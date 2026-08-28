#!/usr/bin/env python3
"""
Resolve each (artist, song) in the play log to a YouTube video, so the site can
offer a play button next to a song instead of only counting it.

There is no lookup table for "the video of this recording". YouTube's own Data
API charges 100 quota units for a search and allows 10,000 a day -- a hundred
songs, three weeks to cover a catalogue this size, and no budget left to ever
re-check one. So this searches YouTube the way a person would, through yt-dlp,
and then scores the results:

  1. Search `ytsearch6:<artist> <title>`, with the Walmart-specific edit markers
     ("(WM Clean)", "(Squeaky Clean)") stripped -- no such upload exists.
  2. Score every hit on who uploaded it, whether the title is the song, and how
     long it runs (see score_candidate).
  3. Keep the winner, and keep the runners-up too, so a wrong pick can be
     corrected later without searching again.

A pick is "high" confidence when the uploader is provably the artist -- an
official artist channel, a "- Topic" auto-upload, or a VEVO channel -- and the
title matches. Everything else is "low" and wants human eyes; --review lists
them worst-first with the alternates the search already found.

Results live in youtube/links.tsv, committed to the repo rather than written to
the database, for three reasons: the database is a build artifact that gets
rebuilt, GitHub Actions never has to write it back to the bucket, and a
correction someone made by hand shows up as a reviewable diff. To correct a
pick, edit its video_id and set its source column to `manual`; rows marked
`manual` are never re-resolved or overwritten. To say a song should have no
video at all, blank the video_id and mark it `manual` too.

YouTube throttles datacentre IPs harder than home ones, so the initial backfill
is meant to be run locally and committed. The scheduled job only ever has a
handful of new songs and is allowed to fail without failing the build.
"""
import argparse
import csv
import re
import sys
import time
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "radio_plays.duckdb"
LINKS_PATH = ROOT / "youtube" / "links.tsv"

FIELDS = ["artist", "song", "video_id", "confidence", "source",
          "score", "duration", "channel", "title", "alternates"]

N_RESULTS = 6            # candidates to score per song
MIN_SECONDS = 45         # shorter than this is a clip or a teaser
MAX_SECONDS = 900        # longer is a mix, a live set, or an hour of the album
MIN_SCORE = 30           # below this we would rather show nothing
HIGH_SCORE = 75          # at or above this, and channel-verified, we trust it

# Words that mean "not the recording the station played". Checked against the
# candidate's title only when the song's own title doesn't contain them -- the
# station does play remixes and live cuts, and when it does we want to match one.
NEGATIVE = [
    ("karaoke", 90), ("instrumental", 70), ("cover", 60), ("tribute", 80),
    ("in the style of", 90), ("reaction", 90), ("review", 40), ("nightcore", 90),
    ("sped up", 70), ("slowed", 70), ("8d audio", 90), ("mashup", 60),
    ("full album", 90), ("greatest hits", 80), ("playlist", 70), ("mix)", 25),
    ("live", 30), ("remix", 35), ("acoustic", 40), ("demo", 40), ("tutorial", 90),
    ("lesson", 70), ("backing track", 90), ("loop", 50), ("1 hour", 90),
]


def clean_title(song: str) -> str:
    """The searchable form of a title.

    Unlike the artwork fetcher's version this keeps remix and feature credits --
    a remix is a different video, not a different pressing of the same one. It
    only drops the edits that exist nowhere but in-store: the station plays
    radio-safe cuts labelled "(WM Clean)" or "(Squeaky Clean)" that were cut for
    it and were never uploaded anywhere.
    """
    s = re.sub(r"\s*[\(\[](wm |squeaky |super )?clean( version| edit)?[\)\]]", "", song, flags=re.I)
    s = re.sub(r"\s*[\(\[]explicit[\)\]]", "", s, flags=re.I)
    return s.strip() or song


def core_title(song: str) -> str:
    """The song without its parenthesised credits, for loose title matching."""
    s = re.sub(r"\s*[\(\[](feat\.?|featuring|with)\s[^\)\]]*[\)\]]", "", clean_title(song), flags=re.I)
    s = re.sub(r"\s*[\(\[][^\)\]]*[\)\]]", "", s)
    return s.strip() or clean_title(song)


def norm(s: str) -> str:
    """Fold to comparable letters: case, punctuation and '&' all go away."""
    s = (s or "").lower().replace("&", " and ")
    return re.sub(r"[^a-z0-9]", "", s)


def search(query: str, n: int) -> list[dict]:
    """Top n YouTube search hits, flat (no per-video request)."""
    from yt_dlp import YoutubeDL

    opts = {"quiet": True, "no_warnings": True, "extract_flat": True,
            "skip_download": True, "ignoreerrors": True, "socket_timeout": 20}
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{n}:{query}", download=False)
    return [e for e in (info or {}).get("entries", []) or [] if e and e.get("id")]


def video_live(video_id: str) -> bool:
    """Is this video still playable?

    `process=False` skips format resolution. Without it yt-dlp reports
    "Requested format is not available" for perfectly good videos, which reads
    as a dead link and is not one.
    """
    from yt_dlp import YoutubeDL

    opts = {"quiet": True, "no_warnings": True, "skip_download": True,
            "socket_timeout": 20}
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}",
                                    download=False, process=False)
        return bool(info)
    except Exception:
        return False


def parse_alternates(alternates: str) -> list[tuple[str, str]]:
    """The runner-up candidates a past search stored, as (video_id, label)."""
    out = []
    for part in (alternates or "").split(" | "):
        part = part.strip()
        if not part:
            continue
        vid = part.split(" ", 1)[0]
        if re.fullmatch(r"[A-Za-z0-9_-]{11}", vid):
            out.append((vid, part))
    return out


def score_candidate(entry: dict, artist: str, song: str) -> tuple[int, list[str]]:
    """Score one search hit for being *this* recording. Returns (score, why)."""
    title = entry.get("title") or ""
    channel = entry.get("channel") or entry.get("uploader") or ""
    dur = entry.get("duration") or 0
    nt, nc, na = norm(title), norm(channel), norm(artist)
    ncore, nsong = norm(core_title(song)), norm(clean_title(song))
    why, score = [], 0

    # --- who uploaded it. The strongest signal by far. ---
    # Acts decorate their channel names ("Lizzo Music", "2 Unlimited Official",
    # "P!NKVEVO"), and a "- Topic" channel is YouTube's own auto-upload of the
    # label's audio. Strip the decoration before comparing, or a good share of
    # genuinely official uploads read as some stranger's.
    bare = re.sub(r"(vevo|topic|official|music|band|tv|channel|records)+$", "", nc)
    if nc == na + "topic":
        score += 55; why.append("topic channel")      # auto-generated official audio
    elif nc.endswith("vevo") and na and (bare == na or na in nc):
        score += 50; why.append("vevo channel")
    elif nc == na or bare == na:
        score += 45; why.append("artist channel")
    elif na and (na in nc or (len(nc) > 3 and nc in na)):
        score += 22; why.append("channel ~ artist")
    elif entry.get("channel_is_verified"):
        score += 5; why.append("verified channel")

    # --- is the title the song ---
    if ncore and ncore in nt:
        score += 30; why.append("title has song")
    elif nsong and nsong in nt:
        score += 30; why.append("title has song")
    elif ncore and nt and (nt in ncore or _fuzzy(nt, ncore)):
        score += 12; why.append("title ~ song")
    else:
        score -= 35; why.append("title mismatch")
    if na and na in nt:
        score += 8; why.append("title has artist")
    if re.search(r"official\s*(music\s*)?(video|audio|visualizer)", title, re.I):
        score += 8; why.append("official upload")
    if re.search(r"\bhd\b|\b4k\b|remaster", title, re.I):
        score += 2

    # --- how long it runs ---
    if not dur:
        score -= 5; why.append("no duration")
    elif dur < MIN_SECONDS or dur > MAX_SECONDS:
        score -= 60; why.append(f"duration {dur}s")
    elif dur > 480:
        score -= 15; why.append(f"long ({dur}s)")

    # --- words that mean a different recording ---
    for word, penalty in NEGATIVE:
        if word in clean_title(song).lower():
            continue        # the station really does play the remix / live cut
        if word in title.lower():
            score -= penalty; why.append(f"-{word}")
    # ...and the reverse: the station played a remix, this hit is the original.
    if "remix" in song.lower() and "remix" not in title.lower():
        score -= 30; why.append("-not the remix")

    return score, why


def flat(s: str) -> str:
    """One line, single-spaced. The links file is meant to be edited by hand,
    and a tab or a newline inside a video title would split its row."""
    return " ".join((s or "").split())


def _fuzzy(a: str, b: str) -> bool:
    """True when two normalised titles differ only at the edges."""
    if not a or not b:
        return False
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    return len(short) >= 6 and len(short) / len(long_) >= 0.8 and short[:6] == long_[:6]


def resolve(artist: str, song: str) -> tuple[dict | None, list[dict]]:
    """Search for one song and return (best candidate, all scored candidates)."""
    hits = search(f"{artist} {clean_title(song)}", N_RESULTS)
    scored = []
    for rank, e in enumerate(hits):
        s, why = score_candidate(e, artist, song)
        s += max(0, 4 - rank)      # a tie goes to whatever YouTube ranked first
        scored.append({
            "video_id": e["id"],
            "title": flat(e.get("title")),
            "channel": flat(e.get("channel") or e.get("uploader")),
            "duration": int(e.get("duration") or 0),
            "score": s,
            "why": ", ".join(why),
        })
    scored.sort(key=lambda c: -c["score"])
    best = scored[0] if scored and scored[0]["score"] >= MIN_SCORE else None
    return best, scored


def confidence_of(cand: dict) -> str:
    verified = any(k in cand["why"] for k in ("topic channel", "artist channel", "vevo channel"))
    strong_title = "title has song" in cand["why"]
    return "high" if cand["score"] >= HIGH_SCORE and verified and strong_title else "low"


# ---------- the links file ----------

def load_links(path: Path = LINKS_PATH) -> dict[tuple[str, str], dict]:
    if not path.exists():
        return {}
    with path.open(newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh, delimiter="\t"))
    return {(r["artist"], r["song"]): r for r in rows}


def save_links(links: dict[tuple[str, str], dict], path: Path = LINKS_PATH) -> None:
    """Write the table back, sorted, so a run that adds one song diffs as one line."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS, delimiter="\t",
                           extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        for key in sorted(links, key=lambda k: (k[0].lower(), k[1].lower())):
            w.writerow(links[key])


def main():
    p = argparse.ArgumentParser(description="Resolve songs to YouTube videos")
    p.add_argument("--limit", type=int, default=None, help="max songs to resolve this run")
    p.add_argument("--retry-misses", action="store_true", help="retry songs that got no pick")
    p.add_argument("--redo-low", action="store_true", help="re-resolve low-confidence picks too")
    p.add_argument("--review", action="store_true", help="list low-confidence picks and exit")
    p.add_argument("--stats", action="store_true", help="print coverage and exit")
    p.add_argument("--verify", action="store_true",
                   help="check stored links still play; fall back or clear the dead ones")
    p.add_argument("--only", nargs=2, metavar=("ARTIST", "SONG"), help="resolve one song")
    p.add_argument("--db", type=Path, default=DB_PATH)
    p.add_argument("--links", type=Path, default=LINKS_PATH)
    args = p.parse_args()

    links = load_links(args.links)
    con = duckdb.connect(str(args.db), read_only=True)
    catalogue = con.execute("""
        SELECT artist, song, count(*) AS n FROM plays GROUP BY 1, 2 ORDER BY n DESC
    """).fetchall()

    if args.stats or args.review:
        report(links, catalogue, low_only=args.review)
        return 0

    if args.verify:
        return verify(links, args)

    if args.retry_misses:
        for key, row in list(links.items()):
            if not row["video_id"] and row["source"] != "manual":
                del links[key]

    if args.only:
        todo = [(args.only[0], args.only[1], 0)]
    else:
        def wanted(row):
            if row is None:
                return True
            if row["source"] == "manual":
                return False                     # a person decided this one
            return args.redo_low and row["confidence"] == "low"
        todo = [(a, s, n) for a, s, n in catalogue if wanted(links.get((a, s)))]
    if args.limit:
        todo = todo[: args.limit]

    print(f"{len(todo)} songs to resolve", flush=True)
    high = low = missed = 0
    for i, (artist, song, n_plays) in enumerate(todo, 1):
        if links.get((artist, song), {}).get("source") == "manual":
            continue
        label = f"[{i}/{len(todo)}] {artist} - {song}"
        try:
            best, scored = resolve(artist, song)
        except Exception as e:                      # network, throttling, parse
            print(f"{label} -> ERROR {e} (will retry next run)", flush=True)
            time.sleep(5)
            continue

        alternates = " | ".join(
            f"{c['video_id']} {c['score']} {c['channel']}: {c['title']}"[:120]
            for c in scored[1:4])
        if best:
            conf = confidence_of(best)
            links[(artist, song)] = {
                "artist": artist, "song": song, "video_id": best["video_id"],
                "confidence": conf, "source": "search", "score": best["score"],
                "duration": best["duration"], "channel": best["channel"],
                "title": best["title"], "alternates": alternates,
            }
            high += conf == "high"
            low += conf == "low"
            print(f"{label} -> {conf:4} {best['video_id']}  {best['channel']} | {best['title'][:60]}",
                  flush=True)
        else:
            links[(artist, song)] = {
                "artist": artist, "song": song, "video_id": "",
                "confidence": "none", "source": "search",
                "score": scored[0]["score"] if scored else 0, "duration": 0,
                "channel": "", "title": "", "alternates": alternates,
            }
            missed += 1
            reason = "no results" if not scored else f"best scored {scored[0]['score']}"
            print(f"{label} -> MISS ({reason})", flush=True)

        if i % 25 == 0:
            save_links(links, args.links)   # a throttled run keeps what it got

    save_links(links, args.links)
    print(f"\nDone: {high} high, {low} low, {missed} misses", flush=True)
    report(links, catalogue)
    return 0


def verify(links, args) -> int:
    """Re-check stored links and repair the dead ones.

    YouTube search can return a video that is already unavailable, and uploads
    are taken down over time, so a link that was good at resolve time is not
    good forever. A dead pick falls back to the best runner-up that still
    plays; if none does, the id is cleared and the site shows a search link,
    which is the one thing that cannot rot.
    """
    rows = [r for r in links.values() if r["video_id"]]
    if args.limit:
        rows = rows[: args.limit]
    print(f"verifying {len(rows)} links", flush=True)
    checked = dead = repaired = cleared = 0
    for i, r in enumerate(rows, 1):
        checked += 1
        if video_live(r["video_id"]):
            continue
        dead += 1
        label = f"{r['artist']} - {r['song']}"
        replacement = None
        for vid, _ in parse_alternates(r["alternates"]):
            if video_live(vid):
                replacement = vid
                break
        if replacement:
            r.update(video_id=replacement, confidence="low", source="search")
            repaired += 1
            print(f"  DEAD {label} -> fell back to {replacement}", flush=True)
        else:
            r.update(video_id="", confidence="none", source="search",
                     channel="", title="", duration=0, score=0)
            cleared += 1
            print(f"  DEAD {label} -> no live alternate, cleared", flush=True)
        if dead % 5 == 0:
            save_links(links, args.links)
    save_links(links, args.links)
    print(f"\nchecked {checked}: {dead} dead ({repaired} repaired from alternates, "
          f"{cleared} cleared to a search link)")
    return 0


def report(links, catalogue, low_only: bool = False) -> None:
    if low_only:
        by_plays = {(a, s): n for a, s, n in catalogue}
        rows = sorted((r for r in links.values() if r["confidence"] == "low"),
                      key=lambda r: -by_plays.get((r["artist"], r["song"]), 0))
        print(f"{len(rows)} low-confidence picks, most-played first.")
        print("To fix one: edit its video_id in youtube/links.tsv and set source to `manual`.\n")
        for r in rows:
            n = by_plays.get((r["artist"], r["song"]), 0)
            print(f"{n:5} plays  {r['artist']} - {r['song']}")
            print(f"            https://youtu.be/{r['video_id']}  [{r['score']}] "
                  f"{r['channel']} | {r['title']} ({r['duration']}s)")
            if r["alternates"]:
                for alt in r["alternates"].split(" | "):
                    print(f"              alt: {alt}")
        none = [r for r in links.values() if r["confidence"] == "none"]
        if none:
            print(f"\n{len(none)} with no pick at all:")
            for r in sorted(none, key=lambda r: -by_plays.get((r["artist"], r["song"]), 0)):
                print(f"            {r['artist']} - {r['song']}")
        return

    total = len(catalogue)
    hi = sum(r["confidence"] == "high" for r in links.values())
    lo = sum(r["confidence"] == "low" for r in links.values())
    manual = sum(r["source"] == "manual" for r in links.values())
    none = sum(not r["video_id"] for r in links.values())
    linked_keys = {k for k, r in links.items() if r["video_id"]}
    n_plays = sum(n for _, _, n in catalogue)
    covered = sum(n for a, s, n in catalogue if (a, s) in linked_keys)
    print(f"linked {len(linked_keys)}/{total} songs ({len(linked_keys)/max(1,total):.1%})  "
          f"high {hi}, low {lo}, manual {manual}, no pick {none}")
    print(f"plays with a link: {covered:,}/{n_plays:,} ({covered/max(1,n_plays):.1%})")


if __name__ == "__main__":
    sys.exit(main())

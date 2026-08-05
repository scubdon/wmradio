#!/usr/bin/env python3
"""
Fetch missing artwork via MusicBrainz + Cover Art Archive.

For each distinct (artist, song) in plays with NULL artwork_url:
  1. Search the MusicBrainz recording index for the song+artist.
  2. Collect candidate release-groups (albums preferred, then singles/EPs).
  3. Try https://coverartarchive.org/release-group/<mbid>/front-500 for each
     candidate until one has art.
  4. Save the image to artwork/artwork_large/rg_<mbid>.jpg (plus a 150px
     thumbnail in artwork_small/ via sips), and update all matching plays rows.

Failed lookups are recorded in the artwork_misses table so reruns skip them;
use --retry-misses to try them again.

MusicBrainz rate limit: 1 request/second (enforced below). Be patient:
~500 songs takes ~20 minutes.
"""
import argparse
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import requests

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "radio_plays.duckdb"
LARGE_DIR = ROOT / "artwork" / "artwork_large"
SMALL_DIR = ROOT / "artwork" / "artwork_small"

MB_URL = "https://musicbrainz.org/ws/2/recording"
CAA_URL = "https://coverartarchive.org/release-group/{mbid}/front-500"
USER_AGENT = "wmplan-radio-dashboard/0.1 (richard.t.cooney@gmail.com)"

MB_INTERVAL = 1.1  # seconds between MusicBrainz requests
_last_mb_request = 0.0

session = requests.Session()
session.headers["User-Agent"] = USER_AGENT


def clean_title(song: str) -> str:
    """Strip featuring/version decorations that hurt MB search matching."""
    s = re.sub(r"\s*[\(\[](feat\.?|featuring|with)\s[^\)\]]*[\)\]]", "", song, flags=re.I)
    s = re.sub(r"\s+-\s+(.*(remix|version|mix|edit|mono|stereo|live|main|remaster).*)$", "", s, flags=re.I)
    s = re.sub(r"\s*[\(\[].*(remaster|deluxe|radio edit|single version|from ).*[\)\]]", "", s, flags=re.I)
    return s.strip() or song


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def mb_search(title: str, artist: str) -> list[dict]:
    """Search MB recordings; return candidate release-groups, best first."""
    global _last_mb_request

    q = f'recording:"{title}" AND artist:"{artist}"'
    for attempt in range(3):
        wait = MB_INTERVAL - (time.monotonic() - _last_mb_request)
        if wait > 0:
            time.sleep(wait)
        _last_mb_request = time.monotonic()
        resp = session.get(MB_URL, params={"query": q, "fmt": "json", "limit": 10}, timeout=15)
        if resp.status_code in (429, 503) and attempt < 2:
            time.sleep(3 * (attempt + 1))
            continue
        resp.raise_for_status()
        break
    recordings = resp.json().get("recordings", [])

    candidates = []  # (rank, release-group dict)
    for rec in recordings:
        score = int(rec.get("score", 0))
        # High-score hits are trusted; lower scores (long feat. credit lists
        # depress the score) only count when the title genuinely matches.
        if score < 85 and not (score >= 55 and norm(rec.get("title", "")) == norm(title)):
            continue
        for rel in rec.get("releases", []):
            rg = rel.get("release-group")
            if not rg:
                continue
            primary = (rg.get("primary-type") or "").lower()
            secondary = rg.get("secondary-types", [])
            if primary == "album" and not secondary:
                rank = 0
            elif primary == "single":
                rank = 1
            elif primary == "ep":
                rank = 2
            elif primary == "album":  # compilation/soundtrack/live etc.
                rank = 3
            else:
                rank = 4
            candidates.append((rank, rg["id"], rg.get("title", "")))

    seen, ordered = set(), []
    for rank, mbid, title_ in sorted(candidates, key=lambda c: c[0]):
        if mbid not in seen:
            seen.add(mbid)
            ordered.append({"mbid": mbid, "title": title_})
    return ordered


def fetch_cover(mbid: str) -> bytes | None:
    resp = session.get(CAA_URL.format(mbid=mbid), timeout=30, allow_redirects=True)
    if resp.status_code == 200 and resp.content[:3] != b"<ht":
        return resp.content
    return None


def save_artwork(mbid: str, data: bytes) -> str:
    fname = f"rg_{mbid}.jpg"
    large = LARGE_DIR / fname
    small = SMALL_DIR / fname
    large.write_bytes(data)
    for cmd in (["sips", "-Z", "150", str(large), "--out", str(small)],
                ["magick", str(large), "-resize", "150x150", str(small)],
                ["convert", str(large), "-resize", "150x150", str(small)]):
        try:
            if subprocess.run(cmd, capture_output=True).returncode == 0:
                return fname
        except FileNotFoundError:
            continue
    shutil.copy2(large, small)  # no resizer available; 500px thumb still works
    return fname


def main():
    parser = argparse.ArgumentParser(description="Fetch missing artwork from Cover Art Archive")
    parser.add_argument("--limit", type=int, default=None, help="max pairs to process this run")
    parser.add_argument("--retry-misses", action="store_true", help="retry pairs previously recorded as misses")
    parser.add_argument("--db", type=Path, default=DB_PATH)
    args = parser.parse_args()

    con = duckdb.connect(str(args.db))
    con.execute("""
        CREATE TABLE IF NOT EXISTS artwork_misses (
            artist VARCHAR, song VARCHAR, reason VARCHAR, checked_at TIMESTAMP
        )""")
    if args.retry_misses:
        con.execute("DELETE FROM artwork_misses")

    pairs = con.execute("""
        SELECT artist, song, count(*) AS n
        FROM plays p
        WHERE artwork_url IS NULL
          AND NOT EXISTS (SELECT 1 FROM artwork_misses m
                          WHERE m.artist = p.artist AND m.song = p.song)
        GROUP BY 1, 2 ORDER BY n DESC
    """).fetchall()
    if args.limit:
        pairs = pairs[: args.limit]

    print(f"{len(pairs)} artist/song pairs to look up", flush=True)
    found = missed = 0

    for i, (artist, song, n_plays) in enumerate(pairs, 1):
        label = f"[{i}/{len(pairs)}] {artist} - {song}"
        try:
            title = clean_title(song)
            rgs = mb_search(title, artist)
            if not rgs and title != song:
                rgs = mb_search(song, artist)

            art = None
            for rg in rgs[:4]:
                art = fetch_cover(rg["mbid"])
                if art:
                    fname = save_artwork(rg["mbid"], art)
                    url = CAA_URL.format(mbid=rg["mbid"])
                    con.execute(
                        "UPDATE plays SET artwork_url = ?, artwork_file = ? "
                        "WHERE artist = ? AND song = ? AND artwork_url IS NULL",
                        [url, fname, artist, song],
                    )
                    found += 1
                    print(f"{label} -> {rg['title']} ({rg['mbid'][:8]})", flush=True)
                    break
                time.sleep(0.3)

            if not art:
                reason = "no MB match" if not rgs else "no cover art on candidates"
                con.execute(
                    "INSERT INTO artwork_misses VALUES (?, ?, ?, ?)",
                    [artist, song, reason, datetime.now(timezone.utc).replace(tzinfo=None)],
                )
                missed += 1
                print(f"{label} -> MISS ({reason})", flush=True)

        except requests.RequestException as e:
            print(f"{label} -> ERROR {e} (will retry next run)", flush=True)
            time.sleep(5)

    print(f"\nDone: {found} fetched, {missed} misses recorded", flush=True)
    remaining = con.execute(
        "SELECT count(DISTINCT (artist, song)) FROM plays WHERE artwork_url IS NULL"
    ).fetchone()[0]
    print(f"Pairs still without artwork: {remaining}", flush=True)


if __name__ == "__main__":
    sys.exit(main())

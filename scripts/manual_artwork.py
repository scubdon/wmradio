#!/usr/bin/env python3
"""
Hand-picked cover art for songs the automatic lookups can't fill.

Two kinds of song end up without a usable cover on the site:

  * Nothing at all -- the Rockbot feed carried no artwork_url and
    fetch_artwork.py found no MusicBrainz match or no Cover Art Archive image,
    so the pair sits in artwork_misses and is skipped on every later run.
  * A placeholder -- the feed *did* give an artwork_url, but it points at
    Rockbot's grey music-note tile. The pair looks filled to every automatic
    step, so nothing will ever replace it, and the site shows a grey square.

Both are fixed the same way: drop an image in with `add`, which resizes it into
artwork/artwork_small/ (the directory build.py publishes from), records the
pairing in artwork/manual_artwork.json, and points the play rows at it.

The manifest is the durable half. The database lives in the GCS bucket, is
re-downloaded by every scheduled run, and would lose a purely local edit; the
manifest is committed, and `apply` replays it onto the fresh copy inside the
Action -- after fetch_artwork.py, so a hand-picked cover also wins over
whatever the feed later supplies for that song.

Usage:
    python scripts/manual_artwork.py missing            # what still needs art
    python scripts/manual_artwork.py add cover.jpg --artist "X" --song "Y"
    python scripts/manual_artwork.py apply [--check]    # replay the manifest
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aliases import canonical

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "radio_plays.duckdb"
MANIFEST = ROOT / "artwork" / "manual_artwork.json"
LARGE_DIR = ROOT / "artwork" / "artwork_large"
SMALL_DIR = ROOT / "artwork" / "artwork_small"
SITE_ART = ROOT / "dashboard" / "site" / "artwork"

THUMB_PX = 150  # what the site loads; matches fetch_artwork.py

# artwork_url doubles as the "already looked up" flag: fetch_artwork.py only
# considers pairs where it is NULL. Writing a marker here rather than leaving it
# NULL is what stops the next run from overwriting a hand-picked cover.
MARKER = "manual:"

# Rockbot serves this grey music-note tile under ordinary-looking artwork ids,
# one per song, so the id alone can't identify it -- the bytes can. Add a hash
# here if another stand-in turns up; `missing` then lists the songs using it.
PLACEHOLDER_MD5 = {
    "6f0e568c78e68bd4c4f6f5c7f6ec2ec7",  # Rockbot grey music note, 150px thumb
}


# --- manifest -----------------------------------------------------------------

def load_manifest() -> list[dict]:
    if not MANIFEST.exists():
        return []
    return json.loads(MANIFEST.read_text())


def save_manifest(entries: list[dict]) -> None:
    entries.sort(key=lambda e: (e["artist"].lower(), e["song"].lower()))
    MANIFEST.write_text(json.dumps(entries, indent=2, ensure_ascii=False) + "\n")


def slug(text: str) -> str:
    text = text.replace("'", "").replace("’", "")  # keep "don't" one word
    out = "".join(c.lower() if c.isalnum() else "-" for c in text)
    return "-".join(part for part in out.split("-") if part)


# --- images -------------------------------------------------------------------

def make_thumb(src: Path, dst: Path, px: int = THUMB_PX) -> None:
    """Write a `px`-square-ish thumbnail of `src`, whatever resizer is around."""
    for cmd in (["sips", "-Z", str(px), str(src), "--out", str(dst)],
                ["magick", str(src), "-resize", f"{px}x{px}", str(dst)],
                ["convert", str(src), "-resize", f"{px}x{px}", str(dst)]):
        try:
            if subprocess.run(cmd, capture_output=True).returncode == 0:
                return
        except FileNotFoundError:
            continue
    shutil.copy2(src, dst)  # no resizer available; the full-size image still renders


def md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


# --- database -----------------------------------------------------------------

def connect(db: Path, read_only: bool = False) -> duckdb.DuckDBPyConnection:
    if not db.exists():
        sys.exit(f"No database at {db} -- pull it first:\n"
                 f"  gcloud storage cp gs://wmradio-metadata/db/radio_plays.duckdb {db}")
    return duckdb.connect(str(db), read_only=read_only)


def apply_entry(con, artist: str, song: str, fname: str) -> int:
    """Point every play of one pair at `fname`. Returns rows changed."""
    changed = con.execute(
        "UPDATE plays SET artwork_url = ?, artwork_file = ? "
        "WHERE artist = ? AND song = ? "
        "  AND (artwork_file IS DISTINCT FROM ? OR artwork_url IS DISTINCT FROM ?)",
        [MARKER + fname, fname, artist, song, fname, MARKER + fname]).fetchone()[0]
    # A miss recorded before the manual add would otherwise sit there forever
    # claiming this pair has no cover available.
    if con.execute("SELECT count(*) FROM duckdb_tables() "
                   "WHERE table_name = 'artwork_misses'").fetchone()[0]:
        con.execute("DELETE FROM artwork_misses WHERE artist = ? AND song = ?",
                    [artist, song])
    return changed


# --- commands -----------------------------------------------------------------

def cmd_apply(args) -> int:
    entries = load_manifest()
    if not entries:
        print(f"No entries in {MANIFEST.relative_to(ROOT)} -- nothing to apply.")
        return 0

    con = connect(args.db, read_only=args.check)
    changed_total = problems = 0

    for entry in entries:
        artist, song = canonical(entry["artist"], entry["song"])
        fname = entry["file"]
        label = f"{artist} - {song}"

        # Applying an entry whose thumb never made it into the commit would point
        # the site at a 404; leaving the old value alone degrades more gently.
        if not (SMALL_DIR / fname).exists():
            print(f"  SKIP {label}: {fname} missing from artwork/artwork_small/")
            problems += 1
            continue

        n_plays = con.execute(
            "SELECT count(*) FROM plays WHERE artist = ? AND song = ?",
            [artist, song]).fetchone()[0]
        if not n_plays:
            print(f"  SKIP {label}: no plays match this artist/song spelling")
            problems += 1
            continue

        if args.check:
            stale = con.execute(
                "SELECT count(*) FROM plays WHERE artist = ? AND song = ? "
                "AND artwork_file IS DISTINCT FROM ?", [artist, song, fname]).fetchone()[0]
            print(f"  {'WOULD SET' if stale else 'ok'} {label} -> {fname}"
                  f"{f' ({stale} of {n_plays} rows)' if stale else ''}")
            changed_total += stale
            continue

        changed = apply_entry(con, artist, song, fname)
        changed_total += changed
        if changed:
            print(f"  set {label} -> {fname} ({changed} rows)")

    verb = "would update" if args.check else "updated"
    print(f"{len(entries)} manual entries, {verb} {changed_total} rows"
          + (f", {problems} skipped" if problems else ""))
    return 1 if (problems and args.strict) else 0


def cmd_add(args) -> int:
    src = Path(args.image).expanduser()
    if not src.exists():
        sys.exit(f"No such image: {src}")

    artist, song = canonical(args.artist, args.song)
    con = connect(args.db)
    row = con.execute(
        "SELECT count(*), any_value(artwork_file) FROM plays WHERE artist = ? AND song = ?",
        [artist, song]).fetchone()
    n_plays, current = row

    if not n_plays:
        # The feed's spelling is often the surprise ("Mumford & Sons", "Feat."
        # vs "feat."), so search on the most distinctive word rather than the
        # whole string, which by definition didn't match.
        def longest_word(text):
            words = [w for w in "".join(c if c.isalnum() else " " for c in text).split()]
            return max(words, key=len) if words else text

        print(f"No plays for {artist!r} - {song!r}. Closest spellings:")
        for a, s, n in con.execute(
                "SELECT artist, song, count(*) n FROM plays "
                "WHERE artist ILIKE ? OR song ILIKE ? GROUP BY 1, 2 ORDER BY n DESC LIMIT 8",
                [f"%{longest_word(args.artist)}%", f"%{longest_word(args.song)}%"]).fetchall():
            print(f'  --artist "{a}" --song "{s}"   ({n} plays)')
        return 1

    fname = args.filename or f"manual_{slug(artist)}_{slug(song)}.jpg"
    LARGE_DIR.mkdir(parents=True, exist_ok=True)
    SMALL_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, LARGE_DIR / fname)          # local-only original, for re-thumbing
    make_thumb(LARGE_DIR / fname, SMALL_DIR / fname)
    # build.py skips thumbs already in the site directory, so a rebuild after
    # replacing an image would otherwise keep serving the old one locally.
    (SITE_ART / fname).unlink(missing_ok=True)

    entries = [e for e in load_manifest()
               if canonical(e["artist"], e["song"]) != (artist, song)]
    entry = {"artist": artist, "song": song, "file": fname, "added": date.today().isoformat()}
    if args.source:
        entry["source"] = args.source
    if args.note:
        entry["note"] = args.note
    entries.append(entry)
    save_manifest(entries)

    changed = apply_entry(con, artist, song, fname)
    was = f" (replacing {current})" if current and current != fname else ""
    print(f"{artist} - {song}: {n_plays} plays -> {fname}{was}")
    print(f"  thumb   artwork/artwork_small/{fname}")
    print(f"  listed  {MANIFEST.relative_to(ROOT)}")
    print(f"  db      {changed} rows updated (local copy; the manifest is what lasts)")
    print("\nCommit artwork/artwork_small/" + fname + " and artwork/manual_artwork.json "
          "-- the next refresh replays it onto the canonical database.")
    return 0


def cmd_missing(args) -> int:
    con = connect(args.db, read_only=True)

    has_misses = con.execute("SELECT count(*) FROM duckdb_tables() "
                             "WHERE table_name = 'artwork_misses'").fetchone()[0]
    misses = {(a, s): reason for a, s, reason in con.execute(
        "SELECT artist, song, reason FROM artwork_misses").fetchall()} if has_misses else {}

    rows = []
    for artist, song, n in con.execute("""
            SELECT artist, song, count(*) n FROM plays
            WHERE artwork_url IS NULL GROUP BY 1, 2 ORDER BY n DESC""").fetchall():
        reason = misses.get((artist, song), "not looked up yet")
        rows.append((n, artist, song, f"no art ({reason})"))

    # Placeholder covers read as "filled" everywhere else, so they can only be
    # found by looking at the bytes on disk.
    if not args.no_placeholders:
        for fname, artist, song, n in con.execute("""
                SELECT artwork_file, artist, song, count(*) n FROM plays
                WHERE artwork_file IS NOT NULL AND artwork_url NOT LIKE 'manual:%'
                GROUP BY 1, 2, 3""").fetchall():
            path = SMALL_DIR / fname
            if path.exists() and md5(path) in PLACEHOLDER_MD5:
                rows.append((n, artist, song, f"placeholder ({fname})"))

    rows.sort(reverse=True)
    if not rows:
        print("Every song has real artwork.")
        return 0

    shown = rows[: args.limit]
    width = max(len(f"{a} - {s}") for _, a, s, _ in shown)
    print(f"{len(rows)} songs need artwork "
          f"({sum(1 for r in rows if r[3].startswith('placeholder'))} of them placeholders)"
          + (f"; top {len(shown)}:" if len(shown) < len(rows) else ":"))
    for n, artist, song, why in shown:
        print(f"  {n:>5} plays  {f'{artist} - {song}':<{width}}  {why}")
    print('\nAdd one with:\n  python scripts/manual_artwork.py add cover.jpg '
          f'--artist "{shown[0][1]}" --song "{shown[0][2]}"')
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--db", type=Path, default=DB_PATH)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_missing = sub.add_parser("missing", help="songs with no cover, or a placeholder one")
    p_missing.add_argument("--limit", type=int, default=40)
    p_missing.add_argument("--no-placeholders", action="store_true",
                           help="only list songs with no artwork at all")
    p_missing.set_defaults(func=cmd_missing)

    p_add = sub.add_parser("add", help="install an image for one artist/song")
    p_add.add_argument("image", help="path to the cover image (any size; 500px+ is ideal)")
    p_add.add_argument("--artist", required=True)
    p_add.add_argument("--song", required=True)
    p_add.add_argument("--source", help="where the image came from, recorded in the manifest")
    p_add.add_argument("--note", help="why it was added by hand")
    p_add.add_argument("--filename", help="override the generated thumb filename")
    p_add.set_defaults(func=cmd_add)

    p_apply = sub.add_parser("apply", help="replay the manifest onto the database")
    p_apply.add_argument("--check", action="store_true", help="report, don't write")
    p_apply.add_argument("--strict", action="store_true",
                         help="exit non-zero if any entry had to be skipped")
    p_apply.set_defaults(func=cmd_apply)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

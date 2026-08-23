#!/usr/bin/env python3
"""
Fold artist and song spelling variants in the play log onto one canonical name.

The metadata feed renames things: R.E.M. became 'REM' on 2026-07-27, 'almost
monday' became 'Almost Monday' on 2024-06-28, and three song titles gained or
lost punctuation. Every query in dashboard/build.py groups by the raw string, so
each rename split one act's history in two.

The map lives in scripts/aliases.py and is shared with scripts/update_duckdb.py,
which applies it on the way in -- necessary because some of these renames are
live, so repairing only the stored rows would drift apart again.

Merged tracks can end up holding two different artwork files, one fetched under
each spelling. Both exist on disk, so this picks the one the larger pile of
plays already used, which is what the site was mostly showing anyway.

Idempotent -- rerunning finds nothing to do.
"""
import argparse
import shutil
import sys
from datetime import datetime
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aliases import ARTIST_ALIASES, SONG_ALIASES

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "radio_plays.duckdb"


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--db", type=Path, default=DB_PATH)
    ap.add_argument("--apply", action="store_true",
                    help="write the changes (default is a dry run)")
    ap.add_argument("--no-backup", action="store_true",
                    help="skip the timestamped copy taken before writing")
    args = ap.parse_args()

    con = duckdb.connect(str(args.db), read_only=not args.apply)

    # Report first, so a dry run shows exactly what a real run would touch.
    total = 0
    for old, new in ARTIST_ALIASES.items():
        for table in ("plays", "artwork_misses"):
            n = con.execute(
                f"SELECT count(*) FROM {table} WHERE artist = ?", [old]
            ).fetchone()[0]
            if n:
                print(f"  {table}.artist: {old!r} -> {new!r}  ({n} rows)")
                total += n
    for (artist, old), new in SONG_ALIASES.items():
        for table in ("plays", "artwork_misses"):
            n = con.execute(
                f"SELECT count(*) FROM {table} WHERE artist = ? AND song = ?",
                [artist, old],
            ).fetchone()[0]
            if n:
                print(f"  {table}.song [{artist}]: {old!r} -> {new!r}  ({n} rows)")
                total += n

    if not total:
        print("Nothing to fold.")
        return

    if not args.apply:
        print(f"\nWould fold {total} row(s).\nDry run -- rerun with --apply to write.")
        return

    if not args.no_backup:
        stamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        backup = args.db.with_name(f"{args.db.stem}_backup_pre_aliases_{stamp}.duckdb")
        con.close()
        shutil.copy2(args.db, backup)
        print(f"Backup: {backup.name}")
        con = duckdb.connect(str(args.db))

    con.execute("BEGIN")
    for table in ("plays", "artwork_misses"):
        # One targeted statement per alias rather than a CASE over the whole
        # table. DuckDB rewrites every row group an UPDATE touches and never
        # returns the space, so an unconditional rewrite of 230k rows added
        # 20MB to the file to change two of them.
        # Artist first: SONG_ALIASES is keyed on the canonical artist name.
        for old, new in ARTIST_ALIASES.items():
            con.execute(f"UPDATE {table} SET artist = ? WHERE artist = ?", [new, old])
        for (artist, old), new in SONG_ALIASES.items():
            con.execute(
                f"UPDATE {table} SET song = ? WHERE artist = ? AND song = ?",
                [new, artist, old],
            )

    # A merged track can now carry two artwork files. Keep the one the most
    # plays already pointed at.
    con.execute("""
        WITH ranked AS (
            SELECT artist, song, artwork_url, artwork_file,
                   row_number() OVER (
                       PARTITION BY artist, song
                       ORDER BY count(*) DESC, artwork_file
                   ) AS rn
            FROM plays WHERE artwork_file IS NOT NULL
            GROUP BY artist, song, artwork_url, artwork_file
        ), winner AS (SELECT * FROM ranked WHERE rn = 1)
        UPDATE plays p
        SET artwork_url = w.artwork_url, artwork_file = w.artwork_file
        FROM winner w
        WHERE p.artist = w.artist AND p.song = w.song
          AND p.artwork_file IS DISTINCT FROM w.artwork_file
    """)

    # Folding can leave two identical miss rows, and a miss recorded under an
    # old spelling is moot once the canonical track has artwork.
    before = con.execute("SELECT count(*) FROM artwork_misses").fetchone()[0]
    con.execute("""
        CREATE OR REPLACE TEMP TABLE misses AS
        SELECT artist, song, any_value(reason) AS reason, max(checked_at) AS checked_at
        FROM artwork_misses GROUP BY artist, song
    """)
    con.execute("DELETE FROM artwork_misses")
    con.execute("""
        INSERT INTO artwork_misses
        SELECT * FROM misses m
        WHERE NOT EXISTS (
            SELECT 1 FROM plays p
            WHERE p.artist = m.artist AND p.song = m.song
              AND p.artwork_file IS NOT NULL
        )
    """)
    con.execute("COMMIT")
    after = con.execute("SELECT count(*) FROM artwork_misses").fetchone()[0]
    print(f"Folded {total} row(s); artwork_misses {before} -> {after}.")


if __name__ == "__main__":
    main()

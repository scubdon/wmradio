#!/usr/bin/env python3
"""
Repair the mangled non-ASCII text the upstream metadata feed emitted between
2025-07-24 and 2025-09-08.

During that window the radiomast metadata endpoint intermittently returned a
broken percent-encoding of any non-ASCII character: 'Tiesto' with a diaeresis
arrived as 'Ti%3*\\x12sto'. The v1 cloud function wrote the bytes through to the
CSV verbatim, so the damage is in the source data, not in our pipeline -- the
same track shows up correctly encoded on adjacent days. The feed corrected
itself after 2025-09-08 and nothing since is affected.

Each mangled character maps to exactly one real character (see FRAGMENTS), so
the repair is a straight substring replacement. Repaired rows also get their
artwork relinked: they had none, because the garbled names never matched
anything in MusicBrainz.

Idempotent -- rerunning finds nothing to do.
"""
import argparse
import shutil
from datetime import datetime
from pathlib import Path

import duckdb

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "radio_plays.duckdb"

# Mangled byte-run -> the character it should have been. The upstream encoder
# emitted '%' plus two shifted hex digits per leading UTF-8 byte, then the final
# byte offset by 0x99; every affected value in the log decodes through these.
FRAGMENTS = {
    "%3*\x10": "é",   # e-acute      (Beyonce, Expose, Rose, cliche)
    "%3*\x12": "ë",   # e-diaeresis  (Tiesto)
    "%3)\x15": "®",   # registered   (F1 The Movie)
    "%5)%/0\x03": "“",  # left double quote
    "%5)%/0\x04": "”",  # right double quote
}

TEXT_COLUMNS = {"plays": ("artist", "song"), "artwork_misses": ("artist", "song")}


def repaired(value: str) -> str:
    for bad, good in FRAGMENTS.items():
        value = value.replace(bad, good)
    return value


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--db", type=Path, default=DB_PATH)
    ap.add_argument("--apply", action="store_true",
                    help="write the changes (default is a dry run)")
    ap.add_argument("--no-backup", action="store_true",
                    help="skip the timestamped copy taken before writing")
    args = ap.parse_args()

    if args.apply and not args.no_backup:
        stamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        backup = args.db.with_name(f"{args.db.stem}_backup_pre_mojibake_{stamp}.duckdb")
        shutil.copy2(args.db, backup)
        print(f"Backup: {backup.name}")

    con = duckdb.connect(str(args.db), read_only=not args.apply)
    total = 0

    for table, columns in TEXT_COLUMNS.items():
        for column in columns:
            rows = con.execute(
                f"SELECT DISTINCT {column} FROM {table} "
                f"WHERE regexp_matches({column}, '[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]')"
            ).fetchall()
            for (bad,) in rows:
                good = repaired(bad)
                if good == bad:
                    print(f"  !! {table}.{column}: no rule for {bad!r} -- left alone")
                    continue
                n = con.execute(
                    f"SELECT count(*) FROM {table} WHERE {column} = ?", [bad]
                ).fetchone()[0]
                print(f"  {table}.{column}: {bad!r} -> {good!r}  ({n} rows)")
                total += n
                if args.apply:
                    con.execute(
                        f"UPDATE {table} SET {column} = ? WHERE {column} = ?", [good, bad]
                    )

    if args.apply and total:
        # The repaired rows carry no artwork; adopt whatever the correctly
        # spelled copies of the same track already resolved to.
        missing = "SELECT count(*) FROM plays WHERE artwork_url IS NULL"
        before = con.execute(missing).fetchone()[0]
        con.execute("""
            WITH art AS (
                SELECT artist, song,
                       any_value(artwork_url) AS url, any_value(artwork_file) AS file
                FROM plays WHERE artwork_url IS NOT NULL GROUP BY 1, 2
            )
            UPDATE plays p SET artwork_url = art.url, artwork_file = art.file
            FROM art
            WHERE p.artwork_url IS NULL
              AND p.artist = art.artist AND p.song = art.song
        """)
        print(f"Relinked artwork for {before - con.execute(missing).fetchone()[0]} row(s).")

        # These misses only ever existed because the names were garbled.
        n_misses = "SELECT count(*) FROM artwork_misses"
        before = con.execute(n_misses).fetchone()[0]
        con.execute("""
            DELETE FROM artwork_misses
            WHERE (artist, song) IN (
                SELECT artist, song FROM plays WHERE artwork_url IS NOT NULL
            )
        """)
        print(f"Dropped {before - con.execute(n_misses).fetchone()[0]} stale artwork_misses row(s).")

    print(f"\n{'Repaired' if args.apply else 'Would repair'} {total} row(s).")
    if not args.apply:
        print("Dry run -- rerun with --apply to write.")


if __name__ == "__main__":
    main()

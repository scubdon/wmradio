#!/usr/bin/env python3
"""
Restore the live-show and promo rows that were stripped out of the early data.

Background
----------
Until roughly April 2026 the station ran three live talk shows on a fixed
Central-time grid, and the stream *did* report them: one metadata row at the top
of each block, logged as "The WMW Radio Network - <show name>". Station adverts
came through the same way, as "Promo". Both kinds were dropped from the CSV
exports the early database was built from, which is why those hours read as
empty and why the dataset's coverage figure understates what the logger saw.

The rows survive in the original Rockbot exports. Two of them together cover the
whole affected era, 2024-05-28 to 2025-06-17, which is exactly the span of the
database's numeric-pick_id rows:

    "~/Desktop/New Folder With Items/Projects/wmradiodata.csv"   (through 2025-02-13)
    ~/projects/wmradio_duckdb/data/wmradiodata_b.csv             (from 2025-02-06)

Pass those two paths as arguments. Other exports of the same shape work too --
the script unions whatever it is given and dedupes by pick_id, so overlapping
files are safe.

What it does *not* touch
------------------------
The `plays` table is left alone. Its rows mean "a song the station played", the
public plays.csv/parquet downloads inherit that meaning, and ~25 queries in
dashboard/build.py assume it. Show announcements and adverts are not songs, so
they land in a separate `station_events` table with the same time columns. Any
query wanting both can union the two; nothing that wants songs has to change.

Idempotent: re-running inserts only pick_ids not already stored.

Requires: duckdb python package.
"""
import argparse
import sys
from pathlib import Path

import duckdb

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "radio_plays.duckdb"

# The exports carry one row per metadata change, so a show block is a single row
# whose "artist" is the network and whose "song" is the programme name. Adverts
# arrive with no artist at all and the literal song "Promo".
SHOW_ARTIST = "%radio network%"
PROMO_SONG = "promo"

SCHEMA = """
CREATE TABLE IF NOT EXISTS station_events (
    pick_id     VARCHAR PRIMARY KEY,
    ts_utc      TIMESTAMP NOT NULL,
    ts_local    TIMESTAMP NOT NULL,
    date_local  DATE      NOT NULL,
    dow_local   TINYINT   NOT NULL,
    hour_local  TINYINT   NOT NULL,
    kind        VARCHAR   NOT NULL,   -- 'show' | 'promo'
    source      VARCHAR,              -- raw artist; NULL on adverts
    label       VARCHAR   NOT NULL,   -- raw song: 'The Bo Show', 'Promo', ...
    artwork_url VARCHAR
)
"""

# One export writes pick_id as a float ("17101752812.0"); the rest write it as
# digits. Normalise before comparing, or nothing joins against the database.
SOURCE_SQL = """
SELECT DISTINCT ON (pick_id)
       regexp_replace(pick_id, '\\.0+$', '') AS pick_id,
       timestamp::TIMESTAMP                  AS ts_utc,
       artist, song, artwork_large           AS artwork_url
FROM read_csv({paths}, header=true, all_varchar=true, union_by_name=true)
WHERE pick_id IS NOT NULL
  AND regexp_matches(regexp_replace(pick_id, '\\.0+$', ''), '^[0-9]+$')
  AND NOT (artist IS NULL AND song IS NULL)
ORDER BY pick_id, ts_utc
"""

CLASSIFY_SQL = f"""
SELECT *, CASE
    WHEN artist ILIKE '{SHOW_ARTIST}'                        THEN 'show'
    WHEN artist IS NULL AND lower(song) = '{PROMO_SONG}'     THEN 'promo'
    WHEN artist ILIKE '%{PROMO_SONG}%'                       THEN 'promo'
    ELSE 'music'
END AS kind
FROM src
"""

# Same derivation as update_duckdb.py: America/New_York, DST-aware, Monday=0.
INSERT_SQL = """
INSERT INTO station_events
SELECT c.pick_id, c.ts_utc, l.ts_local, l.ts_local::DATE,
       (isodow(l.ts_local) - 1)::TINYINT,
       date_part('hour', l.ts_local)::TINYINT,
       c.kind, c.artist, c.song, c.artwork_url
FROM classified c,
     LATERAL (SELECT timezone('America/New_York',
                              timezone('UTC', c.ts_utc)) AS ts_local) l
WHERE c.kind <> 'music'
  AND c.pick_id NOT IN (SELECT pick_id FROM station_events)
  AND c.pick_id NOT IN (SELECT pick_id FROM plays)
"""


def die(msg):
    sys.exit(f"error: {msg}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sources", nargs="+", type=Path,
                    help="Rockbot export CSVs (pick_id,timestamp,artist,song,artwork_large)")
    ap.add_argument("--db", type=Path, default=DB_PATH)
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would be inserted, then stop")
    ap.add_argument("--max-unmatched", type=float, default=1.0,
                    help="abort if more than this %% of the export's music rows are "
                         "absent from `plays` — a sign the file is not a match (default 1.0)")
    args = ap.parse_args()

    missing = [p for p in args.sources if not p.is_file()]
    if missing:
        die("no such file: " + ", ".join(str(p) for p in missing))
    if not args.db.is_file():
        die(f"no database at {args.db}")

    con = duckdb.connect(str(args.db), read_only=args.dry_run)
    paths = "[" + ", ".join("'" + str(p).replace("'", "''") + "'" for p in args.sources) + "]"

    con.execute(f"CREATE TEMP VIEW src AS {SOURCE_SQL.format(paths=paths)}")
    con.execute(f"CREATE TEMP VIEW classified AS {CLASSIFY_SQL}")

    n_src, lo, hi = con.execute(
        "SELECT count(*), min(ts_utc), max(ts_utc) FROM src").fetchone()
    if not n_src:
        die("sources contained no usable rows")
    print(f"Sources: {len(args.sources)} file(s), {n_src:,} usable rows, "
          f"{lo.date()} .. {hi.date()}")
    for kind, n in con.execute(
            "SELECT kind, count(*) FROM classified GROUP BY 1 ORDER BY 2 DESC").fetchall():
        print(f"  {kind:<6} {n:>7,}")

    # Does this export actually describe the same station log the DB was built
    # from? If its music rows are already in `plays`, yes. If they are not, the
    # file is from somewhere else and its show rows should not be trusted either.
    matched, unmatched = con.execute("""
        SELECT count(*) FILTER (WHERE p.pick_id IS NOT NULL),
               count(*) FILTER (WHERE p.pick_id IS NULL)
        FROM classified c LEFT JOIN plays p USING (pick_id)
        WHERE c.kind = 'music'
    """).fetchone()
    pct = 100.0 * unmatched / max(1, matched + unmatched)
    print(f"\nCross-check against `plays`: {matched:,} of {matched + unmatched:,} "
          f"music rows already present ({pct:.2f}% not)")
    if pct > args.max_unmatched:
        die(f"{pct:.2f}% of music rows are absent from `plays`, above the "
            f"{args.max_unmatched}% threshold — this export does not line up "
            f"with the database. Check the files, or raise --max-unmatched.")
    if unmatched:
        print("  music rows in the export but not the DB (not inserted — `plays` is "
              "left alone):")
        for r in con.execute("""
                SELECT c.ts_utc, c.artist, c.song FROM classified c
                LEFT JOIN plays p USING (pick_id)
                WHERE c.kind = 'music' AND p.pick_id IS NULL
                ORDER BY c.ts_utc LIMIT 10""").fetchall():
            print(f"    {r[0]}  {r[1]} — {r[2]}")

    if args.dry_run:
        n_new = con.execute("""
            SELECT count(*) FROM classified c WHERE c.kind <> 'music'
              AND c.pick_id NOT IN (SELECT pick_id FROM plays)""").fetchone()[0]
        print(f"\nDry run: {n_new:,} event row(s) would be inserted. Nothing written.")
        return

    con.execute(SCHEMA)
    before = con.execute("SELECT count(*) FROM station_events").fetchone()[0]
    con.execute("BEGIN")
    con.execute(INSERT_SQL)
    con.execute("COMMIT")
    after = con.execute("SELECT count(*) FROM station_events").fetchone()[0]
    print(f"\nInserted {after - before:,} row(s) -> station_events holds {after:,}")
    for kind, n, a, b in con.execute("""
            SELECT kind, count(*), min(date_local), max(date_local)
            FROM station_events GROUP BY 1 ORDER BY 2 DESC""").fetchall():
        print(f"  {kind:<6} {n:>7,}   {a} .. {b}")

    # The reason for the whole exercise: hours that logged something but held no
    # song were being counted as hours the logger missed.
    span, before_h, after_h = con.execute("""
        WITH b AS (SELECT DISTINCT date_trunc('hour', ts_utc) h FROM plays),
             e AS (SELECT DISTINCT date_trunc('hour', ts_utc) h FROM station_events),
             s AS (SELECT date_diff('hour', min(ts_utc), max(ts_utc)) n FROM plays)
        SELECT (SELECT n FROM s), (SELECT count(*) FROM b),
               (SELECT count(*) FROM (SELECT h FROM b UNION SELECT h FROM e))
    """).fetchone()
    print(f"\nClock hours with something logged, across the {span:,}-hour span:")
    print(f"  songs only       {before_h:,}  ({before_h / span:.1%})")
    print(f"  songs or events  {after_h:,}  ({after_h / span:.1%})   "
          f"+{after_h - before_h:,} hours")


if __name__ == "__main__":
    sys.exit(main())

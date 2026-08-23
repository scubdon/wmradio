#!/usr/bin/env python3
"""
Scheduled refresh: pull new plays from the wmradio-metadata bucket into
the local DuckDB database (data/radio_plays.duckdb).

Reads from BOTH sources so the old->new cloud function transition is seamless:
  1. Legacy monolithic CSV (gs://wmradio-metadata/radio_plays.csv) — written by
     the v1 function; stops growing once v2 is deployed. Skip with --skip-csv.
  2. Per-play JSON objects (gs://wmradio-metadata/plays/date=YYYY-MM-DD/*.json)
     — written by the v2 function. Only dates >= the DB's last play are pulled.

New rows are deduped against the DB by pick_id, and artist/song spellings are
folded through scripts/aliases.py (the feed renames acts over time). Local-time
columns are derived in America/New_York (DST-aware, dow_local Monday=0, matching
existing rows), and artwork is backfilled for songs the DB has already seen.

Requires: gcloud CLI (authenticated), duckdb python package.
"""
import argparse
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aliases import artist_case_sql, song_case_sql

BUCKET = "wmradio-metadata"
LEGACY_CSV = f"gs://{BUCKET}/radio_plays.csv"
PLAYS_PREFIX = f"gs://{BUCKET}/plays"
DB_PATH = Path(__file__).resolve().parent.parent / "data" / "radio_plays.duckdb"

INSERT_SQL = """
CREATE TEMP TABLE incoming AS
WITH src AS ({source_union}),
fresh AS (
    SELECT s.* FROM src s
    LEFT JOIN plays p USING (pick_id)
    WHERE p.pick_id IS NULL
),
-- Fold the feed's spelling variants before the artwork lookup below, so a
-- renamed act inherits the artwork already fetched under its canonical name.
-- Artist first: the song map is keyed on the canonical artist.
renamed AS (
    SELECT pick_id, ts_utc, {artist_case} AS artist, song FROM fresh
),
folded AS (
    SELECT pick_id, ts_utc, artist, {song_case} AS song FROM renamed
),
derived AS (
    SELECT pick_id, ts_utc,
           timezone('America/New_York', timezone('UTC', ts_utc)) AS ts_local,
           artist, song
    FROM folded
),
art AS (
    SELECT artist, song,
           any_value(artwork_url) AS artwork_url,
           any_value(artwork_file) AS artwork_file
    FROM plays WHERE artwork_url IS NOT NULL
    GROUP BY artist, song
)
SELECT d.pick_id, d.ts_utc, d.ts_local,
       d.ts_local::DATE AS date_local,
       (isodow(d.ts_local) - 1)::TINYINT AS dow_local,
       date_part('hour', d.ts_local)::TINYINT AS hour_local,
       d.artist, d.song, a.artwork_url, a.artwork_file
FROM derived d LEFT JOIN art a USING (artist, song);
"""

CSV_SOURCE = """
    SELECT pick_id, timestamp AS ts_utc, song, artist
    FROM read_csv('{path}', header=true,
                  columns={{'pick_id':'VARCHAR','timestamp':'TIMESTAMP',
                            'song':'VARCHAR','artist':'VARCHAR'}})
"""

JSON_SOURCE = """
    SELECT pick_id, timestamp AS ts_utc, song, artist
    FROM read_json('{glob}', format='auto',
                   columns={{'pick_id':'VARCHAR','timestamp':'TIMESTAMP',
                             'song':'VARCHAR','artist':'VARCHAR'}})
"""


def run(cmd, check=True):
    result = subprocess.run(cmd, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)}\n{result.stderr.strip()}")
    return result


def fetch_sources(tmp: Path, last_play_date: date, skip_csv: bool) -> list[str]:
    """Download new data from GCS; return SQL SELECTs for each source found."""
    sources = []

    if not skip_csv:
        csv_path = tmp / "radio_plays.csv"
        result = run(["gcloud", "storage", "cp", LEGACY_CSV, str(csv_path)], check=False)
        if csv_path.exists():
            sources.append(CSV_SOURCE.format(path=csv_path))
            print(f"  legacy CSV: downloaded ({csv_path.stat().st_size:,} bytes)")
        else:
            print(f"  legacy CSV: not found, skipping ({result.stderr.strip().splitlines()[-1] if result.stderr else 'no error'})")

    listing = run(["gcloud", "storage", "ls", f"{PLAYS_PREFIX}/"], check=False)
    date_dirs = []
    for line in listing.stdout.splitlines():
        line = line.strip().rstrip("/")
        if "date=" in line:
            try:
                d = date.fromisoformat(line.rsplit("date=", 1)[1])
            except ValueError:
                continue
            if d >= last_play_date:
                date_dirs.append(line)

    if date_dirs:
        json_dir = tmp / "plays"
        json_dir.mkdir()
        for dir_url in sorted(date_dirs):
            run(["gcloud", "storage", "cp", "-r", f"{dir_url}/", str(json_dir)])
        n_files = sum(1 for _ in json_dir.rglob("*.json"))
        print(f"  play objects: {n_files} files from {len(date_dirs)} day(s)")
        if n_files:
            sources.append(JSON_SOURCE.format(glob=f"{json_dir}/**/*.json"))
    else:
        print("  play objects: none new")

    return sources


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--skip-csv", action="store_true",
                        help="don't pull the legacy CSV (use once v2 function is live and its plays are ingested)")
    parser.add_argument("--db", type=Path, default=DB_PATH)
    args = parser.parse_args()

    con = duckdb.connect(str(args.db))
    last_ts, n_before = con.sql("SELECT max(ts_utc), count(*) FROM plays").fetchone()
    print(f"DB: {n_before:,} plays, latest {last_ts}")

    with tempfile.TemporaryDirectory() as tmpdir:
        print("Fetching from GCS...")
        sources = fetch_sources(Path(tmpdir), last_ts.date(), args.skip_csv)
        if not sources:
            print("Nothing to ingest.")
            return

        con.execute("BEGIN")
        con.execute(INSERT_SQL.format(
            source_union=" UNION ALL ".join(sources),
            artist_case=artist_case_sql(), song_case=song_case_sql()))
        n_new = con.sql("SELECT count(*) FROM incoming").fetchone()[0]
        con.execute("INSERT INTO plays SELECT * FROM incoming")
        con.execute("COMMIT")

    n_after, new_ts = con.sql("SELECT count(*), max(ts_utc) FROM plays").fetchone()
    missing_art = con.execute(
        "SELECT count(DISTINCT (artist, song)) FROM plays "
        "WHERE artwork_url IS NULL AND ts_utc > ?", [last_ts]
    ).fetchone()[0]
    print(f"Inserted {n_new:,} new plays -> {n_after:,} total, latest {new_ts}")
    if missing_art:
        print(f"Note: {missing_art} new song(s) have no artwork yet (artwork backfill only covers previously seen songs)")


if __name__ == "__main__":
    sys.exit(main())

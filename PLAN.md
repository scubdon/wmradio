# Walmart Radio Dashboard — Plan

Track what Walmart Radio plays, keep a DuckDB database current, and publish a
dashboard of analysis/visualizations that refreshes roughly daily.

## Data flow (target architecture)

```
radiomast metadata URL
        │  polled every minute (Cloud Scheduler → Cloud Function, us-east4)
        ▼
Cloud Function (cloud_run_function/main.py, v2)
        │  on song change: write ONE small JSON object
        ▼
gs://wmradio-metadata/plays/date=YYYY-MM-DD/<ts>_<id>.json
        │  daily: scripts/update_duckdb.py
        ▼
data/radio_plays.duckdb  (plays + spotify_tracks + views)
        │  daily build step (TBD)
        ▼
Dashboard (static site or hosted app)
```

## What changed and why

### v1 cloud function (preserved as `main_v1_csv.py`)
On every song change it downloaded the entire `radio_plays.csv` (~12 MB,
~120k rows), parsed it, appended one row, and re-uploaded the whole file.
That's ~400 full read-modify-write cycles a day (~10 GB/day of transfer),
with cost/latency growing forever as the CSV grows, plus a lost-update risk
if two runs ever overlapped.

### v2 cloud function (`main.py`)
- On change, writes **one ~200-byte JSON object per play** under a
  Hive-style `plays/date=YYYY-MM-DD/` prefix. Append-only, O(1) forever,
  no read-modify-write, no lost-update window.
- Caches `last_metadata.txt` in a module-level global, so warm instances do
  **zero** GCS reads on no-change runs (the common case, ~every minute).
- Same timestamp format (naive UTC isoformat) and fields
  (`pick_id, timestamp, song, artist`) as the legacy CSV.
- `requirements.txt` unchanged.

Deploy (same name/region as current deployment; scheduler needs no change):

```bash
gcloud functions deploy check-radio-metadata \
  --gen2 --region=us-east4 --runtime=python312 \
  --source=cloud_run_function --entry-point=check_radio_metadata \
  --trigger-http
```

### Daily DB refresh (`scripts/update_duckdb.py`)
Pulls new plays into `data/radio_plays.duckdb`:
- Reads **both** the legacy CSV and the new per-play JSON objects, so the
  cutover needs no coordination — dedupe is by `pick_id` anti-join, so it's
  idempotent and safe to run any time.
- Derives `ts_local`/`date_local`/`dow_local`/`hour_local` exactly like the
  existing rows (America/New_York, DST-aware, Monday=0).
- Backfills `artwork_url`/`artwork_file` for songs already seen in the DB.
  Genuinely new songs get NULL artwork (a separate artwork-fetch step can
  fill those; rockbot URLs like the existing ones).
- Once v2 is live and a refresh has run, add `--skip-csv` to stop pulling
  the 12 MB legacy CSV. The CSV in the bucket then becomes a frozen archive
  (already fully ingested).

## Status (2026-08-03)
- [x] `data/radio_plays.duckdb` updated from the downloaded CSV + live bucket:
      **223,449 plays** through 2026-08-04 02:12 UTC (was 188,028 through
      Apr 30). Backup at `data/radio_plays_backup_2026-08-03.duckdb`.
      27.5k of the new plays got artwork backfilled; ~500 new songs have no
      artwork yet.
- [x] v2 function deployed and **verified end-to-end** (2026-08-04): JSON
      objects landing in `plays/date=*/`, refresh ingests them, cutover from
      the CSV was gapless (CSV froze 02:16 UTC, first JSON play 02:19 UTC).
      Use `--skip-csv` on all future refresh runs. Artwork coverage: 99.2% of
      plays (73 of 2,006 songs missing; misses logged in `artwork_misses`).
- [x] Fixed v1 parser damage: hyphenated artists (A-ha, Run-D.M.C., Ne-Yo, …)
      had been split at the first hyphen; 20 pairs repaired in the DB, regex
      fixed in v2 (`\s+-\s+`).
- [x] Artwork fetch from MusicBrainz + Cover Art Archive
      (`scripts/fetch_artwork.py`, idempotent; misses tracked in
      `artwork_misses` table). Run periodically for newly appearing songs.
- [x] Dashboard **built** (2026-08-04): `dashboard/build.py` (DuckDB → compact
      JSON + rotation inference) and `dashboard/site/` (static, no deps,
      light/dark). All Tier 1 + Tier 2 features plus segment-based rotation
      inference using the May-2025 CT schedule (`radio_schedule_table.html`).
      Preview: `python3 -m http.server 8137 --directory dashboard/site`.
- [x] **Published** (2026-08-04): https://scubdon.github.io/wmradio/ from
      https://github.com/scubdon/wmradio. Daily Action at 10:00 UTC pulls the
      canonical DB from gs://wmradio-metadata/db/, ingests new plays, fetches
      artwork, uploads the DB back, rebuilds, deploys Pages. Auth: service
      account gh-actions-wmradio (objectAdmin on the bucket only), key stored
      as the GCP_SA_KEY Actions secret. First run verified end-to-end.

## Dashboard roadmap (from "Potential features.md", 2026-08-04)

All of the wishlist works on static GitHub Pages + Actions — the interactivity
is client-side JS over pre-computed data, no backend. Scale check: ~1.8k
distinct songs, ~950 artists, 223k plays ≈ 1–2 MB gzipped as compact arrays;
150px artwork thumbs total 17 MB.

**Tier 1 — Wrapped core (build first)**
- Top songs/artists for week/month/year/all-time, with artwork (pre-agg JSON)
- Recently-played scrollable artwork timeline
- Daily play-count plot with annotated recording gaps. Known gaps:
  2025-06-18→07-23 (36 days), 2026-03-24→27, 2024-07-06→08, 2024-10-07→09,
  and 4 scattered single days in 2024. Baseline ~390 plays/day.

**Tier 2 — differentiators (one shared data file powers all three)**
- "Your personal Walmart wrapped": pick your working hours/days → top
  songs/plays during those hours over a chosen timeframe. Centerpiece feature.
- Calendar/date picker → that day's plays chronologically.
- Per-song / per-artist occurrence timelines.
- Shared file design: `songs.json` (id → artist/song/artwork/totals) +
  columnar play history (song_id array + hour-resolution timestamp array).

**Tier 3 — analysis (runs in the daily Action, publishes results)**
- Playlist/rotation inference: overnight plays reveal the shuffled pool;
  rolling play-frequency detects songs entering/leaving rotation; publish
  "current rotation" with estimated add/drop dates.

**Deferred**: MotherDuck as live query backend (static is enough);
spotify_tracks audio features (Spotify killed the endpoint in 2024).

**Open decision**: canonical DuckDB file location for the Action — recommend
the GCS bucket (download → refresh → upload → emit site JSON), not git
(growing 40 MB binary). Needs a read-scoped service-account key as a GH
secret, or a public-read bucket.

## Dashboard notes (next phase)

- **Refresh cadence**: daily is fine. Simplest: a scheduled job (GitHub
  Actions cron, or local cron) runs `update_duckdb.py`, then rebuilds and
  publishes the dashboard.
- **Data source options**:
  1. *Static build* (recommended start): the daily job queries DuckDB and
     emits a static site (JSON + charts, e.g. Observable Framework / Evidence
     / hand-rolled). Free hosting, no live DB needed — fits the "not live,
     daily is fine" requirement.
  2. *MotherDuck*: you already mirror the DB there. The refresh script could
     also push new rows to MotherDuck, and a dashboard (or duckdb-wasm page
     with a read-scoped token) queries it directly. More moving parts; only
     worth it if you want ad-hoc interactive queries.
  3. *Parquet + httpfs* (the idea from earlier): have the daily job also
     write partitioned Parquet back to the bucket
     (`COPY plays TO 'gs://.../parquet' (FORMAT PARQUET, PARTITION_BY ...)`),
     so anything speaking DuckDB can `read_parquet()` it remotely. Not
     needed for a static daily build — revisit if other consumers appear.
- **Existing assets**: `v_song_totals`, `v_artist_totals`, `v_daily_counts`,
  `v_hour_dow_counts` views are aggregation-ready; local artwork images in
  `artwork/artwork_large/` keyed by rockbot file id. `spotify_tracks` table
  exists but is empty — audio-features enrichment is a possible future angle
  (note: Spotify deprecated the audio-features endpoint in late 2024, so
  BPM/energy/etc. would need another source).

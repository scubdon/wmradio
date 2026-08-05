# 📻 Walmart Radio, Charted

A dashboard of everything the in-store Walmart Radio stream has played since
May 2024 — logged minute-by-minute, refreshed daily. Not affiliated with
Walmart.

## How it works

```
radiomast metadata URL
  → Cloud Function (every minute; one small JSON object per song change)
  → gs://wmradio-metadata/plays/date=YYYY-MM-DD/
  → daily GitHub Action:
      scripts/update_duckdb.py   pull new plays into DuckDB
      scripts/fetch_artwork.py   cover art for new songs (MusicBrainz + CAA)
      dashboard/build.py         DuckDB → compact JSON for the site
  → GitHub Pages (dashboard/site — static, no dependencies)
```

The canonical DuckDB database lives in the GCS bucket; the Action downloads
it, refreshes it, and uploads it back. See `PLAN.md` for architecture notes
and `cloud_run_function/` for the logger.

## Local development

```bash
pip install duckdb requests
gcloud storage cp gs://wmradio-metadata/db/radio_plays.duckdb data/
python3 scripts/update_duckdb.py --skip-csv
python3 dashboard/build.py
python3 -m http.server 8137 --directory dashboard/site
```

Artwork courtesy of the [Cover Art Archive](https://coverartarchive.org) and
[MusicBrainz](https://musicbrainz.org).

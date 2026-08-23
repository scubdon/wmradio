# A record of the songs played on Walmart Radio

**→ [scubdon.github.io/wmradio](https://scubdon.github.io/wmradio/)**

(Almost) every song the in-store Walmart Radio stream has played since May 2024,
logged minute by minute and refreshed every eight hours — and what two years
of it reveals about how the station is programmed.

This is an independent, non-commercial record of a public broadcast, compiled by
listening to the stream. Not affiliated with, sponsored by, or endorsed by
Walmart.

---

## The data

The whole log is published with the site, regenerated on every build:

| File | Rows | Format |
|---|---|---|
| [`plays.csv`](https://scubdon.github.io/wmradio/data/plays.csv) | one per play | plain text, one header row |
| [`plays.parquet`](https://scubdon.github.io/wmradio/data/plays.parquet) | one per play | zstd-compressed, typed timestamps |
| [`README.txt`](https://scubdon.github.io/wmradio/data/README.txt) | — | data dictionary, coverage and outage list |

Three columns, and no sampling or aggregation — it is the same file the charts
are built from:

- **`played_at_utc`** — when the track change was observed. UTC, second
  precision. ISO 8601 with an explicit `Z` in the CSV
  (`2026-08-13T12:34:56Z`); a UTC-aware timestamp in the Parquet.
- **`artist`** — exactly as the stream reported it. Not normalised or
  deduplicated against MusicBrainz.
- **`song`** — the title as reported, including any "(Feat. …)" or remix credit.

Song identity is the `(artist, song)` pair.

Play counts are lower bounds. About 75% of the clock
hours in the span contain at least one logged play; most of the rest is the
live-show grid rather than the logger. Until April 2026 the station ran three
live shows on fixed daily slots (see below), and there are a couple of dozen
genuine logger outages on top of that. The site's
[Use the data](https://scubdon.github.io/wmradio/#dataSection) section lists
every outage and explains how coverage is measured — check anything that
compares two time periods against it.

## What the site works out

Nobody publishes what's in rotation on Walmart Radio, so the site derives it
from the log alone. Each analysis on the page carries a "How this is worked out"
panel stating its thresholds and what it can't tell you.

- **The rotation pool and its tiers** — how often each song comes round, and
  which tracks entered or were retired against the previous window.
- **Day and night are different stations** — songs are tested against a
  station-wide night baseline on Central time, and far more of them skew than
  chance allows.
- **Chris, Bo, Kirby Gwen & Friends** — the station's three live shows, on the
  fixed Central-time slots its own published programming page gives them, down
  to the morning show running two hours on weekdays and one at weekends. The
  music log carries no songs inside those hours and is busy outside them, so the
  daily grid reads straight off the schedule.
- **Records & oddities**, seasonal concentration, per-song and per-artist pages
  with play calendars and dot-per-play scatters, a personal "your shift"
  breakdown, and a searchable dataset explorer.


## Credits

Artwork via the [Cover Art Archive](https://coverartarchive.org) and
[MusicBrainz](https://musicbrainz.org), and from the stream's own metadata.
Album art remains the property of its respective rights holders and appears at
thumbnail size to illustrate the play data.

Times are recorded in UTC and shown in your browser's timezone, except the
day/night and schedule analyses, which use Central time — the station's own
clock.

Corrections and removal requests are welcome —
[open an issue](https://github.com/scubdon/wmradio/issues).

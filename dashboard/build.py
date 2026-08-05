#!/usr/bin/env python3
"""
Build the static dashboard data files from data/radio_plays.duckdb.

Emits into dashboard/site/data/:
  songs.json  — [[artist, song, artwork_file|null, total_plays], ...]; song id = index
  plays.json  — {"t0": <epoch-minute>, "dt": [...], "s": [...]}
                delta-encoded UTC epoch-minutes + song ids, ascending
  meta.json   — totals, recording gaps, schedule, rotation inference results

Also copies the 150px artwork thumbs used by the site into site/artwork/.

Run after scripts/update_duckdb.py. Pure read of the DB.
"""
import json
import shutil
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import duckdb

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "radio_plays.duckdb"
SITE = Path(__file__).resolve().parent / "site"
DATA_OUT = SITE / "data"
ART_SRC = ROOT / "artwork" / "artwork_small"
ART_OUT = SITE / "artwork"

CT = ZoneInfo("America/Chicago")

# Show schedule (May 2025, times CT). hour -> (weekday_show, weekend_show)
SCHEDULE_CT = {
    0: ("The Bo Show", "The Bo Show"),
    1: ("Overnights", "Overnights"),
    2: ("Overnights", "Overnights"),
    3: ("Kirby Gwen & Friends", "Kirby Gwen & Friends"),
    4: ("Overnights", "Overnights"),
    5: ("Overnights", "Overnights"),
    6: ("The Chris Show", "The Chris Show"),
    7: ("The Chris Show", "World Music"),
    8: ("Sensory Hours", "Sensory Hours"),
    9: ("Sensory Hours", "Sensory Hours"),
    10: ("World Music", "World Music"),
    11: ("World Music", "World Music"),
    12: ("The Bo Show", "The Bo Show"),
    13: ("World Music", "World Music"),
    14: ("World Music", "World Music"),
    15: ("Kirby Gwen & Friends", "Kirby Gwen & Friends"),
    16: ("World Music", "World Music"),
    17: ("World Music", "World Music"),
    18: ("The Chris Show", "The Chris Show"),
    19: ("World Music", "World Music"),
    20: ("World Music", "World Music"),
    21: ("World Music", "World Music"),
    22: ("World Music", "World Music"),
    23: ("Overnights", "Overnights"),
}

ROTATION_WINDOW_DAYS = 28
ROTATION_MIN_PLAYS = 4


def segment_for(ts_utc: datetime) -> str:
    ct = ts_utc.replace(tzinfo=timezone.utc).astimezone(CT)
    weekday, weekend = SCHEDULE_CT[ct.hour]
    return weekend if ct.weekday() >= 5 else weekday


def build_rotation(rows, songs_index):
    """rows: (ts_utc, song_id) in the rotation window."""
    total_by_song = Counter()
    seg_by_song = defaultdict(Counter)
    seg_totals = Counter()
    for ts, sid in rows:
        seg = segment_for(ts)
        total_by_song[sid] += 1
        seg_by_song[seg][sid] += 1
        seg_totals[seg] += 1

    window_total = sum(total_by_song.values())
    pool = {sid: n for sid, n in total_by_song.items() if n >= ROTATION_MIN_PLAYS}

    segments = {}
    for seg, counts in seg_by_song.items():
        seg_total = seg_totals[seg]
        entries = []
        for sid, n in counts.most_common():
            if n < 3:
                break
            overall_share = total_by_song[sid] / window_total
            lift = (n / seg_total) / overall_share if overall_share else 0
            entries.append([sid, n, round(lift, 2)])
        segments[seg] = {
            "hours_per_week": sum(
                (5 if wd == seg else 0) + (2 if we == seg else 0)
                for wd, we in SCHEDULE_CT.values()
            ),
            "total_plays": seg_total,
            "distinct_songs": len(counts),
            "top": entries[:25],
        }

    return {
        "window_days": ROTATION_WINDOW_DAYS,
        "min_plays": ROTATION_MIN_PLAYS,
        "window_plays": window_total,
        "pool_size": len(pool),
        "pool": sorted(([sid, n] for sid, n in pool.items()), key=lambda x: -x[1]),
        "segments": segments,
    }


def main():
    con = duckdb.connect(str(DB_PATH), read_only=True)
    DATA_OUT.mkdir(parents=True, exist_ok=True)
    ART_OUT.mkdir(parents=True, exist_ok=True)

    # --- songs.json (id = index, ordered by total plays desc) ---
    songs = con.execute("""
        SELECT artist, song, any_value(artwork_file) AS art, count(*) AS n
        FROM plays GROUP BY artist, song ORDER BY n DESC, artist, song
    """).fetchall()
    songs_index = {(a, s): i for i, (a, s, _, _) in enumerate(songs)}
    songs_out = [[a, s, art, n] for a, s, art, n in songs]

    # --- plays.json (delta-encoded epoch minutes UTC + song ids) ---
    plays = con.execute("""
        SELECT epoch(ts_utc)::BIGINT // 60 AS m, artist, song
        FROM plays ORDER BY ts_utc
    """).fetchall()
    t0 = plays[0][0]
    dts, sids = [], []
    prev = t0
    for m, a, s in plays:
        dts.append(int(m - prev))
        prev = m
        sids.append(songs_index[(a, s)])
    dts[0] = 0

    # --- gaps (days with zero plays, ET calendar like the DB) ---
    gaps = con.execute("""
        WITH cal AS (
            SELECT unnest(generate_series(
                (SELECT min(date_local) FROM plays),
                (SELECT max(date_local) FROM plays), INTERVAL 1 DAY))::DATE d),
        days AS (SELECT DISTINCT date_local FROM plays),
        missing AS (SELECT d FROM cal LEFT JOIN days ON d = date_local
                    WHERE date_local IS NULL),
        grp AS (SELECT d, d - (ROW_NUMBER() OVER (ORDER BY d))::INT g FROM missing)
        SELECT min(d)::VARCHAR, max(d)::VARCHAR FROM grp GROUP BY g ORDER BY 1
    """).fetchall()

    # --- rotation inference over the trailing window ---
    max_ts = con.execute("SELECT max(ts_utc) FROM plays").fetchone()[0]
    cutoff = max_ts - timedelta(days=ROTATION_WINDOW_DAYS)
    rot_rows = con.execute(
        "SELECT ts_utc, artist, song FROM plays WHERE ts_utc >= ?", [cutoff]
    ).fetchall()
    rotation = build_rotation(
        [(ts, songs_index[(a, s)]) for ts, a, s in rot_rows], songs_index
    )

    # --- weekly debuts (songs first ever heard that week) ---
    debuts = con.execute("""
        WITH firsts AS (SELECT artist, song, min(ts_utc) f FROM plays GROUP BY 1,2)
        SELECT date_trunc('week', f)::DATE::VARCHAR w, count(*) FROM firsts
        GROUP BY 1 ORDER BY 1
    """).fetchall()

    n_plays, n_artists, first_day, last_day = con.execute("""
        SELECT count(*), count(DISTINCT artist),
               min(date_local)::VARCHAR, max(date_local)::VARCHAR FROM plays
    """).fetchone()

    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total_plays": n_plays,
        "n_songs": len(songs),
        "n_artists": n_artists,
        "first_day": first_day,
        "last_day": last_day,
        "last_play_utc_min": int(plays[-1][0]),
        "gaps": [[a, b] for a, b in gaps],
        "weekly_debuts": [[w, n] for w, n in debuts],
        "rotation": rotation,
        "schedule_ct": {str(h): v for h, v in SCHEDULE_CT.items()},
    }

    (DATA_OUT / "songs.json").write_text(json.dumps(songs_out, separators=(",", ":")))
    (DATA_OUT / "plays.json").write_text(
        json.dumps({"t0": int(t0), "dt": dts, "s": sids}, separators=(",", ":")))
    (DATA_OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))

    # --- artwork thumbs for songs the site knows about ---
    copied = missing = 0
    wanted = {art for _, _, art, _ in songs if art}
    for fname in wanted:
        src = ART_SRC / fname
        dst = ART_OUT / fname
        if dst.exists():
            continue
        if src.exists():
            shutil.copy2(src, dst)
            copied += 1
        else:
            missing += 1

    sizes = {p.name: f"{(DATA_OUT / p.name).stat().st_size / 1024:.0f} KB"
             for p in DATA_OUT.iterdir()}
    print(f"plays: {n_plays:,}  songs: {len(songs):,}  artists: {n_artists:,}")
    print(f"data files: {sizes}")
    print(f"artwork thumbs: +{copied} copied, {missing} referenced but not on disk")
    print(f"rotation pool (last {ROTATION_WINDOW_DAYS}d): {rotation['pool_size']} songs")


if __name__ == "__main__":
    sys.exit(main())

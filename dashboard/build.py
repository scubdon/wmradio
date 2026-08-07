#!/usr/bin/env python3
"""
Build the static dashboard data files from data/radio_plays.duckdb.

Emits into dashboard/site/data/:
  songs.json  — [[artist, song, artwork_file|null, total_plays], ...]; song id = index
  plays.json  — {"t0": <epoch-minute>, "dt": [...], "s": [...]}
                delta-encoded UTC epoch-minutes + song ids, ascending
  meta.json   — totals, recording gaps, schedule, rotation inference results
  plays.csv / plays.parquet — full play log (played_at_utc, artist, song)
                for public download; linked from the site footer

Also copies the 150px artwork thumbs used by the site into site/artwork/.

Run after scripts/update_duckdb.py. Pure read of the DB.
"""
import json
import shutil
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from math import sqrt
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

ROTATION_WINDOW_DAYS = 28
ROTATION_MIN_PLAYS = 3

# Night is defined on the station's own clock (Central — Walmart's HQ timezone
# and the timezone its published schedule used), not the viewer's.
NIGHT_HOURS = set([23, 0, 1, 2, 3, 4, 5])
SKEW_WINDOW_DAYS = 56
SKEW_MIN_PLAYS = 10

# Play tiers, by plays in the 28-day window. (label, min_plays, blurb)
TIERS = [
    ("Heavy", 28, "at least once a day"),
    ("Regular", 14, "every other day or so"),
    ("Weekly", 7, "roughly twice a week"),
    ("Occasional", 3, "a few times a month"),
    ("One-off", 1, "once or twice, then gone"),
]


def ct_hour(ts_utc: datetime) -> int:
    return ts_utc.replace(tzinfo=timezone.utc).astimezone(CT).hour


def build_rotation(cur_rows, prev_ids, skew_rows):
    """
    cur_rows:  (ts_utc, song_id) inside the 28-day rotation window
    prev_ids:  set of song ids played in the preceding 28-day window
    skew_rows: (ts_utc, song_id) over the 56-day day/night test window

    No show/segment mapping: the published schedule can't be verified against
    the log (music runs straight through the blocks it says are talk), so
    everything here is derived from the clock alone.
    """
    counts = Counter(sid for _, sid in cur_rows)
    window_total = sum(counts.values())
    pool = {sid: n for sid, n in counts.items() if n >= ROTATION_MIN_PLAYS}

    tiers = []
    for label, floor, blurb in TIERS:
        higher = [f for _, f, _ in TIERS if f > floor]
        ceil = min(higher) if higher else 10**9
        members = sorted(((sid, n) for sid, n in counts.items() if floor <= n < ceil),
                         key=lambda x: -x[1])
        tiers.append({
            "label": label, "blurb": blurb, "min_plays": floor,
            "songs": len(members),
            "plays": sum(n for _, n in members),
            "top": members[:40],
        })

    # "In rotation" means the same thing on both sides of the comparison:
    # at least ROTATION_MIN_PLAYS in the window.
    cur_ids = set(pool)
    entered = sorted(((sid, counts[sid]) for sid in cur_ids - prev_ids),
                     key=lambda x: -x[1])
    left = prev_ids - cur_ids

    # --- day/night pools -------------------------------------------------
    # Each song gets a night share. Compared against the station-wide night
    # share, the spread is far wider than chance would produce — that's the
    # evidence for separate pools, without naming any show.
    night_by_song, tot_by_song = Counter(), Counter()
    night_plays = 0
    for ts, sid in skew_rows:
        tot_by_song[sid] += 1
        if ct_hour(ts) in NIGHT_HOURS:
            night_by_song[sid] += 1
            night_plays += 1
    baseline = night_plays / max(1, len(skew_rows))

    tested, zs = [], []
    for sid, n in tot_by_song.items():
        if n < SKEW_MIN_PLAYS:
            continue
        k = night_by_song[sid]
        z = (k / n - baseline) / sqrt(baseline * (1 - baseline) / n)
        tested.append((sid, n, k / n, z))
        zs.append(z)
    n_night = sum(1 for *_, z in tested if z > 2)
    n_day = sum(1 for *_, z in tested if z < -2)
    z_sd = sqrt(sum(z * z for z in zs) / len(zs)) if zs else 0

    # Within a tie on share, the most-played song is the more convincing
    # example — 0-for-27 says far more than 0-for-10.
    by_night = sorted(tested, key=lambda t: (-t[2], -t[1]))
    by_day = sorted(tested, key=lambda t: (t[2], -t[1]))
    daynight = {
        "window_days": SKEW_WINDOW_DAYS,
        "min_plays": SKEW_MIN_PLAYS,
        "baseline": round(baseline, 3),
        "n_tested": len(tested),
        "n_night": n_night,
        "n_day": n_day,
        "expected": round(0.0228 * len(tested)),
        "z_sd": round(z_sd, 2),
        "night_top": [[sid, n, round(s, 2)] for sid, n, s, _ in by_night[:20]],
        "day_top": [[sid, n, round(s, 2)] for sid, n, s, _ in by_day[:20]],
    }

    return {
        "window_days": ROTATION_WINDOW_DAYS,
        "min_plays": ROTATION_MIN_PLAYS,
        "window_plays": window_total,
        "pool_size": len(pool),
        "distinct_songs": len(counts),
        "tiers": tiers,
        "entered": entered[:40],
        "n_entered": len(entered),
        "n_left": len(left),
        "prev_pool": len(prev_ids),
        "daynight": daynight,
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
    prev_cutoff = max_ts - timedelta(days=2 * ROTATION_WINDOW_DAYS)
    skew_cutoff = max_ts - timedelta(days=SKEW_WINDOW_DAYS)

    rot_rows = con.execute(
        "SELECT ts_utc, artist, song FROM plays WHERE ts_utc >= ?", [cutoff]
    ).fetchall()
    prev_rows = con.execute(
        "SELECT artist, song FROM plays WHERE ts_utc >= ? AND ts_utc < ? "
        "GROUP BY 1, 2 HAVING count(*) >= ?",
        [prev_cutoff, cutoff, ROTATION_MIN_PLAYS],
    ).fetchall()
    skew_rows = con.execute(
        "SELECT ts_utc, artist, song FROM plays WHERE ts_utc >= ?", [skew_cutoff]
    ).fetchall()
    rotation = build_rotation(
        [(ts, songs_index[(a, s)]) for ts, a, s in rot_rows],
        {songs_index[(a, s)] for a, s in prev_rows},
        [(ts, songs_index[(a, s)]) for ts, a, s in skew_rows],
    )

    # --- weekly debuts (songs first ever heard that week) ---
    debuts = con.execute("""
        WITH firsts AS (SELECT artist, song, min(ts_utc) f FROM plays GROUP BY 1,2)
        SELECT date_trunc('week', f)::DATE::VARCHAR w, count(*) FROM firsts
        GROUP BY 1 ORDER BY 1
    """).fetchall()

    # --- monthly playlist-shape trends -----------------------------------
    # top50_share = how concentrated the month was (December spikes: holiday
    # music crowds everything else out). fresh_share = plays from songs that
    # were not played at all the month before.
    trends = con.execute("""
        WITH m AS (
            SELECT date_trunc('month', date_local)::DATE mo, artist, song, count(*) n
            FROM plays GROUP BY 1,2,3),
        tot AS (SELECT mo, sum(n) plays, count(*) distinct_songs FROM m GROUP BY 1),
        rk AS (SELECT mo, n, row_number() OVER (PARTITION BY mo ORDER BY n DESC) r FROM m),
        top50 AS (SELECT mo, sum(n) top_plays FROM rk WHERE r <= 50 GROUP BY 1),
        fresh AS (
            SELECT c.mo, sum(c.n) fresh_plays FROM m c
            LEFT JOIN m p ON p.artist = c.artist AND p.song = c.song
                         AND p.mo = c.mo - INTERVAL 1 MONTH
            WHERE p.song IS NULL GROUP BY 1)
        SELECT tot.mo::VARCHAR, tot.plays, tot.distinct_songs,
               round(top50.top_plays::DOUBLE / tot.plays, 3),
               round(coalesce(fresh.fresh_plays, 0)::DOUBLE / tot.plays, 3)
        FROM tot JOIN top50 USING (mo) LEFT JOIN fresh USING (mo) ORDER BY 1
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
        "trends": [[mo, p, d, t, f] for mo, p, d, t, f in trends],
        "rotation": rotation,
    }

    (DATA_OUT / "songs.json").write_text(json.dumps(songs_out, separators=(",", ":")))
    (DATA_OUT / "plays.json").write_text(
        json.dumps({"t0": int(t0), "dt": dts, "s": sids}, separators=(",", ":")))
    (DATA_OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))

    # --- public download files (times are naive UTC, like the DB) ---
    con.execute(f"""
        COPY (SELECT date_trunc('second', ts_utc) AS played_at_utc, artist, song
              FROM plays ORDER BY ts_utc)
        TO '{DATA_OUT / "plays.csv"}' (HEADER, DELIMITER ',')
    """)
    con.execute(f"""
        COPY (SELECT date_trunc('second', ts_utc) AS played_at_utc, artist, song
              FROM plays ORDER BY ts_utc)
        TO '{DATA_OUT / "plays.parquet"}' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)

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
    dn = rotation["daynight"]
    print(f"rotation pool (last {ROTATION_WINDOW_DAYS}d): {rotation['pool_size']} songs "
          f"of {rotation['distinct_songs']} heard; +{rotation['n_entered']} in, "
          f"-{rotation['n_left']} out vs prior window")
    print(f"day/night: {dn['n_night']} night-skewed + {dn['n_day']} day-skewed of "
          f"{dn['n_tested']} tested (chance would give ~{dn['expected']} each); "
          f"z sd={dn['z_sd']}")


if __name__ == "__main__":
    sys.exit(main())

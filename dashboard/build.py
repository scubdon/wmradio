#!/usr/bin/env python3
"""
Build the static dashboard data files from data/radio_plays.duckdb.

Emits into dashboard/site/data/:
  songs.json  — [[artist, song, artwork_file|null, total_plays], ...]; song id = index
  plays.json  — {"t0": <epoch-minute>, "dt": [...], "s": [...]}
                delta-encoded UTC epoch-minutes + song ids, ascending
  meta.json   — totals, recording gaps, rotation inference, records & oddities,
                dataset coverage
  plays.csv / plays.parquet — full play log (played_at_utc, artist, song)
                for public download; linked from the site footer

Anything a browser can derive in one pass over plays.json (per-song play counts,
recent-window totals, gaps between plays) is deliberately left to the client —
only cross-song work that would need the whole log resident is precomputed here.

Also copies the 150px artwork thumbs used by the site into site/artwork/.

Run after scripts/update_duckdb.py. Pure read of the DB.
"""
import json
import shutil
import sys
from bisect import bisect_right
from collections import Counter
from datetime import date, datetime, timedelta, timezone
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

# What counts as the logger being down, as opposed to the stream simply not
# reporting a track. Deliberately conservative: hour-long silences are common
# and *structured* — they land on the same Central-time hours every day, which
# is a programme grid, not failure (see build_silence). Only multi-hour holes
# get called downtime, and in practice every one of those runs half a day or
# more.
OUTAGE_MIN_MINUTES = 6 * 60

# Silences long enough to be worth reporting, but short enough to be the
# station rather than the logger.
QUIET_MIN_MINUTES = 45

# An hour counts as off air if it logged at most this many track changes. Not
# zero: a song that starts a minute before the top of the hour still lands one
# row inside it, which is why the midnight block looked half-hearted when this
# was a zero test. The distribution is starkly bimodal — across the grid era,
# hours inside a show slot come in at 0, 1, 2 or 3 changes (3,756 of them) or at
# 12+ (290, the December suspension); nothing at all lands in between.
SILENT_MAX_PLAYS = 2

# A day is "gridded" if this many Central-time hours were off air. The show
# blocks take out seven a day; a day running music round the clock takes out
# none. Nothing sits in between, so the cut is safe.
GRID_MIN_SILENT_HOURS = 4

# The station's own published schedule (its programming page, as kept locally in
# radio_schedule_table.html). Only the personality shows are listed here, and
# only because the log independently says they are the silent hours: every slot
# below is a metadata blackout, and every music block on the same schedule —
# Walmart World Music, Walmart World Overnights, the 8–10a Sensory Hours —
# reports track changes as normal. The names are the station's; the hours below
# are what the log actually shows, recomputed every build.
WEEKDAYS, WEEKEND, EVERY_DAY = frozenset(range(5)), frozenset({5, 6}), frozenset(range(7))
SHOWS = [
    ("The Chris Show", [(6, 8, WEEKDAYS), (6, 7, WEEKEND), (18, 19, EVERY_DAY)]),
    ("The Bo Show", [(0, 1, EVERY_DAY), (12, 13, EVERY_DAY)]),
    ("Kirby Gwen & Friends", [(3, 4, EVERY_DAY), (15, 16, EVERY_DAY)]),
]

# "Seasonal" is derived, not keyword-matched: a song whose plays cluster in the
# run-up to Christmas. Nov 15 – Dec 31 is the window the log's December spike
# actually occupies.
SEASON_START = (11, 15)

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


def build_rotation(cur_rows, prev_counts, skew_rows, spans):
    """
    cur_rows:    (ts_utc, song_id) inside the 28-day rotation window
    prev_counts: {song_id: plays} for the preceding 28-day window
    skew_rows:   (ts_utc, song_id) over the 56-day day/night test window
    spans:       {song_id: (first_ts, last_ts)} over the whole log

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
    prev_ids = set(prev_counts)
    entered = sorted(((sid, counts[sid]) for sid in cur_ids - prev_ids),
                     key=lambda x: -x[1])
    left = prev_ids - cur_ids

    # Songs that fell out. The interesting columns are the ones you can't see
    # from a play count: how hard it was being played right before it stopped,
    # and how long it had been around. Ranked by former intensity — a track
    # dropping from 2 plays a day is a bigger change than one dropping from 3
    # plays a month. counts[sid] is what it still managed this window (often 0).
    dropped = []
    for sid in left:
        n_prev = prev_counts[sid]
        first, last = spans[sid]
        dropped.append([
            sid, n_prev,
            round(n_prev / ROTATION_WINDOW_DAYS, 2),
            counts.get(sid, 0),
            last.date().isoformat(),
            max(1, (last - first).days),
        ])
    dropped.sort(key=lambda r: -r[1])

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
        "dropped": dropped[:40],
        "n_left": len(left),
        "prev_pool": len(prev_ids),
        "daynight": daynight,
    }


def outage_spans(plays_min):
    """
    Stretches the logger was demonstrably not listening, read off the play
    sequence itself rather than off the calendar — so partial-day outages that
    a blank-day count misses are included.
    """
    return [(a, b) for a, b in zip(plays_min, plays_min[1:])
            if b - a >= OUTAGE_MIN_MINUTES]


def build_coverage(plays_min, down, first_day, last_day, n_gap_days):
    """
    What a downloader of the CSV needs in order to judge it: how much of the
    span was actually observed, and what the holes are.

    Coverage is stated as the share of clock hours containing at least one
    logged play. That is the claim the data can actually support: the rest of
    the silence splits into a handful of long outages (below) and a great many
    short, regularly-timed quiet blocks that are the stream's own behaviour,
    and it would be dishonest to bundle the second kind into a downtime figure.
    """
    span = plays_min[-1] - plays_min[0]
    covered_hours = len({m // 60 for m in plays_min})
    span_hours = round(span / 60)

    quiet = [b - a for a, b in zip(plays_min, plays_min[1:])
             if QUIET_MIN_MINUTES <= b - a < OUTAGE_MIN_MINUTES]

    return {
        "first_day": first_day,
        "last_day": last_day,
        "span_days": round(span / 1440),
        "span_hours": span_hours,
        "covered_hours": covered_hours,
        "uptime": round(covered_hours / max(1, span_hours), 4),
        "blank_days": n_gap_days,
        "n_outages": len(down),
        "outage_hours": round(sum(b - a for a, b in down) / 60),
        "longest_outage_hours": round(max((b - a for a, b in down), default=0) / 60),
        "n_quiet": len(quiet),
        "quiet_hours": round(sum(quiet) / 60),
        "rows": len(plays_min),
        "csv_bytes": (DATA_OUT / "plays.csv").stat().st_size,
        "parquet_bytes": (DATA_OUT / "plays.parquet").stat().st_size,
    }


DOW_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def deltas(xs):
    """First value zero, then successive differences — the client re-adds t0."""
    return [b - a for a, b in zip(xs[:1] + xs, xs)]


def describe_days(dows):
    if len(dows) == 7:
        return "every day"
    if dows == {0, 1, 2, 3, 4}:
        return "weekdays"
    if dows == {5, 6}:
        return "weekends"
    return ", ".join(DOW_NAMES[d] for d in sorted(dows))


def build_silence(con, down):
    """
    The station's daily programme grid, read off the silences.

    The stream announces a track change and nothing else — no talk, no ads, no
    dead air. So an hour that logs nothing is an hour the stream was not
    playing songs, and for most of this log those hours are *the same hours
    every day* on Central time, the station's own clock. That is a schedule,
    and it is the only view of one this dataset contains: the published
    schedule can't be matched against the log (see the project notes), but the
    holes can.

    down: [(start_min, end_min)] UTC epoch-minute outage spans, so days the
    logger slept are dropped rather than counted as the station going quiet.
    """
    rows = con.execute("""
        WITH p AS (SELECT (ts_utc AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') ct
                   FROM plays)
        SELECT ct::DATE::VARCHAR AS d, hour(ct) AS h, count(*) AS n
        FROM p GROUP BY 1, 2
    """).fetchall()

    by_day = {}
    for d, h, n in rows:
        by_day.setdefault(d, {})[h] = n

    # A partial day is indistinguishable from a quiet one, so drop any date the
    # logger was down for part of, plus the first and last (both truncated).
    skip = set()
    for a, b in down:
        d = datetime.fromtimestamp(a * 60, timezone.utc).astimezone(CT).date()
        end = datetime.fromtimestamp(b * 60, timezone.utc).astimezone(CT).date()
        while d <= end:
            skip.add(d.isoformat())
            d += timedelta(days=1)
    days = sorted(by_day)
    skip.update(days[:1] + days[-1:])
    days = [d for d in days if d not in skip]
    if not days:
        return None

    silent = {d: {h for h in range(24) if by_day[d].get(h, 0) <= SILENT_MAX_PLAYS}
              for d in days}
    gridded = {d for d in days if len(silent[d]) >= GRID_MIN_SILENT_HOURS}

    # The changeover is the start of the run of gridless days that reaches the
    # present. Isolated gridless days earlier on (the December holiday run,
    # which suspends the grid on weekdays) stay in the "before" era, where they
    # belong — they were exceptions to a schedule that was still in force.
    i = len(days)
    while i > 0 and days[i - 1] not in gridded:
        i -= 1
    changeover = days[i] if i < len(days) else None

    def era(subset):
        if not subset:
            return None
        n_days = [[0] * 24 for _ in range(7)]
        n_silent = [[0] * 24 for _ in range(7)]
        n_plays = [[0] * 24 for _ in range(7)]
        plays = 0
        for d in subset:
            dow = date.fromisoformat(d).weekday()
            plays += sum(by_day[d].values())
            for h in range(24):
                n_days[dow][h] += 1
                n_plays[dow][h] += by_day[d].get(h, 0)
                if h in silent[d]:
                    n_silent[dow][h] += 1
        grid = [[round(n_silent[w][h] / n_days[w][h], 3) if n_days[w][h] else None
                 for h in range(24)] for w in range(7)]
        return {
            "days": len(subset),
            "from": subset[0],
            "to": subset[-1],
            "grid": grid,
            "plays": [[round(n_plays[w][h] / n_days[w][h], 1) if n_days[w][h] else None
                       for h in range(24)] for w in range(7)],
            "plays_per_day": round(plays / len(subset)),
            "silent_hours_per_day": round(
                sum(len(silent[d]) for d in subset) / len(subset), 1),
        }

    before = era(days[:i])
    after = era(days[i:])

    # Contiguous runs of hours that are silent on most days, grouped by which
    # days they apply to — the schedule in words rather than in colour.
    blocks = []
    if before:
        per_hour = [{w for w in range(7) if (before["grid"][w][h] or 0) >= 0.6}
                    for h in range(24)]
        h = 0
        while h < 24:
            if not per_hour[h]:
                h += 1
                continue
            j = h
            while j + 1 < 24 and per_hour[j + 1] == per_hour[h]:
                j += 1
            blocks.append({"from": h, "to": j + 1, "days": describe_days(per_hour[h])})
            h = j + 1

    # --- match the derived blocks against the station's published schedule ---
    # The grid above was read off the log without reference to any schedule.
    # This is the check, and it is the whole argument: if the named shows are
    # what fills the blocks, then every show hour should be off air and every
    # other hour should not.
    slot_of = {}
    for i, (name, slots) in enumerate(SHOWS):
        for a, b, dows in slots:
            for h in range(a, b):
                for w in dows:
                    slot_of[(w, h)] = i

    hit = miss = false_alarm = clear = 0
    per_show = [{"name": name, "hours": 0, "by_year": {}, "slots": slots}
                for name, slots in SHOWS]
    occ = []            # (start_epoch_minute, minutes, show index) for observed hours
    for d in days:
        if d not in gridded:
            continue
        dt = date.fromisoformat(d)
        w = dt.weekday()
        for h in range(24):
            off = h in silent[d]
            show = slot_of.get((w, h))
            if show is None:
                false_alarm += off
                clear += not off
                continue
            hit += off
            miss += not off
            if off:
                s = per_show[show]
                s["hours"] += 1
                s["by_year"][dt.year] = s["by_year"].get(dt.year, 0) + 1
                start = datetime(dt.year, dt.month, dt.day, h, tzinfo=CT)
                occ.append((int(start.timestamp()) // 60, 60, show))

    # Merge each show's adjacent hours into one on-air stretch, so a listener's
    # 6–8am is one two-hour block rather than two ones.
    occ.sort()
    merged = []
    for start, mins, show in occ:
        if merged and merged[-1][2] == show and merged[-1][0] + merged[-1][1] == start:
            merged[-1][1] += mins
        else:
            merged.append([start, mins, show])

    for s in per_show:
        s["by_year"] = sorted(s["by_year"].items())
        s["slots"] = [[a, b, describe_days(set(dows))] for a, b, dows in s["slots"]]

    return {
        "changeover": changeover,
        "blocks": blocks,
        "before": before,
        "after": after,
        "shows": {
            "names": [name for name, _ in SHOWS],
            "per_show": per_show,
            # Delta-encoded so the occurrence list stays small in meta.json.
            "t0": merged[0][0] if merged else 0,
            "dt": deltas([m[0] for m in merged]),
            "mins": [m[1] for m in merged],
            "s": [m[2] for m in merged],
            "match": {
                "show_hours_off": hit,
                "show_hours_total": hit + miss,
                "other_hours_off": false_alarm,
                "other_hours_total": false_alarm + clear,
            },
        },
    }


def build_records(con, seq, songs, songs_index, pool_ids, down):
    """
    Records & oddities — the "how is that even possible" facts a 224k-play log
    contains and a chart doesn't show. Everything here is one query or one pass;
    it's all recomputed from scratch on every build.

    seq:  (epoch_minute, song_id) ascending
    down: [(start_min, end_min)] stretches the logger was not listening

    Every query here picks a single winning row, and ties for the top spot are
    normal rather than exotic — hundreds of songs sit at exactly one play. So
    each ORDER BY carries enough columns to break every tie, or the same
    database would publish a different record on the next build. Dated records
    break ties towards the earlier date: whoever reached the number first holds
    it until something beats it, rather than merely matching it.
    """
    def rec(key, title, value, sub, sid=None, artist=None):
        return {"k": key, "title": title, "value": value, "sub": sub,
                "sid": sid, "artist": artist}

    out = []
    sid_of = lambda a, s: songs_index[(a, s)]

    # --- all-time leaders -------------------------------------------------
    top_artist, artist_plays, artist_songs = con.execute("""
        SELECT artist, count(*) n, count(DISTINCT song) k
        FROM plays GROUP BY 1 ORDER BY n DESC, artist LIMIT 1
    """).fetchone()
    out.append(rec("top_song", "Most-played song ever", f"{songs[0][3]:,} plays",
                   f"{songs[0][1]} — {songs[0][0]}", sid=0))
    out.append(rec("top_artist", "Most-played artist ever", f"{artist_plays:,} plays",
                   f"{top_artist} · {artist_songs} songs in the log", artist=top_artist))

    wide = con.execute("""
        SELECT artist, count(DISTINCT song) k FROM plays
        GROUP BY 1 ORDER BY k DESC, artist LIMIT 1
    """).fetchone()
    out.append(rec("widest_artist", "Most different songs by one artist", f"{wide[1]} songs",
                   f"{wide[0]} — everything they have ever had played",
                   artist=wide[0]))

    # --- single-day extremes ---------------------------------------------
    d = con.execute("""
        SELECT artist, song, date_local::VARCHAR, count(*) n FROM plays
        GROUP BY 1,2,3 ORDER BY n DESC, 3, artist, song LIMIT 1
    """).fetchone()
    out.append(rec("song_day", "Most plays of one song in a day", f"{d[3]}×",
                   f"{d[1]} — {d[0]}, on {d[2]}", sid=sid_of(d[0], d[1])))

    d = con.execute("""
        SELECT artist, date_local::VARCHAR, count(*) n, count(DISTINCT song) k
        FROM plays GROUP BY 1,2 ORDER BY n DESC, 2, artist LIMIT 1
    """).fetchone()
    out.append(rec("artist_day", "Most airtime for one artist in a day", f"{d[2]} plays",
                   f"{d[0]} — {d[3]} different songs, on {d[1]}", artist=d[0]))

    # --- seasonality, derived rather than keyword-matched -----------------
    mo, day = SEASON_START
    season = con.execute(f"""
        WITH s AS (
            SELECT artist, song, count(*) n,
                   sum(CASE WHEN month(date_local) = 12
                              OR (month(date_local) = {mo} AND day(date_local) >= {day})
                            THEN 1 ELSE 0 END) x
            FROM plays GROUP BY 1,2 HAVING count(*) >= 20)
        SELECT artist, song, n, x::DOUBLE / n FROM s
        ORDER BY 4 DESC, n DESC, artist, song LIMIT 1
    """).fetchone()
    if season:
        out.append(rec("seasonal", "Most relentlessly seasonal song",
                       f"{round(season[3] * 100)}% in December",
                       f"{season[1]} — {season[0]}, {season[2]:,} plays, almost all of "
                       f"them after mid-November", sid=sid_of(season[0], season[1])))

    # --- gap-based records, one pass over the per-song play times ---------
    by_song = {}
    for i, (m, sid) in enumerate(seq):
        by_song.setdefault(sid, []).append((m, i))

    # A silence only counts against the station for the part of it we were
    # actually listening to, so downtime is subtracted from every gap rather
    # than disqualifying it — otherwise the 36-day 2025 outage would knock out
    # every candidate that happens to straddle it. Both ends of a downtime span
    # are themselves plays, so no song gap ever starts or ends inside one and a
    # prefix sum over the spans is exact.
    down_ends = [e for _, e in down]
    down_cum = [0]
    for s, e in down:
        down_cum.append(down_cum[-1] + (e - s))
    cum_down = lambda x: down_cum[bisect_right(down_ends, x)]
    observed = lambda a, b: (b - a) - (cum_down(b) - cum_down(a))

    best_short = best_return = best_burst = best_streak = None

    for sid, plays_of in by_song.items():
        if len(plays_of) < 2:
            continue
        ms = [m for m, _ in plays_of]
        for (a, ia), (b, ib) in zip(plays_of, plays_of[1:]):
            gap = b - a
            # The failure mode for a tiny gap is the metadata endpoint
            # flickering off and back onto the same track, which logs as a
            # repeat with nothing in between. Requiring at least one other
            # song between the two plays rules that out; what survives is the
            # station genuinely coming back round to it.
            if ib - ia >= 2 and (best_short is None or gap < best_short[1]):
                best_short = (sid, gap, b)
            if best_return is None or observed(a, b) > best_return[1]:
                best_return = (sid, observed(a, b), b, gap)

        # Most plays inside any rolling 24 hours.
        lo = 0
        for hi in range(len(ms)):
            while ms[hi] - ms[lo] > 1440:
                lo += 1
            if best_burst is None or hi - lo + 1 > best_burst[1]:
                best_burst = (sid, hi - lo + 1, ms[hi])

        # Longest run of consecutive days with at least one play. Uses UTC day
        # boundaries (the log's own clock) — good enough for a streak.
        days = sorted({m // 1440 for m in ms})
        run = best = 1
        end = days[0]
        for p, q in zip(days, days[1:]):
            run = run + 1 if q == p + 1 else 1
            if run > best:
                best, end = run, q
        if best_streak is None or best > best_streak[1]:
            best_streak = (sid, best, end * 1440)

    fmt_day = lambda m: datetime.fromtimestamp(m * 60, timezone.utc).date().isoformat()

    if best_short:
        sid, gap, when = best_short
        out.append(rec("short_gap", "Shortest gap between repeats",
                       f"{gap // 60}h {gap % 60}m" if gap >= 60 else f"{gap} min",
                       f"{songs[sid][1]} — {songs[sid][0]}, twice on {fmt_day(when)}",
                       sid=sid))
    if best_burst:
        sid, n, when = best_burst
        out.append(rec("burst", "Most plays of one song in 24 hours", f"{n}×",
                       f"{songs[sid][1]} — {songs[sid][0]}, ending {fmt_day(when)}",
                       sid=sid))
    if best_streak:
        sid, n, when = best_streak
        out.append(rec("streak", "Longest run of consecutive days played", f"{n} days",
                       f"{songs[sid][1]} — {songs[sid][0]}, through {fmt_day(when)}",
                       sid=sid))
    if best_return:
        sid, gap, when, raw = best_return
        # The value is listening time, not calendar time: any logger downtime
        # inside the stretch is deducted, because we cannot claim the station
        # skipped a song during hours nobody was watching. Both numbers are
        # stated so the deduction is visible rather than implied.
        lost = round((raw - gap) / 1440)
        out.append(rec("return", "Longest disappearance before coming back",
                       f"{round(gap / 1440)} days",
                       f"{songs[sid][1]} — {songs[sid][0]} resurfaced on {fmt_day(when)}. "
                       f"{round(raw / 1440):,} days passed in all; "
                       + (f"{lost:,} of them fall inside logger outages and are not counted."
                          if lost else "the logger was up for all of it."), sid=sid))

    # --- longest-serving track --------------------------------------------
    span_best = max(
        ((sid, p[0][0], p[-1][0], len(p)) for sid, p in by_song.items() if len(p) >= 50),
        key=lambda r: r[2] - r[1], default=None)
    if span_best:
        sid, a, b, n = span_best
        out.append(rec("longest_active", "Longest-serving song",
                       f"{round((b - a) / 1440)} days",
                       f"{songs[sid][1]} — {songs[sid][0]}, {n:,} plays from "
                       f"{fmt_day(a)} to {fmt_day(b)}", sid=sid))

    # --- who owns the current rotation ------------------------------------
    pool_artists = Counter(songs[sid][0] for sid in pool_ids)
    if pool_artists:
        # most_common() would settle a tie by whichever artist the pool set
        # happened to yield first; sort the name in as a tiebreaker instead.
        name, k = min(pool_artists.items(), key=lambda kv: (-kv[1], kv[0]))
        out.append(rec("pool_artist", "Most songs in rotation right now", f"{k} songs",
                       f"{name} — of the {len(pool_ids):,} titles currently in rotation",
                       artist=name))

    # --- longest stretch with nothing repeated ----------------------------
    # Sliding window over the whole log: how long can you stand in the aisle
    # before the station plays something you have already heard that shift?
    last_at, start, best_run = {}, 0, (0, 0, 0)
    for i, (m, sid) in enumerate(seq):
        if last_at.get(sid, -1) >= start:
            start = last_at[sid] + 1
        last_at[sid] = i
        if i - start + 1 > best_run[0]:
            best_run = (i - start + 1, seq[start][0], m)
    if best_run[0] > 1:
        n, a, b = best_run
        out.append(rec("norepeat", "Longest run with nothing repeated", f"{n} songs",
                       f"{round((b - a) / 60)} hours straight without a single track "
                       f"coming back, ending {fmt_day(b)}"))

    # --- station-level extremes -------------------------------------------
    d = con.execute("""
        SELECT date_local::VARCHAR, count(*) n, count(DISTINCT song) k
        FROM plays GROUP BY 1 ORDER BY n DESC, 1 LIMIT 1
    """).fetchone()
    out.append(rec("busiest", "Busiest day the station has had", f"{d[1]} plays",
                   f"{d[0]} — {d[2]} different songs, one every "
                   f"{round(1440 / d[1] * 10) / 10:g} minutes"))

    # First heard *since* the opening weeks, which are all debuts by definition.
    d = con.execute("""
        WITH f AS (SELECT artist, song, min(date_local) d FROM plays GROUP BY 1, 2)
        SELECT d::VARCHAR, count(*) k FROM f
        WHERE d > (SELECT min(date_local) + 60 FROM plays)
        GROUP BY 1 ORDER BY k DESC, 1 LIMIT 1
    """).fetchone()
    if d:
        out.append(rec("intake", "Most new songs added in one day", f"{d[1]} songs",
                       f"all heard for the first time on {d[0]}"))

    # --- the long tail ----------------------------------------------------
    # One row, picked once: several one-play songs routinely share the same
    # date, and independent any_value(... ORDER BY d) calls are free to answer
    # from different rows, which would pair one song's title with another's
    # artist. Take the whole row in a single ORDER BY instead, alphabetical
    # within a date so the same day always yields the same track.
    once = con.execute("""
        WITH s AS (SELECT artist, song, count(*) n, max(date_local) d FROM plays GROUP BY 1, 2),
        o AS (SELECT artist, song, d FROM s WHERE n = 1)
        SELECT (SELECT count(*) FROM o), artist, song, d::VARCHAR
        FROM o ORDER BY d DESC, artist, song LIMIT 1
    """).fetchone()
    if once and once[0]:
        out.append(rec("once", "Songs played exactly once, ever", f"{once[0]} songs",
                       f"the most recent was {once[2]} — {once[1]}, on {once[3]}",
                       sid=sid_of(once[1], once[2])))

    # --- tied to a single hour of the day ---------------------------------
    # The day/night split writ small: a song that keeps its appointment.
    ck = con.execute("""
        WITH p AS (
            SELECT artist, song,
                   hour(ts_utc AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago') h
            FROM plays),
        t AS (SELECT artist, song, count(*) n FROM p GROUP BY 1, 2 HAVING count(*) >= 100),
        x AS (SELECT p.artist, p.song, h, count(*) k FROM p JOIN t USING (artist, song)
              GROUP BY 1, 2, 3)
        SELECT x.artist, x.song, x.h, x.k, t.n
        FROM x JOIN t USING (artist, song)
        ORDER BY x.k::DOUBLE / t.n DESC, x.artist, x.song, x.h LIMIT 1
    """).fetchone()
    if ck:
        artist, song, h, k, n = ck
        out.append(rec("clockbound", "Most clock-bound song",
                       f"{round(k / n * 100)}% in one hour",
                       f"{song} — {artist}, {k} of its {n} plays between "
                       f"{h}:00 and {h + 1}:00 Central", sid=sid_of(artist, song)))

    # --- when the holiday takeover starts ---------------------------------
    mo, day = SEASON_START
    xmas = con.execute(f"""
        WITH s AS (
            SELECT artist, song, count(*) n,
                   sum(CASE WHEN month(date_local) = 12
                              OR (month(date_local) = {mo} AND day(date_local) >= {day})
                            THEN 1 ELSE 0 END) x
            FROM plays GROUP BY 1, 2 HAVING count(*) >= 20),
        holiday AS (SELECT artist, song FROM s WHERE x::DOUBLE / n >= 0.9),
        seasons AS (
            SELECT year(date_local) y, min(date_local) d, count(*) n
            FROM plays JOIN holiday USING (artist, song)
            WHERE month(date_local) >= 9 GROUP BY 1)
        SELECT d::VARCHAR, y, n, (SELECT count(*) FROM holiday)
        FROM seasons ORDER BY y DESC LIMIT 1
    """).fetchone()
    if xmas:
        first, year, n, k = xmas
        d0 = date.fromisoformat(first)
        out.append(rec("xmas", "When Christmas starts at Walmart",
                       f"{d0.strftime('%B')} {d0.day}",
                       f"the first of {k} holiday-only songs to surface in {year}, "
                       f"{(date(year, 12, 25) - d0).days} days out. "
                       f"{n:,} holiday plays followed before the year was over."))

    return out


def main():
    con = duckdb.connect(str(DB_PATH), read_only=True)
    DATA_OUT.mkdir(parents=True, exist_ok=True)
    ART_OUT.mkdir(parents=True, exist_ok=True)

    # --- songs.json (id = index, ordered by total plays desc) ---
    songs = con.execute("""
        SELECT artist, song, min(artwork_file) AS art, count(*) AS n
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
        "SELECT artist, song, count(*) FROM plays WHERE ts_utc >= ? AND ts_utc < ? "
        "GROUP BY 1, 2 HAVING count(*) >= ?",
        [prev_cutoff, cutoff, ROTATION_MIN_PLAYS],
    ).fetchall()
    skew_rows = con.execute(
        "SELECT ts_utc, artist, song FROM plays WHERE ts_utc >= ?", [skew_cutoff]
    ).fetchall()
    span_rows = con.execute(
        "SELECT artist, song, min(ts_utc), max(ts_utc) FROM plays GROUP BY 1, 2"
    ).fetchall()
    rotation = build_rotation(
        [(ts, songs_index[(a, s)]) for ts, a, s in rot_rows],
        {songs_index[(a, s)]: n for a, s, n in prev_rows},
        [(ts, songs_index[(a, s)]) for ts, a, s in skew_rows],
        {songs_index[(a, s)]: (f, l) for a, s, f, l in span_rows},
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

    # --- public download files (times are naive UTC, like the DB) ---
    # Written before meta.json so the coverage panel can quote real file sizes.
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

    # --- records & dataset coverage --------------------------------------
    play_min = [int(m) for m, _, _ in plays]
    down = outage_spans(play_min)
    pool_ids = {sid for sid, n in Counter(songs_index[(a, s)] for _, a, s in rot_rows
                                          ).items() if n >= ROTATION_MIN_PLAYS}
    records = build_records(con, list(zip(play_min, sids)), songs_out, songs_index,
                            pool_ids, down)
    blank_days = sum((date.fromisoformat(b) - date.fromisoformat(a)).days + 1
                     for a, b in gaps)
    coverage = build_coverage(play_min, down, first_day, last_day, blank_days)
    silence = build_silence(con, down)

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
        "records": records,
        "coverage": coverage,
        "silence": silence,
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
    dn = rotation["daynight"]
    print(f"rotation pool (last {ROTATION_WINDOW_DAYS}d): {rotation['pool_size']} songs "
          f"of {rotation['distinct_songs']} heard; +{rotation['n_entered']} in, "
          f"-{rotation['n_left']} out vs prior window")
    print(f"day/night: {dn['n_night']} night-skewed + {dn['n_day']} day-skewed of "
          f"{dn['n_tested']} tested (chance would give ~{dn['expected']} each); "
          f"z sd={dn['z_sd']}")
    print(f"coverage: {coverage['uptime'] * 100:.1f}% of hours have a play over "
          f"{coverage['span_days']} days · {coverage['n_outages']} outages "
          f"({coverage['outage_hours']}h, longest {coverage['longest_outage_hours']}h) · "
          f"{coverage['n_quiet']} short quiet blocks ({coverage['quiet_hours']}h)")
    print(f"records: {len(records)}")
    if silence:
        b, a = silence["before"], silence["after"]
        print("silence grid: " + " · ".join(
            f"{x['from']}–{x['to']} CT, {'every day' if x['days'] == 'every day' else x['days']}"
            for x in silence["blocks"]))
        print(f"  grid era: {b['days']} days, {b['silent_hours_per_day']}h/day silent, "
              f"{b['plays_per_day']} plays/day"
              + (f" · dropped {silence['changeover']}: {a['days']} days since, "
                 f"{a['silent_hours_per_day']}h/day silent, {a['plays_per_day']} plays/day"
                 if a else " · still in force"))
        m = silence["shows"]["match"]
        print(f"  schedule match: {m['show_hours_off']}/{m['show_hours_total']} published show "
              f"hours off air; {m['other_hours_off']}/{m['other_hours_total']} other hours off air")
        for s in silence["shows"]["per_show"]:
            print(f"    {s['name']}: {s['hours']:,}h — "
                  + ", ".join(f"{y}: {n:,}h" for y, n in s["by_year"]))


if __name__ == "__main__":
    sys.exit(main())

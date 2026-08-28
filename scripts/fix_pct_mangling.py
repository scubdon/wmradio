#!/usr/bin/env python3
"""
Repair the percent-mangled punctuation the metadata feed emitted between
2025-07-24 and 2025-09-08.

A second, distinct corruption from the one fix_mojibake.py handles. At the start
of the radiomast era the feed rendered a handful of punctuation characters as a
literal ASCII run beginning with '%': 'MO with a stroke' arrived as 'M%3*%0/'
and 'half-bullet-alive' as 'half%5)%/0%1)alive'. Unlike the fix_mojibake case
this is *not* a straight substring replacement, because the feed also truncated
the title at the first mangled character: 'Maybe You%5)%/0' is the whole of what
it sent for "Maybe You're The Problem". Decoding alone would leave 'Maybe You'
with a dangling apostrophe, which is still not the song.

What makes the repair safe is that every mangled pair has a correctly spelled
twin already in the log -- the feed only misbehaved intermittently, so the same
track landed clean on adjacent days. So each corrupt row is a phantom splitting
one song's play count in two, and the tail the feed dropped can be *read back*
off the twin instead of guessed at. The script therefore decodes, then resolves
the decoded prefix against the existing correct rows, and refuses to touch
anything that does not resolve to exactly one twin.

The full set is derived from the log, not hardcoded: any value matching
MANGLE_RE is suspect, and a suspect value that FRAGMENTS cannot fully decode is
reported and left alone rather than passed over silently. That matters -- the
first pass at this corruption was written from three observed substitutions and
missed a fourth.

Dead pattern, so this is a one-off and needs no scripts/aliases.py entry: the
last mangled play is 2025-09-08 and the feed has been clean for the ~12 months
since. Repaired rows also get their artwork relinked -- they had none, because
the mangled names never matched anything in MusicBrainz.

Idempotent -- rerunning finds nothing to do.
"""
import argparse
import re
import shutil
from datetime import datetime
from pathlib import Path

import duckdb

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "radio_plays.duckdb"

# Mangled run -> the character it stands for. Applied longest-first, because
# the bullet's encoding has the apostrophe's as a prefix.
FRAGMENTS = {
    "%5)%/0%1)": "•",  # bullet          (half-bullet-alive)
    "%5)%/0": "’",     # right single quote
    "%3*%0/": "Ø",     # O with stroke   (MO)
}

# A value is suspect if it matches this. Every fragment above does; a real '%'
# in a title ('100% Pure Love') does not, because it is followed by a space or
# a letter rather than a digit or punctuation. Kept deliberately wider than
# FRAGMENTS so an unknown fourth mangling shows up as an error, not a silence.
MANGLE_RE = r"%[0-9/][0-9)*/]"

TEXT_COLUMNS = {"plays": ("artist", "song"), "artwork_misses": ("artist", "song")}


def decoded(value: str) -> str:
    for bad, good in FRAGMENTS.items():
        value = value.replace(bad, good)
    return value


def resolve(con, artist: str, song: str) -> tuple[str, str]:
    """Map one mangled (artist, song) onto the correct pair already in `plays`.

    Returns the canonical pair, or raises if the decoded prefix does not pick
    out exactly one existing song -- better to leave a row mangled than to
    invent a title for it.
    """
    for value in (artist, song):
        if re.search(MANGLE_RE, decoded(value)):
            raise LookupError(f"no rule decodes {value!r} -- unknown mangling")

    artist, prefix = decoded(artist), decoded(song)
    # The feed truncated at the mangled character, so the decoded song is a
    # prefix of the real title, not the title. starts_with, not LIKE: a title
    # may legitimately contain '%' or '_'.
    candidates = con.execute(
        f"""SELECT song, count(*) FROM plays
            WHERE artist = ? AND starts_with(song, ?)
              AND NOT regexp_matches(song, '{MANGLE_RE}')
            GROUP BY 1 ORDER BY 2 DESC""",
        [artist, prefix],
    ).fetchall()
    if len(candidates) != 1:
        raise LookupError(
            f"{prefix!r} by {artist!r} matches {len(candidates)} existing songs "
            f"({[c[0] for c in candidates]}) -- need exactly 1"
        )
    return artist, candidates[0][0]


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--db", type=Path, default=DB_PATH)
    ap.add_argument("--apply", action="store_true",
                    help="write the changes (default is a dry run)")
    ap.add_argument("--no-backup", action="store_true",
                    help="skip the timestamped copy taken before writing")
    args = ap.parse_args()

    con = duckdb.connect(str(args.db), read_only=True)

    # Resolve everything before writing anything, so a dry run shows exactly
    # what a real run would do and an unresolvable row stops the whole repair
    # rather than leaving the log half folded.
    plan, total, failures = [], 0, []
    for table, columns in TEXT_COLUMNS.items():
        where = " OR ".join(f"regexp_matches({c}, '{MANGLE_RE}')" for c in columns)
        for artist, song in con.execute(
            f"SELECT DISTINCT artist, song FROM {table} WHERE {where}"
        ).fetchall():
            try:
                canon = resolve(con, artist, song)
            except LookupError as exc:
                failures.append(f"  !! {table}: ({artist!r}, {song!r}): {exc}")
                continue
            n = con.execute(
                f"SELECT count(*) FROM {table} WHERE artist = ? AND song = ?",
                [artist, song],
            ).fetchone()[0]
            plan.append((table, artist, song, *canon, n))
            total += n

    for line in failures:
        print(line)
    for table, artist, song, ca, cs, n in sorted(plan, key=lambda r: -r[5]):
        print(f"  {table}: ({artist!r}, {song!r})\n"
              f"      -> ({ca!r}, {cs!r})  ({n} rows)")

    if failures:
        raise SystemExit(
            f"\n{len(failures)} value(s) could not be resolved. Nothing written -- "
            "add the missing fragment to FRAGMENTS, or check the twin exists."
        )
    if not plan:
        print("Nothing mangled.")
        return
    if not args.apply:
        print(f"\nWould repair {total} row(s).\nDry run -- rerun with --apply to write.")
        return

    con.close()
    if not args.no_backup:
        stamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        backup = args.db.with_name(f"{args.db.stem}_backup_pre_pct_{stamp}.duckdb")
        shutil.copy2(args.db, backup)
        print(f"Backup: {backup.name}")
    con = duckdb.connect(str(args.db))

    con.execute("BEGIN")
    for table, artist, song, ca, cs, _ in plan:
        # One targeted statement per pair rather than a CASE over the table:
        # DuckDB rewrites every row group an UPDATE touches and never returns
        # the space (see fix_aliases.py).
        con.execute(
            f"UPDATE {table} SET artist = ?, song = ? WHERE artist = ? AND song = ?",
            [ca, cs, artist, song],
        )

    # The repaired plays carry no artwork; adopt what the correctly spelled
    # copies of the same track already resolved to.
    missing = "SELECT count(*) FROM plays WHERE artwork_file IS NULL"
    before = con.execute(missing).fetchone()[0]
    con.execute("""
        WITH art AS (
            SELECT artist, song,
                   any_value(artwork_url) AS url, any_value(artwork_file) AS file
            FROM plays WHERE artwork_file IS NOT NULL GROUP BY 1, 2
        )
        UPDATE plays p SET artwork_url = art.url, artwork_file = art.file
        FROM art
        WHERE p.artwork_file IS NULL
          AND p.artist = art.artist AND p.song = art.song
    """)
    relinked = before - con.execute(missing).fetchone()[0]

    # Folding can leave two identical miss rows, and a miss recorded under a
    # mangled name is moot once the canonical track has artwork.
    misses = "SELECT count(*) FROM artwork_misses"
    before = con.execute(misses).fetchone()[0]
    con.execute("""
        CREATE OR REPLACE TEMP TABLE kept AS
        SELECT artist, song, any_value(reason) AS reason, max(checked_at) AS checked_at
        FROM artwork_misses GROUP BY artist, song
    """)
    con.execute("DELETE FROM artwork_misses")
    con.execute("""
        INSERT INTO artwork_misses
        SELECT * FROM kept k
        WHERE NOT EXISTS (
            SELECT 1 FROM plays p
            WHERE p.artist = k.artist AND p.song = k.song
              AND p.artwork_file IS NOT NULL
        )
    """)
    con.execute("COMMIT")
    after = con.execute(misses).fetchone()[0]

    print(f"\nRepaired {total} row(s); relinked artwork for {relinked}; "
          f"artwork_misses {before} -> {after}.")


if __name__ == "__main__":
    main()

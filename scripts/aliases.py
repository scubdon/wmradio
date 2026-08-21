"""Canonical artist and song names for the play log.

The metadata feed renames things over time. 'almost monday' became
'Almost Monday' on 2024-06-28, tobyMac was recapitalised between the 2024 and
2025 holiday runs, and R.E.M. turned into 'REM' on 2026-07-27. Every query that
groups by the raw string then counts one act as two, so R.E.M. showed 181 plays
under one name and 17 under the other.

Both the one-off repair (fix_aliases.py) and the daily ingest
(update_duckdb.py) apply this map, which matters because some of these renames
are live: the feed is still emitting 'REM', so a repair that only touched
existing rows would come apart again within days.

When the feed renames something new, add a line here -- fix_aliases.py folds in
whatever already landed under the old name, and the ingest keeps it folded.
"""

# Old spelling -> the name to keep. The kept name is the one the log has used
# for the most plays, except where the feed's newer form is also the correct
# title (see SONG_ALIASES).
ARTIST_ALIASES = {
    "almost monday": "Almost Monday",  # feed switched 2024-06-28
    "tobyMac": "TobyMac",              # feed switched between the 2024 and 2025 holidays
    "REM": "R.E.M.",                   # feed switched 2026-07-27 and is still emitting it
}

# Keyed on the *canonical* artist, so ARTIST_ALIASES resolves first. Here the
# feed's newer spelling is the correct one, so the larger pile of older plays
# is what gets rewritten.
SONG_ALIASES = {
    ("KC & The Sunshine Band", "Keep It Comin Love"): "Keep It Comin' Love",
    ("Rascal Flatts", "I Dare You (Feat. Jonas Brothers)"): "I Dare You (feat. Jonas Brothers)",
    ("Tommy Tutone", "867-5309 Jenny"): "867-5309 / Jenny",
}


def canonical(artist: str, song: str) -> tuple[str, str]:
    """Fold one (artist, song) pair to its canonical spelling."""
    artist = ARTIST_ALIASES.get(artist, artist)
    return artist, SONG_ALIASES.get((artist, song), song)


def _lit(value: str) -> str:
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def artist_case_sql(column: str = "artist") -> str:
    """SQL CASE folding `column` to the canonical artist name."""
    if not ARTIST_ALIASES:
        return column
    whens = " ".join(
        f"WHEN {_lit(old)} THEN {_lit(new)}" for old, new in ARTIST_ALIASES.items()
    )
    return f"CASE {column} {whens} ELSE {column} END"


def song_case_sql(artist_column: str = "artist", song_column: str = "song") -> str:
    """SQL CASE folding `song_column` to its canonical title.

    Expects `artist_column` to already hold the canonical artist name.
    """
    if not SONG_ALIASES:
        return song_column
    whens = " ".join(
        f"WHEN {artist_column} = {_lit(artist)} AND {song_column} = {_lit(old)} "
        f"THEN {_lit(new)}"
        for (artist, old), new in SONG_ALIASES.items()
    )
    return f"CASE {whens} ELSE {song_column} END"

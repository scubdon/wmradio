import functions_framework
import requests
import json
import re
import uuid
from datetime import datetime, timezone

from google.cloud import storage
from google.api_core.exceptions import NotFound

# Configuration
BUCKET_NAME = "wmradio-metadata"
LAST_METADATA_FILE_NAME = "last_metadata.txt"
PLAYS_PREFIX = "plays"  # one small JSON object per play: plays/date=YYYY-MM-DD/<ts>_<id>.json
METADATA_URL = "https://streams.radiomast.io/2ce0b08d-2fe6-42a1-b64a-9f0a682f5508/metadata"

# Module-level state survives across invocations on a warm instance, so most
# runs never need to read last_metadata.txt from GCS.
_storage_client = None
_last_metadata_cache = None


def _get_bucket():
    global _storage_client
    if _storage_client is None:
        _storage_client = storage.Client()
    return _storage_client.bucket(BUCKET_NAME)


@functions_framework.http
def check_radio_metadata(request):
    """
    Check radio metadata once. When the song has changed since the last run,
    write a single small JSON object for the play instead of rewriting a
    growing CSV. Downstream (the daily DB refresh) picks these objects up.
    """
    global _last_metadata_cache
    try:
        # 1. Fetch current metadata
        response = requests.get(METADATA_URL, timeout=10)
        response.raise_for_status()
        current = response.json().get("metadata", "")
        if not current:
            print("Empty metadata string; nothing to record.")
            return "Empty metadata; nothing to record.", 200

        bucket = _get_bucket()

        # 2. Last recorded metadata: warm-instance cache, GCS on cold start
        last = _last_metadata_cache
        if last is None:
            try:
                last = bucket.blob(LAST_METADATA_FILE_NAME).download_as_text()
            except NotFound:
                last = ""

        if current == last:
            _last_metadata_cache = current
            print(f"No change: '{current}'")
            return "No change.", 200

        # 3. New song: parse "Artist - Song". Require whitespace around the
        # hyphen so hyphenated artists (A-ha, Run-D.M.C.) don't get split.
        match = re.match(r"^(.*?)\s+-\s+(.*)$", current)
        if match:
            artist = match.group(1).strip()
            song = match.group(2).strip()
        else:
            artist = "Unknown Artist"
            song = current

        # Naive UTC isoformat, matching the historical CSV timestamp format
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        play = {
            "pick_id": str(uuid.uuid4()),
            "timestamp": now.isoformat(),
            "song": song,
            "artist": artist,
        }

        # 4. Write one small object per play. Timestamped names sort
        # chronologically; the date= prefix keeps daily listing cheap.
        object_name = (
            f"{PLAYS_PREFIX}/date={now:%Y-%m-%d}/"
            f"{now:%Y%m%dT%H%M%S}_{play['pick_id'][:8]}.json"
        )
        bucket.blob(object_name).upload_from_string(
            json.dumps(play), content_type="application/json"
        )

        # 5. Update last-metadata marker (after the play write, so a failure
        # here can only cause a duplicate record, never a lost one)
        bucket.blob(LAST_METADATA_FILE_NAME).upload_from_string(current)
        _last_metadata_cache = current

        print(f"Recorded new play: {artist} - {song} -> {object_name}")
        return f"Recorded: {current}", 200

    except requests.exceptions.RequestException as e:
        print(f"HTTP Request failed: {e}")
        return f"Error fetching metadata: {e}", 500
    except json.JSONDecodeError as e:
        print(f"JSON decoding failed: {e}")
        return f"Error decoding JSON: {e}", 500
    except Exception as e:
        print(f"An unexpected error occurred: {e}")
        return f"An unexpected error occurred: {e}", 500

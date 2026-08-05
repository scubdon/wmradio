import functions_framework
import requests
import json
import csv
import io
from datetime import datetime
from google.cloud import storage
import uuid
import re

# Configuration
BUCKET_NAME = "wmradio-metadata"  # Replace with your bucket name
CSV_FILE_NAME = "radio_plays.csv"
LAST_METADATA_FILE_NAME = "last_metadata.txt"
METADATA_URL = "https://streams.radiomast.io/2ce0b08d-2fe6-42a1-b64a-9f0a682f5508/metadata"

@functions_framework.http
def check_radio_metadata(request):
    """
    Cloud Function to check radio metadata, record changes to CSV,
    and store last metadata in Cloud Storage.
    """
    storage_client = storage.Client()
    bucket = storage_client.bucket(BUCKET_NAME)

    try:
        # 1. Fetch current metadata
        response = requests.get(METADATA_URL, timeout=10)
        response.raise_for_status()  # Raise an exception for bad status codes
        current_data = response.json()
        current_metadata_string = current_data.get("metadata", "")

        print(f"Current metadata fetched: '{current_metadata_string}'")

        # 2. Get last recorded metadata from Cloud Storage
        last_metadata_blob = bucket.blob(LAST_METADATA_FILE_NAME)
        last_metadata_string = ""
        if last_metadata_blob.exists():
            last_metadata_string = last_metadata_blob.download_as_text()
            print(f"Last recorded metadata: '{last_metadata_string}'")
        else:
            print("No last metadata file found. Creating one.")

        # 3. Compare and record if different
        if current_metadata_string and current_metadata_string != last_metadata_string:
            print("Metadata has changed. Recording new entry.")

            # Parse song and artist
            artist = "Unknown Artist"
            song = current_metadata_string

            # Attempt to parse "Artist - Song" format
            match = re.match(r"^(.*?)\s*-\s*(.*)$", current_metadata_string)
            if match:
                artist = match.group(1).strip()
                song = match.group(2).strip()
            else:
                # If no hyphen, assume the whole string is the song and artist is unknown
                artist = "Unknown Artist"
                song = current_metadata_string

            # Prepare new row data
            new_row = {
                "pick_id": str(uuid.uuid4()),
                "timestamp": datetime.now().isoformat(),
                "song": song,
                "artist": artist,
            }

            # Read existing CSV, append new row, and upload back
            csv_blob = bucket.blob(CSV_FILE_NAME)
            csv_data = []
            headers = ["pick_id", "timestamp", "song", "artist"]

            if csv_blob.exists():
                existing_csv_content = csv_blob.download_as_text()
                csv_file = io.StringIO(existing_csv_content)
                reader = csv.DictReader(csv_file)
                # Ensure headers are consistent, or add if missing
                if reader.fieldnames:
                    headers = reader.fieldnames
                for row in reader:
                    csv_data.append(row)
            else:
                print(f"CSV file '{CSV_FILE_NAME}' not found. Creating a new one.")

            csv_data.append(new_row)

            output = io.StringIO()
            writer = csv.DictWriter(output, fieldnames=headers)
            writer.writeheader()
            writer.writerows(csv_data)

            csv_blob.upload_from_string(output.getvalue(), content_type="text/csv")
            print(f"Appended new row to '{CSV_FILE_NAME}' in Cloud Storage.")

            # Update the last metadata file
            last_metadata_blob.upload_from_string(current_metadata_string)
            print(f"Updated '{LAST_METADATA_FILE_NAME}' with '{current_metadata_string}'.")
        else:
            print("Metadata is the same as last run or empty. No change recorded.")

        return "Cloud Function executed successfully.", 200

    except requests.exceptions.RequestException as e:
        print(f"HTTP Request failed: {e}")
        return f"Error fetching metadata: {e}", 500
    except json.JSONDecodeError as e:
        print(f"JSON decoding failed: {e}")
        return f"Error decoding JSON: {e}", 500
    except Exception as e:
        print(f"An unexpected error occurred: {e}")
        return f"An unexpected error occurred: {e}", 500
"""
Fetch and parse all Citibike/Lyft ride receipt emails directly via Gmail API.

Usage:
    python scraper/fetch_gmail.py

First run will open a browser for OAuth. Subsequent runs use cached token.
"""

import os
import sys
import json
import base64
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

# Add parent dir so we can import parse_receipt
sys.path.insert(0, os.path.dirname(__file__))
from parse_receipt import extract_rides_from_html

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
PROJECT_DIR = Path(__file__).parent.parent
DATA_DIR = PROJECT_DIR / "data"
CREDS_FILE = PROJECT_DIR / "credentials.json"
TOKEN_FILE = PROJECT_DIR / "token.json"
OUTPUT_FILE = DATA_DIR / "rides.json"


def get_gmail_service():
    """Authenticate and return Gmail API service."""
    creds = None
    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(str(CREDS_FILE), SCOPES)
            creds = flow.run_local_server(port=0)
        TOKEN_FILE.write_text(creds.to_json())

    return build("gmail", "v1", credentials=creds)


def search_messages(service, query):
    """Search Gmail and return all matching message IDs."""
    messages = []
    result = service.users().messages().list(userId="me", q=query, maxResults=500).execute()
    messages.extend(result.get("messages", []))

    while "nextPageToken" in result:
        result = (
            service.users()
            .messages()
            .list(userId="me", q=query, maxResults=500, pageToken=result["nextPageToken"])
            .execute()
        )
        messages.extend(result.get("messages", []))

    return messages


def get_message_html(service, msg_id):
    """Fetch a single message and extract its HTML body."""
    msg = service.users().messages().get(userId="me", id=msg_id, format="full").execute()

    headers = {h["name"]: h["value"] for h in msg["payload"].get("headers", [])}
    subject = headers.get("Subject", "")
    date = headers.get("Date", "")

    # Extract HTML body from MIME parts
    html = _extract_html(msg["payload"])
    return html, subject, date


def _extract_html(payload):
    """Recursively find the HTML body in a MIME message."""
    if payload.get("mimeType") == "text/html":
        data = payload["body"].get("data", "")
        return base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")

    for part in payload.get("parts", []):
        html = _extract_html(part)
        if html:
            return html
    return ""


def load_existing_rides():
    """Load already-scraped rides to avoid re-processing."""
    if OUTPUT_FILE.exists():
        with open(OUTPUT_FILE) as f:
            return json.load(f)
    return []


def save_rides(rides):
    """Save rides to JSON."""
    DATA_DIR.mkdir(exist_ok=True)
    with open(OUTPUT_FILE, "w") as f:
        json.dump(rides, f, indent=2)


def main():
    print("Authenticating with Gmail...")
    service = get_gmail_service()

    # Search for all receipt emails
    queries = [
        'from:no-reply@updates.citibikenyc.com subject:(Ride Receipt)',
        'from:no-reply@lyftmail.com subject:("Lyft Bike ride") after:2025/06/01',
        'from:no-reply@lyftmail.com subject:("Lyft Bike ride") before:2025/06/01',
        'from:no-reply@updates.citibikenyc.com subject:("receipt for rides")',
        'from:no-reply@lyftmail.com subject:("receipt for rides") after:2025/06/01',
        'from:no-reply@lyftmail.com subject:("receipt for rides") before:2025/06/01',
        'from:no-reply@updates.citibikenyc.com subject:("weekly receipt")',
    ]

    all_msg_ids = []
    for q in queries:
        print(f"Searching: {q}")
        results = search_messages(service, q)
        print(f"  Found {len(results)} messages")
        all_msg_ids.extend(results)

    # Deduplicate by message ID
    seen = set()
    unique_msgs = []
    for m in all_msg_ids:
        if m["id"] not in seen:
            seen.add(m["id"])
            unique_msgs.append(m)

    print(f"\nTotal unique messages: {len(unique_msgs)}")

    # Load existing rides and skip already-processed
    existing_rides = load_existing_rides()
    processed_ids = {r["message_id"] for r in existing_rides}
    to_process = [m for m in unique_msgs if m["id"] not in processed_ids]

    print(f"Already processed: {len(processed_ids)}")
    print(f"Remaining to fetch: {len(to_process)}")

    if not to_process:
        print("Nothing to do!")
        return

    # Process each message
    all_rides = list(existing_rides)
    failed = []

    for i, msg in enumerate(to_process):
        msg_id = msg["id"]
        try:
            html, subject, date = get_message_html(service, msg_id)
            if not html:
                print(f"  [{i+1}/{len(to_process)}] {msg_id}: no HTML body, skipping")
                failed.append({"id": msg_id, "error": "no HTML body"})
                continue

            rides = extract_rides_from_html(html, message_id=msg_id, subject=subject, date=date)
            all_rides.extend(rides)

            ride_info = rides[0] if rides else {}
            station = ride_info.get("start_station", "?")
            price = ride_info.get("total_charged", "?")
            print(f"  [{i+1}/{len(to_process)}] {station} → {ride_info.get('end_station', '?')} | {price}")

        except Exception as e:
            print(f"  [{i+1}/{len(to_process)}] {msg_id}: ERROR - {e}")
            failed.append({"id": msg_id, "error": str(e)})

        # Save every 50 rides as checkpoint
        if (i + 1) % 50 == 0:
            save_rides(all_rides)
            print(f"  -- checkpoint saved ({len(all_rides)} total rides) --")

    # Final save
    save_rides(all_rides)
    print(f"\nDone! {len(all_rides)} total rides saved to {OUTPUT_FILE}")
    if failed:
        print(f"{len(failed)} failed messages:")
        for f in failed:
            print(f"  {f['id']}: {f['error']}")


if __name__ == "__main__":
    main()

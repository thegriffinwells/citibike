"""
Batch scraping orchestrator for Citibike ride receipts.

This script is designed to be used with Claude Code's Gmail MCP tools.
It tracks which messages have been processed and which remain.

Usage:
    1. Run this script to see remaining message IDs to process
    2. Use Claude Code's Gmail MCP to read each message
    3. Parse with parse_receipt.py and append to data/rides.json
"""

import json
import os

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data')


def get_processed_ids():
    """Get set of already-processed message IDs."""
    rides_path = os.path.join(DATA_DIR, 'rides.json')
    if not os.path.exists(rides_path):
        return set()
    with open(rides_path) as f:
        rides = json.load(f)
    return {r['message_id'] for r in rides}


def get_all_message_ids():
    """Get all message IDs from the search results."""
    ids = []
    for fname in ['citibike_message_ids.json', 'lyft_message_ids.json']:
        path = os.path.join(DATA_DIR, fname)
        if os.path.exists(path):
            with open(path) as f:
                msgs = json.load(f)
            for m in msgs:
                # Each entry is [message_id, subject, date]
                # Skip daily digest receipts
                if 'receipt for rides' in m[1].lower():
                    continue
                ids.append({
                    'message_id': m[0],
                    'subject': m[1],
                    'date': m[2],
                    'source': 'citibike' if 'citibike' in fname else 'lyft'
                })
    return ids


def get_remaining():
    """Get message IDs that haven't been processed yet."""
    processed = get_processed_ids()
    all_msgs = get_all_message_ids()
    return [m for m in all_msgs if m['message_id'] not in processed]


def add_ride(ride_data):
    """Append a parsed ride to rides.json."""
    rides_path = os.path.join(DATA_DIR, 'rides.json')
    rides = []
    if os.path.exists(rides_path):
        with open(rides_path) as f:
            rides = json.load(f)

    # Dedup by message_id
    existing_ids = {r['message_id'] for r in rides}
    if ride_data['message_id'] not in existing_ids:
        rides.append(ride_data)

    with open(rides_path, 'w') as f:
        json.dump(rides, f, indent=2)


if __name__ == '__main__':
    processed = get_processed_ids()
    remaining = get_remaining()

    print(f"Processed: {len(processed)} rides")
    print(f"Remaining: {len(remaining)} messages")
    print(f"\nNext 10 to process:")
    for m in remaining[:10]:
        print(f"  [{m['source']}] {m['message_id']}: {m['subject']} ({m['date']})")

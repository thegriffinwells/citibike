"""
Parse Citibike/Lyft ride receipt HTML emails into structured ride data.

Handles 3 formats:
1. Individual ride receipts (Citi Bike branded or Lyft branded)
2. Group ride receipts
3. Daily digest receipts (limited data - no station/location info)
"""

import re
import json
from html.parser import HTMLParser
from urllib.parse import urlparse, parse_qs, unquote


def extract_rides_from_html(html: str, message_id: str = "", subject: str = "", date: str = "") -> list[dict]:
    """Extract ride data from a receipt email HTML body."""

    # Determine email type
    is_daily_digest = "DAILY RECEIPT" in html or "WEEKLY RECEIPT" in html or "Your bill for yesterday" in html or "recap of your day" in html or "receipt for rides" in subject.lower() or "weekly receipt" in subject.lower()
    is_group_ride = "Group ride" in subject or "Group ride" in html

    if is_daily_digest:
        return _parse_daily_digest(html, message_id, subject, date)
    else:
        return _parse_individual_receipt(html, message_id, subject, date, is_group_ride)


def _parse_individual_receipt(html: str, message_id: str, subject: str, date: str, is_group_ride: bool) -> list[dict]:
    """Parse an individual ride receipt (Citi Bike or Lyft branded)."""
    ride = {
        "message_id": message_id,
        "subject": subject,
        "email_date": date,
        "type": "group_ride" if is_group_ride else "individual",
        "source": _detect_source(html),
    }

    # Extract ride date/time from preheader or header
    ride_datetime = _extract_ride_datetime(html)
    if ride_datetime:
        ride["ride_date"] = ride_datetime["date"]
        ride["ride_time"] = ride_datetime["time"]

    # Extract stations and times from the trip section
    trip_info = _extract_trip_info(html)
    ride["start_station"] = trip_info.get("start_station", "")
    ride["end_station"] = trip_info.get("end_station", "")
    ride["start_time"] = trip_info.get("start_time", "")
    ride["end_time"] = trip_info.get("end_time", "")

    # Extract lat/lng and polyline from static map URL
    map_data = _extract_map_data(html)
    ride["origin_lat"] = map_data.get("origin_lat")
    ride["origin_lng"] = map_data.get("origin_lng")
    ride["dest_lat"] = map_data.get("dest_lat")
    ride["dest_lng"] = map_data.get("dest_lng")
    ride["polyline"] = map_data.get("polyline", "")

    # Extract bike number
    ride["bike_number"] = _extract_bike_number(html)

    # Extract cost breakdown
    ride["cost"] = _extract_cost_breakdown(html)

    # Extract total charged
    ride["total_charged"] = _extract_total_charged(html)

    # Extract receipt number
    ride["receipt_number"] = _extract_receipt_number(html)

    # Extract rider name for group rides
    if is_group_ride:
        ride["rider_name"] = _extract_rider_name(html, subject)

    return [ride]


def _parse_daily_digest(html: str, message_id: str, subject: str, date: str) -> list[dict]:
    """Parse a daily digest receipt. These have limited data (no stations/locations)."""
    rides = []

    # Find ride type icons (bike vs car) in order they appear
    ride_types = re.findall(r'dbr-icon-(\w+)\.png', html)

    # Find ride blocks: "DATE TIME" in td, price in nested table nearby
    ride_pattern = r'(\w+ \d{1,2}, \d{4}\s+\d{1,2}:\d{2}\s*[AP]M)\s*</td>.*?\$(\d+\.\d{2})\s*\n?\s*</td>'
    matches = re.findall(ride_pattern, html, re.DOTALL)

    # Find start/end time pairs from the detail section
    time_pattern = r'text-decoration: none;">(\d{1,2}:\d{2}\s*[AP]M)'
    times = re.findall(time_pattern, html)
    # Times come in pairs: [start1, end1, start2, end2, ...]
    time_pairs = list(zip(times[0::2], times[1::2]))

    for i, (ride_time_str, cost) in enumerate(matches):
        # Skip non-bike rides (car, scooter, etc.)
        if i < len(ride_types) and ride_types[i] != "bike":
            continue

        ride_time_str = re.sub(r'\s+', ' ', ride_time_str).strip()
        # Parse date and time
        dt_match = re.match(r'(\w+ \d{1,2}, \d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)', ride_time_str)

        ride = {
            "message_id": message_id,
            "subject": subject,
            "email_date": date,
            "type": "daily_digest",
            "source": _detect_source(html),
            "ride_date": dt_match.group(1) if dt_match else "",
            "ride_time": dt_match.group(2) if dt_match else "",
            "total_charged": f"${cost}",
            "start_time": time_pairs[i][0] if i < len(time_pairs) else "",
            "end_time": time_pairs[i][1] if i < len(time_pairs) else "",
            "start_station": "",
            "end_station": "",
            "origin_lat": None,
            "origin_lng": None,
            "dest_lat": None,
            "dest_lng": None,
            "polyline": "",
        }
        rides.append(ride)

    return rides


def _detect_source(html: str) -> str:
    """Detect if receipt is from Citi Bike or Lyft."""
    if "updates.citibikenyc.com" in html or "LyftCitibikePBL" in html:
        return "citibike"
    return "lyft"


def _extract_ride_datetime(html: str) -> dict | None:
    """Extract ride date and time from the header section."""
    # Pattern matches: MARCH 23, 2026 AT 11:22 PM
    # Handle the HTML spacing - date and time are in separate lines
    pattern = r'(\w+ \d{1,2}, \d{4})\s*\n?\s*AT\s*\n?\s*(\d{1,2}:\d{2} [AP]M)'
    match = re.search(pattern, html)
    if match:
        return {"date": match.group(1).strip(), "time": match.group(2).strip()}
    return None


def _extract_trip_info(html: str) -> dict:
    """Extract start/end stations and times from the trip section."""
    info = {}

    # The trip section has station names and times in a specific layout
    # Start station comes after the start marker image, end after the end marker

    # Look for station names - they appear as text content in specific td elements
    # near the Start/End labels

    # Pattern for start: "Start" label followed by time, with station name in adjacent td
    # We need to find the "Your Trip" or "[Name]'s Trip" section

    trip_section = html
    trip_match = re.search(r"(?:Your Trip|'s Trip)(.*?)(?:Question about charges|Receipt #)", html, re.DOTALL)
    if trip_match:
        trip_section = trip_match.group(1)

    # Extract stations - they're in td elements with specific styling
    # Station names appear between marker images and time cells
    station_pattern = r'font-size: 17px;[^"]*color: #0C0B31;[^"]*line-height: 20px;[^"]*font-weight: 400;["\s]*>\s*\n?\s*(.+?)\s*\n?\s*</td>'
    stations = re.findall(station_pattern, trip_section)

    if len(stations) >= 2:
        info["start_station"] = _clean_text(stations[0])
        info["end_station"] = _clean_text(stations[1])
    elif len(stations) == 1:
        info["start_station"] = _clean_text(stations[0])

    # Extract times
    time_pattern = r'<span style="font-weight: 400;">(Start|End)</span><br>\s*\n?\s*(\d{1,2}:\d{2} [ap]m)'
    times = re.findall(time_pattern, trip_section)
    for label, time_val in times:
        if label == "Start":
            info["start_time"] = time_val.strip()
        elif label == "End":
            info["end_time"] = time_val.strip()

    return info


def _extract_map_data(html: str) -> dict:
    """Extract lat/lng and polyline from the static map image URL."""
    data = {}

    # Find the static map URL
    map_pattern = r'(?:api\.lyft\.com/v1/staticmap/general|staticmap)[^"]*?origin_lat=([^&]+)&amp;origin_lng=([^&]+)&amp;dest_lat=([^&]+)&amp;dest_lng=([^&]+)&amp;polyline=([^&"]+)'
    match = re.search(map_pattern, html)

    if match:
        data["origin_lat"] = float(match.group(1))
        data["origin_lng"] = float(match.group(2))
        data["dest_lat"] = float(match.group(3))
        data["dest_lng"] = float(match.group(4))
        data["polyline"] = unquote(match.group(5))

    return data


def _extract_bike_number(html: str) -> str:
    """Extract bike number from the receipt."""
    # Bike number appears in a specific pill-shaped element
    # Pattern: 7-digit number like 243-5337 or 737-6569
    pattern = r'pill_background\.png[^>]*>[\s\S]*?(\d{3}-\d{4})'
    match = re.search(pattern, html)
    return match.group(1) if match else ""


def _extract_cost_breakdown(html: str) -> list[dict]:
    """Extract cost line items from the receipt."""
    items = []

    # Cost items appear in td pairs: description and amount
    # Look for the charge section before the total
    cost_pattern = r'font-weight: 400;["\s]*>\s*\n?\s*(.+?)(?:<br>.*?)?</(?:td|span)>\s*\n?\s*</td>\s*\n?\s*<td[^>]*align="right"[^>]*>\s*\n?\s*([-$\d.]+)\s*\n?\s*</td>'
    matches = re.findall(cost_pattern, html, re.DOTALL)

    for desc, amount in matches:
        desc = _clean_text(desc)
        # Filter out non-cost items (station names, times, etc.)
        if "$" in amount and desc and not any(skip in desc.lower() for skip in ["start", "end", "trip"]):
            items.append({"description": desc, "amount": amount.strip()})

    return items


def _extract_total_charged(html: str) -> str:
    """Extract total amount charged."""
    # Total appears in the payment method section with large font
    pattern = r'font-size: 30px;[^"]*color: #0C0B31;[^"]*line-height: 32px;["\s]*>\s*\n?\s*(\$[\d.]+)'
    match = re.search(pattern, html)
    return match.group(1).strip() if match else ""


def _extract_receipt_number(html: str) -> str:
    """Extract receipt number."""
    pattern = r'Receipt #\s*(\d+)'
    match = re.search(pattern, html)
    return match.group(1) if match else ""


def _extract_rider_name(html: str, subject: str) -> str:
    """Extract rider name from group ride receipts."""
    # From subject: "Griffin's Ride Receipt (Group ride)"
    name_match = re.match(r"(.+?)'s Ride Receipt", subject)
    if name_match:
        return name_match.group(1)

    # From HTML: "[Name]'s fare breakdown" or "[Name]'s Trip"
    html_match = re.search(r"(\w+)'s (?:fare breakdown|Trip)", html)
    if html_match:
        return html_match.group(1)

    return ""


def _strip_html(html: str) -> str:
    """Remove HTML tags from text."""
    return re.sub(r'<[^>]+>', ' ', html)


def _clean_text(text: str) -> str:
    """Clean extracted text: decode entities, strip whitespace."""
    text = text.replace("&amp;", "&")
    text = text.replace("&#39;", "'")
    text = text.replace("&quot;", '"')
    text = re.sub(r'<[^>]+>', '', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip()


# ---- Test / CLI ----
if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        with open(sys.argv[1]) as f:
            html = f.read()
        rides = extract_rides_from_html(html)
        print(json.dumps(rides, indent=2))

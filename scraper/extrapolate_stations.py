"""
Extrapolate station data for digest-only rides.

Strategy:
1. If a digest ride falls between two individual rides on the same day,
   assume it starts where the previous ride ended and ends where the next one started.
2. For rides with only a predecessor, assume round-trip (start = prev end, end = prev end).
3. For rides with only a successor, assume reverse (start = next start, end = next start).
4. For isolated rides (no same-day neighbors), use the rider's most frequent home station.
"""

import json
import os
from datetime import datetime
from collections import Counter

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data')
STATIONS_FILE = os.path.join(DATA_DIR, 'stations.json')


def parse_dt(ride):
    """Parse ride into a comparable datetime."""
    rd = ride.get('ride_date', '')
    rt = ride.get('start_time', '') or ride.get('ride_time', '')
    if not rd:
        return None
    try:
        if rt:
            return datetime.strptime(f'{rd} {rt}', '%B %d, %Y %I:%M %p')
        else:
            return datetime.strptime(rd, '%B %d, %Y')
    except ValueError:
        return None


def load_stations():
    """Load GBFS station data for coordinate lookup."""
    if not os.path.exists(STATIONS_FILE):
        return {}
    with open(STATIONS_FILE) as f:
        stations = json.load(f)
    return {s['name']: s for s in stations}


def main():
    rides_path = os.path.join(DATA_DIR, 'rides.json')
    with open(rides_path) as f:
        rides = json.load(f)

    stations = load_stations()

    # Separate individual and digest rides
    individuals = [r for r in rides if r.get('type') != 'daily_digest']
    digests = [r for r in rides if r.get('type') == 'daily_digest']

    print(f"Individual rides: {len(individuals)}")
    print(f"Digest rides to extrapolate: {len(digests)}")

    # Find most frequent stations (home stations)
    station_counts = Counter()
    for r in individuals:
        if r.get('start_station'):
            station_counts[r['start_station']] += 1
        if r.get('end_station'):
            station_counts[r['end_station']] += 1

    top_stations = station_counts.most_common(5)
    home_station = top_stations[0][0] if top_stations else None
    print(f"Home station: {home_station}")
    print(f"Top 5: {[s[0] for s in top_stations]}")

    # Build day -> sorted individual rides index
    day_rides = {}
    for r in individuals:
        dt = parse_dt(r)
        if not dt:
            continue
        day_key = dt.strftime('%Y-%m-%d')
        if day_key not in day_rides:
            day_rides[day_key] = []
        day_rides[day_key].append((dt, r))

    for key in day_rides:
        day_rides[key].sort(key=lambda x: x[0])

    # Extrapolate each digest ride
    extrapolated = 0
    chained = 0
    home_filled = 0

    for ride in digests:
        dt = parse_dt(ride)
        if not dt:
            continue

        day_key = dt.strftime('%Y-%m-%d')
        same_day = day_rides.get(day_key, [])

        # Find predecessor (latest individual ride before this one)
        pred = None
        succ = None
        for rdt, r in same_day:
            if rdt < dt:
                pred = r
            elif rdt > dt and succ is None:
                succ = r

        if pred and succ:
            # Sandwich: digest ride goes from pred's end to succ's start
            ride['start_station'] = pred.get('end_station', '')
            ride['end_station'] = succ.get('start_station', '')
            ride['origin_lat'] = pred.get('dest_lat')
            ride['origin_lng'] = pred.get('dest_lng')
            ride['dest_lat'] = succ.get('origin_lat')
            ride['dest_lng'] = succ.get('origin_lng')
            ride['extrapolated'] = 'chained'
            chained += 1
            extrapolated += 1
        elif pred:
            # Only predecessor: likely going home or to a frequent spot
            ride['start_station'] = pred.get('end_station', '')
            ride['origin_lat'] = pred.get('dest_lat')
            ride['origin_lng'] = pred.get('dest_lng')
            # End station: use home station
            if home_station and home_station != ride['start_station']:
                ride['end_station'] = home_station
                if home_station in stations:
                    ride['dest_lat'] = stations[home_station].get('lat')
                    ride['dest_lng'] = stations[home_station].get('lon')
            ride['extrapolated'] = 'pred_only'
            extrapolated += 1
            home_filled += 1
        elif succ:
            # Only successor: likely coming from home
            ride['end_station'] = succ.get('start_station', '')
            ride['dest_lat'] = succ.get('origin_lat')
            ride['dest_lng'] = succ.get('origin_lng')
            if home_station:
                ride['start_station'] = home_station
                if home_station in stations:
                    ride['origin_lat'] = stations[home_station].get('lat')
                    ride['origin_lng'] = stations[home_station].get('lon')
            ride['extrapolated'] = 'succ_only'
            extrapolated += 1
            home_filled += 1
        else:
            # No same-day neighbors: use home station as start, second most frequent as end
            if home_station:
                ride['start_station'] = home_station
                if home_station in stations:
                    ride['origin_lat'] = stations[home_station].get('lat')
                    ride['origin_lng'] = stations[home_station].get('lon')
            if len(top_stations) > 1:
                second = top_stations[1][0]
                ride['end_station'] = second
                if second in stations:
                    ride['dest_lat'] = stations[second].get('lat')
                    ride['dest_lng'] = stations[second].get('lon')
            ride['extrapolated'] = 'isolated'
            extrapolated += 1
            home_filled += 1

    print(f"\nExtrapolated: {extrapolated}/{len(digests)}")
    print(f"  Chained (sandwich): {chained}")
    print(f"  Home-filled: {home_filled}")

    # Count rides with coordinates now
    with_coords = sum(1 for r in rides if r.get('origin_lat') is not None)
    print(f"\nRides with coordinates: {with_coords}/{len(rides)}")

    # Save
    with open(rides_path, 'w') as f:
        json.dump(rides, f, indent=2)
    print(f"Saved to {rides_path}")


if __name__ == '__main__':
    main()

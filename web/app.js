// Citibike Ride Map - app.js

let map, rideData = [], routeLayers = [], activeFilters = new Set();
let allYears = new Set();

// Decode Google-encoded polyline
function decodePolyline(encoded) {
    if (!encoded || typeof polyline === 'undefined') return [];
    try {
        return polyline.decode(encoded);
    } catch (e) {
        console.warn('Failed to decode polyline:', e);
        return [];
    }
}

// Parse ride date string to Date object
function parseRideDate(dateStr) {
    const months = {
        'JANUARY': 0, 'FEBRUARY': 1, 'MARCH': 2, 'APRIL': 3, 'MAY': 4, 'JUNE': 5,
        'JULY': 6, 'AUGUST': 7, 'SEPTEMBER': 8, 'OCTOBER': 9, 'NOVEMBER': 10, 'DECEMBER': 11
    };
    const parts = dateStr.match(/(\w+)\s+(\d+),\s+(\d+)/);
    if (!parts) return new Date();
    return new Date(parseInt(parts[3]), months[parts[1].toUpperCase()] || 0, parseInt(parts[2]));
}

// Color palette for routes based on time of day
function getRouteColor(timeStr) {
    if (!timeStr) return '#3b82f6';
    const hour = parseInt(timeStr);
    const isPM = timeStr.toLowerCase().includes('pm');
    let h = isPM && hour !== 12 ? hour + 12 : hour;
    if (!isPM && hour === 12) h = 0;

    if (h >= 6 && h < 10) return '#f59e0b';   // morning - amber
    if (h >= 10 && h < 14) return '#22c55e';   // midday - green
    if (h >= 14 && h < 18) return '#3b82f6';   // afternoon - blue
    if (h >= 18 && h < 22) return '#8b5cf6';   // evening - purple
    return '#ef4444';                           // night - red
}

// Initialize map
function initMap() {
    map = L.map('map', {
        zoomControl: false,
    }).setView([40.695, -73.955], 13);

    L.control.zoom({ position: 'topright' }).addTo(map);

    // Dark tile layer
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);
}

// Load ride data
async function loadRides() {
    try {
        const resp = await fetch('./data/rides.json');
        rideData = await resp.json();
    } catch (e) {
        // Fallback: try inline data
        console.warn('Could not load rides.json, using embedded data');
        rideData = window.RIDE_DATA || [];
    }

    // Sort by date descending
    rideData.sort((a, b) => {
        const da = parseRideDate(a.ride_date);
        const db = parseRideDate(b.ride_date);
        return db - da;
    });

    // Collect years
    rideData.forEach(r => {
        const d = parseRideDate(r.ride_date);
        allYears.add(d.getFullYear());
    });

    renderStats();
    renderYearFilters();
    renderRides();
    plotRides();
    fitBounds();
}

// Render stats
function renderStats() {
    const filtered = getFilteredRides();
    const stations = new Set();
    filtered.forEach(r => {
        if (r.start_station) stations.add(r.start_station);
        if (r.end_station) stations.add(r.end_station);
    });

    document.getElementById('stats').innerHTML = `
        <div class="stat">
            <div class="stat-value">${filtered.length}</div>
            <div class="stat-label">Total Rides</div>
        </div>
        <div class="stat">
            <div class="stat-value">${stations.size}</div>
            <div class="stat-label">Unique Stations</div>
        </div>
        <div class="stat">
            <div class="stat-value">${allYears.size}</div>
            <div class="stat-label">Years Riding</div>
        </div>
        <div class="stat">
            <div class="stat-value">${filtered.filter(r => r.type === 'group_ride').length}</div>
            <div class="stat-label">Group Rides</div>
        </div>
    `;
}

// Render year filter buttons
function renderYearFilters() {
    const container = document.getElementById('year-filters');
    const years = [...allYears].sort((a, b) => b - a);
    container.innerHTML = `
        <span class="filter-btn active" onclick="filterYear(null)">All</span>
        ${years.map(y => `<span class="filter-btn" onclick="filterYear(${y})">${y}</span>`).join('')}
    `;
}

// Filter by year
function filterYear(year) {
    activeFilters.clear();
    if (year) activeFilters.add(year);

    // Update button states
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.remove('active');
        if ((!year && btn.textContent === 'All') || btn.textContent == year) {
            btn.classList.add('active');
        }
    });

    renderStats();
    renderRides();
    clearRoutes();
    plotRides();
    fitBounds();
}

function getFilteredRides() {
    if (activeFilters.size === 0) return rideData;
    return rideData.filter(r => {
        const d = parseRideDate(r.ride_date);
        return activeFilters.has(d.getFullYear());
    });
}

// Render ride list
function renderRides() {
    const container = document.getElementById('ride-list');
    const rides = getFilteredRides();

    container.innerHTML = rides.map((r, i) => `
        <div class="ride-item" data-index="${i}" onclick="focusRide(${rideData.indexOf(r)})">
            <div class="ride-date">${r.ride_date} at ${r.ride_time}${r.type === 'group_ride' ? ' (Group)' : ''}</div>
            <div class="ride-stations">
                ${r.start_station}<span class="arrow">&rarr;</span>${r.end_station}
            </div>
            <div class="ride-bike">Bike #${r.bike_number}</div>
        </div>
    `).join('');
}

// Clear route layers
function clearRoutes() {
    routeLayers.forEach(l => map.removeLayer(l));
    routeLayers = [];
}

// Plot all rides on map
function plotRides() {
    const rides = getFilteredRides();

    rides.forEach((ride, idx) => {
        if (!ride.origin_lat || !ride.dest_lat) return;

        const color = getRouteColor(ride.ride_time);

        // Draw route polyline
        if (ride.polyline) {
            const decoded = decodePolyline(ride.polyline);
            if (decoded.length > 0) {
                const routeLine = L.polyline(decoded, {
                    color: color,
                    weight: 3,
                    opacity: 0.6,
                    smoothFactor: 1
                }).addTo(map);
                routeLine.on('click', () => focusRide(rideData.indexOf(ride)));
                routeLayers.push(routeLine);
            }
        }

        // Start marker
        const startIcon = L.divIcon({ className: 'start-marker', iconSize: [12, 12] });
        const startMarker = L.marker([ride.origin_lat, ride.origin_lng], { icon: startIcon })
            .bindPopup(`
                <strong>${ride.start_station}</strong><br>
                Start: ${ride.start_time}<br>
                ${ride.ride_date}
            `)
            .addTo(map);
        routeLayers.push(startMarker);

        // End marker
        const endIcon = L.divIcon({ className: 'end-marker', iconSize: [12, 12] });
        const endMarker = L.marker([ride.dest_lat, ride.dest_lng], { icon: endIcon })
            .bindPopup(`
                <strong>${ride.end_station}</strong><br>
                End: ${ride.end_time}<br>
                ${ride.ride_date}
            `)
            .addTo(map);
        routeLayers.push(endMarker);
    });
}

// Fit map to all visible rides
function fitBounds() {
    const rides = getFilteredRides();
    const points = [];
    rides.forEach(r => {
        if (r.origin_lat) points.push([r.origin_lat, r.origin_lng]);
        if (r.dest_lat) points.push([r.dest_lat, r.dest_lng]);
    });
    if (points.length > 0) {
        map.fitBounds(L.latLngBounds(points).pad(0.1));
    }
}

// Focus on a specific ride
function focusRide(globalIdx) {
    const ride = rideData[globalIdx];
    if (!ride || !ride.origin_lat) return;

    // Highlight in list
    document.querySelectorAll('.ride-item').forEach(el => el.classList.remove('active'));
    const el = document.querySelector(`[data-index="${getFilteredRides().indexOf(ride)}"]`);
    if (el) {
        el.classList.add('active');
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // Zoom to ride
    const bounds = L.latLngBounds(
        [ride.origin_lat, ride.origin_lng],
        [ride.dest_lat, ride.dest_lng]
    );
    map.fitBounds(bounds.pad(0.3));
}

// Toggle sidebar
function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('collapsed');
}

// Share map
function shareMap() {
    if (navigator.share) {
        navigator.share({
            title: "Griffin's Citibike Rides",
            text: `Check out my ${rideData.length} Citibike rides across NYC!`,
            url: window.location.href
        });
    } else {
        navigator.clipboard.writeText(window.location.href);
        const btn = document.querySelector('.share-btn');
        btn.textContent = 'Link copied!';
        setTimeout(() => btn.textContent = 'Share This Map', 2000);
    }
}

// Boot
initMap();
loadRides();

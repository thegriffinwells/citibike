// Citibike Ride Map — deck.gl + MapLibre GL

// ═══════════════ Configuration ═══════════════
const CONFIG = {
    GRID_CELL: 0.001,         // ~100m density grid cells
    LOOP_LENGTH: 80,          // pulse animation loop (seconds)
    TRAIL_LENGTH: 1.5,        // pulse trail length (seconds)
    MIN_POLYLINE_LEN: 50,     // skip polylines shorter than this
    VIRTUAL_ITEM_H: 56,
    VIRTUAL_BUFFER: 10,
};

const THERMAL_STOPS = [
    [0.00,  50,   8,   0],   // very dark ember
    [0.25, 140,  25,   0],   // deep red
    [0.45, 200,  35,  10],   // red
    [0.60, 230,  35,  60],   // red-pink
    [0.75, 245,  45, 140],   // magenta/pink
    [0.88, 255, 140,  50],   // orange
    [1.00, 255, 220, 120],   // warm yellow
];

const MONTH_MAP = {
    JANUARY: 0, FEBRUARY: 1, MARCH: 2, APRIL: 3, MAY: 4, JUNE: 5,
    JULY: 6, AUGUST: 7, SEPTEMBER: 8, OCTOBER: 9, NOVEMBER: 10, DECEMBER: 11
};
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ═══════════════ State ═══════════════
let map, deckOverlay;
let rideData = [];
let pathData = [], tripsData = [], focusMarkerData = [], stationData = [];
let allYears = new Set(), activeYear = null;
let animating = true, animFrameId = null, userPaused = false;
let virtualList = null;
let focusedRideIdx = -1;
let deckClickHandled = false;

// ═══════════════ Date Parsing ═══════════════
function parseRideDate(dateStr) {
    if (!dateStr) return new Date(0);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const [y, m, d] = dateStr.split('-').map(Number);
        return new Date(y, m - 1, d);
    }
    const parts = dateStr.match(/(\w+)\s+(\d+),?\s+(\d{4})/);
    if (parts) {
        return new Date(
            parseInt(parts[3]),
            MONTH_MAP[parts[1].toUpperCase()] ?? 0,
            parseInt(parts[2])
        );
    }
    return new Date(0);
}

function formatDate(dateStr) {
    const d = parseRideDate(dateStr);
    if (d.getTime() === 0) return dateStr;
    return `${MONTH_ABBR[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// ═══════════════ Polyline ═══════════════
function decodePolylineStr(encoded) {
    if (!encoded || typeof polyline === 'undefined') return [];
    try { return polyline.decode(encoded); }
    catch { return []; }
}

function getDecodedPolyline(ride) {
    if (!ride._decoded) ride._decoded = decodePolylineStr(ride.polyline);
    return ride._decoded;
}

// ═══════════════ Density Grid ═══════════════
function buildDensityGrid(rides) {
    const CELL = CONFIG.GRID_CELL;
    const grid = new Map();
    let max = 0;

    for (const ride of rides) {
        const pts = getDecodedPolyline(ride);
        if (!pts || pts.length < 2) continue;

        const visited = new Set();
        for (let i = 0; i < pts.length - 1; i++) {
            const [lat1, lng1] = pts[i];
            const [lat2, lng2] = pts[i + 1];
            const dist = Math.sqrt((lat2 - lat1) ** 2 + (lng2 - lng1) ** 2);
            const steps = Math.max(1, Math.ceil(dist / (CELL * 0.5)));

            for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                const key = `${Math.floor((lat1 + t * (lat2 - lat1)) / CELL)},${Math.floor((lng1 + t * (lng2 - lng1)) / CELL)}`;
                if (!visited.has(key)) {
                    visited.add(key);
                    const count = (grid.get(key) || 0) + 1;
                    grid.set(key, count);
                    if (count > max) max = count;
                }
            }
        }
    }
    return { grid, max };
}

function rideHeatScore(ride, grid) {
    const CELL = CONFIG.GRID_CELL;
    const pts = getDecodedPolyline(ride);
    if (!pts || pts.length < 2) return 1;

    let best = 0;
    for (const [lat, lng] of pts) {
        const score = grid.get(`${Math.floor(lat / CELL)},${Math.floor(lng / CELL)}`) || 0;
        if (score > best) best = score;
    }
    return best || 1;
}

// ═══════════════ Thermal Colors ═══════════════
function thermalRGBA(t, alpha) {
    t = Math.max(0, Math.min(1, t));
    let i = 0;
    while (i < THERMAL_STOPS.length - 1 && THERMAL_STOPS[i + 1][0] < t) i++;
    if (i >= THERMAL_STOPS.length - 1) {
        const s = THERMAL_STOPS[THERMAL_STOPS.length - 1];
        return [s[1], s[2], s[3], alpha];
    }
    const [t0, r0, g0, b0] = THERMAL_STOPS[i];
    const [t1, r1, g1, b1] = THERMAL_STOPS[i + 1];
    const f = (t - t0) / (t1 - t0);
    return [
        Math.round(r0 + f * (r1 - r0)),
        Math.round(g0 + f * (g1 - g0)),
        Math.round(b0 + f * (b1 - b0)),
        alpha,
    ];
}

function thermalColor(t) {
    const [r, g, b] = thermalRGBA(t, 255);
    return `rgb(${r},${g},${b})`;
}

function rideStyle(score, maxScore) {
    const t = maxScore > 1 ? Math.pow(score / maxScore, 0.35) : 0;
    const opacity = 0.10 + t * 0.25;
    return {
        color: thermalColor(t),
        colorRGBA: thermalRGBA(t, Math.round(opacity * 255)),
        pulseRGBA: thermalRGBA(t, 255),
        weight: 0.5 + t * 0.8,
        opacity,
        t,
    };
}

// ═══════════════ Data Preparation ═══════════════
function prepareLayerData(rides) {
    const sorted = [...rides].sort((a, b) => (a._heatScore || 0) - (b._heatScore || 0));

    pathData = [];
    tripsData = [];

    for (let i = 0; i < sorted.length; i++) {
        const ride = sorted[i];
        if (!ride.origin_lat || !ride.dest_lat) continue;
        if (!ride.polyline || ride.polyline.length < CONFIG.MIN_POLYLINE_LEN) continue;
        const pts = getDecodedPolyline(ride);
        if (!pts || pts.length < 4) continue;

        const style = ride._style;
        const path = pts.map(p => [p[1], p[0]]); // deck.gl uses [lng, lat]
        const globalIdx = rideData.indexOf(ride);

        pathData.push({
            path,
            color: style.colorRGBA,
            focusColor: [...style.colorRGBA.slice(0, 3), 255],
            dimColor: [...style.colorRGBA.slice(0, 3), 15],
            width: style.weight,
            rideIdx: globalIdx,
        });

        // Trips layer: synthesize timestamps from cumulative distance
        let totalDist = 0;
        const dists = [0];
        for (let j = 1; j < pts.length; j++) {
            const dlat = pts[j][0] - pts[j - 1][0];
            const dlng = pts[j][1] - pts[j - 1][1];
            totalDist += Math.sqrt(dlat * dlat + dlng * dlng);
            dists.push(totalDist);
        }

        const phase = (i * 7.31) % (CONFIG.LOOP_LENGTH - 7);
        const speed = 4 + (i % 5) * 0.6;
        const timestamps = totalDist > 0
            ? dists.map(d => phase + (d / totalDist) * speed)
            : dists.map(() => phase);

        tripsData.push({
            path,
            timestamps,
            color: style.pulseRGBA,
        });
    }
}

// ═══════════════ Station Dots ═══════════════
function prepareStationData(rides) {
    const map = new Map();
    for (const r of rides) {
        if (r.origin_lat && r.start_station) {
            const k = `${r.origin_lat.toFixed(5)},${r.origin_lng.toFixed(5)}`;
            if (!map.has(k)) map.set(k, { position: [r.origin_lng, r.origin_lat], count: 0 });
            map.get(k).count++;
        }
        if (r.dest_lat && r.end_station) {
            const k = `${r.dest_lat.toFixed(5)},${r.dest_lng.toFixed(5)}`;
            if (!map.has(k)) map.set(k, { position: [r.dest_lng, r.dest_lat], count: 0 });
            map.get(k).count++;
        }
    }
    stationData = [...map.values()];
}

// ═══════════════ Constants ═══════════════
const NYC_BOUNDS = [[-74.35, 40.45], [-73.65, 40.95]];
const IS_MOBILE = () => window.innerWidth <= 768;

// ═══════════════ Map + deck.gl Setup ═══════════════
function initMap() {
    map = new maplibregl.Map({
        container: 'map',
        style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
        center: [-73.955, 40.695],
        zoom: 13,
        attributionControl: false,
        maxPitch: 0,
        dragRotate: false,
        touchPitch: false,
        maxBounds: NYC_BOUNDS,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }));

    deckOverlay = new deck.MapboxOverlay({ layers: [] });
    map.addControl(deckOverlay);

    map.on('click', () => {
        if (deckClickHandled) {
            deckClickHandled = false;
            return;
        }
        if (focusedRideIdx >= 0) unfocusRide();
        if (IS_MOBILE()) document.getElementById('sidebar').classList.remove('expanded');
    });
}

// ═══════════════ Layer Updates ═══════════════
function updateLayers() {
    const layers = [];

    layers.push(new deck.PathLayer({
        id: 'routes',
        data: pathData,
        getPath: d => d.path,
        getColor: d => {
            if (focusedRideIdx < 0) return d.color;
            return d.rideIdx === focusedRideIdx ? d.focusColor : d.dimColor;
        },
        getWidth: d => {
            if (focusedRideIdx < 0) return d.width;
            return d.rideIdx === focusedRideIdx ? 5 : 0.5;
        },
        widthUnits: 'pixels',
        widthMinPixels: 1,
        capRounded: true,
        jointRounded: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 40],
        onClick: (info) => {
            if (info.object) {
                deckClickHandled = true;
                focusRide(info.object.rideIdx);
                return true;
            }
        },
        updateTriggers: {
            getColor: focusedRideIdx,
            getWidth: focusedRideIdx,
        },
    }));

    if (focusedRideIdx < 0 && animating) {
        layers.push(new deck.TripsLayer({
            id: 'pulses',
            data: tripsData,
            getPath: d => d.path,
            getTimestamps: d => d.timestamps,
            getColor: d => d.color,
            widthMinPixels: 3,
            capRounded: true,
            jointRounded: true,
            trailLength: CONFIG.TRAIL_LENGTH,
            currentTime: (performance.now() / 1000) % CONFIG.LOOP_LENGTH,
        }));
    }

    if (focusedRideIdx >= 0 && focusMarkerData.length) {
        layers.push(new deck.ScatterplotLayer({
            id: 'focus-markers',
            data: focusMarkerData,
            getPosition: d => d.position,
            getFillColor: d => d.color,
            getRadius: 7,
            radiusUnits: 'pixels',
            stroked: true,
            getLineColor: [255, 255, 255],
            getLineWidth: 2,
            lineWidthUnits: 'pixels',
        }));
    }

    deckOverlay.setProps({ layers });
}

// ═══════════════ Data Loading ═══════════════
function fetchRideData() {
    return fetch('./data/rides.json')
        .then(r => r.json())
        .catch(() => window.RIDE_DATA || []);
}

// ═══════════════ Process & Render Pipeline ═══════════════
function processAndRender() {
    rideData.sort((a, b) => parseRideDate(b.ride_date) - parseRideDate(a.ride_date));

    rideData.forEach(r => {
        const y = parseRideDate(r.ride_date).getFullYear();
        if (y > 2000) allYears.add(y);
    });

    recomputeAndDraw();
}

function recomputeAndDraw() {
    const filtered = getFilteredRides();
    const { grid, max } = buildDensityGrid(filtered);

    filtered.forEach(r => {
        r._heatScore = rideHeatScore(r, grid);
        r._style = rideStyle(r._heatScore, max);
    });

    prepareLayerData(filtered);
    prepareStationData(filtered);
    renderStats();
    renderYearFilters();
    renderRideList();
    updateLayers();
    fitBounds();
}

// ═══════════════ Filtering ═══════════════
function getFilteredRides() {
    if (!activeYear) return rideData;
    return rideData.filter(r => parseRideDate(r.ride_date).getFullYear() === activeYear);
}

function filterYear(year) {
    activeYear = year;
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active',
            (!year && btn.dataset.year === 'all') ||
            btn.dataset.year === String(year)
        );
    });
    unfocusRide();
    recomputeAndDraw();
}

// ═══════════════ Focus / Unfocus ═══════════════
function focusRide(globalIdx) {
    const ride = rideData[globalIdx];
    if (!ride || !ride.origin_lat) return;

    // Validate coordinates are in NYC area — skip bad data
    const inNYC = (lat, lng) => lat > 40.45 && lat < 40.95 && lng > -74.35 && lng < -73.65;
    if (!inNYC(ride.origin_lat, ride.origin_lng) || !inNYC(ride.dest_lat, ride.dest_lng)) return;

    focusedRideIdx = globalIdx;

    focusMarkerData = [
        { position: [ride.origin_lng, ride.origin_lat], color: [34, 197, 94, 230] },
        { position: [ride.dest_lng, ride.dest_lat], color: [239, 68, 68, 230] },
    ];

    updateLayers();

    const padding = IS_MOBILE()
        ? { top: 40, bottom: 160, left: 20, right: 20 }
        : 80;
    const bounds = new maplibregl.LngLatBounds(
        [ride.origin_lng, ride.origin_lat],
        [ride.dest_lng, ride.dest_lat]
    );
    map.fitBounds(bounds, { padding, duration: 600, maxZoom: 16 });

    const filtered = getFilteredRides();
    const filteredIdx = filtered.indexOf(ride);
    if (virtualList && filteredIdx >= 0) {
        virtualList.scrollTo(filteredIdx);
        virtualList.setActive(filteredIdx);
    }

    if (IS_MOBILE()) document.getElementById('sidebar').classList.remove('expanded');
}

function unfocusRide() {
    if (focusedRideIdx < 0) return;
    focusedRideIdx = -1;
    focusMarkerData = [];
    updateLayers();
    if (virtualList) virtualList.setActive(-1);
}

// ═══════════════ Animation ═══════════════
function startAnimation() {
    animating = true;
    if (!animFrameId) animate();
}

function stopAnimation() {
    animating = false;
    if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }
}

function animate() {
    if (!animating) { animFrameId = null; return; }
    updateLayers();
    animFrameId = requestAnimationFrame(animate);
}

const PAUSE_ICON = '<svg width="10" height="12" viewBox="0 0 10 12"><rect x="0" y="0" width="3" height="12" fill="currentColor"/><rect x="7" y="0" width="3" height="12" fill="currentColor"/></svg>';
const PLAY_ICON = '<svg width="10" height="12" viewBox="0 0 10 12"><polygon points="0,0 10,6 0,12" fill="currentColor"/></svg>';

function toggleAnimation() {
    const btn = document.getElementById('anim-toggle');
    if (animating) {
        stopAnimation();
        userPaused = true;
        btn.innerHTML = PLAY_ICON;
        updateLayers();
    } else {
        startAnimation();
        userPaused = false;
        btn.innerHTML = PAUSE_ICON;
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopAnimation();
    } else if (!userPaused) {
        startAnimation();
    }
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') unfocusRide();
});

// ═══════════════ Virtual Scroll ═══════════════
class VirtualList {
    constructor(container) {
        this.container = container;
        this.itemH = CONFIG.VIRTUAL_ITEM_H;
        this.items = [];
        this.renderFn = null;
        this.activeIdx = -1;

        this.inner = document.createElement('div');
        this.inner.style.position = 'relative';
        container.appendChild(this.inner);

        this._raf = null;
        container.addEventListener('scroll', () => {
            if (!this._raf) {
                this._raf = requestAnimationFrame(() => {
                    this._raf = null;
                    this._render();
                });
            }
        });
    }

    update(items, renderFn) {
        this.items = items;
        this.renderFn = renderFn;
        this.inner.style.height = `${items.length * this.itemH}px`;
        this._render();
    }

    _render() {
        const top = this.container.scrollTop;
        const h = this.container.clientHeight;
        const buf = CONFIG.VIRTUAL_BUFFER;
        const start = Math.max(0, Math.floor(top / this.itemH) - buf);
        const end = Math.min(this.items.length, Math.ceil((top + h) / this.itemH) + buf);

        const frag = document.createDocumentFragment();
        for (let i = start; i < end; i++) {
            const el = this.renderFn(this.items[i], i);
            el.style.position = 'absolute';
            el.style.top = `${i * this.itemH}px`;
            el.style.left = '0';
            el.style.right = '0';
            el.style.height = `${this.itemH}px`;
            if (i === this.activeIdx) el.classList.add('active');
            frag.appendChild(el);
        }
        this.inner.replaceChildren(frag);
    }

    scrollTo(idx) {
        const target = idx * this.itemH;
        const h = this.container.clientHeight;
        const top = this.container.scrollTop;
        if (target < top || target + this.itemH > top + h) {
            this.container.scrollTop = target - h / 2 + this.itemH / 2;
        }
    }

    setActive(idx) {
        this.activeIdx = idx;
        this._render();
    }
}

// ═══════════════ Sidebar ═══════════════
function renderStats() {
    const filtered = getFilteredRides();
    const stations = new Set();
    let totalCost = 0;
    filtered.forEach(r => {
        if (r.start_station) stations.add(r.start_station);
        if (r.end_station) stations.add(r.end_station);
        const c = r.total_charged;
        if (c && c.startsWith('$')) totalCost += parseFloat(c.slice(1)) || 0;
    });

    document.getElementById('stats').innerHTML = `
        <div class="stat" onclick="openSheet()" style="cursor:pointer"><div class="stat-value">${filtered.length.toLocaleString()}</div><div class="stat-label">Rides</div></div>
        <div class="stat" onclick="openSheet()" style="cursor:pointer"><div class="stat-value">${stations.size}</div><div class="stat-label">Stations</div></div>
        <div class="stat"><div class="stat-value">${[...allYears].length}</div><div class="stat-label">Years</div></div>
        <div class="stat"><div class="stat-value">$${Math.round(totalCost).toLocaleString()}</div><div class="stat-label">Spent</div></div>
    `;
}

function renderYearFilters() {
    const years = [...allYears].sort((a, b) => b - a);
    document.getElementById('year-filters').innerHTML =
        `<span class="filter-btn ${!activeYear ? 'active' : ''}" data-year="all" onclick="filterYear(null)">All</span>` +
        years.map(y =>
            `<span class="filter-btn ${activeYear === y ? 'active' : ''}" data-year="${y}" onclick="filterYear(${y})">${y}</span>`
        ).join('');
}

function renderRideList() {
    const container = document.getElementById('ride-list');
    const filtered = getFilteredRides();

    if (!virtualList) {
        container.innerHTML = '';
        virtualList = new VirtualList(container);
    }

    virtualList.update(filtered, (ride, idx) => {
        const el = document.createElement('div');
        el.className = 'ride-item';
        const style = ride._style || { color: '#4a00e0', t: 0 };
        el.style.borderLeftColor = style.color;

        el.innerHTML =
            `<div class="ride-date">${formatDate(ride.ride_date)} &middot; ${ride.ride_time || ride.start_time}${ride.type === 'group_ride' ? ' &middot; Group' : ''}</div>` +
            `<div class="ride-route"><span class="station">${ride.start_station}</span>` +
            `<span class="arrow" style="color:${style.color}">&rarr;</span>` +
            `<span class="station">${ride.end_station}</span></div>`;

        el.addEventListener('click', () => focusRide(rideData.indexOf(ride)));
        return el;
    });
}

// ═══════════════ Map Utilities ═══════════════
function fitBounds() {
    const rides = getFilteredRides();
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    let hasPoints = false;

    rides.forEach(r => {
        if (r.origin_lat) {
            west = Math.min(west, r.origin_lng);
            east = Math.max(east, r.origin_lng);
            south = Math.min(south, r.origin_lat);
            north = Math.max(north, r.origin_lat);
            hasPoints = true;
        }
        if (r.dest_lat) {
            west = Math.min(west, r.dest_lng);
            east = Math.max(east, r.dest_lng);
            south = Math.min(south, r.dest_lat);
            north = Math.max(north, r.dest_lat);
            hasPoints = true;
        }
    });

    if (hasPoints) {
        const padding = IS_MOBILE()
            ? { top: 20, bottom: 160, left: 20, right: 20 }
            : 40;
        map.fitBounds([[west, south], [east, north]], { padding, duration: 0, maxZoom: 16 });
    }
}

function resetView() {
    unfocusRide();
    fitBounds();
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (IS_MOBILE()) {
        sidebar.classList.toggle('expanded');
    } else {
        sidebar.classList.toggle('collapsed');
    }
}

function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (IS_MOBILE()) {
        sidebar.classList.remove('expanded');
    } else {
        sidebar.classList.add('collapsed');
    }
}

function openSheet() {
    if (IS_MOBILE()) document.getElementById('sidebar').classList.add('expanded');
}

// ═══════════════ Sheet Drag (mobile) ═══════════════
function initSheetDrag() {
    const sidebar = document.getElementById('sidebar');
    const handle = document.getElementById('sheet-handle');
    if (!handle) return;

    let startY, isDragging = false;

    handle.addEventListener('touchstart', e => {
        e.preventDefault();
        startY = e.touches[0].clientY;
        isDragging = true;
        sidebar.style.transition = 'none';
    }, { passive: false });

    document.addEventListener('touchmove', e => {
        if (!isDragging) return;
        const dy = e.touches[0].clientY - startY;
        const isExpanded = sidebar.classList.contains('expanded');
        const sheetH = sidebar.offsetHeight;
        const peek = 220; // matches mobile --sheet-peek
        const base = isExpanded ? 0 : (sheetH - peek);
        const clamped = Math.max(0, Math.min(sheetH - peek, base + dy));
        sidebar.style.transform = `translateY(${clamped}px)`;
    }, { passive: true });

    document.addEventListener('touchend', e => {
        if (!isDragging) return;
        isDragging = false;
        const endY = e.changedTouches[0]?.clientY ?? startY;
        const dy = endY - startY;

        sidebar.style.transition = '';
        sidebar.style.transform = '';

        if (Math.abs(dy) < 10) {
            sidebar.classList.toggle('expanded');
        } else if (dy > 60) {
            sidebar.classList.remove('expanded');
        } else if (dy < -60) {
            sidebar.classList.add('expanded');
        }
    }, { passive: true });
}

// ═══════════════ Boot ═══════════════
initMap();
initSheetDrag();
const _dataPromise = fetchRideData();

map.on('load', async () => {
    rideData = await _dataPromise;
    processAndRender();
    startAnimation();
});

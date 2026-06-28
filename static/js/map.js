const S = {
  data: null,
  allRecords: [],
  filteredAll: [],
  records: [],
  map: null,
  markers: [],
  markerLayer: null,
  trailLine: null,
  heatLayer: null,
  heatmapOn: false,
  playheadMarker: null,
  drawnItems: null,
  drawControl: null,
  geofenceShape: null,
  selectedIndex: 0,
  followMap: true,
  isPanning: false,
  playing: false,
  playTimer: null,
  showDeviceAlerts: true,
  showOperatorAlerts: true,
  timeFilter: { dateFrom: '', dateTo: '', timeFrom: '00:00', timeTo: '23:59', days: [0, 1, 2, 3, 4, 5, 6] },
  recordIndexMap: new Map(),
  deviceAlertIndices: new Set(),
  operatorAlertIndices: new Set(),
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function loadAlertPrefs() {
  S.showDeviceAlerts = localStorage.getItem('st_alert_device') !== 'off';
  S.showOperatorAlerts = localStorage.getItem('st_alert_operator') !== 'off';
  document.getElementById('toggle-device-alerts').checked = S.showDeviceAlerts;
  document.getElementById('toggle-operator-alerts').checked = S.showOperatorAlerts;
}

function initDayChips() {
  const wrap = document.getElementById('day-chips');
  wrap.innerHTML = DAY_NAMES.map((name, i) =>
    `<button type="button" class="day-chip active" data-day="${i}">${name}</button>`
  ).join('');
  wrap.querySelectorAll('.day-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      chip.classList.toggle('active');
      S.timeFilter.days = [...wrap.querySelectorAll('.day-chip.active')].map(c => parseInt(c.dataset.day, 10));
    });
  });
}

function readTimeFilterFromUI() {
  S.timeFilter.dateFrom = document.getElementById('filter-date-from').value;
  S.timeFilter.dateTo = document.getElementById('filter-date-to').value;
  S.timeFilter.timeFrom = document.getElementById('filter-time-from').value || '00:00';
  S.timeFilter.timeTo = document.getElementById('filter-time-to').value || '23:59';
}

function setDefaultDateRange() {
  const ov = S.data.overview;
  if (ov.first_seen) document.getElementById('filter-date-from').value = ov.first_seen.slice(0, 10);
  if (ov.last_seen) document.getElementById('filter-date-to').value = ov.last_seen.slice(0, 10);
}

function applyTimeFilter() {
  readTimeFilterFromUI();
  S.filteredAll = S.allRecords.filter(r => matchesTimeFilter(r, S.timeFilter));
  S.records = S.filteredAll.filter(r => r.latitude && r.longitude);
  S.recordIndexMap = new Map(S.records.map((r, i) => [r.id, i]));
  buildAlertIndexSets();
  updateFilterSummary();
  renderStats();
  renderCategoryBoxes();
  renderSidePanels();
  if (S.map) rebuildMapLayers();
  else if (S.records.length) initMap();
  else showNoGeoMessage();
  if (S.geofenceShape) updateGeofenceEvents();
  renderEventLog(S.records.length ? S.records.length - 1 : 0);
  resetPlayback();
}

function buildAlertIndexSets() {
  S.deviceAlertIndices = new Set();
  S.operatorAlertIndices = new Set();
  const filteredIds = new Set(S.filteredAll.map(r => r.id));
  (S.data.device_change_alerts || []).forEach(a => {
    const rec = S.allRecords[a.trail_index];
    if (rec && filteredIds.has(rec.id)) {
      const gi = S.recordIndexMap.get(rec.id);
      if (gi != null) S.deviceAlertIndices.add(gi);
    }
  });
  (S.data.operator_handoffs || []).forEach(h => {
    if (filteredIds.has(h.record_id)) {
      const gi = S.recordIndexMap.get(h.record_id);
      if (gi != null) S.operatorAlertIndices.add(gi);
    }
  });
}

function updateFilterSummary() {
  const el = document.getElementById('filter-summary');
  el.innerHTML = `Showing <b>${S.filteredAll.length}</b> / ${S.allRecords.length} events · <b>${S.records.length}</b> on map`;
}

function renderStats() {
  const f = S.filteredAll;
  const geo = S.records;
  const dist = actualTrailDistance(geo).toFixed(1);
  const jumps = f.filter(r => r.is_anomalous_jump).length;
  const contacts = new Set();
  f.forEach(r => { if (r.dest_number) contacts.add(r.dest_number); if (r.source_number) contacts.add(r.source_number); });
  const stats = [
    { label: 'Filtered events', value: f.length },
    { label: 'On map', value: geo.length },
    { label: 'Trail distance', value: `${dist} km`, sub: 'excl. jumps' },
    { label: 'Unique contacts', value: contacts.size },
    { label: 'Cell IDs', value: new Set(f.map(r => r.cell_id).filter(Boolean)).size },
    { label: 'Anomalous jumps', value: jumps, danger: jumps > 0 },
  ];
  document.getElementById('stat-row').innerHTML = stats.map(s => `
    <div class="stat-card ${s.danger ? 'stat-danger' : ''}">
      <div class="stat-value">${s.value}</div>
      <div class="stat-label">${s.label}${s.sub ? ` · ${s.sub}` : ''}</div>
    </div>`).join('');
}

function renderCategoryBoxes() {
  const f = S.filteredAll;
  const categories = [
    { key: 'incoming', filter: 'incoming', count: f.filter(r => r.call_type === 'incoming').length },
    { key: 'outgoing', filter: 'outgoing', count: f.filter(r => r.call_type === 'outgoing').length },
    { key: 'missed', filter: 'missed', count: f.filter(r => r.call_type === 'missed').length },
    { key: 'sms', filter: 'sms', count: f.filter(r => r.call_type === 'sms').length },
    { key: 'jump', filter: 'jump', count: f.filter(r => r.is_anomalous_jump).length, danger: true },
  ];
  function recentFor(filter) {
    const list = filter === 'jump' ? f.filter(r => r.is_anomalous_jump) : f.filter(r => r.call_type === filter);
    return list.slice(-3).reverse();
  }
  document.getElementById('event-cat-grid').innerHTML = categories.map(cat => {
    const meta = cat.key === 'jump' ? { label: 'Jump', icon: '⚡', css: 'jump' } : callMeta(cat.key);
    const recent = recentFor(cat.filter);
    return `<div class="event-cat-box ${meta.css} ${cat.danger ? 'cat-danger' : ''}">
      <div class="cat-head"><span class="cat-icon">${meta.icon}</span><span class="cat-title">${meta.label}</span><span class="cat-count">${cat.count}</span></div>
      <ul class="cat-recent">${recent.length ? recent.map(r => `<li><span class="mono">${new Date(r.timestamp).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span><span>${locationLabel(r).slice(0,28)}</span></li>`).join('') : '<li class="hint-text">No events</li>'}</ul>
      <button class="cat-more" data-filter="${cat.filter}">More →</button></div>`;
  }).join('');
  document.querySelectorAll('.cat-more').forEach(btn => btn.addEventListener('click', () => openEventsPage(CASE_ID, btn.dataset.filter)));
}

function renderSidePanels() {
  const f = S.filteredAll;
  const hourBuckets = {};
  for (let h = 0; h < 24; h++) hourBuckets[h] = 0;
  f.forEach(r => { if (r.timestamp) hourBuckets[new Date(r.timestamp).getHours()]++; });
  const maxHour = Math.max(...Object.values(hourBuckets), 1);
  document.getElementById('hour-chart').innerHTML = Object.entries(hourBuckets).map(([h, count]) => {
    const pct = Math.round((count / maxHour) * 100);
    return `<div class="hour-bar" title="${h}:00 — ${count}"><div class="hour-fill" style="height:${pct}%"></div><span class="hour-label">${h}</span></div>`;
  }).join('');

  renderPatternMatrix(buildPatternMatrixFromRecords(f), 'pattern-matrix');

  const breakdown = {};
  f.forEach(r => { const t = r.call_type || 'unknown'; breakdown[t] = (breakdown[t] || 0) + 1; });
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0) || 1;
  document.getElementById('breakdown-bars').innerHTML = Object.entries(breakdown).map(([type, count]) => {
    const pct = Math.round((count / total) * 100);
    return `<div class="bar-row"><span class="bar-label">${callMeta(type).label}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${callMeta(type).color}"></div></div><span class="bar-count">${count}</span></div>`;
  }).join('');

  const locBuckets = {};
  f.filter(r => r.latitude).forEach(r => {
    const key = `${r.latitude?.toFixed(3)},${r.longitude?.toFixed(3)}`;
    locBuckets[key] = (locBuckets[key] || 0) + 1;
  });
  const topLocs = Object.entries(locBuckets).sort((a, b) => b[1] - a[1]).slice(0, 5);
  document.getElementById('freq-list').innerHTML = topLocs.length
    ? topLocs.map(([, count], i) => {
        const r = f.find(x => x.latitude && `${x.latitude.toFixed(3)},${x.longitude.toFixed(3)}` === topLocs[i][0]);
        return `<li><span>${locationLabel(r)}</span><b>${count}×</b></li>`;
      }).join('')
    : '<li class="hint-text">No locations</li>';

  renderAlertLists();
  renderContactTables();
}

function renderAlertLists() {
  const filteredIds = new Set(S.filteredAll.map(r => r.id));
  const devList = document.getElementById('device-alerts-list');
  const devAlerts = (S.data.device_change_alerts || []).filter(a => {
    const rec = S.allRecords[a.trail_index];
    return rec && filteredIds.has(rec.id);
  });
  devList.innerHTML = devAlerts.length
    ? devAlerts.map(a => `<li data-id="${a.record_id}"><b>${a.type.toUpperCase()}</b> ${a.from_value} → ${a.to_value}<br><span class="mono">${fmtDateTime(a.timestamp)}</span></li>`).join('')
    : '<li class="hint-text">No device changes in filter</li>';

  const opList = document.getElementById('operator-alerts-list');
  const opAlerts = (S.data.operator_handoffs || []).filter(h => filteredIds.has(h.record_id));
  opList.innerHTML = opAlerts.length
    ? opAlerts.map(h => `<li class="alert-op" data-id="${h.record_id}">${h.from_operator} → <b>${h.to_operator}</b><br><span class="mono">${fmtDateTime(h.timestamp)}</span></li>`).join('')
    : '<li class="hint-text">No operator handoffs in filter</li>';

  devList.querySelectorAll('li[data-id]').forEach(li => li.addEventListener('click', () => jumpToRecord(li.dataset.id)));
  opList.querySelectorAll('li[data-id]').forEach(li => li.addEventListener('click', () => jumpToRecord(li.dataset.id)));
}

function jumpToRecord(id) {
  const numId = parseInt(id, 10);
  let idx = S.recordIndexMap.get(numId);
  if (idx == null) idx = S.records.findIndex(r => r.id === numId);
  if (idx >= 0) { S.selectedIndex = idx; setPlayhead(idx, true); }
}

function renderContactTables() {
  const f = S.filteredAll;
  const buckets = {};
  f.forEach(r => {
    const c = r.dest_number || r.source_number;
    if (!c) return;
    if (!buckets[c]) buckets[c] = { contact: c, count: 0, total_duration_seconds: 0, timestamps: [] };
    buckets[c].count++;
    buckets[c].total_duration_seconds += r.duration_seconds || 0;
    if (r.timestamp) buckets[c].timestamps.push(new Date(r.timestamp));
  });
  const rows = Object.values(buckets).map(b => ({
    ...b,
    first_contact: b.timestamps.length ? new Date(Math.min(...b.timestamps)).toISOString() : null,
    last_contact: b.timestamps.length ? new Date(Math.max(...b.timestamps)).toISOString() : null,
  }));
  const byCalls = [...rows].sort((a, b) => b.count - a.count).slice(0, 10);
  const byDur = [...rows].sort((a, b) => b.total_duration_seconds - a.total_duration_seconds).slice(0, 10);
  function fill(sel, data, fmt) {
    document.querySelector(`${sel} tbody`).innerHTML = data.map(r =>
      `<tr><td class="mono">${r.contact}</td><td>${fmt(r)}</td><td>${fmtDateShort(r.first_contact)}</td><td>${fmtDateShort(r.last_contact)}</td></tr>`
    ).join('');
  }
  fill('#table-most-calls', byCalls, r => r.count);
  fill('#table-most-duration', byDur, r => fmtDuration(r.total_duration_seconds));
}

function colorFor(r, idx) {
  if (S.showDeviceAlerts && S.deviceAlertIndices.has(idx)) return '#a78bfa';
  if (S.showOperatorAlerts && S.operatorAlertIndices.has(idx)) return '#38bdf8';
  if (r.is_anomalous_jump) return '#ff5c6a';
  if (r.location_confidence === 'known_tower') return '#00d4aa';
  if (r.location_confidence === 'provided_in_file') return '#7AA2F7';
  return '#6b8a9e';
}

function showNoGeoMessage() {
  if (S.map) { S.map.remove(); S.map = null; S.markers = []; S.trailLine = null; }
  document.getElementById('map').innerHTML = '<div style="padding:40px;color:#6b8a9e">No geolocated records match the current filter.</div>';
}

function initMap() {
  if (!S.records.length) return;
  const mapEl = document.getElementById('map');
  mapEl.innerHTML = '';
  S.map = L.map(mapEl, { zoomControl: true }).setView([S.records[0].latitude, S.records[0].longitude], 7);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19
  }).addTo(S.map);

  S.markerLayer = L.layerGroup().addTo(S.map);
  S.drawnItems = new L.FeatureGroup().addTo(S.map);
  S.drawControl = new L.Control.Draw({
    draw: {
      polygon: { shapeOptions: { color: '#00d4aa', weight: 2 } },
      circle: { shapeOptions: { color: '#38bdf8', weight: 2 } },
      rectangle: false, marker: false, polyline: false, circlemarker: false,
    },
    edit: { featureGroup: S.drawnItems, remove: true },
  });
  S.map.addControl(S.drawControl);
  S.map.on(L.Draw.Event.CREATED, onGeofenceDrawn);
  S.map.on(L.Draw.Event.DELETED, () => { S.geofenceShape = null; document.getElementById('geofence-panel').style.display = 'none'; });

  rebuildMapLayers();
  document.getElementById('toggle-heatmap').addEventListener('click', toggleHeatmap);
  document.getElementById('clear-geofence').addEventListener('click', clearGeofence);
}

function rebuildMapLayers() {
  if (!S.map || !S.records.length) return;
  S.markerLayer.clearLayers();
  S.markers = [];
  if (S.trailLine) { S.map.removeLayer(S.trailLine); S.trailLine = null; }
  if (S.heatLayer) { S.map.removeLayer(S.heatLayer); S.heatLayer = null; }
  if (S.playheadMarker) { S.map.removeLayer(S.playheadMarker); S.playheadMarker = null; }

  const latlngs = S.records.map(r => [r.latitude, r.longitude]);
  S.trailLine = L.polyline(latlngs, { color: '#00d4aa', weight: 2, opacity: 0.65, dashArray: '4,4' }).addTo(S.map);

  S.records.forEach((r, i) => {
    const color = colorFor(r, i);
    const marker = L.circleMarker([r.latitude, r.longitude], {
      radius: 6, color, fillColor: color, fillOpacity: 0.85, weight: 1
    });
    marker._baseColor = color;
    marker._index = i;
    marker.on('click', () => { S.selectedIndex = i; showSelectedPoint(r, i); updateMarkerStyles(getPlayheadIdx()); });
    S.markers.push(marker);
    S.markerLayer.addLayer(marker);
  });

  if (S.heatmapOn) buildHeatLayer();
  S.map.fitBounds(S.trailLine.getBounds(), { padding: [30, 30] });
  setTimeout(() => S.map?.invalidateSize(), 150);
  const slider = document.getElementById('time-slider');
  slider.max = Math.max(0, S.records.length - 1);
  const idx = Math.min(getPlayheadIdx(), S.records.length - 1);
  setPlayhead(idx, false);
}

function buildHeatLayer() {
  if (S.heatLayer) { S.map.removeLayer(S.heatLayer); S.heatLayer = null; }
  const pts = S.records.map(r => [r.latitude, r.longitude, 0.6]);
  S.heatLayer = L.heatLayer(pts, { radius: 28, blur: 18, maxZoom: 14, gradient: { 0.2: '#0a2a4a', 0.5: '#00d4aa', 1: '#ff5c6a' } });
  if (S.heatmapOn) S.heatLayer.addTo(S.map);
}

function toggleHeatmap() {
  S.heatmapOn = !S.heatmapOn;
  document.getElementById('toggle-heatmap').classList.toggle('active', S.heatmapOn);
  if (S.heatmapOn) { buildHeatLayer(); if (S.heatLayer) S.heatLayer.addTo(S.map); }
  else if (S.heatLayer) S.map.removeLayer(S.heatLayer);
}

function onGeofenceDrawn(e) {
  S.drawnItems.clearLayers();
  S.drawnItems.addLayer(e.layer);
  S.geofenceShape = e.layer;
  updateGeofenceEvents();
}

function clearGeofence() {
  S.drawnItems?.clearLayers();
  S.geofenceShape = null;
  document.getElementById('geofence-panel').style.display = 'none';
}

function eventInGeofence(r) {
  if (!S.geofenceShape || !r.latitude) return false;
  const ll = [r.latitude, r.longitude];
  if (S.geofenceShape instanceof L.Circle) {
    const c = S.geofenceShape.getLatLng();
    return pointInCircle(ll[0], ll[1], c.lat, c.lng, S.geofenceShape.getRadius());
  }
  if (S.geofenceShape instanceof L.Polygon) {
    const ring = S.geofenceShape.getLatLngs()[0].map(p => [p.lat, p.lng]);
    return pointInPolygon(ll[0], ll[1], ring);
  }
  return false;
}

function updateGeofenceEvents() {
  const inside = S.filteredAll.filter(eventInGeofence);
  const panel = document.getElementById('geofence-panel');
  panel.style.display = '';
  document.getElementById('geofence-count').textContent = inside.length;
  const shape = S.geofenceShape instanceof L.Circle
    ? `Circle · ${Math.round(S.geofenceShape.getRadius())} m radius`
    : 'Polygon area';
  document.getElementById('geofence-hint').textContent = `${shape} — click event to locate on map`;
  document.getElementById('geofence-events').innerHTML = inside.map(r =>
    `<div class="geofence-event" data-id="${r.id}">${eventBadgeHtml(r, true)} <span class="mono">${fmtDateTime(r.timestamp)}</span> — ${locationLabel(r)}</div>`
  ).join('') || '<p class="hint-text">No events inside geofence</p>';
  panel.querySelectorAll('.geofence-event').forEach(el => el.addEventListener('click', () => jumpToRecord(el.dataset.id)));
}

function smoothFollow(latlng, force) {
  if (!S.followMap || S.isPanning) return;
  const bounds = S.map.getBounds().pad(-0.3);
  if (force || !bounds.contains(latlng)) {
    S.isPanning = true;
    S.map.flyTo(latlng, Math.max(S.map.getZoom(), 12), { duration: 0.7, easeLinearity: 0.2, noMoveStart: true });
    S.map.once('moveend', () => { S.isPanning = false; });
  }
}

function getPlayheadIdx() {
  return parseInt(document.getElementById('time-slider').value, 10) || 0;
}

function updatePlayheadMarker(i) {
  if (!S.records[i]) return;
  const r = S.records[i];
  const latlng = [r.latitude, r.longitude];
  const pColor = r.is_anomalous_jump ? '#ff5c6a' : '#00d4aa';
  if (!S.playheadMarker) {
    S.playheadMarker = L.circleMarker(latlng, { radius: 11, color: pColor, fillColor: pColor, fillOpacity: 0.35, weight: 3, className: 'playhead-pulse' }).addTo(S.map);
  } else {
    S.playheadMarker.setLatLng(latlng);
    S.playheadMarker.setStyle({ color: pColor, fillColor: pColor });
  }
}

function updateMarkerStyles(playheadIdx) {
  S.markers.forEach((m, idx) => {
    const r = S.records[idx];
    const el = m.getElement && m.getElement();
    const isPast = idx <= playheadIdx;
    const isSelected = idx === S.selectedIndex;
    const isActive = idx === playheadIdx;
    const radius = isActive ? 11 : isSelected ? 9 : 6;
    const base = colorFor(r, idx);
    m.setStyle({ radius, weight: isActive || isSelected ? 2.5 : 1, fillOpacity: isPast ? 0.9 : 0.12, color: isActive ? '#00d4aa' : base, fillColor: isActive ? '#00d4aa' : base });
    if (el) { el.style.opacity = isPast ? '1' : '0.15'; }
  });
  updatePlayheadMarker(playheadIdx);
}

function detailMiniBox(title, html) {
  return `<div class="mini-detail-box"><h4>${title}</h4>${html}</div>`;
}

function showSelectedPoint(r, idx) {
  const i = idx ?? S.recordIndexMap.get(r.id) ?? 0;
  const prev = i > 0 ? S.records[i - 1] : null;
  const next = i < S.records.length - 1 ? S.records[i + 1] : null;
  const sameLocation = S.records.filter(o => (o.cell_id && o.cell_id === r.cell_id) || (Math.abs(o.latitude - r.latitude) < 0.0005 && Math.abs(o.longitude - r.longitude) < 0.0005));
  const timestamps = sameLocation.map(o => new Date(o.timestamp));
  const conf = CONFIDENCE_META[r.location_confidence] || { label: r.location_confidence || '—' };
  const devAlert = (S.data.device_change_alerts || []).find(a => a.record_id === r.id);
  const opAlert = (S.data.operator_handoffs || []).find(h => h.record_id === r.id);

  document.getElementById('selected-point-block').innerHTML = `
    <div class="detail-header"><h2 class="stack-title">Event #${i + 1} — selected point</h2><div class="detail-badges">${eventBadgeHtml(r)}${r.is_anomalous_jump ? '<span class="anomaly-pill">⚡ Jump</span>' : ''}${devAlert ? '<span class="anomaly-pill" style="border-color:#a78bfa;color:#a78bfa">IMEI/IMSI</span>' : ''}${opAlert ? '<span class="anomaly-pill" style="color:#38bdf8">Operator switch</span>' : ''}</div></div>
    <div class="detail-actions">
      <button class="btn-ghost small" id="btn-center-map">Center map</button>
      <button class="btn-ghost small" id="btn-open-detail">Full report ↗</button>
      <button class="btn-ghost small" id="btn-prev-evt" ${!prev ? 'disabled' : ''}>← Prev</button>
      <button class="btn-ghost small" id="btn-next-evt" ${!next ? 'disabled' : ''}>Next →</button>
    </div>
    <div class="detail-boxes">
      ${detailMiniBox('Call &amp; time', `<dl class="kv"><dt>Time</dt><dd>${fmtDateTime(r.timestamp)}</dd><dt>Day</dt><dd>${dayOfWeek(r.timestamp)}</dd><dt>Period</dt><dd>${timeOfDay(r.timestamp)}</dd><dt>Contact</dt><dd class="mono">${contactLabel(r)}</dd><dt>Duration</dt><dd>${fmtDuration(r.duration_seconds)}</dd><dt>Gap</dt><dd>${fmtGap(r.gap_from_prev_seconds)}</dd></dl>`)}
      ${detailMiniBox('Location', `<dl class="kv"><dt>Address</dt><dd>${locationLabel(r)}</dd><dt>Cell ID</dt><dd class="mono">${r.cell_id || '—'}</dd><dt>Operator</dt><dd>${r.tower_operator || r.service_provider || '—'}</dd><dt>Confidence</dt><dd>${conf.label}</dd><dt>Coords</dt><dd class="mono">${r.latitude?.toFixed(5)}, ${r.longitude?.toFixed(5)}</dd></dl>`)}
      ${detailMiniBox('Movement', `<dl class="kv"><dt>Distance</dt><dd>${r.is_anomalous_jump ? '<span class="danger-text">excluded (jump)</span>' : (r.distance_from_prev_km != null ? r.distance_from_prev_km + ' km' : '—')}</dd><dt>Speed</dt><dd>${r.speed_from_prev_kmh != null ? r.speed_from_prev_kmh + ' km/h' : '—'}</dd><dt>Bearing</dt><dd>${r.bearing_label || '—'}</dd><dt>Dwell</dt><dd>${r.dwell_minutes_after != null ? r.dwell_minutes_after + ' min' : '—'}</dd></dl>`)}
      ${detailMiniBox('Device', `<dl class="kv"><dt>IMEI</dt><dd class="mono">${r.imei || '—'}</dd><dt>IMSI</dt><dd class="mono">${r.imsi || '—'}</dd>${devAlert ? `<dt>⚠ Change</dt><dd class="danger-text">${devAlert.type}: ${devAlert.from_value} → ${devAlert.to_value}</dd>` : ''}</dl>`)}
      ${opAlert ? detailMiniBox('Operator handoff', `<p class="danger-text">${opAlert.from_operator} → <b>${opAlert.to_operator}</b></p>`) : ''}
      ${detailMiniBox('At location', `<p class="big-stat">${sameLocation.length} events</p><p class="hint-text">${fmtDateTime(new Date(Math.min(...timestamps)))} → ${fmtDateTime(new Date(Math.max(...timestamps)))}</p></dl>`)}
    </div>`;

  document.getElementById('btn-center-map')?.addEventListener('click', () => S.map.flyTo([r.latitude, r.longitude], Math.max(S.map.getZoom(), 14), { duration: 0.6 }));
  document.getElementById('btn-open-detail')?.addEventListener('click', () => openEventDetail(CASE_ID, r.id));
  document.getElementById('btn-prev-evt')?.addEventListener('click', () => { if (prev) { S.selectedIndex = i - 1; setPlayhead(i - 1, true); } });
  document.getElementById('btn-next-evt')?.addEventListener('click', () => { if (next) { S.selectedIndex = i + 1; setPlayhead(i + 1, true); } });
}

function renderEventLog(upToIndex) {
  const eventLog = document.getElementById('event-log');
  document.getElementById('event-count-badge').textContent = S.records.length;
  if (!S.records.length) { eventLog.innerHTML = '<p class="hint-text">No events</p>'; return; }
  const visible = S.records.slice(0, upToIndex + 1).slice(-50);
  eventLog.innerHTML = visible.map((r, idx, arr) => {
    const isLast = idx === arr.length - 1;
    const globalIdx = S.recordIndexMap.get(r.id);
    return `<div class="event-row ${isLast ? 'highlight' : ''} ${r.is_anomalous_jump ? 'row-jump' : ''}" data-idx="${globalIdx}">
      ${eventBadgeHtml(r, true)}<span class="evt-time mono">${new Date(r.timestamp).toLocaleString()}</span>
      <span class="evt-contact mono">${r.dest_number || r.source_number || '—'}</span>
      <span class="evt-loc">${locationLabel(r)}</span><span class="evt-dur">${fmtDuration(r.duration_seconds)}</span>
      <button class="evt-more" data-id="${r.id}">↗</button></div>`;
  }).join('');
  eventLog.querySelectorAll('.event-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.evt-more')) return;
      const idx = parseInt(row.dataset.idx, 10);
      S.selectedIndex = idx;
      setPlayhead(idx, true);
    });
  });
  eventLog.querySelectorAll('.evt-more').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); openEventDetail(CASE_ID, btn.dataset.id); }));
  eventLog.scrollTop = eventLog.scrollHeight;
}

function setPlayhead(i, animateFollow = true) {
  if (!S.records.length) return;
  i = Math.max(0, Math.min(S.records.length - 1, i));
  const r = S.records[i];
  document.getElementById('time-slider').value = i;
  document.getElementById('time-readout').textContent = fmtDateTime(r.timestamp);
  document.getElementById('playhead-info').innerHTML = `${eventBadgeHtml(r, true)} <span class="mono">#${i + 1}</span>`;
  if (S.trailLine) S.trailLine.setLatLngs(S.records.slice(0, i + 1).map(x => [x.latitude, x.longitude]));
  updateMarkerStyles(i);
  renderEventLog(i);
  if (animateFollow && S.map) smoothFollow([r.latitude, r.longitude]);
  S.selectedIndex = i;
  showSelectedPoint(r, i);
}

function resetPlayback() {
  clearInterval(S.playTimer);
  S.playing = false;
  document.getElementById('play-btn').textContent = '▶ Play';
}

function setupPlayback() {
  const slider = document.getElementById('time-slider');
  const playBtn = document.getElementById('play-btn');
  const speedSelect = document.getElementById('play-speed');
  document.getElementById('follow-map').addEventListener('change', e => { S.followMap = e.target.checked; });

  slider.addEventListener('input', () => setPlayhead(parseInt(slider.value, 10), true));
  const tick = () => {
    const next = getPlayheadIdx() + 1;
    if (next > S.records.length - 1) { resetPlayback(); return; }
    S.selectedIndex = next;
    setPlayhead(next, true);
  };
  playBtn.addEventListener('click', () => {
    S.playing = !S.playing;
    playBtn.textContent = S.playing ? '⏸ Pause' : '▶ Play';
    if (S.playing) {
      setPlayhead(0, true);
      S.playTimer = setInterval(tick, parseInt(speedSelect.value, 10));
    } else resetPlayback();
  });
  speedSelect.addEventListener('change', () => {
    if (S.playing) { resetPlayback(); S.playing = true; playBtn.textContent = '⏸ Pause'; S.playTimer = setInterval(tick, parseInt(speedSelect.value, 10)); }
  });
}

async function init() {
  const res = await fetch(API_URL);
  S.data = await res.json();
  S.allRecords = S.data.records;

  loadAlertPrefs();
  initDayChips();
  setDefaultDateRange();
  document.getElementById('filter-apply').addEventListener('click', applyTimeFilter);
  document.getElementById('filter-reset').addEventListener('click', () => {
    document.getElementById('filter-time-from').value = '00:00';
    document.getElementById('filter-time-to').value = '23:59';
    setDefaultDateRange();
    document.querySelectorAll('.day-chip').forEach(c => c.classList.add('active'));
    S.timeFilter.days = [0, 1, 2, 3, 4, 5, 6];
    applyTimeFilter();
  });
  document.getElementById('view-all-events').addEventListener('click', () => openEventsPage(CASE_ID));
  document.getElementById('toggle-device-alerts').addEventListener('change', e => {
    S.showDeviceAlerts = e.target.checked;
    localStorage.setItem('st_alert_device', e.target.checked ? 'on' : 'off');
    rebuildMapLayers();
  });
  document.getElementById('toggle-operator-alerts').addEventListener('change', e => {
    S.showOperatorAlerts = e.target.checked;
    localStorage.setItem('st_alert_operator', e.target.checked ? 'on' : 'off');
    rebuildMapLayers();
  });

  setupPlayback();
  applyTimeFilter();
}

init();

/* Shared CDR / event helpers for map and events pages */

const CALL_TYPE_META = {
  incoming: { label: 'Incoming', short: 'IN', icon: '↓', color: '#00d4aa', css: 'incoming' },
  outgoing: { label: 'Outgoing', short: 'OUT', icon: '↑', color: '#fbbf24', css: 'outgoing' },
  missed:   { label: 'Missed', short: 'MIS', icon: '✕', color: '#E5484D', css: 'missed' },
  sms:      { label: 'Message', short: 'SMS', icon: '✉', color: '#7AA2F7', css: 'sms' },
  unknown:  { label: 'Unknown', short: '?', icon: '?', color: '#8B98A0', css: 'unknown' },
};

const CONFIDENCE_META = {
  known_tower:       { label: 'Known tower', css: 'conf-known' },
  provided_in_file:  { label: 'From CDR file', css: 'conf-provided' },
  estimated:         { label: 'Estimated', css: 'conf-estimated' },
};

function fmtDuration(seconds) {
  seconds = seconds || 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtGap(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function fmtDateShort(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function callMeta(type) {
  return CALL_TYPE_META[type] || CALL_TYPE_META.unknown;
}

function eventTypeLabel(r) {
  if (r.is_anomalous_jump) return 'jump';
  return r.call_type || 'unknown';
}

function eventBadgeHtml(r, compact) {
  const jump = r.is_anomalous_jump;
  const meta = jump
    ? { label: 'Jump', short: 'JMP', icon: '⚡', color: '#E5484D', css: 'jump' }
    : callMeta(r.call_type);
  if (compact) {
    return `<span class="evt-badge ${meta.css}${jump ? ' jump' : ''}" title="${meta.label}">${meta.icon}</span>`;
  }
  return `<span class="evt-badge ${meta.css}${jump ? ' jump' : ''}">${meta.icon} ${meta.label}</span>`;
}

function locationLabel(r) {
  return r.tower_address || r.location_text || 'Unknown location';
}

function contactLabel(r) {
  return `${r.source_number || '?'} → ${r.dest_number || '?'}`;
}

function mapsLink(lat, lng) {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
}

function dayOfWeek(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'long' });
}

function timeOfDay(iso) {
  if (!iso) return '—';
  const h = new Date(iso).getHours();
  if (h < 6) return 'Night (00–06)';
  if (h < 12) return 'Morning (06–12)';
  if (h < 17) return 'Afternoon (12–17)';
  if (h < 21) return 'Evening (17–21)';
  return 'Night (21–00)';
}

function openEventDetail(caseId, recordId) {
  window.open(`/case/${caseId}/event/${recordId}`, '_blank');
}

function openEventsPage(caseId, filter) {
  const q = filter ? `?type=${filter}` : '';
  window.open(`/case/${caseId}/events${q}`, '_blank');
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function pointInCircle(lat, lng, cLat, cLng, radiusM) {
  return haversineKm(lat, lng, cLat, cLng) * 1000 <= radiusM;
}

function pointInPolygon(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = ring[i][1];
    const yj = ring[j][0], xj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function isNightHour(iso) {
  const h = new Date(iso).getHours();
  return h < 6 || h >= 21;
}

function parseTimeToMins(t) {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

function matchesTimeFilter(r, f) {
  if (!r.timestamp) return false;
  const d = new Date(r.timestamp);
  if (f.dateFrom) {
    const from = new Date(f.dateFrom + 'T00:00:00');
    if (d < from) return false;
  }
  if (f.dateTo) {
    const to = new Date(f.dateTo + 'T23:59:59');
    if (d > to) return false;
  }
  if (f.days && f.days.length < 7 && !f.days.includes(d.getDay())) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  const fromM = parseTimeToMins(f.timeFrom || '00:00');
  const toM = parseTimeToMins(f.timeTo || '23:59');
  if (fromM <= toM) {
    if (mins < fromM || mins > toM) return false;
  } else if (mins > toM && mins < fromM) return false;
  return true;
}

function actualTrailDistance(records) {
  return records
    .filter(r => r.latitude && r.longitude)
    .reduce((sum, r) => sum + (r.is_anomalous_jump ? 0 : (r.distance_from_prev_km || 0)), 0);
}

function renderPatternMatrix(matrix, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  let maxVal = 1;
  for (let h = 0; h < 24; h++) {
    maxVal = Math.max(maxVal, (matrix[h]?.incoming || 0) + (matrix[h]?.outgoing || 0));
  }
  let html = '<div class="pattern-matrix">';
  html += '<div class="pm-label"></div>';
  for (let h = 0; h < 24; h++) html += `<div class="pm-hour">${h}</div>`;
  ['incoming', 'outgoing'].forEach(dir => {
    html += `<div class="pm-label">${dir === 'incoming' ? '↓ In' : '↑ Out'}</div>`;
    for (let h = 0; h < 24; h++) {
      const v = matrix[h]?.[dir] || 0;
      const intensity = Math.round((v / maxVal) * 100);
      const cls = dir === 'incoming' ? 'in' : 'out';
      html += `<div class="pattern-cell ${cls}${intensity > 60 ? ' hot' : ''}" style="opacity:${0.2 + intensity/125}" title="${h}:00 — ${v} ${dir}"></div>`;
    }
  });
  html += '</div><div class="pattern-legend"><span class="leg-in">Incoming</span><span class="leg-out">Outgoing</span></div>';
  el.innerHTML = html;
}

function buildPatternMatrixFromRecords(records) {
  const matrix = {};
  for (let h = 0; h < 24; h++) matrix[h] = { incoming: 0, outgoing: 0 };
  records.forEach(r => {
    if (!r.timestamp) return;
    const ct = r.call_type;
    if (ct !== 'incoming' && ct !== 'outgoing') return;
    const h = new Date(r.timestamp).getHours();
    matrix[h][ct]++;
  });
  return matrix;
}

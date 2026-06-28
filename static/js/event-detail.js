function detailBox(title, rows) {
  const items = rows.map(([k, v]) =>
    `<dt>${k}</dt><dd>${v ?? '—'}</dd>`
  ).join('');
  return `<div class="detail-box"><h3>${title}</h3><dl class="kv kv-detail">${items}</dl></div>`;
}

function buildContactHistory(records, r) {
  const contact = r.dest_number || r.source_number;
  if (!contact) return [];
  return records.filter(o =>
    o.dest_number === contact || o.source_number === contact
  ).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 8);
}

async function initEventDetail() {
  const res = await fetch(API_URL);
  const data = await res.json();
  const records = data.records;
  const r = records.find(x => x.id === RECORD_ID);
  if (!r) {
    document.getElementById('detail-grid').innerHTML = '<p class="hint-text">Event not found.</p>';
    return;
  }

  const idx = r.trail_index ?? records.indexOf(r);
  const prev = idx > 0 ? records[idx - 1] : null;
  const next = idx < records.length - 1 ? records[idx + 1] : null;

  const sameLocation = records.filter(o =>
    (o.cell_id && o.cell_id === r.cell_id) ||
    (r.latitude && o.latitude &&
      Math.abs(o.latitude - r.latitude) < 0.0005 &&
      Math.abs(o.longitude - r.longitude) < 0.0005)
  );
  const contactHistory = buildContactHistory(records, r);
  const conf = CONFIDENCE_META[r.location_confidence] || { label: r.location_confidence || '—' };

  document.getElementById('event-headline').textContent =
    `${fmtDateTime(r.timestamp)} · ${contactLabel(r)} · ${eventBadgeHtml(r).replace(/<[^>]+>/g, '')}`;

  const grid = document.getElementById('detail-grid');
  grid.innerHTML = `
    <div class="detail-hero">
      ${eventBadgeHtml(r)}
      ${r.is_anomalous_jump ? '<span class="anomaly-banner">⚠ Anomalous movement detected</span>' : ''}
    </div>
    ${detailBox('Call &amp; contact', [
      ['Trail index', `#${idx + 1} of ${records.length}`],
      ['Timestamp', fmtDateTime(r.timestamp)],
      ['Day', dayOfWeek(r.timestamp)],
      ['Time of day', timeOfDay(r.timestamp)],
      ['Call type', callMeta(r.call_type).label],
      ['Duration', fmtDuration(r.duration_seconds)],
      ['Source', r.source_number || '—'],
      ['Destination', r.dest_number || '—'],
      ['Gap since prev', fmtGap(r.gap_from_prev_seconds)],
    ])}
    ${detailBox('Location &amp; tower', [
      ['Address', locationLabel(r)],
      ['Cell ID', r.cell_id || '—'],
      ['Tower operator', r.tower_operator || '—'],
      ['Service provider', r.service_provider || '—'],
      ['Confidence', conf.label],
      ['Latitude', r.latitude != null ? r.latitude.toFixed(6) : '—'],
      ['Longitude', r.longitude != null ? r.longitude.toFixed(6) : '—'],
      ['OSM link', r.latitude ? `<a href="${mapsLink(r.latitude, r.longitude)}" target="_blank" rel="noopener">Open in OpenStreetMap ↗</a>` : '—'],
    ])}
    ${detailBox('Movement &amp; trail', [
      ['Distance from prev', r.distance_from_prev_km != null ? `${r.distance_from_prev_km} km` : '—'],
      ['Speed from prev', r.speed_from_prev_kmh != null ? `${r.speed_from_prev_kmh} km/h` : '—'],
      ['Bearing', r.bearing_label ? `${r.bearing_label} (${r.bearing_from_prev}°)` : '—'],
      ['Dwell after event', r.dwell_minutes_after != null ? `${r.dwell_minutes_after} min` : '—'],
      ['Anomalous jump', r.is_anomalous_jump ? 'Yes' : 'No'],
    ])}
    ${detailBox('Device identifiers', [
      ['IMEI', r.imei || '—'],
      ['IMSI', r.imsi || '—'],
    ])}
    ${detailBox('Location activity', [
      ['Events at this cell/area', sameLocation.length],
      ['First seen here', fmtDateTime(Math.min(...sameLocation.map(o => new Date(o.timestamp))))],
      ['Last seen here', fmtDateTime(Math.max(...sameLocation.map(o => new Date(o.timestamp))))],
      ['Incoming here', sameLocation.filter(o => o.call_type === 'incoming').length],
      ['Outgoing here', sameLocation.filter(o => o.call_type === 'outgoing').length],
      ['Messages here', sameLocation.filter(o => o.call_type === 'sms').length],
    ])}
    <div class="detail-box detail-box-wide">
      <h3>Contact history — ${r.dest_number || r.source_number || 'unknown'}</h3>
      <table class="data-table mini-table">
        <thead><tr><th>Time</th><th>Type</th><th>Duration</th><th>Location</th></tr></thead>
        <tbody>
          ${contactHistory.map(c => `<tr>
            <td class="mono">${fmtDateTime(c.timestamp)}</td>
            <td>${eventBadgeHtml(c, true)}</td>
            <td>${fmtDuration(c.duration_seconds)}</td>
            <td>${locationLabel(c)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;

  if (r.latitude && r.longitude) {
    const mapPanel = document.getElementById('detail-map-panel');
    mapPanel.style.display = '';
    const map = L.map('detail-map').setView([r.latitude, r.longitude], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);
    const color = r.is_anomalous_jump ? '#E5484D' : callMeta(r.call_type).color;
    L.circleMarker([r.latitude, r.longitude], {
      radius: 10, color, fillColor: color, fillOpacity: 0.9, weight: 2
    }).addTo(map).bindPopup(`<b>${locationLabel(r)}</b><br>${fmtDateTime(r.timestamp)}`);
    if (prev && prev.latitude) {
      L.polyline([[prev.latitude, prev.longitude], [r.latitude, r.longitude]], {
        color: '#FFB454', weight: 2, dashArray: '6,4'
      }).addTo(map);
      L.circleMarker([prev.latitude, prev.longitude], {
        radius: 5, color: '#8B98A0', fillColor: '#8B98A0', fillOpacity: 0.6
      }).addTo(map);
    }
    if (next && next.latitude) {
      L.circleMarker([next.latitude, next.longitude], {
        radius: 5, color: '#8B98A0', fillColor: '#8B98A0', fillOpacity: 0.6
      }).addTo(map);
    }
    const pts = [prev, r, next].filter(p => p && p.latitude).map(p => [p.latitude, p.longitude]);
    if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40] });
  }

  const ctxPanel = document.getElementById('context-panel');
  ctxPanel.style.display = '';
  function ctxCard(label, rec) {
    if (!rec) return `<div class="context-card empty"><span class="context-label">${label}</span><p>—</p></div>`;
    return `<div class="context-card" data-id="${rec.id}">
      <span class="context-label">${label}</span>
      ${eventBadgeHtml(rec)}
      <p class="mono">${fmtDateTime(rec.timestamp)}</p>
      <p>${locationLabel(rec)}</p>
      <button class="btn-link-detail" data-id="${rec.id}">Open →</button>
    </div>`;
  }
  document.getElementById('context-row').innerHTML =
    ctxCard('Previous', prev) + ctxCard('Current', r) + ctxCard('Next', next);

  document.querySelectorAll('.btn-link-detail, .context-card[data-id]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      if (id && parseInt(id, 10) !== RECORD_ID) {
        window.location.href = `/case/${CASE_ID}/event/${id}`;
      }
    });
  });
}

initEventDetail();

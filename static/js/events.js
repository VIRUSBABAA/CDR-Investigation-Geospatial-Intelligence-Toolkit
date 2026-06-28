async function initEventsPage() {
  const res = await fetch(API_URL);
  const data = await res.json();
  const allRecords = data.records;
  let activeFilter = INITIAL_FILTER;
  let searchQuery = '';

  const deviceChangeIds = new Set((data.device_change_alerts || []).map(a => a.record_id));
  const operatorHandoffIds = new Set((data.operator_handoffs || []).map(h => h.record_id));

  const tbody = document.getElementById('events-tbody');
  const summary = document.getElementById('events-summary');
  const chips = document.querySelectorAll('#filter-chips .chip');
  const searchInput = document.getElementById('event-search');

  const adv = {
    dateFrom: document.getElementById('adv-date-from'),
    dateTo: document.getElementById('adv-date-to'),
    timeFrom: document.getElementById('adv-time-from'),
    timeTo: document.getElementById('adv-time-to'),
    durMin: document.getElementById('adv-dur-min'),
    durMax: document.getElementById('adv-dur-max'),
    cellId: document.getElementById('adv-cell-id'),
    imei: document.getElementById('adv-imei'),
    imsi: document.getElementById('adv-imsi'),
    jumpsOnly: document.getElementById('adv-jumps-only'),
    nightOnly: document.getElementById('adv-night-only'),
    deviceChange: document.getElementById('adv-device-change'),
    operatorHandoff: document.getElementById('adv-operator-handoff'),
  };

  if (data.overview.first_seen) adv.dateFrom.value = data.overview.first_seen.slice(0, 10);
  if (data.overview.last_seen) adv.dateTo.value = data.overview.last_seen.slice(0, 10);

  function getAdvFilter() {
    return {
      dateFrom: adv.dateFrom.value,
      dateTo: adv.dateTo.value,
      timeFrom: adv.timeFrom.value || '00:00',
      timeTo: adv.timeTo.value || '23:59',
      days: [0, 1, 2, 3, 4, 5, 6],
    };
  }

  function matchesTypeFilter(r) {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'jump') return r.is_anomalous_jump;
    return r.call_type === activeFilter;
  }

  function matchesSearch(r) {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const hay = [r.source_number, r.dest_number, r.cell_id, r.tower_address, r.location_text, r.imei, r.imsi, r.service_provider, r.call_type].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  }

  function matchesAdvanced(r) {
    if (!matchesTimeFilter(r, getAdvFilter())) return false;
    const durMin = parseInt(adv.durMin.value, 10);
    const durMax = parseInt(adv.durMax.value, 10);
    if (!isNaN(durMin) && adv.durMin.value !== '' && (r.duration_seconds || 0) < durMin) return false;
    if (!isNaN(durMax) && adv.durMax.value !== '' && (r.duration_seconds || 0) > durMax) return false;
    if (adv.cellId.value && !(r.cell_id || '').toLowerCase().includes(adv.cellId.value.toLowerCase())) return false;
    if (adv.imei.value && !(r.imei || '').toLowerCase().includes(adv.imei.value.toLowerCase())) return false;
    if (adv.imsi.value && !(r.imsi || '').toLowerCase().includes(adv.imsi.value.toLowerCase())) return false;
    if (adv.jumpsOnly.checked && !r.is_anomalous_jump) return false;
    if (adv.nightOnly.checked && !isNightHour(r.timestamp)) return false;
    if (adv.deviceChange.checked && !deviceChangeIds.has(r.id)) return false;
    if (adv.operatorHandoff.checked && !operatorHandoffIds.has(r.id)) return false;
    return true;
  }

  function filtered() {
    return allRecords.filter(r => matchesTypeFilter(r) && matchesSearch(r) && matchesAdvanced(r));
  }

  function render() {
    const rows = filtered();
    const geo = rows.filter(r => r.latitude && r.longitude);
    const dist = actualTrailDistance(geo).toFixed(1);
    summary.innerHTML = `
      Showing <b>${rows.length}</b> of ${allRecords.length} events
      · Trail <b>${dist} km</b> (excl. jumps)
      · ${rows.filter(r => r.is_anomalous_jump).length} jumps
      · ${rows.filter(r => deviceChangeIds.has(r.id)).length} device changes
      · ${rows.filter(r => operatorHandoffIds.has(r.id)).length} operator handoffs`;

    tbody.innerHTML = rows.map(r => `<tr class="evt-row ${r.is_anomalous_jump ? 'row-jump' : ''} ${deviceChangeIds.has(r.id) ? 'row-device' : ''}" data-id="${r.id}">
      <td class="mono">${(r.trail_index ?? 0) + 1}</td>
      <td>${eventBadgeHtml(r)}</td>
      <td class="mono">${fmtDateTime(r.timestamp)}</td>
      <td class="mono">${contactLabel(r)}</td>
      <td>${fmtDuration(r.duration_seconds)}</td>
      <td>${locationLabel(r)}</td>
      <td class="mono">${r.cell_id || '—'}</td>
      <td>${r.is_anomalous_jump ? '—' : (r.distance_from_prev_km != null ? r.distance_from_prev_km + ' km' : '—')}</td>
      <td>${r.speed_from_prev_kmh != null ? r.speed_from_prev_kmh + ' km/h' : '—'}</td>
      <td>${r.dwell_minutes_after != null ? r.dwell_minutes_after + ' min' : '—'}</td>
      <td><button class="btn-link-detail" data-id="${r.id}">Details →</button></td>
    </tr>`).join('');

    tbody.querySelectorAll('.btn-link-detail, .evt-row').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        if (id) openEventDetail(CASE_ID, id);
      });
    });
  }

  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.dataset.filter;
      render();
    });
    if (chip.dataset.filter === INITIAL_FILTER) {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    }
  });

  searchInput.addEventListener('input', () => { searchQuery = searchInput.value.trim(); render(); });
  Object.values(adv).forEach(el => el.addEventListener('input', render));
  Object.values(adv).forEach(el => el.addEventListener('change', render));

  document.getElementById('adv-reset').addEventListener('click', () => {
    if (data.overview.first_seen) adv.dateFrom.value = data.overview.first_seen.slice(0, 10);
    if (data.overview.last_seen) adv.dateTo.value = data.overview.last_seen.slice(0, 10);
    adv.timeFrom.value = '00:00';
    adv.timeTo.value = '23:59';
    adv.durMin.value = '';
    adv.durMax.value = '';
    adv.cellId.value = '';
    adv.imei.value = '';
    adv.imsi.value = '';
    adv.jumpsOnly.checked = false;
    adv.nightOnly.checked = false;
    adv.deviceChange.checked = false;
    adv.operatorHandoff.checked = false;
    render();
  });

  render();
}

initEventsPage();

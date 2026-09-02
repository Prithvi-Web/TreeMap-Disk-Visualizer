/* ───────────────────────────── Trends view ───────────────────────────── */
async function loadTrends() {
  try {
    const { roots } = await api('/api/snapshots');
    state.trends.roots = roots;
    const sel = $('trendRoot');
    if (!roots.length) {
      sel.innerHTML = '<option>No history yet</option>';
      sel.disabled = true;
      $('trendInfo').textContent = '';
      state.trends.snapshots = [];
      drawTrendChart();
      drawTrendNet();
      $('trendDeltas').innerHTML = '<div class="muted">Finish a scan and history starts building automatically — every scan saves a snapshot.</div>';
      return;
    }
    sel.disabled = false;
    const has = (p) => roots.some(r => r.rootPath === p);
    const preferred = (state.root && has(state.root.path) && state.root.path) ||
                      (state.trends.path && has(state.trends.path) && state.trends.path) ||
                      roots[0].rootPath;
    sel.innerHTML = roots.map(r =>
      `<option value="${escapeHtml(r.rootPath)}"${r.rootPath === preferred ? ' selected' : ''}>${escapeHtml(r.rootPath)} · ${r.count} snapshot${r.count > 1 ? 's' : ''}</option>`).join('');
    state.trends.path = preferred;
    await loadTrendData();
  } catch (e) { toast('Could not load history: ' + e.message, 'error'); }
}

/* The tmLoadSeq pattern: the forecast suffix appends with +=, so two
   overlapped loads for the SAME path would both land and duplicate it —
   only the latest load's callback may touch the label. */
let trendInfoSeq = 0;
async function loadTrendData() {
  const seq = ++trendInfoSeq;
  // FX: the bklit loading veil covers the chart only while its snapshots
  // are genuinely in flight — the finally holds on the error path too.
  const chartWrap = $('trendChart').parentElement;
  chartWrap.classList.add('fx-chart-loading');
  let snapshots;
  try {
    ({ snapshots } = await api('/api/snapshots?path=' + encodeURIComponent(state.trends.path)));
  } finally {
    chartWrap.classList.remove('fx-chart-loading');
  }
  state.trends.snapshots = snapshots;
  // A new root's growth rate is unknown until the server answers, and unknown
  // never projects — the dashed tail is a claim, not a default.
  state.trends.forecastRate = null;
  drawTrendNet();
  $('trendInfo').textContent = snapshots.length
    ? `latest: ${formatBytes(snapshots[snapshots.length - 1].totalSize)} · ${formatCount(snapshots[snapshots.length - 1].fileCount)} files`
    : '';
  drawTrendChart();
  renderTrendDeltas();
  // The dashed line and the breach date beside it are now the same claim: both
  // ride the server's own growth rate, which refuses to guess when the history
  // is thin, erratic, flat or shrinking. Fetched after the paint, because the
  // snapshots are the substance and this is the sentence about them.
  if (snapshots.length) void labelTrendForecast(state.trends.path, seq);
}
async function labelTrendForecast(path, seq) {
  let f;
  try { f = await api('/api/forecast?path=' + encodeURIComponent(path)); }
  catch { return; }
  if (seq !== trendInfoSeq || state.trends.path !== path) return; // a newer load owns the view
  // The chart's dashed tail rides this same answer AND this same rate — one
  // number, so the line and the date can never tell different stories — and a
  // changed rate is a changed slope, so it repaints before anything else.
  const ok = f.status === 'ok';
  const rate = ok && Number.isFinite(f.bytesPerDay) ? f.bytesPerDay : null;
  if (state.trends.forecastRate !== rate) { state.trends.forecastRate = rate; drawTrendChart(); }
  if (!ok || !f.fullInDays) return;
  const days = Math.max(1, Math.round(f.fullInDays));
  if (days >= 365) return; // a year+ out is noise, same bar as the dashboard banner
  // Same basis rule as the dashboard banner: a folder's slope names the
  // folder, because growth elsewhere on the disk was not measured.
  const when = formatDate(Date.now() + days * 864e5);
  const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
  $('trendInfo').textContent += f.basis === 'volume'
    ? ` · at current growth, disk full ~${when}`
    : ` · at ${name}’s growth, the disk it lives on is full ~${when}`;
}
$('trendRoot').addEventListener('change', (e) => {
  state.trends.path = e.target.value;
  loadTrendData().catch(err => toast(err.message, 'error'));
});

/**
 * The dashed forecast tail, or null.
 *
 * `rate` is the server's own growth rate in bytes per day — the recency-
 * weighted fit (7-day half-life) that the "disk full ~date" printed beside
 * this chart and the dashboard's "+X/day" are both computed from. Drawing the
 * tail from that one number is what stops the line and the date disagreeing;
 * a second fit here, however reasonable, is a second answer to one question.
 *
 * null means the server declined to name a rate — too little history, too
 * erratic, flat, or shrinking — and a claim the rest of the app is refusing is
 * a claim this chart does not draw. Zero and negative are refused for the same
 * reason: 'stable' and 'shrinking' are the server's words for them, and both
 * come with "no fill-up in sight" beside a line that would say otherwise.
 *
 * The horizon is bounded by what was actually observed as well as by an
 * absolute month. A flat 30-day tail off an hour of history put the real
 * series inside 0.05% of the plot and read as an empty chart; half the
 * observed span keeps real data on at least two thirds of the domain at
 * every history length.
 */
function trendProjection(pts, rate) {
  const MAX_MS = 30 * 864e5;      // a month is as far as this rate is worth reading
  const SPAN_FRACTION = 0.5;      // → real data holds ≥ 2/3 of the x-domain
  // Not-positive catches null, undefined, NaN, zero and shrinking in one test.
  if (!(rate > 0) || pts.length < 3) return null;
  const last = pts[pts.length - 1];
  const span = last.t - pts[0].t;
  if (!(span > 0)) return null;   // no elapsed time, no horizon to reach for
  const reach = Math.min(MAX_MS, span * SPAN_FRACTION);
  return { name: 'Forecast', points: [
    { t: last.t, v: last.v },
    { t: last.t + reach, v: last.v + rate * (reach / 864e5) },
  ] };
}

/* FxCharts.area owns the surface: dotted grid, formatBytes ticks, gradient
   fill, monotone stroke, crosshair+tooltip, resize (its own observer — no
   window resize listener needed) and the REDUCED-checked draw-in. This
   function only shapes the spec: the snapshot series, plus the gated,
   history-bounded projection above. */
let trendHandle = null;
function drawTrendChart() {
  const snaps = state.trends.snapshots;
  const pts = snaps.map(s => ({ t: s.takenAt, v: s.totalSize }));
  const projection = trendProjection(pts, state.trends.forecastRate);
  // The budget the dashboard already fetched for this root, as the bklit
  // reference band: over-budget territory is tinted from the ceiling up, so
  // a line entering the band is a line crossing its budget. No budget (or
  // no scan yet) means no band — never a fabricated ceiling.
  const budget = budgetFor(state.trends.path);
  // The edge dissolve suits a series whose ink spans the plot. A young
  // history squeezed against the projection tail would dissolve entirely
  // inside the left fade zone — real data must never lose to a decoration —
  // so the fade waits until the history holds its own fifth of the domain.
  const span = pts.length > 1 ? pts[pts.length - 1].t - pts[0].t : 0;
  const domain = projection ? projection.points[1].t - pts[0].t : span;
  const spec = {
    series: pts.length ? [{ name: 'Total size', points: pts }] : [],
    projection, height: 300,
    fadeEdges: span > 0 && span >= domain * 0.2,
    pattern: 'dots',
    brush: pts.length > 1 ? {} : null,
    referenceBand: budget && budget.maxBytes > 0
      ? { from: budget.maxBytes, to: Infinity, label: `Budget ${formatBytes(budget.maxBytes)}` }
      : null,
  };
  if (trendHandle) trendHandle.update(spec);
  else trendHandle = FxCharts.area($('trendChart'), spec);
}

/** Net change between consecutive snapshots — the deltas the profit line
    draws, derived from the SAME series the area chart plots. */
function trendNetPoints(snaps) {
  return snaps.slice(1).map((s, i) => ({ t: s.takenAt, v: s.totalSize - snaps[i].totalSize }));
}

/* The compact net-change strip above the deltas: sign-split at zero, accent
   above, slate below (FxCharts.profitLine). Three snapshots make two honest
   deltas; fewer make none, so the strip hides instead of padding. */
let trendNetHandle = null;
function drawTrendNet() {
  const snaps = state.trends.snapshots;
  const wrap = $('trendNet');
  if (snaps.length < 3) {
    wrap.hidden = true;
    if (trendNetHandle) { trendNetHandle.destroy(); trendNetHandle = null; }
    return;
  }
  wrap.hidden = false;
  const spec = { points: trendNetPoints(snaps), height: 120, posName: 'Grew', negName: 'Freed' };
  if (trendNetHandle) trendNetHandle.update(spec);
  else trendNetHandle = FxCharts.profitLine($('trendNetChart'), spec);
}

async function renderTrendDeltas() {
  const host = $('trendDeltas');
  const snaps = state.trends.snapshots;
  if (snaps.length < 2) {
    host.innerHTML = '<div class="muted">Scan this folder again later — what grew or shrank will show up here.</div>';
    return;
  }
  const a = snaps[snaps.length - 2], b = snaps[snaps.length - 1];
  try {
    const diff = await api(`/api/snapshots/compare?a=${a.id}&b=${b.id}`);
    const up = diff.totalDelta >= 0;
    const head = `<div class="muted" style="margin-bottom:10px;" >${formatDate(a.takenAt)} → ${formatDate(b.takenAt)} — total ${up ? 'grew' : 'shrank'} by
      <b class="num" style="color:${up ? '#ff6b61' : 'var(--ok)'}">${formatBytes(Math.abs(diff.totalDelta))}</b></div>`;
    if (!diff.entries.length) { host.innerHTML = head + '<div class="muted">No top-level changes between the last two snapshots.</div>'; return; }
    const maxD = Math.abs(diff.entries[0].delta) || 1;
    // Keyed by root path: the same folder's next comparison rolls whatever
    // digits survived in place; a different root snaps.
    FxNum.rollHtml(host, head + diff.entries.slice(0, 12).map(en => deltaRow(en, maxD)).join(''), state.trends.path);
    fxBarsIn(host); // the diverging bars ride the kit's width-in
  } catch (e) {
    host.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
  }
}

/** Shared red/green delta row (Trends + Compare). */
function deltaRow(en, maxD, opts = {}) {
  const up = en.delta > 0;
  const removed = en.sizeB === null;
  const label = en.sizeA === null ? 'new' : removed ? 'removed' : up ? 'grew' : 'shrank';
  const ext = en.type === 'file' ? (en.name.split('.').pop() || '').toLowerCase() : undefined;
  // B4: only a *removed* row has anything to recover, so only it gets the
  // action. Offering "check snapshots" beside a file that is still on disk
  // would be noise on every other row.
  const recover = removed && opts.offerSnapshots
    ? `<button class="pill" data-snap-check="${escapeHtml(en.path)}" title="Look for this in the system's own filesystem snapshots">Check snapshots</button>`
    : '';
  return `
    <div class="delta-row" title="${escapeHtml(en.path)}" data-row-path="${escapeHtml(en.path)}">
      ${chipFor({ type: en.type, extension: ext }, 13)}
      <div class="meta"><div class="nm">${escapeHtml(en.name)} <span class="muted">· ${label}</span></div></div>
      <div class="bar-track dv"><div class="fx-bar-fill ${up ? 'up' : 'down'}" data-w="${Math.max(4, (Math.abs(en.delta) / maxD) * 50).toFixed(1)}"></div></div>
      <span class="delta-badge num ${up ? 'up' : 'down'}">${up ? '+' : '−'}${formatBytes(Math.abs(en.delta))}</span>
      ${recover}
    </div>`;
}

/* ── Snapshot recovery from a Compare row (B4) ──
   The Trash covers "I deleted that and changed my mind". This covers "that
   went missing weeks ago and the Trash is long empty" — the OS has probably
   been keeping filesystem snapshots the whole time.

   Looking costs nothing and asks for nothing on every platform. Reading a
   snapshot needs an administrator password on macOS and Windows, so that is
   requested only when the user actually asks to recover, and the panel says so
   before they commit to anything.                                            */

async function checkSnapshotsFor(targetPath, rowEl) {
  let host = rowEl.nextElementSibling;
  if (!host || !host.classList.contains('snap-find')) {
    host = document.createElement('div');
    host.className = 'snap-find';
    rowEl.after(host);
  }
  host.innerHTML = `<div class="muted">${icon('loader', 13)} Looking through this system's snapshots…</div>`;

  let result;
  try {
    result = await api('/api/system/snapshots/find-deleted?path=' + encodeURIComponent(targetPath));
  } catch (e) {
    host.innerHTML = `<div class="snap-msg">${escapeHtml(e.message)}</div>` +
      `<button class="pill" data-snap-check="${escapeHtml(targetPath)}">Try again</button>`;
    wireSnapshotActions(host);
    return;
  }

  if (result.stillPresent) {
    host.innerHTML = `<div class="snap-msg">${icon('checkCircle', 13)} That path is still on this disk — nothing to recover.</div>`;
    return;
  }

  const usable = result.candidates.filter(c => c.state !== 'absent');

  // Capability unavailable (§3.5 #5) — the specific reason, not a blank.
  //
  // The emptiness test is on `usable`, not on `candidates`, because those two
  // are not the same question. A system that can read its own snapshots looks
  // inside every one of them and reports each as 'present' or 'absent', so a
  // file created and deleted between two snapshots comes back as a *full*
  // candidate list in which nothing is recoverable — and `findDeleted` phrases
  // that case for a reader ("Checked N snapshots — none of them contain that
  // path."). Testing `candidates.length` here let that answer walk on into
  // `usable[0].snapshot`, which is undefined: a legitimate reply reached the
  // user as a TypeError and a blank panel.
  if (!usable.length) {
    host.innerHTML = `<div class="snap-msg">${icon('alert', 13)} ${escapeHtml(result.reason || 'No snapshots on this system contain that path.')}</div>`;
    return;
  }

  const newest = usable[0];
  const when = newest.snapshot.takenAt ? formatDate(newest.snapshot.takenAt) : 'an unknown date';
  // The distinction that keeps this honest: on Linux we looked inside and know;
  // on macOS/Windows we know a snapshot exists and nothing more until authorized.
  const headline = result.confirmed
    ? `${icon('checkCircle', 13)} Found in ${formatCount(usable.length)} snapshot${usable.length === 1 ? '' : 's'} — newest from ${escapeHtml(when)}` +
      (newest.sizeBytes !== null ? ` <span class="num">(${formatBytes(newest.sizeBytes)})</span>` : '')
    : `${icon('clock', 13)} ${formatCount(usable.length)} snapshot${usable.length === 1 ? ' covers' : 's cover'} this period — newest from ${escapeHtml(when)}. ` +
      `Checking inside one needs your administrator password.`;

  host.innerHTML =
    `<div class="snap-msg">${headline}</div>` +
    `<div class="snap-actions">` +
      `<button class="btn btn-primary" data-snap-restore="${escapeHtml(targetPath)}">${icon('refresh', 13)}Recover it</button>` +
      `<span class="muted">Written beside the original — never over anything that's there now.</span>` +
    `</div>`;
  wireSnapshotActions(host);
}

async function restoreFromSnapshot(targetPath, host) {
  const actions = host.querySelector('.snap-actions');
  if (actions) actions.innerHTML = `<div class="muted">${icon('loader', 13)} Recovering…</div>`;
  try {
    const out = await api('/api/system/snapshots/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: targetPath }),
    });
    host.innerHTML =
      `<div class="snap-msg">${icon('checkCircle', 13)} Recovered <b>${formatBytes(out.sizeBytes)}</b> to ` +
      `<span class="pth">${escapeHtml(out.restoredTo)}</span></div>` +
      `<div class="snap-actions"><button class="pill" data-snap-reveal="${escapeHtml(out.restoredTo)}">Show me</button></div>`;
    wireSnapshotActions(host);
    toast('Recovered from a system snapshot');
  } catch (e) {
    // A dismissed password prompt is an answer, not a fault — shown neutrally.
    const declined = e.code === 'AUTHORIZATION_DECLINED';
    host.innerHTML =
      `<div class="snap-msg">${icon(declined ? 'clock' : 'alert', 13)} ${escapeHtml(e.message)}</div>` +
      `<div class="snap-actions"><button class="pill" data-snap-restore="${escapeHtml(targetPath)}">Try again</button></div>`;
    wireSnapshotActions(host);
  }
}

function wireSnapshotActions(scope) {
  scope.querySelectorAll('[data-snap-check]').forEach(b => b.addEventListener('click', () => {
    const row = b.closest('.snap-find')?.previousElementSibling || b.closest('.delta-row');
    checkSnapshotsFor(b.dataset.snapCheck, row);
  }));
  scope.querySelectorAll('[data-snap-restore]').forEach(b =>
    b.addEventListener('click', () => restoreFromSnapshot(b.dataset.snapRestore, b.closest('.snap-find'))));
  scope.querySelectorAll('[data-snap-reveal]').forEach(b =>
    b.addEventListener('click', () => api('/api/files/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: b.dataset.snapReveal, reveal: true }),
    }).catch(err => toast(err.message, 'error'))));
}

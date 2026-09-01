/* ───────────────────────────── Disk topology (A5) ─────────────────────────────
   Physical disks with the volumes on each, and a per-disk usage bar.

   Two numbers per volume, deliberately distinct: sizeBytes is the capacity
   *ceiling* — shared by every volume in an APFS container or storage pool, so
   it is never summed here — while usedBytes is the volume's own consumption,
   the only figure that may be added up. The bar divides summed usage by the
   disk's real size; a volume whose usage the platform cannot report is counted
   as unknown and said out loud, never treated as zero (§2.2).               */

let topologyLoading = false;

/* Two cards want the same disk layout on one dashboard paint: this one draws
   it, and Drive Health reads a device name out of it. Reading it spawns
   diskutil/lsblk — measured at ~90ms, and the boot timeline showed the two
   cards asking 160ms apart — so the second read spent a child process and a
   token of the strict rate limit on an answer already in hand.

   This shares an answer; it does not cache one. The window is one paint, the
   re-check and refresh controls pass `force` because looking again is the
   whole point of them, and a failure is dropped so the next caller retries for
   real rather than inheriting someone else's error. */
const TOPOLOGY_SHARE_MS = 3000;
let topologyShared = null;
function topologyAnswer(force) {
  const now = Date.now();
  if (!force && topologyShared && now - topologyShared.at < TOPOLOGY_SHARE_MS) return topologyShared.promise;
  const shared = { at: now, promise: api('/api/platform/topology') };
  topologyShared = shared;
  shared.promise.catch(() => { if (topologyShared === shared) topologyShared = null; });
  return shared.promise;
}

async function loadTopology() {
  const body = $('topologyBody');
  if (!body || topologyLoading) return;

  // When the capability answer is already on hand, render the honest
  // unavailable state without a doomed request. Capabilities unknown → ask
  // anyway; the server answers 409 with the same human-readable reason.
  const cap = state.capabilities && state.capabilities.volumeTopology;
  if (cap && !cap.available) { renderTopologyBlocked(cap.reason); return; }

  topologyLoading = true;
  // Loading state (§3.5) — but not on a refresh, where blanking a populated
  // card for half a second would read as data vanishing. A refresh sweeps
  // the standing rows with the loading veil instead; every painter settles it.
  if (!body.querySelector('.topo-disk')) {
    body.innerHTML = skeletonRows(3, 30, 'Reading disk layout…');
  } else {
    body.classList.add('fx-chart-loading');
  }
  try {
    // Always a fresh read: every control that reaches this function — refresh,
    // retry, a capability re-probe — means "look again".
    const topo = await topologyAnswer(true);
    renderTopology(topo);
  } catch (err) {
    if (err.capabilityUnavailable) renderTopologyBlocked(err.message);
    else renderTopologyError(err);
  } finally {
    topologyLoading = false;
  }
}

/** Unavailable (§3.5 state 5): the specific reason, shown as an answer, not an error. */
function renderTopologyBlocked(reason) {
  $('topologyBody').classList.remove('fx-chart-loading');
  $('topologyBody').innerHTML =
    `<div class="muted" style="display:flex;gap:8px;align-items:flex-start;padding:4px 2px;">${icon('alert', 14)}` +
    `<span style="line-height:1.5;">${escapeHtml(reason || 'Disk layout is not available on this computer.')}</span></div>` +
    `<button class="pill topo-more" data-topo-recheck="1" title="Probe again — after installing the missing tool or granting access">Check again</button>`;
  wireTopologyActions();
}

/** Error (§3.5 state 6): the envelope's message, with a retry. */
function renderTopologyError(err) {
  $('topologyBody').classList.remove('fx-chart-loading');
  $('topologyBody').innerHTML =
    `<div class="muted" style="padding:4px 2px;">Couldn’t read the disk layout: ${escapeHtml(err.message || 'something went wrong.')}</div>` +
    `<button class="pill topo-more" data-topo-retry="1">Try again</button>`;
  wireTopologyActions();
}

/** How many volume rows a disk shows before the rest fold behind "show more". */
const TOPO_VISIBLE_VOLUMES = 4;

function renderTopology(topo) {
  const body = $('topologyBody');
  body.classList.remove('fx-chart-loading'); // every paint settles the veil
  const disks = topo.physicalDisks || [];
  const volumes = topo.logicalVolumes || [];

  if (!disks.length && !volumes.length) {
    // Empty (§3.5 state 1) — genuinely nothing visible, with the fix at hand.
    body.innerHTML =
      `<div class="muted" style="padding:4px 2px;">No disks are visible right now.</div>` +
      `<button class="pill topo-more" data-topo-retry="1">Look again</button>`;
    wireTopologyActions();
    return;
  }

  // Volumes grouped by the exact set of disks behind them: a plain volume
  // joins its one disk's section; a RAID/pool volume spanning several disks
  // forms a combined section, because splitting its bytes per member would be
  // a made-up number (the resiliency layout decides, not arithmetic).
  const groups = new Map();
  for (const v of volumes) {
    const ids = (v.physicalDiskIds || []).slice().sort();
    const key = ids.length ? ids.join('|') : `un:${v.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }

  const labelOf = (id) => {
    const d = disks.find((x) => x.id === id);
    return (d && d.name) || id;
  };

  const sections = [];
  for (const d of disks) {
    sections.push(topoSection({
      title: d.name || d.id,
      tag: d.rotational === true ? 'HDD' : d.rotational === false ? 'SSD' : null,
      capacity: d.sizeBytes,
      vols: groups.get(d.id) || [],
    }, sections.length));
  }
  for (const [key, vols] of groups) {
    if (!key.includes('|')) continue;
    sections.push(topoSection({
      title: key.split('|').map(labelOf).join(' + '),
      tag: 'POOL',
      // A pool's ceiling is what it provisions, not the sum of raw disks —
      // a mirror of two 1TB drives holds 1TB, not 2.
      capacity: vols.reduce((s, v) => s + (v.sizeBytes || 0), 0) || null,
      vols,
    }, sections.length));
  }
  for (const [key, vols] of groups) {
    if (!key.startsWith('un:')) continue;
    for (const v of vols) {
      sections.push(topoSection({ title: v.name || v.id, tag: (v.kind || '').toUpperCase() || null, capacity: v.sizeBytes, vols: [v] }, sections.length));
    }
  }

  const note = topo.capability && topo.capability.degradedTo && topo.capability.reason
    ? `<div class="topo-note" style="margin-top:6px;">${escapeHtml(topo.capability.reason)}</div>`
    : '';
  // Same machine, fresh reading → the numerals roll in place; the ramp bars
  // ride the kit's REDUCED-aware width-in through the shared entry.
  FxNum.rollHtml(body, sections.join('') + note, 'topo');
  fxBarsIn(body);
  wireTopologyActions();
}

function topoSection({ title, tag, capacity, vols }, rank = 0) {
  const known = vols.filter((v) => typeof v.usedBytes === 'number');
  const unknown = vols.length - known.length;
  const used = known.reduce((s, v) => s + v.usedBytes, 0);
  const pct = capacity > 0 && known.length ? Math.min(100, (used / capacity) * 100) : null;

  let sub = '';
  if (known.length && capacity > 0) sub = `${formatBytes(used)} of ${formatBytes(capacity)}`;
  else if (capacity > 0) sub = formatBytes(capacity);

  // The kit's ramp gradient by section rank; a disk past 85% keeps the one
  // honest exception — solid danger, the same signal the old bar carried.
  const bar = pct === null ? '' :
    `<div class="topo-track"><div class="fx-bar-fill" data-w="${Math.max(2, pct).toFixed(1)}" style="${pct > 85 ? 'background:var(--danger);' : fxBarStyle(rank)}"></div></div>`;
  // Usage the platform could not read is said out loud — an absent number is
  // an answer here, a bar quietly missing those bytes would be a wrong one.
  const caveat = !vols.length
    ? `<div class="topo-note">No volumes on this disk.</div>`
    : !known.length
      ? `<div class="topo-note">This disk’s filesystems don’t report how full they are.</div>`
      : unknown > 0
        ? `<div class="topo-note">Bar excludes ${unknown} volume${unknown === 1 ? '' : 's'} that couldn’t be read.</div>`
        : '';

  // Biggest first, unknowns last — attention proportional to bytes.
  const ordered = [...vols].sort((a, b) => (b.usedBytes ?? -1) - (a.usedBytes ?? -1));
  const rows = ordered.map((v, i) => {
    const nm = v.name || v.id;
    const mount = v.mountPoint ? escapeHtml(v.mountPoint) : 'not mounted';
    const sz = typeof v.usedBytes === 'number' ? formatBytes(v.usedBytes) : '–';
    // Free space only when the platform reported both sides — a free figure
    // subtracted from an unknown ceiling would be a made-up number.
    const free = typeof v.usedBytes === 'number' && typeof v.sizeBytes === 'number' && v.sizeBytes >= v.usedBytes
      ? `<span class="free num" title="Space still free on this volume">${formatBytes(v.sizeBytes - v.usedBytes)} free</span>`
      : '';
    return `<div class="topo-vol"${i >= TOPO_VISIBLE_VOLUMES ? ' hidden' : ''}>` +
      `<span class="nm" title="${escapeHtml(nm)}">${escapeHtml(nm)}</span>` +
      `<span class="pth" title="${mount}">${mount}</span>` +
      free +
      `<b class="sz num" title="Space this volume itself takes up">${sz}</b></div>`;
  }).join('');

  const foldedCount = Math.max(0, ordered.length - TOPO_VISIBLE_VOLUMES);
  const folded = ordered.slice(TOPO_VISIBLE_VOLUMES);
  const foldedUsed = folded.reduce((s, v) => s + (typeof v.usedBytes === 'number' ? v.usedBytes : 0), 0);
  const more = foldedCount
    ? `<button class="pill topo-more" data-topo-toggle="1" data-more="Show ${foldedCount} more · ${formatBytes(foldedUsed)}" data-less="Show fewer" aria-expanded="false">Show ${foldedCount} more · ${formatBytes(foldedUsed)}</button>`
    : '';

  return `<div class="topo-disk">` +
    `<div class="topo-head"><span class="nm" title="${escapeHtml(title)}">${escapeHtml(title)}</span>` +
    (tag ? `<span class="topo-tag">${escapeHtml(tag)}</span>` : '') +
    (sub ? `<span class="sub num">${sub}</span>` : '') +
    `</div>${bar}${caveat}${rows}${more}</div>`;
}

function wireTopologyActions() {
  const body = $('topologyBody');
  body.querySelectorAll('[data-topo-retry]').forEach((b) => b.addEventListener('click', () => loadTopology()));
  body.querySelectorAll('[data-topo-recheck]').forEach((b) => b.addEventListener('click', async () => {
    // Availability may have changed at a moment the 30s cache didn't see —
    // a tool installed, access granted (§3.8) — so re-probe, then re-render.
    b.disabled = true;
    try {
      const res = await api('/api/platform/capabilities/refresh', { method: 'POST' });
      state.capabilities = res.capabilities || null;
      emit(TOPIC.capabilities, state.capabilities);
    } catch (err) {
      reportError(err, 'Couldn’t re-check');
      b.disabled = false;
    }
  }));
  body.querySelectorAll('[data-topo-toggle]').forEach((b) => b.addEventListener('click', () => {
    const open = b.getAttribute('aria-expanded') === 'true';
    b.closest('.topo-disk').querySelectorAll('.topo-vol').forEach((row, i) => {
      if (i >= TOPO_VISIBLE_VOLUMES) row.hidden = open;
    });
    b.setAttribute('aria-expanded', String(!open));
    b.textContent = open ? b.dataset.more : b.dataset.less;
  }));
}

$('topologyRefresh').addEventListener('click', () => loadTopology());
// Repaints when the capability answer lands or changes; the card never sits
// on its skeleton waiting for a poke from another view.
subscribe(TOPIC.capabilities, () => loadTopology());

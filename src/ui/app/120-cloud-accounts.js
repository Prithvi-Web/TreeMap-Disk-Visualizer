/* ───────────────────────────── Cloud accounts (Feature 25) ───────────────────────────── */
function isCloudScan() { return !!state.root && state.root.path.startsWith('cloud://'); }
function cloudProviderOfScan() {
  const p = state.cloud.providers.find(pr => state.root && state.root.path === 'cloud://' + pr.id);
  return p || { id: (state.root?.path || '').replace('cloud://', ''), name: 'cloud', trashLabel: 'the provider’s trash' };
}

/** Local-only unless an account is connected — the phase's feature flag. */
async function loadCloudStatus() {
  try {
    const data = await api('/api/cloud/status');
    state.cloud.providers = data.providers || [];
    state.cloud.loaded = true;
  } catch { state.cloud.providers = []; }
  renderAllStorage();
}

/* The kit's barSquares language laid flat, rendered inline because these
   rows carry Scan buttons the component cannot host (the .bigfile hybrid
   recipe). Used bytes light discrete ramp squares; free capacity stays
   visible as ghosts — a shape, not an absence. No total means no strip:
   squares against an unknown ceiling would be a made-up picture. */
const ASQ_SQUARES = 12;
let allStorageEntered = false; // the cascade plays once, not on every repaint
function asqStrip(used, total, rowIdx) {
  if (!(total > 0)) return '';
  const lit = FxCharts.math.squareStack(used, total, ASQ_SQUARES);
  const danger = used / total > 0.85; // the same threshold the old bar spoke
  const enter = !allStorageEntered && !REDUCED && !document.hidden;
  let out = '';
  for (let i = 0; i < ASQ_SQUARES; i++) {
    const isLit = i < lit;
    const style = isLit
      ? ` style="background:${danger ? 'var(--danger)' : FxCharts.math.sampleRamp(ASQ_SQUARES > 1 ? i / (ASQ_SQUARES - 1) : 0)};${enter ? `transition-delay:${rowIdx * 60 + i * 35}ms;` : ''}"`
      : '';
    out += `<span class="fx-bsq-sq${isLit ? '' : ' fx-bsq-ghost'}${isLit && enter ? ' fx-bsq-pre' : ''}"${style}></span>`;
  }
  return `<span class="asq" aria-hidden="true">${out}</span>`;
}

function renderAllStorage() {
  const host = $('allStorageList');
  if (!host) return;
  const rows = [];
  if (state.system) {
    const used = state.system.totalDisk - state.system.freeDisk;
    rows.push(`
      <div class="storage-row">
        <span class="chip" style="--tint:#0A84FF">${icon('hardDrive', 15)}</span>
        <div class="meta"><div class="nm">This Mac</div><div class="pth num">${formatBytes(used)} of ${formatBytes(state.system.totalDisk)}</div></div>
        ${asqStrip(used, state.system.totalDisk, rows.length)}
        <button class="pill" data-storage-scan-local="1">Scan</button>
      </div>`);
  }
  const connected = state.cloud.providers.filter(p => p.connected);
  for (const p of connected) {
    const q = p.quota || { used: 0, total: 0 };
    rows.push(`
      <div class="storage-row">
        <span class="chip" style="--tint:#64D2FF">${icon('cloud', 15)}</span>
        <div class="meta"><div class="nm">${escapeHtml(p.name)}</div><div class="pth num">${p.account ? escapeHtml(p.account) + ' · ' : ''}${q.total ? `${formatBytes(q.used)} of ${formatBytes(q.total)}` : formatBytes(q.used)}</div></div>
        ${asqStrip(q.used, q.total, rows.length)}
        <button class="pill" data-cloud-scan="${p.id}" data-cloud-name="${escapeHtml(p.name)}">Scan</button>
      </div>`);
  }
  if (!connected.length) {
    rows.push(`<div class="muted" style="padding:6px 2px;font-size:12px;">${icon('cloud', 13)} Connect Google Drive, Dropbox or OneDrive in Settings to see and scan them here — nothing talks to the internet until you do.</div>`);
  }

  /* A3 — how much of the folder you just scanned is not actually on this
     machine. Without this, a scan of a synced folder reports bytes the user
     cannot free by deleting anything locally, and cannot find on their disk
     either. The "This Mac" bar above comes from the operating system's own
     accounting and already excludes these, so nothing is double-counted;
     this line explains the gap between the two rather than adding to it. */
  const cloudBytes = state.scanStats ? state.scanStats.cloudBytes || 0 : 0;
  const cloudFiles = state.scanStats ? state.scanStats.cloudFiles || 0 : 0;
  if (cloudBytes > 0) {
    rows.push(`
      <div class="storage-row" style="opacity:0.9;">
        <span class="chip" style="--tint:#64D2FF">${icon('cloud', 15)}</span>
        <div class="meta">
          <div class="nm">Not on this computer</div>
          <div class="pth num">${formatBytes(cloudBytes)} across ${formatCount(cloudFiles)} file${cloudFiles === 1 ? '' : 's'} in your last scan</div>
        </div>
        <div class="muted" style="font-size:11px;max-width:190px;text-align:right;line-height:1.4;">Stored online — counted in the folder's size, but taking no space here.</div>
      </div>`);
  }

  // Same machine, fresh numbers → the numerals roll in place; a provider
  // connecting changes the printed shape, which FxNum snaps on.
  FxNum.rollHtml(host, rows.join(''), 'storage');
  // Release the one-time cascade: pre-scaled squares ride the kit's own
  // transition on the next frame (the barSquares entrance, laid flat).
  if (host.querySelector('.fx-bsq-pre')) {
    requestAnimationFrame(() => {
      for (const sq of host.querySelectorAll('.fx-bsq-pre')) sq.classList.remove('fx-bsq-pre');
    });
  }
  if (host.querySelector('.asq')) allStorageEntered = true;
  host.querySelectorAll('[data-cloud-scan]').forEach(b =>
    b.addEventListener('click', () => startCloudScan(b.dataset.cloudScan, b.dataset.cloudName)));
  host.querySelectorAll('[data-storage-scan-local]').forEach(b =>
    b.addEventListener('click', () => { if (state.system) startScan(state.system.homeDir); }));
}

/** Provider-trash for cloud scans (mirrors the local trash-only rule). */
async function cloudTrashPaths(paths) {
  try {
    // Chunked for the same reason as trashPaths: the API bounds a request at
    // 500 paths, but the user's selection is unbounded.
    const result = { deleted: [], failed: [] };
    for (let i = 0; i < paths.length; i += TRASH_CHUNK) {
      const chunk = paths.slice(i, i + TRASH_CHUNK);
      try {
        const r = await apiPaced('/api/cloud/trash', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scanId: state.scanId, paths: chunk }),
        });
        result.deleted.push(...r.deleted);
        result.failed.push(...r.failed);
      } catch (e) {
        for (const p of chunk) result.failed.push({ path: p, reason: e.message });
      }
    }
    // The server already removed these from its own tree and shrank every
    // ancestor (pruneNode in cloudScan.ts). This mirrors that into the tree we
    // hold so sizes stay right until the next fetch. nodeFor, not pathIndex:
    // a file trashed from a server-sourced list may have been pruned away, and
    // skipping it would leave every ancestor reading too big.
    for (const p of result.deleted) {
      const node = nodeFor(p);
      if (node) applyLiveDelta({ path: p, kind: 'deleted', size: 0, delta: -node.size });
      const parent = state.pathIndex.get(p.slice(0, p.lastIndexOf('/')));
      if (parent && parent.children) parent.children = parent.children.filter(c => c.path !== p);
      state.pathIndex.delete(p);
      state.nodeCache.delete(p);
    }
    const provider = cloudProviderOfScan();
    if (result.deleted.length) toast(`Moved ${result.deleted.length} item${result.deleted.length === 1 ? '' : 's'} to ${provider.name}'s trash`);
    if (result.failed.length) toast(`${result.failed.length} failed: ${result.failed[0].reason}`, 'error');
    state.grid.selection.clear();
    updateSelectionBar();
    if (state.view === 'treemap') loadTreemap(state.treemap.rootPath);
    if (state.view === 'grid') renderGrid();
  } catch (e) {
    toast(e.message, 'error');
  }
}

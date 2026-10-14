/* ───────────────────────────── Offload (Feature 24) ───────────────────────────── */
const OFFLOAD_PHASE_LABEL = {
  checking: 'Checking free space…',
  copying: 'Copying…',
  verifying: 'Verifying the copy…',
  trashing: 'All copies verified — moving originals to the Trash…',
  'rolling-back': 'Undoing partial copies…',
  done: 'Done',
};
/** The job the shared progress modal is currently showing, with its cancel URL. */
let activeJob = null;

/**
 * Entry point for every "Offload…" action: pick a folder on another drive, then
 * the same dry-run manifest and shared confirm the drive dock uses — a pick
 * never moves anything bare (fourth browser pass, E01). The picker opens on a
 * connected drive, never on the disk the files are on: an offload into the
 * drive they live on frees nothing, and the server refuses it.
 */
async function startOffloadFlow(paths) {
  if (!paths.length) return;
  if (!state.scanId || !state.root) { toast('Run a scan first', 'error'); return; }
  if (paths[0].startsWith('cloud://')) { toast('Offload moves local files to another drive — it doesn’t apply to cloud scans', 'error'); return; }
  hideCtxMenu();
  let drives = [];
  try {
    drives = (await api('/api/volumes')).volumes || [];
  } catch {
    drives = []; // no answer: no drive is offered, and the line below says none is connected
  }
  // A drive the selection itself is on is no destination for it.
  const others = drives.filter((v) => !paths.some((p) => p === v.path || tmIsInside(p, v.path)));
  // Files on a connected drive have this computer's own disk as another
  // drive: the picker's usual start and shortcuts are then the obvious choice.
  const onADrive = others.length < drives.length;
  const why = 'an offload to the drive these files are on frees nothing, so TreeMap refuses it.';
  // The picker's button names the offload — copy, verify, then trash the
  // originals — not a scan (final review F1.7).
  openBrowse(others.length ? others[0].path : null, (dest) => offloadPicked(paths, dest), 'Offload to…', 'Offload to this folder', {
    chips: others.length || !onADrive ? others.map((v) => ({ path: v.path, name: v.name })) : undefined,
    hint: others.length || onADrive
      ? `Pick a folder on another drive: ${why}`
      : `No other drive is connected. Connect one, or type the path of a drive or network share: ${why}`,
  });
}

/** Which plan owns the shared confirm: a later plan, from the dock or the picker, takes it over. */
let offloadPlanSeq = 0;

/** A folder picked for an offload: planned by the dry run and confirmed before anything moves (E01). */
async function offloadPicked(paths, dest) {
  // The shared confirm is repainted from a clean slate (review RD3).
  resetOpenHandleWarning();
  if (activeJob) { toast('An offload is already running — let it finish first', 'error'); return; }
  const seq = ++offloadPlanSeq;
  try {
    await confirmOffloadPlan(paths, dest, lastPathSegment(dest), '', () => seq === offloadPlanSeq);
  } catch (e) {
    toast('Could not plan the offload: ' + e.message, 'error');
  }
}

/**
 * The one door every offload goes through before anything moves (E01): the
 * exact manifest from the pipeline's own dry run, behind the shared confirm,
 * and only Confirm hands the same paths and folder to runOffloadJob. The dry
 * run is where the server refuses — a folder on the files' own drive, too
 * little space, a link — so a refusal is thrown before any sheet opens.
 * `notes`: extra lines for the sheet; `isCurrent`: false once a later plan
 * owns the dialog.
 */
async function confirmOffloadPlan(paths, dest, destName, notes, isCurrent) {
  const plan = await api('/api/offload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scanId: state.scanId, paths, dest, dryRun: true }),
  });
  if (!isCurrent()) return;
  $('confirmTitle').innerHTML = icon('archive', 18) + `Offload to ${escapeHtml(destName)}?`;
  $('confirmText').innerHTML =
    `<b>${plan.fileCount}</b> file${plan.fileCount === 1 ? '' : 's'} · <b>${formatBytes(plan.bytesTotal)}</b> will be copied to ` +
    `<b>${escapeHtml(dest)}</b>, verified by reading every byte back from the destination, and only then moved to the Trash here.` +
    notes +
    `<br><span style="color:var(--text-3)">Any failure rolls back completely — nothing local is touched until every copy has verified.</span>`;
  $('confirmOk').innerHTML = icon('archive', 15) + 'Copy, verify, then trash';
  $('confirmModal').classList.add('open');
  // Only Confirm reaches the pipeline, through the same door as every other offload.
  onConfirmTrash = async () => { await runOffloadJob(paths, dest); };
}

async function runOffloadJob(paths, dest) {
  try {
    const resp = await api('/api/offload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanId: state.scanId, paths, dest }),
    });
    watchOffloadJob(resp.jobId, 'Offloading…', (ev) => {
      // Silent when a warning has already been shown. This line says the
      // originals are in the Trash, which is exactly what the warning may be
      // denying — the two appeared together, the false one last.
      if (!ev || !ev.warning) toast('Offloaded and verified — originals are in the Trash');
      // What just left the disk leaves the cart with it — a stale entry
      // would brick the next dock drop with PATH_NOT_FOUND (QA D1) — and so
      // does whatever was staged inside a folder that went (final review F1.8).
      let removedFromCart = 0;
      for (const p of [...state.cart]) {
        if (paths.some((top) => p === top || tmIsInside(p, top)) && state.cart.delete(p)) removedFromCart++;
      }
      if (removedFromCart) { saveCart(); void renderCart(); refreshCartButtons(); }
      refreshDock(); // the destination's free space just changed (QA D6)
      loadOffloadIndex();
      rescan({ unattended: true }); // the job ends when it ends, not at a click (review F2.1)
    });
  } catch (e) {
    toast(e.message, 'error');
    refreshDock(); // a failed plan often means the drive itself went away (QA D6)
  }
}

/* ── v4 §8.3 — the drive dock: a new gesture onto the proven pipeline ──
   Connected external drives sit under the Treemap and Disk City canvases,
   each showing its free space. The cart chip is the drag source (a lasso
   already stages into the cart, so "drag a selection" and "drag the cart"
   are one gesture). A drop NEVER moves anything bare: the drive is
   re-verified (drives disappear mid-drag), the exact manifest comes from the
   pipeline's own dryRun, it sits behind the shared confirm, and Confirm
   hands the same paths to the same runOffloadJob every offload uses — the
   one door, confirmOffloadPlan, that a folder picked for an offload goes
   through too (E01). */
let dockVolumes = [];
let dockSeq = 0;

async function refreshDock() {
  const seq = ++dockSeq;
  try {
    const data = await api('/api/volumes');
    if (seq !== dockSeq) return; // superseded
    dockVolumes = data.volumes || [];
  } catch {
    if (seq !== dockSeq) return; // a stale failure must not clobber a fresh answer (review RD4)
    dockVolumes = []; // no endpoint answer = no dock, never a stale one
  }
  renderDock();
}

function renderDock() {
  const rows = dockVolumes.map((v) => {
    const used = v.totalBytes != null && v.freeBytes != null && v.totalBytes > 0
      ? Math.min(1, Math.max(0, 1 - v.freeBytes / v.totalBytes)) : null;
    const free = v.freeBytes == null
      ? (v.reason || 'free space unknown')
      : `${formatBytes(v.freeBytes)} free of ${formatBytes(v.totalBytes)}`;
    return `<div class="drive-tile" data-vol="${escapeHtml(v.path)}" aria-label="Drop the cart here to offload to ${escapeHtml(v.name)} — ${escapeHtml(free)}">
      ${icon('disc', 16)}
      <div>
        <div>${escapeHtml(v.name)}</div>
        <div class="drive-free num">${escapeHtml(free)}</div>
        ${used == null ? '' : `<div class="drive-bar"><i style="width:${Math.round(used * 100)}%"></i></div>`}
      </div>
    </div>`;
  }).join('');
  for (const id of ['tmDock', 'cityDock']) {
    const el = $(id);
    if (!el) continue;
    // FX: a tile a drag-hover beam ever touched holds an FxBeam instance; the
    // rewrite below would orphan it. Detach is idempotent, so every tile goes.
    el.querySelectorAll('.drive-tile').forEach((t) => FxBeam.detach(t));
    // FX: same contract for a mid-drag liquid bend — FxGoo.detach is the
    // bend's own teardown and is idempotent on untouched tiles.
    el.querySelectorAll('.drive-tile').forEach((t) => FxGoo.detach(t));
    el.innerHTML = rows;
    el.hidden = dockVolumes.length === 0;
  }
}

async function dockDrop(volPath) {
  // The shared confirm is repainted from a clean slate — a stale open-handle
  // warning panel (and its "Delete anyway" button) must never bleed into the
  // offload dialog (review RD3).
  resetOpenHandleWarning();
  if (activeJob) { toast('An offload is already running — let it finish first', 'error'); return; }
  const all = [...state.cart];
  if (!all.length) { toast('Your cart is empty — lasso a region or stage files first', 'error'); return; }
  if (!state.scanId) { toast('Run a scan first', 'error'); return; }
  if (all.some((p) => p.startsWith('cloud://'))) {
    toast('Offload moves local files to another drive — remove the cloud items from the cart first', 'error');
    return;
  }
  // Cart entries that are not in THIS scan (already offloaded, or staged from
  // an older scan) would 404 the whole plan and brick the drop (QA D1). They
  // are skipped, said out loud below, and everything else still moves.
  const inScan = all.filter((p) => state.pathIndex.has(p));
  const staleCount = all.length - inScan.length;
  // A folder and an item staged inside it are one set of files, sent once by
  // the folder (final review F1.8): sent both, the server planned the item
  // twice — the dialog over-counted, and the job warned that an original
  // "couldn't be moved to the Trash" after its folder had taken it.
  const paths = outermostPaths(inScan);
  if (!paths.length) {
    toast('Nothing in the cart is part of this scan — rescan the folder, or clear the stale entries in Review', 'error');
    return;
  }
  const seq = ++offloadPlanSeq;
  try {
    // 1 — the drive must still be there: drives disappear mid-drag (§8.3).
    const fresh = await api('/api/volumes');
    if (seq !== offloadPlanSeq) return; // a later plan owns the dialog now
    const vol = (fresh.volumes || []).find((v) => v.path === volPath);
    if (!vol) {
      toast('That drive is no longer connected — nothing was copied', 'error');
      refreshDock();
      return;
    }
    // 2 — the exact manifest from the pipeline's own dryRun, behind the shared
    // confirm; only Confirm reaches runOffloadJob (confirmOffloadPlan).
    const notes =
      (vol.freeBytes != null ? `<br><span style="color:var(--text-3)">${formatBytes(vol.freeBytes)} free on ${escapeHtml(vol.name)}.</span>` : '') +
      (staleCount ? `<br><span style="color:var(--text-3)">${staleCount} cart entr${staleCount === 1 ? 'y is' : 'ies are'} not in this scan and will be skipped.</span>` : '');
    await confirmOffloadPlan(paths, vol.path, vol.name, notes, () => seq === offloadPlanSeq);
  } catch (e) {
    toast('Could not plan the offload: ' + e.message, 'error');
  }
}

$('cartTab').setAttribute('draggable', 'true');
$('cartTab').addEventListener('dragstart', (e) => {
  if (!state.cart.size) { e.preventDefault(); return; }
  e.dataTransfer.setData('application/x-treemap-cart', '1');
  e.dataTransfer.effectAllowed = 'copy';
});
for (const dockId of ['tmDock', 'cityDock']) {
  const dockEl = $(dockId);
  dockEl.addEventListener('dragover', (e) => {
    const tile = e.target.closest('.drive-tile');
    if (!tile || ![...e.dataTransfer.types].includes('application/x-treemap-cart')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    // FX: the drop target breathes only while the cart hovers it. Gated on
    // the class — dragover repeats every few ms, and the attach belongs to
    // the ENTER edge, not to every frame of the hover.
    if (!tile.classList.contains('drop-ok')) FxBeam.attach(tile, { type: 'md', active: true });
    tile.classList.add('drop-ok');
    // FX: the tile's liquid body arcs toward the hovering cart. bendAttach
    // is idempotent (keyed on the tile); both exit edges below release it,
    // and release tears the goo down on its own once it settles flat.
    FxGoo.bendAttach(tile);
    const tr = tile.getBoundingClientRect();
    if (tr.width > 0 && tr.height > 0) {
      FxGoo.bendPull(tile,
        ((e.clientX - tr.left) / tr.width) * 2 - 1,
        ((e.clientY - tr.top) / tr.height) * 2 - 1);
    }
  });
  dockEl.addEventListener('dragleave', (e) => {
    const tile = e.target.closest('.drive-tile');
    if (!tile) return;
    // dragleave also fires when the pointer crosses into one of the tile's
    // OWN five children, and the dragover that follows switched the ring
    // straight back on — off/on churn several times a second, each cycle
    // restarting the 0.6s fade-in and leaving a full-cost fading instance
    // behind. Neither test covers both engines: Chromium never populates
    // relatedTarget on drag events, and Firefox populates it but reports the
    // dragleave at 0,0 — so the coordinates decide where relatedTarget is
    // null, and relatedTarget decides where it is not.
    if (e.relatedTarget && tile.contains(e.relatedTarget)) return;
    const r = tile.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom) return;
    tile.classList.remove('drop-ok');
    FxBeam.attach(tile, { type: 'md', active: false });
    FxGoo.bendRelease(tile);
  });
  dockEl.addEventListener('drop', (e) => {
    const tile = e.target.closest('.drive-tile');
    // Only the cart's own payload: the window-level dragover preventDefault
    // makes the whole page a drop target, so a text selection or a Finder
    // file released here must not launch an offload confirm (QA D2).
    if (!tile || ![...e.dataTransfer.types].includes('application/x-treemap-cart')) return;
    e.preventDefault();
    tile.classList.remove('drop-ok');
    FxBeam.attach(tile, { type: 'md', active: false });
    FxGoo.bendRelease(tile);
    dockDrop(tile.dataset.vol);
  });
}

async function runRestoreJob(ids) {
  try {
    const resp = await api('/api/offload/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    watchOffloadJob(resp.jobId, 'Restoring…', (ev) => {
      if (!ev || !ev.warning) toast('Restored and verified');
      loadOffloadIndex();
    });
  } catch (e) {
    toast(e.message, 'error');
  }
}

/** Progress modal driven by the job's SSE stream. */
/**
 * Drive the shared progress modal from any copy-and-verify job's SSE stream.
 *
 * Offload and Time Capsule restore are the same shape — phases, per-file
 * progress, cooperative cancel, rollback — so they share one implementation
 * and one dialog rather than each rendering its own (§3.4). Only the URLs and
 * the wording differ, which is what `opts` carries.
 */
function watchJob(opts) {
  activeJob = { cancelUrl: opts.cancelUrl };
  $('offloadTitle').innerHTML = icon(opts.icon || 'archive', 18) + opts.title;
  $('offloadPhase').textContent = OFFLOAD_PHASE_LABEL.checking;
  $('offloadBar').style.width = '0%';
  $('offloadStats').textContent = '';
  $('offloadCurrent').textContent = '';
  $('offloadFoot').textContent = opts.footNote;
  $('offloadModal').classList.add('open');
  // FX: the md ring marks the copy-and-verify job itself — on with the modal,
  // off in closeModal's offloadModal hook, which every exit reaches: done()
  // (each terminal SSE event and a dropped stream) closes the modal there,
  // and so do the scrim and Esc. The modal is static DOM, so the off side
  // deactivates rather than detaches: the next job re-lights the instance.
  // The host is the overlay strip: .modal is lensed, and the beam and the
  // lens cannot both own ::before/::after.
  FxBeam.attach($('offloadBeamStrip'), { type: 'md', active: true });
  const es = new EventSource(opts.progressUrl);
  const done = () => { es.close(); activeJob = null; closeModal('offloadModal'); };
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'progress') {
      $('offloadPhase').textContent = OFFLOAD_PHASE_LABEL[ev.phase] || ev.phase;
      const pct = ev.bytesTotal > 0 ? (ev.bytesDone / ev.bytesTotal) * 100 : 0;
      $('offloadBar').style.width = pct.toFixed(1) + '%';
      $('offloadStats').textContent = `${formatCount(ev.filesDone)} of ${formatCount(ev.fileCount)} files · ${formatBytes(ev.bytesDone)} of ${formatBytes(ev.bytesTotal)}`;
      $('offloadCurrent').textContent = ev.currentPath;
    } else if (ev.type === 'complete') {
      done();
      // A job can finish AND have something the user must know: the originals
      // were not trashed, or the offload record could not be written. That
      // used to be carried only in a `job.error` the client never saw, so the
      // one case where files are at the destination but Restore cannot list
      // them was reported as an unqualified success.
      if (ev.warning) toast(ev.warning, 'error', 12000);
      opts.onComplete(ev);
    } else if (ev.type === 'error') {
      done();
      toast(ev.message, 'error', 8000);
      opts.onSettled();
    } else if (ev.type === 'cancelled') {
      done();
      toast(opts.cancelledMessage);
      opts.onSettled();
    } else if (ev.type === 'shutdown') {
      done();
      toast('Server shutting down — the job rolled back safely', 'error');
      opts.onSettled();
    }
  };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      done();
      toast(opts.lostMessage, 'error');
    }
  };
}

function watchOffloadJob(jobId, title, onComplete) {
  watchJob({
    title,
    icon: 'archive',
    progressUrl: `/api/offload/${jobId}/progress`,
    cancelUrl: `/api/offload/${jobId}/cancel`,
    footNote: 'Nothing is removed until every copy is verified.',
    cancelledMessage: 'Offload cancelled — everything rolled back, nothing was deleted',
    lostMessage: 'Lost the progress stream — check the Offloaded tab for the result',
    onComplete,
    onSettled: () => loadOffloadIndex(),
  });
}

$('offloadCancelBtn').addEventListener('click', () => {
  if (!activeJob) { closeModal('offloadModal'); return; }
  api(activeJob.cancelUrl, { method: 'POST' }).catch(() => {});
});
$('selOffloadBtn').addEventListener('click', () => { void startOffloadFlow([...state.grid.selection]); });
$('dupOffloadBtn').addEventListener('click', () => { void startOffloadFlow([...state.dup.selection]); });

/* ── Offloaded tab ── */
async function loadOffloadIndex() {
  try {
    state.offload.index = await api('/api/offload/index');
  } catch (e) {
    $('offloadBody').innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
    return;
  }
  renderOffloadIndex();
}

/**
 * The most rows the Offloaded tab draws for one destination (final review F2.4).
 * TreeMap's record keeps every file still offloaded (F1.9), and a drive given a
 * photo library in batches drew 80,000 rows each time the tab opened. The
 * newest are shown and the rest counted; the search reaches any of them.
 */
const OFFLOAD_ROWS_PER_DESTINATION = 200;

function renderOffloadIndex() {
  const host = $('offloadBody');
  const idx = state.offload.index;
  if (!idx || !idx.entries.length) {
    $('offloadInfo').textContent = '';
    host.innerHTML = '<div class="muted">Nothing offloaded yet — right-click any file or folder and choose <b>Offload…</b> to move it to another drive with copy-and-verify safety.</div>';
    return;
  }
  const q = state.offload.q.trim().toLowerCase();
  const active = idx.entries.filter(e => !e.restoredAt);
  // A copy whose original the offload left in place freed nothing here
  // (final review F3.2): it is listed, and counted apart from what was freed.
  const kept = active.filter(e => e.originalKept).length;
  // One offload index per machine — a constant key, so a restore or a new
  // offload rolls the totals in place.
  FxNum.rollHtml($('offloadInfo'),
    `<span class="num">${formatCount(active.length)}</span> offloaded file${active.length === 1 ? '' : 's'} across ${idx.destinations.length} destination${idx.destinations.length === 1 ? '' : 's'} — <span class="num">${formatBytes(active.reduce((s, e) => s + (e.originalKept ? 0 : e.size), 0))}</span> freed locally.` +
    (kept ? ` <span class="num">${formatCount(kept)}</span> ${kept === 1 ? 'was copied with its original left in place, so it is' : 'were copied with their originals left in place, so they are'} not counted.` : ''),
    'offload-index');

  host.innerHTML = idx.destinations.map((d, di) => {
    const entries = idx.entries.filter(e => e.destRoot === d.root &&
      (!q || e.name.toLowerCase().includes(q) || e.originalPath.toLowerCase().includes(q)));
    if (q && !entries.length) return '';
    const rows = entries.slice(0, OFFLOAD_ROWS_PER_DESTINATION).map(e => `
      <div class="bp-item${e.restoredAt ? ' offl-restored' : ''}">
        ${chipFor({ type: 'file', extension: (e.name.split('.').pop() || '').toLowerCase() }, 13)}
        <div class="meta" style="flex:1;min-width:0;">
          <div class="nm" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(e.name)}${e.restoredAt ? ` <span class="muted">· restored ${formatDate(e.restoredAt)}</span>` : e.originalKept ? ' <span class="muted">· original left in place</span>' : ''}</div>
          <div class="pth" title="was ${escapeHtml(e.originalPath)}">was ${escapeHtml(e.originalPath)}</div>
        </div>
        <span class="dt num">${formatDate(e.offloadedAt)}</span>
        <span class="size-badge num">${formatBytes(e.size)}</span>
        ${e.restoredAt ? '' : `
          <button class="icon-btn" data-offl-reveal="${escapeHtml(e.id)}" title="Reveal at the destination" aria-label="Reveal ${escapeHtml(e.name)} at its destination" ${d.mounted ? '' : 'disabled'}>${icon('external', 13)}</button>
          <button class="pill" data-offl-restore="${escapeHtml(e.id)}" title="Copy back to the original location and verify" ${d.mounted ? '' : 'disabled'}>Restore</button>`}
      </div>`).join('') + (entries.length > OFFLOAD_ROWS_PER_DESTINATION
      ? `<div class="bp-item muted">…and ${formatCount(entries.length - OFFLOAD_ROWS_PER_DESTINATION)} more ${q ? 'matches here — narrow the search to see them' : 'here — search by name or folder to find one'}.</div>`
      : '');
    return `
      <div class="bp-acc offl-acc${d.mounted ? '' : ' offl-unmounted'}" data-acc="${di}">
        <div class="bp-head" role="button" tabindex="0" aria-expanded="false">
          <span class="chip" style="--tint:${d.mounted ? '#30D158' : '#8E8E93'}">${icon('hardDrive', 15)}</span>
          <span class="bp-title">${escapeHtml(d.root)}<span class="prof">${d.mounted ? `${formatCount(d.activeCount)} file${d.activeCount === 1 ? '' : 's'}` : `not connected — last seen ${d.lastSeenAt ? formatDate(d.lastSeenAt) : 'never'}`}</span></span>
          <span class="spacer"></span>
          <span class="size-badge num">${formatBytes(d.totalBytes)}</span>
          <span class="chev">${icon('chevronRight', 14)}</span>
        </div>
        <div class="bp-items">${rows || '<div class="bp-item muted">No matches here.</div>'}</div>
      </div>`;
  }).join('') || '<div class="muted" style="padding:10px 2px;">No offloaded files match that search.</div>';

  host.querySelectorAll('.offl-acc .bp-head').forEach(head => {
    const toggle = () => { const a = head.closest('.bp-acc'); head.setAttribute('aria-expanded', String(a.classList.toggle('open'))); };
    head.addEventListener('click', (e) => { if (e.target.closest('button')) return; toggle(); });
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
  if (q) host.querySelectorAll('.offl-acc').forEach(a => a.classList.add('open'));
  host.querySelectorAll('[data-offl-reveal]').forEach(b => b.addEventListener('click', () =>
    api('/api/offload/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.offlReveal }) })
      .catch(e => toast(e.message, 'error'))));
  host.querySelectorAll('[data-offl-restore]').forEach(b => b.addEventListener('click', () => runRestoreJob([b.dataset.offlRestore])));
}
$('offloadSearch').addEventListener('input', () => {
  state.offload.q = $('offloadSearch').value;
  renderOffloadIndex();
});

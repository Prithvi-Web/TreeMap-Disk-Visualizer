/* ───────────────────────────── System info ───────────────────────────── */
async function loadSystem() {
  try {
    const sys = await api('/api/system');
    state.system = sys;
    // The tour's welcome card offers "scan my home folder" only once it
    // knows where home is; repaint it if it went up first (§9.2).
    if (typeof tour !== 'undefined' && tour.active && tour.step === 'welcome') tourRender();
    $('sysHost').textContent = sys.hostname;
    $('sysPlatform').textContent = ({ darwin:'macOS', win32:'Windows', linux:'Linux' })[sys.platform] || sys.platform;
    // Rolling numerals: same machine, same meaning, every refresh — the
    // digits glide while "GB" and the labels hold still.
    countUp($('sysTotal'), sys.totalDisk, formatBytes);
    countUp($('sysFree'), sys.freeDisk, formatBytes);
    const used = sys.totalDisk - sys.freeDisk;
    countUp($('sysUsed'), used, formatBytes);
    const pct = sys.totalDisk > 0 ? used / sys.totalDisk : 0;
    countUp($('ringPct'), Math.round(pct * 100), (v) => v + '%');
    const C = 2 * Math.PI * 55;
    requestAnimationFrame(() => { $('ringFg').style.strokeDashoffset = String(C * (1 - pct)); });
    if (!$('pathInput').value) $('pathInput').value = sys.homeDir;
    loadTrash();
    loadSnapshots();
    loadCloudStatus(); // reads local token state; network only for connected accounts
  } catch (e) {
    toast('Could not load system info: ' + e.message, 'error');
  }
}

/* Feature 8 — Trash awareness. */
async function loadTrash() {
  try {
    const t = await api('/api/trash/size');
    state.trash = t;
    const el = $('trashFact');
    // `complete: false` means the sweep could not read part of the Trash, so
    // zero bytes is a floor, not a fact — on macOS without Full Disk Access
    // that is the everyday case. Hiding the chip then tells the user their
    // Trash is empty when TreeMap simply could not look.
    if (t && (t.totalBytes > 0 || t.complete === false)) {
      const prefix = t.complete === false ? 'at least ' : '';
      const suffix = t.itemCount ? ` · ${formatCount(t.itemCount)}` : '';
      countUp($('sysTrash'), t.totalBytes, (v) => prefix + formatBytes(v) + suffix);
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  } catch { /* trash sizing is best-effort */ }
}
function openTrashModal() {
  const t = state.trash;
  const atLeast = t && t.complete === false;
  $('trashModalMeta').textContent = t
    ? `· ${atLeast ? 'at least ' : ''}${formatBytes(t.totalBytes)} · ${formatCount(t.itemCount)} item${t.itemCount === 1 ? '' : 's'}`
    : '';
  const body = $('trashModalBody');
  if (!t || !t.items || !t.items.length) {
    // "The Trash is empty" is a claim about the disk. Only make it when the
    // sweep actually finished; otherwise say what happened and how to fix it.
    body.innerHTML = atLeast
      ? `<div class="muted" style="padding:18px 2px;display:flex;align-items:flex-start;gap:8px;">${icon('alert', 15)}<span>${escapeHtml(t.incompleteReason || 'Part of the Trash could not be read, so TreeMap cannot say what is in it.')}</span></div>`
      : `<div class="muted" style="padding:18px 2px;display:flex;align-items:center;gap:8px;">${icon('checkCircle', 15)} The Trash is empty.</div>`;
  } else {
    body.innerHTML = '<div class="trash-list">' + t.items.map((it) =>
      `<div class="trash-item">${chipFor({ type: 'file', extension: (it.name.split('.').pop() || '').toLowerCase() }, 14)}` +
      `<span class="nm" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>` +
      `<span class="sz num">${formatBytes(it.size)}</span></div>`
    ).join('') + '</div>';
  }
  // Enabled when there is something to empty OR when we could not tell —
  // the platform's own emptier has permissions the enumeration does not, so
  // refusing to even try is the one thing that cannot help.
  $('emptyTrashBtn').disabled = !(t && (t.itemCount > 0 || t.complete === false));
  $('trashModal').classList.add('open');
}
$('trashFact').addEventListener('click', openTrashModal);
$('trashFact').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTrashModal(); } });

/* Empty Trash — irreversible, so it goes through the standard confirm modal. */
$('emptyTrashBtn').addEventListener('click', () => {
  const t = state.trash;
  if (!t || (!t.itemCount && t.complete !== false)) return;
  closeModal('trashModal');
  $('confirmTitle').innerHTML = icon('trash', 18) + 'Empty the Trash?';
  $('confirmText').innerHTML = t.complete === false
    // Never quote a figure as the amount being permanently deleted when the
    // figure is a floor. Say what is not known, and let the user decide.
    ? `Empty the system Trash?<br><span style="color:var(--text-3)">${escapeHtml(t.incompleteReason || 'TreeMap could not read the Trash, so it cannot say how much this frees.')} This cannot be undone.</span>`
    : `Permanently delete <b>${formatCount(t.itemCount)} item${t.itemCount === 1 ? '' : 's'}</b> (${formatBytes(t.totalBytes)})?` +
      `<br><span style="color:var(--text-3)">This empties the system Trash and cannot be undone.</span>`;
  onConfirmTrash = emptyTrashAction;
  $('confirmModal').classList.add('open');
});
async function emptyTrashAction() {
  toast('Emptying Trash…');
  try {
    const r = await api('/api/trash/empty', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    });
    if (r.emptied) {
      toast(r.freedBytes > 0 ? `Trash emptied — ${formatBytes(r.freedBytes)} freed` : 'Trash emptied');
    } else {
      const why = r.failed && r.failed.length ? r.failed[0].reason : 'some items could not be removed';
      toast(`Emptied ${formatBytes(r.freedBytes)}, but ${why}`, 'error');
    }
  } catch (e) { toast('Could not empty the Trash: ' + e.message, 'error'); }
  loadTrash(); // refresh the dashboard fact (and hide it once the Trash is empty)
}

/* Feature 9 — OS snapshot accounting. */
async function loadSnapshots() {
  try {
    const s = await api('/api/system/snapshots');
    state.snapshots = s;
    const el = $('snapRow');
    if (s && s.available && s.snapshots && s.snapshots.length > 0) {
      const n = s.snapshots.length;
      $('snapCount').textContent = `${formatCount(n)} local snapshot${n === 1 ? '' : 's'}` + (s.totalBytes ? ` · ~${formatBytes(s.totalBytes)}` : '');
      $('snapHint').textContent = 'Hidden space from filesystem snapshots — Time Machine recreates these on the next backup, so purging is safe.';
      $('snapPurgeBtn').hidden = !s.canPurge;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  } catch { /* snapshot accounting is best-effort */ }
}
$('snapPurgeBtn').addEventListener('click', () => {
  const n = state.snapshots && state.snapshots.snapshots ? state.snapshots.snapshots.length : 0;
  $('confirmTitle').innerHTML = icon('clock', 18) + 'Purge local snapshots?';
  $('confirmText').innerHTML = `Delete <b>${formatCount(n)} local snapshot${n === 1 ? '' : 's'}</b>?<br><span style="color:var(--text-3)">This frees the space they hold. Time Machine will create fresh ones on the next backup.</span>`;
  onConfirmTrash = purgeSnapshotsAction;
  $('confirmModal').classList.add('open');
});
async function purgeSnapshotsAction() {
  try {
    const r = await api('/api/system/snapshots/purge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
    if (r.ok) toast(`Purged ${formatCount(r.deleted)} local snapshot${r.deleted === 1 ? '' : 's'}`);
    else toast(`Purged ${r.deleted}, ${r.failed} failed`, r.failed ? 'error' : 'success');
  } catch (e) { toast('Purge failed: ' + e.message, 'error'); }
  loadSnapshots();
}

/** Inject a synthetic Trash cell at the top level of a home-folder treemap. */
function maybeInjectTrash() {
  if (state.treemap.mode !== 'treemap') return;
  if (!state.root || !state.system || !state.trash) return;
  if (state.treemap.rootPath !== state.root.path) return;
  if (state.root.path !== state.system.homeDir) return;
  const tb = state.trash.totalBytes;
  if (!(tb > 0) || !state.treemap.nodes.length) return;
  const rootSize = state.treemap.rootSize || state.root.size;
  if (rootSize <= 0) return;
  const frac = tb / (rootSize + tb);
  const trashW = Math.max(6, Math.min(34, frac * 100)); // keep visible, never dominant
  const scale = (100 - trashW) / 100;
  for (const n of state.treemap.nodes) { n.x *= scale; n.w *= scale; }
  state.treemap.nodes.push({
    name: 'Trash', path: '\0trash', size: tb, type: 'dir', modifiedAt: Date.now(),
    depth: 1, expanded: false, isTrash: true, x: 100 - trashW, y: 0, w: trashW, h: 100,
  });
}

/* ─────────────── "What's new since last scan" (Dashboard banner) ─────────────── */
function timeAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return 'moments ago';
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? 'a minute ago' : `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? 'an hour ago' : `${h} hours ago`;
  const d = Math.round(h / 24);
  if (d < 7) return d === 1 ? 'yesterday' : `${d} days ago`;
  const w = Math.round(d / 7);
  if (w < 5) return w === 1 ? 'a week ago' : `${w} weeks ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return mo === 1 ? 'a month ago' : `${mo} months ago`;
  const y = Math.round(d / 365);
  return y === 1 ? 'a year ago' : `${y} years ago`;
}

/**
 * After a completed scan, compare the two most recent snapshots of this root
 * and summarize what changed. The scan's own snapshot is written async just
 * after completion, so poll briefly until it lands — diffing a stale pair
 * would report the previous scan's changes as this one's. First-ever scan of
 * a folder (fewer than two snapshots) renders nothing at all.
 */
async function loadWhatsNew() {
  const seq = ++state.whatsNew.seq;
  state.whatsNew.dismissed = false;
  $('whatsNewCard').hidden = true;
  if (!state.root) return;
  const rootPath = state.root.path;
  const finishedBy = state.lastScan ? state.lastScan.when : Date.now();
  try {
    let snaps = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const { snapshots } = await api('/api/snapshots?path=' + encodeURIComponent(rootPath));
      if (seq !== state.whatsNew.seq) return; // a newer scan superseded this one
      if (snapshots.length && snapshots[snapshots.length - 1].takenAt >= finishedBy - 5000) {
        snaps = snapshots;
        break;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    if (!snaps || snaps.length < 2) return;
    const prev = snaps[snaps.length - 2], curr = snaps[snaps.length - 1];
    const diff = await api(`/api/snapshots/compare?a=${encodeURIComponent(prev.id)}&b=${encodeURIComponent(curr.id)}`);
    if (seq !== state.whatsNew.seq || state.whatsNew.dismissed) return;
    renderWhatsNew(prev, curr, diff);
  } catch { /* history is best-effort — no banner beats a wrong one */ }
}

function renderWhatsNew(prev, curr, diff) {
  const bytes = diff.totalDelta;
  const files = curr.fileCount - prev.fileCount;
  // diff entries arrive sorted by |delta|, so the first grower is the biggest.
  const mover = (diff.entries || []).find((e) => e.delta > 0) || null;
  const ago = timeAgo(prev.takenAt);

  const parts = [];
  if (bytes !== 0) {
    parts.push(`<span class="delta-badge num ${bytes > 0 ? 'up' : 'down'}">${bytes > 0 ? '+' : ''}${formatBytes(Math.abs(bytes))} ${bytes > 0 ? 'added' : 'freed'}</span>`);
  }
  if (files !== 0) {
    parts.push(`<span class="delta-badge num ${files > 0 ? 'up' : 'down'}">${files > 0 ? '+' : ''}${formatCount(Math.abs(files))} file${Math.abs(files) === 1 ? '' : 's'} ${files > 0 ? 'added' : 'removed'}</span>`);
  }
  if (mover) {
    parts.push(`<span class="wn-mover" title="${escapeHtml(mover.path)}">${escapeHtml(mover.name)} grew the most (+${formatBytes(mover.delta)})</span>`);
  }
  const headline = parts.length ? "What's new" : 'Nothing changed';
  $('whatsNewBody').innerHTML =
    `<span class="wn-title">${icon('sparkles', 15)}${headline} <span class="wn-ago">since your last scan ${escapeHtml(ago)}</span></span>` +
    parts.join('');
  $('whatsNewCard').hidden = false;
}

$('whatsNewClose').addEventListener('click', (e) => {
  e.stopPropagation();
  state.whatsNew.dismissed = true;
  $('whatsNewCard').hidden = true;
});
$('whatsNewBody').addEventListener('click', () => switchView('trends'));
$('whatsNewBody').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchView('trends'); }
});

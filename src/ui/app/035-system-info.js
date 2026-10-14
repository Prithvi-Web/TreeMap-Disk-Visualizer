/* ───────────────────────────── System info ───────────────────────────── */
async function loadSystem() {
  try {
    const sys = await api('/api/system');
    state.system = sys;
    renderKeyNames(); // ⌘ and ⌥ on a Mac, Ctrl and Alt elsewhere, now that the OS is known
    // The tour's welcome card offers "scan my home folder" only once it
    // knows where home is; repaint it if it went up first (§9.2).
    if (typeof tour !== 'undefined' && tour.active && tour.step === 'welcome') tourRender();
    $('sysHost').textContent = sys.hostname;
    $('sysPlatform').textContent = ({ darwin:'macOS', win32:'Windows', linux:'Linux' })[sys.platform] || sys.platform;
    paintDiskFacts(sys);
    // The Fast rescan box follows the folder the box now holds — at once,
    // not whenever the engine plan happens to answer (review L3).
    if (!$('pathInput').value) { $('pathInput').value = sys.homeDir; maybeShowFastRescan(); }
    loadTrash();
    loadSnapshots();
    loadCloudStatus(); // reads local token state; network only for connected accounts
    // Handed back so one call can both repaint this panel and answer "how much
    // is free right now" — these numbers are otherwise painted once at boot.
    return sys;
  } catch (e) {
    toast('Could not load system info: ' + e.message, 'error');
    return null;
  }
}

/** The disk's own figures on the System card: total, free, used and the ring. */
function paintDiskFacts(sys) {
  // Rolling numerals: same machine, same meaning, every refresh — the
  // digits glide while "GB" and the labels hold still.
  countUp($('sysTotal'), sys.totalDisk, formatBytes);
  countUp($('sysFree'), sys.freeDisk, formatBytes);
  // `usedDisk`, not `totalDisk - freeDisk`: `freeDisk` is what a normal
  // program may write, which on ext4 excludes the 5% the system keeps for
  // itself. Subtracting it would count that reserve as space something is
  // using, and the Missing GB receipt — which reads the occupied blocks
  // directly — would disagree with this tile by ~50 GB on a 1 TB disk.
  const used = sys.usedDisk;
  countUp($('sysUsed'), used, formatBytes);
  const pct = sys.totalDisk > 0 ? used / sys.totalDisk : 0;
  countUp($('ringPct'), Math.round(pct * 100), (v) => v + '%');
  const C = 2 * Math.PI * 55;
  requestAnimationFrame(() => { $('ringFg').style.strokeDashoffset = String(C * (1 - pct)); });
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
      // Nothing found, and part of it unread: "at least 0 B" is true of every
      // Trash and says nothing (B02). Nor can the row say none of it was read:
      // the same answer comes back when one location was refused and the rest
      // were read and found empty (review F1.5). It says what is true either
      // way, and the server's sentence — on the row and in the sheet it
      // opens — says which.
      if (t.complete === false && !(t.totalBytes > 0)) {
        $('sysTrash').dataset.v = 0;
        $('sysTrash').textContent = 'Couldn’t read all of it';
      } else countUp($('sysTrash'), t.totalBytes, (v) => prefix + formatBytes(v) + suffix);
      el.title = t.complete === false
        ? (t.incompleteReason || 'Part of the Trash could not be read, so TreeMap cannot say what is in it.')
        : 'View Trash contents';
      el.hidden = false;
    } else {
      // The row goes once the Trash is empty — just after "Empty the Trash"
      // gave it focus back (E04). Focus on it would fall to <body> with it:
      // the view's first control takes it, as when the cart or the selection
      // bar goes holding focus (QA B13; review F2.2 of QA fourth pass E04).
      const held = el.contains(document.activeElement);
      el.hidden = true;
      if (held) { const to = activeViewControl(); if (to) to.focus({ preventScroll: true }); }
    }
  } catch { /* trash sizing is best-effort */ }
}
function openTrashModal() {
  const t = state.trash;
  const atLeast = t && t.complete === false;
  // The header says what the row says. Nothing sized and part unread, "at
  // least 0 B · 0 items" is true of every Trash and reads as a count; the body
  // below gives the server's reason (B02 review F2.4).
  $('trashModalMeta').textContent = !t ? ''
    : atLeast && !(t.totalBytes > 0) ? '· couldn’t read all of it'
    : `· ${atLeast ? 'at least ' : ''}${formatBytes(t.totalBytes)} · ${formatCount(t.itemCount)} item${t.itemCount === 1 ? '' : 's'}`;
  const body = $('trashModalBody');
  const listed = !!(t && t.items && t.items.length);
  // What could not be read, said plainly (C02): the server's sentence, then
  // what that leaves unknown — over no items, that nothing can be listed or
  // sized; over a partial list, that the list is only what could be read.
  const unreadNote = (after) => `<div class="muted" style="padding:${listed ? '4px 2px 12px' : '18px 2px'};display:flex;align-items:flex-start;gap:8px;">${icon('alert', 15)}` +
    `<span>${escapeHtml(`${t.incompleteReason || 'Part of the Trash could not be read.'} ${after}`)}</span></div>`;
  if (!listed) {
    // "The Trash is empty" is a claim about the disk. Only make it when the
    // sweep actually finished; otherwise say what happened and how to fix it.
    body.innerHTML = atLeast
      ? unreadNote('TreeMap cannot list what is in it or say how much space it takes.')
      : `<div class="muted" style="padding:18px 2px;display:flex;align-items:center;gap:8px;">${icon('checkCircle', 15)} The Trash is empty.</div>`;
  } else {
    body.innerHTML = (atLeast ? unreadNote('The items below are the ones TreeMap could read.') : '') + '<div class="trash-list">' + t.items.map((it) =>
      `<div class="trash-item">${chipFor({ type: 'file', extension: (it.name.split('.').pop() || '').toLowerCase() }, 14)}` +
      `<span class="nm" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>` +
      `<span class="sz num">${formatBytes(it.size)}</span></div>`
    ).join('') + '</div>';
  }
  // About the items listed, so said only over a list (C02).
  $('trashModalNote').textContent = listed ? 'Items restore from here until the Trash is emptied.' : '';
  // Enabled when there is something to empty OR when we could not tell —
  // the platform's own emptier has permissions the enumeration does not, so
  // refusing to even try is the one thing that cannot help.
  $('emptyTrashBtn').disabled = !(t && (t.itemCount > 0 || t.complete === false));
  $('trashModal').classList.add('open');
}
$('trashFact').addEventListener('click', openTrashModal);
$('trashFact').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTrashModal(); } });

/* The System card follows the disk, not the page load (B18). It was read
   once at boot and, half an hour of disk churn later, stated a Free figure
   3.8 GB away from the Missing GB receipt beside it. A scan landing asks
   again — one small read, the disk figures only; a failed read keeps what
   the card already says. A tree painted from the index (no scan id) waits
   for the scan behind it. */
async function refreshDiskFacts() {
  let sys;
  try { sys = await api('/api/system'); } catch { return; }
  if (!sys) return;
  state.system = sys;
  paintDiskFacts(sys);
}
subscribe(TOPIC.scan, (scanId) => { if (scanId) return refreshDiskFacts(); });

/* Empty Trash — irreversible, so it goes through the standard confirm modal,
   asked OVER the Trash sheet: a "no" goes back to the sheet, focus on
   "Empty Trash…". The sheet used to close before asking, so Cancel or Escape
   left neither, and focus on <body> (QA fourth pass E04). A "yes" closes it
   (emptyTrashAction): its list is what was just emptied. */
$('emptyTrashBtn').addEventListener('click', () => {
  const t = state.trash;
  if (!t || (!t.itemCount && t.complete !== false)) return;
  $('confirmTitle').innerHTML = icon('trash', 18) + 'Empty the Trash?';
  $('confirmText').innerHTML = t.complete === false
    // Never quote a figure as the amount being permanently deleted when the
    // figure is a floor. Say what is not known, and let the user decide.
    ? `Empty the system Trash?<br><span style="color:var(--text-3)">${escapeHtml(t.incompleteReason || 'TreeMap could not read the Trash, so it cannot say how much this frees.')} This cannot be undone.</span>`
    : `Permanently delete <b>${formatCount(t.itemCount)} item${t.itemCount === 1 ? '' : 's'}</b> (${formatBytes(t.totalBytes)})?` +
      `<br><span style="color:var(--text-3)">This empties the system Trash and cannot be undone.</span>`;
  setConfirmButton('Empty the Trash');
  onConfirmTrash = emptyTrashAction;
  $('confirmModal').classList.add('open');
});
async function emptyTrashAction() {
  // With the question, in one batch: focus goes back to where the Trash
  // sheet was opened from (E04).
  closeModal('trashModal');
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
    // Shown when something was measured or listed: Windows can report space in
    // storage for restore points with none listed at this moment, and a
    // measurement must not vanish because the list was empty.
    if (s && s.available && ((s.snapshots && s.snapshots.length > 0) || s.totalBytes > 0)) {
      const n = s.snapshots ? s.snapshots.length : 0;
      const noun = platformWord({ darwin: 'local snapshot', win32: 'restore point', other: 'snapshot' });
      $('snapCount').textContent = `${formatCount(n)} ${noun}${n === 1 ? '' : 's'}` + (s.totalBytes ? ` · ~${formatBytes(s.totalBytes)}` : '');
      // Windows manages restore points itself; the purge button is macOS-only
      // (canPurge) and so is the sentence that justifies it.
      $('snapHint').textContent = platformWord({
        darwin: 'Hidden space from filesystem snapshots — Time Machine recreates these on the next backup, so purging is safe.',
        win32: 'Space held by Windows restore points (Windows calls them shadow copies). Windows manages these itself; TreeMap does not delete them.',
        other: 'Hidden space held by filesystem snapshots. TreeMap does not delete them.',
      }) + (s.sizeReason ? ` ${s.sizeReason}` : '');
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
  setConfirmButton('Purge snapshots', 'clock');
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

/* ── What a scan counted (QA D75) ──
   A snapshot records the totals a scan COUNTED, not what it was allowed to
   count. A new "Don't scan" pattern leaves a folder out, and the next banner
   read the drop as "5.0 MB freed · 25,600 files removed" when nothing had
   been removed. History already refuses to compare two scans that stopped at
   different drives (U-24, 409 BOUNDARY_CHANGED — the banner meets that as no
   banner); this is the page's equivalent for what the page can know: the
   "Don't scan" patterns each scan ran with, and the kind of engine that
   counted. It is kept per folder and per snapshot, in this browser, so a
   snapshot the page never saw (a scheduled scan, another window, a build
   before this one) has no record — and then the banner states the change in
   the totals without naming a cause. */
const SCAN_COVERAGE_STORE = 'tm-scan-coverage';
/** Records kept per folder: the two snapshots a banner compares, a reopened
    scan's, and each one's live scan too ("scan:<id>", for Compare — B24). */
const SCAN_COVERAGE_PER_ROOT = 8;
const SCAN_COVERAGE_ROOTS = 60;

/**
 * What a scan counted besides the folder itself, or null when unknown: its
 * "Don't scan" patterns (a "suggest"-only entry is no scan rule) and the kind
 * of engine. The native engine, the walker at any pool size and its fast
 * rescan count the same entries; gdu shows a folder it may not open as an
 * empty one; the NTFS read counts from the volume's own table. The index and
 * a cloud listing are no scan of the disk.
 */
function scanCoverageOf(settings, engine) {
  if (!settings || !Array.isArray(settings.ignore)) return null;
  const family = { native: 'walk', walker: 'walk', 'turbo-walker': 'walk', 'gdu-turbo': 'gdu', 'ntfs-mft': 'ntfs-mft' }[engine];
  if (!family) return null;
  const patterns = settings.ignore
    .filter((e) => e && typeof e.pattern === 'string' && e.pattern && e.scope !== 'suggest')
    .map((e) => e.pattern)
    .sort();
  return { family, patterns };
}
function readCoverageBook() {
  try {
    const book = JSON.parse(localStorage.getItem(SCAN_COVERAGE_STORE) || '{}');
    return book && typeof book === 'object' && !Array.isArray(book) ? book : {};
  } catch { return {}; }
}
/** The coverage recorded for one snapshot of a folder, or null. */
function coverageFor(rootPath, snapshotId) {
  const list = readCoverageBook()[rootPath];
  const hit = Array.isArray(list) ? list.find((r) => r && r.snap === snapshotId) : null;
  return hit && typeof hit.family === 'string' && Array.isArray(hit.patterns) ? { family: hit.family, patterns: hit.patterns } : null;
}
function rememberCoverage(rootPath, snapshotId, coverage) {
  try {
    const book = readCoverageBook();
    const list = (Array.isArray(book[rootPath]) ? book[rootPath] : []).filter((r) => r && r.snap !== snapshotId);
    list.push({ snap: snapshotId, family: coverage.family, patterns: coverage.patterns });
    delete book[rootPath]; // put back last: the folders scanned most recently are the ones kept
    book[rootPath] = list.slice(-SCAN_COVERAGE_PER_ROOT);
    const roots = Object.keys(book);
    for (const r of roots.slice(0, Math.max(0, roots.length - SCAN_COVERAGE_ROOTS))) delete book[r];
    localStorage.setItem(SCAN_COVERAGE_STORE, JSON.stringify(book));
  } catch { /* a convenience of this browser: without it the banner only says less */ }
}
/**
 * How two scans' coverage compares: 'same', 'rules' (their "Don't scan"
 * patterns differ — the stated cause even when the engine changed with them,
 * as adding a pattern moves a scan off the native engine), 'engine' (another
 * kind of engine counted), or 'unknown' (either side has no record).
 */
function coverageChange(before, after) {
  if (!before || !after) return 'unknown';
  if (JSON.stringify(before.patterns) !== JSON.stringify(after.patterns)) return 'rules';
  return before.family === after.family ? 'same' : 'engine';
}

/**
 * One "Don't scan" pattern as the scanner reads it (src/utils/glob.ts,
 * compileIgnore — tests/historyRuleChange.test.ts holds the two to the same
 * answers): a bare name matches an entry's name anywhere; a pattern with a
 * separator matches that path and everything beneath it. `*` stays inside a
 * name, `**` crosses folders, `?` is one character; `~` is the home folder;
 * case counts only on Linux.
 */
function ignorePatternTest(pattern) {
  const sys = state.system || {};
  const ci = sys.platform !== 'linux';
  let p = String(pattern).trim();
  if (sys.homeDir && (p === '~' || p.startsWith('~/') || p.startsWith('~\\'))) p = sys.homeDir + p.slice(1);
  const toRe = (glob) => {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
      const ch = glob[i];
      if (ch === '*') {
        if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/\\\\]*';
      } else if (ch === '?') re += '[^/\\\\]';
      else if (ch === '/' || ch === '\\') re += '[/\\\\]';
      else if ('.+^$()[]{}|'.includes(ch)) re += '\\' + ch;
      else re += ch;
    }
    return new RegExp('^' + re + '$', ci ? 'i' : '');
  };
  if (/[/\\]/.test(p)) {
    const trimmed = p.replace(/[/\\]+$/, '');
    // '/' + '**', never one string: the build's banner check counts comment openers and closers in each part.
    const self = toRe(trimmed), beneath = toRe(trimmed + '/' + '**');
    return (fullPath) => self.test(fullPath) || beneath.test(fullPath);
  }
  const nameRe = toRe(p);
  return (_fullPath, name) => nameRe.test(name);
}

/**
 * What a change of "Don't scan" rules between two scans can explain (B24):
 * the patterns only the second ran with left things out of it, and the ones
 * only the first ran with let things back in once dropped. Null when the two
 * counted the same way, or either has no record — then nothing is explained,
 * and a missing folder is just missing.
 */
function coverageRules(before, after) {
  if (coverageChange(before, after) !== 'rules') return null;
  const only = (xs, ys) => xs.filter((x) => !ys.includes(x)).map(ignorePatternTest);
  return { leftOut: only(after.patterns, before.patterns), letIn: only(before.patterns, after.patterns) };
}

/** A compare entry a rule change explains: 'no longer scanned', 'scanned again', or null. */
function coverageExplains(entry, rules) {
  if (!rules) return null;
  const hit = (tests) => tests.some((t) => t(entry.path, entry.name));
  if (entry.sizeB === null && hit(rules.leftOut)) return 'no longer scanned';
  if (entry.sizeA === null && hit(rules.letIn)) return 'scanned again';
  return null;
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
  // This scan's engine, read before the first await: another scan can replace
  // the stats meanwhile. A tree painted from the index says 'index', which
  // scanCoverageOf refuses: no scan counted it. Nor is a scan reopened after a
  // reload described by today's settings (review M1): a rule added since
  // would make the next scan with it compare as the same, and say "freed".
  const reopened = !!(state.lastScan && state.lastScan.reopened);
  const engine = state.scanStats && !reopened ? state.scanStats.engine : null;
  const scanId = state.scanId;
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
    if (!snaps) return;
    const curr = snaps[snaps.length - 1];
    // What this scan counted, kept beside its snapshot for the next banner.
    // A scan reopened later is described by what it ran with, or not at all.
    // "Don't scan" rules apply from the next scan, so for a scan that has just
    // finished the settings read now are the ones it ran with.
    let after = coverageFor(rootPath, curr.id);
    if (!after && engine) {
      const settings = await api('/api/settings').catch(() => null);
      if (seq !== state.whatsNew.seq) return;
      after = scanCoverageOf(settings, engine);
      if (after) rememberCoverage(rootPath, curr.id, after);
    }
    // And under the live scan's own id: Compare's "Scan (full diff)" pairs
    // are scans, not snapshots, and read their rules from here (B24).
    if (after && scanId) rememberCoverage(rootPath, 'scan:' + scanId, after);
    if (snaps.length < 2) return;
    const prev = snaps[snaps.length - 2];
    const change = coverageChange(coverageFor(rootPath, prev.id), after);
    // Another kind of engine counted: like two scans that stopped at
    // different drives, no banner rather than a wrong one.
    if (change === 'engine') return;
    const diff = await api(`/api/snapshots/compare?a=${encodeURIComponent(prev.id)}&b=${encodeURIComponent(curr.id)}`);
    if (seq !== state.whatsNew.seq || state.whatsNew.dismissed) return;
    renderWhatsNew(prev, curr, diff, change);
  } catch { /* history is best-effort — no banner beats a wrong one */ }
}

/**
 * The banner. `change` is coverageChange's: only two scans known to have
 * counted the same way say "added", "freed" and "removed". Across a change of
 * "Don't scan" rules the difference is what was scanned, said as that and
 * nothing more — no bytes "freed", no mover. Without a record either side the
 * totals' difference is stated with its sign and no cause.
 */
function renderWhatsNew(prev, curr, diff, change = 'unknown') {
  const bytes = diff.totalDelta;
  const files = curr.fileCount - prev.fileCount;
  // diff entries arrive sorted by |delta|, so the first grower is the biggest.
  const mover = (diff.entries || []).find((e) => e.delta > 0) || null;
  const ago = timeAgo(prev.takenAt);
  const n = Math.abs(files);
  const fileWord = `file${n === 1 ? '' : 's'}`;

  const parts = [];
  if (change === 'rules') {
    const counted = files < 0 ? `${formatCount(n)} ${fileWord} no longer scanned`
      : files > 0 ? `${formatCount(n)} more ${fileWord} scanned`
        : 'Not compared';
    // The badge never wraps (105-trends.css), so the cause goes beside it.
    parts.push(`<span class="delta-badge num">${counted}</span>`, '<span class="wn-mover">— your “Don’t scan” rules changed</span>');
  } else {
    const known = change === 'same';
    // Coloured as growth or as space won back only when that is what it is.
    const tone = (up) => (known ? (up ? ' up' : ' down') : '');
    if (bytes !== 0) {
      parts.push(`<span class="delta-badge num${tone(bytes > 0)}">${bytes > 0 ? '+' : known ? '' : '−'}${formatBytes(Math.abs(bytes))}` +
        `${known ? (bytes > 0 ? ' added' : ' freed') : ''}</span>`);
    }
    if (files !== 0) {
      parts.push(`<span class="delta-badge num${tone(files > 0)}">${files > 0 ? '+' : known ? '' : '−'}${formatCount(n)} ${fileWord}` +
        `${known ? (files > 0 ? ' added' : ' removed') : ''}</span>`);
    }
    // Unknown coverage names no mover either: a folder counted again after a
    // rule was removed is not one that grew (review L1).
    if (mover && known) {
      parts.push(`<span class="wn-mover" title="${escapeHtml(mover.path)}">${escapeHtml(mover.name)} grew the most (+${formatBytes(mover.delta)})</span>`);
    }
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

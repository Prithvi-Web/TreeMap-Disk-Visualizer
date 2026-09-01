/* ───────────────────── v4 §9.1 — the command palette ─────────────────────
 *
 * Fifteen views heading toward twenty, deep settings, and until now no
 * palette: discoverability was a real cost, and this is the cheapest fix in
 * the phase. One box, fuzzy-matched, over four sources — the VIEW REGISTRY
 * itself (so every view is reachable by construction, not by a list that can
 * drift), a small action registry, the saved views, and recent scan roots.
 * Focus returns to wherever it was, which §9.1 asks for by name.
 */

/**
 * The fuzzy scorer. Pure and deterministic — tests/commandPalette.test.ts
 * extracts this function and runs it in Node, so it must not read anything
 * outside its arguments. Subsequence match; consecutive letters and
 * word-start hits score up, gaps score down; null means "not a match" and is
 * never conflated with a low score.
 */
function cmdkScore(query, label) {
  const q = String(query).toLowerCase();
  const l = String(label).toLowerCase();
  if (!q) return 0; // an empty box lists everything, in registry order
  if (q.length > l.length) return null;
  let score = 0;
  let li = 0;
  let prev = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const found = l.indexOf(q[qi], li);
    if (found === -1) return null;
    score += 1;
    if (prev !== -1 && found === prev + 1) score += 3;
    if (found === 0 || ' -_/.:('.includes(l[found - 1])) score += 6;
    const gap = prev === -1 ? Math.min(3, found) : found - prev - 1;
    score -= Math.min(6, gap);
    prev = found;
    li = found + 1;
  }
  return score;
}

/** Actions by name. `when` gates entries that would be dead where you are. */
const CMDK_ACTIONS = [
  { label: 'Scan a folder…', hint: 'pick a folder to map', run: () => {
    // The same zero-state trap the tour's pick button hit: before any scan
    // the path box is offscreen and focus() is a silent no-op. The visible
    // affordance there is the folder browser.
    const pi = $('pathInput');
    if (pi.offsetParent === null) { openBrowse(null); return; }
    pi.focus();
    pi.select();
  } },
  { label: 'Rescan this folder', hint: 'fresh numbers for the same tree', when: () => !!state.root && !state.scanning, run: () => rescan() },
  { label: 'Empty the cleanup cart', hint: 'unstages everything, deletes nothing', when: () => state.cart.size > 0, run: () => cartClear() },
  { label: 'Export the map as PNG', hint: 'the current treemap, as pixels', when: () => state.view === 'treemap' && drawnCells().length > 0, run: () => exportTreemapPNG() },
  { label: 'Search all indexed files', hint: 'the sidebar search box', run: () => summonGlobalSearch() },
  // Gated on a scan: with none, switchView('treemap') shows the empty state
  // and the ✨ button the popover anchors to is not on screen — the popover
  // would arm at (8,8) and resurface stale over whatever came next.
  { label: 'Ask in plain words', hint: 'translated to a query you approve', when: () => !!state.root, run: () => { switchView('treemap'); requestAnimationFrame(() => nlOpen()); } },
  { label: 'Open Settings', hint: 'schedules, weights, notes and more', run: () => $('settingsBtn').click() },
  { label: 'Open Clean Up', hint: 'smart suggestions, custom rules, empty folders', run: () => $('cleanupBtn').click() },
  { label: 'Keyboard shortcuts', hint: 'the ? panel', run: () => toggleShortcuts() },
  { label: 'Switch light / dark', hint: 'theme', run: () => $('themeToggle').click() },
];

/**
 * Deep settings, searchable by section name — §9.1 names settings among the
 * palette's sources, and "deep settings" is part of its stated why: typing
 * "weights" must land on the Reclaim sliders, not on nothing. Each entry
 * opens the modal and scrolls its own heading into view. The final audit
 * held this list to the real headings (tests/commandPalette.test.ts).
 */
const CMDK_SETTINGS_SECTIONS = [
  { name: 'Scheduled scans', hint: 'schedule, recurring, automatic' },
  { name: 'Disk-full forecast', hint: 'warning, days, projection' },
  { name: 'Live activity', hint: 'watch, auto-pause' },
  { name: 'Time Capsule', hint: 'retention, undo copies' },
  { name: 'Reclaim Score', hint: 'weights, sliders, signals' },
  { name: 'Cleanup target', hint: 'goal, free up, meter' },
  { name: 'Human-scale sizes', hint: 'photo equivalents, tooltips' },
  { name: 'Ask in plain words', hint: 'natural language, translate' },
  { name: 'Welcome tour', hint: 'first run, onboarding' },
  { name: 'Cloud accounts', hint: 'drive, dropbox, onedrive' },
  { name: 'Ignore list', hint: 'exclude, patterns, globs' },
];
function cmdkOpenSettingsSection(name) {
  $('settingsBtn').click();
  // The headings are static markup; only the values load async — so the
  // scroll is safe one frame after the modal opens.
  requestAnimationFrame(() => {
    const head = [...document.querySelectorAll('#settingsModal .set-h')]
      .find((h) => h.textContent.trim().includes(name));
    if (head) head.scrollIntoView({ block: 'start' });
  });
}

/** Recent scan roots, fetched once per palette opening; empty is fine. */
let cmdkRoots = [];
async function cmdkLoadRoots() {
  try {
    // listSnapshotRoots serves { rootPath, count, … } — QA caught the wrong
    // field here rendering a "Scan again: [object Object]" row whose dedupe
    // against the open folder also never matched.
    const { roots } = await api('/api/snapshots');
    cmdkRoots = (roots || [])
      .map((r) => (r && typeof r.rootPath === 'string') ? r.rootPath : null)
      .filter(Boolean)
      .slice(0, 8);
  } catch { cmdkRoots = []; }
}

function cmdkItems() {
  const items = [];
  for (const v of VIEWS) {
    // A capability-blocked view still appears — with the capability's own
    // reason as its hint. Landing on it shows the full notice; hiding it
    // would make the palette lie about what this app has.
    const blocked = viewBlockedReason(v);
    items.push({ label: v.label, hint: blocked || 'view', run: () => switchView(v.id) });
  }
  for (const a of CMDK_ACTIONS) {
    if (a.when && !a.when()) continue;
    items.push({ label: a.label, hint: a.hint, run: a.run });
  }
  for (const sec of CMDK_SETTINGS_SECTIONS) {
    items.push({ label: `Settings: ${sec.name}`, hint: sec.hint, run: () => cmdkOpenSettingsSection(sec.name) });
  }
  for (const sv of (state.savedViews || [])) {
    items.push({ label: `Saved view: ${sv.name}`, hint: sv.q, run: () => {
      switchView('treemap');
      $('tmSearch').value = sv.q;
      $('tmSearch').dispatchEvent(new Event('input', { bubbles: true }));
    } });
  }
  for (const rootPath of cmdkRoots) {
    if (state.root && rootPath === state.root.path) continue; // already open
    items.push({ label: `Scan again: ${rootPath}`, hint: 'recent folder', run: () => startScan(rootPath) });
  }
  return items;
}

let cmdkPrevFocus = null;
let cmdkSel = 0;
let cmdkShown = [];

function cmdkRender() {
  const q = $('cmdkInput').value.trim();
  const scored = [];
  for (const item of cmdkItems()) {
    // Labels first; hints as a discounted fallback — "weights" must land on
    // "Settings: Reclaim Score" even though the label lacks a w (the final
    // audit's point: deep settings are only searchable if their WORDS are).
    let s = cmdkScore(q, item.label);
    if (s === null && item.hint) {
      const hs = cmdkScore(q, item.hint);
      if (hs !== null) s = hs - 8;
    }
    if (s === null) continue;
    scored.push({ item, s });
  }
  // Stable order: score first, then registry order (Array.prototype.sort is
  // stable), so equal scores never jitter between keystrokes.
  scored.sort((a, b) => b.s - a.s);
  // An empty box BROWSES — capping it at 12 hid three views and every action
  // from the arrow keys (QA finding 4). The list scrolls; only typed queries
  // trim to the best dozen.
  cmdkShown = scored.slice(0, q ? 12 : scored.length).map((x) => x.item);
  // Free text is never a dead end: whatever was typed can always become a
  // file search, which is where the old ⌘K muscle memory still lands.
  if (q) {
    cmdkShown.push({ label: `Search files for “${q}”`, hint: 'global search', run: () => {
      summonGlobalSearch();
      const g = $('gsearch');
      g.value = q;
      g.dispatchEvent(new Event('input', { bubbles: true }));
    } });
  }
  cmdkSel = Math.min(cmdkSel, Math.max(0, cmdkShown.length - 1));
  $('cmdkList').innerHTML = cmdkShown.map((item, i) =>
    `<button class="cmdk-row" role="option" id="cmdk-opt-${i}" aria-selected="${i === cmdkSel}" data-cmdk="${i}">` +
    `<span>${escapeHtml(item.label)}</span><span class="hint">${escapeHtml(item.hint || '')}</span></button>`).join('');
  if (cmdkShown.length) $('cmdkInput').setAttribute('aria-activedescendant', `cmdk-opt-${cmdkSel}`);
  else $('cmdkInput').removeAttribute('aria-activedescendant');
  $('cmdkList').querySelectorAll('[data-cmdk]').forEach((b) => b.addEventListener('click', () => cmdkRun(Number(b.dataset.cmdk))));
}

function cmdkRun(i) {
  const item = cmdkShown[i];
  if (!item) return;
  cmdkClose({ restoreFocus: false }); // the action decides where focus goes next
  item.run();
}

function cmdkOpen() {
  hideTooltip(); // a stale hover card must not float above the palette
  // §9.6's popover outranks this palette's own scrim (nlOverlayGuard explains
  // why), and it must go BEFORE the snapshot below: dismissed after it, the
  // palette dutifully restores focus to #nlInput inside a dialog it has just
  // hidden, which lands the caret on <body>. Closed here, nlClose hands focus
  // back to the ✨ button — which is what this line should be remembering.
  nlClose();
  cmdkPrevFocus = document.activeElement;
  cmdkSel = 0;
  $('cmdkInput').value = '';
  $('cmdkModal').classList.add('open');
  cmdkRender();
  $('cmdkInput').focus();
  // Saved views and roots load in the background and refresh the open list;
  // the palette never waits on the network to appear.
  void loadSavedViews().then(() => { if ($('cmdkModal').classList.contains('open')) cmdkRender(); });
  void cmdkLoadRoots().then(() => { if ($('cmdkModal').classList.contains('open')) cmdkRender(); });
}

function cmdkClose(opts = {}) {
  if (!$('cmdkModal').classList.contains('open')) return;
  $('cmdkModal').classList.remove('open');
  // §9.1: "focus returns to where it was."
  if (opts.restoreFocus !== false && cmdkPrevFocus && cmdkPrevFocus.focus) cmdkPrevFocus.focus();
  cmdkPrevFocus = null;
}

$('cmdkInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); cmdkSel = (cmdkSel + 1) % Math.max(1, cmdkShown.length); cmdkRender(); cmdkScrollSel(); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); cmdkSel = (cmdkSel - 1 + Math.max(1, cmdkShown.length)) % Math.max(1, cmdkShown.length); cmdkRender(); cmdkScrollSel(); return; }
  if (e.key === 'Enter') { e.preventDefault(); cmdkRun(cmdkSel); return; }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cmdkClose(); return; }
});
$('cmdkInput').addEventListener('input', () => { cmdkSel = 0; cmdkRender(); });
$('cmdkModal').addEventListener('mousedown', (e) => { if (e.target === $('cmdkModal')) cmdkClose(); });
// While the palette is up, its keys are its own: without this, typing into
// the palette over the duplicate viewer fed dupeViewerKeys (Space staged a
// file behind the scrim), and letters reached the treemap's shortcut map.
// ⌘K and Escape are handled here so the toggle and the focus-restoring close
// keep working from anywhere inside the panel.
$('cmdkModal').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); cmdkClose(); }
  else if (e.key === 'Escape' && document.activeElement !== $('cmdkInput')) { e.preventDefault(); cmdkClose(); }
  e.stopPropagation();
});
function cmdkScrollSel() {
  const el = document.getElementById(`cmdk-opt-${cmdkSel}`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

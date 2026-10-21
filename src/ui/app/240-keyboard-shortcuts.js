/* ───────────────────────────── Keyboard shortcuts ───────────────────────────── */
/* The page's key names, rewritten for this keyboard once /api/system has said
   which OS this is (loadSystem calls this): every <kbd> and hint that names a
   modifier carries data-key="mod" or data-key="alt" and ships the Mac glyph,
   and the sidebar toggle's tooltip names its shortcut. KEY_NAMES (prelude)
   holds the names. */
function renderKeyNames() {
  for (const el of document.querySelectorAll('[data-key="mod"]')) el.textContent = keyName('mod');
  for (const el of document.querySelectorAll('[data-key="alt"]')) el.textContent = keyName('alt');
  const nav = $('sideToggle');
  if (nav) nav.title = sideNavTitle($('sideNav').classList.contains('collapsed'));
}

/* ── v4 §6.4 — hold Z ──
   `keydown` repeats while a key is held, so the guard on `state.lens.held` is
   what keeps this from repainting the map sixty times a second for as long as
   the key is down. Released on `keyup`, and also on `blur`: switching apps
   mid-hold never delivers the keyup, and a lens stuck on until the next press
   of Z would look like a bug in the map rather than in the keyboard. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'z' && e.key !== 'Z') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
  // A sheet is up: the map is behind a scrim, and magnifying what nobody can
  // see leaves the lens painted over the dimmed page when the sheet closes.
  if (topModal()) return;
  if (state.view !== 'treemap' || isSun() || state.lens.held) return;
  state.lens.held = true;
  presentView();
});
document.addEventListener('keyup', (e) => {
  if (e.key !== 'z' && e.key !== 'Z' || !state.lens.held) return;
  state.lens.held = false;
  presentView();
});
window.addEventListener('blur', () => {
  if (!state.lens.held) return;
  state.lens.held = false;
  presentView();
});

/**
 * Keys the map must leave to something else (QA-6 review MEDIUM-1). Every one
 * of them while #ctxMenu is open: its entries are what the arrows move between
 * (ctxMenuKeydown), and h/j/k/l, Backspace or Enter must not move, climb or
 * drill the map behind it. And Enter or Space on a button or a link — the "…"
 * crumb, an entry of its menu — is that control's own press: the map's Enter
 * called preventDefault() and drilled instead, so the "…" menu could neither
 * be opened nor used from the keyboard.
 */
function tmMapKeyYields(e) {
  if (ctxMenuIsOpen()) return true;
  if (e.key !== 'Enter' && e.key !== ' ') return false;
  const t = e.target;
  return !!(t && typeof t.closest === 'function' && t.closest('button, a[href], [role="button"], [role="menuitem"]'));
}

/**
 * The map's moving keys hand focus to the map when they are pressed from a
 * control beside it (QA-6 review MEDIUM-1). Enter on a focused button is that
 * button's press now (tmMapKeyYields), and a click leaves focus on the button
 * it pressed — a crumb, Refresh, a renderer segment — so someone who then
 * steered the map with j and k would have pressed that button with Enter.
 * The map is what those keys drive, so it is what Enter goes to next.
 */
function tmMapTakeFocus() {
  const at = document.activeElement;
  if (at && at !== tmCanvas && at !== document.body) tmCanvas.focus({ preventScroll: true });
}

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  // §6.3 — Escape abandons a lasso in progress before it can mean anything
  // else, so a gesture started by accident costs one key rather than an undo.
  if (e.key === 'Escape' && state.lasso.on) { e.preventDefault(); e.stopPropagation(); lassoCancel(); return; }
  // The tab lists get the arrows first: ArrowRight on the map-layout segment
  // switches renderer, it does not drill the treemap behind it. The tab has
  // to be focused for this to fire, so it can never intercept a stray arrow.
  if (tablistKeydown(e)) return;
  /* ── Nothing reaches the page under an open sheet ──
     A dialog is modal: while one is up, the only keys that mean anything are
     the ones that act on IT. Everything below used to fire straight through
     the scrim — Enter drilled the map behind a Trash sheet, '?' stacked the
     shortcuts sheet on Settings, ⌘R rescanned under a confirmation. Escape
     still passes (it is how a sheet closes), ⌘K keeps its toggle so the
     palette can be dismissed the way it was summoned, and Tab is handed to
     the trap that cycles inside the top sheet. */
  const sheet = topModal();
  if (sheet && e.key !== 'Escape' && !(mod && e.key.toLowerCase() === 'k')) {
    if (e.key === 'Tab') modalTrapTab(e, sheet);
    return;
  }
  // An open menu's arrows, Home, End and Tab are the menu's (QA-6 review MEDIUM-1).
  if (ctxMenuKeydown(e)) return;
  if (e.key === '?' && !typing && !mod) { e.preventDefault(); toggleShortcuts(); return; }
  if (mod && e.key.toLowerCase() === 'r') {
    // Claimed unconditionally. Letting it through when there was no root
    // handed ⌘R to Electron's View › Reload, which during a first scan threw
    // the whole renderer away — the scan, the progress, the tour — and came
    // back to an empty welcome screen.
    e.preventDefault();
    if (state.scanning) toast('A scan is already running', 'error');
    else if (state.root) rescan();
    return;
  }
  // ⌘⌫ / ⌘Delete trash the selection the view on screen shows, and nothing
  // else (QA third pass D03): pressed on the Dashboard, it opened a Trash
  // sheet for a Grid selection made two views ago. Not under the "…" menu
  // either, as plain Delete below (QA-6b review F2.6).
  if (mod && (e.key === 'Backspace' || e.key === 'Delete')) {
    if (!typing && gridSelectionShown() && !ctxMenuIsOpen()) { e.preventDefault(); confirmTrash([...state.grid.selection]); }
    return;
  }
  /* v4 §9.1 — ⌘K/Ctrl+K is the COMMAND PALETTE now; the spec assigns the key
     explicitly. Global search keeps "/" (below) and its sidebar box, and the
     palette carries a "Search files for …" row on any free text, so the old
     ⌘K muscle memory still lands one keystroke from where it used to.

     "/" stays as before: §A4 asks for search "from anywhere", but Grid and
     Treemap have bound it to their own highlight boxes since they shipped —
     those filter what is on screen, global search finds things anywhere on
     disk. Recorded in docs/PLATFORM_NOTES.md. */
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if ($('cmdkModal').classList.contains('open')) cmdkClose();
    else cmdkOpen();
    return;
  }
  if (mod && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    toggleSideNav();
    return;
  }
  if (e.key === '/' && !typing && state.view === 'grid') {
    e.preventDefault();
    $('gridSearch').focus();
    return;
  }
  if (e.key === '/' && !typing && state.view !== 'treemap') {
    e.preventDefault();
    summonGlobalSearch();
    return;
  }
  // Plain Backspace / Delete in the grid — never while typing; the
  // Cmd/Ctrl-modified variants are above. Not while #ctxMenu is open either:
  // the Grid's trail folds into the same "…" menu, and Backspace pressed in
  // it climbed the Grid behind it, Delete opened a Trash sheet for the
  // selected rows (QA-6b review F2.6).
  if (!mod && !typing && state.view === 'grid' && state.root && !ctxMenuIsOpen()) {
    if (e.key === 'Backspace') { e.preventDefault(); gridUp(); return; }
    if (e.key === 'Delete' && gridSelectionShown()) {
      e.preventDefault(); confirmTrash([...state.grid.selection]); return;
    }
  }
  // Feature 6 — keyboard navigation in the treemap / sunburst view.
  if (state.view === 'treemap' && !typing && !mod && state.treemap.rootPath
      && !state.treemap.history.active && !tmPreview.on && !tmMapKeyYields(e)) {
    switch (e.key) {
      case '/': e.preventDefault(); $('tmSearch').focus(); return;
      case 'h': case 'ArrowLeft': case 'Backspace': e.preventDefault(); tmMapTakeFocus(); kbUp(); return;
      case 'j': case 'ArrowDown': e.preventDefault(); tmMapTakeFocus(); kbMove(1); return;
      case 'k': case 'ArrowUp': e.preventDefault(); tmMapTakeFocus(); kbMove(-1); return;
      case 'l': case 'ArrowRight': case 'Enter': e.preventDefault(); tmMapTakeFocus(); kbDrill(); return;
      case 'Delete':
        // Synthetic Trash cell and in-archive entries can't be trashed.
        if (state.treemap.kbSel && !state.treemap.kbSel.isTrash && !state.treemap.kbSel.virtual) {
          e.preventDefault(); confirmTrash([state.treemap.kbSel.path]);
        }
        return;
      case 'c': if (state.treemap.kbSel) { e.preventDefault(); cartToggle(state.treemap.kbSel.path); } return;
      case 'p': if (state.treemap.kbSel && state.treemap.kbSel.type === 'file') { e.preventDefault(); openPreview(state.treemap.kbSel); } return;
      case 'n': if (state.treemap.kbSel && state.treemap.kbSel.type === 'dir' && !state.treemap.kbSel.isTrash && !state.treemap.kbSel.virtual) { e.preventDefault(); openNoteDialog(state.treemap.kbSel); } return;
    }
  }
  if (e.key === 'Escape') {
    // The TOPMOST sheet, not the first in DOM order: stacking a confirmation
    // on Settings and pressing Escape closed Settings underneath it.
    const openModal = topModal();
    if (openModal) {
      // The palette promises to restore focus (§9.1); the generic class
      // removal would close it without keeping that promise.
      if (openModal.id === 'cmdkModal') { cmdkClose(); return; }
      closeModal(openModal.id); // one funnel — per-modal teardown lives there
      return;
    }
    // Focus goes back to whatever opened the menu, not to <body> (QA-6 review MEDIUM-1).
    if ($('ctxMenu').style.display === 'block') { ctxMenuFocusOpener(hideCtxMenu()); return; }
    // The drawer sits OVER the map, so it is the thing Escape means: before
    // this, Escape climbed a folder behind an open cart and left it open.
    if ($('cartDock').classList.contains('open')) { cartDockToggle(false, { focus: true }); return; }
    if (previewIsOpen()) { closePreview(); return; }
    if (typing && document.activeElement === $('gridSearch') && $('gridSearch').value) {
      $('gridSearch').value = ''; state.grid.query = ''; renderGrid(); return;
    }
    if (typing && document.activeElement === $('tmSearch') && $('tmSearch').value) {
      $('tmSearch').value = '';
      // Cancel FIRST. Setting .value programmatically fires no input event, so
      // the timer armed by the last real keystroke survived and fired
      // tmApplyQuery('size>1gb') afterwards — dimming the map and printing
      // "N matches" under a visibly empty box.
      tmCancelQueries();
      tmApplyQuery('');
      return;
    }
    // §4.3 — ahead of "go up one folder", so Escape always means "get me out
    // of the thing I am in" rather than navigating a hypothetical map.
    if (state.view === 'treemap' && tmPreview.on) { exitCartPreview(); return; }
    if (state.view === 'treemap' && state.treemap.history.active) {
      const slider = $('tmTimeSlider');
      slider.value = slider.max;
      setHistoryIndex(Number(slider.max)); // Escape brings you back to Live
      return;
    }
    if (state.view === 'treemap' && state.treemap.kbSel) {
      state.treemap.kbSel = null; presentView(); hideTooltip(); return;
    }
    if (state.view === 'treemap' && state.root && state.treemap.rootPath !== state.root.path) {
      treemapUp();
      return;
    }
    // §6.1 asks for "Escape to climb out", and this is the only place that
    // implements it. It used to live on `cityOnKey`, bound to the CANVAS, so
    // it fired only once the canvas had focus — and nothing focuses it on
    // entering the view. Arriving at Disk City and pressing Escape did
    // nothing at all, while every other view's Escape works without a click
    // first. The canvas binding keeps the arrow-key panning and the zoom
    // keys, which are canvas gestures; this key is not.
    if (state.view === 'city') { cityUp(); return; }
    if (state.view === 'grid') {
      // Clear's own door: focus that was in the selection bar comes back to
      // the grid instead of falling to <body> with it (B13 review F1.8).
      if (state.grid.selection.size) { gridClearSelection(); return; }
      gridUp();
      return;
    }
    /* v4 §9.2 — LAST, after every other Escape meaning has had its chance.
       The tour's first cut lived on its own document listener, and the same
       press that climbed the map (or closed the preview, or cleared the
       highlight box) ALSO threw the tour away — it died on its own "press
       Esc to climb back out" instruction. One press, one meaning: only a
       bare Esc that nothing above claimed skips the tour. */
    if (tour.active && !$('tourOverlay').hidden && $('nlPop').hidden && !typing) {
      void tourFinish('Tour skipped — reset it any time in Settings');
    }
  }
});

/* ───────────────────────────── Desktop integration ───────────────────────────── */
/* In the Electron build, a preload bridge (window.treemapDesktop) lets us
   resolve dropped files to real paths and receive dock-drop / CLI scans. */
if (window.treemapDesktop) {
  window.treemapDesktop.onScanPath((p) => {
    if (!p) return;
    $('pathInput').value = p;
    // The same queue the window's own drop uses: the dock and the CLI can
    // hand over several folders in a burst, and a scan already running must
    // not swallow the rest.
    queueScan(p);
  });
}
/* ── Drop a folder to scan it ── */
/* Two things the old handler did not do. It gave no sign it was willing to
   take the drop — the window looked inert until the folder was already
   released — and it read `files[0]` and dropped the rest on the floor, so a
   stack of four folders scanned one and silently forgot three.

   The hint is counted, not toggled: `dragenter` and `dragleave` fire again
   for every child element the pointer crosses, so a bare toggle flickers the
   whole way across the window. Only a drag carrying FILES lights it — the
   cart drags its own rows around, and those must leave the page alone. */
let dragDepth = 0;
const dragHasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
function showDropHint(on) {
  if (on) document.documentElement.classList.add('drop-hint');
  else { document.documentElement.classList.remove('drop-hint'); dragDepth = 0; }
}
window.addEventListener('dragenter', (e) => {
  if (!dragHasFiles(e)) return;
  dragDepth++;
  showDropHint(true);
});
window.addEventListener('dragleave', (e) => {
  if (!dragHasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) showDropHint(false);
});
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  showDropHint(false);
  const files = (e.dataTransfer && e.dataTransfer.files) || [];
  if (!files.length) return;
  if (!window.treemapDesktop) {
    toast('Drag & drop scanning works in the desktop app — use Browse here', 'error');
    return;
  }
  // Resolved in the order they were dropped, then queued in that order: the
  // queue starts the first and tells the user about the rest.
  for (const file of files) {
    const raw = window.treemapDesktop.getPathForFile(file);
    const dir = raw ? await window.treemapDesktop.resolveScanPath(raw) : null;
    if (dir) queueScan(dir);
  }
});
/* ── end drop ── */

/* ── The start screen (the owner, 17 Oct 2026) ──
   "When you open TreeMap it automatically runs a scan of the entire disk but
   ideally users should be able to pick the folder for example desktop or if
   they actually want a full disk scan." Nothing is scanned because the app
   opened: the empty state that stands in for every view that needs a scan
   offers what to scan, and the person picks. renderEmptyState (020) paints it
   each time it comes up; the system answer, the disk layout's names and the
   boot restore paint it again as each arrives. */

/* Declared before the boot below paints the first view, which paints the
   start screen: a `let` or `const` read before its declaration throws, and
   would stop the page script there (tests/coreScanFlow.test.ts). */
/** The folders under the home folder the start screen offers, in order, by their names on disk. */
const START_FOLDERS = ['Desktop', 'Documents', 'Downloads'];

/** Whether the disk layout has been asked for the drives' names this page load (startNameDrives). */
let startDrivesAsked = false;
/** The choices on screen, and the markup they were painted from: a paint that would change nothing leaves the buttons in place. */
let startShown = [];
let startPainted = null;
/**
 * Whether the rules let a scan start at each folder the start screen would
 * offer, as the server judges it — GET /api/policy?scanRoot=, the gates
 * POST /api/scan applies before it walks (agent-policy.json's allowedRoots,
 * where a link leads, the path rules): folder → { allowed, error }, the
 * refusal's words when not (review F3.2). A folder is offered once it is
 * judged allowed; one the server could not be asked about is offered as the
 * server found it, as before (startJudge).
 */
let startVerdicts = new Map();
/** The folders asked about whose answer has not come. */
let startAsking = new Set();

/** A folder's name on the start screen: a whole drive by the folder picker's name for it — the startup disk's own, "Macintosh HD" — anything else by its last name. */
function startFolderName(p, drives) {
  const drive = drives.find((d) => d.path === p);
  return drive ? drive.name : lastPathSegment(p);
}

/**
 * The start screen's choices, in order, each { path, name, icon, sub, again,
 * drive }: the folder `last` names first — never a cloud account's: the
 * restore and noteLastFolder keep those out — as "Scan … again", when the server
 * can open it — with its size and date when a scan of it finished; then
 * Desktop, Documents, Downloads and the home folder, only as the server found
 * them on this machine (GET /api/system's commonDirs, each looked at there,
 * as the folder picker's shortcuts are); then each whole drive as the folder
 * picker names it (browseWholeDrives). A folder is offered once, where it
 * comes first.
 */
function startChoiceList(sys, last, drives, refused = [], history = null) {
  const out = [];
  // A folder that answers an error is offered nowhere, under any name: every
  // folder the server refused a scan of (`refused` — a history folder that
  // cannot be opened among them, until a scan of it is taken), and the folder
  // `last` names where it is not offered. "Documents" one row below "The scan
  // of …/Documents failed: …" would only hear the same refusal (review F1.5).
  const skip = new Set(refused);
  if (last && last.path && !last.offered) skip.add(last.path);
  const add = (c) => { if (c.path && !skip.has(c.path) && !out.some((x) => x.path === c.path)) out.push(c); };
  const again = (f, extra) => {
    const sized = typeof f.size === 'number' && f.at > 0;
    add({ path: f.path, name: `Scan ${startFolderName(f.path, drives)} again`, icon: 'refresh', again: true,
      sub: sized ? `${formatBytes(f.size)} · ${formatDate(f.at)}` : '', ...extra });
  };
  if (last && last.offered && last.path) again(last, {});
  // The history's folder stays offered after another folder's scan is stopped
  // or fails — second, the stopped or failed one first (the owner, 20 Oct
  // 2026; seventh browser pass J03). `history`: it is not where focus lands.
  if (history && history.offered && history.path) again(history, { history: true });
  const home = sys && sys.homeDir;
  const dirs = sys && Array.isArray(sys.commonDirs) ? sys.commonDirs : [];
  for (const name of START_FOLDERS) {
    const d = dirs.find((p) => p !== home && lastPathSegment(p) === name);
    if (d) add({ path: d, name, icon: 'folder', sub: '' });
  }
  if (home && dirs.includes(home)) add({ path: home, name: 'Home folder', icon: 'folder', sub: '' });
  for (const d of drives) add({ path: d.path, name: d.name, icon: 'hardDrive', sub: 'Whole drive', drive: true });
  return out;
}

/**
 * The page's own words for a refusal the rules make — `v`, { code, error }:
 * a verdict of GET /api/policy?scanRoot=, or a refused scan's answer. The
 * server's sentences are written for an agent: the path printed again, "GET
 * /api/policy reports its location", "refused this operation" said to a
 * person who has done nothing (seventh browser pass J07). A refusal of any
 * other kind is the server's own sentence, which is about the folder.
 *
 * POLICY_ROOT_NOT_ALLOWED carries one of three sentences, and they are not
 * the same claim (review F1.4): a folder outside the allowed roots as named
 * (policy.ts), one that lies outside them where it really is — a folder on
 * its way leads elsewhere — and a link to a folder outside them (both
 * diskScanner.ts assertWalkAllowed). Said all as "outside", a link spelled
 * inside an allowed folder read as false, and hid why.
 */
function startRefusalWords(v) {
  if (v.code === 'POLICY_ROOT_NOT_ALLOWED') {
    const allowed = 'the folders your agent policy allows TreeMap to scan (allowedRoots in agent-policy.json)';
    const said = String(v.error || '');
    if (said.includes(' is a link to a folder outside the allowed roots')) return `it is a link to a folder outside ${allowed}`;
    if (said.includes(' lies outside the allowed roots where it really is')) return `where it really is on the disk, it lies outside ${allowed}`;
    return `it is outside ${allowed}`;
  }
  if (v.code === 'POLICY_UNREADABLE') return 'TreeMap’s agent policy file could not be read, and until it is repaired no folder on this computer can be scanned';
  return v.error || '';
}

/**
 * The sentence above the choices about the folder `last` names, or '' when
 * there is nothing to say. `refusal`: the rules' verdict ({ code, error })
 * when they do not let a scan start at a last folder the history names — it
 * is offered nowhere, and said why (review F3.2). `unreadable`: a verdict of
 * a policy file that cannot be read, which refuses every folder — said
 * whether or not a folder is named, with the file to repair, as the reason
 * only "Choose a folder…" is offered (J07).
 */
function startLastLine(last, refusal = null, unreadable = null) {
  const sentence = (s) => (/[.!?…]$/.test(s) ? s : s + '.');
  const named = !!last && !!last.path;
  if (unreadable && (!named || last.outcome === 'history')) {
    const blocked = `TreeMap can’t scan any folder on this computer until its agent policy file is repaired — ${unreadable.file || 'agent-policy.json'} could not be read.`;
    return named ? `Your last scan was of ${last.path}. ${blocked}` : blocked;
  }
  if (!named) return '';
  // Said while the Stop's cancel is out: the scan may yet prove to have finished (J02).
  if (last.outcome === 'stopping') return `Stopping the scan of ${last.path}…`;
  if (last.outcome === 'stopped') return `You stopped the scan of ${last.path}.`;
  if (last.outcome === 'unshown') return `The scan of ${last.path} had already finished when you pressed Stop, but its results could not be shown: ${sentence(last.reason || 'TreeMap could not read them')}`;
  if (last.outcome === 'unstopped') return `TreeMap could not stop the scan of ${last.path}, so it may still be running: ${sentence(last.reason || 'the server did not say why')}`;
  if (last.outcome === 'failed') return `The scan of ${last.path} failed: ${sentence(startRefusalWords({ code: last.code, error: last.reason }) || 'it did not finish')}`;
  if (!last.offered) return `Your last scan was of ${last.path}, which cannot be opened now: ${sentence(last.reason || 'TreeMap could not open it')}`;
  if (refusal) return `Your last scan was of ${last.path}, which TreeMap may not scan now: ${sentence(startRefusalWords(refusal))}`;
  if (last.outcome === 'unreadable') return `Couldn’t reopen your last scan of ${last.path} (${last.reason}).`;
  return '';
}

/**
 * Paint the start screen's line and choices from what the page holds now.
 * "Scan … again" for a scan just stopped or failed carries `start-retry`,
 * which makes it where focus lands (startLanding). A choice that held focus
 * through a repaint keeps it on its new button.
 */
function renderStartChoices() {
  const host = $('startChoices');
  const line = $('startLast');
  if (!host || !line) return;
  const sys = state.system || {};
  const last = state.lastFolder;
  const drives = browseDrivesSeen || browseWholeDrives(sys.platform, null, sys.homeDir);
  const retry = !!last && ['stopping', 'stopped', 'failed', 'unshown'].includes(last.outcome);
  // Each folder is offered once the server has said a scan may start there —
  // never one a scan would be refused, nor one still being asked about
  // (startJudge, review F3.2) — but for the folder of a scan just stopped or
  // failed: the person's own choice, offered at once as "Scan … again", focus
  // on it, while the rules are asked about it, and taken away if they refuse
  // it. Its own request, where it answered, was the rules' answer: accepted
  // (startNoteAllowed), or refused, which the start screen names (failScan).
  const candidates = startChoiceList(sys, last, drives, state.refusedPaths, state.historyFolder);
  const verdict = (p) => startVerdicts.get(p);
  const list = candidates.filter((c) => { const v = verdict(c.path); return v ? v.allowed : !!(c.again && !c.history && retry); });
  const lastVerdict = last && last.path ? verdict(last.path) : null;
  const unreadable = [...startVerdicts.values()].find((v) => !v.allowed && v.code === 'POLICY_UNREADABLE') || null;
  const words = startLastLine(last, lastVerdict && !lastVerdict.allowed ? lastVerdict : null, unreadable);
  line.textContent = words;
  line.hidden = !words;
  // One "Scan … again" carries the id focus lands by: the last folder's, never the history's beside it (J03).
  const html = list.map((c, i) => `<button class="btn start-choice${c.again ? ` start-again${retry && !c.history ? ' start-retry' : ''}` : ''}"` +
    `${c.again && !c.history ? ' id="startAgainBtn"' : ''} data-start-ix="${i}" title="${escapeHtml(c.drive ? `${c.path} — the whole drive` : c.path)}">` +
    `${icon(c.icon, 16)}<span class="start-choice-txt"><span class="start-choice-nm">${escapeHtml(c.name)}</span>` +
    `${c.sub ? `<span class="start-sub">${escapeHtml(c.sub)}</span>` : ''}</span></button>`).join('');
  if (html !== startPainted) {
    const at = document.activeElement;
    const held = at && host.contains(at) ? startShown[Number(at.getAttribute('data-start-ix'))] : null;
    host.innerHTML = html;
    startPainted = html;
    startShown = list;
    const buttons = host.querySelectorAll('[data-start-ix]');
    buttons.forEach((b) => {
      const c = list[Number(b.getAttribute('data-start-ix'))];
      b.addEventListener('click', () => scanStartChoice(c.path));
    });
    const again = held ? list.findIndex((c) => c.path === held.path) : -1;
    if (again !== -1) buttons[again].focus({ preventScroll: true });
  }
  void startJudge(candidates.map((c) => c.path));
  void startNameDrives();
  startFocusAtBoot();
}

/**
 * On a relaunch with history (state.startFocusDue, set by the restore) the
 * start screen's control takes focus: the last folder's "Scan … again" once
 * the rules have said it may be offered (startJudge repaints when they
 * answer), "Choose a folder…" until then or if they refuse it. A relaunch
 * left focus on <body>: the tour, which places it on a first run, waits for
 * someone who has scanned before until their next scan lands (eighth browser
 * pass K01). Focus the person placed meanwhile is theirs, and ends this.
 */
function startFocusAtBoot() {
  if (!state.startFocusDue) return;
  const at = document.activeElement;
  const cta = $('emptyBrowseBtn');
  if (at && at !== document.body && at !== cta && at.getClientRects().length > 0) { state.startFocusDue = false; return; }
  const last = state.lastFolder;
  if (!(last && last.offered && last.path && !startVerdicts.has(last.path))) state.startFocusDue = false; // nothing more to wait for
  const to = startLanding();
  if (to && to !== at) to.focus({ preventScroll: true });
}

/**
 * Ask the server, in one request, whether the rules let a scan start at each
 * of `paths` not yet judged nor being asked about — the gates POST /api/scan
 * applies, which only the server reads rightly (`~`, links, the Data
 * volume's spelling) — then paint the choices with the answer (review F3.2).
 * Each folder is asked about once a page load. A folder the answer does not
 * judge — the request failed, or left it out — is offered as the server
 * found it, as before: a scan of it then answers with the rules' refusal,
 * which the start screen names (failScan). Never asked again on a repaint,
 * so a server that cannot answer is not asked in a loop: only `again`, when
 * TreeMap's window is back in front, asks again about the folders the rules
 * refused (startRejudgeRefused) — and a refusal the new answer does not
 * judge stands.
 */
async function startJudge(paths, again = false) {
  const ask = [...new Set(paths)].filter((p) => (again || !startVerdicts.has(p)) && !startAsking.has(p));
  if (!ask.length) return;
  startAsking = new Set([...startAsking, ...ask]);
  let judged = new Map();
  let file = ''; // the policy file, for a refusal that asks for it to be repaired (J07)
  try {
    const body = await api('/api/policy?' + ask.map((p) => 'scanRoot=' + encodeURIComponent(p)).join('&'));
    judged = new Map((body && Array.isArray(body.scanRoots) ? body.scanRoots : []).map((v) => [v.path, v]));
    if (body && typeof body.file === 'string') file = body.file;
  } catch (e) {
    console.warn('[treemap] could not ask which folders a scan may start at:', e.message);
  }
  startAsking = new Set([...startAsking].filter((p) => !ask.includes(p)));
  startVerdicts = new Map([...startVerdicts, ...ask.map((p) => {
    const v = judged.get(p);
    if (!v && again && startVerdicts.has(p)) return [p, startVerdicts.get(p)];
    return [p, !v || v.allowed === true ? { allowed: true, error: '' } : { allowed: false, error: String(v.error || ''), code: String(v.code || ''), file }];
  })]);
  withFocusKept(() => { renderStartChoices(); });
}

/**
 * The rules may change while TreeMap waits: the start screen's own sentence
 * sends the person to repair agent-policy.json, or to widen its allowedRoots,
 * which they do in another window. When TreeMap's window is back in front,
 * every folder the rules refused is asked about again — never one they
 * allowed: a scan's own answer still judges that — and the start screen is
 * painted with what they answer now (review F1.7). The verdicts of the page's
 * load stood until a reload, and the start screen went on saying no folder
 * could be scanned, offering only "Choose a folder…", after the file was
 * repaired.
 */
function startRejudgeRefused() {
  const refused = [...startVerdicts].filter(([, v]) => !v.allowed).map(([p]) => p);
  if (refused.length) void startJudge(refused, true);
}
window.addEventListener('focus', startRejudgeRefused);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') startRejudgeRefused(); });

/**
 * The server has just accepted a scan of `path` (POST /api/scan answered with
 * its id): the rules let a scan start there, so "Scan … again" for it after a
 * Stop is offered at once, focus landing on it, without asking (review F3.2).
 */
function startNoteAllowed(path) {
  startVerdicts = new Map([...startVerdicts, [path, { allowed: true, error: '' }]]);
}

/**
 * A choice pressed: scanned as the folder picker's "Scan this folder" scans
 * — the Scan card's box names it, and startScan runs it as a person's scan
 * (interactive), with the Full Disk Access notice and the "Stay on this
 * drive" setting the Scan button's scans have. A click that lands while a
 * scan is starting — the second of a double-click, before the start screen
 * has gone — starts nothing and leaves the box naming the folder being
 * scanned: written first, the box went on naming another folder, which a
 * later Scan or Enter would have walked (review F1.12).
 */
function scanStartChoice(path) {
  if (state.scanning) return;
  $('pathInput').value = path;
  maybeShowFastRescan();
  void startScan(path);
}

/**
 * Ask the disk layout, once a page load, for the names the folder picker
 * gives the whole drives (browseWholeDrives over topologyAnswer, shared with
 * the picker through browseDrivesSeen), then paint the choices with them.
 * Off macOS and Windows the names need no layout; until it answers, and
 * where it cannot, the names that need none stand ("Startup disk").
 */
async function startNameDrives() {
  const sys = state.system || {};
  if (startDrivesAsked || browseDrivesSeen || (sys.platform !== 'darwin' && sys.platform !== 'win32')) return;
  const cap = state.capabilities && state.capabilities.volumeTopology;
  if (cap && cap.available === false) return;
  startDrivesAsked = true;
  let topo = null;
  try { topo = await topologyAnswer(false); } catch { topo = null; }
  if (!topo) return;
  if (!browseDrivesSeen) browseDrivesSeen = browseWholeDrives(sys.platform, topo, sys.homeDir);
  renderStartChoices();
}

/* ── end start screen ── */

/* ───────────────────────────── Boot ───────────────────────────── */
switchView('dashboard');
loadSystem();
// Capabilities are fetched in the background: nothing blocks the first paint on
// them, and until they arrive no view is disabled (unknown never means absent).
loadCapabilities();
// Folder notes too (v4 §9.5) — one small read; failing to load them costs
// glyphs and tooltip lines, never the app.
loadNotes();

/* Session restore. The newest completed scan still in the server's memory —
   /api/scans lists nothing else — is REOPENED: its counters and its first
   frame, painted through finishScan as its completion was, and no walk (QA
   D57: every reload used to walk the folder again). Otherwise nothing is
   walked (the owner, 17 Oct 2026, superseding B38, which scanned the newest
   folder in the history again at every relaunch — the owner's was the whole
   disk): the start screen names that folder, with its size and date, and
   offers it first among the choices, when the server can open it. Restore
   must never make boot worse: every failure is swallowed to a warn and the
   app simply starts at the start screen. */
/**
 * `?path=<folder>` — scan that folder on boot instead of restoring.
 *
 * The one way an embedder can say which folder it wants. The VS Code extension
 * frames this page in a webview, which is cross-origin to it and so cannot
 * script it: a query parameter is the only channel there is. It takes priority
 * over session restore, because someone who asked for a specific folder did not
 * ask for the last one.
 *
 * The value is only ever put in the input and passed to startScan — the same
 * two things the Browse… picker does with what it returns. Every path check
 * that matters is the server's, which refuses anything outside what it will
 * scan regardless of who asked.
 *
 * Read as every path box is (asPath): leading whitespace goes, and whitespace
 * at its end stays — it is part of a folder's name, and a trim turned
 * "Screenshots " into its sibling "Screenshots", scanned in its place (final
 * review F1.8).
 */
function requestedPath() {
  try {
    return asPath(new URLSearchParams(location.search).get('path')) || null;
  } catch { return null; }
}

async function restoreLastSession() {
  // A relaunch whose last scan was a cloud account's offers no folder from it: "Choose a folder…" takes focus,
  // as it does for a folder the rules refuse — never left on <body> (K01, review F2.10) — unless the person moved first.
  const focusStartWithNoFolder = () => {
    if (state.root || state.scanning) return;
    state.startFocusDue = true;
    startFocusAtBoot();
  };
  try {
    const wanted = requestedPath();
    if (wanted) {
      $('pathInput').value = wanted;
      maybeShowFastRescan();
      if (!state.root && !state.scanning) await startScan(wanted);
      return;
    }
    const { scans } = await api('/api/scans');
    const held = scans && scans[0];
    let last;
    if (held && held.rootPath) {
      state.scannedBefore = true;
      if (held.rootPath.startsWith('cloud://')) { focusStartWithNoFolder(); return; } // sign-in may be gone
      if (state.root || state.scanning) return;          // the user beat us to it
      const reopen = held.scanId ? await reopenScan(held) : { outcome: 'gone' };
      if (reopen.outcome === 'reopened' || reopen.outcome === 'superseded') return;
      // Gone (expired or evicted), or not reopened (review M2): named and
      // offered, never walked.
      last = { path: held.rootPath, size: held.totalSize, at: held.finishedAt,
        outcome: reopen.outcome === 'failed' ? 'unreadable' : 'history', reason: reopen.reason || '' };
    } else {
      // Nothing held: the scans expired (30 minutes after they finished), or
      // the desktop app was relaunched — they live in the server's memory and
      // die with it. The history on disk still names the folder last scanned
      // (B38). Only an empty — or unreadable — history is a first run.
      const history = await api('/api/snapshots').catch(() => null);
      const newest = history && Array.isArray(history.roots) ? history.roots[0] : null;
      if (!newest || !newest.rootPath) return;          // true first run
      state.scannedBefore = true;
      if (newest.rootPath.startsWith('cloud://')) { focusStartWithNoFolder(); return; } // a cloud account is not offered from here
      last = { path: newest.rootPath, size: newest.latestSize, at: newest.latestAt, outcome: 'history', reason: '' };
    }
    // Offered only where the server can open it — the picker's own listing
    // endpoint: a moved or deleted folder is named with why, never offered.
    let offered = true;
    try {
      await api('/api/fs/list?path=' + encodeURIComponent(last.path));
    } catch (e) {
      offered = false;
      last.reason = (e && e.message) || '';
      // Offered nowhere, under any name, however the start screen comes back —
      // after another folder's Stop too — until a scan of it is taken (review F2.5).
      state.refusedPaths = [...(state.refusedPaths || []).filter((x) => x !== last.path), last.path];
    }
    // Offered after another folder's scan is stopped or fails, too (J03).
    state.historyFolder = { ...last, offered };
    // The person moved first — a scan started, or one stopped, which names its own folder.
    if (state.root || state.scanning) return;
    if (!state.lastFolder) state.lastFolder = state.historyFolder;
    // The start screen's control takes focus as it is offered (startFocusAtBoot, K01).
    state.startFocusDue = true;
    renderStartChoices(); // a choice holding focus keeps it, on its new button
  } catch (e) {
    console.warn('[treemap] session restore skipped:', e.message);
  } finally {
    // The tour waits for this answer: whether this person has scanned before (170).
    tourBootSettled();
  }
}

/**
 * The Scan card names the folder the restore puts on screen (QA D66). Left to
 * loadSystem it said the home folder beside a map of another, and Scan or
 * Enter would have walked the home folder. Not while the person is typing in
 * it: what they typed is what Scan should take.
 */
function showRestoredPath(p) {
  const box = $('pathInput');
  if (document.activeElement === box) return;
  box.value = p;
  maybeShowFastRescan();
}

/**
 * Reopen a completed scan the server still holds (QA D57): its counters from
 * /stats, its tree from /result — the same first frame its stream carried —
 * painted through finishScan, which is told it is a reopening (no "Scan
 * complete", and when it finished). Answers `{ outcome }`: 'reopened';
 * 'superseded' when the person started something while it was being
 * fetched, which then owns the screen; 'gone' when the record is no longer
 * there (a 404: expired or evicted); or 'failed', with the `reason`, when the
 * asking failed in a way that says nothing about whether the scan is still
 * held (review M2). Either way the caller walks nothing: the start screen
 * names the folder and offers it, and says which (the owner, 17 Oct 2026).
 */
async function reopenScan(last) {
  const id = encodeURIComponent(last.scanId);
  const unreadable = 'the server’s answer could not be read';
  let stats;
  let result;
  try {
    const body = await api(`/api/scan/${id}/stats`);
    if (!body) return { outcome: 'failed', reason: unreadable };
    const { scanId: _scanId, status, ...rest } = body;
    if (status !== 'complete') return { outcome: 'gone' };
    stats = rest;
    result = await api(`/api/scan/${id}/result`);
  } catch (e) {
    if (e && (e.status === 404 || e.code === 'SCAN_NOT_FOUND')) return { outcome: 'gone' };
    return { outcome: 'failed', reason: (e && e.message) || unreadable };
  }
  if (!result) return { outcome: 'failed', reason: unreadable };
  if (result.status !== 'complete' || !result.root) return { outcome: 'gone' };
  if (state.root || state.scanning) return { outcome: 'superseded' };
  state.scanId = last.scanId;
  showRestoredPath(last.rootPath);
  await finishScan(result.root, stats.durationMs, stats, { reopenedAt: last.finishedAt || Date.now() });
  return { outcome: 'reopened' };
}
void restoreLastSession();

/* Debug/testing handle. Deliberately read-mostly and namespaced: the app's own
   state and view registry are script-scoped `const`s, which are not reachable
   from outside the script — so an end-to-end check could not otherwise assert
   which view is mounted or what the registry contains. */
window.TreeMap = {
  get state() { return state; },
  // The live registry, not a copy: capability gating has no consumer among the
  // original ten views (none of them depend on a platform mechanism), so the
  // only way to prove that machinery works before its first real consumer
  // arrives is to register a probe view against it.
  get views() { return VIEWS; },
  get mountedView() { return mountedView && mountedView.id; },
  registerView,
  switchView,
  subscribe,
  emit,
  TOPIC,
  applyCapabilitiesToTabs,
  Canvas2D,
  formatBytes,
  // Hover-driven UI cannot be exercised from outside: the treemap's mousemove
  // handler does its work inside a requestAnimationFrame callback, and rAF does
  // not fire while the window is occluded — so a synthetic mousemove reaches
  // nothing. Exposing the tooltip lets its content be asserted directly.
  showTooltip,
  allocationTooltipLine,
  resolveAllocation,
  // Same reason: the preview pane opens from a canvas double-click, a context
  // menu or a keyboard shortcut, none of which a synthetic event can drive in an
  // occluded window — so the provenance strip (§C3) could not otherwise be
  // asserted against a real file.
  openPreview,
};

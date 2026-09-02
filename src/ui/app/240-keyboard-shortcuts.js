/* ───────────────────────────── Keyboard shortcuts ───────────────────────────── */
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
  if (mod && (e.key === 'Backspace' || e.key === 'Delete')) {
    if (!typing && state.grid.selection.size) { e.preventDefault(); confirmTrash([...state.grid.selection]); }
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
  // Plain Backspace / Delete in the grid — never while typing, and the
  // Cmd/Ctrl-modified variants above keep working exactly as before.
  if (!mod && !typing && state.view === 'grid' && state.root) {
    if (e.key === 'Backspace') { e.preventDefault(); gridUp(); return; }
    if (e.key === 'Delete' && state.grid.selection.size) {
      e.preventDefault(); confirmTrash([...state.grid.selection]); return;
    }
  }
  // Feature 6 — keyboard navigation in the treemap / sunburst view.
  if (state.view === 'treemap' && !typing && !mod && state.treemap.rootPath
      && !state.treemap.history.active && !tmPreview.on) {
    switch (e.key) {
      case '/': e.preventDefault(); $('tmSearch').focus(); return;
      case 'h': case 'ArrowLeft': case 'Backspace': e.preventDefault(); kbUp(); return;
      case 'j': case 'ArrowDown': e.preventDefault(); kbMove(1); return;
      case 'k': case 'ArrowUp': e.preventDefault(); kbMove(-1); return;
      case 'l': case 'ArrowRight': case 'Enter': e.preventDefault(); kbDrill(); return;
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
    if ($('ctxMenu').style.display === 'block') { hideCtxMenu(); return; }
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
      if (state.grid.selection.size) { state.grid.selection.clear(); updateSelectionBar(); renderGridWindow(true); return; }
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

/* ───────────────────────────── Boot ───────────────────────────── */
switchView('dashboard');
loadSystem();
// Capabilities are fetched in the background: nothing blocks the first paint on
// them, and until they arrive no view is disabled (unknown never means absent).
loadCapabilities();
// Folder notes too (v4 §9.5) — one small read; failing to load them costs
// glyphs and tooltip lines, never the app.
loadNotes();

/* Session restore: the app opens where it left off. The newest completed scan
   comes back through the exact path the Scan button takes — painted instantly
   from the live index when it can be, with the reconciling rescan running
   quietly underneath. The welcome screen is only for true first runs. Restore
   must never make boot worse: every failure is swallowed to a warn and the
   app simply starts empty, exactly as before this feature existed. */
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
 */
function requestedPath() {
  try {
    const p = new URLSearchParams(location.search).get('path');
    return p && p.trim() ? p.trim() : null;
  } catch { return null; }
}

async function restoreLastSession() {
  try {
    const wanted = requestedPath();
    if (wanted) {
      $('pathInput').value = wanted;
      maybeShowFastRescan();
      if (!state.root && !state.scanning) await startScan(wanted);
      return;
    }
    const { scans } = await api('/api/scans');
    const last = scans && scans[0];
    if (!last || !last.rootPath) return;               // true first run
    if (last.rootPath.startsWith('cloud://')) return;  // sign-in may be gone
    if (state.root || state.scanning) return;          // the user beat us to it
    // Pre-flight with the picker's own listing endpoint, so a moved or
    // deleted folder falls back to the welcome screen instead of a boot error.
    await api('/api/fs/list?path=' + encodeURIComponent(last.rootPath));
    if (state.root || state.scanning) return;
    await startScan(last.rootPath);
  } catch (e) {
    console.warn('[treemap] session restore skipped:', e.message);
  }
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

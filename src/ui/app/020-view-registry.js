/* ───────────────────────────── View registry (§3.4) ─────────────────────────────
   Every view — the original ten and everything added later — is registered
   here as { id, label, icon, needsScan, mount, unmount, onScanChange,
   capabilityKey }. Tab switching calls unmount() on the outgoing view and
   mount() on the incoming one. There is exactly ONE navigation mechanism: no
   view is reachable through a second path, and no per-view branch survives
   inside switchView.

   Why unmount() is not ceremony: the Duplicates view polls the hashing job on a
   700 ms self-rescheduling timer, and before this registry existed, navigating
   away left that timer running against the server until the job happened to
   finish. Live activity mode holds two intervals and an animation frame with
   the same problem. Each view now stops what it started.

   `capabilityKey` names an entry in /api/platform/capabilities. A view that
   declares one is disabled — with the capability's own human-readable reason
   shown on its tab — rather than rendering an empty panel (§2.2, §3.5 state 5).
   No view has to plumb capability handling itself.                            */

const tabs = document.querySelectorAll('.tabbar button');

const VIEWS = [
  {
    id: 'dashboard', label: 'Dashboard', icon: 'dashboard', needsScan: true,
    mount() {
      // Painted by finishScan; on re-entry only the chart handles need
      // rebuilding — unmount destroyed them and their data is still in state.
      // Mid-scan the skeletons are the honest state — but the ring teardown
      // below empties the legend, so a re-entry puts the skeleton back.
      if (state.scanning) {
        if (!$('donutLegend').childElementCount) $('donutLegend').innerHTML = skeletonRows(5, 24);
        fxDonutLoadingSync(true);
        return;
      }
      if (state.types.length) { state.donut.animated = false; renderDonut(); }
      renderBudgetWidget();
      // The wear gauge rebuilds from the held report — without this, the
      // canvas would sit on its dead raster from before the unmount.
      if (state.driveHealth) renderDriveHealth();
    },
    unmount() {
      // Chart handles are live rAF/observer clients — the registry's rule
      // (a view stops what it started) applies to them exactly as to timers.
      if (donutHandle) { donutHandle.destroy(); donutHandle = null; }
      fxBudgetGaugesDrop();
      fxDriveGaugeDrop();
    },
  },
  {
    id: 'treemap', label: 'Treemap', icon: 'treemap', needsScan: true,
    // A new scan invalidates the drill-in path: it belongs to the previous
    // scan's tree, and reusing it would either render the wrong folder or
    // silently fail to find it. Resetting here is why mount() can now be the
    // single load path.
    onScanChange() {
      state.treemap.rootPath = state.root ? state.root.path : null;
      exitHistoryState();
    },
    mount() {
      // FX: pinned Lens / persisted Diff and the rest survive an unmount in
      // state; re-entry re-lights their sm rings. Above the scan guard on
      // purpose — with nothing scanned every state is false and this is the
      // cheap all-off no-op.
      fxTmPillBeamsSync(true);
      if (!state.scanId || !state.root) return;
      if (!state.treemap.rootPath) state.treemap.rootPath = state.root.path;
      loadSavedViews(); // Phase 2 §2.4 — the chip strip, fetched lazily on entry
      refreshDock(); // §8.3 — connected drives, fetched lazily on entry like the chips
      loadTreemap(state.treemap.rootPath);
    },
    unmount() {
      // Phase 2: stop the debounce, invalidate anything already in flight, and
      // clear the message. Without the invalidation a reply landed after the
      // view was gone, re-painted a hidden canvas, and left tmQueryErr visible
      // so the NEXT entry resurrected the bar with a query from two views ago.
      tmCancelQueries();
      tmCloseHints();
      tmClearHits();
      // §9.6 — the plain-words popover is position:fixed and anchored to a
      // button this view owns; left open it would resurface at stale
      // coordinates over whatever view comes next (each view stops what it
      // started — the registry's own rule).
      nlClose({ focusButton: false });
      exitCartPreview(true); // §4.3 — never come back to a banner over a real map
      tmSetQueryMessage('', false);
      $('tmQueryBar').hidden = true;
      // Live mode keeps two intervals and a rAF loop alive; leaving the view
      // without stopping them means the app keeps re-laying-out a canvas
      // nobody is looking at. `keepWanted` preserves the user's intent so the
      // toggle is still on when they come back.
      if (state.live.on) disableLive({ keepWanted: true });
      // tmAnimFrame is declared further down with `let`; unmount only ever runs
      // after the whole script has evaluated, so it is in scope by then.
      if (tmAnimFrame) { cancelAnimationFrame(tmAnimFrame); tmAnimFrame = 0; }
      // §6.2's level transition, §6.3's lasso and §6.4's lens are all state
      // that would otherwise survive into the next view: a rAF loop repainting
      // a hidden canvas, a half-drawn selection, and a magnifier still held.
      // §2.5's refinement loop is the same shape of leak and leaves by the
      // same door.
      if (state.treemap.altZoomRaf) { cancelAnimationFrame(state.treemap.altZoomRaf); state.treemap.altZoomRaf = 0; }
      altRefineCancel();
      state.treemap.altZoom = null;
      // §7.1's playback is the same shape of leak — a rAF loop repainting a
      // canvas nobody is looking at — and leaves by the same door.
      lapseStop();
      // A resize that lands after the view is gone would solve a layout for a
      // canvas nobody is looking at, and paint it there.
      clearTimeout(tmResizeDeb);
      // And the drawn set goes with the view, exactly as Disk City's blocks do.
      // These are the shapes §6.2 solved for a canvas that is no longer on
      // screen — each holding a polygon and a node — and `mount` rebuilds them
      // on the way back in. Keeping them is the leak the registry exists to
      // close; the only reason it went unnoticed is that they are small.
      state.treemap.cells = [];
      state.treemap.altNote = '';
      lassoCancel();
      state.lens.held = false;
      state.lens.at = null;
      // FX: the mode pills' sm rings die with the view — `false` is explicit
      // because state.view still reads 'treemap' while this unmount runs.
      fxTmPillBeamsSync(false);
    },
  },
  {
    id: 'grid', label: 'Grid', icon: 'grid', needsScan: true,
    // Same reasoning as the treemap: the browsed folder came from the old tree.
    onScanChange() { state.grid.path = state.root ? state.root.path : null; },
    mount() {
      if (!state.root) return;
      if (!state.grid.path || !state.pathIndex.has(state.grid.path)) state.grid.path = state.root.path;
      renderGrid();
    },
  },
  {
    id: 'apps', label: 'Apps', icon: 'box', needsScan: true,
    mount() { if (state.scanId && state.root) loadApps(); },
    unmount() {
      // The scatter handle is a live client (tooltip, listeners, observer);
      // it dies with the view and mount()'s render path rebuilds it.
      appsScatterDrop();
    },
  },
  {
    id: 'games', label: 'Libraries', icon: 'play', needsScan: true,
    mount() { if (state.scanId && state.root) { loadGames(); loadMedia(); } },
    onScanChange() { state.games.loadedFor = null; state.media.loadedFor = null; },
  },
  {
    id: 'security', label: 'Security', icon: 'shield', needsScan: true,
    mount() { if (state.scanId && state.root) loadSecurity(); },
    onScanChange() { state.security.loadedFor = null; },
  },
  {
    // Needs no scan: it is about other machines, not this folder.
    id: 'fleet', label: 'Fleet', icon: 'globe', needsScan: false,
    mount() { loadFleet(); },
    unmount() { clearTimeout(state.fleet.timer); state.fleet.timer = 0; },
  },
  {
    id: 'duplicates', label: 'Duplicates', icon: 'copy', needsScan: true,
    mount() {
      if (!state.root) return; // nothing scanned at all — the welcome screen is up
      // A tree with no scan behind it (index-painted, or a rescan the user
      // stopped) is not a reason to leave the markup's "Scanning for
      // duplicates…" standing over an empty card. Both panes, because the
      // segmented control switches between them without remounting.
      if (!state.scanId) { dupNeedsScan(); ndNeedsScan(); return; }
      if (isCloudScan()) {
        // Duplicate detection reads file contents, and a cloud scan never
        // downloads any — so this is genuinely unavailable rather than empty,
        // and says which account it is unavailable for (§3.5 state 5).
        const provider = cloudProviderOfScan();
        const msg = `<div class="card glass"><div class="muted" style="display:flex;align-items:center;gap:8px;padding:10px 2px;">${icon('cloud', 15)} Duplicate detection reads file contents, and cloud scans never download any — it's disabled for ${escapeHtml(provider.name)}.</div></div>`;
        $('dupBody').innerHTML = msg;
        $('ndBody').innerHTML = msg;
        $('dupSummary').textContent = 'Not available for cloud scans.';
        $('ndSummary').textContent = 'Not available for cloud scans.';
        return;
      }
      if (state.dupMode === 'near') loadNearDupes(); else loadDuplicates();
    },
    unmount() {
      // The leak this registry exists to close: both finders reschedule
      // themselves every 700 ms until the job completes, whether or not anyone
      // is watching.
      clearTimeout(state.dup.pollTimer); state.dup.pollTimer = 0;
      clearTimeout(state.near.pollTimer); state.near.pollTimer = 0;
      // The solving orb is the same shape of leak — a mounted orb is a live
      // rAF client — and leaves by the same door. The progress card's ring
      // with it: the card outlives the view only as hidden DOM.
      fxOrbHide('dup');
      fxHuntBeamSync('dupBody', false);
      // So is the reclaim funnel: a view stops what it started. The selection
      // survives in state; a re-entry's updateDupToolbar rebuilds the funnel.
      dupFunnelDrop();
      // Hiding a view does not free it. A big near-duplicate result left tens of
      // thousands of nodes and ~1,500 cart buttons in the document, and every
      // later cart click in every other view paid for them.
      ndClearBody();
    },
  },
  // Trends, Compare and Offloaded read persisted history, so they work with no
  // scan loaded at all — which is why they never show the empty state.
  {
    id: 'trends', label: 'Trends', icon: 'trendUp', needsScan: false,
    mount() { loadTrends(); },
    unmount() {
      // The area handle is a live client (tooltip node, listeners, observer);
      // it dies with the view and mount()'s loadTrends rebuilds it from disk.
      if (trendHandle) { trendHandle.destroy(); trendHandle = null; }
      // The net-change strip is the same shape of client, by the same door.
      if (trendNetHandle) { trendNetHandle.destroy(); trendNetHandle = null; }
    },
  },
  { id: 'offloaded', label: 'Offloaded', icon: 'archive', needsScan: false, mount() { loadOffloadIndex(); } },
];

const VIEW_BY_ID = new Map();

/**
 * Register a view. The only supported way to add one.
 *
 * The lookup map and the ordered list are updated together here because
 * keeping them in sync by hand does not work: pushing to `VIEWS` alone leaves
 * `VIEW_BY_ID` stale, and `switchView` then silently does nothing for the new
 * view — it takes the "unknown view" early return, so the tab appears to be
 * dead rather than broken. Every view added from Phase 1 onward goes through
 * this.
 */
function registerView(view) {
  if (!view || !view.id) throw new Error('a view needs an id');
  if (VIEW_BY_ID.has(view.id)) {
    // Replace in place rather than appending a duplicate, so a re-registration
    // during development cannot leave two entries answering to one id.
    const at = VIEWS.findIndex(v => v.id === view.id);
    if (at !== -1) VIEWS[at] = view;
  } else {
    VIEWS.push(view);
  }
  VIEW_BY_ID.set(view.id, view);
  return view;
}

for (const view of [...VIEWS]) VIEW_BY_ID.set(view.id, view);

/** The view currently mounted, so switchView knows what to unmount. */
let mountedView = null;

/**
 * Is this view usable right now, and if not, why not?
 * Returns null when usable, or a human-readable reason when it is not.
 */
function viewBlockedReason(view) {
  if (!view.capabilityKey) return null;
  const caps = state.capabilities;
  if (!caps) return null; // not yet known — never disable on missing information
  const cap = caps[view.capabilityKey];
  if (!cap || cap.available) return null;
  return cap.reason || 'This feature is not available on this computer.';
}

function switchView(name) {
  const view = VIEW_BY_ID.get(name);
  if (!view) return;

  // FX: captured BEFORE the visibility toggles below. An entry is hidden →
  // shown — a real navigation, or the empty state giving way to the first
  // scan — which is what separates it from the data refreshes that re-call
  // switchView with the view already up: those must never replay the
  // entrance choreography.
  const viewEl = $('view-' + name);
  const wasHidden = !viewEl || viewEl.hidden;

  // Tear down the outgoing view before the incoming one starts, so the two
  // never hold the same timers or canvas at once.
  if (mountedView && mountedView.id !== name && typeof mountedView.unmount === 'function') {
    try { mountedView.unmount(); }
    catch (err) { console.error('[treemap] unmount of "' + mountedView.id + '" failed:', err); }
  }

  state.view = name;
  const blocked = viewBlockedReason(view);
  const empty = !blocked && view.needsScan && !state.root && !state.scanning;

  tabs.forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === name)));
  document.querySelectorAll('.view').forEach(v => {
    const on = !empty && !blocked && v.id === 'view-' + name;
    v.classList.toggle('active', on);
    v.hidden = !on;
  });
  hideTooltip(); hideCtxMenu();
  $('emptyState').style.display = empty ? 'flex' : 'none';
  // FX: the zero-state CTA halo lives and dies with the welcome screen, and
  // the scan hero follows the active view — both are functions of the state
  // this function just set. The hover ring goes too: a keyboard view switch
  // moves no pointer, and the card it sat on is hidden DOM now.
  fxEmptyCtaSync(empty);
  fxScanHeroSync();
  fxHoverSync(null);
  renderCapabilityNotice(view, blocked);

  if (empty || blocked) { mountedView = view; return; }

  mountedView = view;
  // A view failing to mount disables itself, and must not take the app with it.
  try { view.mount(); }
  catch (err) {
    console.error('[treemap] mount of "' + name + '" failed:', err);
    toast('The ' + view.label + ' view could not be opened.', 'error');
  }
  // FX: the entrance runs only on the entry this very call revealed — after
  // mount, so cards a synchronous mount painted are part of the choreography.
  if (wasHidden && viewEl && !viewEl.hidden) fxViewEnter(viewEl);
}

/**
 * The *unavailable* state (§3.5 #5) for a capability-gated view: the specific
 * reason, never a blank panel.
 */
function renderCapabilityNotice(view, reason) {
  let host = $('capabilityNotice');
  if (!host) {
    host = document.createElement('div');
    host.id = 'capabilityNotice';
    host.className = 'card glass';
    host.style.cssText = 'display:none;margin:18px auto;max-width:640px;padding:18px 20px;';
    host.setAttribute('role', 'status');
    const main = document.querySelector('main') || document.body;
    main.appendChild(host);
  }
  if (!reason) { host.style.display = 'none'; return; }
  host.innerHTML =
    `<div style="display:flex;gap:10px;align-items:flex-start;">${icon('alert', 18)}` +
    `<div><b>${escapeHtml(view.label)} isn’t available on this computer</b>` +
    `<div class="muted" style="margin-top:6px;line-height:1.5;">${escapeHtml(reason)}</div></div></div>`;
  host.style.display = 'block';
}

/** Reflect capability changes onto the tab bar itself. */
function applyCapabilitiesToTabs() {
  for (const view of VIEWS) {
    const btn = [...tabs].find(b => b.dataset.view === view.id);
    if (!btn) continue;
    const reason = viewBlockedReason(view);
    btn.classList.toggle('tab-unavailable', Boolean(reason));
    if (reason) btn.title = reason; else btn.removeAttribute('title');
  }
  // A blocked view that is currently open must re-render into its notice.
  if (state.view) switchView(state.view);
}

tabs.forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));

/* A completed scan is a state change every view reacts to, rather than
   something finishScan pokes into each panel by hand. */
subscribe(TOPIC.scan, (scanId) => {
  for (const view of VIEWS) {
    if (typeof view.onScanChange === 'function') {
      try { view.onScanChange(scanId); }
      catch (err) { console.error('[treemap] onScanChange for "' + view.id + '" failed:', err); }
    }
  }
});

subscribe(TOPIC.capabilities, applyCapabilitiesToTabs);

/* A3 — the "All Storage" strip reports how much of the last scan is not
   actually on this machine, so it has to repaint when a scan lands. It renders
   on load from the cloud-account list, which happens long before any scan. */
subscribe(TOPIC.scan, () => {
  if (typeof renderAllStorage === 'function') renderAllStorage();
});

/**
 * Platform capabilities (§2.2). Loaded once at start-up; failure is not fatal,
 * because every view treats "capabilities unknown" as "do not disable anything".
 */
async function loadCapabilities() {
  try {
    const res = await api('/api/platform/capabilities');
    state.capabilities = res.capabilities || null;
  } catch {
    state.capabilities = null; // unknown — views stay enabled rather than hiding
  }
  // Emitted on failure too: subscribers that can get their own answer from the
  // server (the topology card asks it directly and renders its 409 reason)
  // must not stay stuck on a skeleton because this one request failed.
  emit(TOPIC.capabilities, state.capabilities);
}

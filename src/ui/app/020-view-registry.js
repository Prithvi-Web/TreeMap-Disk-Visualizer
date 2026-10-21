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
      if (!state.root) return;
      if (!state.treemap.rootPath) state.treemap.rootPath = state.root.path;
      // A tree with no scan behind it — the saved index's, painted before its
      // scan lands, or left on screen by a Stop — is drawn all the same,
      // laid out from that tree (loadTreemap). Returning here left a blank
      // canvas under the tree's name (seventh browser pass, J05). What asks
      // the scan itself waits for one: not the scan running behind the
      // tree, whose id is on hand once its request answers, and which
      // answers nothing until it lands (treeScanId, review F1.5).
      // The highlight box's query typed over it says again what it waits for (review F1.2).
      if (!treeScanId()) { loadTreemap(state.treemap.rootPath); tmRejudgeQueryWait(); return; }
      loadSavedViews(); // Phase 2 §2.4 — the chip strip, fetched lazily on entry
      refreshDock(); // §8.3 — connected drives, fetched lazily on entry like the chips
      loadTreemap(state.treemap.rootPath);
      // C11 — a query a previous scan of this folder answered is asked of
      // this one. Not while a scan runs: the tree on screen is still the one
      // its query answered, and the running scan answers a query 409
      // SCAN_RUNNING — its highlights cleared and an error said over a tree
      // they were right for (review F2.5). finishScan re-enters this view
      // once the scan lands, and it is asked then.
      if (!state.scanning) tmRejudgeQuery();
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
  // Apps, Libraries and Security read a report of the scan the tree on screen
  // came from (treeScanId). Each loader asks it, or — over the saved index's
  // tree, which no scan stands behind — says why there is nothing yet: keyed
  // on the scan on hand, a rescan's view asked the scan still walking (409),
  // and after a Stop kept another folder's report on screen (BQJ-1b).
  {
    id: 'apps', label: 'Apps', icon: 'box', needsScan: true,
    mount() { if (state.root) loadApps(); },
    unmount() {
      // The scatter handle is a live client (tooltip, listeners, observer);
      // it dies with the view and mount()'s render path rebuilds it.
      appsScatterDrop();
    },
  },
  {
    id: 'games', label: 'Libraries', icon: 'play', needsScan: true,
    mount() { if (state.root) { loadGames(); loadMedia(); } },
    onScanChange() { state.games.loadedFor = null; state.media.loadedFor = null; },
  },
  {
    id: 'security', label: 'Security', icon: 'shield', needsScan: true,
    mount() { if (state.root) loadSecurity(); },
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
      // segmented control switches between them without remounting. The
      // running scan's id on hand is no scan behind the tree (treeScanId).
      if (!treeScanId()) { dupNeedsScan(); ndNeedsScan(); return; }
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
        // unmount() has not run — switchView only unmounts when the view
        // actually changes. Without this the previous local scan's measured
        // trash line stands under "Not available for cloud scans."
        dupTrashOutcome = null;
        // Nor may either pane offer what the scan before left (review F3.4).
        // state.near outlives a scan (finishScan replaces only state.dup): its
        // groups and selection are a local folder's, not this account's. The
        // pane's answer for this scan is settled — unavailable, as the server
        // answers a search it cannot run — so Auto-select says why it has
        // nothing to select. Both toolbars are then repainted from what they
        // hold, so neither offers Move to Trash under the notice
        // (updateDupToolbar repaints the trash line too).
        clearTimeout(state.near.pollTimer);
        state.near = {
          loadedFor: null, status: 'complete', available: false,
          reason: 'Finding similar images reads the pictures themselves, and cloud scans never download any.',
          clusters: [], clusterCount: 0, totalReclaimable: 0, truncated: false,
          selection: new Set(), pollTimer: 0, renderedClusters: 0, shownPerCluster: {},
        };
        updateNdToolbar();
        updateDupToolbar();
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
      // The measured trash line belongs to the tab it was written on. It
      // deliberately survives the rescan the trash starts (finishScan replaces
      // state.dup and remounts this view), and deliberately does not survive
      // the user walking away from the tab.
      dupTrashOutcome = null;
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

/**
 * What each view that needs a scan will show once a folder is scanned, in one
 * sentence (design pass G02). Before a scan every one of them put up the
 * Dashboard's welcome with no title of its own, so clicking Grid looked like
 * nothing had happened. Keyed by view id, here rather than on each view,
 * because the views are registered in files of their own; a view missing
 * from this table still gets its own title and a sentence that claims nothing.
 * Each claims only what its view does: the map leaves out what is too small
 * to draw, and the statement keeps a line for what it cannot explain (review
 * F2.4, F2.5).
 */
const EMPTY_VIEW_LEADS = {
  treemap: 'Once a folder is scanned, its biggest files and folders appear here as rectangles — the bigger the rectangle, the more space it takes.',
  city: 'Once a folder is scanned, its map appears here as a city seen from a corner, where you choose what a building’s height and color mean.',
  grid: 'Once a folder is scanned, its files and folders appear here as tiles you can sort, filter and open.',
  apps: 'Once a folder is scanned, this shows how much of it each application owns — the app itself, its caches, its data and its logs.',
  games: 'Once a folder is scanned, this shows what its game, photo and video libraries hold, and which parts their apps can rebuild if you remove them.',
  security: 'Once a folder is scanned, this lists keys, credentials and wallets sitting outside the folders they belong in — found by name and place, without opening any file.',
  missing: 'Once a folder is scanned, this sets out everything the disk it is on counts as used — what the scan found, what no scan can see, such as snapshots, and whatever is left unaccounted for.',
  duplicates: 'Once a folder is scanned, this finds files in it with identical contents, and pictures that look nearly the same.',
};
const EMPTY_VIEW_LEAD_DEFAULT = 'Once a folder is scanned, this view fills in.';

/** The empty state, for the view it stands in for (G02): the welcome on the
    Dashboard, the view's own name, icon and sentence everywhere else — and,
    for every one of them, the start screen's choices (240, the owner, 17 Oct
    2026). Guarded: a page reader may lift this without the start screen. */
function renderEmptyState(view) {
  if (typeof renderStartChoices === 'function') renderStartChoices();
  const hero = view.id === 'dashboard';
  $('emptyHero').hidden = !hero;
  $('emptyForView').hidden = hero;
  if (hero) return;
  $('emptyViewIcon').innerHTML = icon(view.icon, 30);
  $('emptyViewTitle').textContent = view.label;
  $('emptyViewLead').textContent = EMPTY_VIEW_LEADS[view.id] || EMPTY_VIEW_LEAD_DEFAULT;
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
  // The Grid's selection bar is the Grid's: it goes with the Grid and comes
  // back with it (QA third pass D03). After the toggles, so focus that was in
  // the bar finds the view now on screen.
  selectionBarFollowView();
  if (empty) renderEmptyState(view);
  $('emptyState').style.display = empty ? 'flex' : 'none';
  // FX: the zero-state CTA halo lives and dies with the welcome screen, and
  // the scan hero follows the active view — both are functions of the state
  // this function just set. The hover ring goes too: a keyboard view switch
  // moves no pointer, and the card it sat on is hidden DOM now.
  fxEmptyCtaSync(empty);
  fxScanHeroSync();
  renderCapabilityNotice(view, blocked);
  // The welcome card offers the folder browser exactly while the empty
  // state's own button is off screen (review F1.2), so it hears of every
  // change of view. Guarded like indexTree's renderCart: a page reader may
  // lift this function without the tour.
  if (typeof tourFollowView === 'function') tourFollowView();
  // The toasts stand clear of the map's footer, which comes and goes with
  // its view (BQR-1 item 14). Guarded the same way.
  if (typeof toastPlaceSoon === 'function') toastPlaceSoon();

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
 * The first enabled control on screen in the view that is up, or null: where
 * keyboard focus goes when the thing that held it disappears — an emptied
 * cart, the Grid's selection bar leaving with the Grid (D03) — rather than
 * falling to <body> (QA B13). On screen means painted: a control in a
 * hidden part of the view has no client rects.
 *
 * While a scan runs, its Stop, when it is on screen: a scan started from the
 * start screen hides the choice that held focus, and the view's first
 * control is the System card's Trash row, whose next Enter opened the Trash
 * sheet over the map (seventh browser pass, J01).
 */
function activeViewControl() {
  if (state.scanning) {
    const stop = $('scanBtn');
    if (stop && !stop.disabled && stop.getClientRects().length > 0) return stop;
  }
  return [...document.querySelectorAll('.view.active button, .view.active input, .view.active select, .view.active [tabindex="0"]')]
    .find((el) => !el.disabled && el.getClientRects().length > 0) || null;
}

/**
 * The start screen's control that takes focus, or null while the start
 * screen is not on screen: its "Scan … again" for the last folder — right
 * after a scan of it was stopped or failed, what the person was just doing
 * (the owner, 17 Oct 2026), or on a relaunch, the folder the history names
 * (eighth browser pass K01) — else its one primary, "Choose a folder…" (G03).
 * Only the last folder's carries the id: the history's beside another
 * folder's Stop does not (J03).
 */
function startLanding() {
  const shown = (el) => !!el && !el.disabled && el.getClientRects().length > 0;
  const again = $('startAgainBtn');
  if (shown(again) && again.classList.contains('start-again')) return again;
  const cta = $('emptyBrowseBtn');
  return shown(cta) ? cta : null;
}

/**
 * Where focus goes when the control that held it has left the screen: the
 * start screen's control while it is up (startLanding) — else the tour
 * card's own control while the card is up, else the first control of the
 * view now up, else that view's tab. Never <body> (G11, review F1.11, F2.6).
 */
function focusLanding() {
  return startLanding() || tourCardControl() || activeViewControl() || document.querySelector('.tabbar button[aria-selected="true"]');
}

/**
 * After a scan ends with nothing on screen — stopped, or failed — focus goes
 * to the start screen's control (startLanding) whenever nothing on screen
 * holds it: Stop pressed with the mouse can leave it on <body>, and
 * withFocusKept moves only focus that was on a control (the owner, 17 Oct
 * 2026). Focus on a control still on screen stays where it is.
 */
function focusStartScreen() {
  const at = document.activeElement;
  if (at && at !== document.body && at.getClientRects().length > 0) return;
  const to = startLanding();
  if (to) to.focus({ preventScroll: true });
}

/**
 * Run `change`, a repaint that may take the focused control off screen, and
 * if it did, move focus on, to focusLanding(). The folder browser hands focus
 * back to the button that opened it as it closes — the welcome's "Choose a
 * folder", Trends' or History's — and the scan it started then hides that
 * button (review F1.11); a scan that fails or is stopped puts the welcome
 * back over the Dashboard's path box and Stop, and one that paints or lands
 * hides the welcome or repaints the view under focus (review F2.6).
 * Focus on a control still on screen, or on nothing, is left where it is;
 * and so is focus the change itself put on another control on screen, as
 * renderBudgetWidget gives it to the same budget's new Edit button (BQR-1
 * item 12c).
 */
function withFocusKept(change) {
  const had = document.activeElement;
  change();
  if (!had || had === document.body || had.getClientRects().length > 0) return;
  const now = document.activeElement;
  if (now && now !== had && now !== document.body && now.getClientRects().length > 0) return;
  const to = focusLanding();
  if (to) to.focus({ preventScroll: true });
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
    // Its tooltip: why it is unavailable, or its view's name — taken away, an available tab had no tooltip,
    // and in the collapsed rail, whose labels are hidden, no name either (eighth browser pass K51). Its
    // accessible name is its view's name in both, the reason then its description.
    btn.title = reason || view.label;
    btn.setAttribute('aria-label', view.label);
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

/* ─────────────────────── Persistent live index (A1) ───────────────────────
   The first scan of a folder is a scan. Every later open is a database read:
   the index is built in the background once a scan finishes, kept current by a
   filesystem watcher, and read back in a few milliseconds.

   The honesty rule that makes this safe: an index whose watcher was not
   attached continuously since it was built may have missed changes, and the
   server reports that as `state: 'stale'`. Stale data is still shown — it is
   far better than nothing and usually correct — but it is *labelled*, and a
   rescan is offered. TreeMap never presents an unverified number as current. */

/** Paint the index indicator for the folder currently on screen. */
function renderIndexBadge(info) {
  const el = $('indexBadge');
  // The badge comes on screen with its words already in it, which a screen
  // reader seldom announces: they are said in #indexBadgeSaid, a frame after it
  // shows them, and taken back as it goes (BQS). Guarded: a page reader may
  // lift this function without sayAloud.
  const say = (words) => { if (typeof sayAloud === 'function') sayAloud('indexBadgeSaid', words); };
  if (!info || !info.indexed || !info.root) { el.hidden = true; say(''); return; }
  const stale = info.root.state !== 'ready' || !info.root.live;
  // A stale root comes with the server's reason, and there is more than one:
  // on macOS another folder's watch starting or stopping can cost this one a
  // change while it stays attached. Without a reason — an index that is only
  // not being watched — the badge says what it always said.
  const why = info.root.state === 'stale' ? info.root.staleReason : '';
  // This folder's own index, holding more items than TreeMap indexes on its
  // own (plan U-1): a scan will not rebuild it, so "Scan again to refresh it"
  // would promise what never happens. It says when it was saved instead. The
  // same holds when the folder's last automatic build stopped at the cap (its
  // walk counts what the scan's "don't scan" patterns skip): the next scan
  // offers rather than rebuilds (Track U review of U-1).
  const max = info.autoBuild ? info.autoBuild.maxEntries : null;
  const own = info.root.path === info.path && typeof max === 'number';
  const oversized = own && info.root.fileCount + info.root.dirCount > max;
  const stop = info.stoppedAtCap;
  const heldBack = own && !!stop && typeof stop.maxEntries === 'number' && stop.maxEntries >= max;
  const refresh = oversized || heldBack
    ? (info.root.builtAt ? ' Saved ' + escapeHtml(formatDate(info.root.builtAt)) + '; not refreshed automatically.' : ' Not refreshed automatically.')
    : ' Scan again to refresh it.';
  el.classList.toggle('stale', stale);
  el.innerHTML =
    '<span class="dot"></span><span>' +
    (stale
      ? (why
        ? 'Index may be out of date. ' + escapeHtml(why) + refresh
        // Built, and nothing watching it while TreeMap runs — a single file
        // cannot be watched as a folder root, and a watch can fail to attach.
        // "While TreeMap was closed" said seconds after the build was false
        // (B34); that sentence is for a stale index that gives no reason.
        : info.root.state === 'ready'
          ? 'Index may be out of date — it isn’t being watched for changes.' + refresh
          : 'Index may be out of date — it wasn’t watching while TreeMap was closed.' + refresh)
      : 'Up to date — updates itself as files change') +
    '</span>';
  el.title = stale
    ? 'TreeMap keeps a saved index of this folder so it opens instantly. It may have missed a change at some point, so something may be different now.'
    : 'This folder opens instantly from a saved index that updates itself as files change.';
  el.hidden = false;
  say(el.textContent);
}

/** Bumped by each background build; a build whose number has passed stops following its job. */
let indexLineGen = 0;
/** The server's `autoBuild.maxEntries`, from the last status that carried it; null until one has. */
let indexAutoMaxEntries = null;

/**
 * Whether a finished scan's folder is indexed now (plan U-1, U-D3):
 * 'build', 'offer' (too many items — say so, build nothing) or 'none'.
 *
 * `autoBuild` is the server's (`GET /api/index/status`), never a number held
 * here. `exactRoot` is the index of exactly this folder, or null: a root that
 * merely CONTAINS it (a whole-disk index saved by 5.1.0) is not its index and
 * must not stop it being indexed.
 *
 * An unknown count is never read as small: no stats, a null, missing or NaN
 * `scanned`, or no `autoBuild` at all is 'none'. A current index (ready, and
 * watched) is not rebuilt. Nor is this folder's own index when it holds more
 * than the limit: a rebuild would stop at the limit, a whole walk for
 * nothing (the server keeps the saved index; it is never deleted
 * automatically).
 *
 * `stoppedAtCap` is the status's: the last capped build of exactly this
 * folder stopped at its cap. Its walk counts what the scan's "don't scan"
 * patterns skip, so the scan's own count can be under the limit while the
 * walk is over it; building again would walk the same million entries and
 * keep none. That is an offer, while the cap it stopped at is at least
 * today's (a stop at a smaller cap says nothing about a larger one).
 */
function indexAutoPlan(stats, autoBuild, exactRoot, stoppedAtCap) {
  const max = autoBuild ? autoBuild.maxEntries : undefined;
  if (typeof max !== 'number' || !Number.isFinite(max) || max < 1) return 'none';
  // Only a local scan: a cloud account has no filesystem to watch, and a
  // tree read from the index is not indexed again.
  if (!stats || stats.engine === 'index' || stats.engine === 'cloud') return 'none';
  const n = stats.scanned;
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'none';
  const small = n <= max;
  if (!small) return 'offer';
  if (exactRoot && exactRoot.fileCount + exactRoot.dirCount > max) return 'none';
  if (exactRoot && exactRoot.state === 'ready' && exactRoot.live === true) return 'none';
  if (stoppedAtCap && typeof stoppedAtCap.maxEntries === 'number' && stoppedAtCap.maxEntries >= max) return 'offer';
  return 'build';
}

/**
 * The line under the index badge: a build that is running, one that outlived
 * the page's ten minutes of close polling, or why a folder was not indexed.
 * `line` is null (clear it), or { kind: 'building' | 'background', processed },
 * { kind: 'offer', scanned, maxEntries } or { kind: 'stopped', reason } (a
 * build stopped at its cap, now or last time, in the server's sentence).
 *
 * The line is rewritten on every poll of a running build, so it is not a live
 * region: a screen reader hears it through #indexAnnounce, once each time the
 * kind of line changes, never once per count (Track U review of U-1, finding
 * 8; the scan's own counter speaks once every ten seconds for the same reason).
 * Said through sayAloud, which holds the words while the Dashboard is not up —
 * a build runs on whatever view is — and says them a frame after it comes
 * back; and taken back as the line goes, so a later build is news again
 * (BQT item 28). Its sentence has no count in it, so a poll that changes
 * only the count says nothing new. Guarded: a page reader may lift this
 * function without sayAloud.
 */
function renderIndexLine(line) {
  const el = $('indexLine');
  if (!el) return;
  const say = (words) => { if (typeof sayAloud === 'function') sayAloud('indexAnnounce', words); };
  if (!line) { el.hidden = true; el.textContent = ''; el.dataset.kind = ''; say(''); return; }
  const soFar = typeof line.processed === 'number' ? ` — ${formatCount(line.processed)} items so far` : '';
  const sentence =
    line.kind === 'offer'
      ? `Not indexed automatically — ${formatCount(line.scanned)} items is more than TreeMap indexes on its own (up to ${formatCount(line.maxEntries)}).`
      : line.kind === 'stopped'
        ? `Not indexed automatically. ${line.reason}`
        : line.kind === 'background'
          ? 'Still indexing in the background'
          : 'Indexing this folder for instant opening';
  el.textContent = sentence + soFar;
  el.hidden = false;
  el.dataset.kind = line.kind;
  say(sentence);
}

/** Ask whether a folder can be served from the index. Never throws. */
async function indexStatusFor(path) {
  try {
    const info = await api('/api/index/status?path=' + encodeURIComponent(path));
    // Kept for the sentences that name the limit without a status to hand
    // (search's "nothing is indexed yet").
    if (info && info.autoBuild && Number.isFinite(info.autoBuild.maxEntries)) indexAutoMaxEntries = info.autoBuild.maxEntries;
    return info;
  } catch {
    return null; // no index service, no problem — scanning still works
  }
}

/**
 * Open a folder straight from the index.
 *
 * Returns true when it rendered. The tree comes back in the same `FileNode`
 * shape a scan produces, so everything downstream — treemap, grid, cart — is
 * the existing code path with no special casing. `stopped` says whether the
 * person pressed Stop while the tree was read: then nothing is painted.
 */
async function openFromIndex(path, info, stopped = () => false) {
  const t0 = performance.now();
  let data;
  try {
    data = await api('/api/index/tree?path=' + encodeURIComponent(path) + '&maxNodes=' + INSTANT_OPEN_NODES);
  } catch {
    return false; // fall through to a real scan
  }
  if (stopped() || !data || !data.root) return false;

  // The tree on screen, when a scan of its own is behind it — the older
  // results — is kept until this folder's scan lands, for a Stop to put back
  // with its scan (putBackHeldTree): a Stopped rescan keeps the older tree,
  // as it does for a folder with no saved index (seventh browser pass, J06).
  state.heldBehindIndex = state.root && state.settledScanId
    ? { root: state.root, scanId: state.settledScanId, stats: state.scanStats, lastScan: state.lastScan,
        largest: state.largest, types: state.types, bigFolders: state.bigFolders,
        treemapPath: state.treemap.rootPath, gridPath: state.grid.path, over: data.root }
    : null;

  // A scanId is what every destructive and drill-in endpoint keys off. The
  // index cannot grant one — those endpoints deliberately require a scan this
  // server actually performed — so a real scan still runs in the background to
  // unlock them. What the index buys is the instant paint.
  state.root = data.root;
  // Another tree is on screen, and finishScan returns before the index build
  // below for a tree with no scan behind it. Whatever #indexLine said was
  // about the last folder, and a build of it still running no longer speaks
  // for this screen (Track U review of U-1, finding 4).
  indexLineGen++;
  renderIndexLine(null);
  indexTree(data.root);
  // The index cannot grant a scanId, and the one sitting in state belongs to a
  // DIFFERENT scan — the last one, which may have been of another folder, or
  // may have been stopped and now answers 500 to everything. Either way it does
  // not describe this tree. Clearing it makes every scanId-keyed view take its
  // existing "no scan yet" branch and wait for the background scan a moment
  // later, instead of rendering another folder's data or a wall of errors.
  state.scanId = null;
  // `state.lastScan` is deliberately NOT written here. It has one shape,
  // { when, durationMs }, and finishScan sets it a moment later — writing a
  // different shape from here left `when` undefined, which the "since your last
  // scan" banner reads directly.
  // Whose counts are these? `GET /api/index/tree` answers with the subtree that
  // was asked for, but its fileCount/dirCount/totalSize describe the whole
  // IndexedRoot that CONTAINS it — `rootFor()` in indexRoutes matches any
  // containing root by prefix. So after scanning `~` once, opening
  // `~/Documents` reported the home folder's item count beside Documents' own
  // byte total, at an items/sec rate neither of them supports. The counters
  // describe this tree only when this tree IS the root; anything else — a
  // subfolder, or a server that did not say which root answered — gets null,
  // which every surface below is required to read as "show no number at all"
  // rather than as a zero. root.size, computed over the tree itself, stays
  // exact and is still shown.
  const wholeRoot = !!data.rootPath && data.rootPath === data.path;
  state.scanStats = {
    scanned: wholeRoot ? data.fileCount + data.dirCount : null,
    fileCount: wholeRoot ? data.fileCount : null,
    dirCount: wholeRoot ? data.dirCount : null,
    engine: 'index',
    durationMs: Math.round(performance.now() - t0),
  };
  renderIndexBadge(info);
  await finishScan(data.root, performance.now() - t0, state.scanStats);
  return true;
}

/**
 * Build the index for a freshly-scanned root, in the background — when
 * TreeMap indexes a folder that size on its own (plan U-1).
 *
 * Fire-and-forget on purpose: this is what makes the *next* open instant, and
 * the user is already looking at their results. A failure is silent because
 * nothing they can see depends on it — scanning keeps working exactly as
 * before if indexing is unavailable. What IS said, on #indexLine, is that a
 * build is running and how far it has got, or why none was started.
 *
 * `stats` is the finished scan's (`scanned`, `engine`); the limit is the
 * server's, and the build request carries it, so the server stops a build
 * that walks past it (its walk does not honour the scan's "don't scan"
 * patterns, and the folder can grow meanwhile). A stop keeps the saved index
 * as it was, says so on the line, and is remembered by the server, so the
 * next scan offers instead of building again.
 *
 * However it ends — built, offered, nothing to do, stopped, failed — the
 * badge is painted again for this folder: until then it describes whatever
 * was on screen before (Track U review of U-1, finding 5).
 */
async function buildIndexInBackground(path, stats) {
  const gen = ++indexLineGen;
  // Only the folder on screen gets a line; they may have scanned somewhere
  // else while a big index was building. The loaded tree's own root is the
  // test — `state.lastScan` carries timing, not a path.
  const onScreen = () => !!state.root && state.root.path === path;
  const ours = () => gen === indexLineGen && onScreen();
  const paint = (line) => { if (ours()) renderIndexLine(line); };
  const badge = (info) => { if (ours()) renderIndexBadge(info); };
  // A poll every half second for ten minutes; past that the build is said to
  // be running in the background, and followed every ten seconds until it
  // settles rather than dropped.
  const POLL_MS = 500;
  const WINDOW_MS = 600000;
  const BACKGROUND_POLL_MS = 10000;
  try {
    if (!path || path.startsWith('cloud://')) { paint(null); badge(null); return; }
    const status = await indexStatusFor(path);
    if (!status) { paint(null); badge(null); return; }
    const exactRoot = status.root && status.root.path === path ? status.root : null;
    const plan = indexAutoPlan(stats, status.autoBuild, exactRoot, status.stoppedAtCap);
    if (plan === 'offer') {
      paint(stats.scanned > status.autoBuild.maxEntries
        ? { kind: 'offer', scanned: stats.scanned, maxEntries: status.autoBuild.maxEntries }
        : { kind: 'stopped', reason: status.stoppedAtCap.reason });
      badge(status);
      return;
    }
    if (plan !== 'build') { paint(null); badge(status); return; }
    const started = await api('/api/index/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, maxEntries: status.autoBuild.maxEntries }),
    });
    paint({ kind: 'building', processed: 0 });
    // The build endpoint answers 202 with a job id and returns immediately, so
    // asking for status now would read the index mid-build and paint a badge
    // describing a state that is about to change. Follow the job until it
    // settles first; each 202 carries how far it has got, for the line.
    for (let polls = 0; ; polls++) {
      const r = await api(`/api/index/${started.jobId}/result`, undefined, { pending: 'return' });
      if (!r || r.status !== 'running') break;
      if (gen !== indexLineGen) return; // a newer build owns the line now
      const outlived = polls * POLL_MS >= WINDOW_MS;
      paint({ kind: outlived ? 'background' : 'building', processed: r.processed });
      await new Promise((resolve) => setTimeout(resolve, outlived ? BACKGROUND_POLL_MS : POLL_MS));
    }
    paint(null);
    badge(await indexStatusFor(path));
  } catch (e) {
    // Stopped at the cap: nothing failed, and the saved index (if any) is as
    // it was — the line says why, in the server's sentence. Anything else:
    // indexing is an optimisation, never a requirement, and scanning still
    // works, so the line just clears.
    paint(e && e.code === 'INDEX_CAP_REACHED' ? { kind: 'stopped', reason: e.message } : null);
    badge(await indexStatusFor(path));
  }
}

async function startScan(path, opts = {}) {
  if (state.scanning) { toast('A scan is already running', 'error'); return; }
  state.scanningPath = path; // a Stop or a failure names it on the start screen (noteLastFolder)
  closeEventSource();
  disableLive({ keepWanted: true }); // the new scanId gets a fresh watch session

  // Answer the click BEFORE the index probe below, which is a network round
  // trip — measured at 400ms on a large indexed root, and longer again when it
  // goes on to fetch the tree. Doing that first left the button reading "Scan"
  // with no spinner for the whole time, which reads as the app having missed
  // the click. `quiet` while a tree is on screen, because we do not yet know
  // whether the index will paint over it; startScanRequest re-enters with the
  // real value a moment later. With none on screen there is nothing to keep:
  // the full chrome takes the start screen down at once and puts the
  // Dashboard's Stop on screen. Quiet, the start screen stayed up and
  // clickable for the whole probe, with Stop in the hidden Dashboard, and a
  // second click on a choice was told "A scan is already running" (review
  // F1.2).
  beginScanChrome({ quiet: !!state.root, message: 'Starting scan…' });
  // That chrome has a Stop, and a Stop pressed while the index below is asked
  // about or read has no scan to cancel: stopScan ends the chrome, and this
  // click starts nothing more — no paint, no scan (final review F1.7). A Scan
  // pressed after the Stop is a click of its own, with a chrome of its own.
  const gen = state.scanGen;
  const stopped = () => !state.scanning || state.scanGen !== gen;
  // The badge and its line describe the folder on screen. A scan of another
  // folder takes them down now, not when the probe below answers: the index
  // paint puts this folder's back, and the full chrome keeps them down (B05).
  if (!state.root || state.root.path !== path) {
    renderIndexBadge(null);
    indexLineGen++;
    renderIndexLine(null);
  }

  // A1: if this folder is already indexed, paint from the index first so the
  // user sees their tree immediately, then let the scan refresh it underneath.
  // Skipped for an explicit fast-rescan, which the user asked to be a rescan.
  if (!opts.incremental && !opts.noIndex) {
    const info = await indexStatusFor(path);
    if (stopped()) return;
    if (info && info.indexed && info.root && info.root.state !== 'building') {
      const painted = await openFromIndex(path, info, stopped);
      if (painted) {
        // The scan still runs — it grants the scanId the destructive endpoints
        // require, and reconciles anything the watcher missed.
        void startScanRequest(path, opts, { quiet: true });
        return;
      }
      // Not painted, the chrome still up unless a Stop took it down: painting ends it.
      if (stopped()) return;
    }
  }
  await startScanRequest(path, opts, { quiet: false });
}

/** The actual scan request, split out so the index path can run it quietly. */
async function startScanRequest(path, opts = {}, { quiet = false } = {}) {
  beginScanChrome({ quiet });
  const gen = state.scanGen; // this request's identity, for both outcomes below
  try {
    // U-11: a notice beside the scan, never a question in front of it — its
    // answer is asked for alongside the scan request, not awaited before it.
    void scanAccessNotice(path, gen);
    const t0 = performance.now();
    state.scanRequestGen = gen; // a Stop from now has a cancel to come (review F1.2)
    const resp = await api('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // interactive: a person started this scan here (ScanOptions.interactive)
      // — the one kind that runs Automatic at Turbo and may raise an
      // administrator prompt. Who started it is the caller's to say, never
      // `quiet`, which says only that an index paint is already on screen:
      // keyed on `quiet`, every rescan of an indexed folder — ⌘R, Rescan,
      // Scan — ran at the background budget (B04). A caller nobody need be
      // present for passes `unattended`: the rescan at the end of a job that
      // runs on after its click — an offload, the cart's undo, a video
      // re-encode (review F2.1) — which may not ask for elevation. (The boot
      // restore, review F1.2, starts no scan at all now: the owner, 17 Oct
      // 2026.) The rest are a person's click, drop or request.
      body: JSON.stringify({ path, incremental: !!opts.incremental, interactive: !opts.unattended }),
    });
    startNoteAllowed(path); // accepted: the start screen need not ask the rules about it (review F3.2)
    if (abandonIfStopped(resp.scanId, gen, path)) return;
    followScanProgress(resp.scanId, path, resp.incremental === true, t0);
  // A request a Stop ended, or one another scan has replaced since, has
  // nothing to report when it fails — abandonIfStopped's check, for the other
  // outcome. Reported, its failure tore down the scan running now: the start
  // screen came back over it saying its folder failed, with this request's
  // reason, and Stop could no longer reach it (review F1.1). A failed
  // background refresh keeps the indexed tree on screen. The Stop that ended
  // it said "Stopping…" while it was out: no scan ran, so it is stopped.
  } catch (e) {
    if (!state.scanning || state.scanGen !== gen) {
      stoppedRequestFailed(gen, path);
      return;
    }
    if (quiet) { quietRescanFailed(e); return; }
    failScan(e.message, e); // the error: a folder the server refused is not offered again
  }
}

/**
 * The quiet rescan behind an index-first paint failed.
 *
 * "Quiet" was taken literally: the function returned, and the spinner, the
 * three skeleton cards and the Stop button stayed up for ever over a tree
 * that was never going to be refreshed — unplug the drive a folder lived on,
 * reopen it from Recent, and the app spun forever with the lists as grey
 * skeletons and "Index live — always current" underneath. The tree itself is
 * still good — it came from the index — so it stays; what has to end is the
 * pretence that something is still happening, and the badge's claim that the
 * index is current, which is exactly what just failed to be confirmed. Shown
 * in the status line and on the badge, neither of which is a live region, and
 * said once, by the toast (BQU item 35; review F1.2, F1.9).
 *
 * (There were two of these, and the second, declared later in the one page
 * script, silently replaced this one everywhere — tests/frontendContract now
 * refuses a second top-level declaration of any name.)
 */
function quietRescanFailed(e) {
  state.scanning = false;
  state.heldBehindIndex = null; // the index's tree stays, said to be the saved index; nothing to put back
  endScanChrome();
  restoreDashboardPanels();
  const why = (e && e.message) || 'the folder could not be read';
  const el = $('scanStatus');
  el.classList.add('error');
  el.innerHTML = icon('alert', 14) + '<span>Showing the saved index — the refresh failed: ' + escapeHtml(why) + '</span>';
  // The toast is what says it (BQU item 35): the scan's own region, outside
  // every view, said it in the same words, and on the Dashboard the badge's
  // region said it a third time. The region is emptied — what it said of the
  // refresh, "Checking for changes…" or a count, is over. So the toast says
  // all of it, below: the tree on screen being the saved index's, and maybe
  // older, too — the badge's region said that, and nothing else does now.
  $('scanAnnounce').textContent = '';
  // Amber, the badge kept the words it was painted with: "Up to date — updates
  // itself as files change" beside the dot that says it may not be. Its words
  // say what happened (BQT item 25). The toast says it, so they are kept as
  // said in #indexBadgeSaid, which says nothing of it (sayAloud's `heard`);
  // guarded, as there.
  const badge = $('indexBadge');
  const failed = 'Index may be out of date — the refresh failed, so what is shown may be older.';
  badge.classList.add('stale');
  badge.innerHTML = '<span class="dot"></span><span>' + failed + '</span>';
  badge.title = 'The refresh of this folder failed, so what is shown comes from its saved index and may be older.';
  if (typeof sayAloud === 'function') sayAloud('indexBadgeSaid', badge.hidden ? '' : failed, true);
  // The reason, then the consequence, each its own sentence (asSentences' rule, 010: a stop where the reason has none).
  toast('Couldn’t refresh this folder: ' + why + (/[.!?…]$/.test(why) ? ' ' : '. ') + 'What is shown comes from its saved index and may be older.', 'error');
  // The view on screen says what it will now never be drawn from: Disk City's
  // "loading this folder…" and the Reclaim legend's "scoring starts once this
  // folder's scan finishes" were of a scan that will not land, and nothing
  // else redraws them — re-entered, as failScan and stopScan re-enter it
  // (review F3.4).
  withFocusKept(() => { switchView(state.view); });
  tourScanFailed(); // the tour's quick wins, waiting for this scan, say it will not land (review F1.4)
  liveScanEnded(); // and a Live wish waiting for it goes (review F2.14)
  if (typeof cleanScanChanged === 'function') cleanScanChanged(); // the Clean Up panes waiting on a scan say so again, or ask (K04)
  // The desktop shell hears it ended, before a folder waiting here starts (hunt C01).
  if (typeof tellDesktop === 'function') tellDesktop('scanFinished', { ok: false, path: state.scanningPath || '', error: why });
  drainScanQueue(); // a folder waiting behind this one still deserves its turn
}

/**
 * A Stop while an index paint stands over older results (seventh browser
 * pass, J06): put the older tree back on screen with its scan — its counters,
 * lists, the folder the map and the Grid were in — as a Stopped rescan of a
 * folder with no saved index keeps them (the A6 rule). Without it the Stop
 * left the index's tree with no scan behind it, the older scan abandoned, and
 * the map drawing the older folder under the new folder's name.
 *
 * Only while the index's tree is still the one on screen (`over`). Returns
 * whether it put anything back; the caller says the scan was stopped and
 * remounts the view. Nothing is walked: the older scan is the server's still.
 */
function putBackHeldTree() {
  const held = state.heldBehindIndex;
  state.heldBehindIndex = null;
  if (!held || state.root !== held.over) return false;
  state.root = held.root;
  state.scanId = held.scanId;
  state.settledScanId = held.scanId;
  state.scanStats = held.stats;
  state.lastScan = held.lastScan;
  state.largest = held.largest;
  state.types = held.types;
  state.bigFolders = held.bigFolders;
  indexTree(held.root);
  state.grid.selection.clear();
  updateSelectionBar();
  // Every view hears that the older scan is the one on screen again, and
  // repoints at its tree (onScanChange) — then goes back to where it was in it.
  emit(TOPIC.scan, held.scanId);
  state.treemap.rootPath = held.treemapPath || held.root.path;
  state.grid.path = held.gridPath || held.root.path;
  FxNum.rollText($('statLastScan'), formatClock(held.lastScan ? held.lastScan.when : Date.now()));
  void loadWhatsNew();
  // Its Dashboard cards, which the index paint said were waiting (review F1.12).
  void loadCostEstimate();
  void loadDriveHealth();
  void loadBudgets();
  // Its index badge, which the index paint took down: asked again, as when it landed.
  void indexStatusFor(held.root.path).then((info) => { if (state.root === held.root) renderIndexBadge(info); });
  if (state.live.wanted) enableLive(); // Live survives a Stop, as it survives a rescan
  return true;
}

/** Follow a running scan (disk or cloud) over SSE, with the stall watchdog. */
function followScanProgress(scanId, path, fast, t0) {
  const status = $('scanStatus');
  const fastTag = fast ? icon('zap', 12) + ' Fast rescan · ' : '';
  const isCloud = path.startsWith('cloud://');
  state.scanId = scanId;

  const es = new EventSource(`/api/scan/${scanId}/progress`);
  state.es = es;
  // Watchdog (plan U-2): SSE can stall silently through proxies (no error
  // event, no frames), and a server that is busy — a second walk, the
  // ingest, the first frame being built — sends the unchanged progress frame
  // again every ~2 s as a heartbeat. So a stream that has said nothing for
  // QUIET_MS is asked about, with the small /stats, never the result: the
  // result is the whole first frame (238.6 MB on the Track U disk), and
  // asking for it every tick serialized it four and eight times over.
  //  - One poll at a time. A /stats still out after IN_FLIGHT_TICKS ticks is
  //    abandoned (aborted) and counts as nobody answering; a /result is given
  //    RESULT_IN_FLIGHT_TICKS, because a frame that size takes longer than
  //    fifteen seconds to build and send, and abandoning it would only ask
  //    for it again.
  //  - /stats "complete" while the stream is open counts one tick of
  //    FRAME_GRACE_TICKS: the complete frame is on its way. Only after the
  //    grace is /result fetched, once. "running" starts the grace again.
  //  - A stream that has closed goes straight to /result: nothing else can
  //    deliver it.
  // When is the server dead (finding L6 of the U-1/U-2 review)? Five in a
  // row of what can only mean it is not there: a refused connection (status
  // 0) or a 5xx. Anything it sends — a frame on the stream, any HTTP answer —
  // is proof of life and starts the count again. A poll that is merely slow
  // (abandoned in flight) or that came back with nothing readable counts
  // only once nothing at all has arrived for SILENCE_FLOOR_MS: completion
  // bursts of 7.4–40.8 s were measured at 9.46M items, and five slow polls
  // (~75–90 s) used to declare a LIVE scan dead. A /result is never
  // abandoned and asked for again — it is the whole first frame, and on a
  // slow link that is minutes; its stretches in flight count the same way.
  const QUIET_MS = 6000;
  const IN_FLIGHT_TICKS = 5;
  const RESULT_IN_FLIGHT_TICKS = 40;
  const FRAME_GRACE_TICKS = 10;
  const SILENCE_FLOOR_MS = 120000;
  // An unreadable /result is the whole first frame serialized for nothing:
  // it is asked for again this many ticks later, not every tick (review L4).
  const RESULT_RETRY_TICKS = 10;
  const NO_ANSWER = 'Couldn’t reach TreeMap — its own server stopped answering. Check the app is still running, then try again.';
  let lastSseAt = performance.now();
  let lastLifeAt = lastSseAt; // the last frame or answer of any kind
  let finished = false;
  let lastAnnounced = 0; // seconds — the live region speaks once every ten
  // Counted toward the five that end the wait: chrome that spins forever
  // over a dead server is a lie.
  let dead = 0;
  let poll = null; // { controller, ticks, limit, result } while a request is out
  let completeTicks = 0;
  let tickNo = 0;
  let resultNotBefore = 0; // the tick an unreadable /result may be asked for again
  const stop = () => { finished = true; clearInterval(watchdog); if (poll) poll.controller.abort(); closeEventSource(); };
  const alive = () => { dead = 0; lastLifeAt = performance.now(); };
  const noAnswer = (message) => {
    if (++dead >= 5 && !finished) { stop(); failScan(message); }
  };
  const slowOrUnreadable = (message) => {
    if (performance.now() - lastLifeAt >= SILENCE_FLOOR_MS) noAnswer(message);
  };
  // Only a body with a status is an answer. null — an empty 2xx, or a body
  // that could not be read — is nobody answering: taken as an answer, it
  // reset the count, and a server that sends headers and then nothing was
  // asked again for ever (Track U review of U-2, finding 2).
  const answered = (body) => !!body && typeof body.status === 'string';
  /**
   * Completion from /result: the stream closed, or the grace passed. The
   * counters are the /stats body already in hand when there is one — asked
   * once, not again — and scanStatsFor's otherwise.
   */
  const completeFromResult = async (mine, statsBody) => {
    if (tickNo < resultNotBefore) return;
    mine.limit = RESULT_IN_FLIGHT_TICKS;
    mine.ticks = 0;
    mine.result = true;
    const r = await api(`/api/scan/${scanId}/result`, { signal: mine.controller.signal });
    if (!answered(r)) { resultNotBefore = tickNo + RESULT_RETRY_TICKS; slowOrUnreadable(NO_ANSWER); return; }
    alive();
    if (r.status === 'complete' && !finished) {
      stop();
      if (!isCloud) rememberScannedRoot(path);
      if (fast) showFastRescanStat(scanId);
      let stats;
      if (statsBody) {
        const { scanId: _scanId, status: _status, ...rest } = statsBody;
        stats = rest;
      } else {
        stats = await scanStatsFor(scanId, r);
      }
      finishScan(r.root, performance.now() - t0, stats);
    }
  };
  const watchdog = setInterval(async () => {
    if (!state.scanning || finished) { clearInterval(watchdog); return; }
    tickNo++;
    if (poll) {
      // Never a second request beside one in flight. A /stats this slow is
      // abandoned and asked again next tick; a /result keeps its place.
      if (++poll.ticks >= poll.limit) {
        poll.ticks = 0;
        if (!poll.result) poll.controller.abort();
        slowOrUnreadable(NO_ANSWER);
      }
      return;
    }
    const open = state.es === es && es.readyState !== EventSource.CLOSED;
    if (open && performance.now() - lastSseAt < QUIET_MS) return;
    const mine = { controller: new AbortController(), ticks: 0, limit: IN_FLIGHT_TICKS, result: false };
    poll = mine;
    try {
      if (!open) { await completeFromResult(mine, null); return; }
      const s = await api(`/api/scan/${scanId}/stats`, { signal: mine.controller.signal });
      if (!answered(s)) { slowOrUnreadable(NO_ANSWER); return; }
      alive();
      if (s.status === 'running') { completeTicks = 0; return; }
      if (s.status === 'complete' && ++completeTicks <= FRAME_GRACE_TICKS) return; // the frame is on its way
      // Complete past the grace, or failed: /result has the tree, or the
      // failure's own sentence (a 500, handled below).
      await completeFromResult(mine, s.status === 'complete' ? s : null);
    } catch (e) {
      if (finished) return;
      // Abandoned by the tick that counted it, or by Stop: nothing more to say.
      if (e && e.name === 'AbortError') return;
      // 500: the scan itself failed server-side. 404: the scan record is
      // gone — waiting longer can never succeed, so stop the spinner instead
      // of polling forever. A running scan does not expire (only at the
      // six-hour limit, which now ends it with its reason, hunt C68): a record
      // gone under it is almost always TreeMap's server having restarted, and
      // "expired" said what did not happen (hunt C69).
      if (e.status === 500 || e.status === 404) {
        stop();
        failScan(e.status === 404 ? 'TreeMap’s server no longer has this scan — it may have restarted. Scan the folder again.' : e.message);
        return;
      }
      // Headers and then nothing readable: not a refusal, and no answer.
      if (e.code === 'BAD_RESPONSE') {
        if (mine.result) resultNotBefore = tickNo + RESULT_RETRY_TICKS;
        slowOrUnreadable(e.message);
        return;
      }
      // Refused (status 0) or a 5xx: the server is not there. A 4xx but a 429
      // (404 is answered above) is a refusal that waiting cannot turn into
      // this scan's answer — an auth layer's 401, a 403 (review L5).
      if (e.status === 0 || e.status >= 501 || (e.status >= 400 && e.status !== 429)) {
        noAnswer(e.message); // api()'s own sentence: check the app is still running
        return;
      }
      alive();
      /* otherwise: still running or transient (a 429, a 202) — keep waiting */
    } finally {
      if (poll === mine) poll = null;
    }
  }, 3000);
  // Hand Stop the two things only this closure can settle. `finished` also
  // gates es.onmessage, so a frame already queued when Stop is pressed is
  // dropped rather than repainting a scan the user just ended.
  state.abortScan = () => { finished = true; clearInterval(watchdog); if (poll) poll.controller.abort(); };
  es.onmessage = async (ev) => {
    lastSseAt = performance.now();
    alive(); // any frame is the server alive (L6)
    if (finished) return;
    const msg = JSON.parse(ev.data);
    if (msg.type === 'progress') {
      const secs = (performance.now() - t0) / 1000;
      const rate = secs > 0.2 ? Math.round(msg.scanned / secs) : 0;
      const items = msg.scanned === 1 ? 'item' : 'items'; // the first frame is often "1 item" (C14)
      // The "searching" orb in the well beside this line is the activity
      // indicator now — the status carries only the numbers.
      status.innerHTML =
        `<span class="num">${fastTag}Scanning… <b>${formatCount(msg.scanned)}</b> ${items}` +
        (rate ? ` · ${formatCount(rate)}/s` : '') + ` · ${secs.toFixed(1)}s</span>`;
      $('scanMeta').textContent = msg.currentPath;
      // A live region fed every frame would never stop talking; one sentence
      // every ten seconds says the scan is alive and how far it has got.
      if (secs - lastAnnounced >= 10) {
        lastAnnounced = secs;
        $('scanAnnounce').textContent = `${formatCount(msg.scanned)} ${items} scanned so far`;
      }
      $('progressTrack').setAttribute('aria-valuetext', `${formatCount(msg.scanned)} ${items} scanned`);
    } else if (msg.type === 'complete') {
      stop(); // and abandon a poll in flight: the frame is what it was waiting for
      let root = msg.root;
      let stats = msg.stats;
      if (!root) {
        const r = await api(`/api/scan/${scanId}/result`);
        root = r.root;
        stats = await scanStatsFor(scanId, r);
      }
      if (!isCloud) rememberScannedRoot(path);
      if (fast) showFastRescanStat(scanId);
      finishScan(root, performance.now() - t0, stats);
    } else if (msg.type === 'error') {
      stop();
      failScan(msg.message);
    } else if (msg.type === 'shutdown') {
      stop();
      failScan('Server is shutting down');
    }
  };
  es.onerror = () => {
    if (finished) return;
    // Transient drops auto-reconnect; a permanently closed stream just
    // hands completion over to the watchdog's result polling.
    if (es.readyState === EventSource.CLOSED) {
      closeEventSource();
      lastSseAt = 0; // let the watchdog take over immediately
    }
  };
}

/** Scan a connected cloud account — registers and follows like a disk scan. */
async function startCloudScan(providerId, providerName) {
  if (state.scanning) { toast('A scan is already running', 'error'); return; }
  state.scanningPath = 'cloud://' + providerId; // named nowhere if it stops (noteLastFolder)
  closeEventSource();
  disableLive({ keepWanted: false }); // watching makes no sense on a cloud tree
  beginScanChrome();
  const gen = state.scanGen; // this request's identity, for both outcomes below
  try {
    $('scanStatus').innerHTML = `<span>Listing ${escapeHtml(providerName)}…</span>`;
    const t0 = performance.now();
    state.scanRequestGen = gen; // a Stop from now has a cancel to come (review F1.2)
    const resp = await api('/api/cloud/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerId }),
    });
    if (abandonIfStopped(resp.scanId, gen, 'cloud://' + providerId)) return;
    followScanProgress(resp.scanId, 'cloud://' + providerId, false, t0);
  // Stopped, or replaced by another scan since: nothing to report (startScanRequest, review F1.1).
  } catch (e) {
    if (!state.scanning || state.scanGen !== gen) { stoppedRequestFailed(gen, 'cloud://' + providerId); return; }
    failScan(e.message);
  }
}

function endScanChrome() {
  state.scanning = false;
  state.indexScanDue = false; // whatever scan an index paint was due, it has ended or is running and ends here
  state.abortScan = null;
  state.accessNotice = null; // the Full Disk Access notice ends with the scan it was set for (U-11)
  setScanButtonMode('scan');
  $('headerSpin').classList.remove('on');
  $('progressTrack').classList.remove('active');
  $('scanMeta').textContent = '';
  // FX: the other half of beginScanChrome's pair — beam fades, orbs destroyed,
  // the status label's shimmer stops before any settled text is written.
  fxStateBeam($('scanStatus').closest('.card'), { type: 'md', active: false });
  fxOrbHide('scan');
  fxScanHeroSync();
  $('scanStatus').classList.remove('fx-shimmer-text');
  // The Live pill's waiting look is for a scan running, and ends with it:
  // finishScan starts Live only once the landed scan's lists answer, and the
  // pill said it waited for a scan that had landed — a press there started
  // Live where the person meant to take the wish back (review F3.1).
  liveQueuedSync();
}

/** Statuses with which the server refuses the folder itself — malformed or
    blocked (400), not allowed or not readable (403), not there (404): a
    retry would only hear the same answer, so a failed scan's folder is not
    offered again for them (failScan). */
const FOLDER_REFUSED_STATUSES = [400, 403, 404];

function failScan(message, err = null) {
  endScanChrome();
  // Every scanId-keyed endpoint answers a failed scan with 500 SCAN_FAILED,
  // so its id is not left for a view to ask with: the id of the scan the tree
  // on screen came from takes its place, or none — stopScan's rule, and for
  // its reason (review F2.3).
  state.scanId = state.settledScanId || null;
  // An index paint's tree stays on screen when its scan fails, as when its
  // quiet request fails (quietRescanFailed): the older tree it stood over is
  // no one's to put back now. Held, a later Stop of another scan swapped it,
  // and its long-gone scan, back over the tree on screen (review F1.1).
  state.heldBehindIndex = null;
  const status = $('scanStatus');
  status.classList.add('error');
  status.innerHTML = icon('alert', 14) + '<span>' + escapeHtml(message) + '</span>';
  // The toast says why, and is the failure's one voice (BQU item 35): the
  // scan's region, outside every view, said it too. It is emptied: what it
  // said of the scan — "Scanning…", a count — is over.
  $('scanAnnounce').textContent = '';
  restoreDashboardPanels();
  toast(message, 'error');
  // With no tree on screen the start screen comes back naming the folder and
  // why, and offers "Scan … again" for it — unless the server refused the
  // folder itself, which is named but never offered: a path that answers an
  // error is not a choice (the owner, 17 Oct 2026).
  if (!state.root) noteLastFolder('failed', message, !(err && FOLDER_REFUSED_STATUSES.includes(err.status)), (err && err.code) || '');
  // The start screen comes back over the Dashboard's path box, where focus
  // was moved as the scan started: withFocusKept moves it on (review F2.6).
  withFocusKept(() => { switchView(state.view); });
  // v4 §9.2 — the welcome card comes back: after the view, so the start
  // screen is on screen when the card picks where focus goes (review F1.12).
  tourScanFailed();
  liveScanEnded(); // a Live wish waited for this scan to land; it will not (review F2.14)
  if (typeof cleanScanChanged === 'function') cleanScanChanged(); // the Clean Up panes waiting on a scan say so again, or ask (K04)
  focusStartScreen(); // on "Scan … again", as after a Stop, or on "Choose a folder…"
  // The desktop shell hears it ended, before a folder waiting here starts (hunt C01).
  if (typeof tellDesktop === 'function') tellDesktop('scanFinished', { ok: false, path: state.scanningPath || '', error: message });
  drainScanQueue(); // a folder waiting behind this one still gets its turn
}

/**
 * Name, on the start screen, the folder of the scan that just ended with no
 * tree on screen — `outcome` 'stopped' or 'failed', with the failure's
 * `reason` — and whether "Scan … again" is offered for it (the owner, 17 Oct
 * 2026: "a scan should work again after being stopped"). The size and date
 * the start screen held for the same folder stay with it. A cloud account's
 * scan changes nothing there, as a cloud account in the history never did.
 */
function noteLastFolder(outcome, reason = '', offered = true, code = '') {
  const p = state.scanningPath;
  if (!p || p.startsWith('cloud://')) return null;
  // The size and date of its last finished scan, from the start screen's record or the history's (J03).
  const prev = [state.lastFolder, state.historyFolder].find((f) => f && f.path === p) || null;
  // A folder the server refused is offered nowhere on the start screen
  // (startChoiceList), until a scan of it is taken: one that ran since — and
  // was stopped, or failed some other way — is offered again (review F1.5).
  const others = (state.refusedPaths || []).filter((x) => x !== p);
  state.refusedPaths = offered ? others : [...others, p];
  // The history's folder, taken since it could not be opened, is offered again beside others (J03).
  if (offered && state.historyFolder && state.historyFolder.path === p && !state.historyFolder.offered) state.historyFolder = { ...state.historyFolder, offered: true };
  // `code`: the refusal's, which the start screen says in its own words (startRefusalWords, J07).
  state.lastFolder = { path: p, outcome, reason, offered, code, size: prev ? prev.size : null, at: prev ? prev.at : 0 };
  return state.lastFolder;
}

/**
 * A Stop whose cancel the server refused — anything but a 404 — so the walk
 * of `path`, the stopped scan's folder, may still be running: it is offered
 * nowhere, under any name, until a scan of it is taken — "Scan … again" or
 * its quick choice would start a second walk of a folder still being walked
 * (review F1.3). However late the refusal answers: by then another folder's
 * Stop or failure may have taken the start screen's line (review F2.5,
 * F3.1). The start screen said "You stopped the scan of …" the moment Stop
 * was pressed; while it still says that of this Stop — `noted`, what
 * noteLastFolder recorded for it, with nothing started or said since — it
 * says instead that TreeMap could not stop it. Focus on a choice that went
 * moves on (withFocusKept). The live region that said "You stopped …" is
 * stopNotConfirmed's, for every refused cancel, a folder named or not
 * (review F1.14, F2.1). (A cloud account's listing, `cloud://…`, is never
 * a choice there, so keeping it out changes nothing.)
 */
function noteStopUnconfirmed(noted, reason, path) {
  if (path) state.refusedPaths = [...(state.refusedPaths || []).filter((x) => x !== path), path];
  if (noted && state.lastFolder === noted) state.lastFolder = { ...noted, outcome: 'unstopped', reason, offered: false };
  withFocusKept(() => { renderStartChoices(); });
}

/**
 * Build what it can of the ScanStats shape from a /result response, whose
 * counters sit at the top level rather than under `stats`. Only for when the
 * stats request itself fails: /result carries no engine reason, budget,
 * refused folders or expiry, so this shape is the lesser of the two.
 */
function statsFromResult(r) {
  return {
    scanned: r.scanned, fileCount: r.fileCount, dirCount: r.dirCount,
    engine: r.engine, ioThreads: r.ioThreads,
    durationMs: r.finishedAt && r.startedAt ? r.finishedAt - r.startedAt : 0,
    incremental: !!r.incremental, cachedDirs: r.cachedDirs || 0, walkedDirs: r.walkedDirs || 0,
    hardlinkedFiles: r.hardlinkedFiles || 0, hardlinkedBytes: r.hardlinkedBytes || 0,
    sparseFiles: r.sparseFiles || 0, sparseBytes: r.sparseBytes || 0, slackBytes: r.slackBytes || 0,
    cloudFiles: r.cloudFiles || 0, cloudBytes: r.cloudBytes || 0,
  };
}

/**
 * The scan's counters, from the response that actually carries them.
 *
 * `buildScanStats` on the server is the single place these are shaped, and
 * `GET /api/scan/:scanId/stats` is the only response that publishes all of
 * them. `/result` carries the tree and the file/dir counts but no `scanned`,
 * `engine`, `ioThreads`, `cachedDirs` or `walkedDirs` — so deriving the
 * counters from it produced `undefined`s, and the dashboard's engine row,
 * which is gated on `engine`, silently vanished on exactly the two paths that
 * had already gone wrong: a stalled stream recovered by the watchdog, and a
 * `complete` frame that arrived with no tree.
 *
 * A stats request that fails is not worth failing a completed scan over, so
 * the result-derived shape stays as the fallback.
 */
async function scanStatsFor(scanId, result) {
  try {
    // buildScanStats plus the record's id and status: exactly the `stats` a
    // complete frame carries, so a recovered scan paints from the same keys.
    // Copying a fixed list of them dropped the engine's reason and fallback,
    // the budget, the refused folders and the expiry after a stalled stream.
    const { scanId: _scanId, status: _status, ...stats } = await api(`/api/scan/${scanId}/stats`);
    return stats;
  } catch {
    return statsFromResult(result);
  }
}

/**
 * Paint a finished scan. `reopenedAt` is set when the tree is a scan the
 * server still held, reopened after a reload (QA D57): it finished then, not
 * now, so the card says when, and there is no "Scan complete" to announce.
 * `afterStop`: a scan that finished before the Stop pressed for it reached
 * the server (J02) — its toast says so, and nothing is indexed behind it: the
 * person asked for the work to stop.
 */
async function finishScan(root, durationMs, stats, { reopenedAt = 0, afterStop = false } = {}) {
  endScanChrome();
  state.root = root;
  // The id that answers questions about the tree we just put on screen — set
  // in the same breath as the tree so the two can never disagree. Null on the
  // index-first paint, which has a tree and deliberately no scan yet. Stop
  // reads it to put the previous results back when a rescan is abandoned.
  state.settledScanId = state.scanId;
  // A scan landed: the older results an index paint stood over are no one's
  // to put back now (putBackHeldTree). The index paint itself keeps them.
  if (state.scanId) state.heldBehindIndex = null;
  indexTree(root);
  state.lastScan = { when: reopenedAt || Date.now(), durationMs, reopened: !!reopenedAt };
  state.treemap.rootPath = root.path;
  state.grid.path = root.path;
  state.grid.selection.clear();
  updateSelectionBar();

  state.dup = { loadedFor: null, status: 'idle', groups: [], groupCount: 0, totalReclaimable: 0, selection: new Set(), pollTimer: 0, shown: DUP_PAGE };
  state.apps.loadedFor = null;

  // `root` is pruned to a node budget, so counting the tree we just indexed
  // would under-report any large scan. The counters come from the server, which
  // holds the whole thing — and they arrive ON the complete frame, so painting
  // costs no round-trip. root.size is exact even when pruned. If we somehow have
  // no stats we say nothing rather than state a pruned count as fact — a wrong
  // number is worse than a missing one.
  //
  // Everything from here to the paint must stay synchronous. The three list
  // endpoints below each walk the whole tree server-side; awaiting them before
  // the paint is what left a 4M-item scan looking frozen for ~2s after it had
  // actually finished, and is why this build was rolled back on July 16.
  state.scanStats = stats || null;
  const files = stats ? stats.fileCount : null;
  const dirs = stats ? stats.dirCount : null;
  const filesWord = files === 1 ? 'file' : 'files'; // a scan of one file is "1 file" (B34)

  // QA D12: one duration, in the engine row's format. The server's own
  // (`stats.durationMs`, which the engine row states too) when it sent one;
  // the page's wall time — which also counts the request, the stream and the
  // frame — only when it did not.
  const tookMs = stats && stats.durationMs > 0 ? stats.durationMs : durationMs;
  // Under a twentieth of a second rounds to "0.0 s", which reads as no time
  // at all: it is "under 0.1 s" (QA fourth pass E14a), as the engine row says.
  const took = (tookMs / 1000).toFixed(1) === '0.0' ? 'under 0.1 s' : `${(tookMs / 1000).toFixed(1)} s`;
  $('scanStatus').classList.remove('error');
  $('scanStatus').innerHTML = icon('checkCircle', 14) + (reopenedAt
    ? `<span class="num">Reopened the scan from ${escapeHtml(formatClock(reopenedAt))} — ` +
      `${files === null ? '' : `<b>${formatCount(files)}</b> ${filesWord}, `}${formatBytes(root.size)} in ${escapeHtml(root.path)}</span>`
    : `<span class="num">Scanned ${files === null ? '' : `<b>${formatCount(files)}</b> ${filesWord} `}` +
      `in ${took} — ${formatBytes(root.size)} in ${escapeHtml(root.path)}</span>`);
  // One voice for the finish (BQU item 35): a scan that completed now, with
  // something in it, is said by its toast (below), and the region is emptied —
  // its count is over; said there too, the finish was heard twice. A paint
  // from the saved index, a reopened scan and a folder that held nothing raise
  // no toast, and the region says them — but one shown after a Stop, which
  // #stopAnnounce says (showFinishedAfterStop).
  const toasted = !!state.scanId && !reopenedAt && !(root.size === 0 && !files);
  const said = reopenedAt ? 'Reopened the last scan — ' : state.scanId ? 'Scan finished — ' : 'Folder opened from the saved index — ';
  $('scanAnnounce').textContent = toasted || afterStop ? '' : said + (files === null ? '' : `${formatCount(files)} ${filesWord}, `) + formatBytes(root.size);
  // Blanked, not merely skipped. Skipping leaves the tiles holding the PREVIOUS
  // scan's numbers, which is the same lie in slower motion: the headline and the
  // engine row go quiet while Files and Folders keep stating another folder's
  // counts as this one's. `data-v` goes with the text because countUp resumes
  // its roll from that attribute, not from what the tile reads — a tile blanked
  // by text alone would animate up from a number nobody can see.
  const setStat = (el, n) => {
    if (n === null) { el.dataset.v = 0; el.textContent = '–'; return; } // the dash the markup ships with
    countUp(el, n);
  };
  setStat($('statFiles'), files);
  setStat($('statDirs'), dirs);
  FxNum.rollText($('statLastScan'), formatClock(reopenedAt || Date.now()));
  renderDiskNotes();
  // finishScan runs twice per scan by design — the index-first instant paint
  // (scanId still null, see the gate below), then the real completion. One
  // scan gets ONE completion toast, on the pass that actually completed (QA D3).
  // FX: the completion pulse rides the same gate — one crossing, one pulse.
  // A reopened scan completed before the reload, and was announced then.
  if (state.scanId && !reopenedAt) {
    // Nothing to celebrate about 0 B in 0 files: on a Mac that is what a
    // folder macOS refused to open looks like, and the refused-folder check
    // (renderRefusedFolders, on TOPIC.scan) speaks for it once it has looked.
    // A partial scan says so in the same breath as its total.
    const refusedDirs = stats && stats.refused && stats.refused.dirs > 0 ? stats.refused.dirs : 0;
    if (toasted) {
      const counted = `${formatBytes(root.size)}${files === null ? '' : ` across ${formatCount(files)} ${filesWord}`}` +
        (refusedDirs ? ` — ${formatCount(refusedDirs)} folder${refusedDirs === 1 ? '' : 's'} could not be read` : '');
      // One toast for the one crossing. A scan that finished before the Stop
      // pressed for it reached the server says so (J02), not "Scan complete":
      // the toast, with its counts, is what says that — #stopAnnounce, which
      // showFinishedAfterStop gave the same news, is emptied (BQU item 35).
      if (afterStop) { toast(`The scan had already finished when you pressed Stop — ${counted}`); $('stopAnnounce').textContent = ''; }
      else toast(`Scan complete — ${counted}`);
    }
    fxScanDonePulse();
  }

  // Painted. Now the expensive server-side walks, filling in behind it.
  void loadWhatsNew(); // "what's new" banner — fetches its snapshots behind the paint too
  if (state.scanId) void loadDriveHealth(); // C4 — shells out to smartctl, so never in front of the paint; the index paint's card is said below
  state.largest = []; state.types = []; state.bigFolders = [];
  $('statLargest').textContent = '–';
  $('statLargestSize').textContent = '';
  // Painted from the index: there is no scan yet, so these three would be
  // `?scanId=null` (404) or, worse, the previous scan's id (500 after a stop,
  // or another folder's data). The background scan calls finishScan again with
  // a real id in a moment, and that is what fills them in.
  if (!state.scanId) {
    // The forecast on the card was the last folder's; the scan behind this
    // tree paints this one's, and Stop asks for it by this folder's path (B05).
    if ($('growthProj')) $('growthProj').hidden = true;
    // The scan behind this tree is requested as this paint returns (startScan
    // → startScanRequest), and the views below are painted before it is, the
    // scan chrome ended above: it is due, for what says whether a scan will
    // draw the tree (review F3.1). The scan chrome's next end clears it.
    state.indexScanDue = true;
    // The lists, Cost to keep, Drive health and the budgets are a scan's
    // too: each says it is on its way, not the last folder's figures (review
    // F1.12). They rewrite cards under focus — a budget's Edit button —
    // so focus they take away moves on (review F2.5).
    withFocusKept(() => {
      showListsPending();
      void loadCostEstimate();
      void loadDriveHealth();
      void loadBudgets();
    });
    emit(TOPIC.scan, null);
    // The first paint of a tree hides the welcome, whose "Choose a folder"
    // the folder browser handed focus back to (review F2.6).
    withFocusKept(() => { switchView(state.view); });
    return;
  }
  const lists = loadDashboardLists();
  // C1. The card shows it is loading now, so a rescan never leaves the last
  // scan's prices standing; its what-if asks for the cleanup suggestions, a
  // walk of the whole tree, only once the three list walks have answered
  // (U-16) — it used to start alongside them and compete for the server.
  void loadCostEstimate(lists);
  await lists;
  // Tell every view a new scan landed, then re-enter the current one. Views
  // repoint themselves at the new root in onScanChange, so switchView's mount
  // is the single load path — previously this called loadTreemap()/renderGrid()
  // and *then* switchView(), loading the active view twice on every scan.
  emit(TOPIC.scan, state.scanId);
  // The desktop shell hears that a scan completed now (hunt C01) — after the
  // views have it, where the page's own queue starts its next folder too —
  // with what the notice says. Not a reopened scan, which completed before
  // the page loaded, nor one shown after its Stop, which told the shell; nor
  // when a scan has begun since, whose own end the shell will hear.
  if (!reopenedAt && !afterStop && !state.scanning && typeof tellDesktop === 'function') {
    tellDesktop('scanFinished', { ok: true, path: root.path, files: typeof files === 'number' ? files : undefined, bytes: root.size });
  }
  // Re-entering the view repaints what it holds, focus on it included (review F2.6).
  withFocusKept(() => { switchView(state.view); });
  // A1: make the *next* open of this folder instant. Background, non-blocking,
  // and only for real local scans of a size TreeMap indexes on its own —
  // buildIndexInBackground decides (indexAutoPlan): a cloud account has no
  // filesystem to watch, re-indexing what we just read from the index would
  // be pointless work, and a whole disk is not indexed automatically (U-1).
  // This scan's own counts, not state.scanStats: another scan finishing
  // while the lists loaded has replaced those (Track U review L4). Never for
  // a reopened scan: the page reopens it as it loads, and an index build is a
  // walk of the folder — opening TreeMap starts none (hunt C16). Its badge is
  // painted from the index as it stands.
  if (root.path && !afterStop && !reopenedAt) buildIndexInBackground(root.path, stats || null);
  else if (root.path && reopenedAt) void indexStatusFor(root.path).then((info) => { if (state.root === root) renderIndexBadge(info); });
  renderGrowthProjection();
  loadBudgets();
  // The snapshot (and its time-slider tree) is saved asynchronously after the
  // scan completes — pick it up once it lands.
  setTimeout(() => { if (state.view === 'treemap') refreshTimebar(); }, 1500);
  if (state.live.wanted) enableLive(); // Live survives rescans
}

/**
 * The three dashboard lists — largest files, type breakdown, largest folders.
 *
 * Split out of finishScan so a failed fetch has a retry that re-runs only
 * this, not the whole scan. When one of the three fails, the cards say so
 * with a Try again: the old fall-through painted "No files found." and "No
 * folders above 1 MB found." under a headline that had just said 812,441
 * files — a 5xx, an unreadable body or an exhausted 429 backoff became a
 * confident statement that the folder is empty, and the toast that
 * contradicted it faded in seconds.
 *
 * All three poll. finishScan normally runs against a scan that just
 * finished, but not always: a rescan can be in flight against this one, and
 * all three endpoints answer a running scan with 202. Without poll the 202
 * body has no `files` / `types` / `folders` field, so the row either read
 * undefined or — once api() started throwing on an unrequested 202 — told
 * the user "could not load stats" about a scan that was merely still running.
 *
 * Returns true when the lists were painted from data.
 */
async function loadDashboardLists() {
  const scanId = state.scanId;
  if (!scanId) return false;
  try {
    const [lf, ft, lfo] = await Promise.all([
      api(`/api/large-files?scanId=${scanId}&limit=10&minSize=1`, undefined, { poll: true }),
      api(`/api/file-types?scanId=${scanId}`, undefined, { poll: true }),
      // Sixty for a card of ten: the card folds a folder that is nearly all of
      // a folder above it into that row and fills on (bigFolderRows, G15).
      api(`/api/large-folders?scanId=${scanId}&limit=60`, undefined, { poll: true }),
    ]);
    if (scanId !== state.scanId) return false; // a newer scan owns the cards now
    state.largest = lf.files; state.types = ft.types; state.bigFolders = lfo.folders;
    seedNodes(lf.files); // right-click/cart on a big file must resolve even if pruned away
    const largest = state.largest[0] || null;
    // Name and size apart: only the name gives way to a narrow tile (G14).
    $('statLargest').textContent = largest ? largest.name : '–';
    $('statLargestSize').textContent = largest ? ` · ${formatBytes(largest.size)}` : '';
  } catch (e) {
    if (scanId !== state.scanId) return false;
    const retry = (host) => {
      host.innerHTML = '<div class="muted">Couldn’t load this list — ' + escapeHtml(e.message) +
        ' <button class="pill" type="button" data-retry-lists>Try again</button></div>';
      host.querySelector('[data-retry-lists]').addEventListener('click', () => { void loadDashboardLists(); });
    };
    retry($('bigFiles'));
    retry($('bigFolders'));
    retry($('donutLegend'));
    fxDonutLoadingSync(false);
    return false;
  }
  refreshBigFiles();
  renderBigFolders();
  state.donut.animated = false;
  renderDonut();
  return true;
}

/* Features 11 + 10 — hard-link / cloud-placeholder dashboard notes. */
function renderDiskNotes() {
  const s = state.scanStats || {};
  const hl = $('hardlinkRow');
  if (hl) {
    if (s.hardlinkedFiles > 0) {
      $('hardlinkText').textContent = `${formatCount(s.hardlinkedFiles)} extra file name${s.hardlinkedFiles === 1 ? '' : 's'} (${formatBytes(s.hardlinkedBytes)})`;
      hl.hidden = false;
    } else hl.hidden = true;
  }
  const sp = $('sparseRow');
  if (sp) {
    if (s.sparseFiles > 0) {
      $('sparseText').textContent = `${formatCount(s.sparseFiles)} file${s.sparseFiles === 1 ? ' claims' : 's claim'} ${formatBytes(s.sparseBytes)} more than ${s.sparseFiles === 1 ? 'it takes' : 'they take'}`;
      sp.hidden = false;
    } else sp.hidden = true;
  }
  const cl = $('cloudRow');
  if (cl) {
    if (s.cloudFiles > 0) {
      $('cloudText').textContent = `${formatCount(s.cloudFiles)} cloud placeholder${s.cloudFiles === 1 ? '' : 's'} (${formatBytes(s.cloudBytes)} online-only)`;
      cl.hidden = false;
    } else cl.hidden = true;
  }
  const ct = $('tmCloudToggle');
  if (ct) {
    if (s.cloudFiles > 0) {
      ct.hidden = false;
    } else {
      ct.hidden = true;
      state.treemap.hideCloud = false;
      ct.classList.remove('active');
      ct.setAttribute('aria-pressed', 'false');
      fxTmPillBeamsSync(); // FX: the reset flips hideCloud outside its toggle
    }
  }
  // Feature 19 — which scan engine ran, and how fast.
  const en = $('engineRow');
  if (en) {
    // `scanned` is null whenever the counters that came back do not describe
    // the tree on screen — the instant-open path sets it that way when it reads
    // a subfolder of an indexed root. This row is nothing but that number and a
    // rate derived from it, and `formatCount(null)` prints "0", so an ungated
    // row states "scanned 0 items" and "0/s" as fact about a folder that plainly
    // holds files. There is nothing honest left to say, so the row says nothing.
    if (s.engine && s.durationMs > 0 && s.scanned != null) {
      // The names Settings › Scan engine uses. The walker is one engine at any
      // pool size: the desktop app always sizes the pool past 4, and "Turbo
      // walker" then sat beside "budget: Eco".
      // A tree painted from the saved index was read, not scanned (B08: the
      // row said "index — scanned 106,664 items").
      const label = { native: 'Native engine', 'gdu-turbo': 'gdu', 'turbo-walker': 'Built-in walker', 'ntfs-mft': 'NTFS turbo', walker: 'Built-in walker', cloud: 'Cloud metadata listing', index: 'Saved index' }[s.engine] || s.engine;
      const verb = s.engine === 'index' ? 'read' : 'scanned';
      // A rate over less than a second is mostly the scan's setup, not its
      // speed: one file in a millisecond read "1,000/s" (C10).
      const RATE_MIN_MS = 1000;
      const rate = s.durationMs >= RATE_MIN_MS ? Math.round(s.scanned / (s.durationMs / 1000)) : 0;
      // "0.0 s" reads as no time at all: under a twentieth of a second is
      // "under 0.1 s" (QA fourth pass E14a), as the status line says.
      const took = (s.durationMs / 1000).toFixed(1) === '0.0' ? 'under 0.1 s' : `${(s.durationMs / 1000).toFixed(1)} s`;
      // Items, said to be files and folders: the count is every entry read,
      // folders included, and "106,664 items" beside "Scanned 101,034 files"
      // read as two file counts that disagree (design pass G13). The speed and
      // the budget are details, in the disclosure under the line.
      const items = s.scanned === 1 ? '1 item' : `${formatCount(s.scanned)} items (files and folders)`;
      $('engineText').textContent = `${label} — ${verb} ${items} in ${took}`;
      // Phase 3 — why this engine ran, on hover: the stats' own sentence, and
      // the fallback reason when something faster could not run.
      $('engineText').title = engineReasonTitle(s);
      // Each hint is true of its own engine only: gdu shows a folder it was
      // refused as an empty one (missingGigabytes.ts), and every scan carries
      // ioThreads, so the I/O-thread hint is the walker's alone.
      const walker = s.engine === 'walker' || s.engine === 'turbo-walker';
      // Why the walker ran, on the line itself rather than only on hover (C10).
      // When a rule chose it — a "don't scan" pattern, the setting, a single
      // file — that rule is the first clause of the engine's own reason. When
      // a faster engine failed, its sentence is a developer's (a module path,
      // a rebuild command): the line says so plainly and the disclosure under
      // it holds the sentence. The hover title alone reached only a pointer;
      // a keyboard, a touch and a screen reader had no way to it (C10 review).
      // One fallback is no failure: the Scan engine setting asked for gdu and
      // a rule kept it off (a pattern, a single file, a rescan), or no gdu was
      // there to run. The server names it "<rule> (the Scan engine setting
      // asked for gdu)", the rule in its own plain words, and that rule is
      // why the walker ran (C10 review).
      const WALKER_RAN = 'the built-in walker ran: ';
      const GDU_ASKED = ' (the Scan engine setting asked for gdu)';
      const reason = typeof s.engineReason === 'string' ? s.engineReason : '';
      const fallback = typeof s.fallbackReason === 'string' ? s.fallbackReason : '';
      const ruleAt = reason.indexOf(WALKER_RAN);
      const failed = walker && !!fallback && !fallback.endsWith(GDU_ASKED);
      const why = !walker ? ''
        : fallback.endsWith(GDU_ASKED) ? `Used because ${fallback.slice(0, -GDU_ASKED.length)}, though the Scan engine setting asked for gdu.`
          : failed ? 'Used because a faster engine could not run on this computer.'
            : ruleAt === -1 ? '' : `Used because ${reason.slice(ruleAt + WALKER_RAN.length).split('; ')[0]}.`;
      $('engineWhy').hidden = !failed;
      $('engineWhyText').textContent = failed ? fallback : '';
      const reads = walker && s.ioThreads > 4 ? `It reads up to ${s.ioThreads} files and folders at once, which keeps the disk busy.` : '';
      // On the line: only what changes what the numbers mean — gdu's empty
      // folders — or why a slower engine ran. How an engine works, how fast it
      // went and the budget it ran under are its details (G13).
      $('engineHint').textContent = s.engine === 'gdu-turbo'
        ? 'A bundled gdu process per top-level folder — faster than the built-in walker, but a folder it may not open shows as empty instead of being counted.'
        : why;
      const pace = [rate ? `${formatCount(rate)} items a second` : '', engineBudgetNote(s)].filter(Boolean).join(' · ');
      const how = s.engine === 'native'
        ? 'The built-in native engine lists each folder in one call and hands the tree over in one piece — same counts as the built-in walker.'
        : s.engine === 'ntfs-mft'
          ? "Read from the drive's file table by an elevated, read-only helper, then checked against what TreeMap can open itself."
          : reads;
      const detail = [pace ? pace.charAt(0).toUpperCase() + pace.slice(1) + '.' : '', how].filter(Boolean).join(' ');
      $('engineMoreText').textContent = detail;
      $('engineMore').hidden = !detail;
      en.hidden = false;
    } else en.hidden = true;
  }
  // renderCloudSafe() walks the whole tree server-side. It only fills the Clean
  // Up modal, so it runs when that modal opens — not on every scan completion.
}

/* Phase 2 — the budget the scan ran under, when the stats say so. `effective`
   is what it started at (Automatic resolves to Turbo for a scan started here
   and to Balanced for any other, a step lower on battery and Eco under heat).
   A scan started here can be held a step lower part-way while an unattended
   scan runs; /stats keeps the start (P8-1), and the record keeps the changes
   for /live. Stats from a build without the field add nothing rather than a
   guess. */
function budgetPresetLabel(preset) {
  const s = String(preset || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}
function engineBudgetNote(s) {
  const effective = s && s.budget ? s.budget.effective : '';
  return effective ? `scanning budget: ${budgetPresetLabel(effective)}` : '';
}
/* Phase 3 — the hover title of the engine row: why this engine ran, and what
   fell back when something faster could not run. Stats from a build without
   the field say nothing. */
function engineReasonTitle(s) {
  const reason = s && typeof s.engineReason === 'string' ? s.engineReason : '';
  if (!reason) return '';
  const fallback = typeof s.fallbackReason === 'string' && s.fallbackReason ? s.fallbackReason : '';
  return fallback ? `${reason} — ${fallback}` : reason;
}

/* Feature 10 — "Cloud-safe deletes" list in the Clean Up modal. */
async function renderCloudSafe() {
  const host = $('cloudResults');
  const tab = $('cleanTabCloud');
  if (!host) return;
  const hide = () => { if (tab) tab.hidden = true; host.innerHTML = ''; };
  // The scan the tree on screen came from (treeScanId) — the list is of that
  // tree's files — never a scan still walking (BQJ-1b). The saved index's
  // tree has none, and the tab claims nothing.
  const scanId = treeScanId();
  if (!scanId) { hide(); return; }

  // The client tree is pruned to a node budget, so counting placeholders here
  // would only see the part that came through. The server walks the whole scan:
  // its counts and byte totals are exact, only the file lists are capped.
  // An answer, a "still counting" or a failure the older scan gives once
  // another tree is on screen — the rescan landed, a Stop or an index paint
  // changed it — is not painted over it: the list is asked again of the
  // scan the tree now came from, or hidden for the saved index's (review F2.4).
  const superseded = () => {
    if (scanId === treeScanId()) return false;
    void renderCloudSafe();
    return true;
  };
  let data;
  try {
    data = await api(`/api/cleanup/cloud-safe?scanId=${scanId}`);
  } catch (e) {
    if (superseded()) return;
    // Two different answers arrive here and only one of them is a failure.
    // While a scan runs the endpoint answers 202 { status: 'running' }, which
    // api() turns into a thrown `stillWorking` error rather than a body — so
    // the old `if (!data.groups)` guard that claimed to handle the 202 could
    // never run, and the catch below it hid the whole tab. During any rescan
    // the Cloud-safe tab therefore vanished out from under the user instead of
    // saying it was working. "Not yet" keeps the tab and explains itself;
    // "broken" is the only thing that still takes the tab away.
    if (e && e.stillWorking) {
      if (tab) tab.hidden = false;
      host.innerHTML = '<div class="muted">Still counting online-only files — the scan is finishing. This list fills in on its own.</div>';
      return;
    }
    hide();
    return;
  }
  if (superseded()) return;

  if (tab) tab.hidden = data.totalCount === 0;
  if (!data.totalCount) { host.innerHTML = ''; return; }
  for (const g of data.groups) seedNodes(g.files); // these get staged into the cart from here

  const label = { icloud: 'iCloud Drive', onedrive: 'OneDrive', dropbox: 'Dropbox', cloud: 'Cloud' };
  host.innerHTML = `<div class="muted" style="margin-bottom:10px;">${formatCount(data.totalCount)} online-only file${data.totalCount === 1 ? '' : 's'} (${formatBytes(data.totalSize)} logical). The cloud keeps the original, so removing the local copy is safe.</div>` +
    data.groups.map((g) =>
      `<div style="margin-bottom:14px;">
        <div class="rule-row" style="padding:6px 0;"><b>${label[g.provider] || 'Cloud'}</b><span class="size-badge num" style="margin-left:auto;">${formatCount(g.count)} · ${formatBytes(g.totalSize)}</span></div>
        <div class="clean-list">` + g.files.map((n) =>
          `<div class="clean-item">${chipFor(n, 13)}<div class="meta"><div class="nm">${escapeHtml(n.name)}</div><div class="pth" title="${escapeHtml(n.path)}">${escapeHtml(n.path)}</div></div>` +
          `<span class="dt num">${formatDate(n.modifiedAt)}</span><span class="size-badge num">${formatBytes(n.size)}</span>` +
          cartButtonHtml(n.path, n.name) + `</div>`
        ).join('') + `</div>
      </div>`
    ).join('');
  refreshCartButtons();
}

/* Feature 7 — "disk full in ~N days" projection from snapshot history. */
/* Feature 21 — disk-full forecast (server-side fit with honesty gates). */
async function renderGrowthProjection() {
  const el = $('growthProj');
  if (!el) return;
  el.hidden = true;
  if (!state.root || isCloudScan()) return; // the disk-full forecast is about this disk
  let f;
  try { f = await api('/api/forecast?path=' + encodeURIComponent(state.root.path)); }
  catch { return; }

  if (f.status === 'ok' && f.fullInDays) {
    const d = Math.max(1, Math.round(f.fullInDays));
    if (d >= 365) return; // a year+ out isn't worth a warning banner
    const culprits = (f.topGrowers || []).slice(0, 3)
      .map(g => `${g.name} +${formatBytes(g.bytesPerDay)}/day`).join(' · ');
    // The slope was fitted to THIS scan's history. When the scan is a folder
    // — the tour's home folder, a Projects tree — that is the folder's growth
    // measured against the whole volume's free space, and growth anywhere
    // else on the volume is invisible to it. The sentence says which. A
    // server that does not say (`basis`) is read as a folder scan, the
    // honest default: most scans are.
    const wholeVolume = f.basis === 'volume';
    const days = `<b>~${formatCount(d)} day${d === 1 ? '' : 's'}</b>`;
    const name = escapeHtml(state.root.name || state.root.path);
    el.className = 'growth-proj ' + (d < 30 ? 'danger' : 'warn');
    el.innerHTML = icon('trendUp', 15) + '<span>' + (wholeVolume
      ? `At current growth (+${formatBytes(f.bytesPerDay)}/day), this disk is full in ${days}`
      : `At ${name}’s growth (+${formatBytes(f.bytesPerDay)}/day), the disk it lives on is full in ${days}`) +
      (culprits ? ` — top culprits: ${escapeHtml(culprits)}` : '') +
      (wholeVolume ? '' : ' <span class="muted">Growth elsewhere on the disk is not counted.</span>') + '</span>';
    el.hidden = false;
    return;
  }
  if (f.status === 'insufficient') {
    // Honest placeholder: the feature exists, the history doesn't yet.
    el.className = 'growth-proj';
    el.innerHTML = icon('clock', 15) + `<span class="muted">Disk-full forecast: ${escapeHtml(f.reason || 'not enough history yet — keep scanning.')}</span>`;
    el.hidden = false;
    return;
  }
  if (f.status === 'erratic' || f.status === 'shrinking' || f.status === 'stable') {
    el.className = 'growth-proj';
    el.innerHTML = icon(f.status === 'erratic' ? 'alert' : 'checkCircle', 15) +
      `<span class="muted">Disk-full forecast: ${escapeHtml(f.reason || '')}</span>`;
    el.hidden = false;
  }
}

/* ── Refused folders ── */
/* A folder the operating system would not open is not an empty folder.
   On a Mac without Full Disk Access, scanning Desktop, Documents or
   Downloads returns nothing at all, and every surface downstream said so
   cheerfully: "Scanned 0 files — 0 B", a green "Scan complete" toast, and a
   first-run card congratulating the user on a folder with nothing to clean.
   That is the app being confidently wrong about the user's own disk.

   Two sources of truth, in order. The server counts what it was refused
   while walking (`stats.refused`), which costs nothing and covers every
   engine but gdu: gdu shows a folder it may not open as an empty one, so a
   gdu scan's count is 0 whatever was refused (the Missing GB view says that
   count is unknown). An older server sends no such field, and there the page asks one
   question of its own: the folder picker's listing endpoint answers 403 for
   a path the OS is protecting, which is a definitive answer in a single
   call. Only a result that looks like a refusal is worth asking about — a
   0-byte root, or one of the three protected folders the scan came back
   empty-handed from. */

/** The three folders macOS protects by default; the ones a home scan loses. */
const PROTECTED_HOME_DIRS = ['Desktop', 'Documents', 'Downloads'];

/* Last path segment, either separator — for naming folders in a sentence.
   NOT `baseNameOf`: `function baseName` is a slice anchor in
   tests/frontendContract.test.ts, and a second match earlier in the page
   collapsed three of its regions to the empty string. */
function lastPathSegment(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
}

/* Track U, U-11. Whether Full Disk Access is on is the server's answer
   (/api/platform/capabilities → fullDiskAccess: { state, grantee, advice }),
   and so is every sentence that says what to do about it: `advice` is built
   by the server's one builder for the state it probed, naming whoever the
   grant belongs to (TreeMap in the desktop app; in a browser tab, the app
   that started the server). The page shows it as is, and writes none of its
   own: "Give TreeMap Full Disk Access" was false for a folder's own
   permissions, on a Mac that already had it, and in web mode. */

/** The server's Full Disk Access answer, or null where there is none (a failed load, an older server). */
function fullDiskAccessInfo() {
  const fda = state.capabilities && state.capabilities.fullDiskAccess;
  return fda && typeof fda.state === 'string' ? fda : null;
}

/**
 * The hint under the refused count on a Mac: the server's sentence for the
 * state it probed (`fda`), unless access is on now and the scan on screen
 * started without it, or without the page knowing. That is decided by the
 * state the scan started under (`state.scanAccessState`, kept by
 * scanAccessNotice), never by a read the recheck made before its ask: a scan
 * begun while the ask was out learned from its own start that access was
 * already on, and was still told "on now" (review F3.1). The server words a
 * scan's count by the same pair (scanAccessAdvice).
 */
function accessHintFor(fda) {
  const ran = state.scanAccessState;
  if (fda && fda.state === 'granted' && ran === 'not-granted') {
    // Switched on after this scan ran without it: what it refused may be readable now.
    return 'Full Disk Access is on now, so a new scan can read the folders macOS kept TreeMap out of.';
  }
  if (fda && fda.state === 'granted' && (ran === null || ran === 'unknown')) {
    // On now, but the page never knew whether it was on when this scan ran
    // (no answer, or "unknown"). "On now" would promise a rescan that may
    // refuse the same folders, and the server's "does not change that" may
    // be false: both halves are said (review F2.2).
    return 'Full Disk Access is on. If it was off when this scan ran, a new scan can read the folders macOS kept TreeMap out of; folders closed by their own permissions stay closed.';
  }
  if (fda && typeof fda.advice === 'string' && fda.advice) return fda.advice;
  // No answer from the server: say what is known, and name no one to grant it to.
  return 'macOS or the folders’ own permissions kept TreeMap out of them. Privacy settings show whether Full Disk Access is on.';
}

/** A scan of the whole disk or of the home folder: the scans that lose what macOS protects. */
function isWholeDiskOrHome(p) {
  const s = String(p || '').trim();
  if (s === '/' || s === '~' || s === '~/') return true;
  const home = String((state.system || {}).homeDir || '').replace(/\/+$/, '');
  return !!home && s.replace(/\/+$/, '') === home;
}

/**
 * Repaint the access row without losing a keyboard user's place (U-11,
 * reviews F1.11 and F2.6). [hidden] takes an element out of the page, and a
 * focused one hands focus to <body>: "Open Privacy settings" once the
 * recheck finds access on, "What's missing?" when a scan's notice replaces
 * its count, "Show all" when a rescan names every folder it was refused
 * (C06), the whole row when a rescan refused nothing. So where focus is is
 * read before `paint` runs; if it was in the row and is gone after, it moves
 * to "What's missing?", else the next button still showing there, else to
 * the row itself (which says what changed), else — the row gone — to the
 * Scan button above it. Focus anywhere else is never moved.
 */
function keepAccessFocus(paint) {
  const row = $('accessRow');
  const was = document.activeElement;
  const inRow = !!was && (was === row || row.contains(was));
  paint();
  // Where focus goes, if the part of the row it was on is gone.
  const stays = ['accessMissingBtn', 'accessOpenBtn', 'accessListBtn'].map((id) => $(id)).find((b) => !row.hidden && !b.hidden);
  const to = inRow && (row.hidden || was.hidden) ? (stays || (row.hidden ? $('scanBtn') : row)) : null;
  // Every paint of the row runs in here, and the row comes on screen with its
  // words already in it, which a screen reader seldom announces: its count and
  // its hint, a line each, are said in #accessSaid a frame later, and taken
  // back as it goes (BQS). Focus moved onto the row itself reads them there,
  // so the region keeps them as heard and stays silent — said in both, they
  // were heard twice (BQT item 27). Guarded: a page reader may lift this
  // without sayAloud.
  if (typeof sayAloud === 'function') {
    sayAloud('accessSaid', row.hidden ? '' : [$('accessText').textContent, $('accessHint').textContent].filter(Boolean).join('\n'), to === row);
  }
  if (to) to.focus();
}

/** Paint the before-the-total notice into the access row (no count yet, and no byte figure: U-D14). */
function paintAccessNotice() {
  const fda = fullDiskAccessInfo();
  $('accessText').textContent = 'macOS keeps TreeMap out of the folders it protects (Mail, Messages, Safari, the Trash), so their size will not be in this total.';
  $('accessHint').textContent = accessHintFor(fda);
  $('accessMissingBtn').hidden = true; // nothing is missing yet: the scan has not finished
  $('accessListBtn').hidden = true; // nor any list of what it was refused
  $('accessRow').hidden = false;
  $('accessOpenBtn').hidden = !!fda && fda.state === 'granted';
}

/**
 * Before a scan of / or the home folder on a Mac without Full Disk Access,
 * say what the total will leave out — a notice beside the running scan,
 * never a question in front of it (U-Q12). Returns whether it showed.
 */
function preScanAccessNotice(path) {
  const mac = (state.system || {}).platform === 'darwin';
  const fda = mac ? fullDiskAccessInfo() : null;
  state.accessNotice = fda && fda.state === 'not-granted' && isWholeDiskOrHome(path) ? path : null;
  if (!state.accessNotice) return false;
  keepAccessFocus(paintAccessNotice);
  return true;
}

/**
 * A scan's start: ask the server whether Full Disk Access is on, then decide
 * the notice (review F2.1). The page's own answer is read once, at load, and
 * goes stale exactly where it matters: in web mode the fix the server
 * prescribes is to restart the server, and nothing reloads the open tab, so
 * a / scan on a server that now had the grant still said macOS would keep
 * folders out of its total, and its refusals were still worded "Give … Full
 * Disk Access". On a cold start the answer was not in yet, and a
 * first-minute whole-disk scan had no notice at all.
 *
 * The state the scan starts under is kept in `state.scanAccessState`, and
 * the scan's refused row is worded by it when the scan ends (review F3.1):
 * the page's own answer at once — so a scan that settles before the server
 * answers forgets whatever the recheck learned about the last scan — then
 * the server's answer when it comes. Only this scan's own start writes it,
 * so however the recheck's ask and this one interleave, a scan that started
 * with access is never told "on now".
 *
 * Called beside the scan request, never awaited in front of it. A GET: within
 * the server's 30-second cache no probe is re-run, and past it the server
 * probes every capability again, as for any read of them — long enough for
 * a short scan to settle first (review F3.2). Only `fullDiskAccess` is
 * replaced, and TOPIC.capabilities is not emitted (see the recheck below).
 * An answer that arrives after another scan began (`gen`) decides nothing
 * for either scan. One that arrives after its own scan ended paints no
 * notice, but rewords that scan's refused row, which was painted from the
 * page's own answer (review F3.2). With no answer, the page's own decides.
 */
async function scanAccessNotice(path, gen) {
  const held = fullDiskAccessInfo();
  state.scanAccessState = held ? held.state : null; // until the server answers, what the page holds
  let fda = null;
  try {
    const res = await api('/api/platform/capabilities');
    const answer = res && res.capabilities ? res.capabilities.fullDiskAccess : null;
    if (answer && typeof answer.state === 'string') {
      fda = answer;
      state.capabilities = { ...(state.capabilities || {}), fullDiskAccess: answer };
    }
  } catch {
    // No answer: the page's own is what there is.
  }
  if (gen !== state.scanGen) return false; // another scan began: it keeps the state it started under
  if (fda) state.scanAccessState = fda.state;
  if (!state.scanning) {
    if (fda) renderRefusedFolders(); // settled first: word its row by the state it ran under
    return false;
  }
  return preScanAccessNotice(path);
}

/**
 * Paint (or hide) the "could not be read" row from whatever we know.
 *
 * A count of 0 from the server is an answer, not a silence (QA D46): reading
 * it as "nothing said" fell back to the PREVIOUS scan's refusals, so a clean
 * scan of another folder went on saying "69 folders could not be read … Give
 * TreeMap Full Disk Access". And a refusal belongs to the scan it was found
 * in — `scanId` is stamped on it, and one from any other scan is not shown.
 */
function renderRefusedFolders() {
  keepAccessFocus(paintRefusedRow);
}

/** renderRefusedFolders' painting, run inside keepAccessFocus. */
function paintRefusedRow() {
  const row = $('accessRow');
  const stats = state.scanStats || {};
  // The server's count wins when it sent one, zero included; otherwise
  // whatever this scan's own probe found.
  const answered = !!stats.refused && typeof stats.refused.dirs === 'number';
  if (answered) {
    state.scanRefused = stats.refused.dirs > 0
      ? { dirs: stats.refused.dirs, examples: [...(stats.refused.examples || [])], root: false, scanId: state.scanId }
      : null;
  }
  // Another scan's refusals are dropped, not merely hidden: the tour reads
  // state.scanRefused too (170), and would repeat them as this scan's.
  if (state.scanRefused && state.scanRefused.scanId !== state.scanId) state.scanRefused = null;
  // While a whole-disk or home scan runs without Full Disk Access, its notice
  // is what the row says: this scan has refused nothing yet that it can count.
  if (state.scanning && state.accessNotice) {
    paintAccessNotice();
    return;
  }
  const found = state.scanRefused;
  if (!found || !found.dirs) {
    row.hidden = true;
    return;
  }
  const mac = (state.system || {}).platform === 'darwin';
  const names = (found.examples || []).map(lastPathSegment).filter(Boolean);
  const n = found.dirs;
  // The row names at most five (the server's examples). It says how many it
  // does not name, and offers the server's list of every one (C06): "69
  // folders could not be read — " and five names read as the whole list.
  const more = n - names.length;
  $('accessText').textContent =
    `${formatCount(n)} folder${n === 1 ? '' : 's'} could not be read` +
    (names.length ? ` — ${names.join(', ')}${more > 0 ? ` and ${formatCount(more)} more` : ''}` : '');
  $('accessListBtn').textContent = `Show all ${formatCount(n)}`;
  $('accessListBtn').hidden = !(more > 0);
  const fda = mac ? fullDiskAccessInfo() : null;
  $('accessHint').textContent = mac
    ? accessHintFor(fda)
    : 'TreeMap does not have permission to open them. Check the folder’s permissions, then scan again.';
  $('accessMissingBtn').hidden = false;
  row.hidden = false;
  // Nothing to switch on once it is on; off macOS there is no such setting.
  $('accessOpenBtn').hidden = !mac || (!!fda && fda.state === 'granted');
}

/**
 * Ask the OS directly, when the server did not say.
 *
 * One call per candidate, and only for candidates that look refused: the
 * scanned folder itself when it came back empty, or a protected home folder
 * the scan did not read. A 404 is "not on this machine", which is not a
 * refusal and is not counted.
 *
 * Once per scan (review F3.6). The probe ends by emitting TOPIC.scan, whose
 * subscriber below starts it; with no `refused` in the stats (the
 * result-derived fallback, when /stats failed) nothing else stopped it, and
 * a refused empty root was asked about again and again — one request and
 * one 15-second error toast per cycle, every TOPIC.scan listener re-run
 * each time. `refusedProbedFor` is the scan it last asked about, found
 * something or not; an answer dropped because a rescan landed meanwhile
 * does not count as asked.
 */
let refusedProbedFor = null;
async function probeRefusedFolders() {
  const stats = state.scanStats || {};
  if (stats.refused) return; // the server already answered
  const root = state.root;
  if (!root) return;
  const scanId = state.scanId;
  if (refusedProbedFor === scanId) return; // asked already: its own emit, or later news of the same scan
  refusedProbedFor = scanId;
  const home = (state.system || {}).homeDir || '';
  // "\" separates only a Windows path (POL item 7): a home folder "/Users/a\b" is asked about as
  // "/Users/a\b/Desktop", never "/Users/a\b\Desktop".
  const sep = /^(?:[A-Za-z]:|\\\\)/.test(String(root.path)) ? '\\' : '/';
  const readNothing = (node) => !node || (!node.size && !(node.children || []).length);

  const candidates = [];
  let rootRefused = false;
  if (readNothing(root)) {
    candidates.push(root.path);
    rootRefused = true;
  } else if (home && (root.path === home || root.path === home + sep)) {
    for (const name of PROTECTED_HOME_DIRS) {
      const p = home + sep + name;
      const known = state.pathIndex && state.pathIndex.get(p);
      if (known && known.size > 0) continue; // the scan read it — nothing to ask
      candidates.push(p);
    }
  }
  if (!candidates.length) return;

  const refused = [];
  for (const p of candidates) {
    try {
      await api('/api/fs/list?path=' + encodeURIComponent(p));
    } catch (e) {
      if (e && (e.status === 403 || e.code === 'PERMISSION_DENIED')) refused.push(p);
      // 404 and everything else: not a refusal, and not worth a guess.
    }
  }
  // A rescan may have landed while we were asking; its tree is not this one.
  if (scanId !== state.scanId) {
    if (refusedProbedFor === scanId) refusedProbedFor = null; // dropped: asked again if this scan comes back
    return;
  }
  if (!refused.length) return;

  state.scanRefused = { dirs: refused.length, examples: refused, root: rootRefused, scanId };
  renderRefusedFolders();
  if (rootRefused) {
    const mac = (state.system || {}).platform === 'darwin';
    const line = mac
      ? 'macOS would not let TreeMap look inside this folder.'
      : 'TreeMap is not allowed to read this folder.';
    // What to do is the row's to say: renderRefusedFolders just painted it with
    // this advice, and #accessSaid says it aloud. In the toast as well, it was
    // said twice (BQT item 29, BQS review L1). Only where the row does not show
    // it — not on screen, or saying something else — does the toast carry it.
    // On screen is the row and what holds it: the row stands in the Dashboard,
    // and painted while another view is up — a quiet rescan keeps the map —
    // it shows the advice nowhere (BQU item 38).
    const advice = mac ? accessHintFor(fullDiskAccessInfo()) : '';
    const rowSaysIt = $('accessRow').getClientRects().length > 0 && $('accessHint').textContent === advice;
    const fix = advice && !rowSaysIt ? ' ' + advice : '';
    const el = $('scanStatus');
    el.classList.add('error');
    el.innerHTML = escapeHtml(line);
    toast(line + fix, 'error', 15000);
  }
  emit(TOPIC.scan, state.scanId);
}

/**
 * The sheet "Show all" opens (browser re-check C06): every folder this scan
 * was refused, by path, from GET /api/scan/:scanId/refused — the row names
 * five, and nothing else in the app named the rest. The count and the hint
 * are the row's own. An answer is painted only for the ask that is still the
 * latest, and only for the scan still on screen: a list that arrives after a
 * new scan landed is another scan's, and says so rather than standing in for
 * this one's.
 */
let refusedListAsk = 0;
async function openRefusedList() {
  const scanId = state.scanId;
  const ask = ++refusedListAsk;
  const found = state.scanRefused;
  $('refusedModalMeta').textContent = found && found.dirs ? `· ${formatCount(found.dirs)}` : '';
  $('refusedModalNote').textContent = $('accessHint').textContent;
  const body = $('refusedModalBody');
  const note = (text) => `<div class="muted" style="padding:4px 2px 12px;display:flex;align-items:flex-start;gap:8px;">${icon('alert', 15)}<span>${escapeHtml(text)}</span></div>`;
  body.innerHTML = '<div class="muted" style="padding:18px 2px;">Loading the list…</div>';
  $('refusedModal').classList.add('open');
  let list;
  try {
    list = await api(`/api/scan/${encodeURIComponent(scanId)}/refused`);
  } catch (e) {
    if (ask !== refusedListAsk) return;
    const why = String((e && e.message) || 'the server did not answer').replace(/\.$/, '');
    body.innerHTML = note(`TreeMap could not load the list: ${why}.`);
    return;
  }
  if (ask !== refusedListAsk) return; // opened again since: the newer ask paints
  if (scanId !== state.scanId) {
    body.innerHTML = note('A new scan finished while this list loaded. Open the list again from the Dashboard to see the folders that scan could not read.');
    return;
  }
  $('refusedModalMeta').textContent = `· ${formatCount(list.dirs)}`;
  body.innerHTML = (list.unnamedReason ? note(list.unnamedReason) : '') +
    '<div class="refused-list">' +
    (list.paths || []).map((p) => `<div class="refused-item">${escapeHtml(p)}</div>`).join('') +
    '</div>';
}
/* ── end refused folders ── */
subscribe(TOPIC.scan, (scanId) => {
  renderRefusedFolders();
  if (scanId) void probeRefusedFolders();
});
/* ── Drives mounted inside the folder ── */
/* Track U, U-27. A drive mounted inside the scanned folder — a disk image,
   the iOS Simulator's runtime volumes, a nullfs view an app makes of its own
   bundle — is a separate disk, and under "Stay on this drive" (Settings, the
   default) no scan goes into it. Its mount point stays in the tree as an
   empty folder (gdu leaves one deeper than the folder's own children out of
   the tree), which says nothing by itself: this row names the drives the
   scan stayed out of, or, under "Include drives mounted inside it", the ones
   it counted, or why it could not tell. It reads GET /api/scan/:id/boundary
   once a scan has painted (TOPIC.scan), never in front of the paint, and
   writes only text: a drive may be named anything. */

/** The note for a /boundary answer — its sentence, and whether Settings can change it — or null when there is nothing to say. */
function mountsNoteText(b) {
  if (!b || !b.rule) return null;
  if (!b.notEntered || !b.mounts) {
    if (!b.reason) return null;
    return { text: `TreeMap could not read the list of mounted drives (${b.reason}), so a drive mounted inside this folder may have been counted as part of it.`, settings: false };
  }
  const plural = (n, one, many) => (n === 1 ? one : many);
  /** Up to five names, then how many more. */
  const names = (list, total) => {
    const shown = list.slice(0, 5).map((m) => lastPathSegment(m.path));
    const more = total - shown.length;
    return shown.join(', ') + (more > 0 ? ` and ${formatCount(more)} more` : '');
  };
  if (b.rule === 'cross') {
    const n = b.entered ? b.entered.count : 0;
    if (!n) return null;
    const shown = b.entered.examples.map((p) => ({ path: p }));
    return {
      text: `This scan includes ${formatCount(n)} drive${plural(n, '', 's')} mounted inside it — ${names(shown, n)}. ` +
        plural(n, 'Its files are counted, though it is not on this disk.', 'Their files are counted, though they are not on this disk.'),
      settings: true,
    };
  }
  const n = b.notEntered.count;
  if (!n) return null;
  // A nullfs or bind mount shows a folder a second time: it is no disk of its own.
  const VIEWS = ['nullfs', 'bindfs', 'fuse.bindfs'];
  const listed = b.mounts.filter((m) => m.reached && !m.entered);
  const views = listed.filter((m) => VIEWS.includes(m.filesystem));
  const disks = listed.filter((m) => !VIEWS.includes(m.filesystem));
  const diskCount = n - views.length; // past the fifty the answer lists, a drive is read as a disk
  // Already counted only when the scan listed what the view shows again: the
  // server says so (`sourceListed`), since a folder under /Volumes or on a
  // drive not entered is inside the root and was still never counted.
  const counted = views.every((m) => m.sourceListed === true);
  if (diskCount > 0) {
    let text = `${formatCount(diskCount)} drive${plural(diskCount, '', 's')} mounted inside this folder ${plural(diskCount, 'was', 'were')} not scanned — ${names(disks, diskCount)}. ` +
      `${plural(diskCount, 'It is a separate disk, so its files are', 'They are separate disks, so their files are')} not part of this disk’s total.`;
    if (views.length) {
      const what = counted ? plural(views.length, 'a folder already counted', 'folders already counted') : plural(views.length, 'another folder', 'other folders');
      text += ` Also not scanned: ${names(views, views.length)}, ${plural(views.length, 'a second view', 'second views')} of ${what}.`;
    }
    return { text, settings: true };
  }
  return {
    text: `${formatCount(n)} drive${plural(n, '', 's')} mounted inside this folder ${plural(n, 'was', 'were')} not scanned — ${names(views, n)}. ` +
      `${plural(n, 'It is', 'Each is')} a second view of ${counted ? 'a folder already counted' : 'another folder'}, so ${plural(n, 'it was', 'they were')} not counted ${counted ? 'again' : 'here'}.`,
    settings: true,
  };
}

/** Paint (or hide) the note for a /boundary answer. Text only: a drive may be named like markup. */
function renderMountsNote(b) {
  const row = $('mountsNote');
  if (!row) return;
  const note = mountsNoteText(b);
  // The note comes on screen with its words already in it, which a screen
  // reader seldom announces: they are said in #mountsNoteSaid a frame later,
  // and taken back as it goes (BQS). Guarded: a page reader may lift this
  // function without sayAloud.
  if (typeof sayAloud === 'function') sayAloud('mountsNoteSaid', note ? note.text : '');
  if (!note) {
    row.hidden = true;
    return;
  }
  $('mountsNoteText').textContent = note.text;
  $('mountsNoteSettingsBtn').hidden = !note.settings;
  row.hidden = false;
}

/** The scan the note shows, or is asking about: TOPIC.scan fires again after the refused-folder probe, and one question is enough. */
let mountsNoteScanId = null;
async function loadBoundary(scanId) {
  if (scanId === mountsNoteScanId) return;
  mountsNoteScanId = scanId;
  let b = null;
  try {
    b = await api(`/api/scan/${encodeURIComponent(scanId)}/boundary`);
  } catch {
    b = null; // an older server, or no answer: say nothing rather than guess
  }
  if (scanId !== state.scanId) return; // a newer scan owns the Dashboard now
  renderMountsNote(b);
}

subscribe(TOPIC.scan, (scanId) => {
  if (!scanId) {
    mountsNoteScanId = null;
    renderMountsNote(null);
    return;
  }
  void loadBoundary(scanId);
});
$('mountsNoteSettingsBtn').addEventListener('click', () => cmdkOpenSettingsSection('Drives mounted inside a folder'));
/* ── end drives mounted inside ── */
/* ── Full Disk Access recheck ── */
/* Track U, U-11. After "Open Privacy settings" the person is in System
   Settings. The next time this window has focus, the server is asked
   whether Full Disk Access is on now, and the refused row is repainted from
   its answer. TOPIC.capabilities is NOT emitted: its listeners (held-up
   space runs lsof and ps, the disk layout card asks diskutil) would redo
   their own work for an answer that concerns this row alone.
   What spends the ask is an answer that access is on (review F2.5). A failed
   ask — the server restarting, as the web-mode sentence tells the person to
   do — and an answer that it is still off (asked before the switch, or
   before the restart that makes it count) leave it armed for the next focus.
   One ask is out at a time, and after ACCESS_RECHECK_ANSWERS answers that it
   is still off it stops asking until the button is used again: each ask
   re-runs every capability probe on the server. */
let accessRecheckArmed = false;
let accessRecheckAsking = false;
let accessRecheckAnswers = 0;
/** The peek before anything was switched on, the return after the switch, the return after a restart. */
const ACCESS_RECHECK_ANSWERS = 3;
/** The button was used: the next focus asks. */
function armFullDiskAccessRecheck() {
  accessRecheckArmed = true;
  accessRecheckAnswers = 0;
}
async function recheckFullDiskAccess() {
  if (!accessRecheckArmed || accessRecheckAsking) return; // focus and visibilitychange arrive together
  accessRecheckAsking = true;
  let res = null;
  try {
    res = await api('/api/platform/capabilities/refresh', { method: 'POST' });
  } catch {
    res = null; // no answer: the row stays as it was, and the next focus asks again
  } finally {
    accessRecheckAsking = false;
  }
  if (!res) return;
  const fda = res.capabilities ? res.capabilities.fullDiskAccess : null;
  if ((fda && fda.state === 'granted') || ++accessRecheckAnswers >= ACCESS_RECHECK_ANSWERS) accessRecheckArmed = false;
  if (!fda || typeof fda.state !== 'string') return;
  // The row says "on now" by the state its scan started under, which that
  // scan's own start keeps (review F3.1). Only a scan this page did not
  // start has none — one reopened after a reload — and the answer the page
  // held until now stands for it: read here, after the ask, since a scan
  // begun while it was out has kept its own. "Off" only when the page was
  // told so: a missing or "unknown" answer is not one (review F2.2).
  if (state.scanAccessState === undefined) {
    const held = fullDiskAccessInfo();
    state.scanAccessState = held ? held.state : null;
  }
  state.capabilities = { ...(state.capabilities || {}), fullDiskAccess: fda };
  renderRefusedFolders();
}
window.addEventListener('focus', () => { void recheckFullDiskAccess(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void recheckFullDiskAccess();
});
/* ── end Full Disk Access recheck ── */
/**
 * "Open Privacy settings": the desktop shell opens the Full Disk Access pane
 * when asked for it BY NAME. The page holds no settings URL, and the shell's
 * window.open guard refuses x-apple URLs (Track U, U-3; the window.open this
 * replaced was dropped by that guard, so the button did nothing). Wherever
 * the pane did not open — a browser tab, an answer of opened: false, a
 * failed call — the path is said in words instead.
 */
async function openFullDiskAccessSettings() {
  const bridge = window.treemapDesktop;
  if (bridge && typeof bridge.openPrivacySettings === 'function') {
    try {
      const answer = await bridge.openPrivacySettings('full-disk-access');
      if (answer && answer.opened === true) return;
    } catch {
      // The call failed: nothing opened, so the words below are the answer.
    }
  }
  // The server's sentence names whom to switch on and what to restart (U-11);
  // without one, the path alone, naming no one.
  const fda = fullDiskAccessInfo();
  toast(fda && fda.state !== 'granted' && fda.advice
    ? 'System Settings did not open from here. ' + fda.advice
    : 'Open System Settings › Privacy & Security › Full Disk Access to switch it on, then scan again.', 'success', 9000);
}
$('accessOpenBtn').addEventListener('click', () => {
  armFullDiskAccessRecheck(); // the next focus asks whether it is on now
  void openFullDiskAccessSettings();
});
$('accessMissingBtn').addEventListener('click', () => switchView('missing'));
$('accessListBtn').addEventListener('click', () => void openRefusedList());

/* ── Scan queue ── */
/* Several folders can arrive at once — a stack dropped from Finder, or the
   dock and the CLI handing paths over while a scan runs. One scan at a time
   is the rule (the chrome, the stream and the watchdog are singular), so the
   rest wait their turn in order and are told so; the old drop handler read
   the first file and silently ignored the others. Draining waits a tick so
   the finishing scan's own repaint completes before the next one begins. */
const scanQueue = [];
/**
 * Scan `p` now, or after the folders already waiting. The Scan card's box
 * names the folder that starts now — never one that waits, which would leave
 * the box naming another folder than the one being scanned (drainScanQueue
 * names each as its turn comes). Only the first folder waiting scans next:
 * "it scans next" said of every one was false of all but that one (hunt C19).
 */
function queueScan(p) {
  if (!p) return;
  if (!state.scanning) { $('pathInput').value = p; void startScan(p); return; }
  if (scanQueue.includes(p)) return;
  scanQueue.push(p);
  const before = scanQueue.length - 1;
  toast(before === 0 ? `Queued ${p} — it scans next` : `Queued ${p} — ${before} folder${before === 1 ? '' : 's'} before it`, 'success', 5000);
}
function drainScanQueue() {
  if (state.scanning || !scanQueue.length) return;
  const next = scanQueue.shift();
  $('pathInput').value = next;
  void startScan(next);
}
/** Empty the queue (a Stop); answers how many folders were waiting, which the Stop says will not be scanned (hunt C19). */
function clearScanQueue() { const n = scanQueue.length; scanQueue.length = 0; return n; }
subscribe(TOPIC.scan, (scanId) => { if (scanId) setTimeout(drainScanQueue, 0); });
/* ── end scan queue ── */

/* ── The desktop shell's side of a scan (hunt C01) ──
   In the desktop app the shell (electron/preload.js) runs the dock or taskbar
   progress bar, the bounce and notice for a scan that ends while TreeMap is in
   the background, and its own queue of the folders it is handed — the File
   menu, the tray, a dock drop, "Scan with TreeMap" — which it gives the page
   one at a time, the next only once the page says the last scan ended. The
   page says so here: a real scan starting (beginScanChrome), and every way
   one ends — finished (finishScan), failed (failScan), its quiet refresh
   failed (quietRescanFailed) or stopped (stopScan). A paint from the saved
   index and a reopened scan are no scan of their own and say nothing. Never
   said, the shell's queue waited for ever: every folder it was handed after
   the first was dropped without a word until the app was relaunched. A
   browser tab has no bridge, and nothing is said. The shell's answer is
   handed back (scanFinished's: how many folders a Stop dropped, review
   F1.1); one that fails is no answer, never an unhandled rejection. */
function tellDesktop(method, arg) {
  const bridge = typeof window === 'undefined' || !window ? null : window.treemapDesktop;
  if (!bridge || typeof bridge[method] !== 'function') return undefined;
  const answer = bridge[method](arg);
  return answer && typeof answer.then === 'function' ? answer.then((v) => v, () => null) : answer;
}

/* ── Results expire ──
   Scan results are kept for a limited time after they settle; the server
   says how long in `stats.expiresAt`. Every later action would fail with an
   "unknown or expired scanId" — an error about an identifier the user never
   saw, under a map that still looks perfectly alive. Two answers: a warning
   two minutes before, and, once it has happened, a sentence that says what
   it means with a Scan again beside it. Older servers send no expiresAt and
   get the second answer only. */
/* The timer handle and the Scan again offer made for an expired scan
   (`expiredOffer`) live on `state`, not in module scope: they are per-scan
   facts — the timer is re-armed as each scan lands, and the offer names the
   scan it was made for, so another scan's expiry is offered anew — and it
   keeps each function readable on its own, which is also how the tests
   exercise them. */
function armScanExpiry() {
  clearTimeout(state.scanExpiryTimer);
  state.scanExpiryTimer = 0;
  if (!state.scanId) return;
  const scanId = state.scanId;
  // When the results leave the server's memory, as far as the page can tell:
  // the landed stats' `expiresAt`, pushed on by every read of the scan since
  // (hunt C17). The server keeps a settled scan 30 minutes after it was last
  // read ("Every read of the scan pushes it out by 30 minutes", GET
  // /api/openapi.json), and stamps a read at most once a minute, so a read
  // the page made counts from a minute before it. A timer fixed when the scan
  // landed told someone still using the results that they were about to
  // expire, when they were not. 0: the server said nothing (an older server).
  const expiresAt = () => {
    const at = Number((state.scanStats || {}).expiresAt);
    if (!Number.isFinite(at) || at <= 0) return 0;
    const used = state.scanUsed && state.scanUsed.scanId === scanId ? state.scanUsed.at - 60_000 + 30 * 60_000 : 0;
    return Math.max(at, used);
  };
  const at = expiresAt();
  if (!at) return;
  const warnIn = Math.max(0, at - Date.now() - 2 * 60_000);
  state.scanExpiryTimer = setTimeout(() => {
    if (scanId !== state.scanId || state.scanning) return;
    const left = expiresAt() - Date.now();
    // Read since this was armed: the warning moves with it.
    if (left > 2 * 60_000) { armScanExpiry(); return; }
    // Gone already, by all the page knows — an older tree put back by a Stop,
    // not read since: no "about 1 minute" for it. A later read says what
    // happened (scanResultsExpired), and a read that answers arms this again.
    if (left <= 0) return;
    const mins = Math.max(1, Math.round(left / 60_000));
    toastAction(`These results expire in about ${mins} minute${mins === 1 ? '' : 's'} — scan again to keep them fresh.`,
      'Scan again', () => rescan(), 'success', 20000);
  }, warnIn);
}

/**
 * A request the server answered (api()) that named the scan on hand — in its
 * URL, or as `scanId` in its JSON body — read that scan, and pushed its
 * expiry on (hunt C17): noted, and the warning armed from it again, at most
 * once a minute (the server's own grain).
 */
function noteScanUsed(url, body) {
  const scanId = state.scanId;
  if (!scanId) return;
  let named = null;
  if (typeof body === 'string' && body.includes(scanId)) { try { named = JSON.parse(body).scanId; } catch { /* not JSON: it names no scan */ } }
  if (!(String(url).includes(scanId) || named === scanId)) return;
  const prev = state.scanUsed;
  const now = Date.now();
  state.scanUsed = { scanId, at: now };
  if (!prev || prev.scanId !== scanId || now - prev.at >= 60_000) armScanExpiry();
}
subscribe(TOPIC.scan, (scanId) => { if (scanId) armScanExpiry(); });

function scanResultsExpired(err, url, body) {
  // The results of the tree on screen (treeScanId): during a rescan the
  // older scan's, which every view asks, and which can expire while the
  // rescan runs — said then as the raw "Unknown or expired scanId" (review F2.13).
  const scanId = treeScanId();
  // A request names its scan in its URL, or — a POST: the highlight box's
  // query, opening an archive, a fact — as `scanId` in its JSON body. Judged
  // by the URL alone, those kept the raw words, at rest too (review F3.2).
  let named = null;
  if (typeof body === 'string') { try { named = JSON.parse(body).scanId; } catch { /* not JSON: it names no scan */ } }
  if (!state.root || !scanId || !(String(url).includes(scanId) || named === scanId)) return;
  // An answer, not a failure: whoever prints it says the sentence alone (reportError), and says nothing
  // more where the sentence was offered with its Scan again (`offered`) — the map said it again as
  // "Treemap failed: These results have expired…" (eighth browser pass K05).
  err.resultsExpired = true;
  if (state.scanning) {
    // A scan is under way: Scan again is not offered over it.
    err.message = 'These results have expired — the scan under way replaces them when it finishes.';
    return;
  }
  err.message = 'These results have expired — scan the folder again to refresh them.';
  // One Scan again offer per expired scan, however many calls fail under it. While it is on screen it says
  // the sentence, so whoever prints the error says nothing more (`offered`); once it has gone — timed out,
  // dismissed or chosen — a later failure is said by its caller, plainly. Marked offered for good, a click
  // on the map, or Clean Up's Find, after the offer had gone did nothing, with no word said (review F1.1, F1.6).
  const offer = state.expiredOffer;
  if (offer && offer.scanId === scanId) {
    if (offer.isOpen()) err.offered = true;
    return;
  }
  const p = state.root.path;
  const shown = toastAction(err.message, 'Scan again', () => { void startScan(p); }, 'error', 15000);
  state.expiredOffer = { scanId, isOpen: () => Boolean(shown && shown.isOpen()) };
  err.offered = true;
}
/* ── end results expire ── */

$('scanBtn').addEventListener('click', () => {
  if (state.scanning) { void stopScan(); return; } // the same button is Stop mid-scan
  return scanTheBox();
});
/** Scan the folder the Scan card's box names, exactly as it is (asPath): a
    trailing space is part of a name — the picker, Recent and the last scan fill
    this box as the server spells a folder (review F2.4, F2.8). A path that
    names no folder where the same path without its trailing space does is not
    scanned in its place: "no such folder", with that folder offered, and a
    click on it scans it — with Fast rescan then offered for it where it was
    scanned before, since that box is read the same way (QA4a R4-1, R4-2), and
    never ticked for the person, so that click scans it in full (QA D45). */
let scanPressSeq = 0; // each press of Scan takes the next number (scanTheBox)
async function scanTheBox() {
  const box = $('pathInput');
  const btn = $('scanBtn');
  // Only the folder offered can be chosen mid-scan (the button is Stop then):
  // said, as startScan says it, rather than nothing at all.
  if (state.scanning) { toast('A scan is already running', 'error'); return; }
  const p = asPath(box.value);
  if (!p) { toast('Enter a folder path first', 'error'); return; }
  // Read as the person pressed Scan; only the path is looked up after, held
  // to PATH_LOOKUP_MS, with the button held while it is (QA4a R4-3) — and
  // saying so: "Checking…" on its face, aria-busy, and a sentence in the
  // scan's live region (final review F1.11).
  const incremental = !$('fastRescanWrap').hidden && $('fastRescan').checked;
  const seq = ++scanPressSeq;
  const checking = 'Checking that the folder exists…';
  // Held, the button is disabled, and a browser hands focus from a disabled
  // control to <body> — where it stayed through the scan, its landing and a
  // Stop, and Enter mid-scan reached nothing (eighth browser pass K02). It is
  // given back as the button is, unless the person moved it meanwhile.
  const heldFocus = document.activeElement === btn;
  btn.disabled = true;
  if (boxLooksUp(p)) {
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = icon('search', 16) + 'Checking…';
    $('scanAnnounce').textContent = checking;
  }
  let meant = null;
  try {
    meant = await boxMeant(p);
  } finally {
    // Handed back by the press that holds it, however the lookup ended — a
    // throw included, which left Scan disabled until a reload (final review
    // F1.5). A scan started meanwhile has made it Stop already.
    if (seq === scanPressSeq) {
      btn.removeAttribute('aria-busy');
      if (state.scanning) btn.disabled = false; else setScanButtonMode('scan');
      if (heldFocus && (!document.activeElement || document.activeElement === document.body)) btn.focus({ preventScroll: true });
      // And the check is over: the live region stops saying one is running,
      // however it ended — an offer, a press dropped — unless a scan started
      // meanwhile has said its own sentence there (final review F2.4).
      // What the region says, or holds back while the page comes out from under
      // a sheet (scanVoiceSays, 040); guarded: a page reader may lift this without it.
      const saying = typeof scanVoiceSays === 'function' ? scanVoiceSays($('scanAnnounce')) : $('scanAnnounce').textContent;
      if (saying === checking) $('scanAnnounce').textContent = '';
    }
  }
  // A newer press took over — Enter, or the folder offered, chosen — and
  // answers in this one's place.
  if (seq !== scanPressSeq) return;
  // The person moved on while it was looked up — a scan started some other
  // way, or another path in the box: this press acts on nothing, and says so
  // rather than leaving a press that did nothing (final review F1.5).
  if (state.scanning) { toast('A scan is already running', 'error'); return; }
  if (asPath(box.value) !== p) {
    toast('Nothing was scanned — the path changed while it was being checked. Press Scan to scan the path in the box.', 'error');
    return;
  }
  if (meant) {
    // Chosen while a scan started some other way runs, the box is left as it
    // is — scanTheBox says why — or the next press would scan a folder nobody
    // pressed Scan on (final review F1.12).
    offerMeant(p, meant, () => {
      if (!state.scanning) { box.value = meant; maybeShowFastRescan(); }
      return scanTheBox();
    }, 'Scan that folder');
    return;
  }
  startScan(p, { incremental });
}
// Enter starts a scan and only ever starts one. It used to be free of this
// check because the button was disabled mid-scan; now that the button is Stop,
// an unguarded Enter in the path field would cancel the running scan instead.
//
// Refusing is right. Refusing in SILENCE was not: the app then scanned the
// last path at boot (it no longer does: the owner, 17 Oct 2026), so the very
// first thing a returning user could do was type a different folder and press
// Enter — and for those seconds Enter did nothing
// at all, with no scan and no message. That reads as a broken input, and it
// fooled two people testing this build before it was noticed. The house rule
// is the one at tmRunGrammarQuery: say so rather than doing nothing. The
// button's own behaviour is unchanged; only the refusal gained a voice.
//
// Enter is a press of Scan of its own, not a click() on the button: while
// Scan is held for a lookup a click() on it does nothing, so Enter in the
// box was dropped in silence. Pressed, it takes over from the held press
// and scans what the box holds now (final review F1.11).
$('pathInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !state.scanning) { void scanTheBox(); return; }
  if (e.key === 'Enter') toast('A scan is already running — press Stop to end it, then press Enter to scan this path.', 'error');
});
$('pathInput').addEventListener('input', maybeShowFastRescan);
void refreshFastRescanPlan(); // shows or hides the box once the engine plan is known (QA D45)
window.addEventListener('beforeunload', closeEventSource);

/* ───────────────────────────── Dashboard: largest files ───────────────────────────── */
/* The FxCharts.barList row recipe, applied to rows barList itself cannot own:
   these carry cart/trash/reveal controls, reclaim badges and context menus,
   so the markup stays here and only the bar (gradient fill on the blue ramp,
   REDUCED-aware width-in) and the percent-of-largest column move in. */
function fxBarStyle(rank) {
  const colors = FxCharts.ramp(4);
  const col = colors[Math.min(rank, colors.length - 1)];
  const rgb = FxCharts.math.hexRgb(col);
  return `background:linear-gradient(90deg, ${col}, rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.35));`;
}
function fxBarsIn(host) {
  host.querySelectorAll('.fx-bar-fill[data-w]').forEach((el) => {
    const w = el.dataset.w + '%';
    if (REDUCED) { el.style.width = w; return; }
    // Two frames from 0: the width transition needs a painted starting state.
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.width = w; }));
  });
}
function renderBigFiles() {
  const host = $('bigFiles');
  if (!state.largest.length) { host.innerHTML = '<div class="muted">No files found.</div>'; return; }
  // The bar is always scaled against the biggest file, whichever order the
  // rows are in: a bar that rescaled itself to the top row would make the
  // reclaim ordering look like a size ordering.
  const max = state.largest.reduce((m, f) => Math.max(m, f.size), 1);
  const rows = state.bigFilesSort === 'reclaim'
    ? [...state.largest].sort(byReclaimDesc((f) => f.path))
    : state.largest;
  // ONE measure column per row: the score, once there is one, takes the
  // percent-of-largest's place. Added beside it, the badge squeezed the name
  // column to 66 px and six of ten rows read "dup-gro…" (QA B03); the bar and
  // the size badge still say how big each file is.
  host.innerHTML = rows.map((f, i) => `
    <div class="bigfile">
      ${chipFor(f)}
      <div class="meta">
        <div class="nm" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
        <div class="pth" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</div>
      </div>
      <div class="bar-track"><div class="fx-bar-fill" data-w="${Math.max(4, (f.size / max) * 100).toFixed(1)}" style="${fxBarStyle(i)}"></div></div>
      ${reclaimBadge(f.path, scoreFor(f.path)) || (state.bigFilesSort === 'reclaim' && scoreKnown(f.path) ? '<span class="rc-none" title="None of the six signals could be read for this file">not scored</span>' : `<span class="fx-li-pct num">${Math.round((f.size / max) * 100)}%</span>`)}
      <span class="size-badge num" style="color:${sizeInk(f.size)};">${formatBytes(f.size)}</span>
      <span class="actions">
        ${cartButtonHtml(f.path, f.name, 14)}
        <button class="icon-btn" data-reveal="${escapeHtml(f.path)}" title="Reveal in file manager" aria-label="Reveal ${escapeHtml(f.name)}">${icon('external', 14)}</button>
        <button class="icon-btn danger" data-trash="${escapeHtml(f.path)}" title="Move to Trash" aria-label="Move ${escapeHtml(f.name)} to Trash">${icon('trash', 14)}</button>
      </span>
    </div>`).join('');
  fxBarsIn(host);
  host.querySelectorAll('[data-trash]').forEach(btn =>
    btn.addEventListener('click', () => confirmTrash([btn.dataset.trash])));
  host.querySelectorAll('[data-reveal]').forEach(btn =>
    btn.addEventListener('click', () => openInOS(btn.dataset.reveal, true)));
  host.querySelectorAll('.bigfile').forEach((row, i) => {
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // `rows`, not `state.largest`: under the Reclaim sort the two differ,
      // and indexing the wrong one opens the context menu for a file the
      // user did not right-click.
      const f = rows[i];
      if (!f) return;
      showCtxMenu(e.clientX, e.clientY, nodeFor(f.path) || { ...f, type: 'file' });
    });
  });
  refreshCartButtons();
}

/**
 * The Size / Reclaim toggle on the Largest Files card.
 *
 * Scores are fetched for the ten rows only, and only once the user asks for
 * that order — the dashboard's first paint must not wait on six signals per
 * file for a list most people read by size. The rows repaint when the scores
 * land, so the toggle itself is instant.
 */
function refreshBigFiles() {
  renderBigFiles();
  if (state.bigFilesSort === 'reclaim' && state.largest.length) {
    void ensureScores(state.largest.map((f) => f.path), renderBigFiles);
  }
}
function setBigFilesSort(mode) {
  state.bigFilesSort = mode === 'reclaim' ? 'reclaim' : 'size';
  localStorage.setItem('tm-bigfiles-sort', state.bigFilesSort);
  for (const b of $('bigFilesSort').querySelectorAll('button'))
    b.setAttribute('aria-selected', String(b.dataset.sort === state.bigFilesSort));
  refreshBigFiles();
}
$('bigFilesSort').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-sort]');
  if (btn) setBigFilesSort(btn.dataset.sort);
});
setBigFilesSort(state.bigFilesSort); // reflect the persisted choice on load

/* ───────────────────────────── Dashboard: largest folders ───────────────────────────── */
/** The rows the card shows. */
const BIG_FOLDERS_ROWS = 10;
/** A folder holding this share or more of a listed folder it lies in is that place again. */
const BIG_FOLDER_FOLD_SHARE = 0.95;

/**
 * The card's rows, each a distinct place on the disk (design pass G15).
 *
 * A folder with one child holds what the child holds, so the API's biggest
 * folders list the same space over and over: on /Applications, IntelliJ
 * IDEA.app, its Contents and its plugins at about 4.5 GB each, then Chrome's
 * .app, Contents, Frameworks, Framework.framework and Versions at 1.5 GB —
 * ten rows, three apps. A folder that lies inside a row and holds 95% or more
 * of it is folded into that row, which keeps the outer name, the one a person
 * knows (the .app); the list fills on with the next folders. A folder that is
 * a real part of a row (Xcode's Developer, two thirds of it) keeps its own.
 *
 * Outer first among equal sizes: the API lists a one-child folder ahead of its
 * parent when they tie, as its walk finishes the child first. Only the page
 * folds: /api/large-folders and its order are what agents read.
 */
function bigFolderRows(folders) {
  const bySize = folders.slice().sort((a, b) => b.size - a.size || a.path.length - b.path.length);
  const rows = [];
  for (const f of bySize) {
    const holder = rows.find((r) => tmIsInside(f.path, r.path) && f.size >= r.size * BIG_FOLDER_FOLD_SHARE);
    if (holder) holder.folded.push(f);
    else if (rows.length < BIG_FOLDERS_ROWS) rows.push({ ...f, folded: [] });
  }
  return rows;
}

function renderBigFolders() {
  const host = $('bigFolders');
  const folders = bigFolderRows(state.bigFolders || []);
  if (!folders.length) { host.innerHTML = '<div class="muted">No folders above 1 MB found.</div>'; return; }
  const max = folders[0].size || 1;
  // What a row folded in, said once in words and in full in its tooltip —
  // and in the row's accessible name, so keyboard, touch and screen-reader
  // users get it too; the note wraps rather than being cut to one line
  // (sixth browser pass H55). Plain text here, escaped once where written.
  const foldWords = (f) => {
    if (!f.folded.length) return '';
    const names = f.folded.map((x) => x.name);
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return `${list} inside it, which ${names.length === 1 ? 'holds' : 'each hold'} nearly all of its size`;
  };
  const foldNote = (f) => {
    if (!f.folded.length) return '';
    const title = 'Inside it, not listed again:\n' + f.folded.map((x) => x.path + ' — ' + formatBytes(x.size)).join('\n');
    return `<div class="bf-fold" title="${escapeHtml(title)}">Also covers ${escapeHtml(foldWords(f))}</div>`;
  };
  // The bars and the figures compare the rows shown: a share of the largest.
  const pct = (f) => Math.round((f.size / max) * 100);
  const files = (f) => `${formatCount(f.fileCount)} file${f.fileCount === 1 ? '' : 's'}`;
  // A row's aria-label replaces everything in it, so it says each figure the
  // row shows, as the row shows it — size, file count and share of the
  // largest — then what it does (seventh browser pass J55).
  const rowName = (f) => `${f.name}, ${formatBytes(f.size)}, ${files(f)}, ${pct(f)}% of the largest folder listed — open it in the treemap` +
    (f.folded.length ? `. It also covers ${foldWords(f)}.` : '');
  host.innerHTML = folders.map((f, i) => `
    <div class="bigfile" data-jump="${escapeHtml(f.path)}" style="cursor:var(--cur-hand);" role="button" tabindex="0"
         aria-label="${escapeHtml(rowName(f))}">
      ${chipFor({ type: 'dir' })}
      <div class="meta">
        <div class="nm" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
        <div class="pth" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</div>
        ${foldNote(f)}
      </div>
      <span class="cnt muted num" style="white-space:nowrap;">${files(f)}</span>
      <div class="bar-track"><div class="fx-bar-fill" data-w="${Math.max(4, (f.size / max) * 100).toFixed(1)}" style="${fxBarStyle(i)}"></div></div>
      <span class="fx-li-pct num" title="${pct(f)}% of the size of the largest folder listed">${pct(f)}%</span>
      <span class="size-badge num" style="color:${sizeInk(f.size)};">${formatBytes(f.size)}</span>
    </div>`).join('');
  fxBarsIn(host);
  host.querySelectorAll('[data-jump]').forEach(row => {
    const jump = () => {
      state.treemap.rootPath = row.dataset.jump;
      switchView('treemap');
    };
    row.addEventListener('click', jump);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(); } });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = row.dataset.jump;
      const node = state.pathIndex.get(p) ||
        { path: p, name: p.split(/[\\/]/).pop() || p, type: 'dir', modifiedAt: 0 };
      showCtxMenu(e.clientX, e.clientY, node);
    });
  });
}

/* ───────────────────────────── Dashboard: donut chart ─────────────────────────────
   FxCharts.rings owns the whole card now: entrance sweep (REDUCED-checked),
   annulus hit-testing, legend↔ring hover sync, and the thin center numeral.
   The handle is kept so a rescan updates in place; only the empty state and
   the theme repaint are decided here. */
let donutHandle = null;
/**
 * Take the ring and its centre total off the card. The kit's destroy empties
 * the legend but leaves the canvas as it was painted, so the last breakdown's
 * "8.8 GB All types" stood on beside skeletons or another folder's lists
 * (B05, B08) unless the canvas is cleared too.
 */
function clearDonut() {
  if (donutHandle) { donutHandle.destroy(); donutHandle = null; }
  const { ctx } = Canvas2D.setup($('donutCanvas'), 230, 230);
  ctx.clearRect(0, 0, 230, 230);
}
function renderDonut() {
  fxDonutLoadingSync(false); // every paint of the card settles the veil
  const legend = $('donutLegend');
  // The kit draws at most 8 slices and computes every percentage against the
  // items it is handed, so handing it only the 8 biggest made each legend
  // percentage a share of those 8 rather than of the scan — ".zip 30.1%" for
  // an extension that is 28.2% of what was scanned. Seven named types plus
  // one tail slice keeps the ring a real part-to-whole, and names how many
  // extensions the tail stands for rather than leaving them unaccounted.
  const RING_SLICES = 8;
  const all = state.types;
  const named = all.length > RING_SLICES ? all.slice(0, RING_SLICES - 1) : all;
  const rest = all.slice(named.length);
  const top = named;
  if (!top.length) {
    if (donutHandle) { donutHandle.destroy(); donutHandle = null; }
    const { ctx } = Canvas2D.setup($('donutCanvas'), 230, 230);
    ctx.clearRect(0, 0, 230, 230);
    legend.classList.remove('fx-legend');
    legend.innerHTML = '<div class="muted">Run a scan to see the breakdown.</div>';
    return;
  }
  legend.classList.add('fx-legend');
  const spec = {
    // count rides along: the baseline legend answered "how many files is
    // that?" per type, and the rings kit renders it when it is provided.
    items: [
      ...top.map(t => ({ name: t.ext === '(none)' ? 'no ext' : '.' + t.ext, value: t.totalSize, count: t.count })),
      // "Other", not "873 more": the legend's name column ellipsizes, and the
      // one name made of a number lost the number ("873 …", QA D24). How many
      // extensions the tail stands for stays said, in the row's tooltip.
      ...(rest.length ? [{
        name: 'Other',
        title: `${formatCount(rest.length)} more extension${rest.length === 1 ? '' : 's'}`,
        value: rest.reduce((a, t) => a + t.totalSize, 0),
        count: rest.reduce((a, t) => a + t.count, 0),
      }] : []),
    ],
    centerLabel: 'All types',
  };
  if (donutHandle) donutHandle.update(spec);
  else donutHandle = FxCharts.rings($('donutCanvas'), legend, spec);
}

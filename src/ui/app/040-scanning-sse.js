/* ───────────────────────────── Scanning + SSE ───────────────────────────── */
function closeEventSource() {
  if (state.es) { state.es.close(); state.es = null; }
}

/**
 * The primary scan control is one button in two modes: Scan, and Stop while a
 * scan is running. One button rather than two because the two actions are
 * never both available, and a permanently-greyed Stop is the thing that made
 * a long scan feel like it had taken the app hostage.
 *
 * The label must be rebuilt with icon() rather than a [data-icon] span: the
 * injector runs once at boot and replaces those placeholders outright, so a
 * span written here would stay permanently empty.
 */
function setScanButtonMode(mode) {
  const btn = $('scanBtn');
  const stop = mode === 'stop';
  btn.disabled = false; // a disabled Stop cannot be clicked — .btn:disabled kills pointer events
  btn.classList.toggle('btn-primary', !stop);
  btn.classList.toggle('btn-danger', stop);
  btn.innerHTML = icon(stop ? 'stop' : 'play', 16) + (stop ? 'Stop' : 'Scan');
  btn.setAttribute('aria-label', stop ? 'Stop the running scan' : 'Scan the folder');
}

/**
 * Undo beginScanChrome's skeletons for a scan that will never fill them.
 *
 * The dashboard's mount() is deliberately a no-op — it is painted by
 * finishScan — so switchView cannot repaint these three panels. Without this,
 * a scan that stops or fails after a successful one leaves the dashboard
 * showing skeleton rows forever, on top of data the app still holds.
 */
function restoreDashboardPanels() {
  if (state.largest.length) renderBigFiles();
  else $('bigFiles').innerHTML = '<div class="muted">Run a scan to find your biggest files.</div>';
  if (state.bigFolders.length) renderBigFolders();
  else $('bigFolders').innerHTML = '<div class="muted">Run a scan to find your biggest folders.</div>';
  if (state.types.length) { state.donut.animated = false; renderDonut(); }
  else { $('donutLegend').innerHTML = '<div class="muted">Run a scan to see the breakdown.</div>'; fxDonutLoadingSync(false); }
}

/**
 * The three dashboard lists, shown as loading rather than as empty.
 *
 * Used when a tree has been painted from the index but no scan has granted an
 * id yet: the lists are genuinely on their way, so "No files found." would be
 * a lie about a folder that plainly has files.
 */
function showListsPending() {
  $('bigFiles').innerHTML = skeletonRows(6);
  $('bigFolders').innerHTML = skeletonRows(6);
  $('donutLegend').innerHTML = skeletonRows(5, 24);
  fxDonutLoadingSync(true);
}

/** Ask the server to stop one scan. Split out because Stop can be pressed
 *  before the scan request has answered, and that scanId still has to be
 *  cancelled — by whichever entry point is the only code that ever sees it. */
function cancelScanById(scanId) {
  return api(`/api/scan/${scanId}/cancel`, { method: 'POST' });
}

/**
 * True when a scan request that has just answered must be abandoned instead of
 * followed, because it is no longer the scan the app is running.
 *
 * There is no scanId until the request answers, so a Stop pressed before then
 * can only stop the chrome — the walk is running with nothing watching it.
 * Opening a stream now would be worse than leaking it: followScanProgress
 * would repoint state.scanId and finishScan would eventually resurrect a scan
 * the user already ended, on top of a UI that says it stopped.
 *
 * The generation check is what makes this correct rather than merely usually
 * right. `state.scanning` describes whichever scan is running NOW, not the one
 * that is asking — so after Stop-then-Scan-again, the first request's reply
 * would see scanning=true and be followed, leaving two live streams, a
 * state.scanId belonging to the abandoned scan, and an uncancelled walk.
 *
 * Shared by both entry points on purpose: startScanRequest and startCloudScan
 * have the same await-then-follow shape, and the disk path having this guard
 * while the cloud path silently did not is exactly the asymmetry it prevents.
 */
function abandonIfStopped(scanId, gen) {
  if (state.scanning && state.scanGen === gen) return false;
  void cancelScanById(scanId).catch((e) => console.warn('[treemap] late cancel failed:', e));
  return true;
}

/**
 * Stop the running scan, from the user's side first.
 *
 * The stream and watchdog are settled before the request goes out, so nothing
 * that is already in flight can repaint the status afterwards — the server's
 * own 'error' frame and the watchdog's 500 both describe the cancellation we
 * just asked for, and either one landing later would read as a failure the
 * user did not cause. The request is still awaited so a genuinely failed
 * cancel is reported rather than assumed.
 */
async function stopScan() {
  if (!state.scanning) return;
  // `state.scanId` is only ever assigned by followScanProgress, and a quiet
  // background refresh leaves the PREVIOUS scan's id sitting there until the
  // new one arrives — so it alone cannot say which scan to cancel. abortScan
  // is set in the same breath as the new id, which makes it the honest test
  // for "this scan has a stream, and state.scanId is its id". If it is null we
  // are still inside POST /api/scan; startScanRequest cancels that one.
  const scanId = state.abortScan ? state.scanId : null;
  if (state.abortScan) state.abortScan();
  closeEventSource();
  endScanChrome();
  clearScanQueue(); // a Stop means stop — folders waiting behind this one are not started
  // Every scanId-keyed endpoint answers a cancelled scan with
  // 500 SCAN_FAILED "Scan stopped by user". Leaving the id in state and then
  // remounting the views below turns one deliberate Stop into a wall of red
  // toasts reporting the user's own choice back to them as a failure.
  //
  // What replaces it is the id of the scan the tree on screen actually came
  // from: stopping a rescan should leave the previous results working, not
  // strand a real tree with no scan behind it. Null when there is no such
  // scan — a first run, or a tree the index painted — and then the views take
  // their existing "no scan yet" branch, which openFromIndex relies on too.
  state.scanId = state.settledScanId || null;

  const status = $('scanStatus');
  status.classList.remove('error'); // stopping is a choice, not a failure
  status.innerHTML = icon('stop', 14) + '<span>Scan stopped by user</span>';
  restoreDashboardPanels();
  switchView(state.view); // and put the never-scanned empty state back if that is where we are

  if (!scanId) return; // stopped before POST /api/scan answered — startScanRequest handles it
  try {
    await cancelScanById(scanId);
  } catch (e) {
    // The walk is still running server-side, and saying "stopped" would be a
    // lie. 404 is not one of these: the record was already gone, so it is.
    if (e.status !== 404) {
      status.classList.add('error');
      status.innerHTML = icon('alert', 14) + '<span>' + escapeHtml('Could not stop the scan: ' + e.message) + '</span>';
    }
  }
}
function skeletonRows(n, h = 38, label = '') {
  const rows = Array.from({ length: n }, () => `<div class="skeleton" style="height:${h}px;margin:8px 0;"></div>`).join('');
  // A labelled skeleton keeps the §3.5 loading copy for screen readers —
  // the rows are decoration, the sentence is the state.
  return label ? `<div role="status" aria-label="${escapeHtml(label)}">${rows}</div>` : rows;
}

/**
 * How much tree the instant open asks the index for.
 *
 * This paint is a PREVIEW: the background scan replaces it seconds later with
 * its own pruned tree and a real scanId. Sizing it like the scan's 250,000 was
 * costing 89.7 MB of JSON and ~2.1s of blocked server on a 1M-node index —
 * on the one path whose entire purpose is to feel instant. 25,000 nodes is
 * 6.2 MB and ~440ms, still covers the whole first screen biggest-first, and
 * root.size stays exact because pruning preserves recursive totals.
 *
 * Nothing is lost: a folder the preview withheld is marked `pruned`, and
 * ensureSubtree now fetches it from the index on demand.
 */
const INSTANT_OPEN_NODES = 25000;
/** Budget for one on-demand drill-in, matching the scan path's subtree cap. */
const SUBTREE_NODES = 20000;

/* Feature 5 — fast (incremental) rescan helpers. */
function scannedRoots() { try { return new Set(JSON.parse(localStorage.getItem('tm-scanned-roots') || '[]')); } catch { return new Set(); } }
function rememberScannedRoot(p) { const s = scannedRoots(); s.add(p); localStorage.setItem('tm-scanned-roots', JSON.stringify([...s].slice(-60))); }
function maybeShowFastRescan() {
  const wrap = $('fastRescanWrap'); if (!wrap) return;
  const p = $('pathInput').value.trim();
  const known = !!p && scannedRoots().has(p);
  wrap.hidden = !known;
  $('fastRescan').checked = known;
}
async function showFastRescanStat(scanId) {
  try {
    const s = await api(`/api/scan/${scanId}/stats`);
    if (s && s.cachedDirs > 0) toast(`Fast rescan — ${formatCount(s.cachedDirs)} folders reused from cache`);
  } catch { /* stats are best-effort */ }
}

/** Shared scanning chrome: spinners, skeletons, dashboard switch. */
/**
 * Put the UI into "scanning" mode.
 *
 * `quiet` is for the A1 background refresh that runs behind an already-painted
 * indexed tree. It still marks the scan as running — the progress watchdog and
 * the double-scan guard both key off `state.scanning`, so skipping that would
 * quietly disable the stall recovery — but it leaves the results on screen
 * instead of replacing them with skeletons. Wiping a perfectly good tree to
 * show a spinner would make the instant open pointless.
 */
function beginScanChrome({ quiet = false, message = '' } = {}) {
  state.scanning = true;
  state.abortScan = null; // no stream yet — Stop before the request answers has no scanId
  state.scanGen++; // this scan's identity while its request is in flight
  // Above the `quiet` branch on purpose: a background refresh of a whole drive
  // is exactly as long as a foreground one, so it gets a Stop too.
  setScanButtonMode('stop');
  $('headerSpin').classList.add('on');
  $('headerSpin').innerHTML = icon('loader', 15, REDUCED ? '' : 'spin');
  $('progressTrack').classList.add('active');
  $('scanStatus').classList.remove('error');
  // FX: the card's traveling beam and the "searching" orb mark the one state
  // this function owns. endScanChrome is the single funnel every scan exit
  // passes through (finish, fail, stop), so activation and deactivation are
  // the same pair of lines in two places. The orb replaces the old loader
  // icon in the status line — one activity indicator, not two. Routed
  // through fxStateBeam: the card is hover-ambience territory, and a real
  // state must own it outright.
  fxStateBeam($('scanStatus').closest('.card'), { type: 'md', active: true });
  fxOrbShow('scan', $('scanOrbWell'), 'searching');
  fxScanHeroSync();
  // FX: the status label shimmers for exactly as long as the scan is
  // genuinely pending — endScanChrome, the single exit funnel, removes it.
  $('scanStatus').classList.add('fx-shimmer-text');
  // Assistive tech hears the scan start here; followScanProgress speaks again
  // every ten seconds, and finishScan / failScan say how it ended. The bar
  // states what it is until the first frame gives it a count.
  $('scanAnnounce').textContent = message || 'Scanning…';
  $('progressTrack').setAttribute('aria-valuetext', 'Scanning');
  tourScanStarted(); // v4 §9.2 — the welcome card follows the user into the scan
  if (quiet) {
    // `message` lets the caller say what is actually happening. A first scan
    // enters here too — startScan shows the chrome before it knows whether the
    // index will paint — and "Checking for changes" would be a lie there.
    $('scanStatus').innerHTML = message
      ? '<span>' + escapeHtml(message) + '</span>'
      : icon('refresh', 14) + '<span>Checking for changes…</span>';
    return;
  }
  $('scanStatus').innerHTML = '<span>Starting scan…</span>';
  $('bigFiles').innerHTML = skeletonRows(6);
  $('bigFolders').innerHTML = skeletonRows(6);
  $('donutLegend').innerHTML = skeletonRows(5, 24);
  fxDonutLoadingSync(true);
  // The last scan's summary is stale the moment a new one starts — hide it and
  // invalidate any in-flight snapshot poll so it can't repaint mid-scan.
  state.whatsNew.seq++;
  $('whatsNewCard').hidden = true;
  $('emptyState').style.display = 'none';
  switchView('dashboard');
}

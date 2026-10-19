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
  // A tree on screen with no scan behind it was painted from the saved index,
  // and the scan that lists it was stopped or failed: there are no lists to
  // give back, and "Run a scan…" describes an app with nothing on screen
  // (B08). Said as what it is, beside the map it describes.
  const fromIndex = !!state.root && !state.settledScanId;
  const empty = (indexed, firstRun) => '<div class="muted">' + (fromIndex ? indexed : firstRun) + '</div>';
  if (state.largest.length) renderBigFiles();
  else $('bigFiles').innerHTML = empty('Opened from the saved index — scan this folder to list its biggest files.', 'Run a scan to find your biggest files.');
  if (state.bigFolders.length) renderBigFolders();
  else $('bigFolders').innerHTML = empty('Opened from the saved index — scan this folder to list its biggest folders.', 'Run a scan to find your biggest folders.');
  if (state.types.length) { state.donut.animated = false; renderDonut(); }
  else {
    // The ring and its centre total are another folder's, or a scan's that
    // never finished: off the card with the legend (B08: "36.0 MB All types"
    // stood beside "Run a scan to see the breakdown.").
    clearDonut();
    $('donutLegend').innerHTML = empty('Opened from the saved index — scan this folder to see its breakdown.', 'Run a scan to see the breakdown.');
    fxDonutLoadingSync(false);
  }
  // And the lines and tiles beginScanChrome took down (QA D22), from the
  // stats of the tree still on screen; blank when there is none.
  renderDiskNotes();
  const s = state.scanStats;
  for (const [id, n] of [['statFiles', s ? s.fileCount : null], ['statDirs', s ? s.dirCount : null]]) {
    if (typeof n === 'number') countUp($(id), n);
    else { $(id).dataset.v = 0; $(id).textContent = '–'; }
  }
  const largest = state.largest[0] || null;
  // Name and size apart: only the name gives way to a narrow tile (G14).
  $('statLargest').textContent = largest ? largest.name : '–';
  $('statLargestSize').textContent = largest ? ' · ' + formatBytes(largest.size) : '';
  // The forecast is about the folder on screen, read by its path (B05).
  if (state.root) void renderGrowthProjection();
  // The refused row too: a stopped or failed whole-disk scan's notice
  // ("their size will not be in this total") goes with it (Track U, U-11).
  if (typeof renderRefusedFolders === 'function') renderRefusedFolders();
}

/**
 * The three dashboard lists, shown as loading rather than as empty.
 *
 * Used when a tree has been painted from the index but no scan has granted an
 * id yet: the lists are genuinely on their way, so "No files found." would be
 * a lie about a folder that plainly has files.
 */
function showListsPending() {
  clearDonut(); // the ring is the last folder's until this one's types land (B05)
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
 *
 * `path` is the folder the request asked to scan, the request's own: by the
 * time it answers, later Stops may have replaced every record of the one
 * that ended it (review F3.1).
 */
function abandonIfStopped(scanId, gen, path) {
  if (state.scanning && state.scanGen === gen) return false;
  // Its cancel can be refused as a Stop's own can, and the Stop that ended
  // this request has already said "stopped": a refusal is said the same way,
  // and takes back what that Stop — the one of this request's generation —
  // said on the start screen, while it still says it (review F2.2). Its
  // folder is offered nowhere whatever has been stopped since (review F3.1).
  const stop = state.lastStop && state.lastStop.gen === gen ? state.lastStop : null;
  void cancelScanById(scanId).catch((e) => stopNotConfirmed(e, gen, stop ? stop.noted : null, path));
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
  // The scan this Stop ends, by generation: a scan begun before the cancel
  // answers owns the status line and the live region (stopNotConfirmed).
  const gen = state.scanGen;
  // And by its folder, which a refused cancel keeps offered nowhere whatever
  // has been stopped or has failed by the time it answers (review F3.1).
  const stopped = state.scanningPath;
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
  // With no tree on screen the start screen comes back naming the folder that
  // was being scanned, "Scan … again" first among its choices (the owner,
  // 17 Oct 2026: "a scan should work again after being stopped"). A tree
  // still on screen — a rescan stopped — stays, with its own scan behind it.
  // What is said here is said before the cancel answers; `noted` is kept to
  // take it back if the cancel is refused (noteStopUnconfirmed).
  const noted = state.root ? null : noteLastFolder('stopped');
  // For a request this Stop ended before it answered, whose cancel is sent
  // when it does (abandonIfStopped).
  state.lastStop = { gen, noted };

  const status = $('scanStatus');
  status.classList.remove('error'); // stopping is a choice, not a failure
  status.innerHTML = icon('stop', 14) + '<span>Scan stopped by user</span>';
  restoreDashboardPanels();
  // And put the start screen back if that is where we are — over the
  // Dashboard's Stop, which held focus if it was pressed from the keyboard
  // (review F2.6).
  withFocusKept(() => { switchView(state.view); });
  // v4 §9.2 — the tour's "Reading your files…" card goes back to the welcome,
  // now the start screen is on screen: nothing is being read (review F2.2).
  tourScanFailed();
  // Focus on "Scan … again", never <body>, however Stop was pressed.
  focusStartScreen();
  // And said aloud: the start screen's own line, or the status line's, in a
  // live region nothing hides (review F1.14).
  $('stopAnnounce').textContent = noted ? startLastLine(noted) : 'Scan stopped.';

  // Stopped before POST /api/scan answered — startScanRequest abandons that scan — or before it was
  // sent, while startScan asked the index — and startScan starts none (final review F1.7).
  if (!scanId) return;
  try {
    await cancelScanById(scanId);
  } catch (e) {
    stopNotConfirmed(e, gen, noted, stopped);
  }
}

/**
 * A cancel that failed after a Stop had already said "stopped": the walk may
 * still be running server-side, and saying "stopped" would be a lie.
 *
 * Said where it is heard and seen: a toast, over every view — with nothing on
 * screen the status line sits in the Dashboard the start screen hides (review
 * F1.3). The status line, and the live region that said "Scan stopped." or
 * the start screen's sentence, only while no scan has begun since `gen`, the
 * generation the Stop ended: a scan begun since owns both — running, or
 * already ended with words of its own (review F2.9). Where they are this
 * Stop's, the live region is emptied, so no screen reader finds "stopped"
 * beside the toast, whether or not a start screen named a folder (review
 * F2.1). And the start screen offers the stopped scan's folder, `path`,
 * nowhere — whatever it says by then — and takes back what it said, while it
 * still says it (noteStopUnconfirmed, review F3.1).
 */
function stopNotConfirmed(e, gen, noted, path) {
  // 404 is not one of these: the record was already gone, so it is stopped.
  const refused = e.status !== 404;
  if (!refused) return;
  const why = 'Could not stop the scan: ' + e.message;
  toast(why, 'error');
  if (state.scanGen === gen) {
    const status = $('scanStatus');
    status.classList.add('error');
    status.innerHTML = icon('alert', 14) + '<span>' + escapeHtml(why) + '</span>';
    $('stopAnnounce').textContent = '';
  }
  noteStopUnconfirmed(noted, e.message, path);
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

/* Feature 5 — fast (incremental) rescan helpers.
   "Fast" is against the built-in walker: an incremental rescan always runs
   on the walker, because the mtime cache it reuses is the walker's. Where
   the native engine would run instead it is ~20× SLOWER (QA D45: 4.3 s
   against 0.2 s on the QA corpus), so the box is offered only where the next
   scan would not be native, and it is never ticked for the person. */
function scannedRoots() { try { return new Set(JSON.parse(localStorage.getItem('tm-scanned-roots') || '[]')); } catch { return new Set(); } }
function rememberScannedRoot(p) {
  const s = scannedRoots(); s.add(p);
  try { localStorage.setItem('tm-scanned-roots', JSON.stringify([...s].slice(-60))); } catch { /* the box is a convenience */ }
  // QA D47: the folder in the path box may be the one just scanned — the box
  // is offered now, not after the next edit. The engine plan is read again:
  // a "Don't scan" rule saved since the last look moves the next scan off
  // the native engine.
  maybeShowFastRescan();
  void refreshFastRescanPlan();
}
/** Whether the next scan would run on the native engine: true, false, or null while not known. */
let fastRescanNative = null;
/**
 * The engine rule (scan/nativeEngine.ts, nativeRule) as far as the page can
 * see it: Automatic, Native or NTFS turbo, the native core loaded, and no
 * "Don't scan" pattern (their glob dialect lives in the walker). NTFS turbo
 * is one of them because nativeRule has no rule for it (final review F1.6):
 * where the turbo mode does not scan, the native engine does, so a fast
 * rescan would never be used there, and asking for one keeps the turbo mode
 * off. The probe of the folder itself is the server's; a refusal there sends
 * a scan to the walker, which only means the box was not offered where it
 * would have helped.
 */
function nativeScanExpected(caps, settings) {
  if (!caps || !caps.native || typeof caps.native.available !== 'boolean' || !settings) return null;
  if (!caps.native.available) return false;
  const engine = settings.engine || 'auto';
  if (engine !== 'auto' && engine !== 'native' && engine !== 'ntfs-mft') return false;
  const ignore = Array.isArray(settings.ignore) ? settings.ignore : [];
  return !ignore.some((e) => e && e.pattern && e.scope !== 'suggest');
}
async function refreshFastRescanPlan() {
  try {
    const [caps, settings] = await Promise.all([api('/api/engine/capabilities'), api('/api/settings')]);
    fastRescanNative = nativeScanExpected(caps, settings);
  } catch {
    fastRescanNative = null; // not known: offered unticked, which costs nothing
  }
  maybeShowFastRescan();
}
function maybeShowFastRescan() {
  const wrap = $('fastRescanWrap'); if (!wrap) return;
  // Read as the Scan button reads it (asPath), so it speaks for exactly the
  // path Scan will scan: a root remembered as "Screenshots " is known by that
  // name (review F2.4), and "Documents " is not "Documents" (QA4a R4-2).
  const p = asPath($('pathInput').value);
  const show = !!p && scannedRoots().has(p) && fastRescanNative !== true;
  wrap.hidden = !show;
  // Never ticked for the person: it can be the slow path, so it is their
  // choice, which stands while the box is offered. A hidden box asks nothing.
  if (!show) $('fastRescan').checked = false;
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
  // A scan paints the Full Disk Access notice only if it sets one itself
  // (startScanRequest → preScanAccessNotice, after this): a cloud scan never
  // does, and must not inherit the last disk scan's (U-11, review F1.2).
  state.accessNotice = null;
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
  $('stopAnnounce').textContent = ''; // so the next Stop's words are a change, and spoken (review F1.14)
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
  clearDonut(); // before the legend: taking the ring down empties it
  $('donutLegend').innerHTML = skeletonRows(5, 24);
  fxDonutLoadingSync(true);
  // The last scan's summary is stale the moment a new one starts — hide it and
  // invalidate any in-flight snapshot poll so it can't repaint mid-scan.
  state.whatsNew.seq++;
  $('whatsNewCard').hidden = true;
  // So are its facts (QA D22): "4 files claim 7.1 GB…", the engine line,
  // Quick Stats' counts and "Index live — always current" stood beside the
  // skeletons until finishScan repainted them. Blanked the way finishScan
  // blanks a tile it has no number for; restoreDashboardPanels puts the lines
  // and tiles back when the scan is stopped or fails, as the last tree stays
  // on screen. The index badge and line stay down until the next scan paints
  // them: a background build of the last folder no longer speaks (the
  // generation moves on, review L2), and its claim was not re-checked.
  for (const id of ['sparseRow', 'hardlinkRow', 'cloudRow', 'engineRow']) $(id).hidden = true;
  for (const id of ['statFiles', 'statDirs']) { $(id).dataset.v = 0; $(id).textContent = '–'; }
  // B05: the ring's centre total (above), Largest file and the disk-full
  // forecast were the last folder's too, and stood for the whole scan.
  $('statLargest').textContent = '–';
  $('statLargestSize').textContent = '';
  if ($('growthProj')) $('growthProj').hidden = true;
  renderIndexBadge(null);
  indexLineGen++;
  renderIndexLine(null);
  // Focus on a button this hides — the welcome's "Choose a folder", handed
  // back by the folder browser as it closed — would fall to <body> for the
  // whole scan (review F1.11): withFocusKept moves it on.
  withFocusKept(() => {
    $('emptyState').style.display = 'none';
    switchView('dashboard');
  });
}

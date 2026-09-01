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
  if (!info || !info.indexed || !info.root) { el.hidden = true; return; }
  const stale = info.root.state !== 'ready' || !info.root.live;
  el.classList.toggle('stale', stale);
  el.innerHTML =
    '<span class="dot"></span><span>' +
    (stale
      ? 'Index may be out of date — it wasn’t watching while TreeMap was closed. Scan again to refresh it.'
      : 'Index live — always current') +
    '</span>';
  el.title = stale
    ? 'TreeMap keeps a saved index of this folder so it opens instantly. It stopped watching for changes at some point, so something may have changed since.'
    : 'This folder opens instantly from a saved index that updates itself as files change.';
  el.hidden = false;
}

/** Ask whether a folder can be served from the index. Never throws. */
async function indexStatusFor(path) {
  try {
    return await api('/api/index/status?path=' + encodeURIComponent(path));
  } catch {
    return null; // no index service, no problem — scanning still works
  }
}

/**
 * Open a folder straight from the index.
 *
 * Returns true when it rendered. The tree comes back in the same `FileNode`
 * shape a scan produces, so everything downstream — treemap, grid, cart — is
 * the existing code path with no special casing.
 */
async function openFromIndex(path, info) {
  const t0 = performance.now();
  let data;
  try {
    data = await api('/api/index/tree?path=' + encodeURIComponent(path) + '&maxNodes=' + INSTANT_OPEN_NODES);
  } catch {
    return false; // fall through to a real scan
  }
  if (!data || !data.root) return false;

  // A scanId is what every destructive and drill-in endpoint keys off. The
  // index cannot grant one — those endpoints deliberately require a scan this
  // server actually performed — so a real scan still runs in the background to
  // unlock them. What the index buys is the instant paint.
  state.root = data.root;
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
 * Build the index for a freshly-scanned root, in the background.
 *
 * Fire-and-forget on purpose: this is what makes the *next* open instant, and
 * the user is already looking at their results. A failure is silent because
 * nothing they can see depends on it — scanning keeps working exactly as
 * before if indexing is unavailable.
 */
async function buildIndexInBackground(path) {
  try {
    const started = await api('/api/index/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    // The build endpoint answers 202 with a job id and returns immediately, so
    // asking for status now would read the index mid-build and paint a badge
    // describing a state that is about to change. Wait for the job to settle
    // first — this is exactly the 202 handling the shared wrapper provides.
    await api(`/api/index/${started.jobId}/result`, undefined, { poll: true, pollMs: 500, pollTimeoutMs: 600000 });

    const info = await indexStatusFor(path);
    // Only paint if the user is still looking at this folder; they may have
    // scanned somewhere else while a big index was building. The loaded tree's
    // own root is the test — `state.lastScan` carries timing, not a path.
    if (info && state.root && state.root.path === path) renderIndexBadge(info);
  } catch {
    /* indexing is an optimisation, never a requirement — scanning still works */
  }
}

async function startScan(path, opts = {}) {
  if (state.scanning) { toast('A scan is already running', 'error'); return; }
  closeEventSource();
  disableLive({ keepWanted: true }); // the new scanId gets a fresh watch session

  // Answer the click BEFORE the index probe below, which is a network round
  // trip — measured at 400ms on a large indexed root, and longer again when it
  // goes on to fetch the tree. Doing that first left the button reading "Scan"
  // with no spinner for the whole time, which reads as the app having missed
  // the click. `quiet` because we do not yet know whether the index will paint;
  // startScanRequest re-enters with the real value a moment later.
  beginScanChrome({ quiet: true, message: 'Starting scan…' });

  // A1: if this folder is already indexed, paint from the index first so the
  // user sees their tree immediately, then let the scan refresh it underneath.
  // Skipped for an explicit fast-rescan, which the user asked to be a rescan.
  if (!opts.incremental && !opts.noIndex) {
    const info = await indexStatusFor(path);
    if (info && info.indexed && info.root && info.root.state !== 'building') {
      const painted = await openFromIndex(path, info);
      if (painted) {
        // The scan still runs — it grants the scanId the destructive endpoints
        // require, and reconciles anything the watcher missed.
        void startScanRequest(path, opts, { quiet: true });
        return;
      }
    }
  }
  await startScanRequest(path, opts, { quiet: false });
}

/** The actual scan request, split out so the index path can run it quietly. */
async function startScanRequest(path, opts = {}, { quiet = false } = {}) {
  try {
    beginScanChrome({ quiet });
    const gen = state.scanGen; // this request's identity for the abandon check below
    const t0 = performance.now();
    const resp = await api('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, incremental: !!opts.incremental }),
    });
    if (abandonIfStopped(resp.scanId, gen)) return;
    followScanProgress(resp.scanId, path, resp.incremental === true, t0);
  } catch (e) {
    // A background refresh that fails must not blow away the tree already on
    // screen — the indexed view is still perfectly usable.
    if (quiet) { console.warn('[treemap] background rescan failed:', e); return; }
    failScan(e.message);
  }
}

/** Follow a running scan (disk or cloud) over SSE, with the stall watchdog. */
function followScanProgress(scanId, path, fast, t0) {
  const status = $('scanStatus');
  const fastTag = fast ? icon('zap', 12) + ' Fast rescan · ' : '';
  const isCloud = path.startsWith('cloud://');
  state.scanId = scanId;

  const es = new EventSource(`/api/scan/${scanId}/progress`);
  state.es = es;
  // Watchdog: SSE can stall silently through proxies (no error event, no
  // frames). If the stream goes quiet mid-scan, poll the result directly.
  let lastSseAt = performance.now();
  let finished = false;
  const watchdog = setInterval(async () => {
    if (!state.scanning || finished) { clearInterval(watchdog); return; }
    if (performance.now() - lastSseAt < 6000) return;
    try {
      const r = await api(`/api/scan/${scanId}/result`);
      if (r.status === 'complete' && !finished) {
        finished = true;
        clearInterval(watchdog);
        closeEventSource();
        if (!isCloud) rememberScannedRoot(path);
        if (fast) showFastRescanStat(scanId);
        finishScan(r.root, performance.now() - t0, await scanStatsFor(scanId, r));
      }
    } catch (e) {
      // 500: the scan itself failed server-side. 404: the scan record is
      // gone (evicted or the server restarted) — waiting longer can never
      // succeed, so stop the spinner instead of polling forever.
      if ((e.status === 500 || e.status === 404) && !finished) {
        finished = true;
        clearInterval(watchdog);
        closeEventSource();
        failScan(e.status === 404 ? 'The scan expired — please run it again.' : e.message);
      }
      /* otherwise: still running or transient — keep waiting */
    }
  }, 3000);
  // Hand Stop the two things only this closure can settle. `finished` also
  // gates es.onmessage, so a frame already queued when Stop is pressed is
  // dropped rather than repainting a scan the user just ended.
  state.abortScan = () => { finished = true; clearInterval(watchdog); };
  es.onmessage = async (ev) => {
    lastSseAt = performance.now();
    if (finished) return;
    const msg = JSON.parse(ev.data);
    if (msg.type === 'progress') {
      const secs = (performance.now() - t0) / 1000;
      const rate = secs > 0.2 ? Math.round(msg.scanned / secs) : 0;
      // The "searching" orb in the well beside this line is the activity
      // indicator now — the status carries only the numbers.
      status.innerHTML =
        `<span class="num">${fastTag}Scanning… <b>${formatCount(msg.scanned)}</b> items` +
        (rate ? ` · ${formatCount(rate)}/s` : '') + ` · ${secs.toFixed(1)}s</span>`;
      $('scanMeta').textContent = msg.currentPath;
    } else if (msg.type === 'complete') {
      finished = true;
      clearInterval(watchdog);
      closeEventSource();
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
      finished = true;
      clearInterval(watchdog);
      closeEventSource();
      failScan(msg.message);
    } else if (msg.type === 'shutdown') {
      finished = true;
      clearInterval(watchdog);
      closeEventSource();
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
  closeEventSource();
  disableLive({ keepWanted: false }); // watching makes no sense on a cloud tree
  try {
    beginScanChrome();
    const gen = state.scanGen; // this request's identity for the abandon check below
    $('scanStatus').innerHTML = `<span>Listing ${escapeHtml(providerName)}…</span>`;
    const t0 = performance.now();
    const resp = await api('/api/cloud/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerId }),
    });
    if (abandonIfStopped(resp.scanId, gen)) return;
    followScanProgress(resp.scanId, 'cloud://' + providerId, false, t0);
  } catch (e) {
    failScan(e.message);
  }
}

function endScanChrome() {
  state.scanning = false;
  state.abortScan = null;
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
}

function failScan(message) {
  endScanChrome();
  const status = $('scanStatus');
  status.classList.add('error');
  status.innerHTML = icon('alert', 14) + '<span>' + escapeHtml(message) + '</span>';
  restoreDashboardPanels();
  toast(message, 'error');
  switchView(state.view);
}

/**
 * Build the ScanStats shape from a /result response, whose counters sit at the
 * top level rather than under `stats`. Keeps the SSE path and the watchdog
 * fallback painting from identical data.
 */
function statsFromResult(r) {
  return {
    scanned: r.scanned, fileCount: r.fileCount, dirCount: r.dirCount,
    engine: r.engine, ioThreads: r.ioThreads,
    durationMs: r.finishedAt && r.startedAt ? r.finishedAt - r.startedAt : 0,
    incremental: !!r.incremental, cachedDirs: r.cachedDirs || 0, walkedDirs: r.walkedDirs || 0,
    hardlinkedFiles: r.hardlinkedFiles || 0, hardlinkedBytes: r.hardlinkedBytes || 0,
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
    return statsFromResult({ ...result, ...await api(`/api/scan/${scanId}/stats`) });
  } catch {
    return statsFromResult(result);
  }
}

async function finishScan(root, durationMs, stats) {
  endScanChrome();
  state.root = root;
  // The id that answers questions about the tree we just put on screen — set
  // in the same breath as the tree so the two can never disagree. Null on the
  // index-first paint, which has a tree and deliberately no scan yet. Stop
  // reads it to put the previous results back when a rescan is abandoned.
  state.settledScanId = state.scanId;
  indexTree(root);
  state.lastScan = { when: Date.now(), durationMs };
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

  $('scanStatus').classList.remove('error');
  $('scanStatus').innerHTML = icon('checkCircle', 14) +
    `<span class="num">Scanned ${files === null ? '' : `<b>${formatCount(files)}</b> files `}` +
    `in ${(durationMs / 1000).toFixed(1)}s — ${formatBytes(root.size)} in ${escapeHtml(root.path)}</span>`;
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
  FxNum.rollText($('statLastScan'), new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }));
  renderDiskNotes();
  // finishScan runs twice per scan by design — the index-first instant paint
  // (scanId still null, see the gate below), then the real completion. One
  // scan gets ONE completion toast, on the pass that actually completed (QA D3).
  // FX: the completion pulse rides the same gate — one crossing, one pulse.
  if (state.scanId) {
    toast(`Scan complete — ${formatBytes(root.size)}${files === null ? '' : ` across ${formatCount(files)} files`}`);
    fxScanDonePulse();
  }

  // Painted. Now the expensive server-side walks, filling in behind it.
  void loadWhatsNew(); // "what's new" banner — fetches its snapshots behind the paint too
  void loadDriveHealth(); // C4 — shells out to smartctl, so never in front of the paint
  void loadCostEstimate(); // C1
  state.largest = []; state.types = []; state.bigFolders = [];
  $('statLargest').textContent = '–';
  // Painted from the index: there is no scan yet, so these three would be
  // `?scanId=null` (404) or, worse, the previous scan's id (500 after a stop,
  // or another folder's data). The background scan calls finishScan again with
  // a real id in a moment, and that is what fills them in.
  if (!state.scanId) {
    showListsPending();
    emit(TOPIC.scan, null);
    switchView(state.view);
    return;
  }
  try {
    /* All three poll. finishScan normally runs against a scan that just
       finished, but not always: the index paints a tree before any scan has an
       id, a rescan can be in flight against this one, and all three endpoints
       answer a running scan with 202. Without poll the 202 body has no `files`
       / `types` / `folders` field, so the row either read undefined or — once
       api() started throwing on an unrequested 202 — told the user "could not
       load stats" about a scan that was merely still running. */
    const [lf, ft, lfo] = await Promise.all([
      api(`/api/large-files?scanId=${state.scanId}&limit=10&minSize=1`, undefined, { poll: true }),
      api(`/api/file-types?scanId=${state.scanId}`, undefined, { poll: true }),
      api(`/api/large-folders?scanId=${state.scanId}&limit=10`, undefined, { poll: true }),
    ]);
    state.largest = lf.files; state.types = ft.types; state.bigFolders = lfo.folders;
    seedNodes(lf.files); // right-click/cart on a big file must resolve even if pruned away
    const largest = state.largest[0] || null;
    $('statLargest').textContent = largest ? `${largest.name} · ${formatBytes(largest.size)}` : '–';
  } catch (e) { toast('Could not load stats: ' + e.message, 'error'); }

  refreshBigFiles();
  renderBigFolders();
  state.donut.animated = false;
  renderDonut();
  // Tell every view a new scan landed, then re-enter the current one. Views
  // repoint themselves at the new root in onScanChange, so switchView's mount
  // is the single load path — previously this called loadTreemap()/renderGrid()
  // and *then* switchView(), loading the active view twice on every scan.
  emit(TOPIC.scan, state.scanId);
  switchView(state.view);
  // A1: make the *next* open of this folder instant. Background, non-blocking,
  // and only for real local scans — a cloud account has no filesystem to watch,
  // and re-indexing what we just read from the index would be pointless work.
  if (root.path && !root.path.startsWith('cloud://') && state.scanStats?.engine !== 'index') {
    buildIndexInBackground(root.path);
  }
  renderGrowthProjection();
  loadBudgets();
  // The snapshot (and its time-slider tree) is saved asynchronously after the
  // scan completes — pick it up once it lands.
  setTimeout(() => { if (state.view === 'treemap') refreshTimebar(); }, 1500);
  if (state.live.wanted) enableLive(); // Live survives rescans
}

/* Features 11 + 10 — hard-link / cloud-placeholder dashboard notes. */
function renderDiskNotes() {
  const s = state.scanStats || {};
  const hl = $('hardlinkRow');
  if (hl) {
    if (s.hardlinkedFiles > 0) {
      $('hardlinkText').textContent = `${formatCount(s.hardlinkedFiles)} hard-linked file${s.hardlinkedFiles === 1 ? '' : 's'} (${formatBytes(s.hardlinkedBytes)})`;
      hl.hidden = false;
    } else hl.hidden = true;
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
      const label = { 'gdu-turbo': 'Turbo engine (gdu)', 'turbo-walker': 'Turbo walker', 'ntfs-mft': 'NTFS MFT reader', walker: 'Standard walker', cloud: 'Cloud metadata listing' }[s.engine] || s.engine;
      const rate = s.durationMs > 0 ? Math.round(s.scanned / (s.durationMs / 1000)) : 0;
      $('engineText').textContent = `${label} — scanned ${formatCount(s.scanned)} items in ${(s.durationMs / 1000).toFixed(1)} s` +
        (rate ? ` · ${formatCount(rate)}/s` : '');
      $('engineHint').textContent = s.engine === 'gdu-turbo'
        ? 'A bundled gdu subprocess per top-level folder — same counts as the built-in walker, measurably faster.'
        : s.ioThreads > 4
          ? `${s.ioThreads} parallel I/O threads keep the disk saturated instead of Node's default 4.`
          : '';
      en.hidden = false;
    } else en.hidden = true;
  }
  // renderCloudSafe() walks the whole tree server-side. It only fills the Clean
  // Up modal, so it runs when that modal opens — not on every scan completion.
}

/* Feature 10 — "Cloud-safe deletes" list in the Clean Up modal. */
async function renderCloudSafe() {
  const host = $('cloudResults');
  const tab = $('cleanTabCloud');
  if (!host) return;
  const hide = () => { if (tab) tab.hidden = true; host.innerHTML = ''; };
  if (!state.scanId) { hide(); return; }

  // The client tree is pruned to a node budget, so counting placeholders here
  // would only see the part that came through. The server walks the whole scan:
  // its counts and byte totals are exact, only the file lists are capped.
  let data;
  try {
    data = await api(`/api/cleanup/cloud-safe?scanId=${state.scanId}`);
  } catch (e) {
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

  if (tab) tab.hidden = data.totalCount === 0;
  if (!data.totalCount) { host.innerHTML = ''; return; }
  for (const g of data.groups) seedNodes(g.files); // these get staged into the cart from here

  const label = { icloud: 'iCloud Drive', onedrive: 'OneDrive', dropbox: 'Dropbox', cloud: 'Cloud' };
  host.innerHTML = `<div class="muted" style="margin-bottom:10px;">${formatCount(data.totalCount)} online-only file${data.totalCount === 1 ? '' : 's'} (${formatBytes(data.totalSize)} logical). The cloud keeps the original, so removing the local copy is safe.</div>` +
    data.groups.map((g) =>
      `<div style="margin-bottom:14px;">
        <div class="rule-row" style="padding:6px 0;"><b>${label[g.provider] || 'Cloud'}</b><span class="size-badge num" style="margin-left:auto;">${formatCount(g.count)} · ${formatBytes(g.totalSize)}</span></div>
        <div class="clean-list">` + g.files.map((n) =>
          `<div class="clean-item">${chipFor(n, 13)}<div class="meta"><div class="nm">${escapeHtml(n.name)}</div><div class="pth">${escapeHtml(n.path)}</div></div>` +
          `<span class="dt num">${formatDate(n.modifiedAt)}</span><span class="size-badge num">${formatBytes(n.size)}</span>` +
          `<button class="icon-btn" data-cart-add="${escapeHtml(n.path)}" aria-label="Add ${escapeHtml(n.name)} to cleanup cart">${icon('plus', 13)}</button></div>`
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
    el.className = 'growth-proj ' + (d < 30 ? 'danger' : 'warn');
    el.innerHTML = icon('trendUp', 15) +
      `<span>At current growth (+${formatBytes(f.bytesPerDay)}/day), this disk is full in <b>~${formatCount(d)} day${d === 1 ? '' : 's'}</b>` +
      (culprits ? ` — top culprits: ${escapeHtml(culprits)}` : '') + `</span>`;
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

$('scanBtn').addEventListener('click', () => {
  if (state.scanning) { void stopScan(); return; } // the same button is Stop mid-scan
  const p = $('pathInput').value.trim();
  if (!p) { toast('Enter a folder path first', 'error'); return; }
  startScan(p, { incremental: !$('fastRescanWrap').hidden && $('fastRescan').checked });
});
// Enter starts a scan and only ever starts one. It used to be free of this
// check because the button was disabled mid-scan; now that the button is Stop,
// an unguarded Enter in the path field would cancel the running scan instead.
//
// Refusing is right. Refusing in SILENCE was not: the app auto-scans the last
// path at boot, so the very first thing a returning user can do is type a
// different folder and press Enter — and for those seconds Enter did nothing
// at all, with no scan and no message. That reads as a broken input, and it
// fooled two people testing this build before it was noticed. The house rule
// is the one at tmRunGrammarQuery: say so rather than doing nothing. The
// button's own behaviour is unchanged; only the refusal gained a voice.
$('pathInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !state.scanning) { $('scanBtn').click(); return; }
  if (e.key === 'Enter') toast('A scan is already running — press Stop to end it, then press Enter to scan this path.', 'error');
});
$('pathInput').addEventListener('input', maybeShowFastRescan);
maybeShowFastRescan();
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
  host.innerHTML = rows.map((f, i) => `
    <div class="bigfile">
      ${chipFor(f)}
      <div class="meta">
        <div class="nm" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
        <div class="pth" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</div>
      </div>
      <div class="bar-track"><div class="fx-bar-fill" data-w="${Math.max(4, (f.size / max) * 100).toFixed(1)}" style="${fxBarStyle(i)}"></div></div>
      <span class="fx-li-pct num">${Math.round((f.size / max) * 100)}%</span>
      ${reclaimBadge(f.path, scoreFor(f.path)) || (state.bigFilesSort === 'reclaim' && scoreKnown(f.path) ? '<span class="rc-none" title="None of the six signals could be read for this file">not scored</span>' : '')}
      <span class="size-badge num" style="color:color-mix(in srgb, ${sizeColor(f.size)} 60%, var(--text-1));">${formatBytes(f.size)}</span>
      <span class="actions">
        <button class="icon-btn" data-cart-add="${escapeHtml(f.path)}" aria-label="Add ${escapeHtml(f.name)} to cleanup cart">${icon('plus', 14)}</button>
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
function renderBigFolders() {
  const host = $('bigFolders');
  const folders = state.bigFolders || [];
  if (!folders.length) { host.innerHTML = '<div class="muted">No folders above 1 MB found.</div>'; return; }
  const max = folders[0].size || 1;
  host.innerHTML = folders.map((f, i) => `
    <div class="bigfile" data-jump="${escapeHtml(f.path)}" style="cursor:pointer;" role="button" tabindex="0"
         aria-label="Open ${escapeHtml(f.name)} in the treemap">
      ${chipFor({ type: 'dir' })}
      <div class="meta">
        <div class="nm" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
        <div class="pth" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</div>
      </div>
      <span class="cnt muted num" style="white-space:nowrap;">${formatCount(f.fileCount)} files</span>
      <div class="bar-track"><div class="fx-bar-fill" data-w="${Math.max(4, (f.size / max) * 100).toFixed(1)}" style="${fxBarStyle(i)}"></div></div>
      <span class="fx-li-pct num">${Math.round((f.size / max) * 100)}%</span>
      <span class="size-badge num" style="color:color-mix(in srgb, ${sizeColor(f.size)} 60%, var(--text-1));">${formatBytes(f.size)}</span>
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
      ...(rest.length ? [{
        name: `${formatCount(rest.length)} more`,
        value: rest.reduce((a, t) => a + t.totalSize, 0),
        count: rest.reduce((a, t) => a + t.count, 0),
      }] : []),
    ],
    centerLabel: 'All types',
  };
  if (donutHandle) donutHandle.update(spec);
  else donutHandle = FxCharts.rings($('donutCanvas'), legend, spec);
}

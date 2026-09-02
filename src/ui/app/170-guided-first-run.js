/* ───────────────────── v4 §9.2 — the guided first run ─────────────────────
 *
 * A coach card, not a wizard: the user drives the real UI while the card
 * narrates. Three promises, each held by tests/firstRun.test.ts:
 *
 *  - The tour NEVER stages anything itself. Staging happens only when the
 *    user clicks the card's Add button, which goes through cartAddMany —
 *    the one cart, its own pipeline.
 *  - Every win comes from /api/cleanup/suggestions — the same engine, the
 *    same rules, the same confidence the Clean Up view shows. Advisory
 *    groups (which have no delete path anywhere) are never offered.
 *  - Skippable at every step; completing OR skipping persists tourDone
 *    through settings, so a read-only portable session honestly forgets.
 */
const tour = { active: false, step: 'welcome', wins: [], winIx: 0, staged: 0, unknownReason: '' };

function tourMaybeStart(done) {
  if (done === true || tour.active) return;
  tour.active = true;
  tour.step = state.scanId ? 'map' : 'welcome';
  tourRender();
}

async function tourFinish(message) {
  if (!tour.active) return;
  tour.active = false;
  $('tourOverlay').hidden = true;
  if (message) toast(message);
  try {
    await api('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tourDone: true }),
    });
  } catch { /* a failed write means the tour offers itself again next launch — honest */ }
}

function tourRender() {
  if (!tour.active) return;
  const host = $('tourCard');
  $('tourOverlay').hidden = false;
  const skipBtn = `<button class="btn" data-tour-skip>Skip the tour</button>`;
  if (tour.step === 'welcome') {
    const home = state.system && state.system.homeDir;
    host.innerHTML = `
      <div class="tour-step">Welcome · step 1 of 4</div>
      <h4>${icon('treemap', 16)}See where your disk went</h4>
      <p>TreeMap draws every file and folder as a map — the bigger the rectangle, the more space it takes. Start by scanning a folder${home ? ', or just use your home folder' : ' (type a path in the box up top)'}.</p>
      <div class="tour-row">
        ${home ? `<button class="btn btn-primary" data-tour-home>Scan my home folder</button>` : ''}
        <button class="btn" data-tour-pick>I’ll pick my own</button>
        ${skipBtn}
      </div>`;
    if (home) host.querySelector('[data-tour-home]').addEventListener('click', () => { startScan(home); });
    host.querySelector('[data-tour-pick]').addEventListener('click', () => {
      // Before any scan the top path box is not on screen, and focusing a
      // hidden input does nothing at all, silently (summonGlobalSearch
      // documents the same trap). The zero-state's own affordance is the
      // folder browser — hand the user exactly the control they can see.
      const pi = $('pathInput');
      if (pi.offsetParent === null) { openBrowse(null); return; }
      pi.focus();
      pi.select();
    });
  } else if (tour.step === 'scanning') {
    // The click registered — say so. The old card kept offering "Scan my
    // home folder" for the whole scan, and a second press earned a red
    // "already running" toast within the first ten seconds.
    const name = state.root ? state.root.name : ($('pathInput').value.trim() || 'this folder');
    host.innerHTML = `
      <div class="tour-step">Welcome · step 1 of 4</div>
      <h4>${icon('loader', 16)}Reading your files…</h4>
      <p>TreeMap is measuring every file and folder in ${escapeHtml(name)}. The map appears the moment it finishes — a big folder can take a minute.</p>
      <div class="tour-row">${skipBtn}</div>`;
  } else if (tour.step === 'map') {
    host.innerHTML = `
      <div class="tour-step">The map · step 2 of 4</div>
      <h4>${icon('treemap', 16)}This is your disk as a map</h4>
      <p>Every rectangle is a file or folder; bigger means more space. Click one to drill in, press <kbd>Esc</kbd> to climb back out, and hover anything for the details.</p>
      <div class="tour-row">
        <button class="btn btn-primary" data-tour-wins>Show me what I could free</button>
        ${skipBtn}
      </div>`;
    host.querySelector('[data-tour-wins]').addEventListener('click', () => { void tourLoadWins(); });
  } else if (tour.step === 'clean') {
    host.innerHTML = `
      <div class="tour-step">All done</div>
      <h4>${icon('checkCircle', 16)}This folder looks clean</h4>
      <p>TreeMap has nothing safe to suggest here — no caches, no rebuildable folders, no obvious junk. That is a good result, and the honest end of the tour.</p>
      <div class="tour-row"><button class="btn btn-primary" data-tour-done>Finish</button></div>`;
    host.querySelector('[data-tour-done]').addEventListener('click', () => { void tourFinish('Tour complete'); });
  } else if (tour.step === 'unknown') {
    // Not "clean" — "couldn't check". A blank good-news card over an error
    // would be exactly the confident wrongness this app exists to avoid.
    host.innerHTML = `
      <div class="tour-step">One thing unchecked</div>
      <h4>${icon('alert', 16)}Couldn&rsquo;t check for quick wins</h4>
      <p>${escapeHtml(tour.unknownReason || 'Suggestions are not available right now.')} The Clean Up view will have more to say once it can look.</p>
      <div class="tour-row"><button class="btn btn-primary" data-tour-done>Finish</button></div>`;
    host.querySelector('[data-tour-done]').addEventListener('click', () => { void tourFinish('Tour complete'); });
  } else if (tour.step === 'win') {
    const g = tour.wins[tour.winIx];
    const already = g.items.every((it) => state.cart.has(it.path));
    host.innerHTML = `
      <div class="tour-step">Quick win ${tour.winIx + 1} of ${tour.wins.length} · step 3 of 4</div>
      <h4>${icon('sparkles', 16)}${escapeHtml(g.title)} — ${formatBytes(g.totalSize)}</h4>
      <p>${escapeHtml(g.description)}${g.why ? ` <span class="muted">${escapeHtml(g.why)}</span>` : ''}</p>
      <div class="tour-row">
        <button class="btn btn-primary" data-tour-add ${already ? 'disabled' : ''}>${already ? 'Already in the cart' : 'Add to cart'}</button>
        <button class="btn" data-tour-next>${tour.winIx + 1 < tour.wins.length ? 'Skip this one' : 'Not this one'}</button>
        ${skipBtn}
      </div>`;
    host.querySelector('[data-tour-add]').addEventListener('click', () => {
      // The one place the tour touches the cart — inside the user's click.
      tour.staged += cartAddMany(g.items.map((it) => it.path));
      tourAdvanceWin();
    });
    host.querySelector('[data-tour-next]').addEventListener('click', tourAdvanceWin);
  } else if (tour.step === 'cart') {
    host.innerHTML = `
      <div class="tour-step">The cart · step 4 of 4</div>
      <h4>${icon('cart', 16)}Staged — deleted only when you say so</h4>
      <p>${tour.staged > 0
        ? `Everything you added is waiting in the cleanup cart at the bottom. Nothing has been deleted.`
        : `You added nothing — also fine. The cart at the bottom is where anything you stage waits.`}
        Committing the cart runs a preview first, protects files in the Time Capsule, and every run has a one-click Undo.</p>
      <div class="tour-row"><button class="btn btn-primary" data-tour-done>Finish</button></div>`;
    host.querySelector('[data-tour-done]').addEventListener('click', () => { void tourFinish('Tour complete — the map is yours'); });
  }
  const skip = host.querySelector('[data-tour-skip]');
  if (skip) skip.addEventListener('click', () => { void tourFinish('Tour skipped — reset it any time in Settings'); });
  // The card takes focus so keyboard users land on its primary action — but
  // never out of a text field. A scan completing repaints this card, and
  // yanking the caret from someone mid-word is how a coach becomes a pest.
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  const primary = host.querySelector('.btn-primary') || host.querySelector('button');
  if (primary && !typing) primary.focus();
}

function tourAdvanceWin() {
  if (tour.winIx + 1 < tour.wins.length) {
    tour.winIx += 1;
  } else {
    tour.step = 'cart';
  }
  tourRender();
}

async function tourLoadWins() {
  if (!state.scanId) return;
  // A fourth non-answer, and the loudest: the folder was never read. On a Mac
  // without Full Disk Access a scan of Desktop or Documents returns nothing,
  // and congratulating someone on a folder the OS would not open is the
  // worst thing the first run can say. The refused probe has already looked
  // by the time the tour asks.
  if (state.scanRefused && state.scanRefused.dirs) {
    tour.step = 'unknown';
    tour.unknownReason = state.scanRefused.root
      ? 'macOS would not let TreeMap look inside this folder, so nothing here has been checked.'
      : `${state.scanRefused.dirs} folder${state.scanRefused.dirs === 1 ? '' : 's'} could not be read, so this is not the whole picture.`;
    tourRender();
    return;
  }
  // Three distinct non-answers must not read as "clean" (review round 1):
  // a still-running scan (202 — poll it out), a broken rule catalog
  // (available:false with its reason), and a transport error. Each gets the
  // honest card; only a real, complete, empty answer earns "looks clean".
  let groups = [];
  try {
    const res = await api(`/api/cleanup/suggestions?scanId=${state.scanId}`, undefined, { poll: true });
    if (res && res.available === false) {
      tour.step = 'unknown';
      tour.unknownReason = res.reason || 'Suggestions are not available right now.';
      tourRender();
      return;
    }
    groups = (res && res.groups) || [];
  } catch (e) {
    tour.step = 'unknown';
    tour.unknownReason = 'Could not check: ' + e.message;
    tourRender();
    return;
  }
  // The normal engine's own output, minus what has no delete path: advisory
  // groups are information, not wins, and offering them would break the
  // app-wide rule that they carry no cart button.
  tour.wins = groups.filter((g) => !g.advisory && g.totalSize > 0 && g.items.length > 0).slice(0, 3);
  tour.winIx = 0;
  // A folder the OS refused to open came back empty, and "clean" would be
  // the false all-clear this card exists to avoid (renderRefusedFolders).
  if (!tour.wins.length && state.scanRefused && state.scanRefused.dirs > 0) {
    const r = state.scanRefused;
    const mac = state.system && state.system.platform === 'darwin';
    tour.step = 'unknown';
    tour.unknownReason = r.root
      ? (mac ? 'macOS would not let TreeMap look inside this folder' : 'TreeMap was not allowed to read this folder') + ', so nothing here has been checked.'
      : `${r.dirs} folder${r.dirs === 1 ? '' : 's'} could not be read, so part of this folder has not been checked.`;
    tourRender();
    return;
  }
  tour.step = tour.wins.length ? 'win' : 'clean';
  tourRender();
}

/** A scan started while the welcome card is up: the card follows. Called from
 *  beginScanChrome, so Browse, ⌘K, a drop and the card's own button all count. */
function tourScanStarted() {
  if (tour.active && tour.step === 'welcome') { tour.step = 'scanning'; tourRender(); }
}
/** The scan failed before it landed: the welcome card and its buttons come back. */
function tourScanFailed() {
  if (tour.active && tour.step === 'scanning') { tour.step = 'welcome'; tourRender(); }
}

// A scan landing while the welcome card is up means the user took the step —
// move with them. Any later scans leave the tour where it is.
subscribe(TOPIC.scan, () => {
  if (!tour.active) return;
  if (!(tour.step === 'welcome' || tour.step === 'scanning')) return;
  tour.step = 'map';
  // After finishScan's own synchronous switchView(state.view): the first scan
  // lands on the dashboard, and the card would narrate a map the user is not
  // looking at (the restart path below fixed this for Settings › Show the
  // tour again; the first run it was written for still had it).
  queueMicrotask(() => {
    if (tour.active && tour.step === 'map' && state.root && state.view !== 'treemap') switchView('treemap');
    tourRender();
  });
});
// The tour's Escape lives at the END of the app-wide Escape chain above —
// not on a listener of its own, where the first review round showed it
// double-firing with every other meaning of the key.
// Settings promises a way back, so here it is: clear the flag and start over.
$('tourResetBtn').addEventListener('click', () => {
  void (async () => {
    try {
      await api('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tourDone: false }),
      });
      closeModal('settingsModal');
      tour.active = false; // restartable even in the session that finished it
      // A restart in a scanned session opens at "this is your disk as a map"
      // — so put the map on screen (QA finding 5: the card narrated a view
      // the user wasn't looking at).
      if (state.scanId && state.view !== 'treemap') switchView('treemap');
      tourMaybeStart(false);
    } catch (e) { toast('Could not reset the tour: ' + e.message, 'error'); }
  })();
});
/* ───────────── end §9.2 ───────────── */
$('budgetValue').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitBudget(); } });

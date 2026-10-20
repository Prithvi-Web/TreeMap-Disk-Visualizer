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
const tour = {
  active: false, step: 'welcome', wins: [], winIx: 0, added: [], unknownReason: '',
  // The boot restore has said whether this person has scanned before
  // (tourBootSettled); until it has, a start asked for at boot waits (`wanted`).
  booted: false, wanted: false,
  // Someone who has scanned before is never walked through step 1 again (the
  // owner, 17 Oct 2026): the start screen is their prompt, and the tour joins
  // them at the map when their next scan lands (the TOPIC.scan subscriber).
  deferred: false,
};

/** Start the tour unless it is done or running. `asked`: Settings › Show the
    welcome tour again — a person's request, which starts it whoever they are. */
function tourMaybeStart(done, { asked = false } = {}) {
  if (done === true || tour.active) return;
  if (!asked && !tour.booted) { tour.wanted = true; return; }
  if (!asked && !state.root && state.scannedBefore) { tour.deferred = true; return; }
  tour.deferred = false;
  tour.active = true;
  // Each run starts with nothing added, no wins and no reason (review F1.1):
  // Settings › Show the welcome tour again restarts it in the same session,
  // and the last run's adds are not this run's to talk about.
  tour.added = [];
  tour.wins = [];
  tour.winIx = 0;
  tour.unknownReason = '';
  // A first scan running when it starts — `?path=`, or a folder the desktop
  // shell handed over — is the scanning step; a scan on screen is the map.
  tour.step = state.scanning && !state.root ? 'scanning' : state.scanId ? 'map' : 'welcome';
  tourRender();
}

/** The boot restore has settled (240): a start the boot settings read asked
    for while it was out is decided now, knowing whether this person has
    scanned before. */
function tourBootSettled() {
  tour.booted = true;
  if (!tour.wanted) return;
  tour.wanted = false;
  tourMaybeStart(false);
}

async function tourFinish(message) {
  if (!tour.active) return;
  tour.active = false;
  // Finish, Skip and Escape all take the card away, and focus on its button
  // would fall to <body> with it (design pass G11). Focus that was elsewhere
  // is left where it is.
  const held = $('tourOverlay').contains(document.activeElement);
  $('tourOverlay').hidden = true;
  if (held) { const to = tourLanding(); if (to) to.focus({ preventScroll: true }); }
  if (message) toast(message);
  try {
    await api('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tourDone: true }),
    });
  } catch { /* a failed write means the tour offers itself again next launch — honest */ }
}

/** Where focus goes when the card closes holding it (G11): the start
    screen's control while it is up (startLanding), the map the card was
    describing, else the view's first control, else the view's own tab —
    never <body>. */
function tourLanding() {
  const shown = (el) => !!el && !el.disabled && el.getClientRects().length > 0;
  const start = startLanding();
  if (start) return start;
  const map = $('treemapCanvas');
  if (state.view === 'treemap' && shown(map)) return map;
  return activeViewControl() || document.querySelector('.tabbar button[aria-selected="true"]');
}

/** Paint the card for its step. `takeFocus` false repaints without moving
    focus: a change of view must not pull it from the view just opened. */
function tourRender(takeFocus = true) {
  if (!tour.active) return;
  const host = $('tourCard');
  $('tourOverlay').hidden = false;
  // "Skip the tour" lives in the card's header, apart from the step's own
  // actions: in the row it wrapped alone onto a second line, and sat beside
  // "Skip this one" (design pass G03). The closing steps offer only Finish.
  const head = (label, skippable = true) => `<div class="tour-head"><span class="tour-step">${label}</span>` +
    (skippable ? '<button class="tour-skip" data-tour-skip>Skip the tour</button>' : '') + '</div>';
  if (tour.step === 'welcome') {
    // The start screen behind the card already says what TreeMap does, offers
    // what to scan — the home folder among its choices — and holds the one
    // primary action, "Choose a folder…" (G03; the owner, 17 Oct 2026): the
    // card offers none of it again, and narrates. Where the start screen is
    // not on screen — Offloaded, Undo Vault, Autopilot, Fleet — the card is
    // the one prompt, so it offers the folder browser and the home folder
    // itself, neither one blue (review F1.2); a change of view repaints it
    // (tourFollowView).
    const home = state.system && state.system.homeDir;
    const heroBtn = $('emptyBrowseBtn');
    const pick = !(heroBtn && heroBtn.getClientRects().length > 0);
    const actions = pick ? '<button class="btn" data-tour-pick>Choose a folder</button>' +
      (home ? '<button class="btn" data-tour-home>Scan my home folder</button>' : '') : '';
    host.innerHTML = `
      ${head('Welcome · step 1 of 4')}
      <h4>${icon('treemap', 16)}Start with one folder</h4>
      <p>Pick a folder to look at first — scanning only reads it; nothing is moved or deleted.${home ? ' Your home folder is a good place to start.' : ''}</p>
      ${actions ? `<div class="tour-row">${actions}</div>` : ''}`;
    if (pick) host.querySelector('[data-tour-pick]').addEventListener('click', () => { openBrowse(null); });
    // The path box names the folder about to be read, as the folder browser's
    // "Scan this folder" sets it: the scanning card names it from there, and
    // an earlier pick that failed or was stopped is not it (review F2.2).
    if (pick && home) host.querySelector('[data-tour-home]').addEventListener('click', () => { $('pathInput').value = home; startScan(home); });
  } else if (tour.step === 'scanning') {
    // The click registered — say so. The old card kept offering "Scan my
    // home folder" for the whole scan, and a second press earned a red
    // "already running" toast within the first ten seconds.
    const name = state.root ? state.root.name : ($('pathInput').value.trim() || 'this folder');
    host.innerHTML = `
      ${head('Welcome · step 1 of 4')}
      <h4>${icon('loader', 16)}Reading your files…</h4>
      <p>TreeMap is measuring every file and folder in ${escapeHtml(name)}. The map appears the moment it finishes — a big folder can take a minute.</p>`;
  } else if (tour.step === 'map') {
    host.innerHTML = `
      ${head('The map · step 2 of 4')}
      <h4>${icon('treemap', 16)}This is your disk as a map</h4>
      <p>Every rectangle is a file or folder; bigger means more space. Click a folder to open it, one level at a time; press <kbd>Esc</kbd> to climb back up a level, and hover anything for the details.</p>
      <div class="tour-row"><button class="btn btn-primary" data-tour-wins>Show me what I could free</button></div>`;
    host.querySelector('[data-tour-wins]').addEventListener('click', () => { void tourLoadWins(); });
  } else if (tour.step === 'clean') {
    host.innerHTML = `
      ${head('All done', false)}
      <h4>${icon('checkCircle', 16)}This folder looks clean</h4>
      <p>TreeMap has nothing safe to suggest here — no caches, no rebuildable folders, no obvious junk. That is a good result, and the honest end of the tour.</p>
      <div class="tour-row"><button class="btn btn-primary" data-tour-done>Finish</button></div>`;
    host.querySelector('[data-tour-done]').addEventListener('click', () => { void tourFinish('Tour complete'); });
  } else if (tour.step === 'unknown') {
    // Not "clean" — "couldn't check". A blank good-news card over an error
    // would be exactly the confident wrongness this app exists to avoid.
    host.innerHTML = `
      ${head('One thing unchecked', false)}
      <h4>${icon('alert', 16)}Couldn&rsquo;t check for quick wins</h4>
      <p>${escapeHtml(tour.unknownReason || 'Suggestions are not available right now.')} The Clean Up view will have more to say once it can look.</p>
      <div class="tour-row"><button class="btn btn-primary" data-tour-done>Finish</button></div>`;
    host.querySelector('[data-tour-done]').addEventListener('click', () => { void tourFinish('Tour complete'); });
  } else if (tour.step === 'win') {
    const g = tour.wins[tour.winIx];
    const already = tourWinStaged(g);
    host.innerHTML = `
      ${head(`Quick win ${tour.winIx + 1} of ${tour.wins.length} · step 3 of 4`)}
      <h4>${icon('sparkles', 16)}${escapeHtml(g.title)} — ${formatBytes(g.totalSize)}</h4>
      <p>${tourWinLine(g)}</p>
      <div class="tour-row">
        <button class="btn btn-primary" data-tour-add ${already ? 'disabled' : ''}>${already ? 'Already in the cart' : 'Add to cart'}</button>
        <button class="btn" data-tour-next>Skip this one</button>
      </div>`;
    host.querySelector('[data-tour-add]').addEventListener('click', () => {
      // The one place the tour touches the cart — inside the user's click.
      // It remembers what it put there, for the last step to read (F1.1).
      const fresh = g.items.map((it) => it.path).filter((p) => p && !state.cart.has(p));
      cartAddMany(fresh);
      tour.added = [...tour.added, ...fresh.filter((p) => state.cart.has(p))];
      tourAdvanceWin();
    });
    host.querySelector('[data-tour-next]').addEventListener('click', tourAdvanceWin);
  } else if (tour.step === 'cart') {
    // What this run added, read against the cart as it is now (G04, review
    // F1.1). The cart is drawn only while it holds something, so with nothing
    // added there is no cart at the bottom to point at; and an item added here
    // may have left it since — taken out, or committed.
    const kept = tour.added.filter((p) => state.cart.has(p)).length;
    const where = !tour.added.length
      ? 'You added nothing — also fine. Anything you add later waits in a cleanup cart that appears at the bottom right once it holds something.'
      : kept === tour.added.length
        ? 'Everything you added is waiting in the cleanup cart at the bottom right.'
        : `${kept ? 'Some of what you added' : 'Everything you added'} has since left the cart. The cleanup cart shows at the bottom right whenever it holds something.`;
    host.innerHTML = `
      ${head('The cart · step 4 of 4', false)}
      <h4>${icon('cart', 16)}Staged — deleted only when you say so</h4>
      <p>${where}
        Committing the cart runs a preview first, protects files in the Undo Vault, and a run can be undone in one click until the Undo Vault removes its copies.</p>
      <div class="tour-row"><button class="btn btn-primary" data-tour-done>Finish</button></div>`;
    host.querySelector('[data-tour-done]').addEventListener('click', () => { void tourFinish('Tour complete — the map is yours'); });
  }
  const skip = host.querySelector('[data-tour-skip]');
  if (skip) skip.addEventListener('click', () => { void tourFinish('Tour skipped — reset it any time in Settings'); });
  // The card takes focus so keyboard users land on its primary action — but
  // never out of a text field. A scan completing repaints this card, and
  // yanking the caret from someone mid-word is how a coach becomes a pest.
  // On the welcome step the start screen's control takes focus while it is
  // up (startLanding: "Scan … again" just after a Stop, else "Choose a
  // folder…", the one primary, G03); otherwise the card's first action that
  // can take it — a disabled "Already in the cart" cannot, and
  // focus on the button it replaced would fall to <body>. Skip, which sits
  // apart in the header, only when the card has nothing else: the scanning
  // step, painted over the "Scan my home folder" that held focus (G11).
  // A field that is not on screen holds no caret: the first scan's switch to
  // the map hides the Dashboard's path box, and a browser moves focus off a
  // hidden field only at a later rendering step — to <body> (review F3.2).
  const active = document.activeElement;
  const typing = !!active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || '') && active.getClientRects().length > 0;
  const cta = tour.step === 'welcome' ? startLanding() : null;
  const primary = (cta && cta.getClientRects().length > 0 ? cta : null) || tourCardControl();
  if (primary && takeFocus && !typing) primary.focus();
  // Its height changed with its step: stand it clear of the controls again (J04). Guarded:
  // a page reader may lift this function without the placement.
  if (typeof tourPlaceSoon === 'function') tourPlaceSoon();
}

/** The card's own control that takes focus, or null while the card is down:
    its first enabled primary action, else its first enabled action, else
    Skip. A disabled "Already in the cart" cannot hold focus. */
function tourCardControl() {
  if (!tour.active || $('tourOverlay').hidden) return null;
  const host = $('tourCard');
  return host.querySelector('.btn-primary:not([disabled])') || host.querySelector('.tour-row button:not([disabled])') ||
    host.querySelector('[data-tour-skip]');
}

/** A change of view while the welcome card is up (review F1.2). The card
    offers the folder browser exactly while the welcome's own "Choose a
    folder" is off screen, so it is repainted when that changes — taking focus
    only when it held it, so focus on the button it replaces is not dropped. */
function tourFollowView() {
  if (typeof tourPlaceSoon === 'function') tourPlaceSoon(); // another view's controls are under it now (J04)
  if (!tour.active || tour.step !== 'welcome') return;
  const heroBtn = $('emptyBrowseBtn');
  const heroUp = !!heroBtn && heroBtn.getClientRects().length > 0;
  const offered = !!$('tourCard').querySelector('[data-tour-pick]');
  if (offered === !heroUp) return;
  tourRender($('tourCard').contains(document.activeElement));
}

/** Whether every item of a quick win is in the cart: its Add then has
    nothing to add, and says "Already in the cart". */
function tourWinStaged(g) {
  return g.items.every((it) => state.cart.has(it.path));
}

/** The cart changed — renderCart tells the tour (review F2.3, F3.1). Two
    steps read the cart: the last step's sentence, and a quick win's Add. The
    card stays up while the cart is used beside it — Clear, a removed item, a
    row's own cart button, a commit — so the step is repainted, taking focus
    only when the card held it (tourRender itself paints nothing once the tour
    is over). A quick win is repainted only when its Add has changed: a
    repaint hands focus held on the card to its primary action, and one that
    changes nothing would move focus off "Skip the tour" for no reason. */
function tourCartChanged() {
  if (tour.step === 'win') {
    const offered = !!$('tourCard').querySelector('[data-tour-add]:not([disabled])');
    if (offered !== tourWinStaged(tour.wins[tour.winIx])) return;
  } else if (tour.step !== 'cart') return;
  tourRender($('tourCard').contains(document.activeElement));
}

/** How many of a quick win's items its card names; the rest are counted. */
const TOUR_WIN_ITEMS = 3;

/** The most items the server lists for one rule (ITEMS_PER_RULE in
    src/services/cleanupRules.ts; tests/firstRun.test.ts holds them equal).
    A shorter list holds every match; one this long may have been cut, and
    the group's total counts every match, listed or not. */
const SUGGESTION_ITEMS_LISTED = 200;

/** A quick win's words: the rule's own description, ended as a sentence (QA
    D06: the descriptions carry no full stop), then what it found — each item's
    name, the folder it is in and its size (design pass G04). The rule's matcher
    wording ("A folder named .next; or a folder named dist sitting next to
    package.json, next.config.*…") is for the Clean Up view, not the tour. The
    server lists at most SUGGESTION_ITEMS_LISTED items a rule, so the rest are
    counted only when the list is shorter than that. Listed sizes adding up to
    the group's total prove nothing: a rule for .DS_Store and Thumbs.db
    matches empty files, and those past the cap add nothing (review F1.4). */
function tourWinLine(g) {
  const desc = String(g.description || '').trim();
  const sentence = desc && !/[.!?…]$/.test(desc) ? desc + '.' : desc;
  const items = Array.isArray(g.items) ? g.items : [];
  if (!items.length) return escapeHtml(sentence);
  const rows = items.slice(0, TOUR_WIN_ITEMS).map((it) => {
    const parts = String(it.path || '').split(/[\\/]/).filter(Boolean);
    const folder = parts.length > 1 ? parts[parts.length - 2] : '';
    return `<span class="tour-item"><b>${escapeHtml(it.name)}</b>` +
      (folder ? ` <span class="muted">in ${escapeHtml(folder)}</span>` : '') +
      ` <span class="num">${formatBytes(it.size)}</span></span>`;
  });
  const rest = items.length - rows.length;
  const listedAll = items.length < SUGGESTION_ITEMS_LISTED;
  if (rest > 0) rows.push(`<span class="tour-item muted">${listedAll ? `and ${formatCount(rest)} more` : 'and more'}</span>`);
  return `${escapeHtml(sentence)}<span class="tour-items">${rows.join('')}</span>`;
}

function tourAdvanceWin() {
  if (tour.winIx + 1 < tour.wins.length) {
    tour.winIx += 1;
  } else {
    tour.step = 'cart';
  }
  tourRender();
}

/* The OS refused a folder: name the OS that did, once, for both first-run cards. */
function refusedFolderWords() {
  return platformWord({
    darwin: 'macOS would not let TreeMap look inside this folder',
    win32: 'Windows would not let TreeMap look inside this folder',
    other: 'TreeMap was not allowed to look inside this folder',
  });
}

/* ── Where the card stands (seventh browser pass, J04) ──
   The card floats over the view at one place — 18 px from the right, 86 px up
   — and a view's controls are wherever the view puts them: at 1024 × 700 its
   top lay over the Dashboard's Browse… and Scan. After each paint of the card,
   a resize, a scroll or a change of view, it stands at the place nearest its
   rest that covers no control on screen beside it — just above or just below
   the controls in its way — as --tour-b, its offset from the window's bottom,
   which the stylesheet reads. Never lower than its rest: the window's
   bottom-right corner is the cart pill's and the toasts'. Where nothing is in
   the way, or nowhere is clear (a column full of controls), it rests. A
   canvas is the view's surface, not a control: over the map the card rests. */
const TOUR_REST_BOTTOM = 86; // --tour-b at rest (080-suggestions-reclaim.css)
const TOUR_GAP = 12; // between the card and the control it stands clear of
const TOUR_EDGE = 8; // the least room kept between it and the window's top
const TOUR_CONTROLS = '.view.active button, .view.active input, .view.active select, .view.active textarea, .view.active summary, .view.active [tabindex="0"], #emptyState button';

function tourPlace() {
  if (!tour.active || $('tourOverlay').hidden) return;
  const card = $('tourCard').getBoundingClientRect();
  const H = window.innerHeight;
  const h = card.height;
  const inWay = [...document.querySelectorAll(TOUR_CONTROLS)]
    .filter((el) => el.tagName !== 'CANVAS' && el.getClientRects().length > 0)
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.right > card.left && r.left < card.right && r.bottom > r.top);
  const clear = (b) => b >= TOUR_REST_BOTTOM && H - b - h >= TOUR_EDGE && !inWay.some((r) => r.top < H - b && r.bottom > H - b - h);
  const places = [TOUR_REST_BOTTOM, ...inWay.flatMap((r) => [H - r.top + TOUR_GAP, H - r.bottom - TOUR_GAP - h])].map(Math.round);
  const best = places.filter(clear).sort((a, b) => Math.abs(a - TOUR_REST_BOTTOM) - Math.abs(b - TOUR_REST_BOTTOM))[0];
  if (best === undefined || best === TOUR_REST_BOTTOM) document.body.style.removeProperty('--tour-b');
  else document.body.style.setProperty('--tour-b', best + 'px');
}

/** tourPlace at the next frame, once however often it is asked for in one. */
let tourPlaceRaf = 0;
function tourPlaceSoon() {
  if (!tour.active || tourPlaceRaf) return;
  tourPlaceRaf = requestAnimationFrame(() => { tourPlaceRaf = 0; tourPlace(); });
}
window.addEventListener('resize', tourPlaceSoon);
document.addEventListener('scroll', tourPlaceSoon, { capture: true, passive: true });

async function tourLoadWins() {
  if (!state.scanId) return;
  // A fourth non-answer, and the loudest: the folder was never read. On a Mac
  // without Full Disk Access a scan of Desktop or Documents returns nothing,
  // and on Windows a folder another account owns does the same,
  // and congratulating someone on a folder the OS would not open is the
  // worst thing the first run can say. The refused probe has already looked
  // by the time the tour asks.
  if (state.scanRefused && state.scanRefused.dirs) {
    tour.step = 'unknown';
    tour.unknownReason = state.scanRefused.root
      ? refusedFolderWords() + ', so nothing here has been checked.'
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
    tour.step = 'unknown';
    tour.unknownReason = r.root
      ? refusedFolderWords() + ', so nothing here has been checked.'
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
/** The scan failed, or was stopped, before it landed: the welcome card and its buttons come back (review F2.2). */
function tourScanFailed() {
  if (tour.active && tour.step === 'scanning') { tour.step = 'welcome'; tourRender(); }
}

// A scan landing while the welcome card is up means the user took the step —
// move with them. Any later scans leave the tour where it is. A tour held
// back for someone who has scanned before starts here, at the map.
subscribe(TOPIC.scan, () => {
  if (tour.deferred && !tour.active) {
    tour.deferred = false;
    tour.active = true;
    tour.added = [];
    tour.wins = [];
    tour.winIx = 0;
    tour.unknownReason = '';
    tour.step = 'scanning'; // moved to the map, and painted there, just below
  }
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
      tourMaybeStart(false, { asked: true });
    } catch (e) { toast('Could not reset the tour: ' + e.message, 'error'); }
  })();
});
/* ───────────── end §9.2 ───────────── */
$('budgetValue').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitBudget(); } });

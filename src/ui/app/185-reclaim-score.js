/* ══════════════════ Phase 3 (v4 §3) — the Reclaim Score ══════════════════
 *
 * "What is biggest" is the question every view already answers. This is the
 * one people actually have: what is safest to delete. The server computes it
 * from six signals and hands back the full reasoning; everything here is the
 * join and the presentation.
 *
 * ── Why the scores live in a side map and not on the nodes ──
 *
 * §2.1 holds the scan responses to byte-identity against a recorded baseline,
 * so nothing may be added to them — not even an optional field. Scores arrive
 * through POST /api/facts keyed by path and are joined here. Grafting them
 * onto tree nodes would work and would be the obvious thing to do; it would
 * also mean the next person to serialise a subtree ships a field that breaks
 * tests/goldenResponses.test.ts for reasons no error message will explain.
 *
 * ── Three states, kept apart ──
 *
 *   not asked   — absent from `scores`. The UI shows nothing.
 *   asked, none — `null`. The server could not score this path, and the UI
 *                 says so in words rather than showing a zero.
 *   scored      — the fact, with its components, its `missing` list and a
 *                 confidence band.
 *
 * Collapsing the middle state into a zero is the mistake the whole phase is
 * built to avoid, so it is representable here too.
 */
const RECLAIM_BATCH = 2000; // MAX_FACT_PATHS in src/api/factRoutes.ts

const reclaim = {
  /** path → fact | null. null means asked and unanswerable, never zero. */
  scores: new Map(),
  /** In flight, so two hovers over the same cell make one request. */
  pending: new Set(),
  /**
   * Paths whose request failed, not asked about again until the scan, the
   * view or the folder on screen changes (failedFor): a request that fails
   * every time was re-sent on every repaint, one after another, for as long
   * as the map was open. Shown as "could not be scored", never as loading.
   */
  failed: new Set(),
  /** The scope the failed set belongs to (reclaimFailureScope). */
  failedFor: '',
  /** The weights in force, for the breakdown's footer. Loaded with settings. */
  weights: null,
};

/** Forget everything: a new scan means every score describes a stale tree. */
function reclaimReset() {
  reclaim.scores.clear();
  reclaim.pending.clear();
  reclaim.failed.clear();
}

/** What a failed request is remembered for: this scan, this view, this folder on screen. */
function reclaimFailureScope() {
  return `${state.scanId}\n${state.view}\n${(state.treemap && state.treemap.rootPath) || ''}`;
}

/**
 * Could the fact route answer for this path at all? A cloud:// or in-archive
 * path is a listing, not a file on this disk, and a NUL is no path — the
 * synthetic Trash cell's is "\0trash" — and the route refuses any of them
 * for the whole batch it rides in, so they are never sent.
 */
function reclaimAskablePath(p) {
  return !!p && typeof p === 'string' && !p.startsWith('cloud://') && !p.includes('!/') && !p.includes('\0');
}

/**
 * Is this drawn cell a file or folder on disk the score is about? Not the
 * Trash cell, not a freed block (§4.3: a hypothetical, not a path), not an
 * entry inside an archive. The map asks about exactly these, and its legend
 * counts exactly these, so neither can disagree with the other.
 */
function reclaimAskableNode(n) {
  return !!n && !n.isTrash && !n.freed && !n.virtual && reclaimAskablePath(n.path);
}

/**
 * The fact route's refusals of a path (the path guard, the sanitizer): one
 * such path in a batch refuses the whole batch — a folder the server will not
 * look at, such as /private/var/db on a scan of /, by the same rule the
 * destructive routes keep — so a batch refused this way is halved and asked
 * again until only the refused paths are left without a score.
 */
const RECLAIM_PATH_REFUSALS = new Set(['PATH_BLOCKED', 'PATH_INVALID', 'VIRTUAL_PATH', 'CLOUD_PATH', 'OUTSIDE_SCAN_ROOT']);
subscribe(TOPIC.scan, reclaimReset);
// §4.3 — a new scan replaces the very tree the preview was laid out from, so
// the saved "restore me" node list is stale too. Dropped silently: the map is
// about to be redrawn from the new scan anyway.
subscribe(TOPIC.scan, () => exitCartPreview(true));

/** The fact for a path, or undefined when it has not been asked for. */
function scoreFor(path) {
  const hit = reclaim.scores.get(path);
  return hit === null ? undefined : hit;
}

/** True once this path has been asked about, whatever the answer was. */
function scoreKnown(path) { return reclaim.scores.has(path); }

/**
 * Fetch scores for these paths, skipping anything already known or in flight.
 *
 * Resolves when every batch has landed. Callers that only want to repaint
 * pass a callback rather than awaiting, because the common case — a hover —
 * must not hold anything up.
 *
 * **`onLanded` fires only when new scores actually arrived**, and that is a
 * contract rather than an optimisation. The treemap's callback repaints, and
 * a repaint re-asks for the scores of whatever it just drew; if this fired on
 * a request where everything was already cached, the two would call each
 * other forever. "Nothing was fetched" and "nothing changed" are the same
 * statement, so the callback has nothing to say. **A failed request is not
 * scores landing either**: it fired `onLanded` once, and a request that
 * fails every time — the Trash cell's NUL refused the whole batch — was
 * re-sent on every repaint for as long as the map was open (QA-6 review).
 * Failed paths are remembered (`reclaim.failed`) and not asked about again
 * in this scan, view and folder; `onFailed`, if given, is told instead, so
 * a legend can say they could not be scored.
 *
 * **A chain can be called off** (QA-6 review MEDIUM-2): drilling quickly in
 * the Reclaim colour mode left every folder's chain running — up to three
 * 2,000-path batches each, every path a subprocess-backed scoring, in the
 * same strict lane as the map's own loads and deletes. `signal` cancels the
 * request in flight and every batch after it; `isCurrent` is asked between
 * batches, so a chain whose map has gone stops even before anything new
 * asks. A chain called off either way calls neither callback, and an abort
 * releases its paths from `pending` AT ONCE — the chain replacing it asks
 * right after, and would otherwise skip every path still marked in flight
 * by a request that will never answer for it.
 */
async function ensureScores(paths, onLanded, onFailed, { signal = null, isCurrent = null } = {}) {
  if (!state.scanId || (signal && signal.aborted)) return;
  const scope = reclaimFailureScope();
  if (reclaim.failedFor !== scope) {
    reclaim.failed.clear();
    reclaim.failedFor = scope;
  }
  const wanted = [];
  const seen = new Set();
  for (const p of paths) {
    if (!reclaimAskablePath(p)) continue;
    if (reclaim.scores.has(p) || reclaim.pending.has(p) || reclaim.failed.has(p) || seen.has(p)) continue;
    seen.add(p);
    wanted.push(p);
  }
  if (!wanted.length) return; // nothing fetched, so nothing changed — see above
  for (const p of wanted) reclaim.pending.add(p);
  const release = () => { for (const p of wanted) reclaim.pending.delete(p); };
  if (signal) signal.addEventListener('abort', release, { once: true });

  const scanAtRequest = state.scanId;
  const outcome = { landed: false, failed: false };
  try {
    for (let i = 0; i < wanted.length; i += RECLAIM_BATCH) {
      await reclaimScoreBatch(wanted.slice(i, i + RECLAIM_BATCH), scanAtRequest, scope, outcome, signal);
      // A scan that changed under a request in flight would otherwise file
      // the previous tree's verdicts against the new one's paths.
      if (state.scanId !== scanAtRequest) return;
      // Called off, or its map is gone: no more batches, and no callbacks.
      if ((signal && signal.aborted) || (isCurrent && !isCurrent())) return;
    }
  } finally {
    if (signal) signal.removeEventListener('abort', release);
    // Released by the abort already; the paths may be a newer chain's by now.
    if (!(signal && signal.aborted)) release();
  }
  if (outcome.landed) {
    if (onLanded) onLanded();
  } else if (outcome.failed && onFailed) {
    onFailed();
  }
}

/**
 * Asks for one batch and files the answer: a score, or null for a path the
 * server could not score. A failure is this batch's alone — the scores
 * earlier batches landed stay — and its paths are remembered as failed. A
 * batch refused for one of its paths (RECLAIM_PATH_REFUSALS) is halved and
 * each half asked again, so only the refused paths go without a score: at
 * most two requests per halving for each refused path. `outcome` records
 * whether anything landed and whether anything failed.
 */
async function reclaimScoreBatch(batch, scanAtRequest, scope, outcome, signal = null) {
  let res;
  try {
    res = await api('/api/facts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanId: scanAtRequest, paths: batch, providers: ['reclaimScore'] }),
      // The fact route stops scoring when the request closes, so this frees the server too.
      signal: signal || undefined,
    });
  } catch (err) {
    // Called off (ensureScores): not a failure, and nothing to remember.
    if (err && err.name === 'AbortError') return;
    if (state.scanId !== scanAtRequest) return;
    if (err && RECLAIM_PATH_REFUSALS.has(err.code) && batch.length > 1) {
      const half = Math.ceil(batch.length / 2);
      await reclaimScoreBatch(batch.slice(0, half), scanAtRequest, scope, outcome, signal);
      if (signal && signal.aborted) return;
      await reclaimScoreBatch(batch.slice(half), scanAtRequest, scope, outcome, signal);
      return;
    }
    // A score is an enrichment, never a blocker: the badge does not appear,
    // every surface renders without it, and the legend says these could not
    // be scored. Remembered only for the scope it was asked in.
    if (reclaim.failedFor === scope) for (const p of batch) reclaim.failed.add(p);
    outcome.failed = true;
    if (window.TREEMAP_DEBUG) console.warn('[treemap] reclaim scores failed:', err);
    return;
  }
  if (state.scanId !== scanAtRequest) return;
  const provider = (res.providers && res.providers.reclaimScore) || null;
  const values = (provider && provider.available && provider.values) || {};
  for (const p of batch) {
    // Absent from `values` is the server saying it could not score this.
    // Recorded as null so we neither ask again in a loop nor invent a 0.
    reclaim.scores.set(p, Object.prototype.hasOwnProperty.call(values, p) ? values[p] : null);
  }
  outcome.landed = true;
}

/** "high" / "medium" / "low" as a phrase a person can act on. */
function reclaimConfidenceWording(fact) {
  const measured = Math.round((fact.coverage || 0) * 100);
  if (fact.confidence === 'high') return `high — ${measured}% of this score was actually measured`;
  if (fact.confidence === 'medium') return `medium — only ${measured}% of this score was measured`;
  return `low — only ${measured}% of this score was measured, so treat it as a hint`;
}

/**
 * The badge. Always a button, never a bare number (§3.2).
 *
 * `path` is carried on the element rather than closed over so the same markup
 * works inside an innerHTML write, which is how every list in this file is
 * built.
 */
function reclaimBadge(path, fact) {
  if (!fact) return '';
  const colour = reclaimInk(fact.score);
  // A tilde, not a letter.
  //
  // The first version suffixed the confidence initial — "66.4M", "43.3H" —
  // and in a disk tool that reads as 66.4 megabytes. Every other number on
  // the same row is a byte count, so a letter glued to this one is not a
  // subtle ambiguity, it is the wrong reading by default. A leading "~" says
  // "approximately" and cannot be mistaken for a unit.
  const approx = fact.confidence === 'high' ? '' : '~';
  const conf = `${fact.confidence} confidence`;
  return `<button type="button" class="rc-badge conf-${escapeHtml(fact.confidence)}" style="color:${colour}"
    data-rc-why="${escapeHtml(path)}"
    aria-label="Reclaim score ${fact.score} out of 100, ${escapeHtml(conf)}. Show what it is made of."
    title="Reclaim score ${fact.score}/100 — ${escapeHtml(conf)}. Click for the breakdown."
    >${approx}${fact.score}</button>`;
}

/**
 * The breakdown, in the same shape as Smart Suggestions' "why is this
 * suggested" panel — §3.2 asks for that reuse by name.
 *
 * Components that answered come first with what each contributed, then the
 * ones that could not, then the confidence and the weights footer. The
 * missing block is not an afterthought: it is the difference between a score
 * that means something and one that merely looks like it does.
 */
function reclaimWhyHtml(fact) {
  const rows = fact.components.map((c) => `
    <div class="rc-why-row">
      <span class="rc-k">${escapeHtml(c.label)}</span>
      <span class="rc-v">${escapeHtml(c.why)}</span>
      <span class="rc-n">+${c.contribution.toFixed(1)}</span>
    </div>`).join('');
  const missing = fact.missing.length ? `<hr>` + fact.missing.map((m) => `
    <div class="rc-why-row rc-missing">
      <span class="rc-k">${escapeHtml(labelForComponent(m.id))}</span>
      <span class="rc-v">${escapeHtml(m.reason)}</span>
      <span class="rc-n">not counted</span>
    </div>`).join('') : '';
  return `<div class="rc-why">
    ${rows}${missing}
    <hr>
    <div class="rc-why-row"><span class="rc-k">Confidence</span><span class="rc-v">${escapeHtml(reclaimConfidenceWording(fact))}</span></div>
    <div class="rc-foot">A missing signal is left out of the score, never counted as zero — that is why the confidence moves.
      Change what counts, and by how much, in Settings → Reclaim Score. This ranks and explains; it never selects anything for deletion.</div>
  </div>`;
}

/** Labels for components that did not answer, and so carry no label of their own. */
const RC_LABELS = {
  size: 'Size',
  staleness: 'How long since it was used',
  regenerable: 'Rebuilds itself',
  redundant: 'Another copy on this disk',
  redownloadable: 'Came from somewhere',
  elsewhere: 'A copy exists elsewhere',
};
function labelForComponent(id) { return RC_LABELS[id] || id; }

/** Short names for the radar's rim, where a full label would not fit. */
const RC_SHORT = {
  size: 'Size',
  staleness: 'Unused',
  regenerable: 'Rebuilds',
  redundant: 'Duplicate',
  redownloadable: 'Re-gettable',
  elsewhere: 'Backed up',
};

/**
 * The six signals as radar axes, in one fixed order.
 *
 * Order is a constant, not the order the server happened to answer in: the
 * shape is only comparable between two files if the axes never move. A signal
 * that could not answer carries `value: null` — the radar draws its spoke and
 * leaves it un-plotted, which is the same promise the rows below make in
 * words ("not counted"), kept in geometry.
 */
const RC_AXIS_ORDER = ['size', 'staleness', 'regenerable', 'redundant', 'redownloadable', 'elsewhere'];

function reclaimRadarAxes(fact) {
  const answered = new Map((fact.components || []).map((c) => [c.id, c]));
  const missing = new Map((fact.missing || []).map((m) => [m.id, m]));
  return RC_AXIS_ORDER.map((id) => {
    const c = answered.get(id);
    return {
      label: labelForComponent(id),
      short: RC_SHORT[id] || id,
      value: c ? c.value : null,
      detail: c ? c.why : (missing.get(id) || {}).reason || 'not measured',
    };
  });
}

/* ── the popover ── */

let rcPopoverPath = null;
let rcPopoverOpener = null;
/** The sheet on top when the breakdown opened, null over the page. A sheet on
    top that is not this one opened after the breakdown (review F3.1). */
let rcPopoverOver = null;
/** The radar's handle. One panel, one chart — every open pairs with a drop. */
let rcRadarHandle = null;
function rcRadarDrop() {
  if (!rcRadarHandle) return;
  try { rcRadarHandle.destroy(); } catch { /* already gone */ }
  rcRadarHandle = null;
}

/**
 * Open the breakdown for one path.
 *
 * Anchored to the element that opened it where there is one, and to a point
 * otherwise — the treemap's cells are canvas pixels, not elements, so the
 * right-click menu passes the coordinates it was opened at, and `returnTo`:
 * what had focus when the menu opened, which focus goes back to on close —
 * a Grid tile has no score badge to be found again by (QA fourth pass E05).
 */
function openReclaimWhy(path, anchorEl, point, returnTo = null) {
  const fact = scoreFor(path);
  const pop = $('rcPopover');
  if (!fact) {
    // Asked and unanswerable: say which, rather than opening an empty panel.
    toast(scoreKnown(path)
      ? 'TreeMap could not score this — none of the six signals could be read for it.'
      : 'That score has not been worked out yet.', 'success', 5000);
    return;
  }
  rcPopoverPath = path;
  rcPopoverOpener = anchorEl || returnTo || null;
  rcPopoverOver = topModal();
  // Everything scrolls inside .rc-pop-scroll, never the panel, whose opaque
  // fill and ring would scroll away with the rows (POL item 3). The close
  // button is inside it too, so the keys that scroll still scroll it.
  pop.innerHTML = `
    <div class="rc-pop-scroll">
    <div class="rc-pop-head">
      <span class="rc-badge conf-${escapeHtml(fact.confidence)}" style="color:${reclaimInk(fact.score)}" aria-hidden="true">${fact.confidence === 'high' ? '' : '~'}${fact.score}</span>
      <b id="rcPopTitle" title="${escapeHtml(path)}">${escapeHtml(path.split(/[\\/]/).filter(Boolean).pop() || path)}</b>
      <div style="flex:1"></div>
      <button class="icon-btn" id="rcPopClose" aria-label="Close the score breakdown">${icon('x', 14)}</button>
    </div>
    <div class="rc-radar-wrap"><canvas id="rcRadar" width="280" height="200" role="img"></canvas></div>
    ${reclaimWhyHtml(fact)}
    </div>`;
  pop.hidden = false;

  /* The same six signals the rows spell out, read as one shape. Mounted after
     the panel is in the DOM (the kit measures its host) and torn down with it. */
  rcRadarDrop();
  try {
    const measured = (fact.components || []).length;
    rcRadarHandle = FxCharts.radar($('rcRadar'), {
      axes: reclaimRadarAxes(fact),
      size: 200,
      ariaLabel: `Reclaim score ${fact.score} of 100 — ${measured} of ${RC_AXIS_ORDER.length} signals measured. `
        + reclaimRadarAxes(fact).map((a) => a.label + ': '
          + (a.value === null ? 'not measured' : Math.round(a.value * 100) + '%')).join('. '),
    });
  } catch { /* the rows below are the score; the shape is the read on it */ }

  // Positioned after it is measurable: flipped above the anchor when it will
  // not fit below, and then CLAMPED into the viewport on both axes.
  //
  // The clamp is not belt-and-braces. `position: fixed` coordinates are
  // viewport-relative, while the anchor's rect is wherever that row happens
  // to be — and a row below the fold has a `top` larger than the window. In a
  // narrow window this put the panel at y=2227 in an 820px viewport: opened,
  // populated, focused, and completely invisible.
  const r = anchorEl ? anchorEl.getBoundingClientRect()
    : point ? { left: point.x, top: point.y, bottom: point.y }
    : { left: window.innerWidth / 2, top: 120, bottom: 120 };
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const maxTop = Math.max(10, window.innerHeight - h - 10);
  const preferred = r.bottom + 8 + h > window.innerHeight - 10 ? r.top - h - 8 : r.bottom + 8;
  pop.style.left = Math.max(10, Math.min(r.left, window.innerWidth - w - 10)) + 'px';
  pop.style.top = Math.max(10, Math.min(preferred, maxTop)) + 'px';

  $('rcPopClose').addEventListener('click', closeReclaimWhy);
  $('rcPopClose').focus();
}

function closeReclaimWhy() {
  const pop = $('rcPopover');
  if (pop.hidden) return;
  const path = rcPopoverPath;
  const opener = rcPopoverOpener;
  rcRadarDrop(); // before the innerHTML wipe takes its canvas out from under it
  pop.hidden = true;
  pop.innerHTML = '';
  rcPopoverPath = null;
  rcPopoverOpener = null;
  rcFocusBack(opener, path);
  // A sheet opened after the breakdown made the page behind it inert, and an
  // inert opener refuses focus, which then drops to <body> under the sheet:
  // the sheet takes it instead (review F3.1).
  const top = topModal();
  if (top && !top.contains(document.activeElement)) modalFocusInto(top);
}

function rcFocusBack(opener, path) {
  // Focus goes back where it came from, or it lands on <body> and a keyboard
  // user loses their place in the list they were reading.
  //
  // The element cannot simply be held onto: every list carrying these badges
  // is rebuilt by innerHTML when the scores land, so by the time the panel
  // closes the button that opened it has usually been replaced by an
  // identical one. Holding the reference silently dropped focus to <body>.
  // The path is stable across those repaints, so the badge is re-found.
  //
  // <body> is where focus was, never where it came from: a right-click on a
  // row that is no Tab stop leaves it there, and the menu hands that on.
  // Taken for the opener, it was "focused" — a no-op — and the row's badge
  // was never looked for (review F1.1 of QA fourth pass E05).
  if (opener && opener !== document.body && document.contains(opener)) { opener.focus(); return; }
  // A Grid tile the menu was opened from, rebuilt since: the tile now
  // standing for that file takes it (QA fourth pass E05).
  const standIn = opener ? gridFocusStandIn(opener) : null;
  if (standIn) { standIn.focus(); return; }
  if (!path) return;
  const escaped = window.CSS && CSS.escape ? CSS.escape(path) : path.replace(/["\\]/g, '\\$&');
  const replacement = document.querySelector(`[data-rc-why="${escaped}"]`);
  if (replacement) replacement.focus();
}

// One delegated listener for every badge in the app, present and future —
// each list is rebuilt by innerHTML, and per-row listeners would be re-bound
// on every repaint.
document.addEventListener('click', (e) => {
  const badge = e.target.closest('[data-rc-why]');
  if (badge) {
    e.preventDefault();
    e.stopPropagation();
    openReclaimWhy(badge.dataset.rcWhy, badge);
    return;
  }
  // The right-click menu's "Why this reclaim score?" is the click that asked
  // for the panel, not a click outside it. A person's click runs that entry's
  // listener, then the microtasks — which open the panel at once when the
  // score is already loaded — and only then bubbles here: without this the
  // one click opened the panel and closed it again (B09). Kept only when the
  // panel shows the cell the menu was opened on; one still showing another
  // cell (this one's score is on its way) closes, as any outside click does.
  if (e.target.closest('#ctxMenu [data-act="score"]') && ctxTarget && rcPopoverPath === ctxTarget.path) return;
  if (!$('rcPopover').hidden && !e.target.closest('#rcPopover')) closeReclaimWhy();
});
/* Escape closes the layer the keyboard is in, the latest first. The
   breakdown paints above every sheet, but a sheet opened after it — `?` over
   a breakdown opened from a page row — takes focus (the net in 235, review
   F2.3), so that sheet is what Escape means: it closes and hands focus back
   to the breakdown, whose Escape is the next one. Until review F3.1 this
   listener, in the capture phase, took every Escape while the breakdown
   showed and stopped it before the sheet's handler saw it. The breakdown
   keeps the key when no sheet is up, when it opened over the top sheet, or
   when it holds focus itself. */
function rcPopoverOwnsEscape() {
  const top = topModal();
  return !top || top === rcPopoverOver || inModalOverlay(document.activeElement);
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('rcPopover').hidden && rcPopoverOwnsEscape()) { e.stopPropagation(); closeReclaimWhy(); }
}, true);

/* ── sorting ──
 *
 * A path with no score sorts last rather than as zero. Sorting unknowns to
 * the bottom of a "safest to delete" list is the only honest placement: the
 * top of that list is a recommendation, and nothing TreeMap has not assessed
 * belongs there.
 */
function byReclaimDesc(pathOf) {
  return (a, b) => {
    const fa = scoreFor(pathOf(a));
    const fb = scoreFor(pathOf(b));
    if (fa && fb) return fb.score - fa.score || (b.size || 0) - (a.size || 0);
    if (fa) return -1;
    if (fb) return 1;
    return (b.size || 0) - (a.size || 0);
  };
}

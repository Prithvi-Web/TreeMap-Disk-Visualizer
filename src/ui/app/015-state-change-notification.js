/* ─────────────── State change notification (§3.4) ───────────────
   One app state object with explicit subscribe/notify. Views read from it and
   subscribe to it; a view never reaches into another view's state or calls
   another view's render function directly. That rule is what stops the "grid
   nudges the treemap which re-enters the grid" tangles that make a single-file
   UI unmaintainable.

   `emit` is deliberately synchronous and exception-isolated: a listener that
   throws must not stop the others from being told, or one broken panel silently
   freezes the rest of the app (§6, failure isolation).                     */
const stateListeners = new Map(); // topic -> Set<fn>

/** Subscribe to a topic. Returns an unsubscribe function. */
function subscribe(topic, fn) {
  if (!stateListeners.has(topic)) stateListeners.set(topic, new Set());
  stateListeners.get(topic).add(fn);
  return () => { const set = stateListeners.get(topic); if (set) set.delete(fn); };
}

/** Tell every subscriber of `topic`. Never throws. */
function emit(topic, payload) {
  const set = stateListeners.get(topic);
  if (!set) return;
  for (const fn of [...set]) {
    try { fn(payload, state); }
    catch (err) { console.error('[treemap] listener for "' + topic + '" failed:', err); }
  }
}

/** Topics the app publishes. Listed here so subscribers can't invent typos. */
const TOPIC = {
  scan: 'scan',                 // a new scan completed, or was cleared
  path: 'path',                 // the current drill-in path changed
  selection: 'selection',       // the multi-select set changed
  capabilities: 'capabilities', // platform capabilities arrived or were refreshed
};

/**
 * Index whatever tree we hold. The server prunes it to a node budget, so this
 * is a partial index of a big scan, not a complete one: a path missing from it
 * means "not shipped", NOT "not on disk". Use nodeFor()/ensureNodes() rather
 * than reading pathIndex directly when a miss would change what the user sees.
 */
function indexTree(root) {
  state.pathIndex.clear();
  state.nodeCache.clear(); // resolved against the previous scan; nothing carries over
  // Same reasoning for A2 allocation: shared/exclusive bytes are relative to
  // what was in scope at the time, and a file that lost its twin since the last
  // scan would otherwise keep reporting "deleting this frees nothing".
  allocationCache.clear();
  hsFacts.clear(); // §9.3 — equivalents describe a scan's tree, like allocation
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    state.pathIndex.set(n.path, n);
    if (n.children) for (const c of n.children) stack.push(c);
  }
  if (typeof renderCart === 'function') renderCart(); // refresh staged-item sizes against the new tree
}

/** The node for `path`, from the tree we hold or from what we've resolved. */
function nodeFor(p) {
  return state.pathIndex.get(p) || state.nodeCache.get(p) || null;
}

/**
 * Splice a fetched subtree into the tree we hold and index it, so later lookups
 * resolve from memory. The fetched copy wins over anything we'd resolved
 * piecemeal: it's the same server tree, but with structure attached.
 */
function graftSubtree(sub) {
  const existing = state.pathIndex.get(sub.path);
  if (existing) {
    existing.children = sub.children;
    if (sub.pruned) existing.pruned = true; else delete existing.pruned;
  }
  const target = existing || sub;
  const stack = [target];
  while (stack.length) {
    const n = stack.pop();
    state.pathIndex.set(n.path, n);
    state.nodeCache.delete(n.path); // the tree outranks a standalone resolved copy
    if (n.children) for (const c of n.children) stack.push(c);
  }
  return target;
}

/**
 * The scan the tree on screen came from: what every request about that tree
 * names — a subtree, the map, a score, a fact, a query, a view's report — and
 * what an answer is checked against before it is kept. One rule, here, so no
 * view keeps a copy of its own (BQJ-1b; three review rounds each found more).
 *
 * While a scan runs, its id is on hand once its request answers
 * (followScanProgress), but the tree on screen is still the one before it: an
 * older scan's (settledScanId), or the saved index's (none — nothing is asked
 * of it). A scan still walking answers nothing about a tree: 202, 409
 * SCAN_RUNNING, or every path "unavailable" (review F1.5, F2.2). Once it lands
 * (finishScan) or is stopped (stopScan, failScan) the scan on hand is the
 * tree's own again.
 */
function treeScanId() {
  return state.scanning ? state.settledScanId : state.scanId;
}

/**
 * Whether a scan of the tree on screen is coming, for a tree no scan stands
 * behind yet — the saved index's: the scan an index paint is due
 * (indexScanDue: set by the paint, which returns before its scan is
 * requested, and held until the scan chrome ends, review F3.1), or a running
 * scan of that folder (startScan names it first, scanningPath) — a rescan
 * pressed over it, the index still being asked about. A scan of another
 * folder is none: it replaces the tree rather than standing behind it, and
 * "scan this folder" stays true of it (BQJ-1b). What a view says there in
 * place of what it would ask the tree's scan: that it fills in once the scan
 * finishes while one is coming, and that the tree is the saved index once
 * nothing will land (a Stop, a failure).
 */
function treeScanComing() {
  return !!state.indexScanDue || (!!state.scanning && !!state.root && state.scanningPath === state.root.path);
}

/**
 * Make sure we hold the children of `path`, fetching them if the server pruned
 * this branch. Views that lay out from the tree (grid, sunburst) must call this
 * before deciding a folder is empty — "we weren't sent it" is not "it's empty".
 *
 * `pruned` means exactly "children withheld", so anything without that mark is
 * already complete (invariant 1) or is a leaf, and needs no request.
 */
async function ensureSubtree(path) {
  if (!path) return null;
  const have = state.pathIndex.get(path);
  if (have && !have.pruned) return have;
  // The scan the tree on screen came from (treeScanId): a scan still walking
  // answers a subtree with 202 (review F1.5).
  const treeScan = treeScanId;
  const scanId = treeScan();
  if (!scanId) {
    // No scan yet — we are looking at the instant paint from the index, which
    // is deliberately a small preview. The index can still answer for this
    // branch, and without this the folder would render as empty, which is the
    // one thing ensureSubtree exists to prevent.
    try {
      const data = await apiPaced(`/api/index/tree?path=${encodeURIComponent(path)}&maxNodes=${SUBTREE_NODES}`);
      if (treeScan()) return state.pathIndex.get(path) || have || null; // a scan landed; its tree wins
      return data.root ? graftSubtree(data.root) : (have || null);
    } catch {
      return have || null;
    }
  }
  try {
    // Paced: quick navigation can outrun the server's 10/s allowance, and a
    // 429 here would leave the folder looking empty rather than unloaded.
    const data = await apiPaced(`/api/scan/${scanId}/subtree?path=${encodeURIComponent(path)}`);
    // A rescan landing during the fetch replaces the whole tree; grafting this
    // answer would splice nodes from the old scan into the new one.
    if (scanId !== treeScan()) return state.pathIndex.get(path) || null;
    return data.root ? graftSubtree(data.root) : (state.pathIndex.get(path) || null);
  } catch {
    return state.pathIndex.get(path) || null; // may still be `pruned` — callers must respect that
  }
}

/**
 * Remember nodes that arrived in a server list (largest files, duplicates,
 * cloud-safe, rule matches). They already carry their real sizes, so seeding
 * them here lets the synchronous size readers resolve without a round trip —
 * which matters for the selection toolbars, since those run on every click.
 */
function seedNodes(files) {
  for (const f of files || []) {
    if (f && f.path && !state.pathIndex.has(f.path)) state.nodeCache.set(f.path, f);
  }
}

/**
 * Resolve any of `paths` we don't already hold, so a pruned-away node is never
 * mistaken for a missing one. Sizes and cart membership depend on this: reading
 * an absent node as zero bytes would quietly under-report what the user is
 * about to delete.
 */
async function ensureNodes(paths) {
  // The scan the tree on screen came from (treeScanId): a scan still walking
  // answers nothing about it (BQJ-1b).
  const scanId = treeScanId();
  if (!scanId) return;
  const missing = [...new Set(paths)].filter((p) => !state.pathIndex.has(p) && !state.nodeCache.has(p));
  if (!missing.length) return;
  for (let i = 0; i < missing.length; i += 500) { // the endpoint caps a batch at 500
    const chunk = missing.slice(i, i + 500);
    try {
      const r = await apiPaced(`/api/scan/${scanId}/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: chunk }),
      });
      // A rescan during the fetch means these answers describe a tree that no
      // longer exists — caching them would report stale sizes as current.
      if (scanId !== treeScanId()) return;
      if (r.nodes) for (const p of chunk) state.nodeCache.set(p, r.nodes[p] || null);
    } catch { /* unresolved: callers fall back to what they already hold */ }
  }
}

/** Each toast with a button names its message for that button (aria-describedby). */
let toastActionSeq = 0;
/** The offers made in each sheet, by the sheet's id (toastAction's `sheet`). */
const sheetToasts = new Map();
/**
 * A sheet closed (modalClosed): the offers made in it go, their choices with
 * them. An offer's choice acts on the sheet it was made in, and one holding
 * focus never times out — so it outlived a sheet closed by Escape, its choice
 * doing nothing (the policy editor, Settings) or re-listing a picker nobody
 * could see (final review F2.2, F2.3).
 */
function toastsRetire(sheet) {
  const goes = sheetToasts.get(sheet);
  sheetToasts.delete(sheet);
  if (goes) for (const go of goes) go();
}
/**
 * A toast with one button — for the cases where the right next step is a
 * single click away (scan again, try again). `fn` runs once and the toast
 * goes with it. Same surface and lifetime as toast(), so it reads as one
 * family; longer by default because it is asking for a decision.
 *
 * `focus`: the button takes focus as the toast appears, and focus goes back
 * where it was when the toast goes — for an answer to a press the person
 * just made (offerMeant). #toasts is the last thing in the page, and with a
 * sheet open Tab cycles inside the sheet, so a keyboard could not reach the
 * choice at all (final review F1.10). A toast holding focus does not time out
 * from under it.
 *
 * `sheet`: the id of the sheet the toast was made in; it goes when that sheet
 * closes (toastsRetire).
 */
function toastAction(msg, label, fn, kind = 'success', ms = 12000, { focus = false, sheet = null } = {}) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  const msgId = 'toastMsg' + (++toastActionSeq);
  el.innerHTML = icon(kind === 'error' ? 'alert' : 'checkCircle', 16) + `<span id="${msgId}">` + escapeHtml(msg) + '</span>' +
    `<button class="pill" type="button" aria-describedby="${msgId}" style="margin-left:10px;flex:none;">` + escapeHtml(label) + '</button>';
  const btn = el.querySelector('button');
  const back = focus ? document.activeElement : null;
  // Gone once, and its choice made once: the toast stays on screen, and
  // clickable, for the 320ms it fades, so a double-click — or a click as it
  // times out — ran `fn` again (final review F1.12).
  let done = false;
  /** The page's Tab stops outside #toasts, in order: the last is the one a keyboard reaches #toasts from. */
  const pageStops = () => modalFocusables(document.body).filter((x) => !$('toasts').contains(x));
  // Focus the toast holds goes on as it goes, however it goes — chosen by
  // Enter, Space or a click, dismissed by Escape, retired with its sheet —
  // never to <body> as its button is removed: back to the control it
  // answers; failing that (an offer made without `focus`, or its control
  // since gone or no longer able to take focus), into the sheet on top, where
  // the sheet opens; else to the page's last stop, as Shift+Tab goes (review
  // F1.1, F2.3). None of them scrolls: the last stop can be a Grid tile drawn
  // below the window, and a toast going is no reason to move the page.
  const handOff = () => {
    if (back && back.isConnected !== false && back.focus) back.focus({ preventScroll: true });
    if (!el.contains(document.activeElement)) return;
    const top = topModal();
    if (top) { modalFocusInto(top); return; }
    const to = pageStops().at(-1);
    if (to) to.focus({ preventScroll: true });
  };
  const gone = () => {
    if (done) return;
    done = true;
    const held = el.contains(document.activeElement);
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
    if (held) handOff();
  };
  btn.addEventListener('click', () => { if (done) return; gone(); fn(); });
  // Outside a sheet the toast is the page's last stop (QA C09): Escape did
  // nothing, and Tab left the page for <body>. Escape dismisses it, focus
  // handed on as it goes (handOff); Tab moves on as if the toast sat right
  // after the control it answers — to the stop after that control, Shift+Tab
  // back to it — or, with that control gone, from the page's first stop.
  // Inside a sheet both keys are the sheet's: Escape closes it, its offers
  // with it, and Tab cycles inside it (modalTrapTab).
  btn.addEventListener('keydown', (e) => {
    if (done || topModal()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      gone();
      return;
    }
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
    const stops = pageStops();
    const at = back ? stops.indexOf(back) : -1;
    const to = e.shiftKey ? (at === -1 ? stops[stops.length - 1] : back) : stops[(at + 1) % stops.length];
    if (!to) return;
    e.preventDefault();
    to.focus();
  });
  if (sheet) {
    if (!sheetToasts.has(sheet)) sheetToasts.set(sheet, new Set());
    sheetToasts.get(sheet).add(gone);
  }
  $('toasts').appendChild(el);
  if (focus) btn.focus({ preventScroll: true });
  const expire = () => {
    if (done) return;
    if (el.contains(document.activeElement)) { setTimeout(expire, ms); return; }
    gone();
  };
  setTimeout(expire, ms);
}

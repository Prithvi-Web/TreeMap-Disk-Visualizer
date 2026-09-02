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
  const scanId = state.scanId;
  if (!scanId) {
    // No scan yet — we are looking at the instant paint from the index, which
    // is deliberately a small preview. The index can still answer for this
    // branch, and without this the folder would render as empty, which is the
    // one thing ensureSubtree exists to prevent.
    try {
      const data = await apiPaced(`/api/index/tree?path=${encodeURIComponent(path)}&maxNodes=${SUBTREE_NODES}`);
      if (state.scanId) return state.pathIndex.get(path) || have || null; // a scan landed; its tree wins
      return data.root ? graftSubtree(data.root) : (have || null);
    } catch {
      return have || null;
    }
  }
  try {
    // Paced: quick navigation can outrun the server's 10/s allowance, and a
    // 429 here would leave the folder looking empty rather than unloaded.
    const data = await apiPaced(`/api/scan/${scanId}/subtree?path=${encodeURIComponent(path)}`);
    // A rescan during the fetch replaces the whole tree; grafting this answer
    // would splice nodes from the old scan into the new one.
    if (scanId !== state.scanId) return state.pathIndex.get(path) || null;
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
  const scanId = state.scanId;
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
      if (scanId !== state.scanId) return;
      if (r.nodes) for (const p of chunk) state.nodeCache.set(p, r.nodes[p] || null);
    } catch { /* unresolved: callers fall back to what they already hold */ }
  }
}

/**
 * A toast with one button — for the cases where the right next step is a
 * single click away (scan again, try again). `fn` runs once and the toast
 * goes with it. Same surface and lifetime as toast(), so it reads as one
 * family; longer by default because it is asking for a decision.
 */
function toastAction(msg, label, fn, kind = 'success', ms = 12000) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = icon(kind === 'error' ? 'alert' : 'checkCircle', 16) + '<span>' + escapeHtml(msg) + '</span>' +
    '<button class="pill" type="button" style="margin-left:10px;flex:none;">' + escapeHtml(label) + '</button>';
  const gone = () => { el.classList.add('out'); setTimeout(() => el.remove(), 320); };
  el.querySelector('button').addEventListener('click', () => { gone(); fn(); });
  $('toasts').appendChild(el);
  setTimeout(gone, ms);
}

/* ═══════════ Phase 4 (v4 §4.3) — the simulated "after" ═══════════

   A **client-side** re-layout of the map with the staged items taken out.
   §4.3 forbids a server call, and the reason is not only latency: the layout
   endpoint is one of the byte-locked golden responses (§2.1), so there is
   nowhere on the server for a hypothetical tree to come from anyway.

   ── The one decision that shapes everything below ──

   The freed space **stays on the map**, hatched, instead of the survivors
   growing to fill it.

   Those two are mutually exclusive: area means bytes, so if the survivors
   expanded into the vacated space, the same rectangle would silently be worth
   more bytes than it was a second earlier, and every size comparison the user
   made against the live map would be wrong. §4.3 asks for "freed regions
   rendered in a distinct hatched style", which settles it — a freed region
   that is still drawn is a region the survivors did not take.

   So the re-layout is real but scale-preserving: inside each folder, the
   staged children collapse into ONE hatched block of exactly their combined
   size, and that folder's surviving children re-tile around it. The map still
   totals what the disk totals today, and the hatched area is exactly what
   comes back.

   ── Where a staged path lands ──

   A staged path is charged to the deepest drawn node that contains it:
     * it IS a drawn node          → that node and its subtree go, and its
                                     bytes join its parent's freed block;
     * inside a drawn folder       → its bytes join that folder's own freed
                                     block, which is where they actually are;
     * inside a drawn leaf         → the leaf shrinks by that much and the
                                     difference joins its parent's freed block,
                                     because a leaf has no interior to draw in;
     * outside this view entirely  → counted, and said out loud in the banner.
   The four cases keep the arithmetic exact: every byte staged is either drawn
   as hatched somewhere or reported as not being in this view.                */

/**
 * Worst aspect ratio of a row — the ranking function squarify greedily
 * minimises. Ported with `tmSquarify` below.
 */
function tmWorstRatio(row, side) {
  let sum = 0, max = -Infinity, min = Infinity;
  for (const a of row) { sum += a; if (a > max) max = a; if (a < min) min = a; }
  if (sum <= 0 || side <= 0) return Infinity;
  const s2 = sum * sum, w2 = side * side;
  return Math.max((w2 * max) / s2, s2 / (w2 * min));
}

/**
 * Squarified layout — a port of `squarify()` in `src/utils/treemap.ts`.
 *
 * A second implementation is a cost, and it is paid deliberately: §4.3 rules
 * out asking the server, and the server is where the only other one lives.
 * What keeps the two honest is `tests/cartPreview.test.ts`, which pulls this
 * function out of this file, runs it beside the real one over the same corpus
 * and demands identical rectangles. If either drifts, that fails.
 *
 * Bruls, Huizing & van Wijk (2000): lay items into rows along the shorter side
 * of what is left, growing a row while doing so improves its worst ratio.
 */
function tmSquarify(areas, rect) {
  const result = new Array(areas.length);
  let remaining = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(remaining.w, remaining.h);
    const rowStart = i;
    const row = [areas[i]];
    i++;
    while (i < areas.length) {
      const candidate = [...row, areas[i]];
      if (tmWorstRatio(candidate, side) <= tmWorstRatio(row, side)) { row.push(areas[i]); i++; }
      else break;
    }
    let rowArea = 0;
    for (const a of row) rowArea += a;
    const thickness = side > 0 ? rowArea / side : 0;
    if (remaining.w >= remaining.h) {
      let y = remaining.y;
      for (let k = 0; k < row.length; k++) {
        const h = thickness > 0 ? row[k] / thickness : 0;
        result[rowStart + k] = { x: remaining.x, y, w: thickness, h };
        y += h;
      }
      remaining = { x: remaining.x + thickness, y: remaining.y, w: remaining.w - thickness, h: remaining.h };
    } else {
      let x = remaining.x;
      for (let k = 0; k < row.length; k++) {
        const w = thickness > 0 ? row[k] / thickness : 0;
        result[rowStart + k] = { x, y: remaining.y, w, h: thickness };
        x += w;
      }
      remaining = { x: remaining.x, y: remaining.y + thickness, w: remaining.w, h: remaining.h - thickness };
    }
  }
  return result;
}

/** Preview state. `saved` is the exact node list to put back on exit (§4.3). */
const tmPreview = { on: false, saved: null, freedBytes: 0, stagedInView: 0, outsideView: 0, outsideBytes: 0 };

/**
 * The directory part of a path, using whichever separator the path itself uses.
 *
 * The root's own separator is kept: `/Users` yields `/`, not `''`, and
 * `C:\\Users` yields `C:\\`, not `C:`. Dropping it looks harmless until the
 * scan is rooted at the whole disk — then every top-level folder reports a
 * parent that matches no node, the child map comes out empty, and the preview
 * silently has nothing to show on the one scan people run most.
 */
function tmParentPath(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (i < 0) return '';
  const head = p.slice(0, i);
  if (head === '' || /^[A-Za-z]:$/.test(head)) return head + p[i];
  return head;
}

/** Is `p` inside `dir` (and not `dir` itself)? Separator-aware, prefix-safe. */
function tmIsInside(p, dir) {
  if (!dir || p === dir) return false;
  const sep = dir.includes('\\') ? '\\' : '/';
  const base = dir.endsWith(sep) ? dir : dir + sep;
  return p.startsWith(base);
}

/**
 * Rebuild the parent → children relation the server laid out from.
 *
 * The flat node list is emitted breadth-first with a `depth` on every entry,
 * so a node's parent is the entry whose path is its directory, with the
 * current treemap root standing in at depth 0. Reconstructing it rather than
 * deriving children from `state.pathIndex` is what makes the preview
 * comparable to the live map: the same child sets, filtered by the same
 * minSize, laid out by the same algorithm.
 */
function tmDrawnTree() {
  const rootPath = state.treemap.rootPath;
  const byPath = new Map();
  const kids = new Map();
  const root = { path: rootPath, size: state.treemap.rootSize, depth: 0, expanded: true };
  byPath.set(rootPath, root);
  for (const n of state.treemap.nodes) byPath.set(n.path, n);
  for (const n of state.treemap.nodes) {
    const parent = tmParentPath(n.path);
    if (!byPath.has(parent)) continue; // a gap the layout skipped
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(n);
  }
  return { root, byPath, kids };
}

/**
 * The cart, reduced to the paths that stand alone.
 *
 * Staging a folder and then a file inside it is ordinary — the file's bytes
 * are already counted in the folder's, and taking both would free the same
 * space twice and produce a map whose areas do not add up.
 */
function tmCartRoots() {
  const paths = [...state.cart];
  // Ancestor lookup rather than the pairwise scan this started as. A cart may
  // hold 500 paths, and `paths.some` inside `paths.filter` is 250,000 string
  // comparisons for a question each path can answer about itself in a handful
  // of Map probes: is any directory above me also staged?
  const staged = new Set(paths);
  return paths.filter((p) => {
    for (let dir = tmParentPath(p); dir; dir = tmParentPath(dir)) {
      if (staged.has(dir)) return false;
      if (dir === tmParentPath(dir)) break; // reached the filesystem root
    }
    return true;
  });
}

/**
 * Build the previewed node list.
 *
 * Pure: it reads `state.treemap.nodes`, the cart and the node cache and
 * returns a new array. §4.3 requires that no state outlives the preview, and
 * the cheapest way to guarantee that is a builder that mutates nothing.
 */
function tmBuildPreview() {
  if (!state.treemap.nodes.length || !state.treemap.rootPath) return null;
  const { root, byPath, kids } = tmDrawnTree();

  const freedIn = new Map();   // path → bytes freed directly inside it
  const removed = new Set();   // drawn nodes staged whole
  const shrunk = new Map();    // drawn leaves that lost bytes from below
  let removedAll = false;      // the map's own root was staged: everything goes

  let stagedInView = 0, outsideView = 0, outsideBytes = 0;
  const addFreed = (p, bytes) => freedIn.set(p, (freedIn.get(p) || 0) + bytes);

  for (const p of tmCartRoots()) {
    const node = cartNode(p);
    const bytes = node ? node.size : null;

    // Staging the folder the map is rooted at — or anything above it — frees
    // everything on screen. Drawn as one hatched canvas, which is the truth.
    if (p === root.path || tmIsInside(root.path, p)) {
      stagedInView += root.size;
      addFreed(root.path, root.size);
      removedAll = true; // one flag; the walk below skips every child
      continue;
    }
    if (!tmIsInside(p, root.path)) { outsideView++; outsideBytes += bytes || 0; continue; }

    const drawn = byPath.get(p);
    if (drawn) {
      removed.add(p);
      addFreed(tmParentPath(p), drawn.size);
      stagedInView += drawn.size;
      continue;
    }
    // Size unknown: never guessed at, and never silently dropped either.
    if (bytes === null) { outsideView++; continue; }

    // Not drawn: charge it to the deepest drawn node that contains it.
    //
    // Found by walking UP from the path, not by scanning the drawn set. The
    // scan version was O(staged × drawn) and measured 120 ms at 250k nodes —
    // over §2.5's 50 ms main-thread budget, on the map size the budget exists
    // for. Every ancestor of a path is a prefix of it, so the answer is a few
    // Map probes.
    let host = root;
    for (let dir = tmParentPath(p); dir; dir = tmParentPath(dir)) {
      const hit = byPath.get(dir);
      if (hit) { host = hit; break; }
      if (dir === tmParentPath(dir)) break; // reached the filesystem root
    }
    stagedInView += bytes;
    if (kids.has(host.path)) {
      addFreed(host.path, bytes); // an interior block, where the bytes really are
    } else {
      // A leaf has no interior to draw in, so it shrinks and its parent's
      // freed block grows by the same amount. The sum is unchanged.
      shrunk.set(host.path, Math.min(host.size, (shrunk.get(host.path) || 0) + bytes));
      addFreed(tmParentPath(host.path), bytes);
    }
  }

  if (!freedIn.size) return { nodes: null, stagedInView: 0, outsideView, outsideBytes, freedBytes: 0 };

  // Re-lay out from the root. Every parent keeps its ORIGINAL size as the
  // denominator, so a surviving rectangle covers exactly the area it covers on
  // the live map and only its position changes.
  const out = [];
  let freedTotal = 0;
  const walk = (parent, rect, depth) => {
    const children = removedAll ? [] : (kids.get(parent.path) || []).filter((c) => !removed.has(c.path));
    const freed = freedIn.get(parent.path) || 0;
    const entries = children.map((c) => ({ node: c, size: Math.max(0, c.size - (shrunk.get(c.path) || 0)) }));
    if (freed > 0) entries.push({ node: null, size: freed });
    const live = entries.filter((e) => e.size > 0).sort((a, b) => b.size - a.size);
    if (!live.length || parent.size <= 0 || rect.w <= 0 || rect.h <= 0) return;

    const rectArea = rect.w * rect.h;
    const rects = tmSquarify(live.map((e) => (e.size / parent.size) * rectArea), rect);
    for (let k = 0; k < live.length; k++) {
      const r = rects[k];
      if (!r || r.w <= 0 || r.h <= 0) continue;
      if (live[k].node === null) {
        freedTotal += live[k].size;
        out.push({
          name: 'Freed', path: parent.path + ' — freed', size: live[k].size, type: 'dir',
          depth: depth + 1, expanded: false, freed: true,
          x: r.x, y: r.y, w: r.w, h: r.h,
        });
        continue;
      }
      const c = live[k].node;
      out.push({ ...c, size: live[k].size, x: r.x, y: r.y, w: r.w, h: r.h });
      if (c.expanded && kids.has(c.path) && r.w > 0.2 && r.h > 0.2) {
        walk({ path: c.path, size: c.size }, r, depth + 1);
      }
    }
  };
  walk(root, { x: 0, y: 0, w: 100, h: 100 }, 0);
  return { nodes: out, stagedInView, outsideView, outsideBytes, freedBytes: freedTotal };
}

/**
 * Diagonal hatch, built once, in the current theme's ink.
 *
 * Drawn in `--warn`, the same amber as the freed block's dashed border and the
 * preview banner — one visual language for "this is not here yet". It started
 * as `--text-3`, which is a dim tertiary *text* colour: measured against the
 * dark canvas it came out at RGB 15 on a background of 7, a hatch nobody could
 * see. A colour picked for small type is not a colour for a texture.
 */
let tmHatch = null;
let tmHatchInk = '';
function tmHatchPattern(ctx) {
  const ink = cssVar('--warn') || '#FF9F0A';
  if (tmHatch && tmHatchInk === ink) return tmHatch;
  const tile = document.createElement('canvas');
  tile.width = 8; tile.height = 8;
  const t = tile.getContext('2d');
  t.strokeStyle = ink;
  t.lineWidth = 1.6;
  t.beginPath();
  // Two strokes, the second offset by a tile, so the diagonal runs continuously
  // across tiles instead of showing a seam every 8 px.
  t.moveTo(-2, 10); t.lineTo(10, -2);
  t.moveTo(-2, 18); t.lineTo(18, -2);
  t.stroke();
  tmHatch = ctx.createPattern(tile, 'repeat');
  tmHatchInk = ink;
  return tmHatch;
}

/** Turn the preview on, or say honestly why it cannot run. */
function enterCartPreview() {
  if (tmPreview.on) { exitCartPreview(); return; }
  if (state.view !== 'treemap') { toast('Open the Treemap view to preview what the cart frees', 'error'); return; }
  if (isSun() || isCells()) {
    // §4.3's preview re-tiles rectangles, and the hatched freed block only
    // means anything in a rectangular layout. Naming the renderer the user is
    // actually looking at beats a message about a mode they did not pick.
    const names = { sunburst: 'Sunburst', circles: 'Circles', voronoi: 'Voronoi' };
    toast(`The preview re-lays out the treemap — switch the map back from ${names[state.treemap.mode]} first`, 'error');
    return;
  }
  if (state.treemap.history.active) { toast('Leave the time slider first — the preview works on the live map', 'error'); return; }
  if (!state.treemap.nodes.length) { toast('Nothing is drawn yet', 'error'); return; }
  if (!state.cart.size) { toast('Your cart is empty — there is nothing to take out of the map', 'error'); return; }

  const built = tmBuildPreview();
  if (!built || !built.nodes) {
    toast(
      built && built.outsideView
        ? `None of the ${formatCount(built.outsideView)} staged item${built.outsideView === 1 ? '' : 's'} is inside this folder — open the folder they are in to preview them.`
        : 'Nothing staged is drawn on this map.',
      'error', 7000,
    );
    return;
  }
  tmPreview.on = true;
  tmPreview.saved = state.treemap.nodes;
  tmPreview.freedBytes = built.freedBytes;
  tmPreview.stagedInView = built.stagedInView;
  tmPreview.outsideView = built.outsideView;
  tmPreview.outsideBytes = built.outsideBytes;
  state.treemap.nodes = built.nodes;
  state.treemap.hover = null;
  state.treemap.kbSel = null;
  syncCartPreviewChrome();
  drawTreemap();
}

/** Put the map back exactly as it was. */
function exitCartPreview(silent = false) {
  if (!tmPreview.on) return;
  const saved = tmPreview.saved;
  tmPreview.on = false;
  tmPreview.saved = null;
  // The identical array, not a rebuilt one: §4.3 asks that exiting restore the
  // exact prior view state, and re-fetching would re-run the server's layout —
  // which could legitimately differ if a rescan landed while the preview was up.
  if (saved) state.treemap.nodes = saved;
  state.treemap.hover = null;
  state.treemap.kbSel = null;
  syncCartPreviewChrome();
  if (!silent && state.view === 'treemap' && isRectMap()) drawTreemap();
}

/** Banner text, toggle state and the wrap outline — one place, both directions. */
function syncCartPreviewChrome() {
  const btn = $('cartPreview');
  if (btn) {
    btn.setAttribute('aria-pressed', String(tmPreview.on));
    btn.classList.toggle('active', tmPreview.on);
  }
  $('treemapWrap').classList.toggle('previewing', tmPreview.on);
  const banner = $('tmPreviewBanner');
  if (!banner) return;
  banner.hidden = !tmPreview.on;
  if (!tmPreview.on) return;
  const outside = tmPreview.outsideView
    ? ` <span class="muted">${formatCount(tmPreview.outsideView)} staged item${tmPreview.outsideView === 1 ? '' : 's'} ` +
      `${tmPreview.outsideBytes ? `(${escapeHtml(formatBytes(tmPreview.outsideBytes))}) ` : ''}` +
      `${tmPreview.outsideView === 1 ? 'is' : 'are'} outside this folder and not shown.</span>`
    : '';
  $('tmPreviewText').innerHTML =
    `<b>Preview — nothing has been deleted.</b> The hatched areas are the ` +
    `<b>${escapeHtml(formatBytes(tmPreview.freedBytes))}</b> this cart would free.` + outside;
}

$('cartPreview').addEventListener('click', () => enterCartPreview());
$('tmPreviewExit').addEventListener('click', () => exitCartPreview());

function treemapHit(clientX, clientY, leavesOnly = false) {
  // Through the shared toolkit: the deepest rectangle wins, so clicking a file
  // inside a folder selects the file rather than its parent.
  const { x, y } = Canvas2D.toLocal(tmCanvas, clientX, clientY);
  return Canvas2D.hitTest(state.treemap.pxRects, x, y, {
    skip: leavesOnly ? (r) => r.frame : null,
    depthOf: (r) => r.n.depth,
  });
}

/* v4 §6.3 — a drag on the map is a lasso. A plain CLICK still drills in, so
   the two are separated by distance, not by intent: under the threshold in
   `lassoEnd` the gesture never became a lasso and the click is allowed
   through. Read-only states refuse it for the same reasons they refuse a
   click — a historical path may no longer exist, and §4.3's preview is a
   hypothetical with nothing in it to stage. */
tmCanvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !lassoAvailable()) return;
  if (state.treemap.history.active || tmPreview.on) return;
  tmCanvas.setPointerCapture(e.pointerId);
  lassoStart(e, tmCanvas);
});
tmCanvas.addEventListener('pointermove', (e) => { if (state.lasso.on) lassoMove(e); });
tmCanvas.addEventListener('pointerup', (e) => {
  if (tmCanvas.hasPointerCapture(e.pointerId)) tmCanvas.releasePointerCapture(e.pointerId);
  if (lassoEnd()) tmSuppressClick = true;
});
tmCanvas.addEventListener('pointercancel', () => lassoCancel());
let tmSuppressClick = false;

/** The union of two hover rects in CSS px, padded for the 2px ring; null when neither exists. */
function tmHoverUnion(a, b) {
  const rs = [a, b].filter(Boolean);
  if (!rs.length) return null;
  const pad = 3;
  const x0 = Math.max(0, Math.min(...rs.map((r) => r.x)) - pad);
  const y0 = Math.max(0, Math.min(...rs.map((r) => r.y)) - pad);
  const x1 = Math.max(...rs.map((r) => r.x + r.w)) + pad;
  const y1 = Math.max(...rs.map((r) => r.y + r.h)) + pad;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

let tmRaf = 0;
tmCanvas.addEventListener('mousemove', (e) => {
  // §6.4 — the lens follows the pointer whether or not it is up, so pressing
  // Z shows the tiles the cursor is already over rather than nothing until
  // the mouse next moves.
  const lensAt = Canvas2D.toLocal(tmCanvas, e.clientX, e.clientY);
  state.lens.at = lensAt;
  if (state.lasso.on) { hideTooltip(); return; }
  if (tmRaf) return;
  tmRaf = requestAnimationFrame(() => {
    tmRaf = 0;
    if (lensActive()) presentView();
    const hit = viewHit(e.clientX, e.clientY, true);
    const prevNode = state.treemap.hover && state.treemap.hover.n;
    if ((hit && hit.n) !== prevNode) {
      const prev = state.treemap.hover;
      state.treemap.hover = hit;
      // Only two tiles changed: present that union, not the whole map. The
      // lens paints a circle that is not a tile, and the sunburst and the
      // solved renderers hover shapes that are not rectangles — those keep
      // the full present.
      const clip = !lensActive() && isRectMap() ? tmHoverUnion(prev, hit) : null;
      presentView(clip ? { clip } : undefined);
    }
    if (hit) {
      // §4.3 — a freed block is a hypothetical, not a file: no drill-in cursor,
      // and no tooltip claiming a path that will not exist.
      tmCanvas.style.cursor = hit.n.freed ? 'var(--cur-dot)'
        : (hit.n.type === 'dir' || hit.center) ? 'var(--cur-hand)' : 'var(--cur-dot)';
      if (hit.n.freed) { hideTooltip(); return; }
      // §6.4 — the lens already names what is under the cursor, and the
      // tooltip is a floating card that lands squarely on top of the glass.
      // Two labels for one thing, one of them covering the other.
      if (lensActive()) { hideTooltip(); return; }
      // Same node as last frame and the card is already up: reposition it.
      // Rebuilding the card (innerHTML, then a forced layout to measure it)
      // on every frame the pointer moved inside one tile was pure waste, and
      // each rebuild nudged the card's size — which is what kept feeding the
      // glass engine's ResizeObserver.
      const tip = $('tooltip');
      if (hit.n === prevNode && tip.style.display !== 'none' && tip.dataset.path === hit.n.path) {
        moveTooltip(e.clientX, e.clientY);
      } else {
        const pct = state.treemap.rootSize > 0 ? (hit.n.size / state.treemap.rootSize) * 100 : 0;
        showTooltip(e.clientX, e.clientY, hit.n, pct);
      }
    } else { tmCanvas.style.cursor = 'var(--cur-dot)'; hideTooltip(); }
  });
});
tmCanvas.addEventListener('mouseleave', () => {
  state.treemap.hover = null;
  state.lens.at = null;
  presentView();
  hideTooltip();
});
tmCanvas.addEventListener('click', (e) => {
  // A lasso that ended over a folder must not also drill into it.
  if (tmSuppressClick) { tmSuppressClick = false; hideTooltip(); return; }
  if (state.treemap.history.active) { hideTooltip(); return; } // historical view — read-only
  // v4 §4.3 — the preview is a hypothetical, so drilling into it would load a
  // real folder under a banner that says nothing has been deleted. Read-only,
  // for the same reason the time slider is.
  if (tmPreview.on) { hideTooltip(); return; }
  const hit = viewHit(e.clientX, e.clientY);
  if (!hit) return;
  if (hit.n && hit.n.isTrash) { hideTooltip(); openTrashModal(); return; }
  if (hit.center) { // sunburst centre disc → zoom out one level
    const crumbs = breadcrumbsFor(state.treemap.rootPath);
    if (crumbs.length > 1) { hideTooltip(); loadTreemap(crumbs[crumbs.length - 2].path, true); }
    return;
  }
  // Feature 23 — containers drill into their virtual contents.
  if (hit.n.container && hit.n.type === 'file' && !hit.n.virtual) { hideTooltip(); expandContainerNode(hit.n); return; }
  if (hit.n.type === 'dir') { hideTooltip(); loadTreemap(hit.n.path, true); }
  else if (!hit.n.virtual) { hideTooltip(); openPreview(hit.n); }
});

/** Feature 23 — open a container: parse once server-side, then drill in. */
async function expandContainerNode(n) {
  const node = state.pathIndex.get(n.path);
  if (node && node.children && node.children.length) { loadTreemap(n.path, true); return; }
  $('tmStatus').textContent = `Opening ${n.name}…`;
  try {
    const resp = await api('/api/container/expand', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanId: state.scanId, path: n.path }),
    });
    if (node) {
      node.children = resp.children;
      const stack = [...resp.children];
      while (stack.length) {
        const c = stack.pop();
        state.pathIndex.set(c.path, c);
        if (c.children) stack.push(...c.children);
      }
    }
    toast(`Opened ${n.name} — ${formatCount(resp.entryCount)} entr${resp.entryCount === 1 ? 'y' : 'ies'}${resp.truncated ? ' (largest shown)' : ''}`);
    loadTreemap(n.path, true);
  } catch (e) {
    updateTmStatus();
    toast(e.message, 'error');
  }
}
tmCanvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (state.treemap.history.active) return; // historical paths may no longer exist
  if (tmPreview.on) return;                 // §4.3 — nothing here is real yet
  const hit = viewHit(e.clientX, e.clientY, true);
  if (hit && hit.n && hit.n.isTrash) { openTrashModal(); return; }
  if (hit && hit.n) showCtxMenu(e.clientX, e.clientY, hit.n);
});
$('tmDepth').addEventListener('change', (e) => {
  state.treemap.maxDepth = +e.target.value;
  if (state.treemap.rootPath) loadTreemap(state.treemap.rootPath);
});
$('tmRefresh').innerHTML = icon('refresh', 15);
$('tmRefresh').addEventListener('click', () => { if (state.treemap.rootPath) loadTreemap(state.treemap.rootPath); });
$('tmLensToggle').addEventListener('click', () => lensSetPinned(!state.lens.pinned));
// Feature 10 — hide cloud placeholders (show only on-disk bytes).
$('tmCloudToggle').addEventListener('click', () => {
  state.treemap.hideCloud = !state.treemap.hideCloud;
  $('tmCloudToggle').setAttribute('aria-pressed', String(state.treemap.hideCloud));
  $('tmCloudToggle').classList.toggle('active', state.treemap.hideCloud);
  fxTmPillBeamsSync(); // FX: Hide-cloud on is a persistent mode
  if (state.treemap.rootPath) drawView();
});
// Feature 1 — Size/Age heatmap color mode toggle (persisted in localStorage).
const TM_COLOR_MODES = ['size', 'age', 'reclaim'];
function setTreemapColorMode(mode) {
  mode = TM_COLOR_MODES.includes(mode) ? mode : 'size';
  state.treemap.colorMode = mode;
  localStorage.setItem('tm-colormode', mode);
  for (const b of $('tmColorSeg').querySelectorAll('button'))
    b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  // Colour, not geometry: §6.2's solved renderers repaint rather than re-solve.
  if (state.treemap.rootPath) { isCells() ? repaintCells() : drawView(); } else renderTmLegend();
  // Painting comes first and the scores follow, so switching mode is instant
  // and the map fills in. Painting behind the fetch would stall the toggle on
  // a subprocess round trip for every cell on screen.
  if (mode === 'reclaim') fetchScoresForTreemap();
}

/**
 * Scores for the cells actually on screen, then one repaint.
 *
 * Deliberately the drawn rectangles rather than the whole pruned tree: the
 * tree can hold 250,000 nodes and the map draws a few thousand of them, so
 * scoring the tree would spend most of a 2,000-path budget on cells nobody
 * can see. Re-run on every layout change, and cheap after the first because
 * `ensureScores` skips everything already known.
 */
/**
 * How many drawn cells one mode switch will score.
 *
 * Not the per-request cap: `ensureScores` chunks internally, so this is a
 * ceiling on total work rather than on one call. A real map draws a few
 * thousand cells — the rest are sub-pixel and never rendered — so this covers
 * the visible set on an ordinary tree in about three requests.
 *
 * It is a cap all the same, and §2.4 does not allow a cap to be silent: when
 * the drawn set exceeds it, the legend says how many of how many were scored,
 * because a grey cell that was never asked about looks exactly like one
 * TreeMap tried and failed to score.
 */
const TM_SCORE_CAP = 6000;

function fetchScoresForTreemap() {
  if (state.treemap.colorMode !== 'reclaim' || !state.scanId) return;
  // Every renderer, because Reclaim is a colour mode and all four paint
  // through the same cellRgb. Their entries are shaped alike: `{ n, ... }`.
  const drawn = drawnCells();
  if (!drawn.length) return;
  const paths = [];
  for (const r of drawn) {
    // v4 §4.3 — a freed block is a hypothetical, not a path. Asking the fact
    // layer about it spends a batch slot on a file that never existed and
    // comes back unanswerable, which the coverage note would then report as a
    // file that could not be read.
    if (r.n && r.n.path && !r.n.freed) paths.push(r.n.path);
    if (paths.length >= TM_SCORE_CAP) break;
  }
  void ensureScores(paths, () => {
    // Only if the user is still looking at this: a repaint of a view they
    // navigated away from is wasted work, and worse, can land mid-render.
    if (state.view === 'treemap' && state.treemap.colorMode === 'reclaim' && state.treemap.rootPath) {
      // Scores land in batches, so this runs several times per folder. Behind
      // §6.2's Voronoi renderer a re-solve here would be a fifth of a second of
      // main thread per batch, arriving at the arrangement already on screen.
      isCells() ? repaintCells() : drawView();
      renderTmLegend(); // the coverage line changes as batches land
    }
  });
}
$('tmColorSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (btn) setTreemapColorMode(btn.dataset.mode);
});
setTreemapColorMode(state.treemap.colorMode); // reflect persisted choice on load
/* A resize DOES move everything, so the layout has to be redone — but a window
   drag emits a continuous stream of these, and §6.2's Voronoi solve is up to a
   fifth of a second each. Re-solving per event turns a window drag into a
   slideshow, so the two solved renderers wait for the drag to settle; the
   treemap and the sunburst are cheap enough to keep following the edge live. */
let tmResizeDeb = 0;
window.addEventListener('resize', () => {
  if (state.view !== 'treemap' || !state.treemap.rootPath) return;
  if (!isCells()) { drawView(); return; }
  clearTimeout(tmResizeDeb);
  tmResizeDeb = setTimeout(() => {
    if (state.view === 'treemap' && isCells() && state.treemap.rootPath) drawCells();
  }, 160);
});

/* ── Feature 20 — time-slider treemap: scrub through snapshot history ── */
const HISTORY_CACHE_MAX = 40;

/** Drop history mode without reloading (called whenever a live layout lands). */
function exitHistoryState() {
  const h = state.treemap.history;
  lapseStop(); // §7.1 — leaving history always ends playback (Escape, live layout landing)
  h.active = false;
  h.scrubbing = false; // a live layout that genuinely landed ends the scrub
  h.tree = null;
  h.seq++; // invalidate any in-flight history fetch
  const slider = $('tmTimeSlider');
  if (slider) { slider.value = slider.max; }
  updateTimeLabel();
}

/**
 * Show/refresh the slider. History scrubbing works at the scan root only
 * (snapshot trees are stored per scanned root), so the bar hides while
 * drilled into a subfolder. Treemap and sunburst modes both scrub.
 */
async function refreshTimebar() {
  const bar = $('tmTimebar');
  if (!bar) return;
  // Never rewrite the timeline under a running playback: the tick indexes
  // into h.snaps live, and the store drops the oldest snapshot at its cap —
  // segments, slider and label would silently disagree (review RD9).
  if (state.treemap.lapse.playing) return;
  $('tmLiveToggle').hidden = isCloudScan(); // live watching is local-disk only
  const h = state.treemap.history;
  if (!state.root || state.treemap.rootPath !== state.root.path) { bar.hidden = true; return; }
  try {
    const data = await api('/api/snapshots?path=' + encodeURIComponent(state.root.path));
    // §7.1 — ordered and tree-bearing only: a treeless snapshot is a gap the
    // slider and playback both skip, never a tree to guess at.
    h.snaps = lapseOrderedSnaps(data.snapshots || []);
  } catch { h.snaps = []; }
  // The newest snapshot is the scan you're looking at — history needs two.
  if (h.snaps.length < 2) { bar.hidden = true; return; }
  bar.hidden = false;
  const slider = $('tmTimeSlider');
  slider.max = String(h.snaps.length);
  if (!h.active && !h.scrubbing) slider.value = slider.max; // a scrub in flight owns the thumb
  updateTimeLabel();
}

function updateTimeLabel() {
  const h = state.treemap.history;
  const label = $('tmTimeLabel');
  if (!label) return;
  const i = Number($('tmTimeSlider').value);
  if (i >= h.snaps.length || !h.snaps[i]) { label.textContent = 'Live'; return; }
  const s = h.snaps[i];
  label.textContent = `${formatWhen(s.takenAt)} · ${formatBytes(s.totalSize)}`;
}

/**
 * Fetch-or-remember one snapshot's layout. The cache discipline lived inside
 * setHistoryIndex until §7.1 needed the same bytes for playback segments and
 * prefetch; one function now owns the LRU so the two callers cannot diverge.
 */
async function historyLayoutFor(snap) {
  const h = state.treemap.history;
  let layout = h.cache.get(snap.id);
  if (!layout || !layout.tree) { // missing or from an older response shape
    layout = await api(`/api/snapshots/tree?path=${encodeURIComponent(state.root.path)}&at=${snap.takenAt}`);
    h.cache.set(snap.id, layout);
    if (h.cache.size > HISTORY_CACHE_MAX) h.cache.delete(h.cache.keys().next().value);
  }
  return layout;
}

/** Scrub to slider position i (h.snaps.length = Live). */
async function setHistoryIndex(i) {
  const h = state.treemap.history;
  h.index = i;
  if (i >= h.snaps.length) {
    h.scrubbing = false; // the hand asked for Live: this load may land
    if (h.active && state.root) loadTreemap(state.root.path); // back to the live tree
    return;
  }
  const snap = h.snaps[i];
  const seq = ++h.seq;
  try {
    const layout = await historyLayoutFor(snap);
    if (seq !== h.seq || state.view !== 'treemap') return; // superseded
    if (state.live.on) { disableLive(); toast('Live mode paused while viewing history'); }
    h.active = true;
    h.viewingAt = layout.snapshot.takenAt;
    h.tree = layout.tree || null;
    state.treemap.rootSize = layout.root.size;
    state.treemap.hover = null;
    state.treemap.kbSel = null;
    if (isSun()) animateSunburstTo(layout.tree);
    // §6.2's renderers re-lay out from the historical tree the same way they
    // do from the live one. They are not animated between snapshots: both are
    // global optimisations, so a cell's position between two scans is not a
    // path anything travelled and tweening it would invent a motion.
    else if (isCells()) drawCells();
    else animateTreemapTo(layout.nodes);
    updateTimeLabel();
  } catch (e) {
    toast('Could not load that point in time: ' + e.message, 'error');
  } finally {
    // Only the newest scrub may declare the hand lifted — a superseded one
    // leaves that to its successor — and it does so even if its fetch failed.
    if (seq === h.seq) h.scrubbing = false;
  }
}

/** Canvas interpolation: morph the current rectangles into `newNodes`. */
let tmAnimFrame = 0;
function animateTreemapTo(newNodes) {
  cancelAnimationFrame(tmAnimFrame);
  // Hidden tabs get no animation frames — apply the final state directly so
  // a backgrounded Live session never freezes mid-morph.
  if (REDUCED || document.hidden || !state.treemap.nodes.length) {
    state.treemap.nodes = newNodes;
    drawTreemap();
    return;
  }
  const oldByPath = new Map(state.treemap.nodes.map((n) => [n.path, n]));
  const from = newNodes.map((n) => {
    const o = oldByPath.get(n.path);
    // Entries with no previous rectangle bloom out of their own centre.
    return o ? { x: o.x, y: o.y, w: o.w, h: o.h } : { x: n.x + n.w / 2, y: n.y + n.h / 2, w: 0, h: 0 };
  });
  const t0 = performance.now(), dur = 260;
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    state.treemap.nodes = newNodes.map((n, i) => ({
      ...n,
      x: from[i].x + (n.x - from[i].x) * e,
      y: from[i].y + (n.y - from[i].y) * e,
      w: from[i].w + (n.w - from[i].w) * e,
      h: from[i].h + (n.h - from[i].h) * e,
    }));
    drawTreemap();
    if (p < 1) tmAnimFrame = requestAnimationFrame(tick);
    else { state.treemap.nodes = newNodes; drawTreemap(); }
  };
  tmAnimFrame = requestAnimationFrame(tick);
}

/* ── v4 §7.1 — time-lapse interpolation, as pure functions ──
   Lifted whole by tests/timelapse.test.ts (liftFrontend.ts explains why they
   live here and not in src/). lapseLerpNodes morphs one snapshot's rectangle
   layout into the next: matched rectangles travel linearly; arrivals bloom
   from their own centre — animateTreemapTo's convention — and departures
   shrink into theirs, gone at t=1, because nothing may be drawn for a file
   that no longer exists. Non-geometry fields come from the destination:
   colour and depth describe where playback is going, not a blend. Draw order
   is the destination's, departures on top so they stay visible while they go. */
function lapseLerpNodes(a, b, t) {
  const tt = Math.max(0, Math.min(1, t));
  const byPathA = new Map(a.map((n) => [n.path, n]));
  const out = [];
  for (const m of b) {
    const o = byPathA.get(m.path);
    if (o) {
      byPathA.delete(m.path);
      out.push({
        ...m,
        x: o.x + (m.x - o.x) * tt,
        y: o.y + (m.y - o.y) * tt,
        w: o.w + (m.w - o.w) * tt,
        h: o.h + (m.h - o.h) * tt,
        // Geometry morphs; size does NOT — it prints as text in labels and
        // tooltips, and a lerped byte count is an invented number. The source
        // snapshot's size is the one the slider and label are showing.
        size: o.size,
      });
    } else {
      const cx = m.x + m.w / 2, cy = m.y + m.h / 2;
      out.push({ ...m, x: cx + (m.x - cx) * tt, y: cy + (m.y - cy) * tt, w: m.w * tt, h: m.h * tt });
    }
  }
  if (tt < 1) {
    for (const o of a) {
      if (!byPathA.has(o.path)) continue; // survived into b — already emitted above
      const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
      out.push({ ...o, x: o.x + (cx - o.x) * tt, y: o.y + (cy - o.y) * tt, w: o.w * (1 - tt), h: o.h * (1 - tt) });
    }
  }
  return out;
}

/* A snapshot without a tree cannot be interpolated through, and synthesising
   an intermediate tree would be a guess — §7.1 says a gap. Filtering it out
   makes playback interpolate straight across the hole: the time axis is
   segments, so the gap costs nothing and fabricates nothing. Returns a new
   array; the caller's is untouched. */
function lapseOrderedSnaps(snaps) {
  return (snaps || []).filter((s) => s && s.hasTree).sort((x, y) => x.takenAt - y.takenAt);
}

/* §7.1c — where the GIF export samples playback time. Uncapped, one frame
   every 1/fps of a segment plus the final frame; past the cap the samples
   thin out evenly but the span never shrinks — the last snapshot is always
   the last frame, and `capped` is returned so the UI can say what was cut. */
function lapseSampleTimes(snapCount, fps, cap) {
  if (snapCount < 2 || cap < 1) return { times: [], capped: false };
  const segs = snapCount - 1;
  const natural = segs * fps + 1;
  if (natural <= cap) {
    const times = [];
    for (let i = 0; i < natural; i++) times.push(Math.min(i / fps, segs));
    return { times, capped: false };
  }
  // cap 1 would divide by zero below; one frame means the final snapshot.
  if (cap === 1) return { times: [segs], capped: true };
  const times = [];
  for (let i = 0; i < cap; i++) times.push((segs * i) / (cap - 1));
  return { times, capped: true };
}

/* ── v4 §7.1 — transport: play/pause, speed, loop ──
   One rAF loop advances a fractional position over segments (one segment =
   snapshot k → k+1, LAPSE_SEG_MS at 1×). The rectangle renderer draws
   lapseLerpNodes frames; sunburst and the solved renderers step discretely at
   crossings through the same dispatch the slider uses, because a cell's
   position between two scans is not a path anything travelled. The slider and
   label update only at crossings: an interpolated byte total would be an
   invented number. */
const LAPSE_SEG_MS = 1000;
/** How long the clock may hold for a segment's bytes before stopping honestly. */
const LAPSE_HOLD_MAX_MS = 8000;

function lapseReflect() {
  const L = state.treemap.lapse;
  const play = $('tmLapsePlay');
  if (!play) return;
  play.setAttribute('aria-label', L.playing ? 'Pause time-lapse' : 'Play time-lapse');
  $('tmLapseIconPlay').hidden = L.playing;
  $('tmLapseIconPause').hidden = !L.playing;
  for (const b of $('tmLapseSpeed').querySelectorAll('button'))
    b.setAttribute('aria-selected', String(Number(b.dataset.speed) === L.speed));
  const loop = $('tmLapseLoop');
  loop.classList.toggle('active', L.loop);
  loop.setAttribute('aria-pressed', String(L.loop));
  fxTmPillBeamsSync(); // FX: the Loop ring mirrors the class this reflect just set
}

function lapseStop() {
  const L = state.treemap.lapse;
  L.seq++; // orphan the running tick before cancelling, so a queued frame is inert
  if (L.raf) cancelAnimationFrame(L.raf);
  L.raf = 0;
  L.playing = false;
  lapseReflect();
  // §7.1c — whoever is waiting on this run (the WebM recorder) hears about
  // every ending, including an interrupted one; what was captured is honest.
  const cb = L.onDone;
  L.onDone = null;
  if (cb) cb();
}

/** Warm the cache for the segments about to play; a miss never stalls a fetch already running. */
const lapseFetching = new Set();
function lapsePrefetch(from) {
  const h = state.treemap.history;
  for (let j = from; j < Math.min(from + 3, h.snaps.length); j++) {
    const snap = h.snaps[j];
    if (!snap || h.cache.get(snap.id)?.tree || lapseFetching.has(snap.id)) continue;
    lapseFetching.add(snap.id);
    historyLayoutFor(snap).catch(() => {}).finally(() => lapseFetching.delete(snap.id));
  }
}

/**
 * The slider's dispatch plus the slider itself: setHistoryIndex never writes
 * the slider (its caller IS the slider, already there), so every programmatic
 * seek — a discrete crossing, a renderer switch keeping your place — must
 * move the thumb and label itself or both keep claiming "Live" (QA D1).
 */
function lapseSeekTo(i) {
  $('tmTimeSlider').value = String(i);
  updateTimeLabel();
  setHistoryIndex(i);
}

/** Sync the per-snapshot surfaces at a crossing: slider, label, history state. */
function lapseApplySnap(j, layout) {
  const h = state.treemap.history;
  h.active = true;
  h.index = j;
  h.viewingAt = layout.snapshot.takenAt;
  h.tree = layout.tree || null;
  state.treemap.rootSize = layout.root.size;
  $('tmTimeSlider').value = String(j);
  updateTimeLabel();
}

function lapseStart() {
  const h = state.treemap.history;
  const L = state.treemap.lapse;
  // With reduced motion, playback still plays but steps discretely from
  // snapshot to snapshot — the same degradation §6 asks of every animation.
  // Sunburst and the solved renderers step discretely regardless (the rule
  // setHistoryIndex states: tweening a global optimisation invents a motion).
  const discrete = REDUCED || !isRectMap();
  // During an export only the export itself may start playback (review H4).
  if (h.snaps.length < 2 || L.playing || state.view !== 'treemap' || (lapseExporting && !lapseInternalStart)) return;
  if (state.live.on) { disableLive(); toast('Live mode paused while playing history'); }
  const seq = ++L.seq;
  // A scrub's 260 ms morph must not fight the transport for the node set.
  cancelAnimationFrame(tmAnimFrame);
  // Start from the slider; from Live or the end, start over at the oldest.
  const cur = Number($('tmTimeSlider').value);
  L.pos = cur >= h.snaps.length - 1 ? 0 : cur;
  L.playing = true;
  L.completed = false;
  lapseReflect();
  lapsePrefetch(Math.floor(L.pos));
  let last = performance.now();
  let crossed = -1;
  let holdSince = 0; // when the clock started waiting for bytes; 0 = not waiting
  const end = h.snaps.length - 1;
  const tick = async (now) => {
    if (seq !== L.seq) return; // stopped, restarted, or superseded
    const dt = Math.min(now - last, 100); // a background tab must not teleport on return
    last = now;
    // Advance first, then look at the segment the NEW position sits in.
    // Reading the pair before advancing drew one frame of the previous
    // segment at every crossing — a visible backward blink (review RD5).
    const pos = Math.min(L.pos + (dt / LAPSE_SEG_MS) * L.speed, end);
    const k = Math.min(Math.floor(pos), end - 1);
    const sa = h.snaps[k], sb = h.snaps[k + 1];
    if (!sa || !sb) { lapseStop(); return; } // the timeline was rewritten under us (review RD9)
    const a = h.cache.get(sa.id);
    const b = h.cache.get(sb.id);
    if (!a?.tree || !b?.tree) {
      // Hold the clock while a segment's bytes are still arriving — playback
      // waits rather than skipping time it never showed. But not forever: a
      // server that keeps refusing would spin this loop silently for good,
      // and a WebM export waiting on onDone would record a frozen canvas
      // indefinitely (review RD4).
      if (!holdSince) holdSince = now;
      if (now - holdSince > LAPSE_HOLD_MAX_MS) {
        toast('Playback stopped — a snapshot could not be loaded', 'error');
        lapseStop();
        return;
      }
      lapsePrefetch(k);
      L.raf = requestAnimationFrame(tick);
      return;
    }
    holdSince = 0;
    L.pos = pos;
    const j = Math.floor(pos);
    if (j !== crossed) {
      crossed = j;
      lapsePrefetch(j + 1);
      if (discrete) {
        lapseSeekTo(j); // slider + label + the slider's own dispatch (QA D1)
      } else {
        let layout;
        try {
          layout = await historyLayoutFor(h.snaps[j]);
        } catch (e) {
          if (seq !== L.seq) return; // an orphaned fetch must not stop a NEWER run (review RD3)
          toast('Could not load that point in time: ' + e.message, 'error');
          lapseStop();
          return;
        }
        if (seq !== L.seq) return; // stopped while the layout loaded — apply nothing (review RD2)
        lapseApplySnap(j, layout);
      }
    }
    if (!discrete && pos < end) {
      state.treemap.nodes = lapseLerpNodes(a.nodes, b.nodes, pos - k);
      drawTreemap();
    }
    if (pos >= end) {
      if (!discrete) { state.treemap.nodes = b.nodes; drawTreemap(); }
      if (L.loop) { L.pos = 0; crossed = -1; lapsePrefetch(0); }
      else {
        L.completed = true; // a finished run — the WebM toast tells this apart from a stop (review RD10)
        L.raf = 0; L.playing = false; lapseReflect();
        const cb = L.onDone; L.onDone = null; if (cb) cb();
        return;
      }
    }
    L.raf = requestAnimationFrame(tick);
  };
  L.raf = requestAnimationFrame(tick);
}

/* The transport is the export's instrument while one runs: a Play would fight
   the sampler for the canvas, a Loop would make the promised "one run" never
   end (review H1). The slider stays free — a scrub honestly ends the take. */
$('tmLapsePlay').addEventListener('click', () => {
  if (lapseExporting) { toast('An export is running — it drives playback itself', 'error'); return; }
  state.treemap.lapse.playing ? lapseStop() : lapseStart();
});
$('tmLapseSpeed').addEventListener('click', (e) => {
  if (lapseExporting) { toast('An export is running — it drives playback itself', 'error'); return; }
  const btn = e.target.closest('button[data-speed]');
  if (!btn) return;
  state.treemap.lapse.speed = Number(btn.dataset.speed);
  lapseReflect();
});
$('tmLapseLoop').addEventListener('click', () => {
  if (lapseExporting) { toast('An export is running — it drives playback itself', 'error'); return; }
  state.treemap.lapse.loop = !state.treemap.lapse.loop;
  lapseReflect();
});

let tmTimeDebounce = 0;
$('tmTimeSlider').addEventListener('input', () => {
  // §7.1 — the hand on the slider outranks the transport. But only a running
  // transport (or one an export is waiting on) has anything to stop:
  // lapseStop() re-reflects the whole bar — five beam re-attaches and four
  // aria-selected writes that wake the speed seg's goo — and doing that per
  // input event, at pointer rate, was half of every scrub's cost.
  const L = state.treemap.lapse;
  if (L.playing || L.onDone) lapseStop();
  // The hand is on the slider until the index it asked for has landed. A
  // live layout arriving inside that window — the return-to-Live fetch from
  // a moment ago, the post-scan timebar refresh — must not park the thumb at
  // Live under it: that discarded the newer scrub and yanked the thumb.
  state.treemap.history.scrubbing = true;
  updateTimeLabel(); // label tracks the thumb instantly
  clearTimeout(tmTimeDebounce);
  tmTimeDebounce = setTimeout(() => setHistoryIndex(Number($('tmTimeSlider').value)), 120);
});
$('tmDiffToggle').addEventListener('click', () => {
  const h = state.treemap.history;
  h.diff = !h.diff;
  $('tmDiffToggle').classList.toggle('active', h.diff);
  $('tmDiffToggle').setAttribute('aria-pressed', String(h.diff));
  fxTmPillBeamsSync(); // FX: Diff enabled is a persistent mode
  if (state.treemap.rootPath) drawView(); else renderTmLegend();
});

/* ── Feature 22 — Live disk activity mode ── */
const LIVE_PULSE_MS = 1200;
const LIVE_WINDOW_MS = 60_000;
const LIVE_RELAYOUT_MS = 8000;

/** Mirror a live change into the client tree so sunburst/tooltips stay true. */
function applyLiveDelta(ev) {
  const node = state.pathIndex.get(ev.path);
  if (node && node.type === 'file') node.size = ev.kind === 'deleted' ? 0 : ev.size;
  if (!state.root) return;
  let p = ev.path;
  for (;;) {
    const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    if (cut <= 0) break;
    p = p.slice(0, cut);
    const dir = state.pathIndex.get(p);
    if (dir && dir.type === 'dir') dir.size += ev.delta;
    if (p === state.root.path) break;
  }
}

/** Match an event path to the deepest visible region (rect or arc). */
function liveRegionFor(path_, byPath) {
  let p = path_;
  for (;;) {
    const hit = byPath.get(p);
    if (hit) return hit;
    const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    if (cut <= 0) return null;
    p = p.slice(0, cut);
  }
}

function onLiveActivity(frame) {
  const live = state.live;
  // Region lookup for pulse placement, built once per frame.
  const byPath = new Map();
  if (isSun()) for (const a of state.treemap.arcs) byPath.set(a.n.path, { arc: a });
  // §6.2 — a pulse is a shape lit up, and these shapes are neither a rectangle
  // nor an arc. `cell` is drawn through the same path function that painted it.
  else if (isCells()) for (const c of state.treemap.cells) byPath.set(c.n.path, { cell: c });
  else for (const r of state.treemap.pxRects) byPath.set(r.n.path, { rect: r });

  for (const ev of frame.events) {
    applyLiveDelta(ev);
    live.window.push({ path: ev.path, delta: ev.delta, at: frame.at });
    live.dirty += Math.abs(ev.delta);
    if (REDUCED || state.treemap.history.active || state.view !== 'treemap') continue;
    const region = liveRegionFor(ev.path, byPath);
    if (region) {
      const rgb = ev.delta < 0 || ev.kind === 'deleted' ? C_RED : C_TEAL;
      live.pulses.set(ev.path, { ...region, rgb, until: performance.now() + LIVE_PULSE_MS });
    }
  }
  if (live.pulses.size && !live.pulseRaf) livePulseLoop();
}

function livePulseLoop() {
  const live = state.live;
  if (!live.on || !live.pulses.size) { live.pulseRaf = 0; return; }
  presentView();
  live.pulseRaf = requestAnimationFrame(livePulseLoop);
}

/** Pulse overlay — called by presentTreemap/presentSunburst after their own passes. */
function drawLivePulses() {
  const live = state.live;
  if (!live.on || !live.pulses.size) return;
  const dpr = window.devicePixelRatio || 1;
  const now = performance.now();
  tmCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const [key, p] of live.pulses) {
    const t = (p.until - now) / LIVE_PULSE_MS;
    if (t <= 0) { live.pulses.delete(key); continue; }
    const a = 0.4 * t;
    tmCtx.fillStyle = `rgba(${p.rgb[0]},${p.rgb[1]},${p.rgb[2]},${a})`;
    if (p.rect) {
      tmCtx.fillRect(p.rect.x, p.rect.y, p.rect.w, p.rect.h);
      tmCtx.strokeStyle = `rgba(${p.rgb[0]},${p.rgb[1]},${p.rgb[2]},${Math.min(0.9, a * 2.2)})`;
      tmCtx.lineWidth = 1.5;
      tmCtx.strokeRect(p.rect.x + 0.5, p.rect.y + 0.5, p.rect.w - 1, p.rect.h - 1);
    } else if (p.arc) {
      sectorPath(tmCtx, p.arc.cx, p.arc.cy, p.arc.rInner, p.arc.rOuter, p.arc.a0, p.arc.a1);
      tmCtx.fill();
    } else if (p.cell) {
      altCellPath(tmCtx, p.cell);
      tmCtx.fill();
    }
  }
}

/* The write-rate spark under the top-writers rows. One handle per Live
   session; renderLiveFeed rewrites the panel with innerHTML every tick, so
   the spark lives in its own wrap element that is re-appended afterwards —
   the node (and the handle's canvas) survives, only its slot is rebuilt. */
let liveLineHandle = null;
let liveLineWrap = null;
function fxLiveLineDrop() {
  if (!liveLineHandle) return;
  liveLineHandle.destroy();
  liveLineHandle = null;
  liveLineWrap = null;
}
function renderLiveFeed() {
  const host = $('liveFeed');
  if (!host) return;
  const live = state.live;
  if (!live.on || state.view !== 'treemap') { host.hidden = true; return; }
  const cutoff = Date.now() - LIVE_WINDOW_MS;
  live.window = live.window.filter(e => e.at > cutoff);
  const byPath = new Map();
  for (const e of live.window) byPath.set(e.path, (byPath.get(e.path) || 0) + e.delta);
  const rows = [...byPath.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6);
  const rel = p => (state.root && p.startsWith(state.root.path) ? p.slice(state.root.path.length + 1) : p) || p;
  host.innerHTML = `<div class="lf-h">${icon('activity', 13)}Writing now</div>` + (rows.length
    ? rows.map(([p, d]) => `<div class="lf-row" title="${escapeHtml(p)}"><span class="nm">${escapeHtml(rel(p))}</span>` +
        `<span class="num ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : '−'}${formatBytes(Math.abs(d))}/min</span></div>`).join('')
    : `<div class="lf-row"><span class="nm muted">listening — quiet so far…</span></div>`);
  if (!liveLineWrap) {
    liveLineWrap = document.createElement('div');
    liveLineWrap.className = 'lf-spark-wrap';
    liveLineWrap.setAttribute('aria-hidden', 'true');
    liveLineWrap.appendChild(document.createElement('canvas'));
  }
  host.appendChild(liveLineWrap);
  if (!liveLineHandle) {
    liveLineHandle = FxCharts.liveLine(liveLineWrap.firstChild, {
      windowMs: LIVE_WINDOW_MS, height: 52, label: 'writes/min',
    });
  }
  // The same aggregate the rows are sliced from: total |delta| in the window.
  liveLineHandle.push([...byPath.values()].reduce((s, d) => s + Math.abs(d), 0));
  host.hidden = false;
}

/** Periodic re-layout so regions truly resize in place (morphed, not jumped). */
async function liveRelayout() {
  const live = state.live;
  if (!live.on || live.dirty <= 0 || state.scanning || state.treemap.history.active || state.view !== 'treemap') return;
  live.dirty = 0;
  if (isSun()) { animateSunburstTo(sunburstRoot()); return; }
  if (isCells()) { drawCells(); return; } // re-solved from the tree the watcher just updated
  try {
    const data = await api(`/api/scan/${state.scanId}/treemap?maxDepth=${state.treemap.maxDepth}&minSize=4096&root=${encodeURIComponent(state.treemap.rootPath)}`);
    if (!live.on) return;
    state.treemap.rootSize = data.root.size;
    animateTreemapTo(data.nodes);
  } catch { /* transient — next tick retries */ }
}

function enableLive() {
  const live = state.live;
  if (live.on || !state.scanId || !state.root) return;
  if (isCloudScan()) { toast('Live mode watches your local disk — cloud accounts can’t stream changes', 'error'); return; }
  if (state.treemap.history.active) {
    const slider = $('tmTimeSlider');
    slider.value = slider.max;
    setHistoryIndex(Number(slider.max)); // live means Live — leave history
  }
  const es = new EventSource(`/api/watch/${state.scanId}`);
  live.es = es;
  live.on = true;
  live.wanted = true;
  live.window = [];
  live.dirty = 0;
  es.onmessage = (m) => {
    const frame = JSON.parse(m.data);
    if (frame.type === 'init') {
      live.idleMinutes = frame.idleMinutes;
      live.engine = frame.engine;
      // §2.4 — a session that attached no watchers can never report anything.
      // Left on, it is a control that looks attentive over a disk it cannot
      // see; the honest move is to refuse it with the server's own reason.
      if (frame.watchers === 0) {
        disableLive({ keepWanted: false });
        toast(frame.reason || 'This folder could not be watched for live changes.', 'error', 12000);
        return;
      }
    } else if (frame.type === 'activity') {
      onLiveActivity(frame);
    } else if (frame.type === 'paused') {
      const idle = frame.reason === 'idle';
      disableLive({ keepWanted: false });
      toast(idle ? `Live mode paused — no disk activity for ${live.idleMinutes} min` : 'Live mode stopped — server shutting down');
    }
  };
  es.onerror = () => {
    if (!live.on) return;
    // EventSource reconnects by itself after transient drops (the server
    // re-creates the watch session on reconnect). Only a permanently
    // closed stream (4xx/5xx or an expired scan) ends Live mode.
    if (es.readyState === EventSource.CLOSED) {
      disableLive({ keepWanted: false });
      toast('Live stream closed — rescan and toggle Live to reconnect', 'error');
    }
  };
  $('tmLiveToggle').classList.add('active');
  $('tmLiveToggle').setAttribute('aria-pressed', 'true');
  fxTmPillBeamsSync(); // FX: the sm ring rides the same edge as the .active class
  live.feedTimer = setInterval(renderLiveFeed, 2000);
  live.relayoutTimer = setInterval(() => void liveRelayout(), LIVE_RELAYOUT_MS);
  renderLiveFeed();
}

function disableLive({ keepWanted = false } = {}) {
  const live = state.live;
  if (!keepWanted) live.wanted = false;
  if (!live.on) return;
  live.on = false;
  if (live.es) { live.es.close(); live.es = null; }
  clearInterval(live.feedTimer);
  clearInterval(live.relayoutTimer);
  // The spark's scroll loop is a Live-session client exactly like the
  // intervals above; the treemap's unmount reaches here too (keepWanted).
  fxLiveLineDrop();
  cancelAnimationFrame(live.pulseRaf);
  live.pulseRaf = 0;
  live.pulses.clear();
  live.window = [];
  $('tmLiveToggle').classList.remove('active');
  $('tmLiveToggle').setAttribute('aria-pressed', 'false');
  fxTmPillBeamsSync(); // FX: off through the same funnel every live exit uses
  $('liveFeed').hidden = true;
  if (state.view === 'treemap' && state.treemap.rootPath) presentView();
}

$('tmLiveToggle').addEventListener('click', () => {
  if (state.live.on) disableLive();
  else if (state.scanId && state.root) enableLive();
  else toast('Run a scan first — Live mode watches the scanned folder', 'error');
});

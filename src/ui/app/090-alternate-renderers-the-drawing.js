/* ═════════════ v4 §6.2 — Alternate renderers: the drawing ═════════════

   Two more lenses on the tree the sunburst already reads. They are NOT views:
   §6.2 asks for a segmented control in the Treemap view, and that is what they
   are, sharing its root, its breadcrumbs, its depth, its colour mode, its
   highlight box, its cart preview refusal and its export menu.

   Everything spatial here is derived from `state.treemap.cells`, one flat list
   in breadth-first order — which is also depth order, so drawing it front to
   back needs no sort. A cell is either a circle or a convex polygon and
   carries its own axis-aligned bounds, because the hit tester and §6.3's lasso
   both want to reject on a box before paying for the real shape.               */

/** The four renderers, and the two that draw from `state.treemap.cells`. */
const TM_MODES = ['treemap', 'sunburst', 'circles', 'voronoi'];
function isCells() { return state.treemap.mode === 'circles' || state.treemap.mode === 'voronoi'; }
function isRectMap() { return state.treemap.mode === 'treemap'; }

/**
 * Whatever the current renderer actually put on screen.
 *
 * Four renderers, three shapes, one question — "what is drawn right now?" —
 * asked by the reclaim-score fetch, the coverage note and §6.3's lasso. Each
 * of those grew its own `isSun() ? arcs : pxRects` ternary, and every new
 * renderer would have had to find all of them.
 */
function drawnCells() {
  if (isSun()) return state.treemap.arcs || [];
  if (isCells()) return state.treemap.cells || [];
  return state.treemap.pxRects || [];
}

/* ── Sizing, shared with the sunburst ─────────────────────────────────── */

/** Size the visible canvas and its offscreen buffer for the device pixel ratio. */
function tmSizeCanvas() {
  const wrap = $('treemapWrap');
  const cssW = wrap.clientWidth - 20;
  const cssH = treemapCanvasHeight(wrap);
  const dpr = window.devicePixelRatio || 1;
  tmCanvas.style.width = cssW + 'px';
  tmCanvas.style.height = cssH + 'px';
  const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
  if (tmCanvas.width !== pw) tmCanvas.width = pw;
  if (tmCanvas.height !== ph) tmCanvas.height = ph;
  if (tmBuffer.width !== pw) tmBuffer.width = pw;
  if (tmBuffer.height !== ph) tmBuffer.height = ph;
  return { cssW, cssH, dpr };
}

/** Children worth laying out: real bytes, and not hidden by the cloud filter. */
function altChildren(node) {
  if (!node || !node.children) return [];
  return node.children.filter((c) => c.size > 0 && !(state.treemap.hideCloud && c.cloudPlaceholder));
}

/**
 * Does this shape hold things the map is not showing?
 *
 * A folder drawn as a solid because the depth limit stopped there looks
 * exactly like a 13 GB file, and the two could hardly be more different. The
 * hatch says "there is more in here" in the same visual language §6.1 already
 * uses for a block that swallowed its children.
 */
function altHasMore(cell) {
  const n = cell.n;
  if (!cell.leaf || !n) return false;
  return n.type === 'dir' && (n.pruned === true || !!(n.children && n.children.length));
}

/** Axis-aligned bounds for a cell, computed once at layout time. */
function altBounds(cell) {
  if (cell.kind === 'circle') {
    return { x0: cell.cx - cell.r, x1: cell.cx + cell.r, y0: cell.cy - cell.r, y1: cell.cy + cell.r };
  }
  const b = polyBounds(cell.poly);
  return b;
}

/* ── Nested circle packing ────────────────────────────────────────────── */

// A circle under this radius has no room for children that could be told
// apart, and packing them anyway costs the frame budget for pixels nobody can
// resolve. A circle under the leaf radius is not drawn at all.
const ALT_PARENT_MIN_R = 13;
// Under a pixel and a bit a circle is an anti-aliasing artefact that can still
// be hovered — a hit target for something nobody can see. Counted and stated
// with everything else that did not fit, rather than drawn as a speck.
const ALT_MIN_LEAF_R = 1.3;
// The coverage gate's line (§2.5 close-out): a parent whose DRAWABLE children
// hold less than this share of its bytes is not subdivided — it stays a
// hatched leaf. 0.9 is the threshold HANDOFF.md's measurements were taken at:
// it catches both packs that broke the budget on the pathological folder, and
// it bounds the bead inflation the pre-filter below it can cause at
// √(1/0.9) ≈ 5.4% in radius. The one picture it costs is recorded as a test.
const ALT_COVERAGE_MIN = 0.9;
const ALT_CELL_BUDGET = 4000;

/**
 * Decide, without packing, whether subdividing a parent is worth what it
 * costs — and which children are worth handing to the pack at all.
 *
 * The estimate is r ≈ R·0.955·√(bytes/total): the child's byte share, as
 * area, inside the parent's usable radius. It can only OVER-state a radius —
 * a real pack's hull is never denser than area-perfect — so a child estimated
 * under ALT_MIN_LEAF_R is provably undrawable, and dropping it before the
 * pack changes nothing the post-pack filter would have kept. What it does
 * change is the cost: the measured pathology spent 740 ms packing 4,239
 * circles to draw 13 of them, and a folder holding one giant among thousands
 * of specks spent 80 ms to draw one.
 *
 * When the drawable children hold less than ALT_COVERAGE_MIN of the parent's
 * bytes the parent is not subdivided at all: a picture that is mostly empty
 * space is better told as a hatched leaf — this app's language for "there is
 * more in here" — with the children counted in the note, and drill-in showing
 * them at full size. Above the line, the survivors inflate by at most
 * √(1/ALT_COVERAGE_MIN) in radius from the specks' absence, which the
 * threshold bounds at ~5.4%.
 */
function altCoverageGate(kids, r) {
  let total = 0;
  for (const kid of kids) total += kid.size;
  if (!(total > 0)) {
    return { skip: true, packKids: [], omittedCount: kids.length, omittedBytes: 0 };
  }
  const estScale = r * 0.955; // 1 − the pack's own padding
  const floorShare = (ALT_MIN_LEAF_R / estScale) * (ALT_MIN_LEAF_R / estScale);
  const packKids = [];
  let drawableBytes = 0;
  let omittedCount = 0;
  let omittedBytes = 0;
  for (const kid of kids) {
    if (kid.size / total >= floorShare) {
      packKids.push(kid);
      drawableBytes += kid.size;
    } else {
      omittedCount++;
      omittedBytes += kid.size;
    }
  }
  if (drawableBytes / total < ALT_COVERAGE_MIN) {
    return { skip: true, packKids: [], omittedCount: kids.length, omittedBytes: total };
  }
  return { skip: false, packKids, omittedCount, omittedBytes };
}

function layoutCirclePack(root, geo, resume) {
  // A `resume` is the state a previous slice ran out of clock on: the queue of
  // parents still to subdivide, the cells laid so far, and the counters the
  // footnote is built from. §2.5's refinement loop hands it back one animation
  // frame later, so the picture finishes across frames instead of in one block.
  const S = resume || {
    cells: [], queue: [], omittedCount: 0, omittedBytes: 0, unresolved: 0, truncated: false,
  };
  const cells = S.cells;
  const queue = S.queue;
  if (!resume) {
    const R = Math.max(24, Math.min(geo.cssW, geo.cssH) / 2 - 14);
    const rootCell = { n: root, depth: 0, kind: 'circle', cx: geo.cssW / 2, cy: geo.cssH / 2, r: R, leaf: true };
    cells.push(rootCell);
    queue.push({ cell: rootCell, node: root });
  }
  const maxDepth = Math.max(1, Math.min(7, state.treemap.maxDepth));
  let { omittedCount, omittedBytes, unresolved, truncated } = S;
  const started = performance.now();
  let outOfTime = false;

  while (queue.length) {
    // Peeked, not shifted: a job the clock refuses stays queued for the next
    // slice rather than silently vanishing from the picture.
    const job = queue[0];
    if (job.cell.depth >= maxDepth || job.cell.r < ALT_PARENT_MIN_R) { queue.shift(); continue; }
    // The same clock the Voronoi solver runs under, and for the same reason:
    // the cell budget below bounds how many shapes come OUT of this loop, not
    // how long the packing that produces them takes. A single pack of 4,239
    // values into an 18-pixel radius was measured at 740 ms, and the cell
    // budget never saw it because the cost is spent before a cell exists.
    // Checked after the first level has been laid out, never before it, so a
    // slow machine yields a coarse picture rather than an empty one.
    if (job.cell.depth > 0 && performance.now() - started > ALT_LAYOUT_BUDGET_MS) { outOfTime = true; break; }
    queue.shift();
    const kids = altChildren(job.node);
    if (!kids.length) continue;
    // The gate first: a pack that would mostly produce specks is not run at
    // all, and provably-undrawable children never reach the one that is.
    const gate = altCoverageGate(kids, job.cell.r);
    omittedCount += gate.omittedCount;
    omittedBytes += gate.omittedBytes;
    if (gate.skip) continue;
    const packed = circlePackChildren(gate.packKids.map((k) => k.size), job.cell.r, { padding: 0.045 });
    if (!packed.circles.length) continue;
    omittedCount += packed.omitted;
    omittedBytes += packed.omittedValue;
    unresolved += packed.unresolved;
    job.cell.leaf = false;
    for (const c of packed.circles) {
      if (cells.length >= ALT_CELL_BUDGET) { truncated = true; break; }
      const kid = gate.packKids[c.i];
      if (c.r < ALT_MIN_LEAF_R) { omittedCount++; omittedBytes += kid.size; continue; }
      const cell = {
        n: kid, depth: job.cell.depth + 1, kind: 'circle',
        cx: job.cell.cx + c.x, cy: job.cell.cy + c.y, r: c.r, leaf: true,
      };
      cells.push(cell);
      queue.push({ cell, node: kid });
      // How much clear ring is left above the topmost child. This is where a
      // folder's own name can go without being written over its contents, and
      // it is only knowable here, while the children are being placed.
      const clear = (cell.cy - cell.r) - (job.cell.cy - job.cell.r);
      if (job.cell.topGap === undefined || clear < job.cell.topGap) job.cell.topGap = clear;
    }
    if (truncated) break;
  }
  for (const c of cells) { c.bb = altBounds(c); c.more = altHasMore(c); }
  S.omittedCount = omittedCount;
  S.omittedBytes = omittedBytes;
  S.unresolved = unresolved;
  S.truncated = truncated;
  return {
    cells,
    // The truncated break leaves the clock unfired, so this is exactly
    // "the queue is either empty or stopped for a reason no next slice fixes".
    done: !outOfTime,
    resume: S,
    note: altNoteFor({ omittedCount, omittedBytes, unresolved, truncated, outOfTime, drawn: cells.length }),
  };
}

/* ── Weighted centroidal Voronoi ──────────────────────────────────────── */

// Below this a cell cannot hold a legible child layout, and subdividing it
// spends the iteration budget on shapes two millimetres across.
const ALT_VORONOI_MIN_AREA = 8500;
/* §6.2's hard cap, at the level above the per-layout one.
   Checked BEFORE each nested layout, so the true worst case is this plus one
   layout. 45 ms rather than the 150 it shipped at, because the binding budget
   was never the 250 ms first paint — it is §2.5's 50 ms ceiling on a single
   main-thread block, and with the refinement loop in `buildCells` the clock
   now ends a SLICE, not the layout: the queue comes back one animation frame
   later and the picture fills in across frames, each block under this
   ceiling, until nothing is left to subdivide. The coverage gate above bounds
   what any one pack inside a slice can cost.

   It applies to BOTH solvers. It used to be Voronoi's alone, on the reasoning
   recorded in `buildCells` that the Voronoi solver "is the only thing in this
   file that could plausibly spend" the 250 ms budget. That was measured and
   is false: `layoutCirclePack` had no clock on it at all, and on
   `~/Library/Application Support/Claude` it spent **1,102 ms** in one
   synchronous block — four times the whole first-paint budget and five times
   what the capped solver beside it is allowed. Two nested packs accounted for
   1,089 ms of it. §6.2 asks for a hard cap so "a pathological input cannot
   hang the frame"; a cap that only one of the two renderers honours is not
   that.                                                                     */
const ALT_LAYOUT_BUDGET_MS = 45;

function layoutVoronoi(root, geo, resume) {
  // Resumable for the same reason as `layoutCirclePack` above: a slice that
  // runs out of clock returns its queue, and §2.5's refinement loop finishes
  // the picture across frames rather than in one main-thread block.
  const S = resume || {
    cells: [], queue: [], omittedCount: 0, omittedBytes: 0, worstError: 0,
    allConverged: true, truncated: false,
  };
  const cells = S.cells;
  const queue = S.queue;
  if (!resume) {
    const pad = 8;
    const boundary = [
      { x: pad, y: pad }, { x: geo.cssW - pad, y: pad },
      { x: geo.cssW - pad, y: geo.cssH - pad }, { x: pad, y: geo.cssH - pad },
    ];
    const rootCell = { n: root, depth: 0, kind: 'poly', poly: boundary, leaf: true, area: Math.abs(polyArea(boundary)) };
    cells.push(rootCell);
    queue.push({ cell: rootCell, node: root });
  }
  // Nesting stops at three levels whatever the depth selector says. A fourth
  // level of Voronoi is visually mush — the cells are smaller than their own
  // borders — and it is where the iteration budget goes to die.
  const maxDepth = Math.max(1, Math.min(3, state.treemap.maxDepth));
  const started = performance.now();
  let { omittedCount, omittedBytes, worstError, allConverged, truncated } = S;
  let outOfTime = false;

  while (queue.length) {
    // Peeked, not shifted — an out-of-clock job belongs to the next slice.
    const job = queue[0];
    const depth = job.cell.depth;
    if (depth >= maxDepth) { queue.shift(); continue; }
    if (depth > 0 && job.cell.area < ALT_VORONOI_MIN_AREA) { queue.shift(); continue; }
    if (performance.now() - started > ALT_LAYOUT_BUDGET_MS) { outOfTime = true; break; }
    queue.shift();
    const kids = altChildren(job.node);
    if (!kids.length) continue;
    // Only the cell count is set here. The iteration budget belongs to the
    // solver, which sizes it from n — a nested layout is usually a handful of
    // cells and wants MORE passes than the top level, not fewer, because they
    // are nearly free and it is the only way its areas come out right.
    const res = voronoiTreemap(kids.map((k) => k.size), job.cell.poly, {
      maxCells: depth === 0 ? 96 : 24,
      // A nested cell is small, so the floor that makes something legible
      // inside it is larger in proportion — and fewer, bigger cells is also
      // what lets a nested level reach its tolerance rather than running out
      // of passes and reporting a number nobody wants to read.
      minCellArea: depth === 0 ? 100 : 170,
    });
    if (!res.cells.length) continue;
    omittedCount += res.omitted;
    omittedBytes += res.omittedValue;
    if (res.maxError > worstError) worstError = res.maxError;
    if (!res.converged) allConverged = false;
    job.cell.leaf = false;
    for (const c of res.cells) {
      if (cells.length >= ALT_CELL_BUDGET) { truncated = true; break; }
      const kid = kids[c.i];
      const centre = polyCentroid(c.poly) || { x: 0, y: 0 };
      const cell = {
        n: kid, depth: depth + 1, kind: 'poly', poly: c.poly, area: c.area,
        cx: centre.x, cy: centre.y, leaf: true,
      };
      cells.push(cell);
      queue.push({ cell, node: kid });
    }
    if (truncated) break;
  }
  for (const c of cells) {
    c.bb = altBounds(c);
    c.more = altHasMore(c);
    if (c.cx === undefined) { const m = polyCentroid(c.poly) || { x: 0, y: 0 }; c.cx = m.x; c.cy = m.y; }
  }
  S.omittedCount = omittedCount;
  S.omittedBytes = omittedBytes;
  S.worstError = worstError;
  S.allConverged = allConverged;
  S.truncated = truncated;
  return {
    cells,
    done: !outOfTime,
    resume: S,
    note: altNoteFor({
      omittedCount, omittedBytes, truncated, outOfTime, drawn: cells.length,
      converged: allConverged, worstError,
    }),
  };
}

/**
 * The footnote under the map.
 *
 * §6.2 asks for one specific sentence — "if the tolerance is not met within
 * the cap, render what converged and say so" — and §2.4 asks for the rest of
 * them. A renderer that drops a thousand small folders, or stops iterating
 * with the areas still 9% out, has changed what the picture means, and the
 * picture has to admit it. Silence here is the same defect as a zero standing
 * in for an unavailable number.
 */
function altNoteFor(info) {
  const bits = [];
  if (info.omittedCount > 0) {
    bits.push(
      `${formatCount(info.omittedCount)} item${info.omittedCount === 1 ? '' : 's'} ` +
      `(${formatBytes(info.omittedBytes)}) too small to draw at this size — drill in to see them`
    );
  }
  if (info.truncated) bits.push(`stopped at ${formatCount(ALT_CELL_BUDGET)} shapes`);
  if (info.outOfTime) bits.push(`stopped subdividing after ${ALT_LAYOUT_BUDGET_MS} ms — drill in for more detail`);
  if (info.converged === false) {
    bits.push(
      `areas are approximate: the solver hit its iteration cap with the worst cell ` +
      `${(info.worstError * 100).toFixed(1)}% off its true share`
    );
  }
  if (info.unresolved > 0) {
    bits.push(`${formatCount(info.unresolved)} circle${info.unresolved === 1 ? '' : 's'} could not be placed without overlapping`);
  }
  return bits.join(' · ');
}

function renderAltNote() {
  const host = $('tmAltNote');
  if (!host) return;
  const note = state.treemap.altNote;
  host.textContent = note || '';
  host.hidden = !note;
}

/* ── Drawing ──────────────────────────────────────────────────────────── */

/** Trace a cell's outline, whichever shape it is. */
function altCellPath(ctx, c) {
  if (c.kind === 'circle') {
    ctx.beginPath();
    ctx.arc(c.cx, c.cy, Math.max(0.4, c.r), 0, Math.PI * 2);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(c.poly[0].x, c.poly[0].y);
  for (let i = 1; i < c.poly.length; i++) ctx.lineTo(c.poly[i].x, c.poly[i].y);
  ctx.closePath();
}

/**
 * Build the layout for the current alternate renderer.
 *
 * Timed, and the timing is kept, because §2.5 gives a new canvas view 250 ms
 * to first paint and both solvers here can spend it.
 *
 * This comment used to say the Voronoi solver was "the only thing in this file
 * that could plausibly spend it", and that sentence is why `layoutCirclePack`
 * shipped with no clock on it. It was wrong by a factor of four: measured at
 * 1,102 ms on `~/Library/Application Support/Claude`, against 55–198 ms for
 * the capped solver on the same tree. The lesson is the one this repo keeps
 * relearning — a budget that is reasoned about rather than measured is not a
 * budget, and `altMs` exists precisely so the reasoning can be checked.
 */
function buildCells(geo) {
  const root = sunburstRoot();
  altRefineCancel();
  if (!root) { state.treemap.cells = []; state.treemap.altNote = ''; return; }
  const t0 = performance.now();
  const out = state.treemap.mode === 'circles' ? layoutCirclePack(root, geo) : layoutVoronoi(root, geo);
  state.treemap.cells = out.cells;
  state.treemap.altNote = out.done ? out.note : altRefiningNote(out.cells.length);
  // The cost of THIS slice — the block a user gesture actually paid — not the
  // eventual total. §2.5's 50 ms rule is about blocks, and this is the block.
  state.treemap.altMs = performance.now() - t0;
  if (!out.done) altRefineSchedule(root, geo, out.resume);
  fxShapeSync(!out.done); // FX: the shaping chip is up while slices remain
}

/* ── §2.5's refinement loop ──────────────────────────────────────────────
   The layout clock used to be the end of the story: a tree with more detail
   than the budget buys was drawn coarse, permanently, with a footnote. Now
   the clock only ends the SLICE — the layout returns its queue, and this loop
   hands it back one animation frame later, repainting as the picture fills
   in. Every individual block stays under the clock; nothing is lost; the
   footnote says "still laying out" while it is true and settles to the
   layout's own last word when it is not. Cancelled by the next buildCells
   (a resize, a drill, a renderer switch), by setTreemapView, and by the
   view's unmount — the same three doors the zoom transition uses.          */
let altRefineSeq = 0;

function altRefiningNote(drawn) {
  return `still laying out — ${formatCount(drawn)} shapes so far`;
}

function altRefineCancel() {
  altRefineSeq++;
  if (state.treemap.altRaf) { cancelAnimationFrame(state.treemap.altRaf); state.treemap.altRaf = 0; }
  // FX: every door out of the refinement loop — the next buildCells, a
  // renderer switch, the view's unmount — also takes the shaping orb with it.
  fxShapeSync(false);
}

function altRefineSchedule(root, geo, resume) {
  const seq = ++altRefineSeq;
  const mode = state.treemap.mode;
  state.treemap.altRaf = requestAnimationFrame(() => {
    state.treemap.altRaf = 0;
    if (seq !== altRefineSeq || state.view !== 'treemap' || state.treemap.mode !== mode || !isCells()) return;
    // The drill-in transition owns the canvas while it runs; keep the queue
    // warm and try again next frame rather than repainting under it.
    if (state.treemap.altZoomRaf) { altRefineSchedule(root, geo, resume); return; }
    const out = mode === 'circles' ? layoutCirclePack(root, geo, resume) : layoutVoronoi(root, geo, resume);
    state.treemap.cells = out.cells;
    state.treemap.altNote = out.done ? out.note : altRefiningNote(out.cells.length);
    repaintCells();
    renderAltNote();
    if (!out.done) altRefineSchedule(root, geo, out.resume);
    fxShapeSync(!out.done); // FX: the chip settles the moment the queue does
  });
}

/* ── v4 §6.2 — the zoom between levels ────────────────────────────────────

   "Animate the zoom transition between levels", and the reason it earns its
   place is that circle packing hides WHERE you went. A treemap keeps a child
   roughly where its parent's rectangle was; a packing re-solves from scratch,
   so drilling into a bead produces a completely new arrangement with no
   inherited geometry at all. Without the transition, one click replaces the
   whole picture and the only way to know what you are looking at is the
   breadcrumb.

   The whole animation is one affine transform over the finished layout —
   nothing is re-solved per frame, which is what keeps it inside the frame
   budget on a map that took a few milliseconds to lay out. It runs from the
   position the shared node USED to occupy on screen to the position it
   occupies now, and that one rule covers both directions: drilling in, the
   shared node is the new root and it grows out of the bead you clicked;
   climbing out, the shared node is the old root and the panel shrinks back
   into it.

   Skipped entirely under `prefers-reduced-motion` — skipped, not shortened.  */
const ALT_ZOOM_MS = 340;

/** Where a path sits in the current layout, if it is drawn at all. */
function altCircleFor(path) {
  for (const c of state.treemap.cells) {
    if (c.n.path === path && c.kind === 'circle') return { cx: c.cx, cy: c.cy, r: c.r };
  }
  return null;
}

/**
 * Start the transition, given where the shared node was before the rebuild.
 *
 * Returns false when there is nothing to animate — a jump between unrelated
 * folders, a node that was not on screen, or a reduced-motion preference — so
 * the caller can simply paint the new layout.
 */
function altBeginZoom(sharedPath, wasAt) {
  const z = state.treemap;
  z.altZoom = null;
  /* `document.hidden` matters MORE here than anywhere else in this file.
     A hidden tab runs no frames, so `altRunZoom` would never clear `altZoom` —
     and `presentCells` deliberately sits out the hover ring, the budget borders
     and the keyboard cursor for as long as a transition is running. A drill
     performed while the tab was hidden therefore left those three overlays
     suppressed permanently, long after the user came back. Measured: 2.6
     seconds after a drill, `altZoomRaf` was still set and `altZoom` still
     truthy. There is nothing to animate anyway when nobody is watching. */
  if (REDUCED || document.hidden || !wasAt || !sharedPath) return false;
  const now = altCircleFor(sharedPath);
  if (!now || !(now.r > 0) || !(wasAt.r > 0)) return false;
  const k = wasAt.r / now.r;
  // A transition that barely moves is a flicker, not a transition.
  if (Math.abs(k - 1) < 0.04 && Math.hypot(now.cx - wasAt.cx, now.cy - wasAt.cy) < 6) return false;
  z.altZoom = { k, from: wasAt, to: now, start: performance.now() };
  altRunZoom();
  return true;
}

function altRunZoom() {
  const z = state.treemap;
  if (z.altZoomRaf) cancelAnimationFrame(z.altZoomRaf);
  const step = () => {
    if (state.view !== 'treemap' || !isCells() || !z.altZoom) { z.altZoomRaf = 0; return; }
    // Hidden after the transition began — no entry check can cover that, and
    // leaving `altZoom` set would keep the overlays suppressed for good.
    if (document.hidden) { z.altZoom = null; z.altZoomRaf = 0; paintCells(); return; }
    const t = Math.min(1, (performance.now() - z.altZoom.start) / ALT_ZOOM_MS);
    z.altZoom.t = 1 - Math.pow(1 - t, 3); // easeOutCubic: quick, then settles
    paintCells();
    if (t < 1) { z.altZoomRaf = requestAnimationFrame(step); return; }
    z.altZoom = null;
    z.altZoomRaf = 0;
    paintCells();
  };
  z.altZoomRaf = requestAnimationFrame(step);
}

/**
 * Apply the transition's transform, if one is running.
 *
 * At `t = 0` the shared node is drawn exactly where it used to be, at `t = 1`
 * the transform is the identity and the layout is drawn as laid out.
 */
function altZoomTransform(ctx, dpr) {
  const z = state.treemap.altZoom;
  if (!z) return;
  const t = z.t || 0;
  const k = z.k + (1 - z.k) * t;
  const cx = z.from.cx + (z.to.cx - z.from.cx) * t;
  const cy = z.from.cy + (z.to.cy - z.from.cy) * t;
  ctx.translate(cx - k * z.to.cx, cy - k * z.to.cy);
  ctx.scale(k, k);
}

/** Repaint the existing layout — no solve, no re-layout. Used by the transition. */
function paintCells() {
  const geo = tmSizeCanvas();
  const ctx = tmBufCtx;
  ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
  ctx.clearRect(0, 0, geo.cssW, geo.cssH);
  ctx.fillStyle = cssVar('--tm-canvas-bg');
  ctx.fillRect(0, 0, geo.cssW, geo.cssH);
  ctx.save();
  altZoomTransform(ctx, geo.dpr);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  const circles = state.treemap.mode === 'circles';
  for (const c of state.treemap.cells) {
    if (circles) drawPackedCircle(ctx, c); else drawVoronoiCell(ctx, c);
  }
  altDrawLabels(ctx, state.treemap.cells);
  ctx.restore();
  presentCells();
}

function drawCells() {
  const geo = tmSizeCanvas();
  const ctx = tmBufCtx;
  buildCells(geo);
  ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
  ctx.clearRect(0, 0, geo.cssW, geo.cssH);
  ctx.fillStyle = cssVar('--tm-canvas-bg');
  ctx.fillRect(0, 0, geo.cssW, geo.cssH);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';

  const cells = state.treemap.cells;
  const circles = state.treemap.mode === 'circles';

  // Breadth-first order is depth order, so a plain forward pass paints parents
  // before their children with no sort — the same reason §6.1's draw order is
  // computed once per layout rather than per frame.
  for (const c of cells) {
    if (circles) drawPackedCircle(ctx, c);
    else drawVoronoiCell(ctx, c);
  }
  altDrawLabels(ctx, cells);

  // The overlay first: it calls `updateTmStatus`, which deliberately writes
  // nothing for this renderer, so the line below is the last word.
  renderSearchOverlay();
  renderCellsStatus();
  presentCells();
  renderTmLegend();
  renderAltNote();
}

/**
 * The diagonal hatch that means "there is more inside this than is drawn".
 *
 * Deliberately the same marking, and the same weight, as §6.1's aggregated
 * block: white diagonals at low alpha rather than the amber pattern §4.3 uses
 * for freed space, because those are two different claims and the map must not
 * blur them. Clipped to the shape, so it never leaks onto a neighbour.
 */
function altDrawMore(ctx, c) {
  const b = c.bb;
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  if (w < 13 || h < 13) return; // no room for two lines; the tooltip still says so
  ctx.save();
  altCellPath(ctx, c);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.34)';
  ctx.lineWidth = 1;
  const step = Math.max(5, Math.min(9, Math.round(Math.min(w, h) / 6)));
  for (let x = b.x0 - h; x < b.x1; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, b.y1);
    ctx.lineTo(x + h, b.y0);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * One packed circle.
 *
 * A leaf is a bead, lit from the upper left by the same light the rest of the
 * app uses; a folder is a rim and a shadowed inner edge, so its children read
 * as sitting *in* it. The gradient is the whole difference between a scatter
 * of flat discs and something with volume, and it costs one extra fill per
 * circle, gated on a radius where the shading is actually resolvable.
 *
 * **Every colour here comes from the cell's own hue, never from white.** The
 * first version rimmed folders in `rgba(255,255,255,…)`, which is invisible on
 * the light theme's near-white canvas — and worse, filling each folder with a
 * translucent wash stacked one alpha per level on nearly concentric circles
 * and turned a deep tree into a bullseye. A rim and an inner shading ring say
 * "container" without adding a single flat layer over what is inside it.
 */
function drawPackedCircle(ctx, c) {
  const r = c.r;
  if (r < 1.1) return; // smaller than a rounding error, and it would only alias
  const base = c.n.isTrash ? [108, 122, 137] : cellRgb(c.n);

  if (!c.leaf) {
    if (r < 3.5) return;
    // Ambient occlusion at the rim: nothing in the middle, where the children
    // are, and a touch of shade at the edge. This is what reads as depth.
    if (r > 24) {
      const g = ctx.createRadialGradient(c.cx, c.cy, r * 0.8, c.cx, c.cy, r);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.16)');
      ctx.beginPath();
      ctx.arc(c.cx, c.cy, r, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
    }
    const rim = mix(base, [0, 0, 0], 0.35);
    ctx.beginPath();
    ctx.arc(c.cx, c.cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${rim[0]},${rim[1]},${rim[2]},${Math.max(0.25, 0.62 - c.depth * 0.09)})`;
    ctx.lineWidth = c.depth === 0 ? 1.6 : 1.1;
    ctx.stroke();
    return;
  }

  ctx.beginPath();
  ctx.arc(c.cx, c.cy, r, 0, Math.PI * 2);
  if (r >= 5) {
    // Light from the upper left: the highlight sits a third of the way in and
    // the far edge falls to a darkened version of the cell's OWN colour rather
    // than to grey, so the hue keeps carrying the meaning it was chosen for.
    const g = ctx.createRadialGradient(
      c.cx - r * 0.36, c.cy - r * 0.4, r * 0.05,
      c.cx, c.cy, r * 1.06,
    );
    const lit = mix(base, [255, 255, 255], 0.34);
    const shade = mix(base, [0, 0, 0], 0.3);
    g.addColorStop(0, `rgb(${lit[0]},${lit[1]},${lit[2]})`);
    g.addColorStop(0.55, `rgb(${base[0]},${base[1]},${base[2]})`);
    g.addColorStop(1, `rgb(${shade[0]},${shade[1]},${shade[2]})`);
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
  }
  ctx.fill();
  if (r > 3) {
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  if (c.more) altDrawMore(ctx, c);
  // The specular arc along the lit edge. Only where there are pixels for it.
  if (r > 9) {
    ctx.beginPath();
    ctx.arc(c.cx, c.cy, r * 0.86, Math.PI * 1.05, Math.PI * 1.75);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = Math.min(2, r * 0.09);
    ctx.stroke();
  }
}

/**
 * One Voronoi cell.
 *
 * The inset stroke is what makes a field of polygons read as tiles rather than
 * as a wireframe: a second outline a pixel or two inside the first, lighter,
 * so each cell has a bevel. It is drawn with the same `polyClip` the diagram
 * itself is built from — an inset of a convex polygon is that polygon clipped
 * by each of its own edges, moved inward — so there is one piece of geometry
 * here rather than two that have to be kept in step.
 */
function drawVoronoiCell(ctx, c) {
  if (c.poly.length < 3) return;
  if (!c.leaf) {
    if (c.depth === 0) return; // the panel edge; the cells fill it entirely
    // Parent outlines are drawn from the folder's own colour for the same
    // reason the circles are: a white line vanishes on the light theme.
    const rim = mix(c.n.isTrash ? [108, 122, 137] : cellRgb(c.n), [0, 0, 0], 0.45);
    altCellPath(ctx, c);
    ctx.strokeStyle = `rgba(${rim[0]},${rim[1]},${rim[2]},${Math.max(0.35, 0.85 - c.depth * 0.18)})`;
    ctx.lineWidth = Math.max(1.2, 3 - c.depth * 0.7);
    ctx.stroke();
    return;
  }
  const base = c.n.isTrash ? [108, 122, 137] : cellRgb(c.n);
  const b = c.bb;
  altCellPath(ctx, c);
  const g = ctx.createLinearGradient(b.x0, b.y0, b.x0, b.y1);
  const top = mix(base, [255, 255, 255], 0.17);
  const bot = mix(base, [0, 0, 0], 0.2);
  g.addColorStop(0, `rgb(${top[0]},${top[1]},${top[2]})`);
  g.addColorStop(1, `rgb(${bot[0]},${bot[1]},${bot[2]})`);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.42)';
  ctx.lineWidth = 1;
  ctx.stroke();

  if ((b.x1 - b.x0) > 26 && (b.y1 - b.y0) > 26) {
    const inner = polyInset(c.poly, 2.5);
    if (inner.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(inner[0].x, inner[0].y);
      for (let i = 1; i < inner.length; i++) ctx.lineTo(inner[i].x, inner[i].y);
      ctx.closePath();
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  if (c.more) altDrawMore(ctx, c);
}

/**
 * Names, on the cells with room for them.
 *
 * Drawn in a pass of their own after every shape is down, because in both
 * renderers a child is painted over its parent: a label written inline would
 * be half-covered by the very children it is meant to name.
 */
function altDrawLabels(ctx, cells) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const c of cells) {
    const b = c.bb;
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    // A folder's name goes on its own rim, in the clear band above its topmost
    // child — never through the middle, which belongs to its contents. Without
    // this a chain of nested folders is a set of anonymous rings, and the one
    // question the picture should answer at a glance ("what is this?") needs a
    // hover for every level.
    if (!c.leaf) {
      if (c.kind !== 'circle' || !(c.topGap >= 15) || c.r < 26) continue;
      ctx.font = '600 11px -apple-system, sans-serif';
      const chord = 2 * Math.sqrt(Math.max(0, c.r * c.r - Math.pow(c.r - c.topGap / 2, 2)));
      const label = Canvas2D.fitText(ctx, c.n.name, Math.min(chord * 0.9, c.r * 1.7));
      if (!label || label.replace(/…$/, '').length < Math.min(4, c.n.name.length)) continue;
      const ry = c.cy - c.r + c.topGap / 2;
      // A ring label sits on the PANEL, not on a coloured fill, so it takes the
      // theme's own text colour haloed in the theme's own background. White on
      // a dark halo is right over a bead and unreadable over the light theme's
      // near-white canvas, which is exactly where these labels live.
      ctx.lineWidth = 3;
      ctx.strokeStyle = cssVar('--bg-1') || '#0c0d14';
      ctx.strokeText(label, c.cx, ry);
      ctx.fillStyle = cssVar('--text-2') || 'rgba(255,255,255,0.7)';
      ctx.fillText(label, c.cx, ry);
      continue;
    }
    if (w < 34 || h < 16) continue;
    const room = c.kind === 'circle' ? c.r * 1.5 : w * 0.82;
    ctx.font = '600 11px -apple-system, sans-serif';
    const name = Canvas2D.fitText(ctx, c.n.name, room);
    if (!name || name.replace(/…$/, '').length < Math.min(4, c.n.name.length)) continue;
    const twoLines = h > 34 && (c.kind === 'circle' ? c.r > 22 : true);
    const y = twoLines ? c.cy - 6 : c.cy;
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.42)';
    ctx.strokeText(name, c.cx, y);
    ctx.fillStyle = 'rgba(255,255,255,0.97)';
    ctx.fillText(name, c.cx, y);
    if (twoLines) {
      ctx.font = '10px -apple-system, sans-serif';
      const size = Canvas2D.fitText(ctx, formatBytes(c.n.size), room);
      if (size) {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.42)';
        ctx.strokeText(size, c.cx, c.cy + 8);
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fillText(size, c.cx, c.cy + 8);
      }
    }
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/**
 * Redraw §6.2's renderers without re-solving them.
 *
 * Colour is the only thing a theme change moves, and the layout is in canvas
 * pixels that have not shifted — so re-running the solver would spend up to a
 * fifth of a second arriving at the arrangement already on screen. §2.5 gives a
 * single UI action 50 ms of main thread; a theme toggle in the Voronoi
 * renderer was measured at nearly four times that, all of it recomputing an
 * answer it already had.
 *
 * The overlay is re-rendered because its scrim colour IS theme-dependent.
 */
function repaintCells() {
  if (!isCells()) return;
  renderSearchOverlay();
  renderCellsStatus();
  paintCells();
}

/**
 * The status line for §6.2's renderers.
 *
 * Its own function because `updateTmStatus` deliberately writes nothing here —
 * "nodes drawn" is not a true sentence about circles or Voronoi cells — and
 * something therefore has to put the line back whenever a query clears it.
 * Doing that by re-running `drawCells` would re-solve a layout that can take a
 * fifth of a second, to update one line of text.
 */
function renderCellsStatus() {
  const st = $('tmStatus');
  if (!st || !isCells()) return;
  if (state.treemap.query.trim() || state.treemap.history.active || tmPreview.on) return;
  const cells = state.treemap.cells;
  const leaves = cells.reduce((k, c) => k + (c.leaf ? 1 : 0), 0);
  st.textContent =
    `${formatCount(Math.max(0, cells.length - 1))} shape${cells.length === 2 ? '' : 's'} · ` +
    `${formatCount(leaves)} without children · ${formatBytes(state.treemap.rootSize)} total`;
}

/** Blit the buffer, then the overlays that change without a re-layout. */
function presentCells() {
  const dpr = window.devicePixelRatio || 1;
  tmCtx.setTransform(1, 0, 0, 1, 0, 0);
  tmCtx.clearRect(0, 0, tmCanvas.width, tmCanvas.height);
  tmCtx.drawImage(tmBuffer, 0, 0);
  tmCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (state.treemap.query.trim()) {
    /* The dim-and-outline overlay is a bitmap of the layout, so during §6.2's
       level transition it has to move with the layout. `tmBuffer` already has
       the transform baked in — `paintCells` applied it while drawing — but the
       search buffer is rendered once, unmoved, and compositing it flat would
       park the scrim over a map sliding out from under it. */
    tmCtx.save();
    if (state.treemap.altZoom) altZoomTransform(tmCtx, dpr);
    tmCtx.drawImage(tmSearchBuffer, 0, 0, tmSearchBuffer.width / dpr, tmSearchBuffer.height / dpr);
    tmCtx.restore();
  }
  // While the level transition is running the layout is drawn through a
  // transform these overlays do not share, so a hover ring or a budget border
  // would sit somewhere the shape it belongs to is not. They are back a third
  // of a second later, on a picture that has stopped moving.
  if (state.treemap.altZoom) { drawLivePulses(); lassoPaint(tmCtx); return; }

  const h = state.treemap.hover;
  if (h && h.kind) {
    altCellPath(tmCtx, h);
    tmCtx.fillStyle = 'rgba(255,255,255,0.14)';
    tmCtx.fill();
    tmCtx.strokeStyle = cssVar('--accent') || '#0A84FF';
    tmCtx.lineWidth = 2;
    tmCtx.stroke();
  }
  const over = state.budgets.overPaths;
  if (over && over.size) {
    tmCtx.setLineDash([5, 3]);
    tmCtx.strokeStyle = cssVar('--danger') || '#FF453A';
    tmCtx.lineWidth = 2;
    for (const c of state.treemap.cells) {
      if (!over.has(c.n.path)) continue;
      altCellPath(tmCtx, c);
      tmCtx.stroke();
    }
    tmCtx.setLineDash([]);
  }
  const ks = state.treemap.kbSel;
  if (ks) {
    const cell = state.treemap.cells.find((c) => c.n.path === ks.path);
    if (cell) {
      altCellPath(tmCtx, cell);
      tmCtx.setLineDash([6, 3]);
      tmCtx.strokeStyle = '#fff';
      tmCtx.lineWidth = 2;
      tmCtx.stroke();
      tmCtx.setLineDash([]);
    }
  }
  drawLivePulses();
  lensPaint(tmCtx, tmCanvas.width / dpr, tmCanvas.height / dpr);
  lassoPaint(tmCtx);
}

/** The deepest cell under a point — so a click lands on the file, not its folder. */
function cellsHit(clientX, clientY) {
  const { x, y } = Canvas2D.toLocal(tmCanvas, clientX, clientY);
  let best = null;
  for (const c of state.treemap.cells) {
    if (x < c.bb.x0 || x > c.bb.x1 || y < c.bb.y0 || y > c.bb.y1) continue;
    if (c.kind === 'circle') {
      const dx = x - c.cx, dy = y - c.cy;
      if (dx * dx + dy * dy > c.r * c.r) continue;
    } else if (!polyContains(c.poly, x, y)) continue;
    if (!best || c.depth > best.depth) best = c;
  }
  return best;
}

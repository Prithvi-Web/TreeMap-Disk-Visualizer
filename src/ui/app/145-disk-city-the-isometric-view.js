/* ═══════════ Disk City — the isometric view (v4 §6.1) ═══════════
   The same squarified tiling the Treemap draws, seen from a corner. That is
   the point of it: a flat treemap encodes exactly one variable in area, and
   this encodes three — footprint is bytes, height is staleness (or file count,
   or depth), colour is reclaim score (or type, or age). "The tall grey tower
   is a 40 GB thing you have not opened in two years" reads instantly in a way
   a red rectangle never does.

   It shares `state.treemap.rootPath` and `state.treemap.nodes` with the
   Treemap deliberately, and that is the strongest claim this view makes: the
   two are not similar arrangements, they are the *same* arrangement, so
   switching between them is legible rather than disorienting and needs no
   refetch. Drilling in either moves both.

   All Canvas 2D. §7 rules out WebGL and a 3D engine by name, and nothing here
   needs one: the projection is a 2D affine transform.                       */

/* ── The projection, and the one hard problem in it ────────────────────────

   `sx = (x - y)·cos30`, `sy = (x + y)·sin30 - z`, exactly as §6.1 states.

   Draw order is the part that is easy to get subtly wrong. Painter's
   algorithm needs far-to-near, and the obvious approach — sort each box by
   some scalar depth — **cannot be correct**, which was measured rather than
   assumed. Four candidate keys were driven against an exact oracle (ray-cast
   along the view direction at sampled points inside each pair's shared
   silhouette) over six layouts:

     key            uniform grid   squarified   big + slivers
     minCornerSum        0              0..2          0
     centreSum           0              0..1         11
     farCornerSum        0              0..3         56
     maxOfMax            0              0..3         59

   The failures all have one shape: a wide, shallow strip whose *minimum*
   corner sits far from where it actually overlaps its neighbour. No per-box
   number can express that, which is the classic painter's problem.

   What IS exact — and this was checked against the same ray-cast oracle over
   779 overlapping pairs in six layouts, with **zero** disagreements and zero
   ambiguous cases — is the pairwise rule below: for two boxes on a common
   ground plane with non-overlapping footprints (which a treemap guarantees),
   A is behind B exactly when A ends before B begins on either axis. Sorting
   that relation topologically is therefore correct, not approximately correct.

   It is computed **once per layout**, never per frame, exactly as §6.1 asks —
   panning and zooming re-use the order and only move the camera.            */

/** §6.1's projection, verbatim. Called once per corner per layout, not per frame. */
function isoProject(x, y, z) {
  return { sx: (x - y) * Math.cos(Math.PI / 6), sy: (x + y) * Math.sin(Math.PI / 6) - z };
}

/**
 * The screen-space bounding box of an extruded block `{x, y, w, h, z}`.
 *
 * Only the four corners that can be extreme are projected: in this projection
 * the leftmost point is always the far-y corner and the rightmost the far-x
 * one, the top is the raised near corner and the bottom the ground corner.
 */
function isoBounds(b) {
  const left = isoProject(b.x, b.y + b.h, 0);
  const right = isoProject(b.x + b.w, b.y, 0);
  const top = isoProject(b.x, b.y, b.z);
  const bottom = isoProject(b.x + b.w, b.y + b.h, 0);
  return { x0: left.sx, x1: right.sx, y0: top.sy, y1: bottom.sy };
}

/**
 * Is `a` strictly behind `b`?
 *
 * The exact rule, for boxes whose footprints do not overlap. Verified against
 * a ray-cast oracle on every overlapping pair of six layouts.
 */
function isoBehind(a, b) {
  return (a.x + a.w <= b.x + 1e-9) || (a.y + a.h <= b.y + 1e-9);
}

/**
 * Far-to-near draw order.
 *
 * Kahn's algorithm over the occlusion relation, with edges only between boxes
 * whose screen bounding boxes actually overlap — a full pairwise pass would be
 * O(n²) on a set that can run to a few thousand. Candidates come from a
 * uniform grid over screen space, so the edge count is proportional to how
 * much the picture actually overlaps itself rather than to n².
 *
 * Ties break on `x + y` so the order is stable frame to frame and layout to
 * layout: an unstable tie-break makes equal-depth blocks swap places on every
 * redraw, which reads as flicker.
 *
 * A cycle cannot arise from non-overlapping footprints, but a numerical edge
 * case is not worth a wrong picture: anything Kahn cannot place is appended in
 * tie-break order and counted, so `isoDepthOrder` can never drop a block.
 */
function isoDepthOrder(blocks) {
  const n = blocks.length;
  if (n < 2) return { order: blocks.slice(), unresolved: 0 };

  const bounds = blocks.map(isoBounds);

  // ── edges, by sweep line ──
  // A uniform grid was tried first and is the wrong structure here: one big
  // folder's block spans most of the screen, lands in thousands of cells, and
  // is then re-tested against its neighbours once per shared cell. Measured at
  // 4,000 blocks that took 3.5 SECONDS. A sweep over x tests every pair
  // exactly once instead, and only pairs that actually share screen columns.
  const byLeft = Array.from({ length: n }, (_, i) => i).sort((a, b) => bounds[a].x0 - bounds[b].x0 || a - b);
  const after = new Array(n).fill(null);
  const indegree = new Int32Array(n);
  const active = [];

  for (const i of byLeft) {
    const bi = bounds[i];
    // Drop anything whose right edge is already behind this block's left one:
    // it can never overlap this block or any later one.
    let keep = 0;
    for (let k = 0; k < active.length; k++) {
      const j = active[k];
      if (bounds[j].x1 > bi.x0) active[keep++] = j;
    }
    active.length = keep;

    for (let k = 0; k < active.length; k++) {
      const j = active[k];
      const bj = bounds[j];
      if (bi.y1 <= bj.y0 || bj.y1 <= bi.y0) continue; // no vertical overlap
      const iBehind = isoBehind(blocks[i], blocks[j]);
      const jBehind = isoBehind(blocks[j], blocks[i]);
      if (iBehind === jBehind) continue; // both or neither: no constraint
      const from = iBehind ? i : j, to = iBehind ? j : i;
      if (!after[from]) after[from] = [];
      after[from].push(to);
      indegree[to]++;
    }
    active.push(i);
  }

  // ── Kahn, with a binary heap so ties break deterministically ──
  // The tie-break is `x + y`, which keeps equal-depth blocks in the same order
  // every redraw; an unstable one makes them trade places and reads as flicker.
  // A sorted array with splice() was the first attempt and is O(n²) on its own.
  const heap = [];
  const heapKey = (i) => blocks[i].x + blocks[i].y;
  const less = (a, b) => { const ka = heapKey(a), kb = heapKey(b); return ka < kb || (ka === kb && a < b); };
  const heapPush = (v) => {
    heap.push(v);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!less(heap[c], heap[p])) break;
      const t = heap[c]; heap[c] = heap[p]; heap[p] = t;
      c = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let p = 0;
      for (;;) {
        const l = p * 2 + 1, r = l + 1;
        let m = p;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === p) break;
        const t = heap[p]; heap[p] = heap[m]; heap[m] = t;
        p = m;
      }
    }
    return top;
  };

  for (let i = 0; i < n; i++) if (indegree[i] === 0) heapPush(i);

  const order = [];
  const placed = new Uint8Array(n);
  while (heap.length) {
    const i = heapPop();
    order.push(blocks[i]);
    placed[i] = 1;
    const outs = after[i];
    if (!outs) continue;
    for (let k = 0; k < outs.length; k++) if (--indegree[outs[k]] === 0) heapPush(outs[k]);
  }

  // A cycle cannot arise from non-overlapping footprints, but a numerical edge
  // case is not worth a wrong picture: anything left over is appended in
  // tie-break order and counted, so a block can never be dropped.
  let unresolved = 0;
  if (order.length < n) {
    const left = [];
    for (let i = 0; i < n; i++) if (!placed[i]) left.push(i);
    left.sort((a, b) => heapKey(a) - heapKey(b) || a - b);
    unresolved = left.length;
    for (const i of left) order.push(blocks[i]);
  }
  return { order, unresolved };
}

/* ── What a building's height and colour mean ──────────────────────────────

   Height is a *rank*, not a raw quantity. Staleness in days spans four orders
   of magnitude and reclaim scores span two, so a linear height would give one
   ancient folder a mile-high tower and flatten everything else into the
   pavement. Each mode maps its value through a log or a clamp into the same
   0..CITY_MAX_H band, so the picture reads at any scale — and the legend says
   which variable is which, because a height nobody can name is decoration. */
const CITY_MAX_H = 26;   // in layout units, where the whole map is 100 wide
const CITY_MIN_H = 0.6;  // never zero: a flat block is a hole, not a building

/**
 * The raw number a height mode is a picture of, before any scaling.
 *
 * Kept separate from the scaling because the scaling needs to see the WHOLE
 * set before it can place any single member — see `cityScaleHeights`. (There
 * used to be a `cityHeight` that did both against an absolute band; it was
 * superseded by this pair and has been removed, because a dead function that
 * looks authoritative is an invitation to call it.)
 */
function cityMetric(n, mode, counts) {
  if (mode === 'depth') return typeof n.depth === 'number' ? n.depth : null;
  if (mode === 'files') {
    const c = counts.get(n.path);
    return c ? Math.log10(c.files + 1) : null; // not answered yet — not "zero files"
  }
  const days = cityAgeDays(n);
  return days === null ? null : Math.log10(days + 1);
}

/**
 * Spread the drawn set across the full height range.
 *
 * An absolute scale is what made the first version look like a car park: on a
 * folder whose contents were all touched in the same month, every tower came
 * out the same height and the map collapsed into one slab. Normalising to the
 * range actually present means the tallest thing HERE is full height and the
 * shortest is the floor, so the picture has a skyline whatever folder you are
 * standing in.
 *
 * The ordering is untouched — this is a linear remap of an already-log-scaled
 * value, not a rank — so twice as tall still means "older than", and the exact
 * figure is always one hover away. The legend says the height is relative to
 * this folder, because a scale that changes as you drill has to say so.
 */
function cityScaleHeights(values) {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) {
    if (v === null) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return () => null;
  const span = hi - lo;
  // Everything identical: one honest mid-height rather than a fake spread.
  if (span < 1e-9) return (v) => (v === null ? null : CITY_MIN_H + CITY_MAX_H * 0.45);
  return (v) => (v === null ? null : CITY_MIN_H + Math.pow((v - lo) / span, 0.82) * CITY_MAX_H);
}

/** Days since a node changed, or null when it does not say. */
function cityAgeDays(n) {
  if (!n || typeof n.modifiedAt !== 'number' || n.modifiedAt <= 0) return null;
  return Math.max(0, (Date.now() - n.modifiedAt) / 86400000);
}


/** Base colour for a building, as [r,g,b]. */
function cityRgb(n, mode) {
  if (mode === 'type') { const k = kindFor(n); return k && k.tint ? hexToRgb(k.tint) : [120, 128, 140]; }
  if (mode === 'age') return ageRgb(n.modifiedAt);
  const score = reclaim.scores.get(n.path);
  // Unscored is its own colour, never the bottom of the ramp: "nobody looked"
  // and "not worth reclaiming" must not paint the same grey.
  if (score === undefined || score === null) return C_RC_UNSCORED;
  return reclaimRgb(typeof score === 'object' ? score.score : score);
}

/**
 * A small, stable lightness shift per building.
 *
 * Two hundred folders of source code are all the same blue, and a hundred
 * identical blue boxes read as a texture rather than as buildings. A few
 * percent either way — derived from the path, so it never flickers between
 * frames or between sessions — gives the eye something to separate them by
 * without touching the hue, which is the part that carries meaning.
 */
function cityJitter(rgb, path) {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) { h ^= path.charCodeAt(i); h = Math.imul(h, 16777619); }
  const k = 1 + (((h >>> 8) % 1000) / 1000 - 0.5) * 0.17;
  return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
}

/* ── Choosing what to draw ─────────────────────────────────────────────────

   The depth sort is only correct for blocks whose FOOTPRINTS DO NOT OVERLAP,
   and that is not a detail — it is the precondition the whole picture rests
   on. A treemap's node list contains parents and the children that tile them,
   so drawing both would interpenetrate every building with its own contents.

   So the drawn set is the frontier: a node is drawn when it is big enough to
   see AND none of its children are. That is exactly §6.1's "aggregate children
   into the parent block", and the parents that swallowed children are hatched
   so the map says where the detail went instead of pretending there is none. */
function cityVisibleNodes(nodes, minArea) {
  const passes = new Set();
  for (const n of nodes) if (n.w * n.h >= minArea) passes.add(n.path);
  const hasDrawnChild = new Set();
  for (const n of nodes) {
    if (!passes.has(n.path)) continue;
    const parent = tmParentPath(n.path);
    if (parent && passes.has(parent)) hasDrawnChild.add(parent);
  }
  const out = [];
  for (const n of nodes) {
    if (!passes.has(n.path) || hasDrawnChild.has(n.path)) continue;
    out.push(n);
  }
  // `aggregated` is the count of interior nodes dropped because a child of
  // theirs was drawn. It is reported, not used to decide anything — it was
  // once the basis of the `hatched` flag, and being a single number for the
  // whole layout it was wrong in both directions. See `buildCity`.
  return { drawn: out, aggregated: hasDrawnChild.size };
}

/**
 * The projected box that holds the ground plate and every building on it.
 *
 * Recomputed once per layout, never per frame: deriving it from what is
 * currently on screen would make the camera chase itself as buildings scroll
 * in and out of view.
 */
function cityContentBounds(blocks) {
  // The plate is always part of the picture, so it always counts.
  const plate = [isoProject(0, 0, 0), isoProject(100, 0, 0), isoProject(100, 100, 0), isoProject(0, 100, 0)];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of plate) {
    if (p.sx < x0) x0 = p.sx;
    if (p.sx > x1) x1 = p.sx;
    if (p.sy < y0) y0 = p.sy;
    if (p.sy > y1) y1 = p.sy;
  }
  for (const b of blocks) {
    if (b.bb.x0 < x0) x0 = b.bb.x0;
    if (b.bb.x1 > x1) x1 = b.bb.x1;
    if (b.bb.y0 < y0) y0 = b.bb.y0;
    if (b.bb.y1 > y1) y1 = b.bb.y1;
  }
  return { x0, x1, y0, y1 };
}

/**
 * Build the city: pick the visible set, give each block a height, project it,
 * and put it in draw order. Once per layout — never per frame.
 */
function buildCity() {
  const c = state.city;
  const nodes = state.treemap.nodes || [];
  c.total = nodes.length;
  if (!nodes.length) {
    c.blocks = []; c.drawn = 0; c.aggregated = 0; c.unresolved = 0; c.unknownHeight = 0;
    c.contentBounds = cityContentBounds([]);
    return;
  }

  // The threshold is in LAYOUT units (the map is 100 x 100), scaled by zoom so
  // that zooming in genuinely reveals more rather than only magnifying.
  const minArea = 0.55 / (c.zoom * c.zoom);
  const { drawn, aggregated } = cityVisibleNodes(nodes, minArea);
  c.aggregated = aggregated;

  let unknownHeight = 0;
  const blocks = [];
  const metrics = drawn.map((n) => cityMetric(n, c.height, c.counts));
  const scale = cityScaleHeights(metrics);
  for (let i = 0; i < drawn.length; i++) {
    const n = drawn[i];
    const h = scale(metrics[i]);
    if (h === null) unknownHeight++;
    blocks.push({
      x: n.x, y: n.y, w: n.w, h: n.h,
      z: h === null ? CITY_MIN_H : h,
      unknownHeight: h === null,
      n,
      rgb: cityJitter(cityRgb(n, c.colour), n.path),
      // A drawn FOLDER always stands for contents that are not drawn, so the
      // texture §6.1 asks for is exactly "this block is a folder".
      //
      // That follows from the drawn set being the frontier: a node is drawn
      // only when NO child of it is drawn, and a folder with no contents has
      // no size, so it can never clear the area threshold to be drawn at all.
      // Verified against a real 2,759-node payload: of 236 drawn folders,
      // zero had a drawn child and zero had zero size.
      //
      // Two narrower predicates were tried and both under-marked, which is
      // the direction that matters — an unmarked block claims it is showing
      // you everything:
      //   - `aggregated > 0`, a single flag for the whole layout, marked
      //     NOTHING in the case the texture exists for (nothing had a drawn
      //     child, so the count was zero);
      //   - "has a child in the payload" missed every folder the SERVER
      //     stopped at — 102 of 229 on that same payload, each one standing
      //     for a subtree the payload never described.
      // Two exceptions to "every drawn folder", and only two.
      //
      // The synthetic Trash cell (`maybeInjectTrash`) is `type: 'dir'` with no
      // subtree at all — it is a single figure, so a texture on it would claim
      // contents the map cannot show and the user cannot drill into.
      //
      // A container is an archive with virtual children, and it arrives as
      // `type: 'file'` — so the plain rule missed it while it genuinely does
      // hide what is inside.
      hatched: (n.type === 'dir' || !!n.container) && !n.isTrash,
    });
  }
  // Bounds are kept from the build pass so the draw loop can cull to the
  // viewport with six comparisons instead of re-projecting eight corners.
  for (const b of blocks) b.bb = isoBounds(b);
  c.contentBounds = cityContentBounds(blocks);
  const ordered = isoDepthOrder(blocks);
  c.blocks = ordered.order;
  c.unresolved = ordered.unresolved;
  c.drawn = blocks.length;
  c.unknownHeight = unknownHeight;
}

/* ── Drawing ───────────────────────────────────────────────────────────────

   Three faces per building, painter's order, no per-frame projection: the
   layout already holds screen-space corners, so a frame is a transform and a
   fill. That is what keeps panning inside §2.5's 16 ms.                     */

/** Project the block's corners once, into the shape the draw loop wants. */
function cityFaces(b) {
  const p = (x, y, z) => isoProject(x, y, z);
  const x0 = b.x, x1 = b.x + b.w, y0 = b.y, y1 = b.y + b.h, z = b.z;
  return {
    top: [p(x0, y0, z), p(x1, y0, z), p(x1, y1, z), p(x0, y1, z)],
    // The two walls that face the viewer: +x (lower right) and +y (lower left).
    right: [p(x1, y0, z), p(x1, y1, z), p(x1, y1, 0), p(x1, y0, 0)],
    left: [p(x0, y1, z), p(x1, y1, z), p(x1, y1, 0), p(x0, y1, 0)],
  };
}

/**
 * Is a point inside a polygon? Ray casting, in plain screen pixels.
 *
 * Deliberately NOT `ctx.isPointInPath`, and this is the trap that cost the
 * hover: `Canvas2D.setup` leaves a `devicePixelRatio` scale on the context, the
 * path is built in CSS pixels and therefore stored scaled — but
 * `isPointInPath` takes coordinates **unaffected by the current transform**.
 * On any Retina display the cursor was compared at half its real position, so
 * hovering a building found nothing. Nothing in a headless test catches that,
 * because the bug IS the device pixel ratio.
 *
 * Doing the arithmetic here also makes the hit test independent of the canvas
 * entirely, which is what §6.3's lasso needs from the same geometry.
 */
function cityPointInPoly(pts, px, py) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function cityShade(rgb, k, alpha = 1) {
  return `rgba(${Math.round(Math.min(255, rgb[0] * k))},${Math.round(Math.min(255, rgb[1] * k))},${Math.round(Math.min(255, rgb[2] * k))},${alpha})`;
}

/**
 * Project one face into screen pixels at the current transform.
 *
 * `into` lets the caller hand back the same array every frame. That matters:
 * the draw loop touches four faces on every visible block, so allocating fresh
 * point objects each time made roughly 4,400 short-lived objects per frame and
 * the garbage collector turned up as a 24 ms hitch in the p95 — inside §2.5's
 * 33 ms, but plainly visible as a stutter while panning. Reusing the buffers
 * takes it to 2 ms.
 */
function cityScreen(pts, tx, into) {
  const out = into || new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const o = out[i] || (out[i] = { x: 0, y: 0 });
    o.x = pts[i].sx * tx.s + tx.dx;
    o.y = pts[i].sy * tx.s + tx.dy;
  }
  return out;
}

function cityPathOf(ctx, screenPts) {
  ctx.beginPath();
  ctx.moveTo(screenPts[0].x, screenPts[0].y);
  for (let i = 1; i < screenPts.length; i++) ctx.lineTo(screenPts[i].x, screenPts[i].y);
  ctx.closePath();
}

function cityPoly(ctx, pts, tx) {
  cityPathOf(ctx, cityScreen(pts, tx));
}

/** The transform that puts the projected map on the canvas at the current zoom/pan. */
function cityTransform(width, height) {
  const c = state.city;
  // The projected map of a 100x100 layout spans x in [-100cos30, 100cos30] and
  // y in [-CITY_MAX_H, 100sin30]. Fitting that once keeps zoom === 1 meaning
  // "the whole disk fits", whatever the panel size is.
  // Fit to what is actually there, not to the theoretical worst case. Reserving
  // room for a full-height tower on a map whose tallest building is a shed left
  // a third of the panel empty and made the city look like a postage stamp.
  const bb = c.contentBounds;
  const spanX = Math.max(1, bb.x1 - bb.x0);
  const spanY = Math.max(1, bb.y1 - bb.y0);
  const fit = Math.min(width / spanX, height / spanY) * 0.9;
  c.fit = fit;
  const s = fit * c.zoom;
  // Centre the content's own box, so the city sits in the middle of the panel
  // whatever shape it turned out to be.
  const midX = (bb.x0 + bb.x1) / 2, midY = (bb.y0 + bb.y1) / 2;
  return { s, dx: width / 2 - midX * s + c.pan.x, dy: height / 2 - midY * s + c.pan.y };
}

/* ── Light, air and ground ─────────────────────────────────────────────────

   Three things separate a picture of boxes from a place: the boxes stand on
   something, they cast something, and the far ones are further away. None of
   it is decoration — depth cueing in particular is what lets the eye read
   which of two overlapping towers is in front without moving the camera.  */

/** How far back is this block, 0 (nearest) to 1 (furthest)? */
function cityDepthT(b) {
  // Depth grows with x + y in this projection; the map is 100 across, so the
  // far corner is 0 and the near corner is 200.
  return 1 - Math.min(1, Math.max(0, (b.x + b.w / 2 + b.y + b.h / 2) / 200));
}

/** Fade a colour toward the panel's own background as it recedes. */
function cityAirRgb(rgb, t, bg) {
  const k = t * 0.34; // measured by eye: enough to read as distance, not as fog
  return [rgb[0] + (bg[0] - rgb[0]) * k, rgb[1] + (bg[1] - rgb[1]) * k, rgb[2] + (bg[2] - rgb[2]) * k];
}

/** The panel background, read from the theme so this works in light mode too. */
function cityBackdropRgb() {
  const probe = getComputedStyle(document.documentElement).getPropertyValue('--bg-1').trim();
  if (/^#[0-9a-f]{6}$/i.test(probe)) return hexToRgb(probe);
  return [12, 13, 20];
}

function drawCity() {
  const canvas = $('cityCanvas');
  if (!canvas || !canvas.isConnected) return;
  const wrap = $('cityWrap');
  const cssW = Math.max(120, wrap.clientWidth);
  const cssH = Math.max(120, wrap.clientHeight);
  const { ctx, width, height } = Canvas2D.setup(canvas, cssW, cssH);
  ctx.clearRect(0, 0, width, height);

  const c = state.city;
  const tx = cityTransform(width, height);
  const hoverPath = c.hover ? c.hover.n.path : null;
  const bg = cityBackdropRgb();

  drawCityGround(ctx, tx, bg, width, height);

  const edgeWidth = Math.min(1.1, Math.max(0.35, tx.s * 0.06));
  ctx.lineJoin = 'round';
  let painted = 0;
  const pendingLabels = [];
  const paintedBoxes = [];

  for (const b of c.blocks) {
    // Viewport culling. At high zoom most of the city is off-canvas, and
    // drawing it costs the same as drawing what you can see: measured at
    // 9,897 blocks the median frame was 18.1 ms, over §2.5's 16 ms, with about
    // nine tenths of them outside the panel. Every block that intersects the
    // canvas is still drawn, in the same order, so nothing visible is lost.
    const bx0 = b.bb.x0 * tx.s + tx.dx, bx1 = b.bb.x1 * tx.s + tx.dx;
    if (bx1 < 0 || bx0 > width) continue;
    const by0 = b.bb.y0 * tx.s + tx.dy, by1 = b.bb.y1 * tx.s + tx.dy;
    if (by1 < 0 || by0 > height) continue;
    painted++;

    if (!b.faces) b.faces = cityFaces(b);
    const isHover = b.n.path === hoverPath;
    const wide = (b.w + b.h) * tx.s > 7;
    const rgb = cityAirRgb(b.rgb, cityDepthT(b), bg);

    // Reused buffers, not fresh arrays — see cityScreen's header.
    if (!b.sBuf) b.sBuf = { top: [], right: [], left: [], shadow: [] };
    const top = cityScreen(b.faces.top, tx, b.sBuf.top);
    const right = cityScreen(b.faces.right, tx, b.sBuf.right);
    const left = cityScreen(b.faces.left, tx, b.sBuf.left);

    // The cast shadow, laid down before its own building — see cityPaintShadow.
    if (wide && b.z > CITY_MIN_H * 1.05) {
      if (!b.shadow) b.shadow = cityShadowShape(b);
      cityPaintShadow(ctx, cityScreen(b.shadow, tx, b.sBuf.shadow));
    }

    const seed = b.seed || (b.seed = citySeed(b.n.path));
    const tallness = Math.min(1, (b.z - CITY_MIN_H) / CITY_MAX_H);

    // Left wall — the shadowed side, cooled slightly rather than merely darkened.
    cityPathOf(ctx, left);
    ctx.fillStyle = cityShade([rgb[0] * 0.92, rgb[1] * 0.96, rgb[2] * 1.08], isHover ? 0.66 : 0.46);
    ctx.fill();
    ctx.save(); ctx.clip();
    cityWindows(ctx, left, seed, rgb, 0.30);
    if (wide) cityWallShading(ctx, left);
    ctx.restore();
    if (wide) { ctx.strokeStyle = cityShade(rgb, 0.28, 0.9); ctx.lineWidth = edgeWidth; ctx.stroke(); }

    // Right wall — the lit side, warmed. Its windows catch more of the light.
    cityPathOf(ctx, right);
    ctx.fillStyle = cityShade([rgb[0] * 1.06, rgb[1] * 1.0, rgb[2] * 0.92], isHover ? 0.95 : 0.74);
    ctx.fill();
    ctx.save(); ctx.clip();
    cityWindows(ctx, right, seed ^ 0x9e3779b9, rgb, 0.5);
    if (wide) cityWallShading(ctx, right);
    ctx.restore();
    if (wide) { ctx.strokeStyle = cityShade(rgb, 0.34, 0.9); ctx.lineWidth = edgeWidth; ctx.stroke(); }

    // Roof — full light, with a soft gradient so a large roof is not a flat slab.
    cityPathOf(ctx, top);
    if (wide) {
      const tGrad = ctx.createLinearGradient(top[3].x, top[3].y, top[1].x, top[1].y);
      tGrad.addColorStop(0, cityShade(rgb, isHover ? 1.3 : 1.1));
      tGrad.addColorStop(1, cityShade(rgb, isHover ? 1.08 : 0.9));
      ctx.fillStyle = tGrad;
    } else {
      ctx.fillStyle = cityShade(rgb, isHover ? 1.24 : 1);
    }
    ctx.fill();
    if (wide) { ctx.strokeStyle = cityShade(rgb, 0.44, 0.95); ctx.lineWidth = edgeWidth; ctx.stroke(); }

    // Detail before the hatch and the label, so neither is drawn over.
    if (wide) { ctx.save(); cityPathOf(ctx, top); ctx.clip(); cityRoofDetail(ctx, top, seed ^ 0x85ebca6b, rgb); ctx.restore(); }
    // The crown stands ON the roof rather than inside it, so it is drawn
    // unclipped and after the roof detail it would otherwise be hidden under.
    if (wide && tallness > 0.16) cityCrown(ctx, b, tx, rgb, tallness);

    if (b.hatched) {
      // §6.1 — a block that swallowed its children says so, rather than
      // presenting itself as a thing with nothing inside it.
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      const ax = Math.min(top[0].x, top[2].x), bx = Math.max(top[0].x, top[2].x);
      const ay = Math.min(top[0].y, top[2].y), by = Math.max(top[0].y, top[2].y);
      for (let x = ax - (by - ay); x < bx; x += 7) {
        ctx.beginPath(); ctx.moveTo(x, by); ctx.lineTo(x + (by - ay), ay); ctx.stroke();
      }
      ctx.restore();
    }

    // The crisp lines where roof meets wall, and down the near corner. One
    // stroke each, and together they are most of the difference between a
    // rendered solid and a filled polygon: real edges catch the light, flat
    // fills do not. The vertical is the only edge in the whole silhouette
    // that faces the viewer head-on, which is exactly where a rim light lands.
    if (wide) {
      ctx.beginPath();
      ctx.moveTo(top[3].x, top[3].y);
      ctx.lineTo(top[2].x, top[2].y);
      ctx.lineTo(top[1].x, top[1].y);
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = Math.max(0.8, edgeWidth);
      ctx.stroke();
      if (b.z * tx.s > 10) {
        ctx.beginPath();
        ctx.moveTo(right[1].x, right[1].y);
        ctx.lineTo(right[2].x, right[2].y);
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
        ctx.lineWidth = Math.max(0.7, edgeWidth * 0.9);
        ctx.stroke();
      }
    }

    if (isHover) {
      // A halo rather than a lift: raising the building would put it a few
      // pixels away from where the hit test says it is, and a hover that does
      // not sit under the cursor is worse than no hover at all.
      ctx.save();
      ctx.shadowColor = 'rgba(255,255,255,0.55)';
      ctx.shadowBlur = 16;
      cityPathOf(ctx, top);
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.restore();
    }

    // A name on the roof, when the roof is big enough to hold one. This is the
    // difference between a chart you have to interrogate and a map you can
    // read: without it, nothing on screen is identifiable until you hover it.
    // Labels are decided after the whole city is painted — see below.
    if (labelsFit(top)) pendingLabels.push({ b, top, rgb, order: painted });
    b.screenBox = { x0: bx0, x1: bx1, y0: by0, y1: by1, order: painted };
    paintedBoxes.push(b.screenBox);
  }

  cityDrawLabels(ctx, pendingLabels, paintedBoxes);
  lassoPaint(ctx);
  c.painted = painted;
  renderCityChrome();
}

/**
 * Draw the labels that nothing is standing in front of.
 *
 * A label belongs to its roof, so drawing it inline means a nearer building
 * correctly paints over it — which produced names like "k-043…" with both ends
 * sliced off, reading as broken text rather than as one building in front of
 * another. Drawing every label in a final pass instead would be worse: the
 * name would float over the thing that hides it, which is a lie about what is
 * in front of what.
 *
 * So the test is on the LABEL, not on the roof. A roof may be half hidden and
 * still carry its name, as long as the strip of pixels the text occupies is
 * clear — which is what lets the biggest building on the map keep its label
 * when a tower clips one of its corners. Anything genuinely covered is left
 * unnamed and identified by hovering, which the card does in full.
 */
function cityDrawLabels(ctx, pending, boxes) {
  ctx.font = '600 11px ui-sans-serif, -apple-system, system-ui, sans-serif';
  for (const item of pending) {
    const { b, top } = item;
    const cx = (top[0].x + top[1].x + top[2].x + top[3].x) / 4;
    const cy = (top[0].y + top[1].y + top[2].y + top[3].y) / 4;
    const chord = cityChordAtY(top, cy);
    const maxW = Math.max(0, chord.right - chord.left) * 0.84;
    const name = Canvas2D.fitText(ctx, b.n.name, maxW);
    // "ack-0…" identifies nothing and reads as damage. A label either says
    // enough of the name to be useful or it is not drawn at all.
    if (!name || name.replace(/…$/, '').length < Math.min(6, b.n.name.length)) continue;

    const half = ctx.measureText(name).width / 2 + 3;
    const lx0 = cx - half, lx1 = cx + half, ly0 = cy - 9, ly1 = cy + 9;
    let clear = true;
    for (const box of boxes) {
      if (box.order <= item.order) continue; // drawn before this roof, so behind it
      if (box.x1 <= lx0 || box.x0 >= lx1 || box.y1 <= ly0 || box.y0 >= ly1) continue;
      clear = false;
      break;
    }
    if (!clear) continue;
    cityLabel(ctx, b, top, item.rgb, name, cx, cy);
  }
}

/**
 * The plot the city stands on.
 *
 * Three layers, and each earns itself: a soft pool of light under the whole
 * thing so the plate is not a hard-edged card floating on the panel; the plot
 * itself, lit from the same corner as the buildings; and a faint plan grid,
 * which is what makes a surface read as ground rather than as a grey shape.
 */
function drawCityGround(ctx, tx, bg, width, height) {
  const corners = [isoProject(0, 0, 0), isoProject(100, 0, 0), isoProject(100, 100, 0), isoProject(0, 100, 0)];
  if (!drawCityGround.buf) drawCityGround.buf = [];
  const g = cityScreen(corners, tx, drawCityGround.buf);
  const cx = (g[0].x + g[2].x) / 2, cy = (g[0].y + g[2].y) / 2;
  const rx = Math.abs(g[1].x - g[3].x) / 2, ry = Math.abs(g[2].y - g[0].y) / 2;

  // A pool of light beneath the plot. Drawn first and generously wide, so the
  // ground appears to sit IN the room rather than on top of a picture of one.
  const pool = ctx.createRadialGradient(cx, cy + ry * 0.35, Math.max(1, rx * 0.1), cx, cy + ry * 0.35, Math.max(2, rx * 1.35));
  pool.addColorStop(0, 'rgba(0,0,0,0.34)');
  pool.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = pool;
  ctx.fillRect(0, 0, width, height);

  cityPathOf(ctx, g);
  const lit = ctx.createLinearGradient(g[1].x, g[1].y, g[3].x, g[3].y);
  lit.addColorStop(0, `rgba(${Math.min(255, bg[0] + 26)},${Math.min(255, bg[1] + 30)},${Math.min(255, bg[2] + 42)},0.96)`);
  lit.addColorStop(1, `rgba(${Math.min(255, bg[0] + 6)},${Math.min(255, bg[1] + 8)},${Math.min(255, bg[2] + 14)},0.96)`);
  ctx.fillStyle = lit;
  ctx.fill();

  // The plan grid, clipped to the plot. Ten divisions is enough to read as a
  // surface and few enough that it never competes with the buildings.
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 10; i++) {
    const t = i * 10;
    const a = cityScreen([isoProject(t, 0, 0), isoProject(t, 100, 0)], tx);
    ctx.beginPath(); ctx.moveTo(a[0].x, a[0].y); ctx.lineTo(a[1].x, a[1].y); ctx.stroke();
    const b = cityScreen([isoProject(0, t, 0), isoProject(100, t, 0)], tx);
    ctx.beginPath(); ctx.moveTo(b[0].x, b[0].y); ctx.lineTo(b[1].x, b[1].y); ctx.stroke();
  }
  ctx.restore();

  // The plot's own rim: bright along the two near edges, invisible along the
  // far ones, which is where the light is coming from.
  ctx.beginPath();
  ctx.moveTo(g[1].x, g[1].y); ctx.lineTo(g[2].x, g[2].y); ctx.lineTo(g[3].x, g[3].y);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

/**
 * Windows.
 *
 * This is the single thing that turns a bar chart into a skyline. A wall is a
 * parallelogram, so the grid is laid out by interpolating along its own two
 * edges rather than in screen axes — that keeps the rows parallel to the
 * building instead of to the monitor, which is what would immediately give it
 * away as a texture pasted on top.
 *
 * Which windows are lit is derived from the path and the cell index, so a
 * building looks the same every frame, at every zoom, and in every session.
 * Random lighting would shimmer on every repaint.
 *
 * Gated hard on size: below roughly a thumbnail there is no room for a grid,
 * and drawing one anyway costs frames and reads as noise. Measured cost is in
 * the phase notes.
 */
function cityWindows(ctx, quad, seed, rgb, lit) {
  // quad: [topA, topB, bottomB, bottomA] — going along the top, then down.
  const wpx = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
  const hpx = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
  if (wpx < 26 || hpx < 22) return;

  const cols = Math.max(2, Math.min(9, Math.floor(wpx / 11)));
  const rows = Math.max(2, Math.min(14, Math.floor(hpx / 10)));
  const inset = 0.16;

  let h = seed;
  const next = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967296; };

  // Bilinear on the quad's own corners: P(u,v) walks the wall, not the screen.
  const at = (u, v) => ({
    x: quad[0].x + (quad[1].x - quad[0].x) * u + (quad[3].x - quad[0].x) * v,
    y: quad[0].y + (quad[1].y - quad[0].y) * u + (quad[3].y - quad[0].y) * v,
  });

  for (let r = 0; r < rows; r++) {
    for (let cN = 0; cN < cols; cN++) {
      const on = next() > 0.62;
      const u0 = (cN + inset) / cols, u1 = (cN + 1 - inset) / cols;
      const v0 = (r + inset) / rows, v1 = (r + 1 - inset) / rows;
      const p00 = at(u0, v0), p10 = at(u1, v0), p11 = at(u1, v1), p01 = at(u0, v1);
      ctx.beginPath();
      ctx.moveTo(p00.x, p00.y); ctx.lineTo(p10.x, p10.y);
      ctx.lineTo(p11.x, p11.y); ctx.lineTo(p01.x, p01.y);
      ctx.closePath();
      ctx.fillStyle = on
        ? `rgba(${Math.min(255, rgb[0] * 1.7 + 60)},${Math.min(255, rgb[1] * 1.7 + 52)},${Math.min(255, rgb[2] * 1.4 + 26)},${lit})`
        : 'rgba(0,0,0,0.30)';
      ctx.fill();
    }
  }
}

/**
 * Rooftop detail on a large roof.
 *
 * A folder that holds most of a disk gets most of the map, and at low height
 * that is an enormous flat plane — the single thing that made the first pass
 * read as a chart rather than a place. Real roofs are not empty: this lays a
 * faint panel grid in the building's own axes and stands a few plant boxes on
 * it, which breaks the plane up without inventing any information.
 *
 * Purely decorative, and deliberately so. It carries no data, which is why it
 * is drawn at very low contrast and never near a label.
 */
function cityRoofDetail(ctx, top, seed, rgb) {
  const wpx = Math.hypot(top[1].x - top[0].x, top[1].y - top[0].y);
  const hpx = Math.hypot(top[3].x - top[0].x, top[3].y - top[0].y);
  if (wpx < 90 || hpx < 60) return;

  const at = (u, v) => ({
    x: top[0].x + (top[1].x - top[0].x) * u + (top[3].x - top[0].x) * v,
    y: top[0].y + (top[1].y - top[0].y) * u + (top[3].y - top[0].y) * v,
  });

  // Panel seams, in the roof's own axes so they run with the building.
  const cols = Math.max(3, Math.min(12, Math.round(wpx / 46)));
  const rows = Math.max(3, Math.min(12, Math.round(hpx / 46)));
  ctx.strokeStyle = 'rgba(0,0,0,0.13)';
  ctx.lineWidth = 1;
  for (let i = 1; i < cols; i++) {
    const a = at(i / cols, 0), b = at(i / cols, 1);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  for (let j = 1; j < rows; j++) {
    const a = at(0, j / rows), b = at(1, j / rows);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }

  // A few plant boxes, placed deterministically so they never crawl.
  let h = seed;
  const next = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967296; };
  const units = Math.min(5, Math.max(1, Math.round((wpx * hpx) / 26000)));
  for (let i = 0; i < units; i++) {
    const u = 0.12 + next() * 0.68, v = 0.12 + next() * 0.68;
    const du = 0.06 + next() * 0.07, dv = 0.06 + next() * 0.07;
    const q = [at(u, v), at(u + du, v), at(u + du, v + dv), at(u, v + dv)];
    const riseY = Math.min(9, Math.max(3, hpx * 0.035));
    // The box's own little walls, so it stands rather than lies flat.
    ctx.beginPath();
    ctx.moveTo(q[1].x, q[1].y - riseY); ctx.lineTo(q[2].x, q[2].y - riseY);
    ctx.lineTo(q[2].x, q[2].y); ctx.lineTo(q[1].x, q[1].y);
    ctx.closePath();
    ctx.fillStyle = cityShade(rgb, 0.62, 0.95); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(q[3].x, q[3].y - riseY); ctx.lineTo(q[2].x, q[2].y - riseY);
    ctx.lineTo(q[2].x, q[2].y); ctx.lineTo(q[3].x, q[3].y);
    ctx.closePath();
    ctx.fillStyle = cityShade(rgb, 0.5, 0.95); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(q[0].x, q[0].y - riseY); ctx.lineTo(q[1].x, q[1].y - riseY);
    ctx.lineTo(q[2].x, q[2].y - riseY); ctx.lineTo(q[3].x, q[3].y - riseY);
    ctx.closePath();
    ctx.fillStyle = cityShade(rgb, 1.16, 0.95); ctx.fill();
  }
}

/* ── Light, and what it does to the ground ──────────────────────────────────

   One light, one direction, everywhere: from high on the RIGHT, which is
   already what the right wall being the lit one means, what the backdrop's
   warm corner means, and where every other lit thing in the app takes its
   light from. Naming it once as a vector is what lets the shadows agree with
   the shading instead of being drawn to taste.

   Shadows are cast onto the GROUND ONLY, never onto other buildings. That is a
   simplification and it is the right one here: a painter's algorithm has no
   depth buffer to test against, so a building-on-building shadow would have to
   be clipped against every block it might land on — at which point the sort
   that §6.1 spent a whole commit getting right becomes a per-frame occlusion
   problem. Ground shadows alone give the eye what it actually needs, which is
   height: two towers of the same footprint are told apart instantly by how far
   their shadows reach.                                                        */

/**
 * Where a shadow runs, per unit of height, in layout units.
 *
 * Both signs are forced by the shading, and the magnitudes by the painter's
 * algorithm — this vector is not a taste decision:
 *
 *  - the +x wall is the lit one and the +y wall the shaded one, so the light
 *    travels in −x and +y and the shadow must too;
 *  - depth in this projection grows with x + y, and **a treemap tiles its
 *    ground completely**. There is no bare floor anywhere for a shadow to land
 *    on, so a shadow that moved toward the viewer would fall only on buildings
 *    drawn after it and be painted over by every one of them. Measured, by
 *    building exactly that and finding an empty plot: with `x + y` increasing,
 *    not one shadow in the city was visible.
 *
 * So |x| > |y|: the sun sits to the right and a little in front, and shadows
 * run back and to the left, over the roofs of the buildings behind — which are
 * drawn earlier and can therefore receive them.
 */
const CITY_LIGHT = { x: -1.25, y: 0.45 };

/**
 * The convex hull of projected points — monotone chain.
 *
 * A block's shadow is its footprint swept along the light, which is the hull
 * of the footprint and the footprint translated. Enumerating the resulting
 * hexagon by hand needs a case per sign combination of the offset; the hull of
 * eight points has no cases at all and costs about thirty comparisons.
 */
function cityHull(pts) {
  const p = pts.slice().sort((a, b) => a.sx - b.sx || a.sy - b.sy);
  const cross = (o, a, b) => (a.sx - o.sx) * (b.sy - o.sy) - (a.sy - o.sy) * (b.sx - o.sx);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/**
 * One block's ground shadow, in projected (pre-transform) coordinates.
 *
 * Computed once per layout and cached on the block beside `faces`, because it
 * only changes when the height does — which is exactly when `faces` is
 * invalidated, so the two are cleared together.
 */
function cityShadowShape(b) {
  const ox = b.z * CITY_LIGHT.x, oy = b.z * CITY_LIGHT.y;
  const x0 = b.x, x1 = b.x + b.w, y0 = b.y, y1 = b.y + b.h;
  const pts = [];
  for (const corner of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
    pts.push(isoProject(corner[0], corner[1], 0));
    pts.push(isoProject(corner[0] + ox, corner[1] + oy, 0));
  }
  return cityHull(pts);
}

/**
 * One building's shadow, drawn immediately before that building.
 *
 * The order is the whole design. Shadows here run BACK, onto roofs that were
 * drawn earlier, so painting one just before its caster lays it correctly over
 * the neighbours behind and lets the caster itself cover the part that falls
 * on its own footprint. A single early pass — which is what one wants for a
 * shadow on bare ground — puts every shadow under every building instead, and
 * on a tiling with no bare ground that means under, full stop.
 *
 * Two fills, the outer slightly larger and fainter, for a penumbra.
 * `ctx.filter = 'blur()'` would be truer and costs a full-canvas readback per
 * building, which is not a trade worth making sixty times a second.
 */
function cityPaintShadow(ctx, screenPts) {
  if (screenPts.length < 3) return;
  let cx = 0, cy = 0;
  for (const p of screenPts) { cx += p.x; cy += p.y; }
  cx /= screenPts.length; cy /= screenPts.length;
  for (const pass of [{ k: 1.07, a: 0.08 }, { k: 1.0, a: 0.17 }]) {
    ctx.beginPath();
    for (let i = 0; i < screenPts.length; i++) {
      const x = cx + (screenPts[i].x - cx) * pass.k;
      const y = cy + (screenPts[i].y - cy) * pass.k;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = `rgba(0,0,0,${pass.a})`;
    ctx.fill();
  }
}

/**
 * What a wall does between the ground and the sky.
 *
 * Two effects in one gradient, because they are two ends of the same fact:
 * light does not reach the crease where a wall meets the ground, and the top
 * of a wall catches the sky. A wall filled with one flat value is the single
 * most reliable way to make an extrusion look like a sticker; these two stops
 * cost one fill between them and do most of the work of turning a shaded
 * quadrilateral into a surface.
 */
function cityWallShading(ctx, quad) {
  // quad: [topA, topB, bottomB, bottomA] — along the top, then down.
  const topX = (quad[0].x + quad[1].x) / 2, topY = (quad[0].y + quad[1].y) / 2;
  const botX = (quad[2].x + quad[3].x) / 2, botY = (quad[2].y + quad[3].y) / 2;
  if (Math.hypot(botX - topX, botY - topY) < 14) return;
  const g = ctx.createLinearGradient(botX, botY, topX, topY);
  g.addColorStop(0, 'rgba(0,0,0,0.36)');      // the crease at the ground
  g.addColorStop(0.30, 'rgba(0,0,0,0.07)');
  g.addColorStop(0.86, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(190,214,255,0.14)'); // sky, caught along the parapet
  ctx.fillStyle = g;
  ctx.fill();
}

/**
 * A crown on a tall building: a parapet cap, and a mast on the slim ones.
 *
 * This is what stops a skyline reading as a bar chart. Every real tower is
 * finished at the top — a plant room, a parapet, a mast — and a field of
 * boxes chopped flat is the tell that these are bars with shading on them.
 * Purely architectural, carrying no data, which is why it is drawn from the
 * building's own colour and never near the label.
 *
 * The crown is a smaller box standing on the roof, drawn through the same
 * projection as its parent, so it stays put under pan, zoom and the height
 * morph without any state of its own.
 */
function cityCrown(ctx, b, tx, rgb, tallness) {
  const wpx = (b.w + b.h) * tx.s;
  if (wpx < 26 || b.z * tx.s < 16) return;
  const foot = (b.w + b.h) / 2;
  const tower = b.z > foot * 0.4;

  /* A tower is finished with a centred parapet; a slab gets a plant room off
     to one side, sized and placed from a hash of its own path.

     The uniform version — every roof with one concentric box at the same
     fraction — was the tell. A dozen wide blocks each carrying an identical
     lighter rectangle read as an overlay someone had drawn on the map rather
     than as roofs, and the eye starts looking for what the rectangle MEANS.
     It means nothing, so it has to look like nothing: varied, off-centre and
     small enough to be furniture. Derived from the path, so a building keeps
     the same roof at every zoom and in every session. */
  let insetX = 0.24, insetY = 0.24, offX = 0, offY = 0, rise = 0.07;
  if (!tower) {
    const h = citySeed(b.n.path);
    insetX = 0.32 + ((h >>> 3) % 90) / 500;
    insetY = 0.32 + ((h >>> 11) % 90) / 500;
    offX = ((((h >>> 17) % 100) / 100) - 0.5) * (1 - 2 * insetX) * 0.85;
    offY = ((((h >>> 23) % 100) / 100) - 0.5) * (1 - 2 * insetY) * 0.85;
    rise = 0.0;
  }
  const x0 = b.x + b.w * (insetX + offX), x1 = b.x + b.w * (1 - insetX + offX);
  const y0 = b.y + b.h * (insetY + offY), y1 = b.y + b.h * (1 - insetY + offY);
  const zc = tower
    ? b.z + Math.min(2.2, Math.max(0.35, b.z * rise))
    : b.z + Math.min(1.4, Math.max(0.28, foot * 0.05));
  const p = (x, y, z) => isoProject(x, y, z);
  const cap = cityScreen([p(x0, y0, zc), p(x1, y0, zc), p(x1, y1, zc), p(x0, y1, zc)], tx);
  const rightF = cityScreen([p(x1, y0, zc), p(x1, y1, zc), p(x1, y1, b.z), p(x1, y0, b.z)], tx);
  const leftF = cityScreen([p(x0, y1, zc), p(x1, y1, zc), p(x1, y1, b.z), p(x0, y1, b.z)], tx);
  cityPathOf(ctx, leftF); ctx.fillStyle = cityShade(rgb, 0.44); ctx.fill();
  cityPathOf(ctx, rightF); ctx.fillStyle = cityShade(rgb, 0.7); ctx.fill();
  cityPathOf(ctx, cap); ctx.fillStyle = cityShade(rgb, 1.16); ctx.fill();

  /* A mast, on very few buildings.
     The first version put one on anything tall and slim, and at a working zoom
     that was most of the map: forty white lines shooting out of a skyline read
     as a data layer nobody could explain rather than as architecture. A mast
     is only interesting when it is RARE, so this asks for three things at once
     — genuinely tall for this folder, genuinely slender, and one in five by a
     hash of the path so the same buildings keep theirs from frame to frame. */
  const slim = (b.w + b.h) / 2 < b.z * 0.45;
  if (!slim || tallness < 0.72 || b.z * tx.s < 54) return;
  if ((citySeed(b.n.path) % 5) !== 0) return;
  const mx = b.x + b.w / 2, my = b.y + b.h / 2;
  const base = cityScreen([p(mx, my, zc)], tx)[0];
  const tip = cityScreen([p(mx, my, zc + b.z * 0.16)], tx)[0];
  ctx.beginPath();
  ctx.moveTo(base.x, base.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.strokeStyle = cityShade(rgb, 1.15, 0.75);
  ctx.lineWidth = Math.max(0.8, Math.min(1.6, tx.s * 0.03));
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(tip.x, tip.y, Math.max(1, ctx.lineWidth * 1.1), 0, Math.PI * 2);
  ctx.fillStyle = cityShade(rgb, 1.4, 0.85);
  ctx.fill();
}

/** A stable 32-bit seed for one path, so a building never re-rolls its windows. */
function citySeed(path) {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) { h ^= path.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) || 1;
}

/** Is this roof big enough that a label would help rather than clutter? */
function labelsFit(top) {
  const cy = (top[0].y + top[1].y + top[2].y + top[3].y) / 4;
  const chord = cityChordAtY(top, cy);
  const h = Math.abs(top[2].y - top[0].y);
  return chord.right - chord.left > 62 && h > 24;
}

/** Where a horizontal line at `y` enters and leaves a convex polygon. */
function cityChordAtY(pts, y) {
  let left = Infinity, right = -Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j], b = pts[i];
    if ((a.y > y) === (b.y > y)) continue; // edge does not cross this line
    const x = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
    if (x < left) left = x;
    if (x > right) right = x;
  }
  return Number.isFinite(left) ? { left, right } : { left: 0, right: 0 };
}

/**
 * Draw a name on a roof.
 *
 * Clipped to the roof and centred on its middle, so a label can never spill
 * onto the building behind it — which, with a painter's algorithm, is exactly
 * how a label ends up floating over something it does not belong to.
 */
function cityLabel(ctx, b, top, rgb, name, cx, cy) {
  ctx.save();
  cityPathOf(ctx, top);
  ctx.clip();
  ctx.font = '600 11px ui-sans-serif, -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Legible on any roof colour: a halo in the opposite direction to the fill.
  const light = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 150;
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = light ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)';
  ctx.strokeText(name, cx, cy);
  ctx.fillStyle = light ? 'rgba(18,20,26,0.96)' : 'rgba(255,255,255,0.96)';
  ctx.fillText(name, cx, cy);
  ctx.restore();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/* ── Motion ────────────────────────────────────────────────────────────────

   Three transitions, and each exists because the alternative is a jump cut
   that costs the viewer their place:

     - changing what height means REBUILDS every tower, so they grow into it
     - zooming steps by a fixed notch, so the camera eases rather than snaps
     - drilling into a folder replaces the whole city, so it settles in

   All of them are skipped wholesale under `prefers-reduced-motion`, which the
   file already honours in five other places. Skipped, not shortened: a person
   who asked for no motion gets the end state immediately.

   The height morph is capped by block count. Animating means recomputing every
   block's geometry each frame, which is fine for the few hundred a normal view
   draws and is not fine for ten thousand — so above the cap the new heights
   simply apply, which is the same answer the reduced-motion path gives.      */
const CITY_MORPH_MS = 420;
const CITY_MORPH_MAX_BLOCKS = 4000;

const cityEase = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic: quick, then settles

/** Start a height morph from whatever is on screen to whatever was just built. */
function cityMorphHeights(previousByPath) {
  const c = state.city;
  if (REDUCED || document.hidden || c.blocks.length > CITY_MORPH_MAX_BLOCKS || !previousByPath.size) return false;
  let moved = 0;
  for (const b of c.blocks) {
    const was = previousByPath.get(b.n.path);
    if (was === undefined || Math.abs(was - b.z) < 0.01) { delete b.z1; continue; }
    b.z0 = was;
    b.z1 = b.z;
    b.z = was;
    b.faces = null; b.shadow = null;
    b.bb = isoBounds(b);
    moved++;
  }
  if (!moved) return false;
  c.morphStart = performance.now();
  cityRunMorph();
  return true;
}

/** Put every block at the height it was actually laid out with. */
function cityFinishMorph() {
  const c = state.city;
  for (const b of c.blocks) {
    if (b.z1 === undefined) continue;
    b.z = b.z1;
    delete b.z1;
    b.faces = null; b.shadow = null;
    b.bb = isoBounds(b);
  }
}

function cityRunMorph() {
  const c = state.city;
  if (c.morphRaf) cancelAnimationFrame(c.morphRaf);
  const step = () => {
    // A hidden tab does not run rAF at all, and this animation begins by
    // REPLACING every height with a placeholder. If the page is hidden between
    // the first frame and the second, the city is left permanently flat — and
    // height is two of the three things Disk City exists to show. Finish
    // immediately instead. The guards on the two entry points stop this being
    // reachable in the ordinary case; this is the one that catches a tab
    // hidden mid-morph, which no entry check can.
    if (document.hidden) { cityFinishMorph(); c.morphRaf = 0; drawCity(); return; }
    const t = Math.min(1, (performance.now() - c.morphStart) / CITY_MORPH_MS);
    const k = cityEase(t);
    for (const b of c.blocks) {
      if (b.z1 === undefined) continue;
      b.z = b.z0 + (b.z1 - b.z0) * k;
      b.faces = null; b.shadow = null;
      b.bb = isoBounds(b);
    }
    drawCity();
    if (t < 1) { c.morphRaf = requestAnimationFrame(step); return; }
    c.morphRaf = 0;
    cityFinishMorph();
    drawCity();
  };
  c.morphRaf = requestAnimationFrame(step);
}

/** Ease the camera toward a zoom target instead of snapping to it. */
function cityAnimateZoom(target) {
  const c = state.city;
  c.zoomTarget = Math.max(0.4, Math.min(14, target));
  // No frames means no easing, and easing is the only thing that moves `zoom`
  // toward `zoomTarget` — so without this the camera would stop where it was
  // and the map would silently ignore the zoom.
  if (REDUCED || document.hidden) { c.zoom = c.zoomTarget; cityAfterZoom(); cityInvalidate(); return; }
  if (c.zoomRaf) return;
  const step = () => {
    if (document.hidden) { c.zoom = c.zoomTarget; c.zoomRaf = 0; cityAfterZoom(); cityInvalidate(); return; }
    const gap = c.zoomTarget - c.zoom;
    if (Math.abs(gap) < 0.002) {
      c.zoom = c.zoomTarget;
      c.zoomRaf = 0;
      cityAfterZoom();
      cityInvalidate();
      return;
    }
    c.zoom += gap * 0.22; // enough damping to feel like weight rather than lag
    cityInvalidate();
    c.zoomRaf = requestAnimationFrame(step);
  };
  c.zoomRaf = requestAnimationFrame(step);
}

/**
 * Zoom changes which blocks clear the pixel threshold, so the layout is rebuilt
 * — but only once the gesture settles. §6.1's "computed once per layout" is
 * what keeps a wheel spin from re-sorting on every tick.
 */
function cityAfterZoom() {
  const c = state.city;
  clearTimeout(c.zoomTimer);
  c.zoomTimer = setTimeout(() => {
    if (state.view !== 'city') return;
    const before = new Map(c.blocks.map((b) => [b.n.path, b.z]));
    buildCity();
    if (!cityMorphHeights(before)) drawCity();
    renderCityTable();
    cityFetchFacts();
  }, 130);
}

/** A new folder is a new city; let it rise rather than cutting to it. */
function cityEnter() {
  const c = state.city;
  if (REDUCED || document.hidden || !c.blocks.length || c.blocks.length > CITY_MORPH_MAX_BLOCKS) { drawCity(); return; }
  for (const b of c.blocks) {
    b.z0 = 0;
    b.z1 = b.z;
    b.z = 0;
    b.faces = null; b.shadow = null;
    b.bb = isoBounds(b);
  }
  c.morphStart = performance.now();
  cityRunMorph();
}

function cityInvalidate() {
  const c = state.city;
  if (c.raf) return;
  c.raf = requestAnimationFrame(() => { c.raf = 0; drawCity(); });
}

/* ── Chrome: the legend, the coverage line, and the text equivalent ──────── */

function renderCityChrome() {
  const c = state.city;
  const lod = $('cityLod');
  if (lod) {
    // §6.1 forbids a silent threshold. A map drawing 4,120 of 251,000 things
    // and saying nothing is lying by omission about what is on screen.
    const parts = [];
    if (c.drawn < c.total) {
      parts.push(`showing ${formatCount(c.drawn)} of ${formatCount(c.total)} — zoom in for more`);
    } else {
      parts.push(`showing all ${formatCount(c.drawn)}`);
    }
    if (c.unknownHeight) parts.push(`${formatCount(c.unknownHeight)} with no ${c.height === 'files' ? 'count' : 'date'} yet, drawn flat`);
    if (c.unresolved) parts.push(`${formatCount(c.unresolved)} could not be depth-sorted and are drawn last`);
    lod.textContent = parts.join(' · ');
    lod.hidden = false;
  }

  const legend = $('cityLegend');
  if (legend) {
    // "in this folder" is not padding: the scale is normalised to what is on
    // screen, so a tower is tall relative to its neighbours rather than on an
    // absolute scale, and a legend that implied otherwise would be wrong.
    const heightLabel = CITY_HEIGHT_LABEL[c.height];
    const colourLabel = CITY_COLOUR_LABEL[c.colour];
    // The colour key is the ramp itself, not a sentence about it.
    const ramp = c.colour === 'reclaim'
      ? `linear-gradient(90deg, rgb(${C_RC_LOW.join(',')}), rgb(${C_AMBER.join(',')}), rgb(${C_TEAL.join(',')}))`
      : c.colour === 'age'
        ? `linear-gradient(90deg, rgb(${ageRgb(Date.now()).join(',')}), rgb(${ageRgb(Date.now() - 3 * 365 * 86400000).join(',')}))`
        : '';
    legend.innerHTML =
      `<span class="tml-item"><b>Footprint</b> = size on disk</span>` +
      `<span class="tml-item"><b>Height</b> = ${escapeHtml(heightLabel)}</span>` +
      `<span class="tml-item city-ramp"><b>Color</b> = ${escapeHtml(colourLabel)}` +
      (ramp ? `<i style="background:${ramp}"></i>` : '') + `</span>`;
  }

  const status = $('cityStatus');
  if (status) status.textContent = state.treemap.rootSize ? formatBytes(state.treemap.rootSize) : '';
}

/**
 * The text equivalent §6 requires of every canvas view.
 *
 * Not a second navigation mechanism: it lists exactly what the canvas drew, in
 * the same draw order, and drilling from it calls the same function a click on
 * the canvas does. Rendered on demand, because a table of thousands of rows
 * built eagerly would cost more than the map it describes.
 */
function renderCityTable() {
  const host = $('cityTable');
  if (!host) return;
  const c = state.city;
  const rows = c.blocks.slice(0, 500);
  host.innerHTML =
    `<table><thead><tr><th>Name</th><th class="num">Size</th><th>Height means</th><th class="num">Value</th></tr></thead><tbody>` +
    rows.map((b) => {
      const days = cityAgeDays(b.n);
      const count = c.counts.get(b.n.path);
      const value = c.height === 'files'
        ? (count ? formatCount(count.files) + ' files' : 'not counted yet')
        : c.height === 'depth'
          ? 'level ' + String(b.n.depth ?? '?')
          : (days === null ? 'no date' : Math.round(days) + ' days');
      return `<tr><td><button data-city-row="${escapeHtml(b.n.path)}">${escapeHtml(b.n.name)}</button></td>` +
        `<td class="num">${escapeHtml(formatBytes(b.n.size))}</td>` +
        `<td>${escapeHtml({ staleness: 'staleness', files: 'file count', depth: 'depth' }[c.height])}</td>` +
        `<td class="num">${escapeHtml(value)}</td></tr>`;
    }).join('') +
    `</tbody></table>` +
    (c.blocks.length > rows.length
      ? `<p class="muted" style="margin-top:8px;font-size:11.5px">Listing the first ${formatCount(rows.length)} of ${formatCount(c.blocks.length)} drawn buildings.</p>`
      : '');
}

/* ── Loading ──────────────────────────────────────────────────────────────

   Shares the Treemap's root and nodes outright. If the Treemap already holds
   this folder, entering Disk City costs no request at all — and the two
   pictures are provably the same arrangement rather than two that resemble
   each other.                                                              */

let cityLoadSeq = 0;
async function loadCity(rootPath) {
  if (!state.scanId || !state.root) return;
  const want = rootPath || state.treemap.rootPath || state.root.path;
  const seq = ++cityLoadSeq;
  const c = state.city;

  if (state.treemap.rootPath !== want || !state.treemap.nodes.length) {
    try {
      const data = await api(`/api/scan/${state.scanId}/treemap?maxDepth=${state.treemap.maxDepth}&minSize=4096&root=${encodeURIComponent(want)}`);
      if (seq !== cityLoadSeq) return; // superseded while fetching
      state.treemap.rootPath = data.root.path;
      state.treemap.rootName = data.root.name;
      state.treemap.rootSize = data.root.size;
      state.treemap.nodes = data.nodes;
      state.treemap.hover = null;
    } catch (e) {
      $('cityLod').textContent = e.message;
      $('cityLod').hidden = false;
      return;
    }
  }
  c.hover = null;
  c.pan = { x: 0, y: 0 };
  c.zoom = 1;
  renderCrumbs($('cityCrumbs'), state.treemap.rootPath, (p) => loadCity(p));
  $('cityUpBtn').disabled = !state.root || state.treemap.rootPath === state.root.path;
  buildCity();
  cityEnter();
  renderCityTable();
  cityFetchFacts();
}

/**
 * Ask the fact layer for whatever the current modes need, for the DRAWN set
 * only.
 *
 * The same rule the treemap's Reclaim mode follows: the tree can hold 250,000
 * nodes and the map draws a few thousand, so scoring the tree would spend the
 * budget on buildings nobody can see.
 */
function cityFetchFacts() {
  const c = state.city;
  if (!state.scanId || !c.blocks.length) return;
  const paths = c.blocks.map((b) => b.n.path).filter((p) => p && !p.startsWith('cloud://') && !p.includes('!/')).slice(0, TM_SCORE_CAP);

  if (c.colour === 'reclaim') {
    void ensureScores(paths, () => {
      if (state.view !== 'city') return;
      for (const b of state.city.blocks) b.rgb = cityJitter(cityRgb(b.n, state.city.colour), b.n.path);
      cityInvalidate();
    });
  }
  if (c.height === 'files') {
    const key = state.scanId + '|' + state.treemap.rootPath;
    if (c.countsFor === key) return;
    c.countsFor = key;
    void cityLoadCounts(paths, key);
  }
}

/** Fetch subtree counts in the fact layer's own batches. */
async function cityLoadCounts(paths, key) {
  const scanAtRequest = state.scanId;
  try {
    for (let i = 0; i < paths.length; i += RECLAIM_BATCH) {
      const batch = paths.slice(i, i + RECLAIM_BATCH);
      const res = await api('/api/facts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanId: scanAtRequest, paths: batch, providers: ['subtreeCount'] }),
      });
      if (state.scanId !== scanAtRequest || state.city.countsFor !== key) return;
      const provider = (res.providers && res.providers.subtreeCount) || null;
      const values = (provider && provider.available && provider.values) || {};
      // A path absent from `values` stays absent from the map: unknown is not
      // a count of zero, and the coverage line says how many are still blank.
      for (const p of batch) {
        if (Object.prototype.hasOwnProperty.call(values, p)) state.city.counts.set(p, values[p]);
      }
      if (state.view === 'city' && state.city.height === 'files') {
        buildCity(); cityInvalidate(); renderCityTable();
      }
    }
  } catch (err) {
    state.city.countsFor = null; // a later entry retries rather than remembering a blip
    if (window.TREEMAP_DEBUG) console.warn('[treemap] subtree counts failed:', err);
  }
}

/* ── Interaction ─────────────────────────────────────────────────────────── */

/**
 * Which building is under the cursor?
 *
 * Front to back over the SAME order the painter used, so the answer is always
 * the building the user can actually see. Hit-testing a separate structure is
 * how a hit tester silently disagrees with what was drawn — the Canvas2D
 * toolkit's header says exactly that, and this obeys it by reusing the draw
 * order rather than by reusing its rectangle helper, which cannot describe a
 * six-sided silhouette.
 */
function cityHit(px, py) {
  const c = state.city;
  const wrap = $('cityWrap');
  if (!wrap) return null;
  const tx = cityTransform(Math.max(120, wrap.clientWidth), Math.max(120, wrap.clientHeight));
  for (let i = c.blocks.length - 1; i >= 0; i--) {
    const b = c.blocks[i];
    // Reject on the bounding box before projecting anything. The cursor is a
    // point, so a block whose box does not contain it cannot be the answer.
    if (px < b.bb.x0 * tx.s + tx.dx || px > b.bb.x1 * tx.s + tx.dx) continue;
    if (py < b.bb.y0 * tx.s + tx.dy || py > b.bb.y1 * tx.s + tx.dy) continue;
    if (!b.faces) b.faces = cityFaces(b);
    // Front to back over the SAME order the painter used, so the answer is
    // always the building the user can actually see.
    // Same shape the draw loop allocates, so the hit tester and the painter
    // share one set of buffers rather than each quietly making its own.
    if (!b.sBuf) b.sBuf = { top: [], right: [], left: [], shadow: [] };
    if (cityPointInPoly(cityScreen(b.faces.top, tx, b.sBuf.top), px, py)) return b;
    if (cityPointInPoly(cityScreen(b.faces.right, tx, b.sBuf.right), px, py)) return b;
    if (cityPointInPoly(cityScreen(b.faces.left, tx, b.sBuf.left), px, py)) return b;
  }
  return null;
}

function cityShowCard(b, px, py) {
  const card = $('cityCard');
  if (!card) return;
  if (!b) { card.hidden = true; return; }
  const c = state.city;
  const days = cityAgeDays(b.n);
  const count = c.counts.get(b.n.path);
  const score = reclaim.scores.get(b.n.path);
  const share = state.treemap.rootSize ? (b.n.size / state.treemap.rootSize) * 100 : null;

  const rows = [['Size', formatBytes(b.n.size)]];
  if (share !== null && share >= 0.1) rows.push(['Share of this folder', share.toFixed(1) + '%']);
  rows.push(['Last changed', days === null ? 'not recorded' : cityAgeWords(days)]);
  if (count) rows.push(['Holds', `${formatCount(count.files)} files · ${formatCount(count.dirs)} folders`]);
  else if (c.height === 'files') rows.push(['Holds', 'still counting…']);
  if (c.colour === 'reclaim') {
    rows.push(['Reclaim score', score === undefined || score === null
      ? 'not scored'
      : String(Math.round(typeof score === 'object' ? score.score : score)) + ' / 100']);
  }

  const swatch = `rgb(${b.rgb.map((v) => Math.round(v)).join(',')})`;
  card.innerHTML =
    `<div class="cc-head"><span class="cc-dot" style="background:${swatch}"></span>` +
    `<span class="cc-name">${escapeHtml(b.n.name)}</span></div>` +
    rows.map(([k, v]) => `<div class="cc-row"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join('') +
    (b.n.type === 'dir' ? `<div class="cc-hint">Click to go inside · Esc to come back out</div>` : '');
  card.dataset.path = b.n.path;
  card.dataset.k = cityCardKey(b); // what this card was built from — a later fact invalidates it
  card.hidden = false;

  // Kept inside the panel and away from the cursor, flipping side rather than
  // being clamped: a card pinned to the right edge covers what you are pointing at.
  const wrap = $('cityWrap');
  const cw = card.offsetWidth || 230, ch = card.offsetHeight || 90;
  const left = px + 18 + cw > wrap.clientWidth ? px - 18 - cw : px + 18;
  const top = py + 18 + ch > wrap.clientHeight ? py - 18 - ch : py + 18;
  card.style.left = Math.max(8, Math.min(left, wrap.clientWidth - cw - 8)) + 'px';
  card.style.top = Math.max(8, Math.min(top, wrap.clientHeight - ch - 8)) + 'px';
}

/** "3 weeks ago", not "21 days" — the card is read at a glance. */
function cityAgeWords(days) {
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 14) return `${Math.round(days)} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 730) return `${Math.round(days / 30.4)} months ago`;
  const years = days / 365.25;
  return `${years.toFixed(years < 10 ? 1 : 0)} years ago`;
}

function cityDrillInto(node) {
  if (!node || node.type !== 'dir') return;
  loadCity(node.path);
}

function cityUp() {
  if (!state.root || state.treemap.rootPath === state.root.path) return;
  const parent = tmParentPath(state.treemap.rootPath);
  loadCity(parent || state.root.path);
}

/* ── Wiring. Every listener added here is removed in unmount(). ─────────── */

function cityOnPointerDown(e) {
  const canvas = $('cityCanvas');
  canvas.setPointerCapture(e.pointerId);
  // §6.3 — here a plain drag already pans, so the lasso needs a modifier to
  // ask for it. Any of the three does: whichever one the user reached for,
  // they meant "select", and `lassoOpFor` reads which sense they meant.
  if (e.button === 0 && (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey)) {
    lassoStart(e, canvas);
    return;
  }
  state.city.drag = { x: e.clientX, y: e.clientY, panX: state.city.pan.x, panY: state.city.pan.y, moved: false };
}

function cityOnPointerMove(e) {
  const canvas = $('cityCanvas');
  const local = Canvas2D.toLocal(canvas, e.clientX, e.clientY);
  const c = state.city;
  if (state.lasso.on) { lassoMove(e); cityShowCard(null); return; }
  if (c.drag) {
    const dx = e.clientX - c.drag.x, dy = e.clientY - c.drag.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) c.drag.moved = true;
    c.pan = { x: c.drag.panX + dx, y: c.drag.panY + dy };
    cityShowCard(null);
    cityInvalidate();
    return;
  }
  const hit = cityHit(local.x, local.y);
  if (hit !== c.hover) { c.hover = hit; cityInvalidate(); }
  // Same block as last frame and the card already says everything it can
  // (a count or score that landed since changes the key): reposition it.
  // Rebuilding — rows serialised, innerHTML assigned, then a forced layout to
  // measure the card — on every frame inside one block was the treemap
  // tooltip's defect, one view over.
  const card = $('cityCard');
  const fresh = !!hit && !!card && !card.hidden && card.dataset.path === hit.n.path && card.dataset.k === cityCardKey(hit);
  if (!fresh) cityShowCard(hit, local.x, local.y);
  else cityMoveCard(local.x, local.y);
}

/** What the card's content depends on beyond the block itself: facts that arrive later. */
function cityCardKey(b) {
  return (state.city.counts.has(b.n.path) ? 'c' : '-') + (reclaim.scores.has(b.n.path) ? 's' : '-') + state.city.height + state.city.colour;
}

/**
 * Reposition the card that is already showing. No content is touched, so
 * layout is clean and the two size reads are plain reads, not a forced
 * reflow. Same flip-not-clamp placement as cityShowCard.
 */
function cityMoveCard(px, py) {
  const card = $('cityCard');
  if (!card || card.hidden) return;
  const wrap = $('cityWrap');
  const cw = card.offsetWidth || 230, ch = card.offsetHeight || 90;
  const left = px + 18 + cw > wrap.clientWidth ? px - 18 - cw : px + 18;
  const top = py + 18 + ch > wrap.clientHeight ? py - 18 - ch : py + 18;
  card.style.left = Math.max(8, Math.min(left, wrap.clientWidth - cw - 8)) + 'px';
  card.style.top = Math.max(8, Math.min(top, wrap.clientHeight - ch - 8)) + 'px';
}

function cityOnPointerUp(e) {
  const c = state.city;
  const canvas = $('cityCanvas');
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  if (state.lasso.on) { lassoEnd(); return; }
  const wasDrag = c.drag && c.drag.moved;
  c.drag = null;
  if (wasDrag) return; // a pan is not a click
  const local = Canvas2D.toLocal(canvas, e.clientX, e.clientY);
  const hit = cityHit(local.x, local.y);
  if (hit) cityDrillInto(hit.n);
}

/**
 * The pointer left the canvas: drop the hover, and the card that follows it.
 *
 * A named function rather than the inline closure it used to be, because
 * `mount()` runs on every visit to this view and `#cityCanvas` is static
 * markup that outlives all of them. An anonymous listener cannot be removed
 * by reference, so `unmount()` could not take it off and each visit left
 * another copy attached — measured going 1 → 4 across three visits. Harmless
 * per call and unbounded across a session, which is the exact leak §4.3 makes
 * the registry responsible for closing.
 */
function cityOnPointerLeave() {
  state.city.hover = null;
  cityShowCard(null);
  cityInvalidate();
}

function cityOnWheel(e) {
  e.preventDefault();
  const c = state.city;
  cityAnimateZoom((c.zoomTarget || c.zoom) * (e.deltaY < 0 ? 1.14 : 1 / 1.14));
}

function cityOnKey(e) {
  // Escape is deliberately NOT handled here. The document-level handler owns
  // it, so that it works whether or not the canvas has been clicked — which
  // §6.1 asks for and this binding alone could not deliver. Handling it in
  // both places climbed only one level by luck: `cityUp` reads
  // `state.treemap.rootPath`, which `loadCity` updates asynchronously, so two
  // synchronous calls happened to resolve to the same parent. That is a
  // coincidence to remove, not to rely on.
  const step = e.shiftKey ? 60 : 20;
  const c = state.city;
  if (e.key === 'ArrowLeft') { c.pan.x += step; cityInvalidate(); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { c.pan.x -= step; cityInvalidate(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { c.pan.y += step; cityInvalidate(); e.preventDefault(); }
  else if (e.key === 'ArrowDown') { c.pan.y -= step; cityInvalidate(); e.preventDefault(); }
  else if (e.key === '+' || e.key === '=') { cityAnimateZoom((c.zoomTarget || c.zoom) * 1.25); e.preventDefault(); }
  else if (e.key === '-' || e.key === '_') { cityAnimateZoom((c.zoomTarget || c.zoom) / 1.25); e.preventDefault(); }
}

function cityOnResize() { cityInvalidate(); }

function citySetHeight(requested) {
  const mode = cityMode(requested, CITY_HEIGHT_LABEL, 'staleness');
  state.city.height = mode;
  try { localStorage.setItem('tm-cityheight', mode); } catch { /* private mode */ }
  for (const b of $('cityHeightSeg').querySelectorAll('button')) {
    b.setAttribute('aria-selected', String(b.dataset.h === mode));
  }
  const before = new Map(state.city.blocks.map((b) => [b.n.path, b.z]));
  buildCity();
  if (!cityMorphHeights(before)) drawCity();
  renderCityTable();
  cityFetchFacts();
}

function citySetColour(requested) {
  const mode = cityMode(requested, CITY_COLOUR_LABEL, 'reclaim');
  state.city.colour = mode;
  try { localStorage.setItem('tm-citycolour', mode); } catch { /* private mode */ }
  for (const b of $('cityColorSeg').querySelectorAll('button')) {
    b.setAttribute('aria-selected', String(b.dataset.c === mode));
  }
  // Through `cityJitter`, exactly as the build pass does. Without it, two
  // hundred folders of the same kind flatten into one undifferentiated slab
  // the moment you switch to Type or Age — which is the thing the jitter was
  // written to prevent — until something happens to rebuild the layout.
  for (const b of state.city.blocks) b.rgb = cityJitter(cityRgb(b.n, mode), b.n.path);
  drawCity(); cityFetchFacts();
}

$('cityHeightSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-h]');
  if (btn) citySetHeight(btn.dataset.h);
});
$('cityColorSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-c]');
  if (btn) citySetColour(btn.dataset.c);
});
$('cityUpBtn').addEventListener('click', () => cityUp());
$('cityReset').addEventListener('click', () => {
  state.city.pan = { x: 0, y: 0 };
  cityAnimateZoom(1);
});
$('cityTableWrap').addEventListener('toggle', () => { if ($('cityTableWrap').open) renderCityTable(); });
$('cityTable').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-city-row]');
  if (!btn) return;
  const node = state.city.blocks.find((b) => b.n.path === btn.dataset.cityRow);
  // The same drill the canvas performs — a text equivalent that navigated by
  // its own route would be the second navigation mechanism §2.2 forbids.
  if (node) cityDrillInto(node.n);
});

registerView({
  id: 'city',
  label: 'Disk City',
  icon: 'box',
  needsScan: true,
  onScanChange() {
    state.city.counts.clear();
    state.city.countsFor = null;
    state.city.blocks = [];
    if (mountedView && mountedView.id === 'city') loadCity(state.root ? state.root.path : null);
  },
  mount() {
    refreshDock(); // §8.3 — the dock sits under this canvas too
    const canvas = $('cityCanvas');
    canvas.addEventListener('pointerdown', cityOnPointerDown);
    canvas.addEventListener('pointermove', cityOnPointerMove);
    canvas.addEventListener('pointerup', cityOnPointerUp);
    canvas.addEventListener('pointerleave', cityOnPointerLeave);
    canvas.addEventListener('wheel', cityOnWheel, { passive: false });
    canvas.addEventListener('keydown', cityOnKey);
    window.addEventListener('resize', cityOnResize);
    citySetHeight(state.city.height);
    citySetColour(state.city.colour);
    loadCity(state.treemap.rootPath);
  },
  unmount() {
    // Everything this view started, stopped. The registry exists for exactly
    // this: a canvas view that leaves a rAF and a resize listener behind keeps
    // repainting a hidden canvas for the rest of the session.
    const c = state.city;
    if (c.raf) { cancelAnimationFrame(c.raf); c.raf = 0; }
    if (c.morphRaf) { cancelAnimationFrame(c.morphRaf); c.morphRaf = 0; }
    if (c.zoomRaf) { cancelAnimationFrame(c.zoomRaf); c.zoomRaf = 0; }
    clearTimeout(c.zoomTimer);
    cityLoadSeq++; // invalidate anything still in flight
    const canvas = $('cityCanvas');
    if (canvas) {
      canvas.removeEventListener('pointerdown', cityOnPointerDown);
      canvas.removeEventListener('pointermove', cityOnPointerMove);
      canvas.removeEventListener('pointerup', cityOnPointerUp);
      canvas.removeEventListener('pointerleave', cityOnPointerLeave);
      canvas.removeEventListener('wheel', cityOnWheel);
      canvas.removeEventListener('keydown', cityOnKey);
    }
    window.removeEventListener('resize', cityOnResize);
    c.blocks = [];
    c.hover = null;
    c.drag = null;
    $('cityTable').innerHTML = '';
    $('cityCard').hidden = true;
  },
});

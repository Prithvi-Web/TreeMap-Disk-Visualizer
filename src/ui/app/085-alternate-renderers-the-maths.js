/* ═══════════════ v4 §6.2 — Alternate renderers: the maths ═══════════════

   Two more layouts over the SAME tree the treemap and the sunburst draw:
   nested circle packing, and a weighted centroidal Voronoi treemap. Neither is
   a new view — both are entries in the Treemap view's segmented control, and
   both read `sunburstRoot()`, so switching between the four is switching lens,
   not switching data.

   Everything in this block is deliberately a **plain function of its
   arguments**: no `state`, no canvas, no DOM. That is what lets
   `tests/circlePack.test.ts` and `tests/voronoiTreemap.test.ts` lift these out
   of this file and drive them against oracles built from first principles,
   which is the same standard §6.1's draw order was held to. A layout that is
   only ever checked by looking at it is a layout nobody can prove.

   Both are pure Canvas 2D maths. No WebGL, no D3, no dependency — §7.        */

/* ── Smallest enclosing circle (Welzl) ──────────────────────────────────── */

/** Does circle `a` completely contain circle `b`? */
function packEncloses(a, b) {
  const dr = a.r - b.r + Math.max(a.r, b.r, 1) * 1e-9;
  const dx = b.x - a.x, dy = b.y - a.y;
  return dr > 0 && dr * dr > dx * dx + dy * dy;
}

/** The circle through one circle: itself. */
function packBasis1(a) { return { x: a.x, y: a.y, r: a.r }; }

/** The smallest circle enclosing two, which spans the far side of each. */
function packBasis2(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dr = b.r - a.r;
  const l = Math.sqrt(dx * dx + dy * dy);
  // Concentric: the bigger one already encloses the other.
  if (l < 1e-12) return a.r >= b.r ? packBasis1(a) : packBasis1(b);
  return {
    x: (a.x + b.x + (dx / l) * dr) / 2,
    y: (a.y + b.y + (dy / l) * dr) / 2,
    r: (l + a.r + b.r) / 2,
  };
}

/**
 * The smallest circle enclosing three — the Apollonius problem, solved in
 * closed form.
 *
 * The unknown circle is internally tangent to all three, so its centre is the
 * point equidistant-minus-radius from each. Writing the two linear conditions
 * that come from subtracting the tangency equations pairwise leaves the centre
 * as an affine function of the unknown radius, and substituting that back into
 * one tangency equation gives a quadratic in the radius. `A` degenerating to
 * zero is the collinear-centres case, where the quadratic is really linear —
 * hence the branch rather than a bare division.
 */
function packBasis3(a, b, c) {
  const a2 = a.x - b.x, a3 = a.x - c.x;
  const b2 = a.y - b.y, b3 = a.y - c.y;
  const c2 = b.r - a.r, c3 = c.r - a.r;
  const d1 = a.x * a.x + a.y * a.y - a.r * a.r;
  const d2 = d1 - b.x * b.x - b.y * b.y + b.r * b.r;
  const d3 = d1 - c.x * c.x - c.y * c.y + c.r * c.r;
  const ab = a3 * b2 - a2 * b3;
  if (Math.abs(ab) < 1e-12) return packBasis2(a, b); // centres coincide pairwise
  const xa = (b2 * d3 - b3 * d2) / (ab * 2) - a.x;
  const xb = (b3 * c2 - b2 * c3) / ab;
  const ya = (a3 * d2 - a2 * d3) / (ab * 2) - a.y;
  const yb = (a2 * c3 - a3 * c2) / ab;
  const A = xb * xb + yb * yb - 1;
  const B = 2 * (a.r + xa * xb + ya * yb);
  const C = xa * xa + ya * ya - a.r * a.r;
  let r;
  if (Math.abs(A) > 1e-9) {
    const disc = B * B - 4 * A * C;
    if (!(disc >= 0)) return packBasis2(a, b); // numerically impossible triple
    r = -(B + Math.sqrt(disc)) / (2 * A);
  } else {
    if (Math.abs(B) < 1e-12) return packBasis2(a, b);
    r = -C / B;
  }
  return { x: a.x + xa + xb * r, y: a.y + ya + yb * r, r };
}

/**
 * A deterministic shuffle.
 *
 * Welzl's expected-linear bound needs the input in random order, and a layout
 * that moved when nothing about the disk had changed would be a defect rather
 * than a flourish. So the order is randomised by a fixed-seed xorshift: the
 * same input always produces the same packing, in this session and the next.
 */
function packShuffled(items) {
  const out = items.slice();
  let h = 0x9e3779b9;
  for (let i = out.length - 1; i > 0; i--) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    const j = (h >>> 0) % (i + 1);
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

/** The smallest circle containing every circle in `circles`. */
function packEnclose(circles) {
  if (!circles.length) return { x: 0, y: 0, r: 0 };
  const cs = packShuffled(circles);
  let e = null;
  for (let i = 0; i < cs.length; i++) {
    if (e && packEncloses(e, cs[i])) continue;
    e = packBasis1(cs[i]);
    for (let j = 0; j < i; j++) {
      if (packEncloses(e, cs[j])) continue;
      e = packBasis2(cs[i], cs[j]);
      for (let k = 0; k < j; k++) {
        if (packEncloses(e, cs[k])) continue;
        e = packBasis3(cs[i], cs[j], cs[k]);
      }
    }
  }
  return e;
}

/* ── Front-chain packing (Wang et al.) ──────────────────────────────────── */

/**
 * Put `c` tangent to both `a` and `b`, on the anticlockwise side.
 *
 * In the frame where `b - a` is the first axis, the tangency conditions are
 * two circles' worth of Pythagoras and reduce to one linear and one quadratic
 * equation; `Math.max(0, …)` under the root is the guard for the case where
 * `a` and `b` are further apart than `c` can bridge, which floating point can
 * produce even when the geometry says otherwise.
 */
function packPlace(a, b, c) {
  const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
  if (!(d2 > 0)) { c.x = a.x + a.r + c.r; c.y = a.y; return; }
  const ra = a.r + c.r, rb = b.r + c.r;
  const x = (d2 + ra * ra - rb * rb) / (2 * d2);
  const y = Math.sqrt(Math.max(0, (ra * ra) / d2 - x * x));
  c.x = a.x + x * dx - y * dy;
  c.y = a.y + x * dy + y * dx;
}

/** Do two circles overlap by more than rounding error? */
function packIntersects(a, b) {
  const dr = a.r + b.r - 1e-6;
  const dx = b.x - a.x, dy = b.y - a.y;
  return dr > 0 && dr * dr > dx * dx + dy * dy;
}

/** How close to the origin is the gap between this chain link and the next? */
function packChainScore(node) {
  const a = node.c, b = node.next.c;
  const ab = a.r + b.r;
  if (!(ab > 0)) return Infinity;
  const dx = (a.x * b.r + b.x * a.r) / ab;
  const dy = (a.y * b.r + b.y * a.r) / ab;
  return dx * dx + dy * dy;
}

/**
 * Pack circles around the origin, each touching its neighbours.
 *
 * The front chain: keep the circles on the outside of the packing so far in a
 * ring, always add the next circle into the gap nearest the centre, and if it
 * lands on top of something, delete the span it crossed from the ring and try
 * again. Wang, Wang, Dai and Zhang, 2006.
 *
 * `budget` is not decoration. The retry is the one unbounded thing in the
 * algorithm, and while it is proven to terminate on well-formed input, this
 * one is fed the sizes of whatever is on a stranger's disk. A packing that
 * spins forever would freeze the tab; a packing that stops early is visibly
 * wrong and says so through `unresolved`, which the caller shows. §6.2 asks
 * for exactly this on the Voronoi side and the reasoning is not different here.
 */
function packSiblings(circles) {
  const n = circles.length;
  let unresolved = 0;
  if (n === 0) return { circles, unresolved };
  circles[0].x = 0; circles[0].y = 0;
  if (n === 1) return { circles, unresolved };
  // The first pair straddles the origin rather than starting at it: the gap
  // chosen for each later circle is the one nearest the origin, so a packing
  // that began off-centre would grow lopsided.
  circles[0].x = -circles[1].r; circles[1].x = circles[0].r; circles[1].y = 0;
  if (n === 2) return { circles, unresolved };
  packPlace(circles[0], circles[1], circles[2]);

  let A = { c: circles[0] }, B = { c: circles[1] }, C = { c: circles[2] };
  A.next = C.prev = B; B.next = A.prev = C; C.next = B.prev = A;

  let budget = 64 * n + 256;
  outer: for (let i = 3; i < n; i++) {
    const cc = circles[i];
    // Tangent to the two links of the chosen gap, and on the OUTSIDE of the
    // chain. The argument order is what decides that: `packPlace` puts the new
    // circle anticlockwise of the a→b direction, so passing the gap's links in
    // chain order would place it *inside* the packing, on top of what is
    // already there. Measured, not reasoned about — with the arguments the
    // other way round a ten-circle pack overlapped by 59 units in a 200-unit
    // radius, which the sibling-overlap test now pins at zero.
    packPlace(B.c, A.c, cc);
    let j = B.next, k = A.prev, sj = B.c.r, sk = A.c.r;
    do {
      if (sj <= sk) {
        if (packIntersects(j.c, cc)) {
          if (--budget < 0) { unresolved++; break; }
          B = j; A.next = B; B.prev = A; i--; continue outer;
        }
        sj += j.c.r; j = j.next;
      } else {
        if (packIntersects(k.c, cc)) {
          if (--budget < 0) { unresolved++; break; }
          A = k; A.next = B; B.prev = A; i--; continue outer;
        }
        sk += k.c.r; k = k.prev;
      }
    } while (j !== k.next);

    const node = { c: cc, prev: A, next: B };
    A.next = node; B.prev = node; B = node;
    let best = packChainScore(A), t = node;
    while ((t = t.next) !== B) {
      const s = packChainScore(t);
      if (s < best) { best = s; A = t; }
    }
    B = A.next;
  }
  return { circles, unresolved };
}

/**
 * Lay a list of sizes out as circles inside a circle of radius `R` at the
 * origin.
 *
 * Radii go as the square root of the value, so **area** is proportional to
 * bytes — the same promise the treemap's rectangles make, which is the whole
 * reason the two are comparable at a glance.
 *
 * A value of zero gets no circle at all rather than a circle of radius zero:
 * an invisible dot that can still be hovered is a hit target for something the
 * user cannot see. They are counted in `omitted` and the caller says so.
 */
function circlePackChildren(values, R, opts) {
  const padding = (opts && opts.padding) || 0.02;
  const cap = (opts && opts.maxCircles) || 4096;
  const idx = [];
  for (let i = 0; i < values.length; i++) if (values[i] > 0) idx.push(i);
  // Biggest first: front-chain packing is markedly tighter that way, and it
  // also makes the cap drop the least significant things rather than a
  // arbitrary tail.
  idx.sort((p, q) => values[q] - values[p]);
  const omitted = values.length - Math.min(idx.length, cap);
  let omittedValue = 0;
  for (let i = 0; i < values.length; i++) if (!(values[i] > 0)) omittedValue += Math.max(0, values[i]);
  for (let i = cap; i < idx.length; i++) omittedValue += values[idx[i]];
  const kept = idx.slice(0, cap);
  if (!kept.length) return { circles: [], omitted, omittedValue, unresolved: 0 };

  const cs = kept.map((i) => ({ i, r: Math.sqrt(values[i]), x: 0, y: 0 }));
  const packed = packSiblings(cs);
  const hull = packEnclose(cs);
  // Scale the packing into the target circle, leaving a hairline of padding so
  // a child never appears to touch its parent's rim — which reads as a child
  // that has escaped rather than one that fits.
  const k = hull.r > 0 ? (R * (1 - padding)) / hull.r : 0;
  const circles = cs.map((c) => ({
    i: c.i,
    x: (c.x - hull.x) * k,
    y: (c.y - hull.y) * k,
    r: c.r * k,
  }));
  return { circles, omitted, omittedValue, unresolved: packed.unresolved };
}

/* ── Weighted centroidal Voronoi (Lloyd + power weights) ────────────────── */

/**
 * Clip a convex polygon to the half-plane `nx·x + ny·y ≤ c` (Sutherland–Hodgman).
 *
 * The whole Voronoi construction is this function called in a loop, which is
 * why it is worth being careful here: `da - db` can only be divided by when
 * the two endpoints are strictly on opposite sides, and both branches below
 * enter only in that case, so the division cannot produce a NaN.
 */
function polyClip(poly, nx, ny, c) {
  const out = [];
  const n = poly.length;
  if (!n) return out;
  let A = poly[n - 1];
  let da = nx * A.x + ny * A.y - c;
  for (let i = 0; i < n; i++) {
    const B = poly[i];
    const db = nx * B.x + ny * B.y - c;
    if (db <= 0) {
      if (da > 0) {
        const t = da / (da - db);
        out.push({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t });
      }
      out.push(B);
    } else if (da <= 0) {
      const t = da / (da - db);
      out.push({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t });
    }
    A = B; da = db;
  }
  return out;
}

/** Signed area of a polygon (positive anticlockwise). */
function polyArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  }
  return a / 2;
}

/** Area centroid, falling back to the vertex mean on a degenerate polygon. */
function polyCentroid(poly) {
  if (!poly.length) return null;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j].x * poly[i].y - poly[i].x * poly[j].y;
    a += f;
    cx += (poly[j].x + poly[i].x) * f;
    cy += (poly[j].y + poly[i].y) * f;
  }
  // A sliver with no area has no area centroid, and dividing by it is exactly
  // where a NaN enters a layout and never leaves again.
  if (Math.abs(a) < 1e-12) {
    let sx = 0, sy = 0;
    for (const p of poly) { sx += p.x; sy += p.y; }
    return { x: sx / poly.length, y: sy / poly.length };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Axis-aligned bounds of a polygon. */
function polyBounds(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return poly.length ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 0, y1: 0 };
}

/**
 * Shrink a convex polygon inward by `d` on every edge.
 *
 * An inset of a convex polygon is that polygon clipped by each of its own
 * edges moved inward, so this is `polyClip` again rather than a second piece
 * of geometry to keep in step with it. Returns an empty polygon when the
 * inset eats the shape, which is the honest answer for a sliver.
 */
function polyInset(poly, d) {
  if (poly.length < 3) return [];
  const c = polyCentroid(poly);
  if (!c) return [];
  let out = poly;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j].x, ay = poly[j].y, bx = poly[i].x, by = poly[i].y;
    let nx = by - ay, ny = ax - bx;
    const len = Math.hypot(nx, ny);
    if (!(len > 0)) continue; // a repeated vertex contributes no edge
    nx /= len; ny /= len;
    // Point the normal away from the interior, so "≤ c" is the inside.
    if (nx * c.x + ny * c.y > nx * ax + ny * ay) { nx = -nx; ny = -ny; }
    out = polyClip(out, nx, ny, nx * ax + ny * ay - d);
    if (out.length < 3) return [];
  }
  return out;
}

/** Is a point inside a polygon? Ray casting; used for site placement only. */
function polyContains(poly, px, py) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The power diagram of weighted sites, clipped to a convex boundary.
 *
 * A site owns the points where `|p − s|² − w` is smallest. Subtracting that
 * expression for two sites cancels the `|p|²` term, so every boundary between
 * two cells is a straight line and each cell is an intersection of
 * half-planes — which is why plain polygon clipping is the whole algorithm and
 * no Delaunay triangulation is needed.
 *
 * Because the boundary is convex and half-plane intersection preserves
 * convexity, every cell that comes out of here is convex. Nesting relies on
 * that: a child layout takes its parent's cell as its own boundary.
 */
function powerCells(sites, boundary) {
  const cells = new Array(sites.length);
  for (let i = 0; i < sites.length; i++) {
    const si = sites[i];
    const ki = si.x * si.x + si.y * si.y - si.w;
    let poly = boundary;
    for (let j = 0; j < sites.length; j++) {
      if (j === i || !poly.length) continue;
      const sj = sites[j];
      const nx = 2 * (sj.x - si.x), ny = 2 * (sj.y - si.y);
      if (nx === 0 && ny === 0) continue; // coincident: no line separates them
      poly = polyClip(poly, nx, ny, (sj.x * sj.x + sj.y * sj.y - sj.w) - ki);
    }
    cells[i] = poly;
  }
  return cells;
}

/**
 * Seed sites inside a convex polygon, deterministically.
 *
 * The additive-recurrence (golden-ratio) sequence spreads points far more
 * evenly than a pseudo-random one and is completely reproducible, which
 * matters twice over: Lloyd's algorithm converges much faster from an even
 * start, and a map that re-arranged itself on every repaint would be unusable
 * regardless of how correct its areas were.
 */
function voronoiSeedSites(boundary, n) {
  const bb = polyBounds(boundary);
  const w = bb.x1 - bb.x0, h = bb.y1 - bb.y0;
  const out = [];
  const PHI = 0.6180339887498949, PHI2 = 0.7548776662466927;
  let tries = 0;
  for (let i = 0; out.length < n && tries < n * 64 + 512; i++, tries++) {
    const u = (0.5 + PHI * i) % 1, v = (0.5 + PHI2 * i) % 1;
    const x = bb.x0 + u * w, y = bb.y0 + v * h;
    if (polyContains(boundary, x, y)) out.push({ x, y, w: 0 });
  }
  // A boundary so thin that rejection sampling cannot land in it still has a
  // centroid, so fall back to stacking the remainder there with a tiny spread
  // rather than returning fewer sites than were asked for.
  const c = polyCentroid(boundary) || { x: bb.x0, y: bb.y0 };
  for (let i = out.length; i < n; i++) {
    out.push({ x: c.x + (i % 7) * 1e-3, y: c.y + ((i * 3) % 11) * 1e-3, w: 0 });
  }
  return out;
}

/**
 * One Lloyd run: alternate moving the sites and reweighting them, and hand
 * back the best diagram seen rather than the last one.
 *
 * Three forces:
 *
 *   1. move every site to the centroid of its own cell — this is what stops
 *      the picture degenerating into slivers, and it has to keep running to
 *      the end: every schedule that faded it out was measured and every one
 *      of them made convergence *worse*, not better;
 *   2. scale every site's weight by how far its area is off target, so a cell
 *      that is too small pushes its own boundaries outward on the next pass;
 *   3. cap each weight against its neighbours' — see below, this one is the
 *      difference between converging and not.
 *
 * **The neighbour cap is relative, and that was the whole ball game.** Capping
 * each weight at its own distance-to-nearest-neighbour — the obvious reading,
 * and what the first version did — leaves a big cell unable to grow whenever a
 * small sibling happens to sit near it, because the cap is an absolute number
 * and weights only mean anything as differences. Measured on a folder-shaped
 * distribution the worst cell was 389% off its true share and stayed there.
 * Capping `w_i` at `min_j (w_j + d_ij²)` instead — the condition that actually
 * matters, that no site may be swallowed by a neighbour — took the same input
 * to 1.95%.
 *
 * **Best, not last.** On a hard input this oscillates rather than diverging:
 * one measured run reached 17% at pass 346 and was at 25% by pass 1200. The
 * whole diagram is one array of polygons, so remembering the best one costs a
 * reference, and returning the worst one for want of it would be silly.
 *
 * `anneal` narrows the per-pass weight change as the run goes on, which is
 * what damps that oscillation; `seeded` says the caller has already put an
 * approximate weight on each site, in which case the early passes are already
 * close and the wide steps would only throw them off.
 */
function voronoiSolve(sites, target, boundary, opts) {
  const o = opts || {};
  const maxIterations = o.maxIterations || 600;
  const tolerance = o.tolerance === undefined ? 0.02 : o.tolerance;
  const anneal = o.anneal || 0;
  // A hair under 1: at exactly 1 the neighbour's site sits precisely on the
  // shared edge, which is the degenerate case rather than a valid one.
  const SLACK = 0.99;
  const n = sites.length;
  const boundaryArea = Math.abs(polyArea(boundary));
  const minArea = boundaryArea * 1e-9;

  let best = null, bestError = Infinity, iterations = 0;

  for (let iter = 1; iter <= maxIterations; iter++) {
    iterations = iter;
    const cells = powerCells(sites, boundary);
    let maxError = 0;
    for (let i = 0; i < n; i++) {
      const err = Math.abs(Math.abs(polyArea(cells[i])) - target[i]) / target[i];
      if (err > maxError) maxError = err;
    }
    if (maxError < bestError) { bestError = maxError; best = cells; }
    if (maxError <= tolerance) return { cells, maxError, iterations, converged: true };
    if (iter === maxIterations) break; // cap reached: keep the best, say so

    // Per-pass weight change, clamped. Unclamped, a cell a thousand times too
    // small multiplies its weight by a thousand in one step, overshoots, and
    // the diagram rings for hundreds of passes working it back off.
    let rMax = 2, rMin = 0.5;
    if (anneal) {
      const k = 1 + Math.pow(1 - iter / maxIterations, anneal);
      rMax = k; rMin = 1 / k;
    }
    for (let i = 0; i < n; i++) {
      const area = Math.abs(polyArea(cells[i]));
      if (area > minArea) {
        const c = polyCentroid(cells[i]);
        if (c && Number.isFinite(c.x) && Number.isFinite(c.y)) { sites[i].x = c.x; sites[i].y = c.y; }
      }
      // A swallowed cell keeps its position — there is no centroid to move to —
      // and is rescued by the weight step rather than by a guess.
      const rate = Math.min(rMax, Math.max(rMin, target[i] / Math.max(area, minArea)));
      const w = sites[i].w * rate;
      // Floor at a hair above zero, never back at a starting weight: a cell
      // that has shrunk its way down to nothing must STAY small relative to its
      // neighbours, and resetting it throws the whole diagram back to the
      // beginning. Measured: the reset version stalled a 56-cell folder at 32%
      // error where the floor converges to 2%.
      sites[i].w = Number.isFinite(w) ? Math.max(1e-9, w) : 1e-9;
    }

    // No site may be swallowed by a neighbour: past that point its cell is
    // empty, its own weight explodes, and the two trade places forever instead
    // of converging. Read from a snapshot so the cap does not depend on which
    // order the sites happen to be visited in.
    const w = sites.map((si) => si.w);
    for (let i = 0; i < n; i++) {
      let cap = Infinity;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const dx = sites[j].x - sites[i].x, dy = sites[j].y - sites[i].y;
        const c = w[j] + (dx * dx + dy * dy) * SLACK;
        if (c < cap) cap = c;
      }
      if (Number.isFinite(cap) && cap > 0) sites[i].w = Math.min(sites[i].w, cap);
    }
  }
  return { cells: best || [], maxError: bestError, iterations, converged: false };
}

/**
 * A Voronoi treemap: cells whose areas are proportional to `values`.
 *
 * **The iteration cap is hard, and required.** §6.2: "a pathological input
 * cannot hang the frame." A run that hits the cap returns the best diagram it
 * found, with `converged: false` and the error it reached, and the caller
 * prints that rather than quietly presenting an inexact map as an exact one.
 *
 * **Two starts, keep the better.** Seeding each weight from the area that site
 * is supposed to end up with makes the first pass an approximate answer rather
 * than a uniform one, and on ordinary folder distributions that is a five- to
 * ten-fold speed-up — 886 passes down to 105, 548 down to 56. On a folder with
 * one enormous child and a long tail it can also settle into a local minimum
 * that flat weights walk straight past. Neither start dominates, both are
 * cheap at the sizes where the hard cases live, so it runs the fast one and
 * falls back to the patient one only when the fast one did not get there.
 *
 * **`maxCells` and `minCellArea` are the same bargain the isometric view's
 * level-of-detail line makes.** The cost is O(n²) per pass and hundreds of
 * passes are needed, so four hundred cells is a fifth of a second; and a cell
 * of a hundred square pixels is a ten-pixel square that can be hovered but not
 * read. The biggest `maxCells` above the floor are laid out, and everything
 * else comes back as `omitted`, for the caller to state out loud.
 *
 * `maxError` is the worst single cell's error **relative to its own target**,
 * not to the total. The gentler figure everyone reports — the sum of the
 * errors over twice the total area — reads under 1% on a map whose smallest
 * cell is twice the size it should be, which is exactly the kind of true
 * sentence that leaves a false impression.
 */
function voronoiTreemap(values, boundary, opts) {
  const o = opts || {};
  const maxCells = o.maxCells || 96;
  const tolerance = o.tolerance === undefined ? 0.02 : o.tolerance;
  // The floor is an AREA, not a share, and that distinction was measured. A
  // share of the parent reads sensibly at the top level and absurdly three
  // levels down, where 0.2% of an already-small cell is a quarter of a pixel;
  // an area says the one thing that actually matters — "there is not enough
  // room here to draw this" — in the same units at every level.
  const minCellArea = o.minCellArea === undefined ? 100 : o.minCellArea;

  const empty = {
    cells: [], iterations: 0, maxError: 0, converged: true,
    omitted: 0, omittedValue: 0,
  };
  if (!boundary || boundary.length < 3) return empty;
  const boundaryArea = Math.abs(polyArea(boundary));
  if (!(boundaryArea > 0)) return empty;

  // A value of zero asks for a cell of zero area, which is not a cell. Dropped
  // here, counted, and reported — never drawn as a sliver that can be hovered.
  const ranked = [];
  for (let i = 0; i < values.length; i++) if (values[i] > 0) ranked.push(i);
  ranked.sort((p, q) => values[q] - values[p]);

  // Cap FIRST, then apply the legibility floor to what is left — in that order
  // and not the other. Judging the floor against the whole folder throws away
  // every cell when a folder holds two thousand equal things, each of which is
  // a twentieth of a per cent of it: the honest answer there is "the biggest
  // ninety-six, and here is how many were left out", not an empty panel.
  const kept = ranked.slice(0, maxCells);
  let keptTotal = 0;
  for (const i of kept) keptTotal += values[i];
  while (kept.length > 1 &&
         (values[kept[kept.length - 1]] / keptTotal) * boundaryArea < minCellArea) {
    keptTotal -= values[kept.pop()];
  }
  let omittedValue = 0;
  for (let i = 0; i < values.length; i++) omittedValue += Math.max(0, values[i]);
  omittedValue -= keptTotal;
  let omitted = values.length - kept.length;
  if (!kept.length) return { ...empty, omitted, omittedValue };

  const n = kept.length;
  if (n === 1) {
    return {
      cells: [{ i: kept[0], poly: boundary.slice(), area: boundaryArea }],
      iterations: 0, maxError: 0, converged: true, omitted, omittedValue,
    };
  }

  /* Two caps, and the second one is not redundant.

     The per-attempt cap scales with the work, because the work is O(n²) per
     pass. A fixed number is wrong at both ends and both ends were measured:
     240 passes starved a six-cell folder and left its worst cell 249% off,
     while the same 240 over ninety-six cells is a fifth of a second of main
     thread. A constant amount of TOTAL work instead gives a small layout every
     pass it can use — they cost nothing — and a large one the most it can
     afford.

     `passBudget` then caps the whole call, across both starting points and
     every shrink retry. Without it the retries multiply the per-attempt cap by
     up to eighteen, and they did: a real `node_modules` — ninety-odd children
     of very similar size, which is the worst possible shape for this
     algorithm — spent **2.7 seconds** on one layout against §2.5's 250 ms
     first-paint budget, and still did not converge. Two caps, because "how
     long may one attempt take" and "how many attempts may there be" are
     different questions and only bounding the first bounds nothing. */
  const maxIterations = o.maxIterations ||
    Math.max(120, Math.min(1200, Math.round(1.5e6 / (n * n))));
  // Both caps are expressed as WORK, not as a number of passes, because a pass
  // over ninety cells costs sixteen times one over twenty-two. Measured at
  // roughly 43 million half-plane clips a second on this machine, six million
  // clips is about 140 ms — which leaves room inside §2.5's 250 ms for the
  // nested levels and the drawing.
  const passBudget = o.passBudget ||
    Math.max(360, Math.min(6000, Math.round(6e6 / (n * n))));

  const bb = polyBounds(boundary);
  const diag = Math.hypot(bb.x1 - bb.x0, bb.y1 - bb.y0);
  const w0 = Math.pow(diag * 0.002, 2);

  /* Solve; and if the areas will not come true, make the question smaller.
     ─────────────────────────────────────────────────────────────────────
     What defeats this algorithm is not size, it is DYNAMIC RANGE. A folder
     whose largest child is two thousand times its smallest asks for a cell
     that its neighbours can squeeze to nothing before the weights can hold it
     open, and no number of passes fixes that — measured, on a real Desktop:
     one child at 98.9% of the folder left the worst cell 125% off after both
     starts and 2,400 passes.

     Dropping the smallest cell and asking again is the honest move rather than
     the lazy one. The alternative is a map that draws twenty-three cells whose
     areas do not mean what the view exists to claim they mean — and the cells
     being surrendered are the ones already closest to the floor. Every one of
     them is added to `omitted`, which the footnote prints, so the picture says
     "here is an exact map of the eight things that fit, and 101 more did not"
     instead of "here is an approximate map of everything". */
  let cur = kept.slice();
  let curTotal = keptTotal;
  let run = null, iterations = 0, target = null;
  /* How far apart the biggest and smallest drawn cells may be — bounded from
     the START, not only after a failure.

     A first attempt on a set the solver cannot possibly resolve is the most
     expensive thing this function can do and the least likely to pay: at
     seventy cells it eats most of the pass budget, leaves no room to descend,
     and ends with a diagram 584% out. Beginning inside a plausible range means
     the first attempt usually just converges.

     The bound scales with n² because that is how tolerance for spread actually
     behaves — measured, on real folders: ten cells resolve a 3,000:1 spread,
     thirty-six need about 250:1, seventy-odd about 120:1. The constant is set
     so the curve sits slightly INSIDE each of those, because being one cell
     too cautious costs a footnote line and being one too greedy costs the
     claim the whole view rests on. */
  let range = Math.max(80, Math.min(4000, 2.5e5 / (n * n)));
  {
    const floor = values[cur[0]] / range;
    while (cur.length > 2 && values[cur[cur.length - 1]] < floor) {
      const dropped = cur.pop();
      curTotal -= values[dropped];
      omittedValue += values[dropped];
      omitted++;
    }
  }
  // How many times it may give ground. Generous, because the real bound is
  // `passBudget` above: on the inputs where many retries are needed the cells
  // are few, and few cells make a pass almost free — a ten-child folder with a
  // two-thousand-to-one spread wants to shed half its tail before the areas
  // can come true, and doing so costs it about twenty milliseconds.
  const maxShrinks = o.maxShrinks === undefined ? 24 : o.maxShrinks;

  for (let attempt = 0; ; attempt++) {
    const m = cur.length;
    target = cur.map((i) => (values[i] / curTotal) * boundaryArea);
    if (m === 1) {
      run = { cells: [boundary.slice()], maxError: 0, iterations: 0, converged: true };
      break;
    }
    const left = passBudget - iterations;
    if (left <= 0 && run) break; // out of budget, and something already drawn
    // Never above the caller's cap. A floor here would quietly let an
    // explicitly small `maxIterations` run longer than it asked to, which is
    // the one thing a cap must not do.
    const cap = Math.max(1, Math.min(maxIterations, left));

    // Start one: every site already carrying roughly the weight its own share
    // implies, so the first diagram is an approximate answer.
    const seeded = voronoiSeedSites(boundary, m);
    for (let i = 0; i < m; i++) seeded[i].w = Math.max(1e-9, target[i] / Math.PI);
    run = voronoiSolve(seeded, target, boundary, { maxIterations: cap, tolerance });
    iterations += run.iterations;

    if (!run.converged && passBudget - iterations >= Math.min(20, maxIterations)) {
      // Start two: equal weights, so the first pass is an ordinary Voronoi
      // diagram, with the step size narrowing as it goes. Slower to get moving
      // and better at not settling for the first minimum it finds.
      const flat = voronoiSeedSites(boundary, m);
      for (const s of flat) s.w = w0;
      const second = voronoiSolve(flat, target, boundary, {
        maxIterations: Math.min(cap, passBudget - iterations), tolerance, anneal: 1,
      });
      iterations += second.iterations;
      if (second.converged || second.maxError < run.maxError) run = second;
    }
    if (run.converged || attempt >= maxShrinks || cur.length <= 2) break;
    if (passBudget - iterations < Math.min(20, maxIterations)) break;

    /* Halve the DYNAMIC RANGE, and drop whatever no longer fits inside it.

       This is the fix for the thing that actually defeats a power diagram, and
       it took two wrong answers to find. It is not the number of cells — a
       hundred near-equal siblings solve in fifty passes. It is the ratio
       between the biggest cell and the smallest: a folder whose largest child
       is 95% of it asks for neighbours a thousand times smaller, and no number
       of passes produces those, because the constraint that keeps a site
       inside its own cell puts a floor under how small that cell can get next
       to its neighbours.

       Dropping the smallest cell, or a quarter of them, only helps by
       accident — it moves the ratio a little, and mostly it does not. Halving
       the allowed range attacks the cause directly, and every real folder
       measured lands inside two or three halvings:

         Desktop      267% → 2% at 1/250     (24 children, 2 drawn)
         Treemap      936% → 1% at 1/250     (36 children, 6 drawn)
         node_modules 581% → 2% at 1/120     (386 children, 21 drawn)

       What is given up is real and is stated: a cell a hundred times smaller
       than the biggest thing on screen is a few pixels, and the footnote counts
       it out by name. An exact map of six things beats an approximate map of
       eleven, because "area is bytes" is the only claim this view makes. */
    range /= 2;
    const floor = values[cur[0]] / range;
    const before = cur.length;
    while (cur.length > 2 && values[cur[cur.length - 1]] < floor) {
      const dropped = cur.pop();
      curTotal -= values[dropped];
      omittedValue += values[dropped];
      omitted++;
    }
    /* Halving the range is the right lever for a lopsided folder and the wrong
       one for a bunched one, where it can bite nothing at all — and a bunched
       folder of ninety cells is expensive per attempt, so an attempt that
       barely moves is an attempt wasted. So there is also a floor on how much
       each pass gives up, scaled by how costly the layout still is: a quarter
       while it is expensive, a tenth while it is middling, and one at a time
       once passes are cheap enough to try every size on the way down. Below
       sixteen cells the single step finds exact answers a bigger step goes
       straight past.

       Both levers, because the two failure modes are different and each one
       alone leaves the other unfixed — measured: range-halving alone took a
       real Desktop from 267% to 2% and left a ninety-six-cell fixture at 73%. */
    const minDrop = before > 40 ? Math.max(1, Math.round((before - 2) * 0.25))
      : before > 16 ? Math.max(1, Math.round((before - 2) * 0.1))
      : 1;
    while (cur.length > 2 && before - cur.length < minDrop) {
      const dropped = cur.pop();
      curTotal -= values[dropped];
      omittedValue += values[dropped];
      omitted++;
    }
  }

  const out = [];
  for (let i = 0; i < cur.length; i++) {
    const poly = run.cells[i];
    if (!poly || poly.length < 3) continue; // squeezed out entirely — not a cell
    out.push({ i: cur[i], poly, area: Math.abs(polyArea(poly)) });
  }
  return {
    cells: out, iterations, maxError: run.maxError, converged: run.converged,
    omitted, omittedValue,
  };
}

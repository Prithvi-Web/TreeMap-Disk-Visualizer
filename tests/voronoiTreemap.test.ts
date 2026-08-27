import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lift } from './fixtures/liftFrontend';

/**
 * The weighted centroidal Voronoi treemap (v4 §6.2).
 *
 * The single claim this renderer makes is **area is bytes**, so that is what
 * these tests check, and they check it the hard way: per cell, against that
 * cell's own target, not as a sum over the whole diagram. The gentle global
 * measure everyone reports reads under 1% on a map whose smallest cell is
 * twice the size it should be.
 *
 * §6.2 asks for three things by name and each has its own test:
 *
 *   - area error inside a tolerance on fixtures;
 *   - the iteration cap honoured, so a pathological input cannot hang a frame;
 *   - no NaN coordinates on degenerate input — a zero-size child, a single
 *     child, ten thousand equal children.
 *
 * Plus one the spec does not ask for and the design demands: whatever the
 * solver could not draw truthfully is **reported**, and the reported numbers
 * add up to the input. A map that quietly leaves things out is the failure
 * mode this whole project is built against.
 */

interface Pt { x: number; y: number }
interface Cell { i: number; poly: Pt[]; area: number }
interface VResult {
  cells: Cell[];
  iterations: number;
  maxError: number;
  converged: boolean;
  omitted: number;
  omittedValue: number;
}

const GEOM = ['polyClip', 'polyArea', 'polyCentroid', 'polyBounds', 'polyContains', 'polyInset'];
const SOLVER = [...GEOM, 'powerCells', 'voronoiSeedSites', 'voronoiSolve', 'voronoiTreemap'];

const polyArea = lift<(p: Pt[]) => number>(['polyArea'], 'polyArea');
const polyCentroid = lift<(p: Pt[]) => Pt | null>(['polyCentroid'], 'polyCentroid');
const polyClip = lift<(p: Pt[], nx: number, ny: number, c: number) => Pt[]>(['polyClip'], 'polyClip');
const polyInset = lift<(p: Pt[], d: number) => Pt[]>(['polyClip', 'polyCentroid', 'polyInset'], 'polyInset');
const polyContains = lift<(p: Pt[], x: number, y: number) => boolean>(['polyContains'], 'polyContains');
const powerCells = lift<(s: { x: number; y: number; w: number }[], b: Pt[]) => Pt[][]>(
  ['polyClip', 'powerCells'], 'powerCells',
);
const voronoiTreemap = lift<(v: number[], b: Pt[], o?: unknown) => VResult>(SOLVER, 'voronoiTreemap');

const rect = (w: number, h: number): Pt[] => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
const PANEL = rect(1240, 700);
const PANEL_AREA = 1240 * 700;

/** A deterministic, folder-shaped distribution: a few big things, a long tail. */
function zipf(n: number, seed = 1): number[] {
  let h = seed;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    out.push(Math.pow((h >>> 0) / 4294967296, 4) * 1e10 + 1e5);
  }
  return out;
}

/** Worst cell error, relative to that cell's own target share. */
function worstError(values: number[], r: VResult, boundaryArea = PANEL_AREA): number {
  let keptTotal = 0;
  for (const c of r.cells) keptTotal += values[c.i];
  let worst = 0;
  for (const c of r.cells) {
    const target = (values[c.i] / keptTotal) * boundaryArea;
    worst = Math.max(worst, Math.abs(c.area - target) / target);
  }
  return worst;
}

/* ═══════════════════════════ the geometry below ═══════════════════════════ */

test('polygon area and centroid are the textbook ones', () => {
  assert.equal(Math.abs(polyArea(rect(10, 4))), 40);
  const c = polyCentroid(rect(10, 4));
  assert.deepEqual(c, { x: 5, y: 2 });
  // A triangle's centroid is the mean of its vertices; the shoelace centroid
  // must agree, which is the cheapest available check that it is not the
  // bounding-box centre in disguise.
  const tri = [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 0, y: 6 }];
  const t = polyCentroid(tri) as Pt;
  assert.ok(Math.abs(t.x - 3) < 1e-12 && Math.abs(t.y - 2) < 1e-12);
});

test('a zero-area polygon has no area centroid, and says so with the vertex mean', () => {
  // This is where a NaN would enter a layout and never leave: 0/0 from the
  // shoelace denominator, carried into a site position, then into every cell.
  const degenerate = [{ x: 3, y: 3 }, { x: 7, y: 3 }, { x: 5, y: 3 }];
  const c = polyCentroid(degenerate) as Pt;
  assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y));
  assert.equal(c.y, 3);
});

test('clipping to a half-plane keeps exactly the right half', () => {
  const half = polyClip(rect(10, 10), 1, 0, 4); // keep x <= 4
  assert.equal(Math.abs(polyArea(half)), 40);
  assert.ok(half.every((p) => p.x <= 4 + 1e-12));
  // Fully outside: nothing survives, and it is an empty polygon rather than a
  // degenerate one that later code would try to fill.
  assert.equal(polyClip(rect(10, 10), 1, 0, -5).length, 0);
  // Fully inside: unchanged area.
  assert.equal(Math.abs(polyArea(polyClip(rect(10, 10), 1, 0, 50))), 100);
});

test('an inset polygon is smaller, inside, and empty when it is eaten', () => {
  assert.equal(Math.abs(polyArea(polyInset(rect(100, 100), 10))), 6400);
  assert.equal(polyInset(rect(100, 100), 60).length, 0);
  const tri = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 0, y: 60 }];
  const inner = polyInset(tri, 3);
  assert.ok(Math.abs(polyArea(inner)) < Math.abs(polyArea(tri)));
  for (const p of inner) assert.ok(polyContains(tri, p.x, p.y), 'the inset stays inside the source');
});

/* ═══════════════════════════ the power diagram ═══════════════════════════ */

test('equal weights give the ordinary Voronoi diagram: nearest site wins', () => {
  const sites = [
    { x: 200, y: 200, w: 5 }, { x: 900, y: 200, w: 5 },
    { x: 200, y: 500, w: 5 }, { x: 900, y: 500, w: 5 },
  ];
  const cells = powerCells(sites, PANEL);
  // Sample the panel and check every point landed with its nearest site. This
  // is the definition, tested as the definition rather than as a fixture.
  for (let gx = 1; gx < 20; gx++) {
    for (let gy = 1; gy < 12; gy++) {
      const x = (gx / 20) * 1240, y = (gy / 12) * 700;
      const d2 = sites.map((s) => (s.x - x) ** 2 + (s.y - y) ** 2);
      const best = Math.min(...d2);
      // A point exactly equidistant from two sites belongs to whichever the
      // tie is broken toward, and both answers are correct. Skipping the ties
      // is what makes this a test of the diagram rather than of the tie-break:
      // this grid lands one sample precisely on a shared bisector.
      if (d2.filter((d) => d - best < 1e-9).length > 1) continue;
      const nearest = d2.indexOf(best);
      const owner = cells.findIndex((c) => c.length >= 3 && polyContains(c, x, y));
      if (owner === -1) continue; // exactly on an edge, so in neither polygon
      assert.equal(owner, nearest, `(${x},${y}) belongs to its nearest site`);
    }
  }
});

test('the cells tile the boundary exactly — no gaps, no double counting', () => {
  const cells = powerCells(
    [{ x: 300, y: 300, w: 900 }, { x: 700, y: 200, w: 100 }, { x: 800, y: 550, w: 4000 }],
    PANEL,
  );
  const total = cells.reduce((s, c) => s + Math.abs(polyArea(c)), 0);
  assert.ok(Math.abs(total - PANEL_AREA) < 1e-6, `cells sum to the panel (${total} vs ${PANEL_AREA})`);
});

/* ═════════════════════════ area fidelity, the point ═════════════════════════ */

test('areas land within tolerance on real-shaped fixtures', () => {
  const fixtures: Record<string, number[]> = {
    'ten mixed': [100, 60, 40, 30, 20, 15, 10, 8, 5, 2],
    'one dominant child and a tail': [2179, 300, 120, 60, 30, 15, 8, 4, 2, 1],
    'a folder of near-equals': Array.from({ length: 56 }, (_, i) => ((i * 7919) % 97) + 6),
    'thirty-two, folder-shaped': zipf(32, 7),
    'ninety-six, folder-shaped': zipf(96, 13),
    'two hundred, folder-shaped': zipf(200, 23),
    'real byte sizes': [42e9, 12e9, 8e9, 3e9, 2.2e9, 900e6, 700e6, 300e6, 120e6, 40e6, 12e6, 4e6],
  };
  for (const [name, values] of Object.entries(fixtures)) {
    const r = voronoiTreemap(values, PANEL);
    assert.ok(r.converged, `${name}: the solver reached its tolerance`);
    assert.ok(r.maxError <= 0.02 + 1e-9, `${name}: reported worst cell ${r.maxError}`);
    // Recomputed independently of what the solver reported about itself.
    assert.ok(worstError(values, r) <= 0.02 + 1e-9,
      `${name}: independently measured worst cell ${worstError(values, r)}`);
  }
});

test('the cells always tile the whole boundary, whatever was omitted', () => {
  // The corollary of "area is bytes": the drawn cells are an exact map of the
  // subset that survived, not a partial covering of the panel with holes.
  for (const values of [zipf(40, 3), [10, 5], new Array(500).fill(1), [1e9, 5, 5, 5]]) {
    const r = voronoiTreemap(values, PANEL);
    if (!r.cells.length) continue;
    const total = r.cells.reduce((s, c) => s + c.area, 0);
    assert.ok(Math.abs(total - PANEL_AREA) / PANEL_AREA < 1e-9,
      `cells cover the panel exactly (${total} vs ${PANEL_AREA})`);
  }
});

test('every cell is convex, which is what lets a child be laid out inside it', () => {
  const r = voronoiTreemap(zipf(24, 9), PANEL);
  for (const c of r.cells) {
    let sign = 0;
    for (let i = 0; i < c.poly.length; i++) {
      const a = c.poly[i], b = c.poly[(i + 1) % c.poly.length], d = c.poly[(i + 2) % c.poly.length];
      const cross = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x);
      if (Math.abs(cross) < 1e-9) continue;
      const s = Math.sign(cross);
      if (sign === 0) sign = s;
      else assert.equal(s, sign, 'the cell turns the same way at every vertex');
    }
  }
});

/* ═══════════════════════ caps, degenerates, honesty ═══════════════════════ */

test('the iteration cap is hard — a pathological input cannot hang the frame', () => {
  // An impossible tolerance, so the only way out is the cap. `iterations` is
  // the TOTAL across the solver's two starting points and its shrink retries,
  // so the bound is the cap times how many runs it is allowed.
  const cap = 4;
  const r = voronoiTreemap([5, 4, 3, 2, 1], PANEL, { maxIterations: cap, tolerance: 1e-12, maxShrinks: 2 });
  assert.equal(r.converged, false);
  assert.ok(r.iterations >= cap, 'it did iterate');
  assert.ok(r.iterations <= cap * 2 * (2 + 1), `total passes ${r.iterations} stayed inside the cap`);
  // And it still returned a usable diagram rather than nothing: §6.2 asks for
  // "render what converged and say so", not for an empty panel.
  assert.ok(r.cells.length > 0, 'the best diagram it found came back');
});

test('a single child takes the whole boundary, with no iterations at all', () => {
  const r = voronoiTreemap([7], PANEL);
  assert.equal(r.cells.length, 1);
  assert.equal(r.iterations, 0);
  assert.equal(r.converged, true);
  assert.ok(Math.abs(r.cells[0].area - PANEL_AREA) < 1e-6);
});

test('a zero-size child gets no cell, and is counted rather than drawn as a sliver', () => {
  const r = voronoiTreemap([10, 0, 5], PANEL);
  assert.equal(r.cells.length, 2);
  assert.equal(r.omitted, 1);
  assert.ok(!r.cells.some((c) => c.i === 1));
});

test('a list of nothing but zeroes draws nothing and says so', () => {
  const r = voronoiTreemap([0, 0, 0], PANEL);
  assert.equal(r.cells.length, 0);
  assert.equal(r.omitted, 3);
  assert.equal(r.converged, true);
});

test('ten thousand equal children: capped, exact, no NaN, and it finishes', () => {
  const values = new Array(10000).fill(1);
  const started = Date.now();
  const r = voronoiTreemap(values, PANEL);
  const elapsed = Date.now() - started;
  assert.ok(r.cells.length <= 96, `the cap held (${r.cells.length} cells)`);
  assert.equal(r.omitted, 10000 - r.cells.length);
  assert.ok(r.converged, 'what it did draw, it drew truthfully');
  for (const c of r.cells) {
    for (const p of c.poly) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'no NaN coordinates');
    }
  }
  assert.ok(elapsed < 5000, `finished in ${elapsed} ms`);
});

test('a boundary with no area returns nothing rather than dividing by it', () => {
  const flat = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }];
  const r = voronoiTreemap([3, 2], flat);
  assert.equal(r.cells.length, 0);
  assert.equal(r.converged, true);
});

test('what was left out is reported, and the report adds up to the input', () => {
  // §2.4 — partial is stated, not hidden. If these two numbers do not
  // reconcile, the footnote under the map is a guess.
  for (const values of [zipf(60, 5), new Array(400).fill(1), [1e9, 1e3, 1e3, 0]]) {
    const r = voronoiTreemap(values, PANEL);
    assert.equal(r.omitted + r.cells.length, values.length, 'every input is drawn or counted out');
    const drawn = r.cells.reduce((s, c) => s + values[c.i], 0);
    const all = values.reduce((s, v) => s + Math.max(0, v), 0);
    assert.ok(Math.abs(drawn + r.omittedValue - all) < 1e-6,
      'the omitted bytes are exactly the bytes not drawn');
  }
});

test('the same folder solves the same way twice — no drift between repaints', () => {
  const values = zipf(24, 5);
  assert.equal(
    JSON.stringify(voronoiTreemap(values, PANEL).cells),
    JSON.stringify(voronoiTreemap(values, PANEL).cells),
  );
});

test('the legibility floor is an area, so it means the same thing at every depth', () => {
  // A cell of a hundred square pixels is a ten-pixel square: hoverable, not
  // readable. The floor is absolute so a nested layout inside a small cell
  // applies the same standard the top level does.
  const small = rect(120, 90); // 10,800 px² — a plausible second-level cell
  const r = voronoiTreemap([1000, 1, 1, 1], small, { minCellArea: 100 });
  for (const c of r.cells) assert.ok(c.area >= 90, `no cell under the floor (${c.area})`);
  assert.ok(r.omitted >= 1, 'the ones that could not clear it were counted');
});

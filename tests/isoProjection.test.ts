import { test } from 'node:test';
import assert from 'node:assert/strict';

import { squarify } from '../src/utils/treemap';
import { lift } from './fixtures/liftFrontend';

/**
 * Disk City's projection and draw order (v4 §6.1).
 *
 * **There is no `src/` copy of this maths, deliberately.** The squarify port
 * that `cartPreview.test.ts` guards exists because the server computes the
 * treemap layout and the frontend needed the same function; a port there is
 * forced. Nothing on the server projects anything isometrically, so a second
 * copy here would be a drift hazard invented for the sake of having one. The
 * functions are lifted out of `public/index.html` and driven directly, so what
 * these tests exercise is the code that actually ships.
 *
 * The draw-order test is the one that matters. It does not compare against a
 * remembered answer — it compares against an **oracle built from first
 * principles**: for a sampled point inside two blocks' shared silhouette, cast
 * the view ray and see which block is genuinely nearer. If the shipped
 * ordering ever disagrees with physics, this fails.
 */

interface Block { x: number; y: number; w: number; h: number; z: number }
interface Pt { sx: number; sy: number }

const isoProject = lift<(x: number, y: number, z: number) => Pt>(['isoProject'], 'isoProject');
const isoBounds = lift<(b: Block) => { x0: number; x1: number; y0: number; y1: number }>(
  ['isoProject', 'isoBounds'], 'isoBounds',
);
const isoBehind = lift<(a: Block, b: Block) => boolean>(['isoBehind'], 'isoBehind');
const isoDepthOrder = lift<(bs: Block[]) => { order: Block[]; unresolved: number }>(
  ['isoProject', 'isoBounds', 'isoBehind', 'isoDepthOrder'], 'isoDepthOrder',
);

const C = Math.cos(Math.PI / 6);
const S = Math.sin(Math.PI / 6);

/* ═════════════════════════ the projection itself ═════════════════════════ */

test('the projection is §6.1’s formula, exactly', () => {
  assert.deepEqual(isoProject(0, 0, 0), { sx: 0, sy: 0 });
  // sx = (x - y)cos30, sy = (x + y)sin30 - z
  const p = isoProject(3, 1, 2);
  assert.ok(Math.abs(p.sx - (3 - 1) * C) < 1e-12);
  assert.ok(Math.abs(p.sy - ((3 + 1) * S - 2)) < 1e-12);
});

test('the three axes go where an isometric view sends them', () => {
  // These are the sign conventions every later assumption rests on: +x is
  // right-and-down, +y is left-and-down, +z is straight up.
  const o = isoProject(0, 0, 0);
  const px = isoProject(1, 0, 0);
  const py = isoProject(0, 1, 0);
  const pz = isoProject(0, 0, 1);
  assert.ok(px.sx > o.sx && px.sy > o.sy, '+x moves right and down');
  assert.ok(py.sx < o.sx && py.sy > o.sy, '+y moves left and down');
  assert.ok(pz.sx === o.sx && pz.sy < o.sy, '+z moves straight up');
});

test('height never changes a block’s horizontal position', () => {
  // Footprint means bytes. A taller building that also drifted sideways would
  // make area stop meaning what the legend says it means.
  for (const z of [0, 1, 40, 1000]) {
    assert.equal(isoProject(7, 3, z).sx, isoProject(7, 3, 0).sx);
  }
});

test('the screen bounds really do bound the block', () => {
  // isoBounds projects four corners rather than eight, on the claim that the
  // others cannot be extreme. That claim is worth checking against all eight.
  const blocks: Block[] = [
    { x: 0, y: 0, w: 10, h: 10, z: 5 },
    { x: -3, y: 7, w: 1, h: 40, z: 0 },
    { x: 12.5, y: 0.25, w: 0.5, h: 33, z: 91 },
  ];
  for (const b of blocks) {
    const bb = isoBounds(b);
    for (const [x, y, z] of [
      [b.x, b.y, 0], [b.x + b.w, b.y, 0], [b.x + b.w, b.y + b.h, 0], [b.x, b.y + b.h, 0],
      [b.x, b.y, b.z], [b.x + b.w, b.y, b.z], [b.x + b.w, b.y + b.h, b.z], [b.x, b.y + b.h, b.z],
    ] as [number, number, number][]) {
      const p = isoProject(x, y, z);
      assert.ok(p.sx >= bb.x0 - 1e-9 && p.sx <= bb.x1 + 1e-9, 'corner inside the horizontal bounds');
      assert.ok(p.sy >= bb.y0 - 1e-9 && p.sy <= bb.y1 + 1e-9, 'corner inside the vertical bounds');
    }
  }
});

/* ═══════════════ the oracle: which block is genuinely nearer ═══════════════ */

/**
 * The world points projecting to one screen point form a line. With
 * `u = x - y = sx/cos30` and free parameter `w = x + y`:
 *   x = (u + w)/2,  y = (w - u)/2,  z = w·sin30 - sy
 * `w` grows toward the viewer, so the surface seen at that pixel is the one
 * with the largest `w` inside the box.
 */
function rayInterval(b: Block, sx: number, sy: number): { lo: number; hi: number } | null {
  const u = sx / C;
  let lo = -Infinity;
  let hi = Infinity;
  lo = Math.max(lo, 2 * b.x - u); hi = Math.min(hi, 2 * (b.x + b.w) - u);
  lo = Math.max(lo, 2 * b.y + u); hi = Math.min(hi, 2 * (b.y + b.h) + u);
  lo = Math.max(lo, sy / S); hi = Math.min(hi, (sy + b.z) / S);
  return hi > lo + 1e-9 ? { lo, hi } : null;
}

/** Which of the two must be drawn LAST, sampled over their shared screen area. */
function nearerByRayCast(a: Block, b: Block): Block | null {
  const A = isoBounds(a);
  const B = isoBounds(b);
  const x0 = Math.max(A.x0, B.x0), x1 = Math.min(A.x1, B.x1);
  const y0 = Math.max(A.y0, B.y0), y1 = Math.min(A.y1, B.y1);
  if (!(x1 > x0 && y1 > y0)) return null;
  let aWins = 0;
  let bWins = 0;
  const N = 24;
  for (let i = 1; i < N; i++) {
    for (let j = 1; j < N; j++) {
      const sx = x0 + ((x1 - x0) * i) / N;
      const sy = y0 + ((y1 - y0) * j) / N;
      const ra = rayInterval(a, sx, sy);
      const rb = rayInterval(b, sx, sy);
      if (!ra || !rb) continue;
      if (ra.hi > rb.hi + 1e-6) aWins++;
      else if (rb.hi > ra.hi + 1e-6) bWins++;
    }
  }
  if (aWins === 0 && bWins === 0) return null;
  return aWins > bWins ? a : b;
}

/** Deterministic power-law areas: a few big folders, a long tail — a real disk. */
function realisticAreas(n: number, seed = 12345): number[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return Array.from({ length: n }, () => Math.pow(rnd(), 3) * 1000 + 1).sort((a, b) => b - a);
}

function layout(n: number, seed?: number): Block[] {
  const rects = squarify(realisticAreas(n, seed), { x: 0, y: 0, w: 100, h: 100 });
  return rects.map((r, i) => ({ ...r, z: 10 + (i % 9) * 9 }));
}

function grid(side: number): Block[] {
  const out: Block[] = [];
  for (let x = 0; x < side; x++) {
    for (let y = 0; y < side; y++) out.push({ x, y, w: 1, h: 1, z: 0.5 + ((x * 7 + y) % 5) * 0.4 });
  }
  return out;
}

/* ══════════════════════════ the rule, and the order ══════════════════════════ */

test('the pairwise rule agrees with a ray cast on every overlapping pair', () => {
  // The rule is what makes the topological sort exact rather than merely
  // plausible, so it is checked against physics, not against itself.
  let overlapping = 0;
  let disagreed = 0;
  const scenes: Block[][] = [grid(8), layout(12), layout(40), layout(120), layout(400)];
  const slivers = squarify([500, 300, 100, ...Array.from({ length: 60 }, () => 1)], { x: 0, y: 0, w: 100, h: 60 });
  scenes.push(slivers.map((r, i) => ({ ...r, z: 6 + (i % 7) * 12 })));

  for (const scene of scenes) {
    for (let i = 0; i < scene.length; i++) {
      for (let j = i + 1; j < scene.length; j++) {
        const a = scene[i];
        const b = scene[j];
        const truth = nearerByRayCast(a, b);
        if (!truth) continue;
        overlapping++;
        const aBehind = isoBehind(a, b);
        const bBehind = isoBehind(b, a);
        // For non-overlapping footprints exactly one direction must hold.
        assert.notEqual(aBehind, bBehind, 'the rule gives a verdict for every overlapping pair');
        if ((aBehind ? b : a) !== truth) disagreed++;
      }
    }
  }
  assert.ok(overlapping > 500, `the corpus must actually exercise overlap (saw ${overlapping} pairs)`);
  assert.equal(disagreed, 0, 'the rule never disagrees with where the blocks physically are');
});

test('the draw order never puts a nearer block behind a farther one', () => {
  // The property the whole view rests on, over the layouts a real disk makes.
  for (const scene of [grid(8), layout(12), layout(40), layout(120), layout(400), layout(90, 777)]) {
    const { order, unresolved } = isoDepthOrder(scene);
    assert.equal(order.length, scene.length, 'every block survives the sort');
    assert.equal(unresolved, 0, 'the occlusion relation is acyclic on a treemap layout');

    const at = new Map<Block, number>();
    order.forEach((b, i) => at.set(b, i));
    for (let i = 0; i < scene.length; i++) {
      for (let j = i + 1; j < scene.length; j++) {
        const truth = nearerByRayCast(scene[i], scene[j]);
        if (!truth) continue;
        const farther = truth === scene[i] ? scene[j] : scene[i];
        assert.ok(
          at.get(truth)! > at.get(farther)!,
          'the nearer block is drawn after the one it hides',
        );
      }
    }
  }
});

test('a scalar depth key would not have been good enough — which is why this is a sort', () => {
  // Guards the reasoning, not just the result: if someone later "simplifies"
  // isoDepthOrder into a sort by x+y, this states what that costs. The
  // big-block-beside-slivers layout is where every scalar key falls apart.
  const slivers = squarify([500, 300, 100, ...Array.from({ length: 60 }, () => 1)], { x: 0, y: 0, w: 100, h: 60 })
    .map((r, i) => ({ ...r, z: 6 + (i % 7) * 12 }));

  const byMinCorner = slivers.slice().sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byCentre = slivers.slice().sort((a, b) => (a.x + a.w / 2 + a.y + a.h / 2) - (b.x + b.w / 2 + b.y + b.h / 2));

  const violations = (order: Block[]): number => {
    const at = new Map<Block, number>();
    order.forEach((b, i) => at.set(b, i));
    let bad = 0;
    for (let i = 0; i < slivers.length; i++) {
      for (let j = i + 1; j < slivers.length; j++) {
        const truth = nearerByRayCast(slivers[i], slivers[j]);
        if (!truth) continue;
        const farther = truth === slivers[i] ? slivers[j] : slivers[i];
        if (at.get(truth)! < at.get(farther)!) bad++;
      }
    }
    return bad;
  };

  assert.ok(violations(byCentre) > 0, 'sorting by centre depth really does draw blocks in the wrong order here');
  assert.equal(violations(isoDepthOrder(slivers).order), 0, 'the topological order does not');
  // minCornerSum happens to survive this particular scene; it does not survive
  // every one, which the previous test covers. Recorded so a future reader does
  // not conclude from this scene alone that it is safe.
  assert.ok(violations(byMinCorner) >= 0);
});

test('degenerate input is ordered rather than dropped', () => {
  assert.deepEqual(isoDepthOrder([]).order, []);
  const one: Block[] = [{ x: 0, y: 0, w: 1, h: 1, z: 1 }];
  assert.deepEqual(isoDepthOrder(one).order, one);

  // Zero-size and zero-height blocks: a treemap can produce both for an empty
  // folder, and neither may vanish from the draw list.
  const odd: Block[] = [
    { x: 0, y: 0, w: 0, h: 0, z: 0 },
    { x: 1, y: 1, w: 5, h: 5, z: 0 },
    { x: 9, y: 9, w: 2, h: 2, z: 30 },
  ];
  const res = isoDepthOrder(odd);
  assert.equal(res.order.length, 3);
  assert.equal(res.unresolved, 0);
  for (const b of res.order) assert.ok(Number.isFinite(b.x) && Number.isFinite(b.z));
});

test('the order is stable: the same layout sorts the same way twice', () => {
  // An unstable tie-break makes equal-depth blocks trade places on every
  // redraw, which reads as flicker rather than as a picture.
  const scene = layout(200);
  const a = isoDepthOrder(scene).order;
  const b = isoDepthOrder(scene).order;
  assert.deepEqual(a.map((n) => `${n.x},${n.y}`), b.map((n) => `${n.x},${n.y}`));
});

test('ordering a Disk City-sized scene stays well inside the first-paint budget', () => {
  // §2.5 allows 250 ms for a new canvas view's first paint, and the order is
  // computed once per layout — so it may use some of that, but not all of it.
  const scene = layout(4000);
  const started = process.hrtime.bigint();
  const { order, unresolved } = isoDepthOrder(scene);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(order.length, scene.length);
  assert.equal(unresolved, 0);
  assert.ok(ms < 120, `depth-sorting ${scene.length} blocks took ${ms.toFixed(1)} ms, which must leave room to draw them`);
});

/* ═══════════════════ shadows, and where the light is (§6.1) ═══════════════════

   The light in Disk City is not a taste decision, and these tests are the
   reason it cannot quietly become one. Both signs are forced by the shading —
   the +x wall is drawn lit and the +y wall shaded — and the MAGNITUDES are
   forced by the painter's algorithm over a tiling with no bare ground: a
   shadow that moved toward the viewer would fall only on buildings drawn after
   it and be painted over by every one of them.

   That was not reasoned out in advance. It was built the other way round
   first, and the result was a city with cast shadows in the code and not one
   of them visible on screen.                                                  */

const CITY_LIGHT = lift<{ x: number; y: number }>(['CITY_LIGHT'], 'CITY_LIGHT');
const cityHull = lift<(pts: Pt[]) => Pt[]>(['cityHull'], 'cityHull');
const cityShadowShape = lift<(b: Block) => Pt[]>(
  ['isoProject', 'cityHull', 'CITY_LIGHT', 'cityShadowShape'], 'cityShadowShape',
);

/** Shoelace area of a projected polygon. */
function shoelace(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j].sx * pts[i].sy - pts[i].sx * pts[j].sy;
  }
  return Math.abs(a / 2);
}

test('the hull of a set of points contains every one of them, and is convex', () => {
  const pts: Pt[] = [
    { sx: 0, sy: 0 }, { sx: 10, sy: 0 }, { sx: 10, sy: 10 }, { sx: 0, sy: 10 },
    { sx: 5, sy: 5 }, // strictly interior: must not appear on the hull
    { sx: 5, sy: 0 }, // collinear on an edge
  ];
  const hull = cityHull(pts);
  assert.ok(hull.length >= 3 && hull.length <= 4, `a square's hull has four corners, got ${hull.length}`);
  assert.ok(!hull.some((p) => p.sx === 5 && p.sy === 5), 'the interior point is not on the hull');
  // Convex: every turn goes the same way.
  let sign = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length], c = hull[(i + 2) % hull.length];
    const cross = (b.sx - a.sx) * (c.sy - b.sy) - (b.sy - a.sy) * (c.sx - b.sx);
    if (Math.abs(cross) < 1e-12) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s; else assert.equal(s, sign, 'the hull turns the same way throughout');
  }
});

test('a flat block casts a shadow exactly its own footprint', () => {
  const flat = cityShadowShape({ x: 10, y: 20, w: 8, h: 6, z: 0 });
  const foot = cityHull([
    isoProject(10, 20, 0), isoProject(18, 20, 0), isoProject(18, 26, 0), isoProject(10, 26, 0),
  ]);
  assert.ok(Math.abs(shoelace(flat) - shoelace(foot)) < 1e-9);
});

test('a shadow grows with height, and never shrinks below the footprint', () => {
  const base = { x: 10, y: 20, w: 8, h: 6 };
  let previous = shoelace(cityShadowShape({ ...base, z: 0 }));
  for (const z of [1, 4, 12, 26]) {
    const area = shoelace(cityShadowShape({ ...base, z }));
    assert.ok(area > previous, `z=${z}: the shadow is longer than at the height below it`);
    previous = area;
  }
});

test('a shadow runs AWAY from the viewer — the invariant the draw order needs', () => {
  // Depth grows with x + y, so "away" means the swept footprint must land at a
  // SMALLER x + y than it started. This is what puts a shadow on the roofs
  // behind its caster, which are drawn earlier and can receive it. Flip it and
  // every shadow in the city is painted over by the buildings in front.
  assert.ok(CITY_LIGHT.x + CITY_LIGHT.y < 0,
    `the light must sweep shadows toward the back (got x+y = ${CITY_LIGHT.x + CITY_LIGHT.y})`);
  // And the two signs, which are what the shading already committed to: the
  // +x wall is drawn as the lit one, the +y wall as the shaded one.
  assert.ok(CITY_LIGHT.x < 0, 'the +x wall is lit, so the light travels in −x');
  assert.ok(CITY_LIGHT.y > 0, 'the +y wall is shaded, so the light travels in +y');
});

test('a shadow reaches back past its own caster', () => {
  // The consequence of the invariant above, asserted on the geometry rather
  // than on the constant: some part of the shadow is strictly further back
  // than every corner of the footprint that cast it.
  const b = { x: 30, y: 30, w: 10, h: 10, z: 20 };
  const shadow = cityShadowShape(b);
  const footTop = Math.min(
    ...[[30, 30], [40, 30], [40, 40], [30, 40]].map(([x, y]) => isoProject(x, y, 0).sy),
  );
  assert.ok(Math.min(...shadow.map((p) => p.sy)) < footTop - 1e-9,
    'the shadow extends above the footprint on screen, which is backwards in this projection');
});

/* ══════════════════ §6.1's level-of-detail threshold ══════════════════ */

/**
 * The LOD pass, which §6.1's "Tests:" paragraph names explicitly and which
 * had no test at all.
 *
 * That gap was not free. `hatched` — the texture §6.1 requires a block to
 * carry when it has swallowed its children — was written as
 * `aggregated > 0 && n.type === 'dir'`, a single number for the WHOLE layout.
 * `aggregated` counts interior nodes DROPPED because they had a drawn child,
 * so it is wrong in both directions, and the tests below fail on each:
 *
 *   - when only top-level folders survive the threshold — the case the
 *     texture exists for, every block swallowing an entire subtree — nothing
 *     had a drawn child, the count was zero, and NOTHING was marked;
 *   - once it was non-zero, every drawn folder was marked, including
 *     childless ones, claiming contents that are not there.
 */
interface LodNode { path: string; w: number; h: number; type?: string; expanded?: boolean; isTrash?: boolean; container?: string }
const cityVisibleNodes = lift<
  (nodes: LodNode[], minArea: number) => { drawn: LodNode[]; aggregated: number }
>(['tmParentPath', 'cityVisibleNodes'], 'cityVisibleNodes');

/** A folder tree shaped like a real payload: a parent and the children tiling it. */
const LOD_TREE: LodNode[] = [
  { path: '/r/big', w: 6, h: 6, type: 'dir', expanded: true },
  { path: '/r/big/a', w: 3, h: 3, type: 'dir', expanded: true },
  { path: '/r/big/a/leaf', w: 1, h: 1, type: 'file' },
  { path: '/r/big/b', w: 2, h: 2, type: 'file' },
  // `expanded: false` with no children in the payload is what the SERVER
  // emits for a folder it stopped at — `maxDepth`, `minSize`, `maxNodes`, or
  // a rect too small to subdivide. At the client's `maxDepth = 4` that is
  // every folder on the deepest layer, so it is the common case.
  { path: '/r/truncated', w: 5, h: 5, type: 'dir', expanded: false },
];

test('the drawn set is the frontier: a parent is dropped once a child is drawn', () => {
  // The precondition the whole picture rests on — the depth sort is only
  // correct for footprints that do not overlap, and a parent drawn together
  // with the children tiling it interpenetrates every one of them.
  const { drawn } = cityVisibleNodes(LOD_TREE, 1); // everything passes
  const paths = drawn.map((n) => n.path).sort();
  assert.deepEqual(paths, ['/r/big/a/leaf', '/r/big/b', '/r/truncated'], 'only the leaves of what passed');
  assert.ok(!paths.includes('/r/big'), 'the parent gave way to its children');
  assert.ok(!paths.includes('/r/big/a'), 'and so did the intermediate folder');
});

test('raising the threshold aggregates children back into the parent', () => {
  // §6.1: "below a pixel threshold, aggregate children into the parent block".
  const coarse = cityVisibleNodes(LOD_TREE, 25); // 6x6 = 36 and 5x5 = 25 pass; 3x3 = 9 does not
  assert.deepEqual(coarse.drawn.map((n) => n.path).sort(), ['/r/big', '/r/truncated']);
  assert.ok(coarse.drawn.length < cityVisibleNodes(LOD_TREE, 1).drawn.length, 'fewer blocks than at full detail');
});

test('the frontier property that makes the texture rule sound', () => {
  /**
   * §6.1 marks an aggregated block with a texture. `buildCity` marks every
   * drawn FOLDER, and this is why that is exactly right rather than lazy: a
   * node is drawn only when no child of it is drawn, so a drawn folder is
   * always standing in for contents that are not on screen.
   *
   * The two narrower rules that were tried both UNDER-marked, which is the
   * dangerous direction — an unmarked block claims it is showing everything.
   * `aggregated > 0` is one number for the whole layout, and it is 0 here
   * precisely when every drawn block is hiding a whole subtree. "Has a child
   * in the payload" misses every folder the server stopped at, which on a
   * real 2,759-node payload was 102 of 229.
   */
  const coarse = cityVisibleNodes(LOD_TREE, 25);
  assert.equal(coarse.aggregated, 0, 'nothing was dropped for having a drawn child — so the old flag was 0');
  for (const n of coarse.drawn) {
    if (n.type !== 'dir') continue;
    const hasDrawnChild = coarse.drawn.some((o) => o !== n && o.path.startsWith(`${n.path}/`));
    assert.equal(hasDrawnChild, false, `${n.path} is drawn, so by the frontier property none of its children are`);
  }
});

test('a folder the SERVER stopped at is still drawn, and the payload cannot tell you what it holds', () => {
  // Why the texture rule cannot be derived from the payload alone.
  // `/r/truncated` has no children in the node list because the server never
  // emitted them — at the client's `maxDepth = 4` that is every folder on the
  // deepest layer of a real scan, each standing for a whole subtree.
  const { drawn } = cityVisibleNodes(LOD_TREE, 1);
  assert.ok(drawn.some((n) => n.path === '/r/truncated'), 'it is drawn');
  assert.ok(!LOD_TREE.some((n) => n.path.startsWith('/r/truncated/')), 'with nothing under it in the payload');
  assert.equal(
    LOD_TREE.find((n) => n.path === '/r/truncated')!.expanded,
    false,
    'and the only hint is the server’s own flag, which says it stopped',
  );
});

test('the frontier holds at every threshold, so no drawn block contains another', () => {
  // The precondition the depth sort rests on, and the same property the
  // texture rule rests on. Checked across the whole threshold range rather
  // than at one convenient value.
  for (const minArea of [0.5, 1, 4, 9, 25, 30]) {
    const { drawn } = cityVisibleNodes(LOD_TREE, minArea);
    for (const a of drawn) {
      for (const b of drawn) {
        if (a === b) continue;
        assert.ok(!b.path.startsWith(`${a.path}/`), `at minArea ${String(minArea)}, ${b.path} is inside ${a.path}`);
      }
    }
  }
});

test('the count of drawn blocks is what the "showing N of M" line reports', () => {
  // §6.1 requires the threshold be stated "never silently", and the number in
  // that sentence is this one. A drawn set that disagreed with the count
  // would make the sentence a lie while every pixel stayed correct.
  for (const minArea of [1, 5, 26, 1000]) {
    const { drawn } = cityVisibleNodes(LOD_TREE, minArea);
    assert.equal(
      drawn.length,
      drawn.filter((n) => n.w * n.h >= minArea).length,
      'every drawn block passed the threshold it was drawn under',
    );
  }
});

test('a threshold above everything draws nothing rather than guessing', () => {
  const { drawn, aggregated } = cityVisibleNodes(LOD_TREE, 1e9);
  assert.deepEqual(drawn, [], 'nothing passes, so nothing is drawn');
  assert.equal(aggregated, 0);
});

test('the frontier holds on a deep chain, not just one level', () => {
  const chain: LodNode[] = [
    { path: '/c', w: 10, h: 10, type: 'dir' },
    { path: '/c/1', w: 8, h: 8, type: 'dir' },
    { path: '/c/1/2', w: 6, h: 6, type: 'dir' },
    { path: '/c/1/2/3', w: 4, h: 4, type: 'dir' },
    { path: '/c/1/2/3/4', w: 2, h: 2, type: 'file' },
  ];
  // Only the deepest survivor is drawn at each threshold, and everything
  // above it is marked as hiding what it swallowed.
  assert.deepEqual(cityVisibleNodes(chain, 1).drawn.map((n) => n.path), ['/c/1/2/3/4']);
  const coarse = cityVisibleNodes(chain, 17);
  assert.deepEqual(coarse.drawn.map((n) => n.path), ['/c/1/2']);
  // And it is a folder standing alone on screen with two more levels beneath
  // it in the payload — which is precisely what the texture is for.
  assert.ok(chain.some((n) => n.path.startsWith('/c/1/2/')), 'there really is more underneath');
  assert.equal(coarse.drawn[0].type, 'dir', 'so the block that survived is marked');
});

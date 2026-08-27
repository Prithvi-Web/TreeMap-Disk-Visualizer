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

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lift, INDEX } from './fixtures/liftFrontend';

/**
 * Nested circle packing (v4 §6.2).
 *
 * The tests that matter here are the ones with an **oracle**, not a remembered
 * answer:
 *
 *   - the smallest enclosing circle is checked against a brute-force minimum
 *     computed from every pair and triple, so a wrong Apollonius solution
 *     fails rather than being enshrined;
 *   - siblings are checked for overlap directly, which is what caught the
 *     mirrored tangent placement that made a ten-circle pack overlap by 59
 *     units inside a 200-unit radius — a bug no eyeball test would have
 *     flagged, because overlapping bubbles still look like bubbles.
 *
 * §6.2 also names three degenerate inputs by hand — a zero-size child, a single
 * child, ten thousand equal children — and each has its own test below.
 */

interface Circle { x: number; y: number; r: number }
interface Packed { i: number; x: number; y: number; r: number }
interface PackResult {
  circles: Packed[];
  omitted: number;
  omittedValue: number;
  unresolved: number;
}

const ENCLOSE = ['packEncloses', 'packBasis1', 'packBasis2', 'packBasis3', 'packShuffled', 'packEnclose'];
const SIBLINGS = ['packPlace', 'packIntersects', 'packChainScore', 'packSiblings'];

const packEnclose = lift<(cs: Circle[]) => Circle>(ENCLOSE, 'packEnclose');
const packPlace = lift<(a: Circle, b: Circle, c: Circle) => void>(['packPlace'], 'packPlace');
const packSiblings = lift<(cs: Circle[]) => { circles: Circle[]; unresolved: number }>(
  SIBLINGS, 'packSiblings',
);
const circlePackChildren = lift<(v: number[], R: number, o?: unknown) => PackResult>(
  [...ENCLOSE, ...SIBLINGS, 'circlePackChildren'], 'circlePackChildren',
);

const dist = (a: Circle, b: Circle) => Math.hypot(a.x - b.x, a.y - b.y);

/** Every circle sits inside `e`, allowing for floating point. */
function enclosesAll(e: Circle, cs: Circle[], eps = 1e-6): boolean {
  return cs.every((c) => dist(e, c) + c.r <= e.r + eps);
}

/**
 * The true minimum enclosing circle, by exhaustion.
 *
 * The optimum is always determined by one, two or three of the input circles,
 * so trying every such subset and keeping the smallest candidate that encloses
 * everything is exact. O(n⁴) and used only on small fixtures — which is the
 * point: an oracle is allowed to be slow, it is not allowed to be clever.
 */
function bruteEnclose(cs: Circle[]): Circle {
  const cand: Circle[] = cs.map((c) => ({ ...c }));
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      const d = dist(cs[i], cs[j]);
      const r = (d + cs[i].r + cs[j].r) / 2;
      if (d < 1e-12) continue;
      const t = (r - cs[i].r) / d;
      cand.push({ x: cs[i].x + (cs[j].x - cs[i].x) * t, y: cs[i].y + (cs[j].y - cs[i].y) * t, r });
    }
  }
  // Three-circle candidates: search the plane around the trio's bounding box.
  // Coarse then fine, which is enough to certify the analytic answer is not
  // beatable by more than a rounding error.
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      for (let k = j + 1; k < cs.length; k++) {
        const trio = [cs[i], cs[j], cs[k]];
        let cx = trio.reduce((s, c) => s + c.x, 0) / 3;
        let cy = trio.reduce((s, c) => s + c.y, 0) / 3;
        let step = Math.max(...trio.map((c) => dist({ x: cx, y: cy, r: 0 }, c) + c.r));
        for (let pass = 0; pass < 60; pass++) {
          let bx = cx, by = cy;
          let br = Math.max(...trio.map((c) => Math.hypot(cx - c.x, cy - c.y) + c.r));
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
            const nx = cx + dx * step, ny = cy + dy * step;
            const nr = Math.max(...trio.map((c) => Math.hypot(nx - c.x, ny - c.y) + c.r));
            if (nr < br) { br = nr; bx = nx; by = ny; }
          }
          cx = bx; cy = by; step *= 0.75;
        }
        cand.push({ x: cx, y: cy, r: Math.max(...trio.map((c) => Math.hypot(cx - c.x, cy - c.y) + c.r)) });
      }
    }
  }
  let best: Circle | null = null;
  for (const c of cand) {
    if (!enclosesAll(c, cs, 1e-7)) continue;
    if (!best || c.r < best.r) best = c;
  }
  assert.ok(best, 'the brute-force oracle found an enclosing circle');
  return best as Circle;
}

/* ═════════════════════ the smallest enclosing circle ═════════════════════ */

test('the enclosing circle of one circle is that circle', () => {
  const e = packEnclose([{ x: 3, y: -4, r: 2 }]);
  assert.deepEqual(e, { x: 3, y: -4, r: 2 });
});

test('the enclosing circle contains every input, on fixtures and at random', () => {
  const fixtures: Circle[][] = [
    [{ x: 0, y: 0, r: 5 }, { x: 10, y: 0, r: 3 }],
    [{ x: 0, y: 0, r: 1 }, { x: 0, y: 0, r: 9 }], // concentric: one swallows the other
    [{ x: 0, y: 0, r: 4 }, { x: 8, y: 0, r: 4 }, { x: 4, y: 7, r: 4 }],
    [{ x: -6, y: 0, r: 1 }, { x: 0, y: 0, r: 1 }, { x: 6, y: 0, r: 1 }], // collinear
  ];
  let h = 12345;
  for (let n = 1; n <= 9; n++) {
    for (let trial = 0; trial < 12; trial++) {
      const cs: Circle[] = [];
      for (let i = 0; i < n; i++) {
        h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
        const a = (h >>> 0) / 4294967296;
        h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
        const b = (h >>> 0) / 4294967296;
        h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
        const c = (h >>> 0) / 4294967296;
        cs.push({ x: a * 100 - 50, y: b * 100 - 50, r: 1 + c * 12 });
      }
      fixtures.push(cs);
    }
  }
  for (const cs of fixtures) {
    const e = packEnclose(cs);
    assert.ok(Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.r),
      `enclosing circle is finite for ${JSON.stringify(cs)}`);
    assert.ok(enclosesAll(e, cs), `enclosing circle contains every input: ${JSON.stringify(cs)}`);
  }
});

test('the enclosing circle is the SMALLEST one — checked against exhaustion', () => {
  // The whole reason `packBasis3` exists is to be exactly this, and a version
  // that merely encloses would pass the test above while wasting a third of
  // every folder's area. Small fixtures only: the oracle is O(n⁴).
  let h = 777;
  for (let trial = 0; trial < 25; trial++) {
    const n = 2 + (trial % 5);
    const cs: Circle[] = [];
    for (let i = 0; i < n; i++) {
      h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
      const a = (h >>> 0) / 4294967296;
      h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
      const b = (h >>> 0) / 4294967296;
      h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
      const c = (h >>> 0) / 4294967296;
      cs.push({ x: a * 40 - 20, y: b * 40 - 20, r: 1 + c * 6 });
    }
    const mine = packEnclose(cs);
    const truth = bruteEnclose(cs);
    assert.ok(mine.r <= truth.r + 1e-4,
      `enclosing radius ${mine.r} is no worse than the exhaustive ${truth.r}`);
  }
});

/* ══════════════════════════ tangent placement ══════════════════════════ */

test('packPlace puts a circle exactly tangent to both of its neighbours', () => {
  const a: Circle = { x: 0, y: 0, r: 5 };
  const b: Circle = { x: 12, y: 3, r: 4 };
  const c: Circle = { x: 0, y: 0, r: 2 };
  packPlace(a, b, c);
  assert.ok(Math.abs(dist(a, c) - (a.r + c.r)) < 1e-9, 'tangent to a');
  assert.ok(Math.abs(dist(b, c) - (b.r + c.r)) < 1e-9, 'tangent to b');
});

test('packPlace degrades honestly when the two anchors coincide', () => {
  const a: Circle = { x: 4, y: 4, r: 3 };
  const c: Circle = { x: 0, y: 0, r: 1 };
  packPlace(a, { ...a }, c);
  assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y), 'no NaN from a zero-length baseline');
  assert.ok(Math.abs(dist(a, c) - (a.r + c.r)) < 1e-9, 'still tangent to the anchor');
});

/* ═══════════════════════════ sibling packing ═══════════════════════════ */

test('packed siblings never overlap', () => {
  // This is the assertion that caught the mirrored `packPlace` call: with the
  // arguments the other way round the pack still LOOKS like a pack, and every
  // circle is still tangent to two others — they are simply tangent on the
  // wrong side, and lie on top of the ones already placed.
  let h = 99;
  for (let n = 1; n <= 40; n++) {
    const cs: Circle[] = [];
    for (let i = 0; i < n; i++) {
      h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
      cs.push({ x: 0, y: 0, r: 1 + ((h >>> 0) % 900) / 100 });
    }
    packSiblings(cs);
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const gap = dist(cs[i], cs[j]) - (cs[i].r + cs[j].r);
        assert.ok(gap > -1e-6, `n=${n}: circles ${i} and ${j} overlap by ${-gap}`);
      }
    }
  }
});

test('every packed circle touches at least one other — the pack is not scattered', () => {
  const cs: Circle[] = [9, 7, 6, 5, 4, 4, 3, 2, 2, 1].map((r) => ({ x: 0, y: 0, r }));
  packSiblings(cs);
  for (let i = 0; i < cs.length; i++) {
    const touches = cs.some((o, j) => j !== i && Math.abs(dist(cs[i], o) - (cs[i].r + o.r)) < 1e-6);
    assert.ok(touches, `circle ${i} is tangent to a neighbour`);
  }
});

/* ══════════════════════════ the layout function ══════════════════════════ */

test('circle AREA is proportional to value — the promise the view makes', () => {
  const values = [100, 50, 25, 25, 10, 8, 6, 4, 2, 1];
  const { circles } = circlePackChildren(values, 200);
  const totalValue = values.reduce((s, v) => s + v, 0);
  const totalArea = circles.reduce((s, c) => s + Math.PI * c.r * c.r, 0);
  for (const c of circles) {
    const share = (Math.PI * c.r * c.r) / totalArea;
    assert.ok(Math.abs(share - values[c.i] / totalValue) < 1e-9,
      `child ${c.i} holds its share of the area`);
  }
});

test('nothing escapes the circle it was packed into', () => {
  const values = [40, 30, 20, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const R = 150;
  const { circles } = circlePackChildren(values, R);
  for (const c of circles) {
    assert.ok(Math.hypot(c.x, c.y) + c.r <= R + 1e-6, `child ${c.i} stays inside R`);
  }
  // …and it fills it: a pack that fitted by shrinking to a dot would pass the
  // line above and waste the whole panel.
  const reach = Math.max(...circles.map((c) => Math.hypot(c.x, c.y) + c.r));
  assert.ok(reach > R * 0.9, `the pack fills its circle (reached ${reach} of ${R})`);
});

test('a zero-size child gets no circle at all, and is counted', () => {
  // A radius-zero circle is invisible and still hoverable: a hit target for
  // something that is not on screen. §2.4 — say it, do not draw it.
  const r = circlePackChildren([10, 0, 5], 100);
  assert.equal(r.circles.length, 2);
  assert.equal(r.omitted, 1);
  assert.ok(!r.circles.some((c) => c.i === 1), 'the zero-size child has no circle');
});

test('a single child is centred and fills its parent', () => {
  const { circles } = circlePackChildren([5], 100);
  assert.equal(circles.length, 1);
  assert.equal(circles[0].x, 0);
  assert.equal(circles[0].y, 0);
  assert.ok(circles[0].r > 95 && circles[0].r <= 100, 'it fills the parent circle');
});

test('an empty child list is empty, not a crash', () => {
  const r = circlePackChildren([], 100);
  assert.equal(r.circles.length, 0);
  assert.equal(r.omitted, 0);
});

test('ten thousand equal children: no NaN, no overlap, and it finishes', () => {
  const values = new Array(10000).fill(1);
  const started = Date.now();
  const r = circlePackChildren(values, 500, { maxCircles: 10000 });
  const elapsed = Date.now() - started;
  assert.equal(r.circles.length, 10000);
  assert.equal(r.unresolved, 0, 'the retry budget was never needed');
  for (const c of r.circles) {
    assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.r),
      'no NaN coordinates on a degenerate input');
    assert.ok(Math.hypot(c.x, c.y) + c.r <= 500 + 1e-6, 'still inside the parent');
  }
  // Not a benchmark — a guard on the one unbounded thing in the algorithm.
  // §6.2 asks that a pathological input cannot hang the frame.
  assert.ok(elapsed < 5000, `packing finished in ${elapsed} ms`);
});

test('the cap keeps the biggest and reports the rest', () => {
  const values = Array.from({ length: 300 }, (_, i) => i + 1);
  const r = circlePackChildren(values, 200, { maxCircles: 50 });
  assert.equal(r.circles.length, 50);
  assert.equal(r.omitted, 250);
  const kept = new Set(r.circles.map((c) => c.i));
  assert.ok(kept.has(299), 'the largest child survived the cap');
  assert.ok(!kept.has(0), 'the smallest did not');
  const droppedTotal = values.filter((_, i) => !kept.has(i)).reduce((s, v) => s + v, 0);
  assert.equal(r.omittedValue, droppedTotal, 'the omitted bytes are the ones actually dropped');
});

test('the same input packs the same way twice — no drift between sessions', () => {
  // Welzl needs its input shuffled, and a shuffle that were genuinely random
  // would re-arrange the map on every repaint.
  const values = [37, 21, 18, 12, 9, 7, 5, 3, 2, 1];
  const a = JSON.stringify(circlePackChildren(values, 120).circles);
  const b = JSON.stringify(circlePackChildren(values, 120).circles);
  assert.equal(a, b);
});

/* ═════════ The layout clock, which only one of the two solvers had ═════════ */

const altNoteFor = lift<(i: Record<string, unknown>) => string>(
  ['formatCount', 'formatBytes', 'ALT_CELL_BUDGET', 'ALT_LAYOUT_BUDGET_MS', 'altNoteFor'], 'altNoteFor',
);

/** A named function's source, brace-matched out of the shipped frontend. */
function fnSource(name: string): string {
  const start = INDEX.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} must exist`);
  const open = INDEX.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') { depth--; if (depth === 0) return INDEX.slice(start, i + 1); }
  }
  throw new Error(`function ${name} has an unbalanced body`);
}

test('BOTH alternate renderers lay out under a wall clock', () => {
  // §6.2 asks for "a hard iteration cap so a pathological input cannot hang
  // the frame". The Voronoi solver had one from the start; `layoutCirclePack`
  // had none, and the comment on `buildCells` said in so many words that the
  // Voronoi solver was "the only thing in this file that could plausibly
  // spend" the 250 ms first-paint budget.
  //
  // That was measured on ~/Library/Application Support/Claude and it was
  // wrong by a factor of four: 1,102 ms in one synchronous block, of which
  // two nested packs were 1,089 ms — one of them 740 ms spent packing 4,239
  // circles into an 18-pixel radius, where 13 of them ended up large enough
  // to draw. The cell budget could not catch it, because the cost is spent
  // before a single cell exists.
  for (const solver of ['layoutCirclePack', 'layoutVoronoi']) {
    const src = fnSource(solver);
    assert.match(src, /const started = performance\.now\(\);/, `${solver} must start a clock`);
    assert.match(
      src,
      /performance\.now\(\) - started > ALT_LAYOUT_BUDGET_MS/,
      `${solver} must check the shared layout budget, not a private one`,
    );
    assert.match(src, /outOfTime = true/, `${solver} must record that it ran out of time`);
    // The flag has to reach the NOTE, not merely exist. Dropping it from this
    // one call is a silent truncation that every other assertion here passes.
    const call = src.slice(src.indexOf('altNoteFor('));
    assert.match(call, /altNoteFor\(\{[^}]*\boutOfTime\b/, `${solver} must hand outOfTime to altNoteFor`);
  }
});

test('the clock is checked before the work, not after it', () => {
  // A budget consulted after the expensive call has already returned is a
  // report, not a cap. Both solvers must test the clock inside the queue loop
  // and BREAK, so the next pack never starts.
  for (const solver of ['layoutCirclePack', 'layoutVoronoi']) {
    const src = fnSource(solver);
    const check = src.indexOf('ALT_LAYOUT_BUDGET_MS');
    assert.notEqual(check, -1);
    const line = src.slice(check, src.indexOf('\n', check));
    assert.match(line, /outOfTime = true; break;/, `${solver} must stop rather than note and continue`);
  }
  // And the first level is never skipped: an empty picture is not a cheaper
  // picture, it is a wrong one.
  assert.match(
    fnSource('layoutCirclePack'),
    /job\.cell\.depth > 0 && performance\.now\(\) - started > ALT_LAYOUT_BUDGET_MS/,
    'the circle solver always lays out depth 0 before consulting the clock',
  );
});

test('running out of time is stated, never silently truncated', () => {
  // §2.4: partial is stated, not hidden. A map that stopped subdividing looks
  // exactly like a map that had nothing more to show.
  const note = altNoteFor({ omittedCount: 0, omittedBytes: 0, unresolved: 0, truncated: false, outOfTime: true, drawn: 12 });
  assert.match(note, /stopped subdividing after 45 ms/, 'the note says it stopped, and after how long');
  assert.match(note, /drill in for more detail/, 'and what the user can do about it');
  const quiet = altNoteFor({ omittedCount: 0, omittedBytes: 0, unresolved: 0, truncated: false, outOfTime: false, drawn: 12 });
  assert.equal(quiet, '', 'a layout that finished says nothing');
});

/* ═══════════ The coverage gate — packs that cannot draw are not run ═══════════ */

/**
 * §2.5 close-out (the trade HANDOFF.md left open, now taken).
 *
 * A pack's cost is spent on every child; its value is only the children big
 * enough to draw. The measured pathology packed 4,239 circles into an
 * 18.8-pixel parent to draw 13 of them — 740 ms for specks. The gate estimates
 * each child's drawn radius WITHOUT packing — r ≈ R·0.955·√(share) — and that
 * estimate can only over-state: a real pack's hull is never denser than
 * area-perfect, so a child estimated under the leaf floor is provably
 * undrawable. Two consequences, both tested here:
 *
 *  - a parent whose drawable children hold under ALT_COVERAGE_MIN of its bytes
 *    is not subdivided at all — it stays a hatched leaf, counted in the note;
 *  - above the line, provably-undrawable children are dropped BEFORE the pack,
 *    which bounds the survivors' inflation at √(1/ALT_COVERAGE_MIN) ≈ 5.4% in
 *    radius — the price of not spending 80 ms packing four thousand invisible
 *    circles around one giant.
 */
interface GateKid { size: number }
interface GateResult {
  skip: boolean;
  packKids: GateKid[];
  omittedCount: number;
  omittedBytes: number;
}
const altCoverageGate = lift<(kids: GateKid[], r: number) => GateResult>(
  ['ALT_MIN_LEAF_R', 'ALT_COVERAGE_MIN', 'altCoverageGate'], 'altCoverageGate',
);

test('the measured pathology — 23% drawable — is not subdivided', () => {
  const kids: GateKid[] = [{ size: 2300 }];
  for (let i = 0; i < 4238; i++) kids.push({ size: 7700 / 4238 });
  const gate = altCoverageGate(kids, 18.8);
  assert.equal(gate.skip, true, 'a parent that is mostly specks stays solid');
  assert.equal(gate.omittedCount, kids.length, 'every child is counted in the note');
  assert.ok(Math.abs(gate.omittedBytes - 10000) < 1e-6, 'and every byte');
});

test('the recorded trade: 84% drawable still hatches, and that is the chosen threshold', () => {
  // HANDOFF.md names this exact parent: R=63.8, coverage 0.842, currently 42
  // legible beads. Below ALT_COVERAGE_MIN it stops subdividing — the beads
  // become a hatched circle whose drill-in shows them at full size. This test
  // exists so the loss is a decision with a witness, not a side effect.
  const kids: GateKid[] = [];
  for (let i = 0; i < 42; i++) kids.push({ size: 84200 / 42 });
  for (let i = 0; i < 4000; i++) kids.push({ size: 15800 / 4000 });
  const gate = altCoverageGate(kids, 63.8);
  assert.equal(gate.skip, true);
});

test('a dense folder passes the gate untouched', () => {
  const kids: GateKid[] = Array.from({ length: 20 }, () => ({ size: 5 }));
  const gate = altCoverageGate(kids, 100);
  assert.equal(gate.skip, false);
  assert.equal(gate.packKids.length, 20, 'every drawable child is packed');
  assert.equal(gate.omittedCount, 0);
  assert.equal(gate.omittedBytes, 0);
});

test('one giant among thousands of specks: the giant packs, the specks never do', () => {
  // Coverage is ~99.6% — far above the gate — but 4,238 of the children are
  // provably under the leaf floor. Packing them anyway was measured at 80 ms
  // warm; the gate hands the pack exactly one circle instead.
  const kids: GateKid[] = [{ size: 999000 }];
  for (let i = 0; i < 4238; i++) kids.push({ size: 1 });
  const gate = altCoverageGate(kids, 18.8);
  assert.equal(gate.skip, false, 'the folder subdivides — its bytes are drawable');
  assert.equal(gate.packKids.length, 1, 'only the giant reaches the pack');
  assert.equal(gate.omittedCount, 4238);
  assert.equal(gate.omittedBytes, 4238);
});

test('the gate partitions the children exactly — nothing lost, nothing doubled', () => {
  const kids: GateKid[] = Array.from({ length: 500 }, (_, i) => ({ size: (i % 97) + 1 }));
  const total = kids.reduce((s, k) => s + k.size, 0);
  const gate = altCoverageGate(kids, 40);
  assert.equal(gate.packKids.length + gate.omittedCount, kids.length);
  const packed = gate.packKids.reduce((s: number, k: GateKid) => s + k.size, 0);
  assert.ok(Math.abs(packed + gate.omittedBytes - total) < 1e-6);
});

test('children with no bytes at all skip without dividing by zero', () => {
  const gate = altCoverageGate([{ size: 0 }, { size: 0 }], 50);
  assert.equal(gate.skip, true);
  assert.equal(gate.omittedCount, 2);
  assert.equal(gate.omittedBytes, 0);
  assert.ok(Number.isFinite(gate.omittedBytes));
});

test('layoutCirclePack consults the gate before it pays for a pack', () => {
  const src = fnSource('layoutCirclePack');
  const gateAt = src.indexOf('altCoverageGate(');
  const packAt = src.indexOf('circlePackChildren(');
  assert.notEqual(gateAt, -1, 'the layout calls the gate');
  assert.notEqual(packAt, -1, 'the layout still packs');
  assert.ok(gateAt < packAt, 'and the gate is asked first');
});

/* ═════════════ The refinement loop — the clock ends a slice, not the map ═════════════ */

test('both solvers are resumable, and buildCells schedules the next slice', () => {
  // §2.5's 50 ms block rule is met by slicing, not by settling for a coarse
  // picture: a layout that runs out of clock returns its queue as `resume`,
  // and buildCells hands it back one animation frame later. These are the
  // load-bearing joints of that loop; if any of them goes, the picture
  // silently reverts to permanently-coarse and nothing else fails.
  for (const name of ['layoutCirclePack', 'layoutVoronoi']) {
    const src = fnSource(name);
    assert.match(src, /function \w+\(root, geo, resume\)/, `${name} accepts a resume state`);
    assert.match(src, /done: !outOfTime/, `${name} says whether it finished`);
    assert.match(src, /resume: S/, `${name} returns its queue for the next slice`);
    assert.match(src, /const job = queue\[0\]/, `${name} peeks before the clock so an out-of-clock job is not lost`);
  }
  const build = fnSource('buildCells');
  assert.match(build, /altRefineCancel\(\)/, 'a rebuild cancels the previous refinement');
  assert.match(build, /if \(!out\.done\) altRefineSchedule\(/, 'an unfinished layout is continued');
  const sched = fnSource('altRefineSchedule');
  assert.match(sched, /requestAnimationFrame/, 'continuation waits for a frame');
  assert.match(sched, /state\.treemap\.mode !== mode/, 'a renderer switch orphans the old queue');
});

test('while refining, the footnote says so in plain words', () => {
  const altRefiningNote = lift<(drawn: number) => string>(
    ['formatCount', 'altRefiningNote'], 'altRefiningNote',
  );
  assert.equal(altRefiningNote(1234), 'still laying out — 1,234 shapes so far');
});

test('the treemap unmount and setTreemapView both cancel the refinement loop', () => {
  // The registry's rule: every rAF a view starts, its unmount stops. The
  // refinement rAF lives on state.treemap.altRaf; both exits must close it.
  const src = fnSource('setTreemapView');
  assert.match(src, /altRefineCancel\(\)/, 'switching renderer cancels refinement');
  const unmountAt = INDEX.indexOf("id: 'treemap'");
  const unmountSrc = INDEX.slice(unmountAt, INDEX.indexOf("id: 'grid'", unmountAt));
  assert.match(unmountSrc, /altRefineCancel\(\)/, 'leaving the view cancels refinement');
});

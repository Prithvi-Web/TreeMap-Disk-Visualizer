import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lift } from './fixtures/liftFrontend';

/**
 * Time-lapse interpolation (v4 §7.1).
 *
 * Playback morphs one snapshot's rectangle layout into the next. The rules
 * under test are the honesty rules applied to motion: a rectangle present in
 * both layouts travels linearly between them; one that only exists in the
 * destination blooms out of its own centre (the same convention
 * `animateTreemapTo` established); one that only exists in the source shrinks
 * into its own centre and is GONE at t=1 — nothing is drawn for a file that
 * no longer exists. And `lapseOrderedSnaps` never invents a tree: a snapshot
 * without one is filtered out, leaving a gap, not a guess.
 *
 * Both functions live in `public/index.html` as named pure functions (the
 * frontend has no build step; see liftFrontend.ts) and are lifted whole, so
 * what runs here is the code that ships.
 */

interface LapseNode {
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  [key: string]: unknown;
}

const lapseLerpNodes = lift<(a: LapseNode[], b: LapseNode[], t: number) => LapseNode[]>(
  ['lapseLerpNodes'],
  'lapseLerpNodes',
);

interface Snap {
  id: string;
  takenAt: number;
  hasTree: boolean;
  [key: string]: unknown;
}

const lapseOrderedSnaps = lift<(snaps: Snap[]) => Snap[]>(
  ['lapseOrderedSnaps'],
  'lapseOrderedSnaps',
);

const N = (path: string, x: number, y: number, w: number, h: number, size: number, extra: Record<string, unknown> = {}): LapseNode =>
  ({ path, x, y, w, h, size, ...extra });

const geom = (n: LapseNode) => ({ x: n.x, y: n.y, w: n.w, h: n.h, size: n.size });

test('a node present in both layouts sits exactly at the endpoints', () => {
  const a = [N('/r/a', 0, 0, 100, 50, 1000)];
  const b = [N('/r/a', 40, 20, 60, 30, 400)];
  assert.deepEqual(geom(lapseLerpNodes(a, b, 0)[0]), geom(a[0]));
  assert.deepEqual(geom(lapseLerpNodes(a, b, 1)[0]), geom(b[0]));
});

test('matched geometry and size move monotonically toward the target', () => {
  const a = [N('/r/a', 0, 10, 100, 80, 1000)];
  const b = [N('/r/a', 50, 0, 20, 40, 200)];
  let prevDist = Infinity;
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const [n] = lapseLerpNodes(a, b, t);
    const dist =
      Math.abs(n.x - b[0].x) + Math.abs(n.y - b[0].y) +
      Math.abs(n.w - b[0].w) + Math.abs(n.h - b[0].h) +
      Math.abs(n.size - b[0].size);
    assert.ok(dist <= prevDist, `distance to target never grows (t=${t}: ${dist} > ${prevDist})`);
    prevDist = dist;
  }
  assert.equal(prevDist, 0, 'arrives exactly at the target');
});

test('t is clamped to [0, 1]', () => {
  const a = [N('/r/a', 0, 0, 100, 50, 1000)];
  const b = [N('/r/a', 40, 20, 60, 30, 400)];
  assert.deepEqual(lapseLerpNodes(a, b, -3), lapseLerpNodes(a, b, 0));
  assert.deepEqual(lapseLerpNodes(a, b, 7), lapseLerpNodes(a, b, 1));
});

test('an arrival blooms from its own centre — animateTreemapTo\'s convention', () => {
  const arriving = N('/r/new', 10, 20, 40, 60, 500);
  const cx = 10 + 40 / 2, cy = 20 + 60 / 2;
  const at0 = lapseLerpNodes([], [arriving], 0)[0];
  assert.deepEqual({ x: at0.x, y: at0.y, w: at0.w, h: at0.h }, { x: cx, y: cy, w: 0, h: 0 });
  const atHalf = lapseLerpNodes([], [arriving], 0.5)[0];
  assert.deepEqual({ x: atHalf.x, y: atHalf.y, w: atHalf.w, h: atHalf.h }, { x: (cx + 10) / 2, y: (cy + 20) / 2, w: 20, h: 30 });
  assert.deepEqual(geom(lapseLerpNodes([], [arriving], 1)[0]), geom(arriving));
});

test('a departure shrinks into its own centre and is gone at t=1', () => {
  const leaving = N('/r/old', 10, 20, 40, 60, 500);
  const cx = 10 + 40 / 2, cy = 20 + 60 / 2;
  assert.deepEqual(geom(lapseLerpNodes([leaving], [], 0)[0]), geom(leaving));
  const mid = lapseLerpNodes([leaving], [], 0.5)[0];
  assert.deepEqual({ x: mid.x, y: mid.y, w: mid.w, h: mid.h }, { x: (10 + cx) / 2, y: (20 + cy) / 2, w: 20, h: 30 });
  assert.equal(lapseLerpNodes([leaving], [], 1).length, 0, 'nothing is drawn for a file that no longer exists');
});

test('matched nodes carry the destination\'s non-geometry fields', () => {
  // Colour, depth and name must describe where playback is going, not a blend
  // — only geometry and size are continuous quantities.
  const a = [N('/r/a', 0, 0, 10, 10, 100, { name: 'old', depth: 1 })];
  const b = [N('/r/a', 5, 5, 20, 20, 200, { name: 'new', depth: 2 })];
  const mid = lapseLerpNodes(a, b, 0.5)[0];
  assert.equal(mid.name, 'new');
  assert.equal(mid.depth, 2);
});

test('output order is the destination\'s, departures appended last', () => {
  // Draw order is z-order on the canvas: survivors and arrivals paint in the
  // destination layout's order, and shrinking departures paint on top so they
  // stay visible while they go.
  const a = [N('/r/gone', 0, 0, 10, 10, 1), N('/r/x', 0, 0, 10, 10, 1)];
  const b = [N('/r/y', 0, 0, 10, 10, 1), N('/r/x', 5, 5, 10, 10, 1)];
  const mid = lapseLerpNodes(a, b, 0.5);
  assert.deepEqual(mid.map((n) => n.path), ['/r/y', '/r/x', '/r/gone']);
});

test('empty layouts interpolate to an empty frame', () => {
  assert.deepEqual(lapseLerpNodes([], [], 0.5), []);
});

test('lapseOrderedSnaps sorts by takenAt and never mutates its input', () => {
  const snaps: Snap[] = [
    { id: 'c', takenAt: 300, hasTree: true },
    { id: 'a', takenAt: 100, hasTree: true },
    { id: 'b', takenAt: 200, hasTree: true },
  ];
  const copy = snaps.map((s) => ({ ...s }));
  assert.deepEqual(lapseOrderedSnaps(snaps).map((s) => s.id), ['a', 'b', 'c']);
  assert.deepEqual(snaps, copy, 'the caller\'s array is untouched');
});

/* ── §7.1c — the export sampler ── */

const lapseSampleTimes = lift<(snapCount: number, fps: number, cap: number) => { times: number[]; capped: boolean }>(
  ['lapseSampleTimes'],
  'lapseSampleTimes',
);

test('the sampler covers every segment at the asked rate, ends exactly on the last snapshot', () => {
  const { times, capped } = lapseSampleTimes(3, 10, 150);
  assert.equal(capped, false);
  assert.equal(times.length, 21); // 2 segments × 10 fps + the final frame
  assert.equal(times[0], 0);
  assert.equal(times[times.length - 1], 2);
  for (let i = 1; i < times.length; i++) {
    assert.ok(Math.abs(times[i] - times[i - 1] - 0.1) < 1e-9, 'uniform 1/fps steps');
  }
});

test('the cap thins the samples but never the span — and says so', () => {
  const { times, capped } = lapseSampleTimes(31, 10, 150); // natural 301 frames
  assert.equal(capped, true);
  assert.equal(times.length, 150);
  assert.equal(times[0], 0);
  assert.equal(times[times.length - 1], 30, 'the last snapshot is still the last frame');
  for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1], 'strictly increasing');
});

test('fewer than two snapshots yields no samples', () => {
  assert.deepEqual(lapseSampleTimes(1, 10, 150), { times: [], capped: false });
  assert.deepEqual(lapseSampleTimes(0, 10, 150), { times: [], capped: false });
});

test('a treeless snapshot is a gap, never a guess', () => {
  const snaps: Snap[] = [
    { id: 'a', takenAt: 100, hasTree: true },
    { id: 'hole', takenAt: 200, hasTree: false },
    { id: 'c', takenAt: 300, hasTree: true },
  ];
  const ordered = lapseOrderedSnaps(snaps);
  assert.deepEqual(ordered.map((s) => s.id), ['a', 'c'],
    'playback interpolates a→c directly; nothing is synthesised for the hole');
});

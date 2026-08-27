import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lift, INDEX } from './fixtures/liftFrontend';

/**
 * Lasso containment (v4 §6.3).
 *
 * §6.3 names the case that matters — "point-in-polygon including
 * self-intersecting freehand paths" — and a freehand loop crosses itself
 * constantly, because a hand drawing a circle on a trackpad overshoots.
 *
 * The rule is **non-zero winding**, not even-odd, and that is a decision with
 * a visible consequence rather than a coin toss: the lasso is drawn filled
 * while it is being dragged, `ctx.fill()` defaults to non-zero, and under
 * even-odd a scribble that crossed itself would show one shape and select
 * another. The pentagram test below is the one that tells the two apart — its
 * middle is inside under winding and outside under even-odd — so if the rule
 * ever silently changes, that test says so.
 */

interface Pt { x: number; y: number }

const lassoContains = lift<(pts: Pt[], x: number, y: number) => boolean>(
  ['lassoContains'], 'lassoContains',
);
const lassoBounds = lift<(pts: Pt[]) => { x0: number; y0: number; x1: number; y1: number }>(
  ['lassoBounds'], 'lassoBounds',
);
const lassoRectPath = lift<(a: Pt, b: Pt) => Pt[]>(['lassoRectPath'], 'lassoRectPath');
const lassoPush = lift<(pts: Pt[], x: number, y: number) => void>(['lassoPush'], 'lassoPush');

const SQUARE: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

/* ═══════════════════════════ the ordinary cases ═══════════════════════════ */

test('a square contains its middle and excludes everything outside it', () => {
  assert.equal(lassoContains(SQUARE, 5, 5), true);
  assert.equal(lassoContains(SQUARE, -1, 5), false);
  assert.equal(lassoContains(SQUARE, 11, 5), false);
  assert.equal(lassoContains(SQUARE, 5, -1), false);
  assert.equal(lassoContains(SQUARE, 5, 11), false);
});

test('winding does not depend on which way round the loop was drawn', () => {
  // A user dragging up-and-left traces the same shape backwards, and a rule
  // that only worked one way round would select nothing half the time.
  const reversed = [...SQUARE].reverse();
  for (const [x, y] of [[5, 5], [1, 9], [9, 1]]) {
    assert.equal(lassoContains(reversed, x, y), lassoContains(SQUARE, x, y), `(${x},${y})`);
  }
});

test('a concave loop does not catch what sits in its bay', () => {
  // A C-shape. The point in the opening is surrounded on three sides and is
  // still outside — which is the whole reason a lasso beats a bounding box.
  const c: Pt[] = [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 3 }, { x: 3, y: 3 },
    { x: 3, y: 7 }, { x: 10, y: 7 }, { x: 10, y: 10 }, { x: 0, y: 10 },
  ];
  assert.equal(lassoContains(c, 1, 5), true, 'the spine of the C is inside');
  assert.equal(lassoContains(c, 7, 5), false, 'the bay is not');
});

/* ══════════════════ self-intersection: the named requirement ══════════════════ */

test('a pentagram’s middle is INSIDE — the winding rule, pinned', () => {
  // Five points taken in star order, so the path crosses itself five times.
  // The inner pentagon is wound twice, so it is inside under non-zero and
  // outside under even-odd. This test exists to fail if the rule changes.
  const star: Pt[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (-Math.PI / 2) + (i * 4 * Math.PI * 2) / 10;
    star.push({ x: 50 + 40 * Math.cos(a), y: 50 + 40 * Math.sin(a) });
  }
  assert.equal(lassoContains(star, 50, 50), true, 'the middle of the star is selected');
  assert.equal(lassoContains(star, 50, 2), false, 'and a point beyond the tips is not');
});

test('a scribble that doubles back keeps everything it went around', () => {
  // The realistic freehand failure: a loop that overshoots and re-enters. Both
  // lobes are enclosed, and under even-odd the overlap would be punched out.
  const eight: Pt[] = [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    { x: 0, y: 0 }, { x: 4, y: 4 }, { x: 6, y: 4 }, { x: 6, y: 6 }, { x: 4, y: 6 },
  ];
  assert.equal(lassoContains(eight, 5, 5), true, 'the doubly-wound middle stays caught');
  assert.equal(lassoContains(eight, 1, 9), true, 'and so does the rest of the loop');
});

test('a degenerate path catches nothing rather than throwing', () => {
  // A click with no drag, a two-point path, and an empty one all reach here
  // before `lassoEnd` decides the gesture was not a lasso.
  for (const pts of [[], [{ x: 3, y: 3 }], [{ x: 3, y: 3 }, { x: 9, y: 9 }],
    [{ x: 4, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 4 }]] as Pt[][]) {
    assert.equal(lassoContains(pts, 4, 4), false);
    assert.equal(lassoContains(pts, 100, 100), false);
  }
});

/* ═══════════════════════════ the supporting parts ═══════════════════════════ */

test('bounds are the box a candidate can be rejected on', () => {
  assert.deepEqual(lassoBounds(SQUARE), { x0: 0, y0: 0, x1: 10, y1: 10 });
  assert.deepEqual(lassoBounds([]), { x0: 0, y0: 0, x1: 0, y1: 0 });
  // The bounds must never be tighter than the path, or the cheap rejection in
  // `lassoCaught` would drop things the loop really encloses.
  const scribble = [{ x: 5, y: -3 }, { x: -2, y: 8 }, { x: 12, y: 4 }];
  const b = lassoBounds(scribble);
  for (const p of scribble) {
    assert.ok(p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1);
  }
});

test('a rubber band is a path, so there is one containment rule and not two', () => {
  // Dragged in any of the four directions it must describe the same region:
  // the rectangle is fed through exactly the same winding test the freehand
  // loop is, which is what stops the two modes disagreeing about an edge.
  const corners: [Pt, Pt][] = [
    [{ x: 2, y: 2 }, { x: 8, y: 6 }],
    [{ x: 8, y: 6 }, { x: 2, y: 2 }],
    [{ x: 8, y: 2 }, { x: 2, y: 6 }],
    [{ x: 2, y: 6 }, { x: 8, y: 2 }],
  ];
  for (const [a, b] of corners) {
    const path = lassoRectPath(a, b);
    assert.equal(lassoContains(path, 5, 4), true, 'the middle is caught either way round');
    assert.equal(lassoContains(path, 5, 9), false);
    assert.equal(lassoContains(path, 0, 4), false);
  }
});

test('a freehand path drops points the pointer did not really move to', () => {
  // A stationary pointer still emits move events. Four hundred coincident
  // vertices make both the winding test and the stroke measurably slower for
  // no shape at all.
  const pts: Pt[] = [];
  lassoPush(pts, 10, 10);
  for (let i = 0; i < 50; i++) lassoPush(pts, 10.4, 10.4); // jitter under the threshold
  assert.equal(pts.length, 1);
  lassoPush(pts, 40, 10);
  assert.equal(pts.length, 2);
});

/* ══════════════════════ what the lasso is allowed to stage ══════════════════════ */

test('the lasso can never empty the cart, and never deletes', () => {
  // Two structural guarantees, asserted against the source because they are
  // properties of what is NOT there. §6.3 reads as though a plain lasso should
  // replace the selection — and replace is the one behaviour that could throw
  // away staging done in four other views without saying so.
  const start = INDEX.indexOf('function lassoApply(');
  assert.notEqual(start, -1);
  const body = INDEX.slice(start, INDEX.indexOf('\n}', start));
  assert.ok(!/state\.cart\.clear\(\)/.test(body), 'no code path clears the cart');
  assert.ok(!/trash|delete\s*\(/i.test(body.replace(/state\.cart\.delete/g, '')),
    'nothing here deletes anything from disk');
  assert.ok(/saveCart\(\)/.test(body), 'and what it does change, it persists');
});

test('everything the lasso can catch is something the cart can hold', () => {
  // §4.3's freed blocks are a hypothetical, archive entries are a listing that
  // the server refuses with VIRTUAL_PATH, and the Trash cell is synthetic.
  // Excluded at the source, so the count in the badge is the count that stages.
  const start = INDEX.indexOf('function lassoTargets(');
  const body = INDEX.slice(start, INDEX.indexOf('\n}\n', start));
  for (const guard of ['n.path', '!n.freed', '!n.virtual', '!n.isTrash']) {
    assert.ok(body.includes(guard), `lassoTargets excludes on ${guard}`);
  }
});

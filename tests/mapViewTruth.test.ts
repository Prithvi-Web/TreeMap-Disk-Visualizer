import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The map view says what it is doing — QA of 5 Oct 2026 (batch QA-6).
 *
 * Every pin here RUNS the shipped code: the functions are cut out of the built
 * `public/index.html` by brace matching and evaluated with each global they
 * touch passed in, which is what makes them stubbable at all (the
 * gridAnchorStale / treemapFooterPlural harness precedent). The invariants are
 * about what a person sees and what a click does, so they are asserted as
 * behaviour rather than as source shapes a rewrite would legitimately change.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** `function name(…) {…}` or `const name = {…};`, cut by brace matching. */
function declSource(name: string): string {
  let start = INDEX.indexOf(`function ${name}(`);
  if (start > 0 && INDEX.slice(start - 6, start) === 'async ') start -= 6;
  if (start === -1) start = INDEX.indexOf(`const ${name} = {`);
  assert.notEqual(start, -1, `${name} is declared in the built page`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', INDEX.indexOf(name, start) + name.length); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1) + ';';
  }
  return assert.fail(`${name} never closes`);
}

/**
 * Evaluate the named declarations in one scope, with `deps` as the globals.
 * `prelude` declares module-level `let`s the functions assign to.
 */
function load<T>(names: string[], deps: Record<string, unknown>, returns: string, prelude = ''): T {
  const keys = Object.keys(deps);
  const src = `'use strict'; ${prelude}\n${names.map(declSource).join('\n')}\nreturn ${returns};`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...keys, src)(...keys.map((k) => deps[k])) as T;
}

const fmtCount = (n: number) => n.toLocaleString('en-US');

/* ══════════════ D28 — Reclaim colour mode: scores follow every load ══════════════ */

type Calls = Record<string, number>;

/**
 * Drive the real `loadTreemap` (and the real `drawView`) for one renderer with
 * the Reclaim colour mode on, and count what was drawn and what was asked for.
 */
async function loadInMode(mode: string, colorMode = 'reclaim'): Promise<Calls> {
  const calls: Calls = { drawTreemap: 0, drawSunburst: 0, drawCells: 0, fetchScoresForTreemap: 0 };
  const count = (k: string) => () => { calls[k]++; };
  const el = () => ({ classList: { add() {}, remove() {} }, disabled: false, innerHTML: '' });
  const els: Record<string, ReturnType<typeof el>> = {};
  const state = {
    scanId: 's1',
    root: { path: '/r', name: 'r', size: 100 },
    pathIndex: new Map(),
    treemap: {
      mode, colorMode, rootPath: '/r', maxDepth: 4, nodes: [], hover: null, kbSel: null,
      history: { scrubbing: false, active: false },
    },
  };
  const deps = {
    state,
    $: (id: string) => (els[id] ||= el()),
    REDUCED: true,
    isSun: () => state.treemap.mode === 'sunburst',
    isCells: () => state.treemap.mode === 'circles' || state.treemap.mode === 'voronoi',
    exitCartPreview() {},
    ensureSubtree: async (p: string) => ({ path: p, name: 'a', size: 60 }),
    api: async () => ({ root: { path: '/r/a', name: 'a', size: 60 }, nodes: [{ path: '/r/a/x', size: 60 }] }),
    renderCrumbs() {},
    exitHistoryState() {},
    refreshTimebar() {},
    tmSetEmpty() {},
    maybeInjectTrash() {},
    altBeginZoom() {},
    altCircleFor: () => null,
    toast: (m: string) => { throw new Error('loadTreemap reported a failure: ' + m); },
    requestAnimationFrame: (f: () => void) => f(),
    drawTreemap: count('drawTreemap'),
    drawSunburst: count('drawSunburst'),
    drawCells: count('drawCells'),
    fetchScoresForTreemap: count('fetchScoresForTreemap'),
  };
  const loadTreemap = load<(p: string, animate?: boolean) => Promise<void>>(
    ['loadTreemap', 'drawView'], deps, 'loadTreemap', 'let tmLoadSeq = 0;');
  await loadTreemap('/r/a', true);
  return calls;
}

test('D28: a drill-in, an Up, a crumb or a renderer switch asks for the Reclaim scores of what it drew', async () => {
  // Every one of those goes through loadTreemap. It used to draw with the
  // renderer's own draw function, which never asks for scores, so switching
  // Voronoi → Treemap kept Voronoi's 210 scores and painted the rest grey.
  const expectDraw: Record<string, string> = {
    treemap: 'drawTreemap', sunburst: 'drawSunburst', circles: 'drawCells', voronoi: 'drawCells',
  };
  for (const [mode, drawFn] of Object.entries(expectDraw)) {
    const calls = await loadInMode(mode);
    assert.equal(calls[drawFn], 1, `${mode}: the map is drawn once`);
    assert.equal(calls.fetchScoresForTreemap, 1,
      `${mode}: the cells it just drew are scored — a load must not keep the previous layout's scores`);
  }
});

test('D28: with Size or Age colouring a load asks for no scores at all', async () => {
  for (const colorMode of ['size', 'age']) {
    const calls = await loadInMode('treemap', colorMode);
    assert.equal(calls.drawTreemap, 1);
    assert.equal(calls.fetchScoresForTreemap, 0, `${colorMode}: nothing is fetched that nothing will paint`);
  }
});

/** The coverage sentence for `drawn` cells of which the first `scored` are scored and the next `pending` are in flight. */
function coverage(drawn: number, scored: number, pending: number, unscorable = 0): string {
  const cells = Array.from({ length: drawn }, (_, i) => ({ n: { path: `/r/f${i}` } }));
  const scores = new Map<string, unknown>();
  const inFlight = new Set<string>();
  cells.forEach((c, i) => {
    if (i < scored) scores.set(c.n.path, { score: 50 });
    else if (i < scored + unscorable) scores.set(c.n.path, null);
    else if (i < scored + unscorable + pending) inFlight.add(c.n.path);
  });
  const note = load<() => string>(['reclaimCoverageNote'], {
    drawnCells: () => cells,
    reclaim: { scores, pending: inFlight },
    formatCount: fmtCount,
    TM_SCORE_CAP: 6000,
  }, 'reclaimCoverageNote');
  return note();
}

test('D28: "TreeMap stops at 6,000" is said only when the asking actually reached 6,000', () => {
  // The QA screen: Voronoi's 210 scores carried over, nothing else asked.
  // "Scored 210 of 9,432 — TreeMap stops at 6,000 at a time" contradicts itself.
  const carried = coverage(9432, 210, 0);
  assert.match(carried, /Scored 210 of 9,432 on screen/);
  assert.doesNotMatch(carried, /stops at/, 'nothing reached the cap, so the cap is not the reason');
  // The fetch that follows the draw is in flight: say so, with the count.
  const loading = coverage(9432, 210, 5790);
  assert.match(loading, /Scored 210 of 9,432 on screen; 5,790 more are loading/);
  assert.match(loading, /stops at 6,000 at a time; drill in to score the rest/,
    '210 + 5,790 is the cap, so this time the cap IS why 3,432 cells will stay grey');
  // Landed at the cap.
  assert.match(coverage(9432, 6000, 0), /Scored 6,000 of 9,432 on screen — TreeMap stops at 6,000/);
  // Under the cap and loading: no cap clause.
  const small = coverage(4000, 1000, 3000);
  assert.match(small, /3,000 more are loading\.$/);
  assert.doesNotMatch(small, /stops at/);
  assert.match(coverage(4000, 1000, 1), /1 more is loading\./, 'the verb follows its own number');
  // Unchanged: fully scored says nothing; unscorable cells are named.
  assert.equal(coverage(4000, 4000, 0), '');
  assert.match(coverage(4000, 3990, 0, 10), /10 of 4,000 could not be scored/);
});

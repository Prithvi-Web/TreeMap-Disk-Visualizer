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

/** `function name(…) {…}`, `const name = {…};` (cut by brace matching) or `const NAME = value;`. */
function declSource(name: string): string {
  let start = INDEX.indexOf(`function ${name}(`);
  if (start > 0 && INDEX.slice(start - 6, start) === 'async ') start -= 6;
  if (start === -1) start = INDEX.indexOf(`const ${name} = {`);
  if (start === -1) {
    // A one-statement value: `const NAME = value;` or `let NAME = value;`, up to its semicolon.
    let at = INDEX.indexOf(`const ${name} = `);
    if (at === -1) at = INDEX.indexOf(`let ${name} = `);
    assert.notEqual(at, -1, `${name} is declared in the built page`);
    return INDEX.slice(at, INDEX.indexOf(';', at) + 1);
  }
  assert.notEqual(start, -1, `${name} is declared in the built page`);
  let from = INDEX.indexOf(name, start) + name.length;
  if (INDEX[from] === '(') {
    // Past the parameter list first: a destructured parameter is a brace, and
    // `function ctxMenuShow(menu, { label, … })` would otherwise close on it.
    for (let paren = 0; from < INDEX.length; from++) {
      if (INDEX[from] === '(') paren++;
      else if (INDEX[from] === ')' && --paren === 0) break;
    }
  }
  let depth = 0;
  for (let i = INDEX.indexOf('{', from); i < INDEX.length; i++) {
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
    ['treeScanId', 'loadTreemap', 'drawView', 'TM_MIN_SIZE'], deps, 'loadTreemap', 'let tmLoadSeq = 0;');
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

/* ══════════════ J06 — a Stop puts the older folder's map back at once ══════════════ */

/**
 * The real `loadTreemap` and `drawView` over a server whose map answers wait until the test lets each one land:
 * `answer()` lands the oldest still out. `draws` holds each map drawn — the folder it names, the scan its nodes came
 * from (null: laid out here from a tree with no scan behind it) and how many rectangles — and `shapes` each one's
 * rectangles, as `name@x+w`. With `home`, Mail is the home folder and the Trash holds 100 bytes, and the page's own
 * maybeInjectTrash adds the Trash cell to Mail's map, as on a home folder's scan. A map is asked of a folder by
 * `root=`, of whichever scan stands behind the tree on screen: Mail's two files, or one file in any other folder —
 * with `answerRoot`, under the folder's own spelling of the one asked, as a scan answers for a link (/tmp answered as
 * /private/tmp; review F2.3).
 */
function stopHarness(opts: { home?: boolean; answerRoot?: (asked: string) => string } = {}) {
  const MAIL = '/Users/x/Mail', CORPUS = '/Users/x/corpus';
  const file = (p: string, size: number) => ({ name: p.slice(p.lastIndexOf('/') + 1), path: p, size, type: 'file', extension: 'emlx' });
  const mailTree = { name: 'Mail', path: MAIL, size: 300, type: 'dir', children: [file(`${MAIL}/a.emlx`, 200), file(`${MAIL}/b.emlx`, 100)] };
  const corpusTree = { name: 'corpus', path: CORPUS, size: 9000, type: 'dir', children: [file(`${CORPUS}/v.mov`, 9000)] };
  const mailMap = { root: { name: 'Mail', path: MAIL, size: 300 }, nodes: [
    { name: 'a.emlx', path: `${MAIL}/a.emlx`, size: 200, type: 'file', depth: 1, expanded: false, x: 0, y: 0, w: 66.7, h: 100 },
    { name: 'b.emlx', path: `${MAIL}/b.emlx`, size: 100, type: 'file', depth: 1, expanded: false, x: 66.7, y: 0, w: 33.3, h: 100 },
  ] };
  const el = () => ({ classList: { add() {}, remove() {} }, disabled: false, innerHTML: '' });
  const els: Record<string, ReturnType<typeof el>> = {};
  const state: Record<string, any> = {
    scanning: false, scanId: 'scan-mail', settledScanId: 'scan-mail', root: mailTree, pathIndex: new Map(),
    treemap: { mode: 'treemap', colorMode: 'size', rootPath: MAIL, maxDepth: 4, nodes: [], nodesFor: null, hover: null, kbSel: null, history: { scrubbing: false, active: false } },
    ...(opts.home ? { system: { homeDir: MAIL }, trash: { totalBytes: 100 } } : {}),
  };
  const out: Array<{ url: string; land: () => void }> = [];
  const draws: Array<{ rootPath: string; scanId: unknown; nodes: number }> = [];
  const shapes: string[][] = [];
  const asked = (root: string) => (root === MAIL ? mailMap : { root: { name: root.slice(root.lastIndexOf('/') + 1), path: root, size: 50 }, nodes: [
    { name: 'c.emlx', path: `${root}/c.emlx`, size: 50, type: 'file', depth: 1, expanded: false, x: 0, y: 0, w: 100, h: 100 },
  ] });
  const mapOf = (root: string) => { const m = asked(root); return opts.answerRoot ? { ...m, root: { ...m.root, path: opts.answerRoot(root) } } : m; };
  const deps = {
    state, $: (id: string) => (els[id] ||= el()), REDUCED: true,
    isSun: () => false, isCells: () => false, exitCartPreview() {}, renderCrumbs() {}, exitHistoryState() {}, refreshTimebar() {},
    tmSetEmpty() {}, ...(opts.home ? {} : { maybeInjectTrash() {} }), altBeginZoom() {}, altCircleFor: () => null, requestAnimationFrame: (f: () => void) => f(),
    toast: (m: string) => { throw new Error('loadTreemap reported a failure: ' + m); },
    reportError: (e: Error) => { throw e; },
    // The saved index's tree is whole here: nothing was withheld for the index to answer for.
    ensureSubtree: async (p: string) => (state.root && state.root.path === p ? state.root : null),
    api: (url: string) => new Promise((resolve) => {
      const scan = /^\/api\/scan\/([^/?]+)\/treemap\?/.exec(url), behind = state.scanning ? state.settledScanId : state.scanId;
      assert.ok(scan && scan[1] === behind, `a map is asked of the scan behind the tree on screen, ${behind}: ${url}`);
      const root = decodeURIComponent(/[?&]root=([^&]*)/.exec(url)![1]);
      out.push({ url, land: () => resolve(JSON.parse(JSON.stringify(mapOf(root)))) });
    }),
    drawTreemap: () => {
      draws.push({ rootPath: state.treemap.rootPath, scanId: state.treemap.nodesFor ? state.treemap.nodesFor.scanId : undefined, nodes: state.treemap.nodes.length });
      shapes.push(state.treemap.nodes.map((n: any) => `${n.name}@${n.x.toFixed(2)}+${n.w.toFixed(2)}`));
    },
    drawSunburst() {}, drawCells() {}, fetchScoresForTreemap() {},
  };
  const loadTreemap = load<(p: string, animate?: boolean) => Promise<void>>(
    ['treeScanId', 'loadTreemap', 'drawView', 'TM_MIN_SIZE', 'TM_SERVER_NODE_CAP', 'tmHeldTreemap', 'tmLayoutTree', 'tmSquarify', 'tmWorstRatio',
      ...(opts.home ? ['maybeInjectTrash'] : [])],
    deps, 'loadTreemap', 'let tmLoadSeq = 0;');
  const answer = async () => { out.shift()!.land(); for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  /** Mail's scan on screen and Mail's map drawn from it; then a rescan of corpus painting corpus's saved index over it (J05); then a Stop putting Mail's tree and scan back (putBackHeldTree), as the view has them when it asks for Mail's map again. */
  const mailThenCorpusThenStop = async () => {
    Object.assign(state, { scanning: false, scanId: 'scan-mail', settledScanId: 'scan-mail', root: mailTree });
    state.treemap.rootPath = MAIL;
    const mail = loadTreemap(MAIL);
    await answer();
    await mail;
    Object.assign(state, { scanning: true, scanId: null, settledScanId: null, root: corpusTree });
    state.treemap.rootPath = CORPUS;
    await loadTreemap(CORPUS);
    Object.assign(state, { scanning: false, scanId: 'scan-mail', settledScanId: 'scan-mail', root: mailTree });
    state.treemap.rootPath = MAIL;
  };
  return { MAIL, CORPUS, mailTree, corpusTree, state, out, draws, shapes, loadTreemap, answer, mailThenCorpusThenStop };
}

test('J06: a Stop that puts the older folder back paints its map at once, in the same turn as the load — never the stopped folder\'s drawing under it until the older scan\'s map answers — and still asks the scan for it', async () => {
  // Ninth browser pass, item 19: 70–130 ms after a Stop the map still showed the stopped folder's drawing (corpus, from
  // its saved index) before the older folder (Mail) repainted, because its map is asked of its scan again and drawn
  // only when that answers. The older folder's map was on screen a moment before; it is drawn again at once.
  const h = stopHarness();
  // Mail's scan is on screen: its map is asked of its scan and drawn when that answers.
  const first = h.loadTreemap(h.MAIL);
  assert.equal(h.out.length, 1, 'control: Mail\'s map is asked of its scan');
  assert.equal(h.draws.length, 0, 'control: and nothing is drawn before it answers');
  await h.answer();
  await first;
  assert.deepEqual(h.draws.at(-1), { rootPath: h.MAIL, scanId: 'scan-mail', nodes: 2 }, 'control: Mail\'s map is drawn from its scan');
  // A rescan of corpus paints corpus's saved index over it, with no scan behind it yet (J05).
  Object.assign(h.state, { scanning: true, scanId: null, settledScanId: null, root: h.corpusTree });
  h.state.treemap.rootPath = h.CORPUS;
  await h.loadTreemap(h.CORPUS);
  assert.deepEqual(h.draws.at(-1), { rootPath: h.CORPUS, scanId: null, nodes: 1 }, 'control: corpus is drawn from its saved index');
  assert.equal(h.out.length, 0, 'control: and nothing is asked of a scan for it');
  // Stop: the older tree is back with its scan (putBackHeldTree), and the view asks for Mail's map again.
  Object.assign(h.state, { scanning: false, scanId: 'scan-mail', settledScanId: 'scan-mail', root: h.mailTree });
  h.state.treemap.rootPath = h.MAIL;
  const drawn = h.draws.length;
  const again = h.loadTreemap(h.MAIL);
  assert.deepEqual(h.draws.slice(drawn), [{ rootPath: h.MAIL, scanId: 'scan-mail', nodes: 2 }],
    'Mail\'s map is drawn in the same turn as the load that asks for it — corpus\'s drawing is not left on screen under Mail while its scan is asked');
  assert.equal(h.out.length, 1, 'and its scan is still asked for Mail\'s map');
  await h.answer();
  await again;
  assert.deepEqual(h.draws.at(-1), { rootPath: h.MAIL, scanId: 'scan-mail', nodes: 2 }, 'whose answer is drawn when it lands');
  // Within one scan nothing is drawn ahead of its answer: a refresh, a depth change, an archive opened — what changed
  // there is the scan's to say.
  const before = h.draws.length;
  const refresh = h.loadTreemap(h.MAIL);
  assert.equal(h.draws.length, before, 'a load within the scan on screen draws only when its answer lands');
  await h.answer();
  await refresh;
  assert.equal(h.draws.length, before + 1, 'control: and draws then');
});

test('J06: on a home folder\'s map the Stop draws the older map as it was drawn — its files where they were and one Trash cell — never its files squeezed again beside a second Trash cell; after a second Stop too, made before the first one\'s answer landed (review F1.1, F1.3)', async () => {
  // The kept map was the scan's answer itself, whose nodes the map was handed: maybeInjectTrash squeezes them in place
  // and adds the Trash cell to them, so a Stop landed them a second time — every file squeezed twice and two Trash
  // cells, a quarter of the map's width left empty — and when the older scan had expired that map stayed. A map kept
  // as a copy but landed as itself is squeezed by the first Stop's landing, which a second Stop then lands again.
  const h = stopHarness({ home: true });
  const first = h.loadTreemap(h.MAIL);
  await h.answer();
  await first;
  const drawn = h.shapes.at(-1)!;
  assert.equal(drawn.filter((c) => c.startsWith('Trash@')).length, 1, `control: the home folder's map has its Trash cell (${drawn})`);
  assert.equal(drawn.length, 3, `control: beside Mail's two files (${drawn})`);
  const loads: Array<Promise<void>> = [];
  for (const stop of [1, 2]) {
    Object.assign(h.state, { scanning: true, scanId: null, settledScanId: null, root: h.corpusTree });
    h.state.treemap.rootPath = h.CORPUS;
    await h.loadTreemap(h.CORPUS);
    assert.ok(!h.shapes.at(-1)!.some((c) => c.startsWith('Trash@')), 'control: corpus is no home folder, and its map has no Trash cell');
    Object.assign(h.state, { scanning: false, scanId: 'scan-mail', settledScanId: 'scan-mail', root: h.mailTree });
    h.state.treemap.rootPath = h.MAIL;
    const at = h.shapes.length;
    loads.push(h.loadTreemap(h.MAIL));
    assert.deepEqual(h.shapes.slice(at), [drawn], `Stop ${stop}: the older map is drawn at once as it was drawn`);
  }
  assert.equal(h.out.length, 2, 'control: both Stops asked the scan for Mail\'s map, and neither answer has landed');
  await h.answer();
  await h.answer();
  await Promise.all(loads);
  assert.deepEqual(h.shapes.at(-1), drawn, 'and the scan\'s answer, when it lands, draws it the same');
});

test('J06: the older map is drawn ahead of its answer only for the scan, folder and depth it was drawn for, and not while History is scrubbed — a load of the same folder in another scan of it, of another folder of that scan, of the same folder at another depth, or one under a scrub waits for its own answer (review F1.9, F2.3)', async () => {
  const h = stopHarness();
  const cases: Array<{ what: string; path: string; set: (on: boolean) => void }> = [
    // A newer scan of Mail behind the tree: the older scan's map drawn ahead of its answer would stand for it, and stay
    // if that answer failed (review F2.3).
    { what: 'Mail in another scan of it', path: h.MAIL, set(on) { Object.assign(h.state, { scanId: on ? 'scan-mail-2' : 'scan-mail', settledScanId: on ? 'scan-mail-2' : 'scan-mail' }); } },
    { what: 'another folder of the same scan', path: `${h.MAIL}/Archive`, set() {} },
    { what: 'Mail at another depth', path: h.MAIL, set(on) { h.state.treemap.maxDepth = on ? 3 : 4; } },
    { what: 'Mail while History is scrubbed', path: h.MAIL, set(on) { h.state.treemap.history.scrubbing = on; } },
  ];
  for (const c of cases) {
    await h.mailThenCorpusThenStop();
    c.set(true);
    const at = h.draws.length;
    const load = h.loadTreemap(c.path);
    assert.equal(h.draws.length, at, `${c.what}: nothing is drawn before its own answer lands — the map kept is scan-mail's of Mail at depth 4`);
    await h.answer();
    await load;
    c.set(false);
  }
  // Control: for the folder and depth it was drawn for, it is drawn at once — so each silence above is its case's.
  await h.mailThenCorpusThenStop();
  const at = h.draws.length;
  const load = h.loadTreemap(h.MAIL);
  assert.equal(h.draws.length, at + 1, 'control: a Stop back to Mail at depth 4 draws Mail\'s map at once');
  await h.answer();
  await load;
});

test('J06: the older map is drawn at once for its folder by either spelling — as the view asked for it, when its scan answered under the folder\'s own (a link: /tmp answered as /private/tmp), and as the scan answered (review F2.3)', async () => {
  // The kept map is drawn for a load of its folder by the spelling the view asked with or the one the scan answered
  // with. The harness answered every folder as asked, so dropping the first spelling left every test green; after a
  // scan of a link the Stop's load asks by the link, and the older map would wait for its scan's answer after all.
  const REAL = '/private/Users/x/Mail';
  const h = stopHarness({ answerRoot: (p) => (p === '/Users/x/Mail' ? REAL : p) });
  await h.mailThenCorpusThenStop();
  assert.equal(h.state.treemap.scanMap.ask, h.MAIL, 'control: Mail\'s map was asked as Mail');
  assert.equal(h.state.treemap.scanMap.data.root.path, REAL, 'control: and answered under its own spelling');
  const at = h.draws.length;
  const asked = h.loadTreemap(h.MAIL);
  assert.deepEqual(h.draws.slice(at), [{ rootPath: REAL, scanId: 'scan-mail', nodes: 2 }], 'a Stop back to Mail, asked as before, draws its map at once');
  await h.answer();
  await asked;
  await h.mailThenCorpusThenStop();
  const at2 = h.draws.length;
  const answered = h.loadTreemap(REAL);
  assert.deepEqual(h.draws.slice(at2), [{ rootPath: REAL, scanId: 'scan-mail', nodes: 2 }], 'and asked under the spelling its scan answered with, at once too');
  await h.answer();
  await answered;
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
  const note = load<() => string>(['reclaimCoverageNote', 'reclaimAskableNode', 'reclaimAskablePath', 'treeScanId', 'treeScanComing', 'reclaimNoScanWords'], {
    // A scan stands behind the tree on screen (a saved index's tree is reclaimScoreLoop's, review F3.3).
    state: { scanId: 's1', scanning: false },
    drawnCells: () => cells,
    reclaim: { scores, pending: inFlight, failed: new Set<string>() },
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

/* ══════════════ D26 — one level per click (owner, 5 Oct 2026) ══════════════ */

type Hit = { n: { path: string; type: 'dir' | 'file'; container?: boolean | string; virtual?: boolean; isTrash?: boolean }; center?: boolean };

/** Click the map over `hit` while `rootPath` is on screen; report what the click did. */
function clickOn(hit: Hit, rootPath = '/r') {
  const did = { loaded: [] as string[], previewed: [] as string[], expanded: [] as string[] };
  const click = load<(e: unknown) => void>(['tmOnCanvasClick', 'tmStepToward', 'tmIsInside', 'containerListable'], {
    state: { treemap: { rootPath, history: { active: false } } },
    tmPreview: { on: false },
    hideTooltip() {},
    viewHit: () => hit,
    openTrashModal() { throw new Error('not the Trash cell'); },
    breadcrumbsFor: () => [],
    loadTreemap: (p: string) => { did.loaded.push(p); },
    openPreview: (n: { path: string }) => { did.previewed.push(n.path); },
    expandContainerNode: (n: { path: string }) => { did.expanded.push(n.path); },
  }, 'tmOnCanvasClick', 'let tmSuppressClick = false;');
  click({ clientX: 10, clientY: 10 });
  return did;
}

test('D26: a click opens the next folder down under the pointer, never the deepest one drawn there', () => {
  // QA: one click went AssetsV2 › … › AssetData, four levels at once, while
  // the tour said "click to drill in" and Esc climbs back ONE.
  assert.deepEqual(clickOn({ n: { path: '/r/a/b/c', type: 'dir' } }).loaded, ['/r/a'],
    'a folder drawn three levels down opens its top-level ancestor');
  assert.deepEqual(clickOn({ n: { path: '/r/a', type: 'dir' } }).loaded, ['/r/a'], 'a top-level folder opens itself');
  const deepFile = clickOn({ n: { path: '/r/a/b/movie.mov', type: 'file' } });
  assert.deepEqual(deepFile.loaded, ['/r/a'], 'a file inside a folder is a click on that folder, one level down');
  assert.deepEqual(deepFile.previewed, [], 'and does not open a preview from three levels away');
  assert.deepEqual(clickOn({ n: { path: '/r/notes.txt', type: 'file' } }).previewed, ['/r/notes.txt'],
    'a file directly in the folder on screen still opens its preview');
});

test('D26: the step is separator-aware: Windows paths, a drive root, and archive entries', () => {
  assert.deepEqual(clickOn({ n: { path: 'C:\\Users\\me\\AppData\\Local\\Temp', type: 'dir' } }, 'C:\\Users\\me').loaded,
    ['C:\\Users\\me\\AppData'], 'a Windows tree steps on its own separator');
  assert.deepEqual(clickOn({ n: { path: '/Users/me/x', type: 'dir' } }, '/').loaded, ['/Users'],
    'from the filesystem root the next level is /Users, not "" or "//Users"');
  // A Windows drive root ends in its separator too, and is the case a scan of C:\ lands in.
  assert.deepEqual(clickOn({ n: { path: 'C:\\Users\\me\\x', type: 'dir' } }, 'C:\\').loaded, ['C:\\Users'],
    'from a drive root the next level is C:\\Users, not "C:" or "C:\\\\Users"');
  assert.deepEqual(clickOn({ n: { path: 'C:\\pagefile.sys', type: 'file' } }, 'C:\\').previewed, ['C:\\pagefile.sys'],
    'a file directly on the drive opens its preview');
  assert.deepEqual(clickOn({ n: { path: '/r/z.zip/inner/x.txt', type: 'file', virtual: true } }).loaded, ['/r/z.zip'],
    'an entry inside an opened archive opens the archive first');
  assert.deepEqual(clickOn({ n: { path: '/r/z.zip', type: 'file', container: true } }).expanded, ['/r/z.zip'],
    'an archive on screen still opens through the container route');
});

/* ══════════════ B37 — a .dmg is a plain file on the map ══════════════ */

test('B37: a .dmg on screen previews like a plain file — the server cannot list one, so the click never asks it to', () => {
  const dmg = clickOn({ n: { path: '/r/Installer.dmg', type: 'file', container: 'dmg' } });
  assert.deepEqual(dmg.expanded, [], 'no POST /api/container/expand, which answers 422 for every .dmg');
  assert.deepEqual(dmg.previewed, ['/r/Installer.dmg'], 'it opens its preview, as any file does');
  assert.deepEqual(clickOn({ n: { path: '/r/disc.iso', type: 'file', container: 'iso' } }).expanded, ['/r/disc.iso'],
    'a disc image the server can list still opens through the container route');
});

/** The page's showTooltip over stubs, with the cart preview `previewOn`; answers the tooltip and a function that shows a node. */
function tooltipWorld(previewOn = false) {
  const tip = { innerHTML: '', style: {} as Record<string, string>, dataset: {} as Record<string, string>, offsetWidth: 0, offsetHeight: 0 };
  const show = load<(x: number, y: number, node: unknown) => void>(['showTooltip', 'containerListable', 'sizeInk'], {
    $: () => tip, icon: () => '', escapeHtml: (s: unknown) => String(s), formatBytes: (n: number) => `${n} B`, sizeColor: () => '#fff',
    formatDate: () => 'then', state: { view: 'treemap', grid: {}, treemap: {} }, kindFor: () => ({ tint: '#000', icon: 'file' }),
    resolveAllocation() {}, resolveScore() {}, resolveHumanScale() {},
    allocationTooltipLine: () => '', reclaimTooltipLine: () => '', humanScaleTooltipLine: () => '', noteTooltipLine: () => '',
    window: { innerWidth: 1000, innerHeight: 800 }, tmPreview: { on: previewOn },
  }, 'showTooltip');
  return { tip, show };
}

test('the tooltip does not invite a click "to look inside" an archive while the cart preview is up — a click does nothing then — and says when it can be (BQG-5 item 15)', () => {
  const zip = { name: 'a.zip', path: '/r/a.zip', type: 'file', size: 5, modifiedAt: 0, container: 'zip' };
  const during = tooltipWorld(true);
  during.show(1, 1, zip);
  assert.doesNotMatch(during.tip.innerHTML, /click to look inside/, 'no click to promise during the preview');
  assert.match(during.tip.innerHTML, / · you can look inside it after the preview/, 'it says when it can be looked inside, as the key does');
  const after = tooltipWorld(false);
  after.show(1, 1, zip);
  assert.match(after.tip.innerHTML, / · click to look inside/, 'control: outside the preview the click is offered');
});

test('B37: the tooltip never invites a click "to look inside" a .dmg', () => {
  const tip = { innerHTML: '', style: {} as Record<string, string>, dataset: {} as Record<string, string>, offsetWidth: 0, offsetHeight: 0 };
  const show = load<(x: number, y: number, node: unknown) => void>(['showTooltip', 'containerListable', 'sizeInk'], { // sizeInk: the size line's readable ink (B21), over the sizeColor below
    tmPreview: { on: false },
    $: () => tip,
    icon: () => '',
    escapeHtml: (s: unknown) => String(s),
    formatBytes: (n: number) => `${n} B`,
    sizeColor: () => '#fff',
    formatDate: () => 'then',
    state: { view: 'treemap', grid: {}, treemap: {} },
    kindFor: () => ({ tint: '#000', icon: 'file' }),
    resolveAllocation() {}, resolveScore() {}, resolveHumanScale() {},
    allocationTooltipLine: () => '', reclaimTooltipLine: () => '', humanScaleTooltipLine: () => '', noteTooltipLine: () => '',
    window: { innerWidth: 1000, innerHeight: 800 },
  }, 'showTooltip');
  const file = (name: string, container: string) => ({ name, path: `/r/${name}`, type: 'file', size: 5, modifiedAt: 0, container });
  show(1, 1, file('Installer.dmg', 'dmg'));
  assert.doesNotMatch(tip.innerHTML, /look inside/, 'a .dmg cannot be looked inside without mounting it');
  show(1, 1, file('a.zip', 'zip'));
  assert.match(tip.innerHTML, /click to look inside/, 'an archive the server can list still says so');
});

test('B37: the dashed "drillable" border is drawn only on containers the server can list', () => {
  const draw = declSource('drawTreemap');
  const pass = draw.slice(draw.indexOf('Pass 7'), draw.indexOf('Pass 7') + 600);
  assert.match(pass, /if \(!containerListable\(r\.n\) \|\| r\.n\.virtual\) continue;/,
    'the badge pass asks the same question as the click');
});

/** Click a Disk City building while `rootPath` is on screen; report the folders the city loaded. */
function cityClickOn(node: { path: string; type: string } | null, rootPath = '/r') {
  const loaded: string[] = [];
  const drill = load<(n: unknown) => void>(['cityDrillInto', 'tmStepToward', 'tmIsInside'], {
    state: { treemap: { rootPath } },
    loadCity: (p: string) => { loaded.push(p); },
  }, 'cityDrillInto');
  drill(node);
  return loaded;
}

test('B11: Disk City opens one level per click too — the next folder down under the pointer, never the deepest building', () => {
  // B11: from /Applications one click on "Kotlin" landed in IntelliJ IDEA.app/
  // Contents/plugins/Kotlin, four levels at once, while the four map layouts
  // step one level and Esc climbs back one (owner, D26: one level per click).
  assert.deepEqual(cityClickOn({ path: '/Applications/IntelliJ IDEA.app/Contents/plugins/Kotlin', type: 'dir' }, '/Applications'),
    ['/Applications/IntelliJ IDEA.app'], 'a building four levels down opens the folder one level down that holds it');
  assert.deepEqual(cityClickOn({ path: '/r/a', type: 'dir' }), ['/r/a'], 'a folder directly here opens itself');
  assert.deepEqual(cityClickOn({ path: '/r/a/b/movie.mov', type: 'file' }), ['/r/a'],
    'a file building inside a folder is a click on that folder, one level down');
  assert.deepEqual(cityClickOn({ path: '/r/notes.txt', type: 'file' }), [], 'a file directly here has no level to open');
  assert.deepEqual(cityClickOn(null), [], 'a click on open ground does nothing');
  assert.deepEqual(cityClickOn({ path: 'C:\\Users\\me\\AppData\\Local\\Temp', type: 'dir' }, 'C:\\Users\\me'),
    ['C:\\Users\\me\\AppData'], 'separator-aware, as the map is');
});

test('D26: the tour describes the click the map actually performs', () => {
  const start = INDEX.indexOf("tour.step === 'map'");
  assert.notEqual(start, -1, 'the map step of the tour exists');
  const card = INDEX.slice(start, INDEX.indexOf('</p>', start));
  assert.match(card, /Click a folder to open it, one level at a time/, 'one click, one level — the owner\'s rule, in words');
  assert.match(card, /<kbd>Esc<\/kbd> to climb back up a level/, 'and Esc is the same step in reverse');
});

/* ══════════════ D25 — the breadcrumb trail folds instead of clipping ══════════════ */

const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Where keyboard focus is, for the fake elements below: `focus()` moves it,
 * and the code under test reads it back through `document.activeElement`.
 */
const fakeDoc = {
  body: { tagName: 'BODY' } as unknown,
  active: null as unknown,
  get activeElement() { return fakeDoc.active; },
  /**
   * The page's own document-level click handler — the one that closes
   * #ctxMenu on a click outside it — as crumbsHarness loaded it, or null.
   * Every fake click bubbles to it unless a listener stopped it (QA-6b review F2.2).
   */
  clickHandler: null as ((e: ClickEv) => void) | null,
};

type ClickEv = { target: unknown; currentTarget: unknown; propagationStopped: boolean; stopPropagation(): void; preventDefault(): void };

/**
 * A click on `target`, as the browser delivers it: the element's own
 * listeners first, then — unless one of them stopped it — the page's document
 * click handler, which a click bubbles up to. The doubles used to hand every
 * listener a stopPropagation() that did nothing and never reached the
 * document, so a menu whose opening click closed it again stayed green
 * (QA-6b review F2.2). `at` is the element whose listeners `own` are — the
 * `currentTarget` they see — when the click landed on something inside it,
 * such as a button's icon: then `target` is that icon and only `at` is the
 * button (final review F1.3).
 */
function dispatchClick(target: unknown, own: Array<(e: unknown) => void> = [], at: unknown = target): ClickEv {
  const ev: ClickEv = { target, currentTarget: at, propagationStopped: false,
    stopPropagation() { ev.propagationStopped = true; }, preventDefault() {} };
  for (const f of own) f(ev);
  if (!ev.propagationStopped && fakeDoc.clickHandler) {
    ev.currentTarget = fakeDoc;
    fakeDoc.clickHandler(ev);
  }
  return ev;
}

type FakeBtn = {
  tagName: string; path: string | null; more: boolean; nm: string | null; text: string; current: boolean; disabled: boolean;
  attrs: Record<string, string>;
  /** Every `data-*` attribute, camel-cased, as the DOM's dataset has them. */
  dataset: Record<string, string>; listeners: Record<string, Array<(e: unknown) => void>>;
  /** Every scrollIntoView() call's options, in order. */
  scrolls: unknown[];
  addEventListener(t: string, f: (e: unknown) => void): void; click(): void;
  getBoundingClientRect(): { left: number; bottom: number }; focus(): void; scrollIntoView(o?: unknown): void;
  setAttribute(k: string, v: string): void; getAttribute(k: string): string | null; hasAttribute(k: string): boolean;
  closest(sel: string): unknown;
};

/**
 * `el.closest(sel)` for the fakes, which have no parents: the element itself,
 * matched against each selector of a comma list — a tag name, `[attr]` and
 * `[attr="value"]` (QA-6b review F1.9). It used to answer the button for any
 * list that mentioned `button`, so `a[href]` and the ARIA roles were never tried.
 */
function fakeClosest<T extends { tagName: string; attrs: Record<string, string> }>(el: T, sel: string): T | null {
  for (const one of sel.split(',')) {
    const m = /^\s*([a-z]*)((?:\[[^\]]+\])*)\s*$/i.exec(one);
    if (!m) throw new Error(`the fake closest() cannot read ${JSON.stringify(one)}`);
    if (m[1] && m[1].toUpperCase() !== el.tagName) continue;
    const conds = [...m[2].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
    if (conds.every(([, k, v]) => k in el.attrs && (v === undefined || el.attrs[k] === v))) return el;
  }
  return null;
}

/** A fake element that is not a button: a link, a `div` with a role, a menu's separator. */
function fakeEl(tagName: string, attrs: Record<string, string> = {}) {
  const el = {
    tagName, attrs,
    setAttribute(k: string, v: string) { el.attrs[k] = String(v); },
    getAttribute(k: string) { return k in el.attrs ? el.attrs[k] : null; },
    closest(sel: string) { return fakeClosest(el, sel); },
    focus() { fakeDoc.active = el; },
  };
  return el;
}

function parseButtons(html: string): FakeBtn[] {
  const out: FakeBtn[] = [];
  for (const m of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)) {
    const attrText = m[1];
    const attrs: Record<string, string> = {};
    for (const a of attrText.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = unesc(a[2] ?? '');
    const p = /data-p="([^"]*)"/.exec(attrText);
    const nm = /<span class="crumb-nm">([\s\S]*?)<\/span>/.exec(m[2]);
    const b: FakeBtn = {
      tagName: 'BUTTON',
      path: p ? unesc(p[1]) : null,
      more: /data-crumb-more/.test(attrText),
      nm: nm ? unesc(nm[1]) : null,
      text: unesc(m[2].replace(/<[^>]*>/g, '')),
      current: /aria-current="true"/.test(attrText),
      disabled: 'disabled' in attrs,
      attrs,
      dataset: Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith('data-'))
        .map(([k, v]) => [k.slice(5).replace(/-(\w)/g, (_, c: string) => c.toUpperCase()), v])),
      scrolls: [],
      listeners: {},
      addEventListener(t, f) { (b.listeners[t] ||= []).push(f); },
      click() { dispatchClick(b, b.listeners.click || []); },
      getBoundingClientRect: () => ({ left: 0, bottom: 30 }),
      focus() { fakeDoc.active = b; },
      scrollIntoView(o) { b.scrolls.push(o); },
      setAttribute(k, v) { b.attrs[k] = String(v); },
      getAttribute(k) { return k in b.attrs ? b.attrs[k] : null; },
      hasAttribute(k) { return k in b.attrs; },
      closest(sel: string) { return fakeClosest(b, sel); },
    };
    out.push(b);
  }
  return out;
}

/**
 * The `.crumbs` rule's numbers, read from the built page: the width of the
 * mask's fade, the gap between items, and a button's ceiling. The fit tests
 * measure against these rather than against copies of the product's own
 * constants, so a fade the CSS widens is a fade the trail must clear.
 */
function crumbsCss() {
  const at = INDEX.indexOf('.crumbs { display: flex;');
  assert.notEqual(at, -1, 'the .crumbs rule is in the built page');
  const rule = INDEX.slice(at, INDEX.indexOf('}', at));
  const fades = [...rule.matchAll(/mask-image:\s*linear-gradient\(to right, transparent 0, #000 (\d+)px\)/g)].map((m) => Number(m[1]));
  assert.equal(fades.length, 2, 'the fade is declared for -webkit-mask-image and mask-image');
  assert.equal(fades[0], fades[1], 'both draw the same fade');
  const gap = /gap:\s*(\d+)px/.exec(rule);
  const btnAt = INDEX.indexOf('.crumbs button {');
  const maxW = /max-width:\s*(\d+)px/.exec(INDEX.slice(btnAt, INDEX.indexOf('}', btnAt)));
  assert.ok(gap && maxW, 'the gap and the button ceiling are declared in px');
  return { fade: fades[0], gap: Number(gap![1]), maxW: Number(maxW![1]) };
}

/**
 * A crumb host that lays its buttons out the way `.crumbs` does: one line,
 * packed to the END, so a trail wider than the host overflows past its START
 * edge — the first button's left edge goes negative. Text widths are a model
 * (7 px a character, 15 px separators, 30 px for "…"); the gap and a button's
 * ceiling are the CSS's own (crumbsCss).
 */
function makeHost(width: number) {
  const h = {
    clientWidth: width, html: '', buttons: [] as FakeBtn[], seps: 0, cls: new Set<string>(),
    classList: {
      add: (c: string) => { h.cls.add(c); }, remove: (c: string) => { h.cls.delete(c); },
      contains: (c: string) => h.cls.has(c),
      toggle: (c: string, on?: boolean) => { if (on ?? !h.cls.has(c)) h.cls.add(c); else h.cls.delete(c); },
    },
    set innerHTML(v: string) { h.html = v; h.buttons = parseButtons(v); h.seps = (v.match(/class="sep"/g) || []).length; },
    get innerHTML() { return h.html; },
    natural(): number {
      const items = h.buttons.map((b) => (b.more ? 30 : Math.min(crumbsCss().maxW, 20 + b.text.length * 7)));
      return items.reduce((a, w) => a + w, 0) + h.seps * 15 + crumbsCss().gap * Math.max(0, items.length + h.seps - 1);
    },
    /**
     * Where each button lands: packed to the end, or — under the tight mark
     * (QA C05), as its own rules read from the built page say — to the start,
     * with the folder on screen shrinking to its padding and border (22 px)
     * and no fade. A separator sits between each pair of buttons.
     */
    layout() {
      const tight = h.cls.has('crumbs-tight') ? tightCss() : null;
      const gap = crumbsCss().gap;
      const widths = h.buttons.map((b) => (b.more ? 30 : Math.min(crumbsCss().maxW, 20 + b.text.length * 7)));
      const total = h.natural();
      const cur = h.buttons.findIndex((b) => b.current);
      if (tight && tight.shrinks && cur !== -1 && total > h.clientWidth) widths[cur] = Math.max(22, widths[cur] - (total - h.clientWidth));
      const used = widths.reduce((a, w) => a + w, 0) + h.seps * 15 + gap * Math.max(0, widths.length + h.seps - 1);
      let x = tight && tight.start ? 0 : h.clientWidth - used;
      const boxes = h.buttons.map((b, i) => {
        const box = { more: b.more, current: b.current, left: x, right: x + widths[i] };
        x = box.right + gap + 15 + gap;
        return box;
      });
      return Object.assign(boxes, { fade: tight && tight.noFade ? 0 : crumbsCss().fade });
    },
    get firstElementChild() {
      return h.buttons.length ? { getBoundingClientRect: () => ({ left: h.layout()[0].left }) } : null;
    },
    contains: (el: unknown) => h.buttons.includes(el as FakeBtn),
    getBoundingClientRect: () => ({ left: 0, right: h.clientWidth }),
    querySelectorAll(sel: string) {
      if (sel === 'button[data-p]') return h.buttons.filter((b) => b.path !== null);
      if (sel === 'button') return h.buttons;
      throw new Error('unexpected selector ' + sel);
    },
    querySelector(sel: string) {
      if (sel === '[data-crumb-more]') return h.buttons.find((b) => b.more) || null;
      throw new Error('unexpected selector ' + sel);
    },
  };
  return h;
}

const DEEP = '/System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime/7f2d3a5b8c9e1f0a/AssetData';

/** The arrow function `(e) => {…}` registered right after `anchor` in the built page, cut out by brace matching. */
function listenerAfter(anchor: string, what: string): string {
  const at = INDEX.indexOf(anchor);
  assert.notEqual(at, -1, `${what} is where this test thinks it is`);
  const start = INDEX.indexOf('(e) => {', at);
  let depth = 0;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`${what} never closes`);
}

/** The page's own document-level keydown handler — the anonymous one holding the map's keys. */
function pageKeydownSource(): string {
  return listenerAfter("document.addEventListener('keydown', (e) => {\n  const mod = e.metaKey || e.ctrlKey;", 'the page keydown handler');
}

/** The Export button's own click listener, which fills #ctxMenu and shows it (QA-6b review F1.7). */
function exportClickSource(): string {
  return listenerAfter("$('tmExportBtn').addEventListener('click', (e) => {", 'the Export click listener');
}

/** The page's document-level click handler: a click outside #ctxMenu closes it (QA-6b review F2.2). */
function docClickSource(): string {
  return listenerAfter("document.addEventListener('click', (e) => { if (!$('ctxMenu')", 'the document click handler');
}

/** The Export button as the markup draws it, its attributes the page's own. */
function exportButton(): FakeBtn {
  const at = INDEX.indexOf('id="tmExportBtn"');
  assert.notEqual(at, -1, 'the Export button is in the built page');
  const [btn] = parseButtons(INDEX.slice(INDEX.lastIndexOf('<button', at), INDEX.indexOf('</button>', at) + '</button>'.length));
  return btn;
}

type FakeMenu = {
  html: string; buttons: FakeBtn[]; divs: Array<ReturnType<typeof fakeEl>>;
  /** The `.ctx-list` the entries scroll in, when what was written has one. */
  list: ReturnType<typeof fakeEl> | null;
  style: Record<string, string>; offsetHeight: number;
  attrs: Record<string, string>;
  innerHTML: string; querySelectorAll(sel: string): unknown[]; querySelector(sel: string): FakeBtn | null;
  setAttribute(k: string, v: string): void; getAttribute(k: string): string | null; contains(el: unknown): boolean;
};

/**
 * #ctxMenu's own attributes, as the built markup draws the element. Its role
 * comes from there alone — ctxMenuShow names the menu and gives its entries
 * the menuitem role, and both mean something only inside a `menu` — so the
 * fake starts as the markup does rather than as a role-less box (QA-6b review F2.5).
 */
function ctxMenuMarkupAttrs(): Record<string, string> {
  const tags = [...INDEX.matchAll(/<div\b([^>]*\bid="ctxMenu"[^>]*)>/g)];
  assert.equal(tags.length, 1, '#ctxMenu is drawn once in the built page');
  return Object.fromEntries([...tags[0][1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((a) => [a[1], unesc(a[2] ?? '')]));
}

/**
 * #ctxMenu: its buttons and its `.div` dividers are parsed from what is
 * written into it, and only the selectors the page uses on it are answered
 * — anything else throws rather than quietly answering the buttons.
 */
function fakeMenu(): FakeMenu {
  fakeDoc.clickHandler = null; // a new page: whichever handler bubbled before belonged to another menu
  const menu: FakeMenu = { html: '', buttons: [], divs: [], list: null, style: {}, offsetHeight: 120, attrs: ctxMenuMarkupAttrs(),
    set innerHTML(v: string) {
      menu.html = v;
      menu.buttons = parseButtons(v);
      menu.divs = [...v.matchAll(/<div class="div"><\/div>/g)].map(() => fakeEl('DIV', { class: 'div' }));
      menu.list = /^<div class="ctx-list" role="none">[\s\S]*<\/div>$/.test(v) ? fakeEl('DIV', { class: 'ctx-list', role: 'none' }) : null;
    },
    get innerHTML() { return menu.html; },
    querySelectorAll(sel: string) {
      if (sel === 'button') return menu.buttons;
      if (sel === '.div') return menu.divs;
      throw new Error('unexpected selector ' + sel);
    },
    querySelector(sel: string) {
      if (sel === 'button') return menu.buttons[0] || null;
      const act = /^\[data-act="([^"]+)"\]$/.exec(sel);
      if (act) return menu.buttons.find((b) => b.dataset.act === act[1]) || null;
      throw new Error('unexpected selector ' + sel);
    },
    setAttribute(k, v) { menu.attrs[k] = String(v); },
    getAttribute(k) { return k in menu.attrs ? menu.attrs[k] : null; },
    contains: (el: unknown) => el === menu || (!!menu.list && el === menu.list) || menu.buttons.includes(el as FakeBtn)
      || menu.divs.includes(el as ReturnType<typeof fakeEl>) };
  return menu;
}

/** The menu's machinery, shared by the "…" crumb, the right-click menu and Export (QA-6 review MEDIUM-1). */
const CTX_MENU_DECLS = ['ctxMenuOpener', 'ctxMenuReturn', 'CTX_MENU_EDGE', 'ctxMenuShow', 'hideCtxMenu', 'ctxMenuFocusOpener', 'ctxMenuIsOpen',
  'ctxMenuKeydown'];

type KeyEv = { key: string; target: unknown; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean;
  defaultPrevented: boolean; preventDefault(): void; stopPropagation(): void };
const keyEv = (key: string, target: unknown = fakeDoc.active): KeyEv => {
  const ev: KeyEv = { key, target, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false,
    preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {} };
  return ev;
};

/**
 * `view` and `selection` put the page in another view — the Grid shares the trail and its "…" menu (QA-6b review F2.6).
 * `kbSel` is the Treemap's keyboard selection, the cell its keys act on.
 */
function crumbsHarness(opts: { view?: string; selection?: string[]; kbSel?: Record<string, unknown> } = {}) {
  const picked: string[] = [];
  const focusAtPick: unknown[] = [];
  const observers: Array<{ cb: () => void; el: unknown }> = [];
  const menu = fakeMenu();
  const map = { drill: 0, up: 0, move: 0 };
  /** The Grid's climbs (gridUp). */
  const gridMoves = { up: 0 };
  /** What an entry of the Export or right-click menu did when it was picked. */
  const acts: string[] = [];
  /**
   * Where focus was as each of those ran: a sheet an act opens — Quick Look,
   * the Trash sheet — remembers document.activeElement to give focus back to
   * on close, so focus must already be off the menu (QA-6b review F2.4).
   */
  const actFocus: unknown[] = [];
  const act = (name: string) => (p?: unknown) => {
    acts.push(typeof p === 'string' ? `${name} ${p}` : name);
    actFocus.push(fakeDoc.active);
  };
  const canvas = { tagName: 'CANVAS', focus() { fakeDoc.active = canvas; } };
  fakeDoc.active = fakeDoc.body;
  class FakeRO { cb: () => void; constructor(cb: () => void) { this.cb = cb; } observe(el: unknown) { observers.push({ cb: this.cb, el }); } }
  type Page = {
    render: (host: unknown, p: string, onPick: (p: string) => void, mapFocus?: () => unknown) => void; keydown: (e: KeyEv) => void;
    exportClick: (e: unknown) => void; showCtxMenu: (x: number, y: number, node: unknown) => void;
    docClick: (e: ClickEv) => void;
  };
  const { render, keydown, exportClick, showCtxMenu, docClick } = load<Page>(
    ['renderCrumbs', 'breadcrumbsFor', 'crumbsPaint', 'crumbFolded', 'crumbsOverflow', 'crumbsWatch', 'showCrumbMenu', 'CRUMB_FADE_PX',
      ...CTX_MENU_DECLS, 'tmMapKeyYields', 'tmMapTakeFocus', 'showCtxMenu', 'ctxTarget', 'gridSelectionShown'], {
      state: {
        scanId: 's1', scanning: false,
        root: { path: '/System', name: 'System' }, view: opts.view ?? 'treemap', lasso: { on: false },
        grid: { selection: new Set(opts.selection ?? []) },
        system: { platform: 'darwin' },
        treemap: { rootPath: DEEP, history: { active: false, snaps: [] }, kbSel: opts.kbSel ?? null },
      },
      // The Export menu's own world: a map is drawn, the PNG and SVG entries are offered.
      drawnCells: () => [{}],
      isRectMap: () => true,
      HTMLCanvasElement: { prototype: {} },
      toast: (m: string) => { throw new Error('the page reported: ' + m); },
      exportTreemapPNG: act('png'), exportTreemapSVG: act('svg'), exportTimelapseGif: act('gif'), exportTimelapseWebm: act('webm'),
      downloadReport: act('report'),
      // The right-click menu's.
      cartHas: () => false, budgetFor: () => null, noteFor: () => null,
      openInOS: act('open'), copyPath: act('copy'), openPreview: act('preview'), cartToggle: act('cart'), confirmTrash: act('trash'),
      cloudProviderOfScan: () => ({ name: 'Drive' }),
      document: fakeDoc,
      icon: () => '<svg></svg>',
      escapeHtml: esc,
      hideTooltip() {},
      nodeFor: () => null,
      openBudgetDialog() {},
      $: (id: string) => { assert.equal(id, 'ctxMenu'); return menu; },
      window: { innerWidth: 1440, innerHeight: 900 },
      ResizeObserver: FakeRO,
      // The rest of the page's keydown handler, as far as the keys below reach it.
      tablistKeydown: () => false,
      topModal: () => null,
      tmPreview: { on: false },
      kbDrill: () => { map.drill++; },
      kbUp: () => { map.up++; },
      kbMove: () => { map.move++; },
      gridUp: () => { gridMoves.up++; },
      tmCanvas: canvas,
    }, `{ render: renderCrumbs, keydown: (${pageKeydownSource()}), exportClick: (${exportClickSource()}), showCtxMenu,
      docClick: (${docClickSource()}) }`);
  // Every click from here on bubbles to the page's own document handler, as in the window.
  fakeDoc.clickHandler = docClick;
  return {
    render, keydown, showCtxMenu, acts, actFocus, map, gridMoves, canvas, picked, focusAtPick, menu, observers,
    onPick: (p: string) => { picked.push(p); focusAtPick.push(fakeDoc.active); },
    /**
     * The Export button as the markup draws it, with Export's own click
     * listener on it: press it with click(), or with pressIcon() where a
     * pointer lands on its icon — the click's target is then the icon's svg,
     * and only its currentTarget is the button (final review F1.3).
     */
    exportBtn(): FakeBtn & { pressIcon(): void } {
      const btn = exportButton();
      btn.addEventListener('click', exportClick);
      assert.match(INDEX.slice(INDEX.indexOf('id="tmExportBtn"'), INDEX.indexOf('</button>', INDEX.indexOf('id="tmExportBtn"'))),
        /<span data-icon="[\w-]+"><\/span>/, 'control: Export draws an icon inside itself, which a pointer can land on');
      const iconEl = fakeEl('svg', { class: 'ic' });
      return Object.assign(btn, { pressIcon: () => { dispatchClick(iconEl, btn.listeners.click || [], btn); } });
    },
    /** A click on something that is not one of the fakes' buttons — the map, the page — which only bubbles. */
    clickOn: (target: unknown) => dispatchClick(target),
  };
}

/** Every path the trail offers: the visible crumbs, plus whatever the "…" menu lists. */
function reachable(host: ReturnType<typeof makeHost>, h: ReturnType<typeof crumbsHarness>): string[] {
  const out = host.buttons.filter((b) => b.path).map((b) => b.path as string);
  const more = host.buttons.find((b) => b.more);
  if (more) { more.click(); out.push(...h.menu.buttons.map((b) => b.path as string)); }
  return out;
}

test('D25: a deep trail that does not fit folds its ancestors into "…" — clear of the fade, every ancestor one click away', () => {
  const h = crumbsHarness();
  const host = makeHost(420);
  h.render(host, DEEP, h.onPick);
  const ancestors = ['/System', '/System/Library', '/System/Library/AssetsV2',
    '/System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime',
    '/System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime/7f2d3a5b8c9e1f0a'];
  assert.ok(host.clientWidth - host.natural() >= crumbsCss().fade,
    `the trail fits clear of the ${crumbsCss().fade} px fade instead of being sliced mid-word (needs ${host.natural()} px of ${host.clientWidth})`);
  assert.ok(host.buttons.some((b) => b.more), 'something had to fold, and it folded into the "…" crumb');
  assert.equal(host.buttons[0].path, '/System', 'the middle folds first: the root stays on screen while it fits');
  const cur = host.buttons[host.buttons.length - 1];
  assert.equal(cur.path, DEEP, 'the folder on screen is the last crumb and never folds');
  assert.equal(cur.nm, 'AssetData', 'its name sits in .crumb-nm, the span that can ellipsize');
  const offered = reachable(host, h);
  for (const a of ancestors) assert.ok(offered.includes(a), `${a} is reachable from the crumbs`);
  // Picking from the menu navigates there.
  const lib = h.menu.buttons.find((b) => b.path === '/System/Library');
  assert.ok(lib, 'Library is in the menu — QA could not reach it at all');
  lib!.click();
  assert.deepEqual(h.picked, ['/System/Library']);
});

test('D25: "fits" means clear of the fade, not merely inside the box', () => {
  // At 630 px the trail with two ancestors folded measures 611 px: inside the
  // box, but its first 19 px sit under the 34 px mask — the half-legible root
  // the old clip produced. It folds one more.
  const h = crumbsHarness();
  const host = makeHost(630);
  h.render(host, DEEP, h.onPick);
  assert.ok(host.clientWidth - host.natural() >= crumbsCss().fade, `clear of the fade (left edge at ${host.clientWidth - host.natural()} px)`);
});

test('D25: a trail that fits is drawn whole — nothing folds that did not have to', () => {
  const h = crumbsHarness();
  const host = makeHost(1400);
  h.render(host, DEEP, h.onPick);
  assert.equal(host.buttons.filter((b) => b.more).length, 0, 'no "…" when everything fits');
  assert.equal(host.buttons.length, 6, 'all six crumbs are on screen');
  assert.ok(host.buttons.every((b) => b.nm !== null), 'and every name is in its ellipsizing span');
});

test('D25: in a very narrow toolbar only "…" and the folder on screen remain, and the menu holds the rest', () => {
  const h = crumbsHarness();
  const host = makeHost(150);
  h.render(host, DEEP, h.onPick);
  assert.deepEqual(host.buttons.map((b) => (b.more ? '…' : b.nm)), ['…', 'AssetData']);
  reachable(host, h);
  assert.equal(h.menu.buttons.length, 5, 'all five ancestors, the root included, are in the menu');
  assert.equal(h.menu.buttons[0].path, '/System', 'in path order, root first');
});

test('D25: the trail re-fits when the toolbar changes width, and a hidden toolbar folds nothing', () => {
  const h = crumbsHarness();
  const host = makeHost(0);
  h.render(host, DEEP, h.onPick);
  assert.equal(host.buttons.filter((b) => b.more).length, 0,
    'a host that is not laid out cannot measure, so nothing is folded on a guess');
  assert.equal(h.observers.length, 1, 'the host is watched for size changes');
  host.clientWidth = 420; // the view is shown
  h.observers[0].cb();
  assert.ok(host.buttons.some((b) => b.more), 'shown at 420 px, the trail folds');
  assert.ok(host.clientWidth - host.natural() >= crumbsCss().fade, 'and fits');
  const painted = host.html;
  host.html = 'untouched';
  h.observers[0].cb();
  assert.equal(host.html, 'untouched', 'a callback with no change of width repaints nothing — the re-fit cannot feed its own observer');
  host.html = painted;
  h.render(host, DEEP, h.onPick);
  assert.equal(h.observers.length, 1, 'one observer per host, however many renders');
});

test('D25: the fold clears the fade the CSS draws — the product\'s fade width is the mask\'s, not a copy that can drift', () => {
  // The fit tests above used to measure against 34, the product's own
  // CRUMB_FADE_PX: a mask widened in the CSS would have left the trail
  // folding to a fade it no longer matched, with every test still green.
  const fadePx = load<number>(['CRUMB_FADE_PX'], {}, 'CRUMB_FADE_PX');
  assert.equal(fadePx, crumbsCss().fade, `CRUMB_FADE_PX (${fadePx}) is the .crumbs mask's fade (${crumbsCss().fade} px)`);
});

test('D25: the name inside a crumb ellipsizes (text-overflow does nothing on the flex button itself)', () => {
  const at = INDEX.indexOf('.crumbs .crumb-nm {');
  assert.notEqual(at, -1, 'the name span has its own rule');
  const rule = INDEX.slice(at, INDEX.indexOf('}', at));
  for (const d of [/min-width:\s*0/, /overflow:\s*hidden/, /text-overflow:\s*ellipsis/, /white-space:\s*nowrap/]) {
    assert.match(rule, d, `.crumb-nm declares ${d}`);
  }
});

/* ══════════════ C05 — folded as far as it goes, the trail still shows "…" ══════════════ */

/**
 * What the tight trail's own rules say, read from the built page: whether it
 * packs to the start, whether the fade is gone, and whether the folder on
 * screen may shrink below its name.
 */
function tightCss() {
  const rule = (sel: string) => {
    const at = INDEX.indexOf(sel + ' {');
    assert.notEqual(at, -1, `${sel} has a rule in the built page`);
    return INDEX.slice(at, INDEX.indexOf('}', at));
  };
  const host = rule('.crumbs.crumbs-tight');
  const cur = rule('.crumbs.crumbs-tight button[aria-current="true"]');
  return {
    start: /justify-content:\s*flex-start/.test(host),
    noFade: /(^|[\s;{])mask-image:\s*none/.test(host) && /-webkit-mask-image:\s*none/.test(host),
    shrinks: /flex:\s*0 1 auto/.test(cur) && /min-width:\s*0/.test(cur),
  };
}

test('C05: a trail folded as far as it goes and still too wide keeps "…" on screen — it was drawn under the Up button at 1024×768', () => {
  // QA re-check: at 1024×768, drilled into a folder, the nav flank left the
  // trail ~88 px. Even "… › Archives" needs more, so — packed to the END —
  // the overflow spilled past the START edge, and "…" went with it: clipped
  // and faded out beside the Up button, the hidden levels neither visible nor
  // reachable. Everything is folded by then, so nothing is left to fade; the
  // folder on screen gives up width instead (its name ellipsizes, and its
  // tooltip holds the whole path).
  for (const width of [150, 88, 60]) {
    const h = crumbsHarness();
    const host = makeHost(width);
    h.render(host, DEEP, h.onPick);
    assert.deepEqual(host.buttons.map((b) => (b.more ? '…' : b.nm)), ['…', 'AssetData'], `${width} px: only "…" and the folder on screen are left`);
    const lay = host.layout();
    const more = lay.find((b) => b.more)!;
    assert.ok(more.left >= 0 && more.right <= width, `${width} px: "…" spans ${more.left}–${more.right} px of a ${width} px trail`);
    assert.ok(more.left >= lay.fade, `${width} px: and none of it is under a fade (it starts at ${more.left} px, the fade runs to ${lay.fade} px)`);
    assert.ok(host.cls.has('crumbs-tight'), `${width} px: the trail is marked tight — it cannot fold any further and still does not fit`);
    const cur = lay.find((b) => b.current)!;
    assert.ok(cur.left >= more.right, `${width} px: the folder on screen follows it`);
    if (width >= 88) assert.ok(cur.right <= width, `${width} px: and fits beside it, its name shortened (${cur.left}–${cur.right} px)`);
  }
  // The mark is decided afresh on every fit: widened, the trail lays out as
  // it always has, folding only what it must.
  const h = crumbsHarness();
  const host = makeHost(88);
  h.render(host, DEEP, h.onPick);
  assert.ok(host.cls.has('crumbs-tight'), 'control: tight at 88 px');
  host.clientWidth = 420;
  h.observers[0].cb();
  assert.ok(!host.cls.has('crumbs-tight'), 'at 420 px the trail is not tight');
  assert.equal(host.buttons[0].path, '/System', 'the root is back on screen — a stale mark would have folded it too');
  assert.ok(host.clientWidth - host.natural() >= crumbsCss().fade, 'and the trail clears the fade as before');
});

test('C05 (review F1.9): folded tight, the folder on screen keeps room for its name, and its whole path shows on hover', () => {
  // At 1024×768 the trail is ~88 px. Folded tight, "…" and the folder on
  // screen kept their 10 px paddings: 33 px for "…", 18 for the separator and
  // its gaps, and 22 of the folder's remaining 37 px went to padding and
  // border — a 15 px name, one letter and an ellipsis. Nor could its title
  // help: the folder on screen takes no pointer events, so it never shows.
  const ruleBody = (sel: string) => {
    const at = INDEX.indexOf(sel + ' {');
    return at === -1 ? null : INDEX.slice(at, INDEX.indexOf('}', at));
  };
  const padX = (body: string | null) => {
    const m = body && /padding:\s*0 (\d+)px/.exec(body);
    return m ? Number(m[1]) : null;
  };
  const base = padX(ruleBody('.crumbs button'));
  assert.equal(base, 10, 'control: a crumb is padded 10 px a side');
  const pad = padX(ruleBody('.crumbs.crumbs-tight button')) ?? base!;
  const BORDER = 2, ELLIPSIS = 11, CHEVRON = 12, TRAIL = 88; // "…" at 12.5 px; icon('chevronRight', 12)
  const more = 2 * pad + BORDER + ELLIPSIS;
  const folder = TRAIL - more - 2 * crumbsCss().gap - CHEVRON;
  const name = folder - 2 * pad - BORDER;
  assert.ok(name >= 28, `the folder's name has ${name} px of the ${TRAIL} px trail — four characters at this file's 7 px a character need 28`);
  assert.ok(more >= 24, `and "…" stays a ${more} px target, at least 24 px wide`);

  // Its whole path on hover: on the trail, as the folder's own button takes no pointer events.
  const current = ruleBody('.crumbs button[aria-current="true"]');
  assert.match(current ?? '', /pointer-events:\s*none/, 'control: the folder on screen takes no pointer events');
  assert.doesNotMatch(ruleBody('.crumbs.crumbs-tight button[aria-current="true"]') ?? '', /pointer-events/, 'control: nor does it when tight');
  const h = crumbsHarness();
  const host = makeHost(TRAIL) as ReturnType<typeof makeHost> & { title?: string };
  h.render(host, DEEP, h.onPick);
  assert.ok(host.cls.has('crumbs-tight'), 'control: tight at 88 px');
  assert.equal(host.title, DEEP, 'a pointer over the folder\'s name lands on the trail, whose tooltip is the whole path');
  host.clientWidth = 420;
  h.observers[0].cb();
  assert.ok(!host.cls.has('crumbs-tight'), 'control: at 420 px the trail is not tight');
  assert.equal(host.title, '', 'and the trail\'s tooltip goes with the mark: each crumb has its own');
});

/* ══════════════ QA-6 review MEDIUM-1 — the "…" menu works from the keyboard ══════════════ */

/** A narrow trail, so only "…" and the folder on screen are left: the harness, and the "…" crumb. */
function foldedTrail() {
  const h = crumbsHarness();
  const host = makeHost(150);
  h.render(host, DEEP, h.onPick);
  const more = host.buttons.find((b) => b.more);
  assert.ok(more, 'the trail folded into "…"');
  return { h, host, more: more! };
}

test('MEDIUM-1: Enter on "…" is the button\'s own press — it opens the menu instead of drilling the map', () => {
  const { h, more } = foldedTrail();
  const onMap = keyEv('Enter', fakeDoc.body);
  h.keydown(onMap);
  assert.equal(h.map.drill, 1, 'control: Enter with nothing focused drills the map, as before');
  assert.equal(onMap.defaultPrevented, true);
  more.focus();
  const onMore = keyEv('Enter');
  h.keydown(onMore);
  assert.equal(h.map.drill, 1, 'Enter on "…" no longer drills the map behind it');
  assert.equal(onMore.defaultPrevented, false, 'and the button\'s click — what Enter on a button is — is not cancelled');
  more.click(); // the press Enter makes
  assert.equal(h.menu.style.display, 'block', 'the menu opens');
  assert.equal(fakeDoc.active, h.menu.buttons[0], 'with its first folder focused');
});

test('MEDIUM-1: inside the menu the arrows, Home and End move between its folders, and the map behind it stays put', () => {
  const { h, more } = foldedTrail();
  more.click();
  const items = h.menu.buttons;
  assert.equal(items.length, 5);
  // Focus moves with preventScroll, so in a menu that scrolls (LOW-4) every
  // step has to bring its entry into view itself (QA-6b review F1.9).
  const scrolls = () => items.reduce((n, b) => n + b.scrolls.length, 0);
  /**
   * Press `key` and say whether the menu `taken` it: a key the menu takes is
   * cancelled — left to the browser, Home and End scroll the list or the page
   * after focus has moved, and a page scroll closes the menu — and brings the
   * entry it focused into view; a key it leaves is neither (QA-6b review F2.3).
   */
  const press = (key: string, taken: boolean) => {
    const before = scrolls();
    const ev = keyEv(key);
    h.keydown(ev);
    assert.equal(ev.defaultPrevented, taken, taken ? `the menu takes ${key}: the browser does not act on it too` : `${key} is not cancelled`);
    if (taken) {
      assert.equal(scrolls(), before + 1, `${key} scrolls one entry into view`);
      assert.deepEqual((fakeDoc.active as FakeBtn).scrolls.at(-1), { block: 'nearest' }, `${key}: the entry it focused, the least scroll that shows it`);
    } else {
      assert.equal(scrolls(), before, `${key} scrolls nothing`);
    }
    return ev;
  };
  press('ArrowDown', true);
  assert.equal(fakeDoc.active, items[1], 'ArrowDown: the next folder');
  press('ArrowDown', true); press('ArrowDown', true); press('ArrowDown', true);
  assert.equal(fakeDoc.active, items[4]);
  press('ArrowDown', true);
  assert.equal(fakeDoc.active, items[0], 'and wraps from the last to the first');
  press('ArrowUp', true);
  assert.equal(fakeDoc.active, items[4], 'ArrowUp wraps the other way');
  press('Home', true);
  assert.equal(fakeDoc.active, items[0], 'Home: the first');
  press('End', true);
  assert.equal(fakeDoc.active, items[4], 'End: the last');
  assert.equal(scrolls(), 8, 'one scroll for each of the eight steps');
  // Not the menu's, and not the map's either while it is open: the map's would cancel them.
  for (const key of ['h', 'j', 'k', 'l', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Enter']) press(key, false);
  assert.deepEqual(h.map, { drill: 0, up: 0, move: 0 }, 'no key pressed in the menu moves, climbs or drills the map');
  // A menu a right-click opened has not taken focus: the first arrow takes it in.
  fakeDoc.active = fakeDoc.body;
  press('ArrowDown', true);
  assert.equal(fakeDoc.active, items[0], 'ArrowDown from outside the menu lands on its first folder');
  fakeDoc.active = fakeDoc.body;
  press('ArrowUp', true);
  assert.equal(fakeDoc.active, items[4], 'ArrowUp from outside it, on its last');
  fakeDoc.active = fakeDoc.body;
  press('End', true);
  assert.equal(fakeDoc.active, items[4], 'End from outside it, on its last');
  fakeDoc.active = fakeDoc.body;
  press('j', false);
  assert.equal(h.map.move, 0, 'and while it is open the map keys wait, wherever focus is');
});

test('MEDIUM-1: Escape, or a folder picked, closes the menu and gives focus back to "…"', () => {
  const { h, host, more } = foldedTrail();
  more.click();
  h.keydown(keyEv('ArrowDown'));
  h.keydown(keyEv('Escape'));
  assert.equal(h.menu.style.display, 'none', 'Escape closes it');
  assert.equal(fakeDoc.active, more, 'and focus is back on "…", not on <body>');
  assert.deepEqual(h.picked, [], 'nothing was picked');
  more.click();
  h.keydown(keyEv('End'));
  const last = fakeDoc.active as FakeBtn;
  const enter = keyEv('Enter');
  h.keydown(enter);
  assert.equal(enter.defaultPrevented, false, 'Enter on a folder in the menu is that folder\'s press');
  assert.equal(h.map.drill, 0);
  last.click(); // the press Enter makes
  assert.deepEqual(h.picked, [last.path], 'it opens the folder picked');
  assert.equal(h.focusAtPick[0], more, 'focus was on "…" before the map moved');
  assert.equal(h.menu.style.display, 'none');
  // The load redraws the trail: focus stays in it rather than dropping to <body>.
  h.render(host, last.path as string, h.onPick);
  assert.ok(host.contains(fakeDoc.active), 'after the crumbs are redrawn, focus is still on a crumb');
});

test('MEDIUM-1: a trail redrawn while its "…" menu is open closes the menu, and focus goes to the new "…" (QA-6b review F1.3, F1.5, F1.12)', () => {
  // A resize, ⌘B or a scan landing redraws the trail under an open menu. The
  // menu stayed up, bound to the old "…": the new one said aria-expanded
  // false over an open menu, a press of it re-opened instead of closing, and
  // Escape focused a button no longer on the page — focus fell to <body>.
  const { h, host, more } = foldedTrail();
  more.click();
  assert.equal(h.menu.buttons.includes(fakeDoc.active as FakeBtn), true, 'control: focus is in the open menu');
  host.clientWidth = 140; // the toolbar narrows
  h.observers[0].cb();
  const again = host.buttons.find((b) => b.more)!;
  assert.ok(again && again !== more, 'control: the redraw replaced "…"');
  assert.equal(h.menu.style.display, 'none', 'the menu of the old trail closes with it');
  assert.equal(fakeDoc.active, again, 'focus that was in it goes to the new "…", not to <body>');
  assert.equal(again.getAttribute('aria-expanded'), 'false', 'which says, truthfully, that its menu is closed');
  again.click();
  assert.equal(h.menu.style.display, 'block', 'one press of the new "…" opens its menu');
  assert.equal(again.getAttribute('aria-expanded'), 'true');
  again.click();
  assert.equal(h.menu.style.display, 'none', 'and the next closes it: the toggle follows the button on screen');
  again.click();
  h.keydown(keyEv('Escape'));
  assert.equal(fakeDoc.active, again, 'Escape gives focus back to the "…" on screen');
  // A load landing on another folder redraws the trail the same way.
  again.click();
  h.render(host, DEEP.slice(0, DEEP.lastIndexOf('/')), h.onPick);
  assert.equal(h.menu.style.display, 'none', 'a new folder\'s trail closes the menu of the old one');
  assert.equal(fakeDoc.active, host.buttons.find((b) => b.more), 'and focus is on its "…"');
  assert.deepEqual(h.picked, [], 'nothing was picked');
});

test('MEDIUM-1: another trail redrawn leaves an open "…" menu alone (QA-6b review F1.3)', () => {
  const { h, more } = foldedTrail();
  more.click();
  const at = fakeDoc.active;
  h.render(makeHost(1400), '/System/Library', h.onPick); // the Grid's or the City's trail
  assert.equal(h.menu.style.display, 'block', 'the menu belongs to the other trail and stays open');
  assert.equal(fakeDoc.active, at, 'with focus where it was');
  assert.equal(more.getAttribute('aria-expanded'), 'true');
});

test('MEDIUM-1: focus on "…" goes to the folder on screen when the redrawn trail has no "…" (QA-6b review F1.10)', () => {
  // Widened, or a shallow folder picked, the trail no longer folds: the
  // fallback is the only place focus can go that is not <body>.
  for (const menuOpen of [false, true]) {
    const { h, host, more } = foldedTrail();
    if (menuOpen) more.click(); else more.focus();
    host.clientWidth = 1400;
    h.observers[0].cb();
    assert.equal(host.buttons.some((b) => b.more), false, 'control: wide, the trail has no "…"');
    const here = host.buttons[host.buttons.length - 1];
    assert.equal(here.current, true, 'control: the last crumb is the folder on screen');
    assert.equal(fakeDoc.active, here, `focus ${menuOpen ? 'in the open menu' : 'on "…"'} goes to the folder on screen`);
    assert.equal(h.menu.style.display, menuOpen ? 'none' : undefined, 'and an open menu is closed');
  }
});

test('MEDIUM-1: a crumb a pointer pressed does not hold focus in the redrawn trail — Enter goes back to the map', () => {
  // Focus is kept across the redraw for "…" (the keyboard's way through the
  // menu). A click leaves focus on the crumb it pressed; keeping it there
  // would have made the next Enter reload that folder instead of reaching the map.
  const h = crumbsHarness();
  const host = makeHost(1400); // wide: every crumb is drawn, no "…"
  h.render(host, DEEP, h.onPick);
  const lib = host.buttons.find((b) => b.path === '/System/Library')!;
  lib.focus();
  lib.click();
  h.render(host, '/System/Library', h.onPick); // the load redraws the trail
  assert.equal(host.contains(fakeDoc.active), false, 'focus was not put back on a crumb');
});

test('C23: the trail redrawn under a pressed crumb hands focus to the view\'s map, never to <body>', () => {
  // The load the crumb asked for redraws the trail and the pressed crumb goes
  // with it: focus fell to <body> in the Treemap, the Grid and Disk City (hunt C23).
  const h = crumbsHarness();
  const host = makeHost(1400);
  const toMap = () => h.canvas;
  h.render(host, DEEP, h.onPick, toMap);
  const lib = host.buttons.find((b) => b.path === '/System/Library')!;
  lib.focus();
  lib.click();
  h.render(host, '/System/Library', h.onPick, toMap);
  assert.equal(fakeDoc.active, h.canvas, 'the map the next Enter belongs to');
  // Focus elsewhere is not taken.
  const elsewhere = fakeEl('INPUT');
  elsewhere.focus();
  h.render(host, '/System', h.onPick, toMap);
  assert.equal(fakeDoc.active, elsewhere, 'a redraw takes focus only from a crumb it removed');
});

test('C23: a crumb tabbed to keeps focus when its own trail is re-fitted to a new width', () => {
  const h = crumbsHarness();
  const host = makeHost(1400);
  h.render(host, DEEP, h.onPick, () => h.canvas);
  host.buttons.find((b) => b.path === '/System/Library')!.focus();
  host.clientWidth = 1300; // still wide enough to draw every crumb
  h.observers[0].cb(); // the window resized: the same trail, re-fitted
  const again = host.buttons.find((b) => b.path === '/System/Library')!;
  assert.equal(fakeDoc.active, again, 'the same crumb, redrawn, holds focus — not <body>, not the map');
});

test('MEDIUM-1: Enter on a link, or on anything with a button or menu-item role, is that control\'s press — not the map\'s', () => {
  // tmMapKeyYields asks closest('button, a[href], [role="button"], [role="menuitem"]'):
  // each kind is tried as itself, not as a button (QA-6b review F1.9).
  const h = crumbsHarness();
  const plain = fakeEl('DIV');
  plain.focus();
  h.keydown(keyEv('Enter'));
  assert.equal(h.map.drill, 1, 'control: Enter on an element that is no control drills the map');
  for (const el of [fakeEl('A', { href: '/help' }), fakeEl('DIV', { role: 'button' }), fakeEl('DIV', { role: 'menuitem' })]) {
    el.focus();
    const ev = keyEv('Enter');
    h.keydown(ev);
    assert.equal(h.map.drill, 1, `Enter on ${el.tagName} ${JSON.stringify(el.attrs)} does not drill the map`);
    assert.equal(ev.defaultPrevented, false, 'and its own press is not cancelled');
  }
  const bare = fakeEl('A');
  bare.focus();
  h.keydown(keyEv('Enter'));
  assert.equal(h.map.drill, 2, 'an <a> with no href is no link: Enter on it is the map\'s');
});

test('MEDIUM-1: the map keys used from a button beside the map hand focus to the map, so Enter after j or k still drills', () => {
  // Enter on a focused button is now that button's press. A click leaves
  // focus on the button it pressed — a crumb, Refresh, a renderer segment —
  // and someone who then steers the map with j and k means Enter for the map.
  const { h, host } = foldedTrail();
  const crumb = host.buttons[host.buttons.length - 1];
  crumb.focus();
  h.keydown(keyEv('j'));
  assert.equal(h.map.move, 1, 'j moves the selection');
  assert.equal(fakeDoc.active, h.canvas, 'and the map, which j drives, takes focus');
  h.keydown(keyEv('Enter'));
  assert.equal(h.map.drill, 1, 'so Enter drills the selection rather than pressing the crumb');
  for (const [key, count] of [['k', 'move'], ['h', 'up'], ['l', 'drill']] as const) {
    crumb.focus();
    const before = h.map[count];
    h.keydown(keyEv(key));
    assert.equal(h.map[count], before + 1, `${key} acts on the map`);
    assert.equal(fakeDoc.active, h.canvas, `${key} from a button hands focus to the map`);
  }
  fakeDoc.active = fakeDoc.body;
  h.keydown(keyEv('j'));
  assert.equal(fakeDoc.active, fakeDoc.body, 'with nothing focused, focus is left where it is');
});

test('MEDIUM-1: Tab out of the menu closes it, and the Tab goes on from "…"', () => {
  const { h, more } = foldedTrail();
  more.click();
  h.keydown(keyEv('ArrowDown'));
  const tab = keyEv('Tab');
  h.keydown(tab);
  assert.equal(h.menu.style.display, 'none', 'a menu Tabbed out of does not stay open, holding the map keys');
  assert.equal(fakeDoc.active, more, 'focus is back on "…"');
  assert.equal(tab.defaultPrevented, false, 'and the Tab itself still moves focus on, from there');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
});

test('MEDIUM-1: in the Grid, Backspace and Delete wait while the "…" menu is open — the Grid neither climbs nor opens a Trash sheet under it (QA-6b review F2.6)', () => {
  // The Grid draws the same trail (#gridCrumbs), folded into the same "…"
  // menu. Its Backspace / Delete block had no open-menu guard: Backspace, the
  // natural "back" key in a menu, climbed the Grid behind it, and Delete
  // opened a Trash sheet for selected rows the menu has nothing to do with.
  const h = crumbsHarness({ view: 'grid', selection: ['/System/a.mov'] });
  const host = makeHost(150);
  h.render(host, DEEP, h.onPick);
  const more = host.buttons.find((b) => b.more)!;
  assert.ok(more, 'control: the Grid\'s trail folded into "…"');
  more.focus();
  h.keydown(keyEv('Backspace'));
  assert.equal(h.gridMoves.up, 1, 'control: with no menu open, Backspace climbs the Grid');
  h.keydown(keyEv('Delete'));
  assert.deepEqual(h.acts, ['trash'], 'control: and Delete asks to trash the selected rows');
  h.acts.length = 0;
  more.click();
  assert.ok(h.menu.buttons.includes(fakeDoc.active as FakeBtn), 'control: focus is in the open menu');
  const back = keyEv('Backspace');
  h.keydown(back);
  assert.equal(h.gridMoves.up, 1, 'Backspace in the open menu does not climb the Grid under it');
  assert.equal(back.defaultPrevented, false, 'nor is it cancelled for the Grid');
  const del = keyEv('Delete');
  h.keydown(del);
  assert.deepEqual(h.acts, [], 'Delete in the open menu opens no Trash sheet for the selected rows');
  assert.equal(del.defaultPrevented, false);
  assert.equal(h.menu.style.display, 'block', 'the menu is still open');
  fakeDoc.active = fakeDoc.body; // wherever focus is, while the menu is up
  h.keydown(keyEv('Backspace'));
  h.keydown(keyEv('Delete'));
  assert.equal(h.gridMoves.up, 1, 'with focus elsewhere, Backspace still waits for the menu');
  assert.deepEqual(h.acts, [], 'and Delete');
  more.focus();
  h.keydown(keyEv('Escape'));
  assert.equal(h.menu.style.display, 'none', 'Escape closes the menu');
  h.keydown(keyEv('Backspace'));
  assert.equal(h.gridMoves.up, 2, 'and the keys are the Grid\'s again');
});

/** A key pressed with ⌘ (or Ctrl), as the page reads it: metaKey || ctrlKey. */
const modKeyEv = (key: string, ctrl = false): KeyEv => Object.assign(keyEv(key), ctrl ? { ctrlKey: true } : { metaKey: true });

test('D03: ⌘⌫ and ⌘Delete ask to trash only a selection the view on screen shows — never the Grid\'s, from another view', () => {
  // QA third pass D03: Grid › Mail, ⌘-click Mailbox 23.mbox, then the
  // Dashboard — and ⌘⌫ there opened "Move Mailbox 23.mbox (1.7 MB) to the
  // Trash?" for a selection the Dashboard does not show. Plain Delete and
  // Escape were already the Grid's alone; the ⌘ variant answered in any view.
  for (const view of ['dashboard', 'treemap', 'autopilot', 'duplicates']) {
    const h = crumbsHarness({ view, selection: ['/System/a.mov'] });
    for (const [key, ctrl] of [['Backspace', false], ['Delete', false], ['Backspace', true], ['Delete', true]] as const) {
      const ev = modKeyEv(key, ctrl);
      h.keydown(ev);
      assert.deepEqual(h.acts, [], `${view}: ${ctrl ? 'Ctrl' : '⌘'}+${key} opens no Trash sheet for the Grid's hidden selection`);
      assert.equal(ev.defaultPrevented, false, `${view}: nor is the key taken from anything else`);
    }
  }
  // Control: in the Grid, the selection it shows is what the keys trash.
  const g = crumbsHarness({ view: 'grid', selection: ['/System/a.mov'] });
  const del = modKeyEv('Backspace');
  g.keydown(del);
  assert.deepEqual(g.acts, ['trash'], 'control: in the Grid, ⌘⌫ asks to trash its selection');
  assert.equal(del.defaultPrevented, true);
  g.keydown(modKeyEv('Delete', true));
  assert.deepEqual(g.acts, ['trash', 'trash'], 'control: and Ctrl+Delete');
  // Nothing selected in the Grid: nothing to ask about.
  const none = crumbsHarness({ view: 'grid' });
  none.keydown(modKeyEv('Backspace'));
  assert.deepEqual(none.acts, [], 'an empty selection asks nothing');
});

test('D03: ⌘⌫ waits while the "…" menu is open, as plain Delete does — no Trash sheet for the selected tiles under it', () => {
  // The audit of every shortcut behind D03: plain Delete had learnt the
  // open-menu guard (QA-6b review F2.6); its ⌘ variant had not.
  const h = crumbsHarness({ view: 'grid', selection: ['/System/a.mov'] });
  const host = makeHost(150);
  h.render(host, DEEP, h.onPick);
  const more = host.buttons.find((b) => b.more)!;
  more.focus();
  more.click();
  assert.equal(h.menu.style.display, 'block', 'control: the menu is open');
  const del = modKeyEv('Backspace');
  h.keydown(del);
  assert.deepEqual(h.acts, [], '⌘⌫ in the open menu opens no Trash sheet');
  assert.equal(del.defaultPrevented, false);
  h.keydown(keyEv('Escape'));
  h.keydown(modKeyEv('Backspace'));
  assert.deepEqual(h.acts, ['trash'], 'control: with the menu closed, ⌘⌫ is the Grid\'s again');
});

/** A row of the Keyboard shortcuts sheet: the section it is under, its keys (a modifier as "mod") and what it says they do. */
type SheetRow = { section: string; keys: string[]; says: string };
/** The Keyboard shortcuts sheet as the built page draws it, row by row. */
function shortcutSheetRows(): SheetRow[] {
  const at = INDEX.indexOf('id="shortcutsModal"');
  assert.notEqual(at, -1, 'the Keyboard shortcuts sheet is in the page');
  const end = INDEX.indexOf('<!-- ═══', at);
  assert.notEqual(end, -1, 'and it ends before the next block of markup');
  const rows: SheetRow[] = [];
  let section = '';
  for (const line of INDEX.slice(at, end).split('\n')) {
    const sec = /<div class="kbd-sec">([^<]*)<\/div>/.exec(line);
    if (sec) { section = unesc(sec[1]); continue; }
    const row = /^\s*<div>((?:<kbd[^>]*>[^<]*<\/kbd>)+)<\/div><div>(.*)<\/div>\s*$/.exec(line);
    if (!row) continue;
    const keys = [...row[1].matchAll(/<kbd(?: data-key="(\w+)")?>([^<]*)<\/kbd>/g)].map((k) => k[1] ?? unesc(k[2]));
    rows.push({ section, keys, says: unesc(row[2].replace(/<[^>]+>/g, '')) });
  }
  assert.ok(rows.length >= 15, `the sheet's rows were read (${rows.length})`);
  return rows;
}

test('the shortcuts sheet says where each Trash key works, and the page\'s keydown handler agrees row by row (review F1.1 of D03)', () => {
  // D03 made ⌘⌫ the Grid's alone, and the sheet still listed it under
  // "Anywhere" as "Move the selection to Trash" — a promise the Dashboard,
  // the Treemap, Duplicates and Autopilot no longer keep — while the Grid's
  // own section did not name it at all.
  const VIEWS = ['dashboard', 'treemap', 'grid', 'autopilot', 'duplicates'];
  const sectionViews: Record<string, string[]> = { 'Treemap & Sunburst': ['treemap'], Grid: ['grid'], Anywhere: VIEWS };
  /** The key event a row's keys name: a modifier chord, or each key alone. */
  const KEY: Record<string, string> = { '⌫': 'Backspace', Del: 'Delete' };
  const eventsOf = (keys: string[]): Array<{ name: string; ev: () => KeyEv }> => (keys[0] === 'mod'
    ? [{ name: `⌘${keys[1]}`, ev: () => modKeyEv(KEY[keys[1]] ?? keys[1]) }]
    : keys.map((k) => ({ name: k, ev: () => keyEv(KEY[k] ?? k) })));
  /** The views in which `ev` opens a Trash sheet, with a Grid selection and a Treemap cell both selected. */
  const actsIn = (ev: () => KeyEv) => VIEWS.filter((view) => {
    const h = crumbsHarness({ view, selection: ['/System/a.mov'], kbSel: { path: '/System/b.mov', name: 'b.mov', type: 'file' } });
    h.keydown(ev());
    return h.acts.includes('trash');
  });
  const trashRows = shortcutSheetRows().filter((r) => /\bTrash\b/.test(r.says));
  for (const r of trashRows) {
    assert.ok(r.section in sectionViews, `"${r.section}" is a section this test knows the views of`);
    for (const { name, ev } of eventsOf(r.keys)) {
      const where = actsIn(ev);
      // The sheet's promise: wherever its section says, the key does what the row says.
      for (const view of sectionViews[r.section]) {
        assert.ok(where.includes(view), `${r.section} › ${name} "${r.says}": the key does nothing in ${view} (it acts in: ${where.join(', ') || 'no view'})`);
      }
      // And the other way: wherever the key trashes, a row under a section covering that view says so.
      for (const view of where) {
        assert.ok(trashRows.some((o) => sectionViews[o.section]?.includes(view) && eventsOf(o.keys).some((e) => e.name === name)),
          `${name} trashes in ${view}, and no row of the sheet says so there`);
      }
    }
  }
  // The Grid's ⌘⌫ is on the sheet at all: a row that left it out would pass the loop above by naming nothing.
  assert.ok(trashRows.some((r) => r.keys.join(' ') === 'mod ⌫'), `the sheet names ⌘⌫, which trashes the Grid's selection: ${trashRows.map((r) => `${r.section} › ${r.keys.join('')}`).join('; ')}`);
});

test('MEDIUM-1: Tab closes the menu wherever focus is — still on Export, or on the map a right-click left it on (QA-6b review F1.1)', () => {
  // Export and a right-click open the menu without moving focus into it, and
  // Tab closed it only from inside: it stayed up, and while it was up the map
  // keys did nothing — only Escape or a click got out.
  const h = crumbsHarness();
  const btn = h.exportBtn();
  btn.focus();
  btn.click();
  assert.equal(fakeDoc.active, btn, 'control: Export keeps focus while its menu opens');
  const tab = keyEv('Tab');
  h.keydown(tab);
  assert.equal(h.menu.style.display, 'none', 'Tab from Export closes its menu');
  assert.equal(btn.getAttribute('aria-expanded'), 'false', 'and Export says so');
  assert.equal(tab.defaultPrevented, false, 'the Tab itself goes on');
  assert.equal(fakeDoc.active, btn, 'from Export, where focus was');
  h.canvas.focus(); // where the Tab took it
  h.keydown(keyEv('j'));
  assert.equal(h.map.move, 1, 'with the menu gone, the map keys are the map\'s again');
  h.showCtxMenu(40, 50, { path: '/System/a.mov', name: 'a.mov', type: 'file' });
  assert.equal(fakeDoc.active, h.canvas, 'control: a right-click menu does not take focus');
  h.keydown(keyEv('Tab'));
  assert.equal(h.menu.style.display, 'none', 'Tab from the map closes a right-click menu too');
  assert.equal(fakeDoc.active, h.canvas, 'and leaves focus for the Tab to move');
});

test('MEDIUM-1: a pick from Export or from a right-click menu puts focus back where it was, not on <body> (QA-6b review F1.8)', () => {
  // Only the "…" menu's pick gave focus back; Export's and the right-click
  // menu's closed the menu around the focused entry, and focus fell to <body>.
  const h = crumbsHarness();
  const btn = h.exportBtn();
  btn.focus();
  btn.click();
  h.keydown(keyEv('ArrowDown'));
  const png = fakeDoc.active as FakeBtn;
  assert.equal(png.dataset.exp, 'png', 'control: the PNG entry has focus');
  png.click(); // the press Enter on it makes
  assert.deepEqual(h.acts, ['png'], 'it exports the PNG');
  assert.equal(h.actFocus.at(-1), btn, 'focus was back on Export before the export ran, not on the entry being hidden');
  assert.equal(h.menu.style.display, 'none');
  assert.equal(fakeDoc.active, btn, 'and focus is back on Export');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  // Every entry the right-click menu builds — on disk, inside an archive, in
  // the cloud — Quick Look and the Trash sheet among them: each remembers
  // what had focus when it opened and gives focus back there when it closes.
  // Run before focus left the menu, that is an entry about to be hidden, and
  // closing the sheet drops focus on <body> (QA-6b review F2.4).
  const cases: Array<[unknown, string, string]> = [
    [{ path: '/System/a.mov', name: 'a.mov', type: 'file' }, 'open', 'open /System/a.mov'],
    [{ path: '/System/a.mov', name: 'a.mov', type: 'file' }, 'preview', 'preview'],
    [{ path: '/System/a.mov', name: 'a.mov', type: 'file' }, 'trash', 'trash'],
    [{ path: '/System/a.zip/b.txt', name: 'b.txt', type: 'file', virtual: true }, 'copy', 'copy /System/a.zip/b.txt'],
    [{ path: 'cloud://drive/c', name: 'c', type: 'file' }, 'copy', 'copy cloud://drive/c'],
    [{ path: 'cloud://drive/c', name: 'c', type: 'file' }, 'cloudtrash', 'trash'],
  ];
  for (const [node, which, did] of cases) {
    const where = `${which} on ${(node as { path: string }).path}`;
    h.acts.length = 0;
    h.canvas.focus();
    h.showCtxMenu(40, 50, node);
    const entry = h.menu.buttons.find((b) => b.dataset.act === which)!;
    entry.focus(); // reached with the arrows
    entry.click();
    assert.deepEqual(h.acts, [did], `${which} did its job`);
    assert.equal(h.actFocus.at(-1), h.canvas, `${where} ran with focus already back on the map`);
    assert.equal(h.menu.style.display, 'none');
    assert.equal(fakeDoc.active, h.canvas, `after ${where}, focus is back on the map`);
  }
});

test('MEDIUM-1: "…" says whether its menu is open, the menu is named and made of menu items, and a second click closes it', () => {
  const { h, more } = foldedTrail();
  assert.equal(more.getAttribute('aria-haspopup'), 'menu');
  assert.equal(more.getAttribute('aria-expanded'), 'false', 'closed, and says so');
  more.click();
  assert.equal(more.getAttribute('aria-expanded'), 'true', 'open, and says so');
  assert.equal(h.menu.getAttribute('role'), 'menu', 'the container is a menu, as the markup draws it — the parent its name and its menu items need (QA-6b review F2.5)');
  assert.match(h.menu.getAttribute('aria-label') || '', /folders above/i, 'the menu has an accessible name');
  assert.ok(h.menu.buttons.every((b) => b.getAttribute('role') === 'menuitem'), 'every entry is a menuitem');
  more.click();
  assert.equal(h.menu.style.display, 'none', 'a second click on "…" closes what the first opened');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
});

test('MEDIUM-1: the click that opens a menu does not close it on its way up; a click outside the menu closes it, one inside does not (QA-6b review F2.2)', () => {
  // The page's document click handler closes #ctxMenu on any click outside
  // it — and the click on "…" or Export that opened it is outside it too.
  // Each opener stops its click short of the document, or the menu would
  // close in the same click that opened it, and neither would show a menu.
  const { h, more } = foldedTrail();
  more.click();
  assert.equal(h.menu.style.display, 'block', '"…" opens its menu, and the click that did it does not close it on the way up');
  h.clickOn(h.menu.list);
  assert.equal(h.menu.style.display, 'block', 'a click inside the menu, between its entries, leaves it open');
  h.clickOn(h.canvas);
  assert.equal(h.menu.style.display, 'none', 'a click on the map closes it');
  assert.equal(more.getAttribute('aria-expanded'), 'false', 'and "…" says so');
  const btn = h.exportBtn();
  btn.click();
  assert.equal(h.menu.style.display, 'block', 'Export opens its menu, its click stopped short of the document too');
  h.clickOn(fakeDoc.body);
  assert.equal(h.menu.style.display, 'none', 'a click anywhere else on the page closes it');
  assert.equal(btn.getAttribute('aria-expanded'), 'false', 'and Export says so');
});

test('MEDIUM-1: the right-click menu is named and made of menu items too', () => {
  const menu = fakeMenu();
  const { show, keydown } = load<{ show: (x: number, y: number, node: unknown) => void; keydown: (e: KeyEv) => boolean }>(
    ['showCtxMenu', 'ctxTarget', ...CTX_MENU_DECLS], {
    $: (id: string) => { assert.equal(id, 'ctxMenu'); return menu; },
    document: fakeDoc,
    window: { innerWidth: 1440, innerHeight: 900 },
    state: { system: { platform: 'darwin' } },
    icon: () => '<svg></svg>',
    escapeHtml: esc,
    cartHas: () => false, budgetFor: () => null, noteFor: () => null,
  }, '{ show: showCtxMenu, keydown: ctxMenuKeydown }');
  fakeDoc.active = fakeDoc.body;
  show(40, 50, { path: '/r/movie.mov', name: 'movie.mov', type: 'file' });
  assert.equal(menu.style.display, 'block');
  assert.equal(menu.getAttribute('role'), 'menu', 'a menu, as the markup draws it');
  assert.equal(menu.getAttribute('aria-label'), 'Actions for movie.mov');
  assert.ok(menu.buttons.length > 3 && menu.buttons.every((b) => b.getAttribute('role') === 'menuitem'), 'every entry is a menuitem');
  assert.ok(menu.divs.length >= 1, 'control: the menu has a divider, before Move to Trash');
  assert.ok(menu.divs.every((d) => d.getAttribute('role') === 'separator'), 'and every divider is a separator to assistive technology');
  // A text field keeps its own arrows while a right-click menu is up.
  fakeDoc.active = { tagName: 'INPUT' };
  const inField = keyEv('ArrowDown');
  assert.equal(keydown(inField), false, 'ArrowDown in a text field is the field\'s');
  assert.equal(inField.defaultPrevented, false);
  // An entry that cannot be used is not stepped onto.
  fakeDoc.active = fakeDoc.body;
  show(40, 50, { path: '/r/a.zip/inner.txt', name: 'inner.txt', type: 'file', virtual: true });
  assert.equal(menu.buttons.length, 2, 'Copy path, and the disabled note about the archive');
  keydown(keyEv('ArrowDown'));
  assert.equal(fakeDoc.active, menu.buttons[0]);
  keydown(keyEv('ArrowDown'));
  assert.equal(fakeDoc.active, menu.buttons[0], 'the disabled entry is skipped');
  keydown(keyEv('End'));
  assert.equal(fakeDoc.active, menu.buttons[0], 'End too');
});

test('MEDIUM-1: Export says it opens a menu and whether it is open, and Escape gives focus back to it (QA-6b review F1.7)', () => {
  // Driven through Export's own click listener: a regex over its source stayed
  // green with the opener left out, and nothing read the button's markup.
  const h = crumbsHarness();
  const btn = h.exportBtn();
  assert.equal(btn.getAttribute('aria-haspopup'), 'menu', 'the markup says Export opens a menu');
  assert.equal(btn.getAttribute('aria-expanded'), 'false', 'and that it is closed');
  btn.focus();
  const enter = keyEv('Enter');
  h.keydown(enter);
  assert.equal(enter.defaultPrevented, false, 'Enter on Export is Export\'s press');
  assert.equal(h.map.drill, 0);
  btn.click(); // the press Enter makes — it bubbles to the page's document click handler
  assert.equal(h.menu.style.display, 'block', 'the menu opens');
  assert.equal(btn.getAttribute('aria-expanded'), 'true', 'and Export says it is open');
  assert.equal(h.menu.getAttribute('role'), 'menu', 'a menu, as the markup draws it');
  assert.equal(h.menu.getAttribute('aria-label'), 'Export the map', 'the menu is named');
  assert.deepEqual(h.menu.buttons.map((b) => b.dataset.exp), ['png', 'svg', 'csv-files', 'csv-folders', 'xlsx-files', 'xlsx-folders', 'pdf'],
    'the map\'s two image formats, and the reports a finished scan offers');
  assert.ok(h.menu.buttons.every((b) => b.getAttribute('role') === 'menuitem'), 'as menu items');
  h.keydown(keyEv('ArrowDown'));
  assert.equal(fakeDoc.active, h.menu.buttons[0], 'ArrowDown from Export goes into the menu');
  h.keydown(keyEv('Escape'));
  assert.equal(h.menu.style.display, 'none', 'Escape closes it');
  assert.equal(fakeDoc.active, btn, 'and focus is back on Export, not on <body>');
  assert.equal(btn.getAttribute('aria-expanded'), 'false', 'which says the menu is closed');
  assert.deepEqual(h.acts, [], 'nothing was exported');
});

test('MEDIUM-1: Export is a toggle, as its aria-expanded says — a second press closes the menu the first opened (QA-6b review F3.3)', () => {
  // "…" closed on a second press; Export rebuilt its menu and stayed
  // aria-expanded="true". Its click stops short of the document handler that
  // closes the menu on a click outside it, and ctxMenuShow leaves an opener's
  // aria-expanded alone when that opener shows the menu again — so only
  // Escape, Tab or a click elsewhere could close it.
  const { h, more } = foldedTrail();
  const btn = h.exportBtn();
  btn.focus();
  btn.click();
  assert.equal(h.menu.style.display, 'block', 'control: the first press opens the menu');
  assert.equal(btn.getAttribute('aria-expanded'), 'true', 'control: and Export says so');
  btn.click(); // a click, or Enter or Space with focus still on Export
  assert.equal(h.menu.style.display, 'none', 'the second press closes it');
  assert.equal(btn.getAttribute('aria-expanded'), 'false', 'and Export says so');
  assert.equal(fakeDoc.active, btn, 'focus stays on Export');
  btn.click();
  assert.equal(h.menu.style.display, 'block', 'a third press opens it again');
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  // A pointer lands on Export's icon as often as on its label: the click's
  // target is then the svg, and only its currentTarget is the button the menu
  // was opened from (final review F1.3).
  btn.pressIcon();
  assert.equal(h.menu.style.display, 'none', 'a press on Export\'s icon closes the menu Export opened');
  assert.equal(btn.getAttribute('aria-expanded'), 'false', 'and Export says so');
  btn.pressIcon();
  assert.equal(h.menu.style.display, 'block', 'and the next press on it opens the menu again');
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(h.acts, [], 'nothing was exported along the way');
  // A menu another control opened is not Export's to close: a press of Export
  // shows Export's own menu in its place.
  btn.click();
  more.click();
  assert.equal(more.getAttribute('aria-expanded'), 'true', 'control: "…" has the menu now');
  btn.click();
  assert.equal(h.menu.style.display, 'block', 'Export, pressed over the "…" menu, opens its own');
  assert.equal(h.menu.getAttribute('aria-label'), 'Export the map', 'in place of the folders');
  assert.equal(btn.getAttribute('aria-expanded'), 'true', 'Export says it is open');
  assert.equal(more.getAttribute('aria-expanded'), 'false', 'and "…" that it is not');
  h.showCtxMenu(40, 50, { path: '/System/a.mov', name: 'a.mov', type: 'file' });
  assert.equal(btn.getAttribute('aria-expanded'), 'false', 'control: a right-click menu took it over');
  btn.click();
  assert.equal(h.menu.getAttribute('aria-label'), 'Export the map', 'and Export, pressed over a right-click menu, opens its own too');
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
});

/* ══════════════ QA-6 review LOW-4 — #ctxMenu fits the window ══════════════ */

test('LOW-4: a menu taller than the window opens at its top edge, never above it', () => {
  // ≥ ~25 folded ancestors at 900 px: top = min(36, 900 − height − 8) went negative,
  // and the first folders — the root among them — were off the top of the window.
  const { h, more } = foldedTrail();
  h.menu.offsetHeight = 1200;
  more.click();
  assert.equal(h.menu.style.top, '8px', 'pinned 8 px below the top of the window');
  const narrow = load<(menu: FakeMenu, o: unknown) => void>(CTX_MENU_DECLS, {
    document: fakeDoc, window: { innerWidth: 200, innerHeight: 900 },
  }, 'ctxMenuShow');
  const m = fakeMenu();
  narrow(m, { label: 'x', html: '', x: 150, y: 20 });
  assert.equal(m.style.left, '8px', 'and never off the left edge of a window narrower than the menu');
});

/** A CSS rule of the built page, from its selector to its closing brace. */
function cssRule(selector: string): string {
  const at = INDEX.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `the ${selector} rule is in the built page`);
  return INDEX.slice(at, INDEX.indexOf('}', at));
}

test('LOW-4: the menu\'s entries scroll inside a short window, in a list inside the panel — the frosted panel itself never scrolls (QA-6b review F1.11)', () => {
  // #ctxMenu is a lensed surface: its frost is .lg::before and its ring
  // .lg::after, both absolutely positioned against it. Made the scroller, it
  // scrolled them away with the entries — the bottom of a scrolled menu sat
  // on the bare map and the ring's edge crossed the list. The entries scroll
  // in .ctx-list instead, as a sheet's body scrolls inside .modal.
  assert.ok(INDEX.includes("['#ctxMenu',"), 'control: #ctxMenu is one of the liquid-glass engine\'s surfaces');
  const panel = cssRule('#ctxMenu');
  assert.doesNotMatch(panel, /overflow/, 'the panel is not a scroll container');
  assert.doesNotMatch(panel, /max-height/, 'nor capped: its list is');
  const pad = Number(/padding:\s*(\d+)px;/.exec(panel)![1]);
  const border = Number(/border:\s*(\d+)px solid/.exec(panel)![1]);
  const edge = Number(load<number>(['CTX_MENU_EDGE'], {}, 'CTX_MENU_EDGE'));
  const list = cssRule('#ctxMenu .ctx-list');
  const cap = 2 * edge + 2 * pad + 2 * border;
  assert.match(list, new RegExp(`max-height:\\s*calc\\(100vh - ${cap}px\\)`),
    `the list is no taller than the window less the edge kept above and below and the panel's padding and border (${cap} px)`);
  assert.match(list, /overflow-y:\s*auto/, 'and what does not fit scrolls there');
  // Every menu is written through ctxMenuShow, which puts its entries in that list.
  const { h, more } = foldedTrail();
  more.click();
  assert.ok(h.menu.list, `the "…" menu's entries are inside .ctx-list: ${h.menu.html.slice(0, 60)}`);
  assert.equal(h.menu.buttons.length, 5, 'all of them');
  h.showCtxMenu(40, 50, { path: '/System/a.mov', name: 'a.mov', type: 'file' });
  assert.ok(h.menu.list, 'and the right-click menu\'s');
  h.exportBtn().click();
  assert.ok(h.menu.list, 'and Export\'s');
});

/** Where a rule of the built page starts; it must be there exactly once, or "before" means nothing. */
function cssAt(selector: string): number {
  const at = INDEX.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `the ${selector} rule is in the built page`);
  assert.equal(INDEX.indexOf(`${selector} {`, at + 1), -1, `the ${selector} rule is in the built page once`);
  return at;
}

/* ── Colours, as a browser resolves them (final review F1.1, F1.2) ── */

type Rgba = [number, number, number, number];

/**
 * The design tokens one theme resolves: every top-level `:root { … }` block,
 * and for the light theme every `:root[data-theme="light"] { … }` block over
 * them. Each block is cut at its MATCHING brace — a one-line block such as
 * `:root { --side-w: 232px; }` otherwise runs on into the rules after it.
 */
function themeTokens(theme: 'dark' | 'light'): Map<string, string> {
  const blocks = (opener: string): string[] => {
    const out: string[] = [];
    for (let at = INDEX.indexOf(`\n${opener} {`); at !== -1; at = INDEX.indexOf(`\n${opener} {`, at + 1)) {
      const open = INDEX.indexOf('{', at);
      let depth = 0;
      for (let i = open; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}' && --depth === 0) { out.push(INDEX.slice(open + 1, i)); break; }
      }
    }
    return out;
  };
  const tokensIn = (list: string[]) => {
    const out = new Map<string, string>();
    for (const b of list) for (const m of b.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) if (!out.has(m[1])) out.set(m[1], m[2].trim());
    return out;
  };
  const out = tokensIn(blocks(':root'));
  assert.ok(out.size > 0, 'control: the page defines its design tokens on :root');
  if (theme === 'light') {
    const light = tokensIn(blocks(':root[data-theme="light"]'));
    assert.ok(light.size > 0, 'control: the page has a light theme');
    for (const [k, v] of light) out.set(k, v);
  }
  return out;
}

/** A colour value with every var() resolved against `tokens`; undefined when a token is not defined. */
function resolveColor(value: string, tokens: Map<string, string>): string | undefined {
  let v = value.trim();
  for (let hops = 0; hops < 10; hops++) {
    const m = /^var\((--[\w-]+)\)$/.exec(v);
    if (!m) return v;
    const next = tokens.get(m[1]);
    if (next === undefined) return undefined;
    v = next.trim();
  }
  return assert.fail(`${value} never resolves`);
}

/**
 * A CSS colour as [r, g, b, alpha 0-1], in every spelling a stylesheet may use
 * for one: `transparent`, #rgb, #rgba, #rrggbb, #rrggbbaa, and rgb()/rgba()
 * with commas or spaces, a `/ alpha`, and an alpha as a number or a percent.
 * Anything else fails the test: a spelling it cannot read is not one it may pass.
 */
function parseColor(value: string): Rgba {
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex && [3, 4, 6, 8].includes(hex[1].length)) {
    const h = hex[1].length <= 4 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(v);
  if (fn) {
    const parts = fn[1].trim().split(/\s*[,/]\s*|\s+/).filter(Boolean);
    if (parts.length === 3 || parts.length === 4) {
      const num = (s: string, scale: number) => (s.endsWith('%') ? (Number(s.slice(0, -1)) / 100) * scale : Number(s));
      const out: Rgba = [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255), parts.length === 4 ? num(parts[3], 1) : 1];
      if (out.every((x) => Number.isFinite(x))) return out;
    }
  }
  return assert.fail(`a colour this test can read: ${value}`);
}

/** `top` painted over an opaque `ground`. */
function over(top: Rgba, ground: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + ground[i] * (1 - a)).concat(1) as Rgba;
}

/** WCAG 2.x contrast ratio of two opaque colours. */
function contrastRatio(x: Rgba, y: Rgba): number {
  const lum = (c: Rgba) => {
    const lin = (u: number) => { const s = u / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  };
  const [hi, lo] = [lum(x), lum(y)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** The value a rule of the built page gives `prop` (a longhand, not a shorthand), or undefined. */
function declaredIn(selector: string, prop: string): string | undefined {
  if (!INDEX.includes(`${selector} {`)) return undefined;
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;}]+)`).exec(cssRule(selector).slice(selector.length));
  return m ? m[1].trim() : undefined;
}

/**
 * A control marked by focus inside the box that clips it (QA-6b review F2.1,
 * F3.1, F3.2): the ring is the page's own, moved inside by `selector` and
 * reaching no further past the control's edge than the `room` its clipping
 * box leaves, and the control's background turns to a tint the page defines.
 *
 * Checked as a browser resolves it, in both themes, not by spelling (final
 * review F1.2): a guard that looked for the words `transparent` and `none`
 * passed `outline-color: rgba(0,0,0,0)`, `outline-width: 0` and a ring the
 * colour of the tint, and a token of `#0A84FF00` or `rgb(10 132 255 / 0)`.
 * So the rule may set no outline of its own but its offset — the page's ring
 * stays the ring — and that ring and the tint are resolved to colours: the
 * ring opaque and standing 3:1 off the tint it is drawn on (WCAG 1.4.11), the
 * tint not see-through. A misspelled token computes to transparent, which is
 * no tint at all.
 */
function assertFocusMarkedInside(selector: string, room: number, what: string): void {
  const pageAt = INDEX.indexOf('\n:focus-visible {');
  assert.notEqual(pageAt, -1, 'control: the page draws one focus ring for every control');
  const page = INDEX.slice(pageAt, INDEX.indexOf('}', pageAt));
  const own = cssRule(selector).slice(selector.length);
  const outlines = [...own.matchAll(/(?:^|[;{\s])(outline(?:-[\w-]+)?)\s*:/g)].map((m) => m[1]);
  assert.deepEqual(outlines.filter((p) => p !== 'outline-offset'), [],
    `a focused ${what} keeps the page's ring: its rule moves it inside (outline-offset) and sets no outline of its own: ${own}`);
  const ring = /(?:^|[;{\s])outline:\s*(\d+(?:\.\d+)?)px\s+(solid|double|dashed|dotted)\s+([^;]+);/.exec(page);
  assert.ok(ring, `control: the page's ring is a drawn outline of a width, a style and a colour: ${page}`);
  const width = Number(ring![1]);
  assert.ok(width > 0, `control: the page's ring has a width (${width} px)`);
  const offsetDecl = /outline-offset:\s*(-?\d+(?:\.\d+)?)px/.exec(own);
  assert.ok(offsetDecl, `a focused ${what}'s rule moves the ring (outline-offset)`);
  const offset = Number(offsetDecl![1]);
  assert.ok(width + offset <= room,
    `the ring reaches ${width + offset} px past the ${what}'s edge, and the box that clips it leaves ${room} px before it clips`);
  const bg = /(?:^|[;{\s])background(?:-color)?:\s*([^;]+);/.exec(own);
  assert.ok(bg, `and focus is not shown by the ring alone: a focused ${what}'s background changes too`);
  const token = /^var\((--[\w-]+)\)$/.exec(bg![1].trim());
  assert.ok(token, `to one of the page's tints, not a colour of its own or none (${bg![1]})`);
  for (const theme of ['dark', 'light'] as const) {
    const tokens = themeTokens(theme);
    const value = resolveColor(bg![1], tokens);
    assert.ok(value !== undefined, `${token![1]} is a token the ${theme} theme defines — an undefined one computes to transparent`);
    const tint = parseColor(value!);
    assert.ok(tint[3] > 0, `${theme}: and ${token![1]} is a tint you can see, not a see-through one (${value})`);
    const ground = over(parseColor(resolveColor('var(--glass)', tokens)!), parseColor(resolveColor('var(--bg-1)', tokens)!));
    const tinted = over(tint, ground);
    const ringValue = resolveColor(ring![3], tokens);
    assert.ok(ringValue !== undefined, `${theme}: the page's ring colour (${ring![3]}) is defined`);
    const ringColor = parseColor(ringValue!);
    assert.equal(ringColor[3], 1, `${theme}: the page's ring is opaque (${ringValue})`);
    const ratio = contrastRatio(ringColor, tinted);
    assert.ok(ratio >= 3, `${theme}: and stands ${ratio.toFixed(2)}:1 off the ${what}'s tint it is drawn on — 3:1 is the bar`);
  }
}

test('LOW-4: a focused menu entry shows its whole focus ring inside the list that clips it, and more than the ring (QA-6b review F2.1, F3.1)', () => {
  // .ctx-list scrolls (overflow-y:auto makes overflow-x auto too) and its
  // entries are full width, so it clips right at their edges. The page's ring
  // is drawn outside the box it marks — 2 px wide, 2 px out — and was cut off
  // at every edge: a menu of one entry showed no focus at all, and arrowing
  // through a longer one, nothing said which entry was active (WCAG 2.4.7).
  const pad = /padding:\s*([^;]+);/.exec(cssRule('#ctxMenu .ctx-list'));
  const room = pad ? Math.min(...(pad[1].match(/-?\d+/g) || ['0']).map(Number)) : 0;
  assertFocusMarkedInside('#ctxMenu button:focus-visible', room, 'menu entry');
  // Both rules are (1,1,1), so the later wins where both apply. :hover must:
  // it sets white text with its accent fill, and a focus tint after it left
  // that white text on the pale tint of an entry the pointer was over.
  assert.match(cssRule('#ctxMenu button:hover'), /color:\s*#fff/, 'control: an entry under the pointer has white text on the accent');
  assert.ok(cssAt('#ctxMenu button:focus-visible') < cssAt('#ctxMenu button:hover'),
    'the focus rule comes before :hover, so an entry both focused and under the pointer keeps the accent behind its white text');
});

test('MEDIUM-1: a focused crumb shows its whole focus ring inside the trail that clips it, and more than the ring (QA-6b review F3.2)', () => {
  // .crumbs clips (overflow:hidden, and the fade's mask) and has no padding:
  // its 30 px crumbs fill it top to bottom, and the folder on screen sits flush
  // with its right edge. The page's ring, drawn 2 px outside the box it marks,
  // lost its top and bottom to that clip, so "…" — the keyboard's way into the
  // folded folders, and where focus comes back from their menu — was marked
  // by two thin side bars. The City's and the Grid's trails are the same rule.
  const host = cssRule('.crumbs');
  assert.match(host, /overflow:\s*hidden/, 'control: the trail clips what does not fit in it');
  assert.deepEqual([...INDEX.matchAll(/<div class="crumbs" id="(\w+)"><\/div>/g)].map((m) => m[1]), ['tmCrumbs', 'cityCrumbs', 'gridCrumbs'],
    'control: the map\'s, the City\'s and the Grid\'s trails are all .crumbs');
  const pad = /padding:\s*([^;]+);/.exec(host);
  const room = pad ? Math.min(...(pad[1].match(/-?\d+/g) || ['0']).map(Number)) : 0;
  assertFocusMarkedInside('.crumbs button:focus-visible', room, 'crumb');
  // With no "…", focus lands on the folder on screen (renderCrumbs). Its rule
  // gives it a background of its own at the same specificity, (0,2,1), so the
  // tint shows there only if the focus rule comes later.
  assert.match(cssRule('.crumbs button[aria-current="true"]'), /background:/, 'control: the folder on screen has a background of its own');
  assert.ok(cssAt('.crumbs button[aria-current="true"]') < cssAt('.crumbs button:focus-visible'),
    'the focus rule comes after it, so a focused folder on screen is tinted like any other focused crumb');
});

test('a focused or hovered crumb\'s name reads at 4.5:1 or better on its tint in both themes, and the folder on screen keeps its own colour when focused (final review F1.1)', () => {
  // The tint, --accent-soft, is the dark theme's #0A84FF at 16% in BOTH
  // themes. Under the light theme's darker --accent (#0069D6) a focused
  // crumb's 12.5 px name measured 4.20:1 on the card ground — below the 4.5:1
  // the tokens file sets for light text this size. Crumbs sit on the card
  // ground that file measures against: --glass over --bg-1.
  for (const theme of ['dark', 'light'] as const) {
    const tokens = themeTokens(theme);
    const paint = (selector: string, prop: string) => {
      const value = declaredIn(selector, prop);
      assert.ok(value, `${selector} sets its ${prop}`);
      const resolved = resolveColor(value!, tokens);
      assert.ok(resolved, `${value} is defined in the ${theme} theme`);
      return parseColor(resolved!);
    };
    const token = (name: string) => {
      const resolved = resolveColor(`var(${name})`, tokens);
      assert.ok(resolved, `${name} is defined in the ${theme} theme`);
      return parseColor(resolved!);
    };
    const ground = over(token('--glass'), token('--bg-1'));
    /** The text colour the last of `rules` (lowest precedence first) that sets one gives a crumb. */
    const textOf = (rules: string[]) => {
      const winner = [...rules].reverse().find((r) => declaredIn(r, 'color') !== undefined);
      assert.ok(winner, `a crumb has a text colour (${rules.join(' < ')})`);
      return { rule: winner!, rgba: paint(winner!, 'color') };
    };
    for (const [state, rules] of [
      ['focused', ['.crumbs button', '.crumbs button:focus-visible']],
      ['under the pointer', ['.crumbs button', '.crumbs button:hover']],
    ] as const) {
      const tint = over(paint(rules[1], 'background'), ground);
      const text = textOf([...rules]);
      const ratio = contrastRatio(over(text.rgba, tint), tint);
      assert.ok(ratio >= 4.5, `${theme}: a crumb ${state} shows its name at ${ratio.toFixed(2)}:1 on its tint (${text.rule}) — the bar is 4.5:1`);
    }
    // The folder on screen, focused (renderCrumbs puts focus there when there
    // is no "…"): precedence lowest first — its own rule and the focus rule tie
    // at (0,2,1) and the focus rule comes later (asserted above), and a rule
    // for both at once outranks them.
    const own = textOf(['.crumbs button', '.crumbs button[aria-current="true"]']);
    const focused = textOf(['.crumbs button', '.crumbs button[aria-current="true"]', '.crumbs button:focus-visible',
      '.crumbs button[aria-current="true"]:focus-visible']);
    assert.deepEqual(focused.rgba, own.rgba, `${theme}: the folder on screen keeps its own colour when focused, not a link's (${focused.rule})`);
    const tint = over(paint('.crumbs button:focus-visible', 'background'), ground);
    const ratio = contrastRatio(over(focused.rgba, tint), tint);
    assert.ok(ratio >= 4.5, `${theme}: and reads at ${ratio.toFixed(2)}:1 on the tint`);
  }
});

test('LOW-4: scrolling the menu\'s list does not close it; a scroll anywhere else does', () => {
  // The capture-phase scroll listener closed the menu on ANY scroll — its own list's included.
  const menu = fakeMenu();
  const page = load<{ show: (m: FakeMenu, o: unknown) => void; onScroll: (e: { target: unknown }) => void }>(['ctxMenuOnScroll', ...CTX_MENU_DECLS], {
    $: () => menu, document: fakeDoc, window: { innerWidth: 1440, innerHeight: 900 },
  }, '{ show: ctxMenuShow, onScroll: ctxMenuOnScroll }');
  page.show(menu, { label: 'x', html: '<button>a</button>', x: 10, y: 10 });
  assert.ok(menu.list, 'control: the entries are in their list');
  page.onScroll({ target: menu.list });
  assert.equal(menu.style.display, 'block', 'scrolling the list leaves the menu open');
  page.onScroll({ target: { tagName: 'MAIN' } });
  assert.equal(menu.style.display, 'none', 'a scroll anywhere else still closes it');
  assert.ok(INDEX.includes("document.addEventListener('scroll', ctxMenuOnScroll, true);"), 'and that is the listener the page installs');
});

/* ══════════════ D58 — the 20,000-node cap is stated, not left as a blank ══════════════ */

type TmNode = { path: string; size: number; depth: number; expanded: boolean; isTrash?: boolean };

const CAP_NOTE_DECLS = ['tmNodeCapNote', 'tmDrawnTree', 'tmParentPath', 'TM_SERVER_NODE_CAP', 'TM_MIN_SIZE', 'tmCapMemo'];

/** The note under a map of `nodes`, drawn with the floor `minSize` (what loadTreemap records; 4000 is its first ask). */
function capNote(nodes: TmNode[], rootSize: number, history = false, minSize = 4000): string {
  const note = load<() => string>(CAP_NOTE_DECLS, {
    state: { treemap: { rootPath: '/r', rootSize, nodes, minSize, history: { active: history } } },
    formatCount: fmtCount,
    formatBytes: (n: number) => `${n} B`,
  }, 'tmNodeCapNote');
  return note();
}

const files = (n: number, size: number, dir = '/r'): TmNode[] =>
  Array.from({ length: n }, (_, i) => ({ path: `${dir}/f${i}`, size, depth: 1, expanded: false }));

test('D58: a map cut at the server\'s 20,000 nodes says so, and how much has no rectangle', () => {
  // QA: a folder of 25,600 files drew 20,000 and left a blank rectangle for
  // the rest, with "20,000 nodes · 20,000 drawn" as the only words.
  const note = capNote(files(20000, 250), 25600 * 250);
  assert.match(note, /holds at most 20,000 items, and this folder reached that/, 'the cap is named');
  assert.match(note, /1400000 B has no rectangle here/, 'the 5,600 undrawn files are 1.4 MB of blank map, stated exactly');
  assert.match(note, /drill in, or open the Grid view/, 'and the way to see them');
});

test('D58: the undrawn bytes come from every outlined folder, not only the top level', () => {
  // Breadth-first: the cap leaves whole subtrees out at the BOTTOM of the
  // drawing order — a folder outlined with nothing inside it.
  const nodes = [
    ...files(19998, 10),
    { path: '/r/big', size: 5000, depth: 1, expanded: true },
    { path: '/r/big/a', size: 1000, depth: 2, expanded: false },
  ];
  const note = capNote(nodes, 19998 * 10 + 5000);
  assert.match(note, /4000 B has no rectangle here/, 'big/ is outlined at 5,000 B with 1,000 B drawn inside it');
});

test('D58: under the cap the map says nothing extra — and the Trash cell is not a node the server sent', () => {
  assert.equal(capNote(files(19999, 250), 19999 * 250 + 5000), '', '19,999 nodes were not cut by a 20,000 cap');
  const withTrash = [...files(19999, 250), { path: '\0trash', size: 1e9, depth: 1, expanded: false, isTrash: true }];
  assert.equal(capNote(withTrash, 19999 * 250), '', 'the injected Trash cell does not make 19,999 into 20,000');
});

test('LOW-2: the page\'s 20,000 is the server\'s — read from both routes that cap a treemap', () => {
  // The response is golden-locked, so it cannot say it was cut: the page has
  // to know the number, and a copy nothing checks drifts the day either changes.
  const cap = load<number>(['TM_SERVER_NODE_CAP'], {}, 'TM_SERVER_NODE_CAP');
  const routes: Array<[string, RegExp]> = [
    ['src/api/scanRoutes.ts', /buildTreemapFromStore\(store, rootId, \{[^}]*maxNodes: ([\d_]+)/], // the live map
    ['src/api/insightRoutes.ts', /buildTreemap\(root, \{[^}]*maxNodes: ([\d_]+)/], // the time slider's
  ];
  for (const [file, re] of routes) {
    const m = re.exec(readFileSync(path.join(__dirname, '..', file), 'utf8'));
    assert.ok(m, `${file} still caps the treemap with a maxNodes literal`);
    assert.equal(Number(m![1].replace(/_/g, '')), cap, `${file}'s maxNodes is the page's TM_SERVER_NODE_CAP`);
  }
});

test('LOW-2: exactly 20,000 items with every byte drawn is not called cut', () => {
  // `sent >= 20000` also fired on a folder of exactly 20,000 items. A cut
  // always leaves bytes undrawn — the items it left out are at least 4 KB —
  // so a full map that reached the cap with nothing undrawn says nothing.
  assert.equal(capNote(files(20000, 250), 20000 * 250), '');
});

test('LOW-2: the undrawn figure says it counts files under the 4 KB floor, which no drill-in reveals', () => {
  const note = capNote(files(20000, 250), 25600 * 250);
  assert.match(note, /That figure counts files under 4000 B too, which the map does not draw; the Grid view lists them\./);
  // The time slider's map is laid out with no floor (minSize: 0).
  const history = capNote(files(20000, 250), 25600 * 250, true);
  assert.match(history, /holds at most 20,000 items/);
  assert.doesNotMatch(history, /under 4000 B/, 'a history map has no floor to mention');
});

test('the map\'s floor is the round 4 KB its note names, in the decimal units the page prints (QA D09)', () => {
  // TM_MIN_SIZE was 4096: once sizes became decimal the note read "files
  // under 4.1 KB" — true, and not the 4 KB the floor is meant to be.
  const floor = load<number>(['TM_MIN_SIZE'], {}, 'TM_MIN_SIZE');
  const formatBytes = load<(n: number) => string>(['UNITS', 'formatBytes'], {}, 'formatBytes');
  assert.equal(formatBytes(floor), '4.0 KB', 'the note prints the floor through formatBytes (the LOW-2 tests above)');
});

test('LOW-2: the floor the note names is the one the map is asked for', async () => {
  let url = '';
  const state = { scanId: 's1', root: { path: '/r' }, pathIndex: new Map(),
    treemap: { mode: 'treemap', colorMode: 'size', rootPath: '/r', maxDepth: 4, nodes: [], history: { scrubbing: false } } };
  const loadTreemap = load<(p: string) => Promise<void>>(['treeScanId', 'loadTreemap', 'TM_MIN_SIZE'], {
    state, REDUCED: true, isSun: () => false, isCells: () => false, exitCartPreview() {}, $: () => ({ classList: { add() {}, remove() {} } }),
    // The map's failure is said through reportError (K05); this asks only where the map is asked for.
    api: async (u: string) => { url = u; throw new Error('stop here'); }, toast() {}, reportError() {},
  }, 'loadTreemap', 'let tmLoadSeq = 0;');
  await loadTreemap('/r');
  const floor = load<number>(['TM_MIN_SIZE'], {}, 'TM_MIN_SIZE');
  assert.match(url, new RegExp(`[?&]minSize=${floor}&`), 'loadTreemap asks for the floor TM_MIN_SIZE names');
  // The live re-layout asks with the floor the map on screen was asked with,
  // not TM_MIN_SIZE whatever it was (POL item 4): the tests after mapAndNote.
});

/**
 * The real loadTreemap and liveRelayout over a stubbed server, and the real
 * note for whatever they left on screen. `serve(minSize)` answers each ask.
 */
function mapAndNote(serve: (minSize: number, state: { treemap: { rootPath: string } }) => { root: { path: string; name: string; size: number }; nodes: TmNode[] }) {
  const asked: number[] = [];
  const state = {
    scanId: 's1', root: { path: '/r' }, pathIndex: new Map(), view: 'treemap', scanning: false,
    live: { on: true, dirty: 1 },
    treemap: { mode: 'treemap', colorMode: 'size', rootPath: '/r', rootSize: 0, maxDepth: 4, nodes: [] as TmNode[], minSize: undefined as number | undefined,
      hover: null, kbSel: null, history: { scrubbing: false, active: false } },
  };
  const page = load<{ loadTreemap: (p: string) => Promise<void>; liveRelayout: () => Promise<void>; note: () => string }>(
    ['treeScanId', 'loadTreemap', 'liveRelayout', ...CAP_NOTE_DECLS], {
      state, REDUCED: true, isSun: () => false, isCells: () => false, exitCartPreview() {},
      $: () => ({ classList: { add() {}, remove() {} }, disabled: false }),
      api: async (u: string) => { const m = Number(/[?&]minSize=(\d+)/.exec(u)![1]); asked.push(m); return serve(m, state); },
      toast: (m: string) => { throw new Error('the page reported: ' + m); },
      renderCrumbs() {}, maybeInjectTrash() {}, exitHistoryState() {}, refreshTimebar() {}, drawView() {},
      animateTreemapTo: (nodes: TmNode[]) => { state.treemap.nodes = nodes; },
      formatCount: fmtCount, formatBytes: (n: number) => `${n} B`,
    }, '{ loadTreemap, liveRelayout, note: tmNodeCapNote }', 'let tmLoadSeq = 0;');
  return { ...page, state, asked };
}

test('LOW-2: a map loadTreemap asked for again with no floor does not say it hides files under one (QA-6b review F1.2, F1.4)', async () => {
  // A flat folder of 25,600 files of 250 B: the 4 KB ask draws nothing, so
  // loadTreemap asks again with minSize=1 and gets 20,000 of them. That map
  // DOES draw 250-byte files; the 1.4 MB with no rectangle is what the cap cut.
  const root = { path: '/r', name: 'r', size: 25600 * 250 };
  const small = mapAndNote((m) => ({ root, nodes: m <= 250 ? files(20000, 250) : [] }));
  await small.loadTreemap('/r');
  assert.deepEqual(small.asked, [4000, 1], 'control: the floor was dropped for the second ask');
  assert.equal(small.state.treemap.nodes.length, 20000);
  const note = small.note();
  assert.match(note, /holds at most 20,000 items, and this folder reached that: 1400000 B has no rectangle here/, 'the cut is still said');
  assert.doesNotMatch(note, /files under/, 'and no floor is claimed for a map that has none');
  // The same folder with files over the floor keeps the sentence: its map was asked with 4 KB.
  const big = mapAndNote(() => ({ root: { path: '/r', name: 'r', size: 25600 * 5000 }, nodes: files(20000, 5000) }));
  await big.loadTreemap('/r');
  assert.deepEqual(big.asked, [4000]);
  assert.match(big.note(), /That figure counts files under 4000 B too, which the map does not draw; the Grid view lists them\./);
});

test('the live re-layout asks with the floor the map on screen was asked with: a folder of small files stays drawn in Live mode (POL item 4)', async () => {
  // loadTreemap drew a folder of 250-byte files with no floor; every Live tick
  // then asked with the 4 KB floor, got no rectangles back, and morphed the
  // map to nothing.
  const root = { path: '/r', name: 'r', size: 25600 * 250 };
  const h = mapAndNote((m) => ({ root, nodes: m <= 250 ? files(20000, 250) : [] }));
  await h.loadTreemap('/r');
  assert.deepEqual(h.asked, [4000, 1], 'control: the map on screen was asked with no floor');
  await h.liveRelayout();
  assert.deepEqual({ asked: h.asked, drawn: h.state.treemap.nodes.length, floor: h.state.treemap.minSize },
    { asked: [4000, 1, 1], drawn: 20000, floor: 1 }, 'the re-layout asks with that floor and lays the same files out');
});

test('LOW-2: the live re-layout records the floor it asks with, and the note follows it — asked again with none when the floor leaves nothing, as loadTreemap is (QA-6b review F1.2, POL item 4)', async () => {
  // Live mode on a folder of 5 KB files, while they shrink under 4 KB.
  let shrunk = false;
  const h = mapAndNote((m) => (shrunk
    ? { root: { path: '/r', name: 'r', size: 25600 * 250 }, nodes: m <= 250 ? files(20000, 250) : [] }
    : { root: { path: '/r', name: 'r', size: 25600 * 5000 }, nodes: files(20000, 5000) }));
  await h.loadTreemap('/r');
  await h.liveRelayout();
  assert.deepEqual(h.asked, [4000, 4000], 'control: a map asked with the 4 KB floor is re-laid out with it');
  assert.match(h.note(), /counts files under 4000 B too/, 'control: and says so');
  shrunk = true;
  h.state.live.dirty = 1; // the watcher saw the change
  await h.liveRelayout();
  assert.deepEqual({ asked: h.asked, drawn: h.state.treemap.nodes.length },
    { asked: [4000, 4000, 4000, 1], drawn: 20000 }, 'the floor drew nothing of a folder that holds bytes, so it asked again with none');
  assert.doesNotMatch(h.note(), /files under/, 'and the map it lays out claims no floor');
});

test('a live re-layout that lands after the map moved to another folder is dropped, not drawn over that folder (POL item 4)', async () => {
  // The re-layout can now ask twice; a drill-in landing in between must not
  // have the old folder's rectangles morphed onto it.
  // `moveOnAsk`: the live re-layout's ask (1st, or 2nd — the one with no
  // floor) during which the map moves. Files are 5 KB while the map loads,
  // and 250 B after, so the 4 KB ask draws nothing and is asked again.
  const run = async (moveOnAsk: number): Promise<{ asked: number[]; drawn: number }> => {
    let live = 0;
    const h = mapAndNote((m, state) => {
      if (live > 0 && ++live - 1 === moveOnAsk) state.treemap.rootPath = '/r/elsewhere';
      return live > 0
        ? { root: { path: '/r', name: 'r', size: 25600 * 250 }, nodes: m <= 250 ? files(20000, 250) : [] }
        : { root: { path: '/r', name: 'r', size: 25600 * 5000 }, nodes: files(20000, 5000) };
    });
    await h.loadTreemap('/r');
    assert.equal(h.state.treemap.nodes.length, 20000, 'control: the map was drawn');
    h.state.treemap.nodes = [];
    live = 1;
    await h.liveRelayout();
    return { asked: h.asked, drawn: h.state.treemap.nodes.length };
  };
  assert.deepEqual({ first: await run(1), second: await run(2) }, {
    first: { asked: [4000, 4000], drawn: 0 },
    second: { asked: [4000, 4000, 1], drawn: 0 },
  }, 'nothing was laid out for the folder the map left, during either ask');
});

test('LOW-2: the note is recomputed when only the floor changed (QA-6b review F1.2)', () => {
  const state = { treemap: { rootPath: '/r', rootSize: 25600 * 250, nodes: files(20000, 250), minSize: 4096, history: { active: false } } };
  const note = load<() => string>(CAP_NOTE_DECLS, { state, formatCount: fmtCount, formatBytes: (n: number) => `${n} B` }, 'tmNodeCapNote');
  assert.match(note(), /files under 4096 B/);
  state.treemap.minSize = 1; // the same nodes, read under another floor
  assert.doesNotMatch(note(), /files under/, 'the remembered note is not served for another floor');
});

test('B33: a history frame says how much its snapshot did not keep — the dark holes are named, below the cap too', () => {
  // B33: a history frame showed Videos/clips (141.5 MB) as a few tiles beside
  // a dark empty rectangle, with no word: a snapshot keeps each folder's
  // biggest items a few levels deep, not the whole tree.
  const nodes = [
    { path: '/r/clips', size: 5000, depth: 1, expanded: true },
    { path: '/r/clips/a.mov', size: 1500, depth: 2, expanded: false },
    { path: '/r/b.mov', size: 2000, depth: 1, expanded: false },
  ];
  const history = capNote(nodes, 7000, true);
  assert.match(history, /3500 B in this snapshot has no rectangle/, 'clips is 5,000 B with 1,500 B kept inside it');
  assert.match(history, /History keeps/, 'and why: what a snapshot keeps');
  assert.doesNotMatch(history, /20,000/, 'not the node cap, which this map is far below');
  // Review F1.4: it ended "The live map shows everything." — but the live map
  // is asked with a 4 KB floor and a 20,000-item cap, and says so itself.
  assert.doesNotMatch(history, /live map/i, 'no promise about the live map, which has its own floor and cap');
  assert.match(history, /has no rectangle\.$/, 'the note ends on what it knows: the bytes this snapshot did not keep');
  assert.equal(capNote(nodes, 7000, false), '', 'the live map below the cap still says nothing');
  const whole = [{ path: '/r/a', size: 4000, depth: 1, expanded: false }, { path: '/r/b', size: 3000, depth: 1, expanded: false }];
  assert.equal(capNote(whole, 7000, true), '', 'a snapshot that kept everything has nothing to explain');
  // During playback the frames are blends; the note waits for a frame that is a snapshot.
  const playing = load<() => string>(CAP_NOTE_DECLS, {
    state: { treemap: { rootPath: '/r', rootSize: 7000, nodes, minSize: 0, history: { active: true }, lapse: { playing: true } } },
    formatCount: fmtCount, formatBytes: (n: number) => `${n} B`,
  }, 'tmNodeCapNote');
  assert.equal(playing(), '', 'no note on a frame that is a blend of two snapshots');
});

test('D58: every rectangle-map paint refreshes the note under the map', () => {
  const start = INDEX.indexOf('function drawTreemap() {');
  const body = INDEX.slice(start, INDEX.indexOf('\n}', start));
  const at = body.indexOf('state.treemap.altNote = tmNodeCapNote();');
  assert.notEqual(at, -1, 'drawTreemap writes the note (from the nodes alone)');
  // Review F1.1 of fifth browser pass F06: the note is a row under the footer that the map's height
  // counts, and it is no longer watched — written after the measuring, it ran the page past the window.
  assert.ok(at < body.indexOf('treemapCanvasHeight(wrap)'), 'before it measures the map, whose height counts the note');
  assert.ok(at < body.indexOf('if (!px.length)'), 'before the empty-map return, so a stale note never outlives its map');
  assert.match(body.slice(at, at + 200), /renderAltNote\(\);/, 'and shows it');
});

/* ══════════════ D59 — the time-lapse bar appearing re-fits the map ══════════════ */

/**
 * Run the real `refreshTimebar` with the bar starting `startHidden` and the
 * snapshot list answering `snaps` entries; count the redraws it asks for.
 * `during` runs while the snapshot request is out.
 */
async function timebar(startHidden: boolean, snaps: number, opts: { view?: string; rootPath?: string; during?: (s: any, els: any) => void; calls?: number } = {}) {
  const els: Record<string, { hidden: boolean; value?: string; max?: string }> = {
    tmTimebar: { hidden: startHidden }, tmLiveToggle: { hidden: false }, tmTimeSlider: { hidden: false, value: '0', max: '0' },
  };
  const state = {
    view: opts.view ?? 'treemap',
    root: { path: '/r' },
    treemap: { rootPath: opts.rootPath ?? '/r', lapse: { playing: false }, history: { snaps: [] as unknown[], active: false, scrubbing: false } },
  };
  let redraws = 0;
  const refresh = load<() => Promise<void>>(['refreshTimebar'], {
    $: (id: string) => els[id],
    state,
    isCloudScan: () => false,
    api: async () => {
      if (opts.during) opts.during(state, els);
      return { snapshots: Array.from({ length: snaps }, (_, i) => ({ id: i, takenAt: i })) };
    },
    lapseOrderedSnaps: (s: unknown[]) => s,
    updateTimeLabel() {},
    drawView: () => { redraws++; },
  }, 'refreshTimebar');
  // `calls` at once: loadTreemap's call and finishScan's 1.5 s timer call can both be out.
  await Promise.all(Array.from({ length: opts.calls ?? 1 }, () => refresh()));
  return { redraws, hidden: els.tmTimebar.hidden };
}

test('D59: when the history bar appears or goes, the map is re-measured and redrawn', async () => {
  // QA at 1440×900: the bar unhid after the map was sized, pushed it down,
  // and cut the footer (legend, node count, hint) off the window.
  assert.deepEqual(await timebar(true, 2), { redraws: 1, hidden: false }, 'the bar appeared: one redraw');
  assert.deepEqual(await timebar(false, 1), { redraws: 1, hidden: true }, 'the bar went: the map takes the room back');
});

test('D59: no redraw when nothing moved, when the map is not on screen, or when the caller draws next', async () => {
  assert.deepEqual(await timebar(false, 3), { redraws: 0, hidden: false }, 'shown before and after');
  assert.deepEqual(await timebar(true, 1), { redraws: 0, hidden: true }, 'hidden before and after');
  assert.deepEqual(await timebar(true, 2, { view: 'grid' }), { redraws: 0, hidden: false }, 'a hidden view is not drawn');
  assert.deepEqual(await timebar(false, 2, { rootPath: '/r/sub' }), { redraws: 0, hidden: true },
    'in a subfolder the bar hides at once, before loadTreemap draws');
});

test('D59: a snapshot answer that lands after the map left the scan root does not bring the bar back', async () => {
  const r = await timebar(true, 2, {
    during: (state, els) => { state.treemap.rootPath = '/r/sub'; els.tmTimebar.hidden = true; },
  });
  assert.deepEqual(r, { redraws: 0, hidden: true }, 'the newer load (in a subfolder) owns the bar');
});

test('LOW-4: two snapshot answers in flight redraw the map once, not twice', async () => {
  // Each call captured the bar's state BEFORE its await, so when loadTreemap's
  // call and finishScan's timer call were both out, both saw "hidden → shown"
  // and both redrew — a Voronoi or Circles re-solve each, up to 200 ms apiece.
  assert.deepEqual(await timebar(true, 2, { calls: 2 }), { redraws: 1, hidden: false }, 'the bar appeared once: one redraw');
  assert.deepEqual(await timebar(false, 1, { calls: 2 }), { redraws: 1, hidden: true }, 'and went once: one redraw');
});

test('LOW-4: a new circle or Voronoi layout ends the level transition still running on the old one', () => {
  // The zoom's `to` is where the shared node sat in the layout being replaced:
  // a redraw that re-solved under a running zoom (the time-lapse bar
  // appearing, a resize) made it jump. loadTreemap starts the new zoom after.
  const cancelled: number[] = [];
  const state = { treemap: { mode: 'circles', cells: [] as unknown[], altNote: '', altMs: 0,
    altZoom: { k: 2, start: 0 } as unknown, altZoomRaf: 7 } };
  const build = load<(geo: unknown) => void>(['buildCells'], {
    state,
    sunburstRoot: () => ({ path: '/r' }),
    altRefineCancel() {},
    performance: { now: () => 0 },
    layoutCirclePack: () => ({ cells: [{ n: { path: '/r/a' } }], done: true, note: '' }),
    layoutVoronoi: () => { throw new Error('the circles mode lays out circles'); },
    altRefineSchedule() {}, altRefiningNote: () => '', fxShapeSync() {},
    cancelAnimationFrame: (id: number) => { cancelled.push(id); },
  }, 'buildCells');
  build({ cssW: 800, cssH: 600, dpr: 1 });
  assert.equal(state.treemap.altZoom, null, 'the running zoom is over');
  assert.equal(state.treemap.altZoomRaf, 0);
  assert.deepEqual(cancelled, [7], 'and its frame loop is cancelled, not left to paint the old transform');
  assert.equal(state.treemap.cells.length, 1, 'the new layout is in place');
});

/* ══════════════ D63 — the keyboard selection's card goes when the map does ══════════════ */

test('D63: a press or a focus anywhere but the map takes the map\'s card down; one on the map does not', () => {
  // QA: after j selected "Archives", its card stayed up over the cart panel
  // and through Preview after — only map navigation ever hid it.
  const canvas = { id: 'treemapCanvas' };
  let hides = 0;
  const view = { name: 'treemap' };
  const dismiss = load<(e: { target: unknown }) => void>(['tmTipDismiss'], {
    state: { get view() { return view.name; } },
    tmCanvas: canvas,
    hideTooltip: () => { hides++; },
  }, 'tmTipDismiss');
  dismiss({ target: { id: 'cartTab' } });
  assert.equal(hides, 1, 'a press on the cart tab hides it');
  dismiss({ target: canvas });
  assert.equal(hides, 1, 'a press on the map is the map\'s business — hover and click manage the card there');
  view.name = 'grid';
  dismiss({ target: { id: 'gridTile' } });
  assert.equal(hides, 1, 'another view\'s card is not the map\'s to hide');
});

test('D63: the dismissal is wired to presses, focus moves and the canvas losing focus', () => {
  assert.ok(INDEX.includes("document.addEventListener('pointerdown', tmTipDismiss, true);"), 'every press, in capture');
  assert.ok(INDEX.includes("document.addEventListener('focusin', tmTipDismiss, true);"), 'every focus move — Tab into the cart');
  assert.ok(INDEX.includes("tmCanvas.addEventListener('blur', hideTooltip);"), 'and the map losing focus');
});

test('D63: entering and leaving the cart preview take the selection\'s card down with the selection', () => {
  let hides = 0;
  const base = {
    hideTooltip: () => { hides++; },
    isSun: () => false, isCells: () => false, isRectMap: () => true,
    toast: (m: string) => { throw new Error('refused: ' + m); },
    formatCount: String,
    syncCartPreviewChrome() {}, drawTreemap() {}, exitCartPreview() {},
    tmBuildPreview: () => ({ nodes: [{ path: '/r/x' }], freedBytes: 5, stagedInView: 1, outsideView: 0, outsideBytes: 0 }),
  };
  const state = { view: 'treemap', cart: { size: 1 }, treemap: { history: { active: false }, nodes: [{ path: '/r/x' }], hover: null, kbSel: { path: '/r/x' } } };
  const tmPreview: Record<string, unknown> = { on: false };
  const enter = load<() => void>(['enterCartPreview'], { ...base, state, tmPreview }, 'enterCartPreview');
  enter();
  assert.equal(tmPreview.on, true, 'the preview started');
  assert.equal(hides, 1, 'and the card of the selection it cleared went with it');
  const exit = load<(silent?: boolean) => void>(['exitCartPreview'], { ...base, state, tmPreview }, 'exitCartPreview');
  state.treemap.kbSel = { path: '/r/x' };
  exit();
  assert.equal(tmPreview.on, false, 'the preview ended');
  assert.equal(hides, 2, 'leaving it clears the selection, and its card, too');
});

/* ══════════════ D64 — the preview banner sits above the map, not on it ══════════════ */

function previewChrome() {
  const props: Record<string, string> = {};
  const wrap = {
    previewing: false,
    classList: { toggle(_c: string, on: boolean) { wrap.previewing = on; } },
    style: {
      setProperty(k: string, v: string) { props[k] = v; }, removeProperty(k: string) { delete props[k]; },
      getPropertyValue: (k: string) => props[k] ?? '',
    },
  };
  const banner = { hidden: true, offsetHeight: 44 };
  const els: Record<string, unknown> = {
    cartPreview: { setAttribute() {}, classList: { toggle() {} } },
    treemapWrap: wrap, tmPreviewBanner: banner, tmPreviewText: { innerHTML: '' },
  };
  const tmPreview = { on: true, freedBytes: 5e9, outsideView: 0, outsideBytes: 0 };
  const observers: Array<() => void> = [];
  class FakeRO { cb: () => void; constructor(cb: () => void) { this.cb = cb; } observe() { observers.push(this.cb); } }
  const counts = { draws: 0 };
  const sync = load<() => void>(['syncCartPreviewChrome', 'cartSpaceSaid', 'TM_PREVIEW_BANNER_INSET', 'tmPreviewPadSync', 'TM_CART_GAP', 'tmCartClearSync', 'tmPreviewWatch'], {
    $: (id: string) => els[id], tmPreview,
    escapeHtml: (s: string) => s, formatBytes: (n: number) => `${n} B`, formatCount: String,
    ResizeObserver: FakeRO, state: { view: 'treemap' }, isRectMap: () => true,
    drawTreemap: () => { counts.draws++; },
  }, 'syncCartPreviewChrome');
  return { sync, props, banner, tmPreview, wrap, observers, counts };
}

test('D64: the preview pads the map down by its banner\'s measured height', () => {
  // QA: the absolutely-positioned banner sat over the map's top-left tiles
  // and hid their labels ("Videos", "holiday-4k.mov").
  const p = previewChrome();
  p.sync();
  assert.equal(p.wrap.previewing, true);
  assert.equal(p.props['--tm-preview-pad'], '64px', '10 px above the banner, its 44 px, 10 px below');
  p.banner.offsetHeight = 62; // the text wrapped beside the open cart
  p.sync();
  assert.equal(p.props['--tm-preview-pad'], '82px', 'a taller banner pushes the map further');
  p.tmPreview.on = false;
  p.sync();
  assert.equal(p.props['--tm-preview-pad'], undefined, 'leaving the preview gives the room back');
});

test('LOW-3: the pad follows the banner while the preview is up — the cart dock opening, a resize — one redraw per change', () => {
  // The banner narrows beside the open cart dock (max-width: calc(100% - 402px))
  // and on a resize, and wraps to more lines; measured only on enter and exit,
  // the pad went stale and the banner covered the top row again.
  const p = previewChrome();
  p.sync();
  assert.equal(p.props['--tm-preview-pad'], '64px');
  assert.equal(p.observers.length, 1, 'the banner is watched for its size');
  p.observers[0](); // the observer's first call, as it is installed
  assert.equal(p.counts.draws, 0, 'nothing changed, nothing is redrawn');
  p.banner.offsetHeight = 62; // the cart dock opened: the banner wrapped to two lines
  p.observers[0]();
  assert.equal(p.props['--tm-preview-pad'], '82px', 're-measured');
  assert.equal(p.counts.draws, 1, 'and the map redrawn under the new pad');
  p.observers[0]();
  assert.equal(p.counts.draws, 1, 'a callback with no change of height redraws nothing');
  p.tmPreview.on = false;
  p.sync();
  p.banner.offsetHeight = 44;
  p.observers[0]();
  assert.equal(p.props['--tm-preview-pad'], undefined, 'out of the preview nothing is padded');
  assert.equal(p.counts.draws, 1, 'or redrawn');
  p.tmPreview.on = true;
  p.sync();
  assert.equal(p.observers.length, 1, 'one observer however many times the preview starts');
});

test('D64: the map the preview draws is shorter by the banner\'s pad, re-measured, and gets the room back on exit', () => {
  // The test below checks treemapCanvasHeight's subtraction, which predates
  // D64. This drives the preview's own order — the pad is set BEFORE the map
  // is drawn, re-measured when the banner rewraps, and taken off before the
  // exit redraw — through the real functions, with the CSS as a stub:
  // #treemapWrap.previewing { padding-top: var(--tm-preview-pad, 64px) }.
  const props: Record<string, string> = {};
  const wrap = {
    previewing: false,
    classList: { toggle(_c: string, on: boolean) { wrap.previewing = on; } },
    style: {
      setProperty(k: string, v: string) { props[k] = v; }, removeProperty(k: string) { delete props[k]; },
      getPropertyValue: (k: string) => props[k] ?? '',
    },
    getBoundingClientRect: () => ({ top: 150 }),
    parentElement: { querySelector: () => ({ getBoundingClientRect: () => ({ height: 30 }) }) },
    closest: () => ({}),
  };
  const banner = { hidden: true, offsetHeight: 44 };
  const els: Record<string, unknown> = {
    cartPreview: { setAttribute() {}, classList: { toggle() {} } },
    treemapWrap: wrap, tmPreviewBanner: banner, tmPreviewText: { innerHTML: '' },
  };
  const observers: Array<() => void> = [];
  class FakeRO { cb: () => void; constructor(cb: () => void) { this.cb = cb; } observe() { observers.push(this.cb); } }
  const heights: number[] = [];
  let heightOf: (w: unknown) => number = () => NaN;
  const nodes = [{ path: '/r/x' }];
  const state = { view: 'treemap', cart: { size: 1 }, treemap: { history: { active: false }, nodes, hover: null, kbSel: null } };
  const out = load<{ enter: () => void; exit: () => void; heightOf: (w: unknown) => number }>(
    ['enterCartPreview', 'exitCartPreview', 'syncCartPreviewChrome', 'cartSpaceSaid', 'TM_PREVIEW_BANNER_INSET', 'tmPreviewPadSync', 'TM_CART_GAP', 'tmCartClearSync', 'tmPreviewWatch', 'tmUnscrolledTop', 'treemapCanvasHeight'], {
      $: (id: string) => els[id], state, tmPreview: { on: false },
      isSun: () => false, isCells: () => false, isRectMap: () => true,
      toast: (m: string) => { throw new Error('refused: ' + m); },
      formatCount: String, formatBytes: (n: number) => `${n} B`, escapeHtml: (x: string) => x, hideTooltip() {},
      tmBuildPreview: () => ({ nodes: [{ path: '/r/y' }], freedBytes: 5, stagedInView: 1, outsideView: 0, outsideBytes: 0 }),
      drawTreemap: () => { heights.push(heightOf(wrap)); },
      window: { innerHeight: 900 },
      getComputedStyle: (el: unknown) => (el === wrap
        ? { paddingTop: wrap.previewing ? (props['--tm-preview-pad'] ?? '64px') : '10px', paddingBottom: '10px' }
        : { marginTop: '12px', paddingBottom: '24px' }),
      ResizeObserver: FakeRO,
    }, '{ enter: enterCartPreview, exit: exitCartPreview, heightOf: treemapCanvasHeight }');
  heightOf = out.heightOf;
  const full = heightOf(wrap);
  out.enter();
  assert.deepEqual(heights, [full - 54], 'drawn under the preview: its 64 px pad (44 px banner, 10 px either side) for the 10 px it had');
  banner.offsetHeight = 62; // the cart dock opened beside it: the banner wrapped
  observers[0]();
  assert.deepEqual(heights, [full - 54, full - 72], 're-measured and redrawn 18 px shorter');
  out.exit();
  assert.deepEqual(heights, [full - 54, full - 72, full], 'and the exit redraw has every pixel back');
});

test('D64: the previewing wrap takes that padding, and the map\'s height gives it back', () => {
  const at = INDEX.indexOf('#treemapWrap.previewing {');
  assert.notEqual(at, -1);
  assert.match(INDEX.slice(at, INDEX.indexOf('}', at)), /padding-top:\s*var\(--tm-preview-pad,/,
    'the wrap is padded by the measure while previewing');
  // treemapCanvasHeight subtracts the wrap's own top padding, so the padded
  // map still fits the window above its footer.
  const height = (padTop: string) => load<(w: unknown) => number>(['tmUnscrolledTop', 'treemapCanvasHeight'], {
    getComputedStyle: (el: { pad?: string }) => (el.pad
      ? { paddingTop: el.pad, paddingBottom: '10px' }
      : { marginTop: '12px', paddingBottom: '24px' }),
    window: { innerHeight: 900 },
  }, 'treemapCanvasHeight')({
    pad: padTop,
    getBoundingClientRect: () => ({ top: 150 }),
    parentElement: { querySelector: () => ({ getBoundingClientRect: () => ({ height: 30 }) }) },
    closest: () => ({}),
  });
  assert.equal(height('10px') - height('64px'), 54, 'every pixel of padding comes off the map, none off the footer');
});

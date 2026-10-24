import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The map views tell the truth about what is on screen — the final hunt of
 * 24 Oct 2026, group B (C02, C20–C28, C70–C72).
 *
 * Every pin here RUNS the shipped code: the functions are cut out of the built
 * `public/index.html` by brace matching and evaluated with each global they
 * touch passed in (the mapViewTruth harness). The invariants are about what a
 * person sees, hears and what a key or a click does.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const MARKUP = readFileSync(path.join(__dirname, '..', 'src', 'ui', 'markup', '015-view-treemap.html'), 'utf8');

/** `function name(…) {…}`, `const name = {…};` (cut by brace matching) or `const NAME = value;`. */
function declSource(name: string): string {
  let start = INDEX.indexOf(`function ${name}(`);
  if (start > 0 && INDEX.slice(start - 6, start) === 'async ') start -= 6;
  if (start === -1) start = INDEX.indexOf(`const ${name} = {`);
  if (start === -1) {
    let at = INDEX.indexOf(`const ${name} = `);
    if (at === -1) at = INDEX.indexOf(`let ${name} = `);
    assert.notEqual(at, -1, `${name} is declared in the built page`);
    return INDEX.slice(at, INDEX.indexOf(';', at) + 1);
  }
  let from = INDEX.indexOf(name, start) + name.length;
  if (INDEX[from] === '(') {
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

/** Evaluate the named declarations in one scope, with `deps` as the globals. */
function load<T>(names: string[], deps: Record<string, unknown>, returns: string, prelude = ''): T {
  const keys = Object.keys(deps);
  const src = `'use strict'; ${prelude}\n${names.map(declSource).join('\n')}\nreturn ${returns};`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...keys, src)(...keys.map((k) => deps[k])) as T;
}

type Node = { path: string; name?: string; size: number; type?: string; depth?: number; children?: Node[]; pruned?: boolean; isTrash?: boolean; freed?: boolean };

/* ══════════════ C02 — the keyboard moves through the folder on screen ══════════════ */

function kbHarness(mode: string) {
  const library: Node = { path: '/home/u/Library', name: 'Library', size: 900, type: 'dir' };
  const big: Node = { path: '/home/u/big', name: 'big', size: 100, type: 'dir', pruned: true }; // the first frame's budget withheld its children
  const root: Node = { path: '/home/u', name: 'u', size: 1000, type: 'dir', children: [library, big] };
  const state = {
    root,
    pathIndex: new Map<string, Node>([[root.path, root], [library.path, library], [big.path, big]]),
    treemap: { mode, rootPath: '/home/u/big', rootName: 'big', rootSize: 100, nodes: [] as Node[], kbSel: null as Node | null },
  };
  const said: string[] = [];
  const live = { set textContent(v: string) { said.push(v); }, get textContent() { return said[said.length - 1] || ''; } };
  const deps = {
    state,
    isSun: () => state.treemap.mode === 'sunburst',
    isCells: () => state.treemap.mode === 'circles' || state.treemap.mode === 'voronoi',
    presentView() {},
    kbShowTip() {},
    hideTooltip() {},
    $: (id: string) => (id === 'tmKbAnnounce' ? live : null),
    formatBytes: (b: number) => `${b} B`,
    cartHas: () => false,
  };
  const api = load<{ kbSiblings: () => Node[]; kbMove: (d: number) => void }>(
    ['kbSiblings', 'kbSelect', 'kbMove'], deps, '{ kbSiblings, kbMove }');
  return { state, said, ...api };
}

test('C02: in a folder the first frame pruned, j/k move through the rectangles the map draws there', () => {
  const h = kbHarness('treemap');
  // The server laid the map out from its whole store: the folder's contents
  // are drawn although the page's tree holds it pruned, with no children.
  h.state.treemap.nodes = [
    { path: '/home/u/big/sub', name: 'sub', size: 60, type: 'dir', depth: 1 },
    { path: '/home/u/big/sub/deep.bin', name: 'deep.bin', size: 50, type: 'file', depth: 2 },
    { path: '/home/u/big/movie.mov', name: 'movie.mov', size: 40, type: 'file', depth: 1 },
  ];
  assert.deepEqual(h.kbSiblings().map((n) => n.path), ['/home/u/big/sub', '/home/u/big/movie.mov'],
    'the drawn top level of the folder on screen, biggest first');
  h.kbMove(1);
  assert.equal(h.state.treemap.kbSel?.path, '/home/u/big/sub', 'j selects the biggest thing drawn here');
  assert.match(h.said[h.said.length - 1], /^sub, folder, 60 B, 60\.0 percent of this view/);
});

test('C02: one level further, in a folder the page never held, j never selects the scan root\'s folders', () => {
  const h = kbHarness('treemap');
  h.state.treemap.rootPath = '/home/u/big/sub';
  h.state.treemap.rootSize = 60;
  h.state.treemap.nodes = [{ path: '/home/u/big/sub/deep.bin', name: 'deep.bin', size: 50, type: 'file', depth: 1 }];
  assert.deepEqual(h.kbSiblings().map((n) => n.path), ['/home/u/big/sub/deep.bin']);
  h.kbMove(1);
  assert.equal(h.state.treemap.kbSel?.path, '/home/u/big/sub/deep.bin', 'never ~/Library, which is not on screen');
});

test('C02: the Trash cell and a preview\'s staged block are not stops for j/k', () => {
  const h = kbHarness('treemap');
  h.state.treemap.rootPath = '/home/u';
  h.state.treemap.rootSize = 1000;
  h.state.treemap.nodes = [
    { path: '/home/u/Library', name: 'Library', size: 900, type: 'dir', depth: 1 },
    { path: '/home/u — freed', name: 'Staged', size: 100, type: 'dir', depth: 1, freed: true },
    { path: '\0trash', name: 'Trash', size: 5000, type: 'dir', depth: 1, isTrash: true },
  ];
  assert.deepEqual(h.kbSiblings().map((n) => n.path), ['/home/u/Library']);
});

test('C02: in the sunburst, circles or Voronoi, a folder the page does not hold gives j/k nothing — never the scan root\'s folders', () => {
  for (const mode of ['sunburst', 'circles', 'voronoi']) {
    const h = kbHarness(mode);
    h.state.treemap.rootPath = '/home/u/big/sub'; // not in the page's tree
    assert.deepEqual(h.kbSiblings(), [], `${mode}: nothing to move through`);
    h.state.treemap.rootPath = '/home/u';
    assert.deepEqual(h.kbSiblings().map((n) => n.path), ['/home/u/Library', '/home/u/big'], `${mode}: a folder the page holds still answers`);
  }
});

/* ══════════════ C20 — a grammar query over the sunburst ══════════════ */

const ctxStub = () => new Proxy({}, { get: (_t, k) => (k === 'canvas' ? {} : () => {}), set: () => true });

/** The real renderSearchOverlay and updateTmStatus over a map whose last rectangles are another view's. */
function overlayHarness(mode: string) {
  const status = { textContent: 'sunburst: 12 rings · 8.8 GB' };
  const state = {
    treemap: {
      mode, query: 'size>1gb', queryMode: 'grammar', matchedPaths: new Set(['/r/a', '/r/b']), matchTotal: 9, matches: 0,
      rootSize: 100, minSize: 4000, nodes: [], nodesFor: null, cells: [], history: { active: false },
      // Left by the rectangle map drawn before the sunburst: two of them match.
      pxRects: [
        { n: { path: '/r/a', depth: 1 }, x: 0, y: 0, w: 10, h: 10 },
        { n: { path: '/r/b', depth: 1 }, x: 10, y: 0, w: 10, h: 10 },
      ],
    },
  };
  const deps = {
    state,
    tmSearchBuffer: { width: 1, height: 1 }, tmBuffer: { width: 1, height: 1 }, tmSearchCtx: ctxStub(),
    window: { devicePixelRatio: 1 }, document: { documentElement: { dataset: { theme: 'dark' } } },
    cssVar: () => '#0A84FF', isCells: () => mode === 'circles' || mode === 'voronoi', isSun: () => mode === 'sunburst',
    treemapMatch: () => false, tmKidsOf: () => new Map(), altCellPath() {},
    $: (id: string) => (id === 'tmStatus' ? status : null),
    tmPreview: { on: false }, formatCount: (n: number) => n.toLocaleString('en-US'), formatBytes: (b: number) => `${b} B`, formatWhen: () => 'then',
  };
  const page = load<{ renderSearchOverlay: () => void; updateTmStatus: () => void }>(
    ['renderSearchOverlay', 'updateTmStatus'], deps, '{ renderSearchOverlay, updateTmStatus }');
  return { state, status, ...page };
}

test('C20: over the sunburst a grammar query counts no drawn match from the last rectangle map, and leaves the sunburst\'s line', () => {
  const h = overlayHarness('sunburst');
  h.renderSearchOverlay();
  assert.equal(h.state.treemap.matches, 0, 'the sunburst draws no highlight, so none is counted');
  assert.equal(h.status.textContent, 'sunburst: 12 rings · 8.8 GB', 'never "2 of 9 matches" over arcs that outline nothing');
  h.state.treemap.matches = 2; // whatever a caller left
  h.updateTmStatus();
  assert.equal(h.status.textContent, 'sunburst: 12 rings · 8.8 GB', 'the status line names no drawn count over the sunburst, whoever asks it');
  // The rectangle map still counts what it draws.
  const t = overlayHarness('treemap');
  t.renderSearchOverlay();
  assert.equal(t.state.treemap.matches, 2);
  assert.match(t.status.textContent, /^2 of 9 matches for “size>1gb”/);
});

/** The real tmRunGrammarQuery, answered with `total` matches, in `mode`. */
async function grammarIn(mode: string, total: number, degraded: { reason: string }[] = []) {
  const said: string[] = [];
  const state = {
    scanId: 's1', scanning: false, root: { path: '/r' },
    treemap: { mode, matchedPaths: null as Set<string> | null, queryMode: 'bare', queryScanId: null as string | null, matchTotal: null as number | null, matches: 0, rootPath: '/r' },
  };
  const hits = Array.from({ length: Math.min(total, 3) }, (_, i) => ({ path: `/r/f${i}`, name: `f${i}`, size: 2e9, isDir: false, mtimeMs: 0 }));
  const deps: Record<string, unknown> = {
    $: () => ({ hidden: true, textContent: '', classList: { toggle() {}, contains: () => false }, setAttribute() {} }),
    state,
    api: async () => ({ hits, total, truncated: false, degraded }),
    seedNodes() {}, renderSearchOverlay() {}, presentView() {}, tmSyncStageButton() {}, tmStageable: () => null,
    tmSetQueryMessage: (t: string) => { said.push(t); },
    tmUndrawnMessage: () => 'UNDRAWN', // the rectangle map's sentence — never the sunburst's
    formatCount: (n: number) => n.toLocaleString('en-US'),
    isSun: () => mode === 'sunburst',
  };
  const keys = Object.keys(deps);
  const optional = ['tmSunburstQueryWords'].filter((n) => INDEX.includes(`function ${n}(`)).map(declSource).join('\n');
  const src = `'use strict'; let tmLastHits = { q: '', paths: [], total: 0, truncated: false, stage: null }; let tmQuerySeq = 0; let tmQueryAbort = null;
    ${optional}\n${['treeScanId', 'tmRunGrammarQuery'].map(declSource).join('\n')}\nreturn tmRunGrammarQuery;`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function(...keys, src)(...keys.map((k) => deps[k])) as (q: string) => Promise<void>;
  await run('size>1gb');
  return said[said.length - 1];
}

test('C20: over the sunburst the box says the matches are not highlighted there, and where they are', async () => {
  assert.equal(await grammarIn('sunburst', 9),
    '9 matches — the sunburst does not highlight them. Switch to Treemap, Circles or Voronoi to see them.');
  assert.equal(await grammarIn('sunburst', 1),
    '1 match — the sunburst does not highlight it. Switch to Treemap, Circles or Voronoi to see it.');
  assert.equal(await grammarIn('sunburst', 0), 'Nothing matched.');
  assert.equal(await grammarIn('sunburst', 4, [{ reason: 'Last-opened dates are not recorded here.' }]),
    'Last-opened dates are not recorded here. 4 matches — the sunburst does not highlight them. Switch to Treemap, Circles or Voronoi to see them.');
  assert.equal(await grammarIn('treemap', 9), 'UNDRAWN', 'the rectangle map keeps its own account of what it drew');
});

/** The real setTreemapView, switching renderer under a grammar query whose answer is on screen. */
async function switchRenderer(to: string, query: { mode: string; text: string }) {
  const asked: string[] = [];
  const el = () => ({ disabled: false, hidden: false, textContent: '', querySelectorAll: () => [], setAttribute() {}, classList: { toggle() {}, add() {}, remove() {} } });
  const els: Record<string, ReturnType<typeof el>> = {};
  const state = {
    view: 'treemap', lens: { held: false },
    treemap: { mode: 'treemap', rootPath: '/r', history: { active: false }, altZoomRaf: 0, altZoom: null, cells: [], altNote: '', hover: null, queryMode: query.mode, query: query.text },
  };
  const deps = {
    state, TM_MODES: ['treemap', 'sunburst', 'circles', 'voronoi'],
    $: (id: string) => (els[id] ||= el()),
    lapseStop() {}, lensSetPinned() {}, lassoCancel() {}, cancelAnimationFrame() {}, altRefineCancel() {}, renderAltNote() {}, lapseSeekTo() {},
    localStorage: { setItem() {} },
    loadTreemap: async () => {},
    tmApplyQuery: (q: string) => { asked.push(q); },
  };
  const setTreemapView = load<(m: string) => void>(['setTreemapView'], deps, 'setTreemapView');
  setTreemapView(to);
  for (let i = 0; i < 5; i++) await Promise.resolve(); // the load's landing
  return { asked, els };
}

test('C20: switching renderer under a grammar query asks it again, so the box speaks of the renderer now on screen', async () => {
  assert.deepEqual((await switchRenderer('sunburst', { mode: 'grammar', text: 'size>1gb' })).asked, ['size>1gb']);
  assert.deepEqual((await switchRenderer('treemap', { mode: 'grammar', text: 'size>1gb' })).asked, ['size>1gb']);
  assert.deepEqual((await switchRenderer('sunburst', { mode: 'bare', text: 'movie' })).asked, [], 'a bare word is the page\'s own filter, asked of nobody');
  assert.deepEqual((await switchRenderer('sunburst', { mode: 'grammar', text: '  ' })).asked, [], 'nothing typed, nothing asked');
});

/* ══════════════ C21 — a query's answer comes back with the Treemap ══════════════ */

test('C21: back in the Treemap, a grammar query whose answer the unmount cleared is asked again', () => {
  const applied: string[] = [];
  const state = { scanning: false, scanId: 's1', treemap: { query: 'size>1gb', queryMode: 'grammar', queryScanId: 's1', matchTotal: 9 as number | null } };
  const deps = { state, tmApplyQuery: (q: string) => { applied.push(q); }, tmSyncStageButton() {} };
  const page = load<{ clear: () => void; rejudge: () => void }>(
    ['treeScanId', 'tmClearHits', 'tmRejudgeQuery'], deps, '{ clear: tmClearHits, rejudge: tmRejudgeQuery }',
    'let tmLastHits = { q: "size>1gb", paths: [], total: 9, truncated: false, stage: null };');
  page.rejudge();
  assert.deepEqual(applied, [], 'an answer this scan gave and still on screen is not asked again');
  page.clear(); // what the Treemap's unmount does on the way to another view
  page.rejudge(); // and its mount on the way back
  assert.deepEqual(applied, ['size>1gb'], 'the total, its explanation and the Stage offer come back with the highlights');
});

/* ══════════════ C22 — Disk City's Trash building ══════════════ */

/** What maybeInjectTrash adds beside a home folder's map, as Disk City is handed it. */
const TRASH_CELL = () => ({ name: 'Trash', path: '\0trash', size: 4e9, type: 'dir', modifiedAt: Date.now(), depth: 1, expanded: false, isTrash: true, x: 80, y: 0, w: 20, h: 100 });

test('C22: a click on the Trash building opens the Trash sheet — it is no folder to go inside', () => {
  const loaded: string[] = [];
  let sheets = 0;
  const drill = load<(n: unknown) => void>(['cityDrillInto', 'tmStepToward', 'tmIsInside'], {
    state: { treemap: { rootPath: '/home/u' } },
    loadCity: (p: string) => { loaded.push(p); },
    openTrashModal: () => { sheets++; },
  }, 'cityDrillInto');
  drill(TRASH_CELL());
  assert.deepEqual(loaded, [], 'never loadCity("\\0trash"), which the server refuses with a null-byte error said aloud');
  assert.equal(sheets, 1, 'the Trash sheet, as the Treemap\'s Trash cell opens');
  drill({ path: '/home/u/Movies', type: 'dir' });
  assert.deepEqual(loaded, ['/home/u/Movies'], 'a folder still opens');
});

/** The real cityShowCard for one building, in a height mode. */
function cityCard(n: Record<string, unknown>, height = 'staleness') {
  const card = { hidden: true, innerHTML: '', dataset: {} as Record<string, string>, style: {} as Record<string, string>, offsetWidth: 230, offsetHeight: 90 };
  const state = { treemap: { rootSize: 1e10 }, city: { counts: new Map(), height, colour: 'size' } };
  const show = load<(b: unknown, x: number, y: number) => void>(
    ['cityShowCard', 'cityAgeDays', 'cityAgeWords', 'cityCardKey'], {
      $: (id: string) => (id === 'cityCard' ? card : { clientWidth: 800, clientHeight: 600 }),
      state, reclaim: { scores: new Map() },
      formatBytes: (b: number) => `${b} B`, formatCount: (k: number) => String(k), escapeHtml: (s: string) => s,
    }, 'cityShowCard');
  show({ n, rgb: [1, 2, 3] }, 10, 10);
  return card.innerHTML;
}

test('C22: the Trash building\'s card invents no date, offers no way inside, and is not "still counting" for ever', () => {
  const html = cityCard(TRASH_CELL());
  assert.match(html, /Last changed<\/span><b>not recorded/, 'the map\'s Trash cell carries the moment it was drawn, never a date of the Trash');
  assert.doesNotMatch(html, /Click to go inside/);
  assert.match(html, /Click to see what is in the Trash/);
  assert.doesNotMatch(html, /Share of this folder/, 'the Trash is beside the folder, no share of it');
  const files = cityCard(TRASH_CELL(), 'files');
  assert.doesNotMatch(files, /still counting/, 'nothing ever counts the Trash cell');
  assert.match(files, /Holds<\/span><b>not counted/);
  // A real folder keeps its words.
  const folder = cityCard({ path: '/home/u/Movies', name: 'Movies', size: 1e9, type: 'dir', modifiedAt: Date.now() - 3 * 86400000 }, 'files');
  assert.match(folder, /Click to go inside · Esc to come back out/);
  assert.match(folder, /Share of this folder<\/span><b>10\.0%/);
  assert.match(folder, /still counting/);
  assert.doesNotMatch(folder, /not recorded/);
});

test('C22: the Trash building wears the Trash\'s own grey-blue in every colour mode, never the colour of a date it does not have', () => {
  const cityRgb = load<(n: unknown, m: string) => number[]>(['cityRgb'], {
    sizeRgb: () => [9, 9, 9], kindFor: () => ({ tint: '#ffffff' }), hexToRgb: () => [8, 8, 8], ageRgb: () => [7, 7, 7],
    reclaim: { scores: new Map() }, C_RC_UNSCORED: [6, 6, 6], reclaimRgb: () => [5, 5, 5],
  }, 'cityRgb');
  for (const mode of ['size', 'type', 'age', 'reclaim']) assert.deepEqual(cityRgb(TRASH_CELL(), mode), [108, 122, 137], mode);
  assert.deepEqual(cityRgb({ path: '/home/u/x', size: 1 }, 'age'), [7, 7, 7], 'a building of the folder keeps the mode\'s colour');
});

test('C22: the Files height never sends the Trash cell\'s path to the fact route, where it refuses the whole batch', async () => {
  const sent: string[][] = [];
  const blocks = [{ n: TRASH_CELL() }, { n: { path: '/home/u/Movies', type: 'dir' } }, { n: { path: '/home/u/Music', type: 'dir' } }];
  const state = { scanId: 's1', scanning: false, view: 'city', city: { blocks, colour: 'size', height: 'files', countsAsked: new Set<string>(), counts: new Map() } };
  const fetch = load<() => void>(['treeScanId', 'TM_SCORE_CAP', 'RECLAIM_BATCH', 'cityFetchFacts', 'cityLoadCounts'], {
    state, ensureScores() {}, buildCity() {}, cityInvalidate() {}, renderCityTable() {}, cityRefreshCard() {}, window: {},
    api: async (_url: string, init: { body: string }) => { sent.push(JSON.parse(init.body).paths); return { providers: { subtreeCount: { available: true, values: {} } } }; },
  }, 'cityFetchFacts');
  fetch();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(sent, [['/home/u/Movies', '/home/u/Music']]);
});

test('C22: the Trash building is not one the city\'s line says has "no date yet"', () => {
  const nodes = [
    { path: '/home/u/Movies', name: 'Movies', size: 6e9, type: 'dir', modifiedAt: Date.now() - 9 * 86400000, depth: 1, x: 0, y: 0, w: 40, h: 100 },
    { path: '/home/u/Music', name: 'Music', size: 2e9, type: 'dir', depth: 1, x: 40, y: 0, w: 40, h: 100 }, // no date: really waiting
    TRASH_CELL(),
  ];
  const state = {
    scanId: 's1', scanning: false,
    treemap: { rootPath: '/home/u', nodes, nodesFor: null as unknown },
    city: { zoom: 1, height: 'staleness', colour: 'size', counts: new Map() } as Record<string, unknown>,
  };
  state.treemap.nodesFor = { scanId: 's1', path: '/home/u', nodes, size: 1e10, minSize: 4000 };
  const build = load<() => void>(['treeScanId', 'tmParentPath', 'isoProject', 'isoBounds', 'isoBehind', 'isoDepthOrder', 'CITY_MAX_H', 'CITY_MIN_H',
    'cityAgeDays', 'cityMetric', 'cityScaleHeights', 'cityVisibleNodes', 'cityContentBounds', 'buildCity'], {
    state, cityRgb: () => [1, 2, 3], cityJitter: (rgb: number[]) => rgb,
  }, 'buildCity');
  build();
  assert.equal((state.city.blocks as unknown[]).length, 3, 'control: all three are drawn');
  assert.equal(state.city.unknownHeight, 1, 'only Music, whose date may yet be known');
});

/** An attribute value as the HTML parser stores it: entities decoded, and U+0000 stored as U+FFFD (WHATWG tokenizer). */
const parsedAttr = (v: string) => v.replace(/\0/g, '�').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * The real list of buildings and its click handler over `blocks`: each row's button as the browser builds it from the
 * markup (its data-* attributes read back through the parser), what activating it drills into, and the row's cells.
 */
function cityTable(blocks: { n: Record<string, unknown> }[], height = 'files') {
  const host = { innerHTML: '' };
  const drilled: unknown[] = [];
  const state = { city: { blocks, counts: new Map(), height } };
  const page = load<{ render: () => void; click: (e: unknown) => void }>(['escapeHtml', 'cityAgeDays', 'renderCityTable', 'cityTableClick'], {
    state, $: (id: string) => (id === 'cityTable' ? host : null),
    formatCount: (k: number) => String(k), formatBytes: (b: number) => `${b} B`,
    cityDrillInto: (n: unknown) => { drilled.push(n); },
  }, '{ render: renderCityTable, click: cityTableClick }');
  page.render();
  const camel = (s: string) => s.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase());
  const rows = [...host.innerHTML.matchAll(/<tr><td><button((?:\s+data-[\w-]+="[^"]*")+)>([^<]*)<\/button><\/td>(.*?)<\/tr>/g)].map(([, attrs, label, cells]) => {
    const dataset: Record<string, string> = {};
    for (const [, name, value] of attrs.matchAll(/data-([\w-]+)="([^"]*)"/g)) dataset[camel(name)] = parsedAttr(value);
    const btn = { dataset };
    // closest() as the DOM answers it: the button, when it carries the attribute the selector names.
    const closest = (sel: string) => { const m = /^(?:button)?\[data-([\w-]+)\]$/.exec(sel); return m && camel(m[1]) in dataset ? btn : null; };
    return {
      label, cells: [...cells.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => m[1]),
      activate: () => { drilled.length = 0; page.click({ target: { closest } }); return drilled[0]; },
    };
  });
  return { state, rows, render: page.render };
}

test('C22: the list of buildings opens the Trash from its Trash row, as a click on the building does — the row is not a dead button', () => {
  const movies = { name: 'Movies', path: '/home/u/Movies', size: 6e9, type: 'dir', depth: 1, modifiedAt: Date.now() - 86400000 };
  const trash = TRASH_CELL();
  const t = cityTable([{ n: movies }, { n: trash }]);
  assert.deepEqual(t.rows.map((r) => r.label), ['Movies', 'Trash'], 'control: both buildings are listed');
  assert.equal(t.rows[1].activate(), trash, 'the Trash row drills the Trash cell, which opens the Trash sheet (cityDrillInto)');
  assert.equal(t.rows[0].activate(), movies, 'control: a folder row still drills its folder');
  assert.equal(t.rows[1].cells[2], 'not counted', 'its Files value is the card\'s "not counted": nothing will ever count the Trash');
  assert.equal(t.rows[0].cells[2], 'not counted yet', 'control: a folder not counted yet still says so');
  // A table left from before a rebuild drills what its row names in the city now on screen, and nothing that is gone.
  const again = { ...trash };
  t.state.city.blocks = [{ n: again }];
  assert.equal(t.rows[1].activate(), again, 'the row it names, as the city now holds it');
  assert.equal(t.rows[0].activate(), undefined, 'a building no longer in the city is not drilled');
});

/* ══════════════ C23 — Up, disabled at the scan root, does not drop focus ══════════════ */

test('C23: the Treemap\'s Up, disabled at the scan root while it holds focus, hands focus to the map', async () => {
  const doc = { activeElement: null as unknown };
  const canvas = { tagName: 'CANVAS', focus() { doc.activeElement = canvas; } };
  const el = () => ({ classList: { add() {}, remove() {} }, disabled: false, innerHTML: '', focus() { doc.activeElement = this; } });
  const els: Record<string, ReturnType<typeof el>> = {};
  const $ = (id: string) => (els[id] ||= el());
  for (const mode of ['treemap', 'sunburst']) {
    const state = {
      scanId: 's1', scanning: false, root: { path: '/r', name: 'r', size: 100, children: [] }, pathIndex: new Map(),
      treemap: { mode, rootPath: '/r/a', maxDepth: 4, nodes: [], hover: null, kbSel: null, history: { scrubbing: false, active: false } },
    };
    const deps = {
      state, $, document: doc, tmCanvas: canvas, REDUCED: true,
      isSun: () => mode === 'sunburst', isCells: () => false, exitCartPreview() {},
      ensureSubtree: async () => state.root,
      api: async () => ({ root: { path: '/r', name: 'r', size: 100 }, nodes: [{ path: '/r/a', size: 60, depth: 1 }] }),
      renderCrumbs() {}, exitHistoryState() {}, refreshTimebar() {}, tmSetEmpty() {}, maybeInjectTrash() {}, altBeginZoom() {}, altCircleFor: () => null,
      reportError: (e: Error) => { throw e; }, requestAnimationFrame: (f: () => void) => f(), drawView() {},
    };
    const loadTreemap = load<(p: string, a?: boolean) => Promise<void>>(['treeScanId', 'TM_MIN_SIZE', 'upDisabledKeepFocus', 'loadTreemap'], deps, 'loadTreemap', 'let tmLoadSeq = 0;');
    $('tmUpBtn').focus(); // tabbed to, and pressed with Enter
    await loadTreemap('/r', true);
    assert.equal($('tmUpBtn').disabled, true, `${mode}: control — Up has nowhere to go at the scan root`);
    assert.equal(doc.activeElement, canvas, `${mode}: focus is on the map, not left on a disabled button for the browser to drop on <body>`);
  }
});

test('C23: Up disabled while focus is elsewhere takes nothing; the Grid and Disk City hand theirs to their own map', () => {
  const doc = { activeElement: null as unknown };
  const mk = (tag: string) => { const e = { tagName: tag, disabled: false, focus() { doc.activeElement = e; } }; return e; };
  const keep = load<(btn: unknown, to: unknown) => void>(['upDisabledKeepFocus'], { document: doc }, 'upDisabledKeepFocus');
  const up = mk('BUTTON'), map = mk('CANVAS'), other = mk('INPUT');
  other.focus();
  up.disabled = true;
  keep(up, map);
  assert.equal(doc.activeElement, other, 'focus on something else stays there');
  up.focus();
  up.disabled = false;
  keep(up, map);
  assert.equal(doc.activeElement, up, 'an Up still enabled keeps its focus');
  up.disabled = true;
  const asked = Object.assign(() => map, { focus() { doc.activeElement = 'the function itself'; } });
  keep(up, asked);
  assert.equal(doc.activeElement, map, 'a target given as a function is asked at the time');
  // Every Up button is wired to it, each to its own view's map.
  const src = (fn: string) => declSource(fn);
  assert.match(src('renderGrid'), /\$\('gridUpBtn'\)\.disabled = [^;]+;\s*\n\s*if \(typeof upDisabledKeepFocus === 'function'\) upDisabledKeepFocus\(\$\('gridUpBtn'\), \$\('gridSearch'\)\);/);
  const city = src('loadCity');
  const wired = city.match(/\$\('cityUpBtn'\)\.disabled = [^;]+;[^\n]*\n\s*if \(typeof upDisabledKeepFocus === 'function'\) upDisabledKeepFocus\(\$\('cityUpBtn'\), \$\('cityCanvas'\)\);/g) || [];
  const sets = city.match(/\$\('cityUpBtn'\)\.disabled = /g) || [];
  assert.ok(sets.length >= 1 && wired.length === sets.length, `every place loadCity disables Disk City's Up hands focus on (${wired.length} of ${sets.length})`);
});

/* ══════════════ C24 — Live, the slider and Play leave the cart preview's picture alone ══════════════ */

/** The real liveRelayout (and maybeInjectTrash) over a stubbed server, with the preview `on` or not. */
function liveHarness(opts: { preview: boolean; home?: boolean; previewDuringFetch?: boolean }) {
  const asked: string[] = [];
  const previewNodes = [{ path: '/r/a', size: 40, depth: 1, x: 0, y: 0, w: 40, h: 100 }, { path: '/r — freed', size: 60, depth: 1, freed: true, x: 40, y: 0, w: 60, h: 100 }];
  const tmPreview = { on: opts.preview };
  const state = {
    scanId: 's1', scanning: false, view: 'treemap', root: { path: '/r' },
    system: { homeDir: opts.home ? '/r' : '/elsewhere' }, trash: { totalBytes: 50 },
    live: { on: true, dirty: 2 },
    treemap: { mode: 'treemap', rootPath: '/r', rootSize: 100, minSize: 4000, maxDepth: 4, nodes: previewNodes as Record<string, unknown>[], history: { active: false } },
  };
  const deps = {
    state, tmPreview, TM_MIN_SIZE: 4000,
    isSun: () => false, isCells: () => false, animateSunburstTo() {}, drawCells() {}, sunburstRoot: () => null,
    api: async (u: string) => {
      asked.push(u);
      if (opts.previewDuringFetch) tmPreview.on = true;
      return { root: { path: '/r', size: 100 }, nodes: [{ path: '/r/a', size: 100, depth: 1, x: 0, y: 0, w: 100, h: 100 }] };
    },
    animateTreemapTo: (nodes: Record<string, unknown>[]) => { state.treemap.nodes = nodes; },
    Date,
  };
  const liveRelayout = load<() => Promise<void>>(['maybeInjectTrash', 'liveRelayout'], deps, 'liveRelayout');
  return { state, asked, previewNodes, liveRelayout };
}

test('C24: a live re-layout waits while the cart preview is up — its hatched staged blocks stay drawn, and the change is laid out after', async () => {
  const h = liveHarness({ preview: true });
  await h.liveRelayout();
  assert.deepEqual(h.asked, [], 'nothing asked while the preview is up');
  assert.equal(h.state.treemap.nodes, h.previewNodes, 'the preview\'s picture is not replaced under its banner');
  assert.equal(h.state.live.dirty, 2, 'the disk\'s changes are kept for the relayout after the preview');
  const f = liveHarness({ preview: false, previewDuringFetch: true });
  await f.liveRelayout();
  assert.equal(f.state.treemap.nodes, f.previewNodes, 'a preview entered while the layout was asked: its picture stays');
  assert.ok(f.state.live.dirty > 0, 'and the relayout is still owed');
  const n = liveHarness({ preview: false });
  await n.liveRelayout();
  assert.deepEqual(n.state.treemap.nodes.map((x) => x.path), ['/r/a'], 'control: with no preview the live layout lands');
});

test('C24: a live re-layout of the home folder keeps the Trash cell beside it', async () => {
  const h = liveHarness({ preview: false, home: true });
  await h.liveRelayout();
  const trash = h.state.treemap.nodes.find((x) => x.isTrash);
  assert.ok(trash, 'the Trash cell is laid in again, as every load of the home folder does');
  assert.equal(h.state.treemap.nodes.filter((x) => x.isTrash).length, 1);
});

test('C24: a point on the time slider, and Play, leave the cart preview first — never a past snapshot under its banner', async () => {
  const calls: string[] = [];
  const state = {
    view: 'treemap', live: { on: false }, root: { path: '/r' },
    treemap: { rootSize: 0, hover: null, kbSel: null, nodes: [], history: { snaps: [{ takenAt: 1 }, { takenAt: 2 }], index: 0, seq: 0, active: false, scrubbing: true, viewingAt: 0, tree: null },
      lapse: { playing: false, seq: 0, pos: 0, completed: false, loop: false, onDone: null } },
  };
  const deps = {
    state, REDUCED: true, isSun: () => false, isCells: () => false, isRectMap: () => true,
    exitCartPreview: (silent: boolean) => { calls.push(`exit:${silent}`); },
    historyLayoutFor: async () => ({ snapshot: { takenAt: 1 }, root: { size: 1 }, nodes: [] }),
    animateTreemapTo: () => { calls.push('draw'); }, updateTimeLabel() {}, toast() {}, disableLive() {}, loadTreemap() {},
    cancelAnimationFrame() {}, $: () => ({ value: '0' }), lapseReflect() {}, lapsePrefetch() {}, performance: { now: () => 0 },
    requestAnimationFrame: () => 0, lapseExporting: false, lapseInternalStart: false, tmAnimFrame: 0,
  };
  const page = load<{ seek: (i: number) => Promise<void>; play: () => void }>(['setHistoryIndex', 'lapseStart'], deps, '{ seek: setHistoryIndex, play: lapseStart }');
  await page.seek(0);
  assert.deepEqual(calls, ['exit:true', 'draw'], 'the preview is left before the snapshot is drawn');
  calls.length = 0;
  page.play();
  assert.equal(calls[0], 'exit:true', 'Play (and the time-lapse export it drives) leaves the preview first');
});

/* ══════════════ C25 — Circles and Voronoi: the folder on screen is no drawn match ══════════════ */

test('C25: in Circles and Voronoi the scanned folder\'s own cell is neither counted, outlined nor dimmed as one of the shapes', () => {
  for (const [kind, rootMatches] of [['circle', true], ['poly', true], ['circle', false], ['poly', false]] as const) {
    const shape = (path: string, depth: number, cx: number) => (kind === 'circle'
      ? { n: { path, depth }, depth, kind, cx, cy: 50, r: depth === 0 ? 50 : 10, leaf: depth > 0 }
      : { n: { path, depth }, depth, kind, cx, cy: 50, leaf: depth > 0, poly: [{ x: cx, y: 0 }, { x: cx + 10, y: 0 }, { x: cx + 10, y: 10 }] });
    const cells = [shape('/r', 0, 50), shape('/r/big.mov', 1, 20), shape('/r/small', 1, 80)];
    const stroked: string[] = [];
    const dimmedAt: number[] = [];
    const ctx = new Proxy({}, {
      get: (_t, k) => (k === 'arc' ? (x: number) => { dimmedAt.push(x); } : k === 'moveTo' ? (x: number) => { if (kind === 'poly') dimmedAt.push(x); } : () => {}),
      set: () => true,
    });
    const state = {
      treemap: { mode: kind === 'circle' ? 'circles' : 'voronoi', query: 'size>1gb', queryMode: 'grammar', matchedPaths: new Set(rootMatches ? ['/r', '/r/big.mov'] : ['/r/big.mov']),
        matchTotal: 2, matches: 0, cells, pxRects: [], history: { active: false }, rootSize: 100 },
    };
    const renderSearchOverlay = load<() => void>(['renderSearchOverlay'], {
      state, tmSearchBuffer: { width: 1, height: 1 }, tmBuffer: { width: 1, height: 1 }, tmSearchCtx: ctx, window: { devicePixelRatio: 1 },
      document: { documentElement: { dataset: { theme: 'dark' } } }, cssVar: () => '#0A84FF', isCells: () => true, treemapMatch: () => false,
      altCellPath: (_c: unknown, c: { n: { path: string } }) => { stroked.push(c.n.path); }, updateTmStatus() {},
    }, 'renderSearchOverlay');
    renderSearchOverlay();
    const at = `${kind}, the folder ${rootMatches ? 'matching' : 'not matching'}`;
    assert.equal(state.treemap.matches, 1, `${at}: one drawn match — the folder on screen has no shape of its own, as on the rectangle map`);
    assert.deepEqual(stroked, ['/r/big.mov'], `${at}: only the matching file is outlined`);
    assert.ok(!dimmedAt.includes(50), `${at}: the folder's own cell is not in the scrim — it dimmed every shape inside it, matches too`);
    assert.ok(dimmedAt.includes(80), `${at}: control — the shape that did not match is dimmed`);
  }
});

test('C25: the box then explains the undrawn match truthfully — this folder itself, and none deeper', () => {
  const msg = load<(f: number, d: number, p: string[], r: string) => string>(['tmIsInside', 'tmUndrawnBreakdown', 'tmUndrawnMessage'], {}, 'tmUndrawnMessage');
  // What renderSearchOverlay now counts for the cells above: one drawn of the two found.
  assert.equal(msg(2, 1, ['/r', '/r/big.mov'], '/r'), '2 matches — 1 shown here. One is this folder itself, which has no rectangle of its own.');
});

/* ══════════════ C26 — "without children" counts what has none ══════════════ */

function cellsLine(cells: Record<string, unknown>[]) {
  const st = { textContent: '' };
  const state = { treemap: { query: '', queryMode: 'bare', matchedPaths: null, history: { active: false }, cells, rootSize: 1e9 } };
  const render = load<() => void>(['renderCellsStatus'], {
    $: (id: string) => (id === 'tmStatus' ? st : null), isCells: () => true, state, tmPreview: { on: false },
    formatCount: (n: number) => n.toLocaleString('en-US'), formatBytes: (b: number) => `${b / 1e9} GB`,
  }, 'renderCellsStatus');
  render();
  return st.textContent;
}

test('C26: a folder drawn hatched — more in it than drawn — is not counted "without children"; the line says how many there are', () => {
  const root = { n: { path: '/r', type: 'dir' }, depth: 0, leaf: false };
  const file = (p: string) => ({ n: { path: p, type: 'file' }, depth: 1, leaf: true, more: false });
  const held = (p: string) => ({ n: { path: p, type: 'dir', children: [{}] }, depth: 2, leaf: true, more: true });
  const open = { n: { path: '/r/d', type: 'dir', children: [{}] }, depth: 1, leaf: false, more: false };
  assert.equal(cellsLine([root, open, file('/r/a.mov'), file('/r/b.txt'), held('/r/d/x'), held('/r/d/y'), held('/r/d/z')]),
    '6 shapes · 2 without children · 3 folders drawn without their contents · 1 GB total');
  assert.equal(cellsLine([root, open, file('/r/a.mov'), held('/r/d/x')]), '3 shapes · 1 without children · 1 folder drawn without its contents · 1 GB total');
  assert.equal(cellsLine([root, file('/r/a.mov'), file('/r/b.txt')]), '2 shapes · 2 without children · 1 GB total', 'no hatched folder, no words about one');
  // A folder of 50,000 small files: the coverage gate leaves only the folder on screen, hatched.
  assert.equal(cellsLine([{ n: { path: '/r', type: 'dir', children: [{}] }, depth: 0, leaf: true, more: true }]), '0 shapes · 0 without children · 1 GB total',
    'never "0 shapes · 1 without children" of the folder on screen, which holds 50,000 files');
});

/* ══════════════ C27 — "click to look inside" only where a click does ══════════════ */

function tooltipFor(node: Record<string, unknown>, where: { view?: string; rootPath?: string; preview?: boolean } = {}) {
  const tip = { innerHTML: '', style: {} as Record<string, string>, dataset: {} as Record<string, string>, offsetWidth: 0, offsetHeight: 0 };
  const show = load<(x: number, y: number, node: unknown) => void>(['showTooltip', 'containerListable', 'sizeInk', 'tmStepToward', 'tmIsInside'], {
    $: () => tip, icon: () => '', escapeHtml: (s: unknown) => String(s), formatBytes: (n: number) => `${n} B`, sizeColor: () => '#fff',
    formatDate: () => 'then', state: { view: where.view ?? 'treemap', grid: { sort: 'size' }, treemap: { rootPath: where.rootPath ?? '/r' } },
    kindFor: () => ({ tint: '#000', icon: 'file' }), resolveAllocation() {}, resolveScore() {}, resolveHumanScale() {},
    allocationTooltipLine: () => '', reclaimTooltipLine: () => '', humanScaleTooltipLine: () => '', noteTooltipLine: () => '',
    window: { innerWidth: 1000, innerHeight: 800 }, tmPreview: { on: !!where.preview },
  }, 'showTooltip');
  show(1, 1, node);
  return tip.innerHTML;
}

test('C27: an archive below the next level is not offered "click to look inside" — a click there opens the folder that holds it', () => {
  const zip = (p: string) => ({ name: p.split('/').pop(), path: p, type: 'file', size: 5, modifiedAt: 0, container: 'zip', depth: p.split('/').length - 2 });
  assert.match(tooltipFor(zip('/r/a.zip')), / · click to look inside/, 'control: an archive directly in the folder on screen expands on a click');
  const deep = tooltipFor(zip('/r/Docs/a.zip'));
  assert.doesNotMatch(deep, /click to look inside/, 'a click opens /r/Docs, one level per click (D26)');
  assert.match(deep, / · open its folder to look inside/);
  // Windows-shaped paths take the same rule.
  assert.match(tooltipFor(zip('C:\\r\\Docs\\a.zip'), { rootPath: 'C:\\r' }), / · open its folder to look inside/);
  assert.match(tooltipFor(zip('C:\\r\\a.zip'), { rootPath: 'C:\\r' }), / · click to look inside/);
});

test('C27: the Grid\'s card offers no click to look inside — a click there previews the archive', () => {
  const html = tooltipFor({ name: 'a.zip', path: '/r/a.zip', type: 'file', size: 5, modifiedAt: 0, container: 'zip' }, { view: 'grid' });
  assert.doesNotMatch(html, /look inside/);
});

/* ══════════════ C28 — the map's hint offers only what works in the renderer on screen ══════════════ */

test('C28: in Sunburst the hint does not offer the lasso or the Z lens, which do nothing there; the other renderers keep them', async () => {
  const flat = /<span id="tmHintFlat">([\s\S]*?)<\/span> · Esc to go up/.exec(MARKUP);
  assert.ok(flat, 'the lasso and lens phrases stand in a span of their own');
  const words = flat![1].replace(/<[^>]+>/g, '');
  assert.equal(words, ' · drag to lasso (⌥ freehand, ⌘ to unstage) · hold Z to magnify');
  for (const [mode, hidden] of [['sunburst', true], ['treemap', false], ['circles', false], ['voronoi', false]] as const) {
    const { els } = await switchRenderer(mode, { mode: 'bare', text: '' });
    assert.equal(els.tmHintFlat.hidden, hidden, `${mode}: ${hidden ? 'not offered — lassoAvailable() and the Z key refuse the sunburst' : 'offered'}`);
  }
});

/* ══════════════ C72 — leaving the Treemap invalidates a map load still out ══════════════ */

/** The registry's `{ id: '<id>', … }` view object, as the page declares it. */
function viewSource(id: string): string {
  const at = INDEX.indexOf(`id: '${id}', label:`);
  assert.notEqual(at, -1, `the ${id} view is in the page`);
  const start = INDEX.lastIndexOf('{', at);
  let depth = 0;
  for (let i = start; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`the ${id} view never closes`);
}

test('C72: a map load still out when the Treemap is left never lands under the view that took its place', async () => {
  let answer: (v: unknown) => void = () => {};
  const noop = () => {};
  const el = () => ({ classList: { add: noop, remove: noop, toggle: noop }, disabled: false, hidden: false, innerHTML: '', textContent: '' });
  const els: Record<string, ReturnType<typeof el>> = {};
  const state = {
    scanId: 's1', scanning: false, view: 'treemap', root: { path: '/r', name: 'r', size: 100 }, pathIndex: new Map(), live: { on: false },
    lens: { held: false, at: null },
    treemap: { mode: 'treemap', rootPath: '/r', rootName: 'r', rootSize: 100, maxDepth: 4, nodes: [] as unknown[], nodesFor: null as unknown, hover: null, kbSel: null,
      history: { scrubbing: false, active: false }, altZoomRaf: 0, altZoom: null, cells: [], altNote: '' },
  };
  const deps = {
    state, $: (id: string) => (els[id] ||= el()), REDUCED: true, isSun: () => false, isCells: () => false, exitCartPreview: noop,
    api: () => new Promise((land) => { answer = land; }),
    renderCrumbs: noop, maybeInjectTrash: noop, exitHistoryState: noop, refreshTimebar: noop, drawView: noop, reportError: noop,
    requestAnimationFrame: (f: () => void) => f(), tmCanvas: {},
    // The rest of the Treemap view's unmount: each stops what it names.
    tmCancelQueries: noop, tmCloseHints: noop, tmClearHits: noop, nlClose: noop, tmSetQueryMessage: noop, disableLive: noop,
    cancelAnimationFrame: noop, altRefineCancel: noop, lapseStop: noop, clearTimeout: noop, tmResizeDeb: 0, lassoCancel: noop, fxTmPillBeamsSync: noop,
  };
  const page = load<{ loadTreemap: (p: string) => Promise<void>; view: { unmount: () => void } }>(
    ['treeScanId', 'TM_MIN_SIZE', 'loadTreemap'], deps, `{ loadTreemap, view: (${viewSource('treemap')}) }`, 'let tmLoadSeq = 0; let tmAnimFrame = 0;');
  const out = page.loadTreemap('/r/A'); // a click on folder A
  page.view.unmount(); // Disk City opened before the answer landed
  state.view = 'city';
  answer({ root: { path: '/r/A', name: 'A', size: 60 }, nodes: [{ path: '/r/A/x', size: 60, depth: 1 }] });
  await out;
  assert.equal(state.treemap.rootPath, '/r', 'the shared root the city stands on is not rewritten to A');
  assert.deepEqual(state.treemap.nodes, [], 'nor its nodes');
});

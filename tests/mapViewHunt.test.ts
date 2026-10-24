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

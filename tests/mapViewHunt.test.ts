import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { load as pull } from './fixtures/mapRaster';

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
    treemap: {
      mode, rootPath: '/home/u/big', rootName: 'big', rootSize: 100, nodes: [] as Node[], kbSel: null as Node | null, hideCloud: false,
      // What the renderer on screen last drew: the rectangle map's rectangles, the sunburst's arcs, the cells' shapes.
      pxRects: [] as { n: Node }[], arcs: [] as { n: Node; depth: number }[], cells: [] as { n: Node; depth: number }[],
    },
  };
  /** The rectangle map's answer for the folder on screen, every node of it drawn (drawTreemap's pxRects). */
  const paint = (nodes: Node[]) => { state.treemap.nodes = nodes; state.treemap.pxRects = nodes.map((n) => ({ n, x: 0, y: 0, w: 10, h: 10 })); };
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
  return { state, said, paint, ...api };
}

test('C02: in a folder the first frame pruned, j/k move through the rectangles the map draws there', () => {
  const h = kbHarness('treemap');
  // The server laid the map out from its whole store: the folder's contents
  // are drawn although the page's tree holds it pruned, with no children.
  h.paint([
    { path: '/home/u/big/sub', name: 'sub', size: 60, type: 'dir', depth: 1 },
    { path: '/home/u/big/sub/deep.bin', name: 'deep.bin', size: 50, type: 'file', depth: 2 },
    { path: '/home/u/big/movie.mov', name: 'movie.mov', size: 40, type: 'file', depth: 1 },
  ]);
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
  h.paint([{ path: '/home/u/big/sub/deep.bin', name: 'deep.bin', size: 50, type: 'file', depth: 1 }]);
  assert.deepEqual(h.kbSiblings().map((n) => n.path), ['/home/u/big/sub/deep.bin']);
  h.kbMove(1);
  assert.equal(h.state.treemap.kbSel?.path, '/home/u/big/sub/deep.bin', 'never ~/Library, which is not on screen');
});

test('C02: the Trash cell and a preview\'s staged block are not stops for j/k', () => {
  const h = kbHarness('treemap');
  h.state.treemap.rootPath = '/home/u';
  h.state.treemap.rootSize = 1000;
  h.paint([
    { path: '/home/u/Library', name: 'Library', size: 900, type: 'dir', depth: 1 },
    { path: '/home/u — freed', name: 'Staged', size: 100, type: 'dir', depth: 1, freed: true },
    { path: '\0trash', name: 'Trash', size: 5000, type: 'dir', depth: 1, isTrash: true },
  ]);
  assert.deepEqual(h.kbSiblings().map((n) => n.path), ['/home/u/Library']);
});

test('C02: in the sunburst, circles or Voronoi, a folder the page does not hold gives j/k nothing — never the scan root\'s folders', () => {
  for (const mode of ['sunburst', 'circles', 'voronoi']) {
    const h = kbHarness(mode);
    // The scan root's shapes, as the last draw left them.
    const drawn = h.state.root.children!.map((n) => ({ n, depth: 1 }));
    if (mode === 'sunburst') h.state.treemap.arcs = drawn; else h.state.treemap.cells = [{ n: h.state.root, depth: 0 }, ...drawn];
    h.state.treemap.rootPath = '/home/u/big/sub'; // not in the page's tree
    assert.deepEqual(h.kbSiblings(), [], `${mode}: nothing to move through`);
    h.state.treemap.rootPath = '/home/u';
    assert.deepEqual(h.kbSiblings().map((n) => n.path), ['/home/u/Library', '/home/u/big'], `${mode}: a folder the page holds still answers`);
  }
});

test('C02 (review F1.2): in the sunburst, circles and Voronoi j/k move through the shapes drawn — never a cloud file Hide cloud hides, nor an arc too thin to draw', () => {
  const local: Node = { path: '/home/u/local.bin', name: 'local.bin', size: 300, type: 'file' };
  const cloud = { path: '/home/u/icloud-only.mov', name: 'icloud-only.mov', size: 600, type: 'file', cloudPlaceholder: true } as Node;
  const speck: Node = { path: '/home/u/speck', name: 'speck', size: 1, type: 'file' }; // 0.36°: under the sunburst's 0.8° floor
  const sub: Node = { path: '/home/u/local.bin/x', name: 'x', size: 1, type: 'file' };
  for (const mode of ['sunburst', 'circles', 'voronoi']) {
    const h = kbHarness(mode);
    const root = h.state.root;
    root.children = [cloud, local, speck];
    h.state.treemap.rootPath = root.path;
    h.state.treemap.hideCloud = true;
    if (mode === 'sunburst') {
      // The real sunburst layout of the folder, as drawSunburst lays it.
      const layout = load<(r: Node, g: unknown) => { n: Node; depth: number }[]>(['layoutSunburstArcs'], { state: h.state }, 'layoutSunburstArcs');
      h.state.treemap.arcs = layout(root, { rings: 2, cx: 50, cy: 50, innerR0: 10, ringT: 10 });
      assert.deepEqual(h.state.treemap.arcs.filter((a) => a.depth === 1).map((a) => a.n.path), [local.path], 'control: only local.bin has an arc');
    } else {
      // What layoutCirclePack and layoutVoronoi keep (altChildren): the folder's own shape, local.bin, and one inside it.
      h.state.treemap.cells = [{ n: root, depth: 0 }, { n: local, depth: 1 }, { n: sub, depth: 2 }];
    }
    assert.deepEqual(h.kbSiblings().map((n) => n.path), [local.path], `${mode}: the stops are the shapes drawn at the folder's top level`);
    h.kbMove(1);
    assert.equal(h.state.treemap.kbSel?.path, local.path, `${mode}: j never selects the hidden cloud file`);
  }
});

/* ══════════════ C20 — a grammar query over the sunburst ══════════════ */

const ctxStub = () => new Proxy({}, { get: (_t, k) => (k === 'canvas' ? {} : () => {}), set: () => true });

/** The real renderSearchOverlay and updateTmStatus over a map whose last rectangles are another view's. */
function overlayHarness(mode: string, extra: Record<string, unknown> = {}) {
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
    ...extra,
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

/**
 * The real tmRunGrammarQuery, answered with `total` matches, in `mode`, over the folder `rootPath` (the scan's root,
 * /r, unless given): the hits are `paths` (`/r/f0`… unless given), and `truncated` says the server sent only the biggest.
 */
async function grammarIn(mode: string, total: number, degraded: { reason: string }[] = [], o: { rootPath?: string; paths?: string[]; truncated?: boolean; settled?: boolean } = {}) {
  const said: string[] = [];
  const state = {
    scanId: 's1', scanning: false, root: { path: '/r' },
    treemap: { mode, matchedPaths: null as Set<string> | null, queryMode: 'bare', queryScanId: null as string | null, matchTotal: null as number | null, matches: 0, rootPath: o.rootPath ?? '/r' },
  };
  const paths = o.paths ?? Array.from({ length: Math.min(total, 3) }, (_, i) => `/r/f${i}`);
  const hits = paths.map((p) => ({ path: p, name: p.slice(p.lastIndexOf('/') + 1), size: 2e9, isDir: false, mtimeMs: 0 }));
  const deps: Record<string, unknown> = {
    $: () => ({ hidden: true, textContent: '', classList: { toggle() {}, contains: () => false }, setAttribute() {} }),
    state,
    api: async () => ({ hits, total, truncated: !!o.truncated, degraded }),
    seedNodes() {}, renderSearchOverlay() {}, presentView() {}, tmSyncStageButton() {}, tmStageable: () => null,
    tmSetQueryMessage: (t: string) => { said.push(t); },
    tmUndrawnMessage: () => 'UNDRAWN', // the rectangle map's sentence — never the sunburst's
    formatCount: (n: number) => n.toLocaleString('en-US'),
    isSun: () => mode === 'sunburst',
    // Whether the picture on screen is the settled live map (review HB2-L1): settled unless the case says not.
    tmSettledLiveMap: () => o.settled !== false,
  };
  const keys = Object.keys(deps);
  const optional = ['tmSunburstQueryWords'].filter((n) => INDEX.includes(`function ${n}(`)).map(declSource).join('\n');
  const src = `'use strict'; let tmLastHits = { q: '', paths: [], total: 0, truncated: false, stage: null }; let tmQuerySeq = 0; let tmQueryAbort = null;
    ${optional}\n${['treeScanId', 'tmIsInside', 'tmUndrawnBreakdown', 'tmQueryAnswerWords', 'tmRunGrammarQuery'].map(declSource).join('\n')}\nreturn tmRunGrammarQuery;`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function(...keys, src)(...keys.map((k) => deps[k])) as (q: string) => Promise<void>;
  await run('size>1gb');
  return said[said.length - 1];
}

test('HB2 review (HB2-L1): an answer that lands while the map is no settled live map — a past snapshot, a time-lapse frame, a morph, the cart preview, a layout still being laid out — is not worded for that picture; the box is cleared for the draw that settles to word', async () => {
  assert.equal(await grammarIn('treemap', 9, [], { settled: false }), '', 'the box is cleared, never worded of the picture in passing');
  assert.equal(await grammarIn('treemap', 9), 'UNDRAWN', 'control: over the settled live map it is worded');
  // One gate decides, and it is the one tmRewordQuery asks (the page's own, lifted).
  const gate = (o: Record<string, unknown>) => new Function('state', 'tmPreview', 'tmMorph', 'altLayoutRefining', `${declSource('tmSettledLiveMap')}\nreturn tmSettledLiveMap();`)(
    { view: o.view ?? 'treemap', treemap: { history: { active: !!o.history }, lapse: { playing: !!o.lapse } } }, { on: !!o.preview }, o.morph ? {} : null, () => !!o.refining) as boolean;
  assert.equal(gate({}), true, 'the live Treemap, settled');
  for (const k of ['history', 'lapse', 'preview', 'morph', 'refining']) assert.equal(gate({ [k]: true }), false, `not while ${k}`);
  assert.equal(gate({ view: 'grid' }), false, 'not another view');
  assert.match(declSource('tmRewordQuery'), /if \(!tmSettledLiveMap\(\)\) return;/, 'tmRewordQuery asks the same gate');
});

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

test('C20 (review F1.3): over the sunburst the box advises switching renderer only for matches in the folder on screen — never for one elsewhere in the scan, nor for the folder itself', async () => {
  const lib = Array.from({ length: 9 }, (_, i) => `/home/u/Library/big${i}.bin`);
  // Every match under ~/Library, the sunburst on ~/Movies: switching renderer there shows "0 shown here".
  assert.equal(await grammarIn('sunburst', 9, [], { rootPath: '/home/u/Movies', paths: lib }),
    '9 matches — the sunburst does not highlight them. 9 are elsewhere in the scan, outside this folder. Go up in Treemap, Circles or Voronoi to see them.');
  assert.equal(await grammarIn('sunburst', 1, [], { rootPath: '/home/u/Movies', paths: lib.slice(0, 1) }),
    '1 match — the sunburst does not highlight it. 1 is elsewhere in the scan, outside this folder. Go up in Treemap, Circles or Voronoi to see it.');
  // The only match is the folder on screen: no renderer highlights the folder it is showing.
  assert.equal(await grammarIn('sunburst', 1, [], { rootPath: '/home/u/Movies', paths: ['/home/u/Movies'] }),
    '1 match — the sunburst does not highlight it. One is this folder itself.');
  // All three kinds at once.
  assert.equal(await grammarIn('sunburst', 6, [], { rootPath: '/home/u/Movies', paths: ['/home/u/Movies', ...lib.slice(0, 2), '/home/u/Movies/a.mov', '/home/u/Movies/b/c.mov', '/home/u/Movies/d.mov'] }),
    '6 matches — the sunburst does not highlight them. One is this folder itself; 2 are elsewhere in the scan, outside this folder; 3 are in this folder. ' +
    'Switch to Treemap, Circles or Voronoi to see the ones in this folder, and go up there for the rest.');
  assert.equal(await grammarIn('sunburst', 2, [], { rootPath: '/home/u/Movies', paths: ['/home/u/Movies', '/home/u/Movies/a.mov'] }),
    '2 matches — the sunburst does not highlight them. One is this folder itself; 1 is in this folder. Switch to Treemap, Circles or Voronoi to see the one in this folder.');
  // Only the biggest were sent: where the rest are is not known, so no renderer is promised to show them.
  assert.equal(await grammarIn('sunburst', 5000, [], { rootPath: '/home/u/Movies', paths: lib, truncated: true }),
    '5,000 matches — the sunburst does not highlight them. Treemap, Circles and Voronoi highlight the ones they draw.');
});

/** The real setTreemapView, switching renderer under a grammar query whose answer is on screen. */
async function switchRenderer(to: string, query: { mode: string; text: string }, typedDuringLoad?: string) {
  const asked: string[] = [];
  const el = () => ({ disabled: false, hidden: false, textContent: '', value: '', querySelectorAll: () => [], setAttribute() {}, classList: { toggle() {}, add() {}, remove() {} } });
  const els: Record<string, ReturnType<typeof el>> = {};
  els.tmSearch = { ...el(), value: query.text }; // the box holds the query applied
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
  if (typedDuringLoad !== undefined) els.tmSearch.value = typedDuringLoad; // typed while the new renderer loaded: its debounce is out
  for (let i = 0; i < 5; i++) await Promise.resolve(); // the load's landing
  return { asked, els };
}

test('C20: switching renderer under a grammar query asks it again, so the box speaks of the renderer now on screen', async () => {
  assert.deepEqual((await switchRenderer('sunburst', { mode: 'grammar', text: 'size>1gb' })).asked, ['size>1gb']);
  assert.deepEqual((await switchRenderer('treemap', { mode: 'grammar', text: 'size>1gb' })).asked, ['size>1gb']);
  // A bare word is the page's own filter, asked of no server (tmApplyQuery, below): applied again, its words follow the renderer (review F1.8).
  assert.deepEqual((await switchRenderer('sunburst', { mode: 'bare', text: 'movie' })).asked, ['movie']);
  assert.deepEqual((await switchRenderer('treemap', { mode: 'bare', text: 'movie' })).asked, ['movie']);
  assert.deepEqual((await switchRenderer('sunburst', { mode: 'grammar', text: '  ' })).asked, [], 'nothing typed, nothing asked');
  // Text typed while the new renderer loaded is applied by its own debounce: applying the older text then cancelled it,
  // leaving the box showing one query and the map another.
  assert.deepEqual((await switchRenderer('sunburst', { mode: 'grammar', text: 'size>1gb' }, 'size>1gb ext:mov')).asked, [], 'never the older text over newer typing');
  assert.deepEqual((await switchRenderer('treemap', { mode: 'bare', text: 'movie' }, 'movies')).asked, []);
});

/** The real tmApplyQuery with `raw` typed, over `mode`: what the box says, and whether anything was asked of the server. */
function bareWordIn(mode: string, raw: string, matches = 0) {
  const said: string[] = [];
  const grammar: string[] = [];
  const state = { root: { path: '/r' }, treemap: { mode, query: '', queryMode: 'bare', matchedPaths: null, matchTotal: null as number | null, matches } };
  const apply = load<(q: string) => void>(['TM_GRAMMAR_FIELDS', 'TM_GRAMMAR_RE', 'TM_SUNBURST_BARE_WORDS', 'tmIsGrammarQuery', 'tmApplyQuery'], {
    state, tmCancelQueries() {}, tmClearHits() {}, tmSetQueryMessage: (t: string) => { said.push(t); },
    isSun: () => mode === 'sunburst', isCells: () => mode === 'circles' || mode === 'voronoi',
    presentSunburst() {}, renderSearchOverlay() {}, renderCellsStatus() {}, presentCells() {}, presentTreemap() {},
    tmUnknownFieldHint: () => null, tmRunGrammarQuery: async (q: string) => { grammar.push(q); },
  }, 'tmApplyQuery');
  apply(raw);
  return { said: said.at(-1), grammar };
}

test('C20 (review F1.8): a plain word typed over the sunburst is told the sunburst highlights no match — never a silent box', () => {
  const sun = bareWordIn('sunburst', 'node_modules');
  assert.equal(sun.said, 'The sunburst does not highlight matches. Switch to Treemap, Circles or Voronoi to see what matches.');
  assert.deepEqual(sun.grammar, [], 'still the page\'s own filter: nothing is asked of the server');
  assert.equal(bareWordIn('sunburst', '  ').said, '', 'an emptied box says nothing');
  for (const mode of ['treemap', 'circles', 'voronoi']) {
    assert.equal(bareWordIn(mode, 'node_modules', 3).said, '', `${mode}: control — a renderer that highlights says nothing of it`);
  }
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

test('C21 (review F1.6): left and entered again while a rescan of the folder runs, the Treemap asks the query again of the tree\'s own scan — never leaving the drawn count as the whole answer', () => {
  const noop = () => {};
  const applied: { q: string; scanId: string | null }[] = [];
  const el = () => ({ hidden: false, classList: { add: noop, remove: noop, toggle: noop } });
  const els: Record<string, ReturnType<typeof el>> = {};
  // A rescan of /r runs (its request answered: scan-2); the tree on screen, and the query's answer, are scan-1's.
  const state = {
    root: { path: '/r' }, scanning: true, scanId: 'scan-2', settledScanId: 'scan-1', live: { on: false }, lens: { held: false, at: null },
    treemap: { rootPath: '/r', query: 'size>1gb', queryMode: 'grammar', queryScanId: 'scan-1', matchTotal: 9 as number | null, altZoomRaf: 0, altZoom: null, cells: [], altNote: '' },
  };
  // tmRunGrammarQuery asks the page's treeScanId (treeScanKey pins it): the scan recorded is the one it would ask.
  type Page = { view: { mount: () => void; unmount: () => void }; treeScanId: () => string | null };
  let page: Page | null = null;
  const deps: Record<string, unknown> = {
    state, $: (id: string) => (els[id] ||= el()),
    tmApplyQuery: (q: string) => { applied.push({ q, scanId: page!.treeScanId() }); }, tmSyncStageButton: noop,
    fxTmPillBeamsSync: noop, loadSavedViews: noop, refreshDock: noop, loadTreemap: noop, tmRejudgeQueryWait: noop,
    tmCancelQueries: noop, tmCloseHints: noop, nlClose: noop, exitCartPreview: noop, tmSetQueryMessage: noop, disableLive: noop,
    cancelAnimationFrame: noop, altRefineCancel: noop, lapseStop: noop, clearTimeout: noop, tmResizeDeb: 0, lassoCancel: noop,
  };
  page = load<Page>(['treeScanId', 'tmClearHits', 'tmRejudgeQuery', 'tmStopMorph'], deps, `{ view: (${viewSource('treemap')}), treeScanId }`,
    'let tmLoadSeq = 0; let tmAnimFrame = 0; let tmMorph = null; let tmLastHits = { q: "size>1gb", paths: ["/r/a"], total: 9, truncated: false, stage: null };');
  const view = page.view;
  view.mount(); // the view re-entered as the scan chrome began
  assert.deepEqual(applied, [], 'control: an answer of the tree\'s own scan, still whole, is not asked again');
  view.unmount(); // to the Dashboard: the answer's total, words and Stage offer go
  assert.equal(state.treemap.matchTotal, null, 'control: the unmount cleared the answer');
  view.mount(); // and back, the rescan still walking
  assert.deepEqual(applied, [{ q: 'size>1gb', scanId: 'scan-1' }], 'asked again — of the scan the tree on screen came from, never the running one');
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
    state, $: (id: string) => (id === 'cityTable' ? host : null), document: { activeElement: null }, // nothing in the list holds focus here
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

/** Every `renderCrumbs(…)` call in `src`, with its arguments split at the top level. */
function crumbCalls(src: string): string[][] {
  const calls: string[][] = [];
  for (let at = src.indexOf('renderCrumbs('); at !== -1; at = src.indexOf('renderCrumbs(', at + 1)) {
    const args: string[] = [];
    let depth = 0;
    let start = at + 'renderCrumbs('.length;
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) {
        if (depth === 0) { args.push(src.slice(start, i).trim()); break; }
        depth--;
      } else if (c === ',' && depth === 0) { args.push(src.slice(start, i).trim()); start = i + 1; }
    }
    calls.push(args);
  }
  return calls;
}

test('C23 (review F1.4): the Treemap, the Grid and Disk City each hand a pressed crumb\'s focus to their own map — at every place they draw the trail', () => {
  const canvas = { id: 'tmCanvas' }, city = { id: 'cityCanvas' }, search = { id: 'gridSearch' }, tile = { id: 'a tile' };
  const els: Record<string, unknown> = { cityCanvas: city, gridSearch: search };
  // The map a call names, asked as renderCrumbs asks it when the crumb that held focus is redrawn away.
  const mapOf = (expr: string, onScreen: unknown = null) => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const ask = new Function('$', 'tmCanvas', 'gridTileOnScreen', `return (${expr});`)((id: string) => els[id] ?? null, canvas, () => onScreen);
    return typeof ask === 'function' ? ask() : undefined;
  };
  for (const [fn, trail, sites, map] of [['loadTreemap', "$('tmCrumbs')", 2, canvas], ['loadCity', "$('cityCrumbs')", 3, city], ['renderGrid', "$('gridCrumbs')", 1, search]] as const) {
    const calls = crumbCalls(declSource(fn));
    assert.ok(calls.length >= sites, `control: ${fn} draws the trail at ${sites} places (found ${calls.length})`);
    for (const args of calls) {
      assert.equal(args[0], trail, `control: ${fn} draws its own trail`);
      // Without it renderCrumbs focuses nothing, and the load replaces the pressed crumb: focus falls to <body>.
      assert.equal(mapOf(args[3] ?? 'undefined'), map, `${fn}: renderCrumbs(${args.join(', ')}) hands focus to ${map.id}`);
    }
  }
  const grid = crumbCalls(declSource('renderGrid'))[0][3];
  assert.equal(mapOf(grid, tile), tile, 'the Grid\'s map is the tile on screen first — its search box only where no tile is');
});

/* ══════════════ C24 — Live, the slider and Play leave the cart preview's picture alone ══════════════ */

/** The real liveRelayout (and maybeInjectTrash) over a stubbed server, with the preview `on` or not. */
function liveHarness(opts: { preview: boolean; home?: boolean; previewDuringFetch?: boolean; smallFiles?: boolean; previewDuringRetry?: boolean }) {
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
      // A folder whose files shrank under the 4 KB floor: that ask draws nothing of its bytes, and is asked again with none.
      if (opts.smallFiles && asked.length === 1) return { root: { path: '/r', size: 100 }, nodes: [] };
      if (opts.previewDuringRetry) tmPreview.on = true;
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

test('C24 (review F1.5): a preview put up while a folder of small files is asked again with no floor keeps its picture too', async () => {
  const r = liveHarness({ preview: false, smallFiles: true, previewDuringRetry: true });
  await r.liveRelayout();
  assert.deepEqual(r.asked.map((u) => /minSize=(\d+)/.exec(u)![1]), ['4000', '1'], 'control: the 4 KB ask drew nothing, and the folder was asked again with none');
  assert.equal(r.state.treemap.nodes, r.previewNodes, 'the preview\'s hatched picture is not replaced under its banner when the second answer lands');
  assert.ok(r.state.live.dirty > 0, 'and the relayout is still owed');
  const n = liveHarness({ preview: false, smallFiles: true });
  await n.liveRelayout();
  assert.deepEqual([n.state.treemap.nodes.map((x) => x.path), n.state.treemap.minSize], [['/r/a'], 1], 'control: with no preview the second answer lands, with its floor');
});

/** The real liveRelayout, its morph (animateTreemapTo), and the cart preview, over animation frames run by hand. */
function morphHarness() {
  const rect = (path: string, size: number, x: number, w: number) => ({ name: path.slice(3), path, size, type: 'dir', depth: 1, expanded: false, x, y: 0, w, h: 100 });
  const before = [rect('/r/a', 40, 0, 40), rect('/r/b', 60, 40, 60)];
  const answers: Record<string, unknown>[][] = [];
  const frames = new Map<number, (t: number) => void>();
  let lastFrame = 0;
  let clock = 1000;
  const runFrames = (ms: number) => { clock += ms; const due = [...frames.values()]; frames.clear(); for (const f of due) f(clock); };
  const state = {
    scanId: 's1', scanning: false, view: 'treemap', root: { path: '/r' }, system: { homeDir: '/elsewhere' }, trash: { totalBytes: 0 },
    cart: new Set(['/r/a']), live: { on: true, dirty: 1 },
    treemap: { mode: 'treemap', rootPath: '/r', rootSize: 100, minSize: 4000, maxDepth: 4, nodes: before as Record<string, unknown>[], hover: null, kbSel: null, history: { active: false } },
  };
  const deps = {
    state, TM_MIN_SIZE: 4000, REDUCED: false, document: { hidden: false }, performance: { now: () => clock },
    requestAnimationFrame: (f: (t: number) => void) => { frames.set(++lastFrame, f); return lastFrame; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    drawTreemap() {}, isSun: () => false, isCells: () => false, isRectMap: () => true, animateSunburstTo() {}, drawCells() {}, sunburstRoot: () => null,
    // The disk moved: b grew, a shrank, and the server lays the folder out again.
    api: async () => { answers.push([rect('/r/b', 70, 0, 70), rect('/r/a', 30, 70, 30)]); return { root: { path: '/r', size: 100 }, nodes: answers.at(-1) }; },
    toast: (m: string) => { throw new Error(`the preview refused: ${m}`); }, tmPreviewRefusal: () => 'refused', hideTooltip() {}, syncCartPreviewChrome() {},
    cartNode: (p: string) => ({ size: p === '/r/a' ? 30 : 0 }),
  };
  const names = ['tmPreview', 'tmAnimFrame', 'tmWorstRatio', 'tmSquarify', 'tmParentPath', 'tmIsInside', 'tmDrawnTree', 'tmCartRoots', 'tmBuildPreview',
    'maybeInjectTrash', 'liveRelayout', 'animateTreemapTo', 'enterCartPreview', 'exitCartPreview',
    ...['tmMorph', 'tmSettleMorph'].filter((n) => INDEX.includes(`let ${n} =`) || INDEX.includes(`function ${n}(`))];
  const page = load<{ tmPreview: { on: boolean; saved: unknown }; liveRelayout: () => Promise<void>; enterCartPreview: () => void; exitCartPreview: () => void }>(
    names, deps, '{ tmPreview, liveRelayout, enterCartPreview, exitCartPreview }');
  /** A Live tick: the new layout morphs in over 260 ms. */
  const tick = async () => { state.live.dirty = 1; await page.liveRelayout(); return answers.at(-1)!; };
  return { state, page, frames, runFrames, tick };
}

test('C24 (review F1.7): Preview pressed while a live re-layout still morphs takes the map as it will stand — the morph never replaces the preview\'s picture, and Escape puts back the new layout', async () => {
  const h = morphHarness();
  const answered = await h.tick();
  h.runFrames(100); // 100 ms in
  assert.notEqual(h.state.treemap.nodes, answered, 'control: the map shows a frame of the morph');
  h.page.enterCartPreview(); // Preview after, pressed inside the morph
  const preview = h.state.treemap.nodes;
  assert.ok(h.page.tmPreview.on && preview.some((n) => n.freed), 'control: the preview is up, its staged block hatched');
  assert.equal(h.page.tmPreview.saved, answered, 'the preview took the map as the morph will leave it, never a frame of it');
  for (let i = 0; i < 10 && h.frames.size; i++) h.runFrames(50);
  assert.equal(h.state.treemap.nodes, preview, 'the morph\'s frames never replace the preview\'s picture under its banner');
  h.page.exitCartPreview(); // Escape
  assert.equal(h.state.treemap.nodes, answered, 'Escape puts back the new layout, not the frame Preview was pressed on');
  // Pressed before the morph's first frame: the same.
  const next = await h.tick();
  h.page.enterCartPreview();
  assert.equal(h.page.tmPreview.saved, next, 'pressed before the first frame, it takes the layout the morph ends on');
  const again = h.state.treemap.nodes;
  for (let i = 0; i < 10 && h.frames.size; i++) h.runFrames(50);
  assert.equal(h.state.treemap.nodes, again, 'and no frame replaces its picture');
  h.page.exitCartPreview();
});

test('C24 (review F1.7): a morph something else has stopped and drawn over is not landed by the preview — the map as it now stands is what it takes', async () => {
  const h = morphHarness();
  await h.tick();
  h.runFrames(100);
  // The Treemap left and entered again mid-morph: its unmount stopped the frames, and the map loaded afresh.
  h.frames.clear();
  const landed = [{ name: 'a', path: '/r/a', size: 50, type: 'dir', depth: 1, expanded: false, x: 0, y: 0, w: 50, h: 100 },
    { name: 'b', path: '/r/b', size: 50, type: 'dir', depth: 1, expanded: false, x: 50, y: 0, w: 50, h: 100 }];
  h.state.treemap.nodes = landed;
  h.page.enterCartPreview();
  assert.equal(h.page.tmPreview.saved, landed, 'the map that stands, never the stopped morph\'s end');
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
  const page = load<{ seek: (i: number) => Promise<void>; play: () => void }>(['setHistoryIndex', 'lapseStart', 'tmSettleMorph', 'tmStopMorph'], deps,
    '{ seek: setHistoryIndex, play: lapseStart }', 'let tmMorph = null;');
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
    ['treeScanId', 'TM_MIN_SIZE', 'loadTreemap', 'tmStopMorph'], deps, `{ loadTreemap, view: (${viewSource('treemap')}) }`, 'let tmLoadSeq = 0; let tmAnimFrame = 0; let tmMorph = null;');
  const out = page.loadTreemap('/r/A'); // a click on folder A
  page.view.unmount(); // Disk City opened before the answer landed
  state.view = 'city';
  answer({ root: { path: '/r/A', name: 'A', size: 60 }, nodes: [{ path: '/r/A/x', size: 60, depth: 1 }] });
  await out;
  assert.equal(state.treemap.rootPath, '/r', 'the shared root the city stands on is not rewritten to A');
  assert.deepEqual(state.treemap.nodes, [], 'nor its nodes');
});

/* ══════════════ The last round (HB2, 24 Oct 2026) ══════════════ */

/**
 * The real list of buildings, rebuilt as the page rebuilds it, over a host that behaves as a browser's does for focus:
 * the rebuild replaces every row button, and focus on one of them falls to <body> unless something hands it on.
 */
function cityTableFocus(blocks: { n: Record<string, unknown> }[]) {
  const body = { tag: 'body', focus() { doc.activeElement = body; } };
  const doc: { activeElement: unknown } = { activeElement: body };
  const canvas = { tag: 'cityCanvas', focus() { doc.activeElement = canvas; } };
  type Btn = { tag: string; dataset: { cityRow: string }; focus: () => void };
  const host = {
    buttons: [] as Btn[],
    set innerHTML(html: string) {
      const held = this.buttons.includes(doc.activeElement as Btn);
      this.buttons = [...html.matchAll(/data-city-row="(\d+)">([^<]*)</g)].map(([, i, label]) => {
        const b: Btn = { tag: label, dataset: { cityRow: i }, focus() { doc.activeElement = b; } };
        return b;
      });
      if (held) doc.activeElement = body; // a removed element's focus goes to <body>
    },
    contains(el: unknown) { return this.buttons.includes(el as Btn); },
    querySelector(sel: string) { const m = /^\[data-city-row="(\d+)"\]$/.exec(sel); return (m && this.buttons.find((b) => b.dataset.cityRow === m[1])) || null; },
  };
  const state = { city: { blocks, counts: new Map(), height: 'files' } };
  const render = load<() => void>(['escapeHtml', 'cityAgeDays', 'renderCityTable'], {
    state, document: doc, $: (id: string) => (id === 'cityTable' ? host : id === 'cityCanvas' ? canvas : null),
    formatCount: (k: number) => String(k), formatBytes: (b: number) => `${b} B`,
  }, 'renderCityTable');
  render();
  return { state, doc, host, body, canvas, render };
}

test('HB2 (L11): a rebuild of Disk City\'s list keeps focus on the building\'s row — and after a drill, on the city — never <body>', () => {
  const movies = { n: { name: 'Movies', path: '/home/u/Movies', size: 6e9, type: 'dir', depth: 1 } };
  const music = { n: { name: 'Music', path: '/home/u/Music', size: 2e9, type: 'dir', depth: 1 } };
  const t = cityTableFocus([movies, music]);
  t.host.buttons[1].focus(); // tabbed to Music
  t.state.city.counts.set('/home/u/Music', { files: 12 }); // Files height: a batch of counts lands
  t.render();
  assert.equal((t.doc.activeElement as { tag: string }).tag, 'Music', 'the rebuilt Music row holds focus, as the old one did');
  assert.ok(t.host.contains(t.doc.activeElement), 'and it is a row of the list now on screen');
  // A zoom that reorders the list keeps focus with the building, not the place.
  t.state.city.blocks = [music, movies];
  t.render();
  assert.equal((t.doc.activeElement as { tag: string }).tag, 'Music', 'the building\'s row, wherever it now stands');
  // A drill from the list: the new city lists other buildings, and focus goes to the city, as a crumb's does.
  t.state.city.blocks = [{ n: { name: 'Trailers', path: '/home/u/Music/Trailers', size: 1e9, type: 'dir', depth: 1 } }];
  t.render();
  assert.equal(t.doc.activeElement, t.canvas, 'the building pressed is not in the new list: focus goes to the city, never <body>');
  // Focus anywhere else is left where it is.
  t.body.focus();
  t.render();
  assert.equal(t.doc.activeElement, t.body, 'control: a rebuild takes no focus it did not hold');
});

/**
 * The real tmApplyQuery, tmSetQueryMessage and sayAloud over `mode`, the box's live region (#tmQuerySaid) recording
 * every time words go into it, a frame passing between applications as it does between pauses in typing.
 */
function typedAloud(mode: string, matches = 0) {
  const fills: string[] = [];
  const said = { _t: '', set textContent(v: string) { this._t = v; if (v) fills.push(v); }, get textContent() { return this._t; } };
  const el = () => ({ textContent: '', hidden: true, classList: { toggle() {} }, setAttribute() {} });
  const els: Record<string, unknown> = { tmQuerySaid: said, tmQueryErr: el(), tmSearch: el() };
  const frames: (() => void)[] = [];
  const state = { root: { path: '/r' }, treemap: { mode, query: '', queryMode: 'bare', matchedPaths: null, matchTotal: null as number | null, matches } };
  const apply = load<(q: string) => void>(['TM_GRAMMAR_FIELDS', 'TM_GRAMMAR_RE', 'TM_SUNBURST_BARE_WORDS', 'tmIsGrammarQuery', 'asSentences', 'sayAloud', 'tmSetQueryMessage', 'tmApplyQuery'], {
    state, $: (id: string) => els[id], requestAnimationFrame: (f: () => void) => { frames.push(f); },
    tmCancelQueries() {}, tmClearHits() {}, tmSyncQueryBar() {},
    isSun: () => mode === 'sunburst', isCells: () => mode === 'circles' || mode === 'voronoi',
    presentSunburst() {}, renderSearchOverlay() {}, renderCellsStatus() {}, presentCells() {}, presentTreemap() {},
    tmUnknownFieldHint: (q: string) => (q === 'sise' ? 'Did you mean size?' : null), tmRunGrammarQuery: async () => {},
  }, 'tmApplyQuery', 'const aloudSaid = new Map();');
  const type = (q: string) => { apply(q); while (frames.length) frames.shift()!(); };
  return { type, fills, box: els.tmQueryErr as { textContent: string } };
}

test('HB2 (L1, L8, L14): a plain word typed over the sunburst is said once — the same sentence at every pause is no news', () => {
  const t = typedAloud('sunburst');
  for (const q of ['n', 'no', 'nod', 'node']) t.type(q);
  assert.deepEqual(t.fills, ['The sunburst does not highlight matches. Switch to Treemap, Circles or Voronoi to see what matches.'],
    'four pauses, one announcement: the box is never emptied first, so its unchanged words are not said again');
  assert.equal(t.box.textContent, 'The sunburst does not highlight matches. Switch to Treemap, Circles or Voronoi to see what matches.');
  t.type('');
  assert.equal(t.box.textContent, '', 'control: an emptied box says nothing');
  t.type('node');
  assert.equal(t.fills.length, 2, 'control: after the box was emptied the sentence is news again');
  // The field hint over a renderer that highlights is said once too.
  const h = typedAloud('treemap');
  h.type('sise'); h.type('sise');
  assert.deepEqual(h.fills, ['Did you mean size?'], 'the same hint at the next pause is not said again');
});

/** What the box says, and the real functions that word a query's answer for the map now drawn. */
const REWORD_NAMES = ['TM_SUNBURST_BARE_WORDS', 'tmIsInside', 'tmUndrawnBreakdown', 'tmUndrawnMessage', 'tmSunburstQueryWords', 'tmQueryAnswerWords', 'tmSettledLiveMap', 'tmRewordQuery',
  ...['tmHiddenByCloud', 'tmCloudHiddenWords', 'tmCloudUpToo'].filter((n) => INDEX.includes(`function ${n}(`))];
const NINE = ['/r', '/r/a/x1', '/r/a/x2', '/r/b/y1', '/r/b/y2', '/r/b/y3', '/r/c/z1', '/r/c/z2', '/r/c/z3'];

function rewordHarness(mode: string) {
  const said: string[] = []; // what the box's live region says, frame by frame
  const live = { _t: '', set textContent(v: string) { this._t = v; if (v) said.push(v); }, get textContent() { return this._t; } };
  const box = { textContent: '', hidden: true, classList: { toggle() {} } };
  const els: Record<string, unknown> = { tmQueryErr: box, tmQuerySaid: live, tmSearch: { classList: { toggle() {} }, setAttribute() {} } };
  const frames: (() => void)[] = [];
  const preview = { on: false };
  const state = {
    view: 'treemap',
    pathIndex: new Map<string, { cloudPlaceholder?: boolean }>(),
    treemap: { mode, rootPath: '/r', query: 'size>1gb', queryMode: 'grammar', matchTotal: 9 as number | null, matchedPaths: new Set(NINE), matches: 3,
      hideCloud: false, nodes: [] as { path: string; cloudPlaceholder?: boolean }[],
      history: { active: false }, lapse: { playing: false }, cells: [] as unknown[], altNote: '' },
  };
  const page = load<{ reword: () => void; say: (t: string) => void; words: () => string; setMorph: (m: unknown) => void }>(
    [...REWORD_NAMES, 'asSentences', 'sayAloud', 'tmSetQueryMessage'], {
      state, tmPreview: preview, $: (id: string) => els[id], requestAnimationFrame: (f: () => void) => { frames.push(f); }, tmSyncQueryBar() {},
      formatCount: (n: number) => n.toLocaleString('en-US'), isSun: () => state.treemap.mode === 'sunburst',
    }, '{ reword: tmRewordQuery, say: tmSetQueryMessage, words: tmQueryAnswerWords, setMorph: (m) => { tmMorph = m; } }',
    'const aloudSaid = new Map(); let tmMorph = null; let tmLastHits = { q: "size>1gb", paths: ' + JSON.stringify(NINE) + ', total: 9, truncated: false, stage: null, degraded: [] };');
  const frame = () => { while (frames.length) frames.shift()!(); };
  page.say(page.words()); frame(); // what the answer said as it landed
  said.length = 0;
  const reword = () => { page.reword(); frame(); };
  return { ...page, reword, state, said, box, preview };
}

test('HB2 (L6, L12): the box\'s words about a grammar answer follow the map — raise Depth, drill or go up, and they speak of what is drawn now', () => {
  const t = rewordHarness('treemap');
  assert.equal(t.box.textContent, '9 matches — 3 shown here. One is this folder itself, which has no rectangle of its own; 5 are deeper than this view draws. Zoom in or raise Depth.');
  t.reword();
  assert.deepEqual(t.said, [], 'the same map, the same words: nothing is said again');
  t.state.treemap.matches = 8; // Depth raised as advised: the status line reads "8 of 9 matches"
  t.reword();
  assert.equal(t.box.textContent, '9 matches — 8 shown here. One is this folder itself, which has no rectangle of its own.',
    'never "3 shown here … raise Depth" beside a status line counting 8');
  t.state.treemap.rootPath = '/r/b'; t.state.treemap.matches = 3; // a drill into b
  t.reword();
  assert.equal(t.box.textContent, '9 matches — 3 shown here. 6 are elsewhere in the scan, outside this folder. Go up to see them.');
  t.state.treemap.rootPath = '/r'; t.state.treemap.matches = 9; // every match drawn
  t.reword();
  assert.equal(t.box.textContent, '', 'nothing left to explain: the box goes');
  // The sunburst speaks of the folder on screen too.
  const s = rewordHarness('sunburst');
  assert.match(s.box.textContent, /^9 matches — the sunburst does not highlight them\. One is this folder itself; 8 are in this folder\./);
  s.state.treemap.rootPath = '/r/a'; // an arc clicked
  s.reword();
  assert.equal(s.box.textContent, '9 matches — the sunburst does not highlight them. 7 are elsewhere in the scan, outside this folder; 2 are in this folder. ' +
    'Switch to Treemap, Circles or Voronoi to see the ones in this folder, and go up there for the rest.');
});

test('HB2 (L6, L12): the words are left alone where they speak of no answer on hand, or of a picture that is not the map', () => {
  const cases: [string, (t: ReturnType<typeof rewordHarness>) => void][] = [
    ['the answer cleared (the unmount, a failed query)', (t) => { t.state.treemap.matchTotal = null; }],
    ['newer text typed, its answer not in yet', (t) => { t.state.treemap.query = 'size>2gb'; }],
    ['the cart preview up, a picture of the cart', (t) => { t.preview.on = true; }],
    ['a morph still running', (t) => { t.setMorph({}); }],
    ['another view on screen', (t) => { t.state.view = 'city'; }],
    // The answer is the live scan's: what a snapshot draws holds other files (review F1.2, F1.4).
    ['a past snapshot on the map (the time slider)', (t) => { t.state.treemap.history.active = true; }],
    ['the time-lapse playing', (t) => { t.state.treemap.lapse.playing = true; }],
  ];
  for (const [what, arrange] of cases) {
    const t = rewordHarness('treemap');
    const before = t.box.textContent;
    arrange(t);
    t.state.treemap.matches = 8;
    t.reword();
    assert.equal(t.box.textContent, before, what);
  }
  const t = rewordHarness('treemap');
  t.setMorph({}); t.state.treemap.matches = 8; t.reword();
  t.setMorph(null); t.reword(); // the morph's last frame
  assert.deepEqual(t.said, ['9 matches — 8 shown here. One is this folder itself, which has no rectangle of its own.'], 'control: the morph\'s end words what it ended on, once');
  const past = rewordHarness('treemap');
  past.state.treemap.history.active = true; past.state.treemap.matches = 4; past.reword(); // a snapshot holding 4 of the 9
  past.state.treemap.history.active = false; past.state.treemap.matches = 8; past.reword(); // back to Live: the map lands through drawView
  assert.deepEqual(past.said, ['9 matches — 8 shown here. One is this folder itself, which has no rectangle of its own.'],
    'control: never "5 are deeper" of files the snapshot does not hold, and worded once back on the live map');
  const typed = rewordHarness('treemap');
  typed.state.treemap.query = '  size>1gb '; typed.state.treemap.matches = 8; typed.reword();
  assert.equal(typed.said.length, 1, 'control: the text in the box, spaced, is the query answered');
  // A plain word over a renderer that highlights: the box is tmApplyQuery's (its field hint, or nothing), left as it is.
  const bare = rewordHarness('treemap');
  bare.state.treemap.queryMode = 'bare'; bare.state.treemap.query = 'sise'; bare.state.treemap.matchTotal = null;
  bare.say('Did you mean size?');
  bare.reword();
  assert.equal(bare.box.textContent, 'Did you mean size?', 'a plain word over the Treemap keeps what tmApplyQuery said of it');
});

test('HB2 (L6, L12): the map\'s every repaint words the box — drawView after any renderer, and the overlay once it has counted', () => {
  const order: string[] = [];
  for (const mode of ['treemap', 'sunburst', 'circles']) {
    order.length = 0;
    const drawView = load<() => void>(['drawView'], {
      state: { treemap: { colorMode: 'size' } }, isSun: () => mode === 'sunburst', isCells: () => mode === 'circles',
      drawSunburst: () => order.push('draw'), drawCells: () => order.push('draw'), drawTreemap: () => order.push('draw'),
      fetchScoresForTreemap() {}, tmRewordQuery: () => order.push('reword'),
    }, 'drawView');
    drawView();
    assert.deepEqual(order, ['draw', 'reword'], `${mode}: the box is worded after the draw`);
  }
  for (const mode of ['treemap', 'circles']) {
    const counted: number[] = [];
    const h = overlayHarness(mode, { tmRewordQuery: () => counted.push(h.state.treemap.matches) });
    if (mode === 'circles') h.state.treemap.cells = [{ depth: 1, kind: 'circle', cx: 0, cy: 0, r: 1, n: { path: '/r/a' } }] as never;
    h.renderSearchOverlay();
    assert.deepEqual(counted, [mode === 'circles' ? 1 : 2], `${mode}: worded once, with the count just made — never with the 0 it starts from`);
  }
});

test('HB2 review (F1.6): over Circles or Voronoi the box is worded once the layout settles — never at each slice of a layout still being laid out', () => {
  // Both renderers, judged by the page's own isCells, and a layout that settles on a note of its own — nearly every
  // real one does (altNoteFor) — which is no layout still being laid out (review HB2-L3).
  const SETTLED_NOTE = '2 items (4 B) too small to draw at this size — drill in to see them';
  for (const mode of ['circles', 'voronoi']) {
    const said: string[] = []; // what the box's live region says
    const live = { _t: '', set textContent(v: string) { this._t = v; if (v) said.push(v); }, get textContent() { return this._t; } };
    const box = { textContent: '', hidden: true, classList: { toggle() {} } };
    const els: Record<string, unknown> = { tmQueryErr: box, tmQuerySaid: live, tmSearch: { classList: { toggle() {} }, setAttribute() {} }, tmStatus: { textContent: '' } };
    const frames: (() => void)[] = [];
    const shape = (path: string, depth: number) => ({ n: { path }, depth, kind: 'circle', cx: 0, cy: 0, r: 1 });
    // One layout's slices, breadth first: the shapes laid so far grow, and the matches among them with them — 0, 1, 2, 4, 6,
    // then all 8 of the 9 that can be drawn (the ninth is the folder on screen itself).
    const slices = [0, 1, 2, 4, 6, 8].map((k, i, all) => ({
      cells: [shape('/r', 0), ...NINE.slice(1, 1 + k).map((p) => shape(p, 2))], done: i === all.length - 1, note: i === all.length - 1 ? SETTLED_NOTE : '', resume: {},
    }));
    let next = 0;
    const state = {
      view: 'treemap', pathIndex: new Map(),
      treemap: { mode, rootPath: '/r', query: 'size>1gb', queryMode: 'grammar', matchTotal: 9, matchedPaths: new Set(NINE), matches: 0,
        hideCloud: false, nodes: [], history: { active: false }, lapse: { playing: false }, cells: [] as unknown[], altNote: '', altMs: 0,
        altRaf: 0, altZoomRaf: 0, altZoom: null, colorMode: 'size', rootSize: 100 },
    };
    const noop = () => {};
    const drawView = load<() => void>([...REWORD_NAMES, 'asSentences', 'sayAloud', 'tmSetQueryMessage', 'renderSearchOverlay', 'updateTmStatus',
      'isCells', 'altRefiningNote', 'buildCells', 'altRefineSchedule', 'repaintCells', 'drawCells', 'drawView',
      ...['altLayoutRefining'].filter((n) => INDEX.includes(`function ${n}(`))], {
      state, tmPreview: { on: false }, $: (id: string) => els[id], tmSyncQueryBar: noop,
      requestAnimationFrame: (f: () => void) => frames.push(f), cancelAnimationFrame: noop, performance: { now: () => 0 },
      formatCount: (n: number) => n.toLocaleString('en-US'), formatBytes: (b: number) => `${b} B`, formatWhen: () => 'then',
      isSun: () => false,
      tmSearchBuffer: { width: 1, height: 1 }, tmBuffer: { width: 1, height: 1 }, tmSearchCtx: ctxStub(), tmBufCtx: ctxStub(),
      window: { devicePixelRatio: 1 }, document: { documentElement: { dataset: { theme: 'dark' } } }, cssVar: () => '#0A84FF',
      treemapMatch: () => false, tmKidsOf: () => new Map(), altCellPath: noop,
      sunburstRoot: () => ({ path: '/r' }), altRefineCancel: noop, fxShapeSync: noop, tmSizeCanvas: () => ({ cssW: 100, cssH: 100, dpr: 1 }),
      layoutCirclePack: () => slices[next++], layoutVoronoi: () => slices[next++],
      drawPackedCircle: noop, drawVoronoiCell: noop, altDrawLabels: noop, presentCells: noop, renderCellsStatus: noop, paintCells: noop,
      renderTmLegend: noop, renderAltNote: noop, altNoteSettled: noop, fetchScoresForTreemap: noop,
    }, 'drawView', 'const aloudSaid = new Map(); let tmMorph = null; let altRefineSeq = 0; let altNoteRefitDue = false; let altNoteRefitting = false; ' +
      'let tmLastHits = { q: "size>1gb", paths: ' + JSON.stringify(NINE) + ', total: 9, truncated: false, stage: null, degraded: [] };');
    drawView(); // a drill, Depth or Hide cloud: the layout's first slice, then one slice a frame
    while (frames.length) frames.shift()!();
    assert.equal(next, slices.length, `${mode}: control — every slice of the layout ran`);
    assert.equal(state.treemap.altNote, SETTLED_NOTE, `${mode}: control — the layout settled on its own note`);
    assert.equal(state.treemap.matches, 8, `${mode}: control — the settled layout draws 8 of the 9`);
    assert.deepEqual(said, ['9 matches — 8 shown here. One is this folder itself, which has no rectangle of its own.'],
      'one sentence, of the settled map: never "8 are deeper than this view draws. Zoom in or raise Depth." of a half-laid one, nor a new one each slice');
    assert.equal(box.textContent, said[0]);
  }
});

test('HB2 review (HB2-L4): back on Live from a past snapshot, the real loadTreemap lands the map — out of history first, then drawView — and the box is worded of the live map that landed', async () => {
  // The order the `past` control above stands in for, run: loadTreemap's landing calls exitHistoryState, then drawView,
  // whose tmRewordQuery words the box. Called the other way round, tmRewordQuery saw history.active and returned, and
  // nothing repainted after it: the box kept the words it had.
  const said: string[] = [];
  const live = { _t: '', set textContent(v: string) { this._t = v; if (v) said.push(v); }, get textContent() { return this._t; } };
  const box = { textContent: '', hidden: true, classList: { toggle() {} } };
  const els: Record<string, unknown> = { tmQueryErr: box, tmQuerySaid: live, tmSearch: { classList: { toggle() {} }, setAttribute() {} }, tmTimeSlider: { value: '0', max: '2' }, tmUpBtn: {} };
  const state = {
    scanId: 's1', scanning: false, view: 'treemap', root: { path: '/r', name: 'r', size: 100 }, pathIndex: new Map(),
    treemap: { mode: 'treemap', rootPath: '/r', rootName: 'r', rootSize: 100, maxDepth: 4, query: 'size>1gb', queryMode: 'grammar', matchTotal: 9,
      matchedPaths: new Set(NINE), matches: 3, hideCloud: false, nodes: [] as unknown[], nodesFor: null, hover: null, kbSel: null, colorMode: 'size',
      cells: [] as unknown[], altNote: '', history: { active: true, scrubbing: false, snaps: [], index: 0, cache: new Map(), seq: 0 },
      lapse: { playing: false, seq: 0, raf: 0, onDone: null } },
  };
  const noop = () => {};
  const frames: (() => void)[] = [];
  const page = load<{ load: (p: string) => Promise<void> }>(
    [...REWORD_NAMES, 'asSentences', 'sayAloud', 'tmSetQueryMessage', 'drawView', 'exitHistoryState', 'loadTreemap'], {
      state, tmPreview: { on: false }, $: (id: string) => els[id] || { classList: { add() {}, remove() {} }, disabled: false },
      requestAnimationFrame: (f: () => void) => { frames.push(f); return 1; }, cancelAnimationFrame: noop, tmSyncQueryBar: noop, formatCount: (n: number) => n.toLocaleString('en-US'),
      isSun: () => false, isCells: () => false, REDUCED: true, exitCartPreview: noop, renderCrumbs: noop, maybeInjectTrash: noop, refreshTimebar: noop,
      upDisabledKeepFocus: noop, tmSetEmpty: noop, fetchScoresForTreemap: noop, kbDropUndrawn: noop,
      api: async () => ({ root: { path: '/r', name: 'r', size: 100 }, nodes: [{ path: '/r/a', depth: 1 }] }), reportError: (e: Error) => { throw e; },
      treeScanId: () => 's1', tmCanvas: {}, TM_MIN_SIZE: 4096, updateTimeLabel: noop, lapseStop: noop,
      drawTreemap() { state.treemap.matches = 8; }, drawSunburst: noop, drawCells: noop, altCircleFor: noop, ensureSubtree: async () => null,
      tmHeldTreemap: async () => null, tmStopMorph: noop,
    }, '{ load: loadTreemap }',
    'const aloudSaid = new Map(); let tmMorph = null; let tmLoadSeq = 0; ' +
    'let tmLastHits = { q: "size>1gb", paths: ' + JSON.stringify(NINE) + ', total: 9, truncated: false, stage: null, degraded: [] };');
  box.textContent = 'THE WORDS IT HAD'; // scrubbed to a snapshot, the box still holds what it last said
  await page.load('/r');
  for (let i = 0; i < 10 && frames.length; i++) frames.splice(0).forEach((f) => f()); // the live region speaks a frame later
  assert.equal(state.treemap.history.active, false, 'control: back on Live');
  assert.equal(box.textContent, '9 matches — 8 shown here. One is this folder itself, which has no rectangle of its own.', 'the box is worded of the live map that landed');
  assert.deepEqual(said, [box.textContent], 'and said once');
});

test('HB2 review (F1.10): over the sunburst an empty box stays empty — a repaint never tells it the sunburst highlights no matches', () => {
  for (const text of ['', '   ']) {
    const t = rewordHarness('sunburst');
    t.state.treemap.queryMode = 'bare';
    t.state.treemap.query = text; // nothing typed, or only spaces
    t.say(''); // the box as an empty query leaves it
    t.said.length = 0;
    t.reword();
    assert.equal(t.box.textContent, '', `${JSON.stringify(text)}: nothing typed, nothing said in the box`);
    assert.deepEqual(t.said, [], `${JSON.stringify(text)}: and nothing said aloud`);
  }
  const w = rewordHarness('sunburst');
  w.state.treemap.queryMode = 'bare';
  w.state.treemap.query = 'node_modules';
  w.reword();
  assert.equal(w.box.textContent, 'The sunburst does not highlight matches. Switch to Treemap, Circles or Voronoi to see what matches.', 'control: a word typed is told');
});

test('HB2 (L2, L7, L10): a plain word over the sunburst is told again on the way back into the Treemap', () => {
  const said: string[] = [];
  const box = { textContent: '' };
  const noop = () => {};
  const el = () => ({ hidden: false, textContent: '', classList: { add: noop, remove: noop, toggle: noop } });
  const els: Record<string, unknown> = { tmQueryErr: box };
  const state = {
    view: 'treemap', root: { path: '/r' }, scanning: false, scanId: 's1', live: { on: false }, lens: { held: false, at: null },
    treemap: { mode: 'sunburst', colorMode: 'size', rootPath: '/r', query: 'node_modules', queryMode: 'bare', queryScanId: null, matchTotal: null as number | null,
      matchedPaths: null, matches: 0, altZoomRaf: 0, altZoom: null, cells: [], altNote: '', history: { active: false }, lapse: { playing: false } },
  };
  const deps: Record<string, unknown> = {
    state, $: (id: string) => (els[id] ||= el()), tmPreview: { on: false }, formatCount: String, isSun: () => state.treemap.mode === 'sunburst',
    isCells: () => false, drawSunburst: noop, drawCells: noop, drawTreemap: noop, fetchScoresForTreemap: noop,
    tmSetQueryMessage: (t: string) => { said.push(t); box.textContent = t; }, tmApplyQuery: noop, tmSyncStageButton: noop,
    fxTmPillBeamsSync: noop, loadSavedViews: noop, refreshDock: noop, tmRejudgeQueryWait: noop,
    tmCancelQueries: noop, tmCloseHints: noop, nlClose: noop, exitCartPreview: noop, disableLive: noop,
    cancelAnimationFrame: noop, altRefineCancel: noop, lapseStop: noop, clearTimeout: noop, tmResizeDeb: 0, lassoCancel: noop,
  };
  const view = load<{ mount: () => void; unmount: () => void }>([...REWORD_NAMES, 'drawView', 'treeScanId', 'tmClearHits', 'tmRejudgeQuery', 'tmStopMorph'], deps,
    `(${viewSource('treemap')})`,
    // The sunburst's load, as loadTreemap's sunburst branch ends: through drawView.
    'let tmLoadSeq = 0; let tmAnimFrame = 0; let tmMorph = null; let tmLastHits = { q: "", paths: [], total: 0, truncated: false, stage: null }; function loadTreemap() { drawView(); }');
  view.mount();
  assert.equal(box.textContent, 'The sunburst does not highlight matches. Switch to Treemap, Circles or Voronoi to see what matches.', 'control: said as the view first drew');
  view.unmount(); // to the Dashboard: the box is emptied
  state.view = 'dashboard';
  assert.equal(box.textContent, '');
  state.view = 'treemap';
  view.mount(); // and back
  assert.equal(box.textContent, 'The sunburst does not highlight matches. Switch to Treemap, Circles or Voronoi to see what matches.',
    'the word still in the box is told again that the sunburst highlights none — never a silent box');
  assert.equal(said.filter((t) => t).length, 2, 'said once on each entry, never twice');
});

/** The real expandContainerNode, its POST held until `answer` is called. */
function expandHarness() {
  let answer: (v: unknown) => void = () => {};
  const loaded: string[] = [];
  const toasts: string[] = [];
  const zip = { name: 'a.zip', path: '/r/a.zip', size: 10, type: 'file', container: 'zip' };
  const state = { view: 'treemap', scanId: 's1', treemap: { rootPath: '/r' }, pathIndex: new Map<string, unknown>([[zip.path, { ...zip }]]) };
  // A map load takes the next tmLoadSeq as it is asked, as loadTreemap does; the folder's rootPath moves only when its map lands.
  const page = load<{ expand: (n: unknown) => Promise<void>; click: (p: string) => void }>(['treeScanId', 'expandContainerNode'], {
    state, $: () => ({ textContent: '' }), api: () => new Promise((land) => { answer = land; }),
    noteLoad: (p: string) => { loaded.push(p); }, toast: (m: string) => { toasts.push(m); }, formatCount: String, updateTmStatus() {},
  }, '{ expand: expandContainerNode, click: loadTreemap }', 'let tmLoadSeq = 0; function loadTreemap(p) { ++tmLoadSeq; noteLoad(p); }');
  const run = (arrange: (s: typeof state, click: (p: string) => void) => void) => {
    const out = page.expand(zip);
    arrange(state, page.click); // what happens while the archive is listed
    answer({ children: [{ path: '/r/a.zip/x', name: 'x', size: 10, type: 'file', virtual: true }], entryCount: 1, truncated: false });
    return out;
  };
  return { run, loaded, toasts, state };
}

test('HB2 (L5): an archive opened in the Treemap is gone into only while the Treemap still shows the folder it was clicked in', async () => {
  const stay = expandHarness();
  await stay.run(() => {});
  assert.deepEqual(stay.loaded, ['/r/a.zip'], 'control: still here, the archive opens');
  const left = expandHarness();
  await left.run((s) => { s.view = 'city'; }); // Disk City opened before the listing came back
  assert.deepEqual(left.loaded, [], 'never a map load under the view that took its place — it rewrites the root Disk City stands on');
  assert.deepEqual(left.toasts, ['Opened a.zip — 1 entry'], 'the archive was opened, and is said to be: it opens at once next time');
  const moved = expandHarness();
  await moved.run((s, click) => { click('/r/b'); s.treemap.rootPath = '/r/b'; }); // another folder clicked meanwhile, its map landed
  assert.deepEqual(moved.loaded, ['/r/b'], 'nor over the folder the user went to since');
  // HB2 review (F1.12): the folder's map still out when the listing answers.
  const asked = expandHarness();
  await asked.run((_s, click) => { click('/r/B'); }); // folder B clicked: its map is asked, rootPath still /r
  assert.deepEqual(asked.loaded, ['/r/B'], 'the folder clicked last is where the user goes — the archive\'s load never supersedes the one asked after it');
  assert.deepEqual(asked.toasts, ['Opened a.zip — 1 entry'], 'opened all the same, and said to be');
});

/** The real animateTreemapTo / animateSunburstTo and loadTreemap, over animation frames run by hand. */
function morphLandHarness(mode: string) {
  const rect = (path: string, x: number, w: number) => ({ name: path.slice(path.lastIndexOf('/') + 1), path, size: w, type: 'dir', depth: 1, expanded: false, x, y: 0, w, h: 100 });
  const frames = new Map<number, (t: number) => void>();
  let lastFrame = 0;
  let clock = 1000;
  const runFrames = (ms: number) => { clock += ms; const due = [...frames.values()]; frames.clear(); for (const f of due) f(clock); };
  const sunDrawn: string[] = [];
  const nodeB = { path: '/r/B', name: 'B', size: 50, type: 'dir', children: [] };
  const state = {
    scanId: 's1', scanning: false, view: 'treemap', root: { path: '/r', name: 'r', size: 100 }, pathIndex: new Map<string, unknown>([['/r/B', nodeB]]),
    treemap: { mode, rootPath: '/r', rootName: 'r', rootSize: 100, maxDepth: 4, nodes: [rect('/r/a', 0, 50), rect('/r/b', 50, 50)] as unknown[], nodesFor: null as unknown,
      hover: null, kbSel: null, history: { scrubbing: false, active: false }, arcs: [{ n: { path: '/r/a' }, a0: 0, a1: 1, rInner: 1, rOuter: 2 }] },
  };
  const deps = {
    state, REDUCED: false, document: { hidden: false }, performance: { now: () => clock },
    requestAnimationFrame: (f: (t: number) => void) => { frames.set(++lastFrame, f); return lastFrame; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    $: () => ({ classList: { add() {}, remove() {} }, disabled: false }), isSun: () => mode === 'sunburst', isCells: () => false, exitCartPreview() {},
    api: async () => ({ root: { path: '/r/B', name: 'B', size: 50 }, nodes: [rect('/r/B/x', 0, 100)] }),
    ensureSubtree: async (p: string) => state.pathIndex.get(p), renderCrumbs() {}, maybeInjectTrash() {}, exitHistoryState() {}, refreshTimebar() {},
    tmSetEmpty() {}, drawView() { if (mode === 'sunburst') sunDrawn.push(state.treemap.rootPath); }, reportError(e: Error) { throw e; }, tmCanvas: {},
    drawTreemap() {}, sunburstGeometry: () => ({}), layoutSunburstArcs: () => [{ n: { path: '/r/a' }, a0: 0, a1: 2, rInner: 1, rOuter: 2 }],
    renderSunburstFrame: (root: { path: string }) => { sunDrawn.push(root.path); },
  };
  const names = ['tmAnimFrame', 'tmMorph', 'animateTreemapTo', 'animateSunburstTo', 'treeScanId', 'TM_MIN_SIZE', 'loadTreemap',
    ...['tmStopMorph'].filter((n) => INDEX.includes(`function ${n}(`))];
  const page = load<{ animateTreemapTo: (n: unknown[]) => void; animateSunburstTo: (r: unknown) => void; loadTreemap: (p: string) => Promise<void>; morph: () => unknown }>(
    names, deps, '{ animateTreemapTo, animateSunburstTo, loadTreemap, morph: () => tmMorph }', 'let tmLoadSeq = 0;');
  return { state, page, frames, runFrames, sunDrawn, rect };
}

test('HB2 (L4, L13): a map that lands during a morph stays — the morph\'s last frames never put the older layout back under the new folder', async () => {
  const h = morphLandHarness('treemap');
  h.page.animateTreemapTo([h.rect('/r/a', 0, 70), h.rect('/r/b', 70, 30)]); // a live re-layout of /r begins its 260 ms morph
  h.runFrames(100);
  await h.page.loadTreemap('/r/B'); // folder B clicked inside the morph: its map lands
  const landed = h.state.treemap.nodes;
  assert.deepEqual((landed as { path: string }[]).map((n) => n.path), ['/r/B/x'], 'control: B\'s map landed');
  // HB2 review (F1.8): tmRewordQuery holds the box's words while a morph is set, so the landing leaves none set behind.
  assert.equal(h.page.morph(), null, 'no morph is left set by the landing — the box\'s words, held while one runs, follow B\'s map');
  for (let i = 0; i < 10 && h.frames.size; i++) h.runFrames(50);
  assert.equal(h.state.treemap.nodes, landed, 'B\'s rectangles stay under B\'s crumbs — never /r\'s, for a click to jump sideways from');
  // The sunburst's sweep likewise: its frames draw the folder it began on.
  const s = morphLandHarness('sunburst');
  s.page.animateSunburstTo({ path: '/r', name: 'r', size: 100 });
  s.runFrames(100);
  await s.page.loadTreemap('/r/B');
  s.sunDrawn.length = 0;
  for (let i = 0; i < 10 && s.frames.size; i++) s.runFrames(50);
  assert.deepEqual(s.sunDrawn, [], 'no frame of /r is drawn over B\'s sunburst');
});

/** The real animateTreemapTo with `names`, over frames run by hand: a live re-layout's morph, one frame in, then a door out of it. */
function morphDoorHarness<T>(names: string[], deps: Record<string, unknown>, returns: string, prelude = '') {
  const rect = (path: string, x: number, w: number) => ({ name: path.slice(3), path, size: w, type: 'dir', depth: 1, expanded: false, x, y: 0, w, h: 100 });
  const frames = new Map<number, (t: number) => void>();
  let lastFrame = 0;
  let clock = 1000;
  const state = deps.state as { treemap: { nodes: unknown[] } };
  state.treemap.nodes = [rect('/r/a', 0, 50), rect('/r/b', 50, 50)];
  const page = load<T & { animateTreemapTo: (n: unknown[]) => void; morph: () => unknown }>(['tmAnimFrame', 'tmMorph', 'animateTreemapTo', 'tmStopMorph', ...names], {
    REDUCED: false, document: { hidden: false }, performance: { now: () => clock },
    requestAnimationFrame: (f: (t: number) => void) => { frames.set(++lastFrame, f); return lastFrame; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    drawTreemap() {}, ...deps,
  }, `{ animateTreemapTo, morph: () => tmMorph, ${returns} }`, prelude);
  const to = [rect('/r/a', 0, 70), rect('/r/b', 70, 30)];
  page.animateTreemapTo(to);
  clock += 100; for (const [id, f] of [...frames]) { frames.delete(id); f(clock); } // one frame of its 260 ms
  assert.ok(page.morph(), 'control: the morph is running');
  return { page, frames, to, state };
}

test('HB2 review (F1.11): every door that cancels a morph\'s frames leaves no morph running behind — the box is never held waiting on a last frame that will not come', () => {
  // Play pressed inside a Live re-layout's morph, and Stop before a snapshot was drawn.
  const said: string[] = [];
  const live = { _t: '', set textContent(v: string) { this._t = v; if (v) said.push(v); }, get textContent() { return this._t; } };
  const els: Record<string, unknown> = { tmQueryErr: { textContent: '', hidden: true, classList: { toggle() {} } }, tmQuerySaid: live,
    tmSearch: { classList: { toggle() {} }, setAttribute() {} }, tmTimeSlider: { value: '2' } };
  const lapseState = {
    view: 'treemap', live: { on: false }, pathIndex: new Map(),
    treemap: { mode: 'treemap', rootPath: '/r', query: 'size>1gb', queryMode: 'grammar', matchTotal: 9, matchedPaths: new Set(NINE), matches: 3, hideCloud: false,
      nodes: [] as unknown[], cells: [], altNote: '', history: { active: false, snaps: [{ id: 1, takenAt: 1 }, { id: 2, takenAt: 2 }], index: 2, cache: new Map() },
      lapse: { playing: false, seq: 0, raf: 0, pos: 0, speed: 1, loop: false, completed: false, onDone: null } },
  };
  const a = morphDoorHarness<{ play: () => void; stop: () => void; reword: () => void }>(
    [...REWORD_NAMES, 'asSentences', 'sayAloud', 'tmSetQueryMessage', 'lapseStart', 'lapseStop', ...['tmSettleMorph'].filter((n) => INDEX.includes(`function ${n}(`))], {
      state: lapseState, tmPreview: { on: false }, $: (id: string) => els[id], tmSyncQueryBar() {}, formatCount: (n: number) => n.toLocaleString('en-US'),
      isSun: () => false, isCells: () => false, isRectMap: () => true, exitCartPreview() {}, disableLive() {}, toast() {}, lapseReflect() {}, lapsePrefetch() {},
      lapseExporting: false, lapseInternalStart: false,
    }, 'play: lapseStart, stop: lapseStop, reword: tmRewordQuery',
    'const aloudSaid = new Map(); let tmLastHits = { q: "size>1gb", paths: ' + JSON.stringify(NINE) + ', total: 9, truncated: false, stage: null, degraded: [] };');
  a.page.play();
  a.page.stop();
  a.frames.clear(); // the box's words land a frame after
  assert.equal(a.page.morph(), null, 'Play: the morph its transport cancelled is not left running');
  assert.equal(a.state.treemap.nodes, a.to, 'and the map stands on the layout the morph was going to — never a blend of two, left up');
  lapseState.treemap.matches = 8; // Hide cloud turned off: drawView words the box
  a.page.reword();
  assert.equal((els.tmQueryErr as { textContent: string }).textContent, '9 matches — 8 shown here. One is this folder itself, which has no rectangle of its own.',
    'the box follows the map again — a morph left set held its words until the next map landed');
  // The sunburst's sweep starts on the frame the rectangle map's morph was using.
  const b = morphDoorHarness<{ sweep: (r: unknown) => void }>(['animateSunburstTo'], {
    state: { treemap: { arcs: [] } }, sunburstGeometry: () => ({}), layoutSunburstArcs: () => [], renderSunburstFrame() {},
  }, 'sweep: animateSunburstTo');
  b.page.sweep({ path: '/r' });
  assert.equal(b.page.morph(), null, 'the sunburst\'s sweep: the rectangle map\'s morph it cancelled is not left running');
  // A scrub's sweep of the sunburst sets no morph, and Play still stops it: the transport steps the sunburst itself.
  const sweepFrames = new Map<number, (t: number) => void>();
  let sweepFrame = 0;
  const sunState = { ...lapseState, treemap: { ...lapseState.treemap, mode: 'sunburst', arcs: [{ n: { path: '/r/a' }, a0: 0, a1: 1, rInner: 1, rOuter: 2 }],
    lapse: { ...lapseState.treemap.lapse, playing: false } } };
  const sun = load<{ sweep: (r: unknown) => void; play: () => void }>(['tmAnimFrame', 'tmMorph', 'tmStopMorph', 'animateSunburstTo', 'lapseStart',
    ...['tmSettleMorph'].filter((n) => INDEX.includes(`function ${n}(`))], {
    state: sunState, REDUCED: false, document: { hidden: false }, performance: { now: () => 0 }, $: (id: string) => els[id],
    requestAnimationFrame: (f: (t: number) => void) => { sweepFrames.set(++sweepFrame, f); return sweepFrame; },
    cancelAnimationFrame: (id: number) => { sweepFrames.delete(id); }, drawTreemap() {},
    sunburstGeometry: () => ({}), layoutSunburstArcs: () => [{ n: { path: '/r/a' }, a0: 0, a1: 2, rInner: 1, rOuter: 2 }], renderSunburstFrame() {},
    isRectMap: () => false, exitCartPreview() {}, disableLive() {}, toast() {}, lapseReflect() {}, lapsePrefetch() {}, lapseExporting: false, lapseInternalStart: false,
  }, '{ sweep: animateSunburstTo, play: lapseStart }');
  sun.sweep({ path: '/r' });
  const sweepTick = [...sweepFrames.keys()];
  sun.play();
  assert.ok(sweepTick.length === 1 && !sweepFrames.has(sweepTick[0]), 'Play stops the sunburst\'s sweep, as it always did');
  // Leaving the Treemap mid-morph.
  const noop = () => {};
  const c = morphDoorHarness<{ view: { unmount: () => void } }>([], {
    state: { view: 'treemap', live: { on: false }, lens: { held: false, at: null }, treemap: { altZoomRaf: 0, altZoom: null, cells: [], pxRects: [], arcs: [] } },
    $: () => ({ hidden: false, textContent: '', classList: { toggle() {}, add() {}, remove() {} } }),
    tmCancelQueries: noop, tmCloseHints: noop, tmClearHits: noop, nlClose: noop, exitCartPreview: noop, tmSetQueryMessage: noop, disableLive: noop,
    altRefineCancel: noop, lapseStop: noop, clearTimeout: noop, tmResizeDeb: 0, lassoCancel: noop, fxTmPillBeamsSync: noop,
  }, `view: (${viewSource('treemap')})`, 'let tmLoadSeq = 0;');
  c.page.view.unmount();
  assert.equal(c.frames.size, 0, 'control: its frames are stopped');
  assert.equal(c.page.morph(), null, 'the unmount: no morph is left running for the next visit\'s box to wait on');
});

test('HB2 (L9): j/k never move through what an earlier renderer drew — a renderer switch, and leaving the Treemap, take the drawn set with them', async () => {
  const oldChild = { path: '/home/u/A/old-child', name: 'old-child', size: 5, type: 'dir', depth: 1 };
  const bKid = { path: '/home/u/B/c', name: 'c', size: 3, type: 'dir' };
  const B = { path: '/home/u/B', name: 'B', size: 3, type: 'dir', children: [bKid] };
  const el = () => ({ disabled: false, hidden: false, textContent: '', value: '', querySelectorAll: () => [], setAttribute() {}, classList: { toggle() {}, add() {}, remove() {} } });
  const els: Record<string, ReturnType<typeof el>> = {};
  const state = {
    view: 'treemap', lens: { held: false }, root: { path: '/home/u' }, pathIndex: new Map<string, unknown>([[B.path, B]]),
    treemap: { mode: 'sunburst', rootPath: '/home/u/B', history: { active: false }, altZoomRaf: 0, altZoom: null, cells: [] as unknown[], altNote: '', hover: null,
      queryMode: 'bare', query: '', kbSel: null,
      pxRects: [{ n: oldChild }] as unknown[], // the rectangle map drawn at A, before the sunburst
      arcs: [{ n: bKid, depth: 1 }] as unknown[] },
  };
  const deps = {
    state, TM_MODES: ['treemap', 'sunburst', 'circles', 'voronoi'], $: (id: string) => (els[id] ||= el()),
    lapseStop() {}, lensSetPinned() {}, lassoCancel() {}, cancelAnimationFrame() {}, altRefineCancel() {}, renderAltNote() {}, lapseSeekTo() {},
    localStorage: { setItem() {} }, loadTreemap: () => new Promise(() => {}), tmApplyQuery() {}, // the new renderer's map is still being asked
    isSun: () => state.treemap.mode === 'sunburst', isCells: () => state.treemap.mode === 'circles' || state.treemap.mode === 'voronoi',
  };
  const page = load<{ setTreemapView: (m: string) => void; kbSiblings: () => unknown[] }>(['setTreemapView', 'kbSiblings'], deps, '{ setTreemapView, kbSiblings }');
  assert.deepEqual(page.kbSiblings(), [bKid], 'control: over the sunburst, its arcs');
  page.setTreemapView('treemap');
  assert.deepEqual(page.kbSiblings(), [], 'until the rectangle map draws B, nothing — never A\'s old-child, nowhere on screen');
  state.treemap.pxRects = [{ n: { ...bKid, depth: 1 } }];
  assert.equal(page.kbSiblings().length, 1, 'control: once it has drawn, its rectangles');
  page.setTreemapView('sunburst');
  assert.deepEqual(page.kbSiblings(), [], 'back in the sunburst before it draws: never the arcs it drew last time');
  // And leaving the Treemap: what it drew is no map on the way back in, until the map lands again.
  state.treemap.pxRects = [{ n: oldChild }]; state.treemap.arcs = [{ n: bKid, depth: 1 }];
  const noop = () => {};
  const unmount = load<{ unmount: () => void }>(['tmStopMorph'], {
    state: { ...state, live: { on: false }, lens: { held: false, at: null } }, $: (id: string) => (els[id] ||= el()),
    tmCancelQueries: noop, tmCloseHints: noop, tmClearHits: noop, nlClose: noop, exitCartPreview: noop, tmSetQueryMessage: noop, disableLive: noop,
    cancelAnimationFrame: noop, altRefineCancel: noop, lapseStop: noop, clearTimeout: noop, tmResizeDeb: 0, lassoCancel: noop, fxTmPillBeamsSync: noop,
  }, `(${viewSource('treemap')})`, 'let tmLoadSeq = 0; let tmAnimFrame = 0; let tmMorph = null;');
  unmount.unmount();
  assert.deepEqual([state.treemap.pxRects, state.treemap.arcs], [[], []], 'the unmount drops the rectangles and arcs, as it drops the shapes');
});

test('HB2 (L3): the keyboard\'s selection goes when a repaint stops drawing it — Hide cloud, or a map landing after the key', () => {
  const cloud = { path: '/r/icloud-only.mov', name: 'icloud-only.mov', size: 9, type: 'file', depth: 1, cloudPlaceholder: true };
  const local = { path: '/r/local.bin', name: 'local.bin', size: 5, type: 'file', depth: 1 };
  let tips = 0;
  const state = { treemap: { colorMode: 'size', mode: 'treemap', kbSel: cloud as unknown, hideCloud: false, pxRects: [{ n: cloud }, { n: local }] as unknown[], arcs: [] as unknown[], cells: [] as unknown[] } };
  const drawView = load<() => void>(['drawView', 'drawnCells', ...['kbDropUndrawn'].filter((n) => INDEX.includes(`function ${n}(`))], {
    state, isSun: () => state.treemap.mode === 'sunburst', isCells: () => false, drawSunburst() {}, drawCells() {}, fetchScoresForTreemap() {},
    // Hide cloud on: the rectangle map paints the local file alone.
    drawTreemap() { state.treemap.pxRects = state.treemap.hideCloud ? [{ n: local }] : [{ n: cloud }, { n: local }]; },
    hideTooltip() { tips++; },
    $: (id: string) => (id === 'tmKbAnnounce' ? announce : null),
  }, 'drawView');
  const SELECTED = 'icloud-only.mov, file, 9 B, 64.3 percent of this view'; // what kbSelect said of it
  const announce = { textContent: SELECTED };
  drawView();
  assert.equal(state.treemap.kbSel, cloud, 'control: still drawn, still selected');
  assert.equal(announce.textContent, SELECTED, 'control: a repaint that still draws it says nothing new');
  state.treemap.hideCloud = true; // the Hide cloud pill
  drawView();
  assert.equal(state.treemap.kbSel, null, 'nothing on screen is selected: c, Delete, p and Enter have nothing to act on');
  assert.equal(tips, 1, 'and its card goes with it');
  // Said, in the region kbSelect speaks in: a screen reader was told it was selected, and never that it went (review HB2-L5).
  assert.equal(announce.textContent, 'icloud-only.mov is no longer shown, so nothing is selected.', 'the drop is said once');
  state.treemap.kbSel = local;
  drawView();
  assert.equal(state.treemap.kbSel, local, 'control: a selection still drawn stays');
  state.treemap.mode = 'sunburst'; state.treemap.arcs = [{ n: local, depth: 1 }];
  drawView();
  assert.equal(state.treemap.kbSel, local, 'over the sunburst, judged by its arcs');
  state.treemap.arcs = [];
  drawView();
  assert.equal(state.treemap.kbSel, null);
});

/** A 2D context that does nothing but answer measureText and make gradients (as mapKeyMarkings' quietCtx). */
function quietCtx() {
  const props: Record<string, unknown> = {
    measureText: (t: string) => ({ width: String(t).length * 6 }),
    createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }), createPattern: () => null,
  };
  return new Proxy(props, { get(t, k: string) { return k in t ? t[k] : () => {}; }, set(t, k: string, v) { t[k] = v; return true; } });
}

/**
 * The real liveRelayout over the real painter of `mode` — drawTreemap after the real animateTreemapTo, drawCells, or the
 * real animateSunburstTo — with fixtures/mapRaster resolving the painter's helpers. big.iso is selected, then deleted on disk.
 */
async function liveDropHarness(mode: string, reduced = false) {
  const gone = { path: '/r/big.iso', name: 'big.iso', size: 60, type: 'file' };
  const kept = { path: '/r/small.txt', name: 'small.txt', size: 40, type: 'file' };
  const root = { path: '/r', name: 'r', size: 100, type: 'dir', children: [gone, kept] };
  const rect = (n: { path: string; name: string; size: number }, x: number, w: number) => ({ ...n, type: 'file', depth: 1, expanded: false, x, y: 0, w, h: 100 });
  const frames: ((t: number) => void)[] = [];
  let clock = 0;
  let tips = 0;
  const state = {
    scanId: 's1', scanning: false, view: 'treemap', live: { on: true, dirty: 0 }, root,
    pathIndex: new Map<string, unknown>([[root.path, root], [gone.path, gone], [kept.path, kept]]),
    treemap: { mode, rootPath: '/r', rootName: 'r', rootSize: 100, maxDepth: 4, minSize: 1, nodes: [rect(gone, 0, 60), rect(kept, 60, 40)] as unknown[],
      pxRects: [] as unknown[], arcs: [] as unknown[], cells: [] as unknown[], kbSel: null as { path: string } | null, hideCloud: false, hover: null,
      history: { active: false, diff: false }, colorMode: 'size', query: '', queryMode: 'bare', matchedPaths: null, altNote: '', altRaf: 0, altZoomRaf: 0, altZoom: null },
  };
  const deps = {
    state, $: () => ({ clientWidth: 420, textContent: '', style: {} }), treemapCanvasHeight: () => 400, window: { devicePixelRatio: 1 },
    tmCanvas: { style: {}, width: 0, height: 0 }, tmBuffer: { width: 0, height: 0 }, tmBufCtx: quietCtx(), cssVar: () => '#888888',
    tmNodeCapNote: () => '', renderAltNote() {}, tmSetEmpty() {}, renderSearchOverlay() {}, presentTreemap() {}, renderTmLegend() {},
    cellRgb: () => [48, 209, 88], tmHatchPattern: () => null, tmPreview: { on: false }, roundRect() {}, reclaimCoverageNote: () => '',
    formatBytes: (b: number) => `${b} B`, formatCount: String, formatWhen: () => 'then',
    tmSizeCanvas: () => ({ cssW: 400, cssH: 400, dpr: 1 }), fxShapeSync() {}, performance: { now: () => clock },
    drawPackedCircle() {}, drawVoronoiCell() {}, altDrawLabels() {}, renderCellsStatus() {}, presentCells() {}, altNoteSettled() {},
    presentSunburst() {}, Canvas2D: { fitText: (_c: unknown, t: string) => t }, REDUCED: false, document: { hidden: false },
    requestAnimationFrame: (f: (t: number) => void) => frames.push(f), cancelAnimationFrame() {},
    hideTooltip() { tips++; },
  };
  // The painter, its helpers resolved by painting the map as it stands, a frame of the morph and the layout it ends on.
  const kb = ['kbDropUndrawn', 'drawnCells', 'isSun', 'isCells']; // run only once a key has selected something
  const paintEach = (draw: () => void) => {
    const was = state.treemap.nodes;
    for (const nodes of [was, [rect(kept, 30, 70)], [rect(kept, 0, 100)]]) { state.treemap.nodes = nodes; draw(); }
    state.treemap.nodes = was;
  };
  const painter = mode === 'treemap' ? pull<{ draw: () => void }>(['drawTreemap', ...kb], deps, '{ draw: drawTreemap }', (f) => paintEach(f.draw))
    : mode === 'sunburst' ? pull<{ draw: (r: unknown) => void }>(['animateSunburstTo', ...kb], { ...deps, REDUCED: true }, '{ draw: animateSunburstTo }', (f) => f.draw(root))
      : pull<{ draw: () => void }>(['drawCells', ...kb], deps, '{ draw: drawCells }', (f) => f.draw());
  frames.length = 0;
  const live = load<{ liveRelayout: () => Promise<void> }>(['tmAnimFrame', 'tmMorph', 'animateTreemapTo', 'TM_MIN_SIZE', 'liveRelayout'], {
    ...deps, isSun: () => mode === 'sunburst', isCells: () => mode === 'circles', maybeInjectTrash() {},
    // Reduced motion (or a hidden tab): animateTreemapTo paints once, with no morph frame to mask a painter that
    // dropped the selection by the paint before (review HB2-L2).
    REDUCED: reduced,
    drawTreemap: painter.draw, drawCells: painter.draw, animateSunburstTo: painter.draw, sunburstRoot: () => root,
    // The server's layout of the folder now: big.iso is drawn until another process deletes it (review HB2-L2) — so
    // the paint before the one that leaves it out still draws it, and only reading the paint just made drops it.
    api: async () => ({ root: { path: '/r', size: gone.size + kept.size }, nodes: gone.size > 0 ? [rect(gone, 0, 60), rect(kept, 60, 40)] : [rect(kept, 0, 100)] }),
  }, '{ liveRelayout }');
  const relayout = async () => {
    state.live.dirty = 1;
    await live.liveRelayout();
    for (let i = 0; i < 20 && frames.length; i++) { clock += 50; const due = frames.splice(0); for (const f of due) f(clock); }
  };
  return { state, relayout, gone, kept, tips: () => tips };
}

test('HB2 review (F1.3, F1.5, F1.7): a Live re-layout that stops drawing the selected item takes the selection — every renderer, with no drawView', async () => {
  for (const [mode, reduced] of [['treemap', false], ['treemap', true], ['circles', false], ['sunburst', false]] as const) {
    const h = await liveDropHarness(mode, reduced);
    h.state.treemap.kbSel = h.kept;
    await h.relayout();
    assert.equal(h.state.treemap.kbSel, h.kept, `${mode}: control — a selection still drawn stays`);
    h.state.treemap.kbSel = h.gone;
    h.gone.size = 0; // another process deleted big.iso: the watcher's tree has it at 0 bytes, and the server's layout leaves it out
    await h.relayout();
    assert.equal(h.state.treemap.kbSel, null, `${mode}: nothing on screen is selected — c, Delete, p, n and Enter have nothing to act on`);
    assert.ok(h.tips() >= 1, `${mode}: and its card goes with it`);
  }
});

test('HB2 (L15): with Hide cloud on, the matches it hides are said as that — never "deeper than this view draws", whose advice cannot show them', () => {
  const t = rewordHarness('treemap');
  t.state.treemap.hideCloud = true;
  for (const p of ['/r/c/z1', '/r/c/z2']) t.state.pathIndex.set(p, { cloudPlaceholder: true });
  t.state.treemap.nodes = [{ path: '/r/c/z3', cloudPlaceholder: true }]; // laid out by the server, not in the page's tree
  t.reword();
  assert.equal(t.box.textContent, '9 matches — 3 shown here. One is this folder itself, which has no rectangle of its own; 2 are deeper than this view draws; ' +
    '3 are online-only files hidden by Hide cloud. Zoom in or raise Depth for the deeper ones; turn off Hide cloud for the online-only ones.');
  t.state.treemap.matches = 5;
  t.reword();
  assert.equal(t.box.textContent, '9 matches — 5 shown here. One is this folder itself, which has no rectangle of its own; 3 are online-only files hidden by Hide cloud. ' +
    'Turn off Hide cloud to see them.');
  t.state.treemap.hideCloud = false; t.state.treemap.matches = 3;
  t.reword();
  assert.match(t.box.textContent, /5 are deeper than this view draws\. Zoom in or raise Depth\.$/, 'control: Hide cloud off, they are drawable');
  const s = rewordHarness('sunburst');
  s.state.treemap.hideCloud = true;
  for (const p of ['/r/c/z1', '/r/c/z2', '/r/c/z3']) s.state.pathIndex.set(p, { cloudPlaceholder: true });
  s.reword();
  assert.equal(s.box.textContent, '9 matches — the sunburst does not highlight them. One is this folder itself; 5 are in this folder; 3 are online-only files hidden by Hide cloud. ' +
    'Switch to Treemap, Circles or Voronoi to see the ones in this folder. Turn off Hide cloud to see the online-only ones.');
  // Every match in the folder on screen, some hidden: "switch to see them" alone would be followed by a map that hides them too.
  const words = load<(...a: unknown[]) => string>(REWORD_NAMES, { state: {}, formatCount: String }, 'tmSunburstQueryWords', 'let tmMorph = null; let tmLastHits = {};');
  assert.equal(words(2, [], ['/r/a/x1', '/r/c/z1'], '/r', false, (p: string) => p === '/r/c/z1'),
    '2 matches — the sunburst does not highlight them. 1 is in this folder; 1 is an online-only file hidden by Hide cloud. ' +
    'Switch to Treemap, Circles or Voronoi to see the one in this folder. Turn off Hide cloud to see the online-only ones.');
  assert.equal(words(1, [], ['/r/c/z1'], '/r', false, () => true),
    '1 match — the sunburst does not highlight it. 1 is an online-only file hidden by Hide cloud. Turn off Hide cloud and switch to Treemap, Circles or Voronoi to see it.');
});

test('HB2 review (F1.1, F1.9): a match Hide cloud hides outside the folder on screen is said as hidden, and where — "go up" alone is never offered for what going up cannot draw', () => {
  const ctx = { state: {}, formatCount: String };
  const msg = load<(...a: unknown[]) => string>(REWORD_NAMES, ctx, 'tmUndrawnMessage', 'let tmMorph = null; let tmLastHits = {};');
  const words = load<(...a: unknown[]) => string>(REWORD_NAMES, ctx, 'tmSunburstQueryWords', 'let tmMorph = null; let tmLastHits = {};');
  const mov = (p: string) => p.endsWith('.mov'); // the online-only files, hidden while Hide cloud is on
  // F1.1: viewing /r/a, the one match not drawn is an online-only file in /r/b. Going up never draws it while Hide cloud is on.
  assert.equal(msg(1, 0, ['/r/b/icloud.mov'], '/r/a', mov),
    '1 match — 0 shown here. 1 is an online-only file hidden by Hide cloud, outside this folder. Turn off Hide cloud and go up to see it.',
    'never "elsewhere in the scan … Go up to see them" — up there Hide cloud hides it all the same');
  assert.equal(words(1, [], ['/r/b/icloud.mov'], '/r/a', false, mov),
    '1 match — the sunburst does not highlight it. 1 is an online-only file hidden by Hide cloud, outside this folder. ' +
    'Turn off Hide cloud and go up in Treemap, Circles or Voronoi to see it.');
  // Some of them outside: each is told where it is.
  assert.equal(msg(2, 0, ['/r/a/i1.mov', '/r/b/i2.mov'], '/r/a', mov),
    '2 matches — 0 shown here. 2 are online-only files hidden by Hide cloud, 1 of them outside this folder. Turn off Hide cloud to see them, going up for the one outside this folder.');
  assert.equal(msg(4, 0, ['/r/a/i1.mov', '/r/b/i2.mov', '/r/b/i3.mov', '/r/b/x'], '/r/a', mov),
    '4 matches — 0 shown here. 1 is elsewhere in the scan, outside this folder; 3 are online-only files hidden by Hide cloud, 2 of them outside this folder. ' +
    'Go up for the ones elsewhere; turn off Hide cloud for the online-only ones, going up for those outside this folder.');
  assert.equal(msg(2, 0, ['/r/a/d', '/r/b/i.mov'], '/r/a', mov),
    '2 matches — 0 shown here. 1 is deeper than this view draws; 1 is an online-only file hidden by Hide cloud, outside this folder. ' +
    'Zoom in or raise Depth for the deeper ones; turn off Hide cloud and go up for the online-only ones.');
  assert.equal(words(2, [], ['/r/a/i1.mov', '/r/b/i2.mov'], '/r/a', false, mov),
    '2 matches — the sunburst does not highlight them. 2 are online-only files hidden by Hide cloud, 1 of them outside this folder. ' +
    'Turn off Hide cloud and switch to Treemap, Circles or Voronoi to see them, going up for the one outside this folder.');
  assert.equal(words(2, [], ['/r/a/d', '/r/b/i.mov'], '/r/a', false, mov),
    '2 matches — the sunburst does not highlight them. 1 is in this folder; 1 is an online-only file hidden by Hide cloud, outside this folder. ' +
    'Switch to Treemap, Circles or Voronoi to see the one in this folder. Turn off Hide cloud and go up to see the online-only ones.');
  assert.equal(words(3, [], ['/r/a/d', '/r/a/i1.mov', '/r/b/i2.mov'], '/r/a', false, mov),
    '3 matches — the sunburst does not highlight them. 1 is in this folder; 2 are online-only files hidden by Hide cloud, 1 of them outside this folder. ' +
    'Switch to Treemap, Circles or Voronoi to see the one in this folder. Turn off Hide cloud to see the online-only ones, going up for the one outside this folder.');
  // F1.9: Hide cloud's advice beside matches outside the folder, and one hidden match alone, each pinned.
  assert.equal(msg(2, 0, ['/r/b/x', '/r/a/i.mov'], '/r/a', mov),
    '2 matches — 0 shown here. 1 is elsewhere in the scan, outside this folder; 1 is an online-only file hidden by Hide cloud. ' +
    'Go up for the ones elsewhere; turn off Hide cloud for the online-only ones.');
  assert.equal(msg(4, 1, ['/r/a/d1', '/r/a/d2', '/r/b/x', '/r/a/i.mov'], '/r/a', mov),
    '4 matches — 1 shown here. 1 is elsewhere in the scan, outside this folder; 1 is deeper than this view draws; 1 is an online-only file hidden by Hide cloud. ' +
    'Zoom in or raise Depth for the deeper ones; go up for the ones elsewhere; turn off Hide cloud for the online-only ones.');
  assert.equal(msg(1, 0, ['/r/a/i.mov'], '/r/a', mov),
    '1 match — 0 shown here. 1 is an online-only file hidden by Hide cloud. Turn off Hide cloud to see it.', 'one hidden match is "it", never "them"');
  const outsideOnly = words(2, [], ['/r/b/x', '/r/a/i.mov'], '/r/a', false, mov);
  assert.doesNotMatch(outsideOnly, /switch to/i, 'no renderer switch shows a match outside the folder, nor one Hide cloud hides');
  assert.equal(outsideOnly, '2 matches — the sunburst does not highlight them. 1 is elsewhere in the scan, outside this folder; 1 is an online-only file hidden by Hide cloud. ' +
    'Go up in Treemap, Circles or Voronoi to see it. Turn off Hide cloud to see the online-only ones.');
  // Through the page's own Hide cloud predicate: the online-only files of /r/b, seen from /r/a.
  const t = rewordHarness('treemap');
  t.state.treemap.hideCloud = true;
  for (const p of ['/r/b/y1', '/r/b/y2', '/r/b/y3']) t.state.pathIndex.set(p, { cloudPlaceholder: true });
  t.state.treemap.rootPath = '/r/a'; t.state.treemap.matches = 2;
  t.reword();
  assert.equal(t.box.textContent, '9 matches — 2 shown here. 4 are elsewhere in the scan, outside this folder; 3 are online-only files hidden by Hide cloud, outside this folder. ' +
    'Go up for the ones elsewhere; turn off Hide cloud and go up for the online-only ones.');
});

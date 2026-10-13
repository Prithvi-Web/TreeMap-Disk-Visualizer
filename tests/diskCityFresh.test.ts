import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-diskCityFresh-data-');

import { INDEX } from './fixtures/liftFrontend';

/**
 * Disk City draws what the scan on screen holds (browser re-check C03, C13).
 *
 * C03: scan corpus/Mail, open the Treemap, scan corpus, go straight to Disk
 * City — it said "corpus" and drew Mail's 4,396 items. finishScan points
 * the shared root path at the new folder and leaves the Treemap's nodes as
 * they were, and loadCity reused the nodes whenever that PATH matched. The
 * nodes now carry the scan and the folder they were fetched for, and are
 * reused only for that pair.
 *
 * The page's own loadTreemap, finishScan, setHistoryIndex and loadCity run
 * here, lifted out of the built page with their surroundings stubbed: the
 * sequence is the app's, only the server is a test's.
 */

/** `function name(…) {…}` (async too) or a one-statement `const NAME = value;`, cut out of the built page. */
function declSource(name: string): string {
  let start = INDEX.indexOf(`function ${name}(`);
  if (start > 0 && INDEX.slice(start - 6, start) === 'async ') start -= 6;
  if (start === -1) {
    const at = INDEX.indexOf(`const ${name} = `);
    assert.notEqual(at, -1, `${name} is declared in the built page`);
    return INDEX.slice(at, INDEX.indexOf(';', at) + 1);
  }
  let from = INDEX.indexOf('(', start);
  for (let paren = 0; from < INDEX.length; from++) {
    if (INDEX[from] === '(') paren++;
    else if (INDEX[from] === ')' && --paren === 0) break;
  }
  let depth = 0;
  for (let i = INDEX.indexOf('{', from); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1) + ';';
  }
  return assert.fail(`${name} never closes`);
}

/** Disk City's own `registerView({ id: 'city', … })` call — its onScanChange and mount — cut out of the built page. */
function cityViewSource(): string {
  const at = INDEX.indexOf("registerView({\n  id: 'city',");
  assert.notEqual(at, -1, 'Disk City registers its view in the built page');
  let depth = 0;
  for (let i = INDEX.indexOf('{', at); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(at, i + 1) + ');';
  }
  return assert.fail('the city view never closes');
}

/** The named declarations in one scope, `deps` as their globals. */
function load<T>(names: string[], deps: Record<string, unknown>, returns: string, prelude = '', tail = ''): T {
  const keys = Object.keys(deps);
  const src = `'use strict'; ${prelude}\n${names.map(declSource).join('\n')}\n${tail}\nreturn ${returns};`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...keys, src)(...keys.map((k) => deps[k])) as T;
}

interface Node { path: string; name: string; size: number; type: string; x?: number; y?: number; w?: number; h?: number }

/** One element per id, holding whatever the code under test writes to it. */
function fakeDom() {
  const els = new Map<string, Record<string, unknown>>();
  return (id: string): Record<string, unknown> => {
    if (!els.has(id)) {
      els.set(id, {
        id, hidden: false, disabled: false, textContent: '', innerHTML: '', dataset: {}, style: {},
        classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [], offsetWidth: 230, offsetHeight: 90, clientWidth: 900, clientHeight: 600,
        addEventListener() {}, removeEventListener() {}, setAttribute() {},
      });
    }
    return els.get(id)!;
  };
}

/**
 * The page's loaders over a stubbed server. Every node the server hands out
 * names the scan and the folder it was asked for, so what Disk City built
 * from says which scan it came from.
 */
function harness(opts: { realCard?: boolean; lapse?: boolean; facts?: boolean; realBuild?: boolean; batch?: number; realChrome?: boolean } = {}) {
  const asked: string[] = [];
  const built: Node[][] = [];
  // The stub server's state: a folder's size where a test names one, a
  // failure while `down` holds a reason, and layouts held back until a test
  // lands or fails them while `hold` is set.
  const server = {
    sizes: {} as Record<string, number>, down: null as string | null, hold: false,
    held: [] as Array<{ root: string; land: () => void; fail: (reason: string) => void }>,
  };
  // Every trail the page drew, as [the element's id, the folder it names].
  const crumbs: Array<[string, string]> = [];
  const $ = fakeDom();
  const state = {
    scanId: null as string | null, root: null as { path: string; size: number } | null, view: 'treemap', scanning: false,
    pathIndex: new Map(), scanStats: null, live: { on: false, wanted: false },
    grid: { path: '', selection: new Set() }, apps: { loadedFor: null }, dup: null,
    treemap: {
      mode: 'treemap', colorMode: 'size', rootPath: null as string | null, rootName: '', rootSize: 0, maxDepth: 4,
      nodes: [] as Node[], minSize: undefined as number | undefined, hover: null, kbSel: null,
      history: {
        active: false, scrubbing: false, snaps: [] as Array<{ id: string; takenAt: number }>, index: 0, seq: 0, tree: null, viewingAt: 0,
        cache: new Map<string, unknown>(),
      },
      lapse: { playing: false, raf: 0, pos: 0, speed: 1, loop: false, seq: 0, onDone: null, completed: false },
    },
    city: {
      hover: null, pan: { x: 0, y: 0 }, zoom: 1, blocks: [] as Block[], counts: new Map(), countsAsked: new Set<string>(), unknownHeight: 0,
      colour: 'reclaim', height: 'staleness',
    },
  };
  // Which view the registry has mounted: Disk City's onScanChange reloads only when it is up.
  const mounted = { id: 'dashboard' };
  const views: Record<string, { onScanChange: (scanId: string) => void; mount: () => void }> = {};
  // Facts the city asks for later (subtree counts, reclaim scores), held until a test lands them.
  const countAsks: Array<{ scanId: string; paths: string[]; answer: (res: unknown) => void; fail: (err: Error) => void }> = [];
  const scoreAsks: Array<{ paths: string[]; land: () => void }> = [];
  const reclaim = { scores: new Map<string, unknown>() };
  const api = async (url: string, init?: { body?: string }) => {
    if (url === '/api/facts') {
      const body = JSON.parse(init!.body!) as { scanId: string; paths: string[]; providers: string[] };
      assert.deepEqual(body.providers, ['subtreeCount'], 'the city asks the fact layer for counts only');
      return new Promise((answer, fail) => countAsks.push({ scanId: body.scanId, paths: body.paths, answer, fail }));
    }
    asked.push(url);
    const m = /^\/api\/scan\/([^/]+)\/treemap\?.*root=([^&]+)/.exec(url);
    assert.ok(m, `the stub serves the treemap layout only, not ${url}`);
    const [, scanId, root] = [m[0], m[1], decodeURIComponent(m[2])];
    // Laid out as the server lays them out, so the city's own build can draw
    // them: three files side by side, and a fourth too small to see until
    // the city is zoomed in.
    const nodes: Node[] = [1, 2, 3].map((i) => ({
      path: `${root}/f${i}`, name: `${scanId}:${root}`, size: 5000 * i, type: 'file', x: 40 * (i - 1), y: 0, w: i === 3 ? 19.5 : 40, h: 100,
    }));
    nodes.push({ path: `${root}/f4`, name: `${scanId}:${root}`, size: 10, type: 'file', x: 99.5, y: 0, w: 0.5, h: 0.5 });
    const layout = { root: { path: root, name: root.split('/').pop(), size: server.sizes[root] ?? 30000 }, nodes };
    if (server.hold) {
      return new Promise((land, fail) => server.held.push({ root, land: () => land(layout), fail: (reason) => fail(new Error(reason)) }));
    }
    if (server.down) throw new Error(server.down);
    return layout;
  };
  const noop = () => {};
  const deps: Record<string, unknown> = {
    state, $, api, REDUCED: true, requestAnimationFrame: noop,
    // Disk City's view: the registry it registers with, and what it starts when mounted.
    registerView: (v: { id: string; onScanChange: (scanId: string) => void; mount: () => void }) => { views[v.id] = v; },
    mountedView: mounted, refreshDock: noop,
    cityOnPointerDown: noop, cityOnPointerMove: noop, cityOnPointerUp: noop, cityOnPointerLeave: noop, cityOnWheel: noop, cityOnKey: noop, cityOnResize: noop,
    isSun: () => false, isCells: () => false, exitCartPreview: noop,
    // finishScan's completion toast is expected; any other is a loader reporting a failure.
    toast: (m: string) => { if (!/^Scan complete/.test(m)) throw new Error('the page reported: ' + m); },
    renderCrumbs: (host: { id: string }, p: string) => { crumbs.push([host.id, p]); }, maybeInjectTrash: noop, exitHistoryState: noop, refreshTimebar: noop, drawView: noop,
    animateTreemapTo: (nodes: Node[]) => { state.treemap.nodes = nodes; },
    disableLive: noop, drawCells: noop, animateSunburstTo: noop, updateTimeLabel: noop,
    historyLayoutFor: async (snap: { takenAt: number }) => ({
      snapshot: { takenAt: snap.takenAt }, tree: null, root: { path: state.root!.path, size: 1 },
      nodes: [{ path: `${state.root!.path}/old`, name: `snapshot:${snap.takenAt}`, size: 1, type: 'file', x: 0, y: 0, w: 100, h: 100 }],
    }),
    // Disk City's own drawing is not under test: what it was handed to draw is.
    // A rebuild makes new blocks for the same paths, as the page's does.
    buildCity: () => { built.push(state.treemap.nodes.slice()); state.city.blocks = state.city.blocks.map((b) => ({ ...b })); },
    cityEnter: noop, renderCityTable: noop, cityFetchFacts: noop, drawCity: noop, renderCityChrome: noop, cityMorphHeights: () => false,
    // One base colour per mode, so a card says which mode it was painted in;
    // in Reclaim, grey until the building is scored and red once it is.
    cityRgb: (n: Node, mode: string) => (mode === 'type' ? [191, 90, 242] : mode === 'age' ? [10, 200, 10]
      : reclaim.scores.has(n.path) ? [231, 63, 63] : [58, 64, 72]),
    reclaim, localStorage: { setItem: noop, getItem: () => null },
    // The reclaim scores' own loader: the scores land when the test says so.
    ensureScores: (paths: string[], onLanded: () => void) => {
      scoreAsks.push({ paths, land: () => { for (const p of paths) reclaim.scores.set(p, { score: 80 }); onLanded(); } });
      return Promise.resolve();
    },
    cityInvalidate: noop, window: { addEventListener: noop, removeEventListener: noop },
    // finishScan's surroundings.
    endScanChrome: noop, indexTree: noop, updateSelectionBar: noop, DUP_PAGE: 100, icon: () => '',
    formatCount: (n: number) => String(n), formatBytes: (n: number) => `${n} B`, escapeHtml: (s: string) => s,
    countUp: noop, FxNum: { rollText: noop }, renderDiskNotes: noop, loadWhatsNew: noop, loadDriveHealth: noop,
    loadCostEstimate: noop, showListsPending: noop, emit: noop, TOPIC: { scan: 'scan' }, switchView: noop, fxScanDonePulse: noop,
    // The three list walks have not answered: the person went straight to Disk City.
    loadDashboardLists: () => new Promise(() => {}),
    buildIndexInBackground: noop, formatClock: () => '10:31 PM',
  };
  // The card's own code where a test reads the card; a no-op where none does.
  const cardNames = ['cityShowCard', 'cityMoveCard', 'cityRefreshCard', 'cityCardKey', 'cityAgeDays', 'cityAgeWords', 'cityJitter', 'cityUp', 'tmParentPath',
    'citySetColour', 'citySetHeight', 'cityMode', 'CITY_COLOUR_LABEL', 'CITY_HEIGHT_LABEL'];
  if (!opts.realCard) deps.cityShowCard = noop;
  // The city's own fact loaders, over the held counts and scores above.
  const factNames = ['TM_SCORE_CAP', ...(opts.batch ? [] : ['RECLAIM_BATCH']), 'cityFetchFacts', 'cityLoadCounts'];
  if (opts.facts) delete deps.cityFetchFacts;
  if (opts.batch) deps.RECLAIM_BATCH = opts.batch; // the fact layer's batch, small enough to see a second one
  // The city's own build, over its own geometry, where a test reads what it
  // built rather than what it was handed; and its own zoom settle, at once.
  const buildNames = ['isoProject', 'isoBounds', 'isoBehind', 'isoDepthOrder', 'CITY_MAX_H', 'CITY_MIN_H', 'cityMetric', 'cityScaleHeights',
    'cityVisibleNodes', 'cityContentBounds', 'buildCity', 'cityAfterZoom'];
  if (opts.realBuild) {
    delete deps.buildCity;
    Object.assign(deps, { setTimeout: (fn: () => void) => { fn(); return 1; }, clearTimeout: noop });
  }
  // The city's own line and size (#cityLod, #cityStatus), written by every
  // draw as the page's drawCity writes them — and by the reduced-motion
  // entry, which draws at once. Only the legend's colour keys are stubs.
  const hooks = { redraw: noop };
  const chromeNames = ['TM_SERVER_NODE_CAP', 'baseName', 'renderCityChrome'];
  if (opts.realChrome) {
    delete deps.renderCityChrome;
    Object.assign(deps, {
      drawCity: () => hooks.redraw(), cityEnter: () => hooks.redraw(),
      C_RC_LOW: [1, 2, 3], C_AMBER: [4, 5, 6], C_TEAL: [7, 8, 9], ageRgb: () => [0, 0, 0], cityTypeKey: () => ({ shown: [], more: 0 }),
    });
  }
  // The time-lapse's own transport, animated as it plays by default (motion
  // not reduced, rectangle map), over a frame queue the test pumps by hand.
  const frames = { queue: [] as Array<[number, (t: number) => unknown]>, next: 0, clock: 0 };
  const lapseNames = ['LAPSE_SEG_MS', 'LAPSE_HOLD_MAX_MS', 'lapseFetching', 'lapseStart', 'lapseStop', 'lapseApplySnap', 'lapseSeekTo', 'lapsePrefetch', 'lapseLerpNodes'];
  if (opts.lapse) {
    Object.assign(deps, {
      REDUCED: false, isRectMap: () => true, lapseReflect: noop, drawTreemap: noop,
      performance: { now: () => frames.clock },
      requestAnimationFrame: (cb: (t: number) => unknown) => { frames.queue.push([++frames.next, cb]); return frames.next; },
      cancelAnimationFrame: (id: number) => { frames.queue = frames.queue.filter(([at]) => at !== id); },
    });
  }
  const page = load<{
    loadTreemap: (p: string) => Promise<void>;
    loadCity: (p: string | null) => Promise<void>;
    finishScan: (root: unknown, ms: number, stats: unknown) => Promise<void>;
    setHistoryIndex: (i: number) => Promise<void>;
    lapse?: { start: () => void; stop: () => void };
    afterZoom?: () => void;
    chrome?: () => void;
    card?: {
      show: (b: Block | null, px?: number, py?: number) => void;
      up: () => void;
      setColour: (m: string) => void;
      setHeight: (m: string) => void;
      jitter: (rgb: number[], path: string) => number[];
    };
  }>(['TM_MIN_SIZE', 'loadTreemap', 'loadCity', 'finishScan', 'setHistoryIndex', ...(opts.realCard ? cardNames : []), ...(opts.lapse ? lapseNames : []),
    ...(opts.facts ? factNames : []), ...(opts.realBuild ? buildNames : []), ...(opts.realChrome ? chromeNames : [])], deps,
    `{ loadTreemap, loadCity, finishScan, setHistoryIndex${opts.realCard
      ? ', card: { show: cityShowCard, up: cityUp, setColour: citySetColour, setHeight: citySetHeight, jitter: cityJitter }'
      : ''}${opts.lapse ? ', lapse: { start: lapseStart, stop: lapseStop }' : ''}${opts.realBuild ? ', afterZoom: cityAfterZoom' : ''}${
      opts.realChrome ? ', chrome: renderCityChrome' : ''} }`,
    'let tmLoadSeq = 0; let cityLoadSeq = 0; let tmAnimFrame = 0; let lapseExporting = false; let lapseInternalStart = false;',
    // The view itself registers where the page's onScanChange and mount can reach the city's own functions.
    opts.realCard && opts.facts ? cityViewSource() : '');
  /** Run `count` animation frames, 100 ms apart, letting each frame's awaits settle. */
  const pump = async (count: number) => {
    for (let i = 0; i < count; i++) {
      frames.clock += 100;
      const due = frames.queue;
      frames.queue = [];
      for (const [, cb] of due) await cb(frames.clock);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  /** The scan:folder every node Disk City was last handed names. */
  const lastBuilt = () => [...new Set((built[built.length - 1] ?? []).map((n) => n.name))];
  if (page.chrome) hooks.redraw = page.chrome;
  return { ...page, state, asked, built, lastBuilt, $, pump, frames, countAsks, scoreAsks, mounted, views, server, crumbs };
}

interface Block { n: Node & { modifiedAt?: number }; rgb: number[]; z: number }

test('C03: Disk City entered straight after a scan of another folder draws that scan, never the last one the Treemap held', async () => {
  const h = harness();
  // A scan of corpus/Mail, and the Treemap opened on it.
  h.state.scanId = 's-mail';
  h.state.root = { path: '/corpus/Mail', size: 37_700_000 };
  await h.loadTreemap('/corpus/Mail');
  assert.deepEqual([...new Set(h.state.treemap.nodes.map((n) => n.name))], ['s-mail:/corpus/Mail'], 'control: the Treemap holds Mail');

  // A scan of corpus lands; its lists are still walking when Disk City opens.
  h.state.scanId = 's-corpus';
  void h.finishScan({ path: '/corpus', size: 900_000_000 }, 50, { fileCount: 12, dirCount: 3 });
  assert.equal(h.state.treemap.rootPath, '/corpus', 'control: the paint pointed the shared root at the new folder');
  h.asked.length = 0;
  await h.loadCity(h.state.treemap.rootPath); // Disk City's mount

  assert.deepEqual(h.lastBuilt(), ['s-corpus:/corpus'], 'the city is built from the new scan of the new folder');
  assert.equal(h.asked.length, 1, 'which it asked the server for');
  assert.match(h.asked[0], /^\/api\/scan\/s-corpus\/treemap\?.*root=%2Fcorpus/);
});

test('C03: a rescan of the SAME folder is not drawn from the previous scan\'s nodes either', async () => {
  const h = harness();
  h.state.scanId = 's1';
  h.state.root = { path: '/corpus', size: 1 };
  await h.loadTreemap('/corpus');
  h.state.scanId = 's2';
  void h.finishScan({ path: '/corpus', size: 2 }, 50, { fileCount: 1, dirCount: 1 });
  await h.loadCity(h.state.treemap.rootPath);
  assert.deepEqual(h.lastBuilt(), ['s2:/corpus'], 'the nodes are keyed by the scan, not by the folder\'s path');
});

test('C03: nodes are reused only for the folder they were fetched for — a root path repointed without them is fetched', async () => {
  const h = harness();
  h.state.scanId = 's1';
  h.state.root = { path: '/corpus', size: 1 };
  await h.loadTreemap('/corpus/Mail');
  // The Calendar and the Media list repoint the shared root without loading it.
  h.state.treemap.rootPath = '/corpus/Projects';
  await h.loadCity(h.state.treemap.rootPath);
  assert.deepEqual(h.lastBuilt(), ['s1:/corpus/Projects'], 'Projects is drawn, not the Mail nodes still held');
});

test('C03: the same scan and folder the Treemap already holds still costs Disk City no request', async () => {
  const h = harness();
  h.state.scanId = 's1';
  h.state.root = { path: '/corpus', size: 1 };
  await h.loadTreemap('/corpus');
  h.asked.length = 0;
  await h.loadCity('/corpus');
  assert.deepEqual(h.asked, [], 'the two views share one fetch, as they always did');
  assert.deepEqual(h.lastBuilt(), ['s1:/corpus']);
});

test('C03: a drill in Disk City and back up draws the folder it climbed to, not the one it left', async () => {
  const h = harness();
  h.state.scanId = 's1';
  h.state.root = { path: '/corpus', size: 1 };
  await h.loadTreemap('/corpus');
  await h.loadCity('/corpus/Mail'); // a click on a building
  assert.deepEqual(h.lastBuilt(), ['s1:/corpus/Mail'], 'control: the drill drew Mail');
  await h.loadCity('/corpus'); // Esc, Up or a crumb
  assert.deepEqual(h.lastBuilt(), ['s1:/corpus'], 'the nodes Disk City fetched say which folder they are');
});

test('C03: a past snapshot the time slider put in the Treemap is not drawn by Disk City as the live scan', async () => {
  const h = harness();
  h.state.scanId = 's1';
  h.state.root = { path: '/corpus', size: 1 };
  await h.loadTreemap('/corpus');
  h.state.treemap.history.snaps = [{ id: 'old', takenAt: 1000 }];
  await h.setHistoryIndex(0);
  assert.deepEqual([...new Set(h.state.treemap.nodes.map((n) => n.name))], ['snapshot:1000'], 'control: the Treemap shows the snapshot');
  h.asked.length = 0;
  await h.loadCity('/corpus');
  assert.deepEqual(h.lastBuilt(), ['s1:/corpus'], 'Disk City draws the scan, fetched again');
});

test('C03: Disk City re-entered on the folder it drew itself costs no request', async () => {
  const h = harness();
  h.state.scanId = 's1';
  h.state.root = { path: '/corpus', size: 1 };
  await h.loadCity('/corpus/Mail');
  assert.deepEqual(h.lastBuilt(), ['s1:/corpus/Mail'], 'control: Disk City fetched Mail');
  h.asked.length = 0;
  await h.loadCity('/corpus/Mail'); // a visit to another view and back
  assert.deepEqual(h.asked, [], 'the nodes it fetched are reused for the same scan and folder');
  assert.deepEqual(h.lastBuilt(), ['s1:/corpus/Mail']);
});

/**
 * The Treemap on a scan of /corpus with three past snapshots of it cached, as
 * the time bar's prefetch leaves them: every rectangle a snapshot holds names
 * the snapshot, and its root size is not the live one.
 */
async function treemapWithSnapshots() {
  const h = harness({ lapse: true });
  h.state.scanId = 's1';
  h.state.root = { path: '/corpus', size: 1 };
  await h.loadTreemap('/corpus');
  const hist = h.state.treemap.history;
  hist.snaps = [1000, 2000, 3000].map((takenAt) => ({ id: `snap-${takenAt}`, takenAt }));
  for (const s of hist.snaps) {
    hist.cache.set(s.id, {
      snapshot: { takenAt: s.takenAt }, tree: { path: '/corpus' }, root: { path: '/corpus', size: s.takenAt },
      nodes: [1, 2, 3].map((i) => ({ path: `/corpus/f${i}`, name: `snapshot:${s.takenAt}`, size: s.takenAt, type: 'file', x: 10 * i, y: 0, w: 10, h: 10 })),
    });
  }
  (h.$('tmTimeSlider') as { value: string }).value = String(hist.snaps.length); // the thumb at Live
  return h;
}
const drawnNames = (h: ReturnType<typeof harness>) => [...new Set(h.state.treemap.nodes.map((n) => n.name))];

test('C03: a time-lapse paused on a past snapshot is not drawn by Disk City as the live scan', async () => {
  const h = await treemapWithSnapshots();
  h.lapse!.start(); // Play, animated
  await h.pump(6);
  assert.equal(h.state.treemap.lapse.playing, true, 'control: the time-lapse is playing');
  h.lapse!.stop(); // Pause: the map settles on the snapshot the slider names
  assert.deepEqual(drawnNames(h), ['snapshot:1000'], 'control: the Treemap shows a past snapshot');
  h.state.view = 'city';
  h.lapse!.stop(); // the Treemap's unmount, on the way to Disk City
  h.asked.length = 0;
  await h.loadCity(h.state.treemap.rootPath); // Disk City's mount
  assert.deepEqual(h.lastBuilt(), ['s1:/corpus'], 'Disk City draws the live scan');
  assert.equal(h.asked.length, 1, 'which it asked the server for');
  assert.equal(h.state.treemap.rootSize, 30000, 'and the live folder\'s size, not the snapshot\'s');
});

test('C03: a time-lapse played to its end is not drawn by Disk City as the live scan', async () => {
  const h = await treemapWithSnapshots();
  h.lapse!.start();
  // Two one-second segments at 100 ms a frame: well inside 60 frames.
  for (let i = 0; i < 60 && h.state.treemap.lapse.playing; i++) await h.pump(1);
  assert.equal(h.state.treemap.lapse.completed, true, 'control: the run finished');
  assert.deepEqual(drawnNames(h), ['snapshot:3000'], 'control: the Treemap ends on the newest snapshot');
  h.state.view = 'city';
  h.lapse!.stop();
  h.asked.length = 0;
  await h.loadCity(h.state.treemap.rootPath);
  assert.deepEqual(h.lastBuilt(), ['s1:/corpus'], 'Disk City draws the live scan');
  assert.equal(h.asked.length, 1);
});

test('C03: no rectangles but the ones fetched for the scan are reused — a blend mid-segment is not', async () => {
  const h = await treemapWithSnapshots();
  h.lapse!.start();
  await h.pump(4);
  assert.deepEqual(drawnNames(h), ['snapshot:2000'], 'control: the map holds a blend on its way to a snapshot');
  h.asked.length = 0;
  await h.loadCity(h.state.treemap.rootPath); // reached without the Treemap's unmount settling the blend
  assert.deepEqual(h.lastBuilt(), ['s1:/corpus'], 'Disk City draws the live scan');
  assert.equal(h.asked.length, 1);
});

/* ══════════════ C13 — the hover card follows the city it describes ══════════════ */

/** The card's colour dot, as the page writes it. */
const dotOf = (html: string): string => {
  const m = /class="cc-dot" style="background:(rgb\([^)]*\))"/.exec(html);
  assert.ok(m, `the card has a colour dot: ${html.slice(0, 120)}`);
  return m[1];
};
const rgbText = (rgb: number[]): string => `rgb(${rgb.map((v) => Math.round(v)).join(',')})`;

/** A city holding one video file, with its card up as a pointer left it. */
async function cityWithCard(opts: { facts?: boolean; colour?: string } = {}) {
  const h = harness({ realCard: true, facts: opts.facts });
  h.state.scanId = 's1';
  h.state.root = { path: '/corpus', size: 1 };
  h.state.view = 'city';
  if (opts.colour) h.state.city.colour = opts.colour;
  await h.loadCity('/corpus/Media/Clips');
  const n = { path: '/corpus/Media/Clips/clip027.m4v', name: 'clip027.m4v', size: 5_000_000, type: 'file', modifiedAt: 0 };
  const b: Block = { n, rgb: h.card!.jitter([58, 64, 72], n.path), z: 1 };
  h.state.city.blocks = [b];
  h.card!.show(b, 40, 50);
  const card = h.$('cityCard') as { hidden: boolean; innerHTML: string };
  assert.equal(card.hidden, false, 'control: the card is up');
  return { h, card, n };
}

test('C13: Escape climbing out of a folder takes the hover card with it, at every level', async () => {
  const { h, card } = await cityWithCard();
  h.card!.up(); // the document's Escape handler, in Disk City
  assert.equal(card.hidden, true, 'the card describing a building of the folder being left goes at once');
  await Promise.resolve();
  card.hidden = false; // a pointer crossed a building while the parent loaded
  h.card!.up();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(card.hidden, true, 'and at the next level too');
  assert.equal(h.state.treemap.rootPath, '/corpus', 'control: two levels were climbed');
});

test('C13: a card up while the layout is replaced is hidden when the new city lands', async () => {
  const { h, card } = await cityWithCard();
  const landing = h.loadCity('/corpus/Media');
  card.hidden = false; // shown for the old layout while the new one was asked for
  await landing;
  assert.equal(card.hidden, true, 'the building it described is not in the city drawn now');
});

test('C13: the card\'s colour dot is the colour mode now chosen, not the one it was built in', async () => {
  const { h, card, n } = await cityWithCard();
  assert.equal(dotOf(card.innerHTML), rgbText(h.card!.jitter([58, 64, 72], n.path)), 'control: built in Reclaim, it wears the reclaim colour');
  assert.match(card.innerHTML, /Reclaim score/, 'control: and the reclaim row');
  h.card!.setColour('type');
  assert.equal(card.hidden, false, 'the card stays up for the building still under the pointer');
  assert.equal(dotOf(card.innerHTML), rgbText(h.card!.jitter([191, 90, 242], n.path)), 'its dot is the Type colour the building is now painted');
  assert.doesNotMatch(card.innerHTML, /Reclaim score/, 'and it no longer reads a reclaim score that is not on the map');
});

test('C13: changing what height means rebuilds the card for the new city', async () => {
  const { h, card } = await cityWithCard();
  assert.doesNotMatch(card.innerHTML, /still counting/, 'control: by staleness, the card says nothing of a count');
  h.card!.setHeight('files');
  assert.equal(card.hidden, false);
  assert.match(card.innerHTML, /Holds<\/span><b>still counting…/, 'by file count, it says the count is on its way');
});

/* The switch by keyboard leaves the pointer where it was, so no pointer move
   rebuilds the card when the facts the new mode waits for land: the card must
   be rebuilt by their landing (C13 review F1.2, F1.10). */

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('C13: a card switched to file counts by keyboard says the count once it lands, not "still counting…" for good', async () => {
  const { h, card, n } = await cityWithCard({ facts: true });
  h.card!.setHeight('files');
  assert.match(card.innerHTML, /Holds<\/span><b>still counting…/, 'control: the count is on its way');
  assert.equal(h.countAsks.length, 1, 'control: the city asked for the counts');
  h.countAsks[0].answer({ providers: { subtreeCount: { available: true, values: { [n.path]: { files: 7, dirs: 2 } } } } });
  await settle();
  assert.equal(card.hidden, false, 'the card stays up over the building under the pointer');
  assert.match(card.innerHTML, /Holds<\/span><b>7 files · 2 folders/, 'it says what the building holds');
  assert.doesNotMatch(card.innerHTML, /still counting/, 'and no longer that the count is on its way');
});

test('C13: a card switched to Reclaim by keyboard takes the score and the colour once the scores land', async () => {
  const { h, card, n } = await cityWithCard({ facts: true, colour: 'type' });
  h.card!.setColour('reclaim');
  assert.match(card.innerHTML, /Reclaim score<\/span><b>not scored/, 'control: no score yet');
  assert.equal(dotOf(card.innerHTML), rgbText(h.card!.jitter([58, 64, 72], n.path)), 'control: the unscored grey');
  assert.equal(h.scoreAsks.length, 1, 'control: the city asked for the scores');
  h.scoreAsks[0].land();
  const scored = rgbText(h.card!.jitter([231, 63, 63], n.path));
  assert.equal(rgbText(h.state.city.blocks[0].rgb), scored, 'control: the building is repainted in its score\'s colour');
  assert.equal(card.hidden, false);
  assert.match(card.innerHTML, /Reclaim score<\/span><b>80 \/ 100/, 'the card reads the score that landed');
  assert.equal(dotOf(card.innerHTML), scored, 'and its dot is the colour the building now wears');
});

/* ══════════════ C03 review F2.2 — what Disk City builds before its own fetch lands ══════════════

   loadCity decided rightly whether the nodes on the map were this scan's
   folder's, but the view's mount built the city from them BEFORE asking it:
   the Height control's rebuild drew the last scan's buildings under the new
   folder's name until the fetch landed, and for good if it failed. In Files
   height that build also asked for the last scan's buildings' counts under
   the new scan's key, and the real build's ask then found the key taken, so
   no building of the new folder was ever counted. */

const cityNames = (h: ReturnType<typeof harness>) => [...new Set(h.state.city.blocks.map((b) => b.n.name))];
const cityPaths = (h: ReturnType<typeof harness>) => h.state.city.blocks.map((b) => b.n.path).sort();
const countAnswer = (paths: string[], files = 3) => ({
  providers: { subtreeCount: { available: true, values: Object.fromEntries(paths.map((p) => [p, { files, dirs: 0 }])) } },
});

/** Disk City with its own build, fact loaders and view, by file count, in the Type colours (no scores to wait on). */
function cityHarness(opts: { batch?: number; realChrome?: boolean } = {}) {
  const h = harness({ realCard: true, facts: true, realBuild: true, ...opts });
  h.state.city.height = 'files';
  h.state.city.colour = 'type';
  return h;
}

/**
 * A scan of `from`, drawn by the Treemap, then a scan `scanId` of `to` landing.
 * The registry's TOPIC.scan (the city's onScanChange) is the caller's: finishScan
 * sends it and mounts the view in the same tick, before any fetch can land.
 */
async function scanAfterTreemap(h: ReturnType<typeof harness>, from: string, to: string, scanId: string) {
  h.state.scanId = 's1';
  h.state.root = { path: from, size: 1 };
  await h.loadTreemap(from);
  assert.deepEqual([...new Set(h.state.treemap.nodes.map((n) => n.name))], [`s1:${from}`], 'control: the Treemap holds the last scan');
  h.state.scanId = scanId;
  void h.finishScan({ path: to, size: 2 }, 50, { fileCount: 4, dirCount: 1 });
}

test('C03: Disk City opened after a scan of another folder builds nothing of the last scan while it fetches the new one', async () => {
  const h = cityHarness();
  await scanAfterTreemap(h, '/A', '/B', 's2');
  h.views.city.onScanChange('s2'); // the registry's TOPIC.scan, with the Dashboard up
  h.state.view = 'city';
  h.views.city.mount(); // the Disk City tab
  assert.deepEqual(cityNames(h), [], 'no building of A stands under B\'s name while B is fetched');
  await settle();
  assert.deepEqual(cityNames(h), ['s2:/B'], 'control: B is drawn once it lands');
});

test('C03: Disk City already up when a scan of another folder lands builds nothing of the last scan when the view is mounted again', async () => {
  const h = cityHarness();
  h.state.view = 'city';
  h.mounted.id = 'city';
  await scanAfterTreemap(h, '/A', '/B', 's2');
  h.views.city.onScanChange('s2'); // the registry's TOPIC.scan: the city that is up reloads
  h.views.city.mount(); // finishScan's switchView(state.view) in the same tick, with no unmount between
  assert.deepEqual(cityNames(h), [], 'the second mount builds nothing of A either');
  await settle();
  assert.deepEqual(cityNames(h), ['s2:/B']);
});

test('C03: in Files height the new folder\'s buildings are the ones counted — no count is asked for the last scan\'s', async () => {
  const h = cityHarness();
  await scanAfterTreemap(h, '/A', '/B', 's2');
  h.views.city.onScanChange('s2');
  h.state.view = 'city';
  h.views.city.mount();
  await settle();
  assert.deepEqual(cityPaths(h), ['/B/f1', '/B/f2', '/B/f3'], 'control: B\'s buildings are drawn');
  assert.deepEqual(h.countAsks.map((a) => [a.scanId, ...a.paths]), [['s2', '/B/f1', '/B/f2', '/B/f3']],
    'one ask, of the new scan, for the buildings drawn');
  assert.equal(h.state.city.unknownHeight, 3, 'control: drawn flat until their counts land');
  h.countAsks[0].answer(countAnswer(h.countAsks[0].paths));
  await settle();
  assert.equal(h.state.city.unknownHeight, 0, 'and every building drawn stands at its count, none flat for want of one');
});

/* Each part of the rule, alone: the build takes only the very array fetched
   for this scan's folder, and takes it at once when it is. */
const mountCases: Array<{ name: string; setup: (h: ReturnType<typeof harness>) => Promise<void>; drawn: string; fetched: boolean }> = [
  {
    name: 'a rescan of the same folder (the scan differs)', drawn: 's2:/corpus', fetched: true,
    setup: async (h) => {
      await scanAfterTreemap(h, '/corpus', '/corpus', 's2');
      h.views.city.onScanChange('s2');
    },
  },
  {
    name: 'the shared root repointed at another folder of the same scan (the folder differs)', drawn: 's1:/corpus/Projects', fetched: true,
    setup: async (h) => {
      h.state.scanId = 's1';
      h.state.root = { path: '/corpus', size: 1 };
      await h.loadTreemap('/corpus/Mail');
      h.state.treemap.rootPath = '/corpus/Projects'; // the Calendar and the Media list repoint it without loading it
    },
  },
  {
    name: 'a past snapshot the time slider left on the map (the array differs)', drawn: 's1:/corpus', fetched: true,
    setup: async (h) => {
      h.state.scanId = 's1';
      h.state.root = { path: '/corpus', size: 1 };
      await h.loadTreemap('/corpus');
      h.state.treemap.history.snaps = [{ id: 'old', takenAt: 1000 }];
      await h.setHistoryIndex(0);
      assert.deepEqual([...new Set(h.state.treemap.nodes.map((n) => n.name))], ['snapshot:1000'], 'control: the map holds the snapshot');
    },
  },
];
for (const c of mountCases) {
  test(`C03: Disk City's mount builds nothing before its fetch lands after ${c.name}`, async () => {
    const h = cityHarness();
    await c.setup(h);
    h.state.view = 'city';
    h.asked.length = 0;
    h.views.city.mount();
    assert.deepEqual(cityNames(h), [], 'nothing it was not fetched for is built');
    await settle();
    assert.deepEqual(cityNames(h), [c.drawn], 'control: what it fetched is drawn');
    assert.equal(h.asked.length, 1, 'control: which it asked the server for');
  });
}

test('C03: Disk City mounted on the scan and folder the Treemap holds builds them at once, with no request', async () => {
  const h = cityHarness();
  h.state.scanId = 's1';
  h.state.root = { path: '/corpus', size: 1 };
  await h.loadTreemap('/corpus');
  h.state.view = 'city';
  h.asked.length = 0;
  h.views.city.mount();
  assert.deepEqual(cityNames(h), ['s1:/corpus'], 'the nodes fetched for this scan\'s folder are built as the view mounts');
  await settle();
  assert.deepEqual(h.asked, [], 'and shared, not fetched again');
});

test('C03: buildings a zoom reveals are counted too — the count asked for the last build does not stand for the next', async () => {
  const h = cityHarness();
  h.state.scanId = 's1';
  h.state.root = { path: '/corpus', size: 1 };
  h.state.view = 'city';
  await h.loadCity('/corpus');
  assert.deepEqual(cityPaths(h), ['/corpus/f1', '/corpus/f2', '/corpus/f3'], 'control: the smallest file is too small to draw yet');
  assert.equal(h.countAsks.length, 1, 'control: the drawn buildings were asked for');
  h.countAsks[0].answer(countAnswer(h.countAsks[0].paths));
  await settle();
  h.state.city.zoom = 2;
  h.afterZoom!(); // the wheel settles
  assert.deepEqual(cityPaths(h), ['/corpus/f1', '/corpus/f2', '/corpus/f3', '/corpus/f4'], 'control: zoomed in, it is drawn');
  assert.deepEqual(h.countAsks.map((a) => a.paths), [['/corpus/f1', '/corpus/f2', '/corpus/f3'], ['/corpus/f4']],
    'it is asked for, and only it — the three already counted are not asked again');
  assert.equal(h.state.city.unknownHeight, 1, 'control: it stands flat until its count lands');
  h.countAsks[1].answer(countAnswer(['/corpus/f4']));
  await settle();
  assert.equal(h.state.city.unknownHeight, 0, 'every building drawn stands at its count');
});

test('C03: a count ask that fails is asked again at the next entry, for what it had not answered only', async () => {
  const h = cityHarness({ batch: 2 });
  h.state.scanId = 's1';
  h.state.root = { path: '/corpus', size: 1 };
  h.state.view = 'city';
  await h.loadCity('/corpus');
  assert.deepEqual(h.countAsks.map((a) => a.paths), [['/corpus/f1', '/corpus/f2']], 'control: the first batch');
  h.countAsks[0].answer(countAnswer(h.countAsks[0].paths));
  await settle();
  assert.deepEqual(h.countAsks.map((a) => a.paths).slice(1), [['/corpus/f3']], 'control: then the second');
  h.countAsks[1].fail(new Error('the connection dropped'));
  await settle();
  h.card!.setHeight('files'); // the next entry: Files chosen again
  assert.deepEqual(h.countAsks.map((a) => a.paths).slice(2), [['/corpus/f3']], 'the file the failed batch held is asked again, and only it');
});

test('C03: a count ask whose FIRST batch fails asks again, at the next entry, for the batches it never sent as well', async () => {
  // The case above fails the last batch, where "what it had not answered"
  // and "the batch that failed" are the same paths. Here the first batch
  // fails while the second has not been sent: releasing only the failing
  // batch would leave f3 marked asked, never asked again, and its building
  // flat for the rest of the scan (C03 review F3.2).
  const h = cityHarness({ batch: 2 });
  h.state.scanId = 's1';
  h.state.root = { path: '/corpus', size: 1 };
  h.state.view = 'city';
  await h.loadCity('/corpus');
  assert.deepEqual(h.countAsks.map((a) => a.paths), [['/corpus/f1', '/corpus/f2']], 'control: the first batch, the second not sent yet');
  h.countAsks[0].fail(new Error('the connection dropped'));
  await settle();
  assert.equal(h.countAsks.length, 1, 'control: the failure sent nothing more');
  h.card!.setHeight('files'); // the next entry: Files chosen again
  assert.deepEqual(h.countAsks.map((a) => a.paths).slice(1), [['/corpus/f1', '/corpus/f2']], 'the failed batch is asked again');
  h.countAsks[1].answer(countAnswer(h.countAsks[1].paths));
  await settle();
  assert.deepEqual(h.countAsks.map((a) => a.paths).slice(2), [['/corpus/f3']], 'and so is the batch the failure never sent');
  h.countAsks[2].answer(countAnswer(h.countAsks[2].paths));
  await settle();
  assert.equal(h.state.city.unknownHeight, 0, 'every building drawn stands at its count');
});

/** Disk City up on s1's /corpus with its count ask in flight, then a rescan s2 of the folder asking its own. */
async function rescanWhileCounting() {
  const h = cityHarness();
  h.state.scanId = 's1';
  h.state.root = { path: '/corpus', size: 1 };
  h.state.view = 'city';
  h.mounted.id = 'city';
  await h.loadCity('/corpus');
  assert.deepEqual(h.countAsks.map((a) => a.scanId), ['s1'], 'control: s1 is counting');
  h.state.scanId = 's2';
  void h.finishScan({ path: '/corpus', size: 2 }, 50, { fileCount: 4, dirCount: 1 });
  h.views.city.onScanChange('s2');
  await settle();
  assert.deepEqual(h.countAsks.map((a) => a.scanId), ['s1', 's2'], 'the rescan asks for the same buildings again, of its own scan');
  return h;
}

test('C03: a rescan\'s counts are not taken from the last scan\'s answer landing late', async () => {
  const h = await rescanWhileCounting();
  h.countAsks[0].answer(countAnswer(h.countAsks[0].paths, 999));
  await settle();
  assert.equal(h.state.city.counts.has('/corpus/f1'), false, 'the last scan\'s count is not filed against the rescan\'s building');
});

test('C03: the last scan\'s count ask failing late does not send the rescan\'s own ask again', async () => {
  const h = await rescanWhileCounting();
  h.countAsks[0].fail(new Error('the scan it asked of has gone'));
  await settle();
  h.card!.setHeight('files');
  assert.equal(h.countAsks.length, 2, 'the rescan\'s ask is still on its way; nothing is asked twice');
});

/* ══════════════ C03 review F3.1, F3.4 — what the city says of a folder it has not drawn ══════════════

   The build took only this scan's folder's nodes, but the line under the
   city and the size beside it still read the map: a city waiting on its
   fetch said "showing all 0 items of 4.0 KB or more" under the last scan's
   4.4 GB, the polite live region announced it, and a fetch that failed had
   its reason wiped by the next redraw — a resize, the Height or Colour
   control — leaving a blank plate that read as an empty folder. */

/** The line under the city (#cityLod) and the size beside it (#cityStatus). */
const chromeOf = (h: ReturnType<typeof harness>) => ({
  lod: (h.$('cityLod') as { textContent: string }).textContent,
  status: (h.$('cityStatus') as { textContent: string }).textContent,
});
const cityTrail = (h: ReturnType<typeof harness>) => h.crumbs.filter(([id]) => id === 'cityCrumbs').map(([, p]) => p);
const LOADING = { lod: 'loading this folder…', status: '' };

/**
 * A scan of /B landed while the Treemap still holds a 4.4 GB scan of /A, and
 * the Disk City tab is about to be pressed. The caller mounts the view, in
 * its own tick: an await between would let the fetch land first.
 */
async function scanOfAnotherBeforeCity(down: string | null = null) {
  const h = cityHarness({ realChrome: true });
  h.server.sizes['/A'] = 4_400_000_000;
  await scanAfterTreemap(h, '/A', '/B', 's2');
  assert.equal(h.state.treemap.rootSize, 4_400_000_000, 'control: the map still holds A\'s size');
  h.views.city.onScanChange('s2');
  h.state.view = 'city';
  h.server.down = down;
  return h;
}

test('C03: Disk City waiting on a new folder says it is loading, with no size and the new folder\'s trail — nothing of the map the last scan left', async () => {
  const h = await scanOfAnotherBeforeCity();
  h.views.city.mount(); // the Disk City tab
  assert.deepEqual(chromeOf(h), LOADING, 'not "showing all 0", and not A\'s 4.4 GB beside it');
  assert.deepEqual(cityTrail(h), ['/B'], 'the trail names the folder being loaded');
  assert.equal((h.$('cityUpBtn') as { disabled: boolean }).disabled, true, 'and Up has nowhere to go from the scan\'s own folder');
  h.chrome!(); // a redraw while it loads: a resize
  assert.deepEqual(chromeOf(h), LOADING, 'a redraw says the same');
  await settle();
  assert.match(chromeOf(h).lod, /^showing 3 of 4 items of 4000 B or more — zoom in for more/, 'control: B\'s own line once it lands');
  assert.equal(chromeOf(h).status, '30000 B', 'control: and B\'s own size');
});

test('C03: a fetch for the new folder that fails says so, and no redraw turns it into "showing all 0" under the last scan\'s size', async () => {
  const h = await scanOfAnotherBeforeCity('Couldn’t reach TreeMap.');
  h.views.city.mount();
  await settle();
  const failed = { lod: 'B did not load: Couldn’t reach TreeMap.', status: '' };
  assert.deepEqual(chromeOf(h), failed, 'it says which folder did not load, and why');
  h.chrome!(); // a window resize
  assert.deepEqual(chromeOf(h), failed, 'a resize repaints the same');
  h.card!.setHeight('depth'); // the Height control, the natural reaction to a blank city
  assert.deepEqual(chromeOf(h), failed, 'and so does the Height control');
  h.card!.setColour('age');
  assert.deepEqual(chromeOf(h), failed, 'and the Colour control');
  h.server.down = null;
  await h.loadCity('/B'); // the next entry
  assert.match(chromeOf(h).lod, /^showing 3 of 4/, 'a load that lands says what it drew, and nothing of the failure');
  assert.equal(chromeOf(h).status, '30000 B');
});

test('C03: Disk City already up when a scan of another folder lands says it is loading until the new folder lands — not the last city\'s line', async () => {
  const h = cityHarness({ realChrome: true });
  h.state.scanId = 's1';
  h.state.root = { path: '/A', size: 1 };
  h.server.sizes['/A'] = 4_400_000_000;
  h.state.view = 'city';
  h.mounted.id = 'city';
  await h.loadCity('/A');
  assert.equal(chromeOf(h).status, '4400000000 B', 'control: A is drawn, at its size');
  h.state.scanId = 's2';
  void h.finishScan({ path: '/B', size: 2 }, 50, { fileCount: 4, dirCount: 1 });
  h.views.city.onScanChange('s2'); // the city that is up reloads
  assert.deepEqual(chromeOf(h), LOADING, 'the last city\'s line and size go with its buildings');
  h.chrome!(); // a resize before B lands
  assert.deepEqual(chromeOf(h), LOADING, 'and a redraw does not bring them back');
  await settle();
  assert.match(chromeOf(h).lod, /^showing 3 of 4/, 'control: B lands');
});

test('C03: a drill whose fetch fails says so over the folder still drawn, through a redraw, until the next load', async () => {
  const h = cityHarness({ realChrome: true });
  h.state.scanId = 's1';
  h.state.root = { path: '/corpus', size: 1 };
  h.state.view = 'city';
  await h.loadCity('/corpus');
  const drawn = chromeOf(h);
  assert.match(drawn.lod, /^showing 3 of 4/, 'control: /corpus is drawn');
  h.server.down = 'HTTP 500';
  await h.loadCity('/corpus/Mail'); // a click on a building
  const failed = { lod: `Mail did not load: HTTP 500 · ${drawn.lod}`, status: drawn.status };
  assert.deepEqual(chromeOf(h), failed, 'what did not load, then what is still drawn: /corpus, at its own size');
  assert.deepEqual(cityTrail(h).slice(-1), ['/corpus'], 'and the trail is still the folder drawn');
  h.chrome!();
  assert.deepEqual(chromeOf(h), failed, 'a redraw keeps the failure');
  h.server.down = null;
  await h.loadCity('/corpus/Mail');
  assert.doesNotMatch(chromeOf(h).lod, /did not load/, 'the next load says nothing of the last one\'s failure');
});

test('C03: a load overtaken by a newer one that landed does not report its failure over the newer city', async () => {
  const h = cityHarness({ realChrome: true });
  h.state.scanId = 's1';
  h.state.root = { path: '/corpus', size: 1 };
  h.state.view = 'city';
  await h.loadCity('/corpus');
  h.server.hold = true;
  const slow = h.loadCity('/corpus/Mail'); // a click on a building
  const fast = h.loadCity('/corpus/Docs'); // then on another, before the first answered
  assert.deepEqual(h.server.held.map((x) => x.root), ['/corpus/Mail', '/corpus/Docs'], 'control: both are asked');
  h.server.held[1].land();
  await fast;
  assert.deepEqual(cityNames(h), ['s1:/corpus/Docs'], 'control: Docs is drawn');
  h.server.held[0].fail('HTTP 500');
  await slow;
  assert.match(chromeOf(h).lod, /^showing 3 of 4/, 'the line is Docs\', with no failure of a load nobody is waiting on');
});

test('C03: the size and the floor beside the city are those of the nodes it was built from — not of whatever the map holds since', async () => {
  const h = cityHarness({ realChrome: true });
  h.state.scanId = 's1';
  h.state.root = { path: '/corpus', size: 1 };
  h.server.sizes['/corpus'] = 777_000;
  await h.loadTreemap('/corpus');
  h.state.view = 'city';
  h.views.city.mount(); // on the nodes the Treemap fetched: built at once, with no request
  const shared = chromeOf(h);
  assert.deepEqual(shared, { lod: 'showing 3 of 4 items of 4000 B or more — zoom in for more · 3 with no count yet, drawn flat', status: '777000 B' },
    'the floor and the size the Treemap\'s fetch recorded with its nodes');
  // A Treemap fetch of another folder, asked before the person switched
  // views, lands after the city was built: the map moves on, the city does not.
  h.server.sizes['/corpus/Mail'] = 5_000;
  await h.loadTreemap('/corpus/Mail');
  h.state.treemap.minSize = 1;
  h.chrome!();
  assert.deepEqual(chromeOf(h), shared, 'the city drawn is still /corpus, and its line and size say so');
});

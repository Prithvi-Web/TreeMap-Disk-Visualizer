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

/** The named declarations in one scope, `deps` as their globals. */
function load<T>(names: string[], deps: Record<string, unknown>, returns: string, prelude = ''): T {
  const keys = Object.keys(deps);
  const src = `'use strict'; ${prelude}\n${names.map(declSource).join('\n')}\nreturn ${returns};`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...keys, src)(...keys.map((k) => deps[k])) as T;
}

interface Node { path: string; name: string; size: number; type: string }

/** One element per id, holding whatever the code under test writes to it. */
function fakeDom() {
  const els = new Map<string, Record<string, unknown>>();
  return (id: string): Record<string, unknown> => {
    if (!els.has(id)) {
      els.set(id, {
        id, hidden: false, disabled: false, textContent: '', innerHTML: '', dataset: {}, style: {},
        classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [], offsetWidth: 230, offsetHeight: 90, clientWidth: 900, clientHeight: 600,
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
function harness(opts: { realCard?: boolean; lapse?: boolean } = {}) {
  const asked: string[] = [];
  const built: Node[][] = [];
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
      hover: null, pan: { x: 0, y: 0 }, zoom: 1, blocks: [] as Block[], counts: new Map(), countsFor: null,
      colour: 'reclaim', height: 'staleness',
    },
  };
  const api = async (url: string) => {
    asked.push(url);
    const m = /^\/api\/scan\/([^/]+)\/treemap\?.*root=([^&]+)/.exec(url);
    assert.ok(m, `the stub serves the treemap layout only, not ${url}`);
    const [, scanId, root] = [m[0], m[1], decodeURIComponent(m[2])];
    const nodes: Node[] = [1, 2, 3].map((i) => ({ path: `${root}/f${i}`, name: `${scanId}:${root}`, size: 5000 * i, type: 'file' }));
    return { root: { path: root, name: root.split('/').pop(), size: 30000 }, nodes };
  };
  const noop = () => {};
  const deps: Record<string, unknown> = {
    state, $, api, REDUCED: true, requestAnimationFrame: noop,
    isSun: () => false, isCells: () => false, exitCartPreview: noop,
    // finishScan's completion toast is expected; any other is a loader reporting a failure.
    toast: (m: string) => { if (!/^Scan complete/.test(m)) throw new Error('the page reported: ' + m); },
    renderCrumbs: noop, maybeInjectTrash: noop, exitHistoryState: noop, refreshTimebar: noop, drawView: noop,
    animateTreemapTo: (nodes: Node[]) => { state.treemap.nodes = nodes; },
    disableLive: noop, drawCells: noop, animateSunburstTo: noop, updateTimeLabel: noop,
    historyLayoutFor: async (snap: { takenAt: number }) => ({
      snapshot: { takenAt: snap.takenAt }, tree: null, root: { path: state.root!.path, size: 1 },
      nodes: [{ path: `${state.root!.path}/old`, name: `snapshot:${snap.takenAt}`, size: 1, type: 'file' }],
    }),
    // Disk City's own drawing is not under test: what it was handed to draw is.
    // A rebuild makes new blocks for the same paths, as the page's does.
    buildCity: () => { built.push(state.treemap.nodes.slice()); state.city.blocks = state.city.blocks.map((b) => ({ ...b })); },
    cityEnter: noop, renderCityTable: noop, cityFetchFacts: noop, drawCity: noop, cityMorphHeights: () => false,
    // One base colour per mode, so a card says which mode it was painted in.
    cityRgb: (_n: unknown, mode: string) => (mode === 'type' ? [191, 90, 242] : mode === 'age' ? [10, 200, 10] : [58, 64, 72]),
    reclaim: { scores: new Map() }, localStorage: { setItem: noop, getItem: () => null },
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
    card?: {
      show: (b: Block | null, px?: number, py?: number) => void;
      up: () => void;
      setColour: (m: string) => void;
      setHeight: (m: string) => void;
      jitter: (rgb: number[], path: string) => number[];
    };
  }>(['TM_MIN_SIZE', 'loadTreemap', 'loadCity', 'finishScan', 'setHistoryIndex', ...(opts.realCard ? cardNames : []), ...(opts.lapse ? lapseNames : [])], deps,
    `{ loadTreemap, loadCity, finishScan, setHistoryIndex${opts.realCard
      ? ', card: { show: cityShowCard, up: cityUp, setColour: citySetColour, setHeight: citySetHeight, jitter: cityJitter }'
      : ''}${opts.lapse ? ', lapse: { start: lapseStart, stop: lapseStop }' : ''} }`,
    'let tmLoadSeq = 0; let cityLoadSeq = 0; let tmAnimFrame = 0; let lapseExporting = false; let lapseInternalStart = false;');
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
  return { ...page, state, asked, built, lastBuilt, $, pump, frames };
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
async function cityWithCard() {
  const h = harness({ realCard: true });
  h.state.scanId = 's1';
  h.state.root = { path: '/corpus', size: 1 };
  h.state.view = 'city';
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

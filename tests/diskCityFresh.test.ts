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
        classList: { add() {}, remove() {}, toggle() {} }, offsetWidth: 230, offsetHeight: 90, clientWidth: 900, clientHeight: 600,
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
function harness() {
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
      history: { active: false, scrubbing: false, snaps: [] as Array<{ id: string; takenAt: number }>, index: 0, seq: 0, tree: null, viewingAt: 0 },
    },
    city: { hover: null, pan: { x: 0, y: 0 }, zoom: 1, blocks: [], counts: new Map(), countsFor: null },
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
    buildCity: () => { built.push(state.treemap.nodes.slice()); }, cityEnter: noop, renderCityTable: noop, cityFetchFacts: noop,
    cityShowCard: noop,
    // finishScan's surroundings.
    endScanChrome: noop, indexTree: noop, updateSelectionBar: noop, DUP_PAGE: 100, icon: () => '',
    formatCount: (n: number) => String(n), formatBytes: (n: number) => `${n} B`, escapeHtml: (s: string) => s,
    countUp: noop, FxNum: { rollText: noop }, renderDiskNotes: noop, loadWhatsNew: noop, loadDriveHealth: noop,
    loadCostEstimate: noop, showListsPending: noop, emit: noop, TOPIC: { scan: 'scan' }, switchView: noop, fxScanDonePulse: noop,
    // The three list walks have not answered: the person went straight to Disk City.
    loadDashboardLists: () => new Promise(() => {}),
    buildIndexInBackground: noop, formatClock: () => '10:31 PM',
  };
  const page = load<{
    loadTreemap: (p: string) => Promise<void>;
    loadCity: (p: string | null) => Promise<void>;
    finishScan: (root: unknown, ms: number, stats: unknown) => Promise<void>;
    setHistoryIndex: (i: number) => Promise<void>;
  }>(['TM_MIN_SIZE', 'loadTreemap', 'loadCity', 'finishScan', 'setHistoryIndex'], deps,
    '{ loadTreemap, loadCity, finishScan, setHistoryIndex }', 'let tmLoadSeq = 0; let cityLoadSeq = 0;');
  /** The scan:folder every node Disk City was last handed names. */
  const lastBuilt = () => [...new Set((built[built.length - 1] ?? []).map((n) => n.name))];
  return { ...page, state, asked, built, lastBuilt };
}

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

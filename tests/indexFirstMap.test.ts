import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-indexFirstMap-data-');

import { buildTreemap } from '../src/utils/treemap';
import type { FileNode } from '../src/models/types';
import { INDEX, lift } from './fixtures/liftFrontend';

/** The page's own size words: decimal, as Finder counts them. */
const formatBytes = lift<(n: number) => string>(['UNITS', 'UI_LOCALE', 'formatBytes'], 'formatBytes');

/**
 * The map of a folder opened from its saved index (seventh browser pass, J05).
 *
 * TreeMap paints a folder with a saved index at once, from the index, while
 * its scan runs behind it. The rectangle map is laid out by the SERVER, and
 * only for a scan it ran — so that tree had no map at all: the Treemap view
 * stood blank until the scan completed, and for ever after a Stop. The page
 * now lays the map of such a tree out itself, with a port of the server's
 * buildTreemap; these tests run the port beside the real one and demand the
 * same nodes, and run the page's own loadTreemap over a tree with no scan
 * behind it. Every function here is lifted out of the built page and
 * EXECUTED; nothing is timed.
 */

/** `function name(…) {…}` (async too) or a one-statement `const NAME = …;`, out of the built page. */
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
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`${name} never closes`);
}

/** The named declarations evaluated in one scope, with `deps` as their globals. */
function load<T>(names: string[], deps: Record<string, unknown>, returns: string, prelude = ''): T {
  const keys = Object.keys(deps);
  const src = `'use strict'; ${prelude}\n${names.map(declSource).join('\n')}\nreturn ${returns};`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...keys, src)(...keys.map((k) => deps[k])) as T;
}

type Layout = (root: FileNode, maxDepth: number, minSize: number, maxNodes: number) => unknown[];
const LAYOUT_DECLS = ['tmLayoutTree', 'tmSquarify', 'tmWorstRatio'];
const tmLayoutTree = load<Layout>(LAYOUT_DECLS, {}, 'tmLayoutTree');

/** A node as the server sends it: JSON drops the fields a scan left undefined. */
const wire = (x: unknown) => JSON.parse(JSON.stringify(x)) as unknown;

/** A small deterministic generator, so every run lays out the same trees. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/**
 * A tree with what the layout has to tell apart: folders inside folders,
 * files above and below the 4 KB floor, empty files, a folder the index's
 * preview withheld (`pruned`, no children), a container with virtual
 * entries, cloud placeholders, a git repository, and folders wide enough to
 * reach a cap and leave rectangles too thin to divide.
 */
function corpus(seed: number): FileNode {
  const r = rng(seed);
  const file = (dir: string, i: number): FileNode => {
    const roll = r();
    const size = roll < 0.08 ? 0 : roll < 0.45 ? Math.floor(r() * 3999) + 1 : Math.floor(r() * 50_000_000) + 4000;
    return { name: `f${i}.dat`, path: `${dir}/f${i}.dat`, size, type: 'file', extension: 'dat', modifiedAt: 1_700_000_000_000 + i,
      isHidden: false, ...(r() < 0.05 ? { cloudPlaceholder: true } : {}) };
  };
  const dir = (p: string, depth: number): FileNode => {
    const children: FileNode[] = [];
    const files = depth === 0 ? 40 : Math.floor(r() * 30);
    for (let i = 0; i < files; i++) children.push(file(p, i));
    const dirs = depth >= 5 ? 0 : Math.floor(r() * (depth === 0 ? 6 : 4));
    for (let i = 0; i < dirs; i++) children.push(dir(`${p}/d${i}`, depth + 1));
    if (depth === 1 && r() < 0.6) {
      // A folder the preview withheld: its size is exact, its children are not here.
      children.push({ name: 'withheld', path: `${p}/withheld`, size: Math.floor(r() * 900_000_000) + 1, type: 'dir', pruned: true, modifiedAt: 1, isHidden: false });
    }
    if (depth === 1 && r() < 0.5) {
      const zip = `${p}/archive.zip`;
      const entries: FileNode[] = [0, 1, 2].map((i) => ({ name: `e${i}`, path: `${zip}/e${i}`, size: 10_000 * (i + 1), type: 'file', modifiedAt: 1, isHidden: false, virtual: true, logicalSize: 30_000 * (i + 1) } as FileNode));
      children.push({ name: 'archive.zip', path: zip, size: 60_000, type: 'file', extension: 'zip', modifiedAt: 1, isHidden: false, container: 'zip', children: entries } as FileNode);
    }
    if (depth === 2 && r() < 0.3) {
      // A folder of a thousand tiny files: rectangles too thin to divide, and a cap to reach.
      const many: FileNode[] = [];
      for (let i = 0; i < 1000; i++) many.push({ name: `t${i}`, path: `${p}/many/t${i}`, size: 4000 + i, type: 'file', modifiedAt: 1, isHidden: false });
      children.push({ name: 'many', path: `${p}/many`, size: many.reduce((a, c) => a + c.size, 0), type: 'dir', modifiedAt: 1, isHidden: false, children: many });
    }
    const size = children.reduce((a, c) => a + c.size, 0);
    return { name: p.slice(p.lastIndexOf('/') + 1), path: p, size, type: 'dir', modifiedAt: 1_700_000_000_000, isHidden: false, children,
      ...(depth === 1 && r() < 0.3 ? { gitRepo: true } : {}) };
  };
  return dir('/r', 0);
}

test('the map the page lays out of a tree it holds is the map the server lays out of the same tree — node for node, at every depth, floor and cap (J05)', () => {
  let nodes = 0, expanded = 0, leaves = 0, capped = 0, containers = 0, withheld = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const tree = corpus(seed);
    for (const [maxDepth, minSize, maxNodes] of [[4, 4000, 20_000], [4, 1, 20_000], [1, 4000, 20_000], [8, 0, 20_000], [3, 4000, 50], [6, 1, 777]] as const) {
      const server = wire(buildTreemap(tree, { maxDepth, minSize, maxNodes })) as Array<{ expanded: boolean; container?: string; path: string }>;
      const page = wire(tmLayoutTree(tree, maxDepth, minSize, maxNodes));
      assert.deepEqual(page, server, `seed ${seed}, depth ${maxDepth}, floor ${minSize}, cap ${maxNodes}: the same nodes, in the same order`);
      nodes += server.length;
      expanded += server.filter((n) => n.expanded).length;
      leaves += server.filter((n) => !n.expanded).length;
      if (server.length === maxNodes) capped++;
      containers += server.filter((n) => n.container).length;
      withheld += server.filter((n) => n.path.endsWith('/withheld')).length;
    }
  }
  // Controls: the corpus exercised what it was built to.
  assert.ok(nodes > 20_000, `control: ${nodes} nodes compared`);
  assert.ok(expanded > 100 && leaves > 1000, `control: folders opened (${expanded}) and leaves drawn (${leaves})`);
  assert.ok(capped >= 12, `control: the cap was reached (${capped} layouts)`);
  assert.ok(containers > 0, `control: containers drawn (${containers})`);
  assert.ok(withheld > 0, `control: a folder the preview withheld is drawn as a leaf (${withheld})`);
});

/* ══════════════ loadTreemap over a tree with no scan behind it ══════════════ */

const MAP_DECLS = ['loadTreemap', 'TM_MIN_SIZE', 'TM_SERVER_NODE_CAP', 'tmHeldTreemap', ...LAYOUT_DECLS];

/** Every node of a tree by its path, as indexTree keeps them. */
function pathIndexOf(root: FileNode): Map<string, FileNode> {
  const m = new Map<string, FileNode>();
  const walk = (n: FileNode) => { m.set(n.path, n); for (const c of n.children ?? []) walk(c); };
  walk(root);
  return m;
}

/**
 * The page's loadTreemap with `root` on screen and `scanId` behind it (null:
 * the saved index's tree), its map drawn through a recorded drawView.
 * `fetched` is what the index answers for a folder its preview withheld.
 */
function mapPage(root: FileNode, scanId: string | null, fetched: Record<string, FileNode> = {}) {
  const pathIndex = pathIndexOf(root);
  const state = {
    scanId, root, pathIndex,
    treemap: { mode: 'treemap', maxDepth: 4, rootPath: root.path, rootName: '', rootSize: 0, nodes: [] as unknown[], nodesFor: null as unknown,
      minSize: 0, hover: null, kbSel: null, history: { scrubbing: false, active: false } },
  };
  const asked: string[] = [];
  const subtrees: string[] = [];
  const drawn: Array<{ rootPath: string; nodes: unknown[] }> = [];
  const crumbs: string[] = [];
  const el = () => ({ classList: { add() {}, remove() {} }, disabled: false });
  const els: Record<string, ReturnType<typeof el>> = {};
  const loadTreemap = load<(p: string) => Promise<void>>(MAP_DECLS, {
    state,
    $: (id: string) => (els[id] ||= el()),
    REDUCED: true,
    isSun: () => false,
    isCells: () => false,
    exitCartPreview() {},
    altCircleFor: () => null,
    // ensureSubtree as the page's answers with no scan: the node held, or, withheld, the index's answer for it.
    ensureSubtree: async (p: string) => {
      subtrees.push(p);
      const have = pathIndex.get(p);
      if (have && !have.pruned) return have;
      return fetched[p] ?? have ?? null;
    },
    api: async (url: string) => {
      asked.push(url);
      if (!scanId) throw new Error(`asked the server for a map of a scan that is not there: ${url}`);
      return { root: { path: root.path, name: root.name, size: root.size }, nodes: [{ path: `${root.path}/x`, size: 1 }] };
    },
    renderCrumbs: (_host: unknown, p: string) => { crumbs.push(p); },
    exitHistoryState() {},
    refreshTimebar() {},
    tmSetEmpty() {},
    maybeInjectTrash() {},
    altBeginZoom() {},
    toast: (m: string) => { throw new Error('loadTreemap reported a failure: ' + m); },
    requestAnimationFrame: (f: () => void) => f(),
    drawView: () => { drawn.push({ rootPath: state.treemap.rootPath, nodes: state.treemap.nodes }); },
  }, 'loadTreemap', 'let tmLoadSeq = 0;');
  return { loadTreemap, state, asked, subtrees, drawn, crumbs };
}

const leaf = (dir: string, name: string, size: number): FileNode => ({ name, path: `${dir}/${name}`, size, type: 'file', modifiedAt: 1, isHidden: false });
const folder = (p: string, children: FileNode[]): FileNode => ({ name: p.slice(p.lastIndexOf('/') + 1), path: p, size: children.reduce((a, c) => a + c.size, 0), type: 'dir', modifiedAt: 1, isHidden: false, children });

test('with no scan behind the tree on screen — the saved index\'s — loadTreemap draws its map, laid out here, and asks the server for nothing (J05)', async () => {
  // The corpus tree with the largest map, so the control below is about a real one.
  const size = (t: FileNode) => buildTreemap(t, { maxDepth: 4, minSize: 4000, maxNodes: 20_000 }).length;
  const tree = Array.from({ length: 12 }, (_, i) => corpus(i + 1)).sort((a, b) => size(b) - size(a))[0];
  const h = mapPage(tree, null);
  await h.loadTreemap(tree.path);
  assert.deepEqual(h.asked, [], 'the server is asked for nothing: it lays a map out only for a scan it ran');
  assert.equal(h.drawn.length, 1, 'the map is drawn — never a blank canvas waiting for a scan');
  assert.deepEqual(wire(h.drawn[0].nodes), wire(buildTreemap(tree, { maxDepth: 4, minSize: 4000, maxNodes: 20_000 })),
    'with the rectangles the server would lay out of the same tree, at the 4 KB floor');
  assert.ok(h.drawn[0].nodes.length > 200, `control: a real map (${h.drawn[0].nodes.length} rectangles)`);
  assert.ok((h.drawn[0].nodes as Array<{ expanded: boolean }>).some((n) => n.expanded), 'control: with folders opened inside it');
  assert.equal(h.state.treemap.rootPath, tree.path, 'named by the folder it draws');
  assert.deepEqual(h.crumbs, [tree.path], 'and its crumbs');
  assert.equal(h.state.treemap.rootSize, tree.size, 'with the folder\'s exact size');
  assert.equal(h.state.treemap.minSize, 4000, 'and the floor it was laid out with (tmNodeCapNote)');
  assert.deepEqual(h.state.treemap.nodesFor, { scanId: null, path: tree.path, nodes: h.state.treemap.nodes, size: tree.size, minSize: 4000 },
    'recorded as no scan\'s: Disk City, which needs a scan, never reuses it, and the footer says it is the saved index');

  // Control: with a scan behind the tree, the server lays the map out, as before.
  const scanned = mapPage(tree, 's1');
  await scanned.loadTreemap(tree.path);
  assert.equal(scanned.asked.length, 1, 'control: a scan\'s map is the server\'s');
  assert.match(scanned.asked[0], /^\/api\/scan\/s1\/treemap\?maxDepth=4&minSize=4000&root=/);
});

test('the map of a saved index\'s tree drops the floor for a folder of small files, as a scan\'s does, and draws a folder its preview withheld once the index has answered for it (J05)', async () => {
  // A folder of 2.9 KB mail files (corpus/Mail, 37.7 MB of them) is all under the 4 KB floor.
  const mail = folder('/r/Mail', Array.from({ length: 30 }, (_, i) => leaf('/r/Mail', `m${i}.emlx`, 2900)));
  const small = mapPage(mail, null);
  await small.loadTreemap(mail.path);
  assert.equal(small.drawn.length, 1);
  assert.equal(small.state.treemap.minSize, 1, 'laid out again with no floor');
  assert.deepEqual(wire(small.drawn[0].nodes), wire(buildTreemap(mail, { maxDepth: 4, minSize: 1, maxNodes: 20_000 })), 'every file drawn');
  assert.equal(small.drawn[0].nodes.length, 30, 'control: all thirty');

  // A drill into a folder the preview withheld: the index answers for it, and it is drawn.
  const big = folder('/r/big', [leaf('/r/big', 'a.mov', 9_000_000), leaf('/r/big', 'b.mov', 4_000_000)]);
  const withheld: FileNode = { name: 'big', path: '/r/big', size: big.size, type: 'dir', pruned: true, modifiedAt: 1, isHidden: false };
  const root = { ...folder('/r', [leaf('/r', 'c.txt', 5000)]), children: [withheld, leaf('/r', 'c.txt', 5000)], size: big.size + 5000 };
  const drill = mapPage(root, null, { '/r/big': big });
  await drill.loadTreemap('/r/big');
  assert.ok(drill.subtrees.includes('/r/big'), 'the withheld folder is asked of the index');
  assert.equal(drill.state.treemap.rootPath, '/r/big', 'and the map is of it');
  assert.deepEqual(wire(drill.drawn.at(-1)!.nodes), wire(buildTreemap(big, { maxDepth: 4, minSize: 4000, maxNodes: 20_000 })), 'with its files drawn');
  assert.deepEqual(drill.asked, [], 'and the server was asked for no map');
});

/* ══════════════ the footer says it is the saved index ══════════════ */

test('the map\'s footer says a map laid out from the saved index is from the saved index — and only that map (J05)', () => {
  const status = { textContent: '' };
  const nodes = [{ path: '/r/a', size: 5000 }];
  const state = {
    treemap: { query: '', history: { active: false }, minSize: 4000, rootSize: 37_700_000, nodes, nodesFor: null as unknown,
      pxRects: [{ n: { path: '/r/a' } }] },
  };
  const update = load<() => void>(['updateTmStatus'], {
    state, $: () => status, tmPreview: { on: false }, isSun: () => false, isCells: () => false,
    formatCount: (n: number) => n.toLocaleString('en-US'), formatBytes, formatWhen: String,
  }, 'updateTmStatus');
  state.treemap.nodesFor = { scanId: null, path: '/r', nodes, size: 37_700_000, minSize: 4000 };
  update();
  assert.equal(status.textContent, '1 item of 4.0 KB or more drawn · 37.7 MB in this folder · from the saved index',
    'a map laid out from the saved index says so where the map is (sizes decimal)');
  state.treemap.nodesFor = { scanId: 's1', path: '/r', nodes, size: 37_700_000, minSize: 4000 };
  update();
  assert.doesNotMatch(status.textContent, /saved index/, 'a scan\'s map does not');
  state.treemap.nodesFor = { scanId: null, path: '/r', nodes: [], size: 37_700_000, minSize: 4000 };
  update();
  assert.doesNotMatch(status.textContent, /saved index/, 'nor a map drawn since from other rectangles (a past snapshot, a preview)');
});

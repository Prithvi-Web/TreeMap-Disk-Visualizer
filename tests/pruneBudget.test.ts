import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-pruneBudget-data-');

import { HANG_GUARD_MS } from './fixtures/waitFor';
import { INDEX } from './fixtures/liftFrontend';
import { buildPair, mutateBoth, verifyPruneInvariants } from './fixtures/storeFuzz';
import { ObjectScanStore, PackedScanStore, prunedExpansion, pruneStore, type NodeInput, type ScanStore } from '../src/services/scanStore';
import type { FileNode } from '../src/models/types';
import { createApp } from '../src/server';
import { createScanRecord } from '../src/services/diskScanner';
import { PRUNE_MAX_NODES, firstFrameMaxNodes, setPruneMaxNodesForTests } from '../src/api/scanRoutes';

/**
 * Plan U-19, the owner's answer to U-Q6 (2 Oct 2026: yes, strict, no
 * tolerance): the first tree sent to the window honours its node budget.
 *
 * The prune expands folders largest first while fewer than `maxNodes` nodes
 * are counted, and a popped folder gives every child (a folder is shown whole
 * or not at all), so the last folder popped could take the tree past the
 * budget by its whole width. On the diagnosis Mac one folder of at least
 * 421,546 entries turned the 250,000-node budget into 671,545 nodes and a
 * 238.6 MB frame. Under `overshoot: 'none'` a popped folder whose children
 * would pass the budget stays `pruned` (the window opens it through
 * `/subtree` when the user does) and the prune goes on to the next, smaller
 * one — except the prune's own root, whose children always come. So a first
 * frame holds at most max(maxNodes, 1 + the root's children) nodes, and at
 * maxNodes = 1 the root alone. Where today's tree already fits the budget the
 * JSON is byte for byte today's. `/subtree` and every other prune keep
 * today's rule.
 */

const BUDGETS = [1, 2, 7, 20, 40, 250, 20_000, 250_000];

/** Nodes in a pruned tree, walked with a stack of its own. */
function countNodes(root: FileNode): number {
  let nodes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop() as FileNode;
    nodes++;
    if (n.children) for (const c of n.children) stack.push(c);
  }
  return nodes;
}

/** The ids of the folders a pruned tree gives children to, ascending. */
function expandedIds(store: ScanStore, root: FileNode): number[] {
  const ids: number[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop() as FileNode;
    if (n.children && n.children.length > 0) {
      ids.push(store.findByPath(n.path));
      for (const c of n.children) stack.push(c);
    }
  }
  return ids.sort((a, b) => a - b);
}

const ascending = (ids: Iterable<number>): number[] => [...ids].sort((a, b) => a - b);

test("under overshoot 'none' the budget is honoured but for the root's own children, on the fuzz trees in both stores, before and after watcher edits", () => {
  let leftClosed = 0;
  let fitted = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const { obj, packed, rng } = buildPair(seed, seed, 300 + seed * 170);
    for (const round of ['as scanned', 'after edits']) {
      if (round === 'after edits') mutateBoth(obj, packed, rng);
      for (const maxNodes of BUDGETS) {
        // ObjectScanStore.prune is pruneTree over the object tree, the oracle;
        // PackedScanStore.prune is pruneStore.
        const oracle = obj.prune(obj.rootId, { maxNodes, overshoot: 'none' });
        for (const store of [obj, packed] as ScanStore[]) {
          const at = `seed ${seed}, ${round}, ${store.constructor.name}, maxNodes ${maxNodes}`;
          const strict = store.prune(store.rootId, { maxNodes, overshoot: 'none' });
          const today = store.prune(store.rootId, { maxNodes });
          assert.equal(strict.nodes, countNodes(strict.root), `${at}: nodes counts the tree returned`);
          const bound = maxNodes === 1 ? 1 : Math.max(maxNodes, 1 + store.childCount(store.rootId));
          assert.ok(strict.nodes <= bound, `${at}: ${strict.nodes} nodes, past ${bound}`);
          // Every expanded folder carries every child, every size is the store's, never both marks.
          verifyPruneInvariants(store, strict.root);
          if (today.nodes <= maxNodes) {
            assert.equal(JSON.stringify(strict.root), JSON.stringify(today.root), `${at}: today's tree fits, so it is today's bytes`);
            fitted++;
          } else if (strict.nodes < today.nodes) {
            leftClosed++;
          }
          assert.deepEqual(
            ascending(prunedExpansion(store, store.rootId, { maxNodes, overshoot: 'none' })),
            expandedIds(store, strict.root),
            `${at}: prunedExpansion names the folders the prune expands`,
          );
          assert.equal(JSON.stringify(strict.root), JSON.stringify(oracle.root), `${at}: pruneTree and pruneStore agree`);
          assert.equal(strict.nodes, oracle.nodes, `${at}: nodes`);
          assert.equal(strict.prunedDirs, oracle.prunedDirs, `${at}: prunedDirs`);
        }
      }
    }
  }
  assert.ok(leftClosed > 0, `the rule left a folder closed in some case (${leftClosed})`);
  assert.ok(fitted > 0, `and some case fitted the budget as it is (${fitted})`);
});

/* -------------------------- trees made by hand -------------------------- */

const file = (name: string, size: number): NodeInput => ({ name, isDir: false, size, modifiedAt: 1_700_000_000_000, isHidden: false });
const dir = (name: string): NodeInput => ({ name, isDir: true, size: 0, modifiedAt: 1_700_000_000_000, isHidden: false });

/** Both stores holding the tree `build` adds, finalized and summed. */
function storesOf(rootPath: string, sep: '/' | '\\', build: (add: (parent: number, input: NodeInput) => number) => void): [ObjectScanStore, PackedScanStore] {
  const rootInput = dir(rootPath);
  const obj = new ObjectScanStore(rootPath, sep, rootInput);
  const packed = new PackedScanStore(rootPath, sep, rootInput);
  build((parent, input) => {
    const o = obj.addNode(parent, input);
    assert.equal(packed.addNode(parent, input), o, 'the two stores number alike');
    return o;
  });
  for (const store of [obj, packed]) {
    store.finalize();
    store.sumSizes();
  }
  return [obj, packed];
}

/** A pruned tree's direct children by name. */
function kidsOf(root: FileNode): Record<string, FileNode> {
  return Object.fromEntries((root.children ?? []).map((c) => [c.name, c]));
}

/** The prunes a first frame can be made by: the store's own, and pruneStore over it. */
function strictPrunes(store: ScanStore, maxNodes: number): Array<[string, { root: FileNode; nodes: number }]> {
  return [
    [`${store.constructor.name}.prune`, store.prune(store.rootId, { maxNodes, overshoot: 'none' })],
    [`pruneStore over ${store.constructor.name}`, pruneStore(store, store.rootId, { maxNodes, overshoot: 'none' })],
  ];
}

test('a 300-child folder at budget 40 stays closed, and a smaller folder popped after it is opened', () => {
  for (const store of storesOf('/hand', '/', (add) => {
    const big = add(0, dir('big'));
    for (let i = 0; i < 300; i++) add(big, file(`b${i}`, 100));
    const small = add(0, dir('small'));
    for (let i = 0; i < 5; i++) add(small, file(`s${i}`, 10));
    add(0, file('loose', 1));
  })) {
    for (const [how, strict] of strictPrunes(store, 40)) {
      const kids = kidsOf(strict.root);
      assert.equal(kids.big.pruned, true, `${how}: the folder whose 300 children would pass 40 stays closed`);
      assert.equal(kids.big.children, undefined, how);
      assert.equal(kids.big.size, 30_000, `${how}: and keeps its true size`);
      assert.equal(kids.small.children?.length, 5, `${how}: the smaller folder popped after it is opened`);
      assert.equal(strict.nodes, 9, how);
    }
    assert.deepEqual(ascending(prunedExpansion(store, store.rootId, { maxNodes: 40, overshoot: 'none' })), [0, store.findByPath('/hand/small')]);
    // Today's rule, for contrast: the big folder whole, past the budget, and the small one closed.
    const today = store.prune(store.rootId, { maxNodes: 40 });
    assert.equal(today.nodes, 304);
    assert.equal(kidsOf(today.root).small.pruned, true);
  }
});

test("a folder that fits exactly is opened, the scanned folder's own children always come, and a budget of 1 is the root alone", () => {
  // The root's pop counts 4 rows; the 36-file folder then makes exactly 40.
  for (const store of storesOf('/fit', '/', (add) => {
    const fit = add(0, dir('fit'));
    for (let i = 0; i < 36; i++) add(fit, file(`f${i}`, 10));
    const other = add(0, dir('other'));
    for (let i = 0; i < 2; i++) add(other, file(`o${i}`, 1));
    add(0, file('loose', 1));
  })) {
    for (const [how, strict] of strictPrunes(store, 40)) {
      const kids = kidsOf(strict.root);
      assert.equal(kids.fit.children?.length, 36, `${how}: 4 + 36 = 40 fits a budget of 40`);
      assert.equal(kids.other.pruned, true, `${how}: and the budget is then spent`);
      assert.equal(strict.nodes, 40, how);
    }
    for (const [how, strict] of strictPrunes(store, 1)) {
      assert.equal(strict.nodes, 1, how);
      assert.equal(strict.root.pruned, true, `${how}: at a budget of 1 the root alone, closed`);
      assert.equal(strict.root.children, undefined, how);
    }
  }
  for (const store of storesOf('/wide', '/', (add) => {
    for (let i = 0; i < 300; i++) add(0, file(`w${i}`, 1 + i));
  })) {
    for (const [how, strict] of strictPrunes(store, 40)) {
      assert.equal(strict.root.children?.length, 300, `${how}: the scanned folder's own 300 children come at a budget of 40`);
      assert.equal(strict.nodes, 301, how);
    }
  }
});

/* ------------------------------ the routes ------------------------------ */

/** The platform's own spelling of an absolute root, so `/subtree`'s path guard hands it back unchanged. */
const ROOT = path.resolve('/treemap-u19');
const SEP = path.sep as '/' | '\\';
const WIDE = 5_000;

/** A root holding a folder of 5,000 files (5 MB) and ten folders of 50 small files each. */
function wideScanStore(): PackedScanStore {
  return storesOf(ROOT, SEP, (add) => {
    const wide = add(0, dir('wide'));
    for (let i = 0; i < WIDE; i++) add(wide, file(`w${i}.bin`, 1_000));
    for (let d = 0; d < 10; d++) {
      const folder = add(0, dir(`d${d}`));
      for (let i = 0; i < 50; i++) add(folder, file(`f${i}.txt`, 10 + d));
    }
  })[1];
}

function completedScan(store: ScanStore): string {
  const scan = createScanRecord(store.rootPath);
  scan.status = 'complete';
  scan.store = store;
  scan.fileCount = WIDE + 500;
  scan.dirCount = 11;
  scan.scanned = WIDE + 511;
  scan.finishedAt = scan.startedAt + 10;
  return scan.scanId;
}

async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function get(port: number, route: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: route }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(HANG_GUARD_MS, () => req.destroy(new Error(`${route} never answered`)));
  });
}

/** The progress stream's complete frame, read to the end of the stream. */
async function streamedTree(port: number, scanId: string): Promise<FileNode> {
  const { body } = await get(port, `/api/scan/${scanId}/progress`);
  const frame = body.split('\n\n').find((f) => f.startsWith('data: {"type":"complete"'));
  assert.ok(frame, `the stream sent a complete frame: ${body.slice(0, 200)}`);
  return (JSON.parse(frame.slice('data: '.length)) as { root: FileNode }).root;
}

test("through the routes, a 5,000-child folder at a first-frame budget of 1,000 stays closed: the stream's frame and /result hold at most 1,000 nodes", async (t) => {
  t.after(() => setPruneMaxNodesForTests(null));
  setPruneMaxNodesForTests(1_000);
  const store = wideScanStore();
  const scanId = completedScan(store);
  const { port, close } = await listen();
  try {
    const streamed = await streamedTree(port, scanId);
    const result = await get(port, `/api/scan/${scanId}/result`);
    assert.equal(result.status, 200);
    const fallback = (JSON.parse(result.body) as { root: FileNode }).root;
    for (const [route, root] of [['the progress stream', streamed], ['/result', fallback]] as const) {
      assert.ok(countNodes(root) <= 1_000, `${route}: ${countNodes(root)} nodes, past a budget of 1,000`);
      const kids = kidsOf(root);
      assert.equal(kids.wide.pruned, true, `${route}: the 5,000-child folder is left closed`);
      assert.equal(kids.wide.size, WIDE * 1_000, `${route}: with its true size`);
      for (let d = 0; d < 10; d++) assert.equal(kids[`d${d}`].children?.length, 50, `${route}: d${d} opened whole`);
      assert.equal(JSON.stringify(root), JSON.stringify(store.prune(store.rootId, { maxNodes: 1_000, overshoot: 'none' }).root), `${route}: pruneStore's strict tree, byte for byte`);
    }
    // The drill-in keeps today's rule: the folder opened through /subtree gives every child.
    const opened = await get(port, `/api/scan/${scanId}/subtree?path=${encodeURIComponent(path.join(ROOT, 'wide'))}`);
    assert.equal(opened.status, 200);
    assert.equal((JSON.parse(opened.body) as { root: FileNode }).root.children?.length, WIDE);
  } finally {
    await close();
  }
});

test("with the seam let go the first frame's budget is PRUNE_MAX_NODES, 250,000 (U-Q8), and a tree under it goes whole", async () => {
  setPruneMaxNodesForTests(1_000);
  assert.equal(firstFrameMaxNodes(), 1_000, 'the seam sets it');
  setPruneMaxNodesForTests(null);
  assert.equal(PRUNE_MAX_NODES, 250_000);
  assert.equal(firstFrameMaxNodes(), PRUNE_MAX_NODES, 'and letting it go restores the 250,000');
  const store = wideScanStore();
  const scanId = completedScan(store);
  const { port, close } = await listen();
  try {
    const result = await get(port, `/api/scan/${scanId}/result`);
    const root = (JSON.parse(result.body) as { root: FileNode }).root;
    assert.equal(countNodes(root), 1 + 11 + WIDE + 500, 'a tree under the budget goes whole');
  } finally {
    await close();
  }
});

/* -------------------------- the window's drill-in -------------------------- */

/** A declaration out of the built page, from `anchor` (e.g. `async function ensureSubtree(`) to its closing brace. */
function declaration(anchor: string): string {
  const start = INDEX.indexOf(anchor);
  assert.notEqual(start, -1, `"${anchor}" is in public/index.html`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', INDEX.indexOf(')', start)); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`"${anchor}" never closes`);
}

interface PageState {
  pathIndex: Map<string, FileNode>;
  nodeCache: Map<string, FileNode | null>;
  scanId: string | null;
}

test('the window opens a folder the first frame left closed: ensureSubtree fetches it whole from /subtree and grafts it into the tree it holds', async (t) => {
  t.after(() => setPruneMaxNodesForTests(null));
  setPruneMaxNodesForTests(1_000);
  const store = wideScanStore();
  const scanId = completedScan(store);
  const { port, close } = await listen();
  try {
    const first = (JSON.parse((await get(port, `/api/scan/${scanId}/result`)).body) as { root: FileNode }).root;
    // The page's own functions, executed against the real server.
    const state: PageState = { pathIndex: new Map(), nodeCache: new Map(), scanId };
    const asked: string[] = [];
    const apiPaced = async (url: string): Promise<unknown> => {
      asked.push(url);
      const answer = await get(port, url);
      assert.equal(answer.status, 200, `${url}: ${answer.body.slice(0, 200)}`);
      return JSON.parse(answer.body);
    };
    const page = new Function('state', 'apiPaced', 'allocationCache', 'hsFacts', 'SUBTREE_NODES',
      `'use strict'; ${declaration('function indexTree(')} ${declaration('function graftSubtree(')} ${declaration('function treeScanId(')} ${declaration('async function ensureSubtree(')} return { indexTree, ensureSubtree };`,
    )(state, apiPaced, new Map(), new Map(), 20_000) as {
      indexTree: (root: FileNode) => void;
      ensureSubtree: (p: string) => Promise<FileNode | null>;
    };
    page.indexTree(first);
    const widePath = path.join(ROOT, 'wide');
    const closed = state.pathIndex.get(widePath);
    assert.ok(closed, 'the closed folder is in the tree the window holds');
    assert.equal(closed.pruned, true, 'marked as withheld, not as empty');
    assert.equal(state.pathIndex.has(path.join(widePath, 'w0.bin')), false, 'its children were not sent');

    const opened = await page.ensureSubtree(widePath);
    assert.ok(opened, 'the folder opens');
    assert.equal(opened.children?.length, WIDE, 'with every child');
    assert.equal(opened.pruned, undefined, 'and no longer marked withheld');
    assert.equal(opened.size, WIDE * 1_000, 'the size the user read before opening it');
    assert.equal(opened, closed, 'grafted in place into the tree the window holds');
    assert.ok(state.pathIndex.has(path.join(widePath, `w${WIDE - 1}.bin`)), 'its children are indexed');
    assert.deepEqual(asked, [`/api/scan/${scanId}/subtree?path=${encodeURIComponent(widePath)}`], 'one drill-in request');

    assert.equal(await page.ensureSubtree(widePath), opened, 'opening it again');
    assert.equal(asked.length, 1, 'asks the server nothing more');
  } finally {
    await close();
  }
});

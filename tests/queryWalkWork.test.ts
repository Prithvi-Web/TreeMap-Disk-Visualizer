import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-queryWalkWork-data-');
process.env.TREEMAP_NO_GDU = '1';

import os from 'node:os';
import { parse } from '../src/services/query/parse';
import { evaluateMaybe, type EvalNode } from '../src/services/query/evaluate';
import { executeAgainstScan, childlessUnproven, type QueryHit, type QueryOutcome, type SortKey } from '../src/services/query/execute';
import { createScanRecord } from '../src/services/diskScanner';
import { buildStoreFromTree, Flag, PackedScanStore, type ScanStore } from '../src/services/scanStore';
import type { FileNode, ScanResult } from '../src/models/types';
import type { Ast } from '../src/services/query/types';
import { collector, heldBytes } from './fixtures/heapProbe';

/**
 * The query walk's work, counted (design pass G07).
 *
 * The Highlight box asks POST /api/query on every pause in typing, and on a
 * 304k-file scan the walk took 128-180 ms on a quiet machine (0.21 s in the
 * pass's own measurement). It decoded every node's name twice — once to
 * build its path when its parent pushed it, once more as the node was judged
 * — and built a path string for every node, though a path is read only by a
 * path term, a fact lookup and the hits on the page. Names and paths are now
 * read when something reads them. And the walk ran in one turn of the event
 * loop, so a query the person had already typed past could not be stopped:
 * now it runs in slices (Track U's U-D9, the same guard as the dashboard's
 * lists), an abort lands between slices, and a tree that changed during a
 * slice's turn is walked again from the start.
 *
 * Counted, never timed. The answers are held to an oracle that shares none
 * of the walk's code: every node read by id (store.path, store.name), judged
 * by the same evaluator, sorted by the documented order.
 */

const T = 1_800_000_000_000;
const YEAR = 365 * 86_400_000;

/** A seeded tree: `dirs` folders a few levels deep, files of many sizes, names and ages, some empty folders. */
function seededTree(root: string, seed: number, dirs: number): FileNode {
  let s = seed >>> 0;
  const rnd = (): number => { s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0; return s / 2 ** 32; };
  const EXT = ['zip', 'mp4', 'txt', 'JPG', 'tar.gz', '', 'é.png'];
  let made = 0;
  const dir = (path: string, name: string, depth: number): FileNode => {
    const children: FileNode[] = [];
    const files = Math.floor(rnd() * 9);
    for (let i = 0; i < files; i++) {
      const ext = EXT[Math.floor(rnd() * EXT.length)];
      const nm = `${rnd() < 0.2 ? 'Report' : 'item'}-${depth}-${i}${rnd() < 0.1 ? ' (copy)' : ''}${ext ? '.' + ext : ''}`;
      children.push({ name: nm, path: `${path}/${nm}`, type: 'file', extension: ext.split('.').pop() ?? '', size: Math.floor(10 ** (1 + rnd() * 9)), modifiedAt: T - Math.floor(rnd() * 4) * YEAR - 86_400_000, isHidden: false });
    }
    while (made < dirs && depth < 6 && (depth === 0 || rnd() < 0.8)) { // the root keeps going until the tree has its folders
      made++;
      const dn = `${rnd() < 0.15 ? 'node_modules' : 'Folder'}${made}`;
      children.push(dir(`${path}/${dn}`, dn, depth + 1));
    }
    return { name, path, type: 'dir', size: children.reduce((a, c) => a + c.size, 0), modifiedAt: T - YEAR, isHidden: false, children };
  };
  return dir(root, root.split('/').pop() as string, 0);
}

function scanOf(tree: FileNode): ScanResult {
  const scan = createScanRecord(tree.path);
  scan.store = buildStoreFromTree(tree);
  scan.status = 'complete';
  scan.engine = 'walker';
  return scan;
}

function ast(q: string): Ast {
  const r = parse(q);
  assert.ok(r.ok, `"${q}" parses`);
  return (r as { ok: true; ast: Ast }).ast;
}

const run = (scan: ScanResult, q: string, opts: Partial<{ limit: number; offset: number; sort: SortKey; signal: AbortSignal; slices: unknown }> = {}): Promise<QueryOutcome> =>
  executeAgainstScan(scan.scanId, ast(q), { limit: 1000, offset: 0, sort: 'size', signal: new AbortController().signal, ...opts } as never) as Promise<QueryOutcome>;

/** Every node of the store, read by id — store.path and store.name, never the walk's own reads. */
function everyNode(store: ScanStore, childlessKnown: boolean): EvalNode[] {
  const out: EvalNode[] = [];
  const visit = (id: number, depth: number): void => {
    const isDir = store.isDir(id);
    let childCount: number | undefined;
    if (isDir && store.hasChildArray(id)) {
      const n = store.childCount(id);
      childCount = n > 0 ? n : childlessKnown && !store.flag(id, Flag.Unlisted) ? 0 : undefined;
    }
    out.push({ name: store.name(id), path: store.path(id), size: store.size(id), isDir, mtimeMs: store.modifiedAt(id), depth, childCount });
    if (isDir) store.forEachChild(id, (c) => visit(c, depth + 1));
  };
  visit(store.rootId, 0);
  return out;
}

const ORDER: Record<SortKey, (a: QueryHit, b: QueryHit) => number> = {
  size: (a, b) => b.size - a.size || a.path.localeCompare(b.path),
  name: (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
  modified: (a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path),
  path: (a, b) => a.path.localeCompare(b.path),
};

test('G07: the walk answers exactly what every node, judged one by one, says — totals, pages and undecided', async () => {
  const scan = scanOf(seededTree('/q/walk', 0x9e37, 400));
  const store = scan.store as ScanStore;
  const nodes = everyNode(store, childlessUnproven(scan) === null);
  assert.ok(nodes.length > 1500, `a tree of ${nodes.length} nodes`);
  const queries = [
    'size>1mb', 'size<100', 'ext:zip,mp4', 'ext:jpg', 'name:report', 'path:folder1', 'in:node_modules', '-in:node_modules size>10kb',
    'type:dir', 'type:dir size>100mb', 'depth>3', 'depth<2 or ext:txt', '(ext:png or ext:gz) -name:copy', 'empty:yes', 'empty:no type:dir',
    'modified>2y', 'modified<1y', '*.zip', 'report', 'size>1gb or (depth=1 and type:dir)',
  ];
  const home = os.homedir();
  for (const q of queries) {
    const now = Date.now();
    const verdicts = nodes.map((node) => evaluateMaybe(ast(q), { node, facts: {}, now }, home));
    const matched = nodes.filter((_, i) => verdicts[i] === true);
    const undecided = verdicts.filter((v) => v === 'maybe').length;
    for (const sort of ['size', 'name', 'modified', 'path'] as SortKey[]) {
      for (const [limit, offset] of [[1000, 0], [7, 0], [5, 11]]) {
        const out = await run(scan, q, { limit, offset, sort });
        const expected = matched
          .map((n) => ({ path: n.path, name: n.name, size: n.size, isDir: n.isDir, mtimeMs: n.mtimeMs }))
          .sort(ORDER[sort]).slice(offset, offset + limit);
        assert.equal(out.total, matched.length, `${q}: total`);
        assert.deepEqual(out.hits, expected, `${q} by ${sort}, ${limit} from ${offset}: the page`);
        assert.equal(out.examined, nodes.length, `${q}: every node examined`);
        assert.equal(out.truncated, offset + expected.length < matched.length, `${q}: truncated says whether more matched`);
        const said = out.degraded.find((d) => d.provider === 'undecided');
        assert.equal(Boolean(said), undecided > 0, `${q}: undecided is said exactly when a node could not be decided`);
        if (said) assert.match(said.reason, new RegExp(`^${undecided.toLocaleString('en-US')} item`), `${q}: and counts them`);
      }
    }
  }
});

/** The store, with every name and path read counted. */
function counting(scan: ScanResult): { reads: { name: number; childPath: number; path: number } } {
  const store = scan.store as ScanStore;
  const reads = { name: 0, childPath: 0, path: 0 };
  scan.store = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop === 'name' || prop === 'childPath' || prop === 'path') {
        return (...args: unknown[]) => { reads[prop]++; return (value as (...a: unknown[]) => unknown).apply(receiver, args); };
      }
      return (value as (...a: unknown[]) => unknown).bind(receiver);
    },
  }) as ScanStore;
  return { reads };
}

/**
 * The paths a page of hits needs built (review F3.1): each hit's own, and
 * each folder below the root on a hit's way down — counted once however many
 * hits lie under it, and once when a hit is itself such a folder. Read from
 * the hits' paths, so it shares nothing with the walk. A walk that builds
 * any other folder's path (one with no hit under it) goes past it.
 */
function pathsNeeded(hits: QueryHit[], root: string): number {
  const needed = new Set<string>();
  for (const h of hits) {
    needed.add(h.path);
    for (let p = h.path.slice(0, h.path.lastIndexOf('/')); p.length > root.length; p = p.slice(0, p.lastIndexOf('/'))) needed.add(p);
  }
  return needed.size;
}

test('G07: a size query reads the names and paths of its hits, not of every node it walks past', async () => {
  const scan = scanOf(seededTree('/q/work', 0x51ce, 300));
  const store = scan.store as ScanStore;
  const nodes = everyNode(store, true);
  const dirs = nodes.filter((n) => n.isDir).length;
  const { reads } = counting(scan);
  const out = await run(scan, 'size>500mb', { limit: 1000 });
  assert.ok(out.total > 0 && out.total < 1000 && out.hits.length === out.total, `a selective query, every hit on the page (${out.total} of ${nodes.length})`);
  assert.equal(out.examined, nodes.length);
  // Each hit's name for the page, and again inside the store as its path is
  // built; each path built once from its folder's: every folder on a hit's
  // way down, and the hit itself — no other folder's (review F3.1). Before,
  // every node twice.
  const needed = pathsNeeded(out.hits, '/q/work');
  assert.ok(needed < out.total + dirs, `the hits need ${needed} paths of the ${out.total + dirs} a path for every folder would give`);
  assert.ok(reads.name <= 2 * out.total + dirs, `names read: ${reads.name} for ${out.total} hits among ${nodes.length} nodes`);
  assert.ok(reads.childPath <= needed, `paths built: ${reads.childPath} for ${out.total} hits needing ${needed} (${dirs} folders in all) — no folder's path built without a hit under it`);
  assert.equal(reads.path, 0, 'and no path rebuilt from the root');
});

test('G07 review F2.3: many hits sharing folders build each folder\'s path once — a later hit\'s path is built from its folder\'s, kept from the hit before', async () => {
  const scan = scanOf(seededTree('/q/many', 0x51ce, 300));
  const nodes = everyNode(scan.store as ScanStore, true);
  const dirs = nodes.filter((n) => n.isDir).length;
  const { reads } = counting(scan);
  const out = await run(scan, 'ext:txt', { limit: 1000 });
  assert.ok(out.total > 100 && out.hits.length === out.total, `many hits, all on the page (${out.total})`);
  // What building every hit's path down from the root, keeping nothing on
  // the way, would take: each folder below the root on its way, and itself.
  const rebuiltEachTime = out.hits.reduce((n, h) => n + h.path.split('/').length - '/q/many'.split('/').length, 0);
  const needed = pathsNeeded(out.hits, '/q/many');
  assert.ok(rebuiltEachTime > out.total + dirs, `the hits share folders: ${rebuiltEachTime} builds if none were kept, past even ${out.total + dirs}`);
  assert.ok(needed < out.total + dirs, `and leave folders with no hit under them: they need ${needed} paths of the ${out.total + dirs} a path for every folder would give`);
  // Each folder's once, however many hits lie under it — and only a folder
  // with a hit under it (review F3.1): a walk that builds every folder's path
  // as it passes is the per-node cost G07 removed.
  assert.ok(reads.childPath <= needed, `paths built: ${reads.childPath} for ${out.total} hits needing ${needed} (${dirs} folders in all) — each folder's once, however many hits lie under it, and no folder's without one`);
  assert.equal(reads.path, 0, 'and no hit\'s path asked of the store whole, from the root');
});

test('G07: a name query decodes each name once, not once to build a path and again to judge it', async () => {
  const scan = scanOf(seededTree('/q/names', 0xbeef, 300));
  const nodes = everyNode(scan.store as ScanStore, true);
  const dirs = nodes.filter((n) => n.isDir).length;
  const { reads } = counting(scan);
  const out = await run(scan, 'name:report', { limit: 5 });
  assert.ok(out.total > 5, `more matches (${out.total}) than the page holds`);
  // Every node's name is judged once; a path is built only for a folder on a
  // kept hit's way down, or a hit itself, and building one reads its name.
  assert.ok(reads.name <= nodes.length + dirs + out.total, `names read: ${reads.name} for ${nodes.length} nodes (twice each would be ${2 * nodes.length})`);
  assert.ok(reads.childPath < nodes.length / 2, `paths built: ${reads.childPath} for ${nodes.length} nodes`);
});

test('G07: an abort that lands between slices stops the walk there, and the answer says it was stopped', async () => {
  const scan = scanOf(seededTree('/q/abort', 0xab, 300));
  const total = everyNode(scan.store as ScanStore, true).length;
  assert.ok(total > 1000, `a tree of ${total} nodes, many slices of 100`);
  const controller = new AbortController();
  let turns = 0;
  const out = await run(scan, 'size>0', {
    signal: controller.signal,
    // The person typed on: the request closes while the walk has handed the loop a turn.
    slices: { sliceNodes: 100, yieldTurn: async () => { turns++; controller.abort(); await new Promise((r) => setImmediate(r)); } },
  });
  assert.ok(turns >= 1, 'the walk handed the loop a turn after its first slice');
  assert.equal(out.examined, 100, `it stopped at the slice the abort landed after (${out.examined} of ${total} examined)`);
  assert.ok(out.degraded.some((d) => d.provider === 'cancelled'), 'and says the results are incomplete');
  assert.equal(out.truncated, true, 'a stopped walk is never a confident total');
});

test('G07: a tree that changes during a slice\'s turn is walked again from the start — never half the old tree and half the new', async () => {
  const scan = scanOf(seededTree('/q/changed', 0xc0de, 300));
  const store = scan.store as ScanStore;
  const before = await run(scan, 'size>0 type:file');
  // The biggest file: on page one either way, so leaving it in would show.
  const victim = before.hits[0].path;
  let victimId = -1;
  const find = (id: number): void => { if (store.path(id) === victim) victimId = id; else if (store.isDir(id)) store.forEachChild(id, find); };
  find(store.rootId);
  assert.notEqual(victimId, -1);
  const attempts: number[] = [];
  let changed = false;
  const out = await run(scan, 'size>0 type:file', {
    slices: {
      sliceNodes: 200,
      onAttempt: (n: number) => attempts.push(n),
      yieldTurn: async () => {
        if (!changed) { changed = true; store.removeNode(victimId); } // a delete lands mid-walk
        await new Promise((r) => setImmediate(r));
      },
    },
  });
  assert.deepEqual(attempts, [1, 2], 'the walk that saw the change started again');
  const after = await run(scan, 'size>0 type:file');
  assert.equal(out.total, before.total - 1, 'the answer is the changed tree\'s');
  assert.deepEqual(out, after, 'exactly the answer a walk of the changed tree gives');
  assert.ok(!out.hits.some((h) => h.path === victim), 'the deleted file is not among the hits');
});

/**
 * A completed scan of `depth` folders, one inside the next under /deep, with
 * one file at the bottom. With `fileBeside`, every folder on the way also
 * holds a file, f<i>.bin, listed before its subfolder.
 */
function deepChain(depth: number, fileBeside = false): { scan: ScanResult; store: PackedScanStore; leaf: number; leafPath: string } {
  const store = new PackedScanStore('/deep', '/', { name: 'deep', isDir: true, size: 0, modifiedAt: 1, isHidden: false });
  let parent = store.rootId;
  for (let i = 0; i < depth; i++) {
    if (fileBeside) store.addNode(parent, { name: `f${i}.bin`, isDir: false, size: 1, modifiedAt: 1, isHidden: false, extension: 'bin' });
    parent = store.addNode(parent, { name: `d${i}`, isDir: true, size: 0, modifiedAt: 1, isHidden: false });
  }
  store.addNode(parent, { name: 'leaf.bin', isDir: false, size: 7, modifiedAt: 1, isHidden: false, extension: 'bin' });
  store.finalize();
  store.sumSizes();
  const scan = createScanRecord('/deep');
  scan.store = store;
  scan.status = 'complete';
  scan.engine = 'walker';
  // Found by walking down after finalize, which may renumber.
  let leaf = store.rootId;
  while (store.isDir(leaf)) {
    const kids = store.childIds(leaf);
    leaf = kids.find((k) => store.isDir(k)) ?? kids[0];
  }
  let deepest = '/deep';
  for (let i = 0; i < depth; i++) deepest += `/d${i}`;
  return { scan, store, leaf, leafPath: `${deepest}/leaf.bin` };
}

test('G07 review F1.2: a hit at the bottom of a 30k-deep chain is answered, its path built without a stack frame per folder', async () => {
  // The store's own standing case (tests/packedStore.test.ts: a 30k-deep
  // chain, nothing recurses on pathological depth). A query whose terms read
  // no path during the walk (name:, ext:, size) leaves every folder's path
  // unbuilt, so the first path read is the deep hit's, for the page.
  const DEPTH = 30_000;
  const { scan, leafPath } = deepChain(DEPTH);
  for (const q of ['name:leaf', 'ext:bin', 'size>5 type:file']) {
    const out = await run(scan, q);
    assert.equal(out.total, 1, `${q}: the one file matches`);
    assert.equal(out.hits[0].path, leafPath, `${q}: its path, all ${DEPTH} folders of it`);
  }
});

/**
 * What a deep hit's path may hold while it is built: a few hundred bytes per
 * folder on its way down (the nodes the walk holds — a file waiting beside
 * the folder too — and the folder's share of a path joined from its
 * folder's) — never a whole copy of every folder's path, which costs half the
 * deep path's length per folder: 23 KB at 8,000 folders deep.
 */
const HELD_PER_FOLDER = 2048;

/**
 * Run `q` and read the heap each time `probe`'s path is built, and each time
 * a path of a node in `watch` is — the most the walk holds at once is at the
 * bottom: as the deepest node's path is built, and as the deepest folder's is
 * joined, the last of a chain joined in one go — after a full collection: a
 * byte count, never a time. Answers the most held, and how often `probe`'s
 * path was built.
 */
async function heldAsPathIsBuilt(
  scan: ScanResult, store: PackedScanStore, probe: number, q: string, gc: () => void, opts: { limit?: number; watch?: number[] } = {},
): Promise<{ out: QueryOutcome; probes: number; held: number }> {
  const limit = opts.limit ?? 1000;
  const watched = new Set([probe, ...(opts.watch ?? [])]);
  await run(scan, q, { limit }); // whatever the first query loads is not the walk's
  let probes = 0;
  let held = -1;
  const base = heldBytes(gc);
  scan.store = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop !== 'childPath') return (value as (...a: unknown[]) => unknown).bind(target);
      return (child: number, parentPath: string): string => {
        const built = (value as (c: number, p: string) => string).call(target, child, parentPath);
        if (child === probe) probes++;
        if (watched.has(child)) held = Math.max(held, heldBytes(gc) - base);
        return built;
      };
    },
  }) as ScanStore;
  const out = await run(scan, q, { limit });
  scan.store = store;
  return { out, probes, held };
}

const heldMessage = (q: string, held: number, depth: number, deepPath: string): string =>
  `${q}: ${(held / 1e6).toFixed(1)} MB held as the deep path is built, ${Math.round(held / depth)} bytes per folder of ${depth} (at most ${HELD_PER_FOLDER}; a whole copy of every folder's path is about ${Math.round(deepPath.length / 2)})`;

/** The deep chain's one file found by `q`, its path exactly right and built once, and the walk's heap held to a few hundred bytes a folder as it is. */
async function heldAsTheDeepPathIsBuilt(depth: number, fileBeside: boolean, q: string, gc: () => void): Promise<void> {
  const { scan, store, leaf, leafPath } = deepChain(depth, fileBeside);
  if (fileBeside) {
    const top = store.childIds(store.rootId);
    assert.ok(top.length === 2 && !store.isDir(top[0]) && store.isDir(top[1]), 'each folder lists its file before its subfolder');
  }
  const { out, probes, held } = await heldAsPathIsBuilt(scan, store, leaf, q, gc, { watch: [store.parent(leaf)] });
  assert.equal(out.total, 1, `${q}: the one file matches`);
  assert.equal(out.hits[0].path, leafPath, `${q}: its path, all ${depth} folders of it`);
  assert.equal(probes, 1, `${q}: the deep path is built once, from its folder's`);
  assert.ok(held < HELD_PER_FOLDER * depth, heldMessage(q, held, depth, leafPath));
}

test('CI4: a deep hit costs memory in proportion to its depth, not its square — with a path term or without, no folder on its way down keeps a whole copy of its path', async () => {
  // CI run 39095045009: the 30k-deep chain above ran macOS's 2 GB heap out
  // (it passed on this Mac's 4 GB). Each folder's path, built from its
  // folder's, was read whole as the next was joined (the store's childPath
  // asked whether it ended with the separator), so every folder kept a flat
  // copy of its own path: the depth squared, about 2.7 GB at 30k. A path
  // term reads every node's path whole anyway, and a folder kept reachable
  // from below after its path was built then held that copy alive.
  const gc = collector();
  for (const q of ['name:leaf', 'path:leaf']) await heldAsTheDeepPathIsBuilt(8_000, false, q, gc);
});

test('CI4 review F1.2: a file waiting beside every folder of a deep chain keeps no folder\'s whole path alive — with a path term or an in: term reading every path, or neither', async (t) => {
  // Every folder holds a file listed before its subfolder. The walk pushes a
  // folder's children in order and takes the last first, so each file waits
  // on its stack while everything under its folder is walked, and it needs
  // its folder's path for its own. It held the folder's node for that, and
  // with it the folder's path, which a path: or in: term had read whole: the
  // depth squared again — 185 MB at 8,000 deep, and a 2 GB heap run out at
  // 30,000 — though the chain without the files held a few bytes a folder.
  const gc = collector();
  for (const q of ['path:leaf', 'in:/deep/d0 name:leaf', 'name:leaf']) {
    await t.test(q, () => heldAsTheDeepPathIsBuilt(8_000, true, q, gc));
  }
});

/**
 * deepChain(depth, true) with its sizes set by hand, two folders at a time:
 * d0 and d1 hold 1 byte, d2 and d3 hold 2, and so on; every file holds none.
 */
function pairedChain(depth: number): { scan: ScanResult; store: PackedScanStore; deepest: number; keptPath: string } {
  const store = new PackedScanStore('/deep', '/', { name: 'deep', isDir: true, size: 0, modifiedAt: 1, isHidden: false });
  let parent = store.rootId;
  for (let i = 0; i < depth; i++) {
    store.addNode(parent, { name: `f${i}.bin`, isDir: false, size: 0, modifiedAt: 1, isHidden: false, extension: 'bin' });
    parent = store.addNode(parent, { name: `d${i}`, isDir: true, size: Math.floor(i / 2) + 1, modifiedAt: 1, isHidden: false });
  }
  store.addNode(parent, { name: 'leaf.bin', isDir: false, size: 0, modifiedAt: 1, isHidden: false, extension: 'bin' });
  store.finalize();
  const scan = createScanRecord('/deep');
  scan.store = store;
  scan.status = 'complete';
  scan.engine = 'walker';
  let deepest = store.rootId;
  for (let next = store.rootId; next !== -1; next = store.childIds(next).find((k) => store.isDir(k)) ?? -1) deepest = next;
  let keptPath = '/deep';
  for (let i = 0; i < depth - 1; i++) keptPath += `/d${i}`;
  return { scan, store, deepest, keptPath };
}

test('CI4 review F1.2: a sort tie that reads a kept folder\'s path while its file still waits leaves the path that file holds in pieces', async () => {
  // Folders only, the largest kept, one: each even folder is kept as it is
  // met, being larger than the one kept before, and the odd folder inside it
  // is the same size — a tie, broken by path, so the kept folder's path is
  // read after its children were pushed, while its file still waits. Were
  // its own path and the one its children join onto one string while the
  // walk runs, that read would copy the joined one whole, and every second
  // folder's would stay whole on the stack: the depth squared.
  const DEPTH = 8_000; // even, so the deepest folder ties with the one above it as it is met
  const gc = collector();
  const { scan, store, deepest, keptPath } = pairedChain(DEPTH);
  assert.equal(store.size(deepest), DEPTH / 2, 'the deepest folder is the size of the one above it');
  const { out, probes, held } = await heldAsPathIsBuilt(scan, store, deepest, 'type:dir', gc, { limit: 1 });
  assert.equal(out.total, DEPTH + 1, 'every folder matches, the scanned one too');
  assert.deepEqual(out.hits.map((h) => h.path), [keptPath], 'the largest, the tie broken by path: the folder above the deepest');
  assert.equal(probes, 1, 'the deepest folder\'s path is built once, for its tie');
  assert.ok(held < HELD_PER_FOLDER * DEPTH, heldMessage('type:dir', held, DEPTH, keptPath));
});

test('CI4 review F2.1/F2.2: a hit whose name begins with a byte-order mark keeps it — "\\uFEFFfoo" beside "foo", and "\\uFEFF" alone, are answered as the files they are, each under its own path', async () => {
  // A hit's path is what DELETE /api/files, the cart and an Autopilot query
  // policy act on. Read without its mark, the 900-byte '\uFEFFfoo' was
  // answered as '/data/foo', the 5-byte file beside it, and the 7-byte
  // '\uFEFF' as '/data/', its folder. The oracle is the listing the store was
  // built from, as a walker's fs.readdir gives the names.
  const BOM = '\uFEFF';
  const file = (dir: string, name: string, size: number): FileNode => ({ name, path: `${dir}/${name}`, type: 'file', extension: '', size, modifiedAt: T - YEAR, isHidden: false });
  const sub = `/data/${BOM}sub`;
  const listed = [file('/data', 'foo', 5), file('/data', `${BOM}foo`, 900), file('/data', BOM, 7), file(sub, BOM, 13), file(sub, 'foo', 11)];
  const tree: FileNode = {
    name: 'data', path: '/data', type: 'dir', size: 936, modifiedAt: T - YEAR, isHidden: false,
    children: [...listed.slice(0, 3), { name: `${BOM}sub`, path: sub, type: 'dir', size: 24, modifiedAt: T - YEAR, isHidden: false, children: listed.slice(3) }],
  };
  const out = await run(scanOf(tree), 'type:file');
  const bySize = (a: { size: number }, b: { size: number }): number => a.size - b.size;
  assert.deepEqual(
    out.hits.map((h) => ({ path: h.path, name: h.name, size: h.size })).sort(bySize),
    listed.map((n) => ({ path: n.path, name: n.name, size: n.size })).sort(bySize),
    'every file answered under its own name and path',
  );
});

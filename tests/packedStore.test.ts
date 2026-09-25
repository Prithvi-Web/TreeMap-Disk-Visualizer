import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-packedStore-data-');

import { FileNode } from '../src/models/types';
import { ObjectScanStore, PackedScanStore, ScanStore, Flag, NodeInput } from '../src/services/scanStore';
import { streamTreeJson } from '../src/services/scanStoreJson';
import { buildPair, compareStores, comparePrunes, makeRng, mutateBoth } from './fixtures/storeFuzz';

/**
 * Differential fuzz: every random tree is built into ObjectScanStore (the
 * oracle — it delegates to the logic the app runs today) and PackedScanStore
 * from the identical NodeInput stream, and the two must agree on everything:
 * per-node metadata, traversal order, path lookup (hits and misses), size
 * summation, and — most importantly — prune() output that is byte-identical
 * as JSON across a sweep of budgets, before and after mutations.
 */

/* ------------------------------- tests ------------------------------- */

test('differential fuzz: packed store matches the oracle on 120 random trees', () => {
  for (let iter = 0; iter < 120; iter++) {
    const { obj, packed, rng } = buildPair(1000 + iter, iter, 1200);
    try {
      compareStores(obj, packed, rng);
      comparePrunes(obj, packed);
    } catch (err) {
      throw new Error(`fuzz iteration ${iter} (seed ${1000 + iter}): ${String(err)}`, { cause: err });
    }
  }
});

test('differential fuzz: mutations keep both stores identical', () => {
  for (let iter = 0; iter < 40; iter++) {
    const { obj, packed, rng } = buildPair(9000 + iter, iter, 900);
    try {
      mutateBoth(obj, packed, rng);
      compareStores(obj, packed, rng);
      comparePrunes(obj, packed);
    } catch (err) {
      throw new Error(`mutation fuzz iteration ${iter} (seed ${9000 + iter}): ${String(err)}`, { cause: err });
    }
  }
});

test('differential: container graft (ingestSubtree) matches on both stores', () => {
  const { obj, packed } = buildPair(777, 0, 400);

  // Find a childless container file to graft into; guarantee one exists.
  let target = '';
  obj.eachNode(obj.rootId, (id) => {
    if (!target && !obj.isDir(id) && obj.container(id) !== undefined && !obj.hasChildArray(id)) {
      target = obj.path(id);
    }
  });
  if (!target) {
    const oId = obj.addNode(obj.rootId, { name: 'late.zip', isDir: false, size: 500, modifiedAt: 1, isHidden: false, extension: 'zip', container: 'zip' });
    const pId = packed.addNode(packed.rootId, { name: 'late.zip', isDir: false, size: 500, modifiedAt: 1, isHidden: false, extension: 'zip', container: 'zip' });
    void oId;
    void pId;
    target = obj.path(obj.findByPath(obj.rootPath + obj.sep + 'late.zip'));
  }
  const sep = obj.sep;
  const kids: FileNode[] = [
    {
      name: 'inner', path: `${target}${sep}inner`, size: 90, type: 'dir', modifiedAt: 123, isHidden: false, virtual: true,
      children: [
        { name: 'a.txt', path: `${target}${sep}inner${sep}a.txt`, size: 90, type: 'file', modifiedAt: 123, isHidden: false, virtual: true, logicalSize: 400, extension: 'txt' },
      ],
    },
    { name: 'top.bin', path: `${target}${sep}top.bin`, size: 10, type: 'file', modifiedAt: 123, isHidden: false, virtual: true, extension: 'bin' },
  ];
  obj.ingestSubtree(obj.findByPath(target), kids);
  packed.ingestSubtree(packed.findByPath(target), structuredClone(kids));

  const rng = makeRng(1);
  compareStores(obj, packed, rng);
  comparePrunes(obj, packed);
  assert.equal(packed.findByPath(`${target}${sep}inner${sep}a.txt`) !== -1, true);
});

test('a 60k-node tree prunes byte-identically across the budget sweep', () => {
  const { obj, packed, rng } = buildPair(31337, 0, 60_000);
  compareStores(obj, packed, rng);
  comparePrunes(obj, packed);
});

test('packed store survives a 30k-deep chain without recursion blowups', () => {
  const root: NodeInput = { name: 'root', isDir: true, size: 0, modifiedAt: 1, isHidden: false };
  const packed = new PackedScanStore('/deep', '/', root);
  let parent = packed.rootId;
  for (let i = 0; i < 30_000; i++) {
    parent = packed.addNode(parent, { name: `d${i}`, isDir: true, size: 0, modifiedAt: 1, isHidden: false });
  }
  packed.addNode(parent, { name: 'leaf.bin', isDir: false, size: 7, modifiedAt: 1, isHidden: false, extension: 'bin' });
  packed.finalize();
  packed.sumSizes();

  assert.equal(packed.size(packed.rootId), 7, 'the leaf sums all the way up');

  let deepest = '/deep';
  for (let i = 0; i < 30_000; i++) deepest += `/d${i}`;
  const dirId = packed.findByPath(deepest);
  assert.notEqual(dirId, -1);
  assert.equal(packed.findByPath(`${deepest}/leaf.bin`), packed.childByName(dirId, 'leaf.bin'));

  let count = 0;
  packed.eachNode(packed.rootId, () => count++);
  assert.equal(count, 30_002);

  const pruned = packed.prune(packed.rootId, { maxNodes: 50 });
  assert.ok(pruned.nodes >= 50 || pruned.prunedDirs === 0);
});

test('eviction semantics: dropping the store frees it for GC (no registry leaks)', () => {
  // The store keeps no module-level registries — everything is instance state,
  // so dropping the last reference is sufficient for GC. This guards against
  // someone adding a static cache later.
  const statics = Object.getOwnPropertyNames(PackedScanStore).filter(
    (k) => !['length', 'name', 'prototype'].includes(k),
  );
  assert.deepEqual(statics, [], 'PackedScanStore must hold no static state');
});

test('names are stored as their UTF-8, whether ASCII or not', () => {
  // The name pool is UTF-8: a name reads back as what an encode then a
  // decode of it gives (a lone surrogate becomes U+FFFD). The ASCII fast
  // path in appendName must agree with TextEncoder on every one of these.
  const names = [
    'plain.txt', 'x', `${'a'.repeat(300)}.bin`, 'del\u007fedge', 'pad\u0080edge', 'é', 'café.txt', 'abcé',
    '文件', 'emoji😀', 'lone\ud800half', 'tail\udfff', 'mixed ascii then 文 then ascii', 'nul\u0000byte',
  ];
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const root: NodeInput = { name: 'root', isDir: true, size: 0, modifiedAt: 1, isHidden: false };
  const packed = new PackedScanStore('/r', '/', root);
  const ids = names.map((name) => packed.addNode(packed.rootId, { name, isDir: false, size: 1, modifiedAt: 1, isHidden: false }));
  packed.finalize();
  const read = packed.childIds(packed.rootId).map((id) => packed.name(id));
  assert.equal(ids.length, names.length);
  assert.deepEqual(read, names.map((name) => decoder.decode(encoder.encode(name))));
});

test('names survive the name pool growing, ASCII or not, on either side of every doubling', () => {
  // The pool starts at 16 KiB and doubles when a name might not fit; 3,000
  // names of 20–79 characters, one in five non-ASCII, cross several doublings
  // with both of appendName's paths.
  const rng = makeRng(7);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const names: string[] = [];
  for (let i = 0; i < 3000; i++) {
    const len = 20 + Math.floor(rng() * 60);
    let s = '';
    for (let k = 0; k < len; k++) s += rng() < 0.8 ? String.fromCharCode(0x20 + Math.floor(rng() * 0x5f)) : '文';
    names.push(`${i}-${s}`);
  }
  const root: NodeInput = { name: 'root', isDir: true, size: 0, modifiedAt: 1, isHidden: false };
  const packed = new PackedScanStore('/r', '/', root);
  for (const name of names) packed.addNode(packed.rootId, { name, isDir: false, size: 1, modifiedAt: 1, isHidden: false });
  packed.finalize();
  const read = packed.childIds(packed.rootId).map((id) => packed.name(id));
  assert.deepEqual(read, names.map((name) => decoder.decode(encoder.encode(name))));
});

/* --------------------------- streamed tree JSON --------------------------- */

/** The JSON a whole-tree prune stringifies to: what `scan.root` serialises as. */
function wholeTreeJson(store: ScanStore): string {
  return JSON.stringify(store.prune(store.rootId, { maxNodes: Number.MAX_SAFE_INTEGER }).root);
}

/** Everything `streamTreeJson` hands over, piece by piece. */
async function streamed(store: ScanStore, chunkChars?: number): Promise<{ json: string; chunks: string[]; complete: boolean }> {
  const chunks: string[] = [];
  const complete = await streamTreeJson(store, store.rootId, async (chunk) => {
    chunks.push(chunk);
  }, { chunkChars });
  return { json: chunks.join(''), chunks, complete };
}

test('streamTreeJson writes the whole-tree prune byte for byte, on both stores, at any chunk size', async () => {
  for (let iter = 0; iter < 40; iter++) {
    const { obj, packed } = buildPair(4000 + iter, iter, 1200);
    for (const [label, store] of [['object', obj], ['packed', packed]] as const) {
      const want = wholeTreeJson(store);
      for (const chunkChars of [1, 97, 65_536]) {
        const got = await streamed(store, chunkChars);
        assert.equal(got.complete, true);
        assert.equal(got.json, want, `seed ${4000 + iter}, ${label} store, chunkChars ${chunkChars}`);
      }
    }
  }
});

test('streamTreeJson matches after removals, size changes and a container graft', async () => {
  for (let iter = 0; iter < 10; iter++) {
    const { obj, packed, rng } = buildPair(6000 + iter, iter, 900);
    const paths: string[] = [];
    obj.eachNode(obj.rootId, (id) => paths.push(obj.path(id)));
    for (let i = 0; i < 30; i++) {
      const p = paths[Math.floor(rng() * paths.length)];
      const oId = obj.findByPath(p);
      const pId = packed.findByPath(p);
      if (oId === -1 || p === obj.rootPath) continue;
      if (rng() < 0.5) {
        obj.removeNode(oId);
        packed.removeNode(pId);
      } else {
        obj.setSize(oId, 42);
        packed.setSize(pId, 42);
      }
    }
    const zip: NodeInput = { name: 'late.zip', isDir: false, size: 500, modifiedAt: 1, isHidden: false, extension: 'zip', container: 'zip' };
    const oZip = obj.addNode(obj.rootId, zip);
    const pZip = packed.addNode(packed.rootId, zip);
    const at = obj.path(oZip);
    const sep = obj.sep;
    const kids: FileNode[] = [
      {
        name: 'inner', path: `${at}${sep}inner`, size: 90, type: 'dir', modifiedAt: 123, isHidden: false, virtual: true,
        children: [
          { name: 'a.txt', path: `${at}${sep}inner${sep}a.txt`, size: 90, type: 'file', modifiedAt: 123, isHidden: false, virtual: true, logicalSize: 400, extension: 'txt' },
        ],
      },
      { name: 'empty', path: `${at}${sep}empty`, size: 0, type: 'dir', modifiedAt: 123, isHidden: false, virtual: true, children: [] },
    ];
    obj.ingestSubtree(oZip, kids);
    packed.ingestSubtree(pZip, structuredClone(kids));
    for (const store of [obj, packed]) {
      assert.equal((await streamed(store, 257)).json, wholeTreeJson(store), `seed ${6000 + iter}, ${store.constructor.name}`);
    }
  }
});

test('streamTreeJson escapes every name as JSON.stringify does, under "/", "C:\\" and cloud roots', async () => {
  const awkward = ['quote"d', 'back\\slash', 'brace}', '],"children":[', 'new\nline', 'nul\u0000byte', 'lone\ud800half', 'emoji😀', 'tab\t', 'é文'];
  for (const [rootPath, sep] of [['/', '/'], ['C:\\', '\\'], ['cloud://gdrive', '/']] as const) {
    const rootInput: NodeInput = { name: rootPath.split(sep).pop() || rootPath, isDir: true, size: 0, modifiedAt: 1, isHidden: false };
    for (const store of [new ObjectScanStore(rootPath, sep, rootInput), new PackedScanStore(rootPath, sep, rootInput)]) {
      const dir = store.addNode(store.rootId, { name: 'd"ir}', isDir: true, size: 0, modifiedAt: 2, isHidden: false });
      store.addNode(store.rootId, { name: 'empty', isDir: true, size: 0, modifiedAt: 3, isHidden: true });
      awkward.forEach((name, i) => store.addNode(dir, { name, isDir: false, size: i, modifiedAt: 4, isHidden: false }));
      store.finalize();
      store.sumSizes();
      assert.equal((await streamed(store, 13)).json, wholeTreeJson(store), `${rootPath} on the ${store.constructor.name}`);
    }
  }
});

test('streamTreeJson streams a 5,000-deep chain, and it parses back whole', async () => {
  // 5,000 levels are 10,000 levels of JSON nesting (an object and its
  // children array each). JSON.stringify recurses and threw RangeError at
  // that depth on Node 24, so the old cache writer never saved such a tree;
  // this writer keeps its own stack, and JSON.parse and the cache reader
  // (buildDirCache) are iterative. One-letter names keep the document small:
  // every node carries its whole path, so a chain's JSON grows with the
  // square of its depth (a 30,000-deep chain of longer names is gigabytes).
  const DEPTH = 5_000;
  const root: NodeInput = { name: 'r', isDir: true, size: 0, modifiedAt: 1, isHidden: false };
  const packed = new PackedScanStore('/r', '/', root);
  let parent = packed.rootId;
  for (let i = 0; i < DEPTH; i++) {
    parent = packed.addNode(parent, { name: 'a', isDir: true, size: 0, modifiedAt: 1, isHidden: false });
  }
  packed.addNode(parent, { name: 'leaf.bin', isDir: false, size: 7, modifiedAt: 1, isHidden: false, extension: 'bin' });
  packed.finalize();
  packed.sumSizes();

  const got = await streamed(packed, 65_536);
  assert.equal(got.complete, true);
  let node = JSON.parse(got.json) as FileNode;
  let depth = 0;
  while (node.type === 'dir' && node.children?.length === 1) {
    node = node.children[0];
    depth++;
  }
  assert.equal(depth, DEPTH + 1, 'every level is there');
  assert.equal(node.name, 'leaf.bin');
  assert.equal(node.size, 7);
  assert.equal(node.path, `/r${'/a'.repeat(DEPTH)}/leaf.bin`);
});

test('streamTreeJson stops at the first hand-off after the tree changes, and says so', async () => {
  const { packed } = buildPair(4242, 0, 3000);
  const victim = packed.childIds(packed.rootId)[0];
  let writes = 0;
  const complete = await streamTreeJson(packed, packed.rootId, async () => {
    writes++;
    // What a delete, a watcher or a container expansion does between two chunks.
    if (writes === 2) packed.setSize(victim, 1);
  }, { chunkChars: 256 });
  assert.equal(complete, false, 'a document spanning two versions of the tree is refused');
  assert.equal(writes, 2, 'and nothing more is written once the change is seen');

  // The last piece is built before its write begins, so a change during that
  // write leaves a whole document of the version it was built from. With
  // one-character chunks every piece is a write of its own, the last included.
  const { packed: small } = buildPair(4243, 0, 40);
  const want = wholeTreeJson(small);
  let writesInAll = 0;
  await streamTreeJson(small, small.rootId, async () => {
    writesInAll++;
  }, { chunkChars: 1 });
  const pieces: string[] = [];
  const whole = await streamTreeJson(small, small.rootId, async (chunk) => {
    pieces.push(chunk);
    if (pieces.length === writesInAll) small.setSize(small.childIds(small.rootId)[0], 1);
  }, { chunkChars: 1 });
  assert.equal(whole, true, 'a change during the last write is after the document was built');
  assert.equal(pieces.join(''), want);
});

test('streamTreeJson hands off at least every chunkChars characters', async () => {
  const { packed } = buildPair(5151, 0, 20_000);
  const chunkChars = 4096;
  // One loop step adds at most a comma, one node's JSON and the opening of
  // its children, or one closing bracket pair.
  let longestNode = 0;
  packed.eachNode(packed.rootId, (id) => {
    longestNode = Math.max(longestNode, JSON.stringify(packed.materialize(id)).length);
  });
  const bound = chunkChars + longestNode + ',"children":['.length + 1;
  const { chunks, json } = await streamed(packed, chunkChars);
  assert.ok(chunks.length > json.length / bound, `${chunks.length} chunks for ${json.length} characters`);
  for (const [i, c] of chunks.slice(0, -1).entries()) {
    assert.ok(c.length >= chunkChars && c.length <= bound, `chunk ${i} is ${c.length} characters (bound ${bound})`);
  }
});

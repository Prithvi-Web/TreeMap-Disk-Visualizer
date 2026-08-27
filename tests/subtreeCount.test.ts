import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ObjectScanStore, PackedScanStore, NodeInput, ScanStore } from '../src/services/scanStore';
import { buildCountTable } from '../src/services/facts/subtreeCountProvider';

/**
 * `subtreeCount` (v4 §6.1) — how many things live under a path.
 *
 * Disk City's "height by file count" needs a number the treemap response is
 * not allowed to carry (§2.1 holds it byte-identical), so it arrives through
 * the fact layer. What is worth testing is not the plumbing — `tests/facts.ts`
 * already pins that — but the two claims this provider makes on its own:
 *
 *   1. **The counts are right**, including for the shapes that break a naive
 *      recursive count: an empty directory, a deep chain, a file at the root.
 *   2. **The whole-tree pass is why it is fast enough.** The provider counts
 *      every node once and looks each path up in O(1), because the paths Disk
 *      City asks about are the big directories near the root — walking each
 *      one's subtree separately is quadratic on exactly the input it gets.
 */

const fileIn = (name: string, size = 10, extra: Partial<NodeInput> = {}): NodeInput => ({
  name, isDir: false, size, modifiedAt: 1000, isHidden: false, ...extra,
});
const dirIn = (name: string, extra: Partial<NodeInput> = {}): NodeInput => ({
  name, isDir: true, size: 0, modifiedAt: 2000, isHidden: false, ...extra,
});

/**
 * root/
 *   docs/            2 files, 1 dir below
 *     a.txt
 *     deep/
 *       b.txt
 *   empty/           0 files, 0 dirs
 *   loose.bin        a file directly at the root
 */
function fixture(): { store: ObjectScanStore; ids: Record<string, number> } {
  const store = new ObjectScanStore('/root', '/', dirIn('root'));
  const ids: Record<string, number> = { root: store.rootId };
  ids.docs = store.addNode(ids.root, dirIn('docs'));
  ids.a = store.addNode(ids.docs, fileIn('a.txt'));
  ids.deep = store.addNode(ids.docs, dirIn('deep'));
  ids.b = store.addNode(ids.deep, fileIn('b.txt'));
  ids.empty = store.addNode(ids.root, dirIn('empty'));
  ids.loose = store.addNode(ids.root, fileIn('loose.bin'));
  store.finalize();
  store.sumSizes();
  return { store, ids };
}

test('counts every file and folder beneath a path, and nothing above it', () => {
  const { store, ids } = fixture();
  const t = buildCountTable(store);

  assert.deepEqual({ f: t.files[ids.root], d: t.dirs[ids.root] }, { f: 3, d: 3 }, 'root: a, b, loose + docs, deep, empty');
  assert.deepEqual({ f: t.files[ids.docs], d: t.dirs[ids.docs] }, { f: 2, d: 1 }, 'docs: a, b + deep');
  assert.deepEqual({ f: t.files[ids.deep], d: t.dirs[ids.deep] }, { f: 1, d: 0 });
});

test('an empty folder is 0 files — and a file is 1, never 0', () => {
  const { store, ids } = fixture();
  const t = buildCountTable(store);

  // An empty directory genuinely holds nothing, so 0 is a measurement here.
  assert.equal(t.files[ids.empty], 0);
  assert.equal(t.dirs[ids.empty], 0);

  // A file counts itself. Height-by-file-count must never render an existing
  // file as a zero-height block, which is what "count of files *below* a file"
  // would produce for every leaf on the map.
  assert.equal(t.files[ids.loose], 1);
  assert.equal(t.dirs[ids.loose], 0);
});

test('a deep chain does not overflow the stack', () => {
  // Recursion is the obvious implementation and it dies on real input: a
  // node_modules chain or a Time Machine backup nests far deeper than this.
  const store = new ObjectScanStore('/root', '/', dirIn('root'));
  let cursor = store.rootId;
  const DEPTH = 20_000;
  for (let i = 0; i < DEPTH; i++) cursor = store.addNode(cursor, dirIn(`d${String(i)}`));
  store.addNode(cursor, fileIn('bottom.txt'));
  store.finalize();

  const t = buildCountTable(store);
  assert.equal(t.files[store.rootId], 1, 'the one file at the bottom is found');
  assert.equal(t.dirs[store.rootId], DEPTH, 'and every directory on the way down is counted');
});

test('the packed store and the reference store agree, node for node', () => {
  // The same differential discipline packedStore.test.ts applies to the store
  // itself: whatever the counting does, it must not depend on which
  // implementation is underneath.
  const { store: objectStore } = fixture();
  const packed = new PackedScanStore('/root', '/', dirIn('root'));
  const pIds: Record<string, number> = { root: packed.rootId };
  pIds.docs = packed.addNode(pIds.root, dirIn('docs'));
  packed.addNode(pIds.docs, fileIn('a.txt'));
  pIds.deep = packed.addNode(pIds.docs, dirIn('deep'));
  packed.addNode(pIds.deep, fileIn('b.txt'));
  packed.addNode(pIds.root, dirIn('empty'));
  packed.addNode(pIds.root, fileIn('loose.bin'));
  packed.finalize();
  packed.sumSizes();

  const a = buildCountTable(objectStore);
  const b = buildCountTable(packed);

  // Compared by PATH, not by node id: the two implementations are free to
  // number their nodes differently and they do, so an id-for-id comparison
  // would be asserting an incidental detail rather than the counts.
  for (const p of ['/root', '/root/docs', '/root/docs/deep', '/root/empty', '/root/loose.bin']) {
    const ia = objectStore.findByPath(p);
    const ib = packed.findByPath(p);
    assert.notEqual(ia, -1, `${p} exists in the reference store`);
    assert.notEqual(ib, -1, `${p} exists in the packed store`);
    assert.deepEqual(
      { files: a.files[ia], dirs: a.dirs[ia] },
      { files: b.files[ib], dirs: b.dirs[ib] },
      `${p} counts the same in both stores`,
    );
  }
});

test('the table is built once for a tree, not once per requested path', () => {
  // This is the provider's whole performance argument, so it is asserted
  // rather than asserted-in-a-comment. A wide, shallow tree is exactly what
  // Disk City asks about: many big sibling directories near the root.
  const store = new ObjectScanStore('/root', '/', dirIn('root'));
  const dirs: number[] = [];
  for (let i = 0; i < 200; i++) {
    const d = store.addNode(store.rootId, dirIn(`d${String(i)}`));
    dirs.push(d);
    for (let j = 0; j < 200; j++) store.addNode(d, fileIn(`f${String(j)}`));
  }
  store.finalize();

  let visits = 0;
  const counting: ScanStore = new Proxy(store, {
    get(target, prop, recv) {
      if (prop === 'forEachChild') {
        return (id: number, fn: (c: number) => void) => {
          target.forEachChild(id, (c) => { visits++; fn(c); });
        };
      }
      return Reflect.get(target, prop, recv) as unknown;
    },
  }) as ScanStore;

  const t = buildCountTable(counting);
  assert.equal(t.files[store.rootId], 40_000);

  // Each node is reached from its parent exactly twice: once to push it, once
  // to add its total in. Anything super-linear here means a path-by-path walk
  // crept back in, which is the shape that blows §2.5's 400 ms budget.
  const nodes = 200 * 201; // 200 dirs × (200 files + itself)
  assert.equal(visits, nodes * 2, 'linear in the tree, with no per-path re-walk');
});

test('counting a 250k-node tree stays well inside the sidecar budget', () => {
  // §2.5 allows 400 ms for 5,000 paths. The pass this provider does once is
  // the only part that scales with the tree, so it is the part worth timing.
  const store = new ObjectScanStore('/root', '/', dirIn('root'));
  for (let i = 0; i < 500; i++) {
    const d = store.addNode(store.rootId, dirIn(`d${String(i)}`));
    for (let j = 0; j < 500; j++) store.addNode(d, fileIn(`f${String(j)}`));
  }
  store.finalize();

  const started = process.hrtime.bigint();
  const t = buildCountTable(store);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(t.files[store.rootId], 250_000);
  assert.ok(ms < 400, `the whole-tree pass took ${ms.toFixed(1)} ms, which must stay under the 400 ms sidecar budget`);
});

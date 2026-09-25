import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-packedStoreRelease-data-');

import { FileNode } from '../src/models/types';
import { Flag, NodeInput, PackedScanStore, StoreColumns } from '../src/services/scanStore';
import { waitFor } from './fixtures/waitFor';

/**
 * Phase 4 (design §S.1.6): `release()` gives up a PackedScanStore's columns.
 * A typed array whose memory is gone does not throw when read — a detached
 * array reads `undefined` — so a store read after its release must fail
 * loudly through its own check, from every accessor, whichever way the store
 * was made: built node by node and finalized (the walker), or adopting the
 * columns a native build handed over (tm-store).
 */

const RELEASED = /PackedScanStore: this store was released/;

function input(name: string, isDir: boolean, fields: Partial<NodeInput> = {}): NodeInput {
  return { name, isDir, size: 0, modifiedAt: 1_000, isHidden: false, ...fields };
}

/**
 * /r
 *   a.txt  (5 bytes, accessed)
 *   b/
 *     c.bin (7 bytes)
 *   e/     (empty)
 * Breadth-first ids after finalize: r 0, a.txt 1, b 2, e 3, c.bin 4.
 */
function built(): PackedScanStore {
  const store = new PackedScanStore('/r', '/', input('r', true));
  store.addNode(0, input('a.txt', false, { size: 5, extension: 'txt', accessedAt: 2_000 }));
  const b = store.addNode(0, input('b', true));
  store.addNode(0, input('e', true));
  store.addNode(b, input('c.bin', false, { size: 7, extension: 'bin' }));
  store.finalize();
  return store;
}

/** The same tree as the columns a native build hands over, two rows of headroom. */
function columns(): StoreColumns {
  const capacity = 7;
  const names = new TextEncoder().encode('ra.txtbec.bin');
  const column = <T extends { set(values: ArrayLike<number>): void }>(make: (n: number) => T, rows: number[]): T => {
    const out = make(capacity);
    out.set(rows);
    return out;
  };
  const dirBits = Flag.Dir | Flag.HasChildArray;
  const nameOff = new Uint32Array(capacity + 1);
  nameOff.set([0, 1, 6, 7, 8, 13]);
  return {
    n: 5,
    capacity,
    parent: column((n) => new Int32Array(n), [-1, 0, 0, 0, 2]),
    size: column((n) => new Float64Array(n), [0, 5, 0, 0, 7]),
    mtime: column((n) => new Float64Array(n), [1_000, 1_000, 1_000, 1_000, 1_000]),
    atime: column((n) => new Float64Array(n), [0, 2_000, 0, 0, 0]),
    flags: column((n) => new Uint16Array(n), [dirBits, Flag.HasAccessed, dirBits, dirBits, 0]),
    ext: column((n) => new Uint16Array(n), [0, 1, 0, 0, 2]),
    container: new Uint8Array(capacity),
    cloudProv: new Uint8Array(capacity),
    nameOff,
    names,
    namesLen: names.length,
    childStart: column((n) => new Uint32Array(n), [1, 4, 4, 5, 5]),
    childCnt: column((n) => new Uint32Array(n), [3, 0, 1, 0, 0]),
    extDict: ['', 'txt', 'bin'],
    extOverflow: [],
  };
}

function adopted(): PackedScanStore {
  const store = new PackedScanStore('/r', '/', input('r', true));
  store.adoptColumns(columns());
  return store;
}

const graft: FileNode[] = [
  { name: 'x.txt', path: '/r/e/x.txt', size: 1, type: 'file', modifiedAt: 1_000, isHidden: false },
];

/**
 * One call per public member of PackedScanStore, each one that succeeds on a
 * live store. `fresh` makes the store the call needs when the tree above will
 * not do (only a store holding just its root may adopt columns).
 */
const CALLS: Record<string, { call: (s: PackedScanStore) => unknown; fresh?: () => PackedScanStore }> = {
  count: { call: (s) => s.count },
  addNode: { call: (s) => s.addNode(2, input('late.txt', false, { size: 1 })) },
  finalize: { call: (s) => s.finalize() },
  adoptColumns: {
    call: (s) => s.adoptColumns(columns()),
    fresh: () => new PackedScanStore('/r', '/', input('r', true)),
  },
  sumSizes: { call: (s) => s.sumSizes() },
  name: { call: (s) => s.name(4) },
  path: { call: (s) => s.path(4) },
  childPath: { call: (s) => s.childPath(4, '/r/b') },
  size: { call: (s) => s.size(1) },
  isDir: { call: (s) => s.isDir(2) },
  nodeType: { call: (s) => s.nodeType(2) },
  modifiedAt: { call: (s) => s.modifiedAt(1) },
  flag: { call: (s) => s.flag(2, Flag.Dir) },
  extension: { call: (s) => s.extension(1) },
  accessedAt: { call: (s) => s.accessedAt(1) },
  container: { call: (s) => s.container(1) },
  cloudProvider: { call: (s) => s.cloudProvider(1) },
  cloudId: { call: (s) => s.cloudId(1) },
  logicalSize: { call: (s) => s.logicalSize(1) },
  parent: { call: (s) => s.parent(4) },
  setSize: { call: (s) => s.setSize(1, 6) },
  setModifiedAt: { call: (s) => s.setModifiedAt(1, 3_000) },
  setAccessedAt: { call: (s) => s.setAccessedAt(1, 4_000) },
  setFlag: { call: (s) => s.setFlag(1, Flag.Hidden, true) },
  addToSize: { call: (s) => s.addToSize(1, 1) },
  removeNode: { call: (s) => s.removeNode(4) },
  childCount: { call: (s) => s.childCount(0) },
  hasChildArray: { call: (s) => s.hasChildArray(2) },
  childIds: { call: (s) => s.childIds(0) },
  forEachChild: { call: (s) => s.forEachChild(0, () => {}) },
  childByName: { call: (s) => s.childByName(0, 'b') },
  eachFile: { call: (s) => s.eachFile(0, () => {}) },
  eachNode: { call: (s) => s.eachNode(0, () => {}) },
  findByPath: { call: (s) => s.findByPath('/r/b/c.bin') },
  ingestSubtree: { call: (s) => s.ingestSubtree(3, graft) },
  prune: { call: (s) => s.prune(0, { maxNodes: 10 }) },
  materialize: { call: (s) => s.materialize(0) },
  bareNode: { call: (s) => s.bareNode(4) },
};

/** Members only the class itself calls: its storage plumbing and its checks. */
const INTERNAL = new Set([
  'allocate', 'grow', 'appendName', 'internExt', 'writeNode', 'check', 'live', 'requireFinal', 'nameEquals',
]);

const PRODUCERS: Array<[string, () => PackedScanStore]> = [
  ['built and finalized', built],
  ['adopting a native build\'s columns', adopted],
];

test('every public member of PackedScanStore is one this file reads after release', () => {
  const members = Object.getOwnPropertyNames(PackedScanStore.prototype)
    .filter((name) => name !== 'constructor' && name !== 'release' && !INTERNAL.has(name))
    .sort();
  assert.deepEqual(members, Object.keys(CALLS).sort());
});

for (const [how, make] of PRODUCERS) {
  test(`a store ${how} answers until it is released, then every accessor throws the released error`, () => {
    for (const [member, { call, fresh }] of Object.entries(CALLS)) {
      const live = (fresh ?? make)();
      assert.doesNotThrow(() => call(live), `${member} on a live store`);
    }
    const store = make();
    assert.equal(store.path(4), '/r/b/c.bin');
    assert.equal(store.extension(1), 'txt');
    assert.equal(store.accessedAt(1), 2_000);
    assert.deepEqual(store.childIds(0), [1, 2, 3]);
    const version = store.version;
    store.release();
    // streamTreeJson (scanStoreJson.ts) compares the version across each
    // awaited write and stops, answering false, when it has changed.
    assert.notEqual(store.version, version, 'release changes the version');
    for (const [member, { call }] of Object.entries(CALLS)) {
      assert.throws(() => call(store), RELEASED, `${member} after release`);
    }
    // The root answers from fields no column holds, so the check must stop it too.
    assert.throws(() => store.path(store.rootId), RELEASED);
    assert.throws(() => store.findByPath(store.rootPath), RELEASED);
  });
}

test('releasing twice is harmless, and the store stays released', () => {
  const store = adopted();
  store.release();
  assert.doesNotThrow(() => store.release());
  assert.throws(() => store.size(1), RELEASED);
});

/** The tables beside the columns, each a private field of the store. */
const SIDE_TABLES = [
  'extraChildren', 'removedUnder', 'logicalMap', 'cloudIdMap', 'extDict', 'extLookup', 'extOverflow',
];

/** The build-time adjacency, private fields a store holds until it is finalized. */
const ADJACENCY = ['firstChild', 'lastChild', 'nextSibling'];

/** A private field of the store, read through a cast; it must hold an object. */
function heldBy(store: PackedScanStore, field: string): object {
  const value = (store as unknown as Record<string, unknown>)[field];
  assert.ok(typeof value === 'object' && value !== null, `the store holds ${field}`);
  return value;
}

/**
 * Counts collections of what is registered with it, forcing a collection on
 * each count.
 */
function collections(): { register: (value: object, name: string) => void; registered: () => number; collected: () => number } {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  let registered = 0;
  let collected = 0;
  const registry = new FinalizationRegistry<string>(() => {
    collected++;
  });
  return {
    register: (value, name) => {
      registry.register(value, name);
      registered++;
    },
    registered: () => registered,
    collected: () => {
      gc();
      return collected;
    },
  };
}

test('release lets go of every column and side table: each is collected once nothing else holds it', async () => {
  const { register, registered, collected } = collections();
  let columnsRegistered = 0;
  const store = new PackedScanStore('/r', '/', input('r', true));
  // Registered inside a function of its own, so no binding of this test's
  // holds a column or a table once it returns.
  ((cols: StoreColumns) => {
    // One extension past the dictionary, so the store holds an overflow table.
    cols.ext[4] = 0xffff;
    cols.extOverflow = [[4, 'bin']];
    for (const [name, value] of Object.entries(cols)) {
      if (ArrayBuffer.isView(value)) {
        register(value, name);
        columnsRegistered++;
      }
    }
    store.adoptColumns(cols);
    for (const table of SIDE_TABLES) register(heldBy(store, table), table);
  })(columns());
  assert.equal(columnsRegistered, 12, 'every typed-array column, atime included');
  assert.equal(registered(), 12 + SIDE_TABLES.length);
  assert.equal(store.size(4), 7);
  assert.equal(store.extension(4), 'bin');
  store.release();
  await waitFor(() => collected() === registered(), `all ${registered()} columns and tables collected after release`);
  assert.equal(collected(), registered());
});

test('release of a store never finalized lets go of its build-time adjacency and every other table', async () => {
  const { register, registered, collected } = collections();
  const held: string[] = [];
  const store = new PackedScanStore('/r', '/', input('r', true));
  ((): void => {
    const b = store.addNode(0, input('b', true));
    store.addNode(b, input('c.bin', false, { size: 7, extension: 'bin', accessedAt: 2_000, logicalSize: 4, cloudId: 'c-1' }));
    // Every object the store holds, read through a cast: each is a column or a table.
    for (const [field, value] of Object.entries(store as unknown as Record<string, unknown>)) {
      if (typeof value === 'object' && value !== null) {
        register(value, field);
        held.push(field);
      }
    }
  })();
  assert.deepEqual([...held].sort(), [
    ...ADJACENCY,
    ...SIDE_TABLES.filter((table) => table !== 'extOverflow'),
    'atimeArr', 'cloudProvArr', 'containerArr', 'extArr', 'flagsArr', 'mtimeArr', 'nameBytes', 'nameOff',
    'parentArr', 'sizeArr',
  ].sort(), 'no childStart or childCnt before finalize, and no overflow table');
  assert.equal(store.cloudId(2), 'c-1');
  assert.equal(store.logicalSize(2), 4);
  store.release();
  await waitFor(() => collected() === registered(), `all ${registered()} of ${held.join(', ')} collected after release`);
  assert.equal(collected(), registered());
});

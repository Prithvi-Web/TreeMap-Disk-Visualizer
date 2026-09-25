import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-packedStoreAdopt-data-');

import { Flag, NodeInput, PackedScanStore, StoreColumns } from '../src/services/scanStore';
import { buildPair, compareStores, comparePrunes, mutateBoth } from './fixtures/storeFuzz';

/**
 * Phase 4 S2: the native engine's scan arrives as columns the Rust store
 * (tm-store) built — PackedScanStore's own layout, every column `capacity`
 * rows long so nodes added later fit without a copy — and the packed store
 * the scanner already made adopts them in place (`adoptColumns`). Here the
 * columns are read out of a store built the ordinary way, through its public
 * API only, and a fresh store that adopts them must answer exactly as the
 * object store (the oracle) does: every node, traversal order, path lookup,
 * prune JSON across budgets, and after the watcher's mutations, including
 * growth past the headroom.
 */

const CONTAINER_ID: Record<string, number> = { zip: 1, tar: 2, tgz: 3, iso: 4, dmg: 5, photos: 6, docker: 7 };
const CLOUD_ID: Record<string, number> = { icloud: 1, onedrive: 2, dropbox: 3 };
const FLAG_BITS = [
  Flag.Dir, Flag.HasChildArray, Flag.Hidden, Flag.HardlinkDup, Flag.Symlink,
  Flag.CloudPlaceholder, Flag.GitRepo, Flag.Virtual, Flag.HasAccessed,
];
const encoder = new TextEncoder();

/**
 * A finalized store's columns as the native build hands them over:
 * `capacity` rows each (the headroom rows zero), `nameOff` one longer, the
 * names with `nameRoom` spare bytes. Read through the public API only.
 */
function columnsOf(store: PackedScanStore, headroom: number, nameRoom: number): StoreColumns {
  const n = store.count;
  const capacity = n + headroom;
  const parent = new Int32Array(capacity);
  const size = new Float64Array(capacity);
  const mtime = new Float64Array(capacity);
  let atime: Float64Array | null = null;
  const flags = new Uint16Array(capacity);
  const ext = new Uint16Array(capacity);
  const container = new Uint8Array(capacity);
  const cloudProv = new Uint8Array(capacity);
  const nameOff = new Uint32Array(capacity + 1);
  const childStart = new Uint32Array(capacity);
  const childCnt = new Uint32Array(capacity);
  const extDict = [''];
  const extIds = new Map<string, number>();
  const nameParts: Uint8Array[] = [];
  let namesLen = 0;
  let running = 1;
  for (let id = 0; id < n; id++) {
    parent[id] = store.parent(id);
    size[id] = store.size(id);
    mtime[id] = store.modifiedAt(id);
    let bits = 0;
    for (const f of FLAG_BITS) if (store.flag(id, f)) bits |= f;
    flags[id] = bits;
    const accessed = store.accessedAt(id);
    if (accessed !== undefined) (atime ??= new Float64Array(capacity))[id] = accessed;
    const e = store.extension(id);
    if (e !== undefined) {
      let extId = extIds.get(e);
      if (extId === undefined) {
        extId = extDict.length;
        extDict.push(e);
        extIds.set(e, extId);
      }
      ext[id] = extId;
    }
    const kind = store.container(id);
    container[id] = kind ? CONTAINER_ID[kind] : 0;
    const provider = store.cloudProvider(id);
    cloudProv[id] = provider ? CLOUD_ID[provider] : 0;
    const bytes = encoder.encode(store.name(id));
    nameParts.push(bytes);
    nameOff[id] = namesLen;
    namesLen += bytes.length;
    const kids = store.childIds(id);
    kids.forEach((kid, k) => assert.equal(kid, running + k, 'a finalized store numbers children consecutively'));
    childStart[id] = running;
    childCnt[id] = kids.length;
    running += kids.length;
  }
  nameOff[n] = namesLen;
  const names = new Uint8Array(namesLen + nameRoom);
  let at = 0;
  for (const part of nameParts) {
    names.set(part, at);
    at += part.length;
  }
  return {
    n, capacity, parent, size, mtime, atime, flags, ext, container, cloudProv,
    nameOff, names, namesLen, childStart, childCnt, extDict, extOverflow: [],
  };
}

/** A store holding only its root, as the scanner makes it before the walk. */
function freshStore(rootPath: string, sep: string, root: NodeInput): PackedScanStore {
  return new PackedScanStore(rootPath, sep, root);
}

function rootInputOf(store: PackedScanStore): NodeInput {
  return { name: store.name(0), isDir: true, size: 0, modifiedAt: store.modifiedAt(0), isHidden: store.flag(0, Flag.Hidden) };
}

test('an adopted store answers as the oracle does, on 96 random trees (cloud-id roots excepted)', () => {
  let checked = 0;
  for (let iter = 0; iter < 120; iter++) {
    if (iter % 5 === 3) continue; // a cloud root's ids and logical sizes are not columns: no native scan has them
    const { obj, packed, rng } = buildPair(1000 + iter, iter, 1200);
    const adopted = freshStore(packed.rootPath, packed.sep, rootInputOf(packed));
    adopted.adoptColumns(columnsOf(packed, 1 + (iter % 7), 16 * (iter % 3)));
    try {
      compareStores(obj, adopted, rng);
      comparePrunes(obj, adopted);
    } catch (err) {
      throw new Error(`adopt iteration ${iter} (seed ${1000 + iter}): ${String(err)}`, { cause: err });
    }
    checked++;
  }
  assert.equal(checked, 96);
});

test('an adopted store takes the watcher\'s changes as the oracle does, growing past its headroom', () => {
  for (let iter = 0; iter < 40; iter++) {
    if (iter % 5 === 3) continue;
    const { obj, packed, rng } = buildPair(9000 + iter, iter, 900);
    const adopted = freshStore(packed.rootPath, packed.sep, rootInputOf(packed));
    // Two spare rows: the six new files outgrow them. Every other tree has no
    // spare name bytes (the names grow too) or 24 (a new name lands in the
    // room after the adopted names, not after the whole buffer).
    adopted.adoptColumns(columnsOf(packed, 2, iter % 2 === 0 ? 0 : 24));
    try {
      mutateBoth(obj, adopted, rng);
      compareStores(obj, adopted, rng);
      comparePrunes(obj, adopted);
    } catch (err) {
      throw new Error(`adopt mutation iteration ${iter} (seed ${9000 + iter}): ${String(err)}`, { cause: err });
    }
  }
});

test('an extension past the dictionary is read from the overflow list', () => {
  const { packed } = buildPair(4242, 0, 50);
  const cols = columnsOf(packed, 4, 0);
  const file = Array.from({ length: cols.n }, (_, id) => id).find((id) => !packed.isDir(id));
  assert.ok(file !== undefined);
  cols.ext[file] = 0xffff;
  cols.extOverflow = [[file, 'overflowed']];
  const adopted = freshStore(packed.rootPath, packed.sep, rootInputOf(packed));
  adopted.adoptColumns(cols);
  assert.equal(adopted.extension(file), 'overflowed');
});

test('adoptColumns refuses a store that is not fresh, and columns that do not fit together', () => {
  const { packed } = buildPair(77, 0, 60);
  const good = (): StoreColumns => columnsOf(packed, 3, 8);
  const fresh = (): PackedScanStore => freshStore(packed.rootPath, packed.sep, rootInputOf(packed));

  assert.throws(() => packed.adoptColumns(good()), /only a store holding just its root/);
  const grown = fresh();
  grown.addNode(0, { name: 'x', isDir: false, size: 1, modifiedAt: 0, isHidden: false });
  assert.throws(() => grown.adoptColumns(good()), /only a store holding just its root/);
  const finalized = fresh();
  finalized.finalize();
  assert.throws(() => finalized.adoptColumns(good()), /only a store holding just its root/, 'a finalized root-only store');

  const bad: Array<[string, (c: StoreColumns) => void, RegExp]> = [
    ['no rows', (c) => { c.n = 0; }, /n must be at least 1/],
    ['more rows than room', (c) => { c.capacity = c.n - 1; }, /capacity \d+ is less than the \d+ rows/],
    ['a short column', (c) => { c.size = c.size.subarray(0, c.n); }, /size has \d+ rows/],
    ['a short atime column', (c) => { c.atime = new Float64Array(c.n); }, /atime has \d+ rows/],
    ['name offsets one short', (c) => { c.nameOff = c.nameOff.subarray(0, c.capacity); }, /nameOff/],
    ['names past their buffer', (c) => { c.namesLen = c.names.length + 1; }, /namesLen \d+ does not fit/],
    ['a root with a parent', (c) => { c.parent[0] = 0; }, /root/],
    ['an empty dictionary', (c) => { c.extDict = []; }, /extDict/],
    ['a dictionary whose first entry is an extension', (c) => { c.extDict = ['jpg', ...c.extDict]; }, /extDict/],
    ['a dictionary past 65,535 entries', (c) => { c.extDict = ['', ...Array.from({ length: 0xffff }, (_, i) => `e${i}`)]; }, /extDict/],
    ['names that end where nameOff does not', (c) => { c.namesLen -= 1; }, /nameOff\[\d+\] is \d+, not namesLen/],
    ['an overflow text for a node without the mark', (c) => { c.extOverflow = [[1, 'x']]; }, /extOverflow names node 1/],
    ['an overflow text for no node', (c) => { const at = c.n; c.extOverflow = [[at, 'x']]; }, /extOverflow names node/],
  ];
  for (const [what, spoil, message] of bad) {
    const cols = good();
    spoil(cols);
    assert.throws(() => fresh().adoptColumns(cols), message, what);
  }
  const ok = fresh();
  ok.adoptColumns(good());
  assert.equal(ok.count, packed.count);
  assert.throws(() => ok.adoptColumns(good()), /only a store holding just its root/, 'adopting twice');
});

test('adopting keeps the columns it was given: no copy of any array', () => {
  const { packed } = buildPair(5150, 0, 80);
  const cols = columnsOf(packed, 5, 32);
  const adopted = freshStore(packed.rootPath, packed.sep, rootInputOf(packed));
  adopted.adoptColumns(cols);
  // A write through the store lands in the array Node handed over.
  const id = cols.n - 1;
  adopted.setSize(id, 123_456);
  assert.equal(cols.size[id], 123_456);
  adopted.setModifiedAt(id, 42);
  assert.equal(cols.mtime[id], 42);
  // The headroom rows are the adopted arrays' own: a node the watcher adds
  // lands in them, with no copy of any column.
  const added = adopted.addNode(0, { name: 'late.txt', isDir: false, size: 777, modifiedAt: 7, isHidden: false });
  assert.equal(added, cols.n);
  assert.equal(cols.size[added], 777);
  assert.equal(cols.parent[added], 0);
  assert.equal(cols.mtime[added], 7);
});

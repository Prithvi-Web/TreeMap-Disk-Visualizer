import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { NativeStore, ScanStartOptions, WalkResult } from '../native/index';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-nativeCompletion-data-');

import { skipOrFailOnCi } from './fixtures/ciSkip';
import { waitFor } from './fixtures/waitFor';
import { buildEdgeFixture, unlockAndRemove } from './fixtures/nativeEdge';
import { comparePrunes, compareStores, makeRng } from './fixtures/storeFuzz';
import { oracleAdoptNativeStore } from './fixtures/adoptOracle';
import {
  buildObject,
  buildPacked,
  columnParentsDecrease,
  fuzzColumns,
  nameBytesBelowRoot,
  parentsNeverDecrease,
  randomSpec,
  syntheticTaken,
  type TakenSpec,
} from './fixtures/completionFixtures';
import { loadNative, resetNativeForTests, type ScanModule } from '../src/services/scan/native';
import { ingestColumns, rootName, runNativeWalk, type NativeStorage } from '../src/services/scan/nativeEngine';
import { ADOPT_SLICE_ITEMS, adoptNativeStore, adoptNativeStoreInSlices } from '../src/services/scan/nativeMemory';
import { setCompletionSlicesForTests } from '../src/services/scan/completionSlices';
import { statToInput } from '../src/services/scan/nodeInput';
import { Flag, PackedScanStore, forceFinalizePermutationForTests, type NodeInput } from '../src/services/scanStore';
import { neverDescendPaths } from '../src/utils/mountBoundaries';
import { createScanRecord } from '../src/services/diskScanner';
import { platform } from '../src/platform';
import type { ScanResult } from '../src/models/types';

/**
 * Track U, U-35, part 1: a native scan's completion without one long stall.
 *
 * The diagnosis measured the main thread held for 7.4 s (run 1) and 11.8 s
 * (run 3) as a whole-disk native scan completed: the ingest, `finalize()`'s
 * renumbering (11 % of the samples), the columns' regrowth and copies (3 %),
 * and on the memory path — every scan's since T10 — Node's passes over the
 * store the native build hands over. Three changes, each held here:
 *
 *  - `finalize()` of a store already in breadth-first order — the ingest's,
 *    where every node comes under a parent no smaller than the one before it —
 *    builds the child ranges from the build lists and permutes nothing: the
 *    renumbering there is the identity. Any other order (a walker's, a
 *    depth-first graft) is permuted as before.
 *  - `PackedScanStore.reserve(rows, nameBytes)`: room made once. The ingest
 *    reserves exactly what the walk's columns hold, so it never regrows a
 *    column or the name pool, and finalize, with the room equal to the rows,
 *    has nothing to trim.
 *  - The adopt's three passes — text candidates, cloud candidates (a path
 *    built for each), refused folders — run a slice at a time with the event
 *    loop turning between slices, write the scan record once, at the end, and
 *    stop between slices when the scan is stopped.
 *
 * Every answer is held to the old one: a forced permutation, the object store,
 * the pre-change adopt copied verbatim (tests/fixtures/adoptOracle.ts: the
 * release's one-shot adopt, U-4's `Flag.Unlisted` mark on each refused folder
 * included), and on the real module the columns path. Rows, copies, slices and turns are
 * counted; nothing is timed.
 */

const REPO = path.join(__dirname, '..');
const PREBUILT_MODULE = path.join(REPO, 'native', 'prebuilt', `${process.platform}-${process.arch}`, 'treemap_core.node');
const BLOCKS_ARE_MEANINGFUL = platform().blocksAreMeaningful;
const PRUNE_SIZES = [1, 50, 250_000];
/** Every flag a row can carry, U-4's `Unlisted` among them: a store that lost the mark on a refused folder differs. */
const ALL_FLAGS = [
  Flag.Dir, Flag.HasChildArray, Flag.Hidden, Flag.HardlinkDup, Flag.Symlink,
  Flag.CloudPlaceholder, Flag.GitRepo, Flag.Virtual, Flag.HasAccessed, Flag.Removed, Flag.Unlisted,
] as const;
/** Every field of the scan record the ingest or the adopt fills. */
const RECORD_FIELDS = [
  'scanned', 'fileCount', 'dirCount', 'walkedDirs', 'cachedDirs', 'hardlinkedFiles', 'hardlinkedBytes',
  'sparseFiles', 'sparseBytes', 'slackBytes', 'cloudFiles', 'cloudBytes', 'deniedDirs', 'deniedExamples',
  'vanishedDirs', 'unreadableDirs', 'deniedEntries', 'unreadableEntries', 'placeholdersSkipped',
] as const;
const immediate = (): Promise<void> => Promise.resolve();
/** The rows and name bytes a new store starts with (scanStore.ts): a build within them is trimmed at finalize, reserve or not. */
const INITIAL_ROWS = 1_024;
const INITIAL_NAME_ROOM = 16 * 1_024;

/* ------------------------------ comparing stores ------------------------------ */

/** Every column of every row, read through the accessors, and each row's children in order. */
function rowsOf(store: PackedScanStore): unknown[] {
  const rows: unknown[] = [];
  for (let id = 0; id < store.count; id++) {
    let flags = 0;
    for (const f of ALL_FLAGS) if (store.flag(id, f)) flags |= f;
    rows.push([
      id, store.name(id), store.parent(id), store.size(id), store.modifiedAt(id), store.accessedAt(id), store.extension(id),
      store.container(id), store.cloudProvider(id), store.cloudId(id), store.logicalSize(id), flags, store.childIds(id),
    ]);
  }
  return rows;
}

/** The pruned tree at each budget, as the API emits it, with its node and pruned-folder counts. */
function prunesOf(store: PackedScanStore): string[] {
  return PRUNE_SIZES.map((maxNodes) => {
    const p = store.prune(store.rootId, { maxNodes });
    return `${maxNodes}: ${p.nodes} nodes, ${p.prunedDirs} pruned, ${JSON.stringify(p.root)}`;
  });
}

/** Where two strings first differ, with a little of each around it: a short message however long they are. */
function firstDifference(got: string, want: string): string {
  let i = 0;
  while (i < got.length && i < want.length && got[i] === want[i]) i++;
  return `at character ${i}: …${got.slice(Math.max(0, i - 60), i + 60)}… where …${want.slice(Math.max(0, i - 60), i + 60)}… was wanted`;
}

/**
 * Every column of every row, each row's children, and the pruned JSON, the
 * same in both stores. Compared one row and one prune at a time, so a store
 * that differs everywhere fails with one short message rather than a diff of
 * the whole tree.
 */
function assertSameStore(got: PackedScanStore, want: PackedScanStore, what: string): void {
  assert.equal(got.count, want.count, `${what}: the same rows`);
  // Both shapes first: two stores broken the same way agree row for row, and
  // a prune of a store whose node is its own child builds ever longer paths.
  assertTreeShape(got, what);
  assertTreeShape(want, `${what} (the store held to)`);
  const gotRows = rowsOf(got);
  const wantRows = rowsOf(want);
  for (let i = 0; i < gotRows.length; i++) {
    if (!isDeepStrictEqual(gotRows[i], wantRows[i])) assert.deepEqual(gotRows[i], wantRows[i], `${what}: row ${i}, every column and its children`);
  }
  const gotPrunes = prunesOf(got);
  const wantPrunes = prunesOf(want);
  PRUNE_SIZES.forEach((size, k) => {
    if (gotPrunes[k] !== wantPrunes[k]) assert.fail(`${what}: the pruned JSON at ${size} nodes differs ${firstDifference(gotPrunes[k], wantPrunes[k])}`);
  });
}

/**
 * Every row's children name it as their parent and come after it, the shape
 * of a finalized store: checked in one bounded pass before anything walks the
 * tree, so a store a mistake made cyclic fails here instead of walking forever.
 */
function assertTreeShape(store: PackedScanStore, what: string): void {
  for (let id = 0; id < store.count; id++) {
    for (const child of store.childIds(id)) {
      if (store.parent(child) !== id || child <= id) assert.fail(`${what}: row ${id} lists row ${child} as a child, whose parent is ${store.parent(child)}`);
    }
  }
}

function record(scan: ScanResult): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of RECORD_FIELDS) out[k] = k === 'deniedExamples' && scan.deniedExamples ? [...scan.deniedExamples] : scan[k];
  return out;
}

/** `fn` with every finalize forced through the permutation (the old path), the fast path restored after. */
function permuted<T>(fn: () => T): T {
  forceFinalizePermutationForTests(true);
  try {
    return fn();
  } finally {
    forceFinalizePermutationForTests(false);
  }
}

/* ------------------------------ finalize: nothing to renumber ------------------------------ */

test('a store built breadth-first finalizes without moving a row, and answers as the same build permuted the old way and as the object store', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const spec = randomSpec(seed, 300 + seed * 110);
    const fast = buildPacked(spec, 'breadthFirst');
    assert.ok(parentsNeverDecrease(fast.parents), `seed ${seed}: the breadth-first build never puts a node under a smaller parent than the one before`);
    fast.store.finalize();
    assertTreeShape(fast.store, `seed ${seed}`);
    const n = fast.store.count;
    assert.equal(fast.store.buildCountsForTests().permutedRows, 0, `seed ${seed}: finalize moved no row of a store already in breadth-first order`);
    const slow = permuted(() => {
      const built = buildPacked(spec, 'breadthFirst');
      built.store.finalize();
      return built;
    });
    assert.equal(slow.store.buildCountsForTests().permutedRows, n, `seed ${seed}: the forced permutation moved every one of the ${n} rows`);
    fast.store.sumSizes();
    slow.store.sumSizes();
    assertSameStore(fast.store, slow.store, `seed ${seed}`);

    const obj = buildObject(spec);
    obj.finalize();
    obj.sumSizes();
    compareStores(obj, fast.store, makeRng(seed));
    comparePrunes(obj, fast.store);

    // After finalize the two take the watcher's edits the same way: sizes,
    // removals and nodes added later, which regrow a store left at its rows.
    const rng = makeRng(seed + 1_000);
    for (let k = 0; k < 40; k++) {
      const id = 1 + Math.floor(rng() * (n - 1));
      const roll = rng();
      if (roll < 0.4) {
        const size = Math.floor(rng() * 1e6);
        fast.store.setSize(id, size);
        slow.store.setSize(id, size);
      } else if (roll < 0.6) {
        fast.store.removeNode(id);
        slow.store.removeNode(id);
      } else if (fast.store.isDir(id)) {
        const input: NodeInput = { name: `late-${k}.log`, isDir: false, size: k, modifiedAt: 1_750_000_000_000, isHidden: false, extension: 'log' };
        fast.store.addNode(id, input);
        slow.store.addNode(id, input);
      }
    }
    assertSameStore(fast.store, slow.store, `seed ${seed}, after the watcher's edits`);
  }
});

test('a store built in a walker\'s order, or depth first, is permuted as before and answers as the object store', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const spec = randomSpec(seed, 400 + seed * 90);
    const obj = buildObject(spec);
    obj.finalize();
    obj.sumSizes();
    for (const order of ['walker', 'depthFirst'] as const) {
      const built = buildPacked(spec, order, seed);
      assert.ok(!parentsNeverDecrease(built.parents), `seed ${seed}, ${order}: the build puts some node under a smaller parent than the one before (the fixture's point)`);
      built.store.finalize();
      assert.equal(built.store.buildCountsForTests().permutedRows, built.store.count, `seed ${seed}, ${order}: finalize permuted every row`);
      assertTreeShape(built.store, `seed ${seed}, ${order}`);
      built.store.sumSizes();
      compareStores(obj, built.store, makeRng(seed));
      comparePrunes(obj, built.store);
    }
  }
});

test('reserve: a build of exactly the room it reserved never regrows, and finalize keeps the columns it built', () => {
  const spec = randomSpec(77, 3_000);
  const bytes = nameBytesBelowRoot(spec);
  assert.ok(bytes > INITIAL_NAME_ROOM, `the names (${bytes} bytes) outgrow the pool a store starts with, so its room is the reserve's`);
  const reserved = new PackedScanStore(spec.profile.rootPath, spec.profile.sep, spec.root);
  reserved.reserve(spec.nodes, bytes);
  // buildPacked makes its own store; this one is filled the same way, breadth first.
  const queue: Array<{ id: number; kids: typeof spec.children }> = [{ id: reserved.rootId, kids: spec.children }];
  while (queue.length > 0) {
    const { id, kids } = queue.shift() as (typeof queue)[number];
    for (const kid of kids) {
      const child = reserved.addNode(id, kid.input);
      if (kid.children) queue.push({ id: child, kids: kid.children });
    }
  }
  const before = reserved.buildCountsForTests();
  assert.equal(before.grows, 0, 'no column regrown: the room was made once');
  assert.equal(before.nameGrows, 0, 'no name pool regrown: names with accents, CJK and emoji fit the bytes reserved, to the byte');
  reserved.finalize();
  const after = reserved.buildCountsForTests();
  assert.equal(after.permutedRows, 0, 'breadth first: nothing permuted');
  assert.equal(after.columnTrims, 0, 'the room equals the rows: no column copied to trim it');
  assert.equal(after.nameTrims, 0, 'the name pool equals its bytes: not copied either');

  const plain = buildPacked(spec, 'breadthFirst').store;
  const grown = plain.buildCountsForTests();
  assert.equal(grown.grows, 2, 'without reserve, 3,001 rows regrow the columns twice from 1,024 (the counter counts)');
  assert.ok(grown.nameGrows >= 1, `without reserve the names regrow too (${grown.nameGrows})`);
  plain.finalize();
  assert.equal(plain.buildCountsForTests().columnTrims, 1, 'and finalize trims the 4,096-row columns to the 3,001 rows once');
  assert.equal(plain.buildCountsForTests().nameTrims, 1, 'and the name pool to its bytes');
  reserved.sumSizes();
  plain.sumSizes();
  assertSameStore(reserved, plain, 'reserved against grown');
});

test('reserve counts a name\'s bytes as the encoder writes them: a lone surrogate is three, an emoji four', () => {
  const kinds = ['x\uD800y', 'ok\u{1F600}', '\uDC00', 'Ω.txt', 'plain', '文字'];
  const names = Array.from({ length: 3_000 }, (_, k) => `${kinds[k % kinds.length]}${k}`);
  const bytes = names.reduce((sum, name) => sum + Buffer.byteLength(name, 'utf8'), 0);
  assert.ok(bytes > INITIAL_NAME_ROOM, `the names (${bytes} bytes) outgrow the pool a store starts with`);
  const store = new PackedScanStore('/r', '/', statToInput('r', true, 0, 0));
  store.reserve(names.length, bytes);
  for (const name of names) store.addNode(store.rootId, statToInput(name, false, 1, 0));
  assert.equal(store.buildCountsForTests().nameGrows, 0, 'the bytes reserved were enough');
  store.finalize();
  assert.equal(store.buildCountsForTests().nameTrims, 0, 'and exactly used: none left over to trim');
  const stored = store.childIds(store.rootId).map((id) => store.name(id));
  assert.deepEqual(stored.slice(0, 6), ['x�y0', 'ok\u{1F600}1', '�2', 'Ω.txt3', 'plain4', '文字5'], 'a lone surrogate is stored as U+FFFD, as it always was');
  assert.deepEqual(stored, names.map((name) => new TextDecoder().decode(new TextEncoder().encode(name))), 'every name as the encoder writes it');
});

test('a name\'s own bytes decide whether the pool regrows: one byte short regrows it, exactly enough does not, and the name is whole either way', () => {
  // Each probe is added to a pool left with exactly `slack` bytes free: one
  // less than the name's UTF-8 must regrow it (or the encoder would cut the
  // name short), exactly its UTF-8 must not.
  const probes = ['abc', 'é', 'ࠀ', '文字', 'a\u{1F600}', '\uD800', 'x\uDC00', '\uD83D', '􏿿z'];
  for (const probe of probes) {
    const bytes = Buffer.byteLength(probe, 'utf8');
    for (const slack of [bytes - 1, bytes]) {
      const room = 20_000;
      const store = new PackedScanStore('/r', '/', statToInput('r', true, 0, 0));
      store.reserve(2, room);
      store.addNode(store.rootId, statToInput('a'.repeat(room - slack), false, 1, 0));
      const id = store.addNode(store.rootId, statToInput(probe, false, 1, 0));
      const what = `${JSON.stringify(probe)} (${bytes} bytes) with ${slack} free`;
      assert.equal(store.buildCountsForTests().nameGrows, slack < bytes ? 1 : 0, `${what}: ${slack < bytes ? 'regrows' : 'fits as it is'}`);
      store.finalize();
      assert.equal(store.name(id), new TextDecoder().decode(new TextEncoder().encode(probe)), `${what}: the name is whole`);
    }
  }
});

test('reserve refuses what is not a count, makes room after finalize too, and never shrinks the room', () => {
  const store = new PackedScanStore('/r', '/', statToInput('r', true, 0, 0));
  for (const [rows, bytes] of [[-1, 0], [1.5, 0], [0, -2], [Number.NaN, 0], [0, Number.POSITIVE_INFINITY]]) {
    assert.throws(() => store.reserve(rows, bytes), RangeError, `reserve(${rows}, ${bytes}) is refused`);
  }
  for (let k = 0; k < 5; k++) store.addNode(store.rootId, statToInput(`a${k}`, true, 0, 0));
  store.finalize();
  const late = Array.from({ length: 3_000 }, (_, k) => `late${k}.txt`);
  store.reserve(late.length, late.reduce((sum, name) => sum + Buffer.byteLength(name, 'utf8'), 0));
  // A smaller reserve, and an empty one, leave the room as it is.
  store.reserve(2, 2);
  store.reserve(0, 0);
  late.forEach((name, k) => store.addNode(1 + (k % 5), statToInput(name, false, k, 0)));
  assert.equal(store.buildCountsForTests().grows, 0, 'room made after finalize holds the nodes the watcher adds, never shrunk by a smaller reserve');
  assert.equal(store.buildCountsForTests().nameGrows, 0, 'and their names');
  assert.equal(store.childCount(1), 600, 'each folder holds its 600 late children');
  assert.deepEqual(store.childIds(5).slice(0, 2).map((id) => store.name(id)), ['late4.txt', 'late9.txt'], 'in the order they came');
  store.addNode(1, statToInput('one-more', false, 1, 0));
  assert.equal(store.buildCountsForTests().grows, 1, 'a room already full grows by doubling, as before');
});

test('a store past 65,535 extensions keeps every overflowing extension through the fast path', () => {
  // The slow path re-keys the overflow by the new ids; the fast path keeps
  // the ids, so it must keep the overflow as it is. 66,000 distinct
  // extensions: the last 466 are past the dictionary.
  const store = new PackedScanStore('/r', '/', statToInput('r', true, 0, 0));
  const dirs = [store.addNode(store.rootId, statToInput('a', true, 0, 0)), store.addNode(store.rootId, statToInput('b', true, 0, 0))];
  const wanted: Array<string | undefined> = [undefined, undefined, undefined];
  for (const dir of dirs) {
    for (let k = 0; k < 33_000; k++) {
      store.addNode(dir, statToInput(`f${dir}-${k}.e${dir}x${k}`, false, k, 0));
      wanted.push(`e${dir}x${k}`);
    }
  }
  store.finalize();
  assert.equal(store.buildCountsForTests().permutedRows, 0, 'breadth first: nothing permuted');
  const wrong = wanted.findIndex((ext, id) => store.extension(id) !== ext);
  assert.equal(wrong, -1, `every extension reads back, the overflowing ones too (row ${wrong}: ${wrong === -1 ? '' : store.extension(wrong)})`);
  assert.equal(store.extension(store.count - 1), 'e2x32999', 'the last, far past the dictionary');
});

/* ------------------------------ the native ingest ------------------------------ */

/** `cols` ingested into a fresh record for `root` and finalized, as `runNativeWalk`'s columns path leaves it. */
function ingest(root: string, cols: WalkResult): { scan: ScanResult; store: PackedScanStore } {
  const scan = createScanRecord(root);
  const store = new PackedScanStore(root, path.sep, statToInput(rootName(root), true, 0, 1_000));
  ingestColumns(scan, store, cols, root);
  store.finalize();
  store.sumSizes();
  return { scan, store };
}

/** The ingest with the fast path against the ingest finalized the old way: the same store and record, and the fast path's costs. */
function assertIngestFast(root: string, cols: () => WalkResult, what: string, exactNames = true): { scan: ScanResult; store: PackedScanStore } {
  const walked = cols();
  const fast = ingest(root, walked);
  const counts = fast.store.buildCountsForTests();
  assert.equal(counts.grows, 0, `${what}: the ingest reserved its rows, so no column regrew`);
  if (exactNames) {
    assert.equal(counts.nameGrows, 0, `${what}: and the bytes of its names`);
    const nameBytes = walked.nameOff[walked.parent.length] - walked.nameOff[1];
    if (nameBytes > INITIAL_NAME_ROOM) assert.equal(counts.nameTrims, 0, `${what}: to the byte, so the ${nameBytes} bytes of names were not trimmed`);
  }
  assert.equal(counts.permutedRows, 0, `${what}: the ingest builds breadth first, so finalize moved no row`);
  if (fast.store.count > INITIAL_ROWS) assert.equal(counts.columnTrims, 0, `${what}: and the room is the rows, so nothing was trimmed`);
  const slow = permuted(() => ingest(root, cols()));
  assert.equal(slow.store.buildCountsForTests().permutedRows, slow.store.count, `${what}: the forced permutation moved every row`);
  assertSameStore(fast.store, slow.store, what);
  assert.deepEqual(record(fast.scan), record(slow.scan), `${what}: the scan record`);
  return fast;
}

test('the native ingest reserves what the walk holds and builds it breadth first: no regrowth, no permutation, no trim, and the old store and record', () => {
  const root = path.join(path.sep, 'fuzz', 'walk');
  const seen = { hardlinked: 0, cloud: 0, sparse: 0, slack: 0, denied: 0, vanished: 0, unreadable: 0, git: 0 };
  for (let seed = 1; seed <= 10; seed++) {
    const entries = INITIAL_ROWS + seed * 270;
    const cols = (): WalkResult => fuzzColumns(seed, { entries, workers: 4 });
    assert.ok(columnParentsDecrease(cols()), `seed ${seed}: the workers interleaved, so a folder's children are not contiguous in the columns`);
    const { scan, store } = assertIngestFast(root, cols, `seed ${seed}`);
    seen.hardlinked += scan.hardlinkedFiles ?? 0;
    seen.cloud += scan.cloudFiles ?? 0;
    seen.sparse += scan.sparseFiles ?? 0;
    seen.slack += scan.slackBytes ? 1 : 0;
    seen.denied += scan.deniedDirs ?? 0;
    seen.vanished += scan.vanishedDirs ?? 0;
    seen.unreadable += scan.unreadableDirs ?? 0;
    store.eachNode(store.rootId, (id) => { if (store.flag(id, Flag.GitRepo)) seen.git++; });
  }
  for (const [what, count] of Object.entries(seen)) {
    if (!BLOCKS_ARE_MEANINGFUL && (what === 'sparse' || what === 'slack')) continue; // no sparse or slack account where blocks mean nothing
    assert.ok(count > 0, `the fuzz reached every case the ingest decides: ${what} (${count})`);
  }
  // Names with a byte that is not UTF-8 (Linux): each becomes U+FFFD, three bytes for one, so the
  // names may outgrow the bytes reserved; the answer must still be the old one.
  for (let seed = 11; seed <= 13; seed++) {
    assertIngestFast(root, () => fuzzColumns(seed, { entries: 900, workers: 3, invalidUtf8: true }), `seed ${seed}, names not UTF-8`, false);
  }
});

function loadCore(t: TestContext): ScanModule | null {
  const file = process.env.TREEMAP_NATIVE_MODULE ?? PREBUILT_MODULE;
  if (!fs.existsSync(file)) {
    skipOrFailOnCi(t, `no native module at ${file}; build it with npm run build:native`);
    return null;
  }
  resetNativeForTests();
  const r = loadNative({ path: file });
  if (!r.available) assert.fail(r.reason);
  return r.module as unknown as ScanModule;
}

/** The real module's columns for `root`: one walk, taken once it is done. */
async function realColumns(core: ScanModule, root: string, opts: Partial<ScanStartOptions> = {}): Promise<WalkResult> {
  const handle = core.scanStart(root, { neverDescend: neverDescendPaths(), wantAtime: true, ...opts });
  await waitFor(() => core.scanPoll(handle).done, 'the native walk', 5);
  return core.scanTake(handle);
}

test('real module: the edge fixture\'s columns and a synthetic walk\'s, numbered by real workers, ingest without regrowth or permutation and as the old finalize gives them', async (t) => {
  const core = loadCore(t);
  if (!core) return;
  const { root, locked } = await buildEdgeFixture('treemap-native-completion-');
  try {
    const cols = await realColumns(core, root);
    assertIngestFast(root, () => cols, 'the edge fixture');
  } finally {
    await unlockAndRemove(root, locked);
  }
  const synthetic = path.join((core as unknown as { syntheticTempFolder(): string }).syntheticTempFolder(), `completion-${process.pid}`);
  const cols = await realColumns(core, synthetic, { neverDescend: [], wantAtime: false, maxWorkers: 4, synthetic: { entries: 20_000, seed: 9, fanOut: 12, depth: 5 } });
  assert.ok(columnParentsDecrease(cols), 'four workers interleaved the synthetic walk\'s listings');
  assertIngestFast(synthetic, () => cols, 'a synthetic walk of 20,000 entries');
});

/* ------------------------------ the adopt, in slices ------------------------------ */

interface Adopted {
  scan: ScanResult;
  store: PackedScanStore;
}

const ADOPT_ROOT = '/Users/someone/r';

function freshTarget(): Adopted {
  return { scan: createScanRecord(ADOPT_ROOT), store: new PackedScanStore(ADOPT_ROOT, '/', statToInput('r', true, 0, 1_000)) };
}

function oracle(taken: NativeStore): Adopted {
  const target = freshTarget();
  oracleAdoptNativeStore(target.scan, target.store, taken);
  target.store.sumSizes();
  return target;
}

function assertSameAdopt(got: Adopted, want: Adopted, what: string): void {
  got.store.sumSizes();
  assert.deepEqual(record(got.scan), record(want.scan), `${what}: the scan record, field for field`);
  assertSameStore(got.store, want.store, what);
}

const TAKEN_SPECS: TakenSpec[] = [
  { folders: 12, filesPerFolder: 40, denied: 9, textEvery: 3, cloudEvery: 2, seed: 1 },
  { folders: 30, filesPerFolder: 25, denied: 0, textEvery: 0, cloudEvery: 1, seed: 2 },
  { folders: 7, filesPerFolder: 90, denied: 31, textEvery: 1, cloudEvery: 0, seed: 3 },
  { folders: 1, filesPerFolder: 1, denied: 0, textEvery: 0, cloudEvery: 0, seed: 4 },
];

/** The rows marked not listed (`Flag.Unlisted`, U-4). */
function unlistedRows(store: PackedScanStore): number[] {
  const rows: number[] = [];
  for (let id = 0; id < store.count; id++) if (store.flag(id, Flag.Unlisted)) rows.push(id);
  return rows;
}

test('the adopt in slices gives the old adopt\'s store and record at every slice size, and so does the drained adopt', async () => {
  let candidates = 0;
  for (const spec of TAKEN_SPECS) {
    const want = oracle(syntheticTaken(spec));
    // The oracle is the release's adopt: each refused folder marked not listed
    // (U-4), so a sliced adopt that lost the mark differs from it row for row.
    assert.deepEqual(unlistedRows(want.store), [...syntheticTaken(spec).counters.deniedDirs].sort((a, b) => a - b), `seed ${spec.seed}: the oracle marks every refused folder not listed, and nothing else`);
    const drained = freshTarget();
    adoptNativeStore(drained.scan, drained.store, syntheticTaken(spec));
    assertSameAdopt(drained, want, `seed ${spec.seed}, drained`);
    for (const slice of [1, 7, 64, 100_000]) {
      const sliced = freshTarget();
      const taken = syntheticTaken(spec);
      candidates += taken.textCandidates.length + taken.cloudCandidates.length + taken.counters.deniedDirs.length;
      const outcome = await adoptNativeStoreInSlices(sliced.scan, sliced.store, taken, { sliceNodes: slice, yieldTurn: immediate });
      assert.equal(outcome.completed, true, `seed ${spec.seed}, slices of ${slice}: completed`);
      assertSameAdopt(sliced, want, `seed ${spec.seed}, slices of ${slice}`);
    }
  }
  assert.ok(candidates > 1_000, `the specs held candidates and refused folders to slice (${candidates})`);
});

test('the adopt hands the loop back once per slice of its candidates and refused folders, and a turn queued before it runs before it answers', async () => {
  assert.equal(ADOPT_SLICE_ITEMS, 16_384, 'the slice the cleanup walk and the dashboard\'s lists use too');
  const cases: Array<[string, TakenSpec, number | undefined]> = [
    ['the default slice', { folders: 20, filesPerFolder: 1_000, denied: 25, textEvery: 4, cloudEvery: 1, seed: 5 }, undefined],
    ['slices of 5', { folders: 3, filesPerFolder: 21, denied: 4, textEvery: 2, cloudEvery: 3, seed: 6 }, 5],
    ['nothing to do', { folders: 2, filesPerFolder: 5, denied: 0, textEvery: 0, cloudEvery: 0, seed: 7 }, 5],
  ];
  for (const [what, spec, slice] of cases) {
    const taken = syntheticTaken(spec);
    const items = taken.textCandidates.length + taken.cloudCandidates.length + taken.counters.deniedDirs.length;
    const target = freshTarget();
    let yields = 0;
    const order: string[] = [];
    setImmediate(() => order.push('probe'));
    const outcome = await adoptNativeStoreInSlices(target.scan, target.store, taken, {
      ...(slice === undefined ? {} : { sliceNodes: slice }),
      yieldTurn: () => new Promise<void>((resolve) => { yields++; setImmediate(resolve); }),
    });
    order.push('answered');
    assert.equal(outcome.completed, true, `${what}: completed`);
    assert.equal(yields, Math.ceil(items / (slice ?? ADOPT_SLICE_ITEMS)), `${what}: one turn per slice of ${slice ?? ADOPT_SLICE_ITEMS} of its ${items} items`);
    if (items > 0) assert.deepEqual(order, ['probe', 'answered'], `${what}: a turn queued before the adopt ran before it answered`);
    assertSameAdopt(target, oracle(syntheticTaken(spec)), what);
  }
});

test('nothing reaches the scan record until the adopt\'s last turn', async () => {
  const spec: TakenSpec = { folders: 10, filesPerFolder: 30, denied: 12, textEvery: 4, cloudEvery: 2, seed: 8 };
  const target = freshTarget();
  const untouched = JSON.stringify(record(target.scan));
  let turns = 0;
  await adoptNativeStoreInSlices(target.scan, target.store, syntheticTaken(spec), {
    sliceNodes: 9,
    yieldTurn: async () => {
      turns++;
      assert.equal(JSON.stringify(record(target.scan)), untouched, `turn ${turns}: the record is as the walk left it`);
    },
  });
  assert.ok(turns > 10, `the adopt took many turns (${turns})`);
  assertSameAdopt(target, oracle(syntheticTaken(spec)), 'written at the end');
});

test('refused folders are added to a record that already holds some, as noteRefused adds them: the counts summed, the five smallest paths of both', async () => {
  // The adopt keeps a count and the five smallest paths across its slices, not
  // every path, and adds them to the record at the end. 31 refused folders,
  // `locked 7` to `locked 37`; the record already names one path that sorts
  // before them all and one after.
  const spec: TakenSpec = { folders: 6, filesPerFolder: 4, denied: 31, textEvery: 0, cloudEvery: 0, seed: 12 };
  const first = `${ADOPT_ROOT}/0 first`;
  const last = `${ADOPT_ROOT}/~ last`;
  const prefilled = (): Adopted => {
    const target = freshTarget();
    target.scan.deniedDirs = 2;
    target.scan.deniedExamples = [first, last];
    return target;
  };
  const want = prefilled();
  oracleAdoptNativeStore(want.scan, want.store, syntheticTaken(spec));
  want.store.sumSizes();
  assert.equal(want.scan.deniedDirs, 33, 'the oracle: two on the record and 31 refused folders');
  assert.deepEqual(want.scan.deniedExamples, [first, ...[10, 11, 12, 13].map((f) => `${ADOPT_ROOT}/locked ${f}`)], 'the oracle: the record\'s smaller path kept, its larger one displaced');
  for (const slice of [1, 7, 100_000]) {
    const got = prefilled();
    await adoptNativeStoreInSlices(got.scan, got.store, syntheticTaken(spec), { sliceNodes: slice, yieldTurn: immediate });
    assertSameAdopt(got, want, `slices of ${slice}`);
  }
  const drained = prefilled();
  adoptNativeStore(drained.scan, drained.store, syntheticTaken(spec));
  assertSameAdopt(drained, want, 'drained');
});

test('cloudBytes is one sum from 0 in the candidates\' order across slices, and so is sparseBytes past 2^53 (RISKS R91)', async () => {
  // Four candidates under the iCloud folder (1): 0, 1, 1 and 2^53 bytes. From 0 in
  // order the sum is exact, 2^53 + 2; slices of two summed apart would give
  // (0 + 1) + (1 + 2^53) = 2^53, the 1 rounded away.
  const cloudy = (): NativeStore => {
    const taken = syntheticTaken({ folders: 1, filesPerFolder: 4, denied: 0, textEvery: 0, cloudEvery: 1, seed: 9 });
    taken.size.set([0, 1, 1, 2 ** 53], 2);
    taken.flags.fill(0, 2, 6);
    taken.counters.cloudFiles = 0;
    taken.counters.hardlinkedFiles = 0;
    return taken;
  };
  const target = freshTarget();
  await adoptNativeStoreInSlices(target.scan, target.store, cloudy(), { sliceNodes: 2, yieldTurn: immediate });
  assert.equal(target.store.path(2), `${ADOPT_ROOT}/com~apple~CloudDocs 1/f0.bin`, 'the candidates sit under the iCloud folder');
  assert.equal(target.scan.cloudFiles, 4);
  assert.equal(target.scan.cloudBytes, 2 ** 53 + 2, 'summed in one pass from 0');
  assertSameAdopt(target, oracle(cloudy()), 'cloud bytes');

  if (!BLOCKS_ARE_MEANINGFUL) return; // no sparse account where blocks mean nothing
  // R91, as tests/nativeMemoryPath.test.ts builds it: ids the build numbered by block,
  // not breadth first. Breadth first: a5 (a term of 1), a6 (a guess Node counts, 1
  // byte), b3 (a term of 2^53): from 0 in that order, exactly 2^53 + 2.
  const r91 = freshTarget();
  await adoptNativeStoreInSlices(r91.scan, r91.store, blockNumbered(), { sliceNodes: 1, yieldTurn: immediate });
  assert.equal(r91.scan.sparseFiles, 3, 'the two the build counted and Node\'s guess');
  assert.equal(r91.scan.sparseBytes, 2 ** 53 + 2, 'summed in breadth-first order, across slices');
  assertSameAdopt(r91, oracle(blockNumbered()), 'R91, in slices of one');
});

/**
 * The root (0) holds folders `a` (1) and `b` (2); `b`'s block was reserved
 * first, so its files are 3 and 4, and `a`'s are 5 and 6. Breadth first the
 * files come a5, a6, b3, b4. Terms of 1 (a5) and 2^53 (b3); a6 and b4 are
 * cloud candidates with no provider, so sparse guesses (b4 a later name of a
 * hard-linked file, so not one).
 */
function blockNumbered(): NativeStore {
  const capacity = 9;
  const names = ['r', 'a', 'b', 'b3.img', 'b4.img', 'a5.img', 'a6.img'];
  const encoded = names.map((name) => new TextEncoder().encode(name));
  const nameOff = new Uint32Array(capacity + 1);
  let at = 0;
  encoded.forEach((bytes, id) => { nameOff[id] = at; at += bytes.length; });
  for (let id = names.length; id <= capacity; id++) nameOff[id] = at;
  const pool = new Uint8Array(at + 4);
  encoded.forEach((bytes, id) => pool.set(bytes, nameOff[id]));
  const column = <T extends { set(values: ArrayLike<number>): void }>(make: (rows: number) => T, rows: number[]): T => {
    const out = make(capacity);
    out.set(rows);
    return out;
  };
  const dir = Flag.Dir | Flag.HasChildArray;
  return {
    n: names.length,
    capacity,
    parent: column((r) => new Int32Array(r), [-1, 0, 0, 2, 2, 1, 1]),
    size: column((r) => new Float64Array(r), [0, 0, 0, 2 ** 53, 4, 1, 1]),
    mtime: column((r) => new Float64Array(r), [1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000]),
    flags: column((r) => new Uint16Array(r), [dir, dir, dir, 0, Flag.HardlinkDup, 0, 0]),
    ext: column((r) => new Uint16Array(r), [0, 0, 0, 1, 1, 1, 1]),
    container: new Uint8Array(capacity),
    cloudProv: new Uint8Array(capacity),
    nameOff,
    names: pool,
    namesLen: at,
    childStart: column((r) => new Uint32Array(r), [1, 5, 3, 7, 7, 7, 7]),
    childCnt: column((r) => new Uint32Array(r), [2, 2, 2, 0, 0, 0, 0]),
    extDict: ['', 'img'],
    extOverflowIds: new Uint32Array(0),
    extOverflowTexts: [],
    cloudCandidates: new Uint32Array([6, 4]),
    textCandidates: new Uint32Array(0),
    sparseTermIds: new Uint32Array([5, 3]),
    sparseTermBytes: new Float64Array([1, 2 ** 53]),
    counters: {
      dirs: 3, files: 4, hardlinkedFiles: 1, hardlinkedBytes: 4, cloudFiles: 0, cloudBytes: 0,
      sparseFiles: 2, sparseBytes: 2 ** 53 + 1, slackBytes: 0, deniedDirs: [], vanishedDirs: 0, unreadableDirs: 0,
    },
    stats: {
      dirsListed: 3, entries: 6, wallMs: 1, cpuSeconds: null, fastPath: 'bulk', workersPeak: 1, climbSteps: 0,
      deniedEntries: 0, unreadableEntries: 0, dataless: 0,
    },
  };
}

/** A store that counts the text candidates the adopt decides. */
class CountingStore extends PackedScanStore {
  extensionsSet = 0;
  override setExtension(id: number, extension: string | undefined): void {
    this.extensionsSet++;
    super.setExtension(id, extension);
  }
}

test('a cancel between two slices ends the adopt there: two slices done, nothing written, no completion', async () => {
  const slice = 6;
  const spec: TakenSpec = { folders: 3, filesPerFolder: slice * 2, denied: 2, textEvery: 1, cloudEvery: 0, seed: 11 };
  const run = async (cancelAtTurn: number): Promise<{ outcome: Awaited<ReturnType<typeof adoptNativeStoreInSlices>>; store: CountingStore; scan: ScanResult; untouched: string }> => {
    const scan = createScanRecord(ADOPT_ROOT);
    const store = new CountingStore(ADOPT_ROOT, '/', statToInput('r', true, 0, 1_000));
    const untouched = JSON.stringify(record(scan));
    let turns = 0;
    let cancelled = cancelAtTurn === 0;
    const outcome = await adoptNativeStoreInSlices(scan, store, syntheticTaken(spec), {
      sliceNodes: slice,
      yieldTurn: async () => { if (++turns === cancelAtTurn) cancelled = true; },
      isCancelled: () => cancelled,
    });
    return { outcome, store, scan, untouched };
  };
  const second = await run(2);
  assert.equal(second.outcome.completed, false, 'a cancel after the second slice: not completed');
  assert.equal(second.store.extensionsSet, 2 * slice, 'exactly two slices of text candidates were decided');
  assert.equal(JSON.stringify(record(second.scan)), second.untouched, 'and the record is as the walk left it');
  const before = await run(0);
  assert.equal(before.outcome.completed, false, 'a cancel before the first slice: not completed');
  assert.equal(before.store.extensionsSet, 0, 'and nothing decided');
  // 36 text candidates and 2 refused folders: seven slices, the last turn after the seventh.
  const last = await run(7);
  assert.equal(last.outcome.completed, false, 'a cancel in the turn after the last slice: still not completed');
  assert.equal(last.store.extensionsSet, 3 * 2 * slice, 'every slice ran');
  assert.equal(JSON.stringify(record(last.scan)), last.untouched, 'but the record was not written');
  const never = await run(-1);
  assert.equal(never.outcome.completed, true, 'no cancel: completed');
  assert.equal(never.store.extensionsSet, 3 * 2 * slice, 'every text candidate decided');
});

/* ------------------------------ runNativeWalk's memory path ------------------------------ */

/** The real module with `storeTake` reporting what it handed over. */
function watchTake(core: ScanModule, onTaken: (taken: NativeStore) => void): ScanModule {
  const module: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(core)) module[name] = (core as unknown as Record<string, unknown>)[name];
  const take = core.storeTake as (handle: number) => Promise<NativeStore>;
  module.storeTake = async (handle: number): Promise<NativeStore> => {
    const taken = await take(handle);
    onTaken(taken);
    return taken;
  };
  return module as unknown as ScanModule;
}

async function walkInto(module: ScanModule, root: string, storage: NativeStorage): Promise<Adopted> {
  const scan = createScanRecord(root);
  const st = fs.lstatSync(root);
  const store = new PackedScanStore(root, path.sep, statToInput(rootName(root), true, 0, st.mtimeMs, st.atimeMs));
  await runNativeWalk(scan, store, root, module, storage);
  return { scan, store };
}

/** The whole tree as the API would emit it, access times scrubbed; the budget is the rows, so even a broken store's prune ends. */
function treeJson(store: PackedScanStore): string {
  assertTreeShape(store, store.rootPath);
  return JSON.stringify(store.prune(store.rootId, { maxNodes: store.count + 1 }).root).replace(/"accessedAt":\d+/g, '"accessedAt":1');
}

test('real module: the memory path adopts in slices, as the columns path builds the tree, and a Stop between slices ends it with nothing written', async (t) => {
  const core = loadCore(t);
  if (!core) return;
  const { root, locked } = await buildEdgeFixture('treemap-native-completion-walk-');
  try {
    let items = -1;
    const module = watchTake(core, (taken) => {
      items = taken.textCandidates.length + taken.cloudCandidates.length + taken.counters.deniedDirs.length;
    });
    let yields = 0;
    setCompletionSlicesForTests({ sliceNodes: 1, yieldTurn: async () => { yields++; } });
    const memory = await walkInto(module, root, 'memory');
    setCompletionSlicesForTests(null);
    assert.ok(items >= 2, `the fixture holds names Node decides (${items} candidates and refused folders)`);
    assert.equal(yields, items, 'one turn per candidate, in slices of one');
    const columns = await walkInto(core, root, 'columns');
    assert.equal(treeJson(memory.store), treeJson(columns.store), 'the tree, byte for byte');
    assert.deepEqual(record(memory.scan), record(columns.scan), 'the record, field for field');

    let stopped: ScanResult | null = null;
    setCompletionSlicesForTests({
      sliceNodes: 1,
      yieldTurn: async () => { if (stopped) stopped.cancelled = true; },
    });
    const scan = createScanRecord(root);
    stopped = scan;
    const st = fs.lstatSync(root);
    const store = new PackedScanStore(root, path.sep, statToInput(rootName(root), true, 0, st.mtimeMs, st.atimeMs));
    await runNativeWalk(scan, store, root, core, 'memory');
    setCompletionSlicesForTests(null);
    assert.equal(scan.dirCount, 0, 'stopped after the first slice: no counts written');
    assert.equal(scan.fileCount, 0);
    assert.equal(scan.walkedDirs, undefined);
    assert.equal(scan.cpuSeconds, null, 'and no CPU noted: the completion did not complete');
  } finally {
    setCompletionSlicesForTests(null);
    await unlockAndRemove(root, locked);
  }
});

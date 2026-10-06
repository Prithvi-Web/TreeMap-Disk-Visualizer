import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

import { isolatedDataDir, fileTempDir } from './fixtures/dataDir';
isolatedDataDir('treemap-collectorSlices-data-');

import {
  COLLECTOR_SLICE_NODES,
  collectFileTypes,
  collectFileTypesAsync,
  collectLargestFiles,
  collectLargestFilesAsync,
  collectLargestFolders,
  collectLargestFoldersAsync,
  createScanRecord,
  eachFileInSlices,
} from '../src/services/diskScanner';
import { MAX_SLICE_ATTEMPTS, resetSlicedWalkCountsForTests, SliceOptions, slicedWalkCountsForTests } from '../src/services/slices';
import { buildStoreFromTree, ObjectScanStore, PackedScanStore, ScanStore } from '../src/services/scanStore';
import { FileNode } from '../src/models/types';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { buildPair, makeRng, mutateBoth } from './fixtures/storeFuzz';
import { oracleFileTypes, oracleLargestFiles, oracleLargestFolders } from './fixtures/collectorSlicesOracle';

/**
 * Track U, U-17: the dashboard's three lists — largest files, file types and
 * largest folders — walked in slices.
 *
 * After a 9M-entry scan the diagnosis measured the file-type list holding the
 * event loop for 1.8 s and the largest-folders list for 1.1 s, right after the
 * completion burst. Each collector is now a walk that can stop between any two
 * nodes; the sync form drains it (MCP, the agent summary and the report still
 * call it) and the async form runs it in slices of COLLECTOR_SLICE_NODES under
 * the same U-D9 driver as the cleanup suggestions (src/services/slices.ts).
 * The three routes answer from the async form.
 *
 * The answers are held to the pre-change collectors, copied verbatim as
 * tests/fixtures/collectorSlicesOracle.ts, on fuzz trees full of size ties,
 * with tombstones and nodes added after finalize, at every limit and minimum
 * the routes use. Turns, attempts and walks are counted; nothing is timed.
 */

const MIB = 1_048_576;
const LIMITS = [1, 10, 20, 500];
const MINIMUMS = [0, 1, MIB];
const immediate = (): Promise<void> => Promise.resolve();

/** A fuzz pair whose files share a handful of sizes, so the lists' ties decide their order. */
function tiedPair(seed: number, mutate: boolean): { obj: ObjectScanStore; packed: PackedScanStore } {
  const { obj, packed } = buildPair(seed, seed, 1_500);
  const rng = makeRng(seed * 7 + 1);
  const sizes = [0, 1, 2, 3, MIB, MIB, 2 * MIB];
  const ids: Array<[number, number]> = [];
  obj.eachNode(obj.rootId, (oId) => {
    if (!obj.isDir(oId)) ids.push([oId, packed.findByPath(obj.path(oId))]);
  });
  for (const [oId, pId] of ids) {
    const size = sizes[Math.floor(rng() * sizes.length)];
    obj.setSize(oId, size);
    packed.setSize(pId, size);
  }
  obj.sumSizes();
  packed.sumSizes();
  if (mutate) mutateBoth(obj, packed, rng);
  return { obj, packed };
}

/* ───────────────────────── the same answers, byte for byte ───────────────────────── */

test('the sliced and drained collectors give the pre-change answers on fuzz trees full of ties, at every limit and minimum', async () => {
  let ties = 0;
  for (let seed = 1; seed <= 14; seed++) {
    for (const mutate of [false, true]) {
      const pair = tiedPair(seed, mutate);
      for (const [kind, store] of [['object store', pair.obj], ['packed store', pair.packed]] as const) {
        const label = `seed ${seed}${mutate ? ', after watcher edits' : ''}, ${kind}`;
        const options = { sliceNodes: 7, yieldTurn: immediate };
        for (const limit of LIMITS) {
          for (const minSize of MINIMUMS) {
            const files = JSON.stringify(oracleLargestFiles(store, limit, minSize));
            assert.equal(JSON.stringify(collectLargestFiles(store, limit, minSize)), files, `${label}, largest ${limit} files ≥ ${minSize}: drained`);
            assert.equal(JSON.stringify(await collectLargestFilesAsync(store, limit, minSize, options)), files, `${label}, largest ${limit} files ≥ ${minSize}: sliced`);
            const folders = oracleLargestFolders(store, limit, minSize);
            ties += folders.filter((f, i) => i > 0 && f.size === folders[i - 1].size).length;
            assert.equal(JSON.stringify(collectLargestFolders(store, limit, minSize)), JSON.stringify(folders), `${label}, largest ${limit} folders ≥ ${minSize}: drained`);
            assert.equal(JSON.stringify(await collectLargestFoldersAsync(store, limit, minSize, options)), JSON.stringify(folders), `${label}, largest ${limit} folders ≥ ${minSize}: sliced`);
          }
        }
        const types = JSON.stringify(oracleFileTypes(store));
        assert.equal(JSON.stringify(collectFileTypes(store)), types, `${label}, file types: drained`);
        assert.equal(JSON.stringify(await collectFileTypesAsync(store, options)), types, `${label}, file types: sliced`);
      }
    }
  }
  assert.ok(ties > 100, `the fuzz trees put folders of equal size side by side (${ties} ties), so order among equals was tested`);
});

test('a container\'s listing, a file root and an empty root are walked as eachFile walks them', async () => {
  // Review of U-17, finding 2: no fuzz tree held these, so a walk that went
  // into a container's listing (whose entries are not files on disk) would
  // have stayed green.
  const root = path.join(path.sep, 'shapes');
  const file = (at: string, name: string, size: number): FileNode => ({ name, path: path.join(at, name), size, type: 'file', modifiedAt: 0, isHidden: false, extension: name.split('.').pop() });
  const zipAt = path.join(root, 'archive.zip');
  const listing: FileNode[] = [
    { ...file(zipAt, 'inner.bin', 9 * MIB), virtual: true },
    { name: 'sub', path: path.join(zipAt, 'sub'), type: 'dir', size: 8 * MIB, modifiedAt: 0, isHidden: false, virtual: true, children: [{ ...file(path.join(zipAt, 'sub'), 'deep.bin', 8 * MIB), virtual: true }] },
  ];
  const kids: FileNode[] = [
    { ...file(root, 'archive.zip', 2 * MIB), container: 'zip' },
    file(root, 'plain.dat', 3 * MIB),
    { name: 'empty', path: path.join(root, 'empty'), type: 'dir', size: 0, modifiedAt: 0, isHidden: false, children: [] },
  ];
  const tree: FileNode = { name: 'shapes', path: root, type: 'dir', size: 5 * MIB, modifiedAt: 0, isHidden: false, children: kids };
  const withListing = (store: ScanStore): ScanStore => {
    store.ingestSubtree(store.findByPath(zipAt), listing); // as a container expansion grafts it, after finalize
    return store;
  };
  const shapes: Array<[string, ScanStore]> = [
    ['an expanded container, object store', withListing(ObjectScanStore.wrap(structuredClone(tree)))],
    ['an expanded container, packed store', withListing(buildStoreFromTree(tree))],
    ['a file root, object store', ObjectScanStore.wrap(file(path.sep, 'solo.bin', 7))],
    ['a file root, packed store', buildStoreFromTree(file(path.sep, 'solo.bin', 7))],
    ['an empty root, packed store', buildStoreFromTree({ name: 'none', path: path.join(path.sep, 'none'), type: 'dir', size: 0, modifiedAt: 0, isHidden: false, children: [] })],
  ];
  for (const [what, store] of shapes) {
    const options = { sliceNodes: 2, yieldTurn: immediate };
    for (const [limit, minSize] of [[10, 0], [500, 1]] as const) {
      const files = JSON.stringify(oracleLargestFiles(store, limit, minSize));
      assert.equal(JSON.stringify(await collectLargestFilesAsync(store, limit, minSize, options)), files, `${what}: largest files, sliced`);
      assert.equal(JSON.stringify(collectLargestFiles(store, limit, minSize)), files, `${what}: largest files, drained`);
      const folders = JSON.stringify(oracleLargestFolders(store, limit, minSize));
      assert.equal(JSON.stringify(await collectLargestFoldersAsync(store, limit, minSize, options)), folders, `${what}: largest folders, sliced`);
      assert.equal(JSON.stringify(collectLargestFolders(store, limit, minSize)), folders, `${what}: largest folders, drained`);
    }
    assert.equal(JSON.stringify(await collectFileTypesAsync(store, { sliceNodes: 2, yieldTurn: immediate })), JSON.stringify(oracleFileTypes(store)), `${what}: file types`);
  }
  const expanded = shapes[1][1];
  const names = (await collectLargestFilesAsync(expanded, 10, 0)).map((f) => f.name);
  assert.deepEqual(names, ['plain.dat', 'archive.zip'], 'the listing\'s entries are not files on disk: the archive counts, its contents do not');
});

test('a sliced walk of the files visits them in the order eachFile does, tombstones and late additions included', async () => {
  for (let seed = 1; seed <= 10; seed++) {
    const pair = tiedPair(seed, true);
    for (const [kind, store] of [['object store', pair.obj], ['packed store', pair.packed]] as const) {
      const want: number[] = [];
      store.eachFile(store.rootId, (id) => { want.push(id); });
      let got: number[] = [];
      await eachFileInSlices(store, () => { got = []; return (id) => { got.push(id); }; }, { sliceNodes: 3, yieldTurn: immediate });
      assert.deepEqual(got, want, `seed ${seed}, ${kind}: the same files in the same order`);
    }
  }
});

/* ───────────────────────────── slices, counted ───────────────────────────── */

/** 50 folders of 1,000 files under one root. */
function wideStore(): ScanStore {
  const root = path.join(path.sep, 'wide');
  const kids: FileNode[] = [];
  for (let d = 0; d < 50; d++) {
    const at = path.join(root, `d${d}`);
    const files: FileNode[] = Array.from({ length: 1_000 }, (_, f) => ({
      name: `f${f}.dat`, path: path.join(at, `f${f}.dat`), size: 1 + ((d * 1_000 + f) % 97), type: 'file', modifiedAt: 0, isHidden: false, extension: 'dat',
    }));
    kids.push({ name: `d${d}`, path: at, type: 'dir', modifiedAt: 0, isHidden: false, size: files.reduce((s, c) => s + c.size, 0), children: files });
  }
  return buildStoreFromTree({ name: 'wide', path: root, type: 'dir', modifiedAt: 0, isHidden: false, size: kids.reduce((s, c) => s + c.size, 0), children: kids });
}

test('each collector hands the loop back once per slice, and a turn queued before it runs before it answers', async () => {
  assert.equal(COLLECTOR_SLICE_NODES, 16_384, 'the slice the cleanup walk uses too');
  const store = wideStore();
  // The file walk takes one step per node: the root, 50 folders, 50,000 files.
  // The folder walk takes one to enter each node and one to leave each folder:
  // 2 per file and 2 per folder, plus the root's leaving (its entry is the start).
  const cases: Array<[string, number, () => Promise<unknown>, (y: () => Promise<void>) => Promise<unknown>]> = [
    ['largest files', 1 + 50 + 50_000, () => Promise.resolve(oracleLargestFiles(store, 10, 1)), (yieldTurn) => collectLargestFilesAsync(store, 10, 1, { yieldTurn })],
    ['file types', 1 + 50 + 50_000, () => Promise.resolve(oracleFileTypes(store)), (yieldTurn) => collectFileTypesAsync(store, { yieldTurn })],
    ['largest folders', 50 * 2 + 50_000 * 2 + 1, () => Promise.resolve(oracleLargestFolders(store, 10, 1)), (yieldTurn) => collectLargestFoldersAsync(store, 10, 1, { yieldTurn })],
  ];
  for (const [what, steps, oracle, run] of cases) {
    let yields = 0;
    const order: string[] = [];
    setImmediate(() => order.push('probe'));
    const answer = await run(() => new Promise<void>((resolve) => { yields++; setImmediate(resolve); }));
    order.push('answered');
    assert.equal(yields, Math.ceil(steps / COLLECTOR_SLICE_NODES), `${what}: one turn per slice of ${COLLECTOR_SLICE_NODES} of its ${steps} steps`);
    assert.deepEqual(order, ['probe', 'answered'], `${what}: a turn queued before the walk ran before it answered`);
    assert.equal(JSON.stringify(answer), JSON.stringify(await oracle()), `${what}: and the answer is the old one`);
  }
});

/** Runs the largest-folders walk while `change` edits the store at the turns `on` picks. */
async function foldersWhileChanging(store: ScanStore, on: (turn: number) => boolean) {
  let turn = 0;
  const yieldsPerAttempt: number[] = [];
  const answer = await collectLargestFoldersAsync(store, 500, 0, {
    sliceNodes: 5,
    yieldTurn: async () => {
      turn++;
      yieldsPerAttempt[yieldsPerAttempt.length - 1]++;
      if (on(turn)) {
        // A folder's size, so the change shows in the answer.
        const folder = store.childIds(store.rootId).find((id) => store.isDir(id)) as number;
        store.setSize(folder, store.size(folder) + 1_000 * turn);
      }
    },
    onAttempt: () => { yieldsPerAttempt.push(0); },
  });
  return { answer, yieldsPerAttempt };
}

test('a store changed during a collector\'s walk is walked again, at most three times, the last in one turn', async () => {
  assert.equal(MAX_SLICE_ATTEMPTS, 3, 'U-D9');
  for (const [kind, make] of [['object store', (s: number) => tiedPair(s, false).obj], ['packed store', (s: number) => tiedPair(s, false).packed]] as const) {
    const once = make(3);
    const changed = await foldersWhileChanging(once, (turn) => turn === 1);
    assert.equal(changed.yieldsPerAttempt.length, 2, `${kind}: a change on the first turn started a second walk`);
    assert.equal(JSON.stringify(changed.answer), JSON.stringify(oracleLargestFolders(once, 500, 0)), `${kind}: whose answer is the changed store's`);

    const storm = make(4);
    const stormy = await foldersWhileChanging(storm, () => true);
    assert.deepEqual(stormy.yieldsPerAttempt, [1, 1, 0], `${kind}: a change on every turn: two walks give up, the third takes no turn`);
    assert.equal(JSON.stringify(stormy.answer), JSON.stringify(oracleLargestFolders(storm, 500, 0)), `${kind}: and answers for the final store`);

    // The file walks keep a tally: a walk started again must start it again too.
    for (const [what, run, oracle] of [
      ['file types', (s: ScanStore, o: SliceOptions) => collectFileTypesAsync(s, o), (s: ScanStore) => oracleFileTypes(s)],
      ['largest files', (s: ScanStore, o: SliceOptions) => collectLargestFilesAsync(s, 500, 0, o), (s: ScanStore) => oracleLargestFiles(s, 500, 0)],
    ] as const) {
      const store = make(5);
      let attempts = 0;
      let turn = 0;
      const answer = await run(store, {
        sliceNodes: 9,
        onAttempt: () => { attempts++; },
        yieldTurn: async () => {
          if (++turn !== 2) return;
          const file = store.childIds(store.rootId).find((id) => !store.isDir(id)) ?? store.rootId;
          store.setSize(file, store.size(file) + 7);
        },
      });
      assert.equal(attempts, 2, `${kind}, ${what}: a change on the second turn started a second walk`);
      assert.equal(JSON.stringify(answer), JSON.stringify(oracle(store)), `${kind}, ${what}: counted once, for the changed store`);
    }
  }
});

/* ───────────────────────────── the routes ───────────────────────────── */

function get(port: number, url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { buf += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf ? JSON.parse(buf) as Record<string, unknown> : {} }));
    }).on('error', reject);
  });
}

test('the three dashboard routes answer from the sliced walks, with the old answers', async () => {
  const pair = tiedPair(5, true);
  const root = fileTempDir('treemap-collectorSlices-root-');
  const scan = createScanRecord(root);
  scan.store = pair.packed;
  scan.status = 'complete';
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    resetSlicedWalkCountsForTests();
    const files = await get(port, `/api/large-files?scanId=${scan.scanId}&limit=10&minSize=1`);
    const types = await get(port, `/api/file-types?scanId=${scan.scanId}`);
    const folders = await get(port, `/api/large-folders?scanId=${scan.scanId}&limit=10`);
    assert.equal(files.status, 200, JSON.stringify(files.body));
    assert.equal(JSON.stringify(files.body.files), JSON.stringify(oracleLargestFiles(pair.packed, 10, 1)), 'largest files as before');
    assert.equal(JSON.stringify(types.body.types), JSON.stringify(oracleFileTypes(pair.packed)), 'file types as before');
    assert.equal(JSON.stringify(folders.body.folders), JSON.stringify(oracleLargestFolders(pair.packed, 10, 1_000_000)), 'largest folders as before (the route\'s 1 MB default)');
    assert.equal(slicedWalkCountsForTests().walks, 3, 'each list came from a sliced walk');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('the routes\' default floor is 1 MB in the decimal units every size is printed in: 1,000,000 bytes (QA D09)', async () => {
  // The Dashboard asks for the largest folders with no minSize and, when none
  // is over the floor, says "No folders above 1 MB found." — so the floor is
  // the 1 MB that sentence and every printed size mean.
  const root = fileTempDir('treemap-collectorSlices-floor-');
  const file = (dir: string, name: string, size: number): FileNode =>
    ({ name, path: path.join(dir, name), type: 'file', size, modifiedAt: 0, isHidden: false, extension: 'bin' });
  const dir = (name: string, kids: FileNode[]): FileNode => ({
    name, path: path.join(root, name), type: 'dir', modifiedAt: 0, isHidden: false,
    size: kids.reduce((s, k) => s + k.size, 0), children: kids,
  });
  const one = dir('one', [file(path.join(root, 'one'), 'exactly.bin', 1_000_000)]);
  const under = dir('under', [file(path.join(root, 'under'), 'short.bin', 999_999)]);
  const scan = createScanRecord(root);
  scan.store = buildStoreFromTree({ name: path.basename(root), path: root, type: 'dir', modifiedAt: 0, isHidden: false, size: one.size + under.size, children: [one, under] });
  scan.status = 'complete';
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const files = await get(port, `/api/large-files?scanId=${scan.scanId}&limit=10`);
    const folders = await get(port, `/api/large-folders?scanId=${scan.scanId}&limit=10`);
    assert.deepEqual((files.body.files as { name: string }[]).map((f) => f.name), ['exactly.bin'], 'a 1,000,000-byte file is 1 MB, and 999,999 bytes are not');
    assert.deepEqual((folders.body.folders as { name: string }[]).map((f) => f.name), ['one'], 'and so for folders');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

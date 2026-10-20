import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Isolate every cache/snapshot write from the user's real app data, before the app's code loads.
// Scans in this suite would otherwise land in the real snapshots.json.
import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-inc-test-');

import { startScan, getScan, mtimesMatch, listingSettled, SETTLED_LISTING_MS } from '../src/services/diskScanner';
import { updateSettings } from '../src/services/settings';
import { FileNode, ScanResult } from '../src/models/types';
import { settled, pending } from '../src/utils/backgroundWrites';
import { HANG_GUARD_MS, waitFor } from './fixtures/waitFor';
import { ageFolders } from './fixtures/folderTimes';

/**
 * Fast (incremental) rescan correctness. The original substitution reused an
 * ENTIRE cached subtree whenever a directory's own mtime matched — but a
 * directory's mtime only reflects its DIRECT entries and never propagates
 * upward, so a brand-new file deep in an unchanged-ancestor chain was
 * invisible to fast rescans. The fix reuses only the directory's own listing
 * and revalidates every subdirectory with one fresh lstat. These tests pin:
 *
 *  - deep creates and deletes are seen (the bug),
 *  - unchanged listings are still reused (the speed),
 *  - in-place file edits stay unseen (the documented trade-off),
 *  - second-precision caches written by gdu scans still match (the tolerance),
 *  - a listing read moments after its folder last changed is never reused: a
 *    change in the same tick of the clock keeps the time the cache holds
 *    (git's racily clean entries; CI run 38519159263).
 *
 * Every tree is made with its folder times an hour old (`ageFolders`), so the
 * cache vouches for its listings; the tests of the racy rule set the one
 * folder time they are about.
 */

/** diskScanner's cacheFileName under "Stay on this drive": format 3 since BQL item 8 (2 since U-4c L2). */
function cacheFileFor(rootPath: string): string {
  const h = crypto.createHash('sha1').update(rootPath).digest('hex').slice(0, 16);
  return path.join(process.env.TREEMAP_DATA_DIR!, `mtime-cache-v3-${h}.json`);
}

/**
 * A scan is done when its record leaves 'running'. The wait is a hang guard,
 * not a measurement: with ten busy loops on this Mac's eight cores, four of
 * these four-file scans outlasted the 10 s deadline this used to have.
 */
async function settle(scanId: string): Promise<ScanResult> {
  await waitFor(() => {
    const s = getScan(scanId);
    assert.ok(s, 'scan record must exist');
    return s.status !== 'running';
  }, `scan ${scanId} settling`, 25);
  return getScan(scanId)!;
}

/**
 * The mtime cache and the snapshot are written fire-and-forget once a scan
 * settles, each registered with backgroundWrites — so this awaits the writes
 * themselves. A write that never finishes fails here, named, instead of
 * hanging the run.
 */
async function writesSettled(): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`background writes did not settle within ${HANG_GUARD_MS} ms; still running: ${pending().join(', ') || '(none)'}`)),
      HANG_GUARD_MS,
    );
  });
  try {
    await Promise.race([settled(), hung]);
  } finally {
    clearTimeout(timer);
  }
}

/** The mtime cache is written fire-and-forget after completion — wait for it. */
async function waitForCache(rootPath: string): Promise<void> {
  await writesSettled();
  const file = cacheFileFor(rootPath);
  assert.ok(fs.existsSync(file), `cache file never appeared: ${file}`);
}

async function scanOnce(root: string, incremental: boolean): Promise<ScanResult> {
  // No gdu. The FIRST scan runs on whichever engine Automatic picks — the
  // native engine wherever its module loads — and the fast rescan runs on the
  // walker, reading the mtime cache the first scan wrote: the cross-engine
  // path. (This comment used to say "the walker on every machine"; written
  // before the native engine existed, it stopped being true, and on Windows
  // this very path exposed the native listing's lazily updated directory
  // times — see DirTimes in tm-walk.) The rescan asks for the walker by the
  // setting: where the native engine can run, Automatic walks natively and
  // does not read the cache (QA D45, tests/fastRescanEngine.test.ts).
  process.env.TREEMAP_NO_GDU = '1';
  try {
    await updateSettings({ engine: incremental ? 'walker' : 'auto' });
    const started = await startScan(root, { incremental });
    return await settle(started.scanId);
  } finally {
    delete process.env.TREEMAP_NO_GDU;
  }
}

/** root/a/b/c with one file at each level, every folder's time an hour old. */
async function makeTree(tag: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `treemap-${tag}-`));
  await fsp.mkdir(path.join(root, 'a', 'b', 'c'), { recursive: true });
  await fsp.writeFile(path.join(root, 'top.txt'), 'top level\n');
  await fsp.writeFile(path.join(root, 'a', 'in-a.txt'), 'level a\n');
  await fsp.writeFile(path.join(root, 'a', 'b', 'keep.txt'), 'level b\n');
  await fsp.writeFile(path.join(root, 'a', 'b', 'c', 'deep.txt'), 'level c\n');
  ageFolders(root);
  return root;
}

function findNode(root: FileNode, name: string): FileNode | undefined {
  if (root.name === name) return root;
  for (const c of root.children ?? []) {
    const hit = findNode(c, name);
    if (hit) return hit;
  }
  return undefined;
}

test('mtimesMatch: exact ms, and second-tolerance only for second-aligned cache values', () => {
  assert.equal(mtimesMatch(1_784_659_466_860, 1_784_659_466_860), true); // exact
  assert.equal(mtimesMatch(1_784_659_466_860, 1_784_659_466_861), false); // off by 1ms
  assert.equal(mtimesMatch(1_784_659_466_000, 1_784_659_466_860), true); // gdu cache, same second
  assert.equal(mtimesMatch(1_784_659_466_000, 1_784_659_467_001), false); // gdu cache, next second
  assert.equal(mtimesMatch(1_784_659_466_500, 1_784_659_466_900), false); // ms cache never gets tolerance
});

test('the cache vouches for a folder\'s listing only when the folder last changed strictly before its scan began, by SETTLED_LISTING_MS — a margin wider than a whole-second time and FAT\'s two-second one together', () => {
  const start = 1_784_659_466_860;
  const at = (t: number): boolean => listingSettled(t, start);
  assert.deepEqual(
    {
      'an hour before': at(start - 3_600_000),
      'just past the margin': at(start - SETTLED_LISTING_MS - 1),
      'on the margin': at(start - SETTLED_LISTING_MS),
      'a millisecond before the start': at(start - 1),
      'at the start': at(start),
      'after it (a time ahead of the clock)': at(start + 1_000),
      'no time at all': at(Number.NaN),
    },
    {
      'an hour before': true,
      'just past the margin': true,
      'on the margin': false,
      'a millisecond before the start': false,
      'at the start': false,
      'after it (a time ahead of the clock)': false,
      'no time at all': false,
    },
  );
  // mtimesMatch lets a whole-second cache time stand for the second after it, and FAT keeps a time to
  // two seconds: a change that keeps the cached time lands within both of the time before it.
  assert.ok(SETTLED_LISTING_MS > 1_000 + 2_000, `the margin (${SETTLED_LISTING_MS} ms) covers them`);
});

test('the cache marks as not to be reused exactly the folders whose time is not settled by the moment their scan BEGAN — one changed while it ran included — and never a file', async () => {
  const { saveMtimeCache } = await import('../src/services/diskScanner');
  const { PackedScanStore } = await import('../src/services/scanStore');
  // Never created on disk: the tree lives in the store alone.
  const rootPath = path.join(os.tmpdir(), 'treemap-cache-settled');
  const START = 1_784_659_466_860;
  const HOUR = 3_600_000;
  const store = new PackedScanStore(rootPath, path.sep, { name: path.basename(rootPath), isDir: true, size: 0, modifiedAt: START - HOUR, isHidden: false });
  const add = (name: string, isDir: boolean, modifiedAt: number): number =>
    store.addNode(store.rootId, { name, isDir, size: 0, modifiedAt, isHidden: false, ...(isDir ? {} : { extension: 'bin' }) });
  add('an hour before', true, START - HOUR);
  add('a moment before', true, START - 1);
  add('while it ran', true, START + 1_000); // after the scan began, well before it ended
  add('a file changed while it ran.bin', false, START + 1_000);
  store.finalize();
  store.sumSizes();
  await saveMtimeCache({ rootPath, scanned: 5, startedAt: START, finishedAt: START + 10_000, store } as unknown as ScanResult);
  type Cached = FileNode & { unlisted?: true };
  const cached = JSON.parse(await fsp.readFile(cacheFileFor(rootPath), 'utf8')) as Cached;
  const marked = Object.fromEntries([cached, ...(cached.children ?? [])].map((n: Cached) => [n === cached ? '(the root)' : n.name, n.unlisted === true]));
  assert.deepEqual(marked, {
    '(the root)': false,
    'an hour before': false,
    'a moment before': true,
    'while it ran': true,
    'a file changed while it ran.bin': false,
  });
});

test('a brand-new file deep in an unchanged-ancestor chain IS found by a fast rescan', async () => {
  const root = await makeTree('deep-create');
  try {
    const first = await scanOnce(root, false);
    assert.equal(first.status, 'complete');
    assert.equal(first.fileCount, 4);
    await waitForCache(root);

    // Only c's mtime changes; root, a and b stay byte-identical.
    await fsp.writeFile(path.join(root, 'a', 'b', 'c', 'brand-new.txt'), 'the old code never saw me\n');

    const second = await scanOnce(root, true);
    assert.equal(second.status, 'complete');
    assert.equal(second.incremental, true, 'cache must have been loaded');
    assert.ok(findNode(second.root!, 'brand-new.txt'), 'deep new file must appear');
    assert.equal(second.fileCount, 5);
    // The unchanged ancestors were reused, not re-listed…
    assert.ok((second.cachedDirs ?? 0) >= 3, `root/a/b should be reused, cachedDirs=${second.cachedDirs}`);
    // …and only the changed directory was walked.
    assert.equal(second.walkedDirs, 1, 'exactly c should be re-listed');
    // Sizes stay exact: the new bytes must be included in the root total.
    assert.ok(second.root!.size > first.root!.size, 'root size must grow by the new file');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a deep deletion is seen too', async () => {
  const root = await makeTree('deep-delete');
  try {
    await scanOnce(root, false);
    await waitForCache(root);
    await fsp.rm(path.join(root, 'a', 'b', 'c', 'deep.txt'));

    const second = await scanOnce(root, true);
    assert.equal(findNode(second.root!, 'deep.txt'), undefined, 'deleted file must vanish');
    assert.equal(second.fileCount, 3);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a deletion that leaves its folder the time the cache holds is seen when the scan listed that folder moments after it last changed — a change in the same tick of the clock (CI run 38519159263: a whole second, as 1 in 1,000 times fall)', async () => {
  // The cached time of c, and the time the delete leaves it — set, not waited for. Each first time is
  // ahead of the clock, so it is never older than the scan's start however soon the scan starts.
  const ahead = (Math.floor(Date.now() / 1000) + 60) * 1000;
  const cases: Record<string, [cached: number, afterDelete: number]> = {
    // gdu and FAT keep whole seconds, and mtimesMatch lets a whole-second cached time stand for the
    // second after it — which a scan reads too, for 1 time in 1,000 (the CI run's 1791957605000).
    'a whole second, then a later moment of that second': [ahead, ahead + 500],
    // A kernel that stamps times from a coarse clock gives two changes a few ms apart one time.
    'the very millisecond': [ahead + 321, ahead + 321],
  };
  const seen: Record<string, { 'deep.txt listed': boolean; 'folders listed afresh': number | undefined }> = {};
  const expected: typeof seen = {};
  for (const [what, [cached, afterDelete]] of Object.entries(cases)) {
    const root = await makeTree('same-tick');
    const c = path.join(root, 'a', 'b', 'c');
    try {
      fs.utimesSync(c, new Date(cached), new Date(cached));
      const first = await scanOnce(root, false);
      assert.equal(first.status, 'complete');
      assert.equal(findNode(first.root!, 'c')!.modifiedAt, cached, 'the scan read the time set');
      await waitForCache(root);
      await fsp.rm(path.join(c, 'deep.txt'));
      fs.utimesSync(c, new Date(afterDelete), new Date(afterDelete));

      const second = await scanOnce(root, true);
      assert.equal(second.incremental, true, 'the cache was read');
      seen[what] = { 'deep.txt listed': findNode(second.root!, 'deep.txt') !== undefined, 'folders listed afresh': second.walkedDirs };
      // root, a and b changed an hour ago: their listings are reused, and only c is read again.
      expected[what] = { 'deep.txt listed': false, 'folders listed afresh': 1 };
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }
  assert.deepEqual(seen, expected);
});

test('in-place edits stay unseen — the documented trade-off that makes fast rescan opt-in', async () => {
  const root = await makeTree('in-place');
  try {
    const first = await scanOnce(root, false);
    const before = findNode(first.root!, 'keep.txt')!.size;
    await waitForCache(root);

    // Appending changes keep.txt's size but not b's mtime — by design the
    // fast rescan reuses b's cached listing and never re-stats the file.
    await fsp.appendFile(path.join(root, 'a', 'b', 'keep.txt'), 'appended bytes the fast rescan ignores\n');

    const second = await scanOnce(root, true);
    assert.equal(findNode(second.root!, 'keep.txt')!.size, before, 'stale size is the accepted trade-off');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a second-precision cache (as written after a gdu scan) still gets full reuse', async () => {
  const root = await makeTree('gdu-precision');
  try {
    await scanOnce(root, false);
    await waitForCache(root);

    // Simulate a gdu-written cache: every mtime truncated to whole seconds.
    const file = cacheFileFor(root);
    const truncate = (n: FileNode): void => {
      n.modifiedAt = Math.floor(n.modifiedAt / 1000) * 1000;
      for (const c of n.children ?? []) truncate(c);
    };
    const cached = JSON.parse(await fsp.readFile(file, 'utf8')) as FileNode;
    truncate(cached);
    await fsp.writeFile(file, JSON.stringify(cached), 'utf8');

    const second = await scanOnce(root, true);
    assert.equal(second.incremental, true);
    assert.equal(second.walkedDirs, 0, 'nothing changed — nothing should be re-listed');
    assert.ok((second.cachedDirs ?? 0) >= 4, `all four dirs should be reused, cachedDirs=${second.cachedDirs}`);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('revalidated directories refresh their own mtime and atime from the disk', async () => {
  const root = await makeTree('atime-refresh');
  try {
    await scanOnce(root, false);
    await waitForCache(root);
    const second = await scanOnce(root, true);
    const b = findNode(second.root!, 'b')!;
    // b was reached through a's cached listing, so its stats came from the
    // revalidation lstat — the walker records atime, so it must be present.
    assert.ok(b.accessedAt !== undefined, 'revalidated dir should carry a fresh accessedAt');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('the fast-rescan cache is the finished tree, byte for byte', async () => {
  const root = await makeTree('cache-bytes');
  try {
    const scan = await scanOnce(root, false);
    assert.equal(scan.status, 'complete');
    await writesSettled();
    assert.equal(await fsp.readFile(cacheFileFor(root), 'utf8'), JSON.stringify(scan.root));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('finishing a scan never builds the whole tree as objects', async () => {
  // Building `scan.root` for this cache froze the app for ~70 ms as a
  // 200,000-entry scan completed, before anything could see that it had, and
  // stringifying it for another ~80 ms (M3, 23 Sep 2026). The cache is now
  // streamed from the store, so no whole-tree prune runs between a scan's
  // last entry and its cache landing on disk.
  const { PackedScanStore } = await import('../src/services/scanStore');
  const root = await makeTree('no-materialize');
  const proto = PackedScanStore.prototype;
  const prune = proto.prune;
  let unbounded = 0;
  proto.prune = function (this: InstanceType<typeof PackedScanStore>, id: number, opts: { maxNodes: number }) {
    if (opts.maxNodes >= Number.MAX_SAFE_INTEGER) unbounded++;
    return prune.call(this, id, opts);
  };
  try {
    const scan = await scanOnce(root, false);
    assert.equal(scan.status, 'complete');
    await writesSettled();
    assert.ok(fs.existsSync(cacheFileFor(root)), 'the cache is still written');
    assert.equal(unbounded, 0, 'no whole-tree prune ran between the scan and its cache');
  } finally {
    proto.prune = prune;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/** A long name, so a few thousand files make a cache of several chunks. */
const LONG = 'long-name-'.repeat(10);

/**
 * An in-memory tree of `files` files under root/d, in a store whose listings
 * call `onListing` — the hook the retry tests use to change the tree while a
 * chunk of its cache is being written, the one moment anything else can run.
 */
async function storeWithHook(rootPath: string, files: number, onListing: (store: InstanceType<typeof import('../src/services/scanStore').PackedScanStore>, id: number) => void) {
  const { PackedScanStore } = await import('../src/services/scanStore');
  class Hooked extends PackedScanStore {
    override childIds(id: number): number[] {
      onListing(this, id);
      return super.childIds(id);
    }
  }
  const store = new Hooked(rootPath, path.sep, { name: path.basename(rootPath), isDir: true, size: 0, modifiedAt: 1, isHidden: false });
  const dir = store.addNode(store.rootId, { name: 'd', isDir: true, size: 0, modifiedAt: 2, isHidden: false });
  for (let i = 0; i < files; i++) {
    store.addNode(dir, { name: `${LONG}${i}.bin`, isDir: false, size: i, modifiedAt: 3, isHidden: false, extension: 'bin' });
  }
  store.finalize();
  store.sumSizes();
  return { store, victim: store.findByPath(path.join(rootPath, 'd', `${LONG}0.bin`)) };
}

test('a tree that changes while its cache is being written is written again, whole', async () => {
  const { saveMtimeCache } = await import('../src/services/diskScanner');
  const { TREE_JSON_CHUNK_CHARS } = await import('../src/services/scanStoreJson');
  // Never created on disk: the tree lives in the store alone.
  const rootPath = path.join(os.tmpdir(), 'treemap-cache-retry-once');
  let armed = false;
  let victim = -1;
  const { store, victim: v } = await storeWithHook(rootPath, 3000, (s) => {
    if (!armed) return;
    armed = false;
    // Lands while the first attempt's first chunk is being written, as a delete would.
    setImmediate(() => s.setSize(victim, 12_345));
  });
  victim = v;
  assert.notEqual(victim, -1);
  armed = true;
  await saveMtimeCache({ rootPath, scanned: 3002, startedAt: Date.now(), store } as unknown as ScanResult);
  assert.equal(armed, false, 'the change was scheduled');
  assert.equal(store.size(victim), 12_345, 'and it landed');
  const written = await fsp.readFile(cacheFileFor(rootPath), 'utf8');
  assert.ok(written.length > 2 * TREE_JSON_CHUNK_CHARS, 'the first attempt needed several chunks');
  assert.equal(written, JSON.stringify(store.prune(store.rootId, { maxNodes: Number.MAX_SAFE_INTEGER }).root),
    'the cache is the tree after the change, never half of each');
});

test('a tree that never stops changing keeps the previous cache, and says why', async () => {
  const { saveMtimeCache } = await import('../src/services/diskScanner');
  const rootPath = path.join(os.tmpdir(), 'treemap-cache-retry-never');
  let victim = -1;
  const { store, victim: v } = await storeWithHook(rootPath, 3000, (s, id) => {
    // Every attempt lists the root first: every attempt sees a change.
    if (id === s.rootId && victim !== -1) setImmediate(() => s.setSize(victim, s.size(victim) + 1));
  });
  victim = v;
  const file = cacheFileFor(rootPath);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, 'the previous cache');
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    await saveMtimeCache({ rootPath, scanned: 3002, startedAt: Date.now(), store } as unknown as ScanResult);
  } finally {
    console.warn = warn;
  }
  assert.equal(await fsp.readFile(file, 'utf8'), 'the previous cache');
  // Its temp file is named for the process that writes it (FG3g review F2.5): any beside it counts.
  const temps = fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(`${path.basename(file)}.`) && n.endsWith('.tmp'));
  assert.deepEqual(temps, [], 'no half-written file is left');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /changed while it was being written, 3 times/);
});

/** The fast-rescan cache file of `rootPath` the last scan left in app-data, whatever its format number. */
function cacheOnDisk(rootPath: string): string {
  const h = crypto.createHash('sha1').update(rootPath).digest('hex').slice(0, 16);
  const found = fs.readdirSync(process.env.TREEMAP_DATA_DIR!).filter((n) => new RegExp(`^mtime-cache-v\\d+-${h}\\.json$`).test(n));
  assert.equal(found.length, 1, `one cache of the folder: ${found.join(', ')}`);
  return path.join(process.env.TREEMAP_DATA_DIR!, found[0]);
}

test('a fast-rescan cache an earlier build saved (format 2) is never read: a name it wrote without its leading byte-order mark does not come back as the file beside it, and the old file leaves app-data (BQL item 8)', async () => {
  // Builds before 134674f6 (5–18 Oct 2026) read a stored name through a decoder that
  // dropped a leading U+FEFF, and wrote their cache from it: the 900-byte "\uFEFFfoo"
  // went in as "foo" at <root>/foo, the 5-byte file beside it. A walker fast rescan
  // reused that listing as written, so the 900-byte row was spelled as the 5-byte
  // file's path, and a Trash or offload of it acted on the wrong file.
  const BOM = '\uFEFF';
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-bom-cache-'));
  try {
    await fsp.writeFile(path.join(root, 'foo'), Buffer.alloc(5, 1));
    await fsp.writeFile(path.join(root, `${BOM}foo`), Buffer.alloc(900, 2));
    ageFolders(root);
    const first = await scanOnce(root, false);
    assert.equal(first.status, 'complete');
    await writesSettled();
    const h = crypto.createHash('sha1').update(first.rootPath).digest('hex').slice(0, 16);
    const written = cacheOnDisk(first.rootPath);
    // The same folder as such a build cached it, under the name it used: the
    // 900-byte file's name without its mark, at the 5-byte file's path.
    const tree = JSON.parse(fs.readFileSync(written, 'utf8')) as FileNode;
    let restyled = 0;
    for (const child of tree.children ?? []) {
      if (child.size !== 900) continue;
      child.name = 'foo';
      child.path = path.join(path.dirname(child.path), 'foo');
      restyled++;
    }
    assert.equal(restyled, 1, 'control: the 900-byte file is in the cache, and the stale copy names it as the file beside it');
    const v2 = path.join(process.env.TREEMAP_DATA_DIR!, `mtime-cache-v2-${h}.json`);
    fs.writeFileSync(v2, JSON.stringify(tree));
    if (written !== v2) fs.unlinkSync(written);

    const second = await scanOnce(root, true);
    assert.equal(second.status, 'complete');
    assert.equal(second.cachedDirs, 0, 'no listing came from the old cache');
    assert.equal(second.incremental, false, 'and the answer says no saved listing was read');
    const store = second.store!;
    // The paths an action is sent with: each finds its own file.
    const found = ['foo', `${BOM}foo`].map((name) => store.findByPath(path.join(second.rootPath, name)));
    assert.deepEqual(found.map((id) => (id === -1 ? null : store.size(id))), [5, 900], '<root>/foo is the 5-byte file and <root>/\\uFEFFfoo the 900-byte one');
    const kids = store.childIds(store.rootId).map((id) => [store.name(id), store.size(id)] as const).sort((a, b) => a[1] - b[1]);
    assert.deepEqual(kids, [['foo', 5], [`${BOM}foo`, 900]], 'each name as it is on disk, with its own size');
    await writesSettled();
    assert.equal(fs.existsSync(v2), false, 'the old cache left app-data');
    assert.equal(path.basename(cacheOnDisk(second.rootPath)), `mtime-cache-v3-${h}.json`, 'and the rescan saved one of the current format');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

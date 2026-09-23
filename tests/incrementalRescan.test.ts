import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startScan, getScan, mtimesMatch } from '../src/services/diskScanner';
import { FileNode, ScanResult } from '../src/models/types';

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
 *  - second-precision caches written by gdu scans still match (the tolerance).
 */

// Isolate every cache/snapshot write from the user's real app data. Scans in
// this suite would otherwise land in the real snapshots.json.
process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-inc-test-'));

function cacheFileFor(rootPath: string): string {
  const h = crypto.createHash('sha1').update(rootPath).digest('hex').slice(0, 16);
  return path.join(process.env.TREEMAP_DATA_DIR!, `mtime-cache-${h}.json`);
}

async function settle(scanId: string): Promise<ScanResult> {
  const t0 = Date.now();
  for (;;) {
    const s = getScan(scanId);
    assert.ok(s, 'scan record must exist');
    if (s.status !== 'running') return s;
    assert.ok(Date.now() - t0 < 10_000, 'scan timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The mtime cache is written fire-and-forget after completion — wait for it. */
async function waitForCache(rootPath: string): Promise<void> {
  const file = cacheFileFor(rootPath);
  const t0 = Date.now();
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() - t0 < 5_000, `cache file never appeared: ${file}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function scanOnce(root: string, incremental: boolean): Promise<ScanResult> {
  // No gdu. The FIRST scan runs on whichever engine Automatic picks — the
  // native engine wherever its module loads — and a fast rescan always runs
  // on the walker (P3-4), reading the mtime cache the first scan wrote: the
  // cross-engine path every user takes. (This comment used to say "the
  // walker on every machine"; written before the native engine existed, it
  // stopped being true, and on Windows this very path exposed the native
  // listing's lazily updated directory times — see DirTimes in tm-walk.)
  process.env.TREEMAP_NO_GDU = '1';
  try {
    const started = await startScan(root, { incremental });
    return await settle(started.scanId);
  } finally {
    delete process.env.TREEMAP_NO_GDU;
  }
}

/** root/a/b/c with one file at each level. */
async function makeTree(tag: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `treemap-${tag}-`));
  await fsp.mkdir(path.join(root, 'a', 'b', 'c'), { recursive: true });
  await fsp.writeFile(path.join(root, 'top.txt'), 'top level\n');
  await fsp.writeFile(path.join(root, 'a', 'in-a.txt'), 'level a\n');
  await fsp.writeFile(path.join(root, 'a', 'b', 'keep.txt'), 'level b\n');
  await fsp.writeFile(path.join(root, 'a', 'b', 'c', 'deep.txt'), 'level c\n');
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
  const { settled } = await import('../src/utils/backgroundWrites');
  const root = await makeTree('cache-bytes');
  try {
    const scan = await scanOnce(root, false);
    assert.equal(scan.status, 'complete');
    await settled();
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
  const { settled } = await import('../src/utils/backgroundWrites');
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
    await settled();
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
  await saveMtimeCache({ rootPath, scanned: 3002, store } as unknown as ScanResult);
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
    await saveMtimeCache({ rootPath, scanned: 3002, store } as unknown as ScanResult);
  } finally {
    console.warn = warn;
  }
  assert.equal(await fsp.readFile(file, 'utf8'), 'the previous cache');
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'no half-written file is left');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /changed while it was being written, 3 times/);
});

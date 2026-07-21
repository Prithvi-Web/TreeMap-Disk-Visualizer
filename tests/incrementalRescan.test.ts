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
  process.env.TREEMAP_NO_GDU = '1'; // deterministic walker on every machine
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

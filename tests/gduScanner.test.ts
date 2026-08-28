import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findGduBinary, runGdu, gduScan } from '../src/services/gduScanner';
import { startScan, getScan, createScanRecord } from '../src/services/diskScanner';
import { FileNode, ScanResult } from '../src/models/types';

/**
 * The gdu engine is strictly best-effort: every failure mode here must end in
 * the walker producing a normal scan, never in a scan error the user sees.
 */

function countNodes(n: FileNode): number {
  let c = 1;
  for (const k of n.children ?? []) c += countNodes(k);
  return c;
}

/**
 * Wait for a scan to finish — with a deadline.
 *
 * `node:test` has no default per-test timeout, so an unbounded poll does not
 * fail when a scan never settles: it HANGS THE WHOLE JOB, and CI reports
 * nothing at all rather than a failing test. `incrementalRescan.test.ts`
 * already does this correctly; this is the same loop.
 */
async function settle(scanId: string): Promise<ScanResult> {
  const t0 = Date.now();
  for (;;) {
    const s = getScan(scanId);
    assert.ok(s, 'scan record must exist');
    if (s.status !== 'running') return s;
    assert.ok(Date.now() - t0 < 30_000, `scan ${scanId} never settled — timed out after 30s`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A tree with a hard link, a symlink, a nested dir and an empty dir. */
async function makeTree(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gdu-test-'));
  await fsp.mkdir(path.join(dir, 'sub', 'deep'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'empty'));
  await fsp.writeFile(path.join(dir, 'sub', 'big.bin'), Buffer.alloc(50_000, 1));
  await fsp.writeFile(path.join(dir, 'sub', 'deep', 'small.txt'), 'hello');
  await fsp.writeFile(path.join(dir, 'top.bin'), Buffer.alloc(1_234, 2));
  await fsp.link(path.join(dir, 'sub', 'big.bin'), path.join(dir, 'hard.bin'));
  await fsp.symlink('top.bin', path.join(dir, 'link.bin'));
  return dir;
}

test('findGduBinary returns null rather than throwing when nothing is installed', async () => {
  const found = await findGduBinary({ bundledPath: '/nonexistent/gdu', pathLookup: false });
  assert.equal(found, null);
});

test('runGdu rejects a non-zero exit instead of returning a partial tree', async () => {
  await assert.rejects(
    () => runGdu('/bin/false', os.tmpdir(), path.join(os.tmpdir(), 'never.json')),
    /gdu failed/i,
  );
});

test('runGdu rejects a missing binary instead of throwing synchronously', async () => {
  await assert.rejects(
    () => runGdu('/nonexistent/gdu', os.tmpdir(), path.join(os.tmpdir(), 'never.json')),
    /gdu failed/i,
  );
});

test('a scan completes via the walker when gdu is disabled', async () => {
  const dir = await makeTree();
  process.env.TREEMAP_NO_GDU = '1';
  try {
    const started = await startScan(dir, { incremental: false });
    const s = await settle(started.scanId);
    assert.equal(s.status, 'complete');
    assert.ok(s.engine === 'walker' || s.engine === 'turbo-walker', `engine was ${s.engine}`);
    assert.ok(s.root);
  } finally {
    delete process.env.TREEMAP_NO_GDU;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/**
 * The load-bearing test. gdu and the walker must agree EXACTLY.
 *
 * The integration prompt asserted gdu exposes no inode and that hardlink dedup
 * would therefore have to be "explicitly dropped or degraded". That is false:
 * gdu emits `ino` + `hlnkc` (only when nlink > 1), and deduping on them
 * reproduced the walker's total byte-for-byte on /Applications
 * (30,070,595,907 both ways; 21,499 hard links both ways). Naive counting runs
 * 1.972% high. This test is what keeps that honest, instead of a UI caption
 * apologising for a wrong number.
 */
test('gdu and the walker report identical bytes and hardlinks on the same tree', async (t) => {
  const bin = await findGduBinary();
  if (!bin) return t.skip('gdu not available on this machine');

  const dir = await makeTree();
  try {
    const scan = createScanRecord(dir);
    const gduRoot = await gduScan(scan, bin, () => undefined);

    process.env.TREEMAP_NO_GDU = '1';
    const started = await startScan(dir, { incremental: false });
    const walked = await settle(started.scanId);
    delete process.env.TREEMAP_NO_GDU;

    assert.equal(gduRoot.size, walked.root!.size, 'total bytes must match exactly');
    assert.equal(scan.fileCount, walked.fileCount, 'file counts must match');
    assert.equal(scan.dirCount, walked.dirCount, 'dir counts must match');
    assert.equal(
      scan.hardlinkedFiles,
      walked.hardlinkedFiles,
      'hard-link dedup must match the walker',
    );
    assert.equal(countNodes(gduRoot), countNodes(walked.root!), 'node counts must match');
  } finally {
    delete process.env.TREEMAP_NO_GDU;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/**
 * Is this one of `gduScan`'s own temp directories?
 *
 * `gduScanner.ts` creates them with `mkdtemp(tmpdir()/'treemap-gdu-')`, so the
 * name is that prefix plus exactly the six characters `mkdtemp` appends —
 * never another hyphen.
 *
 * The precision matters because the test below asserts that nothing survived,
 * and the whole suite shares one `os.tmpdir()`. A `startsWith('treemap-gdu-')`
 * filter also claimed `treemap-gdu-precision-XXXXXX`, which
 * `incrementalRescan.test.ts` creates for a completely unrelated fixture, and
 * the two files run concurrently — so whether this test passed depended on
 * which one happened to be mid-flight. It failed exactly that way once in this
 * session, reporting another test's fixture as a leaked temp directory.
 *
 * The bug class is the one this repo keeps finding: something unrecognised
 * read as a fact about our own code. Here it costs a red CI run rather than
 * data, but the shape is identical.
 */
function isGduTemp(name: string): boolean {
  return /^treemap-gdu-[A-Za-z0-9]{6}$/.test(name);
}

test('gduScan removes its temp files even when a shard fails', async (t) => {
  const bin = await findGduBinary();
  if (!bin) return t.skip('gdu not available on this machine');

  const before = (await fsp.readdir(os.tmpdir())).filter(isGduTemp);
  const scan = createScanRecord('/definitely/not/a/real/path');
  await assert.rejects(() => gduScan(scan, bin, () => undefined));
  const after = (await fsp.readdir(os.tmpdir())).filter(isGduTemp);
  assert.deepEqual(after, before, "no directory of gduScan's own may survive a failure");
});

test('a cancelled scan stops sharding instead of walking the whole tree', async (t) => {
  const bin = await findGduBinary();
  if (!bin) return t.skip('gdu not available on this machine');

  const dir = await makeTree();
  try {
    const scan = createScanRecord(dir);
    scan.cancelled = true;
    await assert.rejects(() => gduScan(scan, bin, () => undefined), /cancelled/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('gduScan keeps empty dirs as children: [] so the empty-folder finder works', async (t) => {
  const bin = await findGduBinary();
  if (!bin) return t.skip('gdu not available on this machine');

  const dir = await makeTree();
  try {
    const scan = createScanRecord(dir);
    const root = await gduScan(scan, bin, () => undefined);
    const empty = root.children!.find((c) => c.name === 'empty');
    assert.ok(empty, 'empty dir must be present');
    assert.deepEqual(empty!.children, []);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('gduScan records files sitting directly under the scan root', async (t) => {
  const bin = await findGduBinary();
  if (!bin) return t.skip('gdu not available on this machine');

  const dir = await makeTree();
  try {
    const scan = createScanRecord(dir);
    const root = await gduScan(scan, bin, () => undefined);
    const top = root.children!.find((c) => c.name === 'top.bin');
    assert.ok(top, 'a file directly under the root must be included');
    assert.equal(top!.size, 1_234);
    const link = root.children!.find((c) => c.name === 'link.bin');
    assert.equal(link!.isSymlink, true, 'a symlink under the root must be flagged');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

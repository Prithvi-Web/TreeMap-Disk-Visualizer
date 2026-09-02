process.env.TREEMAP_NO_GDU = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startScan, getScan } from '../src/services/diskScanner';
import { sparseLine } from '../src/services/missingGigabytes';
import { ScanResult } from '../src/models/types';

/**
 * A file can claim more room than it occupies, and TreeMap counted the claim.
 *
 * Docker Desktop's Docker.raw is the usual one: created at 64 GB, perhaps 12 GB
 * actually on the disk. It drew as a 64 GB tile, added 64 GB to the scanned
 * total, and the Missing Gigabytes receipt then reported the difference as
 * "Unaccounted" under an explanation naming copy-on-write clones — the wrong
 * cause for the single most common macOS case of the numbers not adding up.
 *
 * macOS also stores a great many ordinary files compressed (measured: 758 of
 * 884 files in /usr/bin claim 62.6% more than they occupy), so the tally is
 * about claiming versus occupying, not about sparseness alone.
 */

const skipWin = { skip: process.platform === 'win32' ? 'blocks are not reported on Windows' : false };

async function tree(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-sparse-'));
  // A genuinely sparse file: truncate reserves the length without writing it.
  // (NTFS would allocate this solid, hence the skip above.)
  const fh = await fsp.open(path.join(dir, 'vm.img'), 'w');
  await fh.truncate(8 * 1024 * 1024);
  await fh.close();
  // A solid file, to prove the tally is not just counting everything.
  await fsp.writeFile(path.join(dir, 'solid.bin'), Buffer.alloc(64 * 1024, 7));
  // And a tiny one: fifty bytes occupying a whole piece of disk. This is the
  // half a shortfall-only correction misses, and on a tree of small files it
  // is the larger half.
  await fsp.writeFile(path.join(dir, 'tiny.txt'), 'x'.repeat(50));
  // A symlink reports a non-zero size against zero blocks — indistinguishable
  // from a fully sparse file unless it is excluded before the check.
  await fsp.symlink(path.join(dir, 'solid.bin'), path.join(dir, 'link.bin'));
  return dir;
}

async function scanned(dir: string): Promise<ScanResult> {
  const { scanId } = await startScan(dir, {});
  for (let i = 0; i < 400; i++) {
    const s = getScan(scanId)!;
    if (s.status === 'complete' || s.status === 'error') return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('scan did not finish');
}

test('a file that claims more than it occupies is counted, and a symlink is not', skipWin, async () => {
  const dir = await tree();
  try {
    const scan = await scanned(dir);
    assert.equal(scan.status, 'complete');
    assert.equal(scan.sparseFiles, 1, 'the reserved-but-unfilled file, and only it');
    // 8 MB claimed, essentially nothing occupied. Never the symlink's 
    // path length, and never the solid file.
    assert.ok(scan.sparseBytes! > 7 * 1024 * 1024,
      `the shortfall is what it claims minus what it holds, got ${String(scan.sparseBytes)}`);
    assert.ok(scan.sparseBytes! <= 8 * 1024 * 1024, 'and never more than it claimed');
    // The mirror image, and the reason a one-sided correction is wrong: a
    // 64 KB file occupies whole blocks, so the tree total UNDER-states it.
    // Measured: 3,000 fifty-byte files claim 0.14 MB and occupy 11.72 MB.
    assert.ok(scan.slackBytes! > 0, 'the disk hands out space in fixed-size pieces, and that is counted too');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a hard-link duplicate never has its shortfall taken off twice', skipWin, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-sparse-hl-'));
  try {
    const fh = await fsp.open(path.join(dir, 'vm.img'), 'w');
    await fh.truncate(8 * 1024 * 1024);
    await fh.close();
    // A second NAME for the same sparse inode. Its size is zeroed by the
    // hard-link tally, so its bytes were never added to the tree total —
    // subtracting a shortfall for it as well would take them off twice.
    await fsp.link(path.join(dir, 'vm.img'), path.join(dir, 'vm-again.img'));
    const scan = await scanned(dir);
    assert.equal(scan.sparseFiles, 1, 'one inode, one shortfall — however many names it has');
    assert.equal(scan.hardlinkedFiles, 1, 'and the second name is still counted as a hard link');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ── the receipt ── */

function baseScan(over: Partial<ScanResult>): ScanResult {
  return {
    scanId: 's1', rootPath: '/t', status: 'complete', startedAt: 0, fileCount: 1, dirCount: 1,
    engine: 'walker', sparseFiles: 3, sparseBytes: 52 * 1024 ** 3, ...over,
  } as ScanResult;
}

test('the receipt takes the claimed-but-not-occupied space back off, as a correction', () => {
  const line = sparseLine(baseScan({}), 'darwin');
  assert.equal(line.id, 'sparseFiles');
  assert.equal(line.available, true);
  assert.ok(line.bytes! < 0, 'a correction is negative — it takes back off what the scanned line counted');
  assert.equal(line.bytes, -(52 * 1024 ** 3));
  assert.equal(line.count, 3);
  assert.match(line.detail!, /Docker\.raw/, 'the commonest case is named, as an example');
  assert.doesNotMatch(line.label + String(line.detail), /sparse|block|allocat/i,
    'no jargon: most of these bytes are compression, and the user did not ask for the word either way');
});

test('an engine that cannot measure what a file occupies says so, rather than reporting zero', () => {
  const win = sparseLine(baseScan({}), 'win32');
  assert.equal(win.available, false);
  assert.equal(win.bytes, null, 'unknown is not zero');
  assert.match(win.reason!, /Windows/);

  const cloud = sparseLine(baseScan({ engine: 'cloud' }), 'darwin');
  assert.equal(cloud.available, false);
  assert.equal(cloud.bytes, null);
  assert.match(cloud.reason!, /cloud/, 'and it names the engine that could not tell');

  const gdu = sparseLine(baseScan({ engine: 'gdu-turbo' }), 'darwin');
  assert.equal(gdu.available, true, 'gdu reports dsize, so it can answer this');
});

test('a fast rescan says its figure is a floor, because unchanged folders were not measured again', () => {
  const line = sparseLine(baseScan({ incremental: true, cachedDirs: 12 }), 'darwin');
  assert.equal(line.available, true);
  assert.equal(line.notes.length, 1);
  assert.match(line.notes[0], /floor/, 'an under-count that says it is one is honest; a silent one is not');
  assert.doesNotMatch(line.notes[0], /\d+(\.\d+)? [KMGT]B/, 'and carries no byte figure of its own');
});

/* ── the platform seam, and the gdu engine ── */

test('Windows says its block counts mean nothing, so the shortfall is never computed there', async () => {
  // libuv leaves Stats.blocks at zero for every file on Windows. Believing that
  // zero would report every non-empty file on the drive as claiming space it
  // does not occupy, and the receipt would subtract the entire scanned line.
  // This is the one guard no test on a Mac can exercise by scanning, so the
  // seam itself is what gets pinned.
  const { WindowsProvider } = await import('../src/platform/windows/index');
  const { MacOsProvider } = await import('../src/platform/macos/index');
  assert.equal(new WindowsProvider().blocksAreMeaningful, false, 'the whole guard rests on this being false');
  assert.equal(new MacOsProvider().blocksAreMeaningful, true, 'and on it being true where blocks are real');
});

test('gdu, the default engine, can answer this too — it reports what it measured on disk', async () => {
  const { mapGduTree } = await import('../src/services/gduMapper');
  // gdu's own shape: asize is what the file claims, dsize what it occupies,
  // and dsize is omitted entirely when zero.
  const tree = [1, 2, { progname: 'gdu', progver: 'v5.36.1', timestamp: 1 },
    [{ name: '/fx', mtime: 1 },
      { name: 'vm.img', asize: 8 * 1024 * 1024, dsize: 4096, mtime: 1 },
      { name: 'solid.bin', asize: 4096, dsize: 4096, mtime: 1 },
    ]];

  const on = mapGduTree(tree as never, '/fx', { blocksAreMeaningful: true });
  assert.equal(on.stats.sparseFiles, 1, 'the file whose dsize is under its asize, and only it');
  assert.equal(on.stats.sparseBytes, 8 * 1024 * 1024 - 4096, 'claimed minus occupied');

  // Omitted by default, so no existing caller changes behaviour, and so a
  // platform that cannot measure allocation reports nothing rather than
  // reporting everything.
  const off = mapGduTree(tree as never, '/fx');
  assert.equal(off.stats.sparseFiles, 0, 'and nothing is claimed when the platform cannot say');
  assert.equal(off.stats.sparseBytes, 0);
});


test('the correction is the difference both ways, not just the files that claim too much', () => {
  // Measured on this Mac: /usr/bin claims 224.0 MB and holds 84.1 MB, so a
  // shortfall-only line is right to within its 0.3 MB of slack. But 3,000
  // fifty-byte files claim 0.14 MB and HOLD 11.72 MB — there the scan
  // under-counts, and a shortfall-only line would leave all of it in
  // Unaccounted under the clone explanation this fix exists to remove.
  const claimsMore = sparseLine(baseScan({ sparseBytes: 140 * 1024 ** 2, slackBytes: 300 * 1024 }), 'darwin');
  assert.equal(claimsMore.bytes, -(140 * 1024 ** 2 - 300 * 1024),
    'the usual case still takes space back off — net of the slack, not gross');

  const holdsMore = sparseLine(baseScan({ sparseFiles: 0, sparseBytes: 0, slackBytes: 11 * 1024 ** 2 }), 'darwin');
  assert.equal(holdsMore.bytes, 11 * 1024 ** 2,
    'a tree of small files occupies MORE than it claims, and the receipt must add that back, not ignore it');

  const balanced = sparseLine(baseScan({ sparseBytes: 5000, slackBytes: 5000 }), 'darwin');
  assert.equal(balanced.bytes, 0, 'and when the two cancel, the line is a measured zero');
});

test('the line explains both directions, because a user will meet both', () => {
  const line = sparseLine(baseScan({ sparseBytes: 1, slackBytes: 0 }), 'darwin');
  assert.match(line.detail!, /Docker\.raw/, 'the case that motivated it is named');
  assert.match(line.detail!, /small file/i, 'and so is the opposite case, which is commoner');
  assert.doesNotMatch(line.label, /but do not occupy/,
    'a label that only describes one direction contradicts itself when the number is positive');
});

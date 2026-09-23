import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScanRecord } from '../src/services/diskScanner';
import { getDuplicateJob, observeHashOpensForTests } from '../src/services/duplicateFinder';
import { PackedScanStore } from '../src/services/scanStore';
import type { DuplicateJob, ScanResult } from '../src/models/types';

/**
 * RISKS R1, the master prompt §3.2: hashing a file makes a sync client
 * download it, so a duplicate pass over iCloud Drive or OneDrive could pull
 * down hundreds of gigabytes onto the disk the user is emptying. A cloud
 * placeholder is never opened; neither is a symbolic link (which a read
 * follows — and a Windows cloud placeholder is a reparse point, which both
 * engines record as a link). What was not read because it would download is
 * reported, never silently dropped.
 */

const PAYLOAD = Buffer.alloc(8192, 7);

interface Built { scan: ScanResult; dir: string }

/** A scan of `dir` whose store says what each file is, over real files with the same bytes. */
function built(): Built {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-dupes-cloud-'));
  for (const name of ['a.dat', 'b.dat', 'cloud.dat', 'cloud-too.dat', 'online-only.dat']) fs.writeFileSync(path.join(dir, name), PAYLOAD);
  fs.symlinkSync(path.join(dir, 'a.dat'), path.join(dir, 'link.dat'));
  const scan = createScanRecord(dir);
  const store = new PackedScanStore(dir, path.sep, { name: path.basename(dir), isDir: true, size: 0, modifiedAt: 0, isHidden: false });
  const file = (name: string, extra: object = {}) =>
    store.addNode(store.rootId, { name, isDir: false, size: PAYLOAD.length, modifiedAt: 1, isHidden: false, ...extra });
  file('a.dat');
  file('b.dat');
  file('cloud.dat', { cloudPlaceholder: true, cloudProvider: 'icloud' });
  file('cloud-too.dat', { cloudPlaceholder: true });
  file('link.dat', { isSymlink: true });
  // The walk's exact flag, outside any known cloud folder: the ingest makes it
  // a placeholder too (nativeEngine.test.ts); here it is one without a provider.
  file('online-only.dat', { cloudPlaceholder: true });
  file('small-cloud.dat', { cloudPlaceholder: true, size: 10 });
  store.finalize();
  store.sumSizes();
  scan.store = store;
  scan.status = 'complete';
  return { scan, dir };
}

async function finished(job: DuplicateJob): Promise<DuplicateJob> {
  const deadline = Date.now() + 15_000;
  while (job.status === 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(job.status, 'complete', job.error);
  return job;
}

test('a cloud placeholder or a link is never opened; only real copies are hashed and grouped', async () => {
  const { scan, dir } = built();
  const opened: string[] = [];
  observeHashOpensForTests((file) => opened.push(path.basename(file)));
  try {
    const job = await finished(getDuplicateJob(scan, 1024));
    assert.deepEqual([...new Set(opened)].sort(), ['a.dat', 'b.dat'], 'only the two real copies were read');
    assert.deepEqual(job.groups?.map((g) => g.files.map((f) => path.basename(f.path)).sort()), [['a.dat', 'b.dat']]);
    assert.equal(job.totalReclaimable, PAYLOAD.length);
  } finally {
    observeHashOpensForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('what would have to download is reported: how many, how much, and the largest by name', async () => {
  const { scan, dir } = built();
  try {
    const job = await finished(getDuplicateJob(scan, 1024));
    assert.deepEqual(job.notHashed, {
      files: 3,
      bytes: 3 * PAYLOAD.length,
      largest: ['cloud-too.dat', 'cloud.dat', 'online-only.dat'].map((name) => ({ path: path.join(dir, name), size: PAYLOAD.length })),
    }, 'placeholders at or above the size the pass looks at; a link is not a file of its own, and a placeholder below the minimum would not have been read anyway');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

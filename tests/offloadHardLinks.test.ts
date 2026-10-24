import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-offloadHardLinks-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createScanRecord } from '../src/services/diskScanner';
import { getOffloadIndex, getOffloadJob, prepareOffload, setOffloadDiskUsageForTests, startOffload } from '../src/services/offload';
import { setTrashStepForTests } from '../src/services/cleaner';
import { AppError } from '../src/middleware/errorHandler';
import type { FileNode, OffloadJob, ScanResult } from '../src/models/types';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';
import { destinationsOnAnotherDrive } from './fixtures/offloadDrive';
destinationsOnAnotherDrive(); // every destination here stands for another drive (E01)

/**
 * A hard link's second name (hunt C07, C44). Every scan engine counts a file's bytes once, under the
 * first of its names it meets, and gives each later name size 0 with `hardlinkDuplicate`. An offload
 * skipped such a name inside a selected folder — then trashed the folder whole, with that name in it:
 * the copy, the record and Restore all lacked the file, and the job said it was complete. And a
 * second name selected on its own was planned at 0 bytes: "0 B will be copied", no free-space check
 * and no byte cap, though the whole file was copied. Every name is now copied, each planned at the
 * size the file really is.
 *
 * The scans are built by hand over real hard links on the disk (fs.linkSync makes one on macOS, Linux
 * and NTFS alike), so the engines' own marking is not what is tested here. Nothing reaches the
 * machine's Trash: the trash step moves each original into this file's own folder.
 */

const FAKE_TRASH = fileTempDir('treemap-offloadHardLinks-trash-');
const trashedPaths: string[] = [];

before(() => {
  setTrashStepForTests(async (p) => {
    trashedPaths.push(p);
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashedPaths.length}-${path.basename(p)}`));
  });
});

after(() => {
  setTrashStepForTests(null);
});

function fileNode(p: string, size: number, extra: Partial<FileNode> = {}): FileNode {
  return { name: path.basename(p), path: p, size, type: 'file', modifiedAt: Date.now(), isHidden: false, ...extra };
}

function dirNode(p: string, children: FileNode[]): FileNode {
  return { name: path.basename(p), path: p, size: children.reduce((s, c) => s + c.size, 0), type: 'dir', modifiedAt: Date.now(), isHidden: false, children };
}

/**
 * root/a-keep/photo.jpg (`bytes` long) with a second name root/z-proj/photo.jpg, and z-proj/other.txt;
 * a complete scan listing them as every engine does — the second name at 0 with `hardlinkDuplicate`.
 */
function linkedProject(label: string, bytes: number): { root: string; keep: string; proj: string; first: string; second: string; other: string; scan: ScanResult } {
  const root = fs.realpathSync(fileTempDir(`treemap-offloadHardLinks-${label}-`));
  const keep = path.join(root, 'a-keep');
  const proj = path.join(root, 'z-proj');
  fs.mkdirSync(keep);
  fs.mkdirSync(proj);
  const first = path.join(keep, 'photo.jpg');
  const second = path.join(proj, 'photo.jpg');
  const other = path.join(proj, 'other.txt');
  fs.writeFileSync(first, Buffer.alloc(bytes, 7));
  fs.linkSync(first, second);
  fs.writeFileSync(other, 'x'.repeat(100));
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = dirNode(root, [
    dirNode(keep, [fileNode(first, bytes)]),
    dirNode(proj, [fileNode(second, 0, { hardlinkDuplicate: true }), fileNode(other, 100)]),
  ]);
  return { root, keep, proj, first, second, other, scan };
}

async function settled(jobId: string): Promise<OffloadJob> {
  await waitFor(() => getOffloadJob(jobId)?.status !== 'running', `the job ${jobId} settling`);
  return getOffloadJob(jobId) as OffloadJob;
}

test('a hard link\'s second name inside a selected folder is copied, recorded and counted at its real size before the folder goes to the Trash', async () => {
  const { proj, second, other, scan } = linkedProject('folder', 5000);
  const dest = fileTempDir('treemap-offloadHardLinks-folder-dest-');
  const prepared = await withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest));
  assert.deepEqual(prepared.plan.map((c) => [c.src, c.size]).sort(), [[other, 100], [second, 5000]].sort(),
    'both names are planned, the second at the size the file really is');
  assert.equal(prepared.bytesTotal, 5100, 'the confirm and the free-space check count the whole file');
  const before = trashedPaths.length;
  const job = await withOpenFileCheck('clear', async () => settled((await startOffload(scan, [proj], dest, prepared)).jobId));
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(trashedPaths.slice(before), [proj], 'the folder went to the Trash whole');
  const copy = path.join(dest, 'z-proj', 'photo.jpg');
  assert.ok(fs.existsSync(copy), 'the second name has its copy at the destination');
  assert.equal(fs.statSync(copy).size, 5000);
  assert.ok(fs.readFileSync(copy).equals(Buffer.alloc(5000, 7)), 'holding the file\'s bytes');
  const recorded = (await getOffloadIndex()).entries.filter((e) => e.originalPath.startsWith(proj + path.sep)).map((e) => e.originalPath).sort();
  assert.deepEqual(recorded, [other, second].sort(), 'and is in the record Restore reads');
});

test('a hard link\'s second name selected on its own is planned at its real size, so the free-space check sees it', async () => {
  const { second, scan } = linkedProject('alone', 3_000_000);
  const dest = fileTempDir('treemap-offloadHardLinks-alone-dest-');
  const roomy = await withOpenFileCheck('clear', () => prepareOffload(scan, [second], dest));
  assert.deepEqual(roomy.plan.map((c) => [c.src, c.size]), [[second, 3_000_000]], 'planned at the file\'s real size, not the scan\'s 0');
  assert.equal(roomy.bytesTotal, 3_000_000);
  const undo = setOffloadDiskUsageForTests(async () => ({ total: 10_000_000, free: 1_000_000, used: 9_000_000 }));
  try {
    await assert.rejects(withOpenFileCheck('clear', () => prepareOffload(scan, [second], dest)), (err: unknown) => {
      assert.ok(err instanceof AppError, String(err));
      assert.equal(err.code, 'DEST_FULL', err.message);
      return true;
    });
  } finally {
    undo();
  }
});

test('two names of one file inside the same selected folder are each copied and recorded', async () => {
  const root = fs.realpathSync(fileTempDir('treemap-offloadHardLinks-both-'));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  const a = path.join(proj, 'a.bin');
  const b = path.join(proj, 'b.bin');
  fs.writeFileSync(a, Buffer.alloc(2000, 3));
  fs.linkSync(a, b);
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = dirNode(root, [dirNode(proj, [fileNode(a, 2000), fileNode(b, 0, { hardlinkDuplicate: true })])]);
  const dest = fileTempDir('treemap-offloadHardLinks-both-dest-');
  const prepared = await withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest));
  assert.deepEqual(prepared.plan.map((c) => [c.src, c.size]).sort(), [[a, 2000], [b, 2000]].sort());
  const job = await withOpenFileCheck('clear', async () => settled((await startOffload(scan, [proj], dest, prepared)).jobId));
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(fs.readdirSync(path.join(dest, 'proj')).sort(), ['a.bin', 'b.bin'], 'each name has its copy');
  const recorded = (await getOffloadIndex()).entries.filter((e) => e.originalPath.startsWith(proj + path.sep)).map((e) => e.originalPath).sort();
  assert.deepEqual(recorded, [a, b].sort(), 'and each is in the record, so Restore brings both names back');
});

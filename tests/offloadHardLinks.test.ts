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
/** Run inside the stand-in Trash step, right after it took `p`; a test sets it and clears it. */
let afterTrashStep: ((p: string) => void) | null = null;

before(() => {
  setTrashStepForTests(async (p) => {
    trashedPaths.push(p);
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashedPaths.length}-${path.basename(p)}`));
    afterTrashStep?.(p);
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
  const otherEntry = (await getOffloadIndex()).entries.find((e) => e.originalPath === other);
  assert.equal(otherEntry?.hardLinked, undefined, 'a file with one name carries no such mark');
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
  const linked = (await getOffloadIndex()).entries.filter((e) => e.originalPath.startsWith(proj + path.sep)).map((e) => e.hardLinked);
  assert.deepEqual(linked, [true, true], 'each is recorded as one of several names, so the Offloaded tab counts no space freed for it (review F1.11)');
  const recorded = (await getOffloadIndex()).entries.filter((e) => e.originalPath.startsWith(proj + path.sep)).map((e) => e.originalPath).sort();
  assert.deepEqual(recorded, [a, b].sort(), 'and each is in the record, so Restore brings both names back');
});

/**
 * Moving one name of a hard-linked file to the Trash (a rename) moves the shared file's change time, so
 * the look right before the next name's own trash step saw "may have changed" and left it in place,
 * half the selection done, with a warning that nothing had changed it (review F1.6). A change time
 * that moved because another name of the same file went on to its trash step in this job is not read
 * as a change; size, modified time and file id still are.
 */
test('two names of one file, each selected on its own, both go to the Trash with no "may have changed"', async () => {
  const root = fs.realpathSync(fileTempDir('treemap-offloadHardLinks-pair-'));
  const a = path.join(root, 'a.bin');
  const b = path.join(root, 'b.bin');
  fs.writeFileSync(a, Buffer.alloc(2000, 5));
  fs.linkSync(a, b);
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = dirNode(root, [fileNode(a, 2000), fileNode(b, 0, { hardlinkDuplicate: true })]);
  const dest = fileTempDir('treemap-offloadHardLinks-pair-dest-');
  const before = trashedPaths.length;
  const job = await withOpenFileCheck('clear', async () => {
    const prepared = await prepareOffload(scan, [a, b], dest);
    return settled((await startOffload(scan, [a, b], dest, prepared)).jobId);
  });
  assert.equal(job.status, 'complete', job.error);
  assert.equal(job.error, undefined, 'nothing was left in place');
  assert.deepEqual(trashedPaths.slice(before), [a, b], 'both names went to the Trash');
});

test('a name of a file whose other name went to the Trash is still looked at: written to after that, it stays in place, named as changed', async () => {
  const root = fs.realpathSync(fileTempDir('treemap-offloadHardLinks-pairWritten-'));
  const a = path.join(root, 'a.bin');
  const b = path.join(root, 'b.bin');
  fs.writeFileSync(a, Buffer.alloc(2000, 8));
  fs.linkSync(a, b);
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = dirNode(root, [fileNode(a, 2000), fileNode(b, 0, { hardlinkDuplicate: true })]);
  const dest = fileTempDir('treemap-offloadHardLinks-pairWritten-dest-');
  // Between a.bin's trash step and b.bin's own look: the file the two names share grows, through b.bin.
  afterTrashStep = (p) => { if (p === a) fs.appendFileSync(b, 'written after its copy was made'); };
  const before = trashedPaths.length;
  let job: OffloadJob;
  try {
    job = await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scan, [a, b], dest);
      return settled((await startOffload(scan, [a, b], dest, prepared)).jobId);
    });
  } finally {
    afterTrashStep = null;
  }
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(trashedPaths.slice(before), [a], 'the name written to after its copy was made was not handed to the Trash');
  assert.ok(fs.existsSync(b), 'it is in place');
  assert.match(job.error ?? '', /^b\.bin was left in place: it changed after its copy was made \(the copy holds it as it was then\), so it was not moved to the Trash\./, job.error);
});

test('every name of a hard-linked file keeps the date the file was last opened before the offload read it: the copies and the record', async () => {
  const root = fs.realpathSync(fileTempDir('treemap-offloadHardLinks-atime-'));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  const a = path.join(proj, 'a.bin');
  const b = path.join(proj, 'b.bin');
  fs.writeFileSync(a, Buffer.alloc(2000, 9));
  fs.linkSync(a, b);
  const opened = new Date('2019-06-07T08:09:10Z');
  const modified = new Date('2020-01-02T03:04:05Z');
  // Last opened before it was last modified: the next read of it moves that date (relatime, and macOS).
  fs.utimesSync(a, opened, modified);
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = dirNode(root, [dirNode(proj, [fileNode(a, 2000), fileNode(b, 0, { hardlinkDuplicate: true })])]);
  const dest = fileTempDir('treemap-offloadHardLinks-atime-dest-');
  const job = await withOpenFileCheck('clear', async () => {
    const prepared = await prepareOffload(scan, [proj], dest);
    return settled((await startOffload(scan, [proj], dest, prepared)).jobId);
  });
  assert.equal(job.status, 'complete', job.error);
  for (const name of ['a.bin', 'b.bin']) {
    assert.equal(fs.statSync(path.join(dest, 'proj', name)).atime.toISOString(), opened.toISOString(), `the copy of ${name} keeps the last-opened date`);
  }
  const recorded = (await getOffloadIndex()).entries.filter((e) => e.originalPath.startsWith(proj + path.sep));
  assert.deepEqual(recorded.map((e) => [path.basename(e.originalPath), e.atimeMs]).sort(), [['a.bin', opened.getTime()], ['b.bin', opened.getTime()]],
    'and the record keeps it for each name, so Restore puts it back on each');
});

test('a name of a file selected on its own, then a folder holding its other name: both go to the Trash', async () => {
  const root = fs.realpathSync(fileTempDir('treemap-offloadHardLinks-fileThenFolder-'));
  const a = path.join(root, 'a.bin');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  const b = path.join(proj, 'b.bin');
  fs.writeFileSync(a, Buffer.alloc(2000, 6));
  fs.linkSync(a, b);
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = dirNode(root, [fileNode(a, 2000), dirNode(proj, [fileNode(b, 0, { hardlinkDuplicate: true })])]);
  const dest = fileTempDir('treemap-offloadHardLinks-fileThenFolder-dest-');
  const before = trashedPaths.length;
  const job = await withOpenFileCheck('clear', async () => {
    const prepared = await prepareOffload(scan, [a, proj], dest);
    return settled((await startOffload(scan, [a, proj], dest, prepared)).jobId);
  });
  assert.equal(job.error, undefined, job.error);
  assert.deepEqual(trashedPaths.slice(before), [a, proj]);
});

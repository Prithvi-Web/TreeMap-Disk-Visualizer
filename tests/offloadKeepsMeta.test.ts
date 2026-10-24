import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-offloadKeepsMeta-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createScanRecord } from '../src/services/diskScanner';
import { getOffloadIndex, getOffloadJob, prepareOffload, setOffloadFileMetaFaultForTests, startOffload, startRestore } from '../src/services/offload';
import { setTrashStepForTests } from '../src/services/cleaner';
import type { FileNode, OffloadJob, ScanResult } from '../src/models/types';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';
import { destinationsOnAnotherDrive } from './fixtures/offloadDrive';
destinationsOnAnotherDrive(); // every destination here stands for another drive (E01)

/**
 * An offload and its Restore keep each file's modified date and, where the system has them, its
 * permissions (hunt C45). The copy opened its output with the default mode and set nothing after:
 * a private 0600 file came out 0644 — readable by every account — at the destination and again after
 * Restore, a script lost its execute bit, and every date became the time of the offload or the
 * restore. Now each copy is given its original's dates (and, off Windows, its permission bits) once it
 * verifies, the record keeps them, and Restore puts them back on the file it writes.
 *
 * Windows has no POSIX permission bits — a mode there is only the read-only attribute — so the
 * permission test runs where they exist; the dates are kept, and tested, everywhere.
 *
 * Nothing reaches the machine's Trash: the trash step moves each original into this file's own folder.
 */

const FAKE_TRASH = fileTempDir('treemap-offloadKeepsMeta-trash-');
let trashCount = 0;

before(() => {
  setTrashStepForTests(async (p) => {
    trashCount++;
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashCount}-${path.basename(p)}`));
  });
});

after(() => {
  setTrashStepForTests(null);
});

const OLD = new Date('2020-01-02T03:04:05Z');
const OLDER = new Date('2019-06-07T08:09:10Z');

function fileNode(p: string): FileNode {
  return { name: path.basename(p), path: p, size: fs.statSync(p).size, type: 'file', modifiedAt: Date.now(), isHidden: false };
}

/** root/proj holding `files` (name → mode), each last opened OLDER and modified OLD, and a complete scan listing them. */
function project(label: string, files: Record<string, number>): { proj: string; paths: string[]; scan: ScanResult } {
  const root = fs.realpathSync(fileTempDir(`treemap-offloadKeepsMeta-${label}-`));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  const paths = Object.entries(files).map(([name, mode]) => {
    const p = path.join(proj, name);
    fs.writeFileSync(p, `the contents of ${name}\n`);
    fs.chmodSync(p, mode);
    fs.utimesSync(p, OLDER, OLD);
    return p;
  });
  const children = paths.map(fileNode);
  const scan = createScanRecord(root);
  scan.status = 'complete';
  const folder: FileNode = { name: 'proj', path: proj, size: children.reduce((s, c) => s + c.size, 0), type: 'dir', modifiedAt: Date.now(), isHidden: false, children };
  scan.root = { name: path.basename(root), path: root, size: folder.size, type: 'dir', modifiedAt: Date.now(), isHidden: false, children: [folder] };
  return { proj, paths, scan };
}

async function settled(jobId: string): Promise<OffloadJob> {
  await waitFor(() => getOffloadJob(jobId)?.status !== 'running', `the job ${jobId} settling`);
  return getOffloadJob(jobId) as OffloadJob;
}

/** Offloads `proj`, then restores every file of it; answers the destination. */
async function offloadAndRestore(label: string, proj: string, scan: ScanResult, between: (dest: string) => void): Promise<string> {
  const dest = fileTempDir(`treemap-offloadKeepsMeta-${label}-dest-`);
  const job = await withOpenFileCheck('clear', async () => {
    const prepared = await prepareOffload(scan, [proj], dest);
    return settled((await startOffload(scan, [proj], dest, prepared)).jobId);
  });
  assert.equal(job.status, 'complete', job.error);
  assert.equal(job.error, undefined, 'no warning: every date and permission was set');
  assert.ok(!fs.existsSync(proj), 'the originals went to the (stand-in) Trash');
  between(dest);
  const ids = (await getOffloadIndex()).entries.filter((e) => e.originalPath.startsWith(proj + path.sep)).map((e) => e.id);
  const restore = await settled((await startRestore(ids)).jobId);
  assert.equal(restore.status, 'complete', restore.error);
  assert.equal(restore.error, undefined, 'no warning: every date and permission was set back');
  return dest;
}

test('an offload\'s copies and its Restore keep each file\'s modified date, and the record keeps it', async () => {
  const { proj, paths, scan } = project('times', { 'notes.txt': 0o644, 'report.pdf': 0o644 });
  await offloadAndRestore('times', proj, scan, (dest) => {
    for (const name of ['notes.txt', 'report.pdf']) {
      assert.equal(fs.statSync(path.join(dest, 'proj', name)).mtime.toISOString(), OLD.toISOString(), `the copy of ${name} keeps its modified date`);
    }
  });
  for (const p of paths) {
    assert.equal(fs.statSync(p).mtime.toISOString(), OLD.toISOString(), `the restored ${path.basename(p)} has its modified date back`);
  }
  const recorded = (await getOffloadIndex()).entries.filter((e) => e.originalPath.startsWith(proj + path.sep));
  assert.ok(recorded.every((e) => e.mtimeMs === OLD.getTime()), 'the record keeps each modified date');
});

test('an offload\'s copies and its Restore keep each file\'s permissions: a private file stays private, a script stays runnable', { skip: process.platform === 'win32' ? 'Windows has no POSIX permission bits; a mode there is only the read-only attribute' : false }, async () => {
  const { proj, paths: [secret, script], scan } = project('modes', { 'secret.txt': 0o600, 'run.sh': 0o755 });
  await offloadAndRestore('modes', proj, scan, (dest) => {
    assert.equal(fs.statSync(path.join(dest, 'proj', 'secret.txt')).mode & 0o777, 0o600, 'the copy of the private file is private');
    assert.equal(fs.statSync(path.join(dest, 'proj', 'run.sh')).mode & 0o777, 0o755, 'the copy of the script is runnable');
  });
  assert.equal(fs.statSync(secret).mode & 0o777, 0o600, 'the restored private file is private');
  assert.equal(fs.statSync(script).mode & 0o777, 0o755, 'the restored script is runnable');
  const recorded = (await getOffloadIndex()).entries.filter((e) => e.originalPath.startsWith(proj + path.sep));
  assert.deepEqual(recorded.map((e) => [path.basename(e.originalPath), e.mode]).sort(), [['run.sh', 0o755], ['secret.txt', 0o600]], 'the record keeps each permission');
});

test('Restore puts the recorded date and permissions back even when the copy on the drive lost them (a drive that cannot hold them)', async () => {
  const { proj, paths: [file], scan } = project('lost', { 'kept.txt': 0o640 });
  await offloadAndRestore('lost', proj, scan, (dest) => {
    // As exFAT would have it: the copy's own date and permissions are whatever the drive gives it.
    const copy = path.join(dest, 'proj', 'kept.txt');
    fs.utimesSync(copy, new Date(), new Date());
    if (process.platform !== 'win32') fs.chmodSync(copy, 0o666);
  });
  assert.equal(fs.statSync(file).mtime.toISOString(), OLD.toISOString(), 'the date comes from the record');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o640, 'and so do the permissions');
});

test('a drive that cannot hold a copy\'s dates is said, never a reason to undo the offload or the restore', async () => {
  const { proj, paths: [file], scan } = project('fault', { 'a.txt': 0o644 });
  const dest = fileTempDir('treemap-offloadKeepsMeta-fault-dest-');
  const refuse = setOffloadFileMetaFaultForTests((_p, what) => (what === 'times' ? Object.assign(new Error('EPERM: operation not permitted, utime'), { code: 'EPERM' }) : null));
  try {
    const job = await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scan, [proj], dest);
      return settled((await startOffload(scan, [proj], dest, prepared)).jobId);
    });
    assert.equal(job.status, 'complete', job.error);
    assert.ok(!fs.existsSync(proj), 'the verified offload went ahead');
    assert.match(job.error ?? '', /The dates or permissions of 1 copy could not be set at the destination/, job.error);
    assert.match(job.error ?? '', /TreeMap's record keeps the originals' dates and permissions for Restore/, job.error);
    const ids = (await getOffloadIndex()).entries.filter((e) => e.originalPath === file).map((e) => e.id);
    const restore = await settled((await startRestore(ids)).jobId);
    assert.equal(restore.status, 'complete', restore.error);
    assert.ok(fs.existsSync(file), 'the restore went ahead');
    assert.match(restore.error ?? '', /The dates or permissions of 1 restored file could not be set back/, restore.error);
  } finally {
    refuse();
  }
});

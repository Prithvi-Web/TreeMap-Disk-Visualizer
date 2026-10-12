import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-offloadUnlisted-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createScanRecord, getScan, startScan } from '../src/services/diskScanner';
import { getOffloadIndex, getOffloadJob, prepareOffload, setOffloadVerifyForTests, startOffload } from '../src/services/offload';
import { setTrashStepForTests } from '../src/services/cleaner';
import { updateSettings } from '../src/services/settings';
import { AppError } from '../src/middleware/errorHandler';
import type { OffloadJob, ScanResult } from '../src/models/types';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';

/**
 * An offload copies what the scan listed, then trashes each selected item whole (the final review,
 * F1.5). A selected folder can hold what the scan never listed — a "Don't scan" match, a folder it
 * could not read, a drive it did not enter, a file made since — and that went to the Trash with the
 * folder and no copy, the job ending "complete". Now a selection holding anything the scan did not
 * list is refused before anything is copied (dry run included), naming it; and a folder that holds
 * something new by its trash step is left in place, its copies standing at the destination.
 *
 * Nothing reaches the machine's Trash: the trash step moves each original into this file's own folder.
 */

const FAKE_TRASH = fileTempDir('treemap-offloadUnlisted-trash-');
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

/** A project folder `proj` holding a.txt, with `extra` (relative paths) written beside it on disk. */
function project(label: string, extra: string[] = []): { root: string; proj: string; a: string } {
  const root = fs.realpathSync(fileTempDir(`treemap-offloadUnlisted-${label}-`));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  const a = path.join(proj, 'a.txt');
  fs.writeFileSync(a, 'listed');
  for (const rel of extra) {
    fs.mkdirSync(path.dirname(path.join(proj, rel)), { recursive: true });
    fs.writeFileSync(path.join(proj, rel), 'not listed by the scan');
  }
  return { root, proj, a };
}

/** A complete scan of `root` whose tree lists `proj` holding only `a` — whatever else is on the disk. */
function scanListingOnly(root: string, proj: string, a: string): ScanResult {
  const scan = createScanRecord(root);
  scan.status = 'complete';
  const file = { name: 'a.txt', path: a, size: fs.statSync(a).size, type: 'file' as const, modifiedAt: Date.now(), isHidden: false };
  const folder = { name: 'proj', path: proj, size: file.size, type: 'dir' as const, modifiedAt: Date.now(), isHidden: false, children: [file] };
  scan.root = { name: path.basename(root), path: root, size: file.size, type: 'dir', modifiedAt: Date.now(), isHidden: false, children: [folder] };
  return scan;
}

async function refusalOf(work: Promise<unknown>): Promise<AppError> {
  try {
    await work;
  } catch (err) {
    assert.ok(err instanceof AppError, String(err));
    return err;
  }
  assert.fail('it was not refused');
}

async function settled(jobId: string): Promise<OffloadJob> {
  await waitFor(() => getOffloadJob(jobId)?.status !== 'running', `the job ${jobId} settling`);
  return getOffloadJob(jobId) as OffloadJob;
}

test('a folder holding a "Don\'t scan" match is refused before anything is copied, naming what the scan did not list', async () => {
  const { root, proj, a } = project('ignored', ['node_modules/lib.js']);
  const dest = fileTempDir('treemap-offloadUnlisted-ignored-dest-');
  await updateSettings({ ignore: [{ pattern: 'node_modules', scope: 'scan' }] });
  try {
    const started = await startScan(root, {});
    await waitFor(() => getScan(started.scanId)?.status !== 'running', 'the scan settling');
    const scan = getScan(started.scanId) as ScanResult;
    assert.equal(scan.status, 'complete');
    const refused = await refusalOf(withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest)));
    assert.equal(refused.code, 'OFFLOAD_NOT_FULLY_LISTED', refused.message);
    assert.equal(refused.status, 409);
    assert.match(refused.message, /node_modules/, refused.message);
    assert.match(refused.message, /the scan did not list/, refused.message);
    assert.match(refused.message, /nothing was copied or deleted/, refused.message);
  } finally {
    await updateSettings({ ignore: [] });
  }
  assert.deepEqual(fs.readdirSync(dest), [], 'nothing was copied');
  assert.ok(fs.existsSync(path.join(proj, 'node_modules', 'lib.js')) && fs.existsSync(a), 'nothing was touched');
});

test('a folder holding a file the scan did not list is refused for a dry run as for a real one, and a file selected on its own is not', async () => {
  const { root, proj, a } = project('hand', ['later.txt']);
  const dest = fileTempDir('treemap-offloadUnlisted-hand-dest-');
  const scan = scanListingOnly(root, proj, a);
  const refused = await refusalOf(withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest)));
  assert.equal(refused.code, 'OFFLOAD_NOT_FULLY_LISTED', refused.message);
  assert.match(refused.message, /later\.txt/, refused.message);
  const alone = await withOpenFileCheck('clear', () => prepareOffload(scan, [a], dest));
  assert.deepEqual(alone.plan.map((c) => c.src), [a], 'a listed file on its own is planned as before');
});

test('a folder that cannot be looked into is refused, never trashed unseen', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'permissions do not stop this user here' : false }, async () => {
  const { root, proj, a } = project('locked', ['locked/secret.txt']);
  const locked = path.join(proj, 'locked');
  const dest = fileTempDir('treemap-offloadUnlisted-locked-dest-');
  const scan = scanListingOnly(root, proj, a);
  // Listed by the scan as an empty folder it could not read.
  (scan.root?.children?.[0].children ?? []).push({ name: 'locked', path: locked, size: 0, type: 'dir', modifiedAt: Date.now(), isHidden: false, children: [] });
  fs.chmodSync(locked, 0o000);
  try {
    const refused = await refusalOf(withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest)));
    assert.equal(refused.code, 'OFFLOAD_NOT_FULLY_LISTED', refused.message);
    assert.match(refused.message, /locked/, refused.message);
    assert.match(refused.message, /could not be looked into/, refused.message);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

test('a file that appears in a selected folder after its copies were made leaves that folder in place, its copies standing and recorded', async () => {
  const { root, proj, a } = project('race');
  const dest = fileTempDir('treemap-offloadUnlisted-race-dest-');
  const scan = scanListingOnly(root, proj, a);
  const late = path.join(proj, 'made-during-the-copy.txt');
  const undo = setOffloadVerifyForTests((_dest, hash) => {
    if (!fs.existsSync(late)) fs.writeFileSync(late, 'written while the offload ran');
    return hash;
  });
  let job: OffloadJob;
  const before = trashedPaths.length;
  try {
    job = await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scan, [proj], dest);
      return settled((await startOffload(scan, [proj], dest, prepared)).jobId);
    });
  } finally {
    undo();
  }
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(trashedPaths.slice(before), [], 'the folder was not handed to the Trash');
  assert.ok(fs.existsSync(late) && fs.existsSync(a), 'it is still in place, the new file in it');
  assert.match(job.error ?? '', /proj was left in place/, job.error);
  assert.match(job.error ?? '', /made-during-the-copy\.txt/, job.error);
  assert.ok(fs.existsSync(path.join(dest, 'proj', 'a.txt')), 'the verified copy stands at the destination');
  assert.ok((await getOffloadIndex()).entries.some((e) => e.originalPath === a), 'and is recorded');
});

/** Folders `names` under a new root, each holding a.txt, and a complete scan listing exactly that. */
function projects(label: string, names: string[]): { root: string; folders: string[]; scan: ScanResult } {
  const root = fs.realpathSync(fileTempDir(`treemap-offloadUnlisted-${label}-`));
  const children = names.map((name) => {
    const folder = path.join(root, name);
    fs.mkdirSync(folder);
    const a = path.join(folder, 'a.txt');
    fs.writeFileSync(a, `listed in ${name}`);
    const file = { name: 'a.txt', path: a, size: fs.statSync(a).size, type: 'file' as const, modifiedAt: Date.now(), isHidden: false };
    return { name, path: folder, size: file.size, type: 'dir' as const, modifiedAt: Date.now(), isHidden: false, children: [file] };
  });
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = { name: path.basename(root), path: root, size: children.reduce((sum, c) => sum + c.size, 0), type: 'dir', modifiedAt: Date.now(), isHidden: false, children };
  return { root, folders: children.map((c) => c.path), scan };
}

/** Offloads `folders` of `scan`, a file appearing in each of `gaining` while the copies are made. */
async function offloadWhileGaining(label: string, scan: ScanResult, folders: string[], gaining: string[]): Promise<OffloadJob> {
  const dest = fileTempDir(`treemap-offloadUnlisted-${label}-dest-`);
  const undo = setOffloadVerifyForTests((_dest, hash) => {
    for (const folder of gaining) {
      const late = path.join(folder, 'made-during-the-copy.txt');
      if (!fs.existsSync(late)) fs.writeFileSync(late, 'written while the offload ran');
    }
    return hash;
  });
  try {
    return await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scan, folders, dest);
      return settled((await startOffload(scan, folders, dest, prepared)).jobId);
    });
  } finally {
    undo();
  }
}

test('a folder that gains a file during the copy is left in place alone: the other selected folders go to the Trash (final review F2.5)', async () => {
  const { folders: [projA, projB], scan } = projects('two', ['projA', 'projB']);
  const before = trashedPaths.length;
  const job = await offloadWhileGaining('two', scan, [projA, projB], [projA]);
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(trashedPaths.slice(before), [projB], 'the untouched folder went to the Trash after its copies verified');
  assert.ok(fs.existsSync(path.join(projA, 'made-during-the-copy.txt')) && fs.existsSync(path.join(projA, 'a.txt')), 'the one that gained a file is in place');
  assert.match(job.error ?? '', /projA was left in place: it now holds made-during-the-copy\.txt/, job.error);
  assert.doesNotMatch(job.error ?? '', /projB|more folder/, `only the folder held back is named (${job.error})`);
});

test('two of three folders gaining a file are both left in place, the first named and the other counted (final review F2.5)', async () => {
  const { folders: [projA, projB, projC], scan } = projects('three', ['projA', 'projB', 'projC']);
  const before = trashedPaths.length;
  const job = await offloadWhileGaining('three', scan, [projA, projB, projC], [projA, projC]);
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(trashedPaths.slice(before), [projB], 'only the untouched folder went to the Trash');
  assert.ok(fs.existsSync(path.join(projA, 'a.txt')) && fs.existsSync(path.join(projC, 'a.txt')), 'both that gained a file are in place');
  assert.match(job.error ?? '', /projA was left in place \(and 1 more folder\): /, job.error);
});

test('an OS junk file the scan did not list (.DS_Store) does not hold a folder back', async () => {
  const { root, proj, a } = project('junk', ['.DS_Store']);
  const dest = fileTempDir('treemap-offloadUnlisted-junk-dest-');
  const scan = scanListingOnly(root, proj, a);
  const before = trashedPaths.length;
  const job = await withOpenFileCheck('clear', async () => {
    const prepared = await prepareOffload(scan, [proj], dest);
    return settled((await startOffload(scan, [proj], dest, prepared)).jobId);
  });
  assert.equal(job.status, 'complete', job.error);
  assert.equal(job.error, undefined, job.error);
  assert.deepEqual(trashedPaths.slice(before), [proj], 'the folder went to the Trash after its copies verified');
});

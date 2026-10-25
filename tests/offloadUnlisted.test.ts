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
import { destinationsOnAnotherDrive } from './fixtures/offloadDrive';
destinationsOnAnotherDrive(); // every destination here stands for another drive (E01)

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
/** Run inside the stand-in Trash step, right before it takes `p`; a test sets it and clears it. */
let duringTrashStep: ((p: string) => void) | null = null;

before(() => {
  setTrashStepForTests(async (p) => {
    duringTrashStep?.(p);
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
  // Both had files to copy, so both copies stand (leftover HE2-L6).
  assert.equal(job.error, `projA was left in place (and 1 more folder): it now holds made-during-the-copy.txt, which was not copied (it was made after the offload was planned), so it was not moved to the Trash. Their verified copies stand at ${job.destRoot}.`);
});

test('a file made in a later selected folder while an earlier one goes to the Trash leaves that folder in place: each folder is listed again at its own turn', async () => {
  const { folders: [projA, projB], scan } = projects('own-turn', ['projA', 'projB']);
  const dest = fileTempDir('treemap-offloadUnlisted-own-turn-dest-');
  const late = path.join(projB, 'made-while-trashing.txt');
  // Past the one look at every folder before the first trash step: made by projA's own trash step.
  duringTrashStep = (p) => {
    if (p === projA && !fs.existsSync(late)) fs.writeFileSync(late, 'written while an earlier folder went to the Trash');
  };
  const before = trashedPaths.length;
  let job: OffloadJob;
  try {
    job = await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scan, [projA, projB], dest);
      return settled((await startOffload(scan, [projA, projB], dest, prepared)).jobId);
    });
  } finally {
    duringTrashStep = null;
  }
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(trashedPaths.slice(before), [projA], 'the folder that gained a file was not handed to the Trash');
  assert.ok(fs.existsSync(late) && fs.existsSync(path.join(projB, 'a.txt')), 'it is in place, the new file in it');
  assert.match(job.error ?? '', /^projB was left in place: it now holds made-while-trashing\.txt, which was not copied \(it was made after the offload was planned\), so it was not moved to the Trash\. Its verified copies stand at /, job.error);
  assert.ok(fs.existsSync(path.join(dest, 'projB', 'a.txt')), 'its verified copy stands at the destination');
  const entry = (await getOffloadIndex()).entries.find((e) => e.originalPath === path.join(projB, 'a.txt'));
  assert.equal(entry?.originalKept, true, 'and is recorded as a copy whose original stayed, never as space freed');
});

test('a later selected folder with files moved away while an earlier one goes to the Trash is said to be gone, its verified copies standing — never left in place, never holding itself (review)', async () => {
  const { root, folders: [projA, projB], scan } = projects('moved-away', ['projA', 'projB']);
  const dest = fileTempDir('treemap-offloadUnlisted-moved-away-dest-');
  const elsewhere = path.join(root, 'moved-projB');
  duringTrashStep = (p) => {
    if (p === projA && fs.existsSync(projB)) fs.renameSync(projB, elsewhere);
  };
  let job: OffloadJob;
  try {
    job = await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scan, [projA, projB], dest);
      return settled((await startOffload(scan, [projA, projB], dest, prepared)).jobId);
    });
  } finally {
    duringTrashStep = null;
  }
  assert.equal(job.status, 'complete', job.error);
  // Its file's look at its own turn fails first, as the folder is gone: the folder is said to be gone,
  // as one gone before the first trash step is, not "left in place" with "a.txt was removed".
  assert.equal(job.error, `projB is no longer there, so it was not moved to the Trash. Its verified copies stand at ${dest}.`);
  assert.doesNotMatch(job.error ?? '', /now holds/, 'a folder that is gone holds nothing');
  assert.ok(fs.existsSync(path.join(elsewhere, 'a.txt')), 'what was moved away is untouched');
  // Its record says so too, never "original left in place" (HE3 review F1.1).
  await assertRecordedGone([projB], [projA]);
});

/**
 * The offload record of each `gone` folder's a.txt says its original was gone (`originalGone`), never
 * that it was left in place (`originalKept`) — and each `trashed` folder's says neither (HE3 review F1.1).
 */
async function assertRecordedGone(gone: string[], trashed: string[]): Promise<void> {
  const entries = (await getOffloadIndex()).entries;
  const of = (folder: string): (typeof entries)[number] => {
    const entry = entries.find((e) => e.originalPath === path.join(folder, 'a.txt'));
    assert.ok(entry, `the copy of ${path.basename(folder)}/a.txt is recorded`);
    return entry;
  };
  for (const folder of gone) {
    const entry = of(folder);
    assert.equal(entry.originalGone, true, `${path.basename(folder)}: recorded as a copy whose original was gone, so no space was freed by it`);
    assert.equal('originalKept' in entry, false, `${path.basename(folder)}: never as one whose original was left in place`);
  }
  for (const folder of trashed) {
    const entry = of(folder);
    assert.equal('originalGone' in entry || 'originalKept' in entry, false, `${path.basename(folder)} went to the Trash: recorded as before`);
  }
}

/** `scan` with an empty folder `name` beside its folders, on the disk and listed as empty. */
function withEmptyFolder(root: string, scan: ScanResult, name: string): string {
  const folder = path.join(root, name);
  fs.mkdirSync(folder);
  scan.root?.children?.push({ name, path: folder, size: 0, type: 'dir', modifiedAt: Date.now(), isHidden: false, children: [] });
  return folder;
}

/** Offloads `selection`, running `during` inside each trash step and `whileCopying` as each copy verifies. */
async function offloadWith(label: string, scan: ScanResult, selection: string[], hooks: { during?: (p: string) => void; whileCopying?: () => void }): Promise<OffloadJob> {
  const dest = fileTempDir(`treemap-offloadUnlisted-${label}-dest-`);
  duringTrashStep = hooks.during ?? null;
  const undo = setOffloadVerifyForTests((_dest, hash) => { hooks.whileCopying?.(); return hash; });
  try {
    return await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scan, selection, dest);
      return settled((await startOffload(scan, selection, dest, prepared)).jobId);
    });
  } finally {
    duringTrashStep = null;
    undo();
  }
}

test('a selected empty folder that is gone by its turn is said to be gone — never to hold itself, never to have copies (review F1.6)', async () => {
  const { root, folders: [projB], scan } = projects('gone-empty', ['projB']);
  const emptyE = withEmptyFolder(root, scan, 'emptyE');
  const before = trashedPaths.length;
  const job = await offloadWith('gone-empty', scan, [projB, emptyE], { during: (p) => { if (p === projB && fs.existsSync(emptyE)) fs.rmdirSync(emptyE); } });
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(trashedPaths.slice(before), [projB], 'only projB was handed to the Trash');
  assert.equal(job.error, 'emptyE is no longer there, so it was not moved to the Trash.');
});

test('two selected empty folders gone — one while the copies were made, one by its own turn — are said together (review F1.6)', async () => {
  const { root, folders: [projB], scan } = projects('gone-two', ['projB']);
  const emptyE = withEmptyFolder(root, scan, 'emptyE');
  const emptyF = withEmptyFolder(root, scan, 'emptyF');
  const job = await offloadWith('gone-two', scan, [projB, emptyE, emptyF], {
    whileCopying: () => { if (fs.existsSync(emptyE)) fs.rmdirSync(emptyE); },
    during: (p) => { if (p === projB && fs.existsSync(emptyF)) fs.rmdirSync(emptyF); },
  });
  assert.equal(job.status, 'complete', job.error);
  assert.equal(job.error, 'emptyE and 1 more selected folder are no longer there, so they were not moved to the Trash.');
});

test('a selected empty folder that gains a file at its own turn is left in place with no word of copies: it had none (leftover HE2-L6)', async () => {
  const { root, folders: [projB], scan } = projects('empty-gains', ['projB']);
  const emptyG = withEmptyFolder(root, scan, 'emptyG');
  const late = path.join(emptyG, 'late.txt');
  const before = trashedPaths.length;
  const job = await offloadWith('empty-gains', scan, [projB, emptyG], { during: (p) => { if (p === projB && !fs.existsSync(late)) fs.writeFileSync(late, 'made while projB went to the Trash'); } });
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(trashedPaths.slice(before), [projB], 'only projB was handed to the Trash');
  assert.equal(job.error, 'emptyG was left in place: it now holds late.txt, which was not copied (it was made after the offload was planned), so it was not moved to the Trash.');
  assert.ok(fs.existsSync(late), 'it is in place, the new file in it');
});

test('three selected folders with files gone before the first trash step are said together, their verified copies standing (leftover HE2-L6)', async () => {
  const { root, folders: [projA, projB, projC, projD], scan } = projects('gone-with-files', ['projA', 'projB', 'projC', 'projD']);
  let verified = 0;
  const before = trashedPaths.length;
  // Moved away once every copy has verified: after the copies, before the look at every folder.
  const job = await offloadWith('gone-with-files', scan, [projA, projB, projC, projD], {
    whileCopying: () => {
      if (++verified !== 4) return;
      for (const folder of [projB, projC, projD]) fs.renameSync(folder, path.join(root, `moved-${path.basename(folder)}`));
    },
  });
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(trashedPaths.slice(before), [projA], 'only projA was handed to the Trash');
  assert.equal(job.error, `projB and 2 more selected folders are no longer there, so they were not moved to the Trash. Their verified copies stand at ${job.destRoot}.`);
  for (const name of ['projB', 'projC', 'projD']) assert.ok(fs.existsSync(path.join(job.destRoot, name, 'a.txt')), `the verified copy of ${name} stands`);
  await assertRecordedGone([projB, projC, projD], [projA]);
});

const lockable = process.platform !== 'win32' && process.getuid?.() !== 0;

/** Gives back the permissions a test took from `rel` in `folder`, wherever the folder is now: in place, or in the stand-in Trash. */
function unlock(folder: string, rel = ''): void {
  const places = [folder, ...fs.readdirSync(FAKE_TRASH).filter((n) => n.endsWith(`-${path.basename(folder)}`)).map((n) => path.join(FAKE_TRASH, n))];
  for (const place of places) {
    const p = path.join(place, rel);
    if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
  }
}

test('a selected folder that cannot be looked into again at its turn is said so, its copies standing — never as holding itself (review F1.6)', { skip: lockable ? false : 'permissions do not stop this user here' }, async () => {
  const { folders: [projA, projB], scan } = projects('unlistable-top', ['projA', 'projB']);
  // Its files can still be looked at (search permission), but it cannot be listed.
  const job = await offloadWith('unlistable-top', scan, [projA, projB], { during: (p) => { if (p === projA) fs.chmodSync(projB, 0o300); } });
  unlock(projB);
  assert.equal(job.status, 'complete', job.error);
  assert.match(job.error ?? '', /^projB was left in place: it could not be looked into again \(.+\), so it was not moved to the Trash\. Its verified copies stand at \S+\.$/s, job.error);
  assert.doesNotMatch(job.error ?? '', /now holds|which was not copied/, job.error);
  assert.ok(fs.existsSync(path.join(projB, 'a.txt')), 'it is in place');
});

test('a folder in a selected folder that cannot be looked into at its turn leaves it in place, saying what is not known (review F1.6)', { skip: lockable ? false : 'permissions do not stop this user here' }, async () => {
  const { folders: [projA, projB], scan } = projects('unlistable-sub', ['projA', 'projB']);
  const sub = path.join(projB, 'sub');
  fs.mkdirSync(sub);
  scan.root?.children?.find((c) => c.path === projB)?.children?.push({ name: 'sub', path: sub, size: 0, type: 'dir', modifiedAt: Date.now(), isHidden: false, children: [] });
  const job = await offloadWith('unlistable-sub', scan, [projA, projB], { during: (p) => { if (p === projA) fs.chmodSync(sub, 0o000); } });
  unlock(projB, 'sub');
  assert.equal(job.status, 'complete', job.error);
  assert.match(job.error ?? '', /^projB was left in place: what sub in it holds is not known \(it could not be looked into: .+\), so it was not moved to the Trash\. Its verified copies stand at \S+\.$/s, job.error);
});

test('a selected folder that cannot be looked into is refused before anything is copied, never said to hold itself (review F1.6)', { skip: lockable ? false : 'permissions do not stop this user here' }, async () => {
  const { root, proj, a } = project('unlistable-prepare');
  const dest = fileTempDir('treemap-offloadUnlisted-unlistable-prepare-dest-');
  const scan = scanListingOnly(root, proj, a);
  fs.chmodSync(proj, 0o300);
  try {
    const refused = await refusalOf(withOpenFileCheck('clear', () => prepareOffload(scan, [proj], dest)));
    assert.equal(refused.code, 'OFFLOAD_NOT_FULLY_LISTED', refused.message);
    assert.match(refused.message, /^proj could not be looked into \(.+\), so what it holds is not known\. Offloading it would move anything the scan did not list to the Trash with no copy, so nothing was copied or deleted\. Rescan it, or offload what is inside it instead\.$/s, refused.message);
  } finally {
    fs.chmodSync(proj, 0o755);
  }
});

test('a selected empty folder that is gone before the offload is planned is refused, said to be gone (review F1.6)', async () => {
  const { root, folders: [projB], scan } = projects('gone-prepare', ['projB']);
  const emptyE = withEmptyFolder(root, scan, 'emptyE');
  fs.rmdirSync(emptyE);
  const dest = fileTempDir('treemap-offloadUnlisted-gone-prepare-dest-');
  const refused = await refusalOf(withOpenFileCheck('clear', () => prepareOffload(scan, [projB, emptyE], dest)));
  assert.equal(refused.code, 'OFFLOAD_NOT_FULLY_LISTED', refused.message);
  assert.equal(refused.message, 'emptyE is no longer there, so nothing was copied or deleted. Rescan the folder that held it.');
});

test('where agents read the offload contract, a selected folder that cannot be listed or is gone is said to be refused or kept for that (review F1.6)', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\s+/g, ' ');
  const agents = read('AGENTS.md');
  assert.ok(agents.includes('(`409 OFFLOAD_NOT_FULLY_LISTED`, naming it, or saying that the selected folder itself could not be looked into or is gone)'), 'AGENTS.md, before anything is copied');
  assert.ok(agents.includes('one that is gone by then, files and all, is said to be gone — its verified copies standing if it had files to copy — and is not moved to the Trash; a file whose size, modified time or file id moved, or that is gone from a selected folder that is still there, changed after its copy was made'), 'AGENTS.md, at its own turn (leftover HE2-L8)');
  assert.ok(read('src/api/openapi.ts').includes('naming the first such entry, or saying that the selected folder itself could not be looked into or is gone'), 'the OpenAPI 409');
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

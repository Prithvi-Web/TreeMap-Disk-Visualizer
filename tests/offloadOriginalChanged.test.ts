import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-offloadOriginalChanged-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createScanRecord } from '../src/services/diskScanner';
import { getOffloadIndex, getOffloadJob, prepareOffload, setOffloadVerifyForTests, startOffload } from '../src/services/offload';
import { setTrashStepForTests } from '../src/services/cleaner';
import { setCopyFaultForTests } from '../src/utils/copyVerify';
import { platform } from '../src/platform';
import type { FileNode, OffloadJob, ScanResult } from '../src/models/types';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';
import { destinationsOnAnotherDrive } from './fixtures/offloadDrive';
destinationsOnAnotherDrive(); // every destination here stands for another drive (E01)

/**
 * An original that changes after its copy was made (hunt C06). The copies are all made and verified
 * first, and the originals go to the Trash only at the end of the job — on a large offload, hours
 * later. An original edited in between (an app still saving, or one that saves by writing a new file
 * and renaming it over the old) went to the Trash all the same, while the copy at the destination —
 * what Restore brings back — held the earlier version; the job said it was complete. Now each
 * selected item is looked at again right before its own trash step: one holding a file that is not
 * what was copied (its size, modified time, file id, or change time moved, or it is gone) is left in
 * place, its copies standing and recorded, and the job says which file and why.
 *
 * Nothing reaches the machine's Trash: the trash step moves each original into this file's own folder.
 */

const FAKE_TRASH = fileTempDir('treemap-offloadOriginalChanged-trash-');
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

function fileNode(p: string): FileNode {
  return { name: path.basename(p), path: p, size: fs.statSync(p).size, type: 'file', modifiedAt: Date.now(), isHidden: false };
}

function dirNode(p: string, children: FileNode[]): FileNode {
  return { name: path.basename(p), path: p, size: children.reduce((s, c) => s + c.size, 0), type: 'dir', modifiedAt: Date.now(), isHidden: false, children };
}

/** Folders `names` under a new root, each holding doc.txt ("version 1") and b.txt, and a complete scan listing them. */
function projects(label: string, names: string[]): { root: string; folders: string[]; scan: ScanResult } {
  const root = fs.realpathSync(fileTempDir(`treemap-offloadOriginalChanged-${label}-`));
  const children = names.map((name) => {
    const folder = path.join(root, name);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'doc.txt'), 'version 1');
    fs.writeFileSync(path.join(folder, 'b.txt'), 'b');
    return dirNode(folder, [fileNode(path.join(folder, 'b.txt')), fileNode(path.join(folder, 'doc.txt'))]);
  });
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = dirNode(root, children);
  return { root, folders: children.map((c) => c.path), scan };
}

async function settled(jobId: string): Promise<OffloadJob> {
  await waitFor(() => getOffloadJob(jobId)?.status !== 'running', `the job ${jobId} settling`);
  return getOffloadJob(jobId) as OffloadJob;
}

/** Offloads `paths` of `scan`, calling `change` once the copy of the file named `when` has verified. */
async function offloadChanging(label: string, scan: ScanResult, paths: string[], when: string, change: () => void): Promise<{ job: OffloadJob; dest: string; trashed: string[] }> {
  const dest = fileTempDir(`treemap-offloadOriginalChanged-${label}-dest-`);
  let changed = false;
  const undo = setOffloadVerifyForTests((destPath, hash) => {
    if (!changed && destPath.endsWith(when)) {
      changed = true;
      change();
    }
    return hash;
  });
  const before = trashedPaths.length;
  try {
    const job = await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scan, paths, dest);
      return settled((await startOffload(scan, paths, dest, prepared)).jobId);
    });
    assert.ok(changed, 'the change was made');
    return { job, dest, trashed: trashedPaths.slice(before) };
  } finally {
    undo();
  }
}

test('a file edited after its copy verified leaves its folder in place, the copies standing and recorded, and says so — while an unchanged folder beside it goes to the Trash', async () => {
  const { folders: [edited, untouched], scan } = projects('edited', ['edited', 'untouched']);
  const doc = path.join(edited, 'doc.txt');
  const { job, dest, trashed } = await offloadChanging('edited', scan, [edited, untouched], path.join('edited', 'doc.txt'), () => {
    fs.writeFileSync(doc, 'version 2 — the edits made while the offload ran');
  });
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(trashed, [untouched], 'only the folder that is still what was copied went to the Trash');
  assert.equal(fs.readFileSync(doc, 'utf8'), 'version 2 — the edits made while the offload ran', 'the edits are still in place');
  assert.match(job.error ?? '', /edited was left in place/, job.error);
  assert.match(job.error ?? '', /doc\.txt changed after its copy was made/, job.error);
  assert.match(job.error ?? '', /so it was not moved to the Trash/, job.error);
  assert.doesNotMatch(job.error ?? '', /couldn't be moved to the Trash/, 'said as a change TreeMap found, not as a Trash failure');
  assert.equal(fs.readFileSync(path.join(dest, 'edited', 'doc.txt'), 'utf8'), 'version 1', 'the copy is of what was there when it was made');
  const entries = (await getOffloadIndex()).entries;
  const kept = entries.filter((e) => e.originalPath.startsWith(edited + path.sep));
  assert.equal(kept.length, 2, 'the copies are recorded');
  assert.ok(kept.every((e) => e.originalKept === true), 'as copies whose originals stayed');
  assert.ok(entries.filter((e) => e.originalPath.startsWith(untouched + path.sep)).every((e) => e.originalKept !== true), 'the trashed folder\'s are not');
});

test('a file selected on its own and replaced by another file (a save that renames a new file over the old) after its copy stays in place', async () => {
  const { folders: [proj], scan } = projects('replaced', ['proj']);
  const doc = path.join(proj, 'doc.txt');
  // A whole second, which utimes can set exactly: the new file gets the same modified time.
  const when = new Date('2020-01-02T03:04:05Z');
  fs.utimesSync(doc, when, when);
  const { job, trashed } = await offloadChanging('replaced', scan, [doc], 'doc.txt', () => {
    const tmp = path.join(proj, '.doc.txt.saving');
    fs.writeFileSync(tmp, 'version 1'); // same size, same text, same modified time: the file id tells it apart
    fs.utimesSync(tmp, when, when);
    fs.renameSync(tmp, doc);
  });
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(trashed, [], 'the replaced file was not handed to the Trash');
  assert.ok(fs.existsSync(doc), 'it is still in place');
  assert.match(job.error ?? '', /doc\.txt was left in place: it changed after its copy was made \(the copy holds it as it was then\)/, job.error);
  assert.doesNotMatch(job.error ?? '', /may have changed/, 'another file in its place is a definite change');
});

test('a file removed from a selected folder after its copy leaves the folder in place', async () => {
  const { folders: [proj], scan } = projects('removed', ['proj']);
  const { job, trashed } = await offloadChanging('removed', scan, [proj], path.join('proj', 'doc.txt'), () => {
    fs.rmSync(path.join(proj, 'b.txt'));
  });
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(trashed, [], 'the folder was not handed to the Trash');
  assert.match(job.error ?? '', /proj was left in place/, job.error);
  assert.match(job.error ?? '', /b\.txt was removed after its copy was made/, job.error);
});

test('a change time that moved alone is said as "may have changed", and the folder still stays', { skip: process.platform === 'win32' ? 'a permission on Windows is the read-only attribute, which a test folder then cannot be cleaned up past' : false }, async () => {
  const { folders: [proj], scan } = projects('ctime', ['proj']);
  const { job, trashed } = await offloadChanging('ctime', scan, [proj], path.join('proj', 'doc.txt'), () => {
    fs.chmodSync(path.join(proj, 'b.txt'), 0o600);
  });
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(trashed, [], 'the folder was not handed to the Trash');
  assert.match(job.error ?? '', /b\.txt may have changed after its copy was made/, job.error);
});

/**
 * A file written to WHILE its copy streams (a database, a mailbox or a VM disk in use) gives a copy that
 * matches its own stream's hash — so it verifies — but equals neither the old file nor the new one
 * (review F1.9). It must never be recorded as a copy Restore could bring back, nor described as "the
 * file as it was then". Each file is looked at again right after its copy: one that changed meanwhile
 * has its copy removed and not recorded, and its item stays, said as changed while it was copied.
 */
async function offloadEditedMidCopy(label: string, scan: ScanResult, paths: string[], file: string, edit?: () => void): Promise<{ job: OffloadJob; dest: string; trashed: string[] }> {
  const dest = fileTempDir(`treemap-offloadOriginalChanged-${label}-dest-`);
  let edits = 0;
  const undo = setCopyFaultForTests((destPath) => {
    if (edits === 0 && destPath.endsWith(path.basename(file))) {
      edits++;
      if (edit) edit();
      else {
        // The first chunk is read; write same-size bytes near the end, which the copy has not read yet.
        const fd = fs.openSync(file, 'r+');
        try { fs.writeSync(fd, Buffer.alloc(16, 0x58), 0, 16, 280_000); } finally { fs.closeSync(fd); }
      }
    }
    return null;
  });
  const before = trashedPaths.length;
  try {
    const job = await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scan, paths, dest);
      return settled((await startOffload(scan, paths, dest, prepared)).jobId);
    });
    assert.equal(edits, 1, 'the file was written to while its copy streamed');
    return { job, dest, trashed: trashedPaths.slice(before) };
  } finally {
    undo();
  }
}

test('a file written to while its copy streamed: the copy, which may mix old and new, is removed and never recorded, and its folder stays (review F1.9)', async () => {
  const root = fs.realpathSync(fileTempDir('treemap-offloadOriginalChanged-torn-'));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  const db = path.join(proj, 'db.bin');
  fs.writeFileSync(db, Buffer.alloc(300_000, 0x41));
  fs.writeFileSync(path.join(proj, 'b.txt'), 'b');
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = dirNode(root, [dirNode(proj, [fileNode(path.join(proj, 'b.txt')), fileNode(db)])]);
  const { job, dest, trashed } = await offloadEditedMidCopy('torn', scan, [proj], db);
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(trashed, [], 'the folder was not handed to the Trash');
  assert.match(job.error ?? '', /proj was left in place: db\.bin changed while it was being copied, so its copy, which may mix old and new, was removed and not recorded/, job.error);
  assert.doesNotMatch(job.error ?? '', /as it was then/, 'never said to hold the file as it was');
  assert.match(job.error ?? '', /Its other verified copies stand at /, job.error);
  assert.equal(fs.existsSync(path.join(dest, 'proj', 'db.bin')), false, 'the torn copy is not left at the destination');
  const entries = (await getOffloadIndex()).entries.filter((e) => e.originalPath.startsWith(proj + path.sep));
  assert.deepEqual(entries.map((e) => path.basename(e.originalPath)), ['b.txt'], 'only the copy that verified whole is recorded for Restore');
  assert.ok(entries.every((e) => e.originalKept === true), 'as a copy whose original stayed');
});

test('a file selected on its own and written to while it was copied stays, with no copy standing for it', async () => {
  const root = fs.realpathSync(fileTempDir('treemap-offloadOriginalChanged-tornfile-'));
  const db = path.join(root, 'mail.db');
  fs.writeFileSync(db, Buffer.alloc(300_000, 0x41));
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = dirNode(root, [fileNode(db)]);
  const { job, dest, trashed } = await offloadEditedMidCopy('tornfile', scan, [db], db);
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(trashed, []);
  assert.match(job.error ?? '', /mail\.db was left in place: it changed while it was being copied, so its copy, which may mix old and new, was removed and not recorded\./, job.error);
  assert.doesNotMatch(job.error ?? '', /copies stand at/, 'no copy of it stands anywhere');
  assert.equal(fs.existsSync(path.join(dest, 'mail.db')), false);
  assert.equal((await getOffloadIndex()).entries.filter((e) => e.originalPath === db).length, 0);
});

test('a change time that moved alone while the copy streamed is said as "may have changed", and that copy is not kept either', { skip: process.platform === 'win32' ? 'a permission on Windows is the read-only attribute' : false }, async () => {
  const root = fs.realpathSync(fileTempDir('treemap-offloadOriginalChanged-tornctime-'));
  const db = path.join(root, 'cache.db');
  fs.writeFileSync(db, Buffer.alloc(300_000, 0x41));
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = dirNode(root, [fileNode(db)]);
  const { job, dest, trashed } = await offloadEditedMidCopy('tornctime', scan, [db], db, () => fs.chmodSync(db, 0o600));
  assert.deepEqual(trashed, []);
  assert.match(job.error ?? '', /cache\.db was left in place: it may have changed while it was being copied, so its copy, which may mix old and new, was removed and not recorded\./, job.error);
  assert.equal(fs.existsSync(path.join(dest, 'cache.db')), false);
});

test('beside a file that changed while it was copied, the job never says everything was offloaded', async () => {
  const root = fs.realpathSync(fileTempDir('treemap-offloadOriginalChanged-tornplus-'));
  const db = path.join(root, 'live.db');
  const other = path.join(root, 'other.txt');
  fs.writeFileSync(db, Buffer.alloc(300_000, 0x41));
  fs.writeFileSync(other, 'other');
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = dirNode(root, [fileNode(db), fileNode(other)]);
  // The Trash refuses other.txt: "Offloaded everything, but 1 original couldn't be moved" would be untrue.
  setTrashStepForTests(async (p) => { throw new Error(`the Trash refused ${path.basename(p)} (a test)`); });
  try {
    const { job, trashed } = await offloadEditedMidCopy('tornplus', scan, [db, other], db);
    assert.deepEqual(trashed, []);
    assert.match(job.error ?? '', /^Offloaded everything else, but 1 original couldn't be moved to the Trash/, job.error);
    assert.match(job.error ?? '', /live\.db was left in place: it changed while it was being copied/, job.error);
  } finally {
    setTrashStepForTests(async (p) => {
      trashedPaths.push(p);
      fs.renameSync(p, path.join(FAKE_TRASH, `${trashedPaths.length}-${path.basename(p)}`));
    });
  }
});

test('beside a file that changed while it was copied, an original found open at the trash step never reads as everything copied', async () => {
  const root = fs.realpathSync(fileTempDir('treemap-offloadOriginalChanged-tornopen-'));
  const db = path.join(root, 'open.db');
  const other = path.join(root, 'notes.txt');
  fs.writeFileSync(db, Buffer.alloc(300_000, 0x41));
  fs.writeFileSync(other, 'notes');
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = dirNode(root, [fileNode(db), fileNode(other)]);
  const provider = platform() as unknown as { getOpenHandlesBatch: (paths: string[]) => Promise<unknown> };
  const { job, trashed } = await offloadEditedMidCopy('tornopen', scan, [db, other], db, () => {
    const fd = fs.openSync(db, 'r+');
    try { fs.writeSync(fd, Buffer.alloc(16, 0x58), 0, 16, 280_000); } finally { fs.closeSync(fd); }
    // Opened after the offload's own check before the copy: the trash step's check finds it.
    provider.getOpenHandlesBatch = async () => ({ handles: [{ path: other, pid: process.pid + 1, processName: 'Notes' }], complete: true });
  });
  assert.deepEqual(trashed, []);
  assert.match(job.error ?? '', /^Everything else was copied and verified to .*, but the originals are still here/, job.error);
  assert.match(job.error ?? '', /open\.db was left in place: it changed while it was being copied/, job.error);
});

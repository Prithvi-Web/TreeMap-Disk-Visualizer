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

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-offloadOriginalKept-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createScanRecord } from '../src/services/diskScanner';
import { getOffloadIndex, getOffloadJob, prepareOffload, setOffloadVerifyForTests, startOffload } from '../src/services/offload';
import { setTrashStepForTests } from '../src/services/cleaner';
import { platform } from '../src/platform';
import type { OffloadEntry, OffloadJob, ScanResult } from '../src/models/types';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';

/**
 * The offload record says which originals went to the Trash (final review F3.2). Every verified copy is
 * recorded, so Restore and Reveal can find it — including the copies of an original the offload left in
 * place: a selected folder that gained a file during the copy (F1.5), an original found open at the trash
 * step, one the Trash refused. Nothing in the record told those apart, and the Offloaded tab counted
 * every one as "freed locally". Now each such entry carries `originalKept: true`, and the rest carry no
 * such field, as every entry an earlier build recorded.
 *
 * Nothing reaches the machine's Trash: the trash step moves each original into this file's own folder,
 * or refuses the ones a test names.
 */

const FAKE_TRASH = fileTempDir('treemap-offloadOriginalKept-trash-');
const trashedPaths: string[] = [];
/** Originals the stand-in Trash refuses, as a Trash that cannot take an item does. */
const refused = new Set<string>();

before(() => {
  setTrashStepForTests(async (p) => {
    if (refused.has(p)) throw new Error('the Trash would not take it (a test)');
    trashedPaths.push(p);
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashedPaths.length}-${path.basename(p)}`));
  });
});

after(() => {
  setTrashStepForTests(null);
});

/** Folders `names` under a new root, each holding a.txt and b.txt, and a complete scan listing exactly that. */
function projects(label: string, names: string[]): { folders: string[]; scan: ScanResult } {
  const root = fs.realpathSync(fileTempDir(`treemap-offloadOriginalKept-${label}-`));
  const children = names.map((name) => {
    const folder = path.join(root, name);
    fs.mkdirSync(folder);
    const files = ['a.txt', 'b.txt'].map((file) => {
      const at = path.join(folder, file);
      fs.writeFileSync(at, Buffer.alloc(1000, 1));
      return { name: file, path: at, size: 1000, type: 'file' as const, modifiedAt: Date.now(), isHidden: false };
    });
    return { name, path: folder, size: 2000, type: 'dir' as const, modifiedAt: Date.now(), isHidden: false, children: files };
  });
  const scan = createScanRecord(root);
  scan.status = 'complete';
  scan.root = { name: path.basename(root), path: root, size: 2000 * names.length, type: 'dir', modifiedAt: Date.now(), isHidden: false, children };
  return { folders: children.map((c) => c.path), scan };
}

/** Offloads `folders` of `scan`, calling `during` while the copies are made; the job settled, and what it recorded. */
async function offload(label: string, scan: ScanResult, folders: string[], during: () => void = () => undefined): Promise<{ job: OffloadJob; entries: OffloadEntry[] }> {
  const dest = fileTempDir(`treemap-offloadOriginalKept-${label}-dest-`);
  const undo = setOffloadVerifyForTests((_dest, hash) => {
    during();
    return hash;
  });
  try {
    const job = await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scan, folders, dest);
      const { jobId } = await startOffload(scan, folders, dest, prepared);
      await waitFor(() => getOffloadJob(jobId)?.status !== 'running', `the offload to ${dest} settling`);
      return getOffloadJob(jobId) as OffloadJob;
    });
    return { job, entries: (await getOffloadIndex()).entries.filter((e) => e.destRoot === dest) };
  } finally {
    undo();
  }
}

/** Each recorded copy of a file in `folder`, by name, with its `originalKept` as recorded. */
function keptIn(entries: OffloadEntry[], folder: string): Record<string, unknown> {
  return Object.fromEntries(entries.filter((e) => path.dirname(e.originalPath) === folder).map((e) => [e.name, e.originalKept]).sort());
}

test('the copies of a folder left in place because it gained a file during the copy say their originals were kept - the folder trashed beside it says nothing', async () => {
  const { folders: [projA, projB], scan } = projects('gained', ['projA', 'projB']);
  const before = trashedPaths.length;
  const { job, entries } = await offload('gained', scan, [projA, projB], () => {
    const late = path.join(projA, 'made-during-the-copy.txt');
    if (!fs.existsSync(late)) fs.writeFileSync(late, 'written while the offload ran');
  });
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(trashedPaths.slice(before), [projB], 'only the folder that gained nothing went to the Trash');
  assert.deepEqual(keptIn(entries, projA), { 'a.txt': true, 'b.txt': true }, 'its copies are recorded, their originals kept');
  assert.deepEqual(keptIn(entries, projB), { 'a.txt': undefined, 'b.txt': undefined }, 'the trashed folder\'s copies carry no such field');
});

test('the copies of an original the Trash would not take say it was kept - the one it took says nothing', async () => {
  const { folders: [projA, projB], scan } = projects('refused', ['projA', 'projB']);
  refused.add(projA);
  try {
    const { job, entries } = await offload('refused', scan, [projA, projB]);
    assert.equal(job.status, 'complete', job.error);
    assert.match(job.error ?? '', /1 original couldn't be moved to the Trash/, job.error);
    assert.ok(fs.existsSync(path.join(projA, 'a.txt')), 'the refused original is in place');
    assert.deepEqual(keptIn(entries, projA), { 'a.txt': true, 'b.txt': true }, job.error);
    assert.deepEqual(keptIn(entries, projB), { 'a.txt': undefined, 'b.txt': undefined }, job.error);
  } finally {
    refused.delete(projA);
  }
});

test('when an original is found open at the trash step, every original of the job stays, and every copy says so', async () => {
  const { folders: [projA, projB], scan } = projects('open', ['projA', 'projB']);
  const provider = platform() as unknown as { getOpenHandlesBatch: (paths: string[]) => Promise<unknown> };
  const before = trashedPaths.length;
  const { job, entries } = await offload('open', scan, [projA, projB], () => {
    // Opened after the offload's own check before the copy: the trash step's check finds it.
    provider.getOpenHandlesBatch = async () => ({ handles: [{ path: projA, pid: process.pid + 1, processName: 'Preview' }], complete: true });
  });
  assert.equal(job.status, 'complete', job.error);
  assert.match(job.error ?? '', /the originals are still here/, job.error);
  assert.deepEqual(trashedPaths.slice(before), [], 'nothing went to the Trash');
  assert.deepEqual(keptIn(entries, projA), { 'a.txt': true, 'b.txt': true }, job.error);
  assert.deepEqual(keptIn(entries, projB), { 'a.txt': true, 'b.txt': true }, job.error);
});

test('a file selected on its own and moved to the Trash says nothing of being kept', async () => {
  const { folders: [projA], scan } = projects('single', ['projA']);
  const a = path.join(projA, 'a.txt');
  const before = trashedPaths.length;
  const dest = fileTempDir('treemap-offloadOriginalKept-single-dest-');
  const job = await withOpenFileCheck('clear', async () => {
    const prepared = await prepareOffload(scan, [a], dest);
    const { jobId } = await startOffload(scan, [a], dest, prepared);
    await waitFor(() => getOffloadJob(jobId)?.status !== 'running', 'the offload settling');
    return getOffloadJob(jobId) as OffloadJob;
  });
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(trashedPaths.slice(before), [a]);
  const [entry] = (await getOffloadIndex()).entries.filter((e) => e.destRoot === dest);
  assert.equal(entry?.originalPath, a);
  assert.equal('originalKept' in entry, false, 'no field at all, as every entry an earlier build recorded');
});

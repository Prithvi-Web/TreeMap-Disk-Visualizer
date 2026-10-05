import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-offloadLeftBehind-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createScanRecord } from '../src/services/diskScanner';
import { cancelAllOffloadJobs, getOffloadIndex, getOffloadJob, prepareOffload, startOffload, startRestore } from '../src/services/offload';
import { setTrashStepForTests } from '../src/services/cleaner';
import { setCopyFaultForTests } from '../src/utils/copyVerify';
import type { OffloadJob } from '../src/models/types';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';
import { isRestoreCopyFor, restorePartialsIn } from './fixtures/restoreCopy';

/**
 * FG3f #7 (introduced with FG3d #1's CopyLeftBehind). An offload that stopped part-way — cancelled,
 * or failed — rolled back what it had copied "best effort", swallowing every removal that failed,
 * and ignored the copy's own CopyLeftBehind: a cancelled job whose part-copied file could not be
 * removed still ended "cancelled", and the page said "Offload cancelled — everything rolled back".
 * Its restore did the same. Now a job that leaves anything behind ends as an error naming it, never
 * as cancelled.
 *
 * "Could not be removed" is made real: part-way through the big file the folder the job writes into
 * stops taking removals (its mode), and the job is cancelled. Nothing reaches the machine's Trash:
 * the offload's trash step moves each original into this file's own folder.
 */

const SKIP = process.platform === 'win32' ? 'a folder’s mode does not stop a removal on Windows'
  : process.getuid?.() === 0 ? 'running as root, a folder’s mode stops nothing' : false;

const FAKE_TRASH = fileTempDir('treemap-offloadLeftBehind-trash-');
let trashCalls = 0;
const CHUNK = 64 * 1024;
const BIG = 4 * CHUNK;

before(() => {
  setTrashStepForTests(async (p) => {
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashCalls++}-${path.basename(p)}`));
  });
});

after(() => {
  setTrashStepForTests(null);
});

/** A source folder with a small file and a big one (in that order), and a scan record of it. */
function source(label: string): { src: string; small: string; big: string; scan: ReturnType<typeof createScanRecord> } {
  const src = fileTempDir(`treemap-offloadLeftBehind-${label}-src-`);
  const small = path.join(src, 'a-small.bin');
  const big = path.join(src, 'b-big.bin');
  fs.writeFileSync(small, Buffer.alloc(1024, 1));
  fs.writeFileSync(big, Buffer.alloc(BIG, 2));
  const scan = createScanRecord(src);
  scan.status = 'complete';
  scan.root = {
    name: path.basename(src), path: src, size: 1024 + BIG, type: 'dir', modifiedAt: Date.now(), isHidden: false,
    children: [small, big].map((p) => ({ name: path.basename(p), path: p, size: fs.statSync(p).size, type: 'file' as const, modifiedAt: Date.now(), isHidden: false })),
  };
  return { src, small, big, scan };
}

async function settled(job: OffloadJob): Promise<OffloadJob> {
  await waitFor(() => getOffloadJob(job.jobId)?.status !== 'running', 'the job settling');
  return getOffloadJob(job.jobId) as OffloadJob;
}

/** Part-way through copying to `dest`: `locked` stops taking removals, and every job is cancelled. */
function lockAndCancelAt(dest: (d: string) => boolean, locked: string): () => void {
  return setCopyFaultForTests((d, read) => {
    if (!dest(d) || read <= CHUNK) return null;
    fs.chmodSync(locked, 0o500);
    cancelAllOffloadJobs();
    return null;
  });
}

test('a cancelled offload that cannot remove what it copied says so, and is never "cancelled — everything rolled back"', { skip: SKIP }, async () => {
  const { small, big, scan } = source('offload');
  const dest = fileTempDir('treemap-offloadLeftBehind-dest-');
  const unfault = lockAndCancelAt((d) => path.basename(d) === 'b-big.bin', dest);
  let job: OffloadJob;
  try {
    job = await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scan, [small, big], dest);
      return settled(await startOffload(scan, [small, big], dest, prepared));
    });
  } finally {
    unfault();
    fs.chmodSync(dest, 0o700);
  }
  assert.equal(job.status, 'error', `not "cancelled — everything rolled back" (${job.status}: ${job.error})`);
  const left = fs.readdirSync(dest);
  assert.ok(left.length > 0, 'the case is the one under test: something is left at the destination');
  for (const name of left) assert.ok((job.error ?? '').includes(path.join(dest, name)) || (job.error ?? '').includes('more'), `the sentence names what is left (${job.error})`);
  assert.match(job.error ?? '', /could not be removed/, job.error);
  assert.match(job.error ?? '', /nothing was deleted from this computer/i, job.error);
  assert.ok(fs.existsSync(small) && fs.existsSync(big), 'the originals are where they were');
});

test('a cancelled offload that removes everything it copied is still "cancelled"', { skip: SKIP }, async () => {
  const { small, big, scan } = source('clean-cancel');
  const dest = fileTempDir('treemap-offloadLeftBehind-clean-dest-');
  const unfault = setCopyFaultForTests((d, read) => {
    if (path.basename(d) === 'b-big.bin' && read > CHUNK) cancelAllOffloadJobs();
    return null;
  });
  let job: OffloadJob;
  try {
    job = await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scan, [small, big], dest);
      return settled(await startOffload(scan, [small, big], dest, prepared));
    });
  } finally {
    unfault();
  }
  assert.equal(job.status, 'cancelled', job.error);
  assert.deepEqual(fs.readdirSync(dest), [], 'nothing it copied is left');
});

test('a cancelled offload restore that cannot remove its part-copied file says so, and is never "cancelled"', { skip: SKIP }, async () => {
  const { src, small, big, scan } = source('restore');
  const dest = fileTempDir('treemap-offloadLeftBehind-restore-dest-');
  const done = await withOpenFileCheck('clear', async () => {
    const prepared = await prepareOffload(scan, [small, big], dest);
    return settled(await startOffload(scan, [small, big], dest, prepared));
  });
  assert.equal(done.status, 'complete', done.error);
  assert.ok(!fs.existsSync(big), 'the originals went to the (stand-in) Trash');
  const ids = (await getOffloadIndex()).entries.filter((e) => e.originalPath === big).map((e) => e.id);
  assert.equal(ids.length, 1);

  // The restore writes beside the file's name until its copy verifies (FG3f #8).
  const unfault = lockAndCancelAt((d) => isRestoreCopyFor(d, big), src);
  let job: OffloadJob;
  try {
    job = await settled(await startRestore(ids));
  } finally {
    unfault();
    fs.chmodSync(src, 0o700);
  }
  assert.equal(job.status, 'error', `not "cancelled" (${job.status}: ${job.error})`);
  const [partial] = restorePartialsIn(src);
  assert.ok(partial, 'the case is the one under test: the part-copied file is still there, beside the name');
  assert.ok(!fs.existsSync(big), 'and nothing stands at the name itself');
  assert.ok((job.error ?? '').includes(partial), `the sentence names it (${job.error})`);
  assert.match(job.error ?? '', /could not be removed/, job.error);
});

test('while an offload restore copies a file, nothing stands at the file’s name (FG3f #8)', async () => {
  const { src, small, big, scan } = source('restore-partial');
  const dest = fileTempDir('treemap-offloadLeftBehind-restore-partial-dest-');
  const done = await withOpenFileCheck('clear', async () => {
    const prepared = await prepareOffload(scan, [small, big], dest);
    return settled(await startOffload(scan, [small, big], dest, prepared));
  });
  assert.equal(done.status, 'complete', done.error);
  const ids = (await getOffloadIndex()).entries.filter((e) => e.originalPath === big).map((e) => e.id);
  let atItsName: boolean | null = null;
  const unhook = setCopyFaultForTests((d, read) => {
    if (atItsName === null && isRestoreCopyFor(d, big) && read > CHUNK) atItsName = fs.existsSync(big);
    return null;
  });
  let job: OffloadJob;
  try {
    job = await settled(await startRestore(ids));
  } finally {
    unhook();
  }
  assert.equal(atItsName, false, 'part-way through the copy, nothing stands at its name');
  assert.equal(job.status, 'complete', job.error);
  assert.ok(fs.readFileSync(big).equals(Buffer.alloc(BIG, 2)), 'once it verifies it is there, whole');
  assert.deepEqual(restorePartialsIn(src), [], 'with nothing left beside it');
});

/* ─────────────── FG3g L5: a restore's temporary file that could not be removed is named ─────────────── */

/** An offloaded big file, its original gone, and its record's id. */
async function offloadedBig(label: string): Promise<{ src: string; big: string; dest: string; id: string }> {
  const { src, small, big, scan } = source(label);
  const dest = fileTempDir(`treemap-offloadLeftBehind-${label}-dest-`);
  const done = await withOpenFileCheck('clear', async () => {
    const prepared = await prepareOffload(scan, [small, big], dest);
    return settled(await startOffload(scan, [small, big], dest, prepared));
  });
  assert.equal(done.status, 'complete', done.error);
  const entry = (await getOffloadIndex()).entries.find((e) => e.originalPath === big);
  assert.ok(entry);
  return { src, big, dest, id: entry.id };
}

for (const [label, prepare] of [
  ['its placement fails', (_: { dest: string }) => undefined],
  ['its copy no longer matches its fingerprint', ({ dest }: { dest: string }) => {
    const copy = path.join(dest, 'b-big.bin');
    fs.writeFileSync(copy, Buffer.alloc(BIG, 9)); // the same size, other bytes: bit rot on the drive
  }],
] as const) {
  test(`an offload restore whose temporary file cannot be removed after ${label} names it, as left behind (FG3g L5)`, { skip: SKIP }, async () => {
    const { src, big, dest, id } = await offloadedBig(`l5-${label.split(' ')[1]}`);
    prepare({ dest });
    // Part-way through the copy, the folder it writes into stops taking new names and removals.
    let locked = false;
    const unfault = setCopyFaultForTests((d, read) => {
      if (!locked && isRestoreCopyFor(d, big) && read > CHUNK) {
        locked = true;
        fs.chmodSync(src, 0o500);
      }
      return null;
    });
    let job: OffloadJob;
    try {
      job = await settled(await startRestore([id]));
    } finally {
      unfault();
      fs.chmodSync(src, 0o700);
    }
    const [partial] = restorePartialsIn(src);
    assert.ok(partial, 'the case is the one under test: the temporary file is still there');
    assert.equal(job.status, 'error');
    assert.ok((job.error ?? '').includes(partial), `the sentence names it (${job.error})`);
    assert.match(job.error ?? '', /could not be removed/, job.error);
  });
}

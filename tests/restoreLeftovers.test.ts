import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
const DATA = isolatedDataDir('treemap-restoreLeftovers-data-');
process.env.TREEMAP_NO_GDU = '1';

import { getCapsuleJob, protectItems, startCapsuleMaintenance, startCapsuleRestore, stopCapsuleMaintenance } from '../src/services/timeCapsule';
import { recordRestorePartial, sweepRestoreLeftovers } from '../src/services/restoreLeftovers';
import { createScanRecord } from '../src/services/diskScanner';
import { getOffloadIndex, getOffloadJob, prepareOffload, startOffload, startRestore } from '../src/services/offload';
import { setTrashStepForTests } from '../src/services/cleaner';
import { withOpenFileCheck } from './fixtures/openFileCheck';
import { setCopyFaultForTests, setHardLinkForTests } from '../src/utils/copyVerify';
import { waitFor, withinHangGuard } from './fixtures/waitFor';
import { isRestoreCopyFor } from './fixtures/restoreCopy';

/**
 * FG3g L4 (the crash-leftover sweep). A restore writes each file beside its name under
 * `.treemap-restore-…` and puts it there only once it verifies (FG3f #8), so a quit or a kill part-way
 * leaves no part-copied file at the person's own name — but it left that temporary file beside it,
 * and nothing ever removed it. Now each one is recorded in app-data, with the file it was made as
 * (device and id), before anything is written into it; the record goes once nothing of it is left;
 * and at the next start whatever is still recorded is removed — only a name TreeMap recorded, and
 * only while it is still that same file. A name it never recorded, or one that is something else
 * now, is left alone.
 */

const JOURNAL = path.join(DATA, 'restore-leftovers.jsonl');

function records(): { path: string; id: string }[] {
  if (!fs.existsSync(JOURNAL)) return [];
  return fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { path: string; id: string });
}

function identity(p: string): string {
  const st = fs.lstatSync(p, { bigint: true });
  return `${st.dev}:${st.ino}`;
}

async function settled(jobId: string): Promise<{ status?: string; error?: string }> {
  await waitFor(() => getCapsuleJob(jobId)?.status !== 'running', 'the restore settling');
  return getCapsuleJob(jobId) ?? {};
}

async function capturedFile(label: string, content: string): Promise<{ file: string; id: string }> {
  const file = path.join(fileTempDir(`treemap-restoreLeftovers-${label}-`), 'kept.txt');
  fs.writeFileSync(file, content);
  const { outcomes } = await protectItems([{ path: file }]);
  assert.equal(outcomes[0].protected, true, outcomes[0].detail);
  fs.rmSync(file);
  return { file, id: outcomes[0].entryId as string };
}

test('a restore records each temporary file, as the file it was made, before writing into it — and the record goes once the file has', async () => {
  const { file, id } = await capturedFile('recorded', 'the content of kept.txt');
  let seen: { recorded: boolean; asMade: boolean } | null = null;
  const unhook = setCopyFaultForTests((dest) => {
    if (seen === null && isRestoreCopyFor(dest, file) && dest !== file) {
      const record = records().find((r) => r.path === dest);
      seen = { recorded: record !== undefined, asMade: record?.id === identity(dest) };
    }
    return null;
  });
  let job: { status?: string; error?: string };
  try {
    job = await settled((await startCapsuleRestore([id])).jobId);
  } finally {
    unhook();
  }
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(seen, { recorded: true, asMade: true }, 'recorded, with the file it was made as, by the time its bytes were written');
  assert.deepEqual(records(), [], 'and once it was put in place, nothing of it is left to record');
});

test('an offload restore records its temporary file the same way', async () => {
  const src = fileTempDir('treemap-restoreLeftovers-offload-src-');
  const file = path.join(src, 'away.bin');
  fs.writeFileSync(file, Buffer.alloc(4096, 3));
  const scan = createScanRecord(src);
  scan.status = 'complete';
  scan.root = {
    name: path.basename(src), path: src, size: 4096, type: 'dir', modifiedAt: Date.now(), isHidden: false,
    children: [{ name: 'away.bin', path: file, size: 4096, type: 'file', modifiedAt: Date.now(), isHidden: false }],
  };
  const trash = fileTempDir('treemap-restoreLeftovers-trash-');
  setTrashStepForTests(async (p) => { fs.renameSync(p, path.join(trash, path.basename(p))); });
  try {
    const dest = fileTempDir('treemap-restoreLeftovers-offload-dest-');
    await withOpenFileCheck('clear', async () => {
      const prepared = await prepareOffload(scan, [file], dest);
      const job = await startOffload(scan, [file], dest, prepared);
      await waitFor(() => getOffloadJob(job.jobId)?.status !== 'running', 'the offload');
      assert.equal(getOffloadJob(job.jobId)?.status, 'complete', getOffloadJob(job.jobId)?.error);
    });
  } finally {
    setTrashStepForTests(null);
  }
  const entry = (await getOffloadIndex()).entries.find((e) => e.originalPath === file);
  assert.ok(entry);
  let seen: { recorded: boolean; asMade: boolean } | null = null;
  const unhook = setCopyFaultForTests((dest) => {
    if (seen === null && isRestoreCopyFor(dest, file) && dest !== file) {
      const record = records().find((r) => r.path === dest);
      seen = { recorded: record !== undefined, asMade: record?.id === identity(dest) };
    }
    return null;
  });
  try {
    const { jobId } = await startRestore([entry.id]);
    await waitFor(() => getOffloadJob(jobId)?.status !== 'running', 'the restore');
    assert.equal(getOffloadJob(jobId)?.status, 'complete', getOffloadJob(jobId)?.error);
  } finally {
    unhook();
  }
  assert.deepEqual(seen, { recorded: true, asMade: true });
  assert.deepEqual(records(), [], 'and its record went once the file was in place');
});

test('at the next start, a recorded temporary file still as it was made is removed; one that is something else now, or never recorded, is left alone', async () => {
  const dir = fileTempDir('treemap-restoreLeftovers-start-');
  const left = path.join(dir, '.treemap-restore-aaaa0001');
  const replaced = path.join(dir, '.treemap-restore-aaaa0002');
  const unrecorded = path.join(dir, '.treemap-restore-aaaa0003');
  fs.writeFileSync(left, 'part of a file, left by a restore that was killed');
  fs.writeFileSync(replaced, 'part of a file');
  fs.writeFileSync(unrecorded, 'a file TreeMap never recorded');
  await recordRestorePartial(left, identity(left));
  await recordRestorePartial(replaced, identity(replaced));
  fs.rmSync(replaced);
  fs.writeFileSync(path.join(dir, 'spare'), 'keeps the old id taken'); // so the new file cannot reuse it
  fs.writeFileSync(replaced, 'something else, saved at that name since');
  assert.notEqual(identity(replaced), records().find((r) => r.path === replaced)?.id);

  startCapsuleMaintenance(); // what the server does at start
  try {
    await waitFor(() => !fs.existsSync(left), 'the start-up sweep removing the leftover');
  } finally {
    stopCapsuleMaintenance();
  }
  await waitFor(() => records().length === 0, 'the sweep dropping its records');
  assert.equal(fs.readFileSync(replaced, 'utf8'), 'something else, saved at that name since', 'what stands there now is not the file that was made');
  assert.equal(fs.readFileSync(unrecorded, 'utf8'), 'a file TreeMap never recorded', 'and a name never recorded is never touched');
});

test('the sweep never removes the temporary file of a restore under way', async () => {
  const { file, id } = await capturedFile('under-way', 'the content of a file being restored');
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let partial = '';
  const unlink = setHardLinkForTests(async (existing, link) => {
    partial = existing;
    arrive();
    await gate;
    await fs.promises.link(existing, link);
  });
  try {
    const { jobId } = await startCapsuleRestore([id]);
    await withinHangGuard(reached, 'the restore reaching its placement');
    const swept = await sweepRestoreLeftovers();
    assert.deepEqual(swept.removed, [], 'nothing is removed while a restore runs');
    assert.ok(fs.existsSync(partial), 'its temporary file is still there');
    release();
    const job = await settled(jobId);
    assert.equal(job.status, 'complete', job.error);
    assert.equal(fs.readFileSync(file, 'utf8'), 'the content of a file being restored');
  } finally {
    release();
    unlink();
  }
});

test('a record naming anything but a restore\'s temporary name is never acted on, whatever it says of the file', async () => {
  const dir = fileTempDir('treemap-restoreLeftovers-planted-');
  const precious = path.join(dir, 'thesis.docx');
  fs.writeFileSync(precious, 'a file a record was planted for');
  // As a record written by anything but TreeMap: the right identity, but not a name TreeMap gives.
  fs.appendFileSync(JOURNAL, `${JSON.stringify({ path: precious, id: identity(precious) })}\n`);
  const swept = await sweepRestoreLeftovers();
  assert.deepEqual(swept.removed, []);
  assert.equal(fs.readFileSync(precious, 'utf8'), 'a file a record was planted for');
});

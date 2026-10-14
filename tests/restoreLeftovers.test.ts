import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
const DATA = isolatedDataDir('treemap-restoreLeftovers-data-');
process.env.TREEMAP_NO_GDU = '1';

import { getCapsuleJob, protectItems, startCapsuleMaintenance, startCapsuleRestore, stopCapsuleMaintenance } from '../src/services/timeCapsule';
import { pendingRecords, recordRestorePartial, restorePlacementHooks, sweepRestoreLeftovers } from '../src/services/restoreLeftovers';
import { createScanRecord } from '../src/services/diskScanner';
import { getOffloadIndex, getOffloadJob, prepareOffload, startOffload, startRestore } from '../src/services/offload';
import { setTrashStepForTests } from '../src/services/cleaner';
import { withOpenFileCheck } from './fixtures/openFileCheck';
import { setCopyFaultForTests, setHardLinkForTests } from '../src/utils/copyVerify';
import { waitFor, withinHangGuard } from './fixtures/waitFor';
import { isRestoreCopyFor } from './fixtures/restoreCopy';
import { destinationsOnAnotherDrive } from './fixtures/offloadDrive';
destinationsOnAnotherDrive(); // every destination here stands for another drive (E01)

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
  // Dropped by the compaction that runs once the job has ended, which may finish after the job says
  // so (FG3g review F1.7): waited for, never read the moment the status changes.
  await waitFor(() => records().length === 0, 'once it was put in place, nothing of it left to record');
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
  await waitFor(() => records().length === 0, 'its record going once the file was in place');
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

const SKIP_MODES = process.platform === 'win32'
  ? 'a folder\'s permissions cannot hide its names on Windows'
  : process.getuid?.() === 0 ? 'running as root, a folder\'s mode hides nothing (FG3g review F2.15)' : false;

test('the tidying after a restore keeps the record of a temporary file still there, and of one whose place cannot be looked at: the next start removes both (FG3g review F1.9)', { skip: SKIP_MODES }, async () => {
  const dir = fileTempDir('treemap-restoreLeftovers-kept-');
  const stillThere = path.join(dir, '.treemap-restore-bbbb0001'); // left by a restore that could not remove it, or a crash
  fs.writeFileSync(stillThere, 'part of a file nothing removed');
  await recordRestorePartial(stillThere, identity(stillThere));
  const hidden = path.join(dir, 'locked');
  fs.mkdirSync(hidden);
  const unseen = path.join(hidden, '.treemap-restore-bbbb0002');
  fs.writeFileSync(unseen, 'part of a file in a folder that cannot be looked into');
  await recordRestorePartial(unseen, identity(unseen));
  const planted = [stillThere, unseen];
  const { file, id } = await capturedFile('kept', 'the content of a file put back while the others wait');
  fs.chmodSync(hidden, 0o000); // its names can no longer be looked at
  try {
    const job = await settled((await startCapsuleRestore([id])).jobId);
    assert.equal(job.status, 'complete', job.error);
    assert.equal(fs.readFileSync(file, 'utf8'), 'the content of a file put back while the others wait');
    // The restore recorded its own temporary file before it settled: once that record is gone, the tidying has run.
    await waitFor(() => records().every((r) => planted.includes(r.path)), 'the tidying after the restore');
    assert.deepEqual(records().map((r) => r.path).sort(), [...planted].sort(), 'both records stay for the sweep: one file is still there, the other could not be looked at');
  } finally {
    fs.chmodSync(hidden, 0o700);
  }
  const swept = await sweepRestoreLeftovers();
  assert.deepEqual(swept.removed.sort(), [...planted].sort(), 'the next start removes them');
  assert.ok(!fs.existsSync(stillThere) && !fs.existsSync(unseen));
  assert.deepEqual(records(), []);
});

test('an empty file a restore held at an item\'s own name is removed at the next start only while it is still that empty file, and never once it was settled (FG3g review F1.1, FG3h D)', async () => {
  const dir = fileTempDir('treemap-restoreLeftovers-held-');
  const left = path.join(dir, 'report.docx'); // the person's own name: held, then a kill
  const grown = path.join(dir, 'notes.txt'); // held, then written into by something else
  const settledName = path.join(dir, 'empty.txt'); // held, and the file put over it is as empty
  for (const p of [left, grown, settledName]) fs.writeFileSync(p, '');
  for (const p of [left, grown, settledName]) await restorePlacementHooks(p).onHeld(identity(p));
  fs.writeFileSync(grown, 'written into the held name since'); // the same file, no longer empty
  await restorePlacementHooks(settledName).onPlacedOverHeld(identity(settledName));
  const swept = await sweepRestoreLeftovers();
  assert.deepEqual(swept.removed, [left], JSON.stringify(swept));
  assert.equal(fs.existsSync(left), false, 'the empty file a kill left at the name is gone');
  assert.equal(fs.readFileSync(grown, 'utf8'), 'written into the held name since', 'one written into since is never removed');
  assert.ok(fs.existsSync(settledName), 'and one whose placement finished is never taken for a leftover, though as empty and the same id');
  assert.deepEqual(records(), [], 'nothing is left to record');
});

test('a held name\'s record is acted on only while it names an empty file: a planted one for a file with content is never acted on', async () => {
  const precious = path.join(fileTempDir('treemap-restoreLeftovers-planted-held-'), 'thesis.docx');
  fs.writeFileSync(precious, 'a file a record was planted for');
  fs.appendFileSync(JOURNAL, `${JSON.stringify({ path: precious, id: identity(precious), kind: 'placeholder' })}\n`);
  const swept = await sweepRestoreLeftovers();
  assert.deepEqual(swept.removed, []);
  assert.equal(fs.readFileSync(precious, 'utf8'), 'a file a record was planted for');
});

test('a held name\'s record spelled in any way TreeMap does not record a place - or under a system folder - is never acted on, though it names an empty file (FG3g review F2.11)', async () => {
  const dir = fileTempDir('treemap-restoreLeftovers-spelled-');
  const empty = path.join(dir, 'empty.txt'); // a person's own empty file
  fs.writeFileSync(empty, '');
  fs.mkdirSync(path.join(dir, 'x'));
  const sep = path.sep;
  const spellings = [
    `${dir}${sep}x${sep}..${sep}empty.txt`, // through a folder and back
    `${dir}${sep}${sep}empty.txt`, // a doubled separator
    `${dir}${sep}.${sep}empty.txt`, // through "."
    `${empty}${sep}`, // a trailing separator
  ];
  for (const spelled of spellings) {
    fs.appendFileSync(JOURNAL, `${JSON.stringify({ path: spelled, id: identity(empty), kind: 'placeholder' })}\n`);
  }
  const system = process.platform === 'win32' ? 'C:\\Windows\\System32\\treemap-held' : '/dev/treemap-held';
  fs.appendFileSync(JOURNAL, `${JSON.stringify({ path: system, id: identity(empty), kind: 'placeholder' })}\n`);
  const swept = await sweepRestoreLeftovers();
  assert.deepEqual(swept.removed, [], JSON.stringify(swept));
  assert.ok(fs.existsSync(empty), 'the person\'s empty file is still there');
  assert.deepEqual(records().filter((r) => [...spellings, system].includes(r.path)), [], 'and no such record is kept for a later start');
});

test('the start-up sweep never removes what another TreeMap still running recorded; it removes what one that has ended left (FG3h D)', async () => {
  const dir = fileTempDir('treemap-restoreLeftovers-pid-');
  const live = path.join(dir, '.treemap-restore-cccc0001');
  const ended = path.join(dir, '.treemap-restore-cccc0002');
  fs.writeFileSync(live, 'a restore under way in another TreeMap');
  fs.writeFileSync(ended, 'left by a TreeMap that has ended');
  // A process that has ended: its id is no longer running (a child, run to its end).
  const gone = spawnSync(process.execPath, ['-e', ''], { env: { ...process.env } }).pid;
  assert.ok(typeof gone === 'number');
  fs.appendFileSync(JOURNAL, `${JSON.stringify({ path: live, id: identity(live), pid: process.ppid })}\n`); // the runner that started this file: running
  fs.appendFileSync(JOURNAL, `${JSON.stringify({ path: ended, id: identity(ended), pid: gone })}\n`);
  const swept = await sweepRestoreLeftovers();
  assert.deepEqual(swept.removed, [ended], JSON.stringify(swept));
  assert.ok(fs.existsSync(live), 'the live restore\'s temporary file is still there');
  assert.match(swept.kept.find((k) => k.path === live)?.why ?? '', /still running/, JSON.stringify(swept.kept));
  assert.deepEqual(records().map((r) => r.path), [live], 'and its record stays for a later start');
  fs.rmSync(live);
  await sweepRestoreLeftovers(); // gone now: the record goes
  assert.deepEqual(records(), []);
});

test('every record a restore writes names the process that wrote it', async () => {
  const { file, id } = await capturedFile('pid', 'the content of a file whose restore is recorded');
  let pids: (number | undefined)[] = [];
  const unhook = setCopyFaultForTests(() => {
    if (pids.length === 0) {
      pids = fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { path: string; pid?: number })
        .filter((r) => path.dirname(r.path) === path.dirname(file)).map((r) => r.pid);
    }
    return null;
  });
  try {
    const job = await settled((await startCapsuleRestore([id])).jobId);
    assert.equal(job.status, 'complete', job.error);
  } finally {
    unhook();
  }
  assert.ok(pids.length > 0 && pids.every((p) => p === process.pid), JSON.stringify(pids));
});

/* ─────────────── FG3g review F2.4: reading the journal is linear in its lines ─────────────── */

/**
 * A restore of a large folder onto a volume without hard links writes three lines a file (its
 * temporary copy, the empty file held at its name, and the line settling that one), and each settled
 * line was resolved by a scan of every record before it: 50,000 files took seconds of the event loop
 * at the end of the job and at the next start. Counted here, never timed: every read of a record's
 * path or id while the journal is resolved, against a bound linear in its lines.
 */
test('the journal of one restore of many files is resolved in work linear in its lines, keeping exactly the records no later line settled', () => {
  let reads = 0;
  const counted = <T extends object>(fields: T & { path: string; id: string }): T => {
    const { path: p, id, ...rest } = fields;
    return Object.defineProperties({ ...rest }, {
      path: { enumerable: true, get: () => { reads++; return p; } },
      id: { enumerable: true, get: () => { reads++; return id; } },
    }) as unknown as T;
  };
  const n = 3000;
  const dir = path.join(path.sep, 'restored');
  const lines: Parameters<typeof pendingRecords>[0][number][] = [];
  for (let i = 0; i < n; i++) {
    const name = path.join(dir, `file-${i}.txt`);
    lines.push(counted({ path: path.join(dir, `.treemap-restore-${i.toString(16).padStart(8, '0')}`), id: `1:${2 * i}`, pid: 1 }));
    lines.push(counted({ path: name, id: `1:${2 * i + 1}`, kind: 'placeholder' as const, pid: 1 }));
    lines.push(counted({ path: name, id: `1:${2 * i + 1}`, settled: true as const }));
  }
  // A settled line drops only the earlier records of the same place and file: not another file at
  // that place, and not a record that comes after it.
  const shared = path.join(dir, 'shared.txt');
  lines.push(counted({ path: shared, id: '2:1', kind: 'placeholder' as const }));
  lines.push(counted({ path: shared, id: '2:2', kind: 'placeholder' as const }));
  lines.push(counted({ path: shared, id: '2:1', settled: true as const }));
  lines.push(counted({ path: shared, id: '2:1', kind: 'placeholder' as const }));
  reads = 0;
  const pending = pendingRecords(lines);
  const bound = 4 * lines.length;
  assert.ok(reads <= bound, `${reads} reads of a record's place or file to resolve ${lines.length} lines: not linear in the journal (bound ${bound})`);
  const ids = pending.map((r) => r.id);
  assert.equal(pending.length, n + 2, 'every temporary copy\'s record, and of the shared place\'s, the two no line settled');
  assert.deepEqual(ids.slice(0, 3), ['1:0', '1:2', '1:4'], 'the temporary copies\' records, in order');
  assert.deepEqual(ids.slice(-2), ['2:2', '2:1'], 'another file at a settled place is kept, and so is a record after the line that settled one');
});

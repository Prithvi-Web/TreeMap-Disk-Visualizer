import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-restoreCancelWords-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createScanRecord } from '../src/services/diskScanner';
import { cancelAllOffloadJobs, getOffloadIndex, getOffloadJob, prepareOffload, startOffload, startRestore } from '../src/services/offload';
import { setTrashStepForTests } from '../src/services/cleaner';
import { setCopyFaultForTests, setHardLinkForTests } from '../src/utils/copyVerify';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import type { OffloadJob } from '../src/models/types';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';
import { isRestoreCopyFor } from './fixtures/restoreCopy';
import { destinationsOnAnotherDrive } from './fixtures/offloadDrive';
destinationsOnAnotherDrive(); // every destination here stands for another drive (E01)

/**
 * A cancelled Restore (hunt C49). The Offloaded tab's Restore was followed by the offload's own
 * watcher, so its Cancel said "Offload cancelled — everything rolled back, nothing was deleted" and a
 * shutdown "the job rolled back safely" — yet a restore never takes back a file it put back. And the
 * server called a restore cancelled whenever the cancel flag was set by its end, even when every file
 * had been put back. Now a restore that put every file back is complete, a cancelled one's frame
 * says how many it had restored, and the page says what a restore did: the files already restored
 * stay where they are.
 *
 * Nothing reaches the machine's Trash: the trash step moves each original into this file's own folder.
 */

const FAKE_TRASH = fileTempDir('treemap-restoreCancelWords-trash-');
let trashCount = 0;
before(() => {
  setTrashStepForTests(async (p) => {
    trashCount++;
    fs.renameSync(p, path.join(FAKE_TRASH, `${trashCount}-${path.basename(p)}`));
  });
});
after(() => setTrashStepForTests(null));

async function settled(jobId: string): Promise<OffloadJob> {
  await waitFor(() => getOffloadJob(jobId)?.status !== 'running', `the job ${jobId} settling`);
  return getOffloadJob(jobId) as OffloadJob;
}

/** `names` offloaded from a new folder; answers the originals (now in the stand-in Trash) and their record ids. */
async function offloaded(label: string, names: string[]): Promise<{ files: string[]; ids: string[] }> {
  const src = fs.realpathSync(fileTempDir(`treemap-restoreCancelWords-${label}-src-`));
  const dest = fileTempDir(`treemap-restoreCancelWords-${label}-dest-`);
  const files = names.map((name, i) => {
    const p = path.join(src, name);
    fs.writeFileSync(p, Buffer.alloc(1024, i + 1));
    return p;
  });
  const scan = createScanRecord(src);
  scan.status = 'complete';
  scan.root = {
    name: path.basename(src), path: src, size: 1024 * files.length, type: 'dir', modifiedAt: Date.now(), isHidden: false,
    children: files.map((p) => ({ name: path.basename(p), path: p, size: 1024, type: 'file' as const, modifiedAt: Date.now(), isHidden: false })),
  };
  const job = await withOpenFileCheck('clear', async () => {
    const prepared = await prepareOffload(scan, files, dest);
    return settled((await startOffload(scan, files, dest, prepared)).jobId);
  });
  assert.equal(job.status, 'complete', job.error);
  const entries = (await getOffloadIndex()).entries;
  return { files, ids: files.map((f) => (entries.find((e) => e.originalPath === f) as { id: string }).id) };
}

test('a Cancel that arrives after a restore put its every file back leaves it complete, not "cancelled"', async () => {
  const { files, ids } = await offloaded('late', ['one.bin']);
  const undo = setHardLinkForTests(async (a, b) => {
    cancelAllOffloadJobs(); // while the verified copy is being put in place
    await fsp.link(a, b);
  });
  let job: OffloadJob;
  try {
    job = await settled((await startRestore(ids)).jobId);
  } finally {
    undo();
  }
  assert.ok(fs.existsSync(files[0]), 'the file is back');
  assert.equal(job.status, 'complete', 'every file was put back, so the restore is complete');
  assert.equal(job.filesDone, 1);
});

test('a Cancel that arrives after the last file was tried leaves a restore with a failure an error that names it, not "cancelled"', async () => {
  const { files, ids } = await offloaded('latefail', ['taken.bin', 'free.bin']);
  fs.writeFileSync(files[0], 'something else stands at this name now'); // its restore is refused as occupied
  const undo = setHardLinkForTests(async (a, b) => {
    if (b === files[1]) cancelAllOffloadJobs(); // while the last file is put in place
    await fsp.link(a, b);
  });
  let job: OffloadJob;
  try {
    job = await settled((await startRestore(ids)).jobId);
  } finally {
    undo();
  }
  assert.ok(fs.existsSync(files[1]), 'the free one is back');
  assert.equal(job.status, 'error', 'every file was tried: the Cancel stopped nothing');
  assert.match(job.error ?? '', /1 of 2 couldn't be restored — taken\.bin: something already exists/, job.error);
});

test('a Cancel that cuts the last file\'s copy short is a cancelled restore that put nothing back, not a failure', async () => {
  const { files, ids } = await offloaded('cutshort', ['only.bin']);
  const undo = setCopyFaultForTests((dest) => {
    if (isRestoreCopyFor(dest, files[0])) cancelAllOffloadJobs(); // during the copy of the only file
    return null;
  });
  let job: OffloadJob;
  try {
    job = await settled((await startRestore(ids)).jobId);
  } finally {
    undo();
  }
  assert.equal(job.status, 'cancelled', job.error);
  assert.equal(job.filesDone, 0);
  assert.ok(!fs.existsSync(files[0]), 'nothing was put back');
});

test('a Cancel that lands between two files, with no copy under way, stops the restore there: cancelled, the later files never tried (review F1.17)', async () => {
  const { files, ids } = await offloaded('between', ['first.bin', 'second.bin', 'third.bin']);
  const undo = setHardLinkForTests(async (a, b) => {
    if (b === files[0]) cancelAllOffloadJobs(); // while the first file is put in place: no copy is running to stop
    await fsp.link(a, b);
  });
  let job: OffloadJob;
  try {
    job = await settled((await startRestore(ids)).jobId);
  } finally {
    undo();
  }
  assert.equal(job.status, 'cancelled', `the Cancel stopped two files from being tried: ${job.error}`);
  assert.equal(job.filesDone, 1);
  assert.ok(fs.existsSync(files[0]), 'the file put back before the Cancel stays');
  assert.deepEqual([files[1], files[2]].map((f) => fs.existsSync(f)), [false, false], 'the later files were never tried');
});

/** The frames of an offload job's progress stream, read until the server ends it. */
async function framesOf(jobId: string): Promise<Record<string, unknown>[]> {
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as { port: number }).port;
    const text = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: `/api/offload/${jobId}/progress`, method: 'GET' }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => resolve(buf));
      });
      req.on('error', reject);
      req.end();
    });
    return text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('a restore cancelled part-way is "cancelled", and its frame says how many files it had already put back', async () => {
  const { files, ids } = await offloaded('mid', ['a.bin', 'b.bin', 'c.bin']);
  const undo = setCopyFaultForTests((dest) => {
    if (isRestoreCopyFor(dest, files[1]) && fs.existsSync(files[0])) cancelAllOffloadJobs();
    return null;
  });
  let job: OffloadJob;
  try {
    job = await settled((await startRestore(ids)).jobId);
  } finally {
    undo();
  }
  assert.equal(job.status, 'cancelled');
  assert.equal(job.filesDone, 1);
  assert.deepEqual(files.map((f) => fs.existsSync(f)), [true, false, false], 'the file already put back stays');
  const frames = await framesOf(job.jobId);
  assert.deepEqual(frames.at(-1), { type: 'cancelled', filesDone: 1 }, 'the stream says how many were put back');
});

/* ---------- the page's words (read as built: public/index.html) ---------- */

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function slice(from: string, to: string): string {
  const start = INDEX.indexOf(from);
  assert.notEqual(start, -1, `anchor not found: ${from}`);
  const end = INDEX.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `end anchor not found: ${to}`);
  return INDEX.slice(start, end);
}

/** The toasts a job's watcher shows for `frame`, followed as `runRestoreJob` or `startOffloadFlow`'s watcher follows it. */
function toastsFor(kind: 'restore' | 'offload', frame: Record<string, unknown>): string[] {
  const toasts: string[] = [];
  const streams: { onmessage: ((m: { data: string }) => void) | null }[] = [];
  class FakeEventSource {
    static CLOSED = 2;
    readyState = 1;
    onmessage: ((m: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { streams.push(this); }
    close(): void { this.readyState = 2; }
  }
  const el = () => ({ innerHTML: '', textContent: '', style: {}, classList: { add() {}, remove() {} } });
  const source = `${slice('function watchJob(opts)', "$('offloadCancelBtn')")}; return { watchOffloadJob };`;
  const { watchOffloadJob } = new Function(
    'EventSource', '$', 'icon', 'OFFLOAD_PHASE_LABEL', 'FxBeam', 'closeModal', 'toast', 'formatCount', 'formatBytes', 'loadOffloadIndex', 'activeJob',
    source,
  )(FakeEventSource, el, () => '', { checking: 'Checking' }, { attach() {} }, () => undefined, (m: string) => toasts.push(m), (n: number) => String(n), (n: number) => `${n} B`, () => undefined, null) as {
    watchOffloadJob: (id: string, title: string, done: () => void, kind?: string) => void;
  };
  watchOffloadJob('job-1', kind === 'restore' ? 'Restoring…' : 'Offloading…', () => undefined, kind);
  assert.equal(streams.length, 1, 'the job is followed');
  streams[0].onmessage?.({ data: JSON.stringify(frame) });
  return toasts;
}

test('a cancelled Restore says the files it had already put back stay where they are, never that an offload rolled back', () => {
  const some = toastsFor('restore', { type: 'cancelled', filesDone: 2 }).join(' | ');
  assert.match(some, /Restore stopped — 2 files already restored stay where they are/, some);
  assert.doesNotMatch(some, /Offload|rolled back/, some);
  const one = toastsFor('restore', { type: 'cancelled', filesDone: 1 }).join(' | ');
  assert.match(one, /Restore stopped — 1 file already restored stays where it is/, one);
  const none = toastsFor('restore', { type: 'cancelled', filesDone: 0 }).join(' | ');
  assert.match(none, /Restore cancelled — nothing was restored/, none);
});

test('an offload\'s Cancel still says it rolled back, and a shutdown claims no rollback that has not happened', () => {
  assert.match(toastsFor('offload', { type: 'cancelled' }).join(' | '), /Offload cancelled — everything rolled back, nothing was deleted/);
  const restoreShutdown = toastsFor('restore', { type: 'shutdown' }).join(' | ');
  assert.match(restoreShutdown, /the restore was stopped before it finished; files it had already restored stay where they are/, restoreShutdown);
  const offloadShutdown = toastsFor('offload', { type: 'shutdown' }).join(' | ');
  assert.doesNotMatch(offloadShutdown, /rolled back/, offloadShutdown);
  assert.match(offloadShutdown, /the offload was stopped before it finished/, offloadShutdown);
});

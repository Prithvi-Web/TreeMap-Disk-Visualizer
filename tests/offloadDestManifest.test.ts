import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
const APP = isolatedDataDir('treemap-offloadDestManifest-data-');
process.env.TREEMAP_NO_GDU = '1';

import { execFileSync } from 'node:child_process';

import { createApp } from '../src/server';
import { SPILL_DIR } from '../src/services/spillSweep';
import { startScan } from '../src/services/diskScanner';
import { getOffloadJob, setDestRecordFloorForTests } from '../src/services/offload';
import { setLaunchStepForTests, setTrashStepForTests } from '../src/services/cleaner';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import type { OffloadJob } from '../src/models/types';
import { waitFor } from './fixtures/waitFor';

/**
 * Follow-up FG3, items 1, 4 and 6. An offload keeps a copy of its record on the destination drive,
 * `<dest>/treemap-offload-manifest.json`: a folder someone else may have prepared (a shared or
 * second-hand drive). It used to read the record there, merge its entries, and write
 * `<dest>/treemap-offload-manifest.json.tmp` with a plain write — so a link at that name, or a
 * second name for another file, made an ordinary offload overwrite any file: the local offload
 * manifest (with a crafted entry), agent-policy.json, the Time Capsule's index, a file of the
 * user's in no scanned root. Now the temp is made exclusively under a random name and renamed
 * onto the record; a record's name that is not a plain file of one name is refused and not read;
 * and only the drive's entries of that destination are kept. An offload restore writes to a
 * place its record names, so the record is held to the shape TreeMap writes, and never into
 * app-data.
 *
 * Nothing reaches the machine's Trash (each original an offload trashes goes into this file's own
 * folder), and nothing is launched.
 */

const SCANNED = path.join(fileTempDir('treemap-offloadDestManifest-scanned-'), 'scanned');
fs.mkdirSync(SCANNED);
const FAKE_TRASH = fileTempDir('treemap-offloadDestManifest-trash-');
const IMPORTANT = path.join(fileTempDir('treemap-offloadDestManifest-important-'), 'report.doc');
const PRECIOUS = 'PRECIOUS USER DATA';
fs.writeFileSync(IMPORTANT, PRECIOUS);
const DEST_MANIFEST = 'treemap-offload-manifest.json';

const launched: string[] = [];
let server: http.Server;
let port: number;
let offloads = 0;

before(async () => {
  setTrashStepForTests(async (p) => {
    fs.renameSync(p, path.join(FAKE_TRASH, `${crypto.randomUUID()}-${path.basename(p)}`));
  });
  setLaunchStepForTests(async (command) => {
    launched.push(command.args.join(' '));
  });
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  setTrashStepForTests(null);
  setLaunchStepForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function request(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  resetRateLimiter();
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1', port, path: url, method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try { parsed = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** A new destination folder. */
function destination(label: string): string {
  return fileTempDir(`treemap-offloadDestManifest-${label}-`);
}

/** Offload one new file of the scanned folder to `dest`, over HTTP, and wait for the job. */
async function offloadOne(dest: string): Promise<OffloadJob> {
  const name = `file-${++offloads}.txt`;
  fs.writeFileSync(path.join(SCANNED, name), `the content of ${name}`);
  const scan = await startScan(SCANNED);
  await waitFor(() => scan.status !== 'running', 'the scan');
  const started = await request('POST', '/api/offload', { scanId: scan.scanId, paths: [path.join(SCANNED, name)], dest });
  assert.equal(started.status, 202, JSON.stringify(started.body).slice(0, 200));
  let job: OffloadJob | undefined;
  await waitFor(() => (job = getOffloadJob(started.body.jobId)) !== undefined && job.status !== 'running', 'the offload job');
  return job as OffloadJob;
}

const read = (p: string): string => fs.readFileSync(p, 'utf8');
const driveEntries = (dest: string): { id: string; destPath: string }[] =>
  (JSON.parse(read(path.join(dest, DEST_MANIFEST))) as { entries: { id: string; destPath: string }[] }).entries;

/* ─────────────── 1. The record on the drive ─────────────── */

test('a link or a second name planted at the old temp name is never written through', async () => {
  // Seed the files a planted name would reach: an earlier offload makes the local manifest.
  await offloadOne(destination('seed'));
  const policy = path.join(APP, 'agent-policy.json');
  fs.writeFileSync(policy, JSON.stringify({ protectedPaths: ['/nowhere/protected'] }));
  const capsule = path.join(APP, 'timecapsule.json');
  fs.writeFileSync(capsule, JSON.stringify({ version: 1, entries: [], events: [] }));
  const targets: [string, string, 'symlink' | 'hardlink'][] = [
    ['the local offload manifest', path.join(APP, 'offload-manifest.json'), 'symlink'],
    ['agent-policy.json', policy, 'symlink'],
    ['a file of the user in no scanned root', IMPORTANT, 'symlink'],
    ['the Time Capsule index', capsule, 'symlink'],
    ['agent-policy.json, by a second name (a hard link)', policy, 'hardlink'],
  ];
  for (const [what, target, kind] of targets) {
    const dest = destination('temp-link');
    const planted = path.join(dest, `${DEST_MANIFEST}.tmp`);
    if (kind === 'symlink') fs.symlinkSync(target, planted, 'file');
    else fs.linkSync(target, planted);
    const before = read(target);
    const job = await offloadOne(dest);
    assert.equal(job.status, 'complete', `${what}: ${job.error ?? ''}`);
    if (target === path.join(APP, 'offload-manifest.json')) {
      // The offload writes its own entry there, so the file changes; what matters is whose write was
      // last. The drive's record has no `destinations` — TreeMap's local one always does.
      assert.ok('destinations' in (JSON.parse(read(target)) as object), `${what} was last written by TreeMap, not through the planted name`);
    } else {
      assert.equal(read(target), before, `${what} is byte for byte what it was`);
    }
    assert.equal(kind === 'symlink' ? fs.lstatSync(planted).isSymbolicLink() : fs.statSync(planted).nlink === 2, true, `${what}: the planted name is left as it was`);
    assert.ok(fs.lstatSync(path.join(dest, DEST_MANIFEST)).isFile(), `${what}: the record is a file of its own`);
    assert.equal(driveEntries(dest).length, 1, `${what}: listing the one copy made there`);
  }
});

test('a record whose own name is a link or a second name is refused, and never read', async () => {
  for (const kind of ['symlink', 'hardlink'] as const) {
    const dest = destination(`final-${kind}`);
    const record = path.join(dest, DEST_MANIFEST);
    if (kind === 'symlink') fs.symlinkSync(IMPORTANT, record, 'file');
    else fs.linkSync(IMPORTANT, record);
    const job = await offloadOne(dest);
    assert.equal(job.status, 'complete', 'the offload itself went through');
    assert.match(job.error ?? '', /record on the destination was not written/, `${kind}: and says what it did not do`);
    assert.equal(read(IMPORTANT), PRECIOUS, `${kind}: the file the name leads to is untouched`);
    assert.equal(kind === 'symlink' ? fs.lstatSync(record).isSymbolicLink() : fs.statSync(record).nlink === 2, true, `${kind}: the name is left as it was`);
  }
});

test('the drive\'s record keeps every entry it already holds, verbatim — another mount\'s spelling included — and none of it reaches the local record (FG3b)', async () => {
  // Nothing in TreeMap reads the drive's record back: it is written, never followed. So an entry
  // written while the drive was mounted elsewhere (another drive letter, "/Volumes/X 1", another
  // machine) is kept as it stands, and so is anything else in it, rather than dropped for good.
  const dest = destination('verbatim');
  const inside = path.join(dest, 'kept.txt');
  fs.writeFileSync(inside, 'an earlier copy');
  const good = { id: 'earlier', name: 'kept.txt', originalPath: path.join(SCANNED, 'kept.txt'), destPath: inside, destRoot: dest, size: 1, hash: 'h', offloadedAt: 1 };
  const earlier: unknown[] = [
    good,
    { ...good, id: 'remounted', destRoot: '/Volumes/Old Name/Archive', destPath: '/Volumes/Old Name/Archive/kept.txt' },
    { ...good, id: 'other-letter', destRoot: 'E:\\Archive', destPath: 'E:\\Archive\\w.mov' },
    { ...good, id: 'hosts', destRoot: '/', destPath: '/etc/hosts' },
    { ...good, id: 'elsewhere', destPath: IMPORTANT },
    { ...good, id: 'not-text', destPath: 5 },
    { ...good, id: 7, destRoot: ['/x'] },
    { ...good, id: 'relative', originalPath: 'relative/x' },
    'not an entry',
    null,
  ];
  fs.writeFileSync(path.join(dest, DEST_MANIFEST), JSON.stringify({ entries: earlier }));
  const job = await offloadOne(dest);
  assert.equal(job.status, 'complete', job.error);
  assert.equal(job.error, undefined, 'nothing to report');
  const after = (JSON.parse(read(path.join(dest, DEST_MANIFEST))) as { entries: unknown[] }).entries;
  assert.deepEqual(after.slice(0, earlier.length), earlier, 'every earlier entry, as it was');
  assert.equal(after.length, earlier.length + 1, 'and the new one');
  const local = JSON.parse(read(path.join(APP, 'offload-manifest.json'))) as { entries: { id: unknown }[] };
  assert.deepEqual(local.entries.filter((e) => ['earlier', 'remounted', 'other-letter', 'hosts', 'elsewhere', 7].includes(e.id as string)), [], 'none of it is taken into the local record');
});

test('merging the drive\'s record does no file system work per entry: 5,000 entries are carried with no look at any of them (FG3b)', async () => {
  // Counted, not timed: every realpath and lstat the server makes while the offload runs.
  const dest = destination('many');
  const many = Array.from({ length: 5_000 }, (_, i) => ({
    id: `e-${i}`, name: 'x', originalPath: path.join(SCANNED, `gone-${i}.txt`), destRoot: dest,
    destPath: path.join(dest, `missing-${i}`, 'deeper', 'x.txt'), size: 1, hash: 'h', offloadedAt: 1,
  }));
  fs.writeFileSync(path.join(dest, DEST_MANIFEST), JSON.stringify({ entries: many }));
  // The module objects every file of the server shares, written through views that let them be:
  // each realpath, lstat and stat, synchronous or not.
  type Look = (...args: unknown[]) => unknown;
  const sync = fs as unknown as { lstatSync: Look; statSync: Look; realpathSync: { native: Look } };
  const promised = fs.promises as unknown as { lstat: Look; stat: Look; realpath: Look };
  const real = { native: sync.realpathSync.native, lstatSync: sync.lstatSync, statSync: sync.statSync, lstat: promised.lstat, stat: promised.stat, realpath: promised.realpath };
  let looks = 0;
  const counted = (fn: Look): Look => (...args: unknown[]) => { looks++; return fn(...args); };
  sync.realpathSync.native = counted(real.native);
  sync.lstatSync = counted(real.lstatSync);
  sync.statSync = counted(real.statSync);
  promised.lstat = counted(real.lstat);
  promised.stat = counted(real.stat);
  promised.realpath = counted(real.realpath);
  let job: OffloadJob;
  try {
    job = await offloadOne(dest);
  } finally {
    sync.realpathSync.native = real.native;
    sync.lstatSync = real.lstatSync;
    sync.statSync = real.statSync;
    promised.lstat = real.lstat;
    promised.stat = real.stat;
    promised.realpath = real.realpath;
  }
  assert.equal(job.status, 'complete', job.error);
  assert.ok(looks < 1_000, `${looks} looks for a record of ${many.length} entries: none of them per entry`);
  assert.equal((JSON.parse(read(path.join(dest, DEST_MANIFEST))) as { entries: unknown[] }).entries.length, many.length + 1, 'every entry kept, and the new one');
});

test('a record on the drive that cannot be read whole is never replaced: it is kept beside the new one, and the job says so (FG3b)', async () => {
  const cases: [string, (record: string) => void, RegExp][] = [
    ['larger than a record TreeMap reads', (record) => { fs.writeFileSync(record, ''); fs.truncateSync(record, 33 * 1024 * 1024); }, /larger than/],
    ['not JSON', (record) => fs.writeFileSync(record, 'not json at all'), /not JSON/],
    ['not a list of entries', (record) => fs.writeFileSync(record, JSON.stringify({ entries: 'none' })), /not a list of entries/],
  ];
  for (const [what, plant, why] of cases) {
    const dest = destination('unreadable');
    const record = path.join(dest, DEST_MANIFEST);
    plant(record);
    const was = fs.readFileSync(record);
    const job = await offloadOne(dest);
    assert.equal(job.status, 'complete', `${what}: ${job.error ?? ''}`);
    assert.match(job.error ?? '', why, `${what}: the job says why (${job.error})`);
    const aside = fs.readdirSync(dest).filter((n) => n.startsWith(`${DEST_MANIFEST.replace(/\.json$/, '')}.`) && n !== DEST_MANIFEST);
    assert.equal(aside.length, 1, `${what}: the earlier record is kept beside (${fs.readdirSync(dest).join(', ')})`);
    assert.ok(fs.readFileSync(path.join(dest, aside[0])).equals(was), `${what}: byte for byte`);
    assert.ok((job.error ?? '').includes(aside[0]), `${what}: and the job names where`);
    assert.equal(driveEntries(dest).length, 1, `${what}: the new record lists the copy made there`);
  }
});

/** The names beside the drive's record that a write set aside. */
const setAside = (dest: string): string[] => fs.readdirSync(dest).filter((n) => n.startsWith(`${DEST_MANIFEST.replace(/\.json$/, '')}.unreadable-`));

test('the drive\'s record of this machine\'s own offloads is read whole however large it grows - never set aside, a new copy on every offload (final review F2.4)', async () => {
  // The record grows with every file offloaded to the drive, and TreeMap's own record now keeps every
  // file still offloaded (F1.9): past the 32 MiB it read whole — some 50,000 files — every offload set
  // TreeMap's own record aside as "could not be read whole", leaving another ~50 MB copy on the drive
  // each time. The size read whole regardless is lowered here, so a few entries pass it.
  const dest = destination('own-grows');
  const first = await offloadOne(dest);
  assert.equal(first.error, undefined, first.error);
  const stop = setDestRecordFloorForTests(fs.statSync(path.join(dest, DEST_MANIFEST)).size + 1);
  try {
    for (let n = 2; n <= 4; n++) {
      const job = await offloadOne(dest);
      assert.equal(job.status, 'complete', job.error);
      assert.equal(job.error, undefined, `offload ${n}: nothing to report (${job.error})`);
    }
  } finally {
    stop();
  }
  assert.deepEqual(setAside(dest), [], 'nothing was set aside');
  assert.equal(driveEntries(dest).length, 4, 'one record, listing every copy made there');
});

test('a record on the drive far larger than this machine\'s own entries there is still kept beside a new one, never read whole (final review F2.4)', async () => {
  const dest = destination('foreign-big');
  const record = path.join(dest, DEST_MANIFEST);
  // Entries another machine wrote — many times what this machine has there.
  const foreign = Array.from({ length: 200 }, (_, i) => ({
    id: `other-${i}`, name: `f-${i}`, originalPath: `/Users/other/f-${i}`, destRoot: dest, destPath: path.join(dest, `f-${i}`), size: 1, hash: 'h', offloadedAt: 1,
  }));
  fs.writeFileSync(record, JSON.stringify({ entries: foreign }, null, 2));
  const was = fs.readFileSync(record);
  const stop = setDestRecordFloorForTests(1024);
  let job: OffloadJob;
  try {
    job = await offloadOne(dest);
  } finally {
    stop();
  }
  assert.equal(job.status, 'complete', job.error);
  assert.match(job.error ?? '', /could not be read whole \(it is larger than/, `the job says why (${job.error})`);
  const aside = setAside(dest);
  assert.equal(aside.length, 1, `kept beside (${fs.readdirSync(dest).join(', ')})`);
  assert.ok(fs.readFileSync(path.join(dest, aside[0])).equals(was), 'byte for byte');
  assert.equal(driveEntries(dest).length, 1, 'the new record lists the copy made there');
});

/** A record whose entries JSON reads but cannot write back: nested past what JSON.stringify recurses through. */
const DEEP = 50_000;
const tooDeep = `{"entries":[${'['.repeat(DEEP)}${']'.repeat(DEEP)}]}`;
const DEEP_THROWS = ((): boolean => {
  try {
    JSON.stringify(JSON.parse(tooDeep), null, 2);
    return false;
  } catch {
    return true;
  }
})();

test('a record whose entries cannot be written back is kept beside a new one, rather than freezing the drive\'s record (FG3c #8)', {
  skip: DEEP_THROWS ? false : 'this runtime writes back a record nested that deep',
}, async () => {
  const dest = destination('too-deep');
  const record = path.join(dest, DEST_MANIFEST);
  fs.writeFileSync(record, tooDeep);
  const was = fs.readFileSync(record);
  const job = await offloadOne(dest);
  assert.equal(job.status, 'complete', job.error);
  const aside = fs.readdirSync(dest).filter((n) => n.startsWith(`${DEST_MANIFEST.replace(/\.json$/, '')}.`) && n !== DEST_MANIFEST);
  assert.equal(aside.length, 1, `the earlier record is kept beside (${fs.readdirSync(dest).join(', ')})`);
  assert.ok(fs.readFileSync(path.join(dest, aside[0])).equals(was), 'byte for byte');
  assert.ok((job.error ?? '').includes(aside[0]), `and the job names where (${job.error})`);
  assert.equal(driveEntries(dest).length, 1, 'the new record lists the copy made there');
});

test('a record that could not be written says so, even when nothing was set aside (FG3c #8)', async () => {
  const dest = destination('no-space');
  type Open = (...args: unknown[]) => Promise<unknown>;
  const promised = fs.promises as unknown as { open: Open };
  const realOpen = promised.open;
  promised.open = (...args: unknown[]) => (/\.treemap-offload-manifest\.json\..*\.tmp$/.test(String(args[0]))
    ? Promise.reject(Object.assign(new Error('ENOSPC: no space left on device, open'), { code: 'ENOSPC' }))
    : realOpen(...args));
  let job: OffloadJob;
  try {
    job = await offloadOne(dest);
  } finally {
    promised.open = realOpen;
  }
  assert.equal(job.status, 'complete', 'the copies are made, and the offload went through');
  assert.match(job.error ?? '', /record on the destination/, `the job says the record was not written (${job.error})`);
  assert.ok(!fs.existsSync(path.join(dest, DEST_MANIFEST)), 'and none was');
});

test('a record that is there but cannot be opened is never replaced (FG3b)', { skip: process.platform === 'win32' ? 'Windows ignores a file\'s mode bits' : process.getuid?.() === 0 ? 'root may open any file' : false }, async () => {
  const dest = destination('unopenable');
  const record = path.join(dest, DEST_MANIFEST);
  fs.writeFileSync(record, JSON.stringify({ entries: [{ id: 'mine-alone' }] }));
  fs.chmodSync(record, 0o000);
  let job: OffloadJob;
  try {
    job = await offloadOne(dest);
  } finally {
    fs.chmodSync(record, 0o600);
  }
  assert.equal(job.status, 'complete');
  assert.match(job.error ?? '', /record on the destination was not written: .* could not be opened/, `the job says so (${job.error})`);
  assert.equal(read(record), JSON.stringify({ entries: [{ id: 'mine-alone' }] }), 'and the record is as it was');
});

test('a record whose name is not a file (a FIFO) is refused, never opened to wait on (FG3b)', { skip: process.platform === 'win32' ? 'no FIFOs on Windows' : false }, async () => {
  const dest = destination('fifo');
  const record = path.join(dest, DEST_MANIFEST);
  execFileSync('mkfifo', [record]);
  const job = await offloadOne(dest);
  assert.equal(job.status, 'complete', 'the offload itself went through, and did not hang');
  assert.match(job.error ?? '', /record on the destination was not written: .* is not a file/, `and says what it did not do (${job.error})`);
  assert.ok(fs.lstatSync(record).isFIFO(), 'the name is left as it was');
});

/* ─────────────── 4. An offload restore ─────────────── */

test('an offload restore never writes into app-data, and holds a record to the shape TreeMap writes', async () => {
  const dest = destination('restore');
  const payload = JSON.stringify({ policies: [{ id: 'planted', approvedAt: 1 }] });
  const copy = path.join(dest, 'payload.json');
  fs.writeFileSync(copy, payload);
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  const entry = { name: 'x', size: payload.length, hash, offloadedAt: 1, destRoot: dest, destPath: copy };
  const legitOriginal = path.join(SCANNED, 'restored-here.json');
  const systemPlace = process.platform === 'win32' ? 'C:\\Windows\\System32\\treemap-restored.json' : '/dev/treemap-restored.json';
  const records = [
    { ...entry, id: 'into-app-data', originalPath: path.join(APP, 'autopilot.json') },
    { ...entry, id: 'copy-outside-its-destination', originalPath: path.join(SCANNED, 'a.json'), destPath: IMPORTANT },
    { ...entry, id: 'not-text', originalPath: 5 },
    { ...entry, id: 'relative', originalPath: 'relative/x.json' },
    { ...entry, id: 'into-spill', originalPath: path.join(APP, SPILL_DIR, 'spilled.json') },
    { ...entry, id: 'system-folder', originalPath: systemPlace },
    { ...entry, id: 'respelled', originalPath: `${path.join(SCANNED, 'sub')}${path.sep}..${path.sep}respelled.json` },
    { ...entry, id: 'legit', originalPath: legitOriginal },
  ];
  const manifest = path.join(APP, 'offload-manifest.json');
  const saved = read(manifest);
  // Written by the test into its own app-data: what a record that was tampered with holds.
  fs.writeFileSync(manifest, JSON.stringify({ entries: [...(JSON.parse(saved) as { entries: unknown[] }).entries, ...records], destinations: {} }));
  const restore = async (id: string): Promise<OffloadJob> => {
    const started = await request('POST', '/api/offload/restore', { ids: [id] });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    let job: OffloadJob | undefined;
    await waitFor(() => (job = getOffloadJob(started.body.jobId)) !== undefined && job.status !== 'running', `the restore of ${id}`);
    return job as OffloadJob;
  };
  const expectations: [string, RegExp][] = [
    ['into-app-data', /TreeMap's own app-data folder/],
    ['copy-outside-its-destination', /outside the destination it was offloaded to/],
    ['not-text', /not a record TreeMap wrote/],
    ['relative', /not a record TreeMap wrote/],
    ['into-spill', /TreeMap's own spill folder/],
    ['system-folder', /is a system folder TreeMap never writes/],
    ['respelled', /not a record TreeMap wrote/],
  ];
  // The dry run passes every record through the check the real run makes (FG3b): it lists only
  // what the real run would restore, and each refusal with its reason.
  const dry = await request('POST', '/api/offload/restore', { ids: records.map((r) => r.id), dryRun: true });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.deepEqual(dry.body.wouldRestore.map((e: { id: string }) => e.id), ['legit'], 'only the record of the right shape would be restored');
  assert.equal(dry.body.bytesTotal, payload.length);
  for (const [id, why] of expectations) {
    const refusal = (dry.body.refused as { id: string; reason: string }[]).find((r) => r.id === id);
    assert.match(refusal?.reason ?? '', why, `the dry run names ${id}'s refusal (${JSON.stringify(dry.body.refused)})`);
  }
  for (const [id, why] of expectations) {
    const job = await restore(id);
    assert.equal(job.status, 'error', id);
    assert.match(job.error ?? '', why, `${id}: ${job.error}`);
  }
  assert.ok(!fs.existsSync(path.join(APP, 'autopilot.json')), 'nothing was written into app-data');
  const legit = await restore('legit');
  assert.equal(legit.status, 'complete', legit.error);
  assert.equal(read(legitOriginal), payload, 'a record of the right shape restores as before');
});

/* ─────────────── 6. The reveal of a record that is not text ─────────────── */

test('the offload reveal refuses a record whose paths are not text, rather than failing', async () => {
  const manifest = path.join(APP, 'offload-manifest.json');
  const current = JSON.parse(read(manifest)) as { entries: unknown[] };
  const base = { name: 'x', originalPath: '/x', size: 1, hash: 'h', offloadedAt: 1 };
  fs.writeFileSync(manifest, JSON.stringify({
    entries: [...current.entries, { ...base, id: 'root-not-text', destRoot: 7, destPath: '/x/y' }, { ...base, id: 'path-not-text', destRoot: '/x', destPath: ['/x/y'] }],
    destinations: {},
  }));
  const before = launched.length;
  for (const id of ['root-not-text', 'path-not-text']) {
    const answer = await request('POST', '/api/offload/reveal', { id });
    assert.deepEqual([answer.status, answer.body.code], [403, 'OUTSIDE_DEST_ROOT'], `${id}: ${JSON.stringify(answer.body)}`);
  }
  assert.equal(launched.length, before, 'nothing was launched');
});

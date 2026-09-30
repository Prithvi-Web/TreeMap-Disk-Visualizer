import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
const APP = isolatedDataDir('treemap-offloadDestManifest-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { startScan } from '../src/services/diskScanner';
import { getOffloadJob } from '../src/services/offload';
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

test('the drive\'s record keeps only entries of that destination, and says how many it dropped', async () => {
  const dest = destination('crafted');
  const inside = path.join(dest, 'kept.txt');
  fs.writeFileSync(inside, 'an earlier copy');
  const good = { id: 'earlier', name: 'kept.txt', originalPath: path.join(SCANNED, 'kept.txt'), destPath: inside, destRoot: dest, size: 1, hash: 'h', offloadedAt: 1 };
  fs.writeFileSync(path.join(dest, DEST_MANIFEST), JSON.stringify({
    entries: [
      good,
      { ...good, id: 'hosts', destRoot: '/', destPath: '/etc/hosts' },
      { ...good, id: 'elsewhere', destPath: IMPORTANT },
      { ...good, id: 'not-text', destPath: 5 },
      { ...good, id: 'relative', originalPath: 'relative/x' },
      'not an entry',
    ],
  }));
  const logged: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  let job: OffloadJob;
  try {
    job = await offloadOne(dest);
  } finally {
    console.error = log;
  }
  assert.equal(job.status, 'complete', job.error);
  const ids = driveEntries(dest).map((e) => e.id);
  assert.equal(ids.length, 2, `the earlier entry and the new one (${ids.join(', ')})`);
  assert.ok(ids.includes('earlier'));
  assert.ok(logged.some((line) => /5 entries .* dropped/.test(line)), `the drop is counted (${logged.join(' | ')})`);
  // And nothing of the drive's reaches the local record.
  const local = JSON.parse(read(path.join(APP, 'offload-manifest.json'))) as { entries: { id: string }[] };
  assert.deepEqual(local.entries.filter((e) => ['earlier', 'hosts', 'elsewhere'].includes(e.id)), []);
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
  const records = [
    { ...entry, id: 'into-app-data', originalPath: path.join(APP, 'autopilot.json') },
    { ...entry, id: 'copy-outside-its-destination', originalPath: path.join(SCANNED, 'a.json'), destPath: IMPORTANT },
    { ...entry, id: 'not-text', originalPath: 5 },
    { ...entry, id: 'relative', originalPath: 'relative/x.json' },
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
  ];
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

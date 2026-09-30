import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
const APP = isolatedDataDir('treemap-capsuleRecords-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { capsuleRoot, getCapsuleIndex, getCapsuleJob, pruneExpired, reconcileCapsule } from '../src/services/timeCapsule';
import { commitCart, undoCartRun } from '../src/services/cartCommit';
import { approvePolicy, listPolicies, runPolicy, savePolicies } from '../src/services/autopilot';
import { setTrashStepForTests } from '../src/services/cleaner';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { SPILL_DIR } from '../src/services/spillSweep';
import { platform } from '../src/platform';
import { invalidateCapabilities } from '../src/platform/capabilities';
import type { TimeCapsuleEntry } from '../src/models/types';
import { waitFor } from './fixtures/waitFor';

/**
 * Follow-up FG3, item 3. The Time Capsule's index (timecapsule.json), each entry's manifest.json and
 * Autopilot's autopilot.json are files on disk, and what they record becomes a path TreeMap removes,
 * reads or writes: an entry's id names its folder (`rm -rf` on a forget, an expiry or an eviction),
 * its original place is where a restore writes, a manifest's names place each file, and a policy's
 * folder is what an unattended run scans and deletes in. An index record with the id
 * `../../../victim` made `DELETE /api/timecapsule/<id>` remove a folder outside app-data. Each is now
 * held to the shape TreeMap writes before it is used.
 *
 * Nothing reaches the machine's Trash (the trash step moves each file into this file's own folder),
 * and the open-file check an unattended run makes answers "nothing open" here.
 */

const FAKE_TRASH = fileTempDir('treemap-capsuleRecords-trash-');
const PLACE = fileTempDir('treemap-capsuleRecords-place-');
const INDEX = path.join(APP, 'timecapsule.json');

let server: http.Server;
let port: number;
const provider = platform() as unknown as {
  getOpenHandlesBatch: (paths: string[]) => Promise<unknown>;
  probeOpenHandleGuard: () => Promise<unknown>;
};
const realBatch = provider.getOpenHandlesBatch.bind(provider);
const realProbe = provider.probeOpenHandleGuard.bind(provider);

before(async () => {
  setTrashStepForTests(async (p) => {
    fs.renameSync(p, path.join(FAKE_TRASH, `${crypto.randomUUID()}-${path.basename(p)}`));
  });
  provider.getOpenHandlesBatch = () => Promise.resolve({ handles: [], complete: true });
  provider.probeOpenHandleGuard = () => Promise.resolve({ available: true, mechanism: 'test' });
  invalidateCapabilities();
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  setTrashStepForTests(null);
  provider.getOpenHandlesBatch = realBatch;
  provider.probeOpenHandleGuard = realProbe;
  invalidateCapabilities();
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

const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

/** An index record as capture writes one, with `over` applied. */
function record(over: Partial<TimeCapsuleEntry>): TimeCapsuleEntry {
  return {
    id: crypto.randomUUID(), name: 'x.txt', originalPath: path.join(PLACE, `absent-${crypto.randomUUID()}.txt`), kind: 'file',
    sizeBytes: 11, heldBytes: 11, hasPayload: true, fileCount: 1, digest: '', capturedAt: Date.now(), ...over,
  };
}

/** The index as it stands, with `entries` added — written by the test into its own app-data. */
function plant(...entries: TimeCapsuleEntry[]): void {
  const current = fs.existsSync(INDEX)
    ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) as { entries: TimeCapsuleEntry[]; events: unknown[] }
    : { entries: [], events: [] };
  fs.writeFileSync(INDEX, JSON.stringify({ version: 1, entries: [...current.entries, ...entries], events: current.events }));
}

const listed = async (id: string): Promise<TimeCapsuleEntry | undefined> => (await getCapsuleIndex()).entries.find((e) => e.id === id);

/**
 * A folder outside app-data holding what a capsule entry's folder holds: a manifest.json naming one
 * file, and that file under data/. An index record whose id leads here would restore it, or remove it.
 */
function victimFolder(label: string): { dir: string; id: string; payload: string } {
  const dir = path.join(fileTempDir(`treemap-capsuleRecords-${label}-`), 'victim');
  const payload = `planted by ${label}`;
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'x.txt'), payload);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    originalPath: '/unused', name: 'x.txt', members: [{ rel: '', kind: 'file', size: payload.length, hash: sha256(payload) }],
  }));
  return { dir, id: path.relative(capsuleRoot(), dir), payload };
}

function assertIntact(victim: { dir: string; payload: string }, what: string): void {
  assert.equal(fs.readFileSync(path.join(victim.dir, 'data', 'x.txt'), 'utf8'), victim.payload, `${what}: the folder the id leads to is untouched`);
}

/* ─────────────── An id is the shape TreeMap gives one ─────────────── */

test('forgetting a record whose id leads out of the capsule removes nothing on disk, and forgets the record', async () => {
  const victim = victimFolder('forget');
  assert.ok(victim.id.startsWith('..'), `the id leads out of the capsule (${victim.id})`);
  plant(record({ id: victim.id }));
  const answer = await request('DELETE', `/api/timecapsule/${encodeURIComponent(victim.id)}`);
  assert.deepEqual([answer.status, answer.body], [200, { deleted: true, bytesFreed: 0 }], JSON.stringify(answer.body));
  assertIntact(victim, 'DELETE');
  assert.equal(await listed(victim.id), undefined, 'and the record is gone from the index');
});

test('an expired record whose id leads out of the capsule removes nothing on disk when it expires', async () => {
  const victim = victimFolder('expire');
  plant(record({ id: victim.id, capturedAt: 1 }));
  const pruned = await pruneExpired();
  assert.ok(pruned.removed >= 1);
  assertIntact(victim, 'the expiry');
  assert.equal(await listed(victim.id), undefined);
});

test('restoring a record whose id leads out of the capsule is refused, and nothing is read from there or written', async () => {
  const victim = victimFolder('restore');
  const target = path.join(PLACE, 'restored-from-outside.txt');
  plant(record({ id: victim.id, originalPath: target }));
  const answer = await request('POST', `/api/timecapsule/${encodeURIComponent(victim.id)}/restore`);
  assert.deepEqual([answer.status, answer.body.code], [409, 'CAPSULE_RECORD_INVALID'], JSON.stringify(answer.body));
  assert.match(answer.body.error, /not one TreeMap made/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!fs.existsSync(target), 'nothing was written where the record says');
  assertIntact(victim, 'the restore');
});

test('the start-up sweep marks such a record as holding no copy, and touches nothing it leads to', async () => {
  const victim = victimFolder('sweep');
  plant(record({ id: victim.id }));
  await reconcileCapsule();
  const after = await listed(victim.id);
  assert.equal(after?.hasPayload, false, 'it can no longer be restored');
  assert.equal(after?.heldBytes, 0, 'and holds nothing against the cap');
  assertIntact(victim, 'the sweep');
});

test('an undo passes over a record of its run that is not one TreeMap made, and puts back the rest', async () => {
  const file = path.join(PLACE, 'undo-me.txt');
  fs.writeFileSync(file, 'the content of undo-me.txt');
  const committed = await commitCart([file]);
  assert.deepEqual(committed.trashed, [file]);
  const victim = victimFolder('undo');
  plant(record({ id: victim.id, runId: committed.runId, originalPath: path.join(PLACE, 'never-restored.txt') }));
  const job = await undoCartRun(committed.runId);
  assert.equal(job.entryCount, 1, 'the one copy TreeMap made');
  await waitFor(() => getCapsuleJob(job.jobId)?.status !== 'running', 'the undo');
  assert.equal(getCapsuleJob(job.jobId)?.status, 'complete', getCapsuleJob(job.jobId)?.error);
  assert.equal(fs.readFileSync(file, 'utf8'), 'the content of undo-me.txt');
  assert.ok(!fs.existsSync(path.join(PLACE, 'never-restored.txt')));
  assertIntact(victim, 'the undo');
});

/* ─────────────── A restore writes only where capture would have ─────────────── */

/** A capsule entry of TreeMap's shape, in the capsule, whose manifest the test writes. */
function capsuleEntry(entry: Partial<TimeCapsuleEntry>, manifest: { name: string; members: unknown[] }, files: Record<string, string>): TimeCapsuleEntry {
  const made = record({ name: manifest.name, ...entry });
  const folder = path.join(capsuleRoot(), made.id);
  fs.mkdirSync(path.join(folder, 'data'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, 'data', rel)), { recursive: true });
    fs.writeFileSync(path.join(folder, 'data', rel), content);
  }
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ originalPath: made.originalPath, ...manifest }));
  plant(made);
  return made;
}

test('a restore refuses a record whose names or original place lead anywhere capture would not have written', async () => {
  const outside = path.join(fileTempDir('treemap-capsuleRecords-outside-'), 'report.doc');
  fs.writeFileSync(outside, 'PRECIOUS USER DATA');
  const escape = 'escaped';
  fs.mkdirSync(path.join(PLACE, 'sub'), { recursive: true });
  const cases: [string, TimeCapsuleEntry, string][] = [
    [
      'a member that leads out of the item',
      capsuleEntry({ kind: 'folder', originalPath: path.join(PLACE, 'folder-a') },
        { name: 'folder-a', members: [{ rel: path.join('..', 'escape-a.txt'), kind: 'file', size: escape.length, hash: sha256(escape) }] },
        { 'escape-a.txt': escape }),
      path.join(PLACE, 'escape-a.txt'),
    ],
    [
      'a name that leads out of the copy',
      capsuleEntry({ originalPath: path.join(PLACE, 'from-outside.doc') },
        { name: path.relative(path.join(capsuleRoot(), 'x', 'data'), outside), members: [{ rel: '', kind: 'file', size: 18, hash: sha256('PRECIOUS USER DATA') }] },
        {}),
      path.join(PLACE, 'from-outside.doc'),
    ],
    [
      'an original place spelled with ..',
      capsuleEntry({ originalPath: `${path.join(PLACE, 'sub')}${path.sep}..${path.sep}dotdot.txt` },
        { name: 'dotdot.txt', members: [{ rel: '', kind: 'file', size: escape.length, hash: sha256(escape) }] },
        { 'dotdot.txt': escape }),
      path.join(PLACE, 'dotdot.txt'),
    ],
    [
      'a member under a link the restore itself makes',
      capsuleEntry({ kind: 'folder', originalPath: path.join(PLACE, 'folder-b') },
        {
          name: 'folder-b',
          members: [
            { rel: 'a', kind: 'symlink', size: 0, hash: sha256(path.dirname(outside)), target: path.dirname(outside) },
            { rel: path.join('a', 'through.txt'), kind: 'file', size: escape.length, hash: sha256(escape) },
          ],
        },
        { [path.join('folder-b', 'a', 'through.txt')]: escape }),
      path.join(path.dirname(outside), 'through.txt'),
    ],
    [
      "an original place in TreeMap's own spill folder",
      capsuleEntry({ originalPath: path.join(APP, SPILL_DIR, 'spilled.txt') },
        { name: 'spilled.txt', members: [{ rel: '', kind: 'file', size: escape.length, hash: sha256(escape) }] },
        { 'spilled.txt': escape }),
      path.join(APP, SPILL_DIR, 'spilled.txt'),
    ],
  ];
  for (const [what, entry, wouldWrite] of cases) {
    const answer = await request('POST', `/api/timecapsule/${entry.id}/restore`);
    assert.deepEqual([answer.status, answer.body.code], [409, 'CAPSULE_RECORD_INVALID'], `${what}: ${JSON.stringify(answer.body)}`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(!fs.existsSync(wouldWrite), `${what}: nothing was written`);
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'PRECIOUS USER DATA');
});

/* ─────────────── Autopilot's policy folder, read back from autopilot.json ─────────────── */

test('an Autopilot policy whose folder is not one TreeMap saved does not run, and deletes nothing', async () => {
  const dir = fileTempDir('treemap-capsuleRecords-policy-');
  fs.mkdirSync(path.join(dir, 'sub'));
  const files = ['a.bin', 'b.bin'].map((name) => path.join(dir, name));
  for (const f of files) fs.writeFileSync(f, Buffer.alloc(4096, 1));
  try {
    await savePolicies([{ id: 'planted', name: 'planted', path: dir, match: { kind: 'custom', minBytes: 1 }, dryRunFirst: false, enabled: true }]);
    await approvePolicy('planted');
    // autopilot.json edited on disk, as something other than TreeMap would: the saved folder, respelled.
    const file = path.join(APP, 'autopilot.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { policies: { path: string }[] };
    stored.policies[0].path = `${path.join(dir, 'sub')}${path.sep}..`;
    fs.writeFileSync(file, JSON.stringify(stored));
    const policy = (await listPolicies())[0];
    const run = await runPolicy(policy, { ignoreCooldown: true });
    assert.equal(run.status, 'failed', run.blockedReason);
    assert.match(run.blockedReason ?? '', /not one TreeMap saved/);
    assert.deepEqual([run.items, run.bytesDeleted], [[], 0]);
    for (const f of files) assert.ok(fs.existsSync(f), `${path.basename(f)} is where it was`);
  } finally {
    await savePolicies([]);
  }
});

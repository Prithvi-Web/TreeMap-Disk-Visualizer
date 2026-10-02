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
import { cancelAllCapsuleJobs, capsuleRoot, getCapsuleIndex, getCapsuleJob, manifestRefusal, pruneExpired, reconcileCapsule } from '../src/services/timeCapsule';
import { setCopyFaultForTests } from '../src/utils/copyVerify';
import { apfsNameKey } from '../src/utils/volumeNames';
import { commitCart, undoCartRun } from '../src/services/cartCommit';
import { approvePolicy, assertSavedPolicyPath, listPolicies, runPolicy, savePolicies } from '../src/services/autopilot';
import { AppError } from '../src/middleware/errorHandler';
import { sanitizePath } from '../src/utils/pathSanitizer';
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

test('an undo of a run holding a record whose original place is not a path is refused with a sentence and an audit line, never an internal error (FG3d #6)', async () => {
  const file = path.join(PLACE, 'beside-a-bad-record.txt');
  fs.writeFileSync(file, 'the content of beside-a-bad-record.txt');
  const committed = await commitCart([file]);
  assert.deepEqual(committed.trashed, [file]);
  for (const originalPath of [12345, null, { not: 'a path' }]) {
    const bad = record({ runId: committed.runId, originalPath: originalPath as unknown as string });
    plant(bad);
    const answer = await request('POST', '/api/cart/undo', { runId: committed.runId });
    assert.deepEqual([answer.status, answer.body.code], [409, 'CAPSULE_RECORD_INVALID'], `${JSON.stringify(originalPath)}: ${JSON.stringify(answer.body)}`);
    assert.match(answer.body.error, /not one TreeMap made/, JSON.stringify(originalPath));
    const [line] = (await request('GET', '/api/audit?limit=1')).body.entries as { action: string; outcome: string; code?: string }[];
    assert.deepEqual([line?.action, line?.outcome, line?.code], ['cart.undo', 'refused', 'CAPSULE_RECORD_INVALID'], 'and the refusal is audited');
    assert.ok(!fs.existsSync(file), 'nothing was put back: an undo checks every copy before it restores any');
    const index = JSON.parse(fs.readFileSync(INDEX, 'utf8')) as { entries: TimeCapsuleEntry[] };
    fs.writeFileSync(INDEX, JSON.stringify({ ...index, entries: index.entries.filter((e) => e.id !== bad.id) }));
  }
});

/* ─────────────── A restore writes only where capture would have ─────────────── */

/** A capsule entry of TreeMap's shape, in the capsule, whose manifest the test writes. */
function capsuleEntry(entry: Partial<TimeCapsuleEntry>, manifest: { name: string; members?: unknown[] }, files: Record<string, string>): TimeCapsuleEntry {
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

/** A system folder `sanitizePath` refuses on this platform, and a name in it. */
const SYSTEM_PLACE = process.platform === 'win32' ? 'C:\\Windows\\System32\\treemap-capsuleRecords.txt' : '/dev/treemap-capsuleRecords.txt';

test('a restore refuses, and says why, a record whose original place or manifest is not of a shape capture writes (FG3b)', async () => {
  const content = 'restored';
  const file = { rel: '', kind: 'file', size: content.length, hash: sha256(content) };
  const cases: [string, TimeCapsuleEntry, RegExp][] = [
    ['an original place that is not a full path (cloud://)',
      capsuleEntry({ originalPath: 'cloud://gdrive/from-the-cloud.txt' }, { name: 'from-the-cloud.txt', members: [file] }, { 'from-the-cloud.txt': content }),
      /its original place is not a full path/],
    ['an original place that is not text',
      capsuleEntry({ originalPath: 5 as unknown as string }, { name: 'five.txt', members: [file] }, { 'five.txt': content }),
      /its original place is not a full path/],
    ['an original place in a system folder',
      capsuleEntry({ originalPath: SYSTEM_PLACE }, { name: path.basename(SYSTEM_PLACE), members: [file] }, { [path.basename(SYSTEM_PLACE)]: content }),
      /is a system folder TreeMap never writes/],
    ['a manifest that lists no members',
      capsuleEntry({}, { name: 'x.txt' }, { 'x.txt': content }),
      /it lists no members/],
    ['a member of a kind capture never records',
      capsuleEntry({}, { name: 'x.txt', members: [{ ...file, kind: 'device' }] }, { 'x.txt': content }),
      /a member is not one TreeMap records/],
    ['an item recorded as a link, with a member past it',
      capsuleEntry({ kind: 'folder' }, {
        name: 'linked',
        members: [
          { rel: '', kind: 'symlink', size: PLACE.length, hash: sha256(PLACE), target: PLACE },
          { rel: 'through.txt', kind: 'file', size: content.length, hash: sha256(content) },
        ],
      }, { [path.join('linked', 'through.txt')]: content }),
      /a member lies past a link it records/],
  ];
  for (const [what, entry, why] of cases) {
    const answer = await request('POST', `/api/timecapsule/${entry.id}/restore`);
    assert.deepEqual([answer.status, answer.body.code], [409, 'CAPSULE_RECORD_INVALID'], `${what}: ${JSON.stringify(answer.body)}`);
    assert.match(answer.body.error, why, what);
  }
  assert.ok(!fs.existsSync(path.join(process.cwd(), 'cloud:')), 'nothing was written under the working folder');
});

test('a member past a link the restore makes is refused early where the volume reads the two names as one, and nothing is written through the link either way (FG3b, FG3c)', async () => {
  // What the destination's volume reads as one name (FG3c, measured on this Mac's APFS by
  // tests/volumeNames.test.ts): a Mac volume that folds case folds Unicode forms and case by
  // Unicode's full case folding — ς and σ, ß, ẞ and ss — but not compatibility forms (ｌｉｂ, lib) nor
  // dotless ı; an NTFS folder that folds case uses simple upper case only; Linux compares exactly.
  // Where the names are one, the restore is refused before anything is written; where they are two,
  // it restores both. Either way the link is made last, so nothing is written through it.
  const probe = fileTempDir('treemap-capsuleRecords-fold-probe-');
  fs.writeFileSync(path.join(probe, 'probe'), '');
  const folds = fs.existsSync(path.join(probe, 'PROBE'));
  const outside = fileTempDir('treemap-capsuleRecords-fold-outside-');
  const escape = 'escaped';
  // [what, the link's name, the folder's name, one name on a folding Mac volume, on a folding NTFS folder]
  const variants: [string, string, string, boolean, boolean][] = [
    ['another case', 'a', 'A', true, true],
    ['another Unicode form', '\u00e9', 'e\u0301', true, false],
    ['a final sigma', '\u03b1\u03c2', '\u03b1\u03c3', true, true],
    ['a sharp s', 'stra\u00dfe', 'strasse', true, false],
    ['a capital sharp s', 'ss', '\u1e9e', true, false],
    ['a fullwidth name', '\uff4c\uff49\uff42', 'lib', false, false],
    ['a dotless i', '\u0131', 'I', false, true],
  ];
  for (const [n, [what, link, spelled, onMac, onNtfs]] of variants.entries()) {
    const oneName = folds && (process.platform === 'darwin' ? onMac : process.platform === 'win32' ? onNtfs : false);
    const folder = `fold-${n}`;
    const through = `through-${n}.txt`;
    const entry = capsuleEntry({ kind: 'folder', originalPath: path.join(PLACE, folder) }, {
      name: folder,
      members: [
        { rel: link, kind: 'symlink', size: outside.length, hash: sha256(outside), target: outside },
        { rel: path.join(spelled, through), kind: 'file', size: escape.length, hash: sha256(escape) },
      ],
    }, { [path.join(folder, spelled, through)]: escape });
    const answer = await request('POST', `/api/timecapsule/${entry.id}/restore`);
    if (oneName) {
      assert.deepEqual([answer.status, answer.body.code], [409, 'CAPSULE_RECORD_INVALID'], `${what}: ${JSON.stringify(answer.body)}`);
      assert.match(answer.body.error, /past a link/, what);
    } else {
      assert.equal(answer.status, 202, `${what}: two names here, so it is not refused (${JSON.stringify(answer.body)})`);
      await waitFor(() => getCapsuleJob(answer.body.jobId)?.status !== 'running', `the restore (${what})`);
      assert.equal(getCapsuleJob(answer.body.jobId)?.status, 'complete', `${what}: both are put back (${getCapsuleJob(answer.body.jobId)?.error})`);
      assert.equal(fs.readFileSync(path.join(PLACE, folder, spelled, through), 'utf8'), escape, `${what}: the file is in its own folder`);
    }
    assert.ok(!fs.existsSync(path.join(outside, through)), `${what}: nothing was written through the link`);
  }
  assert.deepEqual(fs.readdirSync(outside), [], 'the folder the links lead to holds nothing new');
});

test('a record naming a link where the restore already put a file of that name fails with a sentence, and leaves nothing behind (FG3c #9)', async () => {
  const place = path.join(PLACE, 'twice-named');
  const outside = fileTempDir('treemap-capsuleRecords-twice-outside-');
  const content = 'a file, and then a link of the same name';
  const entry = capsuleEntry({ kind: 'folder', originalPath: place }, {
    name: 'twice-named',
    members: [
      { rel: 'dup', kind: 'file', size: content.length, hash: sha256(content) },
      { rel: 'dup', kind: 'symlink', size: outside.length, hash: sha256(outside), target: outside },
    ],
  }, { [path.join('twice-named', 'dup')]: content });
  const answer = await request('POST', `/api/timecapsule/${entry.id}/restore`);
  assert.equal(answer.status, 202, JSON.stringify(answer.body));
  await waitFor(() => getCapsuleJob(answer.body.jobId)?.status !== 'running', 'the restore');
  const job = getCapsuleJob(answer.body.jobId);
  assert.equal(job?.status, 'error');
  assert.match(job?.error ?? '', /capture never records that/, `a sentence, not the bare EEXIST (${job?.error})`);
  assert.ok(!fs.existsSync(place), 'nothing is left at its place');
  assert.deepEqual(fs.readdirSync(outside), [], 'and nothing where the link leads');
});

test('a restore that fails part-way leaves nothing at its place, not even a folder it made on the way, so it can be tried again (FG3c #9)', async () => {
  const place = path.join(PLACE, 'half-made');
  const recorded = 'the content capture recorded';
  const entry = capsuleEntry({ kind: 'folder', originalPath: place }, {
    name: 'half-made',
    members: [{ rel: path.join('sub', 'x.txt'), kind: 'file', size: recorded.length, hash: sha256(recorded) }],
  }, { [path.join('half-made', 'sub', 'x.txt')]: 'not what capture recorded' });
  for (const attempt of [1, 2]) {
    const answer = await request('POST', `/api/timecapsule/${entry.id}/restore`);
    assert.equal(answer.status, 202, `attempt ${attempt}: ${JSON.stringify(answer.body)}`);
    await waitFor(() => getCapsuleJob(answer.body.jobId)?.status !== 'running', `attempt ${attempt}`);
    assert.match(getCapsuleJob(answer.body.jobId)?.error ?? '', /no longer matches/, `attempt ${attempt} fails on the copy, not on the place`);
    assert.ok(!fs.existsSync(place), `attempt ${attempt}: nothing is left at its place`);
  }
});

test('a restore that fails part-way removes only the folders it made: an empty folder that was there before it is kept (FG3d #14)', async () => {
  const outer = fileTempDir('treemap-capsuleRecords-outer-empty-');
  const place = path.join(outer, 'made-1', 'made-2', 'half-made');
  const recorded = 'the content capture recorded';
  const entry = capsuleEntry({ kind: 'folder', originalPath: place }, {
    name: 'half-made',
    members: [{ rel: path.join('sub', 'x.txt'), kind: 'file', size: recorded.length, hash: sha256(recorded) }],
  }, { [path.join('half-made', 'sub', 'x.txt')]: 'not what capture recorded' });
  const job = await restoreSettled(entry.id, 'a restore under an empty folder of the user\u2019s');
  assert.match(job.error ?? '', /no longer matches/, 'it fails on the copy');
  assert.ok(!fs.existsSync(path.join(outer, 'made-1')), 'the folders it made on the way are gone, its place with them');
  assert.ok(fs.existsSync(outer), 'the empty folder that was there before the restore is kept');
  assert.deepEqual(fs.readdirSync(outer), [], 'holding what it held: nothing');
});

/* ─────────────── A restore stopped part-way through a file (FG3d #1) ─────────────── */

/** What a file read stream hands over at a time: a fault past it lands part-way through a file. */
const CHUNK = 64 * 1024;
const BIG = crypto.randomBytes(3 * CHUNK).toString('hex');
const SMALL = 'a small file, put back before the big one';

/** A file entry, or a folder entry holding a small file and then a big one, each in the capsule. */
function partWayEntry(kind: 'file' | 'folder', name: string, parent = PLACE): { entry: TimeCapsuleEntry; place: string; bigAt: string } {
  const place = path.join(parent, name);
  if (kind === 'file') {
    const entry = capsuleEntry({ originalPath: place, sizeBytes: BIG.length },
      { name, members: [{ rel: '', kind: 'file', size: BIG.length, hash: sha256(BIG) }] }, { [name]: BIG });
    return { entry, place, bigAt: place };
  }
  const bigRel = path.join('sub', 'big.txt');
  const entry = capsuleEntry({ kind: 'folder', originalPath: place, sizeBytes: BIG.length + SMALL.length }, {
    name,
    members: [
      { rel: 'small.txt', kind: 'file', size: SMALL.length, hash: sha256(SMALL) },
      { rel: 'sub', kind: 'dir', size: 0, hash: '' },
      { rel: bigRel, kind: 'file', size: BIG.length, hash: sha256(BIG) },
    ],
  }, { [path.join(name, 'small.txt')]: SMALL, [path.join(name, bigRel)]: BIG });
  return { entry, place, bigAt: path.join(place, bigRel) };
}

/** Restore one entry through the route the Time Capsule tab uses, and hand back the settled job. */
async function restoreSettled(id: string, what: string): Promise<{ status?: string; error?: string }> {
  const answer = await request('POST', `/api/timecapsule/${id}/restore`);
  assert.equal(answer.status, 202, `${what}: ${JSON.stringify(answer.body)}`);
  await waitFor(() => getCapsuleJob(answer.body.jobId)?.status !== 'running', what);
  return getCapsuleJob(answer.body.jobId) ?? {};
}

test('a restore that fails or is cancelled part-way through a file leaves nothing at its place, for a file and for a folder, and can be tried again (FG3d #1)', async () => {
  for (const kind of ['file', 'folder'] as const) {
    for (const how of ['fails', 'is cancelled'] as const) {
      const what = `a ${kind} whose restore ${how}`;
      const { entry, place, bigAt } = partWayEntry(kind, `part-way-${kind}-${how === 'fails' ? 'failed' : 'cancelled'}`);
      let madeMidCopy = false;
      const removeFault = setCopyFaultForTests((dest, read) => {
        if (dest !== bigAt || read <= CHUNK) return null;
        madeMidCopy = fs.existsSync(dest) && (kind === 'file' || fs.existsSync(path.join(place, 'small.txt')));
        if (how === 'fails') return new Error('the disk stopped answering (a test)');
        cancelAllCapsuleJobs();
        return null;
      });
      let job: { status?: string; error?: string };
      try {
        job = await restoreSettled(entry.id, what);
      } finally {
        removeFault();
      }
      assert.equal(job.status, how === 'fails' ? 'error' : 'cancelled', `${what}: ${job.error}`);
      assert.ok(madeMidCopy, `${what}: the restore had begun writing at its place when it stopped`);
      // "nothing was left half-written", as the cancelled restore and both undos say.
      assert.ok(!fs.existsSync(place), `${what}: nothing is left at its place`);

      const again = await restoreSettled(entry.id, `${what}, tried again`);
      assert.equal(again.status, 'complete', `${what}: it can be tried again, all the way (${again.error})`);
      assert.equal(fs.readFileSync(bigAt, 'utf8'), BIG, `${what}: the retry puts it back whole`);
      if (kind === 'folder') assert.equal(fs.readFileSync(path.join(place, 'small.txt'), 'utf8'), SMALL);
    }
  }
});

test('an undo cancelled part-way through a file leaves nothing at its place, and the next undo puts it back (FG3d #1)', async () => {
  const report = path.join(PLACE, 'report.docx');
  const bytes = crypto.randomBytes(3 * CHUNK + 11);
  fs.writeFileSync(report, bytes);
  const committed = await commitCart([report]);
  assert.deepEqual(committed.trashed, [report], JSON.stringify(committed));
  const removeFault = setCopyFaultForTests((dest, read) => {
    if (dest !== report || read <= CHUNK) return null;
    cancelAllCapsuleJobs();
    return null;
  });
  let jobId = '';
  try {
    jobId = (await undoCartRun(committed.runId)).jobId;
    await waitFor(() => getCapsuleJob(jobId)?.status !== 'running', 'the cancelled undo');
  } finally {
    removeFault();
  }
  assert.equal(getCapsuleJob(jobId)?.status, 'cancelled', getCapsuleJob(jobId)?.error);
  assert.ok(!fs.existsSync(report), 'nothing half-written is left at its place');
  const again = await undoCartRun(committed.runId);
  await waitFor(() => getCapsuleJob(again.jobId)?.status !== 'running', 'the second undo');
  assert.equal(getCapsuleJob(again.jobId)?.status, 'complete', getCapsuleJob(again.jobId)?.error);
  assert.deepEqual(fs.readFileSync(report), bytes, 'the second undo puts it back byte for byte');
});

test('a stopped restore that cannot remove what it had made says so, and is never reported as cancelled with nothing left (FG3d #1)', {
  skip: process.platform === 'win32' ? 'a folder’s mode does not stop a removal on Windows'
    : process.getuid?.() === 0 ? 'running as root, a folder’s mode stops nothing' : false,
}, async () => {
  // Part-way through the big file, the folder that holds what the restore made stops taking
  // removals: the part-copied file itself, a file put back before it, or a folder made on the way.
  const cases = ['the part-copied file', 'a file put back before it', 'a folder made on the way'] as const;
  for (const [n, left] of cases.entries()) {
    const what = `a cancelled restore that cannot remove ${left}`;
    const tmp = fileTempDir(`treemap-capsuleRecords-stuck-${n}-`);
    const madeUp = path.join(tmp, 'made-up');
    const { entry, place, bigAt } = left === 'a file put back before it'
      ? partWayEntry('folder', `stuck-${n}`, tmp)
      : partWayEntry('file', `stuck-${n}`, left === 'a folder made on the way' ? madeUp : tmp);
    const locked = left === 'a file put back before it' ? place : tmp;
    const stuck = left === 'the part-copied file' ? bigAt : left === 'a file put back before it' ? path.join(place, 'small.txt') : madeUp;
    const removeFault = setCopyFaultForTests((dest, read) => {
      if (dest !== bigAt || read <= CHUNK) return null;
      fs.chmodSync(locked, 0o500);
      cancelAllCapsuleJobs();
      return null;
    });
    let job: { status?: string; error?: string };
    try {
      job = await restoreSettled(entry.id, what);
    } finally {
      removeFault();
      fs.chmodSync(locked, 0o700);
    }
    assert.equal(job.status, 'error', `${what}: not "cancelled — nothing was left half-written" (${job.status})`);
    assert.ok(fs.existsSync(stuck), `${what}: the case is the one under test — ${stuck} is still there`);
    assert.ok((job.error ?? '').includes(stuck), `${what}: the sentence names what is left (${job.error})`);
    assert.match(job.error ?? '', /could not be removed/, what);
    // Removing it, as the sentence says, lets it be tried again.
    fs.rmSync(left === 'a folder made on the way' ? madeUp : place, { recursive: true, force: true });
    const again = await restoreSettled(entry.id, `${what}, tried again`);
    assert.equal(again.status, 'complete', `${what}: tried again (${again.error})`);
    assert.equal(fs.readFileSync(bigAt, 'utf8'), BIG);
  }
});

test('the check of a manifest against its links looks each member up by its own folders, never against every link (FG3b)', () => {
  // A node_modules capture: its .bin links, and the files of its packages. Counted, not timed.
  const links = 1_000;
  const files = 20_000;
  const members: unknown[] = [];
  for (let i = 0; i < links; i++) members.push({ rel: path.join('.bin', `tool-${i}`), kind: 'symlink', size: 1, hash: 'h', target: `../pkg-${i}/cli.js` });
  for (let i = 0; i < files; i++) members.push({ rel: path.join(`pkg-${i % 500}`, 'lib', `file-${i}.js`), kind: 'file', size: 1, hash: 'h' });
  const manifest = (list: unknown[]) => ({ originalPath: path.join(PLACE, 'node_modules'), name: 'node_modules', members: list } as unknown as Parameters<typeof manifestRefusal>[0]);
  const tally = { lookups: 0 };
  assert.equal(manifestRefusal(manifest(members), tally), null, 'a manifest capture writes passes');
  const deepest = 3; // no member here is more than three names deep
  assert.ok(tally.lookups <= members.length * deepest, `${tally.lookups} lookups for ${members.length} members: linear in the members, not members times links`);
  const tampered = [...members, { rel: path.join('.bin', `tool-${links - 1}`, 'through.txt'), kind: 'file', size: 1, hash: 'h' }];
  assert.match(manifestRefusal(manifest(tampered)) ?? '', /past a link/, 'and a member past one of its links is still refused');
});

test('the check of a manifest folds each name once, however many members its folders hold (FG3d #5)', () => {
  // A capture of 50,000 members under three long accented folder names, and one link. The fold that
  // follows Unicode code point by code point runs on the event loop that also serves the page.
  const folders = ['\u00dcn\u00efc\u00f6d\u00e9-f\u00f6lder-'.repeat(10), '\u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac-'.repeat(12), '\u00e7\u00e0-et-l\u00e0-'.repeat(16)];
  const members: unknown[] = [{ rel: path.join('bin', 'tool'), kind: 'symlink', size: 1, hash: 'h', target: '../x' }];
  for (let i = 0; i < 50_000; i++) members.push({ rel: path.join(...folders, `file-${i}.txt`), kind: 'file', size: 1, hash: 'h' });
  const manifest = { originalPath: path.join(PLACE, 'accented'), name: 'accented', members } as unknown as Parameters<typeof manifestRefusal>[0];
  let folds = 0;
  const counting = (name: string): string => { folds++; return apfsNameKey(name); };
  assert.equal(manifestRefusal(manifest, undefined, counting), null, 'a manifest capture writes passes');
  const distinct = new Set(['bin', 'tool', ...folders]).size;
  assert.ok(folds <= distinct, `${folds} folds for ${distinct} distinct names: each name once, not once per member`);
  const tampered = { ...manifest, members: [...members, { rel: path.join('BIN', 'TOOL', 'through.txt'), kind: 'file', size: 1, hash: 'h' }] } as unknown as Parameters<typeof manifestRefusal>[0];
  assert.match(manifestRefusal(tampered, undefined, apfsNameKey) ?? '', /past a link/, 'and a member past the link, in another case, is still refused');
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

test('a policy folder read back from autopilot.json is held to what TreeMap saves: respelled, a whole drive, a system folder or not text is refused (FG3b)', () => {
  const dir = sanitizePath(fileTempDir('treemap-capsuleRecords-saved-'));
  const cases: [string, unknown][] = [
    ['a respelled folder', `${path.join(dir, 'sub')}${path.sep}..`],
    ['a whole drive', path.parse(dir).root],
    ['a system folder', SYSTEM_PLACE],
    ['a value that is not text', 5],
  ];
  for (const [what, saved] of cases) {
    assert.throws(
      () => assertSavedPolicyPath(saved),
      (err: unknown) => err instanceof AppError && err.code === 'POLICY_RECORD_INVALID' && /not one TreeMap saved/.test(err.message),
      what,
    );
  }
  assert.doesNotThrow(() => assertSavedPolicyPath(dir), 'the folder as TreeMap saves it');
});

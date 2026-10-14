import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-auditOutcome-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { readAudit } from '../src/services/audit';
import { setSnapshotPurgeStepForTests } from '../src/services/snapshotAccounting';
import { createScanRecord } from '../src/services/diskScanner';
import { updateSettings } from '../src/services/settings';
import { saveTokens } from '../src/services/cloud/oauth';
import { setTrashStepForTests } from '../src/services/cleaner';
import { commitCart } from '../src/services/cartCommit';
import { getCapsuleJob, protectItems } from '../src/services/timeCapsule';
import { getOffloadIndex, getOffloadJob, prepareOffload, setAfterManifestLoadForTests, startOffload } from '../src/services/offload';
import type { AuditEntry, FileNode } from '../src/models/types';
import { waitFor } from './fixtures/waitFor';
import { withOpenFileCheck } from './fixtures/openFileCheck';
import { destinationsOnAnotherDrive } from './fixtures/offloadDrive';
destinationsOnAnotherDrive(); // every destination here stands for another drive (E01)

/**
 * The audit log says what a destructive request did (the final review, F1.13). Emptying the Trash,
 * purging snapshots and trashing cloud files were logged `outcome: 'ok'` whatever happened — a Trash
 * entry that could not be removed, a purge that failed, every cloud path failing — while the local
 * delete logs `error` / PARTIAL_FAILURE. And a restore (Time Capsule, cart undo, offload restore)
 * writes files at their original paths but its line named none. Now each line's outcome is the
 * operation's own, and a restore names what it puts back.
 *
 * Nothing reaches the machine's Trash, snapshots or a cloud account: the Trash is a folder of this
 * file's own (TREEMAP_TRASH_DIR), the purge step is stood in for, a cloud provider is a local
 * stand-in, and every trash step moves into this file's own folder.
 */

const FAKE_TRASH = fileTempDir('treemap-auditOutcome-moved-');
let moves = 0;
let server: http.Server;
let port = 0;

before(async () => {
  setTrashStepForTests(async (p) => {
    fs.renameSync(p, path.join(FAKE_TRASH, `${moves++}-${path.basename(p)}`));
  });
  resetRateLimiter();
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  setTrashStepForTests(null);
  setSnapshotPurgeStepForTests(null);
  await new Promise<void>((r) => server.close(() => r()));
});

function post(url: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf || 'null') }));
    });
    r.on('error', reject);
    r.end(payload);
  });
}

/** The newest audit line for `action`. */
async function lastLine(action: string): Promise<AuditEntry> {
  const line = (await readAudit(100)).find((e) => e.action === action);
  assert.ok(line, `a ${action} line was written`);
  return line;
}

async function withTrashDir<T>(dir: string, act: () => Promise<T>): Promise<T> {
  const prior = process.env.TREEMAP_TRASH_DIR;
  process.env.TREEMAP_TRASH_DIR = dir;
  try {
    return await act();
  } finally {
    if (prior === undefined) delete process.env.TREEMAP_TRASH_DIR;
    else process.env.TREEMAP_TRASH_DIR = prior;
  }
}

const NO_PERMISSIONS = process.platform === 'win32' || process.getuid?.() === 0 ? 'permissions do not stop this user here' : false;

test('emptying the Trash is audited as an error when an item could not be removed, and as ok when it was emptied', { skip: NO_PERMISSIONS }, async () => {
  const trash = fileTempDir('treemap-auditOutcome-trash-');
  const locked = path.join(trash, 'locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'f.txt'), 'x'.repeat(100));
  fs.chmodSync(locked, 0o555);
  try {
    const partial = await withTrashDir(trash, () => post('/api/trash/empty', { confirm: true }));
    assert.equal(partial.status, 200, JSON.stringify(partial.body));
    assert.equal(partial.body.emptied, false, 'the case under test: the Trash was not emptied');
    const line = await lastLine('trash.empty');
    assert.equal(line.outcome, 'error', JSON.stringify(line));
    assert.equal(line.code, 'PARTIAL_FAILURE');
  } finally {
    fs.chmodSync(locked, 0o755);
  }
  const emptied = await withTrashDir(trash, () => post('/api/trash/empty', { confirm: true }));
  assert.equal(emptied.body.emptied, true, JSON.stringify(emptied.body));
  assert.equal((await lastLine('trash.empty')).outcome, 'ok');
});

test('a snapshot purge is audited as an error when it failed, and as ok when it did not', async () => {
  setSnapshotPurgeStepForTests(async () => ({ ok: false, deleted: 0, failed: 3 }));
  const failed = await post('/api/system/snapshots/purge', { confirm: true });
  assert.equal(failed.status, 200, JSON.stringify(failed.body));
  const line = await lastLine('snapshots.purge');
  assert.equal(line.outcome, 'error', JSON.stringify(line));
  assert.equal(line.code, 'PARTIAL_FAILURE');
  setSnapshotPurgeStepForTests(async () => ({ ok: true, deleted: 2, failed: 0 }));
  await post('/api/system/snapshots/purge', { confirm: true });
  assert.equal((await lastLine('snapshots.purge')).outcome, 'ok');
  setSnapshotPurgeStepForTests(null);
});

test('trashing cloud files is audited as an error when a path failed, and as ok when each went', async () => {
  const requests: string[] = [];
  const standIn = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  });
  await new Promise<void>((r) => standIn.listen(0, '127.0.0.1', r));
  const prior = process.env.TM_GDRIVE_API;
  process.env.TM_GDRIVE_API = `http://127.0.0.1:${(standIn.address() as AddressInfo).port}`;
  try {
    await updateSettings({ cloud: { gdrive: { clientId: 'stand-in-client' } } });
    await saveTokens('gdrive', { accessToken: 'stand-in-token', expiresAt: 0 });
    const scan = createScanRecord('cloud://gdrive');
    const file: FileNode = { name: 'a.txt', path: 'cloud://gdrive/a.txt', size: 10, type: 'file', modifiedAt: 0, isHidden: false, cloudId: 'id:a' };
    scan.root = { name: 'Google Drive', path: 'cloud://gdrive', size: 10, type: 'dir', modifiedAt: 0, isHidden: false, children: [file] };
    scan.status = 'complete';
    const failed = await post('/api/cloud/trash', { scanId: scan.scanId, paths: ['cloud://gdrive/not-in-the-scan.txt'] });
    assert.equal(failed.status, 200, JSON.stringify(failed.body));
    assert.equal(failed.body.failed.length, 1, 'the case under test: the path failed');
    const line = await lastLine('cloud.trash');
    assert.equal(line.outcome, 'error', JSON.stringify(line));
    assert.equal(line.code, 'PARTIAL_FAILURE');
    const went = await post('/api/cloud/trash', { scanId: scan.scanId, paths: ['cloud://gdrive/a.txt'] });
    assert.deepEqual(went.body.deleted, ['cloud://gdrive/a.txt'], JSON.stringify(went.body));
    assert.equal((await lastLine('cloud.trash')).outcome, 'ok');
  } finally {
    if (prior === undefined) delete process.env.TM_GDRIVE_API;
    else process.env.TM_GDRIVE_API = prior;
    await new Promise<void>((r) => standIn.close(() => r()));
  }
});

test('a Time Capsule restore\'s line names the original path it writes', async () => {
  const original = path.join(fileTempDir('treemap-auditOutcome-capsule-'), 'kept.txt');
  fs.writeFileSync(original, 'protected, then gone');
  const [outcome] = (await protectItems([{ path: original }])).outcomes;
  assert.ok(outcome.entryId, outcome.detail);
  fs.rmSync(original);
  const started = await post(`/api/timecapsule/${outcome.entryId}/restore`, {});
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.deepEqual((await lastLine('timecapsule.restore')).paths, [original]);
  await waitFor(() => getCapsuleJob(started.body.jobId)?.status !== 'running', 'the restore finishing');
});

test('a cart undo\'s line names the original paths it writes', async () => {
  const original = path.join(fileTempDir('treemap-auditOutcome-cart-'), 'undone.txt');
  fs.writeFileSync(original, 'committed, then undone');
  const result = await withOpenFileCheck('clear', () => commitCart([original]));
  assert.deepEqual(result.trashed, [original], JSON.stringify(result.skipped));
  const started = await post('/api/cart/undo', { runId: result.runId });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(started.body.puttingBack, undefined, 'the answer is as before: the paths are the audit line\'s');
  assert.deepEqual((await lastLine('cart.undo')).paths, [original]);
  await waitFor(() => getCapsuleJob(started.body.jobId)?.status !== 'running', 'the undo finishing');
});

/** Offloads one new file of a folder of its own, and answers its original path and its record's id. */
async function offloadedEntry(label: string): Promise<{ original: string; id: string }> {
  const src = fs.realpathSync(fileTempDir(`treemap-auditOutcome-${label}-`));
  const original = path.join(src, 'away.bin');
  fs.writeFileSync(original, Buffer.alloc(2048, 4));
  const dest = fileTempDir(`treemap-auditOutcome-${label}-dest-`);
  const scan = createScanRecord(src);
  scan.status = 'complete';
  scan.root = { name: path.basename(src), path: src, size: 2048, type: 'dir', modifiedAt: 0, isHidden: false, children: [{ name: 'away.bin', path: original, size: 2048, type: 'file', modifiedAt: 0, isHidden: false }] };
  const job = await withOpenFileCheck('clear', async () => startOffload(scan, [original], dest, await prepareOffload(scan, [original], dest)));
  await waitFor(() => getOffloadJob(job.jobId)?.status !== 'running', 'the offload finishing');
  const entry = (await getOffloadIndex()).entries.find((e) => e.originalPath === original);
  assert.ok(entry, getOffloadJob(job.jobId)?.error);
  return { original, id: entry.id };
}

test('an offload restore\'s line names the original paths it writes', async () => {
  const { original, id } = await offloadedEntry('offload');
  const started = await post('/api/offload/restore', { ids: [id] });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.deepEqual((await lastLine('offload.restore')).paths, [original]);
  await waitFor(() => getOffloadJob(started.body.jobId)?.status !== 'running', 'the restore finishing');
});

test('a restore request reads the offload record once for all its ids, never once per id (final review F2.2)', async () => {
  // Each read is the whole record: up to 500 ids against a record of tens of thousands of entries took
  // seconds of reads before anything began.
  const { id } = await offloadedEntry('lookups');
  const ids = [id, ...Array.from({ length: 9 }, (_, i) => `not-recorded-${i}`)];
  let reads = 0;
  const stop = setAfterManifestLoadForTests(async () => { reads++; });
  try {
    const dry = await post('/api/offload/restore', { ids, dryRun: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.deepEqual(dry.body.wouldRestore.map((e: { id: string }) => e.id), [id], 'the one recorded id');
    assert.equal(reads, 1, 'a dry run of ten ids reads the record once');
    reads = 0;
    const none = await post('/api/offload/restore', { ids: ids.slice(1) });
    assert.equal(none.status, 404, JSON.stringify(none.body));
    assert.equal(none.body.code, 'NOTHING_TO_RESTORE');
    assert.equal(reads, 2, 'a real one reads it once for its audit line, and once as the restore starts');
  } finally {
    stop();
  }
});

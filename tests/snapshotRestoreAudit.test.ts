import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-snap-audit-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { startScan, getScan } from '../src/services/diskScanner';
import { setTrashStepForTests } from '../src/services/cleaner';
import { updateSettings } from '../src/services/settings';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { resetIdempotencyCache } from '../src/middleware/idempotency';
import { readAudit } from '../src/services/audit';
import { platform } from '../src/platform';
import { waitFor } from './fixtures/waitFor';

/**
 * Hunt C54: a snapshot restore with overwrite that failed after the file at the destination had
 * gone to the Trash was audited as "refused" naming the path asked for, so the file this request
 * did move to the Trash was in no audit line; and a copy that started and failed was "refused" too.
 * Now a restore that fails after the Trash step is audited as "error" naming the file it moved and
 * the path asked for, a copy that failed is "error", and "refused" stays for refusals.
 *
 * The platform's snapshot list and copy are stood in for, and so is the Trash step, as
 * tests/snapshotReplaceRules.test.ts does.
 */

const SCANNED = fs.realpathSync(fileTempDir('treemap-snap-audit-scanned-'));
const ELSEWHERE = fs.realpathSync(fileTempDir('treemap-snap-audit-else-'));
const STAND_IN_TRASH = fs.realpathSync(fileTempDir('treemap-snap-audit-trash-'));
const trashed: string[] = [];
let answer: Record<string, unknown> = {};
let server: http.Server;
let port = 0;
const provider = platform() as unknown as Record<string, unknown>;
const saved = { list: provider.listSnapshots, recover: provider.recoverFromSnapshots, folder: provider.restoreFolderRefusal };

function restore(body: unknown): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  resetRateLimiter();
  resetIdempotencyCache();
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: '/api/system/snapshots/restore', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(buf) }));
    });
    r.on('error', reject);
    r.end(payload);
  });
}

before(async () => {
  setTrashStepForTests(async (p: string) => {
    trashed.push(p);
    fs.renameSync(p, path.join(STAND_IN_TRASH, `${trashed.length}-${path.basename(p)}`));
  });
  provider.listSnapshots = async () => [{ id: 'snap1', name: 'a', takenAt: 1, volume: '/', accessPath: null }];
  provider.restoreFolderRefusal = async () => null;
  provider.recoverFromSnapshots = async () => answer;
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  await updateSettings({ engine: 'walker' });
  for (const n of ['b.txt', 'c.txt']) fs.writeFileSync(path.join(SCANNED, n), 'newer work');
  const s = await startScan(SCANNED, {});
  await waitFor(() => getScan(s.scanId)?.status !== 'running', 'the scan');
  assert.equal(getScan(s.scanId)?.status, 'complete', getScan(s.scanId)?.error);
});

after(async () => {
  setTrashStepForTests(null);
  provider.listSnapshots = saved.list;
  provider.recoverFromSnapshots = saved.recover;
  provider.restoreFolderRefusal = saved.folder;
  await new Promise<void>((r) => server.close(() => r()));
});

const failedCopy = { restored: false, failed: true, reason: 'The copy failed (a test).' };
const declined = { restored: false, cancelled: true, reason: 'The password prompt was dismissed (a test).' };

test('a restore that fails after the file it replaces went to the Trash is audited as an error naming that file and the path asked for', async () => {
  for (const [label, given, dest, code] of [
    ['a failed copy', failedCopy, 'b.txt', 'RESTORE_FAILED'],
    ['a dismissed prompt', declined, 'c.txt', 'AUTHORIZATION_DECLINED'],
  ] as const) {
    answer = given;
    const original = path.join(ELSEWHERE, 'a.txt');
    const destination = path.join(SCANNED, dest);
    const out = await restore({ path: original, destination, overwrite: true });
    assert.deepEqual([out.status, out.body.code], [409, code], `${label}: ${JSON.stringify(out.body)}`);
    assert.ok(trashed.includes(destination), `${label}: control — the file at the destination went to the Trash first`);
    const [line] = await readAudit(1);
    assert.deepEqual(
      { action: line.action, outcome: line.outcome, code: line.code, paths: line.paths },
      { action: 'snapshots.restore', outcome: 'error', code, paths: [destination, original] },
      `${label}: the line names what this request moved to the Trash`,
    );
  }
});

test('with nothing replaced, a copy that failed is an error and a dismissed prompt stays a refusal, each naming the path asked for', async () => {
  const original = path.join(ELSEWHERE, 'd.txt');
  const destination = path.join(SCANNED, 'absent.txt');
  answer = failedCopy;
  let out = await restore({ path: original, destination });
  assert.deepEqual([out.status, out.body.code], [409, 'RESTORE_FAILED']);
  let [line] = await readAudit(1);
  assert.deepEqual([line.outcome, line.code, line.paths], ['error', 'RESTORE_FAILED', [original]]);
  answer = declined;
  out = await restore({ path: original, destination });
  assert.deepEqual([out.status, out.body.code], [409, 'AUTHORIZATION_DECLINED']);
  [line] = await readAudit(1);
  assert.deepEqual([line.outcome, line.code, line.paths], ['refused', 'AUTHORIZATION_DECLINED', [original]]);
});

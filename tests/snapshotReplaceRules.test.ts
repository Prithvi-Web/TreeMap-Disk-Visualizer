import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
const DATA_DIR = isolatedDataDir('treemap-snapshotReplaceRules-data-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { startScan } from '../src/services/diskScanner';
import { setTrashStepForTests } from '../src/services/cleaner';
import { updateSettings } from '../src/services/settings';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { resetIdempotencyCache } from '../src/middleware/idempotency';
import { platform } from '../src/platform';
import { POLICY_FILE } from '../src/services/policy';
import type { VolumeSnapshotRef } from '../src/platform/types';

/**
 * POST /api/system/snapshots/restore with `overwrite: true` moves the file at the destination to the
 * Trash before it restores over it — a delete, and it was held to none of a delete's rules (the
 * final review, F1.12, F1.16): a file in no scan, under agent-policy.json's protectedPaths or past
 * its byte cap went to the Trash first, before the password prompt or any proof the path is in a
 * snapshot. The file it replaces is now held to the rules DELETE /api/files holds a path to.
 *
 * The snapshots, the restore itself and the Trash are stood in for: nothing privileged runs, and
 * nothing reaches the machine's Trash.
 */

const SCANNED = fs.realpathSync(fileTempDir('treemap-snapshotReplaceRules-scanned-'));
const ELSEWHERE = fs.realpathSync(fileTempDir('treemap-snapshotReplaceRules-elsewhere-'));
const STAND_IN_TRASH = fs.realpathSync(fileTempDir('treemap-snapshotReplaceRules-trash-'));
const POLICY_PATH = path.join(DATA_DIR, POLICY_FILE);
const SNAPSHOTS: VolumeSnapshotRef[] = [{ id: 'com.apple.TimeMachine.2026-09-01-000000.local', name: 'a', takenAt: 1, volume: '/', accessPath: null }];

let port = 0;
let server: http.Server;
const trashed: string[] = [];
type Provider = Record<'listSnapshots' | 'recoverFromSnapshots' | 'restoreFolderRefusal', unknown>;
const provider = platform() as unknown as Provider;
const saved = { list: provider.listSnapshots, recover: provider.recoverFromSnapshots, folder: provider.restoreFolderRefusal };

before(async () => {
  setTrashStepForTests(async (p) => {
    trashed.push(p);
    fs.renameSync(p, path.join(STAND_IN_TRASH, `${trashed.length}-${path.basename(p)}`));
  });
  provider.listSnapshots = async () => SNAPSHOTS;
  provider.restoreFolderRefusal = async () => null;
  provider.recoverFromSnapshots = async (_s: VolumeSnapshotRef[], _o: string, d: string) => {
    fs.writeFileSync(d, 'from the snapshot');
    return { restored: true, fromSnapshotId: SNAPSHOTS[0].id, sizeBytes: 17 };
  };
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  await updateSettings({ engine: 'walker' });
  fs.writeFileSync(path.join(SCANNED, 'present.txt'), 'there now');
  const scan = await startScan(SCANNED);
  await waitFor(() => scan.status !== 'running', `the scan of ${SCANNED}`);
  assert.equal(scan.status, 'complete', scan.error);
});

after(async () => {
  setTrashStepForTests(null);
  provider.listSnapshots = saved.list;
  provider.recoverFromSnapshots = saved.recover;
  provider.restoreFolderRefusal = saved.folder;
  fs.rmSync(POLICY_PATH, { force: true });
  await new Promise<void>((r) => server.close(() => r()));
});

/** POST /api/system/snapshots/restore replacing `destination`: its status and code. */
function restoreOver(destination: string): Promise<string> {
  resetRateLimiter();
  resetIdempotencyCache();
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ path: path.join(ELSEWHERE, 'gone.txt'), destination, overwrite: true });
    const r = http.request(
      { host: '127.0.0.1', port, path: '/api/system/snapshots/restore', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          let code = '';
          try { code = (JSON.parse(buf) as { code?: string }).code ?? ''; } catch { /* not JSON */ }
          resolve(`${res.statusCode}${code ? ` ${code}` : ''}`);
        });
      },
    );
    r.on('error', reject);
    r.end(payload);
  });
}

/** The newest line of the audit log, as GET /api/audit reads it back. */
function newestAudit(): Promise<{ action: string; outcome: string; code?: string; paths: string[] }> {
  resetRateLimiter();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/audit?limit=1' }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => {
        const [line] = (JSON.parse(buf) as { entries: { action: string; outcome: string; code?: string; paths: string[] }[] }).entries;
        resolve({ action: line.action, outcome: line.outcome, code: line.code, paths: line.paths });
      });
    }).on('error', reject);
  });
}

/** A file at `p` with `text`, made now. */
function fileAt(p: string, text: string): string {
  fs.writeFileSync(p, text);
  return p;
}

test('the file a restore replaces is held to the rules a delete is: outside every scan, protected, or past the byte cap, it is refused before anything is moved to the Trash — and the audit names the file refused (the final review, F2.9)', async () => {
  const outside = fileAt(path.join(ELSEWHERE, 'taxes.pdf'), 'in no scan');
  const protectedOne = fileAt(path.join(SCANNED, 'keep.pdf'), 'protected');
  const present = path.join(SCANNED, 'present.txt');
  const answers: Record<string, string> = {};
  const audited: Record<string, unknown> = {};
  answers['a file in no scan'] = await restoreOver(outside);
  audited['a file in no scan'] = await newestAudit();
  fs.writeFileSync(POLICY_PATH, JSON.stringify({ protectedPaths: [protectedOne] }));
  answers['a protected file'] = await restoreOver(protectedOne);
  audited['a protected file'] = await newestAudit();
  fs.writeFileSync(POLICY_PATH, JSON.stringify({ maxBytesPerOperation: 5 }));
  answers['a file past the byte cap'] = await restoreOver(present); // 9 bytes, as the scan sized it
  audited['a file past the byte cap'] = await newestAudit();
  fs.rmSync(POLICY_PATH, { force: true });
  assert.deepEqual(answers, {
    'a file in no scan': '403 OUTSIDE_SCAN_ROOT',
    'a protected file': '403 POLICY_PROTECTED_PATH',
    'a file past the byte cap': '403 POLICY_BYTES_EXCEEDED',
  });
  // The audit is the record of what was done to which paths: the refused file is the one the restore
  // would have replaced, not the one it was asked to bring back.
  const refusal = (code: string, p: string): unknown => ({ action: 'snapshots.restore', outcome: 'refused', code, paths: [p] });
  assert.deepEqual(audited, {
    'a file in no scan': refusal('OUTSIDE_SCAN_ROOT', outside),
    'a protected file': refusal('POLICY_PROTECTED_PATH', protectedOne),
    'a file past the byte cap': refusal('POLICY_BYTES_EXCEEDED', present),
  });
  assert.deepEqual(trashed, [], 'nothing was moved to the Trash');
  assert.deepEqual([outside, protectedOne, path.join(SCANNED, 'present.txt')].map((p) => fs.existsSync(p)), [true, true, true]);
});

test('a file the rules allow is still replaced, and a restore to a name nothing holds is not a delete at all', async () => {
  trashed.length = 0;
  const present = path.join(SCANNED, 'present.txt');
  assert.equal(await restoreOver(present), '200');
  assert.deepEqual([trashed, fs.readFileSync(present, 'utf8')], [[present], 'from the snapshot']);
  assert.equal(await restoreOver(path.join(ELSEWHERE, 'new-name.txt')), '200', 'nothing to replace, outside every scan');
});

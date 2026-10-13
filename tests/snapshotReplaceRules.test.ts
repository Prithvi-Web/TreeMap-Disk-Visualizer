import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
// App-data is reached through a link in the scanned folder, as a person who moved it to a bigger
// volume and linked it back has it: TreeMap spells it SCANNED/hop/treemap-data, where SCANNED/hop
// leads to VOL — so app-data really is VOL/treemap-data, and SCANNED/hop is a link TreeMap reaches
// its agent policy and audit log through.
const VOL_DIR = isolatedDataDir('treemap-snapshotReplaceRules-vol-');
const VOL = fs.realpathSync(VOL_DIR);
const DATA_DIR = path.join(VOL, 'treemap-data');
const SCANNED = fs.realpathSync(fileTempDir('treemap-snapshotReplaceRules-scanned-'));
const HOP = path.join(SCANNED, 'hop');
fs.mkdirSync(DATA_DIR);
fs.symlinkSync(VOL, HOP, 'junction');
process.env.TREEMAP_DATA_DIR = path.join(HOP, 'treemap-data');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { startScan } from '../src/services/diskScanner';
import { setTrashStepForTests } from '../src/services/cleaner';
import { updateSettings } from '../src/services/settings';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { resetIdempotencyCache } from '../src/middleware/idempotency';
import { platform } from '../src/platform';
import { invalidateCapabilities } from '../src/platform/capabilities';
import { POLICY_FILE } from '../src/services/policy';
import type { OpenHandleInfo, VolumeSnapshotRef } from '../src/platform/types';

/**
 * POST /api/system/snapshots/restore with `overwrite: true` moves the file at the destination to the
 * Trash before it restores over it — a delete, and it was held to none of a delete's rules (the
 * final review, F1.12, F1.16): a file in no scan, under agent-policy.json's protectedPaths or past
 * its byte cap went to the Trash first, before the password prompt or any proof the path is in a
 * snapshot. The file it replaces is now held to the rules DELETE /api/files holds a path to — and a
 * refusal of that file, whichever step refuses it, is audited against that file (F2.9, F3.1).
 *
 * The snapshots, the restore itself and the Trash are stood in for: nothing privileged runs, and
 * nothing reaches the machine's Trash.
 */

const ELSEWHERE = fs.realpathSync(fileTempDir('treemap-snapshotReplaceRules-elsewhere-'));
const STAND_IN_TRASH = fs.realpathSync(fileTempDir('treemap-snapshotReplaceRules-trash-'));
const POLICY_PATH = path.join(DATA_DIR, POLICY_FILE);
const SNAPSHOTS: VolumeSnapshotRef[] = [{ id: 'com.apple.TimeMachine.2026-09-01-000000.local', name: 'a', takenAt: 1, volume: '/', accessPath: null }];

let port = 0;
let server: http.Server;
const trashed: string[] = [];
type Provider = Record<'listSnapshots' | 'recoverFromSnapshots' | 'restoreFolderRefusal' | 'getOpenHandlesBatch' | 'probeOpenHandleGuard', unknown>;
const provider = platform() as unknown as Provider;
const saved = { list: provider.listSnapshots, recover: provider.recoverFromSnapshots, folder: provider.restoreFolderRefusal };

/** The Trash, stood in for: the file is moved aside here, never to the machine's Trash. */
async function standInTrash(p: string): Promise<void> {
  trashed.push(p);
  fs.renameSync(p, path.join(STAND_IN_TRASH, `${trashed.length}-${path.basename(p)}`));
}

before(async () => {
  setTrashStepForTests(standInTrash);
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

test('a file the Trash step itself refuses or fails to take — a link TreeMap reaches its records through, a file another program holds open, a file the Trash would not take — is not replaced, and the audit names that file, not the one asked for (the final review, F3.1)', async () => {
  const held = fileAt(path.join(SCANNED, 'held.txt'), 'open in another program');
  const stuck = fileAt(path.join(SCANNED, 'stuck.txt'), 'the Trash will not take it');
  const answers: Record<string, string> = {};
  const audited: Record<string, unknown> = {};
  trashed.length = 0;

  answers['a link TreeMap reaches its records through'] = await restoreOver(HOP);
  audited['a link TreeMap reaches its records through'] = await newestAudit();

  // Another program holds `held` open, as the open-file check (B2) reports it.
  const probes = { batch: provider.getOpenHandlesBatch, guard: provider.probeOpenHandleGuard };
  provider.probeOpenHandleGuard = async () => ({ available: true, mechanism: 'test' });
  provider.getOpenHandlesBatch = async (paths: string[]): Promise<{ handles: OpenHandleInfo[]; complete: boolean }> => ({
    handles: paths.filter((p) => p === held).map((p) => ({ path: p, pid: process.pid + 1, processName: 'a stand-in editor' })),
    complete: true,
  });
  invalidateCapabilities();
  try {
    answers['a file another program holds open'] = await restoreOver(held);
    audited['a file another program holds open'] = await newestAudit();
  } finally {
    provider.getOpenHandlesBatch = probes.batch;
    provider.probeOpenHandleGuard = probes.guard;
    invalidateCapabilities();
  }

  setTrashStepForTests(async (p) => {
    if (p === stuck) throw new Error('the Trash did not take it (a test)');
    await standInTrash(p);
  });
  try {
    answers['a file the Trash would not take'] = await restoreOver(stuck);
    audited['a file the Trash would not take'] = await newestAudit();
  } finally {
    setTrashStepForTests(standInTrash);
  }

  assert.deepEqual(answers, {
    'a link TreeMap reaches its records through': '403 SAFETY_RECORD',
    'a file another program holds open': '409 OPEN_HANDLE_CONFLICT',
    'a file the Trash would not take': '409 DESTINATION_NOT_CLEARED',
  });
  const refusal = (code: string, p: string): unknown => ({ action: 'snapshots.restore', outcome: 'refused', code, paths: [p] });
  assert.deepEqual(audited, {
    'a link TreeMap reaches its records through': refusal('SAFETY_RECORD', HOP),
    'a file another program holds open': refusal('OPEN_HANDLE_CONFLICT', held),
    'a file the Trash would not take': refusal('DESTINATION_NOT_CLEARED', stuck),
  });
  assert.deepEqual(trashed, [], 'nothing was moved to the Trash');
  assert.deepEqual(
    [fs.lstatSync(HOP).isSymbolicLink(), fs.readFileSync(held, 'utf8'), fs.readFileSync(stuck, 'utf8')],
    [true, 'open in another program', 'the Trash will not take it'],
    'each is where it was, as it was',
  );
});

test('of the cases SAFETY_RECORD names, a restore meets only a link TreeMap reaches its records through: the agent policy, the audit log and app-data are a destination in app-data, 403 APP_DATA_PATH, and a folder above app-data or one holding that link is never replaced, 409 DESTINATION_IS_FOLDER — as the restore\'s OpenAPI 403 says (the review of LEFT2, F2.1; openapiDeclared holds the words)', async () => {
  trashed.length = 0;
  const cases: Record<string, string> = {
    'the agent policy': POLICY_PATH,
    'the audit log': path.join(DATA_DIR, 'audit.jsonl'),
    'app-data': DATA_DIR,
    'a folder above app-data': VOL,
    'a folder holding a link TreeMap reaches its records through': SCANNED,
    'a link TreeMap reaches its records through': HOP,
  };
  const answers: Record<string, string> = {};
  for (const [what, destination] of Object.entries(cases)) answers[what] = await restoreOver(destination);
  assert.deepEqual({ answers, 'moved to the Trash': trashed, 'an agent policy written': fs.existsSync(POLICY_PATH) }, {
    answers: {
      'the agent policy': '403 APP_DATA_PATH',
      'the audit log': '403 APP_DATA_PATH',
      'app-data': '403 APP_DATA_PATH',
      'a folder above app-data': '409 DESTINATION_IS_FOLDER',
      'a folder holding a link TreeMap reaches its records through': '409 DESTINATION_IS_FOLDER',
      'a link TreeMap reaches its records through': '403 SAFETY_RECORD',
    },
    'moved to the Trash': [],
    'an agent policy written': false,
  });
});

/** GET `url` from the server above: its JSON body. */
function served(url: string): Promise<unknown> {
  resetRateLimiter();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve(JSON.parse(buf)));
    }).on('error', reject);
  });
}

test('what the capability manifest and AGENTS.md say of the audit is what a restore records: SAFETY_RECORD goes unrecorded where a door refuses it before its endpoint, but a restore\'s refusal of the file it would replace is recorded, SAFETY_RECORD among them, as the test above it shows (the review of LEFT2, F2.2)', async () => {
  const audit = String((await served('/api/capabilities') as { safety: { audit: string } }).safety.audit);
  const agents = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8').replace(/\s+/g, ' ');
  assert.deepEqual({
    'the manifest: the doors where SAFETY_RECORD is not recorded':
      /as SAFETY_RECORD is where a delete, the cart, an offload, a relocation or an MCP tool refuses it;/.test(audit),
    'the manifest: a restore records its refusal of the file it would replace, SAFETY_RECORD among them':
      /a snapshot restore with overwrite judges the file it would replace inside its endpoint, so every refusal of that file, SAFETY_RECORD for a link TreeMap reaches app-data through among them, is recorded \(snapshots\.restore, refused, naming that file\)/.test(audit),
    'AGENTS.md: SAFETY_RECORD falls on both sides of the line':
      /`OUTSIDE_SCAN_ROOT` and `SAFETY_RECORD` fall on both sides of that line too\./.test(agents),
    'AGENTS.md: a restore records its refusal of the file it would replace, SAFETY_RECORD among them':
      /A snapshot restore with `overwrite` judges the file it would replace inside its endpoint, so every refusal of that file — `OUTSIDE_SCAN_ROOT`, the policy's, an open file's, and `SAFETY_RECORD` for a link TreeMap reaches app-data through — is recorded against it: `snapshots\.restore`, `refused`, with its code\./.test(agents),
  }, {
    'the manifest: the doors where SAFETY_RECORD is not recorded': true,
    'the manifest: a restore records its refusal of the file it would replace, SAFETY_RECORD among them': true,
    'AGENTS.md: SAFETY_RECORD falls on both sides of the line': true,
    'AGENTS.md: a restore records its refusal of the file it would replace, SAFETY_RECORD among them': true,
  });
});

test('a file the rules allow is still replaced, and a restore to a name nothing holds is not a delete at all', async () => {
  trashed.length = 0;
  const present = path.join(SCANNED, 'present.txt');
  assert.equal(await restoreOver(present), '200');
  assert.deepEqual([trashed, fs.readFileSync(present, 'utf8')], [[present], 'from the snapshot']);
  assert.equal(await restoreOver(path.join(ELSEWHERE, 'new-name.txt')), '200', 'nothing to replace, outside every scan');
});

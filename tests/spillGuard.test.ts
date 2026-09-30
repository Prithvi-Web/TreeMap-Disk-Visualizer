import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
// App-data sits one level down in this file's own temp folder, so a folder that holds it (as a
// home folder holds ~/Library/Application Support) can be scanned beside it.
const HOME = isolatedDataDir('treemap-spillGuard-home-');
const APP = path.join(HOME, 'app-data');
fs.mkdirSync(APP);
process.env.TREEMAP_DATA_DIR = APP;
process.env.TREEMAP_NO_GDU = '1';

import type { Request, Response } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../src/server';
import { buildMcpServer } from '../src/mcp/server';
import { startScan, collectEmptyFolders } from '../src/services/diskScanner';
import { setTrashStepForTests } from '../src/services/cleaner';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { requireInsideScanRoot, requireInsideScanRootToRead } from '../src/middleware/pathGuard';
import { ENDPOINTS } from '../src/api/openapi';
import { moveToTrash } from '../src/services/cleaner';
import { protectAndTrash } from '../src/services/timeCapsule';
import { relocateSecret } from '../src/services/securityHygieneScanner';
import { setSpillCheckForTests } from '../src/services/autopilot';
import { AppError } from '../src/middleware/errorHandler';
import { isSpillPath } from '../src/utils/pathSanitizer';
import { SPILL_DIR } from '../src/services/spillSweep';
import type { FileNode, ScanResult } from '../src/models/types';
import { waitFor } from './fixtures/waitFor';

/**
 * Phase 4 T17a (plan §S.5.3): `<appData>/scan-spill` holds the working files of very large
 * scans, and nothing the app offers may touch it. Every destructive or file-opening request
 * whose path is that folder or anything under it is refused, 403 `SPILL_PATH`, however the
 * path is spelled (`..`, trailing separators, another case, a link in its parents, Windows'
 * trailing dots and spaces); the MCP tools refuse the same; the Empty Folders view never
 * offers it. Facts about it still answer: they read, they never act.
 *
 * App-data is this file's own temp folder (`TREEMAP_DATA_DIR`), scanned so its paths are
 * inside a scanned root: the refusal must hold there, where the scan-root rule would allow
 * the request. Nothing reaches the Trash: the trash step is replaced for the whole file.
 */

const SPILL = path.join(APP, SPILL_DIR);
fs.mkdirSync(path.join(SPILL, 'inner'), { recursive: true, mode: 0o700 });
const INNER = path.join(SPILL, 'inner');
const LEFTOVER = path.join(SPILL, '4242-1790656308811-3f2b1c4e-8a7d-4b6c-9e1f-0123456789ab-size');
fs.mkdirSync(path.join(APP, 'empty-one'));
fs.mkdirSync(path.join(APP, 'other', SPILL_DIR), { recursive: true });
const OTHER_FILE = path.join(APP, 'other', 'keep.txt');
fs.writeFileSync(OTHER_FILE, 'the user’s file');
const OCCUPIED = path.join(APP, 'other', 'occupied.txt');
fs.writeFileSync(OCCUPIED, 'something already here');
const DEST = fileTempDir('treemap-spillGuard-dest-');
const POSIX = process.platform !== 'win32';
/** The user's own folders beside app-data: twenty files in twenty folders, and one folder named like the spill folder. */
const USER = path.join(HOME, 'user');
for (let i = 0; i < 20; i++) {
  fs.mkdirSync(path.join(USER, `f${i}`), { recursive: true });
  fs.writeFileSync(path.join(USER, `f${i}`, 'file.txt'), `file ${i}`);
}
fs.mkdirSync(path.join(USER, SPILL_DIR));
fs.writeFileSync(path.join(USER, SPILL_DIR, 'mine.txt'), 'mine');
/** Whether this volume folds ſ (U+017F) to s, as default APFS does: then `ſcan-spill` beside it is the spill folder itself. */
const FOLDS_LONG_S = fs.existsSync(path.join(APP, `\u017f${SPILL_DIR.slice(1)}`));
const LONG_S_SPILL = path.join(APP, `\u017f${SPILL_DIR.slice(1)}`);
const USER2 = path.join(HOME, 'user2');
fs.mkdirSync(path.join(USER2, `\u017f${SPILL_DIR.slice(1)}`), { recursive: true });
fs.writeFileSync(path.join(USER2, `\u017f${SPILL_DIR.slice(1)}`, 'theirs.txt'), 'theirs');

async function settledScan(root: string): Promise<ScanResult> {
  const started = await startScan(root);
  await waitFor(() => started.status !== 'running', `the scan of ${root}`);
  assert.equal(started.status, 'complete', started.error);
  return started;
}

const trashed: string[] = [];
let server: http.Server;
let port: number;
let client: Client;
let scan: ScanResult;

before(async () => {
  setTrashStepForTests(async (p) => {
    trashed.push(p);
    throw new Error('the spill guard test trashes nothing');
  });
  server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  const mcp = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'spill-guard-test', version: '0.0.0' });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  scan = await startScan(APP);
  await waitFor(() => scan.status !== 'running', 'the app-data scan');
  assert.equal(scan.status, 'complete', scan.error);
});

after(async () => {
  setTrashStepForTests(null);
  await client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.deepEqual(trashed, [], 'nothing was offered to the Trash');
});

interface Answer {
  status: number;
  body: any;
}

function request(method: string, url: string, body?: unknown): Promise<Answer> {
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

function assertSpillRefusal(answer: Answer, what: string): void {
  assert.equal(answer.status, 403, `${what}: refused (${JSON.stringify(answer.body).slice(0, 240)})`);
  assert.equal(answer.body.code, 'SPILL_PATH', what);
  assert.match(answer.body.error, new RegExp(`TreeMap's own ${SPILL_DIR} folder`), what);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const reply = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content?: { text: string }[] };
  return reply.content?.[0]?.text ?? '';
}

/* ─────────────── The spellings ─────────────── */

// First in the file on purpose: canonicalising a path memoises its folders for five seconds
// (pathSanitizer's canonDir), so this must run before anything could have canonicalised the
// folders a cloud identifier would split into, or a fault here would read a memoised answer.
test('a cloud identifier is never read as a path, even from a working folder inside the spill folder', () => {
  const cwd = process.cwd();
  process.chdir(SPILL);
  try {
    assert.equal(isSpillPath(`cloud://gdrive/${SPILL_DIR}/x`), false, 'a cloud path never lives on this disk');
  } finally {
    process.chdir(cwd);
  }
});

test('the spill folder and everything under it is recognised, however the path is spelled', () => {
  const link = path.join(fileTempDir('treemap-spillGuard-link-'), 'app-data');
  fs.symlinkSync(APP, link, 'junction');
  const alias = path.join(fileTempDir('treemap-spillGuard-alias-'), 'to-spill');
  fs.symlinkSync(SPILL, alias, 'junction');
  const inside = [
    SPILL,
    INNER,
    LEFTOVER,
    path.join(INNER, 'deeper', 'still'),
    path.join(APP, 'other', '..', SPILL_DIR, 'x'),
    `${SPILL}${path.sep}`,
    `${SPILL}${path.sep}${path.sep}inner`,
    path.join(APP, SPILL_DIR.toUpperCase(), 'x'),
    path.join(APP, 'Scan-Spill'),
    path.join(fs.realpathSync.native(APP), SPILL_DIR, 'x'),
    path.join(link, SPILL_DIR, 'x'),
    path.join(alias, 'x'),
    // A name that begins with two dots is a name, not a way out.
    path.join(SPILL, '..x'),
    path.join(SPILL, '...'),
    path.join(SPILL, '..x', 'deep'),
  ];
  for (const p of inside) assert.equal(isSpillPath(p), true, `${p} is in the spill folder`);
  const outside = [
    APP,
    path.join(APP, `${SPILL_DIR}-2`, 'x'),
    path.join(APP, SPILL_DIR.slice(0, -1)),
    path.join(APP, 'other', SPILL_DIR),
    path.join(APP, 'other', SPILL_DIR, 'x'),
    OTHER_FILE,
    path.join(APP, '..x'),
    // A link is not what it leads to: removing it removes the link, never the folder.
    alias,
    `cloud://gdrive/${SPILL_DIR}`,
  ];
  for (const p of outside) assert.equal(isSpillPath(p), false, `${p} is not in the spill folder`);
});

test('before the folder exists, a path to it in another case is refused by its name', () => {
  const away = `${SPILL}.away`;
  fs.renameSync(SPILL, away); // as on every machine before its first large scan
  try {
    for (const p of [path.join(APP, SPILL_DIR.toUpperCase(), 'x'), path.join(APP, 'Scan-Spill'), path.join(APP, SPILL_DIR, 'not-yet')]) {
      assert.equal(isSpillPath(p), true, `${p} is in the spill folder, which does not exist yet`);
    }
  } finally {
    fs.renameSync(away, SPILL);
  }
});

test('Windows spells the spill folder with trailing dots and spaces too', { skip: POSIX && 'Windows drops them from every name; POSIX keeps them as part of it' }, () => {
  for (const p of [`${SPILL}.`, `${SPILL} `, `${SPILL}. .${path.sep}x`, `${SPILL} ${path.sep}inner`]) {
    assert.equal(isSpillPath(p), true, `${p} is in the spill folder`);
  }
});

/* ─────────────── The shared guard ─────────────── */

function runGuard(guard: typeof requireInsideScanRoot, body: Record<string, unknown>): unknown {
  let passed: unknown = 'not called';
  guard({ body } as Request, {} as Response, (err?: unknown) => { passed = err; });
  return passed;
}

test('the scanned-root guard refuses a path in the spill folder, inside a scanned root', () => {
  for (const body of [{ path: INNER }, { paths: [OTHER_FILE, LEFTOVER] }, { path: SPILL }]) {
    const err = runGuard(requireInsideScanRoot, body);
    assert.ok(err instanceof AppError, `${JSON.stringify(body)} is refused`);
    assert.equal(err.status, 403);
    assert.equal(err.code, 'SPILL_PATH');
  }
  assert.equal(runGuard(requireInsideScanRoot, { paths: [OTHER_FILE] }), undefined, 'a user file in the same scan passes');
  // The read-only variant (facts) keeps the scan-root rule and answers about the folder.
  assert.equal(runGuard(requireInsideScanRootToRead, { paths: [SPILL, INNER] }), undefined, 'facts may read it');
  const outside = runGuard(requireInsideScanRootToRead, { paths: [DEST] });
  assert.ok(outside instanceof AppError && outside.code === 'OUTSIDE_SCAN_ROOT', 'and still refuses what no scan covers');
});

/**
 * The destructive endpoints (the registry's own flag) that do not carry the shared guard, each
 * with why a path in the spill folder cannot reach anything through it. A new destructive
 * endpoint must carry the guard or be added here with its reason.
 */
const NO_GUARD_BECAUSE: Record<string, string> = {
  'DELETE /api/notes': 'a note is words about a path; nothing at the path is touched',
  'PUT /api/notes': 'a note is words about a path; nothing at the path is touched',
  'DELETE /api/timecapsule/:id': 'forgets a capsule copy by id; takes no path',
  'POST /api/timecapsule/:id/restore': 'writes back what the capsule recorded, and protectAndTrash refuses the spill folder',
  'POST /api/autopilot/policies/:id/approve': 'takes a policy id; its runs leave the spill folder out, and protectAndTrash refuses it',
  'PUT /api/autopilot/policies': 'saves policies; their runs leave the spill folder out, and protectAndTrash refuses it',
  'POST /api/autopilot/runs/:id/undo': 'writes back what its run recorded, which never held the spill folder',
  'POST /api/cart/undo': 'writes back what the commit recorded; the commit carries the guard',
  'POST /api/offload/restore': 'writes back what the offload manifest recorded; the offload carries the guard',
  'POST /api/cloud/disconnect': 'takes no path',
  'POST /api/cloud/trash': 'cloud:// paths only, never this disk',
  'POST /api/compression/encode': 'checks its paths itself (over HTTP below)',
  'POST /api/system/snapshots/restore': 'checks its path and destination itself (over HTTP below)',
  'POST /api/system/snapshots/purge': 'removes the system\'s own snapshots; takes no path',
  'POST /api/trash/empty': 'empties the system Trash; takes no path',
  'POST /api/zombie-handles/restart': 'quits a program; takes no path',
  'PUT /api/engine/budget': 'a setting',
  'PUT /api/settings': 'settings',
};

/** Routes that open a path without being destructive: each carries the guard or checks itself. */
const OPENS = ['POST /api/files/open', 'POST /api/files/terminal', 'POST /api/files/open-handles', 'POST /api/container/expand'];

test('every destructive endpoint carries the guard or says why it need not, and so does every route that opens a path', () => {
  const app = createApp(path.join(__dirname, '..', 'public')) as unknown as {
    router: { stack: { handle: { stack?: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] } }[] } }[] };
  };
  const stacks = new Map<string, unknown[]>();
  for (const layer of app.router.stack) {
    for (const sub of layer.handle.stack ?? []) {
      if (!sub.route) continue;
      for (const m of Object.keys(sub.route.methods)) stacks.set(`${m.toUpperCase()} /api${sub.route.path}`, sub.route.stack.map((l) => l.handle));
    }
  }
  const destructive = ENDPOINTS.filter((e) => e.destructive).map((e) => `${e.method.toUpperCase()} ${e.path.replace(/\{(\w+)\}/g, ':$1')}`);
  assert.ok(destructive.length >= 20, `the registry flags its destructive endpoints (${destructive.length})`);
  for (const route of destructive) {
    const guarded = stacks.get(route)?.includes(requireInsideScanRoot) === true;
    assert.ok(guarded !== (route in NO_GUARD_BECAUSE), `${route}: ${guarded ? 'carries the guard, so it needs no exemption' : 'carries no guard and says nothing about why'}`);
  }
  for (const route of Object.keys(NO_GUARD_BECAUSE)) assert.ok(destructive.includes(route), `${route} is exempted, but the registry does not call it destructive`);
  for (const route of OPENS) assert.ok(stacks.get(route)?.includes(requireInsideScanRoot), `${route} carries the guard`);
  assert.ok(stacks.get('POST /api/facts')?.includes(requireInsideScanRootToRead), 'facts carries the read-only guard');
  assert.ok(!stacks.get('POST /api/facts')?.includes(requireInsideScanRoot), 'and not the one that refuses the spill folder');
});

/* ─────────────── Over HTTP ─────────────── */

test('the routes behind the shared guard refuse the spill folder', async () => {
  const id = scan.scanId;
  assertSpillRefusal(await request('DELETE', '/api/files', { paths: [INNER], dryRun: true }), 'DELETE /api/files');
  assertSpillRefusal(await request('POST', '/api/cart/commit', { paths: [INNER], dryRun: true }), 'POST /api/cart/commit');
  assertSpillRefusal(await request('POST', '/api/files/open-handles', { paths: [INNER] }), 'POST /api/files/open-handles');
  assertSpillRefusal(await request('POST', '/api/container/expand', { scanId: id, path: INNER }), 'POST /api/container/expand');
  assertSpillRefusal(await request('POST', '/api/offload', { scanId: id, paths: [INNER], dest: DEST, dryRun: true }), 'offloading from it');
  assertSpillRefusal(await request('POST', '/api/security/relocate', { path: LEFTOVER, to: path.join(APP, 'other', 'moved'), confirm: true }), 'relocating from it');
});

test('the routes that check a path themselves refuse it too: preview, encode, a destination', async () => {
  const id = scan.scanId;
  assertSpillRefusal(await request('GET', `/api/files/preview?path=${encodeURIComponent(LEFTOVER)}`), 'GET /api/files/preview');
  assertSpillRefusal(await request('POST', '/api/compression/encode', { paths: [LEFTOVER] }), 'POST /api/compression/encode');
  assertSpillRefusal(await request('POST', '/api/security/relocate', { path: OTHER_FILE, to: path.join(SPILL, 'moved.txt'), confirm: true }), 'relocating into it');
  assertSpillRefusal(await request('POST', '/api/offload', { scanId: id, paths: [OTHER_FILE], dest: SPILL, dryRun: true }), 'offloading into it');
  // A destination in it that does not exist yet is refused as the spill folder, not as a missing folder.
  assertSpillRefusal(await request('POST', '/api/offload', { scanId: id, paths: [OTHER_FILE], dest: path.join(SPILL, 'not-yet'), dryRun: true }), 'offloading into a folder not made yet');
  // The destination is checked before anything privileged (snapshotRecovery.ts), and so is this.
  assertSpillRefusal(await request('POST', '/api/system/snapshots/restore', { path: LEFTOVER, destination: OCCUPIED }), 'recovering a file that lived in it');
  assertSpillRefusal(await request('POST', '/api/system/snapshots/restore', { path: OTHER_FILE, destination: SPILL }), 'recovering into it');
  assert.ok(fs.existsSync(OTHER_FILE), 'the user file stayed where it was');
  assert.deepEqual(fs.readdirSync(SPILL), ['inner'], 'and nothing was written into the spill folder');
});

test('facts about the spill folder still answer: they read, they never act', async () => {
  const answer = await request('POST', '/api/facts', { scanId: scan.scanId, paths: [SPILL, INNER], providers: ['size'] });
  assert.equal(answer.status, 200, JSON.stringify(answer.body).slice(0, 200));
  assert.equal(answer.body.providers.size.available, true);
});

test('the MCP tools refuse it the same way', async () => {
  assert.match(await callTool('trash_paths', { paths: [INNER], dryRun: true }), /^Error \(SPILL_PATH\): /);
  assert.match(await callTool('offload', { scanId: scan.scanId, paths: [INNER], dest: DEST, dryRun: true }), /^Error \(SPILL_PATH\): /);
  assert.match(await callTool('offload', { scanId: scan.scanId, paths: [OTHER_FILE], dest: SPILL, dryRun: true }), /^Error \(SPILL_PATH\): /);
  assert.match(await callTool('offload', { scanId: scan.scanId, paths: [OTHER_FILE], dest: path.join(SPILL, 'not-yet'), dryRun: true }), /^Error \(SPILL_PATH\): /);
});

/* ─────────────── Autopilot and the trash itself ─────────────── */

test('Autopilot leaves the spill folder out of every run, and says so', async () => {
  const left = path.join(SPILL, '4243-1790656308811-3f2b1c4e-8a7d-4b6c-9e1f-0123456789ab-names');
  fs.writeFileSync(left, 'what a crash left');
  try {
    const answer = await request('POST', '/api/autopilot/simulate', { policy: { path: APP, match: { kind: 'custom', minBytes: 1 } } });
    assert.equal(answer.status, 200, JSON.stringify(answer.body).slice(0, 240));
    const items = (answer.body.items as { path: string }[]).map((i) => i.path);
    assert.ok(items.includes(OTHER_FILE), `the policy matched the user's files (${items.length})`);
    assert.deepEqual(items.filter((p) => isSpillPath(p)), [], 'and nothing in the spill folder');
    const skipped = (answer.body.skipped as { path: string; reason: string }[]).filter((s) => s.path === SPILL);
    assert.equal(skipped.length, 1, 'which it names once, as left alone');
    assert.match(skipped[0].reason, new RegExp(`TreeMap's own ${SPILL_DIR} folder .*\\(1 matched item\\)`));
  } finally {
    fs.rmSync(left);
  }
});

test('the trash itself refuses the spill folder, behind every entry point: moveToTrash and protectAndTrash', async () => {
  const refused = (err: unknown): boolean => err instanceof AppError && err.code === 'SPILL_PATH';
  await assert.rejects(moveToTrash([OTHER_FILE, INNER], { ignoreOpenHandles: true }), refused, 'moveToTrash refuses the whole batch');
  await assert.rejects(protectAndTrash([{ path: INNER }]), refused, 'protectAndTrash refuses before copying anything');
  assert.deepEqual(trashed, [], 'nothing reached the trash step');
  assert.ok(fs.existsSync(OTHER_FILE), 'the user file in the same batch stayed');
});

/* ─────────────── The security review round ─────────────── */

test('a paths beside path cannot stand in for it: the guard judges both, and refuses what is not a path', async () => {
  // Outside every scan and missing, so a handler reached by mistake could open nothing.
  const outside = path.join(DEST, 'missing.txt');
  const routes: [string, Record<string, unknown>][] = [
    ['/api/files/open', {}],
    ['/api/files/terminal', {}],
    // No confirm: a relocation or a gc that got past the guard would answer 400 CONFIRM_REQUIRED.
    ['/api/security/relocate', { to: path.join(APP, 'other', 'moved') }],
    ['/api/git/gc', {}],
    ['/api/container/expand', { scanId: scan.scanId }],
  ];
  for (const [url, extra] of routes) {
    const a = await request('POST', url, { ...extra, path: outside, paths: [] });
    assert.deepEqual([a.status, a.body.code], [403, 'OUTSIDE_SCAN_ROOT'], `${url}, an outside path beside paths: []`);
    const b = await request('POST', url, { ...extra, path: LEFTOVER, paths: [] });
    assert.deepEqual([b.status, b.body.code], [403, 'SPILL_PATH'], `${url}, a spill path beside paths: []`);
  }
  // Every element of paths is judged too, and anything but a path is refused. The path given is a
  // file, so Open Terminal would answer without launching anything even if it were reached.
  const element = await request('POST', '/api/files/terminal', { path: OTHER_FILE, paths: [LEFTOVER] });
  assert.deepEqual([element.status, element.body.code], [403, 'SPILL_PATH'], 'an element of paths');
  const number = await request('POST', '/api/files/terminal', { path: OTHER_FILE, paths: [42] });
  assert.deepEqual([number.status, number.body.code], [400, 'PATH_INVALID'], 'a number in paths');
  const text = await request('POST', '/api/files/terminal', { path: OTHER_FILE, paths: 'x' });
  assert.deepEqual([text.status, text.body.code], [400, 'PATH_INVALID'], 'paths that is not a list');
  const beside = await request('DELETE', '/api/files', { paths: [OTHER_FILE], path: outside, dryRun: true });
  assert.deepEqual([beside.status, beside.body.code], [403, 'OUTSIDE_SCAN_ROOT'], 'a path beside paths is judged as well');
  // A clean body still reaches its handler.
  const clean = await request('POST', '/api/files/terminal', { path: OTHER_FILE });
  assert.deepEqual([clean.status, clean.body.code], [400, 'NOT_A_DIRECTORY'], 'Open Terminal on a file');
});

test('relocateSecret checks both ends itself: inside a scanned root, and never the spill folder', async () => {
  const outsideSecret = path.join(DEST, 'id_rsa');
  fs.writeFileSync(outsideSecret, 'a key');
  await assert.rejects(relocateSecret(outsideSecret, path.join(APP, 'other', 'keys', 'id_rsa')), /outside every scanned folder/);
  assert.ok(fs.existsSync(outsideSecret), 'the file outside every scan stayed');
  const insideSecret = path.join(APP, 'other', 'secret.pem');
  fs.writeFileSync(insideSecret, 'a key');
  await assert.rejects(relocateSecret(insideSecret, path.join(DEST, 'secret.pem')), /outside every scanned folder/);
  await assert.rejects(relocateSecret(insideSecret, path.join(SPILL, 'secret.pem')), new RegExp(`TreeMap's own ${SPILL_DIR} folder`));
  assert.ok(fs.existsSync(insideSecret), 'and the one inside stayed where it was');
});

test('the folder itself under a name only the file system folds (ſ for s on APFS) is the folder', { skip: !FOLDS_LONG_S && 'this volume does not fold ſ to s (it is case-sensitive), so ſcan-spill beside app-data is another folder' }, async () => {
  assert.equal(fs.statSync(LONG_S_SPILL).ino, fs.statSync(SPILL).ino, 'the same folder, by inode');
  assert.equal(isSpillPath(LONG_S_SPILL), true);
  assertSpillRefusal(await request('DELETE', '/api/files', { paths: [LONG_S_SPILL], dryRun: true }), 'DELETE /api/files');
  assertSpillRefusal(await request('POST', '/api/cart/commit', { paths: [LONG_S_SPILL], dryRun: true }), 'the cart commit');
  assertSpillRefusal(await request('POST', '/api/offload', { scanId: scan.scanId, paths: [OTHER_FILE], dest: LONG_S_SPILL, dryRun: true }), 'an offload into it');
});

test('beside the folder, a link to it is still a link and another folder is another folder', () => {
  const link = path.join(APP, 'to-spill');
  fs.symlinkSync(SPILL, link, 'junction');
  try {
    assert.equal(isSpillPath(link), false, 'removing the link removes the link, never the folder');
    assert.equal(isSpillPath(path.join(APP, 'other')), false);
    assert.equal(isSpillPath(path.join(APP, 'empty-one')), false);
  } finally {
    fs.unlinkSync(link);
  }
});

test('an offload never plans a copy into the spill folder: a folder named like it sent into app-data', async () => {
  const users = await settledScan(USER);
  const away = `${SPILL}.away`;
  fs.renameSync(SPILL, away); // the folder absent, as on every machine before its first large scan
  try {
    assertSpillRefusal(
      await request('POST', '/api/offload', { scanId: users.scanId, paths: [path.join(USER, SPILL_DIR)], dest: APP, dryRun: true }),
      'user/scan-spill offloaded into app-data',
    );
  } finally {
    fs.renameSync(away, SPILL);
  }
  if (FOLDS_LONG_S) {
    const others = await settledScan(USER2);
    assertSpillRefusal(
      await request('POST', '/api/offload', { scanId: others.scanId, paths: [path.join(USER2, `\u017f${SPILL_DIR.slice(1)}`)], dest: APP, dryRun: true }),
      'ſcan-spill offloaded into app-data, where that name is the spill folder',
    );
  }
});

test('Autopilot pays the full spill check only for candidates under app-data', async () => {
  let full = 0;
  setSpillCheckForTests((p) => {
    full++;
    return isSpillPath(p);
  });
  const left = path.join(SPILL, '4245-1790656308811-3f2b1c4e-8a7d-4b6c-9e1f-0123456789ab-flags');
  try {
    const beside = await request('POST', '/api/autopilot/simulate', { policy: { path: USER, match: { kind: 'custom', minBytes: 1 } } });
    assert.equal(beside.status, 200, JSON.stringify(beside.body).slice(0, 200));
    assert.ok(beside.body.items.length >= 20, `a folder beside app-data matched its files (${beside.body.items.length})`);
    assert.equal(full, 0, 'and cost no full check at all');
    full = 0;
    fs.writeFileSync(left, 'what a crash left');
    const holding = await request('POST', '/api/autopilot/simulate', { policy: { path: HOME, match: { kind: 'custom', minBytes: 1 } } });
    assert.equal(holding.status, 200, JSON.stringify(holding.body).slice(0, 200));
    const items = (holding.body.items as { path: string }[]).map((i) => i.path);
    assert.ok(items.filter((p) => p.startsWith(USER + path.sep)).length >= 20, 'a folder holding app-data matched the user\'s files');
    const underApp = items.filter((p) => p.startsWith(APP + path.sep)).length;
    assert.equal(full, underApp + 1, 'one full check per candidate under app-data, the leftover included, and none for the rest');
    assert.ok((holding.body.skipped as { path: string }[]).some((sk) => sk.path === SPILL), 'and the leftover is still left alone');
  } finally {
    setSpillCheckForTests(null);
    fs.rmSync(left, { force: true });
  }
});

/* ─────────────── Empty Folders ─────────────── */

test('the Empty Folders view never offers the spill folder, nor anything in it', async () => {
  const answer = await request('GET', `/api/empty-folders?scanId=${scan.scanId}`);
  assert.equal(answer.status, 200);
  const offered = (answer.body.folders as { path: string }[]).map((f) => f.path);
  assert.ok(offered.includes(path.join(APP, 'empty-one')), `a user's empty folder is offered (${offered.join(', ')})`);
  assert.ok(offered.includes(path.join(APP, 'other', SPILL_DIR)), 'and a folder of that name anywhere else is the user\'s');
  // The spill folder holds only an empty folder, so without the skip it is the topmost empty one.
  assert.ok(!offered.includes(SPILL), `the spill folder is not offered (${offered.join(', ')})`);
  assert.ok(!offered.some((p) => p.startsWith(SPILL + path.sep)), 'nor anything in it');
});

function dir(name: string, p: string, children: FileNode[] = []): FileNode {
  return { name, path: p, type: 'dir', size: 0, modifiedAt: 0, isHidden: false, children };
}

test('the skip reads the folder by where it is, whatever its case, and covers a scan rooted inside it', () => {
  const tree = dir(path.basename(APP), APP, [
    dir('Scan-Spill', path.join(APP, 'Scan-Spill'), [dir('inner', path.join(APP, 'Scan-Spill', 'inner'))]),
    dir('mine', path.join(APP, 'mine')),
  ]);
  assert.deepEqual(collectEmptyFolders(tree, true).folders.map((f) => f.path), [path.join(APP, 'mine')]);
  const rooted = dir(SPILL_DIR, SPILL, [dir('inner', INNER)]);
  assert.deepEqual(collectEmptyFolders(rooted, true), { folders: [], totalCount: 0, truncated: false });
});

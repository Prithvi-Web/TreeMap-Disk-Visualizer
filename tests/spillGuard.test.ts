import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
const APP = isolatedDataDir('treemap-spillGuard-data-');
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

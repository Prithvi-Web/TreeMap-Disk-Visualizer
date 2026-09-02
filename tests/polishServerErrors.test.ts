import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-polish-errors-data-'));
process.env.TREEMAP_NO_GDU = '1';

import express from 'express';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { errorHandler, permissionDeniedMessage } from '../src/middleware/errorHandler';
import { describeFsError } from '../src/utils/errno';
import { moveToTrash } from '../src/services/cleaner';
import { startScan, getScan, describeScanError } from '../src/services/diskScanner';

/**
 * What the user reads when the disk says no.
 *
 *  - EACCES/EPERM used to reach the page as the bare words "Permission
 *    denied" (proven on the isolated server: GET /api/fs/list on a chmod-000
 *    folder). The contract now: code PERMISSION_DENIED, message
 *    "TreeMap isn't allowed to read {path}." with the macOS remedy appended.
 *  - A failed Move to Trash stored `err.message` verbatim, so toasts read
 *    "ENOENT: no such file or directory, lstat '/Users/…'".
 *  - A root that disappears mid-scan was either a raw errno string on the
 *    progress stream or a green "Scan complete" over files that are gone.
 */

const canLock = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0);

interface Reply { status: number; body: any }

function req(port: number, method: string, url: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { data += c; });
      res.on('end', () => {
        let parsed: unknown = data;
        try { parsed = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function errno(code: string, message: string, p?: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code, ...(p ? { path: p } : {}) });
}

/* ───────────────────────── PERMISSION_DENIED text ───────────────────────── */

test('permissionDeniedMessage is the shared contract, remedy included on macOS', () => {
  const m = permissionDeniedMessage('/Users/me/Documents');
  assert.ok(m.startsWith("TreeMap isn't allowed to read /Users/me/Documents."), m);
  if (process.platform === 'darwin') {
    assert.match(m, /Full Disk Access in System Settings › Privacy & Security, then try again\.$/);
  } else {
    assert.equal(m, "TreeMap isn't allowed to read /Users/me/Documents.");
  }
  assert.ok(permissionDeniedMessage(undefined).startsWith("TreeMap isn't allowed to read this folder."), 'no path is still a sentence');
  assert.doesNotMatch(m, /E[A-Z]{3,}/, 'no errno');
});

test('an EACCES thrown from a route answers 403 PERMISSION_DENIED with the friendly sentence', async () => {
  const app = express();
  app.get('/denied', () => { throw errno('EACCES', "EACCES: permission denied, scandir '/x/y'", '/x/y'); });
  app.get('/eperm', () => { throw errno('EPERM', "EPERM: operation not permitted, lstat '/x/z'", '/x/z'); });
  app.get('/nopath', () => { throw errno('EACCES', 'EACCES: permission denied'); });
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    for (const [url, p] of [['/denied', '/x/y'], ['/eperm', '/x/z']] as const) {
      const r = await req(port, 'GET', url);
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'PERMISSION_DENIED', 'the code is unchanged, so every client keyed on it still works');
      assert.equal(r.body.error, permissionDeniedMessage(p));
      assert.doesNotMatch(r.body.error, /EACCES|EPERM|scandir|lstat/);
    }
    const r = await req(port, 'GET', '/nopath');
    assert.equal(r.status, 403);
    assert.equal(r.body.error, permissionDeniedMessage(undefined));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('POST /api/scan on a folder the OS refuses answers 403 with the remedy, not a complete empty scan', { skip: !canLock && 'needs a chmod-000 folder' }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-polish-locked-'));
  const locked = path.join(base, 'locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'big.bin'), Buffer.alloc(9999));
  fs.chmodSync(locked, 0o000);
  resetRateLimiter();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const r = await req(port, 'POST', '/api/scan?wait=true&waitMs=10000', { path: locked });
    assert.equal(r.status, 403, `got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'PERMISSION_DENIED');
    assert.equal(r.body.error, permissionDeniedMessage(locked));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.chmodSync(locked, 0o755);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/* ───────────────────────── describeFsError ───────────────────────── */

test('describeFsError turns an errno into a sentence a non-coder can act on', () => {
  const cases: [string, RegExp][] = [
    ['ENOENT', /no longer there/],
    ['ENOTDIR', /no longer there/],
    ['EACCES', /not allowed|would not let/],
    ['EPERM', /not allowed|would not let/],
    ['EBUSY', /still has it open/],
    ['ETXTBSY', /still has it open/],
    ['EROFS', /read-only/],
    ['EIO', /did not answer|still connected/],
    ['ETIMEDOUT', /did not answer|still connected/],
    ['EWHATEVER', /something went wrong/],
  ];
  for (const [code, want] of cases) {
    const s = describeFsError(errno(code, `${code}: raw message, lstat '/a/b'`, '/a/b'));
    assert.match(s, want, code);
    assert.doesNotMatch(s, /^E[A-Z]+:/, `${code}: no errno prefix`);
    assert.doesNotMatch(s, /\blstat\b|\brmdir\b|\bscandir\b/, `${code}: no syscall names`);
    assert.ok(s.split('/a/b').length <= 2, `${code}: the path never appears twice`);
  }
  if (process.platform === 'darwin') {
    assert.match(describeFsError(errno('EPERM', 'x')), /Full Disk Access/, 'macOS names the setting');
  }
  assert.match(describeFsError(new Error('plain failure')), /something went wrong/, 'an error with no code still reads as a sentence');
  assert.match(describeFsError('a string'), /something went wrong/);
});

test('a failed Move to Trash reports why in plain words', async () => {
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-polish-trash-')), 'already-gone.txt');
  const result = await moveToTrash([missing], { ignoreOpenHandles: true });
  assert.equal(result.deleted.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].path, missing);
  assert.doesNotMatch(result.failed[0].reason, /^E[A-Z]+:/, `raw errno leaked: ${result.failed[0].reason}`);
  assert.doesNotMatch(result.failed[0].reason, /lstat/);
  assert.match(result.failed[0].reason, /no longer there/);
});

/* ───────────────────────── a root that disappears ───────────────────────── */

test('describeScanError maps the disk\'s answer to the sentence the status line shows', () => {
  const gone = describeScanError(errno('ENOENT', "ENOENT: no such file or directory, lstat '/Volumes/Backup'", '/Volumes/Backup'));
  assert.match(gone, /disappeared while TreeMap was scanning/);
  assert.match(gone, /unplugged|moved/);
  assert.doesNotMatch(gone, /ENOENT|lstat/);
  const denied = describeScanError(errno('EPERM', 'EPERM: operation not permitted', '/Users/me/Library/Mail'));
  assert.equal(denied, permissionDeniedMessage('/Users/me/Library/Mail'));
  assert.equal(describeScanError(new Error('gdu exploded')), 'gdu exploded', 'an ordinary error keeps its own words');
  assert.equal(describeScanError('boom'), 'boom');
});

test('a root removed while it is being scanned settles as an error, never as a complete scan', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-polish-vanish-'));
  const root = path.join(base, 'drive');
  // Enough entries that the walk is still running when the root goes away.
  for (let d = 0; d < 40; d++) {
    const dir = path.join(root, `d${d}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 25; f++) fs.writeFileSync(path.join(dir, `f${f}.txt`), 'x');
  }
  const scan = await startScan(root);
  fs.rmSync(root, { recursive: true, force: true });
  const deadline = Date.now() + 15_000;
  while (getScan(scan.scanId)?.status === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const done = getScan(scan.scanId)!;
  assert.equal(done.status, 'error', `a scan of a folder that no longer exists is not complete (fileCount ${done.fileCount})`);
  assert.match(done.error ?? '', /disappeared while TreeMap was scanning/);
  assert.doesNotMatch(done.error ?? '', /ENOENT/);
  fs.rmSync(base, { recursive: true, force: true });
});

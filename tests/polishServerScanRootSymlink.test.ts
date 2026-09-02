import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-polish-symlink-data-'));
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { resetIdempotencyCache } from '../src/middleware/idempotency';
import { insideAnyScanRoot } from '../src/middleware/pathGuard';
import { startScan, getScan } from '../src/services/diskScanner';

/**
 * "Nothing outside a scanned root can be touched" has to survive a symlink.
 *
 * The scanner never follows links, so a link inside the root points at files
 * that were never in the map — and a purely textual `path.relative` test let
 * `root/esc/victim.txt` (esc -> somewhere else entirely) through every guard:
 * trash, offload, cart commit, open, preview, and the MCP trash_paths tool.
 * Proven on the isolated server before the fix: DELETE /api/files (dryRun)
 * answered 200 for exactly that path, and 403 for the same file by its real
 * name.
 *
 * The rule now: the path's PARENT chain is resolved (fs.realpath) and the leaf
 * is left alone, so the symlink's own location decides — trashing the link
 * itself stays allowed, anything reached THROUGH it is refused — and the same
 * canonical form is used for the root, so an alias spelling of a scanned file
 * (/tmp vs /private/tmp on macOS) is accepted instead of refused.
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-polish-symlink-'));
const root = path.join(base, 'tree');
const outside = path.join(base, 'outside');
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.mkdirSync(outside);
const victim = path.join(outside, 'victim.txt');
fs.writeFileSync(victim, 'victim');
const report = path.join(root, 'docs', 'report.txt');
fs.writeFileSync(report, 'report');
const link = path.join(root, 'esc');
let linked = true;
try {
  fs.symlinkSync(outside, link, 'dir');
} catch {
  linked = false; // Windows without the symlink privilege — nothing to test
}
const throughLink = path.join(link, 'victim.txt');

const skipReason = linked ? false : 'this account cannot create symlinks';

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

async function scanned(dir: string): Promise<void> {
  const scan = await startScan(dir);
  const deadline = Date.now() + 15_000;
  while (getScan(scan.scanId)?.status === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(getScan(scan.scanId)?.status, 'complete', 'the fixture scan must complete');
}

async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  resetRateLimiter();
  resetIdempotencyCache();
  const server = http.createServer(createApp(path.join(__dirname, '..', 'public')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test('a file reached through a symlink inside the root is outside the root', { skip: skipReason }, async () => {
  await scanned(root);
  const { port, close } = await listen();
  try {
    const r = await req(port, 'DELETE', '/api/files', { paths: [throughLink], dryRun: true });
    assert.equal(r.status, 403, `expected a refusal, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'OUTSIDE_SCAN_ROOT');

    const preview = await req(port, 'GET', `/api/files/preview?path=${encodeURIComponent(throughLink)}`);
    assert.equal(preview.status, 403, 'preview reads through the link too');
    assert.equal(preview.body.code, 'OUTSIDE_SCAN_ROOT');

    const handles = await req(port, 'POST', '/api/files/open-handles', { paths: [throughLink] });
    assert.equal(handles.status, 403, 'open-handles is gated by the same rule');
    assert.equal(handles.body.code, 'OUTSIDE_SCAN_ROOT');
  } finally {
    await close();
  }
  assert.ok(fs.existsSync(victim), 'dryRun touched nothing');
});

test('the symlink itself, and real files inside the root, stay allowed', { skip: skipReason }, async () => {
  await scanned(root);
  const { port, close } = await listen();
  try {
    const self = await req(port, 'DELETE', '/api/files', { paths: [link], dryRun: true });
    assert.equal(self.status, 200, `the link is inside the root: ${JSON.stringify(self.body)}`);
    assert.equal(self.body.wouldTrash[0].path, link);

    const real = await req(port, 'DELETE', '/api/files', { paths: [report], dryRun: true });
    assert.equal(real.status, 200, `an ordinary file inside the root: ${JSON.stringify(real.body)}`);
  } finally {
    await close();
  }
  assert.ok(fs.existsSync(link) && fs.existsSync(report), 'dryRun touched nothing');
});

test('an alias spelling of a scanned file is the same file, and is accepted', {
  skip: fs.realpathSync(root) === root && 'the temp dir has no alias spelling on this machine',
}, async () => {
  await scanned(root);
  const alias = path.join(fs.realpathSync(root), 'docs', 'report.txt');
  assert.notEqual(alias, report, 'the fixture really has two spellings');
  const { port, close } = await listen();
  try {
    const r = await req(port, 'DELETE', '/api/files', { paths: [alias], dryRun: true });
    assert.equal(r.status, 200, `same file, different spelling: ${JSON.stringify(r.body)}`);
  } finally {
    await close();
  }
});

test('the MCP tools share the verdict: insideAnyScanRoot is the one gate', { skip: skipReason }, async () => {
  await scanned(root);
  assert.equal(insideAnyScanRoot(throughLink), false, 'through the link: refused');
  assert.equal(insideAnyScanRoot(link), true, 'the link itself: allowed');
  assert.equal(insideAnyScanRoot(report), true, 'a real file: allowed');
  assert.equal(insideAnyScanRoot(victim), false, 'the target by its real name: refused');
  assert.equal(insideAnyScanRoot(path.join(root, 'docs', 'not-yet.txt')), true, 'a file that does not exist yet is judged by where it would live');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-rails-test-'));
process.env.TREEMAP_NO_GDU = '1';

import express from 'express';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { idempotency, resetIdempotencyCache } from '../src/middleware/idempotency';

/**
 * The agent-safety rails: dryRun acts on nothing (proven against the real
 * filesystem), agent-policy.json refuses out-of-policy operations with clean
 * {error,code} bodies, every destructive request lands in the audit log, and
 * a repeated Idempotency-Key never double-executes.
 */

const DATA_DIR = process.env.TREEMAP_DATA_DIR!;
const POLICY_PATH = path.join(DATA_DIR, 'agent-policy.json');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-rails-fixture-'));
const BIG = 512 * 1024;
const bigPath = path.join(fixture, 'big.bin');
fs.writeFileSync(bigPath, Buffer.alloc(BIG, 7));
fs.mkdirSync(path.join(fixture, 'precious'));
const preciousFile = path.join(fixture, 'precious', 'keep.txt');
fs.writeFileSync(preciousFile, 'irreplaceable');

async function listen() {
  resetRateLimiter();
  resetIdempotencyCache();
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

function req(port: number, method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { ...extraHeaders };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => {
        let parsed: unknown = buf;
        try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function scanFixture(port: number): Promise<string> {
  const started = await req(port, 'POST', '/api/scan', { path: fixture });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const scanId = started.body.scanId as string;
  for (let i = 0; i < 100; i++) {
    const stats = await req(port, 'GET', `/api/scan/${scanId}/stats`);
    if (stats.body.status === 'complete') return scanId;
    if (stats.body.status === 'error') assert.fail('scan failed');
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail('scan did not complete in time');
}

/* ------------------------------- dryRun ------------------------------- */

test('DELETE /api/files dryRun returns the manifest and provably touches nothing', async () => {
  const { port, close } = await listen();
  try {
    await scanFixture(port);
    const r = await req(port, 'DELETE', '/api/files', { paths: [bigPath], dryRun: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.dryRun, true);
    assert.deepEqual(r.body.wouldTrash, [{ path: bigPath, bytes: BIG }]);
    assert.equal(r.body.totalKnownBytes, BIG);
    assert.ok(fs.existsSync(bigPath), 'dry run must not move the file');
  } finally {
    await close();
  }
});

test('POST /api/offload dryRun returns the exact plan and writes nothing at the destination', async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-rails-dest-'));
  const { port, close } = await listen();
  try {
    const scanId = await scanFixture(port);
    const r = await req(port, 'POST', '/api/offload', { scanId, paths: [bigPath], dest, dryRun: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.dryRun, true);
    assert.equal(r.body.fileCount, 1);
    assert.equal(r.body.bytesTotal, BIG);
    assert.deepEqual(r.body.wouldTrashAfterVerify, [bigPath]);
    assert.equal(r.body.copies[0].src, bigPath);
    assert.equal(fs.readdirSync(dest).length, 0, 'dry run must not copy anything');
    assert.ok(fs.existsSync(bigPath), 'dry run must not trash the source');
  } finally {
    await close();
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('without dryRun the response shape is the historical one (spec sanity via a refused batch)', async () => {
  const { port, close } = await listen();
  try {
    // A path outside every scan root exercises the unchanged guard path.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-rails-outside-'));
    const victim = path.join(outside, 'x.txt');
    fs.writeFileSync(victim, 'x');
    const r = await req(port, 'DELETE', '/api/files', { paths: [victim] });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'OUTSIDE_SCAN_ROOT');
    assert.ok(fs.existsSync(victim));
    fs.rmSync(outside, { recursive: true, force: true });
  } finally {
    await close();
  }
});

/* ------------------------------- policy ------------------------------- */

test('agent-policy.json blocks out-of-allowlist scans and destructive calls with clean codes', async () => {
  const { port, close } = await listen();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-rails-elsewhere-'));
  try {
    const scanId = await scanFixture(port); // scanned before the policy tightens
    assert.ok(scanId);

    // 1. allowedRoots: scans outside the allowlist are refused.
    fs.writeFileSync(POLICY_PATH, JSON.stringify({ allowedRoots: [fixture] }));
    const refusedScan = await req(port, 'POST', '/api/scan', { path: elsewhere });
    assert.equal(refusedScan.status, 403);
    assert.equal(refusedScan.body.code, 'POLICY_ROOT_NOT_ALLOWED');
    const allowedScan = await req(port, 'POST', '/api/scan', { path: fixture });
    assert.equal(allowedScan.status, 202, 'inside the allowlist still works');

    // 2. protectedPaths: even a dry run refuses to touch them (or their parents).
    fs.writeFileSync(POLICY_PATH, JSON.stringify({ protectedPaths: [path.join(fixture, 'precious')] }));
    const refusedProtected = await req(port, 'DELETE', '/api/files', { paths: [preciousFile], dryRun: true });
    assert.equal(refusedProtected.status, 403);
    assert.equal(refusedProtected.body.code, 'POLICY_PROTECTED_PATH');
    const refusedParent = await req(port, 'DELETE', '/api/files', { paths: [fixture], dryRun: true });
    assert.equal(refusedParent.body.code, 'POLICY_PROTECTED_PATH', 'trashing a parent of a protected path is refused too');

    // 3. maxBytesPerOperation: the cap refuses oversized operations.
    fs.writeFileSync(POLICY_PATH, JSON.stringify({ maxBytesPerOperation: 1024 }));
    const refusedCap = await req(port, 'DELETE', '/api/files', { paths: [bigPath], dryRun: true });
    assert.equal(refusedCap.status, 403);
    assert.equal(refusedCap.body.code, 'POLICY_BYTES_EXCEEDED');

    assert.ok(fs.existsSync(preciousFile) && fs.existsSync(bigPath), 'nothing was touched throughout');
  } finally {
    fs.rmSync(POLICY_PATH, { force: true }); // later tests run unrestricted
    fs.rmSync(elsewhere, { recursive: true, force: true });
    await close();
  }
});

/* -------------------------------- audit -------------------------------- */

test('the audit log recorded the dry runs and the policy refusals, newest first', async () => {
  const { port, close } = await listen();
  try {
    const r = await req(port, 'GET', '/api/audit?limit=50');
    assert.equal(r.status, 200);
    const entries = r.body.entries as any[];
    assert.ok(entries.length >= 4, `expected several entries, got ${entries.length}`);
    assert.ok(entries.every((e) => typeof e.at === 'number' && typeof e.action === 'string' && typeof e.tokenId === 'string'));
    assert.ok(entries.slice(1).every((e, i) => e.at <= entries[i].at), 'newest first');

    const okDry = entries.find((e) => e.action === 'files.trash' && e.dryRun === true && e.outcome === 'ok');
    assert.ok(okDry, 'successful dry run recorded');
    assert.deepEqual(okDry.paths, [bigPath]);
    assert.equal(okDry.bytes, BIG);

    const refused = entries.find((e) => e.outcome === 'refused' && e.code === 'POLICY_PROTECTED_PATH');
    assert.ok(refused, 'policy refusal recorded with its code');

    const offloadDry = entries.find((e) => e.action === 'offload.start' && e.dryRun === true);
    assert.ok(offloadDry, 'offload dry run recorded');
  } finally {
    await close();
  }
});

/* ----------------------------- idempotency ----------------------------- */

test('a duplicate Idempotency-Key replays instead of re-executing (probe app, execution counted)', async () => {
  resetIdempotencyCache();
  const app = express();
  app.use(express.json());
  let executions = 0;
  app.post('/probe', idempotency, (_req2, res) => {
    executions++;
    res.json({ execution: executions });
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const first = await req(port, 'POST', '/probe', {}, { 'Idempotency-Key': 'k-1' });
    const second = await req(port, 'POST', '/probe', {}, { 'Idempotency-Key': 'k-1' });
    assert.equal(executions, 1, 'the handler must run exactly once');
    assert.deepEqual(second.body, first.body, 'the replay is byte-identical');
    assert.equal(second.headers['idempotency-replayed'], 'true');

    const third = await req(port, 'POST', '/probe', {}, { 'Idempotency-Key': 'k-2' });
    assert.equal(executions, 2, 'a different key executes normally');
    assert.equal(third.body.execution, 2);

    const noKey = await req(port, 'POST', '/probe', {});
    assert.equal(executions, 3, 'no key = no idempotency, exactly as before');
    assert.equal(noKey.headers['idempotency-replayed'], undefined);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('failures are not remembered — a retry after an error really retries', async () => {
  resetIdempotencyCache();
  const app = express();
  app.use(express.json());
  let calls = 0;
  app.post('/flaky', idempotency, (_req2, res) => {
    calls++;
    if (calls === 1) res.status(500).json({ error: 'boom', code: 'INTERNAL' });
    else res.json({ ok: true, calls });
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const first = await req(port, 'POST', '/flaky', {}, { 'Idempotency-Key': 'k-3' });
    assert.equal(first.status, 500);
    const second = await req(port, 'POST', '/flaky', {}, { 'Idempotency-Key': 'k-3' });
    assert.equal(second.status, 200, 'the retry executed for real');
    assert.equal(second.body.calls, 2);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('idempotency works end-to-end on the real DELETE /api/files route', async () => {
  const { port, close } = await listen();
  try {
    await scanFixture(port);
    const first = await req(port, 'DELETE', '/api/files', { paths: [bigPath], dryRun: true }, { 'Idempotency-Key': 'trash-1' });
    const second = await req(port, 'DELETE', '/api/files', { paths: [bigPath], dryRun: true }, { 'Idempotency-Key': 'trash-1' });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.headers['idempotency-replayed'], 'true');
    assert.deepEqual(second.body, first.body);
  } finally {
    await close();
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
});

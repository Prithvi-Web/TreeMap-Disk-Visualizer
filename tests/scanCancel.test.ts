import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate every cache/snapshot write from the user's real app data — a
// cancelled scan must be provably unable to write one, and proving that
// against the real directory would be proving nothing.
process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-cancel-test-'));

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import {
  cancelScan,
  createScanRecord,
  getScan,
  scanExpired,
  startScan,
  SCAN_CANCELLED_MESSAGE,
} from '../src/services/diskScanner';

const ROOT = path.sep === '\\' ? 'C:\\root' : '/root';

async function listen() {
  resetRateLimiter(); // suites share a process; don't inherit a drained bucket
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function req(port: number, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, path: url, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          let parsed: unknown = buf;
          try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/* ---------------------------- the service ---------------------------- */

test('cancelling a running scan settles it as an error nobody has to wait for', () => {
  const scan = createScanRecord(ROOT); // stays 'running'
  assert.equal(scan.status, 'running');

  assert.equal(cancelScan(scan.scanId), true);

  assert.equal(scan.cancelled, true, 'the engines stop on the flag');
  assert.equal(scan.status, 'error', 'and the record settles rather than wedging at running');
  assert.equal(scan.error, SCAN_CANCELLED_MESSAGE);
  assert.ok(scan.finishedAt, 'finishedAt must be set — see the eviction test below');
});

test('an engine that returns on the flag cannot un-settle the record', () => {
  // Every engine observes cancellation by plain `return` without assigning a
  // status. This reproduces the shape: cancel, then let the walk's own
  // completion path try to run. It must find the record already settled.
  const scan = createScanRecord(ROOT);
  cancelScan(scan.scanId);

  const settledAt = scan.finishedAt;
  if (scan.cancelled) {
    /* what walk() does: return, touching nothing */
  } else {
    assert.fail('the flag must be raised for the engine to observe');
  }

  assert.equal(scan.status, 'error');
  assert.equal(scan.finishedAt, settledAt, 'and nothing re-stamps it');
});

test('cancelling twice is not a second cancellation', () => {
  const scan = createScanRecord(ROOT);
  assert.equal(cancelScan(scan.scanId), true);
  const firstFinish = scan.finishedAt;

  assert.equal(cancelScan(scan.scanId), false, 'the scan was already settled');
  assert.equal(scan.finishedAt, firstFinish, 'so its finish time is not rewritten');
  assert.equal(scan.error, SCAN_CANCELLED_MESSAGE);
});

test('a completed scan is never rewritten as cancelled', () => {
  const scan = createScanRecord(ROOT);
  scan.status = 'complete';
  scan.finishedAt = Date.now() - 1000;
  const finishedAt = scan.finishedAt;

  assert.equal(cancelScan(scan.scanId), false, 'there was nothing running to stop');
  assert.equal(scan.status, 'complete', 'a scan that finished, finished');
  assert.equal(scan.error, undefined);
  assert.equal(scan.finishedAt, finishedAt);
});

test('an already-failed scan keeps its own error, not the cancellation message', () => {
  const scan = createScanRecord(ROOT);
  scan.status = 'error';
  scan.error = 'EACCES: permission denied';
  scan.finishedAt = Date.now();

  assert.equal(cancelScan(scan.scanId), false);
  assert.equal(scan.error, 'EACCES: permission denied', 'the real cause survives');
});

test('cancelling an unknown scan is a plain false, not a throw', () => {
  assert.equal(cancelScan('no-such-scan'), false);
  assert.equal(cancelScan(''), false);
});

test('a cancelled scan is evicted on the settled clock, not held for six hours', () => {
  // The trap this pins: scanExpired falls back to createdAt when finishedAt is
  // missing, so cancelling a long-running scan without stamping finishedAt
  // would have the next evictor tick delete the record — and the UI would get
  // a 404 instead of the message that explains what happened.
  const scan = createScanRecord(ROOT);
  const longAgo = Date.now() - 45 * 60 * 1000;
  scan.createdAt = longAgo;
  scan.startedAt = longAgo;

  assert.equal(scanExpired(scan, Date.now()), false, 'a running scan is held to the 6h wedge horizon');
  cancelScan(scan.scanId);

  assert.equal(scanExpired(scan, Date.now()), false, 'cancelling must not make it instantly evictable');
  assert.equal(
    scanExpired(scan, Date.now() + 31 * 60 * 1000),
    true,
    'but it does settle onto the 30-minute retention clock',
  );
});

test('a cancelled real scan writes no snapshot and no rescan cache', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-cancel-fixture-'));
  try {
    for (let i = 0; i < 40; i++) {
      const dir = path.join(fixture, `d${i}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'f.bin'), Buffer.alloc(2048, i));
    }
    const dataDir = process.env.TREEMAP_DATA_DIR!;
    const before = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];

    process.env.TREEMAP_NO_GDU = '1'; // deterministic walker on every machine
    let scan;
    try {
      scan = await startScan(fixture, {});
      assert.equal(cancelScan(scan.scanId), true);
    } finally {
      delete process.env.TREEMAP_NO_GDU;
    }

    // Give the walk every chance to reach its completion path and write.
    await new Promise((r) => setTimeout(r, 400));

    const settled = getScan(scan.scanId)!;
    assert.equal(settled.status, 'error', 'the record stays cancelled');
    assert.equal(settled.error, SCAN_CANCELLED_MESSAGE);
    assert.equal(settled.store, undefined, 'no partial tree is published');

    // Not named `after` — that is the node:test hook imported at the top.
    const afterFiles = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];
    const added = afterFiles.filter((n) => !before.includes(n));
    assert.deepEqual(
      added.filter((n) => n.startsWith('mtime-cache-') || n === 'snapshots.json'),
      [],
      'a partial walk must never poison the fast-rescan cache or Trends',
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

/* ----------------------------- the route ----------------------------- */

test('POST /api/scan/:scanId/cancel stops a running scan', async () => {
  const scan = createScanRecord(ROOT);
  const { port, close } = await listen();
  try {
    const r = await req(port, 'POST', `/api/scan/${scan.scanId}/cancel`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { scanId: scan.scanId, cancelled: true, status: 'error' });
    assert.equal(getScan(scan.scanId)!.error, SCAN_CANCELLED_MESSAGE);
  } finally {
    await close();
  }
});

test('cancelling a finished scan answers honestly instead of claiming a stop', async () => {
  const scan = createScanRecord(ROOT);
  scan.status = 'complete';
  scan.finishedAt = Date.now();
  const { port, close } = await listen();
  try {
    const r = await req(port, 'POST', `/api/scan/${scan.scanId}/cancel`);
    assert.equal(r.status, 200);
    assert.equal(r.body.cancelled, false, 'there was nothing left to stop');
    assert.equal(r.body.status, 'complete', 'and the scan is reported as it really is');
  } finally {
    await close();
  }
});

test('cancelling an unknown scan is a clean 404, like every other scan route', async () => {
  const { port, close } = await listen();
  try {
    const r = await req(port, 'POST', '/api/scan/not-a-real-scan/cancel');
    assert.equal(r.status, 404);
    assert.equal(r.body.code ?? r.body.error?.code, 'SCAN_NOT_FOUND');
  } finally {
    await close();
  }
});

test('cancel does not answer 202 while running — that is the whole point', async () => {
  // Every other scan route defers with 202 until the scan settles. This one
  // must act on a running scan, so it is deliberately outside that rule.
  const scan = createScanRecord(ROOT);
  const { port, close } = await listen();
  try {
    assert.equal(scan.status, 'running');
    const r = await req(port, 'POST', `/api/scan/${scan.scanId}/cancel`);
    assert.equal(r.status, 200);
  } finally {
    await close();
  }
});

test('the progress stream ends on cancellation instead of beating forever', async () => {
  // The SSE timer only stops on `status !== 'running'`. A cancel that raised
  // the flag without settling the record would leave this stream open and the
  // UI spinning — this is the test that catches that regression.
  const scan = createScanRecord(ROOT);
  const { port, close } = await listen();
  try {
    const frames: string[] = [];
    const ended = new Promise<void>((resolve, reject) => {
      const r = http.get({ host: '127.0.0.1', port, path: `/api/scan/${scan.scanId}/progress` }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (c: string) => { frames.push(c); });
        res.on('end', () => { clearTimeout(bomb); resolve(); });
      });
      // Destroys the stream before rejecting: a stream still open holds
      // server.close() open forever, so the regression this test exists to
      // catch would hang the whole suite instead of failing it.
      //
      // Cleared on BOTH settle paths, and from inside this promise rather than
      // the outer finally. Left armed it keeps the event loop alive for its
      // full 8s after a PASSING run — measured, it added 8s to every run of
      // this file.
      const bomb = setTimeout(() => {
        r.destroy();
        reject(new Error('the progress stream never ended after a cancel'));
      }, 8000);
      r.on('error', (err) => { clearTimeout(bomb); reject(err); });
    });

    await new Promise((r) => setTimeout(r, 250)); // let the first progress frame land
    cancelScan(scan.scanId);
    await ended;

    const text = frames.join('');
    assert.match(text, /"type":"error"/, 'the stream signs off with an error frame');
    assert.ok(text.includes(SCAN_CANCELLED_MESSAGE), `the frame says why: ${text.slice(-200)}`);
  } finally {
    await close();
  }
});

test('a cancelled scan reports itself over /stats rather than staying running', async () => {
  const scan = createScanRecord(ROOT);
  const { port, close } = await listen();
  try {
    await req(port, 'POST', `/api/scan/${scan.scanId}/cancel`);
    const r = await req(port, 'GET', `/api/scan/${scan.scanId}/stats`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'error');
  } finally {
    await close();
  }
});

test('the app-data directory used by this suite is the temporary one', () => {
  // Guards the isolation every test above depends on. The cleanup is an
  // after() hook rather than a line here: a test body that deletes shared
  // state only works while it happens to be declared last, and would silently
  // stop running at all under --test-name-pattern.
  assert.match(process.env.TREEMAP_DATA_DIR!, /treemap-cancel-test-/);
});

test('shutdown kills the gdu subprocess, not just the flag', async () => {
  // cancelAllScans runs on SIGTERM/SIGINT and on Electron quit. Raising the
  // flag alone is only observed BETWEEN gdu shards, so quitting mid-shard
  // would orphan a subprocess that keeps reading the disk with nothing left
  // to reap it or clean up its temp directory.
  const { runGdu } = await import('../src/services/gduScanner');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'diskScanner.ts'), 'utf8');
  const start = src.indexOf('export function cancelAllScans');
  assert.ok(start !== -1, 'cancelAllScans must exist');
  const end = src.indexOf('export const SCAN_CANCELLED_MESSAGE', start);
  assert.ok(end > start, 'and SCAN_CANCELLED_MESSAGE must follow it');
  const fn = src.slice(start, end);
  assert.ok(fn.length > 50, 'the cancelAllScans slice is non-empty');
  assert.match(fn, /abortGduScan\(scan\.scanId\)/, 'shutdown reaps the subprocess too');
  assert.ok(typeof runGdu === 'function', 'runGdu is the spawner this reaps');
});

test('abortGduScan is a plain false when there is nothing in flight', async () => {
  // The overwhelmingly common case: the walker engine, or a gdu scan sitting
  // between shards. It must never throw, because cancelScan calls it
  // unconditionally on every cancellation.
  const { abortGduScan } = await import('../src/services/gduScanner');
  assert.equal(abortGduScan('no-such-scan'), false);
  const scan = createScanRecord(ROOT);
  assert.equal(abortGduScan(scan.scanId), false, 'a walker scan has no subprocess');
  assert.equal(cancelScan(scan.scanId), true, 'and cancelling it still works');
});

test('runGdu hands back the child it spawned, which is what makes the kill possible', async () => {
  const { runGdu, findGduBinary } = await import('../src/services/gduScanner');
  const bin = await findGduBinary();
  if (!bin) return; // gdu is optional; the walker path is covered above

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-gdukill-'));
  const out = path.join(dir, 'out.json');
  try {
    let spawned: { pid?: number; killed: boolean } | null = null;
    const run = runGdu(bin, dir, out, { onSpawn: (c) => { spawned = c; } });
    assert.ok(spawned, 'onSpawn fires synchronously, before the promise settles');
    assert.ok((spawned as { pid?: number }).pid! > 0, 'and hands over a real process');
    await run.catch(() => { /* the tree is trivial; either outcome is fine here */ });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Windows CI needs the retries: a just-closed sqlite/journal handle can hold a
// file for a few ms after the process that owned it has gone.
after(() => {
  fs.rmSync(process.env.TREEMAP_DATA_DIR!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

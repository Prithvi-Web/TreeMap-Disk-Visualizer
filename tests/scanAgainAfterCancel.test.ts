import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-scanAgainAfterCancel-data-');

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { getScan, setRootCheckForTests, SCAN_CANCELLED_MESSAGE } from '../src/services/diskScanner';
import { nativeScanModule } from '../src/services/scan/native';
import { updateSettings } from '../src/services/settings';
import { waitFor } from './fixtures/waitFor';

/**
 * The owner, 17 Oct 2026: "a scan should work again after being stopped."
 * The page's half is tests/coreScanFlow.test.ts. This is the server's: a scan
 * cancelled through the route the Stop button calls, then at once — while the
 * cancelled walk is still winding down — a new scan of the same folder, and
 * of another, each reaching `complete`.
 *
 * The cancelled scan is held at its last step, the root check every engine
 * awaits before it settles (setRootCheckForTests), until the new scan has
 * been asked for: so the cancel always finds it running, and the new scan
 * always starts beside a walk that has not finished. On the walker, and on
 * the native engine wherever its prebuilt module loads (it is not built on
 * every CI machine; there the native half says why it skipped).
 */

async function listen() {
  resetRateLimiter();
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function req(port: number, method: string, url: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, path: url, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          let parsed: Record<string, unknown> = {};
          try { parsed = JSON.parse(buf) as Record<string, unknown>; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** A small folder of a few files in a few subfolders. */
function tree(prefix: string): string {
  const root = fileTempDir(prefix);
  for (let i = 0; i < 6; i++) {
    const dir = path.join(root, `d${i}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'f.bin'), Buffer.alloc(1000 + i, i));
  }
  return fs.realpathSync(root);
}

/** Stop the scan of `first`, then scan `then` at once; answers what each scan settled as. */
async function stopThenScan(port: number, first: string, then: string) {
  let release: (() => void) | null = null;
  let holding = true;
  // Only the scan to be stopped is held; the scan asked for after it runs straight through.
  setRootCheckForTests(async () => {
    if (!holding) return;
    holding = false;
    await new Promise<void>((r) => { release = r; });
  });
  try {
    const started = await req(port, 'POST', '/api/scan', { path: first, interactive: true });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const stopped = String(started.body.scanId);
    await waitFor(() => release !== null, 'the first scan reaching its last step');
    const cancel = await req(port, 'POST', `/api/scan/${stopped}/cancel`);
    assert.deepEqual(cancel.body, { scanId: stopped, cancelled: true, status: 'error' }, 'the Stop found the scan running and settled it');
    // At once: the cancelled walk is still held at its last step.
    const again = await req(port, 'POST', '/api/scan', { path: then, interactive: true });
    assert.equal(again.status, 202, `a new scan is accepted straight after a Stop: ${JSON.stringify(again.body)}`);
    const next = String(again.body.scanId);
    assert.notEqual(next, stopped, 'as a scan of its own');
    (release as unknown as () => void)();
    await waitFor(async () => (await req(port, 'GET', `/api/scan/${next}/stats`)).body.status !== 'running', 'the new scan settling');
    await waitFor(() => getScan(stopped)?.status !== 'running', 'the stopped scan settling');
    return { stopped: getScan(stopped)!, next: getScan(next)! };
  } finally {
    setRootCheckForTests(null);
  }
}

async function both(engine: 'walker' | 'native') {
  await updateSettings({ engine });
  const a = tree(`treemap-again-${engine}-a-`);
  const b = tree(`treemap-again-${engine}-b-`);
  const { port, close } = await listen();
  try {
    const same = await stopThenScan(port, a, a);
    assert.deepEqual([same.stopped.status, same.stopped.error, same.stopped.store], ['error', SCAN_CANCELLED_MESSAGE, undefined], 'the stopped scan stays stopped');
    assert.equal(same.next.status, 'complete', `the same folder, scanned again at once, completes: ${same.next.error ?? ''}`);
    assert.equal(same.next.rootPath, a);
    assert.equal(same.next.fileCount, 6, 'and counts every file');
    const other = await stopThenScan(port, a, b);
    assert.equal(other.stopped.status, 'error');
    assert.equal(other.next.status, 'complete', `another folder, scanned at once, completes: ${other.next.error ?? ''}`);
    assert.equal(other.next.rootPath, b);
    return [same.next.engine, other.next.engine];
  } finally {
    await close();
    await updateSettings({ engine: 'auto' });
  }
}

test('Stop, then at once a new scan of the same folder and of another: each completes, on the walker', async () => {
  process.env.TREEMAP_NO_GDU = '1';
  try {
    const engines = await both('walker');
    assert.ok(engines.every((e) => e === 'walker' || e === 'turbo-walker'), `control: the built-in walker ran both (${engines.join(', ')})`);
  } finally {
    delete process.env.TREEMAP_NO_GDU;
  }
});

const native = nativeScanModule();
test('Stop, then at once a new scan of the same folder and of another: each completes, on the native engine',
  { skip: native.available ? false : `the native module does not load here: ${native.available ? '' : native.reason}` }, async () => {
    assert.deepEqual(await both('native'), ['native', 'native'], 'control: the native engine ran both');
  });

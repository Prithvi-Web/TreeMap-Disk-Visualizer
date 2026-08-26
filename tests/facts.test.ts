import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-facts-test-'));
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import {
  clearFactCache,
  computeFacts,
  factCacheSize,
  factProviderIds,
  getFactProvider,
  registerFactProvider,
  unregisterFactProvider,
} from '../src/services/facts';
import { setFactCacheLimitsForTests } from '../src/services/facts/registry';
import { unavailableBatch, FactBatch, FactProvider } from '../src/services/facts/types';
import { MAX_FACT_PATHS } from '../src/api/factRoutes';

/**
 * The fact layer (v4 §0.2 / §4.1).
 *
 * What these tests are really defending is one sentence from §2.4: **a path
 * absent from `values` was not computable, and that is not a zero.** Every
 * downstream v4 feature — the reclaim score, the query grammar's `used>1y`,
 * the recoverability verdict — reads this layer, and each of them would
 * happily render an invented zero as a fact if the layer permitted it. So the
 * "absent is not zero" case, the stats arithmetic that lets a partial result
 * state itself, and the failure isolation between providers are all pinned
 * here rather than left to the consumers to get right individually.
 */

/* ------------------------------ harness ------------------------------ */

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

function req(port: number, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        host: '127.0.0.1',
        port,
        path: url,
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
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

/** A fixture with known, distinct byte counts, and a completed scan over it. */
async function scannedFixture(port: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-facts-fixture-'));
  fs.writeFileSync(path.join(root, 'small.txt'), Buffer.alloc(11, 0x61));
  fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(4096, 0x62));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'leaf.dat'), Buffer.alloc(2048, 0x63));

  const started = await req(port, 'POST', '/api/scan', { path: root });
  assert.equal(started.status, 202, `scan refused: ${JSON.stringify(started.body)}`);
  const scanId = started.body.scanId as string;
  for (let i = 0; i < 200; i++) {
    const stats = await req(port, 'GET', `/api/scan/${scanId}/stats`);
    if (stats.body.status === 'complete') break;
    assert.notEqual(stats.body.status, 'error', 'fixture scan failed');
    await new Promise((r) => setTimeout(r, 25));
  }
  return { root, scanId, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A provider whose behaviour each test dictates, registered under a unique id. */
function fakeProvider(id: string, compute: FactProvider<unknown>['compute']): FactProvider<unknown> {
  const provider: FactProvider<unknown> = { id, label: `Fake ${id}`, capabilityKey: null, compute };
  registerFactProvider(provider);
  return provider;
}

/* ------------------------------ registry ------------------------------ */

test('the registry resolves providers by id and lists them sorted', () => {
  assert.ok(factProviderIds().includes('size'), 'the built-in size provider is registered');
  assert.equal(getFactProvider('size')?.label, 'Size from the scan');
  assert.equal(getFactProvider('no-such-provider'), undefined);

  fakeProvider('zzz-registry-probe', async () => ({
    available: true, values: new Map(), stats: { requested: 0, computed: 0, skipped: 0, failed: 0 },
  }));
  try {
    const ids = factProviderIds();
    assert.deepEqual(ids, [...ids].sort(), 'ids come back sorted, so error messages are stable');
    assert.ok(ids.includes('zzz-registry-probe'));
  } finally {
    assert.equal(unregisterFactProvider('zzz-registry-probe'), true);
  }
  assert.equal(unregisterFactProvider('zzz-registry-probe'), false, 'unregistering twice reports nothing removed');
});

test('registering the same id twice throws rather than replacing', () => {
  // Two providers answering to one name would otherwise surface as facts that
  // change with module import order — a bug that is very hard to see.
  assert.throws(
    () => registerFactProvider({ id: 'size', label: 'Impostor', capabilityKey: null, compute: async () => unavailableBatch('no', 0) }),
    /already registered/,
  );
});

/* --------------------------- the size provider --------------------------- */

test('POST /api/facts returns the scan\'s own byte counts for a fixture', async () => {
  const { port, close } = await listen();
  const fixture = await scannedFixture(port);
  try {
    clearFactCache();
    const r = await req(port, 'POST', '/api/facts', {
      scanId: fixture.scanId,
      paths: [
        path.join(fixture.root, 'small.txt'),
        path.join(fixture.root, 'big.bin'),
        path.join(fixture.root, 'sub', 'leaf.dat'),
        path.join(fixture.root, 'sub'),
      ],
      providers: ['size'],
    });

    assert.equal(r.status, 200);
    const size = r.body.providers.size;
    assert.equal(size.available, true);
    assert.equal(size.values[path.join(fixture.root, 'small.txt')].bytes, 11);
    assert.equal(size.values[path.join(fixture.root, 'big.bin')].bytes, 4096);
    assert.equal(size.values[path.join(fixture.root, 'sub', 'leaf.dat')].bytes, 2048);
    // A directory's size is its subtree total, summed by the store.
    assert.equal(size.values[path.join(fixture.root, 'sub')].bytes, 2048);
    assert.deepEqual(size.stats, { requested: 4, computed: 4, skipped: 0, failed: 0 });
  } finally {
    fixture.cleanup();
    await close();
  }
});

test('a path the scan does not contain is skipped and absent — never bytes: 0', async () => {
  const { port, close } = await listen();
  const fixture = await scannedFixture(port);
  try {
    clearFactCache();
    const ghost = path.join(fixture.root, 'never-existed.bin');
    const r = await req(port, 'POST', '/api/facts', {
      scanId: fixture.scanId,
      paths: [path.join(fixture.root, 'small.txt'), ghost],
      providers: ['size'],
    });

    assert.equal(r.status, 200);
    const size = r.body.providers.size;
    // The whole point: the key is not present at all. A consumer that reads
    // `values[ghost]?.bytes ?? 0` gets undefined and must handle it, rather
    // than being handed a zero that looks like a measurement.
    assert.equal(Object.prototype.hasOwnProperty.call(size.values, ghost), false);
    assert.equal(size.values[ghost], undefined);
    assert.deepEqual(size.stats, { requested: 2, computed: 1, skipped: 1, failed: 0 });
  } finally {
    fixture.cleanup();
    await close();
  }
});

test('stats always account for every requested path', async () => {
  // requested === computed + skipped + failed is what lets a caller say
  // "scored 41,200 of 58,900" honestly. If it can drift, a partial result can
  // silently present itself as complete.
  const { port, close } = await listen();
  const fixture = await scannedFixture(port);
  try {
    clearFactCache();
    const r = await req(port, 'POST', '/api/facts', {
      scanId: fixture.scanId,
      paths: [
        path.join(fixture.root, 'small.txt'),
        path.join(fixture.root, 'missing-a'),
        path.join(fixture.root, 'missing-b'),
      ],
      providers: ['size'],
    });
    const s = r.body.providers.size.stats;
    assert.equal(s.requested, s.computed + s.skipped + s.failed);
    assert.equal(s.requested, 3);
  } finally {
    fixture.cleanup();
    await close();
  }
});

test('duplicate paths in one request are counted once', async () => {
  const { port, close } = await listen();
  const fixture = await scannedFixture(port);
  try {
    clearFactCache();
    const p = path.join(fixture.root, 'big.bin');
    const r = await req(port, 'POST', '/api/facts', {
      scanId: fixture.scanId,
      paths: [p, p, p],
      providers: ['size'],
    });
    // Otherwise a caller could inflate its own coverage figure just by
    // repeating a path — "4,000 of 4,000 scored" over 1,300 real files.
    assert.deepEqual(r.body.providers.size.stats, { requested: 1, computed: 1, skipped: 0, failed: 0 });
  } finally {
    fixture.cleanup();
    await close();
  }
});

/* ------------------------------ route guards ------------------------------ */

test('the batch cap is enforced at 2000 paths', async () => {
  const { port, close } = await listen();
  const fixture = await scannedFixture(port);
  try {
    const many = Array.from({ length: MAX_FACT_PATHS + 1 }, (_, i) => path.join(fixture.root, `f${i}`));
    const r = await req(port, 'POST', '/api/facts', { scanId: fixture.scanId, paths: many, providers: ['size'] });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'TOO_MANY_PATHS');
    assert.match(r.body.error, /2000/);

    // And exactly at the cap is allowed — an off-by-one here would be
    // invisible until a real screenful of tiles hit it.
    const atCap = many.slice(0, MAX_FACT_PATHS);
    const ok = await req(port, 'POST', '/api/facts', { scanId: fixture.scanId, paths: atCap, providers: ['size'] });
    assert.equal(ok.status, 200);
  } finally {
    fixture.cleanup();
    await close();
  }
});

test('the destructive routes keep their own, smaller cap', async () => {
  // The fact route raising its cap to 2000 must not have raised it anywhere
  // else. DELETE /api/files still refuses at 500.
  const { port, close } = await listen();
  const fixture = await scannedFixture(port);
  try {
    const paths = Array.from({ length: 501 }, (_, i) => path.join(fixture.root, `f${i}`));
    const r = await req(port, 'DELETE', '/api/files', { paths, dryRun: true });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'TOO_MANY_PATHS');
    assert.match(r.body.error, /500/);
  } finally {
    fixture.cleanup();
    await close();
  }
});

test('a path outside every scanned root is refused', async () => {
  const { port, close } = await listen();
  const fixture = await scannedFixture(port);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-facts-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  try {
    const r = await req(port, 'POST', '/api/facts', {
      scanId: fixture.scanId,
      paths: [path.join(outside, 'secret.txt')],
      providers: ['size'],
    });
    // Read-only or not, "what is in this folder" is itself information, and
    // scanning is what grants scoped permission to answer for a tree.
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'OUTSIDE_SCAN_ROOT');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    fixture.cleanup();
    await close();
  }
});

test('an unknown provider id is refused, and the error names the valid ids', async () => {
  const { port, close } = await listen();
  const fixture = await scannedFixture(port);
  try {
    const r = await req(port, 'POST', '/api/facts', {
      scanId: fixture.scanId,
      paths: [path.join(fixture.root, 'small.txt')],
      providers: ['size', 'lastUsedd'],
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'UNKNOWN_PROVIDER');
    assert.match(r.body.error, /"lastUsedd"/, 'the error names what was wrong');
    assert.match(r.body.error, /size/, 'and what would have been right');
    // Silently ignoring an unknown id is the failure mode this prevents: a
    // caller asking for a fact it never receives, and rendering the absence
    // as "nothing matched".
  } finally {
    fixture.cleanup();
    await close();
  }
});

test('a missing or empty providers array is refused', async () => {
  const { port, close } = await listen();
  const fixture = await scannedFixture(port);
  try {
    for (const providers of [undefined, [], 'size']) {
      const r = await req(port, 'POST', '/api/facts', {
        scanId: fixture.scanId,
        paths: [path.join(fixture.root, 'small.txt')],
        ...(providers === undefined ? {} : { providers }),
      });
      assert.equal(r.status, 400, `providers=${JSON.stringify(providers)}`);
      assert.equal(r.body.code, 'PROVIDERS_REQUIRED');
    }
  } finally {
    fixture.cleanup();
    await close();
  }
});

test('an empty paths array and an unknown scanId are each refused', async () => {
  const { port, close } = await listen();
  const fixture = await scannedFixture(port);
  try {
    const noPaths = await req(port, 'POST', '/api/facts', { scanId: fixture.scanId, paths: [], providers: ['size'] });
    assert.equal(noPaths.status, 400);
    assert.equal(noPaths.body.code, 'PATHS_REQUIRED');

    const badScan = await req(port, 'POST', '/api/facts', {
      scanId: 'not-a-real-scan',
      paths: [path.join(fixture.root, 'small.txt')],
      providers: ['size'],
    });
    assert.equal(badScan.status, 404);
    assert.equal(badScan.body.code, 'SCAN_NOT_FOUND');
  } finally {
    fixture.cleanup();
    await close();
  }
});

/* --------------------------- failure isolation --------------------------- */

test('one provider throwing leaves the others intact', async () => {
  const { port, close } = await listen();
  const fixture = await scannedFixture(port);
  fakeProvider('boom', async () => { throw new Error('mdls exited with code 1'); });
  try {
    clearFactCache();
    const r = await req(port, 'POST', '/api/facts', {
      scanId: fixture.scanId,
      paths: [path.join(fixture.root, 'small.txt')],
      providers: ['size', 'boom'],
    });

    assert.equal(r.status, 200, 'a failing provider is not a failed request');
    // The good one still answered.
    assert.equal(r.body.providers.size.available, true);
    assert.equal(r.body.providers.size.values[path.join(fixture.root, 'small.txt')].bytes, 11);
    // The bad one reported itself, carrying the real reason rather than a
    // generic one — §2.4 says the reason is shown to the user verbatim.
    assert.equal(r.body.providers.boom.available, false);
    assert.match(r.body.providers.boom.reason, /mdls exited with code 1/);
    assert.deepEqual(r.body.providers.boom.values, {});
    assert.equal(r.body.providers.boom.stats.failed, 1);
  } finally {
    unregisterFactProvider('boom');
    fixture.cleanup();
    await close();
  }
});

test('a provider reporting itself unavailable yields a reason, not an empty success', async () => {
  const provider = fakeProvider('offline', async (_scanId, paths) =>
    unavailableBatch('Spotlight indexing is turned off for this volume.', paths.length));
  try {
    clearFactCache();
    const out = await computeFacts('scan-x', ['/a', '/b'], ['offline'], new AbortController().signal);
    assert.equal(out.offline.available, false);
    assert.equal(out.offline.reason, 'Spotlight indexing is turned off for this volume.');
    assert.deepEqual(out.offline.stats, { requested: 2, computed: 0, skipped: 2, failed: 0 });
    // Unavailable paths are skipped, not failed: nothing was attempted, so
    // nothing went wrong. Reporting them as failures would make an honest
    // "this machine cannot do that" read as a malfunction.
    assert.equal(provider.id, 'offline');
  } finally {
    unregisterFactProvider('offline');
  }
});

/* --------------------------------- cache --------------------------------- */

test('a second request for the same paths is served from cache', async () => {
  let calls = 0;
  fakeProvider('counted', async (_scanId, paths) => {
    calls++;
    return {
      available: true,
      values: new Map(paths.map((p) => [p, { n: calls }])),
      stats: { requested: paths.length, computed: paths.length, skipped: 0, failed: 0 },
    } as FactBatch<unknown>;
  });
  try {
    clearFactCache();
    const signal = new AbortController().signal;
    const first = await computeFacts('scan-c', ['/a', '/b'], ['counted'], signal);
    const second = await computeFacts('scan-c', ['/a', '/b'], ['counted'], signal);

    assert.equal(calls, 1, 'the provider ran once');
    assert.deepEqual(second.counted.values, first.counted.values, 'and the same answer came back');
    assert.deepEqual(second.counted.stats, { requested: 2, computed: 2, skipped: 0, failed: 0 },
      'cache hits still count as computed — otherwise a fully-answered batch looks partial');

    // A different scan id is a different question, even for the same path.
    await computeFacts('scan-OTHER', ['/a'], ['counted'], signal);
    assert.equal(calls, 2, 'facts are not shared across scans');
  } finally {
    unregisterFactProvider('counted');
  }
});

test('only the uncached paths reach the provider', async () => {
  const seen: string[][] = [];
  fakeProvider('partial', async (_scanId, paths) => {
    seen.push([...paths]);
    return {
      available: true,
      values: new Map(paths.map((p) => [p, { ok: true }])),
      stats: { requested: paths.length, computed: paths.length, skipped: 0, failed: 0 },
    } as FactBatch<unknown>;
  });
  try {
    clearFactCache();
    const signal = new AbortController().signal;
    await computeFacts('scan-p', ['/a'], ['partial'], signal);
    const out = await computeFacts('scan-p', ['/a', '/b'], ['partial'], signal);

    assert.deepEqual(seen, [['/a'], ['/b']], 'the second call only asked about the new path');
    assert.deepEqual(Object.keys(out.partial.values).sort(), ['/a', '/b'], 'but both came back');
    assert.deepEqual(out.partial.stats, { requested: 2, computed: 2, skipped: 0, failed: 0 });
  } finally {
    unregisterFactProvider('partial');
  }
});

test('cached facts expire, and expiry evicts them from the cache', async () => {
  let calls = 0;
  fakeProvider('ttl', async (_scanId, paths) => {
    calls++;
    return {
      available: true,
      values: new Map(paths.map((p) => [p, { calls }])),
      stats: { requested: paths.length, computed: paths.length, skipped: 0, failed: 0 },
    } as FactBatch<unknown>;
  });
  const restore = setFactCacheLimitsForTests({ ttlMs: 1 });
  try {
    clearFactCache();
    const signal = new AbortController().signal;
    await computeFacts('scan-t', ['/a'], ['ttl'], signal);
    assert.equal(calls, 1);
    assert.equal(factCacheSize(), 1);

    await new Promise((r) => setTimeout(r, 20));

    const again = await computeFacts('scan-t', ['/a'], ['ttl'], signal);
    assert.equal(calls, 2, 'an expired fact is recomputed, not served stale');
    assert.deepEqual(again.ttl.values['/a'], { calls: 2 });
    assert.equal(factCacheSize(), 1, 'and the expired entry was swept, not merely ignored');
  } finally {
    restore();
    unregisterFactProvider('ttl');
    clearFactCache();
  }
});

test('the cache is bounded: oldest entries are evicted past the cap', async () => {
  fakeProvider('bulk', async (_scanId, paths) => ({
    available: true,
    values: new Map(paths.map((p) => [p, { p }])),
    stats: { requested: paths.length, computed: paths.length, skipped: 0, failed: 0 },
  } as FactBatch<unknown>));
  const restore = setFactCacheLimitsForTests({ maxEntries: 10 });
  try {
    clearFactCache();
    const signal = new AbortController().signal;
    const paths = Array.from({ length: 25 }, (_, i) => `/f${i}`);
    await computeFacts('scan-b', paths, ['bulk'], signal);

    // An unbounded side table is how a desktop app that holds itself to
    // 56 bytes per node develops a slow leak anyway.
    assert.equal(factCacheSize(), 10, 'the cap is honoured');
  } finally {
    restore();
    unregisterFactProvider('bulk');
    clearFactCache();
  }
});

test('clearFactCache drops one scan without touching the others', async () => {
  fakeProvider('scoped', async (_scanId, paths) => ({
    available: true,
    values: new Map(paths.map((p) => [p, { p }])),
    stats: { requested: paths.length, computed: paths.length, skipped: 0, failed: 0 },
  } as FactBatch<unknown>));
  try {
    clearFactCache();
    const signal = new AbortController().signal;
    await computeFacts('scan-keep', ['/a'], ['scoped'], signal);
    await computeFacts('scan-drop', ['/a'], ['scoped'], signal);
    assert.equal(factCacheSize(), 2);

    clearFactCache('scan-drop');
    assert.equal(factCacheSize(), 1, 'a rescan invalidates its own facts only');
  } finally {
    unregisterFactProvider('scoped');
    clearFactCache();
  }
});

/* --------------------------------- abort --------------------------------- */

test('an abort reaches the provider', async () => {
  let sawAbort = false;
  fakeProvider('slow', async (_scanId, paths, signal) => {
    await new Promise((r) => setTimeout(r, 30));
    sawAbort = signal.aborted;
    return {
      available: true,
      values: new Map(),
      stats: { requested: paths.length, computed: 0, skipped: paths.length, failed: 0 },
    } as FactBatch<unknown>;
  });
  try {
    clearFactCache();
    const controller = new AbortController();
    const pending = computeFacts('scan-a', ['/a'], ['slow'], controller.signal);
    controller.abort();
    await pending;
    // Providers shell out to per-OS tools; a client that navigated away must
    // stop the work, not merely stop reading its result.
    assert.equal(sawAbort, true);
  } finally {
    unregisterFactProvider('slow');
  }
});

test('the size provider stops early when aborted, and still accounts for every path', async () => {
  const { port, close } = await listen();
  const fixture = await scannedFixture(port);
  try {
    clearFactCache();
    const controller = new AbortController();
    controller.abort();
    const out = await computeFacts(
      fixture.scanId,
      [path.join(fixture.root, 'small.txt'), path.join(fixture.root, 'big.bin')],
      ['size'],
      controller.signal,
    );
    const s = out.size.stats;
    assert.equal(s.requested, 2);
    assert.equal(s.requested, s.computed + s.skipped + s.failed, 'an abandoned batch still adds up');
    assert.equal(s.computed, 0, 'an already-aborted batch computes nothing');
  } finally {
    fixture.cleanup();
    await close();
  }
});

/* ------------------------- the golden-response lock ------------------------- */

test('the fact route adds nothing to the byte-locked scan responses', async () => {
  // The reason this whole layer exists. If a future change ever merges a fact
  // into /api/scan/:id/result, goldenResponses.test.ts fails — but only on
  // macOS, and only if someone runs it. This assertion states the intent in
  // the fact layer's own test, where a person editing facts will see it.
  const { port, close } = await listen();
  const fixture = await scannedFixture(port);
  try {
    const result = await req(port, 'GET', `/api/scan/${fixture.scanId}/result`);
    assert.equal(result.status, 200);
    for (const forbidden of ['facts', 'reclaimScore', 'lastUsed', 'recoverability', 'note']) {
      assert.equal(forbidden in result.body, false, `/result must not carry "${forbidden}"`);
    }
    const nodes = await req(port, 'POST', `/api/scan/${fixture.scanId}/nodes`, {
      paths: [path.join(fixture.root, 'small.txt')],
    });
    const node = nodes.body.nodes[path.join(fixture.root, 'small.txt')];
    assert.ok(node, 'the fixture node resolved');
    for (const forbidden of ['facts', 'reclaimScore', 'lastUsed', 'recoverability', 'note']) {
      assert.equal(forbidden in node, false, `node payloads must not carry "${forbidden}"`);
    }
  } finally {
    fixture.cleanup();
    await close();
  }
});

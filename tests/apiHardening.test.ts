import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../src/server';
import { createScanRecord } from '../src/services/diskScanner';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { FileNode } from '../src/models/types';

/**
 * Hardening of the endpoints added for the pruned-tree work. Every case here
 * is either hostile input or a shape a real client can produce by accident.
 * The bar: a defined, honest response — never a crash, never a leak outside
 * the scanned root.
 */

function tree(): FileNode {
  return {
    name: 'root', path: '/root', type: 'dir', modifiedAt: 0, isHidden: false, size: 30,
    children: [
      { name: 'a.txt', path: '/root/a.txt', size: 10, type: 'file', modifiedAt: 0, isHidden: false, extension: 'txt' },
      {
        name: 'sub', path: '/root/sub', type: 'dir', modifiedAt: 0, isHidden: false, size: 20,
        children: [{ name: 'b.txt', path: '/root/sub/b.txt', size: 20, type: 'file', modifiedAt: 0, isHidden: false, extension: 'txt' }],
      },
    ],
  };
}

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

async function withScan(fn: (port: number, scanId: string) => Promise<void>): Promise<void> {
  const scan = createScanRecord('/root');
  scan.status = 'complete';
  scan.root = tree();
  scan.fileCount = 2;
  scan.dirCount = 2;
  const { port, close } = await listen();
  try { await fn(port, scan.scanId); } finally { await close(); }
}

/* ------------------------------ /subtree ------------------------------ */

test('subtree refuses path traversal out of the scanned root', async () => {
  await withScan(async (port, scanId) => {
    const attacks = [
      '/root/../../../etc/passwd',
      '/root/sub/../../../../etc/shadow',
      '/etc/passwd',
      '/root/../root-evil',
    ];
    for (const p of attacks) {
      const r = await req(port, 'GET', `/api/scan/${scanId}/subtree?path=${encodeURIComponent(p)}`);
      assert.ok(r.status === 403 || r.status === 404, `${p} must be refused, got ${r.status}`);
      assert.ok(!JSON.stringify(r.body).includes('passwd'), `${p} must not leak anything`);
    }
  });
});

test('subtree rejects a null byte in the path', async () => {
  await withScan(async (port, scanId) => {
    const r = await req(port, 'GET', `/api/scan/${scanId}/subtree?path=${encodeURIComponent('/root/a.txt\0.png')}`);
    assert.ok(r.status >= 400, `a null byte must be refused, got ${r.status}`);
  });
});

test('subtree survives junk maxNodes values', async () => {
  await withScan(async (port, scanId) => {
    for (const v of ['abc', '-5', '0', 'NaN', 'Infinity', '999999999999', '1e400', '', '1.5']) {
      const r = await req(port, 'GET', `/api/scan/${scanId}/subtree?path=${encodeURIComponent('/root')}&maxNodes=${encodeURIComponent(v)}`);
      assert.equal(r.status, 200, `maxNodes=${v} should clamp, not fail (got ${r.status})`);
      assert.equal(r.body.root.path, '/root');
      assert.equal(r.body.root.size, 30, 'size stays exact whatever the budget');
    }
  });
});

test('subtree on an unknown scanId is a clean 404', async () => {
  await withScan(async (port) => {
    const r = await req(port, 'GET', `/api/scan/does-not-exist/subtree?path=${encodeURIComponent('/root')}`);
    assert.equal(r.status, 404);
  });
});

test('subtree with no path defaults to the scan root', async () => {
  await withScan(async (port, scanId) => {
    const r = await req(port, 'GET', `/api/scan/${scanId}/subtree`);
    assert.equal(r.status, 200);
    assert.equal(r.body.root.path, '/root');
  });
});

/* ------------------------------- /nodes ------------------------------- */

test('nodes rejects a batch over the 500-path cap rather than doing partial work', async () => {
  await withScan(async (port, scanId) => {
    const paths = Array.from({ length: 501 }, (_, i) => `/root/f${i}`);
    const r = await req(port, 'POST', `/api/scan/${scanId}/nodes`, { paths });
    assert.equal(r.status, 400);
    assert.equal(r.body.code ?? r.body.error?.code, 'TOO_MANY_PATHS');
  });
});

test('nodes accepts exactly 500 — the boundary is inclusive', async () => {
  await withScan(async (port, scanId) => {
    const paths = Array.from({ length: 500 }, (_, i) => (i === 0 ? '/root/a.txt' : `/root/f${i}`));
    const r = await req(port, 'POST', `/api/scan/${scanId}/nodes`, { paths });
    assert.equal(r.status, 200, 'exactly 500 must be allowed');
    assert.equal(r.body.nodes['/root/a.txt'].size, 10);
    assert.equal(r.body.nodes['/root/f1'], null, 'unknown paths resolve to null');
  });
});

test('nodes rejects malformed bodies without crashing', async () => {
  await withScan(async (port, scanId) => {
    for (const body of [{}, { paths: [] }, { paths: 'not-an-array' }, { paths: [123] }, { paths: [null] }]) {
      const r = await req(port, 'POST', `/api/scan/${scanId}/nodes`, body);
      assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body)} → expected 4xx, got ${r.status}`);
    }
  });
});

/* --------------------------- /cleanup/rules --------------------------- */

test('cleanup rules refuses a request with no rules enabled', async () => {
  await withScan(async (port, scanId) => {
    const r = await req(port, 'GET', `/api/cleanup/rules?scanId=${scanId}`);
    assert.equal(r.status, 400, 'no rules would match the whole disk');
  });
});

test('cleanup rules survives junk parameter values', async () => {
  await withScan(async (port, scanId) => {
    const junk = [
      'maxAgeMs=abc', 'maxAgeMs=-999', 'minBytes=NaN', 'minBytes=-1',
      'exts=' + encodeURIComponent('.TXT, .Txt ,,,'), 'exts=' + encodeURIComponent('<script>'),
      'dup=maybe&minBytes=0', 'limit=0&minBytes=0', 'limit=99999&minBytes=0',
    ];
    for (const q of junk) {
      const r = await req(port, 'GET', `/api/cleanup/rules?scanId=${scanId}&${q}`);
      assert.ok(r.status === 200 || r.status === 400, `${q} → expected 200/400, got ${r.status}`);
      if (r.status === 200) assert.ok(Array.isArray(r.body.files), `${q} must return a file list`);
    }
  });
});

test('cleanup rules normalises extensions the way the UI does', async () => {
  await withScan(async (port, scanId) => {
    // Leading dots, mixed case and stray commas must all resolve to "txt".
    const r = await req(port, 'GET', `/api/cleanup/rules?scanId=${scanId}&exts=${encodeURIComponent('.TXT, ,txt')}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.matched, 2, 'both .txt files should match');
  });
});

/* ------------------------- /cleanup/cloud-safe ------------------------ */

test('cloud-safe returns exact zeroes rather than failing on a scan with none', async () => {
  await withScan(async (port, scanId) => {
    const r = await req(port, 'GET', `/api/cleanup/cloud-safe?scanId=${scanId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.totalCount, 0);
    assert.deepEqual(r.body.groups, []);
  });
});

/* ----------------------- concurrency / running ------------------------ */

test('every new endpoint answers 202 while the scan is still running', async () => {
  const scan = createScanRecord('/root'); // stays 'running'
  const { port, close } = await listen();
  try {
    const urls = [
      `/api/scan/${scan.scanId}/subtree?path=${encodeURIComponent('/root')}`,
      `/api/cleanup/rules?scanId=${scan.scanId}&minBytes=0`,
      `/api/cleanup/cloud-safe?scanId=${scan.scanId}`,
    ];
    for (const u of urls) {
      const r = await req(port, 'GET', u);
      assert.equal(r.status, 202, `${u} should be 202 while running, got ${r.status}`);
    }
    const post = await req(port, 'POST', `/api/scan/${scan.scanId}/nodes`, { paths: ['/root/a.txt'] });
    assert.equal(post.status, 202);
  } finally {
    await close();
  }
});

test('50 concurrent subtree requests are each served correctly or cleanly rate-limited', async () => {
  await withScan(async (port, scanId) => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        req(port, 'GET', `/api/scan/${scanId}/subtree?path=${encodeURIComponent('/root/sub')}`)),
    );
    let served = 0, limited = 0;
    for (const r of results) {
      if (r.status === 429) { limited++; continue; } // a real, honest answer
      assert.equal(r.status, 200, `unexpected status ${r.status}`);
      assert.equal(r.body.root.size, 20, 'concurrent reads must never disagree');
      assert.equal(r.body.root.children.length, 1);
      served++;
    }
    assert.ok(served > 0, 'the burst allowance should serve some of them');
    assert.equal(served + limited, 50, 'every request gets a defined answer — none hang or crash');
  });
});

test('concurrent prunes never mutate the shared scan tree', async () => {
  const scan = createScanRecord('/root');
  scan.status = 'complete';
  scan.root = tree();
  const before = JSON.stringify(scan.root);
  const { port, close } = await listen();
  try {
    await Promise.all([
      ...Array.from({ length: 20 }, () => req(port, 'GET', `/api/scan/${scan.scanId}/subtree?path=${encodeURIComponent('/root')}&maxNodes=1`)),
      ...Array.from({ length: 20 }, () => req(port, 'GET', `/api/scan/${scan.scanId}/result`)),
    ]);
    assert.equal(JSON.stringify(scan.root), before, 'the live scan tree must be untouched by reads');
  } finally {
    await close();
  }
});

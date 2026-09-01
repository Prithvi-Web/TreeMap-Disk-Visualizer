import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../src/server';
import { createScanRecord } from '../src/services/diskScanner';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { FileNode } from '../src/models/types';

/**
 * GET /api/cleanup/rules — query parsing.
 *
 * The NO_RULES guard exists because a request with nothing enabled matches the
 * entire disk, which is never what the user meant. The guard is only as good as
 * the parser feeding it: a rule built from `Number(x) || 0` is *present* even
 * when the value was junk or an explicit zero, so the guard sees "a rule is
 * enabled", waves the request through, and the user gets every file on the disk
 * offered up for deletion. These tests pin the parser's real contract — a rule
 * is installed only when its value parses to a finite POSITIVE number — because
 * that is the property the guard depends on, and it cannot defend itself.
 *
 * A zero floor is not a rule, it is the absence of one: "files at least 0 bytes"
 * and "files at least 0 ms old" both select everything, so they must reach the
 * guard as omitted rather than as a filter that happens to filter nothing.
 */

const ROOT = path.resolve('/rulesroot');
const R = (...parts: string[]) => path.join(ROOT, ...parts);

const DAY = 86_400_000;
const NOW = Date.now();

/**
 * Three files chosen so age and size each single one out: only `ancient.log` is
 * old, only `big.bin` is large. A rule that is silently dropped therefore shows
 * up as a *count*, not just a status code.
 */
function tree(): FileNode {
  return {
    name: 'rulesroot', path: ROOT, type: 'dir', modifiedAt: 0, isHidden: false, size: 5_030,
    children: [
      { name: 'ancient.log', path: R('ancient.log'), size: 10, type: 'file', modifiedAt: NOW - 400 * DAY, isHidden: false, extension: 'log' },
      { name: 'fresh.txt', path: R('fresh.txt'), size: 20, type: 'file', modifiedAt: NOW, isHidden: false, extension: 'txt' },
      { name: 'big.bin', path: R('big.bin'), size: 5_000, type: 'file', modifiedAt: NOW, isHidden: false, extension: 'bin' },
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

function get(port: number, url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: url, method: 'GET' }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => {
        let parsed: unknown = buf;
        try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

async function withScan(fn: (port: number, scanId: string) => Promise<void>): Promise<void> {
  const scan = createScanRecord(ROOT);
  scan.status = 'complete';
  scan.root = tree();
  scan.fileCount = 3;
  scan.dirCount = 1;
  const { port, close } = await listen();
  try { await fn(port, scan.scanId); } finally { await close(); }
}

/* --------------- a value that is not a rule must not count -------------- */

test('an unparseable or zero numeric rule leaves the request rule-less (400 NO_RULES)', async () => {
  await withScan(async (port, scanId) => {
    const notRules = [
      'maxAgeMs=abc',        // garbage
      'maxAgeMs=0',          // explicit zero: every file is at least 0ms old
      'maxAgeMs=-999',       // negative: same, plus nonsense
      'maxAgeMs=',           // present but empty — Number('') is 0
      'maxAgeMs=NaN',
      'maxAgeMs=1e999',      // parses, but to Infinity — no file is that old
      'minBytes=abc',
      'minBytes=0',          // explicit zero: every file is at least 0 bytes
      'minBytes=-1',
      'minBytes=',
      'minBytes=NaN',
      'minBytes=1e999',
      'maxAgeMs=abc&minBytes=0', // two non-rules are still no rules
      'exts=' + encodeURIComponent(' , ,,'), // all-empty ext list is not a rule either
      'dup=maybe',           // only 1/true enable the duplicate rule
    ];
    for (const q of notRules) {
      const r = await get(port, `/api/cleanup/rules?scanId=${scanId}&${q}`);
      assert.equal(r.status, 400, `${q} → expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'NO_RULES', `${q} → expected NO_RULES, got ${r.body.code}`);
    }
  });
});

/* ------------------- real rules still filter, exactly ------------------- */

test('a genuine positive rule still returns 200 and matches only what it should', async () => {
  await withScan(async (port, scanId) => {
    const age = await get(port, `/api/cleanup/rules?scanId=${scanId}&maxAgeMs=${30 * DAY}`);
    assert.equal(age.status, 200);
    assert.equal(age.body.matched, 1, 'only the 400-day-old file is older than 30 days');
    assert.deepEqual(age.body.files.map((f: { name: string }) => f.name), ['ancient.log']);

    const size = await get(port, `/api/cleanup/rules?scanId=${scanId}&minBytes=1000`);
    assert.equal(size.status, 200);
    assert.equal(size.body.matched, 1, 'only big.bin clears a 1000-byte floor');
    assert.deepEqual(size.body.files.map((f: { name: string }) => f.name), ['big.bin']);

    // A fractional byte floor is still a real rule: 0.5 must not round to "off".
    const frac = await get(port, `/api/cleanup/rules?scanId=${scanId}&minBytes=0.5`);
    assert.equal(frac.status, 200);
    assert.equal(frac.body.matched, 3, 'every file is at least half a byte');
  });
});

test('a dropped rule never widens or narrows the rules that did parse', async () => {
  await withScan(async (port, scanId) => {
    // minBytes is junk, exts is real: the answer must be exactly the exts answer,
    // not "everything" (the old bug) and not "nothing" (over-correcting to a
    // 400 when a valid rule is present).
    const r = await get(port, `/api/cleanup/rules?scanId=${scanId}&minBytes=abc&exts=log`);
    assert.equal(r.status, 200);
    assert.equal(r.body.matched, 1);
    assert.deepEqual(r.body.files.map((f: { name: string }) => f.name), ['ancient.log']);

    // The same with an explicit zero floor alongside a real age rule.
    const z = await get(port, `/api/cleanup/rules?scanId=${scanId}&minBytes=0&maxAgeMs=${30 * DAY}`);
    assert.equal(z.status, 200);
    assert.equal(z.body.matched, 1);
    assert.deepEqual(z.body.files.map((f: { name: string }) => f.name), ['ancient.log']);
  });
});

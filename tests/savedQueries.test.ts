import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-savedq-test-'));
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';

/**
 * Saved queries and the query HTTP surface (v4 §2.2, §2.3).
 *
 * The rule with teeth: **a query that does not parse is refused rather than
 * stored.** A saved query is not a bookmark — §4.5 turns it into a Clean Up
 * rule and then an Autopilot policy, and a policy whose query never parsed
 * would either match nothing forever or fail at the least convenient moment.
 * Save time is the only point at which a person is present to fix it.
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

function req(port: number, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        host: '127.0.0.1', port, path: url, method,
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

/** Scan a small fixture and return its id. */
async function scannedFixture(port: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-query-fixture-'));
  fs.writeFileSync(path.join(root, 'big.mp4'), Buffer.alloc(200_000));
  fs.writeFileSync(path.join(root, 'small.txt'), Buffer.alloc(40));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'huge.mp4'), Buffer.alloc(300_000));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'clip.mov'), Buffer.alloc(150_000));

  const started = await req(port, 'POST', '/api/scan', { path: root });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const scanId = started.body.scanId as string;
  for (let i = 0; i < 200; i++) {
    const stats = await req(port, 'GET', `/api/scan/${scanId}/stats`);
    if (stats.body.status === 'complete') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return { root, scanId, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/* ============================ validate ============================ */

test('POST /api/query/validate accepts a good query and reports its plan', async () => {
  const { port, close } = await listen();
  try {
    const r = await req(port, 'POST', '/api/query/validate', { q: 'size>100mb ext:mp4 used>1y -in:node_modules' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    // Two different engines, reported separately. `postFiltered` is what a
    // scan query needs beyond the tree; `indexPostFiltered` is what the SQLite
    // index could not answer. Merging them would let a caller attribute one
    // path's cost to the other.
    assert.deepEqual(r.body.postFiltered, ['lastUsed'], 'a scan query needs the lastUsed provider');
    assert.deepEqual(r.body.indexPostFiltered, ['in', 'used'], 'the index cannot answer either of those');
    assert.ok(r.body.fields.includes('size'));
  } finally {
    await close();
  }
});

test('a parse error comes back with an offset, a length and what was expected', async () => {
  const { port, close } = await listen();
  try {
    const r = await req(port, 'POST', '/api/query/validate', { q: 'size>1gb backupp:yes' });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.code, 'QUERY_PARSE_ERROR');
    // The offset must point at the offending token, not at the start — the UI
    // underlines exactly this span.
    assert.equal(r.body.offset, 9);
    assert.equal(r.body.length, 'backupp:yes'.length);
    assert.match(r.body.error, /Unknown field "backupp"/);
    assert.ok(Array.isArray(r.body.expected) && r.body.expected.includes('backup'));
  } finally {
    await close();
  }
});

test('validate never runs a query, so it needs no scan', async () => {
  const { port, close } = await listen();
  try {
    // No scanId anywhere. It is the cheapest endpoint in the app by design,
    // because the frontend calls it on every keystroke.
    const r = await req(port, 'POST', '/api/query/validate', { q: 'size>1gb' });
    assert.equal(r.status, 200);
    const missing = await req(port, 'POST', '/api/query/validate', {});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'QUERY_REQUIRED');
  } finally {
    await close();
  }
});

test('GET /api/query/fields serves the grammar rather than duplicating it', async () => {
  const { port, close } = await listen();
  try {
    const r = await req(port, 'GET', '/api/query/fields');
    assert.equal(r.status, 200);
    const names = r.body.fields.map((f: { name: string }) => f.name);
    for (const expected of ['size', 'ext', 'name', 'path', 'in', 'modified', 'created', 'used', 'dupe', 'elsewhere', 'git', 'backup', 'cloud', 'type', 'depth', 'empty', 'score']) {
      assert.ok(names.includes(expected), `the grammar is missing "${expected}"`);
    }
    const type = r.body.fields.find((f: { name: string }) => f.name === 'type');
    assert.deepEqual(type.values, ['file', 'dir']);
    assert.deepEqual(type.operators, [':']);
    const size = r.body.fields.find((f: { name: string }) => f.name === 'size');
    assert.deepEqual(size.operators.sort(), [':', '<', '<=', '>', '>='].sort());
    assert.ok(size.help.length > 10, 'every field carries help text for autocomplete');
  } finally {
    await close();
  }
});

/* ============================ running a query ============================ */

test('POST /api/query returns the right files from a real scan', async () => {
  const { port, close } = await listen();
  const fixture = await scannedFixture(port);
  try {
    const r = await req(port, 'POST', '/api/query', { scanId: fixture.scanId, q: 'ext:mp4' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    const names = r.body.hits.map((h: { name: string }) => h.name).sort();
    assert.deepEqual(names, ['big.mp4', 'huge.mp4']);

    // The exclusion in §2.1's own example.
    const excluded = await req(port, 'POST', '/api/query', { scanId: fixture.scanId, q: 'ext:mp4 -in:node_modules' });
    assert.deepEqual(excluded.body.hits.map((h: { name: string }) => h.name), ['big.mp4']);

    const bySize = await req(port, 'POST', '/api/query', { scanId: fixture.scanId, q: 'size>100kb type:file' });
    assert.deepEqual(
      bySize.body.hits.map((h: { name: string }) => h.name).sort(),
      ['big.mp4', 'clip.mov', 'huge.mp4'],
    );
  } finally {
    fixture.cleanup();
    await close();
  }
});

test('results are sorted and paged deterministically', async () => {
  const { port, close } = await listen();
  const fixture = await scannedFixture(port);
  try {
    const all = await req(port, 'POST', '/api/query', { scanId: fixture.scanId, q: 'type:file', sort: 'size' });
    const sizes = all.body.hits.map((h: { size: number }) => h.size);
    assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a), 'sorted biggest first');

    // Paging must not lose or repeat a row — ties are broken by path for
    // exactly this reason.
    const page1 = await req(port, 'POST', '/api/query', { scanId: fixture.scanId, q: 'type:file', limit: 2, offset: 0 });
    const page2 = await req(port, 'POST', '/api/query', { scanId: fixture.scanId, q: 'type:file', limit: 2, offset: 2 });
    const paged = [...page1.body.hits, ...page2.body.hits].map((h: { path: string }) => h.path);
    assert.deepEqual(paged, all.body.hits.slice(0, 4).map((h: { path: string }) => h.path));
    assert.equal(page1.body.total, all.body.total, 'total is the whole result, not the page');
    assert.equal(page1.body.truncated, true, 'and a partial page says so');
  } finally {
    fixture.cleanup();
    await close();
  }
});

test('a query needing an unavailable signal is DEGRADED, not silently empty', async () => {
  const { port, close } = await listen();
  const fixture = await scannedFixture(port);
  try {
    // §2.2's point: an empty list alone reads as "nothing matched", which is a
    // different and wrong claim from "this machine cannot answer that".
    //
    // `dupe:` is the right example now that §3 has made `score:` real. It is
    // unconditionally unwired rather than machine-dependent, so this asserts
    // the degradation contract without also asserting something about whoever
    // is running the tests — `backup:yes` would pass here only because this
    // Mac has no Time Machine.
    const r = await req(port, 'POST', '/api/query', { scanId: fixture.scanId, q: 'dupe:yes' });
    assert.equal(r.status, 200);
    assert.equal(r.body.hits.length, 0);
    const providers = r.body.degraded.map((d: { provider: string }) => d.provider);
    assert.ok(providers.includes('duplicates'), 'the missing signal is named');
    assert.deepEqual(r.body.postFiltered, ['duplicates'], 'and it is reported as beyond the tree');
    const reason = r.body.degraded.find((d: { provider: string }) => d.provider === 'duplicates').reason;
    assert.ok(reason.length > 20, 'and the reason is a sentence a person can act on');

    // A query needing nothing special is not degraded.
    const plain = await req(port, 'POST', '/api/query', { scanId: fixture.scanId, q: 'ext:mp4' });
    assert.deepEqual(plain.body.degraded, []);
  } finally {
    fixture.cleanup();
    await close();
  }
});

test('score: is a real filter now, not a stated dead end', async () => {
  const { port, close } = await listen();
  const fixture = await scannedFixture(port);
  try {
    // Phase 2 shipped the `score` field with an honest "not built yet" and a
    // degraded marker. Phase 3 makes it answerable, and the marker has to go
    // with it — a response that still said "reclaim scores are not built yet"
    // while returning real matches would be worse than either state alone.
    const all = await req(port, 'POST', '/api/query', { scanId: fixture.scanId, q: 'score>=0' });
    assert.equal(all.status, 200);
    assert.ok(all.body.hits.length > 0, 'every scorable file matches score>=0');

    const providers = all.body.degraded.map((d: { provider: string }) => d.provider);
    assert.ok(!providers.includes('reclaimScore'), 'the "not built yet" degradation is gone');

    // `postFiltered` still names it: a score genuinely is computed per file
    // after the tree is walked, and that cost is worth reporting.
    assert.deepEqual(all.body.postFiltered, ['reclaimScore']);

    // And the filter discriminates rather than matching everything.
    const impossible = await req(port, 'POST', '/api/query', { scanId: fixture.scanId, q: 'score>99' });
    assert.equal(impossible.status, 200);
    assert.ok(impossible.body.hits.length < all.body.hits.length,
      'a demanding threshold must narrow the set, or the field is not really being read');

    // node_modules is regenerable, so it outranks a plain video of similar
    // size — the whole reason the field exists.
    const top = await req(port, 'POST', '/api/query', { scanId: fixture.scanId, q: 'score>40 type:dir' });
    assert.equal(top.status, 200);
    const paths = top.body.hits.map((h: { path: string }) => h.path);
    assert.ok(paths.some((p: string) => p.endsWith('node_modules')),
      `a regenerable folder should clear a middling threshold; got ${JSON.stringify(paths)}`);
  } finally {
    fixture.cleanup();
    await close();
  }
});

test('the query route refuses bad input rather than guessing', async () => {
  const { port, close } = await listen();
  const fixture = await scannedFixture(port);
  try {
    const noQuery = await req(port, 'POST', '/api/query', { scanId: fixture.scanId });
    assert.equal(noQuery.status, 400);
    assert.equal(noQuery.body.code, 'QUERY_REQUIRED');

    const noScan = await req(port, 'POST', '/api/query', { q: 'size>1gb' });
    assert.equal(noScan.status, 400);
    assert.equal(noScan.body.code, 'SCAN_REQUIRED');

    const badScan = await req(port, 'POST', '/api/query', { scanId: 'nope', q: 'size>1gb' });
    assert.equal(badScan.status, 404);
    assert.equal(badScan.body.code, 'SCAN_NOT_FOUND');

    const badQuery = await req(port, 'POST', '/api/query', { scanId: fixture.scanId, q: 'zzz:1' });
    assert.equal(badQuery.status, 400);
    assert.equal(badQuery.body.code, 'QUERY_PARSE_ERROR');
  } finally {
    fixture.cleanup();
    await close();
  }
});

/* ============================ saved queries ============================ */

test('a saved view round-trips, and a bad query is refused rather than stored', async () => {
  const { port, close } = await listen();
  try {
    const empty = await req(port, 'GET', '/api/queries');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.queries, []);

    const created = await req(port, 'POST', '/api/queries', {
      name: 'Big stale videos', q: 'size>1gb ext:mp4,mov used>1y', pinned: true, colour: '#ff8800',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.query.name, 'Big stale videos');
    assert.equal(created.body.query.pinned, true);
    assert.equal(created.body.query.colour, '#ff8800');
    assert.ok(created.body.query.id);

    const listed = await req(port, 'GET', '/api/queries');
    assert.equal(listed.body.queries.length, 1);
    assert.equal(listed.body.queries[0].q, 'size>1gb ext:mp4,mov used>1y');

    // The rule with teeth. A saved query becomes a Clean Up rule and then an
    // Autopilot policy; one that never parsed would fail later, unattended.
    const rejected = await req(port, 'POST', '/api/queries', { name: 'Broken', q: 'size>banana' });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.code, 'QUERY_PARSE_ERROR');
    assert.match(rejected.body.error, /is not a size/);
    assert.equal(typeof rejected.body.offset, 'number');

    const stillOne = await req(port, 'GET', '/api/queries');
    assert.equal(stillOne.body.queries.length, 1, 'the rejected query was not stored');

    const removed = await req(port, 'DELETE', `/api/queries/${created.body.query.id}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, true);
    assert.deepEqual((await req(port, 'GET', '/api/queries')).body.queries, []);

    const gone = await req(port, 'DELETE', `/api/queries/${created.body.query.id}`);
    assert.equal(gone.status, 404);
    assert.equal(gone.body.code, 'SAVED_QUERY_NOT_FOUND');
  } finally {
    await close();
  }
});

test('a saved view needs a name and a query', async () => {
  const { port, close } = await listen();
  try {
    for (const [body, code] of [
      [{ q: 'size>1gb' }, 'NAME_REQUIRED'],
      [{ name: '   ', q: 'size>1gb' }, 'NAME_REQUIRED'],
      [{ name: 'x' }, 'QUERY_REQUIRED'],
      [{ name: 'x', q: '   ' }, 'QUERY_REQUIRED'],
      [{ name: 'y'.repeat(81), q: 'size>1gb' }, 'NAME_TOO_LONG'],
    ] as const) {
      const r = await req(port, 'POST', '/api/queries', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.code, code, JSON.stringify(body));
    }
  } finally {
    await close();
  }
});

test('a colour is accepted only in a form that is safe to put in CSS', async () => {
  const { port, close } = await listen();
  try {
    // The chip's colour reaches a style attribute. An arbitrary string there
    // is a CSS injection, so anything that is not #rrggbb becomes null and
    // the chip uses the default accent.
    for (const colour of ['red', 'rgb(1,2,3)', '#fff', 'url(x)', 'expression(1)', '#12345g', '"><script>']) {
      const r = await req(port, 'POST', '/api/queries', { name: `c-${colour}`, q: 'size>1gb', colour });
      assert.equal(r.status, 201);
      assert.equal(r.body.query.colour, null, `"${colour}" must not survive`);
    }
    const good = await req(port, 'POST', '/api/queries', { name: 'good', q: 'size>1gb', colour: '#AABBCC' });
    assert.equal(good.body.query.colour, '#AABBCC');
  } finally {
    await close();
  }
});

test('pinned views sort first, then newest', async () => {
  const { port, close } = await listen();
  try {
    for (const q of (await req(port, 'GET', '/api/queries')).body.queries) {
      await req(port, 'DELETE', `/api/queries/${q.id}`);
    }
    await req(port, 'POST', '/api/queries', { name: 'first', q: 'size>1gb' });
    await new Promise((r) => setTimeout(r, 5));
    await req(port, 'POST', '/api/queries', { name: 'second', q: 'size>2gb' });
    await new Promise((r) => setTimeout(r, 5));
    await req(port, 'POST', '/api/queries', { name: 'pinned', q: 'size>3gb', pinned: true });

    const listed = (await req(port, 'GET', '/api/queries')).body.queries as { name: string }[];
    assert.equal(listed[0].name, 'pinned', 'pinned first — this is the chip strip order');
    assert.equal(listed[1].name, 'second', 'then newest');
    assert.equal(listed[2].name, 'first');
  } finally {
    await close();
  }
});

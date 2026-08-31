import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-calendar-test-'));
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { createScanRecord } from '../src/services/diskScanner';
import { aggregateCalendar, STAT_CAP } from '../src/services/calendarAggregate';
import { STAT_CAP as QUERY_STAT_CAP } from '../src/services/query/execute';
import { FileNode } from '../src/models/types';

/**
 * The calendar endpoint's one hard problem is the word "day": buckets are
 * LOCAL days, and local days are 23 or 25 hours long twice a year. Every
 * DST test here pins TZ and then PROVES the pin took effect before trusting
 * a single bucket — Node applies a runtime TZ change on this platform, and
 * the guard is what turns that from lore into an assertion.
 */

/* ------------------------------ helpers ------------------------------ */

/**
 * Pin the process timezone for one test, restoring the previous value. The
 * server under test runs in this same process, so the pin governs its
 * bucketing too. An async body keeps the pin until it settles — restoring in
 * a plain finally would unpin before the first await resumed.
 */
function withTz<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  const restore = (): void => {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  };
  try {
    const out = fn();
    if (out instanceof Promise) return out.finally(restore) as unknown as T;
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

/** Fail loudly if the TZ pin did not reach Date — every bucket assert rests on it. */
function assertTzActive(utcMs: number, expectedLocalHour: number): void {
  assert.equal(
    new Date(utcMs).getHours(),
    expectedLocalHour,
    'the TZ pin did not take effect in this process — DST asserts below would be meaningless',
  );
}

/** A flat scan tree: /root holding these files. */
function flatTree(files: { name: string; size: number; modifiedAt: number }[]): FileNode {
  return {
    name: 'root',
    path: '/root',
    size: files.reduce((s, f) => s + f.size, 0),
    type: 'dir',
    modifiedAt: 0,
    isHidden: false,
    children: files.map((f) => ({
      name: f.name,
      path: `/root/${f.name}`,
      size: f.size,
      type: 'file' as const,
      modifiedAt: f.modifiedAt,
      isHidden: false,
    })),
  };
}

async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  resetRateLimiter();
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
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

/* --------------------- local-day bucketing, incl. DST --------------------- */

test('spring forward (US, March 2026): the 23-hour day buckets by wall clock, not UTC', () => {
  withTz('America/New_York', () => {
    // 12:00 UTC on a plain winter day is 07:00 EST — proves the pin.
    assertTzActive(Date.UTC(2026, 0, 15, 12), 7);

    const result = aggregateCalendar(flatTree([
      // 01:30 EST, Mar 8 — before the jump.
      { name: 'a', size: 1, modifiedAt: Date.UTC(2026, 2, 8, 6, 30) },
      // 07:00 UTC is the transition instant: 02:00 never exists, this is 03:00 EDT Mar 8.
      { name: 'b', size: 2, modifiedAt: Date.UTC(2026, 2, 8, 7, 0) },
      // Mar 9 in UTC, but 23:30 EDT Mar 8 locally — the case UTC bucketing gets wrong.
      { name: 'c', size: 4, modifiedAt: Date.UTC(2026, 2, 9, 3, 30) },
      // 00:30 EDT Mar 9.
      { name: 'd', size: 8, modifiedAt: Date.UTC(2026, 2, 9, 4, 30) },
    ]));

    assert.deepEqual(result.modified, [
      { date: '2026-03-08', bytes: 7, count: 3 },
      { date: '2026-03-09', bytes: 8, count: 1 },
    ]);
    assert.deepEqual(result.degraded, [], 'the modified channel reads the tree — nothing can degrade');
    assert.equal(result.created, undefined, 'created is opt-in and was not requested');
  });
});

test('fall back (US, November 2026): the repeated 1 AM hour lands on one 25-hour day', () => {
  withTz('America/New_York', () => {
    assertTzActive(Date.UTC(2026, 0, 15, 12), 7);

    const result = aggregateCalendar(flatTree([
      // 01:30 EDT Nov 1 — the first pass through the hour.
      { name: 'a', size: 1, modifiedAt: Date.UTC(2026, 10, 1, 5, 30) },
      // 01:30 EST Nov 1 — the same wall clock an hour later. Still Nov 1.
      { name: 'b', size: 2, modifiedAt: Date.UTC(2026, 10, 1, 6, 30) },
      // Nov 2 in UTC, but 23:59 EST Nov 1 locally.
      { name: 'c', size: 4, modifiedAt: Date.UTC(2026, 10, 2, 4, 59) },
      // 00:00 EST Nov 2 exactly.
      { name: 'd', size: 8, modifiedAt: Date.UTC(2026, 10, 2, 5, 0) },
    ]));

    assert.deepEqual(result.modified, [
      { date: '2026-11-01', bytes: 7, count: 3 },
      { date: '2026-11-02', bytes: 8, count: 1 },
    ]);
  });
});

test('year boundary: one UTC instant is Dec 31 west of Greenwich and Jan 1 east of it', () => {
  withTz('America/New_York', () => {
    assertTzActive(Date.UTC(2026, 0, 15, 12), 7);
    const ny = aggregateCalendar(flatTree([
      // 23:59 EST Dec 31 2025 — Jan 1 in UTC.
      { name: 'a', size: 1, modifiedAt: Date.UTC(2026, 0, 1, 4, 59) },
      // 00:00 EST Jan 1 2026.
      { name: 'b', size: 2, modifiedAt: Date.UTC(2026, 0, 1, 5, 0) },
    ]));
    assert.deepEqual(ny.modified, [
      { date: '2025-12-31', bytes: 1, count: 1 },
      { date: '2026-01-01', bytes: 2, count: 1 },
    ]);
  });

  withTz('Pacific/Auckland', () => {
    // 12:00 UTC on Jan 15 is 01:00 NZDT on Jan 16 — proves the pin, opposite side of UTC.
    assertTzActive(Date.UTC(2026, 0, 15, 12), 1);
    const nz = aggregateCalendar(flatTree([
      // 23:30 NZDT Dec 31 2025.
      { name: 'a', size: 1, modifiedAt: Date.UTC(2025, 11, 31, 10, 30) },
      // 00:30 NZDT Jan 1 2026 — still Dec 31 in UTC.
      { name: 'b', size: 2, modifiedAt: Date.UTC(2025, 11, 31, 11, 30) },
    ]));
    assert.deepEqual(nz.modified, [
      { date: '2025-12-31', bytes: 1, count: 1 },
      { date: '2026-01-01', bytes: 2, count: 1 },
    ]);
  });
});

test('days are emitted in ascending date order regardless of tree order', () => {
  withTz('America/New_York', () => {
    assertTzActive(Date.UTC(2026, 0, 15, 12), 7);
    const result = aggregateCalendar(flatTree([
      { name: 'newest', size: 1, modifiedAt: Date.UTC(2026, 5, 20, 12) },
      { name: 'oldest', size: 2, modifiedAt: Date.UTC(2024, 1, 3, 12) },
      { name: 'middle', size: 4, modifiedAt: Date.UTC(2025, 8, 9, 12) },
    ]));
    assert.deepEqual(result.modified.map((d) => d.date), ['2024-02-03', '2025-09-09', '2026-06-20']);
  });
});

/* ------------------------- the created channel ------------------------- */

test('created is a second channel: statted per file, bucketed by local day, modified untouched', () => {
  withTz('America/New_York', () => {
    assertTzActive(Date.UTC(2026, 0, 15, 12), 7);
    const births: Record<string, number> = {
      '/root/a': Date.UTC(2026, 2, 9, 3, 30), // 23:30 EDT Mar 8 — the DST case again, on birthtime.
      '/root/b': Date.UTC(2026, 2, 9, 4, 30), // 00:30 EDT Mar 9.
    };
    const result = aggregateCalendar(
      flatTree([
        { name: 'a', size: 1, modifiedAt: Date.UTC(2026, 4, 1, 12) },
        { name: 'b', size: 2, modifiedAt: Date.UTC(2026, 4, 1, 12) },
      ]),
      { includeCreated: true, birthtimeOf: (p) => births[p] },
    );

    assert.deepEqual(result.created, [
      { date: '2026-03-08', bytes: 1, count: 1 },
      { date: '2026-03-09', bytes: 2, count: 1 },
    ]);
    assert.deepEqual(result.modified, [{ date: '2026-05-01', bytes: 3, count: 2 }]);
    assert.deepEqual(result.degraded, []);
  });
});

test('birthtime 0 means unknown: the file is excluded and reported, never bucketed to 1970', () => {
  withTz('America/New_York', () => {
    assertTzActive(Date.UTC(2026, 0, 15, 12), 7);
    const result = aggregateCalendar(
      flatTree([
        { name: 'known', size: 1, modifiedAt: Date.UTC(2026, 4, 1, 12) },
        { name: 'unknown', size: 2, modifiedAt: Date.UTC(2026, 4, 1, 12) },
      ]),
      { includeCreated: true, birthtimeOf: (p) => (p.endsWith('known') && !p.endsWith('unknown') ? Date.UTC(2026, 4, 1, 12) : 0) },
    );

    assert.deepEqual(result.created, [{ date: '2026-05-01', bytes: 1, count: 1 }]);
    assert.ok(!result.created!.some((d) => d.date.startsWith('1970')), 'birthtime 0 must never become "day zero"');
    const unknown = result.degraded.find((d) => d.provider === 'createdUnknown');
    assert.ok(unknown, 'files with no recorded creation time must be reported, not silently dropped');
    assert.match(unknown!.reason, /1/, 'the prose names how many files were affected');
  });
});

test('the stat cap: files past it are skipped and reported; no day is invented as zero', () => {
  withTz('America/New_York', () => {
    assertTzActive(Date.UTC(2026, 0, 15, 12), 7);
    let statted = 0;
    const result = aggregateCalendar(
      flatTree([1, 2, 3, 4, 5].map((n) => ({ name: `f${n}`, size: n, modifiedAt: Date.UTC(2026, 4, 1, 12) }))),
      {
        includeCreated: true,
        statCap: 2,
        birthtimeOf: () => { statted++; return Date.UTC(2026, 4, 1, 12); },
      },
    );

    assert.equal(statted, 2, 'the cap must stop stat calls, not merely stop counting them');
    // Only what was actually read is reported — and days appear only with real
    // counts, so a day the cap prevented reading is absent, never zero.
    assert.equal(result.created!.reduce((s, d) => s + d.count, 0), 2);
    assert.ok(result.created!.every((d) => d.count >= 1), 'a zero-count day is an invented number');

    const capped = result.degraded.find((d) => d.provider === 'created');
    assert.ok(capped, 'hitting the cap must surface in degraded');
    assert.match(capped!.reason, /2/, 'the prose says how many were read');
    assert.match(capped!.reason, /3/, 'and how many were skipped');

    // The modified channel comes from the tree and owes the cap nothing.
    assert.deepEqual(result.modified, [{ date: '2026-05-01', bytes: 15, count: 5 }]);
  });
});

test('unreadable files are counted and reported, not treated as non-matching', () => {
  withTz('America/New_York', () => {
    assertTzActive(Date.UTC(2026, 0, 15, 12), 7);
    const result = aggregateCalendar(
      flatTree([
        { name: 'ok', size: 1, modifiedAt: Date.UTC(2026, 4, 1, 12) },
        { name: 'locked', size: 2, modifiedAt: Date.UTC(2026, 4, 1, 12) },
      ]),
      {
        includeCreated: true,
        birthtimeOf: (p) => {
          if (p.endsWith('locked')) throw new Error('EPERM');
          return Date.UTC(2026, 4, 1, 12);
        },
      },
    );

    assert.deepEqual(result.created, [{ date: '2026-05-01', bytes: 1, count: 1 }]);
    const unreadable = result.degraded.find((d) => d.provider === 'createdUnreadable');
    assert.ok(unreadable, 'a permission failure must be reported, not silently dropped');
    assert.match(unreadable!.reason, /1/);
  });
});

test('the default stat cap IS the query engine budget — one constant, not a copy', () => {
  assert.equal(STAT_CAP, QUERY_STAT_CAP, 'the two budgets must be the same exported constant');
});

test('an mtime the filesystem never recorded is unknown, not a 1969 day', () => {
  // diskScanner's own rule: a zero timestamp means "never recorded — omit
  // rather than let a 1970 date surface anywhere". The always-on modified
  // channel must hold it too, and say what it skipped.
  return withTz('America/New_York', () => {
    const result = aggregateCalendar(flatTree([
      { name: 'no-mtime.bin', size: 100, modifiedAt: 0 },
      { name: 'negative.bin', size: 50, modifiedAt: -1 },
      { name: 'real.bin', size: 200, modifiedAt: new Date(2026, 5, 10, 12).getTime() },
    ]));
    assert.deepEqual(result.modified.map((d) => d.date), ['2026-06-10'], 'no 1969/1970 bucket may exist');
    assert.equal(result.modified[0].bytes, 200);
    const note = result.degraded.find((d) => d.provider === 'modifiedUnknown');
    assert.ok(note, 'the skipped files are reported, never silently absent');
    assert.match(note!.reason, /\b2\b/, 'the count of unknown-mtime files is stated');
  });
});

/* ------------------------------ the route ------------------------------ */

test('GET /api/scan/:scanId/calendar serves both channels over a real scan', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-calendar-fixture-'));
  // mtimes pinned to the March DST edge: b's mtime is Mar 9 in UTC but Mar 8 in New York.
  const mtimeA = new Date(Date.UTC(2026, 2, 9, 3, 30));
  const mtimeB = new Date(Date.UTC(2026, 2, 9, 4, 30));
  fs.writeFileSync(path.join(fixture, 'a.txt'), 'aaaa');
  fs.writeFileSync(path.join(fixture, 'b.txt'), 'bb');
  fs.utimesSync(path.join(fixture, 'a.txt'), mtimeA, mtimeA);
  fs.utimesSync(path.join(fixture, 'b.txt'), mtimeB, mtimeB);

  const { port, close } = await listen();
  try {
    const started = await req(port, 'POST', '/api/scan?wait=true', { path: fixture });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const scanId = started.body.scanId as string;

    await withTz('America/New_York', async () => {
      assertTzActive(Date.UTC(2026, 0, 15, 12), 7);

      const plain = await req(port, 'GET', `/api/scan/${scanId}/calendar`);
      assert.equal(plain.status, 200);
      assert.equal(plain.body.scanId, scanId);
      assert.equal(plain.body.rootPath, fixture);
      assert.deepEqual(plain.body.modified, [
        { date: '2026-03-08', bytes: 4, count: 1 },
        { date: '2026-03-09', bytes: 2, count: 1 },
      ]);
      assert.equal(plain.body.created, undefined, 'created must not be statted unless asked for');
      assert.deepEqual(plain.body.degraded, []);

      const withCreated = await req(port, 'GET', `/api/scan/${scanId}/calendar?channel=created`);
      assert.equal(withCreated.status, 200);
      assert.ok(Array.isArray(withCreated.body.created), 'channel=created adds the second channel');
      // Real birthtimes are the filesystem's to report (APFS moves them with a
      // backdated mtime; other filesystems do not record them at all), so the
      // assertions are invariants, not dates: every reported day is a real
      // YYYY-MM-DD carrying at least one actually-read file, and nothing was
      // invented past what the scan holds.
      const days = withCreated.body.created as { date: string; bytes: number; count: number }[];
      for (const d of days) {
        assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(d.count >= 1, 'a zero-count day is an invented number');
        assert.ok(!d.date.startsWith('1970'), 'an unknown birthtime must never bucket to day zero');
      }
      assert.ok(days.reduce((s, d) => s + d.count, 0) <= 2, 'more created files than scanned files');
      assert.deepEqual(withCreated.body.modified, plain.body.modified, 'the modified channel is identical either way');
    });
  } finally {
    await close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('the route refuses unknown channels and unknown scans, and waits for running ones', async () => {
  const running = createScanRecord('/root');
  const done = createScanRecord('/root');
  done.status = 'complete';
  done.root = flatTree([{ name: 'a', size: 1, modifiedAt: Date.UTC(2026, 4, 1, 12) }]);

  const { port, close } = await listen();
  try {
    const bad = await req(port, 'GET', `/api/scan/${done.scanId}/calendar?channel=accessed`);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'BAD_CHANNEL');

    // channel=modified is the default made explicit, not an error.
    const explicit = await req(port, 'GET', `/api/scan/${done.scanId}/calendar?channel=modified`);
    assert.equal(explicit.status, 200);
    assert.equal(explicit.body.created, undefined);

    const missing = await req(port, 'GET', '/api/scan/nope/calendar');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'SCAN_NOT_FOUND');

    const early = await req(port, 'GET', `/api/scan/${running.scanId}/calendar`);
    assert.equal(early.status, 202);
    assert.equal(early.body.status, 'running');
  } finally {
    await close();
  }
});

test('a failed scan answers SCAN_FAILED like its sibling endpoints', async () => {
  const failed = createScanRecord('/root');
  failed.status = 'error';
  failed.error = 'boom';

  const { port, close } = await listen();
  try {
    const r = await req(port, 'GET', `/api/scan/${failed.scanId}/calendar`);
    assert.equal(r.status, 500);
    assert.equal(r.body.code, 'SCAN_FAILED');
  } finally {
    await close();
  }
});

test('the endpoint is registered in the spec, and its live 200 matches the schema', async () => {
  const scan = createScanRecord('/root');
  scan.status = 'complete';
  scan.root = flatTree([{ name: 'a', size: 1, modifiedAt: Date.UTC(2026, 4, 1, 12) }]);

  const { port, close } = await listen();
  try {
    const doc = (await req(port, 'GET', '/api/openapi.json')).body;
    const op = doc.paths['/api/scan/{scanId}/calendar']?.get;
    assert.ok(op, 'the calendar endpoint must be in the OpenAPI registry');
    assert.equal(op.tags[0], 'scan');

    const live = await req(port, 'GET', `/api/scan/${scan.scanId}/calendar?channel=created`);
    assert.equal(live.status, 200);
    const schema = op.responses['200'].content['application/json'].schema;
    const properties = schema.properties as Record<string, unknown>;
    for (const key of Object.keys(live.body)) {
      assert.ok(key in properties, `server returned "${key}" but the spec doesn't describe it`);
    }
    for (const key of schema.required as string[]) {
      assert.ok(key in live.body, `spec requires "${key}" but the server didn't return it`);
    }
  } finally {
    await close();
  }
});

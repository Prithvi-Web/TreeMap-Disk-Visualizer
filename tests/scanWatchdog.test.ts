import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The scan watchdog (plan U-2): one poll in flight, `/stats` first, a grace
 * for the complete frame, and heartbeats the page can count.
 *
 * On the Track U diagnosis's whole-disk scans the page's watchdog asked for
 * the 238.6 MB result every 3 s once the stream had been quiet for 6 s, with
 * nothing stopping a second request while one was in flight: run 3 serialized
 * the tree 4 times and abandoned the stream's own frame at 108.9 MB, run 2
 * serialized it 8 times (docs/engine/TRACK-U-DIAGNOSIS.md). Now a quiet stream
 * that is still open asks the small `/stats`; `/result` is fetched once, when
 * the stream has closed or when `/stats` has said "complete" for ten ticks
 * without the frame arriving.
 *
 * `followScanProgress` is EXECUTED out of the built page with a fake
 * `setInterval`, `EventSource` and clock, and a stub `api()` that records
 * every request. Every assertion counts ticks and requests; nothing is timed.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function slice(a: string, b: string): string {
  const i = INDEX.indexOf(a);
  assert.notEqual(i, -1, `anchor "${a}" exists`);
  const j = INDEX.indexOf(b, i + a.length);
  assert.notEqual(j, -1, `anchor "${b}" follows`);
  return INDEX.slice(i, j);
}

type Msg = Record<string, unknown>;
type Call = { url: string; signal: AbortSignal | undefined };
/**
 * What the stub answers: a value, an error to throw, HANG (a promise that
 * never settles, whatever its signal says) or ABORTABLE (one that never
 * settles until its signal is aborted, then rejects as fetch does).
 */
type Answer = unknown;
const HANG = Symbol('hang');
const ABORTABLE = Symbol('abortable');

class FakeES {
  static CLOSED = 2;
  readyState = 1; // OPEN
  onmessage: ((ev: { data: string }) => unknown) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  close(): void { this.closed = true; this.readyState = FakeES.CLOSED; }
}

type Drive = {
  tick: () => Promise<void>;
  ticks: (n: number) => Promise<void>;
  message: (m: Msg) => Promise<void>;
  closeStream: () => void;
  calls: Call[];
  urls: (part: string) => Call[];
  failed: string[];
  finished: Array<{ root: unknown; stats: unknown }>;
  statsFetched: number;
  es: () => FakeES;
  timerCleared: () => boolean;
};

/** Lets every microtask the watchdog queued run (a stub answer, the awaits behind it) before the test looks. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * `followScanProgress` for scan `s1` of `/Users/x`, against `answer(url, n)`,
 * the stub's reply to the n-th request of that url (1-based). Each `tick()`
 * moves the clock 3 s — the watchdog's period — and runs the watchdog once.
 * The stream opens at 0 and says nothing unless a test sends a message, so
 * the first tick (3 s) is inside the 6 s quiet threshold and the second is
 * the first quiet one.
 */
function drive(answer: (url: string, n: number) => Answer): Drive {
  const src = slice('function followScanProgress(', 'async function startCloudScan(');
  const els: Record<string, { innerHTML: string; textContent: string; setAttribute: () => void }> = {};
  const $ = (id: string) => (els[id] ??= { innerHTML: '', textContent: '', setAttribute: () => {} });
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const failed: string[] = [];
  const finished: Array<{ root: unknown; stats: unknown }> = [];
  let statsFetched = 0;
  let now = 0;
  let dog: (() => Promise<void>) | null = null;
  let cleared = false;
  const state: Record<string, unknown> = { scanning: true, scanId: null, es: null, abortScan: null };
  const api = (url: string, options?: { signal?: AbortSignal }): Promise<unknown> => {
    calls.push({ url, signal: options?.signal });
    const key = url.replace(/\?.*$/, '');
    counts[key] = (counts[key] ?? 0) + 1;
    const a = answer(url, counts[key]);
    if (a === HANG) return new Promise(() => {});
    if (a === ABORTABLE) {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
      });
    }
    if (a instanceof Error) return Promise.reject(a);
    return Promise.resolve(a);
  };
  const follow = new Function('$', 'state', 'api', 'EventSource', 'performance', 'setInterval', 'clearInterval', 'closeEventSource', 'failScan',
    'finishScan', 'rememberScannedRoot', 'showFastRescanStat', 'scanStatsFor', 'formatCount', 'escapeHtml', 'icon',
    `'use strict'; ${src} return followScanProgress;`)(
    $, state, api, FakeES, { now: () => now },
    (fn: () => Promise<void>, ms: number) => { assert.equal(ms, 3000, 'the watchdog ticks every three seconds'); dog = fn; return 1; },
    () => { cleared = true; },
    () => { const es = state.es as FakeES | null; if (es) es.close(); state.es = null; },
    (m: string) => { failed.push(m); state.scanning = false; },
    (root: unknown, _ms: number, stats: unknown) => { finished.push({ root, stats }); state.scanning = false; },
    () => {}, () => {},
    async () => { statsFetched++; return { from: 'scanStatsFor' }; },
    (n: number) => String(n), (s: string) => s, () => '',
  ) as (id: string, p: string, fast: boolean, t0: number) => void;
  follow('s1', '/Users/x', false, 0);
  const es = state.es as FakeES;
  const tick = async () => { now += 3000; void dog!(); await settle(); };
  return {
    tick,
    ticks: async (n: number) => { for (let i = 0; i < n; i++) await tick(); },
    message: async (m: Msg) => { await es.onmessage!({ data: JSON.stringify(m) }); await settle(); },
    closeStream: () => { es.readyState = FakeES.CLOSED; es.onerror!(); },
    calls,
    urls: (part: string) => calls.filter((c) => c.url.includes(part)),
    failed,
    finished,
    get statsFetched() { return statsFetched; },
    es: () => es,
    timerCleared: () => cleared,
  };
}

const STATS = '/api/scan/s1/stats';
const RESULT = '/api/scan/s1/result';
const statsBody = (status: string) => ({ scanId: 's1', status, scanned: 9, fileCount: 7, dirCount: 2, engine: 'native' });
const resultBody = { status: 'complete', scanId: 's1', root: { path: '/Users/x', size: 5 }, fileCount: 7, dirCount: 2 };
const httpError = (status: number, code: string, message = `answered ${status}`) => Object.assign(new Error(message), { status, code });

test('a progress message before every tick makes no request in 20 ticks', async () => {
  const d = drive(() => assert.fail('no request is made while the stream is talking'));
  for (let i = 0; i < 20; i++) {
    await d.message({ type: 'progress', scanned: 100 + i, currentPath: '/Users/x/a' });
    await d.tick();
  }
  assert.equal(d.calls.length, 0);
  // A heartbeat is the same frame again, and counts as the stream talking.
  for (let i = 0; i < 20; i++) {
    await d.message({ type: 'progress', scanned: 119, currentPath: '/Users/x/a' });
    await d.tick();
  }
  assert.equal(d.calls.length, 0, 'an unchanged frame repeated is still a message');
});

test('a /stats that never settles makes one request in 10 ticks, is aborted after 5 ticks in flight, and counts toward dead', async () => {
  const d = drive(() => HANG);
  await d.tick(); // 3 s: not yet quiet
  await d.tick();
  assert.equal(d.calls.length, 1, 'the first quiet tick asks once');
  assert.equal(d.calls[0].url, STATS, 'and asks /stats, not the result');
  await d.ticks(4);
  assert.equal(d.calls[0].signal!.aborted, false, 'four ticks in flight: still waiting');
  await d.tick();
  assert.equal(d.calls[0].signal!.aborted, true, 'the fifth tick in flight abandons it');
  await d.ticks(4);
  assert.equal(d.calls.length, 1, 'one request in ten ticks: never a second beside one in flight');
  // Each five ticks in flight is one "nobody answered"; five of them end the scan, as five dead polls always have.
  await d.ticks(15);
  assert.deepEqual(d.failed, [], 'four abandoned polls are still "transient"');
  await d.tick();
  assert.equal(d.failed.length, 1, 'the fifth ends the scan');
  assert.match(d.failed[0], /stopped answering/, 'saying the server stopped answering');
  assert.equal(d.timerCleared(), true);
});

test('an abandoned poll that settles as fetch does frees the next tick to ask again', async () => {
  const d = drive((_url, n) => (n === 1 ? ABORTABLE : statsBody('running')));
  await d.tick();
  await d.ticks(1 + 5);
  assert.equal(d.calls.length, 1, 'the one poll, abandoned on its fifth tick in flight');
  assert.equal(d.calls[0].signal!.aborted, true);
  await d.tick();
  assert.equal(d.calls.length, 2, 'the next tick asks again');
  assert.equal(d.calls[1].signal!.aborted, false);
  assert.deepEqual(d.failed, []);
});

test('/stats running for 30 ticks never fetches /result', async () => {
  const d = drive((url) => (url === STATS ? statsBody('running') : assert.fail(`unexpected ${url}`)));
  await d.tick();
  await d.ticks(30);
  assert.equal(d.urls(RESULT).length, 0, 'a running scan is never asked for its tree');
  assert.equal(d.urls(STATS).length, 30, 'one /stats a quiet tick, one at a time');
  assert.deepEqual(d.failed, []);
});

test('/stats complete fetches /result once, at tick 11, and never again', async () => {
  const d = drive((url) => (url === STATS ? statsBody('complete') : resultBody));
  await d.tick(); // not yet quiet
  const at: number[] = [];
  for (let i = 1; i <= 20; i++) {
    const before = d.urls(RESULT).length;
    await d.tick();
    if (d.urls(RESULT).length > before) at.push(i);
  }
  assert.deepEqual(at, [11], 'ten quiet ticks of "complete" are the frame\'s grace; the eleventh fetches the result');
  assert.equal(d.urls(STATS).length, 11);
  assert.equal(d.finished.length, 1, 'the scan finishes from the result');
  assert.deepEqual(d.finished[0].root, resultBody.root);
  const { scanId: _id, status: _st, ...stats } = statsBody('complete');
  assert.deepEqual(d.finished[0].stats, stats, 'with the /stats body it already had, not a second request for it');
  assert.equal(d.statsFetched, 0, 'scanStatsFor is not asked again');
  assert.equal(d.es().closed, true, 'and the stream is closed');
});

test('a /stats "running" resets the grace', async () => {
  let n = 0;
  const d = drive((url) => {
    if (url !== STATS) return resultBody;
    n++;
    return statsBody(n === 6 ? 'running' : 'complete');
  });
  await d.tick();
  await d.ticks(16);
  assert.equal(d.urls(RESULT).length, 0, 'five "complete", one "running", then ten "complete": the grace began again');
  await d.tick();
  assert.equal(d.urls(RESULT).length, 1, 'the eleventh "complete" in a row after the reset: the result');
});

test('a complete message during the grace ends the scan with no /result', async () => {
  const d = drive((url) => (url === STATS ? statsBody('complete') : assert.fail('no /result: the frame arrived')));
  await d.tick();
  await d.ticks(5);
  await d.message({ type: 'complete', root: { path: '/Users/x', size: 5 }, stats: { fileCount: 7 } });
  assert.equal(d.finished.length, 1, 'the frame finishes the scan');
  assert.deepEqual(d.finished[0].stats, { fileCount: 7 }, 'from the frame\'s own stats');
  await d.ticks(20);
  assert.equal(d.urls(RESULT).length, 0);
  assert.equal(d.urls(STATS).length, 5, 'and the watchdog stopped with it');
  assert.equal(d.timerCleared(), true);
});

test('a closed stream fetches /result at the first tick', async () => {
  const d = drive((url) => (url === RESULT ? resultBody : assert.fail(`unexpected ${url}`)));
  d.closeStream();
  await d.tick();
  assert.deepEqual(d.calls.map((c) => c.url), [RESULT], 'straight to the result, as before: nothing else can deliver it');
  assert.equal(d.finished.length, 1);
  assert.equal(d.statsFetched, 1, 'its counters from the stats request, as before');
});

test('a /result still arriving is not abandoned after five ticks: it carries the whole first frame', async () => {
  const d = drive(() => HANG);
  d.closeStream();
  await d.ticks(30);
  assert.equal(d.calls.length, 1, 'one /result in flight, never a second');
  assert.equal(d.calls[0].signal!.aborted, false, 'a 238.6 MB tree can take longer than fifteen seconds to arrive');
});

test('/stats 404 fails as expired; ten 429s count nothing toward dead', async () => {
  const gone = drive(() => httpError(404, 'SCAN_NOT_FOUND'));
  await gone.ticks(3);
  assert.deepEqual(gone.failed, ['The scan expired — please run it again.'], 'a record that is gone can never finish');
  assert.equal(gone.timerCleared(), true);

  const limited = drive(() => httpError(429, 'RATE_LIMITED'));
  await limited.tick();
  await limited.ticks(10);
  assert.deepEqual(limited.failed, [], 'a server that answers 429 is alive');
  assert.equal(limited.urls(STATS).length, 10, 'and is asked again on the next tick');
});

test('a /stats "error" fetches /result for the message, and the scan fails with it', async () => {
  const d = drive((url) => (url === STATS ? statsBody('error') : httpError(500, 'SCAN_FAILED', 'The folder could not be read.')));
  await d.ticks(3);
  assert.deepEqual(d.calls.map((c) => c.url), [STATS, RESULT]);
  assert.deepEqual(d.failed, ['The folder could not be read.']);
});

test('the watchdog constants are the plan\'s: 5 ticks in flight, 10 ticks of grace, 6 s of quiet', () => {
  const src = slice('function followScanProgress(', 'async function startCloudScan(');
  assert.match(src, /const IN_FLIGHT_TICKS = 5;/);
  assert.match(src, /const FRAME_GRACE_TICKS = 10;/);
  assert.match(src, /const QUIET_MS = 6000;/);
});

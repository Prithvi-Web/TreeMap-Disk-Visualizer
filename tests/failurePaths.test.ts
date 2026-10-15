import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Every way a request can fail, driven through the one wrapper that turns a
 * failure into something a person reads (§3.4, §3.5).
 *
 * The bar these pin, one test each:
 *
 *  - a capability answer is shown neutrally, as an answer, not as an error;
 *  - a real error names what failed, in words written for a reader — never the
 *    browser's own `Failed to fetch`, never a `TypeError` from the caller that
 *    tried to read a field off a body that never parsed;
 *  - nothing silently returns a value that reads as "empty" when the truth is
 *    "this did not answer".
 *
 * The wrapper is extracted from the shipped page and run against a stubbed
 * `fetch`, so these are the real code paths and not a description of them.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function slice(startAnchor: string, endAnchor: string): string {
  const start = INDEX.indexOf(startAnchor);
  assert.notEqual(start, -1, `anchor "${startAnchor}" exists in index.html`);
  const end = INDEX.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(end, -1, `anchor "${endAnchor}" follows it`);
  return INDEX.slice(start, end);
}

interface StubResponse {
  status: number;
  /** Raw body text. `json()` parses it, exactly as the browser's does. */
  text?: string;
  /** Reject the request outright — a dropped connection. */
  throws?: Error;
}

type ApiFn = (url: string, options?: unknown, opts?: Record<string, unknown>) => Promise<unknown>;
type ReportFn = (err: unknown, context?: string) => void;
interface Toast { msg: string; kind: string }

/**
 * `api` and `reportError` from the shipped page, wired to a scripted `fetch`
 * and a `toast` that records instead of painting. `setTimeout` fires
 * immediately so backoff and polling cost the test nothing.
 */
function harness(script: StubResponse[]): { api: ApiFn; report: ReportFn; toasts: Toast[]; urls: string[] } {
  const src = slice('async function api(url', '/**\n * The single place an error becomes') +
    slice('function reportError(err, context)', '\n}\n').concat('\n}\n');
  const urls: string[] = [];
  const toasts: Toast[] = [];
  let i = 0;
  const fetchStub = (url: string): Promise<unknown> => {
    urls.push(url);
    const step = script[Math.min(i++, script.length - 1)];
    if (step.throws) return Promise.reject(step.throws);
    const text = step.text ?? '';
    return Promise.resolve({
      status: step.status,
      ok: step.status >= 200 && step.status < 300,
      json: () => Promise.resolve(JSON.parse(text)), // throws on non-JSON, as the browser's does
      text: () => Promise.resolve(text),
    });
  };
  const setTimeoutStub = (fn: () => void): number => { queueMicrotask(fn); return 0; };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function('fetch', 'setTimeout', 'toast', `'use strict';
    ${src}
    return { api, reportError };`) as (f: unknown, s: unknown, t: unknown) => { api: ApiFn; reportError: ReportFn };
  const built = factory(fetchStub, setTimeoutStub, (msg: string, kind = 'success') => { toasts.push({ msg, kind }); });
  return { api: built.api, report: built.reportError, toasts, urls };
}

const errorOf = async (p: Promise<unknown>): Promise<{ message: string; code?: string; status?: number; capabilityUnavailable?: boolean }> => {
  try {
    await p;
    assert.fail('expected the call to fail');
  } catch (e) {
    return e as { message: string; code?: string };
  }
};

/* ────────────────────────────── the honest answers ────────────────────────────── */

test('404: the envelope’s own message reaches the user, with its code intact', async () => {
  const h = harness([{ status: 404, text: '{"error":"Scan not found — it may have expired","code":"SCAN_NOT_FOUND"}' }]);
  const err = await errorOf(h.api('/api/scan/x/result'));
  assert.equal(err.code, 'SCAN_NOT_FOUND');
  assert.equal(err.message, 'Scan not found — it may have expired');
  h.report(err, 'Couldn’t open that scan');
  assert.deepEqual(h.toasts, [{ msg: 'Couldn’t open that scan: Scan not found — it may have expired', kind: 'error' }]);
});

test('409 CAPABILITY_UNAVAILABLE is an answer, shown neutrally and without the failure framing', async () => {
  const h = harness([{ status: 409, text: '{"error":"smartctl is not installed — install smartmontools to read drive health","code":"CAPABILITY_UNAVAILABLE"}' }]);
  const err = await errorOf(h.api('/api/health/smart?scanId=x'));
  assert.equal(err.capabilityUnavailable, true, 'the marker panels branch on');
  h.report(err, 'Couldn’t read drive health');
  assert.equal(h.toasts.length, 1);
  assert.notEqual(h.toasts[0].kind, 'error', 'a capability answer is never red');
  assert.equal(h.toasts[0].msg, 'smartctl is not installed — install smartmontools to read drive health',
    'and it is stated plainly, without a "couldn’t" prefix that makes it sound like a fault');
});

test('409 that is NOT a capability answer stays a real error', async () => {
  const h = harness([{ status: 409, text: '{"error":"Scan is still running — try again when it completes","code":"SCAN_RUNNING"}' }]);
  const err = await errorOf(h.api('/api/duplicates?scanId=x'));
  assert.equal(err.capabilityUnavailable, false);
  h.report(err, 'Couldn’t list duplicates');
  assert.equal(h.toasts[0].kind, 'error');
});

test('429 is retried, and a 429 that outlasts the retries names itself rather than reading as a blank', async () => {
  const limited = { status: 429, text: '{"error":"Too many requests — slow down","code":"RATE_LIMITED"}' };
  const ok = { status: 200, text: '{"scans":[]}' };
  const h = harness([limited, limited, ok]);
  assert.deepEqual(await h.api('/api/scans'), { scans: [] });
  assert.equal(h.urls.length, 3, 'the wrapper backed off and retried rather than surfacing the 429');

  const stubborn = harness([limited]);
  const err = await errorOf(stubborn.api('/api/scans', undefined, { retries: 2 }));
  assert.equal(err.code, 'RATE_LIMITED');
  assert.equal(stubborn.urls.length, 3, 'two retries, then the honest failure');
  stubborn.report(err, 'Couldn’t refresh');
  assert.equal(stubborn.toasts[0].kind, 'error');
});

test('500: the server hides its internals, and what the user sees is still a sentence', async () => {
  const h = harness([{ status: 500, text: '{"error":"Internal server error","code":"INTERNAL"}' }]);
  const err = await errorOf(h.api('/api/large-files?scanId=x'));
  assert.equal(err.code, 'INTERNAL');
  assert.equal(err.status, 500);
  h.report(err, 'Couldn’t load the largest files');
  assert.equal(h.toasts[0].msg, 'Couldn’t load the largest files: Internal server error');
});

/* ─────────────────── the two that used to pass silently ─────────────────── */

test('a 200 whose body is not JSON fails loudly instead of returning nothing', async () => {
  // A truncated or proxied response parses to nothing. Returning null let the
  // caller read a field off it and surface a TypeError — or, where the caller
  // guarded, paint an empty card that claimed the folder had no large files.
  const h = harness([{ status: 200, text: '<html>502 Bad Gateway</html>' }]);
  const err = await errorOf(h.api('/api/large-files?scanId=x'));
  assert.equal(err.code, 'BAD_RESPONSE');
  assert.doesNotMatch(err.message, /JSON|SyntaxError|token/i, 'the reader is not shown a parser message');
  h.report(err, 'Couldn’t load the largest files');
  assert.equal(h.toasts[0].kind, 'error');
  assert.match(h.toasts[0].msg, /Couldn’t load the largest files/);
});

test('an error response whose body is not JSON still reports the status, not a parser message', async () => {
  const h = harness([{ status: 502, text: '<html>Bad Gateway</html>' }]);
  const err = await errorOf(h.api('/api/scans'));
  assert.equal(err.status, 502);
  assert.doesNotMatch(err.message, /SyntaxError|Unexpected token/i);
});

test('a dropped connection says the app cannot be reached, not "Failed to fetch"', async () => {
  // What the browser throws here is a developer's sentence in three different
  // dialects (Chrome "Failed to fetch", Safari "Load failed", Firefox
  // "NetworkError…"). None of them names TreeMap or tells the reader anything.
  for (const raw of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.']) {
    const h = harness([{ status: 0, throws: Object.assign(new TypeError(raw), {}) }]);
    const err = await errorOf(h.api('/api/scans'));
    assert.equal(err.code, 'OFFLINE');
    assert.doesNotMatch(err.message, /fetch|NetworkError|Load failed/i, `"${raw}" must not reach the user`);
    assert.match(err.message, /TreeMap/, 'the message names what is unreachable');
    h.report(err, 'Couldn’t refresh');
    assert.equal(h.toasts[0].kind, 'error');
  }
});

test('a cancelled request is not a failure and says nothing at all', async () => {
  const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
  const h = harness([{ status: 0, throws: abort }]);
  const err = await errorOf(h.api('/api/scans'));
  assert.equal((err as { name?: string }).name, 'AbortError', 'an abort passes through untouched');
  h.report(err, 'Couldn’t refresh');
  assert.deepEqual(h.toasts, [], 'a request the app itself cancelled must not toast at the user');
});

/* ───────────────────────────── long jobs ───────────────────────────── */

test('a 202 poll gives up eventually and says so, rather than spinning forever', async () => {
  const h = harness([{ status: 202, text: '{"status":"running"}' }]);
  const err = await errorOf(h.api('/api/index/j/result', undefined, { poll: true, pollMs: 1, pollTimeoutMs: -1 }));
  assert.equal(err.code, 'PENDING_TIMEOUT');
  assert.equal(err.status, 202);
});

test('a 202 to a caller that did not ask to poll is not handed back as the payload', async () => {
  // 202 { status: 'running' } is the shape every long endpoint answers with
  // while it works. Returning it as though it were the result is how a card
  // ends up reading `.suggestions` off it and painting an empty list — the
  // silent blank §3.5 forbids. A job handle (a POST that was accepted) is a
  // real payload and must still come straight back.
  const pending = harness([{ status: 202, text: '{"status":"running","scanned":1200}' }]);
  const err = await errorOf(pending.api('/api/cleanup/suggestions?scanId=x'));
  assert.equal(err.code, 'PENDING');
  assert.deepEqual((err as { pending?: unknown }).pending, { status: 'running', scanned: 1200 },
    'the progress it carried is kept, so a caller can say how far along it is');

  const accepted = harness([{ status: 202, text: '{"scanId":"abc","incremental":false}' }]);
  assert.deepEqual(await accepted.api('/api/scan', { method: 'POST' }),
    { scanId: 'abc', incremental: false }, 'an accepted job still returns its handle');
});

test('every 202 shape the server actually sends lands on the right side of that line', async () => {
  // Taken from the `res.status(202).json(...)` literals in src/api. A handle is
  // recognised by the id it carries, which is why `POST /api/index/build` —
  // `{ jobId, status: 'running' }` — is a handle despite saying "running".
  const handles = [
    '{"scanId":"s1","incremental":false}',                                  // POST /api/scan
    '{"scanId":"s1","status":"running","incremental":false,"scanned":9}',   // POST /api/scan, already running
    '{"jobId":"j1","status":"running"}',                                    // POST /api/index/build
    '{"jobId":"j1","status":"running","alreadyRunning":true}',              // …when one was already building
    '{"jobId":"j1","total":4,"encoder":"hevc"}',                            // POST /api/compression/encode
    '{"jobId":"j1","entryCount":2,"bytesTotal":10}',                        // POST /api/cart/undo, autopilot undo
  ];
  for (const text of handles) {
    const h = harness([{ status: 202, text }]);
    assert.deepEqual(await h.api('/api/x', { method: 'POST' }), JSON.parse(text), `${text} is a job handle`);
  }
  const pendings = [
    '{"status":"running"}',                                                  // budgets, settings jobs
    '{"status":"running","scanned":120,"currentPath":"/x"}',                 // scan stats
    '{"status":"running","hashed":3,"toHash":9}',                            // duplicate finders
    '{"status":"running","phase":"walk","processed":40,"currentPath":"/x"}', // index build progress
    '{"status":"running","root":"/x"}',                                      // index tree
  ];
  for (const text of pendings) {
    const h = harness([{ status: 202, text }]);
    const err = await errorOf(h.api('/api/x'));
    assert.equal(err.code, 'PENDING', `${text} is work in progress, not a result`);
  }
});

/* ─────────────────────── a scan the user stopped ─────────────────────── */

interface FakeEl { classList: { add(c: string): void; remove(c: string): void; has(c: string): boolean }; innerHTML: string; textContent: string }

/**
 * `stopScan` from the shipped page, with the DOM and its neighbours stubbed.
 * The question these ask is what STATE it leaves behind, which no amount of
 * matching its text can answer.
 */
function stopHarness(cancel: () => Promise<unknown>, settledScanId: string | null = null) {
  const src = slice('async function stopScan()', 'function skeletonRows(');
  const classes = new Set<string>();
  const el: FakeEl = {
    classList: { add: (c) => { classes.add(c); }, remove: (c) => { classes.delete(c); }, has: (c) => classes.has(c) },
    innerHTML: '', textContent: '',
  };
  const state: Record<string, unknown> = {
    scanning: true,
    scanId: 'the-scan-just-cancelled',
    settledScanId,
    abortScan: () => { state.abortScan = null; },
    view: 'duplicates',
  };
  /** What state.scanId was at the moment the views were remounted. */
  const seen: { scanIdAtSwitch?: unknown } = {};
  const cleared: { queue?: boolean } = {};
  const env = {
    state,
    $: () => el,
    icon: () => '',
    escapeHtml: (s: string) => s,
    closeEventSource: () => {},
    endScanChrome: () => { state.scanning = false; },
    restoreDashboardPanels: () => {},
    switchView: () => { seen.scanIdAtSwitch = state.scanId; },
    cancelScanById: cancel,
    // Stop means stop: folders dropped behind this one are waiting in the scan
    // queue, and starting the next of them would be the opposite of what the
    // button says. Recorded rather than ignored so the assertion below is
    // about behaviour, not about the stub existing.
    clearScanQueue: () => { cleared.queue = true; },
  };
  const names = Object.keys(env);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(...names, `'use strict'; ${src} return stopScan;`) as (...a: unknown[]) => () => Promise<void>;
  return { stop: factory(...names.map((n) => (env as Record<string, unknown>)[n])), state, el, seen, classes, cleared };
}

test('stopping a scan stops pointing at it, so no view fetches a scan that will answer 500 forever', async () => {
  // Measured against the dev server: every scanId-keyed endpoint answers a
  // cancelled scan with `500 SCAN_FAILED "Scan stopped by user"`. Leaving that
  // id in state and then remounting the views turned one deliberate Stop into
  // a wall of red toasts reporting the user's own choice back at them as a
  // failure. `openFromIndex` already clears the id for exactly this reason.
  const h = stopHarness(async () => ({ cancelled: true }));
  await h.stop();
  assert.equal(h.seen.scanIdAtSwitch, null, 'the id is gone BEFORE the views remount, not after');
  assert.equal(h.state.scanId, null);
  assert.equal(h.state.scanning, false);
  assert.equal(h.cleared.queue, true, 'and folders queued behind this scan are dropped — Stop means stop');
});

test('stopping a rescan puts the previous scan back, tree and id together', async () => {
  // The tree on screen belongs to the scan before this one, and so does the id
  // that answers questions about it. Leaving the id null would strand a real
  // tree with no scan behind it — every scanId-keyed panel would then have to
  // explain itself for a scan the user never actually lost.
  const h = stopHarness(async () => ({ cancelled: true }), 'the-scan-already-on-screen');
  await h.stop();
  assert.equal(h.seen.scanIdAtSwitch, 'the-scan-already-on-screen', 'restored BEFORE the views remount');
  assert.equal(h.state.scanId, 'the-scan-already-on-screen');
});

test('a stop still cancels the scan it was pointing at', async () => {
  const asked: string[] = [];
  const h = stopHarness(async (id?: string) => { asked.push(id as string); return {}; });
  await h.stop();
  assert.deepEqual(asked, ['the-scan-just-cancelled'], 'clearing the id must not lose the cancel');
});

test('a cancel the server refuses leaves the status honest, and a 404 does not', async () => {
  const refused = stopHarness(() => Promise.reject(Object.assign(new Error('Internal server error'), { status: 500 })));
  await refused.stop();
  assert.ok(refused.classes.has('error'), 'the walk is still running, so this is a real error');
  assert.match(refused.el.innerHTML, /Could not stop the scan/);

  const gone = stopHarness(() => Promise.reject(Object.assign(new Error('Scan not found'), { status: 404 })));
  await gone.stop();
  assert.ok(!gone.classes.has('error'), 'a record that was already gone IS stopped');
  assert.match(gone.el.innerHTML, /Scan stopped by user/);
});

/* ─────────────── a Stop pressed before the scan request (final review F1.7) ─────────────── */

/** An element of the page, as much of one as the scan chrome touches. */
function chromeEl() {
  const classes = new Set<string>();
  return {
    innerHTML: '', textContent: '', hidden: false, dataset: {} as Record<string, unknown>, style: {} as Record<string, string>,
    classList: { add: (c: string) => { classes.add(c); }, remove: (c: string) => { classes.delete(c); }, toggle: () => false, contains: (c: string) => classes.has(c) },
    setAttribute: () => {}, closest: () => null,
  };
}

/**
 * startScan from the shipped page, with what it calls on the way to a scan
 * request — the index probe and paint, the chrome, startScanRequest — and
 * stopScan beside it. Every answer of the index waits for the test, so a
 * Stop can be pressed while one is out. `indexed` says what the status says.
 */
function scanStartHarness(indexed: boolean) {
  const src = [
    slice('function cancelScanById(', 'function skeletonRows('),
    slice('function beginScanChrome(', '\n}\n') + '\n}\n',
    slice('function endScanChrome()', 'function failScan('),
    slice('async function indexStatusFor(', '/**\n * Build the index for a freshly-scanned root'),
    slice('async function startScan(', '/**\n * The quiet rescan behind'),
  ].join('\n');
  const els = new Map<string, ReturnType<typeof chromeEl>>();
  const $ = (id: string) => { if (!els.has(id)) els.set(id, chromeEl()); return els.get(id)!; };
  const state: Record<string, unknown> = { scanning: false, abortScan: null, scanGen: 0, scanId: null, settledScanId: null, root: null, scanStats: null, whatsNew: { seq: 0 }, view: 'dashboard' };
  /** What happened, in order: every request, the paint, a scan followed. */
  const log: string[] = [];
  /** The index answers out, each waiting for the test. */
  const out: Array<{ what: string; answer: () => void }> = [];
  const waitFor = (what: string) => new Promise<void>((resolve) => { out.push({ what, answer: resolve }); });
  let scans = 0;
  const api = async (url: string, opts?: { method?: string }) => {
    log.push(`${opts?.method ?? 'GET'} ${url.split('?')[0]}`);
    if (url.startsWith('/api/index/status')) {
      await waitFor('status');
      return indexed ? { path: '/x', indexed: true, root: { path: '/x', state: 'ready', live: true } } : { path: '/x', indexed: false, root: null };
    }
    if (url.startsWith('/api/index/tree')) {
      await waitFor('tree');
      return { rootPath: '/x', path: '/x', fileCount: 1, dirCount: 1, root: { name: 'x', path: '/x', size: 1, type: 'dir', children: [] } };
    }
    if (url === '/api/scan') return { scanId: `scan-${++scans}`, incremental: false };
    if (url.endsWith('/cancel')) return {};
    return assert.fail(`unexpected ${url}`);
  };
  const noop = () => {};
  const env: Record<string, unknown> = {
    state, $, api, log, performance, console,
    toast: noop, closeEventSource: noop, disableLive: noop, icon: () => '', REDUCED: true, escapeHtml: (s: string) => s,
    fxStateBeam: noop, fxOrbShow: noop, fxOrbHide: noop, fxScanHeroSync: noop, fxDonutLoadingSync: noop, tourScanStarted: noop,
    // The chrome takes the last folder's ring down while the lists load (B05);
    // like the donut's loading state beside it, a picture, not a step.
    clearDonut: noop,
    // The Full Disk Access notice beside the scan (U-11), asked for alongside the request and never
    // awaited: a notice, not a step of starting one.
    scanAccessNotice: async () => {},
    skeletonRows: () => '', setScanButtonMode: (mode: string) => { log.push(`button ${mode}`); },
    renderIndexBadge: noop, renderIndexLine: noop, indexTree: noop, switchView: noop, clearScanQueue: noop, restoreDashboardPanels: noop,
    // Where focus goes when the chrome hides the button that held it is tests/firstRun.test.ts's (review F1.11).
    withFocusKept: (change: () => void) => { change(); },
    followScanProgress: (scanId: string) => { log.push(`follow ${scanId}`); },
    quietRescanFailed: () => { log.push('quiet rescan failed'); }, failScan: (m: string) => { log.push(`failed: ${m}`); },
    INSTANT_OPEN_NODES: 25000,
  };
  const names = Object.keys(env);
  // finishScan as the page's begins: the chrome ends, then the tree is painted.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fns = new Function(...names, `'use strict';
    let indexLineGen = 0; let indexAutoMaxEntries = null;
    const finishScan = async (root) => { endScanChrome(); state.root = root; log.push('painted the index tree'); };
    ${src}
    return { startScan, stopScan };`)(...names.map((n) => env[n])) as { startScan: (p: string, o?: object) => Promise<void>; stopScan: () => Promise<void> };
  /** Let the index's next answer go, and the code waiting on it run. */
  const answer = async (what: string): Promise<void> => {
    const at = out.findIndex((x) => x.what === what);
    assert.ok(at >= 0, `the index's ${what} is being asked for (${log.join(', ')})`);
    out.splice(at, 1)[0].answer();
    await turns(20);
  };
  return { ...fns, state, log, $, answer, scansPosted: () => log.filter((l) => l === 'POST /api/scan').length };
}

/** Let `n` turns of the event loop pass: a count, never a time. */
async function turns(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Whether `p` has settled yet — read after counted turns, never awaited, so a click that never finishes cannot hang a test. */
function settledYet(p: Promise<unknown>): () => boolean {
  let settled = false;
  void p.then(() => { settled = true; }, () => { settled = true; });
  return () => settled;
}

test('a Stop pressed while the index is asked about an unindexed folder starts no scan (final review F1.7)', async () => {
  const h = scanStartHarness(false);
  const done = settledYet(h.startScan('/x'));
  await turns(20);
  assert.equal(h.state.scanning, true, 'the click is answered at once: the Stop button is up');
  await h.stopScan();
  await h.answer('status');
  assert.equal(h.scansPosted(), 0, `the scan the person stopped is never asked for (${h.log.join(', ')})`);
  assert.equal(h.state.scanning, false, 'and nothing says a scan is running');
  assert.match(h.$('scanStatus').innerHTML, /Scan stopped by user/, 'the status still says what the person did');
  assert.ok(done(), 'and the click has finished');
});

test('a Stop pressed while the index is asked about an indexed folder neither paints it nor starts a scan (final review F1.7)', async () => {
  const h = scanStartHarness(true);
  const done = settledYet(h.startScan('/x'));
  await turns(20);
  await h.stopScan();
  await h.answer('status');
  assert.deepEqual(h.log.filter((l) => l.startsWith('GET /api/index/tree') || l === 'painted the index tree'), [], 'the tree is not read');
  assert.equal(h.scansPosted(), 0, `and no scan is asked for (${h.log.join(', ')})`);
  assert.ok(done(), 'and the click has finished');
});

test('a Stop pressed while the index tree is read neither paints it nor starts a scan (final review F1.7)', async () => {
  const h = scanStartHarness(true);
  const done = settledYet(h.startScan('/x'));
  await turns(20);
  await h.answer('status');
  await h.stopScan();
  await h.answer('tree');
  assert.ok(!h.log.includes('painted the index tree'), `the tree read after the Stop is not painted (${h.log.join(', ')})`);
  assert.equal(h.scansPosted(), 0, `and no scan is asked for (${h.log.join(', ')})`);
  assert.match(h.$('scanStatus').innerHTML, /Scan stopped by user/);
  assert.ok(done(), 'and the click has finished');
});

test('a Scan pressed again after a Stop starts one scan, not two: the first click\'s probe answering late starts nothing (final review F1.7)', async () => {
  const h = scanStartHarness(false);
  const first = settledYet(h.startScan('/x'));
  await turns(20);
  await h.stopScan();
  const second = settledYet(h.startScan('/x')); // Scan again, while the first click's probe is still out
  await turns(20);
  await h.answer('status'); // the first click's
  assert.equal(h.scansPosted(), 0, `the first click starts nothing, though a scan is running again (${h.log.join(', ')})`);
  assert.ok(first(), 'and has finished');
  await h.answer('status'); // the second click's
  assert.equal(h.scansPosted(), 1, `the second click starts its scan (${h.log.join(', ')})`);
  assert.deepEqual(h.log.filter((l) => l.startsWith('follow')), ['follow scan-1'], 'and it is followed');
  assert.ok(second());
});

test('without a Stop, an indexed folder is painted from the index and then scanned quietly; an unindexed one is scanned (final review F1.7)', async () => {
  const indexed = scanStartHarness(true);
  const a = settledYet(indexed.startScan('/x'));
  await turns(20);
  await indexed.answer('status');
  await indexed.answer('tree');
  assert.deepEqual(indexed.log.filter((l) => l === 'painted the index tree' || l === 'POST /api/scan' || l.startsWith('follow')), ['painted the index tree', 'POST /api/scan', 'follow scan-1'], indexed.log.join(', '));
  assert.ok(a());
  const plain = scanStartHarness(false);
  const b = settledYet(plain.startScan('/x'));
  await turns(20);
  await plain.answer('status');
  assert.deepEqual(plain.log.filter((l) => l === 'POST /api/scan' || l.startsWith('follow')), ['POST /api/scan', 'follow scan-1'], plain.log.join(', '));
  assert.ok(b());
});

test('a tree with no scan behind it does not leave the Duplicates panes claiming to be scanning', () => {
  // Reachable two ways, and measured in the running app: opening an indexed
  // folder paints a tree before any scan has an id, and Stop leaves one when
  // the rescan is abandoned. Both mounted the view against `!state.scanId`
  // and returned, leaving the markup's own "Scanning for duplicates…" over an
  // empty card — a sentence that would never come true (§3.5).
  const html = INDEX;
  assert.match(html, /id="dupSummary">Scanning for duplicates…/, 'the stale label really does ship in the markup');

  for (const [fn, summaryId, bodyId] of [
    ['function dupNeedsScan(', 'dupSummary', 'dupBody'],
    ['function ndNeedsScan(', 'ndSummary', 'ndBody'],
  ] as const) {
    const src = slice(fn, '\n}\n') + '\n}\n';
    const painted: Record<string, { textContent: string; innerHTML: string }> = {};
    const env = {
      $: (id: string) => (painted[id] = painted[id] || { textContent: '', innerHTML: '' }),
      icon: () => '',
      updateDupToolbar: () => {},
      updateNdToolbar: () => {},
      state: { near: { selection: new Set<string>() } }, // the near pane lets go of an earlier scan's picks (review F2.5)
    };
    const names = Object.keys(env);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(...names, `'use strict'; ${src} return ${fn.slice('function '.length, -1)};`) as (...a: unknown[]) => () => void;
    factory(...names.map((n) => (env as Record<string, unknown>)[n]))();
    assert.doesNotMatch(painted[summaryId].textContent, /Scanning|Looking/i, `${summaryId} stops claiming to be working`);
    assert.match(painted[bodyId].innerHTML, /scan/i, 'the card says a scan is what is missing');
    assert.match(painted[bodyId].innerHTML, /Press Scan|run one/i, 'and how to get one');
  }

  // …and the view has to actually reach them.
  const mount = slice("id: 'duplicates', label:", 'unmount() {');
  assert.match(mount, /dupNeedsScan\(\)/);
  assert.match(mount, /ndNeedsScan\(\)/);
  assert.doesNotMatch(mount, /if \(!state\.scanId \|\| !state\.root\) return;/,
    'the silent return is what left the stale label up');
});

/* ────────────────────── long jobs that wait on a person ────────────────────── */

test('the cloud consent poll gives up out loud, leaving the way out on screen', () => {
  // It stops after five minutes, which is right — but it used to stop in
  // silence: the row simply ceased moving and the user was told nothing about
  // a handshake they had started in another tab. A poll that ends with no
  // answer is the same non-answer as a spinner that never ends (§3.5).
  const src = 'let cloudConnectPoll = 0;\n' + slice('function cloudConnectGaveUp(', '\nasync function connectCloud(');
  const cleared: number[] = [];
  const orbs: string[] = [];
  const toasts: Toast[] = [];
  const paste = { hidden: true, sel: '' };
  const env = {
    clearInterval: (h: number) => { cleared.push(h); },
    fxOrbHide: (k: string) => { orbs.push(k); },
    document: { querySelector: (s: string) => { paste.sel = s; return paste; } },
    toast: (msg: string, kind = 'success') => { toasts.push({ msg, kind }); },
  };
  const names = Object.keys(env);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(...names, `'use strict'; ${src} return cloudConnectGaveUp;`) as (...a: unknown[]) => (p: string) => void;
  factory(...names.map((n) => (env as Record<string, unknown>)[n]))('gdrive');

  assert.equal(cleared.length, 1, 'the interval really stops — no orphan');
  assert.deepEqual(orbs, ['cloud'], 'and the "connecting" orb goes with it');
  assert.equal(toasts.length, 1, 'the user is told');
  assert.match(toasts[0].msg, /five minutes/, 'what happened');
  assert.match(toasts[0].msg, /Connect|paste/i, 'and what to do about it');
  assert.notEqual(toasts[0].kind, 'success', 'a handshake that never completed is not a tick');
  assert.equal(paste.hidden, false, 'the paste-the-code row is the way out, so it stays open');
  assert.match(paste.sel, /gdrive/, 'for the provider that was being connected');
});

test('the two finders that paint a 202 themselves say so, rather than being broken by the rule', () => {
  // They poll by hand because the wrapper's own wait cannot draw a progress
  // bar. Without the opt-out the rule above turns their progress into a
  // "Duplicate search failed" card on the first tick.
  const dup = slice('async function loadDuplicates(', 'function renderDuplicates(');
  assert.match(dup, /\/api\/duplicates\?[\s\S]{0,160}?pending: 'return'/, 'the exact finder opts out');
  const near = slice('async function loadNearDupes(', 'function ndItemHtml(');
  assert.match(near, /\/api\/near-duplicates\?[\s\S]{0,160}?pending: 'return'/, 'and so does the image finder');
  // Both loops must still be stoppable, or leaving the view leaves a timer
  // rescheduling itself every 700 ms forever.
  const unmount = slice("id: 'duplicates'", "id: 'trends'");
  assert.match(unmount, /clearTimeout\(state\.dup\.pollTimer\)/);
  assert.match(unmount, /clearTimeout\(state\.near\.pollTimer\)/);
});

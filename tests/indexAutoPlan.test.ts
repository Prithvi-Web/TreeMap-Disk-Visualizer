import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-indexAutoPlan-data-');

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { INDEX_AUTO_MAX_ENTRIES, buildIndex, closeIndex, getRoot, listRoots, openIndex, rootFor } from '../src/services/indexEngine';
import { lift } from './fixtures/liftFrontend';

/**
 * No automatic index build for a folder larger than TreeMap indexes on its
 * own, none for an index that is already current, and the build visible while
 * it runs (plan U-1, owner's answers U-Q2 and U-Q3).
 *
 * After every scan the page rebuilt the scanned folder's index. For a whole
 * disk that was a second walk of 9.46M entries: 31 minutes with the server's
 * event loop blocked 32 % of the time, stalls up to 111 s, a 3.76 GB heap and
 * a 2.63 GB database (docs/engine/TRACK-U-DIAGNOSIS.md). The automatic build
 * is now bounded twice (U-D3): the page builds only when the scan's own count
 * is known and at most the server's `autoBuild.maxEntries`, and the server
 * stops an automatic build that passes the `maxEntries` it was sent — the walk
 * that builds the index does not honour the scan's "don't scan" patterns, so
 * the page's count alone is not a bound.
 *
 * The page's functions are EXECUTED out of the built page against a stub
 * `api()` that records every call; every assertion counts requests.
 */

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** A declaration out of the built page, from its anchor to its closing brace (parameters skipped). */
function braced(openAnchor: string): string {
  const start = INDEX.indexOf(openAnchor);
  assert.notEqual(start, -1, `block "${openAnchor}" exists in index.html`);
  let p = INDEX.indexOf('(', start), paren = 0;
  for (; p < INDEX.length; p++) {
    if (INDEX[p] === '(') paren++;
    else if (INDEX[p] === ')' && --paren === 0) break;
  }
  let depth = 0;
  for (let i = INDEX.indexOf('{', p); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`block "${openAnchor}" never closes`);
}

/** One top-level statement of the page, from its anchor to the end of its line. */
function line(anchor: string): string {
  const start = INDEX.indexOf(anchor);
  assert.notEqual(start, -1, `"${anchor}" exists in index.html`);
  return INDEX.slice(start, INDEX.indexOf('\n', start));
}

const formatCount = lift<(n: unknown) => string>(['UI_LOCALE', 'formatCount'], 'formatCount');
const formatDate = lift<(ms: number) => string>(['UI_LOCALE', 'DATE_FMT', 'dateMemo', 'formatDate'], 'formatDate');
const escapeHtml = new Function(`'use strict'; ${braced('function escapeHtml(')} return escapeHtml;`)() as (s: string) => string;

type El = { hidden: boolean; textContent: string; innerHTML: string; title: string; cls: Set<string>; classList: { toggle: (c: string, on?: boolean) => void; add: (c: string) => void } };
function el(): El {
  const e: El = {
    hidden: true, textContent: '', innerHTML: '', title: '', cls: new Set(),
    classList: { toggle: (c, on) => { if (on ?? !e.cls.has(c)) e.cls.add(c); else e.cls.delete(c); }, add: (c) => { e.cls.add(c); } },
  };
  return e;
}
function makeDom() {
  const els: Record<string, El> = {};
  return { $: (id: string) => (els[id] ??= el()), els };
}

type Call = { url: string; method: string; body: Record<string, unknown> | null };

type Harness = {
  build: (p: string, stats: unknown) => Promise<void>;
  calls: Call[];
  posts: () => Call[];
  els: Record<string, El>;
  state: { root: { path: string } | null };
  slept: number[];
  lines: Array<{ polls: number; hidden: boolean; text: string }>;
  badges: unknown[];
};

/**
 * `buildIndexInBackground` with the functions it calls, as they ship, over a
 * stub `api` that answers `status` to the status request and the next of
 * `results` to each poll of the build job (then the last one for ever). The
 * page's own `setTimeout` is replaced by one that records the delay and
 * resolves at once, so a ten-minute poll window runs in microseconds and is
 * counted in the page's own delays, never timed.
 */
function harness(opts: { status: unknown; results?: unknown[]; rootPath?: string }): Harness {
  const src = [
    line('let indexLineGen = '),
    line('let indexAutoMaxEntries = '),
    braced('function indexAutoPlan('),
    braced('function renderIndexLine('),
    braced('async function indexStatusFor('),
    braced('async function buildIndexInBackground('),
  ].join('\n');
  const { $, els } = makeDom();
  const calls: Call[] = [];
  const slept: number[] = [];
  const badges: unknown[] = [];
  const lines: Harness['lines'] = [];
  const state = { root: opts.rootPath === undefined ? null : { path: opts.rootPath } };
  const results = opts.results ?? [{ status: 'complete', root: {} }];
  let polls = 0;
  const api = async (url: string, options?: { method?: string; body?: string }) => {
    calls.push({ url, method: options?.method ?? 'GET', body: options?.body ? JSON.parse(options.body) as Record<string, unknown> : null });
    if (url.startsWith('/api/index/status')) {
      if (opts.status instanceof Error) throw opts.status;
      return opts.status;
    }
    if (url === '/api/index/build') return { jobId: 'job-1', status: 'running' };
    if (url === '/api/index/job-1/result') {
      const e = els.indexLine;
      lines.push({ polls, hidden: e ? e.hidden : true, text: e ? e.textContent : '' });
      const r = results[Math.min(polls, results.length - 1)];
      polls++;
      if (r instanceof Error) throw r;
      return r;
    }
    throw new Error(`unexpected request ${url}`);
  };
  const build = new Function('$', 'api', 'state', 'formatCount', 'renderIndexBadge', 'setTimeout',
    `'use strict'; ${src} return buildIndexInBackground;`)(
    $, api, state, formatCount, (info: unknown) => badges.push(info),
    (fn: () => void, ms: number) => { slept.push(ms); fn(); return 0; },
  ) as (p: string, stats: unknown) => Promise<void>;
  return { build, calls, posts: () => calls.filter((c) => c.method === 'POST'), els, state, slept, lines, badges };
}

const M = 1_000_000;
const HOME_PROJECTS = '/Users/x/Projects';
/** A `status?path=` answer; `autoBuild` 'absent' leaves the key out, as a server from before U-1 does. */
const statusFor = (p: string, root: unknown = null, autoBuild: unknown = { maxEntries: M }) =>
  ({ path: p, indexed: root !== null, root, running: [], ...(autoBuild === 'absent' ? {} : { autoBuild }) });
const scanStats = (scanned: unknown, engine = 'native') => ({ scanned, fileCount: 1, dirCount: 1, engine });

/* ══════════════════ the page's plan: build, offer or nothing ══════════════════ */

test('scanned = M makes exactly one build request, carrying maxEntries M', async () => {
  const h = harness({ status: statusFor(HOME_PROJECTS), rootPath: HOME_PROJECTS });
  await h.build(HOME_PROJECTS, scanStats(M));
  assert.equal(h.posts().length, 1, 'a folder of exactly the limit is indexed');
  assert.equal(h.posts()[0].url, '/api/index/build');
  assert.deepEqual(h.posts()[0].body, { path: HOME_PROJECTS, maxEntries: M }, 'and the request carries the limit, so the server can stop it');
  assert.equal(h.calls[0].url, '/api/index/status?path=' + encodeURIComponent(HOME_PROJECTS), 'the status is asked first');
});

test('scanned = M+1 makes none, and #indexLine shows the offer sentence with both numbers', async () => {
  const h = harness({ status: statusFor('/'), rootPath: '/' });
  await h.build('/', scanStats(M + 1));
  assert.equal(h.posts().length, 0, 'one item over the limit is not indexed automatically');
  assert.equal(h.els.indexLine.hidden, false, 'the line says why');
  assert.equal(
    h.els.indexLine.textContent,
    'Not indexed automatically — 1,000,001 items is more than TreeMap indexes on its own (up to 1,000,000).',
  );
});

test('a null, absent or NaN count, or a missing autoBuild, makes none', async () => {
  for (const [label, stats, status] of [
    ['a null count', scanStats(null), statusFor(HOME_PROJECTS)],
    ['an absent count', { fileCount: 1, dirCount: 1, engine: 'native' }, statusFor(HOME_PROJECTS)],
    ['a NaN count', scanStats(Number.NaN), statusFor(HOME_PROJECTS)],
    ['no stats at all', null, statusFor(HOME_PROJECTS)],
    ['a server that sends no autoBuild', scanStats(10), statusFor(HOME_PROJECTS, null, 'absent')],
    ['an autoBuild with no number', scanStats(10), statusFor(HOME_PROJECTS, null, {})],
  ] as const) {
    const h = harness({ status, rootPath: HOME_PROJECTS });
    await h.build(HOME_PROJECTS, stats);
    assert.equal(h.posts().length, 0, `${label}: an unknown count is never read as small`);
    assert.equal(h.els.indexLine?.hidden ?? true, true, `${label}: and no offer states a number nobody measured`);
  }
});

test("engine 'index' or a cloud root makes none", async () => {
  const fromIndex = harness({ status: statusFor(HOME_PROJECTS), rootPath: HOME_PROJECTS });
  await fromIndex.build(HOME_PROJECTS, scanStats(10, 'index'));
  assert.equal(fromIndex.posts().length, 0, 'a tree read from the index is not indexed again');
  const cloud = harness({ status: statusFor('cloud://gdrive'), rootPath: 'cloud://gdrive' });
  await cloud.build('cloud://gdrive', scanStats(10, 'cloud'));
  assert.equal(cloud.calls.length, 0, 'a cloud account has no filesystem to watch: nothing is asked at all');
  const cloudEngine = harness({ status: statusFor(HOME_PROJECTS), rootPath: HOME_PROJECTS });
  await cloudEngine.build(HOME_PROJECTS, scanStats(10, 'cloud'));
  assert.equal(cloudEngine.posts().length, 0, 'nor is a tree the cloud engine produced');
});

test('an exact root over the threshold is not rebuilt across two consecutive completions', async () => {
  // A 5.1.0 whole-disk index, saved before the limit existed. Rebuilding it
  // would delete it first and then stop at the limit: the owner would lose it.
  const oversized = { path: '/', state: 'stale', live: false, builtAt: 1, fileCount: 9_000_000, dirCount: 400_000 };
  for (const scanned of [M, M + 1]) {
    const h = harness({ status: statusFor('/', oversized), rootPath: '/' });
    await h.build('/', scanStats(scanned));
    await h.build('/', scanStats(scanned));
    assert.equal(h.posts().length, 0, `scanned ${scanned}: never rebuilt, completion after completion`);
  }
});

test("a legacy '/' root over the threshold does not stop a 50,000-item ~/Projects from being indexed", async () => {
  const legacy = { path: '/', state: 'stale', live: false, builtAt: 1, fileCount: 9_000_000, dirCount: 400_000 };
  const h = harness({ status: statusFor(HOME_PROJECTS, legacy), rootPath: HOME_PROJECTS });
  await h.build(HOME_PROJECTS, scanStats(50_000));
  assert.equal(h.posts().length, 1, 'the root that contains a folder is not that folder\'s index');
});

test('an exact root that is current is not rebuilt; the same root stale is rebuilt once', async () => {
  const root = (state: string, live: boolean) => ({ path: HOME_PROJECTS, state, live, builtAt: 1, fileCount: 40_000, dirCount: 10_000 });
  const current = harness({ status: statusFor(HOME_PROJECTS, root('ready', true)), rootPath: HOME_PROJECTS });
  await current.build(HOME_PROJECTS, scanStats(50_000));
  assert.equal(current.posts().length, 0, 'a ready index with its watcher attached is already current');
  for (const [state, live] of [['stale', false], ['stale', true], ['ready', false]] as const) {
    const h = harness({ status: statusFor(HOME_PROJECTS, root(state, live)), rootPath: HOME_PROJECTS });
    await h.build(HOME_PROJECTS, scanStats(50_000));
    assert.equal(h.posts().length, 1, `${state}${live ? ', watched' : ', unwatched'}: rebuilt once`);
  }
});

test('the threshold comes from the server', async () => {
  const h = harness({ status: statusFor(HOME_PROJECTS, null, { maxEntries: 10 }), rootPath: HOME_PROJECTS });
  await h.build(HOME_PROJECTS, scanStats(11));
  assert.equal(h.posts().length, 0, 'eleven items is over a limit of ten');
  assert.match(h.els.indexLine.textContent, /11 items is more than TreeMap indexes on its own \(up to 10\)/);
  const at = harness({ status: statusFor(HOME_PROJECTS, null, { maxEntries: 10 }), rootPath: HOME_PROJECTS });
  await at.build(HOME_PROJECTS, scanStats(10));
  assert.deepEqual(at.posts().map((c) => c.body), [{ path: HOME_PROJECTS, maxEntries: 10 }], 'and the request carries the server\'s own number');
});

test('the index line shows while a build runs, says "still indexing" after the poll window, and is cleared when the build settles', async () => {
  // 1,300 polls that answer "running", then the job settles.
  const running = Array.from({ length: 1300 }, (_, i) => ({ status: 'running', phase: 'enumerating', processed: i * 1000 }));
  const h = harness({ status: statusFor(HOME_PROJECTS), results: [...running, { status: 'complete', root: {} }], rootPath: HOME_PROJECTS });
  await h.build(HOME_PROJECTS, scanStats(50_000));
  assert.equal(h.lines[0].hidden, false, 'the line is up before the first poll answers');
  assert.equal(h.lines[0].text, 'Indexing this folder for instant opening — 0 items so far');
  assert.equal(h.lines[2].text, 'Indexing this folder for instant opening — 1,000 items so far', 'and counts what the build has written');
  const firstStill = h.lines.findIndex((l) => l.text.startsWith('Still indexing in the background'));
  assert.notEqual(firstStill, -1, 'a build that outlives the poll window is still said to be running, instead of vanishing');
  // The window is the page's ten minutes of polling, counted in the delays the page itself asked for.
  const sleptBefore = h.slept.slice(0, firstStill - 1).reduce((a, b) => a + b, 0);
  assert.equal(sleptBefore, 600_000, 'the line changes once the page has waited ten minutes, not before and not after');
  assert.ok(h.lines.slice(0, firstStill).every((l) => !l.text.startsWith('Still')), 'nothing said "still" before the window');
  assert.equal(h.lines.length, 1301, 'the page kept following the build past the window');
  assert.equal(h.els.indexLine.hidden, true, 'the line is cleared when the build settles');
  assert.equal(h.els.indexLine.textContent, '');
  assert.equal(h.badges.length, 1, 'and the badge is painted from the settled index');
});

test('a build that fails clears the line: indexing is an optimisation, never a requirement', async () => {
  const h = harness({ status: statusFor(HOME_PROJECTS), results: [Object.assign(new Error('Stopped at 10 items'), { status: 500 })], rootPath: HOME_PROJECTS });
  await h.build(HOME_PROJECTS, scanStats(50_000));
  assert.equal(h.posts().length, 1);
  assert.equal(h.els.indexLine.hidden, true);
  assert.equal(h.badges.length, 0);
});

test('a line for a folder no longer on screen is not painted', async () => {
  const h = harness({ status: statusFor('/'), rootPath: '/Users/x/Elsewhere' });
  await h.build('/', scanStats(M + 1));
  assert.equal(h.els.indexLine?.hidden ?? true, true, 'the offer describes the tree on screen only');
});

/* ══════════════════ the badge, the allocation panel and search ══════════════════ */

function badge(info: unknown): El {
  const { $, els } = makeDom();
  const run = new Function('$', 'escapeHtml', 'formatDate', `'use strict'; ${braced('function renderIndexBadge(')} return renderIndexBadge;`)(
    $, escapeHtml, formatDate) as (info: unknown) => void;
  run(info);
  return els.indexBadge;
}

test('an exact root over the threshold reads "saved <date>; not refreshed automatically", not "Scan again to refresh it"', () => {
  const builtAt = Date.UTC(2026, 8, 28, 12);
  const oversized = { path: '/', state: 'stale', live: false, builtAt, fileCount: 9_000_000, dirCount: 400_000 };
  const b = badge({ path: '/', indexed: true, root: oversized, running: [], autoBuild: { maxEntries: M } });
  assert.match(b.innerHTML, /Saved Sep 28, 2026; not refreshed automatically\./, 'what it is and why it will stay as it is');
  assert.doesNotMatch(b.innerHTML, /Scan again to refresh it/, 'a scan will not refresh it, so the badge does not say one will');
  assert.equal(b.cls.has('stale'), true, 'still amber');
  // The same oversized root serving a folder inside it: scanning that folder does build its own index.
  const inside = badge({ path: HOME_PROJECTS, indexed: true, root: oversized, running: [], autoBuild: { maxEntries: M } });
  assert.match(inside.innerHTML, /Scan again to refresh it\./);
  const under = badge({ path: HOME_PROJECTS, indexed: true, root: { ...oversized, path: HOME_PROJECTS, fileCount: 900, dirCount: 100 }, running: [], autoBuild: { maxEntries: M } });
  assert.match(under.innerHTML, /Scan again to refresh it\./, 'a stale root under the threshold keeps its sentence');
});

function allocationPanel(status: unknown) {
  const { $, els } = makeDom();
  const asked: string[] = [];
  const api = async (url: string) => {
    asked.push(url);
    if (url.startsWith('/api/allocation')) throw Object.assign(new Error('That folder has not been indexed yet'), { status: 404, code: 'INDEX_NOT_BUILT' });
    if (url.startsWith('/api/index/status')) return status;
    throw new Error(`unexpected ${url}`);
  };
  const src = [line('let indexAutoMaxEntries = '), braced('async function indexStatusFor('), braced('async function renderAllocationDiagnostic(')].join('\n');
  const run = new Function('$', 'state', 'api', 'escapeHtml', 'formatBytes', 'formatCount',
    `'use strict'; ${src} return renderAllocationDiagnostic;`)(
    $, { root: { path: HOME_PROJECTS } }, api, escapeHtml, (n: number) => `${n} B`, formatCount) as () => Promise<void>;
  return { run, els, asked };
}

test('the allocation diagnostic says "still building" only while status lists a running job', async () => {
  const building = allocationPanel({ path: HOME_PROJECTS, indexed: false, root: null, running: [{ jobId: 'j', phase: 'enumerating', processed: 10 }], autoBuild: { maxEntries: M } });
  await building.run();
  assert.match(building.els.allocationDiag.innerHTML, /still building its index of this folder/, 'a build is running: it is still building');
  const none = allocationPanel({ path: HOME_PROJECTS, indexed: false, root: null, running: [], autoBuild: { maxEntries: M } });
  await none.run();
  assert.doesNotMatch(none.els.allocationDiag.innerHTML, /still building/, 'nothing is running: nothing is "still" building');
  assert.match(none.els.allocationDiag.innerHTML, /has not indexed this folder/, 'the panel says there is no index');
  assert.match(none.els.allocationDiag.innerHTML, /up to 1,000,000 items/, 'and names the limit the server set');
  assert.ok(none.asked.some((u) => u.startsWith('/api/index/status?path=')), 'the answer comes from the index status, not a guess');
});

test('the empty-roots search note names the limit TreeMap indexes on its own', () => {
  const noteOf = (limit: number | null): string => {
    const { $, els } = makeDom();
    const panel = $('gsearchResults') as El & { querySelectorAll?: () => never[] };
    panel.querySelectorAll = () => [];
    const run = new Function('$', 'gsearch', 'escapeHtml', 'gsearchOpen', 'formatCount', 'indexAutoMaxEntries',
      `'use strict'; ${braced('function renderGsearch(')} return renderGsearch;`)(
      $, { hits: [], selected: -1 }, escapeHtml, () => {}, formatCount, limit) as (r: unknown) => void;
    run({ query: 'x', hits: [], roots: [] });
    return els.gsearchResults.innerHTML;
  };
  assert.match(noteOf(M), /Nothing is indexed yet\./);
  assert.match(noteOf(M), /up to 1,000,000 items/, 'the limit, as the server gave it');
  assert.doesNotMatch(noteOf(null), /\d/, 'before the server has said, no number is invented');
});

/* ══════════════════ the server: the limit, the cap and the request ══════════════════ */

after(() => closeIndex());

async function listen(): Promise<{ base: string; close: () => Promise<void> }> {
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function call(base: string, method: string, url: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  resetRateLimiter();
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** A folder of `files` empty files: `files + 1` entries with the folder itself. */
function fixture(files: number): string {
  const dir = fileTempDir('treemap-indexAutoPlan-tree-');
  for (let i = 0; i < files; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(3, '0')}.txt`), '');
  return fs.realpathSync(dir);
}

/** Polls a job's result until it is not 202; the bound is a hang guard, never a measurement. */
async function settle(base: string, jobId: string): Promise<{ status: number; json: Record<string, unknown> }> {
  for (let i = 0; i < 2000; i++) {
    const r = await call(base, 'GET', `/api/index/${jobId}/result`);
    if (r.status !== 202) return r;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return assert.fail(`index job ${jobId} never settled`);
}

test('the limit is the owner\'s answer: 1,000,000 items (U-Q3)', () => {
  assert.equal(INDEX_AUTO_MAX_ENTRIES, 1_000_000);
});

test('status?path= carries autoBuild.maxEntries equal to the exported constant, and every key it had before, with the same value', async () => {
  const dir = fixture(3);
  await buildIndex(dir, { live: false });
  const { base, close } = await listen();
  try {
    const r = await call(base, 'GET', '/api/index/status?path=' + encodeURIComponent(dir));
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json), ['path', 'indexed', 'root', 'running', 'autoBuild'], 'the four keys it had, in order, and one more at the end');
    assert.equal(r.json.path, dir);
    assert.equal(r.json.indexed, true);
    assert.deepEqual(r.json.root, JSON.parse(JSON.stringify(rootFor(dir))), 'the root that serves the path, unchanged');
    assert.deepEqual(r.json.running, []);
    assert.deepEqual(r.json.autoBuild, { maxEntries: INDEX_AUTO_MAX_ENTRIES });

    const all = await call(base, 'GET', '/api/index/status');
    assert.deepEqual(Object.keys(all.json), ['roots', 'dbPath', 'dbBytes', 'autoBuild'], 'without a path too');
    assert.deepEqual(all.json.roots, JSON.parse(JSON.stringify(listRoots())));
    assert.deepEqual(all.json.autoBuild, { maxEntries: INDEX_AUTO_MAX_ENTRIES });
  } finally {
    await close();
  }
});

test('a build past its maxEntries stops, is cancelled with the sentence, and leaves no rows and no building root', async () => {
  const dir = fixture(130); // 131 entries with the folder itself
  const handle = openIndex();
  const rowsBefore = (handle.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number }).c;
  const { base, close } = await listen();
  try {
    const started = await call(base, 'POST', '/api/index/build', { path: dir, maxEntries: 50 });
    assert.equal(started.status, 202);
    const jobId = String(started.json.jobId);
    const settled = await settle(base, jobId);
    assert.equal(settled.status, 500, 'the job did not complete');
    assert.equal(settled.json.error, 'Stopped at 50 items: more than TreeMap indexes on its own.', 'and says why, in the sentence');
    const cancel = await call(base, 'POST', `/api/index/${jobId}/cancel`);
    assert.equal(cancel.json.status, 'cancelled', 'it ended cancelled, not failed');
    assert.equal(getRoot(dir), null, 'the root is discarded');
    assert.equal((handle.prepare("SELECT COUNT(*) c FROM roots WHERE state = 'building'").get() as { c: number }).c, 0, 'no root is left building');
    assert.equal((handle.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number }).c, rowsBefore, 'and none of its rows are left');
  } finally {
    await close();
  }
});

test('a build of exactly maxEntries items completes; one more is stopped', async () => {
  const dir = fixture(9); // 10 entries with the folder itself
  const exact = await buildIndex(dir, { live: false, maxEntries: 10 });
  assert.equal(exact.state, 'ready', 'ten entries under a limit of ten is built');
  assert.equal(exact.fileCount + exact.dirCount, 10);
  await assert.rejects(buildIndex(dir, { live: false, maxEntries: 9 }), { message: 'Stopped at 9 items: more than TreeMap indexes on its own.' });
  assert.equal(getRoot(dir), null, 'and the stopped build leaves nothing');
});

test("maxEntries of 0, -1 or 'x' is refused with 400", async () => {
  const dir = fixture(1);
  const { base, close } = await listen();
  try {
    for (const maxEntries of [0, -1, 'x', 1.5, null, true, '10']) {
      const r = await call(base, 'POST', '/api/index/build', { path: dir, maxEntries });
      assert.equal(r.status, 400, `maxEntries ${JSON.stringify(maxEntries)} is refused`);
      assert.equal(r.json.code, 'MAX_ENTRIES_INVALID');
    }
    const status = await call(base, 'GET', '/api/index/status?path=' + encodeURIComponent(dir));
    assert.deepEqual(status.json.running, [], 'and no build was started for any of them');
    assert.equal(getRoot(dir), null);
  } finally {
    await close();
  }
});

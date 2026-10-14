import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-indexAutoPlan-data-');

import { createApp } from '../src/server';
import { INDEX_AUTO_MAX_ENTRIES, buildIndex, closeIndex, getRoot, listRoots, openIndex, reclaimsSettled, rootFor } from '../src/services/indexEngine';
import { apiCall as call, settleIndexJob as settle } from './fixtures/indexJobs';
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

type El = {
  hidden: boolean; textContent: string; innerHTML: string; title: string; dataset: Record<string, string>; cls: Set<string>;
  classList: { toggle: (c: string, on?: boolean) => void; add: (c: string) => void };
};
function el(): El {
  const e: El = {
    hidden: true, textContent: '', innerHTML: '', title: '', dataset: {}, cls: new Set(),
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
  /** The page's openFromIndex, as a folder is opened from the saved index. */
  open: (p: string) => Promise<boolean>;
  calls: Call[];
  posts: () => Call[];
  polls: () => number;
  els: Record<string, El>;
  state: { root: { path: string } | null };
  slept: number[];
  lines: Array<{ polls: number; hidden: boolean; text: string }>;
  badges: unknown[];
  /** Every sentence written to the screen reader's region (#indexAnnounce), in order. */
  announced: string[];
};

/**
 * `buildIndexInBackground` with the functions it calls, as they ship, over a
 * stub `api` that answers `status` to the status request and the next of
 * `results` to each poll of the build job (then the last one for ever); a
 * result that is a function is called, so a test can hold a poll open. The
 * page's own `setTimeout` is replaced by one that records the delay and
 * resolves at once, so a ten-minute poll window runs in microseconds and is
 * counted in the page's own delays, never timed. `openFromIndex` shares the
 * same scope, as it does in the page.
 */
function harness(opts: { status: unknown; results?: unknown[]; rootPath?: string }): Harness {
  const src = [
    line('let indexLineGen = '),
    line('let indexAutoMaxEntries = '),
    braced('function indexAutoPlan('),
    braced('function renderIndexLine('),
    braced('async function indexStatusFor('),
    braced('async function openFromIndex('),
    braced('async function buildIndexInBackground('),
  ].join('\n');
  const { $, els } = makeDom();
  const announced: string[] = [];
  const say = el();
  Object.defineProperty(say, 'textContent', { get: () => announced.at(-1) ?? '', set: (v: string) => { announced.push(v); } });
  els.indexAnnounce = say;
  const calls: Call[] = [];
  const slept: number[] = [];
  const badges: unknown[] = [];
  const lines: Harness['lines'] = [];
  const state = { root: opts.rootPath === undefined ? null : { path: opts.rootPath } } as { root: { path: string } | null; scanId?: unknown; scanStats?: unknown };
  const results = opts.results ?? [{ status: 'complete', root: {} }];
  let polls = 0;
  const api = async (url: string, options?: { method?: string; body?: string }) => {
    calls.push({ url, method: options?.method ?? 'GET', body: options?.body ? JSON.parse(options.body) as Record<string, unknown> : null });
    if (url.startsWith('/api/index/status')) {
      if (opts.status instanceof Error) throw opts.status;
      return opts.status;
    }
    if (url.startsWith('/api/index/tree?path=')) {
      const p = decodeURIComponent(url.slice('/api/index/tree?path='.length).split('&')[0]);
      return { rootPath: p, path: p, root: { path: p, size: 1 }, fileCount: 1, dirCount: 0 };
    }
    if (url === '/api/index/build') return { jobId: 'job-1', status: 'running' };
    if (url === '/api/index/job-1/result') {
      const e = els.indexLine;
      lines.push({ polls, hidden: e ? e.hidden : true, text: e ? e.textContent : '' });
      const r = results[Math.min(polls, results.length - 1)];
      polls++;
      if (r instanceof Error) throw r;
      return typeof r === 'function' ? (r as () => Promise<unknown>)() : r;
    }
    throw new Error(`unexpected request ${url}`);
  };
  const page = new Function('$', 'api', 'state', 'formatCount', 'renderIndexBadge', 'setTimeout',
    'indexTree', 'finishScan', 'performance', 'INSTANT_OPEN_NODES',
    `'use strict'; ${src} return { buildIndexInBackground, openFromIndex };`)(
    $, api, state, formatCount, (info: unknown) => badges.push(info),
    (fn: () => void, ms: number) => { slept.push(ms); fn(); return 0; },
    () => {}, async () => {}, { now: () => 0 }, 250_000,
  ) as { buildIndexInBackground: (p: string, stats: unknown) => Promise<void>; openFromIndex: (p: string, info: unknown) => Promise<boolean> };
  return {
    build: page.buildIndexInBackground,
    open: (p: string) => page.openFromIndex(p, statusFor(p)),
    calls,
    posts: () => calls.filter((c) => c.method === 'POST'),
    polls: () => polls,
    els, state, slept, lines, badges, announced,
  };
}

/** Lets every microtask the page queued run before the test looks. */
const drain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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
  // Finding 14: past the window, every ten seconds — never a tight loop over a build that runs for an hour.
  const after = h.slept.slice(firstStill - 1);
  assert.equal(after.length, 100, 'one delay after each of the hundred polls past the window');
  assert.ok(after.every((ms) => ms === 10_000), `each of them ten seconds: ${[...new Set(after)].join(', ')}`);
  assert.equal(h.els.indexLine.hidden, true, 'the line is cleared when the build settles');
  assert.equal(h.els.indexLine.textContent, '');
  assert.equal(h.badges.length, 1, 'and the badge is painted from the settled index');
});

test('a build that fails clears the line: indexing is an optimisation, never a requirement', async () => {
  const h = harness({ status: statusFor(HOME_PROJECTS), results: [Object.assign(new Error('The folder could not be read.'), { status: 500, code: 'INDEX_BUILD_FAILED' })], rootPath: HOME_PROJECTS });
  await h.build(HOME_PROJECTS, scanStats(50_000));
  assert.equal(h.posts().length, 1);
  assert.equal(h.els.indexLine.hidden, true);
  // Finding 5: the badge above the line describes this folder, from a status asked after the failure.
  assert.equal(h.badges.length, 1, 'the badge is painted again for the folder on screen');
  assert.equal(h.calls.filter((c) => c.url.startsWith('/api/index/status')).length, 2, 'from a status asked once the build had ended');
});

/* ══════════════════ a build that stopped at the cap (Track U review of U-1) ══════════════════ */

const STOP = 'Stopped at 1,000,000 items: more than TreeMap indexes on its own.';
const stopped = (maxEntries = M) => ({ maxEntries, at: Date.UTC(2026, 8, 30), reason: `Stopped at ${maxEntries.toLocaleString('en-US')} items: more than TreeMap indexes on its own.` });

test('a build that stops at its cap says so on the line, in the server\'s sentence, and the badge is painted again', async () => {
  const capError = Object.assign(new Error(STOP), { status: 409, code: 'INDEX_CAP_REACHED', maxEntries: M });
  const h = harness({ status: statusFor(HOME_PROJECTS), results: [{ status: 'running', phase: 'enumerating', processed: 5000 }, capError], rootPath: HOME_PROJECTS });
  await h.build(HOME_PROJECTS, scanStats(900_000));
  assert.equal(h.els.indexLine.hidden, false, 'the line stays, instead of vanishing with no word');
  assert.equal(h.els.indexLine.textContent, `Not indexed automatically. ${STOP}`);
  assert.equal(h.badges.length, 1, 'and the badge describes the folder as it now is');
});

test('a folder whose last capped build stopped at the cap is offered, not built again after the next scan', async () => {
  const saved = { path: HOME_PROJECTS, state: 'stale', live: false, builtAt: 1, fileCount: 800_000, dirCount: 100_000 };
  for (const [label, root] of [['no saved index', null], ['a stale saved index under the limit', saved]] as const) {
    const h = harness({ status: { ...statusFor(HOME_PROJECTS, root), stoppedAtCap: stopped() }, rootPath: HOME_PROJECTS });
    await h.build(HOME_PROJECTS, scanStats(900_000));
    assert.equal(h.posts().length, 0, `${label}: the same doomed build is not started again`);
    assert.equal(h.els.indexLine.textContent, `Not indexed automatically. ${STOP}`, `${label}: the line says why`);
    assert.equal(h.badges.length, 1, `${label}: and the badge is painted for this folder`);
  }
  // A stop at a smaller cap says nothing about a larger one: the server's limit was raised since.
  const raised = harness({ status: { ...statusFor(HOME_PROJECTS), stoppedAtCap: stopped(10) }, rootPath: HOME_PROJECTS });
  await raised.build(HOME_PROJECTS, scanStats(900_000));
  assert.equal(raised.posts().length, 1, 'a stop at ten items does not stop a build capped at a million');
});

test('the badge is painted for the folder on screen however the plan ends: offer, none, or no status at all', async () => {
  const offer = harness({ status: statusFor('/'), rootPath: '/' });
  await offer.build('/', scanStats(M + 1));
  assert.deepEqual(offer.badges, [statusFor('/')], 'an offer paints this folder\'s badge — no index here, so none — instead of the last folder\'s');
  const current = { path: HOME_PROJECTS, state: 'ready', live: true, builtAt: 1, fileCount: 1, dirCount: 1 };
  const none = harness({ status: statusFor(HOME_PROJECTS, current), rootPath: HOME_PROJECTS });
  await none.build(HOME_PROJECTS, scanStats(2));
  assert.deepEqual(none.badges, [statusFor(HOME_PROJECTS, current)], 'nothing to build: the badge still describes this folder');
  const unknown = harness({ status: new Error('no index service'), rootPath: HOME_PROJECTS });
  await unknown.build(HOME_PROJECTS, scanStats(2));
  assert.deepEqual(unknown.badges, [null], 'no status: no badge, rather than another folder\'s');
  const elsewhere = harness({ status: statusFor('/'), rootPath: '/Users/x/Elsewhere' });
  await elsewhere.build('/', scanStats(M + 1));
  assert.deepEqual(elsewhere.badges, [], 'a folder no longer on screen paints nothing');
});

/* ══════════════════ the line belongs to the folder on screen (findings 4, 8, 14) ══════════════════ */

test('a build superseded by a newer one stops polling, and paints neither the line nor the badge (finding 14)', async () => {
  for (const ending of ['still running', 'complete'] as const) {
    let releaseOlder!: (v: unknown) => void;
    let releaseNewer!: (v: unknown) => void;
    const older = new Promise((resolve) => { releaseOlder = resolve; });
    const newer = new Promise((resolve) => { releaseNewer = resolve; });
    // Poll 0 is the older build's; polls 1 and 2 are the newer one's.
    const h = harness({
      status: statusFor(HOME_PROJECTS),
      results: [() => older, { status: 'running', phase: 'enumerating', processed: 7000 }, () => newer, { status: 'complete', root: {} }],
      rootPath: HOME_PROJECTS,
    });
    const first = h.build(HOME_PROJECTS, scanStats(50_000));
    await drain();
    const second = h.build(HOME_PROJECTS, scanStats(50_000));
    await drain();
    assert.equal(h.polls(), 3, `${ending}: each build has asked about the job`);
    assert.equal(h.els.indexLine.textContent, 'Indexing this folder for instant opening — 7,000 items so far');
    releaseOlder(ending === 'complete' ? { status: 'complete', root: {} } : { status: 'running', phase: 'enumerating', processed: 999 });
    await first;
    assert.equal(h.polls(), 3, `${ending}: the older build asks nothing more once a newer one owns the line`);
    assert.equal(h.els.indexLine.textContent, 'Indexing this folder for instant opening — 7,000 items so far', `${ending}: and neither paints nor clears it`);
    assert.equal(h.badges.length, 0, `${ending}: nor paints the badge`);
    releaseNewer({ status: 'complete', root: {} });
    await second;
    assert.equal(h.els.indexLine.hidden, true, 'the newer build clears its own line');
    assert.equal(h.badges.length, 1, 'and paints the badge once');
  }
});

test('opening another folder from the saved index clears the line the last folder left (finding 4)', async () => {
  let release!: (v: unknown) => void;
  const held = new Promise((resolve) => { release = resolve; });
  const h = harness({
    status: statusFor(HOME_PROJECTS),
    results: [{ status: 'running', phase: 'enumerating', processed: 2000 }, () => held, { status: 'running', phase: 'enumerating', processed: 3000 }, { status: 'complete', root: {} }],
    rootPath: HOME_PROJECTS,
  });
  const building = h.build(HOME_PROJECTS, scanStats(50_000));
  await drain();
  assert.equal(h.els.indexLine.textContent, 'Indexing this folder for instant opening — 2,000 items so far');
  // openFromIndex puts the other folder's tree on screen and runs finishScan
  // with no scan id, which returns before it reaches the index build.
  assert.equal(await h.open('/Users/x/Elsewhere'), true, 'the other folder opens from its index');
  assert.equal(h.els.indexLine.hidden, true, 'the line about the last folder goes with its tree');
  assert.equal(h.els.indexLine.textContent, '');
  release({ status: 'running', phase: 'enumerating', processed: 2500 });
  await building;
  assert.equal(h.polls(), 2, 'the last folder\'s build is no longer followed from this screen');
  assert.equal(h.els.indexLine.hidden, true, 'and does not bring its line back');
});

test('the line is not a live region: a screen reader hears each change of state once, never each count (finding 8)', async () => {
  const markup = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'markup', '010-view-dashboard.html'), 'utf8');
  const tag = (id: string): string => {
    const m = new RegExp(`<div[^>]*id="${id}"[^>]*>`).exec(markup);
    assert.ok(m, `#${id} is in the dashboard markup`);
    return m[0];
  };
  assert.doesNotMatch(tag('indexLine'), /role=|aria-live/, '#indexLine is rewritten on every poll, so it announces nothing itself');
  assert.match(tag('indexAnnounce'), /class="sr-only"/, 'the announcements have a region of their own, visually hidden');
  assert.match(tag('indexAnnounce'), /role="status"/);
  assert.match(tag('indexAnnounce'), /aria-live="polite"/);
  assert.match(tag('indexAnnounce'), /aria-atomic="true"/);

  const running = Array.from({ length: 1300 }, (_, i) => ({ status: 'running', phase: 'enumerating', processed: i * 1000 }));
  const h = harness({ status: statusFor(HOME_PROJECTS), results: [...running, { status: 'complete', root: {} }], rootPath: HOME_PROJECTS });
  await h.build(HOME_PROJECTS, scanStats(50_000));
  assert.equal(h.lines.length, 1301, 'the line itself changed on every one of 1,301 polls');
  assert.deepEqual(h.announced, ['Indexing this folder for instant opening', 'Still indexing in the background'],
    'and was spoken twice: when the build began, and when it went on in the background');
  // Two short builds in a row: the first ends while its line still says
  // "Indexing", and the second, after the line cleared, is said again.
  const twice = harness({ status: statusFor(HOME_PROJECTS), results: [{ status: 'complete', root: {} }], rootPath: HOME_PROJECTS });
  await twice.build(HOME_PROJECTS, scanStats(50_000));
  await twice.build(HOME_PROJECTS, scanStats(50_000));
  assert.deepEqual(twice.announced, ['Indexing this folder for instant opening', 'Indexing this folder for instant opening'],
    'a later build, after the line cleared, is said again');

  const offer = harness({ status: statusFor('/'), rootPath: '/' });
  await offer.build('/', scanStats(M + 1));
  assert.deepEqual(offer.announced, ['Not indexed automatically — 1,000,001 items is more than TreeMap indexes on its own (up to 1,000,000).'], 'an offer is said once');
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

test('a saved index under the threshold whose folder stopped at the cap reads "not refreshed automatically" too', () => {
  const builtAt = Date.UTC(2026, 8, 28, 12);
  const saved = { path: HOME_PROJECTS, state: 'stale', live: false, builtAt, fileCount: 800_000, dirCount: 100_000 };
  const b = badge({ path: HOME_PROJECTS, indexed: true, root: saved, running: [], autoBuild: { maxEntries: M }, stoppedAtCap: { maxEntries: M, at: 1, reason: 'x' } });
  assert.match(b.innerHTML, /Saved Sep 28, 2026; not refreshed automatically\./, 'its next scan offers instead of rebuilding, so no scan will refresh it');
  assert.doesNotMatch(b.innerHTML, /Scan again to refresh it/);
  const raised = badge({ path: HOME_PROJECTS, indexed: true, root: saved, running: [], autoBuild: { maxEntries: M }, stoppedAtCap: { maxEntries: 10, at: 1, reason: 'x' } });
  assert.match(raised.innerHTML, /Scan again to refresh it\./, 'a stop under a smaller cap than today\'s does not hold it back');
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

test('the stale-results note in search promises a rescan only where one refreshes the index (finding 7)', () => {
  const noteOf = (limit: number | null): string => {
    const { $, els } = makeDom();
    const panel = $('gsearchResults') as El & { querySelectorAll?: () => never[] };
    panel.querySelectorAll = () => [];
    const run = new Function('$', 'gsearch', 'escapeHtml', 'gsearchOpen', 'formatCount', 'indexAutoMaxEntries', 'chipFor', 'formatBytes',
      `'use strict'; ${braced('function renderGsearch(')} return renderGsearch;`)(
      $, { hits: [], selected: -1 }, escapeHtml, () => {}, formatCount, limit, () => '', (n: number) => `${n} B`) as (r: unknown) => void;
    const hit = { name: 'a.zip', path: '/x/a.zip', parentPath: '/x', size: 1, type: 'file', rootPath: '/' };
    run({ query: 'zip', hits: [hit], total: 1, countCapped: false, truncated: false, roots: ['/'], staleRoots: ['/'] });
    const notes = [...els.gsearchResults.innerHTML.matchAll(/<div class="gsearch-note">([^<]*)<\/div>/g)].map((m) => m[1]);
    assert.equal(notes.length, 1, 'one note under the hits: the stale one');
    return notes[0];
  };
  // A stale whole-disk index is never rebuilt by a scan (U-1), so "scan again
  // to refresh it" would be a promise its folder does not keep.
  assert.doesNotMatch(noteOf(M), /scan again to refresh it/i);
  assert.match(noteOf(M), /Some results come from an index that may be out of date\. Scanning a folder again refreshes its index, unless it holds more than TreeMap indexes on its own \(up to 1,000,000 items\)\./);
  assert.match(noteOf(null), /unless it holds more than TreeMap indexes on its own\./, 'before the server has said, no number is invented');
  assert.doesNotMatch(noteOf(null), /\d/);
});

test('the search panel lists a path once, and says results may be out of date only when a hit it shows came from a stale index (fifth browser pass F08)', () => {
  // QA fifth pass F08: with corpus, corpus/Mail and corpus/Deep indexed, "Mailbox 03" showed two
  // identical rows; and "Some results come from an index that may be out of date" showed for "holiday",
  // whose only hit came from the live corpus index — it showed whenever any searched index was stale.
  const panelFor = (result: Record<string, unknown>) => {
    const { $, els } = makeDom();
    const panel = $('gsearchResults') as El & { querySelectorAll?: () => never[] };
    panel.querySelectorAll = () => [];
    const gsearch = { hits: [] as unknown[], selected: -1 };
    const run = new Function('$', 'gsearch', 'escapeHtml', 'gsearchOpen', 'formatCount', 'indexAutoMaxEntries', 'chipFor', 'formatBytes',
      `'use strict'; ${braced('function renderGsearch(')} return renderGsearch;`)(
      $, gsearch, escapeHtml, () => {}, formatCount, M, () => '', (n: number) => `${n} B`) as (r: unknown) => void;
    run({ query: 'q', countCapped: false, truncated: false, roots: ['/c', '/c/Mail'], ...result });
    const html = els.gsearchResults.innerHTML;
    return {
      rows: [...html.matchAll(/data-path="([^"]*)"><span class="nm">[^<]*<\/span><span class="sz">([^<]*)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`),
      stale: /may be out of date/.test(html),
      hits: (gsearch.hits as Array<{ path: string }>).map((h) => h.path),
    };
  };
  const box = (rootPath: string, size: number) => ({ name: 'Mailbox 03.mbox', path: '/c/Mail/Mailbox 03.mbox', parentPath: '/c/Mail', size, type: 'dir', rootPath });
  const holiday = { name: 'holiday.mov', path: '/c/holiday.mov', parentPath: '/c', size: 9, type: 'file', rootPath: '/c' };
  // The server answers each path once; the panel holds to it too, keeping the live index's row.
  const twice = panelFor({ hits: [box('/c/Mail', 1700), box('/c', 1600)], total: 2, staleRoots: ['/c/Mail'] });
  assert.deepEqual(twice.rows, ['/c/Mail/Mailbox 03.mbox 1600 B'], 'one row for the path — the live index\'s, though the stale one\'s came first');
  assert.deepEqual(twice.hits, ['/c/Mail/Mailbox 03.mbox'], 'and one hit behind the keyboard\'s rows');
  assert.equal(twice.stale, false, 'the hit shown is from the live index: nothing shown is out of date');
  // Review F1.4 of F08: whichever comes first — the live index's hit is kept over a stale one's after it,
  // the first of two live hits stands, and the kept hit holds the place the path first came.
  const liveFirst = panelFor({ hits: [box('/c', 1600), box('/c/Mail', 1700)], total: 2, staleRoots: ['/c/Mail'] });
  assert.deepEqual([liveFirst.rows, liveFirst.stale], [['/c/Mail/Mailbox 03.mbox 1600 B'], false],
    'the live index\'s row when it came first, and nothing shown is out of date');
  const bothLive = panelFor({ hits: [box('/c', 1600), box('/c/Mail', 1700)], total: 2, staleRoots: [] });
  assert.deepEqual(bothLive.rows, ['/c/Mail/Mailbox 03.mbox 1600 B'], 'two live hits for one path: the first stands');
  const placed = panelFor({ hits: [box('/c/Mail', 1700), holiday, box('/c', 1600)], total: 3, staleRoots: ['/c/Mail'] });
  assert.deepEqual(placed.hits, ['/c/Mail/Mailbox 03.mbox', '/c/holiday.mov'], 'the live row takes the place the path first came — the server\'s size order');
  assert.deepEqual(placed.rows, ['/c/Mail/Mailbox 03.mbox 1600 B', '/c/holiday.mov 9 B'], 'and is drawn there, its folder first');
  const live = panelFor({ hits: [holiday], total: 1, staleRoots: ['/c/Mail'] });
  assert.deepEqual([live.rows.length, live.stale], [1, false], '"holiday", from the live index while another is stale: no note');
  const stale = panelFor({ hits: [box('/c/Mail', 1700), holiday], total: 2, staleRoots: ['/c/Mail'] });
  assert.equal(stale.stale, true, 'a hit shown from the stale index: the note');
  const none = panelFor({ hits: [holiday], total: 1, staleRoots: [] });
  assert.equal(none.stale, false, 'control: no stale index, no note');
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

/** A folder of `files` empty files: `files + 1` entries with the folder itself. */
function fixture(files: number): string {
  const dir = fileTempDir('treemap-indexAutoPlan-tree-');
  for (let i = 0; i < files; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(3, '0')}.txt`), '');
  return fs.realpathSync(dir);
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
    assert.deepEqual(Object.keys(r.json), ['path', 'indexed', 'root', 'running', 'autoBuild', 'stoppedAtCap'], 'the four keys it had, in order, then autoBuild and stoppedAtCap at the end');
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
    assert.equal(settled.status, 409, 'the job did not complete, and did not fail either');
    assert.equal(settled.json.code, 'INDEX_CAP_REACHED');
    assert.equal(settled.json.error, 'Stopped at 50 items: more than TreeMap indexes on its own.', 'and says why, in the sentence');
    const cancel = await call(base, 'POST', `/api/index/${jobId}/cancel`);
    assert.equal(cancel.json.status, 'cancelled', 'it ended cancelled, not failed');
    assert.equal(getRoot(dir), null, 'the root is discarded');
    await reclaimsSettled(); // its rows are reclaimed in slices behind the job (Track U review M1)
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
  assert.deepEqual(getRoot(dir), exact, 'and the stopped build leaves the saved index exactly as it was');
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

test('a finished scan plans its index build on its own counts, even when another scan finished while its lists loaded (Track U review L4)', async () => {
  // finishScan sets state.scanStats, then waits for the three dashboard
  // lists; another scan finishing in that wait sets state.scanStats again.
  // The build planned after the wait must be this scan's, on this scan's
  // counts: a small folder planned on a whole disk's would be offered
  // instead of built, and a whole disk planned on a small folder's built.
  const src = braced('async function finishScan(');
  const element = (): Record<string, unknown> => ({ classList: { remove: () => {}, add: () => {} }, dataset: {}, innerHTML: '', textContent: '' });
  const elements = new Map<string, Record<string, unknown>>();
  const $ = (id: string): Record<string, unknown> => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id) as Record<string, unknown>;
  };
  const noop = (): void => {};
  const state: Record<string, unknown> = {
    scanId: null, treemap: { rootPath: '' }, grid: { path: '', selection: new Set() }, apps: { loadedFor: 'x' },
    view: 'dashboard', live: { wanted: false }, scanStats: null, root: null,
  };
  const answerLists: (() => void)[] = [];
  const planned: [string, unknown][] = [];
  const deps: Record<string, unknown> = {
    $, state, endScanChrome: noop, indexTree: noop, updateSelectionBar: noop, DUP_PAGE: 100, icon: () => '',
    formatCount: (n: number) => String(n), formatBytes: (n: number) => `${n} B`, escapeHtml: (s: string) => s,
    countUp: noop, FxNum: { rollText: noop }, renderDiskNotes: noop, loadWhatsNew: noop, loadDriveHealth: noop,
    loadCostEstimate: noop, showListsPending: noop, emit: noop, TOPIC: { scan: 'scan' }, switchView: noop, toast: noop,
    fxScanDonePulse: noop, loadDashboardLists: () => new Promise<void>((resolve) => { answerLists.push(resolve); }),
    buildIndexInBackground: (p: string, stats: unknown) => { planned.push([p, stats]); },
    renderGrowthProjection: noop, loadBudgets: noop, refreshTimebar: noop, enableLive: noop, setTimeout: noop, formatClock: () => '10:31 PM',
  };
  const finishScan = new Function(...Object.keys(deps), `'use strict'; ${src} return finishScan;`)(...Object.values(deps)) as
    (root: unknown, ms: number, stats: unknown) => Promise<void>;

  const small = scanStats(40_000);
  const whole = scanStats(5_000_000);
  state.scanId = 'scan-small';
  const first = finishScan({ path: HOME_PROJECTS, size: 10 }, 50, small);
  await drain();
  state.scanId = 'scan-whole';
  const second = finishScan({ path: '/', size: 20 }, 50, whole);
  await drain();
  assert.equal(answerLists.length, 2, 'both scans wait on their lists');
  answerLists[1](); // the later scan's lists answer first
  await second;
  answerLists[0]();
  await first;
  assert.deepEqual(planned, [['/', whole], [HOME_PROJECTS, small]], 'each build is planned on its own scan\'s counts');
});

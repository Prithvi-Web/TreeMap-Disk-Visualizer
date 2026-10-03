import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-indexReaders-data-');

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { buildIndex, closeIndex, getRoot, openIndex, searchIndex, type SearchHit } from '../src/services/indexEngine';
import { platform } from '../src/platform';
import { lift } from './fixtures/liftFrontend';

/**
 * Index readers never serve a root that is still building, and A2 never
 * states allocation it did not measure (plan U-7, U-D5; the owner's answer to
 * U-Q5, 2 Oct 2026: say "not measured", the Windows change included).
 *
 * During the 31-minute whole-disk build (docs/engine/TRACK-U-DIAGNOSIS.md),
 * search answered from the rows written so far — folders still at size 0,
 * because the sizes are summed at the end — and `/api/allocation` summed the
 * same partial rows into a complete-looking account. On Windows, where a
 * file's blocks mean nothing, the panel has always shown logical size as the
 * space actually used. Every assertion here counts hits, rows or keys.
 */

after(() => closeIndex());

const MiB = 1024 * 1024;

/** What allocation answers where it was not measured: the plan's sentence (U-7), shown as it is. */
const ALLOCATION_NOT_MEASURED_SENTENCE =
  'This index was built from data that does not include the blocks files occupy on disk, so TreeMap cannot say what these files occupy.';

/** A new folder under the temp folder, by its real path (macOS's /var is a link to /private/var). */
function folder(prefix: string): string {
  return fs.realpathSync(fileTempDir(`treemap-indexReaders-${prefix}-`));
}

/** Sets a root's state the way a build in flight, or one that failed, leaves it. */
function setState(dir: string, state: string, error: string | null = null): void {
  openIndex().prepare('UPDATE roots SET state = ?, error = ? WHERE path = ?').run(state, error, dir);
}

/* ══════════════════ search reads only ready and stale roots ══════════════════ */

test('search returns nothing from a building or failed root, and the same hits as before from a ready one', async () => {
  const kept = folder('kept');
  fs.writeFileSync(path.join(kept, 'needle-one.bin'), Buffer.alloc(3000, 1));
  fs.writeFileSync(path.join(kept, 'needle-two.txt'), Buffer.alloc(2000, 1));
  fs.writeFileSync(path.join(kept, 'other.bin'), Buffer.alloc(1000, 1));
  const building = folder('building');
  // The larger files, so a leak would lead every page.
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(building, `needle-${String(i)}.bin`), Buffer.alloc(9000 + i, 1));
  await buildIndex(kept, { live: false });
  await buildIndex(building, { live: false });

  const before = searchIndex('needle', { limit: 50 });
  const keptHits = before.hits.filter((h) => h.rootPath === kept);
  assert.equal(keptHits.length, 2, 'the ready root holds two needles');
  assert.equal(before.hits.filter((h) => h.rootPath === building).length, 5, 'and the other root five, while it is ready');
  const keptBins = searchIndex('*.bin', { limit: 50 }).hits.filter((h) => h.rootPath === kept);

  try {
    for (const state of ['building', 'error']) {
      setState(building, state, state === 'error' ? 'The index for that folder could not be built' : null);
      const during = searchIndex('needle', { limit: 50 });
      assert.deepEqual(during.hits, keptHits, `a ${state} root gives no hit, and the ready root's hits are exactly as before`);
      assert.equal(during.total, 2, `the count is the ready root's alone (${state})`);
      // A full page makes the search count its matches in a query of its own.
      const paged = searchIndex('needle', { limit: 1 });
      assert.deepEqual(paged.hits.map((h: SearchHit) => h.rootPath), [kept], `the first page holds the ready root's largest needle (${state})`);
      assert.equal(paged.total, 2, `and the count of a full page leaves the ${state} root's rows out too`);
      assert.deepEqual(searchIndex('*.bin', { limit: 50 }).hits, keptBins, `an extension search leaves the ${state} root out (${state})`);
    }
  } finally {
    setState(building, 'ready');
  }
  assert.equal(searchIndex('needle', { limit: 50 }).total, 7, 'ready again, it is searched again');
});

test('a build in flight is never searched: the rows it has written are not hits', async () => {
  // An explicit build writes under the folder's own path, in state
  // 'building', from the first rows it writes. Six needles beside the
  // folder `sub`, and six hundred inside it: whatever size its write
  // transactions, the build has written rows by its 560th look at whether
  // to stop.
  const dir = folder('flight');
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir, `needle-top-${String(i)}.txt`), 'x');
  fs.mkdirSync(path.join(dir, 'sub'));
  for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(dir, 'sub', `needle-${String(i).padStart(3, '0')}.txt`), 'x');

  let polls = 0;
  type Look = { state: string | undefined; rows: number; hits: number; others: number; total: number; roots: string[] };
  let looked: Look | null = null;
  const built = await buildIndex(dir, {
    live: false,
    isCancelled: () => {
      if (++polls !== 560) return false;
      const root = getRoot(dir);
      const rows = root ? (openIndex().prepare('SELECT COUNT(*) c FROM nodes WHERE root_id = ?').get(root.id) as { c: number }).c : 0;
      const found = searchIndex('needle', { limit: 500 });
      const hits = found.hits.filter((h) => h.rootPath === dir).length;
      looked = { state: root?.state, rows, hits, others: found.hits.length - hits, total: found.total, roots: found.roots };
      return false;
    },
  });
  assert.ok(looked, 'the build was looked at while it ran');
  const seen = looked as Look;
  assert.equal(seen.state, 'building', 'mid-walk, the folder\'s root is building');
  assert.ok(seen.rows > 0, `and has rows written under it (${String(seen.rows)})`);
  assert.equal(seen.hits, 0, 'none of which search returns');
  assert.equal(seen.total, seen.others, 'nor counts: the total is the other roots\' hits alone');
  assert.ok(!seen.roots.includes(dir), 'nor names as a root it searched');
  assert.equal(built.state, 'ready');
  assert.equal(searchIndex('needle', { limit: 500, scope: dir }).total, 606, 'once ready, every one of its 606 needles is found');
});

/* ══════════════════ the allocation routes ══════════════════ */

async function listen(): Promise<{ base: string; close: () => Promise<void> }> {
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function get(base: string, url: string): Promise<{ status: number; json: Record<string, unknown> }> {
  resetRateLimiter();
  const res = await fetch(base + url);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const allocationOf = (base: string, dir: string) => get(base, '/api/allocation?path=' + encodeURIComponent(dir));
const fileAllocationOf = (base: string, file: string) => get(base, '/api/allocation/file?path=' + encodeURIComponent(file));

/** A folder with a hard-linked pair (4 MiB) and an ordinary file (1 MiB): every A2 figure has something to say. */
function allocationFixture(): { dir: string; a: string; b: string; c: string } {
  const dir = folder('alloc');
  const a = path.join(dir, 'a.bin');
  const b = path.join(dir, 'b.bin');
  const c = path.join(dir, 'c.bin');
  fs.writeFileSync(a, Buffer.alloc(4 * MiB, 7));
  fs.linkSync(a, b);
  fs.writeFileSync(c, Buffer.alloc(MiB, 3));
  return { dir, a, b, c };
}

/**
 * Makes the platform say its blocks mean nothing, as Windows' does, for the
 * length of `fn` — the provider's own property, shadowed and then removed.
 */
async function withBlocksMeaningless<T>(fn: () => Promise<T>): Promise<T> {
  const provider = platform() as unknown as Record<string, unknown>;
  Object.defineProperty(provider, 'blocksAreMeaningful', { configurable: true, get: () => false });
  try {
    assert.equal(platform().blocksAreMeaningful, false, 'the seam took');
    return await fn();
  } finally {
    delete provider.blocksAreMeaningful;
  }
}

const NOT_MEASURED = { error: ALLOCATION_NOT_MEASURED_SENTENCE, code: 'ALLOCATION_NOT_MEASURED' };

test('the allocation routes answer 202 for a building root and a failure for a failed one, never a figure', async () => {
  const { dir, c } = allocationFixture();
  await buildIndex(dir, { live: false });
  const { base, close } = await listen();
  try {
    setState(dir, 'building');
    const folderWhileBuilding = await allocationOf(base, dir);
    assert.equal(folderWhileBuilding.status, 202, 'the folder: still building');
    assert.deepEqual(folderWhileBuilding.json, { status: 'building' }, 'and nothing else — no partial sum');
    const fileWhileBuilding = await fileAllocationOf(base, c);
    assert.equal(fileWhileBuilding.status, 202, 'a file in it: still building');
    assert.deepEqual(fileWhileBuilding.json, { status: 'building' });

    setState(dir, 'error', 'The walk could not finish.');
    for (const answer of [await allocationOf(base, dir), await fileAllocationOf(base, c)]) {
      assert.equal(answer.status, 500, 'a build that failed is a failure, as the tree route answers it');
      assert.deepEqual(answer.json, { error: 'The walk could not finish.', code: 'INDEX_BUILD_FAILED' }, 'with its reason, and no figure');
    }

    setState(dir, 'stale');
    const stale = await allocationOf(base, dir);
    assert.equal(stale.status, platform().blocksAreMeaningful ? 200 : 409, 'a stale root is read, as search reads it');
  } finally {
    await close();
  }
});

test('where blocks mean nothing, allocation answers 409 ALLOCATION_NOT_MEASURED with the sentence and no number', async () => {
  const { dir, a, c } = allocationFixture();
  await buildIndex(dir, { live: false });
  const { base, close } = await listen();
  try {
    await withBlocksMeaningless(async () => {
      for (const [what, answer] of [
        ['the folder', await allocationOf(base, dir)],
        ['a hard-linked file', await fileAllocationOf(base, a)],
        ['an ordinary file', await fileAllocationOf(base, c)],
      ] as const) {
        assert.equal(answer.status, 409, `${what}: not measured`);
        assert.deepEqual(answer.json, NOT_MEASURED, `${what}: the sentence alone — logical size never stands in for what is occupied`);
      }
    });
  } finally {
    await close();
  }
});

test('an index built from a scan answers 409 ALLOCATION_NOT_MEASURED on every platform', async () => {
  // Plan U-36 marks such a root `mechanism = 'scan'`: its rows carry no
  // allocated blocks, inodes or link counts.
  const { dir, c } = allocationFixture();
  await buildIndex(dir, { live: false });
  openIndex().prepare("UPDATE roots SET mechanism = 'scan' WHERE path = ?").run(dir);
  const { base, close } = await listen();
  try {
    for (const answer of [await allocationOf(base, dir), await fileAllocationOf(base, c)]) {
      assert.equal(answer.status, 409);
      assert.deepEqual(answer.json, NOT_MEASURED);
    }
  } finally {
    await close();
  }
});

test('where blocks are measured, the allocation figures are unchanged: each one from the files\' own blocks', async () => {
  const { dir, a, b, c } = allocationFixture();
  await buildIndex(dir, { live: false });
  const { base, close } = await listen();
  try {
    const folderAnswer = await allocationOf(base, dir);
    const fileAnswer = await fileAllocationOf(base, a);
    const ordinary = await fileAllocationOf(base, c);
    if (!platform().blocksAreMeaningful) {
      // Windows: the same requests are the not-measured answer.
      for (const answer of [folderAnswer, fileAnswer, ordinary]) {
        assert.equal(answer.status, 409);
        assert.deepEqual(answer.json, NOT_MEASURED);
      }
      return;
    }
    const pair = fs.lstatSync(a).blocks * 512;
    assert.equal(fs.lstatSync(b).blocks * 512, pair, 'one inode, one allocation');
    const solo = fs.lstatSync(c).blocks * 512;
    assert.equal(folderAnswer.status, 200);
    assert.deepEqual(folderAnswer.json, {
      rootPath: dir,
      naiveLogicalBytes: 5 * MiB + pair,
      logicalBytes: 5 * MiB,
      allocatedBytes: pair + solo,
      sharedBytes: pair,
      exclusiveBytes: solo,
      hardlinkFamilies: 1,
      hardlinkedNames: 1,
      savedByDeduplication: pair,
      volume: null,
      reconciliation: null,
      approximate: true,
      reason:
        'Files that share storage with each other (copies that take no extra space until changed) cannot be identified on ' +
        'this system, so each is counted in full. Everything else — including files with several names, and files that ' +
        'claim more space than they use — is measured exactly.',
    });
    assert.equal(fileAnswer.status, 200);
    const { underAllocated: _which, ...linked } = fileAnswer.json; // which name keeps the size follows readdir's order
    assert.deepEqual(linked, {
      path: a, logicalBytes: 4 * MiB, allocatedBytes: pair, sharedBytes: pair, exclusiveBytes: 0,
      linksInScope: 2, linksTotal: 2, extendsOutsideRoot: false,
    });
    assert.equal(ordinary.status, 200);
    assert.deepEqual(ordinary.json, {
      path: c, logicalBytes: MiB, allocatedBytes: solo, sharedBytes: 0, exclusiveBytes: solo,
      linksInScope: 1, linksTotal: 1, extendsOutsideRoot: false, underAllocated: solo < MiB,
    });
  } finally {
    await close();
  }
});

/* ══════════════════ the page ══════════════════ */

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** A declaration out of the built page, from its anchor to its closing brace (parameters skipped). */
function braced(openAnchor: string): string {
  const start = INDEX_HTML.indexOf(openAnchor);
  assert.notEqual(start, -1, `block "${openAnchor}" exists in index.html`);
  let p = INDEX_HTML.indexOf('(', start), paren = 0;
  for (; p < INDEX_HTML.length; p++) {
    if (INDEX_HTML[p] === '(') paren++;
    else if (INDEX_HTML[p] === ')' && --paren === 0) break;
  }
  let depth = 0;
  for (let i = INDEX_HTML.indexOf('{', p); i < INDEX_HTML.length; i++) {
    if (INDEX_HTML[i] === '{') depth++;
    else if (INDEX_HTML[i] === '}' && --depth === 0) return INDEX_HTML.slice(start, i + 1);
  }
  return assert.fail(`block "${openAnchor}" never closes`);
}

/** One top-level statement of the page, from its anchor to the end of its line. */
function line(anchor: string): string {
  const start = INDEX_HTML.indexOf(anchor);
  assert.notEqual(start, -1, `"${anchor}" exists in index.html`);
  return INDEX_HTML.slice(start, INDEX_HTML.indexOf('\n', start));
}

const escapeHtml = new Function(`'use strict'; ${braced('function escapeHtml(')} return escapeHtml;`)() as (s: string) => string;
const formatCount = lift<(n: unknown) => string>(['UI_LOCALE', 'formatCount'], 'formatCount');

/** The page's own api(), over a stand-in fetch that answers every request with `status` and `body`. */
function pageApi(status: number, body: unknown): (url: string) => Promise<unknown> {
  const fetchStub = async () => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });
  return new Function('fetch', `'use strict'; ${braced('async function api(')} return api;`)(fetchStub) as (url: string) => Promise<unknown>;
}

/** The Settings allocation panel as it ships, its one request answered by `answer`; every figure it prints is counted. */
async function allocationPanel(answer: () => Promise<unknown>): Promise<{ html: string; figures: number; asked: string[] }> {
  const els: Record<string, { innerHTML: string; textContent: string }> = {};
  const $ = (id: string) => (els[id] ??= { innerHTML: '', textContent: '' });
  const asked: string[] = [];
  let figures = 0;
  const api = async (url: string) => {
    asked.push(url);
    if (url.startsWith('/api/allocation')) return answer();
    if (url.startsWith('/api/index/status')) return { path: '/x', indexed: true, root: null, running: [{ jobId: 'j', phase: 'enumerating', processed: 10 }], autoBuild: { maxEntries: 1_000_000 } };
    throw new Error(`unexpected ${url}`);
  };
  const src = [line('let indexAutoMaxEntries = '), braced('async function indexStatusFor('), braced('async function renderAllocationDiagnostic(')].join('\n');
  const run = new Function('$', 'state', 'api', 'escapeHtml', 'formatBytes', 'formatCount',
    `'use strict'; ${src} return renderAllocationDiagnostic;`)(
    $, { root: { path: '/x' } }, api, escapeHtml, (n: number) => { figures++; return `${String(n)} B`; }, formatCount) as () => Promise<void>;
  await run();
  return { html: $('allocationDiag').innerHTML, figures, asked };
}

test('the allocation panel says "still building" for a 202 and the not-measured sentence for a 409, and prints no figure for either', async () => {
  // The real client first: a 202 whose status is not 'running' is an answer
  // it hands back, not a wait it throws — so this is the branch the panel meets.
  const building = await pageApi(202, { status: 'building' })('/api/allocation?path=%2Fx');
  assert.deepEqual(building, { status: 'building' }, 'the page\'s api() resolves the 202 with its body');
  let refused: { code?: string; status?: number; message?: string } | null = null;
  await pageApi(409, NOT_MEASURED)('/api/allocation?path=%2Fx').catch((e: { code?: string; status?: number; message?: string }) => { refused = e; });
  assert.ok(refused, 'and rejects the 409');
  const notMeasured = refused as { code?: string; status?: number; message?: string };
  assert.equal(notMeasured.code, 'ALLOCATION_NOT_MEASURED');
  assert.equal(notMeasured.message, ALLOCATION_NOT_MEASURED_SENTENCE);

  const whileBuilding = await allocationPanel(async () => building);
  assert.match(whileBuilding.html, /TreeMap is still building its index of this folder\./, 'a 202 reads as still building');
  assert.equal(whileBuilding.figures, 0, 'and no figure is printed from it');
  assert.doesNotMatch(whileBuilding.html, /What other tools would report|Space actually used/);

  const unmeasured = await allocationPanel(async () => { throw notMeasured; });
  assert.match(unmeasured.html, /Not measured for this index\./, 'a 409 says the space was not measured');
  assert.ok(unmeasured.html.includes(escapeHtml(ALLOCATION_NOT_MEASURED_SENTENCE)), 'in the server\'s own sentence');
  assert.equal(unmeasured.figures, 0, 'and prints no figure');
  assert.doesNotMatch(unmeasured.html, /still building/, 'it is not "still" anything: nothing will measure it');

  // A control, so the harness can tell a figure from none.
  const measured = await allocationPanel(async () => ({
    naiveLogicalBytes: 9, logicalBytes: 5, allocatedBytes: 5, sharedBytes: 4, exclusiveBytes: 1,
    hardlinkFamilies: 1, hardlinkedNames: 1, reconciliation: null, reason: 'r',
  }));
  assert.ok(measured.figures >= 3, 'a measured answer prints its figures');
});

/** `resolveAllocation` as it ships, over a stand-in api answering with `answer`. */
function tooltipResolver(answer: () => Promise<unknown>): { resolve: (node: Record<string, unknown>) => void; asked: string[]; cache: Map<string, unknown> } {
  const asked: string[] = [];
  const cache = new Map<string, unknown>();
  const api = (url: string) => { asked.push(url); return answer(); };
  const tip = { style: { display: 'none' }, dataset: {} as Record<string, string> };
  const resolve = new Function('api', 'allocationCache', '$', 'showTooltip',
    `'use strict'; ${braced('function resolveAllocation(')} return resolveAllocation;`)(
    api, cache, () => tip, () => assert.fail('the tooltip is not showing, so nothing repaints it')) as (node: Record<string, unknown>) => void;
  return { resolve, asked, cache };
}

/** Lets every promise the stand-ins settled run its handlers. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('the tooltip grafts no figure from a 202 or a 409, and asks about the file once', async () => {
  for (const [what, answer] of [
    ['a 202 (still building)', async () => ({ status: 'building' })],
    ['a 409 (not measured)', async () => { throw Object.assign(new Error(ALLOCATION_NOT_MEASURED_SENTENCE), { code: 'ALLOCATION_NOT_MEASURED', status: 409 }); }],
  ] as const) {
    const { resolve, asked, cache } = tooltipResolver(answer);
    const node: Record<string, unknown> = { type: 'file', path: '/x/a.bin', size: 10 };
    resolve(node);
    await settle();
    for (const key of ['allocatedBytes', 'sharedBytes', 'exclusiveBytes', 'linksInScope', 'linksTotal']) {
      assert.ok(!(key in node), `${what}: no ${key} is grafted onto the file`);
    }
    resolve(node);
    await settle();
    assert.equal(asked.length, 1, `${what}: the file is asked about once, never per hover`);
    assert.equal(cache.get('/x/a.bin'), null, `${what}: and remembered as having nothing to say`);
  }
  // The control: a measured answer is grafted, so the loop above could have seen one.
  const { resolve } = tooltipResolver(async () => ({ allocatedBytes: 5, sharedBytes: 5, exclusiveBytes: 0, linksInScope: 2, linksTotal: 2 }));
  const node: Record<string, unknown> = { type: 'file', path: '/x/b.bin', size: 10 };
  resolve(node);
  await settle();
  assert.equal(node.sharedBytes, 5, 'a measured answer is grafted');
});

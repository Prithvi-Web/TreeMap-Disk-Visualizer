import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The Reclaim colour mode must not ask the server the same failing question
 * forever (QA-6 review, HIGH; item 7 of QA-3).
 *
 * The synthetic Trash cell (`maybeInjectTrash`, path "\0trash") was drawn,
 * sent to POST /api/facts, and its null byte made the server refuse the
 * whole batch. The failure path deleted the batch's scores and still called
 * the "scores landed" callback, which repaints, which asks again: one request
 * after another for as long as the map was open (40 calls and 40 redraws
 * before the rate limiter cut it off, in the review's measurement; one call
 * without the Trash cell). A scan of / does the same with any folder the
 * server's blocklist refuses (/private/var/db, C:\Windows\System32).
 *
 * The contract now, every part counted through a stubbed `api` (no clock):
 *  - a cell the server would never answer for — the Trash cell, a freed
 *    block, an in-archive entry, a cloud listing, a NUL in its path — is never
 *    sent, and never counted in the legend's total;
 *  - a failed batch is not asked again until the scan, the view or the folder
 *    on screen changes, and its failure never triggers a repaint;
 *  - a batch the server refuses for one path is halved until only the
 *    refused paths go without a score;
 *  - a failure removes nothing earlier batches landed, and the legend says
 *    "could not be scored", never "still loading", for what failed.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** `function name(…) {…}`, `async function`, `const name = {…};` (brace matched) or `const|let NAME = value;`. */
function declSource(name: string): string {
  let start = INDEX.indexOf(`function ${name}(`);
  if (start > 0 && INDEX.slice(start - 6, start) === 'async ') start -= 6;
  if (start === -1) start = INDEX.indexOf(`const ${name} = {`);
  if (start === -1) {
    let at = INDEX.indexOf(`const ${name} = `);
    if (at === -1) at = INDEX.indexOf(`let ${name} = `);
    assert.notEqual(at, -1, `${name} is declared in the built page`);
    return INDEX.slice(at, INDEX.indexOf(';', at) + 1);
  }
  let from = INDEX.indexOf(name, start) + name.length;
  if (INDEX[from] === '(') {
    // Past the parameter list first: a destructured parameter is a brace.
    for (let paren = 0; from < INDEX.length; from++) {
      if (INDEX[from] === '(') paren++;
      else if (INDEX[from] === ')' && --paren === 0) break;
    }
  }
  let depth = 0;
  for (let i = INDEX.indexOf('{', from); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1) + ';';
  }
  return assert.fail(`${name} never closes`);
}

/**
 * The shipped declarations this file drives. Each is taken from the page when
 * it is there; one that is not (the helpers did not exist before this fix) is
 * simply left out, so the same harness runs the old code and fails on its
 * behaviour — and a helper the shipped code calls but the page lacks fails as
 * a ReferenceError in the test that reaches it.
 */
const SHIPPED = [
  'reclaim', 'RECLAIM_PATH_REFUSALS', 'treeScanId', 'treeScanComing', 'reclaimFailureScope', 'reclaimAskablePath', 'reclaimAskableNode',
  'ensureScores', 'reclaimScoreBatch', 'fetchScoresForTreemap', 'reclaimCoverageNote',
  'tmScoreChain', 'tmScoreKey', 'reclaimNoScanWords', 'scoreFor', 'scoreKnown', 'openReclaimWhy',
];

interface Cell { n: { path: string; isTrash?: boolean; freed?: boolean; virtual?: boolean } }

interface Harness {
  state: { scanId: string; view: string; treemap: { colorMode: string; rootPath: string; mode: string } };
  reclaim: { scores: Map<string, unknown>; pending: Set<string>; failed: Set<string> };
  cells: Cell[];
  /** Every path set the stubbed POST /api/facts was asked about, in order. */
  asked: string[][];
  /** The scan each of those requests was asked of. */
  askedScans: string[];
  /** The AbortSignal each of those requests carried (null when none). */
  signals: Array<AbortSignal | null>;
  calls: { drawView: number; repaintCells: number; renderTmLegend: number };
  fetchScoresForTreemap: () => void;
  ensureScores: (paths: string[], onLanded?: () => void, onFailed?: () => void) => Promise<void>;
  note: () => string;
  /** The page's own breakdown opener (openReclaimWhy), and every toast it raised. */
  why: (path: string) => void;
  toasts: string[];
  /** The stub stops answering: a loop the code under test still runs ends here instead of keeping the file alive. */
  close: () => void;
}

/** Every harness a test opened, closed after it whether it passed or not. */
const open: Harness[] = [];
afterEach(() => { for (const h of open.splice(0)) h.close(); });

/** `unavailable`: the provider answers `available: false`, as reclaimScoreProvider does for a scan still running. */
type Answer = (paths: string[], scanId: string) => { code?: string; values?: Record<string, unknown>; unavailable?: boolean };

/**
 * The shipped functions in one scope, with `answer` as the server: an object
 * with `code` is a refusal (thrown as api() throws one), otherwise the values.
 * Each answer arrives on a later turn of the event loop, as a real one does —
 * so a request loop shows up as a count, never as a hang.
 */
function harness(answer: Answer, opts: { batch?: number; cap?: number } = {}): Harness {
  const h = {
    state: { scanId: 's1', view: 'treemap', treemap: { colorMode: 'reclaim', rootPath: '/r', mode: 'treemap' } },
    cells: [] as Cell[],
    asked: [] as string[][],
    askedScans: [] as string[],
    signals: [] as Array<AbortSignal | null>,
    calls: { drawView: 0, repaintCells: 0, renderTmLegend: 0 },
    toasts: [] as string[],
  } as Harness;
  let closed = false;
  h.close = () => { closed = true; };
  open.push(h);
  const api = (url: string, init: { body: string; signal?: AbortSignal }): Promise<unknown> => new Promise((resolve, reject) => {
    if (closed) return; // never settles, and holds nothing open
    assert.equal(url, '/api/facts');
    const { paths, scanId } = JSON.parse(init.body) as { paths: string[]; scanId: string };
    h.asked.push(paths);
    h.askedScans.push(scanId);
    h.signals.push(init.signal ?? null);
    // As fetch does (and api() passes on): an abort rejects with an AbortError at once.
    const aborted = () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    if (init.signal?.aborted) { aborted(); return; }
    init.signal?.addEventListener('abort', aborted, { once: true });
    setImmediate(() => {
      if (closed || init.signal?.aborted) return;
      const a = answer(paths, scanId);
      if (a.code) reject(Object.assign(new Error(`refused: ${a.code}`), { code: a.code, status: 400 }));
      else if (a.unavailable) resolve({ providers: { reclaimScore: { available: false, reason: 'The scan is still running.' } } });
      else resolve({ providers: { reclaimScore: { available: true, values: a.values ?? {} } } });
    });
  });
  const deps: Record<string, unknown> = {
    state: h.state,
    api,
    window: { TREEMAP_DEBUG: false },
    console,
    RECLAIM_BATCH: opts.batch ?? 2000,
    TM_SCORE_CAP: opts.cap ?? 6000,
    drawnCells: () => h.cells,
    isCells: () => false,
    // The real repaint re-asks for the scores of what it drew: that is the loop under test.
    drawView: () => { h.calls.drawView++; h.fetchScoresForTreemap(); },
    repaintCells: () => { h.calls.repaintCells++; h.fetchScoresForTreemap(); },
    renderTmLegend: () => { h.calls.renderTmLegend++; },
    formatCount: (n: number) => n.toLocaleString('en-US'),
    // The breakdown's panel is not under test: what it says when there is no score to show is.
    $: () => ({}), toast: (m: string) => { h.toasts.push(m); },
  };
  const keys = Object.keys(deps);
  const present = SHIPPED.filter((name) => INDEX.includes(`function ${name}(`) || INDEX.includes(`const ${name} = `)
    || INDEX.includes(`let ${name} = `));
  const why = present.includes('openReclaimWhy') ? 'openReclaimWhy' : 'null';
  const src = `'use strict';\n${present.map(declSource).join('\n')}\nreturn { reclaim, ensureScores, fetchScoresForTreemap, reclaimCoverageNote, why: ${why} };`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const out = new Function(...keys, src)(...keys.map((k) => deps[k])) as {
    reclaim: Harness['reclaim']; ensureScores: Harness['ensureScores']; fetchScoresForTreemap: () => void; reclaimCoverageNote: () => string;
    why: Harness['why'];
  };
  h.reclaim = out.reclaim;
  h.ensureScores = out.ensureScores;
  h.fetchScoresForTreemap = out.fetchScoresForTreemap;
  h.note = out.reclaimCoverageNote;
  h.why = out.why;
  return h;
}

/** Lets `n` turns of the event loop run: long enough for any loop to show itself as a count. */
async function turns(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

const scoreOf = (paths: string[]): Record<string, unknown> => Object.fromEntries(paths.map((p) => [p, { score: 50 }]));
const files = (n: number, prefix = '/r/f'): Cell[] => Array.from({ length: n }, (_, i) => ({ n: { path: `${prefix}${i}` } }));
const TRASH: Cell = { n: { path: '\0trash', isTrash: true } };
/** The server's own rule, stood in for: a NUL is PATH_INVALID, /private/var/db is PATH_BLOCKED, for the whole batch. */
const SERVER: Answer = (paths) => {
  if (paths.some((p) => p.includes('\0'))) return { code: 'PATH_INVALID' };
  if (paths.some((p) => p.startsWith('/private/var/db'))) return { code: 'PATH_BLOCKED' };
  return { values: scoreOf(paths) };
};

test('a drawn Trash cell is never sent, and the map is scored in one request', async () => {
  const h = harness(SERVER);
  h.cells = [...files(5), TRASH];
  h.fetchScoresForTreemap();
  await turns(60);
  assert.equal(h.asked.length, 1, `${h.asked.length} requests, the first ${JSON.stringify(h.asked[0])}`);
  assert.ok(!h.asked.flat().some((p) => p.includes('\0')), 'the Trash cell was sent');
  assert.equal(h.reclaim.scores.size, 5);
  assert.equal(h.calls.drawView, 1, 'one repaint for the scores that landed');
  assert.equal(h.note(), '', 'every cell that can be scored is scored: the Trash cell is not one of them');
});

test('a freed block, an in-archive entry, a cloud listing, a virtual cell and a NUL are never sent nor counted', async () => {
  const h = harness(SERVER);
  h.cells = [
    ...files(3),
    { n: { path: '/r/f0 — freed', freed: true } },
    { n: { path: '/r/a.zip!/inner.txt', virtual: true } },
    { n: { path: 'cloud://drive/x' } },
    { n: { path: '/r/odd\0name' } }, // a NUL without the Trash flag: still no path the route accepts
  ];
  h.fetchScoresForTreemap();
  await turns(60);
  assert.deepEqual(h.asked, [['/r/f0', '/r/f1', '/r/f2']]);
  assert.equal(h.note(), '');
});

test('a request that fails every time is sent once, triggers no repaint, and the legend says the cells could not be scored', async () => {
  const h = harness(() => ({ code: 'HTTP_500' }));
  h.cells = files(4);
  h.fetchScoresForTreemap();
  await turns(60);
  assert.equal(h.asked.length, 1, `the failing request was re-sent ${h.asked.length - 1} times`);
  assert.equal(h.calls.drawView, 0, 'a failure is not "scores landed": no repaint');
  assert.equal(h.calls.renderTmLegend, 1, 'but the legend is told');
  assert.match(h.note(), /4 of 4 could not be scored/);
  assert.doesNotMatch(h.note(), /loading/);
  // The repaints that follow (a hover, a layout switch) do not ask again.
  h.fetchScoresForTreemap();
  await h.ensureScores(['/r/f0', '/r/f1']);
  await turns(20);
  assert.equal(h.asked.length, 1);
});

test('a failed request is asked again once the folder on screen, the view or the scan changes', async () => {
  let fail = true;
  const h = harness((paths) => (fail ? { code: 'HTTP_500' } : { values: scoreOf(paths) }));
  h.cells = files(2);
  h.fetchScoresForTreemap();
  await turns(30);
  assert.equal(h.asked.length, 1);
  h.state.treemap.rootPath = '/r/sub'; // drilled in and back: another folder on screen
  fail = false;
  h.fetchScoresForTreemap();
  await turns(30);
  assert.equal(h.asked.length, 2, 'a new folder on screen asks again, once');
  assert.equal(h.reclaim.scores.size, 2);
});

test('a batch refused for one path is halved until only that path goes without a score', async () => {
  const h = harness(SERVER, { batch: 16 });
  const cells = files(16);
  cells[11] = { n: { path: '/private/var/db/uuidtext' } };
  h.cells = cells;
  h.fetchScoresForTreemap();
  await turns(200);
  assert.equal(h.reclaim.scores.size, 15, 'every other path is scored');
  assert.ok(!h.reclaim.scores.has('/private/var/db/uuidtext'));
  assert.deepEqual([...h.reclaim.failed], ['/private/var/db/uuidtext'], 'the refused path is remembered as failed');
  // 1 + 2·log2(16) at most: each halving asks about two halves of what was refused.
  assert.ok(h.asked.length <= 9, `${h.asked.length} requests to isolate one refused path in 16`);
  assert.match(h.note(), /1 of 16 could not be scored/);
  const before = h.asked.length;
  h.fetchScoresForTreemap();
  await turns(30);
  assert.equal(h.asked.length, before, 'and nothing is asked again');
});

test('a failed batch removes nothing an earlier batch landed', async () => {
  let n = 0;
  const h = harness((paths) => (n++ === 0 ? { values: scoreOf(paths) } : { code: 'HTTP_500' }), { batch: 2 });
  await h.ensureScores(['/r/a', '/r/b', '/r/c', '/r/d']);
  assert.deepEqual([...h.reclaim.scores.keys()], ['/r/a', '/r/b'], 'the first batch keeps its scores');
  assert.deepEqual([...h.reclaim.failed], ['/r/c', '/r/d']);
});

test('the legend counts a landed path as scored while its request is still in flight', () => {
  const h = harness(SERVER);
  h.cells = files(4);
  for (const c of h.cells) h.reclaim.pending.add(c.n.path);
  h.reclaim.scores.set('/r/f0', { score: 50 });
  h.reclaim.scores.set('/r/f1', { score: 50 });
  assert.match(h.note(), /Scored 2 of 4 on screen; 2 more are loading\./);
});

test('"TreeMap stops at 6,000" is said only when there are cells beyond 6,000', () => {
  const h = harness(SERVER, { cap: 10 });
  h.cells = files(10);
  h.cells.slice(0, 2).forEach((c) => h.reclaim.scores.set(c.n.path, { score: 50 }));
  h.cells.slice(2).forEach((c) => h.reclaim.pending.add(c.n.path));
  assert.doesNotMatch(h.note(), /stops at/, 'exactly at the cap, nothing is left unasked');
  h.cells = files(12);
  assert.match(h.note(), /stops at 10 at a time/, 'past the cap, the cap is why two cells stay grey');
});

/* ══════════════ QA-6 review MEDIUM-2 — a chain for a map no longer on screen is cancelled ══════════════ */

test('MEDIUM-2: a drill-in cancels the chain still scoring the folder left behind', async () => {
  // Up to three sequential 2,000-path batches per folder, each a subprocess-backed
  // scoring in the same strict lane as map loads and deletes; drilling quickly
  // left every one of them running.
  const h = harness(SERVER, { batch: 2 });
  h.cells = files(6); // three batches
  h.fetchScoresForTreemap();
  for (let i = 0; i < 50 && h.asked.length < 2; i++) await turns(1);
  assert.equal(h.asked.length, 2, 'the first batch landed and the second is out');
  h.state.treemap.rootPath = '/r/a'; // the drill-in lands, and its draw asks for its own cells
  h.cells = files(3, '/r/a/x');
  h.fetchScoresForTreemap();
  assert.equal(h.signals[1]?.aborted, true, 'the request in flight for the folder left behind is cancelled');
  await turns(60);
  assert.deepEqual(h.asked, [['/r/f0', '/r/f1'], ['/r/f2', '/r/f3'], ['/r/a/x0', '/r/a/x1'], ['/r/a/x2']],
    'nothing more is asked about the folder left behind');
  assert.equal(h.reclaim.pending.size, 0, 'nothing is left marked in flight');
  assert.equal(h.calls.drawView, 1,
    'one repaint, for the new folder\'s scores; the cancelled chain repaints nothing, though its first batch had landed');
});

test('MEDIUM-2: a new scan of the same folder cancels the chain still scoring the old one, request in flight included (QA-6b review F1.6)', async () => {
  // A rescan keeps the folder, the renderer and the colouring: only the scan
  // id tells the two chains apart, and the old one's 2,000-path request was
  // left to run until a later check stopped the chain after it.
  const h = harness(SERVER, { batch: 2 });
  h.cells = files(6); // three batches
  h.fetchScoresForTreemap();
  assert.equal(h.asked.length, 1, 'control: the first batch of the old scan is out');
  h.state.scanId = 's2'; // the rescan lands; its draw asks for its own cells
  h.fetchScoresForTreemap();
  assert.equal(h.signals[0]?.aborted, true, 'the old scan\'s request in flight is cancelled at once');
  assert.equal(h.signals[1]?.aborted, false, 'the new scan\'s is not');
  await turns(60);
  assert.deepEqual(h.asked.slice(1), [['/r/f0', '/r/f1'], ['/r/f2', '/r/f3'], ['/r/f4', '/r/f5']],
    'the new scan asks for every cell itself, and the old chain sends nothing more');
  assert.equal(h.reclaim.failed.size, 0, 'the cancelled request is not remembered as a failure');
  assert.equal(h.note(), '');
});

test('MEDIUM-2: a cell the cancelled chain held in flight is asked for by its replacement at once', async () => {
  const h = harness(SERVER, { batch: 2 });
  h.cells = [{ n: { path: '/r/a/x0' } }, { n: { path: '/r/f1' } }, ...files(2, '/r/g')];
  h.fetchScoresForTreemap(); // '/r/a/x0' rides in the first batch
  h.state.treemap.rootPath = '/r/a';
  h.cells = files(2, '/r/a/x');
  h.fetchScoresForTreemap();
  assert.deepEqual(h.asked[1], ['/r/a/x0', '/r/a/x1'],
    'x0 is not skipped as "in flight": the request holding it was just cancelled, and would never answer for it');
  // The cancelled chain winds down in microtasks; its replacement's answer has not arrived yet.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(h.reclaim.pending.has('/r/a/x0'), true,
    'the replacement still holds x0 in flight — the cancelled chain, ending, did not release it from under it');
  await turns(60);
  assert.equal(h.note(), '', 'every cell of the new folder is scored');
});

test('MEDIUM-2: between batches a chain stops once its map is gone, even before anything new asks', async () => {
  const h = harness(SERVER, { batch: 2 });
  h.cells = files(6);
  h.fetchScoresForTreemap();
  h.state.treemap.mode = 'circles'; // another renderer — another drawn set
  await turns(60);
  assert.deepEqual(h.asked, [['/r/f0', '/r/f1']], 'the batches after the one in flight are never sent');
  assert.equal(h.calls.drawView, 0, 'and nothing is repainted for a map no longer on screen');
});

test('MEDIUM-2: repaints of the same map share its chain — a hover does not cancel the scoring under way', async () => {
  const h = harness(SERVER, { batch: 2 });
  h.cells = files(4);
  h.fetchScoresForTreemap();
  h.fetchScoresForTreemap(); // the same map, asked again
  assert.equal(h.signals[0]?.aborted, false);
  await turns(60);
  assert.equal(h.reclaim.scores.size, 4);
});

test('MEDIUM-2: a request cancelled by turning Reclaim off is not a failure; turned back on, its cells are scored', async () => {
  const h = harness(SERVER, { batch: 2 });
  h.cells = files(4);
  h.fetchScoresForTreemap();
  h.state.treemap.colorMode = 'size';
  h.fetchScoresForTreemap(); // what setTreemapColorMode('size') does now
  assert.equal(h.signals[0]?.aborted, true, 'switching the colouring off cancels the chain at once');
  h.state.treemap.colorMode = 'reclaim';
  h.fetchScoresForTreemap();
  await turns(60);
  assert.equal(h.asked.length, 3,
    'the cancelled chain sends nothing more, even with its map back on screen; its replacement asks for all four in two');
  assert.equal(h.reclaim.failed.size, 0, 'the cancelled request is not remembered as failed — those cells would read "could not be scored"');
  assert.equal(h.reclaim.scores.size, 4);
  assert.equal(h.note(), '');
});

test('MEDIUM-2: a chain cancelled while it halves a refused batch sends no second half', async () => {
  const h = harness(SERVER, { batch: 4 });
  h.cells = [{ n: { path: '/r/f0' } }, { n: { path: '/private/var/db/x' } }, { n: { path: '/r/f2' } }, { n: { path: '/r/f3' } }];
  h.fetchScoresForTreemap();
  for (let i = 0; i < 50 && h.asked.length < 2; i++) await turns(1);
  assert.deepEqual(h.asked, [['/r/f0', '/private/var/db/x', '/r/f2', '/r/f3'], ['/r/f0', '/private/var/db/x']],
    'refused for one path, the batch is being halved');
  h.state.treemap.rootPath = '/r/sub';
  h.cells = [];
  h.fetchScoresForTreemap(); // the map moved on
  await turns(60);
  assert.equal(h.asked.length, 2, 'the other half of a batch nobody is looking at is never sent');
  assert.equal(h.reclaim.failed.size, 0);
});

test('MEDIUM-2: choosing a colour mode always lets the score chain know', () => {
  let asked = 0;
  const seg = { querySelectorAll: () => [] };
  const setMode = new Function('$', 'localStorage', 'state', 'isCells', 'repaintCells', 'drawView', 'renderTmLegend', 'fetchScoresForTreemap',
    `'use strict'; ${declSource('TM_COLOR_MODES')}\n${declSource('setTreemapColorMode')}\nreturn setTreemapColorMode;`)(
    () => seg, { setItem() {} }, { treemap: { rootPath: '/r', colorMode: 'reclaim' } },
    () => false, () => {}, () => {}, () => {}, () => { asked++; }) as (m: string) => void;
  setMode('size');
  assert.equal(asked, 1, 'turning Reclaim off is how its chain learns to stop now, not after the batch in flight');
  setMode('reclaim');
  assert.equal(asked, 2);
});

/* ── Review F2.2: the scores are asked of the scan the tree on screen came from ──
   While a rescan runs over an older scan's tree, the map draws that tree,
   asked of its own scan (settledScanId, review F1.5), and the running scan's
   id is on hand once its request answers (state.scanId). A score asked of
   the running scan is answered "unavailable" for every path, filed as asked
   and none, and a Stop — which puts the older scan back without a TOPIC.scan
   — left the map grey and the tooltip saying no signal could be read, until
   the next scan. */

test('review F2.2: while a rescan runs over an older scan\'s tree, its scores are asked of that older scan — never the running one, which answers "unavailable" — and a Stop keeps them; an answer landing after the rescan landed is not filed against the new tree', async () => {
  const RUNNING = 'B';
  const h = harness((paths, scanId) => (scanId === RUNNING ? { unavailable: true } : { values: scoreOf(paths) }));
  // followScanProgress has set the running scan's id; the tree on screen is A's.
  Object.assign(h.state, { scanId: RUNNING, settledScanId: 'A', scanning: true });
  h.cells = files(2, '/r/');
  h.fetchScoresForTreemap();
  await turns(60);
  assert.deepEqual(h.askedScans, ['A'], 'the scores are asked of the scan the tree on screen came from');
  assert.deepEqual([...h.reclaim.scores.entries()], [['/r/0', { score: 50 }], ['/r/1', { score: 50 }]], 'and filed as scores — never as asked and none');
  assert.equal(h.calls.drawView, 1, 'and the map repaints in their colours');
  // Stop: the older scan is the one behind the tree again (stopScan), with no TOPIC.scan to reset the scores.
  Object.assign(h.state, { scanning: false, scanId: 'A' });
  h.fetchScoresForTreemap();
  await turns(60);
  assert.deepEqual(h.askedScans, ['A'], 'after the Stop nothing more is asked: the scores on hand are that tree\'s');
  assert.equal(h.reclaim.scores.size, 2, 'and they stay');

  // An answer asked of A that lands once the rescan has landed (its tree on screen now) is not filed against it.
  const late = harness((paths) => ({ values: scoreOf(paths) }));
  Object.assign(late.state, { scanId: RUNNING, settledScanId: 'A', scanning: true });
  late.cells = files(2, '/r/');
  late.fetchScoresForTreemap();
  assert.deepEqual(late.askedScans, ['A'], 'control: asked of A');
  Object.assign(late.state, { scanning: false, scanId: RUNNING, settledScanId: RUNNING }); // finishScan, before the answer
  await turns(60);
  assert.equal(late.reclaim.scores.size, 0, 'A\'s scores are not filed against B\'s tree');

  // The saved index's tree on screen, its scan running: no scan stands behind the tree, so nothing is asked.
  const idx = harness((paths) => ({ values: scoreOf(paths) }));
  Object.assign(idx.state, { scanId: RUNNING, settledScanId: null, scanning: true });
  idx.cells = files(2, '/r/');
  idx.fetchScoresForTreemap();
  await turns(60);
  assert.deepEqual(idx.askedScans, [], 'a saved index\'s tree is asked no scores — not of the running scan, not of no scan');
});

test('review F2.2: a failed score request asked while a rescan runs is remembered for the tree on screen — its scan\'s request answering meanwhile changes nothing about that tree, so the cells are not asked again', async () => {
  const h = harness(() => ({ code: 'INTERNAL' }));
  // A rescan has started; its request has not answered yet: the scan on hand is still the tree's own.
  Object.assign(h.state, { scanId: 'A', settledScanId: 'A', scanning: true });
  h.cells = files(2, '/r/');
  h.fetchScoresForTreemap();
  h.state.scanId = 'B'; // followScanProgress: the rescan's request answers while the scores are out
  await turns(60);
  assert.equal(h.asked.length, 1, 'control: asked once, and it failed');
  h.fetchScoresForTreemap(); // the next repaint of the same tree
  await turns(60);
  assert.equal(h.asked.length, 1, `not asked again: the tree on screen, A's, is the one the failure was for (${JSON.stringify(h.askedScans)})`);
});

/* ── Review F3.2: the score chain is keyed on the tree's scan, as the scores are asked of it ──
   F2.2 moved the asks to the scan the tree on screen came from, but the
   chain — which map a chain of batches is for — was still keyed on the scan
   on hand. A rescan's request answering while a batch was out moved that key:
   the batch's scores were filed, its repaint and legend were dropped as the
   chain's, and every later ask found them known and repainted nothing — grey
   cells in the Reclaim colour mode until something else redrew the map. */

test('review F3.2: a rescan\'s request answering while a score batch of the older scan\'s tree is out does not drop its repaint — the chain is the tree\'s, whose scan has not changed', async () => {
  const h = harness((paths) => ({ values: scoreOf(paths) }));
  // Scan A's map drawn, its scores asked.
  Object.assign(h.state, { scanId: 'A', settledScanId: 'A', scanning: false });
  h.cells = files(3, '/r/');
  h.fetchScoresForTreemap();
  // The person presses Scan (beginScanChrome), and the rescan's request answers (followScanProgress) while the batch is out.
  Object.assign(h.state, { scanning: true });
  h.state.scanId = 'B';
  await turns(60);
  assert.deepEqual(h.askedScans, ['A'], 'control: asked of the scan the tree on screen came from');
  assert.equal(h.reclaim.scores.size, 3, 'control: and filed');
  assert.equal(h.calls.drawView, 1, 'the map repaints in their colours');
  assert.equal(h.calls.renderTmLegend, 1, 'and the legend says they are scored');
});

/* ── Review F3.3: a saved index's tree is not "still loading" ──
   With no scan behind the tree on screen — the saved index's, painted before
   its scan answers or left by a Stop (J05) — nothing is asked (F2.2) and
   nothing is pending, yet the legend said "Scored 0 of N on screen; the rest
   are still loading." for as long as it stood, for good after a Stop, and the
   right-click breakdown said the score "has not been worked out yet". */

const SCORED_ONCE_SCANNED = ' Not scored yet — scoring starts once this folder’s scan finishes.';
const SCAN_TO_SCORE = ' Not scored — opened from the saved index; scan this folder to score it.';

test('review F3.3: over a saved index\'s tree no scan stands behind, the legend and the breakdown never say the scores are loading — nothing is asked: while its scan is due or runs they say scoring starts once it finishes, and once a Stop has ended it, to scan the folder to score it', async () => {
  const h = harness((paths) => ({ values: scoreOf(paths) }));
  // The index paint: its scan due (finishScan), the scan chrome not yet begun again.
  Object.assign(h.state, { scanId: null, settledScanId: null, scanning: false, indexScanDue: true });
  h.cells = files(3, '/r/');
  h.fetchScoresForTreemap();
  await turns(60);
  assert.deepEqual(h.askedScans, [], 'control: nothing is asked — no scan stands behind the tree');
  assert.equal(h.note(), SCORED_ONCE_SCANNED, 'at the paint, its scan due: scoring waits on that scan');
  // Its scan runs (beginScanChrome), its request answered (followScanProgress).
  Object.assign(h.state, { scanning: true, scanId: 'B' });
  h.fetchScoresForTreemap();
  await turns(60);
  assert.deepEqual(h.askedScans, [], 'control: still nothing asked of the running scan');
  assert.equal(h.note(), SCORED_ONCE_SCANNED, 'and while it runs');
  h.why('/r/0'); // right-click › Why this reclaim score?
  assert.deepEqual(h.toasts, [SCORED_ONCE_SCANNED.trim()], 'the breakdown says the same');
  // Stop, or a failure: the scan chrome ended (endScanChrome), the scan behind the tree = none.
  Object.assign(h.state, { scanning: false, indexScanDue: false, scanId: null });
  assert.equal(h.note(), SCAN_TO_SCORE, 'once nothing will land, the legend says what would score the tree');
  h.why('/r/0');
  assert.deepEqual(h.toasts.slice(1), [SCAN_TO_SCORE.trim()], 'and so does the breakdown');
  // A rescan of it pressed (beginScanChrome), the index asked about: no paint yet, so nothing due — but a scan runs.
  Object.assign(h.state, { scanning: true });
  assert.equal(h.note(), SCORED_ONCE_SCANNED, 'a scan of it starting: scoring waits on that scan again');

  // A tree its scan stands behind, its scores still to come: as before.
  const scanned = harness(() => ({ values: {} }));
  scanned.cells = files(3, '/r/');
  assert.equal(scanned.note(), ' Scored 0 of 3 on screen; the rest are still loading.', 'control: a scanned tree not yet asked about still says so');
  scanned.why('/r/0');
  assert.deepEqual(scanned.toasts, ['That score has not been worked out yet.'], 'control: and its breakdown');
});

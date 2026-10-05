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

/** `function name(…) {…}`, `async function`, `const name = {…};` (brace matched) or `const NAME = value;`. */
function declSource(name: string): string {
  let start = INDEX.indexOf(`function ${name}(`);
  if (start > 0 && INDEX.slice(start - 6, start) === 'async ') start -= 6;
  if (start === -1) start = INDEX.indexOf(`const ${name} = {`);
  if (start === -1) {
    const at = INDEX.indexOf(`const ${name} = `);
    assert.notEqual(at, -1, `${name} is declared in the built page`);
    return INDEX.slice(at, INDEX.indexOf(';', at) + 1);
  }
  let depth = 0;
  for (let i = INDEX.indexOf('{', INDEX.indexOf(name, start) + name.length); i < INDEX.length; i++) {
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
  'reclaim', 'RECLAIM_PATH_REFUSALS', 'reclaimFailureScope', 'reclaimAskablePath', 'reclaimAskableNode',
  'ensureScores', 'reclaimScoreBatch', 'fetchScoresForTreemap', 'reclaimCoverageNote',
];

interface Cell { n: { path: string; isTrash?: boolean; freed?: boolean; virtual?: boolean } }

interface Harness {
  state: { scanId: string; view: string; treemap: { colorMode: string; rootPath: string } };
  reclaim: { scores: Map<string, unknown>; pending: Set<string>; failed: Set<string> };
  cells: Cell[];
  /** Every path set the stubbed POST /api/facts was asked about, in order. */
  asked: string[][];
  calls: { drawView: number; repaintCells: number; renderTmLegend: number };
  fetchScoresForTreemap: () => void;
  ensureScores: (paths: string[], onLanded?: () => void, onFailed?: () => void) => Promise<void>;
  note: () => string;
  /** The stub stops answering: a loop the code under test still runs ends here instead of keeping the file alive. */
  close: () => void;
}

/** Every harness a test opened, closed after it whether it passed or not. */
const open: Harness[] = [];
afterEach(() => { for (const h of open.splice(0)) h.close(); });

type Answer = (paths: string[]) => { code?: string; values?: Record<string, unknown> };

/**
 * The shipped functions in one scope, with `answer` as the server: an object
 * with `code` is a refusal (thrown as api() throws one), otherwise the values.
 * Each answer arrives on a later turn of the event loop, as a real one does —
 * so a request loop shows up as a count, never as a hang.
 */
function harness(answer: Answer, opts: { batch?: number; cap?: number } = {}): Harness {
  const h = {
    state: { scanId: 's1', view: 'treemap', treemap: { colorMode: 'reclaim', rootPath: '/r' } },
    cells: [] as Cell[],
    asked: [] as string[][],
    calls: { drawView: 0, repaintCells: 0, renderTmLegend: 0 },
  } as Harness;
  let closed = false;
  h.close = () => { closed = true; };
  open.push(h);
  const api = (url: string, init: { body: string }): Promise<unknown> => new Promise((resolve, reject) => {
    if (closed) return; // never settles, and holds nothing open
    assert.equal(url, '/api/facts');
    const paths = (JSON.parse(init.body) as { paths: string[] }).paths;
    h.asked.push(paths);
    setImmediate(() => {
      if (closed) return;
      const a = answer(paths);
      if (a.code) reject(Object.assign(new Error(`refused: ${a.code}`), { code: a.code, status: 400 }));
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
  };
  const keys = Object.keys(deps);
  const present = SHIPPED.filter((name) => INDEX.includes(`function ${name}(`) || INDEX.includes(`const ${name} = `));
  const src = `'use strict';\n${present.map(declSource).join('\n')}\nreturn { reclaim, ensureScores, fetchScoresForTreemap, reclaimCoverageNote };`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const out = new Function(...keys, src)(...keys.map((k) => deps[k])) as {
    reclaim: Harness['reclaim']; ensureScores: Harness['ensureScores']; fetchScoresForTreemap: () => void; reclaimCoverageNote: () => string;
  };
  h.reclaim = out.reclaim;
  h.ensureScores = out.ensureScores;
  h.fetchScoresForTreemap = out.fetchScoresForTreemap;
  h.note = out.reclaimCoverageNote;
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

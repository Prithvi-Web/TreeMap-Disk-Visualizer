import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-highlightSearchLatency-data-');

import { INDEX } from './fixtures/liftFrontend';

/**
 * Highlight and global search, typed to painted (design pass G07).
 *
 * On a 304k-file scan the pass measured 232-605 ms from typing to a painted
 * highlight and 345-565 ms to global search results. Highlight waited 150 ms
 * after the last keystroke, then asked the server to parse the query
 * (/api/query/validate), and only when that answered asked it to run the
 * query (/api/query), which parses it again: two round trips in a row. Global
 * search waited 140 ms. A query the person had typed past ran on to the end.
 *
 * Now: one request per query — /api/query answers a parse error itself, with
 * the same offset, so the message under the box is what it was; shorter waits
 * (90 ms); and every keystroke aborts the request still out for the text
 * before it, so its answer can never paint and its walk stops on the server
 * (tests/queryWalkWork.test.ts). Ordered by a sequence number as before: an
 * answer that is not the newest ask's is dropped, aborted or not.
 *
 * The page's own functions run here over a stubbed server whose answers the
 * test hands back in whatever order it likes. Nothing is timed: the waits are
 * read as the constants the input handlers schedule with.
 */

function matchingBrace(open: number): number {
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return i;
  }
  return assert.fail(`the block opening at ${open} never closes`);
}
function declOf(name: string): string {
  const m = new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`).exec(INDEX);
  assert.ok(m, `function ${name} exists in the built page`);
  const open = INDEX.indexOf(') {', m!.index) + 2;
  return INDEX.slice(m!.index, matchingBrace(open) + 1);
}
function constOf(name: string): string {
  const m = new RegExp(`const ${name} = [^\\n]*;`).exec(INDEX);
  assert.ok(m, `const ${name} exists in the built page`);
  return m![0];
}
const turns = async (n = 8): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve(); };

interface Ask { url: string; body: { q?: string }; signal: AbortSignal | undefined; answer(d: unknown): Promise<void>; fail(e: Error): Promise<void> }

/**
 * A server whose answers wait until the test hands them back. An aborted ask
 * rejects as fetch does — unless `answersAnyway`: an answer already on its
 * way when the abort came, which the sequence number alone must keep off the
 * screen.
 */
function heldServer(answersAnyway = false): { api: (url: string, opts?: { body?: string; signal?: AbortSignal }) => Promise<unknown>; asks: Ask[] } {
  const asks: Ask[] = [];
  const api = (url: string, opts: { body?: string; signal?: AbortSignal } = {}): Promise<unknown> => new Promise((resolve, reject) => {
    const signal = opts.signal;
    if (!answersAnyway) signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
    asks.push({
      url, body: opts.body ? JSON.parse(opts.body) : {}, signal,
      answer: async (d) => { resolve(d); await turns(); },
      fail: async (e) => { reject(e); await turns(); },
    });
  });
  return { api, asks };
}

const hits = (paths: string[]): Record<string, unknown> => ({
  hits: paths.map((p, i) => ({ path: p, name: p.split('/').pop(), size: 100 - i, isDir: false, mtimeMs: 0 })),
  total: paths.length, truncated: false, degraded: [],
});

/* ── Highlight ───────────────────────────────────────────────────────────── */

/** A stub element: the fields and calls the box's message touches. */
interface Elem { value: string; hidden: boolean; textContent: string; childElementCount: number; classList: { toggle(c: string, on?: boolean): void; contains(c: string): boolean }; setAttribute(k: string, v: string): void; getAttribute(k: string): string | null }
function elem(): Elem {
  const cls = new Set<string>();
  const attrs: Record<string, string> = {};
  return {
    value: '', hidden: true, textContent: '', childElementCount: 0,
    classList: { toggle: (c, on) => { if (on ?? !cls.has(c)) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) },
    setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k] ?? null,
  };
}

function highlight(answersAnyway = false) {
  const server = heldServer(answersAnyway);
  const said: Array<{ text: string; isError: boolean }> = [];
  const els: Record<string, Elem> = {};
  const $ = (id: string): Elem => (els[id] ||= elem());
  const state = {
    scanId: 's1' as string | null, root: { path: '/r' }, view: 'treemap',
    treemap: { query: '', queryMode: 'bare', matchedPaths: null as Set<string> | null, matchTotal: null as number | null, matches: 0, rootPath: '/r' },
  };
  const noop = (): void => {};
  let painted = 0;
  const deps: Record<string, unknown> = {
    state, api: server.api, $,
    // Every message the box is given, recorded, then shown by the page's own
    // tmSetQueryMessage: the error text, its hidden flag, the box's invalid mark.
    record: (text: string, isError: boolean) => { said.push({ text, isError }); }, tmSyncQueryBar: noop,
    tmSyncStageButton: noop, seedNodes: noop, tmStageable: () => null, formatCount: String, tmUndrawnMessage: () => '',
    isSun: () => false, isCells: () => false, renderSearchOverlay: () => { painted++; }, presentTreemap: noop, presentView: noop,
    presentSunburst: noop, presentCells: noop, renderCellsStatus: noop, clearTimeout, setTimeout,
  };
  const consts = ['TM_GRAMMAR_FIELDS', 'TM_GRAMMAR_RE', 'TM_FIELDLIKE_RE'].filter((n) => INDEX.includes(`const ${n} =`));
  const helpers = ['tmIsGrammarQuery', 'tmEditDistance', 'tmUnknownFieldHint'].filter((n) => new RegExp(`function ${n}\\s*\\(`).test(INDEX));
  const names = [...helpers, 'tmCancelQueries', 'tmClearHits', 'tmRunGrammarQuery', 'tmApplyQuery'];
  const keys = Object.keys(deps);
  const src = `'use strict'; let tmQueryDeb = 0; let tmQuerySeq = 0; let tmQueryAbort = null; let tmLastHits = { q: '', paths: [], total: 0, truncated: false, stage: null };\n` +
    `${consts.map(constOf).join('\n')}\n${names.map(declOf).join('\n')}\n` +
    `${declOf('tmSetQueryMessage').replace(/^function tmSetQueryMessage\(/, 'function tmSetQueryMessageShipped(')}\n` +
    'function tmSetQueryMessage(text, isError) { record(text, isError); tmSetQueryMessageShipped(text, isError); }\n' +
    'return { apply: tmApplyQuery, cancel: tmCancelQueries };';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const page = new Function(...keys, src)(...keys.map((k) => deps[k])) as { apply: (q: string) => void; cancel: () => void };
  return { ...page, ...server, state, said, painted: () => painted, input: $('tmSearch'), err: $('tmQueryErr') };
}

test('G07: a grammar query is one request — the server parses it as it runs it, with no separate check first', async () => {
  const h = highlight();
  h.apply('size>100mb');
  await turns();
  assert.deepEqual(h.asks.map((a) => a.url), ['/api/query'], 'asked once, straight away');
  assert.equal(h.asks[0].body.q, 'size>100mb');
  await h.asks[0].answer(hits(['/r/a', '/r/b']));
  assert.deepEqual([...h.state.treemap.matchedPaths!], ['/r/a', '/r/b'], 'and painted from that one answer');
  assert.equal(h.painted(), 1);
  for (const fn of ['tmApplyQuery', 'tmRunGrammarQuery']) {
    assert.doesNotMatch(declOf(fn), /\/api\/query\/validate'/, `${fn} never asks the parse-only route`);
  }
  assert.doesNotMatch(INDEX, /function tmValidateQuery\(/, 'and the box has no parse-only step left to call');
});

test('G07: a query that does not parse says where, as the parse-only check did, and leaves the last highlights standing', async () => {
  const h = highlight();
  h.apply('size>1gb');
  await h.asks[0].answer(hits(['/r/big']));
  h.apply('size>');
  await turns();
  await h.asks[1].fail(Object.assign(new Error('A size needs a number after the operator.'), { code: 'QUERY_PARSE_ERROR', offset: 5, status: 400 }));
  assert.deepEqual(h.said[h.said.length - 1], { text: 'A size needs a number after the operator. (at character 6)', isError: true },
    'the parser\'s own words, and where');
  assert.deepEqual([...h.state.treemap.matchedPaths!], ['/r/big'], 'the map keeps the highlights of the last query that ran');
  assert.equal(h.state.treemap.matchTotal, 1, 'and its total, as when a separate parse came first');
  // A failure that is not a parse error clears what may be staged, as before.
  h.apply('size>2gb');
  await turns();
  await h.asks[2].fail(Object.assign(new Error('Scan is still running'), { code: 'SCAN_RUNNING', status: 409 }));
  assert.equal(h.state.treemap.matchTotal, null, 'a query that could not run has no total, and nothing to stage');
  assert.deepEqual(h.said[h.said.length - 1], { text: 'Scan is still running', isError: true });
});

test('G07 review F1.3: a run for new text takes the last text\'s parse error down at once — not when the new answer lands', async () => {
  const h = highlight();
  h.apply('size>1gb');
  await h.asks[0].answer(hits(['/r/big']));
  h.apply('size>');
  await turns();
  await h.asks[1].fail(Object.assign(new Error('A size needs a number after the operator.'), { code: 'QUERY_PARSE_ERROR', offset: 5, status: 400 }));
  assert.ok(h.input.classList.contains('badq') && !h.err.hidden, 'control: the parse error is under the box, and the box is marked invalid');
  h.apply('size>1mb'); // corrected; its answer may take seconds (a fact lookup)
  await turns();
  assert.equal(h.asks.length, 3);
  assert.equal(h.err.hidden, true, 'while the corrected text is asked, the error about the old text is gone');
  assert.equal(h.input.classList.contains('badq'), false, 'and the box is not marked invalid');
  assert.equal(h.input.getAttribute('aria-invalid'), 'false', 'nor said to be to a screen reader');
  const shown = (): string[] | null => (h.state.treemap.matchedPaths ? [...h.state.treemap.matchedPaths] : null);
  assert.deepEqual(shown(), ['/r/big'], 'the last highlights stay up until the answer');
  await h.asks[2].answer(hits(['/r/mid']));
  assert.deepEqual(shown(), ['/r/mid']);
});

test('G07: a newer query aborts the one still out, and the older answer never paints', async () => {
  const h = highlight(true);
  h.apply('size>1mb');
  await turns();
  h.apply('size>10mb');
  await turns();
  assert.equal(h.asks.length, 2);
  assert.equal(h.asks[0].signal?.aborted, true, 'the first request was aborted when the second was sent');
  assert.equal(h.asks[1].signal?.aborted, false);
  await h.asks[1].answer(hits(['/r/ten']));
  await h.asks[0].answer(hits(['/r/one', '/r/ten'])); // a server that answered anyway, late
  assert.deepEqual([...h.state.treemap.matchedPaths!], ['/r/ten'], 'only the newest ask\'s answer is on the map');
  assert.equal(h.painted(), 1, 'painted once, for the newest');
  assert.ok(!h.said.some((s) => /aborted/i.test(s.text)), 'an abort is not an error anyone is told about');
});

test('G07: a cancel — a keystroke, a clear, leaving the map — aborts the request still out', async () => {
  const h = highlight();
  h.apply('size>1mb');
  await turns();
  h.cancel();
  assert.equal(h.asks[0].signal?.aborted, true, 'aborted at once');
  await h.asks[0].answer(hits(['/r/a']));
  assert.equal(h.state.treemap.matchedPaths, null, 'its answer is not painted');
  // The box's input handler cancels on every keystroke, before it waits.
  const input = INDEX.slice(INDEX.indexOf("$('tmSearch').addEventListener('input'"), INDEX.indexOf('/* ── Autocomplete over the grammar'));
  assert.match(input, /^[^]*?tmCancelQueries\(\);[^]*?tmQueryDeb = setTimeout\(/, 'each keystroke stops what the last text asked, then waits');
});

test('G07: the box waits 90 ms after a keystroke before asking the server, where it waited 150', () => {
  const input = INDEX.slice(INDEX.indexOf("$('tmSearch').addEventListener('input'"), INDEX.indexOf('/* ── Autocomplete over the grammar'));
  assert.match(input, /tmQueryDeb = setTimeout\(\(\) => tmApplyQuery\(raw\), tmIsGrammarQuery\(raw\) \? TM_GRAMMAR_DEBOUNCE_MS : TM_BARE_DEBOUNCE_MS\);/);
  const grammar = Number(/const TM_GRAMMAR_DEBOUNCE_MS = (\d+);/.exec(INDEX)?.[1]);
  const bare = Number(/const TM_BARE_DEBOUNCE_MS = (\d+);/.exec(INDEX)?.[1]);
  assert.equal(grammar, 90, 'a grammar query: one request per pause, the request before it aborted');
  assert.equal(bare, 120, 'a bare word is matched in the page, as fast as it always was');
});

/* ── Global search ───────────────────────────────────────────────────────── */

function search(answersAnyway = false) {
  const server = heldServer(answersAnyway);
  const rendered: unknown[] = [];
  const panel = { innerHTML: '' };
  const gsearchSrc = /const gsearch = \{[^]*?\n\};/.exec(INDEX)?.[0];
  assert.ok(gsearchSrc, 'the search state object is in the built page');
  const deps: Record<string, unknown> = {
    api: server.api, $: () => panel, renderGsearch: (r: unknown) => { rendered.push(r); }, gsearchClose() {}, gsearchOpen() {},
    escapeHtml: (s: string) => s, clearTimeout, setTimeout,
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const page = new Function(...keys, `'use strict'; ${gsearchSrc}\n${constOf('GSEARCH_DEBOUNCE_MS')}\n${declOf('gsearchAbort')}\n${declOf('runGsearch')}\nreturn { run: runGsearch, gsearch };`)(
    ...keys.map((k) => deps[k]),
  ) as { run: (q: string) => Promise<void>; gsearch: { seq: number } };
  return { ...page, ...server, rendered, panel };
}

test('G07: a newer search aborts the one still out, and the older answer never paints', async () => {
  const h = search(true);
  void h.run('Mail');
  void h.run('Mailbox');
  await turns();
  assert.equal(h.asks.length, 2);
  assert.match(h.asks[1].url, /\/api\/search\?q=Mailbox&limit=50$/);
  assert.equal(h.asks[0].signal?.aborted, true, 'the first search was aborted when the second was sent');
  await h.asks[1].answer({ query: 'Mailbox', hits: [] });
  await h.asks[0].answer({ query: 'Mail', hits: [] });
  assert.deepEqual(h.rendered.map((r) => (r as { query: string }).query), ['Mailbox'], 'only the newest answer is rendered');
  assert.equal(h.panel.innerHTML, '', 'and the abort is not shown as an error');
});

test('G07: clearing the box aborts the search still out, and its answer never reopens the panel', async () => {
  const h = search();
  void h.run('Mail');
  await turns();
  void h.run('   ');
  assert.equal(h.asks[0].signal?.aborted, true);
  await h.asks[0].answer({ query: 'Mail', hits: [] });
  assert.deepEqual(h.rendered, [], 'nothing painted for text that is gone');
});

test('G07: the search box waits 90 ms after a keystroke, where it waited 140, and each keystroke stops the search before it', () => {
  assert.equal(Number(/const GSEARCH_DEBOUNCE_MS = (\d+);/.exec(INDEX)?.[1]), 90);
  const input = INDEX.slice(INDEX.indexOf("$('gsearch').addEventListener('input'"), INDEX.indexOf("$('gsearch').addEventListener('keydown'"));
  assert.match(input, /gsearchAbort\(\);[^]*?gsearch\.timer = setTimeout\(\(\) => void runGsearch\(value\), GSEARCH_DEBOUNCE_MS\);/);
});

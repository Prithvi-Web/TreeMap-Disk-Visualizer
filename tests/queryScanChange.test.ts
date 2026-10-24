import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-queryScanChange-data-');

import { INDEX } from './fixtures/liftFrontend';

/**
 * A highlight-box query belongs to the folder it was asked of (browser
 * re-check C11). The Calendar's day query from corpus survived a scan of
 * /Applications and dimmed the whole new map under "0 matches": a grammar
 * query's matches are the paths the server found in the OLD tree, and a bare
 * word judged against another folder's map is a filter nobody typed for it.
 *
 * A scan of another folder clears the box. A rescan of the same folder keeps
 * the query and asks it again of the new scan when the map is shown.
 *
 * The page's own tmApplyQuery, tmRunGrammarQuery, tmQueryScanChanged and
 * tmRejudgeQuery run here over a stubbed server.
 */

function matchingBrace(open: number): number {
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return i;
  }
  return assert.fail(`the block opening at ${open} never closes`);
}

/** The whole declaration of one named function, `async` included. */
function declOf(name: string): string {
  const m = new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`).exec(INDEX);
  assert.ok(m, `function ${name} exists in the built page`);
  const open = INDEX.indexOf(') {', m!.index) + 2;
  return INDEX.slice(m!.index, matchingBrace(open) + 1);
}

/** A one-line `const NAME = …;`. */
function constOf(name: string): string {
  const m = new RegExp(`const ${name} = [^\\n]*;`).exec(INDEX);
  assert.ok(m, `const ${name} exists in the built page`);
  return m![0];
}

const turns = async (n = 6): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function harness() {
  const asked: Array<{ url: string; body: { scanId?: string; q?: string } }> = [];
  const said: string[] = [];
  // Never marked invalid here: tmSetQueryMessage is the recording stub below (the run reads the mark, review F1.3).
  const box = { value: '', classList: { contains: (_c: string) => false } };
  const state = {
    scanId: 's1' as string | null, root: { path: '/corpus' } as { path: string } | null, view: 'treemap',
    treemap: {
      query: '', queryMode: 'bare', matchedPaths: null as Set<string> | null, matchTotal: null as number | null, matches: 0,
      rootPath: '/corpus',
    },
  };
  /** URLs whose answers are held until the test releases them (`held`). */
  const holding = new Set<string>();
  const held: Array<{ url: string; release: () => void }> = [];
  const api = async (url: string, opts?: { body?: string }) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    asked.push({ url, body });
    if (holding.has(url)) await new Promise<void>((release) => held.push({ url, release }));
    if (url === '/api/query/validate') return { ok: true };
    // Each scan's answer names the scan, so the matches say which tree they came from.
    // A degraded answer, so the query leaves a message up that a clear must take down.
    return {
      hits: [{ path: `${state.root!.path}/${body.scanId}-hit`, name: 'hit', size: 1, isDir: false, mtimeMs: 0 }], total: 1, truncated: false,
      degraded: [{ field: 'used', reason: 'Last-opened dates are not recorded on this volume.' }],
    };
  };
  const noop = () => {};
  /** How often the Stage offer was synced, and the map seeded with hits. */
  const calls = { stage: 0, seed: 0 };
  const deps: Record<string, unknown> = {
    state, api, $: (id: string) => (id === 'tmSearch' ? box : { hidden: true, value: '' }),
    tmSetQueryMessage: (text: string) => { said.push(text); },
    tmSyncStageButton: () => { calls.stage++; }, seedNodes: () => { calls.seed++; },
    tmStageable: () => null, formatCount: String, tmUndrawnMessage: () => '',
    isSun: () => false, isCells: () => false, renderSearchOverlay: noop, presentTreemap: noop, presentView: noop,
    presentSunburst: noop, presentCells: noop, renderCellsStatus: noop, clearTimeout, setTimeout,
  };
  const consts = ['TM_GRAMMAR_FIELDS', 'TM_GRAMMAR_RE', 'TM_FIELDLIKE_RE'].filter((n) => INDEX.includes(`const ${n} =`));
  const helpers = ['tmIsGrammarQuery', 'tmEditDistance', 'tmUnknownFieldHint'].filter((n) => new RegExp(`function ${n}\\s*\\(`).test(INDEX));
  const names = [...helpers, 'treeScanId', 'treeScanComing', 'tmCancelQueries', 'tmClearHits', 'tmRunGrammarQuery', 'tmApplyQuery', 'tmQueryScanChanged', 'tmRejudgeQuery'];
  const keys = Object.keys(deps);
  const src = `'use strict'; let tmQueryDeb = 0; let tmQuerySeq = 0; let tmQueryAbort = null; let tmLastHits = { q: '', paths: [], total: 0, truncated: false, stage: null };\n` +
    `${consts.map(constOf).join('\n')}\n${names.map(declOf).join('\n')}\n` +
    'return { apply: tmApplyQuery, scanChanged: tmQueryScanChanged, rejudge: tmRejudgeQuery };';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const page = new Function(...keys, src)(...keys.map((k) => deps[k])) as {
    apply: (q: string) => void; scanChanged: (scanId: string | null) => void; rejudge: () => void;
  };
  /** The query typed (or put in the box by the Calendar), as the page applies it. */
  const type = async (q: string) => { box.value = q; page.apply(q); await turns(); };
  /** A finished scan of `root`, announced as finishScan announces it. */
  const scanned = (scanId: string | null, root: string) => {
    state.scanId = scanId;
    state.root = { path: root };
    state.treemap.rootPath = root;
    page.scanChanged(scanId);
  };
  return { ...page, state, asked, said, box, type, scanned, holding, held, calls };
}

test('C11: a grammar query asked of one folder is cleared when a scan of another folder opens', async () => {
  const h = harness();
  await h.type('modified:2026-03-04 type:file'); // the Calendar's day query
  assert.equal(h.state.treemap.queryMode, 'grammar', 'control: the server answered it');
  assert.deepEqual([...h.state.treemap.matchedPaths!], ['/corpus/s1-hit'], 'control: with corpus\'s paths');
  assert.equal(h.said[h.said.length - 1], 'Last-opened dates are not recorded on this volume.', 'control: and its message is up');
  assert.equal(h.state.treemap.matchTotal, 1, 'control: and its total');

  h.scanned('s2', '/Applications');
  assert.equal(h.box.value, '', 'the box is emptied');
  assert.equal(h.state.treemap.query, '', 'no query is applied to the new map');
  assert.equal(h.state.treemap.matchedPaths, null, 'and no old tree\'s matches are left to dim it');
  assert.equal(h.state.treemap.queryMode, 'bare');
  assert.equal(h.state.treemap.matchTotal, null, 'the status line has no total to compare against');
  assert.equal(h.said[h.said.length - 1], '', 'and the query\'s message goes with it');
});

test('C11: a query still being answered when a scan of another folder opens lands nowhere — its answer, or its go-ahead, is the old folder\'s', async () => {
  // With the Treemap already on screen, finishScan's switchView does not
  // unmount it, so the scan announcement is the only thing that stops a
  // reply on its way: without it the old tree's matches land under the
  // emptied box and dim the new map.
  const query = async (url: string) => {
    const h = harness();
    h.holding.add(url);
    await h.type('size>1gb');
    assert.equal(h.held.length, 1, `control: ${url} was asked, and is still being answered`);
    assert.equal(h.state.treemap.matchedPaths, null, 'control: nothing has landed yet');
    h.scanned('s2', '/Applications');
    const before = { ...h.calls };
    h.held[0].release();
    await turns(12);
    return { h, before };
  };

  const answered = await query('/api/query');
  assert.deepEqual(
    { query: answered.h.state.treemap.query, mode: answered.h.state.treemap.queryMode, matched: answered.h.state.treemap.matchedPaths, total: answered.h.state.treemap.matchTotal },
    { query: '', mode: 'bare', matched: null, total: null },
    'the answer for /corpus is not put on the map of /Applications');
  assert.deepEqual(answered.h.calls, answered.before, 'nor its hits seeded, nor a Stage offer made of them');
  // There is no separate parse step left to give a go-ahead (design pass G07):
  // the one request above is the query's only one.
  assert.deepEqual(answered.h.asked.map((a) => a.url), ['/api/query'], 'one request, the query itself');
});

test('C11: a bare word asked of one folder is cleared too — judged against another folder\'s map, it is a filter nobody typed for it', async () => {
  const h = harness();
  await h.type('clip');
  assert.equal(h.state.treemap.query, 'clip', 'control');
  h.scanned('s2', '/Applications');
  assert.deepEqual({ box: h.box.value, query: h.state.treemap.query }, { box: '', query: '' });
});

test('C11: the instant paint of another folder from the saved index clears it as well', async () => {
  const h = harness();
  await h.type('size>1gb');
  h.scanned(null, '/Users/me/Movies'); // finishScan's index-first paint announces a scan of null
  assert.equal(h.state.treemap.query, '', 'the index tree is another folder\'s too');
});

test('C11: a rescan of the same folder keeps the query, and the map asks it again of the new scan', async () => {
  const h = harness();
  await h.type('size>1gb');
  h.scanned('s2', '/corpus');
  assert.deepEqual({ box: h.box.value, query: h.state.treemap.query, mode: h.state.treemap.queryMode },
    { box: 'size>1gb', query: 'size>1gb', mode: 'grammar' }, 'kept: it was asked of this folder');
  h.asked.length = 0;
  h.rejudge(); // the Treemap's mount
  await turns();
  const run = h.asked.find((a) => a.url === '/api/query');
  assert.ok(run, `the query was asked again: ${JSON.stringify(h.asked)}`);
  assert.equal(run.body.scanId, 's2', 'of the scan now on screen');
  assert.deepEqual([...h.state.treemap.matchedPaths!], ['/corpus/s2-hit'], 'and the highlights are that scan\'s');
});

test('C11: a query already answered by the scan on screen is not asked again on every visit to the map', async () => {
  const h = harness();
  await h.type('size>1gb');
  h.asked.length = 0;
  h.rejudge();
  await turns();
  assert.deepEqual(h.asked, [], 'no request: its matches are this scan\'s');
});

test('C11: the page wires both — every scan announcement reaches tmQueryScanChanged, and the Treemap\'s mount re-judges', () => {
  assert.match(INDEX, /subscribe\(TOPIC\.scan, tmQueryScanChanged\);/, 'subscribed to the scan topic');
  const at = INDEX.indexOf("id: 'treemap', label: 'Treemap'");
  assert.notEqual(at, -1, 'the Treemap view is registered');
  const mount = INDEX.slice(INDEX.indexOf('mount() {', at), INDEX.indexOf('unmount() {', at));
  // Once no scan is running, or while one runs if the unmount cleared the answer: asked of the tree's own scan, never the
  // running one, which answers 409 (review F2.5; coreScanFlow runs the mount, mapViewHunt's C21 test the cleared case).
  assert.match(mount, /loadTreemap\(state\.treemap\.rootPath\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*if \(!state\.scanning \|\| state\.treemap\.matchTotal === null\) tmRejudgeQuery\(\);/, 'the mount asks the query again after it loads the map');
});

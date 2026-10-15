import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The query box's "Stage matches", and the cart total it feeds (D60 = D34, D61).
 *
 * `size>1gb` matches the scanned folder itself, every big folder on the way
 * down, AND the big files inside them. "Stage N matches" put all of them in
 * the cart: on the QA corpus it staged the scanned folder, Videos and Archives
 * plus the files inside them, and the cart read "Reclaims 22.5 GB" from an
 * 8.8 GB scan, because the cart summed a folder and its own contents. The
 * button promised "Add 6 matched files". Only the capsule's item cap stopped a
 * cart commit of the whole scanned folder; a smaller folder would have gone
 * from one query click.
 *
 * What staging owes the user now: files only, unless the query itself asks for
 * folders (`type:dir`, `empty:yes`); never the scanned folder; never a path
 * inside another staged one; and a cart total that counts each byte once,
 * however the cart was filled.
 *
 * The functions run out of the built page with their globals stubbed, so the
 * pins are on behaviour; the cart is a real Set.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

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

/** Every `const NAME = …;` the given names need, so the real regexes ship with the functions. */
function constOf(name: string): string {
  const m = new RegExp(`const ${name} = [^\\n]*;`).exec(INDEX);
  assert.ok(m, `const ${name} exists in the built page`);
  return m![0];
}

type Hit = { path: string; name: string; size: number; isDir: boolean; mtimeMs: number };
const hit = (p: string, isDir: boolean, size = 2e9): Hit => ({ path: p, name: p.split('/').pop() || p, size, isDir, mtimeMs: 0 });

interface Btn { hidden: boolean; textContent: string; title: string }

/**
 * Run one grammar query through the real `tmRunGrammarQuery`, then press
 * Stage through the real `tmStageMatches`, all sharing one `tmLastHits` and a
 * real cart Set.
 */
async function queryThenStage(q: string, hits: Hit[], opts: { cart?: string[]; truncated?: boolean; total?: number } = {}) {
  const cart = new Set<string>(opts.cart || []);
  const toasts: { msg: string; kind?: string }[] = [];
  const button: Btn = { hidden: true, textContent: '', title: '' };
  const state = {
    scanId: 's1',
    root: { path: '/r' },
    cart,
    treemap: { matchedPaths: null as Set<string> | null, queryMode: 'bare', matchTotal: null as number | null, matches: hits.length, rootPath: '/r' },
  };
  const deps: Record<string, unknown> = {
    $: (id: string) => (id === 'tmStageMatches' ? button : { hidden: true, textContent: '', classList: { toggle() {}, contains: () => false }, setAttribute() {} }),
    state,
    api: async () => ({ hits, total: opts.total ?? hits.length, truncated: Boolean(opts.truncated), degraded: [] }),
    seedNodes: () => {},
    renderSearchOverlay: () => {},
    presentView: () => {},
    tmSetQueryMessage: () => {},
    tmUndrawnMessage: () => '',
    tmSyncQueryBar: () => {},
    saveCart: () => {},
    renderCart: async () => {},
    refreshCartButtons: () => {},
    cartPreviewInvalidated: () => {}, // no Preview is up here; tests/cartPreview.test.ts drives a real one
    toast: (msg: string, kind?: string) => { toasts.push({ msg, kind }); },
    formatCount: (n: number) => Number(n).toLocaleString('en-US'),
  };
  const helpers = ['tmParentPath', 'tmStageable'].filter((n) => new RegExp(`function ${n}\\s*\\(`).test(INDEX));
  const consts = ['TM_ASKS_FOR_DIRS_RE'].filter((n) => INDEX.includes(`const ${n} =`));
  const keys = Object.keys(deps);
  const src = `
    let tmLastHits = { q: '', paths: [], total: 0, truncated: false };
    let tmQuerySeq = 0;
    let tmQueryAbort = null;
    ${consts.map(constOf).join('\n')}
    ${helpers.map(declOf).join('\n')}
    ${declOf('tmSyncStageButton')}
    ${declOf('tmRunGrammarQuery')}
    ${declOf('tmStageMatches')}
    return { run: tmRunGrammarQuery, stage: tmStageMatches };`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const page = new Function(...keys, src)(...keys.map((k) => deps[k]));
  await page.run(q);
  const offered = { ...button };
  await page.stage();
  return { cart: [...cart], toasts, button: offered };
}

/* ══════════════════ D60: what Stage puts in the cart ══════════════════ */

test('size>1gb stages the big files — never the scanned folder, never the folders around them', async () => {
  const { cart } = await queryThenStage('size>1gb', [
    hit('/r', true, 9e9), hit('/r/V', true, 5e9), hit('/r/V/a.mov', false, 3e9), hit('/r/b.dmg', false, 2e9),
  ]);
  assert.ok(!cart.includes('/r'), 'the scanned folder itself is never staged from a query');
  assert.ok(!cart.includes('/r/V'), 'a folder the query happened to match is not staged when the query did not ask for folders');
  assert.deepEqual(cart.sort(), ['/r/V/a.mov', '/r/b.dmg'], 'exactly the matched files');
});

test('a query that asks for folders stages them, outermost only, and still never the scanned folder', async () => {
  const { cart } = await queryThenStage('type:dir size>1gb', [
    hit('/r', true), hit('/r/V', true), hit('/r/V/sub', true), hit('/r/W', true),
  ]);
  assert.ok(!cart.includes('/r'), 'type:dir is no licence to stage the scanned folder');
  assert.deepEqual(cart.sort(), ['/r/V', '/r/W'], '/r/V/sub goes with /r/V, so it is not staged a second time');
});

test('-type:dir is not a request for folders', async () => {
  const { cart } = await queryThenStage('-type:dir size>1gb', [hit('/r/V', true), hit('/r/a.mov', false)]);
  assert.deepEqual(cart, ['/r/a.mov']);
});

test('neither is type:dir inside a negated group: a query with -( … ) stages files only', async () => {
  const { cart } = await queryThenStage('-(type:dir name:x) size>1gb', [hit('/r/V', true), hit('/r/a.mov', false)]);
  assert.deepEqual(cart, ['/r/a.mov'], 'when in doubt, the narrower thing is staged');
});

test('the button offers what it will stage, by count and by noun', async () => {
  const { button } = await queryThenStage('size>1gb', [
    hit('/r', true), hit('/r/V', true), hit('/r/V/a.mov', false), hit('/r/b.dmg', false),
  ]);
  assert.equal(button.hidden, false);
  assert.match(button.textContent, /\b2\b/, `two files will be staged, so the button says 2: "${button.textContent}"`);
  assert.doesNotMatch(button.textContent, /\b4\b/, 'not the four hits, two of which it will not stage');
  assert.match(button.title, /2 matched files/, 'the title counts the files it adds');
});

test('the button says "items" when the query asked for folders', async () => {
  const { button } = await queryThenStage('type:dir', [hit('/r/V', true), hit('/r/W', true)]);
  assert.match(button.title, /2 matched items/);
  assert.doesNotMatch(button.title, /files/, 'folders are not files');
});

test('the toast says what was left out, and why', async () => {
  const { toasts } = await queryThenStage('size>1gb', [
    hit('/r', true), hit('/r/V', true), hit('/r/V/a.mov', false),
  ]);
  const msg = toasts.map((t) => t.msg).join(' | ');
  assert.match(msg, /Staged 1 file\b/, msg);
  assert.match(msg, /scanned folder/i, 'the scanned folder matched and was left out — said, not silently dropped');
  assert.match(msg, /1 matched folder/, 'and so was the folder');
  assert.match(msg, /type:dir/, 'with the way to stage folders on purpose');
});

/* ══════════════════ D61: the toast is sentences ══════════════════ */

test('"Staged 6 items Nothing has been deleted." — every sentence ends before the next starts', async () => {
  const { toasts } = await queryThenStage('size>1gb', [hit('/r/a.mov', false), hit('/r/b.mov', false)]);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].msg, /^Staged 2 files\. Nothing has been deleted\.$/, toasts[0].msg);
});

test('with items already staged and a truncated answer, each part is still its own sentence', async () => {
  const { toasts } = await queryThenStage('size>1gb', [hit('/r/a.mov', false), hit('/r/b.mov', false)], {
    cart: ['/r/a.mov'], truncated: true, total: 5000,
  });
  const msg = toasts[0].msg;
  assert.doesNotMatch(msg, /[a-z0-9] [A-Z]/, `a full stop before every new sentence: ${msg}`);
  assert.doesNotMatch(msg, /\.\./, 'and never two');
  assert.match(msg, /5,000/, 'the real total, formatted');
});

/* ══════════════════ D60: the cart counts each byte once ══════════════════ */

test('the cart total counts a folder and a file inside it once', () => {
  const sizes: Record<string, number> = { '/r/V': 100, '/r/V/a.mov': 60, '/r/b.dmg': 7 };
  const state = { cart: new Set(['/r/V', '/r/V/a.mov', '/r/b.dmg']) };
  const deps: Record<string, unknown> = {
    state,
    cartNode: (p: string) => (p in sizes ? { size: sizes[p] } : null),
  };
  const helpers = ['tmParentPath', 'tmCartRoots'].map(declOf).join('\n');
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const total = new Function(...keys, `${helpers}\n${declOf('cartTotalBytes')}\nreturn cartTotalBytes();`)(...keys.map((k) => deps[k]));
  assert.equal(total, 107, 'a.mov is inside V, so its 60 bytes are already in V’s 100');
});

/* ══════════════════ D31: the message under the box ══════════════════ */

/** The message the box shows for one /api/query answer. */
async function messageFor(answer: Record<string, unknown>): Promise<string> {
  const said: string[] = [];
  const state = {
    scanId: 's1', root: { path: '/r' }, cart: new Set<string>(),
    treemap: { matchedPaths: null, queryMode: 'bare', matchTotal: null, matches: 3, rootPath: '/r' },
  };
  const deps: Record<string, unknown> = {
    $: () => ({ hidden: true, classList: { contains: () => false } }), // the box is not marked invalid: no error is up
    state,
    api: async () => answer,
    seedNodes: () => {}, renderSearchOverlay: () => {}, presentView: () => {},
    tmSetQueryMessage: (text: string) => { said.push(text); },
    tmUndrawnMessage: () => 'undrawn',
    tmSyncStageButton: () => {},
    tmStageable: () => ({ paths: [], noun: 'file', root: false, folders: 0, nested: 0 }),
    tmClearHits: () => {},
    formatCount: (n: number) => Number(n).toLocaleString('en-US'),
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function(...keys, `let tmLastHits = null; let tmQuerySeq = 0; let tmQueryAbort = null;\n${declOf('tmRunGrammarQuery')}\nreturn tmRunGrammarQuery;`)(...keys.map((k) => deps[k]));
  await run('size>0');
  return said[said.length - 1];
}

const manyHits = (n: number) => Array.from({ length: n }, (_, i) => hit(`/r/f${i}`, false, n - i));

test('"Showing the 1000 biggest of 20000 matches." — the numbers are formatted', async () => {
  const msg = await messageFor({ hits: manyHits(1000), total: 465_602, truncated: true, degraded: [] });
  assert.equal(msg, 'Showing the 1,000 biggest of 465,602 matches.');
});

test('when the server stopped at its cap, the box says so rather than "the N biggest of M"', async () => {
  const reason = 'This query needs facts TreeMap looks up file by file, so it checked only the first 20,000 possible matches it came to.';
  const msg = await messageFor({
    hits: manyHits(1000), total: 20_000, truncated: true, degraded: [{ provider: 'capped', reason }],
  });
  assert.ok(msg.includes(reason), msg);
  assert.doesNotMatch(msg, /Showing the/, 'a capped count is not presented as the total');
});

/* ══════════════════ D37: two exports, two file names ══════════════════ */

/**
 * "CSV — all files" and "CSV — all folders" were both saved as
 * treemap-Library-20261002.csv: the server's Content-Disposition says
 * -files- / -folders-, but the page's `download` attribute wins, and it
 * ignored which one was asked for. The second export overwrote (or was renamed
 * beside) the first. Same for Excel.
 */
async function downloadName(format: string, mode?: string, at: { root: { path: string; name: string }; rootName: string } = { root: { path: '/r', name: 'Library' }, rootName: 'Library' }): Promise<string> {
  const anchors: { download?: string }[] = [];
  const doc = {
    createElement: () => { const a: any = { click() {}, remove() {} }; anchors.push(a); return a; },
    body: { appendChild() {} },
  };
  const deps: Record<string, unknown> = {
    state: { scanId: 's1', root: at.root, scanning: false, treemap: { rootName: at.rootName } },
    toast: () => {},
    api: async () => ({ status: 'complete' }),
    document: doc,
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function(...keys, `${declOf('exportFileName')}\n${declOf('downloadReport')}\nreturn downloadReport;`)(...keys.map((k) => deps[k]));
  await run(format, mode);
  assert.equal(anchors.length, 1, 'one download anchor');
  return String(anchors[0].download);
}

test('files and folders exports are saved under different names', async () => {
  const files = await downloadName('csv', 'files');
  const folders = await downloadName('csv', 'folders');
  assert.notEqual(files, folders, `${files} vs ${folders}`);
  assert.match(files, /^treemap-Library-files-\d{8}\.csv$/, files);
  assert.match(folders, /^treemap-Library-folders-\d{8}\.csv$/, folders);
  assert.match(await downloadName('xlsx', 'folders'), /-folders-\d{8}\.xlsx$/);
});

test('an export with no mode keeps the plain name', async () => {
  assert.match(await downloadName('pdf'), /^treemap-Library-\d{8}\.pdf$/);
});

/* ══════════════════ B32: a report is named for what it holds ══════════════════ */

test('B32: a report holds the whole scan, so it is named after the scanned folder — not the folder drilled into', async () => {
  // B32: drilled into corpus › Videos, "CSV — all files" saved
  // treemap-Videos-files-….csv holding all 101,034 corpus files; the server
  // names it treemap-corpus-files-….csv.
  const drilled = { root: { path: '/Users/x/corpus', name: 'corpus' }, rootName: 'Videos' };
  assert.match(await downloadName('csv', 'files', drilled), /^treemap-corpus-files-\d{8}\.csv$/, 'the CSV');
  assert.match(await downloadName('xlsx', 'folders', drilled), /^treemap-corpus-folders-\d{8}\.xlsx$/, 'the workbook');
  assert.match(await downloadName('pdf', undefined, drilled), /^treemap-corpus-\d{8}\.pdf$/, 'the PDF report');
});

test('B32: a picture of the map is still named after the folder on screen — that is what it shows', () => {
  const name = new Function('state', `${declOf('exportFileName')}\nreturn exportFileName;`)(
    { root: { path: '/Users/x/corpus', name: 'corpus' }, treemap: { rootName: 'Videos' } },
  ) as (ext: string, mode?: string) => string;
  assert.match(name('png'), /^treemap-Videos-\d{8}\.png$/);
  assert.match(name('svg'), /^treemap-Videos-\d{8}\.svg$/);
});

/* ══════════════════ D30: a field that is not one gets a hint ══════════════════ */

/**
 * `sise>1gb` (a typo) and `foo:bar` are filename searches by design: the box
 * sends a query to the grammar only when it names a REAL field, so that
 * `Screenshot (1).png` and `-hidden.txt` keep their plain meaning
 * (tmIsGrammarQuery). That routing stays. What changes is the silence: a bare
 * "0 matches" under a typed field reads as a broken filter, so when the search
 * finds nothing and the text has a word shaped like a field, the box names it,
 * says it is not a field, and offers the nearest real one.
 */
async function bareMessage(q: string, matches: number, view: 'treemap' | 'sunburst' = 'treemap'): Promise<{ said: string[]; routedToGrammar: boolean }> {
  const said: string[] = [];
  let routedToGrammar = false;
  // In the sunburst the count is whatever the last map left: a stale 0 here.
  const state = { treemap: { query: '', queryMode: 'grammar', matchedPaths: null, matchTotal: null, matches: view === 'sunburst' ? 0 : 99 } };
  const deps: Record<string, unknown> = {
    state,
    tmCancelQueries: () => {},
    tmClearHits: () => {},
    tmSetQueryMessage: (text: string) => { said.push(text); },
    // The grammar path is one request since design pass G07: routing to it is a run.
    tmRunGrammarQuery: async () => { routedToGrammar = true; },
    isSun: () => view === 'sunburst',
    isCells: () => false,
    renderSearchOverlay: () => { state.treemap.matches = matches; },
    presentTreemap: () => {},
    presentSunburst: () => {},
    presentCells: () => {},
    renderCellsStatus: () => {},
  };
  const consts = ['TM_GRAMMAR_FIELDS', 'TM_GRAMMAR_RE', 'TM_FIELDLIKE_RE'].filter((n) => INDEX.includes(`const ${n} =`));
  const helpers = ['tmIsGrammarQuery', 'tmEditDistance', 'tmUnknownFieldHint'].filter((n) => new RegExp(`function ${n}\\s*\\(`).test(INDEX));
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const apply = new Function(...keys, `${consts.map(constOf).join('\n')}\n${helpers.map(declOf).join('\n')}\n${declOf('tmApplyQuery')}\nreturn tmApplyQuery;`)(...keys.map((k) => deps[k]));
  apply(q);
  return { said, routedToGrammar };
}

test('a mistyped field that finds nothing names the word and offers the field meant', async () => {
  const { said, routedToGrammar } = await bareMessage('sise>1gb', 0);
  assert.equal(routedToGrammar, false, 'routing is unchanged: an unknown word is still a filename search');
  const msg = said[said.length - 1];
  assert.match(msg, /“sise” is not a query field/, msg);
  assert.match(msg, /did you mean “size”/, msg);
  assert.match(msg, /size, ext, name/, 'and lists the fields');
});

test('a word nowhere near a field still gets the list, without a guess', async () => {
  const { said } = await bareMessage('foo:bar', 0);
  const msg = said[said.length - 1];
  assert.match(msg, /“foo” is not a query field/, msg);
  assert.doesNotMatch(msg, /did you mean/, 'no suggestion that is not close');
});

test('a short word is only matched to a field one edit away', async () => {
  const re = (await bareMessage('re:invoice', 0)).said.pop()!;
  assert.match(re, /“re” is not a query field\./, re);
  assert.doesNotMatch(re, /did you mean/, '"re" is not a misspelt "in"');
  const ex = (await bareMessage('ex:mp4', 0)).said.pop()!;
  assert.match(ex, /did you mean “ext”/, ex);
});

test('a longer word is matched to a field two edits away', async () => {
  const msg = (await bareMessage('elswere:proven', 0)).said.pop()!;
  assert.match(msg, /did you mean “elsewhere”/, msg);
});

test('the sunburst, which counts no matches, never claims none were found', async () => {
  // presentSunburst draws no search highlight and leaves the match count as
  // the last map left it, so "no file name here contains" would be a guess.
  const { said } = await bareMessage('sise>1gb', 0, 'sunburst');
  assert.equal(said.filter(Boolean).length, 0, JSON.stringify(said));
});

test('a filename search that found something is left alone', async () => {
  const { said } = await bareMessage('re:invoice', 3);
  assert.equal(said.filter(Boolean).length, 0, `nothing to explain: ${JSON.stringify(said)}`);
});

test('ordinary filenames never get the hint', async () => {
  for (const q of ['Screenshot (1).png', '-hidden.txt', 'C:\\Users', '10:30 notes']) {
    const { said } = await bareMessage(q, 0);
    assert.equal(said.filter(Boolean).length, 0, `${q}: ${JSON.stringify(said)}`);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Track U, U-4, the page's half: the Empty Folders pane says why it offers
 * nothing (a gdu scan's `reason`) and how many folders it left out after looking
 * again (`withheld`) instead of "tidy already", and its Move to Trash asks the
 * server to look once more at each folder (`onlyEmptyFolders`), reporting a
 * folder that is no longer empty as that rather than as a failure.
 *
 * The functions run out of the built page with stubbed globals, as
 * tests/cleanUpModalHonesty.test.ts runs them, so the pins are on behaviour.
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

/** The body of one function declaration; `afterParams` finds the body's brace past a destructured parameter list. */
function bodyOf(header: string, afterParams = false): string {
  const start = INDEX.indexOf(header);
  assert.notEqual(start, -1, `"${header}" exists in the built page`);
  const open = afterParams ? INDEX.indexOf(') {', start) + 2 : INDEX.indexOf('{', start);
  return INDEX.slice(open + 1, matchingBrace(open));
}

function runnable(body: string, deps: Record<string, unknown>, args = ''): (...a: any[]) => any {
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...keys, `return async function (${args}) {${body}\n};`)(...keys.map((k) => deps[k]));
}

interface El { innerHTML: string; textContent: string; checked: boolean; disabled: boolean; hidden: boolean; style: Record<string, string>; classList: { add(c: string): void; remove(c: string): void } }
function makeDom() {
  const els: Record<string, El> = {};
  const $ = (id: string): El => (els[id] ||= {
    innerHTML: '', textContent: '', checked: false, disabled: false, hidden: false,
    style: {}, classList: { add() {}, remove() {} },
  });
  return { els, $ };
}

/* ─────────────── the pane ─────────────── */

/** The page's own whyLeftOut (U-4b review, L-5), out of the built page with the table it reads. */
function pageWhyLeftOut(formatCount: (n: number) => string): (by: unknown, withheld: number) => string {
  const tableAt = INDEX.indexOf('const WITHHELD_SAID = [');
  assert.notEqual(tableAt, -1, 'the reasons table is in the built page');
  const tableEnd = INDEX.indexOf('];', tableAt) + 2;
  const fnAt = INDEX.indexOf('function whyLeftOut(by, withheld) {');
  assert.notEqual(fnAt, -1, 'whyLeftOut is in the built page');
  const fnEnd = matchingBrace(INDEX.indexOf('{', fnAt)) + 1;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('formatCount', `${INDEX.slice(tableAt, tableEnd)}\n${INDEX.slice(fnAt, fnEnd)}\nreturn whyLeftOut;`)(formatCount);
}

/**
 * What the pane reads since the eighth browser pass (K04): the scan the tree on screen came from — the scan
 * `state` names, none running — and the sheet's bookkeeping for a tree no scan stands behind or another tree
 * come on screen, which these tests do not reach (tests/treeScanKey.test.ts drives those).
 */
const SHEET: Record<string, unknown> = {
  treeScanId: () => 's1',
  cleanAskAgain: () => assert.fail('no other tree came on screen'), cleanNoScanHtml: () => assert.fail('a scan stands behind the tree'),
};

async function renderPane(data: Record<string, unknown>): Promise<string> {
  const { els, $ } = makeDom();
  const fn = runnable(bodyOf('async function loadEmptyFolders() {'), {
    $,
    api: async () => data,
    state: { scanId: 's1' },
    skeletonRows: () => '',
    icon: () => '',
    escapeHtml: (s: string) => String(s).replace(/</g, '&lt;'),
    chipFor: () => '',
    formatCount: (n: number) => (n ?? 0).toLocaleString('en-US'),
    whyLeftOut: pageWhyLeftOut((n: number) => (n ?? 0).toLocaleString('en-US')),
    refreshCartButtons: () => {}, cartButtonHtml: () => '',
    updateCleanSummary: () => {},
    loadEmptyFoldersSeq: 0, // the page's own counter of loads (final review F1.8)
    ...SHEET,
  });
  await fn();
  return els.emptyResults.innerHTML;
}

const GDU_REASON = 'This scan ran on gdu, which shows a folder it could not read as an empty one, so TreeMap offers no empty folders from it.';

test('a scan that cannot tell empty from unread says so, and never claims the disk is tidy', async () => {
  const html = await renderPane({ folders: [], totalCount: 0, truncated: false, withheld: 0, reason: GDU_REASON });
  assert.ok(html.includes(GDU_REASON), 'the server\'s reason is on screen');
  assert.doesNotMatch(html, /tidy already/, 'an answer nobody could give is not "tidy"');
});

test('the reason is shown as text, never as markup', async () => {
  const html = await renderPane({ folders: [], totalCount: 0, truncated: false, withheld: 0, reason: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(html, /<img/, 'escaped');
});

test('folders left out after the second look are counted on the pane, beside what is offered', async () => {
  const html = await renderPane({
    folders: [{ name: 'a', path: '/r/a' }, { name: 'b', path: '/r/b' }], totalCount: 2, truncated: false, withheld: 3,
  });
  assert.match(html, /3 more/, 'how many were left out');
  assert.match(html, /left out/);
  assert.match(html, /class="empty-ck"/, 'and the offered folders are still listed');
});

test('the pane says why the folders it left out were left out, where the server says (U-4b review, L-5)', async () => {
  const html = await renderPane({
    folders: [{ name: 'a', path: '/r/a' }], totalCount: 1, truncated: false, withheld: 4,
    withheldBy: { content: 2, 'no-answer': 1, 'out-of-time': 1 },
  });
  assert.match(html, /4 more folders/);
  assert.match(html, /2 held something/);
  assert.match(html, /1 did not answer/);
  assert.match(html, /1 was not looked at before the 10 seconds TreeMap gives to looking ran out/);
  assert.doesNotMatch(html, /could not be read/, 'only the reasons that applied');
  const all = await renderPane({ folders: [], totalCount: 0, truncated: false, withheld: 1, withheldBy: { unreadable: 1 } });
  assert.match(all, /1 folder looked empty to the scan but was left out: looked at again, it could not be read\./);
});

test('when every candidate was left out the pane says that, not "tidy already"', async () => {
  const html = await renderPane({ folders: [], totalCount: 0, truncated: false, withheld: 2 });
  assert.match(html, /2 folders/);
  assert.match(html, /left out/);
  assert.doesNotMatch(html, /tidy already/);
});

test('an answer with nothing withheld and no reason is the pane it always was', async () => {
  assert.match(await renderPane({ folders: [], totalCount: 0, truncated: false, withheld: 0 }), /tidy already/);
  assert.match(await renderPane({ folders: [], totalCount: 0, truncated: false }), /tidy already/, 'an older server sends neither field');
  assert.doesNotMatch(await renderPane({ folders: [{ name: 'a', path: '/r/a' }], totalCount: 1, truncated: false, withheld: 0 }), /left out/);
});

/* ─────────────── loads that overlap (final review F1.8) ─────────────── */

/**
 * The page's loadEmptyFolders, every load's answer handed out by the test in
 * any order. Each answer waits for the server's second look on disk (U-4) —
 * up to 10 s on a slow drive — so toggling "ignore junk" twice inside that
 * starts two loads whose answers can arrive the other way round.
 */
function loadsByHand() {
  const { els, $ } = makeDom();
  const pending: Array<{ url: string; answer: (data: unknown) => void; fail: (err: Error) => void }> = [];
  const deps: Record<string, unknown> = {
    $,
    api: (url: string) => new Promise((resolve, reject) => { pending.push({ url, answer: resolve, fail: reject }); }),
    state: { scanId: 's1' },
    skeletonRows: () => '',
    icon: () => '',
    escapeHtml: (s: string) => String(s).replace(/</g, '&lt;'),
    chipFor: () => '',
    formatCount: (n: number) => (n ?? 0).toLocaleString('en-US'),
    whyLeftOut: pageWhyLeftOut((n: number) => (n ?? 0).toLocaleString('en-US')),
    refreshCartButtons: () => {}, cartButtonHtml: () => '',
    updateCleanSummary: () => {},
    loadEmptyFoldersSeq: 0,
    ...SHEET,
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const page = new Function(...keys, `let emptyFolders = []; return { load: async function () {${bodyOf('async function loadEmptyFolders() {')}\n}, folders: () => emptyFolders };`)(
    ...keys.map((k) => deps[k]),
  ) as { load: () => Promise<void>; folders: () => Array<{ path: string }> };
  return { pane: () => els.emptyResults.innerHTML, $, pending, ...page };
}

const listOf = (...paths: string[]) => ({ folders: paths.map((p) => ({ name: path.basename(p), path: p })), totalCount: paths.length, truncated: false, withheld: 0 });

test('a load answered after a newer one is dropped: the list is the one for the junk rule the box shows (final review F1.8)', async () => {
  const h = loadsByHand();
  h.$('emptyIgnoreJunk').checked = false;
  const older = h.load(); // "ignore junk" off
  h.$('emptyIgnoreJunk').checked = true;
  const newer = h.load(); // and on again, while the first is still looking
  h.pending[1].answer(listOf('/r/kept'));
  await newer;
  h.pending[0].answer(listOf('/r/junk-only-1', '/r/junk-only-2'));
  await older;
  assert.doesNotMatch(h.pane(), /junk-only/, 'the older answer does not paint over the newer');
  assert.deepEqual(h.folders().map((f) => f.path), ['/r/kept'], 'nor become the list Select all and the trash read');
});

test('a load that fails after a newer one answered does not replace the list with its error (final review F1.8)', async () => {
  const h = loadsByHand();
  const older = h.load();
  const newer = h.load();
  h.pending[1].answer(listOf('/r/kept'));
  await newer;
  h.pending[0].fail(new Error('the older look gave up'));
  await older;
  assert.doesNotMatch(h.pane(), /gave up/, 'the newer list stays');
  assert.match(h.pane(), /\/r\/kept/);
});

/* ─────────────── the selection, the request and the report ─────────────── */

test('the Empty Folders selection asks for the check; the other panes do not', async () => {
  const rows: Record<string, unknown[]> = {
    '#emptyResults .empty-ck': [{ checked: true, dataset: { i: '0' } }],
    '#cleanResults .clean-ck': [{ checked: true, dataset: { i: '0' } }],
  };
  const select = (cleanPane: string, junkRule = true) => runnable(bodyOf('function activeCleanSelection() {'), {
    document: { querySelectorAll: (sel: string) => rows[sel] || [] },
    $: (id: string) => ({ checked: id === 'emptyIgnoreJunk' ? junkRule : false }),
    cleanPane,
    cleanMatches: [{ path: '/r/f', size: 1 }],
    cleanOnDisk: new Map(), // nothing measured (fifth browser pass F09)
    emptyFolders: [{ name: 'a', path: '/r/a' }],
    smartGroups: [], packageOrphans: [],
  })();
  assert.equal((await select('empty')).onlyEmptyFolders, true);
  assert.equal((await select('rules')).onlyEmptyFolders, undefined);
  // U-4b L4: the junk rule the list was made with goes with it (the box reloads the list when it changes).
  assert.equal((await select('empty', true)).ignoreJunk, true);
  assert.equal((await select('empty', false)).ignoreJunk, false);
  assert.equal((await select('rules', false)).ignoreJunk, undefined, 'the other panes have no junk rule');
});

test('the delete request carries the check only when asked', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const fn = runnable(bodyOf('async function trashPaths(', true), {
    ensureNodes: async () => {},
    nodeFor: () => null,
    apiPaced: async (_url: string, opts: { body: string }) => {
      sent.push(JSON.parse(opts.body));
      return { deleted: [], failed: [] };
    },
    TRASH_CHUNK: 400,
    toast: () => {}, rescan: () => {}, reofferBlockedTrash: () => {}, formatBytes: () => '',
  }, 'paths, { silent = false, ignoreOpenHandles = false, onlyEmptyFolders = false, ignoreJunk = true } = {}');
  await fn(['/r/a'], { silent: true, onlyEmptyFolders: true });
  await fn(['/r/b'], { silent: true });
  await fn(['/r/c'], { silent: true, onlyEmptyFolders: true, ignoreJunk: false });
  assert.equal(sent[0].onlyEmptyFolders, true, 'asked for');
  assert.ok(!('onlyEmptyFolders' in sent[1]), 'and omitted, never sent as false, otherwise');
  assert.equal(sent[0].ignoreJunk, true, 'the junk rule rides with the check (U-4b L4)');
  assert.equal(sent[2].ignoreJunk, false, 'the pane\'s choice, as made');
  assert.ok(!('ignoreJunk' in sent[1]), 'and never without the check, which the server refuses');
});

interface TrashResult { deleted: string[]; failed: { path: string; reason: string; code?: string }[]; blocked?: string[] }

async function confirm(selection: Record<string, unknown>, result: TrashResult) {
  const { $ } = makeDom();
  const toasts: string[] = [];
  const calls: Array<Record<string, unknown>> = [];
  // The selection is the one the shared dialog was opened for (D53), handed in rather than re-read.
  const fn = runnable(bodyOf('async function runCleanTrash(selection, options) {'), {
    $,
    trashPaths: async (_chunk: string[], opts: Record<string, unknown>) => { calls.push(opts); return result; },
    closeModal: () => {},
    toast: (msg: string) => { toasts.push(msg); },
    formatBytes: (n: number) => `${n}B`,
    icon: () => '',
    REDUCED: true,
    rescan: () => {},
    cleanTrashing: false, // the page's own flag: a run holds the footer's button (review F2.1)
  }, 'selection, options');
  await fn({ bytes: 0, noun: 'empty folder', sizes: new Map(), ...selection }, {});
  return { toasts, calls };
}

test('Move to Trash from Empty Folders asks the server to look again at each folder', async () => {
  const { calls } = await confirm({ paths: ['/r/a'], onlyEmptyFolders: true }, { deleted: ['/r/a'], failed: [] });
  assert.equal(calls[0].onlyEmptyFolders, true);
  assert.equal(calls[0].silent, true, 'still silent: the run reports for itself');
  const other = await confirm({ paths: ['/r/f'] }, { deleted: ['/r/f'], failed: [] });
  assert.ok(!other.calls[0].onlyEmptyFolders, 'the other panes do not ask');
});

test('the junk rule of the list is the one the delete asks the server to use', async () => {
  const off = await confirm({ paths: ['/r/a'], onlyEmptyFolders: true, ignoreJunk: false }, { deleted: [], failed: [] });
  assert.equal(off.calls[0].ignoreJunk, false);
  const on = await confirm({ paths: ['/r/a'], onlyEmptyFolders: true, ignoreJunk: true }, { deleted: [], failed: [] });
  assert.equal(on.calls[0].ignoreJunk, true);
  const other = await confirm({ paths: ['/r/f'] }, { deleted: [], failed: [] });
  assert.ok(!('ignoreJunk' in other.calls[0]), 'the other panes send none');
});

test('each reason a folder was left where it is is said as itself, never as a failure (U-4b L4)', async () => {
  const { toasts } = await confirm({ paths: ['/r/a', '/r/b', '/r/c', '/r/d', '/r/e', '/r/f'], onlyEmptyFolders: true }, {
    deleted: [],
    failed: [
      { path: '/r/a', reason: 'it holds new.txt now', code: 'FOLDER_NOT_EMPTY' },
      { path: '/r/b', reason: 'the folder x inside it could not be read (EACCES)', code: 'FOLDER_UNREADABLE' },
      { path: '/r/c', reason: 'it did not answer within 2 seconds', code: 'FOLDER_NO_ANSWER' },
      { path: '/r/d', reason: 'the drive it is on did not answer a moment ago', code: 'FOLDER_NO_ANSWER' },
      { path: '/r/e', reason: 'it holds more than 1000 entries', code: 'FOLDER_TOO_MANY_ENTRIES' },
      { path: '/r/f', reason: 'it is not a folder any more', code: 'NOT_A_FOLDER' },
      { path: '/r/g', reason: 'the 10 seconds TreeMap gives to looking at folders again ran out', code: 'FOLDER_NOT_CHECKED' },
    ],
  });
  const said = toasts.join(' | ');
  // TreeMap's own 10 s ran out: said as that, never as a drive asleep or disconnected (U-4b review, L-5).
  const notChecked = toasts.find((m) => /^1 folder was not checked/.test(m)) ?? '';
  assert.match(notChecked, /10 seconds/, said);
  assert.doesNotMatch(notChecked, /asleep|disconnected|did not answer/);
  assert.ok(toasts.some((m) => /^1 folder is no longer empty/.test(m)), said);
  assert.ok(toasts.some((m) => /^1 folder could not be read/.test(m)), said);
  assert.ok(toasts.some((m) => /^No answer came in time for 2 folders/.test(m)), said);
  // No time is promised (the U-4c review, F1.4): a drive whose call never comes back stays silent until
  // it does, since asking again on a timer would hold one more thread of the I/O pool each time.
  const noAnswer = toasts.find((m) => /^No answer came in time/.test(m)) ?? '';
  assert.doesNotMatch(noAnswer, /minute|moment|second/, noAnswer);
  assert.match(noAnswer, /once the drive answers again, move them to the Trash again\.$/, noAnswer);
  assert.ok(toasts.some((m) => /^1 folder holds too much to look through/.test(m)), said);
  assert.ok(toasts.some((m) => /^1 item is no longer a folder/.test(m)), said);
  assert.ok(toasts.every((m) => /left where/.test(m)), `each says the folder is still there: ${said}`);
  assert.ok(!toasts.some((m) => /could not be trashed/.test(m)), 'none of them is a failure');
});

test('folders not asked because their drive still held two calls that had not answered are never said to have not answered themselves (the U-4c review, F3.2)', async () => {
  // FOLDER_NO_ANSWER and the pane's no-answer count cover two causes — the folder or its drive did not
  // answer, or TreeMap did not ask it, its drive holding two calls that had not answered — and the page,
  // which reads only the code, says what is true of both.
  const held = 'two earlier calls on the drive it is on have not answered yet, so TreeMap did not look at it and cannot tell that it is empty';
  const { toasts } = await confirm({ paths: ['/r/a', '/r/b', '/r/c'], onlyEmptyFolders: true }, {
    deleted: [],
    failed: ['/r/a', '/r/b', '/r/c'].map((p) => ({ path: p, reason: held, code: 'FOLDER_NO_ANSWER' })),
  });
  const said = toasts.join(' | ');
  assert.equal(toasts.length, 1, said);
  assert.match(toasts[0], /^No answer came in time for 3 folders — left where they are\./, said);
  assert.match(toasts[0], /or the drive was still waiting on earlier calls/, 'the cause in which TreeMap asked nothing is named');
  assert.doesNotMatch(toasts[0], /folders? did not answer/, 'never that the folders themselves did not answer');
  const pane = await renderPane({ folders: [], totalCount: 0, truncated: false, withheld: 3, withheldBy: { 'no-answer': 3 } });
  assert.match(pane, /3 did not answer or were on a drive still waiting on earlier calls/);
  const one = await renderPane({ folders: [], totalCount: 0, truncated: false, withheld: 1, withheldBy: { 'no-answer': 1 } });
  assert.match(one, /it did not answer or was on a drive still waiting on earlier calls/);
});

test('one folder that did not answer in time is said in the singular, every part of the sentence (final review F1.3)', async () => {
  // The most common case — one folder on a slow drive — was pinned only in the plural.
  const { toasts } = await confirm({ paths: ['/r/a'], onlyEmptyFolders: true }, {
    deleted: [],
    failed: [{ path: '/r/a', reason: 'it did not answer within 2 seconds, so TreeMap cannot tell that it is empty', code: 'FOLDER_NO_ANSWER' }],
  });
  assert.equal(toasts.length, 1, toasts.join(' | '));
  assert.match(
    toasts[0],
    /^No answer came in time for 1 folder — left where it is\. It or its drive did not answer, or the drive was still waiting on earlier calls\. .* move it to the Trash again\.$/,
  );
});

test('a folder that is no longer empty is reported as that, not as a failure', async () => {
  const { toasts } = await confirm({ paths: ['/r/a', '/r/b', '/r/c'], onlyEmptyFolders: true }, {
    deleted: ['/r/a'],
    failed: [
      { path: '/r/b', reason: 'it holds new.txt now, so it is not empty', code: 'FOLDER_NOT_EMPTY' },
      { path: '/r/c', reason: 'permission denied' },
    ],
  });
  assert.ok(toasts.some((m) => /1 folder/.test(m) && /no longer empty/.test(m)), `named as no longer empty (${toasts.join(' | ')})`);
  assert.ok(toasts.some((m) => /1 could not be trashed/.test(m)), 'the real failure is still its own line, counted once');
});

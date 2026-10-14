import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Clean Up modal — what the modal is allowed to claim.
 *
 * Both pins here are honesty pins, and both close the same shape of hole: a
 * number the UI already had was printed in place of a number it did not have.
 *
 *   1. **The empty-folder count.** `GET /api/empty-folders` caps `folders` at
 *      the topmost 1,000 and reports the real figure separately in
 *      `totalCount`, with `truncated` saying the cap was hit. Printing
 *      `folders.length` as "N top-level empty folders" states a cap as a fact,
 *      and Select all only ever ticks what was sent — so a user reading
 *      "Select all — 1,000 empty folders" on a disk holding 40,000 of them is
 *      told a wrong total AND left with no idea the rest exist. The rest of
 *      the app already says "largest shown" and "N more staged, not listed
 *      here"; this pane has to say it too.
 *
 *   2. **The completion report.** `trashPaths` diverts an entire chunk that
 *      comes back OPEN_HANDLE_CONFLICT into a THIRD bucket, `result.blocked` —
 *      deliberately in neither `deleted` nor `failed`, because those files are
 *      still on disk and the user can retry them. A completion path that reads
 *      only `deleted` and `failed` loses those files silently, stalls its own
 *      progress bar short of 100%, and — quoting the byte total computed
 *      before the deletes ran — credits the user with space that was never
 *      freed. What is reported must be what actually happened.
 *
 * Both are asserted by running the real functions out of the built page with
 * stubbed globals, so the pins are on behaviour, not on wording that a
 * rewrite would legitimately change.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** Index of the `}` matching the `{` at `open`. */
function matchingBrace(open: number): number {
  let depth = 0;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return i;
  }
  return assert.fail(`the block opening at ${open} never closes`);
}

/** The body of one function declaration, header text in, statements out. */
function bodyOf(header: string): string {
  const start = INDEX.indexOf(header);
  assert.notEqual(start, -1, `"${header}" exists in the built page`);
  const open = INDEX.indexOf('{', start);
  return INDEX.slice(open + 1, matchingBrace(open));
}

/**
 * Run a slice of app source in Node with every global it touches passed in as
 * a parameter, which is what makes them stubbable at all — the app declares
 * these as top-level `function`s and `let`s in one shared scope.
 */
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

/* ══════════════════ 1. Empty Folders: the cap is not the count ══════════════════ */

const EMPTY_HEADER = 'async function loadEmptyFolders() {';

/** Render the pane against one API payload and hand back the Select-all label. */
async function renderEmptyPane(data: { folders: { name: string; path: string }[]; totalCount: number; truncated: boolean }) {
  const { els, $ } = makeDom();
  const fn = runnable(bodyOf(EMPTY_HEADER), {
    $,
    api: async () => data,
    state: { scanId: 's1' },
    skeletonRows: () => '',
    icon: () => '',
    escapeHtml: (s: string) => s,
    chipFor: () => '',
    formatCount: (n: number) => (n ?? 0).toLocaleString('en-US'),
    refreshCartButtons: () => {}, cartButtonHtml: () => '',
    updateCleanSummary: () => {},
    loadEmptyFoldersSeq: 0, // the page's own counter of loads (final review F1.8)
  });
  await fn();
  const html = els.emptyResults.innerHTML;
  const label = /<label[^>]*for="emptyAll"[^>]*>([\s\S]*?)<\/label>/.exec(html);
  assert.ok(label, 'the pane renders a Select-all label');
  return label![1];
}

function folders(n: number) {
  return Array.from({ length: n }, (_, i) => ({ name: `e${i}`, path: `/r/e${i}` }));
}

test('a capped empty-folder list never prints its cap as the number found', async () => {
  // 1,000 sent, 4,321 found. The old label read "Select all — 1000 top-level
  // empty folders (4,321 counting nested ones)", which is two wrong claims at
  // once: 1,000 is the cap, not a count, and the parenthetical made the real
  // figure look like a superset of a complete list rather than the only number
  // on the row that was measured.
  const label = await renderEmptyPane({ folders: folders(1000), totalCount: 4321, truncated: true });

  assert.ok(label.includes('4,321'), 'the number actually found is on screen');
  assert.doesNotMatch(label, /1,?000 top-level empty folders/,
    'the capped length is never stated as the count of empty folders');
  assert.match(label, /shown/i, 'the list says it is a partial view');
  assert.match(label, /only/i, 'and says Select all reaches only what is listed');
});

test('an uncapped list still states both the top-level and the nested figure', async () => {
  const label = await renderEmptyPane({ folders: folders(2), totalCount: 3, truncated: false });
  assert.match(label, /2 top-level empty folders/, 'what the list holds');
  assert.match(label, /3 counting nested ones/, 'and what removing them takes with it');
  assert.doesNotMatch(label, /shown/i, 'nothing was withheld, so nothing claims it was');
});

test('when the two figures agree the row does not invent a second one', async () => {
  const label = await renderEmptyPane({ folders: folders(2), totalCount: 2, truncated: false });
  assert.match(label, /2 top-level empty folders/);
  assert.doesNotMatch(label, /counting nested/, 'no parenthetical when it would repeat the same number');
});

/* ══════════════════ 2. The selection carries per-path sizes ══════════════════ */

const SELECTION_HEADER = 'function activeCleanSelection() {';

function ck(i: number, checked = true) { return { checked, dataset: { i: String(i) } }; }

test('the selection reports a size per path, not just one total', async () => {
  // The completion path can only report what was really recovered if it can
  // look up the size of each path that came back deleted — a single total
  // cannot be un-summed once a chunk is refused.
  const rows: Record<string, unknown[]> = { '#cleanResults .clean-ck': [ck(0), ck(1)] };
  const fn = runnable(bodyOf(SELECTION_HEADER), {
    document: { querySelectorAll: (sel: string) => rows[sel] || [] },
    cleanPane: 'rules',
    cleanMatches: [{ path: '/a', size: 100 }, { path: '/b', size: 200 }],
    emptyFolders: [], smartGroups: [], packageOrphans: [],
  });
  const sel = await fn();
  assert.ok(sel.sizes instanceof Map, 'sizes is a path → bytes map');
  assert.equal(sel.sizes.get('/a'), 100);
  assert.equal(sel.sizes.get('/b'), 200);
  assert.equal([...sel.sizes.values()].reduce((s: number, v: number) => s + v, 0), sel.bytes,
    'the map and the headline total are the same measurement');
});

test('a path offered by two smart sources is one entry, sized once', async () => {
  const rows: Record<string, unknown[]> = {
    '#smartResults .smart-ck': [{ checked: true, dataset: { g: '0', i: '0' } }],
    '#packageOrphans .pkg-ck': [ck(0)],
    '#browserProfiles .bp-ck': [],
  };
  const fn = runnable(bodyOf(SELECTION_HEADER), {
    document: { querySelectorAll: (sel: string) => rows[sel] || [] },
    cleanPane: 'smart',
    cleanMatches: [], emptyFolders: [],
    smartGroups: [{ items: [{ path: '/dup', size: 500 }] }],
    packageOrphans: [{ path: '/dup', size: 500 }],
  });
  const sel = await fn();
  assert.deepEqual(sel.paths, ['/dup']);
  assert.equal(sel.bytes, 500, 'counted once');
  assert.equal(sel.sizes.size, 1, 'and sized once');
});

/* ══════════════════ 3. The completion report ══════════════════ */

/**
 * The run that follows a confirmed Move to Trash. It is handed the selection
 * the dialog was opened for, and the dialog's own answer about open files —
 * it never reads the panes again once the user has said yes (D53).
 */
const CONFIRM_NAMED = 'async function runCleanTrash(selection, options) {';

interface TrashResult { deleted: string[]; failed: { path: string; reason: string }[]; blocked?: string[] }

/** Run the confirmed Move-to-Trash against one canned `trashPaths` outcome. */
async function runConfirm(sel: { paths: string[]; sizes: Map<string, number> }, result: TrashResult) {
  const body = bodyOf(CONFIRM_NAMED);
  const { els, $ } = makeDom();
  const toasts: { msg: string; kind?: string }[] = [];
  const trashed: string[][] = [];
  let rescans = 0;
  const bytes = [...sel.sizes.values()].reduce((s, v) => s + v, 0);
  const fn = runnable(body, {
    $,
    trashPaths: async (chunk: string[]) => { trashed.push(chunk); return result; },
    closeModal: () => {},
    toast: (msg: string, kind?: string) => { toasts.push({ msg, kind }); },
    formatBytes: (n: number) => `${n}B`,
    icon: () => '',
    REDUCED: true,
    rescan: () => { rescans++; },
  }, 'selection, options');
  await fn({ ...sel, bytes, noun: 'item' }, {});
  return { toasts, trashed, rescans, els, bytes };
}

const SIZES = new Map([['/a', 100], ['/b', 200], ['/c', 400]]);
const PATHS = ['/a', '/b', '/c'];

test('a blocked chunk is counted, named as still in use, and never billed as recovered', async () => {
  // trashPaths puts an OPEN_HANDLE_CONFLICT chunk in `blocked`: not deleted,
  // not failed, still on disk. Reading only the first two buckets loses the
  // file from the report entirely.
  const { toasts, els, rescans } = await runConfirm(
    { paths: PATHS, sizes: SIZES },
    { deleted: ['/a'], failed: [{ path: '/b', reason: 'permission denied' }], blocked: ['/c'] },
  );

  const moved = toasts.find((t) => /Moved/.test(t.msg));
  assert.ok(moved, 'the one file that really moved is reported');
  assert.ok(moved!.msg.includes('100B'),
    'and the space reported is the space its deletion freed');
  assert.ok(!moved!.msg.includes('700B'),
    'never the pre-computed total of everything that was selected — 600B of it is still on disk');

  assert.ok(toasts.some((t) => /in use/i.test(t.msg) && /\b1\b/.test(t.msg)),
    'the blocked file is named as in-use and skipped, not dropped from the report');
  assert.ok(toasts.some((t) => /1 could not be trashed/.test(t.msg)), 'the failure is still its own line');
  assert.equal(els.cleanProgressFill.style.width, '100%',
    'the bar finishes: blocked paths are accounted for, so it cannot stall at 67%');
  assert.equal(rescans, 1, 'something moved, so the tree is re-read');
});

test('when every chunk is blocked, nothing is claimed to have moved', async () => {
  const { toasts, els, rescans } = await runConfirm(
    { paths: PATHS, sizes: SIZES },
    { deleted: [], failed: [], blocked: PATHS },
  );
  assert.ok(!toasts.some((t) => /Moved/.test(t.msg)), 'no move happened, so no move is reported');
  assert.ok(!toasts.some((t) => /recovered/.test(t.msg)), 'and no bytes are credited');
  assert.ok(toasts.some((t) => /in use/i.test(t.msg) && /\b3\b/.test(t.msg)), 'all three are named as skipped');
  assert.equal(rescans, 0, 'nothing changed on disk, so nothing is rescanned');
  assert.equal(els.cleanProgressFill.style.width, '100%', 'the run is over and the bar says so');
});

test('a clean run still reports the full recovered figure', async () => {
  // The fix must not overcorrect into never quoting bytes: when everything
  // selected really was deleted, the sum of the deleted sizes IS the total.
  const { toasts } = await runConfirm(
    { paths: PATHS, sizes: SIZES },
    { deleted: PATHS, failed: [] },
  );
  const moved = toasts.find((t) => /Moved/.test(t.msg));
  assert.ok(moved && moved.msg.includes('700B'), 'all three moved, all three counted');
  assert.ok(!toasts.some((t) => /in use/i.test(t.msg)), 'nothing was blocked, so nothing says it was');
});

/* ═══════ 3. "still working" is an answer, and must not be dressed as a failure ═══════ */

/**
 * The Clean Up rule search is the one place a 202 reaches a caller as an
 * exception rather than as a payload.
 *
 * `GET /api/cleanup/rules` answers 202 `{status:'running'}` while the scan is
 * still going, and `api()` turns exactly that body into a throw carrying
 * `err.stillWorking = true`. That is not an error, and the app knows it: the
 * single place an error becomes something a user sees, `reportError`, checks
 * that flag and shows the sentence plainly rather than in red — the same
 * treatment it gives a capability this machine does not have.
 *
 * `runCleanFind` bypassed it with a bare `toast(e.message, 'error')`, so
 * pressing Find during a rescan turned "Still working on that — it hasn't
 * finished yet" into a red failure, for a request that had not failed and
 * would succeed a second later.
 *
 * The pin is on the CHANNEL, not the wording: whatever the sentence says, a
 * still-working answer may not arrive on the error channel, and a real failure
 * still must.
 */
async function findWith(rejection: Error): Promise<{ msg: string; kind: string }[]> {
  const { $ } = makeDom();
  const shown: { msg: string; kind: string }[] = [];
  const toast = (msg: string, kind = 'info') => { shown.push({ msg, kind }); };
  // The real reportError out of the built page, so this exercises the whole
  // path rather than a test-local idea of what it does.
  const reportError = runnable(bodyOf('function reportError(err, context) {'), { toast }, 'err, context');
  const fn = runnable(bodyOf('async function runCleanFind(fetcher) {'), {
    $, toast, reportError,
    seedNodes: () => {},
    icon: () => '',
  }, 'fetcher');
  await fn(async () => { throw rejection; });
  return shown;
}

test('a scan still running is reported as an answer, not as a red failure', async () => {
  const pending = Object.assign(new Error('Still working on that — it hasn’t finished yet. Try again in a moment.'), {
    code: 'PENDING', status: 202, stillWorking: true,
  });
  const shown = await findWith(pending);
  assert.equal(shown.length, 1, 'the user is told something');
  assert.notEqual(shown[0].kind, 'error', `"still working" must not be shown as an error: ${JSON.stringify(shown[0])}`);
  assert.match(shown[0].msg, /still working/i, 'and the sentence is the one the API layer wrote');
});

test('a capability this machine lacks is not a failure either', async () => {
  const unavailable = Object.assign(new Error('This needs mdls, which is not installed.'), {
    code: 'CAPABILITY_UNAVAILABLE', capabilityUnavailable: true,
  });
  const shown = await findWith(unavailable);
  assert.equal(shown.length, 1);
  assert.notEqual(shown[0].kind, 'error', 'an honest "cannot do that here" is an answer');
});

test('a real failure is still red', async () => {
  const shown = await findWith(Object.assign(new Error('The server answered 500.'), { code: 'HTTP_500', status: 500 }));
  assert.equal(shown.length, 1);
  assert.equal(shown[0].kind, 'error', 'a failure that IS a failure must not be softened');
});

/* ═══════ 4. Move to Trash asks first, in the dialog every other view uses (D53) ═══════ */

/**
 * Clean Up's "Move N to Trash" used to be bound straight to the run: one click
 * trashed every ticked row — and every pane opens with its rows ticked — with
 * no dialog at all, while the pane's own copy said "Nothing is removed until
 * you confirm" and the shared dialog's markup said no view can delete without
 * it. The run also passed `silent`, which turns off trashPaths' own re-ask, so
 * the open-file check (B2) never ran either.
 *
 * Pinned here by running the real pieces together: whatever function the
 * button is bound to, the real `confirmTrash` out of the built page, and the
 * real run — sharing the one `onConfirmTrash` the app's OK button reads. Only
 * the edges are stubbed, and `trashPaths` records rather than deletes.
 */

/** The whole declaration of one named function, `async` included, header to closing brace. */
function declOf(name: string): string {
  const m = new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`).exec(INDEX);
  assert.ok(m, `function ${name} exists in the built page`);
  const open = INDEX.indexOf(') {', m!.index) + 2;
  return INDEX.slice(m!.index, matchingBrace(open) + 1);
}

/** The name of the function the Move to Trash button runs. */
function cleanTrashHandler(): string {
  const m = /\$\('cleanConfirmBtn'\)\.addEventListener\('click',\s*([A-Za-z_$][\w$]*)\)/.exec(INDEX);
  assert.ok(m, 'the Move to Trash button is bound to a named function');
  return m![1];
}

type Sel = { paths: string[]; sizes: Map<string, number>; bytes: number; noun: string };
function sel(paths: string[]): Sel {
  return { paths, sizes: new Map(paths.map((p) => [p, 100])), bytes: 100 * paths.length, noun: 'item' };
}

/** A DOM whose class lists remember, so "the dialog is open" can be read back. */
function classDom() {
  const els: Record<string, El & { classes: Set<string> }> = {};
  const $ = (id: string) => (els[id] ||= (() => {
    const classes = new Set<string>();
    return {
      innerHTML: '', textContent: '', checked: false, disabled: false, hidden: false, style: {}, classes,
      classList: { add: (c: string) => { classes.add(c); }, remove: (c: string) => { classes.delete(c); } },
    };
  })());
  return { els, $ };
}

function cleanUpHarness(opts: { cloud?: boolean } = {}) {
  const { els, $ } = classDom();
  let selection = sel(opts.cloud ? ['cloud://drive/a', 'cloud://drive/b'] : ['/r/a', '/r/b', '/r/c']);
  const trashCalls: { paths: string[]; opts: Record<string, unknown> }[] = [];
  const cloudCalls: string[][] = [];
  const preflights: string[][] = [];
  const handler = cleanTrashHandler();
  const deps: Record<string, unknown> = {
    $,
    activeCleanSelection: () => selection,
    isCloudScan: () => Boolean(opts.cloud),
    trashPaths: async (paths: string[], o: Record<string, unknown>) => {
      trashCalls.push({ paths: [...paths], opts: o });
      return { deleted: [...paths], failed: [] };
    },
    cloudTrashPaths: async (paths: string[]) => { cloudCalls.push([...paths]); },
    checkOpenHandlesFor: async (paths: string[]) => { preflights.push([...paths]); },
    resetOpenHandleWarning: () => {},
    ensureNodes: async () => {},
    nodeFor: () => ({ name: 'x', size: 100 }),
    cloudProviderOfScan: () => ({ name: 'Drive', trashLabel: 'its trash' }),
    escapeHtml: (s: string) => s,
    icon: () => '',
    formatBytes: (n: number) => `${n}B`,
    closeModal: () => {},
    toast: () => {},
    REDUCED: true,
    rescan: () => {},
  };
  const keys = Object.keys(deps);
  // One scope, so the three functions share `onConfirmTrash` and
  // `confirmPaths` exactly as they do in the page.
  const src = `
    let onConfirmTrash = null;
    let confirmPaths = [];
    ${declOf('tmParentPath')}
    ${declOf('outermostPaths')}
    ${declOf('confirmTrash')}
    ${declOf('runCleanTrash')}
    ${handler === 'runCleanTrash' ? '' : declOf(handler)}
    return {
      click: () => ${handler}(),
      callback: () => onConfirmTrash,
      confirmTrash,
    };`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const page = new Function(...keys, src)(...keys.map((k) => deps[k]));
  return {
    page, els, $, trashCalls, cloudCalls, preflights,
    reselect(paths: string[]) { selection = sel(paths); },
    dialogOpen: () => $('confirmModal').classes.has('open'),
    closeDialog: () => { $('confirmModal').classes.delete('open'); },
  };
}

test('Move to Trash opens the shared "Move to Trash?" dialog and trashes nothing on the click', async () => {
  const h = cleanUpHarness();
  await h.page.click();
  assert.equal(h.trashCalls.length, 0, 'a click must not trash anything — the user has not confirmed yet');
  assert.ok(h.dialogOpen(), 'the shared confirmation dialog is open');
  assert.match(h.els.confirmTitle.innerHTML, /Move to Trash\?/, 'and it is the one every other view uses');
  assert.match(h.els.confirmText.innerHTML, /3 items/, 'naming what is about to go');
  assert.deepEqual(h.preflights, [['/r/a', '/r/b', '/r/c']], 'the open-file check (B2) runs for exactly that selection');
});

test('cancelling the dialog deletes nothing, and a later dialog cannot fire the cancelled delete', async () => {
  const h = cleanUpHarness();
  await h.page.click();
  h.closeDialog(); // Cancel, ×, the scrim and Escape all just close it
  assert.equal(h.trashCalls.length, 0, 'nothing was trashed');
  // The next view to ask (Duplicates, Grid, right-click…) goes through
  // confirmTrash, which must leave no trace of the Clean Up callback behind.
  await h.page.confirmTrash(['/elsewhere/z']);
  assert.equal(h.page.callback(), null, 'the cancelled Clean Up delete is gone, not waiting on the next OK');
  assert.equal(h.trashCalls.length, 0, 'still nothing trashed');
});

test('OK trashes exactly what the dialog showed, and carries "Delete anyway" through', async () => {
  const h = cleanUpHarness();
  await h.page.click();
  // A pane that finishes loading behind the dialog must not widen the delete.
  h.reselect(['/r/a', '/r/b', '/r/c', '/r/late-arrival']);
  const ok = h.page.callback();
  assert.equal(typeof ok, 'function', 'OK runs the Clean Up delete');
  await ok({ ignoreOpenHandles: true });
  assert.equal(h.trashCalls.length, 1);
  assert.deepEqual(h.trashCalls[0].paths, ['/r/a', '/r/b', '/r/c'], 'the selection the dialog was opened for, and nothing else');
  assert.equal(h.trashCalls[0].opts.ignoreOpenHandles, true,
    'the user\'s "Delete anyway" reaches the server — dropped, the server refuses the same batch for ever');
  assert.equal(h.trashCalls[0].opts.silent, true, 'the run still reports for itself');
});

test('without "Delete anyway" the open-file guard stays on', async () => {
  const h = cleanUpHarness();
  await h.page.click();
  const ok = h.page.callback();
  assert.equal(typeof ok, 'function', 'OK runs the Clean Up delete');
  await ok({ ignoreOpenHandles: false });
  assert.equal(h.trashCalls.length, 1);
  assert.ok(!h.trashCalls[0].opts.ignoreOpenHandles, 'no override was chosen, so none is sent');
});

test('a cloud scan keeps the dialog\'s own cloud delete: its files go to the provider\'s trash', async () => {
  const h = cleanUpHarness({ cloud: true });
  await h.page.click();
  assert.ok(h.dialogOpen(), 'the dialog still asks first');
  const ok = h.page.callback();
  assert.equal(typeof ok, 'function', 'OK runs a delete');
  await ok({});
  assert.equal(h.trashCalls.length, 0, 'a cloud path is never sent to the local Trash route');
  assert.deepEqual(h.cloudCalls, [['cloud://drive/a', 'cloud://drive/b']]);
});

/**
 * The Clean Up sheet's tabs, from the page's own setCleanPane, the footer's
 * summary and button (activeCleanSelection, updateCleanSummary) and its click
 * (confirmCleanTrash), in one scope over stubs: a Smart Suggestions row is
 * ticked — 5 GB of node_modules — and the Smart pane, when another tab shows,
 * is only hidden, its ticks still in the page.
 */
function cleanPanes() {
  const { els, $ } = classDom();
  const tabs = ['rules', 'smart', 'empty', 'video', 'cloud'].map((pane) => ({ dataset: { pane }, setAttribute() {} }));
  Object.assign($('cleanSeg'), { querySelectorAll: () => tabs });
  const rows: Record<string, unknown[]> = {
    '#smartResults .smart-ck': [{ checked: true, dataset: { g: '0', i: '0' } }],
    '#packageOrphans .pkg-ck': [], '#browserProfiles .bp-ck': [],
  };
  const confirmed: string[][] = [];
  const deps: Record<string, unknown> = {
    $, document: { querySelectorAll: (q: string) => rows[q] || [] },
    cleanMatches: [], emptyFolders: [], packageOrphans: [], videoCandidates: [{ path: '/r/v.mov' }],
    smartGroups: [{ items: [{ path: '/r/node_modules', size: 5_000_000_000 }] }],
    loadEmptyFolders: () => {}, loadSmartSuggestions: () => {}, loadVideoCandidates: () => {}, renderCleanFunnel: () => {},
    isCloudScan: () => false, cloudProviderOfScan: () => assert.fail('a local scan has no provider'), escapeHtml: String,
    icon: () => '', formatBytes: (n: number) => `${n} B`,
    confirmTrash: async (paths: string[]) => { confirmed.push([...paths]); },
    runCleanTrash: async () => assert.fail('nothing was confirmed'),
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const page = new Function(...keys, `let cleanPane = 'rules'; let onConfirmTrash = null;
    ${['setCleanPane', 'activeCleanSelection', 'updateCleanSummary', 'confirmCleanTrash'].map(declOf).join('\n')}
    return { show: setCleanPane, click: confirmCleanTrash };`)(...keys.map((k) => deps[k]));
  const footer = () => ({ summary: els.cleanSummary.textContent, disabled: els.cleanConfirmBtn.disabled, label: els.cleanConfirmBtn.innerHTML });
  return { page, footer, confirmed };
}

test('the Clean Up footer\'s Move to Trash belongs to the pane on screen: Shrink Video and Cloud-safe offer nothing ticked on Smart Suggestions (review F2.6 of QA third pass D03)', async () => {
  // Smart Suggestions, a row ticked, then the Shrink Video tab: the footer
  // read "1 item · up to 5 GB, freed when you empty the Trash" beside an
  // enabled "Move 1 to Trash", and its click opened the Trash sheet for a
  // row the pane on screen does not show — D03's flaw inside the sheet.
  const h = cleanPanes();
  h.page.show('smart');
  assert.match(h.footer().summary, /^1 item · up to 5000000000 B/, 'control: the tick is real, and the Smart pane offers it');
  assert.equal(h.footer().disabled, false);
  assert.match(h.footer().label, /Move 1 to Trash/);
  for (const pane of ['video', 'cloud']) {
    h.page.show(pane);
    assert.deepEqual(h.footer(), { summary: '', disabled: true, label: 'Move to Trash' },
      `the ${pane} pane shows no tick-box selection, so the footer offers none`);
    await h.page.click();
    assert.deepEqual(h.confirmed, [], `and a click there opens no Trash sheet for the Smart pane's hidden rows (${pane})`);
  }
  // Back on Smart Suggestions, the tick it kept is offered again.
  h.page.show('smart');
  assert.match(h.footer().summary, /^1 item/, 'the tick was kept, only not offered elsewhere');
  await h.page.click();
  assert.deepEqual(h.confirmed, [['/r/node_modules']], 'and on its own pane the click asks about it');
});

/* ═══════ 5. A move to the Trash frees nothing yet, and says so (D54) ═══════ */

/**
 * "2 files — 3.6 GB will be recovered" was the summary under a selection of
 * two sparse files that occupy nothing, about to be MOVED to the Trash —
 * where they go on occupying exactly what they did until the Trash is
 * emptied. The figure is the size the files report, and the most a move can
 * ever free. So the line says that: up to this much, when the Trash is
 * emptied. The completion toast and Shrink Video's report made the same claim.
 */

/** The footer under a two-file, 3.6 GB selection, from the page's own updateCleanSummary — on a local scan, or on a cloud account's (`cloud`: its provider). */
async function cleanFooter(cloud?: { name: string; trashLabel: string }): Promise<{ line: string; label: string }> {
  const { els, $ } = makeDom();
  const fn = runnable(bodyOf('function updateCleanSummary() {'), {
    $,
    activeCleanSelection: () => ({ paths: cloud ? ['cloud://gdrive/a', 'cloud://gdrive/b'] : ['/a', '/b'], bytes: 3_600_000_000, noun: 'file' }),
    formatBytes: () => '3.6 GB',
    icon: () => '',
    escapeHtml: String,
    isCloudScan: () => Boolean(cloud),
    cloudProviderOfScan: () => cloud ?? assert.fail('a local scan has no provider'),
    cleanPane: 'rules',
    renderCleanFunnel: () => {},
  });
  await fn();
  return { line: els.cleanSummary.textContent, label: els.cleanConfirmBtn.innerHTML };
}

test('the selection summary promises nothing the Trash has not done yet', async () => {
  const { line, label } = await cleanFooter();
  assert.doesNotMatch(line, /recovered/i, `nothing is recovered by a move to the Trash: "${line}"`);
  assert.match(line, /2 files/);
  assert.match(line, /up to 3\.6 GB/, 'the reported size is the most it can free');
  assert.match(line, /empty the Trash/, 'and only when the Trash is emptied');
  assert.equal(label, 'Move 2 to Trash');
});

test('on a cloud account\'s scan the selection summary and its button name the provider\'s trash, and promise no space from emptying the system Trash (review F2.1 of QA third pass D06)', async () => {
  // F1.4 made the sheet's top sentence say "goes to Google Drive trash"; the
  // footer under it still read "3 files · up to 2.1 GB, freed when you empty
  // the Trash" beside "Move 3 to Trash". A cloud scan's removals go to the
  // provider's own trash (confirmTrash, cloudTrashPaths): emptying the system
  // Trash frees nothing of them, and whether the provider counts its trash
  // against the account's space is the provider's rule (Dropbox does not).
  const { line, label } = await cleanFooter({ name: 'Google Drive', trashLabel: 'Google Drive trash' });
  assert.match(line, /^2 files · 3\.6 GB/, `the selection and its size: "${line}"`);
  assert.doesNotMatch(line, /\bTrash\b|freed|free\b/, `no system Trash, and no space promised: "${line}"`);
  assert.match(line, /Google Drive's trash$/, `where they go: "${line}"`);
  assert.equal(label, 'Move 2 to Google Drive\'s trash', 'the button says where it moves them, as the sheet it opens does');
});

test('the completion toast says where the files went, not that space came back', async () => {
  const { toasts } = await runConfirm({ paths: PATHS, sizes: SIZES }, { deleted: PATHS, failed: [] });
  const moved = toasts.find((t) => /Moved/.test(t.msg));
  assert.ok(moved, 'the move is reported');
  assert.doesNotMatch(moved!.msg, /recovered/i, moved!.msg);
  assert.match(moved!.msg, /empty the Trash/, moved!.msg);
});

test('Shrink Video reports a smaller file and an original in the Trash, not space recovered', async () => {
  const { els, $ } = makeDom();
  const toasts: string[] = [];
  // A holder rather than a bare `let`: assigned inside the constructor, a
  // `let` would be narrowed to null at the use below.
  const opened: { stream: { onmessage?: (ev: { data: string }) => void } | null } = { stream: null };
  class FakeEventSource {
    onmessage?: (ev: { data: string }) => void;
    onerror?: () => void;
    constructor() { opened.stream = this; }
    close() {}
  }
  const fn = runnable(bodyOf('async function startEncode(paths) {'), {
    $,
    api: async () => ({ jobId: 'j1' }),
    toast: (msg: string) => { toasts.push(msg); },
    EventSource: FakeEventSource,
    videoJobStream: null,
    formatBytes: (n: number) => `${n}B`,
    escapeHtml: (s: string) => s,
    baseName: (p: string) => p,
    rescan: () => {},
  }, 'paths');
  await fn(['/v/a.mov']);
  assert.ok(opened.stream, 'the progress stream was opened');
  opened.stream.onmessage!({ data: JSON.stringify({ type: 'complete', results: [{ ok: true, path: '/v/a.mov' }], savedBytes: 500 }) });
  const report = `${els.vidProgText.innerHTML} | ${toasts.join(' | ')}`;
  assert.doesNotMatch(report, /recovered/i, report);
  assert.match(report, /500B/, 'the saving is still stated');
  assert.match(report, /Trash/, 'with where the original went');
});

/** What a confirm sheet says, as a person reads it: its markup with the tags taken out. */
const sheetText = (els: Record<string, El>) => els.confirmText.innerHTML.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

test('the sheets that ask before a re-encode or a shader-cache clear say the space comes back once the Trash is emptied, not that it is freed (review F2.3 of QA third pass D06)', async () => {
  // "Re-encode 1 video file to HEVC, freeing roughly 4.2 GB." — the original
  // goes to the Trash and the new file stays beside it, so disk use rises by
  // the new file's size until the Trash is emptied; the report after it and
  // the selection summary already said so. The Games view's "Move 2 shader
  // caches to the Trash, freeing 1.2 GB" made the same claim.
  const encode = makeDom();
  runnable(bodyOf('function confirmEncode(chosen) {'), {
    $: encode.$, icon: () => '', formatBytes: (n: number) => `${n / 1e9} GB`,
    startEncode: () => {}, onConfirmTrash: null,
  }, 'chosen')([{ path: '/v/a.mov', estimatedSaving: 4_200_000_000 }]);
  const asked = sheetText(encode.els);
  assert.doesNotMatch(asked, /\bfree(ing|s|d)?\b/i, `nothing is freed by a move to the Trash: "${asked}"`);
  assert.match(asked, /roughly 4\.2 GB smaller once you empty the Trash/, `the saving, and when it arrives: "${asked}"`);
  assert.match(asked, /This is lossy/, 'control: the sheet is the re-encode\'s');

  const shaders = makeDom();
  const component = (p: string, bytes: number) => ({ kind: 'shaderCache', path: p, bytes });
  runnable(bodyOf('function clearShaderCaches() {'), {
    $: shaders.$, icon: () => '', formatBytes: (n: number) => `${n / 1e9} GB`, toast: () => assert.fail('there are caches to clear'),
    state: { games: { report: { libraries: [{ titles: [{ components: [component('/g/a', 700_000_000), { kind: 'base', path: '/g/base', bytes: 9e9 }] }, { components: [component('/g/b', 500_000_000)] }] }] } } },
    trashPaths: async () => {}, rescan: () => {}, onConfirmTrash: null,
  })();
  const cleared = sheetText(shaders.els);
  assert.doesNotMatch(cleared, /\bfree(ing|s|d)?\b/i, `nothing is freed by a move to the Trash: "${cleared}"`);
  assert.match(cleared, /Move 2 shader caches \(1\.2 GB\) to the Trash/, `what moves, and its size: "${cleared}"`);
  assert.match(cleared, /space comes back when you empty the Trash/, `and when the space arrives: "${cleared}"`);
});

/* ═══════ 6. Shrink Video: "could not be read" is not "already efficient" (D56) ═══════ */

/**
 * The server now says how many large videos it looked at (`shortlisted`) and
 * how many of those it could not read as video (`unreadable`). The pane used
 * to answer an empty list with "everything large is already in an efficient
 * format" — about files nobody had judged, or when there were no large videos
 * at all. Each case now gets its own sentence.
 */
async function videoPane(data: Record<string, unknown>): Promise<string> {
  const els: Record<string, any> = {};
  const $ = (id: string) => (els[id] ||= {
    innerHTML: '', textContent: '', disabled: false, hidden: false, style: {},
    querySelectorAll: () => [], addEventListener: () => {},
  });
  const fn = runnable(bodyOf('async function loadVideoCandidates() {'), {
    $,
    state: { scanId: 's1' },
    api: async () => ({ available: true, candidates: [], ...data }),
    skeletonRows: () => '',
    icon: () => '',
    escapeHtml: (s: string) => s,
    chipFor: () => '',
    formatBytes: (n: number) => `${n}B`,
    formatCount: (n: number) => Number(n).toLocaleString('en-US'),
    sizeColor: () => '',
    sizeInk: () => '',
    videoCandidates: [],
    confirmEncode: () => {},
  });
  await fn();
  return els.videoBody.innerHTML.replace(/\s+/g, ' ');
}

test('videos that could not be read are counted and named as unjudged, never as efficient', async () => {
  const html = await videoPane({ shortlisted: 4, unreadable: 2 });
  assert.match(html, /2 large videos couldn’t be read/, html);
  assert.doesNotMatch(html, /everything large/i, 'no claim about files nobody judged');
  assert.match(html, /other 2 are already in an efficient format/, 'the ones that were read are still credited');
});

test('when every large video is unreadable, nothing is called efficient', async () => {
  const html = await videoPane({ shortlisted: 3, unreadable: 3 });
  assert.match(html, /3 large videos couldn’t be read/, html);
  assert.doesNotMatch(html, /efficient/, html);
});

test('no large videos at all is said as that', async () => {
  const html = await videoPane({ shortlisted: 0, unreadable: 0 });
  assert.match(html, /No large videos/, html);
  assert.doesNotMatch(html, /efficient/, 'there was nothing to call efficient');
});

test('large videos that were all read and are efficient still get the efficient sentence', async () => {
  const html = await videoPane({ shortlisted: 3, unreadable: 0 });
  assert.match(html, /already in an efficient format/, html);
});

test('beside real candidates, the unreadable ones are still mentioned', async () => {
  const html = await videoPane({
    shortlisted: 2, unreadable: 1,
    candidates: [{ name: 'a.mp4', path: '/v/a.mp4', size: 100, estimatedBytes: 55, estimatedSaving: 45, reason: 'H264 video' }],
  });
  assert.match(html, /a\.mp4/, 'the candidate is listed');
  assert.match(html, /1 more large video couldn’t be read/, html);
});

/* ══════════════ D06 — no promise of recovery the code does not keep ══════════════ */

/** The page with every comment removed: what a person can be shown. */
const SHOWN = INDEX
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

/** Every sentence in `text` that offers a way back — recover, restore, undo, put back. */
function recoverySentences(text: string): string[] {
  return text
    .replace(/<[^>]+>/g, '\n').replace(/\$\{[^}]*\}/g, ' X ')
    .split(/(?<=[.!?])\s+|\n|`|'\s*\+\s*'/)
    .map((s) => s.trim())
    .filter((s) => /\brecoverabl|\brestor(e|ed)\b|\bundo(ne)?\b|\bput (it|them|everything) back\b/i.test(s));
}

/**
 * Open the Clean Up sheet with the page's own Clean Up button handler, over
 * stubs, on a local scan or on a cloud account's (`cloud`: its provider), and
 * read the sentence above its panes as a browser shows it: the markup's own
 * text, unless the handler writes the element. `dom` reuses the page of an
 * earlier open — the sheet is opened again on another scan.
 */
function openCleanUp(opts: { cloud?: { name: string; trashLabel: string } } = {}, dom = classDom()): { said: string; dom: ReturnType<typeof classDom> } {
  const handlerAt = INDEX.indexOf("$('cleanupBtn').addEventListener('click', () => {");
  assert.notEqual(handlerAt, -1, 'the Clean Up button is wired');
  const open = INDEX.indexOf('{', handlerAt + "$('cleanupBtn').addEventListener('click', ()".length);
  const body = INDEX.slice(open + 1, matchingBrace(open));
  // The sentence: the muted line above the first pane, and the id the handler would write it by.
  const paneAt = INDEX.indexOf('<div id="cleanPaneRules"');
  assert.notEqual(paneAt, -1, 'the Clean Up sheet is in the page');
  const noteAt = INDEX.lastIndexOf('<div class="muted"', paneAt);
  const id = /\bid="([^"]+)"/.exec(INDEX.slice(noteAt, INDEX.indexOf('>', noteAt)))?.[1];
  const markupText = INDEX.slice(noteAt, INDEX.indexOf('</div>', noteAt)).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (id && !dom.els[id]) dom.$(id).textContent = markupText;
  const deps: Record<string, unknown> = {
    $: dom.$, state: { root: { path: opts.cloud ? 'cloud://drive' : '/r', name: 'r' } }, toast: () => assert.fail('the sheet opened on a scan'),
    cleanMatches: [], emptyFolders: [], smartGroups: [],
    cleanFunnelDrop: () => {}, setCleanRuleSource: () => {}, setCleanPane: () => {}, renderCloudSafe: () => {},
    isCloudScan: () => Boolean(opts.cloud), cloudProviderOfScan: () => opts.cloud ?? assert.fail('a local scan has no provider'),
  };
  // The page's own helpers the handler calls, where the page has them.
  const helpers = ['cleanUpWhereItGoes'].filter((n) => new RegExp(`function ${n}\\s*\\(`).test(INDEX)).map(declOf).join('\n');
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(...keys, `${helpers}\n${body}`)(...keys.map((k) => deps[k]));
  assert.ok(dom.$('cleanModal').classes.has('open'), 'control: the sheet opened');
  return { said: id ? dom.els[id].textContent : markupText, dom };
}

test('the Clean Up sheet says where its removals go: the Trash, until it is emptied, with no Time Capsule copy; and Shrink Video is lossy (QA third pass D06)', () => {
  // QA third pass D06: "Nothing is removed until you confirm — and everything
  // goes to the system Trash, recoverable any time." Clean Up's moves are
  // DELETE /api/files, which keeps no Time Capsule copy (Settings and the
  // Time Capsule view both say so): once the Trash is emptied, nothing comes
  // back. And Shrink Video's original goes to the Trash after a lossy encode.
  const { said } = openCleanUp();
  assert.doesNotMatch(said, /any ?time/i, `no "recoverable any time": ${said}`);
  assert.match(said, /Nothing is removed until you confirm/, said);
  assert.match(said, /system Trash/, said);
  assert.match(said, /until the Trash is emptied/, `the way back ends when the Trash is emptied: ${said}`);
  assert.match(said, /not copied to the Time Capsule/, `and no capsule copy outlives it: ${said}`);
  assert.match(said, /Shrink Video/, said);
  assert.match(said, /quality/, `the re-encode loses quality for good: ${said}`);
  // What the sentence says of Clean Up is what Clean Up does: its moves are trashPaths, never the cart commit.
  assert.match(declOf('runCleanTrash'), /await trashPaths\(chunk,/, 'Clean Up moves through trashPaths');
});

test('on a cloud account\'s scan the Clean Up sheet says its removals go to that provider\'s trash, not the system Trash — and says so again for whichever scan it opens on (review F1.4 of QA third pass D06)', () => {
  // confirmTrash sends a cloud scan's Clean Up deletes to the provider's own
  // trash (cloudTrashPaths), which the provider empties after the time it
  // keeps deleted files; the sheet's one sentence said "the system Trash".
  const drive = { name: 'Google Drive', trashLabel: 'Google Drive trash' };
  const { said, dom } = openCleanUp({ cloud: drive });
  assert.doesNotMatch(said, /system Trash/, `a cloud scan's removals never reach the system Trash: ${said}`);
  assert.match(said, /Nothing is removed until you confirm/, said);
  assert.match(said, /goes to Google Drive trash\b/, `it names where they do go: ${said}`);
  assert.match(said, /not copied to the Time Capsule/, said);
  assert.match(said, /until that trash is emptied — by you, or by the provider after the time it keeps deleted files/, `and when that way back ends: ${said}`);
  assert.doesNotMatch(said, /any ?time|Shrink Video/i, `nothing a cloud scan cannot do: ${said}`);
  // The same page, a local scan next: the sheet says the local thing again.
  const local = openCleanUp({}, dom).said;
  assert.match(local, /goes to the system Trash/, `opened again on a local scan: ${local}`);
  assert.doesNotMatch(local, /Google Drive/, local);
  // And the cloud thing once more, from the local one.
  assert.match(openCleanUp({ cloud: drive }, dom).said, /goes to Google Drive trash\b/, 'and back');
});

test('no sentence on any page promises a way back "any time", and every promise past an emptied Trash says when it ends (QA third pass D06)', () => {
  // The sweep behind D06: "You can restore it from the Trash at any time"
  // (the Trash sheet every view opens), "Restore any time from the
  // provider's own trash" (providers empty theirs on their own), and the
  // Time Capsule's "even after emptying the Trash", which holds only until
  // the capsule lets the copy go — its retention and its size cap.
  const sentences = recoverySentences(SHOWN);
  assert.ok(sentences.length >= 10, `the sweep reads the page's recovery sentences (${sentences.length})`);
  for (const s of sentences) {
    assert.doesNotMatch(s, /any ?time|forever|always/i, `a way back with no end is promised: "${s}"`);
    if (/even after (you )?empty(ing)? the Trash/i.test(s)) assert.match(s, /\buntil\b/, `"even after emptying the Trash" says until when: "${s}"`);
    // An undo from the Time Capsule lasts as long as its copy: retention and the size cap let copies go.
    if (/Time Capsule/.test(s) && /can be undone|you can undo|undo (it|this|them)\b/i.test(s)) assert.match(s, /\buntil\b/, `an undo from the Time Capsule says until when: "${s}"`);
  }
});

/** What the server and the docs tell an agent or a reader about deletes, as [file, text]. */
function agentTexts(): Array<[string, string]> {
  const root = path.join(__dirname, '..');
  return ['src/mcp/server.ts', 'src/api/metaRoutes.ts', 'src/api/openapi.ts', 'src/services/cloud/providers.ts', 'README.md', 'AGENTS.md', 'SECURITY.md']
    .map((file) => [file, readFileSync(path.join(root, file), 'utf8')]);
}

test('what the server and the docs tell an agent about the Trash says when the way back ends (QA third pass D06)', () => {
  let seen = 0;
  for (const [file, text] of agentTexts()) {
    for (const m of text.matchAll(/[^.\n]*\brecoverable(?!ity)[^\n]*/gi)) {
      seen++;
      // Bounded ("until", "while") or hedged ("often": snapshots may still hold a file the Trash has let go).
      assert.match(m[0], /\buntil\b|\bwhile\b|\boften\b/, `${file}: "${m[0]}" says recoverable with no end — the Trash is emptied, a provider empties its own`);
    }
  }
  assert.ok(seen >= 6, `the sweep found the server's and the docs' own "recoverable" (${seen})`);
});

test('no sentence in the docs or in what an agent is told offers a way back with no end — "any time", "can be put back", "even after the Trash is emptied" each say until when (review F1.2, F1.8 of QA third pass D06)', () => {
  // The sweep above reads only the word "recoverable", so README's "undo
  // from Finder/Explorer any time", SECURITY's "can be put back" and "a run
  // can be undone even after the Trash is emptied", AGENTS' cart undo "even
  // after the Trash has been emptied" and trash_paths' own "can be restored
  // from there" each promised a way back with no end. The Trash's ends when
  // it is emptied; a Time Capsule copy's when its retention (30 days by
  // default) or its size cap lets the copy go.
  /** A doc's paragraphs, list items and table rows with their hard wraps undone, or a source file's lines — each split into sentences. */
  const sentencesOf = (file: string, text: string): string[] => text
    .split(file.endsWith('.md') ? /\n\s*\n|\n(?=\s*(?:[-*|]|\d+\.)\s)/ : /\n/)
    .map((block) => block.replace(/\s+/g, ' '))
    .flatMap((block) => block.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim()).filter(Boolean);
  const WAY_BACK = /\brecoverabl|\brestor(?:e|ed)\b|\bundo(?:ne)?\b|\bput\b[^.;]*\bback\b|\bcan be recovered\b/i;
  /** Whether, after the phrase at `m` and before its clause ends, the sentence says when that way back ends. */
  const endsLater = (s: string, m: RegExpExecArray) => /^[^;.]*?\b(?:until|while|as long as)\b/i.test(s.slice(m.index + m[0].length));
  const seen = { wayBack: 0, pastEmptied: 0, canBe: 0 };
  for (const [file, text] of agentTexts()) {
    for (const s of sentencesOf(file, text)) {
      if (WAY_BACK.test(s)) {
        seen.wayBack++;
        assert.doesNotMatch(s, /\bany ?time\b|\bforever\b/i, `${file}: a way back with no end — "${s}"`);
      }
      const past = /even after (?:you (?:have )?)?(?:emptied|empty(?:ing)?) the Trash|even after the Trash (?:is|has been) emptied|emptying the Trash doesn['’]t lose/i.exec(s);
      if (past) {
        seen.pastEmptied++;
        assert.ok(endsLater(s, past), `${file}: "${past[0]}" — until when? "${s}"`);
      }
      const can = /\b(?:can|could) be (?:put back|restored|undone|recovered)\b/i.exec(s);
      // "No copy it holds can be put back now" offers nothing: the phrase it is the predicate of says no.
      if (can && !/\b(?:no|not|never|nothing|none)\b/i.test(s.slice(0, can.index).split(/[;—:,]/).pop()!)) {
        seen.canBe++;
        assert.ok(endsLater(s, can), `${file}: "${can[0]}" with no end — "${s}"`);
      }
    }
  }
  // Each rule read the sentences it is about: a split that merged or lost them would pass by seeing nothing.
  assert.ok(seen.wayBack >= 100 && seen.pastEmptied >= 4 && seen.canBe >= 6, `the sweep read the docs' ways back: ${JSON.stringify(seen)}`);
});

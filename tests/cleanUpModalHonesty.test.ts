import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { waitFor } from './fixtures/waitFor';

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
    cleanOnDisk: new Map(), // nothing measured (fifth browser pass F09)
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
    cleanTrashing: false, // the page's own flag: a run holds the footer's button (review F2.1)
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
    // confirmTrash asks which paths are parts of an installed program (fifth browser pass F01): none here.
    installedProgramParts: async () => [],
    installedProgramWarningHtml: () => '',
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
    let cleanTrashing = false;
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
  const page = new Function(...keys, `let cleanPane = 'rules'; let onConfirmTrash = null; let cleanTrashing = false;
    ${['setCleanPane', 'activeCleanSelection', 'updateCleanSummary', 'cleanFreedSaid', 'confirmCleanTrash'].map(declOf).join('\n')}
    return { show: setCleanPane, click: confirmCleanTrash };`)(...keys.map((k) => deps[k]));
  const footer = () => ({ summary: els.cleanSummary.textContent, disabled: els.cleanConfirmBtn.disabled, label: els.cleanConfirmBtn.innerHTML });
  const hidden = () => els.cleanConfirmBtn.hidden;
  return { page, footer, hidden, confirmed };
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

test('the footer\'s Move to Trash is not shown under a tab whose action is not a move to the Trash - Shrink Video re-encodes, Cloud-safe stages into the cart (fifth browser pass F10)', () => {
  // QA: the Shrink Video tab showed a disabled "Move to Trash" in the shared
  // footer, under a pane whose own action is "Re-encode".
  const h = cleanPanes();
  for (const pane of ['rules', 'smart', 'empty']) {
    h.page.show(pane);
    assert.equal(h.hidden(), false, `control: the ${pane} pane's action is a move to the Trash, so its footer offers it`);
  }
  for (const pane of ['video', 'cloud']) {
    h.page.show(pane);
    assert.equal(h.hidden(), true, `the ${pane} pane's footer offers no Move to Trash, enabled or not`);
  }
  h.page.show('smart');
  assert.equal(h.hidden(), false, 'and back on a Trash pane it is offered again');
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
    cleanTrashing: false,
    renderCleanFunnel: () => {},
    // How the size is said (fifth browser pass F09), the page's own.
    cleanFreedSaid: new Function('formatBytes', `${declOf('cleanFreedSaid')}\nreturn cleanFreedSaid;`)(() => '3.6 GB'),
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

/* ═══════ 5b. A sparse file frees only what it takes (fifth browser pass F09) ═══════ */

/**
 * QA: Custom Rules (older than 180 days, larger than 100 MB) found
 * holiday-4k.mov and raw-footage.mkv, "2 files · up to 3.9 GB, freed when you
 * empty the Trash" — and `stat -f '%z %b'` said "3200000000 0" and
 * "700000000 0": sparse, taking nothing. The scan counts what a file claims;
 * the onDisk fact says what it takes, and the footer counts that.
 */

/** The Custom Rules footer, from the page's own activeCleanSelection, updateCleanSummary and cleanFreedSaid, for ticked `files` and what the onDisk fact measured. */
function rulesFooter(files: { path: string; size: number }[], onDisk: Record<string, number>) {
  const { $ } = classDom();
  const ticks = files.map((_, i) => ({ checked: true, dataset: { i: String(i) } }));
  const deps: Record<string, unknown> = {
    $, document: { querySelectorAll: (q: string) => (q === '#cleanResults .clean-ck' ? ticks : []) },
    cleanMatches: files, cleanOnDisk: new Map(Object.entries(onDisk)), emptyFolders: [], packageOrphans: [], smartGroups: [],
    isCloudScan: () => false, cloudProviderOfScan: () => assert.fail('a local scan has no provider'), escapeHtml: String,
    icon: () => '', formatBytes: (n: number) => `${n} B`, renderCleanFunnel: () => {},
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...keys, `let cleanPane = 'rules'; let cleanTrashing = false;
    ${['activeCleanSelection', 'updateCleanSummary', 'cleanFreedSaid'].map(declOf).join('\n')}
    return { summary: () => { updateCleanSummary(); return $('cleanSummary').textContent; }, selection: activeCleanSelection };`)(
    ...keys.map((k) => deps[k])) as { summary: () => string; selection: () => { sizes: Map<string, number>; onDiskSizes: Map<string, number> | null } };
}

const HOLIDAY = { path: '/c/Videos/holiday-4k.mov', size: 3_200_000_000 };
const RAW = { path: '/c/Videos/raw-footage.mkv', size: 700_000_000 };

test('Custom Rules counts what the files take on the disk: two sparse files that claim 3.9 GB and take 0 B are said to free none of it (fifth browser pass F09)', () => {
  const sparse = rulesFooter([HOLIDAY, RAW], { [HOLIDAY.path]: 0, [RAW.path]: 0 });
  assert.equal(sparse.summary(), '2 files · they claim 3900000000 B but take no space on the disk, so emptying the Trash frees none of it');
  assert.deepEqual([...sparse.selection().onDiskSizes!.values()], [0, 0], 'and what each takes is kept for the completion toast');
  const one = rulesFooter([HOLIDAY], { [HOLIDAY.path]: 0 });
  assert.equal(one.summary(), '1 file · it claims 3200000000 B but takes no space on the disk, so emptying the Trash frees none of it');
  const part = rulesFooter([HOLIDAY, RAW], { [HOLIDAY.path]: 1_000_000_000, [RAW.path]: 0 });
  assert.equal(part.summary(), '2 files · up to 1000000000 B, freed when you empty the Trash — they claim 3900000000 B but take only 1000000000 B on the disk');
});

test('Custom Rules says what the files take where every one was measured — even where that is more than they claim — and the claimed size, as the most, where not every file was (fifth browser pass F09; review F1.6)', () => {
  const dense = rulesFooter([HOLIDAY, RAW], { [HOLIDAY.path]: 3_200_000_000, [RAW.path]: 700_004_096 });
  assert.equal(dense.summary(), '2 files · up to 3900004096 B, freed when you empty the Trash', 'what they take, a block over what they claim');
  // Three small files claim 100 B each and take a 4096-byte block each: the
  // footer said "up to 300 B" and the completion toast then counted 12288 B.
  const small = ['/c/a.log', '/c/b.log', '/c/c.log'].map((p) => ({ path: p, size: 100 }));
  const blocks = rulesFooter(small, Object.fromEntries(small.map((f) => [f.path, 4096])));
  assert.equal(blocks.summary(), '3 files · up to 12288 B, freed when you empty the Trash', 'never "up to" less than the toast will count');
  const unmeasured = rulesFooter([HOLIDAY, RAW], { [HOLIDAY.path]: 0 });
  assert.equal(unmeasured.summary(), '2 files · up to 3900000000 B, freed when you empty the Trash', 'one file unmeasured: unknown is never read as 0');
  assert.equal(unmeasured.selection().onDiskSizes, null, 'and nothing is counted from what was not measured');
});

/** The page's runCleanFind and cleanOnDiskOf in one scope over stubs; `facts` answers POST /api/facts. */
function findHarness(facts: (paths: string[]) => Promise<unknown>, cloud = false) {
  const asked: { paths: string[]; providers: string[]; scanId: string }[] = [];
  const els: Record<string, any> = {};
  const $ = (id: string) => (els[id] ||= { innerHTML: '', textContent: '', disabled: false, addEventListener() {}, querySelectorAll: () => [] });
  /** What the footer was drawn from, each time it was drawn: how many files were measured then. */
  const summaries: number[] = [];
  let measuredNow = (): number => 0;
  const deps: Record<string, unknown> = {
    $, state: { scanId: 'scan-1' }, isCloudScan: () => cloud, toast: () => {}, reportError: () => assert.fail('nothing failed'), seedNodes: () => {}, icon: () => '',
    chipFor: () => '', formatDate: () => '', sizeInk: () => '', formatBytes: (n: number) => `${n} B`, formatCount: String, escapeHtml: String,
    cartButtonHtml: () => '', refreshCartButtons: () => {}, updateCleanSummary: () => { summaries.push(measuredNow()); },
    api: async (url: string, opts: { body: string }) => {
      assert.equal(url, '/api/facts');
      const body = JSON.parse(opts.body);
      asked.push(body);
      return facts(body.paths);
    },
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const page = new Function(...keys, `let cleanMatches = [], cleanOnDisk = new Map();
    ${declOf('runCleanFind')}
    const CLEAN_ON_DISK_CHUNK = ${/const CLEAN_ON_DISK_CHUNK = (\d+);/.exec(INDEX)?.[1] ?? 'undefined'};
    ${declOf('cleanOnDiskOf')}
    return { find: runCleanFind, onDisk: () => cleanOnDisk, matches: () => cleanMatches };`)(...keys.map((k) => deps[k])) as {
    find: (fetcher: () => Promise<unknown>) => Promise<void>; onDisk: () => Map<string, number>; matches: () => unknown[];
  };
  measuredNow = () => page.onDisk().size;
  return { page, asked, els, summaries };
}

const FOUND = Array.from({ length: 2500 }, (_, i) => ({ path: `/c/f${i}.mov`, name: `f${i}.mov`, size: 1000, modifiedAt: 0 }));

test('Find asks what the matched files take on the disk — the onDisk fact, in the fact route\'s chunks of 2,000 — and draws their summary again from it (fifth browser pass F09)', async () => {
  const h = findHarness(async (paths) => ({ providers: { onDisk: { available: true, values: Object.fromEntries(paths.map((p) => [p, { bytes: 0 }])) } } }));
  await h.page.find(async () => ({ files: FOUND, matched: FOUND.length, truncated: false }));
  assert.deepEqual(h.asked.map((a) => [a.paths.length, a.providers, a.scanId]), [[2000, ['onDisk'], 'scan-1'], [500, ['onDisk'], 'scan-1']]);
  assert.equal(h.page.onDisk().size, 2500, 'every file\'s measure is kept for the summary');
  assert.equal(h.page.onDisk().get('/c/f2499.mov'), 0);
  assert.equal(h.page.matches().length, 2500, 'control: the list is the files found');
  assert.equal(h.summaries.at(-1), 2500, `the footer is drawn last from what the files take: ${JSON.stringify(h.summaries)}`);
});

test('Find lists the matched files and is ready again before what they take on the disk is known — a facts request that never answers holds neither, and the footer says "up to" meanwhile (review F1.12)', async () => {
  // A share asleep after the scan: the onDisk question may never be answered.
  // Find waited on it before re-enabling itself or drawing anything.
  const h = findHarness(() => new Promise(() => {}));
  void h.page.find(async () => ({ files: FOUND.slice(0, 3), matched: 3, truncated: false }));
  await waitFor(() => h.asked.length === 1, 'Find to ask what the files take on the disk');
  assert.equal(h.els.cleanFindBtn.disabled, false, 'Find is ready again');
  assert.match(h.els.cleanResults.innerHTML, /f0\.mov[\s\S]*f2\.mov/, 'the files are listed');
  assert.deepEqual(h.summaries, [0], 'and the footer is drawn, from nothing measured: the claimed size, "up to"');
});

test('a Find\'s late answer about what its files take never lands on a later Find\'s list (review F1.12)', async () => {
  const answers: Array<(values: Record<string, { bytes: number }>) => void> = [];
  const h = findHarness(() => new Promise((resolve) => { answers.push((values) => resolve({ providers: { onDisk: { available: true, values } } })); }));
  // Every answer here is a settled promise, so one turn of the event loop lets it land.
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  void h.page.find(async () => ({ files: FOUND.slice(0, 2), matched: 2, truncated: false }));
  await waitFor(() => answers.length === 1, 'the first Find to ask');
  void h.page.find(async () => ({ files: FOUND.slice(5, 6), matched: 1, truncated: false }));
  await waitFor(() => answers.length === 2, 'the second Find to ask');
  answers[1]({ '/c/f5.mov': { bytes: 4096 } });
  await turn();
  assert.deepEqual([...h.page.onDisk()], [['/c/f5.mov', 4096]], 'control: the second Find\'s files are measured');
  answers[0]({ '/c/f0.mov': { bytes: 0 }, '/c/f1.mov': { bytes: 0 } });
  await turn();
  assert.deepEqual([...h.page.onDisk()], [['/c/f5.mov', 4096]], 'what is measured is the list on screen');
});

test('where the onDisk fact cannot answer — a system that reports no blocks, a failed request — Find still lists the files and nothing is counted as 0 (fifth browser pass F09)', async () => {
  const unavailable = findHarness(async () => ({ providers: { onDisk: { available: false, reason: 'no blocks here', values: {} } } }));
  await unavailable.page.find(async () => ({ files: FOUND.slice(0, 3), matched: 3, truncated: false }));
  assert.equal(unavailable.page.onDisk().size, 0, 'unavailable: nothing measured');
  assert.equal(unavailable.page.matches().length, 3, 'and the files are still listed');
  const failing = findHarness(async () => { throw new Error('offline'); });
  await failing.page.find(async () => ({ files: FOUND.slice(0, 3), matched: 3, truncated: false }));
  assert.equal(failing.page.onDisk().size, 0, 'a failed request: nothing measured');
  assert.equal(failing.page.matches().length, 3);
  const cloud = findHarness(async () => assert.fail('a cloud account\'s files are not measured'), true);
  await cloud.page.find(async () => ({ files: [{ path: 'cloud://drive/a.mov', name: 'a.mov', size: 1, modifiedAt: 0 }], matched: 1, truncated: false }));
  assert.deepEqual(cloud.asked, [], 'a cloud account\'s files are on no disk here: nothing is asked');
});

/**
 * The footer and the delete behind it, in one scope as the page has them: the
 * page's updateCleanSummary draws the footer from the ticked rows (stubbed:
 * `n` files ticked), runCleanTrash moves them in chunks of 20, and
 * confirmCleanTrash is the button's click. Each chunk's trashPaths waits until
 * the test answers it — with the chunk moved, or, given an error, by throwing it.
 */
function footerDuringDelete(n: number) {
  const { els, $ } = classDom();
  const paths = Array.from({ length: n }, (_, i) => `/r/f${i}.mov`);
  const selection = { paths, sizes: new Map(paths.map((p) => [p, 100])), bytes: 100 * n, noun: 'file', onDisk: null };
  const answers: Array<(err?: Error) => void> = [];
  const sheets: string[][] = [];
  const deps: Record<string, unknown> = {
    $, activeCleanSelection: () => selection, isCloudScan: () => false, cloudProviderOfScan: () => assert.fail('a local scan has no provider'),
    escapeHtml: String, icon: () => '', formatBytes: (b: number) => `${b} B`, renderCleanFunnel: () => {},
    trashPaths: (chunk: string[]) => new Promise((resolve, reject) => {
      answers.push((err) => (err ? reject(err) : resolve({ deleted: [...chunk], failed: [] })));
    }),
    closeModal: () => {}, toast: () => {}, REDUCED: true, rescan: () => {},
    confirmTrash: async (p: string[]) => { sheets.push([...p]); },
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const page = new Function(...keys, `let cleanPane = 'rules'; let onConfirmTrash = null; let cleanTrashing = false;
    ${['updateCleanSummary', 'cleanFreedSaid', 'runCleanTrash', 'confirmCleanTrash'].map(declOf).join('\n')}
    return { summary: updateCleanSummary, run: runCleanTrash, click: confirmCleanTrash };`)(...keys.map((k) => deps[k])) as {
    summary: () => void; run: (sel: unknown, opts: unknown) => Promise<void>; click: () => Promise<void>;
  };
  const button = () => ({ disabled: els.cleanConfirmBtn.disabled, label: els.cleanConfirmBtn.innerHTML });
  return { page, selection, answers, sheets, button };
}

test('while a delete runs, a redraw of the footer — Find\'s late answer about what the files take, or a tick — leaves Move to Trash held and saying how far it has got, and a click opens no second sheet (review F2.1, F2.9)', async () => {
  // Find draws its list before what the files take on the disk is known
  // (review F1.12), so on a slow drive that answer can land after Move to
  // Trash and OK: runCleanFind then calls updateCleanSummary, which set the
  // button enabled again as "Move 25 to Trash" mid-delete, and a second click
  // opened a second sheet for files already on their way to the Trash.
  const h = footerDuringDelete(25);
  h.page.summary();
  assert.deepEqual(h.button(), { disabled: false, label: 'Move 25 to Trash' }, 'control: the ticked files are offered');
  const run = h.page.run(h.selection, {});
  await waitFor(() => h.answers.length === 1, 'the first chunk to be sent');
  assert.equal(h.button().disabled, true, 'control: the run holds the button');
  h.answers[0]();
  await waitFor(() => h.answers.length === 2, 'the second chunk to be sent');
  assert.equal(h.button().label, 'Deleting… 20/25', 'control: the button says how far the run has got');
  h.page.summary(); // what runCleanFind's late answer, and a tick, do
  assert.deepEqual(h.button(), { disabled: true, label: 'Deleting… 20/25' }, 'the button stays held, saying how far the run has got');
  await h.page.click();
  assert.deepEqual(h.sheets, [], 'a click meanwhile opens no second sheet for files already on their way to the Trash');
  h.answers[1]();
  await run;
  h.page.summary();
  assert.deepEqual(h.button(), { disabled: false, label: 'Move 25 to Trash' }, 'once the run is over, the footer is drawn from the ticks again');
  await h.page.click();
  assert.equal(h.sheets.length, 1, 'and a click asks again');
});

test('a delete that stops on a throw hands Move to Trash back too: the footer is drawn from the ticks again and a click asks again — the run\'s hold is released in a finally, whatever ends it (review round 3, F3.2)', async () => {
  // runCleanTrash holds the button with a page flag for its whole run. Were
  // the flag cleared only after the loop, a chunk whose trashPaths threw left
  // it set: the footer stayed "Deleting…", disabled, and a click returned
  // silently, so Clean Up could trash nothing until the page was reloaded.
  const h = footerDuringDelete(25);
  h.page.summary();
  const run = h.page.run(h.selection, {});
  await waitFor(() => h.answers.length === 1, 'the first chunk to be sent');
  h.answers[0]();
  await waitFor(() => h.answers.length === 2, 'the second chunk to be sent');
  assert.equal(h.button().label, 'Deleting… 20/25', 'control: the run is under way');
  h.answers[1](new Error('the second chunk could not be sent'));
  await assert.rejects(run, /could not be sent/, 'control: the run stops on the throw');
  h.page.summary();
  assert.deepEqual(h.button(), { disabled: false, label: 'Move 25 to Trash' }, 'the footer is drawn from the ticks again');
  await h.page.click();
  assert.equal(h.sheets.length, 1, 'and a click asks again');
});

test('the completion toast says where the files went, not that space came back', async () => {
  const { toasts } = await runConfirm({ paths: PATHS, sizes: SIZES }, { deleted: PATHS, failed: [] });
  const moved = toasts.find((t) => /Moved/.test(t.msg));
  assert.ok(moved, 'the move is reported');
  assert.doesNotMatch(moved!.msg, /recovered/i, moved!.msg);
  assert.match(moved!.msg, /empty the Trash/, moved!.msg);
});

test('the completion toast counts what the moved files took on the disk, where that was measured — never the size a sparse file claims (fifth browser pass F09)', async () => {
  const measured = { paths: PATHS, sizes: SIZES, onDiskSizes: new Map([['/a', 0], ['/b', 0], ['/c', 4096]]) };
  const { toasts } = await runConfirm(measured, { deleted: PATHS, failed: [] });
  const moved = toasts.find((t) => /Moved/.test(t.msg));
  assert.match(moved!.msg, /^Moved 3 items to Trash \(4096B\)/, `what they took, not the 700 B they claim: ${moved!.msg}`);
  const sparse = { paths: PATHS, sizes: SIZES, onDiskSizes: new Map([['/a', 0], ['/b', 0], ['/c', 0]]) };
  const none = (await runConfirm(sparse, { deleted: PATHS, failed: [] })).toasts.find((t) => /Moved/.test(t.msg));
  assert.equal(none!.msg, 'Moved 3 items to Trash', 'files that took nothing promise no space at all');
  const claimed = (await runConfirm({ paths: PATHS, sizes: SIZES }, { deleted: PATHS, failed: [] })).toasts.find((t) => /Moved/.test(t.msg));
  assert.match(claimed!.msg, /^Moved 3 items to Trash \(up to 700B\)/, `unmeasured, the size they claim — "up to", as the footer said (review F1.6): ${claimed!.msg}`);
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
  await runnable(bodyOf('function confirmEncode(chosen, parts) {'), {
    $: encode.$, icon: () => '', formatBytes: (n: number) => `${n / 1e9} GB`,
    startEncode: () => {}, setConfirmButton: () => {}, onConfirmTrash: null, installedProgramWarningHtml: () => '',
  }, 'chosen, parts')([{ path: '/v/a.mov', estimatedSaving: 4_200_000_000 }], []);
  const asked = sheetText(encode.els);
  assert.doesNotMatch(asked, /\bfree(ing|s|d)?\b/i, `nothing is freed by a move to the Trash: "${asked}"`);
  assert.match(asked, /roughly 4\.2 GB smaller once you empty the Trash/, `the saving, and when it arrives: "${asked}"`);
  assert.match(asked, /This is lossy/, 'control: the sheet is the re-encode\'s');
  assert.match(asked, /^Re-encode 1 video file to HEVC: .* where the original goes\./, `one video is spoken of as one: "${asked}"`);
  // Two videos: the plural half of the same sentence (review F3.3 of QA third pass D08).
  const pair = makeDom();
  await runnable(bodyOf('function confirmEncode(chosen, parts) {'), {
    $: pair.$, icon: () => '', formatBytes: (n: number) => `${n / 1e9} GB`,
    startEncode: () => {}, setConfirmButton: () => {}, onConfirmTrash: null, installedProgramWarningHtml: () => '',
  }, 'chosen, parts')([{ path: '/v/a.mov', estimatedSaving: 4_200_000_000 }, { path: '/v/b.mov', estimatedSaving: 1_000_000_000 }], []);
  const askedTwo = sheetText(pair.els);
  assert.doesNotMatch(askedTwo, /\bfree(ing|s|d)?\b/i, `nothing is freed by a move to the Trash: "${askedTwo}"`);
  assert.match(askedTwo, /^Re-encode 2 video files to HEVC: roughly 5\.2 GB smaller once you empty the Trash, where the originals go\./,
    `two videos are spoken of as two, and the saving is both of theirs: "${askedTwo}"`);

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

/**
 * The Shrink Video pane over real candidates, ticked as a person ticks them:
 * the page's own loadVideoCandidates draws the list and wires its boxes, and
 * `line` reads the sentence beside Re-encode.
 */
async function videoPaneTicking(candidates: Array<{ name: string; path: string; size: number; estimatedBytes: number; estimatedSaving: number; reason: string }>) {
  type Box = { checked: boolean; dataset: { i: string }; changed: Array<() => void>; addEventListener(t: string, f: () => void): void };
  const boxes: Box[] = candidates.map((_, i) => ({
    checked: false, dataset: { i: String(i) }, changed: [] as Array<() => void>,
    addEventListener(t, f) { if (t === 'change') this.changed.push(f); },
  }));
  const els: Record<string, any> = {};
  const $ = (id: string) => (els[id] ||= {
    innerHTML: '', textContent: '', disabled: false, hidden: false, style: {}, clicked: [] as Array<() => void>,
    // The list's boxes live in the pane's body; nothing else here is asked for any.
    querySelectorAll: (sel: string) => (id !== 'videoBody' ? [] : sel === '.vid-ck:checked' ? boxes.filter((b) => b.checked) : sel === '.vid-ck' ? boxes : []),
    addEventListener(t: string, f: () => void) { if (t === 'click') this.clicked.push(f); },
  });
  await runnable(bodyOf('async function loadVideoCandidates() {'), {
    $, state: { scanId: 's1' },
    api: async () => ({ available: true, candidates, shortlisted: candidates.length, unreadable: 0 }),
    skeletonRows: () => '', icon: () => '', escapeHtml: (s: string) => s, chipFor: () => '',
    formatBytes: (n: number) => `${n / 1e9} GB`, formatCount: String, sizeColor: () => '', sizeInk: () => '',
    videoCandidates: [], confirmEncode: () => {},
  })();
  return {
    tick(i: number) { boxes[i].checked = true; boxes[i].changed.forEach((f) => f()); },
    selectAll() { els.vidSelectAll.clicked.forEach((f: () => void) => f()); },
    line: (): string => els.vidSummary.textContent,
  };
}

test('the Shrink Video pane\'s selection line says the space comes once the Trash is emptied, as the sheet after it does (review F3.1 of QA third pass D06)', async () => {
  // "1 selected — around 4.2 GB back, if the estimates hold": the encoder
  // writes the new file beside the original and moves the original to the
  // Trash (compressionAdvisor's encodeOne), so disk use rises by the new
  // file's size until the Trash is emptied. The confirm sheet one click
  // later says so (F2.3); the line beside the button still said "back".
  const video = (name: string, saving: number) => ({ name, path: `/v/${name}`, size: 9e9, estimatedBytes: 9e9 - saving, estimatedSaving: saving, reason: 'H264 video' });
  const pane = await videoPaneTicking([video('a.mov', 4_200_000_000), video('b.mov', 1_000_000_000)]);
  assert.equal(pane.line(), '', 'control: nothing ticked, nothing said');
  pane.tick(0);
  const one = pane.line();
  assert.doesNotMatch(one, /\bback\b|\bfree/i, `no space comes back before the Trash is emptied: "${one}"`);
  assert.match(one, /^1 selected — around 4\.2 GB smaller once you empty the Trash, if the estimates hold$/, `the saving, and when it arrives: "${one}"`);
  pane.selectAll();
  const both = pane.line();
  assert.match(both, /^2 selected — around 5\.2 GB smaller once you empty the Trash/, `every ticked video counts: "${both}"`);

  // And the sheet the button opens says the same thing of the same saving.
  const sheet = makeDom();
  await runnable(bodyOf('function confirmEncode(chosen, parts) {'), {
    $: sheet.$, icon: () => '', formatBytes: (n: number) => `${n / 1e9} GB`, startEncode: () => {}, setConfirmButton: () => {}, onConfirmTrash: null,
    installedProgramWarningHtml: () => '',
  }, 'chosen, parts')([video('a.mov', 4_200_000_000), video('b.mov', 1_000_000_000)], []);
  const asked = sheetText(sheet.els);
  const when = /5\.2 GB smaller once you empty the Trash/;
  assert.ok(when.test(both) && when.test(asked), `the pane and the sheet agree: "${both}" / "${asked}"`);
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

/** What the server and the docs tell an agent or a reader about deletes, as [file, text] — and `more` files besides. */
function agentTexts(more: string[] = []): Array<[string, string]> {
  const root = path.join(__dirname, '..');
  return ['src/mcp/server.ts', 'src/api/metaRoutes.ts', 'src/api/openapi.ts', 'src/services/cloud/providers.ts', 'README.md', 'AGENTS.md', 'SECURITY.md', ...more]
    .map((file) => [file, readFileSync(path.join(root, file), 'utf8')]);
}

/**
 * The services whose sentences reach a person or an agent as a result, not as
 * docs: the cart commit's answer (cleanupError, a skipped item's reason) and
 * an Autopilot run's record, which the run history shows for as long as the
 * record exists (review F2.2, F2.5 of QA third pass D06).
 */
const RESULT_SOURCES = ['src/services/timeCapsule.ts', 'src/services/cartCommit.ts', 'src/services/autopilot.ts'];

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

test('no sentence in the docs, in what an agent is told or in a result the server writes offers a way back with no end — "any time", "can be put back", "puts it back", "even after the Trash is emptied" each say until when (review F1.2, F1.8, F2.2, F2.5, F3.4 of QA third pass D06)', () => {
  // The sweep above reads only the word "recoverable", so README's "undo
  // from Finder/Explorer any time", SECURITY's "can be put back" and "a run
  // can be undone even after the Trash is emptied", AGENTS' cart undo "even
  // after the Trash has been emptied" and trash_paths' own "can be restored
  // from there" each promised a way back with no end. The Trash's ends when
  // it is emptied; a Time Capsule copy's when its retention (30 days by
  // default) or its size cap lets the copy go. And it read only the docs:
  // the cart commit's cleanupError, which an Autopilot run's record keeps,
  // said "Everything listed as trashed was trashed, and can be put back.",
  // and the OpenAPI text for it "undo with runId puts it back" (F2.2, F2.5).
  /** A doc's paragraphs, list items and table rows with their hard wraps undone, or a source file's lines — each split into sentences. */
  const sentencesOf = (file: string, text: string): string[] => text
    .split(file.endsWith('.md') ? /\n\s*\n|\n(?=\s*(?:[-*|]|\d+\.)\s)/ : /\n/)
    .map((block) => block.replace(/\s+/g, ' '))
    .flatMap((block) => block.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim()).filter(Boolean);
  const WAY_BACK = /\brecoverabl|\brestor(?:e|ed)\b|\bundo(?:ne)?\b|\bput\b[^.;]*\bback\b|\bcan be recovered\b/i;
  /** Whether, after the phrase at `m` and before its clause ends, the sentence says when that way back ends. */
  const endsLater = (s: string, m: RegExpExecArray) => /^[^;.]*?\b(?:until|while|as long as)\b/i.test(s.slice(m.index + m[0].length));
  /**
   * Every "puts … back" in `s` that offers a way back — "puts it back", "puts every file back",
   * "puts back what was trashed" — and whether it is bounded. Every one is examined (review F3.4:
   * the rule read four trailing shapes and passed every other), and passes only by saying until
   * when, or by being one of three shapes that offer no way back, each named here: a condition on
   * the item's place ("only if its place is empty by then", "once", "there") says how an undo
   * works, not whether one still can; "before it puts any back" says the order of a restore's
   * steps; and a "puts back" with no object ("what an undo puts back", "copies an undo puts back
   * now") names the copies rather than promising them. Keyboard focus is no deleted item.
   */
  const putsBackIn = (s: string): Array<{ phrase: string; bounded: boolean }> => {
    const offers: Array<{ phrase: string; bounded: boolean }> = [];
    for (const m of s.matchAll(/\bputs((?: (?!back\b)[\w’'`-]+){0,3}) back\b/gi)) {
      const what = m[1].trim();
      const before = s.slice(0, m.index);
      const after = s.slice(m.index! + m[0].length);
      if (/^focus$/i.test(what)) continue;
      if (!what && /^\s*(?:$|[,.;:)\]]|(?:now|is|are)\b)/i.test(after)) continue;
      const bounded = /^[^;.]*?\b(?:until|while|as long as)\b/i.test(after)
        || /^[^;.]*?\b(?:only if|once|there)\b/i.test(after)
        || /\bbefore (?:it|an undo|a restore|the undo|the restore) $/i.test(before);
      offers.push({ phrase: m[0], bounded });
    }
    return offers;
  };
  // The rule itself, on the shapes the review found it blind to: each is a way back with no end.
  for (const s of ['Undo puts it back, whenever you ask.', 'Undo puts it back from the Time Capsule.', 'Undo puts it back where it was.',
    'The undo puts back what was trashed.', 'A run is undone with a click and puts back every file it trashed.', 'Undo puts every file back.']) {
    assert.deepEqual(putsBackIn(s).map((o) => o.bounded), [false], `the rule reads "${s}" as a way back with no end`);
  }
  // And the shapes that say until when, or how, are let through.
  for (const s of ['Undo puts it back until the Time Capsule removes its copies.', 'An undo puts it back only if its place is empty by then.',
    'An undo puts each back once its place is empty.', 'An undo puts it back, and looks for it, there.']) {
    assert.deepEqual(putsBackIn(s).map((o) => o.bounded), [true], `the rule lets "${s}" through`);
  }
  const seen = { wayBack: 0, pastEmptied: 0, canBe: 0, putsBack: 0 };
  for (const [file, text] of agentTexts(RESULT_SOURCES)) {
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
      for (const offer of putsBackIn(s)) {
        seen.putsBack++;
        assert.ok(offer.bounded, `${file}: "${offer.phrase}" with no end — "${s}"`);
      }
    }
  }
  // Each rule read the sentences it is about: a split that merged or lost them would pass by seeing nothing.
  assert.ok(seen.wayBack >= 100 && seen.pastEmptied >= 5 && seen.canBe >= 8 && seen.putsBack >= 19, `the sweep read the docs' ways back: ${JSON.stringify(seen)}`);
});

/* ═══════ 7. Package leftovers: what a person can act on leads, and "in use" is an open file's word (G05) ═══════ */

/*
 * Smart Suggestions opened on "Package leftovers — no orphans; shared caches
 * only — 0 B" over six grey IN USE rows (rusty/target, webapp/node_modules,
 * .venv, dist, .next, a Gradle build), and further down the same sheet offered
 * those very folders for removal ("Rust build target · 78.8 MB · To put it
 * back: cargo build"). The server's `active` means the owning project is still
 * there (AGENTS.md: context only); everywhere else in the app "in use" means a
 * program has the file open. And "shared caches only" was said over no cache at
 * all. The panel is run here from the built page over stubs, on the payloads
 * GET /api/packages/orphans sends.
 */

type PkgKind = 'orphan' | 'active' | 'cache';
interface PkgEntry {
  ecosystem: string; kind: PkgKind; name: string; path: string; size: number; modifiedAt: number;
  projectPath?: string; projectName?: string; reason: string; command?: string; advisory?: boolean;
}
/** One ecosystem group as the server totals it. */
function pkgGroup(ecosystem: string, entries: PkgEntry[]) {
  const of = (k: PkgKind) => entries.filter((e) => e.kind === k);
  const bytes = (k: PkgKind) => of(k).reduce((s, e) => s + e.size, 0);
  return {
    ecosystem, entries,
    orphanCount: of('orphan').length, orphanBytes: bytes('orphan'),
    activeCount: of('active').length, activeBytes: bytes('active'),
    cacheCount: of('cache').length, cacheBytes: bytes('cache'),
  };
}
/** The whole answer, totalled as packageEcosystemScanner totals it. */
function pkgReport(groups: ReturnType<typeof pkgGroup>[]) {
  const sum = (k: 'orphanBytes' | 'cacheBytes' | 'activeBytes' | 'orphanCount') => groups.reduce((s, g) => s + g[k], 0);
  return { scanId: 's1', available: true, ecosystems: groups, orphanBytes: sum('orphanBytes'), cacheBytes: sum('cacheBytes'), activeBytes: sum('activeBytes'), orphanCount: sum('orphanCount') };
}
/** A folder whose project is still beside it — the server's `active`, with the reason it sends. */
const owned = (ecosystem: string, project: string, name: string, size: number, command: string): PkgEntry => ({
  ecosystem, kind: 'active', name, path: `/corpus/Projects/${project}/${name}`, size, modifiedAt: 1_790_000_000_000,
  projectPath: `/corpus/Projects/${project}`, projectName: project, reason: `In use by ${project}.`, command,
});

/** The six folders of the QA corpus: every one's project is still there. */
const CORPUS = pkgReport([
  pkgGroup('gradle', [owned('gradle', 'gradle-app', 'build', 3_400_000, 'gradle build')]),
  pkgGroup('python', [owned('python', 'pyproj', '.venv', 11_500_000, 'python3 -m venv <folder>, then reinstall the packages it held')]),
  pkgGroup('cargo', [owned('cargo', 'rusty', 'target', 78_800_000, 'cargo build')]),
  pkgGroup('npm', [
    owned('npm', 'webapp', 'node_modules', 20_700_000, 'npm install'),
    owned('npm', 'site', 'dist', 1_200_000, 'npm run build'),
    owned('npm', 'nextapp', '.next', 2_300_000, 'npm run build'),
  ]),
]);

/** Run the page's renderPackageOrphans on one answer; `dom` carries a page from an earlier run. */
async function renderPackages(data: unknown, dom: Record<string, { innerHTML: string }> = {}) {
  const $ = (id: string) => (dom[id] ||= Object.assign({ innerHTML: '' }, {
    querySelectorAll: () => [] as unknown[],
  }));
  const fn = runnable(bodyOf('async function renderPackageOrphans() {'), {
    $, api: async () => data, state: { scanId: 's1' },
    icon: () => '', escapeHtml: (s: string) => String(s),
    formatBytes: (n: number) => `${n} B`, formatCount: (n: number) => (n ?? 0).toLocaleString('en-US'),
    formatDate: () => 'Oct 2, 2026', sizeInk: () => 'inherit', ecosystemLabel: (id: string) => id,
    cartButtonHtml: (p: string) => `<cart ${p}>`, refreshCartButtons: () => {}, updateCleanSummary: () => {},
    packageOrphans: [] as unknown[],
  });
  const shown = await fn();
  return { shown, lead: $('packageOrphans').innerHTML, projects: $('packageProjects').innerHTML, dom };
}

/** The rows a host holds, each as its own HTML. */
const pkgRows = (html: string) => html.split('<div class="clean-item pkg-item').slice(1);

test('a sheet whose package folders all still have their project does not open on a 0 B "Package leftovers" header: those folders are listed after Smart Suggestions, folded (G05)', async () => {
  const { shown, lead, projects } = await renderPackages(CORPUS);
  assert.equal(lead, '', 'the panel above Smart Suggestions is empty: no "Package leftovers … 0 B" leads the sheet');
  assert.equal(shown, true, 'yet it listed package folders, in the fold, so the suggestions never also say nothing matched (G05 review F2.3)');
  assert.match(projects, /^\s*<details class="pkg-projects"/, 'the six folders are in a fold of their own');
  assert.doesNotMatch(projects, /<details[^>]*\bopen\b/, 'which opens closed');
  const rows = pkgRows(projects);
  assert.deepEqual(rows.map((r) => /class="pth" title="([^"]+)"/.exec(r)?.[1]).sort(),
    CORPUS.ecosystems.flatMap((g) => g.entries.map((e) => e.path)).sort(), 'every one of them is listed, once');
  for (const r of rows) {
    assert.doesNotMatch(r, /class="pkg-ck"|<cart /, 'nothing in the fold is ticked or staged from here');
  }
  // The fold says how many, and what they take, as the server totalled it.
  const summary = /<summary[\s\S]*?<\/summary>/.exec(projects)?.[0] ?? '';
  assert.match(summary, /\b6\b/, `the fold counts its folders: ${summary}`);
  assert.match(summary, new RegExp(`\\b${CORPUS.activeBytes} B\\b`), 'and says what they take');
  // Each ecosystem in the fold says how many of its folders are there, and
  // what they take as the server totalled them (G05 review F1.5).
  assert.deepEqual([...projects.matchAll(/<div class="pkg-echead"><b>([^<]*)<\/b><span class="muted num">([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]), [
    ['gradle', '1 folder · 3400000 B'],
    ['python', '1 folder · 11500000 B'],
    ['cargo', '1 folder · 78800000 B'],
    ['npm', '3 folders · 24200000 B'],
  ], 'each ecosystem\'s heading counts its folders and their bytes');
});

/*
 * Each row in the fold once ended "· <code>pip install -r requirements.txt</code>
 * to restore" — for a virtualenv, the sentence G05 review F1.1 took off the
 * fold's summary: that command makes no `.venv` and fails where there is no
 * requirements.txt (G05 review F2.1). A row in the fold says what is true of
 * it, its project is still here, and names no command as putting it back. A
 * cache's command does clear it, and still says so.
 */
test('a folder whose project is still here is never called "in use" — the app\'s word for a file a program has open — and says what is true: its project is here, never that the command its rule names puts it back (G05, review F2.1)', async () => {
  const { lead, projects } = await renderPackages(CORPUS);
  assert.doesNotMatch(lead + projects, /in use/i, 'no row, tag or tooltip says "in use"');
  const rows = pkgRows(projects);
  assert.equal(rows.length, 6, 'control: the six folders are in the fold');
  assert.ok(rows.some((r) => r.includes('/pyproj/.venv')), 'control: the virtualenv among them');
  for (const r of rows) {
    const path = /class="pth" title="([^"]+)"/.exec(r)![1];
    const entry = CORPUS.ecosystems.flatMap((g) => g.entries).find((e) => e.path === path)!;
    assert.match(r, /<span class="pkg-tag active">has project<\/span>/, `${path}: its tag says it has a project (G05 review F3.3)`);
    const why = /<div class="pkg-why">([\s\S]*?)<\/div>/.exec(r)?.[1] ?? '';
    assert.doesNotMatch(why, /to restore|puts? (it|them) back/, `${path}: its line never says a command puts it back: ${why}`);
    assert.equal(why, 'Its project is still here', `${path}: its line says its project is still here, and nothing it cannot vouch for`);
    assert.ok(r.includes(`<span class="pkg-proj">${entry.projectName}</span>`), `${path}: beside the project's name`);
  }
  assert.match(/<summary[\s\S]*?<\/summary>/.exec(projects)![0], /project is still here/, 'the fold says so of all of them');
  // A cache's command is what clears it, and its row still says so.
  const cache: PkgEntry = { ecosystem: 'npm', kind: 'cache', name: '_cacache', path: '/home/u/.npm/_cacache', size: 4_000_000, modifiedAt: 1, reason: 'npm’s shared download cache.', command: 'npm cache clean --force' };
  const caches = await renderPackages(pkgReport([pkgGroup('npm', [cache])]));
  assert.match(caches.lead, /<div class="pkg-why">npm’s shared download cache\. · <code>npm cache clean --force<\/code> to clear<\/div>/,
    'a cache names the command that clears it');
});

/*
 * F2.1 took the command off the fold's rows; an orphan's row still ended
 * "· <code>npm install</code> to restore" under a header saying "nothing will
 * rebuild them". With its project gone, `npm install`, `cargo build` and
 * `pip install -r requirements.txt` put back nothing — and the virtualenv's
 * line said requirements.txt was gone, then named it as the way back. A
 * virtualenv whose interpreter is gone gets no `.venv` from pip either, and a
 * superseded Homebrew keg's command (`brew cleanup ripgrep`) removes it. So an
 * orphan's row says what the server found and names no command; a cache's
 * command does clear it, and says so (G05 review F3.2, F3.4).
 */
test('an orphaned folder\'s row names no command as putting it back — no project file is beside it, or its interpreter is gone, and a superseded keg\'s command removes it — while a cache still names what clears it (G05 review F3.2, F3.4)', async () => {
  const orphan = (ecosystem: string, name: string, path: string, reason: string, command: string, project?: string): PkgEntry => ({
    ecosystem, kind: 'orphan', name, path, size: 1_000_000, modifiedAt: 1, reason, command,
    ...(project ? { projectPath: path.slice(0, path.lastIndexOf('/')), projectName: project } : {}),
  });
  // Each with the reason and command GET /api/packages/orphans sends for it (packageEcosystemScanner).
  const rows = [
    orphan('npm', 'node_modules', '/corpus/old/node_modules', 'No package.json beside it — TreeMap finds no project that owns it.', 'npm install'),
    orphan('python', '.venv', '/corpus/gone/.venv', 'No requirements.txt beside it — TreeMap finds no project that owns it.', 'python3 -m venv <folder>, then reinstall the packages it held'),
    orphan('python', '.venv', '/corpus/Projects/py/.venv', 'Its Python interpreter is gone (/old/py/bin) — this environment cannot run.', 'python3 -m venv <folder>, then reinstall the packages it held', 'py'),
    orphan('cargo', 'target', '/corpus/rusty-old/target', 'No Cargo.toml beside it — TreeMap finds no project that owns it.', 'cargo build'),
    orphan('homebrew', 'ripgrep 13.0.0', '/opt/homebrew/Cellar/ripgrep/13.0.0', 'Superseded — ripgrep has 2 versions installed and only the newest is linked.', 'brew cleanup ripgrep', 'ripgrep'),
  ];
  const cache: PkgEntry = { ecosystem: 'npm', kind: 'cache', name: '_cacache', path: '/home/u/.npm/_cacache', size: 4_000_000, modifiedAt: 1, reason: 'npm’s shared download cache.', command: 'npm cache clean --force' };
  const { lead } = await renderPackages(pkgReport([
    pkgGroup('npm', [rows[0], cache]), pkgGroup('python', [rows[1], rows[2]]), pkgGroup('cargo', [rows[3]]), pkgGroup('homebrew', [rows[4]]),
  ]));
  // The header claims nothing of the orphans as a whole (BQG-5 item 15, review F1.2): a virtualenv whose
  // interpreter is gone may sit in a project that is still here, which can make it again ("nothing will
  // rebuild them" was false of it), and one with no project file beside it may sit beside the scripts that
  // still use it ("nothing can still use them" was false of that). Each row says what the server found.
  assert.match(lead, /5 orphaned — each row says why/, 'the header counts the five orphans, and points to their reasons');
  assert.doesNotMatch(lead, /nothing will rebuild|nothing can still use/, 'never a claim the server did not establish of every one');
  const said = Object.fromEntries(pkgRows(lead).map((r) => [
    /class="pth" title="([^"]+)"/.exec(r)![1],
    /<div class="pkg-why">([\s\S]*?)<\/div>/.exec(r)?.[1] ?? '',
  ]));
  assert.deepEqual(said, {
    '/corpus/old/node_modules': 'No package.json beside it — TreeMap finds no project that owns it.',
    '/home/u/.npm/_cacache': 'npm’s shared download cache. · <code>npm cache clean --force</code> to clear',
    '/corpus/gone/.venv': 'No requirements.txt beside it — TreeMap finds no project that owns it.',
    '/corpus/Projects/py/.venv': 'Its Python interpreter is gone (/old/py/bin) — this environment cannot run.',
    '/corpus/rusty-old/target': 'No Cargo.toml beside it — TreeMap finds no project that owns it.',
    '/opt/homebrew/Cellar/ripgrep/13.0.0': 'Superseded — ripgrep has 2 versions installed and only the newest is linked.',
  }, 'each orphan says what the server found, with no command; the cache names the command that clears it');
});

test('orphans and caches lead the sheet with their boxes, and a folder whose project is still here goes to the fold — "shared caches only" is said only where it is true (G05)', async () => {
  const orphan: PkgEntry = { ecosystem: 'npm', kind: 'orphan', name: 'node_modules', path: '/corpus/old/node_modules', size: 9_000_000, modifiedAt: 1, reason: 'No package.json beside it — TreeMap finds no project that owns it.', command: 'npm install' };
  const cache: PkgEntry = { ecosystem: 'npm', kind: 'cache', name: '_cacache', path: '/home/u/.npm/_cacache', size: 4_000_000, modifiedAt: 1, reason: 'npm’s shared download cache.', command: 'npm cache clean --force' };
  const live = owned('npm', 'shop', 'node_modules', 20_700_000, 'npm install');
  const mixed = pkgReport([pkgGroup('npm', [orphan, cache, live])]);
  const first = await renderPackages(mixed);
  assert.equal(first.shown, true, 'something a person can act on was shown');
  assert.deepEqual(pkgRows(first.lead).map((r) => /class="pth" title="([^"]+)"/.exec(r)?.[1]), [orphan.path, cache.path], 'the orphan and the cache lead');
  assert.ok(pkgRows(first.lead).every((r) => /class="pkg-ck"/.test(r) && /<cart /.test(r)), 'each with its box and cart toggle');
  assert.match(first.lead, /1 orphaned — its row says why/, 'the header counts the orphan, and points to its reason');
  assert.doesNotMatch(first.lead, new RegExp(live.path), 'the folder whose project is here is not among them');
  assert.doesNotMatch(first.lead, /\b1 in use\b|in use/i, 'nor counted in its ecosystem\'s line');
  assert.deepEqual(pkgRows(first.projects).map((r) => /class="pth" title="([^"]+)"/.exec(r)?.[1]), [live.path], 'it is in the fold below the suggestions');
  // Caches alone: the header's "shared caches only" is true now, and said.
  const caches = await renderPackages(pkgReport([pkgGroup('npm', [cache])]));
  assert.match(caches.lead, /no orphans; shared caches only/, 'caches and nothing else: said as that');
  assert.equal(caches.projects, '', 'with no fold');
  // The CORPUS sheet's header said "shared caches only" over no cache at all.
  const again = await renderPackages(CORPUS, first.dom);
  assert.equal(again.lead, '', 'opened on another scan, the old leftovers go');
  assert.doesNotMatch(again.projects, new RegExp(live.path), 'and so does the old fold');
  // A scan with no package folder at all, straight after a sheet that showed
  // both halves: each goes (G05 review F1.3 — after `again` the lead was
  // already empty, so its half of this said nothing).
  const both = await renderPackages(mixed, first.dom);
  assert.ok(both.lead !== '' && both.projects !== '', 'control: the leftovers and the fold are both on the sheet');
  const gone = await renderPackages(pkgReport([]), first.dom);
  assert.deepEqual([gone.lead, gone.projects], ['', ''], 'a scan with none clears both');
  // An answer that names no folder at all — a broken rule pack — leaves no earlier fold standing under it.
  await renderPackages(mixed, first.dom);
  const broken = await renderPackages({ scanId: 's1', available: false, reason: 'A rule pack is malformed.' }, first.dom);
  assert.equal(broken.projects, '', 'a fold from an earlier answer goes when the packs cannot be read');
  assert.match(broken.lead, /could not be checked/, 'control: the panel says the packs could not be read');
});

/*
 * The fold's line once said "the command beside each puts it back" wherever
 * every folder named a command. Not every command does: a Python
 * virtualenv's is the rule pack's `pip install -r requirements.txt`, which
 * makes no `.venv` (it installs into whichever Python comes first on PATH)
 * and fails in a project with no requirements.txt (G05 review F1.1). So the
 * line says what is true of every folder in it — its project is still here
 * (F3.3, below) — whichever of them name a command: all, some (F1.4) or none.
 */
test('the fold never says the command beside its folders puts them back — a virtualenv\'s does not — and says the same true thing whether all, some or none name a command (G05 review F1.1, F1.4)', async () => {
  const bare = { ...owned('npm', 'webapp', 'node_modules', 20_700_000, 'npm install'), command: undefined };
  const named = owned('npm', 'shop', 'node_modules', 9_000_000, 'npm install');
  const summaryOf = async (data: unknown) => {
    const { projects } = await renderPackages(data);
    return (/<summary[\s\S]*?<\/summary>/.exec(projects)?.[0] ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  };
  const said = {
    // Six folders, every one naming a command — the virtualenv's among them.
    all: await summaryOf(CORPUS),
    // A folder that names a command beside one that names none, in one ecosystem.
    some: await summaryOf(pkgReport([pkgGroup('npm', [named, bare])])),
    none: await summaryOf(pkgReport([pkgGroup('npm', [bare])])),
  };
  assert.ok(CORPUS.ecosystems.some((g) => g.entries.some((e) => e.name === '.venv' && e.command === 'python3 -m venv <folder>, then reinstall the packages it held')),
    'control: the corpus holds the virtualenv, with the command its rule names (H08)');
  assert.deepEqual(
    Object.fromEntries(Object.entries(said).map(([k, s]) => [k, /command beside|puts? (it|them) back/.test(s)])),
    { all: false, some: false, none: false },
    `no fold line says a command puts its folders back: ${JSON.stringify(said)}`);
  assert.deepEqual(said, {
    all: 'Folders whose project is still here 6 folders 117900000 B',
    some: 'Folders whose project is still here 2 folders 29700000 B',
    none: 'Folders whose project is still here 1 folder 20700000 B',
  }, 'each says what is true of every folder in it');
});

/*
 * The fold's line then said "each one's project can build it again", and each
 * row's tag "rebuildable". The server's `active` is a folder name its rule
 * knows beside its project's manifest (packageEcosystemScanner): nothing reads
 * what the folder holds, or whether the project lists what is in it. A `.venv`
 * holding hand-installed packages beside nothing but a pyenv pin
 * (`.python-version`) is `active`, and so is a plain folder named `env` there;
 * nothing in that project can build either again. The fold says what the
 * server knows, in its line and in each row's tag: the project is still here
 * (G05 review F3.3).
 */
test('the fold says only what the server knows — each folder\'s project is still here — and never that its project can build it again, in its line or in a row\'s tag (G05 review F3.3)', async () => {
  // The two folders the review found classified `active` with nothing to build them from.
  const pinned = owned('python', 'pinned', '.venv', 2_000_000, 'python3 -m venv <folder>, then reinstall the packages it held');
  const plain = owned('python', 'nodep', 'env', 1_000_000, 'python3 -m venv <folder>, then reinstall the packages it held');
  const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [what, data, rows, line] of [
    ['the QA corpus', CORPUS, 6, 'Folders whose project is still here 6 folders 117900000 B'],
    ['a pinned virtualenv and a plain env folder', pkgReport([pkgGroup('python', [pinned, plain])]), 2, 'Folders whose project is still here 2 folders 3000000 B'],
  ] as const) {
    const { projects } = await renderPackages(data);
    assert.equal(pkgRows(projects).length, rows, `${what}: control, every folder is in the fold`);
    assert.equal(text(/<summary[\s\S]*?<\/summary>/.exec(projects)?.[0] ?? ''), line, `${what}: the fold's line says its project is still here, and no more`);
    assert.deepEqual([...new Set([...projects.matchAll(/<span class="pkg-tag[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]))], ['has project'],
      `${what}: each row's tag says it has a project`);
    assert.doesNotMatch(text(projects), /rebuil|build (it|them) again|can be built/i, `${what}: nothing in the fold says a project can build its folders again`);
  }
});

/**
 * Run the page's loadSmartSuggestions, over its own renderPackageOrphans, on
 * one orphans answer and one suggestions answer; `notes` are the folder notes
 * the page holds. Git repos and browser profiles show nothing.
 */
async function loadSuggestions(orphans: unknown, suggestions: unknown, notes: Array<{ path: string; suppress: boolean }> = []) {
  const dom: Record<string, { innerHTML: string; querySelectorAll(): unknown[]; insertAdjacentHTML(where: string, html: string): void }> = {};
  const $ = (id: string) => (dom[id] ||= {
    innerHTML: '', querySelectorAll: () => [],
    insertAdjacentHTML(_where: string, html: string) { this.innerHTML += html; },
  });
  const api = async (url: string) => (url.startsWith('/api/packages/orphans?') ? orphans
    : url.startsWith('/api/cleanup/suggestions?') ? suggestions : assert.fail(`an unexpected request: ${url}`));
  const state = { scanId: 's1', notes: new Map(notes.map((n) => [n.path, n])) };
  const page = { $, api, state, icon: () => '', escapeHtml: (s: string) => String(s) };
  const renderPackageOrphans = runnable(bodyOf('async function renderPackageOrphans() {'), {
    ...page,
    formatBytes: (n: number) => `${n} B`, formatCount: (n: number) => (n ?? 0).toLocaleString('en-US'),
    formatDate: () => 'Oct 2, 2026', sizeInk: () => 'inherit', ecosystemLabel: (id: string) => id,
    cartButtonHtml: (p: string) => `<cart ${p}>`, refreshCartButtons: () => {}, updateCleanSummary: () => {},
    packageOrphans: [] as unknown[],
  });
  const load = runnable(bodyOf('async function loadSmartSuggestions() {'), {
    ...page, renderPackageOrphans,
    renderGitRepos: () => {}, renderBrowserProfiles: async () => false, skeletonRows: () => '<skeleton>',
    updateCleanSummary: () => {}, smartGroups: [] as unknown[], renderSmartGroups: () => assert.fail('no group to paint'),
  });
  await load();
  const text = (id: string) => $(id).innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return { smart: text('smartResults'), projects: $('packageProjects').innerHTML };
}

/*
 * renderPackageOrphans once answered only for the leftovers above the
 * suggestions, so a scan whose one package folder still had its project —
 * paused by a note, which GET /api/cleanup/suggestions honours and
 * GET /api/packages/orphans does not — said "Nothing in this scan matches the
 * common-junk rules." directly above a fold listing that folder, which a
 * common-junk rule (regen-node-modules) does match (G05 review F2.3).
 */
test('Smart Suggestions never says nothing in the scan matches the common-junk rules above a fold that lists folders they match (G05 review F2.3)', async () => {
  const project = '/corpus/Projects/webapp';
  const live = owned('npm', 'webapp', 'node_modules', 20_700_000, 'npm install');
  const paused = await loadSuggestions(pkgReport([pkgGroup('npm', [live])]), { available: true, groups: [] }, [{ path: project, suppress: true }]);
  assert.ok(pkgRows(paused.projects).some((r) => r.includes(live.path)), 'control: the fold lists the folder');
  assert.doesNotMatch(paused.smart, /Nothing in this scan matches/, `the suggestions do not say nothing matches above it: ${paused.smart}`);
  assert.match(paused.smart, /One folder is excluded by a note that pauses suggestions/, 'and say why the folder is not suggested');
  // Where the scan holds no package folder and nothing matched, it is said.
  const none = await loadSuggestions(pkgReport([]), { available: true, groups: [] });
  assert.equal(none.projects, '', 'control: no fold');
  assert.match(none.smart, /^Nothing in this scan matches the common-junk rules\.$/, 'a scan with nothing to suggest says so');
});

test('the fold of folders whose project is still here sits after Smart Suggestions; the leftovers a person can act on, before them (G05)', () => {
  const pane = INDEX.slice(INDEX.indexOf('<div id="cleanPaneSmart"'), INDEX.indexOf('<div id="cleanPaneVideo"'));
  assert.ok(pane.length > 0, 'the Smart Suggestions pane is in the page');
  const at = (id: string) => pane.indexOf(`<div id="${id}"></div>`);
  assert.ok(at('packageOrphans') !== -1 && at('smartResults') !== -1 && at('packageProjects') !== -1, 'control: all three hosts are in the pane');
  assert.ok(at('packageOrphans') < at('smartResults'), 'orphans and caches come before the suggestions');
  assert.ok(at('smartResults') < at('packageProjects'), 'folders whose project is still here come after them');
});

/*
 * The fold is the first <details> in a sheet. A sheet's Tab trap
 * (modalFocusables, 235) lists `a[href], button, input, select, textarea,
 * [tabindex]`, and a bare <summary> is none of those: with nothing ticked
 * (Clean Up's confirm button disabled, so out of the list) Tab on the last
 * suggestion's box wrapped to the ✕ and the fold could be opened only with a
 * mouse; from the summary itself, Tab and Shift+Tab jumped to the sheet's
 * ends (G05 review F1.6).
 */
test('the fold\'s summary is a stop the sheet\'s Tab trap lists, so a keyboard reaches it with nothing ticked (G05 review F1.6)', async () => {
  const { projects } = await renderPackages(CORPUS);
  const tag = /<summary\b[^>]*>/.exec(projects)?.[0] ?? '';
  assert.ok(tag, 'control: the fold opens with its summary');
  // The trap's own selector, as the page has it.
  const selector = /querySelectorAll\('([^']+)'\)/.exec(bodyOf('function modalFocusables(root) {'))?.[1] ?? '';
  assert.match(selector, /\[tabindex\]/, `control: the trap's selector is in the page (${selector})`);
  const attrs = new Map([...tag.matchAll(/\s([a-z-]+)(?:="([^"]*)")?/g)].map((m) => [m[1], m[2] ?? '']));
  const matches = (simple: string) => {
    const m = /^([a-z]*)((?:\[[a-z-]+\])*)$/.exec(simple.trim());
    return !!m && (!m[1] || m[1] === 'summary') && [...m[2].matchAll(/\[([a-z-]+)\]/g)].every((a) => attrs.has(a[1]));
  };
  assert.ok(selector.split(',').some(matches), `the trap's selector lists the fold's summary: ${tag}`);
  // …and its filter keeps it: a stop has tabIndex >= 0.
  assert.ok(Number(attrs.get('tabindex')) >= 0, `the summary is a Tab stop, not taken out of the order: ${tag}`);
});

/* ═══════ "Select all" follows its rows, in every list of the sheet (sixth browser pass H09) ═══════ */

/** A checkbox, as the lists' rows and "Select all" boxes are. */
type Box = { id?: string; className: string; checked: boolean; indeterminate: boolean; classList: { contains(c: string): boolean } };
const box = (className: string, checked: boolean, id?: string): Box => ({
  id, className, checked, indeterminate: false, classList: { contains: (c: string) => className.split(' ').includes(c) },
});

/** A list host as the page wires it: delegated change listeners, its rows and its "Select all" box. */
function selectAllList(allId: string, rowClass: string, ticks: boolean[]) {
  const all = box('', true, allId);
  const rows = ticks.map((t) => box(rowClass, t));
  const listeners: Array<(e: { target: Box }) => void> = [];
  const host = {
    addEventListener: (type: string, fn: (e: { target: Box }) => void) => { assert.equal(type, 'change'); listeners.push(fn); },
    querySelectorAll: (q: string) => (q === `.${rowClass}` ? rows : []),
  };
  let summaries = 0;
  const fns = new Function('$', `${['syncSelectAll', 'wireSelectAll'].map((n) => {
    const at = INDEX.indexOf(`function ${n}(`);
    assert.notEqual(at, -1, `${n} is in the built page`);
    const open = INDEX.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < INDEX.length; i++) {
      if (INDEX[i] === '{') depth++;
      else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(at, i + 1);
    }
    return assert.fail(`${n} never closes`);
  }).join('\n')}\nreturn { syncSelectAll, wireSelectAll };`)((id: string) => (id === allId ? all : null)) as {
    syncSelectAll(all: Box, rows: Box[]): void; wireSelectAll(host: unknown, allId: string, rowClass: string, onChange: () => void): void;
  };
  fns.wireSelectAll(host, allId, rowClass, () => { summaries++; });
  const change = (target: Box) => { for (const fn of listeners) fn({ target }); };
  return { all, rows, change, summaries: () => summaries, listeners: () => listeners.length, sync: fns.syncSelectAll };
}

test('a list\'s "Select all" box is ticked, clear or indeterminate exactly as its rows are, as the browser profiles\' boxes are (H09)', () => {
  for (const [allId, rowClass] of [['cleanAll', 'clean-ck'], ['emptyAll', 'empty-ck']] as const) {
    const l = selectAllList(allId, rowClass, [true, true, true]);
    assert.equal(l.listeners(), 1, `${allId}: one delegated listener, however many rows`);
    l.rows[1].checked = false; l.change(l.rows[1]);
    assert.deepEqual([l.all.checked, l.all.indeterminate], [false, true], `${allId}: one row unticked — the box is indeterminate, not still ticked`);
    for (const r of l.rows) r.checked = false;
    l.change(l.rows[0]);
    assert.deepEqual([l.all.checked, l.all.indeterminate], [false, false], `${allId}: no row ticked — the box is clear`);
    for (const r of l.rows) r.checked = true;
    l.change(l.rows[2]);
    assert.deepEqual([l.all.checked, l.all.indeterminate], [true, false], `${allId}: every row ticked — the box is ticked`);
    l.rows[0].checked = false; l.change(l.rows[0]);
    l.all.checked = true; l.change(l.all); // pressing "Select all" from indeterminate
    assert.deepEqual(l.rows.map((r) => r.checked), [true, true, true], `${allId}: "Select all" ticks every row`);
    assert.equal(l.all.indeterminate, false, `${allId}: and is no longer indeterminate`);
    l.all.checked = false; l.change(l.all);
    assert.deepEqual(l.rows.map((r) => r.checked), [false, false, false], `${allId}: and clears every row`);
    assert.equal(l.summaries(), 6, `${allId}: every change, row or box, refreshes the summary`);
  }
});

test('both lists and the browser profiles share the one helper, and the Custom Rules list is wired once, not again on every Find (H09)', () => {
  assert.match(INDEX, /wireSelectAll\(\$\('cleanResults'\), 'cleanAll', 'clean-ck', updateCleanSummary\);/, 'Custom Rules');
  assert.match(INDEX, /wireSelectAll\(\$\('emptyResults'\), 'emptyAll', 'empty-ck', updateCleanSummary\);/, 'Empty Folders');
  const find = INDEX.slice(INDEX.indexOf('async function runCleanFind('), INDEX.indexOf('/** How many paths one onDisk question carries'));
  assert.doesNotMatch(find, /addEventListener\('change'/, 'runCleanFind adds no listeners of its own: a delegated one on the host would pile up on every Find');
  assert.match(INDEX, /syncSelectAll\(all, cks\)/, 'the browser profiles\' boxes follow their rows through the same helper');
  // The helper itself, on an empty list: nothing to tick is not "all ticked".
  const l = selectAllList('cleanAll', 'clean-ck', []);
  l.sync(l.all, []);
  assert.deepEqual([l.all.checked, l.all.indeterminate], [false, false], 'an empty list ticks nothing');
});

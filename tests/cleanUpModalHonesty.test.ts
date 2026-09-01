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
    refreshCartButtons: () => {},
    updateCleanSummary: () => {},
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

const CONFIRM_ARROW = "$('cleanConfirmBtn').addEventListener('click', async () => {";
const CONFIRM_NAMED = 'async function runCleanTrash() {';

/**
 * The body of the Move-to-Trash handler, whether it is a named function or an
 * inline arrow on the listener. What is pinned below is the report it produces;
 * where the app chooses to keep it is not this test's business.
 */
function confirmBody(): string {
  if (INDEX.includes(CONFIRM_NAMED)) return bodyOf(CONFIRM_NAMED);
  const start = INDEX.indexOf(CONFIRM_ARROW);
  assert.notEqual(start, -1, 'the Move to Trash handler is findable');
  const open = start + CONFIRM_ARROW.length - 1;
  return INDEX.slice(open + 1, matchingBrace(open));
}

interface TrashResult { deleted: string[]; failed: { path: string; reason: string }[]; blocked?: string[] }

/** Run the Move-to-Trash handler against one canned `trashPaths` outcome. */
async function runConfirm(sel: { paths: string[]; sizes: Map<string, number> }, result: TrashResult) {
  const body = confirmBody();
  const { els, $ } = makeDom();
  const toasts: { msg: string; kind?: string }[] = [];
  const trashed: string[][] = [];
  let rescans = 0;
  const bytes = [...sel.sizes.values()].reduce((s, v) => s + v, 0);
  const fn = runnable(body, {
    $,
    activeCleanSelection: () => ({ ...sel, bytes, noun: 'item' }),
    trashPaths: async (chunk: string[]) => { trashed.push(chunk); return result; },
    closeModal: () => {},
    toast: (msg: string, kind?: string) => { toasts.push({ msg, kind }); },
    formatBytes: (n: number) => `${n}B`,
    icon: () => '',
    REDUCED: true,
    rescan: () => { rescans++; },
  });
  await fn();
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

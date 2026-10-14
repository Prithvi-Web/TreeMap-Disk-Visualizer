import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * D62: the shared confirmation dialog showed "Cancel" and "Close" side by side.
 *
 * Every view asks through one dialog, #confirmModal. Two of the cart's uses of
 * it do not ask anything — the dry run that finds nothing it may delete, and
 * the "Done" summary after a commit — so they relabel OK as "Close". The
 * markup's Cancel stayed, and the dialog offered two buttons that both just
 * close it.
 *
 * Those two now hide Cancel. And because the dialog is shared, the footer has
 * to come back however the dialog is closed: before this, a "Close" label left
 * by the cart stayed on the OK button for the next dialog that did not reset
 * it — Empty the Trash among them — so a button reading "Close" would have
 * emptied the Trash. closeModal('confirmModal') — every way the dialog
 * closes — now puts Cancel back and the OK label to "Move to Trash".
 *
 * Nothing here deletes: the dry run and the commit are stubs, and only the
 * dialog's own code runs, out of the built page.
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

function declOf(name: string): string {
  const m = new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`).exec(INDEX);
  assert.ok(m, `function ${name} exists in the built page`);
  const open = INDEX.indexOf(') {', m!.index) + 2;
  return INDEX.slice(m!.index, matchingBrace(open) + 1);
}

test('the dialog\'s Cancel can be found, so a report-only dialog can hide it', () => {
  const sheet = INDEX.slice(INDEX.indexOf('id="confirmModal"'), INDEX.indexOf('id="confirmOk"'));
  assert.match(sheet, /<button class="btn" id="confirmCancel" data-close="confirmModal">Cancel<\/button>/);
});

function harness(plan: { items: { path: string; willDelete: boolean; reason?: string }[] }) {
  const els: Record<string, any> = {};
  const $ = (id: string) => (els[id] ||= (() => {
    const classes = new Set<string>();
    return {
      innerHTML: '', textContent: '', hidden: false, disabled: false, style: {}, classes,
      classList: { add: (c: string) => { classes.add(c); }, remove: (c: string) => { classes.delete(c); } },
    };
  })());
  const deps: Record<string, unknown> = {
    $,
    state: { cart: new Set(plan.items.map((i) => i.path)) },
    ensureNodes: async () => {},
    nodeFor: () => ({ name: 'x', size: 1 }),
    cartKnownPaths: () => plan.items.map((i) => i.path),
    cartDryRun: async () => plan,
    cartManifestHtml: () => 'manifest',
    cartExecuteCommit: async () => {},
    icon: (name: string) => `[${name}]`,
    escapeHtml: (s: string) => s,
    formatBytes: (n: number) => `${n}B`,
    formatCount: (n: number) => String(n),
    toast: () => {},
    REDUCED: true,
    checkOpenHandlesFor: async () => {},
    cloudProviderOfScan: () => ({ name: 'Drive', trashLabel: 'its trash' }),
    cloudTrashPaths: async () => {},
    baseName: (p: string) => p,
    // closeModal's other per-sheet teardown, untouched here
    clearInterval: () => {}, cloudConnectPoll: 0, fxOrbHide: () => {}, cleanFunnelDrop: () => {},
    FxBeam: { attach: () => {} }, activeJob: null, askSettle: () => {},
  };
  const helpers = ['confirmFooterReset'].filter((n) => new RegExp(`function ${n}\\s*\\(`).test(INDEX));
  const keys = Object.keys(deps);
  const src = `
    let openHandleSeq = 0, confirmIgnoreOpenHandles = false, confirmPaths = [], onConfirmTrash = null;
    let cartCommitKey = '', cartLastRun = null;
    ${helpers.map(declOf).join('\n')}
    ${declOf('setConfirmButton')}
    ${declOf('resetOpenHandleWarning')}
    ${declOf('tmParentPath')}
    ${declOf('outermostPaths')}
    ${declOf('confirmTrash')}
    ${declOf('cartTrashAll')}
    ${declOf('cartCommitSummary')}
    ${declOf('cartSpaceSaid')}
    ${declOf('closeModal')}
    return { cartTrashAll, cartCommitSummary, closeModal, confirmTrash };`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const page = new Function(...keys, src)(...keys.map((k) => deps[k]));
  return {
    page,
    cancelShown: () => !$('confirmCancel').hidden,
    okLabel: () => $('confirmOk').innerHTML,
    open: () => $('confirmModal').classes.has('open'),
  };
}

const NOTHING = { items: [{ path: '/r/huge', willDelete: false, reason: 'too large to protect' }] };
const SOME = { items: [{ path: '/r/a', willDelete: true }] };

test('a cart dry run that can delete nothing shows one Close, not Cancel and Close', async () => {
  const h = harness(NOTHING);
  await h.page.cartTrashAll();
  assert.ok(h.open(), 'the manifest is shown');
  assert.match(h.okLabel(), /Close/);
  assert.equal(h.cancelShown(), false, 'Cancel would do exactly what Close does');
});

test('a cart dry run that can delete still asks, with its Cancel', async () => {
  const h = harness(SOME);
  await h.page.cartTrashAll();
  assert.match(h.okLabel(), /Move to Trash/);
  assert.equal(h.cancelShown(), true, 'a question keeps its way out');
});

test('the Done summary shows one Close', async () => {
  const h = harness(SOME);
  h.page.cartCommitSummary({ runId: 'r1', trashed: ['/r/a'], bytesFreed: 1, skipped: [], failedToTrash: [], unverified: [] });
  assert.match(h.okLabel(), /Close/);
  assert.equal(h.cancelShown(), false);
});

test('however a report-only dialog closes, the next dialog gets its Cancel and a Move to Trash button back', async () => {
  const h = harness(NOTHING);
  await h.page.cartTrashAll();
  h.page.closeModal('confirmModal'); // Close, ×, the scrim and Escape all end here
  assert.equal(h.cancelShown(), true, 'Cancel is back for whichever dialog opens next');
  assert.doesNotMatch(h.okLabel(), /Close/,
    'and "Close" does not linger on a button the next dialog — Empty the Trash — wires to a delete');
  assert.match(h.okLabel(), /Move to Trash/);
});

test('after a report closes, the next asking dialog has its Cancel and its delete label', async () => {
  const h = harness(SOME);
  h.page.cartCommitSummary({ runId: 'r1', trashed: ['/r/a'], bytesFreed: 1, skipped: [], failedToTrash: [], unverified: [] });
  h.page.closeModal('confirmModal');
  await h.page.confirmTrash(['/r/b']);
  assert.ok(h.open());
  assert.equal(h.cancelShown(), true);
  assert.match(h.okLabel(), /Move to Trash/);
});

/* ═══════ an open-file answer that lands after Cancel is dropped ═══════ */

/**
 * The dialog asks the server, in the background, whether anything has the
 * selection open (B2). Clean Up now asks for every selection — possibly
 * thousands of paths, so the answer can take a while (D53). Closing the
 * dialog did not abandon that question: an answer landing after Cancel
 * relabelled the closed dialog's OK "Delete anyway" and armed the override,
 * and the next dialog that does not reset the guard — Empty the Trash — opened
 * with that label. Closing the dialog now drops any answer still on its way.
 */
function constOf(name: string): string {
  const m = new RegExp(`const ${name} = [^\\n]*;`).exec(INDEX);
  assert.ok(m, `const ${name} exists in the built page`);
  return m![0];
}

function lateAnswerHarness() {
  const els: Record<string, any> = {};
  const $ = (id: string) => (els[id] ||= (() => {
    const classes = new Set<string>();
    return {
      innerHTML: '', textContent: '', className: '', hidden: false, disabled: false, style: {}, classes,
      classList: { add: (c: string) => { classes.add(c); }, remove: (c: string) => { classes.delete(c); } },
    };
  })());
  let answer: (v: unknown) => void = () => {};
  const trashed: { paths: string[]; opts: Record<string, unknown> }[] = [];
  const deps: Record<string, unknown> = {
    $,
    api: () => new Promise((resolve) => { answer = resolve; }),
    trashPaths: async (paths: string[], opts: Record<string, unknown>) => { trashed.push({ paths: [...paths], opts }); return { deleted: [], failed: [] }; },
    ensureNodes: async () => {},
    nodeFor: () => ({ name: 'a', size: 1 }),
    icon: () => '',
    escapeHtml: (s: string) => s,
    formatBytes: (n: number) => `${n}B`,
    formatCount: (n: number) => String(n),
    cloudProviderOfScan: () => ({ name: 'Drive', trashLabel: 'its trash' }),
    cloudTrashPaths: async () => {},
    clearInterval: () => {}, cloudConnectPoll: 0, fxOrbHide: () => {}, cleanFunnelDrop: () => {},
    FxBeam: { attach: () => {} }, activeJob: null, askSettle: () => {}, toast: () => {},
  };
  const keys = Object.keys(deps);
  const src = `
    let openHandleSeq = 0, confirmIgnoreOpenHandles = false, confirmPaths = [], onConfirmTrash = null;
    ${constOf('TRASH_CHUNK')}
    ${constOf('OPEN_HANDLE_PREFLIGHT_CHUNKS')}
    ${['setConfirmButton', 'confirmFooterReset', 'baseName', 'renderOpenHandleWarning', 'checkOpenHandlesFor',
      'resetOpenHandleWarning', 'tmParentPath', 'outermostPaths', 'confirmTrash', 'closeModal'].map(declOf).join('\n')}
    return {
      confirmTrash, closeModal, override: () => confirmIgnoreOpenHandles,
      ok: async () => {${okBody()}},
    };`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const page = new Function(...keys, src)(...keys.map((k) => deps[k]));
  return { page, $, trashed, answer: (v: unknown) => answer(v) };
}

/** The shared OK button's click handler, out of the built page. */
function okBody(): string {
  const anchor = "$('confirmOk').addEventListener('click', async () => {";
  const start = INDEX.indexOf(anchor);
  assert.notEqual(start, -1, 'the OK handler is findable');
  const open = start + anchor.length - 1;
  return INDEX.slice(open + 1, matchingBrace(open));
}

/** Let a resolved request's continuations run: event-loop turns, not a clock. */
const turns = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

test('an open-file answer that arrives after Cancel neither relabels the dialog nor arms "Delete anyway"', async () => {
  const h = lateAnswerHarness();
  await h.page.confirmTrash(['/r/a']);
  h.page.closeModal('confirmModal'); // Cancel, while the check is still out
  h.answer({ checked: true, complete: true, conflicts: [{ path: '/r/a', pid: 7, processName: 'Editor' }] });
  await turns();
  assert.doesNotMatch(h.$('confirmOk').innerHTML, /Delete anyway/, 'the next dialog to open would show this label');
  assert.equal(h.page.override(), false, 'and no override is armed for it');
});

test('an answer that arrives while the dialog is open still warns', async () => {
  const h = lateAnswerHarness();
  await h.page.confirmTrash(['/r/a']);
  h.answer({ checked: true, complete: true, conflicts: [{ path: '/r/a', pid: 7, processName: 'Editor' }] });
  await turns();
  assert.match(h.$('confirmOk').innerHTML, /Delete anyway/, 'the warning the user is looking at');
  assert.equal(h.page.override(), true);
  // Pressing it: the dialog closes first (which abandons checks), and the
  // choice the user made in it still reaches the delete.
  await h.page.ok();
  assert.deepEqual(h.trashed, [{ paths: ['/r/a'], opts: { ignoreOpenHandles: true } }], '"Delete anyway" is what was sent');
});

/* ═══════ each sheet's OK says what that sheet does (review F3.2 of QA third pass) ═══════ */

/**
 * The OK button reads "Move to Trash", with the trash icon, until a dialog
 * relabels it, and closeModal puts that back after every dialog. The sheets
 * whose action is not a move to the Trash did not relabel it: "Re-encode and replace?"
 * (a lossy HEVC re-encode), "Empty the Trash?" (a permanent delete — beside
 * "This cannot be undone"), "Purge local snapshots?", "Forget this copy?",
 * "Run git gc?", "Move it somewhere safer?" (a move that deletes nothing) and
 * the Autopilot approval each offered a recoverable "Move to Trash".
 */

/** The block of a function or listener whose header is `anchor` (a `{` ends it), as page source. */
function blockAt(anchor: string, from = 0): string {
  const at = INDEX.indexOf(anchor, from);
  assert.notEqual(at, -1, `"${anchor}" is in the built page`);
  const open = at + anchor.length - 1;
  assert.equal(INDEX[open], '{', `"${anchor}" ends at its block's {`);
  return INDEX.slice(at, matchingBrace(open) + 1);
}

/** The git gc button's listener: a document-level click handler, found by what it looks for. */
function gitGcListener(): string {
  const anchor = "document.addEventListener('click', (e) => {";
  return blockAt(anchor, INDEX.lastIndexOf(anchor, INDEX.indexOf("e.target.closest('[data-gc]')")));
}

/** Run one opener (`body` is its block) over stubs, and read the OK button it leaves. */
function okLabelAfter(block: string, arg: unknown): { label: string; icon: string; opened: boolean } {
  const els: Record<string, any> = {};
  const $ = (id: string) => (els[id] ||= (() => {
    const classes = new Set<string>();
    return { innerHTML: '', textContent: '', hidden: false, disabled: false, style: {}, classes,
      classList: { add: (c: string) => { classes.add(c); }, remove: (c: string) => { classes.delete(c); } } };
  })());
  // The button as every close leaves it (confirmFooterReset): the trash icon and "Move to Trash".
  $('confirmOk').innerHTML = '[trash]Move to Trash';
  const deps: Record<string, unknown> = {
    $, icon: (name: string) => `[${name}]`, escapeHtml: (s: string) => s, formatBytes: (n: number) => `${n}B`, formatCount: String,
    toast: () => {}, api: async () => ({}), closeModal: () => {}, rescan: () => {}, baseName: (p: string) => p,
    describeMatch: () => 'files', loadAutopilot: () => {}, loadCapsule: () => {},
    startEncode: () => {}, emptyTrashAction: () => {}, purgeSnapshotsAction: () => {}, runGitGcAction: () => {},
    onConfirmTrash: null,
    state: {
      trash: { itemCount: 3, totalBytes: 300, complete: true },
      snapshots: { snapshots: [{}, {}] },
      capsule: { index: { entries: [{ id: 'c1', name: 'a.zip', sizeBytes: 10 }] } },
      autopilot: { runs: [{ id: 'r1', policyId: 'p1', bytesMatched: 5 }], policies: [{ id: 'p1', name: 'Old downloads', path: '/d', match: {} }] },
    },
  };
  const keys = Object.keys(deps);
  const params = /^(?:async\s+)?function \w+\((\w*)\)/.exec(block)?.[1] ?? /\((\w*)\) => \{$/.exec(block.slice(0, block.indexOf('{') + 1))?.[1] ?? '';
  const body = block.slice(block.indexOf('{') + 1, -1);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function(...keys, `${declOf('setConfirmButton')}\nreturn function (${params}) {${body}\n};`)(...keys.map((k) => deps[k]));
  run(arg);
  const html: string = els.confirmOk.innerHTML;
  return { label: html.replace(/^\[\w+\]/, ''), icon: /^\[(\w+)\]/.exec(html)?.[1] ?? '', opened: els.confirmModal?.classes.has('open') ?? false };
}

test('a sheet whose action is not a move to the Trash says on its OK button what it does — never "Move to Trash" (review F3.2 of QA third pass)', () => {
  const gcClick = { target: { closest: (sel: string) => (sel === '[data-gc]' ? { getAttribute: () => '/repos/site' } : null) } };
  const cases: Array<[string, string, unknown, string, string]> = [
    // [what it is, its block, its argument, the OK label, the OK icon]
    ['the re-encode sheet', blockAt('function confirmEncode(chosen) {'), [{ path: '/v/a.mov', estimatedSaving: 9 }], 'Re-encode', 'video'],
    ['Empty the Trash', blockAt("$('emptyTrashBtn').addEventListener('click', () => {"), undefined, 'Empty the Trash', 'trash'],
    ['Purge local snapshots', blockAt("$('snapPurgeBtn').addEventListener('click', () => {"), undefined, 'Purge snapshots', 'clock'],
    ['Forget this copy', blockAt('function forgetCapsuleEntry(id) {'), 'c1', 'Forget this copy', 'trash'],
    ['Run git gc', gitGcListener(), gcClick, 'Run git gc', 'gitBranch'],
    ['Move it somewhere safer', blockAt('function confirmRelocateSecret(finding) {'), { name: 'id_rsa', path: '/h/Desktop/id_rsa', suggestedPath: '/h/.ssh' }, 'Move it', 'shield'],
    ['the Autopilot approval', blockAt('function approveAutopilotRun(runId) {'), 'r1', 'Approve', 'check'],
  ];
  for (const [what, block, arg, label, icon] of cases) {
    const ok = okLabelAfter(block, arg);
    assert.ok(ok.opened, `control: ${what} opened the sheet`);
    assert.doesNotMatch(ok.label, /Move to Trash/, `${what} is not a move to the Trash, so its OK must not read as one`);
    assert.deepEqual({ label: ok.label, icon: ok.icon }, { label, icon }, `${what}'s OK names its own action`);
  }
});

test('every place that opens the shared sheet is accounted for, with the OK label it shows (review F3.2 of QA third pass)', () => {
  // A new opener that relabels nothing shows whatever the last close left —
  // "Move to Trash". Listing every opener here makes adding one a decision
  // about its button, not an accident of the default.
  const OPEN = "$('confirmModal').classList.add('open')";
  const openers: Array<[string, number, string]> = [
    // [its block, how many times it opens the sheet, the OK label it shows]
    [blockAt('async function confirmTrash(paths) {'), 2, 'Move to Trash'],
    [blockAt('async function reofferBlockedTrash(paths, err) {'), 1, 'Move to Trash'],
    [blockAt('function clearShaderCaches() {'), 1, 'Move to Trash'],
    [blockAt('async function cartTrashAll() {'), 1, 'Move to Trash'],
    [blockAt('function cartCommitSummary(result) {'), 1, 'Close'],
    [blockAt('async function dockDrop(volPath) {'), 1, 'Copy, verify, then trash'],
    [blockAt('function confirmZombieRestart(p) {'), 1, 'Restart it'],
    [blockAt('function confirmEncode(chosen) {'), 1, 'Re-encode'],
    [blockAt("$('emptyTrashBtn').addEventListener('click', () => {"), 1, 'Empty the Trash'],
    [blockAt("$('snapPurgeBtn').addEventListener('click', () => {"), 1, 'Purge snapshots'],
    [blockAt('function forgetCapsuleEntry(id) {'), 1, 'Forget this copy'],
    [gitGcListener(), 1, 'Run git gc'],
    [blockAt('function confirmRelocateSecret(finding) {'), 1, 'Move it'],
    [blockAt('function approveAutopilotRun(runId) {'), 1, 'Approve'],
  ];
  const count = (text: string) => text.split(OPEN).length - 1;
  for (const [block, opens, label] of openers) {
    const header = block.slice(0, block.indexOf('{'));
    assert.equal(count(block), opens, `${header} opens the sheet ${opens} time(s)`);
    // The default is "Move to Trash" (resetOpenHandleWarning and every close set it); any other label is written by the opener.
    if (label !== 'Move to Trash') assert.ok(block.includes(`'${label}'`), `${header} writes its own OK label, "${label}"`);
  }
  const listed = openers.reduce((n, [, opens]) => n + opens, 0);
  assert.equal(count(INDEX), listed, `every opening of the sheet is one listed here (${count(INDEX)} in the page, ${listed} listed)`);
});

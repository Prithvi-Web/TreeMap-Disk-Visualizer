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
    // confirmTrash asks which paths are parts of an installed program (fifth browser pass F01): none here.
    api: async (url: string) => (url === '/api/files/installed-programs' ? { parts: [] } : assert.fail(`unexpected request ${url}`)),
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
    ${constOf('INSTALLED_PROGRAM_CHUNK')}
    ${['installedProgramParts', 'installedProgramWords', 'installedProgramRemoval', 'installedProgramWarningHtml'].map(declOf).join('\n')}
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
    // The open-file answer waits for the test to give it; confirmTrash's installed-programs
    // question (fifth browser pass F01) is answered at once: no part of any program.
    api: (url: string) => (url === '/api/files/installed-programs' ? Promise.resolve({ parts: [] }) : new Promise((resolve) => { answer = resolve; })),
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
      'resetOpenHandleWarning', 'tmParentPath', 'outermostPaths', 'installedProgramParts', 'installedProgramWords',
      'installedProgramRemoval', 'installedProgramWarningHtml', 'confirmTrash', 'closeModal'].map(declOf).join('\n')}
    ${constOf('INSTALLED_PROGRAM_CHUNK')}
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

test('an open-file answer that arrives after Cancel neither relabels the dialog nor arms its "… anyway" override', async () => {
  const h = lateAnswerHarness();
  await h.page.confirmTrash(['/r/a']);
  h.page.closeModal('confirmModal'); // Cancel, while the check is still out
  h.answer({ checked: true, complete: true, conflicts: [{ path: '/r/a', pid: 7, processName: 'Editor' }] });
  await turns();
  assert.doesNotMatch(h.$('confirmOk').innerHTML, /anyway/, 'the next dialog to open would show this label');
  assert.equal(h.page.override(), false, 'and no override is armed for it');
});

test('an answer that arrives while the dialog is open still warns', async () => {
  const h = lateAnswerHarness();
  await h.page.confirmTrash(['/r/a']);
  h.answer({ checked: true, complete: true, conflicts: [{ path: '/r/a', pid: 7, processName: 'Editor' }] });
  await turns();
  assert.match(h.$('confirmOk').innerHTML, /Move to Trash anyway/, 'the warning the user is looking at');
  assert.equal(h.page.override(), true);
  // Pressing it: the dialog closes first (which abandons checks), and the
  // choice the user made in it still reaches the delete.
  await h.page.ok();
  assert.deepEqual(h.trashed, [{ paths: ['/r/a'], opts: { ignoreOpenHandles: true } }], '"Move to Trash anyway" is what was sent');
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
    startEncode: () => {}, emptyTrashAction: () => {}, purgeSnapshotsAction: () => {}, runGitGcAction: () => {}, installedProgramWarningHtml: () => '',
    onConfirmTrash: null,
    state: {
      trash: { itemCount: 3, totalBytes: 300, complete: true },
      snapshots: { snapshots: [{}, {}] },
      capsule: { index: { entries: [{ id: 'c1', name: 'a.zip', sizeBytes: 10 }] } },
      autopilot: { runs: [{ id: 'r1', policyId: 'p1', bytesMatched: 5 }], policies: [{ id: 'p1', name: 'Old downloads', path: '/d', match: {} }] },
    },
  };
  const keys = Object.keys(deps);
  const params = /^(?:async\s+)?function \w+\(([\w, ]*)\)/.exec(block)?.[1] ?? /\((\w*)\) => \{$/.exec(block.slice(0, block.indexOf('{') + 1))?.[1] ?? '';
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
    ['the re-encode sheet', blockAt('function confirmEncode(chosen, parts) {'), [{ path: '/v/a.mov', estimatedSaving: 9 }], 'Re-encode', 'video'],
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
    [blockAt('async function confirmOffloadPlan(paths, dest, destName, notes, isCurrent, withSheet = null) {'), 1, 'Copy, verify, then trash'],
    [blockAt('function confirmZombieRestart(p) {'), 1, 'Restart it'],
    [blockAt('function confirmEncode(chosen, parts) {'), 1, 'Re-encode'],
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

/* ═══════ a cancelled sheet's "in use" warning reaches no later sheet (sixth browser pass H01) ═══════ */

/**
 * The open-file panel (#confirmOpenHandles) and the override it arms belong
 * to the one sheet that asked about its files. Cancelled with a warning up,
 * the trash sheet left both behind: the next sheet to open — Empty the
 * Trash, beside "This cannot be undone" — showed "This file is in use" about
 * files it never named, with the override still armed. Only the openers that
 * reset the guard themselves were clear; every close now clears both, so no
 * opener can forget.
 */
function sheetWorld() {
  const els: Record<string, any> = {};
  const $ = (id: string) => (els[id] ||= (() => {
    const classes = new Set<string>();
    return {
      innerHTML: '', textContent: '', className: '', hidden: false, disabled: false, style: {}, classes,
      classList: { add: (c: string) => { classes.add(c); }, remove: (c: string) => { classes.delete(c); } },
    };
  })());
  let answer: (v: unknown) => void = () => {};
  const deps: Record<string, unknown> = {
    $,
    api: (url: string) => (url === '/api/files/installed-programs' ? Promise.resolve({ parts: [] }) : new Promise((resolve) => { answer = resolve; })),
    trashPaths: async () => ({ deleted: [], failed: [] }),
    ensureNodes: async () => {},
    nodeFor: () => ({ name: 'a', size: 1 }),
    icon: (name: string) => `[${name}]`,
    escapeHtml: (s: string) => s,
    formatBytes: (n: number) => `${n}B`,
    formatCount: (n: number) => String(n),
    cloudProviderOfScan: () => ({ name: 'Drive', trashLabel: 'its trash' }),
    cloudTrashPaths: async () => {},
    clearInterval: () => {}, cloudConnectPoll: 0, fxOrbHide: () => {}, cleanFunnelDrop: () => {},
    FxBeam: { attach: () => {} }, activeJob: null, askSettle: () => {}, toast: () => {},
    rescan: () => {}, describeMatch: () => 'files', loadAutopilot: () => {}, loadCapsule: () => {},
    startEncode: () => {}, emptyTrashAction: () => {}, purgeSnapshotsAction: () => {}, runGitGcAction: () => {},
    state: {
      trash: { itemCount: 3, totalBytes: 300, complete: true },
      snapshots: { snapshots: [{}, {}] },
      capsule: { index: { entries: [{ id: 'c1', name: 'a.zip', sizeBytes: 10 }] } },
      autopilot: { runs: [{ id: 'r1', policyId: 'p1', bytesMatched: 5 }], policies: [{ id: 'p1', name: 'Old downloads', path: '/d', match: {} }] },
      games: { report: { libraries: [{ titles: [{ components: [{ kind: 'shaderCache', path: '/g/shaders', bytes: 7 }] }] }] } },
      capsuleOff: false,
    },
  };
  const gcClick = { target: { closest: (sel: string) => (sel === '[data-gc]' ? { getAttribute: () => '/repos/site' } : null) } };
  // Every sheet the browser pass opened after the cancelled trash sheet, with the arguments it is opened with.
  const openers: Array<[string, string, unknown[]]> = [
    ['Empty the Trash', blockAt("$('emptyTrashBtn').addEventListener('click', () => {"), []],
    ['Purge local snapshots', blockAt("$('snapPurgeBtn').addEventListener('click', () => {"), []],
    ['Forget this copy', blockAt('function forgetCapsuleEntry(id) {'), ['c1']],
    ['Clear shader caches', blockAt('function clearShaderCaches() {'), []],
    ['Move it somewhere safer', blockAt('function confirmRelocateSecret(finding) {'), [{ name: 'id_rsa', path: '/h/Desktop/id_rsa', suggestedPath: '/h/.ssh' }]],
    ['the re-encode sheet', blockAt('function confirmEncode(chosen, parts) {'), [[{ path: '/v/a.mov', estimatedSaving: 9 }], []]],
    ['Run git gc', gitGcListener(), [gcClick]],
    ['the Autopilot approval', blockAt('function approveAutopilotRun(runId) {'), ['r1']],
    ['the cart\'s Done', blockAt('function cartCommitSummary(result) {'), [{ runId: 'r1', trashed: ['/r/x'], bytesFreed: 1, skipped: [], failedToTrash: [], unverified: [] }]],
  ];
  const asFunction = (block: string): string => {
    const params = /^(?:async\s+)?function \w+\(([\w, ]*)\)/.exec(block)?.[1] ?? /\((\w*)\) => \{$/.exec(block.slice(0, block.indexOf('{') + 1))?.[1] ?? '';
    return `function (${params}) {${block.slice(block.indexOf('{') + 1, -1)}\n}`;
  };
  const keys = Object.keys(deps);
  const src = `
    let openHandleSeq = 0, confirmIgnoreOpenHandles = false, confirmPaths = [], onConfirmTrash = null;
    ${constOf('TRASH_CHUNK')}
    ${constOf('OPEN_HANDLE_PREFLIGHT_CHUNKS')}
    ${constOf('INSTALLED_PROGRAM_CHUNK')}
    ${['setConfirmButton', 'confirmFooterReset', 'baseName', 'renderOpenHandleWarning', 'checkOpenHandlesFor',
      'resetOpenHandleWarning', 'tmParentPath', 'outermostPaths', 'installedProgramParts', 'installedProgramWords',
      'installedProgramRemoval', 'installedProgramWarningHtml', 'confirmTrash', 'closeModal', 'cartSpaceSaid'].map(declOf).join('\n')}
    const openers = [${openers.map(([, block]) => asFunction(block)).join(',\n')}];
    return { confirmTrash, closeModal, override: () => confirmIgnoreOpenHandles, openers };`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const page = new Function(...keys, src)(...keys.map((k) => deps[k]));
  return {
    page, $, answer: (v: unknown) => answer(v),
    openers: openers.map(([what, , args], i) => ({ what, open: () => page.openers[i](...args) })),
  };
}

test('a trash sheet cancelled with its "in use" warning up leaves no warning and no override on any sheet opened after it (sixth browser pass H01)', async () => {
  const w = sheetWorld();
  assert.equal(w.openers.length, 9, 'every non-trash sheet of the browser pass is opened here');
  for (const { what, open } of w.openers) {
    await w.page.confirmTrash(['/r/held']);
    w.answer({ checked: true, complete: true, conflicts: [{ path: '/r/held', pid: 7, processName: 'Python', openPath: '/r/held' }] });
    await turns();
    assert.equal(w.$('confirmOpenHandles').hidden, false, `control (before ${what}): the trash sheet shows its warning`);
    assert.equal(w.page.override(), true, `control (before ${what}): and arms its override`);
    w.page.closeModal('confirmModal'); // Cancel
    open();
    assert.ok(w.$('confirmModal').classes.has('open'), `control: ${what} opened the sheet`);
    assert.equal(w.$('confirmOpenHandles').hidden, true, `${what} shows no "in use" panel about the cancelled sheet's files`);
    assert.equal(w.$('confirmOpenHandles').innerHTML, '', `${what}: the panel holds nothing either`);
    assert.equal(w.page.override(), false, `${what}: no override is armed for it`);
    assert.doesNotMatch(w.$('confirmOk').innerHTML, /anyway/, `${what}: its OK is not an "… anyway"`);
    w.page.closeModal('confirmModal');
  }
});

/* ═══════ the in-use warning says what is really open, and what OK really does (sixth browser pass H07) ═══════ */

type NodeFact = { type: 'dir' | 'file'; size: number; name?: string };

/**
 * The trash sheet for `paths`, its open-file answer `conflicts`, over a tree that knows `nodes`
 * (path → node; a path not in it is not in the scan). Answers the panel's words, tags removed, its
 * markup, and the OK button's label. `pageEscape` uses the page's own escapeHtml rather than none, so
 * a name a program chose can be told apart from markup (review F2.3).
 */
async function inUseWarning(paths: string[], conflicts: Array<{ path: string; openPath?: string; processName: string; pid?: number }>, nodes: Record<string, NodeFact>, { pageEscape = false } = {}): Promise<{ text: string; html: string; ok: string }> {
  const els: Record<string, any> = {};
  const $ = (id: string) => (els[id] ||= (() => {
    const classes = new Set<string>();
    return { innerHTML: '', textContent: '', className: '', hidden: false, disabled: false, style: {}, classes,
      classList: { add: (c: string) => { classes.add(c); }, remove: (c: string) => { classes.delete(c); } } };
  })());
  let answer: (v: unknown) => void = () => {};
  const deps: Record<string, unknown> = {
    $,
    api: (url: string) => (url === '/api/files/installed-programs' ? Promise.resolve({ parts: [] }) : new Promise((resolve) => { answer = resolve; })),
    ensureNodes: async () => {},
    nodeFor: (p: string) => (nodes[p] ? { name: p.split('/').pop(), ...nodes[p] } : null),
    icon: () => '', formatBytes: (n: number) => `${n}B`, formatCount: (n: number) => String(n),
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    escapeHtml: pageEscape ? new Function(`${declOf('escapeHtml')}; return escapeHtml;`)() : (s: string) => s,
    cloudProviderOfScan: () => ({ name: 'Drive', trashLabel: 'its trash' }), cloudTrashPaths: async () => {},
  };
  const keys = Object.keys(deps);
  const src = `
    let openHandleSeq = 0, confirmIgnoreOpenHandles = false, confirmPaths = [], onConfirmTrash = null;
    ${constOf('TRASH_CHUNK')}
    ${constOf('OPEN_HANDLE_PREFLIGHT_CHUNKS')}
    ${constOf('INSTALLED_PROGRAM_CHUNK')}
    ${['setConfirmButton', 'baseName', 'renderOpenHandleWarning', 'checkOpenHandlesFor', 'resetOpenHandleWarning', 'tmParentPath',
      'outermostPaths', 'installedProgramParts', 'installedProgramWords', 'installedProgramRemoval', 'installedProgramWarningHtml', 'confirmTrash'].map(declOf).join('\n')}
    return { confirmTrash };`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const page = new Function(...keys, src)(...keys.map((k) => deps[k]));
  await page.confirmTrash(paths);
  answer({ checked: true, complete: true, conflicts: conflicts.map((c) => ({ pid: 7, ...c })) });
  await turns();
  const html = String($('confirmOpenHandles').innerHTML);
  return { text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), html, ok: String($('confirmOk').innerHTML) };
}

test('a folder held open is "This folder is in use", with no promise of space it does not hold, and OK says it moves it to the Trash (H07)', async () => {
  // QA: an empty folder held open by Python — "This file is in use right now. Deleting it may not free the space…", OK "Delete anyway".
  const w = await inUseWarning(['/r/Empty'], [{ path: '/r/Empty', openPath: '/r/Empty', processName: 'Python' }], { '/r/Empty': { type: 'dir', size: 0 } });
  assert.match(w.text, /^This folder is in use right now\./, 'a folder is called a folder');
  assert.doesNotMatch(w.text, /This file/, 'never "This file" for a folder');
  assert.doesNotMatch(w.text, /space/, 'a folder held open holds no space of its own: nothing is said about freeing it');
  assert.match(w.text, /Python/, 'control: the program is named');
  assert.equal(w.ok, 'Move to Trash anyway', 'OK names the action actually taken');
  assert.doesNotMatch(w.ok, /Delete/, 'never "Delete anyway" for a move to the Trash');
});

test('what is open inside a folder is named for what it is: a file, or something TreeMap cannot call a file; and space is mentioned only where an open file may hold some (H07)', async () => {
  const file = await inUseWarning(['/r/logs'], [{ path: '/r/logs', openPath: '/r/logs/x.log', processName: 'node' }],
    { '/r/logs': { type: 'dir', size: 5000 }, '/r/logs/x.log': { type: 'file', size: 4000 } });
  assert.match(file.text, /^A file inside this folder is in use right now\./);
  assert.match(file.text, /Its space may not come back, even once you empty the Trash, until that program closes it\./, 'an open file with bytes: its space may be held');
  const sub = await inUseWarning(['/r/proj'], [{ path: '/r/proj', openPath: '/r/proj/sub', processName: 'zsh' }],
    { '/r/proj': { type: 'dir', size: 9000 }, '/r/proj/sub': { type: 'dir', size: 0 } });
  assert.match(sub.text, /^Something inside this folder is in use right now\./, 'a folder open inside it is not "a file"');
  assert.doesNotMatch(sub.text, /space/, 'and holds no space of its own');
  const two = await inUseWarning(['/r/logs'], [
    { path: '/r/logs', openPath: '/r/logs/a.log', processName: 'node' }, { path: '/r/logs', openPath: '/r/logs/b.log', processName: 'node' },
  ], { '/r/logs': { type: 'dir', size: 5000 }, '/r/logs/a.log': { type: 'file', size: 1 }, '/r/logs/b.log': { type: 'file', size: 1 } });
  assert.match(two.text, /^2 files inside this folder are in use right now\. Their space may not come back, even once you empty the Trash, until that program closes them\./);
});

test('a file held open says "This file"; one of 0 bytes makes no promise about space, and one TreeMap has no size for may still hold some (H07)', async () => {
  const empty = await inUseWarning(['/r/a.txt'], [{ path: '/r/a.txt', processName: 'Editor' }], { '/r/a.txt': { type: 'file', size: 0 } });
  assert.match(empty.text, /^This file is in use right now\./);
  assert.doesNotMatch(empty.text, /space/, '0 B: nothing to free');
  const big = await inUseWarning(['/r/b.mov'], [{ path: '/r/b.mov', processName: 'QuickTime Player' }], { '/r/b.mov': { type: 'file', size: 9_000_000 } });
  assert.match(big.text, /^This file is in use right now\. Its space may not come back, even once you empty the Trash, until that program closes it\./);
  const unknown = await inUseWarning(['/r/c.bin'], [{ path: '/r/c.bin', processName: 'Tool' }], {});
  assert.match(unknown.text, /^This item is in use right now\. Its space may not come back/, 'not in the tree: called an item, and it may hold space');
  for (const w of [empty, big, unknown]) assert.equal(w.ok, 'Move to Trash anyway');
});

test('several items in use: the sentence says some of them are, speaks of space only where an open file may hold some, and names who must close it when not every program listed does (review F1.11)', async () => {
  const head = (w: { text: string }) => w.text.slice(0, w.text.search(/ (Editor|QuickTime Player|VLC|Python|node|vim) — /));
  const files = { '/r/a.txt': { type: 'file' as const, size: 0 }, '/r/b.mov': { type: 'file' as const, size: 9_000_000 }, '/r/c.mov': { type: 'file' as const, size: 7_000_000 } };
  // One of two open files holds bytes, and only one of the two programs holds it: that program is the one to close.
  const one = await inUseWarning(['/r/a.txt', '/r/b.mov'],
    [{ path: '/r/a.txt', processName: 'Editor' }, { path: '/r/b.mov', processName: 'QuickTime Player' }], files);
  assert.equal(head(one), 'Some of these items are in use right now. One of them may keep its space, even once you empty the Trash, until QuickTime Player closes it.',
    'the 0 B file promises nothing; the other is named by the program that holds it, never "until those programs close it"');
  assert.equal(one.ok, 'Move to Trash anyway');
  // The same, with one program holding both: "that program" is the one listed.
  const same = await inUseWarning(['/r/a.txt', '/r/b.mov'],
    [{ path: '/r/a.txt', processName: 'Editor' }, { path: '/r/b.mov', processName: 'Editor' }], files);
  assert.equal(head(same), 'Some of these items are in use right now. One of them may keep its space, even once you empty the Trash, until that program closes it.');
  // A folder held open and a 0 B file: no space is held, and none is mentioned.
  const none = await inUseWarning(['/r/Empty', '/r/a.txt'],
    [{ path: '/r/Empty', openPath: '/r/Empty', processName: 'Python' }, { path: '/r/a.txt', processName: 'Editor' }],
    { ...files, '/r/Empty': { type: 'dir', size: 0 } });
  assert.equal(head(none), 'Some of these items are in use right now.');
  assert.doesNotMatch(none.text, /space/, 'nothing open holds bytes: nothing is said about freeing any');
  // Two files with bytes, each held by its own program, and nothing else listed: "those programs".
  const both = await inUseWarning(['/r/b.mov', '/r/c.mov'],
    [{ path: '/r/b.mov', processName: 'QuickTime Player' }, { path: '/r/c.mov', processName: 'VLC' }], files);
  assert.equal(head(both), 'Some of these items are in use right now. Their space may not come back, even once you empty the Trash, until those programs close them.');
  // Two files with bytes held by one program, a 0 B file by another: the one to close is named.
  const named = await inUseWarning(['/r/a.txt', '/r/b.mov', '/r/c.mov'],
    [{ path: '/r/a.txt', processName: 'Editor' }, { path: '/r/b.mov', processName: 'QuickTime Player' }, { path: '/r/c.mov', processName: 'QuickTime Player' }], files);
  assert.equal(head(named), 'Some of these items are in use right now. Their space may not come back, even once you empty the Trash, until QuickTime Player closes them.');
  // Two of three programs hold bytes: both are named.
  const two = await inUseWarning(['/r/a.txt', '/r/b.mov', '/r/c.mov'],
    [{ path: '/r/a.txt', processName: 'Editor' }, { path: '/r/b.mov', processName: 'QuickTime Player' }, { path: '/r/c.mov', processName: 'VLC' }], files);
  assert.equal(head(two), 'Some of these items are in use right now. Their space may not come back, even once you empty the Trash, until QuickTime Player and VLC close them.');
  // One folder selected, two files open in it — one with bytes (node), one empty (vim): one of them, and node is named.
  const inside = await inUseWarning(['/r/logs'],
    [{ path: '/r/logs', openPath: '/r/logs/x.log', processName: 'node' }, { path: '/r/logs', openPath: '/r/logs/y.log', processName: 'vim' }],
    { '/r/logs': { type: 'dir', size: 5000 }, '/r/logs/x.log': { type: 'file', size: 5000 }, '/r/logs/y.log': { type: 'file', size: 0 } });
  assert.equal(head(inside), '2 files inside this folder are in use right now. One of them may keep its space, even once you empty the Trash, until node closes it.');
});

test('a program the warning says must close a file is escaped where the sentence names it, alone or beside another — any local program chooses its own name (review F2.3)', async () => {
  const files = { '/r/a.txt': { type: 'file' as const, size: 0 }, '/r/b.mov': { type: 'file' as const, size: 9_000_000 }, '/r/c.mov': { type: 'file' as const, size: 7_000_000 } };
  /** The sentence's markup, before the list of programs (which is escaped on its own). */
  const sentence = (w: { html: string }): string => w.html.slice(0, w.html.indexOf('<ul>'));
  const one = await inUseWarning(['/r/a.txt', '/r/b.mov'],
    [{ path: '/r/a.txt', processName: 'Editor' }, { path: '/r/b.mov', processName: '<b>x</b>' }], files, { pageEscape: true });
  assert.match(sentence(one), /until &lt;b&gt;x&lt;\/b&gt; closes it\./, 'one program holding space: its name is escaped in the sentence');
  assert.doesNotMatch(sentence(one), /<b>x/, 'never markup a program chose');
  const two = await inUseWarning(['/r/a.txt', '/r/b.mov', '/r/c.mov'],
    [{ path: '/r/a.txt', processName: 'Editor' }, { path: '/r/b.mov', processName: '<b>x</b>' }, { path: '/r/c.mov', processName: '<i>y</i>' }], files, { pageEscape: true });
  assert.match(sentence(two), /until &lt;b&gt;x&lt;\/b&gt; and &lt;i&gt;y&lt;\/i&gt; close them\./, 'two programs holding space: both names escaped');
  assert.doesNotMatch(sentence(two), /<b>x|<i>y/, 'never markup a program chose');
});

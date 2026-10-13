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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * D65: `window.prompt()` is a no-op in the desktop app.
 *
 * Electron 31 does not implement `prompt()` — it returns nothing — and the
 * shell adds no substitute, so every button that named something with it did
 * nothing at all there: Treemap › Save view (`if (!name) return`), the fleet's
 * pairing code and a paired machine's scan folder. It worked in a browser,
 * which is why nobody saw it.
 *
 * What replaces it is one in-page sheet, `#askModal`, asked through
 * `askText()`. It is a `.modal-backdrop` like every other sheet, so the focus
 * and inert net in 235 applies to it unchanged, and it is answered "no" by
 * every way of closing it except OK — Cancel, ×, the scrim and Escape all go
 * through `closeModal`, which settles it.
 *
 * Pinned on the built page, the way every frontend test here is.
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

/** The body of a top-level `addEventListener(…, () => { … })` call, from its anchor. */
function listenerBody(anchor: string): string {
  const start = INDEX.indexOf(anchor);
  assert.notEqual(start, -1, `"${anchor}" exists in the built page`);
  const open = INDEX.indexOf('{', start + anchor.length);
  return INDEX.slice(open + 1, matchingBrace(open));
}

/** The application script (the page's last) with comments removed, so a word in prose is not a call. */
function scriptWithoutComments(): string {
  const start = INDEX.lastIndexOf('<script>');
  const end = INDEX.lastIndexOf('</script>');
  assert.ok(start !== -1 && end > start, 'the application script is findable');
  return INDEX.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/* ══════════════════ nothing calls prompt() ══════════════════ */

test('the page never calls prompt(): it does nothing in the desktop app', () => {
  const calls = [...scriptWithoutComments().matchAll(/(?<![\w$.])(?:window\.)?prompt\s*\(/g)].map((m) => m[0]);
  assert.deepEqual(calls, [], 'every question goes through askText');
});

/* ══════════════════ the sheet ══════════════════ */

test('the ask sheet is a modal backdrop with a labelled, autofocused field and a Cancel', () => {
  const m = /<div class="modal-backdrop" id="askModal"[^>]*>([\s\S]*?)<!-- ═{5,}/.exec(INDEX);
  assert.ok(m, '#askModal is a .modal-backdrop, so the focus and inert net handles it like any other sheet');
  const sheet = m![0];
  assert.match(sheet, /aria-labelledby="askTitle"/);
  assert.match(sheet, /<input[^>]*id="askInput"[^>]*autofocus/, 'focus lands in the field, not on a button');
  assert.match(sheet, /<label[^>]*for="askInput"/, 'the question labels the field');
  assert.match(sheet, /data-close="askModal"[^>]*>Cancel</, 'and it can be declined');
  assert.match(sheet, /id="askOk"/);
});

/**
 * The answer if the question has been settled, PENDING while it is still open.
 *
 * Read without waiting on anything: askSettle resolves synchronously, and a
 * race against an already-resolved marker takes whichever settled first in
 * microtask order. A question nobody answers therefore fails the assertion
 * instead of hanging the file until the runner's timeout.
 */
const PENDING = Symbol('still waiting for an answer');
function settled<T>(p: Promise<T>): Promise<T | typeof PENDING> {
  return Promise.race([p, Promise.resolve(PENDING)]);
}

/** askText, its settle, the OK and Enter handlers and the real closeModal, in one scope. */
function askHarness() {
  const classes = new Map<string, Set<string>>();
  const els: Record<string, any> = {};
  const $ = (id: string) => (els[id] ||= (() => {
    const set = new Set<string>();
    classes.set(id, set);
    const el: any = {
      value: '', textContent: '', innerHTML: '', hidden: false, style: {},
      classList: { add: (c: string) => { set.add(c); }, remove: (c: string) => { set.delete(c); }, contains: (c: string) => set.has(c) },
      click: () => { okHandler(); },
    };
    return el;
  })());
  const deps: Record<string, unknown> = {
    $,
    clearInterval: () => {},
    cloudConnectPoll: 0,
    fxOrbHide: () => {},
    cleanFunnelDrop: () => {},
    FxBeam: { attach: () => {} },
    activeJob: null,
    toast: () => {},
    confirmFooterReset: () => {},
    asPath: new Function(`${declOf('asPath')}\nreturn asPath;`)(),
  };
  const keys = Object.keys(deps);
  const src = `
    let askResolve = null;
    ${INDEX.includes('let askIsPath = false;') ? 'let askIsPath = false;' : ''}
    ${declOf('askSettle')}
    ${declOf('askText')}
    ${declOf('closeModal')}
    return {
      askText, closeModal,
      ok: () => {${listenerBody("$('askOk').addEventListener('click', () =>")}},
      key: (e) => {${listenerBody("$('askInput').addEventListener('keydown', (e) =>")}},
    };`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const page = new Function(...keys, src)(...keys.map((k) => deps[k]));
  const okHandler = () => page.ok();
  return { page, $, open: () => classes.get('askModal')?.has('open') ?? false };
}

test('OK answers with the trimmed text and closes the sheet', async () => {
  const h = askHarness();
  const answer = h.page.askText({ title: 'Save view', label: 'Name this view', value: 'size>1gb' });
  assert.ok(h.open(), 'the sheet opens');
  assert.equal(h.$('askInput').value, 'size>1gb', 'with the suggested answer filled in');
  assert.equal(h.$('askTitle').textContent, 'Save view');
  h.$('askInput').value = '  Big files  ';
  h.page.ok();
  assert.equal(await settled(answer), 'Big files');
  assert.ok(!h.open(), 'and it closes');
});

test('a folder asked for keeps the whitespace at its end — part of its name — and loses only the leading paste debris, as every path box reads one; other answers are trimmed (final review F1.8)', async () => {
  // "Scan on that machine" trimmed its answer, so a folder named
  // "Screenshots " was asked for as its sibling "Screenshots" — scanned, and
  // granted the scanned-root permission, in its place.
  const h = askHarness();
  const folder = h.page.askText({ title: 'Scan on that machine', label: 'Which folder?', path: true });
  h.$('askInput').value = '  /Users/me/Screenshots ';
  h.page.ok();
  assert.equal(await settled(folder), '/Users/me/Screenshots ', 'the trailing space stays, the leading whitespace goes');
  const blank = h.page.askText({ title: 'Scan on that machine', label: 'Which folder?', path: true });
  h.$('askInput').value = '   ';
  h.page.ok();
  assert.equal(await settled(blank), null, 'a blank folder is a cancel');
  const name = h.page.askText({ title: 'Save view', label: 'Name this view' });
  h.$('askInput').value = '  Big files  ';
  h.page.ok();
  assert.equal(await settled(name), 'Big files', 'the next question, not a path, is trimmed again');
});

test('Enter in the field is OK', async () => {
  const h = askHarness();
  const answer = h.page.askText({ title: 'Pair', label: 'Code' });
  h.$('askInput').value = '123456';
  let prevented = false;
  h.page.key({ key: 'Enter', preventDefault: () => { prevented = true; } });
  assert.equal(await settled(answer), '123456');
  assert.ok(prevented, 'the key is taken, so nothing behind the sheet acts on it');
});

test('every other way of closing the sheet answers "no"', async () => {
  // Cancel, ×, the scrim and Escape all call closeModal('askModal').
  const h = askHarness();
  const answer = h.page.askText({ title: 'Pair', label: 'Code' });
  h.$('askInput').value = 'typed but not confirmed';
  h.page.closeModal('askModal');
  assert.equal(await settled(answer), null, 'a dismissed question is a cancel, not the half-typed text');
});

test('OK with nothing typed is a cancel, as an empty prompt() was', async () => {
  const h = askHarness();
  const answer = h.page.askText({ title: 'Save view', label: 'Name this view' });
  h.$('askInput').value = '   ';
  h.page.ok();
  assert.equal(await settled(answer), null);
});

test('a second question answers the first "no" rather than leaving it waiting for ever', async () => {
  const h = askHarness();
  const first = h.page.askText({ title: 'One', label: 'a' });
  const second = h.page.askText({ title: 'Two', label: 'b' });
  assert.equal(await settled(first), null);
  h.$('askInput').value = 'b-answer';
  h.page.ok();
  assert.equal(await settled(second), 'b-answer');
});

/* ══════════════════ the three callers ══════════════════ */

type Call = { url: string; body?: any };
function caller(name: string, answer: string | null, extra: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const asked: any[] = [];
  const deps: Record<string, unknown> = {
    $: () => ({ value: 'size>1gb ext:mov' }),
    askText: async (q: unknown) => { asked.push(q); return answer; },
    api: async (url: string, opts?: { body?: string }) => { calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : undefined }); return {}; },
    loadSavedViews: async () => {},
    loadFleet: () => {},
    toast: () => {},
    ...extra,
  };
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(...keys, `${declOf(name)}\nreturn ${name};`)(...keys.map((k) => deps[k]));
  return { fn, calls, asked };
}

test('Save view asks in the page and saves under the given name', async () => {
  const yes = caller('saveCurrentView', 'Big videos');
  await yes.fn();
  assert.equal(yes.asked.length, 1, 'it asks through askText');
  const post = yes.calls.find((c) => c.url === '/api/queries');
  assert.ok(post, 'and saves');
  assert.equal(post!.body.name, 'Big videos');
  assert.equal(post!.body.q, 'size>1gb ext:mov');
  const no = caller('saveCurrentView', null);
  await no.fn();
  assert.equal(no.calls.length, 0, 'a cancelled question saves nothing');
});

test('pairing asks for the code in the page', async () => {
  const yes = caller('pairWithMachine', ' 123456 ');
  await yes.fn('studio.local', 4280);
  const post = yes.calls.find((c) => c.url === '/api/fleet/peers');
  assert.ok(post, 'the code reaches the pairing request');
  assert.equal(post!.body.code, '123456');
  const no = caller('pairWithMachine', null);
  await no.fn('studio.local', 4280);
  assert.ok(!no.calls.some((c) => c.url === '/api/fleet/peers'), 'no code, no request');
});

test('a paired machine\'s scan folder is asked for in the page', async () => {
  const yes = caller('triggerPeerScan', '/Users/me/Movies');
  await yes.fn('peer-1');
  const post = yes.calls.find((c) => /\/trigger-scan$/.test(c.url));
  assert.ok(post, 'the folder reaches the request');
  assert.equal(post!.body.path, '/Users/me/Movies');
  assert.equal(yes.asked[0].path, true, 'asked for as a path, so a trailing space in its name stays (final review F1.8)');
  const no = caller('triggerPeerScan', null);
  await no.fn('peer-1');
  assert.equal(no.calls.length, 0);
});

/* ══════════════════ B28 — Save view with nothing to save; deleting a view can be undone ══════════════════ */

test('Save view is not offered while the box is empty — it would save nothing (B28)', () => {
  // B28: with the box cleared, Save view stayed offered (enabled, same
  // tooltip) beside the saved chips, and pressing it did nothing visible.
  const els: Record<string, { hidden: boolean; value: string; childElementCount: number; title: string; disabled: boolean }> = {};
  const $ = (id: string) => (els[id] ??= { hidden: false, value: '', childElementCount: 0, title: '', disabled: false });
  $('tmSavedViews').childElementCount = 1; // a saved chip keeps the bar up
  $('tmQueryErr').hidden = true;
  $('tmStageMatches').hidden = true;
  const sync = new Function('$', 'state', `${declOf('tmSyncQueryBar')}\nreturn tmSyncQueryBar;`)($, { view: 'treemap' }) as () => void;
  $('tmSearch').value = '   ';
  sync();
  assert.equal($('tmQueryBar').hidden, false, 'the bar stays for its saved chips');
  assert.equal($('tmSaveView').hidden, true, 'Save view is not offered with nothing to save');
  $('tmSearch').value = 'size>1gb';
  sync();
  assert.equal($('tmSaveView').hidden, false, 'and comes back as soon as there is a query to save');
  // The box's own input event re-syncs at once, not only when a debounced query lands.
  assert.match(listenerBody("$('tmSearch').addEventListener('input', (e) =>"), /tmSyncQueryBar\(\)/, 'typing or clearing re-syncs the bar');
});

test('deleting a saved view says so and can be undone — it comes back with its name, query and colour (B28)', async () => {
  // B28: the chip's × deleted the view at once, with no toast and nothing to undo.
  const view = { id: 'v1', name: 'QA big old videos', q: 'size>1gb used>1y', pinned: true, colour: '#ff9f0a' };
  const calls: Call[] = [];
  const toasts: string[] = [];
  const actions: Array<{ msg: string; label: string; fn: () => unknown }> = [];
  let reloads = 0;
  const deps: Record<string, unknown> = {
    state: { savedViews: [view] },
    api: async (url: string, opts?: { method?: string; body?: string }) => { calls.push({ url: `${opts?.method ?? 'GET'} ${url}`, body: opts?.body ? JSON.parse(opts.body) : undefined }); return {}; },
    loadSavedViews: async () => { reloads++; },
    toast: (m: string) => { toasts.push(m); },
    toastAction: (msg: string, label: string, fn: () => unknown) => { actions.push({ msg, label, fn }); },
  };
  const keys = Object.keys(deps);
  const del = new Function(...keys, `${declOf('deleteSavedView')}\nreturn deleteSavedView;`)(...keys.map((k) => deps[k])) as (id: string) => Promise<void>;
  await del('v1');
  assert.deepEqual(calls.map((c) => c.url), ['DELETE /api/queries/v1'], 'the view is deleted');
  assert.equal(reloads, 1, 'and the chips are re-read');
  assert.equal(actions.length, 1, 'the delete is said, with an action');
  assert.match(actions[0].msg, /QA big old videos/, 'naming the view');
  assert.equal(actions[0].label, 'Undo');
  await actions[0].fn();
  const post = calls.find((c) => c.url === 'POST /api/queries');
  assert.ok(post, 'Undo saves it again');
  assert.deepEqual(post!.body, { name: 'QA big old videos', q: 'size>1gb used>1y', pinned: true, colour: '#ff9f0a' }, 'as it was');
  assert.equal(reloads, 2, 'and the chip comes back');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { INDEX } from './fixtures/liftFrontend';

/**
 * The Settings sheet tells the truth (QA, 5 Oct 2026 — batch QA-4a).
 *
 *  - D70: Settings › Right-click menu sat on a disabled "Checking…" button
 *    forever. renderShellIntegration lost its only caller when the scanning
 *    budget joined the settings-open handler (ef6ba6d), so the page never
 *    asked GET /api/platform/shell-integration. Opening the sheet is driven
 *    here, out of the built page, and the button must leave "Checking…".
 *
 * Everything runs the code that ships: the opener is evaluated with a fake
 * DOM and a recording api(), and the functions it reaches are the page's own.
 */

/* ══════════════ Slicing helpers — explicit anchors, never a backwards slice ══════════════ */

/** A brace-matched block from an opening anchor — walks past the parameter list first. */
function braced(openAnchor: string): string {
  const start = INDEX.indexOf(openAnchor);
  assert.notEqual(start, -1, `block "${openAnchor}" exists in index.html`);
  let p = INDEX.indexOf('(', start), paren = 0;
  for (; p < INDEX.length; p++) {
    if (INDEX[p] === '(') paren++;
    else if (INDEX[p] === ')' && --paren === 0) break;
  }
  let depth = 0;
  for (let i = INDEX.indexOf('{', p); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`block "${openAnchor}" never closes`);
}

/* ══════════════ A fake DOM: any id answers with a plain element ══════════════ */

type FakeEl = {
  id: string; textContent: string; innerHTML: string; value: string;
  checked: boolean; disabled: boolean; hidden: boolean;
  onclick: null | (() => unknown);
  classes: Set<string>;
  classList: { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): void; contains(c: string): boolean };
  listeners: Record<string, () => unknown>;
  addEventListener(type: string, fn: () => unknown): void;
  focus(opts?: unknown): void;
};

function fakeEl(id: string, init: Partial<FakeEl> = {}): FakeEl {
  const classes = new Set<string>();
  const el: FakeEl = {
    id, textContent: '', innerHTML: '', value: '', checked: false, disabled: false, hidden: false, onclick: null,
    classes,
    classList: {
      add: (c) => { classes.add(c); },
      remove: (c) => { classes.delete(c); },
      toggle: (c, on) => { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    listeners: {},
    addEventListener(type, fn) { el.listeners[type] = fn; },
    focus() {},
    ...init,
  };
  return el;
}

function fakeDom(markup: Record<string, Partial<FakeEl>> = {}) {
  const els = new Map<string, FakeEl>();
  /**
   * Where focus is, as a browser keeps it: a control focused holds it until another takes it — or until it is
   * disabled, when the browser's focus fixup hands it to <body> as it next reads where focus is, and enabling the
   * control again does not give it back (as folderPicker's harness keeps it, eighth browser pass K02).
   */
  let active: FakeEl | null = null;
  const $ = (id: string): FakeEl => {
    let el = els.get(id);
    if (!el) {
      const made = fakeEl(id, markup[id]);
      made.focus = () => { active = made; };
      els.set(id, made);
      el = made;
    }
    return el;
  };
  const body = fakeEl('body');
  const document = {
    body,
    get activeElement(): FakeEl {
      if (active && active.disabled) active = null; // the focus fixup
      return active ?? body;
    },
  };
  return { $, els, document };
}

type ApiCall = { url: string; options?: { method?: string; body?: string } };
function recordingApi(answers: Record<string, unknown>) {
  const calls: ApiCall[] = [];
  const api = async (url: string, options?: ApiCall['options']) => {
    calls.push({ url, options });
    if (url in answers) return answers[url];
    return {};
  };
  return { api, calls };
}

/** Let every promise the handler started but did not await settle — counted turns, never a clock. */
async function settle(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * The settings-open handler, as shipped, with the page functions it calls.
 * The renderers that only paint rows nobody here reads are stubs; the ones
 * under test are lifted from the page.
 */
function openSettingsRuntime(api: (url: string, options?: ApiCall['options']) => Promise<unknown>, lifted: string[]) {
  const dom = fakeDom({
    // The markup's own starting state for the right-click row (110-modal-settings.html).
    shellIntegrationBtn: { disabled: true, textContent: 'Checking…' },
    shellIntegrationBlurb: { textContent: 'Checking…' },
  });
  const opener = braced("$('settingsBtn').addEventListener('click', async () => {");
  const stubs = [
    'renderAllocationDiagnostic', 'renderEngineBudgetHelp', 'loadEngineBudget', 'rememberStoredSchedules', 'renderSchedules', 'renderIgnores',
    'renderCloudAccounts', 'renderCleanupGoalFields', 'renderReclaimWeights', 'renderScanEngine', 'renderScanBoundary',
    'renderShellIntegration',
  ].filter((name) => !lifted.includes(name));
  const liftedSrc = lifted.map((name) => braced(`async function ${name}(`)).join('\n');
  const toasts: string[] = [];
  const toastKinds: Array<string | undefined> = []; // each toast's kind, beside it ('error' is said in red)
  // The focus net's two calls (235): the top open sheet, and focus put where that sheet lands it — its [autofocus],
  // Settings' "Close without saving", stood in for here by one element. Each sheet the net lands is recorded.
  const landed: string[] = [];
  const topModal = () => (dom.$('settingsModal').classes.has('open') ? dom.$('settingsModal') : null);
  const modalFocusInto = (sheet: FakeEl) => { landed.push(sheet.id); dom.$('settingsCloseWithoutSaving').focus(); };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(
    '$', 'api', 'toast', 'document', 'topModal', 'modalFocusInto',
    `'use strict';
     let settingsData = { ignore: [], schedules: [] };
     ${stubs.map((name) => `function ${name}() {}`).join('\n')}
     ${liftedSrc}
     ${INDEX.includes('function settingsSaveOn(') ? braced('function settingsSaveOn(') : ''}
     ${INDEX.includes('function setSettingsStatus(') ? braced('function setSettingsStatus(') : ''}
     ${opener});`,
  )(dom.$, api, (msg: string, kind?: string) => { toasts.push(msg); toastKinds.push(kind); }, dom.document, topModal, modalFocusInto);
  const open = dom.$('settingsBtn').listeners.click;
  assert.ok(open, 'the Settings button has a click handler');
  return { dom, open, toasts, toastKinds, landed };
}

/* ══════════════ D70 — opening Settings asks the OS about the right-click entry ══════════════ */

test('opening Settings requests GET /api/platform/shell-integration and the button leaves "Checking…" (D70)', async () => {
  const { api, calls } = recordingApi({
    '/api/settings': { ignore: [], schedules: [] },
    '/api/platform/shell-integration': { supported: true, installed: false, label: 'Finder Quick Action' },
  });
  const { dom, open } = openSettingsRuntime(api, ['renderShellIntegration']);
  await open();
  await settle();
  const asked = calls.filter((c) => c.url === '/api/platform/shell-integration');
  assert.equal(asked.length, 1, `opening the sheet asks once; asked: ${calls.map((c) => c.url).join(', ')}`);
  assert.equal(asked[0].options, undefined, 'a plain GET');
  const btn = dom.$('shellIntegrationBtn');
  assert.equal(btn.disabled, false, 'the button is usable once the answer is in');
  assert.equal(btn.textContent, 'Add to right-click menu', 'and says what it will do');
  assert.notEqual(dom.$('shellIntegrationBlurb').textContent, 'Checking…', 'the blurb is replaced too');
});

test('an installed entry is offered for removal on open, from the same request (D70)', async () => {
  const { api } = recordingApi({
    '/api/settings': { ignore: [], schedules: [] },
    '/api/platform/shell-integration': { supported: true, installed: true },
  });
  const { dom, open } = openSettingsRuntime(api, ['renderShellIntegration']);
  await open();
  await settle();
  assert.equal(dom.$('shellIntegrationBtn').textContent, 'Remove from right-click menu');
  assert.equal(dom.$('shellIntegrationBtn').disabled, false);
});

test('review F1.3/F1.16: an entry that starts another program is never called TreeMap\'s, and one already in place is offered for removal where adding is not', async () => {
  const shown = async (answer: Record<string, unknown>) => {
    const { api } = recordingApi({ '/api/settings': { ignore: [], schedules: [] }, '/api/platform/shell-integration': answer });
    const { dom, open } = openSettingsRuntime(api, ['renderShellIntegration']);
    await open();
    await settle();
    const btn = dom.$('shellIntegrationBtn') as unknown as { textContent: string; hidden?: boolean; disabled: boolean };
    return { blurb: dom.$('shellIntegrationBlurb').textContent, button: [btn.textContent, !!btn.hidden, btn.disabled] };
  };
  const node = '/opt/homebrew/bin/node';
  let s = await shown({ supported: true, installed: true, current: false, program: node });
  assert.equal(s.blurb, `A “Scan with TreeMap” entry is in your file manager’s right-click menu, but it starts ${node}, not this TreeMap app. Remove it, then add it again to make it start this app.`,
    'the entry an earlier build wrote under npm start runs node on the folder: it is not said to be TreeMap\'s');
  assert.deepEqual(s.button, ['Remove from right-click menu', false, false]);
  s = await shown({ supported: true, installed: true, current: false, program: null });
  assert.equal(s.blurb, 'A “Scan with TreeMap” entry is in your file manager’s right-click menu, but TreeMap cannot read which program it starts. Remove it, then add it again to make it start this app.');
  const reason = 'Only the installed TreeMap app can add the right-click entry, since the entry it adds starts that app; this TreeMap runs in a browser tab or from source.';
  s = await shown({ supported: false, reason, installed: true, current: false, program: node });
  assert.equal(s.blurb, `A “Scan with TreeMap” entry is in your file manager’s right-click menu, and it starts ${node}. Removing it takes the entry away completely. ${reason}`,
    'a browser tab cannot tell whose entry it is — it says what it starts, and why adding is not offered');
  assert.deepEqual(s.button, ['Remove from right-click menu', false, false], 'removable here, though adding is not offered');
  s = await shown({ supported: false, reason, installed: false, current: false, program: null });
  assert.deepEqual([s.blurb, s.button[1]], [reason, true], 'nothing in place and nothing to add: no button');
  s = await shown({ supported: true, installed: true, current: true, program: '/Applications/TreeMap.app/Contents/MacOS/TreeMap' });
  assert.equal(s.blurb, '“Scan with TreeMap” is in your file manager’s right-click menu for folders. Removing it takes the entry away completely.', 'control: the app\'s own entry');
});

test('review HA-L6: the right-click button says what became of what was asked — a failed Add is "Not added." with its reason, a Remove that left the entry is "Not removed" — never "Removed." after an Add or "Added." after a Remove', async () => {
  const pressed = async (installed: boolean, answer: Record<string, unknown> | Error) => {
    let posted = false; // the system as it is before the press, then as the action left it
    const api = async (url: string, options?: ApiCall['options']) => {
      if (url !== '/api/platform/shell-integration') return url === '/api/settings' ? { ignore: [], schedules: [] } : {};
      if (options?.method === 'POST') { posted = true; if (answer instanceof Error) throw answer; return answer; }
      return { supported: true, installed: posted && !(answer instanceof Error) ? answer.installed : installed };
    };
    const rt = openSettingsRuntime(api, ['renderShellIntegration']);
    await rt.open();
    await settle();
    await (rt.dom.$('shellIntegrationBtn').onclick!() as Promise<void>);
    await settle();
    return { status: rt.dom.$('shellIntegrationStatus').textContent, toasts: rt.toasts, kinds: rt.toastKinds };
  };
  const reason = 'The Finder Quick Action could not be created (EACCES: permission denied).';
  let r = await pressed(false, { installed: false, targets: [], reason });
  assert.equal(r.status, `Not added. ${reason}`, 'a failed Add says so, and why');
  // The row's status is no live region, and focus goes back to a button still reading "Add to right-click menu":
  // a failure is said aloud by an error toast, which the sheet repeats in its own live region (review F1.7).
  assert.deepEqual([r.toasts, r.kinds], [[`Not added. ${reason}`], ['error']], 'and is said aloud, once, as an error');
  r = await pressed(false, { installed: false, targets: [] });
  assert.equal(r.status, 'Not added.', 'with no reason given, still not "Removed."');
  r = await pressed(true, { installed: true, targets: [] });
  assert.equal(r.status, 'Not removed — the entry is still in the right-click menu.', 'a Remove that left the entry is not "Added."');
  assert.deepEqual([r.toasts, r.kinds], [['Not removed — the entry is still in the right-click menu.'], ['error']], 'said aloud too');
  r = await pressed(false, new Error('The server did not answer.'));
  assert.deepEqual([r.status, r.toasts, r.kinds], ['Failed: The server did not answer.', ['Failed: The server did not answer.'], ['error']], 'a request that failed is said aloud as well');
  r = await pressed(true, { installed: true, targets: [], reason: 'reg.exe did not answer within 10 s.' });
  assert.equal(r.status, 'Not removed — the entry is still in the right-click menu. reg.exe did not answer within 10 s.');
  r = await pressed(true, { installed: false, targets: ['finder-quick-action'] });
  assert.equal(r.status, 'Removed.', 'control: a Remove that removed it');
  r = await pressed(false, { installed: true, targets: ['finder-quick-action'] });
  assert.deepEqual([r.status, r.toasts], ['Added (finder-quick-action).', ['Added — your file manager may take a moment to show it']], 'control: an Add that added it');
});

/* ══════════════ The right-click button keeps focus through its request (as K02 found of Scan) ══════════════ */

/**
 * The right-click row's api, answered by the test: GET says what the OS has, the POST waits until `release`, and the
 * GET after it answers with what the POST did — or fails, with `rereadFails`.
 */
function shellIntegrationApi(rereadFails: boolean) {
  let installed = false;
  let posted = false;
  let release!: () => void;
  const answer = new Promise<void>((resolve) => { release = resolve; });
  const api = async (url: string, options?: ApiCall['options']) => {
    if (url !== '/api/platform/shell-integration') return url === '/api/settings' ? { ignore: [], schedules: [] } : {};
    if (options?.method === 'POST') {
      await answer;
      posted = true;
      installed = JSON.parse(options.body ?? '{}').install === true;
      return { installed, targets: ['Finder Quick Action'] };
    }
    if (posted && rereadFails) throw new Error('The server did not answer');
    return { supported: true, installed };
  };
  return { api, release: () => release() };
}

/** Settings opened, its right-click row answered, and a press of the row's button out, its POST held until `release`. */
async function shellIntegrationPressed(focusFirst: boolean, rereadFails = false) {
  const { api, release } = shellIntegrationApi(rereadFails);
  const rt = openSettingsRuntime(api, ['renderShellIntegration']);
  await rt.open();
  await settle();
  const btn = rt.dom.$('shellIntegrationBtn');
  const { document } = rt.dom;
  assert.deepEqual([btn.disabled, btn.textContent], [false, 'Add to right-click menu'], 'control: the row answered, its button live');
  if (focusFirst) btn.focus(); // Tab to the button, then Enter
  else assert.equal(document.activeElement, document.body, 'control: nothing is focused before the press');
  const press = btn.onclick!() as Promise<void>;
  assert.equal(btn.disabled, true, 'control: the button is held while its request is out');
  assert.equal(document.activeElement, document.body, 'control: focus is on <body> while the button is held');
  return { ...rt, btn, document, press, release };
}

test('the right-click button keeps focus through its request — held disabled, it hands focus to <body>, and it is given back as the button is, unless the person moved it meanwhile or the button never had it; a re-read that fails keeps the button held, and the sheet takes focus by its own rule (as K02 found of Scan)', async () => {
  {
    const h = await shellIntegrationPressed(true);
    h.release();
    await h.press;
    assert.deepEqual([h.btn.disabled, h.btn.textContent, h.dom.$('shellIntegrationStatus').textContent],
      [false, 'Remove from right-click menu', 'Added (Finder Quick Action).'], 'control: added, re-read, and the button handed back');
    assert.equal(h.document.activeElement, h.btn, 'focus is on the button again — the next Enter reaches it — never left on <body>');
    assert.deepEqual(h.landed, [], 'control: the sheet is not asked to place focus');
  }
  {
    // Focus the person moved while the request was out — to another field in the sheet — stays there.
    const h = await shellIntegrationPressed(true);
    h.dom.$('forecastDays').focus();
    h.release();
    await h.press;
    assert.equal(h.document.activeElement, h.dom.$('forecastDays'), 'focus moved meanwhile is left where the person put it');
  }
  {
    // A press that never focused the button — a mouse click in Safari or Firefox on macOS — is given no focus (F3.7).
    const h = await shellIntegrationPressed(false);
    h.release();
    await h.press;
    assert.equal(h.document.activeElement, h.document.body, 'focus the button never held is not pulled onto it');
    assert.deepEqual(h.landed, [], 'nor put into the sheet');
  }
  {
    // The re-read after the request fails: what the OS has is unknown, so the button stays held, and focus cannot go
    // back to it — the sheet places it, as its focus net places it on any landing (modalFocusInto), not <body>.
    const h = await shellIntegrationPressed(true, true);
    h.release();
    await h.press;
    assert.equal(h.btn.disabled, true, 'control: a re-read that fails keeps the button held');
    assert.match(h.dom.$('shellIntegrationBlurb').textContent, /^Could not check: The server did not answer$/, 'control: and says so');
    assert.deepEqual(h.landed, ['settingsModal'], 'the sheet the press was made in places focus');
    assert.equal(h.document.activeElement, h.dom.$('settingsCloseWithoutSaving'), 'focus is on the sheet\'s landing control, never left on <body>');
  }
});

/* ══════════════ D72 — the Time Capsule says which deletes it copies ══════════════ */

/**
 * The truth, read from the server: the services that route a delete through
 * protectAndTrash (copy, verify, then trash). Every one of them must be named
 * where the app says what the capsule holds. A new caller fails here until
 * the wording names it.
 */
const CAPSULE_ROUTES: Record<string, string> = {
  'autopilot.ts': 'Autopilot',
  'cartCommit.ts': 'Clean Up cart',
};
/** Ways to move a file to the Trash that go through DELETE /api/files — no capsule copy. */
const DIRECT_TRASH_WORDS = ['right-click', 'Grid', 'Duplicates', 'Clean Up'];

function capsuleCallers(): string[] {
  const dir = path.join(__dirname, '..', 'src', 'services');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && f !== 'timeCapsule.ts')
    .filter((f) => /\bprotectAndTrash\(/.test(readFileSync(path.join(dir, f), 'utf8')))
    .sort();
}

const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

function assertCapsuleSentence(where: string, text: string): void {
  for (const word of Object.values(CAPSULE_ROUTES)) {
    assert.ok(text.includes(word), `${where} names ${word} among what the capsule copies: "${text}"`);
  }
  assert.match(text, /aren['’]t copied/, `${where} says plainly what is not copied: "${text}"`);
  for (const word of DIRECT_TRASH_WORDS) {
    assert.ok(text.includes(word), `${where} names ${word} as a delete that is not copied: "${text}"`);
  }
  assert.doesNotMatch(text, /delete yourself|deletes? (anything )?automatically/i,
    `${where} no longer says only automatic deletes are copied — the cart is a delete you make yourself: "${text}"`);
}

test('the capsule copies exactly the deletes of Autopilot and the cleanup cart — read from the server (D72)', () => {
  assert.deepEqual(capsuleCallers(), Object.keys(CAPSULE_ROUTES).sort(),
    'the services that copy into the Time Capsule before trashing; a new one must be named in the wording below');
  // And the routes named as NOT copied really reach DELETE /api/files, never the cart commit.
  const trashPaths = braced('async function trashPaths(');
  assert.match(trashPaths, /api(?:Paced)?\('\/api\/files'[\s\S]{0,120}method: 'DELETE'/, 'a direct move to the Trash is DELETE /api/files');
  assert.doesNotMatch(trashPaths, /cart\/commit/, 'which never goes through the capsule');
});

test('Settings › Time Capsule names what is copied and what is not (D72)', () => {
  const head = INDEX.indexOf('></span>Undo Vault</div>');
  assert.notEqual(head, -1, 'the Settings sheet has an Undo Vault section');
  const blurb = INDEX.slice(head, INDEX.indexOf('id="capsuleRetentionDays"', head));
  const at = blurb.indexOf('<div class="muted"');
  assertCapsuleSentence('Settings', plain(blurb.slice(at, blurb.indexOf('</div>', at))));
});

test('the empty Time Capsule view names what is copied and what is not (D72)', () => {
  const start = INDEX.indexOf('Nothing here yet');
  assert.notEqual(start, -1, 'the empty capsule view has its sentence');
  const end = INDEX.indexOf('</div>`;', start);
  // The template's own string joins: ` + ` between literal lines.
  const text = plain(INDEX.slice(start, end).replace(/`\s*\+\s*`/g, ''));
  assertCapsuleSentence('The Time Capsule view', text);
});

test('the README describes the capsule the same way (D72)', () => {
  const readme = readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const start = readme.indexOf('### 🗄️ Undo Vault');
  assert.notEqual(start, -1, 'the README has an Undo Vault section');
  const para = readme.slice(start, readme.indexOf('</td>', start)).replace(/\*/g, '');
  assertCapsuleSentence('The README', plain(para));
});

/* ══════════════ D71 + D10 — "How TreeMap measures space" says what the totals count ══════════════ */

/** The Settings markup, from the sheet's opening tag to its footer. */
function settingsSheet(): string {
  const start = INDEX.indexOf('<div class="modal-backdrop" id="settingsModal"');
  assert.notEqual(start, -1, 'the Settings sheet is in the page');
  return INDEX.slice(start, INDEX.indexOf('<div class="modal-foot">', start));
}

test('Settings no longer claims the totals measure occupied space — they count the size files claim (D71, D10)', () => {
  // The scan sizes every file by the size it claims; the goldens hold the scan
  // responses byte-identical (DESIGN §12), so the sentence is what changes.
  const sheet = settingsSheet();
  const head = sheet.indexOf('></span>How TreeMap measures space</div>');
  assert.notEqual(head, -1, 'the section is still there');
  const at = sheet.indexOf('<div class="muted"', head);
  const text = plain(sheet.slice(at, sheet.indexOf('</div>', at)));
  assert.doesNotMatch(text, /measures the space files actually occupy/, `the false claim is gone: "${text}"`);
  assert.match(text, /map and totals count the size each file claims/, `it says what the totals count: "${text}"`);
  assert.match(text, /space the files actually take up on disk/, `and what this panel adds: "${text}"`);
  // The two figures it contrasts are rows the panel really draws.
  const panel = braced('async function renderAllocationDiagnostic(');
  assert.match(panel, /row\('Size the files claim'/, 'the claimed size is a row of the panel');
  assert.match(panel, /row\('Space actually used'/, 'and so is the space used');
  // …but only where it was measured: on Windows, and for an index built from
  // a scan, the server refuses (409 ALLOCATION_NOT_MEASURED) and the panel
  // draws no figure. The sentence promises no comparison it cannot make (review F1.3).
  assert.match(panel, /e\.code === 'ALLOCATION_NOT_MEASURED'[\s\S]{0,400}'Not measured for this index\. '/,
    'the panel has a state with no figure at all');
  assert.doesNotMatch(text, /This panel compares/, `no unconditional promise of a comparison: "${text}"`);
  assert.match(text, /where this computer can measure it/i, `it says the second figure depends on the computer: "${text}"`);
});

/* ══════════════ D74 — the cleanup target's empty state fits its box ══════════════ */

test('every number box in Settings shows its whole placeholder — "no target" was clipped to "no targe" (D74)', () => {
  // `.rule-row input[type="number"]` is 88 px wide; after its padding and the
  // spin buttons about six characters of 13.5 px text fit.
  const css = /\.rule-row input\[type="number"\] \{ width: (\d+)px; \}/.exec(INDEX);
  assert.ok(css, 'the number box width is the one this check was measured against');
  assert.equal(Number(css![1]), 88);
  const boxes = [...settingsSheet().matchAll(/<input type="number"[^>]*>/g)].map((m) => m[0]);
  assert.ok(boxes.length >= 5, `found the Settings number boxes (${boxes.length})`);
  const withPlaceholder = boxes.filter((b) => /placeholder="/.test(b));
  assert.ok(withPlaceholder.some((b) => b.includes('id="cleanupGoalValue"')), 'the cleanup target still says what empty means');
  for (const box of withPlaceholder) {
    const placeholder = /placeholder="([^"]*)"/.exec(box)![1];
    assert.ok(placeholder.length <= 6, `"${placeholder}" fits an 88 px box: ${box}`);
  }
});

/* ══════════════ D73 — the footer does not promise to undo what already saved ══════════════ */

/** The Settings footer markup. */
function settingsFooter(): string {
  const start = INDEX.indexOf('<div class="modal-backdrop" id="settingsModal"');
  const foot = INDEX.indexOf('<div class="modal-foot">', start);
  return INDEX.slice(foot, INDEX.indexOf('</div>\n  </div>\n</div>', foot));
}

test('every choice that saves the moment it is picked says so (D73)', () => {
  const sheet = settingsSheet();
  const groups = [...sheet.matchAll(/<div id="(\w+)" role="radiogroup"/g)].map((m) => ({ id: m[1], at: m.index! }));
  assert.ok(groups.length >= 3, `the budget, engine and drives choices are radio groups (${groups.map((g) => g.id).join(', ')})`);
  for (const g of groups) {
    const before = sheet.slice(sheet.lastIndexOf('<div class="set-h"', g.at), g.at);
    assert.match(plain(before), /Picking one saves it straight away/, `#${g.id} says it saves the moment it is picked: "${plain(before)}"`);
  }
});

test('the footer offers "Close without saving", not a Cancel that cannot undo the choices already saved (D73)', () => {
  const foot = settingsFooter();
  assert.doesNotMatch(foot, />Cancel</, 'no Cancel: the budget, engine and drive choices were saved when they were picked');
  assert.match(foot, /<button class="btn" data-close="settingsModal"[^>]*>Close without saving<\/button>/, 'closing drops only the edits Save would keep');
  assert.match(foot, /id="settingsSaveBtn"/, 'Save is still there');
});

test('the footer says which choices are already saved and what Save keeps, naming exactly the choices that save on a pick (design pass G12)', () => {
  // Theme, Scanning budget, Scan engine and Drives each say "Picking one saves
  // it straight away", while the footer offered "Close without saving" and
  // "Save" without saying which settings those two apply to.
  const sheet = settingsSheet();
  const instant = [...sheet.matchAll(/<div id="(\w+)" role="radiogroup"/g)]
    .filter((m) => /Picking one saves it straight away/.test(plain(sheet.slice(sheet.lastIndexOf('<div class="set-h"', m.index!), m.index!))))
    .map((m) => m[1]);
  const named: Record<string, string> = { themeOptions: 'theme', engineBudgetOptions: 'scanning budget', scanEngineOptions: 'scan engine', scanBoundary: 'drives' };
  assert.deepEqual(instant.sort(), Object.keys(named).sort(), 'the choices that save on a pick are the four the note names — a fifth must be named there too');
  const foot = settingsFooter();
  const note = /<span class="muted settings-save-note" id="settingsSaveNote">([^<]+)<\/span>/.exec(foot);
  assert.ok(note, `the footer carries the note: ${foot}`);
  // Reclaim Score's Reset to defaults saves when pressed, so Close without saving does not bring the weights back: said here (the hunt, S3).
  assert.equal(note![1], 'Theme, scanning budget, scan engine and drives are saved the moment you pick one, and Reclaim Score’s Reset to defaults the moment you press it. Save keeps your other edits on this sheet.');
  for (const words of Object.values(named)) assert.match(note![1].toLowerCase(), new RegExp(`\\b${words}\\b`), `the note names ${words}`);
  assert.ok(foot.indexOf('id="settingsSaveNote"') < foot.indexOf('data-close="settingsModal"'), 'beside the two buttons it explains, before them');
  assert.match(foot, /id="settingsStatus"/, 'the status line for a change made here stays');
  const css = INDEX.slice(INDEX.indexOf('/* ── Settings modal ── */'));
  assert.match(css, /\.settings-foot-text \{ flex: 1; min-width: 0; display: flex; flex-direction: column;/, 'the note takes the room beside the buttons and wraps there');
});

/* ══════════════ Review F1.3 — a choice saved on a pick keeps the sheet's other edits ══════════════ */

type Box = { value: string; checked: boolean; dataset: Record<string, string> };
type Row = { boxes: Record<string, Box>; querySelector(sel: string): Box };
function row(boxes: Record<string, Partial<Box>>): Row {
  const all: Record<string, Box> = Object.fromEntries(Object.entries(boxes).map(([k, b]) => [k, { value: '', checked: false, dataset: {}, ...b }]));
  return { boxes: all, querySelector: (sel) => all[sel] };
}

/**
 * The sheet's schedule and ignore rows, bound by index to settingsData as
 * renderSchedules and renderIgnores bind them, with the four choices that
 * save on a pick — the scan engine, the drives, the reclaim weights' reset
 * and a cloud account's Connect — and Save's body, all out of the page.
 * `server` is what PUT /api/settings answers: every setting, as stored.
 */
function instantSaveRuntime(stored: Record<string, unknown>, server: (patch: Record<string, unknown>) => Record<string, unknown>) {
  const dom = fakeDom({ forecastDays: { value: '30' }, watchIdleMin: { value: '10' }, capsuleRetentionDays: { value: '30' }, capsuleMaxPercent: { value: '10' }, humanScaleToggle: { checked: true } });
  const screen: { sched: Row[]; ign: Row[] } = { sched: [], ign: [] };
  const doc = {
    querySelectorAll: (sel: string) => (sel.startsWith('#schedList') ? screen.sched : sel.startsWith('#ignoreList') ? screen.ign : []),
    querySelector: () => null,
  };
  const api = async (url: string, options?: ApiCall['options']) => {
    if (url === '/api/cloud/connect') throw new Error('offline');
    assert.equal(url, '/api/settings');
    return server(JSON.parse(options?.body ?? '{}'));
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const rt = new Function(
    '$', 'api', 'toast', 'document',
    `'use strict';
     let settingsData = ${JSON.stringify(stored)};
     const GB = 1e9;
     const SCAN_ENGINE_LABELS = {}; const SCAN_BOUNDARY_LABELS = {};
     function renderScanEngine() {} function renderScanBoundary() {} function renderReclaimWeights() {}
     function reclaimReset() {} async function refreshFastRescanPlan() {} function fxOrbHide() {}
     function collectReclaimWeights() { return {}; } function collectCleanupGoal() { return null; }
     function collectCloudCreds() { return { gdrive: { clientId: 'typed' } }; }
     ${braced('function asPath(')}
     ${braced('function collectSettingsForms(')}
     ${braced('function settingsBody(')}
     ${braced('async function saveScanEngine(')}
     ${braced('async function saveScanBoundary(')}
     ${braced('async function connectCloud(')}
     ${braced("$('reclaimResetBtn').addEventListener('click', () => {")});
     return { data: () => settingsData, collectSettingsForms, settingsBody, saveScanEngine, saveScanBoundary, connectCloud };`,
  )(dom.$, api, () => {}, doc) as {
    data: () => { schedules: Array<Record<string, unknown>>; ignore: Array<Record<string, unknown>> } & Record<string, unknown>;
    collectSettingsForms: () => void; settingsBody: () => string;
    saveScanEngine: (e: string) => Promise<void>; saveScanBoundary: (r: string) => Promise<void>; connectCloud: (id: string) => Promise<void>;
  };
  /** renderSchedules and renderIgnores: one row per object, bound by its index. */
  const paint = () => {
    screen.sched = rt.data().schedules.map((s, i) => row({ '.s-path': { value: String(s.path), dataset: { i: String(i) } }, '.s-int': { value: String(s.intervalHours) },
      '.s-gb': {}, '.s-pct': {}, '.s-on': { checked: s.enabled === true } }));
    screen.ign = rt.data().ignore.map((e, i) => row({ '.i-pat': { value: String(e.pattern), dataset: { i: String(i) } }, '.i-scope': { value: String(e.scope) } }));
  };
  paint();
  const resetWeights = async () => { dom.$('reclaimResetBtn').listeners.click(); await settle(); };
  return { ...rt, screen, paint, resetWeights };
}

test('a choice saved the moment it is picked keeps every unsaved edit on the sheet, so Save keeps them as the footer promises (review F1.3)', async () => {
  // PUT /api/settings answers with every setting as stored, and each instant
  // save adopted that whole answer as the sheet's settingsData: a scheduled
  // scan or ignore pattern added and not yet saved lost the object its row is
  // bound to, and the next Save dropped it — "Settings saved" — or wrote one
  // row's values over another's.
  const A = { id: 'a', path: '/Users/x/A', intervalHours: 24, enabled: true };
  const B = { id: 'b', path: '/Users/x/B', intervalHours: 24, enabled: true };
  const stored = { schedules: [A], ignore: [], engine: 'auto', scanBoundary: 'stay', reclaimWeights: { size: 0.9 }, cloud: {} };
  const asStored = (patch: Record<string, unknown>) => ({ ...JSON.parse(JSON.stringify(stored)), ...patch, ...(patch.reclaimWeights === null ? { reclaimWeights: { size: 0.3 } } : {}) });
  const picks: Array<[string, (rt: ReturnType<typeof instantSaveRuntime>) => Promise<void>, string, unknown]> = [
    ['the scan engine', (rt) => rt.saveScanEngine('walker'), 'engine', 'walker'],
    ['the drives', (rt) => rt.saveScanBoundary('cross'), 'scanBoundary', 'cross'],
    ['the reclaim weights\' reset', (rt) => rt.resetWeights(), 'reclaimWeights', { size: 0.3 }],
    ['a cloud account\'s Connect', (rt) => rt.connectCloud('gdrive'), 'cloud', { gdrive: { clientId: 'typed' } }],
  ];
  for (const [what, pick, key, value] of picks) {
    const rt = instantSaveRuntime(stored, asStored);
    // "Add scheduled scan" and "Add pattern", then a pattern typed in.
    rt.collectSettingsForms();
    rt.data().schedules.push({ id: '', path: '/Users/x/New', intervalHours: 24, enabled: true });
    rt.data().ignore.push({ pattern: '', scope: 'both' });
    rt.paint();
    rt.screen.ign[0].boxes['.i-pat'].value = 'node_modules';
    await pick(rt);
    assert.deepEqual(rt.data()[key], value, `${what}: the sheet holds what was saved`);
    const body = JSON.parse(rt.settingsBody());
    assert.deepEqual(body.schedules.map((s: { path: string }) => s.path), ['/Users/x/A', '/Users/x/New'], `${what}: the scheduled scan added before it is still saved by Save`);
    assert.deepEqual(body.ignore, [{ pattern: 'node_modules', scope: 'both' }], `${what}: and so is the pattern`);
  }
  // A row removed before the pick: the rows on screen are bound to the
  // objects they show, not to the stored list's indices.
  const rt = instantSaveRuntime({ ...stored, schedules: [A, B] }, (patch) => ({ ...JSON.parse(JSON.stringify({ ...stored, schedules: [A, B] })), ...patch }));
  rt.collectSettingsForms();
  rt.data().schedules.splice(0, 1);
  rt.paint();
  await rt.saveScanBoundary('cross');
  const body = JSON.parse(rt.settingsBody());
  assert.deepEqual(body.schedules.map((s: { id: string; path: string }) => [s.id, s.path]), [['b', '/Users/x/B']], 'the one schedule left is saved as itself, not over the removed one');
});

test('"Clear target" is an edit like the others: the live target and its meter stay until Save, so closing without saving drops it (review F1.10)', () => {
  // It used to hide the cart's target meter on the spot while the stored
  // target stayed — "Close without saving" then left the two disagreeing
  // until Settings was reopened or the page reloaded.
  const dom = fakeDom({ cleanupGoalValue: { value: '50' } });
  const adopted: unknown[] = [];
  // Clear target and the constant and listeners beside it (review HD-L16).
  const at = INDEX.indexOf("$('cleanupGoalClear').addEventListener('click', () => {");
  const handler = INDEX.slice(INDEX.lastIndexOf('// An edit like every other field here', at), INDEX.indexOf('/* ── Reclaim Score weights', at));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('$', 'adoptCartGoal', `'use strict'; ${braced('function setSettingsStatus(')} ${handler}`)(dom.$, (bytes: unknown) => { adopted.push(bytes); return null; });
  const clear = dom.$('cleanupGoalClear').listeners.click;
  assert.ok(clear, 'Clear target has a click handler');
  clear();
  assert.equal(dom.$('cleanupGoalValue').value, '', 'the box is emptied');
  assert.deepEqual(adopted, [], 'the live target is not touched — Save carries the change to the meter');
  assert.match(dom.$('settingsStatus').textContent, /press Save to keep it/, 'and the sheet says Save is what keeps it');
});

/*
 * "Target cleared — press Save to keep it" stayed up once a new target was typed, untrue while Save would
 * store the new figure; and a second press of Clear target was silent, the same words being no news to
 * sayAloud (review HD-L16).
 */
test('"Target cleared" is retired once a new target is typed or its unit changed, and each press of Clear target is said (review HD-L16)', () => {
  const dom = fakeDom({ cleanupGoalValue: { value: '50' } });
  const at = INDEX.indexOf("$('cleanupGoalClear').addEventListener('click', () => {");
  const region = INDEX.slice(INDEX.lastIndexOf('// An edit like every other field here', at), INDEX.indexOf('/* ── Reclaim Score weights', at));
  assert.ok(region.includes('cleanupGoalClear'), 'control: the region holds Clear target');
  const said: string[] = [];
  const memory = new Map<string, string>();
  // The page's rule (sayAloud, 040): the same words again are no news, and are not said.
  const sayAloud = (id: string, words: string) => { if (memory.get(id) === words) return; memory.set(id, words); if (words) said.push(words); };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('$', 'adoptCartGoal', 'sayAloud', `'use strict'; ${braced('function setSettingsStatus(')} ${region}`)(dom.$, () => null, sayAloud);
  const clear = dom.$('cleanupGoalClear').listeners.click;
  clear();
  assert.deepEqual(said, ['Target cleared — press Save to keep it'], 'control: the first press is said');
  clear();
  assert.equal(said.length, 2, 'a second press is said again');

  assert.ok(dom.$('cleanupGoalValue').listeners.input, 'typing a target is listened to');
  assert.ok(dom.$('cleanupGoalUnit').listeners.change, 'and so is a change of unit');
  dom.$('cleanupGoalValue').value = '20';
  dom.$('cleanupGoalValue').listeners.input();
  assert.equal(dom.$('settingsStatus').textContent, '', 'a new target typed retires the line');
  clear();
  dom.$('cleanupGoalUnit').listeners.change();
  assert.equal(dom.$('settingsStatus').textContent, '', 'and so does a new unit');

  // A line about something else is not retired by typing.
  const unread = 'Your settings could not be read, so Save is off — nothing here can overwrite them.';
  dom.$('settingsStatus').textContent = unread;
  dom.$('cleanupGoalValue').listeners.input();
  assert.equal(dom.$('settingsStatus').textContent, unread, 'control: why Save is off stays');
});

/*
 * With the stored settings unreadable, Save is off and the line says why. Clear target wrote "press Save to
 * keep it" over that line — untrue, Save being off — and typing a target then retired it, leaving Save off with
 * nothing saying why (review HD2 F1.11).
 */
test('while Save is off, Clear target and a new target leave the line that says why alone (review HD2 F1.11)', () => {
  const unread = 'Your settings could not be read, so Save is off — nothing here can overwrite them. Close this sheet and open Settings again to try again.';
  const opened = braced("$('settingsBtn').addEventListener('click', async () => {");
  assert.ok(opened.includes(`settingsSaveOn(false);`) && opened.includes(`setSettingsStatus('${unread}');`), 'control: a failed load turns Save off and says why');
  const dom = fakeDom({ cleanupGoalValue: { value: '50' }, settingsSaveBtn: { disabled: true }, settingsStatus: { textContent: unread } });
  const at = INDEX.indexOf("$('cleanupGoalClear').addEventListener('click', () => {");
  const region = INDEX.slice(INDEX.lastIndexOf('// An edit like every other field here', at), INDEX.indexOf('/* ── Reclaim Score weights', at));
  const said: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('$', 'adoptCartGoal', 'sayAloud', `'use strict'; ${braced('function setSettingsStatus(')} ${region}`)(dom.$, () => null, (_id: string, words: string) => { said.push(words); });
  dom.$('cleanupGoalClear').listeners.click();
  assert.equal(dom.$('cleanupGoalValue').value, '', 'control: the box is emptied');
  assert.equal(dom.$('settingsStatus').textContent, unread, 'the line still says why Save is off');
  assert.deepEqual(said, [], 'and nothing untrue is said');
  dom.$('cleanupGoalValue').value = '20';
  dom.$('cleanupGoalValue').listeners.input();
  dom.$('cleanupGoalUnit').listeners.change();
  assert.equal(dom.$('settingsStatus').textContent, unread, 'nor does a new target take it down');

  // Control: with Save on, the press says what it did.
  dom.$('settingsSaveBtn').disabled = false;
  dom.$('cleanupGoalClear').listeners.click();
  assert.equal(dom.$('settingsStatus').textContent, 'Target cleared — press Save to keep it', 'control: with Save on, Clear target says so');
});

/* ══════════════ D76 — Save closes the sheet once the server has the settings ══════════════ */

function saveRuntime(api: (url: string, options?: ApiCall['options']) => Promise<unknown>) {
  const dom = fakeDom({ settingsModal: {} });
  dom.$('settingsModal').classList.add('open');
  const handler = braced("$('settingsSaveBtn').addEventListener('click', async () => {");
  const closed: string[] = [];
  const toasts: { msg: string; kind?: string }[] = [];
  const plan = { reread: 0 };
  const stubs = ['collectSettingsForms', 'renderSchedules', 'renderIgnores', 'renderCleanupGoalFields', 'renderReclaimWeights',
    'reclaimReset', 'drawView', 'refreshBigFiles'];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(
    '$', 'api', 'toast', 'closeModal', 'refreshFastRescanPlan',
    `'use strict';
     let settingsData = { ignore: [], schedules: [] };
     let humanScaleOn = true;
     const state = { view: 'dashboard', treemap: {}, bigFilesSort: 'size' };
     ${stubs.map((name) => `function ${name}() {}`).join('\n')}
     function collectCloudCreds() { return {}; }
     function collectReclaimWeights() { return {}; }
     function collectCleanupGoal() { return null; }
     // Save reads the sheet through settingsBody, and checks typed scheduled
     // folders first (final review F1.4) — none here, so it goes straight on.
     let schedStoredPaths = new Set();
     let settingsSaveSeq = 0;
     ${braced('function settingsBody(')}
     ${braced('async function settingsFoldersChecked(')}
     ${INDEX.includes('function settingsRangeRefusal(') ? braced('function settingsRangeRefusal(') : ''}
     ${handler});`,
  )(dom.$, api, (msg: string, kind?: string) => { toasts.push({ msg, kind }); }, (id: string) => {
    closed.push(id);
    dom.$(id).classList.remove('open');
  }, async () => { plan.reread++; });
  const save = dom.$('settingsSaveBtn').listeners.click;
  assert.ok(save, 'the Save button has a click handler');
  return { dom, save, closed, toasts, plan };
}

test('a successful Save closes the sheet through the one close path, and the toast confirms it (D76)', async () => {
  const { api, calls } = recordingApi({ '/api/settings': { ignore: [], schedules: [] } });
  const { dom, save, closed, toasts } = saveRuntime(api);
  await save();
  await settle();
  assert.equal(calls.filter((c) => c.url === '/api/settings' && c.options?.method === 'PUT').length, 1, 'one PUT');
  assert.deepEqual(closed, ['settingsModal'], 'the sheet closes through closeModal, like every other way out');
  assert.equal(dom.$('settingsModal').classList.contains('open'), false, 'and is no longer open');
  assert.ok(toasts.some((t) => /^Settings saved/.test(t.msg) && t.kind === undefined), `the toast says so: ${JSON.stringify(toasts)}`);
});

test('a saved "Don\'t scan" list re-reads the Fast-rescan plan at once, so the box follows it without a scan or a reload (QA D45)', async () => {
  // A "Don't scan" pattern moves the next scan off the native engine, and
  // that decides whether the Fast-rescan box is offered. The plan was read at
  // boot and after a scan only, so the box stayed as it was until then.
  const { api } = recordingApi({ '/api/settings': { ignore: [{ pattern: 'node_modules', scope: 'scan' }], schedules: [] } });
  const ok = saveRuntime(api);
  await ok.save();
  await settle();
  assert.equal(ok.plan.reread, 1, 'once the server has the settings, the plan is read again');

  const failed = saveRuntime(async () => { throw new Error('disk full'); });
  await failed.save();
  await settle();
  assert.equal(failed.plan.reread, 0, 'nothing was saved, so there is nothing to re-read');
});

test('a failed Save keeps the sheet open, with the edits still in it, and says why (D76)', async () => {
  const api = async () => { throw new Error('disk full'); };
  const { dom, save, closed, toasts } = saveRuntime(api);
  await save();
  await settle();
  assert.deepEqual(closed, [], 'nothing was saved, so nothing closes');
  assert.equal(dom.$('settingsModal').classList.contains('open'), true, 'the sheet stays open');
  assert.ok(toasts.some((t) => t.msg === 'Save failed: disk full' && t.kind === 'error'), `and says why: ${JSON.stringify(toasts)}`);
});

/* ══════════════ The hunt (C79, C81) ══════════════ */

test('Save waits for the settings to load, and stays off when they could not be read — never saving placeholder lists over the stored ones (hunt C79)', () => {
  const opener = braced("$('settingsBtn').addEventListener('click', async () =>");
  const get = opener.indexOf("settingsData = await api('/api/settings');");
  assert.ok(get > 0);
  assert.ok(opener.lastIndexOf('settingsSaveOn(false);', get) !== -1, 'Save is off before the GET goes out');
  const failure = opener.slice(get, opener.indexOf('rememberStoredSchedules();'));
  assert.doesNotMatch(failure, /settingsData = \{ ignore: \[\], schedules: \[\] \}/, 'a failed load never stands placeholder lists in for the stored ones');
  assert.match(failure, /return;/, 'a failed load renders nothing and saves nothing');
  assert.match(failure, /setSettingsStatus\('Your settings could not be read, so Save is off/, 'and the sheet says why Save is off, aloud too (review F1.17)');
  assert.match(failure, /settingsSaveOn\(true\);/, 'Save comes back once the settings have loaded');
  const ok = failure.indexOf('settingsSaveOn(true);');
  assert.ok(ok > failure.indexOf('return;'), 'only after the failure path has returned');
});

test('a figure outside its field\'s range is refused with a sentence naming the field and the range, never replaced on Save (hunt C81)', () => {
  const boxes: Record<string, { value: string }> = {};
  const refusal = new Function('$', `${braced('function settingsRangeRefusal(')}; return settingsRangeRefusal;`)((id: string) => boxes[id]) as () => string | null;
  const set = (v: Record<string, string>): void => {
    Object.assign(boxes, { forecastDays: { value: '30' }, watchIdleMin: { value: '10' }, capsuleRetentionDays: { value: '30' }, capsuleMaxPercent: { value: '10' } });
    for (const [k, x] of Object.entries(v)) boxes[k] = { value: x };
  };
  set({});
  assert.equal(refusal(), null, 'figures in range save as typed');
  set({ capsuleRetentionDays: '0' });
  assert.match(String(refusal()), /Keep copies for/, String(refusal()));
  assert.match(String(refusal()), /1 to 365/, String(refusal()));
  set({ capsuleMaxPercent: '95' });
  assert.match(String(refusal()), /1 to 90 .*Never use more than/, String(refusal()));
  set({ watchIdleMin: '0' });
  assert.match(String(refusal()), /1 to 120 .*Auto-pause after/, String(refusal()));
  set({ forecastDays: '400' });
  assert.match(String(refusal()), /1 to 365 .*Warn within/, String(refusal()));
  set({ forecastDays: '1.5' });
  assert.match(String(refusal()), /whole number/, 'a part of a day is not rounded silently');
  const save = INDEX.slice(INDEX.indexOf("$('settingsSaveBtn').addEventListener('click'"), INDEX.indexOf("$('settingsSaveBtn').addEventListener('click'") + 400);
  assert.match(save, /settingsRangeRefusal\(\)/, 'Save refuses before it reads the sheet');
});

test('Settings promises up to three quick wins, as the tour offers — fewer, or none, when fewer exist (hunt C89)', () => {
  const sheet = readFileSync(path.join(__dirname, '..', 'src', 'ui', 'markup', '110-modal-settings.html'), 'utf8');
  assert.doesNotMatch(sheet, />Three quick wins/, 'the tour slices to at most three; it is not always three');
  assert.match(sheet, />Up to three quick wins, staged only when you click, nothing deleted\.</);
});

test('the Undo Vault size cap says what it is a share of: the free space on its disk, counting what the Undo Vault already holds — not "this disk" (CL-3)', () => {
  // timeCapsule.capFor: the percentage is of free space plus what the Undo Vault holds (SECURITY.md says so too).
  const at = INDEX.indexOf('<label for="capsuleMaxPercent">');
  assert.notEqual(at, -1, 'control: the cap is in the sheet');
  const row = INDEX.slice(at, INDEX.indexOf('</div>', at)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(row, /Never use more than % of the free space on this disk, counting what the Undo Vault holds — oldest copies go first/, row);
  assert.match(INDEX.slice(at, INDEX.indexOf('</div>', at)), /aria-label="Undo Vault size cap as a percentage of the free space on this disk, counting what it already holds"/, 'and so does its name');
});

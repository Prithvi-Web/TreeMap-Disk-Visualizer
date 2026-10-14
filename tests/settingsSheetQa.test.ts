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
    ...init,
  };
  return el;
}

function fakeDom(markup: Record<string, Partial<FakeEl>> = {}) {
  const els = new Map<string, FakeEl>();
  const $ = (id: string): FakeEl => {
    let el = els.get(id);
    if (!el) { el = fakeEl(id, markup[id]); els.set(id, el); }
    return el;
  };
  return { $, els };
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
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(
    '$', 'api', 'toast',
    `'use strict';
     let settingsData = { ignore: [], schedules: [] };
     ${stubs.map((name) => `function ${name}() {}`).join('\n')}
     ${liftedSrc}
     ${opener});`,
  )(dom.$, api, (msg: string) => { toasts.push(msg); });
  const open = dom.$('settingsBtn').listeners.click;
  assert.ok(open, 'the Settings button has a click handler');
  return { dom, open, toasts };
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

/* ══════════════ D72 — the Time Capsule says which deletes it copies ══════════════ */

/**
 * The truth, read from the server: the services that route a delete through
 * protectAndTrash (copy, verify, then trash). Every one of them must be named
 * where the app says what the capsule holds. A new caller fails here until
 * the wording names it.
 */
const CAPSULE_ROUTES: Record<string, string> = {
  'autopilot.ts': 'Autopilot',
  'cartCommit.ts': 'cleanup cart',
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
  const head = INDEX.indexOf('></span>Time Capsule</div>');
  assert.notEqual(head, -1, 'the Settings sheet has a Time Capsule section');
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
  const start = readme.indexOf('### 🕰️ Time Capsule');
  assert.notEqual(start, -1, 'the README has a Time Capsule section');
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
  assert.equal(note![1], 'Theme, scanning budget, scan engine and drives are saved the moment you pick one. Save keeps your other edits on this sheet.');
  for (const words of Object.values(named)) assert.match(note![1].toLowerCase(), new RegExp(`\\b${words}\\b`), `the note names ${words}`);
  assert.ok(foot.indexOf('id="settingsSaveNote"') < foot.indexOf('data-close="settingsModal"'), 'beside the two buttons it explains, before them');
  assert.match(foot, /id="settingsStatus"/, 'the status line for a change made here stays');
  const css = INDEX.slice(INDEX.indexOf('/* ── Settings modal ── */'));
  assert.match(css, /\.settings-foot-text \{ flex: 1; min-width: 0; display: flex; flex-direction: column;/, 'the note takes the room beside the buttons and wraps there');
});

test('"Clear target" is an edit like the others: the live target and its meter stay until Save, so closing without saving drops it (review F1.10)', () => {
  // It used to hide the cart's target meter on the spot while the stored
  // target stayed — "Close without saving" then left the two disagreeing
  // until Settings was reopened or the page reloaded.
  const dom = fakeDom({ cleanupGoalValue: { value: '50' } });
  const adopted: unknown[] = [];
  const handler = braced("$('cleanupGoalClear').addEventListener('click', () => {");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('$', 'adoptCartGoal', `'use strict'; ${handler});`)(dom.$, (bytes: unknown) => { adopted.push(bytes); return null; });
  const clear = dom.$('cleanupGoalClear').listeners.click;
  assert.ok(clear, 'Clear target has a click handler');
  clear();
  assert.equal(dom.$('cleanupGoalValue').value, '', 'the box is emptied');
  assert.deepEqual(adopted, [], 'the live target is not touched — Save carries the change to the meter');
  assert.match(dom.$('settingsStatus').textContent, /press Save to keep it/, 'and the sheet says Save is what keeps it');
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

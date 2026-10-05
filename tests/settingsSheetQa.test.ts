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
    'renderAllocationDiagnostic', 'renderEngineBudgetHelp', 'loadEngineBudget', 'renderSchedules', 'renderIgnores',
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

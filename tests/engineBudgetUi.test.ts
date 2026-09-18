import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEX, lift } from './fixtures/liftFrontend';

/**
 * The scanning budget in the UI — Phase 2 governor plan, Task 6.
 *
 * Settings gains a "Scanning budget" section: Automatic, Eco, Balanced and
 * Turbo as radios, one plain sentence each, saved the moment one is picked —
 * through the page's one api() wrapper, to PUT /api/engine/budget. The
 * Dashboard's engine row says which budget the scan ran under. The endpoint
 * lands with the native governor, so a build without it has to SAY so: a 404
 * renders "Not available in this build", never a blank row that looks like a
 * control nobody wired.
 *
 * Everything here is executed out of the built page. The pure helpers are
 * lifted with the shared fixture; the Settings block is evaluated as a region
 * with api/$/toast injected (its two async functions cannot go through lift);
 * and the save handler's URL is asserted on its SOURCE, because a recording
 * stub on its own would agree with whatever it was handed.
 */

const PRESETS = ['auto', 'eco', 'balanced', 'turbo'] as const;
type Preset = (typeof PRESETS)[number];

const LABELS: Record<Preset, string> = { auto: 'Automatic', eco: 'Eco', balanced: 'Balanced', turbo: 'Turbo' };
const SENTENCES: Record<Preset, string> = {
  auto: 'Balanced, and Eco by itself on battery or when the Mac runs hot',
  eco: 'A quarter of the machine; scans take longer and stay out of your way',
  balanced: 'Half the machine; backs off while you are working',
  turbo: 'All of it; for when you are watching and want it now',
};
const UNAVAILABLE = 'Not available in this build';

/* ══════════════ Slicing helpers — explicit anchors, never a backwards slice ══════════════ */

function slice(a: string, b: string): string {
  const i = INDEX.indexOf(a);
  assert.notEqual(i, -1, `anchor "${a}" exists in index.html`);
  const j = INDEX.indexOf(b, i + a.length);
  assert.notEqual(j, -1, `anchor "${b}" follows it`);
  return INDEX.slice(i, j);
}

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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ══════════════ A fake DOM: the five elements the Settings block touches ══════════════ */

type Radio = {
  id: string; value: string; checked: boolean; disabled: boolean;
  listeners: Record<string, () => void>;
  addEventListener(type: string, fn: () => void): void;
};
type Note = { id: string; textContent: string };

function makeSettingsDom() {
  const els: Record<string, Radio | Note> = {};
  const radios: Radio[] = PRESETS.map((p) => {
    const r: Radio = {
      id: `engineBudget-${p}`, value: p, checked: p === 'auto', disabled: false, listeners: {},
      addEventListener(type, fn) { r.listeners[type] = fn; },
    };
    els[r.id] = r;
    return r;
  });
  const note: Note = { id: 'engineBudgetNote', textContent: '' };
  els[note.id] = note;
  const checkedPreset = () => radios.filter((r) => r.checked).map((r) => r.value);
  /** What a click on a radio does: the browser checks it, then fires change. */
  const pick = async (p: Preset) => {
    for (const r of radios) r.checked = r.value === p;
    const fn = radios.find((r) => r.value === p)!.listeners.change;
    assert.ok(fn, `the ${p} radio has a change listener`);
    fn();
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the save's promise chain settle
  };
  return { $: (id: string) => els[id] ?? null, radios, note, checkedPreset, pick };
}

type ApiCall = { url: string; options?: { method?: string; body?: string } };
type Answer = {
  setting: { preset: string; cpuPercent: number | null };
  effective: { preset: string; targetShare: number; source: string };
  native: { available: boolean; version: string | null; reason: string | null };
  snapshot: unknown;
};
const answer = (over: Partial<Answer> = {}): Answer => ({
  setting: { preset: 'auto', cpuPercent: null },
  effective: { preset: 'balanced', targetShare: 0.5, source: 'native' },
  native: { available: true, version: '0.1.0', reason: null },
  snapshot: null,
  ...over,
});

type Runtime = {
  loadEngineBudget: () => Promise<void>;
  saveEngineBudget: (preset: string) => Promise<void>;
};

/** The Settings block, evaluated with api/$/toast injected — the real wiring included. */
function budgetRuntime(api: (url: string, options?: ApiCall['options']) => Promise<unknown>, toast: (msg: string, kind?: string) => void) {
  const src = slice('/* ── Scanning budget', '/* ── Cleanup target');
  const dom = makeSettingsDom();
  const budgetPresetLabel = lift<(p: unknown) => string>(['budgetPresetLabel'], 'budgetPresetLabel');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const rt = new Function(
    'api', '$', 'toast', 'budgetPresetLabel',
    `'use strict'; ${src}\nreturn { loadEngineBudget, saveEngineBudget };`,
  )(api, dom.$, toast, budgetPresetLabel) as Runtime;
  return { ...rt, dom };
}

function recordingApi(answers: { get: () => Promise<unknown>; put: (call: ApiCall) => Promise<unknown> }) {
  const calls: ApiCall[] = [];
  const api = async (url: string, options?: ApiCall['options']) => {
    const call = { url, options };
    calls.push(call);
    return options && options.method === 'PUT' ? answers.put(call) : answers.get();
  };
  return { api, calls };
}

function recordingToast() {
  const toasts: { msg: string; kind: string }[] = [];
  return { toast: (msg: string, kind = 'success') => { toasts.push({ msg, kind }); }, toasts };
}

/* ══════════════ 1. The section, as shipped markup ══════════════ */

test('Settings has a "Scanning budget" section: four labelled radios, Automatic checked, one plain sentence each', () => {
  const modal = slice('<div class="modal-backdrop" id="settingsModal"', 'id="settingsSaveBtn"');
  // The same shape the palette test holds every section to, so ⌘K can land on it.
  assert.match(modal, /class="set-h"[^>]*>(?:<span[^>]*><\/span>)?Scanning budget/, 'a real Settings heading');
  assert.match(modal, /<[^>]+role="radiogroup"[^>]*aria-label="Scanning budget"/, 'the four radios are one labelled group');
  for (const p of PRESETS) {
    const input = new RegExp(`<input type="radio" name="engineBudget" id="engineBudget-${p}" value="${p}"([^>]*)>`).exec(modal);
    assert.ok(input, `the ${p} radio exists, in the one radio group`);
    assert.equal(/\bchecked\b/.test(input![1]), p === 'auto', `${p} is ${p === 'auto' ? '' : 'not '}the default`);
    const row = new RegExp(
      `id="engineBudget-${p}"[^>]*>\\s*<span class="budget-name">${LABELS[p]}</span>\\s*` +
      `<span class="muted budget-help">${escapeRe(SENTENCES[p])}</span>`,
    );
    assert.match(modal, row, `${LABELS[p]} carries its one plain sentence`);
    assert.match(modal, new RegExp(`<label[^>]*for="engineBudget-${p}"`), `${LABELS[p]} is a real label, so the sentence is clickable`);
  }
  assert.match(modal, /id="engineBudgetNote"/, 'a line under the radios says what is running now, or why nothing can be picked');
  const section = slice('Scanning budget</div>', 'Disk-full forecast');
  assert.doesNotMatch(section.replace(/<[^>]+>/g, ' '), /\bdirector(y|ies)\b|governor|shim|throttle|duty/i, 'plain words: folder, not directory; no engine jargon');
});

test('the section joins the ⌘K palette registry like the other Settings sections', () => {
  const at = INDEX.indexOf('const CMDK_SETTINGS_SECTIONS');
  assert.notEqual(at, -1);
  const sections = INDEX.slice(at, INDEX.indexOf('];', at));
  const row = /\{ name: 'Scanning budget', hint: '([^']+)' \}/.exec(sections);
  assert.ok(row, 'Scanning budget is a registered section');
  assert.match(row![1], /eco/, 'typing a preset name finds it');
  assert.match(row![1], /turbo/);
});

test('opening Settings reads the budget from its own endpoint, independent of /api/settings', () => {
  const opener = braced("$('settingsBtn').addEventListener('click', async () => {");
  assert.match(opener, /loadEngineBudget\(\)/, 'the sheet loads the budget when it opens');
  const load = braced('async function loadEngineBudget(');
  assert.match(load, /\bapi\(\s*'\/api\/engine\/budget'\s*\)/, 'a GET through the shared wrapper');
});

/* ══════════════ 2. Saving — the URL on the handler's source, then driven ══════════════ */

test('the save handler PUTs to /api/engine/budget through the shared wrapper — asserted on its source', () => {
  const save = braced('async function saveEngineBudget(');
  assert.match(save, /\bapi\(\s*'\/api\/engine\/budget'\s*,\s*\{\s*method:\s*'PUT'/, 'PUT /api/engine/budget, like every other settings save');
  assert.doesNotMatch(save, /\/api\/settings/, 'never the general settings endpoint — that one merges a form, this is a dial');
  assert.match(save, /body:\s*JSON\.stringify\(\{\s*preset,\s*cpuPercent\s*\}\)/, 'the contract body: { preset, cpuPercent }');
  assert.match(save, /catch \(e\) \{[\s\S]*toast\([^)]*'error'\)/, 'a failure is a toast, not a silent revert');
  const wiring = slice('/* ── Scanning budget', '/* ── Cleanup target');
  assert.match(wiring, /addEventListener\('change'[\s\S]{0,120}saveEngineBudget\(/, 'every radio saves on change');
});

test('picking a preset saves it: PUT { preset, cpuPercent } with the stored cpuPercent kept, and the row re-renders from the answer', async () => {
  const { api, calls } = recordingApi({
    get: async () => answer({ setting: { preset: 'auto', cpuPercent: 40 } }),
    put: async () => answer({ setting: { preset: 'eco', cpuPercent: 40 }, effective: { preset: 'eco', targetShare: 0.25, source: 'native' } }),
  });
  const { toast, toasts } = recordingToast();
  const rt = budgetRuntime(api, toast);
  await rt.loadEngineBudget();
  assert.deepEqual(rt.dom.checkedPreset(), ['auto'], 'the saved preset is the one checked after a load');
  assert.equal(calls[0].url, '/api/engine/budget');
  assert.equal(calls[0].options, undefined, 'a plain GET');

  await rt.dom.pick('eco');
  assert.equal(calls.length, 2, 'one save per pick');
  assert.equal(calls[1].url, '/api/engine/budget');
  assert.equal(calls[1].options?.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1].options!.body!), { preset: 'eco', cpuPercent: 40 }, 'the UI has no cpuPercent control, so the stored value rides along unchanged');
  assert.deepEqual(rt.dom.checkedPreset(), ['eco']);
  assert.match(rt.dom.note.textContent, /\bEco\b/, 'the line under the radios now says Eco is what runs');
  assert.equal(toasts.filter((t) => t.kind === 'error').length, 0, 'no error toast on a good save');
});

test('a failed save puts the radio back on the saved preset and says why in a toast', async () => {
  const { api } = recordingApi({
    get: async () => answer(),
    put: async () => { throw Object.assign(new Error('Unknown preset'), { status: 400, code: 'BAD_SETTING' }); },
  });
  const { toast, toasts } = recordingToast();
  const rt = budgetRuntime(api, toast);
  await rt.loadEngineBudget();
  await rt.dom.pick('turbo');
  assert.deepEqual(rt.dom.checkedPreset(), ['auto'], 'the radio does not stay on a value the server refused');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].kind, 'error');
  assert.match(toasts[0].msg, /Unknown preset/, 'the server\'s own reason is shown');
});

/* ══════════════ 3. A build without the endpoint ══════════════ */

test(`a 404 renders "${UNAVAILABLE}" and disables the radios — never a silent blank`, async () => {
  // The wrapper throws on every non-2xx; Express's unknown-route answer is
  // { error: 'Endpoint not found', code: 'NOT_FOUND' } with status 404.
  const api = async () => { throw Object.assign(new Error('Endpoint not found'), { status: 404, code: 'NOT_FOUND' }); };
  const { toast, toasts } = recordingToast();
  const rt = budgetRuntime(api, toast);
  await rt.loadEngineBudget();
  assert.equal(rt.dom.note.textContent, UNAVAILABLE);
  assert.deepEqual(rt.dom.radios.map((r) => r.disabled), [true, true, true, true], 'nothing can be picked that nothing will store');
  assert.equal(toasts.length, 0, 'a missing endpoint is a state to show, not an error to shout');
});

test('any other failure to read the budget is still a sentence in the row, with the reason', async () => {
  const api = async () => { throw Object.assign(new Error('Couldn’t reach TreeMap — its own server stopped answering.'), { status: 0, code: 'OFFLINE' }); };
  const { toast } = recordingToast();
  const rt = budgetRuntime(api, toast);
  await rt.loadEngineBudget();
  assert.notEqual(rt.dom.note.textContent.trim(), '', 'never blank');
  assert.notEqual(rt.dom.note.textContent, UNAVAILABLE, 'and not the wrong sentence: this build may well have it');
  assert.match(rt.dom.note.textContent, /stopped answering/, 'the wrapper\'s own message is what the reader sees');
});

test('a budget kept without the native governor says it is approximate, in plain words', async () => {
  const api = async () => answer({ effective: { preset: 'balanced', targetShare: 0.5, source: 'node-shim' }, native: { available: false, version: null, reason: 'no prebuilt module for this platform' } });
  const { toast } = recordingToast();
  const rt = budgetRuntime(api, toast);
  await rt.loadEngineBudget();
  assert.match(rt.dom.note.textContent, /^Right now: Balanced/, 'the effective preset, capitalised');
  assert.match(rt.dom.note.textContent, /approximate/i, 'and that this build can only keep to it roughly');
  assert.doesNotMatch(rt.dom.note.textContent, /shim|governor/i, 'without naming the machinery');
});

/* ══════════════ 4. The Dashboard note beside the engine name ══════════════ */

const engineBudgetNote = lift<(s: unknown) => string>(['budgetPresetLabel', 'engineBudgetNote'], 'engineBudgetNote');

test('the Dashboard note renders "· budget: Balanced" for { budget: { effective: "balanced" } } and nothing without it', () => {
  assert.equal(engineBudgetNote({ budget: { effective: 'balanced' } }), ' · budget: Balanced');
  assert.equal(engineBudgetNote({ budget: { preset: 'auto', effective: 'eco', source: 'native' } }), ' · budget: Eco', 'the EFFECTIVE preset, not the setting');
  assert.equal(engineBudgetNote({}), '', 'stats from a build without the field say nothing');
  assert.equal(engineBudgetNote({ budget: null }), '');
  assert.equal(engineBudgetNote(null), '');
  assert.equal(engineBudgetNote({ budget: { effective: '' } }), '', 'an empty preset is not a budget');
});

test('the engine row prints the note after the engine name and rate', () => {
  const src = slice('function renderDiskNotes()', 'async function renderCloudSafe');
  assert.match(src, /\$\('engineText'\)\.textContent = [^;]*engineBudgetNote\(s\)/, 'the note is part of the engine sentence');
  const formatCount = lift<(n: unknown) => string>(['UI_LOCALE', 'formatCount'], 'formatCount');
  type El = { hidden: boolean; textContent: string; innerHTML: string; dataset: Record<string, unknown>; classList: { add(): void; remove(): void; toggle(): void }; setAttribute(): void; closest(): null; querySelectorAll(): never[] };
  const run = (scanStats: Record<string, unknown>) => {
    const els: Record<string, El> = {};
    const $ = (id: string) => (els[id] ??= { hidden: false, textContent: '', innerHTML: '', dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, closest: () => null, querySelectorAll: () => [] });
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('$', 'state', 'formatCount', 'formatBytes', 'fxTmPillBeamsSync', `'use strict'; ${src} return renderDiskNotes;`)(
      $, { scanStats, treemap: { hideCloud: false } }, formatCount, (n: number) => n + ' B', () => {},
    ) as () => void;
    fn();
    return els;
  };
  const withBudget = run({ engine: 'walker', durationMs: 2000, scanned: 1234, ioThreads: 8, budget: { preset: 'auto', effective: 'balanced', source: 'native' } });
  assert.equal(withBudget.engineRow.hidden, false);
  assert.match(withBudget.engineText.textContent, /Standard walker — scanned 1,234 items in 2\.0 s · 617\/s · budget: Balanced$/);
  const without = run({ engine: 'walker', durationMs: 2000, scanned: 1234, ioThreads: 8 });
  assert.doesNotMatch(without.engineText.textContent, /budget/, 'an older stats shape adds nothing');
});

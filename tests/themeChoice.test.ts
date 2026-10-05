import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEX } from './fixtures/liftFrontend';

/**
 * The theme follows the computer unless you choose otherwise (QA D67, 5 Oct
 * 2026 — batch QA-4a).
 *
 * The sidebar button was a two-way light/dark switch remembered in
 * localStorage, read once at load: no "follow the system" choice, no way
 * back to it once clicked, and nothing in Settings. Now there are three
 * choices — System (the default: follow the computer's light or dark setting,
 * live), Light and Dark — in a Theme row in Settings; the sidebar button flips
 * what you see to an explicit Light or Dark, and Settings is the way back.
 *
 * Both halves run as shipped: the head script that paints before first paint,
 * and the page's theme block, each evaluated with a fake document, storage
 * and media query.
 */

/* ══════════════ Fakes ══════════════ */

function fakeStorage(initial: string | null, { broken = false } = {}) {
  let value = initial;
  return {
    get value() { return value; },
    getItem(key: string) { if (broken) throw new Error('denied'); return key === 'tm-theme' ? value : null; },
    setItem(key: string, v: string) { if (broken) throw new Error('denied'); if (key === 'tm-theme') value = v; },
    removeItem(key: string) { if (broken) throw new Error('denied'); if (key === 'tm-theme') value = null; },
  };
}

function fakeQuery(light: boolean) {
  const listeners: (() => void)[] = [];
  const q = {
    matches: light,
    addEventListener(type: string, fn: () => void) { if (type === 'change') listeners.push(fn); },
    /** The computer switches between light and dark. */
    flip(toLight: boolean) { q.matches = toLight; for (const fn of listeners) fn(); },
    listeners,
  };
  return q;
}

/* ══════════════ The head script — before first paint ══════════════ */

function headTheme(stored: string | null, osLight: boolean, opts: { broken?: boolean } = {}): string {
  const start = INDEX.indexOf('<script>', INDEX.indexOf('<head>'));
  const end = INDEX.indexOf('</script>', start);
  assert.ok(start !== -1 && end > start, 'the head carries its theme script');
  const src = INDEX.slice(start + '<script>'.length, end);
  assert.match(src, /tm-theme/, 'it is the theme script');
  const documentElement = { dataset: {} as Record<string, string> };
  const storage = fakeStorage(stored, opts);
  const query = fakeQuery(osLight);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('document', 'localStorage', 'window', 'matchMedia', src)(
    { documentElement }, storage, { matchMedia: () => query }, () => query);
  return documentElement.dataset.theme;
}

test('before first paint: nothing chosen follows the computer; a choice is kept; junk or no storage follows the computer (D67)', () => {
  assert.equal(headTheme(null, true), 'light', 'System, on a light computer');
  assert.equal(headTheme(null, false), 'dark', 'System, on a dark computer');
  assert.equal(headTheme('dark', true), 'dark', 'an explicit Dark wins');
  assert.equal(headTheme('light', false), 'light', 'an explicit Light wins');
  assert.equal(headTheme('sepia', true), 'light', 'a value TreeMap never writes is System, never a theme of that name');
  assert.equal(headTheme('dark', true, { broken: true }), 'light', 'storage that refuses to be read is System, not a crash before paint');
});

/* ══════════════ The page's theme block ══════════════ */

type El = {
  id: string; checked: boolean; innerHTML: string; title: string; attrs: Record<string, string>;
  listeners: Record<string, () => void>;
  addEventListener(type: string, fn: () => void): void;
  setAttribute(k: string, v: string): void;
};

function themeRuntime(stored: string | null, osLight: boolean, opts: { broken?: boolean; withRadios?: boolean } = {}) {
  const start = INDEX.indexOf('/* ───────────────────────────── Theme ───────────────────────────── */');
  const end = INDEX.indexOf('/* ───────────────────────────── Sidebar', start);
  assert.ok(start !== -1 && end > start, 'the theme block is in the page');
  const els = new Map<string, El>();
  const radios = opts.withRadios !== false ? ['system', 'light', 'dark'].map((c) => `themeChoice-${c}`) : [];
  for (const id of ['themeToggle', ...radios]) {
    const el: El = {
      id, checked: false, innerHTML: '', title: '', attrs: {}, listeners: {},
      addEventListener(type, fn) { el.listeners[type] = fn; },
      setAttribute(k, v) { el.attrs[k] = v; },
    };
    els.set(id, el);
  }
  const documentElement = { dataset: { theme: headTheme(stored, osLight, opts) } as Record<string, string> };
  const storage = fakeStorage(stored, opts);
  const query = fakeQuery(osLight);
  let repaints = 0;
  const handle = { update() { repaints++; } };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(
    'document', 'window', 'localStorage', '$', 'icon', 'state', 'drawnCells', 'isCells', 'repaintCells', 'drawView',
    'donutHandle', 'trendHandle', 'budgetGauges', 'liveLineHandle', 'dhGauge', 'trendNetHandle', 'appsScatterHandle', 'capsuleGaugeHandle',
    `'use strict'; ${INDEX.slice(start, end)}`,
  )(
    { documentElement }, { matchMedia: (q: string) => { assert.equal(q, '(prefers-color-scheme: light)'); return query; } }, storage,
    (id: string) => els.get(id) ?? null, (name: string) => `<${name}>`, { view: 'dashboard' }, () => [], () => false, () => {}, () => {},
    handle, null, [], null, null, null, null, null,
  );
  const checked = () => radios.filter((id) => els.get(id)!.checked).map((id) => id.replace('themeChoice-', ''));
  const pick = (c: string) => {
    for (const id of radios) els.get(id)!.checked = id === `themeChoice-${c}`;
    els.get(`themeChoice-${c}`)!.listeners.change();
  };
  return {
    theme: () => documentElement.dataset.theme, storage, query, checked, pick,
    toggle: () => els.get('themeToggle')!.listeners.click(),
    button: () => els.get('themeToggle')!,
    repaints: () => repaints,
  };
}

test('System is the default and follows the computer as it changes, repainting the charts each time (D67)', () => {
  const t = themeRuntime(null, false);
  assert.equal(t.theme(), 'dark');
  assert.deepEqual(t.checked(), ['system'], 'Settings shows System chosen');
  assert.equal(t.repaints(), 0, 'loading the page repaints nothing');
  t.query.flip(true);
  assert.equal(t.theme(), 'light', 'the computer went light, and so did TreeMap');
  assert.equal(t.repaints(), 1, 'the canvases are told');
  t.query.flip(false);
  assert.equal(t.theme(), 'dark');
  assert.equal(t.storage.value, null, 'following the computer stores nothing');
});

test('the sidebar button flips to an explicit Light or Dark, which the computer no longer overrides (D67)', () => {
  const t = themeRuntime(null, true);
  assert.equal(t.theme(), 'light');
  t.toggle();
  assert.equal(t.theme(), 'dark', 'a click always changes what you see');
  assert.equal(t.storage.value, 'dark', 'and is remembered');
  assert.deepEqual(t.checked(), ['dark'], 'Settings shows the choice');
  t.query.flip(false);
  t.query.flip(true);
  assert.equal(t.theme(), 'dark', 'an explicit choice stays put when the computer changes');
  t.toggle();
  assert.equal(t.theme(), 'light');
  assert.equal(t.storage.value, 'light');
});

test('Settings › Theme is the way back to System, and can choose Light or Dark too (D67)', () => {
  const t = themeRuntime('light', false);
  assert.equal(t.theme(), 'light');
  assert.deepEqual(t.checked(), ['light']);
  t.pick('system');
  assert.equal(t.storage.value, null, 'System forgets the explicit choice');
  assert.equal(t.theme(), 'dark', 'and shows what the computer says');
  t.query.flip(true);
  assert.equal(t.theme(), 'light', 'and follows it again');
  t.pick('dark');
  assert.equal(t.theme(), 'dark');
  assert.equal(t.storage.value, 'dark');
  assert.deepEqual(t.checked(), ['dark']);
});

test('the sidebar button says which theme is chosen and what a click does (D67)', () => {
  const t = themeRuntime(null, false);
  assert.match(t.button().attrs['aria-label'] ?? '', /^Theme: System \(dark now\) — switch to light$/);
  assert.equal(t.button().title, t.button().attrs['aria-label'], 'the tooltip says the same');
  assert.equal(t.button().innerHTML, '<sun>', 'the sun offers light');
  t.toggle();
  assert.match(t.button().attrs['aria-label'] ?? '', /^Theme: Light — switch to dark$/);
  assert.equal(t.button().innerHTML, '<moon>');
});

test('storage that refuses still changes the theme for this session (D67)', () => {
  const t = themeRuntime(null, false, { broken: true });
  t.toggle();
  assert.equal(t.theme(), 'light', 'the click is honoured');
  t.query.flip(false);
  assert.equal(t.theme(), 'light', 'and held for the session, though it could not be remembered');
});

/* ══════════════ The Settings row ══════════════ */

test('Settings has a Theme row: System, Light and Dark, System checked, saved straight away, findable from the palette (D67)', () => {
  const modal = INDEX.slice(INDEX.indexOf('<div class="modal-backdrop" id="settingsModal"'), INDEX.indexOf('id="settingsSaveBtn"'));
  assert.match(modal, /class="set-h"[^>]*>(?:<span[^>]*><\/span>)?Theme<\/div>/, 'a real Settings heading');
  assert.match(modal, /<div id="themeOptions" role="radiogroup" aria-label="Theme">/);
  for (const [c, label] of [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]) {
    const input = new RegExp(`<input type="radio" name="themeChoice" id="themeChoice-${c}" value="${c}"([^>]*)>\\s*<span class="budget-name">${label}</span>`).exec(modal);
    assert.ok(input, `the ${label} radio, labelled`);
    assert.equal(/\bchecked\b/.test(input![1]), c === 'system', `${label} is ${c === 'system' ? '' : 'not '}the default`);
    assert.match(modal, new RegExp(`<label class="rule-row budget-row" for="themeChoice-${c}">`));
  }
  const sections = INDEX.slice(INDEX.indexOf('const CMDK_SETTINGS_SECTIONS'), INDEX.indexOf('];', INDEX.indexOf('const CMDK_SETTINGS_SECTIONS')));
  assert.match(sections, /\{ name: 'Theme', hint: '[^']*system[^']*' \}/, 'typing "system" or "theme" in the palette finds it');
});

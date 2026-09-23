import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every settings write lands in a directory of this file's own.
import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-engine-setting-test-');
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { getSettings, updateSettings } from '../src/services/settings';
import { INDEX, lift } from './fixtures/liftFrontend';

/**
 * The "Scan engine" setting — Phase 3 plan, W2.
 *
 * `engine` is `auto | native | gdu | walker`, Automatic by default (M6 adds a
 * fifth, Windows-only `ntfs-mft` — tests/settingsNtfsMft.test.ts). A
 * hand-edited file is normalised; API input is validated at PUT /api/settings
 * (400 BAD_SETTING). Settings shows it as a "Scan engine" section shaped like
 * the Phase 2 "Scanning budget" row: four radios, one plain sentence each,
 * saved the moment one is picked through the page's one api() wrapper. The
 * Dashboard's engine row says why the engine ran, on hover.
 *
 * As in tests/engineBudgetUi.test.ts, the markup is asserted on the shipped
 * page, the helpers are lifted out of it, and the Settings block is evaluated
 * as a region with api/$/toast injected so the real wiring runs.
 */

const ENGINES = ['auto', 'native', 'gdu', 'walker'] as const;
type Engine = (typeof ENGINES)[number];
const LABELS: Record<Engine, string> = { auto: 'Automatic', native: 'Native', gdu: 'gdu', walker: 'Built-in walker' };
const SENTENCES: Record<Engine, string> = {
  auto: 'TreeMap picks the fastest engine that is exactly as correct',
  native: 'the built-in fast engine, when this build has it',
  gdu: 'the bundled gdu helper, one process per top-level folder',
  walker: 'the original engine — slower, and the one every other engine is checked against',
};

/* ══════════════ the service and the route ══════════════ */

async function listen() {
  resetRateLimiter();
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function req(port: number, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, path: url, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          let parsed: unknown = buf;
          try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

test('engine defaults to auto, and a hand-edited value that is not one of the four is normalised to auto, never trusted', async () => {
  assert.equal((await getSettings()).engine, 'auto');
  for (const [raw, want] of [['native', 'native'], ['gdu', 'gdu'], ['walker', 'walker'], ['auto', 'auto'], ['turbo', 'auto'], [7, 'auto'], [null, 'auto'], [undefined, 'auto'], [['native'], 'auto']] as const) {
    const s = await updateSettings({ engine: raw });
    assert.equal(s.engine, want, `engine ${JSON.stringify(raw)}`);
  }
  await updateSettings({ engine: 'auto' });
});

test('PUT /api/settings validates engine strictly: the four values pass, anything else is 400 BAD_SETTING, and the key alone is a real update', async () => {
  const { port, close } = await listen();
  try {
    for (const engine of ENGINES) {
      const r = await req(port, 'PUT', '/api/settings', { engine });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.engine, engine);
      assert.equal((await req(port, 'GET', '/api/settings')).body.engine, engine, 'GET reflects the write');
    }
    for (const bad of ['turbo', 'NATIVE', '', 3, true, null, { preset: 'native' }, ['native']]) {
      const r = await req(port, 'PUT', '/api/settings', { engine: bad });
      assert.equal(r.status, 400, `engine ${JSON.stringify(bad)} → ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'BAD_SETTING');
      assert.match(r.body.error, /"engine".*auto.*native.*gdu.*walker/);
    }
    assert.equal((await req(port, 'GET', '/api/settings')).body.engine, 'walker', 'a refused value changed nothing');
    const nothing = await req(port, 'PUT', '/api/settings', {});
    assert.equal(nothing.status, 400);
    assert.equal(nothing.body.code, 'NOTHING_TO_UPDATE');
    assert.match(nothing.body.error, /"engine"/, 'the key is named among the ones a body may carry');
    const spec = (await req(port, 'GET', '/api/openapi.json')).body;
    const engine = spec.components.schemas.AppSettings.properties.engine;
    // Plus M6's Windows-only ntfs-mft, which tests/settingsNtfsMft.test.ts covers.
    assert.deepEqual(engine.enum, [...ENGINES, 'ntfs-mft'], 'the spec describes the enum');
    assert.ok(spec.components.schemas.AppSettings.required.includes('engine'));
  } finally {
    await req(port, 'PUT', '/api/settings', { engine: 'auto' }).catch(() => {});
    await close();
  }
});

/* ══════════════ slicing helpers — explicit anchors, never a backwards slice ══════════════ */

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

/* ══════════════ 1. The section, as shipped markup ══════════════ */

test('Settings has a "Scan engine" section: four labelled radios, Automatic checked, one plain sentence each', () => {
  const modal = slice('<div class="modal-backdrop" id="settingsModal"', 'id="settingsSaveBtn"');
  assert.match(modal, /class="set-h"[^>]*>(?:<span[^>]*><\/span>)?Scan engine/, 'a real Settings heading');
  assert.match(modal, /<[^>]+role="radiogroup"[^>]*aria-label="Scan engine"/, 'the four radios are one labelled group');
  for (const e of ENGINES) {
    const input = new RegExp(`<input type="radio" name="scanEngine" id="scanEngine-${e}" value="${e}"([^>]*)>`).exec(modal);
    assert.ok(input, `the ${e} radio exists, in the one radio group`);
    assert.equal(/\bchecked\b/.test(input![1]), e === 'auto', `${e} is ${e === 'auto' ? '' : 'not '}the default`);
    const row = new RegExp(
      `id="scanEngine-${e}"[^>]*>\\s*<span class="budget-name">${escapeRe(LABELS[e])}</span>\\s*` +
      `<span class="muted budget-help"(?: id="scanEngineHelp-${e}")?>${escapeRe(SENTENCES[e])}</span>`,
    );
    assert.match(modal, row, `${LABELS[e]} carries its one plain sentence`);
    assert.match(modal, new RegExp(`<label[^>]*for="scanEngine-${e}"`), `${LABELS[e]} is a real label, so the sentence is clickable`);
  }
  assert.match(modal, /<span class="muted budget-help" id="scanEngineHelp-gdu">/, 'the gdu sentence carries the id the script rewrites on Windows');
  const section = slice('Scan engine</div>', 'Disk-full forecast');
  assert.doesNotMatch(section.replace(/<[^>]+>/g, ' '), /\bdirector(y|ies)\b|governor|shim|throttle|duty|napi|Rust/i, 'plain words: folder, not directory; no engine jargon');
  assert.match(section, /next scan/, 'says when it takes effect');
});

test('the section joins the ⌘K palette registry like the other Settings sections', () => {
  const at = INDEX.indexOf('const CMDK_SETTINGS_SECTIONS');
  assert.notEqual(at, -1);
  const sections = INDEX.slice(at, INDEX.indexOf('];', at));
  const row = /\{ name: 'Scan engine', hint: '([^']+)' \}/.exec(sections);
  assert.ok(row, 'Scan engine is a registered section');
  assert.match(row![1], /native/, 'typing an engine name finds it');
  assert.match(row![1], /walker/);
});

/* ══════════════ 2. Saving — the URL on the handler's source, then driven ══════════════ */

test('opening Settings renders the engine from the settings it just loaded, and the save handler PUTs { engine } to /api/settings', () => {
  const opener = braced("$('settingsBtn').addEventListener('click', async () => {");
  assert.match(opener, /renderScanEngine\(settingsData\.engine\)/, 'the sheet shows the stored choice when it opens');
  const save = braced('async function saveScanEngine(');
  assert.match(save, /\bapi\(\s*'\/api\/settings'\s*,\s*\{\s*method:\s*'PUT'/, 'PUT /api/settings, the setting’s own route');
  assert.match(save, /body:\s*JSON\.stringify\(\{\s*engine\s*\}\)/, 'the one key: { engine }');
  assert.match(save, /catch \(e\) \{[\s\S]*toast\([^)]*'error'\)/, 'a failure is a toast, not a silent revert');
  const wiring = slice('/* ── Scan engine', '/* ── Scanning budget');
  assert.match(wiring, /addEventListener\('change'[\s\S]{0,120}saveScanEngine\(/, 'every radio saves on change');
});

type Radio = {
  id: string; value: string; checked: boolean; disabled: boolean;
  listeners: Record<string, () => void>;
  addEventListener(type: string, fn: () => void): void;
};

function makeDom() {
  const els: Record<string, Radio> = {};
  const radios: Radio[] = ENGINES.map((e) => {
    const r: Radio = {
      id: `scanEngine-${e}`, value: e, checked: e === 'auto', disabled: false, listeners: {},
      addEventListener(type, fn) { r.listeners[type] = fn; },
    };
    els[r.id] = r;
    return r;
  });
  const checked = () => radios.filter((r) => r.checked).map((r) => r.value);
  /** What a click on a radio does: the browser checks it, then fires change. */
  const pick = async (e: Engine) => {
    for (const r of radios) r.checked = r.value === e;
    const fn = radios.find((r) => r.value === e)!.listeners.change;
    assert.ok(fn, `the ${e} radio has a change listener`);
    fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { $: (id: string) => els[id] ?? null, radios, checked, pick };
}

type ApiCall = { url: string; options?: { method?: string; body?: string } };
type Runtime = { renderScanEngine: (engine: unknown) => void; saveScanEngine: (engine: string) => Promise<void>; settings: () => { engine?: string } };

/** The Scan engine block, evaluated with api/$/toast/settingsData injected — the real wiring included. */
function engineRuntime(api: (url: string, options?: ApiCall['options']) => Promise<unknown>, toast: (msg: string, kind?: string) => void, settingsData: { engine?: string }) {
  const src = slice('/* ── Scan engine', '/* ── Scanning budget');
  const dom = makeDom();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const rt = new Function(
    'api', '$', 'toast', 'settingsData',
    `'use strict'; ${src}\nreturn { renderScanEngine, saveScanEngine, settings: () => settingsData };`,
  )(api, dom.$, toast, settingsData) as Runtime;
  return { ...rt, dom };
}

function recordingApi(put: (call: ApiCall) => Promise<unknown>) {
  const calls: ApiCall[] = [];
  const api = async (url: string, options?: ApiCall['options']) => {
    const call = { url, options };
    calls.push(call);
    return put(call);
  };
  return { api, calls };
}

function recordingToast() {
  const toasts: { msg: string; kind: string }[] = [];
  return { toast: (msg: string, kind = 'success') => { toasts.push({ msg, kind }); }, toasts };
}

test('picking an engine saves it: PUT { engine } and the row re-renders from the answer', async () => {
  const { api, calls } = recordingApi(async (call) => ({ ...JSON.parse(call.options!.body!), ignore: [], schedules: [] }));
  const { toast, toasts } = recordingToast();
  const rt = engineRuntime(api, toast, { engine: 'gdu' });
  rt.renderScanEngine('gdu');
  assert.deepEqual(rt.dom.checked(), ['gdu'], 'the stored choice is the one checked');
  rt.renderScanEngine('bogus');
  assert.deepEqual(rt.dom.checked(), ['auto'], 'a value the page does not know renders as Automatic, never as nothing checked');

  await rt.dom.pick('native');
  assert.equal(calls.length, 1, 'one save per pick');
  assert.equal(calls[0].url, '/api/settings');
  assert.equal(calls[0].options?.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].options!.body!), { engine: 'native' }, 'only the engine rides in the body; the form’s other fields are not saved by a dial');
  assert.deepEqual(rt.dom.checked(), ['native']);
  assert.equal(rt.settings().engine, 'native', 'the page’s settings copy follows the server’s answer');
  assert.equal(toasts.filter((t) => t.kind === 'error').length, 0);
  assert.match(toasts[0]?.msg ?? '', /Native/, 'the toast names the engine in the user’s words');
});

test('a failed save puts the radio back on the stored engine and says why in a toast', async () => {
  const { api } = recordingApi(async () => { throw Object.assign(new Error('"engine" must be one of "auto", "native", "gdu", "walker"'), { status: 400, code: 'BAD_SETTING' }); });
  const { toast, toasts } = recordingToast();
  const rt = engineRuntime(api, toast, { engine: 'walker' });
  rt.renderScanEngine('walker');
  await rt.dom.pick('native');
  assert.deepEqual(rt.dom.checked(), ['walker'], 'the radio does not stay on a value the server refused');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].kind, 'error');
  assert.match(toasts[0].msg, /must be one of/, 'the server’s own reason is shown');
});

/* ══════════════ 3. The Dashboard engine row ══════════════ */

const engineReasonTitle = lift<(s: unknown) => string>(['engineReasonTitle'], 'engineReasonTitle');

test('the engine row’s hover title is the reason the engine ran, with the fallback reason when there was one', () => {
  assert.equal(engineReasonTitle({ engineReason: 'the native engine was chosen: this build has it' }), 'the native engine was chosen: this build has it');
  assert.equal(
    engineReasonTitle({ engineReason: 'the built-in walker ran', fallbackReason: 'no native module at /x for darwin-arm64' }),
    'the built-in walker ran — no native module at /x for darwin-arm64',
  );
  assert.equal(engineReasonTitle({ engineReason: 'x', fallbackReason: null }), 'x');
  assert.equal(engineReasonTitle({}), '', 'stats from a build without the field say nothing');
  assert.equal(engineReasonTitle(null), '');
});

test('the engine row names the native engine, sets the reason as its title, and keeps the Phase 2 note', () => {
  const src = slice('function renderDiskNotes()', 'async function renderCloudSafe');
  assert.match(src, /\$\('engineText'\)\.title = engineReasonTitle\(s\)/, 'the reason is on hover, not in the sentence');
  assert.match(src, /native: 'Native engine'/, 'the engine has a label');
  const formatCount = lift<(n: unknown) => string>(['UI_LOCALE', 'formatCount'], 'formatCount');
  type El = { hidden: boolean; textContent: string; title: string; innerHTML: string; dataset: Record<string, unknown>; classList: { add(): void; remove(): void; toggle(): void }; setAttribute(): void; closest(): null; querySelectorAll(): never[] };
  const run = (scanStats: Record<string, unknown>) => {
    const els: Record<string, El> = {};
    const $ = (id: string) => (els[id] ??= { hidden: false, textContent: '', title: '', innerHTML: '', dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, closest: () => null, querySelectorAll: () => [] });
    const engineBudgetNote = lift<(s: unknown) => string>(['budgetPresetLabel', 'engineBudgetNote'], 'engineBudgetNote');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('$', 'state', 'formatCount', 'formatBytes', 'fxTmPillBeamsSync', 'engineBudgetNote', 'engineReasonTitle', `'use strict'; ${src} return renderDiskNotes;`)(
      $, { scanStats, treemap: { hideCloud: false } }, formatCount, (n: number) => n + ' B', () => {}, engineBudgetNote, engineReasonTitle,
    ) as () => void;
    fn();
    return els;
  };
  const native = run({ engine: 'native', durationMs: 2000, scanned: 1234, ioThreads: 8, engineReason: 'the native engine was chosen: this build has it', fallbackReason: null, fastPath: 'bulk', budget: { preset: 'auto', effective: 'balanced', source: 'native' } });
  assert.equal(native.engineRow.hidden, false);
  assert.match(native.engineText.textContent, /^Native engine — scanned 1,234 items in 2\.0 s · 617\/s · budget: Balanced$/);
  assert.equal(native.engineText.title, 'the native engine was chosen: this build has it');
  assert.match(native.engineHint.textContent, /one call/i, 'the hint says what makes it fast');
  const fallen = run({ engine: 'walker', durationMs: 2000, scanned: 1234, ioThreads: 4, engineReason: 'the built-in walker ran', fallbackReason: 'no native module for this platform' });
  assert.equal(fallen.engineText.title, 'the built-in walker ran — no native module for this platform');
  const older = run({ engine: 'walker', durationMs: 2000, scanned: 1234, ioThreads: 8 });
  assert.equal(older.engineText.title, '', 'an older stats shape adds nothing');
});

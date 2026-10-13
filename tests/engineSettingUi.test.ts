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
  auto: 'TreeMap picks the fastest engine this scan can use; the Dashboard says which one ran and why',
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
function engineRuntime(api: (url: string, options?: ApiCall['options']) => Promise<unknown>, toast: (msg: string, kind?: string) => void, settingsData: { engine?: string }, refreshFastRescanPlan: () => Promise<void> = async () => {}) {
  const src = slice('/* ── Scan engine', '/* ── Scanning budget');
  const dom = makeDom();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const rt = new Function(
    'api', '$', 'toast', 'settingsData', 'refreshFastRescanPlan',
    `'use strict'; ${src}\nreturn { renderScanEngine, saveScanEngine, settings: () => settingsData };`,
  )(api, dom.$, toast, settingsData, refreshFastRescanPlan) as Runtime;
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

test('a saved engine choice re-reads the Fast-rescan plan at once — the box follows it without a scan or a reload (QA D45)', async () => {
  // The box is offered only where the next scan would not run on the native
  // engine, and refreshFastRescanPlan is what reads that. It ran at boot and
  // after a scan, so choosing the walker here left the box hidden until then.
  let reread = 0;
  const { api } = recordingApi(async (call) => ({ ...JSON.parse(call.options!.body!), ignore: [], schedules: [] }));
  const rt = engineRuntime(api, () => {}, { engine: 'auto' }, async () => { reread++; });
  rt.renderScanEngine('auto');
  await rt.dom.pick('walker');
  assert.equal(reread, 1, 'the plan is read again once the server has the new engine');

  let rereadAfterRefusal = 0;
  const refused = engineRuntime(async () => { throw new Error('no'); }, () => {}, { engine: 'auto' }, async () => { rereadAfterRefusal++; });
  refused.renderScanEngine('auto');
  await refused.dom.pick('walker');
  assert.equal(rereadAfterRefusal, 0, 'a refused save changed nothing, so there is nothing to re-read');
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

type RowEl = { hidden: boolean; textContent: string; title: string; innerHTML: string; dataset: Record<string, unknown>; classList: { add(): void; remove(): void; toggle(): void }; setAttribute(): void; closest(): null; querySelectorAll(): never[] };

/** renderDiskNotes, run out of the page against these stats; the elements it wrote, by id. */
function runEngineRow(scanStats: Record<string, unknown>): Record<string, RowEl> {
  const src = slice('function renderDiskNotes()', 'async function renderCloudSafe');
  const formatCount = lift<(n: unknown) => string>(['UI_LOCALE', 'formatCount'], 'formatCount');
  const els: Record<string, RowEl> = {};
  const $ = (id: string) => (els[id] ??= { hidden: false, textContent: '', title: '', innerHTML: '', dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, closest: () => null, querySelectorAll: () => [] });
  const engineBudgetNote = lift<(s: unknown) => string>(['budgetPresetLabel', 'engineBudgetNote'], 'engineBudgetNote');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('$', 'state', 'formatCount', 'formatBytes', 'fxTmPillBeamsSync', 'engineBudgetNote', 'engineReasonTitle', `'use strict'; ${src} return renderDiskNotes;`)(
    $, { scanStats, treemap: { hideCloud: false } }, formatCount, (n: number) => n + ' B', () => {}, engineBudgetNote, engineReasonTitle,
  ) as () => void;
  fn();
  return els;
}

test('the engine row names the native engine, sets the reason as its title, and keeps the Phase 2 note', () => {
  const src = slice('function renderDiskNotes()', 'async function renderCloudSafe');
  assert.match(src, /\$\('engineText'\)\.title = engineReasonTitle\(s\)/, 'the reason is on hover, not in the sentence');
  assert.match(src, /native: 'Native engine'/, 'the engine has a label');
  const run = runEngineRow;
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

/* ══════════════ 4. What the section and the row claim, held to the engines ══════════════ */

/** A region's words, tags stripped and whitespace folded. */
const words = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

test('the Scan engine section claims equal counts only for the engines that count alike, and says what gdu does instead', () => {
  // gdu emits a folder it may not open as an ordinary empty one and exits 0
  // (missingGigabytes.ts, ENGINES_THAT_COUNT_REFUSALS), so "every engine
  // counts the same files the same way" was false of one of the four.
  const introHtml = /<span data-icon="activity"><\/span>Scan engine<\/div>\s*<div class="muted"[^>]*>([\s\S]*?)<\/div>/.exec(INDEX);
  assert.ok(introHtml, 'the section opens with its one muted sentence');
  const intro = words(introHtml[1]);
  assert.doesNotMatch(intro, /every engine counts/i);
  assert.match(intro, /^Which engine reads the disk\. Picking one saves it straight away and applies from the next scan\. The native engine and the built-in walker count the same files the same way; gdu shows a folder it may not open as empty\.$/);
  assert.doesNotMatch(SENTENCES.auto, /exactly as correct/, 'Automatic picks gdu where the native engine cannot run, and gdu is not');
});

test('the engine row names each engine as Settings names it, and each hint is true of the engine that ran', () => {
  const stats = (engine: string, ioThreads = 8) => ({ engine, durationMs: 2000, scanned: 1234, ioThreads });
  const label = (engine: string) => runEngineRow(stats(engine)).engineText.textContent.split(' — ')[0];
  assert.equal(label('native'), 'Native engine');
  assert.equal(label('gdu-turbo'), 'gdu', 'Settings calls it gdu');
  assert.equal(label('walker'), 'Built-in walker');
  assert.equal(label('turbo-walker'), 'Built-in walker', 'the desktop app always sizes the pool past 4, so "Turbo walker" sat beside "budget: Eco"');
  assert.equal(label('ntfs-mft'), 'NTFS turbo', 'Settings calls it NTFS turbo');
  assert.equal(label('cloud'), 'Cloud metadata listing');

  const gdu = runEngineRow(stats('gdu-turbo')).engineHint.textContent;
  assert.doesNotMatch(gdu, /same counts/, 'gdu does not count a folder it was refused');
  assert.match(gdu, /^A bundled gdu process per top-level folder — faster than the built-in walker, but a folder it may not open shows as empty instead of being counted\.$/);

  const mft = runEngineRow(stats('ntfs-mft')).engineHint.textContent;
  assert.doesNotMatch(mft, /I\/O threads/, 'an NTFS turbo scan does not take the walker\'s hint');
  assert.match(mft, /^Read from the drive's file table by an elevated, read-only helper, then checked against what TreeMap can open itself\.$/);

  assert.equal(runEngineRow(stats('cloud')).engineHint.textContent, '', 'a cloud listing reads no disk, so no claim about reading it');
  assert.equal(runEngineRow(stats('turbo-walker')).engineHint.textContent, 'It reads up to 8 files and folders at once, which keeps the disk busy.', 'the walker keeps its own hint');
  assert.equal(runEngineRow(stats('walker', 16)).engineHint.textContent, 'It reads up to 16 files and folders at once, which keeps the disk busy.');
  assert.equal(runEngineRow(stats('walker', 4)).engineHint.textContent, '', 'and says nothing at the default pool');
});

test('C10: the walker\'s line says why it ran, in plain words, on the line itself — not only on hover', () => {
  // The Dashboard said "16 parallel I/O threads keep the disk saturated
  // instead of Node's default 4", and the reason the walker ran at all - a
  // Don't-scan rule - only in the hover title, with "glob dialect" in it.
  const walker = (over: Record<string, unknown>) => runEngineRow({ engine: 'walker', durationMs: 2000, scanned: 1234, ioThreads: 16, fallbackReason: null, ...over });
  const rule = walker({ engineReason: 'the built-in walker ran: the scan has 1 "don\'t scan" pattern, and only the built-in walker can skip what a pattern names; CPU seconds are not measured per scan by this engine' });
  assert.equal(rule.engineHint.textContent,
    'Used because the scan has 1 "don\'t scan" pattern, and only the built-in walker can skip what a pattern names. It reads up to 16 files and folders at once, which keeps the disk busy.');
  // A root given as a link is told first (D78); the reason after it is the same.
  const linked = walker({ ioThreads: 4, engineReason: '/tmp is a link to /private/tmp; the built-in walker ran: the root is a single file, which the built-in walker records without a listing; CPU seconds are not measured per scan by this engine' });
  assert.equal(linked.engineHint.textContent, 'Used because the root is a single file, which the built-in walker records without a listing.');
  // A faster engine that FAILED: its reason is a developer's (a module path, a rebuild command), so the line says it plainly and the hover keeps the detail.
  const fell = walker({ ioThreads: 4, engineReason: 'the built-in walker ran: the native module is not loaded: no native module at /x/treemap_core.node for darwin-arm64; the legacy engines run instead; CPU seconds are not measured per scan by this engine', fallbackReason: 'the native module is not loaded: no native module at /x/treemap_core.node for darwin-arm64; the legacy engines run instead' });
  assert.equal(fell.engineHint.textContent, 'Used because a faster engine could not run on this computer — point at the line above for the details.');
  assert.match(fell.engineText.title, /no native module/, 'which the hover still gives');
  for (const row of [rule, linked, fell]) {
    assert.doesNotMatch(row.engineHint.textContent + row.engineText.textContent, /Node|glob|I\/O|saturat|thread/i, 'no developer words on the line');
  }
  assert.equal(walker({}).engineHint.textContent, 'It reads up to 16 files and folders at once, which keeps the disk busy.', 'an older stats shape gives no reason, and none is invented');
});

test('C10: a scan too short to measure a speed by states no speed — one file is not "1,000/s"', () => {
  const one = runEngineRow({ engine: 'native', durationMs: 1, scanned: 1, ioThreads: 8 });
  assert.equal(one.engineText.textContent, 'Native engine — scanned 1 item in 0.0 s', `no rate: ${one.engineText.textContent}`);
  const quick = runEngineRow({ engine: 'native', durationMs: 400, scanned: 2400, ioThreads: 8 });
  assert.doesNotMatch(quick.engineText.textContent, /\/s/, 'under a second the rate is mostly the scan\'s setup');
  const real = runEngineRow({ engine: 'native', durationMs: 1000, scanned: 2400, ioThreads: 8 });
  assert.match(real.engineText.textContent, / · 2,400\/s$/, 'from a second up it is the engine\'s speed');
});

test('the Ignore list says that a pattern that skips folders sends every scan to the built-in walker', () => {
  // Any pattern scoped Don't scan or Both reaches every scan (getIgnoreMatchers
  // takes no root), and any such pattern keeps the scan off the native engine
  // and gdu (nativeRule, gduRuleFor). A new row defaults to Both.
  const blurb = words(slice('Ignore list</div>', 'id="ignoreList"'));
  assert.doesNotMatch(blurb, /faster scans/);
  assert.match(blurb, /While any pattern is set to Don't scan or Both, every scan uses the built-in walker, which is slower than the native engine\./);
  assert.match(blurb, /Don't scan skips them entirely; Don't suggest keeps them out of Smart Suggestions only\./, 'the two scopes are still explained');
});

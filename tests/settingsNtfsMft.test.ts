import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every settings write lands in a directory of this file's own.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-ntfs-mft-setting-test-'));
process.env.TREEMAP_DATA_DIR = DATA_DIR;
process.env.TREEMAP_NO_GDU = '1';

import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';
import { ENGINE_SETTINGS, engineSettingRefusal, engineSettingsFor, getSettings, updateSettings } from '../src/services/settings';
import { mftPromptBlocked, mftPromptEnded, resetMftPromptForTests } from '../src/services/scan/mftPrompt';
import { INDEX } from './fixtures/liftFrontend';

/**
 * The fifth Scan engine value, `ntfs-mft` — M6's NTFS turbo mode.
 *
 * Windows only and opt-in: it asks Windows for administrator permission for a
 * helper that reads the drive's file table directly, read-only. Everywhere
 * else it does not exist: not in the platform's list of values, not at
 * PUT /api/settings (400 BAD_SETTING, with a sentence that names Windows), not
 * in a hand-edited settings file (normalised to Automatic, never trusted), and
 * not in Settings, where its row ships hidden and the script shows it only
 * once the page knows the computer is Windows.
 *
 * This suite also runs on the Windows CI leg, so the tests that go through the
 * real service and route answer for the platform they run on; the pure
 * functions, and a stood-in `process.platform`, cover both sides everywhere.
 */

const ON_WINDOWS = process.platform === 'win32';
const FOUR = ['auto', 'native', 'gdu', 'walker'] as const;
const FIVE = ['auto', 'native', 'gdu', 'walker', 'ntfs-mft'] as const;
const TURBO_REFUSAL =
  '"engine" "ntfs-mft" (the NTFS turbo mode) is available only on Windows; here it must be one of "auto", "native", "gdu", "walker"';
const FOUR_REFUSAL = '"engine" must be one of "auto", "native", "gdu", "walker"';
const FIVE_REFUSAL = '"engine" must be one of "auto", "native", "gdu", "walker", "ntfs-mft"';

/* ══════════════ 1. The model ══════════════ */

test('engineSettingsFor: all five values on Windows, the four without ntfs-mft everywhere else, in the order Settings lists them', () => {
  assert.deepEqual([...ENGINE_SETTINGS], [...FIVE], 'ENGINE_SETTINGS is every value, whatever the platform');
  assert.deepEqual([...engineSettingsFor('win32')], [...FIVE]);
  for (const p of ['darwin', 'linux', 'freebsd'] as const) {
    assert.deepEqual([...engineSettingsFor(p)], [...FOUR], `${p} has no NTFS turbo mode`);
  }
  assert.deepEqual([...engineSettingsFor()], [...engineSettingsFor(process.platform)], 'the default is the platform this runs on');
  assert.equal(engineSettingsFor().includes('ntfs-mft'), ON_WINDOWS);
});

test('engineSettingRefusal: ntfs-mft off Windows is a sentence naming Windows; on Windows it is null; anything else lists the platform’s own values', () => {
  for (const p of ['darwin', 'linux'] as const) {
    assert.equal(engineSettingRefusal('ntfs-mft', p), TURBO_REFUSAL, p);
    for (const e of FOUR) assert.equal(engineSettingRefusal(e, p), null, `${e} on ${p}`);
    assert.equal(engineSettingRefusal('turbo', p), FOUR_REFUSAL, `an unknown word on ${p}`);
  }
  for (const e of FIVE) assert.equal(engineSettingRefusal(e, 'win32'), null, `${e} on win32`);
  assert.equal(engineSettingRefusal('turbo', 'win32'), FIVE_REFUSAL, 'on Windows the list names all five');
  for (const bad of ['NTFS-MFT', 'ntfs', 'mft', '', 3, true, null, undefined, ['ntfs-mft'], { engine: 'ntfs-mft' }]) {
    assert.equal(engineSettingRefusal(bad, 'win32'), FIVE_REFUSAL, `${JSON.stringify(bad)} on win32`);
    assert.equal(engineSettingRefusal(bad, 'darwin'), FOUR_REFUSAL, `${JSON.stringify(bad)} on darwin`);
  }
  assert.equal(engineSettingRefusal('ntfs-mft'), ON_WINDOWS ? null : TURBO_REFUSAL, 'the default is the platform this runs on');
});

/** Run `fn` with `process.platform` reading `p`; the real property is put back whatever happens. */
async function withPlatform<T>(p: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(real && 'value' in real, 'process.platform is a plain value that can be stood in for');
  Object.defineProperty(process, 'platform', { ...real, value: p });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
}

function storedEngine(): unknown {
  return (JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8')) as { engine?: unknown }).engine;
}

test('updateSettings({ engine: "ntfs-mft" }) is kept only on Windows — here it is stored as Automatic, never trusted', async () => {
  try {
    await updateSettings({ engine: 'walker' });
    const here = await updateSettings({ engine: 'ntfs-mft' });
    const want = ON_WINDOWS ? 'ntfs-mft' : 'auto';
    assert.equal(here.engine, want, `on ${process.platform}`);
    assert.equal((await getSettings()).engine, want);
    assert.equal(storedEngine(), want, 'what reaches the file is the normalised value');

    // The normaliser asks the platform when it runs, so a stood-in platform
    // answers for the side this computer is not.
    const onWindows = await withPlatform('win32', () => updateSettings({ engine: 'ntfs-mft' }));
    assert.equal(onWindows.engine, 'ntfs-mft', 'Windows keeps it');
    assert.equal(storedEngine(), 'ntfs-mft');
    for (const p of ['darwin', 'linux'] as const) {
      await withPlatform('win32', () => updateSettings({ engine: 'native' }));
      const off = await withPlatform(p, () => updateSettings({ engine: 'ntfs-mft' }));
      assert.equal(off.engine, 'auto', `${p} turns it into Automatic, not the value it had`);
      assert.equal(storedEngine(), 'auto');
    }
  } finally {
    await updateSettings({ engine: 'auto' });
  }
});

test('no settings save ends the quiet period after a declined prompt — not even choosing ntfs-mft again, over and over', async () => {
  // The second security review of M6: PUT /api/settings is reachable by
  // anything that can reach the API, without an audit line, so a reset there
  // would let the very loop the quiet period stops re-arm the prompt at will.
  try {
    resetMftPromptForTests();
    mftPromptEnded(true, Date.now());
    assert.notEqual(mftPromptBlocked(Date.now()), null, 'quiet after a decline');
    for (let i = 0; i < 3; i++) {
      await withPlatform('win32', () => updateSettings({ engine: 'auto' }));
      await withPlatform('win32', () => updateSettings({ engine: 'ntfs-mft' }));
      await withPlatform('win32', () => updateSettings({ engine: 'ntfs-mft' }));
    }
    assert.notEqual(mftPromptBlocked(Date.now()), null, 'still quiet: only time, or a restart, ends it');
  } finally {
    resetMftPromptForTests();
    await updateSettings({ engine: 'auto' });
  }
});

/* ══════════════ 2. The route and the spec ══════════════ */

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

test('PUT /api/settings { engine: "ntfs-mft" }: off Windows 400 BAD_SETTING naming Windows, with nothing changed; on Windows it is saved', async () => {
  const { port, close } = await listen();
  try {
    assert.equal((await req(port, 'PUT', '/api/settings', { engine: 'gdu' })).status, 200);
    const before = (await req(port, 'GET', '/api/settings')).body;
    assert.equal(before.engine, 'gdu');
    const r = await req(port, 'PUT', '/api/settings', { engine: 'ntfs-mft', humanScaleUnits: !before.humanScaleUnits });
    if (ON_WINDOWS) {
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.engine, 'ntfs-mft');
      assert.equal((await req(port, 'GET', '/api/settings')).body.engine, 'ntfs-mft', 'GET reflects the write');
    } else {
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.code, 'BAD_SETTING');
      assert.equal(r.body.error, TURBO_REFUSAL, 'the refusal says why: Windows only, and what is allowed here');
      const after = (await req(port, 'GET', '/api/settings')).body;
      assert.equal(after.engine, 'gdu', 'the stored engine is unchanged');
      assert.equal(after.humanScaleUnits, before.humanScaleUnits, 'a refused body changes nothing, not even its other keys');
      assert.equal(storedEngine(), 'gdu', 'nor does the file');
    }
    // Any other word names the platform's own list: the four here, all five on Windows.
    const bad = await req(port, 'PUT', '/api/settings', { engine: 'mft' });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.code, 'BAD_SETTING');
    assert.equal(bad.body.error, ON_WINDOWS ? FIVE_REFUSAL : FOUR_REFUSAL);
  } finally {
    await req(port, 'PUT', '/api/settings', { engine: 'auto', humanScaleUnits: true }).catch(() => {});
    await close();
  }
});

test('the OpenAPI spec lists all five values and says what ntfs-mft is: Windows only, refused elsewhere, opt-in, elevated and read-only, not verified on this build', async () => {
  const { port, close } = await listen();
  try {
    const spec = (await req(port, 'GET', '/api/openapi.json')).body;
    const engine = spec.components.schemas.AppSettings.properties.engine;
    assert.deepEqual(engine.enum, [...ENGINE_SETTINGS], 'the spec and the service list the same values');
    assert.deepEqual(engine.enum, [...FIVE]);
    for (const words of [/ntfs-mft/, /Windows only/, /400 BAD_SETTING/, /opt-in/, /administrator permission/, /elevated/, /read-only/, /not verified on this build/i]) {
      assert.match(engine.description, words);
    }
  } finally {
    await close();
  }
});

/* ══════════════ 3. The Settings row, as shipped markup ══════════════ */

function slice(a: string, b: string): string {
  const i = INDEX.indexOf(a);
  assert.notEqual(i, -1, `anchor "${a}" exists in index.html`);
  const j = INDEX.indexOf(b, i + a.length);
  assert.notEqual(j, -1, `anchor "${b}" follows it`);
  return INDEX.slice(i, j);
}

const TURBO_ROW_OPEN = '<label class="rule-row budget-row" for="scanEngine-ntfs-mft" id="scanEngineRow-ntfs-mft" hidden>';
const TURBO_SENTENCE = 'Windows only, with TreeMap installed for everyone who uses the computer: asks Windows for administrator permission, then reads the drive’s file table directly, read-only — not verified on this build';

test('Settings ships a fifth Scan engine radio, NTFS turbo, in the one radio group and hidden by default', () => {
  // The group holds labels, inputs and spans only, so its first </div> is its own.
  const group = slice('<div id="scanEngineOptions" role="radiogroup" aria-label="Scan engine">', '</div>');
  const radios = [...group.matchAll(/<input type="radio" name="scanEngine" id="scanEngine-([a-z-]+)" value="([a-z-]+)"([^>]*)>/g)];
  assert.deepEqual(radios.map((m) => m[2]), [...FIVE], 'five radios, NTFS turbo last');
  assert.deepEqual(radios.map((m) => m[2]), [...ENGINE_SETTINGS], 'in the order the service lists them');
  for (const m of radios) assert.equal(m[1], m[2], 'each id names its value');
  assert.equal((INDEX.match(/name="scanEngine"/g) ?? []).length, FIVE.length, 'no Scan engine radio outside the one group');
  const turbo = radios.find((m) => m[2] === 'ntfs-mft');
  assert.ok(turbo, 'the ntfs-mft radio is in the group');
  assert.doesNotMatch(turbo[3], /\bchecked\b/, 'never the default');
  assert.ok(group.includes(
    `${TURBO_ROW_OPEN}\n          <input type="radio" name="scanEngine" id="scanEngine-ntfs-mft" value="ntfs-mft">\n` +
    `          <span class="budget-name">NTFS turbo</span>\n` +
    `          <span class="muted budget-help">${TURBO_SENTENCE}</span>\n        </label>`,
  ), 'the row: a real label shaped like the other four, hidden, with the name and its one plain sentence');
  const labels = [...group.matchAll(/<label\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(labels.length, FIVE.length);
  assert.deepEqual(labels.filter((l) => /\shidden\b/.test(l)), [TURBO_ROW_OPEN], 'only the NTFS turbo row ships hidden');
});

/* ══════════════ 4. The Settings row, evaluated with a platform ══════════════ */

type Radio = {
  id: string; value: string; checked: boolean; disabled: boolean;
  listeners: Record<string, () => void>;
  addEventListener(type: string, fn: () => void): void;
};
type Row = { id: string; hidden: boolean };

function makeDom() {
  const els: Record<string, Radio | Row> = {};
  const radios: Radio[] = FIVE.map((e) => {
    const r: Radio = {
      id: `scanEngine-${e}`, value: e, checked: e === 'auto', disabled: false, listeners: {},
      addEventListener(type, fn) { r.listeners[type] = fn; },
    };
    els[r.id] = r;
    return r;
  });
  // The markup ships the row hidden; only the script may lift that.
  const row: Row = { id: 'scanEngineRow-ntfs-mft', hidden: true };
  els[row.id] = row;
  const checked = () => radios.filter((r) => r.checked).map((r) => r.value);
  /** What a click on a radio does: the browser checks it, then fires change. */
  const pick = async (e: string) => {
    for (const r of radios) r.checked = r.value === e;
    const fn = radios.find((r) => r.value === e)?.listeners.change;
    assert.ok(fn, `the ${e} radio has a change listener`);
    fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { $: (id: string) => els[id] ?? null, radios, row, checked, pick };
}

type ApiCall = { url: string; options?: { method?: string; body?: string } };
type Runtime = { renderScanEngine: (engine: unknown) => void; saveScanEngine: (engine: string) => Promise<void>; settings: () => { engine?: string } };

/** Evaluate with no `state` binding at all: the bundle has not reached its declaration yet. */
const UNDECLARED = Symbol('state not declared');

/** The Scan engine block, evaluated with api/$/toast/settingsData and `state` injected — the real wiring included. */
function engineRuntime(opts: {
  state: unknown;
  api?: (url: string, options?: ApiCall['options']) => Promise<unknown>;
  toast?: (msg: string, kind?: string) => void;
  settingsData?: { engine?: string };
}) {
  const src = slice('/* ── Scan engine', '/* ── Scanning budget');
  const dom = makeDom();
  const api = opts.api ?? (async () => assert.fail('nothing here should save'));
  const toast = opts.toast ?? (() => {});
  const settingsData = opts.settingsData ?? {};
  const params = ['api', '$', 'toast', 'settingsData'];
  const args: unknown[] = [api, dom.$, toast, settingsData];
  if (opts.state !== UNDECLARED) { params.push('state'); args.push(opts.state); }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const rt = new Function(
    ...params,
    `'use strict'; ${src}\nreturn { renderScanEngine, saveScanEngine, settings: () => settingsData };`,
  )(...args) as Runtime;
  return { ...rt, dom };
}

/** Every way a page can not know it is on Windows. */
const NOT_WINDOWS: [string, unknown][] = [
  ['state not declared yet', UNDECLARED],
  ['state undefined', undefined],
  ['state null', null],
  ['/api/system not answered yet', { system: null }],
  ['macOS', { system: { platform: 'darwin' } }],
  ['Linux', { system: { platform: 'linux' } }],
];

test('the NTFS turbo row is shown only once the page knows it is on Windows, and hidden again when it learns otherwise', () => {
  assert.ok(!('state' in globalThis), 'no global `state` stands in for the undeclared one');
  for (const [what, state] of NOT_WINDOWS) {
    const rt = engineRuntime({ state });
    rt.dom.row.hidden = false; // as if an earlier render had shown it: this one must put it back
    assert.doesNotThrow(() => rt.renderScanEngine('auto'), what);
    assert.equal(rt.dom.row.hidden, true, `${what}: hidden`);
  }
  // /api/system answers after Settings first rendered: each render reads the platform afresh.
  const state: { system: null | { platform: string } } = { system: null };
  const rt = engineRuntime({ state });
  rt.renderScanEngine('auto');
  assert.equal(rt.dom.row.hidden, true, 'hidden before the page knows the platform');
  state.system = { platform: 'win32' };
  rt.renderScanEngine('auto');
  assert.equal(rt.dom.row.hidden, false, 'shown once /api/system says win32');
  assert.deepEqual(rt.dom.checked(), ['auto'], 'showing the row checks nothing new');
  state.system = { platform: 'darwin' };
  rt.renderScanEngine('auto');
  assert.equal(rt.dom.row.hidden, true, 'hidden again for any other platform');
});

test('on Windows, picking NTFS turbo PUTs exactly { engine: "ntfs-mft" } and the radio stays on it', async () => {
  const calls: ApiCall[] = [];
  const toasts: { msg: string; kind: string }[] = [];
  const rt = engineRuntime({
    state: { system: { platform: 'win32' } },
    settingsData: { engine: 'auto' },
    api: async (url, options) => {
      calls.push({ url, options });
      return { ...JSON.parse(options?.body ?? '{}'), ignore: [], schedules: [] };
    },
    toast: (msg, kind = 'success') => { toasts.push({ msg, kind }); },
  });
  rt.renderScanEngine('auto');
  await rt.dom.pick('ntfs-mft');
  assert.equal(calls.length, 1, 'one save per pick');
  assert.equal(calls[0].url, '/api/settings');
  assert.equal(calls[0].options?.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].options?.body ?? 'null'), { engine: 'ntfs-mft' }, 'only the engine rides in the body');
  assert.deepEqual(rt.dom.checked(), ['ntfs-mft'], 'the row re-renders from the answer, on NTFS turbo');
  assert.equal(rt.settings().engine, 'ntfs-mft');
  assert.equal(rt.dom.row.hidden, false);
  assert.deepEqual(toasts.map((t) => t.kind), ['success']);
  assert.match(toasts[0].msg, /NTFS turbo/, 'the toast names it in the user’s words');
});

test('a stored ntfs-mft renders as Automatic on a page that does not know it is on Windows, and as NTFS turbo on one that does', () => {
  for (const [what, state] of NOT_WINDOWS) {
    const rt = engineRuntime({ state });
    rt.renderScanEngine('native');
    rt.renderScanEngine('ntfs-mft');
    assert.deepEqual(rt.dom.checked(), ['auto'], `${what}: Automatic, never nothing checked and never a hidden radio`);
  }
  const win = engineRuntime({ state: { system: { platform: 'win32' } } });
  win.renderScanEngine('ntfs-mft');
  assert.deepEqual(win.dom.checked(), ['ntfs-mft']);
  win.renderScanEngine('bogus');
  assert.deepEqual(win.dom.checked(), ['auto'], 'a value the page does not know is still Automatic on Windows');
});

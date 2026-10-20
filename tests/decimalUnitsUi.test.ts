import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { INDEX } from './fixtures/liftFrontend';

/**
 * A size a person TYPES is read in the units the page PRINTS (QA D09).
 *
 * The owner's answer to D09 ("Match Finder") made every printed size decimal:
 * 1 KB = 1,000 bytes, 1 MB = 1,000,000, 1 GB = 1,000,000,000. The boxes where
 * a person types a size went on multiplying by 1024s — a folder budget typed as
 * "50 GB" was stored as 53,687,091,200 bytes, which the page then printed as
 * "53.7 GB", and an Autopilot policy capped at "5 GB per run" deleted up to
 * 5.37 GB. Every such box is driven here out of the built page, with the
 * globals it touches passed in, so these are pins on behaviour.
 */

/** The `{ … }` block that starts at the first `{` after `anchor`, anchor included. */
function braced(anchor: string, from = 0): string {
  const start = INDEX.indexOf(anchor, from);
  assert.notEqual(start, -1, `"${anchor}" is in the built page`);
  let depth = 0;
  for (let i = INDEX.indexOf('{', start + anchor.length - 1); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`"${anchor}" never closes`);
}

/** The page's own declaration of a top-level constant, one statement. */
function pageConst(name: string): string {
  const start = INDEX.indexOf(`const ${name} = `);
  assert.notEqual(start, -1, `const ${name} is declared in the built page`);
  return INDEX.slice(start, INDEX.indexOf(';', start) + 1);
}

/**
 * The page's unit constants, exactly as the page declares them — whichever of
 * them it declares, so a page with a binary copy of one is measured with it.
 */
function unitDecls(): string {
  return ['KB', 'MB', 'GB', 'TB'].filter((u) => INDEX.includes(`const ${u} = `)).map(pageConst).join('\n');
}

type Box = {
  value: string | number; checked: boolean; innerHTML: string; textContent: string; title: string;
  style: Record<string, string>; classList: { add(): void; remove(): void }; querySelectorAll(): never[];
};
function dom() {
  const els: Record<string, Box> = {};
  const $ = (id: string): Box => (els[id] ??= {
    value: '', checked: false, innerHTML: '', textContent: '', title: '', style: {},
    classList: { add() {}, remove() {} }, querySelectorAll: () => [],
  });
  return { $, els };
}

/** Evaluate page source with the named globals passed in, returning `returns`. */
function run<T>(source: string, deps: Record<string, unknown>, returns: string): T {
  const keys = Object.keys(deps);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...keys, `'use strict';\n${unitDecls()}\n${source}\nreturn ${returns};`)(...keys.map((k) => deps[k])) as T;
}

/* ══════════════ the unit pickers in the markup ══════════════ */

const DECIMAL: Record<string, number> = { KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

test('every unit a person picks from a list is worth its decimal number of bytes', () => {
  // <option value="N">GB</option> (a unit beside a typed number) and
  // <option value="N">100 KB</option> (a size picked whole).
  const options = [...INDEX.matchAll(/<option value="(\d+)"[^>]*>\s*(?:([\d.]+)\s*)?(KB|MB|GB|TB)\s*<\/option>/g)];
  assert.ok(options.length >= 9, `the budget, cleanup-target and duplicate-size lists are all found (${options.length})`);
  for (const [whole, value, count, unit] of options) {
    assert.equal(Number(value), Number(count ?? 1) * DECIMAL[unit], `${whole} — ${count ?? 1} ${unit} is ${Number(count ?? 1) * DECIMAL[unit]} bytes`);
  }
  // The three lists, by name, so a regex that silently matches nothing cannot pass.
  for (const [id, want] of [
    ['budgetUnit', ['1000000000', '1000000', '1000', '1']],
    ['cleanupGoalUnit', ['1000000000', '1000000000000', '1000000']],
    ['dupMinSize', ['1000', '100000', '1000000', '10000000']],
  ] as const) {
    const at = INDEX.indexOf(`<select id="${id}"`);
    assert.notEqual(at, -1, `#${id} is in the page`);
    const sel = INDEX.slice(at, INDEX.indexOf('</select>', at));
    assert.deepEqual([...sel.matchAll(/<option value="(\d+)"/g)].map((m) => m[1]), want, `#${id}`);
  }
});

test('the page declares its units once, in decimal, beside formatBytes', () => {
  for (const u of Object.keys(DECIMAL)) assert.ok(INDEX.includes(`const ${u} = `), `const ${u} is declared in the page`);
  assert.deepEqual(run<Record<string, number>>('', {}, '{ KB, MB, GB, TB }'), DECIMAL);
  assert.equal((INDEX.match(/\bconst (KB|MB|GB|TB) = /g) ?? []).length, 4, 'no second, binary copy of a unit anywhere in the page');
  const prelude = INDEX.indexOf('function formatBytes(');
  assert.ok(INDEX.indexOf('const KB = ') > prelude && INDEX.indexOf('const KB = ') - prelude < 2000, 'declared beside formatBytes, the function whose units they are');
});

/* ══════════════ Autopilot's policy editor ══════════════ */

function editorRuntime(draft: Record<string, unknown> | null) {
  const { $, els } = dom();
  const seg = { dataset: { apmatch: draft && (draft.match as { kind?: string })?.kind === 'custom' ? 'custom' : 'suggestion' } };
  const source = braced('function openPolicyEditor(') + '\n' + braced('function policyFromEditor(');
  const rt = run<{ open: (p: unknown) => void; read: () => Record<string, any> }>(
    `let apDraft = null;\n${source}`,
    {
      $, icon: () => '', state: { system: { homeDir: '/home/u' } },
      setApMatchKind() {}, validateApQuery() {}, renderApGroupList() {}, asPath: (p: string) => p,
      document: { querySelector: () => seg, querySelectorAll: () => [] },
    },
    '{ open: openPolicyEditor, read: policyFromEditor }',
  );
  return { ...rt, $, els };
}

test('Autopilot: "5 GB per run" is 5,000,000,000 bytes, and a size rule of 100 MB is 100,000,000', () => {
  const ed = editorRuntime(null);
  ed.open(null);
  ed.$('apMaxRun').value = '5';
  ed.$('apMaxWeek').value = '20';
  ed.$('apConfirmAbove').value = '2.5';
  let p = ed.read();
  assert.equal(p.maxBytesPerRun, 5e9);
  assert.equal(p.maxBytesPerWeek, 20e9);
  assert.equal(p.requireConfirmationAbove, 2.5e9);

  const custom = editorRuntime({ name: 'c', path: '/home/u', match: { kind: 'custom', minBytes: 1e8 } });
  custom.open({ name: 'c', path: '/home/u', match: { kind: 'custom', minBytes: 1e8 } });
  assert.equal(custom.$('apRuleSizeMb').value, 100, 'a stored 100,000,000-byte rule shows as 100 MB');
  custom.$('apRuleSizeOn').checked = true;
  custom.$('apRuleSizeMb').value = '250';
  p = custom.read();
  assert.equal(p.match.minBytes, 250e6);
});

/**
 * Byte counts of every magnitude a stored size can have, from 1 byte to just
 * under a petabyte, the same list on every run: the 1024-based sizes an
 * earlier TreeMap stored, then a deterministic spread of awkward ones.
 */
function storedSizes(count = 3000): number[] {
  const out = [1, 999, 1000, 4096, 1024 ** 2, 100 * 1024 ** 2, 500 * 1024 ** 2, 1024 ** 3, 0.5 * 1024 ** 3,
    5 * 1024 ** 3, 10 * 1024 ** 3, 20 * 1024 ** 3, 50 * 1024 ** 3, 1024 ** 4, 2 * 1024 ** 4, 2.25e9, 999_999_999_999_999];
  let x = 0x2545f491;
  const next = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0);
  while (out.length < count) {
    const digits = 1 + (next() % 15);
    out.push(Math.max(1, Math.floor((next() / 2 ** 32) * 10 ** digits)));
  }
  return out;
}

test('Autopilot: a limit saved by an earlier TreeMap in 1024s opens as its exact figure, and Save keeps every byte (review F1.1)', () => {
  // 5.1 stored "5 GB per run" as 5,368,709,120 bytes. The editor showed it
  // rounded to "5.37", so opening the policy and pressing Save — touching
  // nothing — rewrote the cap to 5,370,000,000.
  const legacy = {
    name: 'p', path: '/home/u', match: { kind: 'custom', minBytes: 100 * 1024 ** 2 },
    maxBytesPerRun: 5 * 1024 ** 3, maxBytesPerWeek: 20 * 1024 ** 3, requireConfirmationAbove: 1024 ** 3,
  };
  const ed = editorRuntime(legacy);
  ed.open(legacy);
  assert.equal(ed.$('apMaxRun').value, '5.36870912', '5 GiB is 5.36870912 GB, shown whole');
  assert.equal(String(ed.$('apRuleSizeMb').value), '104.8576', 'a 100 MiB rule is 104.8576 MB, shown whole');
  const back = ed.read();
  assert.equal(back.maxBytesPerRun, legacy.maxBytesPerRun, 'opened and saved untouched, the per-run cap keeps every byte');
  assert.equal(back.maxBytesPerWeek, legacy.maxBytesPerWeek);
  assert.equal(back.requireConfirmationAbove, legacy.requireConfirmationAbove);
  assert.equal(back.match.minBytes, legacy.match.minBytes, 'and so does the size rule');

  // Every size a limit or a size rule can hold comes back as the bytes it
  // was — a rule under the editor's 1 MB floor too (review F2.4).
  for (const b of storedSizes()) {
    const p = { name: 'p', path: '/home/u', match: { kind: 'custom', minBytes: b }, maxBytesPerRun: b, maxBytesPerWeek: b, requireConfirmationAbove: b };
    const e = editorRuntime(p);
    e.open(p);
    const r = e.read();
    assert.deepEqual([r.maxBytesPerRun, r.maxBytesPerWeek, r.requireConfirmationAbove, r.match.minBytes], [b, b, b, b], `${b} bytes`);
  }
});

test('Autopilot: a size rule under 1 MB opens as its figure and saves untouched as the bytes it was; only a typed figure is held to the 1 MB floor (review F2.3, F2.4)', () => {
  // The policy API takes any minBytes over 0, so a custom rule of 500,000
  // bytes exists. The editor opened it as "0.5" and Save — nothing touched —
  // sent 1,000,000: the box said one figure and the unattended deleter's rule
  // became another.
  for (const b of [1, 4096, 500_000, 999_999]) {
    const p = { name: 'p', path: '/home/u', match: { kind: 'custom', minBytes: b } };
    const e = editorRuntime(p);
    e.open(p);
    assert.equal(String(e.$('apRuleSizeMb').value), String(b / 1e6), `${b} bytes open as ${b / 1e6} MB`);
    assert.equal(e.read().match.minBytes, b, `a ${b}-byte rule saved untouched keeps every byte`);
  }

  // A figure a person types is still held to the box's 1 MB floor (min="1").
  const p = { name: 'p', path: '/home/u', match: { kind: 'custom', minBytes: 500_000 } };
  const e = editorRuntime(p);
  e.open(p);
  e.$('apRuleSizeMb').value = '0.25';
  assert.equal(e.read().match.minBytes, 1e6, 'a typed 0.25 MB is read as the 1 MB floor');
  e.$('apRuleSizeMb').value = '2.5';
  assert.equal(e.read().match.minBytes, 2.5e6, 'and a typed 2.5 MB is 2,500,000 bytes');
});

test('Autopilot: a stored limit reads back in the units it was typed in', () => {
  const ed = editorRuntime(null);
  ed.open({ name: 'p', path: '/home/u', match: { kind: 'suggestion', groupIds: [] }, maxBytesPerRun: 5e9, maxBytesPerWeek: 1.5e9, requireConfirmationAbove: 250e6 });
  assert.equal(ed.$('apMaxRun').value, '5');
  assert.equal(ed.$('apMaxWeek').value, '1.5');
  assert.equal(ed.$('apConfirmAbove').value, '0.25');
  const back = ed.read();
  assert.equal(back.maxBytesPerRun, 5e9, 'opened and saved untouched, a limit stays exactly what it was');
  assert.equal(back.maxBytesPerWeek, 1.5e9);
  assert.equal(back.requireConfirmationAbove, 250e6);
});

/** The custom-rule controls of the policy editor, every one. */
const AP_RULE_CONTROLS = ['apRuleAgeOn', 'apRuleAgeDays', 'apRuleSizeOn', 'apRuleSizeMb', 'apRuleExtOn', 'apRuleExts'];

/**
 * One policy editor kept across several opens, as the page keeps it: its
 * inputs start as the built page's markup makes them, `defaultValue` and
 * `defaultChecked` reflect that markup as a browser's do (assigning `.value`
 * or `.checked` leaves them alone), and pressing a segment button selects it
 * for policyFromEditor exactly as setApMatchKind does.
 */
function editorSession() {
  const { $: plain } = dom();
  const $ = (id: string) => {
    const el = plain(id) as Box & { defaultValue?: string; defaultChecked?: boolean };
    if (!('defaultValue' in el)) {
      const tag = INDEX.match(new RegExp(`<input\\b[^>]*\\sid="${id}"[^>]*>`))?.[0] ?? '';
      el.defaultValue = tag.match(/\svalue="([^"]*)"/)?.[1] ?? '';
      el.defaultChecked = /\schecked(?=[\s>])/.test(tag);
      el.value = el.defaultValue;
      el.checked = el.defaultChecked;
    }
    return el;
  };
  let kind = 'suggestion';
  const seg = { get dataset() { return { apmatch: kind }; } };
  const source = braced('function openPolicyEditor(') + '\n' + braced('function policyFromEditor(');
  const rt = run<{ open: (p: unknown) => void; read: () => Record<string, any> }>(
    `let apDraft = null;\n${source}`,
    {
      $, icon: () => '', state: { system: { homeDir: '/home/u' } },
      setApMatchKind: (k: string) => { kind = k; }, validateApQuery() {}, renderApGroupList() {}, asPath: (p: string) => p,
      document: { querySelector: () => seg, querySelectorAll: () => [] },
    },
    '{ open: openPolicyEditor, read: policyFromEditor }',
  );
  return { ...rt, $, press: (k: string) => { kind = k; } };
}

test('Autopilot: every custom-rule box opens as the markup made it or as the policy stored it — never as the last policy left it — so Save sends the figure the box shows (review F3.1)', () => {
  const ed = editorSession();
  // Control: the markup's own defaults, so a pattern that matched nothing cannot pass.
  assert.deepEqual(AP_RULE_CONTROLS.map((id) => [id, ed.$(id).defaultChecked, ed.$(id).defaultValue]), [
    ['apRuleAgeOn', true, ''], ['apRuleAgeDays', false, '180'], ['apRuleSizeOn', true, ''],
    ['apRuleSizeMb', false, '100'], ['apRuleExtOn', false, ''], ['apRuleExts', false, ''],
  ], 'the markup ticks "Older than 180 days" and "Larger than 100 MB", and leaves extensions empty');
  const atDefaults = (why: string) => {
    for (const id of AP_RULE_CONTROLS) {
      assert.equal(ed.$(id).checked, ed.$(id).defaultChecked, `${why}: #${id} is ticked as the markup ticks it`);
      assert.equal(String(ed.$(id).value), ed.$(id).defaultValue, `${why}: #${id} holds the markup's figure`);
    }
  };
  const savesWhatItShows = (why: string) => {
    const m = ed.read().match;
    assert.equal(m.kind, 'custom');
    assert.equal(m.minBytes, Number(ed.$('apRuleSizeMb').value) * 1e6, `${why}: Save sends the size the box shows, ${ed.$('apRuleSizeMb').value} MB`);
    assert.equal(m.maxAgeMs, Number(ed.$('apRuleAgeDays').value) * 86_400_000, `${why}: and the age it shows`);
  };
  const ruleA = { id: 'A', name: 'A', path: '/p/a', match: { kind: 'custom', minBytes: 500_000, maxAgeMs: 30 * 86_400_000, exts: ['log'] } };

  // Policy A, a rule under 1 MB the API accepts, opened and closed.
  ed.open(ruleA);
  assert.equal(String(ed.$('apRuleSizeMb').value), '0.5', 'control: A opens as its own figure');
  assert.equal(ed.$('apRuleExts').value, 'log', 'control: and its own extensions');

  // Then "New policy" and "My own rules": the box held A's "0.5", and Save
  // sent 1,000,000 — the box said one figure, the standing rule another.
  ed.open(null);
  atDefaults('a new policy after A');
  ed.press('custom');
  savesWhatItShows('a new policy after A, on "My own rules"');

  // Then a custom policy with only an age rule, and "Larger than" ticked.
  ed.open(ruleA);
  ed.open({ id: 'B', name: 'B', path: '/p/b', match: { kind: 'custom', maxAgeMs: 30 * 86_400_000 } });
  assert.equal(ed.$('apRuleSizeOn').checked, false, 'B has no size rule, so "Larger than" opens unticked');
  assert.equal(String(ed.$('apRuleSizeMb').value), '100', 'and its box holds the markup\'s 100, not A\'s 0.5');
  assert.equal(ed.$('apRuleExtOn').checked, false, 'nor A\'s extensions');
  assert.equal(ed.$('apRuleExts').value, '');
  ed.$('apRuleSizeOn').checked = true;
  savesWhatItShows('B after A, "Larger than" ticked');

  // A figure typed into one editor and abandoned is not the next one's.
  ed.open(null);
  ed.press('custom');
  ed.$('apRuleSizeMb').value = '0.25';
  ed.$('apRuleAgeDays').value = '7';
  ed.$('apRuleAgeOn').checked = false;
  ed.$('apRuleSizeOn').checked = false;
  ed.$('apRuleExtOn').checked = true;
  ed.$('apRuleExts').value = 'tmp';
  ed.open(null);
  atDefaults('a new policy after one typed into and abandoned');
  ed.press('custom');
  savesWhatItShows('that new policy, on "My own rules"');

  // And a query or suggestion policy opened after A leaves nothing of A behind.
  for (const match of [{ kind: 'query', q: 'ext:log' }, { kind: 'suggestion', groupIds: [] }]) {
    ed.open(ruleA);
    ed.open({ id: 'Q', name: 'Q', path: '/p/q', match });
    atDefaults(`a ${match.kind} policy after A`);
  }
});

/* ══════════════ folder budgets ══════════════ */

function budgetDialog(existing: number | null) {
  const { $ } = dom();
  const rt = run<{ open: (n: unknown) => void }>(
    `let budgetTarget = null;\n${braced('function openBudgetDialog(')}`,
    {
      $, formatBytes: (n: number) => `${n} B`, nodeFor: () => null, setTimeout: () => 0,
      budgetFor: () => (existing === null ? null : { path: '/r/a', maxBytes: existing }),
    },
    '{ open: openBudgetDialog }',
  );
  rt.open({ path: '/r/a', name: 'a', size: 1 });
  return { unit: $('budgetUnit').value, value: $('budgetValue').value };
}

test('a folder budget opens in the unit it reads best in, and the number times the unit is the stored bytes', () => {
  assert.deepEqual(budgetDialog(null), { unit: '1000000000', value: '' }, 'a new budget starts in GB');
  assert.deepEqual(budgetDialog(50e9), { unit: '1000000000', value: '50' });
  assert.deepEqual(budgetDialog(1.5e9), { unit: '1000000000', value: '1.5' }, '1.5 GB, not 1500 MB');
  assert.deepEqual(budgetDialog(500e6), { unit: '1000000', value: '500' });
  assert.deepEqual(budgetDialog(64e3), { unit: '1000', value: '64' });
  assert.deepEqual(budgetDialog(999), { unit: '1', value: '999' });
  // A budget saved by an earlier TreeMap was typed in 1024s: 50 "GB" is
  // 53,687,091,200 bytes. It opens as the decimal figure it is — never as a
  // 53687091200 in the bytes box — and saving it untouched keeps every byte.
  const legacy = budgetDialog(50 * 1024 ** 3);
  assert.equal(legacy.unit, '1000000000');
  assert.equal(Math.round(Number(legacy.value) * Number(legacy.unit)), 50 * 1024 ** 3);
});

/* ══════════════ Settings: the cleanup target and the scheduled-scan alerts ══════════════ */

function goalFields(bytes: number | null) {
  const { $ } = dom();
  const rt = run<{ render: () => void; collect: () => number | null }>(
    `${pageConst('CLEANUP_GOAL_UNITS')}\n${braced('function renderCleanupGoalFields(')}\n${braced('function collectCleanupGoal(')}`,
    { $, settingsData: { cleanupGoalBytes: bytes }, adoptCartGoal: (b: number | null) => b },
    '{ render: renderCleanupGoalFields, collect: collectCleanupGoal }',
  );
  rt.render();
  return { unit: $('cleanupGoalUnit').value, value: $('cleanupGoalValue').value, collect: rt.collect, $ };
}

test('the cleanup target is read and shown in decimal units', () => {
  assert.deepEqual((({ unit, value }) => ({ unit, value }))(goalFields(50e9)), { unit: '1000000000', value: '50' });
  assert.deepEqual((({ unit, value }) => ({ unit, value }))(goalFields(2e12)), { unit: '1000000000000', value: '2' });
  assert.deepEqual((({ unit, value }) => ({ unit, value }))(goalFields(500e6)), { unit: '1000000', value: '500' });
  assert.equal(goalFields(null).unit, '1000000000', 'no target: the box waits in GB');
  const g = goalFields(null);
  g.$('cleanupGoalValue').value = '50';
  g.$('cleanupGoalUnit').value = '1000000000';
  assert.equal(g.collect(), 50e9, '"Free up 50 GB" is 50,000,000,000 bytes');
  g.$('cleanupGoalUnit').value = '';
  assert.equal(g.collect(), 50e9, 'a unit the box lost falls back to GB');
});

test('a scheduled scan\'s "Alert if +GB" is read and shown in decimal gigabytes', () => {
  const { $ } = dom();
  const settingsData = { schedules: [{ path: '/r', intervalHours: 24, thresholdBytes: 2e9, enabled: true }], ignore: [] as unknown[] };
  run<() => void>(
    `${pageConst('SCHED_HOURS')}\n${braced('function renderSchedules(')}`,
    { $, settingsData, escapeHtml: String, icon: () => '', collectSettingsForms() {} },
    'renderSchedules',
  )();
  assert.match($('schedList').innerHTML, /class="s-gb"[^>]*value="2"/, '2,000,000,000 bytes show as 2 GB');

  const field = (cls: string, value: string, checked = false) => ({ value, checked, dataset: { i: '0' } });
  const row = { querySelector: (sel: string) => ({ '.s-path': field('', '/r'), '.s-int': field('', '24'), '.s-gb': field('', '3.5'), '.s-pct': field('', ''), '.s-on': field('', '', true) } as Record<string, unknown>)[sel] };
  run<() => void>(
    // Each schedule's folder is read as every path box reads one (asPath, frv-d): the page's own.
    `${braced('function asPath(')}\n${braced('function collectSettingsForms(')}`,
    { $, settingsData, document: { querySelectorAll: (sel: string) => (sel.includes('sched') ? [row] : []) } },
    'collectSettingsForms',
  )();
  assert.equal(settingsData.schedules[0].thresholdBytes, 3.5e9, '"3.5" in the GB box is 3,500,000,000 bytes');
});

/** One scheduled scan's alert, painted by renderSchedules and read back by collectSettingsForms with its box untouched. */
function alertRoundTrip(bytes: number): { shown: string; saved: unknown } {
  const { $ } = dom();
  const settingsData = { schedules: [{ path: '/r', intervalHours: 24, thresholdBytes: bytes, enabled: true }] as Array<Record<string, unknown>>, ignore: [] as unknown[] };
  run<() => void>(
    `${pageConst('SCHED_HOURS')}\n${braced('function renderSchedules(')}`,
    { $, settingsData, escapeHtml: String, icon: () => '', collectSettingsForms() {} },
    'renderSchedules',
  )();
  const shown = /class="s-gb"[^>]*value="([^"]*)"/.exec($('schedList').innerHTML)?.[1] ?? assert.fail('the alert box is painted');
  const field = (value: string, checked = false) => ({ value, checked, dataset: { i: '0' } });
  const fields: Record<string, unknown> = { '.s-path': field('/r'), '.s-int': field('24'), '.s-gb': field(shown), '.s-pct': field(''), '.s-on': field('', true) };
  run<() => void>(
    // Each schedule's folder is read as every path box reads one (asPath, frv-d): the page's own.
    `${braced('function asPath(')}\n${braced('function collectSettingsForms(')}`,
    { $, settingsData, document: { querySelectorAll: (sel: string) => (sel.includes('sched') ? [{ querySelector: (s: string) => fields[s] }] : []) } },
    'collectSettingsForms',
  )();
  return { shown, saved: settingsData.schedules[0].thresholdBytes };
}

test('Settings Save keeps every stored alert and cleanup target exactly — a 1024-based one too, shown as its exact decimal figure (review F1.1, F1.5)', () => {
  // Save reads every schedule row and the target box back, edited or not. A
  // value an earlier TreeMap stored in 1024s was painted rounded ("0.5" for
  // 536,870,912 bytes, "53.69" GB for a 50 GiB target), so saving any other
  // setting rewrote it to the rounded figure: 500,000,000 and 53,690,000,000.
  assert.deepEqual(alertRoundTrip(0.5 * 1024 ** 3), { shown: '0.536870912', saved: 0.5 * 1024 ** 3 });
  assert.deepEqual(alertRoundTrip(2.25e9), { shown: '2.25', saved: 2.25e9 }, 'a decimal alert typed with two places is not rounded to one');

  const goal = goalFields(50 * 1024 ** 3);
  assert.deepEqual({ unit: goal.unit, value: goal.value }, { unit: '1000000000', value: '53.6870912' }, 'a 50 GiB target is 53.6870912 GB');
  assert.equal(goal.collect(), 50 * 1024 ** 3, 'and saving it untouched keeps every byte');
  const mib = goalFields(500 * 1024 ** 2);
  assert.deepEqual({ unit: mib.unit, value: mib.value }, { unit: '1000000', value: '524.288' }, 'a 500 MiB target stays in MB: 524.288 MB, not 0.52 GB');
  assert.equal(mib.collect(), 500 * 1024 ** 2);

  for (const b of storedSizes()) {
    assert.equal(alertRoundTrip(b).saved, b, `an alert of ${b} bytes survives a Save`);
    assert.equal(goalFields(b).collect(), b, `a target of ${b} bytes survives a Save`);
  }
});

test('every box that opens a stored size is wide enough for its exact figure — 14 characters for any size under 10 TB (review F2.5)', () => {
  // The boxes paint the stored bytes' exact figure (review F1.1, F1.5). An
  // 88 px box keeps about 47 px of text beside its spin buttons, so a 5 GiB
  // cap an earlier TreeMap stored, "5.36870912", read as "5.3687" — a shorter,
  // different number — and a 0.5 GiB alert in its 92 px column as "0.5368".
  let widest = '';
  for (const b of storedSizes(300).filter((n) => n < 1e13)) {
    const p = { name: 'p', path: '/home/u', match: { kind: 'custom', minBytes: b }, maxBytesPerRun: b, maxBytesPerWeek: b, requireConfirmationAbove: b };
    const e = editorRuntime(p);
    e.open(p);
    const painted = [...['apMaxRun', 'apMaxWeek', 'apConfirmAbove', 'apRuleSizeMb'].map((id) => String(e.$(id).value)), String(goalFields(b).value), alertRoundTrip(b).shown];
    for (const s of painted) if (s.length > widest.length) widest = s;
  }
  const chars = widest.length; // 14: "1099.511627776", 1 TiB in GB

  // The base box: 13 px text, 12 px padding each side, a 1 px border.
  const base = braced('input[type="text"], input[type="number"], select {');
  const pad = Number(/padding: \d+px (\d+)px;/.exec(base)?.[1] ?? assert.fail('the base box states its padding'));
  assert.match(base, /border: 1px solid/);
  assert.match(base, /font-size: 13px;/);
  const SPIN = 16; // a number box's spin buttons: about 15 px in Chromium
  const chrome = 2 * pad + 2 + SPIN;

  const sizeBox = braced('.rule-row input.size-in {');
  const [, ch, px] = /width: calc\((\d+)ch \+ (\d+)px\);/.exec(sizeBox) ?? assert.fail(`the size boxes are sized in characters: ${sizeBox}`);
  assert.ok(Number(ch) >= chars, `a size box holds ${ch} characters; "${widest}" needs ${chars}`);
  assert.ok(Number(px) >= chrome, `and ${px} px for its padding, border and spin buttons, which take ${chrome}`);
  assert.match(sizeBox, /font-variant-numeric: tabular-nums;/, 'every digit as wide as the "0" a ch measures');
  for (const id of ['apRuleSizeMb', 'apMaxRun', 'apMaxWeek', 'apConfirmAbove', 'cleanupGoalValue']) {
    const tag = new RegExp(`<input [^>]*id="${id}"[^>]*>`).exec(INDEX)?.[0] ?? assert.fail(`#${id} is in the page`);
    assert.match(tag, /class="[^"]*\bsize-in\b/, `#${id} is a size box`);
  }

  // The scheduled-scan alert fills a grid column, measured in the row's own characters.
  const sched = braced('.sched-row {');
  const tracks = /grid-template-columns: ([^;]*);/.exec(sched)?.[1] ?? assert.fail('the schedule rows are a grid');
  const alert = /^minmax\([^()]*\) minmax\([^()]*\) minmax\(\d+px, calc\((\d+)ch \+ (\d+)px\)\) /.exec(tracks) ?? assert.fail(`the alert column is sized in characters: ${tracks}`);
  assert.ok(Number(alert[1]) >= chars, `the alert column holds ${alert[1]} characters; "${widest}" needs ${chars}`);
  assert.ok(Number(alert[2]) >= chrome, `and ${alert[2]} px for the box around them, which takes ${chrome}`);
  assert.match(sched, /font-size: 13px;/, 'the row\'s characters are its boxes\' 13 px ones');
  assert.doesNotMatch(braced('.sched-row.sched-head {'), /font-size/, 'and the header row keeps that size, so its columns line up with the rows under it');
  assert.match(braced('.sched-row input.s-gb {'), /font-variant-numeric: tabular-nums;/);
});

/* ══════════════ thresholds the page shows or acts on ══════════════ */

/**
 * Each line of `code` that spells a 1024-based size, once per line: 1024 as a
 * number (`v /= 1024`, `n % 1024`, `1024 ** 3`, `1024.0`); a shift or a power
 * of two by 10, 20, 30 or 40 bits (`1 << 20`, `bytes >> 30`, `2 ** 30`,
 * `Math.pow(2, 40)`); and an integer literal of seven digits or more that is a
 * whole number of MiB (104857600 is 100 MiB, 5368709120 is 5 GiB) — except
 * 4294967296, the range of a 32-bit hash, which is a count. Smaller powers of
 * two (4096 as a cap, 65536 as a count) and hex literals are not judged.
 */
function binarySizesIn(code: string): string[] {
  const hits = new Set<string>();
  const spelled = /(?<![\w.])1024(?!\w)|(?:<<|>>>?) ?(?:10|20|30|40)\b|\b2 ?\*\* ?(?:10|20|30|40)\b|Math\.pow\( ?2 ?, ?(?:10|20|30|40) ?\)|(?<![\w.])\d[\d_]{6,}(?![\w.])/g;
  for (const m of code.matchAll(spelled)) {
    if (/^\d[\d_]{6,}$/.test(m[0])) {
      const n = Number(m[0].replace(/_/g, ''));
      if (n % 1048576 !== 0 || n === 2 ** 32) continue; // a decimal figure, a count, or a hash's range
    }
    hits.add(code.slice(code.lastIndexOf('\n', m.index) + 1, code.indexOf('\n', m.index)).trim());
  }
  return [...hits];
}

test('the binary-size scan finds each 1024-based spelling it names, and passes decimal sizes and plain counts (review F1.4)', () => {
  // The scan below is the only thing between the page and a size divided by
  // 1024 again. It knew seven literals and two shapes; the old formatBytes
  // loop, a 100 MiB literal and `1 << 20` all went through it.
  for (const bad of [
    'while (v >= 1024) { v /= 1024; }', // the old formatBytes loop
    'const unit = n % 1024 === 0 ? 1024 : 1;', // the old budget unit table
    "return (n / 1024).toFixed(1) + ' KB';",
    'const n = x * 1024.0;',
    'const MB3 = 1048576;', 'const big = 1024 * 1024 * 1024;', 'const t = Math.pow(1024, 3);',
    'if (bytes > 104857600) warn();', 'const cap = 5_368_709_120;', 'const two = 2147483648;',
    'const MiB = 1 << 20;', 'const mib = bytes >> 20;', 'const gib = bytes >>> 30;',
    'const GiB = 2 ** 30;', 'const KiB = 2**10;', 'const TiB = Math.pow(2, 40);',
  ]) assert.equal(binarySizesIn(bad).length, 1, `caught: ${bad}`);
  for (const fine of [
    'const GB = 1e9;', 'if (size > 1000000000) big();', 'const PB = 1_000_000_000_000_000;',
    "const s = 'Explorer divides by 1,024';", 'el.style.width = "1024px";', 'const r = 0.1024;',
    'return (h >>> 0) / 4294967296;', // 2^32, a 32-bit hash's range: a count, not a size
    'const cap = 4096;', 'h ^= h << 13; h ^= h >>> 17;', 'const n = 12345678;',
  ]) assert.deepEqual(binarySizesIn(fine), [], `not a binary size: ${fine}`);
});

test('no size in the page is a power of 1024: every threshold it shows or acts on is a decimal size', () => {
  // The size key's ends ("1 MB … 10 GB+"), the Apps view's "Clear … safely"
  // button (offered from 1 MB) and the Git repositories list (repos over
  // 1 MB) each compared against a mebibyte while the page printed megabytes.
  const at = INDEX.indexOf('<script');
  assert.notEqual(at, -1, 'the page has its script');
  const code = INDEX.slice(at).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  assert.ok(code.length > 500_000, `the scan reads the whole script, not a sliver of it (${code.length} characters)`);
  assert.ok(code.includes('function formatBytes(') && code.includes('function renderCleanupGoalFields('), 'and it is the page\'s own code');
  assert.deepEqual(binarySizesIn(code), [], 'a binary size in the page\'s code');
});

/**
 * Each place in `text` that names formatBytes and, on that line or the two
 * after it, calls its units binary: "binary", a 1024, base 2, or a KiB, MiB,
 * GiB or TiB.
 */
function binaryFormatBytesClaims(text: string): string[] {
  const lines = text.split('\n');
  return lines.flatMap((line, i) =>
    /formatBytes/.test(line) && /\bbinary\b|(?<![\w.])1024(?!\w)|\bbase[- ]?2\b|\b[KMGT]iB\b/i.test(lines.slice(i, i + 3).join('\n'))
      ? [`${i + 1}: ${line.trim()}`] : []);
}

test('no comment in the code calls the shared formatBytes binary, now that it counts in 1000s (review F3.4)', () => {
  // missingGigabytes.ts said its notes go "through the shared formatBytes
  // (binary units)" a release after formatBytes became decimal; told so, the
  // next maintainer may "fix" the labels back.
  for (const said of [
    '// Bytes in notes go through the shared formatBytes (binary units), the same',
    ' * formatBytes divides by 1024, so',
    '// formatBytes: sizes in\n// KiB and MiB',
  ]) assert.equal(binaryFormatBytesClaims(said).length, 1, `caught: ${said}`);
  for (const said of [
    '// Bytes in notes go through the shared formatBytes (decimal units, as Finder counts them), the same',
    ' * reason. Sizes through formatBytes, decimal like every size TreeMap prints',
    '// formatBytes\n\n\n// a binary plist', // three lines on: a different sentence
  ]) assert.deepEqual(binaryFormatBytesClaims(said), [], `not a claim: ${said}`);

  const root = path.join(__dirname, '..');
  const files = ['src', 'electron'].flatMap((dir) =>
    (readdirSync(path.join(root, dir), { recursive: true }) as string[])
      .filter((f) => /\.(ts|js|cjs|mjs)$/.test(f) && !f.split(path.sep).includes('node_modules'))
      .map((f) => path.join(dir, f)));
  assert.ok(files.includes(path.join('src', 'services', 'missingGigabytes.ts')) && files.length > 200, `every source file is read (${files.length})`);
  const claims = files.flatMap((f) => binaryFormatBytesClaims(readFileSync(path.join(root, f), 'utf8')).map((c) => `${f}:${c}`));
  assert.deepEqual(claims, [], 'a comment that calls formatBytes binary');
  assert.match(readFileSync(path.join(root, 'src/services/missingGigabytes.ts'), 'utf8'),
    /shared formatBytes \(decimal units, as Finder(?:\s|\/\/)+counts them\)/, 'missingGigabytes names the units its notes print in');
});

/* ══════════════ the map's floor, wherever the map is asked for ══════════════ */

test('Disk City asks for the map with the Treemap\'s 4 KB floor, and records it beside the nodes the two views share', async () => {
  // TM_MIN_SIZE became 4,000 (D09) while Disk City went on asking with a
  // literal 4096: opened first, it drew no building for a 4,000–4,095-byte
  // file the Treemap then drew, and left state.treemap.minSize unset, so the
  // note under the map named no floor for nodes that had one.
  const floor = run<number>(pageConst('TM_MIN_SIZE'), {}, 'TM_MIN_SIZE');
  const asked: string[] = [];
  const state = {
    scanId: 's1', root: { path: '/r', name: 'r' }, city: {} as Record<string, unknown>,
    treemap: { rootPath: '/r', maxDepth: 3, nodes: [] as unknown[], minSize: undefined as number | undefined },
  };
  const loadCity = run<(p: string) => Promise<void>>(
    `let cityLoadSeq = 0;\n${pageConst('TM_MIN_SIZE')}\n${braced('function treeScanId(')}\n${braced('async function loadCity(')}`,
    {
      state, $: dom().$,
      api: async (u: string) => { asked.push(u); return { root: { path: '/r', name: 'r', size: 9000 }, nodes: [{ path: '/r/f', size: 4000 }] }; },
      renderCrumbs() {}, buildCity() {}, cityEnter() {}, renderCityTable() {}, cityFetchFacts() {}, cityShowCard() {}, renderCityChrome() {},
    },
    'loadCity',
  );
  await loadCity('/r');
  assert.equal(asked.length, 1, 'control: with no map loaded, Disk City asked the server itself');
  assert.equal(new URL(asked[0], 'http://x').searchParams.get('minSize'), String(floor), 'the floor the Treemap asks with (TM_MIN_SIZE)');
  assert.equal(state.treemap.minSize, floor, 'and the floor the shared nodes were asked with is recorded, as loadTreemap records it');
});

/** The page's loadCity over a stub server: `serve(root, minSize)` answers each ask, and `asked` lists them. */
function cityLoader(serve: (root: string, minSize: number) => Promise<{ root: { path: string; name: string; size: number }; nodes: unknown[] }>) {
  const asked: Array<[string, number]> = [];
  const state = {
    scanId: 's1', root: { path: '/r', name: 'r' }, city: {} as Record<string, unknown>,
    treemap: { rootPath: '/r', maxDepth: 3, nodes: [] as unknown[], minSize: undefined as number | undefined },
  };
  const loadCity = run<(p: string) => Promise<void>>(
    `let cityLoadSeq = 0;\n${pageConst('TM_MIN_SIZE')}\n${braced('function treeScanId(')}\n${braced('async function loadCity(')}`,
    {
      state, $: dom().$,
      api: async (u: string) => {
        const q = new URL(u, 'http://x').searchParams;
        const ask: [string, number] = [q.get('root')!, Number(q.get('minSize'))];
        asked.push(ask);
        return serve(...ask);
      },
      renderCrumbs() {}, buildCity() {}, cityEnter() {}, renderCityTable() {}, cityFetchFacts() {}, cityShowCard() {}, renderCityChrome() {},
    },
    'loadCity',
  );
  return { loadCity, state, asked };
}

test('Disk City asks again without the floor when the floor hid every file, as the Treemap does (review F2.6)', async () => {
  // A folder of 30 files of 3,000 bytes: the 4 KB ask returns no nodes. The
  // Treemap asks again with minSize=1 and draws all 30; Disk City kept the
  // empty answer and drew a blank city ("showing all 0").
  const floor = run<number>(pageConst('TM_MIN_SIZE'), {}, 'TM_MIN_SIZE');
  const small = Array.from({ length: 30 }, (_, i) => ({ path: `/r/d/f${i}`, size: 3000 }));
  const c = cityLoader(async (root, m) => ({ root: { path: root, name: 'd', size: 90_000 }, nodes: m <= 3000 ? small : [] }));
  await c.loadCity('/r/d');
  assert.deepEqual(c.asked, [['/r/d', floor], ['/r/d', 1]], 'the floor hid everything there was, so it asked again without it');
  assert.equal(c.state.treemap.nodes.length, 30, 'the city holds the 30 files the Treemap draws');
  assert.equal(c.state.treemap.minSize, 1, 'and records that these nodes were asked for with no floor');

  // A folder with no bytes at all is asked for once: there is nothing a floor hid.
  const empty = cityLoader(async (root) => ({ root: { path: root, name: 'e', size: 0 }, nodes: [] }));
  await empty.loadCity('/r/e');
  assert.deepEqual(empty.asked, [['/r/e', floor]], 'an empty folder is not asked for twice');
});

test('a Disk City load overtaken while it asks again without the floor lands nothing (review F2.6)', async () => {
  const small = Array.from({ length: 30 }, (_, i) => ({ path: `/r/d/f${i}`, size: 3000 }));
  const c: ReturnType<typeof cityLoader> = cityLoader(async (root, m) => {
    if (root === '/r/d' && m === 1) await c.loadCity('/r/x'); // the person drilled elsewhere meanwhile
    return root === '/r/d'
      ? { root: { path: root, name: 'd', size: 90_000 }, nodes: m <= 3000 ? small : [] }
      : { root: { path: root, name: 'x', size: 9000 }, nodes: [{ path: '/r/x/f', size: 9000 }] };
  });
  await c.loadCity('/r/d');
  assert.deepEqual(c.asked.map((a) => a[0]), ['/r/d', '/r/d', '/r/x'], 'control: the newer load started during the retry');
  assert.equal(c.state.treemap.rootPath, '/r/x', 'the overtaken retry does not replace the newer folder');
});

/**
 * The page's own renderCityChrome over a city that drew `drawn` of `total`
 * nodes, returning the coverage line it writes (#cityLod).
 */
function cityNote(o: { drawn: number; total: number; nodes?: Array<{ isTrash?: boolean }>; minSize?: number; history?: boolean }): string {
  const lod = { textContent: '', hidden: true };
  const state = {
    // What the city was built from: the nodes a fetch recorded, with the floor
    // it asked them with (C03 review F3.1) — the line reads nothing else.
    city: {
      drawn: o.drawn, total: o.total, unknownHeight: 0, unresolved: 0, height: 'staleness', colour: 'size',
      builtFrom: { nodes: o.nodes ?? Array.from({ length: o.total }, () => ({})), minSize: o.minSize, size: 0 },
    },
    // The Treemap's time slider, which the nodes the city was built from never are.
    treemap: { history: { active: o.history === true } },
  };
  run<() => void>(
    `${pageConst('UNITS')}\n${braced('function formatBytes(')}\n${pageConst('TM_SERVER_NODE_CAP')}\n${braced('function treeScanId(')}\n${braced('function treeScanComing(')}\n${braced('function renderCityChrome(')}`,
    { state, $: (id: string) => (id === 'cityLod' ? lod : null), formatCount: (n: number) => n.toLocaleString('en-US') },
    'renderCityChrome',
  )();
  assert.equal(lod.hidden, false, 'the coverage line is shown');
  return lod.textContent;
}

test('Disk City says "showing all" only of what its nodes can hold: the floor they were asked with, and the server\'s node cap (review F3.5)', async () => {
  // A folder of 10 files of 5 MB and 30 of 3,000 bytes. The 4 KB ask returns
  // the 10, so there is no retry, and the city said "showing all 10" while
  // the 30 were not drawn at all.
  const files = [
    ...Array.from({ length: 10 }, (_, i) => ({ path: `/r/d/big${i}`, size: 5_000_000 })),
    ...Array.from({ length: 30 }, (_, i) => ({ path: `/r/d/small${i}`, size: 3000 })),
  ];
  const c = cityLoader(async (root, m) => ({ root: { path: root, name: 'd', size: 50_090_000 }, nodes: files.filter((f) => f.size >= m) }));
  await c.loadCity('/r/d');
  assert.equal(c.state.treemap.nodes.length, 10, 'control: the floor kept the 10 large files and no retry asked for the rest');
  assert.equal(c.state.treemap.minSize, 4000, 'control: the nodes were asked for with the 4 KB floor');
  const record = (c.state.treemap as { nodesFor?: { nodes: []; minSize?: number } }).nodesFor;
  assert.equal(record?.minSize, 4000, 'and the floor is recorded with the nodes it was asked for');
  const said = cityNote({ drawn: 10, total: 10, nodes: record!.nodes, minSize: record!.minSize });
  assert.doesNotMatch(said, /^showing all 10$/, 'not "all" of a folder whose 30 small files are not drawn');
  assert.equal(said, 'showing all 10 items of 4.0 KB or more', 'all of the items at or over the floor, which it names');
  assert.equal(cityNote({ drawn: 10, total: 40, minSize: 4000 }), 'showing 10 of 40 items of 4.0 KB or more — zoom in for more');

  // Asked with no floor (the retry), nothing was left out by size, and "all" is true.
  assert.equal(cityNote({ drawn: 30, total: 30, minSize: 1 }), 'showing all 30');
  // The city is built only from nodes a fetch recorded, never from a
  // snapshot's layout (C03 review F2.2), so the time slider left on a
  // snapshot while Disk City fetched the live folder takes nothing off the
  // floor those nodes were asked with (C03 review F3.1).
  assert.equal(cityNote({ drawn: 30, total: 30, minSize: 4000, history: true }), 'showing all 30 items of 4.0 KB or more',
    'the floor the built nodes were asked with, whatever the time slider shows');
  assert.equal(cityNote({ drawn: 30, total: 30 }), 'showing all 30', 'nor do nodes nobody recorded a floor for');

  // The server sends at most TM_SERVER_NODE_CAP nodes; a folder that reached
  // it has more than the city holds.
  const cap = run<number>(pageConst('TM_SERVER_NODE_CAP'), {}, 'TM_SERVER_NODE_CAP');
  assert.equal(cap, 20_000, 'control: the cap the server keeps to');
  const reach = 'the map holds at most 20,000 items, and this folder reached that — drill in for the rest';
  assert.equal(cityNote({ drawn: cap, total: cap, minSize: 1 }), `showing 20,000 · ${reach}`);
  assert.equal(cityNote({ drawn: 900, total: cap, minSize: 4000 }), `showing 900 of 20,000 items of 4.0 KB or more — zoom in for more · ${reach}`);
  assert.equal(cityNote({ drawn: cap - 1, total: cap - 1, minSize: 1 }), 'showing all 19,999', 'one under the cap is all there is');
  const withTrash = [...Array.from({ length: cap - 1 }, () => ({})), { isTrash: true }];
  assert.equal(cityNote({ drawn: cap, total: cap, nodes: withTrash, minSize: 1 }), 'showing all 20,000', 'the Trash cell the page adds is not one the server sent');
});

/* ══════════════ the page says which units it counts in ══════════════ */

test('Settings → "How TreeMap measures space" says sizes are decimal, and what that means against Finder and Explorer', () => {
  const at = INDEX.indexOf('How TreeMap measures space');
  assert.notEqual(at, -1, 'the section is in Settings');
  const words = INDEX.slice(at, INDEX.indexOf('id="allocationDiag"', at)).replace(/<[^>]+>/g, ' ').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
  assert.match(words, /1 KB is 1,000 bytes, 1 MB is 1,000,000 bytes and 1 GB is 1,000,000,000 bytes/, words);
  assert.match(words, /Finder/, 'the reference a Mac user checks against');
  assert.match(words, /Explorer[^.]*1,024/, 'and why Windows shows the same files smaller');
  assert.match(words, /size>1gb/, 'the search box reads the same units');
});

test('the docs promise a formatted string beside a size only where the answers give one (review F1.3, F2.1, F2.2)', () => {
  // PLATFORM_NOTES said "every API answer carries the raw bytes beside the
  // formatted string". A sentence that prints a size does not: DEST_FULL's
  // message ("this needs 30.0 MB … only 30.3 MB is free") and the gdu
  // fallback's reason carry two formatted figures and no byte count, so an
  // agent trusting the sentence would compare rounded strings (F1.3).
  // The first fix still promised a formatted twin beside every size FIELD.
  // Over HTTP only /api/agent/summary adds one at all (GET /api/large-files'
  // `size` is raw bytes alone), and several MCP fields have none — offload's
  // dry-run copies[].size and progress bytesDone, compare_scans' sizeA and
  // sizeB, forecast's topGrowers[].bytesPerDay (F2.1, F2.2).
  const doc = (file: string) => readFileSync(path.join(__dirname, '..', file), 'utf8');
  const notes = doc('docs/PLATFORM_NOTES.md');
  const at = notes.indexOf('## Size units');
  assert.notEqual(at, -1, 'PLATFORM_NOTES has its units section');
  const units = notes.slice(at, notes.indexOf('\n## ', at + 1)).replace(/\s+/g, ' ');
  assert.doesNotMatch(units, /every API answer carries the raw bytes/, 'no claim the error and reason sentences do not keep');
  assert.doesNotMatch(units, /raw bytes stand beside the formatted string/, 'no claim that a formatted string stands beside every size field');
  assert.match(units, /A size an API answer gives as a field is a raw byte count/, 'what a size field is, everywhere');
  assert.match(units, /`GET \/api\/agent\/summary` is the one HTTP route that adds formatted strings/, 'the one HTTP answer that adds a formatted string');
  assert.match(units, /`GET \/api\/large-files`/, 'and a route that does not, by name');
  assert.match(units, /MCP tools add a formatted twin beside many size fields, not all/, 'the MCP tools add one beside many, not all');

  const agents = doc('AGENTS.md');
  const mcp = agents.slice(agents.indexOf('## MCP specifics'), agents.indexOf('\n## ', agents.indexOf('## MCP specifics') + 1)).replace(/\s+/g, ' ');
  assert.doesNotMatch(mcp, /All sizes come back as raw bytes/, 'AGENTS.md\'s MCP line makes no claim of every size');
  assert.doesNotMatch(mcp, /Every size field comes back as raw bytes plus/, 'nor promises every size field a formatted twin');
  assert.match(mcp, /A size field is a raw byte count/);
  assert.match(mcp, /not every size field has one/);
  for (const field of ['`copies[].size`', '`bytesDone`', '`sizeA`', '`sizeB`', '`topGrowers[].bytesPerDay`']) {
    assert.ok(mcp.includes(field), `AGENTS.md names ${field} among the size fields with no formatted twin`);
  }
});

test('the docs say a size inside a sentence is for a person to read: most print the formatted figure alone, a diagnostic may print exact bytes, so an agent reads the raw fields (review F3.3)', () => {
  // AGENTS.md and PLATFORM_NOTES said a size inside a sentence "is the
  // formatted figure only". The NTFS turbo mode's cross-check reason, which
  // becomes a scan's engineReason, names a file's two sizes as exact byte
  // counts ("… its size is 223 bytes, but opening it now reports 289 bytes" —
  // tests/mftEngine.test.ts pins that sentence), and so can the mode's read
  // errors. A diagnostic means its exact figure; the docs now say so.
  const doc = (file: string) => readFileSync(path.join(__dirname, '..', file), 'utf8');
  const section = (text: string, heading: string) => {
    const at = text.indexOf(heading);
    assert.notEqual(at, -1, `the docs have "${heading}"`);
    return text.slice(at, text.indexOf('\n## ', at + 1)).replace(/\s+/g, ' ');
  };
  for (const [where, text] of [
    ['PLATFORM_NOTES', section(doc('docs/PLATFORM_NOTES.md'), '## Size units')],
    ['AGENTS.md', section(doc('AGENTS.md'), '## MCP specifics')],
  ] as const) {
    assert.doesNotMatch(text, /is the formatted figure only/, `${where} no longer says every size in a sentence is formatted`);
    assert.match(text, /[Aa] size inside a sentence is for a person to read/, `${where} says what a size in a sentence is for`);
    assert.match(text, /most print the formatted figure alone[^.]*`DEST_FULL`/, `${where} names a sentence that prints the formatted figure`);
    assert.match(text, /a diagnostic may print an exact byte count instead[^.]*NTFS turbo mode.s cross-check/, `${where} names one that prints exact bytes`);
    assert.match(text, /read sizes from the raw fields, never from the words/, `${where} sends an agent to the raw fields`);
  }
});

test('PLATFORM_NOTES\' Size units section keeps the file\'s 80-column wrap: no line runs past it', () => {
  const notes = readFileSync(path.join(__dirname, '..', 'docs/PLATFORM_NOTES.md'), 'utf8');
  const at = notes.indexOf('## Size units');
  assert.notEqual(at, -1, 'PLATFORM_NOTES has its units section');
  const lines = notes.slice(at, notes.indexOf('\n## ', at + 1)).split('\n');
  assert.ok(lines.length > 10, 'the section is read whole');
  assert.deepEqual(lines.filter((line) => line.length > 80).map((line) => `${line.length} columns: ${line}`), []);
});

test('the agent summary is described as it answers: a formatted twin beside every size but the forecast\'s topGrowers[].bytesPerDay, which is raw bytes only (review F3.2)', () => {
  // AGENTS.md, the route's own comment and its OpenAPI summary all said the
  // summary gives "every number as raw bytes plus a formatted string". The
  // forecast is spread in as computed, so each of its topGrowers carries a
  // bytesPerDay with no twin, and an agent trusting the sentence looked for
  // one and found nothing. (tests/agentErgonomics.test.ts walks a live
  // summary for every other size's twin.)
  const read = (file: string) => readFileSync(path.join(__dirname, '..', file), 'utf8');
  const agents = read('AGENTS.md');
  const at = agents.indexOf('`GET /api/agent/summary?scanId=`');
  assert.notEqual(at, -1, 'AGENTS.md introduces the agent summary');
  const said = agents.slice(at, agents.indexOf('\n   The tree itself', at)).replace(/\s+/g, ' ');
  const comment = (() => {
    const src = read('src/api/metaRoutes.ts');
    const end = src.indexOf("metaRouter.get('/agent/summary'");
    return src.slice(src.lastIndexOf('/**', end), end).replace(/\s*\*\s*/g, ' ');
  })();
  // The entry's summary string, its concatenated pieces joined as JavaScript joins them.
  const openapi = (/path: '\/api\/agent\/summary',\s*summary:\s*((?:'[^']*'(?:\s*\+\s*)?)+)/.exec(read('src/api/openapi.ts'))?.[1]
    ?? assert.fail('the OpenAPI entry for the agent summary has a summary')).match(/'[^']*'/g)!.map((s) => s.slice(1, -1)).join('');
  for (const [where, text] of [['AGENTS.md', said], ['metaRoutes.ts', comment], ['openapi.ts', openapi]] as const) {
    assert.doesNotMatch(text, /every number as raw bytes plus a formatted string|Every number comes as raw bytes plus a formatted string|— raw bytes \+ formatted,/,
      `${where} no longer promises a formatted string beside every number`);
    assert.match(text, /[Ee]very size[^.]*raw bytes/, `${where} says what a size is`);
    assert.match(text, /topGrowers\[\]\.bytesPerDay/, `${where} names the size that has no formatted twin`);
  }
  assert.match(said, /`forecast\.topGrowers\[\]\.bytesPerDay`[^.]*raw bytes only/, 'AGENTS.md says that size is raw bytes only');
});

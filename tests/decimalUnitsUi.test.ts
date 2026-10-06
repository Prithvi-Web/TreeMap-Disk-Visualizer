import { test } from 'node:test';
import assert from 'node:assert/strict';

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

  // Every size a limit can hold comes back as the bytes it was; a size rule
  // from the editor's own 1 MB floor up.
  for (const b of storedSizes()) {
    const p = { name: 'p', path: '/home/u', match: { kind: 'custom', minBytes: Math.max(1e6, b) }, maxBytesPerRun: b, maxBytesPerWeek: b, requireConfirmationAbove: b };
    const e = editorRuntime(p);
    e.open(p);
    const r = e.read();
    assert.deepEqual([r.maxBytesPerRun, r.maxBytesPerWeek, r.requireConfirmationAbove, r.match.minBytes], [b, b, b, Math.max(1e6, b)], `${b} bytes`);
  }
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
    braced('function collectSettingsForms('),
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
    braced('function collectSettingsForms('),
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

/* ══════════════ thresholds the page shows or acts on ══════════════ */

test('no size in the page is a power of 1024: every threshold it shows or acts on is a decimal size', () => {
  // The size key's ends ("1 MB … 10 GB+"), the Apps view's "Clear … safely"
  // button (offered from 1 MB) and the Git repositories list (repos over
  // 1 MB) each compared against a mebibyte while the page printed megabytes.
  const script = INDEX.slice(INDEX.indexOf('<script'));
  const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  for (const m of code.matchAll(/\b(1048576|1_048_576|1073741824|1_073_741_824|1099511627776|10485760|1024 ?\*\* ?[2-5]|1024 ?\* ?1024)\b/g)) {
    const line = code.slice(code.lastIndexOf('\n', m.index) + 1, code.indexOf('\n', m.index));
    assert.fail(`a binary size in the page's code: ${line.trim()}`);
  }
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
    `let cityLoadSeq = 0;\n${pageConst('TM_MIN_SIZE')}\n${braced('async function loadCity(')}`,
    {
      state, $: dom().$,
      api: async (u: string) => { asked.push(u); return { root: { path: '/r', name: 'r', size: 9000 }, nodes: [{ path: '/r/f', size: 4000 }] }; },
      renderCrumbs() {}, buildCity() {}, cityEnter() {}, renderCityTable() {}, cityFetchFacts() {},
    },
    'loadCity',
  );
  await loadCity('/r');
  assert.equal(asked.length, 1, 'control: with no map loaded, Disk City asked the server itself');
  assert.equal(new URL(asked[0], 'http://x').searchParams.get('minSize'), String(floor), 'the floor the Treemap asks with (TM_MIN_SIZE)');
  assert.equal(state.treemap.minSize, floor, 'and the floor the shared nodes were asked with is recorded, as loadTreemap records it');
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

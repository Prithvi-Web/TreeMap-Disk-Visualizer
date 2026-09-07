import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { formatCount as serverFormatCount, machineHourCycle, UI_LOCALE } from '../src/utils/formatCount';
import { lift } from './fixtures/liftFrontend';

/**
 * Issue #34: on a Portuguese Windows one test failed because the page printed
 * "1.234 shapes" where the test expected "1,234". The test was the messenger.
 * The page's `formatCount` — and some twenty server messages — used a bare
 * `toLocaleString()`, which follows the machine's locale, while `formatBytes`
 * always prints an English decimal point: the same dot meant thousands in one
 * number and tenths in the next, and an Arabic machine printed Arabic-Indic
 * digits inside English sentences. Running the whole suite under five locales
 * found twelve tests that depended on the machine, not one.
 *
 * The rule now: what a person reads is written the English way on every
 * machine. Counts go through `formatCount` (page and server); dates name
 * UI_LOCALE, and the two clocks pass the machine's own 12/24-hour setting
 * (HOUR_CYCLE, machineHourCycle) — that and the time zone are the machine's,
 * the words are not. CI runs the suite under a Portuguese locale. This file
 * holds the rule statically, and PROVES it by running Node under three locales.
 *
 * The static rule is a plain text search, comments included: stripping
 * comments first with a regex would let a `/*` inside a string pair with a
 * later real `*\/` and hide live code from the search. A comment that wants to
 * name the call writes it without the dot.
 */

const root = path.join(__dirname, '..');
const read = (...p: string[]) => readFileSync(path.join(root, ...p), 'utf8');
const rel = (f: string) => path.relative(root, f).split(path.sep).join('/');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|js|mjs|cjs)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/* Every way of asking Intl for the MACHINE's locale, whitespace-tolerant. A
   call that names a locale — 'en-US', UI_LOCALE — is not matched. */
const MACHINE_LOCALE = /(\.toLocale(?:Date|Time)?String|Intl\.(?:NumberFormat|DateTimeFormat))\s*\(\s*(\)|undefined\b|null\b|\[\s*\])/;
/* The one sanctioned question to the machine: which clock does it keep. */
const HOUR_CYCLE_PROBE = /new Intl\.DateTimeFormat\(undefined, \{ hour: 'numeric' \}\)\.resolvedOptions\(\)\.hourCycle/;

function offendingLines(file: string): string[] {
  const out: string[] = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (MACHINE_LOCALE.test(line) && !HOUR_CYCLE_PROBE.test(line)) out.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
  });
  return out;
}

const APP_FILES = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'electron')), path.join(root, 'public', 'index.html')];

test('nothing a person reads follows the machine: no locale-less toLocaleString / toLocaleDateString / toLocaleTimeString / Intl.* call anywhere in the app, comments included', () => {
  assert.ok(APP_FILES.length > 100, 'the walk saw the app');
  assert.deepEqual(APP_FILES.flatMap(offendingLines), [],
    'a locale-less call follows the machine. A count goes through formatCount; a date names UI_LOCALE (and HOUR_CYCLE for a clock). Comments count too — describe the call without the leading dot.');
  assert.deepEqual(APP_FILES.filter((f) => HOUR_CYCLE_PROBE.test(readFileSync(f, 'utf8'))).map(rel).sort(),
    ['public/index.html', 'src/ui/app/000-prelude.js', 'src/utils/formatCount.ts'],
    'the hour-cycle probe exists exactly where the two formatters live');
  // The ban checks itself: a regex loosened by accident would pass the whole app silently.
  for (const bad of ['n.toLocaleString()', 'n .toLocaleString ( )', "d.toLocaleDateString([], { weekday: 'long' })", 'd.toLocaleTimeString(undefined, {', 'new Intl.NumberFormat().format(n)', 'new Intl.DateTimeFormat(null, {', "x.toLocaleString(undefined, { dateStyle: 'medium' })"]) {
    assert.match(bad, MACHINE_LOCALE, `the ban catches ${bad}`);
  }
  for (const good of ["n.toLocaleString('en-US')", 'new Intl.DateTimeFormat(UI_LOCALE, {', 'toLocaleDateString(UI_LOCALE, {', 'formatCount(x)', 'formatDate(ms)']) {
    assert.doesNotMatch(good, MACHINE_LOCALE, `the ban lets ${good} through`);
  }
});

test('formatCount: the page and the server agree on every input, take numeric strings, and never print a broken number as 0', () => {
  const pageFormatCount = lift<(n: unknown) => string>(['UI_LOCALE', 'formatCount'], 'formatCount');
  const rows: [unknown, string][] = [
    [0, '0'], [null, '0'], [undefined, '0'],
    [1234, '1,234'], [1234.5, '1,234.5'], [-1234, '-1,234'], [12345678901, '12,345,678,901'],
    ['1234', '1,234'], [' 1234 ', '1,234'],
    ['', '–'], ['abc', '–'], [NaN, '–'], [Infinity, '–'], [-Infinity, '–'],
  ];
  for (const [input, want] of rows) {
    assert.equal(pageFormatCount(input), want, `page formatCount(${String(input)})`);
    assert.equal(serverFormatCount(input as number), want, `server formatCount(${String(input)})`);
  }
  const prelude = read('src', 'ui', 'app', '000-prelude.js');
  assert.match(prelude, /const UI_LOCALE = 'en-US';/);
  assert.match(prelude, /function formatCount\(n\) \{[\s\S]*?toLocaleString\(UI_LOCALE\)[\s\S]*?\n\}/, 'the page writes counts in UI_LOCALE (the table above is what it must do; this is how)');
  const util = read('src', 'utils', 'formatCount.ts');
  assert.match(util, /export const UI_LOCALE = 'en-US';/);
  assert.match(util, /toLocaleString\(UI_LOCALE\)/);
  const tooltip = read('src', 'ui', 'app', '115-tooltip.js');
  assert.doesNotMatch(tooltip, /toLocaleString/, 'the human-scale lines go through formatCount like everything else');
  assert.match(tooltip, /formatCount\(Number\(e\.equivalentCount\) \|\| 0\)/);
  assert.match(tooltip, /formatCount\(b\.sampleCount\)/);
});

test('dates are English too, with the machine\'s clock and time zone: every date site names UI_LOCALE, every clock names the hour cycle', () => {
  const prelude = read('src', 'ui', 'app', '000-prelude.js');
  assert.match(prelude, /const HOUR_CYCLE = new Intl\.DateTimeFormat\(undefined, \{ hour: 'numeric' \}\)\.resolvedOptions\(\)\.hourCycle;/);
  assert.match(prelude, /const DATE_FMT = new Intl\.DateTimeFormat\(UI_LOCALE, \{ year:'numeric', month:'short', day:'numeric' \}\);/);
  assert.match(prelude, /const WHEN_FMT = new Intl\.DateTimeFormat\(UI_LOCALE, \{ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: HOUR_CYCLE \}\);/);
  assert.match(prelude, /const CLOCK_FMT = new Intl\.DateTimeFormat\(UI_LOCALE, \{ hour: '2-digit', minute: '2-digit', hourCycle: HOUR_CYCLE \}\);\nfunction formatClock\(ms\) \{ return CLOCK_FMT\.format\(ms\); \}/, 'a clock alone, same words and clock as formatWhen');
  assert.match(read('src', 'ui', 'app', '045-persistent-live-index.js'), /rollText\(\$\('statLastScan'\), formatClock\(Date\.now\(\)\)\)/, 'the "last scan" tile goes through it');
  const formatClock = lift<(ms: number) => string>(['UI_LOCALE', 'HOUR_CYCLE', 'CLOCK_FMT', 'formatClock'], 'formatClock');
  assert.match(formatClock(Date.UTC(2026, 8, 6, 22, 31)), /^\d\d:\d\d(?: [AP]M)?$/, 'ASCII digits, the machine\'s own clock');
  assert.match(read('src', 'ui', 'app', '135-calendar-heatmap.js'), /toLocaleDateString\(UI_LOCALE, \{ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' \}\)/, 'the heatmap day');
  assert.match(prelude, /const DAY_FMT = new Intl\.DateTimeFormat\(UI_LOCALE, \{ month: 'short', day: 'numeric' \}\);\nfunction formatDay\(ms\) \{ return DAY_FMT\.format\(ms\); \}/, 'a day alone');
  assert.match(read('src', 'ui', 'app', '160-folder-budgets.js'), /const when = formatDay\(p\.breachAtMs\);/, 'the budget breach day goes through it');
  const kit = read('src', 'ui', 'app', '055-fx-charts.js');
  assert.match(kit, /const fxDate = \(ms\) => formatDay\(ms\);/, 'the chart axis goes through it');
  assert.doesNotMatch(kit, /Intl\.DateTimeFormat/, 'the kit owns no date formatter of its own');
  const formatDay = lift<(ms: number) => string>(['UI_LOCALE', 'DAY_FMT', 'formatDay'], 'formatDay');
  assert.match(formatDay(Date.UTC(2026, 8, 6, 12)), /^Sep [5-7]$/, 'English month, ASCII digits');
  assert.match(read('src', 'services', 'reportExport.ts'), /new Date\(\)\.toLocaleString\(UI_LOCALE, \{ dateStyle: 'medium', timeStyle: 'short', hourCycle: machineHourCycle\(\) \}\)/, 'the report\'s "Generated" stamp');
  assert.ok(['h11', 'h12', 'h23', 'h24'].includes(machineHourCycle()), `machineHourCycle() is a real hour cycle, got ${machineHourCycle()}`);
  assert.equal(UI_LOCALE, 'en-US');
  const formatDate = lift<(ms: number) => string>(['UI_LOCALE', 'DATE_FMT', 'dateMemo', 'formatDate'], 'formatDate');
  assert.match(formatDate(Date.UTC(2026, 8, 6, 12)), /^Sep [5-7], 2026$/, 'English month, ASCII digits, the machine\'s own time zone');
  assert.equal(formatDate(0), '–', 'no timestamp, no date');
});

test('CI runs the whole suite under a Portuguese locale — on that leg only, through GITHUB_ENV — and the contributing guide says why', () => {
  const ci = read('.github', 'workflows', 'test.yml');
  assert.match(ci, /\n {10}- os: ubuntu-latest\n {12}name: Linux \(pt-BR locale\)\n {12}locale: pt_BR\.UTF-8\n {12}expect: pt-BR\n/, 'the leg exists and says which locale Node must resolve');
  assert.match(ci, /if: matrix\.locale\n {8}run: \|\n {10}sudo locale-gen \$\{\{ matrix\.locale \}\}\n {10}echo "LC_ALL=\$\{\{ matrix\.locale \}\}" >> "\$GITHUB_ENV"\n {10}echo "LANG=\$\{\{ matrix\.locale \}\}" >> "\$GITHUB_ENV"\n/,
    'the locale is generated (so no child bash or perl warns into the TAP) and exported to the later steps of this leg alone');
  assert.match(ci, /echo "TREEMAP_EXPECT_LOCALE=\$\{\{ matrix\.expect \}\}" >> "\$GITHUB_ENV"/, 'the leg names the locale it expects, and the test below holds it to that');
  assert.doesNotMatch(ci, /\n {10}LC_ALL:/, "an env: entry that resolves to '' is not unset to ICU — Node reads LC_ALL='' as the root locale `und` — so the ordinary legs would stop testing a real machine");
  assert.doesNotMatch(ci, /\n {10}LANG:/, 'same for LANG');
  const guide = read('CONTRIBUTING.md');
  assert.match(guide, /goes through `formatCount`/);
  assert.match(guide, /names `UI_LOCALE`/);
  assert.match(guide, /runs the whole suite under a Portuguese locale/);
});

test('when CI says this leg runs under a locale, Node really resolved that locale', { skip: process.env.TREEMAP_EXPECT_LOCALE ? false : 'TREEMAP_EXPECT_LOCALE is set only on the CI locale leg' }, () => {
  assert.equal(Intl.NumberFormat().resolvedOptions().locale, process.env.TREEMAP_EXPECT_LOCALE,
    'the locale leg would otherwise be a second English leg passing twice');
});

test('under pt-BR, de-DE and ar-EG the shipped formatters still write 1,234,567 and an English date — proven in a child Node, not assumed', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'treemap-locale-'));
  try {
    const child = path.join(dir, 'probe.ts');
    const posix = (...p: string[]) => JSON.stringify(path.join(root, ...p).split(path.sep).join('/'));
    writeFileSync(child, `
      import { formatCount } from ${posix('src', 'utils', 'formatCount')};
      import { lift } from ${posix('tests', 'fixtures', 'liftFrontend')};
      const pageFormatCount = lift<(n: number) => string>(['UI_LOCALE', 'formatCount'], 'formatCount');
      const formatDate = lift<(ms: number) => string>(['UI_LOCALE', 'DATE_FMT', 'dateMemo', 'formatDate'], 'formatDate');
      const noon = Date.UTC(2026, 8, 6, 12);
      console.log(JSON.stringify({
        locale: Intl.NumberFormat().resolvedOptions().locale,
        machineCount: (1234567).toLocaleString(), machineDate: new Date(noon).toLocaleDateString(),
        page: pageFormatCount(1234567), server: formatCount(1234567), pageDate: formatDate(noon),
      }));
    `);
    const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const switched: string[] = [];
    for (const locale of ['pt_BR.UTF-8', 'de_DE.UTF-8', 'ar_EG.UTF-8']) {
      const r = spawnSync(process.execPath, [tsx, child], { env: { ...process.env, LC_ALL: locale, LANG: locale }, encoding: 'utf8', timeout: 60_000 });
      assert.equal(r.status, 0, `${locale}: ${r.stderr}`);
      const out = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<'locale' | 'machineCount' | 'machineDate' | 'page' | 'server' | 'pageDate', string>;
      assert.equal(out.page, '1,234,567', `${locale} (Node saw ${out.locale}): the page's count`);
      assert.equal(out.server, '1,234,567', `${locale} (Node saw ${out.locale}): the server's count`);
      assert.match(out.pageDate, /^Sep [5-7], 2026$/, `${locale} (Node saw ${out.locale}): the page's date`);
      if (out.machineCount !== '1,234,567' || !/^Sep [5-7], 2026$/.test(out.machineDate)) switched.push(`${locale} → ${out.machineCount} / ${out.machineDate}`);
    }
    // Windows takes Node's locale from the system, not from LC_ALL, so there
    // the child never switches and the equalities above are the whole test.
    if (process.platform !== 'win32') {
      assert.ok(switched.length >= 1, 'LC_ALL changed the child’s locale, so the equalities above were tested against something');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

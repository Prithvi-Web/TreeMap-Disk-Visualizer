import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-historyRuleChange-data-');

import { compileIgnore } from '../src/utils/glob';

/**
 * History › Compare and Trends across a change of "Don't scan" rules (B24,
 * the sibling of QA D75's What's New banner).
 *
 * A "Don't scan" rule leaves a folder out of the next scan. Compare then
 * listed that folder as "removed" with a "Check snapshots" button — inviting
 * a hunt through the system's snapshots for a folder that was never deleted —
 * and Trends' net-change strip drew −5 MB then +5 MB as the rule went on and
 * off. The page already keeps the patterns each scan ran with (the coverage
 * record, per snapshot and now per live scan too); these tests EXECUTE the
 * built page's own functions over that record.
 */

const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** `function name(…) {…}` or `const NAME = …;` from the built page. */
function decl(name: string): string {
  let start = INDEX.indexOf(`function ${name}(`);
  if (start > 0 && INDEX.slice(start - 6, start) === 'async ') start -= 6;
  if (start === -1) {
    const at = INDEX.indexOf(`const ${name} = `);
    assert.notEqual(at, -1, `${name} is declared in the built page`);
    return INDEX.slice(at, INDEX.indexOf(';', at) + 1);
  }
  let from = INDEX.indexOf('(', start);
  for (let paren = 0; from < INDEX.length; from++) {
    if (INDEX[from] === '(') paren++;
    else if (INDEX[from] === ')' && --paren === 0) break;
  }
  let depth = 0;
  for (let i = INDEX.indexOf('{', from); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  return assert.fail(`${name} never closes`);
}

/** The coverage helpers every test here needs, with this browser's record. */
const COVERAGE = ['SCAN_COVERAGE_STORE', 'readCoverageBook', 'coverageFor', 'coverageChange', 'ignorePatternTest', 'coverageRules', 'coverageExplains'];

function load<T>(names: string[], deps: Record<string, unknown>, returns: string, prelude = ''): T {
  const keys = Object.keys(deps);
  const src = `'use strict'; ${prelude}\n${[...COVERAGE, ...names].map(decl).join('\n')}\nreturn ${returns};`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...keys, src)(...keys.map((k) => deps[k])) as T;
}

/** A browser whose coverage record holds `records` for /c. */
function browserWith(records: Array<{ snap: string; patterns: string[] }>) {
  const store = new Map<string, string>([
    ['tm-scan-coverage', JSON.stringify({ '/c': records.map((r) => ({ snap: r.snap, family: 'walk', patterns: r.patterns })) })],
  ]);
  return { getItem: (k: string) => (store.has(k) ? store.get(k)! : null), setItem: (k: string, v: string) => { store.set(k, v); } };
}

const SYSTEM = { platform: process.platform, homeDir: os.homedir() };
const base = (localStorage: unknown) => ({ localStorage, state: { system: SYSTEM } });

const WIDE_GONE = { name: 'Wide folder', path: '/c/Wide folder', type: 'dir', sizeA: 5_000_000, sizeB: null, delta: -5_000_000 };
const WIDE_BACK = { name: 'Wide folder', path: '/c/Wide folder', type: 'dir', sizeA: null, sizeB: 5_000_000, delta: 5_000_000 };
const REALLY_GONE = { name: 'Old photos', path: '/c/Old photos', type: 'dir', sizeA: 2_000_000, sizeB: null, delta: -2_000_000 };

/* ── the page reads a "Don't scan" pattern exactly as the scanner does ── */

test('the page reads a "Don’t scan" pattern as the scanner does: the same answer for every case (B24)', () => {
  const pageTest = load<(p: string) => (full: string, name: string) => boolean>([], base(browserWith([])), 'ignorePatternTest');
  const home = os.homedir();
  // Every character the scanner escapes — . + ^ $ ( ) [ ] { } | — is in a
  // pattern below, each beside a path that only the UNescaped reading would
  // match ("Photos old" for "Photos (old)", "diskXiso" for "*.iso", …), so a
  // port that stopped escaping any of them disagrees with the scanner here.
  const patterns = [
    'Wide folder', '*.iso', 'node_modules', 'cache?', `${home}/Library`, '~/projects/**/dist', '/data/', 'WIDE FOLDER',
    'Photos (old)', 'Backup [2019]', 'a+b', 'x{1}', 'cost$', '^top', 'a|b', '/c/build (old)',
  ];
  const paths = [
    '/c/Wide folder', '/c/x/Wide folder', '/c/Wide folder/inner', '/c/disk.iso', '/c/disk.iso.bak', '/c/diskXiso', '/c/a/node_modules',
    '/c/cache1', '/c/cache12', `${home}/Library`, `${home}/Library/Caches`, `${home}/Libraryx`,
    `${home}/projects/a/b/dist`, `${home}/projects/dist`, `${home}/projects/a/dist/x.js`, '/data', '/data/deep/file', '/database',
    '/c/Photos (old)', '/c/Photos old', '/c/Backup [2019]', '/c/Backup 2', '/c/a+b', '/c/ab', '/c/x{1}', '/c/x',
    '/c/cost$', '/c/cost', '/c/^top', '/c/top', '/c/a|b', '/c/a', '/c/build (old)', '/c/build (old)/inner', '/c/build old',
  ];
  for (const p of patterns) {
    const server = compileIgnore(p);
    const page = pageTest(p);
    assert.ok(paths.some((full) => server.test(full, path.posix.basename(full))),
      `"${p}" matches at least one listed path for the scanner, so the page agreeing with it is not two "no"s`);
    for (const full of paths) {
      const name = path.posix.basename(full);
      assert.equal(page(full, name), server.test(full, name), `"${p}" on ${full}: the page and the scanner agree`);
    }
  }
});

/* ── Compare: an exclusion is not a deletion ── */

const RULE_ADDED = { leftOut: ['Wide folder'], before: [], after: ['Wide folder'] };

test('a Compare row left out by a new "Don’t scan" rule says so and offers no snapshot hunt; a real deletion still does (B24)', () => {
  const ls = browserWith([{ snap: 'a', patterns: RULE_ADDED.before }, { snap: 'b', patterns: RULE_ADDED.after }]);
  const row = load<(en: unknown, maxD: number, opts?: unknown) => string>(['deltaRow'], {
    ...base(ls), chipFor: () => '', escapeHtml: (s: unknown) => String(s), formatBytes: (n: number) => `${n} B`,
  }, `(en, maxD, opts) => deltaRow(en, maxD, { ...opts, rules: coverageRules(coverageFor('/c', 'a'), coverageFor('/c', 'b')) })`);

  const wide = row(WIDE_GONE, 5_000_000, { offerSnapshots: true });
  assert.match(wide, /· no longer scanned</, `the row is called what it is: ${wide}`);
  assert.doesNotMatch(wide, /removed/, 'never "removed"');
  assert.doesNotMatch(wide, /data-snap-check/, 'and no "Check snapshots" for a folder that was never deleted');

  const gone = row(REALLY_GONE, 5_000_000, { offerSnapshots: true });
  assert.match(gone, /· removed</, 'a folder no rule explains is still removed');
  assert.match(gone, /data-snap-check/, 'and keeps its way back');
});

test('a Compare row counted again once a rule was dropped is "scanned again", not new (B24)', () => {
  const ls = browserWith([{ snap: 'a', patterns: ['Wide folder'] }, { snap: 'b', patterns: [] }]);
  const row = load<(en: unknown) => string>(['deltaRow'], {
    ...base(ls), chipFor: () => '', escapeHtml: (s: unknown) => String(s), formatBytes: (n: number) => `${n} B`,
  }, `(en) => deltaRow(en, 5000000, { rules: coverageRules(coverageFor('/c', 'a'), coverageFor('/c', 'b')) })`);
  assert.match(row(WIDE_BACK), /· scanned again</);
  assert.doesNotMatch(row(WIDE_BACK), /· new</);
});

test('without a rule change — or with no record of one — Compare rows read as before (B24)', () => {
  const same = browserWith([{ snap: 'a', patterns: ['Wide folder'] }, { snap: 'b', patterns: ['Wide folder'] }]);
  const deps = { chipFor: () => '', escapeHtml: (s: unknown) => String(s), formatBytes: (n: number) => `${n} B` };
  const rules = load<unknown>([], base(same), `coverageRules(coverageFor('/c', 'a'), coverageFor('/c', 'b'))`);
  assert.equal(rules, null, 'the same rules explain nothing');
  const unknown = load<unknown>([], base(browserWith([])), `coverageRules(coverageFor('/c', 'a'), coverageFor('/c', 'b'))`);
  assert.equal(unknown, null, 'no record explains nothing: a missing folder is just missing');
  const plain = load<(en: unknown) => string>(['deltaRow'], { ...base(same), ...deps }, '(en) => deltaRow(en, 5000000, { offerSnapshots: true })');
  assert.match(plain(WIDE_GONE), /· removed</);
  assert.match(plain(WIDE_GONE), /data-snap-check/);
});

test('Compare’s header counts a rule’s exclusion apart from removals, and says the rules changed (B24)', () => {
  const ls = browserWith([{ snap: 'a', patterns: [] }, { snap: 'b', patterns: ['Wide folder'] }]);
  const els: Record<string, { innerHTML: string; querySelector: () => null; querySelectorAll: () => unknown[] }> = {};
  const $ = (id: string) => (els[id] ??= { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] });
  const render = load<(r: unknown) => void>(['renderCompare', 'cmpCountsDrop', 'deltaRow'], {
    ...base(ls), $,
    formatWhen: (t: number) => `t${t}`, formatBytes: (n: number) => `${n} B`, formatCount: String, icon: () => '',
    escapeHtml: (s: unknown) => String(s), chipFor: () => '', countUp: () => {}, fxBarsIn: () => {},
    FxCharts: { barSquares: () => ({ destroy() {} }) }, initCmpSplit: () => {}, wireSnapshotActions: () => {},
  }, '(r) => renderCompare({ ...r, rules: coverageRules(coverageFor("/c", "a"), coverageFor("/c", "b")) })',
  'let cmpSplit = null; let cmpCountsHandle = null;');
  render({ entries: [WIDE_GONE, REALLY_GONE], totalDelta: -7_000_000, truncated: false, deep: true, whenA: 1, whenB: 2 });
  const html = els.cmpBody!.innerHTML;
  assert.match(html, /data-n="1">1<\/span> removed/, `only the real deletion is counted as removed: ${html}`);
  assert.match(html, /1 changed by your “Don’t scan” rules/, 'the excluded folder is counted as what it is');
  assert.match(html, /Your “Don’t scan” rules changed between these two scans/, 'and the change is stated');
  assert.equal((html.match(/data-snap-check/g) ?? []).length, 1, 'one snapshot hunt: for the real deletion only');
});

test('Compare finds a live scan’s rules under its scan id and a snapshot’s under its own (B24)', () => {
  const ls = browserWith([{ snap: 'scan:s1', patterns: [] }, { snap: 'scan:s2', patterns: ['Wide folder'] }, { snap: 'p', patterns: ['x'] }]);
  const of = load<(o: unknown) => unknown>(['cmpCoverage'], base(ls), 'cmpCoverage');
  assert.deepEqual(of({ kind: 'scan', id: 's2', rootPath: '/c' }), { family: 'walk', patterns: ['Wide folder'] });
  assert.deepEqual(of({ kind: 'snap', id: 'p', rootPath: '/c' }), { family: 'walk', patterns: ['x'] });
  assert.equal(of({ kind: 'snap', id: 's2', rootPath: '/c' }), null, 'a scan id is not a snapshot id');
});

test('the Compare button reads both picks\u2019 rules and hands them to the render, for scans and snapshots alike (B24)', () => {
  const start = INDEX.indexOf("$('cmpRunBtn').addEventListener('click'");
  assert.notEqual(start, -1, 'the Compare button is wired');
  const handler = INDEX.slice(start, INDEX.indexOf('/* ── §7.4', start));
  assert.match(handler, /const rules = coverageRules\(cmpCoverage\(a\), cmpCoverage\(b\)\);/, 'the two picks\u2019 rules, A before B');
  assert.equal((handler.match(/renderCompare\(\{[^}]*, rules \}\)/g) ?? []).length, 2, 'both the live-scan and the snapshot render get them');
});

/* ── Trends ── */

const SNAPS = ['s1', 's2', 's3', 's4', 's5'].map((id, i) => ({ id, rootPath: '/c', takenAt: (i + 1) * 100, totalSize: [100, 95, 100, 110, 130][i] }));
const ON_OFF = browserWith([
  { snap: 's1', patterns: [] }, { snap: 's2', patterns: ['Wide folder'] }, { snap: 's3', patterns: [] },
  { snap: 's4', patterns: [] }, { snap: 's5', patterns: [] },
]);

test('Trends’ net-change strip draws no step across a change of "Don’t scan" rules (B24)', () => {
  const drawn: { spec: { points: unknown[] } | null } = { spec: null };
  const wrap = { hidden: true };
  const draw = load<() => void>(['drawTrendNet', 'trendNetPoints', 'trendSameCounting'], {
    ...base(ON_OFF),
    state: { system: SYSTEM, trends: { snapshots: SNAPS } },
    $: (id: string) => (id === 'trendNet' ? wrap : {}),
    FxCharts: { profitLine: (_el: unknown, spec: { points: unknown[] }) => { drawn.spec = spec; return { update() {}, destroy() {} }; } },
  }, 'drawTrendNet', 'let trendNetHandle = null;');
  draw();
  assert.ok(drawn.spec, 'the strip is drawn');
  assert.deepEqual(drawn.spec.points, [{ t: 400, v: 10 }, { t: 500, v: 20 }],
    'the −5 and +5 of the rule going on and off are not growth or space freed');
});

test('Trends’ last-change list says a folder is scanned again, not new, and why (B24)', async () => {
  const host = { innerHTML: '' };
  const render = load<() => Promise<void>>(['renderTrendDeltas', 'deltaRow'], {
    ...base(ON_OFF),
    state: { system: SYSTEM, trends: { snapshots: SNAPS.slice(0, 3), path: '/c' } },
    $: () => host,
    api: async () => ({ totalDelta: 5_000_000, entries: [WIDE_BACK] }),
    formatDate: (t: number) => `d${t}`, formatBytes: (n: number) => `${n} B`, escapeHtml: (s: unknown) => String(s), chipFor: () => '',
    FxNum: { rollHtml: (el: { innerHTML: string }, html: string) => { el.innerHTML = html; } }, fxBarsIn: () => {},
  }, 'renderTrendDeltas');
  await render();
  assert.match(host.innerHTML, /· scanned again</, `the row: ${host.innerHTML}`);
  assert.match(host.innerHTML, /your “Don’t scan” rules changed/, 'and the head says why the total moved');
});

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
  // "WIDE FOLDER" has a path spelled its own way: the scanner folds case on
  // macOS and Windows but not on Linux, so on Linux "/c/Wide folder" is no
  // match for it, and the page must agree on both spellings everywhere.
  const patterns = [
    'Wide folder', '*.iso', 'node_modules', 'cache?', `${home}/Library`, '~/projects/**/dist', '/data/', 'WIDE FOLDER',
    'Photos (old)', 'Backup [2019]', 'a+b', 'x{1}', 'cost$', '^top', 'a|b', '/c/build (old)',
  ];
  const paths = [
    '/c/Wide folder', '/c/WIDE FOLDER', '/c/x/Wide folder', '/c/Wide folder/inner', '/c/disk.iso', '/c/disk.iso.bak', '/c/diskXiso', '/c/a/node_modules',
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
  const render = load<(r: unknown) => void>(['renderCompare', 'cmpWhenPair', 'cmpCountsDrop', 'deltaRow'], {
    ...base(ls), $,
    formatWhen: (t: number) => `t${t}`, formatWhenSeconds: (t: number) => `t${t}s`, formatBytes: (n: number) => `${n} B`, formatCount: String, icon: () => '',
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

test('Trends’ last-change line says the total did not change when it did not — not "grew by 0 B" in the growth colour (QA C07)', async () => {
  const head = async (totalDelta: number) => {
    const host = { innerHTML: '' };
    const render = load<() => Promise<void>>(['renderTrendDeltas', 'deltaRow'], {
      ...base(ON_OFF),
      state: { system: SYSTEM, trends: { snapshots: SNAPS.slice(2), path: '/c' } }, // s4 → s5: the same rules
      $: () => host,
      api: async () => ({ totalDelta, entries: [] }),
      formatDate: (t: number) => `d${t}`, formatBytes: (n: number) => `${n} B`, escapeHtml: (s: unknown) => String(s), chipFor: () => '',
      FxNum: { rollHtml: (el: { innerHTML: string }, html: string) => { el.innerHTML = html; } }, fxBarsIn: () => {},
    }, 'renderTrendDeltas');
    await render();
    return host.innerHTML;
  };
  const still = await head(0);
  assert.match(still, /total did not change/, `nothing changed, and it says so: ${still}`);
  assert.doesNotMatch(still, /grew|shrank|#ff6b61|var\(--ok\)/, 'no growth (or shrink) word or colour for a change of nothing');
  // Controls: a real change keeps its word, amount and colour.
  const grew = await head(5_000_000);
  assert.match(grew, /total grew by\s*<b class="num" style="color:#ff6b61">5000000 B<\/b>/, `growth: ${grew}`);
  const shrank = await head(-3_000_000);
  assert.match(shrank, /total shrank by\s*<b class="num" style="color:var\(--ok\)">3000000 B<\/b>/, `shrink: ${shrank}`);
});

test('Compare says the total did not change when it did not — not "Total grew by 0 B" in the growth colour (C07 review F1.2, F1.10)', () => {
  // The C07 wording reached Trends but not History › Compare: two scans of an
  // unchanged folder, or a pair whose growth and shrinkage cancel, read
  // "Total grew by 0 B" in red above "No differences — nothing changed".
  const same = browserWith([{ snap: 'a', patterns: [] }, { snap: 'b', patterns: [] }]);
  const head = (totalDelta: number, entries: unknown[]) => {
    type Body = { innerHTML: string; querySelector: (sel: string) => unknown; querySelectorAll: () => unknown[] };
    const els: Record<string, Body> = {};
    const $ = (id: string) => (els[id] ??= {
      innerHTML: '', querySelectorAll: () => [],
      // the figure the total rolls in, when the card has one
      querySelector: (sel: string) => (sel === '.cmp-total' && els[id].innerHTML.includes('class="cmp-total"') ? { figure: true } : null),
    });
    const rolled: number[] = [];
    const render = load<(r: unknown) => void>(['renderCompare', 'cmpWhenPair', 'cmpCountsDrop', 'deltaRow'], {
      ...base(same), $,
      formatWhen: (t: number) => `t${t}`, formatWhenSeconds: (t: number) => `t${t}s`, formatBytes: (n: number) => `${n} B`, formatCount: String, icon: () => '',
      escapeHtml: (s: unknown) => String(s), chipFor: () => '', fxBarsIn: () => {},
      // the page's countUp reads el.dataset: handed no element, it throws
      countUp: (el: unknown, n: number) => { assert.ok(el, 'countUp is handed an element to roll'); rolled.push(n); },
      FxCharts: { barSquares: () => ({ destroy() {} }) }, initCmpSplit: () => {}, wireSnapshotActions: () => {},
    }, '(r) => renderCompare(r)', 'let cmpSplit = null; let cmpCountsHandle = null;');
    render({ entries, totalDelta, truncated: false, deep: true, whenA: 1, whenB: 2 });
    const html = els.cmpBody!.innerHTML;
    const at = html.indexOf('Total ');
    return { html, line: html.slice(at, html.indexOf('&nbsp;', at)).trim(), rolled };
  };
  const unchanged = head(0, []);
  assert.equal(unchanged.line, 'Total did not change', `nothing changed, and it says so: ${unchanged.line}`);
  assert.match(unchanged.html, /No differences/, 'control: the card says there are no differences');
  assert.deepEqual(unchanged.rolled, [], 'no amount is rolled for a total that did not move');
  const cancelling = head(0, [
    { name: 'A', path: '/c/A', type: 'dir', sizeA: 10, sizeB: 20, delta: 10 },
    { name: 'B', path: '/c/B', type: 'dir', sizeA: 20, sizeB: 10, delta: -10 },
  ]);
  assert.equal(cancelling.line, 'Total did not change', `growth and shrinkage that cancel: ${cancelling.line}`);
  assert.doesNotMatch(unchanged.line + cancelling.line, /grew|shrank|#ff6b61|var\(--ok\)/, 'no growth (or shrink) word or colour for a change of nothing');
  // Controls: a real change keeps its word, amount, colour and roll.
  const grew = head(5_000_000, []);
  assert.match(grew.line, /^Total grew by\s*<b class="cmp-total" style="color:#ff6b61">5000000 B<\/b>$/, `growth: ${grew.line}`);
  assert.deepEqual(grew.rolled, [5_000_000], 'control: a total that moved rolls its amount');
  const shrank = head(-3_000_000, []);
  assert.match(shrank.line, /^Total shrank by\s*<b class="cmp-total" style="color:var\(--ok\)">3000000 B<\/b>$/, `shrink: ${shrank.line}`);
});

/* ── QA fourth pass E08: Trends tells its folders apart, and two scans of one day by their times ── */

test('Trends’ Folder list leads each folder with its own name — corpus and corpus/Mail no longer read alike (QA fourth pass E08)', async () => {
  // QA fourth pass E08 (shots/066): the 430 px select showed each folder's
  // full path from the left, so corpus and corpus/Mail both read
  // "/Users/<user>/.claude/projects/-Users-…-Desktop" — C08 fixed the same
  // thing in Compare by leading with the folder's name.
  const DEEP = '/Users/me/.claude/projects/-Users-me-Desktop-Claude-Code/treemap-work/qa/corpus';
  const listed = async (rootPaths: string[]) => {
    const sel = { innerHTML: '', disabled: false, title: '' };
    const run = load<() => Promise<void>>(['escapeHtml', 'loadTrends'], {
      ...base(browserWith([])),
      state: { root: null, trends: { path: null, roots: [], snapshots: [] } },
      api: async (url: string) => { assert.equal(url, '/api/snapshots'); return { roots: rootPaths.map((rootPath, i) => ({ rootPath, count: i + 2 })) }; },
      $: (id: string) => (id === 'trendRoot' ? sel : { textContent: '', innerHTML: '' }),
      loadTrendData: async () => {}, drawTrendChart: () => {}, drawTrendNet: () => {}, toast: (m: string) => assert.fail(m),
    }, 'loadTrends');
    await run();
    const options = [...sel.innerHTML.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
      .map((m) => ({ value: m[1], text: m[2].replace(/&amp;/g, '&').replace(/&#39;/g, "'") }));
    assert.equal(options.length, rootPaths.length, `one option per folder: ${sel.innerHTML}`);
    return { options, sel };
  };
  const { options, sel } = await listed([DEEP, `${DEEP}/Mail`]);
  assert.deepEqual(options.map((o) => o.text.split(' · ')[0]), ['corpus', 'Mail'], `each option leads with its folder's name: ${options.map((o) => o.text).join(' | ')}`);
  assert.deepEqual(options.map((o) => o.text.split(' · ')[1]), ['2 snapshots', '3 snapshots'], 'then how many snapshots it has');
  for (const o of options) assert.ok(o.text.endsWith(o.value), `and the whole path last, for the open list: ${o.text}`);
  // A closed select shows the start of the option: the two must differ there.
  assert.notEqual(options[0].text.slice(0, 12), options[1].text.slice(0, 12), 'the two read differently from their first characters');
  assert.equal(sel.title, DEEP, 'the closed list names the whole path of the folder it shows on hover');
  // Two folders of one name lead with as much of their paths as tells them apart.
  const twins = (await listed(['/Volumes/A/Mail', '/Users/me/Mail', '/Users/me/Documents'])).options.map((o) => o.text.split(' · ')[0]);
  assert.deepEqual(twins, ['A/Mail', 'me/Mail', 'Documents'], `twins: ${twins.join(' | ')}`);
  // A drive's root has no name of its own beyond itself.
  assert.deepEqual((await listed(['/'])).options.map((o) => o.text.split(' · ')[0]), ['/'], 'the root of a drive is named as it is');
});

test('Trends’ "Since previous scan" names two scans of one day by their times, to the second in one minute (QA fourth pass E08)', async () => {
  // QA fourth pass E08: "Oct 13, 2026 → Oct 13, 2026".
  const FORMATS = ['UI_LOCALE', 'HOUR_CYCLE', 'CLOCK_HOUR', 'DATE_FMT', 'dateMemo', 'formatDate', 'WHEN_FMT', 'whenMemo', 'formatWhen',
    'WHEN_SEC_FMT', 'formatWhenSeconds', 'cmpWhenPair'];
  const fmt = load<{ formatDate: (t: number) => string; formatWhen: (t: number) => string; formatWhenSeconds: (t: number) => string }>(
    FORMATS, base(browserWith([])), '{ formatDate, formatWhen, formatWhenSeconds }');
  const headFor = async (a: number, b: number) => {
    const host = { innerHTML: '' };
    const render = load<() => Promise<void>>([...FORMATS, 'renderTrendDeltas', 'deltaRow'], {
      ...base(browserWith([])),
      state: { system: SYSTEM, trends: { snapshots: [{ id: 'a', rootPath: '/c', takenAt: a }, { id: 'b', rootPath: '/c', takenAt: b }], path: '/c' } },
      $: () => host,
      api: async () => ({ totalDelta: 5_000_000, entries: [] }),
      formatBytes: (n: number) => `${n} B`, chipFor: () => '',
      FxNum: { rollHtml: (el: { innerHTML: string }, html: string) => { el.innerHTML = html; } }, fxBarsIn: () => {},
    }, 'renderTrendDeltas', "const escapeHtml = (s) => String(s);");
    await render();
    const m = /^<div class="muted"[^>]*>([^<]*?) — total/.exec(host.innerHTML);
    assert.ok(m, `the head names the two scans: ${host.innerHTML}`);
    return m![1];
  };
  const at = (d: number, h: number, mi: number, s: number) => new Date(2026, 9, d, h, mi, s).getTime();
  // One day, minutes apart: the times say which is which.
  const day = await headFor(at(13, 19, 25, 28), at(13, 19, 26, 2));
  assert.equal(day, `${fmt.formatWhen(at(13, 19, 25, 28))} → ${fmt.formatWhen(at(13, 19, 26, 2))}`, `one day: ${day}`);
  assert.notEqual(fmt.formatWhen(at(13, 19, 25, 28)), fmt.formatWhen(at(13, 19, 26, 2)), 'control: the two read differently');
  // One minute: to the second.
  const minute = await headFor(at(13, 19, 26, 2), at(13, 19, 26, 10));
  assert.equal(minute, `${fmt.formatWhenSeconds(at(13, 19, 26, 2))} → ${fmt.formatWhenSeconds(at(13, 19, 26, 10))}`, `one minute: ${minute}`);
  // Different days keep their dates, as before.
  const days = await headFor(at(2, 9, 0, 0), at(13, 19, 26, 2));
  assert.equal(days, `${fmt.formatDate(at(2, 9, 0, 0))} → ${fmt.formatDate(at(13, 19, 26, 2))}`, `two days: ${days}`);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarize, compareToBaseline, describeBudget, printTable, readResult, recordOrRefuse, recordRefusal, writeResult, baselineFileName, recordBaseline, PRE_GOVERNOR_BUDGET, REQUESTED_BUDGETS, type BenchResult, type BenchRun, type StoredResult } from '../bench/lib/report';
import { checkScanAgainstManifest, checkDuplicatesAgainstManifest } from '../bench/lib/verify';

function run(wallMs: number, cpuSeconds = 0.5, entries = 200_000, extra: Partial<BenchRun> = {}): BenchRun {
  return { wallMs, entries, cpuSeconds, selfCpuSeconds: cpuSeconds, childCpuSeconds: 0, peakRssBytes: 100_000_000, bytesRead: 1_000, bytesReadReason: 'test', persistMs: 0, persistCpuSeconds: 0, loadAvg: [1, 1, 1], ...extra };
}

test('the summary is the median wall clock, entries per second from it, and CPU seconds per million entries', () => {
  const s = summarize([run(1100), run(900), run(1000)]);
  assert.equal(s.wallMsMedian, 1000);
  assert.equal(s.entriesPerSecond, 200_000);
  assert.equal(s.cpuSecondsPerMillion, 2.5);
  assert.equal(s.peakRssBytes, 100_000_000);
  assert.equal(s.bytesReadMedian, 1_000);
  assert.equal(s.spreadPct, 20);
  assert.equal(s.reproducible, false, 'a 20% spread is not reproducible');
});

test('three runs inside five percent of each other are reproducible', () => {
  const s = summarize([run(1000), run(1010), run(1020)]);
  assert.ok(s.spreadPct < 5);
  assert.equal(s.reproducible, true);
});

test('bytes read is null when any run could not measure it', () => {
  const s = summarize([run(1000, 0.5, 200_000, { bytesRead: null }), run(1000)]);
  assert.equal(s.bytesReadMedian, null);
});

function result(wallMsMedian: number, resolutionPct: number): BenchResult {
  const r = run(wallMsMedian);
  return {
    suite: 'enumerate',
    corpus: { name: 'enum200k', params: {}, scale: 'full' },
    engine: 'walker',
    engineDescription: 'the Node walker',
    entriesUnit: 'entries',
    machine: { cpuModel: 'x', cores: 8, perfCores: null, effCores: null, memoryBytes: 1, platform: 'darwin', arch: 'arm64', osRelease: '1', node: 'v1', commit: 'abc1234', dirty: false, loadAvg: [1, 1, 1], maxVnodes: null, tier: 'B', tierReason: 'test' },
    cache: { state: 'warm', reason: 'test' },
    budget: { requested: 'turbo', effective: ['turbo', 'turbo', 'turbo'] },
    runs: [r, r, r],
    summary: { ...summarize([r, r, r]), resolutionPct },
    correctness: { ok: true, notes: [] },
    recordedAt: '2026-09-18T00:00:00.000Z',
    commit: 'abc1234',
    label: 'test',
  };
}

/** A result as every Phase 1 baseline was written: before the governor existed, with no budget field at all. */
function preGovernor(r: BenchResult): StoredResult {
  const { budget: _dropped, ...rest } = r;
  return rest;
}

test('fifteen percent slower with a two percent band is a regression', () => {
  const v = compareToBaseline(result(1150, 2), result(1000, 2));
  assert.equal(v.verdict, 'FAIL');
  assert.equal(Math.round(v.deltaPct), 15);
  assert.match(v.sentence, /slower/);
});

test('one percent slower inside two combined two-percent bands is inconclusive, and says at what resolution', () => {
  const v = compareToBaseline(result(1010, 2), result(1000, 2));
  assert.equal(v.verdict, 'INCONCLUSIVE');
  assert.match(v.sentence, /2\.8% combined resolution/);
});

test('twenty percent faster passes', () => {
  const v = compareToBaseline(result(800, 2), result(1000, 2));
  assert.equal(v.verdict, 'PASS');
  assert.equal(Math.round(v.deltaPct), -20);
});

test('five percent slower outside the band but under the ten percent gate passes with the number stated', () => {
  const v = compareToBaseline(result(1050, 1), result(1000, 1));
  assert.equal(v.verdict, 'PASS');
  assert.match(v.sentence, /5\.0% slower/);
});

test('a scan whose file count is off by one fails the manifest check and names the field', () => {
  const manifest = { dirs: 10, files: 90, logicalBytes: 12_345 };
  const bad = checkScanAgainstManifest(manifest, { fileCount: 89, dirCount: 10, rootSize: 12_345, scanned: 99 });
  assert.equal(bad.ok, false);
  assert.ok(bad.notes.some((n) => /fileCount/.test(n) && /89/.test(n) && /90/.test(n)), bad.notes.join('\n'));
  const good = checkScanAgainstManifest(manifest, { fileCount: 90, dirCount: 10, rootSize: 12_345, scanned: 100 });
  assert.equal(good.ok, true);
  assert.deepEqual(good.notes, []);
});

test('a scan whose bytes disagree with the manifest fails and states both totals', () => {
  const bad = checkScanAgainstManifest({ dirs: 1, files: 1, logicalBytes: 1000 }, { fileCount: 1, dirCount: 1, rootSize: 999, scanned: 2 });
  assert.equal(bad.ok, false);
  assert.ok(bad.notes.some((n) => /logicalBytes/.test(n) && /999/.test(n) && /1,000/.test(n)), bad.notes.join('\n'));
});

test('planted duplicate groups all reported gives recall 1, and a reported group of unequal bytes is a false positive named by path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-verify-'));
  try {
    const a1 = path.join(dir, 'a1'), a2 = path.join(dir, 'a2'), b1 = path.join(dir, 'b1'), b2 = path.join(dir, 'b2');
    fs.writeFileSync(a1, Buffer.alloc(4096, 1));
    fs.writeFileSync(a2, Buffer.alloc(4096, 1));
    fs.writeFileSync(b1, Buffer.alloc(4096, 2));
    fs.writeFileSync(b2, Buffer.alloc(4096, 3)); // same size as b1, different bytes
    const manifest = { root: dir, duplicateGroups: [{ content: 7, size: 4096, paths: [a1, a2] }] };
    const perfect = checkDuplicatesAgainstManifest(manifest, [{ size: 4096, files: [{ path: a1 }, { path: a2 }] }], 1024);
    assert.equal(perfect.ok, true);
    assert.equal(perfect.recall, 1);
    assert.equal(perfect.precision, 1);
    const lying = checkDuplicatesAgainstManifest(manifest, [
      { size: 4096, files: [{ path: a1 }, { path: a2 }] },
      { size: 4096, files: [{ path: b1 }, { path: b2 }] },
    ], 1024);
    assert.equal(lying.ok, false);
    assert.ok(lying.precision < 1);
    assert.equal(lying.falsePositives, 1);
    assert.ok(lying.notes.some((n) => n.includes('b1') && n.includes('b2')), lying.notes.join('\n'));
    const missing = checkDuplicatesAgainstManifest(manifest, [], 1024);
    assert.equal(missing.recall, 0);
    assert.equal(missing.missedGroups, 1);
    assert.equal(missing.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('planted groups under the minimum size are not expected', () => {
  const manifest = { root: os.tmpdir(), duplicateGroups: [{ content: 1, size: 512, paths: ['/x/1', '/x/2'] }] };
  const r = checkDuplicatesAgainstManifest(manifest, [], 1024);
  assert.equal(r.ok, true);
  assert.equal(r.recall, 1, 'nothing was expected, so nothing was missed');
});

test('a single run is never reproducible and has no resolution', () => {
  const s = summarize([run(1000)]);
  assert.equal(s.reproducible, false);
  assert.equal(Number.isFinite(s.spreadPct), false);
  assert.equal(Number.isFinite(s.resolutionPct), false);
});

test('a result with one run survives the trip through JSON without gaining a resolution it never had', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-report-'));
  try {
    const r = result(1000, Number.POSITIVE_INFINITY);
    r.runs = [run(1000)];
    r.budget = { requested: 'turbo', effective: ['turbo'] };
    r.summary = summarize(r.runs);
    const file = writeResult(r, dir, 'one.json');
    const back = readResult(file);
    assert.equal(back.summary.resolutionPct, Number.POSITIVE_INFINITY);
    assert.equal(back.summary.spreadPct, Number.POSITIVE_INFINITY);
    assert.equal(back.summary.reproducible, false);
    const v = compareToBaseline(result(800, 2), back);
    assert.equal(v.verdict, 'NOT COMPARABLE', 'a single run is not reproducible, so it cannot be a baseline');
    assert.match(v.sentence, /single run|not reproducible/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--record refuses a single-run series in words, never as an infinite spread', () => {
  // summarize() gives one run an Infinity spread, and the near-duplicate
  // suite runs once by default: this is the refusal its --record prints.
  const one = result(1000, Number.POSITIVE_INFINITY);
  one.runs = [run(1000)];
  one.budget = { requested: 'turbo', effective: ['turbo'] };
  one.summary = summarize(one.runs);
  assert.equal(recordRefusal(one), 'its runs spread over a single run (the rule is under 5%)');
  assert.equal(compareToBaseline(result(1000, 2), one).sentence, 'the baseline is not reproducible (a single run against the 5% rule)');
  assert.equal(compareToBaseline(one, result(1000, 2)).sentence, 'the current result is not reproducible (a single run against the 5% rule)');
});

test('a two-run result is compared in words that count its runs: it takes three to resolve anything', () => {
  // A single run is refused before this, as not reproducible, so the only
  // result with no resolution that reaches it has two runs.
  const two = result(1000, 2);
  two.runs = [run(1000), run(1010)];
  two.budget = { requested: 'turbo', effective: ['turbo', 'turbo'] };
  two.summary = summarize(two.runs);
  assert.equal(two.summary.reproducible, true);
  assert.equal(two.summary.resolutionPct, Number.POSITIVE_INFINITY);
  const current = compareToBaseline(two, result(1000, 2));
  assert.equal(current.verdict, 'INCONCLUSIVE');
  assert.equal(current.sentence, '+0.5% (1000.0 ms → 1005.0 ms), but the current result has 2 runs, too few for a resolution (it takes at least three)');
  const baseline = compareToBaseline(result(1000, 2), two);
  assert.equal(baseline.sentence, '-0.5% (1005.0 ms → 1000.0 ms), but the baseline has 2 runs, too few for a resolution (it takes at least three)');
  const both = compareToBaseline(two, two);
  assert.equal(both.sentence, '+0.0% (1005.0 ms → 1005.0 ms), but the current result has 2 runs and the baseline 2, too few for a resolution (it takes at least three)', 'both sides are named when neither resolves');
});

test('the budget line says what was asked, what each run ran under, and what moved; a result from before the governor says so', () => {
  assert.equal(describeBudget(result(1000, 2)), 'turbo requested, ran under turbo/turbo/turbo');
  const moved = result(1000, 2);
  moved.budget = { requested: 'balanced', effective: ['eco', 'balanced', 'turbo'] };
  const refusal = recordRefusal(moved) ?? '';
  assert.ok(refusal.startsWith('its budget moved: '), refusal);
  assert.equal(describeBudget(moved), `balanced requested, ran under eco/balanced/turbo — moved: ${refusal.slice('its budget moved: '.length)}`);
  assert.equal(describeBudget(preGovernor(result(1000, 2))), PRE_GOVERNOR_BUDGET);
  assert.equal(PRE_GOVERNOR_BUDGET, 'none (recorded before the governor)');
});

test('--record writes a recordable result as its baseline, and refuses, writing nothing, one that is not or one that conflicts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-record-'));
  try {
    const good = result(1000, 2);
    const written = recordOrRefuse(good, dir);
    assert.deepEqual(written, { recorded: path.join(dir, baselineFileName(good)) });
    assert.equal(readResult(path.join(dir, baselineFileName(good))).summary.wallMsMedian, 1000);

    const one = result(1000, Number.POSITIVE_INFINITY);
    one.runs = [run(1000)];
    one.budget = { requested: 'turbo', effective: ['turbo'] };
    one.summary = summarize(one.runs);
    assert.deepEqual(recordOrRefuse(one, dir), { refused: 'its runs spread over a single run (the rule is under 5%)' });

    // The same file name under another condition: refused, the baseline there untouched.
    const cold = result(900, 2);
    cold.cache = { state: 'cold', reason: 'test' };
    const conflict = recordOrRefuse(cold, dir);
    assert.ok('refused' in conflict && conflict.refused.startsWith(`refusing to replace ${path.join(dir, baselineFileName(good))}`), JSON.stringify(conflict));
    assert.equal(readResult(path.join(dir, baselineFileName(good))).summary.wallMsMedian, 1000, 'the baseline there is untouched');
    assert.deepEqual(fs.readdirSync(dir), [baselineFileName(good)]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--record lets every failure but a refusal through: a baseline folder that is a file throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-record-'));
  try {
    const notAFolder = path.join(dir, 'baselines');
    fs.writeFileSync(notAFolder, '');
    assert.throws(() => recordOrRefuse(result(1000, 2), notAFolder), (err: NodeJS.ErrnoException) => typeof err.code === 'string' && err.code.startsWith('E'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the table says a single run has no spread instead of printing infinity', () => {
  const r = result(1000, Number.POSITIVE_INFINITY);
  r.runs = [run(1000)];
  r.summary = summarize(r.runs);
  const table = printTable([r]);
  assert.doesNotMatch(table, /Infinity/);
  assert.match(table, /1 run/);
});

test('results from different corpora, engines, tiers, platforms, suites or cache states are not comparable', () => {
  const base = result(1000, 2);
  for (const patch of [
    (r: BenchResult) => { r.corpus = { ...r.corpus, name: 'enum1m' }; },
    (r: BenchResult) => { r.engine = 'gdu-turbo'; },
    (r: BenchResult) => { r.machine = { ...r.machine, tier: 'C' }; },
    (r: BenchResult) => { r.machine = { ...r.machine, platform: 'linux' }; },
    (r: BenchResult) => { r.suite = 'duplicates'; },
    (r: BenchResult) => { r.cache = { state: 'cold', reason: 'x' }; },
  ]) {
    const cur = result(900, 2);
    patch(cur);
    const v = compareToBaseline(cur, base);
    assert.equal(v.verdict, 'NOT COMPARABLE', v.sentence);
    assert.match(v.sentence, /differ/);
  }
});

test('a result that failed correctness or is not reproducible cannot pass a comparison', () => {
  const base = result(1000, 2);
  const wrong = result(500, 2);
  wrong.correctness = { ok: false, notes: ['fileCount: the scan reported 1, the manifest planted 2'] };
  assert.equal(compareToBaseline(wrong, base).verdict, 'NOT COMPARABLE');
  const noisy = result(500, 2);
  noisy.summary = { ...noisy.summary, spreadPct: 30, reproducible: false };
  assert.equal(compareToBaseline(noisy, base).verdict, 'NOT COMPARABLE');
});

test('the comparison band combines both resolutions, so two 8% measurements cannot resolve a 10.5% difference', () => {
  const v = compareToBaseline(result(1105, 8), result(1000, 8));
  assert.equal(v.verdict, 'INCONCLUSIVE', v.sentence);
  assert.ok(v.band > 11 && v.band < 11.5, `band ${v.band}`);
});

test('readResult refuses a file that is not a well-formed result', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-report-'));
  try {
    const cases: unknown[] = [
      { hello: 1 },
      { summary: 1, runs: 1 },
      { ...result(1000, 2), summary: {} },
      { ...result(1000, 2), summary: { ...result(1000, 2).summary, wallMsMedian: '500' } },
      { ...result(1000, 2), runs: [] },
      { ...result(1000, 2), summary: { ...result(1000, 2).summary, wallMsMedian: 0 } },
      { ...result(1000, 2), summary: { ...result(1000, 2).summary, wallMsMedian: -100 } },
      { ...result(1000, 2), correctness: undefined },
    ];
    cases.forEach((c, i) => {
      const file = path.join(dir, `bad-${i}.json`);
      fs.writeFileSync(file, JSON.stringify(c));
      assert.throws(() => readResult(file), /not a bench result/, `case ${i}`);
    });
    const good = writeResult(result(1000, 2), dir, 'good.json');
    assert.equal(readResult(good).summary.wallMsMedian, 1000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a summary cannot be built from nothing, from a zero wall clock or from zero entries', () => {
  assert.throws(() => summarize([]), /no runs/);
  assert.throws(() => summarize([run(0)]), /not a measurement/);
  assert.throws(() => summarize([run(1000, 0.5, 0)]), /not a measurement/);
});

test('fewer than three runs have no resolution band', () => {
  assert.equal(Number.isFinite(summarize([run(1000), run(1010)]).resolutionPct), false);
  assert.equal(Number.isFinite(summarize([run(1000), run(1010), run(1020)]).resolutionPct), true);
});

test('the table names the unit each suite counts and prints n/a for an unmeasured load', () => {
  const r = result(1000, 2);
  r.suite = 'neardup';
  r.entriesUnit = 'images';
  r.runs = r.runs.map((x) => ({ ...x, loadAvg: null }));
  const table = printTable([r]);
  assert.match(table, /images\/s/);
  assert.match(table, /n\/a/);
});

test('a hard-link name is matched through its family, because the engine may give the bytes to either name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-verify-alias-'));
  try {
    const a1 = path.join(dir, 'a1'), a2 = path.join(dir, 'a2'), a1link = path.join(dir, 'a1link');
    fs.writeFileSync(a1, Buffer.alloc(4096, 5));
    fs.writeFileSync(a2, Buffer.alloc(4096, 5));
    fs.linkSync(a1, a1link);
    const manifest = { root: dir, duplicateGroups: [{ content: 3, size: 4096, paths: [a1, a2] }], hardlinkFamilies: [{ target: a1, links: [a1link] }] };
    // The engine listed a1link first, so a1 carries size 0 and the finder reported the link's name.
    const r = checkDuplicatesAgainstManifest(manifest, [{ size: 4096, files: [{ path: a1link }, { path: a2 }] }], 1024);
    assert.equal(r.recall, 1, r.notes.join('\n'));
    assert.equal(r.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('under a report cap, recall counts only the planted groups above the finder\'s cut, and the total count must still match', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-verify-cap-'));
  try {
    const mk = (name: string, size: number, fill: number): string => { const p = path.join(dir, name); fs.writeFileSync(p, Buffer.alloc(size, fill)); return p; };
    const big = [mk('b1', 8192, 1), mk('b2', 8192, 1)];
    const mid = [mk('m1', 4096, 2), mk('m2', 4096, 2)];
    const small = [mk('s1', 2048, 3), mk('s2', 2048, 3)];
    const manifest = { root: dir, duplicateGroups: [
      { content: 1, size: 8192, paths: big }, { content: 2, size: 4096, paths: mid }, { content: 3, size: 2048, paths: small },
    ] };
    const top2 = [{ size: 8192, files: big.map((p) => ({ path: p })) }, { size: 4096, files: mid.map((p) => ({ path: p })) }];
    const capped = checkDuplicatesAgainstManifest(manifest, top2, 1024, { groupCount: 3 });
    assert.equal(capped.truncated, true);
    assert.equal(capped.expectedGroups, 2, 'the small group sits below the cut and cannot have been reported');
    assert.equal(capped.recall, 1, capped.notes.join('\n'));
    assert.equal(capped.ok, true);
    const untruncated = checkDuplicatesAgainstManifest(manifest, top2, 1024, { groupCount: 2 });
    assert.equal(untruncated.ok, false, 'a finder that found only two of three planted groups is wrong');
    assert.ok(untruncated.notes.some((n) => /counted 2 groups in total; the corpus planted 3/.test(n)), untruncated.notes.join('\n'));
    const missingOne = checkDuplicatesAgainstManifest(manifest, top2.slice(0, 1), 1024, { groupCount: 3 });
    assert.equal(missingOne.recall, 1, 'with one reported group the cut rises to it, so only it is expected');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------ the budget ------------------------------ */

const PRE_GOVERNOR = 'none (recorded before the governor)';

test('the budget is a condition: a different preset, or a result recorded before the governor, is not comparable', () => {
  const base = result(1000, 2);
  const legacy = preGovernor(base);
  const againstLegacy = compareToBaseline(result(900, 2), legacy);
  assert.equal(againstLegacy.verdict, 'NOT COMPARABLE', againstLegacy.sentence);
  assert.equal(againstLegacy.sentence, `the two results differ in budget (turbo vs ${PRE_GOVERNOR}), so their wall clocks measure different things`);
  const legacyAgainst = compareToBaseline(preGovernor(result(900, 2)), base);
  assert.equal(legacyAgainst.verdict, 'NOT COMPARABLE', legacyAgainst.sentence);
  assert.match(legacyAgainst.sentence, /budget \(none \(recorded before the governor\) vs turbo\)/);
  const eco = result(900, 2);
  eco.budget = { requested: 'eco', effective: ['eco', 'eco', 'eco'] };
  const presets = compareToBaseline(eco, base);
  assert.equal(presets.verdict, 'NOT COMPARABLE', presets.sentence);
  assert.match(presets.sentence, /budget \(eco vs turbo\)/);
  assert.equal(compareToBaseline(result(900, 2), base).verdict, 'PASS', 'the same preset leaves the verdict to the numbers');
  assert.equal(compareToBaseline(preGovernor(result(900, 2)), legacy).verdict, 'PASS', 'two results from before the governor still compare with each other');
});

test('every committed baseline still reads, and one recorded before the governor is not comparable with the same result under a budget', () => {
  const dir = path.join(__dirname, '..', 'bench', 'baselines');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'the baselines directory is not empty');
  for (const f of files) {
    const baseline = readResult(path.join(dir, f));
    if (baseline.budget !== undefined) continue; // recorded under a budget: the tests above cover those
    const budgeted: StoredResult = { ...baseline, budget: { requested: 'turbo', effective: baseline.runs.map(() => 'turbo') } };
    const v = compareToBaseline(budgeted, baseline);
    assert.equal(v.verdict, 'NOT COMPARABLE', `${f}: ${v.sentence}`);
    assert.equal(v.sentence, `the two results differ in budget (turbo vs ${PRE_GOVERNOR}), so their wall clocks measure different things`, f);
  }
});

test('--record refuses a series whose budget moved, naming the runs and presets, as it refuses a wide spread', () => {
  assert.equal(recordRefusal(result(1000, 2)), null, 'a correct, reproducible, budget-steady result from a clean tree is recordable');

  const eco = result(1000, 2);
  eco.budget = { requested: 'eco', effective: ['eco', 'balanced', 'eco'] };
  const ecoRefusal = recordRefusal(eco) ?? '';
  assert.match(ecoRefusal, /^its budget moved: eco was requested but run 2 ran under balanced /);
  assert.match(ecoRefusal, /scales Eco and Balanced back while someone is using the computer/, 'Eco and Balanced are interaction-scaled, and the refusal says so');

  const two = result(1000, 2);
  two.budget = { requested: 'balanced', effective: ['eco', 'balanced', 'turbo'] };
  assert.match(recordRefusal(two) ?? '', /balanced was requested but run 1 ran under eco and run 3 under turbo /);

  const turbo = result(1000, 2);
  turbo.budget = { requested: 'turbo', effective: ['balanced', 'balanced', 'turbo'] };
  const turboRefusal = recordRefusal(turbo) ?? '';
  assert.match(turboRefusal, /^its budget moved: turbo was requested but runs 1 and 2 ran under balanced /);
  assert.match(turboRefusal, /never scales Turbo back for interaction/, 'Turbo is not interaction-scaled, and the refusal says so');
  assert.doesNotMatch(turboRefusal, /Eco and Balanced/);

  const auto = result(1000, 2);
  auto.budget = { requested: 'auto', effective: ['balanced', 'eco', 'balanced'] };
  assert.match(recordRefusal(auto) ?? '', /^its budget moved: the app's default \(Automatic\) ran under balanced in runs 1 and 3 and eco in run 2 /);
  const steadyAuto = result(1000, 2);
  steadyAuto.budget = { requested: 'auto', effective: ['balanced', 'balanced', 'balanced'] };
  assert.equal(recordRefusal(steadyAuto), null, 'Automatic that resolved the same way in every run is one condition');

  const movedOnDirtyTree = result(1000, 2);
  movedOnDirtyTree.budget = { requested: 'eco', effective: ['eco', 'balanced', 'eco'] };
  movedOnDirtyTree.machine = { ...movedOnDirtyTree.machine, dirty: true };
  assert.match(recordRefusal(movedOnDirtyTree) ?? '', /^its budget moved/, 'the budget is judged with the spread, before the tree');

  // The refusals that were already there keep their words and their order.
  const wrong = result(1000, 2);
  wrong.correctness = { ok: false, notes: ['fileCount: the scan reported 1, the manifest planted 2'] };
  assert.equal(recordRefusal(wrong), 'it failed its correctness check');
  const noisy = result(1000, 2);
  noisy.summary = { ...noisy.summary, spreadPct: 7.5, reproducible: false };
  assert.equal(recordRefusal(noisy), 'its runs spread 7.5% (the rule is under 5%)');
  const dirty = result(1000, 2);
  dirty.machine = { ...dirty.machine, dirty: true };
  assert.equal(recordRefusal(dirty), 'the working tree had uncommitted changes, so the commit it cites is not the code measured');
});

test('a result whose budget moved cannot pass a comparison, and the sentence names the side and the runs', () => {
  const base = result(1000, 2);
  const moved = result(900, 2);
  moved.budget = { requested: 'turbo', effective: ['turbo', 'balanced', 'turbo'] };
  const current = compareToBaseline(moved, base);
  assert.equal(current.verdict, 'NOT COMPARABLE', current.sentence);
  assert.match(current.sentence, /^the current result's budget moved: turbo was requested but run 2 ran under balanced /);
  const baseline = compareToBaseline(result(900, 2), moved);
  assert.equal(baseline.verdict, 'NOT COMPARABLE', baseline.sentence);
  assert.match(baseline.sentence, /^the baseline's budget moved: /);
});

test('readResult validates a budget field by field, and reads a result without one as recorded before the governor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-report-budget-'));
  try {
    const cases: unknown[] = [
      { ...result(1000, 2), budget: 'turbo' },
      { ...result(1000, 2), budget: { requested: 'fast', effective: ['turbo', 'turbo', 'turbo'] } },
      { ...result(1000, 2), budget: { requested: 'turbo', effective: 'turbo' } },
      { ...result(1000, 2), budget: { requested: 'turbo', effective: ['turbo'] } },
      { ...result(1000, 2), budget: { requested: 'turbo', effective: ['turbo', 3, 'turbo'] } },
    ];
    cases.forEach((c, i) => {
      const file = path.join(dir, `bad-budget-${i}.json`);
      fs.writeFileSync(file, JSON.stringify(c));
      assert.throws(() => readResult(file), /not a bench result/, `case ${i}`);
    });
    const legacyFile = path.join(dir, 'legacy.json');
    fs.writeFileSync(legacyFile, JSON.stringify(preGovernor(result(1000, 2))));
    const legacy = readResult(legacyFile);
    assert.equal(legacy.budget, undefined);
    assert.ok(printTable([legacy]).includes(PRE_GOVERNOR), 'the table says the result predates the governor');
    assert.deepEqual(readResult(writeResult(result(1000, 2), dir, 'good.json')).budget, { requested: 'turbo', effective: ['turbo', 'turbo', 'turbo'] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the table carries the budget beside the cache state: the preset asked for, then what each run ran under', () => {
  const steady = printTable([result(1000, 2)]);
  const [header, , row] = steady.split('\n');
  assert.match(header, /cache\s+budget\s+rate/);
  assert.ok(row.includes('turbo: turbo/turbo/turbo'), row);
  assert.doesNotMatch(row, /moved/);
  const moved = result(1000, 2);
  moved.budget = { requested: 'eco', effective: ['eco', 'balanced', 'eco'] };
  assert.ok(printTable([moved]).includes('eco: eco/balanced/eco (moved)'), printTable([moved]));
});

/* -------------------------- the baseline's name -------------------------- */

/** The series of 23 September 2026: the turbo walker on ci20k, recorded under a budget beside its Phase 1 baseline. */
function turboWalkerCi20k(r: BenchResult): BenchResult {
  return { ...r, engine: 'turbo-walker', corpus: { ...r.corpus, name: 'ci20k' } };
}
/** The name that Phase 1 baseline was committed under, before the governor existed. */
const PHASE1_NAME = 'enumerate-turbo-walker-ci20k-darwin-arm64-tierB.json';

test('recording a budgeted result beside a baseline from before the governor leaves that file byte-identical and writes its own', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-baselines-'));
  try {
    const legacyFile = writeResult(preGovernor(turboWalkerCi20k(result(1200, 2))), dir, PHASE1_NAME);
    const before = fs.readFileSync(legacyFile);
    const budgeted = turboWalkerCi20k(result(1000, 2));
    const written = recordBaseline(budgeted, dir);
    assert.ok(fs.readFileSync(legacyFile).equals(before), 'the baseline from before the governor is byte-identical');
    assert.equal(path.basename(written), 'enumerate-turbo-walker-ci20k-darwin-arm64-tierB-budget-turbo.json');
    assert.deepEqual(fs.readdirSync(dir).sort(), [PHASE1_NAME, path.basename(written)].sort(), 'one new file beside the old one');
    assert.deepEqual(readResult(written).budget, { requested: 'turbo', effective: ['turbo', 'turbo', 'turbo'] });
    assert.equal(readResult(legacyFile).budget, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a baseline name ends in the budget asked for; a result from before the governor keeps the name it was recorded under', () => {
  const budgeted = turboWalkerCi20k(result(1000, 2));
  assert.equal(baselineFileName(preGovernor(budgeted)), PHASE1_NAME, 'the Phase 1 names are unchanged, so those baselines are still where the rule puts them');
  const names = REQUESTED_BUDGETS.map((requested) => {
    // Automatic resolves to Balanced here: the name is the budget asked for, which is what a comparison keys on.
    const name = baselineFileName({ ...budgeted, budget: { requested, effective: budgeted.runs.map(() => (requested === 'auto' ? 'balanced' : requested)) } });
    assert.equal(name, `enumerate-turbo-walker-ci20k-darwin-arm64-tierB-budget-${requested}.json`);
    return name;
  });
  assert.equal(new Set([...names, PHASE1_NAME]).size, REQUESTED_BUDGETS.length + 1, 'every budget has its own file, and none is the Phase 1 one');
});

test('every committed baseline sits where the name rule puts it, and no budgeted recording of the same series can land on one from before the governor', () => {
  const dir = path.join(__dirname, '..', 'bench', 'baselines');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const results = files.map((f) => ({ f, r: readResult(path.join(dir, f)) }));
  const preGovernorFiles = results.filter(({ r }) => r.budget === undefined).map(({ f }) => f);
  assert.ok(preGovernorFiles.length > 0, 'the Phase 1 baselines are committed');
  for (const { f, r } of results) {
    assert.equal(baselineFileName(r), f, `${f} is not the name the rule gives its contents`);
    if (r.budget !== undefined) continue;
    for (const requested of REQUESTED_BUDGETS) {
      const name = baselineFileName({ ...r, budget: { requested, effective: r.runs.map(() => requested) } });
      assert.ok(!preGovernorFiles.includes(name), `${f} recorded under ${requested} would replace ${name}`);
    }
  }
});

/* -------------- a baseline is never replaced by another condition -------------- */

test('--record refuses to replace a baseline of the same name measured under another condition, names the condition, and leaves the file byte-identical', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-baselines-guard-'));
  try {
    const recorded = recordBaseline(result(1000, 2), dir);
    const before = fs.readFileSync(recorded);
    // Each of these keeps the file name (the name carries no cache state, corpus parameters, unit, --min-size or --threshold, and slugs fold case), but compare treats each as a condition.
    const conditions: Array<[string, (r: BenchResult) => void, RegExp]> = [
      ['cache state', (r) => { r.cache = { state: 'mixed', reason: 'x' }; }, /cache state \(mixed vs warm\)/],
      ['corpus parameters', (r) => { r.corpus = { ...r.corpus, params: { entries: 1 } }; }, /corpus parameters \(\{"entries":1\} vs \{\}\)/],
      ['unit', (r) => { r.entriesUnit = 'files'; }, /unit \(files vs entries\)/],
      ['engine spelled another way', (r) => { r.engine = 'Walker'; }, /engine \(Walker vs walker\)/],
      ['--min-size', (r) => { r.minSize = 4096; }, /--min-size \(4096 vs not recorded\)/],
      ['--threshold', (r) => { r.threshold = 12; }, /--threshold \(12 vs not recorded\)/],
    ];
    for (const [name, patch, pattern] of conditions) {
      const next = result(900, 2);
      patch(next);
      assert.equal(baselineFileName(next), path.basename(recorded), `${name}: the same file name`);
      assert.throws(() => recordBaseline(next, dir), (err: unknown) => err instanceof Error && /^refusing to replace /.test(err.message) && pattern.test(err.message), name);
      assert.ok(fs.readFileSync(recorded).equals(before), `${name}: the recorded baseline is byte-identical`);
    }
    const again = recordBaseline(result(900, 2), dir);
    assert.equal(again, recorded, 'a re-measurement under the same conditions replaces it, as --record always has');
    assert.equal(readResult(again).summary.wallMsMedian, 900);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--record refuses to replace a file under a baseline name that is not a result it can read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-baselines-unreadable-'));
  try {
    const file = path.join(dir, baselineFileName(result(1000, 2)));
    fs.writeFileSync(file, 'not a result');
    assert.throws(() => recordBaseline(result(1000, 2), dir), (err: unknown) => err instanceof Error && /^refusing to replace a baseline this harness cannot read: .*not a bench result/.test(err.message));
    assert.equal(fs.readFileSync(file, 'utf8'), 'not a result');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------- --min-size and --threshold are conditions ------------------- */

function duplicatesAt(wallMs: number, minSize?: number): BenchResult {
  const r = { ...result(wallMs, 2), suite: 'duplicates' as const, engine: 'sha256-staged', entriesUnit: 'files' as const };
  return minSize === undefined ? r : { ...r, minSize };
}

function nearDupAt(wallMs: number, threshold?: number): BenchResult {
  const r = { ...result(wallMs, 2), suite: 'neardup' as const, engine: 'dhash-pairwise', entriesUnit: 'images' as const };
  return threshold === undefined ? r : { ...r, threshold };
}

test('two duplicate results at different --min-size, or one that never recorded its value, are not comparable', () => {
  const differ = compareToBaseline(duplicatesAt(900, 4096), duplicatesAt(1000, 1024));
  assert.equal(differ.verdict, 'NOT COMPARABLE', differ.sentence);
  assert.match(differ.sentence, /--min-size \(4096 vs 1024\)/);
  const unrecorded = compareToBaseline(duplicatesAt(900, 1024), duplicatesAt(1000));
  assert.equal(unrecorded.verdict, 'NOT COMPARABLE', unrecorded.sentence);
  assert.match(unrecorded.sentence, /--min-size \(1024 vs not recorded\)/);
  assert.equal(compareToBaseline(duplicatesAt(900, 1024), duplicatesAt(1000, 1024)).verdict, 'PASS', 'the same --min-size leaves the verdict to the numbers');
});

test('two near-duplicate results at different --threshold, or one that never recorded its value, are not comparable', () => {
  const differ = compareToBaseline(nearDupAt(900, 12), nearDupAt(1000, 10));
  assert.equal(differ.verdict, 'NOT COMPARABLE', differ.sentence);
  assert.match(differ.sentence, /--threshold \(12 vs 10\)/);
  const unrecorded = compareToBaseline(nearDupAt(900), nearDupAt(1000, 10));
  assert.equal(unrecorded.verdict, 'NOT COMPARABLE', unrecorded.sentence);
  assert.match(unrecorded.sentence, /--threshold \(not recorded vs 10\)/);
  assert.equal(compareToBaseline(nearDupAt(900, 10), nearDupAt(1000, 10)).verdict, 'PASS', 'the same --threshold leaves the verdict to the numbers');
});

test('readResult keeps a recorded --min-size and --threshold and refuses a malformed one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-report-options-'));
  try {
    assert.equal(readResult(writeResult(duplicatesAt(1000, 1024), dir, 'dup.json')).minSize, 1024);
    assert.equal(readResult(writeResult(nearDupAt(1000, 10), dir, 'near.json')).threshold, 10);
    // Zero is a value the CLI accepts (--threshold=0 is exact matches only): it must read back.
    assert.equal(readResult(writeResult(duplicatesAt(1000, 0), dir, 'dup0.json')).minSize, 0);
    assert.equal(readResult(writeResult(nearDupAt(1000, 0), dir, 'near0.json')).threshold, 0);
    const cases: unknown[] = [
      { ...duplicatesAt(1000), minSize: '1024' },
      { ...duplicatesAt(1000), minSize: -1 },
      { ...duplicatesAt(1000), minSize: 1.5 },
      { ...nearDupAt(1000), threshold: null },
      { ...nearDupAt(1000), threshold: 'ten' },
    ];
    cases.forEach((c, i) => {
      const file = path.join(dir, `bad-option-${i}.json`);
      fs.writeFileSync(file, JSON.stringify(c));
      assert.throws(() => readResult(file), /not a bench result/, `case ${i}`);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------- a tree git could not vouch for --------------------- */

test("--record refuses a result whose tree git could not vouch for, and quotes git's failure", () => {
  const unverified = result(1000, 2);
  unverified.machine = { ...unverified.machine, dirty: true, dirtyReason: 'git status failed: fatal: index file smaller than expected' };
  assert.equal(
    recordRefusal(unverified),
    'git could not say whether the working tree was clean (git status failed: fatal: index file smaller than expected), so the commit it cites may not be the code measured',
  );
});

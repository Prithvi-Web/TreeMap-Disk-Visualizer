import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarize, compareToBaseline, printTable, readResult, writeResult, type BenchResult, type BenchRun } from '../bench/lib/report';
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
    runs: [r, r, r],
    summary: { ...summarize([r, r, r]), resolutionPct },
    correctness: { ok: true, notes: [] },
    recordedAt: '2026-09-18T00:00:00.000Z',
    commit: 'abc1234',
    label: 'test',
  };
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

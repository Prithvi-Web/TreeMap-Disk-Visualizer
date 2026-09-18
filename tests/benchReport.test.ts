import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarize, compareToBaseline, printTable, readResult, writeResult, type BenchResult, type BenchRun } from '../bench/lib/report';
import { checkScanAgainstManifest, checkDuplicatesAgainstManifest } from '../bench/lib/verify';

function run(wallMs: number, cpuSeconds = 0.5, entries = 200_000, extra: Partial<BenchRun> = {}): BenchRun {
  return { wallMs, entries, cpuSeconds, childCpuSeconds: null, peakRssBytes: 100_000_000, bytesRead: 1_000, loadAvg: [1, 1, 1], ...extra };
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
    machine: { cpuModel: 'x', cores: 8, perfCores: null, effCores: null, memoryBytes: 1, platform: 'darwin', osRelease: '1', node: 'v1', commit: 'abc1234', loadAvg: [1, 1, 1], maxVnodes: null, tier: 'B', tierReason: 'test' },
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

test('one percent slower inside a two percent band is inconclusive, and says at what resolution', () => {
  const v = compareToBaseline(result(1010, 2), result(1000, 2));
  assert.equal(v.verdict, 'INCONCLUSIVE');
  assert.match(v.sentence, /2\.0%/);
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
    assert.equal(v.verdict, 'INCONCLUSIVE');
    assert.match(v.sentence, /single run|no resolution/);
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

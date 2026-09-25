import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type * as NativeCore from '../native/index';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-benchSynthetic-data-');

import { skipOrFailOnCi } from './fixtures/ciSkip';
import { HANG_GUARD_MS, waitFor } from './fixtures/waitFor';
import { loadNative, resetNativeForTests } from '../src/services/scan/native';
import { CORPORA, SYNTHETIC_CORPORA, SYNTHETIC_NAMES, createCorpus, planCorpus, syntheticCounts, syntheticManifest, type CorpusManifest, type SyntheticParams } from '../bench/lib/corpus';
import { benchTmpDir } from '../bench/lib/paths';
import { BaselineConflictError, compareToBaseline, isBenchResult, printTable, readResult, recordBaseline, sourceOf, summarize, writeResult, type BenchResult, type BenchRun, type StoredResult } from '../bench/lib/report';
import { manifestSource, runEnumerate } from '../bench/lib/suites';

/**
 * The synthetic source on the Node side (Phase 4, P4-8 and design §S.8): the
 * presets create nothing on disk, their counts are the native walk's own, the
 * report says `source: synthetic`, and `bench compare` refuses to set one
 * beside a file-system run. The native legs walk at most 20,000 entries.
 */

const REPO = path.join(__dirname, '..');
const tsxCli = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const PREBUILT_MODULE = path.join(REPO, 'native', 'prebuilt', `${process.platform}-${process.arch}`, 'treemap_core.node');
/** `bench compare`'s exit code for NOT COMPARABLE (bench/run.ts). */
const EXIT_NOT_COMPARABLE = 3;
/** The native legs' size: a developer-shaped tree small enough for a unit test. */
const SMALL = 20_000;

type Core = typeof NativeCore;

/** The module the native legs load: TREEMAP_NATIVE_MODULE, or the prebuilt one. */
function moduleFile(): string {
  return process.env.TREEMAP_NATIVE_MODULE ?? PREBUILT_MODULE;
}

/** The prebuilt module (or TREEMAP_NATIVE_MODULE) through the real loader, or null after skipping with the reason. */
function loadCore(t: TestContext): Core | null {
  const file = moduleFile();
  if (!fs.existsSync(file)) {
    skipOrFailOnCi(t, `no native module at ${file}; build it with npm run build:native`);
    return null;
  }
  resetNativeForTests();
  const r = loadNative({ path: file });
  if (!r.available) assert.fail(r.reason);
  return r.module as unknown as Core;
}

/** A root inside the app's synthetic temp folder, as the module names it, that nothing creates: one per test and process. */
function syntheticRootFor(core: Core, tag: string): string {
  return path.join(core.syntheticTempFolder(), `bench-test-${tag}-${process.pid}`);
}

/** Walks `synthetic` at `root` natively and takes the columns. */
async function walk(core: Core, root: string, synthetic: SyntheticParams): Promise<NativeCore.WalkResult> {
  const handle = core.scanStart(root, { neverDescend: [], wantAtime: false, maxWorkers: 2, synthetic });
  await waitFor(() => core.scanPoll(handle).done, 'the synthetic walk', 5);
  return core.scanTake(handle);
}

function tally(out: NativeCore.WalkResult): { dirs: number; files: number } {
  let dirs = 0;
  let files = 0;
  for (const kind of out.kind) {
    if (kind === 1) dirs += 1;
    else files += 1;
  }
  return { dirs, files };
}

function entriesUnder(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function run(wallMs: number): BenchRun {
  return { wallMs, entries: 10_000_000, cpuSeconds: 30, selfCpuSeconds: 30, childCpuSeconds: 0, peakRssBytes: 600_000_000, bytesRead: null, bytesReadReason: 'a synthetic listing reads no disk', persistMs: 0, persistCpuSeconds: 0, loadAvg: [1, 1, 1] };
}

/** An enumerate result on `corpus`, from `source` (left out: a result written before the field). */
function result(corpus: string, source: BenchResult['source'] | undefined, wallMs = 20_000): BenchResult {
  const runs = [run(wallMs), run(wallMs + 10), run(wallMs + 20)];
  const r: BenchResult = {
    suite: 'enumerate',
    corpus: { name: corpus, params: {}, scale: 'test' },
    engine: 'native',
    engineDescription: 'the native walker',
    entriesUnit: 'entries',
    machine: { cpuModel: 'x', cores: 8, perfCores: null, effCores: null, memoryBytes: 1, platform: 'darwin', arch: 'arm64', osRelease: '1', node: 'v1', commit: 'abc1234', dirty: false, loadAvg: [1, 1, 1], maxVnodes: null, tier: 'B', tierReason: 'test' },
    cache: { state: 'warm', reason: 'test' },
    budget: { requested: 'turbo', effective: ['turbo', 'turbo', 'turbo'] },
    runs,
    summary: summarize(runs),
    correctness: { ok: true, notes: [] },
    recordedAt: '2026-09-24T00:00:00.000Z',
    commit: 'abc1234',
    label: 'test',
  };
  if (source !== undefined) r.source = source;
  return r;
}

/* ═══════════════════ the presets ═══════════════════ */

test('the synthetic presets are the developer shape at 10M and 100M entries, and naming one creates nothing on disk', () => {
  assert.deepEqual([...SYNTHETIC_NAMES], ['synthetic10m', 'synthetic100m']);
  assert.equal(SYNTHETIC_CORPORA.synthetic10m.entries, 10_000_000);
  assert.equal(SYNTHETIC_CORPORA.synthetic100m.entries, 100_000_000);
  for (const name of SYNTHETIC_NAMES) {
    const p = SYNTHETIC_CORPORA[name];
    assert.equal(p.folderShare, 0.15, `${name}: 15% folders (§S.8)`);
    assert.equal(p.nameLength, 18, `${name}: L ≈ 18`);
    assert.equal(p.linkShare, 0.01, `${name}: κ = 1%`);
    assert.ok(p.sizeSigma > 0 && p.sizeMedian > 0, `${name}: log-normal sizes`);
    assert.ok(Object.isFrozen(p), `${name}: the preset cannot be changed in place`);
  }

  // Any folder: the manifest puts the root in the one it is given.
  const fence = path.join(os.tmpdir(), `treemap-benchSynthetic-fence-${process.pid}`);
  const fenceBefore = fs.existsSync(fence);
  const benchBefore = entriesUnder(benchTmpDir());
  const counts = { synthetic10m: { dirs: 1_500_001, files: 8_500_000, hardlinkNames: 85_000 }, synthetic100m: { dirs: 15_000_001, files: 85_000_000, hardlinkNames: 850_000 } };
  for (const name of SYNTHETIC_NAMES) {
    const m = syntheticManifest(name, fence);
    assert.equal(m.source, 'synthetic');
    assert.equal(m.name, name);
    assert.deepEqual(m.params, SYNTHETIC_CORPORA[name]);
    assert.equal(m.root, path.join(fence, name), `${name}: the root is in the folder given`);
    assert.deepEqual({ dirs: m.dirs, files: m.files, hardlinkNames: m.hardlinkNames }, counts[name], name);
    assert.equal(fs.existsSync(m.root), false, `${name}: ${m.root} was created`);
  }
  assert.equal(fs.existsSync(fence), fenceBefore, 'the synthetic temp folder was made or removed');
  assert.deepEqual(entriesUnder(benchTmpDir()), benchBefore, 'no corpus was built under the bench folder');
});

test('syntheticCounts refuses a parameter outside its range, naming the field', () => {
  const base = SYNTHETIC_CORPORA.synthetic10m;
  const cases: Array<[Partial<SyntheticParams>, RegExp]> = [
    [{ entries: 4_294_967_295 }, /entries/],
    [{ entries: 1.5 }, /entries/],
    [{ folderShare: 1.01 }, /folderShare/],
    [{ linkShare: -0.1 }, /linkShare/],
    [{ sizeSigma: 11 }, /sizeSigma/],
    [{ nameLength: 256 }, /nameLength/],
  ];
  for (const [change, message] of cases) {
    assert.throws(() => syntheticCounts({ ...base, ...change }), message, JSON.stringify(change));
  }
});

/* ═══════════════════ the native walk ═══════════════════ */

test("the presets' counts are the native walk's own, and the walk creates nothing on disk", async (t) => {
  const core = loadCore(t);
  if (!core) return;
  const shapes: SyntheticParams[] = [
    { ...SYNTHETIC_CORPORA.synthetic10m, entries: SMALL },
    { ...SYNTHETIC_CORPORA.synthetic100m, entries: SMALL + 7, folderShare: 0.333, linkShare: 0.1, seed: 5 },
  ];
  for (const synthetic of shapes) {
    const root = syntheticRootFor(core, 'counts');
    const out = await walk(core, root, synthetic);
    const expected = syntheticCounts(synthetic);
    assert.equal(out.stats.entries, synthetic.entries, 'entries under the root');
    assert.deepEqual(tally(out), { dirs: expected.dirs, files: expected.files }, JSON.stringify(synthetic));
    assert.equal(out.hardlinkNode.length, expected.hardlinkNames, 'hard-linked names');
    assert.equal(out.stats.fastPath, 'unavailable', 'no platform listing ran');
    assert.equal(fs.existsSync(root), false, `${root} was created`);
  }
});

test('one seed walks one tree natively, another seed another', async (t) => {
  const core = loadCore(t);
  if (!core) return;
  const synthetic = { ...SYNTHETIC_CORPORA.synthetic10m, entries: SMALL };
  const root = syntheticRootFor(core, 'seed');
  const a = await walk(core, root, synthetic);
  const b = await walk(core, root, synthetic);
  const c = await walk(core, root, { ...synthetic, seed: synthetic.seed + 1 });
  const names = (out: NativeCore.WalkResult): string[] => {
    const all: string[] = [];
    for (let i = 1; i < out.parent.length; i++) all.push(Buffer.from(out.names.subarray(out.nameOff[i], out.nameOff[i + 1])).toString('utf8'));
    return all.sort();
  };
  assert.deepEqual(names(a), names(b), 'the same seed lists the same names');
  assert.deepEqual([...a.size].sort((x, y) => x - y), [...b.size].sort((x, y) => x - y), 'and the same sizes');
  assert.notDeepEqual(names(a), names(c), 'another seed lists other names');
});

test('scanStart refuses a synthetic root outside the app’s synthetic temp folder, a share out of range, an option it does not know and a tree it cannot build', (t) => {
  const core = loadCore(t);
  if (!core) return;
  const opts = (synthetic: unknown): NativeCore.ScanStartOptions => ({ neverDescend: [], wantAtime: false, synthetic: synthetic as NativeCore.SyntheticSource });
  for (const outside of [path.join(os.tmpdir(), 'elsewhere', 'tree'), core.syntheticTempFolder(), REPO]) {
    assert.throws(() => core.scanStart(outside, opts({ entries: 10 })), /TreeMap-synthetic/, outside);
  }
  const root = syntheticRootFor(core, 'refuse');
  assert.throws(() => core.scanStart(root, opts({ entries: 10, folderShare: 1.5 })), /folderShare/);
  assert.throws(() => core.scanStart(root, opts({ entries: 10, colour: 'red' })), /colour/);
  assert.throws(() => core.scanStart(root, opts({ entries: 560, folderShare: 0.15, fanOut: 4, depth: 2 })), /84 folders/);
  assert.throws(() => core.scanStart(root, opts({ entries: 20_000, nameLength: 5 })), /name length/);
  assert.equal(fs.existsSync(root), false);
});

/**
 * Run in a child with TMPDIR removed and TMP and TEMP pointed elsewhere: Node's
 * os.tmpdir() then names TMP (TEMP on Windows) while Rust's temp_dir() names
 * the per-user folder on macOS, /tmp on Linux and TMP on Windows. Prints what
 * the child saw as JSON; the parent's spawn timeout is the hang guard.
 */
const ENV_CHILD = `
const [modulePath, corpusPath] = process.argv.slice(1);
const os = require('node:os');
const core = require(modulePath);
const { syntheticManifest } = require(corpusPath);
const fence = core.syntheticTempFolder();
const m = syntheticManifest('synthetic10m', fence);
let refused = null;
let entries = null;
try {
  const handle = core.scanStart(m.root, { neverDescend: [], wantAtime: false, maxWorkers: 1, synthetic: { ...m.params, entries: 100 } });
  const nap = new Int32Array(new SharedArrayBuffer(4));
  while (!core.scanPoll(handle).done) Atomics.wait(nap, 0, 0, 1);
  entries = core.scanTake(handle).stats.entries;
} catch (err) {
  refused = err instanceof Error ? err.message : String(err);
}
process.stdout.write(JSON.stringify({ tmpdir: os.tmpdir(), fence, root: m.root, refused, entries }));
`;

test("a preset's root is inside the folder the walk accepts, whatever TMPDIR, TMP and TEMP say", (t) => {
  const core = loadCore(t);
  if (!core) return;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-benchSynthetic-env-'));
  try {
    const tmp = path.join(scratch, 'tmp');
    const temp = path.join(scratch, 'temp');
    fs.mkdirSync(tmp);
    fs.mkdirSync(temp);
    const env: NodeJS.ProcessEnv = { ...process.env, TMP: tmp, TEMP: temp };
    delete env.TMPDIR;
    const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', ENV_CHILD, moduleFile(), path.join(REPO, 'bench', 'lib', 'corpus.ts')], { cwd: REPO, env, encoding: 'utf8', timeout: HANG_GUARD_MS });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const seen = JSON.parse(r.stdout) as { tmpdir: string; fence: string; root: string; refused: string | null; entries: number | null };
    assert.ok([tmp, temp].includes(seen.tmpdir), `the child's os.tmpdir() is ${seen.tmpdir}, so the case is not the one meant`);
    assert.equal(seen.refused, null, `scanStart refused ${seen.root}`);
    assert.equal(seen.entries, 100, 'the walk listed the tree');
    assert.equal(seen.root, path.join(seen.fence, 'synthetic10m'));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

/* ═══════════════════ the report ═══════════════════ */

test('a result from a synthetic source says so in its file and in the table; one without the field listed a file system', () => {
  assert.equal(manifestSource(syntheticManifest('synthetic10m', os.tmpdir())), 'synthetic');
  const onDisk: CorpusManifest = { name: 'enum200k', params: CORPORA.enum200k, createdAt: '', root: '/tmp/x', dirs: 1, files: 1, logicalBytes: 0, duplicateGroups: [], hardlinkFamilies: [], sparseFiles: [], flatDir: null, planDigest: '' };
  assert.equal(manifestSource(onDisk), 'file-system');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-benchSynthetic-'));
  try {
    const written = writeResult(result('synthetic10m', 'synthetic'), dir);
    const back = readResult(written);
    assert.equal(back.source, 'synthetic');
    assert.equal(sourceOf(back), 'synthetic');
    assert.ok(printTable([back]).includes('synthetic10m (synthetic)'), printTable([back]));

    const legacy = readResult(writeResult(result('enum200k', undefined), dir, 'legacy.json'));
    assert.equal(sourceOf(legacy), 'file-system', 'every result before the field listed a file system');
    assert.ok(!printTable([legacy]).includes('(synthetic)'));

    const unknown = { ...result('synthetic10m', 'synthetic'), source: 'disk' };
    assert.equal(isBenchResult(JSON.parse(JSON.stringify(unknown))), false, 'a source the harness does not know is not a result');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compare refuses a synthetic result against a file-system run either way round, and compares two synthetic ones', () => {
  const synthetic = result('synthetic10m', 'synthetic');
  for (const fileSystem of [result('synthetic10m', 'file-system'), result('synthetic10m', undefined) as StoredResult]) {
    for (const [a, b] of [[synthetic, fileSystem], [fileSystem, synthetic]] as const) {
      const v = compareToBaseline(a, b);
      assert.equal(v.verdict, 'NOT COMPARABLE', v.sentence);
      assert.match(v.sentence, /synthetic listing/, v.sentence);
      assert.match(v.sentence, /file-system/, v.sentence);
    }
  }
  const same = compareToBaseline(result('synthetic10m', 'synthetic', 20_100), synthetic);
  assert.notEqual(same.verdict, 'NOT COMPARABLE', same.sentence);
  const legacyPair = compareToBaseline(result('enum200k', 'file-system'), result('enum200k', undefined));
  assert.notEqual(legacyPair.verdict, 'NOT COMPARABLE', `a result without the field is a file-system one: ${legacyPair.sentence}`);
});

test('a synthetic result never replaces a file-system baseline recorded under its name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-benchSynthetic-baselines-'));
  try {
    const onDisk = recordBaseline(result('synthetic10m', 'file-system'), dir);
    const before = fs.readFileSync(onDisk, 'utf8');
    assert.throws(() => recordBaseline(result('synthetic10m', 'synthetic'), dir), (err: unknown) => err instanceof BaselineConflictError && /source \(synthetic vs file-system\)/.test(err.message));
    assert.equal(fs.readFileSync(onDisk, 'utf8'), before, 'the baseline is untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a suite run over a corpus on disk records its source as file-system', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-benchSynthetic-corpus-'));
  try {
    const plan = planCorpus({ entries: 200, fanout: 4, depth: 3, flat: 0, sizeMedian: 512, sizeSigma: 1, sizeMax: 65_536, duplicateRate: 0, hardlinkRate: 0, sparseRate: 0, seed: 3 });
    const manifest = await createCorpus(path.join(dir, 'tree'), plan);
    const r = await runEnumerate({ manifest, corpusName: 'test200', engine: 'walker', preset: 'turbo', runs: 1, cache: 'warm', label: 'synthetic test' });
    assert.equal(r.source, 'file-system');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bench compare, the command, exits NOT COMPARABLE for a synthetic result against a file-system baseline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-benchSynthetic-cli-'));
  try {
    const current = writeResult(result('synthetic10m', 'synthetic'), dir, 'current.json');
    const baseline = writeResult(result('synthetic10m', 'file-system'), dir, 'baseline.json');
    const r = spawnSync(process.execPath, [tsxCli, path.join(REPO, 'bench', 'run.ts'), 'compare', current, baseline], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, EXIT_NOT_COMPARABLE, r.stdout + r.stderr);
    assert.match(r.stdout, /^NOT COMPARABLE: .*synthetic listing/, r.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

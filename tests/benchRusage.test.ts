import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { describeMachine } from '../bench/lib/machine';
import { snapshotUsage, diffUsage, probeLocation } from '../bench/lib/rusage';

/**
 * The benchmark harness records every number with the conditions it was taken
 * under. Two modules supply those conditions: the machine record (what the
 * hardware, OS, Node and commit were) and the usage snapshot (what the process
 * itself consumed). What is pinned here is honesty, not magnitude: a snapshot
 * either carries bytes read or says why it cannot, and a difference between
 * two snapshots is never negative — a counter that went backwards is a bug in
 * the measurement, and the harness refuses to print it as a result.
 */

test('the machine record names what every number depends on', async () => {
  const m = await describeMachine();
  assert.ok(m.cpuModel.length > 0);
  assert.ok(m.cores >= 1);
  assert.ok(m.memoryBytes > 0);
  assert.equal(typeof m.platform, 'string');
  assert.match(m.node, /^v\d+/);
  assert.match(m.commit, /^[0-9a-f]{7,40}(-dirty)?$|^unknown$/);
  assert.ok(['A', 'B', 'C'].includes(m.tier));
  if (process.platform === 'darwin') assert.ok((m.maxVnodes ?? 0) > 0);
});

test('a usage snapshot carries CPU seconds and peak RSS, and either bytes read or a stated reason', async () => {
  const s = await snapshotUsage();
  assert.ok(s.cpuSeconds >= 0);
  assert.ok(s.peakRssBytes > 0);
  if (s.bytesRead === null) assert.ok(s.bytesReadReason.length > 10);
  else assert.ok(s.bytesRead >= 0);
});

test('diffUsage never reports a negative delta', async () => {
  const a = await snapshotUsage();
  const b = await snapshotUsage();
  const d = diffUsage(a, b);
  assert.ok(d.cpuSeconds >= 0);
  if (d.bytesRead !== null) assert.ok(d.bytesRead >= 0);
});

test('diffUsage throws when a counter went backwards instead of reporting a negative number', async () => {
  const a = await snapshotUsage();
  assert.throws(
    () => diffUsage({ ...a, cpuSeconds: 9 }, { ...a, cpuSeconds: 1 }),
    /usage went backwards/,
  );
});

test('the tier rule: a small machine is C whatever its model name says, only Apple Pro/Max/Ultra parts skip the core rule', async () => {
  const { classifyTier } = await import('../bench/lib/machine');
  const GiB = 2 ** 30;
  assert.equal(classifyTier('Intel(R) Xeon(R) Processor', 6, 16 * GiB).tier, 'B');
  assert.equal(classifyTier('Intel(R) Core(TM) Ultra 5 125U', 12, 8 * GiB).tier, 'C');
  assert.equal(classifyTier('AMD Ryzen 7 PRO 5850U', 16, 16 * GiB).tier, 'B');
  assert.equal(classifyTier('Apple M4 Pro', 12, 24 * GiB).tier, 'A');
  assert.equal(classifyTier('Apple M4 Pro', 4, 8 * GiB).tier, 'C');
  assert.equal(classifyTier('x', 8, 32 * GiB).tier, 'A');
  assert.equal(classifyTier('x', 4, 64 * GiB).tier, 'C');
  assert.equal(classifyTier('x', 8, 8 * GiB).tier, 'C');
  assert.equal(classifyTier('x', 6, 16 * GiB).tier, 'B');
  const reason = classifyTier('x', 6, 16 * GiB).tierReason;
  assert.match(reason, /8 cores/);
  assert.match(reason, /32(\.0)? GiB/);
});

test('the machine record carries the architecture and says whether the tree was dirty', async () => {
  const { describeMachine } = await import('../bench/lib/machine');
  const m = await describeMachine();
  assert.equal(m.arch, process.arch);
  assert.equal(typeof m.dirty, 'boolean');
  // A commit git could not name stays `unknown`: there is no hash to mark (tests/benchMachine.test.ts).
  if (m.dirty && m.commit !== 'unknown') assert.match(m.commit, /-dirty$/);
  if (process.platform === 'win32') assert.equal(m.loadAvg, null);
});

test('the probe is compiled into a private per-process directory, never a shared fixed path', async () => {
  if (process.platform !== 'darwin') return;
  const { probeLocation } = await import('../bench/lib/rusage');
  await (await import('../bench/lib/rusage')).snapshotUsage();
  const loc = probeLocation();
  assert.ok(loc, 'the probe was built');
  assert.ok(loc!.startsWith(fs.realpathSync(os.tmpdir())) || loc!.startsWith(os.tmpdir()), loc);
  assert.ok(/treemap-bench-probe-[A-Za-z0-9]{6}/.test(loc!), `mkdtemp-style directory: ${loc}`);
  const mode = fs.statSync(path.dirname(loc!)).mode & 0o777;
  assert.equal(mode, 0o700, 'owner-only directory');
});

/* ------------- the probe hand-off: no measuring process compiles ------------- */

const RUSAGE_MODULE = path.join(__dirname, '..', 'bench', 'lib', 'rusage.ts');
const TSX_CLI = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');

interface ChildProbe { location: string | null; builds: number | null; bytesRead: number | null; bytesReadReason: string }

/**
 * One usage snapshot in a fresh process — what a measuring child takes just
 * before its timed window — reporting which probe it ran and how many it
 * compiled (`builds` is null where the module has no build counter).
 */
function snapshotInFreshProcess(env: NodeJS.ProcessEnv): ChildProbe {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-rusage-child-'));
  try {
    const script = path.join(dir, 'snapshot.ts');
    fs.writeFileSync(script, [
      `import * as rusage from ${JSON.stringify(RUSAGE_MODULE)};`,
      'const counter = (rusage as unknown as { probeBuildCount?: () => number }).probeBuildCount;',
      'void rusage.snapshotUsage().then((s) => {',
      '  process.stdout.write(JSON.stringify({ location: rusage.probeLocation(), builds: counter ? counter() : null, bytesRead: s.bytesRead, bytesReadReason: s.bytesReadReason }));',
      '});',
    ].join('\n'));
    const r = spawnSync(process.execPath, [TSX_CLI, script], { encoding: 'utf8', env, timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout) as ChildProbe;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** This process's environment without the hand-off variables: a child started with it is a standalone run. */
function standaloneEnv(): NodeJS.ProcessEnv {
  const { TREEMAP_BENCH_PROBE: _binary, TREEMAP_BENCH_PROBE_FAILURE: _failure, ...rest } = process.env;
  return rest;
}

test("a measuring process handed the harness's probe runs that binary and compiles none", async () => {
  if (process.platform !== 'darwin') return;
  await snapshotUsage();
  const harnessProbe = probeLocation();
  assert.ok(harnessProbe, 'this process built a probe to hand over');
  const child = snapshotInFreshProcess({ ...standaloneEnv(), TREEMAP_BENCH_PROBE: harnessProbe });
  assert.equal(child.location, harnessProbe, 'the child ran the probe it was handed, not one it compiled');
  assert.equal(child.builds, 0, 'the child ran no compiler');
  assert.equal(typeof child.bytesRead, 'number', child.bytesReadReason);
  assert.ok(fs.existsSync(harnessProbe), "the child left the harness's probe in place when it exited");
});

test('a measuring process handed a failed build reports that reason, reads no bytes, and compiles nothing', () => {
  if (process.platform !== 'darwin') return;
  const reason = "compiling bench/probes/darwin-rusage.c failed: a stand-in for the harness's own failure";
  const child = snapshotInFreshProcess({ ...standaloneEnv(), TREEMAP_BENCH_PROBE_FAILURE: reason });
  assert.equal(child.bytesRead, null);
  assert.equal(child.bytesReadReason, reason, 'the failure is reported as the build reported it, never silently');
  assert.equal(child.location, null);
  assert.equal(child.builds, 0);
});

test('with nothing handed over, a process builds its own probe, as a standalone run always has', () => {
  if (process.platform !== 'darwin') return;
  const child = snapshotInFreshProcess(standaloneEnv());
  assert.match(child.location ?? '', /treemap-bench-probe-[A-Za-z0-9]{6}/);
  assert.equal(child.builds, 1);
  assert.equal(typeof child.bytesRead, 'number', child.bytesReadReason);
});

test('a tree is dirty when tracked code changed, not when a baseline the harness itself just recorded is untracked', async () => {
  const { dirtyFromStatus } = await import('../bench/lib/machine');
  assert.equal(dirtyFromStatus(''), false);
  assert.equal(dirtyFromStatus('?? bench/baselines/enumerate-gdu-turbo-ci20k-darwin-arm64-tierB.json\n'), false);
  assert.equal(dirtyFromStatus(' M bench/lib/suites.ts\n'), true);
  assert.equal(dirtyFromStatus('?? bench/lib/newthing.ts\n'), true, 'an untracked source file could have been measured');
  assert.equal(dirtyFromStatus('?? bench/baselines/x.json\n M src/services/diskScanner.ts\n'), true);
});

test('a change confined to bench/baselines/ is data the harness recorded and leaves the tree clean; a change to anything else is dirty', async () => {
  const { dirtyFromStatus } = await import('../bench/lib/machine');
  // `git status --porcelain` (v1) lines, in the formats git 2.50 prints them.
  const baselinesOnly = [
    ' M bench/baselines/enumerate-turbo-walker-ci20k-darwin-arm64-tierB.json', // a tracked baseline an earlier series of the batch replaced
    'M  bench/baselines/enumerate-gdu-turbo-ci20k-darwin-arm64-tierB.json',
    'A  bench/baselines/enumerate-native-ci20k-darwin-arm64-tierB-budget-turbo.json',
    '?? bench/baselines/enumerate-turbo-walker-ci20k-darwin-arm64-tierB-budget-turbo.json',
    ' D bench/baselines/duplicates-sha256-staged-ci20k-darwin-arm64-tierB.json',
    'R  bench/baselines/a.json -> bench/baselines/b.json',
    'RM bench/baselines/a.json -> bench/baselines/b.json',
    '?? bench/baselines/sub/',
    '?? "bench/baselines/with space.json"',
    'R  "bench/baselines/with space.json" -> "bench/baselines/with other space.json"',
  ];
  for (const line of baselinesOnly) assert.equal(dirtyFromStatus(`${line}\n`), false, line);
  const listing = `${baselinesOnly.join('\n')}\n`;
  assert.equal(dirtyFromStatus(listing), false, 'a listing of nothing but baselines is clean');
  const elsewhere = [
    ' M src/services/diskScanner.ts',
    ' M bench/lib/report.ts',
    'M  tests/benchReport.test.ts',
    '?? src/services/newEngine.ts',
    ' M bench/README.md',
    ' D package-lock.json',
    '?? bench/baselines-old/x',
    ' M bench/baselines-old/x.json',
    '?? bench/baselinesx.json',
    'R  src/x.ts -> bench/baselines/x.ts',
    'R  bench/baselines/x.json -> src/x.json',
  ];
  for (const line of elsewhere) {
    assert.equal(dirtyFromStatus(`${line}\n`), true, line);
    assert.equal(dirtyFromStatus(`${listing}${line}\n`), true, `${line}, beside the baselines`);
  }
});

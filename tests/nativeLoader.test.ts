import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import type * as NativeCore from '../native/index';
import { loadNative, nativeCandidates, resetNativeForTests } from '../src/services/scan/native';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { nativeVersion: string };

test('a module that is not there is reported, never thrown, with the path and the platform in the reason', () => {
  resetNativeForTests();
  const missing = path.join(os.tmpdir(), 'treemap-no-such-module.node');
  const r = loadNative({ path: missing });
  assert.equal(r.available, false);
  if (r.available) return;
  assert.ok(r.reason.includes(missing), r.reason);
  assert.ok(r.reason.includes(`${process.platform}-${process.arch}`), r.reason);
});

test('a file that is not a module is refused with the loader error in the reason', () => {
  resetNativeForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-native-'));
  try {
    const bogus = path.join(dir, 'treemap_core.node');
    fs.writeFileSync(bogus, 'not a shared library');
    const r = loadNative({ path: bogus });
    assert.equal(r.available, false);
    if (r.available) return;
    assert.ok(r.reason.length > 20, r.reason);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a version other than the one package.json expects is refused, naming both', () => {
  resetNativeForTests();
  const r = loadNative({
    path: '/fake/treemap_core.node',
    requireModule: () => ({ version: () => '9.9.9' }),
  });
  assert.equal(r.available, false);
  if (r.available) return;
  assert.ok(r.reason.includes('9.9.9') && r.reason.includes(pkg.nativeVersion), r.reason);
});

test('a module with the expected version loads and the outcome is cached until reset', () => {
  resetNativeForTests();
  let calls = 0;
  const fake = { version: () => pkg.nativeVersion };
  const first = loadNative({ path: '/fake/treemap_core.node', requireModule: () => { calls += 1; return fake; } });
  assert.equal(first.available, true);
  const second = loadNative({ path: '/fake/treemap_core.node', requireModule: () => { calls += 1; return fake; } });
  assert.equal(second.available, true);
  assert.equal(calls, 1, 'the second call reused the first outcome');
  resetNativeForTests();
});

test('the candidate list starts with the environment override and names the prebuilt path for this platform', () => {
  const withEnv = nativeCandidates({ TREEMAP_NATIVE_MODULE: '/override/x.node' });
  assert.equal(withEnv[0], '/override/x.node');
  const plain = nativeCandidates({});
  assert.ok(plain.some((p) => p.endsWith(path.join('native', 'prebuilt', `${process.platform}-${process.arch}`, 'treemap_core.node'))), plain.join('\n'));
});

test('TREEMAP_NATIVE_MODULE is the only candidate: pointed at a path that is not there, the loader refuses naming that path and never falls through to a prebuilt', () => {
  const missing = path.join(os.tmpdir(), 'treemap-forced-legacy', 'treemap_core.node');
  assert.deepEqual(nativeCandidates({ TREEMAP_NATIVE_MODULE: missing }), [missing], 'nothing behind the override');

  const prebuilt = path.join(__dirname, '..', 'native', 'prebuilt', `${process.platform}-${process.arch}`, 'treemap_core.node');
  const previous = process.env.TREEMAP_NATIVE_MODULE;
  process.env.TREEMAP_NATIVE_MODULE = missing;
  try {
    // A prebuilt that WOULD load, stood up through the injected loader so the
    // proof does not depend on whether this machine has built one: only the
    // override may be asked, and it is not there.
    resetNativeForTests();
    const injected = loadNative({
      requireModule: (file) => {
        if (file === missing) throw new Error(`dlopen(${file}): no such file`);
        return { version: () => pkg.nativeVersion };
      },
    });
    assert.equal(injected.available, false, 'the prebuilt answered behind the override');
    if (!injected.available) {
      assert.ok(injected.reason.includes(missing), injected.reason);
      assert.ok(!injected.reason.includes(prebuilt), 'the prebuilt was never consulted');
    }
    // And through the real file system, on a machine that has a prebuilt.
    resetNativeForTests();
    const real = loadNative();
    assert.equal(real.available, false);
    if (!real.available) {
      assert.ok(real.reason.includes(missing), real.reason);
      assert.ok(!real.reason.includes(prebuilt), real.reason);
    }
  } finally {
    if (previous === undefined) delete process.env.TREEMAP_NATIVE_MODULE;
    else process.env.TREEMAP_NATIVE_MODULE = previous;
    resetNativeForTests();
  }
});

/* ------------------------------------------------------------------------ */
/* The real module (Phase 2, Task 4). Built by scripts/build-native.js and   */
/* driven through the loader, so the handshake, the JSON shapes and the      */
/* governor's answers are proven on the module that ships, not on a fake.    */
/* Skipped only when cargo is absent: a build that fails is a failure.       */
/* ------------------------------------------------------------------------ */

type Core = typeof NativeCore;

const REPO = path.join(__dirname, '..');
const BUILD_SCRIPT = path.join(REPO, 'scripts', 'build-native.js');
const TRIPLE = `${process.platform}-${process.arch}`;
const PREBUILT_MODULE = path.join(REPO, 'native', 'prebuilt', TRIPLE, 'treemap_core.node');
/** A cold release build (fat LTO) can take a few minutes; a warm one is seconds. */
const BUILD_TIMEOUT_MS = 20 * 60_000;
/** Eco's ceiling, as the Rust preset table holds it. */
const ECO_SHARE = 0.25;
/** The controller's target multiplier while the user is interacting (Eco and Balanced, never Turbo). */
const INTERACTION_SCALE = 0.7;
/** The controller's target multiplier under serious thermal pressure. */
const THERMAL_SERIOUS_SCALE = 0.5;
/** hold() samples every 100 ms. */
const SAMPLES_PER_SECOND = 10;
const SMOKE_PERCENT = 10;
const SMOKE_SECONDS = 2;
/** The smoke tolerance, ±10 points of machine CPU: a two-second check, not the ±5 point gate (bench/lib/governorSuite.ts). */
const SMOKE_BAND = 0.1;
/** The Rust controller clamps the duty to this range. */
const DUTY_MIN = 0.05;
const MECHANISM_NAMES = ['battery', 'interaction', 'ioPolicy', 'machineCpu', 'priority', 'qos', 'thermal'];
const THERMAL_STATES = ['nominal', 'fair', 'serious', 'critical', 'unknown'];
const HOLD_REPORT_KEYS = ['dutyFinal', 'machineIdleLastHalf', 'mean', 'meanLastHalf', 'p95AbsError', 'samples', 'target', 'withinBand', 'workersFinal'];

type Built = { path: string; viaScript: boolean } | { skip: string } | { failed: string };
let built: Built | null = null;

function cargoPresent(): boolean {
  return spawnSync('cargo', ['--version'], { encoding: 'utf8' }).status === 0;
}

/**
 * The module under test: TREEMAP_NATIVE_MODULE when set (a build made by
 * hand, for iterating), otherwise the prebuilt scripts/build-native.js
 * produces. Built once per file.
 */
function buildOnce(): Built {
  if (built) return built;
  const override = process.env.TREEMAP_NATIVE_MODULE;
  if (override) {
    built = fs.existsSync(override) ? { path: override, viaScript: false } : { failed: `TREEMAP_NATIVE_MODULE points at ${override}, which does not exist` };
    return built;
  }
  if (!cargoPresent()) {
    built = { skip: 'cargo is not installed here, so the native module cannot be built (CI builds it on every leg)' };
    return built;
  }
  if (!fs.existsSync(BUILD_SCRIPT)) {
    built = { failed: `${BUILD_SCRIPT} does not exist, so the module cannot be built` };
    return built;
  }
  const r = spawnSync(process.execPath, [BUILD_SCRIPT], { cwd: REPO, encoding: 'utf8', timeout: BUILD_TIMEOUT_MS });
  if (r.status !== 0) {
    built = { failed: `scripts/build-native.js exited ${r.status}:\n${r.stdout}\n${r.stderr}` };
    return built;
  }
  const printed = (r.stdout.trim().split('\n').pop() ?? '').trim();
  if (printed !== PREBUILT_MODULE) {
    built = { failed: `the script's last line must be the module path ${PREBUILT_MODULE}; stdout was:\n${r.stdout}` };
    return built;
  }
  built = { path: printed, viaScript: true };
  return built;
}

interface Real { core: Core; path: string; viaScript: boolean }

/** The built module through the real loader, or null after skipping the test (cargo absent) or failing it (the build broke). */
function loadReal(t: TestContext): Real | null {
  const b = buildOnce();
  if ('skip' in b) {
    t.skip(b.skip);
    return null;
  }
  if ('failed' in b) assert.fail(b.failed);
  resetNativeForTests();
  const r = loadNative({ path: b.path });
  if (!r.available) assert.fail(r.reason);
  return { core: r.module as unknown as Core, path: b.path, viaScript: b.viaScript };
}

const isMechanism = (m: unknown): boolean =>
  typeof m === 'object' && m !== null
  && typeof (m as { available: unknown }).available === 'boolean'
  && typeof (m as { mechanism: unknown }).mechanism === 'string' && (m as { mechanism: string }).mechanism.length > 0
  && ((m as { available: boolean }).available ? (m as { reason: unknown }).reason === null : typeof (m as { reason: unknown }).reason === 'string');

/** What the controller holds for a ceiling given the state a snapshot reports: ×0.5 under serious heat, ×0.7 while interacting (not Turbo). */
function scaledTarget(ceiling: number, snap: { thermal: string; interacting: boolean | null; effective: string }): number {
  let target = ceiling;
  if (snap.thermal === 'serious') target *= THERMAL_SERIOUS_SCALE;
  if (snap.interacting === true && snap.effective !== 'turbo') target *= INTERACTION_SCALE;
  return target;
}

/** Every scaling a hold's opening target can carry, for a ceiling. */
const possibleTargets = (ceiling: number): number[] => [1, THERMAL_SERIOUS_SCALE, INTERACTION_SCALE, THERMAL_SERIOUS_SCALE * INTERACTION_SCALE].map((s) => ceiling * s);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('the built module loads through the loader and version() is the handshake value package.json expects', (t) => {
  const real = loadReal(t);
  if (!real) return;
  assert.equal(real.core.version(), pkg.nativeVersion);
  if (real.viaScript) {
    assert.equal(real.path, PREBUILT_MODULE, 'the script puts the module where the loader looks');
    assert.equal(fs.readFileSync(path.join(path.dirname(real.path), 'VERSION'), 'utf8').trim(), pkg.nativeVersion, 'VERSION beside the module is the handshake value');
  }
  resetNativeForTests();
  const again = loadNative({ path: real.path });
  assert.equal(again.available, true);
  if (again.available) assert.equal(again.version, pkg.nativeVersion);
});

test('governorCapabilities() names the seven mechanisms, each with a reason exactly when it is unavailable', (t) => {
  const real = loadReal(t);
  if (!real) return;
  const caps = real.core.governorCapabilities() as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(caps).sort(), MECHANISM_NAMES);
  for (const name of MECHANISM_NAMES) assert.ok(isMechanism(caps[name]), `${name}: ${JSON.stringify(caps[name])}`);
  assert.deepEqual(real.core.governorCapabilities(), caps, 'probing changes nothing, so a second probe agrees');
});

test('governorConfigure() is live: eco reports effective eco and a quarter of the machine, an override replaces the ceiling, auto follows battery and heat', (t) => {
  const real = loadReal(t);
  if (!real) return;
  const { governorConfigure, governorSnapshot } = real.core;
  governorConfigure({ preset: 'eco' }, false);
  const eco = governorSnapshot();
  assert.deepEqual(eco.budget, { preset: 'eco', cpuPercent: null });
  assert.equal(eco.effective, 'eco');
  assert.ok(Math.abs(eco.targetShare - scaledTarget(ECO_SHARE, eco)) < 1e-9, `targetShare ${eco.targetShare} for ${JSON.stringify({ thermal: eco.thermal, interacting: eco.interacting })}`);
  assert.ok(THERMAL_STATES.includes(eco.thermal), eco.thermal);
  assert.ok([true, false, null].includes(eco.onBattery), String(eco.onBattery));
  assert.ok([true, false, null].includes(eco.interacting), String(eco.interacting));
  assert.equal(eco.paused, false);
  assert.ok(Number.isInteger(eco.ticks) && eco.ticks >= 0, `ticks ${eco.ticks}`);
  assert.ok(Number.isInteger(eco.workers) && eco.workers >= 1 && eco.workers <= 2, `eco runs one or two workers, not ${eco.workers}`);
  assert.ok(eco.duty >= DUTY_MIN && eco.duty <= 1, `duty ${eco.duty}`);
  assert.ok(eco.share1s >= 0 && eco.share1s <= 1, `share1s ${eco.share1s}`);
  assert.ok(eco.machineBusyShare === null || (eco.machineBusyShare >= 0 && eco.machineBusyShare <= 1), `machineBusyShare ${eco.machineBusyShare}`);
  assert.deepEqual(Object.keys(eco.mechanisms).sort(), ['io', 'priority', 'qos']);
  for (const m of Object.values(eco.mechanisms)) assert.ok(isMechanism(m), JSON.stringify(m));

  governorConfigure({ preset: 'balanced', cpuPercent: 40 }, false);
  const forty = governorSnapshot();
  assert.deepEqual(forty.budget, { preset: 'balanced', cpuPercent: 40 });
  assert.equal(forty.effective, 'balanced');
  assert.ok(Math.abs(forty.targetShare - scaledTarget(0.4, forty)) < 1e-9, `targetShare ${forty.targetShare}`);

  governorConfigure({ preset: 'balanced', cpuPercent: null }, true);
  const auto = governorSnapshot();
  assert.deepEqual(auto.budget, { preset: 'balanced', cpuPercent: null });
  const pressed = auto.onBattery === true || auto.thermal === 'serious' || auto.thermal === 'critical';
  assert.equal(auto.effective, pressed ? 'eco' : 'balanced', `auto with ${JSON.stringify({ onBattery: auto.onBattery, thermal: auto.thermal })}`);
});

test('a budget the governor cannot take is refused with a message, and the last good budget stays in force', (t) => {
  const real = loadReal(t);
  if (!real) return;
  const { governorConfigure, governorSnapshot } = real.core;
  governorConfigure({ preset: 'eco' }, false);
  const bad = (budget: unknown, expected: RegExp): void => {
    assert.throws(() => governorConfigure(budget as never, false), expected, `budget ${JSON.stringify(budget)}`);
  };
  bad({ preset: 'fast' }, /eco.*balanced.*turbo/);
  bad({ preset: 'eco', cpuPercent: 0 }, /cpuPercent.*1 to 100/);
  bad({ preset: 'eco', cpuPercent: 101 }, /cpuPercent.*1 to 100/);
  bad({ preset: 'eco', cpuPercent: 2.5 }, /cpuPercent/);
  bad({ preset: 'eco', cpuPercent: 'lots' }, /cpuPercent/);
  bad('eco', /preset/);
  bad(null, /preset/);
  bad(undefined, /preset/);
  const after = governorSnapshot();
  assert.deepEqual(after.budget, { preset: 'eco', cpuPercent: null });
  assert.equal(after.effective, 'eco');
});

test(`governorHold(${SMOKE_PERCENT}, ${SMOKE_SECONDS}) measures about twenty samples, holds ten percent within ten points, and hands back the budget it found`, async (t) => {
  const real = loadReal(t);
  if (!real) return;
  const { governorConfigure, governorSnapshot, governorHold } = real.core;
  governorConfigure({ preset: 'eco' }, false);
  const before = governorSnapshot().budget;
  const report = await governorHold(SMOKE_PERCENT, SMOKE_SECONDS);
  t.diagnostic(`governorHold(${SMOKE_PERCENT}, ${SMOKE_SECONDS}) measured: ${report.samples.length} samples, target ${report.target}, mean ${report.mean.toFixed(4)}, mean of the last half ${report.meanLastHalf.toFixed(4)}, p95 |error| ${report.p95AbsError.toFixed(4)}, within band ${report.withinBand}, workers ${report.workersFinal}, duty ${report.dutyFinal.toFixed(3)}`);
  assert.deepEqual(Object.keys(report).sort(), HOLD_REPORT_KEYS, 'the report is the Rust HoldReport in camelCase, in shares');
  const expected = SMOKE_SECONDS * SAMPLES_PER_SECOND;
  assert.ok(Math.abs(report.samples.length - expected) <= 1, `${report.samples.length} samples for ${SMOKE_SECONDS} s`);
  assert.ok(report.samples.every((s) => Number.isFinite(s) && s >= 0 && s <= 1), 'every sample is a share of the machine');
  const share = SMOKE_PERCENT / 100;
  assert.ok(possibleTargets(share).some((x) => Math.abs(report.target - x) < 1e-9), `target ${report.target} is the ${SMOKE_PERCENT}% asked for, or that scaled for heat or interaction`);
  assert.ok(Math.abs(report.mean - share) <= SMOKE_BAND, `mean ${report.mean} is within ${SMOKE_BAND} of ${share}`);
  assert.ok(Number.isFinite(report.meanLastHalf) && Number.isFinite(report.p95AbsError) && report.p95AbsError >= 0);
  assert.equal(typeof report.withinBand, 'boolean');
  assert.ok(Number.isInteger(report.workersFinal) && report.workersFinal >= 1, `workersFinal ${report.workersFinal}`);
  assert.ok(report.dutyFinal >= DUTY_MIN && report.dutyFinal <= 1, `dutyFinal ${report.dutyFinal}`);
  const idle = report.machineIdleLastHalf;
  assert.ok(idle === null || (Number.isFinite(idle) && idle >= 0 && idle <= 1), `machineIdleLastHalf ${idle} is a share of the machine, or null where the OS published none`);
  const after = governorSnapshot();
  assert.deepEqual(after.budget, before, 'the hold restores the budget it found');
  assert.equal(after.effective, 'eco');
});

test('the module survives governorPause()/governorResume(), and a second hold while one runs is refused, not stacked', async (t) => {
  const real = loadReal(t);
  if (!real) return;
  const { governorConfigure, governorSnapshot, governorHold, governorPause, governorResume, version } = real.core;
  governorConfigure({ preset: 'eco' }, false);
  governorPause();
  assert.equal(governorSnapshot().paused, true);
  governorResume();
  assert.equal(governorSnapshot().paused, false);
  governorPause();
  governorPause();
  governorResume();
  assert.equal(governorSnapshot().paused, false, 'pause is a state, not a count');
  assert.equal(version(), pkg.nativeVersion);

  const first = governorHold(SMOKE_PERCENT, 1);
  const startedBy = Date.now() + 2_000;
  while (governorSnapshot().budget.cpuPercent !== SMOKE_PERCENT) {
    assert.ok(Date.now() < startedBy, 'the hold shows its override in the snapshot within two seconds');
    await sleep(20);
  }
  await assert.rejects(governorHold(SMOKE_PERCENT, 1), /already/);
  const report = await first;
  assert.ok(Math.abs(report.samples.length - SAMPLES_PER_SECOND) <= 1, `${report.samples.length} samples for 1 s`);
  assert.deepEqual(governorSnapshot().budget, { preset: 'eco', cpuPercent: null }, 'the refused hold did not disturb the restore');
});

test('a hold outside 1..100 percent or 1..600 seconds is refused with a message, never a crash', async (t) => {
  const real = loadReal(t);
  if (!real) return;
  const { governorHold, governorSnapshot, version } = real.core;
  for (const percent of [0, 0.4, 101, -5, NaN, Infinity]) {
    await assert.rejects(governorHold(percent, 2), /targetPercent.*1 to 100/, `targetPercent ${percent}`);
  }
  for (const seconds of [0, 0.5, 601, -1, NaN, -Infinity]) {
    await assert.rejects(governorHold(10, seconds), /seconds.*1 to 600/, `seconds ${seconds}`);
  }
  assert.equal(version(), pkg.nativeVersion, 'the process and the module are still here');
  assert.equal(typeof governorSnapshot().ticks, 'number');
});

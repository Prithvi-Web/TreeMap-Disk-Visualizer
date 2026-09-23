import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Every write this file causes — settings, mtime caches, snapshots — lands in
// a directory of its own, never in the owner's real app data.
process.env.TREEMAP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-budget-test-'));
process.env.TREEMAP_NO_GDU = '1';

import { getSettings, updateSettings } from '../src/services/settings';
import { loadNative, resetNativeForTests } from '../src/services/scan/native';
import {
  SHIM_DUTY,
  PRESET_CEILING,
  CHILD_PRIORITY,
  MAX_THROTTLE_SLEEP_MS,
  MECHANISM_NAMES,
  CONFIGURE_RETRY_MS,
  applyEngineBudgetSetting,
  applyChildBudget,
  budgetSnapshot,
  childPriority,
  currentEngineBudgetSetting,
  effectiveBudget,
  engineCapabilities,
  forgetScanBudget,
  gduPauseSupport,
  isScanPaused,
  normalizeEngineBudget,
  pauseScan,
  registerPausable,
  resetEngineBudgetForTests,
  resumeScan,
  setClockForTests,
  setNativeLoadOptionsForTests,
  shimWorkerCap,
  throttleBatch,
  throttleSleepMs,
  validateEngineBudget,
  workerCap,
} from '../src/services/engineBudget';
import { allScans, cancelScan, createScanRecord, evictExpiredScans, getScan, startScan } from '../src/services/diskScanner';
import { gduScanIntoStore, runGdu, trackShard } from '../src/services/gduScanner';
import { startScheduler, stopScheduler } from '../src/services/scheduler';
import { loadMain } from './fixtures/desktop/electronStub';
import type { ScanResult } from '../src/models/types';

/**
 * The scanning budget — Eco, Balanced, Turbo — as the app obeys it with or
 * without the native governor (Phase 2, Task 5).
 *
 * The native module is not on disk while this suite runs, so every
 * native-backed path is exercised through `loadNative({ path, requireModule })`
 * with a fake module, and every shim path pins the loader to a path that does
 * not exist so a machine that HAS built the module answers the same way.
 */

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { nativeVersion: string };
const NO_NATIVE = path.join(os.tmpdir(), 'treemap-no-native-here.node');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isWindows = process.platform === 'win32';

/** Pin the shim: the loader looks only at a path that is not there. */
function useShim(): void {
  resetNativeForTests();
  resetEngineBudgetForTests();
  setNativeLoadOptionsForTests({ path: NO_NATIVE });
}

interface FakeSnapshot {
  budget: { preset: 'eco' | 'balanced' | 'turbo'; cpuPercent: number | null };
  effective: 'eco' | 'balanced' | 'turbo';
  targetShare: number;
  share1s: number;
  workers: number;
  duty: number;
  thermal: 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';
  onBattery: boolean | null;
  interacting: boolean | null;
  paused: boolean;
  ticks: number;
  mechanisms: { qos: unknown; io: unknown; priority: unknown };
}

function fakeSnapshot(over: Partial<FakeSnapshot> = {}): FakeSnapshot {
  const m = { available: true, mechanism: 'fake', reason: null };
  return {
    budget: { preset: 'balanced', cpuPercent: null },
    effective: 'balanced',
    targetShare: 0.5,
    share1s: 0.12,
    workers: 4,
    duty: 0.6,
    thermal: 'nominal',
    onBattery: false,
    interacting: false,
    paused: false,
    ticks: 10,
    mechanisms: { qos: m, io: m, priority: m },
    ...over,
  };
}

/** What a test can make the fake do wrong: a snapshot that throws or has the wrong shape, a configure the governor refuses. */
interface FakeHooks {
  governorSnapshot?: () => unknown;
  governorConfigure?: (budget: unknown, auto: boolean) => void;
  governorCapabilities?: () => void;
}

/** A fake tm-node module, injected through the real loader so the version handshake still runs. */
function useFakeNative(snapshot: FakeSnapshot, hooks: FakeHooks = {}) {
  resetNativeForTests();
  resetEngineBudgetForTests();
  const configured: { budget: unknown; auto: boolean }[] = [];
  const mech = (name: string) => ({ available: true, mechanism: name, reason: null });
  const module = {
    version: () => pkg.nativeVersion,
    governorCapabilities: () => {
      hooks.governorCapabilities?.();
      return {
        qos: mech('pthread_set_qos_class_self_np'),
        ioPolicy: mech('setiopolicy_np'),
        priority: mech('setpriority'),
        thermal: mech('NSProcessInfo.thermalState'),
        battery: mech('IOPSGetTimeRemainingEstimate'),
        interaction: mech('CGEventSourceSecondsSinceLastEventType'),
        machineCpu: mech('host_statistics64'),
      };
    },
    governorConfigure: (budget: unknown, auto: boolean) => {
      hooks.governorConfigure?.(budget, auto);
      configured.push({ budget, auto });
    },
    governorSnapshot: () => (hooks.governorSnapshot ? hooks.governorSnapshot() : snapshot),
    governorPause: () => undefined,
    governorResume: () => undefined,
    governorHold: () => Promise.reject(new Error('not in this test')),
  };
  setNativeLoadOptionsForTests({ path: '/fake/treemap_core.node', requireModule: () => module });
  const outcome = loadNative({ path: '/fake/treemap_core.node', requireModule: () => module });
  assert.equal(outcome.available, true, 'the fake must pass the loader’s handshake');
  return { configured, snapshot };
}

/** A synthetic tree: `dirs` folders of `filesPerDir` empty files each. */
async function buildTree(dirs: number, filesPerDir: number, prefix: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  for (let d = 0; d < dirs; d++) {
    const dir = path.join(root, `d${String(d).padStart(4, '0')}`);
    await fsp.mkdir(dir);
    const writes: Promise<void>[] = [];
    for (let f = 0; f < filesPerDir; f++) writes.push(fsp.writeFile(path.join(dir, `f${f}.txt`), ''));
    await Promise.all(writes);
  }
  return root;
}

async function settle(scanId: string, limitMs = 60_000): Promise<ScanResult> {
  const t0 = Date.now();
  for (;;) {
    const s = getScan(scanId);
    assert.ok(s, 'the scan record must exist');
    if (s.status !== 'running') return s;
    assert.ok(Date.now() - t0 < limitMs, `scan ${scanId} never settled`);
    await sleep(20);
  }
}

/* ───────────────────────────── the setting ───────────────────────────── */

test('engineBudget defaults to Automatic with no CPU override', async () => {
  useShim();
  const settings = await getSettings();
  assert.deepEqual(settings.engineBudget, { preset: 'auto', cpuPercent: null });
});

test('a hand-edited settings file is normalised, never trusted: unknown presets and bad percentages fall back', () => {
  assert.deepEqual(normalizeEngineBudget(undefined), { preset: 'auto', cpuPercent: null });
  assert.deepEqual(normalizeEngineBudget('eco'), { preset: 'auto', cpuPercent: null });
  assert.deepEqual(normalizeEngineBudget({ preset: 'ludicrous', cpuPercent: 'lots' }), { preset: 'auto', cpuPercent: null });
  assert.deepEqual(normalizeEngineBudget({ preset: 'eco' }), { preset: 'eco', cpuPercent: null });
  assert.deepEqual(normalizeEngineBudget({ preset: 'turbo', cpuPercent: 42.4 }), { preset: 'turbo', cpuPercent: 42 });
  assert.deepEqual(normalizeEngineBudget({ preset: 'balanced', cpuPercent: 250 }), { preset: 'balanced', cpuPercent: 100 });
  assert.deepEqual(normalizeEngineBudget({ preset: 'balanced', cpuPercent: 0 }), { preset: 'balanced', cpuPercent: null });
  assert.deepEqual(normalizeEngineBudget({ preset: 'balanced', cpuPercent: -5 }), { preset: 'balanced', cpuPercent: null });
});

test('API input is validated strictly: the four presets, cpuPercent 1–100 or null, nothing else', () => {
  const base = { preset: 'auto' as const, cpuPercent: null };
  for (const preset of ['auto', 'eco', 'balanced', 'turbo'] as const) {
    const r = validateEngineBudget({ preset }, base);
    assert.equal(r.ok, true, preset);
    if (r.ok) assert.deepEqual(r.value, { preset, cpuPercent: null });
  }
  const pct = validateEngineBudget({ cpuPercent: 35 }, { preset: 'eco', cpuPercent: null });
  assert.equal(pct.ok, true);
  if (pct.ok) assert.deepEqual(pct.value, { preset: 'eco', cpuPercent: 35 }, 'a patch keeps the preset it did not mention');
  const cleared = validateEngineBudget({ cpuPercent: null }, { preset: 'eco', cpuPercent: 35 });
  assert.equal(cleared.ok, true);
  if (cleared.ok) assert.deepEqual(cleared.value, { preset: 'eco', cpuPercent: null });

  for (const bad of [
    'eco', null, 7, [], {},
    { preset: 'fast' }, { preset: 1 },
    { cpuPercent: 0 }, { cpuPercent: 101 }, { cpuPercent: '50' }, { cpuPercent: NaN }, { cpuPercent: true },
    { preset: 'eco', watts: 3 },
  ]) {
    const r = validateEngineBudget(bad, base);
    assert.equal(r.ok, false, JSON.stringify(bad));
    if (!r.ok) assert.ok(r.reason.length > 10, r.reason);
  }
});

/* ───────────────────────── the effective preset ───────────────────────── */

test('without the native core, Automatic is Balanced and the source says so', () => {
  useShim();
  assert.deepEqual(effectiveBudget({ preset: 'auto', cpuPercent: null }), { preset: 'balanced', targetShare: 0.5, source: 'node-shim' });
  assert.deepEqual(effectiveBudget({ preset: 'eco', cpuPercent: null }), { preset: 'eco', targetShare: 0.25, source: 'node-shim' });
  assert.deepEqual(effectiveBudget({ preset: 'turbo', cpuPercent: null }), { preset: 'turbo', targetShare: 0.9, source: 'node-shim' });
  assert.deepEqual(effectiveBudget({ preset: 'eco', cpuPercent: 40 }), { preset: 'eco', targetShare: 0.4, source: 'node-shim' }, 'a percentage replaces the ceiling and keeps the preset');
  const state = budgetSnapshot();
  assert.equal(state.source, 'node-shim');
  assert.equal(state.native.available, false);
  assert.ok(state.native.reason && state.native.reason.includes(NO_NATIVE), state.native.reason ?? '');
  assert.equal(state.snapshot, null, 'nothing was measured, so nothing is reported');
});

test('with the native governor, Automatic follows the machine: Eco on battery or when thermal is serious or critical', () => {
  const auto = { preset: 'auto' as const, cpuPercent: null };
  let native = useFakeNative(fakeSnapshot({ onBattery: false, thermal: 'nominal', targetShare: 0.5 }));
  assert.deepEqual(effectiveBudget(auto), { preset: 'balanced', targetShare: 0.5, source: 'native' });

  native = useFakeNative(fakeSnapshot({ onBattery: true, thermal: 'nominal', targetShare: 0.25 }));
  assert.equal(effectiveBudget(auto).preset, 'eco', 'on battery');
  assert.equal(effectiveBudget(auto).source, 'native');

  native = useFakeNative(fakeSnapshot({ onBattery: false, thermal: 'serious', targetShare: 0.125 }));
  assert.equal(effectiveBudget(auto).preset, 'eco', 'thermal serious');
  native = useFakeNative(fakeSnapshot({ onBattery: false, thermal: 'critical' }));
  assert.equal(effectiveBudget(auto).preset, 'eco', 'thermal critical');
  native = useFakeNative(fakeSnapshot({ onBattery: null, thermal: 'fair' }));
  assert.equal(effectiveBudget(auto).preset, 'balanced', 'fair is not serious, and an unknown battery is not a battery');
  native = useFakeNative(fakeSnapshot({ onBattery: true }));
  assert.equal(effectiveBudget({ preset: 'turbo', cpuPercent: null }).preset, 'turbo', 'an explicit preset is never overridden');

  // Applying the setting configures the governor, live, with the auto flag.
  applyEngineBudgetSetting({ preset: 'auto', cpuPercent: null });
  applyEngineBudgetSetting({ preset: 'eco', cpuPercent: 30 });
  assert.deepEqual(native.configured, [
    { budget: { preset: 'balanced', cpuPercent: null }, auto: true },
    { budget: { preset: 'eco', cpuPercent: 30 }, auto: false },
  ]);
  const state = budgetSnapshot();
  assert.equal(state.source, 'native');
  assert.equal(state.native.available, true);
  assert.equal(state.native.version, pkg.nativeVersion);
  assert.deepEqual(state.snapshot, native.snapshot, 'the governor’s own snapshot, verbatim');
  useShim();
});

test('capabilities name the seven mechanisms, or say for each why nothing is there', () => {
  useShim();
  const absent = engineCapabilities();
  assert.equal(absent.source, 'node-shim');
  assert.equal(absent.native.available, false);
  const names = ['qos', 'ioPolicy', 'priority', 'thermal', 'battery', 'interaction', 'machineCpu'];
  assert.deepEqual(Object.keys(absent.mechanisms), names);
  for (const name of names) {
    const m = absent.mechanisms[name as keyof typeof absent.mechanisms];
    assert.equal(m.available, false, name);
    assert.ok(typeof m.reason === 'string' && m.reason.length > 10, `${name} says why`);
    assert.equal(typeof m.mechanism, 'string');
  }
  useFakeNative(fakeSnapshot());
  const present = engineCapabilities();
  assert.equal(present.source, 'native');
  assert.equal(present.mechanisms.qos.mechanism, 'pthread_set_qos_class_self_np');
  assert.equal(present.mechanisms.machineCpu.available, true);
  useShim();
});

/* ─────────────────────────── the shim’s duty ─────────────────────────── */

test('the shim’s duty per preset is the documented table, and the throttle sleep follows (1 − duty) / duty × elapsed, capped at one second', () => {
  assert.deepEqual(SHIM_DUTY, { eco: 0.25, balanced: 0.5, turbo: 1 });
  assert.deepEqual(PRESET_CEILING, { eco: 0.25, balanced: 0.5, turbo: 0.9 });
  assert.equal(MAX_THROTTLE_SLEEP_MS, 1000);
  assert.equal(throttleSleepMs(0.25, 40), 120, 'eco: three units of rest per unit of work');
  assert.equal(throttleSleepMs(0.5, 40), 40, 'balanced: one for one');
  assert.equal(throttleSleepMs(1, 40), 0, 'turbo never sleeps');
  assert.equal(throttleSleepMs(0.25, 5000), 1000, 'capped, so one slow batch cannot park a worker for a minute');
  assert.equal(throttleSleepMs(0.25, 0), 0);
  assert.equal(throttleSleepMs(0, 40), 0, 'a zero duty is not a reason to sleep forever');
});

test('throttleBatch measures from the caller’s previous call: the first call is free, Eco rests three times the work, Turbo never rests, and completion forgets the caller', async () => {
  useShim();
  applyEngineBudgetSetting({ preset: 'eco', cpuPercent: null });
  const id = 'throttle-eco';
  let t0 = performance.now();
  await throttleBatch(id);
  assert.ok(performance.now() - t0 < 15, 'nothing measured yet, nothing to rest for');

  await sleep(40); // the "work"
  t0 = performance.now();
  await throttleBatch(id);
  const rested = performance.now() - t0;
  assert.ok(rested >= 100 && rested < 400, `eco rested ${rested.toFixed(0)} ms after ~40 ms of work (expected ≈120)`);

  forgetScanBudget(id);
  await sleep(40);
  t0 = performance.now();
  await throttleBatch(id);
  assert.ok(performance.now() - t0 < 15, 'a forgotten caller starts afresh');

  applyEngineBudgetSetting({ preset: 'turbo', cpuPercent: null });
  const turbo = 'throttle-turbo';
  await throttleBatch(turbo);
  await sleep(40);
  t0 = performance.now();
  await throttleBatch(turbo);
  assert.ok(performance.now() - t0 < 15, 'turbo does not sleep');

  applyEngineBudgetSetting({ preset: 'auto', cpuPercent: null });
  forgetScanBudget(id);
  forgetScanBudget(turbo);
});

test('with the native governor the duty comes from its snapshot', async () => {
  useFakeNative(fakeSnapshot({ duty: 0.2 }));
  const id = 'throttle-native';
  await throttleBatch(id);
  await sleep(30);
  const t0 = performance.now();
  await throttleBatch(id);
  const rested = performance.now() - t0;
  assert.ok(rested >= 90 && rested < 400, `duty 0.2 rests four units per unit of work: ${rested.toFixed(0)} ms after ~30 ms`);
  forgetScanBudget(id);
  useShim();
});

/* ───────────────────────── workers and priorities ───────────────────────── */

test('the worker cap follows the preset table on this machine’s cores, and the governor’s own count when it is there', () => {
  assert.equal(shimWorkerCap('eco', 8), 2);
  assert.equal(shimWorkerCap('eco', 1), 1);
  assert.equal(shimWorkerCap('balanced', 8), 4);
  assert.equal(shimWorkerCap('balanced', 1), 1);
  assert.equal(shimWorkerCap('turbo', 8), 8);
  useShim();
  const cores = Math.max(1, os.cpus().length);
  applyEngineBudgetSetting({ preset: 'eco', cpuPercent: null });
  assert.equal(workerCap(), Math.min(2, cores));
  applyEngineBudgetSetting({ preset: 'turbo', cpuPercent: null });
  assert.equal(workerCap(), cores);
  applyEngineBudgetSetting({ preset: 'auto', cpuPercent: null });
  useFakeNative(fakeSnapshot({ workers: 3 }));
  assert.equal(workerCap(), 3);
  useShim();
});

test('child priority is 10 under Eco, 5 under Balanced, 0 under Turbo', () => {
  assert.deepEqual(CHILD_PRIORITY, { eco: 10, balanced: 5, turbo: 0 });
  useShim();
  applyEngineBudgetSetting({ preset: 'eco', cpuPercent: null });
  assert.equal(childPriority(), 10);
  applyEngineBudgetSetting({ preset: 'auto', cpuPercent: null });
  assert.equal(childPriority(), 5, 'Automatic without the native core is Balanced');
  applyEngineBudgetSetting({ preset: 'turbo', cpuPercent: null });
  assert.equal(childPriority(), 0);
  applyEngineBudgetSetting({ preset: 'auto', cpuPercent: null });
});

/** A gdu stand-in: waits, then writes one valid gdu document for the folder it was given. */
/**
 * A stand-in for gdu that works for about `holdMs` and then writes a
 * one-file result. Real gdu is ONE process, so a SIGSTOP freezes all of its
 * work and a SIGKILL ends all of it. The work here is therefore a loop of
 * 10 ms steps: a SIGSTOP stops the loop between steps, and a SIGKILL leaves
 * at most one 10 ms `sleep` behind. The first version slept once, in a child
 * the SIGSTOP never reached — on Linux its work finished during the pause
 * (458 ms held of 700) and, killed, it orphaned a `sleep 5` that kept the
 * pipes open past the evictor's two seconds.
 */
async function fakeGdu(dir: string, holdMs: number): Promise<string> {
  const bin = path.join(dir, 'fake-gdu.sh');
  await fsp.writeFile(bin, [
    '#!/bin/sh',
    'out=""',
    'while [ $# -gt 1 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done',
    'target="$1"',
    'i=0',
    `while [ $i -lt ${Math.max(1, Math.ceil(holdMs / 10))} ]; do sleep 0.01; i=$((i + 1)); done`,
    'printf \'[1,2,{"progname":"gdu","progver":"v5.36.1","timestamp":1},[{"name":"%s","mtime":1},{"name":"a.txt","asize":5,"dsize":4096,"mtime":1}]]\' "$target" > "$out"',
  ].join('\n'), { mode: 0o755 });
  return bin;
}

/**
 * Resolves once the stand-in has a child process, i.e. once its work is
 * under way. A pause must land mid-work to test anything: at spawn it lands
 * before the shell has started, and a stand-in whose work outlives a SIGSTOP
 * then passes by luck — which is how the old one (one `sleep` child) passed on
 * macOS, whose shell starts slowly, and failed on Linux, whose `dash` does not.
 */
async function whenWorking(pid: number, limitMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim() === '') {
    assert.ok(Date.now() - t0 < limitMs, `the stand-in (pid ${pid}) started no work within ${limitMs} ms`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

test('gdu shards are started with os.setPriority(pid, 10) under Eco, through the scanner’s own onSpawn hook', { skip: isWindows && 'the stand-in is a shell script' }, async () => {
  useShim();
  applyEngineBudgetSetting({ preset: 'eco', cpuPercent: null });
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-gdu-prio-'));
  await fsp.mkdir(path.join(root, 'one'));
  await fsp.mkdir(path.join(root, 'two'));
  const bin = await fakeGdu(root, 50);
  const seen: { pid: number; priority: number }[] = [];
  const real = os.setPriority;
  (os as { setPriority: typeof os.setPriority }).setPriority = ((pid: number, priority: number) => {
    seen.push({ pid, priority });
    return real.call(os, pid, priority);
  }) as typeof os.setPriority;
  try {
    const scan = createScanRecord(root);
    scan.engine = 'gdu-turbo';
    await gduScanIntoStore(scan, bin, () => undefined);
    const shards = seen.filter((s) => s.priority === 10);
    assert.equal(shards.length, 2, `one call per shard: ${JSON.stringify(seen)}`);
    for (const s of shards) assert.ok(Number.isInteger(s.pid) && s.pid > 0 && s.pid !== process.pid, 'the child’s pid, not ours');

    seen.length = 0;
    applyEngineBudgetSetting({ preset: 'turbo', cpuPercent: null });
    const fast = createScanRecord(root);
    fast.engine = 'gdu-turbo';
    await gduScanIntoStore(fast, bin, () => undefined);
    assert.deepEqual(seen, [], 'Turbo leaves the child at the app’s own priority rather than asking the OS for a no-op');
  } finally {
    (os as { setPriority: typeof os.setPriority }).setPriority = real;
    applyEngineBudgetSetting({ preset: 'auto', cpuPercent: null });
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('applyChildBudget never throws for a child that is already gone', () => {
  useShim();
  applyEngineBudgetSetting({ preset: 'eco', cpuPercent: null });
  // pid 2^22 is above every real pid table; setPriority answers ESRCH.
  assert.doesNotThrow(() => applyChildBudget('gone', { pid: 4_194_304 }));
  assert.doesNotThrow(() => applyChildBudget('gone', { pid: undefined }));
  applyEngineBudgetSetting({ preset: 'auto', cpuPercent: null });
});

/* ───────────────────────────── pause / resume ───────────────────────────── */

test('pausing a running walker halts `scanned` within 200 ms and resuming lets it finish with every entry counted', async () => {
  useShim();
  await updateSettings({ engineBudget: { preset: 'eco', cpuPercent: null } });
  const root = await buildTree(120, 100, 'treemap-pause-walker-');
  // One folder of 8,000 entries, and the pause lands INSIDE it: a gate that
  // only sat between folders would keep counting this one to its end, which
  // is exactly the "seconds after the person pressed pause" the batch-loop
  // gate exists to prevent.
  const big = path.join(root, 'zz-big');
  await fsp.mkdir(big);
  for (let f = 0; f < 8_000; f += 500) {
    await Promise.all(Array.from({ length: 500 }, (_, i) => fsp.writeFile(path.join(big, `f${f + i}.txt`), '')));
  }
  const total = 1 + 121 + 120 * 100 + 8_000;
  try {
    const scan = await startScan(root);
    const t0 = Date.now();
    while (scan.status === 'running' && scan.currentPath !== big) {
      assert.ok(Date.now() - t0 < 20_000, 'the walker never reached the big folder');
      await sleep(2);
    }
    const atEntry = scan.scanned;
    while (scan.status === 'running' && scan.scanned < atEntry + 300) {
      assert.ok(Date.now() - t0 < 20_000, 'the walker never got into the big folder');
      await sleep(2);
    }
    assert.equal(scan.status, 'running', 'too fast to pause — the tree must be bigger');

    const outcome = pauseScan(scan);
    assert.deepEqual({ paused: outcome.paused, supported: outcome.supported, scanId: outcome.scanId, source: outcome.source },
      { paused: true, supported: true, scanId: scan.scanId, source: 'node-shim' });
    assert.equal(isScanPaused(scan.scanId), true);
    await sleep(200);
    const halted = scan.scanned;
    await sleep(300);
    assert.equal(scan.scanned, halted, 'scanned kept moving while paused');
    assert.equal(scan.status, 'running', 'paused is still running, not finished');
    assert.ok(halted < total, 'it really was paused mid-way');

    const again = pauseScan(scan);
    assert.equal(again.paused, true, 'pausing twice is still paused');

    const resumed = resumeScan(scan);
    assert.equal(resumed.paused, false);
    assert.equal(isScanPaused(scan.scanId), false);
    const t1 = Date.now();
    while (scan.scanned === halted && scan.status === 'running') {
      assert.ok(Date.now() - t1 < 5_000, 'scanned did not move after resume');
      await sleep(5);
    }
    const done = await settle(scan.scanId);
    assert.equal(done.status, 'complete');
    assert.equal(done.scanned, total, 'every folder and file was counted once');
    assert.equal(isScanPaused(scan.scanId), false, 'completion clears the pause state');
  } finally {
    await updateSettings({ engineBudget: { preset: 'auto', cpuPercent: null } });
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('cancelling a paused scan releases it: the walker does not wait forever', async () => {
  useShim();
  await updateSettings({ engineBudget: { preset: 'eco', cpuPercent: null } });
  const root = await buildTree(60, 100, 'treemap-pause-cancel-');
  try {
    const scan = await startScan(root);
    while (scan.scanned < 300 && scan.status === 'running') await sleep(5);
    assert.equal(pauseScan(scan).paused, true);
    await sleep(50);
    assert.equal(cancelScan(scan.scanId), true);
    assert.equal(isScanPaused(scan.scanId), false, 'a cancelled scan is not paused');
    assert.equal(scan.status, 'error');
    // The walker's promise must settle rather than hang on the pause gate.
    const settledAt = Date.now();
    const s = await settle(scan.scanId, 5_000);
    assert.equal(s.status, 'error');
    assert.ok(Date.now() - settledAt < 5_000);
  } finally {
    await updateSettings({ engineBudget: { preset: 'auto', cpuPercent: null } });
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('pausing a scan that has already finished says so rather than pretending', () => {
  useShim();
  const scan = createScanRecord('/finished');
  scan.status = 'complete';
  scan.finishedAt = Date.now();
  const r = pauseScan(scan);
  assert.equal(r.paused, false);
  assert.ok(r.reason && /finished/.test(r.reason), r.reason);
  assert.equal(resumeScan(scan).paused, false);
});

test('a gdu scan is paused by stopping its shard, and on Windows the refusal is stated — never a silent no-op', () => {
  useShim();
  const scan = createScanRecord('/gdu-root');
  scan.engine = 'gdu-turbo';
  const calls: string[] = [];
  registerPausable(scan.scanId, { pause: () => { calls.push('pause'); }, resume: () => { calls.push('resume'); } });
  try {
    const win = pauseScan(scan, { platformName: 'windows' });
    assert.equal(win.paused, false);
    assert.equal(win.supported, false);
    assert.ok(win.reason && /Windows/.test(win.reason), win.reason);
    assert.deepEqual(calls, [], 'nothing was signalled');
    assert.equal(isScanPaused(scan.scanId), false);

    const posix = pauseScan(scan, { platformName: 'macos' });
    assert.deepEqual({ paused: posix.paused, supported: posix.supported }, { paused: true, supported: true });
    assert.deepEqual(calls, ['pause']);
    assert.equal(resumeScan(scan).paused, false);
    assert.deepEqual(calls, ['pause', 'resume']);
    assert.deepEqual(gduPauseSupport('windows').supported, false);
    assert.deepEqual(gduPauseSupport('linux'), { supported: true });
  } finally {
    forgetScanBudget(scan.scanId);
  }
});

test('a shard’s controls really stop the process: SIGSTOP shows as a stopped state, and the shard finishes after SIGCONT', { skip: isWindows && 'no SIGSTOP on Windows' }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-gdu-stop-'));
  const bin = await fakeGdu(root, 300);
  try {
    const out = path.join(root, 'shard.json');
    let pid = 0;
    let stateWhileStopped = '';
    const t0 = Date.now();
    await runGdu(bin, root, out, {
      onSpawn: (child, shard) => {
        pid = child.pid ?? 0;
        // Paused mid-work, as a user pauses a scan (see whenWorking).
        void whenWorking(pid).then(() => {
          shard.pause();
          setTimeout(() => {
            const ps = spawnSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' });
            stateWhileStopped = ps.stdout.trim();
            shard.resume();
          }, 400);
        });
      },
    });
    const took = Date.now() - t0;
    assert.ok(pid > 0);
    assert.match(stateWhileStopped, /^T/, `the process state while paused should read T (stopped), got "${stateWhileStopped}"`);
    assert.ok(took >= 650, `the shard was held for the pause: ${took} ms`);
    assert.ok(fs.existsSync(out), 'and then finished its work');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('the six-hour evictor kills a paused gdu shard instead of leaving it stopped forever', { skip: isWindows && 'no SIGSTOP on Windows' }, async () => {
  // A scan paused and forgotten: pause() SIGSTOPs the shard and disarms its
  // own deadline, so nothing but the eviction can ever end that process. The
  // review of this phase found the hard-cap sweep dropping the record while
  // the stopped child lived on with its file descriptors and temp directory.
  useShim();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'treemap-evict-stopped-'));
  const bin = await fakeGdu(root, 5000);
  const scan = createScanRecord(root);
  scan.engine = 'gdu-turbo';
  let child: ChildProcess | undefined;
  try {
    const shard = runGdu(bin, root, path.join(root, 'shard.json'), {
      onSpawn: (c, controls) => {
        child = c;
        trackShard(scan.scanId, c); // exactly as gduScanIntoStore registers a shard
        registerPausable(scan.scanId, controls);
      },
    }).then(() => 'finished', (err: Error) => err);
    while (!child) await sleep(5);
    await whenWorking(child.pid ?? 0); // mid-work, as in the pause test above
    assert.equal(pauseScan(scan).paused, true);
    await sleep(150);
    const state = spawnSync('ps', ['-o', 'state=', '-p', String(child.pid)], { encoding: 'utf8' }).stdout.trim();
    assert.match(state, /^T/, `the shard is stopped before the eviction, got "${state}"`);

    scan.createdAt = Date.now() - 7 * 60 * 60 * 1000; // past the six-hour hard cap
    assert.deepEqual(evictExpiredScans(), [scan.scanId]);
    const outcome = await Promise.race([shard, sleep(2000).then(() => 'still stopped')]);
    assert.ok(outcome instanceof Error, `the eviction ends the stopped shard; the shard reported: ${String(outcome)}`);
    assert.equal(getScan(scan.scanId), undefined);
    assert.equal(isScanPaused(scan.scanId), false);
  } finally {
    cancelScan(scan.scanId);
    child?.kill('SIGKILL'); // a red run must not leave the stopped shard holding this process open
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/* ───────────────────────────── a governor that loaded but is not in force ───────────────────────────── */

function capturingWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  return { lines, restore: () => { console.warn = real; } };
}

test('a governor whose snapshot throws is not the source of any number, says so once, and is reported back once it answers again', async () => {
  let broken = true;
  const { snapshot } = useFakeNative(fakeSnapshot({ targetShare: 0.5, duty: 0.5 }), {
    governorSnapshot: () => { if (broken) throw new Error('the loop is poisoned'); return snapshot; },
  });
  const warn = capturingWarn();
  try {
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(effectiveBudget({ preset: 'auto', cpuPercent: null }), { preset: 'balanced', targetShare: PRESET_CEILING.balanced, source: 'node-shim' }, 'the ceiling is the shim table, and the answer says so');
      const state = budgetSnapshot();
      assert.equal(state.source, 'node-shim');
      assert.equal(state.snapshot, null);
      assert.deepEqual(state.native, { available: true, version: pkg.nativeVersion, reason: 'the native governor could not report its state: the loop is poisoned' });
    }
    const record = createScanRecord('/nowhere-fault');
    try {
      assert.equal(pauseScan(record).source, 'node-shim', 'a pause reply does not claim the governor either');
    } finally {
      cancelScan(record.scanId);
    }
    assert.equal(warn.lines.length, 1, `one line for the fault, not one per read: ${warn.lines.join(' | ')}`);
    assert.match(warn.lines[0], /the loop is poisoned/);

    broken = false;
    assert.deepEqual(effectiveBudget({ preset: 'auto', cpuPercent: null }), { preset: 'balanced', targetShare: 0.5, source: 'native' });
    assert.equal(budgetSnapshot().native.reason, null);
    assert.equal(warn.lines.length, 2, 'the recovery is logged once');
    assert.match(warn.lines[1], /back in force/);
  } finally {
    warn.restore();
  }
});

test('capabilities the core could not report are not reported as the core’s', () => {
  useFakeNative(fakeSnapshot({}), { governorCapabilities: () => { throw new Error('probe crashed'); } });
  const warn = capturingWarn();
  try {
    const caps = engineCapabilities();
    assert.equal(caps.source, 'node-shim');
    assert.equal(caps.native.available, true);
    assert.match(caps.native.reason ?? '', /could not report its mechanisms: probe crashed/);
    for (const name of MECHANISM_NAMES) assert.equal(caps.mechanisms[name].available, false);
  } finally {
    warn.restore();
  }
});

test('a snapshot with the wrong shape is refused like a throw, naming the field', () => {
  useFakeNative(fakeSnapshot({}), { governorSnapshot: () => ({ ...fakeSnapshot({}), targetShare: 'half' }) });
  const warn = capturingWarn();
  try {
    assert.equal(effectiveBudget({ preset: 'turbo', cpuPercent: null }).source, 'node-shim');
    assert.match(budgetSnapshot().native.reason ?? '', /"targetShare" is not a finite number/);
  } finally {
    warn.restore();
  }
});

test('a configure the governor refuses is not pretended: the shim rules apply, the fault is stated, the next apply retries', () => {
  let refuse = true;
  const { configured, snapshot } = useFakeNative(fakeSnapshot({ targetShare: 0.5, duty: 0.5 }), {
    governorConfigure: () => { if (refuse) throw new Error('no such preset here'); },
  });
  const warn = capturingWarn();
  try {
    applyEngineBudgetSetting({ preset: 'eco', cpuPercent: null });
    assert.equal(configured.length, 0, 'the refused configure recorded nothing');
    assert.deepEqual(effectiveBudget(), { preset: 'eco', targetShare: PRESET_CEILING.eco, source: 'node-shim' }, 'Eco at the shim ceiling, not the governor’s stale 0.5');
    const state = budgetSnapshot();
    assert.equal(state.source, 'node-shim');
    assert.equal(state.snapshot, null, 'a snapshot of a budget the governor never adopted is not shown');
    assert.match(state.native.reason ?? '', /the native governor refused the budget: no such preset here/);
    assert.equal(warn.lines.length, 1);

    refuse = false;
    applyEngineBudgetSetting({ preset: 'eco', cpuPercent: null }); // the same setting again: still retried, because the last one failed
    assert.equal(configured.length, 1);
    assert.deepEqual(effectiveBudget(), { preset: 'eco', targetShare: snapshot.targetShare, source: 'native' });
    assert.equal(budgetSnapshot().native.reason, null);
  } finally {
    warn.restore();
  }
});

test('a refused configure is retried on its own after the retry window, without a new setting', () => {
  let refuse = true;
  const { configured } = useFakeNative(fakeSnapshot({}), { governorConfigure: () => { if (refuse) throw new Error('busy'); } });
  const warn = capturingWarn();
  try {
    let now = 1_000_000;
    setClockForTests(() => now);
    applyEngineBudgetSetting({ preset: 'turbo', cpuPercent: null });
    refuse = false;
    assert.equal(effectiveBudget().source, 'node-shim', 'inside the window nothing is retried');
    now += CONFIGURE_RETRY_MS + 1;
    assert.equal(effectiveBudget().source, 'native', 'past the window the read retries the configure');
    assert.equal(configured.length, 1);
  } finally {
    setClockForTests(null);
    warn.restore();
  }
});

test('throttleBatch parks a worker while the governor reports itself paused, and lets it go when it is not', async () => {
  const { snapshot } = useFakeNative(fakeSnapshot({ duty: 0.5, paused: false }));
  const scanId = 'paused-by-heat';
  try {
    await throttleBatch(scanId, 0); // stamps the clock while the governor is running
    snapshot.paused = true; // critical heat, or a caller's pause
    let done = false;
    const second = throttleBatch(scanId, 0).then(() => { done = true; });
    await sleep(400);
    assert.equal(done, false, 'the worker is parked while the governor is paused');
    snapshot.paused = false;
    await second;
    assert.equal(done, true);
  } finally {
    forgetScanBudget(scanId);
  }
});

test('a parked worker is released when its scan is forgotten, so a cancel never waits on the weather', async () => {
  const { snapshot } = useFakeNative(fakeSnapshot({ duty: 0.5, paused: false }));
  const scanId = 'paused-then-forgotten';
  await throttleBatch(scanId, 0);
  snapshot.paused = true;
  let done = false;
  const second = throttleBatch(scanId, 0).then(() => { done = true; });
  await sleep(300);
  assert.equal(done, false);
  forgetScanBudget(scanId);
  await second;
  assert.equal(done, true);
});

test('applyEngineBudgetSetting normalises what it is handed, so a NaN ceiling can never reach the wire', () => {
  useShim();
  applyEngineBudgetSetting({ preset: 'balanced', cpuPercent: Number.NaN });
  assert.deepEqual(currentEngineBudgetSetting(), { preset: 'balanced', cpuPercent: null });
  assert.equal(Number.isFinite(effectiveBudget().targetShare), true);
  applyEngineBudgetSetting({ preset: 'weird' as never, cpuPercent: 250 });
  assert.deepEqual(currentEngineBudgetSetting(), { preset: 'auto', cpuPercent: 100 });
});

test('forgetting a paused scan lets its stopped shard continue before the state is dropped', () => {
  useShim();
  const record = createScanRecord('/nowhere-forget');
  const calls: string[] = [];
  try {
    registerPausable(record.scanId, { pause: () => { calls.push('pause'); }, resume: () => { calls.push('resume'); } });
    assert.equal(pauseScan(record).paused, true);
    assert.deepEqual(calls, ['pause']);
  } finally {
    cancelScan(record.scanId); // cancel forgets the budget state, which must not leave the shard stopped
  }
  assert.deepEqual(calls, ['pause', 'resume']);
});

/* ───────────────────────────── scheduled scans ───────────────────────────── */

test('a scheduled scan runs Eco whatever the setting says', async () => {
  useShim();
  const root = await buildTree(3, 5, 'treemap-sched-eco-');
  const before = new Set(allScans().map((s) => s.scanId));
  try {
    await updateSettings({
      engineBudget: { preset: 'turbo', cpuPercent: null },
      schedules: [{ id: 'budget-sched', path: root, intervalHours: 24, enabled: true }],
    });
    startScheduler();
    let scan: ScanResult | undefined;
    const t0 = Date.now();
    while (!scan) {
      scan = allScans().find((s) => s.rootPath === root && !before.has(s.scanId));
      assert.ok(Date.now() - t0 < 10_000, 'the scheduler never started the due scan');
      if (!scan) await sleep(20);
    }
    assert.deepEqual(scan.budget, { preset: 'eco', effective: 'eco', source: 'node-shim' });
    const done = await settle(scan.scanId);
    assert.equal(done.status, 'complete');
    assert.deepEqual(done.budget, { preset: 'eco', effective: 'eco', source: 'node-shim' }, 'the record keeps what it ran under');

    const user = await startScan(root);
    assert.deepEqual(user.budget, { preset: 'turbo', effective: 'turbo', source: 'node-shim' }, 'a scan the user starts keeps the setting');
    await settle(user.scanId);
  } finally {
    stopScheduler();
    await updateSettings({ engineBudget: { preset: 'auto', cpuPercent: null }, schedules: [] });
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/* ───────────────────────── the walker’s CPU share ───────────────────────── */

interface ChildRun { preset: string; wallMs: number; cpuMs: number; scanned: number; status: string; budget: unknown }

function runChild(preset: string, tree: string): ChildRun {
  const tsxCli = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
  const script = path.join(__dirname, 'fixtures', 'engineBudgetChild.ts');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `treemap-budget-child-${preset}-`));
  try {
    const r = spawnSync(process.execPath, [tsxCli, script, preset, tree, dataDir], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 0, `child (${preset}) failed: ${r.stderr}\n${r.stdout}`);
    const line = r.stdout.trim().split('\n').pop() ?? '';
    return JSON.parse(line) as ChildRun;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('the walker under Eco keeps its process at or under 30% of the machine, and Turbo finishes sooner (20k entries, child process)', async () => {
  const cores = Math.max(1, os.cpus().length);
  const tree = await buildTree(200, 100, 'treemap-budget-share-');
  try {
    runChild('turbo', tree); // warm the page cache so neither timed run pays for cold metadata
    const eco = runChild('eco', tree);
    const turbo = runChild('turbo', tree);
    const load = os.loadavg()[0];
    const share = (r: ChildRun): number => r.cpuMs / (r.wallMs * cores);
    const busy = (r: ChildRun): number => r.cpuMs / r.wallMs;
    const diag = `eco: share ${share(eco).toFixed(3)} (${busy(eco).toFixed(2)} cores busy, ${eco.wallMs.toFixed(0)} ms wall, ${eco.cpuMs.toFixed(0)} ms cpu) · ` +
      `turbo: share ${share(turbo).toFixed(3)} (${busy(turbo).toFixed(2)} cores busy, ${turbo.wallMs.toFixed(0)} ms wall) · ` +
      `${cores} cores, 1-minute load ${load.toFixed(2)}` +
      (load > cores * 0.75 ? ' — the machine is busy with other work, which stretches wall time and can make Turbo look slower than it is' : '');

    for (const r of [eco, turbo]) {
      assert.equal(r.status, 'complete', diag);
      assert.equal(r.scanned, 1 + 200 + 200 * 100, diag);
    }
    assert.deepEqual(eco.budget, { preset: 'eco', effective: 'eco', source: 'node-shim' });
    assert.ok(eco.wallMs >= 100, `the Eco run must be long enough to measure: ${diag}`);
    // The share is the whole process against the whole machine. Measured on
    // this Mac (8 cores): Eco 0.19 with 1.5 cores busy, Turbo 0.44 with 3.5 —
    // the walker's CPU is mostly the lstat storm in the 16-thread pool, so a
    // wall-time duty of 0.25 does not read as 0.25 of one core, and no bound
    // on "cores busy" would say anything true about the duty. An Eco that never
    // rested measured 0.38 here, so the 0.30 bound is what the duty holds.
    assert.ok(share(eco) <= 0.30, `Eco must stay at or under 30% of the machine: ${diag}`);
    assert.ok(turbo.wallMs < eco.wallMs, `Turbo must finish sooner than Eco: ${diag}`);
  } finally {
    await fsp.rm(tree, { recursive: true, force: true });
  }
});

/* ─────────────────────────── sleep and wake (Electron) ─────────────────────────── */

test('main: sleep pauses every running scan and wake resumes exactly those', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-power-'));
  const h = await loadMain({ dataDir: dir });
  try {
    const running = (id: string): (typeof h.stub.backend.scans)[number] => ({ scanId: id, rootPath: `/${id}`, status: 'running', scanned: 0, fileCount: 0, dirCount: 0, currentPath: '/', startedAt: 1, createdAt: 1, cancelled: false });
    h.stub.backend.scans = [running('a'), { ...running('b'), status: 'complete' }, running('c')];
    h.stub.backend.pausedIds.add('c'); // the user paused this one before closing the lid
    h.stub.electron.powerMonitor.emit('suspend');
    assert.deepEqual(h.stub.backend.paused, ['a'], 'running scans are paused; finished and already-paused ones are left alone');
    h.stub.electron.powerMonitor.emit('resume');
    assert.deepEqual(h.stub.backend.resumed, ['a'], 'only what sleep paused is resumed — the user’s own pause survives the nap');
    h.stub.electron.powerMonitor.emit('resume');
    assert.deepEqual(h.stub.backend.resumed, ['a'], 'a second wake resumes nothing twice');
  } finally {
    h.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main: a scan that cannot be paused for sleep is logged and left alone, never resumed as if it had been', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-power-refused-'));
  const h = await loadMain({ dataDir: dir });
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
  try {
    const running = (id: string): (typeof h.stub.backend.scans)[number] => ({ scanId: id, rootPath: `/${id}`, status: 'running', scanned: 0, fileCount: 0, dirCount: 0, currentPath: '/', startedAt: 1, createdAt: 1, cancelled: false });
    h.stub.backend.scans = [running('a'), running('d')];
    h.stub.backend.unpausable.add('d');
    h.stub.electron.powerMonitor.emit('suspend');
    assert.deepEqual(h.stub.backend.paused, ['a'], 'the refusing scan is not counted as paused');
    assert.equal(warned.length, 1, 'the refusal is logged once');
    assert.match(warned[0], /could not pause the scan of \/d for sleep: the stand-in cannot pause this engine/);
    h.stub.electron.powerMonitor.emit('resume');
    assert.deepEqual(h.stub.backend.resumed, ['a'], 'wake resumes only what sleep actually paused');
  } finally {
    console.warn = realWarn;
    h.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

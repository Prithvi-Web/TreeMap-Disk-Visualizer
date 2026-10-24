import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Every write this file causes — settings, mtime caches, snapshots — lands in
// a directory of its own, never in the owner's real app data.
import { isolatedDataDir } from './fixtures/dataDir';
import { waitFor, withinHangGuard } from './fixtures/waitFor';
isolatedDataDir('treemap-budget-test-');
process.env.TREEMAP_NO_GDU = '1';

import { getSettings, updateSettings } from '../src/services/settings';
import { loadNative, resetNativeForTests } from '../src/services/scan/native';
import {
  SHIM_DUTY,
  PRESET_CEILING,
  CHILD_PRIORITY,
  MAX_THROTTLE_SLEEP_MS,
  MAX_BUDGET_CHANGES,
  MECHANISM_NAMES,
  CONFIGURE_RETRY_MS,
  applyEngineBudgetSetting,
  noteNativeGovernorLevel,
  noteForcedLevelAgain,
  applyChildBudget,
  beginScanBudget,
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
  resolvePreset,
  resumeScan,
  setClockForTests,
  setNativeLoadOptionsForTests,
  setThrottleClockForTests,
  shimWorkerCap,
  throttleBatch,
  throttleSleepMs,
  validateEngineBudget,
  workerCap,
} from '../src/services/engineBudget';
import { allScans, cancelAllScans, cancelScan, createScanRecord, evictExpiredScans, getScan, startScan } from '../src/services/diskScanner';
import { gduScanIntoStore, runGdu, trackShard, type ShardControls } from '../src/services/gduScanner';
import { setSchedulerForTests, startScheduler, stopScheduler } from '../src/services/scheduler';
import { loadMain } from './fixtures/desktop/electronStub';
import type { EngineBudgetSetting, ScanResult } from '../src/models/types';

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

async function settle(scanId: string): Promise<ScanResult> {
  await waitFor(() => {
    const s = getScan(scanId);
    assert.ok(s, 'the scan record must exist');
    return s.status !== 'running';
  }, `scan ${scanId} settling`, 20);
  return getScan(scanId)!;
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
    { budget: { preset: 'balanced', cpuPercent: null, autoBase: 'balanced' }, auto: true },
    { budget: { preset: 'eco', cpuPercent: 30, autoBase: 'balanced' }, auto: false },
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

/* ─────────────── U-13: a scan a person starts runs at Turbo ─────────────── */

const AUTO: EngineBudgetSetting = { preset: 'auto', cpuPercent: null };
const ON_MAINS = { onBattery: false, thermal: 'nominal' } as const;

/** The governor's configure call for Automatic on `autoBase`, as the fake records it. */
const autoOn = (autoBase: 'balanced' | 'turbo') => ({ budget: { preset: 'balanced', cpuPercent: null, autoBase }, auto: true });

/**
 * The Rust table (tm-governor, `effective_preset`) written out again, row by row:
 * what Automatic runs for each base and power source while the heat is not
 * pressure. An unknown power source is not a battery.
 */
const AUTO_BY_BASE_AND_POWER = [
  ['eco', null, 'eco'], ['eco', false, 'eco'], ['eco', true, 'eco'],
  ['balanced', null, 'balanced'], ['balanced', false, 'balanced'], ['balanced', true, 'eco'],
  ['turbo', null, 'turbo'], ['turbo', false, 'turbo'], ['turbo', true, 'balanced'],
] as const;

test('the Node mirror of the governor’s table: Automatic runs its base, one step lower on battery and Eco under serious or critical heat; an explicit preset is itself', () => {
  const calm = ['nominal', 'fair', 'unknown', null] as const;
  const hot = ['serious', 'critical'] as const;
  for (const [base, onBattery, expected] of AUTO_BY_BASE_AND_POWER) {
    for (const thermal of calm) {
      assert.equal(resolvePreset('auto', base, onBattery, thermal), expected, `Automatic on ${base}, battery ${String(onBattery)}, thermal ${String(thermal)}`);
    }
    for (const thermal of hot) {
      assert.equal(resolvePreset('auto', base, onBattery, thermal), 'eco', `${thermal} heat is Eco on ${base}, battery ${String(onBattery)}`);
    }
    for (const preset of ['eco', 'balanced', 'turbo'] as const) {
      for (const thermal of [...calm, ...hot]) {
        assert.equal(resolvePreset(preset, base, onBattery, thermal), preset, `an explicit ${preset} on base ${base}, battery ${String(onBattery)}, thermal ${String(thermal)}`);
      }
    }
  }
});

test('a scan a person starts runs Automatic at Turbo on mains, Balanced on battery and Eco under serious heat; any other scan stays Balanced (Eco on battery); an explicit preset always wins', () => {
  let n = 0;
  const startsAt = (snap: Partial<FakeSnapshot>, setting: EngineBudgetSetting, interactive: boolean): string => {
    useFakeNative(fakeSnapshot(snap));
    applyEngineBudgetSetting(setting);
    const id = `table-${n++}`;
    try {
      return beginScanBudget(id, undefined, { interactive }).effective;
    } finally {
      forgetScanBudget(id);
    }
  };
  assert.equal(startsAt(ON_MAINS, AUTO, true), 'turbo', 'a person’s scan on mains, nominal heat');
  assert.equal(startsAt({ onBattery: true, thermal: 'nominal' }, AUTO, true), 'balanced', 'a person’s scan on battery');
  assert.equal(startsAt({ onBattery: false, thermal: 'serious' }, AUTO, true), 'eco', 'a person’s scan under serious heat');
  assert.equal(startsAt(ON_MAINS, AUTO, false), 'balanced', 'a scan nobody is watching: Balanced, as before');
  assert.equal(startsAt({ onBattery: true, thermal: 'nominal' }, AUTO, false), 'eco', 'and Eco on battery, as before');
  for (const preset of ['eco', 'balanced', 'turbo'] as const) {
    for (const interactive of [true, false]) {
      assert.equal(startsAt({ onBattery: true, thermal: 'nominal' }, { preset, cpuPercent: null }, interactive), preset, `an explicit ${preset} wins (interactive: ${interactive})`);
    }
  }

  // Without the governor nothing knows the battery or the heat, and an unknown
  // signal is not pressure (the Rust rule), so the shim runs the base itself.
  useShim();
  const person = beginScanBudget('shim-person', undefined, { interactive: true });
  try {
    assert.deepEqual(person, { preset: 'auto', effective: 'turbo', source: 'node-shim' });
  } finally {
    forgetScanBudget('shim-person');
  }
  const unattended = beginScanBudget('shim-unattended');
  try {
    assert.deepEqual(unattended, { preset: 'auto', effective: 'balanced', source: 'node-shim' });
  } finally {
    forgetScanBudget('shim-unattended');
  }
});

test('a scan a person starts raises the governor’s auto base to Turbo with one reconfigure, and the last such scan ending lowers it with one more', () => {
  const native = useFakeNative(fakeSnapshot(ON_MAINS));
  applyEngineBudgetSetting(AUTO);
  const before = native.configured.length;
  const first = beginScanBudget('person-1', undefined, { interactive: true });
  assert.deepEqual(native.configured.slice(before), [autoOn('turbo')], 'exactly one reconfigure, to the Turbo base');
  assert.deepEqual(first, { preset: 'auto', effective: 'turbo', source: 'native' }, 'the record keeps what the scan runs under');
  beginScanBudget('person-2', undefined, { interactive: true });
  assert.equal(native.configured.length, before + 1, 'a second person’s scan changes nothing');
  forgetScanBudget('person-1');
  assert.equal(native.configured.length, before + 1, 'one person’s scan still runs, so the base stays Turbo');
  forgetScanBudget('person-2');
  assert.deepEqual(native.configured.slice(before + 1), [autoOn('balanced')], 'the last one ending lowers it, once');
  assert.equal(first.changes, undefined, 'nothing held the scan below Turbo, so its record has no changes');
  useShim();
});

test('an unattended scan starting while a person’s scan runs lowers the auto base once, the person’s scan records it, and its end raises it again', () => {
  const native = useFakeNative(fakeSnapshot(ON_MAINS));
  applyEngineBudgetSetting(AUTO);
  const person = beginScanBudget('person', undefined, { interactive: true });
  const before = native.configured.length;
  const agent = beginScanBudget('agent');
  assert.deepEqual(native.configured.slice(before), [autoOn('balanced')], 'exactly one reconfigure, back to the Balanced base');
  assert.deepEqual(agent, { preset: 'auto', effective: 'balanced', source: 'native' }, 'unattended work never runs above the setting');
  const lowered = person.changes ?? [];
  assert.equal(lowered.length, 1, `one change on the person’s scan: ${JSON.stringify(lowered)}`);
  assert.equal(lowered[0].effective, 'balanced');
  assert.match(lowered[0].reason, /^An unattended scan started\./);
  assert.equal(typeof lowered[0].at, 'number');

  forgetScanBudget('agent');
  assert.deepEqual(native.configured.slice(before + 1), [autoOn('turbo')], 'its end raises the base again, once');
  assert.deepEqual((person.changes ?? []).map((c) => c.effective), ['balanced', 'turbo'], 'and the person’s scan records that too');
  assert.match((person.changes ?? [])[1].reason, /^No unattended scan is running any more/);
  forgetScanBudget('person');
  assert.deepEqual(native.configured.slice(before + 2), [autoOn('balanced')]);
  useShim();
});

test('a person’s scan that starts while an unattended scan runs is held below Turbo and says why; a scheduled scan’s held Eco holds the process the same way', () => {
  const native = useFakeNative(fakeSnapshot(ON_MAINS));
  applyEngineBudgetSetting(AUTO);
  const scheduled = beginScanBudget('scheduled', 'eco');
  assert.deepEqual(scheduled, { preset: 'eco', effective: 'eco', source: 'native' });
  const before = native.configured.length;
  const person = beginScanBudget('person', undefined, { interactive: true });
  assert.equal(native.configured.length, before, 'held: the base stays Balanced, so nothing is reconfigured');
  assert.equal(person.effective, 'balanced');
  const held = person.changes ?? [];
  assert.equal(held.length, 1, `the record says why it is not Turbo: ${JSON.stringify(held)}`);
  assert.equal(held[0].effective, 'balanced');
  assert.match(held[0].reason, /^An unattended scan was already running\./);

  forgetScanBudget('scheduled');
  assert.deepEqual(native.configured.slice(before), [autoOn('turbo')], 'the scheduled scan ending raises the base, once');
  assert.deepEqual((person.changes ?? []).map((c) => c.effective), ['balanced', 'turbo']);
  forgetScanBudget('person');
  useShim();
});

test('a scheduled scan the native engine walks records the governor’s level, not the Eco it asked for, and says why (hunt C41)', () => {
  // The forced preset reaches only the built-in walker and gdu (dutyFor, workerCap, childPriority); the
  // native walk runs under the governor's process-wide level, and the record said "eco" all the same.
  const native = useFakeNative(fakeSnapshot(ON_MAINS));
  applyEngineBudgetSetting({ preset: 'turbo', cpuPercent: null });
  const scheduled = beginScanBudget('sched-native', 'eco');
  assert.equal(scheduled.effective, 'eco', 'control: on the walker and gdu it holds Eco');
  noteNativeGovernorLevel('sched-native');
  assert.equal(scheduled.effective, 'turbo', 'the native walk runs at the governor’s level, and the record says so');
  assert.equal(scheduled.preset, 'eco', 'what it asked for is still named');
  assert.match(String((scheduled.changes ?? []).at(-1)?.reason), /native engine/, JSON.stringify(scheduled.changes));
  forgetScanBudget('sched-native');
  void native;
  useShim();
});

test('the native branch of a scan notes the governor’s level on its budget record (hunt C41)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'diskScanner.ts'), 'utf8');
  const at = src.indexOf('if (nativeWalk) {\n      scan.engine = \'native\';');
  assert.ok(at > 0, 'the native branch is found');
  assert.match(src.slice(at, at + 600), /noteNativeGovernorLevel\(scan\.scanId\)/);
});

test('a scheduled scan whose native walk fails part-way records the Eco the built-in walker then holds again, and says why (review F1.4)', () => {
  const native = useFakeNative(fakeSnapshot(ON_MAINS));
  applyEngineBudgetSetting({ preset: 'turbo', cpuPercent: null });
  const scheduled = beginScanBudget('sched-fallback', 'eco');
  noteNativeGovernorLevel('sched-fallback');
  assert.equal(scheduled.effective, 'turbo', 'control: the native walk ran at the governor’s level');
  noteForcedLevelAgain('sched-fallback');
  assert.equal(scheduled.effective, 'eco', 'the walker that takes over runs at the Eco it asked for, and the record says so');
  assert.equal((scheduled.changes ?? []).at(-1)?.effective, 'eco', JSON.stringify(scheduled.changes));
  assert.match(String((scheduled.changes ?? []).at(-1)?.reason), /built-in/, JSON.stringify(scheduled.changes));
  const count = (scheduled.changes ?? []).length;
  noteForcedLevelAgain('sched-fallback');
  assert.equal((scheduled.changes ?? []).length, count, 'nothing more is noted while the record already says it');
  forgetScanBudget('sched-fallback');
  void native;
  useShim();
});

test('the native branch notes the forced level again when its walk fails and the built-in engines take over (review F1.4)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'diskScanner.ts'), 'utf8');
  const at = src.indexOf('const reason = `the native engine failed part-way:');
  assert.ok(at > 0, 'the fallback is found');
  assert.match(src.slice(at, at + 500), /noteForcedLevelAgain\(scan\.scanId\)/);
});

test('under an explicit preset the auto base changes nothing a scan runs at, so no change is recorded', () => {
  const native = useFakeNative(fakeSnapshot(ON_MAINS));
  applyEngineBudgetSetting({ preset: 'balanced', cpuPercent: null });
  const person = beginScanBudget('person', undefined, { interactive: true });
  assert.deepEqual(person, { preset: 'balanced', effective: 'balanced', source: 'native' });
  beginScanBudget('agent');
  forgetScanBudget('agent');
  assert.equal(person.changes, undefined, 'Balanced throughout: nothing changed for this scan');
  assert.ok(native.configured.every((c) => c.auto === false), `a manual preset is configured without auto: ${JSON.stringify(native.configured)}`);
  forgetScanBudget('person');
  useShim();
});

test('a person’s scan has no fixed preset: a setting change mid-scan is followed from the next read (P8-5)', async () => {
  useShim();
  applyEngineBudgetSetting(AUTO);
  const cores = Math.max(1, os.cpus().length);
  const id = 'person-follows';
  const clock = throttleClock();
  try {
    beginScanBudget(id, undefined, { interactive: true });
    assert.equal(workerCap(id), cores, 'Automatic for a person’s scan is Turbo: a worker per core');
    assert.equal(childPriority(id), CHILD_PRIORITY.turbo);
    await throttleBatch(id);
    clock.work(40);
    await throttleBatch(id);
    assert.deepEqual(clock.rests, [], 'Turbo does not rest');

    applyEngineBudgetSetting({ preset: 'eco', cpuPercent: null });
    assert.equal(workerCap(id), shimWorkerCap('eco', cores), 'the same scan runs Eco’s workers from the next read');
    assert.equal(childPriority(id), CHILD_PRIORITY.eco, 'and starts its next helper at Eco’s priority');
    clock.work(40);
    await throttleBatch(id);
    assert.deepEqual(clock.rests, [120], 'and rests three parts to one');

    applyEngineBudgetSetting(AUTO);
    assert.equal(workerCap(id), cores, 'back to Automatic: Turbo again');
    assert.equal(childPriority(id), CHILD_PRIORITY.turbo);
  } finally {
    forgetScanBudget(id);
    setThrottleClockForTests(null);
    applyEngineBudgetSetting(AUTO);
  }
});

test('the governor hears every setting change a person’s scan follows, with the auto base it runs on', () => {
  const native = useFakeNative(fakeSnapshot(ON_MAINS));
  applyEngineBudgetSetting(AUTO);
  beginScanBudget('person', undefined, { interactive: true });
  const before = native.configured.length;
  applyEngineBudgetSetting({ preset: 'eco', cpuPercent: null });
  applyEngineBudgetSetting(AUTO);
  assert.deepEqual(native.configured.slice(before), [
    { budget: { preset: 'eco', cpuPercent: null, autoBase: 'turbo' }, auto: false },
    autoOn('turbo'),
  ]);
  forgetScanBudget('person');
  useShim();
});

test('GET /api/engine/budget states the governor’s own effective preset beside its targetShare, never one worked out from the setting', () => {
  // No scan a person started is registered here, so a preset worked out from
  // the setting would say Balanced beside Turbo's share.
  useFakeNative(fakeSnapshot({ ...ON_MAINS, effective: 'turbo', targetShare: 0.9 }));
  const state = budgetSnapshot();
  assert.deepEqual(state.effective, { preset: 'turbo', targetShare: 0.9, source: 'native' });
  assert.equal(state.effective.preset, state.snapshot?.effective, 'the preset and the share are the governor’s, so they agree');
  useShim();
});

test('a snapshot whose effective preset is not one of the three is refused like any other wrong shape', () => {
  useFakeNative(fakeSnapshot({}), { governorSnapshot: () => ({ ...fakeSnapshot({}), effective: 'ludicrous' }) });
  const warn = capturingWarn();
  try {
    const state = budgetSnapshot();
    assert.equal(state.source, 'node-shim');
    assert.match(state.native.reason ?? '', /"effective" is not one of eco, balanced, turbo/);
  } finally {
    warn.restore();
    useShim();
  }
});

test('startScan hands the window’s interactive on: that scan raises the auto base while it runs and its settling lowers it; a scan without it never raises it', async () => {
  const native = useFakeNative(fakeSnapshot({ ...ON_MAINS, duty: 1 }));
  const root = await buildTree(2, 3, 'treemap-interactive-turbo-');
  try {
    await updateSettings({ engineBudget: AUTO });
    const before = native.configured.length;
    const scan = await startScan(root, { interactive: true });
    assert.equal(scan.status, 'running', 'still walking when startScan hands the record back');
    assert.deepEqual(native.configured.slice(before), [autoOn('turbo')], 'raised once, as the scan started');
    assert.deepEqual(scan.budget, { preset: 'auto', effective: 'turbo', source: 'native' });
    const done = await settle(scan.scanId);
    assert.equal(done.status, 'complete', done.error);
    await waitFor(() => native.configured.length >= before + 2, 'the settled scan lowering the auto base');
    assert.deepEqual(native.configured.slice(before + 1), [autoOn('balanced')], 'lowered once, as it settled');

    // What an agent, Autopilot, a paired computer or the API sends: no interactive.
    const quiet = await startScan(root);
    assert.deepEqual(quiet.budget, { preset: 'auto', effective: 'balanced', source: 'native' });
    await settle(quiet.scanId);
    assert.equal(native.configured.length, before + 2, 'a scan nobody is watching never raises the base');
  } finally {
    await updateSettings({ engineBudget: AUTO });
    await fsp.rm(root, { recursive: true, force: true });
    useShim();
  }
});

test('a person’s scan that is stopped, evicted or shut down lowers the auto base at once, like one that finished', async () => {
  const native = useFakeNative(fakeSnapshot({ ...ON_MAINS, duty: 1 }));
  const root = await buildTree(2, 3, 'treemap-turbo-endings-');
  const endings: Record<string, (scan: ScanResult) => void> = {
    'stopped by the person': (scan) => { assert.equal(cancelScan(scan.scanId), true); },
    'evicted past the six-hour cap': (scan) => {
      scan.createdAt = Date.now() - 7 * 60 * 60 * 1000;
      assert.ok(evictExpiredScans().includes(scan.scanId), 'the eviction took the running scan');
    },
    'shut down with the app': () => { cancelAllScans(); },
  };
  try {
    await updateSettings({ engineBudget: AUTO });
    for (const [ending, end] of Object.entries(endings)) {
      const before = native.configured.length;
      const scan = await startScan(root, { interactive: true });
      assert.equal(scan.status, 'running', `${ending}: still walking when startScan hands the record back`);
      assert.deepEqual(native.configured.slice(before), [autoOn('turbo')], `${ending}: raised as it started`);
      end(scan);
      assert.deepEqual(native.configured.slice(before + 1), [autoOn('balanced')], `${ending}: lowered at once, not when the walk next looks`);
      // A shutdown leaves records as they were; this one is settled so no later test meets it running.
      cancelScan(scan.scanId);
      assert.equal(native.configured.length, before + 2, `${ending}: and nothing after that reconfigures again`);
    }
  } finally {
    await updateSettings({ engineBudget: AUTO });
    await fsp.rm(root, { recursive: true, force: true });
    useShim();
  }
});

test('a scan with a held preset never raises the auto base, even one marked interactive, and it holds a person’s scan like any unattended scan', () => {
  const native = useFakeNative(fakeSnapshot(ON_MAINS));
  applyEngineBudgetSetting(AUTO);
  const before = native.configured.length;
  const held = beginScanBudget('held-eco', 'eco', { interactive: true });
  try {
    assert.deepEqual(held, { preset: 'eco', effective: 'eco', source: 'native' });
    assert.equal(native.configured.length, before, 'a held preset is never raised, so the base does not move');
    const person = beginScanBudget('person', undefined, { interactive: true });
    assert.equal(person.effective, 'balanced', 'and a person’s scan beside it is held at Balanced');
    assert.equal(native.configured.length, before);
  } finally {
    forgetScanBudget('held-eco');
    forgetScanBudget('person');
    useShim();
  }
});

test('a cloud listing started while a person’s scan runs records Automatic’s resting base, not Turbo', () => {
  useFakeNative(fakeSnapshot(ON_MAINS));
  applyEngineBudgetSetting(AUTO);
  beginScanBudget('person', undefined, { interactive: true });
  const cloud = createScanRecord('/cloud-beside-a-person');
  try {
    assert.deepEqual(cloud.budget, { preset: 'auto', effective: 'balanced', source: 'native' }, 'no person started this one from the window');
  } finally {
    cancelScan(cloud.scanId);
    forgetScanBudget('person');
    useShim();
  }
});

test('under serious heat an unattended scan changes nothing a person’s scan runs at, so nothing is recorded, though the governor still hears the base move', () => {
  const native = useFakeNative(fakeSnapshot({ onBattery: false, thermal: 'serious' }));
  applyEngineBudgetSetting(AUTO);
  const person = beginScanBudget('person', undefined, { interactive: true });
  try {
    assert.equal(person.effective, 'eco', 'serious heat is Eco, whatever the base');
    const before = native.configured.length;
    beginScanBudget('agent');
    const second = beginScanBudget('person-2', undefined, { interactive: true });
    forgetScanBudget('agent');
    assert.deepEqual(native.configured.slice(before), [autoOn('balanced'), autoOn('turbo')], 'the base moves both ways all the same');
    assert.equal(person.changes, undefined, 'Eco before and after: no change to record');
    assert.equal(second.changes, undefined, 'and one that started held under heat was Eco on any base');
  } finally {
    forgetScanBudget('person');
    forgetScanBudget('person-2');
    useShim();
  }
});

test(`a person’s scan keeps the latest ${MAX_BUDGET_CHANGES} changes, however many unattended scans come and go`, () => {
  useFakeNative(fakeSnapshot(ON_MAINS));
  applyEngineBudgetSetting(AUTO);
  const person = beginScanBudget('person', undefined, { interactive: true });
  try {
    const rounds = MAX_BUDGET_CHANGES; // two changes each, twice the cap
    for (let i = 0; i < rounds; i++) {
      beginScanBudget(`agent-${i}`);
      forgetScanBudget(`agent-${i}`);
    }
    const kept = person.changes ?? [];
    assert.equal(kept.length, MAX_BUDGET_CHANGES, `${2 * rounds} changes made, the latest ${MAX_BUDGET_CHANGES} kept`);
    assert.deepEqual(kept.map((c) => c.effective), Array.from({ length: MAX_BUDGET_CHANGES }, (_, i) => (i % 2 === 0 ? 'balanced' : 'turbo')));
    assert.match(kept[kept.length - 1].reason, /^No unattended scan is running any more/, 'the newest is the last rise');
  } finally {
    forgetScanBudget('person');
    useShim();
  }
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

/**
 * The throttle's clock, standing in for the real one: `work(ms)` is time
 * passing between batches, and every rest the throttle asks for is recorded
 * (and passes on this clock), so the rests are counted, never timed — a busy
 * machine stretches a real 40 ms sleep, and these tests once read that as the
 * throttle's doing.
 */
function throttleClock(): { rests: number[]; work: (ms: number) => void } {
  let now = 1_000;
  const rests: number[] = [];
  setThrottleClockForTests({
    now: () => now,
    sleep: async (ms) => {
      rests.push(ms);
      now += ms;
    },
  });
  return { rests, work: (ms) => { now += ms; } };
}

test('throttleBatch measures from the caller’s previous call: the first call is free, Eco rests three times the work, Turbo never rests, and completion forgets the caller', async () => {
  useShim();
  const clock = throttleClock();
  try {
    applyEngineBudgetSetting({ preset: 'eco', cpuPercent: null });
    const id = 'throttle-eco';
    await throttleBatch(id);
    assert.deepEqual(clock.rests, [], 'nothing measured yet, nothing to rest for');

    clock.work(40);
    await throttleBatch(id);
    assert.deepEqual(clock.rests, [120], 'eco (duty 0.25) rests three times the 40 ms of work');
    clock.work(40);
    await throttleBatch(id);
    assert.deepEqual(clock.rests, [120, 120], 'the rest itself is not counted as work');

    forgetScanBudget(id);
    clock.work(40);
    await throttleBatch(id);
    assert.deepEqual(clock.rests, [120, 120], 'a forgotten caller starts afresh');

    applyEngineBudgetSetting({ preset: 'turbo', cpuPercent: null });
    const turbo = 'throttle-turbo';
    await throttleBatch(turbo);
    clock.work(40);
    await throttleBatch(turbo);
    assert.deepEqual(clock.rests, [120, 120], 'turbo does not rest');
    forgetScanBudget(id);
    forgetScanBudget(turbo);
  } finally {
    applyEngineBudgetSetting({ preset: 'auto', cpuPercent: null });
    setThrottleClockForTests(null);
  }
});

test('with the native governor the duty comes from its snapshot', async () => {
  useFakeNative(fakeSnapshot({ duty: 0.2 }));
  const clock = throttleClock();
  try {
    const id = 'throttle-native';
    await throttleBatch(id);
    clock.work(30);
    await throttleBatch(id);
    assert.deepEqual(clock.rests, [120], 'duty 0.2 rests four units per unit of work: 120 ms after 30');
    forgetScanBudget(id);
  } finally {
    setThrottleClockForTests(null);
    useShim();
  }
});

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

/**
 * A stand-in for gdu that works for up to `holdMs` and then writes a
 * one-file result. Real gdu is ONE process, so a SIGSTOP freezes all of its
 * work and a SIGKILL ends all of it. The work here is therefore a loop of
 * 10 ms steps: a SIGSTOP stops the loop between steps, and a SIGKILL leaves
 * at most one 10 ms `sleep` behind. The first version slept once, in a child
 * the SIGSTOP never reached — on Linux its work finished during the pause
 * (458 ms held of 700) and, killed, it orphaned a `sleep 5` that kept the
 * pipes open past the evictor's two seconds.
 *
 * What a test needs to see is written to files beside the output, so it is
 * waited for, never sampled: `<out>.started` before the first step, one line
 * in `<out>.ticks` per step, and the loop ends early once `<out>.release`
 * exists. Sampling for a child `sleep` missed the whole 300 ms of work on a
 * busy CI runner (the pt-BR Linux leg of 24 Sep 2026: "started no work
 * within 5000 ms", the pause landing after the stand-in had finished).
 */
async function fakeGdu(dir: string, holdMs: number): Promise<string> {
  const bin = path.join(dir, 'fake-gdu.sh');
  await fsp.writeFile(bin, [
    '#!/bin/sh',
    'out=""',
    'while [ $# -gt 1 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done',
    'target="$1"',
    ': > "$out.started"',
    'i=0',
    `while [ $i -lt ${Math.max(1, Math.ceil(holdMs / 10))} ] && [ ! -e "$out.release" ]; do sleep 0.01; echo . >> "$out.ticks"; i=$((i + 1)); done`,
    'printf \'[1,2,{"progname":"gdu","progver":"v5.36.1","timestamp":1},[{"name":"%s","mtime":1},{"name":"a.txt","asize":5,"dsize":4096,"mtime":1}]]\' "$target" > "$out"',
  ].join('\n'), { mode: 0o755 });
  return bin;
}

/** How long a stand-in's work lasts unless the test releases it: longer than any test here waits for it. */
const STAND_IN_WORK_MS = 60_000;

/**
 * Resolves once the stand-in writing `out` has started its work (its
 * `.started` marker exists). A pause must land mid-work to test anything.
 */
async function whenWorking(out: string): Promise<void> {
  await waitFor(() => fs.existsSync(`${out}.started`), `the stand-in for ${out} starting its work`, 5);
}

/** The stand-in's steps so far. */
function ticksOf(out: string): number {
  return fs.existsSync(`${out}.ticks`) ? fs.readFileSync(`${out}.ticks`, 'utf8').length : 0;
}

/** The OS's state letter for `pid` (`T` = stopped), or '' once it has gone. */
function processState(pid: number): string {
  return spawnSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
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

test('pausing a running walker halts `scanned` once the batches already under way land, and resuming lets it finish with every entry counted', async () => {
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
  // Counted, not timed (the hunt, C82): a batch of lstats already under way when the pause lands still
  // adds to `scanned` as it lands, so "halted" is read once no lstat is in flight — every batch begun
  // before the pause has landed — never after a fixed 200 ms, which a slow runner could outlast.
  const realLstat = fs.promises.lstat;
  let lstatsInFlight = 0;
  (fs.promises as { lstat: typeof realLstat }).lstat = (async (...args: Parameters<typeof realLstat>) => {
    lstatsInFlight++;
    try { return await realLstat.apply(fs.promises, args); } finally { lstatsInFlight--; }
  }) as typeof realLstat;
  try {
    const scan = await startScan(root);
    await waitFor(() => scan.status !== 'running' || scan.currentPath === big, 'the walker reaching the big folder', 2);
    const atEntry = scan.scanned;
    await waitFor(() => scan.status !== 'running' || scan.scanned >= atEntry + 300, 'the walker getting into the big folder', 2);
    assert.equal(scan.status, 'running', 'too fast to pause — the tree must be bigger');

    const outcome = pauseScan(scan);
    assert.deepEqual({ paused: outcome.paused, supported: outcome.supported, scanId: outcome.scanId, source: outcome.source },
      { paused: true, supported: true, scanId: scan.scanId, source: 'node-shim' });
    assert.equal(isScanPaused(scan.scanId), true);
    await waitFor(() => lstatsInFlight === 0, 'every batch begun before the pause landing', 2);
    // What a landed batch adds is added in the microtasks after its last lstat: let them run.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    const halted = scan.scanned;
    await sleep(300); // a pause for a broken gate to show itself in, not a bound
    assert.equal(scan.scanned, halted, 'scanned kept moving while paused');
    assert.equal(scan.status, 'running', 'paused is still running, not finished');
    assert.ok(halted < total, 'it really was paused mid-way');

    const again = pauseScan(scan);
    assert.equal(again.paused, true, 'pausing twice is still paused');

    const resumed = resumeScan(scan);
    assert.equal(resumed.paused, false);
    assert.equal(isScanPaused(scan.scanId), false);
    await waitFor(() => scan.scanned !== halted || scan.status !== 'running', '`scanned` moving again after resume', 5);
    const done = await settle(scan.scanId);
    assert.equal(done.status, 'complete');
    assert.equal(done.scanned, total, 'every folder and file was counted once');
    assert.equal(isScanPaused(scan.scanId), false, 'completion clears the pause state');
  } finally {
    (fs.promises as { lstat: typeof realLstat }).lstat = realLstat;
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
    const s = await settle(scan.scanId);
    assert.equal(s.status, 'error');
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
  // Work that only the test ends: a pause cannot land after it has finished.
  const bin = await fakeGdu(root, STAND_IN_WORK_MS);
  const out = path.join(root, 'shard.json');
  let pid = 0;
  let controls: ShardControls | undefined;
  try {
    const shard = runGdu(bin, root, out, {
      onSpawn: (child, shardControls) => {
        pid = child.pid ?? 0;
        controls = shardControls;
      },
    }).then(() => 'finished', (err: Error) => err);
    await whenWorking(out); // paused mid-work, as a user pauses a scan
    assert.ok(pid > 0 && controls);
    controls.pause();
    await waitFor(() => processState(pid).startsWith('T'), 'the paused stand-in reading as stopped (T)', 5);
    const state = processState(pid);
    assert.match(state, /^T/, `the process state while paused should read T (stopped), got "${state}"`);
    // Stopped means no work: not one step while the pause lasts.
    const before = ticksOf(out);
    await sleep(400);
    assert.equal(ticksOf(out), before, 'the stand-in took no step while stopped');
    assert.match(processState(pid), /^T/, 'and is still stopped');
    controls.resume();
    await fsp.writeFile(`${out}.release`, '');
    const outcome = await withinHangGuard(shard, 'the shard finishing after SIGCONT');
    assert.equal(outcome, 'finished', 'the shard finished after SIGCONT');
    assert.ok(ticksOf(out) >= before, 'its steps are all there');
    assert.ok(fs.existsSync(out), 'and then wrote its result');
  } finally {
    if (pid > 0 && processState(pid) !== '') process.kill(pid, 'SIGKILL'); // a red run must not leave a stopped stand-in behind
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
    await whenWorking(path.join(root, 'shard.json')); // mid-work, as in the pause test above
    assert.equal(pauseScan(scan).paused, true);
    await sleep(150);
    const state = processState(child.pid ?? 0);
    assert.match(state, /^T/, `the shard is stopped before the eviction, got "${state}"`);

    scan.createdAt = Date.now() - 7 * 60 * 60 * 1000; // past the six-hour hard cap
    assert.deepEqual(evictExpiredScans(), [scan.scanId]);
    const outcome = await withinHangGuard(shard, 'the eviction ending the stopped shard');
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
    // No launch hold here: the hold is tests/schedulerLaunchHold.test.ts's, and this asks only what budget a scheduled scan runs under.
    setSchedulerForTests({ launchHoldMs: 0 });
    startScheduler();
    const due = (): ScanResult | undefined => allScans().find((s) => s.rootPath === root && !before.has(s.scanId));
    await waitFor(() => due() !== undefined, 'the scheduler starting the due scan', 20);
    const scan = due()!;
    assert.deepEqual(scan.budget, { preset: 'eco', effective: 'eco', source: 'node-shim' });
    const done = await settle(scan.scanId);
    assert.equal(done.status, 'complete');
    assert.deepEqual(done.budget, { preset: 'eco', effective: 'eco', source: 'node-shim' }, 'the record keeps what it ran under');

    const user = await startScan(root);
    assert.deepEqual(user.budget, { preset: 'turbo', effective: 'turbo', source: 'node-shim' }, 'a scan the user starts keeps the setting');
    await settle(user.scanId);
  } finally {
    stopScheduler();
    setSchedulerForTests(null);
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

test('a real walk rests through the throttle after every batch under Eco, three parts rest to one of work, and never under Turbo (counted on the throttle\'s clock)', async () => {
  // What keeps an Eco scan's process near a quarter of the machine is the
  // walker resting through `throttleBatch` after every batch. That is
  // counted here on the throttle's own clock, which moves one millisecond
  // each time it is read — so every batch "works" at least a millisecond —
  // and records each rest without sleeping it. The share of the machine
  // those rests buy is a measurement of the machine, reported by the test
  // below and never asserted.
  useShim();
  const dirs = 40;
  const tree = await buildTree(dirs, 50, 'treemap-budget-rests-');
  const restsUnder = async (preset: 'eco' | 'turbo'): Promise<number[]> => {
    let now = 0;
    const rests: number[] = [];
    setThrottleClockForTests({ now: () => ++now, sleep: async (ms) => { rests.push(ms); } });
    try {
      await updateSettings({ engineBudget: { preset, cpuPercent: null } });
      const done = await settle((await startScan(tree)).scanId);
      assert.equal(done.status, 'complete', done.error);
      assert.equal(done.scanned, 1 + dirs + dirs * 50, 'every entry counted');
      return rests;
    } finally {
      setThrottleClockForTests(null);
    }
  };
  try {
    const eco = await restsUnder('eco');
    const turbo = await restsUnder('turbo');
    // At least one batch per folder, and a worker's first batch is free.
    const ecoWorkers = shimWorkerCap('eco', os.cpus().length);
    assert.ok(eco.length >= 1 + dirs - ecoWorkers,
      `Eco rested ${eco.length} times over a walk of at least ${1 + dirs} batches on ${ecoWorkers} worker(s): it must rest after every batch but each worker's first`);
    assert.deepEqual(eco.filter((ms) => !(ms >= 3 && ms % 3 === 0)), [],
      'every Eco rest is three times the work before it (duty 0.25), and the work is at least one tick');
    assert.deepEqual(turbo, [], 'Turbo never rests');
  } finally {
    await updateSettings({ engineBudget: { preset: 'auto', cpuPercent: null } });
    await fsp.rm(tree, { recursive: true, force: true });
  }
});

test('the walker under Eco and Turbo, each in a process of its own: both walk every entry, and the machine share each held is reported (20k entries, child process)', async (t) => {
  const cores = Math.max(1, os.cpus().length);
  const tree = await buildTree(200, 100, 'treemap-budget-share-');
  try {
    runChild('turbo', tree); // warm the page cache so neither run pays for cold metadata
    const eco = runChild('eco', tree);
    const turbo = runChild('turbo', tree);
    const load = os.loadavg()[0];
    const share = (r: ChildRun): number => r.cpuMs / (r.wallMs * cores);
    const busy = (r: ChildRun): number => r.cpuMs / r.wallMs;
    // Reported, never asserted: a share of the machine and a wall time both
    // measure the machine as much as the budget (measured on this Mac, 8
    // cores: Eco 0.19 with 1.5 cores busy, Turbo 0.44 with 3.5; an Eco that
    // never rested, 0.38). What the budget controls — the rests — is counted
    // by the test above.
    t.diagnostic(`eco: share ${share(eco).toFixed(3)} (${busy(eco).toFixed(2)} cores busy, ${eco.wallMs.toFixed(0)} ms wall, ${eco.cpuMs.toFixed(0)} ms cpu) · ` +
      `turbo: share ${share(turbo).toFixed(3)} (${busy(turbo).toFixed(2)} cores busy, ${turbo.wallMs.toFixed(0)} ms wall) · ` +
      `${cores} cores, 1-minute load ${load.toFixed(2)}`);
    for (const r of [eco, turbo]) {
      assert.equal(r.status, 'complete', r.preset);
      assert.equal(r.scanned, 1 + 200 + 200 * 100, r.preset);
    }
    assert.deepEqual(eco.budget, { preset: 'eco', effective: 'eco', source: 'node-shim' });
    assert.deepEqual(turbo.budget, { preset: 'turbo', effective: 'turbo', source: 'node-shim' });
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

import os from 'node:os';
import { loadNative, LoadOptions, NativeModule, NativeOutcome } from './scan/native';
import type { Mechanism, MechanismName, NativeBudget, NativeCapabilities, NativeSnapshot } from '../../native/index';
import { platform } from '../platform';
import type { PlatformName } from '../platform/types';
import type { BudgetPreset, BudgetSource, EffectiveBudgetPreset, EngineBudgetSetting, ScanBudget, ScanResult } from '../models/types';

/**
 * The scanning budget — Eco, Balanced, Turbo, or Automatic — and how the app
 * obeys it (Phase 2, Task 5).
 *
 * Two ways to hold a budget live behind one surface:
 *
 *  - **native**: the Rust governor (tm-governor, loaded through
 *    src/services/scan/native.ts) measures the process's share of the machine
 *    every 100 ms and closes the loop with real OS mechanisms — thread QoS,
 *    I/O policy, priority. It decides the duty and the worker count; this
 *    module asks it and passes the answers on.
 *  - **node-shim**: without the module (not built for this platform, the wrong
 *    version, a build from another contract) the legacy engines still obey
 *    the budget as far as Node allows: a fixed duty per preset (`SHIM_DUTY`),
 *    a worker cap per preset, and a lower priority for gdu shards. This is
 *    best effort by construction: nothing here measures the machine, so the
 *    duty is a rule, not a controlled variable, and the API says so through
 *    `source: 'node-shim'`.
 *
 * The setting is owned by settings.ts, which pushes it here on every load and
 * update (`applyEngineBudgetSetting`); nothing here imports settings, so the
 * walker, the gdu engine and the scheduler can import this module without a
 * cycle. Per-scan state (throttle timing, a forced preset, pause) lives in one
 * map keyed by scanId and is dropped when the scan settles.
 */

export const BUDGET_PRESETS: readonly BudgetPreset[] = ['auto', 'eco', 'balanced', 'turbo'];
export const DEFAULT_ENGINE_BUDGET: Readonly<EngineBudgetSetting> = { preset: 'auto', cpuPercent: null };

/**
 * What each preset aims for, as a share of the whole machine — the same table
 * the Rust preset module holds (Turbo still leaves a tenth for the person
 * using the computer).
 */
export const PRESET_CEILING: Readonly<Record<EffectiveBudgetPreset, number>> = { eco: 0.25, balanced: 0.5, turbo: 0.9 };

/**
 * The Node shim's duty per preset: the fraction of wall time a walker worker
 * may spend working, the rest being rest. BEST EFFORT — nothing measures the
 * outcome. Turbo is 1.0 rather than the 0.9 ceiling because the shim's only
 * lever is sleeping, and adding sleeps to a walker that is mostly waiting on
 * the disk would cost speed without buying the person anything; the native
 * governor holds 0.9 by measuring, which the shim cannot.
 */
export const SHIM_DUTY: Readonly<Record<EffectiveBudgetPreset, number>> = { eco: 0.25, balanced: 0.5, turbo: 1 };

/** The nice value gdu shards are started with (0 = the app's own). */
export const CHILD_PRIORITY: Readonly<Record<EffectiveBudgetPreset, number>> = { eco: 10, balanced: 5, turbo: 0 };

/** One slow batch may cost at most this much rest, so a worker never parks for a minute. */
export const MAX_THROTTLE_SLEEP_MS = 1000;

/** The governor's duty is clamped here, as in the Rust controller (0.05..=1). */
const MIN_DUTY = 0.05;
const MIN_SHARE = 0.01;

/* ------------------------------ the setting ------------------------------ */

/**
 * A hand-edited settings file is normalised, never trusted: an unknown preset
 * is Automatic, a percentage outside 1–100 is clamped into it, and anything
 * that is not a positive number is no override at all.
 */
export function normalizeEngineBudget(raw: unknown): EngineBudgetSetting {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_ENGINE_BUDGET };
  const r = raw as { preset?: unknown; cpuPercent?: unknown };
  const preset = BUDGET_PRESETS.includes(r.preset as BudgetPreset) ? (r.preset as BudgetPreset) : 'auto';
  const n = typeof r.cpuPercent === 'number' || typeof r.cpuPercent === 'string' ? Number(r.cpuPercent) : NaN;
  const cpuPercent = Number.isFinite(n) && n > 0 ? Math.min(100, Math.max(1, Math.round(n))) : null;
  return { preset, cpuPercent };
}

export type BudgetValidation = { ok: true; value: EngineBudgetSetting } | { ok: false; reason: string };

/**
 * API input is validated, not forgiven: the four presets, cpuPercent 1–100 or
 * null, and nothing else. A patch may name either key; the other keeps the
 * value in `base` (the setting as it stands).
 */
export function validateEngineBudget(raw: unknown, base: EngineBudgetSetting): BudgetValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: '"engineBudget" must be an object with "preset" and/or "cpuPercent"' };
  }
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r);
  const unknown = keys.filter((k) => k !== 'preset' && k !== 'cpuPercent');
  if (unknown.length > 0) return { ok: false, reason: `"engineBudget" does not take "${unknown[0]}" — only "preset" and "cpuPercent"` };
  if (keys.length === 0) return { ok: false, reason: '"engineBudget" must include "preset" and/or "cpuPercent"' };
  let preset = base.preset;
  if ('preset' in r) {
    if (!BUDGET_PRESETS.includes(r.preset as BudgetPreset)) {
      return { ok: false, reason: `"preset" must be one of ${BUDGET_PRESETS.map((p) => `"${p}"`).join(', ')}` };
    }
    preset = r.preset as BudgetPreset;
  }
  let cpuPercent = base.cpuPercent;
  if ('cpuPercent' in r) {
    if (r.cpuPercent === null) cpuPercent = null;
    else if (typeof r.cpuPercent !== 'number' || !Number.isFinite(r.cpuPercent) || r.cpuPercent < 1 || r.cpuPercent > 100) {
      return { ok: false, reason: '"cpuPercent" must be a number from 1 to 100, or null to keep the preset\'s own ceiling' };
    } else cpuPercent = Math.round(r.cpuPercent);
  }
  return { ok: true, value: { preset, cpuPercent } };
}

let current: EngineBudgetSetting = { ...DEFAULT_ENGINE_BUDGET };
let governorConfigured = false;

/**
 * settings.ts calls this on every load and update. With the native governor
 * loaded the change is live: the governor is reconfigured at once, and a
 * running scan follows it on its next batch. The setting is normalised here
 * as well as at the routes, so no caller can push a NaN ceiling into the
 * shared state and out to the wire.
 */
export function applyEngineBudgetSetting(setting: EngineBudgetSetting): void {
  const next = normalizeEngineBudget(setting);
  const changed = next.preset !== current.preset || next.cpuPercent !== current.cpuPercent;
  current = next;
  if (!changed && governorConfigured && configureFault === null) return;
  const native = governor();
  if (!native) return;
  configureGovernor(native);
}

export function currentEngineBudgetSetting(): EngineBudgetSetting {
  return { ...current };
}

/* ------------------------------ the native side ------------------------------ */

/*
 * The shapes tm-node emits are declared once, in native/index.d.ts (the
 * module's hand-written declaration); this module imports them and re-exports
 * the two the API layer names, so a change to the module is a change there.
 */
export type { Mechanism, MechanismName } from '../../native/index';
export const MECHANISM_NAMES = ['qos', 'ioPolicy', 'priority', 'thermal', 'battery', 'interaction', 'machineCpu'] as const satisfies readonly MechanismName[];
// Every name the declaration knows is in the list above, or this line stops compiling.
const everyMechanismNamed: [MechanismName] extends [(typeof MECHANISM_NAMES)[number]] ? true : never = true;
void everyMechanismNamed;

/** The Rust `Snapshot`, as tm-node serialises it (camelCase, enums as lower-case strings). */
export type GovernorSnapshot = NativeSnapshot;

/** The part of tm-node's surface this module uses (native/index.d.ts declares the whole of it). */
interface GovernorModule extends NativeModule {
  governorCapabilities(): NativeCapabilities;
  governorConfigure(budget: NativeBudget, auto: boolean): void;
  governorSnapshot(): NativeSnapshot;
  governorPause(): void;
  governorResume(): void;
}

const GOVERNOR_FUNCTIONS = ['governorCapabilities', 'governorConfigure', 'governorSnapshot', 'governorPause', 'governorResume'] as const;

let loadOptionsOverride: LoadOptions | null = null;

/**
 * A governor that loaded but is not in force. Two faults, kept apart because
 * they clear differently: a snapshot that threw or came back in the wrong
 * shape (cleared by the next snapshot that answers), and a configure the
 * governor refused (cleared by a configure it accepts — retried by the next
 * setting change, or on a read once CONFIGURE_RETRY_MS have passed). While
 * either stands the shim's rules apply and every answer says `node-shim`;
 * `budgetSnapshot().native.reason` carries the fault; the log records each
 * change of state once, never once per read.
 */
let snapshotFault: string | null = null;
let configureFault: string | null = null;
let retryConfigureAt = 0;
export const CONFIGURE_RETRY_MS = 5000;
let clock: () => number = () => Date.now();

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function noteFaultChange(previous: string | null, next: string | null): void {
  if (previous === next) return;
  if (next !== null) console.warn(`[treemap] the native governor is not in force; the Node shim's rules apply meanwhile: ${next}`);
  else if (nativeFault() === null) console.warn('[treemap] the native governor is back in force');
}

function setSnapshotFault(fault: string | null): void {
  const previous = snapshotFault;
  snapshotFault = fault;
  noteFaultChange(previous, fault);
}

function setConfigureFault(fault: string | null): void {
  const previous = configureFault;
  configureFault = fault;
  noteFaultChange(previous, fault);
}

/** The fault standing against the loaded governor, or null when it is in force. */
function nativeFault(): string | null {
  return configureFault ?? snapshotFault;
}

/** The loader's verdict for this process (cached by the loader itself). */
function nativeOutcome(): NativeOutcome {
  const outcome = loadNative(loadOptionsOverride ?? {});
  if (!outcome.available) return outcome;
  const missing = GOVERNOR_FUNCTIONS.filter((name) => typeof outcome.module[name] !== 'function');
  if (missing.length > 0) {
    return { available: false, reason: `the native module at ${outcome.path} has no ${missing[0]}(), so it cannot govern a budget` };
  }
  return outcome;
}

function governor(): GovernorModule | null {
  const outcome = nativeOutcome();
  return outcome.available ? (outcome.module as GovernorModule) : null;
}

function configureGovernor(native: GovernorModule): void {
  try {
    native.governorConfigure(
      { preset: current.preset === 'auto' ? 'balanced' : current.preset, cpuPercent: current.cpuPercent },
      current.preset === 'auto',
    );
    governorConfigured = true;
    setConfigureFault(null);
  } catch (err: unknown) {
    governorConfigured = false;
    retryConfigureAt = clock() + CONFIGURE_RETRY_MS;
    setConfigureFault(`the native governor refused the budget: ${describe(err)}`);
  }
}

/**
 * What in a snapshot is wrong, or null when every field this module and the
 * API read is there with the right type. A module built from another
 * contract passes the version handshake only if its version string agrees;
 * this is the check for the case where it does and the shape still differs.
 */
export function snapshotShapeFault(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'the snapshot is not an object';
  const v = value as Record<string, unknown>;
  for (const key of ['targetShare', 'share1s', 'workers', 'duty', 'ticks']) {
    if (typeof v[key] !== 'number' || !Number.isFinite(v[key])) return `"${key}" is not a finite number`;
  }
  for (const key of ['effective', 'thermal']) {
    if (typeof v[key] !== 'string') return `"${key}" is not a string`;
  }
  if (typeof v.paused !== 'boolean') return '"paused" is not a boolean';
  for (const key of ['onBattery', 'interacting']) {
    if (v[key] !== null && typeof v[key] !== 'boolean') return `"${key}" is neither a boolean nor null`;
  }
  const budget = v.budget as { preset?: unknown } | null | undefined;
  if (!budget || typeof budget !== 'object' || typeof budget.preset !== 'string') return '"budget.preset" is not a string';
  if (!v.mechanisms || typeof v.mechanisms !== 'object') return '"mechanisms" is not an object';
  return null;
}

/** The governor's snapshot, or null when it cannot answer — the fault recorded, the shim's rules in force. */
function readSnapshot(native: GovernorModule): GovernorSnapshot | null {
  let snap: unknown;
  try {
    snap = native.governorSnapshot();
  } catch (err: unknown) {
    setSnapshotFault(`the native governor could not report its state: ${describe(err)}`);
    return null;
  }
  const shape = snapshotShapeFault(snap);
  if (shape !== null) {
    setSnapshotFault(`the native governor's snapshot has an unexpected shape: ${shape}`);
    return null;
  }
  setSnapshotFault(null);
  return snap as GovernorSnapshot;
}

/**
 * The snapshot of a governor that is in force: loaded, holding the budget it
 * was last asked to hold, and answering. Null otherwise, which is what makes
 * every caller fall back to the shim's rules and say so.
 */
function liveSnapshot(): GovernorSnapshot | null {
  const native = governor();
  if (!native) return null;
  if (configureFault !== null && clock() >= retryConfigureAt) configureGovernor(native);
  if (configureFault !== null) return null;
  return readSnapshot(native);
}

export interface NativeStatus {
  available: boolean;
  version: string | null;
  /** Why the module is not loaded, or why a loaded one is not in force right now; null when it is. */
  reason: string | null;
}

function nativeStatus(outcome: NativeOutcome): NativeStatus {
  return outcome.available
    ? { available: true, version: outcome.version, reason: nativeFault() }
    : { available: false, version: null, reason: outcome.reason };
}

function currentSource(): BudgetSource {
  return governor() !== null && nativeFault() === null ? 'native' : 'node-shim';
}

/* ------------------------------ what is in force ------------------------------ */

export interface EffectiveBudget {
  preset: EffectiveBudgetPreset;
  /** The share of the machine the budget aims for, 0–1. */
  targetShare: number;
  source: BudgetSource;
}

const clampShare = (n: number): number => Math.min(1, Math.max(MIN_SHARE, n));
const clampDuty = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(MIN_DUTY, n)) : 1);

/**
 * What the setting resolves to right now. Automatic is Balanced, or Eco when
 * the native governor reports the machine on battery or thermally serious or
 * critical; without the governor nothing knows those, so Automatic is Balanced
 * and the source says who answered.
 */
export function effectiveBudget(setting: EngineBudgetSetting = current): EffectiveBudget {
  const snap = liveSnapshot();
  let preset: EffectiveBudgetPreset;
  if (setting.preset !== 'auto') preset = setting.preset;
  else if (snap && (snap.onBattery === true || snap.thermal === 'serious' || snap.thermal === 'critical')) preset = 'eco';
  else preset = 'balanced';
  const targetShare = snap
    ? snap.targetShare
    : setting.cpuPercent !== null ? clampShare(setting.cpuPercent / 100) : PRESET_CEILING[preset];
  // `source` follows the snapshot, not the module: a governor that loaded but
  // is not answering, or never adopted this budget, is not the source of the
  // number above.
  return { preset, targetShare, source: snap ? 'native' : 'node-shim' };
}

export interface EngineBudgetState {
  setting: EngineBudgetSetting;
  effective: EffectiveBudget;
  native: NativeStatus;
  /** The governor's live snapshot; null when nothing measured one. */
  snapshot: GovernorSnapshot | null;
  source: BudgetSource;
}

/** GET /api/engine/budget. */
export function budgetSnapshot(): EngineBudgetState {
  const effective = effectiveBudget(current);
  const snapshot = liveSnapshot();
  return {
    setting: currentEngineBudgetSetting(),
    effective,
    native: nativeStatus(nativeOutcome()),
    snapshot,
    source: snapshot ? 'native' : 'node-shim',
  };
}

export interface EngineCapabilities {
  native: NativeStatus;
  mechanisms: Record<MechanismName, Mechanism>;
  source: BudgetSource;
}

/** GET /api/engine/capabilities: probes only, nothing changes. */
export function engineCapabilities(): EngineCapabilities {
  const outcome = nativeOutcome();
  const absent = (reason: string): Record<MechanismName, Mechanism> => {
    const out = {} as Record<MechanismName, Mechanism>;
    for (const name of MECHANISM_NAMES) out[name] = { available: false, mechanism: 'none', reason };
    return out;
  };
  if (!outcome.available) {
    return {
      native: nativeStatus(outcome),
      mechanisms: absent(`the native core is not loaded, so no mechanism on this machine is used: ${outcome.reason}`),
      source: 'node-shim',
    };
  }
  try {
    return { native: nativeStatus(outcome), mechanisms: (outcome.module as GovernorModule).governorCapabilities(), source: 'native' };
  } catch (err: unknown) {
    // Nothing below was measured, so the answer must not claim the core.
    const reason = `the native core could not report its mechanisms: ${describe(err)}`;
    return { native: { ...nativeStatus(outcome), reason }, mechanisms: absent(reason), source: 'node-shim' };
  }
}

/* ------------------------------ per-scan state ------------------------------ */

/** Something a running engine can stop and continue: a gdu shard in flight. */
export interface Pausable {
  pause(): void;
  resume(): void;
}

interface ScanState {
  /**
   * When each worker of this scan last came back from `throttleBatch`
   * (performance.now()), keyed by worker slot. Per worker, like the Rust
   * governor's per-thread throttle: one stamp for the whole scan would let a
   * worker count another worker's rest as its own work, and the rests then
   * escalate to the cap — an Eco scan of 8,000 entries took over a minute.
   */
  lastReturnAt: Map<number, number>;
  /** A preset the scan was started with, whatever the setting says. */
  override?: EffectiveBudgetPreset;
  paused: boolean;
  waiting: Promise<void> | null;
  release: (() => void) | null;
  pausable?: Pausable;
}

const states = new Map<string, ScanState>();
const RESOLVED = Promise.resolve();

function stateFor(scanId: string): ScanState {
  let s = states.get(scanId);
  if (!s) {
    s = { lastReturnAt: new Map(), paused: false, waiting: null, release: null };
    states.set(scanId, s);
  }
  return s;
}

/** The budget a scan starts under, as its record keeps it. */
export function scanBudget(forced?: EffectiveBudgetPreset): ScanBudget {
  const effective = effectiveBudget(current);
  return { preset: forced ?? current.preset, effective: forced ?? effective.preset, source: effective.source };
}

/**
 * Register a scan: with a forced preset it runs at that preset whatever the
 * setting says or later becomes (the scheduler's scans run Eco). Returns what
 * the record should carry.
 */
export function beginScanBudget(scanId: string, forced?: EffectiveBudgetPreset): ScanBudget {
  const s = stateFor(scanId);
  if (forced) s.override = forced;
  return scanBudget(forced);
}

/**
 * Drop everything held for a scan: throttle timing, the forced preset, a
 * pause. A paused scan is released so a walker parked on the gate returns
 * (and reads `cancelled`, which is why the caller settled the record first).
 */
export function forgetScanBudget(scanId: string): void {
  const s = states.get(scanId);
  if (!s) return;
  states.delete(scanId);
  // A shard stopped in place is let go before its record is forgotten: whoever
  // is dropping the scan has killed it or is about to, and a killed process
  // ends either way, but a stopped one that nobody resumes never ends.
  if (s.paused) s.pausable?.resume();
  const release = s.release;
  s.paused = false;
  s.release = null;
  s.waiting = null;
  release?.();
}

/** Test-only: forget every scan, the setting, the faults and the loader override. */
export function resetEngineBudgetForTests(): void {
  for (const id of [...states.keys()]) forgetScanBudget(id);
  current = { ...DEFAULT_ENGINE_BUDGET };
  governorConfigured = false;
  snapshotFault = null;
  configureFault = null;
  retryConfigureAt = 0;
  clock = () => Date.now();
  loadOptionsOverride = null;
}

/** Test-only: the clock the configure retry window reads. */
export function setClockForTests(now: (() => number) | null): void {
  clock = now ?? (() => Date.now());
}

/** Test-only: point the loader at a fake module (or at a path that is not there). */
export function setNativeLoadOptionsForTests(opts: LoadOptions | null): void {
  loadOptionsOverride = opts;
}

/* ------------------------------ the duty ------------------------------ */

/**
 * How long to rest after `elapsedMs` of work at `duty`: (1 − duty) / duty ×
 * elapsed, capped at MAX_THROTTLE_SLEEP_MS. Turbo (duty 1) never rests, and
 * a duty of zero — which the governor cannot produce, but a bug could — is not
 * a reason to sleep forever.
 */
export function throttleSleepMs(duty: number, elapsedMs: number): number {
  if (!(duty > 0) || duty >= 1 || !(elapsedMs > 0)) return 0;
  return Math.min(MAX_THROTTLE_SLEEP_MS, ((1 - duty) / duty) * elapsedMs);
}

/** How often a parked worker looks again while the governor reports itself paused. */
const PAUSE_POLL_MS = 250;

/** The duty a scan's workers hold right now. */
function dutyFor(scanId: string): number {
  const override = states.get(scanId)?.override;
  const snap = liveSnapshot();
  if (override) {
    // The governor holds the machine-wide budget; a scan started at a forced
    // preset additionally holds itself to that preset's shim duty.
    const shim = SHIM_DUTY[override];
    return snap ? Math.min(shim, clampDuty(snap.duty)) : shim;
  }
  if (snap) return clampDuty(snap.duty);
  if (current.cpuPercent !== null) return clampShare(current.cpuPercent / 100);
  return SHIM_DUTY[effectiveBudget(current).preset];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Called by a walker worker after each batch. Rests in proportion to the
 * work since this worker's previous call came back — the first call is free,
 * a resume starts the clock afresh (a pause is not work), and a scan that
 * settled is forgotten, so nothing accrues between scans. The stamp is taken
 * AFTER the rest, so the rest itself is never counted as work; each worker
 * slot has its own, so one worker's rest is never counted as another's work.
 */
export async function throttleBatch(scanId: string, worker = 0): Promise<void> {
  const s = stateFor(scanId);
  const prev = s.lastReturnAt.get(worker);
  if (prev !== undefined) {
    const rest = throttleSleepMs(dutyFor(scanId), performance.now() - prev);
    if (rest >= 1) await sleep(rest);
  }
  // The governor pauses its workers under critical heat (and while a caller
  // holds it paused); the walker's workers are its workers too. A forgotten
  // scan is let go at once, so a cancel never waits on the weather.
  while (liveSnapshot()?.paused === true) {
    await sleep(PAUSE_POLL_MS);
    if (!states.has(scanId)) return;
  }
  s.lastReturnAt.set(worker, performance.now());
}

/* ------------------------------ workers and priority ------------------------------ */

/** The preset table's worker ceiling on `cores` cores — the Rust preset module's ranges. */
export function shimWorkerCap(preset: EffectiveBudgetPreset, cores: number): number {
  const n = Math.max(1, Math.floor(cores));
  if (preset === 'eco') return Math.min(2, n);
  if (preset === 'balanced') return Math.max(1, Math.floor(n / 2));
  return n;
}

/** How many walker workers a scan may run at once, read at start and re-read as it goes. */
export function workerCap(scanId?: string): number {
  const cores = Math.max(1, os.cpus().length);
  const override = scanId !== undefined ? states.get(scanId)?.override : undefined;
  if (override) return shimWorkerCap(override, cores);
  const snap = liveSnapshot();
  if (snap) return Math.max(1, Math.floor(snap.workers));
  return shimWorkerCap(effectiveBudget(current).preset, cores);
}

/** The nice value a child process (a gdu shard) is started with. */
export function childPriority(scanId?: string): number {
  const override = scanId !== undefined ? states.get(scanId)?.override : undefined;
  return CHILD_PRIORITY[override ?? effectiveBudget(current).preset];
}

/**
 * Lower a freshly spawned child's priority to the budget's. Only ever lowers:
 * a nice value of 0 is left alone rather than asked for, because an app that
 * is itself running niced could not grant it. A child that has already gone
 * (ESRCH) is not an error worth more than a line in the log.
 */
export function applyChildBudget(scanId: string, child: { pid?: number }): void {
  const priority = childPriority(scanId);
  if (priority <= 0 || typeof child.pid !== 'number') return;
  try {
    os.setPriority(child.pid, priority);
  } catch (err: unknown) {
    console.warn(`[treemap] could not lower the priority of the scan's helper process (pid ${child.pid}): ${describe(err)}`);
  }
}

/* ------------------------------ pause / resume ------------------------------ */

/**
 * A shard that can be stopped is registered for as long as it runs. If the
 * scan is already paused when the shard appears (the pause landed between the
 * gate and the spawn), it is stopped at once.
 */
export function registerPausable(scanId: string, pausable: Pausable): void {
  const s = stateFor(scanId);
  s.pausable = pausable;
  if (s.paused) pausable.pause();
}

export function unregisterPausable(scanId: string): void {
  const s = states.get(scanId);
  if (s) s.pausable = undefined;
}

export interface PauseSupport {
  supported: boolean;
  reason?: string;
}

/** Whether a gdu shard can be paused here: SIGSTOP/SIGCONT exist on POSIX and not on Windows. */
export function gduPauseSupport(platformName: PlatformName): PauseSupport {
  if (platformName === 'windows') {
    return {
      supported: false,
      reason: 'This scan is running on the gdu engine, which Windows cannot pause part-way through a folder. Stop the scan instead, or turn the gdu engine off and scan again.',
    };
  }
  return { supported: true };
}

function pauseSupportFor(engine: ScanResult['engine'], platformName: PlatformName): PauseSupport {
  if (engine === 'gdu-turbo') return gduPauseSupport(platformName);
  if (engine === 'cloud') return { supported: false, reason: 'A cloud listing waits on the provider, not on this computer, so there is nothing to pause.' };
  if (engine === 'ntfs-mft') return { supported: false, reason: 'The NTFS reader cannot be paused part-way. Stop the scan instead.' };
  return { supported: true };
}

export interface PauseOutcome {
  scanId: string;
  /** Whether the scan is paused after this call. */
  paused: boolean;
  /** Whether this scan's engine can be paused at all on this platform. */
  supported: boolean;
  /** Why it is not paused, or not pausable, in plain words. */
  reason?: string;
  source: BudgetSource;
}

export interface PauseDeps {
  /** Tests: decide the platform without changing the process. */
  platformName?: PlatformName;
}

/**
 * Pause a running scan. The walker checks the gate in its batch loop, so
 * `scanned` halts within one batch; a gdu shard in flight is stopped with
 * SIGSTOP and the next one is not started. A refusal always says why.
 */
export function pauseScan(scan: ScanResult, deps: PauseDeps = {}): PauseOutcome {
  const source = currentSource();
  const scanId = scan.scanId;
  if (scan.status !== 'running') {
    return { scanId, paused: false, supported: true, reason: 'This scan has already finished, so there is nothing to pause.', source };
  }
  const support = pauseSupportFor(scan.engine, deps.platformName ?? platform().platform);
  if (!support.supported) return { scanId, paused: false, supported: false, reason: support.reason, source };
  const s = stateFor(scanId);
  if (!s.paused) {
    s.paused = true;
    s.waiting = new Promise<void>((resolve) => {
      s.release = resolve;
    });
    s.pausable?.pause();
  }
  return { scanId, paused: true, supported: true, source };
}

/** Let a paused scan continue. Its throttle clock restarts, so the pause is not counted as work. */
export function resumeScan(scan: ScanResult): PauseOutcome {
  const source = currentSource();
  const scanId = scan.scanId;
  const s = states.get(scanId);
  if (!s || !s.paused) {
    const reason = scan.status !== 'running' ? 'This scan has already finished.' : 'This scan was not paused.';
    return { scanId, paused: false, supported: true, reason, source };
  }
  s.paused = false;
  s.lastReturnAt.clear();
  s.pausable?.resume();
  const release = s.release;
  s.release = null;
  s.waiting = null;
  release?.();
  return { scanId, paused: false, supported: true, source };
}

export function isScanPaused(scanId: string): boolean {
  return states.get(scanId)?.paused === true;
}

/** Resolves at once unless the scan is paused, then when it is resumed or forgotten. */
export function whenResumed(scanId: string): Promise<void> {
  return states.get(scanId)?.waiting ?? RESOLVED;
}

/**
 * The native core's surface: what `tm-node` (native/treemap-core/crates/tm-node)
 * exports to Node, hand-written and kept as the one declaration.
 * `src/services/engineBudget.ts` imports these types rather than re-declaring
 * them, so a change to the module is a change here first.
 *
 * Every shape is the Rust type serialised through serde with
 * `rename_all = "camelCase"`: enums are lower-case strings, `Option` is `null`,
 * and shares are fractions of the whole machine (0..1), never percent — except
 * the two arguments that take a percent, named so.
 *
 * The module is loaded by `src/services/scan/native.ts`, which refuses it when
 * `version()` is not `package.json`'s `nativeVersion`.
 */

/** A budget preset, as the Rust `Preset` serialises. */
export type NativePreset = 'eco' | 'balanced' | 'turbo';

/** The machine's thermal pressure, as the Rust `Thermal` serialises. */
export type NativeThermal = 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';

/** One OS mechanism: whether it is usable here and, when it is not, why. */
export interface Mechanism {
  available: boolean;
  /** The OS call or source the mechanism is made of. */
  mechanism: string;
  /** Why it is unavailable, in plain words; null when it is available. */
  reason: string | null;
}

/** The seven mechanisms `governorCapabilities()` probes. */
export type MechanismName = 'qos' | 'ioPolicy' | 'priority' | 'thermal' | 'battery' | 'interaction' | 'machineCpu';

/** What this machine can do, mechanism by mechanism (the Rust `Capabilities`). */
export interface NativeCapabilities {
  /** Per-thread scheduling class (QoS on macOS, power throttling on Windows, SCHED_BATCH on Linux). */
  qos: Mechanism;
  /** Per-thread disk I/O priority. */
  ioPolicy: Mechanism;
  /** Per-thread scheduling priority. */
  priority: Mechanism;
  /** The machine's thermal state. */
  thermal: Mechanism;
  /** Whether the machine runs on battery. */
  battery: Mechanism;
  /** Whether the user is interacting. */
  interaction: Mechanism;
  /** The whole machine's CPU busy share. */
  machineCpu: Mechanism;
}

/** The budget as `governorConfigure()` takes it (the Rust `Budget`). */
export interface NativeBudget {
  preset: NativePreset;
  /** 1..100 replaces the preset's ceiling; null or absent keeps it. */
  cpuPercent?: number | null;
}

/** The budget as the snapshot reports it: `cpuPercent` is always present. */
export interface NativeBudgetInForce {
  preset: NativePreset;
  cpuPercent: number | null;
}

/** What the governor did to a worker thread when it last applied the profile (the Rust `EnforceReport`). */
export interface NativeEnforceReport {
  qos: Mechanism;
  io: Mechanism;
  priority: Mechanism;
}

/** The governor's state at one instant (the Rust `Snapshot`). */
export interface NativeSnapshot {
  /** The budget as configured (during `governorHold()`, the hold's override). */
  budget: NativeBudgetInForce;
  /** The preset in force: the budget's, or what auto mode chose. */
  effective: NativePreset;
  /** The share of all cores the loop is holding right now, after thermal and interaction scaling. */
  targetShare: number;
  /** The mean measured share over the last second of ticks; 0 before the first tick. */
  share1s: number;
  /** How many workers may run. */
  workers: number;
  /** The fraction of wall time each worker may run (0.05..1). */
  duty: number;
  thermal: NativeThermal;
  onBattery: boolean | null;
  interacting: boolean | null;
  /** The whole machine's busy share when the OS last published one; null until it has. */
  machineBusyShare: number | null;
  /** Whether workers are blocked in throttle, by a caller or by critical heat. */
  paused: boolean;
  /** Ticks the loop has run. */
  ticks: number;
  mechanisms: NativeEnforceReport;
}

/** What a hold measured (the Rust `HoldReport`), in shares of the machine. */
export interface NativeHoldReport {
  /** The share the governor was holding when the hold began (the target asked for, after any thermal or interaction scaling). */
  target: number;
  /** One sample every 100 ms. */
  samples: number[];
  mean: number;
  /** Mean of the second half of the samples, once the loop has settled. */
  meanLastHalf: number;
  /** The 95th percentile of |sample − target|. */
  p95AbsError: number;
  /** Whether |meanLastHalf − target| ≤ 0.05. */
  withinBand: boolean;
  workersFinal: number;
  dutyFinal: number;
}

/** The crate's version; must equal `package.json`'s `nativeVersion` for the loader to accept the module. */
export function version(): string;

/** The seven mechanisms this machine offers. Probed only; nothing is applied. */
export function governorCapabilities(): NativeCapabilities;

/**
 * Sets the budget live. `auto` makes it Balanced that flips to Eco on battery or
 * under serious heat. Throws, and keeps the budget in force, when `budget` is not
 * one of the three presets with `cpuPercent` a whole number 1..100 or null.
 */
export function governorConfigure(budget: NativeBudget, auto: boolean): void;

/** The governor's state at this instant. */
export function governorSnapshot(): NativeSnapshot;

/** Blocks every worker at its next throttle until `governorResume()`. */
export function governorPause(): void;

/** Releases workers paused by `governorPause()`; a thermal pause stays. */
export function governorResume(): void;

/**
 * Holds `targetPercent` of the machine for `seconds` with a synthetic load on the
 * configured preset (only the ceiling is replaced), then hands the budget back.
 * Test-only: it runs on libuv's thread pool, which is fine for a measurement of
 * a few seconds and not for a scan. Rejects outside 1..100 percent or 1..600
 * seconds, and while another hold runs.
 */
export function governorHold(targetPercent: number, seconds: number): Promise<NativeHoldReport>;

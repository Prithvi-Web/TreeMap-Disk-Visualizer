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

/* ------------------------------ the native walker (Phase 3) ------------------------------ */

/** The listing path a platform offers, as the Rust `FastPath` names it. */
export type NativeFastPath = 'bulk' | 'extdDirInfo' | 'getdents' | 'perEntry' | 'unavailable';

/** What `scanProbe()` found: the path the root would be listed with, and why, in a sentence. */
export interface NativeProbe {
  fastPath: NativeFastPath;
  reason: string;
}

/** What `scanStart()` takes. */
export interface ScanStartOptions {
  /** Absolute paths the walk never descends into (the legacy never-descend list, passed from Node). */
  neverDescend: string[];
  /** Record access times (`atimeMs` is NaN otherwise). */
  wantAtime: boolean;
  /** A fixed worker count, still capped by the governor; omitted or 0 lets the hill-climber decide. */
  maxWorkers?: number;
  /** Bytes per worker listing buffer; omitted or 0 is the crate's default (256 KiB). */
  bufferBytes?: number;
}

/** What `scanPoll()` reports: the atomics the walk keeps, read without blocking. */
export interface NativeProgress {
  /** True once `scanTake()` will not block. */
  done: boolean;
  /** How the walk ended other than with an output (the sentence `scanTake()` throws); null while running or when it succeeded. */
  error: string | null;
  /** Entries discovered under the root so far (the root not counted). */
  entries: number;
  dirs: number;
  files: number;
  /** The leaves' logical bytes so far. */
  bytes: number;
  /** A directory being listed, sampled at most every 50 ms; null before the first sample. */
  currentPath: string | null;
}

/** What the walk measured about itself (the Rust `WalkStats`). */
export interface WalkStats {
  /** Directories listed successfully (the root included; refused ones not). */
  dirsListed: number;
  /** Entries discovered under the root (the root itself not counted). */
  entries: number;
  wallMs: number;
  /** The walker threads' own CPU time in seconds (CLOCK_THREAD_CPUTIME_ID); null where the platform has no thread clock yet. */
  cpuSeconds: number | null;
  fastPath: NativeFastPath;
  workersPeak: number;
  climbSteps: number;
  /** Entries whose metadata the OS refused (EACCES/EPERM); they are omitted. */
  deniedEntries: number;
  /** Entries omitted for any other per-entry error, plus entries kept with a withheld attribute. */
  unreadableEntries: number;
  /** Entries flagged dataless (FLAG_DATALESS). */
  dataless: number;
}

/**
 * The walk's product: columns in discovery order — index 0 is the root and
 * `parent[i] < i` for every `i > 0` — created from the Rust vectors without
 * copying and freed when JavaScript drops them. Node `i`'s name is the UTF-8
 * bytes `names[nameOff[i] .. nameOff[i + 1])`.
 */
export interface WalkResult {
  parent: Uint32Array;
  /** `parent.length + 1` offsets into `names`. */
  nameOff: Uint32Array;
  names: Uint8Array;
  /** 0 = file (or socket, fifo, device), 1 = directory, 2 = symlink (never followed; its size is the target text's length). */
  kind: Uint8Array;
  /** Bit 1 = dataless, bit 2 = a directory that could not be listed (see the refusal columns). */
  flags: Uint8Array;
  /** Logical size in bytes (0 for directories). */
  size: Float64Array;
  /** Allocated bytes (0 for directories). */
  allocBytes: Float64Array;
  /** `sec * 1e3 + nsec / 1e6`, unrounded, exactly as Node computes `mtimeMs` (P3-6); NaN when withheld. */
  mtimeMs: Float64Array;
  /** The same for atime; NaN when not asked for or not recorded. */
  atimeMs: Float64Array;
  /** Every leaf whose link count exceeds one, sorted by node: its index, `st_dev` and `st_ino` as doubles (P3-7). */
  hardlinkNode: Uint32Array;
  hardlinkDev: Float64Array;
  hardlinkIno: Float64Array;
  /** Every directory that could not be listed, sorted by node, and why: 1 denied, 2 vanished, 3 unreadable. */
  refusalNode: Uint32Array;
  refusalWhy: Uint8Array;
  stats: WalkStats;
}

/** Opens and lists `root` once with this platform's listing; no side effects beyond the read. Never throws. */
export function scanProbe(root: string): NativeProbe;

/**
 * Starts a walk of `root` on the crate's own threads, governed by the same
 * process-wide governor `governorConfigure()` drives, and returns its handle.
 * Throws, in plain English, when the root is not a directory or cannot be
 * read (prefixed with Node's errno spelling, e.g. `ENOENT: …`), when this
 * platform has no native listing yet, or when `opts` has the wrong shape.
 */
export function scanStart(root: string, opts: ScanStartOptions): number;

/** The walk's progress right now; throws when `handle` is unknown (taken, or never started). */
export function scanPoll(handle: number): NativeProgress;

/** Stops the workers at their next check (between directories and every 256 entries inside one); nothing is re-listed on resume. */
export function scanPause(handle: number): void;

/** Lets paused workers continue where they stopped. */
export function scanResume(handle: number): void;

/** Ends the walk; `scanTake()` then throws the cancellation and frees the handle. */
export function scanCancel(handle: number): void;

/**
 * The walk's output. Blocks until the walk is done (poll first), then frees
 * the handle. Throws with a plain-English message when the walk failed or was
 * cancelled — the handle is freed either way — and when `handle` is unknown.
 */
export function scanTake(handle: number): WalkResult;

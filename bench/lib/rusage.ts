/**
 * Resource usage of this process, for the benchmark harness.
 *
 * `snapshotUsage()` reads what the process has consumed so far and
 * `diffUsage()` turns two snapshots into the cost of what happened between
 * them. Every field is either measured or `null` with a stated reason — the
 * harness never prints a number it did not take, and a counter that went
 * backwards is a broken measurement, so `diffUsage` throws rather than clamp
 * it to zero or report it as a saving.
 *
 * Sources:
 *   - CPU seconds and peak RSS: `process.resourceUsage()` — user + system CPU
 *     in microseconds; `maxRSS` in KiB on macOS and Linux, bytes on Windows.
 *   - Bytes read: macOS compiles `bench/probes/darwin-rusage.c` into a
 *     private `mkdtemp` directory and asks the kernel for
 *     `proc_pid_rusage(RUSAGE_INFO_V4).ri_diskio_bytesread`: bytes this task
 *     physically read from the device — page-cache hits and children's I/O do
 *     not count. Linux reads `read_bytes` from `/proc/self/io`, which means
 *     the same thing. Windows exposes nothing to Node, so `bytesRead` is
 *     `null` and the reason says so. When the probe cannot be compiled, the
 *     compiler's own message is the reason.
 *   - Children's CPU: the probe's `ri_child_*_time` on macOS and
 *     `cutime + cstime` from `/proc/self/stat` on Linux — both accumulate only
 *     as children are reaped; `null` on Windows.
 *
 * The compile happens once per bench invocation, in the harness process,
 * before the first warm-up pass (`probeHandoff()`, called by suites.ts), and
 * never in a measuring child: a compile (clang, thousands of SDK header
 * reads) is foreign work that has no place between the warm-up and a timed
 * scan. It was suspected of evicting the corpus's metadata and slowing
 * enum200k by ~100 ms; an A/B on 23 Sep 2026 found no such effect (native,
 * Turbo, warm: 625.9 ms with the compile in every child, 646.9 with no probe
 * at all, 650.8 with this hand-off), so the hand-off is a rule of method, not
 * the explanation of any number. The harness names the binary — or
 * the reason its build failed — in the child's environment
 * (`PROBE_BINARY_ENV` / `PROBE_FAILURE_ENV`); a process given neither, such
 * as a standalone run, compiles its own on its first snapshot, as before.
 *
 * Two artefacts of the method, so nobody mistakes them for results: each
 * macOS snapshot spawns and reaps the probe, which adds the probe's own
 * ~1 ms to the children's CPU; and peak RSS is a lifetime maximum, so a run's
 * peak is only its own when nothing bigger ran earlier in the same process.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export interface UsageSnapshot {
  /** `performance.now()` when the snapshot was taken, milliseconds. */
  at: number;
  /** User + system CPU consumed by this process so far, seconds. */
  cpuSeconds: number;
  /** User + system CPU of reaped child processes, seconds; `null` where the OS does not tell Node. */
  childCpuSeconds: number | null;
  /** Peak resident set size so far, bytes. */
  peakRssBytes: number;
  /** Bytes physically read from disk by this process so far; `null` when unavailable. */
  bytesRead: number | null;
  /** Where `bytesRead` came from, or why it is `null`. */
  bytesReadReason: string;
}

export interface UsageDelta {
  wallMs: number;
  cpuSeconds: number;
  childCpuSeconds: number | null;
  /** The lifetime peak as of the later snapshot — a maximum, not a difference. */
  peakRssBytes: number;
  bytesRead: number | null;
  bytesReadReason: string;
}

type PlatformIo = Pick<UsageSnapshot, 'childCpuSeconds' | 'bytesRead' | 'bytesReadReason'>;
type BytesRead = Pick<UsageSnapshot, 'bytesRead' | 'bytesReadReason'>;

interface DarwinProbeReading {
  pid: number;
  diskBytesRead: number;
  diskBytesWritten: number;
  userNs: number;
  systemNs: number;
  childUserNs: number;
  childSystemNs: number;
  peakFootprint: number;
}

type ProbeState =
  | { kind: 'ready'; binary: string }
  | { kind: 'failed'; reason: string };

const MICROSECONDS_PER_SECOND = 1_000_000;
const NANOSECONDS_PER_SECOND = 1_000_000_000;
const BYTES_PER_KIB = 1024;
/** Linux reports the `/proc/self/stat` times in USER_HZ ticks, fixed at 100 by the kernel ABI. */
const LINUX_USER_HZ = 100;
/** `cutime` and `cstime` are fields 16 and 17 of `/proc/self/stat`; field 3 is the first after the comm. */
const PROC_STAT_CUTIME_INDEX = 13;
const PROC_STAT_CSTIME_INDEX = 14;
const FAILURE_MESSAGE_LIMIT = 200;
const PROBE_SOURCE = path.join(__dirname, '..', 'probes', 'darwin-rusage.c');
/**
 * The probe is compiled into a private `mkdtemp` directory (owner-only,
 * unpredictable name) and executed only from there — by the process that
 * built it and by the measuring children that process names it to in their
 * environment. A shared, predictable path trusted by modification time would
 * let any other process of the same user plant a binary the harness then
 * runs; a fresh directory per build costs one clang invocation and closes
 * that door. The directory is removed when the process that built it exits.
 */
const PROBE_DIR_PREFIX = path.join(os.tmpdir(), 'treemap-bench-probe-');
const PROBE_NAME = 'darwin-rusage';
/** A compiler or probe that has not returned in this long is a failure, not a wait. */
const COMPILE_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const DARWIN_SOURCE = 'proc_pid_rusage(RUSAGE_INFO_V4).ri_diskio_bytesread via bench/probes/darwin-rusage.c';
const LINUX_SOURCE = 'read_bytes from /proc/self/io';
const WINDOWS_REASON = 'bytes read are not exposed to Node on Windows; GetProcessIoCounters needs native code';

/** Names the probe binary the harness built, in a measuring child's environment. */
export const PROBE_BINARY_ENV = 'TREEMAP_BENCH_PROBE';
/** Carries the reason the harness's probe build failed, in a measuring child's environment; it wins over a binary. */
export const PROBE_FAILURE_ENV = 'TREEMAP_BENCH_PROBE_FAILURE';

let darwinProbe: ProbeState | undefined;
let probeBuilds = 0;

export async function snapshotUsage(): Promise<UsageSnapshot> {
  const at = performance.now();
  const usage = process.resourceUsage();
  const cpuSeconds = (usage.userCPUTime + usage.systemCPUTime) / MICROSECONDS_PER_SECOND;
  const peakRssBytes = process.platform === 'win32' ? usage.maxRSS : usage.maxRSS * BYTES_PER_KIB;
  const io = await platformIo();
  return { at, cpuSeconds, peakRssBytes, ...io };
}

export function diffUsage(before: UsageSnapshot, after: UsageSnapshot): UsageDelta {
  const wallMs = delta('at', before.at, after.at);
  const cpuSeconds = delta('cpuSeconds', before.cpuSeconds, after.cpuSeconds);
  const childCpuSeconds =
    before.childCpuSeconds === null || after.childCpuSeconds === null
      ? null
      : delta('childCpuSeconds', before.childCpuSeconds, after.childCpuSeconds);
  assertMonotonic('peakRssBytes', before.peakRssBytes, after.peakRssBytes);
  const bytesRead =
    before.bytesRead === null || after.bytesRead === null
      ? null
      : delta('bytesRead', before.bytesRead, after.bytesRead);
  const bytesReadReason = before.bytesRead === null ? before.bytesReadReason : after.bytesReadReason;
  return { wallMs, cpuSeconds, childCpuSeconds, peakRssBytes: after.peakRssBytes, bytesRead, bytesReadReason };
}

function assertMonotonic(counter: string, before: number, after: number): void {
  if (after < before) {
    throw new Error(`usage went backwards: ${counter} ${before} -> ${after}`);
  }
}

function delta(counter: string, before: number, after: number): number {
  assertMonotonic(counter, before, after);
  return after - before;
}

async function platformIo(): Promise<PlatformIo> {
  switch (process.platform) {
    case 'darwin':
      return darwinIo();
    case 'linux':
      return linuxIo();
    case 'win32':
      return { childCpuSeconds: null, bytesRead: null, bytesReadReason: WINDOWS_REASON };
    default:
      return {
        childCpuSeconds: null,
        bytesRead: null,
        bytesReadReason: `bytes read are not implemented for ${process.platform}`,
      };
  }
}

/* ------------------------------- macOS -------------------------------- */

function darwinIo(): PlatformIo {
  const probe = darwinProbeState();
  if (probe.kind === 'failed') {
    return { childCpuSeconds: null, bytesRead: null, bytesReadReason: probe.reason };
  }
  try {
    const reading = readDarwinProbe(probe.binary);
    return {
      childCpuSeconds: (reading.childUserNs + reading.childSystemNs) / NANOSECONDS_PER_SECOND,
      bytesRead: reading.diskBytesRead,
      bytesReadReason: DARWIN_SOURCE,
    };
  } catch (error: unknown) {
    return { childCpuSeconds: null, bytesRead: null, bytesReadReason: `darwin-rusage failed: ${errorMessage(error)}` };
  }
}

/** The probe the harness handed over, or else one compiled here — at most once per process; the outcome, good or bad, is remembered. */
function darwinProbeState(): ProbeState {
  darwinProbe ??= handedOverProbe() ?? buildDarwinProbe();
  return darwinProbe;
}

/** What the harness put in this process's environment: its built probe, its build's failure, or nothing (`undefined`: build one here). */
function handedOverProbe(): ProbeState | undefined {
  const failure = process.env[PROBE_FAILURE_ENV];
  if (failure) return { kind: 'failed', reason: failure };
  const binary = process.env[PROBE_BINARY_ENV];
  if (!binary) return undefined;
  if (!path.isAbsolute(binary) || !fs.existsSync(binary)) {
    return { kind: 'failed', reason: `the probe the harness handed over (${binary}) is not there to run` };
  }
  return { kind: 'ready', binary };
}

/**
 * The environment a measuring child needs to use this process's probe
 * instead of compiling one: the binary, or the reason the build failed.
 * Builds the probe first if this process has not — call it before the
 * warm-up pass. Empty off macOS, where nothing is compiled.
 */
export function probeHandoff(): Record<string, string> {
  if (process.platform !== 'darwin') return {};
  const probe = darwinProbeState();
  return probe.kind === 'ready' ? { [PROBE_BINARY_ENV]: probe.binary } : { [PROBE_FAILURE_ENV]: probe.reason };
}

let probeDir: string | undefined;

/** Where this process's probe binary lives, once built or handed over; `null` before the first snapshot or when the build failed. */
export function probeLocation(): string | null {
  return darwinProbe?.kind === 'ready' ? darwinProbe.binary : null;
}

/** How many times this process ran the compiler for the probe: 1 in the harness or a standalone run, 0 in a child it handed its probe to. */
export function probeBuildCount(): number {
  return probeBuilds;
}

function buildDarwinProbe(): ProbeState {
  probeBuilds += 1;
  try {
    const sdk = spawnSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8', timeout: COMPILE_TIMEOUT_MS });
    const sdkPath = (sdk.stdout ?? '').trim();
    if (sdk.error || sdk.status !== 0 || sdkPath === '') {
      return { kind: 'failed', reason: describeFailure('xcrun --sdk macosx --show-sdk-path', sdk) };
    }
    probeDir = fs.mkdtempSync(PROBE_DIR_PREFIX);
    const binary = path.join(probeDir, PROBE_NAME);
    const compile = spawnSync(
      'xcrun',
      ['--sdk', 'macosx', 'clang', '-O2', '-isysroot', sdkPath, '-o', binary, PROBE_SOURCE],
      { encoding: 'utf8', timeout: COMPILE_TIMEOUT_MS },
    );
    if (compile.error || compile.status !== 0) {
      removeProbeDir();
      return { kind: 'failed', reason: describeFailure('compiling bench/probes/darwin-rusage.c', compile) };
    }
    process.once('exit', removeProbeDir);
    return { kind: 'ready', binary };
  } catch (error: unknown) {
    removeProbeDir();
    return { kind: 'failed', reason: `building the darwin-rusage probe failed: ${errorMessage(error)}` };
  }
}

function removeProbeDir(): void {
  if (probeDir === undefined) return;
  try {
    fs.rmSync(probeDir, { recursive: true, force: true });
  } catch {
    /* a leftover owner-only directory holds nothing but a compiled probe */
  }
  probeDir = undefined;
}

function readDarwinProbe(binary: string): DarwinProbeReading {
  const run = spawnSync(binary, [String(process.pid)], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  if (run.error || run.status !== 0) {
    throw new Error(describeFailure('running the darwin-rusage probe', run));
  }
  const record = parseJsonObject(run.stdout);
  return {
    pid: numberField(record, 'pid'),
    diskBytesRead: numberField(record, 'diskBytesRead'),
    diskBytesWritten: numberField(record, 'diskBytesWritten'),
    userNs: numberField(record, 'userNs'),
    systemNs: numberField(record, 'systemNs'),
    childUserNs: numberField(record, 'childUserNs'),
    childSystemNs: numberField(record, 'childSystemNs'),
    peakFootprint: numberField(record, 'peakFootprint'),
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`the probe printed ${text.trim()} instead of a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function numberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`the probe printed no usable ${field}: ${JSON.stringify(value)}`);
  }
  return value;
}

/* ------------------------------- Linux -------------------------------- */

async function linuxIo(): Promise<PlatformIo> {
  const [bytes, childCpuSeconds] = await Promise.all([linuxBytesRead(), linuxChildCpuSeconds()]);
  return { childCpuSeconds, ...bytes };
}

async function linuxBytesRead(): Promise<BytesRead> {
  try {
    const text = await fsp.readFile('/proc/self/io', 'utf8');
    return { bytesRead: parseProcIoReadBytes(text), bytesReadReason: LINUX_SOURCE };
  } catch (error: unknown) {
    return { bytesRead: null, bytesReadReason: `/proc/self/io could not be read: ${errorMessage(error)}` };
  }
}

function parseProcIoReadBytes(text: string): number {
  const match = /^read_bytes:\s*(\d+)\s*$/m.exec(text);
  if (!match) throw new Error('no read_bytes line');
  return Number(match[1]);
}

/** `null` when `/proc/self/stat` cannot be read or parsed — the field has no reason slot, so it stays unknown. */
async function linuxChildCpuSeconds(): Promise<number | null> {
  try {
    const text = await fsp.readFile('/proc/self/stat', 'utf8');
    return parseProcStatChildTicks(text) / LINUX_USER_HZ;
  } catch {
    return null;
  }
}

/** The comm field may contain spaces and parentheses, so the fields are counted from its closing parenthesis. */
function parseProcStatChildTicks(text: string): number {
  const commEnd = text.lastIndexOf(')');
  if (commEnd < 0) throw new Error('no comm field');
  const fields = text.slice(commEnd + 1).trim().split(/\s+/);
  const cutime = Number(fields[PROC_STAT_CUTIME_INDEX]);
  const cstime = Number(fields[PROC_STAT_CSTIME_INDEX]);
  if (!Number.isFinite(cutime) || !Number.isFinite(cstime)) throw new Error('no cutime/cstime fields');
  return cutime + cstime;
}

/* ------------------------------ helpers ------------------------------- */

function describeFailure(what: string, result: SpawnSyncReturns<string>): string {
  const detail = result.error
    ? result.error.message
    : (result.stderr ?? '').trim() || `exit status ${result.status ?? 'null'}`;
  return `${what} failed: ${detail.slice(0, FAILURE_MESSAGE_LIMIT)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The machine record: what every benchmark number depends on.
 *
 * A throughput figure without the machine it was taken on is not a claim
 * about anything, so every result file carries this record beside its
 * numbers. Everything here is read, not assumed: the CPU model, core count and
 * memory from `os`, the commit from `git rev-parse HEAD` (or `'unknown'` when
 * there is no git to ask — which then counts as a dirty tree, see `gitHead`),
 * the load average at the moment the record was
 * taken, and on macOS three `sysctl` values — `kern.maxvnodes`, the ceiling on
 * how many directory entries a warm metadata cache can hold (§12 of
 * docs/engine/CURRENT-STATE.md), and the performance/efficiency core split
 * that decides how many threads are actually fast.
 *
 * The tier is a coarse label so that results from different machines are not
 * compared as if they were the same. `tierReason` states which clause fired,
 * so a surprising tier can be argued with rather than trusted.
 */
import os from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

export type MachineTier = 'A' | 'B' | 'C';

export interface MachineRecord {
  cpuModel: string;
  cores: number;
  /** Performance cores (`hw.perflevel0.logicalcpu`); `null` off macOS or when the key is absent. */
  perfCores: number | null;
  /** Efficiency cores (`hw.perflevel1.logicalcpu`); `null` off macOS or when the key is absent. */
  effCores: number | null;
  memoryBytes: number;
  platform: string;
  /** `process.arch`: a baseline from one architecture says nothing about another. */
  arch: string;
  osRelease: string;
  node: string;
  /** Full `git rev-parse HEAD`, `-dirty` appended when the tree counts as dirty (see `dirty`); `'unknown'` when git cannot name the commit. */
  commit: string;
  /** True when the tree had uncommitted changes outside bench/baselines/ (see `dirtyFromStatus`), or when git could not say whether it had (see `dirtyReason`). */
  dirty: boolean;
  /** Set when the tree counts as dirty because git could not answer: its failure, in its own words. Absent when git answered. */
  dirtyReason?: string;
  /** 1/5/15-minute load; `null` where the OS does not measure it (Windows). */
  loadAvg: number[] | null;
  /** `kern.maxvnodes`; `null` off macOS. */
  maxVnodes: number | null;
  tier: MachineTier;
  tierReason: string;
}

export interface TierVerdict {
  tier: MachineTier;
  tierReason: string;
}

const GIB = 1024 ** 3;
const TIER_A_MIN_CORES = 8;
const TIER_A_MIN_MEMORY_BYTES = 32 * GIB;
const TIER_C_MAX_CORES = 4;
const TIER_C_MAX_MEMORY_BYTES = 8 * GIB;
/**
 * Only Apple's own Pro/Max/Ultra parts skip the core-and-memory rule: an
 * `Intel(R) Core(TM) Ultra 5` laptop with 8 GiB is a Tier C machine, and
 * `Intel(R) Xeon(R) Processor` contains "Pro" without being one.
 */
const TIER_A_MODEL = /^Apple M\d+ (?:Pro|Max|Ultra)\b/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const REPO_ROOT = path.join(__dirname, '..', '..');

function formatGiB(bytes: number): string {
  return (bytes / GIB).toFixed(1);
}

/** Printed from the constants that decide them, so the sentence cannot drift from the rule. */
const A_CLAUSE = `>= ${TIER_A_MIN_CORES} cores and >= ${formatGiB(TIER_A_MIN_MEMORY_BYTES)} GiB, or an Apple Pro/Max/Ultra part`;
const C_CLAUSE = `<= ${TIER_C_MAX_CORES} cores or <= ${formatGiB(TIER_C_MAX_MEMORY_BYTES)} GiB`;

export async function describeMachine(): Promise<MachineRecord> {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model.trim() || 'unknown';
  const cores = cpus.length;
  const memoryBytes = os.totalmem();
  const isDarwin = process.platform === 'darwin';
  const { tier, tierReason } = classifyTier(cpuModel, cores, memoryBytes);
  const head = gitHead();
  const commit = head.commit === UNKNOWN_COMMIT || !head.dirty ? head.commit : `${head.commit}-dirty`;
  return {
    cpuModel,
    cores,
    perfCores: isDarwin ? sysctlNumber('hw.perflevel0.logicalcpu') : null,
    effCores: isDarwin ? sysctlNumber('hw.perflevel1.logicalcpu') : null,
    memoryBytes,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    node: process.version,
    commit,
    dirty: head.dirty,
    ...(head.dirtyReason === undefined ? {} : { dirtyReason: head.dirtyReason }),
    loadAvg: process.platform === 'win32' ? null : os.loadavg(),
    maxVnodes: isDarwin ? sysctlNumber('kern.maxvnodes') : null,
    tier,
    tierReason,
  };
}

/**
 * The prompt's tiers (its Section 5.1) as a rule a person can argue with.
 * C is decided first — a small machine is small whatever its name says —
 * then A, then B for everything between.
 */
export function classifyTier(cpuModel: string, cores: number, memoryBytes: number): TierVerdict {
  const memory = `${formatGiB(memoryBytes)} GiB`;
  if (cores <= TIER_C_MAX_CORES || memoryBytes <= TIER_C_MAX_MEMORY_BYTES) {
    return { tier: 'C', tierReason: `${cores} cores and ${memory} fall in the C clause (${C_CLAUSE})` };
  }
  if (cores >= TIER_A_MIN_CORES && memoryBytes >= TIER_A_MIN_MEMORY_BYTES) {
    return { tier: 'A', tierReason: `${cores} cores and ${memory} meet the A clause (${A_CLAUSE})` };
  }
  if (TIER_A_MODEL.test(cpuModel)) {
    return { tier: 'A', tierReason: `CPU model "${cpuModel}" is an Apple Pro/Max/Ultra part, the A clause (${A_CLAUSE})` };
  }
  return { tier: 'B', tierReason: `${cores} cores and ${memory}: neither the A clause (${A_CLAUSE}) nor the C clause (${C_CLAUSE}) applies` };
}

/** One key per call: a missing key would otherwise shift every line after it. */
function sysctlNumber(key: string): number | null {
  const result = spawnSync('sysctl', ['-n', key], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  const value = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

const UNKNOWN_COMMIT = 'unknown';
/** Enough of git's own error to name the failure. */
const GIT_ERROR_LIMIT = 200;

function git(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' });
}

/** Why a git invocation did not answer, in its own words; null when it did. */
function gitFailure(command: string, result: SpawnSyncReturns<string>): string | null {
  if (result.error) return `${command} failed: ${result.error.message}`;
  if (result.status === 0) return null;
  const detail = (result.stderr ?? '').trim() || (result.signal ? `killed by ${result.signal}` : `exit status ${String(result.status)}`);
  return `${command} failed: ${detail.slice(0, GIT_ERROR_LIMIT)}`;
}

/**
 * A baseline must cite the code that was measured: an uncommitted change is
 * part of it. The check fails closed — a git that cannot name the commit or
 * cannot list the tree's changes makes the tree dirty, with git's error as
 * the reason, never clean — and asks for every untracked file by name
 * (`--untracked-files=all`), so a user's `status.showUntrackedFiles=no` cannot
 * hide code that was measured.
 */
function gitHead(): { commit: string; dirty: boolean; dirtyReason?: string } {
  const head = git(['rev-parse', 'HEAD']);
  const headFailure = gitFailure('git rev-parse HEAD', head);
  if (headFailure !== null) return { commit: UNKNOWN_COMMIT, dirty: true, dirtyReason: headFailure };
  const commit = head.stdout.trim();
  if (!COMMIT_PATTERN.test(commit)) {
    return { commit: UNKNOWN_COMMIT, dirty: true, dirtyReason: `git rev-parse HEAD printed ${JSON.stringify(commit.slice(0, GIT_ERROR_LIMIT))}, which is not a commit` };
  }
  const status = git(['status', '--porcelain', '--untracked-files=all']);
  const statusFailure = gitFailure('git status', status);
  if (statusFailure !== null) return { commit, dirty: true, dirtyReason: statusFailure };
  return { commit, dirty: dirtyFromStatus(status.stdout) };
}

/**
 * The one directory of measurement data the harness writes where git sees it:
 * `--record`'s baselines. Results go to bench/results/, which git ignores;
 * corpora, probes and the app's data live under the OS temp directory.
 */
const RECORDED_DATA_DIR = 'bench/baselines/';

/**
 * Any change to a tracked file, or any untracked file that could have been
 * code, makes the tree dirty — except a change confined to bench/baselines/:
 * baselines the harness records itself (a batch's first `--record` leaves one
 * new or replaced there before the next series is measured), which the code
 * being measured never reads. A rename or copy is confined only when both of
 * its paths are, and bench/baselines-old/ is not bench/baselines/.
 */
export function dirtyFromStatus(porcelain: string): boolean {
  return porcelain
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .some((line) => !statusPaths(line).every(isRecordedData));
}

/** The paths a `git status --porcelain` line names: `XY path`, or `XY from -> to` for a rename (R) or copy (C). */
function statusPaths(line: string): string[] {
  const paths = line.slice(3);
  return /[RC]/.test(line.slice(0, 2)) ? paths.split(' -> ') : [paths];
}

/** Git quotes a path holding a space or an unusual byte; the prefix is plain ASCII, which it never escapes, so it is read after the quote. */
function isRecordedData(statusPath: string): boolean {
  return (statusPath.startsWith('"') ? statusPath.slice(1) : statusPath).startsWith(RECORDED_DATA_DIR);
}

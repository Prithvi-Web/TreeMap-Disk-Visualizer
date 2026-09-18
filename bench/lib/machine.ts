/**
 * The machine record: what every benchmark number depends on.
 *
 * A throughput figure without the machine it was taken on is not a claim
 * about anything, so every result file carries this record beside its
 * numbers. Everything here is read, not assumed: the CPU model, core count and
 * memory from `os`, the commit from `git rev-parse HEAD` (or `'unknown'` when
 * there is no git to ask), the load average at the moment the record was
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
import { spawnSync } from 'node:child_process';

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
  /** Full `git rev-parse HEAD`, `-dirty` appended when the tree had uncommitted changes; `'unknown'` when git cannot answer. */
  commit: string;
  dirty: boolean;
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
    commit: head.dirty ? `${head.commit}-dirty` : head.commit,
    dirty: head.dirty,
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

/** A baseline must cite the code that was measured: an uncommitted change is part of it. */
function gitHead(): { commit: string; dirty: boolean } {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.error || result.status !== 0) return { commit: 'unknown', dirty: false };
  const head = result.stdout.trim();
  if (!COMMIT_PATTERN.test(head)) return { commit: 'unknown', dirty: false };
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const dirty = !status.error && status.status === 0 && dirtyFromStatus(status.stdout);
  return { commit: head, dirty };
}

/**
 * Any modified tracked file, or any untracked file that could have been code,
 * makes the tree dirty. A baseline the harness itself just recorded under
 * bench/baselines/ is the one untracked file that cannot have been measured.
 */
export function dirtyFromStatus(porcelain: string): boolean {
  return porcelain
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .some((line) => !(line.startsWith('?? ') && line.slice(3).startsWith('bench/baselines/')));
}

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
  osRelease: string;
  node: string;
  /** Full `git rev-parse HEAD`, or `'unknown'` when git cannot answer. */
  commit: string;
  loadAvg: number[];
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
 * Word-bounded on purpose: `Intel(R) Xeon(R) Processor` contains "Pro" and is
 * not a Pro/Max/Ultra part.
 */
const TIER_A_MODEL = /\b(?:Pro|Max|Ultra)\b/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const REPO_ROOT = path.join(__dirname, '..', '..');

export async function describeMachine(): Promise<MachineRecord> {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model.trim() || 'unknown';
  const cores = cpus.length;
  const memoryBytes = os.totalmem();
  const isDarwin = process.platform === 'darwin';
  const { tier, tierReason } = classifyTier(cpuModel, cores, memoryBytes);
  return {
    cpuModel,
    cores,
    perfCores: isDarwin ? sysctlNumber('hw.perflevel0.logicalcpu') : null,
    effCores: isDarwin ? sysctlNumber('hw.perflevel1.logicalcpu') : null,
    memoryBytes,
    platform: process.platform,
    osRelease: os.release(),
    node: process.version,
    commit: gitHead(),
    loadAvg: os.loadavg(),
    maxVnodes: isDarwin ? sysctlNumber('kern.maxvnodes') : null,
    tier,
    tierReason,
  };
}

/**
 * A: at least 8 cores and 32 GiB, or a Pro/Max/Ultra model.
 * C: 4 cores or fewer, or 8 GiB or less.
 * B: everything in between.
 */
export function classifyTier(cpuModel: string, cores: number, memoryBytes: number): TierVerdict {
  const memory = `${formatGiB(memoryBytes)} GiB`;
  if (cores >= TIER_A_MIN_CORES && memoryBytes >= TIER_A_MIN_MEMORY_BYTES) {
    return { tier: 'A', tierReason: `${cores} cores and ${memory} meet the A clause (>= 8 cores and >= 32 GiB)` };
  }
  const model = TIER_A_MODEL.exec(cpuModel);
  if (model) {
    return { tier: 'A', tierReason: `CPU model "${cpuModel}" carries "${model[0]}", the A clause for Pro/Max/Ultra parts` };
  }
  if (cores <= TIER_C_MAX_CORES) {
    return { tier: 'C', tierReason: `${cores} cores fall in the C clause (<= 4 cores)` };
  }
  if (memoryBytes <= TIER_C_MAX_MEMORY_BYTES) {
    return { tier: 'C', tierReason: `${memory} falls in the C clause (<= 8 GiB)` };
  }
  return {
    tier: 'B',
    tierReason:
      `${cores} cores and ${memory}: neither the A clause (>= 8 cores and >= 32 GiB, or a Pro/Max/Ultra model)` +
      ' nor the C clause (<= 4 cores or <= 8 GiB) applies',
  };
}

function formatGiB(bytes: number): string {
  return (bytes / GIB).toFixed(1);
}

/** One key per call: a missing key would otherwise shift every line after it. */
function sysctlNumber(key: string): number | null {
  const result = spawnSync('sysctl', ['-n', key], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  const value = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

function gitHead(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.error || result.status !== 0) return 'unknown';
  const head = result.stdout.trim();
  return COMMIT_PATTERN.test(head) ? head : 'unknown';
}

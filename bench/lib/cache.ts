/**
 * The cache label on every benchmark number, and the refusal behind it.
 *
 * A run is `cold` only when the purge procedure itself reported success;
 * `warm` only after an un-measured warm-up pass over a tree the vnode cache
 * can hold (on macOS, at most 80% of `kern.maxvnodes`); a warmed tree larger
 * than that is `mixed`; everything else is `unknown` with the reason stated.
 * The harness never guesses a cache state it did not verify.
 */
import { spawnSync } from 'node:child_process';

export type CacheState = 'cold' | 'warm' | 'mixed' | 'unknown';
export type RequestedCache = 'cold' | 'warm';

export interface PurgeResult {
  ok: boolean;
  /** The procedure as a person would type it — recorded with the result. */
  command: string;
  error?: string;
}

export type PurgeProcedure = () => Promise<PurgeResult>;

export interface CacheStateOptions {
  requested: RequestedCache;
  /** Defaults to `defaultPurge`; injected by the tests so nothing is really flushed. */
  purge?: PurgeProcedure;
  /** Files plus directories in the corpus, from its manifest. */
  entries: number;
  /** `kern.maxvnodes` on macOS; `undefined` elsewhere, where the vnode rule is skipped. */
  maxVnodes?: number;
  /** Whether one un-measured pass over the corpus ran before the timed runs. */
  warmedUp: boolean;
}

export interface CacheVerdict {
  state: CacheState;
  reason: string;
  procedure?: string;
}

export interface PurgeStep {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
}

export interface PurgeProcedureSpec {
  /** Printed and recorded; `steps` is what actually runs, without a shell. */
  readonly command: string;
  readonly steps: ReadonlyArray<PurgeStep>;
  /** Set where no unattended procedure exists; then nothing runs. */
  readonly refusal?: string;
}

/** A warmed tree counts as cached only when it fits inside this share of the vnode cache. */
const VNODE_FILL_LIMIT = 0.8;
/** A purge that has not returned in this long is reported as failed, not waited on. */
const PURGE_TIMEOUT_MS = 30_000;
const WARM_UP_PROCEDURE = 'one un-measured pass over the corpus';

const count = (n: number): string => n.toLocaleString('en-US');

export const PURGE_PROCEDURES: Readonly<Record<'darwin' | 'linux' | 'win32', PurgeProcedureSpec>> = {
  darwin: { command: 'sudo -n purge', steps: [{ file: 'sudo', args: ['-n', 'purge'] }] },
  linux: {
    command: "sync && sudo -n sh -c 'echo 3 > /proc/sys/vm/drop_caches'",
    steps: [
      { file: 'sync', args: [] },
      { file: 'sudo', args: ['-n', 'sh', '-c', 'echo 3 > /proc/sys/vm/drop_caches'] },
    ],
  },
  win32: { command: 'RAMMap → Empty Standby List', steps: [], refusal: 'no unattended procedure on Windows' },
};

function procedureFor(platform: NodeJS.Platform): PurgeProcedureSpec | undefined {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32' ? PURGE_PROCEDURES[platform] : undefined;
}

function runStep(step: PurgeStep, command: string): PurgeResult {
  const r = spawnSync(step.file, step.args, { encoding: 'utf8', timeout: PURGE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return { ok: false, command, error: `${step.file}: ${r.error.message}` };
  if (r.status !== 0) {
    const detail = r.stderr.trim() || (r.signal ? `killed by ${r.signal}` : `exit status ${String(r.status)}`);
    return { ok: false, command, error: `${step.file}: ${detail}` };
  }
  return { ok: true, command };
}

/**
 * Drops the OS file cache without a shell and without prompting (`sudo -n`):
 * `purge` on macOS, `sync` then `drop_caches` on Linux. On Windows there is no
 * unattended procedure, so the result is a refusal the caller records as such.
 */
export async function defaultPurge(platform: NodeJS.Platform = process.platform): Promise<PurgeResult> {
  const spec = procedureFor(platform);
  if (spec === undefined) return { ok: false, command: '', error: `no purge procedure is known for ${platform}` };
  if (spec.refusal !== undefined) return { ok: false, command: spec.command, error: spec.refusal };
  for (const step of spec.steps) {
    const result = runStep(step, spec.command);
    if (!result.ok) return result;
  }
  return { ok: true, command: spec.command };
}

async function coldVerdict(opts: CacheStateOptions): Promise<CacheVerdict> {
  const purge = opts.purge ?? defaultPurge;
  const result = await purge();
  if (result.ok) {
    return { state: 'cold', reason: `the purge procedure succeeded: ${result.command}`, procedure: result.command };
  }
  return {
    state: 'unknown',
    reason: `not cold: the purge procedure failed (${result.command}): ${result.error ?? 'no error was given'}`,
    procedure: result.command,
  };
}

function warmVerdict(opts: CacheStateOptions): CacheVerdict {
  if (!opts.warmedUp) return { state: 'unknown', reason: 'no warm-up pass was run' };
  if (opts.maxVnodes === undefined) {
    return { state: 'warm', reason: 'a warm-up pass ran; the vnode-cache rule applies only where kern.maxvnodes is known (macOS)', procedure: WARM_UP_PROCEDURE };
  }
  const limit = opts.maxVnodes * VNODE_FILL_LIMIT;
  if (opts.entries > limit) {
    return {
      state: 'mixed',
      reason: `${count(opts.entries)} entries exceed 80% of kern.maxvnodes (${count(opts.maxVnodes)}), so the vnode cache cannot hold the whole tree after a warm-up pass`,
      procedure: WARM_UP_PROCEDURE,
    };
  }
  return {
    state: 'warm',
    reason: `a warm-up pass ran and ${count(opts.entries)} entries fit within 80% of kern.maxvnodes (${count(opts.maxVnodes)})`,
    procedure: WARM_UP_PROCEDURE,
  };
}

/** Labels a run's cache state, or refuses to: `cold` only after a successful purge, `warm` only after a warm-up pass that the vnode cache can hold. */
export async function cacheState(opts: CacheStateOptions): Promise<CacheVerdict> {
  return opts.requested === 'cold' ? coldVerdict(opts) : warmVerdict(opts);
}

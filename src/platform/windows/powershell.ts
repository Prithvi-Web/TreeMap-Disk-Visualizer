import { runText, CommandFailedError, CommandUnavailableError } from '../exec';

/**
 * PowerShell as Windows' structured-output layer.
 *
 * Mechanism choice (§2.3): tier 3, a system binary — but always with
 * `ConvertTo-Json`, so nothing here parses human-formatted text. That matters
 * because the obvious Windows implementations (`vssadmin list shadows`,
 * `openfiles /query`, `wmic`) all print tables meant for people, and §10 bans
 * regex over those when a structured mode exists. For essentially every Windows
 * query TreeMap needs, a `Get-Cim*`/`Get-*` cmdlet plus `ConvertTo-Json` is
 * that structured mode.
 *
 * Two details that are easy to get wrong and expensive to debug remotely:
 *
 * 1. **`ConvertTo-Json` unwraps a single-element array.** A machine with one
 *    disk returns an object where a two-disk machine returns an array — so
 *    every caller must go through `asArray()` below, or single-disk machines
 *    (the common case) silently produce zero results.
 *
 * 2. **`-Depth` defaults to 2**, quietly replacing anything deeper with the
 *    type name. Nested CIM objects need it raised explicitly or fields vanish
 *    with no error at all.
 *
 * Scripts are passed with `-Command` as a single argv element and never
 * interpolate user paths — paths travel through the environment instead
 * (see `runPowerShellJsonWithPath`), the same technique services/cleaner.ts
 * already uses for the Recycle Bin call.
 */

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/** PowerShell exists under two names; Core first, then Windows PowerShell. */
const CANDIDATES = ['pwsh.exe', 'powershell.exe'];

export interface PowerShellOptions {
  timeoutMs?: number;
  /**
   * Paths to expose to the script as environment variables rather than as
   * interpolated text. A path holding `'`, `$(...)` or a backtick cannot then
   * be interpreted as PowerShell syntax.
   */
  env?: Record<string, string>;
}

/**
 * `ConvertTo-Json` returns a bare object for one result and an array for many.
 * Normalising here is what keeps every caller correct on single-disk machines.
 */
export function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Run a PowerShell script whose output is JSON. */
export async function runPowerShellJson<T>(script: string, opts: PowerShellOptions = {}): Promise<T> {
  let lastError: unknown = new CommandUnavailableError('powershell.exe', 'PowerShell is not available');

  for (const exe of CANDIDATES) {
    try {
      const stdout = await runText(exe, [...PS_ARGS, script], {
        timeoutMs: opts.timeoutMs ?? 20_000,
        ...(opts.env ? { env: opts.env } : {}),
      });
      const trimmed = stdout.trim();
      // A cmdlet that matched nothing prints nothing; that is an empty result,
      // not a failure, and must not throw.
      if (trimmed.length === 0) return [] as unknown as T;
      return JSON.parse(trimmed) as T;
    } catch (err) {
      if (err instanceof CommandUnavailableError) {
        lastError = err;
        continue; // try the other executable name
      }
      // Non-zero exit with usable JSON still counts (warnings on stderr).
      if (err instanceof CommandFailedError) {
        const out = err.stdout.trim();
        if (out.startsWith('{') || out.startsWith('[')) {
          try {
            return JSON.parse(out) as T;
          } catch {
            /* fall through to rethrow */
          }
        }
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Wrap a script so it reads its target path from an environment variable.
 *
 * `$env:TREEMAP_TARGET` inside the script; the path never appears in the
 * command text, so no quoting scheme has to be trusted.
 */
export function withTargetPath<T>(script: string, targetPath: string, opts: PowerShellOptions = {}): Promise<T> {
  return runPowerShellJson<T>(script, { ...opts, env: { ...opts.env, TREEMAP_TARGET: targetPath } });
}

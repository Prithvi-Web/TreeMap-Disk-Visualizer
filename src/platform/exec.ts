import { execFile } from 'child_process';

/**
 * Shared subprocess helper for the platform layer.
 *
 * Every call uses execFile with an argv array — never `exec` with a string and
 * never `shell: true` — because most arguments originate in user-supplied
 * paths. This matches the rule already established in services/cleaner.ts.
 *
 * Prefer `runJson` over `runText`: §2.3 forbids regex-parsing human-formatted
 * CLI output when the tool has a structured mode. `runText` exists for the
 * handful of tools that genuinely have no `--json` (tmutil, vssadmin), and
 * every such use is called out in docs/PLATFORM_NOTES.md.
 */

export interface RunOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  /** Extra environment for this call only. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export class CommandUnavailableError extends Error {
  readonly command: string;
  constructor(command: string, detail: string) {
    super(detail);
    this.name = 'CommandUnavailableError';
    this.command = command;
  }
}

/**
 * A command that ran but exited non-zero — carrying whatever it still wrote.
 *
 * Keeping stdout on the error is not a nicety. Several of the tools this layer
 * depends on report partial trouble through a non-zero exit while emitting a
 * perfectly good answer: `lsof` exits 1 if any one of its path arguments has
 * vanished, yet still reports every path that exists, and `smartctl` exits
 * non-zero for advisory drive conditions while emitting complete JSON. An
 * earlier version of this helper threw away stdout, which silently turned the
 * entire open-file guard into "nothing has this open" the moment a delete batch
 * contained one already-deleted path — a confidently wrong answer of exactly
 * the kind §10 forbids. Callers now decide whether partial output is usable.
 */
export class CommandFailedError extends Error {
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  constructor(command: string, detail: string, stdout: string, stderr: string, exitCode: number | null) {
    super(detail);
    this.name = 'CommandFailedError';
    this.command = command;
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

/**
 * Run a command and resolve its stdout.
 *
 * Rejects with CommandUnavailableError when the binary simply isn't there
 * (ENOENT) — callers turn that into a capability `reason`, never a crash.
 */
export function runText(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        windowsHide: true,
        ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      },
      (err, stdout, stderr) => {
        const out = stdout ? stdout.toString() : '';
        const errText = stderr ? stderr.toString() : '';
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          const detail = (errText || err.message || 'command failed').trim();
          if (code === 'ENOENT') {
            reject(new CommandUnavailableError(cmd, `${cmd} is not installed`));
            return;
          }
          const exitCode = typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : null;
          reject(new CommandFailedError(cmd, detail, out, errText, exitCode));
          return;
        }
        resolve(out);
      },
    );
  });
}

/**
 * Run a command whose stdout is JSON and parse it.
 *
 * Some tools (notably `smartctl`) exit non-zero to signal advisory conditions
 * while still emitting a perfectly good JSON document, so a non-zero exit is
 * not by itself a failure here: if stdout parses, the parsed value wins.
 */
export async function runJson<T>(cmd: string, args: string[], opts: RunOptions = {}): Promise<T> {
  let stdout: string;
  try {
    stdout = await runText(cmd, args, opts);
  } catch (err) {
    if (err instanceof CommandUnavailableError) throw err;
    // smartctl and friends: non-zero exit, complete JSON on stdout anyway.
    if (err instanceof CommandFailedError && err.stdout.trim().startsWith('{')) {
      stdout = err.stdout;
    } else {
      throw err;
    }
  }
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error(`${cmd} produced no output`);
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error(`${cmd} did not produce valid JSON`);
  }
}

/** Is a binary runnable at all? Used purely for capability detection. */
export async function commandExists(cmd: string, probeArgs: string[] = ['--version']): Promise<boolean> {
  try {
    await runText(cmd, probeArgs, { timeoutMs: 5_000 });
    return true;
  } catch (err) {
    // Present but unhappy with our probe args still counts as present.
    return !(err instanceof CommandUnavailableError);
  }
}

/** Short, human-readable form of an unknown throw, for capability reasons. */
export function reasonOf(err: unknown): string {
  if (err instanceof CommandUnavailableError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

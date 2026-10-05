import { setTimeout as delay } from 'timers/promises';
import { platform } from '../platform';
import { runText, RunOptions } from '../platform/exec';
import type { ZombieHandleInfo } from '../platform/types';
import { AppError } from '../middleware/errorHandler';

/**
 * ZombieHandles (B5) — space held by files that were deleted while still open.
 *
 * An unlinked file's blocks stay allocated until the last descriptor on it
 * closes, which is how a disk can be full with nothing visible to account for
 * it: the classic case is a log rotated out from under a long-running server.
 * The platform layer does the detection (lsof inode comparison on macOS,
 * `/proc/<pid>/fd` on Linux, honestly unavailable on Windows — see
 * probeZombieHandles per platform); this service turns the raw descriptor
 * list into the per-process answer the panel shows, and carries out the one
 * remedy that actually frees the space: restarting the holder.
 *
 * ── Why restart, and why nothing gentler ──
 *
 * No signal short of process exit releases the space. The file has no name
 * anymore, so there is nothing to trash, offload or compress — B5 is the one
 * feature whose "reclaim" action is aimed at a process, not a file. That is
 * also why the restart endpoint is registered as *destructive* in the agent
 * manifest: quitting a program can lose its unsaved work, and §B5 requires
 * that warning to be explicit, never implied.
 */

/** One process holding at least one unlinked inode. */
export interface ZombieProcess {
  pid: number;
  processName: string;
  /**
   * The macOS .app bundle the process runs from, when it does — the case
   * where "restart" can genuinely mean quit-and-reopen. Null anywhere else,
   * and the UI must then warn that the program has to be started again by
   * hand.
   */
  appBundle: string | null;
  /**
   * Bytes known to be held by this process. A floor, not an estimate — unknowns
   * are counted, not guessed. A file another program also holds is in both
   * programs' figures, so these do not add up to the report's total.
   */
  bytes: number;
  /** Held inodes whose size the platform could not report. */
  unknownSizeCount: number;
  /** `holders`: how many programs hold this same deleted file, this one included. */
  handles: { path: string; bytes: number | null; holders: number }[];
}

export interface ZombieReport {
  processes: ZombieProcess[];
  /**
   * Every known held byte, each deleted file counted once however many
   * programs hold it (QA D17: summing per program counted one file once per
   * holder).
   */
  totalBytes: number;
  /** Held files with unknowable sizes, each counted once; the UI says "at least". */
  unknownSizeCount: number;
  /** How many distinct deleted files are held. */
  fileCount: number;
  /** How many of those more than one program holds. */
  sharedFileCount: number;
  scannedAt: number;
}

/** Runs a command and resolves its stdout: `runText`'s shape, and the seam the tests count `ps` calls through. */
export type CommandRunner = (cmd: string, args: string[], opts?: RunOptions) => Promise<string>;

/** The most pids one `ps` call is asked about, so its argument list stays far inside any system's limit. */
export const PS_PIDS_PER_CALL = 500;

/** One line of `ps -o pid=,comm=`: the pid (right-aligned), ONE space, then the executable — spaces and all. */
const PS_LINE = /^\s*(\d+)\s(.*)$/;

/**
 * Where each process's executable lives, or null for a pid that cannot be
 * read — one `ps` for up to PS_PIDS_PER_CALL pids at a time (Track U, U-5:
 * the held-space report used to start one `ps` per process, a 0.68–1.9 s
 * stall on every app open in the Track U diagnosis).
 *
 * `ps -o comm=` prints the full executable path on macOS (measured — unlike
 * Linux, where comm is the truncated 15-char name, which is why this is only
 * consulted for the .app test and the restart's identity check, and never
 * displayed as truth). `-ww` keeps a long path whole. A pid missing from the
 * output is null; so is every pid of a call that fails, which includes
 * macOS's exit 1 when no pid in the list is running — nothing is guessed.
 */
export async function executablePathsOf(pids: readonly number[], run: CommandRunner = runText): Promise<Map<number, string | null>> {
  const paths = new Map<number, string | null>(pids.map((pid) => [pid, null]));
  const asked = [...paths.keys()].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  for (let i = 0; i < asked.length; i += PS_PIDS_PER_CALL) {
    const chunk = asked.slice(i, i + PS_PIDS_PER_CALL);
    let out: string;
    try {
      out = await run('ps', ['-ww', '-o', 'pid=,comm=', '-p', chunk.join(',')], { timeoutMs: 5_000 });
    } catch {
      continue; // this chunk stays unknown; the rest are still asked
    }
    const wanted = new Set(chunk);
    for (const line of out.split(/\r?\n/)) {
      const m = PS_LINE.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const executable = m[2].trimEnd();
      if (wanted.has(pid) && executable.length > 0) paths.set(pid, executable);
    }
  }
  return paths;
}

/** One process's executable: the same `ps`, asked about that pid alone. */
async function executablePathOf(pid: number, run: CommandRunner = runText): Promise<string | null> {
  return (await executablePathsOf([pid], run)).get(pid) ?? null;
}

/**
 * The .app bundle containing `executable`, when there is one.
 *
 * "Contains" is a path-segment test, not a substring one: matching a bare
 * `.app` substring would mistake `/opt/my.apple/bin` for a bundle.
 */
export function appBundleOf(executable: string | null): string | null {
  if (!executable) return null;
  const marker = '.app/';
  const at = executable.indexOf(marker);
  if (at <= 0) return null;
  return executable.slice(0, at + marker.length - 1);
}

/**
 * Which deleted file a handle holds. Programs holding the same inode at the
 * same path hold the same file. Without an inode, the same path and size is
 * taken as the same file: that can only undercount, and the total is a floor.
 */
function heldFileKey(h: { path: string; bytes: number | null; ino?: number | null }): string {
  return h.ino !== undefined && h.ino !== null
    ? `${h.path}\0i${String(h.ino)}`
    : `${h.path}\0s${h.bytes === null ? '?' : String(h.bytes)}`;
}

/**
 * The pure per-process rollup: group by pid, sum known bytes, count
 * unknowns, biggest holder first — and total the held FILES, each once,
 * however many programs hold it. Exported so the arithmetic — the part a
 * wrong number would come from — is testable without a live process leaking
 * descriptors.
 */
export function groupZombies(
  handles: readonly { pid: number; processName: string; path: string; bytes: number | null; ino?: number | null }[],
): Omit<ZombieReport, 'scannedAt'> {
  const files = new Map<string, { bytes: number | null; holders: Set<number> }>();
  for (const h of handles) {
    const key = heldFileKey(h);
    const file = files.get(key) ?? { bytes: h.bytes, holders: new Set<number>() };
    file.holders.add(h.pid);
    files.set(key, file);
  }

  const byPid = new Map<number, ZombieProcess>();
  for (const h of handles) {
    let proc = byPid.get(h.pid);
    if (!proc) {
      proc = { pid: h.pid, processName: h.processName, appBundle: null, bytes: 0, unknownSizeCount: 0, handles: [] };
      byPid.set(h.pid, proc);
    }
    proc.handles.push({ path: h.path, bytes: h.bytes, holders: files.get(heldFileKey(h))?.holders.size ?? 1 });
    if (h.bytes === null) proc.unknownSizeCount++;
    else proc.bytes += h.bytes;
  }

  const processes = [...byPid.values()].sort((a, b) => b.bytes - a.bytes || a.pid - b.pid);
  for (const proc of processes) proc.handles.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));

  const held = [...files.values()];
  return {
    processes,
    totalBytes: held.reduce((s, f) => s + (f.bytes ?? 0), 0),
    unknownSizeCount: held.filter((f) => f.bytes === null).length,
    fileCount: held.length,
    sharedFileCount: held.filter((f) => f.holders.size > 1).length,
  };
}

/** What zombieReport reads the world through. Production passes nothing; the tests hand in each one. */
export interface ZombieReportDeps {
  /** The platform's raw descriptor list. */
  handles?: () => Promise<ZombieHandleInfo[]>;
  /** Runs `ps` for the .app test. */
  run?: CommandRunner;
  /** The OS the .app test is for: only macOS has .app bundles. */
  os?: NodeJS.Platform;
}

/** The per-process rollup of the platform's raw descriptor list. */
export async function zombieReport(deps: ZombieReportDeps = {}): Promise<ZombieReport> {
  const handles = deps.handles ?? (() => platform().getZombieHandles());
  const grouped = groupZombies(await handles());

  // The .app test: one `ps` for every process (U-5), and only where the
  // answer can be yes.
  if ((deps.os ?? process.platform) === 'darwin' && grouped.processes.length > 0) {
    const paths = await executablePathsOf(grouped.processes.map((proc) => proc.pid), deps.run);
    for (const proc of grouped.processes) proc.appBundle = appBundleOf(paths.get(proc.pid) ?? null);
  }

  return { ...grouped, scannedAt: Date.now() };
}

export interface RestartResult {
  pid: number;
  processName: string;
  terminated: boolean;
  relaunched: boolean;
  message: string;
}

/** Is `pid` still alive? Signal 0 probes without touching the process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else — very much
    // alive. Only ESRCH (and anything equally final) means gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** How long a process gets to exit gracefully before we report it stuck. */
const TERMINATE_WAIT_MS = 5_000;

/**
 * Ask `pid` to quit, and reopen it where that is genuinely supported.
 *
 * The contract, in order of what must never happen:
 *
 * 1. **Never the wrong process.** The caller names the process it believes it
 *    is restarting; if the pid now belongs to something else (pids are
 *    reused), the request is refused rather than honoured against whatever
 *    inherited the number.
 * 2. **Never TreeMap itself, its parent, or a system pid.**
 * 3. **Never an escalation.** SIGTERM only — the polite request every app is
 *    free to answer with a save dialog. A process that declines to exit is
 *    reported as still running; force-killing would be exactly the unsaved-
 *    work loss the confirmation warned about, done silently.
 *
 * Relaunch happens only for a macOS .app bundle, via `open`, after the exit
 * is confirmed — `open` on a still-running app would merely focus it.
 *
 * `waitMs` exists for tests, which prove the still-running path with a child
 * that traps SIGTERM and should not cost five real seconds doing it; `run`
 * lets them count the identity check's `ps` (one, about this pid alone).
 */
export async function restartProcess(
  pid: number,
  expectedName: string,
  waitMs = TERMINATE_WAIT_MS,
  run: CommandRunner = runText,
): Promise<RestartResult> {
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new AppError(400, 'PID_INVALID', 'That is not a process TreeMap can restart');
  }
  if (pid === process.pid || pid === process.ppid) {
    throw new AppError(400, 'PID_IS_TREEMAP', 'TreeMap cannot restart itself from here — quit and reopen the app instead');
  }
  if (!alive(pid)) {
    // Already gone — which also means its held space is already free.
    return { pid, processName: expectedName, terminated: true, relaunched: false, message: 'That program has already quit, so its held space is free.' };
  }

  // Identity check against pid reuse or a stale panel, asked fresh about this
  // one pid — never read from the report. `ps -o comm=` works on macOS and
  // Linux; when it cannot answer, refuse — acting on an unverified pid is how
  // the wrong program gets quit.
  const executable = await executablePathOf(pid, run);
  if (executable === null) {
    throw new AppError(409, 'PID_UNVERIFIED', 'Could not confirm which program that is right now — refresh the list and try again');
  }
  const actualName = executable.split('/').pop() ?? executable;
  // Older lsof builds truncate command names (historically at 9 characters),
  // and Linux's comm is capped at 15 — so a name that long is allowed to be a
  // prefix of the real one. Shorter names must match exactly: "node" being
  // reused by "nodemon" is a realistic collision, "Google Ch" much less so.
  const namesMatch =
    actualName === expectedName ||
    executable === expectedName ||
    (expectedName.length >= 9 && actualName.startsWith(expectedName));
  if (!namesMatch) {
    throw new AppError(
      409,
      'PID_REUSED',
      `That process id now belongs to “${actualName}”, not “${expectedName}” — refresh the list and try again`,
    );
  }

  const bundle = process.platform === 'darwin' ? appBundleOf(executable) : null;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    throw new AppError(409, 'TERMINATE_REFUSED', `macOS would not let TreeMap ask “${expectedName}” to quit — it may belong to another user`);
  }

  const deadline = Date.now() + waitMs;
  while (alive(pid) && Date.now() < deadline) await delay(150);

  if (alive(pid)) {
    // Deliberately not escalated — see the contract above.
    return {
      pid,
      processName: expectedName,
      terminated: false,
      relaunched: false,
      message: `“${expectedName}” was asked to quit but is still running — it may be waiting for you to save or confirm something. Nothing was forced.`,
    };
  }

  if (bundle) {
    try {
      await runText('open', [bundle], { timeoutMs: 10_000 });
      return {
        pid,
        processName: expectedName,
        terminated: true,
        relaunched: true,
        message: `“${expectedName}” quit and was reopened. The space it was holding is free.`,
      };
    } catch {
      return {
        pid,
        processName: expectedName,
        terminated: true,
        relaunched: false,
        message: `“${expectedName}” quit and its held space is free, but it could not be reopened automatically — start it again yourself.`,
      };
    }
  }

  return {
    pid,
    processName: expectedName,
    terminated: true,
    relaunched: false,
    message: `“${expectedName}” quit and the space it was holding is free. Start it again yourself when you need it.`,
  };
}

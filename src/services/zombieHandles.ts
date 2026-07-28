import { setTimeout as delay } from 'timers/promises';
import { platform } from '../platform';
import { runText } from '../platform/exec';
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
  /** Bytes known to be held. A floor, not an estimate — unknowns are counted, not guessed. */
  bytes: number;
  /** Held inodes whose size the platform could not report. */
  unknownSizeCount: number;
  handles: { path: string; bytes: number | null }[];
}

export interface ZombieReport {
  processes: ZombieProcess[];
  /** Sum of every known held byte across processes. */
  totalBytes: number;
  /** Total held inodes with unknowable sizes; the UI says "at least". */
  unknownSizeCount: number;
  scannedAt: number;
}

/**
 * Where the process's executable lives, or null when that cannot be read.
 *
 * `ps -o comm=` prints the full executable path on macOS (measured — unlike
 * Linux, where comm is the truncated 15-char name, which is why this is only
 * consulted for the .app test and never displayed as truth).
 */
async function executablePathOf(pid: number): Promise<string | null> {
  try {
    const out = (await runText('ps', ['-o', 'comm=', '-p', String(pid)], { timeoutMs: 5_000 })).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
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
 * The pure per-process rollup: group by pid, sum known bytes, count
 * unknowns, biggest holder first. Exported so the arithmetic — the part a
 * wrong number would come from — is testable without a live process leaking
 * descriptors.
 */
export function groupZombies(handles: readonly { pid: number; processName: string; path: string; bytes: number | null }[]): {
  processes: ZombieProcess[];
  totalBytes: number;
  unknownSizeCount: number;
} {
  const byPid = new Map<number, ZombieProcess>();
  for (const h of handles) {
    let proc = byPid.get(h.pid);
    if (!proc) {
      proc = { pid: h.pid, processName: h.processName, appBundle: null, bytes: 0, unknownSizeCount: 0, handles: [] };
      byPid.set(h.pid, proc);
    }
    proc.handles.push({ path: h.path, bytes: h.bytes });
    if (h.bytes === null) proc.unknownSizeCount++;
    else proc.bytes += h.bytes;
  }

  const processes = [...byPid.values()].sort((a, b) => b.bytes - a.bytes || a.pid - b.pid);
  for (const proc of processes) proc.handles.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));

  return {
    processes,
    totalBytes: processes.reduce((s, p) => s + p.bytes, 0),
    unknownSizeCount: processes.reduce((s, p) => s + p.unknownSizeCount, 0),
  };
}

/** The per-process rollup of the platform's raw descriptor list. */
export async function zombieReport(): Promise<ZombieReport> {
  const grouped = groupZombies(await platform().getZombieHandles());

  // The .app test is one `ps` per process, so only run it where the answer
  // can be yes.
  if (process.platform === 'darwin') {
    await Promise.all(
      grouped.processes.map(async (proc) => {
        proc.appBundle = appBundleOf(await executablePathOf(proc.pid));
      }),
    );
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
 * that traps SIGTERM and should not cost five real seconds doing it.
 */
export async function restartProcess(pid: number, expectedName: string, waitMs = TERMINATE_WAIT_MS): Promise<RestartResult> {
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

  // Identity check against pid reuse or a stale panel. `ps -o comm=` works on
  // macOS and Linux; when it cannot answer, refuse — acting on an unverified
  // pid is how the wrong program gets quit.
  const executable = await executablePathOf(pid);
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

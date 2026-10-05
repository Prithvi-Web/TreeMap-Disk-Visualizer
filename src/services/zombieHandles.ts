import { promises as fsp } from 'fs';
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
   * Whether TreeMap will ask this process to quit (QA D40). False for a
   * program that is part of the operating system, one run by root or another
   * user, and one TreeMap could not identify — the panel then offers no
   * Restart and shows `restartRefusal` instead.
   */
  restartable: boolean;
  /** Why not, in a few words, when `restartable` is false; null otherwise (and before zombieReport checks). */
  restartRefusal: string | null;
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

/**
 * One line of `ps -o pid=,uid=,comm=`: the pid and the uid (both
 * right-aligned), ONE space, then the executable — spaces and all.
 */
const PS_LINE = /^\s*(\d+)\s+(\d+)\s(.*)$/;

/** What `ps` says about one process. Both fields are null when it could not be read. */
export interface ProcessFacts {
  /** The full executable path on macOS; Linux's `comm` is the short name (see below). */
  executable: string | null;
  /** The user the process runs as. */
  uid: number | null;
}

/**
 * Each process's executable and owner, or nulls for a pid that cannot be read
 * — one `ps` for up to PS_PIDS_PER_CALL pids at a time (Track U, U-5: the
 * held-space report used to start one `ps` per process, a 0.68–1.9 s stall on
 * every app open in the Track U diagnosis).
 *
 * `ps -o comm=` prints the full executable path on macOS (measured — unlike
 * Linux, where comm is the truncated 15-char name, which is why this is only
 * consulted for the .app test, the restart's identity check and the system
 * check on macOS, and never displayed as truth). `-ww` keeps a long path
 * whole. A pid missing from the output is null; so is every pid of a call that
 * fails, which includes macOS's exit 1 when no pid in the list is running —
 * nothing is guessed.
 */
export async function processFactsOf(pids: readonly number[], run: CommandRunner = runText): Promise<Map<number, ProcessFacts>> {
  const facts = new Map<number, ProcessFacts>(pids.map((pid) => [pid, { executable: null, uid: null }]));
  const asked = [...facts.keys()].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  for (let i = 0; i < asked.length; i += PS_PIDS_PER_CALL) {
    const chunk = asked.slice(i, i + PS_PIDS_PER_CALL);
    let out: string;
    try {
      out = await run('ps', ['-ww', '-o', 'pid=,uid=,comm=', '-p', chunk.join(',')], { timeoutMs: 5_000 });
    } catch {
      continue; // this chunk stays unknown; the rest are still asked
    }
    const wanted = new Set(chunk);
    for (const line of out.split(/\r?\n/)) {
      const m = PS_LINE.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const executable = m[3].trimEnd();
      if (wanted.has(pid) && executable.length > 0) facts.set(pid, { executable, uid: Number(m[2]) });
    }
  }
  return facts;
}

/** Each process's executable alone: the same one `ps` per 500 pids. */
export async function executablePathsOf(pids: readonly number[], run: CommandRunner = runText): Promise<Map<number, string | null>> {
  const facts = await processFactsOf(pids, run);
  return new Map([...facts].map(([pid, f]) => [pid, f.executable]));
}

/**
 * Linux's own answer about a process, from /proc and without `ps`: the
 * executable `/proc/<pid>/exe` points at (a full path, where `ps` gives only
 * the 15-character name) and the owner of `/proc/<pid>`. Null for either
 * that cannot be read.
 */
async function procFactsOf(pid: number): Promise<ProcessFacts> {
  const [executable, uid] = await Promise.all([
    fsp.readlink(`/proc/${String(pid)}/exe`).catch(() => null),
    fsp.stat(`/proc/${String(pid)}`).then((st) => st.uid, () => null),
  ]);
  return { executable, uid };
}

/**
 * What the restart refuses, in one sentence. The Missing GB page quotes it as
 * the remedy's caveat, so the claim and the code cannot drift apart again
 * (QA D40: the page said "it refuses system processes" while the code refused
 * only pid 1).
 */
export const RESTART_REFUSES =
  'programs that are part of the operating system, programs run by the system administrator or by another user, TreeMap itself and its own parent';

/** Folders whose programs are part of the operating system. `/usr/local` is a person's, so it is excluded below. */
const SYSTEM_DIRS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ['/System/', '/usr/', '/bin/', '/sbin/', '/Library/Apple/'],
  linux: ['/usr/', '/bin/', '/sbin/', '/lib/', '/lib64/'],
};

/**
 * The main executable of an app in an Applications folder — Mail, Terminal,
 * Safari (which runs from a cryptex under /System) — is a program a person
 * opens and quits, even though Apple ships it under /System.
 */
const APPLICATIONS_APP_MAIN = /\/Applications\/(?:[^/]+\/)?[^/]+\.app\/Contents\/MacOS\/[^/]+$/;

/** True when `executable` is part of the operating system on `os`. */
function isSystemExecutable(executable: string, os: NodeJS.Platform): boolean {
  if (executable.startsWith('/usr/local/')) return false;
  if (!(SYSTEM_DIRS[os] ?? []).some((dir) => executable.startsWith(dir))) return false;
  return !(os === 'darwin' && APPLICATIONS_APP_MAIN.test(executable));
}

/** Why a process may not be restarted: a stable code, and a short reason a person reads. */
export interface RestartRefusal {
  code: 'PID_SYSTEM' | 'PID_OTHER_USER' | 'PID_UNVERIFIED' | 'RESTART_UNSUPPORTED';
  reason: string;
}

/**
 * Whether TreeMap may ask this process to quit (QA D40). It refuses a program
 * that is part of the operating system (chronod, fileproviderd, Finder…), one
 * run by root or by another user, and one whose owner or executable it could
 * not read — refusing is the safe answer to "cannot tell". `ourUid` is the
 * user TreeMap runs as.
 */
export function restartRefusal(facts: ProcessFacts, os: NodeJS.Platform, ourUid: number | null): RestartRefusal | null {
  if (!SYSTEM_DIRS[os]) return { code: 'RESTART_UNSUPPORTED', reason: 'TreeMap restarts programs only on macOS and Linux' };
  if (facts.uid === null) return { code: 'PID_UNVERIFIED', reason: 'TreeMap could not confirm who runs it' };
  if (facts.uid === 0) return { code: 'PID_SYSTEM', reason: 'Runs as the system administrator' };
  if (ourUid !== null && facts.uid !== ourUid) return { code: 'PID_OTHER_USER', reason: 'Belongs to another user' };
  if (facts.executable === null) return { code: 'PID_UNVERIFIED', reason: 'TreeMap could not confirm which program this is' };
  if (isSystemExecutable(facts.executable, os)) {
    return { code: 'PID_SYSTEM', reason: os === 'darwin' ? 'Part of macOS' : 'Part of the operating system' };
  }
  return null;
}

/** The user TreeMap runs as, where the platform has one. */
function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
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
      proc = {
        pid: h.pid, processName: h.processName, appBundle: null, restartable: false, restartRefusal: null,
        bytes: 0, unknownSizeCount: 0, handles: [],
      };
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
  /** Runs `ps` for the .app test and the restart check on macOS. */
  run?: CommandRunner;
  /** The OS the report is for: only macOS has .app bundles, and only macOS and Linux restart anything. */
  os?: NodeJS.Platform;
  /** The user TreeMap runs as; the restart check refuses anyone else's programs. */
  uid?: number | null;
  /** Linux: a process's executable and owner, read from /proc. */
  procFacts?: (pid: number) => Promise<ProcessFacts>;
}

/** The per-process rollup of the platform's raw descriptor list. */
export async function zombieReport(deps: ZombieReportDeps = {}): Promise<ZombieReport> {
  const handles = deps.handles ?? (() => platform().getZombieHandles());
  const grouped = groupZombies(await handles());
  const os = deps.os ?? process.platform;
  const ourUid = deps.uid !== undefined ? deps.uid : currentUid();

  // What each holder is, for the .app test and the restart check (QA D40):
  // one `ps` for every process on macOS (U-5), /proc on Linux, nothing
  // elsewhere — where nothing is asked, nothing is offered.
  let facts = new Map<number, ProcessFacts>();
  if (grouped.processes.length > 0) {
    const pids = grouped.processes.map((proc) => proc.pid);
    if (os === 'darwin') facts = await processFactsOf(pids, deps.run);
    else if (os === 'linux') {
      const read = deps.procFacts ?? procFactsOf;
      facts = new Map(await Promise.all(pids.map(async (pid) => [pid, await read(pid)] as const)));
    }
  }
  for (const proc of grouped.processes) {
    const known = facts.get(proc.pid) ?? { executable: null, uid: null };
    if (os === 'darwin') proc.appBundle = appBundleOf(known.executable);
    const refusal = restartRefusal(known, os, ourUid);
    proc.restartable = refusal === null;
    proc.restartRefusal = refusal?.reason ?? null;
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

/** Where restartProcess acts. Production passes nothing (this machine); the tests hand in their own. */
export interface RestartEnv {
  /** The OS whose rules apply. */
  os?: NodeJS.Platform;
  /** The user TreeMap runs as. */
  uid?: number | null;
  /** Linux: a process's executable and owner, read from /proc. */
  procFacts?: (pid: number) => Promise<ProcessFacts>;
}

/**
 * Ask `pid` to quit, and reopen it where that is genuinely supported.
 *
 * The contract, in order of what must never happen:
 *
 * 1. **Never the wrong process.** The caller names the process it believes it
 *    is restarting; if the pid now belongs to something else (pids are
 *    reused), the request is refused rather than honoured against whatever
 *    inherited the number.
 * 2. **Never TreeMap itself, its parent, or a program that is part of the
 *    system** — pid 1, a program run from the operating system's own folders
 *    (macOS's /System, /usr, /bin, /sbin; Linux's /usr, /bin, /sbin, /lib),
 *    one run by root or by another user, or one whose owner or executable
 *    could not be read (QA D40: chronod, fileproviderd and WallpaperAgent run
 *    as the user, so pid ≤ 1 was never the rule the page claimed). Refused
 *    before anything is sent to the process, even the liveness probe.
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
  env: RestartEnv = {},
): Promise<RestartResult> {
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new AppError(400, 'PID_INVALID', 'That is not a process TreeMap can restart');
  }
  if (pid === process.pid || pid === process.ppid) {
    throw new AppError(400, 'PID_IS_TREEMAP', 'TreeMap cannot restart itself from here — quit and reopen the app instead');
  }
  const os = env.os ?? process.platform;
  const alreadyQuit: RestartResult = {
    pid, processName: expectedName, terminated: true, relaunched: false,
    message: 'That program has already quit, so its held space is free.',
  };

  // Identity check against pid reuse or a stale panel, asked fresh about this
  // one pid — never read from the report. `ps -o pid=,uid=,comm=` works on
  // macOS and Linux; when it cannot answer, the process is either gone
  // (its held space is already free) or unverifiable — and acting on an
  // unverified pid is how the wrong program gets quit.
  const facts = (await processFactsOf([pid], run)).get(pid) ?? { executable: null, uid: null };
  const executable = facts.executable;
  if (executable === null) {
    if (!alive(pid)) return alreadyQuit;
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

  // Never a program that is part of the system, nor root's or another user's
  // (QA D40). Linux's ps names a process only by its 15-character comm, so
  // there the executable comes from /proc.
  const judged = os === 'linux' ? { executable: (await (env.procFacts ?? procFactsOf)(pid)).executable, uid: facts.uid } : facts;
  const refusal = restartRefusal(judged, os, env.uid !== undefined ? env.uid : currentUid());
  if (refusal) {
    throw new AppError(
      refusal.code === 'PID_UNVERIFIED' ? 409 : 400,
      refusal.code,
      `TreeMap will not ask “${expectedName}” to quit (${refusal.reason.startsWith('TreeMap') ? refusal.reason : refusal.reason.charAt(0).toLowerCase() + refusal.reason.slice(1)}). ` +
        'Its held space is returned when it quits by itself or the computer restarts.',
    );
  }

  if (!alive(pid)) return alreadyQuit;

  const bundle = os === 'darwin' ? appBundleOf(executable) : null;

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

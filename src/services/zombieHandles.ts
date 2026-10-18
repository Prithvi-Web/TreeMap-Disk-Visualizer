import { promises as fsp } from 'fs';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { platform } from '../platform';
import { runText, RunOptions, CommandFailedError } from '../platform/exec';
import type { ZombieHandleInfo } from '../platform/types';
import { AppError } from '../middleware/errorHandler';
import { displayProcessName } from '../platform/macos/lsofGuard';

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
   * The macOS .app bundle this process IS — its Info.plist names this
   * executable — and one `open` really reopens: no background app, started by
   * launchd with no arguments, as an app a person opens is (sixth browser
   * pass H03). The one case where "restart" can genuinely mean
   * quit-and-reopen. Null anywhere else, and the UI must then warn that the
   * program has to be started again by hand.
   */
  appBundle: string | null;
  /**
   * The macOS app this process runs INSIDE without being it (fourth browser
   * pass, E02): a helper such as Chrome's renderer, an extension, an XPC
   * service, a login item, a tool kept in the app's bundle. TreeMap does not
   * reopen it — opening the app, still running, reopens nothing — so the UI
   * names the app and says so. Null when the process is the app itself or
   * belongs to no app.
   */
  partOf: string | null;
  /**
   * Why TreeMap does not reopen this process though it is an app's own
   * program (sixth browser pass H03): a background app (LSBackgroundOnly or
   * LSUIElement in its Info.plist), one another program started, one launchd
   * started with arguments `open` cannot repeat, or one whose start could not
   * be read — a sentence ending "TreeMap does not reopen it." Null otherwise.
   */
  notReopened: string | null;
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

/** What a macOS executable is to an app: the app it IS, or the app it runs INSIDE. */
export interface BundleRole {
  /** The .app this executable is the program of — `<X>.app/Contents/MacOS/<name>`, X inside no other bundle. */
  appBundle: string | null;
  /** The outermost .app this executable runs inside without being its program. */
  partOf: string | null;
}

/**
 * What `executable` is, by its path alone (fourth browser pass, E02): the app
 * it IS — its program sits in `<X>.app/Contents/MacOS/`, X inside no other
 * bundle — or the app it runs INSIDE: a helper app (Chrome's renderer), an
 * extension (.appex), an XPC service, a login item, a tool kept anywhere else
 * in the app's bundle. Only the first is reopened by `open`: on the outer app,
 * still running, `open` reopens nothing, and on a helper's own bundle it would
 * start the helper alone. Taking the first ".app/" in the path called Chrome's
 * renderer "Google Chrome.app", and the restart then said it "quit and was
 * reopened". Path segments, never substrings: `/opt/my.apple/bin` is no bundle.
 */
export function bundleRoleOf(executable: string | null): BundleRole {
  if (!executable) return { appBundle: null, partOf: null };
  const parts = executable.split('/');
  const outer = parts.findIndex((name) => name.length > '.app'.length && name.endsWith('.app'));
  if (outer === -1) return { appBundle: null, partOf: null };
  const bundle = parts.slice(0, outer + 1).join('/');
  const isItsProgram = parts.length === outer + 4 && parts[outer + 1] === 'Contents' && parts[outer + 2] === 'MacOS';
  return isItsProgram ? { appBundle: bundle, partOf: null } : { appBundle: null, partOf: bundle };
}

/** The .app bundle `executable` is the program of, by its path; null for a helper inside an app (E02) and anything else. */
export function appBundleOf(executable: string | null): string | null {
  return bundleRoleOf(executable).appBundle;
}

/**
 * The executable an app's Info.plist names (CFBundleExecutable), or null when
 * it cannot be read. plutil reads XML and binary property lists alike.
 */
export async function readBundleExecutable(bundle: string, run: CommandRunner = runText): Promise<string | null> {
  try {
    const out = await run('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')], { timeoutMs: 5_000 });
    const name = out.replace(/\r?\n$/, '');
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * What `executable` is to an app, confirmed (E02): a program in an app's
 * Contents/MacOS is that app only when the app's Info.plist names it — a
 * second program kept there (a crash reporter, an updater) runs inside the
 * app, and opening the app would not bring it back. An app whose Info.plist
 * cannot be read is promised nothing either way.
 */
async function confirmedRoleOf(executable: string | null, mainOf: (bundle: string) => Promise<string | null>): Promise<BundleRole> {
  const role = bundleRoleOf(executable);
  if (role.appBundle === null || executable === null) return role;
  const main = await mainOf(role.appBundle);
  if (main === null) return { appBundle: null, partOf: null };
  return main === path.basename(executable) ? role : { appBundle: null, partOf: role.appBundle };
}

/**
 * Whether an app's Info.plist marks it a background app (sixth browser pass H03): LSBackgroundOnly or
 * LSUIElement, as a boolean or the old string forms ("1", "YES"). Asked only of an app whose Info.plist
 * was just read for its executable (readBundleExecutable), so plutil's exit 1 here is a key that is not
 * there: neither set is false. Any other failure — a timeout, no plutil — is null, which promises
 * nothing.
 */
export async function readBundleBackground(bundle: string, run: CommandRunner = runText): Promise<boolean | null> {
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  for (const key of ['LSBackgroundOnly', 'LSUIElement']) {
    try {
      const out = await run('plutil', ['-extract', key, 'raw', '-o', '-', plist], { timeoutMs: 5_000 });
      if (/^(?:true|yes|1)$/i.test(out.trim())) return true;
    } catch (err) {
      if (!(err instanceof CommandFailedError && err.exitCode === 1)) return null;
    }
  }
  return false;
}

/** How a process was started (sixth browser pass H03): its parent's pid and its whole command line. */
export interface LaunchFacts {
  ppid: number;
  args: string;
}

/** One line of `ps -o pid=,ppid=,args=`: both pids right-aligned, ONE space, then the command line. */
const PS_LAUNCH_LINE = /^\s*(\d+)\s+(\d+)\s(.*)$/;

/**
 * How each process was started, one `ps` for up to PS_PIDS_PER_CALL pids (H03). A pid missing from the
 * output, or every pid of a call that fails, is absent: unknown, never a guess.
 */
export async function launchFactsOf(pids: readonly number[], run: CommandRunner = runText): Promise<Map<number, LaunchFacts>> {
  const facts = new Map<number, LaunchFacts>();
  const asked = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  for (let i = 0; i < asked.length; i += PS_PIDS_PER_CALL) {
    const chunk = asked.slice(i, i + PS_PIDS_PER_CALL);
    let out: string;
    try {
      out = await run('ps', ['-ww', '-o', 'pid=,ppid=,args=', '-p', chunk.join(',')], { timeoutMs: 5_000 });
    } catch {
      continue;
    }
    const wanted = new Set(chunk);
    for (const line of out.split(/\r?\n/)) {
      const m = PS_LAUNCH_LINE.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      if (wanted.has(pid)) facts.set(pid, { ppid: Number(m[2]), args: m[3].trimEnd() });
    }
  }
  return facts;
}

/**
 * Why `open` would not bring an app's own program back as it was (sixth browser pass H03), or null when
 * it would: `open <bundle>` starts the app with no arguments, as a person opening it does. A background
 * app (its Info.plist says so) is started by something else when it is needed; one another program
 * started, or launchd started with arguments of its own, would come back without them, if at all. What
 * could not be read promises nothing either.
 */
export function reopenRefusalOf(executable: string, background: boolean | null, launch: LaunchFacts | null): string | null {
  if (background === true) return 'It is a background app (its Info.plist says so), so TreeMap does not reopen it.';
  if (background === null) return 'Whether it is a background app could not be read, so TreeMap does not reopen it.';
  if (launch === null) return 'How it was started could not be read, so TreeMap does not reopen it.';
  if (launch.ppid !== 1) return 'Another program started it, so TreeMap does not reopen it.';
  if (launch.args !== executable) return 'It was started with options of its own, which TreeMap cannot repeat, so TreeMap does not reopen it.';
  return null;
}

/** An app's name as a person reads it: "Google Chrome" for /Applications/Google Chrome.app. */
function appNameOf(bundle: string): string {
  return path.basename(bundle).replace(/\.app$/, '');
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
        pid: h.pid, processName: h.processName, appBundle: null, partOf: null, notReopened: null, restartable: false, restartRefusal: null,
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
  /** macOS: the executable an app's Info.plist names (E02). */
  bundleExecutable?: (bundle: string) => Promise<string | null>;
  /** macOS: whether an app's Info.plist marks it a background app (H03). */
  bundleBackground?: (bundle: string) => Promise<boolean | null>;
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
  // Each app's Info.plist is read once, and every app's at the same time: a report
  // that waited on one plutil after another would bring back the stall U-5 removed.
  const read = deps.bundleExecutable ?? ((bundle: string) => readBundleExecutable(bundle, deps.run));
  const mains = new Map<string, Promise<string | null>>();
  const mainOf = (bundle: string): Promise<string | null> => {
    let main = mains.get(bundle);
    if (main === undefined) { main = read(bundle); mains.set(bundle, main); }
    return main;
  };
  const roles = os === 'darwin'
    ? await Promise.all(grouped.processes.map((proc) => confirmedRoleOf(facts.get(proc.pid)?.executable ?? null, mainOf)))
    : [];
  // An app's own program is the one a restart reopens only where `open` really brings it back (H03):
  // how each was started, one more `ps` for all of them, and each app's Info.plist read once.
  const appPids = grouped.processes.filter((_, i) => roles[i]?.appBundle).map((proc) => proc.pid);
  const launches = appPids.length > 0 ? await launchFactsOf(appPids, deps.run) : new Map<number, LaunchFacts>();
  const readBackground = deps.bundleBackground ?? ((bundle: string) => readBundleBackground(bundle, deps.run));
  const backgrounds = new Map<string, Promise<boolean | null>>();
  const backgroundOf = (bundle: string): Promise<boolean | null> => {
    let known = backgrounds.get(bundle);
    if (known === undefined) { known = readBackground(bundle); backgrounds.set(bundle, known); }
    return known;
  };
  const reopenRefusals = await Promise.all(grouped.processes.map(async (proc, i) => {
    const bundle = roles[i]?.appBundle;
    const executable = facts.get(proc.pid)?.executable;
    if (!bundle || !executable) return null;
    return reopenRefusalOf(executable, await backgroundOf(bundle), launches.get(proc.pid) ?? null);
  }));
  for (const [i, proc] of grouped.processes.entries()) {
    const known = facts.get(proc.pid) ?? { executable: null, uid: null };
    if (os === 'darwin') {
      // Whole, from the executable the one ps above read: lsof cuts a long name at 31 characters (H04).
      proc.processName = displayProcessName(proc.processName, known.executable);
      Object.assign(proc, roles[i]);
      const notReopened = reopenRefusals[i];
      if (notReopened !== null) Object.assign(proc, { appBundle: null, partOf: null, notReopened });
    }
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
  /** macOS: the executable an app's Info.plist names (E02). */
  bundleExecutable?: (bundle: string) => Promise<string | null>;
  /** macOS: whether an app's Info.plist marks it a background app (H03). */
  bundleBackground?: (bundle: string) => Promise<boolean | null>;
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
 * Relaunch happens only for the macOS app the process IS (its Info.plist
 * names the executable), via `open` through `run`, after the exit is
 * confirmed — `open` on a still-running app would merely focus it. A helper
 * or extension inside an app is never "reopened": the result names the app
 * it runs inside and says TreeMap did not reopen it (E02). Nor is an app's
 * own program that `open` would not bring back as it was — a background
 * app, one another program or launchd started with arguments (H03): it is
 * quit, and the result says why TreeMap does not reopen it.
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

  const role = os === 'darwin'
    ? await confirmedRoleOf(executable, env.bundleExecutable ?? ((b) => readBundleExecutable(b, run)))
    : { appBundle: null, partOf: null };
  // Read before it is asked to quit: once it is gone, nothing says how it was started (H03).
  const notReopened = role.appBundle === null ? null : reopenRefusalOf(
    executable,
    await (env.bundleBackground ?? ((b) => readBundleBackground(b, run)))(role.appBundle),
    (await launchFactsOf([pid], run)).get(pid) ?? null,
  );
  const bundle = notReopened === null ? role.appBundle : null;

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
      await run('open', [bundle], { timeoutMs: 10_000 });
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

  if (notReopened !== null) {
    return {
      pid,
      processName: expectedName,
      terminated: true,
      relaunched: false,
      message: `“${expectedName}” quit and the space it was holding is free. ${notReopened} Start it again yourself if it does not start again by itself.`,
    };
  }

  if (role.partOf) {
    const host = appNameOf(role.partOf);
    return {
      pid,
      processName: expectedName,
      terminated: true,
      relaunched: false,
      message: `“${expectedName}” quit and the space it was holding is free. It runs inside ${host}, and TreeMap did not reopen it — ` +
        `if ${host} does not start it again by itself, quit and reopen ${host}.`,
    };
  }

  return {
    pid,
    processName: expectedName,
    terminated: true,
    relaunched: false,
    message: `“${expectedName}” quit and the space it was holding is free. Start it again yourself when you need it.`,
  };
}

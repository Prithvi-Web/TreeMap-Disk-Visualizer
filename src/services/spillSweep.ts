import fs from 'node:fs';
import path from 'node:path';

/**
 * TreeMap's spill folder, `<appData>/scan-spill`, from Node's side (Phase 4 T13c; plan
 * §S.5.3): the boot sweep, and the one function in the app that removes a spill file.
 *
 * A large scan spills its columns into files tm-store makes in that folder and at once
 * leaves with no name (`native/treemap-core/crates/tm-store/src/spill.rs`), so the kernel
 * frees their bytes when the scan closes, after a crash or a SIGKILL too. Only a crash
 * inside macOS's moment between making a file and unlinking it, or a power loss on Windows
 * (where a file keeps its name while it is open), leaves one behind, named
 * `<pid>-<startMs>-<scanId>-<column>`. `sweepSpillDir` removes such a file once the
 * process its `<pid>` names is dead, and keeps everything else. There is no age check: a
 * leftover whose pid a live process has reused is kept until that process ends (a
 * departure from the master prompt's §9.3, DESIGN §6.2).
 *
 * That removal is the owner's exception to the master prompt's §3.1 ("never an unlink"),
 * decided on 28 Sep 2026 (plan §S.11 Q1): TreeMap removes files it created itself, only
 * inside `scan-spill`. So `removeSpillFile` is the one place that removes a spill file, and
 * it refuses, saying why:
 * - an app-data folder given as a relative path;
 * - a `scan-spill` that is a link, not a folder, or leads anywhere but
 *   `<real app-data>/scan-spill`, and on POSIX one another user owns or can write to;
 * - a path whose real location is not directly inside `scan-spill`;
 * - a name tm-store does not give: its numbers never start with a 0 (a lone 0 start
 *   aside), its parts keep tm-store's alphabets and bounds;
 * - a link, which it never follows, and anything else that is not a regular file;
 * - a file tm-store could not have left: one with other names (a link count above one) and,
 *   on POSIX, one another user owns or with permissions beyond the 0600 tm-store gives;
 * - a file replaced since it was checked. On POSIX the checked file is held open while it
 *   is compared, so its inode cannot be freed and given to another file (ext4 hands a freed
 *   number out again at once); on Windows a file's id carries its record's sequence number,
 *   which changes when the record is reused. The last check and the removal run together,
 *   with nothing between them that yields to other work.
 *
 * Wiring is T17's: the sweep at boot in `src/server.ts`, `pathGuard` over `scan-spill`, the
 * Empty Folders view skipping it, and the missing-gigabytes line.
 */

/** The folder under app-data that holds spill files (tm-store's `SPILL_DIR`). */
export const SPILL_DIR = 'scan-spill';
/** The most bytes a scan id takes in a name (tm-store's `SCAN_ID_MAX`). */
export const SCAN_ID_MAX = 64;
/** The most bytes a column takes in a name (tm-store's `COLUMN_MAX`). */
export const COLUMN_MAX = 32;
/** The permissions tm-store gives a spill file; the umask can only take bits away. */
const SPILL_FILE_MODE = 0o600n;

/** A spill file's name, as tm-store's `SpillName` writes it. */
export interface SpillName {
  /** The process that made it. */
  pid: number;
  /** When that process first named a spill file, in ms since 1970, as its digits. */
  startMs: string;
  scanId: string;
  column: string;
}

/**
 * `<pid>-<startMs>-<scanId>-<column>` as tm-store formats it: the numbers in decimal with no
 * leading zero, the scan id ASCII letters, digits, `-` and `_`, the column letters, digits
 * and `_`, so the last `-` ends the id. The bounds are tm-store's (a test holds them to its
 * source).
 */
const SPILL_NAME = new RegExp(
  `^([1-9]\\d{0,9})-(0|[1-9]\\d{0,19})-([A-Za-z0-9_-]{1,${SCAN_ID_MAX}})-([A-Za-z0-9_]{1,${COLUMN_MAX}})$`,
);
/** The largest pid a process can have; `process.kill` takes nothing past a 32-bit int. */
const MAX_PID = 2 ** 31 - 1;

/**
 * `name` read as a spill file's name, or null when tm-store would not have made it. Its pid
 * is at least 1, because no digit but 1-9 may lead it (`process.kill(0)` would ask the whole
 * process group), and fits in 31 bits.
 */
export function parseSpillName(name: string): SpillName | null {
  const match = SPILL_NAME.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  if (pid > MAX_PID) return null;
  return { pid, startMs: match[2], scanId: match[3], column: match[4] };
}

/**
 * Whether a process with this pid exists: `process.kill(pid, 0)` sends nothing and only
 * asks. Only a definite "no such process" (`ESRCH`) reads as dead; another user's process
 * (`EPERM`) and anything else unexpected read as alive, so doubt keeps a file.
 */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** What `removeSpillFile` did. */
export interface RemoveOutcome {
  removed: boolean;
  /** The bytes the file held, when it was removed; 0 otherwise. */
  bytes: number;
  /** Why it was not removed. */
  reason?: string;
}

export interface RemoveSeams {
  /**
   * Runs between the first check and the last: the tests' seam for what another process
   * could do in that moment.
   */
  window?: () => void | Promise<void>;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** This process's user, or null where there is none to compare (Windows). */
function ownUid(): bigint | null {
  return typeof process.getuid === 'function' ? BigInt(process.getuid()) : null;
}

/**
 * The spill folder under `appDataDir`, resolved, or why it cannot be used: an absolute
 * app-data, a folder of its own at `<real app-data>/scan-spill` (not a link, a junction or
 * any other reparse point leading elsewhere), and on POSIX this user's and writable by no
 * one else. `absent` says it does not exist, so nothing was ever spilled there.
 */
function realSpillDir(appDataDir: string): { dir: string } | { reason: string; absent: boolean } {
  if (!path.isAbsolute(appDataDir)) {
    return { reason: `the app-data folder ${appDataDir} is not an absolute path`, absent: false };
  }
  const spillDir = path.join(appDataDir, SPILL_DIR);
  let stat: fs.BigIntStats;
  try {
    // lstat does not follow a link, so a link here, a junction included, is no directory.
    stat = fs.lstatSync(spillDir, { bigint: true });
  } catch (err) {
    const absent = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return { reason: `${spillDir} cannot be read: ${describe(err)}`, absent };
  }
  if (!stat.isDirectory()) {
    return { reason: `${spillDir} is not a folder of its own (it is a link, or not a folder)`, absent: false };
  }
  const uid = ownUid();
  if (uid !== null && stat.uid !== uid) {
    return { reason: `${spillDir} belongs to user ${stat.uid}, not to the user TreeMap runs as (${uid})`, absent: false };
  }
  if (uid !== null && (stat.mode & 0o022n) !== 0n) {
    return { reason: `${spillDir} can be written by other users`, absent: false };
  }
  try {
    const dir = fs.realpathSync.native(spillDir);
    const expected = path.join(fs.realpathSync.native(appDataDir), SPILL_DIR);
    if (dir !== expected) {
      return { reason: `${spillDir} leads to ${dir}, not to ${expected}`, absent: false };
    }
    return { dir };
  } catch (err) {
    return { reason: `${spillDir} cannot be resolved: ${describe(err)}`, absent: false };
  }
}

/**
 * Why a regular file in `scan-spill` cannot be one tm-store left, or null: it has another
 * name, or (POSIX) another user owns it or its permissions go beyond 0600.
 */
function notLeftByTreeMap(name: string, stat: fs.BigIntStats): string | null {
  if (stat.nlink !== 1n) return `${name} has ${stat.nlink} names, and tm-store leaves a file with one`;
  const uid = ownUid();
  if (uid === null) return null;
  if (stat.uid !== uid) return `${name} belongs to user ${stat.uid}, not to the user TreeMap runs as (${uid})`;
  if ((stat.mode & 0o7777n & ~SPILL_FILE_MODE) !== 0n) {
    return `${name} has permissions ${(stat.mode & 0o7777n).toString(8)}, beyond the 600 tm-store gives a spill file`;
  }
  return null;
}

/** Whether `now` is the file `checked` described: the same device and id, still a file. */
function sameFile(checked: fs.BigIntStats, now: fs.BigIntStats): boolean {
  return now.dev === checked.dev && now.ino === checked.ino && now.isFile();
}

/**
 * The checked file, held open without following a link, so its inode stays its own while
 * it is compared (POSIX); null on Windows, where a reused file record gets a new id anyway.
 */
function holdOpen(target: string): number | null {
  if (process.platform === 'win32') return null;
  return fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
}

/**
 * Removes `file`, a spill file left in `<appDataDir>/scan-spill`: the one place in the app
 * that removes a spill file. Refuses, with the reason, everything the module docs list.
 */
export async function removeSpillFile(appDataDir: string, file: string, seams: RemoveSeams = {}): Promise<RemoveOutcome> {
  const refuse = (reason: string): RemoveOutcome => ({ removed: false, bytes: 0, reason });
  const spill = realSpillDir(appDataDir);
  if ('reason' in spill) return refuse(spill.reason);
  const name = path.basename(file);
  if (parseSpillName(name) === null) return refuse(`${name} is not a name TreeMap gives a spill file`);
  let parent: string;
  try {
    parent = fs.realpathSync.native(path.dirname(file));
  } catch (err) {
    return refuse(`${file} is not directly inside ${spill.dir}: its folder cannot be resolved (${describe(err)})`);
  }
  if (parent !== spill.dir) return refuse(`${file} is not directly inside ${spill.dir}`);
  // From here the file is named by the resolved folder, so what is checked is what is removed.
  const target = path.join(spill.dir, name);
  let checked: fs.BigIntStats;
  try {
    checked = fs.lstatSync(target, { bigint: true });
  } catch (err) {
    return refuse(`${name} cannot be read: ${describe(err)}`);
  }
  if (checked.isSymbolicLink()) return refuse(`${name} is a link, which is never followed or removed here`);
  if (!checked.isFile()) return refuse(`${name} is not a regular file`);
  const stranger = notLeftByTreeMap(name, checked);
  if (stranger !== null) return refuse(stranger);
  let held: number | null;
  try {
    held = holdOpen(target);
  } catch (err) {
    return refuse(`${name} could not be held open to be checked: ${describe(err)}`);
  }
  try {
    if (held !== null && !sameFile(checked, fs.fstatSync(held, { bigint: true }))) {
      return refuse(`${name} was replaced after it was checked, so it was left alone`);
    }
    await seams.window?.();
    // The last check and the removal run together: nothing between them yields.
    let now: fs.BigIntStats;
    try {
      now = fs.lstatSync(target, { bigint: true });
    } catch (err) {
      return refuse(`${name} went away before it could be removed (${describe(err)})`);
    }
    if (!sameFile(checked, now)) return refuse(`${name} was replaced after it was checked, so it was left alone`);
    try {
      fs.unlinkSync(target);
    } catch (err) {
      return refuse(`${name} could not be removed: ${describe(err)}`);
    }
    return { removed: true, bytes: Number(checked.size) };
  } finally {
    if (held !== null) fs.closeSync(held);
  }
}

/** What `sweepSpillDir` did. */
export interface SweepReport {
  /** The files removed, and the bytes they held. */
  removed: number;
  bytes: number;
  /** The entries left in place: a live owner's, a name tm-store does not give, or refused. */
  kept: number;
  /** The entries of dead owners that `removeSpillFile` refused, each with its reason. */
  refused: { name: string; reason: string }[];
  /** Why the folder was not looked into, when it exists and cannot be used or read. */
  unreadable?: string;
}

export interface SweepSeams {
  /** Whether a pid is alive: `processIsAlive` unless a test says otherwise. */
  isAlive?: (pid: number) => boolean;
}

/**
 * The boot sweep: removes, through `removeSpillFile`, each entry of `<appDataDir>/scan-spill`
 * whose name tm-store gives a spill file and whose `<pid>` is dead, and keeps every other
 * entry. An absent `scan-spill` sweeps nothing; one that cannot be used or read is not looked
 * into, and the report says why.
 */
export async function sweepSpillDir(appDataDir: string, seams: SweepSeams = {}): Promise<SweepReport> {
  const isAlive = seams.isAlive ?? processIsAlive;
  const report: SweepReport = { removed: 0, bytes: 0, kept: 0, refused: [] };
  const spill = realSpillDir(appDataDir);
  if ('reason' in spill) {
    if (!spill.absent) report.unreadable = spill.reason;
    return report;
  }
  let names: string[];
  try {
    names = fs.readdirSync(spill.dir);
  } catch (err) {
    report.unreadable = `${spill.dir} cannot be listed: ${describe(err)}`;
    return report;
  }
  for (const name of names) {
    const owner = parseSpillName(name);
    if (owner === null || isAlive(owner.pid)) {
      report.kept++;
      continue;
    }
    const outcome = await removeSpillFile(appDataDir, path.join(spill.dir, name));
    if (outcome.removed) {
      report.removed++;
      report.bytes += outcome.bytes;
    } else {
      report.kept++;
      report.refused.push({ name, reason: outcome.reason ?? 'refused' });
    }
  }
  return report;
}

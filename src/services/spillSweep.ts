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
 * - a `scan-spill` that is a link or not a folder, which it never looks into;
 * - a path whose real location is not directly inside `scan-spill`;
 * - a name tm-store does not give a spill file;
 * - a link, which it never follows, and anything else that is not a regular file;
 * - a file replaced since it was checked: the `(dev, ino)` it checked must be the one it
 *   removes.
 *
 * Wiring is T17's: the sweep at boot in `src/server.ts`, `pathGuard` over `scan-spill`, the
 * Empty Folders view skipping it, and the missing-gigabytes line.
 */

/** The folder under app-data that holds spill files (tm-store's `SPILL_DIR`). */
export const SPILL_DIR = 'scan-spill';

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
 * `<pid>-<startMs>-<scanId>-<column>`: the scan id holds ASCII letters, digits, `-` and `_`
 * (at most 64), the column letters, digits and `_` (at most 32), so the last `-` ends the
 * id. The same bounds as tm-store's `SCAN_ID_MAX` and `COLUMN_MAX`, which that crate's tests
 * pin on its side.
 */
const SPILL_NAME = /^(\d{1,10})-(\d{1,20})-([A-Za-z0-9_-]{1,64})-([A-Za-z0-9_]{1,32})$/;
/** The largest pid a process can have; `process.kill` takes nothing past a 32-bit int. */
const MAX_PID = 2 ** 31 - 1;

/**
 * `name` read as a spill file's name, or null when tm-store would not have made it. A pid
 * of 0 is no process (and `process.kill(0)` would ask the whole process group), so it does
 * not parse.
 */
export function parseSpillName(name: string): SpillName | null {
  const match = SPILL_NAME.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > MAX_PID) return null;
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
   * Runs between the check and the removal: the tests' seam for what another process could
   * do in that moment.
   */
  window?: () => void | Promise<void>;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The spill folder under `appDataDir`, resolved, or why it cannot be used: it must be a
 * folder of its own, not a link to one elsewhere.
 */
function realSpillDir(appDataDir: string): { dir: string } | { reason: string } {
  const spillDir = path.join(appDataDir, SPILL_DIR);
  try {
    // lstat does not follow a link, so a link here, a junction included, is no directory.
    const stat = fs.lstatSync(spillDir);
    if (!stat.isDirectory()) {
      return { reason: `${spillDir} is not a folder of its own (it is a link, or not a folder), so nothing in it is removed` };
    }
    return { dir: fs.realpathSync.native(spillDir) };
  } catch (err) {
    return { reason: `${spillDir} cannot be read: ${describe(err)}` };
  }
}

/**
 * Removes `file`, a spill file left in `<appDataDir>/scan-spill`: the one place in the app
 * that removes a spill file. Refuses, with the reason, everything the module docs list. The
 * last check and the removal are a few microseconds apart, and only a process of the same
 * user could replace the file between them (the folder is mode 0700).
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
  await seams.window?.();
  let now: fs.BigIntStats;
  try {
    now = fs.lstatSync(target, { bigint: true });
  } catch (err) {
    return refuse(`${name} went away before it could be removed (${describe(err)})`);
  }
  if (now.dev !== checked.dev || now.ino !== checked.ino || !now.isFile()) {
    return refuse(`${name} was replaced after it was checked, so it was left alone`);
  }
  try {
    await fs.promises.unlink(target);
  } catch (err) {
    return refuse(`${name} could not be removed: ${describe(err)}`);
  }
  return { removed: true, bytes: Number(checked.size) };
}

/** What `sweepSpillDir` did: the files it removed and their bytes, and the entries it kept. */
export interface SweepReport {
  removed: number;
  bytes: number;
  kept: number;
}

export interface SweepSeams {
  /** Whether a pid is alive: `processIsAlive` unless a test says otherwise. */
  isAlive?: (pid: number) => boolean;
}

/**
 * The boot sweep: removes, through `removeSpillFile`, each entry of `<appDataDir>/scan-spill`
 * whose name tm-store gives a spill file and whose `<pid>` is dead, and keeps every other
 * entry. A `scan-spill` that is absent, a link, not a folder or unreadable is not looked
 * into, and the report is all zeros: nothing there was TreeMap's to remove.
 */
export async function sweepSpillDir(appDataDir: string, seams: SweepSeams = {}): Promise<SweepReport> {
  const isAlive = seams.isAlive ?? processIsAlive;
  const report: SweepReport = { removed: 0, bytes: 0, kept: 0 };
  const spill = realSpillDir(appDataDir);
  if ('reason' in spill) return report;
  let names: string[];
  try {
    names = fs.readdirSync(spill.dir);
  } catch {
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
    }
  }
  return report;
}

import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { meansAbsent, describeFsError } from '../utils/errno';
import { accessAdviceNow, accessCodeOf } from '../utils/accessAdvice';
import { refuseUnderTestRunner } from './realMachineGuard';
import { readMountTable } from '../utils/mountBoundaries';
import type { MountEntry } from '../platform/atime';

/**
 * Trash accounting (Feature 8). Best-effort, read-only sizing of the system
 * Trash / Recycle Bin so the UI can show how many bytes it holds against the
 * disk quota and list its contents.
 *
 * Sizing never deletes anything. The one destructive operation here is
 * emptyTrash(), reachable only through POST /api/trash/empty with an explicit
 * { confirm: true } — it empties via each platform's native mechanism through
 * execFile argv arrays (no shell), mirroring cleaner.ts.
 */

export interface TrashItem {
  name: string;
  path: string;
  size: number;
}

export interface TrashInfo {
  available: boolean;
  totalBytes: number;
  itemCount: number;
  paths: string[];
  items: TrashItem[];
  /**
   * False when any trash location or subtree could not be read, so
   * `totalBytes` and `itemCount` are floors rather than facts.
   *
   * This is not hypothetical. On macOS `~/.Trash` is TCC-protected, and a
   * build without Full Disk Access gets **EPERM** from `readdir` — measured
   * on the maintainer's own Mac against a Trash holding hundreds of items.
   * Every failure was swallowed with `continue`, so the app reported zero
   * bytes, rendered "The Trash is empty.", disabled Empty Trash, and
   * `emptyTrash()` short-circuited to `emptied: true, freedBytes: 0`. A
   * disk-space tool telling someone their full Trash is empty is the worst
   * shape this bug class takes, so the incompleteness is now carried out
   * rather than discarded.
   */
  complete: boolean;
  /** Why the sweep was incomplete, in one sentence a person can act on. */
  incompleteReason?: string;
}

const MAX_ENTRIES = 200_000; // overall traversal budget so a huge Trash can't hang the request
const MAX_ITEMS = 500; // cap on the returned top-level item list

/** What a sweep could not read, so the caller can say so instead of guessing. */
interface SweepProblems {
  /** An errno seen while reading a directory or entry, first one wins. */
  code: string | null;
  /** True once anything at all was skipped, including the entry budget. */
  any: boolean;
}

/** Recursive byte size of a directory, bounded by a shared entry budget. */
async function dirSize(dir: string, budget: { n: number }, problems: SweepProblems): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length && budget.n > 0) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch (err) {
      // A subtree that could not be read contributes zero bytes, which is a
      // FLOOR and not a measurement. Recorded rather than swallowed.
      if (!meansAbsent(err)) noteProblem(problems, err);
      continue;
    }
    for (const ent of entries) {
      if (budget.n-- <= 0) { problems.any = true; break; }
      const full = path.join(d, ent.name);
      try {
        if (ent.isDirectory() && !ent.isSymbolicLink()) stack.push(full);
        else total += (await fsp.lstat(full)).size;
      } catch (err) {
        // A vanished entry is ordinary in a Trash being emptied elsewhere;
        // an unreadable one means the total is short by an unknown amount.
        if (!meansAbsent(err)) noteProblem(problems, err);
      }
    }
  }
  if (stack.length > 0) problems.any = true; // budget ran out with work left
  return total;
}

function noteProblem(problems: SweepProblems, err: unknown): void {
  problems.any = true;
  if (problems.code === null) problems.code = (err as NodeJS.ErrnoException).code ?? 'unknown';
}

/** The macOS directories that hold trashed items (Windows and Linux: trashLocations). */
/**
 * Where the Trash lives — or, under `TREEMAP_TRASH_DIR`, a directory a test
 * owns.
 *
 * The override exists because a test in this repo ran the REAL emptier
 * against the REAL Trash and emptied it, repeatedly, on the maintainer's own
 * machine. It reached it by accident: the test injected a `readdir` failure
 * matched on the suffix `.Trash`, which is the macOS layout, so on any other
 * platform the injection missed and `emptyTrash()` ran for real —
 * `Clear-RecycleBin -Force` on Windows, `gio trash --empty` on Linux. On
 * macOS the injection DID fire, and that turned out to be worse: an
 * unreadable Trash is exactly the state in which `emptyTrash` declines to
 * short-circuit and runs the platform emptier.
 *
 * A test that irreversibly deletes user data must not be able to reach the
 * real location at all, so this is a hard boundary rather than a convention.
 * `TREEMAP_DATA_DIR` already establishes the pattern for the same reason.
 */
export function trashDirOverride(): string | null {
  const override = process.env.TREEMAP_TRASH_DIR;
  return override && override.length > 0 ? override : null;
}

/** The drives whose Recycle Bin the Windows listing reads (hunt C67: the emptier clears every drive's). */
const WINDOWS_TRASH_DRIVES = ['C:', 'D:', 'E:'];

/**
 * What the Windows listing leaves out, said (hunt C67). `Clear-RecycleBin`
 * empties the Recycle Bin on every drive, and Node has no cheap way to list
 * the drives without risking a stall on a mapped network drive — so the
 * listing is a floor there, and the Empty Trash sheet says "at least".
 */
export function windowsTrashNote(drives: readonly string[]): string {
  const named = drives.length > 1 ? `${drives.slice(0, -1).join(', ')} and ${drives[drives.length - 1]}` : drives.join('');
  return `TreeMap counts the Recycle Bin on drives ${named} only; emptying it empties the Recycle Bin on every drive.`;
}

/** Linux filesystems that hold no Trash folder of a drive's own: kernel tables, memory, and network shares a dead server could stall. */
const NO_DRIVE_TRASH = new Set([
  'proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'ramfs', 'cgroup', 'cgroup2', 'securityfs', 'debugfs', 'tracefs', 'pstore', 'bpf',
  'mqueue', 'hugetlbfs', 'configfs', 'fusectl', 'autofs', 'binfmt_misc', 'efivarfs', 'nsfs', 'rpc_pipefs', 'overlay', 'squashfs',
  'nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', 'fuse.sshfs', '9p', 'afs', 'ceph', 'glusterfs',
]);

/**
 * The freedesktop Trash folders on Linux (hunt C67): the home Trash, and on
 * each drive the mount table lists, `.Trash/<uid>/files` and
 * `.Trash-<uid>/files` — which `gio trash --empty` empties too. With no
 * mount table, `note` says what is not counted.
 */
export function linuxTrashLocations(dataHome: string, uid: number | null, mounts: readonly MountEntry[] | null): { dirs: string[]; note: string | null } {
  const dirs = [path.posix.join(dataHome, 'Trash', 'files')];
  if (uid === null) return { dirs, note: null };
  if (mounts === null) {
    return { dirs, note: 'TreeMap could not read the list of mounted drives, so a Trash folder on another drive is not counted here, though emptying the Trash empties it too.' };
  }
  for (const m of mounts) {
    if (NO_DRIVE_TRASH.has(m.filesystem)) continue;
    dirs.push(path.posix.join(m.mountPoint, '.Trash', String(uid), 'files'), path.posix.join(m.mountPoint, `.Trash-${uid}`, 'files'));
  }
  return { dirs, note: null };
}

/**
 * The name a Windows Recycle Bin `$I` record gives the file it stands for:
 * version 1 (Vista to 8.1) holds it in a fixed 520-byte field at 24, version 2
 * (Windows 10 and later) a length at 24 and the name at 28, both UTF-16. Null
 * when the record is not one of those, or is cut short.
 */
export function recycleInfoOriginalName(buf: Buffer): string | null {
  if (buf.length < 28) return null;
  const version = buf.readBigInt64LE(0);
  let raw: string;
  if (version === 1n) {
    if (buf.length < 24 + 520) return null;
    raw = buf.toString('utf16le', 24, 24 + 520);
  } else if (version === 2n) {
    const chars = buf.readInt32LE(24);
    if (chars <= 0 || buf.length < 28 + chars * 2) return null;
    raw = buf.toString('utf16le', 28, 28 + chars * 2);
  } else {
    return null;
  }
  const full = raw.split('\0')[0];
  const name = path.win32.basename(full);
  return name.length > 0 ? name : null;
}

/** What one account folder of a Windows Recycle Bin is read with (injected, so a test runs it anywhere). */
export interface AccountBinDeps {
  join(...parts: string[]): string;
  readdir(dir: string): Promise<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[]>;
  lstat(p: string): Promise<{ size: number }>;
  readFile(p: string): Promise<Buffer>;
  dirSize(dir: string): Promise<number>;
}

/**
 * One account's folder of a Windows `$Recycle.Bin` (`S-1-5-21-…`), listed by
 * what was deleted (hunt C67): each `$R…` is an item, named from its `$I…`
 * record where that reads, and every byte the folder holds is counted. A
 * folder this user may not read is another account's Recycle Bin: not this
 * user's Trash, and not something `Clear-RecycleBin` run as them empties.
 */
export async function listAccountBin(dir: string, deps: AccountBinDeps): Promise<{ items: TrashItem[]; bytes: number; unreadable: boolean }> {
  let entries;
  try {
    entries = await deps.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || meansAbsent(err)) return { items: [], bytes: 0, unreadable: false };
    return { items: [], bytes: 0, unreadable: true };
  }
  const items: TrashItem[] = [];
  let bytes = 0;
  for (const ent of entries) {
    const full = deps.join(dir, ent.name);
    let size: number;
    try {
      size = ent.isDirectory() && !ent.isSymbolicLink() ? await deps.dirSize(full) : (await deps.lstat(full)).size;
    } catch (err) {
      if (!meansAbsent(err)) return { items, bytes, unreadable: true };
      continue;
    }
    bytes += size;
    if (!ent.name.startsWith('$R')) continue; // `$I` records and desktop.ini are the bin's own
    let name = ent.name;
    try {
      name = recycleInfoOriginalName(await deps.readFile(deps.join(dir, '$I' + ent.name.slice(2)))) ?? ent.name;
    } catch { /* no record: the bin's own name for it */ }
    items.push({ name, path: full, size });
  }
  return { items, bytes, unreadable: false };
}

/** Every trash location, and what the listing does not read where it is a floor (hunt C67). */
async function trashLocations(): Promise<{ dirs: string[]; note: string | null }> {
  const override = trashDirOverride();
  if (override) return { dirs: [override], note: null };
  if (process.platform === 'win32') {
    refuseUnderTestRunner("a test reached the machine's real Trash: listing it — point TREEMAP_TRASH_DIR at a folder the test owns");
    return { dirs: WINDOWS_TRASH_DRIVES.map((d) => path.join(d + '\\', '$Recycle.Bin')), note: windowsTrashNote(WINDOWS_TRASH_DRIVES) };
  }
  if (process.platform !== 'darwin') {
    refuseUnderTestRunner("a test reached the machine's real Trash: listing it — point TREEMAP_TRASH_DIR at a folder the test owns");
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const table = await readMountTable('linux');
    return linuxTrashLocations(dataHome, uid, table.entries);
  }
  return { dirs: await trashDirs(), note: null };
}

async function trashDirs(): Promise<string[]> {
  const override = trashDirOverride();
  if (override) return [override];
  // Under a test runner the machine's Trash is not even listed — its names and sizes are the
  // owner's — so a test points TREEMAP_TRASH_DIR at a folder of its own (realMachineGuard.ts).
  refuseUnderTestRunner("a test reached the machine's real Trash: listing it — point TREEMAP_TRASH_DIR at a folder the test owns");
  const home = os.homedir();
  const dirs: string[] = [];
  if (process.platform === 'darwin') {
    dirs.push(path.join(home, '.Trash'));
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid != null) {
      try {
        const vols = await fsp.readdir('/Volumes', { withFileTypes: true });
        for (const v of vols) {
          if (v.isSymbolicLink()) continue;
          dirs.push(path.join('/Volumes', v.name, '.Trashes', String(uid)));
        }
      } catch {
        /* no /Volumes (non-mac layout) — ignore */
      }
    }
  }
  // Windows and Linux are listed by trashLocations (hunt C67).
  return dirs;
}

/** Best-effort size + top-level contents of every trash location. */
export async function getTrashInfo(): Promise<TrashInfo> {
  const { dirs, note } = await trashLocations();
  const budget = { n: MAX_ENTRIES };
  const items: TrashItem[] = [];
  const problems: SweepProblems = { code: null, any: false };
  let totalBytes = 0;

  for (const dir of dirs) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // ENOENT genuinely means "this location doesn't exist on this machine"
      // — `trashDirs` synthesises a path per mounted volume, so most of them
      // legitimately are not there. Every OTHER errno means a location that
      // DOES exist could not be read, and its contents are missing from the
      // totals below.
      if (!meansAbsent(err)) noteProblem(problems, err);
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      // Windows keeps one folder per account in $Recycle.Bin: its items are what is inside (hunt C67).
      if (process.platform === 'win32' && /^S-1-/i.test(ent.name) && ent.isDirectory()) {
        const bin = await listAccountBin(full, {
          join: path.join, readdir: (d) => fsp.readdir(d, { withFileTypes: true }), lstat: (p) => fsp.lstat(p),
          readFile: (p) => fsp.readFile(p), dirSize: (d) => dirSize(d, budget, problems),
        });
        if (bin.unreadable) noteProblem(problems, Object.assign(new Error('unreadable'), { code: 'EIO' }));
        totalBytes += bin.bytes;
        items.push(...bin.items);
        continue;
      }
      let size = 0;
      try {
        if (ent.isDirectory() && !ent.isSymbolicLink()) size = await dirSize(full, budget, problems);
        else size = (await fsp.lstat(full)).size;
      } catch (err) {
        if (!meansAbsent(err)) noteProblem(problems, err);
        continue;
      }
      totalBytes += size;
      items.push({ name: ent.name, path: full, size });
    }
  }

  items.sort((a, b) => b.size - a.size);
  return {
    available: true,
    totalBytes,
    itemCount: items.length,
    paths: items.map((i) => i.path),
    items: items.slice(0, MAX_ITEMS),
    // A listing that does not read every place the emptier clears is a floor, and says so (hunt C67).
    complete: !problems.any && note === null,
    ...(problems.any || note !== null
      ? { incompleteReason: [problems.any ? describeSweepProblem(problems.code) : null, note].filter(Boolean).join(' ') }
      : {}),
  };
}

/**
 * One actionable sentence for why the Trash could not be fully measured: what
 * could not be read, and what to do. It claims no total (browser re-check C02):
 * the sheet that shows it over a Trash it could not read at all has none to
 * show, and said "so this total is a minimum" beside nothing. Where a figure is
 * shown, "at least" goes with the figure.
 */
function describeSweepProblem(code: string | null): string {
  if (code === 'EPERM' || code === 'EACCES') {
    // On macOS the fix follows the errno and the probed Full Disk Access state (Track U, U-11).
    return process.platform === 'darwin'
      ? `macOS would not let TreeMap read the Trash. ${accessAdviceNow({ code: accessCodeOf(code), retry: 'look again' })}`
      : 'TreeMap does not have permission to read part of the Trash.';
  }
  if (code === null) return 'The Trash holds more than TreeMap reads in one pass, so the rest of it was not counted.';
  return `Part of the Trash could not be read (${code}).`;
}

/* ---------- Empty Trash ---------- */

export interface EmptyTrashResult {
  /**
   * The emptier ran and nothing reported a failure.
   *
   * NOT "the Trash is empty afterwards" — that is `verified`, and the two
   * come apart on the commonest macOS configuration there is. Requiring
   * confirmation here reported a SUCCESSFUL Finder empty as a failure
   * ("Emptied 0 B, but some items could not be removed") on any Mac without
   * Full Disk Access, because the re-read that would have confirmed it is
   * exactly the read that permission denies. An irreversible operation that
   * worked must not be announced as broken.
   */
  emptied: boolean;
  /**
   * The Trash was re-read afterwards and really is empty.
   *
   * False when the sweep could not read it — the emptying may still have
   * worked, and `emptied` says whether it was attempted without error.
   */
  verified: boolean;
  freedBytes: number;
  itemCount: number;
  /** Per-location failures — one location failing never aborts the rest. */
  failed: { location: string; reason: string }[];
}

/** A huge Trash takes a while to shred; give the native mechanism 10 minutes. */
const EMPTY_TIMEOUT_MS = 600_000;

/**
 * The native empty-trash commands per platform, as execFile argv arrays
 * (never shell strings), tried in order. Exported so tests can assert the
 * exact argv chosen per platform without executing anything.
 *
 *  - macOS: Finder empties everything it owns, including per-volume .Trashes.
 *  - Windows: Clear-RecycleBin clears all drives; older PowerShell without the
 *    cmdlet exits nonzero and is reported, not crashed on.
 *  - Linux: gio empties every freedesktop trash; when gio is absent the caller
 *    falls back to clearing Trash/files + Trash/info directly.
 */
export function emptyTrashCommands(platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] }[] {
  switch (platform) {
    case 'darwin':
      return [{ cmd: 'osascript', args: ['-e', 'tell application "Finder" to empty trash'] }];
    case 'win32':
      return [{
        cmd: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', 'Clear-RecycleBin -Force -ErrorAction Stop'],
      }];
    default:
      return [{ cmd: 'gio', args: ['trash', '--empty'] }];
  }
}

function runArgv(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: EMPTY_TIMEOUT_MS, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || 'command failed').trim()));
      else resolve();
    });
  });
}

/**
 * Empty one directory's contents, for the test override only.
 *
 * Never the system Trash: the platform emptiers take no path argument, so
 * running one under the override would empty the real Trash whatever
 * `trashDirs` was pointed at.
 */
async function clearDirectoryContents(dir: string, failed: EmptyTrashResult['failed']): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    if (!meansAbsent(err)) failed.push({ location: dir, reason: describeFsError(err) });
    return;
  }
  for (const name of entries) {
    try {
      await fsp.rm(path.join(dir, name), { recursive: true, force: true });
    } catch (err) {
      failed.push({ location: path.join(dir, name), reason: describeFsError(err) });
    }
  }
}

/** Freedesktop fallback: remove the contents of Trash/files and Trash/info. */
async function clearFreedesktopTrash(failed: EmptyTrashResult['failed']): Promise<void> {
  // Every freedesktop Trash, as gio empties them: the home one and each drive's (hunt C67).
  for (const filesDir of (await trashLocations()).dirs) {
    for (const dir of [filesDir, path.join(path.dirname(filesDir), 'info')]) {
      let entries: string[];
      try {
        entries = await fsp.readdir(dir);
      } catch {
        continue; // location doesn't exist — nothing to clear
      }
      for (const name of entries) {
        try {
          await fsp.rm(path.join(dir, name), { recursive: true, force: true });
        } catch (err) {
          failed.push({ location: path.join(dir, name), reason: describeFsError(err) });
        }
      }
    }
  }
}

/**
 * Empty the system Trash / Recycle Bin via the platform's native mechanism.
 * Irreversible — the API route requires an explicit confirm flag before this
 * runs. Freed bytes are measured (before minus after), not assumed, so partial
 * failures report what actually happened.
 */
export async function emptyTrash(): Promise<EmptyTrashResult> {
  // Under a test runner the machine's Trash is never emptied, nor even read here: a test points
  // TREEMAP_TRASH_DIR at a folder of its own (realMachineGuard.ts).
  if (trashDirOverride() === null) {
    refuseUnderTestRunner("a test reached the machine's real Trash: emptying it — point TREEMAP_TRASH_DIR at a folder the test owns");
  }
  const before = await getTrashInfo();
  // `itemCount === 0` is only a reason to do nothing when the count is a
  // MEASUREMENT. When the sweep could not read the Trash — EPERM from a
  // TCC-protected `~/.Trash` is the everyday case on macOS without Full Disk
  // Access — the count is zero because nothing could be seen, and returning
  // `emptied: true, freedBytes: 0` told the user their Trash was emptied when
  // TreeMap had not looked at it, let alone touched it. Run the platform's
  // own emptier instead: it has its own permissions, and it can succeed where
  // the enumeration could not.
  if (before.itemCount === 0 && before.complete) {
    return { emptied: true, verified: true, freedBytes: 0, itemCount: 0, failed: [] };
  }

  const failed: EmptyTrashResult['failed'] = [];
  let ran = false;

  // Under the override this is a directory the caller owns, not the system
  // Trash, so the platform emptier must not be invoked — `Clear-RecycleBin`
  // and `osascript … empty trash` do not take a path and would empty the real
  // one regardless of what `trashDirs` says.
  const override = trashDirOverride();
  if (override) {
    await clearDirectoryContents(override, failed);
    ran = failed.length === 0;
  } else {
  for (const { cmd, args } of emptyTrashCommands()) {
    try {
      await runArgv(cmd, args);
      ran = true;
      break;
    } catch (err) {
      // The page prints this after "Emptied X, but …", so it is a sentence;
      // the command's own output goes to the terminal, where it can be read.
      console.warn(`[treemap] ${cmd} could not empty the Trash:`, err instanceof Error ? err.message : err);
      failed.push({ location: cmd, reason: "the system's own Trash emptier did not run" });
    }
  }
  if (!ran && process.platform !== 'darwin' && process.platform !== 'win32') {
    // The freedesktop fallback is what actually empties the Trash on a Linux
    // box without `gio`, so it has to report that it ran. Leaving `ran` false
    // there made a successful empty come back as
    // `{ emptied: false, freedBytes: 6144 }` — a result that contradicts
    // itself, on a platform in this repo's CI matrix and its own Dockerfile.
    const before = failed.length;
    await clearFreedesktopTrash(failed);
    ran = failed.length === before;
  }
  }

  const after = await getTrashInfo();
  // `after.itemCount === 0` is only evidence of an empty Trash when the sweep
  // could actually READ it. With EPERM — the default state on macOS without
  // Full Disk Access — it is zero because nothing was visible, so this
  // reported `emptied: true, freedBytes: 0, failed: []` even when every
  // emptier command had thrown. The guard added earlier only fixed the
  // short-circuit at the top of this function; the same wrong conclusion was
  // still being drawn at the bottom.
  //
  // `ran` matters too: if no platform mechanism executed at all, nothing was
  // emptied whatever the counts say.
  // Two different claims, and conflating them is what turned a successful
  // empty into an error message. `emptied` is what this process did;
  // `verified` is what it could afterwards see.
  const emptied = ran && failed.length === 0;
  const verified = after.complete && after.itemCount === 0;
  return {
    emptied,
    verified,
    freedBytes: Math.max(0, before.totalBytes - after.totalBytes),
    itemCount: Math.max(0, before.itemCount - after.itemCount),
    // A mechanism that finished the job makes earlier attempts uninteresting.
    // Keyed on `emptied` (nothing failed) rather than on `verified`, because
    // an unreadable Trash must not manufacture a failure list either.
    failed: emptied ? [] : failed,
  };
}

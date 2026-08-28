import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { meansAbsent } from '../utils/errno';

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

/** Per-platform directories that hold trashed items. */
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

async function trashDirs(): Promise<string[]> {
  const override = trashDirOverride();
  if (override) return [override];
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
  } else if (process.platform === 'win32') {
    for (const drive of ['C:', 'D:', 'E:']) dirs.push(path.join(drive + '\\', '$Recycle.Bin'));
  } else {
    const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    dirs.push(path.join(dataHome, 'Trash', 'files'));
  }
  return dirs;
}

/** Best-effort size + top-level contents of every trash location. */
export async function getTrashInfo(): Promise<TrashInfo> {
  const dirs = await trashDirs();
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
    complete: !problems.any,
    ...(problems.any ? { incompleteReason: describeSweepProblem(problems.code) } : {}),
  };
}

/** One actionable sentence for why the Trash could not be fully measured. */
function describeSweepProblem(code: string | null): string {
  if (code === 'EPERM' || code === 'EACCES') {
    return process.platform === 'darwin'
      ? 'macOS would not let TreeMap read the Trash. Give it Full Disk Access in System Settings › Privacy & Security to see what is in there.'
      : 'TreeMap does not have permission to read part of the Trash, so this total is a minimum.';
  }
  if (code === null) return 'The Trash is larger than TreeMap walks in one pass, so this total is a minimum.';
  return `Part of the Trash could not be read (${code}), so this total is a minimum.`;
}

/* ---------- Empty Trash ---------- */

export interface EmptyTrashResult {
  /** True when every trash location is empty afterwards. */
  emptied: boolean;
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
    if (!meansAbsent(err)) failed.push({ location: dir, reason: err instanceof Error ? err.message : String(err) });
    return;
  }
  for (const name of entries) {
    try {
      await fsp.rm(path.join(dir, name), { recursive: true, force: true });
    } catch (err) {
      failed.push({ location: path.join(dir, name), reason: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** Freedesktop fallback: remove the contents of Trash/files and Trash/info. */
async function clearFreedesktopTrash(failed: EmptyTrashResult['failed']): Promise<void> {
  for (const filesDir of await trashDirs()) {
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
          failed.push({ location: path.join(dir, name), reason: err instanceof Error ? err.message : String(err) });
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
    return { emptied: true, freedBytes: 0, itemCount: 0, failed: [] };
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
      failed.push({ location: cmd, reason: err instanceof Error ? err.message : String(err) });
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
  const emptied = ran && after.complete && after.itemCount === 0;
  return {
    emptied,
    freedBytes: Math.max(0, before.totalBytes - after.totalBytes),
    itemCount: Math.max(0, before.itemCount - after.itemCount),
    // A fallback that finished the job makes earlier attempts uninteresting —
    // but only when we can see that it finished. Discarding the failures on
    // an unreadable Trash is how a total failure was reported as a success.
    failed: emptied ? [] : failed,
  };
}

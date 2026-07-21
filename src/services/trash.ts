import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';

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
}

const MAX_ENTRIES = 200_000; // overall traversal budget so a huge Trash can't hang the request
const MAX_ITEMS = 500; // cap on the returned top-level item list

/** Recursive byte size of a directory, bounded by a shared entry budget. */
async function dirSize(dir: string, budget: { n: number }): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length && budget.n > 0) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (budget.n-- <= 0) break;
      const full = path.join(d, ent.name);
      try {
        if (ent.isDirectory() && !ent.isSymbolicLink()) stack.push(full);
        else total += (await fsp.lstat(full)).size;
      } catch {
        /* entry vanished or unreadable — skip */
      }
    }
  }
  return total;
}

/** Per-platform directories that hold trashed items. */
async function trashDirs(): Promise<string[]> {
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
  let totalBytes = 0;

  for (const dir of dirs) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // location doesn't exist on this machine — skip
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      let size = 0;
      try {
        if (ent.isDirectory() && !ent.isSymbolicLink()) size = await dirSize(full, budget);
        else size = (await fsp.lstat(full)).size;
      } catch {
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
  };
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
  if (before.itemCount === 0) {
    return { emptied: true, freedBytes: 0, itemCount: 0, failed: [] };
  }

  const failed: EmptyTrashResult['failed'] = [];
  let ran = false;
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
    await clearFreedesktopTrash(failed);
  }

  const after = await getTrashInfo();
  const emptied = after.itemCount === 0;
  return {
    emptied,
    freedBytes: Math.max(0, before.totalBytes - after.totalBytes),
    itemCount: Math.max(0, before.itemCount - after.itemCount),
    // A fallback that finished the job makes earlier attempts uninteresting.
    failed: emptied ? [] : failed,
  };
}

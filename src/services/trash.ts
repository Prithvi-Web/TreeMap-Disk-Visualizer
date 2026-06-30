import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';

/**
 * Trash accounting (Feature 8). Best-effort, read-only sizing of the system
 * Trash / Recycle Bin so the UI can show how many bytes it holds against the
 * disk quota and list its contents. Never deletes or empties anything.
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

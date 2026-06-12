import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';

/**
 * Storage — tiny JSON-file persistence in the platform's app-data directory.
 * Used for scan snapshots (Trends) and user settings (schedules, ignore list).
 * Plain JSON keeps the stack dependency-free; the data volumes here are tiny
 * (a few KB), so a database would be pure overhead.
 */

/** Per-OS app-data directory, created on demand. */
export function appDataDir(): string {
  if (process.env.TREEMAP_DATA_DIR) return process.env.TREEMAP_DATA_DIR;
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'TreeMap');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'TreeMap');
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'treemap');
  }
}

/** Serialize writes per file so two near-simultaneous saves can't interleave. */
const writeQueues = new Map<string, Promise<void>>();

/** Read a JSON file from the app-data dir; returns `fallback` when missing/corrupt. */
export async function readJsonFile<T>(name: string, fallback: T): Promise<T> {
  try {
    const raw = await fsp.readFile(path.join(appDataDir(), name), 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback; // ENOENT on first run, or unreadable JSON — start fresh
  }
}

/** Atomically write a JSON file (tmp + rename) in the app-data dir. */
export function writeJsonFile(name: string, data: unknown): Promise<void> {
  const prev = writeQueues.get(name) ?? Promise.resolve();
  const next = prev
    .catch(() => {
      /* an earlier failed write must not poison the queue */
    })
    .then(async () => {
      const dir = appDataDir();
      await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, name);
      const tmp = file + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fsp.rename(tmp, file);
    });
  writeQueues.set(name, next);
  return next;
}

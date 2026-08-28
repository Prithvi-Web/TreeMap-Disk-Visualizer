import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { isEphemeral } from './portableMode';
import { meansAbsent } from '../utils/errno';

/**
 * Storage — tiny JSON-file persistence in the platform's app-data directory.
 * Used for scan snapshots (Trends) and user settings (schedules, ignore list).
 * Plain JSON keeps the stack dependency-free; the data volumes here are tiny
 * (a few KB), so a database would be pure overhead.
 */

/** Per-OS app-data directory, created on demand. */
/**
 * In-memory stand-in for the app-data directory, used only by a read-only
 * portable session (D3). Nothing here ever reaches a disk.
 */
const memoryFiles = new Map<string, string>();

/** Test-only: the map outlives a single test otherwise. */
export function resetMemoryStore(): void {
  memoryFiles.clear();
}

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

/**
 * Read a JSON file from the app-data dir.
 *
 * `fallback` is for the two DECIDED facts: the file is not there yet
 * (`ENOENT` on first run), or it is there and is not JSON. Both genuinely
 * mean "there is nothing usable here, start fresh".
 *
 * Every other errno is not a decided fact, and inventing one here is
 * expensive because almost every caller is a read-modify-write: returning the
 * fallback made them PERSIST it, so "start fresh" quietly became "overwrite
 * what was there". One transient `EMFILE` — routine in a process that opens
 * thousands of files to scan a disk — reached all of these:
 *
 *   - `reconcileCapsule` read an empty index, concluded every payload
 *     directory on disk was an orphan, and deleted the protected copy of
 *     every file the user had ever removed through TreeMap;
 *   - `getPolicy` returned no allowedRoots, no protectedPaths and no byte
 *     cap, which is exactly the shape that disables every guard rail on
 *     agent and API deletion;
 *   - `saveTokens` dropped one cloud provider's credentials while saving
 *     another's.
 *
 * So an undecidable read throws. Callers that legitimately want to carry on
 * without the file can catch it; callers that were about to write must not.
 */
export async function readJsonFile<T>(name: string, fallback: T): Promise<T> {
  if (isEphemeral()) {
    const held = memoryFiles.get(name);
    if (held === undefined) return fallback;
    try {
      return JSON.parse(held) as T;
    } catch {
      return fallback;
    }
  }
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(appDataDir(), name), 'utf8');
  } catch (err) {
    if (meansAbsent(err)) return fallback; // not there yet — first run
    throw err; // could not tell — say so rather than answer "empty"
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    // "Nothing usable to preserve" is true of the PARSE and false of the
    // bytes. Nine stores in this app are read-modify-write, so returning the
    // fallback means the very next save replaces the unreadable file with a
    // partial one — and a half-readable `offload-manifest.json` is the only
    // record of where a user's offloaded files went, while
    // `cloud-tokens.json` is credentials for providers other than the one
    // being saved.
    //
    // So the original is kept aside first, once, and only then does the
    // caller get its fallback. Convenient behaviour for preferences (they
    // reset), without the convenience costing anything irreversible.
    await preserveCorrupt(name, err);
    return fallback;
  }
}

/**
 * Keep an unparseable store next to itself before anyone overwrites it.
 *
 * Once only — `readJsonFile` sits on hot paths (`getPolicy` runs on every
 * enforcement), so a corrupt file must not trigger a rename on every call.
 * Best-effort throughout: this runs while something is already wrong, and
 * failing to make a backup must not turn a degraded read into a hard error.
 */
async function preserveCorrupt(name: string, err: unknown): Promise<void> {
  try {
    const dir = appDataDir();
    const backup = path.join(dir, `${name}.corrupt`);
    await fsp.access(backup).then(
      () => undefined, // already kept from an earlier read; leave the first one
      async () => {
        await fsp.copyFile(path.join(dir, name), backup);
        console.error(
          `[treemap] ${name} could not be parsed (${err instanceof Error ? err.message : String(err)}). ` +
            `The original is kept at ${backup}; TreeMap is continuing with defaults.`,
        );
      },
    );
  } catch {
    /* best effort — the caller still gets its fallback */
  }
}

/** Why `readJsonFile` fell back, for callers that must treat the cases apart. */
export type JsonLoad<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'absent' }
  | { ok: false; reason: 'corrupt'; detail: string };

/**
 * `readJsonFile` with the reason attached.
 *
 * Most callers are right to treat "not there" and "not parseable" the same
 * way — both mean there is nothing usable to preserve, and starting fresh is
 * the only thing left to do. Two callers are not:
 *
 *   - **`getPolicy`.** An empty policy is `{ allowedRoots: [], protectedPaths:
 *     [], maxBytesPerOperation: null }`, and every enforcement returns
 *     immediately on that shape. So a corrupt `agent-policy.json` silently
 *     switches off every guard rail on agent and API deletion. That boundary
 *     has to fail CLOSED.
 *   - **`reconcileCapsule`.** An empty index makes every payload directory on
 *     disk look orphaned, and the sweep deletes orphans. It must be able to
 *     tell "the user's capsule really is empty" from "the index would not
 *     parse", because only the first authorises deleting anything.
 */
export async function readJsonFileChecked<T>(name: string): Promise<JsonLoad<T>> {
  if (isEphemeral()) {
    const held = memoryFiles.get(name);
    if (held === undefined) return { ok: false, reason: 'absent' };
    try {
      return { ok: true, value: JSON.parse(held) as T };
    } catch (err) {
      return { ok: false, reason: 'corrupt', detail: err instanceof Error ? err.message : String(err) };
    }
  }
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(appDataDir(), name), 'utf8');
  } catch (err) {
    if (meansAbsent(err)) return { ok: false, reason: 'absent' };
    throw err;
  }
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (err) {
    await preserveCorrupt(name, err);
    return { ok: false, reason: 'corrupt', detail: err instanceof Error ? err.message : String(err) };
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
      // A read-only portable session keeps everything in memory. Writing to the
      // host's normal location instead is the one thing D3 promises never to do.
      if (isEphemeral()) {
        memoryFiles.set(name, JSON.stringify(data, null, 2));
        return;
      }
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

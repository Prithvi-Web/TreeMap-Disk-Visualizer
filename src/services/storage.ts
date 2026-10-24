import { promises as fsp, constants as fsConstants } from 'fs';
import path from 'path';
import os from 'os';
import { isEphemeral } from './portableMode';
import { meansAbsent } from '../utils/errno';
import { processIsAlive } from './spillSweep';

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
 * The temporary file a write of `file` goes through, named for this process (FG3g review F2.5). Two
 * TreeMap processes share one app-data folder — the app and the MCP server beside it — and with one
 * fixed name a save in one truncated and wrote into the very temp file the other was half-way through:
 * the file came out torn, a reader took it for corrupt and started from empty, and the next save of
 * offload-manifest.json kept only its own entries. Now each save writes a whole file of its own and
 * the rename puts one whole document in place; when two processes save at once the later rename
 * wins. Within a process, writes of one name are already one at a time (`writeQueues`), so the
 * process id alone keeps them apart. One a kill or a crash left is removed at the next start
 * (`sweepDeadSaveTemps`).
 */
function tmpPathFor(file: string): string {
  return `${file}.${process.pid}.tmp`;
}

/** A save's temp file name (`tmpPathFor`) of a store in app-data: `<name>.json.<pid>.tmp`, the pid as Node writes one. */
const SAVE_TEMP = /^.+\.json\.([1-9]\d{0,9})\.tmp$/;
/** The largest pid `process.kill` takes. */
const MAX_PID = 2 ** 31 - 1;

/** What `sweepDeadSaveTemps` removed, and what it could not. */
export interface SaveTempSweep {
  removed: string[];
  failed: { name: string; why: string }[];
}

/**
 * Removes what saves left in app-data when the process making them was killed, crashed or lost
 * power part-way (FG3g review F3.2, F3.7); run once at start. Each save's temp file is named for its
 * own process (`tmpPathFor`), so a later save — another process, as every later start is — never
 * replaced one a dead process left: each interrupted save of a scan's cache, up to tens of
 * megabytes, stayed for good in the folder of a tool for finding wasted space.
 *
 * Only a plain file (never a link or a folder) directly in app-data whose name is exactly a save's
 * temp name, and never one whose process is still running — this one's own among them: another
 * TreeMap — the MCP server beside the app — may be half-way through that save. A pid a live process
 * has reused keeps its file until that process ends; doubt keeps a file (`processIsAlive`).
 */
export async function sweepDeadSaveTemps(): Promise<SaveTempSweep> {
  const swept: SaveTempSweep = { removed: [], failed: [] };
  if (isEphemeral()) return swept; // a read-only portable session writes nothing, removes nothing
  const dir = appDataDir();
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if (meansAbsent(err)) return swept; // no app-data yet: nothing was ever saved
    throw err;
  }
  for (const name of names) {
    const pid = Number(SAVE_TEMP.exec(name)?.[1]);
    if (!(pid > 0) || pid > MAX_PID || processIsAlive(pid)) continue; // this process, among the living, keeps its own
    const leftover = path.join(dir, name);
    try {
      if (!(await fsp.lstat(leftover)).isFile()) continue;
      await fsp.rm(leftover);
      swept.removed.push(name);
    } catch (err) {
      if (!meansAbsent(err)) swept.failed.push({ name, why: err instanceof Error ? err.message : String(err) });
    }
  }
  return swept;
}

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
export async function preserveCorrupt(name: string, err: unknown, what = 'could not be parsed'): Promise<void> {
  try {
    const dir = appDataDir();
    const source = path.join(dir, name);
    const backup = path.join(dir, `${name}.corrupt`);
    const current = await fsp.readFile(source);

    // Once per INCIDENT, not once per file. The sidecar outlives the process,
    // so a per-file check meant: corrupt, backed up, user repairs it, months
    // later it corrupts differently — sidecar exists, new bytes destroyed by
    // the next save, no backup and no log line, because the message lived
    // inside the branch that copies.
    const kept = await fsp.readFile(backup).catch(() => null);
    if (kept !== null && kept.equals(current)) return; // same incident, already kept
    // ...and an incident is the same whichever copy holds it. `<name>.corrupt`
    // holds the FIRST one, so comparing with it alone copied a later incident
    // again on every read of the still-bad file (review HD-L1).
    const prefix = `${name}.corrupt-`;
    for (const sibling of await fsp.readdir(dir).catch(() => [] as string[])) {
      if (!sibling.startsWith(prefix)) continue;
      const held = await fsp.readFile(path.join(dir, sibling)).catch(() => null);
      if (held !== null && held.equals(current)) return;
    }
    // Claimed, never written over: two incidents in one millisecond each keep
    // their own copy.
    const stamp = String(Date.now());
    let target = kept === null ? backup : `${backup}-${stamp}`;
    for (let n = 1; ; n++) {
      try {
        await fsp.copyFile(source, target, fsConstants.COPYFILE_EXCL);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n > 100) throw e;
        target = `${backup}-${stamp}-${String(n)}`;
      }
    }
    console.error(
      `[treemap] ${name} ${what} (${err instanceof Error ? err.message : String(err)}). ` +
        `The original is kept at ${target}.`,
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
      const tmpPath = tmpPathFor(file);
      await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      await replaceWith(tmpPath, file);
    });
  writeQueues.set(name, next);
  return next;
}

/**
 * Renames `tmpPath` over `file`. A rename that fails — on Windows, a target
 * another program holds open refuses one — removes `tmpPath` and rethrows, so no
 * tmp file outlives a failed write (the pre-landing review of 23 Sep 2026).
 */
async function replaceWith(tmpPath: string, file: string): Promise<void> {
  try {
    await fsp.rename(tmpPath, file);
  } catch (err) {
    await fsp.rm(tmpPath, { force: true });
    throw err;
  }
}

/**
 * Atomically write a file of the app-data dir from chunks (tmp + rename),
 * queued with every other write of the same name, for a document too big to
 * build as one string. `produce` hands each chunk to `write` — awaited, so
 * the event loop runs between chunks — and answers false to abandon the
 * write, which removes the tmp file and leaves whatever was there before; a
 * `produce` that throws does the same and rejects. Answers whether the file
 * was replaced. A read-only portable session writes nothing, keeps nothing
 * (unlike writeJsonFile, there is no whole document to hold in memory) and
 * never calls `produce`.
 */
export function writeFileChunked(
  name: string,
  produce: (write: (chunk: string) => Promise<void>) => Promise<boolean>,
): Promise<boolean> {
  const prev = writeQueues.get(name) ?? Promise.resolve();
  const next = prev
    .catch(() => {
      /* an earlier failed write must not poison the queue */
    })
    .then(async () => {
      if (isEphemeral()) return false;
      const dir = appDataDir();
      await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, name);
      // Named for tests/openHandleGuard's own-storage rule: the one path this
      // may remove is the tmp file it created a moment ago in app-data.
      const tmpPath = tmpPathFor(file);
      const handle = await fsp.open(tmpPath, 'w');
      let complete = false;
      let failed = false;
      let failure: unknown;
      try {
        complete = await produce(async (chunk) => {
          await handle.write(chunk, null, 'utf8');
        });
      } catch (err) {
        failed = true;
        failure = err;
      }
      try {
        await handle.close();
      } catch (err) {
        // A close that failed may not have flushed: it is never renamed into
        // place. When the producer threw as well, its error is the one reported.
        if (!failed) {
          failed = true;
          failure = err;
        }
      }
      if (failed || !complete) {
        await fsp.rm(tmpPath, { force: true });
        if (failed) throw failure;
        return false;
      }
      await replaceWith(tmpPath, file);
      return true;
    });
  // The queue holds a promise that never rejects: the caller handles `next`,
  // and a derived promise nobody awaits must not surface as an unhandled rejection.
  writeQueues.set(name, next.then(() => undefined, () => undefined));
  return next;
}

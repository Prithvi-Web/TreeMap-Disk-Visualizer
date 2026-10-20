import { promises as fsp } from 'fs';
import path from 'path';
import { appDataDir } from './storage';
import { isEphemeral } from './portableMode';
import { AsyncMutex } from '../utils/asyncMutex';
import { describeFsError, meansAbsent } from '../utils/errno';
import { PathRejectedError, sanitizePath } from '../utils/pathSanitizer';
import type { PlacementHooks } from '../utils/copyVerify';

/**
 * Restore leftovers (FG3g L4).
 *
 * A restore — of an Undo Vault copy or of an offloaded file — writes each file beside its name under
 * `.treemap-restore-…` and puts it at its name only once it verifies (FG3f #8), so a quit or a kill
 * part-way never leaves a part-copied file at the person's own name. It did leave that temporary file
 * beside it, and nothing ever removed it.
 *
 * So each one is recorded here, in app-data, with the file it was made as (device and id), before
 * anything is written into it. When the last restore running ends, records whose file is gone are
 * dropped. At the next start whatever is still recorded is removed — only a name TreeMap recorded,
 * and only while what stands there is still that same file. A name never recorded, or one that is
 * something else now, is left alone. A portable session that saves nothing records nothing.
 *
 * One line per file (JSON Lines), appended: a restore of fifty thousand files records fifty thousand
 * lines, never fifty thousand rewrites of one document. A line a crash cut short is skipped.
 *
 * Where a volume makes no hard links, a restore also holds the item's own name with an empty file
 * before it renames the copy over it (FG3g L4) — and that empty file is recorded too, before the
 * rename (FG3g review F1.1, FG3h D): a kill in between left a 0-byte file at the person's own name
 * that nothing ever removed. A held name is removed only while it is still that same file and still
 * empty, and its record is settled (a line saying so) once the file is in place over it.
 *
 * Each record names the process that wrote it (FG3h D): the "never while a restore runs" guard is
 * this process's own, and a second TreeMap on the same app data (the MCP server beside the app) could
 * otherwise sweep a temporary file the first is still writing. A record of a process still running
 * is left for a later start. The journal is shared by such processes but its tidying is not
 * coordinated between them: one process's tidying can drop a line another appended in the same
 * instant. That costs at most a leftover nothing sweeps — never a removal, since every removal is of
 * a recorded file still standing as it was made, by a process that has ended.
 */

const JOURNAL = 'restore-leftovers.jsonl';

/**
 * The only names a record may name: those `partialNameFor` gives. The journal is a file in app-data,
 * and the sweep removes what it names — so a record for any other name (planted, or garbled) is
 * never acted on, however its identity reads.
 */
const PARTIAL_NAME = /^\.treemap-restore-[0-9a-f]{8}$/;

interface Made {
  path: string;
  /** `dev:ino`, as copyWithHash read it from the file it had just made. */
  id: string;
  /** An empty file holding an item's own name for a rename (FG3g review F1.1); absent for a temporary copy. */
  kind?: 'placeholder';
  /** The process that recorded it (FG3h D); absent in records written before. */
  pid?: number;
}

/** A line saying a held name's placement finished: the record of that path and file is settled. */
interface Settled {
  path: string;
  id: string;
  settled: true;
}

/** Every change to the journal, one at a time. */
const lock = new AsyncMutex();
/** Restore jobs under way in this process: the start-up sweep and the compaction wait for none. */
let restoresRunning = 0;

function journalPath(): string {
  return path.join(appDataDir(), JOURNAL);
}

/**
 * Records a restore's temporary file before anything is written into it. Never throws: the record is
 * what lets a later start tidy up after a crash, and a restore is never refused for want of it.
 */
export async function recordRestorePartial(partial: string, identity: string): Promise<void> {
  await append({ path: partial, id: identity, pid: process.pid });
}

/**
 * What a restore passes to `placeWithoutClobber` for `dest` (FG3g review F1.1): the empty file held
 * at the item's own name is recorded before the rename, and settled once the file is in place over
 * it. Never throws, as `recordRestorePartial`.
 */
export function restorePlacementHooks(dest: string): Required<PlacementHooks> {
  return {
    onHeld: (identity) => append({ path: dest, id: identity, kind: 'placeholder', pid: process.pid }),
    onPlacedOverHeld: (identity) => append({ path: dest, id: identity, settled: true }),
  };
}

/** Appends one line. Never throws: a restore is never refused for want of its record. */
async function append(line: Made | Settled): Promise<void> {
  if (isEphemeral()) return;
  await lock.run(async () => {
    try {
      await fsp.mkdir(appDataDir(), { recursive: true });
      await fsp.appendFile(journalPath(), `${JSON.stringify(line)}\n`, 'utf8');
    } catch (err) {
      console.error('[treemap] a restore\'s temporary file could not be recorded for the sweep after a crash:', err);
    }
  });
}

/** Runs one restore job; when the last one running ends, the records whose file is gone are dropped. */
export async function whileRestoring<T>(fn: () => Promise<T>): Promise<T> {
  restoresRunning++;
  try {
    return await fn();
  } finally {
    restoresRunning--;
    if (restoresRunning === 0) {
      await compact().catch((err: unknown) => {
        console.error('[treemap] the record of restores\' temporary files could not be tidied:', err);
      });
    }
  }
}

/**
 * What the journal records, skipping any line that is not a whole record of a name TreeMap gives —
 * a temporary copy's `.treemap-restore-…` name, or (for a held name) a full path spelled as TreeMap
 * records one, outside the system folders it never writes — and every record a later line settled.
 */
async function readJournal(): Promise<Made[]> {
  let text: string;
  try {
    text = await fsp.readFile(journalPath(), 'utf8');
  } catch (err) {
    if (meansAbsent(err)) return [];
    throw err;
  }
  const lines: (Made | Settled)[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record: Partial<Made & Settled>;
    try {
      record = JSON.parse(line) as Partial<Made & Settled>;
    } catch {
      continue; // A line a crash cut short: nothing can be told of it.
    }
    if (record === null || typeof record !== 'object' || typeof record.path !== 'string' || typeof record.id !== 'string') continue;
    const { path: at, id } = record;
    if (record.settled === true) {
      lines.push({ path: at, id, settled: true });
      continue;
    }
    const placeholder = record.kind === 'placeholder';
    if (!path.isAbsolute(at) || !(placeholder ? isRecordablePlace(at) : PARTIAL_NAME.test(path.basename(at)))) continue;
    lines.push({
      path: at, id,
      ...(placeholder ? { kind: 'placeholder' as const } : {}),
      ...(Number.isInteger(record.pid) && (record.pid as number) > 0 ? { pid: record.pid } : {}),
    });
  }
  return pendingRecords(lines);
}

/** Whether a journal line settles the records before it, rather than recording a file. */
function isSettled(line: Made | Settled): line is Settled {
  return (line as Partial<Settled>).settled === true;
}

/**
 * The records among `lines` that no later line settled, in order: a settled line drops every earlier
 * record of the same place and file — never another file at that place, nor a record after it.
 *
 * In one pass, each record found by its place and file (FG3g review F2.4): each settled line scanned
 * every record before it, so the journal one restore of fifty thousand files leaves on a volume
 * without hard links (three lines a file) took seconds of the event loop to read — at the end of the
 * job and at the next start.
 */
export function pendingRecords(lines: readonly (Made | Settled)[]): Made[] {
  const made: (Made | null)[] = [];
  /** Where in `made` the records not yet settled are, by place and file. */
  const open = new Map<string, number[]>();
  for (const line of lines) {
    const key = `${line.path}\0${line.id}`;
    if (isSettled(line)) {
      for (const i of open.get(key) ?? []) made[i] = null;
      open.delete(key);
      continue;
    }
    const at = open.get(key);
    if (at === undefined) open.set(key, [made.length]);
    else at.push(made.length);
    made.push(line);
  }
  return made.filter((record): record is Made => record !== null);
}

/** Whether `at` is spelled as TreeMap records a place it restores to, and not a system folder it never writes. */
function isRecordablePlace(at: string): boolean {
  try {
    return sanitizePath(at) === at;
  } catch (err) {
    if (err instanceof PathRejectedError) return false;
    throw err;
  }
}

/** Whether the process `pid` is running now (one TreeMap cannot signal still counts as running). */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The journal as `made`, replaced whole (tmp + rename), or removed when nothing is left in it. */
async function writeJournal(made: Made[]): Promise<void> {
  if (made.length === 0) {
    await fsp.rm(journalPath(), { force: true });
    return;
  }
  const tmp = `${journalPath()}.tmp`;
  await fsp.writeFile(tmp, made.map((m) => `${JSON.stringify(m)}\n`).join(''), 'utf8');
  await fsp.rename(tmp, journalPath());
}

/**
 * What stands at a recorded name now: the file that was made, nothing, something else, or unknown. A
 * held name is the file that was made only while it is also still empty: one written into since is
 * not the restore's to remove.
 */
async function standing(record: Made): Promise<'made' | 'absent' | 'other' | { unknown: string }> {
  try {
    const st = await fsp.lstat(record.path, { bigint: true });
    const same = st.isFile() && `${st.dev}:${st.ino}` === record.id && (record.kind !== 'placeholder' || st.size === 0n);
    return same ? 'made' : 'other';
  } catch (err) {
    return meansAbsent(err) ? 'absent' : { unknown: describeFsError(err) };
  }
}

/** Drops the records of files that are gone or are something else now; the rest stay for the sweep. */
async function compact(): Promise<void> {
  if (isEphemeral()) return;
  await lock.run(async () => {
    if (restoresRunning > 0) return; // one began meanwhile: its records are not settled
    const records = await readJournal();
    if (records.length === 0) return writeJournal([]);
    const kept: Made[] = [];
    for (const record of records) {
      const now = await standing(record);
      if (now === 'made' || typeof now === 'object') kept.push(record);
    }
    await writeJournal(kept);
  });
}

/**
 * At start: removes the temporary files restores left — only names recorded here, and only while
 * each is still the file it was made as. Never while a restore is under way in this process, and
 * never a record of another process still running (FG3h D): kept for a later start. A name whose
 * place cannot be looked at keeps its record for a later start; one that is something else now is
 * left alone, and its record dropped.
 */
export async function sweepRestoreLeftovers(): Promise<{ removed: string[]; kept: { path: string; why: string }[] }> {
  if (isEphemeral()) return { removed: [], kept: [] };
  return lock.run(async () => {
    const removed: string[] = [];
    const kept: { path: string; why: string }[] = [];
    if (restoresRunning > 0) return { removed, kept };
    const stay: Made[] = [];
    for (const record of await readJournal()) {
      const now = await standing(record);
      if (now === 'absent') continue;
      if (now === 'made' && record.pid !== undefined && record.pid !== process.pid && isRunning(record.pid)) {
        kept.push({ path: record.path, why: 'the TreeMap that recorded it is still running, and may still be restoring it' });
        stay.push(record);
        continue;
      }
      if (now === 'other') {
        kept.push({ path: record.path, why: 'something else stands at that name now' });
        continue;
      }
      if (typeof now === 'object') {
        kept.push({ path: record.path, why: `it could not be looked at (${now.unknown})` });
        stay.push(record);
        continue;
      }
      try {
        await fsp.rm(record.path);
        removed.push(record.path);
      } catch (err) {
        kept.push({ path: record.path, why: describeFsError(err) });
        stay.push(record);
      }
    }
    await writeJournal(stay);
    return { removed, kept };
  });
}

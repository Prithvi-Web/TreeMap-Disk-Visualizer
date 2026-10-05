import { promises as fsp } from 'fs';
import path from 'path';
import { appDataDir } from './storage';
import { isEphemeral } from './portableMode';
import { AsyncMutex } from '../utils/asyncMutex';
import { describeFsError, meansAbsent } from '../utils/errno';

/**
 * Restore leftovers (FG3g L4).
 *
 * A restore — of a Time Capsule copy or of an offloaded file — writes each file beside its name under
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
  if (isEphemeral()) return;
  await lock.run(async () => {
    try {
      await fsp.mkdir(appDataDir(), { recursive: true });
      await fsp.appendFile(journalPath(), `${JSON.stringify({ path: partial, id: identity } satisfies Made)}\n`, 'utf8');
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

/** What the journal records, skipping any line that is not a whole record. */
async function readJournal(): Promise<Made[]> {
  let text: string;
  try {
    text = await fsp.readFile(journalPath(), 'utf8');
  } catch (err) {
    if (meansAbsent(err)) return [];
    throw err;
  }
  const made: Made[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const record = JSON.parse(line) as Partial<Made>;
      if (typeof record.path === 'string' && path.isAbsolute(record.path) && PARTIAL_NAME.test(path.basename(record.path)) && typeof record.id === 'string') {
        made.push({ path: record.path, id: record.id });
      }
    } catch {
      // A line a crash cut short: nothing can be told of it.
    }
  }
  return made;
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

/** What stands at a recorded name now: the file that was made, nothing, something else, or unknown. */
async function standing(record: Made): Promise<'made' | 'absent' | 'other' | { unknown: string }> {
  try {
    const st = await fsp.lstat(record.path, { bigint: true });
    return st.isFile() && `${st.dev}:${st.ino}` === record.id ? 'made' : 'other';
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
 * each is still the file it was made as. Never while a restore is under way in this process. A name
 * whose place cannot be looked at keeps its record for a later start; one that is something else
 * now is left alone, and its record dropped.
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

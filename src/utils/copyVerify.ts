import fs, { promises as fsp } from 'fs';
import type { FileHandle } from 'fs/promises';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import path from 'path';
import { identityOf, UNKNOWN } from './placeIdentity';
import { describeFsError, meansAbsent } from './errno';

/**
 * copyVerify — the copy-and-fingerprint primitive shared by every feature that
 * moves user data before deleting it (Offload, Time Capsule).
 *
 * There is exactly one implementation on purpose. Both callers depend on the
 * same four properties, and a second copy of this logic is the kind of thing
 * that drifts silently until one path loses a guarantee the other kept:
 *
 *  - **Never clobber.** Writes open with 'wx', so an existing destination is an
 *    error rather than a silent overwrite. Any feature that needs to replace
 *    something must remove it deliberately first.
 *  - **The hash is of the bytes that actually flowed**, taken during the copy
 *    rather than by re-reading the source afterwards — a source that changes
 *    mid-copy is then caught by the read-back verify instead of being
 *    fingerprinted twice and agreeing with itself.
 *  - **Cancellation is cooperative and immediate**: the reader is destroyed on
 *    the next chunk, so a cancelled job stops within one chunk rather than at
 *    the end of the file.
 *  - **A copy that does not finish leaves nothing it made** (FG3d #1). The
 *    destination is the copy's own from the moment its exclusive open succeeds,
 *    and a copy that fails or is cancelled after that removes it — by the
 *    identity it was made with, so a file put at that name since is never taken
 *    for it, and one that was there first (EEXIST) is never touched. Left behind,
 *    a part-copied file stood at a restore's original place: every retry was
 *    refused as occupied, and the cancelled restore said nothing was left. A
 *    removal that fails is thrown as `CopyLeftBehind`, naming what is left, so
 *    no caller says "nothing was left" of it.
 */

/** Progress and cancellation hooks; both optional, both called per chunk. */
export interface CopyProgress {
  /** Bytes read since the previous call. */
  onBytes?: (n: number) => void;
  /** Return true to abort; the pipeline then rejects with `CopyCancelled`. */
  isCancelled?: () => boolean;
}

export class CopyCancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CopyCancelled';
  }
}

/**
 * A copy that did not finish, whose part-copied destination could not be removed (FG3d #1). Thrown
 * in place of the copy's own error, which it carries as `cause` — a cancel included, so a caller
 * that reads `CopyCancelled` as "rolled back, nothing left" never says so of this one.
 */
export class CopyLeftBehind extends Error {
  /**
   * `made` says what is left at `dest`: the part of a copy, or (FG3g review F1.1) the empty file a
   * placement held at an item's own name for its rename.
   */
  constructor(readonly dest: string, readonly why: string, cause: unknown, made: 'part' | 'held' = 'part') {
    super(`${cause instanceof CopyCancelled ? 'It was cancelled' : cause instanceof Error ? cause.message : String(cause)}, ` +
      `and ${made === 'held' ? 'the empty file held at' : 'the part already copied to'} ${dest} could not be removed (${why})`, { cause });
    this.name = 'CopyLeftBehind';
  }
}

/**
 * Remove the file a copy made at `dest`, if the disk still shows that same file there (`made`, its
 * device and id). Answers null when nothing of the copy's is left there, or why it could not be
 * removed. A file another put at that name since is not the copy's, and stays.
 */
async function removeMade(dest: string, made: string | null): Promise<string | null> {
  const now = await identityOf(dest);
  if (typeof now !== 'string') return now === UNKNOWN ? 'its place could not be looked at' : null;
  if (made === null) return 'what the copy made there could not be told from anything else';
  if (now !== made) return null;
  return fsp.rm(dest, { force: true }).then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err)));
}

/**
 * Test-only: a fault part-way through a copy (FG3d #1). Called once per chunk read, with the
 * destination and the bytes read so far; an Error it returns fails the copy there, as a disk that
 * stops answering part-way would. No test can make a real read fail after N bytes on every OS, and
 * what it proves — a copy that does not finish leaves nothing it made — is about exactly that
 * moment. The suite's ForTests idiom: returns the function that removes it.
 */
let copyFaultForTests: ((dest: string, bytesRead: number) => Error | null) | null = null;
export function setCopyFaultForTests(fault: (dest: string, bytesRead: number) => Error | null): () => void {
  copyFaultForTests = fault;
  return () => { copyFaultForTests = null; };
}

/** A copy stopped because its source made no progress for the whole stall limit (FG3g M2). */
export class CopyStalled extends Error {
  constructor(readonly src: string, readonly stallMs: number) {
    super(`reading ${src} made no progress for ${Math.round(stallMs / 1000)} seconds, so the copy was stopped`);
    this.name = 'CopyStalled';
  }
}

/** Arms a timer that calls `onExpire` after `ms`, answering the function that disarms it. */
export type StallTimer = (ms: number, onExpire: () => void) => () => void;

/**
 * Test-only: the timer a copy's stall limit is judged by (FG3g M2), so a test fires "the limit passed
 * with no progress" itself rather than waiting on a clock. The suite's ForTests idiom: returns the
 * function that removes it.
 */
let stallTimerForTests: StallTimer | null = null;
export function setStallTimerForTests(timer: StallTimer): () => void {
  stallTimerForTests = timer;
  return () => { stallTimerForTests = null; };
}

/**
 * File-system calls a caller stopped waiting for at their stall limit that have not returned yet
 * (FG3h A). Such a call cannot be interrupted: it holds a worker thread of the pool every file call
 * shares (and often a handle) until the volume answers, so a few of them left waiting starve every
 * later file call in the process. Counted here so a caller can stop starting more (`abandonedCallsUnsettled`).
 */
let abandonedUnsettled = 0;

/** How many calls left waiting at their stall limit have not returned yet (FG3h A). */
export function abandonedCallsUnsettled(): number {
  return abandonedUnsettled;
}

/** Counts `work` as abandoned until it settles. */
function countAbandoned(work: Promise<unknown>): void {
  abandonedUnsettled++;
  let counted = true;
  const settle = (): void => {
    if (!counted) return;
    counted = false;
    abandonedUnsettled--;
  };
  work.then(settle, settle);
}

/**
 * `work`'s outcome — or, once `stallMs` passes before it settles, `onStall`'s (its value, or what it
 * throws), judged by the same timer as a copy's stall limit (FG3h A, FG3g review F1.2). The work
 * cannot be stopped and goes on unawaited, counted in `abandonedCallsUnsettled` until it settles —
 * unless `counted` is false, for a caller that bounds the calls it leaves waiting itself (FG3g review
 * F3.3: the Offloaded tab's look, one per drive). The count is what stops the Time Capsule starting
 * copies, so a look a person can repeat by opening a tab must not add to it.
 */
export async function withinStallLimit<T>(work: Promise<T>, stallMs: number, onStall: () => T, opts: { counted?: boolean } = {}): Promise<T> {
  let disarm = (): void => {};
  const expired = new Promise<T>((resolve, reject) => {
    disarm = (stallTimerForTests ?? realStallTimer)(stallMs, () => {
      if (opts.counted !== false) countAbandoned(work);
      try {
        resolve(onStall());
      } catch (err) {
        reject(err);
      }
    });
  });
  work.catch(() => {}); // answered below, or — once the limit passed — no longer waited for
  try {
    return await Promise.race([work, expired]);
  } finally {
    disarm();
  }
}

/** Options of one copy. */
export interface CopyOptions {
  /** Stop the copy (CopyStalled) when its source makes no progress for this long (FG3g M2). */
  stallMs?: number;
  /**
   * Awaited with the file the copy has just made at `dest` (`dev:ino`), before any byte is written
   * into it (FG3g L4): a restore records its temporary file there, so a later start can remove one
   * a kill left — and only that file.
   */
  onCreated?: (identity: string) => Promise<void>;
}

/**
 * Copy `src` → `dest`, returning the SHA-256 of the bytes that flowed through.
 * The destination must not already exist. A copy that does not finish leaves
 * nothing it made at `dest`, or throws `CopyLeftBehind` saying what it left.
 */
export async function copyWithHash(src: string, dest: string, progress?: CopyProgress, options: CopyOptions = {}): Promise<string> {
  const { stallMs } = options;
  if (stallMs === undefined) return copyOnce(src, dest, progress, () => false, options.onCreated);
  // The stall limit (FG3g M2). A read that never answers cannot be interrupted — the file system call
  // waits in a worker thread, and even destroying the stream waits for it — so the copy is answered
  // at once, as stalled, and its own work stops (removing what it made) whenever that read returns.
  // Checked once per limit rather than reset per chunk: a stall is seen between one and two limits in.
  let stalled = false;
  let progressed = false;
  let answerStalled!: (err: CopyStalled) => void;
  const expired = new Promise<never>((_, reject) => { answerStalled = reject; });
  const timer = stallTimerForTests ?? realStallTimer;
  let disarm = (): void => {};
  let copying: Promise<string> | null = null;
  const arm = (): void => {
    disarm = timer(stallMs, () => {
      if (progressed) {
        progressed = false;
        arm();
        return;
      }
      stalled = true;
      // Its read is left waiting in a worker thread until the volume answers (FG3h A).
      if (copying !== null) countAbandoned(copying);
      answerStalled(new CopyStalled(src, stallMs));
    });
  };
  arm();
  copying = copyOnce(src, dest, {
    onBytes: (n) => {
      progressed = true;
      progress?.onBytes?.(n);
    },
    isCancelled: () => stalled || (progress?.isCancelled?.() ?? false),
  }, () => stalled, options.onCreated);
  copying.catch(() => {}); // answered below, or — once stalled — no longer waited for
  try {
    return await Promise.race([copying, expired]);
  } finally {
    disarm();
  }
}

/** The real stall timer: never keeps the process alive on its own. */
const realStallTimer: StallTimer = (ms, onExpire) => {
  const handle = setTimeout(onExpire, ms);
  handle.unref();
  return () => clearTimeout(handle);
};

/**
 * One copy. `abandoned` answers true once the caller has stopped waiting for it (a stall): from then
 * on it makes nothing more, and removes what it made, as a failed copy does.
 */
async function copyOnce(
  src: string,
  dest: string,
  progress: CopyProgress | undefined,
  abandoned: () => boolean,
  onCreated?: (identity: string) => Promise<void>,
): Promise<string> {
  // The source first, so a copy that cannot read its source makes nothing at all.
  const input = await fsp.open(src, 'r');
  if (abandoned()) {
    await input.close().catch(() => {});
    throw new CopyCancelled();
  }
  let output: FileHandle;
  try {
    output = await fsp.open(dest, 'wx'); // never clobber: on EEXIST what stands there is not this copy's
  } catch (err) {
    await input.close().catch(() => {});
    throw err;
  }
  let made: string | null = null;
  try {
    const st = await output.stat({ bigint: true });
    made = `${st.dev}:${st.ino}`;
    if (onCreated) await onCreated(made);
    if (abandoned()) throw new CopyCancelled();
    const hash = crypto.createHash('sha256');
    const reader = input.createReadStream();
    const writer = output.createWriteStream();
    let bytesRead = 0;
    reader.on('data', (chunk: string | Buffer) => {
      hash.update(chunk);
      bytesRead += chunk.length;
      progress?.onBytes?.(chunk.length);
      const fault = copyFaultForTests?.(dest, bytesRead) ?? null;
      if (fault) reader.destroy(fault);
      else if (progress?.isCancelled?.()) reader.destroy(new CopyCancelled());
    });
    await pipeline(reader, writer);
    // A read that returned only after the copy was abandoned (an end of file, say) is not a copy.
    if (abandoned()) throw new CopyCancelled();
    return hash.digest('hex');
  } catch (err) {
    // Both handles are closed first, so nothing of this copy's still holds the file it removes.
    await Promise.all([input.close(), output.close()].map((closing) => closing.catch(() => {})));
    const left = await removeMade(dest, made);
    if (left !== null) throw new CopyLeftBehind(dest, left, err);
    throw err;
  }
}

/**
 * A name beside `dest` for a restore's copy that is not complete yet (FG3f #8). A restore copied
 * straight to the item's own name, so a quit or a kill part-way left a part-copied file there — one
 * that looks like the person's file and is not. Short and fixed rather than built from the name, so
 * a name already near the volume's limit still fits; plainly TreeMap's.
 */
export function partialNameFor(dest: string): string {
  return path.join(path.dirname(dest), `.treemap-restore-${crypto.randomUUID().slice(0, 8)}`);
}

/** Test-only: the hard link `placeWithoutClobber` makes, as a volume without them refuses it. */
let hardLinkForTests: ((existing: string, link: string) => Promise<void>) | null = null;
export function setHardLinkForTests(fn: (existing: string, link: string) => Promise<void>): () => void {
  hardLinkForTests = fn;
  return () => { hardLinkForTests = null; };
}

/**
 * Test-only: called with `dest` right before a volume without hard links has the file renamed into
 * place (FG3g L4), so a test can put something at the name in that moment. The suite's ForTests
 * idiom: returns the function that removes it.
 */
let beforeRenameIntoPlaceForTests: ((dest: string) => void) | null = null;
export function setBeforeRenameIntoPlaceForTests(fn: (dest: string) => void): () => void {
  beforeRenameIntoPlaceForTests = fn;
  return () => { beforeRenameIntoPlaceForTests = null; };
}

/** What a placement tells its caller about the empty file it holds at a name (FG3g review F1.1). */
export interface PlacementHooks {
  /** Awaited with the held file's `dev:ino` once it is made, before the rename: a restore records it. */
  onHeld?: (identity: string) => Promise<void>;
  /** Awaited with the same identity once the file is in place over it: a restore settles that record. */
  onPlacedOverHeld?: (identity: string) => Promise<void>;
}

/**
 * Put the complete, verified file at `partial` at `dest`, never over anything (FG3f #8). A hard
 * link is made at `dest` — which fails with EEXIST if anything stands there, in one step — and the
 * partial name is then dropped. Where the volume makes no hard links (FAT, exFAT, some network
 * shares), the file is renamed into a name held for it (`renameIntoHeldName`). Throws EEXIST when
 * something stands at `dest`, leaving the partial for the caller to remove — or `CopyLeftBehind`
 * naming `dest` when the empty file it held there could not be removed or looked at.
 *
 * Answers `partialLeft`: why the partial name could not be dropped once the file was in place, or
 * null (FG3g L4). It is a second name for the restored file, never a wrong file — but it is the
 * restore's to remove, and one it forgets was left at the item's place for good: a rollback did not
 * remove it and a retry found the place occupied with no word of why.
 */
export async function placeWithoutClobber(partial: string, dest: string, hooks: PlacementHooks = {}): Promise<{ partialLeft: string | null }> {
  try {
    await (hardLinkForTests ?? ((a: string, b: string) => fsp.link(a, b)))(partial, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw err;
    await renameIntoHeldName(partial, dest, hooks);
    return { partialLeft: null };
  }
  const partialLeft = await fsp.rm(partial, { force: true }).then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err)));
  return { partialLeft };
}

/** The error a placement answers when something stands at its name. */
function standsThere(dest: string): Error {
  return Object.assign(new Error(`EEXIST: something already stands at ${dest}`), { code: 'EEXIST' });
}

/**
 * What stands at `at` now, against the empty file a placement held there (`id`): that file, still
 * empty (`held`); nothing (`absent`); anything else (`other`) — or `{ unknown }` when it could not
 * be looked at (FG3g review F1.1), which is none of those: read as "something else", a look that
 * failed for a moment (EIO, EACCES) was refused as EEXIST while the held file stayed at the name.
 */
async function heldAt(at: string, id: string): Promise<'held' | 'absent' | 'other' | { unknown: string }> {
  try {
    const st = await fsp.lstat(at, { bigint: true });
    return st.isFile() && st.size === 0n && `${st.dev}:${st.ino}` === id ? 'held' : 'other';
  } catch (err) {
    return meansAbsent(err) ? 'absent' : { unknown: describeFsError(err) };
  }
}

/** Removes the held file at `dest`, answering null or why it could not be removed. */
async function removeHeld(dest: string): Promise<string | null> {
  return fsp.rm(dest, { force: true }).then(() => null, (err: unknown) => describeFsError(err));
}

/**
 * Where the volume makes no hard links: a rename replaces whatever stands at a name, so the name is
 * held first — an empty file made there exclusively, which fails with EEXIST if anything stands
 * there — and the file is renamed over it only if that is still the same empty file right before
 * the rename (FG3g L4). The name used to be looked at and then renamed into, and a file that
 * appeared between the look and the rename was replaced. One written into the placeholder, or put in
 * its place, since is left as it is (EEXIST). Where nothing can be told apart — a volume whose file
 * ids are not stable — a write into the placeholder in the instant before the rename is the one
 * thing still replaced; a volume with hard links never takes this path.
 *
 * The held file is this placement's own until the rename (FG3g review F1.1): its caller is told of it
 * (`hooks.onHeld`, so a restore records it for the sweep after a kill), and a placement that does not
 * finish removes it while it is still that empty file — or, when it cannot be removed or looked at,
 * throws `CopyLeftBehind` naming it. A removal that failed was swallowed, and the person found an
 * empty file under their own name that nothing named, and a retry refused as occupied.
 */
async function renameIntoHeldName(partial: string, dest: string, hooks: PlacementHooks): Promise<void> {
  const held = await fsp.open(dest, 'wx');
  let id: string;
  try {
    const st = await held.stat({ bigint: true });
    id = `${st.dev}:${st.ino}`;
  } catch (err) {
    await held.close().catch(() => {});
    // Made here a moment ago and never told apart: removed rather than left at the person's name, or named.
    const why = await removeHeld(dest);
    if (why !== null) throw new CopyLeftBehind(dest, why, err, 'held');
    throw err;
  }
  await held.close().catch(() => {});
  await hooks.onHeld?.(id);
  beforeRenameIntoPlaceForTests?.(dest);
  const before = await heldAt(dest, id);
  if (before === 'absent' || before === 'other') throw standsThere(dest);
  if (before !== 'held') {
    throw new CopyLeftBehind(dest, 'it could not be told from anything put there since, so it was left as it is',
      new Error(`its place could not be looked at right before the file was put there (${before.unknown})`), 'held');
  }
  try {
    await fsp.rename(partial, dest);
  } catch (err) {
    // Removed while it is still the same empty file; named when it cannot be removed, or looked at.
    const now = await heldAt(dest, id);
    if (now === 'held') {
      const why = await removeHeld(dest);
      if (why !== null) throw new CopyLeftBehind(dest, why, err, 'held');
    } else if (now !== 'absent' && now !== 'other') {
      throw new CopyLeftBehind(dest, `it could not be looked at (${now.unknown})`, err, 'held');
    }
    throw err;
  }
  await hooks.onPlacedOverHeld?.(id);
}

/**
 * SHA-256 of a file already on disk — the read-back verify, and the integrity
 * re-check performed when restoring.
 */
export async function hashFile(filePath: string, progress?: CopyProgress): Promise<string> {
  const hash = crypto.createHash('sha256');
  const reader = fs.createReadStream(filePath);
  reader.on('data', (chunk: string | Buffer) => {
    hash.update(chunk);
    if (progress?.isCancelled?.()) reader.destroy(new CopyCancelled());
  });
  await new Promise<void>((resolve, reject) => {
    reader.on('end', resolve);
    reader.on('error', reject);
  });
  return hash.digest('hex');
}

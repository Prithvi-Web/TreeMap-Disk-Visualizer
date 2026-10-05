import fs, { promises as fsp } from 'fs';
import type { FileHandle } from 'fs/promises';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import path from 'path';
import { identityOf, UNKNOWN } from './placeIdentity';
import { meansAbsent } from './errno';

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
  constructor(readonly dest: string, readonly why: string, cause: unknown) {
    super(`${cause instanceof CopyCancelled ? 'It was cancelled' : cause instanceof Error ? cause.message : String(cause)}, ` +
      `and the part already copied to ${dest} could not be removed (${why})`, { cause });
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

/**
 * Copy `src` → `dest`, returning the SHA-256 of the bytes that flowed through.
 * The destination must not already exist. A copy that does not finish leaves
 * nothing it made at `dest`, or throws `CopyLeftBehind` saying what it left.
 */
export async function copyWithHash(src: string, dest: string, progress?: CopyProgress): Promise<string> {
  // The source first, so a copy that cannot read its source makes nothing at all.
  const input = await fsp.open(src, 'r');
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
 * Put the complete, verified file at `partial` at `dest`, never over anything (FG3f #8). A hard
 * link is made at `dest` — which fails with EEXIST if anything stands there, in one step — and the
 * partial name is then dropped. Where the volume makes no hard links (FAT, exFAT, some network
 * shares), `dest` is looked at and the file renamed there: a rename replaces what stands at a name,
 * so only a name seen empty is used. Throws EEXIST when something stands at `dest`, leaving the
 * partial for the caller to remove.
 */
export async function placeWithoutClobber(partial: string, dest: string): Promise<void> {
  try {
    await (hardLinkForTests ?? ((a: string, b: string) => fsp.link(a, b)))(partial, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw err;
    const taken = await fsp.lstat(dest).then(() => true, (look: unknown) => {
      if (meansAbsent(look)) return false;
      throw look;
    });
    if (taken) throw Object.assign(new Error(`EEXIST: something already stands at ${dest}`), { code: 'EEXIST' });
    await fsp.rename(partial, dest);
    return;
  }
  // In place under its own name: the partial name is a second name for the same file, and one left
  // behind is clutter, never a wrong file — so a failure here is logged, not thrown.
  await fsp.rm(partial, { force: true }).catch((err: unknown) => {
    console.error(`[treemap] a restored file is in place, but its temporary name ${partial} could not be removed:`, err);
  });
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

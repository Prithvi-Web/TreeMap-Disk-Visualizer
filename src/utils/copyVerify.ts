import fs from 'fs';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';

/**
 * copyVerify — the copy-and-fingerprint primitive shared by every feature that
 * moves user data before deleting it (Offload, Time Capsule).
 *
 * There is exactly one implementation on purpose. Both callers depend on the
 * same three properties, and a second copy of this logic is the kind of thing
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
 * Copy `src` → `dest`, returning the SHA-256 of the bytes that flowed through.
 * The destination must not already exist.
 */
export async function copyWithHash(src: string, dest: string, progress?: CopyProgress): Promise<string> {
  const hash = crypto.createHash('sha256');
  const reader = fs.createReadStream(src);
  const writer = fs.createWriteStream(dest, { flags: 'wx' }); // never clobber
  reader.on('data', (chunk: string | Buffer) => {
    hash.update(chunk);
    progress?.onBytes?.(chunk.length);
    if (progress?.isCancelled?.()) reader.destroy(new CopyCancelled());
  });
  await pipeline(reader, writer);
  return hash.digest('hex');
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

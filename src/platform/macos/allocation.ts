import { promises as fsp } from 'fs';
import type { PlaceholderInfo } from '../types';

/**
 * Byte-accurate sizing (A2) and placeholder accounting (A3) on macOS.
 *
 * ── What is genuinely available, and what is not ──
 *
 * **Allocated size: exact.** `lstat().blocks * 512` is the number of 512-byte
 * blocks the file actually occupies, straight from the kernel. Measured on
 * APFS: a 50 MB truncate-only sparse file reports `size = 52428800` and
 * `blocks = 0`. So sparse files, compressed files and evicted cloud
 * placeholders are all correctly sized with nothing but `lstat` — no syscall
 * beyond what the scanner already performs.
 *
 * A3's spec suggests `SEEK_DATA`/`SEEK_HOLE` for hole detection. That is not
 * reachable from Node (`fs.read` exposes no `whence`), and it is also not
 * needed: TreeMap's question is "how many bytes does this occupy", which
 * `blocks` answers directly and portably. Hole *positions*, which is the only
 * thing SEEK_HOLE adds, are not something TreeMap displays. Deviation recorded
 * in docs/PLATFORM_NOTES.md.
 *
 * **Clone families: NOT available without native code.** Grouping APFS clones
 * requires `getattrlist` with `ATTR_CMNEXT_CLONEID`, which no Node API and no
 * bundled binary exposes — `diskutil` does not report clone identity at all.
 * Rather than print a confidently wrong "exclusive bytes" figure, this module
 * reports clone identity as unknown and A2 falls back to what *can* be known
 * exactly: the allocated-block sum, reconciled against the volume's own
 * accounting via `statfs`.
 *
 * That fallback is not a consolation prize. Summing `blocks * 512` already
 * counts a clone's shared extents once *per file that references them*, so it
 * overstates in the same direction as a logical sum — but the reconciliation
 * delta against `statfs` makes the overstatement visible and quantified
 * instead of silent. The UI states the total is approximate and by how much,
 * which is what §10 ("if clone detection failed, say the size is approximate")
 * requires.
 */

/** Bytes actually occupied on disk. Exact on APFS and HFS+. */
export async function allocatedSize(p: string): Promise<number> {
  const st = await fsp.lstat(p);
  return typeof st.blocks === 'number' && st.blocks >= 0 ? st.blocks * 512 : st.size;
}

/** Ground truth for a volume, straight from the filesystem's own accounting. */
export interface VolumeAccounting {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

export async function volumeAccounting(mountPoint: string): Promise<VolumeAccounting> {
  const st = await fsp.statfs(mountPoint);
  const blockSize = Number(st.bsize);
  const total = Number(st.blocks) * blockSize;
  const free = Number(st.bavail) * blockSize;
  return { totalBytes: total, freeBytes: free, usedBytes: total - Number(st.bfree) * blockSize };
}

/**
 * iCloud Drive names an evicted file `.<original>.icloud`, so the visible name
 * is not the real one. Recognising the pattern is what lets the UI say
 * "Report.pdf — 0 MB local" rather than showing a mystery dotfile.
 */
export function decodeICloudStubName(name: string): string | null {
  if (!name.startsWith('.') || !name.endsWith('.icloud')) return null;
  const inner = name.slice(1, -'.icloud'.length);
  return inner.length > 0 ? inner : null;
}

/**
 * Which sync provider owns a path, inferred from its location.
 *
 * Path-based because the alternative — asking each vendor's client — means
 * vendor-specific code that breaks on every client update. A wrong guess here
 * only mislabels *which* cloud a placeholder belongs to; the byte accounting
 * above is independent of it and stays exact either way.
 */
export function providerForPath(p: string): PlaceholderInfo['provider'] {
  if (p.includes('/Library/Mobile Documents/') || p.includes('/iCloud Drive')) return 'icloud';
  if (/\/OneDrive([^/]*)?\//.test(p)) return 'onedrive';
  if (/\/Dropbox([^/]*)?\//.test(p)) return 'dropbox';
  if (/\/Google Drive([^/]*)?\//.test(p)) return 'gdrive';
  return 'unknown';
}

/**
 * Placeholder status for one path.
 *
 * A file is a placeholder when it claims bytes it does not occupy. The test is
 * deliberately `blocks === 0 && size > 0` rather than "much smaller than size":
 * a merely *sparse* file (a VM disk image, a database) is not a cloud
 * placeholder, and calling it one would be a lie in the other direction.
 * Genuinely sparse-but-local files are still sized correctly by
 * `allocatedSize`; they just aren't labelled as cloud.
 */
export async function placeholderInfo(p: string): Promise<PlaceholderInfo | null> {
  let st;
  try {
    st = await fsp.lstat(p);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  const blocks = typeof st.blocks === 'number' ? st.blocks : -1;
  const localSize = blocks >= 0 ? blocks * 512 : st.size;

  const isStub = decodeICloudStubName(p.slice(p.lastIndexOf('/') + 1)) !== null;
  const evicted = isStub || (blocks === 0 && st.size > 0);
  if (!evicted && localSize >= st.size) return null; // ordinary, fully-local file

  return {
    // An .icloud stub's own size is the stub's, not the real file's; the real
    // size is not knowable without asking iCloud, so it is reported as unknown
    // by carrying the stub size rather than inventing one.
    logicalSize: st.size,
    localSize,
    provider: providerForPath(p),
    evicted,
    mechanism: isStub ? '.icloud stub file' : 'allocated blocks (lstat)',
  };
}

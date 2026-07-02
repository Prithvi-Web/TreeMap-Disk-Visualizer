import { promises as fsp } from 'fs';
import fs from 'fs';
import zlib from 'zlib';

/**
 * archive — pure directory-listing parsers for the container drill-down.
 * Nothing here ever extracts file contents: zip reads only the central
 * directory at the end of the file, tar walks 512-byte entry headers
 * (decompressing just enough of a .tar.gz to reach each header).
 */

export interface ArchiveEntry {
  /** Entry path inside the archive, '/'-separated, no leading slash. */
  path: string;
  /** Uncompressed size in bytes (0 for directories). */
  size: number;
  dir: boolean;
}

export interface ArchiveListing {
  entries: ArchiveEntry[];
  /** True when caps stopped the walk before the end. */
  truncated: boolean;
}

export const MAX_ENTRIES = 20_000;

/* ---------------- ZIP: central directory only ---------------- */

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;
/** EOCD must live in the last 64 KB + 22 bytes of the file. */
const EOCD_SEARCH = 65_557;

/** Parse a zip central directory buffer into entries. Exported for tests. */
export function parseZipCentralDirectory(cd: Buffer, entryCount: number): ArchiveListing {
  const entries: ArchiveEntry[] = [];
  let off = 0;
  let truncated = false;
  for (let i = 0; i < entryCount && off + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(off) !== CEN_SIG) break; // corrupt — stop honestly
    let size = cd.readUInt32LE(off + 24); // uncompressed
    const nameLen = cd.readUInt16LE(off + 28);
    const extraLen = cd.readUInt16LE(off + 30);
    const commentLen = cd.readUInt16LE(off + 32);
    const name = cd.subarray(off + 46, off + 46 + nameLen).toString('utf8');

    // ZIP64: a 0xFFFFFFFF size lives in the 0x0001 extra field instead.
    if (size === 0xffffffff) {
      let e = off + 46 + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001 && len >= 8) {
          size = Number(cd.readBigUInt64LE(e + 4));
          break;
        }
        e += 4 + len;
      }
    }

    const cleanName = name.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (cleanName && cleanName !== '.' && !name.includes('\0')) {
      entries.push({ path: cleanName, size, dir: name.endsWith('/') });
    }
    off += 46 + nameLen + extraLen + commentLen;
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
  }
  return { entries, truncated };
}

/** List a .zip/.jar via its central directory — never extracts anything. */
export async function listZip(filePath: string): Promise<ArchiveListing> {
  const fd = await fsp.open(filePath, 'r');
  try {
    const { size: fileSize } = await fd.stat();
    const tailLen = Math.min(EOCD_SEARCH, fileSize);
    const tail = Buffer.alloc(tailLen);
    await fd.read(tail, 0, tailLen, fileSize - tailLen);

    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip archive (no end-of-central-directory record)');

    let entryCount = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    // ZIP64 archives park 0xFFFF/0xFFFFFFFF here and use a 64-bit EOCD.
    if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locAt = eocd - 20;
      if (locAt >= 0 && tail.readUInt32LE(locAt) === EOCD64_LOCATOR_SIG) {
        const eocd64Off = Number(tail.readBigUInt64LE(locAt + 8));
        const e64 = Buffer.alloc(56);
        await fd.read(e64, 0, 56, eocd64Off);
        if (e64.readUInt32LE(0) === EOCD64_SIG) {
          entryCount = Number(e64.readBigUInt64LE(32));
          cdSize = Number(e64.readBigUInt64LE(40));
          cdOffset = Number(e64.readBigUInt64LE(48));
        }
      }
    }

    const cd = Buffer.alloc(Math.min(cdSize, 64 * 1024 * 1024)); // 64 MB of directory ≈ hundreds of thousands of entries
    await fd.read(cd, 0, cd.length, cdOffset);
    return parseZipCentralDirectory(cd, Math.min(entryCount, MAX_ENTRIES + 1));
  } finally {
    await fd.close();
  }
}

/* ---------------- TAR: 512-byte entry headers ---------------- */

/** Cap on bytes walked (decompressed for .tar.gz) so a huge tarball can't spin forever. */
const TAR_MAX_WALK = 8 * 1024 ** 3;

function parseOctal(buf: Buffer, off: number, len: number): number {
  const s = buf.subarray(off, off + len).toString('ascii').replace(/\0.*$/, '').trim();
  if (!s) return 0;
  // GNU base-256 extension for sizes > 8 GB.
  if (buf[off] & 0x80) {
    let v = 0;
    for (let i = 0; i < len; i++) v = v * 256 + (i === 0 ? buf[off] & 0x7f : buf[off + i]);
    return v;
  }
  return parseInt(s, 8) || 0;
}

/**
 * Incremental tar header parser: feed it chunks, it collects entries while
 * skipping file data. Exported for tests (feed crafted 512-byte blocks).
 */
export class TarWalker {
  entries: ArchiveEntry[] = [];
  truncated = false;
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private skip = 0; // data bytes (incl. padding) left to skip
  private longName: string | null = null;
  private paxPath: string | null = null;
  private paxSize: number | null = null;
  private collect: { kind: 'L' | 'x'; left: number; chunks: Buffer[] } | null = null;

  write(chunk: Buffer): void {
    if (this.truncated) return;
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let off = 0;
    while (this.pending.length - off >= 512) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, this.pending.length - off);
        const usable = Math.floor(n / 512) * 512;
        if (usable === 0) break;
        if (this.collect) {
          this.collect.chunks.push(this.pending.subarray(off, off + Math.min(usable, this.collect.left)));
          this.collect.left -= usable;
          if (this.collect.left <= 0) this.finishCollect();
        }
        this.skip -= usable;
        off += usable;
        continue;
      }
      const block = this.pending.subarray(off, off + 512);
      off += 512;
      if (block.every((b) => b === 0)) continue; // end-of-archive padding

      const type = String.fromCharCode(block[156] || 0x30);
      const size = parseOctal(block, 124, 12);
      const dataBlocks = Math.ceil(size / 512) * 512;

      if (type === 'L' || type === 'x') {
        // GNU longname / pax header: capture its data for the NEXT entry.
        this.collect = { kind: type, left: size, chunks: [] };
        this.skip = dataBlocks;
        if (this.skip === 0) this.finishCollect();
        continue;
      }
      if (type === 'g') { this.skip = dataBlocks; continue; } // global pax — ignore

      let name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
      const prefix = block.subarray(345, 345 + 155).toString('utf8').replace(/\0.*$/, '');
      if (prefix) name = prefix + '/' + name;
      if (this.longName) { name = this.longName; this.longName = null; }
      if (this.paxPath) { name = this.paxPath; this.paxPath = null; }
      let entrySize = size;
      if (this.paxSize !== null) { entrySize = this.paxSize; this.paxSize = null; }

      const isDir = type === '5' || name.endsWith('/');
      // bsd tar writes "./"-prefixed entries; the archive root itself ('.')
      // is not an entry worth listing.
      const clean = name.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
      // '._.' is AppleDouble metadata for the archive root — an artifact,
      // not content (entries like '._file' are kept: they are real bytes).
      if (clean && clean !== '.' && clean !== '._.' && (type === '0' || type === '\0'.charAt(0) || type === '5' || type === '7')) {
        this.entries.push({ path: clean, size: isDir ? 0 : entrySize, dir: isDir });
        if (this.entries.length >= MAX_ENTRIES) { this.truncated = true; break; }
      }
      this.skip = isDir ? 0 : dataBlocks;
    }
    // Copy the remainder: subarray would pin the whole incoming chunk alive.
    this.pending = Buffer.from(this.pending.subarray(off));
  }

  private finishCollect(): void {
    if (!this.collect) return;
    const data = Buffer.concat(this.collect.chunks).toString('utf8');
    if (this.collect.kind === 'L') {
      this.longName = data.replace(/\0.*$/, '');
    } else {
      // pax: length key=value\n records
      for (const line of data.split('\n')) {
        const sp = line.indexOf(' ');
        if (sp < 0) continue;
        const kv = line.slice(sp + 1);
        const eq = kv.indexOf('=');
        if (eq < 0) continue;
        const key = kv.slice(0, eq);
        const value = kv.slice(eq + 1);
        if (key === 'path') this.paxPath = value;
        if (key === 'size') this.paxSize = Number(value) || 0;
      }
    }
    this.collect = null;
  }
}

/** List a .tar or .tar.gz by walking entry headers (streamed, capped). */
export function listTar(filePath: string, gzipped: boolean): Promise<ArchiveListing> {
  return new Promise((resolve, reject) => {
    const walker = new TarWalker();
    let walked = 0;
    const src = fs.createReadStream(filePath);
    const stream = gzipped ? src.pipe(zlib.createGunzip()) : src;
    const finish = (): void => resolve({ entries: walker.entries, truncated: walker.truncated });
    stream.on('data', (chunk: Buffer) => {
      walked += chunk.length;
      walker.write(chunk);
      if (walker.truncated || walked > TAR_MAX_WALK) {
        walker.truncated = walker.truncated || walked > TAR_MAX_WALK;
        src.destroy();
        finish();
      }
    });
    stream.on('end', finish);
    stream.on('error', (err: Error) => reject(err));
    src.on('error', (err: Error) => reject(err));
  });
}

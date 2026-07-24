import fsp from 'node:fs/promises';

/** Bump this if the on-disk record shape ever changes — loadIndex rejects
 *  anything else rather than silently misreading old records. */
export const INDEX_FORMAT_VERSION = 1;

export interface IndexCheckpoint {
  volumeSerialNumber: number;
  usnJournalId: bigint;
  lastUsnProcessed: bigint;
  formatVersion: number;
}

export interface IndexRecord {
  recordNo: number;
  parentRecordNo: number;
  name: string;
  size: number;
  isDir: boolean;
  mtimeMs: number;
}

const MAGIC = 0x4e4d4649; // "NMFI" as a little-endian u32
// checkpoint header: magic(4) + formatVersion(4) + volumeSerialNumber(4)
// + usnJournalId(8) + lastUsnProcessed(8) + recordCount(4) + namesBlobLength(4)
const HEADER_SIZE = 36;
// per-record layout (byte offsets within each record):
// recordNo(0-8) + parentRecordNo(8-16) + size(16-24) + mtimeMs(24-32)
// + isDir(32-33) + [3 bytes padding] + nameOffset(36-40) + nameLength(40-42)
// + [6 bytes trailing padding] = 48 total.
const RECORD_SIZE = 48;

/**
 * Binary format, not NDJSON/JSON — a fixed-size header, a fixed-size record
 * array (no per-record parsing/allocation), and a separate names blob that
 * records point into by (offset, length).
 */
export async function saveIndex(
  filePath: string,
  checkpoint: IndexCheckpoint,
  records: IndexRecord[],
): Promise<void> {
  const nameBuffers = records.map((r) => Buffer.from(r.name, 'utf8'));
  const namesBlobLength = nameBuffers.reduce((sum, b) => sum + b.length, 0);
  const buf = Buffer.alloc(HEADER_SIZE + records.length * RECORD_SIZE + namesBlobLength);

  let off = 0;
  buf.writeUInt32LE(MAGIC, off); off += 4;
  buf.writeUInt32LE(checkpoint.formatVersion, off); off += 4;
  buf.writeUInt32LE(checkpoint.volumeSerialNumber, off); off += 4;
  buf.writeBigUInt64LE(checkpoint.usnJournalId, off); off += 8;
  buf.writeBigInt64LE(checkpoint.lastUsnProcessed, off); off += 8;
  buf.writeUInt32LE(records.length, off); off += 4;
  buf.writeUInt32LE(namesBlobLength, off); off += 4;

  let nameOffset = HEADER_SIZE + records.length * RECORD_SIZE;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const nameBuf = nameBuffers[i];
    const recordStart = HEADER_SIZE + i * RECORD_SIZE;
    buf.writeBigUInt64LE(BigInt(r.recordNo), recordStart);
    buf.writeBigUInt64LE(BigInt(r.parentRecordNo), recordStart + 8);
    buf.writeBigUInt64LE(BigInt(r.size), recordStart + 16);
    buf.writeBigInt64LE(BigInt(r.mtimeMs), recordStart + 24);
    buf.writeUInt8(r.isDir ? 1 : 0, recordStart + 32);
    buf.writeUInt32LE(nameOffset, recordStart + 36);
    buf.writeUInt16LE(nameBuf.length, recordStart + 40);
    nameBuf.copy(buf, nameOffset);
    nameOffset += nameBuf.length;
  }

  await fsp.writeFile(filePath, buf);
}

export async function loadIndex(
  filePath: string,
): Promise<{ checkpoint: IndexCheckpoint; records: IndexRecord[] }> {
  const buf = await fsp.readFile(filePath);

  const magic = buf.readUInt32LE(0);
  const formatVersion = buf.readUInt32LE(4);
  if (magic !== MAGIC || formatVersion !== INDEX_FORMAT_VERSION) {
    throw new Error(
      `ntfs-mft index format version mismatch: file has ${formatVersion} (magic ${magic.toString(16)}), expected ${INDEX_FORMAT_VERSION}`,
    );
  }
  const checkpoint: IndexCheckpoint = {
    volumeSerialNumber: buf.readUInt32LE(8),
    usnJournalId: buf.readBigUInt64LE(12),
    lastUsnProcessed: buf.readBigInt64LE(20),
    formatVersion,
  };
  const recordCount = buf.readUInt32LE(28);

  const records: IndexRecord[] = new Array(recordCount);
  const namesStart = HEADER_SIZE + recordCount * RECORD_SIZE;
  for (let i = 0; i < recordCount; i++) {
    const recordStart = HEADER_SIZE + i * RECORD_SIZE;
    const nameOffset = buf.readUInt32LE(recordStart + 36);
    const nameLength = buf.readUInt16LE(recordStart + 40);
    records[i] = {
      recordNo: Number(buf.readBigUInt64LE(recordStart)),
      parentRecordNo: Number(buf.readBigUInt64LE(recordStart + 8)),
      size: Number(buf.readBigUInt64LE(recordStart + 16)),
      mtimeMs: Number(buf.readBigInt64LE(recordStart + 24)),
      isDir: buf.readUInt8(recordStart + 32) !== 0,
      name: buf.toString('utf8', nameOffset, nameOffset + nameLength),
    };
  }
  void namesStart; // kept for clarity/future validation, not otherwise used

  return { checkpoint, records };
}

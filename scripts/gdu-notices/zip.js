'use strict';
/*
 * Go module zips, for scripts/gdu-notices.js: list their files, read one, and
 * compute the hash go.sum records for the whole zip ("h1:", Go's
 * golang.org/x/mod/sumdb/dirhash Hash1) — with Node alone, no dependency.
 *
 * Module zips are plain: one entry per file, stored or deflated, no
 * encryption, well under the sizes that need zip64. Anything else is refused
 * by name rather than read approximately, since what is read here is either
 * printed word for word or vouches for what is.
 */
const crypto = require('crypto');
const zlib = require('zlib');

const SIG_END = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const END_BYTES = 22;
const MAX_COMMENT = 0xffff;
const ZIP64_MARK = 0xffffffff;
const FLAG_ENCRYPTED = 0x1;
const METHOD = { stored: 0, deflated: 8 };

/** The end-of-central-directory record's offset, searched from the end past any comment, or -1. */
function endRecordAt(zip) {
  for (let at = zip.length - END_BYTES; at >= 0 && at >= zip.length - END_BYTES - MAX_COMMENT; at -= 1) {
    if (zip.readUInt32LE(at) === SIG_END) return at;
  }
  return -1;
}

/** Every entry of a zip, from its central directory: { name, method, flags, compressedSize, size, offset }. */
function zipEntries(zip) {
  const end = zip.length >= END_BYTES ? endRecordAt(zip) : -1;
  if (end < 0) throw new Error('it is not a zip archive: it has no end-of-central-directory record');
  const count = zip.readUInt16LE(end + 10);
  const directoryAt = zip.readUInt32LE(end + 16);
  if (directoryAt === ZIP64_MARK || count === 0xffff) throw new Error('it is a zip64 archive, which no module zip needs and this reader does not read');
  const entries = [];
  let at = directoryAt;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== SIG_CENTRAL) throw new Error(`its central directory is damaged at entry ${i + 1} of ${count}`);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    entries.push({
      name: zip.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
      method: zip.readUInt16LE(at + 10),
      flags: zip.readUInt16LE(at + 8),
      compressedSize: zip.readUInt32LE(at + 20),
      size: zip.readUInt32LE(at + 24),
      offset: zip.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One entry's bytes, inflated, checked against the size the directory records. */
function zipEntryData(zip, entry) {
  if (entry.flags & FLAG_ENCRYPTED) throw new Error(`${entry.name} is encrypted`);
  const at = entry.offset;
  if (at + 30 > zip.length || zip.readUInt32LE(at) !== SIG_LOCAL) throw new Error(`${entry.name}: its local header is damaged`);
  const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
  const raw = zip.subarray(start, start + entry.compressedSize);
  let data;
  if (entry.method === METHOD.stored) data = raw;
  else if (entry.method === METHOD.deflated) data = zlib.inflateRawSync(raw);
  else throw new Error(`${entry.name} uses compression method ${entry.method}, which this reader does not read (only stored and deflated)`);
  if (data.length !== entry.size) throw new Error(`${entry.name} inflates to ${data.length} bytes, not the ${entry.size} its directory records`);
  return data;
}

/** Byte order of the names' UTF-8, as Go's sort.Strings orders them. */
function byUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * The zip's go.sum hash, "h1:" and base64: the SHA-256 of one line per file,
 * "<sha256 of its bytes in hex>  <name>\n", in name order — Hash1 over
 * every entry, as dirhash.HashZip computes it.
 */
function hashZip(zip) {
  const entries = zipEntries(zip);
  const summary = crypto.createHash('sha256');
  for (const entry of [...entries].sort((a, b) => byUtf8(a.name, b.name))) {
    if (entry.name.includes('\n')) throw new Error(`it holds a file whose name has a newline, which Go refuses to hash: ${JSON.stringify(entry.name)}`);
    const digest = crypto.createHash('sha256').update(zipEntryData(zip, entry)).digest('hex');
    summary.update(`${digest}  ${entry.name}\n`);
  }
  return `h1:${summary.digest('base64')}`;
}

module.exports = { zipEntries, zipEntryData, hashZip };

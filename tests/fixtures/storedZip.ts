/**
 * A zip archive written by hand, entries stored without compression — the
 * smallest file `unzip` and every other reader accept — so a test can hand a
 * real archive to code that reads one, without a zip tool or a dependency.
 * Written from PKWARE's APPNOTE.TXT: a local file header and the data for
 * each entry, then a central directory entry for each, then the end of
 * central directory record. CRC-32 is the IEEE polynomial (0xedb88320,
 * reflected), which unzip checks on every entry it reads.
 */

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 1 January 1980, the first day a DOS date can hold. */
const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1;

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** The bytes of a zip archive holding `entries`, in order, each stored. */
export function storedZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // flags: the name is UTF-8
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    parts.push(local, nameBytes, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); // central directory header signature
    entry.writeUInt16LE(0x0314, 4); // made by: Unix, 2.0
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0x0800, 8); // flags
    entry.writeUInt16LE(0, 10); // method
    entry.writeUInt16LE(0, 12); // time
    entry.writeUInt16LE(DOS_DATE_1980_01_01, 14); // date
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(0, 30); // extra
    entry.writeUInt16LE(0, 32); // comment
    entry.writeUInt16LE(0, 34); // disk number start
    entry.writeUInt16LE(0, 36); // internal attributes
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attributes: a regular file, rw-r--r--
    entry.writeUInt32LE(offset, 42); // where its local header starts
    central.push(entry, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // the disk the directory starts on
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16); // where the directory starts
  end.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...parts, directory, end]);
}

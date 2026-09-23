//! Hand-built NTFS structures for the tests: FILE records assembled from
//! attribute blobs, with the update-sequence fix-ups applied the way the disk
//! holds them, and the attribute values the parser reads. Every offset is
//! written out here from the NTFS on-disk layout, independently of the
//! parser's constants, so a wrong constant in the parser cannot agree with
//! itself through these builders.
#![allow(
    dead_code,
    reason = "each test binary uses a different subset of these builders"
)]

/// The record size every test uses: two 512-byte update-sequence sectors.
pub const RECORD_BYTES: usize = 1024;
/// The update-sequence stride NTFS uses whatever the device's sector size.
pub const STRIDE: usize = 512;
/// The update sequence number the builder stamps on every sector end.
pub const USN: u16 = 0x5A3C;
/// What the builder writes into a record's slack past the used size, so the
/// fix-up of a sector end that lies in the slack is still observable.
pub const SLACK: u8 = 0xA5;
/// Header flag: the record is in use.
pub const IN_USE: u16 = 0x0001;
/// Header flag: the record is a directory.
pub const DIRECTORY: u16 = 0x0002;
/// Where NTFS 3.1 puts the update-sequence array.
pub const USA_OFFSET: u16 = 0x30;

/// `$STANDARD_INFORMATION`.
pub const STANDARD_INFORMATION: u32 = 0x10;
/// `$ATTRIBUTE_LIST`.
pub const ATTRIBUTE_LIST: u32 = 0x20;
/// `$FILE_NAME`.
pub const FILE_NAME: u32 = 0x30;
/// `$OBJECT_ID`.
pub const OBJECT_ID: u32 = 0x40;
/// `$DATA`.
pub const DATA: u32 = 0x80;
/// `$INDEX_ROOT`.
pub const INDEX_ROOT: u32 = 0x90;
/// `$REPARSE_POINT`.
pub const REPARSE_POINT: u32 = 0xC0;
/// The end marker.
pub const END: u32 = 0xFFFF_FFFF;

/// The POSIX namespace.
pub const POSIX: u8 = 0;
/// The Win32 namespace.
pub const WIN32: u8 = 1;
/// The DOS (8.3) namespace.
pub const DOS: u8 = 2;
/// A name valid in both Win32 and DOS.
pub const WIN32_AND_DOS: u8 = 3;

/// Attribute flag: compressed.
pub const ATTR_COMPRESSED: u16 = 0x0001;
/// Attribute flag: sparse.
pub const ATTR_SPARSE: u16 = 0x8000;

/// The creation time every `$STANDARD_INFORMATION` carries: distinct from
/// every other time so a parser reading the wrong field is caught.
pub const CREATED: i64 = 111_111_111_111_111_111;
/// The MFT-change time, distinct for the same reason.
pub const CHANGED: i64 = 122_222_222_222_222_222;
/// Decoy sizes written into every `$FILE_NAME`'s duplicated information: the
/// size is `$DATA`'s, never these.
pub const DECOY_ALLOC: u64 = 0xDEAD_0000;
/// See [`DECOY_ALLOC`].
pub const DECOY_SIZE: u64 = 0xBEEF_0000;

/// `s` as UTF-16LE bytes.
pub fn utf16le(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(u16::to_le_bytes).collect()
}

/// `s` as UTF-16 units.
pub fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn align8(n: usize) -> usize {
    n.div_ceil(8) * 8
}

fn u16_of(n: usize) -> u16 {
    u16::try_from(n).unwrap_or(u16::MAX)
}

fn u32_of(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Writes `bytes` at `off`, or says where there was no room.
pub fn put(buf: &mut [u8], off: usize, bytes: &[u8]) -> Result<(), String> {
    let end = off
        .checked_add(bytes.len())
        .ok_or_else(|| format!("{off} + {} overflows", bytes.len()))?;
    let len = buf.len();
    buf.get_mut(off..end)
        .ok_or_else(|| format!("no room for {} bytes at {off} in {len}", bytes.len()))?
        .copy_from_slice(bytes);
    Ok(())
}

/// The two bytes at `off`.
pub fn pair(buf: &[u8], off: usize) -> Result<[u8; 2], String> {
    let end = off.checked_add(2).ok_or("overflow")?;
    buf.get(off..end)
        .and_then(|b| <[u8; 2]>::try_from(b).ok())
        .ok_or_else(|| format!("no pair at {off}"))
}

/// A FILE record: its header facts and its attribute blobs, in the order
/// they are written after the update-sequence array.
#[derive(Clone, Debug)]
pub struct FileRecord {
    /// The record number stored at 0x2C.
    pub number: u32,
    /// The sequence number at 0x10.
    pub sequence: u16,
    /// The flags at 0x16.
    pub flags: u16,
    /// The base record reference at 0x20 (0 for a base record).
    pub base: u64,
    /// The attributes, each a complete blob.
    pub attributes: Vec<Vec<u8>>,
    /// The record's size.
    pub size: usize,
    /// The update-sequence array's offset.
    pub usa_offset: u16,
}

impl FileRecord {
    /// An in-use base record numbered `number`, sequence 1, no attributes.
    pub fn new(number: u32) -> Self {
        Self {
            number,
            sequence: 1,
            flags: IN_USE,
            base: 0,
            attributes: Vec::new(),
            size: RECORD_BYTES,
            usa_offset: USA_OFFSET,
        }
    }

    /// Appends an attribute blob.
    pub fn attr(mut self, blob: Vec<u8>) -> Self {
        self.attributes.push(blob);
        self
    }

    /// The number of update-sequence sectors.
    pub fn sectors(&self) -> usize {
        self.size / STRIDE
    }

    /// Where the first attribute starts: after the update-sequence array,
    /// aligned to 8 bytes.
    pub fn first_attribute(&self) -> usize {
        align8(usize::from(self.usa_offset) + 2 * (1 + self.sectors()))
    }

    /// Where attribute `index` starts.
    pub fn attribute_offset(&self, index: usize) -> usize {
        self.first_attribute()
            + self
                .attributes
                .iter()
                .take(index)
                .map(Vec::len)
                .sum::<usize>()
    }

    /// The used size: through the end marker's eight bytes.
    pub fn used(&self) -> usize {
        self.attribute_offset(self.attributes.len()) + 8
    }

    /// The record as memory holds it once the fix-ups have been applied.
    pub fn logical(&self) -> Result<Vec<u8>, String> {
        let used = self.used();
        if used > self.size {
            return Err(format!("the attributes need {used} bytes of {}", self.size));
        }
        let mut rec = vec![SLACK; self.size];
        put(&mut rec, 0x00, b"FILE")?;
        put(&mut rec, 0x04, &self.usa_offset.to_le_bytes())?;
        put(&mut rec, 0x06, &u16_of(1 + self.sectors()).to_le_bytes())?;
        put(&mut rec, 0x08, &0_u64.to_le_bytes())?; // $LogFile sequence number
        put(&mut rec, 0x10, &self.sequence.to_le_bytes())?;
        put(&mut rec, 0x12, &1_u16.to_le_bytes())?; // hard-link count (never read)
        put(
            &mut rec,
            0x14,
            &u16_of(self.first_attribute()).to_le_bytes(),
        )?;
        put(&mut rec, 0x16, &self.flags.to_le_bytes())?;
        put(&mut rec, 0x18, &u32_of(used).to_le_bytes())?;
        put(&mut rec, 0x1C, &u32_of(self.size).to_le_bytes())?;
        put(&mut rec, 0x20, &self.base.to_le_bytes())?;
        put(&mut rec, 0x28, &u16_of(self.attributes.len()).to_le_bytes())?; // next attribute id
        put(&mut rec, 0x2A, &0_u16.to_le_bytes())?; // alignment
        put(&mut rec, 0x2C, &self.number.to_le_bytes())?;
        let usa = usize::from(self.usa_offset);
        put(&mut rec, usa, &USN.to_le_bytes())?;
        for slot in 1..=self.sectors() {
            put(&mut rec, usa + 2 * slot, &0_u16.to_le_bytes())?;
        }
        let first = self.first_attribute();
        put(
            &mut rec,
            usa + 2 * (1 + self.sectors()),
            &vec![0; first - (usa + 2 * (1 + self.sectors()))],
        )?;
        let mut body: Vec<u8> = self.attributes.concat();
        body.extend(END.to_le_bytes());
        body.extend(0_u32.to_le_bytes());
        put(&mut rec, first, &body)?;
        Ok(rec)
    }

    /// The record as the disk holds it: each sector's last two bytes saved
    /// into the update-sequence array and replaced by the sequence number.
    pub fn on_disk(&self) -> Result<Vec<u8>, String> {
        let mut rec = self.logical()?;
        let usa = usize::from(self.usa_offset);
        for sector in 0..self.sectors() {
            let end = (sector + 1) * STRIDE - 2;
            let saved = pair(&rec, end)?;
            put(&mut rec, usa + 2 * (sector + 1), &saved)?;
            put(&mut rec, end, &USN.to_le_bytes())?;
        }
        Ok(rec)
    }
}

/// A resident attribute: the 0x18-byte header, the name, the value.
pub fn resident(kind: u32, name: &str, flags: u16, value: &[u8]) -> Vec<u8> {
    let name16 = utf16le(name);
    let name_off = 0x18;
    let value_off = align8(name_off + name16.len());
    let len = align8(value_off + value.len());
    let mut a = Vec::with_capacity(len);
    a.extend(kind.to_le_bytes()); // 0x00 type
    a.extend(u32_of(len).to_le_bytes()); // 0x04 length
    a.push(0); // 0x08 resident
    a.push(u8::try_from(name.encode_utf16().count()).unwrap_or(u8::MAX)); // 0x09 name length
    a.extend(u16_of(name_off).to_le_bytes()); // 0x0A name offset
    a.extend(flags.to_le_bytes()); // 0x0C flags
    a.extend(0_u16.to_le_bytes()); // 0x0E attribute id
    a.extend(u32_of(value.len()).to_le_bytes()); // 0x10 value length
    a.extend(u16_of(value_off).to_le_bytes()); // 0x14 value offset
    a.extend([0, 0]); // 0x16 indexed flag, padding
    a.extend(&name16);
    a.resize(value_off, 0);
    a.extend(value);
    a.resize(len, 0);
    a
}

/// A non-resident attribute's facts.
#[derive(Clone, Debug, Default)]
pub struct Extent {
    /// The first VCN this extent maps.
    pub lowest_vcn: u64,
    /// The last VCN this extent maps.
    pub highest_vcn: u64,
    /// The allocated size (meaningful in the extent that starts at VCN 0).
    pub allocated: u64,
    /// The real size.
    pub size: u64,
    /// The initialized size.
    pub initialized: u64,
    /// The clusters actually allocated, present when compressed or sparse.
    pub compressed: Option<u64>,
    /// The run list, terminator included.
    pub runs: Vec<u8>,
}

/// A non-resident attribute: the 0x40-byte header (0x48 with a compressed
/// size), the name, the run list.
pub fn non_resident(kind: u32, name: &str, flags: u16, e: &Extent) -> Vec<u8> {
    let header = if e.compressed.is_some() { 0x48 } else { 0x40 };
    let name16 = utf16le(name);
    let runs_off = align8(header + name16.len());
    let len = align8(runs_off + e.runs.len());
    let mut a = Vec::with_capacity(len);
    a.extend(kind.to_le_bytes()); // 0x00 type
    a.extend(u32_of(len).to_le_bytes()); // 0x04 length
    a.push(1); // 0x08 non-resident
    a.push(u8::try_from(name.encode_utf16().count()).unwrap_or(u8::MAX)); // 0x09 name length
    a.extend(u16_of(header).to_le_bytes()); // 0x0A name offset
    a.extend(flags.to_le_bytes()); // 0x0C flags
    a.extend(0_u16.to_le_bytes()); // 0x0E attribute id
    a.extend(e.lowest_vcn.to_le_bytes()); // 0x10
    a.extend(e.highest_vcn.to_le_bytes()); // 0x18
    a.extend(u16_of(runs_off).to_le_bytes()); // 0x20 run-list offset
    let unit: u16 = if flags & ATTR_COMPRESSED != 0 { 4 } else { 0 };
    a.extend(unit.to_le_bytes()); // 0x22 compression unit
    a.extend(0_u32.to_le_bytes()); // 0x24 padding
    a.extend(e.allocated.to_le_bytes()); // 0x28
    a.extend(e.size.to_le_bytes()); // 0x30
    a.extend(e.initialized.to_le_bytes()); // 0x38
    if let Some(c) = e.compressed {
        a.extend(c.to_le_bytes()); // 0x40
    }
    a.extend(&name16);
    a.resize(runs_off, 0);
    a.extend(&e.runs);
    a.resize(len, 0);
    a
}

/// A `$STANDARD_INFORMATION` value (NTFS 3.x, 0x48 bytes).
pub fn std_info(last_write: i64, last_access: i64, attributes: u32) -> Vec<u8> {
    let mut v = Vec::with_capacity(0x48);
    v.extend(CREATED.to_le_bytes()); // 0x00 creation
    v.extend(last_write.to_le_bytes()); // 0x08 last write
    v.extend(CHANGED.to_le_bytes()); // 0x10 MFT change
    v.extend(last_access.to_le_bytes()); // 0x18 last access
    v.extend(attributes.to_le_bytes()); // 0x20 attributes
    v.resize(0x48, 0);
    v
}

/// A `$FILE_NAME` value: the parent reference, decoy duplicated information,
/// the name length, the namespace and the name.
pub fn file_name(parent: u64, parent_seq: u16, namespace: u8, name: &str) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend(((u64::from(parent_seq) << 48) | parent).to_le_bytes()); // 0x00
    v.extend(CREATED.to_le_bytes()); // 0x08 creation
    v.extend(CHANGED.to_le_bytes()); // 0x10 modification (stale copy)
    v.extend(CHANGED.to_le_bytes()); // 0x18 MFT change
    v.extend(CHANGED.to_le_bytes()); // 0x20 access
    v.extend(DECOY_ALLOC.to_le_bytes()); // 0x28 allocated size (stale copy)
    v.extend(DECOY_SIZE.to_le_bytes()); // 0x30 real size (stale copy)
    v.extend(0x20_u32.to_le_bytes()); // 0x38 flags
    v.extend(0_u32.to_le_bytes()); // 0x3C reparse tag / EA size
    v.push(u8::try_from(name.encode_utf16().count()).unwrap_or(u8::MAX)); // 0x40
    v.push(namespace); // 0x41
    v.extend(utf16le(name)); // 0x42
    v
}

/// A `REPARSE_DATA_BUFFER` for a symbolic link or a junction whose
/// substitute name is `substitute` (the print name repeats it).
pub fn link_buffer(tag: u32, substitute: &str) -> Vec<u8> {
    let sub = utf16le(substitute);
    let mut path_buffer = sub.clone();
    path_buffer.extend(&sub);
    let symlink = tag == 0xA000_000C;
    let fixed: usize = if symlink { 12 } else { 8 };
    let mut out = Vec::new();
    out.extend(tag.to_le_bytes());
    out.extend(u16_of(fixed + path_buffer.len()).to_le_bytes()); // ReparseDataLength
    out.extend(0_u16.to_le_bytes()); // Reserved
    out.extend(0_u16.to_le_bytes()); // SubstituteNameOffset
    out.extend(u16_of(sub.len()).to_le_bytes()); // SubstituteNameLength
    out.extend(u16_of(sub.len()).to_le_bytes()); // PrintNameOffset
    out.extend(u16_of(sub.len()).to_le_bytes()); // PrintNameLength
    if symlink {
        out.extend(0_u32.to_le_bytes()); // Flags: absolute
    }
    out.extend(&path_buffer);
    out
}

/// An `IO_REPARSE_TAG_APPEXECLINK` buffer: a version word, then NUL-separated strings.
pub fn appexeclink_buffer(strings: &[&str]) -> Vec<u8> {
    let mut list = Vec::new();
    for s in strings {
        list.extend(utf16le(s));
        list.extend(0_u16.to_le_bytes());
    }
    list.extend(0_u16.to_le_bytes());
    let mut out = Vec::new();
    out.extend(0x8000_001B_u32.to_le_bytes());
    out.extend(u16_of(4 + list.len()).to_le_bytes());
    out.extend(0_u16.to_le_bytes());
    out.extend(3_u32.to_le_bytes()); // Version
    out.extend(&list);
    out
}

/// A reparse buffer carrying only a tag and `data` (a cloud placeholder's, a
/// WSL link's): the listing never reads past the tag for these.
pub fn tag_buffer(tag: u32, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(tag.to_le_bytes());
    out.extend(u16_of(data.len()).to_le_bytes());
    out.extend(0_u16.to_le_bytes());
    out.extend(data);
    out
}

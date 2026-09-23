//! One NTFS FILE record, as `$MFT` holds it: a 48-byte header, an update
//! sequence array, then attributes back to back up to an `0xFFFFFFFF` end
//! marker. [`parse_record`] first applies the update-sequence fix-ups in
//! place — NTFS writes the record's sequence number over the last two bytes
//! of every 512 bytes and saves the real bytes in the array, so a sector the
//! disk wrote from an older version of the record is detectable — and then
//! reads only what the tree needs: the header's flags and references,
//! `$STANDARD_INFORMATION`'s times and attributes, every `$FILE_NAME`, the
//! unnamed `$DATA` stream's sizes and `$REPARSE_POINT`'s value.
//!
//! Every read is bounds-checked through the `read_*` helpers, which return
//! `None` past the end rather than panic; a record the disk could not have
//! held (a torn write, an attribute running past the used size, a value
//! outside its attribute) is refused with the reason rather than half read.

use std::fmt;

/// `FILE`: the signature every file record starts with. `BAAD` is what
/// `chkdsk` writes over a record it found torn.
pub const FILE_SIGNATURE: [u8; 4] = *b"FILE";
/// The update-sequence stride: NTFS protects every 512 bytes of a multi-sector
/// structure whatever the device's sector size (the NT driver's
/// `SEQUENCE_NUMBER_STRIDE`, ntfs-3g's `NTFS_BLOCK_SIZE`), so a 4,096-byte
/// record on a 4K-native disk has eight protected units, not one. This is the
/// value to pass to [`parse_record`] as `bytes_per_sector`, not the volume's
/// `BytesPerSector`.
pub const UPDATE_SEQUENCE_STRIDE: usize = 512;
/// The header through the NTFS 3.1 record number, and where 3.1 puts the
/// update-sequence array.
pub const HEADER_BYTES: usize = 0x30;

const OFF_SIGNATURE: usize = 0x00;
const OFF_USA_OFFSET: usize = 0x04;
const OFF_USA_COUNT: usize = 0x06;
const OFF_SEQUENCE: usize = 0x10;
const OFF_FIRST_ATTRIBUTE: usize = 0x14;
const OFF_FLAGS: usize = 0x16;
const OFF_USED_SIZE: usize = 0x18;
const OFF_BASE_REFERENCE: usize = 0x20;
const OFF_RECORD_NUMBER: usize = 0x2C;

/// Header flag: the record is in use (a deleted file's record keeps its
/// bytes with this bit clear).
pub const RECORD_IN_USE: u16 = 0x0001;
/// Header flag: the record is a directory (it has a `$I30` file-name index).
/// `$STANDARD_INFORMATION`'s attributes never carry
/// `FILE_ATTRIBUTE_DIRECTORY`; NTFS derives it from this bit.
pub const RECORD_IS_DIRECTORY: u16 = 0x0002;

/// A file reference's record number: its low 48 bits.
pub const REFERENCE_NUMBER_MASK: u64 = 0x0000_FFFF_FFFF_FFFF;
/// A file reference's sequence number: its high 16 bits.
const REFERENCE_SEQUENCE_SHIFT: u32 = 48;

/// `$STANDARD_INFORMATION`: times and attributes.
pub const ATTR_STANDARD_INFORMATION: u32 = 0x10;
/// `$ATTRIBUTE_LIST`: never read (decision W6-5); extension records are
/// merged by their base reference instead.
pub const ATTR_ATTRIBUTE_LIST: u32 = 0x20;
/// `$FILE_NAME`: one per name (hard link, DOS alias).
pub const ATTR_FILE_NAME: u32 = 0x30;
/// `$DATA`: the unnamed stream is the file's content; a named one is an
/// alternate data stream.
pub const ATTR_DATA: u32 = 0x80;
/// `$REPARSE_POINT`: a `REPARSE_DATA_BUFFER`.
pub const ATTR_REPARSE_POINT: u32 = 0xC0;
/// The end marker.
pub const ATTR_END: u32 = 0xFFFF_FFFF;

const OFF_ATTR_TYPE: usize = 0x00;
const OFF_ATTR_LENGTH: usize = 0x04;
const OFF_ATTR_NON_RESIDENT: usize = 0x08;
const OFF_ATTR_NAME_LENGTH: usize = 0x09;
const OFF_ATTR_NAME_OFFSET: usize = 0x0A;
const OFF_ATTR_FLAGS: usize = 0x0C;
/// A resident attribute's header: through the value offset and its padding.
const RESIDENT_HEADER_BYTES: usize = 0x18;
const OFF_VALUE_LENGTH: usize = 0x10;
const OFF_VALUE_OFFSET: usize = 0x14;
/// A non-resident attribute's header: through the initialized size.
const NON_RESIDENT_HEADER_BYTES: usize = 0x40;
/// A compressed or sparse non-resident attribute's longer header: through
/// the clusters actually allocated — written only where the run list starts
/// after it (NTFS gives a later extent the short header, flags or not).
const COMPRESSED_HEADER_BYTES: usize = 0x48;
const OFF_LOWEST_VCN: usize = 0x10;
const OFF_RUN_LIST: usize = 0x20;
const OFF_ALLOCATED_SIZE: usize = 0x28;
const OFF_DATA_SIZE: usize = 0x30;
const OFF_INITIALIZED_SIZE: usize = 0x38;
const OFF_COMPRESSED_SIZE: usize = 0x40;
/// Attribute flags naming a compression format.
const ATTR_FLAG_COMPRESSION_MASK: u16 = 0x00FF;
/// Attribute flag: sparse.
const ATTR_FLAG_SPARSE: u16 = 0x8000;
/// NTFS reports a resident stream's allocation as its length rounded up to
/// eight bytes (ntfs-3g does the same when it sizes one).
const RESIDENT_ALLOCATION_ALIGN: u64 = 8;

const SI_OFF_LAST_WRITE: usize = 0x08;
const SI_OFF_LAST_ACCESS: usize = 0x18;
const SI_OFF_ATTRIBUTES: usize = 0x20;
/// Through the attributes field: NTFS 1.2's 48-byte form and 3.x's 72-byte
/// form both have it.
const SI_MIN_BYTES: usize = 0x24;

const FN_OFF_PARENT: usize = 0x00;
const FN_OFF_NAME_LENGTH: usize = 0x40;
const FN_OFF_NAMESPACE: usize = 0x41;
const FN_OFF_NAME: usize = 0x42;

/// `$FILE_NAME` namespace: a POSIX name (case-sensitive, any unit but NUL and `/`).
pub const NAMESPACE_POSIX: u8 = 0;
/// `$FILE_NAME` namespace: a Win32 long name.
pub const NAMESPACE_WIN32: u8 = 1;
/// `$FILE_NAME` namespace: a DOS 8.3 alias of a Win32 name; never an entry.
pub const NAMESPACE_DOS: u8 = 2;
/// `$FILE_NAME` namespace: a name valid as both, stored once.
pub const NAMESPACE_WIN32_AND_DOS: u8 = 3;

/// `$STANDARD_INFORMATION`'s facts the walk records.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StdInfo {
    /// Last write, as FILETIME ticks: what `lstat` reports as the mtime.
    pub last_write: i64,
    /// Last access, as FILETIME ticks.
    pub last_access: i64,
    /// The file attributes (`FILE_ATTRIBUTE_*`), without the directory bit.
    pub attributes: u32,
}

/// One `$FILE_NAME`: a name and the directory it is in.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FileName {
    /// The parent directory's record number (48 bits).
    pub parent: u64,
    /// The parent directory's sequence number when the name was made: a
    /// mismatch with the parent's current one means the parent was deleted
    /// and its record reused.
    pub parent_seq: u16,
    /// [`NAMESPACE_POSIX`], [`NAMESPACE_WIN32`], [`NAMESPACE_DOS`] or
    /// [`NAMESPACE_WIN32_AND_DOS`].
    pub namespace: u8,
    /// The name as UTF-16 units, as stored.
    pub name: Vec<u16>,
}

/// One parsed FILE record, with its extension records' attributes merged in
/// once it is in a `RecordTable`.
///
/// Beyond the plan's fixed fields: `base_seq` (the base reference's
/// sequence, so an extension of a deleted-and-reused base is not merged),
/// `data_alloc` (the allocation the listing reports, which the ingest reads
/// to spot cloud placeholders) and `reparse_nonresident` (a reparse point
/// whose value is on disk, not in the record).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Record {
    /// The record's own number (48 bits), from the header.
    pub number: u64,
    /// The record's sequence number: bumped each time the record is reused.
    pub sequence: u16,
    /// Header flag [`RECORD_IN_USE`].
    pub in_use: bool,
    /// Header flag [`RECORD_IS_DIRECTORY`].
    pub is_dir: bool,
    /// The base record's number for an extension record; 0 (with a 0
    /// `base_seq`) for a base record.
    pub base: u64,
    /// The base record's sequence number, for an extension record.
    pub base_seq: u16,
    /// The first `$STANDARD_INFORMATION`.
    pub std_info: Option<StdInfo>,
    /// Every `$FILE_NAME`, in record order, DOS-only ones included (the
    /// builder drops them).
    pub names: Vec<FileName>,
    /// The unnamed `$DATA` stream's real size: the value length when
    /// resident, the data-size field of the extent that starts at VCN 0
    /// when not. `None` when the record holds no such attribute.
    pub data_size: Option<u64>,
    /// The unnamed stream's allocation as NTFS reports it: the value length
    /// rounded up to 8 when resident; when not, the clusters actually
    /// allocated for a compressed or sparse stream, the allocated size
    /// otherwise.
    pub data_alloc: Option<u64>,
    /// The first resident `$REPARSE_POINT` value (a `REPARSE_DATA_BUFFER`).
    pub reparse: Option<Vec<u8>>,
    /// True when a `$REPARSE_POINT` was non-resident, so its value (and its
    /// tag) is not in the record.
    pub reparse_nonresident: bool,
}

impl Record {
    /// The file reference: the sequence number over the 48-bit record number,
    /// which is what NTFS reports as a file's id (the low 64 bits of
    /// `FILE_ID_EXTD_DIR_INFO`'s `FileId`, Node's `ino`).
    pub fn reference(&self) -> u64 {
        (u64::from(self.sequence) << REFERENCE_SEQUENCE_SHIFT)
            | (self.number & REFERENCE_NUMBER_MASK)
    }

    /// Whether this is an extension record, whose attributes belong to its base.
    pub fn is_extension(&self) -> bool {
        self.base != 0 || self.base_seq != 0
    }
}

/// One extent of a record's unnamed, non-resident `$DATA` stream: what the
/// volume reader needs from `$MFT`'s own record (0) and `$UpCase`'s (10).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DataExtent {
    /// The first VCN the extent maps; the extents of one stream are
    /// concatenated in this order.
    pub lowest_vcn: u64,
    /// The stream's real size (meaningful only when `lowest_vcn` is 0).
    pub data_size: u64,
    /// The stream's initialized size (meaningful only when `lowest_vcn` is
    /// 0): past it, the clusters hold whatever the disk held before.
    pub initialized_size: u64,
    /// The run list, from its offset to the attribute's end (the terminator
    /// and any padding included); see [`crate::runs::decode_runs`].
    pub runs: Vec<u8>,
}

/// Why a record, or a run list, was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordError {
    /// The record does not start with `FILE` (never written, or marked `BAAD`).
    BadSignature,
    /// A protected unit did not hold the update sequence number: the disk
    /// holds part of an older version of the record (a torn write).
    FixupMismatch {
        /// The 512-byte unit, from 0.
        sector: usize,
    },
    /// The buffer is shorter than the header.
    Truncated,
    /// An attribute the record could not have held.
    BadAttribute {
        /// The attribute's offset in the record.
        offset: usize,
        /// What was wrong with it.
        reason: &'static str,
    },
    /// A header the record could not have held (added to the plan's set).
    BadHeader {
        /// What was wrong with it.
        reason: &'static str,
    },
    /// A run list that cannot describe clusters on a volume (added to the plan's set).
    BadRuns {
        /// The run's header byte's offset in the run list.
        offset: usize,
        /// What was wrong with it.
        reason: &'static str,
    },
}

impl fmt::Display for RecordError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadSignature => f.write_str("the record does not start with FILE"),
            Self::FixupMismatch { sector } => write!(
                f,
                "the record's unit {sector} does not end in its update sequence number (a torn write)"
            ),
            Self::Truncated => f.write_str("the record is shorter than its header"),
            Self::BadAttribute { offset, reason } => {
                write!(f, "the attribute at offset {offset}: {reason}")
            }
            Self::BadHeader { reason } => write!(f, "the record header: {reason}"),
            Self::BadRuns { offset, reason } => {
                write!(f, "the run at offset {offset} of the run list: {reason}")
            }
        }
    }
}

impl std::error::Error for RecordError {}

pub(crate) fn read_u8(buf: &[u8], off: usize) -> Option<u8> {
    buf.get(off).copied()
}

pub(crate) fn read_u16(buf: &[u8], off: usize) -> Option<u16> {
    let bytes = buf.get(off..off.checked_add(2)?)?;
    Some(u16::from_le_bytes(bytes.try_into().ok()?))
}

pub(crate) fn read_u32(buf: &[u8], off: usize) -> Option<u32> {
    let bytes = buf.get(off..off.checked_add(4)?)?;
    Some(u32::from_le_bytes(bytes.try_into().ok()?))
}

pub(crate) fn read_u64(buf: &[u8], off: usize) -> Option<u64> {
    let bytes = buf.get(off..off.checked_add(8)?)?;
    Some(u64::from_le_bytes(bytes.try_into().ok()?))
}

pub(crate) fn read_i64(buf: &[u8], off: usize) -> Option<i64> {
    let bytes = buf.get(off..off.checked_add(8)?)?;
    Some(i64::from_le_bytes(bytes.try_into().ok()?))
}

/// A file reference's sequence number.
pub(crate) fn sequence_of(reference: u64) -> u16 {
    u16::try_from(reference >> REFERENCE_SEQUENCE_SHIFT).unwrap_or(u16::MAX)
}

/// Whether the header of `buf` says the record is in use, read from the
/// bytes as they are: the flags lie in the first protected unit but never in
/// its last two bytes, so a fix-up (applied or not) cannot change them. What
/// the volume reader asks of a record [`parse_record`] refused.
pub(crate) fn header_in_use(buf: &[u8]) -> bool {
    read_u16(buf, OFF_FLAGS).is_some_and(|flags| flags & RECORD_IN_USE != 0)
}

fn bad_header(reason: &'static str) -> RecordError {
    RecordError::BadHeader { reason }
}

/// Applies the update-sequence fix-ups to `buf` in place and parses the
/// record. `bytes_per_sector` is the fix-up stride, which is
/// [`UPDATE_SEQUENCE_STRIDE`] on every NTFS volume; `buf` must be exactly one
/// record. A record not in use is returned with its header facts only: what
/// a deleted record still holds is not a fact, so nothing in it can fail it.
/// On any error but a bad header found after the fix-ups, `buf` is left as
/// it was.
pub fn parse_record(buf: &mut [u8], bytes_per_sector: usize) -> Result<Record, RecordError> {
    if buf.len() < HEADER_BYTES {
        return Err(RecordError::Truncated);
    }
    if buf.get(OFF_SIGNATURE..OFF_SIGNATURE + FILE_SIGNATURE.len()) != Some(&FILE_SIGNATURE[..]) {
        return Err(RecordError::BadSignature);
    }
    apply_fixups(buf, bytes_per_sector)?;
    let buf: &[u8] = buf;
    let header = read_header(buf)?;
    let mut rec = Record {
        number: header.number,
        sequence: header.sequence,
        in_use: header.flags & RECORD_IN_USE != 0,
        is_dir: header.flags & RECORD_IS_DIRECTORY != 0,
        base: header.base_reference & REFERENCE_NUMBER_MASK,
        base_seq: sequence_of(header.base_reference),
        ..Record::default()
    };
    if !rec.in_use {
        return Ok(rec);
    }
    walk_attributes(buf, &header, &mut |offset, attr| {
        read_attribute(attr, &mut rec)
            .map_err(|reason| RecordError::BadAttribute { offset, reason })
    })?;
    Ok(rec)
}

/// Every unnamed, non-resident `$DATA` extent of `record`, which
/// [`parse_record`] must already have fixed up (fixing up twice fails: the
/// protected units no longer hold the sequence number).
pub fn data_extents(record: &[u8]) -> Result<Vec<DataExtent>, RecordError> {
    if record.len() < HEADER_BYTES {
        return Err(RecordError::Truncated);
    }
    if record.get(OFF_SIGNATURE..OFF_SIGNATURE + FILE_SIGNATURE.len()) != Some(&FILE_SIGNATURE[..])
    {
        return Err(RecordError::BadSignature);
    }
    let header = read_header(record)?;
    let mut out = Vec::new();
    walk_attributes(record, &header, &mut |offset, attr| {
        if read_u32(attr, OFF_ATTR_TYPE) != Some(ATTR_DATA) {
            return Ok(());
        }
        let a = attribute(attr).map_err(|reason| RecordError::BadAttribute { offset, reason })?;
        if let (true, Form::NonResident(nr)) = (a.name_is_empty, a.form) {
            out.push(DataExtent {
                lowest_vcn: nr.lowest_vcn,
                data_size: nr.data_size,
                initialized_size: nr.initialized,
                runs: nr.runs.to_vec(),
            });
        }
        Ok(())
    })?;
    Ok(out)
}

/// The byte offset of the last protected unit of `sector`.
fn protected_unit(sector: usize, stride: usize) -> Option<usize> {
    sector.checked_add(1)?.checked_mul(stride)?.checked_sub(2)
}

/// Checks every protected unit against the update sequence number, then —
/// only when all of them hold it — puts the saved bytes back. Checking first
/// means a torn record is left exactly as it was read.
fn apply_fixups(buf: &mut [u8], stride: usize) -> Result<(), RecordError> {
    if stride < 2 || buf.len() % stride != 0 {
        return Err(bad_header(
            "the record is not a whole number of update-sequence strides",
        ));
    }
    let sectors = buf.len() / stride;
    let usa = usize::from(read_u16(buf, OFF_USA_OFFSET).ok_or(RecordError::Truncated)?);
    let count = usize::from(read_u16(buf, OFF_USA_COUNT).ok_or(RecordError::Truncated)?);
    if usa % 2 != 0 {
        return Err(bad_header(
            "the update-sequence array is not aligned to a 16-bit unit",
        ));
    }
    if Some(count) != sectors.checked_add(1) {
        return Err(bad_header(
            "the update-sequence array does not hold the sequence number and one unit per sector",
        ));
    }
    // Ending before the first protected unit, the array can never be
    // overwritten by a restore while it is still being read.
    if count
        .checked_mul(2)
        .and_then(|n| n.checked_add(usa))
        .is_none_or(|end| end > stride - 2)
    {
        return Err(bad_header(
            "the update-sequence array overlaps a protected sector end",
        ));
    }
    let usn = read_u16(buf, usa).ok_or(RecordError::Truncated)?;
    for sector in 0..sectors {
        let at = protected_unit(sector, stride).ok_or(RecordError::Truncated)?;
        if read_u16(buf, at) != Some(usn) {
            return Err(RecordError::FixupMismatch { sector });
        }
    }
    for sector in 0..sectors {
        let at = protected_unit(sector, stride).ok_or(RecordError::Truncated)?;
        let slot = sector
            .checked_add(1)
            .and_then(|n| n.checked_mul(2))
            .and_then(|n| n.checked_add(usa))
            .ok_or(RecordError::Truncated)?;
        let saved: [u8; 2] = buf
            .get(slot..slot + 2)
            .and_then(|b| b.try_into().ok())
            .ok_or(RecordError::Truncated)?;
        buf.get_mut(at..at + 2)
            .ok_or(RecordError::Truncated)?
            .copy_from_slice(&saved);
    }
    Ok(())
}

/// The header facts, checked against the record they sit in.
struct Header {
    number: u64,
    sequence: u16,
    flags: u16,
    base_reference: u64,
    first_attribute: usize,
    used: usize,
}

fn read_header(buf: &[u8]) -> Result<Header, RecordError> {
    let truncated = RecordError::Truncated;
    let usa = usize::from(read_u16(buf, OFF_USA_OFFSET).ok_or(truncated)?);
    let count = usize::from(read_u16(buf, OFF_USA_COUNT).ok_or(truncated)?);
    // NTFS 3.0 put the array at 0x2A, over the field 3.1 uses for the
    // record's own number: such a record has no number to read.
    if usa < HEADER_BYTES {
        return Err(bad_header(
            "the record predates NTFS 3.1 and carries no record number",
        ));
    }
    let used = usize::try_from(read_u32(buf, OFF_USED_SIZE).ok_or(truncated)?)
        .map_err(|_| bad_header("the used size is not addressable"))?;
    if used > buf.len() {
        return Err(bad_header("the used size runs past the record"));
    }
    let first_attribute = usize::from(read_u16(buf, OFF_FIRST_ATTRIBUTE).ok_or(truncated)?);
    let array_end = count.saturating_mul(2).saturating_add(usa);
    if first_attribute < array_end || first_attribute >= used {
        return Err(bad_header(
            "the first attribute lies outside the used part of the record",
        ));
    }
    Ok(Header {
        number: u64::from(read_u32(buf, OFF_RECORD_NUMBER).ok_or(truncated)?),
        sequence: read_u16(buf, OFF_SEQUENCE).ok_or(truncated)?,
        flags: read_u16(buf, OFF_FLAGS).ok_or(truncated)?,
        base_reference: read_u64(buf, OFF_BASE_REFERENCE).ok_or(truncated)?,
        first_attribute,
        used,
    })
}

/// What [`walk_attributes`] hands each attribute to: its offset and its bytes.
type Visit<'a> = dyn FnMut(usize, &[u8]) -> Result<(), RecordError> + 'a;

/// Hands every attribute before the end marker to `visit` with its offset.
/// An attribute of zero length (which would never advance) or one running
/// past the used size is refused, as is a used size reached with no marker.
fn walk_attributes(buf: &[u8], header: &Header, visit: &mut Visit<'_>) -> Result<(), RecordError> {
    let used = header.used;
    let mut pos = header.first_attribute;
    loop {
        let at = pos;
        let bad = move |reason| RecordError::BadAttribute { offset: at, reason };
        let within = |len: usize| at.checked_add(len).is_some_and(|end| end <= used);
        if !within(4) {
            return Err(bad(
                "the attributes reach the used size without an end marker",
            ));
        }
        let kind = read_u32(buf, at).ok_or_else(|| bad("the attribute type is not addressable"))?;
        if kind == ATTR_END {
            return Ok(());
        }
        if !within(8) {
            return Err(bad("the attribute's length lies past the used size"));
        }
        let length = read_u32(buf, at + OFF_ATTR_LENGTH)
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| bad("the attribute's length is not addressable"))?;
        if length == 0 {
            return Err(bad("the attribute has zero length"));
        }
        if !within(length) {
            return Err(bad("the attribute runs past the used size"));
        }
        let end = at + length;
        let attr = buf
            .get(at..end)
            .ok_or_else(|| bad("the attribute runs past the used size"))?;
        visit(at, attr)?;
        pos = end;
    }
}

/// A non-resident attribute's header facts.
struct NonResident<'a> {
    lowest_vcn: u64,
    allocated: u64,
    data_size: u64,
    initialized: u64,
    /// The clusters actually allocated, for a compressed or sparse attribute.
    total_allocated: Option<u64>,
    runs: &'a [u8],
}

/// Where an attribute's content is.
enum Form<'a> {
    /// In the record: the value.
    Resident(&'a [u8]),
    /// On the volume, through a run list.
    NonResident(NonResident<'a>),
}

/// An attribute's header, parsed.
struct Attribute<'a> {
    name_is_empty: bool,
    form: Form<'a>,
}

const SHORT_HEADER: &str = "the attribute header does not fit in its length";

/// Parses the header of `attr` (one whole attribute), checking that its name,
/// its value or its run list lies inside it.
fn attribute(attr: &[u8]) -> Result<Attribute<'_>, &'static str> {
    let non_resident = read_u8(attr, OFF_ATTR_NON_RESIDENT).ok_or(SHORT_HEADER)?;
    let name_units = usize::from(read_u8(attr, OFF_ATTR_NAME_LENGTH).ok_or(SHORT_HEADER)?);
    let name_off = usize::from(read_u16(attr, OFF_ATTR_NAME_OFFSET).ok_or(SHORT_HEADER)?);
    let flags = read_u16(attr, OFF_ATTR_FLAGS).ok_or(SHORT_HEADER)?;
    let header = match non_resident {
        0 => RESIDENT_HEADER_BYTES,
        1 => NON_RESIDENT_HEADER_BYTES,
        _ => return Err("the non-resident flag is neither 0 nor 1"),
    };
    // Every header field below is read through a bounds-checked helper, so
    // a header longer than the attribute fails as SHORT_HEADER there.
    if name_units > 0 {
        name_units
            .checked_mul(2)
            .and_then(|len| name_off.checked_add(len))
            .and_then(|end| attr.get(name_off..end))
            .ok_or("the attribute's name lies outside it")?;
    }
    let form = if non_resident == 0 {
        let len = usize::try_from(read_u32(attr, OFF_VALUE_LENGTH).ok_or(SHORT_HEADER)?)
            .map_err(|_| "the attribute's value length is not addressable")?;
        let off = usize::from(read_u16(attr, OFF_VALUE_OFFSET).ok_or(SHORT_HEADER)?);
        let value = off
            .checked_add(len)
            .and_then(|end| attr.get(off..end))
            .ok_or("the attribute's value lies outside it")?;
        Form::Resident(value)
    } else {
        let runs_off = usize::from(read_u16(attr, OFF_RUN_LIST).ok_or(SHORT_HEADER)?);
        if runs_off < header {
            return Err("the run list lies inside the attribute header");
        }
        // The clusters actually allocated follow the fixed header only in a
        // compressed or sparse attribute, and only where the record wrote
        // them: its run list's offset says which (the first Windows CI run
        // refused a real volume on a later sparse extent with the short
        // header, 23 Sep 2026).
        let has_total = flags & (ATTR_FLAG_COMPRESSION_MASK | ATTR_FLAG_SPARSE) != 0
            && runs_off >= COMPRESSED_HEADER_BYTES;
        let runs = attr
            .get(runs_off..)
            .ok_or("the run list lies outside the attribute")?;
        Form::NonResident(NonResident {
            lowest_vcn: read_u64(attr, OFF_LOWEST_VCN).ok_or(SHORT_HEADER)?,
            allocated: read_u64(attr, OFF_ALLOCATED_SIZE).ok_or(SHORT_HEADER)?,
            data_size: read_u64(attr, OFF_DATA_SIZE).ok_or(SHORT_HEADER)?,
            initialized: read_u64(attr, OFF_INITIALIZED_SIZE).ok_or(SHORT_HEADER)?,
            total_allocated: if has_total {
                Some(read_u64(attr, OFF_COMPRESSED_SIZE).ok_or(SHORT_HEADER)?)
            } else {
                None
            },
            runs,
        })
    };
    Ok(Attribute {
        name_is_empty: name_units == 0,
        form,
    })
}

/// Reads one attribute into `rec`; the types the tree does not use are
/// skipped without their headers being parsed.
fn read_attribute(attr: &[u8], rec: &mut Record) -> Result<(), &'static str> {
    match read_u32(attr, OFF_ATTR_TYPE).ok_or(SHORT_HEADER)? {
        ATTR_STANDARD_INFORMATION => {
            let Form::Resident(value) = attribute(attr)?.form else {
                return Err("$STANDARD_INFORMATION must be resident");
            };
            if value.len() < SI_MIN_BYTES {
                return Err("$STANDARD_INFORMATION is shorter than its attributes field");
            }
            if rec.std_info.is_none() {
                rec.std_info = Some(StdInfo {
                    last_write: read_i64(value, SI_OFF_LAST_WRITE).ok_or(SHORT_HEADER)?,
                    last_access: read_i64(value, SI_OFF_LAST_ACCESS).ok_or(SHORT_HEADER)?,
                    attributes: read_u32(value, SI_OFF_ATTRIBUTES).ok_or(SHORT_HEADER)?,
                });
            }
        }
        ATTR_FILE_NAME => {
            let Form::Resident(value) = attribute(attr)?.form else {
                return Err("$FILE_NAME must be resident");
            };
            rec.names.push(file_name(value)?);
        }
        ATTR_DATA => {
            let a = attribute(attr)?;
            // A named stream is an alternate data stream: not the size
            // `lstat` reports, so never the entry's size.
            if !a.name_is_empty || rec.data_size.is_some() {
                return Ok(());
            }
            match a.form {
                Form::Resident(value) => {
                    let len = u64::try_from(value.len()).unwrap_or(u64::MAX);
                    rec.data_size = Some(len);
                    rec.data_alloc = Some(len.next_multiple_of(RESIDENT_ALLOCATION_ALIGN));
                }
                // Only the extent that starts at VCN 0 carries the stream's
                // sizes; a later extent's fields are not the stream's.
                Form::NonResident(nr) if nr.lowest_vcn == 0 => {
                    rec.data_size = Some(nr.data_size);
                    rec.data_alloc = Some(nr.total_allocated.unwrap_or(nr.allocated));
                }
                Form::NonResident(_) => {}
            }
        }
        ATTR_REPARSE_POINT => match attribute(attr)?.form {
            Form::Resident(value) => {
                if rec.reparse.is_none() {
                    rec.reparse = Some(value.to_vec());
                }
            }
            Form::NonResident(_) => rec.reparse_nonresident = true,
        },
        _ => {}
    }
    Ok(())
}

/// A `$FILE_NAME` value: the parent reference, then the name after the
/// duplicated information (whose sizes and times are stale copies and are
/// never read).
fn file_name(value: &[u8]) -> Result<FileName, &'static str> {
    const SHORT: &str = "$FILE_NAME is shorter than its fixed part";
    let parent = read_u64(value, FN_OFF_PARENT).ok_or(SHORT)?;
    let units = usize::from(read_u8(value, FN_OFF_NAME_LENGTH).ok_or(SHORT)?);
    let namespace = read_u8(value, FN_OFF_NAMESPACE).ok_or(SHORT)?;
    let bytes = value
        .get(FN_OFF_NAME..FN_OFF_NAME + 2 * units)
        .ok_or("$FILE_NAME's name runs past its value")?;
    Ok(FileName {
        parent: parent & REFERENCE_NUMBER_MASK,
        parent_seq: sequence_of(parent),
        namespace,
        name: bytes
            .chunks_exact(2)
            .map(|pair| <[u8; 2]>::try_from(pair).map_or(0, u16::from_le_bytes))
            .collect(),
    })
}

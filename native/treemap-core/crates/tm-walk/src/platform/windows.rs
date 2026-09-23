//! Windows: one `GetFileInformationByHandleEx(FileIdExtdDirectoryInfo)` call
//! per batch on a directory handle opened `FILE_LIST_DIRECTORY` with
//! `FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT` on a `\\?\`
//! path, with `FindFirstFileExW(FindExInfoBasic, FIND_FIRST_EX_LARGE_FETCH)`
//! as the fallback where a volume answers `ERROR_INVALID_PARAMETER` or
//! `ERROR_NOT_SUPPORTED` (no file ids).
//!
//! The facts are the legacy walker's, which on Windows come from two libuv
//! paths that must both be mirrored. `readdir` (`uv_fs_scandir`) types every
//! entry carrying `FILE_ATTRIBUTE_REPARSE_POINT` as a symbolic link whatever
//! its tag, so the walker records a junction, a cloud placeholder or a
//! WOF-compressed file as a leaf flagged symlink and never descends into it.
//! `lstat` (`fs__stat_handle`) then sizes that leaf: the UTF-8 length of the
//! reparse target when `fs__readlink_handle` can read it (a symbolic link, a
//! junction to a drive letter, an app execution alias), otherwise the object
//! behind the reparse point (`EndOfFile`, or 0 for a directory); a reparse
//! point Windows itself cannot follow (a WSL link, a Unix socket) fails
//! `lstat` with `ERROR_CANT_ACCESS_FILE`, which Node reports as `EACCES`.
//! Times are FILETIME ticks turned into `(sec, nsec)` exactly as libuv's
//! `uv__filetime_to_timespec` does, 32-bit `long` seconds included.
//!
//! The record has no link count, so files carry `nlink == 0` and the walk
//! detects families by file-id collision. The parser, the rules and the
//! constants are portable and tested on every platform; only the calls are
//! `cfg(windows)`. Every constant is defined here from the SDK headers so the
//! portable part needs no crate; on Windows they are checked at compile time
//! against `windows-sys`.

use std::path::Path;

use super::{Listing, Meta, time_ms};
use crate::output::Refusal;
use crate::{FLAG_DATALESS, KIND_DIR, KIND_FILE, KIND_SYMLINK};

/// `FILE_ATTRIBUTE_DIRECTORY`.
pub const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
/// `FILE_ATTRIBUTE_REPARSE_POINT`: the entry is a reparse point of some kind.
pub const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
/// `FILE_ATTRIBUTE_OFFLINE`: the data was moved to offline storage.
pub const FILE_ATTRIBUTE_OFFLINE: u32 = 0x0000_1000;
/// `FILE_ATTRIBUTE_RECALL_ON_OPEN`: not fully present locally; opening recalls it.
pub const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x0004_0000;
/// `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`: a placeholder whose data is remote.
pub const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
/// The attributes that mean the data is not local.
const DATALESS_ATTRIBUTES: u32 =
    FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_OFFLINE;

/// `IO_REPARSE_TAG_MOUNT_POINT`: a junction, or a volume mount point.
pub const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
/// `IO_REPARSE_TAG_SYMLINK`.
pub const IO_REPARSE_TAG_SYMLINK: u32 = 0xA000_000C;
/// `IO_REPARSE_TAG_APPEXECLINK`: a Microsoft Store app execution alias.
pub const IO_REPARSE_TAG_APPEXECLINK: u32 = 0x8000_001B;
/// `IO_REPARSE_TAG_CLOUD`: the cloud files filter's base tag (OneDrive).
pub const IO_REPARSE_TAG_CLOUD: u32 = 0x9000_001A;
/// `IO_REPARSE_TAG_CLOUD_MASK`: the bits that vary across the cloud family.
pub const IO_REPARSE_TAG_CLOUD_MASK: u32 = 0x0000_F000;
/// `IO_REPARSE_TAG_WOF`: the Windows Overlay Filter (compressed system files).
pub const IO_REPARSE_TAG_WOF: u32 = 0x8000_0017;
/// `IO_REPARSE_TAG_LX_SYMLINK`: a WSL symbolic link; Windows cannot follow it.
pub const IO_REPARSE_TAG_LX_SYMLINK: u32 = 0xA000_001D;
/// `IO_REPARSE_TAG_AF_UNIX`: a Unix domain socket; Windows cannot follow it.
pub const IO_REPARSE_TAG_AF_UNIX: u32 = 0x8000_0023;
/// `IO_REPARSE_TAG_LX_FIFO`: a WSL named pipe.
pub const IO_REPARSE_TAG_LX_FIFO: u32 = 0x8000_0024;
/// `IO_REPARSE_TAG_LX_CHR`: a WSL character device.
pub const IO_REPARSE_TAG_LX_CHR: u32 = 0x8000_0025;
/// `IO_REPARSE_TAG_LX_BLK`: a WSL block device.
pub const IO_REPARSE_TAG_LX_BLK: u32 = 0x8000_0026;

/// `ERROR_FILE_NOT_FOUND`.
pub const ERROR_FILE_NOT_FOUND: u32 = 2;
/// `ERROR_PATH_NOT_FOUND`.
pub const ERROR_PATH_NOT_FOUND: u32 = 3;
/// `ERROR_ACCESS_DENIED`.
pub const ERROR_ACCESS_DENIED: u32 = 5;
/// `ERROR_INVALID_DATA`: what a batch the kernel could not have written is reported as.
pub const ERROR_INVALID_DATA: u32 = 13;
/// `ERROR_INVALID_DRIVE`.
pub const ERROR_INVALID_DRIVE: u32 = 15;
/// `ERROR_NO_MORE_FILES`: the end of a listing.
pub const ERROR_NO_MORE_FILES: u32 = 18;
/// `ERROR_SHARING_VIOLATION`.
pub const ERROR_SHARING_VIOLATION: u32 = 32;
/// `ERROR_NOT_SUPPORTED`.
pub const ERROR_NOT_SUPPORTED: u32 = 50;
/// `ERROR_INVALID_PARAMETER`.
pub const ERROR_INVALID_PARAMETER: u32 = 87;
/// `ERROR_INVALID_NAME`.
pub const ERROR_INVALID_NAME: u32 = 123;
/// `ERROR_DIRECTORY`: not a directory (`ENOTDIR` to libuv).
pub const ERROR_DIRECTORY: u32 = 267;
/// `ERROR_ELEVATION_REQUIRED`.
pub const ERROR_ELEVATION_REQUIRED: u32 = 740;
/// `ERROR_OPERATION_ABORTED`: what a listing the walk cancelled between two
/// batches ends with (the walk discards it, so the code is immaterial).
pub const ERROR_OPERATION_ABORTED: u32 = 995;
/// `ERROR_NOACCESS`.
pub const ERROR_NOACCESS: u32 = 998;
/// `ERROR_PRIVILEGE_NOT_HELD`.
pub const ERROR_PRIVILEGE_NOT_HELD: u32 = 1314;
/// `ERROR_CANT_ACCESS_FILE`: a reparse point no filter resolves.
pub const ERROR_CANT_ACCESS_FILE: u32 = 1920;
/// `ERROR_INVALID_REPARSE_DATA`.
pub const ERROR_INVALID_REPARSE_DATA: u32 = 4392;

/// 1970-01-01T00:00:00Z as a FILETIME: 100 ns ticks since 1601.
pub const FILETIME_UNIX_EPOCH: i64 = 116_444_736_000_000_000;
/// FILETIME ticks per second.
const TICKS_PER_SECOND: i64 = 10_000_000;
/// Nanoseconds per tick.
const NANOS_PER_TICK: i64 = 100;
/// Nanoseconds per second.
const NANOS_PER_SECOND: i64 = 1_000_000_000;

/// Bytes before `FileName` in a `FILE_ID_EXTD_DIR_INFO`.
pub const RECORD_HEADER_BYTES: usize = 88;
const OFF_LAST_ACCESS: usize = 16;
const OFF_LAST_WRITE: usize = 24;
const OFF_END_OF_FILE: usize = 40;
const OFF_ALLOCATION: usize = 48;
const OFF_ATTRIBUTES: usize = 56;
const OFF_NAME_LENGTH: usize = 60;
const OFF_REPARSE_TAG: usize = 68;
const OFF_FILE_ID: usize = 72;
/// Bytes before the reparse-specific data in a `REPARSE_DATA_BUFFER`
/// (`ReparseTag`, `ReparseDataLength`, `Reserved`).
const REPARSE_HEADER_BYTES: usize = 8;
/// Bytes before `PathBuffer` in a `SymbolicLinkReparseBuffer` (four offsets and `Flags`).
const SYMLINK_FIXED_BYTES: usize = 12;
/// Bytes before `PathBuffer` in a `MountPointReparseBuffer` (four offsets).
const MOUNT_POINT_FIXED_BYTES: usize = 8;
/// Bytes before `StringList` in an app execution alias buffer (the version word).
const ALIAS_FIXED_BYTES: usize = 4;
/// The fewest strings libuv accepts in an app execution alias.
const ALIAS_MIN_STRINGS: u32 = 3;

const BACKSLASH: u16 = b'\\' as u16;
const QUESTION: u16 = b'?' as u16;
const COLON: u16 = b':' as u16;
/// `\??\`, the NT namespace prefix `CreateSymbolicLink` puts on absolute targets.
const NT_PREFIX: [u16; 4] = [BACKSLASH, QUESTION, QUESTION, BACKSLASH];
/// The UTF-16LE bytes of `.`.
const DOT: [u8; 2] = [b'.', 0];
/// The UTF-16LE bytes of `..`.
const DOT_DOT: [u8; 4] = [b'.', 0, b'.', 0];
/// The units a listed name must not hold to be joined onto its folder's path
/// as one name: the separators, the stream separator (`a:b` is stream `b` of
/// file `a`) and NUL.
const NOT_IN_A_NAME: [u16; 4] = [b'/' as u16, BACKSLASH, COLON, 0];

/// A batch the kernel could not have written: the directory is unreadable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseError {
    /// Which record of the batch was malformed.
    pub record: usize,
    /// What was wrong with it.
    pub reason: &'static str,
}

fn fail(record: usize, reason: &'static str) -> ParseError {
    ParseError { record, reason }
}

/// One directory record, as far as the walk reads it: a `FILE_ID_EXTD_DIR_INFO`,
/// or a `WIN32_FIND_DATAW` on the fallback path, which has neither an
/// allocation size nor a file id (`None`).
#[derive(Debug, Clone, Copy)]
pub struct Record<'a> {
    /// The name as UTF-16LE bytes, as the record holds it up to its first NUL
    /// unit (a record's name has none; a corrupt one is cut there).
    pub name: &'a [u8],
    /// `FileAttributes`.
    pub attributes: u32,
    /// `ReparsePointTag`; meaningful only with [`FILE_ATTRIBUTE_REPARSE_POINT`].
    pub reparse_tag: u32,
    /// `EndOfFile`: the logical size.
    pub end_of_file: i64,
    /// `AllocationSize`, when the record has one.
    pub allocation: Option<i64>,
    /// `LastWriteTime` as FILETIME ticks.
    pub last_write: i64,
    /// `LastAccessTime` as FILETIME ticks.
    pub last_access: i64,
    /// The whole 128-bit file id, when the record has one. Its low 64 bits are
    /// what Node reports as `ino`, but only the whole id is an identity: ReFS
    /// ids can differ only above bit 64 (the pre-landing review of 23 Sep 2026).
    pub file_id: Option<u128>,
}

impl Record<'_> {
    /// The name as UTF-16 units.
    pub fn name_units(&self) -> Vec<u16> {
        units_of(self.name)
    }

    /// The name as Node decodes it: UTF-8 with U+FFFD for every lone surrogate.
    pub fn name_string(&self) -> String {
        char::decode_utf16(self.name.chunks_exact(2).map(unit_of))
            .map(|r| r.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect()
    }
}

fn unit_of(pair: &[u8]) -> u16 {
    <[u8; 2]>::try_from(pair).map_or(0, u16::from_le_bytes)
}

fn units_of(bytes: &[u8]) -> Vec<u16> {
    bytes.chunks_exact(2).map(unit_of).collect()
}

/// True for the `.` and `..` records, which are never facts.
pub fn is_dot_entry(name_utf16le: &[u8]) -> bool {
    name_utf16le == DOT || name_utf16le == DOT_DOT
}

fn read_u16(buf: &[u8], off: usize) -> Option<u16> {
    let bytes = buf.get(off..off.checked_add(2)?)?;
    Some(u16::from_le_bytes(bytes.try_into().ok()?))
}

fn read_u32(buf: &[u8], off: usize) -> Option<u32> {
    let bytes = buf.get(off..off.checked_add(4)?)?;
    Some(u32::from_le_bytes(bytes.try_into().ok()?))
}

fn read_u128(buf: &[u8], off: usize) -> Option<u128> {
    let bytes = buf.get(off..off.checked_add(16)?)?;
    Some(u128::from_le_bytes(bytes.try_into().ok()?))
}

fn read_i64(buf: &[u8], off: usize) -> Option<i64> {
    let bytes = buf.get(off..off.checked_add(8)?)?;
    Some(i64::from_le_bytes(bytes.try_into().ok()?))
}

/// Walks the `FILE_ID_EXTD_DIR_INFO` records in `buf` by `NextEntryOffset`
/// (the last one carries 0) and hands every record but `.` and `..` to
/// `visit`. Returns how many were visited; a length or offset the kernel
/// could not have written is an error. An empty buffer holds no record.
pub fn parse_records(buf: &[u8], visit: &mut dyn FnMut(&Record<'_>)) -> Result<usize, ParseError> {
    let mut pos = 0_usize;
    let mut visited = 0_usize;
    let mut index = 0_usize;
    if buf.is_empty() {
        return Ok(0);
    }
    loop {
        let rec = buf
            .get(pos..)
            .filter(|r| r.len() >= RECORD_HEADER_BYTES)
            .ok_or_else(|| fail(index, "the record is shorter than its header"))?;
        let next = read_u32(rec, 0)
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| fail(index, "the next-entry offset is not addressable"))?;
        let name_len = read_u32(rec, OFF_NAME_LENGTH)
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| fail(index, "the name length is not addressable"))?;
        if name_len % 2 != 0 {
            return Err(fail(
                index,
                "the name length is not a whole number of UTF-16 units",
            ));
        }
        let name_end = RECORD_HEADER_BYTES
            .checked_add(name_len)
            .ok_or_else(|| fail(index, "the name length overflows"))?;
        let name = rec
            .get(RECORD_HEADER_BYTES..name_end)
            .ok_or_else(|| fail(index, "the name extends beyond the buffer"))?;
        if next != 0 && name_end > next {
            return Err(fail(index, "the name extends beyond the record"));
        }
        // A NUL unit ends the name, as a NUL ends the name in a macOS record;
        // units, not bytes: a zero byte can belong to a unit such as U+0100.
        let name = name
            .chunks_exact(2)
            .position(|unit| unit == [0, 0])
            .and_then(|nul| name.get(..nul.saturating_mul(2)))
            .unwrap_or(name);
        let unreadable = || fail(index, "the record header is not addressable");
        let record = Record {
            name,
            attributes: read_u32(rec, OFF_ATTRIBUTES).ok_or_else(unreadable)?,
            reparse_tag: read_u32(rec, OFF_REPARSE_TAG).ok_or_else(unreadable)?,
            end_of_file: read_i64(rec, OFF_END_OF_FILE).ok_or_else(unreadable)?,
            allocation: Some(read_i64(rec, OFF_ALLOCATION).ok_or_else(unreadable)?),
            last_write: read_i64(rec, OFF_LAST_WRITE).ok_or_else(unreadable)?,
            last_access: read_i64(rec, OFF_LAST_ACCESS).ok_or_else(unreadable)?,
            file_id: Some(read_u128(rec, OFF_FILE_ID).ok_or_else(unreadable)?),
        };
        if !is_dot_entry(name) {
            visit(&record);
            visited = visited.saturating_add(1);
        }
        if next == 0 {
            return Ok(visited);
        }
        if next < RECORD_HEADER_BYTES {
            return Err(fail(
                index,
                "the next-entry offset does not advance past the header",
            ));
        }
        pos = pos
            .checked_add(next)
            .filter(|p| *p < buf.len())
            .ok_or_else(|| fail(index, "the next-entry offset lies beyond the buffer"))?;
        index = index.saturating_add(1);
    }
}

/// libuv's `uv__filetime_to_timespec`: ticks since 1601 become seconds and
/// nanoseconds since 1970, with C's truncating division and the negative
/// remainder normalised. `tv_sec` is a 32-bit `long` on Windows, so a time
/// past 2038 (or a FILETIME of 0) wraps there and wraps here: the equivalence
/// gate compares against Node, not against the calendar.
#[expect(
    clippy::cast_possible_truncation,
    reason = "libuv stores tv_sec in a 32-bit `long` on Windows; the wrap is mirrored, not corrected"
)]
pub fn filetime_to_timespec(filetime: i64) -> (i64, i64) {
    let since_epoch = filetime.wrapping_sub(FILETIME_UNIX_EPOCH);
    let mut sec = i64::from((since_epoch / TICKS_PER_SECOND) as i32);
    let mut nsec = (since_epoch % TICKS_PER_SECOND) * NANOS_PER_TICK;
    if nsec < 0 {
        sec -= 1;
        nsec += NANOS_PER_SECOND;
    }
    (sec, nsec)
}

/// A FILETIME as Node's `mtimeMs`/`atimeMs`: [`filetime_to_timespec`], then
/// `sec * 1e3 + nsec / 1e6` unrounded (P3-6).
pub fn filetime_ms(filetime: i64) -> f64 {
    let (sec, nsec) = filetime_to_timespec(filetime);
    time_ms(sec, nsec)
}

/// Whether the data is not local: a cloud-family reparse tag, or
/// `RECALL_ON_DATA_ACCESS`, `RECALL_ON_OPEN` or `OFFLINE` among the attributes.
pub fn is_dataless(attributes: u32, reparse_tag: u32) -> bool {
    attributes & DATALESS_ATTRIBUTES != 0
        || (reparse_tag & !IO_REPARSE_TAG_CLOUD_MASK) == IO_REPARSE_TAG_CLOUD
}

/// What libuv's `lstat` makes of a reparse tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkClass {
    /// `fs__readlink_handle` reads it: a symbolic link or a junction. When the
    /// target is not one it accepts (a volume mount point), the object behind
    /// the reparse point is reported instead.
    Link,
    /// An app execution alias: read like a link, but when its strings are not
    /// what libuv expects, following it fails with `ERROR_CANT_ACCESS_FILE`.
    Alias,
    /// A tag no filter on Windows resolves (WSL objects, Unix sockets):
    /// following it fails with `ERROR_CANT_ACCESS_FILE`.
    Unfollowable,
    /// Any other tag: the object behind the reparse point is reported.
    Followed,
}

/// Classifies a reparse tag as libuv's `lstat` does.
pub fn link_class(tag: u32) -> LinkClass {
    match tag {
        IO_REPARSE_TAG_SYMLINK | IO_REPARSE_TAG_MOUNT_POINT => LinkClass::Link,
        IO_REPARSE_TAG_APPEXECLINK => LinkClass::Alias,
        IO_REPARSE_TAG_LX_SYMLINK
        | IO_REPARSE_TAG_AF_UNIX
        | IO_REPARSE_TAG_LX_FIFO
        | IO_REPARSE_TAG_LX_CHR
        | IO_REPARSE_TAG_LX_BLK => LinkClass::Unfollowable,
        _ => LinkClass::Followed,
    }
}

/// The size Node's `lstat` reports for a reparse point whose data is `buf`
/// (a `REPARSE_DATA_BUFFER` as `FSCTL_GET_REPARSE_POINT` returned it): the
/// UTF-8 byte length of the target text after libuv's `fs__readlink_handle`
/// rules, or `None` when libuv would not read it as a link.
///
/// * A symbolic link's substitute name loses a leading `\??\` before a drive
///   letter (`\??\C:\x` → `C:\x`); `\??\UNC\server\share` becomes
///   `\\server\share`; anything else (a relative target, a volume path) is
///   kept as it is.
/// * A junction is a link only when its substitute name is `\??\X:` or
///   `\??\X:\...`, which loses the prefix; a volume mount point is not a link.
/// * An app execution alias is a link when its third string is an absolute
///   `X:\` path, and that string is the target.
/// * A lone surrogate counts three bytes (U+FFFD), as `WideCharToMultiByte` does.
pub fn reparse_target_len(buf: &[u8]) -> Option<usize> {
    let tag = read_u32(buf, 0)?;
    let data = buf.get(REPARSE_HEADER_BYTES..)?;
    let target = match tag {
        IO_REPARSE_TAG_SYMLINK => symlink_target(&substitute_name(data, SYMLINK_FIXED_BYTES)?),
        IO_REPARSE_TAG_MOUNT_POINT => {
            junction_target(&substitute_name(data, MOUNT_POINT_FIXED_BYTES)?)?
        }
        IO_REPARSE_TAG_APPEXECLINK => alias_target(data)?,
        _ => return None,
    };
    Some(utf8_len(&target))
}

/// The substitute name of a symbolic-link or mount-point buffer whose
/// `PathBuffer` starts `fixed` bytes into `data`.
fn substitute_name(data: &[u8], fixed: usize) -> Option<Vec<u16>> {
    let offset = usize::from(read_u16(data, 0)?);
    let length = usize::from(read_u16(data, 2)?);
    let path_buffer = data.get(fixed..)?;
    let bytes = path_buffer.get(offset..offset.checked_add(length)?)?;
    Some(units_of(bytes))
}

fn utf8_len(units: &[u16]) -> usize {
    char::decode_utf16(units.iter().copied())
        .map(|r| r.map_or(3, char::len_utf8))
        .sum()
}

fn is_ascii_letter(unit: u16) -> bool {
    u8::try_from(unit).is_ok_and(|b| b.is_ascii_alphabetic())
}

/// `\??\X:` or `\??\X:\...`.
fn is_nt_drive(w: &[u16]) -> bool {
    w.starts_with(&NT_PREFIX)
        && w.len() >= 6
        && w.get(4).is_some_and(|c| is_ascii_letter(*c))
        && w.get(5) == Some(&COLON)
        && (w.len() == 6 || w.get(6) == Some(&BACKSLASH))
}

/// `\??\UNC\...`, the `UNC` in any case.
fn is_nt_unc(w: &[u16]) -> bool {
    w.starts_with(&NT_PREFIX)
        && w.len() >= 8
        && w.get(4..7).is_some_and(|unc| {
            unc.iter()
                .zip(b"UNC")
                .all(|(u, c)| u8::try_from(*u).is_ok_and(|b| b.eq_ignore_ascii_case(c)))
        })
        && w.get(7) == Some(&BACKSLASH)
}

/// libuv drops four units for `\??\X:` and six for `\??\UNC\`, then
/// overwrites the `C` with a backslash; that overwrite is one ASCII unit for
/// another and changes nothing the walk records (the UTF-8 length), so only
/// the drop is done here.
fn symlink_target(w: &[u16]) -> Vec<u16> {
    if is_nt_drive(w) {
        return w.get(4..).map_or_else(Vec::new, <[u16]>::to_vec);
    }
    if is_nt_unc(w) {
        return w.get(6..).map_or_else(Vec::new, <[u16]>::to_vec);
    }
    w.to_vec()
}

fn junction_target(w: &[u16]) -> Option<Vec<u16>> {
    is_nt_drive(w).then(|| w.get(4..).map_or_else(Vec::new, <[u16]>::to_vec))
}

fn alias_target(data: &[u8]) -> Option<Vec<u16>> {
    if read_u32(data, 0)? < ALIAS_MIN_STRINGS {
        return None;
    }
    let list = units_of(data.get(ALIAS_FIXED_BYTES..)?);
    let mut rest = list.as_slice();
    for _ in 0..2 {
        let len = rest.iter().position(|u| *u == 0)?;
        if len == 0 {
            return None;
        }
        rest = rest.get(len.checked_add(1)?..)?;
    }
    let len = rest.iter().position(|u| *u == 0)?;
    if len == 0 {
        return None;
    }
    let target = rest.get(..len)?;
    let absolute = target.len() >= 3
        && target.first().is_some_and(|c| is_ascii_letter(*c))
        && target.get(1) == Some(&COLON)
        && target.get(2) == Some(&BACKSLASH);
    absolute.then(|| target.to_vec())
}

/// What the directory itself contributes to every entry's facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DirFacts {
    /// The volume serial number (`dwVolumeSerialNumber`): Node's `dev`.
    pub dev: u32,
    /// Whether to record access times.
    pub want_atime: bool,
}

/// Where a reparse point's data comes from: the file itself on Windows, a
/// script in tests.
pub trait ReparseSource {
    /// The `REPARSE_DATA_BUFFER` of `dir\name`, or the Win32 error that
    /// opening (with `FILE_FLAG_OPEN_REPARSE_POINT`) or reading it raised.
    fn reparse_data(&self, dir: &Path, name: &[u16]) -> Result<Vec<u8>, u32>;
}

/// Whether a listed name, joined onto its folder's path, names that entry
/// and nothing else: not empty, and none of [`NOT_IN_A_NAME`].
fn is_one_name(name_utf16le: &[u8]) -> bool {
    !name_utf16le.is_empty()
        && name_utf16le
            .chunks_exact(2)
            .all(|pair| !NOT_IN_A_NAME.contains(&unit_of(pair)))
}

/// Stages one record into `out` as the legacy walker would record it (see
/// the module docs), or counts it the way a failed `lstat` is counted.
///
/// A name that is not one name is counted unreadable and staged nowhere:
/// joined onto `dir`, it would name something else — another file (`a\b`),
/// a stream (`a:b`), the folder itself (a name cut to nothing at a leading
/// NUL) — for the reparse read below and for every action on the entry
/// later. NTFS's POSIX namespace allows `\` and `:` (a file made from
/// Linux), so a listing can return one; the legacy walker's `lstat` of the
/// joined path fails for it too.
pub fn stage_record(
    rec: &Record<'_>,
    facts: DirFacts,
    dir: &Path,
    reparse: &dyn ReparseSource,
    out: &mut Listing,
) {
    if !is_one_name(rec.name) {
        out.unreadable_entries = out.unreadable_entries.saturating_add(1);
        return;
    }
    let attrs = rec.attributes;
    let is_dir = attrs & FILE_ATTRIBUTE_DIRECTORY != 0;
    let is_reparse = attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    let tag = if is_reparse { rec.reparse_tag } else { 0 };
    // A negative size or allocation cannot come from the kernel (a corrupt
    // record) and reads as 0, as the Linux fallback reads a negative `st_size`.
    let behind = if is_dir {
        0.0
    } else {
        rec.end_of_file.max(0) as f64
    };
    let class = link_class(tag);
    let (kind, size) = match (is_reparse, class) {
        (false, _) if is_dir => (KIND_DIR, 0.0),
        (false, _) => (KIND_FILE, behind),
        (true, LinkClass::Unfollowable) => {
            count_entry_error(ERROR_CANT_ACCESS_FILE, out);
            return;
        }
        (true, LinkClass::Followed) => (KIND_SYMLINK, behind),
        (true, LinkClass::Link | LinkClass::Alias) => {
            let data = match reparse.reparse_data(dir, &rec.name_units()) {
                Ok(data) => data,
                Err(code) => {
                    count_entry_error(code, out);
                    return;
                }
            };
            match (reparse_target_len(&data), class) {
                (Some(len), _) => (KIND_SYMLINK, len as f64),
                (None, LinkClass::Alias) => {
                    count_entry_error(ERROR_CANT_ACCESS_FILE, out);
                    return;
                }
                (None, _) => (KIND_SYMLINK, behind),
            }
        }
    };
    let alloc = if kind == KIND_DIR {
        0.0
    } else {
        rec.allocation.map_or(0.0, |a| a.max(0) as f64)
    };
    let withheld = kind != KIND_DIR && (rec.allocation.is_none() || rec.file_id.is_none());
    let flags = if is_dataless(attrs, tag) {
        FLAG_DATALESS
    } else {
        0
    };
    let atime_ms = if facts.want_atime {
        filetime_ms(rec.last_access)
    } else {
        f64::NAN
    };
    out.push(
        rec.name_string().as_bytes(),
        Meta {
            kind,
            flags,
            size,
            alloc,
            mtime_ms: filetime_ms(rec.last_write),
            atime_ms,
            dev: f64::from(facts.dev),
            ino: rec.file_id.unwrap_or(0),
            nlink: 0,
            withheld,
        },
    );
}

/// The legacy walker's accounting for an entry whose `lstat` failed: denied
/// for what Node reports as `EACCES`/`EPERM`, nothing for a vanished entry,
/// unreadable otherwise.
pub fn count_entry_error(code: u32, out: &mut Listing) {
    match refusal_from_win32(code) {
        Refusal::Denied => out.denied_entries = out.denied_entries.saturating_add(1),
        Refusal::Vanished => {}
        Refusal::Unreadable => {
            out.unreadable_entries = out.unreadable_entries.saturating_add(1);
        }
    }
}

/// A Win32 error as libuv maps it to an errno, then as the legacy walker
/// classifies that errno: `EACCES`/`EPERM` denied, `ENOENT`/`ENOTDIR`
/// vanished, everything else unreadable.
pub fn refusal_from_win32(code: u32) -> Refusal {
    match code {
        ERROR_ACCESS_DENIED
        | ERROR_NOACCESS
        | ERROR_ELEVATION_REQUIRED
        | ERROR_CANT_ACCESS_FILE
        | ERROR_PRIVILEGE_NOT_HELD => Refusal::Denied,
        ERROR_FILE_NOT_FOUND
        | ERROR_PATH_NOT_FOUND
        | ERROR_INVALID_NAME
        | ERROR_INVALID_DRIVE
        | ERROR_INVALID_REPARSE_DATA
        | ERROR_DIRECTORY => Refusal::Vanished,
        _ => Refusal::Unreadable,
    }
}

/// True when `path` holds a NUL: a Win32 call given such a path would stop
/// reading at the NUL and silently open the truncated path instead.
pub fn has_embedded_nul(path: &str) -> bool {
    path.bytes().any(|b| b == 0)
}

/// `path` with the `\\?\` prefix that lifts the 260-character limit: slashes
/// become backslashes, `\\server\share` becomes `\\?\UNC\server\share`, a
/// drive path gets `\\?\`, and a path that already has a `\\?\`, `\\.\` or
/// `\??\` prefix, or is not absolute, is left as it is.
pub fn prefixed_path(path: &str) -> String {
    let normalised = path.replace('/', "\\");
    if normalised.starts_with("\\\\?\\")
        || normalised.starts_with("\\\\.\\")
        || normalised.starts_with("\\??\\")
    {
        return normalised;
    }
    if let Some(unc) = normalised.strip_prefix("\\\\") {
        return format!("\\\\?\\UNC\\{unc}");
    }
    let bytes = normalised.as_bytes();
    let is_drive = bytes.first().is_some_and(u8::is_ascii_alphabetic)
        && bytes.get(1) == Some(&b':')
        && (bytes.len() == 2 || bytes.get(2) == Some(&b'\\'));
    if is_drive && bytes.len() > 2 {
        return format!("\\\\?\\{normalised}");
    }
    normalised
}

#[cfg(windows)]
const _: () = {
    use windows_sys::Win32::Foundation as f;
    use windows_sys::Win32::Storage::FileSystem as fs;
    use windows_sys::Win32::System::SystemServices as s;
    assert!(FILE_ATTRIBUTE_DIRECTORY == fs::FILE_ATTRIBUTE_DIRECTORY);
    assert!(FILE_ATTRIBUTE_REPARSE_POINT == fs::FILE_ATTRIBUTE_REPARSE_POINT);
    assert!(FILE_ATTRIBUTE_OFFLINE == fs::FILE_ATTRIBUTE_OFFLINE);
    assert!(FILE_ATTRIBUTE_RECALL_ON_OPEN == fs::FILE_ATTRIBUTE_RECALL_ON_OPEN);
    assert!(FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS == fs::FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS);
    assert!(IO_REPARSE_TAG_MOUNT_POINT == s::IO_REPARSE_TAG_MOUNT_POINT);
    assert!(IO_REPARSE_TAG_SYMLINK == s::IO_REPARSE_TAG_SYMLINK);
    assert!(IO_REPARSE_TAG_APPEXECLINK == s::IO_REPARSE_TAG_APPEXECLINK);
    assert!(IO_REPARSE_TAG_CLOUD == s::IO_REPARSE_TAG_CLOUD);
    assert!(IO_REPARSE_TAG_CLOUD_MASK == s::IO_REPARSE_TAG_CLOUD_MASK);
    assert!(IO_REPARSE_TAG_WOF == s::IO_REPARSE_TAG_WOF);
    assert!(IO_REPARSE_TAG_AF_UNIX == s::IO_REPARSE_TAG_AF_UNIX);
    assert!(ERROR_FILE_NOT_FOUND == f::ERROR_FILE_NOT_FOUND);
    assert!(ERROR_PATH_NOT_FOUND == f::ERROR_PATH_NOT_FOUND);
    assert!(ERROR_ACCESS_DENIED == f::ERROR_ACCESS_DENIED);
    assert!(ERROR_INVALID_DATA == f::ERROR_INVALID_DATA);
    assert!(ERROR_INVALID_DRIVE == f::ERROR_INVALID_DRIVE);
    assert!(ERROR_NO_MORE_FILES == f::ERROR_NO_MORE_FILES);
    assert!(ERROR_SHARING_VIOLATION == f::ERROR_SHARING_VIOLATION);
    assert!(ERROR_NOT_SUPPORTED == f::ERROR_NOT_SUPPORTED);
    assert!(ERROR_INVALID_PARAMETER == f::ERROR_INVALID_PARAMETER);
    assert!(ERROR_INVALID_NAME == f::ERROR_INVALID_NAME);
    assert!(ERROR_DIRECTORY == f::ERROR_DIRECTORY);
    assert!(ERROR_ELEVATION_REQUIRED == f::ERROR_ELEVATION_REQUIRED);
    assert!(ERROR_OPERATION_ABORTED == f::ERROR_OPERATION_ABORTED);
    assert!(ERROR_NOACCESS == f::ERROR_NOACCESS);
    assert!(ERROR_PRIVILEGE_NOT_HELD == f::ERROR_PRIVILEGE_NOT_HELD);
    assert!(ERROR_CANT_ACCESS_FILE == f::ERROR_CANT_ACCESS_FILE);
    assert!(ERROR_INVALID_REPARSE_DATA == f::ERROR_INVALID_REPARSE_DATA);
    assert!(RECORD_HEADER_BYTES == std::mem::offset_of!(fs::FILE_ID_EXTD_DIR_INFO, FileName));
    assert!(fs::MAXIMUM_REPARSE_DATA_BUFFER_SIZE == 16 * 1024);
};

#[cfg(windows)]
mod os {
    use std::ffi::{OsString, c_void};
    use std::os::windows::ffi::OsStringExt;
    use std::path::{Path, PathBuf};
    use std::ptr;

    use windows_sys::Win32::Foundation::{
        CloseHandle, FILETIME, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_TAG_INFO,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        FIND_FIRST_EX_LARGE_FETCH, FileAttributeTagInfo, FileIdExtdDirectoryInfo,
        FileIdExtdDirectoryRestartInfo, FindClose, FindExInfoBasic, FindExSearchNameMatch,
        FindFirstFileExW, FindNextFileW, GetFileInformationByHandle, GetFileInformationByHandleEx,
        OPEN_EXISTING, WIN32_FIND_DATAW,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;
    use windows_sys::Win32::System::Ioctl::FSCTL_GET_REPARSE_POINT;
    use windows_sys::Win32::System::Threading::{GetCurrentThread, GetThreadTimes};

    use super::{
        DirFacts, ERROR_CANT_ACCESS_FILE, ERROR_DIRECTORY, ERROR_FILE_NOT_FOUND,
        ERROR_INVALID_DATA, ERROR_INVALID_NAME, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES,
        ERROR_NOT_SUPPORTED, ERROR_OPERATION_ABORTED, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT, FLAG_DATALESS, KIND_DIR, KIND_FILE, KIND_SYMLINK, LinkClass,
        Record, ReparseSource, filetime_ms, has_embedded_nul, is_dataless, is_dot_entry,
        link_class, parse_records, prefixed_path, refusal_from_win32, reparse_target_len,
        stage_record,
    };
    use crate::output::Refusal;
    use crate::platform::{DirTimes, ListBuffer, Lister, Listing, Meta};
    use crate::{FastPath, Probe};

    /// The probe's own listing buffer.
    const PROBE_BUFFER_BYTES: usize = 64 * 1024;
    /// `MAXIMUM_REPARSE_DATA_BUFFER_SIZE`: what `FSCTL_GET_REPARSE_POINT` can return.
    const REPARSE_BUFFER_BYTES: usize = 16 * 1024;
    /// How every directory and reparse point is opened: as a backup operator
    /// would, and never through a reparse point.
    const OPEN_FLAGS: u32 = FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT;
    /// Every sharing mode: a listing must never block a writer or a delete.
    const SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
    /// FILETIME ticks per second, as a double.
    const TICKS_PER_SECOND_F64: f64 = 1e7;
    /// Records per batch of the `FindNextFileW` fallback, which answers one
    /// record per call: the walk's stop flag is checked before each batch and
    /// its heartbeat bumped after it, as `list_extd` does per call, and the
    /// last, partial batch beats when the search ends. The same cadence as
    /// macOS's per-entry fallback.
    const FIND_BATCH: usize = 256;

    /// An open file or directory handle, closed on drop.
    struct Handle(HANDLE);

    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: `self.0` came from a successful CreateFileW (so it is not
            // INVALID_HANDLE_VALUE) and is closed exactly once, here.
            unsafe { CloseHandle(self.0) };
        }
    }

    /// An open search handle, closed on drop.
    struct FindHandle(HANDLE);

    impl Drop for FindHandle {
        fn drop(&mut self) {
            // SAFETY: `self.0` came from a successful FindFirstFileExW and is
            // closed exactly once, here.
            unsafe { FindClose(self.0) };
        }
    }

    fn last_error() -> u32 {
        // SAFETY: GetLastError reads the calling thread's error slot; no preconditions.
        unsafe { GetLastError() }
    }

    fn os_error(code: u32) -> std::io::Error {
        std::io::Error::from_raw_os_error(i32::try_from(code).unwrap_or(i32::MAX))
    }

    /// `path` as a NUL-terminated UTF-16 `\\?\` path, or `ERROR_INVALID_NAME`
    /// when the path holds a NUL of its own: passed on, that NUL would end the
    /// string early and the call would silently open a truncated path.
    fn wide(path: &Path) -> Result<Vec<u16>, u32> {
        let text = path.to_string_lossy();
        if has_embedded_nul(&text) {
            return Err(ERROR_INVALID_NAME);
        }
        Ok(prefixed_path(&text)
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect())
    }

    fn join_wide(dir: &Path, name: &[u16]) -> PathBuf {
        dir.join(OsString::from_wide(name))
    }

    fn struct_size<T>() -> u32 {
        u32::try_from(std::mem::size_of::<T>()).unwrap_or(u32::MAX)
    }

    #[expect(
        clippy::cast_possible_wrap,
        reason = "a FILETIME is a signed 64-bit tick count split in two words"
    )]
    fn ticks(t: FILETIME) -> i64 {
        ((u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime)) as i64
    }

    fn size_of_parts(high: u32, low: u32) -> u64 {
        (u64::from(high) << 32) | u64::from(low)
    }

    /// Opens `path` itself (never through a final reparse point unless
    /// `flags` says so) for `access`, sharing everything.
    fn open(path: &Path, access: u32, flags: u32) -> Result<Handle, u32> {
        let name = wide(path)?;
        // SAFETY: `name` is NUL-terminated and outlives the call; no security
        // attributes and no template handle are passed; OPEN_EXISTING creates nothing.
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                access,
                SHARE_ALL,
                ptr::null(),
                OPEN_EXISTING,
                flags,
                ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(last_error());
        }
        Ok(Handle(handle))
    }

    fn by_handle_info(handle: &Handle) -> Result<BY_HANDLE_FILE_INFORMATION, u32> {
        // SAFETY: all-zero is a valid BY_HANDLE_FILE_INFORMATION (plain integers).
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: `handle` is open and `info` is a writable struct of the type the call fills.
        let ok = unsafe { GetFileInformationByHandle(handle.0, &raw mut info) };
        if ok == 0 {
            return Err(last_error());
        }
        Ok(info)
    }

    fn reparse_tag_of(handle: &Handle) -> Result<u32, u32> {
        // SAFETY: all-zero is a valid FILE_ATTRIBUTE_TAG_INFO.
        let mut info: FILE_ATTRIBUTE_TAG_INFO = unsafe { std::mem::zeroed() };
        // SAFETY: `handle` is open; the pointer and size describe a writable
        // FILE_ATTRIBUTE_TAG_INFO owned by this frame, the class the call fills.
        let ok = unsafe {
            GetFileInformationByHandleEx(
                handle.0,
                FileAttributeTagInfo,
                (&raw mut info).cast::<c_void>(),
                struct_size::<FILE_ATTRIBUTE_TAG_INFO>(),
            )
        };
        if ok == 0 {
            return Err(last_error());
        }
        Ok(info.ReparseTag)
    }

    /// The `REPARSE_DATA_BUFFER` behind `handle`, exactly the bytes returned.
    fn read_reparse(handle: &Handle) -> Result<Vec<u8>, u32> {
        let mut buf = vec![0_u8; REPARSE_BUFFER_BYTES];
        let mut returned = 0_u32;
        // SAFETY: `handle` is open; no input buffer is passed; the output
        // pointer and size describe `buf`, writable for its whole length;
        // `returned` is a live u32 owned by this frame; no overlapped I/O.
        let ok = unsafe {
            DeviceIoControl(
                handle.0,
                FSCTL_GET_REPARSE_POINT,
                ptr::null(),
                0,
                buf.as_mut_ptr().cast::<c_void>(),
                u32::try_from(buf.len()).unwrap_or(u32::MAX),
                &raw mut returned,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(last_error());
        }
        buf.truncate(usize::try_from(returned).unwrap_or(0));
        Ok(buf)
    }

    /// The reparse source for real entries: opens `dir\name` itself and reads its data.
    #[derive(Debug, Clone, Copy, Default)]
    pub struct FileReparse;

    impl ReparseSource for FileReparse {
        fn reparse_data(&self, dir: &Path, name: &[u16]) -> Result<Vec<u8>, u32> {
            let handle = open(&join_wide(dir, name), FILE_READ_ATTRIBUTES, OPEN_FLAGS)?;
            read_reparse(&handle)
        }
    }

    /// `path` itself as Node's `lstat` reports it: kind by libuv's rule (a
    /// readable link is a symbolic link sized by its target; any other reparse
    /// point is the object behind it), sizes, times, `dev`, `ino` and the link
    /// count from `BY_HANDLE_FILE_INFORMATION`. That structure has no
    /// allocation size, so a file is marked withheld; the walk only ever asks
    /// about the root, which must be a directory.
    pub fn stat_path(path: &Path, want_atime: bool) -> Result<Meta, u32> {
        let handle = open(path, FILE_READ_ATTRIBUTES, OPEN_FLAGS)?;
        let info = by_handle_info(&handle)?;
        let attrs = info.dwFileAttributes;
        let is_dir = attrs & FILE_ATTRIBUTE_DIRECTORY != 0;
        let mut kind = if is_dir { KIND_DIR } else { KIND_FILE };
        let mut size = if is_dir {
            0.0
        } else {
            size_of_parts(info.nFileSizeHigh, info.nFileSizeLow) as f64
        };
        let mut tag = 0;
        if attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            tag = reparse_tag_of(&handle)?;
            let class = link_class(tag);
            match class {
                LinkClass::Link | LinkClass::Alias => {
                    match reparse_target_len(&read_reparse(&handle)?) {
                        Some(len) => {
                            kind = KIND_SYMLINK;
                            size = len as f64;
                        }
                        None if class == LinkClass::Alias => return Err(ERROR_CANT_ACCESS_FILE),
                        None => {}
                    }
                }
                LinkClass::Unfollowable => return Err(ERROR_CANT_ACCESS_FILE),
                LinkClass::Followed => {}
            }
        }
        let flags = if is_dataless(attrs, tag) {
            FLAG_DATALESS
        } else {
            0
        };
        let times = own_times(&info, want_atime);
        Ok(Meta {
            kind,
            flags,
            size,
            alloc: 0.0,
            mtime_ms: times.mtime_ms,
            atime_ms: times.atime_ms,
            dev: f64::from(info.dwVolumeSerialNumber),
            ino: u128::from(size_of_parts(info.nFileIndexHigh, info.nFileIndexLow)),
            nlink: if is_dir { 0 } else { info.nNumberOfLinks },
            withheld: kind != KIND_DIR,
        })
    }

    /// A handle's own last-write and last-access times, as libuv's `lstat`
    /// computes them: the directory's own record, not its parent's index copy.
    fn own_times(info: &BY_HANDLE_FILE_INFORMATION, want_atime: bool) -> DirTimes {
        DirTimes {
            mtime_ms: filetime_ms(ticks(info.ftLastWriteTime)),
            atime_ms: if want_atime {
                filetime_ms(ticks(info.ftLastAccessTime))
            } else {
                f64::NAN
            },
        }
    }

    /// Opens `dir` to list it. The listing types every reparse point as a
    /// link and never enqueues one, so a reparse point found here is either
    /// the root or a replacement since the parent was listed: a real link is
    /// refused as not a directory, a cloud placeholder (or any other tag with
    /// a filter behind it) is reopened through its filter exactly as `readdir`
    /// opens it, and a tag Windows cannot follow is refused as `lstat` would be.
    fn open_dir(dir: &Path) -> Result<(Handle, BY_HANDLE_FILE_INFORMATION), u32> {
        let handle = open(dir, FILE_LIST_DIRECTORY, OPEN_FLAGS)?;
        let info = by_handle_info(&handle)?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            return Err(ERROR_DIRECTORY);
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
            return Ok((handle, info));
        }
        let class = link_class(reparse_tag_of(&handle)?);
        let follow = match class {
            LinkClass::Followed => true,
            LinkClass::Unfollowable => false,
            LinkClass::Link | LinkClass::Alias => {
                if reparse_target_len(&read_reparse(&handle)?).is_some() {
                    return Err(ERROR_DIRECTORY);
                }
                class == LinkClass::Link
            }
        };
        if !follow {
            return Err(ERROR_CANT_ACCESS_FILE);
        }
        drop(handle);
        let followed = open(dir, FILE_LIST_DIRECTORY, FILE_FLAG_BACKUP_SEMANTICS)?;
        let info = by_handle_info(&followed)?;
        Ok((followed, info))
    }

    /// How a bulk listing ended other than with an error.
    enum Outcome {
        /// Every batch was parsed into the listing.
        Listed,
        /// The very first call was refused with `ERROR_INVALID_PARAMETER` or
        /// `ERROR_NOT_SUPPORTED`: this volume has no file ids; nothing was read.
        Unsupported(u32),
    }

    /// The `FileIdExtdDirectoryInfo` loop over `handle` into `buf.raw`, staging
    /// every batch; the walk's stop flag is checked before each call and its
    /// heartbeat bumped after each answer.
    fn list_extd(
        handle: &Handle,
        dir: &Path,
        facts: DirFacts,
        buf: &mut ListBuffer,
    ) -> Result<Outcome, u32> {
        let size = u32::try_from(buf.raw.len()).unwrap_or(u32::MAX);
        let mut class = FileIdExtdDirectoryRestartInfo;
        let mut first = true;
        loop {
            if buf.stopped() {
                // The walk discards the listing on cancel, so which error ends it is immaterial.
                return Err(ERROR_OPERATION_ABORTED);
            }
            // SAFETY: `handle` is an open directory; the pointer and `size`
            // describe `buf.raw`, writable for its whole length; the class is a
            // directory-listing class the call fills in place.
            let ok = unsafe {
                GetFileInformationByHandleEx(
                    handle.0,
                    class,
                    buf.raw.as_mut_ptr().cast::<c_void>(),
                    size,
                )
            };
            if ok == 0 {
                let code = last_error();
                if code == ERROR_NO_MORE_FILES {
                    // The end is an answer too: even an empty volume root beats once.
                    buf.beat();
                    return Ok(Outcome::Listed);
                }
                if first && (code == ERROR_INVALID_PARAMETER || code == ERROR_NOT_SUPPORTED) {
                    return Ok(Outcome::Unsupported(code));
                }
                return Err(code);
            }
            buf.beat();
            first = false;
            class = FileIdExtdDirectoryInfo;
            let listing = &mut buf.listing;
            parse_records(&buf.raw, &mut |rec: &Record<'_>| {
                stage_record(rec, facts, dir, &FileReparse, listing);
            })
            .map_err(|_| ERROR_INVALID_DATA)?;
        }
    }

    /// The fallback: `FindFirstFileExW` over `dir\*`, staging each record into
    /// `buf.listing`; no allocation size and no file id, so every leaf is
    /// withheld. The walk's two signals are paced by [`FIND_BATCH`].
    fn list_find(dir: &Path, facts: DirFacts, buf: &mut ListBuffer) -> Result<(), u32> {
        if buf.stopped() {
            // The walk discards the listing on cancel, so which error ends it is immaterial.
            return Err(ERROR_OPERATION_ABORTED);
        }
        let pattern = wide(&dir.join("*"))?;
        // SAFETY: all-zero is a valid WIN32_FIND_DATAW.
        let mut data: WIN32_FIND_DATAW = unsafe { std::mem::zeroed() };
        // SAFETY: `pattern` is NUL-terminated; the pointer is a writable
        // WIN32_FIND_DATAW, which is what FindExInfoBasic fills; no search
        // filter is passed, as FindExSearchNameMatch requires.
        let handle = unsafe {
            FindFirstFileExW(
                pattern.as_ptr(),
                FindExInfoBasic,
                (&raw mut data).cast::<c_void>(),
                FindExSearchNameMatch,
                ptr::null(),
                FIND_FIRST_EX_LARGE_FETCH,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let code = last_error();
            // A volume root with nothing in it has no `.` either; that answer beats too.
            return if code == ERROR_FILE_NOT_FOUND {
                buf.beat();
                Ok(())
            } else {
                Err(code)
            };
        }
        let find = FindHandle(handle);
        let mut name = Vec::new();
        let mut in_batch = 0_usize;
        loop {
            stage_find(&data, &mut name, facts, dir, &mut buf.listing);
            in_batch += 1;
            if in_batch == FIND_BATCH {
                buf.beat();
                in_batch = 0;
                if buf.stopped() {
                    // As above: the walk discards a cancelled listing.
                    return Err(ERROR_OPERATION_ABORTED);
                }
            }
            // SAFETY: `find` is an open search handle and `data` a writable WIN32_FIND_DATAW.
            let ok = unsafe { FindNextFileW(find.0, &raw mut data) };
            if ok == 0 {
                let code = last_error();
                return if code == ERROR_NO_MORE_FILES {
                    // The end is an answer too: the last, partial batch beats here.
                    buf.beat();
                    Ok(())
                } else {
                    Err(code)
                };
            }
        }
    }

    fn stage_find(
        data: &WIN32_FIND_DATAW,
        name: &mut Vec<u8>,
        facts: DirFacts,
        dir: &Path,
        out: &mut Listing,
    ) {
        let len = data
            .cFileName
            .iter()
            .position(|u| *u == 0)
            .unwrap_or(data.cFileName.len());
        name.clear();
        name.extend(
            data.cFileName
                .iter()
                .take(len)
                .flat_map(|u| u.to_le_bytes()),
        );
        if is_dot_entry(name) {
            return;
        }
        let record = Record {
            name,
            attributes: data.dwFileAttributes,
            reparse_tag: data.dwReserved0,
            end_of_file: i64::try_from(size_of_parts(data.nFileSizeHigh, data.nFileSizeLow))
                .unwrap_or(i64::MAX),
            allocation: None,
            last_write: ticks(data.ftLastWriteTime),
            last_access: ticks(data.ftLastAccessTime),
            file_id: None,
        };
        stage_record(&record, facts, dir, &FileReparse, out);
    }

    /// The Windows lister: `FileIdExtdDirectoryInfo` first, `FindFirstFileExW`
    /// where a volume refuses it.
    #[derive(Debug, Clone, Copy, Default)]
    pub struct WindowsLister;

    impl WindowsLister {
        /// The lister.
        pub fn new() -> Self {
            Self
        }
    }

    impl Lister for WindowsLister {
        fn stat_dir(&self, path: &Path, want_atime: bool) -> Result<Meta, Refusal> {
            stat_path(path, want_atime).map_err(refusal_from_win32)
        }

        fn list(
            &self,
            dir: &Path,
            want_atime: bool,
            buf: &mut ListBuffer,
        ) -> Result<FastPath, Refusal> {
            buf.listing.clear();
            let (handle, info) = open_dir(dir).map_err(refusal_from_win32)?;
            let facts = DirFacts {
                dev: info.dwVolumeSerialNumber,
                want_atime,
            };
            // The directory's own times, from the handle this listing opened:
            // its parent's index holds a lazily updated copy (see DirTimes).
            let times = own_times(&info, want_atime);
            let path = match list_extd(&handle, dir, facts, buf) {
                Ok(Outcome::Listed) => FastPath::ExtdDirInfo,
                Ok(Outcome::Unsupported(_code)) => {
                    drop(handle);
                    buf.listing.clear();
                    list_find(dir, facts, buf).map_err(refusal_from_win32)?;
                    FastPath::PerEntry
                }
                Err(code) => return Err(refusal_from_win32(code)),
            };
            buf.listing.own_times = Some(times);
            Ok(path)
        }
    }

    /// [`crate::probe`] on Windows: reads the root's own facts, opens it, and
    /// lists it once with `FileIdExtdDirectoryInfo`.
    pub fn probe(root: &Path) -> Probe {
        let unavailable = |reason: String| Probe {
            fast_path: FastPath::Unavailable,
            reason,
        };
        match stat_path(root, false) {
            Err(code) => {
                return unavailable(format!("the root could not be read: {}", os_error(code)));
            }
            Ok(meta) if meta.kind != KIND_DIR => {
                return unavailable("the root is not a directory".to_owned());
            }
            Ok(_) => {}
        }
        let (handle, info) = match open_dir(root) {
            Ok(opened) => opened,
            Err(code) => {
                return unavailable(format!(
                    "the root directory could not be opened: {}",
                    os_error(code)
                ));
            }
        };
        let facts = DirFacts {
            dev: info.dwVolumeSerialNumber,
            want_atime: false,
        };
        let mut buf = ListBuffer::new(PROBE_BUFFER_BYTES);
        match list_extd(&handle, root, facts, &mut buf) {
            Ok(Outcome::Listed) => Probe {
                fast_path: FastPath::ExtdDirInfo,
                reason: format!(
                    "FileIdExtdDirectoryInfo listed the root directory ({} entries)",
                    buf.listing.len()
                ),
            },
            Ok(Outcome::Unsupported(code)) => Probe {
                fast_path: FastPath::PerEntry,
                reason: format!(
                    "FileIdExtdDirectoryInfo refused the root with {}; FindFirstFileExW is used, which reports no file ids or allocation sizes on this volume",
                    os_error(code)
                ),
            },
            Err(code) => unavailable(format!(
                "FileIdExtdDirectoryInfo failed on the root: {}",
                os_error(code)
            )),
        }
    }

    /// The calling thread's own CPU time in seconds from `GetThreadTimes`
    /// (kernel plus user); NaN when the call fails.
    pub fn thread_cpu_seconds() -> f64 {
        // SAFETY: all-zero is a valid FILETIME.
        let mut creation: FILETIME = unsafe { std::mem::zeroed() };
        // SAFETY: as above.
        let mut exit: FILETIME = unsafe { std::mem::zeroed() };
        // SAFETY: as above.
        let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
        // SAFETY: as above.
        let mut user: FILETIME = unsafe { std::mem::zeroed() };
        // SAFETY: GetCurrentThread's pseudo-handle is always valid for the
        // calling thread; the four pointers are live, writable FILETIMEs owned
        // by this frame. The call only reads the thread.
        let ok = unsafe {
            GetThreadTimes(
                GetCurrentThread(),
                &raw mut creation,
                &raw mut exit,
                &raw mut kernel,
                &raw mut user,
            )
        };
        if ok == 0 {
            return f64::NAN;
        }
        (ticks(kernel).saturating_add(ticks(user))) as f64 / TICKS_PER_SECOND_F64
    }
}

#[cfg(windows)]
pub use os::{FileReparse, WindowsLister, probe, stat_path, thread_cpu_seconds};

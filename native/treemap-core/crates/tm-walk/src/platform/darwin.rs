//! macOS: one `getattrlistbulk(2)` call per directory batch, on a descriptor
//! opened `O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC`, with the
//! per-entry listing as the fallback when a volume refuses the call.
//!
//! The requested set is `RETURNED_ATTRS | ERROR | NAME | DEVID | OBJTYPE |
//! MODTIME | ACCTIME (when atime is wanted) | FLAGS | FILEID` and
//! `FILE_LINKCOUNT | FILE_ALLOCSIZE | FILE_DATALENGTH`. Every entry is parsed
//! through its own returned-attribute set, in the documented order: the `u32`
//! length, the `attribute_set_t`, `ATTR_CMN_ERROR` (only when returned), then
//! the common attributes in bit order and the file attributes in bit order,
//! each 4-byte aligned. A field that was not returned is never read: the
//! column keeps its "unknown" value and the entry is marked withheld.
//!
//! Three constants the `libc` crate (0.2.189) lacks are defined here from the
//! SDK headers: `ATTR_CMN_ERROR`, `SF_DATALESS` and the `vtype` values.

use std::ffi::{CString, c_void};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use super::per_entry;
use super::{ListBuffer, Lister, Listing, Meta, last_errno, refusal_from_errno, time_ms};
use crate::output::Refusal;
use crate::{FLAG_DATALESS, FastPath, KIND_DIR, KIND_FILE, KIND_SYMLINK, Probe};

/// `ATTR_CMN_ERROR` from `<sys/attr.h>`: a per-entry errno, packed right after
/// the returned set when it is returned. Not in `libc` 0.2.189.
pub const ATTR_CMN_ERROR: u32 = 0x2000_0000;
/// `SF_DATALESS` from `<sys/stat.h>`: the object's data is not present locally
/// (a cloud placeholder). Not in `libc` 0.2.189.
pub const SF_DATALESS: u32 = 0x4000_0000;
/// `enum vtype` from `<sys/vnode.h>` (`fsobj_type_t` values). Not in `libc`.
pub const VNON: u32 = 0;
/// A regular file.
pub const VREG: u32 = 1;
/// A directory.
pub const VDIR: u32 = 2;
/// A block device.
pub const VBLK: u32 = 3;
/// A character device.
pub const VCHR: u32 = 4;
/// A symbolic link.
pub const VLNK: u32 = 5;
/// A socket.
pub const VSOCK: u32 = 6;
/// A named pipe.
pub const VFIFO: u32 = 7;

/// The common attributes always requested (atime is added when wanted).
pub const COMMON_ATTRS: u32 = libc::ATTR_CMN_RETURNED_ATTRS
    | ATTR_CMN_ERROR
    | libc::ATTR_CMN_NAME
    | libc::ATTR_CMN_DEVID
    | libc::ATTR_CMN_OBJTYPE
    | libc::ATTR_CMN_MODTIME
    | libc::ATTR_CMN_FLAGS
    | libc::ATTR_CMN_FILEID;
/// The file attributes requested.
pub const FILE_ATTRS: u32 =
    libc::ATTR_FILE_LINKCOUNT | libc::ATTR_FILE_ALLOCSIZE | libc::ATTR_FILE_DATALENGTH;
/// The probe's own listing buffer.
const PROBE_BUFFER_BYTES: usize = 64 * 1024;
/// Bytes before the first attribute: the `u32` length and the five-word `attribute_set_t`.
const HEADER_BYTES: usize = 4 + 5 * 4;
/// A `timespec` in the buffer: two 64-bit words in 64-bit code.
const TIMESPEC_BYTES: usize = 16;

/// The macOS lister. `per_entry_only` skips the bulk call (for the harness and
/// the consistency test).
#[derive(Debug, Clone, Copy, Default)]
pub struct DarwinLister {
    per_entry_only: bool,
}

impl DarwinLister {
    /// Bulk first, per-entry where a volume refuses it.
    pub fn new() -> Self {
        Self {
            per_entry_only: false,
        }
    }

    /// Per-entry only.
    pub fn per_entry_only() -> Self {
        Self {
            per_entry_only: true,
        }
    }
}

impl Lister for DarwinLister {
    fn stat_dir(&self, path: &Path, want_atime: bool) -> Result<Meta, Refusal> {
        per_entry::lstat_meta(path, want_atime).map_err(refusal_from_errno)
    }

    fn list(
        &self,
        dir: &Path,
        want_atime: bool,
        buf: &mut ListBuffer,
    ) -> Result<FastPath, Refusal> {
        let fd = open_dir(dir).map_err(refusal_from_errno)?;
        buf.listing.clear();
        if !self.per_entry_only {
            match list_bulk(&fd, want_atime, buf) {
                Ok(BulkOutcome::Listed) => return Ok(FastPath::Bulk),
                Ok(BulkOutcome::Unsupported(_errno)) => {
                    buf.listing.clear();
                    // SAFETY: `fd` is an open directory; rewinding it has no other effect.
                    unsafe { libc::lseek(fd.as_raw_fd(), 0, libc::SEEK_SET) };
                }
                Err(errno) => return Err(refusal_from_errno(errno)),
            }
        }
        per_entry::list(fd, want_atime, &mut buf.listing).map_err(refusal_from_errno)?;
        Ok(FastPath::PerEntry)
    }
}

/// Opens `path` as a directory for reading, without following a final symlink.
pub fn open_dir(path: &Path) -> Result<OwnedFd, i32> {
    let c = CString::new(path.as_os_str().as_bytes()).map_err(|_| libc::EINVAL)?;
    // SAFETY: `c` is NUL-terminated; the flags open a directory read-only, refuse
    // a final symlink, and close the descriptor on exec.
    let fd = unsafe {
        libc::open(
            c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(last_errno());
    }
    // SAFETY: `fd` was just opened and nobody else owns it.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// How a bulk listing ended other than with an errno.
enum BulkOutcome {
    /// Every batch was parsed into the listing.
    Listed,
    /// The very first call was refused with `ENOTSUP` or `EINVAL`: this volume
    /// does not do bulk listing; nothing was read.
    Unsupported(i32),
}

/// The `getattrlistbulk` loop over `fd` into `buf.raw`, parsing every batch.
fn list_bulk(fd: &OwnedFd, want_atime: bool, buf: &mut ListBuffer) -> Result<BulkOutcome, i32> {
    let atime = if want_atime {
        libc::ATTR_CMN_ACCTIME
    } else {
        0
    };
    let mut attrs = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: COMMON_ATTRS | atime,
        volattr: 0,
        dirattr: 0,
        fileattr: FILE_ATTRS,
        forkattr: 0,
    };
    let ListBuffer { raw, listing } = buf;
    let mut first = true;
    loop {
        // SAFETY: `fd` is an open directory; `attrs` is a valid attrlist for the
        // call; `raw` is a writable buffer of exactly `raw.len()` bytes.
        let n = unsafe {
            libc::getattrlistbulk(
                fd.as_raw_fd(),
                (&raw mut attrs).cast::<c_void>(),
                raw.as_mut_ptr().cast::<c_void>(),
                raw.len(),
                0,
            )
        };
        if n < 0 {
            let errno = last_errno();
            if first && (errno == libc::ENOTSUP || errno == libc::EINVAL) {
                return Ok(BulkOutcome::Unsupported(errno));
            }
            return Err(errno);
        }
        if n == 0 {
            return Ok(BulkOutcome::Listed);
        }
        first = false;
        let count = usize::try_from(n).map_err(|_| libc::EIO)?;
        parse_batch(raw, count, want_atime, listing).map_err(|_| libc::EIO)?;
    }
}

/// A batch the kernel could not have written: the directory is unreadable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseError {
    /// Which entry of the batch was malformed.
    pub entry: usize,
    /// What was wrong with it.
    pub reason: &'static str,
}

/// Parses `count` entries from `raw` (as `getattrlistbulk` left them) into `out`.
/// Per-entry problems become counters; a malformed length is an error.
pub fn parse_batch(
    raw: &[u8],
    count: usize,
    want_atime: bool,
    out: &mut Listing,
) -> Result<(), ParseError> {
    let mut pos = 0_usize;
    for index in 0..count {
        let len = read_u32(raw, pos).ok_or(ParseError {
            entry: index,
            reason: "the entry length lies beyond the buffer",
        })? as usize;
        if len < HEADER_BYTES {
            return Err(ParseError {
                entry: index,
                reason: "the entry is shorter than its header",
            });
        }
        let end = pos
            .checked_add(len)
            .filter(|end| *end <= raw.len())
            .ok_or(ParseError {
                entry: index,
                reason: "the entry extends beyond the buffer",
            })?;
        let entry = raw.get(pos..end).ok_or(ParseError {
            entry: index,
            reason: "the entry range is not addressable",
        })?;
        match parse_entry(entry, want_atime, out) {
            Ok(()) | Err(Problem::Vanished) => {}
            Err(Problem::Denied) => out.denied_entries = out.denied_entries.saturating_add(1),
            Err(Problem::Unreadable) => {
                out.unreadable_entries = out.unreadable_entries.saturating_add(1);
            }
        }
        pos = end;
    }
    Ok(())
}

/// Why one entry was omitted.
enum Problem {
    Denied,
    Vanished,
    Unreadable,
}

fn problem_from_errno(errno: u32) -> Problem {
    match i32::try_from(errno) {
        Ok(libc::EACCES | libc::EPERM) => Problem::Denied,
        Ok(libc::ENOENT) => Problem::Vanished,
        _ => Problem::Unreadable,
    }
}

fn read_u32(buf: &[u8], pos: usize) -> Option<u32> {
    let bytes = buf.get(pos..pos.checked_add(4)?)?;
    Some(u32::from_ne_bytes(bytes.try_into().ok()?))
}

/// A bounds-checked reader over one entry.
struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl Cursor<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], Problem> {
        let end = self.pos.checked_add(n).ok_or(Problem::Unreadable)?;
        let bytes = self.buf.get(self.pos..end).ok_or(Problem::Unreadable)?;
        self.pos = end;
        Ok(bytes)
    }

    fn u32(&mut self) -> Result<u32, Problem> {
        let bytes = self.take(4)?;
        Ok(u32::from_ne_bytes(
            bytes.try_into().map_err(|_| Problem::Unreadable)?,
        ))
    }

    fn i32(&mut self) -> Result<i32, Problem> {
        let bytes = self.take(4)?;
        Ok(i32::from_ne_bytes(
            bytes.try_into().map_err(|_| Problem::Unreadable)?,
        ))
    }

    fn u64(&mut self) -> Result<u64, Problem> {
        let bytes = self.take(8)?;
        Ok(u64::from_ne_bytes(
            bytes.try_into().map_err(|_| Problem::Unreadable)?,
        ))
    }

    fn i64(&mut self) -> Result<i64, Problem> {
        let bytes = self.take(8)?;
        Ok(i64::from_ne_bytes(
            bytes.try_into().map_err(|_| Problem::Unreadable)?,
        ))
    }

    /// A `timespec`: seconds then nanoseconds, both 64-bit, 4-byte aligned.
    fn timespec(&mut self) -> Result<(i64, i64), Problem> {
        let sec = self.i64()?;
        let nsec = self.i64()?;
        Ok((sec, nsec))
    }
}

/// One entry, through its own returned set.
fn parse_entry(entry: &[u8], want_atime: bool, out: &mut Listing) -> Result<(), Problem> {
    let mut cur = Cursor { buf: entry, pos: 4 };
    let common = cur.u32()?;
    let _vol = cur.u32()?;
    let _dir = cur.u32()?;
    let file = cur.u32()?;
    let _fork = cur.u32()?;
    if common & ATTR_CMN_ERROR != 0 {
        let errno = cur.u32()?;
        if errno != 0 {
            return Err(problem_from_errno(errno));
        }
    }
    if common & libc::ATTR_CMN_NAME == 0 {
        return Err(Problem::Unreadable);
    }
    let ref_pos = cur.pos;
    let offset = cur.i32()?;
    let length = cur.u32()? as usize;
    let start = ref_pos
        .checked_add(usize::try_from(offset).map_err(|_| Problem::Unreadable)?)
        .ok_or(Problem::Unreadable)?;
    let end = start.checked_add(length).ok_or(Problem::Unreadable)?;
    let name_raw = entry.get(start..end).ok_or(Problem::Unreadable)?;
    let name = name_raw
        .iter()
        .position(|b| *b == 0)
        .and_then(|nul| name_raw.get(..nul))
        .unwrap_or(name_raw);
    if name.is_empty() {
        return Err(Problem::Unreadable);
    }

    let mut withheld = false;
    let dev = if common & libc::ATTR_CMN_DEVID != 0 {
        f64::from(cur.i32()?)
    } else {
        withheld = true;
        0.0
    };
    let objtype = if common & libc::ATTR_CMN_OBJTYPE != 0 {
        cur.u32()?
    } else {
        withheld = true;
        VNON
    };
    let mtime_ms = if common & libc::ATTR_CMN_MODTIME != 0 {
        let (sec, nsec) = cur.timespec()?;
        time_ms(sec, nsec)
    } else {
        withheld = true;
        f64::NAN
    };
    let atime_ms = if common & libc::ATTR_CMN_ACCTIME != 0 {
        let (sec, nsec) = cur.timespec()?;
        if want_atime {
            time_ms(sec, nsec)
        } else {
            f64::NAN
        }
    } else {
        f64::NAN
    };
    let st_flags = if common & libc::ATTR_CMN_FLAGS != 0 {
        cur.u32()?
    } else {
        withheld = true;
        0
    };
    let ino = if common & libc::ATTR_CMN_FILEID != 0 {
        cur.u64()? as f64
    } else {
        withheld = true;
        0.0
    };

    let kind = match objtype {
        VDIR => KIND_DIR,
        VLNK => KIND_SYMLINK,
        _ => KIND_FILE,
    };
    // Only a regular file or a symlink has a data fork whose absence means
    // something was withheld; a directory, a socket, a fifo or a device has none.
    let needs_file_group = matches!(objtype, VREG | VLNK);
    let nlink = if file & libc::ATTR_FILE_LINKCOUNT != 0 {
        cur.u32()?
    } else {
        withheld |= needs_file_group;
        0
    };
    let alloc = if file & libc::ATTR_FILE_ALLOCSIZE != 0 {
        cur.i64()? as f64
    } else {
        withheld |= needs_file_group;
        0.0
    };
    let size = if file & libc::ATTR_FILE_DATALENGTH != 0 {
        cur.i64()? as f64
    } else {
        withheld |= needs_file_group;
        0.0
    };
    let (size, alloc) = if kind == KIND_DIR {
        (0.0, 0.0)
    } else {
        (size, alloc)
    };
    let flags = if st_flags & SF_DATALESS != 0 {
        FLAG_DATALESS
    } else {
        0
    };
    out.push(
        name,
        Meta {
            kind,
            flags,
            size,
            alloc,
            mtime_ms,
            atime_ms,
            dev,
            ino,
            nlink,
            withheld,
        },
    );
    Ok(())
}

/// [`crate::probe`] on macOS: reads the root's own metadata, opens it, and
/// lists it once with `getattrlistbulk`.
pub fn probe(root: &Path) -> Probe {
    let unavailable = |reason: String| Probe {
        fast_path: FastPath::Unavailable,
        reason,
    };
    match per_entry::lstat_meta(root, false) {
        Err(errno) => {
            return unavailable(format!("the root could not be read: {}", os_error(errno)));
        }
        Ok(meta) if meta.kind != KIND_DIR => {
            return unavailable("the root is not a directory".to_owned());
        }
        Ok(_) => {}
    }
    let fd = match open_dir(root) {
        Ok(fd) => fd,
        Err(errno) => {
            return unavailable(format!(
                "the root directory could not be opened: {}",
                os_error(errno)
            ));
        }
    };
    let mut buf = ListBuffer::new(PROBE_BUFFER_BYTES);
    match list_bulk(&fd, false, &mut buf) {
        Ok(BulkOutcome::Listed) => Probe {
            fast_path: FastPath::Bulk,
            reason: format!(
                "getattrlistbulk listed the root directory ({} entries)",
                buf.listing.len()
            ),
        },
        Ok(BulkOutcome::Unsupported(errno)) => Probe {
            fast_path: FastPath::PerEntry,
            reason: format!(
                "getattrlistbulk refused the root with {}; the per-entry listing (readdir and fstatat) is used",
                os_error(errno)
            ),
        },
        Err(errno) => unavailable(format!(
            "getattrlistbulk failed on the root: {}",
            os_error(errno)
        )),
    }
}

fn os_error(errno: i32) -> std::io::Error {
    std::io::Error::from_raw_os_error(errno)
}

// `TIMESPEC_BYTES` documents the layout the cursor assumes (two `i64`s).
const _: () = assert!(TIMESPEC_BYTES == 2 * size_of::<i64>());
// The device and socket kinds are named for readers of the constants above;
// the parser treats every non-directory, non-link object as a leaf.
const _: () = assert!(VBLK != VDIR && VCHR != VDIR && VSOCK != VDIR && VFIFO != VDIR);

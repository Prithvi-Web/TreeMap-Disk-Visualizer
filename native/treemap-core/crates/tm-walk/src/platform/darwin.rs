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
//! column keeps its "unknown" value and the entry is marked withheld — except
//! the type, without which a directory would pass for a leaf: that entry is
//! re-read with `fstatat` through the directory descriptor first.
//!
//! Three constants the `libc` crate (0.2.189) lacks are defined here from the
//! SDK headers: `ATTR_CMN_ERROR`, `SF_DATALESS` and the `vtype` values.

use std::ffi::{CString, c_void};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use super::per_entry;
use super::{
    ListBuffer, Listed, Lister, Listing, Meta, last_errno, list_whole, refusal_from_errno,
};
use crate::output::Refusal;
use crate::{FastPath, KIND_DIR, Probe};

mod parse;

pub use parse::{ParseError, TypeFallback, parse_batch, parse_part};

/// `ATTR_CMN_ERROR` from `<sys/attr.h>`: a per-entry errno, packed right after
/// the returned set when it is returned. Not in `libc` 0.2.189.
pub const ATTR_CMN_ERROR: u32 = 0x2000_0000;
/// [`super::data_is_local`] on macOS: `lstat`'s flags, never an open.
pub fn data_is_local(path: &Path) -> std::io::Result<bool> {
    use std::os::macos::fs::MetadataExt;
    let meta = std::fs::symlink_metadata(path)?;
    Ok(meta.st_flags() & SF_DATALESS == 0)
}

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

/// Where a macOS listing that stopped early goes on from (T6b): the open
/// directory and the unread rest of its last bulk batch, or the per-entry
/// stream. Dropping it closes the directory.
#[derive(Debug)]
enum DarwinCursor {
    Bulk {
        fd: OwnedFd,
        want_atime: bool,
        rest: Option<BatchRest>,
    },
    PerEntry {
        stream: per_entry::Stream,
        want_atime: bool,
    },
}

impl DarwinLister {
    /// What a bulk step answers: complete and sorted once, or `More` with the
    /// directory and the batch's rest kept as the cursor.
    fn bulk_answer(
        step: Result<BulkStep, i32>,
        fd: OwnedFd,
        want_atime: bool,
        buf: &mut ListBuffer,
    ) -> Result<Listed, Refusal> {
        match step {
            Ok(BulkStep::Done) => {
                drop(fd);
                buf.listing.sort_by_name();
                Ok(Listed::Complete(FastPath::Bulk))
            }
            Ok(BulkStep::Stopped(rest)) => {
                buf.keep_cursor(DarwinCursor::Bulk {
                    fd,
                    want_atime,
                    rest,
                });
                Ok(Listed::More)
            }
            Ok(BulkStep::Unsupported(errno)) | Err(errno) => Err(refusal_from_errno(errno)),
        }
    }

    /// Per-entry listing on through `stream`, keeping it on a stop; sorted
    /// once complete.
    fn per_entry_on(
        mut stream: per_entry::Stream,
        want_atime: bool,
        buf: &mut ListBuffer,
        limit: usize,
    ) -> Result<Listed, Refusal> {
        if stream
            .read_until(want_atime, buf, limit)
            .map_err(refusal_from_errno)?
        {
            drop(stream);
            buf.listing.sort_by_name();
            return Ok(Listed::Complete(FastPath::PerEntry));
        }
        buf.keep_cursor(DarwinCursor::PerEntry { stream, want_atime });
        Ok(Listed::More)
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
        list_whole(self, dir, want_atime, buf)
    }

    fn list_until(
        &self,
        dir: &Path,
        want_atime: bool,
        buf: &mut ListBuffer,
        limit: usize,
    ) -> Result<Listed, Refusal> {
        buf.close_cursor();
        let fd = open_dir(dir).map_err(refusal_from_errno)?;
        buf.listing.clear();
        if !self.per_entry_only {
            match bulk_step(&fd, want_atime, buf, None, true, limit) {
                Ok(BulkStep::Unsupported(_errno)) => {
                    buf.listing.clear();
                    // SAFETY: `fd` is an open directory; rewinding it has no other effect.
                    unsafe { libc::lseek(fd.as_raw_fd(), 0, libc::SEEK_SET) };
                }
                step => return Self::bulk_answer(step, fd, want_atime, buf),
            }
        }
        buf.listing.clear();
        let stream = per_entry::Stream::open(fd).map_err(refusal_from_errno)?;
        Self::per_entry_on(stream, want_atime, buf, limit)
    }

    fn list_more(&self, buf: &mut ListBuffer, limit: usize) -> Result<Listed, Refusal> {
        match buf.take_cursor::<DarwinCursor>() {
            Some(DarwinCursor::Bulk {
                fd,
                want_atime,
                rest,
            }) => {
                let step = bulk_step(&fd, want_atime, buf, rest, false, limit);
                Self::bulk_answer(step, fd, want_atime, buf)
            }
            Some(DarwinCursor::PerEntry { stream, want_atime }) => {
                Self::per_entry_on(stream, want_atime, buf, limit)
            }
            None => Err(Refusal::Unreadable),
        }
    }
}

/// Opens `path` as a directory for reading, without following a final symlink.
pub fn open_dir(path: &Path) -> Result<OwnedFd, i32> {
    let c = CString::new(path.as_os_str().as_bytes()).map_err(|_| libc::EINVAL)?;
    let fd = super::retry_eintr(|| {
        // SAFETY: `c` is NUL-terminated; the flags open a directory read-only,
        // refuse a final symlink, and close the descriptor on exec.
        let fd = unsafe {
            libc::open(
                c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 { Err(last_errno()) } else { Ok(fd) }
    })?;
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
    match bulk_step(fd, want_atime, buf, None, true, usize::MAX)? {
        BulkStep::Done => Ok(BulkOutcome::Listed),
        BulkStep::Unsupported(errno) => Ok(BulkOutcome::Unsupported(errno)),
        // No listing holds `usize::MAX` entries.
        BulkStep::Stopped(_) => Err(libc::EIO),
    }
}

/// The unread rest of the batch `getattrlistbulk` last wrote into
/// `ListBuffer::raw`: where its next entry starts, that entry's index in the
/// batch, and how many entries the batch holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BatchRest {
    /// The next entry's offset in the buffer.
    pub pos: usize,
    /// The next entry's index in the batch.
    pub index: usize,
    /// The entries the batch holds.
    pub count: usize,
}

/// How a bulk listing's step ended other than with an errno.
#[derive(Clone, Copy, Debug)]
enum BulkStep {
    /// Every batch was parsed into the listing; mount points re-read.
    Done,
    /// The listing holds its limit: the unread rest of the last batch, if any.
    Stopped(Option<BatchRest>),
    /// The very first call was refused with `ENOTSUP` or `EINVAL`: this volume
    /// does not do bulk listing; nothing was read.
    Unsupported(i32),
}

/// The `getattrlistbulk` loop over `fd` into `buf.raw`, parsing every batch —
/// from `rest` on, the unread rest of the last one — until the listing is
/// complete or holds `limit` entries (T6b). `first` holds until the call
/// has answered once in this listing: only that very first call may refuse
/// bulk listing for the volume.
fn bulk_step(
    fd: &OwnedFd,
    want_atime: bool,
    buf: &mut ListBuffer,
    mut rest: Option<BatchRest>,
    mut first: bool,
    limit: usize,
) -> Result<BulkStep, i32> {
    let limit = limit.max(1);
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
        dirattr: libc::ATTR_DIR_MOUNTSTATUS,
        fileattr: FILE_ATTRS,
        forkattr: 0,
    };
    loop {
        if let Some(from) = rest.take() {
            let left = parse_part(
                &buf.raw,
                from,
                want_atime,
                &mut buf.listing,
                &mut |name| stat_at(fd, name, want_atime),
                limit,
            )
            .map_err(|_| libc::EIO)?;
            if left.is_some() {
                return Ok(BulkStep::Stopped(left));
            }
        }
        if buf.listing.len() >= limit {
            return Ok(BulkStep::Stopped(None));
        }
        if buf.stopped() {
            // The walk discards the listing on cancel, so which errno ends it is immaterial.
            return Err(libc::ECANCELED);
        }
        let answer = super::retry_eintr(|| {
            // SAFETY: `fd` is an open directory; `attrs` is a valid attrlist for
            // the call; `buf.raw` is a writable buffer of exactly `buf.raw.len()` bytes.
            let n = unsafe {
                libc::getattrlistbulk(
                    fd.as_raw_fd(),
                    (&raw mut attrs).cast::<c_void>(),
                    buf.raw.as_mut_ptr().cast::<c_void>(),
                    buf.raw.len(),
                    0,
                )
            };
            if n < 0 { Err(last_errno()) } else { Ok(n) }
        });
        let n = match answer {
            Ok(n) => n,
            Err(errno) if first && (errno == libc::ENOTSUP || errno == libc::EINVAL) => {
                return Ok(BulkStep::Unsupported(errno));
            }
            Err(errno) => return Err(errno),
        };
        // Every answer beats, the empty one that ends the listing included, so
        // even an empty directory beats once.
        buf.beat();
        if n == 0 {
            // Once, after the last batch.
            restat_mount_points(fd, want_atime, &mut buf.listing);
            return Ok(BulkStep::Done);
        }
        first = false;
        let count = usize::try_from(n).map_err(|_| libc::EIO)?;
        rest = Some(BatchRest {
            pos: 0,
            index: 0,
            count,
        });
    }
}

/// The entry `name` of the open directory `fd`, as `lstat` on the joined path
/// would report it; `None` when the stat failed (a name with a NUL cannot
/// come from a listing, but is refused rather than truncated).
fn stat_at(fd: &OwnedFd, name: &[u8], want_atime: bool) -> Option<Meta> {
    let c = CString::new(name).ok()?;
    per_entry::fstatat_meta(fd.as_raw_fd(), &c, want_atime).ok()
}

/// A mount point's bulk record describes the covered directory; `lstat` — and
/// so the legacy walker — describes the mounted volume's root. Every entry the
/// file system marked as a mount point is re-read with `fstatat` and its facts
/// replaced; one that vanished meanwhile keeps the bulk facts.
fn restat_mount_points(fd: &OwnedFd, want_atime: bool, listing: &mut Listing) {
    for index in std::mem::take(&mut listing.mount_points) {
        let Some(entry) = listing.entries.get(index) else {
            continue;
        };
        let Some(name) = listing.names.get(entry.name.clone()) else {
            continue;
        };
        let Some(meta) = stat_at(fd, name, want_atime) else {
            continue;
        };
        if let Some(entry) = listing.entries.get_mut(index) {
            entry.meta = meta;
        }
    }
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

/// `hw.nperflevels` at or above this: the cores come in more than one kind.
const ASYMMETRIC_LEVELS: u32 = 2;

/// [`super::performance_cores`] on macOS: `hw.perflevel0.logicalcpu` (level 0
/// is the fastest) when `hw.nperflevels` says there are at least two levels;
/// `None` on a machine of one kind of core, or when either name is missing.
pub fn performance_cores() -> Option<u32> {
    let levels = sysctl_u32(c"hw.nperflevels")?;
    if levels < ASYMMETRIC_LEVELS {
        return None;
    }
    sysctl_u32(c"hw.perflevel0.logicalcpu").filter(|cores| *cores >= 1)
}

/// An `int` sysctl read by name, as `u32`; `None` when it is missing, is not
/// an `int`, or is negative.
fn sysctl_u32(name: &std::ffi::CStr) -> Option<u32> {
    let mut value: libc::c_int = 0;
    let mut len = size_of::<libc::c_int>();
    // SAFETY: `name` is NUL-terminated; `value` is a writable `c_int` and `len`
    // holds its size, so the kernel writes at most that many bytes; no new
    // value is passed (null pointer, zero length).
    let rc = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            (&raw mut value).cast::<c_void>(),
            &raw mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || len != size_of::<libc::c_int>() {
        return None;
    }
    u32::try_from(value).ok()
}

// `TIMESPEC_BYTES` documents the layout the cursor assumes (two `i64`s).
const _: () = assert!(TIMESPEC_BYTES == 2 * size_of::<i64>());
// The device and socket kinds are named for readers of the constants above;
// the parser treats every non-directory, non-link object as a leaf.
const _: () = assert!(VBLK != VDIR && VCHR != VDIR && VSOCK != VDIR && VFIFO != VDIR);

//! The platform listing behind one trait, [`Lister`]: given a directory, fill a
//! reusable [`ListBuffer`] with its entries and say which path did it, or say
//! why the directory was refused. macOS is [`darwin`] (with [`per_entry`] as
//! its fallback); every other platform is [`unsupported`] until its task lands.
//! The walk core never calls the OS directly, so a fake `Lister` drives it in
//! tests on every platform.

use std::ops::Range;
use std::path::Path;
use std::sync::Arc;

use crate::output::Refusal;
use crate::{DEFAULT_BUFFER_BYTES, FastPath, MIN_BUFFER_BYTES, Probe, WalkError};

#[cfg(target_os = "macos")]
pub mod darwin;
#[cfg(target_os = "macos")]
pub mod per_entry;
#[cfg(not(target_os = "macos"))]
pub mod unsupported;

/// Everything the listing knows about one entry besides its name. Times are
/// milliseconds computed as `sec * 1e3 + nsec / 1e6` without rounding (P3-6);
/// sizes, `dev` and `ino` are doubles (P3-7).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Meta {
    /// [`crate::KIND_FILE`], [`crate::KIND_DIR`] or [`crate::KIND_SYMLINK`].
    pub kind: u8,
    /// [`crate::FLAG_DATALESS`] when the object's data is not local.
    pub flags: u8,
    /// Logical size; 0 for a directory or when withheld.
    pub size: f64,
    /// Allocated bytes; 0 for a directory or when withheld.
    pub alloc: f64,
    /// Modification time in ms; NaN when withheld.
    pub mtime_ms: f64,
    /// Access time in ms; NaN when not asked for or not returned.
    pub atime_ms: f64,
    /// The device id.
    pub dev: f64,
    /// The inode / file id.
    pub ino: f64,
    /// Hard-link count; 0 for a directory (not a fact the walk records) or when withheld.
    pub nlink: u32,
    /// True when the file system withheld an attribute the walk needs; the
    /// entry is kept with the "unknown" values above and counted as unreadable.
    pub withheld: bool,
}

impl Meta {
    /// A `kind` whose every other fact is unknown.
    pub fn unknown(kind: u8) -> Self {
        Self {
            kind,
            flags: 0,
            size: 0.0,
            alloc: 0.0,
            mtime_ms: f64::NAN,
            atime_ms: f64::NAN,
            dev: 0.0,
            ino: 0.0,
            nlink: 0,
            withheld: true,
        }
    }
}

/// One listed entry: where its raw name lives in [`Listing::names`], and its facts.
#[derive(Clone, Debug)]
pub struct Entry {
    /// The name's byte range in [`Listing::names`], exactly as the OS gave it.
    pub name: Range<usize>,
    /// The facts.
    pub meta: Meta,
}

/// One directory's entries, staged in a worker's reusable buffers. Names are
/// the OS bytes (the walk needs them to build child paths); the lossy UTF-8
/// form is produced once, when a name goes into the output arena.
#[derive(Debug, Default)]
pub struct Listing {
    /// The raw name bytes of every entry, back to back.
    pub names: Vec<u8>,
    /// The entries, in the order the OS returned them.
    pub entries: Vec<Entry>,
    /// Entries omitted because the OS refused their metadata (`EACCES`/`EPERM`).
    pub denied_entries: u64,
    /// Entries omitted for any other per-entry error (a vanished entry is not counted).
    pub unreadable_entries: u64,
}

impl Listing {
    /// Forgets the previous directory; keeps the allocations.
    pub fn clear(&mut self) {
        self.names.clear();
        self.entries.clear();
        self.denied_entries = 0;
        self.unreadable_entries = 0;
    }

    /// Appends one entry.
    pub fn push(&mut self, name: &[u8], meta: Meta) {
        let start = self.names.len();
        self.names.extend_from_slice(name);
        self.entries.push(Entry {
            name: start..self.names.len(),
            meta,
        });
    }

    /// The raw name bytes of `entry`.
    pub fn name(&self, entry: &Entry) -> &[u8] {
        self.names.get(entry.name.clone()).unwrap_or(&[])
    }

    /// How many entries were listed.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True when the directory had no entries.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// A worker's buffers: the platform's raw listing buffer, allocated once and
/// reused for every directory, and the staged [`Listing`].
#[derive(Debug)]
pub struct ListBuffer {
    /// The bulk listing buffer (`getattrlistbulk` writes into it).
    pub raw: Vec<u8>,
    /// The staged entries of the current directory.
    pub listing: Listing,
}

impl ListBuffer {
    /// A buffer of `buffer_bytes` (0 = [`DEFAULT_BUFFER_BYTES`], never below [`MIN_BUFFER_BYTES`]).
    pub fn new(buffer_bytes: usize) -> Self {
        let bytes = if buffer_bytes == 0 {
            DEFAULT_BUFFER_BYTES
        } else {
            buffer_bytes.max(MIN_BUFFER_BYTES)
        };
        Self {
            raw: vec![0; bytes],
            listing: Listing::default(),
        }
    }
}

/// A platform's listing. Implemented for macOS in [`darwin`]; tests script their own.
pub trait Lister: Send + Sync {
    /// The facts about `path` itself, without following a final symlink
    /// (used for the root, at the start and again at the end).
    fn stat_dir(&self, path: &Path, want_atime: bool) -> Result<Meta, Refusal>;

    /// Lists `dir` into `buf.listing` (cleared first) and returns the path that
    /// did it, or the refusal.
    fn list(&self, dir: &Path, want_atime: bool, buf: &mut ListBuffer)
    -> Result<FastPath, Refusal>;
}

/// The lister for this platform, or [`WalkError::Unsupported`] naming the platform.
pub fn platform_lister() -> Result<Arc<dyn Lister>, WalkError> {
    #[cfg(target_os = "macos")]
    {
        Ok(Arc::new(darwin::DarwinLister::new()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(WalkError::Unsupported(unsupported::reason()))
    }
}

/// [`crate::probe`] on this platform.
pub fn platform_probe(root: &Path) -> Probe {
    #[cfg(target_os = "macos")]
    {
        darwin::probe(root)
    }
    #[cfg(not(target_os = "macos"))]
    {
        unsupported::probe(root)
    }
}

/// Milliseconds from a `timespec`, exactly as Node computes `mtimeMs`:
/// `sec * 1e3 + nsec / 1e6`, no rounding (decision P3-6).
pub fn time_ms(sec: i64, nsec: i64) -> f64 {
    (sec as f64) * 1e3 + (nsec as f64) / 1e6
}

/// The legacy walker's classification of an errno.
#[cfg(unix)]
pub fn refusal_from_errno(errno: i32) -> Refusal {
    match errno {
        libc::EACCES | libc::EPERM => Refusal::Denied,
        libc::ENOENT | libc::ENOTDIR => Refusal::Vanished,
        _ => Refusal::Unreadable,
    }
}

/// The calling thread's last OS error number (`EIO` if none is recorded).
#[cfg(unix)]
pub fn last_errno() -> i32 {
    std::io::Error::last_os_error()
        .raw_os_error()
        .unwrap_or(libc::EIO)
}

/// The calling thread's own CPU time in seconds, from `CLOCK_THREAD_CPUTIME_ID`;
/// NaN where the platform has no thread clock yet (Windows until W4).
pub fn thread_cpu_seconds() -> f64 {
    #[cfg(unix)]
    {
        // SAFETY: all-zero is a valid `timespec`.
        let mut ts: libc::timespec = unsafe { std::mem::zeroed() };
        // SAFETY: `ts` is a writable timespec and the clock id is valid on this platform.
        let rc = unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &raw mut ts) };
        if rc != 0 {
            return f64::NAN;
        }
        (ts.tv_sec as f64) + (ts.tv_nsec as f64) / 1e9
    }
    #[cfg(not(unix))]
    {
        f64::NAN
    }
}

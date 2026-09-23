//! The platform listing behind one trait, [`Lister`]: given a directory, fill a
//! reusable [`ListBuffer`] with its entries and say which path did it, or say
//! why the directory was refused. macOS is [`darwin`] (with [`per_entry`] as
//! its fallback), Windows is [`windows`], Linux is [`linux`]; every other
//! platform is `unsupported`. The parsers of the two cross platforms are
//! portable and compiled everywhere so their synthetic-buffer tests run here;
//! only their calls are behind `cfg`. The walk core never calls the OS
//! directly, so a fake `Lister` drives it in tests on every platform.

use std::ops::Range;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use crate::output::Refusal;
use crate::{DEFAULT_BUFFER_BYTES, FastPath, MAX_BUFFER_BYTES, MIN_BUFFER_BYTES, Probe, WalkError};

#[cfg(target_os = "macos")]
pub mod darwin;
pub mod linux;
#[cfg(target_os = "macos")]
pub mod per_entry;
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub mod unsupported;
pub mod windows;

/// Everything the listing knows about one entry besides its name. Times are
/// milliseconds computed as `sec * 1e3 + nsec / 1e6` without rounding (P3-6);
/// sizes and `dev` are doubles (P3-7); `ino` is exact, never a double.
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
    /// The inode or file id, exact: `st_ino`, or on Windows the whole 128-bit
    /// file id. An identity, not a quantity — as a double, a reused NTFS
    /// record's id (its sequence number sits in bits 48..64) rounds into its
    /// neighbour's past 2^53, and ReFS ids can differ only above bit 64, so
    /// two files became one hard-link family (the pre-landing review of 23
    /// Sep 2026).
    pub ino: u128,
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
            ino: 0,
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

/// A directory's own times, read from the directory itself while it was
/// listed. Windows keeps a copy of each directory's times in its PARENT's
/// index and updates that copy lazily, so what the parent's listing reported
/// can be stale; these are what `lstat` — and so the legacy walker — reads.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DirTimes {
    /// Last write, in ms since the epoch, computed as `lstat` computes it.
    pub mtime_ms: f64,
    /// Last access, in ms since the epoch; NaN when the walk did not ask for it.
    pub atime_ms: f64,
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
    /// Indices of entries the file system reported as mount points. A bulk
    /// listing answers for the covered directory where `lstat` answers for the
    /// mounted volume's root, so the lister re-reads these with `fstatat`
    /// before the listing is handed on, and empties this list.
    pub mount_points: Vec<usize>,
    /// The listed directory's own times, when the platform read them from the
    /// directory itself (Windows); `None` where the parent's listing already
    /// reported each entry's own attributes (macOS, Linux).
    pub own_times: Option<DirTimes>,
}

impl Listing {
    /// Forgets the previous directory; keeps the allocations.
    pub fn clear(&mut self) {
        self.names.clear();
        self.mount_points.clear();
        self.entries.clear();
        self.denied_entries = 0;
        self.unreadable_entries = 0;
        self.own_times = None;
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

    /// Orders the entries by their raw name bytes, as `strcmp` would — the
    /// order libuv's `scandir` gives the legacy walker on macOS and Linux, so
    /// their listers call it last and the walk numbers entries in the legacy
    /// walker's order, leaving the ingest's own sort (kept for modules built
    /// before this) its best case. Windows' listers do not: there libuv keeps
    /// the file system's order, and so does the legacy walker. The order is a
    /// lister's, never the host's — a Windows-shaped listing walked on another
    /// host (tm-mft's tests) keeps its own. Names within one directory are
    /// unique, so the unstable sort is exact. Call it once
    /// [`Listing::mount_points`], which holds indices into the entries, is empty.
    pub fn sort_by_name(&mut self) {
        let Self { names, entries, .. } = self;
        entries.sort_unstable_by(|a, b| {
            let a = names.get(a.name.clone()).unwrap_or(&[]);
            let b = names.get(b.name.clone()).unwrap_or(&[]);
            a.cmp(b)
        });
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
    /// The walk's cancel flag: a listing loop that sees it set returns between
    /// two batches instead of issuing the next call, so a cancel does not wait
    /// for a huge directory to finish listing.
    pub stop: Arc<AtomicBool>,
    /// Bumped once per batch the OS answered, across every worker: the caller
    /// can tell a directory that is listing slowly from a call that never
    /// returned, which the entry count alone cannot (entries are counted only
    /// once a directory's listing is complete).
    pub heartbeat: Arc<AtomicU64>,
}

impl ListBuffer {
    /// A buffer of `buffer_bytes` (0 = [`DEFAULT_BUFFER_BYTES`], clamped to
    /// [`MIN_BUFFER_BYTES`]..=[`MAX_BUFFER_BYTES`]) with signals nobody else
    /// holds — a probe's, or a test's.
    pub fn new(buffer_bytes: usize) -> Self {
        Self::with_signals(
            buffer_bytes,
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicU64::new(0)),
        )
    }

    /// A buffer whose `stop` and `heartbeat` are the walk's own, shared by
    /// every worker.
    pub fn with_signals(
        buffer_bytes: usize,
        stop: Arc<AtomicBool>,
        heartbeat: Arc<AtomicU64>,
    ) -> Self {
        let bytes = if buffer_bytes == 0 {
            DEFAULT_BUFFER_BYTES
        } else {
            buffer_bytes.clamp(MIN_BUFFER_BYTES, MAX_BUFFER_BYTES)
        };
        Self {
            raw: vec![0; bytes],
            listing: Listing::default(),
            stop,
            heartbeat,
        }
    }

    /// True once the walk was cancelled: stop between batches.
    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::Acquire)
    }

    /// One more batch answered by the OS.
    pub fn beat(&self) {
        self.heartbeat.fetch_add(1, Ordering::AcqRel);
    }
}

/// A platform's listing. Implemented for macOS in [`darwin`], Windows in
/// [`windows`] and Linux in [`linux`]; tests script their own.
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
    #[cfg(target_os = "linux")]
    {
        Ok(Arc::new(linux::LinuxLister::new()))
    }
    #[cfg(windows)]
    {
        Ok(Arc::new(windows::WindowsLister::new()))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
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
    #[cfg(target_os = "linux")]
    {
        linux::probe(root)
    }
    #[cfg(windows)]
    {
        windows::probe(root)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        unsupported::probe(root)
    }
}

/// The machine's performance cores, where its cores come in more than one
/// performance level (Apple silicon: `hw.perflevel0.logicalcpu` while
/// `hw.nperflevels` is at least 2). `None` everywhere else, and wherever the
/// OS does not say.
pub fn performance_cores() -> Option<u32> {
    #[cfg(target_os = "macos")]
    {
        darwin::performance_cores()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
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

/// Makes `call` again for as long as it fails with `EINTR`, and returns
/// anything else — success or another errno — at once. A signal that lands
/// while a worker is inside `open`, `getattrlistbulk`, `getdents64`, `statx`
/// or `fstatat` says nothing about the file; counted as an error, it would
/// record a readable directory as unreadable and drop its subtree because of
/// when a signal arrived.
#[cfg(unix)]
pub fn retry_eintr<T>(mut call: impl FnMut() -> Result<T, i32>) -> Result<T, i32> {
    loop {
        match call() {
            Err(libc::EINTR) => {}
            other => return other,
        }
    }
}

/// The calling thread's own CPU time in seconds: `CLOCK_THREAD_CPUTIME_ID` on
/// Unix, `GetThreadTimes` on Windows; NaN where the platform has no thread clock.
pub fn thread_cpu_seconds() -> f64 {
    #[cfg(windows)]
    {
        windows::thread_cpu_seconds()
    }
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
    #[cfg(not(any(unix, windows)))]
    {
        f64::NAN
    }
}

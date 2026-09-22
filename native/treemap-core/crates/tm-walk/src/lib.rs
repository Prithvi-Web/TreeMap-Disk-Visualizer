//! `tm-walk`: the native walker (Phase 3). One listing call per directory on
//! platforms that have one, a governed parallel walk, and columnar output in
//! discovery order that the store ingests without a syscall per entry.
//!
//! * [`platform`] is the listing behind one trait: macOS lists with
//!   `getattrlistbulk` and falls back to `readdir` + `fstatat` where a volume
//!   refuses it; Windows with `FileIdExtdDirectoryInfo` and falls back to
//!   `FindFirstFileExW`; Linux with `getdents64` + `statx`; every other
//!   platform reports itself unavailable.
//! * [`walk`] runs the workers, obeys the governor (`throttle()` after every
//!   directory, `worker_limit()` re-read between directories), honours pause
//!   and cancel, and merges the per-worker columns at the end.
//! * [`climb`] is the hill-climber that picks the worker count, as a pure state
//!   machine driven by a clock and an entries counter.
//! * [`output`] is the product: columns, side tables and measured stats.
//!
//! The facts recorded are the legacy walker's facts (`docs/engine/CURRENT-STATE.md`
//! §3): symlinks are leaves with the link's own length and are never followed;
//! sockets, fifos and devices are leaves; a directory that cannot be listed is a
//! node flagged [`FLAG_REFUSED_DIR`] with a [`DirRefusal`], and the walk goes on;
//! `never_descend` paths are childless directory nodes; times cross as `f64`
//! milliseconds computed exactly as Node does (P3-6), sizes and ids as `f64`
//! (P3-7). Nothing here reports a number it did not measure.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tm_governor::Governor;

pub mod climb;
pub mod output;
pub mod platform;
mod queue;
pub mod walk;

pub use output::{DirRefusal, HardlinkRef, Refusal, WalkOutput, WalkStats};
pub use platform::{Entry, ListBuffer, Lister, Listing, Meta};
pub use walk::{GovernorPacer, Pacer, Progress, WalkHandle, panic_text, start_with};

/// A regular file, socket, fifo or device: a leaf with its lstat size.
pub const KIND_FILE: u8 = 0;
/// A directory.
pub const KIND_DIR: u8 = 1;
/// A symbolic link: never followed; its size is the length of the target text.
pub const KIND_SYMLINK: u8 = 2;
/// `SF_DATALESS` (macOS), `RECALL_ON_DATA_ACCESS`/`OFFLINE` or a cloud reparse tag (Windows).
pub const FLAG_DATALESS: u8 = 1;
/// A directory that could not be listed; the reason is in [`WalkOutput::refusals`].
pub const FLAG_REFUSED_DIR: u8 = 2;
/// The listing buffer each worker allocates once, when the options say `0`.
pub const DEFAULT_BUFFER_BYTES: usize = 256 * 1024;
/// The smallest listing buffer: room for one entry with the longest legal name.
pub const MIN_BUFFER_BYTES: usize = 4096;
/// The most a worker's listing buffer may be: a caller's larger request is clamped, never allocated.
pub const MAX_BUFFER_BYTES: usize = 16 * 1024 * 1024;

/// What to walk and how.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalkOptions {
    /// The directory to walk. It is used as given, never resolved.
    pub root: PathBuf,
    /// Absolute paths the walk never descends into (the legacy list, passed from Node).
    pub never_descend: Vec<PathBuf>,
    /// Whether to record access times (`atime_ms` is NaN otherwise).
    pub want_atime: bool,
    /// 0 = let the hill-climber decide, bounded by the governor's worker limit;
    /// otherwise a fixed count, still bounded by the governor's limit.
    pub max_workers: usize,
    /// Bytes per worker listing buffer (0 = [`DEFAULT_BUFFER_BYTES`]; never below [`MIN_BUFFER_BYTES`]).
    pub buffer_bytes: usize,
}

impl WalkOptions {
    /// Options for `root` with the defaults: no never-descend list, no atime,
    /// the hill-climber, the default buffer.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            never_descend: Vec::new(),
            want_atime: false,
            max_workers: 0,
            buffer_bytes: DEFAULT_BUFFER_BYTES,
        }
    }
}

/// The listing path a platform offers, as the probe and the stats report it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FastPath {
    /// macOS `getattrlistbulk`.
    Bulk,
    /// Windows `GetFileInformationByHandleEx(FileIdExtdDirectoryInfo)`.
    ExtdDirInfo,
    /// Linux `getdents64` + `statx`.
    Getdents,
    /// One `stat` per entry: the fallback where the bulk call is refused.
    PerEntry,
    /// No native listing on this platform, or the root could not be probed.
    Unavailable,
}

impl FastPath {
    /// The name the Node side shows: `bulk`, `extdDirInfo`, `getdents`, `perEntry`, `unavailable`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bulk => "bulk",
            Self::ExtdDirInfo => "extdDirInfo",
            Self::Getdents => "getdents",
            Self::PerEntry => "perEntry",
            Self::Unavailable => "unavailable",
        }
    }

    /// The mechanism in words, for reasons.
    pub fn describe(self) -> &'static str {
        match self {
            Self::Bulk => "getattrlistbulk",
            Self::ExtdDirInfo => "FileIdExtdDirectoryInfo",
            Self::Getdents => "getdents64 and statx",
            Self::PerEntry => "per-entry (readdir and fstatat)",
            Self::Unavailable => "unavailable",
        }
    }

    pub(crate) fn code(self) -> u8 {
        match self {
            Self::Bulk => 0,
            Self::ExtdDirInfo => 1,
            Self::Getdents => 2,
            Self::PerEntry => 3,
            Self::Unavailable => 4,
        }
    }

    pub(crate) fn from_code(code: u8) -> Self {
        match code {
            0 => Self::Bulk,
            1 => Self::ExtdDirInfo,
            2 => Self::Getdents,
            3 => Self::PerEntry,
            _ => Self::Unavailable,
        }
    }
}

/// What [`probe`] found: the listing path and, in words, why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Probe {
    /// The path the root would be listed with.
    pub fast_path: FastPath,
    /// The reason, as a sentence the stats can show.
    pub reason: String,
}

/// Opens and lists `root` once with the platform's listing; no side effects
/// beyond the read itself.
pub fn probe(root: &Path) -> Probe {
    platform::platform_probe(root)
}

/// [`probe`] through any [`Lister`]: the seam the tests use with a fake.
pub fn probe_with(lister: &dyn Lister, root: &Path) -> Probe {
    let unavailable = |reason: String| Probe {
        fast_path: FastPath::Unavailable,
        reason,
    };
    match lister.stat_dir(root, false) {
        Err(why) => return unavailable(format!("the root could not be read: {why}")),
        Ok(meta) if meta.kind != KIND_DIR => {
            return unavailable("the root is not a directory".to_owned());
        }
        Ok(_) => {}
    }
    let mut buf = ListBuffer::new(0);
    match lister.list(root, false, &mut buf) {
        Ok(path) => Probe {
            fast_path: path,
            reason: format!(
                "the root was listed through the {} path ({} entries)",
                path.describe(),
                buf.listing.len()
            ),
        },
        Err(why) => unavailable(format!("the root could not be listed: {why}")),
    }
}

/// Starts a walk on the crate's own threads, governed by `governor`. Returns
/// as soon as the root has been checked; the walk itself runs behind the handle.
pub fn start(opts: WalkOptions, governor: Arc<Governor>) -> Result<WalkHandle, WalkError> {
    let lister = platform::platform_lister()?;
    start_with(opts, Arc::new(GovernorPacer::new(governor)), lister)
}

/// Why a walk could not start, or how it ended other than with an output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WalkError {
    /// The root exists but is not a directory (a symlink to one counts as not one).
    RootNotDirectory,
    /// The root could not be read or listed, or vanished during the walk.
    RootRefused(Refusal),
    /// No native listing on this platform; the reason names the platform.
    Unsupported(String),
    /// [`WalkHandle::cancel`] was called before the walk finished.
    Cancelled,
    /// Something this crate could not recover from; the text says what.
    Internal(String),
}

impl fmt::Display for WalkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RootNotDirectory => f.write_str("the root is not a directory"),
            Self::RootRefused(why) => write!(f, "the root could not be walked: {why}"),
            Self::Unsupported(reason) | Self::Internal(reason) => f.write_str(reason),
            Self::Cancelled => f.write_str("the walk was cancelled"),
        }
    }
}

impl std::error::Error for WalkError {}

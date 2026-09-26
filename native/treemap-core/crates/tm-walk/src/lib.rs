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
//! * [`platform::synthetic`] is a scripted listing that reads nothing from
//!   disk ([`WalkOptions::synthetic`]), for measuring the walk and the store
//!   at sizes no disk here holds (Phase 4, P4-8).
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

mod blocks;
pub mod climb;
pub mod invariants;
pub mod links;
pub mod output;
pub mod platform;
mod queue;
pub mod sink;
pub mod walk;

pub use links::{IdFamily, LinkKey, hardlink_families, link_key};
pub use output::{DirRefusal, HardlinkRef, Refusal, WalkOutput, WalkStats};
pub use platform::synthetic::{SyntheticLister, SyntheticSpec, synthetic_temp_folder};
pub use platform::{Entry, ListBuffer, Lister, Listing, Meta};
pub use sink::{Block, ListingSink};
pub use walk::{
    GovernorPacer, Pacer, Progress, WalkCounts, WalkHandle, panic_text, start_with,
    start_with_sinks,
};

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
/// [`WalkOptions::q_max`]'s default: memory mode's `Q_MAX` (P4-13). The large
/// modes will pass 4,096.
pub const DEFAULT_Q_MAX: usize = 65_536;
/// Under [`Numbering::Blocks`], a listing of more entries than this goes
/// through the big-listing semaphore, one at a time, and is committed in
/// chunks of [`CHUNK_BYTES`] (design §S.1.2 step 5).
pub const BIG_LISTING: usize = 16_384;
/// The staged bytes (stored names and rows) a big listing's chunk reaches
/// before it is handed to the sinks.
pub const CHUNK_BYTES: usize = 4 * 1024 * 1024;
/// [`WalkOptions::id_ceiling`]'s default: ids are `u32` and the root holds 0,
/// so a walk numbers at most `u32::MAX - 1` entries.
pub const ID_CEILING: u32 = u32::MAX;

/// How a walk numbers the entries it lists.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Numbering {
    /// Phase 3's numbering, and the default until T10: one atomic counter
    /// hands every entry its id as it is discovered, so the ids of one
    /// listing interleave with other workers' and `build` renumbers
    /// breadth-first. The queue is first-in first-out, as it always was.
    #[default]
    Discovery,
    /// One contiguous block of ids per listing (P4-1a): a worker lists and
    /// orders a whole folder, then reserves `first..first + k` for its `k`
    /// children under one commit lock and hands the rows to every
    /// [`ListingSink`], so invariants I1–I4 ([`invariants`]) hold by
    /// construction. The queue is the hybrid one ([`WalkOptions::q_max`]).
    Blocks,
}

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
    /// When set, [`start`] lists this scripted tree instead of the disk, and
    /// only for a root inside the app's synthetic temp folder
    /// ([`platform::synthetic::synthetic_fences`]).
    pub synthetic: Option<SyntheticSpec>,
    /// How the entries are numbered; [`Numbering::Discovery`] by default.
    pub numbering: Numbering,
    /// Under [`Numbering::Blocks`], the queue hands out the oldest job while
    /// it holds fewer than `q_max` jobs and the newest once it holds `q_max`
    /// or more (P4-13): breadth-first while the backlog is small, depth-first
    /// once it is not. Depth-first slows the backlog's growth to one descent
    /// per worker; it cannot cap it at `q_max` — a folder with more subfolders
    /// than `q_max` queues them all ([`WalkCounts::queue_peak`] says how far it
    /// went). [`Numbering::Discovery`] ignores it.
    pub q_max: usize,
    /// The id the counter stops at: ids `0..id_ceiling` are handed out and a
    /// walk that needs more faults ([`ID_CEILING`] by default, the most a `u32`
    /// column numbers). Tests lower it to reach the fault with a small tree.
    pub id_ceiling: u32,
}

impl WalkOptions {
    /// Options for `root` with the defaults: no never-descend list, no atime,
    /// the hill-climber, the default buffer, the disk, discovery numbering,
    /// [`DEFAULT_Q_MAX`] and [`ID_CEILING`].
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            never_descend: Vec::new(),
            want_atime: false,
            max_workers: 0,
            buffer_bytes: DEFAULT_BUFFER_BYTES,
            synthetic: None,
            // The test-only feature runs every existing walk under block
            // numbering (tm-walk's Cargo.toml); nothing ships with it.
            numbering: if cfg!(feature = "blocks-by-default") {
                Numbering::Blocks
            } else {
                Numbering::Discovery
            },
            q_max: DEFAULT_Q_MAX,
            id_ceiling: ID_CEILING,
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
    /// Windows NTFS: the volume's master file table, read by the elevated
    /// helper (`tm-mft-helper`) instead of listed directory by directory.
    Mft,
}

impl FastPath {
    /// The name the Node side shows: `bulk`, `extdDirInfo`, `getdents`, `perEntry`, `unavailable`, `mft`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bulk => "bulk",
            Self::ExtdDirInfo => "extdDirInfo",
            Self::Getdents => "getdents",
            Self::PerEntry => "perEntry",
            Self::Unavailable => "unavailable",
            Self::Mft => "mft",
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
            Self::Mft => "the NTFS master file table",
        }
    }

    pub(crate) fn code(self) -> u8 {
        match self {
            Self::Bulk => 0,
            Self::ExtdDirInfo => 1,
            Self::Getdents => 2,
            Self::PerEntry => 3,
            Self::Unavailable => 4,
            Self::Mft => 5,
        }
    }

    pub(crate) fn from_code(code: u8) -> Self {
        match code {
            0 => Self::Bulk,
            1 => Self::ExtdDirInfo,
            2 => Self::Getdents,
            3 => Self::PerEntry,
            5 => Self::Mft,
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
    let lister = lister_for(&opts)?;
    start_with(opts, Arc::new(GovernorPacer::new(governor)), lister)
}

/// The lister [`start`] walks `opts` with: the scripted one when
/// `opts.synthetic` is set (refused, as [`WalkError::OptionsRefused`], for a
/// root outside the app's synthetic temp folder or a tree that cannot be
/// built), this platform's otherwise.
pub fn lister_for(opts: &WalkOptions) -> Result<Arc<dyn Lister>, WalkError> {
    match &opts.synthetic {
        Some(spec) => Ok(Arc::new(SyntheticLister::new(spec, &opts.root)?)),
        None => platform::platform_lister(),
    }
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
    /// The options were refused before anything was listed: a synthetic root
    /// outside the app's synthetic temp folder, or a synthetic tree that
    /// cannot be built. The text says which.
    OptionsRefused(String),
}

impl fmt::Display for WalkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RootNotDirectory => f.write_str("the root is not a directory"),
            Self::RootRefused(why) => write!(f, "the root could not be walked: {why}"),
            Self::Unsupported(reason) | Self::Internal(reason) | Self::OptionsRefused(reason) => {
                f.write_str(reason)
            }
            Self::Cancelled => f.write_str("the walk was cancelled"),
        }
    }
}

impl std::error::Error for WalkError {}

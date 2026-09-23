//! The walk's product: columns in discovery order (index 0 is the root and
//! `parent[i] < i` for every `i > 0`), the hard-link and refusal side tables,
//! and the stats the engine measured.

use std::fmt;

use crate::FastPath;

/// Why a directory could not be listed, classified as the legacy walker does:
/// `EACCES`/`EPERM` are denied, `ENOENT`/`ENOTDIR` vanished, everything else unreadable.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Refusal {
    /// The OS would not let this user list it.
    Denied = 1,
    /// It was gone (or no longer a directory) by the time it was listed.
    Vanished = 2,
    /// Any other error.
    Unreadable = 3,
}

impl Refusal {
    /// The code that crosses to Node (`refusalWhy`).
    pub fn code(self) -> u8 {
        self as u8
    }

    pub(crate) fn from_code(code: u8) -> Option<Self> {
        match code {
            1 => Some(Self::Denied),
            2 => Some(Self::Vanished),
            3 => Some(Self::Unreadable),
            _ => None,
        }
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Denied => "permission denied",
            Self::Vanished => "it disappeared",
            Self::Unreadable => "it could not be read",
        })
    }
}

/// A leaf that shares its file with another name: one ref per member, so the
/// ingest counts a family's bytes once, at its first name in id order, as the
/// legacy walker does. Families are told apart by number, assigned from each
/// file's exact identity ([`crate::links`]); an id never leaves the walk.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct HardlinkRef {
    /// The node's index in the columns.
    pub node: u32,
    /// The family's number: the same for every name of one file.
    pub family: u32,
}

/// A directory node that could not be listed, and why.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct DirRefusal {
    /// The node's index in the columns; its `flags` carry [`crate::FLAG_REFUSED_DIR`].
    pub node: u32,
    /// The classification.
    pub why: Refusal,
}

/// What the walk measured about itself.
#[derive(Clone, PartialEq, Debug)]
pub struct WalkStats {
    /// Directories listed successfully (the root included; refused ones not).
    pub dirs_listed: u64,
    /// Entries discovered under the root (the root itself not counted).
    pub entries: u64,
    /// Wall time from `start()` to the merged output, in milliseconds, unrounded.
    pub wall_ms: f64,
    /// Sum of the walker threads' own CPU time (`CLOCK_THREAD_CPUTIME_ID`), the
    /// driver thread included; NaN where the platform has no thread clock yet.
    pub cpu_seconds: f64,
    /// The path the root was listed with.
    pub fast_path: FastPath,
    /// The most workers that were listing at the same time.
    pub workers_peak: u32,
    /// How many times the hill-climber changed the worker count.
    pub climb_steps: u32,
    /// Entries whose metadata the OS refused (`EACCES`/`EPERM`); they are omitted.
    pub denied_entries: u64,
    /// Entries omitted for any other per-entry error, plus entries kept with a
    /// withheld attribute (their columns hold the "unknown" values).
    pub unreadable_entries: u64,
    /// Entries flagged [`crate::FLAG_DATALESS`].
    pub dataless: u64,
}

/// Columns in discovery order; index 0 is the root; `parent[i] < i` for every `i > 0`.
#[derive(Clone, PartialEq, Debug)]
pub struct WalkOutput {
    /// Parent index; the root's is 0.
    pub parent: Vec<u32>,
    /// `len + 1` offsets into `names`; node `i`'s name is `names[name_off[i]..name_off[i + 1]]`.
    pub name_off: Vec<u32>,
    /// Every name, valid UTF-8: the OS bytes when they were valid, U+FFFD per
    /// maximal invalid subpart otherwise (what Node's decoder would produce).
    /// The root's name is its last path component, or the whole root path when
    /// it has none (`/`).
    pub names: Vec<u8>,
    /// [`crate::KIND_FILE`], [`crate::KIND_DIR`] or [`crate::KIND_SYMLINK`].
    pub kind: Vec<u8>,
    /// [`crate::FLAG_DATALESS`] and [`crate::FLAG_REFUSED_DIR`] bits.
    pub flags: Vec<u8>,
    /// Logical size in bytes (0 for directories); a symlink's is its target text length.
    pub size: Vec<f64>,
    /// Allocated bytes (0 for directories).
    pub alloc_bytes: Vec<f64>,
    /// Modification time in milliseconds, `sec * 1e3 + nsec / 1e6`, unrounded; NaN when withheld.
    pub mtime_ms: Vec<f64>,
    /// Access time the same way; NaN when not recorded.
    pub atime_ms: Vec<f64>,
    /// Every leaf whose link count exceeds one, sorted by node.
    pub hardlinks: Vec<HardlinkRef>,
    /// Every directory that could not be listed, sorted by node.
    pub refusals: Vec<DirRefusal>,
    /// What the walk measured.
    pub stats: WalkStats,
}

impl WalkOutput {
    /// Number of nodes, the root included.
    pub fn len(&self) -> usize {
        self.parent.len()
    }

    /// True when there is not even a root (never, for a walk that produced output).
    pub fn is_empty(&self) -> bool {
        self.parent.is_empty()
    }

    /// The name bytes of node `node`, or `None` when the index is out of range.
    pub fn name(&self, node: usize) -> Option<&[u8]> {
        let start = *self.name_off.get(node)? as usize;
        let end = *self.name_off.get(node.checked_add(1)?)? as usize;
        self.names.get(start..end)
    }
}

//! The rules that make one store row from what the walk listed: the one kernel
//! [`build`](crate::build()) and [`MemorySink`](crate::MemorySink) both run, so every
//! per-row value comes from the same function on the same input (design §S.2, Lemma 1).
//!
//! A row is derived in two steps. [`derive_row`] decides everything the row decides by
//! itself — its flag bits, times, extension, container kind and whether Node must look at
//! it. [`Pending::settle`] then decides what depends on the hard-link dedup, which only
//! the caller can: a later name of a hard-linked file keeps no bytes, and the placeholder,
//! sparse and slack tallies follow from that. `build` settles each row as it goes, in its
//! breadth-first order; the sink settles a row whose file may have other names once it
//! knows the family.

use std::collections::HashMap;

use tm_walk::{FLAG_DATALESS, KIND_DIR, KIND_SYMLINK};

use crate::build::Counters;
use crate::derive::{
    ContainerRule, container_kind, decided_here, extension, is_hidden, store_atime, store_mtime,
};
use crate::{EXT_OVERFLOW, StoreError, flag};

/// The most entries the extension dictionary holds, "none" included; later extensions
/// go to [`Store::ext_overflow`](crate::Store::ext_overflow) (`internExt` in
/// `scanStore.ts`).
const EXT_DICT_LIMIT: usize = 0xffff;

/// 2^53: a double holds every whole number below it, and not every one above it.
const WHOLE_NUMBERS_EXACT_BELOW: f64 = 9_007_199_254_740_992.0;

/// What the rules need to know besides the row: Node's facts about the root and the
/// platform ([`BuildOptions`](crate::BuildOptions)).
#[derive(Clone, Copy)]
pub(crate) struct RowRules<'a> {
    /// The root's modification time from Node's own stat, kept when the walk withheld it.
    pub root_mtime_ms: f64,
    /// Whether allocated bytes mean anything here: the sparse and slack tallies.
    pub blocks_are_meaningful: bool,
    /// `detectContainerKind`'s rules, in its order.
    pub container_rules: &'a [ContainerRule],
}

/// One row as the walk listed it.
#[derive(Clone, Copy)]
pub(crate) struct RowInput<'a> {
    /// The name the store shows: the stored name, or for the root Node's name for it.
    pub name: &'a [u8],
    /// Whether this is the root's row.
    pub is_root: bool,
    /// The walk's kind (`KIND_FILE`, `KIND_DIR`, `KIND_SYMLINK`).
    pub kind: u8,
    /// The walk's flag bits (`FLAG_DATALESS` is the one read here).
    pub walk_flags: u8,
    /// Logical bytes.
    pub size: f64,
    /// Allocated bytes.
    pub alloc: f64,
    /// Modification time, milliseconds, unrounded; NaN when withheld.
    pub mtime_ms: f64,
    /// Access time the same way; NaN when not recorded.
    pub atime_ms: f64,
}

/// What the rules make of a row before the hard-link dedup settles it.
pub(crate) struct Row<'a> {
    /// Every flag bit the row decides by itself: all but [`flag::HARDLINK_DUP`] (the
    /// dedup's) and [`flag::GIT_REPO`] (decided by the row's children).
    pub bits: u16,
    /// The modification time the store keeps.
    pub mtime: f64,
    /// The access time the store keeps, when it keeps one ([`flag::HAS_ACCESSED`]).
    pub atime: Option<f64>,
    /// Whether the store decides the extension and container kind itself; when not, the
    /// row is a text candidate and both are left at none.
    pub decided: bool,
    /// The raw extension to intern, for a file whose extension the store decides.
    pub extension: Option<&'a [u8]>,
    /// The container kind, 0 for none.
    pub container: u8,
    /// A folder named `.git`, below the root: its parent is a repository.
    pub marks_parent_git_repo: bool,
    /// What the dedup settles.
    pub pending: Pending,
}

impl Row<'_> {
    /// Whether it is a folder.
    pub(crate) fn is_dir(&self) -> bool {
        self.bits & flag::DIR != 0
    }

    /// Whether the row can be a name of a hard-linked file: neither a folder nor a
    /// symlink. The dedup considers no other row.
    pub(crate) fn linkable(&self) -> bool {
        self.bits & (flag::DIR | flag::SYMLINK) == 0
    }

    /// Whether Node applies the cloud rule to it
    /// ([`Store::cloud_candidates`](crate::Store::cloud_candidates)): a placeholder the
    /// walk flagged, or a file claiming bytes with none allocated.
    pub(crate) fn cloud_candidate(&self) -> bool {
        self.pending.cloud_candidate()
    }
}

/// The part of a row the hard-link dedup decides.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Pending {
    /// The row's bytes before the dedup: a file's own, 0 for a folder.
    pub bytes: f64,
    /// Allocated less claimed bytes, where blocks mean anything and bytes are claimed.
    alloc_delta: f64,
    /// A placeholder the walk flagged itself.
    placeholder: bool,
    /// Claiming bytes with none allocated: a guess Node decides.
    unallocated: bool,
}

/// A row once the dedup is settled.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Settled {
    /// [`flag::HARDLINK_DUP`] for a later name of a hard-linked file, else 0.
    pub dup_bit: u16,
    /// The bytes the row keeps.
    pub bytes: f64,
}

/// The rules of `statToInput` and `ingestColumns` for one row: everything but what the
/// hard-link dedup decides. Fails only for a root that is not a folder.
pub(crate) fn derive_row<'a>(
    input: &RowInput<'a>,
    rules: &RowRules<'_>,
) -> Result<Row<'a>, StoreError> {
    let is_dir = input.kind == KIND_DIR;
    if input.is_root && !is_dir {
        return Err(StoreError::Malformed("the root is not a folder".into()));
    }
    let dataless = input.walk_flags & FLAG_DATALESS != 0;
    let mut bits = 0u16;
    if is_dir {
        bits |= flag::DIR | flag::HAS_CHILD_ARRAY;
    }
    if is_hidden(input.name) {
        bits |= flag::HIDDEN;
    }
    let bytes = if is_dir { 0.0 } else { input.size };
    let mut alloc_delta = 0.0;
    // Claiming bytes with none allocated: the walker's guess at a placeholder, which
    // Node decides by the path unless the walk flagged the file itself.
    let mut unallocated = false;
    if input.kind == KIND_SYMLINK {
        bits |= flag::SYMLINK;
    } else if !is_dir {
        unallocated = bytes > 0.0 && input.alloc == 0.0;
        if rules.blocks_are_meaningful && bytes > 0.0 {
            alloc_delta = input.alloc - bytes;
        }
    }
    let placeholder = dataless && !is_dir;
    if placeholder {
        bits |= flag::CLOUD_PLACEHOLDER;
    }
    let (mtime, atime) = row_times(input.is_root, input.mtime_ms, input.atime_ms, rules);
    if atime.is_some() {
        bits |= flag::HAS_ACCESSED;
    }
    let decided = decided_here(input.name);
    let (extension, container) = if decided {
        let raw = if is_dir { None } else { extension(input.name) };
        (
            raw,
            container_kind(input.name, is_dir, rules.container_rules),
        )
    } else {
        (None, 0)
    };
    Ok(Row {
        bits,
        mtime,
        atime,
        decided,
        extension,
        container,
        marks_parent_git_repo: is_dir && !input.is_root && input.name == b".git",
        pending: Pending {
            bytes,
            alloc_delta,
            placeholder,
            unallocated,
        },
    })
}

/// The modification and access times the store keeps for a row the walk listed with
/// these (for a folder listed on Windows, the times its own listing read): the root's
/// withheld modification time is Node's own; an access time only when one was recorded.
pub(crate) fn row_times(
    is_root: bool,
    mtime_ms: f64,
    atime_ms: f64,
    rules: &RowRules<'_>,
) -> (f64, Option<f64>) {
    let mtime = if is_root && !mtime_ms.is_finite() {
        rules.root_mtime_ms
    } else {
        store_mtime(mtime_ms)
    };
    (mtime, store_atime(atime_ms))
}

impl Pending {
    /// Whether Node applies the cloud rule to the row ([`Row::cloud_candidate`]).
    pub(crate) fn cloud_candidate(&self) -> bool {
        self.placeholder || self.unallocated
    }

    /// The walk flag bits a file's derivation read: [`derive_row`] reads `FLAG_DATALESS`
    /// alone, and for a file it is exactly `placeholder`. What a file's row is derived
    /// again from, without keeping the listing's bits (`memory/refresh.rs`).
    pub(crate) fn file_walk_flags(&self) -> u8 {
        if self.placeholder { FLAG_DATALESS } else { 0 }
    }

    /// Settles the row once the dedup is decided, adding its tallies to `counters` as
    /// the ingest keeps them: a `duplicate` (a later name of a hard-linked file) keeps
    /// no bytes and counts as one; a placeholder counts its bytes (0 for a duplicate);
    /// the sparse and slack tallies count neither duplicates, placeholders nor guesses.
    /// A row counted sparse is a term `(id, bytes it does not take)` in `terms` when
    /// there are terms to keep.
    pub(crate) fn settle(
        &self,
        duplicate: bool,
        id: u32,
        counters: &mut Counters,
        terms: Option<&mut Vec<(u32, f64)>>,
    ) -> Settled {
        let mut bytes = self.bytes;
        let mut dup_bit = 0;
        if duplicate {
            dup_bit = flag::HARDLINK_DUP;
            counters.hardlinked_files += 1;
            counters.hardlinked_bytes += bytes;
            bytes = 0.0;
        }
        if self.placeholder {
            counters.cloud_files += 1;
            counters.cloud_bytes += bytes;
        }
        if self.alloc_delta != 0.0 && !duplicate && !self.placeholder && !self.unallocated {
            if self.alloc_delta < 0.0 {
                counters.sparse_files += 1;
                counters.sparse_bytes -= self.alloc_delta;
                if let Some(terms) = terms {
                    terms.push((id, -self.alloc_delta));
                }
            } else {
                counters.slack_bytes += self.alloc_delta;
            }
        }
        Settled { dup_bit, bytes }
    }
}

/// Whether `sparseBytes` comes out the same in any order, whatever Node decides about its
/// guesses, fed every row's size and allocation. Each of its terms is a row's shortfall
/// (its size less its allocation): a file counted here, or a guess Node counts. When every
/// positive shortfall is a whole number and they total below 2^53, every partial sum of
/// any of them is a whole number below 2^53, which a double holds exactly. The running
/// total here is exact while it stays below 2^53, and once it reaches 2^53 it stays at or
/// above it, because every shortfall added is positive; so it ends below 2^53 exactly when
/// the true total does, in whatever order and however grouped the rows are fed.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ShortfallSum {
    total: f64,
    whole: bool,
}

impl Default for ShortfallSum {
    fn default() -> Self {
        Self {
            total: 0.0,
            whole: true,
        }
    }
}

impl ShortfallSum {
    /// Feeds one row.
    pub(crate) fn add(&mut self, size: f64, alloc: f64) {
        let shortfall = size - alloc;
        if shortfall > 0.0 {
            if shortfall.fract() != 0.0 {
                self.whole = false;
            }
            self.total += shortfall;
        }
    }

    /// Feeds another sum's rows.
    pub(crate) fn merge(&mut self, other: &Self) {
        self.whole &= other.whole;
        self.total += other.total;
    }

    /// Whether every row fed so far leaves `sparseBytes` the same in any order.
    pub(crate) fn is_exact(&self) -> bool {
        self.whole && self.total < WHOLE_NUMBERS_EXACT_BELOW
    }
}

/// The extension dictionary as `internExt` builds it: lower-cased, first seen first,
/// "none" at 0, and every extension past the limit kept per node instead.
pub(crate) struct ExtInterner {
    dict: Vec<String>,
    lookup: HashMap<Vec<u8>, u16>,
    overflow: Vec<(u32, String)>,
    lowered: Vec<u8>,
}

impl ExtInterner {
    pub(crate) fn new() -> Self {
        Self {
            dict: vec![String::new()],
            lookup: HashMap::new(),
            overflow: Vec::new(),
            lowered: Vec::new(),
        }
    }

    /// The column value for the raw ASCII extension `raw` of node `id`.
    pub(crate) fn intern(&mut self, raw: &[u8], id: u32) -> u16 {
        self.lowered.clear();
        self.lowered.extend(raw.iter().map(u8::to_ascii_lowercase));
        if let Some(&known) = self.lookup.get(self.lowered.as_slice()) {
            return known;
        }
        // ASCII, so the conversion is exact.
        let text = String::from_utf8_lossy(&self.lowered).into_owned();
        match u16::try_from(self.dict.len()) {
            Ok(next) if usize::from(next) < EXT_DICT_LIMIT => {
                self.dict.push(text);
                self.lookup.insert(self.lowered.clone(), next);
                next
            }
            _ => {
                self.overflow.push((id, text));
                EXT_OVERFLOW
            }
        }
    }

    /// The dictionary, and the extensions past it by node, in the order interned.
    pub(crate) fn finish(self) -> (Vec<String>, Vec<(u32, String)>) {
        (self.dict, self.overflow)
    }
}

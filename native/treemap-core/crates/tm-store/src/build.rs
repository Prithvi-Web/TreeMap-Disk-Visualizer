//! The store built from a walk: the Node ingest (`ingestColumns`), rule for rule.

use std::collections::HashMap;

use tm_walk::{
    DirRefusal, FLAG_DATALESS, HardlinkRef, KIND_DIR, KIND_SYMLINK, Refusal, WalkOutput, WalkStats,
};

use crate::column::Column;
use crate::derive::{
    ContainerRule, container_kind, decided_here, extension, is_hidden, rule_problem, store_atime,
    store_mtime,
};
use crate::finalize::breadth_first;
use crate::{EXT_NONE, EXT_OVERFLOW, StoreError, flag};

/// Name bytes reserved per headroom row, so a node added after the build (a container
/// expanded, a file the watcher saw) finds room for its name as well as its row.
pub const NAME_BYTES_PER_HEADROOM_ROW: usize = 64;

/// The most entries the extension dictionary holds, "none" included; later extensions
/// go to [`Store::ext_overflow`] (`internExt` in `scanStore.ts`).
const EXT_DICT_LIMIT: usize = 0xffff;

/// 2^53: a double holds every whole number below it, and not every one above it.
const WHOLE_NUMBERS_EXACT_BELOW: f64 = 9_007_199_254_740_992.0;

/// Where the store's columns live.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StoreMode {
    /// In this process's memory.
    Memory,
    /// Written to files in the app's data folder and mapped (not built yet).
    Spill,
    /// Folders and the largest entries only (not built yet).
    Aggregate,
}

/// What Node tells the build that the walk does not know.
#[derive(Clone, PartialEq, Debug)]
pub struct BuildOptions {
    /// The root's name as the store shows it: Node's `rootName(rootPath)` (the last path
    /// component, or the whole path when it has none).
    pub root_name: String,
    /// The root's modification time from Node's own stat, `Math.round`ed as
    /// `statToInput` does: kept when the walk withheld the root's own.
    pub root_mtime_ms: f64,
    /// Whether allocated bytes mean anything here (`platform().blocksAreMeaningful`:
    /// false on Windows, where libuv reports no blocks). Gates the sparse and slack tallies.
    pub blocks_are_meaningful: bool,
    /// Whether each folder's children are sorted by name bytes (every platform but
    /// Windows, `SORT_CHILDREN` in `nativeEngine.ts`).
    pub sort_children: bool,
    /// `detectContainerKind`'s rules, in its order: the first match wins.
    pub container_rules: Vec<ContainerRule>,
    /// Rows to leave room for after the build (decision P4-6).
    pub headroom_rows: u32,
    /// Where the columns live.
    pub mode: StoreMode,
}

/// The scan's tallies as the ingest keeps them on the scan record, before the Node passes
/// over the candidates (see [`Store::cloud_candidates`]). Node adds its guesses to the file
/// counts; `cloud_bytes` and `sparse_bytes` it recomputes, and never adds to.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct Counters {
    /// Folders, the root included (`dirCount`).
    pub dirs: u64,
    /// Everything that is not a folder (`fileCount`).
    pub files: u64,
    /// Later names of hard-linked files (`hardlinkedFiles`).
    pub hardlinked_files: u64,
    /// Their bytes, counted once at the first name (`hardlinkedBytes`).
    pub hardlinked_bytes: f64,
    /// Placeholders the walk itself flagged (`cloudFiles`, before Node's guesses).
    pub cloud_files: u64,
    /// Their bytes (`cloudBytes`, before Node's guesses; Node sums the total over
    /// [`Store::cloud_candidates`], which keeps the ingest's order).
    pub cloud_bytes: f64,
    /// Files with fewer bytes allocated than claimed (`sparseFiles`, before Node's guesses).
    pub sparse_files: u64,
    /// The bytes they do not take (`sparseBytes`, before Node's guesses; Node sums the
    /// total from [`Store::sparse_terms`], which keeps the ingest's order).
    pub sparse_bytes: f64,
    /// The bytes allocated beyond what files claim (`slackBytes`).
    pub slack_bytes: f64,
    /// Store ids of the folders the OS would not let the walk list; Node records each
    /// with its path (`noteRefused`, the five smallest paths as examples).
    pub denied_dirs: Vec<u32>,
    /// Folders that were gone by the time they were listed (`vanishedDirs`).
    pub vanished_dirs: u64,
    /// Folders that could not be read for any other reason (`unreadableDirs`).
    pub unreadable_dirs: u64,
}

/// The finalized store: `PackedScanStore`'s columns (decision P4-1) and what Node needs to
/// adopt them. Every column has `n` rows and room for `capacity`.
#[derive(Clone, PartialEq, Debug)]
pub struct Store {
    /// Where the columns live.
    pub mode: StoreMode,
    /// Rows, the root included.
    pub n: u32,
    /// Rows the columns have room for: `n` plus the headroom.
    pub capacity: u32,
    /// Each node's parent's id; −1 for the root.
    pub parent: Column<i32>,
    /// Bytes: a file's own (0 for a later hard-link name), 0 for a folder until Node's
    /// `sumSizes()` totals them.
    pub size: Column<f64>,
    /// Modification time, milliseconds, as `Math.round` gives it.
    pub mtime: Column<f64>,
    /// Access time where [`flag::HAS_ACCESSED`] is set (0 elsewhere); `None` when no node has one.
    pub atime: Option<Column<f64>>,
    /// [`flag`] bits.
    pub flags: Column<u16>,
    /// An index into [`Store::ext_dict`], [`EXT_NONE`] or [`EXT_OVERFLOW`].
    pub ext: Column<u16>,
    /// The container kind (`CONTAINER_ID`), 0 for none.
    pub container: Column<u8>,
    /// The cloud provider (`CLOUD_ID`), 0 for none: always 0 here, Node sets it.
    pub cloud_prov: Column<u8>,
    /// `n + 1` offsets into `names`.
    pub name_off: Column<u32>,
    /// Every name, UTF-8, in id order.
    pub names: Column<u8>,
    /// Each node's first child's id (where it would be, for a node without children).
    pub child_start: Column<u32>,
    /// Each node's child count.
    pub child_cnt: Column<u32>,
    /// The extensions, "none" (the empty string) first, in the order first seen.
    pub ext_dict: Vec<String>,
    /// `(id, extension)` for extensions past the dictionary's limit.
    pub ext_overflow: Vec<(u32, String)>,
    /// Ids, ascending, of the nodes Node applies the cloud rule to (decision P4-3):
    /// placeholders the walk flagged ([`flag::CLOUD_PLACEHOLDER`] already set and counted;
    /// Node looks up the provider), and files the walker would have to guess about — more
    /// than 0 bytes claimed, none allocated, not a symlink — judged on the walk's bytes, so a
    /// later hard-link name is one as well as its first. For a guess Node decides: a
    /// provider for its path makes it a placeholder (the flag, the provider, `cloudFiles`
    /// += 1); no provider makes it sparse where blocks mean anything and it is not a later
    /// hard-link name (`sparseFiles` += 1, and its size a `sparseBytes` term, see
    /// [`Store::sparse_terms`]). The counters here include neither. Every `cloudBytes` term
    /// is a candidate's store size (0 for a later hard-link name), so Node has the
    /// ingest's `cloudBytes` by summing, from 0 in id order, the sizes of the candidates
    /// that end up placeholders, the walk's own included.
    pub cloud_candidates: Vec<u32>,
    /// Ids, ascending, of the nodes whose names have a non-ASCII byte and a dot: Node sets
    /// their extension and container kind with `statToInput`'s own rules (see
    /// [`crate::derive::decided_here`]); here both are left at none.
    pub text_candidates: Vec<u32>,
    /// `sparseBytes` in the ingest's order: `(id, bytes)`, ascending ids. `ingestColumns`
    /// keeps one running sum in id order, the guesses Node decides among the files counted
    /// here, and a float sum depends on its order; so Node's total is, from 0 in id order,
    /// each term here and the size of each guess it counts sparse. A term is a file counted
    /// here and the bytes it does not take, except when every row's shortfall (its size
    /// less its allocation, where positive) is a whole number and they total below 2^53:
    /// then every partial sum of any of them is exact, the order cannot show, and the
    /// terms are one, `(0, sparse_bytes)`, or none when no file was counted.
    pub sparse_terms: Vec<(u32, f64)>,
    /// The tallies.
    pub counters: Counters,
    /// What the walk measured about itself.
    pub walk_stats: WalkStats,
}

/// Builds the store from a walk, deriving every fact as the Node ingest does.
pub fn build(walk: WalkOutput, opts: &BuildOptions) -> Result<Store, StoreError> {
    if opts.mode != StoreMode::Memory {
        return Err(StoreError::ModeNotBuilt(opts.mode));
    }
    for (index, rule) in opts.container_rules.iter().enumerate() {
        if let Some(why) = rule_problem(rule) {
            return Err(StoreError::BadContainerRule {
                index,
                text: rule.text.clone(),
                why,
            });
        }
    }
    check_lengths(&walk)?;
    let n = walk.len();
    let rows = n as u64 + u64::from(opts.headroom_rows);
    let capacity = i32::try_from(rows)
        .ok()
        .and_then(|c| u32::try_from(c).ok())
        .ok_or(StoreError::TooManyRows { rows })?;
    let rows_now = u32::try_from(n).map_err(|_| StoreError::TooManyRows { rows })?;
    check_side_table("hard-link", walk.hardlinks.iter().map(|r| r.node), n)?;
    check_side_table("refusal", walk.refusals.iter().map(|r| r.node), n)?;
    let order = breadth_first(
        &walk.parent,
        &walk.name_off,
        &walk.names,
        opts.sort_children,
    )?;
    let headroom = opts.headroom_rows as usize;
    let keep_sparse_terms = !sparse_sums_are_exact(&walk, opts.blocks_are_meaningful);

    let reserve = |len: usize| len + headroom;
    let mut size = Vec::with_capacity(reserve(n));
    let mut mtime = Vec::with_capacity(reserve(n));
    let mut atime: Option<Vec<f64>> = None;
    let mut flags: Vec<u16> = Vec::with_capacity(reserve(n));
    let mut ext = Vec::with_capacity(reserve(n));
    let mut container = Vec::with_capacity(reserve(n));
    let mut name_off = Vec::with_capacity(reserve(n) + 1);
    let name_bytes = walk.names.len() + opts.root_name.len();
    let mut names = Vec::with_capacity(name_bytes + headroom * NAME_BYTES_PER_HEADROOM_ROW);
    let mut interner = ExtInterner::new();
    // Families are numbered from 0, at most one per row of the table (the walk's promise).
    let mut seen_families = vec![false; walk.hardlinks.len()];
    let mut cloud_candidates = Vec::new();
    let mut text_candidates = Vec::new();
    let mut sparse_terms = Vec::new();
    let mut counters = Counters {
        dirs: 1,
        ..Counters::default()
    };
    name_off.push(0u32);

    for (sid, &w) in (0u32..).zip(order.walk_index.iter()) {
        let id = sid as usize;
        let wi = w as usize;
        let kind = column_at(&walk.kind, wi)?;
        let is_root = id == 0;
        let is_dir = kind == KIND_DIR;
        if is_root && !is_dir {
            return Err(StoreError::Malformed("the root is not a folder".into()));
        }
        let name: &[u8] = if is_root {
            opts.root_name.as_bytes()
        } else {
            walk.name(wi)
                .ok_or_else(|| StoreError::Malformed(format!("node {w} has no name")))?
        };
        let walk_flags = column_at(&walk.flags, wi)?;
        let dataless = walk_flags & FLAG_DATALESS != 0;

        let mut bits = 0u16;
        if is_dir {
            bits |= flag::DIR | flag::HAS_CHILD_ARRAY;
        }
        if is_hidden(name) {
            bits |= flag::HIDDEN;
        }
        let mut bytes = if is_dir {
            0.0
        } else {
            column_at(&walk.size, wi)?
        };
        let mut alloc_delta = 0.0;
        let mut family = None;
        // Claiming bytes with none allocated: the walker's guess at a placeholder, which
        // Node decides by the path unless the walk flagged the file itself.
        let mut unallocated = false;
        if kind == KIND_SYMLINK {
            bits |= flag::SYMLINK;
        } else if !is_dir {
            let alloc = column_at(&walk.alloc_bytes, wi)?;
            unallocated = bytes > 0.0 && alloc == 0.0;
            if opts.blocks_are_meaningful && bytes > 0.0 {
                alloc_delta = alloc - bytes;
            }
            family = family_of(&walk.hardlinks, w);
        }
        let placeholder = dataless && !is_dir;
        if placeholder {
            bits |= flag::CLOUD_PLACEHOLDER;
        }
        if placeholder || unallocated {
            cloud_candidates.push(sid);
        }
        if let Some(family) = family {
            let Some(seen) = seen_families.get_mut(family as usize) else {
                return Err(StoreError::Malformed(format!(
                    "node {w}'s hard-link family {family} is past the table's {} rows",
                    walk.hardlinks.len()
                )));
            };
            if *seen {
                bits |= flag::HARDLINK_DUP;
                counters.hardlinked_files += 1;
                counters.hardlinked_bytes += bytes;
                bytes = 0.0;
            }
            *seen = true;
        }
        if placeholder {
            counters.cloud_files += 1;
            counters.cloud_bytes += bytes;
        }
        let duplicate = bits & flag::HARDLINK_DUP != 0;
        if alloc_delta != 0.0 && !duplicate && !placeholder && !unallocated {
            if alloc_delta < 0.0 {
                counters.sparse_files += 1;
                counters.sparse_bytes -= alloc_delta;
                if keep_sparse_terms {
                    sparse_terms.push((sid, -alloc_delta));
                }
            } else {
                counters.slack_bytes += alloc_delta;
            }
        }
        if is_dir && !is_root && name == b".git" {
            let parent = order
                .parent
                .get(id)
                .and_then(|&p| usize::try_from(p).ok())
                .and_then(|p| flags.get_mut(p))
                .ok_or_else(|| StoreError::Malformed(format!("node {w}'s parent is missing")))?;
            *parent |= flag::GIT_REPO;
        }

        let walk_mtime = column_at(&walk.mtime_ms, wi)?;
        mtime.push(if is_root && !walk_mtime.is_finite() {
            opts.root_mtime_ms
        } else {
            store_mtime(walk_mtime)
        });
        if let Some(accessed) = store_atime(column_at(&walk.atime_ms, wi)?) {
            bits |= flag::HAS_ACCESSED;
            let column = atime.get_or_insert_with(|| {
                let mut zeros = Vec::with_capacity(reserve(n));
                zeros.resize(id, 0.0);
                zeros
            });
            column.push(accessed);
        } else if let Some(column) = atime.as_mut() {
            column.push(0.0);
        }

        if decided_here(name) {
            let extension_id = if is_dir {
                EXT_NONE
            } else {
                extension(name).map_or(EXT_NONE, |raw| interner.intern(raw, sid))
            };
            ext.push(extension_id);
            container.push(container_kind(name, is_dir, &opts.container_rules));
        } else {
            text_candidates.push(sid);
            ext.push(EXT_NONE);
            container.push(0);
        }

        if let Some(why) = refusal_of(&walk.refusals, w) {
            match why {
                Refusal::Denied => counters.denied_dirs.push(sid),
                Refusal::Vanished => counters.vanished_dirs += 1,
                Refusal::Unreadable => counters.unreadable_dirs += 1,
            }
        }
        if !is_root {
            if is_dir {
                counters.dirs += 1;
            } else {
                counters.files += 1;
            }
        }
        size.push(bytes);
        flags.push(bits);
        names.extend_from_slice(name);
        let end = u32::try_from(names.len()).map_err(|_| StoreError::NamesTooLong {
            bytes: names.len() as u64,
        })?;
        name_off.push(end);
    }

    if !keep_sparse_terms && counters.sparse_files > 0 {
        sparse_terms.push((0, counters.sparse_bytes));
    }
    let with_room = |mut column: Vec<u32>| {
        column.reserve_exact(headroom);
        Column::Owned(column)
    };
    let mut parent = order.parent;
    parent.reserve_exact(headroom);
    let mut cloud_prov = Vec::with_capacity(reserve(n));
    cloud_prov.resize(n, 0u8);
    let (ext_dict, ext_overflow) = interner.finish();
    Ok(Store {
        mode: opts.mode,
        n: rows_now,
        capacity,
        parent: Column::Owned(parent),
        size: Column::Owned(size),
        mtime: Column::Owned(mtime),
        atime: atime.map(Column::Owned),
        flags: Column::Owned(flags),
        ext: Column::Owned(ext),
        container: Column::Owned(container),
        cloud_prov: Column::Owned(cloud_prov),
        name_off: Column::Owned(name_off),
        names: Column::Owned(names),
        child_start: with_room(order.child_start),
        child_cnt: with_room(order.child_cnt),
        ext_dict,
        ext_overflow,
        cloud_candidates,
        text_candidates,
        sparse_terms,
        counters,
        walk_stats: walk.stats,
    })
}

/// Every per-node column has the walk's length, and the name offsets one more.
fn check_lengths(walk: &WalkOutput) -> Result<(), StoreError> {
    let n = walk.len();
    let lengths = [
        ("kind", walk.kind.len()),
        ("flags", walk.flags.len()),
        ("size", walk.size.len()),
        ("alloc_bytes", walk.alloc_bytes.len()),
        ("mtime_ms", walk.mtime_ms.len()),
        ("atime_ms", walk.atime_ms.len()),
    ];
    for (column, len) in lengths {
        if len != n {
            return Err(StoreError::Malformed(format!(
                "{column} has {len} rows for {n} nodes"
            )));
        }
    }
    Ok(())
}

/// A side table names nodes of the walk, each once, in increasing order: the walk's
/// promise, which the lookups by binary search rely on.
fn check_side_table(
    table: &str,
    nodes: impl Iterator<Item = u32>,
    n: usize,
) -> Result<(), StoreError> {
    let mut last: Option<u32> = None;
    for node in nodes {
        if node as usize >= n {
            return Err(StoreError::Malformed(format!(
                "the {table} table names node {node} of {n}"
            )));
        }
        if let Some(last) = last.filter(|&last| node <= last) {
            return Err(StoreError::Malformed(format!(
                "the {table} table names node {node} after node {last}"
            )));
        }
        last = Some(node);
    }
    Ok(())
}

/// The hard-link family of walk node `node`, if it has one.
fn family_of(links: &[HardlinkRef], node: u32) -> Option<u32> {
    let row = links.binary_search_by_key(&node, |r| r.node).ok()?;
    links.get(row).map(|r| r.family)
}

/// Why walk node `node` could not be listed, if it could not.
fn refusal_of(refusals: &[DirRefusal], node: u32) -> Option<Refusal> {
    let row = refusals.binary_search_by_key(&node, |r| r.node).ok()?;
    refusals.get(row).map(|r| r.why)
}

/// Whether `sparseBytes` comes out the same in any order, whatever Node decides about its
/// guesses. Each of its terms is a row's shortfall (its size less its allocation): a file
/// counted here, or a guess Node counts. When every positive shortfall is a whole number
/// and they total below 2^53, every partial sum of any of them is a whole number below
/// 2^53, which a double holds exactly. The running total below is exact while it stays
/// below 2^53, and once it reaches 2^53 it stays at or above it, because every shortfall
/// added is positive; so it ends below 2^53 exactly when the true total does. Where blocks
/// mean nothing there are no terms.
fn sparse_sums_are_exact(walk: &WalkOutput, blocks_are_meaningful: bool) -> bool {
    if !blocks_are_meaningful {
        return true;
    }
    let mut total = 0.0;
    for (&size, &alloc) in walk.size.iter().zip(&walk.alloc_bytes) {
        let shortfall = size - alloc;
        if shortfall > 0.0 {
            if shortfall.fract() != 0.0 {
                return false;
            }
            total += shortfall;
        }
    }
    total < WHOLE_NUMBERS_EXACT_BELOW
}

// `#[inline]`: without the hint LLVM left this a call in `build`'s per-node loop (fat LTO,
// Rust 1.98.1), and the loop ran about 20% slower on a 5M-node synthetic walk (24 Sep 2026).
#[inline]
fn column_at<T: Copy>(column: &[T], index: usize) -> Result<T, StoreError> {
    column
        .get(index)
        .copied()
        .ok_or_else(|| StoreError::Malformed(format!("no row {index}")))
}

/// The extension dictionary as `internExt` builds it: lower-cased, first seen first,
/// "none" at 0, and every extension past the limit kept per node instead.
struct ExtInterner {
    dict: Vec<String>,
    lookup: HashMap<Vec<u8>, u16>,
    overflow: Vec<(u32, String)>,
    lowered: Vec<u8>,
}

impl ExtInterner {
    fn new() -> Self {
        Self {
            dict: vec![String::new()],
            lookup: HashMap::new(),
            overflow: Vec::new(),
            lowered: Vec::new(),
        }
    }

    /// The column value for the raw ASCII extension `raw` of node `id`.
    fn intern(&mut self, raw: &[u8], id: u32) -> u16 {
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

    fn finish(self) -> (Vec<String>, Vec<(u32, String)>) {
        (self.dict, self.overflow)
    }
}

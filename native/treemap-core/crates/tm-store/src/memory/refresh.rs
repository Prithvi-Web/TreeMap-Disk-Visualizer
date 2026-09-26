//! The Windows families' re-read at the seal (T7b; design §S.1.5). A hard-link family
//! found by file id alone — listings that report no link count — holds each name's own
//! copy of the file's facts, and NTFS refreshes a name's copy only when the file is
//! opened through that name, so the copies can be stale. The walk's `refresh_families`
//! reads the file once, through the family's lowest-numbered member, for its collector;
//! the seal reads it the same way — through the walk's own lister, from its root, on its
//! driver thread (T8a: [`Finishing`]) — and derives every member again from what it read.
//! A volume can hold tens of thousands of families (`C:\Windows\WinSxS`), so each read
//! first checks for a cancel and moves the heartbeat, as the walk's refresh does (R90).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use tm_walk::{Finishing, IdFamily, KIND_FILE, Meta, reread_family};

use super::{MemorySink, Side};
use crate::row::{RowInput, RowRules, derive_row};
use crate::{StoreError, flag};

/// The columns a re-read reads a member's path from, and those it writes again.
pub(super) struct Rows<'c> {
    pub parent: &'c [i32],
    pub name_off: &'c [u32],
    pub names: &'c [u8],
    pub mtime: &'c mut [f64],
    /// `None` only where no row has an access time and no family is re-read.
    pub atime: Option<&'c mut [f64]>,
    pub flags: &'c mut [u16],
}

impl MemorySink {
    /// Re-reads each of `families` as the walk's `refresh_families` does, and derives every
    /// member of a family whose read reached its own file again from what it read.
    pub(super) fn reread_families(
        &self,
        ending: &Finishing<'_>,
        families: &[IdFamily],
        side: &mut Side,
        mut rows: Rows<'_>,
    ) -> Result<(), StoreError> {
        let rules = self.rules();
        let mut changes = Changes::default();
        for family in families {
            if ending.cancelled() {
                return Err(StoreError::Sink(
                    "the walk was cancelled while its hard-link families were read".into(),
                ));
            }
            ending.beat();
            let Some(meta) = read_family(ending, &rows, family) else {
                continue;
            };
            for &node in &family.members {
                rederive(node, &meta, &rules, side, &mut rows, &mut changes)?;
            }
        }
        changes.apply(side, &self.accessed);
        Ok(())
    }
}

/// What deriving members again changed beyond their own rows.
#[derive(Default)]
struct Changes {
    /// Members that became cloud candidates.
    gained: Vec<u32>,
    /// Members that stopped being cloud candidates.
    lost: Vec<u32>,
    /// Members that gained an access time.
    accessed: u64,
    /// Members that lost their access time.
    unaccessed: u64,
}

impl Changes {
    /// Brings the cloud candidates and the count of rows with an access time up to date.
    fn apply(mut self, side: &mut Side, accessed: &AtomicU64) {
        if !self.lost.is_empty() {
            self.lost.sort_unstable();
            side.cloud_candidates
                .retain(|id| self.lost.binary_search(id).is_err());
        }
        side.cloud_candidates.extend(self.gained);
        accessed.fetch_add(self.accessed, Ordering::AcqRel);
        accessed.fetch_sub(self.unaccessed, Ordering::AcqRel);
    }
}

/// The facts of `family`'s file, read through its lowest-numbered member as the walk
/// reads them; `None` when that read does not reach the family's own file.
fn read_family(ending: &Finishing<'_>, rows: &Rows<'_>, family: &IdFamily) -> Option<Meta> {
    let &first = family.members.first()?;
    let path = row_path(ending.root(), rows, first)?;
    reread_family(ending.lister(), &path, ending.want_atime(), family)
}

/// Derives member `node` — a file — again from its file's own size and times (`meta`) with
/// its listing's allocation, placeholder flag and name, as `build` derives it from the walk's
/// refreshed columns: its times, its access-time bit, what its dedup settles (in
/// `side.keyed`, sorted by id) and whether it is a cloud candidate.
fn rederive(
    node: u32,
    meta: &Meta,
    rules: &RowRules<'_>,
    side: &mut Side,
    rows: &mut Rows<'_>,
    changes: &mut Changes,
) -> Result<(), StoreError> {
    let keyed = side
        .keyed
        .binary_search_by_key(&node, |keyed| keyed.key.node)
        .ok()
        .and_then(|at| side.keyed.get_mut(at))
        .ok_or_else(|| StoreError::Sink(format!("member {node} has no link key")))?;
    let name = row_name(rows.name_off, rows.names, node)
        .ok_or_else(|| StoreError::Sink(format!("row {node} has no name")))?;
    let row = derive_row(
        &RowInput {
            name,
            is_root: false,
            kind: KIND_FILE,
            walk_flags: keyed.pending.file_walk_flags(),
            size: meta.size,
            alloc: keyed.alloc,
            mtime_ms: meta.mtime_ms,
            atime_ms: meta.atime_ms,
        },
        rules,
    )?;
    match (keyed.pending.cloud_candidate(), row.cloud_candidate()) {
        (false, true) => changes.gained.push(node),
        (true, false) => changes.lost.push(node),
        _ => {}
    }
    keyed.pending = row.pending;
    let at = node as usize;
    let (Some(bits), Some(mtime)) = (rows.flags.get_mut(at), rows.mtime.get_mut(at)) else {
        return Err(StoreError::Sink(format!("row {node} is past the rows")));
    };
    match (*bits & flag::HAS_ACCESSED != 0, row.atime.is_some()) {
        (false, true) => changes.accessed += 1,
        (true, false) => changes.unaccessed += 1,
        _ => {}
    }
    // A file's bits are all its own row's: no dedup bit yet, never `GitRepo`.
    *bits = row.bits;
    *mtime = row.mtime;
    if let Some(time) = rows
        .atime
        .as_deref_mut()
        .and_then(|times| times.get_mut(at))
    {
        *time = row.atime.unwrap_or(0.0);
    }
    Ok(())
}

/// Row `node`'s stored name.
fn row_name<'n>(name_off: &[u32], names: &'n [u8], node: u32) -> Option<&'n [u8]> {
    let at = node as usize;
    let start = *name_off.get(at)? as usize;
    let end = *name_off.get(at.checked_add(1)?)? as usize;
    names.get(start..end)
}

/// Row `node`'s path: the stored names of the rows from the root down to it, joined under
/// `root`, as the walk's `node_path` joins them; `None` when a name is not UTF-8 or a
/// parent is out of range, and then its family keeps its listings' facts, as in the walk.
fn row_path(root: &Path, rows: &Rows<'_>, node: u32) -> Option<PathBuf> {
    let mut chain = Vec::new();
    let mut at = node;
    while at != 0 {
        chain.push(at);
        if chain.len() > rows.parent.len() {
            return None;
        }
        at = u32::try_from(*rows.parent.get(at as usize)?).ok()?;
    }
    let mut path = root.to_path_buf();
    for &row in chain.iter().rev() {
        path.push(std::str::from_utf8(row_name(rows.name_off, rows.names, row)?).ok()?);
    }
    Some(path)
}

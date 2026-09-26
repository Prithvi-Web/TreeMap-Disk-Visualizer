//! The columns a walk gathers and the merge that lays them out in id order:
//! each worker's [`Part`], [`merge`] into [`Merged`], the block collector's
//! [`collected`] check, and the Windows hard-link family refresh that reads
//! the merged columns. Moved out of `walk.rs` unchanged (Phase 4, T6b).

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use super::Shared;
use crate::invariants::check_walk_columns;
use crate::links::{IdFamily, LinkKey, hardlink_families};
use crate::output::{DirRefusal, HardlinkRef};
use crate::platform::{DirTimes, Meta};
use crate::sink::CollectSink;
use crate::{FLAG_REFUSED_DIR, KIND_FILE, WalkError};

/// One worker's columns, in its own discovery order, keyed by global id.
#[derive(Default)]
pub(crate) struct Part {
    pub(super) ids: Vec<u32>,
    parent: Vec<u32>,
    names: Vec<u8>,
    name_len: Vec<u32>,
    kind: Vec<u8>,
    flags: Vec<u8>,
    size: Vec<f64>,
    alloc: Vec<f64>,
    mtime: Vec<f64>,
    atime: Vec<f64>,
    /// Leaves that may share their file with another name: those whose
    /// listing reported a link count above one, and those whose listing
    /// reported none (`nlink == 0`, Windows), each keyed by its exact id and
    /// resolved into families at the merge ([`hardlink_families`]).
    pub(crate) link_keys: Vec<LinkKey>,
    pub(crate) refusals: Vec<DirRefusal>,
    /// Directories whose own listing reported their own times (Windows), which
    /// replace the copy their parent's listing gave; applied at the merge.
    pub(crate) time_patches: Vec<(u32, DirTimes)>,
    pub(super) cpu_seconds: f64,
}

impl Part {
    /// Appends a node. The name goes into the arena as valid UTF-8: the OS
    /// bytes when they are, U+FFFD per maximal invalid subpart otherwise.
    pub(crate) fn push(&mut self, id: u32, parent: u32, name: &[u8], meta: &Meta) {
        let text = String::from_utf8_lossy(name);
        self.ids.push(id);
        self.parent.push(parent);
        self.names.extend_from_slice(text.as_bytes());
        self.name_len
            .push(u32::try_from(text.len()).unwrap_or(u32::MAX));
        self.kind.push(meta.kind);
        self.flags.push(meta.flags);
        self.size.push(meta.size);
        self.alloc.push(meta.alloc);
        self.mtime.push(meta.mtime_ms);
        self.atime.push(meta.atime_ms);
    }
}

/// What a block-numbered walk's collector gathered, in id order. Every test
/// build holds it to I1–I4 first: the store adopts these columns without
/// checking them (`PackedScanStore.adoptColumns` trusts its producer).
pub(super) fn collected(collect: &CollectSink, total: usize) -> Result<Merged, WalkError> {
    let merged = collect.merge(total)?;
    if cfg!(debug_assertions) {
        check_walk_columns(&merged.parent, &merged.name_off, &merged.names, false)
            .map_err(|broken| WalkError::Internal(format!("block numbering: {broken}")))?;
    }
    Ok(merged)
}

/// Gives every member of each hard-link family found by file id the size and
/// times of the file itself. Windows' listing reports each name's own copy of
/// them, and NTFS refreshes a name's copy only when the file is opened
/// through that name (CreateHardLink's documentation), so a file changed
/// through one name lists stale values under the others — where the legacy
/// walker's lstat opens every name and reads the file. One read per family,
/// through its lowest-numbered member, on the driver thread once the workers
/// are done; a family whose file cannot be read keeps what its listing said.
/// A file whose other names are all outside the scan is not a family here,
/// and keeps its listing's copy (DESIGN §16).
///
/// A volume can hold tens of thousands of families (`C:\Windows\WinSxS`), so
/// each read checks for a cancel and moves the heartbeat: the walk stops when
/// asked and is never mistaken for a stalled one. And a read counts only when
/// it reaches the family's own file — a folder on the way swapped for a link
/// since the listing would lead to another file, whose facts are not this
/// family's; where a handle's id cannot be matched against the listing's
/// (ReFS: 64 bits against 128), the family keeps what its listing said (the
/// pre-landing review of 23 Sep 2026).
pub(super) fn refresh_families(shared: &Shared, merged: &mut Merged) -> Result<(), WalkError> {
    for family in &merged.id_families {
        if shared.is_cancelled() {
            return Err(WalkError::Cancelled);
        }
        shared.heartbeat.fetch_add(1, Ordering::AcqRel);
        let Some(&first) = family.members.first() else {
            continue;
        };
        let Some(path) = node_path(&shared.root, merged, first) else {
            continue;
        };
        let Ok(meta) = shared.lister.stat_dir(&path, shared.want_atime) else {
            continue;
        };
        if meta.kind != KIND_FILE || meta.dev.to_bits() != family.dev || meta.ino != family.ino {
            continue;
        }
        for &node in &family.members {
            let i = node as usize;
            if let Some(size) = merged.size.get_mut(i) {
                *size = meta.size;
            }
            if let Some(mtime) = merged.mtime.get_mut(i) {
                *mtime = meta.mtime_ms;
            }
            if let Some(atime) = merged.atime.get_mut(i) {
                *atime = meta.atime_ms;
            }
        }
    }
    Ok(())
}

/// The path of `node`, rebuilt from the parent column and the names under
/// `root`; `None` if a name is not valid UTF-8 or an index is out of range.
fn node_path(root: &Path, merged: &Merged, node: u32) -> Option<PathBuf> {
    let mut chain = Vec::new();
    let mut at = node;
    while at != 0 {
        chain.push(at);
        if chain.len() > merged.parent.len() {
            return None;
        }
        at = *merged.parent.get(at as usize)?;
    }
    let mut path = root.to_path_buf();
    for &n in chain.iter().rev() {
        let i = n as usize;
        let start = *merged.name_off.get(i)? as usize;
        let end = *merged.name_off.get(i.checked_add(1)?)? as usize;
        path.push(std::str::from_utf8(merged.names.get(start..end)?).ok()?);
    }
    Some(path)
}

pub(crate) struct Merged {
    pub(crate) parent: Vec<u32>,
    pub(crate) name_off: Vec<u32>,
    pub(crate) names: Vec<u8>,
    pub(super) kind: Vec<u8>,
    pub(super) flags: Vec<u8>,
    pub(super) size: Vec<f64>,
    pub(super) alloc: Vec<f64>,
    pub(super) mtime: Vec<f64>,
    pub(super) atime: Vec<f64>,
    pub(super) hardlinks: Vec<HardlinkRef>,
    pub(super) refusals: Vec<DirRefusal>,
    /// Hard-link families found by file id (listings with no link count),
    /// with their exact key and members ascending (see `refresh_families`).
    id_families: Vec<IdFamily>,
}

fn out_of_range(id: u32, total: usize) -> WalkError {
    WalkError::Internal(format!("node {id} is outside the {total} nodes discovered"))
}

/// Copies `src[j]` into `dst[i]`, or says which node was inconsistent.
fn place<T: Copy>(dst: &mut [T], i: usize, src: &[T], j: usize, id: u32) -> Result<(), WalkError> {
    let total = dst.len();
    let value = *src.get(j).ok_or_else(|| out_of_range(id, total))?;
    *dst.get_mut(i).ok_or_else(|| out_of_range(id, total))? = value;
    Ok(())
}

/// Marks slot `i` as node `id`'s, or says the id was seen before: two nodes
/// with one id would write the same columns, the second over the first.
fn claim(placed: &mut [bool], i: usize, id: u32) -> Result<(), WalkError> {
    let total = placed.len();
    let slot = placed.get_mut(i).ok_or_else(|| out_of_range(id, total))?;
    if *slot {
        return Err(WalkError::Internal(format!("node {id} was numbered twice")));
    }
    *slot = true;
    Ok(())
}

/// Merges every part's columns into id order and lays the names out in one arena.
pub(crate) fn merge(parts: &[Part], total: usize) -> Result<Merged, WalkError> {
    let mut placed = vec![false; total];
    let mut parent = vec![0_u32; total];
    let mut kind = vec![0_u8; total];
    let mut flags = vec![0_u8; total];
    let mut size = vec![0_f64; total];
    let mut alloc = vec![0_f64; total];
    let mut mtime = vec![f64::NAN; total];
    let mut atime = vec![f64::NAN; total];
    let mut name_len = vec![0_u32; total];
    for part in parts {
        for (j, &id) in part.ids.iter().enumerate() {
            let i = id as usize;
            claim(&mut placed, i, id)?;
            place(&mut parent, i, &part.parent, j, id)?;
            place(&mut kind, i, &part.kind, j, id)?;
            place(&mut flags, i, &part.flags, j, id)?;
            place(&mut size, i, &part.size, j, id)?;
            place(&mut alloc, i, &part.alloc, j, id)?;
            place(&mut mtime, i, &part.mtime, j, id)?;
            place(&mut atime, i, &part.atime, j, id)?;
            place(&mut name_len, i, &part.name_len, j, id)?;
        }
    }

    let mut name_off = Vec::with_capacity(total.saturating_add(1));
    let mut running = 0_u32;
    name_off.push(running);
    for len in &name_len {
        running = running
            .checked_add(*len)
            .ok_or_else(|| WalkError::Internal("the names exceed 4 GiB".to_owned()))?;
        name_off.push(running);
    }
    let mut names = vec![0_u8; running as usize];
    // A directory's own times, read when it was listed, replace the copy its
    // parent's listing reported (see DirTimes).
    for part in parts {
        for &(id, times) in &part.time_patches {
            let i = id as usize;
            *mtime.get_mut(i).ok_or_else(|| out_of_range(id, total))? = times.mtime_ms;
            *atime.get_mut(i).ok_or_else(|| out_of_range(id, total))? = times.atime_ms;
        }
    }
    for part in parts {
        let mut src = 0_usize;
        for (j, &id) in part.ids.iter().enumerate() {
            let len = *part
                .name_len
                .get(j)
                .ok_or_else(|| out_of_range(id, total))? as usize;
            let src_end = src
                .checked_add(len)
                .ok_or_else(|| out_of_range(id, total))?;
            let bytes = part
                .names
                .get(src..src_end)
                .ok_or_else(|| out_of_range(id, total))?;
            let dst = *name_off
                .get(id as usize)
                .ok_or_else(|| out_of_range(id, total))? as usize;
            let dst_end = dst
                .checked_add(len)
                .ok_or_else(|| out_of_range(id, total))?;
            names
                .get_mut(dst..dst_end)
                .ok_or_else(|| out_of_range(id, total))?
                .copy_from_slice(bytes);
            src = src_end;
        }
    }

    let mut keys: Vec<LinkKey> = parts
        .iter()
        .flat_map(|p| p.link_keys.iter().copied())
        .collect();
    let (hardlinks, id_families) = hardlink_families(&mut keys);
    drop(keys);
    let mut refusals: Vec<DirRefusal> = parts
        .iter()
        .flat_map(|p| p.refusals.iter().copied())
        .collect();
    refusals.sort_by_key(|r| r.node);
    for refusal in &refusals {
        let slot = flags
            .get_mut(refusal.node as usize)
            .ok_or_else(|| out_of_range(refusal.node, total))?;
        *slot |= FLAG_REFUSED_DIR;
    }

    Ok(Merged {
        parent,
        name_off,
        names,
        kind,
        flags,
        size,
        alloc,
        mtime,
        atime,
        hardlinks,
        refusals,
        id_families,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::KIND_DIR;
    use crate::sink::ListingSink;

    /// A part holding one node per `(id, parent)`.
    fn part_with(nodes: &[(u32, u32)]) -> Part {
        let mut part = Part::default();
        for &(id, parent) in nodes {
            part.push(id, parent, b"n", &Meta::unknown(KIND_FILE));
        }
        part
    }

    #[test]
    fn merge_refuses_two_nodes_with_one_id() -> Result<(), String> {
        let root = part_with(&[(0, 0)]);
        let first = part_with(&[(1, 0)]);
        let again = part_with(&[(1, 0)]);
        match merge(&[root, first, again], 2) {
            Err(WalkError::Internal(text)) if text.contains("numbered twice") => Ok(()),
            Err(other) => Err(format!("expected the duplicate to be named, got {other:?}")),
            Ok(merged) => Err(format!(
                "merged {} nodes although an id was numbered twice",
                merged.parent.len()
            )),
        }
    }

    #[test]
    fn merge_places_distinct_ids() -> Result<(), String> {
        let root = part_with(&[(0, 0)]);
        let first = part_with(&[(1, 0)]);
        let second = part_with(&[(2, 1)]);
        let merged = merge(&[root, first, second], 3).map_err(|e| e.to_string())?;
        assert_eq!(merged.parent, vec![0, 0, 1]);
        Ok(())
    }

    /// One block's rows named `names`, and their names back to back.
    fn block_rows(names: &[&str], kind: u8) -> (Vec<crate::Entry>, Vec<u8>) {
        let mut stored = Vec::new();
        let mut rows = Vec::new();
        for name in names {
            let start = stored.len();
            stored.extend_from_slice(name.as_bytes());
            rows.push(crate::Entry {
                name: start..stored.len(),
                meta: Meta::unknown(kind),
            });
        }
        (rows, stored)
    }

    /// Commits `names` to `sink` as folder `folder`'s block from id `first`.
    fn commit_block(sink: &CollectSink, folder: u32, first: u32, name_base: u64, names: &[&str]) {
        let (rows, stored) = block_rows(names, KIND_FILE);
        sink.commit(&crate::Block {
            folder,
            first,
            len: u32::try_from(rows.len()).unwrap_or(u32::MAX),
            name_base,
            offset: 0,
            rows: &rows,
            names: &stored,
            own_times: None,
        });
    }

    #[test]
    fn a_collected_walk_that_breaks_i2_is_refused_in_every_test_build() -> Result<(), String> {
        let well_formed = CollectSink::default();
        well_formed.root(b"r", &Meta::unknown(KIND_DIR));
        commit_block(&well_formed, 0, 1, 1, &["a", "b"]);
        commit_block(&well_formed, 1, 3, 3, &["x"]);
        let merged = collected(&well_formed, 4).map_err(|e| e.to_string())?;
        assert_eq!(merged.parent, vec![0, 0, 0, 1]);

        // The collector's own checks pass (names start where the last ended,
        // every id once), but the root's children are 1, 2 and then 4.
        let split = CollectSink::default();
        split.root(b"r", &Meta::unknown(KIND_DIR));
        commit_block(&split, 0, 1, 1, &["a", "b"]);
        commit_block(&split, 1, 3, 3, &["x"]);
        commit_block(&split, 0, 4, 4, &["c"]);
        match collected(&split, 5) {
            Err(WalkError::Internal(text)) if text.contains("I2 broken: folder 0") => Ok(()),
            other => Err(format!(
                "expected I2 named, got {:?}",
                other.map(|m| m.parent)
            )),
        }
    }
}

//! The store's ids: the numbering `PackedScanStore.finalize()` gives the nodes the Node
//! ingest adds (`ingestColumns` in `src/services/scan/nativeEngine.ts`).
//!
//! The ingest adds the root's children, then each folder's children in the order the
//! folders were added — breadth-first — and `finalize()` renumbers breadth-first by
//! insertion order, so a node's final id is the position at which the ingest added it.
//! Each folder's children are the walk's in column order, sorted by their name bytes
//! (`strcmp`, as libuv sorts a `readdir` listing; a stable sort, so names equal byte for
//! byte keep column order) on every platform but Windows, where the listing's own order
//! stands.

use crate::StoreError;

/// Where every node goes in the store.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Order {
    /// The walk's index of the node at each store id; the root is 0 in both.
    pub walk_index: Vec<u32>,
    /// Each store id's parent's store id; −1 for the root.
    pub parent: Vec<i32>,
    /// Each store id's first child's id; for a node without children, the id the next
    /// child would have had (`finalize()`'s running count).
    pub child_start: Vec<u32>,
    /// How many children each store id has.
    pub child_cnt: Vec<u32>,
}

/// Orders a walk's nodes as the store holds them. `parent[i]` is the walk's parent index
/// of node `i` (the root's is 0 and ignored); node `i`'s name is
/// `names[name_off[i]..name_off[i + 1]]`. The walk promises `parent[i] < i`; a walk
/// that breaks the promise, or whose offsets do not fit its names, is refused.
// Kept out of line: inlined into `build` under fat LTO (Rust 1.98.1) it ran about 25% slower
// on a 5M-node synthetic walk (24 Sep 2026).
#[inline(never)]
pub fn breadth_first(
    parent: &[u32],
    name_off: &[u32],
    names: &[u8],
    sort_children: bool,
) -> Result<Order, StoreError> {
    let n = parent.len();
    if n == 0 {
        return Err(StoreError::Malformed("the walk has no root".into()));
    }
    if i32::try_from(n).is_err() {
        return Err(StoreError::TooManyRows { rows: n as u64 });
    }
    if name_off.len() != n + 1 {
        return Err(StoreError::Malformed(format!(
            "{} name offsets for {n} nodes",
            name_off.len()
        )));
    }
    let name_of = |i: u32| -> Result<&[u8], StoreError> {
        match (name_off.get(i as usize), name_off.get(i as usize + 1)) {
            (Some(&start), Some(&end)) if start <= end => {
                names.get(start as usize..end as usize).ok_or_else(|| {
                    StoreError::Malformed(format!("node {i}'s name is outside the names"))
                })
            }
            _ => Err(StoreError::Malformed(format!(
                "node {i}'s name offsets are out of order"
            ))),
        }
    };

    // Each folder's children in column order: a count per parent, a running sum, then a
    // scatter in index order. `start[p]..start[p + 1]` is parent p's range in `kids`.
    let mut start = vec![0u32; n + 1];
    for (i, &p) in parent.iter().enumerate().skip(1) {
        if p as usize >= i {
            return Err(StoreError::Malformed(format!(
                "node {i}'s parent {p} does not come before it"
            )));
        }
        if let Some(count) = start.get_mut(p as usize + 1) {
            *count += 1;
        }
    }
    let mut running = 0u32;
    for slot in &mut start {
        running += *slot;
        *slot = running;
    }
    let mut cursor = start.clone();
    let mut kids = vec![0u32; n - 1];
    for (i, &p) in (1u32..).zip(parent.iter().skip(1)) {
        let at = cursor.get_mut(p as usize).ok_or_else(|| {
            StoreError::Malformed(format!("node {i}'s parent {p} is out of range"))
        })?;
        let slot = kids
            .get_mut(*at as usize)
            .ok_or_else(|| StoreError::Malformed("more children than nodes".into()))?;
        *slot = i;
        *at += 1;
    }

    let mut walk_index = Vec::with_capacity(n);
    let mut parent_ids = Vec::with_capacity(n);
    let mut child_start = Vec::with_capacity(n);
    let mut child_cnt = Vec::with_capacity(n);
    walk_index.push(0u32);
    parent_ids.push(-1i32);
    let mut assigned = 1u32;
    let mut id = 0usize;
    while let Some(&node) = walk_index.get(id) {
        let from = start.get(node as usize).copied().unwrap_or(0) as usize;
        let to = start.get(node as usize + 1).copied().unwrap_or(0) as usize;
        let children = kids.get_mut(from..to).ok_or_else(|| {
            StoreError::Malformed(format!("node {node}'s children are out of range"))
        })?;
        if sort_children && children.len() > 1 {
            // Every name is checked first, so the comparison below never meets a bad one.
            for &child in children.iter() {
                name_of(child)?;
            }
            children.sort_by(|&a, &b| name_of(a).unwrap_or(&[]).cmp(name_of(b).unwrap_or(&[])));
        }
        child_start.push(assigned);
        let too_many = || StoreError::TooManyRows { rows: n as u64 };
        child_cnt.push(u32::try_from(children.len()).map_err(|_| too_many())?);
        let this = i32::try_from(id).map_err(|_| too_many())?;
        for &child in children.iter() {
            walk_index.push(child);
            parent_ids.push(this);
            assigned += 1;
        }
        id += 1;
    }
    Ok(Order {
        walk_index,
        parent: parent_ids,
        child_start,
        child_cnt,
    })
}

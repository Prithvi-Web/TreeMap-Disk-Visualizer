//! Two walks of one tree, compared column for column: M5's instrument.
//!
//! The listing walk numbers nodes in discovery order across its workers and
//! the MFT walk breadth first, so their node ids differ even when every fact
//! agrees. [`canonical`] lays an output out again breadth first with each
//! directory's children sorted by their name bytes and every column carried
//! along (floats as their bits, so an unknown NaN equals an unknown NaN and
//! nothing else), the side tables re-keyed to the new ids; [`differences`]
//! then names every path and column where two layouts disagree.
//! [`child_order`] keeps what the canonical layout throws away — each
//! directory's children in the order the engine emitted them — so the NTFS
//! order the two engines share can be asserted on its own.
//!
//! Portable, and tested in `tests/canon_check.rs` on hand-made outputs: an
//! instrument that agrees with itself would prove nothing.
#![allow(
    dead_code,
    reason = "each test binary uses a different subset of these helpers"
)]

use std::collections::{BTreeMap, VecDeque};

use tm_walk::{Refusal, WalkOutput};

/// The counters of `WalkStats` both engines must agree on (times, the fast
/// path, workers and climb steps are the engine's own).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Counts {
    /// `dirs_listed`.
    pub dirs_listed: u64,
    /// `entries`.
    pub entries: u64,
    /// `denied_entries`.
    pub denied: u64,
    /// `unreadable_entries`.
    pub unreadable: u64,
    /// `dataless`.
    pub dataless: u64,
}

/// An output laid out breadth first, each directory's children in name-byte
/// order: node `i` of one canonical layout is node `i` of another exactly
/// when the two trees have the same paths.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Canonical {
    /// Each node's path under the root, `/`-joined (`""` for the root).
    pub paths: Vec<String>,
    /// Each node's own name (the root's included).
    pub names: Vec<String>,
    /// Each node's parent, in canonical ids.
    pub parent: Vec<usize>,
    /// The kind column.
    pub kind: Vec<u8>,
    /// The flags column.
    pub flags: Vec<u8>,
    /// The size column, as bits.
    pub size: Vec<u64>,
    /// The allocation column, as bits.
    pub alloc: Vec<u64>,
    /// The modification-time column, as bits.
    pub mtime: Vec<u64>,
    /// The access-time column, as bits.
    pub atime: Vec<u64>,
    /// `(node, family)` per hard-link ref, sorted, the family named by its
    /// smallest canonical member: two engines number the same families in
    /// their own orders, so the numbers themselves are not compared.
    pub hardlinks: Vec<(usize, usize)>,
    /// `(node, why)` per refused directory, sorted.
    pub refusals: Vec<(usize, u8)>,
    /// The counters.
    pub counts: Counts,
}

fn column<T: Copy>(values: &[T], i: usize, what: &str) -> Result<T, String> {
    values
        .get(i)
        .copied()
        .ok_or_else(|| format!("the {what} column has no row {i}"))
}

fn name_of(out: &WalkOutput, i: usize) -> Result<String, String> {
    out.name(i)
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .ok_or_else(|| format!("node {i} has no name"))
}

/// `out` laid out canonically, or why it is not a well-formed output (a
/// column of the wrong length, a parent that does not precede its child).
pub fn canonical(out: &WalkOutput) -> Result<Canonical, String> {
    let n = out.len();
    let lengths = [
        out.name_off.len().saturating_sub(1),
        out.kind.len(),
        out.flags.len(),
        out.size.len(),
        out.alloc_bytes.len(),
        out.mtime_ms.len(),
        out.atime_ms.len(),
    ];
    if n == 0 || lengths.iter().any(|len| *len != n) {
        return Err(format!(
            "{n} parents but columns of {lengths:?} rows: not a walk's output"
        ));
    }
    let mut kids: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut names = Vec::with_capacity(n);
    for i in 0..n {
        names.push(name_of(out, i)?);
        if i == 0 {
            continue;
        }
        let parent = column(&out.parent, i, "parent")? as usize;
        if parent >= i {
            return Err(format!("parent[{i}] = {parent} does not precede it"));
        }
        kids.get_mut(parent)
            .ok_or_else(|| format!("no parent {parent}"))?
            .push(i);
    }
    // Breadth first from the root, each directory's children by name bytes
    // (a directory never holds one name twice, so this is a total order).
    let mut order = vec![0_usize];
    let mut canonical_id = vec![0_usize; n];
    let mut queue = VecDeque::from([0_usize]);
    while let Some(node) = queue.pop_front() {
        let mut children = kids.get(node).cloned().unwrap_or_default();
        children.sort_by(|a, b| names.get(*a).cmp(&names.get(*b)).then(a.cmp(b)));
        for child in children {
            if let Some(slot) = canonical_id.get_mut(child) {
                *slot = order.len();
            }
            order.push(child);
            queue.push_back(child);
        }
    }
    let mut c = Canonical {
        paths: Vec::with_capacity(n),
        names: Vec::with_capacity(n),
        parent: Vec::with_capacity(n),
        kind: Vec::with_capacity(n),
        flags: Vec::with_capacity(n),
        size: Vec::with_capacity(n),
        alloc: Vec::with_capacity(n),
        mtime: Vec::with_capacity(n),
        atime: Vec::with_capacity(n),
        hardlinks: Vec::new(),
        refusals: Vec::new(),
        counts: Counts {
            dirs_listed: out.stats.dirs_listed,
            entries: out.stats.entries,
            denied: out.stats.denied_entries,
            unreadable: out.stats.unreadable_entries,
            dataless: out.stats.dataless,
        },
    };
    for &old in &order {
        let name = names.get(old).cloned().unwrap_or_default();
        let parent_old = if old == 0 {
            0
        } else {
            column(&out.parent, old, "parent")? as usize
        };
        let parent = column(&canonical_id, parent_old, "id")?;
        let path = if old == 0 {
            String::new()
        } else {
            match c.paths.get(parent).map(String::as_str) {
                Some("") => name.clone(),
                Some(p) => format!("{p}/{name}"),
                None => return Err(format!("node {old}'s parent is not laid out yet")),
            }
        };
        c.paths.push(path);
        c.names.push(name);
        c.parent.push(parent);
        c.kind.push(column(&out.kind, old, "kind")?);
        c.flags.push(column(&out.flags, old, "flags")?);
        c.size.push(column(&out.size, old, "size")?.to_bits());
        c.alloc
            .push(column(&out.alloc_bytes, old, "alloc")?.to_bits());
        c.mtime.push(column(&out.mtime_ms, old, "mtime")?.to_bits());
        c.atime.push(column(&out.atime_ms, old, "atime")?.to_bits());
    }
    let mut first_of: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
    for h in &out.hardlinks {
        let node = column(&canonical_id, h.node as usize, "hard-link node")?;
        let first = first_of.entry(h.family).or_insert(node);
        *first = (*first).min(node);
    }
    for h in &out.hardlinks {
        let node = column(&canonical_id, h.node as usize, "hard-link node")?;
        let family = first_of.get(&h.family).copied().unwrap_or(node);
        c.hardlinks.push((node, family));
    }
    c.hardlinks.sort_unstable();
    for r in &out.refusals {
        let node = column(&canonical_id, r.node as usize, "refusal node")?;
        c.refusals.push((node, refusal_code(r.why)));
    }
    c.refusals.sort_unstable();
    Ok(c)
}

fn refusal_code(why: Refusal) -> u8 {
    why.code()
}

/// A float column's value in words: the number and its bits.
fn float(bits: u64) -> String {
    format!("{} ({bits:#018x})", f64::from_bits(bits))
}

/// Every path and column where `mft` and `listing` disagree, at most
/// `limit` of them (plus a line saying how many more): empty when they are
/// equal column for column.
pub fn differences(mft: &Canonical, listing: &Canonical, limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    if mft.paths != listing.paths {
        let only = |a: &Canonical, b: &Canonical| -> Vec<String> {
            a.paths
                .iter()
                .filter(|p| !b.paths.contains(p))
                .cloned()
                .collect()
        };
        for p in only(mft, listing) {
            out.push(format!("{p:?}: only in the MFT walk"));
        }
        for p in only(listing, mft) {
            out.push(format!("{p:?}: only in the listing walk"));
        }
        if out.is_empty() {
            out.push("the same paths, in another canonical order".to_owned());
        }
        return truncate(out, limit);
    }
    for (i, path) in mft.paths.iter().enumerate() {
        let mut row = |what: &str, a: String, b: String| {
            if a != b {
                out.push(format!(
                    "{path:?}: {what} is {a} in the MFT walk, {b} in the listing"
                ));
            }
        };
        let get = |v: &[u64]| v.get(i).copied().unwrap_or_default();
        row(
            "the name",
            format!("{:?}", mft.names.get(i)),
            format!("{:?}", listing.names.get(i)),
        );
        row(
            "the parent",
            format!("{:?}", mft.parent.get(i)),
            format!("{:?}", listing.parent.get(i)),
        );
        row(
            "the kind",
            format!("{:?}", mft.kind.get(i)),
            format!("{:?}", listing.kind.get(i)),
        );
        row(
            "the flags",
            format!("{:?}", mft.flags.get(i)),
            format!("{:?}", listing.flags.get(i)),
        );
        row("the size", float(get(&mft.size)), float(get(&listing.size)));
        row(
            "the allocation",
            float(get(&mft.alloc)),
            float(get(&listing.alloc)),
        );
        row(
            "the mtime",
            float(get(&mft.mtime)),
            float(get(&listing.mtime)),
        );
        row(
            "the atime",
            float(get(&mft.atime)),
            float(get(&listing.atime)),
        );
    }
    let path_of = |c: &Canonical, node: usize| c.paths.get(node).cloned().unwrap_or_default();
    let links = |c: &Canonical| -> Vec<String> {
        c.hardlinks
            .iter()
            .map(|(node, family)| format!("{:?} with {:?}", path_of(c, *node), path_of(c, *family)))
            .collect()
    };
    if mft.hardlinks != listing.hardlinks {
        out.push(format!(
            "the hard links are {:?} in the MFT walk, {:?} in the listing",
            links(mft),
            links(listing)
        ));
    }
    let refusals = |c: &Canonical| -> Vec<String> {
        c.refusals
            .iter()
            .map(|(node, why)| format!("{:?} refused ({why})", path_of(c, *node)))
            .collect()
    };
    if mft.refusals != listing.refusals {
        out.push(format!(
            "the refusals are {:?} in the MFT walk, {:?} in the listing",
            refusals(mft),
            refusals(listing)
        ));
    }
    if mft.counts != listing.counts {
        out.push(format!(
            "the counters are {:?} in the MFT walk, {:?} in the listing",
            mft.counts, listing.counts
        ));
    }
    truncate(out, limit)
}

fn truncate(mut lines: Vec<String>, limit: usize) -> Vec<String> {
    if lines.len() > limit {
        let more = lines.len() - limit;
        lines.truncate(limit);
        lines.push(format!("... and {more} more"));
    }
    lines
}

/// Each directory's children, by the directory's path, in the order the
/// engine emitted them (node order): the listing's is the order the
/// directory's index returned; the MFT walk's is its `$UpCase` collation.
pub fn child_order(out: &WalkOutput) -> Result<BTreeMap<String, Vec<String>>, String> {
    let mut paths: Vec<String> = Vec::with_capacity(out.len());
    let mut order: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for i in 0..out.len() {
        let name = name_of(out, i)?;
        if i == 0 {
            paths.push(String::new());
            continue;
        }
        let parent = column(&out.parent, i, "parent")? as usize;
        let dir = paths
            .get(parent)
            .cloned()
            .ok_or_else(|| format!("parent[{i}] = {parent} does not precede it"))?;
        paths.push(if dir.is_empty() {
            name.clone()
        } else {
            format!("{dir}/{name}")
        });
        order.entry(dir).or_default().push(name);
    }
    Ok(order)
}

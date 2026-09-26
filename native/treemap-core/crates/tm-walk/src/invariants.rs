//! The four promises block numbering makes (design §S.2), checked in one pass
//! over a walk's columns. `PackedScanStore.adoptColumns` trusts its producer,
//! so every test build of a block-numbered walk runs this on what it made, and
//! a failure names the invariant a store breaks:
//!
//! * **I1** — the root is id 0 (a walk writes its parent as 0).
//! * **I2** — each folder's children hold one consecutive range of ids, in the
//!   store's child order: by stored name where the listing was sorted.
//! * **I3** — every parent's id is below its child's.
//! * **I4** — the names are laid out in id order: `name_off` starts at 0, never
//!   falls, and ends at the names' length.

use std::fmt;

/// Which promise a set of columns broke.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Invariant {
    /// I1: the root is id 0.
    RootFirst,
    /// I2: each folder's children hold one consecutive range, in child order.
    ChildBlocks,
    /// I3: `parent[i] < i`.
    ParentsFirst,
    /// I4: names in id order.
    NamesInOrder,
}

impl Invariant {
    /// The design's name for it: `I1` to `I4`.
    pub fn code(self) -> &'static str {
        match self {
            Self::RootFirst => "I1",
            Self::ChildBlocks => "I2",
            Self::ParentsFirst => "I3",
            Self::NamesInOrder => "I4",
        }
    }
}

/// The first broken promise, and where.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Broken {
    /// Which one.
    pub invariant: Invariant,
    /// Where, in words.
    pub detail: String,
}

impl fmt::Display for Broken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} broken: {}", self.invariant.code(), self.detail)
    }
}

fn broken(invariant: Invariant, detail: String) -> Broken {
    Broken { invariant, detail }
}

/// Checks I1–I4 over a walk's columns (`parent[0]` is 0; node `i`'s name is
/// `names[name_off[i]..name_off[i + 1]]`). With `stored_order`, each folder's
/// children must also come in the order of their names' bytes (never falling:
/// two names stored alike may sit side by side), as they do where the lister
/// sorted by name; without it, any order within a range is the listing's own.
pub fn check_walk_columns(
    parent: &[u32],
    name_off: &[u32],
    names: &[u8],
    stored_order: bool,
) -> Result<(), Broken> {
    let n = parent.len();
    if n == 0 || parent.first() != Some(&0) {
        return Err(broken(
            Invariant::RootFirst,
            format!(
                "node 0's parent is {:?}, not the root's own 0",
                parent.first()
            ),
        ));
    }
    check_names(name_off, names, n)?;
    let name = |i: usize| -> &[u8] {
        match (name_off.get(i), name_off.get(i + 1)) {
            (Some(&a), Some(&b)) => names.get(a as usize..b as usize).unwrap_or(&[]),
            _ => &[],
        }
    };
    // The last child seen of each node; u32::MAX for none yet.
    let mut last_child = vec![u32::MAX; n];
    for (i, &p) in parent.iter().enumerate().skip(1) {
        let p_at = p as usize;
        if p_at >= i {
            return Err(broken(
                Invariant::ParentsFirst,
                format!("node {i}'s parent {p} does not come before it"),
            ));
        }
        let this = u32::try_from(i).unwrap_or(u32::MAX);
        let Some(last) = last_child.get_mut(p_at) else {
            return Err(broken(
                Invariant::ParentsFirst,
                format!("node {i}'s parent {p} is out of range"),
            ));
        };
        if *last != u32::MAX {
            if last.checked_add(1) != Some(this) {
                return Err(broken(
                    Invariant::ChildBlocks,
                    format!("folder {p}'s children are not one range: {last} and then {i}"),
                ));
            }
            if stored_order && name(*last as usize) > name(i) {
                return Err(broken(
                    Invariant::ChildBlocks,
                    format!(
                        "folder {p}'s children are out of name order: {:?} (node {last}) before {:?} (node {i})",
                        String::from_utf8_lossy(name(*last as usize)),
                        String::from_utf8_lossy(name(i))
                    ),
                ));
            }
        }
        *last = this;
    }
    Ok(())
}

/// I4 on its own: `n + 1` offsets from 0 that never fall and end at the names' length.
fn check_names(name_off: &[u32], names: &[u8], n: usize) -> Result<(), Broken> {
    if name_off.len() != n + 1 || name_off.first() != Some(&0) {
        return Err(broken(
            Invariant::NamesInOrder,
            format!(
                "{} name offsets for {n} nodes, starting at {:?}",
                name_off.len(),
                name_off.first()
            ),
        ));
    }
    if let Some(at) = name_off.windows(2).position(|w| w.first() > w.get(1)) {
        return Err(broken(
            Invariant::NamesInOrder,
            format!("node {at}'s name ends before it starts"),
        ));
    }
    if name_off.last().map(|&end| end as usize) != Some(names.len()) {
        return Err(broken(
            Invariant::NamesInOrder,
            format!(
                "the offsets end at {:?} but the names hold {} bytes",
                name_off.last(),
                names.len()
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Columns for `(parent, name)` rows, the root first.
    fn columns(rows: &[(u32, &str)]) -> (Vec<u32>, Vec<u32>, Vec<u8>) {
        let mut parent = Vec::new();
        let mut name_off = vec![0];
        let mut names = Vec::new();
        for &(p, name) in rows {
            parent.push(p);
            names.extend_from_slice(name.as_bytes());
            name_off.push(u32::try_from(names.len()).unwrap_or(u32::MAX));
        }
        (parent, name_off, names)
    }

    fn check(rows: &[(u32, &str)], sorted: bool) -> Result<(), Invariant> {
        let (parent, name_off, names) = columns(rows);
        check_walk_columns(&parent, &name_off, &names, sorted).map_err(|b| b.invariant)
    }

    #[test]
    fn a_block_numbered_tree_passes() {
        let rows = [(0, "r"), (0, "a"), (0, "b"), (1, "x"), (1, "y"), (2, "z")];
        assert_eq!(check(&rows, true), Ok(()));
    }

    #[test]
    fn each_broken_promise_is_named() {
        assert_eq!(check(&[(1, "r")], true), Err(Invariant::RootFirst));
        assert_eq!(check(&[], true), Err(Invariant::RootFirst));
        // Folder 1's children 3 and 5 with 4 (folder 2's) between them.
        let split = [(0, "r"), (0, "a"), (0, "b"), (1, "x"), (2, "z"), (1, "y")];
        assert_eq!(check(&split, true), Err(Invariant::ChildBlocks));
        let unsorted = [(0, "r"), (0, "b"), (0, "a")];
        assert_eq!(check(&unsorted, true), Err(Invariant::ChildBlocks));
        assert_eq!(
            check(&unsorted, false),
            Ok(()),
            "a listing's own order stands"
        );
        let alike = [(0, "r"), (0, "a"), (0, "a")];
        assert_eq!(
            check(&alike, true),
            Ok(()),
            "names stored alike sit side by side"
        );
        assert_eq!(
            check(&[(0, "r"), (2, "a"), (0, "b")], true),
            Err(Invariant::ParentsFirst)
        );
        let (parent, mut name_off, names) = columns(&[(0, "r"), (0, "ab")]);
        if let Some(last) = name_off.last_mut() {
            *last = 1;
        }
        assert_eq!(
            check_walk_columns(&parent, &name_off, &names, true).map_err(|b| b.invariant),
            Err(Invariant::NamesInOrder),
            "the offsets end short of the names"
        );
        // From 0 to the names' length, but falling on the way: node 2's name
        // would end before it starts.
        let (parent, _, names) = columns(&[(0, "r"), (0, "ab"), (0, "c")]);
        assert_eq!(
            check_walk_columns(&parent, &[0, 3, 1, 4], &names, false).map_err(|b| b.invariant),
            Err(Invariant::NamesInOrder),
            "the offsets fall"
        );
    }

    #[test]
    fn the_message_names_the_invariant() {
        let split = [(0, "r"), (0, "a"), (0, "b"), (1, "x"), (2, "z"), (1, "y")];
        let (parent, name_off, names) = columns(&split);
        let text = check_walk_columns(&parent, &name_off, &names, true)
            .err()
            .map(|b| b.to_string())
            .unwrap_or_default();
        assert!(text.starts_with("I2 broken: folder 1"), "{text}");
    }
}

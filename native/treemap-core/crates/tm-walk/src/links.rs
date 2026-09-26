//! Hard-link families, told apart by each file's exact identity (P3-7,
//! amended by the pre-landing review of 23 Sep 2026).
//!
//! A file id is an identity, not a quantity. It once crossed as a double,
//! and a double cannot hold one: NTFS keeps a record's sequence number in
//! bits 48..64 of its reference, so a record reused 32 times or more has an
//! id at or above 2^53, where doubles round neighbours together, and ReFS
//! ids can differ only above bit 64. Two different files then made one
//! family, the ingest counted the second one's bytes as the first one's,
//! and on Windows the family refresh gave both the first one's size. Here
//! the key is the id itself, and what leaves the walk is a family number.

use crate::platform::Meta;
use crate::{HardlinkRef, KIND_FILE};

/// The link key of the file `meta` describes, numbered `node`, when its name
/// may share the file with another name: its listing reported a link count
/// above one, or none at all (Windows) while its attributes were read. An id
/// of 0 is no id (a FAT32 or exFAT volume gives none, and no listing reports 0
/// for a file): keyed, every such file would be one family (RISKS R55).
pub fn link_key(meta: &Meta, node: u32) -> Option<LinkKey> {
    let counted = meta.nlink > 1;
    (meta.kind == KIND_FILE && meta.ino != 0 && (counted || (meta.nlink == 0 && !meta.withheld)))
        .then(|| LinkKey {
            dev: meta.dev.to_bits(),
            ino: meta.ino,
            node,
            counted,
        })
}

/// One name the walk may have to join to others: its file's device (the
/// bits of the listing's double, exact for every device id a platform
/// reports), its exact id, its node, and whether its listing reported a link
/// count above one (`counted`) or reported none — a Windows listing, where
/// only a second name with the same id inside the scan makes a family.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct LinkKey {
    /// `dev`'s bits.
    pub dev: u64,
    /// The inode or file id, whole.
    pub ino: u128,
    /// The node's index in the columns.
    pub node: u32,
    /// True when the listing reported a link count above one.
    pub counted: bool,
}

/// A family found by id alone (no member's listing reported a link count),
/// whose members may each hold a stale copy of the file's facts; the walk
/// reads the file once for all of them.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct IdFamily {
    /// `dev`'s bits, as in [`LinkKey`].
    pub dev: u64,
    /// The file id, whole.
    pub ino: u128,
    /// The members' nodes, ascending.
    pub members: Vec<u32>,
}

/// Groups names into hard-link families by exact identity. A name whose
/// listing reported a link count above one belongs to its file's family even
/// alone — its other names may be outside the scan, and the ingest keys it
/// but never counts it a duplicate, as the legacy walker's `nlink > 1` key
/// does. A name whose listing reported none is in a family only when its id
/// is seen more than once: a lone id keeps what its listing said (DESIGN §16
/// item 9). Returns one ref per member, sorted by node, each carrying its
/// family's number, and the families that include a name found by id alone
/// (for the walk's refresh). `keys` is sorted in place.
#[must_use]
pub fn hardlink_families(keys: &mut [LinkKey]) -> (Vec<HardlinkRef>, Vec<IdFamily>) {
    keys.sort_unstable();
    let mut refs = Vec::new();
    let mut by_id = Vec::new();
    let mut family = 0_u32;
    for run in keys.chunk_by(|a, b| a.dev == b.dev && a.ino == b.ino) {
        let counted = run.iter().any(|k| k.counted);
        if !counted && run.len() < 2 {
            continue;
        }
        refs.extend(run.iter().map(|k| HardlinkRef {
            node: k.node,
            family,
        }));
        if run.len() > 1
            && run.iter().any(|k| !k.counted)
            && let Some(first) = run.first()
        {
            by_id.push(IdFamily {
                dev: first.dev,
                ino: first.ino,
                members: run.iter().map(|k| k.node).collect(),
            });
        }
        family = family.saturating_add(1);
    }
    refs.sort_unstable_by_key(|h| h.node);
    (refs, by_id)
}

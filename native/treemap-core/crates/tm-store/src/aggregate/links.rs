//! Hard links (Phase 4 T12d; design §S.6.3): the link log, and each family's first name.
//!
//! Every keyed name — a file whose listing reported a link count above one, or none at all
//! (Windows), as `tm_walk::link_key` decides — appends one record. At the seal the log is
//! sorted by (family, depth, position): in a family of two or more names, the first name in
//! breadth-first order keeps the bytes (P4-2a, the store's rule), and every other name is a
//! 0-byte file. The log stays resident here; its disk runs past 32 MiB are T13's.

use std::collections::HashMap;

use super::answers::Extension;
use super::position::PositionPath;

/// A hard-link family: its file's device bits and id.
pub(super) type Family = (u64, u128);

/// One keyed name.
pub(super) struct LinkRecord {
    pub family: Family,
    pub depth: u32,
    pub position: PositionPath,
    /// Its bytes as its listing said them.
    pub bytes: u64,
    pub extension: Extension,
}

/// Every keyed name the walk has named.
#[derive(Default)]
pub(super) struct LinkLog {
    records: Vec<LinkRecord>,
}

/// The log, settled.
pub(super) struct Settled<'a> {
    /// Each family of two or more names: its first name's place.
    pub winners: HashMap<Family, &'a PositionPath>,
    /// Every other name of such a family: 0 bytes in the store.
    pub losers: Vec<&'a LinkRecord>,
}

impl LinkLog {
    pub(super) fn push(&mut self, record: LinkRecord) {
        self.records.push(record);
    }

    pub(super) fn clear(&mut self) {
        self.records.clear();
    }

    /// Each family's first name in breadth-first order, and its later names.
    pub(super) fn settle(&self) -> Settled<'_> {
        let mut order: Vec<&LinkRecord> = self.records.iter().collect();
        order.sort_by(|a, b| {
            a.family
                .cmp(&b.family)
                .then_with(|| a.depth.cmp(&b.depth))
                .then_with(|| a.position.pre_order(&b.position))
        });
        let mut settled = Settled {
            winners: HashMap::new(),
            losers: Vec::new(),
        };
        for run in order.chunk_by(|a, b| a.family == b.family) {
            if let [first, later @ ..] = run
                && !later.is_empty()
            {
                settled.winners.insert(first.family, &first.position);
                settled.losers.extend(later.iter().copied());
            }
        }
        settled
    }
}

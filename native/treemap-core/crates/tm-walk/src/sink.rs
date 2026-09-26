//! What a block-numbered walk hands on as it commits (design §S.1.3): the
//! [`ListingSink`] trait, the [`Block`] each commit carries, and the crate's
//! own `CollectSink`, Phase 3's per-worker columns and merge re-expressed as a
//! sink — the oracle every later sink is held to, and what
//! [`crate::WalkHandle::take`] returns under [`crate::Numbering::Blocks`].
//!
//! The walk makes every call but `abort` under its commit lock, so a sink sees
//! one call at a time: the root's row first, then the blocks in id order, and
//! a refused folder whenever it is refused — not in id order (see
//! [`ListingSink::refused`]). A walk that ends with an
//! output calls nothing more; one that ends without one — cancelled, faulted,
//! or its root refused — calls `abort` once on every sink, after every other
//! call, and a sink panic is the walk's fault.

use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::WalkError;
use crate::links::link_key;
use crate::output::{DirRefusal, Refusal};
use crate::platform::{DirTimes, Entry, Meta};
use crate::walk::{Merged, Part, merge};

/// One listing's children, or one chunk of them, as a commit hands them on.
///
/// The listing of folder `folder` holds the ids `first..first + len`, one per
/// child, in the store's child order (the stored names' order where the
/// lister sorted by name, the listing's own order on Windows). A listing of
/// more than [`crate::BIG_LISTING`] entries arrives as several chunks of the
/// one block: the same `folder`, `first`, `len` and `name_base`, and `offset`
/// rising by each chunk's rows until they total `len`. Every other listing
/// arrives whole, `offset` 0.
#[derive(Clone, Copy, Debug)]
pub struct Block<'a> {
    /// The listed folder's id.
    pub folder: u32,
    /// The id of the listing's first child.
    pub first: u32,
    /// How many children the listing holds, in all its chunks.
    pub len: u32,
    /// Where the listing's first name starts in the names laid out in id
    /// order, the root's own name first (the walk's name arena).
    pub name_base: u64,
    /// This chunk's first row, counted from `first`.
    pub offset: u32,
    /// This chunk's rows in id order: row `i` is id `first + offset + i`. Each
    /// row's `name` ranges over `names`.
    pub rows: &'a [Entry],
    /// The rows' names as they are stored (valid UTF-8: the OS bytes where they
    /// were UTF-8, U+FFFD for each maximal invalid subpart), back to back.
    pub names: &'a [u8],
    /// The listed folder's own times, where its listing read them from the
    /// folder itself (Windows), replacing what its parent's listing said.
    pub own_times: Option<DirTimes>,
}

impl Block<'_> {
    /// Row `i`'s stored name.
    pub fn name(&self, row: &Entry) -> &[u8] {
        self.names.get(row.name.clone()).unwrap_or(&[])
    }
}

/// What consumes a block-numbered walk's commits. See the module docs for
/// when each call comes.
pub trait ListingSink: Send + Sync {
    /// The root's own row, id 0: its name as stored and what the walk read of it.
    fn root(&self, name: &[u8], meta: &Meta);
    /// One listing, or one chunk of a big one.
    fn commit(&self, block: &Block<'_>);
    /// Folder `folder` was not listed: its listing was refused, or its name
    /// holds a separator ([`Refusal::Unreadable`]). Its row came in its
    /// parent's block, before this call.
    ///
    /// Refusals arrive whenever they are found, not in id order: a folder
    /// whose listing fails is refused after blocks with larger ids may have
    /// come. A sink that needs them in order sorts them, as `CollectSink`'s
    /// merge does.
    fn refused(&self, folder: u32, why: Refusal);
    /// The walk ended without an output: drop what was built. The last call.
    fn abort(&self);
}

/// What [`CollectSink`] has gathered so far.
#[derive(Default)]
struct Collected {
    /// Every row, in id order: the root, then the blocks as they came.
    part: Part,
    /// Where the next block's names must start: the names gathered so far.
    names_next: u64,
    /// The first promise a commit broke, kept for [`CollectSink::merge`].
    broken: Option<String>,
    aborted: bool,
}

/// Phase 3's columns and merge as a sink: every row goes into one [`Part`]
/// keyed by its id, and [`CollectSink::merge`] lays them out in id order as
/// the discovery walk's merge always did.
#[derive(Default)]
pub(crate) struct CollectSink {
    state: Mutex<Collected>,
}

impl CollectSink {
    fn lock(&self) -> MutexGuard<'_, Collected> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The columns of `total` nodes in id order, or the first promise a
    /// commit broke: a block whose names did not start where the rows before
    /// it ended (I4), or ids that were not each numbered once.
    pub(crate) fn merge(&self, total: usize) -> Result<Merged, WalkError> {
        let state = self.lock();
        if let Some(why) = &state.broken {
            return Err(WalkError::Internal(why.clone()));
        }
        if state.aborted {
            return Err(WalkError::Internal(
                "the collected rows were dropped by an abort".to_owned(),
            ));
        }
        merge(std::slice::from_ref(&state.part), total)
    }
}

impl ListingSink for CollectSink {
    fn root(&self, name: &[u8], meta: &Meta) {
        let mut state = self.lock();
        state.part.push(0, 0, name, meta);
        state.names_next = u64::try_from(name.len()).unwrap_or(u64::MAX);
    }

    fn commit(&self, block: &Block<'_>) {
        let mut state = self.lock();
        if state.broken.is_some() {
            return;
        }
        if block.offset == 0 {
            // Blocks come in id order, so a block's names start where the
            // names of every smaller id end: the reservation I4 rests on.
            if block.name_base != state.names_next {
                state.broken = Some(format!(
                    "I4: the block of folder {} reserved its names at byte {} but the names before it end at byte {}",
                    block.folder, block.name_base, state.names_next
                ));
                return;
            }
            if let Some(times) = block.own_times {
                state.part.time_patches.push((block.folder, times));
            }
        }
        let Some(start) = block.first.checked_add(block.offset) else {
            state.broken = Some(format!("the block of folder {} overflows", block.folder));
            return;
        };
        for (id, row) in (start..).zip(block.rows) {
            let name = block.name(row);
            state.part.push(id, block.folder, name, &row.meta);
            if let Some(key) = link_key(&row.meta, id) {
                state.part.link_keys.push(key);
            }
            state.names_next = state
                .names_next
                .saturating_add(u64::try_from(name.len()).unwrap_or(u64::MAX));
        }
    }

    fn refused(&self, folder: u32, why: Refusal) {
        self.lock()
            .part
            .refusals
            .push(DirRefusal { node: folder, why });
    }

    fn abort(&self) {
        let mut state = self.lock();
        state.part = Part::default();
        state.aborted = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{KIND_DIR, KIND_FILE};

    /// Commits two files, `a` and `b`, as the root's block, claiming its names
    /// start at `name_base`.
    fn two_files_at(sink: &CollectSink, name_base: u64) {
        let names = b"ab".to_vec();
        let rows = [
            Entry {
                name: 0..1,
                meta: Meta::unknown(KIND_FILE),
            },
            Entry {
                name: 1..2,
                meta: Meta::unknown(KIND_FILE),
            },
        ];
        sink.commit(&Block {
            folder: 0,
            first: 1,
            len: 2,
            name_base,
            offset: 0,
            rows: &rows,
            names: &names,
            own_times: None,
        });
    }

    #[test]
    fn names_reserved_where_the_names_before_them_end_are_collected() -> Result<(), String> {
        let sink = CollectSink::default();
        sink.root(b"root", &Meta::unknown(KIND_DIR));
        two_files_at(&sink, 4);
        let merged = sink.merge(3).map_err(|e| e.to_string())?;
        assert_eq!(merged.parent, vec![0, 0, 0]);
        assert_eq!(merged.names, b"rootab");
        assert_eq!(merged.name_off, vec![0, 4, 5, 6]);
        Ok(())
    }

    #[test]
    fn a_block_whose_names_do_not_start_where_the_last_ended_breaks_i4() -> Result<(), String> {
        let sink = CollectSink::default();
        sink.root(b"root", &Meta::unknown(KIND_DIR));
        two_files_at(&sink, 3);
        match sink.merge(3) {
            Err(WalkError::Internal(text)) if text.starts_with("I4:") => Ok(()),
            other => Err(format!(
                "expected I4 named, got {:?}",
                other.map(|m| m.parent)
            )),
        }
    }
}

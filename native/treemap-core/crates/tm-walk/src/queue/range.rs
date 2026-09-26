//! A listing's subfolders to walk, packed as one [`Range`] (T6b; R88), and
//! the [`RangeBuilder`] that gathers them. Moved out of `queue.rs`, which
//! keeps the queue itself, with no change but the visibility the queue needs.

use std::path::Path;

use super::DirJob;
use crate::KIND_DIR;
use crate::platform::Listing;
use crate::walk::{child_path, name_is_a_path};

/// The bytes one queued range takes besides its parent's path and its
/// folders' ids, name ends and names: the range itself, as the queue holds it.
pub const RANGE_BYTES: usize = size_of::<Range>();

/// The most name bytes one range packs: its name ends are `u32`. A listing
/// whose queued names hold more (16 million names of 255 bytes) is queued as
/// several ranges, pushed together, which schedules exactly as one would.
const MAX_RANGE_NAME_BYTES: usize = u32::MAX as usize;

/// The most folders one range holds: its cursors are `u32`. Ids are unique
/// and below `u32::MAX`, so no listing reaches it.
const MAX_RANGE_FOLDERS: usize = u32::MAX as usize;

/// One listing's subfolders still to walk, or the root alone.
#[derive(Debug)]
pub(crate) struct Range {
    /// The listed folder's path; every subfolder's path is it joined with the
    /// subfolder's OS name. For a lone range, the one folder's own path.
    parent: Box<Path>,
    /// One folder whose path is `parent` itself (the root's job).
    lone: bool,
    /// Under block numbering, the id of the listed folder's first child: a
    /// subfolder's place in its parent's listing is its id minus this.
    #[expect(
        dead_code,
        reason = "kept for T7: a subfolder's position in its parent's listing is id - block_first"
    )]
    block_first: Option<u32>,
    /// Each subfolder's id, in the order they were queued.
    ids: Box<[u32]>,
    /// Where each subfolder's name ends in `names`; the first starts at 0.
    ends: Box<[u32]>,
    /// The subfolders' OS names, back to back.
    names: Box<[u8]>,
    /// The first folder not yet taken.
    front: u32,
    /// One past the last folder not yet taken.
    back: u32,
}

impl Range {
    /// The root's job as a range of one.
    pub(super) fn lone(job: DirJob) -> Self {
        Self {
            parent: job.path.into_boxed_path(),
            lone: true,
            block_first: None,
            ids: Box::new([job.id]),
            ends: Box::new([0]),
            names: Box::new([]),
            front: 0,
            back: 1,
        }
    }

    /// The folders not yet taken.
    pub(super) fn remaining(&self) -> usize {
        usize::try_from(self.back.saturating_sub(self.front)).unwrap_or(usize::MAX)
    }

    /// The bytes it holds: itself, its parent's path, and its ids, ends and
    /// names, from their allocations' lengths.
    pub(super) fn bytes(&self) -> usize {
        RANGE_BYTES
            + self.parent.as_os_str().len()
            + size_of_val::<[u32]>(&self.ids)
            + size_of_val::<[u32]>(&self.ends)
            + self.names.len()
    }

    /// Folder `i`'s job: its id, and its path joined as the walk always joined it.
    fn job(&self, i: u32) -> Option<DirJob> {
        let at = usize::try_from(i).ok()?;
        let id = *self.ids.get(at)?;
        if self.lone {
            return Some(DirJob {
                id,
                path: self.parent.to_path_buf(),
            });
        }
        let start = match at.checked_sub(1) {
            None => 0,
            Some(before) => usize::try_from(*self.ends.get(before)?).ok()?,
        };
        let end = usize::try_from(*self.ends.get(at)?).ok()?;
        let name = self.names.get(start..end)?;
        Some(DirJob {
            id,
            path: child_path(&self.parent, name),
        })
    }

    /// The first folder not yet taken (first in, first out).
    pub(super) fn take_first(&mut self) -> Option<DirJob> {
        if self.front >= self.back {
            return None;
        }
        let job = self.job(self.front);
        self.front += 1;
        job
    }

    /// The last folder not yet taken (last in, first out).
    pub(super) fn take_last(&mut self) -> Option<DirJob> {
        if self.front >= self.back {
            return None;
        }
        self.back -= 1;
        self.job(self.back)
    }
}

/// How many of `listing`'s entries are folders the walk may queue (a name
/// that is a path never is), and the bytes their names take: what a
/// [`RangeBuilder`] for it allocates up front.
pub(crate) fn queueable(listing: &Listing) -> (usize, usize) {
    listing
        .entries
        .iter()
        .filter(|entry| entry.meta.kind == KIND_DIR && !name_is_a_path(listing.name(entry)))
        .fold((0, 0), |(folders, bytes), entry| {
            (folders + 1, bytes + entry.name.len())
        })
}

/// Gathers one listing's subfolders, in the order the walk queues them, into
/// the range (in practice one) the queue takes them in.
pub(crate) struct RangeBuilder<'p> {
    parent: &'p Path,
    block_first: Option<u32>,
    ids: Vec<u32>,
    ends: Vec<u32>,
    names: Vec<u8>,
    /// Ranges already sealed, in order.
    sealed: Vec<Range>,
    /// See [`MAX_RANGE_NAME_BYTES`]; lowered by tests.
    max_name_bytes: usize,
}

impl<'p> RangeBuilder<'p> {
    /// A builder for the subfolders of the folder at `parent`, with room for
    /// `folders` of them and `name_bytes` of names (see [`queueable`]).
    pub(crate) fn new(
        parent: &'p Path,
        block_first: Option<u32>,
        folders: usize,
        name_bytes: usize,
    ) -> Self {
        Self::with_limit(
            parent,
            block_first,
            folders,
            name_bytes,
            MAX_RANGE_NAME_BYTES,
        )
    }

    pub(super) fn with_limit(
        parent: &'p Path,
        block_first: Option<u32>,
        folders: usize,
        name_bytes: usize,
        max_name_bytes: usize,
    ) -> Self {
        let folders = folders.min(MAX_RANGE_FOLDERS);
        Self {
            parent,
            block_first,
            ids: Vec::with_capacity(folders),
            ends: Vec::with_capacity(folders),
            names: Vec::with_capacity(name_bytes.min(max_name_bytes)),
            sealed: Vec::new(),
            max_name_bytes,
        }
    }

    /// Queues folder `id`, named `name` in its parent's listing.
    pub(crate) fn push(&mut self, id: u32, name: &[u8]) {
        if name.len() > self.max_name_bytes {
            // A name no range can pack goes as a range of its own, its path
            // joined now, in its place in the order.
            self.seal();
            self.sealed.push(Range::lone(DirJob {
                id,
                path: child_path(self.parent, name),
            }));
            return;
        }
        if self.ids.len() == MAX_RANGE_FOLDERS
            || self.names.len() + name.len() > self.max_name_bytes
        {
            self.seal();
        }
        self.names.extend_from_slice(name);
        // At most `max_name_bytes`, itself at most `u32::MAX`.
        self.ends
            .push(u32::try_from(self.names.len()).unwrap_or(u32::MAX));
        self.ids.push(id);
    }

    /// Closes the range being filled, if it holds a folder.
    fn seal(&mut self) {
        let ids = std::mem::take(&mut self.ids);
        let ends = std::mem::take(&mut self.ends);
        let names = std::mem::take(&mut self.names);
        if let Some(range) = self.packed(ids, ends, names) {
            self.sealed.push(range);
        }
    }

    fn packed(&self, ids: Vec<u32>, ends: Vec<u32>, names: Vec<u8>) -> Option<Range> {
        let back = u32::try_from(ids.len()).ok().filter(|&n| n > 0)?;
        Some(Range {
            parent: Box::from(self.parent),
            lone: false,
            block_first: self.block_first,
            ids: ids.into_boxed_slice(),
            ends: ends.into_boxed_slice(),
            names: names.into_boxed_slice(),
            front: 0,
            back,
        })
    }

    /// The ranges, in order: none when no subfolder was queued, and in
    /// practice one (so `sealed` stays empty and allocates nothing).
    pub(crate) fn finish(mut self) -> impl Iterator<Item = Range> {
        let ids = std::mem::take(&mut self.ids);
        let ends = std::mem::take(&mut self.ends);
        let names = std::mem::take(&mut self.names);
        let last = self.packed(ids, ends, names);
        self.sealed.into_iter().chain(last)
    }
}

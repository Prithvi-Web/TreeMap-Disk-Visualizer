//! The shared directory queue: a `Mutex<VecDeque<Range>>` with a `Condvar`
//! and in-flight accounting, so a worker knows the walk is finished when there
//! is no folder queued and none being processed. A worker whose index is above
//! the count it may run parks here without holding a job.
//!
//! **Ranges (T6b; R88).** A listing's subfolders to walk are queued together
//! as one [`Range`]: the listed folder's path once, and per subfolder its id,
//! where its name ends and its OS name (the bytes the walk joins onto the
//! path), packed. A worker is handed a [`DirJob`] built from a range when it
//! takes that folder, so only the folders in flight hold a path of their own.
//!
//! **Scheduling is T6's, folder for folder** (P4-13). The hybrid rule compares
//! `lifo_from` with the folders waiting (the ranges' remaining folders,
//! summed): below it a worker takes the front range's first remaining folder
//! (first in, first out), from it on the back range's last remaining folder
//! (last in, first out). The ranges in queue order, each's remaining folders in
//! order, are exactly T6's queue of folders, so every walk lists its folders as
//! T6 did, and first-in first-out over ranges is first-in first-out over their
//! folders. A drained range is dropped.
//!
//! **What is bounded, and what is not.** A waiting folder costs its name and 8
//! bytes (its id and its name's end) instead of a job with a path of its own
//! (about 200 B each, measured under T6); a range costs [`RANGE_BYTES`] and
//! its parent's path besides, and keeps all its names until its last folder is
//! taken. The folders waiting are not bounded by `lifo_from`, exactly as under
//! T6: a folder with more subfolders than that queues them all. With one
//! worker the ranges queued are at most `lifo_from` plus the depth below the
//! root, less one; with several, a schedule where workers stall one after
//! another on single folders can queue more ranges than any multiple of the
//! workers and the depth (an exhaustive model of small trees, T6b, reached
//! `lifo_from − 1 + C(D + W − 1, W)` for depth `D` and `W` workers), so the
//! queue's bytes are bounded by the folders waiting and their listings'
//! names, not by the workers alone.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use crate::KIND_DIR;
use crate::platform::Listing;
use crate::walk::{child_path, name_is_a_path};

/// A directory to list: its node id and its path.
#[derive(Debug)]
pub struct DirJob {
    /// The directory's index in the columns.
    pub id: u32,
    /// The directory's path, as the OS gave its components.
    pub path: PathBuf,
}

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
    fn lone(job: DirJob) -> Self {
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
    fn remaining(&self) -> usize {
        usize::try_from(self.back.saturating_sub(self.front)).unwrap_or(usize::MAX)
    }

    /// The bytes it holds: itself, its parent's path, and its ids, ends and
    /// names, from their allocations' lengths.
    fn bytes(&self) -> usize {
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
    fn take_first(&mut self) -> Option<DirJob> {
        if self.front >= self.back {
            return None;
        }
        let job = self.job(self.front);
        self.front += 1;
        job
    }

    /// The last folder not yet taken (last in, first out).
    fn take_last(&mut self) -> Option<DirJob> {
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

    fn with_limit(
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

#[derive(Debug)]
struct State {
    ranges: VecDeque<Range>,
    /// Folders waiting: the ranges' remaining folders, summed.
    waiting: usize,
    in_flight: u32,
    peak_in_flight: u32,
    closed: bool,
    /// Folders are handed out newest first once this many wait.
    lifo_from: usize,
    /// The most folders waiting at once.
    peak_len: usize,
    /// The most ranges queued at once.
    peak_ranges: usize,
    /// The bytes the queued ranges hold now.
    bytes: usize,
    /// The most bytes the queued ranges held at once.
    peak_bytes: usize,
}

impl State {
    /// Appends `range` and counts it; an empty one is dropped.
    fn append(&mut self, range: Range) {
        let remaining = range.remaining();
        if remaining == 0 {
            return;
        }
        self.waiting = self.waiting.saturating_add(remaining);
        self.bytes = self.bytes.saturating_add(range.bytes());
        self.ranges.push_back(range);
    }

    /// Records the peaks after a push.
    fn note_peaks(&mut self) {
        self.peak_len = self.peak_len.max(self.waiting);
        self.peak_ranges = self.peak_ranges.max(self.ranges.len());
        self.peak_bytes = self.peak_bytes.max(self.bytes);
    }

    /// The front range's first remaining folder, dropping the range once it
    /// is drained.
    fn take_front(&mut self) -> Option<DirJob> {
        let range = self.ranges.front_mut()?;
        let job = range.take_first();
        if range.remaining() == 0 {
            self.drop_drained(VecDeque::pop_front);
        }
        self.taken(job)
    }

    /// The back range's last remaining folder, dropping the range once it is
    /// drained.
    fn take_back(&mut self) -> Option<DirJob> {
        let range = self.ranges.back_mut()?;
        let job = range.take_last();
        if range.remaining() == 0 {
            self.drop_drained(VecDeque::pop_back);
        }
        self.taken(job)
    }

    fn drop_drained(&mut self, pop: fn(&mut VecDeque<Range>) -> Option<Range>) {
        if let Some(drained) = pop(&mut self.ranges) {
            self.bytes = self.bytes.saturating_sub(drained.bytes());
        }
    }

    fn taken(&mut self, job: Option<DirJob>) -> Option<DirJob> {
        if job.is_some() {
            self.waiting = self.waiting.saturating_sub(1);
        }
        job
    }
}

/// How long a parked or idle worker waits before re-reading its permission to run.
const WAIT_SLICE: Duration = Duration::from_millis(50);

/// The queue. See the module docs.
#[derive(Debug)]
pub struct Queue {
    state: Mutex<State>,
    changed: Condvar,
}

impl Default for Queue {
    fn default() -> Self {
        Self::hybrid(usize::MAX)
    }
}

impl Queue {
    /// An empty, open queue, first-in first-out however long it grows: the
    /// queue of [`crate::Numbering::Discovery`], as it always was.
    pub fn new() -> Self {
        Self::default()
    }

    /// An empty, open queue that hands out its oldest folder while fewer than
    /// `lifo_from` folders wait and its newest once `lifo_from` or more do
    /// (P4-13): breadth-first while the backlog is small, depth-first once it
    /// is not, which finishes subtrees instead of widening the frontier.
    pub fn hybrid(lifo_from: usize) -> Self {
        Self {
            state: Mutex::new(State {
                ranges: VecDeque::new(),
                waiting: 0,
                in_flight: 0,
                peak_in_flight: 0,
                closed: false,
                lifo_from,
                peak_len: 0,
                peak_ranges: 0,
                bytes: 0,
                peak_bytes: 0,
            }),
            changed: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Queues one job: the root's.
    pub fn push(&self, job: DirJob) {
        let mut state = self.lock();
        state.append(Range::lone(job));
        state.note_peaks();
        drop(state);
        self.changed.notify_one();
    }

    /// Queues one listing's ranges (see [`RangeBuilder::finish`]) under one
    /// lock, so its subfolders wait together as T6 queued them.
    pub(crate) fn push_ranges(&self, ranges: impl IntoIterator<Item = Range>) {
        let mut ranges = ranges.into_iter().peekable();
        if ranges.peek().is_none() {
            return;
        }
        let mut state = self.lock();
        for range in ranges {
            state.append(range);
        }
        state.note_peaks();
        drop(state);
        self.changed.notify_all();
    }

    /// Queues every job in `jobs` (drained) under one lock, each as a range of
    /// its own: T6's per-folder push, kept for the queue's own tests.
    #[cfg(test)]
    pub fn push_all(&self, jobs: &mut Vec<DirJob>) {
        self.push_ranges(jobs.drain(..).map(Range::lone));
    }

    /// Waits for a job this worker may take. `may_run` is re-read on every
    /// wake-up, so a worker above the current count parks without a job and
    /// without blocking anyone. Returns `None` once the walk is finished or the
    /// queue was closed.
    pub fn next_job(&self, may_run: &dyn Fn() -> bool) -> Option<DirJob> {
        let mut state = self.lock();
        loop {
            if state.closed {
                return None;
            }
            if may_run() {
                let job = if state.waiting >= state.lifo_from {
                    state.take_back()
                } else {
                    state.take_front()
                };
                if let Some(job) = job {
                    state.in_flight = state.in_flight.saturating_add(1);
                    state.peak_in_flight = state.peak_in_flight.max(state.in_flight);
                    return Some(job);
                }
            }
            let (next, _) = self
                .changed
                .wait_timeout(state, WAIT_SLICE)
                .unwrap_or_else(PoisonError::into_inner);
            state = next;
        }
    }

    /// A worker finished a job (its children already pushed). When nothing is
    /// queued and nothing is in flight, the walk is finished and the queue closes.
    pub fn finish_job(&self) {
        let mut state = self.lock();
        state.in_flight = state.in_flight.saturating_sub(1);
        if state.in_flight == 0 && state.ranges.is_empty() {
            state.closed = true;
        }
        drop(state);
        self.changed.notify_all();
    }

    /// Closes the queue: every waiting worker returns `None`. Idempotent.
    pub fn close(&self) {
        self.lock().closed = true;
        self.changed.notify_all();
    }

    /// Wakes every waiter so it re-reads whether it may run.
    pub fn notify(&self) {
        self.changed.notify_all();
    }

    /// Blocks up to `timeout` for the queue to close; true when it is closed.
    pub fn wait_closed(&self, timeout: Duration) -> bool {
        let state = self.lock();
        if state.closed {
            return true;
        }
        let (state, _) = self
            .changed
            .wait_timeout(state, timeout)
            .unwrap_or_else(PoisonError::into_inner);
        state.closed
    }

    /// The most jobs that were in flight at once: the workers' true peak.
    pub fn peak_in_flight(&self) -> u32 {
        self.lock().peak_in_flight
    }

    /// The most folders waiting at once.
    pub fn peak_len(&self) -> usize {
        self.lock().peak_len
    }

    /// The most ranges queued at once.
    pub fn peak_ranges(&self) -> usize {
        self.lock().peak_ranges
    }

    /// The most bytes the queued ranges held at once.
    pub fn peak_bytes(&self) -> usize {
        self.lock().peak_bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: u32) -> DirJob {
        DirJob {
            id,
            path: PathBuf::from(format!("/q/{id}")),
        }
    }

    /// Takes one job and finishes it at once, as a worker that lists nothing would.
    fn take(queue: &Queue) -> Option<u32> {
        let taken = queue.next_job(&|| true).map(|j| j.id);
        queue.finish_job();
        taken
    }

    #[test]
    fn below_its_threshold_the_queue_is_first_in_first_out_and_at_it_last_in_first_out() {
        let queue = Queue::hybrid(3);
        queue.push_all(&mut vec![job(1), job(2)]);
        assert_eq!(take(&queue), Some(1), "two queued: the oldest");
        queue.push_all(&mut vec![job(3), job(4)]);
        assert_eq!(take(&queue), Some(4), "three queued: the newest");
        assert_eq!(take(&queue), Some(2), "two queued again: the oldest");
        assert_eq!(take(&queue), Some(3));
        assert_eq!(queue.peak_len(), 3, "the most it held at once");
    }

    #[test]
    fn the_default_queue_is_first_in_first_out_however_long_it_grows() {
        let queue = Queue::new();
        queue.push_all(&mut (1..=100).map(job).collect());
        let order: Vec<u32> = (0..100).filter_map(|_| take(&queue)).collect();
        assert_eq!(order, (1..=100).collect::<Vec<u32>>());
        assert_eq!(queue.peak_len(), 100);
    }

    #[test]
    fn a_single_push_counts_toward_the_peak() {
        let queue = Queue::hybrid(usize::MAX);
        queue.push(job(1));
        queue.push(job(2));
        assert_eq!(queue.peak_len(), 2);
    }

    #[test]
    fn names_past_a_ranges_room_are_queued_as_several_ranges_in_order() {
        // A room of 7 name bytes: `aaa` and `bbb` fill one range, `ccc` opens
        // the next, and a name longer than the room goes as a range of its own.
        let parent = Path::new("/p");
        let names: [&[u8]; 4] = [b"aaa", b"bbb", b"ccc", b"ddddddddd"];
        let mut builder = RangeBuilder::with_limit(parent, None, 4, 18, 7);
        for (id, name) in (10..).zip(names) {
            builder.push(id, name);
        }
        let queue = Queue::new();
        queue.push_ranges(builder.finish());
        assert_eq!(queue.peak_len(), 4);
        assert_eq!(queue.peak_ranges(), 3);
        // Each range: itself, the parent, 8 bytes and a name per folder; the
        // lone one holds its whole path and no name.
        let lone = "/p/ddddddddd".len() + 8;
        assert_eq!(
            queue.peak_bytes(),
            3 * RANGE_BYTES + (2 + 16 + 6) + (2 + 8 + 3) + lone
        );
        let taken: Vec<(u32, PathBuf)> = (0..4)
            .filter_map(|_| {
                let job = queue.next_job(&|| true)?;
                queue.finish_job();
                Some((job.id, job.path))
            })
            .collect();
        let expected: Vec<(u32, PathBuf)> = ["aaa", "bbb", "ccc", "ddddddddd"]
            .iter()
            .zip(10..)
            .map(|(name, id)| (id, parent.join(name)))
            .collect();
        assert_eq!(taken, expected);
    }
}

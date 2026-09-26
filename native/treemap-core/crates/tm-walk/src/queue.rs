//! The directory queue: deques of folders to list under one `Mutex`, with a
//! `Condvar` and in-flight accounting, so a worker knows the walk is finished
//! when there is no folder queued and none being processed. A worker whose
//! index is above the count it may run parks here without holding a job.
//!
//! **Ranges (T6b; R88).** A listing's subfolders to walk are queued together
//! as one [`Range`]: the listed folder's path once, and per subfolder its id,
//! where its name ends and its OS name (the bytes the walk joins onto the
//! path), packed. A worker is handed a [`DirJob`] built from a range when it
//! takes that folder, so only the folders in flight hold a path of their own.
//! A drained range is dropped.
//!
//! **One deque per worker (T6c).** Under block numbering each worker owns a
//! deque of ranges. It pushes its listing's range onto the back of its own
//! deque, and takes from its own by the hybrid rule (P4-13), which compares
//! `lifo_from` with the folders waiting in *every* deque: below it, its own
//! front range's first remaining folder (first in, first out); from it on,
//! its own back range's last remaining folder (last in, first out). A worker
//! whose deque is empty steals the first remaining folder of the front — the
//! oldest — range of another worker's deque: the first, round robin from its
//! own index, that holds one, whether its owner runs or is parked. The root's
//! job starts in worker 0's deque. With one worker this is T6's queue, folder
//! for folder: the ranges in queue order, each's remaining folders in order,
//! are T6's queue of folders. Under discovery numbering every worker shares
//! one deque, first in, first out, as it always did.
//!
//! **What is bounded, and what is not.** A waiting folder costs its name and 8
//! bytes (its id and its name's end) instead of a job with a path of its own
//! (about 200 B each, measured under T6); a range costs [`RANGE_BYTES`] and
//! its parent's path besides, and keeps all its names until its last folder is
//! taken. The folders waiting are not bounded by `lifo_from`, exactly as under
//! T6: a folder with more subfolders than that queues them all. The *ranges*
//! queued with one deque per worker are at most `lifo_from + W·(D − 1)` for
//! `W` workers and folders at most `D ≥ 1` levels below the root, whatever the
//! schedule. At the last take made while fewer than `lifo_from` folders
//! waited, at most `lifo_from − 1` ranges were queued (each holds a folder).
//! Every range pushed since went onto its pusher's own back: the children of
//! the folder the worker held at that take, of a folder it took since from
//! its own back range (one level deeper than that range), or of a folder it
//! stole (onto its deque, then empty). So the ranges pushed since and still
//! queued form, in each deque, one descent, each a level deeper than the one
//! before it: at most `D` in one deque — the one holding the root's children,
//! the only range one level down — and `D − 1` in every other. (A listing
//! whose queued names pass 4 GiB is queued as several ranges, which count as
//! one here.) With one worker that is `lifo_from + D − 1`, and it is reached.
//! With one shared deque, as under T6b, no such bound held: a model of every
//! schedule of small trees reached `lifo_from − 1 + C(D + W − 1, W)`.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

mod range;

pub use range::RANGE_BYTES;
pub(crate) use range::{Range, RangeBuilder, queueable};

/// A directory to list: its node id and its path.
#[derive(Debug)]
pub struct DirJob {
    /// The directory's index in the columns.
    pub id: u32,
    /// The directory's path, as the OS gave its components.
    pub path: PathBuf,
}

#[derive(Debug)]
struct State {
    /// The ranges queued: one deque per worker under block numbering, one
    /// shared by every worker under discovery numbering (see the module docs).
    deques: Box<[VecDeque<Range>]>,
    /// Ranges queued, in every deque.
    ranges: usize,
    /// Folders waiting: the ranges' remaining folders, summed over every deque.
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
    /// The deque `worker` pushes onto and takes from first: its own, or the
    /// one every worker shares.
    fn own(&self, worker: usize) -> usize {
        worker % self.deques.len().max(1)
    }

    /// Appends `range` to the back of deque `at` and counts it; an empty one
    /// is dropped.
    fn append(&mut self, at: usize, range: Range) {
        let remaining = range.remaining();
        if remaining == 0 {
            return;
        }
        let Some(deque) = self.deques.get_mut(at) else {
            return;
        };
        self.waiting = self.waiting.saturating_add(remaining);
        self.bytes = self.bytes.saturating_add(range.bytes());
        self.ranges = self.ranges.saturating_add(1);
        deque.push_back(range);
    }

    /// Records the peaks after a push.
    fn note_peaks(&mut self) {
        self.peak_len = self.peak_len.max(self.waiting);
        self.peak_ranges = self.peak_ranges.max(self.ranges);
        self.peak_bytes = self.peak_bytes.max(self.bytes);
    }

    /// A folder for `worker` (T6c): from its own deque by the hybrid rule,
    /// which reads the folders waiting in every deque; when its own is empty,
    /// stolen from the next deque, round robin, that holds a range.
    fn take(&mut self, worker: usize) -> Option<DirJob> {
        let own = self.own(worker);
        if self.deques.get(own).is_some_and(|deque| !deque.is_empty()) {
            return if self.waiting >= self.lifo_from {
                self.take_back(own)
            } else {
                self.take_front(own)
            };
        }
        let victim = self.victim(own)?;
        self.take_front(victim)
    }

    /// The first deque after `own`, round robin, that holds a range.
    fn victim(&self, own: usize) -> Option<usize> {
        let n = self.deques.len();
        (1..n)
            .map(|k| (own + k) % n)
            .find(|&at| self.deques.get(at).is_some_and(|deque| !deque.is_empty()))
    }

    /// Deque `at`'s front range's first remaining folder, dropping the range
    /// once it is drained.
    fn take_front(&mut self, at: usize) -> Option<DirJob> {
        let range = self.deques.get_mut(at)?.front_mut()?;
        let job = range.take_first();
        if range.remaining() == 0 {
            self.drop_drained(at, VecDeque::pop_front);
        }
        self.taken(job)
    }

    /// Deque `at`'s back range's last remaining folder, dropping the range
    /// once it is drained.
    fn take_back(&mut self, at: usize) -> Option<DirJob> {
        let range = self.deques.get_mut(at)?.back_mut()?;
        let job = range.take_last();
        if range.remaining() == 0 {
            self.drop_drained(at, VecDeque::pop_back);
        }
        self.taken(job)
    }

    fn drop_drained(&mut self, at: usize, pop: fn(&mut VecDeque<Range>) -> Option<Range>) {
        if let Some(drained) = self.deques.get_mut(at).and_then(pop) {
            self.bytes = self.bytes.saturating_sub(drained.bytes());
            self.ranges = self.ranges.saturating_sub(1);
        }
    }

    fn taken(&mut self, job: Option<DirJob>) -> Option<DirJob> {
        if job.is_some() {
            self.waiting = self.waiting.saturating_sub(1);
        }
        job
    }

    /// `job`, handed to a worker: in flight until it is finished.
    fn handed(&mut self, job: DirJob) -> DirJob {
        self.in_flight = self.in_flight.saturating_add(1);
        self.peak_in_flight = self.peak_in_flight.max(self.in_flight);
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
        Self::with_deques(usize::MAX, 1)
    }
}

impl Queue {
    /// An empty, open queue, one deque every worker shares, first-in first-out
    /// however long it grows: the queue of [`crate::Numbering::Discovery`], as
    /// it always was.
    pub fn new() -> Self {
        Self::default()
    }

    /// An empty, open queue, one deque every worker shares, that hands out its
    /// oldest folder while fewer than `lifo_from` folders wait and its newest
    /// once `lifo_from` or more do: T6's queue, kept for the queue's own tests.
    #[cfg(test)]
    pub fn hybrid(lifo_from: usize) -> Self {
        Self::with_deques(lifo_from, 1)
    }

    /// An empty, open queue with a deque for each worker index below
    /// `workers`, handing out folders by the hybrid rule at `lifo_from`
    /// (P4-13; T6c): breadth-first while the backlog is small, depth-first
    /// once it is not, which finishes subtrees instead of widening the
    /// frontier; see the module docs.
    pub fn per_worker(lifo_from: usize, workers: usize) -> Self {
        Self::with_deques(lifo_from, workers)
    }

    fn with_deques(lifo_from: usize, deques: usize) -> Self {
        Self {
            state: Mutex::new(State {
                deques: (0..deques.max(1)).map(|_| VecDeque::new()).collect(),
                ranges: 0,
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

    /// Queues one job: the root's, in worker 0's deque.
    pub fn push(&self, job: DirJob) {
        let mut state = self.lock();
        state.append(0, Range::lone(job));
        state.note_peaks();
        drop(state);
        self.changed.notify_one();
    }

    /// Queues one listing's ranges (see [`RangeBuilder::finish`]) onto the
    /// back of `worker`'s deque under one lock, so its subfolders wait
    /// together as T6 queued them.
    pub(crate) fn push_ranges(&self, worker: usize, ranges: impl IntoIterator<Item = Range>) {
        let mut ranges = ranges.into_iter().peekable();
        if ranges.peek().is_none() {
            return;
        }
        let mut state = self.lock();
        let own = state.own(worker);
        for range in ranges {
            state.append(own, range);
        }
        state.note_peaks();
        drop(state);
        self.changed.notify_all();
    }

    /// Queues every job in `jobs` (drained) onto `worker`'s deque under one
    /// lock, each as a range of its own: T6's per-folder push, kept for the
    /// queue's own tests.
    #[cfg(test)]
    pub fn push_all(&self, worker: usize, jobs: &mut Vec<DirJob>) {
        self.push_ranges(worker, jobs.drain(..).map(Range::lone));
    }

    /// Waits for a job worker `worker` may take (see the module docs for
    /// which). `may_run` is re-read on every wake-up, so a worker above the
    /// current count parks without a job and without blocking anyone; its
    /// deque is stolen from meanwhile. Returns `None` once the walk is
    /// finished or the queue was closed.
    pub fn next_job(&self, worker: usize, may_run: &dyn Fn() -> bool) -> Option<DirJob> {
        let mut state = self.lock();
        loop {
            if state.closed {
                return None;
            }
            if may_run()
                && let Some(job) = state.take(worker)
            {
                return Some(state.handed(job));
            }
            let (next, _) = self
                .changed
                .wait_timeout(state, WAIT_SLICE)
                .unwrap_or_else(PoisonError::into_inner);
            state = next;
        }
    }

    /// One take by worker `worker`, without waiting: for the queue's own tests.
    #[cfg(test)]
    fn try_take(&self, worker: usize) -> Option<DirJob> {
        let mut state = self.lock();
        let job = state.take(worker)?;
        Some(state.handed(job))
    }

    /// A worker finished a job (its children already pushed). When nothing is
    /// queued and nothing is in flight, the walk is finished and the queue closes.
    pub fn finish_job(&self) {
        let mut state = self.lock();
        state.in_flight = state.in_flight.saturating_sub(1);
        if state.in_flight == 0 && state.ranges == 0 {
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
    use std::path::Path;

    use super::*;

    fn job(id: u32) -> DirJob {
        DirJob {
            id,
            path: PathBuf::from(format!("/q/{id}")),
        }
    }

    /// Takes one job and finishes it at once, as a worker that lists nothing would.
    fn take(queue: &Queue) -> Option<u32> {
        let taken = queue.next_job(0, &|| true).map(|j| j.id);
        queue.finish_job();
        taken
    }

    #[test]
    fn below_its_threshold_the_queue_is_first_in_first_out_and_at_it_last_in_first_out() {
        let queue = Queue::hybrid(3);
        queue.push_all(0, &mut vec![job(1), job(2)]);
        assert_eq!(take(&queue), Some(1), "two queued: the oldest");
        queue.push_all(0, &mut vec![job(3), job(4)]);
        assert_eq!(take(&queue), Some(4), "three queued: the newest");
        assert_eq!(take(&queue), Some(2), "two queued again: the oldest");
        assert_eq!(take(&queue), Some(3));
        assert_eq!(queue.peak_len(), 3, "the most it held at once");
    }

    #[test]
    fn the_default_queue_is_first_in_first_out_however_long_it_grows() {
        let queue = Queue::new();
        queue.push_all(0, &mut (1..=100).map(job).collect());
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
        queue.push_ranges(0, builder.finish());
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
                let job = queue.next_job(0, &|| true)?;
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

    // -----------------------------------------------------------------------
    // One deque per worker (T6c)
    // -----------------------------------------------------------------------

    /// One listing's range of the folders `ids`, each named after its id.
    fn range(ids: &[u32]) -> Vec<Range> {
        let parent = Path::new("/r");
        let mut builder = RangeBuilder::new(parent, None, ids.len(), 4 * ids.len());
        for &id in ids {
            builder.push(id, id.to_string().as_bytes());
        }
        builder.finish().collect()
    }

    /// One take by `worker`, finished at once; `None` when it finds nothing.
    fn take_as(queue: &Queue, worker: usize) -> Option<u32> {
        let taken = queue.try_take(worker).map(|j| j.id);
        if taken.is_some() {
            queue.finish_job();
        }
        taken
    }

    #[test]
    fn each_worker_pushes_onto_its_own_deque_and_takes_from_it_first() {
        let queue = Queue::per_worker(usize::MAX, 3);
        queue.push_ranges(1, range(&[10, 11]));
        queue.push_ranges(2, range(&[20, 21]));
        queue.push_ranges(1, range(&[12]));
        assert_eq!(
            take_as(&queue, 2),
            Some(20),
            "its own, not the oldest queued"
        );
        assert_eq!(take_as(&queue, 1), Some(10));
        assert_eq!(take_as(&queue, 1), Some(11));
        assert_eq!(take_as(&queue, 1), Some(12), "its own second range");
        assert_eq!(take_as(&queue, 2), Some(21));
        assert_eq!(take_as(&queue, 1), None, "nothing left anywhere");
    }

    #[test]
    fn a_worker_whose_deque_is_empty_steals_the_oldest_ranges_first_folder() {
        // Every folder waits last in, first out (lifo_from 1): the owner takes
        // its newest, a thief the oldest range's first.
        let queue = Queue::per_worker(1, 2);
        queue.push_ranges(1, range(&[1, 2]));
        queue.push_ranges(1, range(&[3, 4]));
        assert_eq!(
            take_as(&queue, 0),
            Some(1),
            "stolen: the oldest range's first"
        );
        assert_eq!(take_as(&queue, 1), Some(4), "its owner's: the newest");
        assert_eq!(take_as(&queue, 0), Some(2));
        assert_eq!(
            take_as(&queue, 0),
            Some(3),
            "the next range, once one drains"
        );
        assert_eq!(take_as(&queue, 1), None);
    }

    #[test]
    fn the_hybrid_rule_reads_the_folders_waiting_in_every_deque() {
        let queue = Queue::per_worker(4, 2);
        queue.push_ranges(0, range(&[1, 2]));
        queue.push_ranges(1, range(&[3, 4, 5]));
        // Worker 0's deque holds 2 of the 5 waiting, and 5 reach 4: newest first.
        assert_eq!(take_as(&queue, 0), Some(2));
        // 4 wait: still newest first, for worker 1 too.
        assert_eq!(take_as(&queue, 1), Some(5));
        // 3 wait: oldest first.
        assert_eq!(take_as(&queue, 1), Some(3));
        assert_eq!(take_as(&queue, 0), Some(1));
    }

    #[test]
    fn a_thief_looks_round_robin_from_its_own_index() {
        let queue = Queue::per_worker(usize::MAX, 4);
        queue.push_ranges(1, range(&[10]));
        queue.push_ranges(3, range(&[30]));
        queue.push_ranges(0, range(&[1]));
        assert_eq!(take_as(&queue, 2), Some(30), "after 2 comes 3");
        assert_eq!(take_as(&queue, 3), Some(1), "after 3 comes 0");
        assert_eq!(take_as(&queue, 0), Some(10), "then 1");
    }

    #[test]
    fn the_peaks_count_every_deque() {
        let queue = Queue::per_worker(usize::MAX, 2);
        queue.push_ranges(0, range(&[1]));
        queue.push_ranges(1, range(&[2, 3]));
        assert_eq!(queue.peak_len(), 3);
        assert_eq!(queue.peak_ranges(), 2);
        // Each range: itself, "/r", and per folder 8 bytes and its name.
        assert_eq!(
            queue.peak_bytes(),
            2 * RANGE_BYTES + (2 + 8 + 1) + (2 + 16 + 2)
        );
    }

    #[test]
    fn the_queue_closes_once_no_deque_holds_a_folder_and_none_is_in_flight() {
        let queue = Queue::per_worker(usize::MAX, 2);
        queue.push(job(0));
        let root = queue.try_take(1).map(|j| j.id);
        assert_eq!(root, Some(0), "the root, stolen from worker 0's deque");
        queue.push_ranges(1, range(&[1]));
        queue.finish_job();
        assert!(
            !queue.wait_closed(Duration::ZERO),
            "a folder still waits in worker 1's deque"
        );
        assert_eq!(take_as(&queue, 0), Some(1));
        assert!(queue.wait_closed(Duration::ZERO), "nothing waits or runs");
    }

    #[test]
    fn with_one_deque_every_worker_shares_it_first_in_first_out() {
        let queue = Queue::new();
        queue.push_ranges(5, range(&[1, 2]));
        queue.push_ranges(3, range(&[3]));
        assert_eq!(take_as(&queue, 0), Some(1));
        assert_eq!(take_as(&queue, 7), Some(2));
        assert_eq!(take_as(&queue, 5), Some(3));
    }
}

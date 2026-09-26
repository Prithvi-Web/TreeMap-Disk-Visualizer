//! The shared directory queue: a `Mutex<VecDeque<DirJob>>` with a `Condvar`
//! and in-flight accounting, so a worker knows the walk is finished when there
//! is no job queued and none being processed. A worker whose index is above
//! the count it may run parks here without holding a job.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

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
    jobs: VecDeque<DirJob>,
    in_flight: u32,
    peak_in_flight: u32,
    closed: bool,
    /// Jobs are handed out newest first once the queue holds this many.
    lifo_from: usize,
    /// The most jobs the queue held at once.
    peak_len: usize,
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

    /// An empty, open queue that hands out its oldest job while it holds
    /// fewer than `lifo_from` jobs and its newest once it holds `lifo_from` or
    /// more (P4-13): breadth-first while the backlog is small, depth-first once
    /// it is not, which finishes subtrees instead of widening the frontier.
    pub fn hybrid(lifo_from: usize) -> Self {
        Self {
            state: Mutex::new(State {
                jobs: VecDeque::new(),
                in_flight: 0,
                peak_in_flight: 0,
                closed: false,
                lifo_from,
                peak_len: 0,
            }),
            changed: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Queues one job.
    pub fn push(&self, job: DirJob) {
        let mut state = self.lock();
        state.jobs.push_back(job);
        state.peak_len = state.peak_len.max(state.jobs.len());
        drop(state);
        self.changed.notify_one();
    }

    /// Queues every job in `jobs` (drained) under one lock.
    pub fn push_all(&self, jobs: &mut Vec<DirJob>) {
        if jobs.is_empty() {
            return;
        }
        let mut state = self.lock();
        state.jobs.extend(jobs.drain(..));
        state.peak_len = state.peak_len.max(state.jobs.len());
        drop(state);
        self.changed.notify_all();
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
                let job = if state.jobs.len() >= state.lifo_from {
                    state.jobs.pop_back()
                } else {
                    state.jobs.pop_front()
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
        if state.in_flight == 0 && state.jobs.is_empty() {
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

    /// The most jobs the queue held at once.
    pub fn peak_len(&self) -> usize {
        self.lock().peak_len
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
}

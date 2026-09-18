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

#[derive(Debug, Default)]
struct State {
    jobs: VecDeque<DirJob>,
    in_flight: u32,
    peak_in_flight: u32,
    closed: bool,
}

/// How long a parked or idle worker waits before re-reading its permission to run.
const WAIT_SLICE: Duration = Duration::from_millis(50);

/// The queue. See the module docs.
#[derive(Debug, Default)]
pub struct Queue {
    state: Mutex<State>,
    changed: Condvar,
}

impl Queue {
    /// An empty, open queue.
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Queues one job.
    pub fn push(&self, job: DirJob) {
        self.lock().jobs.push_back(job);
        self.changed.notify_one();
    }

    /// Queues every job in `jobs` (drained) under one lock.
    pub fn push_all(&self, jobs: &mut Vec<DirJob>) {
        if jobs.is_empty() {
            return;
        }
        self.lock().jobs.extend(jobs.drain(..));
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
                if let Some(job) = state.jobs.pop_front() {
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
}

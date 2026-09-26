//! What the workers, the driver and the handle share: the [`Shared`] state,
//! the pacers that govern the workers, and the [`Counted`] guard a waiting
//! worker is counted by. Moved out of `walk.rs` unchanged (Phase 4, T6b).

use std::any::Any;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use tm_governor::{Governor, apply_to_current_thread, profile};

use super::{SAMPLE_INTERVAL, child_path, lock, panic_text, stored_root_name};
use crate::blocks::{BigListings, CommitLock, Resident};
use crate::climb::{START_WORKERS, start_for};
use crate::output::{Refusal, WalkOutput};
use crate::platform::{Lister, performance_cores};
use crate::queue::Queue;
use crate::sink::{CollectSink, ListingSink};
use crate::{FastPath, Numbering, WalkError, WalkOptions};

/// How long a paused worker waits before re-checking the flags.
const PAUSE_POLL: Duration = Duration::from_millis(50);
/// `last_sample_ms` before the first sample.
const NEVER: u64 = u64::MAX;
/// `root_refused` before any refusal.
const NO_REFUSAL: u8 = 0;

/// What the walk asks of a governor. Implemented for [`Governor`] by
/// [`GovernorPacer`]; a test scripts its own to count the calls.
pub trait Pacer: Send + Sync {
    /// Called once on each worker thread before it lists anything.
    fn on_worker_start(&self);
    /// Called after every directory a worker processes; returns early once
    /// `cancelled()` answers true, even while the pacer is paused.
    fn throttle(&self, cancelled: &dyn Fn() -> bool);
    /// Re-read between directories: the most workers that may run.
    fn worker_limit(&self) -> u32;
    /// Read once, when a walk the hill-climber drives starts: the count it
    /// starts at, before `worker_limit()` caps it.
    fn start_workers(&self) -> u32 {
        START_WORKERS
    }
}

/// The real thing: `tm_governor::Governor`.
#[derive(Debug, Clone)]
pub struct GovernorPacer {
    governor: Arc<Governor>,
}

impl GovernorPacer {
    /// Wraps `governor`.
    pub fn new(governor: Arc<Governor>) -> Self {
        Self { governor }
    }
}

impl Pacer for GovernorPacer {
    fn on_worker_start(&self) {
        // The governor applies the profile itself on the worker's first
        // `throttle()` and records what the OS accepted in its snapshot; this
        // earlier call puts the very first listing under the right QoS class.
        let snapshot = self.governor.snapshot();
        let cores = thread::available_parallelism()
            .map_or(1, |n| u32::try_from(n.get()).unwrap_or(u32::MAX));
        let current = profile(snapshot.effective, cores, snapshot.budget.cpu_percent);
        let _applied_early = apply_to_current_thread(&current);
    }

    fn throttle(&self, cancelled: &dyn Fn() -> bool) {
        self.governor.throttle_unless(cancelled);
    }

    fn worker_limit(&self) -> u32 {
        self.governor.worker_limit()
    }

    /// The preset in force decides; see [`start_for`].
    fn start_workers(&self) -> u32 {
        start_for(self.governor.snapshot().effective, performance_cores())
    }
}

/// One more in a count of waiting workers for as long as it lives: the count
/// is given back however its holder stops waiting — the wait ending, a
/// cancel's early return, or a panic unwinding through it.
pub(crate) struct Counted<'a>(&'a AtomicU32);

impl<'a> Counted<'a> {
    /// Counts one more in `count` until the guard drops.
    pub(crate) fn new(count: &'a AtomicU32) -> Self {
        count.fetch_add(1, Ordering::AcqRel);
        Self(count)
    }
}

impl Drop for Counted<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Everything the workers, the driver and the handle share.
pub(crate) struct Shared {
    pub(super) root: PathBuf,
    pub(crate) want_atime: bool,
    pub(crate) never_descend: HashSet<PathBuf>,
    pub(super) max_workers: usize,
    pub(super) buffer_bytes: usize,
    pub(super) pacer: Arc<dyn Pacer>,
    pub(crate) lister: Arc<dyn Lister>,
    pub(crate) queue: Queue,
    pub(crate) next_id: AtomicU32,
    pub(crate) entries: AtomicU64,
    pub(crate) dirs: AtomicU64,
    pub(crate) files: AtomicU64,
    pub(crate) bytes: AtomicU64,
    pub(crate) dirs_listed: AtomicU64,
    pub(crate) denied_entries: AtomicU64,
    pub(crate) unreadable_entries: AtomicU64,
    pub(crate) dataless: AtomicU64,
    pub(super) active_target: AtomicU32,
    pub(super) paused: AtomicBool,
    /// Shared with every worker's [`ListBuffer`], so a listing stops between batches.
    pub(super) cancelled: Arc<AtomicBool>,
    /// Shared with every worker's [`ListBuffer`]; see [`Progress::heartbeat`].
    pub(crate) heartbeat: Arc<AtomicU64>,
    pub(super) done: AtomicBool,
    pause_lock: Mutex<()>,
    pub(super) pause_changed: Condvar,
    pub(super) started: Instant,
    last_sample_ms: AtomicU64,
    pub(super) current_path: Mutex<Option<String>>,
    pub(crate) root_fast_path: AtomicU8,
    pub(crate) root_refused: AtomicU8,
    /// The first fault that ended the walk, as the sentence `take()` returns:
    /// a worker's panic, or the id ceiling. Set once; later faults are dropped.
    pub(super) fault: Mutex<Option<String>>,
    pub(super) result: Mutex<Option<Result<WalkOutput, WalkError>>>,
    pub(super) numbering: Numbering,
    /// See [`WalkOptions::id_ceiling`].
    pub(crate) id_ceiling: u32,
    /// Every sink a block-numbered walk commits to, its collector first;
    /// empty under discovery numbering.
    pub(crate) sinks: Vec<Arc<dyn ListingSink>>,
    /// The collector whose rows `take()` returns under block numbering.
    pub(super) collect: Option<Arc<CollectSink>>,
    /// The commit lock (block numbering).
    pub(crate) commit: CommitLock,
    /// The big-listing semaphore (block numbering).
    pub(crate) big: BigListings,
    /// The listing entries resident in the workers' buffers (block numbering).
    pub(crate) resident: Resident,
    /// Blocks reserved (block numbering): one per listing committed.
    pub(crate) blocks: AtomicU64,
    /// Workers parked by a pause right now.
    pub(super) parked: AtomicU32,
}

impl Shared {
    #[cfg(test)]
    pub(super) fn new(opts: WalkOptions, pacer: Arc<dyn Pacer>, lister: Arc<dyn Lister>) -> Self {
        Self::with_sinks(opts, pacer, lister, Vec::new())
    }

    /// Under block numbering the walk's own collector goes first among the
    /// sinks; under discovery numbering there are none.
    pub(super) fn with_sinks(
        opts: WalkOptions,
        pacer: Arc<dyn Pacer>,
        lister: Arc<dyn Lister>,
        extra: Vec<Arc<dyn ListingSink>>,
    ) -> Self {
        let (queue, collect, sinks) = match opts.numbering {
            Numbering::Discovery => (Queue::new(), None, Vec::new()),
            Numbering::Blocks => {
                let collect = Arc::new(CollectSink::default());
                let mut sinks: Vec<Arc<dyn ListingSink>> = vec![collect.clone()];
                sinks.extend(extra);
                (Queue::hybrid(opts.q_max), Some(collect), sinks)
            }
        };
        let root_name_bytes = u64::try_from(stored_root_name(&opts.root).len()).unwrap_or(0);
        Self {
            numbering: opts.numbering,
            id_ceiling: opts.id_ceiling,
            sinks,
            collect,
            commit: CommitLock::new(root_name_bytes),
            big: BigListings::default(),
            resident: Resident::default(),
            blocks: AtomicU64::new(0),
            parked: AtomicU32::new(0),
            root: opts.root,
            want_atime: opts.want_atime,
            never_descend: opts.never_descend.into_iter().collect(),
            max_workers: opts.max_workers,
            buffer_bytes: opts.buffer_bytes,
            pacer,
            lister,
            queue,
            next_id: AtomicU32::new(1),
            entries: AtomicU64::new(0),
            dirs: AtomicU64::new(0),
            files: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            dirs_listed: AtomicU64::new(0),
            denied_entries: AtomicU64::new(0),
            unreadable_entries: AtomicU64::new(0),
            dataless: AtomicU64::new(0),
            active_target: AtomicU32::new(1),
            paused: AtomicBool::new(false),
            cancelled: Arc::new(AtomicBool::new(false)),
            heartbeat: Arc::new(AtomicU64::new(0)),
            done: AtomicBool::new(false),
            pause_lock: Mutex::new(()),
            pause_changed: Condvar::new(),
            started: Instant::now(),
            last_sample_ms: AtomicU64::new(NEVER),
            current_path: Mutex::new(None),
            root_fast_path: AtomicU8::new(FastPath::Unavailable.code()),
            root_refused: AtomicU8::new(NO_REFUSAL),
            fault: Mutex::new(None),
            result: Mutex::new(None),
        }
    }

    /// Keeps `text` as the walk's fault unless one was recorded already: the
    /// first fault is the one that ended the walk, the rest are its consequences.
    pub(crate) fn record_fault(&self, text: String) {
        let mut fault = lock(&self.fault);
        if fault.is_none() {
            *fault = Some(text);
        }
    }

    /// Records a walker thread's panic as the walk's fault.
    pub(super) fn record_panic(&self, payload: &(dyn Any + Send)) {
        self.record_fault(format!("a walker thread panicked: {}", panic_text(payload)));
    }

    /// The most workers that may run right now: the hill-climber's target,
    /// bounded by the governor's limit, never below one.
    pub(super) fn effective_target(&self) -> u32 {
        self.active_target
            .load(Ordering::Acquire)
            .min(self.pacer.worker_limit())
            .max(1)
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    /// Blocks while paused; returns true when the walk was cancelled meanwhile.
    pub(crate) fn wait_while_paused(&self) -> bool {
        if !self.paused.load(Ordering::Acquire) {
            return self.is_cancelled();
        }
        let mut guard = lock(&self.pause_lock);
        let parked = Counted::new(&self.parked);
        while self.paused.load(Ordering::Acquire) && !self.is_cancelled() {
            let (next, _) = self
                .pause_changed
                .wait_timeout(guard, PAUSE_POLL)
                .unwrap_or_else(PoisonError::into_inner);
            guard = next;
        }
        drop(parked);
        drop(guard);
        self.is_cancelled()
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.queue.close();
        self.pause_changed.notify_all();
    }

    /// Records `path` as the current one, at most every [`SAMPLE_INTERVAL`].
    pub(crate) fn sample_path(&self, path: &Path) {
        let now = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let last = self.last_sample_ms.load(Ordering::Relaxed);
        let due = last == NEVER
            || now.saturating_sub(last)
                >= u64::try_from(SAMPLE_INTERVAL.as_millis()).unwrap_or(u64::MAX);
        if !due {
            return;
        }
        if self
            .last_sample_ms
            .compare_exchange(last, now, Ordering::AcqRel, Ordering::Relaxed)
            .is_ok()
        {
            *lock(&self.current_path) = Some(path.to_string_lossy().into_owned());
        }
    }

    pub(super) fn root_refusal(&self) -> Option<Refusal> {
        Refusal::from_code(self.root_refused.load(Ordering::Acquire))
    }

    /// Whether the walk goes on into `dir`'s subfolder `name`: not when the
    /// joined path is a never-descend path. The path is joined only when
    /// there is such a path to compare it with.
    pub(crate) fn may_descend(&self, dir: &Path, name: &[u8]) -> bool {
        self.never_descend.is_empty() || !self.never_descend.contains(&child_path(dir, name))
    }
}

#[cfg(test)]
mod tests {
    use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};

    use super::*;

    #[test]
    fn a_counted_guard_gives_its_count_back_however_its_holder_ends() {
        let count = AtomicU32::new(0);
        // A holder that panics: the unwinding drop gives the count back.
        let unwound = catch_unwind(AssertUnwindSafe(|| {
            let _waiting = Counted::new(&count);
            if count.load(Ordering::Acquire) == 1 {
                resume_unwind(Box::new("a waiting holder that panics"));
            }
        }));
        assert!(unwound.is_err(), "the holder panicked");
        assert_eq!(count.load(Ordering::Acquire), 0, "given back by the unwind");
        // Holders that overlap and end one after the other.
        {
            let _first = Counted::new(&count);
            {
                let _second = Counted::new(&count);
                assert_eq!(count.load(Ordering::Acquire), 2);
            }
            assert_eq!(count.load(Ordering::Acquire), 1);
        }
        assert_eq!(count.load(Ordering::Acquire), 0);
    }
}

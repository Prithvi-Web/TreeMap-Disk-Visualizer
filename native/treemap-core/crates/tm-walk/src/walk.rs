//! The walk: workers on `std::thread`, a driver thread that runs the
//! hill-climber and merges the output, and the handle Node polls.
//!
//! Each worker applies the governor's profile to its thread at start, then
//! loops: take a directory from the [`Queue`] (parking when its index is above
//! the count it may run: the hill-climber's target and the governor's
//! `worker_limit()`, re-read before every directory), wait while paused, list
//! it into its own reusable [`ListBuffer`], append the entries to its own
//! columns and name arena, enqueue the child directories, then call
//! `throttle()`. Ids come from one atomic counter at discovery, so a directory
//! is always listed after it was numbered and `parent[i] < i` holds. At the end
//! the driver merges every worker's columns into the output in id order.

use std::borrow::Cow;
use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tm_governor::{Governor, apply_to_current_thread, profile};

use crate::climb::Climber;
use crate::output::{DirRefusal, HardlinkRef, Refusal, WalkOutput, WalkStats};
use crate::platform::{ListBuffer, Lister, Meta, thread_cpu_seconds};
use crate::queue::{DirJob, Queue};
use crate::{
    FLAG_DATALESS, FLAG_REFUSED_DIR, FastPath, KIND_DIR, KIND_FILE, WalkError, WalkOptions,
};

/// The `current_path` sample is refreshed at most this often.
pub const SAMPLE_INTERVAL: Duration = Duration::from_millis(50);
/// Entries between pause/cancel checks inside one directory, so a huge
/// directory cannot keep counting for long after a pause.
pub const CHECK_EVERY: usize = 256;
/// The most worker threads a walk ever runs, whatever the governor allows.
pub const MAX_WORKERS: u32 = 64;
/// How long the driver sleeps between looks at the queue and the climber.
const DRIVER_SLICE: Duration = Duration::from_millis(25);
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
}

/// What Node polls at the SSE cadence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Progress {
    /// Entries discovered under the root so far.
    pub entries: u64,
    /// Of which directories.
    pub dirs: u64,
    /// Of which leaves (files, symlinks, sockets, fifos, devices).
    pub files: u64,
    /// The leaves' logical bytes so far.
    pub bytes: u64,
    /// A directory being listed, sampled at most every [`SAMPLE_INTERVAL`].
    pub current_path: Option<String>,
    /// True once [`WalkHandle::take`] will not block.
    pub done: bool,
}

/// Everything the workers, the driver and the handle share.
struct Shared {
    root: PathBuf,
    want_atime: bool,
    never_descend: HashSet<PathBuf>,
    max_workers: usize,
    buffer_bytes: usize,
    pacer: Arc<dyn Pacer>,
    lister: Arc<dyn Lister>,
    queue: Queue,
    next_id: AtomicU32,
    entries: AtomicU64,
    dirs: AtomicU64,
    files: AtomicU64,
    bytes: AtomicU64,
    dirs_listed: AtomicU64,
    denied_entries: AtomicU64,
    unreadable_entries: AtomicU64,
    dataless: AtomicU64,
    active_target: AtomicU32,
    paused: AtomicBool,
    cancelled: AtomicBool,
    done: AtomicBool,
    pause_lock: Mutex<()>,
    pause_changed: Condvar,
    started: Instant,
    last_sample_ms: AtomicU64,
    current_path: Mutex<Option<String>>,
    root_fast_path: AtomicU8,
    root_refused: AtomicU8,
    result: Mutex<Option<Result<WalkOutput, WalkError>>>,
}

impl Shared {
    fn new(opts: WalkOptions, pacer: Arc<dyn Pacer>, lister: Arc<dyn Lister>) -> Self {
        Self {
            root: opts.root,
            want_atime: opts.want_atime,
            never_descend: opts.never_descend.into_iter().collect(),
            max_workers: opts.max_workers,
            buffer_bytes: opts.buffer_bytes,
            pacer,
            lister,
            queue: Queue::new(),
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
            cancelled: AtomicBool::new(false),
            done: AtomicBool::new(false),
            pause_lock: Mutex::new(()),
            pause_changed: Condvar::new(),
            started: Instant::now(),
            last_sample_ms: AtomicU64::new(NEVER),
            current_path: Mutex::new(None),
            root_fast_path: AtomicU8::new(FastPath::Unavailable.code()),
            root_refused: AtomicU8::new(NO_REFUSAL),
            result: Mutex::new(None),
        }
    }

    /// The most workers that may run right now: the hill-climber's target,
    /// bounded by the governor's limit, never below one.
    fn effective_target(&self) -> u32 {
        self.active_target
            .load(Ordering::Acquire)
            .min(self.pacer.worker_limit())
            .max(1)
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    /// Blocks while paused; returns true when the walk was cancelled meanwhile.
    fn wait_while_paused(&self) -> bool {
        if !self.paused.load(Ordering::Acquire) {
            return self.is_cancelled();
        }
        let mut guard = lock(&self.pause_lock);
        while self.paused.load(Ordering::Acquire) && !self.is_cancelled() {
            let (next, _) = self
                .pause_changed
                .wait_timeout(guard, PAUSE_POLL)
                .unwrap_or_else(PoisonError::into_inner);
            guard = next;
        }
        drop(guard);
        self.is_cancelled()
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.queue.close();
        self.pause_changed.notify_all();
    }

    /// Records `path` as the current one, at most every [`SAMPLE_INTERVAL`].
    fn sample_path(&self, path: &Path) {
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

    fn root_refusal(&self) -> Option<Refusal> {
        Refusal::from_code(self.root_refused.load(Ordering::Acquire))
    }
}

/// One worker's columns, in its own discovery order, keyed by global id.
#[derive(Default)]
struct Part {
    ids: Vec<u32>,
    parent: Vec<u32>,
    names: Vec<u8>,
    name_len: Vec<u32>,
    kind: Vec<u8>,
    flags: Vec<u8>,
    size: Vec<f64>,
    alloc: Vec<f64>,
    mtime: Vec<f64>,
    atime: Vec<f64>,
    hardlinks: Vec<HardlinkRef>,
    refusals: Vec<DirRefusal>,
    cpu_seconds: f64,
}

impl Part {
    /// Appends a node. The name goes into the arena as valid UTF-8: the OS
    /// bytes when they are, U+FFFD per maximal invalid subpart otherwise.
    fn push(&mut self, id: u32, parent: u32, name: &[u8], meta: &Meta) {
        let text = String::from_utf8_lossy(name);
        self.ids.push(id);
        self.parent.push(parent);
        self.names.extend_from_slice(text.as_bytes());
        self.name_len
            .push(u32::try_from(text.len()).unwrap_or(u32::MAX));
        self.kind.push(meta.kind);
        self.flags.push(meta.flags);
        self.size.push(meta.size);
        self.alloc.push(meta.alloc);
        self.mtime.push(meta.mtime_ms);
        self.atime.push(meta.atime_ms);
    }
}

/// The handle to a running walk. `Send + Sync`; dropping it without
/// [`take`](Self::take) cancels the walk.
pub struct WalkHandle {
    shared: Arc<Shared>,
    driver: Option<JoinHandle<()>>,
    taken: bool,
}

const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<WalkHandle>();
};

impl std::fmt::Debug for WalkHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WalkHandle")
            .field("root", &self.shared.root)
            .field("progress", &self.progress())
            .field("paused", &self.shared.paused.load(Ordering::Acquire))
            .field("cancelled", &self.shared.is_cancelled())
            .finish_non_exhaustive()
    }
}

impl WalkHandle {
    /// The counters right now.
    pub fn progress(&self) -> Progress {
        let s = &*self.shared;
        Progress {
            entries: s.entries.load(Ordering::Acquire),
            dirs: s.dirs.load(Ordering::Acquire),
            files: s.files.load(Ordering::Acquire),
            bytes: s.bytes.load(Ordering::Acquire),
            current_path: lock(&s.current_path).clone(),
            done: s.done.load(Ordering::Acquire),
        }
    }

    /// Stops the workers at their next check (between directories and every
    /// [`CHECK_EVERY`] entries inside one). Nothing is re-listed on resume.
    pub fn pause(&self) {
        self.shared.paused.store(true, Ordering::Release);
    }

    /// Lets paused workers continue where they stopped.
    pub fn resume(&self) {
        self.shared.paused.store(false, Ordering::Release);
        self.shared.pause_changed.notify_all();
    }

    /// Ends the walk; [`take`](Self::take) then returns [`WalkError::Cancelled`].
    pub fn cancel(&self) {
        self.shared.cancel();
    }

    /// Blocks until the walk is done and returns its output, or the error it
    /// ended with (`Cancelled` after [`cancel`](Self::cancel)). A paused walk
    /// never finishes: resume or cancel it first.
    pub fn take(mut self) -> Result<WalkOutput, WalkError> {
        self.taken = true;
        self.join_driver()?;
        lock(&self.shared.result).take().unwrap_or_else(|| {
            Err(WalkError::Internal(
                "the walk ended without a result".to_owned(),
            ))
        })
    }

    fn join_driver(&mut self) -> Result<(), WalkError> {
        if let Some(driver) = self.driver.take() {
            driver
                .join()
                .map_err(|_| WalkError::Internal("the walk's driver thread panicked".to_owned()))?;
        }
        Ok(())
    }
}

impl Drop for WalkHandle {
    fn drop(&mut self) {
        if !self.taken && !self.shared.done.load(Ordering::Acquire) {
            self.shared.cancel();
        }
        // A panic on the driver has already been reported through `take`, or
        // there is nobody left to report it to.
        let _ = self.join_driver();
    }
}

/// Starts a walk through any [`Pacer`] and [`Lister`]: what [`crate::start`]
/// calls with the governor and the platform, and what tests call with fakes.
pub fn start_with(
    opts: WalkOptions,
    pacer: Arc<dyn Pacer>,
    lister: Arc<dyn Lister>,
) -> Result<WalkHandle, WalkError> {
    let root_meta = lister
        .stat_dir(&opts.root, opts.want_atime)
        .map_err(WalkError::RootRefused)?;
    if root_meta.kind != KIND_DIR {
        return Err(WalkError::RootNotDirectory);
    }
    let shared = Arc::new(Shared::new(opts, pacer, lister));
    let for_driver = Arc::clone(&shared);
    let driver = thread::Builder::new()
        .name("tm-walk-driver".to_owned())
        .spawn(move || drive(&for_driver, root_meta))
        .map_err(|e| {
            WalkError::Internal(format!("could not start the walk's driver thread: {e}"))
        })?;
    Ok(WalkHandle {
        shared,
        driver: Some(driver),
        taken: false,
    })
}

fn drive(shared: &Arc<Shared>, root_meta: Meta) {
    let outcome = run_walk(shared, root_meta);
    *lock(&shared.result) = Some(outcome);
    shared.done.store(true, Ordering::Release);
}

fn run_walk(shared: &Arc<Shared>, root_meta: Meta) -> Result<WalkOutput, WalkError> {
    let mut root_part = Part::default();
    root_part.push(0, 0, &root_name(&shared.root), &root_meta);
    shared.queue.push(DirJob {
        id: 0,
        path: shared.root.clone(),
    });

    let limit = || shared.pacer.worker_limit().clamp(1, MAX_WORKERS);
    let fixed = (shared.max_workers > 0).then(|| {
        u32::try_from(shared.max_workers)
            .unwrap_or(MAX_WORKERS)
            .min(MAX_WORKERS)
    });
    let mut climber = Climber::new(limit());
    let mut target = fixed.map_or_else(|| climber.workers(), |count| count.min(limit()));
    shared.active_target.store(target, Ordering::Release);

    let mut threads: Vec<JoinHandle<Part>> = Vec::new();
    let spawn_failure = loop {
        if let Err(e) = spawn_up_to(shared, &mut threads, target) {
            break Some(e);
        }
        if shared.queue.wait_closed(DRIVER_SLICE) || shared.is_cancelled() {
            break None;
        }
        let now = shared.started.elapsed();
        let current_limit = limit();
        target = if let Some(count) = fixed {
            count.min(current_limit)
        } else {
            climber.set_ceiling(current_limit);
            climber.observe(now, shared.entries.load(Ordering::Acquire))
        };
        if shared.active_target.swap(target, Ordering::AcqRel) != target {
            shared.queue.notify();
        }
    };
    if spawn_failure.is_some() {
        shared.cancel();
    }
    shared.queue.close();
    shared.pause_changed.notify_all();

    let mut parts = vec![root_part];
    for handle in threads {
        match handle.join() {
            Ok(part) => parts.push(part),
            Err(_) => return Err(WalkError::Internal("a walker thread panicked".to_owned())),
        }
    }
    if let Some(e) = spawn_failure {
        return Err(e);
    }
    if let Some(why) = shared.root_refusal() {
        return Err(WalkError::RootRefused(why));
    }
    if shared.is_cancelled() {
        return Err(WalkError::Cancelled);
    }
    // The root must still be there, as the legacy walker re-checks at the end.
    shared
        .lister
        .stat_dir(&shared.root, shared.want_atime)
        .map_err(WalkError::RootRefused)?;

    let worker_cpu: f64 = parts.iter().map(|p| p.cpu_seconds).sum();
    let total = usize::try_from(shared.next_id.load(Ordering::Acquire))
        .map_err(|_| WalkError::Internal("too many nodes for this platform".to_owned()))?;
    let merged = merge(&parts, total)?;
    drop(parts);
    let stats = WalkStats {
        dirs_listed: shared.dirs_listed.load(Ordering::Acquire),
        entries: shared.entries.load(Ordering::Acquire),
        wall_ms: shared.started.elapsed().as_secs_f64() * 1e3,
        cpu_seconds: worker_cpu + thread_cpu_seconds(),
        fast_path: FastPath::from_code(shared.root_fast_path.load(Ordering::Acquire)),
        workers_peak: shared.queue.peak_in_flight(),
        climb_steps: climber.steps(),
        denied_entries: shared.denied_entries.load(Ordering::Acquire),
        unreadable_entries: shared.unreadable_entries.load(Ordering::Acquire),
        dataless: shared.dataless.load(Ordering::Acquire),
    };
    Ok(WalkOutput {
        parent: merged.parent,
        name_off: merged.name_off,
        names: merged.names,
        kind: merged.kind,
        flags: merged.flags,
        size: merged.size,
        alloc_bytes: merged.alloc,
        mtime_ms: merged.mtime,
        atime_ms: merged.atime,
        hardlinks: merged.hardlinks,
        refusals: merged.refusals,
        stats,
    })
}

/// Spawns workers lazily up to `target`; a worker above the current target
/// parks in the queue, so the thread count only ever grows to the peak target.
fn spawn_up_to(
    shared: &Arc<Shared>,
    threads: &mut Vec<JoinHandle<Part>>,
    target: u32,
) -> Result<(), WalkError> {
    while u32::try_from(threads.len()).unwrap_or(u32::MAX) < target {
        let index = u32::try_from(threads.len()).unwrap_or(u32::MAX);
        let for_worker = Arc::clone(shared);
        let handle = thread::Builder::new()
            .name(format!("tm-walk-worker-{index}"))
            .spawn(move || worker(&for_worker, index))
            .map_err(|e| {
                WalkError::Internal(format!("could not start walker thread {index}: {e}"))
            })?;
        threads.push(handle);
    }
    Ok(())
}

fn worker(shared: &Arc<Shared>, index: u32) -> Part {
    shared.pacer.on_worker_start();
    let mut part = Part::default();
    let mut buf = ListBuffer::new(shared.buffer_bytes);
    let mut pending: Vec<DirJob> = Vec::new();
    let may_run = || index < shared.effective_target();
    while let Some(job) = shared.queue.next_job(&may_run) {
        if shared.wait_while_paused() {
            shared.queue.finish_job();
            break;
        }
        process_dir(shared, &mut part, &mut buf, &mut pending, &job);
        shared.queue.finish_job();
        shared.pacer.throttle(&|| shared.is_cancelled());
    }
    part.cpu_seconds = thread_cpu_seconds();
    part
}

/// Lists one directory and records what it holds.
fn process_dir(
    shared: &Shared,
    part: &mut Part,
    buf: &mut ListBuffer,
    pending: &mut Vec<DirJob>,
    job: &DirJob,
) {
    shared.sample_path(&job.path);
    let path = match shared.lister.list(&job.path, shared.want_atime, buf) {
        Ok(path) => path,
        Err(why) => {
            if job.id == 0 {
                shared.root_refused.store(why.code(), Ordering::Release);
                shared.queue.close();
            } else {
                part.refusals.push(DirRefusal { node: job.id, why });
            }
            return;
        }
    };
    if job.id == 0 {
        shared.root_fast_path.store(path.code(), Ordering::Release);
    }
    shared.dirs_listed.fetch_add(1, Ordering::AcqRel);
    let listing = &buf.listing;
    shared
        .denied_entries
        .fetch_add(listing.denied_entries, Ordering::AcqRel);
    shared
        .unreadable_entries
        .fetch_add(listing.unreadable_entries, Ordering::AcqRel);
    for (k, entry) in listing.entries.iter().enumerate() {
        if k > 0 && k % CHECK_EVERY == 0 && shared.wait_while_paused() {
            pending.clear();
            return;
        }
        let meta = &entry.meta;
        let name = listing.name(entry);
        let id = shared.next_id.fetch_add(1, Ordering::AcqRel);
        part.push(id, job.id, name, meta);
        shared.entries.fetch_add(1, Ordering::AcqRel);
        if meta.withheld {
            shared.unreadable_entries.fetch_add(1, Ordering::AcqRel);
        }
        if meta.flags & FLAG_DATALESS != 0 {
            shared.dataless.fetch_add(1, Ordering::AcqRel);
        }
        if meta.kind == KIND_DIR {
            shared.dirs.fetch_add(1, Ordering::AcqRel);
            let child = child_path(&job.path, name);
            if !shared.never_descend.contains(&child) {
                pending.push(DirJob { id, path: child });
            }
        } else {
            shared.files.fetch_add(1, Ordering::AcqRel);
            shared
                .bytes
                .fetch_add(whole_bytes(meta.size), Ordering::AcqRel);
            if meta.kind == KIND_FILE && meta.nlink > 1 {
                part.hardlinks.push(HardlinkRef {
                    node: id,
                    dev: meta.dev,
                    ino: meta.ino,
                });
            }
        }
    }
    shared.queue.push_all(pending);
}

/// A size column value (a whole, non-negative number from the OS) as bytes.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "sizes come from an i64 the OS reported; anything else is treated as zero"
)]
fn whole_bytes(size: f64) -> u64 {
    if size.is_finite() && size >= 0.0 {
        size as u64
    } else {
        0
    }
}

#[cfg(unix)]
fn child_path(dir: &Path, name: &[u8]) -> PathBuf {
    use std::os::unix::ffi::OsStrExt;
    dir.join(OsStr::from_bytes(name))
}

#[cfg(not(unix))]
fn child_path(dir: &Path, name: &[u8]) -> PathBuf {
    dir.join(&*String::from_utf8_lossy(name))
}

/// The root's own name: its last component, or the whole path when it has none.
fn root_name(root: &Path) -> Cow<'_, [u8]> {
    os_bytes(root.file_name().unwrap_or(root.as_os_str()))
}

#[cfg(unix)]
fn os_bytes(os: &OsStr) -> Cow<'_, [u8]> {
    use std::os::unix::ffi::OsStrExt;
    Cow::Borrowed(os.as_bytes())
}

#[cfg(not(unix))]
fn os_bytes(os: &OsStr) -> Cow<'_, [u8]> {
    Cow::Owned(os.to_string_lossy().into_owned().into_bytes())
}

struct Merged {
    parent: Vec<u32>,
    name_off: Vec<u32>,
    names: Vec<u8>,
    kind: Vec<u8>,
    flags: Vec<u8>,
    size: Vec<f64>,
    alloc: Vec<f64>,
    mtime: Vec<f64>,
    atime: Vec<f64>,
    hardlinks: Vec<HardlinkRef>,
    refusals: Vec<DirRefusal>,
}

fn out_of_range(id: u32, total: usize) -> WalkError {
    WalkError::Internal(format!("node {id} is outside the {total} nodes discovered"))
}

/// Copies `src[j]` into `dst[i]`, or says which node was inconsistent.
fn place<T: Copy>(dst: &mut [T], i: usize, src: &[T], j: usize, id: u32) -> Result<(), WalkError> {
    let total = dst.len();
    let value = *src.get(j).ok_or_else(|| out_of_range(id, total))?;
    *dst.get_mut(i).ok_or_else(|| out_of_range(id, total))? = value;
    Ok(())
}

/// Merges every part's columns into id order and lays the names out in one arena.
fn merge(parts: &[Part], total: usize) -> Result<Merged, WalkError> {
    let mut parent = vec![0_u32; total];
    let mut kind = vec![0_u8; total];
    let mut flags = vec![0_u8; total];
    let mut size = vec![0_f64; total];
    let mut alloc = vec![0_f64; total];
    let mut mtime = vec![f64::NAN; total];
    let mut atime = vec![f64::NAN; total];
    let mut name_len = vec![0_u32; total];
    for part in parts {
        for (j, &id) in part.ids.iter().enumerate() {
            let i = id as usize;
            place(&mut parent, i, &part.parent, j, id)?;
            place(&mut kind, i, &part.kind, j, id)?;
            place(&mut flags, i, &part.flags, j, id)?;
            place(&mut size, i, &part.size, j, id)?;
            place(&mut alloc, i, &part.alloc, j, id)?;
            place(&mut mtime, i, &part.mtime, j, id)?;
            place(&mut atime, i, &part.atime, j, id)?;
            place(&mut name_len, i, &part.name_len, j, id)?;
        }
    }

    let mut name_off = Vec::with_capacity(total.saturating_add(1));
    let mut running = 0_u32;
    name_off.push(running);
    for len in &name_len {
        running = running
            .checked_add(*len)
            .ok_or_else(|| WalkError::Internal("the names exceed 4 GiB".to_owned()))?;
        name_off.push(running);
    }
    let mut names = vec![0_u8; running as usize];
    for part in parts {
        let mut src = 0_usize;
        for (j, &id) in part.ids.iter().enumerate() {
            let len = *part
                .name_len
                .get(j)
                .ok_or_else(|| out_of_range(id, total))? as usize;
            let src_end = src
                .checked_add(len)
                .ok_or_else(|| out_of_range(id, total))?;
            let bytes = part
                .names
                .get(src..src_end)
                .ok_or_else(|| out_of_range(id, total))?;
            let dst = *name_off
                .get(id as usize)
                .ok_or_else(|| out_of_range(id, total))? as usize;
            let dst_end = dst
                .checked_add(len)
                .ok_or_else(|| out_of_range(id, total))?;
            names
                .get_mut(dst..dst_end)
                .ok_or_else(|| out_of_range(id, total))?
                .copy_from_slice(bytes);
            src = src_end;
        }
    }

    let mut hardlinks: Vec<HardlinkRef> = parts
        .iter()
        .flat_map(|p| p.hardlinks.iter().copied())
        .collect();
    hardlinks.sort_by_key(|h| h.node);
    let mut refusals: Vec<DirRefusal> = parts
        .iter()
        .flat_map(|p| p.refusals.iter().copied())
        .collect();
    refusals.sort_by_key(|r| r.node);
    for refusal in &refusals {
        let slot = flags
            .get_mut(refusal.node as usize)
            .ok_or_else(|| out_of_range(refusal.node, total))?;
        *slot |= FLAG_REFUSED_DIR;
    }

    Ok(Merged {
        parent,
        name_off,
        names,
        kind,
        flags,
        size,
        alloc,
        mtime,
        atime,
        hardlinks,
        refusals,
    })
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

//! The walk: workers on `std::thread`, a driver thread that runs the
//! hill-climber and merges the output, and the handle Node polls.
//!
//! Each worker applies the governor's profile to its thread at start, then
//! loops: take a directory from the `Queue` (parking when its index is above
//! the count it may run: the hill-climber's target and the governor's
//! `worker_limit()`, re-read before every directory), wait while paused, list
//! it into its own reusable [`ListBuffer`], append the entries to its own
//! columns and name arena, enqueue the child directories, then call
//! `throttle()`. Ids come from one atomic counter at discovery, so a directory
//! is always listed after it was numbered and `parent[i] < i` holds. At the end
//! the driver merges every worker's columns into the output in id order.
//!
//! A panic on a worker is a fault, not a wedge: the listing runs under
//! `catch_unwind`, the first fault's text is kept, the walk is cancelled, every
//! thread is still joined, and `take()` returns [`WalkError::Internal`] naming
//! the panic. The same fault path ends a walk whose ids would wrap.

use std::any::Any;
use std::borrow::Cow;
use std::ffi::OsStr;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::blocks::{Stage, process_listing, to_sinks};
use crate::climb::Climber;
use crate::output::{WalkOutput, WalkStats};
use crate::platform::{ListBuffer, Lister, Meta, push_stored, thread_cpu_seconds};
use crate::queue::DirJob;
use crate::sink::ListingSink;
use crate::{FastPath, KIND_DIR, Numbering, WalkError, WalkOptions};

mod discovery;
mod merge;
mod shared;

use discovery::process_dir;
pub(crate) use merge::{Merged, Part, merge};
use merge::{collected, refresh_families};
pub(crate) use shared::{Counted, Shared};
pub use shared::{GovernorPacer, Pacer};

/// The `current_path` sample is refreshed at most this often.
pub const SAMPLE_INTERVAL: Duration = Duration::from_millis(50);
/// Entries between pause/cancel checks inside one directory, so a huge
/// directory cannot keep counting for long after a pause.
pub const CHECK_EVERY: usize = 256;
/// The most worker threads a walk ever runs, whatever the governor allows.
pub const MAX_WORKERS: u32 = 64;
/// How long the driver sleeps between looks at the queue and the climber.
const DRIVER_SLICE: Duration = Duration::from_millis(25);

/// The fault recorded when the id counter reaches its ceiling: ids are `u32`
/// and the root holds 0, so `u32::MAX - 1` entries is the most a walk can number.
#[cfg(test)]
const ID_CEILING_FAULT: &str = "the walk exceeded 4,294,967,294 entries";

/// The fault recorded when the id counter reaches `ceiling` (at the default
/// ceiling, "the walk exceeded 4,294,967,294 entries"): the walk numbered the
/// most entries it could, `ceiling - 1`, and needed another.
pub(crate) fn ceiling_fault(ceiling: u32) -> String {
    let digits = ceiling.saturating_sub(1).to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    format!("the walk exceeded {grouped} entries")
}
/// The bytes a directory name must not hold to be joined onto its parent as
/// one component: `/` everywhere, `\` too on Windows.
const NAME_SEPARATORS: &[u8] = if cfg!(windows) { b"/\\" } else { b"/" };

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
    /// Batches the OS has answered so far, across every worker (see
    /// [`ListBuffer::heartbeat`]): it advances while a directory is still
    /// listing, when `entries` cannot.
    pub heartbeat: u64,
    /// True once [`WalkHandle::take`] will not block.
    pub done: bool,
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

/// What a walk counted of its own machinery, for tests and measurements. Kept
/// apart from [`WalkStats`], whose shape is tm-mft's wire format too.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WalkCounts {
    /// The most jobs the queue held at once.
    pub queue_peak: u64,
    /// Blocks reserved (block numbering): one per listing committed.
    pub blocks: u64,
    /// Listings that went through the big-listing semaphore.
    pub big_listings: u64,
    /// Workers waiting on the big-listing semaphore right now.
    pub big_waiting: u32,
    /// The most workers past the big-listing semaphore at once.
    pub big_peak: u32,
    /// Workers parked by a pause right now: between two folders, or inside
    /// one at a [`CHECK_EVERY`] check.
    pub paused_workers: u32,
}

impl WalkHandle {
    /// What the walk has counted of its own machinery so far.
    pub fn counts(&self) -> WalkCounts {
        let s = &*self.shared;
        let (big_listings, big_waiting, big_peak) = s.big.counts();
        WalkCounts {
            queue_peak: u64::try_from(s.queue.peak_len()).unwrap_or(u64::MAX),
            blocks: s.blocks.load(Ordering::Acquire),
            big_listings,
            big_waiting,
            big_peak,
            paused_workers: s.parked.load(Ordering::Acquire),
        }
    }

    /// The counters right now.
    pub fn progress(&self) -> Progress {
        let s = &*self.shared;
        Progress {
            entries: s.entries.load(Ordering::Acquire),
            dirs: s.dirs.load(Ordering::Acquire),
            files: s.files.load(Ordering::Acquire),
            bytes: s.bytes.load(Ordering::Acquire),
            current_path: lock(&s.current_path).clone(),
            heartbeat: s.heartbeat.load(Ordering::Acquire),
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
            driver.join().map_err(|payload| {
                WalkError::Internal(format!(
                    "the walk's driver thread panicked: {}",
                    panic_text(&*payload)
                ))
            })?;
        }
        Ok(())
    }
}

/// The text of a panic payload: what `panic!` was given, whether it was
/// formatted (`String`) or a literal (`&str`); `no message` for anything else.
pub fn panic_text(payload: &(dyn Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_owned()
    } else {
        "no message".to_owned()
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
    start_with_sinks(opts, pacer, lister, Vec::new())
}

/// [`start_with`], handing every commit of a block-numbered walk to `sinks`
/// too, after the walk's own collector (see [`crate::sink`]). Every sink that
/// is handed over ends with an output or with `abort()`: a walk that cannot
/// start — its root refused or not a folder, sinks under discovery numbering
/// (which never commits, so they are refused) — aborts them before it returns.
pub fn start_with_sinks(
    opts: WalkOptions,
    pacer: Arc<dyn Pacer>,
    lister: Arc<dyn Lister>,
    sinks: Vec<Arc<dyn ListingSink>>,
) -> Result<WalkHandle, WalkError> {
    let aborting = |sinks: &[Arc<dyn ListingSink>], err: WalkError| {
        abort_all(sinks);
        err
    };
    if opts.numbering == Numbering::Discovery && !sinks.is_empty() {
        return Err(aborting(
            &sinks,
            WalkError::OptionsRefused(
                "listing sinks are fed only by block numbering; discovery numbering never commits a block"
                    .to_owned(),
            ),
        ));
    }
    let root_meta = match catch_unwind(AssertUnwindSafe(|| {
        lister.stat_dir(&opts.root, opts.want_atime)
    })) {
        Ok(Ok(meta)) => meta,
        Ok(Err(why)) => return Err(aborting(&sinks, WalkError::RootRefused(why))),
        Err(payload) => {
            abort_all(&sinks);
            resume_unwind(payload);
        }
    };
    if root_meta.kind != KIND_DIR {
        return Err(aborting(&sinks, WalkError::RootNotDirectory));
    }
    let shared = Arc::new(Shared::with_sinks(opts, pacer, lister, sinks));
    let for_driver = Arc::clone(&shared);
    let driver = thread::Builder::new()
        .name("tm-walk-driver".to_owned())
        .spawn(move || drive(&for_driver, root_meta))
        .map_err(|e| {
            abort_all(&shared.sinks);
            WalkError::Internal(format!("could not start the walk's driver thread: {e}"))
        })?;
    Ok(WalkHandle {
        shared,
        driver: Some(driver),
        taken: false,
    })
}

/// `abort()` on every sink, once each; a sink that panics in it cannot change
/// how the walk ended, so its panic is dropped and the others still abort.
fn abort_all(sinks: &[Arc<dyn ListingSink>]) {
    for sink in sinks {
        let _ = catch_unwind(AssertUnwindSafe(|| sink.abort()));
    }
}

fn drive(shared: &Arc<Shared>, root_meta: Meta) {
    if shared.sinks.is_empty() {
        let outcome = run_walk(shared, root_meta);
        *lock(&shared.result) = Some(outcome);
        shared.done.store(true, Ordering::Release);
        return;
    }
    // A walk that ends without an output aborts every sink, and so does a
    // panic on this thread, which then goes on to `take()` as it always did.
    match catch_unwind(AssertUnwindSafe(|| run_walk(shared, root_meta))) {
        Ok(outcome) => {
            if outcome.is_err() {
                abort_all(&shared.sinks);
            }
            *lock(&shared.result) = Some(outcome);
            shared.done.store(true, Ordering::Release);
        }
        Err(payload) => {
            abort_all(&shared.sinks);
            resume_unwind(payload);
        }
    }
}

fn run_walk(shared: &Arc<Shared>, root_meta: Meta) -> Result<WalkOutput, WalkError> {
    let mut root_part = Part::default();
    match shared.numbering {
        Numbering::Discovery => root_part.push(0, 0, &root_name(&shared.root), &root_meta),
        Numbering::Blocks => {
            let name = stored_root_name(&shared.root);
            if !to_sinks(shared, |sink| sink.root(&name, &root_meta)) {
                let fault = lock(&shared.fault).take();
                return Err(WalkError::Internal(fault.unwrap_or_default()));
            }
        }
    }
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
    let mut climber = Climber::starting_at(limit(), shared.pacer.start_workers());
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

    // Every thread is joined, whatever the first one reported: a dead thread
    // must not leave the others listing behind a handle that says it is done.
    let mut parts = vec![root_part];
    for handle in threads {
        match handle.join() {
            Ok(part) => parts.push(part),
            Err(payload) => shared.record_panic(&*payload),
        }
    }
    // A fault comes before the cancel check: the cancel was the fault's own.
    if let Some(text) = lock(&shared.fault).take() {
        return Err(WalkError::Internal(text));
    }
    if let Some(e) = spawn_failure {
        return Err(e);
    }
    // A cancel before a refused root: the listing a cancel interrupts answers
    // with the error it stopped on, and for the root that reads as the root
    // being refused — a cancel that landed while the root was being listed
    // came back as "the root could not be read".
    if shared.is_cancelled() {
        return Err(WalkError::Cancelled);
    }
    if let Some(why) = shared.root_refusal() {
        return Err(WalkError::RootRefused(why));
    }
    // The root must still be there, as the legacy walker re-checks at the end.
    shared
        .lister
        .stat_dir(&shared.root, shared.want_atime)
        .map_err(WalkError::RootRefused)?;

    let worker_cpu: f64 = parts.iter().map(|p| p.cpu_seconds).sum();
    let total = usize::try_from(shared.next_id.load(Ordering::Acquire))
        .map_err(|_| WalkError::Internal("too many nodes for this platform".to_owned()))?;
    let mut merged = match &shared.collect {
        None => merge(&parts, total)?,
        Some(collect) => collected(collect, total)?,
    };
    drop(parts);
    refresh_families(shared, &mut merged)?;
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
    let mut buf = ListBuffer::with_signals(
        shared.buffer_bytes,
        Arc::clone(&shared.cancelled),
        Arc::clone(&shared.heartbeat),
    );
    let mut pending: Vec<DirJob> = Vec::new();
    let mut stage = Stage::default();
    let may_run = || index < shared.effective_target();
    while let Some(job) = shared.queue.next_job(&may_run) {
        if shared.wait_while_paused() {
            shared.queue.finish_job();
            break;
        }
        // A panic inside the listing (an overflow check, a platform bug) must
        // still hand the job back, or `in_flight` never reaches zero and the
        // queue never closes: the panic becomes the walk's fault instead.
        let listed = catch_unwind(AssertUnwindSafe(|| match shared.numbering {
            Numbering::Discovery => process_dir(shared, &mut part, &mut buf, &mut pending, &job),
            Numbering::Blocks => process_listing(shared, &mut buf, &mut stage, &mut pending, &job),
        }));
        if let Err(payload) = listed {
            shared.record_panic(&*payload);
            shared.queue.finish_job();
            shared.cancel();
            break;
        }
        shared.queue.finish_job();
        shared.pacer.throttle(&|| shared.is_cancelled());
    }
    part.cpu_seconds = thread_cpu_seconds();
    part
}

/// True when a name the OS returned holds a separator, so that joining it
/// onto its parent would make several components and list somewhere else
/// (such names are creatable on NTFS through WSL).
pub(crate) fn name_is_a_path(name: &[u8]) -> bool {
    name.iter().any(|byte| NAME_SEPARATORS.contains(byte))
}

/// A size column value (a whole, non-negative number from the OS) as bytes.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "sizes come from an i64 the OS reported; anything else is treated as zero"
)]
pub(crate) fn whole_bytes(size: f64) -> u64 {
    if size.is_finite() && size >= 0.0 {
        size as u64
    } else {
        0
    }
}

#[cfg(unix)]
pub(crate) fn child_path(dir: &Path, name: &[u8]) -> PathBuf {
    use std::os::unix::ffi::OsStrExt;
    dir.join(OsStr::from_bytes(name))
}

#[cfg(not(unix))]
pub(crate) fn child_path(dir: &Path, name: &[u8]) -> PathBuf {
    dir.join(&*String::from_utf8_lossy(name))
}

/// The root's own name: its last component, or the whole path when it has none.
fn root_name(root: &Path) -> Cow<'_, [u8]> {
    os_bytes(root.file_name().unwrap_or(root.as_os_str()))
}

/// [`root_name`] as it is stored: valid UTF-8.
fn stored_root_name(root: &Path) -> Vec<u8> {
    let mut out = Vec::new();
    push_stored(&mut out, &root_name(root));
    out
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

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ceiling_fault_names_the_most_entries_the_ceiling_allows() {
        assert_eq!(ceiling_fault(u32::MAX), ID_CEILING_FAULT);
        assert_eq!(ceiling_fault(10), "the walk exceeded 9 entries");
        assert_eq!(ceiling_fault(1_235), "the walk exceeded 1,234 entries");
        assert_eq!(
            ceiling_fault(1_000_001),
            "the walk exceeded 1,000,000 entries"
        );
    }

    #[test]
    fn panic_text_reads_string_and_str_payloads() {
        let formatted: Box<dyn Any + Send> = Box::new(String::from("formatted"));
        let literal: Box<dyn Any + Send> = Box::new("literal");
        let other: Box<dyn Any + Send> = Box::new(7_u8);
        assert_eq!(panic_text(&*formatted), "formatted");
        assert_eq!(panic_text(&*literal), "literal");
        assert_eq!(panic_text(&*other), "no message");
    }

    #[test]
    fn a_name_is_a_path_when_it_holds_a_separator() {
        assert!(name_is_a_path(b"evil/.."));
        assert!(name_is_a_path(b"/"));
        assert!(!name_is_a_path(b"plain"));
        assert!(!name_is_a_path(b".."));
        if cfg!(windows) {
            assert!(name_is_a_path(b"evil\\.."));
        } else {
            assert!(!name_is_a_path(b"evil\\.."));
        }
    }
}

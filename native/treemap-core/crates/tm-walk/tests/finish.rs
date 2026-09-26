//! A sink's `finish` (Phase 4, T8a; design §S.1.5) and the walk that keeps no
//! columns of its own. A walk that ends with an output calls `finish` on every
//! sink, in order, on its driver thread, once every worker has stopped and
//! before it reports done: the memory sink seals its store there, so the seal
//! sees a cancel and moves the heartbeat as the rest of the walk does (RISKS
//! R90). A cancel or a failure while a sink finishes ends the walk without an
//! output, and every sink is aborted. With `collect` off the walk's own
//! collector is gone: `take()` gives the stats and no columns, and the sinks
//! hold the walk. Every test counts; a wait is a hang guard only.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use tm_walk::platform::{ListBuffer, Lister, Meta};
use tm_walk::walk::Pacer;
use tm_walk::{
    Block, FastPath, Finishing, KIND_DIR, KIND_FILE, ListingSink, Numbering, Refusal, WalkError,
    WalkHandle, WalkOptions, WalkOutput, start_with_sinks,
};

type TestResult = Result<(), String>;

/// How long a hang guard waits before a test fails instead of hanging.
const SETTLE: Duration = Duration::from_secs(20);
const POLL: Duration = Duration::from_millis(2);
/// Folders under the root, and files in each.
const FOLDERS: u32 = 12;
const FILES: u32 = 5;
/// Every row but the root's.
const ENTRIES: u64 = (FOLDERS * (FILES + 1)) as u64;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Polls `condition` until it holds or `SETTLE` passes: a hang guard.
fn wait_until(mut condition: impl FnMut() -> bool) -> bool {
    let started = Instant::now();
    while started.elapsed() < SETTLE {
        if condition() {
            return true;
        }
        thread::sleep(POLL);
    }
    condition()
}

// ---------------------------------------------------------------------------
// A scripted file system
// ---------------------------------------------------------------------------

fn dir_meta(ino: u128) -> Meta {
    Meta {
        kind: KIND_DIR,
        flags: 0,
        size: 0.0,
        alloc: 0.0,
        mtime_ms: 1_700_000_000_000.5,
        atime_ms: f64::NAN,
        dev: 7.0,
        ino,
        nlink: 2,
        withheld: false,
    }
}

fn file_meta(ino: u128) -> Meta {
    Meta {
        kind: KIND_FILE,
        size: 1.0,
        alloc: 4_096.0,
        nlink: 1,
        ..dir_meta(ino)
    }
}

/// `FOLDERS` folders of `FILES` files each under `/t8a`, listed sorted by name.
struct Tree {
    root: PathBuf,
    folders: HashMap<PathBuf, Vec<(Vec<u8>, Meta)>>,
    /// Refuses the root at the start when set.
    refuse_root: bool,
}

impl Tree {
    fn new() -> Self {
        let root = PathBuf::from("/t8a");
        let mut folders = HashMap::new();
        let mut top = Vec::new();
        let mut ino = 100;
        for d in 0..FOLDERS {
            ino += 1;
            let name = format!("d{d:02}");
            top.push((name.clone().into_bytes(), dir_meta(ino)));
            let mut files = Vec::new();
            for f in 0..FILES {
                ino += 1;
                files.push((format!("f{f}.bin").into_bytes(), file_meta(ino)));
            }
            folders.insert(root.join(&name), files);
        }
        folders.insert(root.clone(), top);
        Self {
            root,
            folders,
            refuse_root: false,
        }
    }
}

impl Lister for Tree {
    fn stat_dir(&self, _path: &Path, _want_atime: bool) -> Result<Meta, Refusal> {
        if self.refuse_root {
            return Err(Refusal::Denied);
        }
        Ok(dir_meta(1))
    }

    fn list(
        &self,
        dir: &Path,
        _want_atime: bool,
        buf: &mut ListBuffer,
    ) -> Result<FastPath, Refusal> {
        buf.listing.clear();
        let entries = self.folders.get(dir).ok_or(Refusal::Vanished)?;
        for (name, meta) in entries {
            buf.listing.push(name, *meta);
        }
        buf.listing.sort_by_name();
        Ok(FastPath::Bulk)
    }
}

/// A pacer that allows two workers and never waits.
struct Two;

impl Pacer for Two {
    fn on_worker_start(&self) {}
    fn throttle(&self, _cancelled: &dyn Fn() -> bool) {}
    fn worker_limit(&self) -> u32 {
        2
    }
}

fn options(tree: &Tree) -> WalkOptions {
    let mut opts = WalkOptions::new(tree.root.clone());
    opts.numbering = Numbering::Blocks;
    opts.max_workers = 2;
    opts
}

fn start(
    tree: Tree,
    opts: WalkOptions,
    sinks: Vec<Arc<dyn ListingSink>>,
) -> Result<WalkHandle, WalkError> {
    start_with_sinks(opts, Arc::new(Two), Arc::new(tree), sinks)
}

/// `take()` on a helper thread, bounded: a walk that never ends fails the test.
fn take_within(handle: WalkHandle) -> Result<Result<WalkOutput, WalkError>, String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(handle.take());
    });
    rx.recv_timeout(SETTLE)
        .map_err(|_| "take() did not return".to_owned())
}

// ---------------------------------------------------------------------------
// A sink that finishes as each test scripts it
// ---------------------------------------------------------------------------

/// What `finish` does, beyond recording what it saw.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Script {
    /// Records, and returns at once.
    Record,
    /// Records, then holds until the test releases it.
    Hold,
    /// Records, then holds until the walk is cancelled, beating meanwhile.
    UntilCancelled,
    /// Records, holds, beats `BEATS` times, holds again.
    Beat,
    /// Records, and fails.
    Fail,
}

/// Heartbeats a `Script::Beat` sink adds.
const BEATS: u64 = 1_000;
/// The reason a `Script::Fail` sink gives.
const FAILURE: &str = "the store would not seal";

/// What a sink's `finish` saw.
#[derive(Clone, Debug, PartialEq)]
struct Seen {
    thread: Option<String>,
    root: PathBuf,
    want_atime: bool,
    entries: u64,
    root_is_a_folder: bool,
}

struct Scripted {
    script: Script,
    rows: AtomicU64,
    finishes: AtomicU32,
    aborts: AtomicU32,
    seen: Mutex<Option<Seen>>,
    /// Set when `finish` holds (the first hold of a `Beat`).
    reached: AtomicBool,
    /// Lets a held `finish` go on.
    release: AtomicBool,
    /// Set when a `Beat` sink has beaten and holds again.
    beaten: AtomicBool,
    /// Lets a `Beat` sink's second hold go on.
    release_again: AtomicBool,
}

impl Scripted {
    fn new(script: Script) -> Arc<Self> {
        Arc::new(Self {
            script,
            rows: AtomicU64::new(0),
            finishes: AtomicU32::new(0),
            aborts: AtomicU32::new(0),
            seen: Mutex::new(None),
            reached: AtomicBool::new(false),
            release: AtomicBool::new(false),
            beaten: AtomicBool::new(false),
            release_again: AtomicBool::new(false),
        })
    }
}

impl ListingSink for Scripted {
    fn root(&self, _name: &[u8], _meta: &Meta) {}

    fn commit(&self, block: &Block<'_>) {
        self.rows
            .fetch_add(block.rows.len() as u64, Ordering::SeqCst);
    }

    fn refused(&self, _folder: u32, _why: Refusal) {}

    fn abort(&self) {
        self.aborts.fetch_add(1, Ordering::SeqCst);
    }

    fn finish(&self, ending: &Finishing<'_>) -> Result<(), String> {
        self.finishes.fetch_add(1, Ordering::SeqCst);
        *lock(&self.seen) = Some(Seen {
            thread: thread::current().name().map(str::to_owned),
            root: ending.root().to_path_buf(),
            want_atime: ending.want_atime(),
            entries: ending.stats().entries,
            root_is_a_folder: ending
                .lister()
                .stat_dir(ending.root(), ending.want_atime())
                .is_ok_and(|meta| meta.kind == KIND_DIR),
        });
        match self.script {
            Script::Record => Ok(()),
            Script::Hold => {
                self.reached.store(true, Ordering::SeqCst);
                wait_until(|| self.release.load(Ordering::SeqCst));
                Ok(())
            }
            Script::UntilCancelled => {
                self.reached.store(true, Ordering::SeqCst);
                wait_until(|| {
                    ending.beat();
                    ending.cancelled()
                });
                Ok(())
            }
            Script::Beat => {
                self.reached.store(true, Ordering::SeqCst);
                wait_until(|| self.release.load(Ordering::SeqCst));
                for _ in 0..BEATS {
                    ending.beat();
                }
                self.beaten.store(true, Ordering::SeqCst);
                wait_until(|| self.release_again.load(Ordering::SeqCst));
                Ok(())
            }
            Script::Fail => Err(FAILURE.to_owned()),
        }
    }
}

// ---------------------------------------------------------------------------
// When `finish` comes, and what it sees
// ---------------------------------------------------------------------------

#[test]
fn a_sink_finishes_once_on_the_driver_thread_before_the_walk_reports_done() -> TestResult {
    let tree = Tree::new();
    let mut opts = options(&tree);
    opts.want_atime = true;
    let sink = Scripted::new(Script::Hold);
    let handle = start(tree, opts, vec![sink.clone()]).map_err(|e| e.to_string())?;
    if !wait_until(|| sink.reached.load(Ordering::SeqCst)) {
        return Err("finish was never called".to_owned());
    }
    assert!(
        !handle.progress().done,
        "the walk reported done while a sink was finishing"
    );
    sink.release.store(true, Ordering::SeqCst);
    let out = take_within(handle)?.map_err(|e| e.to_string())?;
    assert_eq!(sink.finishes.load(Ordering::SeqCst), 1, "finished once");
    assert_eq!(sink.aborts.load(Ordering::SeqCst), 0, "never aborted");
    let seen = lock(&sink.seen).clone().ok_or("finish saw nothing")?;
    assert_eq!(
        seen,
        Seen {
            thread: Some("tm-walk-driver".to_owned()),
            root: PathBuf::from("/t8a"),
            want_atime: true,
            entries: ENTRIES,
            root_is_a_folder: true,
        }
    );
    assert_eq!(out.stats.entries, ENTRIES);
    Ok(())
}

#[test]
fn a_walk_that_ends_without_an_output_finishes_no_sink() {
    let mut tree = Tree::new();
    tree.refuse_root = true;
    let opts = options(&tree);
    let sink = Scripted::new(Script::Record);
    let started = start(tree, opts, vec![sink.clone()]);
    assert!(
        matches!(started, Err(WalkError::RootRefused(Refusal::Denied))),
        "the root is refused"
    );
    assert_eq!(sink.finishes.load(Ordering::SeqCst), 0);
    assert_eq!(sink.aborts.load(Ordering::SeqCst), 1);
}

// ---------------------------------------------------------------------------
// A cancel or a failure while a sink finishes
// ---------------------------------------------------------------------------

#[test]
fn a_cancel_while_a_sink_finishes_ends_the_walk_cancelled_and_aborts_every_sink() -> TestResult {
    let tree = Tree::new();
    let opts = options(&tree);
    let holding = Scripted::new(Script::UntilCancelled);
    let after = Scripted::new(Script::Record);
    let handle =
        start(tree, opts, vec![holding.clone(), after.clone()]).map_err(|e| e.to_string())?;
    if !wait_until(|| holding.reached.load(Ordering::SeqCst)) {
        return Err("finish was never called".to_owned());
    }
    handle.cancel();
    let taken = take_within(handle)?;
    assert!(
        matches!(taken, Err(WalkError::Cancelled)),
        "a walk cancelled while a sink finishes is cancelled: {:?}",
        taken.map(|out| out.len())
    );
    assert_eq!(
        after.finishes.load(Ordering::SeqCst),
        0,
        "no sink finishes after the cancel"
    );
    for sink in [&holding, &after] {
        assert_eq!(sink.aborts.load(Ordering::SeqCst), 1, "aborted once");
    }
    Ok(())
}

#[test]
fn a_sink_whose_finish_fails_ends_the_walk_with_its_reason() -> TestResult {
    let tree = Tree::new();
    let opts = options(&tree);
    let failing = Scripted::new(Script::Fail);
    let after = Scripted::new(Script::Record);
    let handle =
        start(tree, opts, vec![failing.clone(), after.clone()]).map_err(|e| e.to_string())?;
    match take_within(handle)? {
        Err(WalkError::Internal(why)) if why == FAILURE => {}
        other => {
            return Err(format!(
                "the failure's own reason: {:?}",
                other.map(|out| out.len())
            ));
        }
    }
    assert_eq!(after.finishes.load(Ordering::SeqCst), 0);
    for sink in [&failing, &after] {
        assert_eq!(sink.aborts.load(Ordering::SeqCst), 1, "aborted once");
    }
    Ok(())
}

#[test]
fn a_finishing_sink_moves_the_heartbeat() -> TestResult {
    let tree = Tree::new();
    let opts = options(&tree);
    let sink = Scripted::new(Script::Beat);
    let handle = start(tree, opts, vec![sink.clone()]).map_err(|e| e.to_string())?;
    if !wait_until(|| sink.reached.load(Ordering::SeqCst)) {
        return Err("finish was never called".to_owned());
    }
    // Every worker has stopped, so only the finishing sink moves it now.
    let before = handle.progress().heartbeat;
    sink.release.store(true, Ordering::SeqCst);
    if !wait_until(|| sink.beaten.load(Ordering::SeqCst)) {
        return Err("the sink never beat".to_owned());
    }
    let after = handle.progress().heartbeat;
    assert_eq!(after - before, BEATS, "each beat moves the heartbeat once");
    sink.release_again.store(true, Ordering::SeqCst);
    take_within(handle)?.map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// A walk that keeps no columns of its own
// ---------------------------------------------------------------------------

#[test]
fn a_walk_that_collects_nothing_takes_the_stats_and_no_columns() -> TestResult {
    let tree = Tree::new();
    let mut opts = options(&tree);
    opts.collect = false;
    let sink = Scripted::new(Script::Record);
    let handle = start(tree, opts, vec![sink.clone()]).map_err(|e| e.to_string())?;
    let out = take_within(handle)?.map_err(|e| e.to_string())?;
    assert!(out.is_empty(), "no columns: {} rows", out.len());
    assert_eq!(out.stats.entries, ENTRIES, "the stats are the walk's");
    assert_eq!(
        sink.rows.load(Ordering::SeqCst),
        ENTRIES,
        "the sink took every row"
    );
    assert_eq!(sink.finishes.load(Ordering::SeqCst), 1);
    Ok(())
}

#[test]
fn a_block_walk_that_collects_nothing_and_has_no_sink_is_refused() -> TestResult {
    let tree = Tree::new();
    let mut opts = options(&tree);
    opts.collect = false;
    match start(tree, opts, Vec::new()) {
        Err(WalkError::OptionsRefused(why)) => {
            assert!(why.contains("collect"), "{why}");
            Ok(())
        }
        Err(other) => Err(format!("refused for another reason: {other}")),
        Ok(_) => Err("a walk that keeps nothing started".to_owned()),
    }
}

//! The walk's behavioural contract, one test per line of it.
//!
//! Two kinds of test live here. The scripted ones drive the walk core through a
//! fake `Lister` and a fake `Pacer` and run on every platform: they prove the
//! queue, the ids, the refusal accounting, pause, cancel, the governor hooks and
//! the `RETURNED_ATTRS` rule without touching a disk. The live ones (macOS only)
//! build a fixture under `std::env::temp_dir()`, walk it with the real listing
//! and a real governor, and check the facts the legacy walker would record.

use std::collections::{HashMap, VecDeque};
use std::panic::panic_any;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use tm_walk::climb::{START_WORKERS, start_for};
use tm_walk::platform::{DirTimes, ListBuffer, Lister, Meta, performance_cores};
use tm_walk::walk::{GovernorPacer, Pacer};
use tm_walk::{
    DirRefusal, FLAG_REFUSED_DIR, FastPath, KIND_DIR, KIND_FILE, Refusal, WalkError, WalkHandle,
    WalkOptions, WalkOutput, start_with,
};

/// What the contract allows a cancel or a pause to take.
const REACT_WITHIN: Duration = Duration::from_millis(200);
/// How long a test waits for a walk to report `done` before giving up.
const SETTLE: Duration = Duration::from_secs(10);
/// Polling interval while waiting.
const POLL: Duration = Duration::from_millis(5);

type TestResult = Result<(), String>;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

fn dir_meta() -> Meta {
    Meta {
        kind: KIND_DIR,
        flags: 0,
        size: 0.0,
        alloc: 0.0,
        mtime_ms: 1_700_000_000_000.5,
        atime_ms: f64::NAN,
        dev: 16_777_234.0,
        ino: 1.0,
        nlink: 2,
        withheld: false,
    }
}

fn file_meta(size: f64, ino: f64, nlink: u32) -> Meta {
    Meta {
        kind: KIND_FILE,
        flags: 0,
        size,
        alloc: size,
        mtime_ms: 1_700_000_000_001.25,
        atime_ms: f64::NAN,
        dev: 16_777_234.0,
        ino,
        nlink,
        withheld: false,
    }
}

type FakeListing = Result<Vec<(Vec<u8>, Meta)>, Refusal>;

/// What the fake does for one particular directory before it answers.
#[derive(Clone)]
enum Special {
    /// Panics with this message (a `String` payload) instead of answering.
    Panic(String),
    /// Sleeps this long first, whatever the walk's signals say: the shape of
    /// a listing loop that does not read them.
    Sleep(Duration),
    /// Answers after `batches` batches `each` apart, beating after every
    /// batch and returning `Unreadable` as soon as the stop flag is set: the
    /// shape of a platform loop that honours the walk's signals.
    Batches { batches: u32, each: Duration },
}

/// A scripted tree: every directory's listing (or its refusal), a per-listing
/// delay, what happens before particular directories answer, the answers
/// `stat_dir` gives for the root, and counters the tests read.
struct FakeTree {
    root: PathBuf,
    dirs: HashMap<PathBuf, FakeListing>,
    specials: HashMap<PathBuf, Special>,
    root_stats: Mutex<VecDeque<Result<Meta, Refusal>>>,
    /// Panics with the message on this (zero-based) `stat_dir` call.
    stat_panic: Option<(u64, String)>,
    delay: Duration,
    fast_path: FastPath,
    next_ino: f64,
    /// Every path `list` was asked for, in call order.
    listed: Mutex<Vec<PathBuf>>,
    list_calls: AtomicU64,
    stat_calls: AtomicU64,
    in_flight: AtomicU32,
    peak_in_flight: AtomicU32,
    /// The times a directory's own listing reports for the directory itself.
    own_times: HashMap<PathBuf, DirTimes>,
    /// What `stat_dir` says about a particular file (a hard-link family's,
    /// read from the file itself); any other path gets the root's answers.
    file_stats: HashMap<PathBuf, Meta>,
    /// Every path `stat_dir` answered from `file_stats`, in call order.
    file_stat_paths: Mutex<Vec<PathBuf>>,
}

impl FakeTree {
    fn new(root: &str) -> Self {
        let root = PathBuf::from(root);
        let mut dirs = HashMap::new();
        dirs.insert(root.clone(), Ok(Vec::new()));
        Self {
            root,
            dirs,
            specials: HashMap::new(),
            root_stats: Mutex::new(VecDeque::from([Ok(dir_meta())])),
            stat_panic: None,
            delay: Duration::ZERO,
            fast_path: FastPath::Bulk,
            next_ino: 1_000.0,
            listed: Mutex::new(Vec::new()),
            list_calls: AtomicU64::new(0),
            stat_calls: AtomicU64::new(0),
            in_flight: AtomicU32::new(0),
            peak_in_flight: AtomicU32::new(0),
            own_times: HashMap::new(),
            file_stats: HashMap::new(),
            file_stat_paths: Mutex::new(Vec::new()),
        }
    }

    /// Scripts the times the listing of `rel` reports for the directory itself.
    fn own_times(&mut self, rel: &str, times: DirTimes) {
        let path = self.abs(rel);
        self.own_times.insert(path, times);
    }

    fn with_delay(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }

    fn with_fast_path(mut self, fast_path: FastPath) -> Self {
        self.fast_path = fast_path;
        self
    }

    /// Scripts one more answer for `stat_dir(root)`; the last answer repeats.
    fn root_stat_then(self, answer: Result<Meta, Refusal>) -> Self {
        self.root_stats
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push_back(answer);
        self
    }

    /// Scripts a panic with `message` on the `call`-th (zero-based) `stat_dir`:
    /// call 0 is the check at start, call 1 the driver's re-check at the end.
    fn stat_panic_on(mut self, call: u64, message: &str) -> Self {
        self.stat_panic = Some((call, message.to_owned()));
        self
    }

    /// Scripts what happens when `rel` is listed, before the fake answers.
    fn special(&mut self, rel: &str, special: Special) {
        let abs = self.abs(rel);
        self.specials.insert(abs, special);
    }

    /// Every path `list` was asked for so far.
    fn listed_paths(&self) -> Vec<PathBuf> {
        self.listed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Listings in progress right now.
    fn in_flight(&self) -> u32 {
        self.in_flight.load(Ordering::SeqCst)
    }

    /// The listing itself, once the call has been counted: the scripted wait,
    /// the per-listing delay, then the entries.
    fn answer(&self, dir: &Path, buf: &mut ListBuffer) -> Result<FastPath, Refusal> {
        match self.specials.get(dir) {
            Some(Special::Sleep(for_how_long)) => thread::sleep(*for_how_long),
            Some(Special::Batches { batches, each }) => {
                for _ in 0..*batches {
                    thread::sleep(*each);
                    buf.beat();
                    if buf.stopped() {
                        return Err(Refusal::Unreadable);
                    }
                }
            }
            Some(Special::Panic(_)) | None => {}
        }
        if !self.delay.is_zero() {
            thread::sleep(self.delay);
        }
        match self.dirs.get(dir) {
            Some(Ok(entries)) => {
                buf.listing.clear();
                for (name, meta) in entries {
                    buf.listing.push(name, *meta);
                }
                Ok(self.fast_path)
            }
            Some(Err(why)) => Err(*why),
            None => Err(Refusal::Vanished),
        }
    }

    fn abs(&self, rel: &str) -> PathBuf {
        if rel.is_empty() {
            self.root.clone()
        } else {
            self.root.join(rel)
        }
    }

    fn add_entry(&mut self, parent_rel: &str, name: &[u8], meta: Meta) {
        let parent = self.abs(parent_rel);
        if let Some(Ok(entries)) = self.dirs.get_mut(&parent) {
            entries.push((name.to_vec(), meta));
        }
    }

    fn add_file(&mut self, parent_rel: &str, name: &str, size: f64) {
        self.next_ino += 1.0;
        let ino = self.next_ino;
        self.add_entry(parent_rel, name.as_bytes(), file_meta(size, ino, 1));
    }

    /// Adds `name` under `parent_rel` as a directory with an empty listing and
    /// returns its relative path.
    fn add_dir(&mut self, parent_rel: &str, name: &str) -> String {
        let rel = if parent_rel.is_empty() {
            name.to_owned()
        } else {
            format!("{parent_rel}/{name}")
        };
        self.add_entry(parent_rel, name.as_bytes(), dir_meta());
        let abs = self.abs(&rel);
        self.dirs.insert(abs, Ok(Vec::new()));
        rel
    }

    fn refuse_dir(&mut self, rel: &str, why: Refusal) {
        let abs = self.abs(rel);
        self.dirs.insert(abs, Err(why));
    }

    fn calls(&self) -> u64 {
        self.list_calls.load(Ordering::SeqCst)
    }

    fn peak(&self) -> u32 {
        self.peak_in_flight.load(Ordering::SeqCst)
    }
}

impl Lister for FakeTree {
    #[expect(
        clippy::panic,
        reason = "the fake panics on purpose: the walk under test must survive it"
    )]
    fn stat_dir(&self, path: &Path, _want_atime: bool) -> Result<Meta, Refusal> {
        if let Some(meta) = self.file_stats.get(path) {
            self.file_stat_paths
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(path.to_path_buf());
            return Ok(*meta);
        }
        let call = self.stat_calls.fetch_add(1, Ordering::SeqCst);
        if let Some((_, message)) = self.stat_panic.as_ref().filter(|(at, _)| *at == call) {
            panic_any(message.clone());
        }
        let mut answers = self
            .root_stats
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if answers.len() > 1 {
            answers.pop_front().unwrap_or(Ok(dir_meta()))
        } else {
            answers.front().copied().unwrap_or(Ok(dir_meta()))
        }
    }

    #[expect(
        clippy::panic,
        reason = "the fake panics on purpose: the walk under test must survive it"
    )]
    fn list(
        &self,
        dir: &Path,
        _want_atime: bool,
        buf: &mut ListBuffer,
    ) -> Result<FastPath, Refusal> {
        self.list_calls.fetch_add(1, Ordering::SeqCst);
        self.listed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(dir.to_path_buf());
        if let Some(Special::Panic(message)) = self.specials.get(dir) {
            panic_any(message.clone());
        }
        let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak_in_flight.fetch_max(now, Ordering::SeqCst);
        let result = self.answer(dir, buf);
        if result.is_ok() {
            buf.listing.own_times = self.own_times.get(dir).copied();
        }
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        result
    }
}

/// A governor stand-in: a settable worker limit and call counters.
struct FakePacer {
    limit: AtomicU32,
    throttles: AtomicU64,
    starts: AtomicU64,
    /// Panics with the message when the worker thread of this name starts.
    start_panic: Option<(String, String)>,
    /// What `start_workers()` answers; `None` keeps the trait's default.
    start: Option<u32>,
}

impl FakePacer {
    fn new(limit: u32) -> Arc<Self> {
        Arc::new(Self {
            limit: AtomicU32::new(limit),
            throttles: AtomicU64::new(0),
            starts: AtomicU64::new(0),
            start_panic: None,
            start: None,
        })
    }

    /// A pacer that asks a climbing walk to start at `start` workers.
    fn starting_at(limit: u32, start: u32) -> Arc<Self> {
        Arc::new(Self {
            limit: AtomicU32::new(limit),
            throttles: AtomicU64::new(0),
            starts: AtomicU64::new(0),
            start_panic: None,
            start: Some(start),
        })
    }

    /// A pacer whose `on_worker_start` panics with `message` on the worker
    /// thread named `thread` (the walk names them `tm-walk-worker-<index>`).
    fn panicking_at_start(limit: u32, thread: &str, message: &str) -> Arc<Self> {
        Arc::new(Self {
            limit: AtomicU32::new(limit),
            throttles: AtomicU64::new(0),
            starts: AtomicU64::new(0),
            start_panic: Some((thread.to_owned(), message.to_owned())),
            start: None,
        })
    }
}

impl Pacer for FakePacer {
    #[expect(
        clippy::panic,
        reason = "the fake panics on purpose: the walk under test must survive it"
    )]
    fn on_worker_start(&self) {
        self.starts.fetch_add(1, Ordering::SeqCst);
        let here = thread::current();
        if let Some((_, message)) = self
            .start_panic
            .as_ref()
            .filter(|(name, _)| here.name() == Some(name.as_str()))
        {
            panic_any(message.clone());
        }
    }

    fn throttle(&self, _cancelled: &dyn Fn() -> bool) {
        self.throttles.fetch_add(1, Ordering::SeqCst);
    }

    fn worker_limit(&self) -> u32 {
        self.limit.load(Ordering::SeqCst)
    }

    fn start_workers(&self) -> u32 {
        self.start.unwrap_or(START_WORKERS)
    }
}

/// A wide scripted tree: `dirs` directories under the root, `files` files each.
fn wide_tree(dirs: u32, files: u32, delay: Duration) -> FakeTree {
    let mut tree = FakeTree::new("/fake").with_delay(delay);
    for d in 0..dirs {
        let rel = tree.add_dir("", &format!("d{d}"));
        for f in 0..files {
            tree.add_file(&rel, &format!("f{f}.bin"), f64::from(f));
        }
    }
    tree
}

fn options(root: &Path) -> WalkOptions {
    WalkOptions::new(root)
}

fn run(
    tree: FakeTree,
    opts: WalkOptions,
    limit: u32,
) -> Result<(Arc<FakeTree>, WalkOutput), String> {
    let tree = Arc::new(tree);
    let pacer = FakePacer::new(limit);
    let handle = start_with(opts, pacer, tree.clone()).map_err(|e| e.to_string())?;
    let out = handle.take().map_err(|e| e.to_string())?;
    Ok((tree, out))
}

/// Relative paths of every node, built from the parent column; also checks the
/// `parent[i] < i` invariant on the way.
fn rel_paths(out: &WalkOutput) -> Result<Vec<String>, String> {
    let mut paths: Vec<String> = Vec::with_capacity(out.len());
    for i in 0..out.len() {
        let name = out.name(i).ok_or_else(|| format!("node {i} has no name"))?;
        let name = String::from_utf8_lossy(name);
        if i == 0 {
            paths.push(String::new());
            continue;
        }
        let parent = *out
            .parent
            .get(i)
            .ok_or_else(|| format!("node {i} has no parent"))? as usize;
        if parent >= i {
            return Err(format!("parent[{i}] = {parent} is not smaller than {i}"));
        }
        let parent_path = paths
            .get(parent)
            .ok_or_else(|| format!("parent {parent} unknown"))?;
        paths.push(if parent_path.is_empty() {
            name.into_owned()
        } else {
            format!("{parent_path}/{name}")
        });
    }
    Ok(paths)
}

fn index_by_path(out: &WalkOutput) -> Result<HashMap<String, usize>, String> {
    Ok(rel_paths(out)?
        .into_iter()
        .enumerate()
        .map(|(i, p)| (p, i))
        .collect())
}

fn node<'a>(
    index: &HashMap<String, usize>,
    out: &'a WalkOutput,
    rel: &str,
) -> Result<Node<'a>, String> {
    let i = *index
        .get(rel)
        .ok_or_else(|| format!("no node at {rel:?}"))?;
    Ok(Node { out, i })
}

struct Node<'a> {
    out: &'a WalkOutput,
    i: usize,
}

impl Node<'_> {
    fn id(&self) -> u32 {
        u32::try_from(self.i).unwrap_or(u32::MAX)
    }
    fn kind(&self) -> u8 {
        self.out.kind.get(self.i).copied().unwrap_or(u8::MAX)
    }
    fn flags(&self) -> u8 {
        self.out.flags.get(self.i).copied().unwrap_or(u8::MAX)
    }
    fn size(&self) -> f64 {
        self.out.size.get(self.i).copied().unwrap_or(f64::NAN)
    }
    fn alloc(&self) -> f64 {
        self.out
            .alloc_bytes
            .get(self.i)
            .copied()
            .unwrap_or(f64::NAN)
    }
    fn mtime(&self) -> f64 {
        self.out.mtime_ms.get(self.i).copied().unwrap_or(f64::NAN)
    }
    fn atime(&self) -> f64 {
        self.out.atime_ms.get(self.i).copied().unwrap_or(f64::NAN)
    }
    fn children(&self) -> usize {
        self.out
            .parent
            .iter()
            .skip(1)
            .filter(|p| **p as usize == self.i)
            .count()
    }
}

fn wait_until(deadline: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let started = Instant::now();
    while started.elapsed() < deadline {
        if condition() {
            return true;
        }
        thread::sleep(POLL);
    }
    condition()
}

fn wait_done(handle: &WalkHandle) -> TestResult {
    if wait_until(SETTLE, || handle.progress().done) {
        Ok(())
    } else {
        Err("the walk did not finish in time".to_owned())
    }
}

/// `take()` on a helper thread, waited for at most `within`: a walk that
/// never ends fails the test instead of hanging it.
fn take_within(
    handle: WalkHandle,
    within: Duration,
) -> Result<Result<WalkOutput, WalkError>, String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(handle.take());
    });
    rx.recv_timeout(within)
        .map_err(|_| format!("take() did not return within {within:?}"))
}

// ---------------------------------------------------------------------------
// Scripted tests: every platform
// ---------------------------------------------------------------------------

#[test]
fn ids_come_from_discovery_so_every_parent_precedes_its_children() -> TestResult {
    let tree = wide_tree(30, 20, Duration::ZERO);
    let (_, out) = run(tree, options(Path::new("/fake")), 4)?;
    assert_eq!(out.len(), 1 + 30 + 30 * 20);
    assert_eq!(
        out.parent.first().copied(),
        Some(0),
        "the root is its own parent"
    );
    let paths = rel_paths(&out)?; // fails on any parent[i] >= i
    assert_eq!(paths.len(), out.len());
    assert_eq!(
        out.name_off.len(),
        out.len() + 1,
        "name_off has len + 1 entries"
    );
    assert_eq!(out.stats.entries, 30 + 30 * 20);
    assert_eq!(out.stats.dirs_listed, 31);
    Ok(())
}

#[test]
fn throttles_once_per_directory_and_never_exceeds_the_worker_limit() -> TestResult {
    let limit = 2;
    let tree = Arc::new(wide_tree(40, 5, Duration::from_millis(5)));
    let pacer = FakePacer::new(limit);
    let handle = start_with(options(Path::new("/fake")), pacer.clone(), tree.clone())
        .map_err(|e| e.to_string())?;
    let out = handle.take().map_err(|e| e.to_string())?;
    assert_eq!(out.stats.dirs_listed, 41);
    assert_eq!(
        pacer.throttles.load(Ordering::SeqCst),
        41,
        "throttle() is called after every directory, the root included"
    );
    assert!(
        tree.peak() <= limit,
        "listings in flight peaked at {} with a limit of {limit}",
        tree.peak()
    );
    assert!(tree.peak() >= 1);
    assert!(
        pacer.starts.load(Ordering::SeqCst) <= u64::from(limit),
        "no more worker threads than the limit allows"
    );
    assert!(out.stats.workers_peak <= limit);
    Ok(())
}

#[test]
fn a_fixed_worker_count_disables_the_climber() -> TestResult {
    let tree = Arc::new(wide_tree(20, 5, Duration::from_millis(2)));
    let pacer = FakePacer::new(8);
    let mut opts = options(Path::new("/fake"));
    opts.max_workers = 1;
    let handle = start_with(opts, pacer, tree.clone()).map_err(|e| e.to_string())?;
    let out = handle.take().map_err(|e| e.to_string())?;
    assert_eq!(tree.peak(), 1, "one worker, exactly");
    assert_eq!(out.stats.climb_steps, 0);
    assert_eq!(out.stats.workers_peak, 1);
    Ok(())
}

#[test]
fn the_governor_limit_caps_a_fixed_worker_count() -> TestResult {
    let limit = 2;
    let tree = Arc::new(wide_tree(40, 5, Duration::from_millis(5)));
    let pacer = FakePacer::new(limit);
    let mut opts = options(Path::new("/fake"));
    opts.max_workers = 4;
    let handle = start_with(opts, pacer.clone(), tree.clone()).map_err(|e| e.to_string())?;
    let out = handle.take().map_err(|e| e.to_string())?;
    assert!(
        tree.peak() <= limit,
        "peak {} with a limit of {limit}",
        tree.peak()
    );
    assert!(
        pacer.starts.load(Ordering::SeqCst) <= u64::from(limit),
        "no more threads than the limit, whatever max_workers asks: {}",
        pacer.starts.load(Ordering::SeqCst)
    );
    assert_eq!(out.stats.climb_steps, 0);
    Ok(())
}

#[test]
fn a_worker_limit_of_one_runs_one_worker_even_for_the_climber() -> TestResult {
    let tree = Arc::new(wide_tree(40, 5, Duration::from_millis(5)));
    let pacer = FakePacer::new(1);
    let handle = start_with(options(Path::new("/fake")), pacer.clone(), tree.clone())
        .map_err(|e| e.to_string())?;
    let out = handle.take().map_err(|e| e.to_string())?;
    assert_eq!(
        tree.peak(),
        1,
        "the climber's two starting workers are capped at one"
    );
    assert_eq!(pacer.starts.load(Ordering::SeqCst), 1, "one thread started");
    assert_eq!(out.stats.workers_peak, 1);
    Ok(())
}

/// Sixteen directories of 20 ms each end inside the climber's first interval
/// at two workers as at four, so the peak is the start count itself.
fn short_walk_tree() -> FakeTree {
    wide_tree(16, 2, Duration::from_millis(20))
}

#[test]
fn a_climbing_walk_starts_at_the_pacers_start_count() -> TestResult {
    let tree = Arc::new(short_walk_tree());
    let pacer = FakePacer::starting_at(8, 4);
    let handle = start_with(options(Path::new("/fake")), pacer.clone(), tree.clone())
        .map_err(|e| e.to_string())?;
    let out = handle.take().map_err(|e| e.to_string())?;
    assert_eq!(tree.peak(), 4, "four listings in flight from the start");
    assert_eq!(out.stats.workers_peak, 4);
    assert_eq!(out.stats.climb_steps, 0, "the start is not a step");
    Ok(())
}

#[test]
fn an_eco_limit_caps_a_start_that_asks_for_more() -> TestResult {
    let tree = Arc::new(short_walk_tree());
    let pacer = FakePacer::starting_at(2, 4);
    let handle = start_with(options(Path::new("/fake")), pacer.clone(), tree.clone())
        .map_err(|e| e.to_string())?;
    let out = handle.take().map_err(|e| e.to_string())?;
    assert!(tree.peak() <= 2, "peak {} with a limit of 2", tree.peak());
    assert!(
        pacer.starts.load(Ordering::SeqCst) <= 2,
        "no more threads than the limit: {}",
        pacer.starts.load(Ordering::SeqCst)
    );
    assert!(out.stats.workers_peak <= 2);
    Ok(())
}

#[test]
fn the_governor_starts_turbo_at_the_performance_cores_and_nothing_else() {
    use tm_governor::{Budget, FakeSampler, FakeSignals, Governor, Preset};
    for preset in [Preset::Eco, Preset::Balanced, Preset::Turbo] {
        let governor = Arc::new(Governor::start(
            Budget {
                preset,
                cpu_percent: None,
            },
            false,
            Box::new(FakeSampler::new(8)),
            Box::new(FakeSignals::default()),
        ));
        let pacer = GovernorPacer::new(Arc::clone(&governor));
        let expected = if preset == Preset::Turbo {
            start_for(Preset::Turbo, performance_cores())
        } else {
            START_WORKERS
        };
        assert_eq!(pacer.start_workers(), expected, "{preset:?}");
    }
}

#[test]
fn a_refused_directory_is_flagged_and_the_walk_continues() -> TestResult {
    let mut tree = FakeTree::new("/fake");
    let denied = tree.add_dir("", "denied");
    tree.refuse_dir(&denied, Refusal::Denied);
    let gone = tree.add_dir("", "gone");
    tree.refuse_dir(&gone, Refusal::Vanished);
    let broken = tree.add_dir("", "broken");
    tree.refuse_dir(&broken, Refusal::Unreadable);
    let fine = tree.add_dir("", "fine");
    tree.add_file(&fine, "after.bin", 7.0);
    let (_, out) = run(tree, options(Path::new("/fake")), 2)?;
    let index = index_by_path(&out)?;
    let denied = node(&index, &out, "denied")?;
    assert_eq!(denied.kind(), KIND_DIR);
    assert_eq!(denied.flags() & FLAG_REFUSED_DIR, FLAG_REFUSED_DIR);
    assert_eq!(denied.children(), 0);
    let fine = node(&index, &out, "fine")?;
    assert_eq!(fine.flags() & FLAG_REFUSED_DIR, 0);
    assert_eq!(fine.children(), 1, "the walk continued past the refusals");
    let mut refusals = out.refusals.clone();
    refusals.sort_by_key(|r| r.node);
    let mut expected = vec![
        DirRefusal {
            node: denied.id(),
            why: Refusal::Denied,
        },
        DirRefusal {
            node: node(&index, &out, "gone")?.id(),
            why: Refusal::Vanished,
        },
        DirRefusal {
            node: node(&index, &out, "broken")?.id(),
            why: Refusal::Unreadable,
        },
    ];
    expected.sort_by_key(|r| r.node);
    assert_eq!(refusals, expected);
    assert_eq!(out.stats.dirs_listed, 2, "the root and `fine`");
    Ok(())
}

#[test]
fn never_descend_makes_a_childless_directory_node() -> TestResult {
    let mut tree = FakeTree::new("/fake");
    let mount = tree.add_dir("", "Volumes");
    tree.add_file(&mount, "inside.bin", 99.0);
    let other = tree.add_dir("", "other");
    tree.add_file(&other, "seen.bin", 1.0);
    let mut opts = options(Path::new("/fake"));
    opts.never_descend = vec![PathBuf::from("/fake").join("Volumes")];
    let (tree, out) = run(tree, opts, 2)?;
    let index = index_by_path(&out)?;
    let mount = node(&index, &out, "Volumes")?;
    assert_eq!(mount.kind(), KIND_DIR);
    assert_eq!(mount.children(), 0, "never listed, so no children");
    assert_eq!(mount.flags(), 0, "not a refusal: it was never asked");
    assert_eq!(
        mount.mtime().to_bits(),
        dir_meta().mtime_ms.to_bits(),
        "its own metadata"
    );
    assert!(index.contains_key("other/seen.bin"));
    assert!(!index.contains_key("Volumes/inside.bin"));
    assert_eq!(tree.calls(), 2, "the root and `other`, never `Volumes`");
    Ok(())
}

#[test]
fn a_withheld_attribute_keeps_the_entry_with_unknown_values_and_counts_it() -> TestResult {
    let mut tree = FakeTree::new("/fake");
    let mut withheld = file_meta(0.0, 42.0, 1);
    withheld.mtime_ms = f64::NAN;
    withheld.withheld = true;
    tree.add_entry("", b"odd.bin", withheld);
    tree.add_file("", "fine.bin", 5.0);
    let (_, out) = run(tree, options(Path::new("/fake")), 1)?;
    let index = index_by_path(&out)?;
    let odd = node(&index, &out, "odd.bin")?;
    assert_eq!(odd.size().to_bits(), 0.0_f64.to_bits());
    assert_eq!(
        odd.alloc().to_bits(),
        0.0_f64.to_bits(),
        "unknown allocation is 0"
    );
    assert!(odd.mtime().is_nan(), "unknown mtime stays NaN");
    assert!(odd.atime().is_nan(), "atime was not asked for");
    assert_eq!(out.stats.unreadable_entries, 1);
    assert_eq!(out.stats.denied_entries, 0);
    assert_eq!(out.stats.entries, 2, "the entry is kept, not dropped");
    Ok(())
}

#[test]
fn hardlink_refs_exist_only_for_shared_inodes() -> TestResult {
    let mut tree = FakeTree::new("/fake");
    tree.add_entry("", b"one.bin", file_meta(10.0, 500.0, 2));
    tree.add_entry("", b"two.bin", file_meta(10.0, 500.0, 2));
    tree.add_entry("", b"alone.bin", file_meta(10.0, 501.0, 1));
    let mut shared_dir = dir_meta();
    shared_dir.nlink = 5;
    tree.add_entry("", b"dir", shared_dir);
    tree.dirs
        .insert(PathBuf::from("/fake").join("dir"), Ok(Vec::new()));
    let (_, out) = run(tree, options(Path::new("/fake")), 1)?;
    let index = index_by_path(&out)?;
    let one = node(&index, &out, "one.bin")?.id();
    let two = node(&index, &out, "two.bin")?.id();
    let mut nodes: Vec<u32> = out.hardlinks.iter().map(|h| h.node).collect();
    nodes.sort_unstable();
    let mut expected = vec![one, two];
    expected.sort_unstable();
    assert_eq!(
        nodes, expected,
        "one ref per member, none for a lone file or a directory"
    );
    for h in &out.hardlinks {
        assert_eq!(h.ino.to_bits(), 500.0_f64.to_bits());
        assert_eq!(h.dev.to_bits(), 16_777_234.0_f64.to_bits());
    }
    Ok(())
}

#[test]
fn a_directorys_children_are_numbered_in_the_order_its_lister_hands_them_over_on_every_host()
-> TestResult {
    // The order is the lister's to decide (the POSIX listers sort as libuv
    // does; Windows' keep the file system's). The walk core never re-orders:
    // it once sorted by the host it ran on, and re-sorted the Windows-shaped
    // listing tm-mft's tests walk on macOS and Linux.
    let listed: [&[u8]; 6] = [b"b", b"a2", b"C", b"a", b"\xC3\xA4", b"a-"];
    let mut tree = FakeTree::new("/fake");
    for (name, ino) in listed.iter().zip([10.0, 11.0, 12.0, 13.0, 14.0, 15.0]) {
        tree.add_entry("", name, file_meta(1.0, ino, 1));
    }
    let (_, out) = run(tree, options(Path::new("/fake")), 1)?;
    let mut numbered: Vec<Vec<u8>> = Vec::new();
    for i in 1..out.parent.len() {
        if out.parent.get(i) == Some(&0) {
            let start = *out.name_off.get(i).ok_or("name_off")? as usize;
            let end = *out.name_off.get(i + 1).ok_or("name_off")? as usize;
            numbered.push(out.names.get(start..end).ok_or("names")?.to_vec());
        }
    }
    let expected: Vec<Vec<u8>> = listed.iter().map(|n| n.to_vec()).collect();
    assert_eq!(numbered, expected);
    Ok(())
}

#[test]
fn a_hard_link_family_found_by_file_id_takes_its_size_and_times_from_the_file_itself() -> TestResult
{
    // Windows lists each name's own copy of a file's size and times, and NTFS
    // refreshes a name's copy only when the file is opened through that name
    // (CreateHardLink's documentation), so a family whose file was changed
    // through one name lists stale values under the others, where the legacy
    // walker's lstat opens every name. The walk reads each family it finds by
    // file id once, through its first member, and every member takes that.
    let mut tree = FakeTree::new("/fake");
    tree.fast_path = FastPath::ExtdDirInfo;
    tree.add_dir("", "a");
    tree.add_dir("", "b");
    let listed = |size: f64, mtime_ms: f64| Meta {
        mtime_ms,
        ..file_meta(size, 77.0, 0)
    };
    tree.add_entry("a", b"x", listed(5.0, 1_000.0));
    tree.add_entry("b", b"y", listed(6.0, 2_000.0));
    // A file id seen once: its other names, if any, are outside the scan.
    tree.add_entry(
        "",
        b"lone",
        Meta {
            mtime_ms: 3_000.0,
            ..file_meta(3.0, 88.0, 0)
        },
    );
    let truth = Meta {
        mtime_ms: 9_000.5,
        atime_ms: 9_001.25,
        ..file_meta(42.0, 77.0, 2)
    };
    tree.file_stats
        .insert(Path::new("/fake").join("a").join("x"), truth);
    tree.file_stats
        .insert(Path::new("/fake").join("lone"), truth);
    let mut opts = options(Path::new("/fake"));
    opts.want_atime = true;
    let (tree, out) = run(tree, opts, 1)?;
    let index = index_by_path(&out)?;
    for member in ["a/x", "b/y"] {
        let i = *index.get(member).ok_or(member)?;
        assert_eq!(out.size.get(i), Some(&42.0), "{member}: the file's size");
        assert_eq!(
            out.mtime_ms.get(i),
            Some(&9_000.5),
            "{member}: the file's mtime"
        );
        assert_eq!(
            out.atime_ms.get(i),
            Some(&9_001.25),
            "{member}: the file's atime"
        );
    }
    let lone = *index.get("lone").ok_or("lone")?;
    assert_eq!(
        out.size.get(lone),
        Some(&3.0),
        "a lone id keeps what the listing said"
    );
    assert_eq!(out.mtime_ms.get(lone), Some(&3_000.0));
    assert_eq!(
        *tree
            .file_stat_paths
            .lock()
            .unwrap_or_else(PoisonError::into_inner),
        vec![Path::new("/fake").join("a").join("x")],
        "one read per family, through its first member; none for a lone id"
    );
    Ok(())
}

#[test]
fn names_are_stored_as_utf8_with_lossy_replacement() -> TestResult {
    let mut tree = FakeTree::new("/fake");
    tree.add_entry("", b"caf\xC3\xA9.txt", file_meta(1.0, 7.0, 1));
    tree.add_entry("", b"bad\xFFbyte.txt", file_meta(1.0, 8.0, 1));
    let (_, out) = run(tree, options(Path::new("/fake")), 1)?;
    assert!(
        std::str::from_utf8(&out.names).is_ok(),
        "the arena is valid UTF-8"
    );
    let index = index_by_path(&out)?;
    assert!(
        index.contains_key("café.txt"),
        "valid bytes are stored as given"
    );
    assert!(
        index.contains_key("bad\u{FFFD}byte.txt"),
        "invalid bytes become U+FFFD"
    );
    Ok(())
}

#[test]
fn a_root_that_vanishes_after_start_is_root_refused_vanished() -> TestResult {
    let mut tree = FakeTree::new("/fake");
    tree.refuse_dir("", Refusal::Vanished);
    let tree = Arc::new(tree);
    let handle = start_with(options(Path::new("/fake")), FakePacer::new(2), tree)
        .map_err(|e| e.to_string())?;
    match handle.take() {
        Err(WalkError::RootRefused(Refusal::Vanished)) => Ok(()),
        other => Err(format!("expected RootRefused(Vanished), got {other:?}")),
    }
}

#[test]
fn a_root_that_vanishes_before_the_end_is_root_refused_vanished() -> TestResult {
    let mut tree = FakeTree::new("/fake").root_stat_then(Err(Refusal::Vanished));
    tree.add_file("", "a.bin", 1.0);
    let tree = Arc::new(tree);
    let handle = start_with(options(Path::new("/fake")), FakePacer::new(2), tree)
        .map_err(|e| e.to_string())?;
    match handle.take() {
        Err(WalkError::RootRefused(Refusal::Vanished)) => Ok(()),
        other => Err(format!("expected RootRefused(Vanished), got {other:?}")),
    }
}

#[test]
fn a_root_that_is_not_a_directory_is_refused_at_start() -> TestResult {
    let tree = FakeTree::new("/fake").root_stat_then(Ok(file_meta(3.0, 9.0, 1)));
    // The first scripted answer is the directory; drop it so the file answers.
    tree.root_stats
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .pop_front();
    let tree = Arc::new(tree);
    match start_with(options(Path::new("/fake")), FakePacer::new(2), tree) {
        Err(WalkError::RootNotDirectory) => Ok(()),
        Err(other) => Err(format!("expected RootNotDirectory, got {other:?}")),
        Ok(_) => Err("a file root must not start a walk".to_owned()),
    }
}

#[test]
fn cancel_returns_within_200ms_while_directories_are_being_listed() -> TestResult {
    let tree = Arc::new(wide_tree(100, 10, Duration::from_millis(20)));
    let handle = start_with(options(Path::new("/fake")), FakePacer::new(2), tree)
        .map_err(|e| e.to_string())?;
    thread::sleep(Duration::from_millis(50));
    assert!(
        !handle.progress().done,
        "a two-second walk is still running at 50 ms"
    );
    let asked = Instant::now();
    handle.cancel();
    let result = handle.take();
    let took = asked.elapsed();
    assert!(took <= REACT_WITHIN, "cancel took {took:?}");
    match result {
        Err(WalkError::Cancelled) => Ok(()),
        other => Err(format!("expected Cancelled, got {other:?}")),
    }
}

#[test]
fn pause_stops_the_count_within_200ms_and_resume_continues_without_relisting() -> TestResult {
    let dirs = 120;
    let tree = Arc::new(wide_tree(dirs, 10, Duration::from_millis(5)));
    let handle = start_with(options(Path::new("/fake")), FakePacer::new(2), tree.clone())
        .map_err(|e| e.to_string())?;
    thread::sleep(Duration::from_millis(60));
    handle.pause();
    thread::sleep(REACT_WITHIN);
    let first = handle.progress();
    assert!(!first.done, "paused, not finished");
    thread::sleep(Duration::from_millis(300));
    let second = handle.progress();
    assert_eq!(first.entries, second.entries, "entries stopped advancing");
    assert_eq!(first.dirs, second.dirs);
    let calls_while_paused = tree.calls();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(
        tree.calls(),
        calls_while_paused,
        "no directory is listed while paused"
    );
    handle.resume();
    wait_done(&handle)?;
    let out = handle.take().map_err(|e| e.to_string())?;
    assert_eq!(out.stats.entries, u64::from(dirs) + u64::from(dirs) * 10);
    assert_eq!(
        tree.calls(),
        u64::from(dirs) + 1,
        "every directory listed exactly once"
    );
    Ok(())
}

#[test]
fn progress_reports_the_counts_and_a_sample_path() -> TestResult {
    let tree = Arc::new(wide_tree(10, 3, Duration::ZERO));
    let handle = start_with(options(Path::new("/fake")), FakePacer::new(2), tree)
        .map_err(|e| e.to_string())?;
    wait_done(&handle)?;
    let progress = handle.progress();
    assert_eq!(progress.entries, 40);
    assert_eq!(progress.dirs, 10);
    assert_eq!(progress.files, 30);
    assert_eq!(
        progress.bytes, 30,
        "sizes 0, 1 and 2 in each of ten directories"
    );
    assert!(
        progress.current_path.is_some(),
        "at least the root was sampled"
    );
    let out = handle.take().map_err(|e| e.to_string())?;
    assert_eq!(out.stats.fast_path, FastPath::Bulk);
    assert!(out.stats.wall_ms > 0.0);
    Ok(())
}

#[test]
fn the_fast_path_in_the_stats_is_the_root_listing_path() -> TestResult {
    let tree = wide_tree(2, 2, Duration::ZERO).with_fast_path(FastPath::PerEntry);
    let (_, out) = run(tree, options(Path::new("/fake")), 1)?;
    assert_eq!(out.stats.fast_path, FastPath::PerEntry);
    Ok(())
}

// ---------------------------------------------------------------------------
// Scripted tests: a worker that panics, a name that is a path, a cancel that
// reaches a listing in progress
// ---------------------------------------------------------------------------

/// What the scripted `d7` panics with.
const PANIC_MESSAGE: &str = "fixture panic: directory 7";
/// How long a walk that ends in a fault may take to hand it over.
const FAULT_WITHIN: Duration = Duration::from_secs(5);

/// A wide tree whose `d7` panics when listed, walked by two workers: the
/// handle's `take()` outcome, bounded, and the tree for its counters.
fn walk_with_a_panicking_directory()
-> Result<(Arc<FakeTree>, Result<WalkOutput, WalkError>), String> {
    let mut tree = wide_tree(20, 5, Duration::from_millis(2));
    tree.special("d7", Special::Panic(PANIC_MESSAGE.to_owned()));
    let tree = Arc::new(tree);
    let mut opts = options(Path::new("/fake"));
    opts.max_workers = 2;
    let handle = start_with(opts, FakePacer::new(2), tree.clone()).map_err(|e| e.to_string())?;
    let result = take_within(handle, FAULT_WITHIN)?;
    Ok((tree, result))
}

#[test]
fn a_panic_inside_a_listing_ends_the_walk_instead_of_wedging_it() -> TestResult {
    let (tree, result) = walk_with_a_panicking_directory()?;
    match result {
        Err(WalkError::Internal(_)) => {}
        other => return Err(format!("expected Internal, got {other:?}")),
    }
    let calls = tree.calls();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(
        tree.calls(),
        calls,
        "nothing is listed once take() has returned"
    );
    Ok(())
}

#[test]
fn the_panic_message_is_in_the_internal_error() -> TestResult {
    let (_, result) = walk_with_a_panicking_directory()?;
    match result {
        Err(WalkError::Internal(text)) if text.contains(PANIC_MESSAGE) => Ok(()),
        Err(WalkError::Internal(text)) => Err(format!(
            "the generic sentence alone is not enough: {text:?} does not name {PANIC_MESSAGE:?}"
        )),
        other => Err(format!("expected Internal, got {other:?}")),
    }
}

#[test]
fn a_panic_on_the_only_worker_still_ends_the_walk() -> TestResult {
    let mut tree = wide_tree(20, 5, Duration::ZERO);
    tree.special("d7", Special::Panic(PANIC_MESSAGE.to_owned()));
    let tree = Arc::new(tree);
    let mut opts = options(Path::new("/fake"));
    opts.max_workers = 1;
    let handle = start_with(opts, FakePacer::new(1), tree).map_err(|e| e.to_string())?;
    match take_within(handle, FAULT_WITHIN)? {
        Err(WalkError::Internal(text)) if text.contains(PANIC_MESSAGE) => Ok(()),
        other => Err(format!("expected Internal naming the panic, got {other:?}")),
    }
}

#[test]
fn a_worker_that_dies_outside_a_listing_is_reported_after_every_worker_is_joined() -> TestResult {
    // Worker 0 dies in `on_worker_start`, outside the listing; worker 1 does
    // the work and is inside a 300 ms listing when the cancel lands. The
    // driver joins worker 0 first and must go on to join worker 1 rather than
    // report the dead thread while worker 1 is still listing.
    let message = "fixture panic: worker 0 at start";
    let mut tree = FakeTree::new("/fake");
    let slow = tree.add_dir("", "slow");
    tree.special(&slow, Special::Sleep(Duration::from_millis(300)));
    tree.add_dir("", "d1");
    tree.add_dir("", "d2");
    let slow_abs = tree.abs(&slow);
    let tree = Arc::new(tree);
    let pacer = FakePacer::panicking_at_start(2, "tm-walk-worker-0", message);
    let mut opts = options(Path::new("/fake"));
    opts.max_workers = 2;
    let handle = start_with(opts, pacer, tree.clone()).map_err(|e| e.to_string())?;
    if !wait_until(Duration::from_secs(2), || {
        tree.listed_paths().contains(&slow_abs)
    }) {
        return Err("the surviving worker never reached `slow`".to_owned());
    }
    handle.cancel();
    let result = take_within(handle, FAULT_WITHIN)?;
    assert_eq!(
        tree.in_flight(),
        0,
        "take() returned while a worker was still listing: the join loop gave up at the dead thread"
    );
    match result {
        Err(WalkError::Internal(text)) if text.contains(message) => Ok(()),
        other => Err(format!("expected Internal naming the panic, got {other:?}")),
    }
}

#[test]
fn a_panic_on_the_driver_thread_is_reported_with_its_message() -> TestResult {
    // The second `stat_dir` is the driver's end-of-walk re-check of the root.
    let message = "fixture panic: the end-of-walk stat";
    let mut tree = FakeTree::new("/fake").stat_panic_on(1, message);
    tree.add_file("", "a.bin", 1.0);
    let tree = Arc::new(tree);
    let handle = start_with(options(Path::new("/fake")), FakePacer::new(1), tree)
        .map_err(|e| e.to_string())?;
    match take_within(handle, FAULT_WITHIN)? {
        Err(WalkError::Internal(text))
            if text.contains("the walk's driver thread panicked") && text.contains(message) =>
        {
            Ok(())
        }
        other => Err(format!(
            "expected Internal naming the driver's panic, got {other:?}"
        )),
    }
}

#[test]
fn a_directory_whose_name_is_a_path_is_refused_and_never_listed() -> TestResult {
    let mut tree = FakeTree::new("/fake");
    tree.add_entry("", b"evil/..", dir_meta());
    let fine = tree.add_dir("", "fine");
    tree.add_file(&fine, "after.bin", 1.0);
    let (tree, out) = run(tree, options(Path::new("/fake")), 2)?;
    let index = index_by_path(&out)?;
    let evil = node(&index, &out, "evil/..")?;
    assert_eq!(evil.kind(), KIND_DIR);
    assert_eq!(evil.flags() & FLAG_REFUSED_DIR, FLAG_REFUSED_DIR);
    assert_eq!(evil.children(), 0);
    assert_eq!(
        out.refusals,
        vec![DirRefusal {
            node: evil.id(),
            why: Refusal::Unreadable,
        }],
        "refused exactly as an unreadable directory is"
    );
    assert!(index.contains_key("fine/after.bin"), "the walk went on");
    assert_eq!(out.stats.dirs_listed, 2, "the root and `fine`");
    let asked: Vec<String> = tree
        .listed_paths()
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    assert!(
        asked.iter().all(|p| !p.contains("evil")),
        "the lister was asked for a path built from the name: {asked:?}"
    );
    Ok(())
}

#[test]
fn cancel_stops_a_listing_between_its_batches_and_the_heartbeat_advances_meanwhile() -> TestResult {
    let mut tree = FakeTree::new("/fake");
    let huge = tree.add_dir("", "huge");
    tree.special(
        &huge,
        Special::Batches {
            batches: 50,
            each: Duration::from_millis(20),
        },
    );
    let tree = Arc::new(tree);
    let handle = start_with(options(Path::new("/fake")), FakePacer::new(2), tree)
        .map_err(|e| e.to_string())?;
    if !wait_until(Duration::from_secs(2), || handle.progress().heartbeat > 0) {
        return Err("the heartbeat never advanced".to_owned());
    }
    let first = handle.progress().heartbeat;
    if !wait_until(Duration::from_secs(2), || {
        handle.progress().heartbeat > first
    }) {
        return Err(format!("the heartbeat stopped at {first}"));
    }
    assert!(
        !handle.progress().done,
        "a one-second listing is still going"
    );
    handle.cancel();
    // The listing has 50 batches of 20 ms left at most; a cancel that reaches
    // it between batches returns long before the second it would take.
    match take_within(handle, Duration::from_millis(300))? {
        Err(WalkError::Cancelled) => Ok(()),
        other => Err(format!("expected Cancelled, got {other:?}")),
    }
}

#[test]
fn a_cancel_that_interrupts_the_roots_own_listing_is_a_cancel_not_a_refused_root() -> TestResult {
    // The listing a cancel interrupts answers with the error it stopped on;
    // for the root that used to be recorded as the root being refused, and
    // the driver checked a refused root before a cancel — so a cancel that
    // landed while the root was being listed came back as "the root could
    // not be read" (the real-module cancel test caught it on 23 Sep 2026).
    let mut tree = FakeTree::new("/fake");
    tree.special(
        "",
        Special::Batches {
            batches: 50,
            each: Duration::from_millis(20),
        },
    );
    let tree = Arc::new(tree);
    let handle = start_with(options(Path::new("/fake")), FakePacer::new(2), tree)
        .map_err(|e| e.to_string())?;
    if !wait_until(Duration::from_secs(2), || handle.progress().heartbeat > 0) {
        return Err("the root's listing never started".to_owned());
    }
    handle.cancel();
    match take_within(handle, Duration::from_millis(300))? {
        Err(WalkError::Cancelled) => Ok(()),
        other => Err(format!("expected Cancelled, got {other:?}")),
    }
}

/// Windows keeps a copy of each directory's times in its PARENT's index and
/// updates that copy lazily, so the times a parent's listing reports for a
/// subdirectory can be stale. The subdirectory's own listing reads the
/// directory's own times from the handle it opened, and those win: they are
/// what `lstat` — and so the legacy walker — reads. A directory whose listing
/// reports no times of its own (macOS and Linux, whose listings already read
/// each entry's own attributes) keeps what its parent's listing said.
#[test]
fn a_directorys_own_times_from_its_listing_replace_its_parents_copy() -> TestResult {
    let mut tree = FakeTree::new("/r");
    let fresh = tree.add_dir("", "fresh");
    tree.add_dir("", "plain");
    tree.own_times(
        &fresh,
        DirTimes {
            mtime_ms: 1_790_000_000_000.25,
            atime_ms: 1_790_000_000_500.5,
        },
    );
    let (_, out) = run(tree, options(Path::new("/r")), 2)?;
    let paths = rel_paths(&out)?;
    let at = |rel: &str| {
        paths
            .iter()
            .position(|p| p == rel)
            .ok_or_else(|| format!("no node {rel} in {paths:?}"))
    };
    let (f, p) = (at("fresh")?, at("plain")?);
    assert_eq!(
        out.mtime_ms.get(f).copied(),
        Some(1_790_000_000_000.25),
        "fresh: its own mtime"
    );
    assert_eq!(
        out.atime_ms.get(f).copied(),
        Some(1_790_000_000_500.5),
        "fresh: its own atime"
    );
    assert_eq!(
        out.mtime_ms.get(p).copied(),
        Some(dir_meta().mtime_ms),
        "plain: its parent's copy"
    );
    assert!(
        out.atime_ms.get(p).is_some_and(|a| a.is_nan()),
        "plain: its parent's copy (no atime)"
    );
    Ok(())
}

/// The platforms `platform/unsupported.rs` serves: everything without a
/// native listing. This used to be `not(target_os = "macos")`, written before
/// the Windows and Linux listings existed; it never ran off macOS until CI's
/// Rust step first reached the tests, and then it failed on both (Getdents,
/// ExtdDirInfo), correctly — those platforms are supported now.
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
#[test]
fn start_and_probe_report_the_platform_as_unsupported() -> TestResult {
    use tm_governor::{Budget, FakeSampler, FakeSignals, Governor, Preset};
    let probe = tm_walk::probe(Path::new("."));
    assert_eq!(probe.fast_path, FastPath::Unavailable);
    let expected = format!(
        "the native listing is not built for {} yet",
        std::env::consts::OS
    );
    assert_eq!(probe.reason, expected);
    let governor = Arc::new(Governor::start(
        Budget {
            preset: Preset::Balanced,
            cpu_percent: None,
        },
        false,
        Box::new(FakeSampler::new(4)),
        Box::new(FakeSignals::default()),
    ));
    match tm_walk::start(options(Path::new(".")), governor) {
        Err(WalkError::Unsupported(reason)) if reason == expected => Ok(()),
        other => Err(format!("expected Unsupported({expected:?}), got {other:?}")),
    }
}

/// The live half of the Linux and Windows listings, which their synthetic-buffer
/// tests cannot give and only the CI runners can run: the probe names this
/// platform's own call, and a real walk of a real tree returns every entry and
/// every byte. (macOS has its own live module below.)
#[cfg(any(target_os = "linux", windows))]
#[test]
fn the_probe_and_a_real_walk_use_this_platforms_listing() -> TestResult {
    use tm_governor::{Budget, FakeSampler, FakeSignals, Governor, Preset};
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let root = std::env::temp_dir().join(format!("tm-walk-live-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(root.join("sub")).map_err(|e| e.to_string())?;
    let outcome = (|| -> TestResult {
        std::fs::write(root.join("a.txt"), b"hello").map_err(|e| e.to_string())?;
        std::fs::write(root.join("sub").join("b.bin"), vec![7_u8; 1000])
            .map_err(|e| e.to_string())?;

        let probe = tm_walk::probe(&root);
        #[cfg(target_os = "linux")]
        let expected = (FastPath::Getdents, "getdents64 and ");
        #[cfg(windows)]
        let expected = (FastPath::ExtdDirInfo, "FileIdExtdDirectoryInfo ");
        if probe.fast_path != expected.0 || !probe.reason.starts_with(expected.1) {
            return Err(format!(
                "expected {:?} with a reason starting {:?}, got {probe:?}",
                expected.0, expected.1
            ));
        }

        let governor = Arc::new(Governor::start(
            Budget {
                preset: Preset::Balanced,
                cpu_percent: None,
            },
            false,
            Box::new(FakeSampler::new(4)),
            Box::new(FakeSignals::default()),
        ));
        let handle = tm_walk::start(options(&root), governor).map_err(|e| e.to_string())?;
        let out = take_within(handle, Duration::from_secs(10))?.map_err(|e| e.to_string())?;
        // The root, a.txt, sub and sub/b.bin — and the 1,005 bytes of the two files.
        if out.parent.len() != 4 {
            return Err(format!("4 nodes, got {}: {out:?}", out.parent.len()));
        }
        let bytes: f64 = out.size.iter().sum();
        if (bytes - 1005.0).abs() > f64::EPSILON {
            return Err(format!("1005 bytes in all, got {bytes}"));
        }
        if !out.refusals.is_empty() {
            return Err(format!("nothing refused, got {:?}", out.refusals));
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&root);
    outcome
}

// ---------------------------------------------------------------------------
// Live tests: the real listing on a real fixture (macOS)
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod live {
    use std::ffi::CString;
    use std::fs;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use tm_governor::{Budget, FakeSampler, FakeSignals, Governor, Preset};
    use tm_walk::{
        FLAG_REFUSED_DIR, FastPath, KIND_DIR, KIND_FILE, KIND_SYMLINK, Refusal, WalkError,
        WalkOptions, probe, start,
    };

    use super::{REACT_WITHIN, TestResult, index_by_path, node, rel_paths, wait_done};

    const A_BYTES: usize = 1_234;
    const B_BYTES: usize = 4_096;
    const C_BYTES: usize = 10;
    const HARD_BYTES: usize = 777;
    const SPARSE_BYTES: u64 = 1024 * 1024;
    const NEWLINE_BYTES: usize = 11;
    const TAB_BYTES: usize = 12;
    const EMOJI_BYTES: usize = 13;
    const NEWLINE_NAME: &str = "with\nnewline.txt";
    const TAB_NAME: &str = "with\ttab.txt";
    const EMOJI_NAME: &str = "emoji-\u{1F332}.txt";
    const BROKEN_TARGET: &str = "/nonexistent/target";

    /// A temporary tree under `std::env::temp_dir()`, removed however the test
    /// ends; directories made unreadable are made readable again first.
    struct Fixture {
        root: PathBuf,
        restore: Vec<PathBuf>,
    }

    /// Fixtures created by this test binary so far: tests run on parallel
    /// threads, and two starting within the clock's resolution must not share
    /// a directory.
    static FIXTURES: AtomicU64 = AtomicU64::new(0);

    impl Fixture {
        fn new(tag: &str) -> Result<Self, String> {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let serial = FIXTURES.fetch_add(1, Ordering::SeqCst);
            let root = std::env::temp_dir().join(format!(
                "tm-walk-{tag}-{}-{serial}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&root).map_err(|e| format!("mkdir {}: {e}", root.display()))?;
            Ok(Self {
                root,
                restore: Vec::new(),
            })
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.root.join(rel)
        }

        fn file(&self, rel: &str, bytes: usize) -> Result<PathBuf, String> {
            let p = self.path(rel);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
            }
            fs::write(&p, vec![b'x'; bytes]).map_err(|e| format!("write {}: {e}", p.display()))?;
            Ok(p)
        }

        fn dir(&self, rel: &str) -> Result<PathBuf, String> {
            let p = self.path(rel);
            fs::create_dir_all(&p).map_err(|e| format!("mkdir {}: {e}", p.display()))?;
            Ok(p)
        }

        fn symlink(&self, rel: &str, target: &str) -> Result<(), String> {
            let p = self.path(rel);
            std::os::unix::fs::symlink(target, &p)
                .map_err(|e| format!("symlink {}: {e}", p.display()))
        }

        fn hardlink(&self, existing: &str, new: &str) -> Result<(), String> {
            fs::hard_link(self.path(existing), self.path(new))
                .map_err(|e| format!("link {new}: {e}"))
        }

        fn sparse(&self, rel: &str, len: u64) -> Result<PathBuf, String> {
            let p = self.path(rel);
            let f = fs::File::create(&p).map_err(|e| format!("create {}: {e}", p.display()))?;
            f.set_len(len)
                .map_err(|e| format!("ftruncate {}: {e}", p.display()))?;
            Ok(p)
        }

        fn fifo(&self, rel: &str) -> Result<PathBuf, String> {
            let p = self.path(rel);
            let c = CString::new(p.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
            // SAFETY: `c` is a valid NUL-terminated path; mkfifo reads it and creates the node.
            let rc = unsafe { libc::mkfifo(c.as_ptr(), 0o644) };
            if rc != 0 {
                return Err(format!(
                    "mkfifo {}: {}",
                    p.display(),
                    std::io::Error::last_os_error()
                ));
            }
            Ok(p)
        }

        fn deny(&mut self, rel: &str) -> Result<(), String> {
            let p = self.path(rel);
            fs::set_permissions(&p, fs::Permissions::from_mode(0o000))
                .map_err(|e| format!("chmod {}: {e}", p.display()))?;
            self.restore.push(p);
            Ok(())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            for p in &self.restore {
                let _ = fs::set_permissions(p, fs::Permissions::from_mode(0o755));
            }
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn running_as_root() -> bool {
        // SAFETY: geteuid has no preconditions and only reads the process's credentials.
        unsafe { libc::geteuid() == 0 }
    }

    fn governor() -> Arc<Governor> {
        Arc::new(Governor::start(
            Budget {
                preset: Preset::Turbo,
                cpu_percent: None,
            },
            false,
            Box::new(FakeSampler::new(8)),
            Box::new(FakeSignals::default()),
        ))
    }

    /// The P3-6 formula, written out here independently of the crate's helper.
    fn legacy_ms(sec: i64, nsec: i64) -> f64 {
        (sec as f64) * 1e3 + (nsec as f64) / 1e6
    }

    /// The contract fixture: every condition the legacy walker handles.
    fn contract_fixture() -> Result<Fixture, String> {
        let mut fx = Fixture::new("contract")?;
        fx.file("a.bin", A_BYTES)?;
        fx.file("empty.bin", 0)?;
        fx.sparse("sparse.bin", SPARSE_BYTES)?;
        fx.file("sub/b.bin", B_BYTES)?;
        fx.file("sub/deeper/c.bin", C_BYTES)?;
        fx.symlink("link-to-a", "a.bin")?;
        fx.symlink("link-to-sub", "sub")?;
        fx.symlink("broken", BROKEN_TARGET)?;
        fx.symlink("loop-a", "loop-b")?;
        fx.symlink("loop-b", "loop-a")?;
        fx.file("hard1.bin", HARD_BYTES)?;
        fx.hardlink("hard1.bin", "hard2.bin")?;
        fx.file(NEWLINE_NAME, NEWLINE_BYTES)?;
        fx.file(TAB_NAME, TAB_BYTES)?;
        fx.file(EMOJI_NAME, EMOJI_BYTES)?;
        fx.file("denied/x.bin", 1)?;
        fx.deny("denied")?;
        fx.file("never/y.bin", 1)?;
        fx.fifo("fifo")?;
        Ok(fx)
    }

    #[test]
    fn walks_the_fixture_and_records_the_legacy_facts() -> TestResult {
        let fx = contract_fixture()?;
        let mut opts = WalkOptions::new(&fx.root);
        opts.never_descend = vec![fx.path("never")];
        let handle = start(opts, governor()).map_err(|e| e.to_string())?;
        wait_done(&handle)?;
        let progress = handle.progress();
        let out = handle.take().map_err(|e| e.to_string())?;
        let index = index_by_path(&out)?;
        let paths = rel_paths(&out)?;

        // Twenty entries under the root: 4 directories and 16 leaves.
        assert_eq!(out.len(), 21, "{paths:?}");
        assert_eq!(out.stats.entries, 20);
        assert_eq!(progress.entries, 20);
        assert_eq!(progress.dirs, 4);
        assert_eq!(progress.files, 16);
        assert_eq!(out.parent.first().copied(), Some(0));
        let root_name = out.name(0).ok_or("no root name")?;
        assert_eq!(
            root_name,
            fx.root.file_name().ok_or("no root file name")?.as_bytes()
        );

        // Plain files of known sizes; the directory's own size is zero.
        let a = node(&index, &out, "a.bin")?;
        assert_eq!(a.kind(), KIND_FILE);
        assert_eq!(a.size().to_bits(), (A_BYTES as f64).to_bits());
        assert!(
            a.alloc() >= A_BYTES as f64,
            "allocated at least its bytes: {}",
            a.alloc()
        );
        let a_meta = fs::symlink_metadata(fx.path("a.bin")).map_err(|e| e.to_string())?;
        assert_eq!(
            a.mtime().to_bits(),
            legacy_ms(a_meta.mtime(), a_meta.mtime_nsec()).to_bits(),
            "mtime is the exact Node double"
        );
        assert!(a.atime().is_nan(), "atime not asked for");
        assert_eq!(node(&index, &out, "sub")?.kind(), KIND_DIR);
        assert_eq!(
            node(&index, &out, "sub")?.size().to_bits(),
            0.0_f64.to_bits()
        );
        assert_eq!(
            node(&index, &out, "sub/b.bin")?.size().to_bits(),
            (B_BYTES as f64).to_bits()
        );
        assert_eq!(
            node(&index, &out, "sub/deeper/c.bin")?.size().to_bits(),
            (C_BYTES as f64).to_bits()
        );
        assert_eq!(
            node(&index, &out, "empty.bin")?.size().to_bits(),
            0.0_f64.to_bits()
        );

        // A truncate-only sparse file claims its length and occupies nothing.
        let sparse = node(&index, &out, "sparse.bin")?;
        assert_eq!(sparse.size().to_bits(), (SPARSE_BYTES as f64).to_bits());
        assert_eq!(sparse.alloc().to_bits(), 0.0_f64.to_bits());

        // Symlinks are leaves with the link's own length and are never followed.
        let link = node(&index, &out, "link-to-a")?;
        assert_eq!(link.kind(), KIND_SYMLINK);
        assert_eq!(link.size().to_bits(), ("a.bin".len() as f64).to_bits());
        let link_dir = node(&index, &out, "link-to-sub")?;
        assert_eq!(link_dir.kind(), KIND_SYMLINK);
        assert_eq!(link_dir.size().to_bits(), ("sub".len() as f64).to_bits());
        assert_eq!(
            link_dir.children(),
            0,
            "a symlink to a directory is not descended"
        );
        assert!(!index.contains_key("link-to-sub/b.bin"));
        let broken = node(&index, &out, "broken")?;
        assert_eq!(broken.kind(), KIND_SYMLINK);
        assert_eq!(
            broken.size().to_bits(),
            (BROKEN_TARGET.len() as f64).to_bits()
        );
        assert_eq!(node(&index, &out, "loop-a")?.kind(), KIND_SYMLINK);
        assert_eq!(node(&index, &out, "loop-b")?.kind(), KIND_SYMLINK);

        // A hard-linked pair: both full size, one ref each, same (dev, ino).
        let h1 = node(&index, &out, "hard1.bin")?;
        let h2 = node(&index, &out, "hard2.bin")?;
        assert_eq!(h1.size().to_bits(), (HARD_BYTES as f64).to_bits());
        assert_eq!(h2.size().to_bits(), (HARD_BYTES as f64).to_bits());
        assert_eq!(out.hardlinks.len(), 2, "{:?}", out.hardlinks);
        let r1 = out
            .hardlinks
            .iter()
            .find(|h| h.node == h1.id())
            .ok_or("no ref for hard1")?;
        let r2 = out
            .hardlinks
            .iter()
            .find(|h| h.node == h2.id())
            .ok_or("no ref for hard2")?;
        assert_eq!(r1.dev.to_bits(), r2.dev.to_bits());
        assert_eq!(r1.ino.to_bits(), r2.ino.to_bits());
        let h_meta = fs::symlink_metadata(fx.path("hard1.bin")).map_err(|e| e.to_string())?;
        assert_eq!(r1.ino.to_bits(), (h_meta.ino() as f64).to_bits());
        assert_eq!(r1.dev.to_bits(), (h_meta.dev() as f64).to_bits());

        // Names round-trip byte for byte.
        assert_eq!(
            node(&index, &out, NEWLINE_NAME)?.size().to_bits(),
            (NEWLINE_BYTES as f64).to_bits()
        );
        assert_eq!(
            node(&index, &out, TAB_NAME)?.size().to_bits(),
            (TAB_BYTES as f64).to_bits()
        );
        assert_eq!(
            node(&index, &out, EMOJI_NAME)?.size().to_bits(),
            (EMOJI_BYTES as f64).to_bits()
        );

        // Sockets, fifos and devices are leaves.
        let fifo = node(&index, &out, "fifo")?;
        assert_eq!(fifo.kind(), KIND_FILE);
        assert_eq!(fifo.size().to_bits(), 0.0_f64.to_bits());

        // A never-descend directory is a childless node with its own metadata.
        let never = node(&index, &out, "never")?;
        assert_eq!(never.kind(), KIND_DIR);
        assert_eq!(never.children(), 0);
        assert_eq!(never.flags(), 0);
        let never_meta = fs::symlink_metadata(fx.path("never")).map_err(|e| e.to_string())?;
        assert_eq!(
            never.mtime().to_bits(),
            legacy_ms(never_meta.mtime(), never_meta.mtime_nsec()).to_bits()
        );
        assert!(!index.contains_key("never/y.bin"));

        // An unreadable directory is a flagged node with a Denied refusal; the walk went on.
        let denied = node(&index, &out, "denied")?;
        assert_eq!(denied.kind(), KIND_DIR);
        assert_eq!(denied.children(), 0);
        if running_as_root() {
            eprintln!(
                "skipped the denied-directory assertions: running as root, chmod 000 denies nothing"
            );
        } else {
            assert_eq!(denied.flags() & FLAG_REFUSED_DIR, FLAG_REFUSED_DIR);
            assert_eq!(out.refusals.len(), 1, "{:?}", out.refusals);
            let refusal = out.refusals.first().ok_or("no refusal")?;
            assert_eq!(refusal.node, denied.id());
            assert_eq!(refusal.why, Refusal::Denied);
            assert_eq!(
                out.stats.dirs_listed, 3,
                "root, sub, deeper; not denied, not never"
            );
        }

        // Stats are measured, not assumed.
        assert_eq!(out.stats.fast_path, FastPath::Bulk);
        assert_eq!(out.stats.denied_entries, 0);
        assert_eq!(out.stats.unreadable_entries, 0);
        assert_eq!(out.stats.dataless, 0);
        assert!(out.stats.workers_peak >= 1);
        assert!(out.stats.wall_ms > 0.0);
        assert!(out.stats.cpu_seconds.is_finite() && out.stats.cpu_seconds >= 0.0);
        assert_eq!(out.name_off.len(), out.len() + 1);
        assert_eq!(
            out.names.len(),
            *out.name_off.last().ok_or("no name_off")? as usize
        );
        Ok(())
    }

    #[test]
    fn records_atime_when_asked() -> TestResult {
        let fx = Fixture::new("atime")?;
        fx.file("a.bin", 3)?;
        let mut opts = WalkOptions::new(&fx.root);
        opts.want_atime = true;
        let handle = start(opts, governor()).map_err(|e| e.to_string())?;
        let out = handle.take().map_err(|e| e.to_string())?;
        let index = index_by_path(&out)?;
        let a = node(&index, &out, "a.bin")?;
        let meta = fs::symlink_metadata(fx.path("a.bin")).map_err(|e| e.to_string())?;
        assert_eq!(
            a.atime().to_bits(),
            legacy_ms(meta.atime(), meta.atime_nsec()).to_bits()
        );
        let root_atime = out.atime_ms.first().copied().ok_or("no root atime")?;
        assert!(
            root_atime.is_finite(),
            "the root's own atime is recorded too"
        );
        Ok(())
    }

    #[test]
    fn refuses_a_root_that_is_not_a_directory() -> TestResult {
        let fx = Fixture::new("notdir")?;
        let file = fx.file("plain.bin", 1)?;
        fx.dir("real")?;
        fx.symlink("link-to-real", "real")?;
        match start(WalkOptions::new(&file), governor()) {
            Err(WalkError::RootNotDirectory) => {}
            other => {
                return Err(format!(
                    "file root: expected RootNotDirectory, got {other:?}"
                ));
            }
        }
        match start(WalkOptions::new(fx.path("link-to-real")), governor()) {
            Err(WalkError::RootNotDirectory) => {}
            other => {
                return Err(format!(
                    "symlink root: expected RootNotDirectory, got {other:?}"
                ));
            }
        }
        match start(WalkOptions::new(fx.path("missing")), governor()) {
            Err(WalkError::RootRefused(Refusal::Vanished)) => Ok(()),
            other => Err(format!(
                "missing root: expected RootRefused(Vanished), got {other:?}"
            )),
        }
    }

    #[test]
    fn the_probe_reports_bulk_for_a_temp_directory() -> TestResult {
        let fx = Fixture::new("probe")?;
        fx.file("a.bin", 1)?;
        let probe = probe(&fx.root);
        assert_eq!(probe.fast_path, FastPath::Bulk, "{}", probe.reason);
        assert!(probe.reason.contains("getattrlistbulk"), "{}", probe.reason);
        Ok(())
    }

    /// Five thousand entries: fifty directories of a hundred files.
    fn five_thousand(tag: &str) -> Result<Fixture, String> {
        let fx = Fixture::new(tag)?;
        for d in 0..50 {
            for f in 0..100 {
                fx.file(&format!("d{d}/f{f}.bin"), 1)?;
            }
        }
        Ok(fx)
    }

    #[test]
    fn cancel_returns_within_200ms_on_five_thousand_entries() -> TestResult {
        let fx = five_thousand("cancel")?;
        let handle = start(WalkOptions::new(&fx.root), governor()).map_err(|e| e.to_string())?;
        // Hold the workers so the cancel has something to interrupt.
        handle.pause();
        thread::sleep(Duration::from_millis(30));
        let asked = Instant::now();
        handle.cancel();
        let result = handle.take();
        let took = asked.elapsed();
        assert!(took <= REACT_WITHIN, "cancel took {took:?}");
        match result {
            Err(WalkError::Cancelled) => Ok(()),
            Ok(out) => Err(format!(
                "the walk completed ({} entries) before the cancel landed",
                out.stats.entries
            )),
            Err(other) => Err(format!("expected Cancelled, got {other:?}")),
        }
    }

    #[test]
    fn cancel_completes_while_the_governor_is_paused() -> TestResult {
        // The governor's pause, not the walk's: workers park inside
        // `throttle()`, and a cancel must still reach them.
        let fx = five_thousand("cancel-governor-paused")?;
        let gov = governor();
        gov.pause();
        let handle =
            start(WalkOptions::new(&fx.root), Arc::clone(&gov)).map_err(|e| e.to_string())?;
        thread::sleep(Duration::from_millis(50));
        let asked = Instant::now();
        handle.cancel();
        let (tx, rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let _ = tx.send(handle.take());
        });
        let outcome = rx.recv_timeout(Duration::from_secs(2));
        let took = asked.elapsed();
        gov.resume();
        match outcome {
            Ok(Err(WalkError::Cancelled)) => {
                assert!(took <= REACT_WITHIN * 2, "cancel took {took:?}");
                Ok(())
            }
            Ok(Ok(out)) => Err(format!(
                "the walk completed ({} entries) under a paused governor",
                out.stats.entries
            )),
            Ok(Err(other)) => Err(format!("expected Cancelled, got {other:?}")),
            Err(_) => Err(
                "take() did not return within 2 s: the cancel waited on the paused governor"
                    .to_owned(),
            ),
        }
    }

    #[test]
    fn pause_holds_the_count_and_resume_completes_the_same_total() -> TestResult {
        let fx = five_thousand("pause")?;
        let reference = start(WalkOptions::new(&fx.root), governor())
            .map_err(|e| e.to_string())?
            .take()
            .map_err(|e| e.to_string())?;
        assert_eq!(reference.stats.entries, 5_050);

        let handle = start(WalkOptions::new(&fx.root), governor()).map_err(|e| e.to_string())?;
        handle.pause();
        thread::sleep(REACT_WITHIN);
        let first = handle.progress();
        thread::sleep(Duration::from_millis(200));
        let second = handle.progress();
        assert_eq!(first.entries, second.entries, "entries held while paused");
        handle.resume();
        wait_done(&handle)?;
        let out = handle.take().map_err(|e| e.to_string())?;
        assert_eq!(out.stats.entries, reference.stats.entries);
        assert_eq!(out.stats.dirs_listed, reference.stats.dirs_listed);
        Ok(())
    }

    #[test]
    fn dropping_a_handle_cancels_the_walk_and_returns_within_200ms() -> TestResult {
        let fx = five_thousand("drop")?;
        let handle = start(WalkOptions::new(&fx.root), governor()).map_err(|e| e.to_string())?;
        handle.pause();
        thread::sleep(Duration::from_millis(30));
        let asked = Instant::now();
        // The drop cancels and joins the workers, so a paused walk must not
        // hold it up: paused workers wake for a cancel.
        drop(handle);
        assert!(
            asked.elapsed() <= REACT_WITHIN,
            "drop took {:?}",
            asked.elapsed()
        );
        Ok(())
    }

    #[test]
    fn never_descend_is_matched_on_the_exact_path() -> TestResult {
        let fx = Fixture::new("never")?;
        fx.file("Volumes/inside.bin", 1)?;
        fx.file("Volumes2/inside.bin", 1)?;
        let mut opts = WalkOptions::new(&fx.root);
        opts.never_descend = vec![fx.path("Volumes")];
        let out = start(opts, governor())
            .map_err(|e| e.to_string())?
            .take()
            .map_err(|e| e.to_string())?;
        let index = index_by_path(&out)?;
        assert!(!index.contains_key("Volumes/inside.bin"));
        assert!(
            index.contains_key("Volumes2/inside.bin"),
            "a longer path is not the listed one"
        );
        Ok(())
    }

    #[test]
    fn a_symlink_loop_terminates_and_is_two_leaves() -> TestResult {
        let fx = Fixture::new("loop")?;
        fx.dir("d")?;
        fx.symlink("d/up", "..")?;
        fx.symlink("d/self", ".")?;
        let out = start(WalkOptions::new(&fx.root), governor())
            .map_err(|e| e.to_string())?
            .take()
            .map_err(|e| e.to_string())?;
        assert_eq!(out.len(), 4, "{:?}", rel_paths(&out)?);
        let index = index_by_path(&out)?;
        assert_eq!(node(&index, &out, "d/up")?.kind(), KIND_SYMLINK);
        assert_eq!(node(&index, &out, "d/self")?.kind(), KIND_SYMLINK);
        Ok(())
    }
}

//! Sinks that write in place (Phase 4, T7a; design §S.1.2 step 4) and the
//! name ceiling. A sink whose `writes_in_place()` is true takes each whole
//! listing after the commit lock is released and before the listing's
//! subfolders are queued, side by side with other workers' blocks; a big
//! listing's chunks it takes under the lock, in order. A block whose names
//! would pass `WalkOptions::name_ceiling` faults the walk. Every test counts;
//! a wait is a hang guard only, never what a passing test depends on.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use tm_walk::platform::{ListBuffer, Lister, Meta};
use tm_walk::walk::Pacer;
use tm_walk::{
    BIG_LISTING, Block, FastPath, KIND_DIR, KIND_FILE, ListingSink, Numbering, Refusal, WalkError,
    WalkHandle, WalkOptions, WalkOutput, start_with_sinks,
};

type TestResult = Result<(), String>;

/// How long a hang guard waits before a test fails instead of hanging.
const SETTLE: Duration = Duration::from_secs(20);
const POLL: Duration = Duration::from_millis(2);
const WORKERS: [u32; 4] = [1, 2, 8, 64];

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

/// A folder's listing, or why it cannot be listed.
type Listed = Result<Vec<(Vec<u8>, Meta)>, Refusal>;

/// Folders by path, each listed sorted by name as the POSIX listers list.
/// Every name is ASCII, so the walk joins the same path on every host.
struct Tree {
    root: PathBuf,
    folders: HashMap<PathBuf, Listed>,
    next_ino: u128,
}

impl Tree {
    fn new() -> Self {
        let root = PathBuf::from("/t7a");
        let mut folders = HashMap::new();
        folders.insert(root.clone(), Ok(Vec::new()));
        Self {
            root,
            folders,
            next_ino: 100,
        }
    }

    fn ino(&mut self) -> u128 {
        self.next_ino += 1;
        self.next_ino
    }

    fn put(&mut self, parent: &Path, name: &str, meta: Meta) {
        if let Some(Ok(entries)) = self.folders.get_mut(parent) {
            entries.push((name.as_bytes().to_vec(), meta));
        }
    }

    fn file(&mut self, parent: &Path, name: &str) {
        let ino = self.ino();
        self.put(parent, name, file_meta(ino));
    }

    fn dir(&mut self, parent: &Path, name: &str) -> PathBuf {
        let ino = self.ino();
        self.put(parent, name, dir_meta(ino));
        let path = parent.join(name);
        self.folders.insert(path.clone(), Ok(Vec::new()));
        path
    }

    fn refuse(&mut self, path: &Path, why: Refusal) {
        self.folders.insert(path.to_path_buf(), Err(why));
    }
}

impl Lister for Tree {
    fn stat_dir(&self, _path: &Path, _want_atime: bool) -> Result<Meta, Refusal> {
        Ok(dir_meta(1))
    }

    fn list(
        &self,
        dir: &Path,
        _want_atime: bool,
        buf: &mut ListBuffer,
    ) -> Result<FastPath, Refusal> {
        buf.listing.clear();
        let entries = match self.folders.get(dir) {
            Some(Ok(entries)) => entries,
            Some(Err(why)) => return Err(*why),
            None => return Err(Refusal::Vanished),
        };
        for (name, meta) in entries {
            buf.listing.push(name, *meta);
        }
        buf.listing.sort_by_name();
        Ok(FastPath::Bulk)
    }
}

/// Files in the big folder: enough, with their long names, to fill several
/// of the walk's 4 MiB chunks (a staged row is about 80 bytes and its name).
const BIG_FILES: usize = 70_000;
const _: () = assert!(BIG_FILES > BIG_LISTING, "the big folder is a big listing");

/// Small folders of 0 to 27 files, a big one, one refused, an empty one and a
/// folder whose name holds a separator.
fn mixed_tree() -> Tree {
    let mut t = Tree::new();
    let root = t.root.clone();
    for d in 0..10 {
        let folder = t.dir(&root, &format!("d{d:02}"));
        for f in 0..(d * 3) {
            t.file(&folder, &format!("f{f:03}.bin"));
        }
        if d % 3 == 0 {
            let deeper = t.dir(&folder, "deeper");
            t.file(&deeper, "leaf.txt");
        }
    }
    let big = t.dir(&root, "big");
    for f in 0..BIG_FILES {
        t.file(
            &big,
            &format!("a-rather-long-name-for-the-chunks-{f:06}.bin"),
        );
    }
    let denied = t.dir(&root, "denied");
    t.refuse(&denied, Refusal::Denied);
    t.dir(&root, "empty");
    let ino = t.ino();
    t.put(&root, "sl/ash", dir_meta(ino));
    t
}

/// A pacer that allows `n` workers and never waits.
struct Workers(u32);

impl Pacer for Workers {
    fn on_worker_start(&self) {}
    fn throttle(&self, _cancelled: &dyn Fn() -> bool) {}
    fn worker_limit(&self) -> u32 {
        self.0
    }
}

fn options(tree: &Tree, workers: u32) -> WalkOptions {
    let mut opts = WalkOptions::new(tree.root.clone());
    opts.numbering = Numbering::Blocks;
    opts.max_workers = usize::try_from(workers).unwrap_or(1);
    opts
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

fn walk(
    tree: Arc<Tree>,
    opts: WalkOptions,
    sinks: Vec<Arc<dyn ListingSink>>,
) -> Result<Result<WalkOutput, WalkError>, String> {
    let workers = u32::try_from(opts.max_workers.max(1)).unwrap_or(1);
    let handle = start_with_sinks(opts, Arc::new(Workers(workers)), tree, sinks)
        .map_err(|e| e.to_string())?;
    take_within(handle)
}

fn name_of(out: &WalkOutput, id: u32) -> Vec<u8> {
    out.name(id as usize)
        .map(<[u8]>::to_vec)
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Every block reaches an in-place sink once
// ---------------------------------------------------------------------------

/// One commit as a sink saw it.
#[derive(Clone, Debug)]
struct Seen {
    folder: u32,
    first: u32,
    len: u32,
    offset: u32,
    names: Vec<Vec<u8>>,
}

/// Records what it is handed; writes in place when `in_place` says so.
#[derive(Default)]
struct Recorder {
    in_place: bool,
    commits: Mutex<Vec<Seen>>,
    refused: Mutex<Vec<(u32, Refusal)>>,
    aborts: AtomicU64,
}

impl ListingSink for Recorder {
    fn root(&self, _name: &[u8], _meta: &Meta) {}

    fn commit(&self, block: &Block<'_>) {
        lock(&self.commits).push(Seen {
            folder: block.folder,
            first: block.first,
            len: block.len,
            offset: block.offset,
            names: block.rows.iter().map(|r| block.name(r).to_vec()).collect(),
        });
    }

    fn refused(&self, folder: u32, why: Refusal) {
        lock(&self.refused).push((folder, why));
    }

    fn abort(&self) {
        self.aborts.fetch_add(1, Ordering::SeqCst);
    }

    fn writes_in_place(&self) -> bool {
        self.in_place
    }
}

/// Every id below the root held by exactly one of `commits`' rows, each with
/// the name the walk's output gives it; the most chunks one listing came in.
fn check_coverage(out: &WalkOutput, commits: &[Seen], at: &str) -> Result<usize, String> {
    let mut named: BTreeMap<u32, Vec<u8>> = BTreeMap::new();
    let mut chunks_per_listing: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    for seen in commits {
        // By folder: an empty listing's block starts where the next one does.
        chunks_per_listing
            .entry(seen.folder)
            .or_default()
            .push(seen.offset);
        let start = seen.first + seen.offset;
        for (id, name) in (start..).zip(&seen.names) {
            if named.insert(id, name.clone()).is_some() {
                return Err(format!("{at}: id {id} was handed over twice"));
            }
        }
        let end = seen.offset + u32::try_from(seen.names.len()).unwrap_or(u32::MAX);
        if end > seen.len {
            return Err(format!(
                "{at}: folder {}'s chunk ends past its block",
                seen.folder
            ));
        }
    }
    let n = u32::try_from(out.len()).map_err(|e| e.to_string())?;
    let expected: Vec<u32> = (1..n).collect();
    let got: Vec<u32> = named.keys().copied().collect();
    if got != expected {
        let missing = expected.iter().find(|id| !named.contains_key(id));
        return Err(format!(
            "{at}: {} of {} ids handed over; the first missing is {missing:?}",
            got.len(),
            expected.len()
        ));
    }
    for (&id, name) in &named {
        if *name != name_of(out, id) {
            return Err(format!("{at}: id {id} was handed over as another name"));
        }
    }
    let mut most = 0;
    for offsets in chunks_per_listing.values() {
        if !offsets.windows(2).all(|w| w.first() < w.get(1)) {
            return Err(format!("{at}: a big listing's chunks came out of order"));
        }
        most = most.max(offsets.len());
    }
    Ok(most)
}

fn sorted_refusals(refused: &[(u32, Refusal)]) -> Vec<(u32, u8)> {
    let mut all: Vec<(u32, u8)> = refused.iter().map(|&(id, why)| (id, why.code())).collect();
    all.sort_unstable();
    all
}

#[test]
fn an_in_place_sink_takes_every_block_once_and_every_refusal() -> TestResult {
    for workers in WORKERS {
        let tree = Arc::new(mixed_tree());
        let in_place = Arc::new(Recorder {
            in_place: true,
            ..Recorder::default()
        });
        let under_lock = Arc::new(Recorder::default());
        let out = walk(
            tree.clone(),
            options(&tree, workers),
            vec![in_place.clone(), under_lock.clone()],
        )?
        .map_err(|e| e.to_string())?;
        let at = format!("{workers} worker(s)");
        let in_place_chunks = check_coverage(&out, &lock(&in_place.commits), &at)?;
        assert!(
            in_place_chunks >= 2,
            "{at}: the big listing reached the in-place sink in {in_place_chunks} chunk(s)"
        );
        check_coverage(&out, &lock(&under_lock.commits), &at)?;
        let expected: Vec<(u32, u8)> = sorted_refusals(
            &out.refusals
                .iter()
                .map(|r| (r.node, r.why))
                .collect::<Vec<_>>(),
        );
        assert_eq!(expected.len(), 2, "{at}: denied and sl/ash");
        assert_eq!(
            sorted_refusals(&lock(&in_place.refused)),
            expected,
            "{at}: the in-place sink hears every refusal"
        );
        assert_eq!(in_place.aborts.load(Ordering::SeqCst), 0, "{at}");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Whole listings go to in-place sinks outside the lock
// ---------------------------------------------------------------------------

/// Counts in-place commits that start while another is running. The first
/// commit of a folder below the root waits until one has (a hang guard bounds
/// the wait): a second worker can only commit beside it if the first holds no
/// lock the second needs.
#[derive(Default)]
struct Overlap {
    running: AtomicU32,
    overlaps: AtomicU64,
    gated: AtomicBool,
}

impl ListingSink for Overlap {
    fn root(&self, _name: &[u8], _meta: &Meta) {}

    fn commit(&self, block: &Block<'_>) {
        if self.running.fetch_add(1, Ordering::SeqCst) > 0 {
            self.overlaps.fetch_add(1, Ordering::SeqCst);
        }
        if block.folder != 0 && !self.gated.swap(true, Ordering::SeqCst) {
            let _ = wait_until(|| self.overlaps.load(Ordering::SeqCst) > 0);
        }
        self.running.fetch_sub(1, Ordering::SeqCst);
    }

    fn refused(&self, _folder: u32, _why: Refusal) {}

    fn abort(&self) {}

    fn writes_in_place(&self) -> bool {
        true
    }
}

#[test]
fn two_workers_in_place_commits_run_side_by_side() -> TestResult {
    let mut t = Tree::new();
    let root = t.root.clone();
    for d in 0..8 {
        let folder = t.dir(&root, &format!("d{d}"));
        for f in 0..4 {
            t.file(&folder, &format!("f{f}"));
        }
    }
    let tree = Arc::new(t);
    let overlap = Arc::new(Overlap::default());
    let out =
        walk(tree.clone(), options(&tree, 2), vec![overlap.clone()])?.map_err(|e| e.to_string())?;
    assert_eq!(out.len(), 1 + 8 + 32);
    assert!(
        overlap.overlaps.load(Ordering::SeqCst) > 0,
        "no in-place commit ran beside another: the lock was held through them"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// ...and before the listing's subfolders are queued
// ---------------------------------------------------------------------------

/// Holds the root's in-place commit until the test has read the walk's queue
/// peak through the handle; keeps what it read.
#[derive(Default)]
struct QueueProbe {
    reached: AtomicBool,
    read: AtomicBool,
    peak: AtomicU64,
}

impl ListingSink for QueueProbe {
    fn root(&self, _name: &[u8], _meta: &Meta) {}

    fn commit(&self, block: &Block<'_>) {
        if block.folder == 0 {
            self.reached.store(true, Ordering::SeqCst);
            let _ = wait_until(|| self.read.load(Ordering::SeqCst));
        }
    }

    fn refused(&self, _folder: u32, _why: Refusal) {}

    fn abort(&self) {}

    fn writes_in_place(&self) -> bool {
        true
    }
}

#[test]
fn a_listings_subfolders_are_queued_after_its_in_place_commit() -> TestResult {
    let mut t = Tree::new();
    let root = t.root.clone();
    for d in 0..5 {
        let folder = t.dir(&root, &format!("d{d}"));
        t.file(&folder, "f");
    }
    let tree = Arc::new(t);
    let probe = Arc::new(QueueProbe::default());
    let handle = start_with_sinks(
        options(&tree, 2),
        Arc::new(Workers(2)),
        tree,
        vec![probe.clone()],
    )
    .map_err(|e| e.to_string())?;
    if !wait_until(|| probe.reached.load(Ordering::SeqCst)) {
        return Err("the root's block never reached the in-place sink".to_owned());
    }
    // The root's job alone has waited so far: its five subfolders wait only
    // once its in-place commit returns.
    probe
        .peak
        .store(handle.counts().queue_peak, Ordering::SeqCst);
    probe.read.store(true, Ordering::SeqCst);
    let out = take_within(handle)?.map_err(|e| e.to_string())?;
    assert_eq!(out.len(), 11);
    assert_eq!(
        probe.peak.load(Ordering::SeqCst),
        1,
        "subfolders were queued before the in-place sink had the block"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// The name ceiling
// ---------------------------------------------------------------------------

/// The bytes the root's entries' names take in `out`: every name but the root's.
fn block_name_bytes(out: &WalkOutput) -> Result<u64, String> {
    let root = out.name(0).ok_or("no root name")?.len();
    u64::try_from(out.names.len() - root).map_err(|e| e.to_string())
}

#[test]
fn a_block_whose_names_pass_the_name_ceiling_faults_the_walk() -> TestResult {
    let tree = Arc::new(mixed_tree());
    let unlimited =
        walk(tree.clone(), options(&tree, 2), Vec::new())?.map_err(|e| e.to_string())?;
    let total = block_name_bytes(&unlimited)?;
    assert!(total > 1_000, "a tree with names worth limiting: {total}");
    for workers in [1, 8] {
        // Exactly the names the tree holds: the walk fits.
        let mut fits = options(&tree, workers);
        fits.name_ceiling = total;
        let out = walk(tree.clone(), fits, Vec::new())?
            .map_err(|e| format!("{workers} worker(s), a ceiling of {total}: {e}"))?;
        assert_eq!(out.len(), unlimited.len());

        // One byte fewer: the block that would pass it faults the walk, and
        // every sink is aborted once.
        let recorder = Arc::new(Recorder {
            in_place: true,
            ..Recorder::default()
        });
        let mut short = options(&tree, workers);
        short.name_ceiling = total - 1;
        let outcome = walk(tree.clone(), short, vec![recorder.clone()])?;
        let expected = format!("the walk's names exceeded {} bytes", grouped(total - 1));
        match outcome {
            Err(WalkError::Internal(text)) if text == expected => {}
            other => {
                return Err(format!(
                    "{workers} worker(s): expected {expected:?}, got {:?}",
                    other.map(|o| o.len())
                ));
            }
        }
        assert_eq!(recorder.aborts.load(Ordering::SeqCst), 1);
    }
    Ok(())
}

/// Thousands apart, as the walk's fault messages write a number.
fn grouped(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

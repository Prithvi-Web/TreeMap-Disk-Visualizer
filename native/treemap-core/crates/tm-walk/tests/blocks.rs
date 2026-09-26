//! Block numbering (Phase 4, T6; design §S.1.2, §S.2): one block of ids per
//! listing under a commit lock, the stored-name re-sort, the hybrid queue, the
//! big-listing semaphore with its chunked commit, the listing sinks and their
//! abort, the I1–I4 checker. Every test counts; a wait is a hang guard only,
//! never what a passing test depends on.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::panic::panic_any;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use tm_walk::invariants::check_walk_columns;
use tm_walk::platform::{ListBuffer, Lister, Meta};
use tm_walk::walk::Pacer;
use tm_walk::{
    BIG_LISTING, Block, CHUNK_BYTES, FastPath, KIND_DIR, KIND_FILE, ListingSink, Numbering,
    Refusal, SyntheticSpec, WalkCounts, WalkError, WalkHandle, WalkOptions, WalkOutput, lister_for,
    start_with, start_with_sinks, synthetic_temp_folder,
};

type TestResult = Result<(), String>;

/// How long a hang guard waits before a test fails instead of hanging.
const SETTLE: Duration = Duration::from_secs(20);
const POLL: Duration = Duration::from_millis(2);
const WORKERS: [u32; 4] = [1, 2, 8, 64];

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
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

/// A one-shot rendezvous: whoever reaches it says so, then waits for release.
#[derive(Default)]
struct Gate {
    reached: AtomicBool,
    release: AtomicBool,
}

impl Gate {
    fn pass(&self) {
        self.reached.store(true, Ordering::SeqCst);
        let _ = wait_until(|| self.release.load(Ordering::SeqCst));
    }
    fn reached(&self) -> bool {
        self.reached.load(Ordering::SeqCst)
    }
    fn open(&self) {
        self.release.store(true, Ordering::SeqCst);
    }
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

fn file_meta(size: f64, ino: u128, nlink: u32) -> Meta {
    Meta {
        kind: KIND_FILE,
        size,
        alloc: size,
        nlink,
        ..dir_meta(ino)
    }
}

type Listed = Result<Vec<(Vec<u8>, Meta)>, Refusal>;

/// Folders by path; listings sorted by raw name (as the POSIX listers hand
/// theirs over) or in their own order (Windows).
struct Tree {
    root: PathBuf,
    folders: HashMap<PathBuf, Listed>,
    sorted: bool,
    next_ino: u128,
    /// Answers for `stat_dir(root)`, the last repeating.
    root_stats: Mutex<VecDeque<Result<Meta, Refusal>>>,
    /// `list` of this folder waits at the gate first.
    gate: Option<(PathBuf, Arc<Gate>)>,
    /// `list` of this folder panics.
    panic_at: Option<PathBuf>,
    /// Every folder listed, in order, with the entries' room its buffer had.
    listed: Mutex<Vec<(PathBuf, usize)>>,
    /// `stat_dir` calls so far, and the one (zero-based) that panics: call 0 is
    /// the check at the start, call 1 the driver's re-check at the end.
    stat_calls: AtomicU64,
    stat_panic_on: Option<u64>,
}

impl Tree {
    fn new(sorted: bool) -> Self {
        let root = PathBuf::from("/t6");
        let mut folders = HashMap::new();
        folders.insert(root.clone(), Ok(Vec::new()));
        Self {
            root,
            folders,
            sorted,
            next_ino: 100,
            root_stats: Mutex::new(VecDeque::from([Ok(dir_meta(1))])),
            gate: None,
            panic_at: None,
            listed: Mutex::new(Vec::new()),
            stat_calls: AtomicU64::new(0),
            stat_panic_on: None,
        }
    }

    fn abs(&self, rel: &str) -> PathBuf {
        if rel.is_empty() {
            self.root.clone()
        } else {
            self.root.join(rel)
        }
    }

    fn put(&mut self, parent: &str, name: &[u8], meta: Meta) {
        let at = self.abs(parent);
        if let Some(Ok(entries)) = self.folders.get_mut(&at) {
            entries.push((name.to_vec(), meta));
        }
    }

    fn file(&mut self, parent: &str, name: &str, size: f64) {
        self.next_ino += 1;
        let ino = self.next_ino;
        self.put(parent, name.as_bytes(), file_meta(size, ino, 1));
    }

    /// A folder named by raw bytes; its key is its lossy spelling.
    fn dir_raw(&mut self, parent: &str, name: &[u8]) -> String {
        self.next_ino += 1;
        let ino = self.next_ino;
        self.put(parent, name, dir_meta(ino));
        let lossy = String::from_utf8_lossy(name).into_owned();
        let rel = if parent.is_empty() {
            lossy
        } else {
            format!("{parent}/{lossy}")
        };
        let at = self.abs(&rel);
        self.folders.insert(at, Ok(Vec::new()));
        rel
    }

    fn dir(&mut self, parent: &str, name: &str) -> String {
        self.dir_raw(parent, name.as_bytes())
    }

    fn refuse(&mut self, rel: &str, why: Refusal) {
        let at = self.abs(rel);
        self.folders.insert(at, Err(why));
    }

    fn then_root(self, answer: Result<Meta, Refusal>) -> Self {
        lock(&self.root_stats).push_back(answer);
        self
    }

    fn listed(&self) -> Vec<(PathBuf, usize)> {
        lock(&self.listed).clone()
    }

    /// A folder's key: its names under the root, each made lossy, as `dir_raw` files them.
    fn key(&self, dir: &Path) -> PathBuf {
        let Ok(rest) = dir.strip_prefix(&self.root) else {
            return dir.to_path_buf();
        };
        let mut key = self.root.clone();
        for part in rest.components() {
            key.push(part.as_os_str().to_string_lossy().as_ref());
        }
        key
    }
}

impl Lister for Tree {
    #[expect(clippy::panic, reason = "the scripted stat panics on purpose")]
    fn stat_dir(&self, _path: &Path, _want_atime: bool) -> Result<Meta, Refusal> {
        let call = self.stat_calls.fetch_add(1, Ordering::SeqCst);
        if self.stat_panic_on == Some(call) {
            panic_any("fixture panic in the end-of-walk stat".to_owned());
        }
        let mut answers = lock(&self.root_stats);
        if answers.len() > 1 {
            answers.pop_front().unwrap_or(Ok(dir_meta(1)))
        } else {
            answers.front().copied().unwrap_or(Ok(dir_meta(1)))
        }
    }

    #[expect(clippy::panic, reason = "the scripted listing panics on purpose")]
    fn list(
        &self,
        dir: &Path,
        _want_atime: bool,
        buf: &mut ListBuffer,
    ) -> Result<FastPath, Refusal> {
        let key = self.key(dir);
        lock(&self.listed).push((key.clone(), buf.listing.entries.capacity()));
        if self.panic_at.as_ref() == Some(&key) {
            panic_any(format!("fixture panic listing {}", key.display()));
        }
        buf.listing.clear();
        let entries = match self.folders.get(&key) {
            Some(Ok(entries)) => entries,
            Some(Err(why)) => return Err(*why),
            None => return Err(Refusal::Vanished),
        };
        for (name, meta) in entries {
            buf.listing.push(name, *meta);
        }
        if let Some((at, gate)) = &self.gate
            && *at == key
        {
            gate.pass();
        }
        if self.sorted {
            buf.listing.sort_by_name();
        }
        Ok(FastPath::Bulk)
    }
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

fn options(tree: &Tree, numbering: Numbering, workers: u32) -> WalkOptions {
    let mut opts = WalkOptions::new(tree.root.clone());
    opts.numbering = numbering;
    opts.max_workers = usize::try_from(workers).unwrap_or(1);
    opts
}

// ---------------------------------------------------------------------------
// A recording sink
// ---------------------------------------------------------------------------

/// One commit as a sink saw it.
#[derive(Clone, Debug)]
struct Seen {
    folder: u32,
    first: u32,
    len: u32,
    name_base: u64,
    offset: u32,
    names: Vec<Vec<u8>>,
    /// The chunk's staged bytes: its names and its rows.
    bytes: usize,
}

type Matcher = Box<dyn Fn(&Block<'_>) -> bool + Send + Sync>;

#[derive(Default)]
struct Recorder {
    commits: Mutex<Vec<Seen>>,
    refused: Mutex<Vec<(u32, Refusal)>>,
    roots: AtomicU64,
    aborts: AtomicU64,
    /// The first commit matching waits at the gate.
    gate: Option<(Matcher, Arc<Gate>)>,
    gated: AtomicBool,
    /// A commit matching panics.
    panic_on: Option<Matcher>,
}

fn has_name(block: &Block<'_>, name: &str) -> bool {
    block
        .rows
        .iter()
        .any(|row| block.name(row) == name.as_bytes())
}

impl ListingSink for Recorder {
    fn root(&self, _name: &[u8], _meta: &Meta) {
        self.roots.fetch_add(1, Ordering::SeqCst);
    }

    #[expect(clippy::panic, reason = "the recording sink panics on purpose")]
    fn commit(&self, block: &Block<'_>) {
        if self.panic_on.as_ref().is_some_and(|hit| hit(block)) {
            panic_any("fixture panic in a sink".to_owned());
        }
        lock(&self.commits).push(Seen {
            folder: block.folder,
            first: block.first,
            len: block.len,
            name_base: block.name_base,
            offset: block.offset,
            names: block.rows.iter().map(|r| block.name(r).to_vec()).collect(),
            bytes: block.names.len() + size_of_val(block.rows),
        });
        if let Some((hit, gate)) = &self.gate
            && hit(block)
            && !self.gated.swap(true, Ordering::SeqCst)
        {
            gate.pass();
        }
    }

    fn refused(&self, folder: u32, why: Refusal) {
        lock(&self.refused).push((folder, why));
    }

    fn abort(&self) {
        self.aborts.fetch_add(1, Ordering::SeqCst);
    }
}

impl Recorder {
    fn commits(&self) -> Vec<Seen> {
        lock(&self.commits).clone()
    }
    fn aborts(&self) -> u64 {
        self.aborts.load(Ordering::SeqCst)
    }
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

/// Waits for `done`, reads the counts, then takes the output.
fn finish(handle: WalkHandle) -> Result<(WalkOutput, WalkCounts), String> {
    if !wait_until(|| handle.progress().done) {
        return Err("the walk did not finish".to_owned());
    }
    let counts = handle.counts();
    let out = take_within(handle)?.map_err(|e| e.to_string())?;
    Ok((out, counts))
}

fn walk_with(
    tree: Arc<Tree>,
    opts: WalkOptions,
    sinks: Vec<Arc<dyn ListingSink>>,
) -> Result<(WalkOutput, WalkCounts), String> {
    let workers = u32::try_from(opts.max_workers.max(1)).unwrap_or(1);
    let handle = start_with_sinks(opts, Arc::new(Workers(workers)), tree, sinks)
        .map_err(|e| e.to_string())?;
    finish(handle)
}

// ---------------------------------------------------------------------------
// Reading an output
// ---------------------------------------------------------------------------

fn name_of(out: &WalkOutput, i: usize) -> Vec<u8> {
    out.name(i).map(<[u8]>::to_vec).unwrap_or_default()
}

/// Each node's path, from the parent column.
fn paths(out: &WalkOutput) -> Result<Vec<String>, String> {
    let mut all: Vec<String> = Vec::with_capacity(out.len());
    for i in 0..out.len() {
        if i == 0 {
            all.push(String::new());
            continue;
        }
        let parent = *out.parent.get(i).ok_or("no parent")? as usize;
        let above = all.get(parent).ok_or("parent not before its child")?;
        let name = String::from_utf8_lossy(&name_of(out, i)).into_owned();
        all.push(if above.is_empty() {
            name
        } else {
            format!("{above}/{name}")
        });
    }
    Ok(all)
}

/// The names of `parent`'s children in id order.
fn children(out: &WalkOutput, parent: usize) -> Vec<Vec<u8>> {
    (1..out.len())
        .filter(|&i| out.parent.get(i).is_some_and(|&p| p as usize == parent))
        .map(|i| name_of(out, i))
        .collect()
}

/// Every node by path with its facts, and each hard-link family by its
/// smallest member: an output with its numbering taken out.
/// A node's kind, flags (and 0x80 when refused), size and mtime bits, and its
/// hard-link family's smallest member.
type Facts = (u8, u8, u64, u64, Option<String>);

fn by_path(out: &WalkOutput) -> Result<BTreeMap<String, Facts>, String> {
    let all = paths(out)?;
    let mut smallest: HashMap<u32, String> = HashMap::new();
    let mut family: HashMap<u32, u32> = HashMap::new();
    for link in &out.hardlinks {
        let path = all
            .get(link.node as usize)
            .ok_or("hard link out of range")?;
        family.insert(link.node, link.family);
        let entry = smallest.entry(link.family).or_insert_with(|| path.clone());
        if path < entry {
            entry.clone_from(path);
        }
    }
    let refused: HashSet<u32> = out.refusals.iter().map(|r| r.node).collect();
    let mut facts = BTreeMap::new();
    for (i, path) in all.iter().enumerate() {
        let node = u32::try_from(i).map_err(|e| e.to_string())?;
        facts.insert(
            path.clone(),
            (
                out.kind.get(i).copied().unwrap_or(9),
                out.flags.get(i).copied().unwrap_or(9)
                    | if refused.contains(&node) { 0x80 } else { 0 },
                out.size.get(i).copied().unwrap_or(f64::NAN).to_bits(),
                out.mtime_ms.get(i).copied().unwrap_or(f64::NAN).to_bits(),
                family.get(&node).and_then(|f| smallest.get(f)).cloned(),
            ),
        );
    }
    Ok(facts)
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

/// Wide and deep folders, empty and refused ones, a name that is a path, a
/// never-descend folder, a hard-linked pair across folders, invalid UTF-8.
fn mixed_tree(sorted: bool) -> Tree {
    let mut t = Tree::new(sorted);
    for d in 0..12 {
        let rel = t.dir("", &format!("d{d:02}"));
        for f in 0..(d * 7) {
            t.file(&rel, &format!("f{f:03}.bin"), f64::from(f));
        }
        let mut deep = rel.clone();
        for level in 0..(d % 4) {
            deep = t.dir(&deep, &format!("level{level}"));
            t.file(&deep, "leaf.txt", 1.0);
        }
    }
    t.dir("", "empty");
    let denied = t.dir("", "denied");
    t.refuse(&denied, Refusal::Denied);
    let gone = t.dir("", "gone");
    t.refuse(&gone, Refusal::Vanished);
    t.put("", b"sl/ash", dir_meta(9_000));
    let never = t.dir("", "never");
    t.file(&never, "inside.bin", 3.0);
    let a = t.dir("", "links-a");
    let b = t.dir("", "links-b");
    t.put(&a, b"one", file_meta(10.0, 7_000, 2));
    t.put(&b, b"two", file_meta(10.0, 7_000, 2));
    let odd = t.dir_raw("", b"odd\xF8");
    t.put(&odd, b"x\xF9.txt", file_meta(2.0, 7_001, 1));
    t.put(&odd, "x\u{1F600}.txt".as_bytes(), file_meta(3.0, 7_002, 1));
    t
}

fn mixed_options(tree: &Tree, numbering: Numbering, workers: u32) -> WalkOptions {
    let mut opts = options(tree, numbering, workers);
    opts.never_descend = vec![tree.root.join("never")];
    opts
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

#[test]
fn the_test_feature_switches_the_default_numbering() {
    let expected = if cfg!(feature = "blocks-by-default") {
        Numbering::Blocks
    } else {
        Numbering::Discovery
    };
    assert_eq!(WalkOptions::new("/x").numbering, expected);
}

#[test]
fn i1_to_i4_hold_and_every_listing_is_one_block_at_every_worker_count() -> TestResult {
    for workers in WORKERS {
        let tree = Arc::new(mixed_tree(true));
        let opts = mixed_options(&tree, Numbering::Blocks, workers);
        let recorder = Arc::new(Recorder::default());
        let (out, counts) = walk_with(tree.clone(), opts, vec![recorder.clone()])?;
        let at = format!("{workers} worker(s)");
        check_walk_columns(&out.parent, &out.name_off, &out.names, true)
            .map_err(|broken| format!("{at}: {broken}"))?;
        assert_eq!(
            counts.blocks, out.stats.dirs_listed,
            "{at}: one block per listing"
        );
        let commits = recorder.commits();
        let firsts: Vec<u32> = commits.iter().map(|c| c.first).collect();
        assert!(
            firsts.windows(2).all(|w| w.first() <= w.get(1)),
            "{at}: blocks arrive in id order (an empty folder's block is empty): {firsts:?}"
        );
        assert_eq!(
            u64::try_from(commits.len()).ok(),
            Some(out.stats.dirs_listed),
            "{at}"
        );
        let mut next = 1_u32;
        for seen in &commits {
            assert_eq!(seen.first, next, "{at}: the blocks tile the ids");
            assert_eq!(seen.offset, 0, "{at}: no listing here is big");
            assert_eq!(u32::try_from(seen.names.len()).ok(), Some(seen.len), "{at}");
            let kids = children(&out, seen.folder as usize);
            assert_eq!(
                kids, seen.names,
                "{at}: folder {}'s block is its children",
                seen.folder
            );
            let start = out
                .name_off
                .get(seen.first as usize)
                .copied()
                .unwrap_or(u32::MAX);
            assert_eq!(
                u64::from(start),
                seen.name_base,
                "{at}: names reserved in id order"
            );
            next += seen.len;
        }
        assert_eq!(
            usize::try_from(next).ok(),
            Some(out.len()),
            "{at}: every id is in a block"
        );
        assert_eq!(recorder.roots.load(Ordering::SeqCst), 1, "{at}");
        assert_eq!(
            recorder.aborts(),
            0,
            "{at}: a walk with an output aborts nothing"
        );
        let mut refused = lock(&recorder.refused).clone();
        refused.sort_unstable_by_key(|r| r.0);
        let mut expected: Vec<(u32, Refusal)> =
            out.refusals.iter().map(|r| (r.node, r.why)).collect();
        expected.sort_unstable_by_key(|r| r.0);
        assert_eq!(refused, expected, "{at}: the sinks hear every refusal");
        assert_eq!(refused.len(), 3, "{at}: denied, gone and sl/ash");
    }
    Ok(())
}

#[test]
fn a_synthetic_dirheavy_tree_holds_i1_to_i4_at_every_worker_count() -> TestResult {
    let spec = SyntheticSpec {
        folder_ppm: 330_000,
        ..SyntheticSpec::developer(20_000, 3)
    };
    let root = synthetic_temp_folder().join(format!("tm-walk-blocks-{}", std::process::id()));
    let mut reference = None;
    for workers in WORKERS {
        let mut opts = WalkOptions::new(&root);
        opts.numbering = Numbering::Blocks;
        opts.max_workers = usize::try_from(workers).unwrap_or(1);
        opts.synthetic = Some(spec.clone());
        let lister = lister_for(&opts).map_err(|e| e.to_string())?;
        let handle =
            start_with(opts, Arc::new(Workers(workers)), lister).map_err(|e| e.to_string())?;
        let (out, counts) = finish(handle)?;
        check_walk_columns(&out.parent, &out.name_off, &out.names, true)
            .map_err(|broken| format!("{workers} worker(s): {broken}"))?;
        assert_eq!(counts.blocks, out.stats.dirs_listed);
        assert_eq!(out.len(), 20_001);
        let facts = by_path(&out)?;
        match &reference {
            None => reference = Some(facts),
            Some(first) => assert!(first == &facts, "{workers} worker(s) walked another tree"),
        }
    }
    Ok(())
}

#[test]
fn block_and_discovery_numbering_walk_the_same_tree() -> TestResult {
    let tree = Arc::new(mixed_tree(true));
    let discovery = walk_with(
        tree.clone(),
        mixed_options(&tree, Numbering::Discovery, 1),
        Vec::new(),
    )?
    .0;
    let expected = by_path(&discovery)?;
    for workers in WORKERS {
        let blocks = walk_with(
            tree.clone(),
            mixed_options(&tree, Numbering::Blocks, workers),
            Vec::new(),
        )?
        .0;
        let got = by_path(&blocks)?;
        if got != expected {
            let differ = expected
                .iter()
                .find(|(path, facts)| got.get(*path) != Some(facts))
                .map(|(path, _)| path.clone());
            return Err(format!("{workers} worker(s): differs at {differ:?}"));
        }
        assert_eq!(blocks.stats.entries, discovery.stats.entries);
        assert_eq!(blocks.stats.dirs_listed, discovery.stats.dirs_listed);
    }
    Ok(())
}

#[test]
fn names_that_are_not_utf8_end_in_the_stores_order() -> TestResult {
    let emoji = "a\u{1F600}".as_bytes();
    let mut t = Tree::new(true);
    t.put("", b"b", file_meta(1.0, 1_001, 1));
    t.put("", emoji, file_meta(2.0, 1_002, 1));
    t.put("", b"a\xF8", file_meta(3.0, 1_003, 1));
    let pair = t.dir("", "pair");
    t.put(&pair, "c\u{1F600}".as_bytes(), file_meta(6.0, 1_004, 1));
    t.put(&pair, b"c\xF8", file_meta(5.0, 1_005, 1));
    let tree = Arc::new(t);
    for workers in WORKERS {
        let (out, _) = walk_with(
            tree.clone(),
            options(&tree, Numbering::Blocks, workers),
            Vec::new(),
        )?;
        let root: Vec<Vec<u8>> = children(&out, 0);
        let stored_invalid = "a\u{FFFD}".as_bytes().to_vec();
        assert_eq!(
            root,
            [
                stored_invalid,
                emoji.to_vec(),
                b"b".to_vec(),
                b"pair".to_vec()
            ],
            "{workers} worker(s): a\u{FFFD} before a\u{1F600}, as tm-store orders them"
        );
        let pair_id = (1..out.len())
            .find(|&i| name_of(&out, i) == b"pair")
            .ok_or("no pair")?;
        assert_eq!(
            children(&out, pair_id),
            [
                "c\u{FFFD}".as_bytes().to_vec(),
                "c\u{1F600}".as_bytes().to_vec()
            ]
        );
    }
    // The discovery walk keeps the raw order and leaves the re-sort to the build.
    let (out, _) = walk_with(
        tree.clone(),
        options(&tree, Numbering::Discovery, 1),
        Vec::new(),
    )?;
    assert_eq!(children(&out, 0).first().map(Vec::as_slice), Some(emoji));
    Ok(())
}

#[test]
fn a_listing_in_its_own_order_keeps_it() -> TestResult {
    let emoji = "a\u{1F600}".as_bytes();
    let names: [&[u8]; 5] = [b"b", b"a\xF8", emoji, b"A", b"a"];
    let mut t = Tree::new(false);
    for (ino, name) in (2_000..).zip(names) {
        t.put("", name, file_meta(1.0, ino, 1));
    }
    let tree = Arc::new(t);
    for workers in WORKERS {
        let (out, _) = walk_with(
            tree.clone(),
            options(&tree, Numbering::Blocks, workers),
            Vec::new(),
        )?;
        let expected: Vec<Vec<u8>> = names
            .iter()
            .map(|n| String::from_utf8_lossy(n).into_owned().into_bytes())
            .collect();
        assert_eq!(
            children(&out, 0),
            expected,
            "{workers} worker(s): the lister's order stands"
        );
        check_walk_columns(&out.parent, &out.name_off, &out.names, false)
            .map_err(|b| b.to_string())?;
    }
    Ok(())
}

/// A complete tree: every folder above depth `depth` holds `fan` subfolders and one file.
fn complete_tree(fan: u32, depth: u32) -> Tree {
    let mut t = Tree::new(true);
    let mut level = vec![String::new()];
    for _ in 0..depth {
        let mut next = Vec::new();
        for parent in &level {
            t.file(parent, "file.txt", 1.0);
            for k in 0..fan {
                next.push(t.dir(parent, &format!("s{k}")));
            }
        }
        level = next;
    }
    t
}

#[test]
fn the_queue_turns_last_in_first_out_once_it_holds_q_max_jobs() -> TestResult {
    let (fan, depth, q_max) = (4_u32, 6_u32, 16_usize);
    let tree = Arc::new(complete_tree(fan, depth));
    let mut opts = options(&tree, Numbering::Blocks, 1);
    opts.q_max = q_max;
    let (out, counts) = walk_with(tree.clone(), opts, Vec::new())?;
    let listed: Vec<String> = tree
        .listed()
        .iter()
        .map(|(p, _)| {
            p.strip_prefix(&tree.root)
                .map(|r| r.display().to_string())
                .unwrap_or_default()
        })
        .collect();
    // Below Q_MAX the oldest job goes first: the root, then its four
    // subfolders in order (the queue then holds 16). From there the newest.
    assert_eq!(
        listed.get(..6).map(<[String]>::to_vec),
        Some(vec![
            String::new(),
            "s0".to_owned(),
            "s1".to_owned(),
            "s2".to_owned(),
            "s3".to_owned(),
            "s3/s3".to_owned()
        ]),
        "breadth-first, then depth-first"
    );
    let peak = usize::try_from(counts.queue_peak).unwrap_or(usize::MAX);
    let bound = q_max + usize::try_from(depth * fan).unwrap_or(0);
    assert!(
        peak <= bound,
        "one worker's queue peaked at {peak}, past {bound}"
    );
    assert!(
        peak > q_max,
        "the peak ({peak}) passes Q_MAX by the descent: Q_MAX is no cap"
    );
    let folders: u64 = (0..=depth).map(|d| u64::from(fan).pow(d)).sum();
    assert_eq!(out.stats.dirs_listed, folders, "every folder listed once");
    Ok(())
}

#[test]
fn the_queue_peak_stays_within_q_max_and_one_descent_per_worker() -> TestResult {
    let (fan, depth, q_max) = (4_u32, 6_u32, 16_usize);
    let widest = 4_usize.pow(depth);
    for workers in WORKERS {
        let tree = Arc::new(complete_tree(fan, depth));
        let mut opts = options(&tree, Numbering::Blocks, workers);
        opts.q_max = q_max;
        let (_, counts) = walk_with(tree, opts, Vec::new())?;
        let peak = usize::try_from(counts.queue_peak).unwrap_or(usize::MAX);
        let per_worker = usize::try_from((depth + 1) * fan).unwrap_or(0);
        let bound = q_max + usize::try_from(workers).unwrap_or(0) * per_worker;
        assert!(
            peak <= bound,
            "{workers} worker(s): peak {peak} past {bound}"
        );
        assert!(
            bound < widest,
            "the bound ({bound}) must sit below the breadth-first frontier ({widest})"
        );
    }
    Ok(())
}

#[test]
fn a_folder_with_more_subfolders_than_q_max_queues_every_one() -> TestResult {
    let mut t = Tree::new(true);
    for k in 0..100 {
        t.dir("", &format!("s{k:03}"));
    }
    let tree = Arc::new(t);
    let mut opts = options(&tree, Numbering::Blocks, 1);
    opts.q_max = 16;
    let (_, counts) = walk_with(tree, opts, Vec::new())?;
    assert_eq!(
        counts.queue_peak, 100,
        "no order of taking jobs can hold fewer"
    );
    Ok(())
}

#[test]
fn a_lowered_id_ceiling_faults_under_both_numberings() -> TestResult {
    for numbering in [Numbering::Discovery, Numbering::Blocks] {
        let tree = Arc::new(mixed_tree(true));
        let mut opts = mixed_options(&tree, numbering, 2);
        opts.id_ceiling = 10;
        let recorder = Arc::new(Recorder::default());
        let sinks: Vec<Arc<dyn ListingSink>> = match numbering {
            Numbering::Blocks => vec![recorder.clone()],
            Numbering::Discovery => Vec::new(),
        };
        let handle =
            start_with_sinks(opts, Arc::new(Workers(2)), tree, sinks).map_err(|e| e.to_string())?;
        match take_within(handle)? {
            Err(WalkError::Internal(text)) if text == "the walk exceeded 9 entries" => {}
            other => {
                return Err(format!(
                    "{numbering:?}: expected the ceiling fault, got {other:?}"
                ));
            }
        }
        if numbering == Numbering::Blocks {
            assert_eq!(recorder.aborts(), 1);
            let past = recorder.commits().iter().any(|c| c.first + c.len > 10);
            assert!(!past, "no block reaches past the ceiling");
        }
    }
    Ok(())
}

#[test]
fn a_cancel_during_a_listing_commits_nothing_of_it() -> TestResult {
    for files in [3, 300] {
        let gate = Arc::new(Gate::default());
        let mut t = mixed_tree(true);
        let slow = t.dir("", "slow");
        for f in 0..files {
            t.file(&slow, &format!("n{f:04}"), 1.0);
        }
        t.gate = Some((t.abs(&slow), gate.clone()));
        let tree = Arc::new(t);
        let recorder = Arc::new(Recorder::default());
        let handle = start_with_sinks(
            options(&tree, Numbering::Blocks, 2),
            Arc::new(Workers(2)),
            tree,
            vec![recorder.clone()],
        )
        .map_err(|e| e.to_string())?;
        if !wait_until(|| gate.reached()) {
            return Err("the listing never started".to_owned());
        }
        handle.cancel();
        gate.open();
        match take_within(handle)? {
            Err(WalkError::Cancelled) => {}
            other => return Err(format!("expected Cancelled, got {other:?}")),
        }
        let committed_slow = recorder
            .commits()
            .iter()
            .any(|c| c.names.iter().any(|n| n.starts_with(b"n0")));
        assert!(
            !committed_slow,
            "{files} files: the interrupted listing was committed"
        );
        assert_eq!(recorder.aborts(), 1);
    }
    Ok(())
}

/// Whether an outcome is the one a case expects.
type Expect = fn(&WalkError) -> bool;

/// Starts `tree` under block numbering with a recorder; the outcome and the recorder.
fn outcome_of(tree: Tree, workers: u32) -> Result<(Result<(), WalkError>, Arc<Recorder>), String> {
    let tree = Arc::new(tree);
    let recorder = Arc::new(Recorder::default());
    let started = start_with_sinks(
        options(&tree, Numbering::Blocks, workers),
        Arc::new(Workers(workers)),
        tree,
        vec![recorder.clone()],
    );
    let outcome = match started {
        Err(e) => Err(e),
        Ok(handle) => take_within(handle)?.map(drop),
    };
    Ok((outcome, recorder))
}

#[test]
fn every_sink_is_aborted_once_by_every_end_without_an_output() -> TestResult {
    // A fault: a listing panics.
    let mut faulty = mixed_tree(true);
    faulty.panic_at = Some(faulty.abs("d03"));
    // The root refused at the start, not a folder, refused when listed, gone at the end.
    let refused_at_start = Tree::new(true);
    *lock(&refused_at_start.root_stats) = VecDeque::from([Err(Refusal::Denied)]);
    let not_a_folder = Tree::new(true);
    *lock(&not_a_folder.root_stats) = VecDeque::from([Ok(file_meta(1.0, 5, 1))]);
    let mut root_listing_refused = Tree::new(true);
    root_listing_refused.refuse("", Refusal::Unreadable);
    let mut gone_at_end = Tree::new(true).then_root(Err(Refusal::Vanished));
    gone_at_end.file("", "a.bin", 1.0);
    let mut driver_panics = Tree::new(true);
    driver_panics.file("", "a.bin", 1.0);
    driver_panics.stat_panic_on = Some(1);
    let cases: [(&str, Tree, Expect); 6] = [
        (
            "a listing's panic",
            faulty,
            |e| matches!(e, WalkError::Internal(t) if t.contains("fixture panic listing")),
        ),
        ("the root refused at start", refused_at_start, |e| {
            *e == WalkError::RootRefused(Refusal::Denied)
        }),
        ("a root that is not a folder", not_a_folder, |e| {
            *e == WalkError::RootNotDirectory
        }),
        ("the root's listing refused", root_listing_refused, |e| {
            *e == WalkError::RootRefused(Refusal::Unreadable)
        }),
        ("the root gone at the end", gone_at_end, |e| {
            *e == WalkError::RootRefused(Refusal::Vanished)
        }),
        ("a panic on the driver thread", driver_panics, |e| {
            matches!(e, WalkError::Internal(t) if t.contains("driver thread panicked")
                && t.contains("fixture panic in the end-of-walk stat"))
        }),
    ];
    for (what, tree, expected) in cases {
        let (outcome, recorder) = outcome_of(tree, 2)?;
        match outcome {
            Err(e) if expected(&e) => {}
            other => return Err(format!("{what}: unexpected {other:?}")),
        }
        assert_eq!(recorder.aborts(), 1, "{what}: aborted once");
    }
    // Sinks handed to a discovery walk are refused, and aborted.
    let recorder = Arc::new(Recorder::default());
    let tree = Arc::new(Tree::new(true));
    let refused = start_with_sinks(
        options(&tree, Numbering::Discovery, 1),
        Arc::new(Workers(1)),
        tree,
        vec![recorder.clone()],
    );
    assert!(
        matches!(refused, Err(WalkError::OptionsRefused(_))),
        "{:?}",
        refused.err()
    );
    assert_eq!(recorder.aborts(), 1, "refused sinks are aborted");
    // And a walk with an output aborts nothing.
    let (outcome, recorder) = outcome_of(mixed_tree(true), 2)?;
    assert!(outcome.is_ok(), "{outcome:?}");
    assert_eq!(recorder.aborts(), 0);
    Ok(())
}

#[test]
fn a_cancel_while_a_listing_is_staged_commits_nothing_of_it() -> TestResult {
    // One worker lists `slow` (300 entries), pauses at its first check inside
    // the staging loop (entry 256), and is cancelled there: nothing of it may
    // have been reserved or handed on before the loop ended.
    let gate = Arc::new(Gate::default());
    let mut t = Tree::new(true);
    let slow = t.dir("", "slow");
    for f in 0..300 {
        t.file(&slow, &format!("n{f:04}"), 1.0);
    }
    t.gate = Some((t.abs(&slow), gate.clone()));
    let tree = Arc::new(t);
    let recorder = Arc::new(Recorder::default());
    let handle = start_with_sinks(
        options(&tree, Numbering::Blocks, 1),
        Arc::new(Workers(1)),
        tree,
        vec![recorder.clone()],
    )
    .map_err(|e| e.to_string())?;
    if !wait_until(|| gate.reached()) {
        return Err("the listing never started".to_owned());
    }
    handle.pause();
    gate.open();
    if !wait_until(|| handle.counts().paused_workers == 1) {
        return Err("the worker never parked inside the listing".to_owned());
    }
    handle.cancel();
    if !wait_until(|| handle.progress().done) {
        return Err("the walk did not end".to_owned());
    }
    let counts = handle.counts();
    match take_within(handle)? {
        Err(WalkError::Cancelled) => {}
        other => return Err(format!("expected Cancelled, got {other:?}")),
    }
    assert_eq!(
        counts.paused_workers, 0,
        "the parked worker's count went back when the cancel woke it"
    );
    assert_eq!(counts.blocks, 1, "only the root's listing was reserved");
    assert!(
        recorder.commits().iter().all(|c| c.folder == 0),
        "the interrupted listing was handed on"
    );
    assert_eq!(recorder.aborts(), 1);
    Ok(())
}

#[test]
fn a_sinks_panic_is_the_walks_fault() -> TestResult {
    for workers in WORKERS {
        let tree = Arc::new(mixed_tree(true));
        let recorder = Arc::new(Recorder {
            panic_on: Some(Box::new(|block| has_name(block, "f003.bin"))),
            ..Recorder::default()
        });
        let handle = start_with_sinks(
            options(&tree, Numbering::Blocks, workers),
            Arc::new(Workers(workers)),
            tree,
            vec![recorder.clone()],
        )
        .map_err(|e| e.to_string())?;
        match take_within(handle)? {
            Err(WalkError::Internal(text))
                if text.contains("a listing sink panicked")
                    && text.contains("fixture panic in a sink") => {}
            other => {
                return Err(format!(
                    "{workers} worker(s): expected the sink's fault, got {other:?}"
                ));
            }
        }
        assert_eq!(
            recorder.aborts(),
            1,
            "{workers} worker(s): the panicking sink is aborted too"
        );
    }
    Ok(())
}

#[test]
fn a_worker_waiting_on_the_commit_lock_beats_the_heartbeat() -> TestResult {
    let gate = Arc::new(Gate::default());
    let mut t = Tree::new(true);
    for d in ["a", "b", "c"] {
        let rel = t.dir("", d);
        t.file(&rel, "x.bin", 1.0);
    }
    let tree = Arc::new(t);
    let recorder = Arc::new(Recorder {
        gate: Some((Box::new(|block| block.folder != 0), gate.clone())),
        ..Recorder::default()
    });
    let handle = start_with_sinks(
        options(&tree, Numbering::Blocks, 3),
        Arc::new(Workers(3)),
        tree,
        vec![recorder.clone()],
    )
    .map_err(|e| e.to_string())?;
    if !wait_until(|| gate.reached()) {
        return Err("no folder was committed".to_owned());
    }
    // The scripted listings never beat: only a worker waiting on the lock can.
    let beat = wait_until(|| handle.progress().heartbeat > 0);
    gate.open();
    let (out, _) = finish(handle)?;
    assert!(
        beat,
        "a worker waited on the commit lock without beating the heartbeat"
    );
    assert_eq!(out.len(), 7);
    Ok(())
}

/// A tree of two folders of `BIG_LISTING + 50` files each, and one of 3.
fn two_big_folders() -> Tree {
    let mut t = Tree::new(true);
    for d in ["big1", "big2"] {
        let rel = t.dir("", d);
        for f in 0..(BIG_LISTING + 50) {
            t.file(&rel, &format!("{d}-{f:06}"), 1.0);
        }
    }
    let small = t.dir("", "small");
    t.file(&small, "one.txt", 1.0);
    t
}

#[test]
fn big_listings_go_through_the_semaphore_one_at_a_time() -> TestResult {
    let gate = Arc::new(Gate::default());
    let tree = Arc::new(two_big_folders());
    let recorder = Arc::new(Recorder {
        gate: Some((
            Box::new(|block| usize::try_from(block.len).is_ok_and(|len| len > BIG_LISTING)),
            gate.clone(),
        )),
        ..Recorder::default()
    });
    let handle = start_with_sinks(
        options(&tree, Numbering::Blocks, 2),
        Arc::new(Workers(2)),
        tree,
        vec![recorder.clone()],
    )
    .map_err(|e| e.to_string())?;
    if !wait_until(|| gate.reached()) {
        return Err("no big listing was committed".to_owned());
    }
    let queued = wait_until(|| handle.counts().big_waiting == 1);
    let beat = handle.progress().heartbeat > 0;
    gate.open();
    let (out, counts) = finish(handle)?;
    assert!(
        queued,
        "the second big listing never waited on the semaphore"
    );
    assert!(beat, "it waited without beating the heartbeat");
    assert_eq!(counts.big_listings, 2);
    assert_eq!(counts.big_peak, 1, "one big listing at a time");
    check_walk_columns(&out.parent, &out.name_off, &out.names, true).map_err(|b| b.to_string())?;
    Ok(())
}

#[test]
fn a_cancel_ends_a_wait_on_the_semaphore_and_gives_its_count_back() -> TestResult {
    // The first big listing holds the semaphore, gated inside its commit, for
    // the whole test; the second waits on the semaphore. With the gate shut,
    // a cancel is the waiter's only way out, and its count must go with it.
    let gate = Arc::new(Gate::default());
    let tree = Arc::new(two_big_folders());
    let recorder = Arc::new(Recorder {
        gate: Some((
            Box::new(|block| usize::try_from(block.len).is_ok_and(|len| len > BIG_LISTING)),
            gate.clone(),
        )),
        ..Recorder::default()
    });
    let handle = start_with_sinks(
        options(&tree, Numbering::Blocks, 2),
        Arc::new(Workers(2)),
        tree,
        vec![recorder.clone()],
    )
    .map_err(|e| e.to_string())?;
    if !wait_until(|| gate.reached()) {
        return Err("no big listing was committed".to_owned());
    }
    if !wait_until(|| handle.counts().big_waiting == 1) {
        return Err("the second big listing never waited on the semaphore".to_owned());
    }
    handle.cancel();
    let given_back = wait_until(|| handle.counts().big_waiting == 0);
    gate.open();
    match take_within(handle)? {
        Err(WalkError::Cancelled) => {}
        other => return Err(format!("expected Cancelled, got {other:?}")),
    }
    assert!(given_back, "the cancelled waiter kept its count");
    assert_eq!(recorder.aborts(), 1);
    Ok(())
}

#[test]
fn a_big_listing_is_one_block_handed_over_in_chunks() -> TestResult {
    let files: u32 = 70_000;
    let mut t = Tree::new(true);
    let wide = t.dir("", "wide");
    for f in 0..files {
        t.file(
            &wide,
            &format!("a-rather-long-name-for-the-chunks-{f:06}.bin"),
            1.0,
        );
    }
    let tree = Arc::new(t);
    let recorder = Arc::new(Recorder::default());
    let (out, counts) = walk_with(
        tree.clone(),
        options(&tree, Numbering::Blocks, 2),
        vec![recorder.clone()],
    )?;
    let chunks: Vec<Seen> = recorder
        .commits()
        .into_iter()
        .filter(|c| c.len == files)
        .collect();
    assert!(chunks.len() >= 2, "{} chunk(s)", chunks.len());
    let mut offset = 0;
    for chunk in &chunks {
        let first = chunks.first().ok_or("none")?;
        assert_eq!(
            (chunk.folder, chunk.first, chunk.name_base),
            (first.folder, first.first, first.name_base)
        );
        assert_eq!(chunk.offset, offset, "chunks follow each other");
        assert!(
            chunk.bytes < CHUNK_BYTES + 256,
            "a chunk of {} bytes",
            chunk.bytes
        );
        offset += u32::try_from(chunk.names.len()).map_err(|e| e.to_string())?;
    }
    assert_eq!(offset, files, "the chunks hold the listing once");
    assert_eq!(
        counts.blocks, out.stats.dirs_listed,
        "one block, however many chunks"
    );
    check_walk_columns(&out.parent, &out.name_off, &out.names, true).map_err(|b| b.to_string())?;
    Ok(())
}

#[test]
fn a_cancel_while_a_big_listing_is_handed_over_stops_it_between_chunks() -> TestResult {
    // One worker hands a big listing over in chunks. Its first chunk waits at
    // the gate while the walk is paused; released, the worker parks at the
    // first pause check inside the second chunk and is cancelled there. No
    // part of the second chunk may reach a sink.
    let files: u32 = 70_000;
    let gate = Arc::new(Gate::default());
    let mut t = Tree::new(true);
    let wide = t.dir("", "wide");
    for f in 0..files {
        t.file(
            &wide,
            &format!("a-rather-long-name-for-the-chunks-{f:06}.bin"),
            1.0,
        );
    }
    let tree = Arc::new(t);
    let recorder = Arc::new(Recorder {
        gate: Some((
            Box::new(move |block| block.len == files && block.offset == 0),
            gate.clone(),
        )),
        ..Recorder::default()
    });
    let handle = start_with_sinks(
        options(&tree, Numbering::Blocks, 1),
        Arc::new(Workers(1)),
        tree,
        vec![recorder.clone()],
    )
    .map_err(|e| e.to_string())?;
    if !wait_until(|| gate.reached()) {
        return Err("the big listing's first chunk never came".to_owned());
    }
    handle.pause();
    gate.open();
    if !wait_until(|| handle.counts().paused_workers == 1) {
        return Err("the worker never parked inside the second chunk".to_owned());
    }
    handle.cancel();
    match take_within(handle)? {
        Err(WalkError::Cancelled) => {}
        other => return Err(format!("expected Cancelled, got {other:?}")),
    }
    let chunks = recorder.commits().iter().filter(|c| c.len == files).count();
    assert_eq!(chunks, 1, "only the chunk handed over before the cancel");
    assert_eq!(recorder.aborts(), 1);
    Ok(())
}

#[test]
fn a_listing_buffer_shrinks_back_after_a_big_listing() -> TestResult {
    let mut t = Tree::new(true);
    let big = t.dir("", "a-big");
    for f in 0..(BIG_LISTING + 4_000) {
        t.file(&big, &format!("{f:06}"), 1.0);
    }
    t.dir("", "b-after");
    let tree = Arc::new(t);
    walk_with(
        tree.clone(),
        options(&tree, Numbering::Blocks, 1),
        Vec::new(),
    )?;
    let listed = tree.listed();
    let after = listed
        .iter()
        .find(|(p, _)| p.ends_with("b-after"))
        .map(|(_, room)| *room)
        .ok_or("b-after was not listed")?;
    assert!(
        after <= BIG_LISTING,
        "the buffer kept room for {after} entries"
    );
    Ok(())
}

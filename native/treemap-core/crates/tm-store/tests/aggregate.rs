//! AggregateState, T12a (Phase 4; design §S.6.1): position paths, the open frontier, and
//! fold-on-close, held to the walk's own output.
//!
//! Every walk here feeds the aggregate state and the walk's own collector at once, so the
//! columns `take()` returns are the oracle for the same listing: every folder closes exactly
//! once, after every child folder of its own, with the exact totals of its subtree (every
//! file's bytes by the walk's whole-byte rule, as u128), the path the scan would build for it,
//! and its position among its parent's children. Hard links are counted per name here; T12d
//! settles their families.

mod common;

use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use common::scripted::{
    Builder, POSIX_ROOT, ScriptedTree, WIDE_ROOT, WINDOWS_ROOT, folder_meta, posix_tree, wide_tree,
    windows_tree,
};
use tm_store::aggregate::{
    AggregateOptions, AggregateState, CloseObserver, ClosedFolder, PositionPath,
};
use tm_walk::walk::{MAX_WORKERS, Pacer};
use tm_walk::{
    Block, DEFAULT_Q_MAX, FastPath, KIND_DIR, Lister, ListingSink, Numbering, Refusal,
    SyntheticSpec, WalkError, WalkOptions, WalkOutput, lister_for, start_with_sinks,
    synthetic_temp_folder,
};

type TestResult = Result<(), String>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ---------------------------------------------------------------------------
// Position paths
// ---------------------------------------------------------------------------

/// xorshift64*: a fixed, seedable sequence, so a failure names its case.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// An index that often sits at one of the code's boundaries.
    fn index(&mut self) -> u32 {
        const EDGES: [u32; 12] = [
            0,
            1,
            0x7F,
            0x80,
            0x3FFF,
            0x4000,
            0x1F_FFFF,
            0x20_0000,
            0x0FFF_FFFF,
            0x1000_0000,
            u32::MAX - 1,
            u32::MAX,
        ];
        let pick = self.next();
        let edge = EDGES.get(usize::try_from(pick % 16).unwrap_or(0)).copied();
        edge.unwrap_or_else(|| u32::try_from(self.next() >> 40).unwrap_or(0) % 300)
    }

    fn sequence(&mut self) -> Vec<u32> {
        let len = self.next() % 6;
        (0..len).map(|_| self.index()).collect()
    }
}

/// Post-order as design §S.2 states it: a descendant before its ancestor, and otherwise
/// the indices compared in order.
fn post_order(a: &[u32], b: &[u32]) -> Ordering {
    if a.len() < b.len() && b.starts_with(a) {
        Ordering::Greater
    } else if b.len() < a.len() && a.starts_with(b) {
        Ordering::Less
    } else {
        a.cmp(b)
    }
}

#[test]
fn a_position_path_orders_as_its_indices_do_in_pre_order_post_order_and_breadth_first() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for case in 0..20_000 {
        let a = rng.sequence();
        // Half the pairs share a stem, so prefixes and near misses are common.
        let b = if case % 2 == 0 {
            let mut b: Vec<u32> = a.iter().copied().take(a.len() / 2).collect();
            b.extend(rng.sequence());
            b
        } else {
            rng.sequence()
        };
        let (pa, pb) = (
            PositionPath::from_indices(&a),
            PositionPath::from_indices(&b),
        );
        assert_eq!(pa.indices(), a, "round trip of {a:?}");
        assert_eq!(pa.depth(), u32::try_from(a.len()).unwrap_or(u32::MAX));
        // Vec<u32>'s order is pre-order: lexicographic, a prefix first.
        assert_eq!(pa.pre_order(&pb), a.cmp(&b), "pre-order of {a:?} and {b:?}");
        assert_eq!(pa.cmp(&pb), a.cmp(&b), "Ord is pre-order: {a:?} and {b:?}");
        assert_eq!(
            pa.post_order(&pb),
            post_order(&a, &b),
            "post-order of {a:?} and {b:?}"
        );
        assert_eq!(
            pa.breadth_first(&pb),
            (a.len(), &a).cmp(&(b.len(), &b)),
            "breadth-first order of {a:?} and {b:?}"
        );
    }
}

#[test]
fn each_boundary_index_takes_its_own_width_and_a_child_extends_its_parent() {
    let widths = [
        (0, 1),
        (0x7F, 1),
        (0x80, 2),
        (0x3FFF, 2),
        (0x4000, 3),
        (0x1F_FFFF, 3),
        (0x20_0000, 4),
        (0x0FFF_FFFF, 4),
        (0x1000_0000, 5),
        (u32::MAX, 5),
    ];
    for (index, width) in widths {
        let one = PositionPath::root().child(index);
        assert_eq!(one.as_bytes().len(), width, "the width of {index:#x}");
        let two = one.child(index);
        assert!(
            two.as_bytes().starts_with(one.as_bytes()),
            "a child extends {index:#x}"
        );
        assert_eq!(two.indices(), vec![index, index]);
    }
    assert!(PositionPath::root().as_bytes().is_empty());
    assert_eq!(PositionPath::root().depth(), 0);
}

// ---------------------------------------------------------------------------
// Walking into the aggregate state and the collector at once
// ---------------------------------------------------------------------------

/// A pacer that never waits, and lets the walk run as many workers as it asks for.
struct OpenPacer;

impl Pacer for OpenPacer {
    fn on_worker_start(&self) {}
    fn throttle(&self, _cancelled: &dyn Fn() -> bool) {}
    fn worker_limit(&self) -> u32 {
        MAX_WORKERS
    }
}

/// A closed folder as the observer saw it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Closed {
    id: u32,
    path: Vec<u8>,
    position: Vec<u32>,
    depth: u32,
    bytes: u128,
    files: u64,
    folders: u64,
}

#[derive(Default)]
struct Recording {
    closed: Mutex<Vec<Closed>>,
}

impl CloseObserver for Recording {
    fn closed(&self, folder: &ClosedFolder<'_>) {
        lock(&self.closed).push(Closed {
            id: folder.id,
            path: folder.path.to_vec(),
            position: folder.position.indices(),
            depth: folder.depth,
            bytes: folder.bytes,
            files: folder.files,
            folders: folder.folders,
        });
    }
}

enum Source {
    Scripted(Arc<ScriptedTree>),
    Synthetic(SyntheticSpec),
}

struct Fixture {
    name: &'static str,
    root: PathBuf,
    source: Source,
    never_descend: Vec<PathBuf>,
}

const SEP: u8 = b'/';

fn root_bytes(fixture: &Fixture) -> Vec<u8> {
    fixture.root.to_string_lossy().into_owned().into_bytes()
}

/// A folder's child's path as the scan joins it (`joinPath` in `scanStore.ts`).
fn joined(parent: &[u8], name: &[u8]) -> Vec<u8> {
    let mut path = parent.to_vec();
    if path.last() != Some(&SEP) {
        path.push(SEP);
    }
    path.extend_from_slice(name);
    path
}

/// Each row's size as the walk handed it to its sinks: what its listing said.
#[derive(Default)]
struct Listed {
    by_id: Mutex<HashMap<u32, f64>>,
}

impl ListingSink for Listed {
    fn root(&self, _name: &[u8], _meta: &tm_walk::Meta) {}

    fn commit(&self, block: &Block<'_>) {
        let mut by_id = lock(&self.by_id);
        for (step, row) in (0u32..).zip(block.rows) {
            by_id.insert(block.first + block.offset + step, row.meta.size);
        }
    }

    fn refused(&self, _folder: u32, _why: Refusal) {}

    fn abort(&self) {}
}

struct Walked {
    out: WalkOutput,
    listed: HashMap<u32, f64>,
    closed: Vec<Closed>,
    open_after: usize,
}

fn walk(fixture: &Fixture, workers: u32, q_max: usize) -> Result<Walked, String> {
    walk_named(fixture, workers, q_max, root_bytes(fixture))
}

/// [`walk`], the root's path spelled `root_path`.
fn walk_named(
    fixture: &Fixture,
    workers: u32,
    q_max: usize,
    root_path: Vec<u8>,
) -> Result<Walked, String> {
    let recording = Arc::new(Recording::default());
    let state = Arc::new(AggregateState::new(AggregateOptions {
        root_path,
        separator: SEP,
        observer: Some(recording.clone()),
    }));
    let mut opts = WalkOptions::new(fixture.root.clone());
    opts.numbering = Numbering::Blocks;
    opts.max_workers = usize::try_from(workers).unwrap_or(1);
    opts.q_max = q_max;
    opts.never_descend.clone_from(&fixture.never_descend);
    let lister: Arc<dyn Lister> = match &fixture.source {
        Source::Scripted(tree) => Arc::clone(tree) as Arc<dyn Lister>,
        Source::Synthetic(spec) => {
            opts.synthetic = Some(spec.clone());
            lister_for(&opts).map_err(|e| e.to_string())?
        }
    };
    let listed = Arc::new(Listed::default());
    let sinks: Vec<Arc<dyn ListingSink>> = vec![state.clone(), listed.clone()];
    let handle =
        start_with_sinks(opts, Arc::new(OpenPacer), lister, sinks).map_err(|e| e.to_string())?;
    let out = handle.take().map_err(|e| format!("the walk: {e}"))?;
    let closed = lock(&recording.closed).clone();
    let listed = lock(&listed.by_id).clone();
    Ok(Walked {
        out,
        listed,
        closed,
        open_after: state.open_folders(),
    })
}

/// What a folder closes with, from the walk's own columns.
#[derive(Debug, PartialEq, Eq)]
struct Expected {
    path: Vec<u8>,
    position: Vec<u32>,
    bytes: u128,
    files: u64,
    folders: u64,
}

fn whole(size: f64) -> u128 {
    if size.is_finite() && size >= 0.0 {
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a finite size of no less than zero: the walk's own whole-byte rule"
        )]
        let bytes = size as u64;
        u128::from(bytes)
    } else {
        0
    }
}

fn id_of(index: usize) -> Result<u32, String> {
    u32::try_from(index).map_err(|e| e.to_string())
}

fn at_of(id: u32) -> Result<usize, String> {
    usize::try_from(id).map_err(|e| e.to_string())
}

/// Every folder's expectation by id, from `out`: the children of a folder are one range of
/// ids (I2) and every parent's id is below its children's (I3), so positions and paths go up
/// by id and totals come down by id.
///
/// A file's bytes are what its listing said (`listed`, from the blocks the walk handed its
/// sinks): a Windows family is re-read as the walk ends, so `out` can hold another size for
/// it — the correction T12d brings.
fn expected(
    out: &WalkOutput,
    root: &[u8],
    listed: &HashMap<u32, f64>,
) -> Result<HashMap<u32, Expected>, String> {
    let n = out.kind.len();
    let name = |id: usize| -> Result<&[u8], String> {
        let from = at_of(*out.name_off.get(id).ok_or("name offset")?)?;
        let to = at_of(*out.name_off.get(id + 1).ok_or("name end")?)?;
        out.names
            .get(from..to)
            .ok_or_else(|| format!("the name of {id}"))
    };
    let parent_of =
        |id: usize| -> Result<usize, String> { at_of(*out.parent.get(id).ok_or("parent")?) };
    let mut first_child = vec![u32::MAX; n];
    for id in 1..n {
        let slot = first_child.get_mut(parent_of(id)?).ok_or("first child")?;
        *slot = (*slot).min(id_of(id)?);
    }
    let mut positions: Vec<Vec<u32>> = vec![Vec::new(); n];
    let mut paths: Vec<Vec<u8>> = vec![Vec::new(); n];
    *paths.first_mut().ok_or("no root")? = root.to_vec();
    for id in 1..n {
        let parent = parent_of(id)?;
        let index = id_of(id)? - *first_child.get(parent).ok_or("first child")?;
        let mut position = positions.get(parent).ok_or("parent position")?.clone();
        position.push(index);
        *positions.get_mut(id).ok_or("position")? = position;
        let path = joined(paths.get(parent).ok_or("parent path")?, name(id)?);
        *paths.get_mut(id).ok_or("path")? = path;
    }
    let mut bytes = vec![0u128; n];
    let mut files = vec![0u64; n];
    let mut folders = vec![0u64; n];
    for id in 0..n {
        if *out.kind.get(id).ok_or("kind")? != KIND_DIR {
            let size = *listed
                .get(&id_of(id)?)
                .ok_or_else(|| format!("no block held row {id}"))?;
            *bytes.get_mut(id).ok_or("bytes")? = whole(size);
            *files.get_mut(id).ok_or("files")? = 1;
        }
    }
    for id in (1..n).rev() {
        let parent = parent_of(id)?;
        let is_dir = u64::from(*out.kind.get(id).ok_or("kind")? == KIND_DIR);
        let (b, f, d) = (
            *bytes.get(id).ok_or("bytes")?,
            *files.get(id).ok_or("files")?,
            *folders.get(id).ok_or("folders")?,
        );
        *bytes.get_mut(parent).ok_or("parent bytes")? += b;
        *files.get_mut(parent).ok_or("parent files")? += f;
        *folders.get_mut(parent).ok_or("parent folders")? += d + is_dir;
    }
    let mut by_id = HashMap::new();
    for id in 0..n {
        if *out.kind.get(id).ok_or("kind")? == KIND_DIR {
            by_id.insert(
                id_of(id)?,
                Expected {
                    path: paths.get(id).ok_or("path")?.clone(),
                    position: positions.get(id).ok_or("position")?.clone(),
                    bytes: *bytes.get(id).ok_or("bytes")?,
                    files: *files.get(id).ok_or("files")?,
                    folders: *folders.get(id).ok_or("folders")?,
                },
            );
        }
    }
    Ok(by_id)
}

/// Holds one walk's closes to its columns.
fn check(walked: &Walked, root: &[u8], at: &str) -> TestResult {
    let expected = expected(&walked.out, root, &walked.listed)?;
    assert_eq!(walked.open_after, 0, "{at}: nothing is left open");
    assert_eq!(
        walked.closed.len(),
        expected.len(),
        "{at}: every folder closes exactly once"
    );
    let mut closed_at: HashMap<u32, usize> = HashMap::new();
    for (order, closed) in walked.closed.iter().enumerate() {
        assert!(
            closed_at.insert(closed.id, order).is_none(),
            "{at}: folder {} closed twice",
            closed.id
        );
        let want = expected
            .get(&closed.id)
            .ok_or_else(|| format!("{at}: {} closed, and it is no folder", closed.id))?;
        let got = Expected {
            path: closed.path.clone(),
            position: closed.position.clone(),
            bytes: closed.bytes,
            files: closed.files,
            folders: closed.folders,
        };
        assert_eq!(&got, want, "{at}: folder {}", closed.id);
        assert_eq!(
            closed.depth,
            u32::try_from(want.position.len()).unwrap_or(u32::MAX),
            "{at}: the depth of folder {}",
            closed.id
        );
    }
    // A folder closes after every child folder of its own: its parent closes later.
    for id in 1..walked.out.kind.len() {
        if walked.out.kind.get(id).copied() != Some(KIND_DIR) {
            continue;
        }
        let parent = *walked.out.parent.get(id).ok_or("parent")?;
        let own = id_of(id)?;
        assert!(
            closed_at.get(&own) < closed_at.get(&parent),
            "{at}: folder {own} closes before its parent {parent}"
        );
    }
    assert_eq!(
        walked.closed.last().map(|c| c.id),
        Some(0),
        "{at}: the root closes last"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MIXED_ROOT: &str = "/t12a/mixed";
const DEEP_ROOT: &str = "/t12a/deep";
const CHUNKED_ROOT: &str = "/t12a/chunked";

/// Wide and deep folders, empty ones, refused ones, a name that is a path, a
/// never-descend folder, names that are not UTF-8.
fn mixed_tree() -> Result<ScriptedTree, String> {
    let mut b = Builder::with_root();
    for d in 0..12_u32 {
        let rel = b.dir("", format!("d{d:02}").as_bytes())?;
        for f in 0..(d * 7) {
            b.file(&rel, format!("f{f:03}.bin").as_bytes(), f64::from(f))?;
        }
        let mut deep = rel.clone();
        for level in 0..(d % 4) {
            deep = b.dir(&deep, format!("level{level}").as_bytes())?;
            b.file(&deep, b"leaf.txt", 1.0)?;
            b.dir(&deep, b"empty-inside")?;
        }
    }
    b.dir("", b"empty")?;
    b.refused("", b"denied", Refusal::Denied)?;
    b.refused("", b"gone", Refusal::Vanished)?;
    b.put_new("", b"sl/ash", folder_meta)?;
    let never = b.dir("", b"never")?;
    b.file(&never, b"inside.bin", 3.0)?;
    let odd = b.dir("", b"odd\xF8")?;
    b.file(&odd, b"x\xF9.txt", 2.0)?;
    b.file(&odd, "x\u{1F600}.txt".as_bytes(), 3.0)?;
    Ok(b.finish(MIXED_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// One chain 300 folders deep, a file at every level.
fn deep_tree() -> Result<ScriptedTree, String> {
    let mut b = Builder::with_root();
    let mut at = String::new();
    for level in 0..300_u32 {
        at = b.dir(&at, format!("l{level}").as_bytes())?;
        b.file(&at, b"f.bin", f64::from(level))?;
    }
    Ok(b.finish(DEEP_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// One folder of 70,000 entries with long names, which the walk hands on in several 4 MiB
/// chunks: every 997th a folder holding a file, so folders arrive in every chunk and each
/// one's position counts the rows of the chunks before it.
fn chunked_tree() -> Result<ScriptedTree, String> {
    let mut b = Builder::with_root();
    let wide = b.dir("", b"wide")?;
    for i in 0..70_000_u32 {
        let stem = format!("a-rather-long-name-so-a-chunk-holds-fewer-rows-{i:06}");
        if i % 997 == 0 {
            let folder = b.dir(&wide, format!("{stem}-d").as_bytes())?;
            b.file(&folder, b"inside.bin", f64::from(i))?;
        } else {
            b.file(&wide, format!("{stem}-f.bin").as_bytes(), f64::from(i % 50))?;
        }
    }
    Ok(b.finish(CHUNKED_ROOT, folder_meta(1), true, FastPath::Bulk))
}

fn scripted(name: &'static str, root: &str, tree: ScriptedTree) -> Fixture {
    Fixture {
        name,
        root: PathBuf::from(root),
        source: Source::Scripted(Arc::new(tree)),
        never_descend: Vec::new(),
    }
}

fn scripted_fixtures() -> Result<Vec<Fixture>, String> {
    let mut mixed = scripted("mixed", MIXED_ROOT, mixed_tree()?);
    mixed.never_descend = vec![mixed.root.join("never")];
    let mut posix = scripted("posix", POSIX_ROOT, posix_tree()?);
    posix.never_descend = vec![posix.root.join("Volumes")];
    Ok(vec![
        mixed,
        posix,
        scripted("windows", WINDOWS_ROOT, windows_tree()?),
        scripted("wide (chunks)", WIDE_ROOT, wide_tree()?),
        scripted(
            "chunked, folders in every chunk",
            CHUNKED_ROOT,
            chunked_tree()?,
        ),
        scripted("deep", DEEP_ROOT, deep_tree()?),
    ])
}

fn synthetic_fixtures() -> Vec<Fixture> {
    let developer = |seed| SyntheticSpec::developer(30_000, seed);
    let synthetic = |name, spec| Fixture {
        name,
        root: synthetic_temp_folder().join("t12a"),
        source: Source::Synthetic(spec),
        never_descend: Vec::new(),
    };
    vec![
        synthetic("synthetic developer seed 1", developer(1)),
        synthetic(
            "synthetic folders 33%",
            SyntheticSpec {
                folder_ppm: 330_000,
                ..developer(2)
            },
        ),
        synthetic(
            "synthetic folders 1%",
            SyntheticSpec {
                folder_ppm: 10_000,
                ..developer(3)
            },
        ),
    ]
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

const WORKERS: [u32; 3] = [1, 4, 8];

#[test]
fn every_folder_closes_once_after_its_children_with_its_subtrees_totals_on_scripted_trees()
-> TestResult {
    for fixture in scripted_fixtures()? {
        let root = root_bytes(&fixture);
        for workers in WORKERS {
            for q_max in [DEFAULT_Q_MAX, 2] {
                let walked = walk(&fixture, workers, q_max)?;
                check(
                    &walked,
                    &root,
                    &format!("{} at {workers} worker(s), q_max {q_max}", fixture.name),
                )?;
            }
        }
    }
    Ok(())
}

#[test]
fn every_folder_closes_once_after_its_children_with_its_subtrees_totals_on_synthetic_trees()
-> TestResult {
    for fixture in synthetic_fixtures() {
        let root = root_bytes(&fixture);
        for workers in WORKERS {
            let walked = walk(&fixture, workers, DEFAULT_Q_MAX)?;
            check(
                &walked,
                &root,
                &format!("{} at {workers} worker(s)", fixture.name),
            )?;
        }
    }
    Ok(())
}

#[test]
fn a_root_path_that_ends_with_the_separator_takes_no_second_one() -> TestResult {
    // A scan of `/` names its root with the separator at its end, and `joinPath` adds none
    // after it; every other path here gains one.
    let fixture = scripted("mixed", MIXED_ROOT, mixed_tree()?);
    let root = format!("{MIXED_ROOT}/").into_bytes();
    let walked = walk_named(&fixture, 4, DEFAULT_Q_MAX, root.clone())?;
    check(&walked, &root, "the root path spelled with its separator")?;
    let first = walked
        .closed
        .iter()
        .find(|c| c.depth == 1)
        .ok_or("no folder below the root")?;
    assert!(
        !first.path.windows(2).any(|w| w == b"//"),
        "no doubled separator: {}",
        String::from_utf8_lossy(&first.path)
    );
    Ok(())
}

/// A lister that holds one folder's listing until told to go on, so a cancel lands with
/// folders open.
struct Holding {
    tree: Arc<ScriptedTree>,
    reached: AtomicBool,
    release: AtomicBool,
}

impl Lister for Holding {
    fn stat_dir(&self, path: &std::path::Path, want_atime: bool) -> Result<tm_walk::Meta, Refusal> {
        self.tree.stat_dir(path, want_atime)
    }

    fn list(
        &self,
        dir: &std::path::Path,
        want_atime: bool,
        buf: &mut tm_walk::platform::ListBuffer,
    ) -> Result<FastPath, Refusal> {
        if dir.ends_with("d05") {
            self.reached.store(true, AtomicOrdering::SeqCst);
            while !self.release.load(AtomicOrdering::SeqCst) && !buf.stopped() {
                std::thread::yield_now();
                buf.beat();
            }
        }
        self.tree.list(dir, want_atime, buf)
    }
}

#[test]
fn a_cancelled_walk_leaves_nothing_open_and_the_root_never_closes() -> TestResult {
    let holding = Arc::new(Holding {
        tree: Arc::new(mixed_tree()?),
        reached: AtomicBool::new(false),
        release: AtomicBool::new(false),
    });
    let recording = Arc::new(Recording::default());
    let state = Arc::new(AggregateState::new(AggregateOptions {
        root_path: MIXED_ROOT.as_bytes().to_vec(),
        separator: SEP,
        observer: Some(recording.clone()),
    }));
    let mut opts = WalkOptions::new(MIXED_ROOT);
    opts.numbering = Numbering::Blocks;
    opts.max_workers = 2;
    let sinks: Vec<Arc<dyn ListingSink>> = vec![state.clone()];
    let handle = start_with_sinks(opts, Arc::new(OpenPacer), holding.clone(), sinks)
        .map_err(|e| e.to_string())?;
    let started = std::time::Instant::now();
    while !holding.reached.load(AtomicOrdering::SeqCst) {
        if started.elapsed() > std::time::Duration::from_secs(30) {
            return Err("d05's listing never began".to_owned());
        }
        std::thread::yield_now();
    }
    assert!(
        state.open_folders() > 0,
        "folders are open while d05 is held"
    );
    handle.cancel();
    holding.release.store(true, AtomicOrdering::SeqCst);
    match handle.take() {
        Err(WalkError::Cancelled) => {}
        other => {
            return Err(format!(
                "expected Cancelled, got {:?}",
                other.map(|o| o.stats.entries)
            ));
        }
    }
    assert_eq!(
        state.open_folders(),
        0,
        "the abort dropped every open folder"
    );
    assert!(
        lock(&recording.closed).iter().all(|c| c.id != 0),
        "the root never closed"
    );
    Ok(())
}

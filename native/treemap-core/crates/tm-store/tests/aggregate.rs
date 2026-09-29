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
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

use common::aggregate::{
    MIXED_ROOT, OpenPacer, Recording, SEP, WORKERS, Walked, at_of, hand_listing, id_of, joined,
    lock, mixed_tree, new_state, root_bytes, scripted, scripted_fixtures, synthetic_fixtures, walk,
    walk_named, whole,
};
use common::scripted::{BLOCK, ScriptedTree, file_meta, folder_meta};
use tm_store::aggregate::{
    AggregateOptions, AggregateState, EXTENSION_LIMIT, KeepLimits, PositionPath,
};
use tm_walk::{
    Block, DEFAULT_Q_MAX, FastPath, Finishing, KIND_DIR, Lister, ListingSink, Meta, Numbering,
    Refusal, WalkError, WalkOptions, WalkOutput, start_with_sinks,
};

type TestResult = Result<(), String>;

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
        let mut up = a.clone();
        let parent = up.pop().map(|_| PositionPath::from_indices(&up));
        assert_eq!(pa.parent(), parent, "the parent of {a:?}");
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
        assert_eq!(
            two.parent(),
            Some(one.clone()),
            "the parent of {index:#x}'s child"
        );
    }
    assert!(PositionPath::root().as_bytes().is_empty());
    assert_eq!(PositionPath::root().depth(), 0);
    assert_eq!(
        PositionPath::root().parent(),
        None,
        "the root has no parent"
    );
}

// ---------------------------------------------------------------------------
// Walking into the aggregate state and the collector at once
// ---------------------------------------------------------------------------

/// What a folder closes with, from the walk's own columns.
#[derive(Debug, PartialEq, Eq)]
struct Expected {
    path: Vec<u8>,
    position: Vec<u32>,
    bytes: u128,
    files: u64,
    folders: u64,
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
// The tests
// ---------------------------------------------------------------------------

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
        extension_limit: EXTENSION_LIMIT,
        keep: KeepLimits::default(),
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
    assert_eq!(
        state.shallow_rows_held(),
        0,
        "the abort dropped what the shallow keep held"
    );
    assert!(
        state.summary().is_err(),
        "a cancelled walk has nothing to seal"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// The sink's own calls, driven without a walk, and a walk that breaks a promise (T12f:
// the gaps `cargo mutants` found)
// ---------------------------------------------------------------------------

/// A root holding `a.bin`, `b.txt` and folder `d`, which holds `c.bin`: `a.bin` and `c.bin`
/// name one 300-byte file, so the link log has a later name to settle.
fn hand_linked_tree(state: &AggregateState) -> TestResult {
    let family = file_meta(300.0, BLOCK, 7_000, 2);
    state.root(b"linked", &folder_meta(1));
    hand_listing(
        state,
        0,
        1,
        &[
            (b"a.bin".as_slice(), family),
            (b"b.txt".as_slice(), file_meta(20.0, BLOCK, 7_001, 1)),
            (b"d".as_slice(), folder_meta(2)),
        ],
    )?;
    hand_listing(state, 3, 4, &[(b"c.bin".as_slice(), family)])
}

#[test]
fn an_abort_leaves_the_state_answering_as_a_new_one() -> TestResult {
    let state = new_state(b"/t12f/linked", None, KeepLimits::default());
    hand_linked_tree(&state)?;
    assert_eq!(
        (state.answers().files, state.open_folders()),
        (3, 0),
        "every file was counted and the root closed"
    );
    assert!(
        state.summary().is_ok(),
        "the walk had finished, so the state would seal"
    );
    state.abort();
    assert_eq!(
        state.answers(),
        new_state(b"/t12f/linked", None, KeepLimits::default()).answers(),
        "an abort drops every file, extension, histogram count and hard link that was counted"
    );
    let refused = state.summary();
    assert!(
        refused
            .as_ref()
            .is_err_and(|why| why.contains("has not finished")),
        "an aborted walk has nothing to seal: {refused:?}"
    );
    Ok(())
}

#[test]
fn a_size_that_is_no_finite_count_of_bytes_counts_none_as_the_walk_counts_it() -> TestResult {
    // The walk's whole-byte rule (tm-walk's `whole_bytes`, which its own byte count uses): a
    // finite size of no less than zero, its fraction dropped, saturating past u64::MAX; any
    // other size — NaN, a negative one, either infinity — counts 0. No platform's listing
    // gives such a size (each reads an integer), but a lister may hand one on.
    let recording = Arc::new(Recording::default());
    let state = new_state(
        b"/t12f/sizes",
        Some(recording.clone()),
        KeepLimits::default(),
    );
    state.root(b"sizes", &folder_meta(1));
    let sizes = [
        (b"infinite".as_slice(), f64::INFINITY, 0),
        (b"nan", f64::NAN, 0),
        (b"minus-infinite", f64::NEG_INFINITY, 0),
        (b"negative", -1.0, 0),
        (b"fraction", 2.5, 2),
        (b"past-u64", 1e30, u64::MAX),
    ];
    let rows: Vec<(&[u8], Meta)> = sizes
        .iter()
        .zip(7_100_u128..)
        .map(|(&(name, size, _), ino)| (name, file_meta(size, 0.0, ino, 1)))
        .collect();
    hand_listing(&state, 0, 1, &rows)?;
    let answers = state.answers();
    for (name, size, counted) in sizes {
        let file = answers
            .largest_files
            .iter()
            .find(|file| file.name == name)
            .ok_or_else(|| format!("{} was not listed", String::from_utf8_lossy(name)))?;
        assert_eq!(
            file.size, counted,
            "a size of {size} counts {counted} bytes, as the walk counts it"
        );
    }
    let root = lock(&recording.closed)
        .iter()
        .find(|closed| closed.id == 0)
        .map(|closed| closed.bytes);
    assert_eq!(
        root,
        Some(u128::from(u64::MAX) + 2),
        "the root holds what its files count, and nothing for the sizes that count none"
    );
    Ok(())
}

/// Hands the state every call of a walk, but breaks one of the walk's promises when told
/// to: every skip forgotten, so a never-descend folder is never ended; or every refusal said
/// twice, so a folder ends that is no longer open.
struct Breaking {
    state: Arc<AggregateState>,
    forget_skips: bool,
    refuse_twice: bool,
}

impl ListingSink for Breaking {
    fn root(&self, name: &[u8], meta: &Meta) {
        self.state.root(name, meta);
    }

    fn commit(&self, block: &Block<'_>) {
        self.state.commit(block);
    }

    fn refused(&self, folder: u32, why: Refusal) {
        self.state.refused(folder, why);
        if self.refuse_twice {
            self.state.refused(folder, why);
        }
    }

    fn skipped(&self, folder: u32) {
        if !self.forget_skips {
            self.state.skipped(folder);
        }
    }

    fn abort(&self) {
        self.state.abort();
    }

    fn finish(&self, ending: &Finishing<'_>) -> Result<(), String> {
        self.state.finish(ending)
    }
}

#[test]
fn finish_refuses_a_walk_that_left_a_folder_open_or_broke_a_promise() -> TestResult {
    // The mixed tree has a never-descend folder, `never`, and two refused ones.
    let tree: Arc<dyn Lister> = Arc::new(mixed_tree()?);
    for (forget_skips, refuse_twice, refusal) in [
        (false, false, None),
        (
            true,
            false,
            Some("2 folder(s) were still open when the walk finished"),
        ),
        (false, true, Some("ended, and it is not open")),
    ] {
        let at = format!("skips forgotten {forget_skips}, refusals said twice {refuse_twice}");
        let sink = Arc::new(Breaking {
            state: Arc::new(new_state(
                MIXED_ROOT.as_bytes(),
                None,
                KeepLimits::default(),
            )),
            forget_skips,
            refuse_twice,
        });
        let mut opts = WalkOptions::new(MIXED_ROOT);
        opts.numbering = Numbering::Blocks;
        opts.max_workers = 1;
        opts.never_descend = vec![std::path::Path::new(MIXED_ROOT).join("never")];
        let sinks: Vec<Arc<dyn ListingSink>> = vec![sink];
        let taken = start_with_sinks(opts, Arc::new(OpenPacer), Arc::clone(&tree), sinks)
            .map_err(|e| e.to_string())?
            .take();
        match (refusal, taken) {
            (None, Ok(_)) => {}
            (Some(said), Err(WalkError::Internal(why))) => assert!(
                why.starts_with("the aggregate state: ") && why.contains(said),
                "{at}: the walk is refused with the state's reason ({said}), not {why:?}"
            ),
            (want, got) => {
                return Err(format!(
                    "{at}: expected {}, got {:?}",
                    want.map_or_else(
                        || "the walk's output".to_owned(),
                        |said| format!("the state to refuse the walk ({said})")
                    ),
                    got.map(|out| out.stats.entries)
                ));
            }
        }
    }
    Ok(())
}

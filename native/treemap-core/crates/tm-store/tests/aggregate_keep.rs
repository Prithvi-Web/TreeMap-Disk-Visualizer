//! AggregateState, T12c (Phase 4; design §S.6.1–§S.6.2): the β heaps, the kept set, the
//! shallow keep and the summary, held to the full tree `build` makes of the same walk. From
//! that tree the oracle computes β, D_s, the kept set and each kept folder's omitted tally
//! directly — the tally summed from the children that were not kept, not by subtraction — so
//! the state's totals-minus-kept-children and the tree's own sums must meet.

mod common;

use std::cmp::{Ordering, Reverse};
use std::collections::HashMap;

use common::aggregate::{
    CHUNKED_ROOT, DEEP_ROOT, Fixture, MIXED_ROOT, SEP, Source, WORKERS, Walked, chunked_tree,
    deep_tree, hand_listing, mixed_tree, new_state, scripted, walk_kept,
};
use common::scripted::{Builder, WIDE_ROOT, folder_meta, wide_tree};
use tm_store::aggregate::{
    AggregateOptions, AggregateState, EXTENSION_LIMIT, Exactness, FolderRow, KeepLimits, Omitted,
    PositionPath, Summary, SummaryRow,
};
use tm_store::derive::store_mtime;
use tm_store::{BuildOptions, Store, StoreMode, build, flag};
use tm_walk::{DEFAULT_Q_MAX, FastPath, ListingSink, SyntheticSpec, synthetic_temp_folder};

type TestResult = Result<(), String>;

// ---------------------------------------------------------------------------
// The full tree of the same walk
// ---------------------------------------------------------------------------

fn get<T: Copy>(column: &[T], id: usize, what: &str) -> Result<T, String> {
    column
        .get(id)
        .copied()
        .ok_or_else(|| format!("row {id} is past the {what} column"))
}

/// One row of the full tree, with its subtree's totals.
struct Node {
    parent: Option<usize>,
    depth: u32,
    position: PositionPath,
    name: Vec<u8>,
    dir: bool,
    bytes: u128,
    files: u64,
    folders: u64,
    modified_at: f64,
    kids: Vec<usize>,
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

fn name_of(store: &Store, id: usize) -> Result<Vec<u8>, String> {
    let off = store.name_off.as_slice();
    let (start, end) = (get(off, id, "nameOff")?, get(off, id + 1, "nameOff")?);
    store
        .names
        .as_slice()
        .get(start as usize..end as usize)
        .map(<[u8]>::to_vec)
        .ok_or_else(|| format!("row {id}'s name is outside the names"))
}

/// The fixture's root's name, as the walk names its root: the last part of its path.
fn root_name_of(fixture: &Fixture) -> String {
    fixture
        .root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn build_of(walked: &Walked, root_name: &str) -> Result<Store, String> {
    build(
        walked.out.clone(),
        &BuildOptions {
            root_name: root_name.to_owned(),
            root_mtime_ms: 0.0,
            blocks_are_meaningful: true,
            sort_children: true,
            container_rules: Vec::new(),
            cloud_rules: Vec::new(),
            headroom_rows: 0,
            mode: StoreMode::Memory,
        },
    )
    .map_err(|e| format!("build: {e}"))
}

/// The full tree of `store`, whose ids are breadth-first: a folder's children form one
/// range in child order, after it. The root's time is `root_mtime`, as the walk read it.
fn tree_of(store: &Store, root_mtime: f64) -> Result<Vec<Node>, String> {
    let flags = store.flags.as_slice();
    let mut nodes = Vec::with_capacity(flags.len());
    for id in 0..flags.len() {
        let dir = get(flags, id, "flags")? & flag::DIR != 0;
        let kids = if dir {
            let first = get(store.child_start.as_slice(), id, "childStart")? as usize;
            let count = get(store.child_cnt.as_slice(), id, "childCnt")? as usize;
            (first..first + count).collect()
        } else {
            Vec::new()
        };
        nodes.push(Node {
            parent: None,
            depth: 0,
            position: PositionPath::root(),
            name: name_of(store, id)?,
            dir,
            bytes: if dir {
                0
            } else {
                whole(get(store.size.as_slice(), id, "size")?)
            },
            files: 0,
            folders: 0,
            modified_at: if id == 0 {
                root_mtime
            } else {
                get(store.mtime.as_slice(), id, "mtime")?
            },
            kids,
        });
    }
    for id in 0..nodes.len() {
        let (kids, depth, position) = {
            let node = nodes.get(id).ok_or("a row vanished")?;
            (node.kids.clone(), node.depth, node.position.clone())
        };
        for (index, kid) in (0_u32..).zip(kids) {
            let child = nodes
                .get_mut(kid)
                .ok_or_else(|| format!("row {id}'s child {kid} is past the rows"))?;
            child.parent = Some(id);
            child.depth = depth + 1;
            child.position = position.child(index);
        }
    }
    for id in (1..nodes.len()).rev() {
        let (parent, dir, bytes, files, folders) = {
            let node = nodes.get(id).ok_or("a row vanished")?;
            let parent = node
                .parent
                .ok_or_else(|| format!("row {id} has no parent"))?;
            (parent, node.dir, node.bytes, node.files, node.folders)
        };
        let up = nodes.get_mut(parent).ok_or("a parent vanished")?;
        up.bytes += bytes;
        if dir {
            up.files += files;
            up.folders += folders + 1;
        } else {
            up.files += 1;
        }
    }
    Ok(nodes)
}

// ---------------------------------------------------------------------------
// The oracle: β, D_s, the kept set and the summary, from the full tree
// ---------------------------------------------------------------------------

/// The smallest of the `capacity` largest values, when there are that many (a capacity
/// below 1 counts as 1, as the state takes it).
fn threshold(mut values: Vec<u128>, capacity: usize) -> Option<u128> {
    let capacity = capacity.max(1);
    if values.len() < capacity {
        return None;
    }
    values.sort_unstable_by(|a, b| b.cmp(a));
    values.get(capacity - 1).copied()
}

fn above(value: u128, threshold: Option<u128>) -> bool {
    threshold.is_none_or(|beta| value > beta)
}

fn top_of(depth: u32, limits: &KeepLimits) -> usize {
    if depth == 0 {
        limits.root_top
    } else {
        limits.shallow_top
    }
}

/// D_s: the deepest depth whose shallow rows, with every shallower depth's, fit the cap. A
/// folder adds its top children, as many as it has; the root's always fit.
fn shallow_depth(nodes: &[Node], limits: &KeepLimits) -> Result<u32, String> {
    let mut rows: Vec<usize> = Vec::new();
    for node in nodes.iter().filter(|node| node.dir) {
        let adds = top_of(node.depth, limits).min(node.kids.len());
        if adds == 0 {
            continue;
        }
        let at = node.depth as usize;
        if rows.len() <= at {
            rows.resize(at + 1, 0);
        }
        *rows.get_mut(at).ok_or("a depth vanished")? += adds;
    }
    let mut total = 0;
    let mut depth = 0;
    for (at, adds) in (0_u32..).zip(&rows) {
        total += adds;
        if at > 0 && total > limits.shallow_rows {
            break;
        }
        depth = at;
    }
    Ok(depth)
}

fn is_kept(kept: &[bool], id: usize) -> bool {
    matches!(kept.get(id), Some(true))
}

fn expected(nodes: &[Node], limits: &KeepLimits) -> Result<Summary, String> {
    let folder_threshold = threshold(
        nodes
            .iter()
            .filter(|node| node.dir && node.depth > 0)
            .map(|node| node.bytes)
            .collect(),
        limits.folder_heap,
    );
    let file_threshold = threshold(
        nodes
            .iter()
            .filter(|node| !node.dir)
            .map(|node| node.bytes)
            .collect(),
        limits.file_heap,
    );
    let shallow_depth = shallow_depth(nodes, limits)?;
    let mut kept: Vec<bool> = nodes
        .iter()
        .map(|node| {
            if node.depth == 0 {
                true
            } else if node.dir {
                above(node.bytes, folder_threshold)
            } else {
                above(node.bytes, folder_threshold) && above(node.bytes, file_threshold)
            }
        })
        .collect();
    // In id order, which is breadth-first: every kept folder at depth ≤ D_s, whether β or
    // its parent's top children kept it, keeps its own top children.
    for (id, node) in nodes.iter().enumerate() {
        if !is_kept(&kept, id) || !node.dir || node.depth > shallow_depth {
            continue;
        }
        let mut kids = node.kids.clone();
        // Stable, largest first: ties stay in child order, as `compactTree` leaves them.
        kids.sort_by_key(|&kid| Reverse(nodes.get(kid).map_or(0, |child| child.bytes)));
        for kid in kids.into_iter().take(top_of(node.depth, limits)) {
            *kept.get_mut(kid).ok_or("a kept child vanished")? = true;
        }
    }
    let mut ids: Vec<usize> = (0..nodes.len()).filter(|&id| is_kept(&kept, id)).collect();
    let place = |id: usize| nodes.get(id).map(|node| &node.position);
    ids.sort_by(|&a, &b| match (place(a), place(b)) {
        (Some(a), Some(b)) => a.breadth_first(b),
        _ => Ordering::Equal,
    });
    let mut row_of: HashMap<usize, u32> = HashMap::new();
    for (row, &id) in (0_u32..).zip(&ids) {
        row_of.insert(id, row);
    }
    let mut rows = Vec::with_capacity(ids.len());
    for &id in &ids {
        let node = nodes.get(id).ok_or("a kept row vanished")?;
        let parent = match node.parent {
            None => None,
            Some(parent) => Some(
                *row_of
                    .get(&parent)
                    .ok_or_else(|| format!("row {id}'s parent was not kept"))?,
            ),
        };
        let folder = if node.dir {
            let mut omitted = Omitted::default();
            for &kid in &node.kids {
                if is_kept(&kept, kid) {
                    continue;
                }
                let child = nodes.get(kid).ok_or("a child vanished")?;
                omitted.bytes += child.bytes;
                if child.dir {
                    omitted.files += child.files;
                    omitted.folders += child.folders + 1;
                } else {
                    omitted.files += 1;
                }
            }
            Some(FolderRow {
                files: node.files,
                folders: node.folders,
                omitted,
            })
        } else {
            None
        };
        rows.push(SummaryRow {
            parent,
            name: node.name.clone(),
            position: node.position.clone(),
            depth: node.depth,
            bytes: node.bytes,
            modified_at: node.modified_at,
            folder,
        });
    }
    Ok(Summary {
        rows,
        folder_threshold,
        file_threshold: file_threshold
            .map(|beta| u64::try_from(beta).map_err(|e| e.to_string()))
            .transpose()?,
        shallow_depth,
        shallow_exact: Exactness::Exact,
    })
}

// ---------------------------------------------------------------------------
// Holding the state to the oracle
// ---------------------------------------------------------------------------

/// Every row's parent comes before it and is its parent in the tree, the rows are in
/// breadth-first order, and each kept folder's kept children plus what it omitted are its
/// totals.
fn closed_and_balanced(at: &str, summary: &Summary) -> TestResult {
    let root = summary
        .rows
        .first()
        .ok_or_else(|| format!("{at}: no root row"))?;
    assert_eq!(
        (root.parent, root.depth, &root.position),
        (None, 0, &PositionPath::root()),
        "{at}: the root comes first"
    );
    let mut sums = vec![Omitted::default(); summary.rows.len()];
    for (row, kept) in (0_u32..).zip(&summary.rows).skip(1) {
        let parent = kept
            .parent
            .ok_or_else(|| format!("{at}: row {row} has no parent"))?;
        assert!(parent < row, "{at}: row {row}'s parent comes after it");
        let up = summary
            .rows
            .get(parent as usize)
            .ok_or_else(|| format!("{at}: row {row}'s parent is past the rows"))?;
        let mut indices = kept.position.indices();
        indices.pop();
        assert_eq!(
            (&up.position, up.depth + 1),
            (&PositionPath::from_indices(&indices), kept.depth),
            "{at}: row {row}'s parent is its parent in the tree"
        );
        assert!(up.folder.is_some(), "{at}: row {row}'s parent is a folder");
        let sum = sums
            .get_mut(parent as usize)
            .ok_or_else(|| format!("{at}: row {row}'s parent has no tally"))?;
        sum.bytes += kept.bytes;
        match &kept.folder {
            Some(folder) => {
                sum.files += folder.files;
                sum.folders += folder.folders + 1;
            }
            None => sum.files += 1,
        }
    }
    for (row, (kept, sum)) in summary.rows.iter().zip(&sums).enumerate() {
        let Some(folder) = &kept.folder else {
            continue;
        };
        assert_eq!(
            (
                sum.files + folder.omitted.files,
                sum.folders + folder.omitted.folders,
                sum.bytes + folder.omitted.bytes
            ),
            (folder.files, folder.folders, kept.bytes),
            "{at}: row {row}'s kept children and what it omitted are its totals"
        );
    }
    for (row, pair) in summary.rows.windows(2).enumerate() {
        if let [a, b] = pair {
            assert_eq!(
                a.position.breadth_first(&b.position),
                Ordering::Less,
                "{at}: rows {row} and {} are in breadth-first order",
                row + 1
            );
        }
    }
    Ok(())
}

fn check(at: &str, got: &Summary, want: &Summary) -> TestResult {
    assert_eq!(got.folder_threshold, want.folder_threshold, "{at}: β_d");
    assert_eq!(got.file_threshold, want.file_threshold, "{at}: β_f");
    assert_eq!(got.shallow_depth, want.shallow_depth, "{at}: D_s");
    for (row, (g, w)) in got.rows.iter().zip(&want.rows).enumerate() {
        assert_eq!(g, w, "{at}: row {row}");
    }
    assert_eq!(got.rows.len(), want.rows.len(), "{at}: the rows kept");
    closed_and_balanced(at, got)
}

/// The most the shallow keep may hold: the cap, or the root's own list where that is more.
fn held_at_most(limits: &KeepLimits) -> usize {
    limits.shallow_rows.max(limits.root_top)
}

fn check_walk(fixture: &Fixture, workers: u32, q_max: usize, limits: KeepLimits) -> TestResult {
    let at = format!(
        "{} at {workers} worker(s), q_max {q_max}, {limits:?}",
        fixture.name
    );
    let walked = walk_kept(fixture, workers, q_max, limits)?;
    let store = build_of(&walked, &root_name_of(fixture))?;
    let root_mtime = store_mtime(walked.root_mtime.ok_or("the walk never named its root")?);
    let want = expected(&tree_of(&store, root_mtime)?, &limits)?;
    let got = walked
        .summary
        .as_ref()
        .map_err(|e| format!("{at}: the summary was refused: {e}"))?;
    check(&at, got, &want)?;
    assert!(
        walked.shallow_rows_held <= held_at_most(&limits),
        "{at}: {} shallow rows held, past the cap",
        walked.shallow_rows_held
    );
    Ok(())
}

fn check_fixture(fixture: &Fixture, limits: KeepLimits) -> TestResult {
    for workers in WORKERS {
        check_walk(fixture, workers, DEFAULT_Q_MAX, limits)?;
    }
    check_walk(fixture, 8, 2, limits)
}

// ---------------------------------------------------------------------------
// Trees for the kept set
// ---------------------------------------------------------------------------

const TIES_ROOT: &str = "/t12c/ties";
const ROOT_TOP_ROOT: &str = "/t12c/root-top";
const FAN_ROOT: &str = "/t12c/fan";
const BESIDE_ROOT: &str = "/t12c/beside";
const FRONT_ROOT: &str = "/t12c/front";
const LATE_TIE_ROOT: &str = "/t12f/late-tie";

/// Limits that make β and the shallow cap bite on the small scripted trees.
const SMALL: KeepLimits = KeepLimits {
    folder_heap: 6,
    file_heap: 13,
    shallow_rows: 40,
    shallow_top: 3,
    root_top: 5,
};

/// The same for the 30,000-entry synthetic trees.
const SYNTHETIC_SMALL: KeepLimits = KeepLimits {
    folder_heap: 200,
    file_heap: 500,
    shallow_rows: 2_000,
    shallow_top: 8,
    root_top: 16,
};

/// Twelve 200-byte files at the root, three folders of 300 bytes and twenty-seven of 200: a
/// folder heap of 8 holds the three and five of the twenty-seven, so β_d is 200.
fn ties_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    for f in 0..12_u32 {
        b.file("", format!("f{f:02}.bin").as_bytes(), 200.0)?;
    }
    for t in 0..30_u32 {
        let folder = b.dir("", format!("t{t:02}").as_bytes())?;
        for f in 0..(if t < 3 { 3 } else { 2 }) {
            b.file(&folder, format!("g{f}.bin").as_bytes(), 100.0)?;
        }
    }
    Ok(b.finish(TIES_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// 150 files at the root, of 1 to 150 bytes in an order their names do not follow.
fn root_top_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    for i in 0..150_u32 {
        b.file(
            "",
            format!("f{i:03}.bin").as_bytes(),
            f64::from((i * 37) % 150 + 1),
        )?;
    }
    Ok(b.finish(ROOT_TOP_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// Four folders below the root, four below each, four below each of those, and four files
/// in each of the last: shallow rows by depth 4, 16, 64 and 256.
fn fan_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    for a in 0..4_u32 {
        let first = b.dir("", format!("a{a}").as_bytes())?;
        for c in 0..4_u32 {
            let second = b.dir(&first, format!("b{c}").as_bytes())?;
            for d in 0..4_u32 {
                let third = b.dir(&second, format!("c{d}").as_bytes())?;
                for f in 0..4_u32 {
                    b.file(
                        &third,
                        format!("f{f}.bin").as_bytes(),
                        f64::from(a * 64 + c * 16 + d * 4 + f + 1),
                    )?;
                }
            }
        }
    }
    Ok(b.finish(FAN_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// Five folders of 100-byte files, ten, eight, six, four and two of them: with a folder
/// heap of 4 the first three are kept, and with the root keeping only its top child the
/// second and third are kept by β alone.
fn beside_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    for (k, count) in [10_u32, 8, 6, 4, 2].into_iter().enumerate() {
        let folder = b.dir("", format!("b{k}").as_bytes())?;
        for f in 0..count {
            b.file(&folder, format!("f{f:02}.bin").as_bytes(), 100.0)?;
        }
    }
    Ok(b.finish(BESIDE_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// A folder of 70,000 files with long names, which the walk hands on in several chunks,
/// largest first, so its top children all come in its first chunk; beside it twenty files
/// of a million bytes, which fill a file heap of 13, so β keeps none of the first.
fn front_loaded_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    let big = b.dir("", b"big")?;
    for i in 0..70_000_u32 {
        b.file(
            &big,
            format!("a-rather-long-name-so-a-chunk-holds-fewer-rows-{i:06}.bin").as_bytes(),
            f64::from(70_000 - i),
        )?;
    }
    let huge = b.dir("", b"huge")?;
    for i in 0..20_u32 {
        b.file(&huge, format!("h{i:02}.bin").as_bytes(), 1_000_000.0)?;
    }
    Ok(b.finish(FRONT_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// The root's first child, folder `a`, holds 100 bytes, as does its second, the file
/// `b.bin`. The file enters the root's list with the root's block; `a` only when it closes,
/// later. With room for one child, the tie goes to child order: `a`.
fn late_tie_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    let a = b.dir("", b"a")?;
    b.file(&a, b"x.bin", 100.0)?;
    b.file("", b"b.bin", 100.0)?;
    Ok(b.finish(LATE_TIE_ROOT, folder_meta(1), true, FastPath::Bulk))
}

fn synthetic(name: &'static str, spec: SyntheticSpec) -> Fixture {
    Fixture {
        name,
        root: synthetic_temp_folder().join("t12c"),
        source: Source::Synthetic(spec),
        never_descend: Vec::new(),
    }
}

fn developer(seed: u64) -> SyntheticSpec {
    SyntheticSpec {
        link_ppm: 0,
        ..SyntheticSpec::developer(30_000, seed)
    }
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

#[test]
fn the_kept_set_is_the_beta_rule_and_the_shallow_keep_on_scripted_trees() -> TestResult {
    let mut mixed = scripted("mixed", MIXED_ROOT, mixed_tree()?);
    mixed.never_descend = vec![mixed.root.join("never")];
    let fixtures = [
        mixed,
        scripted("deep", DEEP_ROOT, deep_tree()?),
        scripted("chunked", CHUNKED_ROOT, chunked_tree()?),
        scripted("wide", WIDE_ROOT, wide_tree()?),
    ];
    for fixture in &fixtures {
        check_fixture(fixture, SMALL)?;
        check_fixture(fixture, KeepLimits::default())?;
    }
    Ok(())
}

#[test]
fn ties_at_the_boundary_are_dropped_together() -> TestResult {
    let fixture = scripted("ties", TIES_ROOT, ties_tree()?);
    let limits = KeepLimits {
        folder_heap: 8,
        file_heap: 20,
        shallow_rows: 40,
        shallow_top: 2,
        root_top: 3,
    };
    check_fixture(&fixture, limits)?;
    let summary = walk_kept(&fixture, 4, DEFAULT_Q_MAX, limits)?.summary?;
    assert_eq!(summary.folder_threshold, Some(200), "β_d falls in the tie");
    let tied: Vec<&[u8]> = summary
        .rows
        .iter()
        .filter(|row| row.depth > 0 && row.bytes == 200)
        .map(|row| row.name.as_slice())
        .collect();
    assert!(
        tied.is_empty(),
        "no row tied at β_d is kept, whichever the heap held: {tied:?}"
    );
    assert_eq!(
        summary.rows.len(),
        4,
        "the root and its three 300-byte folders"
    );
    Ok(())
}

#[test]
fn the_root_keeps_its_hundred_largest_children() -> TestResult {
    let fixture = scripted("root top", ROOT_TOP_ROOT, root_top_tree()?);
    let limits = KeepLimits {
        folder_heap: 4,
        file_heap: 11,
        ..KeepLimits::default()
    };
    check_fixture(&fixture, limits)?;
    let summary = walk_kept(&fixture, 1, DEFAULT_Q_MAX, limits)?.summary?;
    let mut sizes: Vec<u128> = summary.rows.iter().skip(1).map(|row| row.bytes).collect();
    sizes.sort_unstable_by(|a, b| b.cmp(a));
    assert_eq!(
        sizes,
        (51..=150).rev().collect::<Vec<u128>>(),
        "the root's 100 largest, as saveSnapshot's topEntries reads them"
    );
    Ok(())
}

#[test]
fn the_shallow_depth_falls_as_the_depth_histogram_fills() -> TestResult {
    let fixture = scripted("fan", FAN_ROOT, fan_tree()?);
    let limits = KeepLimits {
        folder_heap: 3,
        file_heap: 5,
        shallow_rows: 100,
        shallow_top: 4,
        root_top: 4,
    };
    check_fixture(&fixture, limits)?;
    for (workers, q_max) in [(1, DEFAULT_Q_MAX), (8, 2)] {
        let walked = walk_kept(&fixture, workers, q_max, limits)?;
        let summary = walked.summary?;
        assert_eq!(
            summary.shallow_depth, 2,
            "4 + 16 + 64 rows fit in 100, and 256 more do not"
        );
        assert_eq!(
            walked.shallow_rows_held, 84,
            "the lists at depth 3 were dropped when D_s left it"
        );
    }
    Ok(())
}

#[test]
fn a_folder_kept_by_beta_alone_keeps_its_top_children_too() -> TestResult {
    let fixture = scripted("beside", BESIDE_ROOT, beside_tree()?);
    let limits = KeepLimits {
        folder_heap: 4,
        file_heap: 2,
        shallow_rows: 1_000,
        shallow_top: 2,
        root_top: 1,
    };
    check_fixture(&fixture, limits)?;
    let summary = walk_kept(&fixture, 4, DEFAULT_Q_MAX, limits)?.summary?;
    let under = |folder: &[u8]| {
        let at = summary.rows.iter().position(|row| row.name == folder);
        summary
            .rows
            .iter()
            .filter(|row| row.parent.is_some_and(|p| Some(p as usize) == at))
            .count()
    };
    assert_eq!(
        [under(b"b0"), under(b"b1"), under(b"b2")],
        [2, 2, 2],
        "each kept folder at depth ≤ D_s keeps its top 2, not only the root's top child"
    );
    Ok(())
}

#[test]
fn a_listing_in_chunks_keeps_the_top_children_its_first_chunk_named() -> TestResult {
    let fixture = scripted("front-loaded", FRONT_ROOT, front_loaded_tree()?);
    check_fixture(&fixture, SMALL)?;
    let summary = walk_kept(&fixture, 4, DEFAULT_Q_MAX, SMALL)?.summary?;
    assert_eq!(summary.file_threshold, Some(1_000_000), "β keeps no file");
    let big = summary.rows.iter().position(|row| row.name == b"big");
    let mut top: Vec<u128> = summary
        .rows
        .iter()
        .filter(|row| row.parent.is_some_and(|p| Some(p as usize) == big))
        .map(|row| row.bytes)
        .collect();
    top.sort_unstable();
    assert_eq!(
        top,
        vec![69_998, 69_999, 70_000],
        "big's three largest, which its first chunk named"
    );
    Ok(())
}

#[test]
fn the_kept_set_is_the_beta_rule_on_synthetic_trees() -> TestResult {
    let fixtures = [
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
    ];
    for fixture in &fixtures {
        check_fixture(fixture, SYNTHETIC_SMALL)?;
        check_fixture(fixture, KeepLimits::default())?;
    }
    Ok(())
}

#[test]
fn the_summary_is_the_same_whatever_the_schedule() -> TestResult {
    let fixture = synthetic("synthetic developer seed 4", developer(4));
    let mut first: Option<Summary> = None;
    for workers in WORKERS {
        for q_max in [DEFAULT_Q_MAX, 2] {
            for run in 0..5 {
                let summary = walk_kept(&fixture, workers, q_max, SYNTHETIC_SMALL)?.summary?;
                match &first {
                    None => first = Some(summary),
                    Some(seen) => assert!(
                        summary == *seen,
                        "run {run} at {workers} worker(s), q_max {q_max}, kept another set"
                    ),
                }
            }
        }
    }
    Ok(())
}

#[test]
fn a_summary_is_refused_until_the_walk_has_finished() {
    let state = AggregateState::new(AggregateOptions {
        root_path: b"/t12c/never-walked".to_vec(),
        separator: SEP,
        observer: None,
        extension_limit: EXTENSION_LIMIT,
        keep: KeepLimits::default(),
    });
    let refused = state.summary();
    assert!(
        refused
            .as_ref()
            .is_err_and(|why| why.contains("has not finished")),
        "a walk that never ran has nothing to seal: {refused:?}"
    );
}

#[test]
fn a_tie_in_a_top_list_goes_to_the_earlier_child_though_it_closes_later() -> TestResult {
    let fixture = scripted("late tie", LATE_TIE_ROOT, late_tie_tree()?);
    // Heaps of one: β keeps nothing below the root, so the root's list decides alone.
    let limits = KeepLimits {
        folder_heap: 1,
        file_heap: 1,
        shallow_rows: 100,
        shallow_top: 1,
        root_top: 1,
    };
    check_fixture(&fixture, limits)?;
    let summary = walk_kept(&fixture, 1, DEFAULT_Q_MAX, limits)?.summary?;
    let kept: Vec<&[u8]> = summary
        .rows
        .iter()
        .skip(1)
        .map(|row| row.name.as_slice())
        .collect();
    assert_eq!(
        kept,
        [b"a".as_slice(), b"x.bin".as_slice()],
        "the root keeps `a`, first in child order at the tie, and `a` keeps its own top child"
    );
    Ok(())
}

#[test]
fn a_summary_is_refused_while_a_folder_is_open_though_a_root_closed_before() -> TestResult {
    let state = new_state(b"/t12f/twice", None, KeepLimits::default());
    state.root(b"twice", &folder_meta(1));
    hand_listing(&state, 0, 1, &[])?;
    assert!(
        state.summary().is_ok(),
        "the root's listing was empty, so it closed and the state would seal"
    );
    // A root named again, a promise no walk breaks but the state's own calls can: its
    // listing is still to come.
    state.root(b"twice", &folder_meta(1));
    assert_eq!(state.open_folders(), 1, "the root named again is open");
    let refused = state.summary();
    assert!(
        refused
            .as_ref()
            .is_err_and(|why| why.contains("has not finished")),
        "a folder is open, so the walk has not finished, whatever closed before: {refused:?}"
    );
    Ok(())
}

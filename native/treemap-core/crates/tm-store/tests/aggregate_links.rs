//! AggregateState, T12d (Phase 4; design §S.6.1, §S.6.3–§S.6.4): hard links. In a family of
//! two or more names in the scan, the first name in breadth-first order — the least
//! (depth, position path) — keeps the bytes, and every other name is a 0-byte file, as the
//! store's `HardlinkDup` makes it.
//!
//! The oracle is the walk's own output, rebuilt as a tree: each file's bytes as its listing
//! said them, each family's winner by (depth, position), and so each folder's totals twice —
//! per name, as the walk counts them, and corrected, as the store does. An answer that says
//! it is exact must be the corrected tree's collectors'. The summary chooses its folders and
//! its top children by the per-name totals (a later name is found only at the seal, design
//! §S.6.4) and its files by the corrected sizes, and reports every value corrected.

mod common;

use std::cmp::{Ordering, Reverse};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::time::{Duration, Instant};

use common::aggregate::{
    Fixture, Source, WORKERS, Walked, at_of, id_of, joined, root_bytes, scripted, walk_kept, whole,
};
use common::scripted::{BLOCK, Builder, dataless, file_meta, folder_meta};
use tm_store::aggregate::{
    Exactness, Extension, FileAnswer, FolderAnswer, FolderRow, KEEP, KeepLimits, Omitted,
    PositionPath, SIZE_BUCKETS, Summary, SummaryRow, TypeAnswer, size_bucket,
};
use tm_store::derive::{decided_here, extension, store_mtime};
use tm_walk::{
    DEFAULT_Q_MAX, FastPath, KIND_DIR, ListBuffer, Lister, Meta, Refusal, SyntheticSpec,
    synthetic_temp_folder,
};

type TestResult = Result<(), String>;

// ---------------------------------------------------------------------------
// The walk's own output as a tree, twice totalled
// ---------------------------------------------------------------------------

/// One row of the walk's output.
struct Node {
    parent: Option<usize>,
    depth: u32,
    position: PositionPath,
    path: Vec<u8>,
    name: Vec<u8>,
    dir: bool,
    /// A file's bytes as its listing said them.
    listed: u128,
    /// A later name of a hard-linked file: 0 bytes in the store.
    loser: bool,
    modified_at: f64,
    kids: Vec<usize>,
    /// A folder's total as the walk counts it, every name at its listed bytes.
    per_name: u128,
    /// A folder's total as the store keeps it, every later name at 0.
    corrected: u128,
    files: u64,
    folders: u64,
}

impl Node {
    /// A file's bytes in the store.
    fn size(&self) -> u128 {
        if self.loser { 0 } else { self.listed }
    }

    /// Its weight in its parent's top list: what the walk offered it with.
    fn offered(&self) -> u128 {
        if self.dir { self.per_name } else { self.listed }
    }
}

/// The walk's output as a tree, by the walk's ids: a folder's children are one range of ids
/// (I2), every parent's id below its children's (I3). The root is named `root_name`.
fn tree_of(walked: &Walked, root: &[u8], root_name: &[u8]) -> Result<Vec<Node>, String> {
    let out = &walked.out;
    let n = out.kind.len();
    let name = |id: usize| -> Result<Vec<u8>, String> {
        let from = at_of(*out.name_off.get(id).ok_or("name offset")?)?;
        let to = at_of(*out.name_off.get(id + 1).ok_or("name end")?)?;
        out.names
            .get(from..to)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| format!("the name of {id}"))
    };
    let root_mtime = store_mtime(walked.root_mtime.ok_or("the walk never named its root")?);
    let mut nodes: Vec<Node> = Vec::with_capacity(n);
    for id in 0..n {
        let dir = *out.kind.get(id).ok_or("kind")? == KIND_DIR;
        let listed = if dir {
            0
        } else {
            whole(
                *walked
                    .listed
                    .get(&id_of(id)?)
                    .ok_or_else(|| format!("no block held row {id}"))?,
            )
        };
        nodes.push(Node {
            parent: None,
            depth: 0,
            position: PositionPath::root(),
            path: root.to_vec(),
            name: if id == 0 {
                root_name.to_vec()
            } else {
                name(id)?
            },
            dir,
            listed,
            loser: false,
            modified_at: if id == 0 {
                root_mtime
            } else {
                store_mtime(*out.mtime_ms.get(id).ok_or("mtime")?)
            },
            kids: Vec::new(),
            per_name: 0,
            corrected: 0,
            files: 0,
            folders: 0,
        });
    }
    for id in 1..n {
        let parent = at_of(*out.parent.get(id).ok_or("parent")?)?;
        nodes
            .get_mut(parent)
            .ok_or("a parent past the rows")?
            .kids
            .push(id);
    }
    for id in 0..n {
        let (kids, depth, position, path) = {
            let node = nodes.get(id).ok_or("a row vanished")?;
            (
                node.kids.clone(),
                node.depth,
                node.position.clone(),
                node.path.clone(),
            )
        };
        for (index, kid) in (0_u32..).zip(kids) {
            let child = nodes.get_mut(kid).ok_or("a child vanished")?;
            child.parent = Some(id);
            child.depth = depth + 1;
            child.position = position.child(index);
            child.path = joined(&path, &child.name);
        }
    }
    // Families: the first name by (depth, position) keeps the bytes.
    let mut families: HashMap<u32, Vec<usize>> = HashMap::new();
    for link in &out.hardlinks {
        families
            .entry(link.family)
            .or_default()
            .push(at_of(link.node)?);
    }
    for members in families.values() {
        let winner = members
            .iter()
            .copied()
            .min_by(|&a, &b| match (nodes.get(a), nodes.get(b)) {
                (Some(a), Some(b)) => a.position.breadth_first(&b.position),
                _ => Ordering::Equal,
            });
        for &member in members {
            if Some(member) != winner {
                nodes.get_mut(member).ok_or("a member vanished")?.loser = true;
            }
        }
    }
    for id in (1..n).rev() {
        let node = nodes.get(id).ok_or("a row vanished")?;
        let parent = node
            .parent
            .ok_or_else(|| format!("row {id} has no parent"))?;
        let (per_name, corrected, files, folders) = if node.dir {
            (node.per_name, node.corrected, node.files, node.folders + 1)
        } else {
            (node.listed, node.size(), 1, 0)
        };
        let up = nodes.get_mut(parent).ok_or("a parent vanished")?;
        up.per_name += per_name;
        up.corrected += corrected;
        up.files += files;
        up.folders += folders;
    }
    Ok(nodes)
}

fn extension_of(name: &[u8]) -> Extension {
    match extension(name) {
        None => Extension::None,
        Some(raw) if decided_here(name) => Extension::Known(raw.to_ascii_lowercase()),
        Some(raw) => Extension::Pending(raw.to_vec()),
    }
}

// ---------------------------------------------------------------------------
// The answers of the corrected tree
// ---------------------------------------------------------------------------

fn largest_files(nodes: &[Node]) -> Result<Vec<FileAnswer>, String> {
    let mut files: Vec<&Node> = nodes.iter().filter(|node| !node.dir).collect();
    files.sort_by(|a, b| {
        b.size()
            .cmp(&a.size())
            .then_with(|| a.position.pre_order(&b.position))
    });
    files
        .into_iter()
        .take(KEEP)
        .map(|node| {
            Ok(FileAnswer {
                name: node.name.clone(),
                path: node.path.clone(),
                size: u64::try_from(node.size()).map_err(|e| e.to_string())?,
                extension: extension_of(&node.name),
                modified_at: node.modified_at,
                position: node.position.clone(),
            })
        })
        .collect()
}

/// The folders below the root by `total`, largest first, post-order at ties.
fn folders_by(nodes: &[Node], total: fn(&Node) -> u128) -> Vec<&Node> {
    let mut folders: Vec<&Node> = nodes
        .iter()
        .filter(|node| node.dir && node.depth > 0)
        .collect();
    folders.sort_by(|a, b| {
        total(b)
            .cmp(&total(a))
            .then_with(|| a.position.post_order(&b.position))
    });
    folders
}

fn largest_folders(nodes: &[Node]) -> Vec<FolderAnswer> {
    folders_by(nodes, |node| node.corrected)
        .into_iter()
        .take(KEEP)
        .map(|node| FolderAnswer {
            name: node.name.clone(),
            path: node.path.clone(),
            size: node.corrected,
            file_count: node.files,
            modified_at: node.modified_at,
            position: node.position.clone(),
        })
        .collect()
}

/// Whether the state's folder list is proven. It keeps the top [`KEEP`] by per-name
/// totals, which is exact when no correction changed a folder it kept; otherwise its last,
/// corrected, must still outweigh the best it turned away, whose per-name total bounds its
/// corrected one.
fn folder_list_proven(nodes: &[Node]) -> bool {
    let folders = folders_by(nodes, |node| node.per_name);
    let (kept, turned_away) = folders.split_at(folders.len().min(KEEP));
    let Some(best_turned_away) = turned_away.iter().map(|node| node.per_name).max() else {
        return true;
    };
    kept.iter().all(|node| node.corrected == node.per_name)
        || kept
            .iter()
            .map(|node| node.corrected)
            .min()
            .is_some_and(|last| last > best_turned_away)
}

/// Whether a later name reaches the file list's boundary: the only way the list can hold
/// one where its family's first name belongs.
fn a_later_name_reaches_the_file_boundary(nodes: &[Node]) -> Result<bool, String> {
    let files = largest_files(nodes)?;
    let boundary = if files.len() < KEEP {
        0
    } else {
        files.last().map_or(0, |file| u128::from(file.size))
    };
    Ok(nodes
        .iter()
        .any(|node| node.loser && node.listed > 0 && node.listed >= boundary))
}

fn file_types(nodes: &[Node]) -> Vec<TypeAnswer> {
    let mut by: HashMap<Extension, TypeAnswer> = HashMap::new();
    for node in nodes.iter().filter(|node| !node.dir) {
        let ext = extension_of(&node.name);
        let entry = by.entry(ext.clone()).or_insert_with(|| TypeAnswer {
            extension: ext,
            count: 0,
            bytes: 0,
            first: node.position.clone(),
        });
        entry.count += 1;
        entry.bytes += node.size();
        if node.position.pre_order(&entry.first) == Ordering::Less {
            entry.first = node.position.clone();
        }
    }
    let mut rows: Vec<TypeAnswer> = by.into_values().collect();
    rows.sort_by(|a, b| {
        b.bytes
            .cmp(&a.bytes)
            .then_with(|| a.first.pre_order(&b.first))
    });
    rows
}

fn histogram(nodes: &[Node]) -> Vec<u64> {
    let mut counts = vec![0_u64; SIZE_BUCKETS];
    for node in nodes.iter().filter(|node| !node.dir) {
        #[expect(
            clippy::cast_precision_loss,
            reason = "a size as JavaScript's number holds it"
        )]
        let bucket = size_bucket(node.size() as f64);
        if let Some(slot) = counts.get_mut(bucket) {
            *slot += 1;
        }
    }
    counts
}

// ---------------------------------------------------------------------------
// The summary: chosen per name, reported corrected
// ---------------------------------------------------------------------------

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

/// The summary the state must seal, and whether its shallow keep must say it is not proven:
/// a kept folder's top list, cut short, holds a later name.
fn expected_summary(nodes: &[Node], limits: &KeepLimits) -> Result<(Summary, bool), String> {
    let folder_threshold = threshold(
        nodes
            .iter()
            .filter(|node| node.dir && node.depth > 0)
            .map(|node| node.per_name)
            .collect(),
        limits.folder_heap,
    );
    let file_threshold = threshold(
        nodes
            .iter()
            .filter(|node| !node.dir)
            .map(Node::size)
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
                above(node.per_name, folder_threshold)
            } else {
                above(node.size(), folder_threshold) && above(node.size(), file_threshold)
            }
        })
        .collect();
    let mut unproven = false;
    for (id, node) in nodes.iter().enumerate() {
        if !matches!(kept.get(id), Some(true)) || !node.dir || node.depth > shallow_depth {
            continue;
        }
        let top = top_of(node.depth, limits);
        let mut kids = node.kids.clone();
        kids.sort_by_key(|&kid| Reverse(nodes.get(kid).map_or(0, Node::offered)));
        let cut = kids.len() > top;
        for kid in kids.into_iter().take(top) {
            *kept.get_mut(kid).ok_or("a kept child vanished")? = true;
            if cut && nodes.get(kid).is_some_and(|child| child.loser) {
                unproven = true;
            }
        }
    }
    let mut ids: Vec<usize> = (0..nodes.len())
        .filter(|&id| matches!(kept.get(id), Some(true)))
        .collect();
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
                if matches!(kept.get(kid), Some(true)) {
                    continue;
                }
                let child = nodes.get(kid).ok_or("a child vanished")?;
                if child.dir {
                    omitted.bytes += child.corrected;
                    omitted.files += child.files;
                    omitted.folders += child.folders + 1;
                } else {
                    omitted.bytes += child.size();
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
            bytes: if node.dir {
                node.corrected
            } else {
                node.size()
            },
            modified_at: node.modified_at,
            folder,
        });
    }
    let summary = Summary {
        rows,
        folder_threshold,
        file_threshold: file_threshold
            .map(|beta| u64::try_from(beta).map_err(|e| e.to_string()))
            .transpose()?,
        shallow_depth,
        shallow_exact: Exactness::Exact,
    };
    Ok((summary, unproven))
}

// ---------------------------------------------------------------------------
// Holding the state to the oracle
// ---------------------------------------------------------------------------

fn root_name_of(fixture: &Fixture) -> Vec<u8> {
    fixture
        .root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned().into_bytes())
        .unwrap_or_default()
}

fn check_walk(fixture: &Fixture, workers: u32, q_max: usize, limits: KeepLimits) -> TestResult {
    let at = format!(
        "{} at {workers} worker(s), q_max {q_max}, {limits:?}",
        fixture.name
    );
    let walked = walk_kept(fixture, workers, q_max, limits)?;
    let nodes = tree_of(&walked, &root_bytes(fixture), &root_name_of(fixture))?;
    let answers = &walked.answers;
    match &answers.largest_files_exact {
        Exactness::Exact => assert_eq!(
            answers.largest_files,
            largest_files(&nodes)?,
            "{at}: the largest files"
        ),
        Exactness::NotProven(why) => assert!(
            a_later_name_reaches_the_file_boundary(&nodes)?,
            "{at}: the file list says it is not proven ({why}), and no later name reaches it"
        ),
    }
    assert_eq!(
        answers.largest_folders_exact == Exactness::Exact,
        folder_list_proven(&nodes),
        "{at}: whether the folder list is proven: {:?}",
        answers.largest_folders_exact
    );
    if answers.largest_folders_exact == Exactness::Exact {
        assert_eq!(
            answers.largest_folders,
            largest_folders(&nodes),
            "{at}: the largest folders"
        );
    }
    assert_eq!(
        answers.file_types,
        Ok(file_types(&nodes)),
        "{at}: the file types"
    );
    assert_eq!(
        answers.size_histogram,
        histogram(&nodes),
        "{at}: the histogram"
    );
    let (want, unproven) = expected_summary(&nodes, &limits)?;
    let got = walked
        .summary
        .as_ref()
        .map_err(|e| format!("{at}: the summary was refused: {e}"))?;
    assert_eq!(
        matches!(got.shallow_exact, Exactness::NotProven(_)),
        unproven,
        "{at}: whether a cut top list holds a later name: {:?}",
        got.shallow_exact
    );
    assert_eq!(got.folder_threshold, want.folder_threshold, "{at}: β_d");
    assert_eq!(got.file_threshold, want.file_threshold, "{at}: β_f");
    assert_eq!(got.shallow_depth, want.shallow_depth, "{at}: D_s");
    for (row, (g, w)) in got.rows.iter().zip(&want.rows).enumerate() {
        assert_eq!(g, w, "{at}: row {row}");
    }
    assert_eq!(got.rows.len(), want.rows.len(), "{at}: the rows kept");
    Ok(())
}

fn check_fixture(fixture: &Fixture, limits: KeepLimits) -> TestResult {
    for workers in WORKERS {
        check_walk(fixture, workers, DEFAULT_Q_MAX, limits)?;
    }
    check_walk(fixture, 8, 2, limits)
}

// ---------------------------------------------------------------------------
// Trees with families
// ---------------------------------------------------------------------------

const LINKS_ROOT: &str = "/t12d/links";
const FOLDER_EDGE_ROOT: &str = "/t12d/folder-edge";
const FILE_EDGE_ROOT: &str = "/t12d/file-edge";
const TOP_EDGE_ROOT: &str = "/t12d/top-edge";
const FOLDER_TIE_ROOT: &str = "/t12d/folder-tie";
const ARRIVAL_ROOT: &str = "/t12d/arrival";
const EMPTY_EDGE_ROOT: &str = "/t12f/empty-edge";
const LATE_FIRST_ROOT: &str = "/t12f/late-first";
const EMPTY_CORRECTION_ROOT: &str = "/t12f/empty-correction";
const OUTWEIGHS_ROOT: &str = "/t12f/outweighs";
const FULL_TOP_ROOT: &str = "/t12f/full-top";
const STALE_SIZE_ROOT: &str = "/t12f/stale-size";

const SMALL: KeepLimits = KeepLimits {
    folder_heap: 5,
    file_heap: 9,
    shallow_rows: 60,
    shallow_top: 3,
    root_top: 4,
};

const SYNTHETIC_SMALL: KeepLimits = KeepLimits {
    folder_heap: 200,
    file_heap: 500,
    shallow_rows: 2_000,
    shallow_top: 8,
    root_top: 16,
};

/// Families across folders and depths. Family 900 has names at `a/deep/x.bin` (the smallest
/// path, depth 3), `q/y.bin` and `t/u.bin` (depth 2): `q/y.bin` is first in breadth-first
/// order. Family 901 has a name at the root and one below it; 902 two names in one folder,
/// the first by child order winning; 903 one name whose others are outside the scan; 904
/// two placeholders; 905 a million bytes in three folders, the corrections' mass.
fn links_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    let a = b.dir("", b"a")?;
    let deep = b.dir(&a, b"deep")?;
    let q = b.dir("", b"q")?;
    let t = b.dir("", b"t")?;
    let family_900 = file_meta(5_000.0, BLOCK * 2.0, 900, 3);
    b.put(&deep, b"x.bin", family_900)?;
    b.put(&q, b"y.bin", family_900)?;
    b.put(&t, b"u.bin", family_900)?;
    let family_901 = file_meta(700.0, BLOCK, 901, 2);
    b.put("", b"m.bin", family_901)?;
    b.put(&deep, b"m2.bin", family_901)?;
    let twins = b.dir(&t, b"twins")?;
    let family_902 = file_meta(123.0, BLOCK, 902, 2);
    b.put(&twins, b"b.dat", family_902)?;
    b.put(&twins, b"a.txt", family_902)?;
    b.put(&q, b"lonely.bin", file_meta(40.0, BLOCK, 903, 2))?;
    let family_904 = dataless(file_meta(300.0, 0.0, 904, 2));
    b.put(&a, b"p1", family_904)?;
    b.put(&t, b"p2", family_904)?;
    let heavy = b.dir("", b"heavy")?;
    let family_905 = file_meta(1_000_000.0, 1_000_000.0, 905, 3);
    b.put(&heavy, b"h.img", family_905)?;
    b.put(&a, b"h.img", family_905)?;
    b.put(&twins, b"h.img", family_905)?;
    for f in 0..6_u32 {
        b.file(&q, format!("q{f}.log").as_bytes(), f64::from(f * 90 + 10))?;
        b.file(&t, format!("t{f}.log").as_bytes(), f64::from(f * 80 + 5))?;
        b.file(&a, format!("a{f}.bin").as_bytes(), f64::from(f * 70 + 1))?;
    }
    Ok(b.finish(LINKS_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// 2,100 folders of one 1,000-byte file each, and a million-byte file linked into two more
/// folders. Per name both hold a million, so the list keeps them and turns 1,000-byte
/// folders away; corrected, the later one holds nothing.
fn folder_edge_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    let family = file_meta(1_000_000.0, 1_000_000.0, 950, 2);
    let first = b.dir("", b"a-first")?;
    b.put(&first, b"big.img", family)?;
    b.file(&first, b"one.bin", 1_000.0)?;
    let second = b.dir("", b"b-second")?;
    let deeper = b.dir(&second, b"deeper")?;
    b.put(&deeper, b"big.img", family)?;
    for f in 0..2_100_u32 {
        let folder = b.dir("", format!("f{f:04}").as_bytes())?;
        b.file(&folder, b"one.bin", 1_000.0)?;
    }
    Ok(b.finish(FOLDER_EDGE_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// 2,000 files of 1,000 bytes in `a`, listed before `b`: the list is full of them when
/// `b/w.bin` — the first name of a 1,000-byte family in breadth-first order — is turned away
/// on the tie, and `a/deep/m.bin`, its later name but earlier in pre-order, then joins the
/// list on the same tie.
fn file_edge_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    let a = b.dir("", b"a")?;
    let deep = b.dir(&a, b"deep")?;
    let family = file_meta(1_000.0, BLOCK, 960, 2);
    b.put(&deep, b"m.bin", family)?;
    for f in 0..2_000_u32 {
        b.file(&a, format!("f{f:04}.bin").as_bytes(), 1_000.0)?;
    }
    let second = b.dir("", b"b")?;
    b.put(&second, b"w.bin", family)?;
    Ok(b.finish(FILE_EDGE_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// A folder of five files, the largest a later name of a file whose first name is at the
/// root: its top 3 holds the later name and turns two files away.
fn top_edge_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    let family = file_meta(9_000.0, BLOCK * 3.0, 970, 2);
    b.put("", b"first.bin", family)?;
    let folder = b.dir("", b"folder")?;
    b.put(&folder, b"later.bin", family)?;
    for (f, size) in [(0_u32, 500.0), (1, 400.0), (2, 300.0), (3, 200.0)] {
        b.file(&folder, format!("f{f}.bin").as_bytes(), size)?;
    }
    Ok(b.finish(TOP_EDGE_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// 2,100 folders of one 1,000-byte file each, and no hard link: the folder list keeps 2,000
/// and turns 100 away, all of one total, and no correction changes any of them.
fn folder_tie_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    for f in 0..2_100_u32 {
        let folder = b.dir("", format!("f{f:04}").as_bytes())?;
        b.file(&folder, b"one.bin", 1_000.0)?;
    }
    Ok(b.finish(FOLDER_TIE_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// A family whose first name in breadth-first order, `q/y.bin`, arrives after its later
/// name `a/deep/x.bin` when `q` is held back (see [`HoldUntil`]).
fn arrival_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    let a = b.dir("", b"a")?;
    let deep = b.dir(&a, b"deep")?;
    let family = file_meta(7_000.0, BLOCK * 2.0, 980, 2);
    b.put(&deep, b"x.bin", family)?;
    let sub = b.dir(&deep, b"sub")?;
    b.file(&sub, b"s.bin", 10.0)?;
    let q = b.dir("", b"q")?;
    b.put(&q, b"y.bin", family)?;
    Ok(b.finish(ARRIVAL_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// 2,000 empty files in `a`, listed before `b`: the list is full of them when `b/w.bin`, the
/// first name of an empty file in breadth-first order, is turned away on the tie, and
/// `a/deep/m.bin`, its later name but earlier in pre-order, then joins the list on the same
/// tie. An empty file's names hold nothing whichever comes first, so the list is proven.
fn empty_edge_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    let a = b.dir("", b"a")?;
    let deep = b.dir(&a, b"deep")?;
    let family = file_meta(0.0, 0.0, 961, 2);
    b.put(&deep, b"m.bin", family)?;
    for f in 0..2_000_u32 {
        b.file(&a, format!("f{f:04}.bin").as_bytes(), 0.0)?;
    }
    let second = b.dir("", b"b")?;
    b.put(&second, b"w.bin", family)?;
    Ok(b.finish(EMPTY_EDGE_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// `a/deep/x.bin` and `q/y.bin` name one 7,000-byte file. `q` is held until `a/deep/sub` is
/// being listed, so the later name, `x.bin`, arrives first, after 2,001 one-byte files in `a`
/// have filled the file list and turned one away. The first name, `y.bin`, then takes the
/// family's place though it ranks below `x.bin` in pre-order, where a file the list turned
/// away might outrank it.
fn late_first_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    let a = b.dir("", b"a")?;
    let deep = b.dir(&a, b"deep")?;
    b.dir(&deep, b"sub")?;
    let family = file_meta(7_000.0, BLOCK * 2.0, 981, 2);
    b.put(&deep, b"x.bin", family)?;
    for f in 0..2_001_u32 {
        b.file(&a, format!("f{f:04}.bin").as_bytes(), 1.0)?;
    }
    let q = b.dir("", b"q")?;
    b.put(&q, b"y.bin", family)?;
    Ok(b.finish(LATE_FIRST_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// 2,100 folders of one 1,000-byte file each, the first two also holding a name each of one
/// empty file: its later name is corrected by no bytes, so no total changes, and the tie at
/// the folder list's edge is still decided exactly.
fn empty_correction_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    let family = file_meta(0.0, 0.0, 951, 2);
    for f in 0..2_100_u32 {
        let folder = b.dir("", format!("f{f:04}").as_bytes())?;
        b.file(&folder, b"one.bin", 1_000.0)?;
        if f < 2 {
            b.put(&folder, b"z.bin", family)?;
        }
    }
    Ok(b.finish(EMPTY_CORRECTION_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// 2,000 folders of one 2,000-byte file each, the first two also holding a name each of one
/// 600-byte file, and 100 folders of one 1,000-byte file: the folder list keeps the 2,000
/// and turns the 100 away. The correction takes `g0001` from 2,600 bytes back to 2,000,
/// still above every folder turned away, so the changed list is proven.
fn outweighs_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    let family = file_meta(600.0, BLOCK, 952, 2);
    for g in 0..2_000_u32 {
        let folder = b.dir("", format!("g{g:04}").as_bytes())?;
        b.file(&folder, b"one.bin", 2_000.0)?;
        if g < 2 {
            b.put(&folder, b"h.bin", family)?;
        }
    }
    for t in 0..100_u32 {
        let folder = b.dir("", format!("t{t:03}").as_bytes())?;
        b.file(&folder, b"one.bin", 1_000.0)?;
    }
    Ok(b.finish(OUTWEIGHS_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// A folder of exactly three files, the largest a later name of a file whose first name is at
/// the root: its top 3 hold every child it has, the later name too, so it turned nothing away
/// that could belong there.
fn full_top_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    let family = file_meta(9_000.0, BLOCK * 3.0, 971, 2);
    b.put("", b"first.bin", family)?;
    let folder = b.dir("", b"folder")?;
    b.put(&folder, b"later.bin", family)?;
    b.file(&folder, b"f0.bin", 500.0)?;
    b.file(&folder, b"f1.bin", 400.0)?;
    Ok(b.finish(FULL_TOP_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// `a/deep/x.bin` and `q/y.bin` name one file, listed at 40 bytes under `x.bin` and at 5
/// under `y.bin`: a Windows listing can hold a stale size for one name of a file, and until
/// T20's refresh each name keeps its listing's (plan T12d). `q` is held until `a/deep/sub` is
/// being listed, so the later name enters a file heap of four first, behind the root's three
/// files, while the heap still has room: it evicts nothing (had it, the heap would have left
/// the corrected tree, T12f's finding F1). The first name then takes its entry at 5 bytes,
/// now the lightest held, which must rise to the heap's top for β_f to be 5.
fn stale_size_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    let a = b.dir("", b"a")?;
    let deep = b.dir(&a, b"deep")?;
    b.dir(&deep, b"sub")?;
    b.put(&deep, b"x.bin", file_meta(40.0, BLOCK, 982, 2))?;
    let q = b.dir("", b"q")?;
    b.put(&q, b"y.bin", file_meta(5.0, BLOCK, 982, 2))?;
    for (name, size) in [(b"r1.bin", 10.0), (b"r2.bin", 20.0), (b"r3.bin", 30.0)] {
        b.file("", name, size)?;
    }
    Ok(b.finish(STALE_SIZE_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// The longest a held listing waits: a hang guard, never the event the test counts on.
const HOLD_GUARD: Duration = Duration::from_secs(60);

/// A lister that holds the listing of folder `hold` until folder `until` is being listed,
/// and says whether that, not the guard, let it go. `until`'s job is queued only when its
/// parent's block is in, so with two workers everything in that block arrives first.
struct HoldUntil {
    tree: Arc<common::scripted::ScriptedTree>,
    hold: &'static str,
    until: &'static str,
    released: AtomicBool,
    by_event: AtomicBool,
}

impl HoldUntil {
    fn reset(&self) {
        self.released.store(false, AtomicOrdering::SeqCst);
        self.by_event.store(false, AtomicOrdering::SeqCst);
    }
}

impl Lister for HoldUntil {
    fn stat_dir(&self, path: &Path, want_atime: bool) -> Result<Meta, Refusal> {
        self.tree.stat_dir(path, want_atime)
    }

    fn list(
        &self,
        dir: &Path,
        want_atime: bool,
        buf: &mut ListBuffer,
    ) -> Result<FastPath, Refusal> {
        if dir.ends_with(self.until) {
            self.by_event.store(true, AtomicOrdering::SeqCst);
            self.released.store(true, AtomicOrdering::SeqCst);
        }
        if dir.ends_with(self.hold) {
            let started = Instant::now();
            while !self.released.load(AtomicOrdering::SeqCst) && !buf.stopped() {
                if started.elapsed() > HOLD_GUARD {
                    break;
                }
                std::thread::yield_now();
                buf.beat();
            }
        }
        self.tree.list(dir, want_atime, buf)
    }
}

/// A fixture of `tree` whose lister holds folder `hold` until folder `until` is being listed.
fn held(
    name: &'static str,
    root: &str,
    tree: common::scripted::ScriptedTree,
    hold: &'static str,
    until: &'static str,
) -> (Arc<HoldUntil>, Fixture) {
    let lister = Arc::new(HoldUntil {
        tree: Arc::new(tree),
        hold,
        until,
        released: AtomicBool::new(false),
        by_event: AtomicBool::new(false),
    });
    let fixture = Fixture {
        name,
        root: PathBuf::from(root),
        source: Source::Custom(lister.clone()),
        never_descend: Vec::new(),
    };
    (lister, fixture)
}

fn synthetic(name: &'static str, spec: SyntheticSpec) -> Fixture {
    Fixture {
        name,
        root: synthetic_temp_folder().join("t12d"),
        source: Source::Synthetic(spec),
        never_descend: Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

#[test]
fn a_family_keeps_its_bytes_at_its_first_name_in_breadth_first_order() -> TestResult {
    let fixture = scripted("links", LINKS_ROOT, links_tree()?);
    check_fixture(&fixture, SMALL)?;
    check_fixture(&fixture, KeepLimits::default())?;
    let walked = walk_kept(&fixture, 1, DEFAULT_Q_MAX, KeepLimits::default())?;
    let bytes_of = |path: &str| {
        let path = [LINKS_ROOT, path].join("/").into_bytes();
        walked
            .answers
            .largest_files
            .iter()
            .find(|file| file.path == path)
            .map(|file| file.size)
    };
    assert_eq!(
        [
            bytes_of("q/y.bin"),
            bytes_of("a/deep/x.bin"),
            bytes_of("t/u.bin")
        ],
        [Some(5_000), Some(0), Some(0)],
        "the first name in breadth-first order keeps the bytes, not the smallest path"
    );
    Ok(())
}

#[test]
fn families_in_synthetic_trees_are_counted_once() -> TestResult {
    let developer = |seed| SyntheticSpec::developer(30_000, seed);
    for fixture in [
        synthetic("synthetic developer seed 5", developer(5)),
        synthetic(
            "synthetic folders 33%, links 5%",
            SyntheticSpec {
                folder_ppm: 330_000,
                link_ppm: 50_000,
                ..developer(6)
            },
        ),
    ] {
        check_fixture(&fixture, SYNTHETIC_SMALL)?;
        check_fixture(&fixture, KeepLimits::default())?;
    }
    Ok(())
}

#[test]
fn the_folder_list_says_it_is_not_proven_when_a_correction_lets_a_turned_away_folder_tie()
-> TestResult {
    let fixture = scripted("folder edge", FOLDER_EDGE_ROOT, folder_edge_tree()?);
    check_fixture(&fixture, KeepLimits::default())?;
    let walked = walk_kept(&fixture, 1, DEFAULT_Q_MAX, KeepLimits::default())?;
    assert!(
        matches!(
            walked.answers.largest_folders_exact,
            Exactness::NotProven(ref why) if why.contains("hard link")
        ),
        "the corrected list's last folder no longer outweighs every folder it turned away: {:?}",
        walked.answers.largest_folders_exact
    );
    assert_eq!(
        walked.answers.largest_files_exact,
        Exactness::Exact,
        "the file list is unaffected"
    );
    Ok(())
}

#[test]
fn the_file_list_says_it_is_not_proven_when_a_later_name_joined_on_a_tie() -> TestResult {
    let fixture = scripted("file edge", FILE_EDGE_ROOT, file_edge_tree()?);
    let walked = walk_kept(&fixture, 1, DEFAULT_Q_MAX, KeepLimits::default())?;
    assert!(
        matches!(
            walked.answers.largest_files_exact,
            Exactness::NotProven(ref why) if why.contains("hard link")
        ),
        "a later name held a place its family's first name was turned away from: {:?}",
        walked.answers.largest_files_exact
    );
    let later = [FILE_EDGE_ROOT, "a/deep/m.bin"].join("/").into_bytes();
    assert!(
        walked
            .answers
            .largest_files
            .iter()
            .all(|file| file.path != later || file.size == 0),
        "the later name is never listed with its family's bytes"
    );
    Ok(())
}

#[test]
fn a_cut_top_list_holding_a_later_name_says_it_is_not_proven() -> TestResult {
    let fixture = scripted("top edge", TOP_EDGE_ROOT, top_edge_tree()?);
    let limits = KeepLimits {
        folder_heap: 2,
        file_heap: 2,
        shallow_rows: 100,
        shallow_top: 3,
        root_top: 4,
    };
    check_fixture(&fixture, limits)?;
    let summary = walk_kept(&fixture, 1, DEFAULT_Q_MAX, limits)?.summary?;
    assert!(
        matches!(summary.shallow_exact, Exactness::NotProven(ref why) if why.contains("hard link")),
        "folder's top 3 held a later name and turned files away: {:?}",
        summary.shallow_exact
    );
    Ok(())
}

#[test]
fn a_tie_at_the_folder_lists_edge_that_no_correction_touched_is_proven() -> TestResult {
    let fixture = scripted("folder tie", FOLDER_TIE_ROOT, folder_tie_tree()?);
    check_fixture(&fixture, KeepLimits::default())?;
    let walked = walk_kept(&fixture, 1, DEFAULT_Q_MAX, KeepLimits::default())?;
    assert_eq!(
        walked.answers.largest_folders_exact,
        Exactness::Exact,
        "post-order settles a tie at the edge exactly when nothing was corrected"
    );
    Ok(())
}

#[test]
fn a_first_name_that_arrives_after_a_later_name_still_takes_the_bytes() -> TestResult {
    let hold = Arc::new(HoldUntil {
        tree: Arc::new(arrival_tree()?),
        hold: "q",
        until: "sub",
        released: AtomicBool::new(false),
        by_event: AtomicBool::new(false),
    });
    let fixture = Fixture {
        name: "arrival",
        root: PathBuf::from(ARRIVAL_ROOT),
        source: Source::Custom(hold.clone()),
        never_descend: Vec::new(),
    };
    // The third keeps `q/y.bin` by β alone: the file heap is full, and the shallow keep
    // reaches only the root's top child, `a`.
    let by_beta_alone = KeepLimits {
        folder_heap: 10,
        file_heap: 3,
        shallow_rows: 1,
        shallow_top: 1,
        root_top: 1,
    };
    for limits in [KeepLimits::default(), SMALL, by_beta_alone] {
        hold.reset();
        check_walk(&fixture, 2, DEFAULT_Q_MAX, limits)?;
        assert!(
            hold.by_event.load(AtomicOrdering::SeqCst),
            "q was held until a/deep's block was in, so the later name arrived first"
        );
    }
    hold.reset();
    let walked = walk_kept(&fixture, 2, DEFAULT_Q_MAX, KeepLimits::default())?;
    assert!(
        hold.by_event.load(AtomicOrdering::SeqCst),
        "the later name arrived first"
    );
    assert_eq!(
        walked.answers.largest_files_exact,
        Exactness::Exact,
        "nothing was turned away, so the first name took the family's place"
    );
    let summary = walked.summary?;
    let bytes_of = |name: &[u8]| {
        summary
            .rows
            .iter()
            .find(|row| row.name == name)
            .map(|row| row.bytes)
    };
    assert_eq!(
        (bytes_of(b"y.bin"), bytes_of(b"x.bin")),
        (Some(7_000), Some(0)),
        "the first name in breadth-first order keeps the bytes, though it came second"
    );
    Ok(())
}

#[test]
fn the_answers_and_the_summary_are_the_same_whatever_the_schedule() -> TestResult {
    let fixture = scripted("links", LINKS_ROOT, links_tree()?);
    let mut first = None;
    for workers in WORKERS {
        for q_max in [DEFAULT_Q_MAX, 2] {
            for run in 0..5 {
                let walked = walk_kept(&fixture, workers, q_max, SMALL)?;
                let seen = (walked.answers, walked.summary?);
                match &first {
                    None => first = Some(seen),
                    Some(earlier) => assert!(
                        seen == *earlier,
                        "run {run} at {workers} worker(s), q_max {q_max}, answered otherwise"
                    ),
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// T12f: the gaps `cargo mutants` found
// ---------------------------------------------------------------------------

#[test]
fn a_hard_link_of_no_bytes_at_the_file_lists_edge_leaves_it_proven() -> TestResult {
    let fixture = scripted("empty edge", EMPTY_EDGE_ROOT, empty_edge_tree()?);
    check_fixture(&fixture, KeepLimits::default())?;
    let walked = walk_kept(&fixture, 1, DEFAULT_Q_MAX, KeepLimits::default())?;
    assert_eq!(
        walked.answers.largest_files_exact,
        Exactness::Exact,
        "neither name of an empty file holds a family's place: the list is ordered as the \
         store's is"
    );
    Ok(())
}

#[test]
fn a_first_name_taking_its_place_from_a_later_name_it_ranks_below_is_not_proven() -> TestResult {
    let (hold, fixture) = held(
        "late first",
        LATE_FIRST_ROOT,
        late_first_tree()?,
        "q",
        "sub",
    );
    hold.reset();
    check_walk(&fixture, 2, DEFAULT_Q_MAX, KeepLimits::default())?;
    assert!(
        hold.by_event.load(AtomicOrdering::SeqCst),
        "q was held until a/deep/sub was being listed, so the later name arrived first"
    );
    hold.reset();
    let walked = walk_kept(&fixture, 2, DEFAULT_Q_MAX, KeepLimits::default())?;
    assert!(
        hold.by_event.load(AtomicOrdering::SeqCst),
        "the later name arrived first"
    );
    assert!(
        matches!(
            walked.answers.largest_files_exact,
            Exactness::NotProven(ref why) if why.contains("ranks below")
        ),
        "the first name ranks below the later name whose place it took, after the list turned \
         a file away: {:?}",
        walked.answers.largest_files_exact
    );
    Ok(())
}

#[test]
fn a_correction_of_no_bytes_leaves_a_tie_at_the_folder_lists_edge_proven() -> TestResult {
    let fixture = scripted(
        "empty correction",
        EMPTY_CORRECTION_ROOT,
        empty_correction_tree()?,
    );
    check_fixture(&fixture, KeepLimits::default())?;
    let walked = walk_kept(&fixture, 1, DEFAULT_Q_MAX, KeepLimits::default())?;
    assert_eq!(
        walked.answers.largest_folders_exact,
        Exactness::Exact,
        "a later name of no bytes changes no folder's total"
    );
    Ok(())
}

#[test]
fn a_changed_folder_list_whose_last_folder_outweighs_all_it_turned_away_is_proven() -> TestResult {
    let fixture = scripted("outweighs", OUTWEIGHS_ROOT, outweighs_tree()?);
    check_fixture(&fixture, KeepLimits::default())?;
    let walked = walk_kept(&fixture, 1, DEFAULT_Q_MAX, KeepLimits::default())?;
    assert_eq!(
        walked.answers.largest_folders_exact,
        Exactness::Exact,
        "corrected, the list's last folder still holds 2,000 bytes, above the 1,000 of every \
         folder it turned away"
    );
    Ok(())
}

#[test]
fn a_top_list_holding_every_child_is_proven_though_one_is_a_later_name() -> TestResult {
    let fixture = scripted("full top", FULL_TOP_ROOT, full_top_tree()?);
    let limits = KeepLimits {
        folder_heap: 2,
        file_heap: 2,
        shallow_rows: 100,
        shallow_top: 3,
        root_top: 4,
    };
    check_fixture(&fixture, limits)?;
    let summary = walk_kept(&fixture, 1, DEFAULT_Q_MAX, limits)?.summary?;
    assert_eq!(
        summary.shallow_exact,
        Exactness::Exact,
        "folder's top 3 hold all three of its children: nothing was turned away"
    );
    Ok(())
}

#[test]
fn a_first_name_listed_lighter_than_its_later_name_keeps_the_file_heap_in_order() -> TestResult {
    let (hold, fixture) = held(
        "stale size",
        STALE_SIZE_ROOT,
        stale_size_tree()?,
        "q",
        "sub",
    );
    let limits = KeepLimits {
        folder_heap: 10,
        file_heap: 4,
        shallow_rows: 100,
        shallow_top: 3,
        root_top: 4,
    };
    hold.reset();
    check_walk(&fixture, 2, DEFAULT_Q_MAX, limits)?;
    assert!(
        hold.by_event.load(AtomicOrdering::SeqCst),
        "q was held until a/deep/sub was being listed, so the later name arrived first"
    );
    hold.reset();
    let summary = walk_kept(&fixture, 2, DEFAULT_Q_MAX, limits)?.summary?;
    assert!(
        hold.by_event.load(AtomicOrdering::SeqCst),
        "the later name arrived first"
    );
    assert_eq!(
        summary.file_threshold,
        Some(5),
        "β_f is the first name's 5 bytes, the lightest of the four files held"
    );
    Ok(())
}

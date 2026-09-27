//! AggregateState, T12b (Phase 4; design §S.6.1): the exact answers, before hard links,
//! held to a port of the TypeScript collectors run over the store `build` makes of the same
//! walk — `collectLargestFiles`, `collectLargestFolders`, `collectFileTypes` (diskScanner.ts)
//! and `computeSizeDistribution`'s buckets (reclaimInputs.ts). The port follows each
//! collector's own steps (its bounded insertion, its stable sorts, its Map's first-seen
//! order) over the store's child ranges in pre-order, so every tie falls as the collectors
//! let it. Hard-linked trees wait for T12d, where `build` keeps a family's bytes once.

mod common;

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::ops::Range;

use common::aggregate::{
    Fixture, SEP, Source, WORKERS, Walked, chunked_tree, deep_tree, joined, mixed_tree, root_bytes,
    scripted, walk, walk_limited,
};
use common::scripted::{Builder, WIDE_ROOT, folder_meta, wide_tree};
use tm_store::aggregate::{
    Answers, EXTENSION_LIMIT, Extension, FileAnswer, FolderAnswer, KEEP, PositionPath,
    SIZE_BUCKET_STARTS, SIZE_BUCKETS, TypeAnswer, size_bucket,
};
use tm_store::derive::extension;
use tm_store::{BuildOptions, EXT_NONE, EXT_OVERFLOW, Store, StoreMode, build, flag};
use tm_walk::{DEFAULT_Q_MAX, FastPath, SyntheticSpec, synthetic_temp_folder};

type TestResult = Result<(), String>;

// ---------------------------------------------------------------------------
// The collectors, ported, over a built store
// ---------------------------------------------------------------------------

fn get<T: Copy>(column: &[T], id: usize, what: &str) -> Result<T, String> {
    column
        .get(id)
        .copied()
        .ok_or_else(|| format!("row {id} is outside {what}"))
}

struct Port<'a> {
    store: &'a Store,
    root_path: Vec<u8>,
    /// Rows whose extension Node decides (`text_candidates`).
    pending: HashSet<u32>,
    /// `eachFile`'s visits, walked once.
    visits: Vec<Visit>,
    /// Every folder below the root in post-order, with its total and file count, walked once.
    post_order: Vec<FolderAnswer>,
}

/// A file as `eachFile` reaches it: its id, path and position.
struct Visit {
    id: usize,
    path: Vec<u8>,
    position: PositionPath,
}

impl<'a> Port<'a> {
    fn new(store: &'a Store, root_path: Vec<u8>) -> Result<Self, String> {
        let mut port = Self {
            store,
            root_path,
            pending: store.text_candidates.iter().copied().collect(),
            visits: Vec::new(),
            post_order: Vec::new(),
        };
        port.visits = port.files()?;
        port.post_order = port.folders_in_post_order()?;
        Ok(port)
    }

    fn name(&self, id: usize) -> Result<&'a [u8], String> {
        let off = self.store.name_off.as_slice();
        let (start, end) = (get(off, id, "nameOff")?, get(off, id + 1, "nameOff")?);
        self.store
            .names
            .as_slice()
            .get(start as usize..end as usize)
            .ok_or_else(|| format!("row {id}'s name is outside the names"))
    }

    fn is_dir(&self, id: usize) -> Result<bool, String> {
        Ok(get(self.store.flags.as_slice(), id, "flags")? & flag::DIR != 0)
    }

    fn children(&self, id: usize) -> Result<Range<usize>, String> {
        let first = get(self.store.child_start.as_slice(), id, "childStart")? as usize;
        let count = get(self.store.child_cnt.as_slice(), id, "childCnt")? as usize;
        Ok(first..first + count)
    }

    fn size(&self, id: usize) -> Result<f64, String> {
        get(self.store.size.as_slice(), id, "size")
    }

    fn mtime(&self, id: usize) -> Result<f64, String> {
        get(self.store.mtime.as_slice(), id, "mtime")
    }

    /// `store.extension(id)`, with a row Node decides left pending under its raw suffix.
    fn extension(&self, id: usize) -> Result<Extension, String> {
        let node = u32::try_from(id).map_err(|e| e.to_string())?;
        if self.pending.contains(&node) {
            return Ok(match extension(self.name(id)?) {
                None => Extension::None,
                Some(raw) => Extension::Pending(raw.to_vec()),
            });
        }
        let text = match get(self.store.ext.as_slice(), id, "ext")? {
            EXT_NONE => return Ok(Extension::None),
            EXT_OVERFLOW => self
                .store
                .ext_overflow
                .binary_search_by_key(&node, |(n, _)| *n)
                .ok()
                .and_then(|at| self.store.ext_overflow.get(at))
                .map(|(_, text)| text.clone())
                .ok_or_else(|| format!("row {id} overflows the dictionary, unlisted"))?,
            known => self
                .store
                .ext_dict
                .get(usize::from(known))
                .cloned()
                .ok_or_else(|| format!("row {id}'s extension is past the dictionary"))?,
        };
        Ok(Extension::Known(text.into_bytes()))
    }

    /// `eachFile(root)`: pre-order over the child ranges, files visited, folders descended.
    fn files(&self) -> Result<Vec<Visit>, String> {
        let mut out = Vec::new();
        let mut stack = vec![(0usize, self.root_path.clone(), PositionPath::root())];
        while let Some((id, path, position)) = stack.pop() {
            if !self.is_dir(id)? {
                out.push(Visit { id, path, position });
                continue;
            }
            let kids = self.children(id)?;
            let first = kids.start;
            for child in kids.rev() {
                let index = u32::try_from(child - first).map_err(|e| e.to_string())?;
                stack.push((
                    child,
                    joined(&path, self.name(child)?),
                    position.child(index),
                ));
            }
        }
        Ok(out)
    }

    fn file_answer(&self, visit: &Visit) -> Result<FileAnswer, String> {
        Ok(FileAnswer {
            name: self.name(visit.id)?.to_vec(),
            path: visit.path.clone(),
            size: whole(self.size(visit.id)?),
            extension: self.extension(visit.id)?,
            modified_at: self.mtime(visit.id)?,
            position: visit.position.clone(),
        })
    }

    /// `collectLargestFiles`, step for step: a bounded insertion that sorts once full and
    /// replaces its last entry only with a strictly larger file, then a final stable sort.
    fn largest_files(&self, limit: usize, min_size: f64) -> Result<Vec<FileAnswer>, String> {
        let mut top: Vec<(usize, f64)> = Vec::new();
        let files = &self.visits;
        for (at, visit) in files.iter().enumerate() {
            let size = self.size(visit.id)?;
            if size < min_size {
                continue;
            }
            if top.len() < limit {
                top.push((at, size));
                if top.len() == limit {
                    top.sort_by(|a, b| b.1.total_cmp(&a.1));
                }
            } else if top.last().is_some_and(|last| size > last.1) {
                // The collector overwrites its last entry and sorts again, stably. Only the
                // newcomer moves, to just before the first entry smaller than it (entries
                // as large stay ahead of it, as a stable sort keeps them): the same order,
                // without sorting 2,000 entries for every larger file.
                top.pop();
                let place = top.partition_point(|kept| kept.1 >= size);
                top.insert(place, (at, size));
            }
        }
        top.sort_by(|a, b| b.1.total_cmp(&a.1));
        top.iter()
            .map(|&(at, _)| {
                files
                    .get(at)
                    .ok_or_else(|| "a kept file vanished".to_owned())
                    .and_then(|visit| self.file_answer(visit))
            })
            .collect()
    }

    /// `collectLargestFolders`: the folders at `min_size` or more in post-order, then a
    /// stable sort by total, cut at `limit`.
    fn largest_folders(&self, limit: usize, min_size: f64) -> Vec<FolderAnswer> {
        let mut found: Vec<FolderAnswer> = self
            .post_order
            .iter()
            .filter(|folder| to_f64(folder.size) >= min_size)
            .cloned()
            .collect();
        found.sort_by_key(|folder| Reverse(folder.size));
        found.truncate(limit);
        found
    }

    /// Every folder below the root in post-order, with its total and recursive file count.
    fn folders_in_post_order(&self) -> Result<Vec<FolderAnswer>, String> {
        struct Frame {
            id: usize,
            path: Vec<u8>,
            position: PositionPath,
            kids: Range<usize>,
            next: usize,
            bytes: u128,
            files: u64,
        }
        let mut found = Vec::new();
        let root_kids = self.children(0)?;
        let mut stack = vec![Frame {
            id: 0,
            path: self.root_path.clone(),
            position: PositionPath::root(),
            next: root_kids.start,
            kids: root_kids,
            bytes: 0,
            files: 0,
        }];
        while let Some(top) = stack.last_mut() {
            if top.next < top.kids.end {
                let child = top.next;
                top.next += 1;
                let index = u32::try_from(child - top.kids.start).map_err(|e| e.to_string())?;
                let path = joined(&top.path, self.name(child)?);
                let position = top.position.child(index);
                if self.is_dir(child)? {
                    let kids = self.children(child)?;
                    stack.push(Frame {
                        id: child,
                        path,
                        position,
                        next: kids.start,
                        kids,
                        bytes: 0,
                        files: 0,
                    });
                } else {
                    top.bytes += u128::from(whole(self.size(child)?));
                    top.files += 1;
                }
                continue;
            }
            let Some(done) = stack.pop() else { break };
            if let Some(parent) = stack.last_mut() {
                parent.bytes += done.bytes;
                parent.files += done.files;
                found.push(FolderAnswer {
                    name: self.name(done.id)?.to_vec(),
                    path: done.path,
                    size: done.bytes,
                    file_count: done.files,
                    modified_at: self.mtime(done.id)?,
                    position: done.position,
                });
            }
        }
        Ok(found)
    }

    /// `collectFileTypes`: a Map in first-seen pre-order, then a stable sort by bytes.
    fn file_types(&self) -> Result<Vec<TypeAnswer>, String> {
        let mut order: Vec<TypeAnswer> = Vec::new();
        let mut at: HashMap<Extension, usize> = HashMap::new();
        for visit in &self.visits {
            let ext = self.extension(visit.id)?;
            let bytes = u128::from(whole(self.size(visit.id)?));
            if let Some(&slot) = at.get(&ext) {
                let entry = order.get_mut(slot).ok_or("a type vanished")?;
                entry.count += 1;
                entry.bytes += bytes;
            } else {
                at.insert(ext.clone(), order.len());
                order.push(TypeAnswer {
                    extension: ext,
                    count: 1,
                    bytes,
                    first: visit.position.clone(),
                });
            }
        }
        order.sort_by_key(|row| Reverse(row.bytes));
        Ok(order)
    }

    /// `computeSizeDistribution`'s counts.
    fn histogram(&self) -> Result<(Vec<u64>, u64), String> {
        let mut counts = vec![0u64; SIZE_BUCKETS];
        let mut files = 0u64;
        for visit in &self.visits {
            let slot = counts
                .get_mut(size_bucket(self.size(visit.id)?))
                .ok_or("a bucket past the last")?;
            *slot += 1;
            files += 1;
        }
        Ok((counts, files))
    }
}

fn whole(size: f64) -> u64 {
    if size.is_finite() && size >= 0.0 {
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a finite size of no less than zero: the walk's own whole-byte rule"
        )]
        let bytes = size as u64;
        bytes
    } else {
        0
    }
}

#[expect(
    clippy::cast_precision_loss,
    reason = "a total as JavaScript's number holds it, as the collectors compare it"
)]
fn to_f64(bytes: u128) -> f64 {
    bytes as f64
}

// ---------------------------------------------------------------------------
// Holding the answers to the port
// ---------------------------------------------------------------------------

const LIMITS: [usize; 7] = [1, 2, 3, 10, 100, KEEP - 1, KEEP];
const MIN_SIZES: [f64; 7] = [0.0, 1.0, 2.0, 50.0, 1_000.0, 1e6, 1e15];

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

fn check(answers: &Answers, port: &Port<'_>, at: &str) -> TestResult {
    for limit in LIMITS {
        for min in MIN_SIZES {
            let want = port.largest_files(limit, min)?;
            let got: Vec<FileAnswer> = answers
                .largest_files
                .iter()
                .filter(|f| to_f64(u128::from(f.size)) >= min)
                .take(limit)
                .cloned()
                .collect();
            assert_eq!(
                got, want,
                "{at}: the largest files, limit {limit}, minimum {min}"
            );
            let want = port.largest_folders(limit, min);
            let got: Vec<FolderAnswer> = answers
                .largest_folders
                .iter()
                .filter(|f| to_f64(f.size) >= min)
                .take(limit)
                .cloned()
                .collect();
            assert_eq!(
                got, want,
                "{at}: the largest folders, limit {limit}, minimum {min}"
            );
        }
    }
    assert!(
        answers.largest_files.len() <= KEEP,
        "{at}: at most KEEP files kept"
    );
    assert!(
        answers.largest_folders.len() <= KEEP,
        "{at}: at most KEEP folders kept"
    );
    assert_eq!(
        answers.file_types,
        Ok(port.file_types()?),
        "{at}: the file types"
    );
    let (counts, files) = port.histogram()?;
    assert_eq!(answers.size_histogram, counts, "{at}: the size histogram");
    assert_eq!(answers.files, files, "{at}: every file counted");
    Ok(())
}

fn check_fixture(fixture: &Fixture, root_name: &str) -> TestResult {
    let root = root_bytes(fixture);
    for workers in WORKERS {
        let walked = walk(fixture, workers, DEFAULT_Q_MAX)?;
        let store = build_of(&walked, root_name)?;
        let port = Port::new(&store, root.clone())?;
        check(
            &walked.answers,
            &port,
            &format!("{} at {workers} worker(s)", fixture.name),
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Trees for the answers
// ---------------------------------------------------------------------------

const TIES_ROOT: &str = "/t12b/ties";
const OWN_TIMES_ROOT: &str = "/t12b/own-times";
const ZEROS_ROOT: &str = "/t12b/zeros";
const CHAINS_ROOT: &str = "/t12b/chains";
const NAMES_ROOT: &str = "/t12b/names";

/// Ties everywhere: 30 folders of 100 files whose sizes repeat every five, so both lists
/// break ties by order at their limits, and folders whose totals repeat too.
fn ties_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    for d in 0..30_u32 {
        let folder = b.dir("", format!("t{d:02}").as_bytes())?;
        let inner = b.dir(&folder, b"inner")?;
        for f in 0..100_u32 {
            let ext = match f % 3 {
                0 => "txt",
                1 => "log",
                _ => "bin",
            };
            b.file(
                &folder,
                format!("f{f:03}.{ext}").as_bytes(),
                f64::from(f % 5),
            )?;
        }
        for f in 0..(d % 4) {
            b.file(&inner, format!("g{f}.dat").as_bytes(), 7.0)?;
        }
    }
    Ok(b.finish(TIES_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// 1,200 chains, each a folder holding one folder holding one file: 2,400 folders in pairs
/// whose totals are equal, a descendant and its ancestor; and one larger folder ahead of
/// them all. So the list's 2,000th place falls inside the 1,000th pair, where post-order
/// keeps the descendant and pre-order would keep the ancestor.
fn chains_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    let ahead = b.dir("", b"a-ahead")?;
    b.file(&ahead, b"big.bin", 1e9)?;
    for c in 0..1_200_u32 {
        let chain = b.dir("", format!("c{c:04}").as_bytes())?;
        let link = b.dir(&chain, b"s")?;
        b.file(&link, b"f.bin", f64::from(c + 1))?;
    }
    Ok(b.finish(CHAINS_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// Zero-byte files only, some with an extension and some without, so the files kept at
/// every limit are the first in pre-order and the types tie at 0 bytes.
fn zeros_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    for d in 0..5_u32 {
        let folder = b.dir("", format!("z{d}").as_bytes())?;
        for f in 0..700_u32 {
            let name = if f % 7 == 0 {
                format!("none{f}")
            } else {
                format!("f{f}.e{}", f % 11)
            };
            b.file(&folder, name.as_bytes(), 0.0)?;
        }
    }
    Ok(b.finish(ZEROS_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// Names whose extension Node decides (a byte past ASCII and a dot), dotfiles, names with
/// no extension, and ASCII names in mixed case.
fn names_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    let named = b.dir("", b"named")?;
    let names: [(&[u8], f64); 12] = [
        ("caf\u{e9}.TXT".as_bytes(), 10.0),
        ("na\u{ef}ve.Txt".as_bytes(), 20.0),
        ("\u{65e5}\u{672c}.txt".as_bytes(), 30.0),
        ("r\u{e9}sum\u{e9}.\u{c9}XT".as_bytes(), 40.0),
        (".caf\u{e9}".as_bytes(), 50.0),
        (b"plain.TXT", 60.0),
        (b"PLAIN.txt", 70.0),
        (b"Makefile", 80.0),
        (b".bashrc", 90.0),
        (b"trailing.", 100.0),
        ("\u{65e5}\u{672c}".as_bytes(), 110.0),
        (b"x\xF8.dat", 120.0),
    ];
    for (name, size) in names {
        b.file(&named, name, size)?;
    }
    Ok(b.finish(NAMES_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// Listed as Windows lists: in the folder's own order, each folder's listing reading its
/// own times from the folder itself, which replace what its parent's listing said.
fn own_times_tree() -> Result<common::scripted::ScriptedTree, String> {
    let mut b = Builder::with_root();
    let mut folders = Vec::new();
    for d in 0..6_u32 {
        let folder = b.dir("", format!("w{d}").as_bytes())?;
        for f in 0..=d {
            b.file(
                &folder,
                format!("f{f}.bin").as_bytes(),
                f64::from(100 * (d + 1)),
            )?;
        }
        folders.push(folder);
    }
    for (d, folder) in (0_u32..).zip(&folders) {
        b.own_times(folder, 5_000.25 + f64::from(d), 6_000.5)?;
    }
    Ok(b.finish(OWN_TIMES_ROOT, folder_meta(1), false, FastPath::ExtdDirInfo))
}

fn synthetic(name: &'static str, spec: SyntheticSpec) -> Fixture {
    Fixture {
        name,
        root: synthetic_temp_folder().join("t12b"),
        source: Source::Synthetic(spec),
        never_descend: Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

#[test]
fn the_answers_equal_the_collectors_on_scripted_trees() -> TestResult {
    let mut mixed = scripted("mixed", common::aggregate::MIXED_ROOT, mixed_tree()?);
    mixed.never_descend = vec![mixed.root.join("never")];
    check_fixture(&mixed, "mixed")?;
    check_fixture(
        &scripted("deep", common::aggregate::DEEP_ROOT, deep_tree()?),
        "deep",
    )?;
    check_fixture(
        &scripted("chunked", common::aggregate::CHUNKED_ROOT, chunked_tree()?),
        "chunked",
    )?;
    check_fixture(&scripted("wide", WIDE_ROOT, wide_tree()?), "wide")
}

#[test]
fn a_folders_own_times_replace_what_its_parent_listed() -> TestResult {
    let fixture = scripted("own times", OWN_TIMES_ROOT, own_times_tree()?);
    check_fixture(&fixture, "own-times")?;
    let walked = walk(&fixture, 1, DEFAULT_Q_MAX)?;
    let times: Vec<f64> = walked
        .answers
        .largest_folders
        .iter()
        .map(|folder| folder.modified_at)
        .collect();
    assert_eq!(
        times,
        vec![5_005.0, 5_004.0, 5_003.0, 5_002.0, 5_001.0, 5_000.0],
        "each folder's own time, rounded as the store rounds it"
    );
    Ok(())
}

#[test]
fn ties_fall_as_the_collectors_let_them_fall() -> TestResult {
    check_fixture(&scripted("ties", TIES_ROOT, ties_tree()?), "ties")?;
    check_fixture(&scripted("chains", CHAINS_ROOT, chains_tree()?), "chains")?;
    check_fixture(&scripted("zeros", ZEROS_ROOT, zeros_tree()?), "zeros")
}

#[test]
fn extensions_node_decides_stay_pending_under_their_raw_suffix() -> TestResult {
    let fixture = scripted("names", NAMES_ROOT, names_tree()?);
    check_fixture(&fixture, "names")?;
    let walked = walk(&fixture, 1, DEFAULT_Q_MAX)?;
    let types = walked.answers.file_types.clone()?;
    let pending: Vec<&Extension> = types
        .iter()
        .map(|t| &t.extension)
        .filter(|e| matches!(e, Extension::Pending(_)))
        .collect();
    assert_eq!(
        pending,
        vec![
            &Extension::Pending(b"dat".to_vec()),
            &Extension::Pending("\u{c9}XT".as_bytes().to_vec()),
            &Extension::Pending(b"txt".to_vec()),
            &Extension::Pending(b"Txt".to_vec()),
            &Extension::Pending(b"TXT".to_vec()),
        ],
        "one pending entry per raw suffix, by bytes"
    );
    Ok(())
}

#[test]
fn the_answers_equal_the_collectors_on_synthetic_trees() -> TestResult {
    let developer = |seed| SyntheticSpec {
        link_ppm: 0,
        ..SyntheticSpec::developer(30_000, seed)
    };
    check_fixture(
        &synthetic("synthetic developer seed 1", developer(1)),
        "t12b",
    )?;
    check_fixture(
        &synthetic(
            "synthetic folders 33%",
            SyntheticSpec {
                folder_ppm: 330_000,
                ..developer(2)
            },
        ),
        "t12b",
    )?;
    check_fixture(
        &synthetic(
            "synthetic folders 1%",
            SyntheticSpec {
                folder_ppm: 10_000,
                ..developer(3)
            },
        ),
        "t12b",
    )
}

/// The collectors' answers for three synthetic trees, as `tests/fixtures/collectorsOracle.ts`
/// wrote them from the TypeScript itself.
fn oracle() -> Result<String, String> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("collectors-oracle.tsv");
    std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))
}

fn field<T: std::str::FromStr>(fields: &[&str], at: usize, what: &str) -> Result<T, String> {
    fields
        .get(at)
        .and_then(|text| text.parse().ok())
        .ok_or_else(|| format!("the oracle's {what} is missing or malformed"))
}

/// The port's lines for one tree, as the TypeScript writes them.
fn port_text(port: &Port<'_>, root: &[u8], spec_line: &str) -> Result<Vec<String>, String> {
    let under = |path: &[u8]| -> Result<String, String> {
        let rest = path
            .strip_prefix(root)
            .and_then(|rest| rest.strip_prefix(b"/"))
            .ok_or("a path outside the root")?;
        Ok(String::from_utf8_lossy(rest).into_owned())
    };
    let ext_text = |ext: &Extension, none: &str| match ext {
        Extension::None => none.to_owned(),
        Extension::Known(text) | Extension::Pending(text) => {
            String::from_utf8_lossy(text).into_owned()
        }
    };
    let mut lines = vec![spec_line.to_owned()];
    for f in port.largest_files(KEEP, 0.0)? {
        lines.push(format!(
            "file\t{}\t{}\t{}\t{}",
            under(&f.path)?,
            f.size,
            ext_text(&f.extension, ""),
            f.modified_at
        ));
    }
    for f in port.largest_folders(KEEP, 0.0) {
        lines.push(format!(
            "folder\t{}\t{}\t{}\t{}",
            under(&f.path)?,
            f.size,
            f.file_count,
            f.modified_at
        ));
    }
    for (limit, min) in [(10_usize, 0.0), (100, 1_000.0)] {
        for f in port.largest_files(limit, min)? {
            lines.push(format!(
                "short\t{limit}\t{min}\t{}\t{}\t{}\t{}",
                under(&f.path)?,
                f.size,
                ext_text(&f.extension, ""),
                f.modified_at
            ));
        }
    }
    for t in port.file_types()? {
        lines.push(format!(
            "type\t{}\t{}\t{}",
            ext_text(&t.extension, "(none)"),
            t.count,
            t.bytes
        ));
    }
    let (counts, files) = port.histogram()?;
    let counts: Vec<String> = counts.iter().map(u64::to_string).collect();
    lines.push(format!("histogram\t{files}\t{}", counts.join(",")));
    Ok(lines)
}

#[test]
fn the_port_answers_as_the_typescript_collectors_do() -> TestResult {
    let text = oracle()?;
    let mut sections: Vec<Vec<&str>> = Vec::new();
    for line in text.lines() {
        if line.starts_with("spec\t") {
            sections.push(Vec::new());
        }
        sections
            .last_mut()
            .ok_or("the oracle does not start with a spec")?
            .push(line);
    }
    assert_eq!(sections.len(), 3, "three trees in the oracle");
    for section in sections {
        let spec_line = *section.first().ok_or("an empty section")?;
        let fields: Vec<&str> = spec_line.split('\t').collect();
        let (entries, seed): (u64, u64) =
            (field(&fields, 1, "entries")?, field(&fields, 2, "seed")?);
        let spec = SyntheticSpec {
            folder_ppm: field(&fields, 3, "folder share")?,
            link_ppm: field(&fields, 4, "link share")?,
            size_sigma_milli: field(&fields, 5, "size spread")?,
            ..SyntheticSpec::developer(entries, seed)
        };
        let fixture = Fixture {
            name: "the collectors' oracle",
            root: synthetic_temp_folder().join(format!("t12b-oracle-{seed}")),
            source: Source::Synthetic(spec),
            never_descend: Vec::new(),
        };
        let walked = walk(&fixture, 2, DEFAULT_Q_MAX)?;
        let store = build_of(&walked, "oracle")?;
        let root = root_bytes(&fixture);
        let port = Port::new(&store, root.clone())?;
        let ours = port_text(&port, &root, spec_line)?;
        let theirs: Vec<String> = section.iter().map(|line| (*line).to_owned()).collect();
        let first_difference = ours.iter().zip(&theirs).position(|(a, b)| a != b);
        assert!(
            first_difference.is_none() && ours.len() == theirs.len(),
            "seed {seed}: the port's line {:?} is {:?}, the collectors' {:?} ({} lines against {})",
            first_difference,
            first_difference.and_then(|at| ours.get(at)),
            first_difference.and_then(|at| theirs.get(at)),
            ours.len(),
            theirs.len()
        );
    }
    Ok(())
}

#[test]
fn past_the_extension_limit_the_file_types_are_refused_with_the_reason() -> TestResult {
    let fixture = scripted("wide", WIDE_ROOT, wide_tree()?);
    let walked = walk_limited(&fixture, 4, DEFAULT_Q_MAX, root_bytes(&fixture), 10)?;
    match &walked.answers.file_types {
        Err(reason) => assert!(
            reason.contains("10 distinct extensions"),
            "the reason names the limit: {reason}"
        ),
        Ok(types) => {
            return Err(format!("{} types answered past a limit of 10", types.len()));
        }
    }
    assert!(
        !walked.answers.largest_files.is_empty(),
        "everything else still answers"
    );
    let within = walk_limited(
        &fixture,
        4,
        DEFAULT_Q_MAX,
        root_bytes(&fixture),
        EXTENSION_LIMIT,
    )?;
    assert!(
        within.answers.file_types.is_ok(),
        "the wide tree's extensions are under the limit"
    );
    // At the limit exactly, the types answer; one fewer allowed, and they are refused.
    let names = scripted("names", NAMES_ROOT, names_tree()?);
    let all = walk(&names, 1, DEFAULT_Q_MAX)?.answers.file_types?.len();
    let at_limit = walk_limited(&names, 1, DEFAULT_Q_MAX, root_bytes(&names), all)?;
    assert!(
        at_limit.answers.file_types.is_ok(),
        "{all} extensions at a limit of {all}"
    );
    let below = walk_limited(&names, 1, DEFAULT_Q_MAX, root_bytes(&names), all - 1)?;
    assert!(
        below.answers.file_types.is_err(),
        "{all} extensions past a limit of {}",
        all - 1
    );
    Ok(())
}

#[test]
fn a_size_is_in_the_bucket_whose_start_it_has_reached() {
    for (index, &bits) in SIZE_BUCKET_STARTS.iter().enumerate() {
        let bucket = index + 1;
        let start = f64::from_bits(bits);
        assert_eq!(
            size_bucket(start),
            bucket,
            "bucket {bucket} starts at {start}"
        );
        let below = f64::from_bits(bits - 1);
        assert_eq!(
            size_bucket(below),
            bucket - 1,
            "{below} is in the bucket before"
        );
    }
    assert_eq!(size_bucket(0.0), 0);
    assert_eq!(size_bucket(-3.0), 0);
    assert_eq!(size_bucket(f64::NAN), 0);
    assert_eq!(size_bucket(1.0), 0);
    assert_eq!(size_bucket(2.0), 16);
    assert_eq!(size_bucket(f64::MAX), SIZE_BUCKETS - 1);
}

/// The separator the harness joins with, named so a change to it shows here too.
#[test]
fn the_harness_joins_with_a_slash() {
    assert_eq!(SEP, b'/');
}

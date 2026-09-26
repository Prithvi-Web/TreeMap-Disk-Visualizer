//! `MemorySink` (Phase 4, T7a; design §S.1.3, §S.2): the finalized store's columns,
//! written during the walk at the ids each listing's block reserved, from several workers
//! at once and outside the commit lock, then sealed into a `Store`.
//!
//! Each walk here feeds the sink and the walk's own collector at once, so one listing of
//! the tree gives both the sink's store and `build(take())`, and the two are held equal
//! through φ: the bijection that walks both stores breadth-first over their child ranges
//! from the root in step, pairing the k-th child of a folder with the k-th child of its
//! image (design §S.2). Every column is compared through φ — names, parents, sizes,
//! times, the access-time column's presence, flags, containers, providers, extensions by
//! their TEXT (the dictionaries' ids may differ, Lemma 4), child ranges — and so are `n`,
//! the capacity, every counter, the cloud candidates and `sparse_terms` (in breadth-first
//! order: `build`'s ids are breadth-first, so through φ the sink's lists must be `build`'s
//! own, in the same order), and the text candidates and denied folders (as φ-mapped sets,
//! each list ascending). The hard-link winner is `build`'s: the member of a family that
//! comes first breadth-first keeps the bytes (P4-2a; T7b), so the `HARDLINK_DUP` flag and
//! every member's size are compared row by row. Where the walk re-reads a family found
//! by file id (Windows-shaped listings, which report no link counts), the seal re-reads it
//! the same way, so every member's size, times, access-time bit and cloud candidacy are
//! compared too (T7b; the `refresh` trees change each of them). Nothing is left out. The
//! sink's store must also hold I1–I4.
//!
//! Every test counts; a wait is a hang guard only, never what a passing test depends on.

use std::collections::VecDeque;
use std::panic::panic_any;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use tm_store::{
    AnonTally, BuildOptions, Counters, EXT_NONE, EXT_OVERFLOW, MemorySink, Store, StoreError,
    StoreMode, anon_tally, build, flag,
};
use tm_walk::invariants::check_walk_columns;
use tm_walk::platform::{ListBuffer, Lister, Meta};
use tm_walk::walk::{MAX_WORKERS, Pacer};
use tm_walk::{
    BIG_LISTING, Block, DEFAULT_Q_MAX, FastPath, Finishing, ListingSink, Numbering, Refusal,
    SyntheticSpec, WalkError, WalkHandle, WalkOptions, WalkOutput, lister_for, start_with_sinks,
    synthetic_temp_folder,
};

mod common;

use common::scripted::{
    BLOCK, Builder, EMOJI, Folder, INVALID, Listed, POSIX_ROOT, ScriptedTree, WIDE_ROOT,
    WINDOWS_ROOT, container_rules, dataless, file_meta, folder_meta, posix_tree, wide_tree,
    windows_tree,
};

type TestResult = Result<(), String>;

/// Worker counts every tree is walked at.
const WORKERS: [u32; 4] = [1, 2, 8, 64];
/// Queue thresholds every scripted and 30k tree is walked at: first-in first-out while
/// the backlog is small (the default), and last-in first-out from the first folder
/// waiting, which commits listings in an order breadth-first never takes.
const Q_MAXES: [usize; 2] = [DEFAULT_Q_MAX, 1];
/// Rows every sink here has room for, headroom included: reserved, not resident.
const ROOM_ROWS: u32 = 2_000_000;
/// Name bytes every sink here has room for.
const ROOM_NAMES: u64 = 128 * 1024 * 1024;
/// How long a hang guard waits before a test fails instead of hanging.
const SETTLE: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(2);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// Where a fixture's listings come from.
enum Source {
    Scripted(Arc<ScriptedTree>),
    Synthetic(SyntheticSpec),
}

struct Fixture {
    name: &'static str,
    root: PathBuf,
    source: Source,
    want_atime: bool,
    never_descend: Vec<PathBuf>,
    build: BuildOptions,
}

/// What Node would pass: POSIX sorts children and has blocks, Windows neither.
fn options(root_name: &str, root_mtime_ms: f64, posix: bool, headroom_rows: u32) -> BuildOptions {
    BuildOptions {
        root_name: root_name.to_owned(),
        root_mtime_ms,
        blocks_are_meaningful: posix,
        sort_children: posix,
        container_rules: container_rules(),
        headroom_rows,
        mode: StoreMode::Memory,
    }
}

fn scripted(
    name: &'static str,
    root: &str,
    tree: ScriptedTree,
    want_atime: bool,
    build: BuildOptions,
) -> Fixture {
    Fixture {
        name,
        root: PathBuf::from(root),
        source: Source::Scripted(Arc::new(tree)),
        want_atime,
        never_descend: Vec::new(),
        build,
    }
}

const MIXED_ROOT: &str = "/t7a/mixed";
const COMPLETE_ROOT: &str = "/t7a/complete";
const BIG_ROOT: &str = "/t7a/big";
const CHUNKS_ROOT: &str = "/t7a/chunks";
/// Files in the chunks tree's one folder: with their long names, three of the walk's
/// 4 MiB chunks.
const CHUNK_FILES: u32 = 70_000;

/// tm-walk's `mixed_tree` (tests/blocks.rs): wide and deep folders, empty and refused
/// ones, a name that is a path, a never-descend folder, a hard-linked pair across
/// folders, names that are not UTF-8; and a folder named with an extension no file
/// has, which no store's dictionary may hold (a folder has no extension).
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
        }
    }
    b.dir("", b"empty")?;
    b.refused("", b"denied", Refusal::Denied)?;
    b.refused("", b"gone", Refusal::Vanished)?;
    b.put_new("", b"sl/ash", folder_meta)?;
    let never = b.dir("", b"never")?;
    b.file(&never, b"inside.bin", 3.0)?;
    let a = b.dir("", b"links-a")?;
    let other = b.dir("", b"links-b")?;
    b.put(&a, b"one", file_meta(10.0, 4_096.0, 7_000, 2))?;
    b.put(&other, b"two", file_meta(10.0, 4_096.0, 7_000, 2))?;
    let odd = b.dir("", b"odd\xF8")?;
    b.file(&odd, b"x\xF9.txt", 2.0)?;
    b.file(&odd, "x😀.txt".as_bytes(), 3.0)?;
    b.dir("", b"archive.folderonly")?;
    Ok(b.finish(MIXED_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// A complete tree: every folder above depth `depth` holds `fan` subfolders and a file.
fn complete_tree(fan: u32, depth: u32) -> Result<ScriptedTree, String> {
    let mut b = Builder::with_root();
    let mut level = vec![String::new()];
    for _ in 0..depth {
        let mut next = Vec::new();
        for parent in &level {
            b.file(parent, b"file.txt", 1.0)?;
            for k in 0..fan {
                next.push(b.dir(parent, format!("s{k}").as_bytes())?);
            }
        }
        level = next;
    }
    Ok(b.finish(COMPLETE_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// Two folders of `BIG_LISTING + 50` files, which go through the big-listing semaphore
/// one after the other, and a small one.
fn two_big_folders() -> Result<ScriptedTree, String> {
    let mut b = Builder::with_root();
    for d in ["big1", "big2"] {
        let rel = b.dir("", d.as_bytes())?;
        for f in 0..(BIG_LISTING + 50) {
            b.file(&rel, format!("{d}-{f:06}.dat").as_bytes(), 1.0)?;
        }
    }
    let small = b.dir("", b"small")?;
    b.file(&small, b"one.txt", 1.0)?;
    Ok(b.finish(BIG_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// The name of file `f` in the chunks tree: long, so a chunk holds fewer rows.
fn chunk_name(f: u32) -> String {
    format!("a-rather-long-name-for-the-chunks-{f:06}.bin")
}

/// One folder of `CHUNK_FILES` files, file `f` of `f` bytes.
fn chunks_tree() -> Result<ScriptedTree, String> {
    let mut b = Builder::with_root();
    let wide = b.dir("", b"wide")?;
    for f in 0..CHUNK_FILES {
        b.file(&wide, chunk_name(f).as_bytes(), f64::from(f))?;
    }
    Ok(b.finish(CHUNKS_ROOT, folder_meta(1), true, FastPath::Bulk))
}

fn posix_fixture() -> Result<Fixture, String> {
    let mut fixture = scripted(
        "scripted-posix",
        POSIX_ROOT,
        posix_tree()?,
        true,
        options("posix", 1_234_567.0, true, 64),
    );
    fixture.never_descend = vec![fixture.root.join("Volumes")];
    Ok(fixture)
}

fn windows_fixture() -> Result<Fixture, String> {
    Ok(scripted(
        "scripted-windows",
        WINDOWS_ROOT,
        windows_tree()?,
        true,
        options("windows", 5.0, false, 0),
    ))
}

fn chunks_fixture() -> Result<Fixture, String> {
    Ok(scripted(
        "scripted-chunks",
        CHUNKS_ROOT,
        chunks_tree()?,
        false,
        options("chunks", 0.0, true, 16),
    ))
}

const OWN_TIMES_ROOT: &str = "/t7a/own-times";
const OWN_TIMES_DROP_ROOT: &str = "/t7a/own-times-drop";

/// `meta` with no access time recorded.
fn unaccessed(meta: Meta) -> Meta {
    Meta {
        atime_ms: f64::NAN,
        ..meta
    }
}

/// Windows-shaped folders whose own listings change whether they have an access time:
/// `keeps`' parent's copy has one and its own times none; `gains`' parent's copy has
/// none and its own times one.
fn own_times_tree() -> Result<ScriptedTree, String> {
    let mut b = Builder::with_root();
    let keeps = b.dir("", b"keeps")?;
    b.file(&keeps, b"k.txt", 1.0)?;
    b.own_times(&keeps, 1_000.5, f64::NAN)?;
    let ino = b.ino();
    let gains = b.folder(
        "",
        b"gains",
        unaccessed(folder_meta(ino)),
        Folder::Listed(Listed::default()),
    )?;
    b.file(&gains, b"g.txt", 2.0)?;
    b.own_times(&gains, 2_000.5, 3_000.5)?;
    Ok(b.finish(OWN_TIMES_ROOT, folder_meta(1), false, FastPath::ExtdDirInfo))
}

/// A Windows-shaped walk whose one access time is a folder's parent's copy, which the
/// folder's own listing takes away: the store then has no access-time column at all.
fn own_times_drop_tree() -> Result<ScriptedTree, String> {
    let mut b = Builder::with_root();
    let only = b.dir("", b"only")?;
    b.own_times(&only, 5.5, f64::NAN)?;
    let ino = b.ino();
    b.put(&only, b"f.txt", unaccessed(file_meta(1.0, 4_096.0, ino, 1)))?;
    let ino = b.ino();
    b.put("", b"g.txt", unaccessed(file_meta(1.0, 4_096.0, ino, 1)))?;
    Ok(b.finish(
        OWN_TIMES_DROP_ROOT,
        unaccessed(folder_meta(1)),
        false,
        FastPath::ExtdDirInfo,
    ))
}

/// One family of [`refresh_tree`]: its member in the root, its member in `ok`, the
/// root member's listed size (the other lists one more), the listings' allocation, the
/// size the re-read finds, whether its listings flag a placeholder, and whether the walk
/// can re-read it.
struct RefreshFamily {
    first: &'static [u8],
    second: &'static [u8],
    listed: f64,
    alloc: f64,
    read: f64,
    placeholder: bool,
    reread: bool,
}

const REFRESH_GAINS_ROOT: &str = "/t7b/refresh-gains";
const REFRESH_LOSES_ROOT: &str = "/t7b/refresh-loses";

/// Windows-shaped hard-link families (no link counts) whose re-read changes more than a
/// size (T7b). Each family has a member in the root and one in `ok`, and the file itself
/// is read with other times and, for most, another size. What a member is then derived
/// from changes with it: whether it is a cloud candidate (bytes claimed with none
/// allocated — by the listing's allocation, which the re-read does not replace: `b` gains
/// the candidacy, `c` loses it, `f` keeps it only by its listing), a placeholder's counted
/// bytes (`p`, whose listing flag the re-read does not replace), and whether it has an
/// access time. Every other row has none, so the store's access-time column exists by the
/// re-read alone when `gains`; when not, only the families' listings have access times and
/// the re-read takes them all away, and with them the column.
///
/// Family `a` is never re-read: the member read is the lowest-numbered, `q\xF9.bin` in the
/// root, whose stored name `q\u{FFFD}.bin` is also `q\xF8.bin`'s, listed before it; so the
/// read reaches that file and counts for nothing (the walk's `refresh_families`), while a
/// read through its other member would reach its own file.
fn refresh_tree(root: &str, gains: bool) -> Result<ScriptedTree, String> {
    let mut b = Builder::with_root();
    let ino = b.ino();
    b.put("", b"q\xF8.bin", unaccessed(file_meta(1.0, BLOCK, ino, 0)))?;
    let ino = b.ino();
    let ok = b.folder(
        "",
        b"ok",
        unaccessed(folder_meta(ino)),
        Folder::Listed(Listed::default()),
    )?;
    let families = [
        RefreshFamily {
            first: b"q\xF9.bin",
            second: b"a.bin",
            listed: 20.0,
            alloc: BLOCK,
            read: 25.0,
            placeholder: false,
            reread: false,
        },
        RefreshFamily {
            first: b"b.bin",
            second: b"b.bin",
            listed: 0.0,
            alloc: 0.0,
            read: 5.0,
            placeholder: false,
            reread: true,
        },
        RefreshFamily {
            first: b"c.bin",
            second: b"c.bin",
            listed: 8.0,
            alloc: 0.0,
            read: 0.0,
            placeholder: false,
            reread: true,
        },
        RefreshFamily {
            first: b"f.bin",
            second: b"f.bin",
            listed: 9.0,
            alloc: 0.0,
            read: 10.0,
            placeholder: false,
            reread: true,
        },
        RefreshFamily {
            first: b"p.bin",
            second: b"p.bin",
            listed: 30.0,
            alloc: 0.0,
            read: 33.0,
            placeholder: true,
            reread: true,
        },
    ];
    for (k, family) in families.into_iter().enumerate() {
        let ino = b.ino();
        let step = f64::from(u8::try_from(k).map_err(|e| e.to_string())?);
        let listing = |size: f64| {
            let meta = file_meta(size, family.alloc, ino, 0);
            let meta = if family.placeholder {
                dataless(meta)
            } else {
                meta
            };
            // Only a family the walk re-reads has access times in its listings, and only
            // when the re-read takes them away.
            if family.reread && !gains {
                meta
            } else {
                unaccessed(meta)
            }
        };
        b.put("", family.first, listing(family.listed))?;
        b.put(&ok, family.second, listing(family.listed + 1.0))?;
        let file = Meta {
            mtime_ms: 7_000.5 + step,
            atime_ms: if gains { 7_100.25 + step } else { f64::NAN },
            ..file_meta(family.read, BLOCK, ino, 2)
        };
        b.reads(ino, Ok(file));
    }
    let root_meta = Meta {
        nlink: 0,
        ..unaccessed(folder_meta(1))
    };
    Ok(b.finish(root, root_meta, false, FastPath::ExtdDirInfo))
}

const SPARSE_LINK_ROOT: &str = "/t7b/sparse-link";
/// 2^53 + 8,192 bytes: past every whole number a double holds exactly.
const PAST_EXACT: f64 = 9_007_199_254_749_184.0;

/// A sparse file with two names (link counts of two, in two folders) whose unallocated
/// bytes pass 2^53, so `sparseBytes` depends on the order of its terms and the store keeps
/// them; every other row is whole and small. A row that may share its file feeds the sum
/// once its size is final, at the seal (T7b), and here only those rows make it inexact.
/// A second sparse file, in `two`, is a second term: breadth-first it comes after the
/// first name's (in `one`), and a walk that lists `two` first numbers it before.
fn sparse_link_tree() -> Result<ScriptedTree, String> {
    let mut b = Builder::with_root();
    let one = b.dir("", b"one")?;
    let two = b.dir("", b"two")?;
    let ino = b.ino();
    b.put(&one, b"disk.img", file_meta(PAST_EXACT, BLOCK, ino, 2))?;
    b.put(&two, b"disk.img", file_meta(PAST_EXACT, BLOCK, ino, 2))?;
    let ino = b.ino();
    b.put(&two, b"sparse.bin", file_meta(100_000.0, BLOCK, ino, 1))?;
    b.file(&one, b"notes.txt", 10.0)?;
    b.file("", b"readme.txt", 5.0)?;
    Ok(b.finish(SPARSE_LINK_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// The scripted trees: tm-store's digest-lock trees and tm-walk's block-test shapes.
fn scripted_fixtures() -> Result<Vec<Fixture>, String> {
    let mut mixed = scripted(
        "scripted-mixed",
        MIXED_ROOT,
        mixed_tree()?,
        false,
        options("mixed", 0.0, true, 16),
    );
    mixed.never_descend = vec![mixed.root.join("never")];
    // Node names the root by its own rule (`rootName`), which may not be the walk's last
    // component: here longer, and with a non-ASCII byte and a dot, so Node decides its
    // extension (a text candidate) and every name after it moves in the pool.
    let mut renamed = scripted(
        "scripted-mixed-renamed-root",
        MIXED_ROOT,
        mixed_tree()?,
        false,
        options("Mixed \u{2013} the root.d", 0.0, true, 16),
    );
    renamed.never_descend = vec![renamed.root.join("never")];
    Ok(vec![
        renamed,
        posix_fixture()?,
        windows_fixture()?,
        scripted(
            "scripted-wide",
            WIDE_ROOT,
            wide_tree()?,
            false,
            options("wide", 0.0, true, 1_000),
        ),
        mixed,
        scripted(
            "scripted-complete",
            COMPLETE_ROOT,
            complete_tree(4, 5)?,
            true,
            options("complete", 0.0, true, 16),
        ),
        scripted(
            "scripted-two-big",
            BIG_ROOT,
            two_big_folders()?,
            false,
            options("big", 0.0, true, 16),
        ),
        chunks_fixture()?,
        scripted(
            "scripted-own-times",
            OWN_TIMES_ROOT,
            own_times_tree()?,
            true,
            options("own-times", 0.0, false, 0),
        ),
        scripted(
            "scripted-own-times-drop",
            OWN_TIMES_DROP_ROOT,
            own_times_drop_tree()?,
            true,
            options("own-times-drop", 0.0, false, 0),
        ),
        scripted(
            "scripted-refresh-gains",
            REFRESH_GAINS_ROOT,
            refresh_tree(REFRESH_GAINS_ROOT, true)?,
            true,
            options("refresh-gains", 0.0, false, 0),
        ),
        scripted(
            "scripted-refresh-loses",
            REFRESH_LOSES_ROOT,
            refresh_tree(REFRESH_LOSES_ROOT, false)?,
            true,
            options("refresh-loses", 0.0, false, 0),
        ),
        scripted(
            "scripted-sparse-link",
            SPARSE_LINK_ROOT,
            sparse_link_tree()?,
            false,
            options("sparse-link", 0.0, true, 16),
        ),
    ])
}

/// The synthetic trees' root, inside the app's synthetic temp folder (nothing creates it).
const SYNTHETIC_ROOT: &str = "tm-store-memory-sink";

fn synthetic(name: &'static str, spec: SyntheticSpec, want_atime: bool) -> Fixture {
    Fixture {
        name,
        root: synthetic_temp_folder().join(SYNTHETIC_ROOT),
        source: Source::Synthetic(spec),
        want_atime,
        never_descend: Vec::new(),
        build: options(SYNTHETIC_ROOT, 0.0, true, 4_096),
    }
}

/// The digest lock's synthetic shapes, at 30,000 entries.
fn synthetic_fixtures() -> Vec<Fixture> {
    let developer = |seed| SyntheticSpec::developer(30_000, seed);
    vec![
        synthetic("synthetic-developer-seed-1", developer(1), false),
        synthetic("synthetic-developer-seed-2", developer(2), true),
        synthetic(
            "synthetic-links-10pct",
            SyntheticSpec {
                link_ppm: 100_000,
                ..developer(1)
            },
            false,
        ),
        synthetic(
            "synthetic-folders-33pct",
            SyntheticSpec {
                folder_ppm: 330_000,
                ..developer(1)
            },
            true,
        ),
        synthetic(
            "synthetic-folders-1pct",
            SyntheticSpec {
                folder_ppm: 10_000,
                ..developer(1)
            },
            false,
        ),
    ]
}

// ---------------------------------------------------------------------------
// Walking into the sink and the collector at once
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

/// One walk's two stores.
struct Both {
    /// The sink's store.
    mem: Store,
    /// `build(take())` of the same walk.
    bfs: Store,
}

/// Block-numbered options for `fixture` at `workers` and `q_max`, with ceilings `sink`
/// can hold.
fn walk_options(fixture: &Fixture, workers: u32, q_max: usize, sink: &MemorySink) -> WalkOptions {
    let mut opts = WalkOptions::new(fixture.root.clone());
    opts.numbering = Numbering::Blocks;
    opts.max_workers = usize::try_from(workers).unwrap_or(1);
    opts.q_max = q_max;
    opts.want_atime = fixture.want_atime;
    opts.never_descend.clone_from(&fixture.never_descend);
    opts.id_ceiling = sink.id_ceiling();
    opts.name_ceiling = sink.name_ceiling();
    if let Source::Synthetic(spec) = &fixture.source {
        opts.synthetic = Some(spec.clone());
    }
    opts
}

fn lister_of(fixture: &Fixture, opts: &WalkOptions) -> Result<Arc<dyn Lister>, String> {
    match &fixture.source {
        Source::Scripted(tree) => Ok(Arc::clone(tree) as Arc<dyn Lister>),
        Source::Synthetic(_) => lister_for(opts).map_err(|e| e.to_string()),
    }
}

/// Walks `fixture` into a sink with room for `rows` rows and the walk's own collector.
fn walk_both_in(fixture: &Fixture, workers: u32, q_max: usize, rows: u32) -> Result<Both, String> {
    let sink =
        Arc::new(MemorySink::new(&fixture.build, rows, ROOM_NAMES).map_err(|e| e.to_string())?);
    let opts = walk_options(fixture, workers, q_max, &sink);
    let lister = lister_of(fixture, &opts)?;
    let handle = start_with_sinks(opts, Arc::new(OpenPacer), lister, vec![sink.clone()])
        .map_err(|e| e.to_string())?;
    let out = handle.take().map_err(|e| format!("the walk: {e}"))?;
    let mem = sink
        .take_store()
        .map_err(|e| format!("the sealed store: {e}"))?;
    let bfs = build(out, &fixture.build).map_err(|e| format!("build: {e}"))?;
    Ok(Both { mem, bfs })
}

fn walk_both(fixture: &Fixture, workers: u32, q_max: usize) -> Result<Both, String> {
    walk_both_in(fixture, workers, q_max, ROOM_ROWS)
}

// ---------------------------------------------------------------------------
// Reading a store
// ---------------------------------------------------------------------------

fn get<T: Copy>(column: &[T], id: usize, what: &str) -> Result<T, String> {
    column
        .get(id)
        .copied()
        .ok_or_else(|| format!("{what} has no row {id}"))
}

fn name_at(store: &Store, id: usize) -> Result<&[u8], String> {
    let off = store.name_off.as_slice();
    let (start, end) = (get(off, id, "nameOff")?, get(off, id + 1, "nameOff")?);
    store
        .names
        .as_slice()
        .get(start as usize..end as usize)
        .ok_or_else(|| format!("row {id}'s name is outside the names"))
}

/// Row `id`'s extension as text: "" for none, else the dictionary's or the overflow's.
fn ext_text(store: &Store, id: usize) -> Result<String, String> {
    match get(store.ext.as_slice(), id, "ext")? {
        EXT_NONE => Ok(String::new()),
        EXT_OVERFLOW => {
            let node = u32::try_from(id).map_err(|e| e.to_string())?;
            store
                .ext_overflow
                .binary_search_by_key(&node, |(n, _)| *n)
                .ok()
                .and_then(|at| store.ext_overflow.get(at))
                .map(|(_, text)| text.clone())
                .ok_or_else(|| format!("row {id} overflows the dictionary but is not listed"))
        }
        known => store
            .ext_dict
            .get(usize::from(known))
            .cloned()
            .ok_or_else(|| format!("row {id}'s extension {known} is past the dictionary")),
    }
}

fn children(store: &Store, id: usize) -> Result<std::ops::Range<usize>, String> {
    let first = get(store.child_start.as_slice(), id, "childStart")? as usize;
    let count = get(store.child_cnt.as_slice(), id, "childCnt")? as usize;
    Ok(first..first + count)
}

/// The id at `path` under the root, found by stored names.
fn store_id(store: &Store, path: &[&[u8]]) -> Result<usize, String> {
    let mut id = 0;
    for name in path {
        let stored = String::from_utf8_lossy(name).into_owned().into_bytes();
        id = children(store, id)?
            .find(|&child| name_at(store, child).is_ok_and(|n| n == stored.as_slice()))
            .ok_or_else(|| format!("{:?} is not in the store", String::from_utf8_lossy(name)))?;
    }
    Ok(id)
}

// ---------------------------------------------------------------------------
// φ, and the comparison through it
// ---------------------------------------------------------------------------

/// φ: the sink's id → build's id, by walking both stores breadth-first over their child
/// ranges from the root in step. Fails unless it is a bijection that pairs children in
/// order, and every row in a folder's range has that folder as its parent in the sink.
fn phi(mem: &Store, bfs: &Store) -> Result<Vec<u32>, String> {
    let n = mem.n as usize;
    if bfs.n != mem.n {
        return Err(format!("the sink has {} rows and build {}", mem.n, bfs.n));
    }
    if get(mem.parent.as_slice(), 0, "parent")? != -1 {
        return Err("the sink's root has a parent".to_owned());
    }
    let mut map = vec![u32::MAX; n];
    if let Some(root) = map.first_mut() {
        *root = 0;
    }
    let mut queue = VecDeque::from([0_usize]);
    let mut reached = 1_usize;
    while let Some(d) = queue.pop_front() {
        let e = get(&map, d, "φ")? as usize;
        let (mine, theirs) = (children(mem, d)?, children(bfs, e)?);
        if mine.len() != theirs.len() {
            return Err(format!(
                "row {d} (build's {e}) has {} children in the sink and {} in build",
                mine.len(),
                theirs.len()
            ));
        }
        let folder = i32::try_from(d).map_err(|e| e.to_string())?;
        for (x, y) in mine.zip(theirs) {
            let parent = get(mem.parent.as_slice(), x, "parent")?;
            if parent != folder {
                return Err(format!(
                    "row {x} is in row {d}'s child range but its parent is {parent}"
                ));
            }
            let slot = map
                .get_mut(x)
                .ok_or_else(|| format!("row {x} is past the sink's {n} rows"))?;
            if *slot != u32::MAX {
                return Err(format!("row {x} is in two child ranges"));
            }
            *slot = u32::try_from(y).map_err(|e| e.to_string())?;
            reached += 1;
            queue.push_back(x);
        }
    }
    if reached != n {
        return Err(format!(
            "{reached} of the sink's {n} rows are reached from the root"
        ));
    }
    Ok(map)
}

/// A list of ids, ascending, mapped through φ and sorted.
fn through_phi(list: &[u32], map: &[u32], what: &str) -> Result<Vec<u32>, String> {
    if !list.windows(2).all(|w| w.first() < w.get(1)) {
        return Err(format!("the sink's {what} are not ascending"));
    }
    let mut mapped = list
        .iter()
        .map(|&x| get(map, x as usize, what))
        .collect::<Result<Vec<u32>, String>>()?;
    mapped.sort_unstable();
    Ok(mapped)
}

/// The counters, every one.
fn compare_counters(mem: &Counters, bfs: &Counters, map: &[u32]) -> Result<(), String> {
    // Every field by name: a field added to `Counters` fails to compile here until it is
    // compared, or left out with the reason.
    let Counters {
        dirs,
        files,
        hardlinked_files,
        hardlinked_bytes,
        cloud_files,
        cloud_bytes,
        sparse_files,
        sparse_bytes,
        slack_bytes,
        denied_dirs,
        vanished_dirs,
        unreadable_dirs,
    } = mem;
    let counts = [
        ("dirs", *dirs, bfs.dirs),
        ("files", *files, bfs.files),
        ("hardlinkedFiles", *hardlinked_files, bfs.hardlinked_files),
        ("cloudFiles", *cloud_files, bfs.cloud_files),
        ("sparseFiles", *sparse_files, bfs.sparse_files),
        ("vanishedDirs", *vanished_dirs, bfs.vanished_dirs),
        ("unreadableDirs", *unreadable_dirs, bfs.unreadable_dirs),
    ];
    for (what, mine, theirs) in counts {
        if mine != theirs {
            return Err(format!("{what}: {mine} in the sink, {theirs} in build"));
        }
    }
    // Whole numbers below 2^53 in every tree here, so their sums are exact in any order
    // (Lemma 5): compared bit for bit.
    let sums = [
        ("hardlinkedBytes", *hardlinked_bytes, bfs.hardlinked_bytes),
        ("cloudBytes", *cloud_bytes, bfs.cloud_bytes),
        ("sparseBytes", *sparse_bytes, bfs.sparse_bytes),
        ("slackBytes", *slack_bytes, bfs.slack_bytes),
    ];
    for (what, mine, theirs) in sums {
        if mine.to_bits() != theirs.to_bits() {
            return Err(format!("{what}: {mine} in the sink, {theirs} in build"));
        }
    }
    if through_phi(denied_dirs, map, "deniedDirs")? != bfs.denied_dirs {
        return Err("deniedDirs differ through φ".to_owned());
    }
    Ok(())
}

/// The sink's store against build's, column for column through φ (see the module docs
/// for what is left out and why).
fn compare(both: &Both, fixture: &Fixture) -> TestResult {
    let (mem, bfs) = (&both.mem, &both.bfs);
    holds_i1_to_i4(mem, fixture.build.sort_children)?;
    if (mem.mode, mem.capacity) != (bfs.mode, bfs.capacity) {
        return Err(format!(
            "mode and capacity: {:?}/{} in the sink, {:?}/{} in build",
            mem.mode, mem.capacity, bfs.mode, bfs.capacity
        ));
    }
    let map = phi(mem, bfs)?;
    match (&mem.atime, &bfs.atime) {
        (Some(_), Some(_)) | (None, None) => {}
        (mine, theirs) => {
            return Err(format!(
                "the access-time column: {} in the sink, {} in build",
                if mine.is_some() { "present" } else { "absent" },
                if theirs.is_some() {
                    "present"
                } else {
                    "absent"
                }
            ));
        }
    }
    for (x, &y) in map.iter().enumerate() {
        let y = y as usize;
        let at = |what: &str| format!("row {x} (build's {y}): {what}");
        if name_at(mem, x)? != name_at(bfs, y)? {
            return Err(at("the name"));
        }
        let bytes = |store: &Store, id: usize| get(store.flags.as_slice(), id, "flags");
        if bytes(mem, x)? != bytes(bfs, y)? {
            return Err(at(&format!(
                "flags {:#x} in the sink, {:#x} in build",
                bytes(mem, x)?,
                bytes(bfs, y)?
            )));
        }
        if get(mem.container.as_slice(), x, "container")?
            != get(bfs.container.as_slice(), y, "container")?
        {
            return Err(at("the container kind"));
        }
        if get(mem.cloud_prov.as_slice(), x, "cloudProv")?
            != get(bfs.cloud_prov.as_slice(), y, "cloudProv")?
        {
            return Err(at("the cloud provider"));
        }
        if ext_text(mem, x)? != ext_text(bfs, y)? {
            return Err(at(&format!(
                "the extension {:?} in the sink, {:?} in build",
                ext_text(mem, x)?,
                ext_text(bfs, y)?
            )));
        }
        let size = |store: &Store, id: usize| get(store.size.as_slice(), id, "size");
        if size(mem, x)?.to_bits() != size(bfs, y)?.to_bits() {
            return Err(at(&format!(
                "size {} in the sink, {} in build",
                size(mem, x)?,
                size(bfs, y)?
            )));
        }
        let mtime = |store: &Store, id: usize| get(store.mtime.as_slice(), id, "mtime");
        if mtime(mem, x)?.to_bits() != mtime(bfs, y)?.to_bits() {
            return Err(at(&format!(
                "mtime {} in the sink, {} in build",
                mtime(mem, x)?,
                mtime(bfs, y)?
            )));
        }
        if let (Some(mine), Some(theirs)) = (&mem.atime, &bfs.atime) {
            let (a, b) = (
                get(mine.as_slice(), x, "atime")?,
                get(theirs.as_slice(), y, "atime")?,
            );
            if a.to_bits() != b.to_bits() {
                return Err(at(&format!("atime {a} in the sink, {b} in build")));
            }
        }
    }
    // In breadth-first order: through φ, `build`'s own lists in the same order.
    let cloud = mem
        .cloud_candidates
        .iter()
        .map(|&x| get(&map, x as usize, "cloud candidates"))
        .collect::<Result<Vec<u32>, String>>()?;
    if cloud != bfs.cloud_candidates {
        return Err(format!(
            "the cloud candidates through φ, {cloud:?}, are not build's, {:?}",
            bfs.cloud_candidates
        ));
    }
    let terms = mem
        .sparse_terms
        .iter()
        .map(|&(x, bytes)| get(&map, x as usize, "sparse terms").map(|y| (y, bytes.to_bits())))
        .collect::<Result<Vec<(u32, u64)>, String>>()?;
    let build_terms: Vec<(u32, u64)> = bfs
        .sparse_terms
        .iter()
        .map(|&(y, bytes)| (y, bytes.to_bits()))
        .collect();
    if terms != build_terms {
        return Err(format!(
            "the sparse terms through φ, {terms:?}, are not build's, {build_terms:?}"
        ));
    }
    if through_phi(&mem.text_candidates, &map, "text candidates")? != bfs.text_candidates {
        return Err("the text candidates differ through φ".to_owned());
    }
    compare_counters(&mem.counters, &bfs.counters, &map)?;
    if bfs.ext_overflow.is_empty() {
        let mut mine = mem.ext_dict.clone();
        let mut theirs = bfs.ext_dict.clone();
        mine.sort_unstable();
        theirs.sort_unstable();
        if mine != theirs {
            return Err("the extension dictionaries hold different texts".to_owned());
        }
    }
    Ok(())
}

/// I1–I4 on the store itself (design §S.2, test 8): the walk's checker, over the store's
/// parents with the root's −1 read as the walk's 0.
fn holds_i1_to_i4(store: &Store, sorted: bool) -> TestResult {
    let parent: Vec<u32> = store
        .parent
        .as_slice()
        .iter()
        .map(|&p| u32::try_from(p).unwrap_or(0))
        .collect();
    check_walk_columns(
        &parent,
        store.name_off.as_slice(),
        store.names.as_slice(),
        sorted,
    )
    .map_err(|broken| format!("the sink's store: {broken}"))
}

/// Walks every fixture at every worker count and queue threshold given, comparing each.
fn phi_equal_on(fixtures: &[Fixture], q_maxes: &[usize], rows: u32) -> TestResult {
    let mut problems = Vec::new();
    for fixture in fixtures {
        for workers in WORKERS {
            for &q_max in q_maxes {
                let at = format!("{} at {workers} worker(s), q_max {q_max}", fixture.name);
                match walk_both_in(fixture, workers, q_max, rows).and_then(|b| compare(&b, fixture))
                {
                    Ok(()) => {}
                    Err(why) => problems.push(format!("{at}: {why}")),
                }
            }
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("\n"))
    }
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

#[test]
fn the_sinks_store_equals_builds_through_phi_on_the_scripted_trees() -> TestResult {
    phi_equal_on(&scripted_fixtures()?, &Q_MAXES, ROOM_ROWS)
}

#[test]
fn the_sinks_store_equals_builds_through_phi_on_synthetic_trees() -> TestResult {
    phi_equal_on(&synthetic_fixtures(), &Q_MAXES, ROOM_ROWS)
}

#[test]
fn the_sinks_store_equals_builds_through_phi_on_a_million_entries() -> TestResult {
    let million = synthetic(
        "synthetic-developer-1m",
        SyntheticSpec::developer(1_000_000, 7),
        true,
    );
    phi_equal_on(&[million], &[DEFAULT_Q_MAX], 1_100_000)
}

#[test]
fn names_that_are_not_utf8_are_ordered_as_the_store_orders_them() -> TestResult {
    let fixture = posix_fixture()?;
    for workers in [1, 8] {
        let store = walk_both(&fixture, workers, DEFAULT_Q_MAX)?.mem;
        let root: Vec<&[u8]> = children(&store, 0)?
            .map(|id| name_at(&store, id))
            .collect::<Result<_, _>>()?;
        let stored = String::from_utf8_lossy(INVALID).into_owned().into_bytes();
        let at = |name: &[u8]| root.iter().position(|&n| n == name);
        let (Some(invalid), Some(emoji)) = (at(&stored), at(EMOJI)) else {
            return Err(format!("the root holds {root:?}"));
        };
        assert!(
            invalid < emoji,
            "{workers} worker(s): a\u{FFFD} is before a😀"
        );
        let sizes = |ids: std::ops::Range<usize>| -> Result<Vec<f64>, String> {
            ids.map(|id| get(store.size.as_slice(), id, "size"))
                .collect()
        };
        let pair = store_id(&store, &[b"pair"])?;
        assert_eq!(
            sizes(children(&store, pair)?)?,
            [5.0, 6.0],
            "{workers} worker(s): c\u{FFFD} (5 bytes) is before c😀 (6 bytes)"
        );
        let alike = "x\u{FFFD}.txt".as_bytes();
        let alike_sizes: Vec<f64> = children(&store, 0)?
            .filter(|&id| name_at(&store, id).is_ok_and(|n| n == alike))
            .map(|id| get(store.size.as_slice(), id, "size"))
            .collect::<Result<_, _>>()?;
        assert_eq!(
            alike_sizes,
            [1.0, 2.0],
            "{workers} worker(s): two names stored alike keep the listing's order"
        );
    }
    Ok(())
}

#[test]
fn a_big_listing_lands_whole_and_in_order() -> TestResult {
    let fixture = chunks_fixture()?;
    for workers in [1, 2, 8] {
        let store = walk_both(&fixture, workers, DEFAULT_Q_MAX)?.mem;
        let wide = store_id(&store, &[b"wide"])?;
        let rows = children(&store, wide)?;
        assert_eq!(rows.len(), CHUNK_FILES as usize, "{workers} worker(s)");
        for (f, id) in (0..CHUNK_FILES).zip(rows) {
            if name_at(&store, id)? != chunk_name(f).as_bytes()
                || get(store.size.as_slice(), id, "size")?.to_bits() != f64::from(f).to_bits()
                || get(store.parent.as_slice(), id, "parent")?
                    != i32::try_from(wide).map_err(|e| e.to_string())?
            {
                return Err(format!("{workers} worker(s): file {f} is not row {id}"));
            }
        }
    }
    Ok(())
}

#[test]
fn a_folder_that_holds_a_git_folder_is_a_repository() -> TestResult {
    let fixture = posix_fixture()?;
    for workers in [1, 8] {
        let store = walk_both(&fixture, workers, DEFAULT_Q_MAX)?.mem;
        let repo = |path: &[&[u8]]| -> Result<bool, String> {
            let id = store_id(&store, path)?;
            Ok(get(store.flags.as_slice(), id, "flags")? & flag::GIT_REPO != 0)
        };
        let root = get(store.flags.as_slice(), 0, "flags")? & flag::GIT_REPO != 0;
        assert!(root, "{workers} worker(s): the root holds .git");
        assert!(repo(&[b"proj"])?, "{workers} worker(s): proj holds .git");
        assert!(
            !repo(&[b".git"])?,
            "{workers} worker(s): the .git folder itself is none"
        );
        assert!(
            !repo(&[b"proj", b".git"])?,
            "{workers} worker(s): nor proj's"
        );
        assert!(
            !repo(&[b"wt"])?,
            "{workers} worker(s): a .git file makes none"
        );
        assert!(
            !repo(&[b"upper"])?,
            "{workers} worker(s): nor a .GIT folder or a .git link"
        );
    }
    Ok(())
}

#[test]
fn windows_own_times_land_on_the_folders_own_row() -> TestResult {
    let fixture = windows_fixture()?;
    // Each folder's listing read its own times; the store keeps them rounded as Node
    // rounds, in place of the copy its parent's listing gave (times near 1.6e12 ms).
    let own: [(&[&[u8]], f64, f64); 5] = [
        (&[b"Beta"], 2_001.0, 2_101.0),
        (&[b"beta2"], 3_000.0, 3_101.0),
        (&[b"Zeta"], 4_001.0, 4_101.0),
        (&[b"Zeta", b"sub"], 5_001.0, 5_100.0),
        (&[b".vs"], 6_001.0, 6_101.0),
    ];
    for workers in [1, 8] {
        let store = walk_both(&fixture, workers, DEFAULT_Q_MAX)?.mem;
        let atime = store.atime.as_ref().ok_or("no access-time column")?;
        for (path, mtime, accessed) in own {
            let id = store_id(&store, path)?;
            let at = format!(
                "{workers} worker(s), {:?}",
                String::from_utf8_lossy(&path.concat())
            );
            assert_eq!(
                get(store.mtime.as_slice(), id, "mtime")?.to_bits(),
                f64::to_bits(mtime),
                "{at}"
            );
            assert_eq!(
                get(atime.as_slice(), id, "atime")?.to_bits(),
                f64::to_bits(accessed),
                "{at}"
            );
            assert!(
                get(store.flags.as_slice(), id, "flags")? & flag::HAS_ACCESSED != 0,
                "{at}"
            );
        }
        // The root's own listing reads its times too, but the root's row keeps the
        // walk's stat of the root, as build keeps it.
        assert_eq!(
            get(store.mtime.as_slice(), 0, "mtime")?.to_bits(),
            f64::to_bits(1_600_000_000_001.0),
            "{workers} worker(s): the root's own times are not applied"
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Lists gathered out of id order
// ---------------------------------------------------------------------------

const REVERSED_ROOT: &str = "/t7a/reversed";
/// Files in the reversed tree's root, each with an extension of its own: more than the
/// extension dictionary holds, so every new extension after them overflows it.
const DICTIONARY_FILLERS: u32 = 65_540;

/// A root that fills the extension dictionary, and two folders, `a` and `b`, each holding
/// a row for every list the sink gathers: a cloud candidate, a text candidate, a new
/// extension (past the full dictionary), a sparse file (the two of them past 2^53, so the
/// terms are kept per file) and a folder the walk is refused.
fn reversed_tree() -> Result<ScriptedTree, String> {
    let mut b = Builder::with_root();
    for i in 0..DICTIONARY_FILLERS {
        b.file("", format!("f{i:05}.e{i}").as_bytes(), 1.0)?;
    }
    for side in ["a", "b"] {
        let folder = b.dir("", side.as_bytes())?;
        let ino = b.ino();
        b.put(
            &folder,
            format!("guess-{side}.bin").as_bytes(),
            file_meta(10.0, 0.0, ino, 1),
        )?;
        b.file(&folder, format!("é-{side}.txt").as_bytes(), 1.0)?;
        b.file(&folder, format!("z.ov{side}").as_bytes(), 1.0)?;
        let ino = b.ino();
        b.put(
            &folder,
            format!("huge-{side}.img").as_bytes(),
            file_meta(6_000_000_000_000_000.0, 4_096.0, ino, 1),
        )?;
        b.refused(&folder, b"denied", Refusal::Denied)?;
    }
    Ok(b.finish(REVERSED_ROOT, folder_meta(1), true, FastPath::Bulk))
}

/// What the reversing sink and lister share.
#[derive(Default)]
struct Reversal {
    /// `(side, first)` of each of `a`'s and `b`'s blocks as they arrive.
    arrived: Mutex<Vec<(char, u32)>>,
    /// The side whose block reserved the larger ids: it reaches the sink first.
    larger: Mutex<Option<char>>,
    /// `a`'s and `b`'s blocks handed to the sink so far.
    committed: AtomicU64,
    /// `denied` listings that reached the lister so far.
    denials_arrived: AtomicU64,
    /// Refusals the sink has heard.
    refused: AtomicU64,
}

/// Which of `a` and `b` a block is, by its cloud candidate's name.
fn side_of(block: &Block<'_>) -> Option<char> {
    ['a', 'b'].into_iter().find(|side| {
        let marker = format!("guess-{side}.bin");
        block
            .rows
            .iter()
            .any(|row| block.name(row) == marker.as_bytes())
    })
}

/// A sink that holds `a`'s and `b`'s blocks until both have come, then hands the one
/// with the larger ids to the `MemorySink` first.
struct Reversing {
    inner: Arc<MemorySink>,
    shared: Arc<Reversal>,
}

impl ListingSink for Reversing {
    fn root(&self, name: &[u8], meta: &Meta) {
        self.inner.root(name, meta);
    }

    fn commit(&self, block: &Block<'_>) {
        let Some(side) = side_of(block) else {
            self.inner.commit(block);
            return;
        };
        lock(&self.shared.arrived).push((side, block.first));
        let _ = wait_until(|| lock(&self.shared.arrived).len() == 2);
        let larger = lock(&self.shared.arrived)
            .iter()
            .max_by_key(|&&(_, first)| first)
            .map(|&(side, _)| side);
        *lock(&self.shared.larger) = larger;
        if larger != Some(side) {
            let _ = wait_until(|| self.shared.committed.load(Ordering::SeqCst) == 1);
        }
        self.inner.commit(block);
        self.shared.committed.fetch_add(1, Ordering::SeqCst);
    }

    fn refused(&self, folder: u32, why: Refusal) {
        self.inner.refused(folder, why);
        self.shared.refused.fetch_add(1, Ordering::SeqCst);
    }

    fn abort(&self) {
        self.inner.abort();
    }

    fn writes_in_place(&self) -> bool {
        true
    }

    fn finish(&self, ending: &Finishing<'_>) -> Result<(), String> {
        self.inner.finish(ending)
    }
}

/// The reversed tree, holding the listings of `a/denied` and `b/denied` until both have
/// come, then refusing the one under the side with the larger ids first. The refusals
/// are heard under the commit lock, so they are held here, where no lock is held.
struct ReversingLister {
    tree: Arc<ScriptedTree>,
    shared: Arc<Reversal>,
}

impl Lister for ReversingLister {
    fn stat_dir(&self, path: &Path, want_atime: bool) -> Result<Meta, Refusal> {
        self.tree.stat_dir(path, want_atime)
    }

    fn list(
        &self,
        dir: &Path,
        want_atime: bool,
        buf: &mut ListBuffer,
    ) -> Result<FastPath, Refusal> {
        let root = Path::new(REVERSED_ROOT);
        let side = ['a', 'b']
            .into_iter()
            .find(|side| dir == root.join(side.to_string()).join("denied"));
        if let Some(side) = side {
            self.shared.denials_arrived.fetch_add(1, Ordering::SeqCst);
            let _ = wait_until(|| self.shared.denials_arrived.load(Ordering::SeqCst) == 2);
            if *lock(&self.shared.larger) != Some(side) {
                let _ = wait_until(|| self.shared.refused.load(Ordering::SeqCst) == 1);
            }
        }
        self.tree.list(dir, want_atime, buf)
    }
}

#[test]
fn lists_gathered_out_of_id_order_come_out_ascending() -> TestResult {
    let build_opts = options("reversed", 0.0, true, 16);
    let tree = Arc::new(reversed_tree()?);
    let fixture = Fixture {
        name: "scripted-reversed",
        root: PathBuf::from(REVERSED_ROOT),
        source: Source::Scripted(Arc::clone(&tree)),
        want_atime: false,
        never_descend: Vec::new(),
        build: build_opts.clone(),
    };
    let sink =
        Arc::new(MemorySink::new(&build_opts, ROOM_ROWS, ROOM_NAMES).map_err(|e| e.to_string())?);
    let shared = Arc::new(Reversal::default());
    let reversing = Arc::new(Reversing {
        inner: Arc::clone(&sink),
        shared: Arc::clone(&shared),
    });
    // The tree the fixture names, listed through the lister that reverses the refusals.
    let lister = Arc::new(ReversingLister {
        tree,
        shared: Arc::clone(&shared),
    });
    let opts = walk_options(&fixture, 2, DEFAULT_Q_MAX, &sink);
    let handle = start_with_sinks(opts, Arc::new(OpenPacer), lister, vec![reversing])
        .map_err(|e| e.to_string())?;
    let out = take_within(handle)?.map_err(|e| e.to_string())?;
    assert_eq!(
        shared.committed.load(Ordering::SeqCst),
        2,
        "a's and b's blocks both reached the sink"
    );
    let mem = sink.take_store().map_err(|e| e.to_string())?;
    let bfs = build(out, &build_opts).map_err(|e| e.to_string())?;
    let ascending = |ids: &[u32]| ids.windows(2).all(|w| w.first() < w.get(1));
    let overflow: Vec<u32> = mem.ext_overflow.iter().map(|&(id, _)| id).collect();
    let terms: Vec<u32> = mem.sparse_terms.iter().map(|&(id, _)| id).collect();
    for (what, ids, count) in [
        ("text candidates", &mem.text_candidates, 2),
        ("denied folders", &mem.counters.denied_dirs, 2),
        ("overflowed extensions", &overflow, 12),
    ] {
        assert_eq!(ids.len(), count, "{what}: {ids:?}");
        assert!(ascending(ids), "{what} are not ascending: {ids:?}");
    }
    // The cloud candidates and the sparse terms come in breadth-first order (T7b), which
    // `compare` holds to `build`'s own lists through φ.
    assert_eq!(
        mem.cloud_candidates.len(),
        2,
        "cloud candidates: {:?}",
        mem.cloud_candidates
    );
    assert_eq!(terms.len(), 2, "sparse terms: {terms:?}");
    compare(&Both { mem, bfs }, &fixture)
}

// ---------------------------------------------------------------------------
// The seal on the walk's driver thread (T8a)
// ---------------------------------------------------------------------------

/// A scripted tree whose file reads — a hard-link family's re-read: the walk itself
/// stats only the root — are held one by one: read `k` waits until `k` reads are let go.
struct HeldReads {
    tree: Arc<ScriptedTree>,
    root: PathBuf,
    reads: AtomicU64,
    let_go: AtomicU64,
}

impl HeldReads {
    fn new(tree: ScriptedTree, root: &str) -> Self {
        Self {
            tree: Arc::new(tree),
            root: PathBuf::from(root),
            reads: AtomicU64::new(0),
            let_go: AtomicU64::new(0),
        }
    }
}

impl Lister for HeldReads {
    fn stat_dir(&self, path: &Path, want_atime: bool) -> Result<Meta, Refusal> {
        if path != self.root {
            let read = self.reads.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = wait_until(|| self.let_go.load(Ordering::SeqCst) >= read);
        }
        self.tree.stat_dir(path, want_atime)
    }

    fn list(
        &self,
        dir: &Path,
        want_atime: bool,
        buf: &mut ListBuffer,
    ) -> Result<FastPath, Refusal> {
        self.tree.list(dir, want_atime, buf)
    }
}

/// The Windows tree walked into a sink alone (`collect` off, so only the seal re-reads
/// its families) through `lister`.
fn start_windows_alone(lister: Arc<HeldReads>) -> Result<(WalkHandle, Arc<MemorySink>), String> {
    let fixture = windows_fixture()?;
    let sink = Arc::new(
        MemorySink::new(&fixture.build, ROOM_ROWS, ROOM_NAMES).map_err(|e| e.to_string())?,
    );
    let mut opts = walk_options(&fixture, 2, DEFAULT_Q_MAX, &sink);
    opts.collect = false;
    let handle = start_with_sinks(opts, Arc::new(OpenPacer), lister, vec![sink.clone()])
        .map_err(|e| e.to_string())?;
    Ok((handle, sink))
}

#[test]
fn a_cancel_while_the_seal_reads_families_ends_the_walk_between_two_reads() -> TestResult {
    let lister = Arc::new(HeldReads::new(windows_tree()?, WINDOWS_ROOT));
    let (handle, sink) = start_windows_alone(Arc::clone(&lister))?;
    if !wait_until(|| lister.reads.load(Ordering::SeqCst) == 1) {
        return Err("the seal never read a family".to_owned());
    }
    handle.cancel();
    lister.let_go.store(u64::MAX, Ordering::SeqCst);
    let taken = take_within(handle)?;
    assert!(
        matches!(taken, Err(WalkError::Cancelled)),
        "cancelled: {:?}",
        taken.map(|out| out.len())
    );
    assert_eq!(
        lister.reads.load(Ordering::SeqCst),
        1,
        "the seal stopped before its next read"
    );
    assert!(
        matches!(sink.take_store(), Err(StoreError::Sink(_))),
        "a cancelled walk's sink has no store"
    );
    Ok(())
}

#[test]
fn every_family_the_seal_reads_moves_the_heartbeat() -> TestResult {
    let lister = Arc::new(HeldReads::new(windows_tree()?, WINDOWS_ROOT));
    let (handle, sink) = start_windows_alone(Arc::clone(&lister))?;
    if !wait_until(|| lister.reads.load(Ordering::SeqCst) == 1) {
        return Err("the seal never read a family".to_owned());
    }
    // Every worker has stopped, so only the seal moves the heartbeat now.
    let first = handle.progress().heartbeat;
    lister.let_go.store(1, Ordering::SeqCst);
    if !wait_until(|| lister.reads.load(Ordering::SeqCst) == 2) {
        return Err("the seal never read a second family".to_owned());
    }
    let second = handle.progress().heartbeat;
    assert!(
        second > first,
        "the heartbeat stood still: {first} then {second}"
    );
    lister.let_go.store(u64::MAX, Ordering::SeqCst);
    take_within(handle)?.map_err(|e| e.to_string())?;
    sink.take_store().map_err(|e| e.to_string())?;
    Ok(())
}

#[test]
fn the_sinks_store_needs_no_collector() -> TestResult {
    let fixtures = [windows_fixture()?, posix_fixture()?];
    for fixture in &fixtures {
        let sink = Arc::new(
            MemorySink::new(&fixture.build, ROOM_ROWS, ROOM_NAMES).map_err(|e| e.to_string())?,
        );
        let mut opts = walk_options(fixture, 2, DEFAULT_Q_MAX, &sink);
        opts.collect = false;
        let lister = lister_of(fixture, &opts)?;
        let handle = start_with_sinks(opts, Arc::new(OpenPacer), lister, vec![sink.clone()])
            .map_err(|e| e.to_string())?;
        let out = take_within(handle)?.map_err(|e| e.to_string())?;
        assert!(out.is_empty(), "{}: the walk kept no columns", fixture.name);
        let mem = sink.take_store().map_err(|e| e.to_string())?;
        // The oracle: `build(take())` of a walk that collects.
        let bfs = walk_both(fixture, 2, DEFAULT_Q_MAX)?.bfs;
        compare(&Both { mem, bfs }, fixture).map_err(|e| format!("{}: {e}", fixture.name))?;
    }
    Ok(())
}

/// A sink whose finish fails, after the memory sink has sealed.
struct FailsToFinish;

/// Its reason.
const FAILS_TO_FINISH: &str = "a later sink could not finish";

impl ListingSink for FailsToFinish {
    fn root(&self, _name: &[u8], _meta: &Meta) {}
    fn commit(&self, _block: &Block<'_>) {}
    fn refused(&self, _folder: u32, _why: Refusal) {}
    fn abort(&self) {}
    fn finish(&self, _ending: &Finishing<'_>) -> Result<(), String> {
        Err(FAILS_TO_FINISH.to_owned())
    }
}

#[test]
fn a_sealed_store_is_released_when_a_later_sink_fails_to_finish() -> TestResult {
    let fixture = posix_fixture()?;
    let before = anon_tally();
    let sink = Arc::new(
        MemorySink::new(&fixture.build, ROOM_ROWS, ROOM_NAMES).map_err(|e| e.to_string())?,
    );
    let made = since(before, anon_tally());
    let watch = Arc::new(AbortWatch::new(Arc::clone(&sink)));
    let opts = walk_options(&fixture, 2, DEFAULT_Q_MAX, &sink);
    let lister = lister_of(&fixture, &opts)?;
    let handle = start_with_sinks(
        opts,
        Arc::new(OpenPacer),
        lister,
        vec![watch.clone(), Arc::new(FailsToFinish)],
    )
    .map_err(|e| e.to_string())?;
    match take_within(handle)? {
        Err(WalkError::Internal(why)) if why == FAILS_TO_FINISH => {}
        other => {
            return Err(format!(
                "the later sink's reason: {:?}",
                other.map(|o| o.len())
            ));
        }
    }
    assert_eq!(watch.aborts.load(Ordering::SeqCst), 1, "aborted once");
    // Every column the sink made went into the sealed store (the walk reads access
    // times, so none was dropped at the seal), and the abort releases them all.
    let released = (*lock(&watch.released)).ok_or("no abort measured")?;
    assert_eq!(
        (released.unmaps, released.bytes_unmapped),
        (made.maps, made.bytes_mapped),
        "the sealed store's mappings are released by the abort"
    );
    assert!(
        matches!(sink.take_store(), Err(StoreError::Sink(_))),
        "an aborted sink has no store"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Ends without an output, and ceilings
// ---------------------------------------------------------------------------

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

/// What changed in a thread's tally between two readings.
fn since(before: AnonTally, after: AnonTally) -> AnonTally {
    AnonTally {
        maps: after.maps - before.maps,
        unmaps: after.unmaps - before.unmaps,
        bytes_mapped: after.bytes_mapped - before.bytes_mapped,
        bytes_unmapped: after.bytes_unmapped - before.bytes_unmapped,
    }
}

/// A sink that hands every call to a `MemorySink` and measures, on the thread that
/// aborts it, what the abort released.
struct AbortWatch {
    inner: Arc<MemorySink>,
    aborts: AtomicU64,
    released: Mutex<Option<AnonTally>>,
}

impl AbortWatch {
    fn new(inner: Arc<MemorySink>) -> Self {
        Self {
            inner,
            aborts: AtomicU64::new(0),
            released: Mutex::new(None),
        }
    }
}

impl ListingSink for AbortWatch {
    fn root(&self, name: &[u8], meta: &Meta) {
        self.inner.root(name, meta);
    }

    fn commit(&self, block: &Block<'_>) {
        self.inner.commit(block);
    }

    fn refused(&self, folder: u32, why: Refusal) {
        self.inner.refused(folder, why);
    }

    fn abort(&self) {
        let before = anon_tally();
        self.inner.abort();
        *lock(&self.released) = Some(since(before, anon_tally()));
        self.aborts.fetch_add(1, Ordering::SeqCst);
    }

    fn writes_in_place(&self) -> bool {
        self.inner.writes_in_place()
    }

    fn finish(&self, ending: &Finishing<'_>) -> Result<(), String> {
        self.inner.finish(ending)
    }
}

/// How a scripted walk is made to end without an output.
enum Ending {
    /// Cancelled while a folder is being listed.
    Cancel(&'static str),
    /// A folder's listing panics.
    Panic(&'static str),
    /// The root cannot be read when the walk starts.
    RootRefusedAtStart,
    /// The root's own listing is refused.
    RootListingRefused,
}

/// The mixed tree, answering as `ending` says.
struct EndingLister {
    tree: Arc<ScriptedTree>,
    ending: Ending,
    reached: AtomicBool,
    release: AtomicBool,
}

impl Lister for EndingLister {
    fn stat_dir(&self, path: &Path, want_atime: bool) -> Result<Meta, Refusal> {
        if matches!(self.ending, Ending::RootRefusedAtStart) {
            return Err(Refusal::Denied);
        }
        self.tree.stat_dir(path, want_atime)
    }

    #[expect(clippy::panic, reason = "the scripted listing panics on purpose")]
    fn list(
        &self,
        dir: &Path,
        want_atime: bool,
        buf: &mut ListBuffer,
    ) -> Result<FastPath, Refusal> {
        let root = Path::new(MIXED_ROOT);
        match self.ending {
            Ending::RootListingRefused if dir == root => return Err(Refusal::Unreadable),
            Ending::Panic(name) if dir == root.join(name) => {
                panic_any(format!("fixture panic listing {name}"));
            }
            Ending::Cancel(name) if dir == root.join(name) => {
                self.reached.store(true, Ordering::SeqCst);
                let _ = wait_until(|| self.release.load(Ordering::SeqCst));
            }
            _ => {}
        }
        self.tree.list(dir, want_atime, buf)
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

#[test]
fn every_mapping_is_released_when_the_walk_ends_without_an_output() -> TestResult {
    let endings = [
        ("a cancel", Ending::Cancel("d05")),
        ("a listing's panic", Ending::Panic("d07")),
        ("the root refused at the start", Ending::RootRefusedAtStart),
        ("the root's listing refused", Ending::RootListingRefused),
    ];
    for (what, ending) in endings {
        let build_opts = options("mixed", 0.0, true, 16);
        let before = anon_tally();
        let sink =
            Arc::new(MemorySink::new(&build_opts, 10_000, 1 << 20).map_err(|e| e.to_string())?);
        let made = since(before, anon_tally());
        assert!(made.maps > 0, "{what}: the sink maps its columns: {made:?}");
        let watch = Arc::new(AbortWatch::new(Arc::clone(&sink)));
        let cancel = matches!(ending, Ending::Cancel(_));
        let lister = Arc::new(EndingLister {
            tree: Arc::new(mixed_tree()?),
            ending,
            reached: AtomicBool::new(false),
            release: AtomicBool::new(false),
        });
        let mut opts = WalkOptions::new(MIXED_ROOT);
        opts.numbering = Numbering::Blocks;
        opts.max_workers = 2;
        opts.id_ceiling = sink.id_ceiling();
        opts.name_ceiling = sink.name_ceiling();
        let started = start_with_sinks(
            opts,
            Arc::new(OpenPacer),
            lister.clone(),
            vec![watch.clone()],
        );
        let outcome = match started {
            Err(e) => Err(e),
            Ok(handle) => {
                if cancel {
                    if !wait_until(|| lister.reached.load(Ordering::SeqCst)) {
                        return Err(format!("{what}: the gated listing never started"));
                    }
                    handle.cancel();
                    lister.release.store(true, Ordering::SeqCst);
                }
                take_within(handle)?.map(drop)
            }
        };
        assert!(outcome.is_err(), "{what}: the walk ended with an output");
        assert_eq!(
            watch.aborts.load(Ordering::SeqCst),
            1,
            "{what}: aborted once"
        );
        let released = (*lock(&watch.released)).ok_or("no abort measured")?;
        assert_eq!(
            (released.unmaps, released.bytes_unmapped),
            (made.maps, made.bytes_mapped),
            "{what}: every mapping the sink made is released by the abort"
        );
        assert!(
            matches!(sink.take_store(), Err(StoreError::Sink(_))),
            "{what}: an aborted sink has no store"
        );
    }
    Ok(())
}

/// Walks the mixed tree into `sink`, its ceilings set when `limited`.
fn walk_mixed_into(
    sink: &Arc<MemorySink>,
    limited: bool,
) -> Result<Result<WalkOutput, WalkError>, String> {
    let mut opts = WalkOptions::new(MIXED_ROOT);
    opts.numbering = Numbering::Blocks;
    opts.max_workers = 2;
    opts.never_descend = vec![PathBuf::from(MIXED_ROOT).join("never")];
    if limited {
        opts.id_ceiling = sink.id_ceiling();
        opts.name_ceiling = sink.name_ceiling();
    }
    let handle = start_with_sinks(
        opts,
        Arc::new(OpenPacer),
        Arc::new(mixed_tree()?),
        vec![Arc::clone(sink) as Arc<dyn ListingSink>],
    )
    .map_err(|e| e.to_string())?;
    take_within(handle)
}

#[test]
fn a_sink_with_less_room_faults_the_walk_at_its_ceilings() -> TestResult {
    let build_opts = options("mixed", 0.0, true, 16);
    // Room for 40 rows beside the headroom: ids 0..40, so the walk faults at its 40th entry.
    let rows = MemorySink::new(&build_opts, 40 + 16, 1 << 20).map_err(|e| e.to_string())?;
    assert_eq!(rows.id_ceiling(), 40);
    match walk_mixed_into(&Arc::new(rows), true)? {
        Err(WalkError::Internal(text)) if text == "the walk exceeded 39 entries" => {}
        other => return Err(format!("the row ceiling: {:?}", other.map(|o| o.len()))),
    }
    // Room for 100 bytes of names beside the root's and the headroom's.
    let names = u64::try_from("mixed".len()).map_err(|e| e.to_string())? + 16 * 64 + 100;
    let names = MemorySink::new(&build_opts, 10_000, names).map_err(|e| e.to_string())?;
    assert_eq!(names.name_ceiling(), 100);
    match walk_mixed_into(&Arc::new(names), true)? {
        Err(WalkError::Internal(text)) if text == "the walk's names exceeded 100 bytes" => {}
        other => return Err(format!("the name ceiling: {:?}", other.map(|o| o.len()))),
    }
    Ok(())
}

#[test]
fn a_sink_the_walk_outgrows_writes_nothing_past_its_room() -> TestResult {
    let build_opts = options("mixed", 0.0, true, 16);
    let roomy =
        Arc::new(MemorySink::new(&build_opts, ROOM_ROWS, ROOM_NAMES).map_err(|e| e.to_string())?);
    let whole = walk_mixed_into(&roomy, false)?.map_err(|e| e.to_string())?;
    assert!(whole.len() > 100, "the tree outgrows the small sinks below");
    for (what, rows, names) in [
        ("rows", 40 + 16, 1 << 20),
        ("names", 10_000, 5 + 16 * 64 + 100),
    ] {
        let sink = Arc::new(MemorySink::new(&build_opts, rows, names).map_err(|e| e.to_string())?);
        // The walk is not told the sink's ceilings: it lists everything, and the sink
        // refuses what it has no room for rather than write past its mappings, so the walk
        // ends at the sink's finish with the sink's reason.
        match walk_mixed_into(&sink, false)? {
            Err(WalkError::Internal(why)) if why.contains("not in the column's room") => {}
            other => return Err(format!("{what}: {:?}", other.map(|o| o.len()))),
        }
        assert!(
            matches!(sink.take_store(), Err(StoreError::Sink(_))),
            "{what}: no store"
        );
    }
    Ok(())
}

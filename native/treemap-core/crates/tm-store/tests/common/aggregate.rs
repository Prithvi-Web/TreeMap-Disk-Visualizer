//! The aggregate state's tests' shared ground (Phase 4, T12): the trees, and a walk that feeds
//! an `AggregateState` and the walk's own collector at once, with what each saw.
#![allow(
    dead_code,
    reason = "each test binary uses its own part of the fixtures"
)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tm_store::aggregate::{
    AggregateOptions, AggregateState, Answers, CloseObserver, ClosedFolder, EXTENSION_LIMIT,
    KeepLimits, Summary,
};
use tm_walk::walk::{MAX_WORKERS, Pacer};
use tm_walk::{
    Block, Entry, FastPath, Lister, ListingSink, Meta, Numbering, Refusal, SyntheticSpec,
    WalkOptions, WalkOutput, lister_for, start_with_sinks, synthetic_temp_folder,
};

use super::scripted::{
    Builder, POSIX_ROOT, ScriptedTree, WIDE_ROOT, WINDOWS_ROOT, folder_meta, posix_tree, wide_tree,
    windows_tree,
};

pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A pacer that never waits, and lets the walk run as many workers as it asks for.
pub struct OpenPacer;

impl Pacer for OpenPacer {
    fn on_worker_start(&self) {}
    fn throttle(&self, _cancelled: &dyn Fn() -> bool) {}
    fn worker_limit(&self) -> u32 {
        MAX_WORKERS
    }
}

/// A closed folder as the observer saw it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Closed {
    pub id: u32,
    pub path: Vec<u8>,
    pub position: Vec<u32>,
    pub depth: u32,
    pub bytes: u128,
    pub files: u64,
    pub folders: u64,
}

#[derive(Default)]
pub struct Recording {
    pub closed: Mutex<Vec<Closed>>,
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

pub enum Source {
    Scripted(Arc<ScriptedTree>),
    Synthetic(SyntheticSpec),
    /// A lister of the test's own, such as one that holds a folder back.
    Custom(Arc<dyn Lister>),
}

pub struct Fixture {
    pub name: &'static str,
    pub root: PathBuf,
    pub source: Source,
    pub never_descend: Vec<PathBuf>,
}

pub const SEP: u8 = b'/';

pub fn root_bytes(fixture: &Fixture) -> Vec<u8> {
    fixture.root.to_string_lossy().into_owned().into_bytes()
}

/// A folder's child's path as the scan joins it (`joinPath` in `scanStore.ts`).
pub fn joined(parent: &[u8], name: &[u8]) -> Vec<u8> {
    let mut path = parent.to_vec();
    if path.last() != Some(&SEP) {
        path.push(SEP);
    }
    path.extend_from_slice(name);
    path
}

/// Each row's size as the walk handed it to its sinks: what its listing said; and the
/// root's own time.
#[derive(Default)]
pub struct Listed {
    pub by_id: Mutex<HashMap<u32, f64>>,
    pub root_mtime: Mutex<Option<f64>>,
}

impl ListingSink for Listed {
    fn root(&self, _name: &[u8], meta: &tm_walk::Meta) {
        *lock(&self.root_mtime) = Some(meta.mtime_ms);
    }

    fn commit(&self, block: &Block<'_>) {
        let mut by_id = lock(&self.by_id);
        for (step, row) in (0u32..).zip(block.rows) {
            by_id.insert(block.first + block.offset + step, row.meta.size);
        }
    }

    fn refused(&self, _folder: u32, _why: Refusal) {}

    fn abort(&self) {}
}

pub struct Walked {
    pub out: WalkOutput,
    pub listed: HashMap<u32, f64>,
    /// The root's own time as the walk read it.
    pub root_mtime: Option<f64>,
    pub closed: Vec<Closed>,
    pub open_after: usize,
    /// What the state answered once the walk was done.
    pub answers: Answers,
    /// The shallow keep's rows held once the walk was done, before the seal.
    pub shallow_rows_held: usize,
    /// What the state kept, sealed.
    pub summary: Result<Summary, String>,
}

pub fn walk(fixture: &Fixture, workers: u32, q_max: usize) -> Result<Walked, String> {
    walk_named(fixture, workers, q_max, root_bytes(fixture))
}

/// [`walk`], the root's path spelled `root_path`.
pub fn walk_named(
    fixture: &Fixture,
    workers: u32,
    q_max: usize,
    root_path: Vec<u8>,
) -> Result<Walked, String> {
    walk_limited(fixture, workers, q_max, root_path, EXTENSION_LIMIT)
}

/// [`walk_named`], the file types refused past `extension_limit` extensions.
pub fn walk_limited(
    fixture: &Fixture,
    workers: u32,
    q_max: usize,
    root_path: Vec<u8>,
    extension_limit: usize,
) -> Result<Walked, String> {
    walk_with(
        fixture,
        workers,
        q_max,
        root_path,
        extension_limit,
        KeepLimits::default(),
    )
}

/// [`walk`], what is kept bounded by `keep`.
pub fn walk_kept(
    fixture: &Fixture,
    workers: u32,
    q_max: usize,
    keep: KeepLimits,
) -> Result<Walked, String> {
    walk_with(
        fixture,
        workers,
        q_max,
        root_bytes(fixture),
        EXTENSION_LIMIT,
        keep,
    )
}

/// [`walk_limited`], what is kept bounded by `keep`.
pub fn walk_with(
    fixture: &Fixture,
    workers: u32,
    q_max: usize,
    root_path: Vec<u8>,
    extension_limit: usize,
    keep: KeepLimits,
) -> Result<Walked, String> {
    let recording = Arc::new(Recording::default());
    let state = Arc::new(AggregateState::new(AggregateOptions {
        root_path,
        separator: SEP,
        observer: Some(recording.clone()),
        extension_limit,
        keep,
    }));
    let mut opts = WalkOptions::new(fixture.root.clone());
    opts.numbering = Numbering::Blocks;
    opts.max_workers = usize::try_from(workers).unwrap_or(1);
    opts.q_max = q_max;
    opts.never_descend.clone_from(&fixture.never_descend);
    let lister: Arc<dyn Lister> = match &fixture.source {
        Source::Scripted(tree) => Arc::clone(tree) as Arc<dyn Lister>,
        Source::Custom(lister) => Arc::clone(lister),
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
    let root_mtime = *lock(&listed.root_mtime);
    let listed = lock(&listed.by_id).clone();
    Ok(Walked {
        out,
        listed,
        root_mtime,
        closed,
        open_after: state.open_folders(),
        answers: state.answers(),
        shallow_rows_held: state.shallow_rows_held(),
        summary: state.summary(),
    })
}

/// A state rooted at `root_path`, keeping what `keep` bounds, showing each folder that closes
/// to `observer`.
pub fn new_state(
    root_path: &[u8],
    observer: Option<Arc<dyn CloseObserver>>,
    keep: KeepLimits,
) -> AggregateState {
    AggregateState::new(AggregateOptions {
        root_path: root_path.to_vec(),
        separator: SEP,
        observer,
        extension_limit: EXTENSION_LIMIT,
        keep,
    })
}

/// Hands `sink` folder `folder`'s whole listing in one block, as a walk under the commit
/// lock hands it: the children `rows` in child order, their ids from `first`. For the
/// sink's own calls, driven without a walk (T12f).
pub fn hand_listing(
    sink: &dyn ListingSink,
    folder: u32,
    first: u32,
    rows: &[(&[u8], Meta)],
) -> Result<(), String> {
    let mut names = Vec::new();
    let mut entries = Vec::with_capacity(rows.len());
    for &(name, meta) in rows {
        let start = names.len();
        names.extend_from_slice(name);
        entries.push(Entry {
            name: start..names.len(),
            meta,
        });
    }
    sink.commit(&Block {
        folder,
        first,
        len: u32::try_from(rows.len()).map_err(|e| e.to_string())?,
        name_base: 0,
        offset: 0,
        rows: &entries,
        names: &names,
        own_times: None,
    });
    Ok(())
}

pub fn whole(size: f64) -> u128 {
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

pub fn id_of(index: usize) -> Result<u32, String> {
    u32::try_from(index).map_err(|e| e.to_string())
}

pub fn at_of(id: u32) -> Result<usize, String> {
    usize::try_from(id).map_err(|e| e.to_string())
}

pub const MIXED_ROOT: &str = "/t12a/mixed";
pub const DEEP_ROOT: &str = "/t12a/deep";
pub const CHUNKED_ROOT: &str = "/t12a/chunked";

/// Wide and deep folders, empty ones, refused ones, a name that is a path, a
/// never-descend folder, names that are not UTF-8.
pub fn mixed_tree() -> Result<ScriptedTree, String> {
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
pub fn deep_tree() -> Result<ScriptedTree, String> {
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
pub fn chunked_tree() -> Result<ScriptedTree, String> {
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

pub fn scripted(name: &'static str, root: &str, tree: ScriptedTree) -> Fixture {
    Fixture {
        name,
        root: PathBuf::from(root),
        source: Source::Scripted(Arc::new(tree)),
        never_descend: Vec::new(),
    }
}

pub fn scripted_fixtures() -> Result<Vec<Fixture>, String> {
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

pub fn synthetic_fixtures() -> Vec<Fixture> {
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

pub const WORKERS: [u32; 3] = [1, 4, 8];

//! The digest lock (Phase 4, T4; design §S.2, test 1): what `build(take())` makes today,
//! recorded column by column before T6 changes how the walk numbers what it lists (a
//! block of ids per listing, a commit lock, sinks), a change that must alter nothing
//! `build` makes of a walk.
//!
//! Every fixture is walked by the real walk (`start_with`, with a lister and a pacer) at
//! 1 worker and at 8, then built. `build` numbers breadth-first, so the two stores must
//! be the same, and each must equal the table at the end of this file. A column's
//! digest is FNV-1a 64 over its row count and its rows, each written little-endian at
//! its own width and a float as its bits (so a NaN's payload and −0 count). The side
//! tables, the counters and what the walk measured about the tree are digested the same
//! way.
//!
//! * `scripted-posix`: every per-row rule of `build` and `derive`, and every case whose
//!   outcome depends on an order: a hard-link family whose first member in listing
//!   order, first member breadth-first and smallest path are three different names;
//!   names whose stored (lossy UTF-8) form sorts apart from their bytes; two names
//!   whose stored forms are equal.
//! * `scripted-windows`: Windows' shape. The listing's own order stands, blocks mean
//!   nothing, hard-link families are found by file id and read once through a member,
//!   and a folder's own times replace its parent's copy.
//! * `scripted-wide`: one folder of 65,605 files with more extensions than the
//!   dictionary holds, 2,000 small folders, and sparse files past 2^53 in total.
//! * `synthetic-*`: `SyntheticLister` trees of 30,000 entries: the developer shape at
//!   two seeds, and with 10% of the files hard-linked, 33% folders and 1% folders.
//!
//! A failure names each fixture and column that moved, and prints the whole new table.
//! After a deliberate change, check that each move is the one intended, then paste the
//! printed table over `RECORDED`. Nothing here ever writes it.
//!
//! The table holds on macOS, Linux and Windows alike. No fixture lists a disk: the
//! scripted lister answers from a table, and the synthetic one from a seed and IEEE
//! 754's exactly rounded arithmetic. The one read of a disk is `synthetic_fences`,
//! which canonicalizes `std::env::temp_dir()` once for each synthetic lister made: a
//! read-only look at that path, nothing under it is read, and no digest depends on it.
//! The walk joins names onto paths differently by host (`child_path` and
//! `NAME_SEPARATORS` in tm-walk's `walk.rs`): `ScriptedTree::key_of` says why that
//! cannot reach a digest, and `Builder::put` refuses a scripted name holding a byte a
//! host reads differently (`HOST_SENSITIVE`).

use std::collections::HashMap;
use std::fmt;
use std::ops::Range;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};

use tm_store::derive::ContainerRule;
use tm_store::{BuildOptions, Counters, Store, StoreMode, build, flag};
use tm_walk::invariants::check_walk_columns;
use tm_walk::platform::{DirTimes, ListBuffer, Lister, Meta};
use tm_walk::walk::{MAX_WORKERS, Pacer};
use tm_walk::{
    FLAG_DATALESS, FastPath, KIND_DIR, KIND_FILE, KIND_SYMLINK, Numbering, Refusal, SyntheticSpec,
    WalkOptions, WalkStats, lister_for, start_with, synthetic_temp_folder,
};

/// A failure the harness prints as written: a `String` error prints escaped, on one
/// line, and the table in it could not be pasted back.
struct Failure(String);

impl fmt::Debug for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

type TestResult = Result<(), Failure>;

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

/// FNV-1a 64's offset basis.
const FNV_OFFSET: u64 = 0xCBF2_9CE4_8422_2325;
/// FNV-1a 64's prime.
const FNV_PRIME: u64 = 0x0000_0100_0000_01B3;

/// An FNV-1a 64 hash, fed fixed-width little-endian values.
#[derive(Clone, Copy)]
struct Fnv(u64);

impl Fnv {
    fn start() -> Self {
        Self(FNV_OFFSET)
    }

    fn bytes(self, bytes: &[u8]) -> Self {
        Self(
            bytes
                .iter()
                .fold(self.0, |h, &b| (h ^ u64::from(b)).wrapping_mul(FNV_PRIME)),
        )
    }

    fn word(self, value: u64) -> Self {
        self.bytes(&value.to_le_bytes())
    }

    fn count(self, n: usize) -> Self {
        self.word(u64::try_from(n).unwrap_or(u64::MAX))
    }

    fn float(self, value: f64) -> Self {
        self.word(value.to_bits())
    }

    fn text(self, text: &str) -> Self {
        self.count(text.len()).bytes(text.as_bytes())
    }

    /// The row count, then every row.
    fn rows<T: Row>(self, rows: &[T]) -> Self {
        rows.iter()
            .fold(self.count(rows.len()), |h, row| row.feed(h))
    }
}

/// A row of a column or side table, as it is fed to the hash.
trait Row {
    fn feed(&self, h: Fnv) -> Fnv;
}

/// Integers are written little-endian at their own width.
macro_rules! integer_rows {
    ($($int:ty),*) => {
        $(impl Row for $int {
            fn feed(&self, h: Fnv) -> Fnv {
                h.bytes(&self.to_le_bytes())
            }
        })*
    };
}

integer_rows!(u8, u16, u32, i32);

impl Row for f64 {
    fn feed(&self, h: Fnv) -> Fnv {
        h.float(*self)
    }
}

impl Row for String {
    fn feed(&self, h: Fnv) -> Fnv {
        h.text(self)
    }
}

impl<A: Row, B: Row> Row for (A, B) {
    fn feed(&self, h: Fnv) -> Fnv {
        self.1.feed(self.0.feed(h))
    }
}

/// A store's row counts and one digest per column, side table and tally, in this order.
#[derive(Clone, PartialEq, Eq, Debug)]
struct Digest {
    n: u32,
    capacity: u32,
    columns: Vec<(&'static str, u64)>,
}

fn digest(store: &Store) -> Digest {
    // Every field by name: a field added to `Store` does not compile here until it is
    // digested, or left out with the reason.
    let Store {
        mode,
        n,
        capacity,
        parent,
        size,
        mtime,
        atime,
        flags,
        ext,
        container,
        cloud_prov,
        name_off,
        names,
        child_start,
        child_cnt,
        ext_dict,
        ext_overflow,
        cloud_candidates,
        text_candidates,
        sparse_terms,
        counters,
        walk_stats,
    } = store;
    let h = Fnv::start();
    // No access-time column at all is not a column of zeros.
    let atime = atime
        .as_ref()
        .map_or(h.word(0), |column| h.word(1).rows(column.as_slice()));
    Digest {
        n: *n,
        capacity: *capacity,
        columns: vec![
            ("mode", h.word(mode_code(*mode)).0),
            ("parent", h.rows(parent.as_slice()).0),
            ("size", h.rows(size.as_slice()).0),
            ("mtime", h.rows(mtime.as_slice()).0),
            ("atime", atime.0),
            ("flags", h.rows(flags.as_slice()).0),
            ("ext", h.rows(ext.as_slice()).0),
            ("container", h.rows(container.as_slice()).0),
            ("cloudProv", h.rows(cloud_prov.as_slice()).0),
            ("nameOff", h.rows(name_off.as_slice()).0),
            ("names", h.rows(names.as_slice()).0),
            ("childStart", h.rows(child_start.as_slice()).0),
            ("childCnt", h.rows(child_cnt.as_slice()).0),
            ("extDict", h.rows(ext_dict).0),
            ("extOverflow", h.rows(ext_overflow).0),
            ("cloudCandidates", h.rows(cloud_candidates).0),
            ("textCandidates", h.rows(text_candidates).0),
            ("sparseTerms", h.rows(sparse_terms).0),
            ("counters", counters_digest(counters)),
            ("walkStats", walk_stats_digest(walk_stats)),
        ],
    }
}

fn mode_code(mode: StoreMode) -> u64 {
    match mode {
        StoreMode::Memory => 0,
        StoreMode::Spill => 1,
        StoreMode::Aggregate => 2,
    }
}

fn counters_digest(counters: &Counters) -> u64 {
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
    } = counters;
    Fnv::start()
        .word(*dirs)
        .word(*files)
        .word(*hardlinked_files)
        .float(*hardlinked_bytes)
        .word(*cloud_files)
        .float(*cloud_bytes)
        .word(*sparse_files)
        .float(*sparse_bytes)
        .float(*slack_bytes)
        .rows(denied_dirs)
        .word(*vanished_dirs)
        .word(*unreadable_dirs)
        .0
}

fn walk_stats_digest(stats: &WalkStats) -> u64 {
    // What the walk measured about the tree. What it measured about its own run (the
    // clock, the CPU, how many workers overlapped, the hill-climber's steps) differs
    // from run to run, so it is left out.
    let WalkStats {
        dirs_listed,
        entries,
        wall_ms: _,
        cpu_seconds: _,
        fast_path,
        workers_peak: _,
        climb_steps: _,
        denied_entries,
        unreadable_entries,
        dataless,
    } = stats;
    Fnv::start()
        .word(*dirs_listed)
        .word(*entries)
        .text(fast_path.as_str())
        .word(*denied_entries)
        .word(*unreadable_entries)
        .word(*dataless)
        .0
}

// ---------------------------------------------------------------------------
// The scripted lister
// ---------------------------------------------------------------------------

/// One entry of a scripted listing: its name's bytes, as the OS would give them.
struct Scripted {
    name: Vec<u8>,
    meta: Meta,
}

/// A folder's listing, as the lister hands it over.
#[derive(Default)]
struct Listed {
    entries: Vec<Scripted>,
    /// Entries the OS refused (`EACCES`/`EPERM`): counted, not listed.
    denied: u64,
    /// Entries omitted for any other error.
    unreadable: u64,
    /// The folder's own times, read from the folder itself (Windows).
    own_times: Option<DirTimes>,
}

/// What listing a folder answers.
enum Folder {
    Listed(Listed),
    Refused(Refusal),
}

/// A file system in a table. Folders are found by their path under the root, each name
/// in lossy UTF-8 and `/` between them: the walk joins a raw name onto its parent's path
/// on POSIX and a lossy one on Windows, and both come to the same key.
struct ScriptedTree {
    root: PathBuf,
    root_meta: Meta,
    folders: HashMap<String, Folder>,
    /// What reading a file through any of its names gives, by file id: every name of one
    /// file reads the file itself (the Windows family refresh reads one of them).
    files: HashMap<u128, Result<Meta, Refusal>>,
    /// Whether a listing is handed over sorted by its raw name bytes, as the POSIX
    /// listers hand theirs over (`Listing::sort_by_name`), or in its own order, as
    /// Windows' are.
    sorted: bool,
    fast_path: FastPath,
}

/// `meta` as a listing gives it when access times were not asked for.
fn asked(meta: Meta, want_atime: bool) -> Meta {
    if want_atime {
        meta
    } else {
        Meta {
            atime_ms: f64::NAN,
            ..meta
        }
    }
}

impl ScriptedTree {
    /// `path`'s key: its names under the root, each made lossy UTF-8, `/` between them.
    ///
    /// The walk spells a path differently by host. `child_path` (tm-walk's `walk.rs`)
    /// joins a folder's raw name bytes on Unix and the name made lossy UTF-8 everywhere
    /// else, and the family refresh (`node_path`) joins the stored names, which are lossy.
    /// Keying every name by `to_string_lossy` erases the difference: a raw name keys as
    /// its lossy form, a lossy name is valid UTF-8 and keys as itself, and that one
    /// spelling is the one `Builder` files every folder and entry under. So every host
    /// finds every folder at the same key, and how a host joins names cannot reach a
    /// digest. `a_raw_name_and_its_lossy_spelling_find_the_same_folder` holds this on
    /// Unix, the one host that joins raw bytes.
    fn key_of(&self, path: &Path) -> Option<String> {
        let rest = path.strip_prefix(&self.root).ok()?;
        let mut names = Vec::new();
        for component in rest.components() {
            let Component::Normal(name) = component else {
                return None;
            };
            names.push(name.to_string_lossy().into_owned());
        }
        Some(names.join("/"))
    }

    /// The listed entry at `key`.
    fn entry(&self, key: &str) -> Option<&Scripted> {
        let (folder, name) = key.rsplit_once('/').unwrap_or(("", key));
        let Some(Folder::Listed(listed)) = self.folders.get(folder) else {
            return None;
        };
        listed
            .entries
            .iter()
            .find(|entry| String::from_utf8_lossy(&entry.name) == name)
    }
}

impl Lister for ScriptedTree {
    fn stat_dir(&self, path: &Path, want_atime: bool) -> Result<Meta, Refusal> {
        let key = self.key_of(path).ok_or(Refusal::Vanished)?;
        if key.is_empty() {
            return Ok(asked(self.root_meta, want_atime));
        }
        let entry = self.entry(&key).ok_or(Refusal::Vanished)?;
        match self.files.get(&entry.meta.ino) {
            Some(&read) if entry.meta.kind == KIND_FILE => read.map(|meta| asked(meta, want_atime)),
            _ => Ok(asked(entry.meta, want_atime)),
        }
    }

    fn list(
        &self,
        dir: &Path,
        want_atime: bool,
        buf: &mut ListBuffer,
    ) -> Result<FastPath, Refusal> {
        buf.listing.clear();
        let key = self.key_of(dir).ok_or(Refusal::Vanished)?;
        let listed = match self.folders.get(&key) {
            Some(Folder::Listed(listed)) => listed,
            Some(Folder::Refused(why)) => return Err(*why),
            None => return Err(Refusal::Vanished),
        };
        for entry in &listed.entries {
            buf.listing.push(&entry.name, asked(entry.meta, want_atime));
        }
        buf.listing.denied_entries = listed.denied;
        buf.listing.unreadable_entries = listed.unreadable;
        buf.listing.own_times = listed.own_times.map(|times| DirTimes {
            atime_ms: if want_atime { times.atime_ms } else { f64::NAN },
            ..times
        });
        if self.sorted {
            buf.listing.sort_by_name();
        }
        buf.beat();
        Ok(self.fast_path)
    }
}

/// The device every scripted entry is on.
const DEV: f64 = 16_777_234.0;
/// The block the scripted file systems allocate in.
const BLOCK: f64 = 4_096.0;
/// The first file id the builder hands out: every id a fixture gives by hand is below it,
/// or past 2^64.
const FIRST_INO: u128 = 1_000;
/// Bytes no scripted name holds, because hosts read them differently. `\` separates names
/// on Windows alone (`NAME_SEPARATORS` in tm-walk's `walk.rs`), so a folder so named
/// would be refused there and listed everywhere else; `:` after a letter starts a drive
/// on Windows, so joining such a name would replace the path it is joined to. Either
/// would make the table differ by host, so `Builder::put` refuses both.
const HOST_SENSITIVE: &[u8] = b"\\:";

/// Times that differ from entry to entry, so no column keeps its digest when rows move.
fn times(ino: u128) -> (f64, f64) {
    let step = f64::from(u32::try_from(ino % 1_000_000).unwrap_or(0));
    let mtime_ms = 1_600_000_000_000.0 + step * 1_000.5;
    (mtime_ms, mtime_ms + 86_400_000.25)
}

fn folder_meta(ino: u128) -> Meta {
    let (mtime_ms, atime_ms) = times(ino);
    Meta {
        kind: KIND_DIR,
        flags: 0,
        size: 0.0,
        alloc: 0.0,
        mtime_ms,
        atime_ms,
        dev: DEV,
        ino,
        nlink: 2,
        withheld: false,
    }
}

fn file_meta(size: f64, alloc: f64, ino: u128, nlink: u32) -> Meta {
    let (mtime_ms, atime_ms) = times(ino);
    Meta {
        kind: KIND_FILE,
        flags: 0,
        size,
        alloc,
        mtime_ms,
        atime_ms,
        dev: DEV,
        ino,
        nlink,
        withheld: false,
    }
}

/// A symbolic link: its size is the length of the target text, and nothing is allocated.
fn symlink(target_len: f64, ino: u128) -> Meta {
    Meta {
        kind: KIND_SYMLINK,
        ..file_meta(target_len, 0.0, ino, 1)
    }
}

/// `meta` with its data away from this disk.
fn dataless(meta: Meta) -> Meta {
    Meta {
        flags: FLAG_DATALESS,
        ..meta
    }
}

/// Whole blocks for `size` bytes.
fn blocks(size: f64) -> f64 {
    (size / BLOCK).ceil() * BLOCK
}

/// Builds a scripted tree folder by folder.
struct Builder {
    folders: HashMap<String, Folder>,
    files: HashMap<u128, Result<Meta, Refusal>>,
    next_ino: u128,
}

impl Builder {
    fn with_root() -> Self {
        let mut folders = HashMap::new();
        folders.insert(String::new(), Folder::Listed(Listed::default()));
        Self {
            folders,
            files: HashMap::new(),
            next_ino: FIRST_INO,
        }
    }

    fn ino(&mut self) -> u128 {
        self.next_ino += 1;
        self.next_ino
    }

    fn listing(&mut self, key: &str) -> Result<&mut Listed, String> {
        match self.folders.get_mut(key) {
            Some(Folder::Listed(listed)) => Ok(listed),
            _ => Err(format!("no listed folder at {key:?}")),
        }
    }

    /// Adds `name` to `parent`'s listing; a name holding a byte of [`HOST_SENSITIVE`] is
    /// refused, so a fixture holding one fails to build rather than digest by host.
    fn put(&mut self, parent: &str, name: &[u8], meta: Meta) -> Result<(), String> {
        if name.iter().any(|byte| HOST_SENSITIVE.contains(byte)) {
            return Err(format!(
                "the name {:?} holds `\\` or `:`, which Windows reads apart from other hosts",
                String::from_utf8_lossy(name)
            ));
        }
        self.listing(parent)?.entries.push(Scripted {
            name: name.to_vec(),
            meta,
        });
        Ok(())
    }

    /// Adds `name` to `parent`'s listing with a new file id.
    fn put_new(&mut self, parent: &str, name: &[u8], meta: fn(u128) -> Meta) -> Result<(), String> {
        let ino = self.ino();
        self.put(parent, name, meta(ino))
    }

    /// A file of `size` bytes in whole blocks.
    fn file(&mut self, parent: &str, name: &[u8], size: f64) -> Result<(), String> {
        let ino = self.ino();
        self.put(parent, name, file_meta(size, blocks(size), ino, 1))
    }

    /// A folder entry answered by `folder`; its key.
    fn folder(
        &mut self,
        parent: &str,
        name: &[u8],
        meta: Meta,
        folder: Folder,
    ) -> Result<String, String> {
        self.put(parent, name, meta)?;
        let name = String::from_utf8_lossy(name);
        let key = if parent.is_empty() {
            name.into_owned()
        } else {
            format!("{parent}/{name}")
        };
        if self.folders.insert(key.clone(), folder).is_some() {
            return Err(format!("two folders at {key:?}"));
        }
        Ok(key)
    }

    /// A folder with nothing in it yet; its key.
    fn dir(&mut self, parent: &str, name: &[u8]) -> Result<String, String> {
        let ino = self.ino();
        self.folder(
            parent,
            name,
            folder_meta(ino),
            Folder::Listed(Listed::default()),
        )
    }

    /// The folder `name` in `parent`, made if it is not there yet; its key.
    fn dir_at(&mut self, parent: &str, name: &[u8]) -> Result<String, String> {
        let lossy = String::from_utf8_lossy(name);
        let key = if parent.is_empty() {
            lossy.into_owned()
        } else {
            format!("{parent}/{lossy}")
        };
        if self.folders.contains_key(&key) {
            return Ok(key);
        }
        self.dir(parent, name)
    }

    /// A folder whose listing is refused.
    fn refused(&mut self, parent: &str, name: &[u8], why: Refusal) -> Result<(), String> {
        let ino = self.ino();
        self.folder(parent, name, folder_meta(ino), Folder::Refused(why))
            .map(drop)
    }

    fn omitted(&mut self, key: &str, denied: u64, unreadable: u64) -> Result<(), String> {
        let listed = self.listing(key)?;
        listed.denied = denied;
        listed.unreadable = unreadable;
        Ok(())
    }

    fn own_times(&mut self, key: &str, mtime_ms: f64, atime_ms: f64) -> Result<(), String> {
        self.listing(key)?.own_times = Some(DirTimes { mtime_ms, atime_ms });
        Ok(())
    }

    fn finish(
        self,
        root: &str,
        root_meta: Meta,
        sorted: bool,
        fast_path: FastPath,
    ) -> ScriptedTree {
        ScriptedTree {
            root: PathBuf::from(root),
            root_meta,
            folders: self.folders,
            files: self.files,
            sorted,
            fast_path,
        }
    }
}

// ---------------------------------------------------------------------------
// The scripted trees
// ---------------------------------------------------------------------------

/// `a😀`: its bytes sort before [`INVALID`]'s.
const EMOJI: &[u8] = "a😀".as_bytes();
/// `a` and the byte 0xF8, which is no UTF-8: stored as `a\u{FFFD}`, which sorts before
/// `a😀` although the raw bytes sort after it.
const INVALID: &[u8] = b"a\xF8";
/// The cross-folder family's member that comes first in listing order (design §S.2,
/// Lemma 3): today's walk, one worker, numbers it first.
const LISTING_FIRST: &[&[u8]] = &[EMOJI, b"x"];
/// The member that comes first breadth-first in the store, which keeps the bytes.
const STORE_FIRST: &[&[u8]] = &[INVALID, b"y"];
/// The member with the smallest path.
const SMALLEST_PATH: &[&[u8]] = &[b"A", b"deep", b"z"];
const FAMILY: [&[&[u8]]; 3] = [LISTING_FIRST, STORE_FIRST, SMALLEST_PATH];
/// The family's file id, and its size.
const FAMILY_INO: u128 = 500;
const FAMILY_BYTES: f64 = 4_096.0;

const POSIX_ROOT: &str = "/t4/posix";

fn posix_tree() -> Result<ScriptedTree, String> {
    let mut b = Builder::with_root();
    b.omitted("", 2, 1)?;

    // `.git` makes its folder a repository, the root included; a `.git` file, a `.GIT`
    // folder and a `.git` link do not.
    let git = b.dir("", b".git")?;
    b.file(&git, b"HEAD", 23.0)?;
    let objects = b.dir(&git, b"objects")?;
    b.file(&objects, b"pack-1.pack", 1_048_576.0)?;
    b.file(&objects, b".keep", 0.0)?;
    let config = b.dir("", b".config")?;
    b.file(&config, b"settings.json", 412.0)?;
    let proj = b.dir("", b"proj")?;
    b.dir(&proj, b".git")?;
    let src = b.dir(&proj, b"src")?;
    b.file(&src, b"main.rs", 2_345.0)?;
    let worktree = b.dir("", b"wt")?;
    b.file(&worktree, b".git", 40.0)?;
    let upper = b.dir("", b"upper")?;
    b.dir(&upper, b".GIT")?;
    b.put_new(&upper, b".git", |ino| symlink(20.0, ino))?;

    // Hidden names, extensions (none, dotfiles, upper case, doubled) and containers.
    let plain: [(&[u8], f64); 27] = [
        (b".hidden", 0.0),
        (b".env.local", 90.0),
        (b"...", 3.0),
        (b"a.", 1.0),
        (b"README", 1_234.0),
        (b"Makefile", 99.0),
        (b"PHOTO.JPG", 2_000_000.0),
        (b"photo.jpg", 1_500_000.0),
        (b"x.Rs", 700.0),
        (b"y.rs", 800.0),
        (b"archive.tar.gz", 10_000.0),
        (b"backup.TAR.GZ", 20_000.0),
        (b"bundle.tgz", 30_000.0),
        (b"lib.jar", 40_000.0),
        (b"data.tar", 50_000.0),
        (b"disk.iso", 700_000_000.0),
        (b"image.dmg", 60_000.0),
        (b"archive.zip", 1_000.0),
        (b"docker.raw.bak", 1_000.0),
        (b"ext4.vhdx", 1_000.0),
        (b"my.ext4.vhdx", 1_000.0),
        (b"fake.photoslibrary", 1_000.0),
        ("café.zip".as_bytes(), 1_000.0),
        ("日本語".as_bytes(), 1_000.0),
        (b"zero.txt", 0.0),
        (b"big.mkv", 5_368_709_120.0),
        (b"x.Zip", 3_000.0),
    ];
    for (name, size) in plain {
        b.file("", name, size)?;
    }
    let photos = b.dir("", b"Photos Library.photoslibrary")?;
    b.file(&photos, b"database.db", 5_000.0)?;
    b.dir("", b"dir.zip")?;
    // Docker's disk image: a whole-name container, sparse, and past 2^32 bytes.
    b.put_new("", b"Docker.raw", |ino| {
        file_meta(68_719_476_736.0, 12_884_901_888.0, ino, 1)
    })?;

    // Links are never followed, whatever their name, size or link count.
    b.put_new("", b"link-to-dir", |ino| symlink(11.0, ino))?;
    b.put_new("", b".hidden-link", |ino| symlink(7.0, ino))?;
    b.put_new("", b"link.zip", |ino| symlink(9.0, ino))?;
    b.put_new("", b"linked-link", |ino| Meta {
        nlink: 2,
        ..symlink(12.0, ino)
    })?;

    // Placeholders, and a file claiming bytes with none allocated.
    b.put_new("", b"cloud.pdf", |ino| {
        dataless(file_meta(1_000_000.0, 0.0, ino, 1))
    })?;
    let ino = b.ino();
    let cloud = b.folder(
        "",
        b"cloud-dir",
        dataless(folder_meta(ino)),
        Folder::Listed(Listed::default()),
    )?;
    b.put_new(&cloud, b"evicted.txt", |ino| {
        dataless(file_meta(5_000.0, 0.0, ino, 1))
    })?;
    b.put_new("", b"guess.bin", |ino| file_meta(2_048.0, 0.0, ino, 1))?;

    // Sparse, slack, exact and empty, and an entry whose attributes were withheld.
    b.put_new("", b"sparse.img", |ino| {
        file_meta(10_000_000.0, 4_096.0, ino, 1)
    })?;
    b.put_new("", b"slack.txt", |ino| file_meta(100.0, 4_096.0, ino, 1))?;
    b.put_new("", b"exact.bin", |ino| file_meta(8_192.0, 8_192.0, ino, 1))?;
    b.put_new("", b"empty-alloc", |ino| file_meta(0.0, 4_096.0, ino, 1))?;
    b.put("", b"odd.bin", Meta::unknown(KIND_FILE))?;

    // Times: `Math.round`'s halves, −0, the largest double below a half, 2^52 + 1, and
    // access times of 0 and below (never recorded).
    let stamps: [(&[u8], f64, f64); 8] = [
        (b"t-half", 1_700_000_000_000.5, f64::NAN),
        (b"t-neg", -1.5, f64::NAN),
        (b"t-negzero", -0.25, f64::NAN),
        (b"t-tiny", 0.5 - f64::EPSILON / 4.0, 1.0),
        (b"t-big", 4_503_599_627_370_497.0, 2.5),
        (b"t-atime-zero", 1_000.0, 0.0),
        (b"t-atime-neg", 1_000.0, -5.0),
        (b"t-atime-half", 1_000.0, 2.5),
    ];
    for (name, mtime_ms, atime_ms) in stamps {
        let ino = b.ino();
        b.put(
            "",
            name,
            Meta {
                mtime_ms,
                atime_ms,
                ..file_meta(1.0, BLOCK, ino, 1)
            },
        )?;
    }

    // Folders that cannot be listed, one whose name holds a separator, one the walk
    // never descends into, and an empty one.
    b.refused("", b"denied", Refusal::Denied)?;
    b.refused("", b"gone", Refusal::Vanished)?;
    b.refused("", b"broken", Refusal::Unreadable)?;
    b.put_new("", b"sl/ash", folder_meta)?;
    let volumes = b.dir("", b"Volumes")?;
    b.file(&volumes, b"inside.bin", 99.0)?;
    b.dir("", b"empty")?;

    // A hundred folders deep.
    let mut deep = b.dir("", b"deep-chain")?;
    for level in 0..100 {
        deep = b.dir(&deep, format!("level-{level:03}").as_bytes())?;
    }
    b.file(&deep, b"leaf.txt", 1.0)?;

    // The cross-folder family, and names whose stored form reorders a listing: in the
    // root (`a\xF8` against `a😀`) and in a folder of exactly two (`c\xF8`, `c😀`).
    let family = file_meta(FAMILY_BYTES, FAMILY_BYTES, FAMILY_INO, 3);
    for path in FAMILY {
        let Some((name, folders)) = path.split_last() else {
            continue;
        };
        let mut at = String::new();
        for folder in folders {
            at = b.dir_at(&at, folder)?;
        }
        b.put(&at, name, family)?;
    }
    let invalid = b.dir_at("", INVALID)?;
    b.file(&invalid, b"w.txt", 10.0)?;
    let pair = b.dir("", b"pair")?;
    b.file(&pair, b"c\xF8", 5.0)?;
    b.file(&pair, "c😀".as_bytes(), 6.0)?;
    // Stored alike as `x\u{FFFD}.txt`: the listing's order stands between them.
    b.file("", b"x\xF8.txt", 1.0)?;
    b.file("", b"x\xF9.txt", 2.0)?;

    // More families: two names in one folder, a name whose other names are outside the
    // scan, names claiming bytes with none allocated, and placeholders.
    let links = b.dir("", b"links")?;
    let two = file_meta(777.0, BLOCK, 501, 2);
    b.put(&links, b"one.bin", two)?;
    b.put(&links, b"two.bin", two)?;
    b.put(&links, b"lonely.bin", file_meta(55.0, BLOCK, 502, 2))?;
    let unallocated = file_meta(1_000.0, 0.0, 503, 2);
    b.put(&links, b"u1", unallocated)?;
    b.put(&src, b"u2", unallocated)?;
    let placeholder = dataless(file_meta(300.0, 0.0, 504, 2));
    b.put(&links, b"p1", placeholder)?;
    let upper_a = b.dir_at("", b"A")?;
    b.put(&upper_a, b"p2", placeholder)?;

    let root_meta = Meta {
        mtime_ms: f64::NAN,
        atime_ms: 1_700_000_000_000.5,
        ..folder_meta(1)
    };
    Ok(b.finish(POSIX_ROOT, root_meta, true, FastPath::Bulk))
}

const WINDOWS_ROOT: &str = "/t4/windows";

fn windows_tree() -> Result<ScriptedTree, String> {
    let mut b = Builder::with_root();
    // The root listing in the file system's own order, which is not the bytes' order;
    // `q\xFF.log` is a name its stored form changes.
    let vs = b.dir("", b".vs")?;
    b.put_new("", b"a/b", folder_meta)?;
    b.put_new("", b"alpha.TXT", |ino| file_meta(10.0, BLOCK, ino, 0))?;
    let beta = b.dir("", b"Beta")?;
    let beta2 = b.dir("", b"beta2")?;
    // Enough folders that eight workers list side by side.
    for i in 0..12 {
        let folder = b.dir("", format!("c{i:02}").as_bytes())?;
        b.put_new(&folder, b"a.dat", |ino| file_meta(1.0, BLOCK, ino, 0))?;
        b.put_new(&folder, b"b.dat", |ino| file_meta(2.0, BLOCK, ino, 0))?;
    }
    // No file id (FAT32, exFAT): never a family.
    b.put("", b"fat1.bin", file_meta(100.0, BLOCK, 0, 0))?;
    b.put("", b"fat2.bin", file_meta(200.0, BLOCK, 0, 0))?;
    b.put_new("", b"junction", |ino| Meta {
        nlink: 0,
        ..symlink(30.0, ino)
    })?;
    b.put_new("", "lone\u{FFFD}.txt".as_bytes(), |ino| {
        file_meta(7.0, BLOCK, ino, 0)
    })?;
    b.put_new("", b"onedrive.docx", |ino| {
        dataless(file_meta(50_000.0, 0.0, ino, 0))
    })?;
    b.put_new("", b"pinned.bin", |ino| file_meta(10.0, 0.0, ino, 0))?;
    b.put_new("", b"q\xFF.log", |ino| file_meta(3.0, BLOCK, ino, 0))?;
    b.put_new("", b"sparse-looking.vhdx", |ino| {
        file_meta(1_000_000.0, BLOCK, ino, 0)
    })?;
    b.refused("", b"System Volume Information", Refusal::Denied)?;
    let zeta = b.dir("", b"Zeta")?;
    let sub = b.dir(&zeta, b"sub")?;
    b.put_new(&beta, b"REPORT.PDF", |ino| file_meta(300.0, BLOCK, ino, 0))?;

    // Each listing reports its folder's own times; the root's are not used.
    let own: [(&str, f64, f64); 6] = [
        ("", 5.0, 6.0),
        (&beta, 2_000.5, 2_100.5),
        (&beta2, 3_000.25, 3_100.75),
        (&zeta, 4_000.5, 4_100.5),
        (&sub, 5_000.75, 5_100.25),
        (&vs, 6_000.5, 6_100.5),
    ];
    for (key, mtime_ms, atime_ms) in own {
        b.own_times(key, mtime_ms, atime_ms)?;
    }

    // Families found by file id alone: every name lists its own stale copy of the
    // file's facts, and reading any name gives the file's own, which every name takes.
    // Two ids that differ only above bit 64 are two files.
    let above_64 = |high: u128, low: u128| (high << 64) | low;
    let refreshed: [(u128, f64, &str, &str); 3] = [
        (above_64(1, 0x77), 42.0, &beta, &sub),
        (above_64(1, 5), 11.0, &beta2, &zeta),
        (above_64(2, 5), 12.0, &beta2, &zeta),
    ];
    for (id, size, first, second) in refreshed {
        b.files.insert(
            id,
            Ok(Meta {
                mtime_ms: 9_000.5 + size,
                atime_ms: 9_001.25 + size,
                ..file_meta(size, BLOCK, id, 2)
            }),
        );
        let name = format!("hl-{size}.bin");
        b.put(first, name.as_bytes(), file_meta(size - 1.0, BLOCK, id, 0))?;
        b.put(second, name.as_bytes(), file_meta(size + 1.0, BLOCK, id, 0))?;
    }
    // A family whose read reaches another file, and one whose read fails: both keep
    // what their listings said.
    b.files.insert(600, Ok(file_meta(99.0, BLOCK, 601, 2)));
    b.put(&zeta, b"w3a", file_meta(7.0, BLOCK, 600, 0))?;
    b.put(&vs, b"w3b", file_meta(8.0, BLOCK, 600, 0))?;
    b.files.insert(602, Err(Refusal::Denied));
    b.put(&zeta, b"w4a", file_meta(9.0, BLOCK, 602, 0))?;
    b.put(&vs, b"w4b", file_meta(10.0, BLOCK, 602, 0))?;

    let root_meta = Meta {
        mtime_ms: 1_600_000_000_000.75,
        atime_ms: 1_600_000_100_000.25,
        nlink: 0,
        ..folder_meta(1)
    };
    Ok(b.finish(WINDOWS_ROOT, root_meta, false, FastPath::ExtdDirInfo))
}

const WIDE_ROOT: &str = "/t4/wide";
/// Files with an extension each: more than the dictionary's 65,534.
const WIDE_FILES: u32 = 65_600;
const SMALL_FOLDERS: u32 = 2_000;

fn wide_tree() -> Result<ScriptedTree, String> {
    let mut b = Builder::with_root();
    // Their shortfalls total more than 2^53, so the store keeps a sparse term per file.
    b.put_new("", b"huge1.img", |ino| {
        file_meta(6_000_000_000_000_000.0, BLOCK, ino, 1)
    })?;
    b.put_new("", b"huge2.img", |ino| {
        file_meta(6_000_000_000_000_000.0, BLOCK, ino, 1)
    })?;
    let many = b.dir("", b"many")?;
    for i in 0..WIDE_FILES {
        b.file(&many, format!("f{i:05}.x{i}").as_bytes(), f64::from(i))?;
    }
    // Upper-case forms of extensions in the dictionary.
    for i in 0..5 {
        b.file(&many, format!("g{i}.X{i}").as_bytes(), 1.0)?;
    }
    // One past it, twice: each name keeps its own overflow entry.
    let other = b.dir("", b"other")?;
    let last = WIDE_FILES - 1;
    b.file(&other, format!("h1.x{last}").as_bytes(), 1.0)?;
    b.file(&other, format!("H2.X{last}").as_bytes(), 2.0)?;
    let small = b.dir("", b"dirs")?;
    for i in 0..SMALL_FOLDERS {
        let folder = b.dir(&small, format!("d{i:04}").as_bytes())?;
        b.file(&folder, b"file.txt", f64::from(i))?;
    }
    Ok(b.finish(WIDE_ROOT, folder_meta(1), true, FastPath::Bulk))
}

// ---------------------------------------------------------------------------
// Fixtures and runs
// ---------------------------------------------------------------------------

/// Where a fixture's listings come from.
enum Source {
    Scripted(Arc<ScriptedTree>),
    /// `SyntheticLister`, as `lister_for` makes it.
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

/// `detectContainerKind`'s rules in its order, with `CONTAINER_ID`'s numbers.
fn container_rules() -> Vec<ContainerRule> {
    let rule = |text: &str, whole_name: bool, folders: bool, kind: u8| ContainerRule {
        text: text.to_owned(),
        whole_name,
        folders,
        kind,
    };
    vec![
        rule(".photoslibrary", false, true, 6),
        rule("docker.raw", true, false, 7),
        rule("docker.qcow2", true, false, 7),
        rule("ext4.vhdx", true, false, 7),
        rule("docker_data.vhdx", true, false, 7),
        rule(".tar.gz", false, false, 3),
        rule(".tgz", false, false, 3),
        rule(".zip", false, false, 1),
        rule(".jar", false, false, 1),
        rule(".tar", false, false, 2),
        rule(".iso", false, false, 4),
        rule(".dmg", false, false, 5),
    ]
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

fn posix_fixture() -> Result<Fixture, String> {
    let root = PathBuf::from(POSIX_ROOT);
    Ok(Fixture {
        name: "scripted-posix",
        never_descend: vec![root.join("Volumes")],
        root,
        source: Source::Scripted(Arc::new(posix_tree()?)),
        want_atime: true,
        build: options("posix", 1_234_567.0, true, 64),
    })
}

/// Entries in each synthetic tree.
const SYNTHETIC_ENTRIES: u64 = 30_000;
/// The synthetic trees' root, inside the app's synthetic temp folder (nothing creates it).
const SYNTHETIC_ROOT: &str = "tm-store-digest-lock";

fn fixtures() -> Result<Vec<Fixture>, String> {
    let mut all = vec![
        posix_fixture()?,
        Fixture {
            name: "scripted-windows",
            root: PathBuf::from(WINDOWS_ROOT),
            source: Source::Scripted(Arc::new(windows_tree()?)),
            want_atime: true,
            never_descend: Vec::new(),
            build: options("windows", 5.0, false, 0),
        },
        Fixture {
            name: "scripted-wide",
            root: PathBuf::from(WIDE_ROOT),
            source: Source::Scripted(Arc::new(wide_tree()?)),
            want_atime: false,
            never_descend: Vec::new(),
            build: options("wide", 0.0, true, 1_000),
        },
    ];
    let developer = |seed| SyntheticSpec::developer(SYNTHETIC_ENTRIES, seed);
    let synthetic = [
        ("synthetic-developer-seed-1", developer(1), false),
        ("synthetic-developer-seed-2", developer(2), true),
        (
            "synthetic-links-10pct",
            SyntheticSpec {
                link_ppm: 100_000,
                ..developer(1)
            },
            false,
        ),
        (
            "synthetic-folders-33pct",
            SyntheticSpec {
                folder_ppm: 330_000,
                ..developer(1)
            },
            true,
        ),
        (
            "synthetic-folders-1pct",
            SyntheticSpec {
                folder_ppm: 10_000,
                ..developer(1)
            },
            false,
        ),
    ];
    for (name, spec, want_atime) in synthetic {
        all.push(Fixture {
            name,
            root: synthetic_temp_folder().join(SYNTHETIC_ROOT),
            source: Source::Synthetic(spec),
            want_atime,
            never_descend: Vec::new(),
            build: options(SYNTHETIC_ROOT, 0.0, true, 4_096),
        });
    }
    Ok(all)
}

/// A pacer that never waits, and lets the walk run as many workers as it asks for.
struct OpenPacer;

impl Pacer for OpenPacer {
    fn on_worker_start(&self) {}
    fn throttle(&self, _cancelled: &dyn Fn() -> bool) {}
    fn worker_limit(&self) -> u32 {
        MAX_WORKERS
    }
}

/// Both ways a walk numbers what it lists (T6): what `build` makes of a walk must not
/// depend on which.
const NUMBERINGS: [Numbering; 2] = [Numbering::Discovery, Numbering::Blocks];

/// `build(take())` of `fixture` walked by exactly `workers` workers, numbered by
/// `numbering`. A block-numbered walk is first held to I1–I4, its children in stored
/// name order wherever the build sorts them (design §S.2, test 8).
fn walk_and_build(
    fixture: &Fixture,
    workers: usize,
    numbering: Numbering,
) -> Result<Store, String> {
    let mut opts = WalkOptions::new(fixture.root.clone());
    opts.never_descend.clone_from(&fixture.never_descend);
    opts.want_atime = fixture.want_atime;
    opts.max_workers = workers;
    opts.numbering = numbering;
    let lister: Arc<dyn Lister> = match &fixture.source {
        Source::Scripted(tree) => Arc::clone(tree) as Arc<dyn Lister>,
        Source::Synthetic(spec) => {
            opts.synthetic = Some(spec.clone());
            lister_for(&opts).map_err(|e| e.to_string())?
        }
    };
    let handle = start_with(opts, Arc::new(OpenPacer), lister).map_err(|e| e.to_string())?;
    let output = handle.take().map_err(|e| e.to_string())?;
    if numbering == Numbering::Blocks {
        check_walk_columns(
            &output.parent,
            &output.name_off,
            &output.names,
            fixture.build.sort_children,
        )
        .map_err(|broken| format!("the block-numbered walk: {broken}"))?;
    }
    build(output, &fixture.build).map_err(|e| e.to_string())
}

/// One fixture's digests at 1 worker and at 8, numbered on discovery and in blocks, or
/// why a run failed.
struct Run {
    fixture: &'static str,
    one: Result<Digest, String>,
    eight: Result<Digest, String>,
    blocks_one: Result<Digest, String>,
    blocks_eight: Result<Digest, String>,
}

/// Every fixture, walked and built once for all the tests here.
fn runs() -> Result<&'static [Run], Failure> {
    static RUNS: OnceLock<Result<Vec<Run>, String>> = OnceLock::new();
    RUNS.get_or_init(|| {
        let digests = |fixture: &Fixture, workers, numbering| {
            walk_and_build(fixture, workers, numbering).map(|store| digest(&store))
        };
        fixtures().map(|all| {
            all.iter()
                .map(|fixture| Run {
                    fixture: fixture.name,
                    one: digests(fixture, 1, Numbering::Discovery),
                    eight: digests(fixture, 8, Numbering::Discovery),
                    blocks_one: digests(fixture, 1, Numbering::Blocks),
                    blocks_eight: digests(fixture, 8, Numbering::Blocks),
                })
                .collect()
        })
    })
    .as_deref()
    .map_err(|why| Failure(format!("the fixtures could not be made: {why}")))
}

// ---------------------------------------------------------------------------
// Comparing and printing
// ---------------------------------------------------------------------------

/// A digest as the table writes it.
fn hex(value: u64) -> String {
    format!(
        "0x{:04X}_{:04X}_{:04X}_{:04X}",
        value >> 48,
        (value >> 32) & 0xFFFF,
        (value >> 16) & 0xFFFF,
        value & 0xFFFF
    )
}

/// A count as the table writes it: thousands apart from five digits on.
fn grouped(value: u32) -> String {
    let digits = value.to_string();
    if digits.len() < 5 {
        return digits;
    }
    let mut out = String::new();
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push('_');
        }
        out.push(digit);
    }
    out
}

/// What differs between two digests of one fixture.
fn moved_between(a: &Digest, b: &Digest) -> Vec<String> {
    let mut moved = Vec::new();
    if a.n != b.n {
        moved.push(format!("n ({} and {})", a.n, b.n));
    }
    if a.capacity != b.capacity {
        moved.push(format!("capacity ({} and {})", a.capacity, b.capacity));
    }
    for &(name, value) in &a.columns {
        let other = b.columns.iter().find(|(n, _)| *n == name).map(|&(_, v)| v);
        if other != Some(value) {
            moved.push(name.to_owned());
        }
    }
    moved
}

/// What moved in `now` from the recorded table.
fn against_recorded(fixture: &str, now: &Digest) -> Vec<String> {
    let Some(recorded) = RECORDED.iter().find(|r| r.fixture == fixture) else {
        return vec![format!("{fixture}: not recorded")];
    };
    let mut moved = Vec::new();
    if recorded.n != now.n {
        moved.push(format!(
            "{fixture}: n moved from {} to {}",
            recorded.n, now.n
        ));
    }
    if recorded.capacity != now.capacity {
        moved.push(format!(
            "{fixture}: capacity moved from {} to {}",
            recorded.capacity, now.capacity
        ));
    }
    for &(name, value) in &now.columns {
        match recorded.columns.iter().find(|(n, _)| *n == name) {
            Some(&(_, was)) if was == value => {}
            Some(&(_, was)) => moved.push(format!(
                "{fixture}: {name} moved from {} to {}",
                hex(was),
                hex(value)
            )),
            None => moved.push(format!("{fixture}: {name} is not recorded")),
        }
    }
    for &(name, _) in recorded.columns {
        if !now.columns.iter().any(|(n, _)| *n == name) {
            moved.push(format!(
                "{fixture}: {name} is recorded but no longer digested"
            ));
        }
    }
    moved
}

/// The table, as `RECORDED` would hold it, from the 1-worker digests.
fn render(runs: &[Run]) -> String {
    let mut lines = vec!["const RECORDED: &[Recorded] = &[".to_owned()];
    for run in runs {
        let Ok(digest) = &run.one else {
            lines.push(format!("    // {}: no digest, the run failed", run.fixture));
            continue;
        };
        lines.push("    Recorded {".to_owned());
        lines.push(format!("        fixture: {:?},", run.fixture));
        lines.push(format!("        n: {},", grouped(digest.n)));
        lines.push(format!("        capacity: {},", grouped(digest.capacity)));
        lines.push("        columns: &[".to_owned());
        for &(name, value) in &digest.columns {
            lines.push(format!("            ({name:?}, {}),", hex(value)));
        }
        lines.push("        ],".to_owned());
        lines.push("    },".to_owned());
    }
    lines.push("];".to_owned());
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

/// `build` numbers breadth-first, so how many workers listed a tree cannot show in
/// what it makes.
#[test]
fn one_worker_and_eight_build_the_same_store() -> TestResult {
    let mut problems = Vec::new();
    for run in runs()? {
        match (&run.one, &run.eight) {
            (Ok(one), Ok(eight)) => {
                let moved = moved_between(one, eight);
                if !moved.is_empty() {
                    problems.push(format!(
                        "{}: 1 worker and 8 differ in {}",
                        run.fixture,
                        moved.join(", ")
                    ));
                }
            }
            (Err(why), _) => problems.push(format!("{} at 1 worker: {why}", run.fixture)),
            (Ok(_), Err(why)) => problems.push(format!("{} at 8 workers: {why}", run.fixture)),
        }
    }
    if problems.is_empty() {
        return Ok(());
    }
    Err(Failure(format!(
        "the number of workers changed what build makes:\n  {}",
        problems.join("\n  ")
    )))
}

/// What `build(take())` makes of every fixture equals the recorded table.
#[test]
fn every_store_equals_its_recorded_digests() -> TestResult {
    let runs = runs()?;
    let mut problems = Vec::new();
    for run in runs {
        match &run.one {
            Ok(now) => problems.extend(against_recorded(run.fixture, now)),
            Err(why) => problems.push(format!("{} at 1 worker: {why}", run.fixture)),
        }
    }
    for recorded in RECORDED {
        if !runs.iter().any(|run| run.fixture == recorded.fixture) {
            problems.push(format!(
                "{}: recorded, but no fixture has the name",
                recorded.fixture
            ));
        }
        if RECORDED
            .iter()
            .filter(|r| r.fixture == recorded.fixture)
            .count()
            > 1
        {
            problems.push(format!("{}: recorded more than once", recorded.fixture));
        }
    }
    if problems.is_empty() {
        return Ok(());
    }
    Err(Failure(format!(
        "what build(take()) makes moved from the recorded table:\n  {}\n\n\
         If every move is intended, replace RECORDED at the end of \
         crates/tm-store/tests/digest_lock.rs with:\n\n{}\n",
        problems.join("\n  "),
        render(runs)
    )))
}

/// T6: a walk that numbers each listing as one block under a commit lock builds the
/// recorded store too, at 1 worker and at 8 — `build(Blocks output)` equals
/// `build(Discovery output)` column for column, since both equal the table.
#[test]
fn block_numbering_builds_the_recorded_store_at_one_worker_and_eight() -> TestResult {
    let mut problems = Vec::new();
    for run in runs()? {
        for (workers, digest) in [(1, &run.blocks_one), (8, &run.blocks_eight)] {
            match digest {
                Ok(now) => problems.extend(
                    against_recorded(run.fixture, now)
                        .into_iter()
                        .map(|moved| format!("blocks at {workers} worker(s): {moved}")),
                ),
                Err(why) => problems.push(format!(
                    "{} in blocks at {workers} worker(s): {why}",
                    run.fixture
                )),
            }
        }
    }
    if problems.is_empty() {
        return Ok(());
    }
    Err(Failure(format!(
        "block numbering changed what build makes:\n  {}",
        problems.join("\n  ")
    )))
}

// ---------------------------------------------------------------------------
// The fixtures hold what they claim
// ---------------------------------------------------------------------------

fn lossy(name: &[u8]) -> Vec<u8> {
    String::from_utf8_lossy(name).into_owned().into_bytes()
}

/// Where `path` comes breadth-first over listings sorted by its names, raw or stored:
/// its depth, then its names from the root (Lemma 3).
fn breadth_first_key(path: &[&[u8]], stored: bool) -> (usize, Vec<Vec<u8>>) {
    let names = path
        .iter()
        .map(|name| if stored { lossy(name) } else { name.to_vec() })
        .collect();
    (path.len(), names)
}

/// `path` as a string, as Node holds it.
fn joined(path: &[&[u8]]) -> String {
    let names: Vec<String> = path
        .iter()
        .map(|name| String::from_utf8_lossy(name).into_owned())
        .collect();
    names.join("/")
}

fn children(store: &Store, id: usize) -> Range<usize> {
    let first = store
        .child_start
        .as_slice()
        .get(id)
        .map_or(0, |&s| s as usize);
    let count = store
        .child_cnt
        .as_slice()
        .get(id)
        .map_or(0, |&c| c as usize);
    first..first + count
}

fn name_at(store: &Store, id: usize) -> &[u8] {
    let off = store.name_off.as_slice();
    match (off.get(id), off.get(id + 1)) {
        (Some(&a), Some(&b)) => store.names.as_slice().get(a as usize..b as usize),
        _ => None,
    }
    .unwrap_or_default()
}

/// Row `id`'s size as the shortest text that reads back as the same double.
fn size_at(store: &Store, id: usize) -> String {
    store
        .size
        .as_slice()
        .get(id)
        .map_or_else(|| "no row".to_owned(), f64::to_string)
}

/// The store id at `path` under the root, found by stored names.
fn store_id(store: &Store, path: &[&[u8]]) -> Option<usize> {
    path.iter().try_fold(0, |id, name| {
        let stored = lossy(name);
        children(store, id).find(|&child| name_at(store, child) == stored.as_slice())
    })
}

/// The family's first member in listing order (the member today's walk numbers first),
/// its first breadth-first and its smallest path are three names, and the store keeps
/// the bytes at the breadth-first one: the member the walk-order-first rule, a
/// last-member rule and a smallest-path rule would each get wrong.
#[test]
fn the_cross_folder_family_keeps_its_bytes_at_its_first_member_breadth_first() -> Result<(), String>
{
    let listing_first = FAMILY
        .iter()
        .min_by_key(|path| breadth_first_key(path, false));
    let store_first = FAMILY
        .iter()
        .min_by_key(|path| breadth_first_key(path, true));
    let smallest = FAMILY.iter().min_by_key(|path| joined(path));
    let smallest_utf16 = FAMILY
        .iter()
        .min_by(|a, b| joined(a).encode_utf16().cmp(joined(b).encode_utf16()));
    assert_eq!(listing_first, Some(&LISTING_FIRST));
    assert_eq!(store_first, Some(&STORE_FIRST));
    assert_eq!(smallest, Some(&SMALLEST_PATH), "in UTF-8 byte order");
    assert_eq!(smallest_utf16, Some(&SMALLEST_PATH), "in UTF-16 order");

    let fixture = posix_fixture()?;
    for (workers, numbering) in [1, 8].into_iter().flat_map(|w| NUMBERINGS.map(|n| (w, n))) {
        let store = walk_and_build(&fixture, workers, numbering)?;
        for path in FAMILY {
            let id = store_id(&store, path)
                .ok_or_else(|| format!("{} is not in the store", joined(path)))?;
            let duplicate =
                store.flags.as_slice().get(id).copied().unwrap_or(0) & flag::HARDLINK_DUP != 0;
            let keeps = path == STORE_FIRST;
            let at = format!(
                "{} walked by {workers} worker(s), {numbering:?} numbering",
                joined(path)
            );
            assert_eq!(duplicate, !keeps, "{at}: the duplicate flag");
            let bytes = if keeps { FAMILY_BYTES } else { 0.0 };
            assert_eq!(size_at(&store, id), bytes.to_string(), "{at}: the size");
        }
    }
    Ok(())
}

/// A name the stored form changes is ordered by the stored form, in the root and in a
/// folder of exactly two; two names stored alike keep the listing's order.
#[test]
fn stored_names_order_each_folder_and_names_stored_alike_keep_the_listing_order()
-> Result<(), String> {
    assert!(EMOJI < INVALID, "the raw bytes sort a😀 first");
    assert!(
        lossy(INVALID).as_slice() < EMOJI,
        "the stored names sort a\u{FFFD} first"
    );
    for numbering in NUMBERINGS {
        stored_order_holds(&walk_and_build(&posix_fixture()?, 1, numbering)?)
            .map_err(|why| format!("{numbering:?} numbering: {why}"))?;
    }
    Ok(())
}

/// The store's own order in the root and in `pair`, and two names stored alike.
fn stored_order_holds(store: &Store) -> Result<(), String> {
    let root: Vec<&[u8]> = children(store, 0).map(|id| name_at(store, id)).collect();
    let stored = lossy(INVALID);
    let at = |name: &[u8]| root.iter().position(|&n| n == name);
    let (Some(invalid), Some(emoji)) = (at(&stored), at(EMOJI)) else {
        return Err(format!("the root holds {root:?}"));
    };
    assert!(invalid < emoji, "a\u{FFFD} is before a😀 in the store");

    let pair = store_id(store, &[b"pair"]).ok_or("no folder pair")?;
    let sizes: Vec<String> = children(store, pair).map(|id| size_at(store, id)).collect();
    assert_eq!(
        sizes,
        ["5", "6"],
        "c\u{FFFD} (5 bytes) is before c😀 (6 bytes)"
    );

    let alike = "x\u{FFFD}.txt".as_bytes();
    let sizes: Vec<String> = children(store, 0)
        .filter(|&id| name_at(store, id) == alike)
        .map(|id| size_at(store, id))
        .collect();
    assert_eq!(sizes, ["1", "2"], "x\\xF8.txt (1 byte), then x\\xF9.txt");
    Ok(())
}

/// On Unix the walk joins a folder's raw name onto its parent's path, where every other
/// host joins the name made lossy (`child_path`): both spellings must come to the key the
/// builder filed the folder under, or which folders a walk finds would depend on the host
/// (see `ScriptedTree::key_of`).
#[cfg(unix)]
#[test]
fn a_raw_name_and_its_lossy_spelling_find_the_same_folder() -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let tree = posix_tree()?;
    let root = Path::new(POSIX_ROOT);
    let stored = String::from_utf8_lossy(INVALID).into_owned();
    let raw = root.join(OsStr::from_bytes(INVALID));
    let lossy = root.join(&stored);
    assert_ne!(raw, lossy, "the two spellings are two paths");
    assert_eq!(tree.key_of(&raw), Some(stored.clone()), "the raw spelling");
    assert_eq!(tree.key_of(&lossy), Some(stored), "the lossy spelling");

    let mut buf = ListBuffer::new(0);
    tree.list(&raw, false, &mut buf)
        .map_err(|why| format!("the folder at its raw path: {why}"))?;
    let listed: Vec<&[u8]> = buf
        .listing
        .entries
        .iter()
        .map(|entry| buf.listing.name(entry))
        .collect();
    let expected: [&[u8]; 2] = [b"w.txt", b"y"];
    assert_eq!(listed, expected, "the listing is the folder's own");
    Ok(())
}

// ---------------------------------------------------------------------------
// The recorded table
// ---------------------------------------------------------------------------

/// One fixture's recorded digests.
struct Recorded {
    fixture: &'static str,
    n: u32,
    capacity: u32,
    columns: &'static [(&'static str, u64)],
}

const RECORDED: &[Recorded] = &[
    Recorded {
        fixture: "scripted-posix",
        n: 198,
        capacity: 262,
        columns: &[
            ("mode", 0xA8C7_F832_281A_39C5),
            ("parent", 0x5578_6CED_7FE3_B10B),
            ("size", 0x330D_3274_7902_516F),
            ("mtime", 0xBA82_7054_723A_FE00),
            ("atime", 0xED2F_BBD3_FFA3_605D),
            ("flags", 0xB638_A20E_53EA_F23F),
            ("ext", 0xCDCC_12F1_A7E4_1D02),
            ("container", 0x2436_E2BE_DBA3_7305),
            ("cloudProv", 0xAAF2_67BA_BE2E_2FEB),
            ("nameOff", 0x7FB1_3ADE_8DDC_3375),
            ("names", 0xBC8E_5C7D_B005_B3FC),
            ("childStart", 0xAAC6_1849_DFAB_CC14),
            ("childCnt", 0xDF27_9B7D_03A4_08C2),
            ("extDict", 0x9878_82F1_66BD_8E74),
            ("extOverflow", 0xA8C7_F832_281A_39C5),
            ("cloudCandidates", 0xE970_2D62_EE5E_AC5C),
            ("textCandidates", 0x3B9A_AFF8_143E_84A2),
            ("sparseTerms", 0xEB13_07AF_2FC2_99ED),
            ("counters", 0xA9D6_7513_951D_64F6),
            ("walkStats", 0x4F72_07F5_6309_6040),
        ],
    },
    Recorded {
        fixture: "scripted-windows",
        n: 64,
        capacity: 64,
        columns: &[
            ("mode", 0xA8C7_F832_281A_39C5),
            ("parent", 0x7BC0_0C24_AF0A_3640),
            ("size", 0xCF72_E7DF_ADE3_9461),
            ("mtime", 0xA28C_21C4_5F6E_5B5C),
            ("atime", 0xFC7B_0242_2D55_1FFD),
            ("flags", 0xD6D7_D8EA_2F80_8551),
            ("ext", 0x0A0D_ACC1_09C9_4F5C),
            ("container", 0x052C_9A20_370E_8705),
            ("cloudProv", 0x052C_9A20_370E_8705),
            ("nameOff", 0xCCBE_30AF_02B0_BB3B),
            ("names", 0x4499_8B8B_75D3_DAAC),
            ("childStart", 0x8C21_0439_768B_0C31),
            ("childCnt", 0xE499_F553_2790_C448),
            ("extDict", 0x3AC6_2B86_D751_A2F0),
            ("extOverflow", 0xA8C7_F832_281A_39C5),
            ("cloudCandidates", 0x7B78_2E53_06EA_F216),
            ("textCandidates", 0x7B0D_786A_4DC3_DFCA),
            ("sparseTerms", 0xA8C7_F832_281A_39C5),
            ("counters", 0x68FE_055C_C840_BC2D),
            ("walkStats", 0x030E_E810_5B19_CB04),
        ],
    },
    Recorded {
        fixture: "scripted-wide",
        n: 69_613,
        capacity: 70_613,
        columns: &[
            ("mode", 0xA8C7_F832_281A_39C5),
            ("parent", 0x5DDE_0BFA_1A98_0678),
            ("size", 0x41C8_9888_506D_D4A4),
            ("mtime", 0xEA44_99A7_2FED_053B),
            ("atime", 0xA8C7_F832_281A_39C5),
            ("flags", 0x7539_0E23_81D7_4C04),
            ("ext", 0x635E_2834_129F_2BAB),
            ("container", 0xDD92_549E_8656_441C),
            ("cloudProv", 0xDD92_549E_8656_441C),
            ("nameOff", 0x3026_A1BA_221E_9984),
            ("names", 0x5B76_EFB8_F18F_3CFC),
            ("childStart", 0xA228_AAA3_4E54_E5AE),
            ("childCnt", 0x78E6_003E_A22F_9E72),
            ("extDict", 0xED1A_F87D_DE8E_CF5C),
            ("extOverflow", 0x0F8C_07AE_0734_48AD),
            ("cloudCandidates", 0xA8C7_F832_281A_39C5),
            ("textCandidates", 0xA8C7_F832_281A_39C5),
            ("sparseTerms", 0xF2F3_F740_892F_AC02),
            ("counters", 0x444C_8778_40BB_8CDB),
            ("walkStats", 0x92CC_532F_A0C6_7994),
        ],
    },
    Recorded {
        fixture: "synthetic-developer-seed-1",
        n: 30_001,
        capacity: 34_097,
        columns: &[
            ("mode", 0xA8C7_F832_281A_39C5),
            ("parent", 0x8F0C_72FF_9CDA_CFF3),
            ("size", 0x9BFD_C525_BF57_5112),
            ("mtime", 0x469B_04B1_912F_5B26),
            ("atime", 0xA8C7_F832_281A_39C5),
            ("flags", 0xDB92_914F_4A1C_9EE8),
            ("ext", 0x7723_8832_3377_1B29),
            ("container", 0xB6AE_9458_A336_F069),
            ("cloudProv", 0xB6AE_9458_A336_F069),
            ("nameOff", 0x61FB_21FD_7134_378C),
            ("names", 0x39FE_2E14_901C_0F80),
            ("childStart", 0x3694_E2F6_A62C_AE26),
            ("childCnt", 0x25DB_4C5D_45D7_9A59),
            ("extDict", 0xD9A9_AF95_DAA3_FBAE),
            ("extOverflow", 0xA8C7_F832_281A_39C5),
            ("cloudCandidates", 0xA8C7_F832_281A_39C5),
            ("textCandidates", 0xA8C7_F832_281A_39C5),
            ("sparseTerms", 0xA8C7_F832_281A_39C5),
            ("counters", 0x9314_5FB5_C846_937A),
            ("walkStats", 0xB2CF_3479_EA6A_3CD3),
        ],
    },
    Recorded {
        fixture: "synthetic-developer-seed-2",
        n: 30_001,
        capacity: 34_097,
        columns: &[
            ("mode", 0xA8C7_F832_281A_39C5),
            ("parent", 0x931D_9C1C_1BFF_51D8),
            ("size", 0x0FCC_1A60_5EC4_0DF1),
            ("mtime", 0xCF5B_A135_0276_AC97),
            ("atime", 0xD744_5E1F_1E87_825E),
            ("flags", 0xF427_C536_547A_C103),
            ("ext", 0x7D60_7921_5485_983D),
            ("container", 0xB6AE_9458_A336_F069),
            ("cloudProv", 0xB6AE_9458_A336_F069),
            ("nameOff", 0x61FB_21FD_7134_378C),
            ("names", 0xDD5D_A889_7052_35AA),
            ("childStart", 0x25DF_647D_322E_640D),
            ("childCnt", 0x327D_DC9A_51AB_7319),
            ("extDict", 0x800E_29DE_6B1D_4290),
            ("extOverflow", 0xA8C7_F832_281A_39C5),
            ("cloudCandidates", 0xA8C7_F832_281A_39C5),
            ("textCandidates", 0xA8C7_F832_281A_39C5),
            ("sparseTerms", 0xA8C7_F832_281A_39C5),
            ("counters", 0xC9FF_80D1_5FDF_19A7),
            ("walkStats", 0xB2CF_3479_EA6A_3CD3),
        ],
    },
    Recorded {
        fixture: "synthetic-links-10pct",
        n: 30_001,
        capacity: 34_097,
        columns: &[
            ("mode", 0xA8C7_F832_281A_39C5),
            ("parent", 0x8F0C_72FF_9CDA_CFF3),
            ("size", 0xF37F_D81C_B0AE_7F8A),
            ("mtime", 0x5BEE_399B_9C4C_19C4),
            ("atime", 0xA8C7_F832_281A_39C5),
            ("flags", 0x2D87_195B_23FB_AE98),
            ("ext", 0x7723_8832_3377_1B29),
            ("container", 0xB6AE_9458_A336_F069),
            ("cloudProv", 0xB6AE_9458_A336_F069),
            ("nameOff", 0x61FB_21FD_7134_378C),
            ("names", 0x39FE_2E14_901C_0F80),
            ("childStart", 0x3694_E2F6_A62C_AE26),
            ("childCnt", 0x25DB_4C5D_45D7_9A59),
            ("extDict", 0xD9A9_AF95_DAA3_FBAE),
            ("extOverflow", 0xA8C7_F832_281A_39C5),
            ("cloudCandidates", 0xA8C7_F832_281A_39C5),
            ("textCandidates", 0xA8C7_F832_281A_39C5),
            ("sparseTerms", 0xA8C7_F832_281A_39C5),
            ("counters", 0xEDB0_D30B_5A16_C7D5),
            ("walkStats", 0xB2CF_3479_EA6A_3CD3),
        ],
    },
    Recorded {
        fixture: "synthetic-folders-33pct",
        n: 30_001,
        capacity: 34_097,
        columns: &[
            ("mode", 0xA8C7_F832_281A_39C5),
            ("parent", 0x728C_0F9A_C548_64BC),
            ("size", 0x857E_72D4_AFB6_94BF),
            ("mtime", 0x0570_7B24_CAFE_AA73),
            ("atime", 0x3F59_28CF_0378_A0B3),
            ("flags", 0xD510_1421_6644_3ADB),
            ("ext", 0xDAAE_DA17_6DAF_464C),
            ("container", 0xB6AE_9458_A336_F069),
            ("cloudProv", 0xB6AE_9458_A336_F069),
            ("nameOff", 0x61FB_21FD_7134_378C),
            ("names", 0x9E4E_3771_F8C1_5EA8),
            ("childStart", 0xC94E_058C_E7C4_9A19),
            ("childCnt", 0x768B_BD2D_1570_5877),
            ("extDict", 0x8BEC_574B_E8E6_87EC),
            ("extOverflow", 0xA8C7_F832_281A_39C5),
            ("cloudCandidates", 0xA8C7_F832_281A_39C5),
            ("textCandidates", 0xA8C7_F832_281A_39C5),
            ("sparseTerms", 0xA8C7_F832_281A_39C5),
            ("counters", 0x9BFC_3C02_6197_53D3),
            ("walkStats", 0x363F_D65A_0AAE_805C),
        ],
    },
    Recorded {
        fixture: "synthetic-folders-1pct",
        n: 30_001,
        capacity: 34_097,
        columns: &[
            ("mode", 0xA8C7_F832_281A_39C5),
            ("parent", 0x593B_9559_8CC9_E413),
            ("size", 0xA7FE_5B82_E354_17F4),
            ("mtime", 0x909A_B041_6CDA_E6E7),
            ("atime", 0xA8C7_F832_281A_39C5),
            ("flags", 0xD0D9_3FB4_638A_1FD8),
            ("ext", 0xA246_1012_22C9_AAE1),
            ("container", 0xB6AE_9458_A336_F069),
            ("cloudProv", 0xB6AE_9458_A336_F069),
            ("nameOff", 0x61FB_21FD_7134_378C),
            ("names", 0x4153_BD11_2EB1_05DF),
            ("childStart", 0x6380_AE86_5537_B548),
            ("childCnt", 0x9BC7_E0B8_6A38_7557),
            ("extDict", 0xFEAF_B8E8_269D_EFC6),
            ("extOverflow", 0xA8C7_F832_281A_39C5),
            ("cloudCandidates", 0xA8C7_F832_281A_39C5),
            ("textCandidates", 0xA8C7_F832_281A_39C5),
            ("sparseTerms", 0xA8C7_F832_281A_39C5),
            ("counters", 0x69B3_3B31_9FBC_D305),
            ("walkStats", 0x7026_61AD_7076_26DB),
        ],
    },
];

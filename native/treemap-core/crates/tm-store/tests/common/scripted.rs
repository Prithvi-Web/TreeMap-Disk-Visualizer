//! A file system in a table, listed through tm-walk's `Lister`: the scripted trees the
//! digest lock (`digest_lock.rs`, T4) records and the memory sink's tests walk. Moved out
//! of `digest_lock.rs` unchanged but for `pub` (T7a), so both walk the very same trees:
//! the digest lock's own table proves the move changed none of them.
#![allow(
    dead_code,
    reason = "each test binary uses its own part of the fixtures"
)]

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use tm_store::derive::ContainerRule;
use tm_walk::platform::{DirTimes, ListBuffer, Lister, Meta};
use tm_walk::{FLAG_DATALESS, FastPath, KIND_DIR, KIND_FILE, KIND_SYMLINK, Refusal};

// ---------------------------------------------------------------------------
// The scripted lister
// ---------------------------------------------------------------------------

/// One entry of a scripted listing: its name's bytes, as the OS would give them.
pub struct Scripted {
    name: Vec<u8>,
    meta: Meta,
}

/// A folder's listing, as the lister hands it over.
#[derive(Default)]
pub struct Listed {
    entries: Vec<Scripted>,
    /// Entries the OS refused (`EACCES`/`EPERM`): counted, not listed.
    denied: u64,
    /// Entries omitted for any other error.
    unreadable: u64,
    /// The folder's own times, read from the folder itself (Windows).
    own_times: Option<DirTimes>,
}

/// What listing a folder answers.
pub enum Folder {
    Listed(Listed),
    Refused(Refusal),
}

/// A file system in a table. Folders are found by their path under the root, each name
/// in lossy UTF-8 and `/` between them: the walk joins a raw name onto its parent's path
/// on POSIX and a lossy one on Windows, and both come to the same key.
pub struct ScriptedTree {
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
pub fn asked(meta: Meta, want_atime: bool) -> Meta {
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
    pub fn key_of(&self, path: &Path) -> Option<String> {
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
    pub fn entry(&self, key: &str) -> Option<&Scripted> {
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
pub const DEV: f64 = 16_777_234.0;
/// The block the scripted file systems allocate in.
pub const BLOCK: f64 = 4_096.0;
/// The first file id the builder hands out: every id a fixture gives by hand is below it,
/// or past 2^64.
pub const FIRST_INO: u128 = 1_000;
/// Bytes no scripted name holds, because hosts read them differently. `\` separates names
/// on Windows alone (`NAME_SEPARATORS` in tm-walk's `walk.rs`), so a folder so named
/// would be refused there and listed everywhere else; `:` after a letter starts a drive
/// on Windows, so joining such a name would replace the path it is joined to. Either
/// would make the table differ by host, so `Builder::put` refuses both.
pub const HOST_SENSITIVE: &[u8] = b"\\:";

/// Times that differ from entry to entry, so no column keeps its digest when rows move.
pub fn times(ino: u128) -> (f64, f64) {
    let step = f64::from(u32::try_from(ino % 1_000_000).unwrap_or(0));
    let mtime_ms = 1_600_000_000_000.0 + step * 1_000.5;
    (mtime_ms, mtime_ms + 86_400_000.25)
}

pub fn folder_meta(ino: u128) -> Meta {
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

pub fn file_meta(size: f64, alloc: f64, ino: u128, nlink: u32) -> Meta {
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
pub fn symlink(target_len: f64, ino: u128) -> Meta {
    Meta {
        kind: KIND_SYMLINK,
        ..file_meta(target_len, 0.0, ino, 1)
    }
}

/// `meta` with its data away from this disk.
pub fn dataless(meta: Meta) -> Meta {
    Meta {
        flags: FLAG_DATALESS,
        ..meta
    }
}

/// Whole blocks for `size` bytes.
pub fn blocks(size: f64) -> f64 {
    (size / BLOCK).ceil() * BLOCK
}

/// Builds a scripted tree folder by folder.
pub struct Builder {
    folders: HashMap<String, Folder>,
    files: HashMap<u128, Result<Meta, Refusal>>,
    next_ino: u128,
}

impl Builder {
    pub fn with_root() -> Self {
        let mut folders = HashMap::new();
        folders.insert(String::new(), Folder::Listed(Listed::default()));
        Self {
            folders,
            files: HashMap::new(),
            next_ino: FIRST_INO,
        }
    }

    pub fn ino(&mut self) -> u128 {
        self.next_ino += 1;
        self.next_ino
    }

    /// What reading the file with id `ino` answers (a hard-link family's re-read): its
    /// own facts, or the refusal.
    pub fn reads(&mut self, ino: u128, read: Result<Meta, Refusal>) {
        self.files.insert(ino, read);
    }

    pub fn listing(&mut self, key: &str) -> Result<&mut Listed, String> {
        match self.folders.get_mut(key) {
            Some(Folder::Listed(listed)) => Ok(listed),
            _ => Err(format!("no listed folder at {key:?}")),
        }
    }

    /// Adds `name` to `parent`'s listing; a name holding a byte of [`HOST_SENSITIVE`] is
    /// refused, so a fixture holding one fails to build rather than digest by host.
    pub fn put(&mut self, parent: &str, name: &[u8], meta: Meta) -> Result<(), String> {
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
    pub fn put_new(
        &mut self,
        parent: &str,
        name: &[u8],
        meta: fn(u128) -> Meta,
    ) -> Result<(), String> {
        let ino = self.ino();
        self.put(parent, name, meta(ino))
    }

    /// A file of `size` bytes in whole blocks.
    pub fn file(&mut self, parent: &str, name: &[u8], size: f64) -> Result<(), String> {
        let ino = self.ino();
        self.put(parent, name, file_meta(size, blocks(size), ino, 1))
    }

    /// A folder entry answered by `folder`; its key.
    pub fn folder(
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
    pub fn dir(&mut self, parent: &str, name: &[u8]) -> Result<String, String> {
        let ino = self.ino();
        self.folder(
            parent,
            name,
            folder_meta(ino),
            Folder::Listed(Listed::default()),
        )
    }

    /// The folder `name` in `parent`, made if it is not there yet; its key.
    pub fn dir_at(&mut self, parent: &str, name: &[u8]) -> Result<String, String> {
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
    pub fn refused(&mut self, parent: &str, name: &[u8], why: Refusal) -> Result<(), String> {
        let ino = self.ino();
        self.folder(parent, name, folder_meta(ino), Folder::Refused(why))
            .map(drop)
    }

    pub fn omitted(&mut self, key: &str, denied: u64, unreadable: u64) -> Result<(), String> {
        let listed = self.listing(key)?;
        listed.denied = denied;
        listed.unreadable = unreadable;
        Ok(())
    }

    pub fn own_times(&mut self, key: &str, mtime_ms: f64, atime_ms: f64) -> Result<(), String> {
        self.listing(key)?.own_times = Some(DirTimes { mtime_ms, atime_ms });
        Ok(())
    }

    pub fn finish(
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
pub const EMOJI: &[u8] = "a😀".as_bytes();
/// `a` and the byte 0xF8, which is no UTF-8: stored as `a\u{FFFD}`, which sorts before
/// `a😀` although the raw bytes sort after it.
pub const INVALID: &[u8] = b"a\xF8";
/// The cross-folder family's member that comes first in listing order (design §S.2,
/// Lemma 3): today's walk, one worker, numbers it first.
pub const LISTING_FIRST: &[&[u8]] = &[EMOJI, b"x"];
/// The member that comes first breadth-first in the store, which keeps the bytes.
pub const STORE_FIRST: &[&[u8]] = &[INVALID, b"y"];
/// The member with the smallest path.
pub const SMALLEST_PATH: &[&[u8]] = &[b"A", b"deep", b"z"];
pub const FAMILY: [&[&[u8]]; 3] = [LISTING_FIRST, STORE_FIRST, SMALLEST_PATH];
/// The family's file id, and its size.
pub const FAMILY_INO: u128 = 500;
pub const FAMILY_BYTES: f64 = 4_096.0;

pub const POSIX_ROOT: &str = "/t4/posix";

pub fn posix_tree() -> Result<ScriptedTree, String> {
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

pub const WINDOWS_ROOT: &str = "/t4/windows";

pub fn windows_tree() -> Result<ScriptedTree, String> {
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

pub const WIDE_ROOT: &str = "/t4/wide";
/// Files with an extension each: more than the dictionary's 65,534.
pub const WIDE_FILES: u32 = 65_600;
pub const SMALL_FOLDERS: u32 = 2_000;

pub fn wide_tree() -> Result<ScriptedTree, String> {
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

/// `detectContainerKind`'s rules in its order, with `CONTAINER_ID`'s numbers.
pub fn container_rules() -> Vec<ContainerRule> {
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

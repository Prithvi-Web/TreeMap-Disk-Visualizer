//! The platform listing behind one trait, [`Lister`]: given a directory, fill a
//! reusable [`ListBuffer`] with its entries and say which path did it, or say
//! why the directory was refused. macOS is [`darwin`] (with [`per_entry`] as
//! its fallback), Windows is [`windows`], Linux is [`linux`]; every other
//! platform is `unsupported`. [`synthetic`] is a scripted tree on every
//! platform, listed from a seed without touching a disk. The parsers of the
//! two cross platforms are portable and compiled everywhere so their
//! synthetic-buffer tests run here; only their calls are behind `cfg`. The
//! walk core never calls the OS directly, so a fake `Lister` drives it in
//! tests on every platform.

use std::ops::Range;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use crate::output::Refusal;
use crate::{DEFAULT_BUFFER_BYTES, FastPath, MAX_BUFFER_BYTES, MIN_BUFFER_BYTES, Probe, WalkError};

#[cfg(target_os = "macos")]
pub mod darwin;
pub mod linux;
#[cfg(target_os = "macos")]
pub mod per_entry;
pub mod synthetic;
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub mod unsupported;
pub mod windows;

/// Everything the listing knows about one entry besides its name. Times are
/// milliseconds computed as `sec * 1e3 + nsec / 1e6` without rounding (P3-6);
/// sizes and `dev` are doubles (P3-7); `ino` is exact, never a double.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Meta {
    /// [`crate::KIND_FILE`], [`crate::KIND_DIR`] or [`crate::KIND_SYMLINK`].
    pub kind: u8,
    /// [`crate::FLAG_DATALESS`] when the object's data is not local.
    pub flags: u8,
    /// Logical size; 0 for a directory or when withheld.
    pub size: f64,
    /// Allocated bytes; 0 for a directory or when withheld.
    pub alloc: f64,
    /// Modification time in ms; NaN when withheld.
    pub mtime_ms: f64,
    /// Access time in ms; NaN when not asked for or not returned.
    pub atime_ms: f64,
    /// The device id.
    pub dev: f64,
    /// The inode or file id, exact: `st_ino`, or on Windows the whole 128-bit
    /// file id. An identity, not a quantity — as a double, a reused NTFS
    /// record's id (its sequence number sits in bits 48..64) rounds into its
    /// neighbour's past 2^53, and ReFS ids can differ only above bit 64, so
    /// two files became one hard-link family (the pre-landing review of 23
    /// Sep 2026).
    pub ino: u128,
    /// Hard-link count; 0 for a directory (not a fact the walk records) or when withheld.
    pub nlink: u32,
    /// True when the file system withheld an attribute the walk needs; the
    /// entry is kept with the "unknown" values above and counted as unreadable.
    pub withheld: bool,
}

impl Meta {
    /// A `kind` whose every other fact is unknown.
    pub fn unknown(kind: u8) -> Self {
        Self {
            kind,
            flags: 0,
            size: 0.0,
            alloc: 0.0,
            mtime_ms: f64::NAN,
            atime_ms: f64::NAN,
            dev: 0.0,
            ino: 0,
            nlink: 0,
            withheld: true,
        }
    }
}

/// One listed entry: where its raw name lives in [`Listing::names`], and its facts.
#[derive(Clone, Debug)]
pub struct Entry {
    /// The name's byte range in [`Listing::names`], exactly as the OS gave it.
    pub name: Range<usize>,
    /// The facts.
    pub meta: Meta,
}

/// A directory's own times, read from the directory itself while it was
/// listed. Windows keeps a copy of each directory's times in its PARENT's
/// index and updates that copy lazily, so what the parent's listing reported
/// can be stale; these are what `lstat` — and so the legacy walker — reads.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DirTimes {
    /// Last write, in ms since the epoch, computed as `lstat` computes it.
    pub mtime_ms: f64,
    /// Last access, in ms since the epoch; NaN when the walk did not ask for it.
    pub atime_ms: f64,
}

/// One directory's entries, staged in a worker's reusable buffers. Names are
/// the OS bytes (the walk needs them to build child paths); the lossy UTF-8
/// form is produced once, when a name goes into the output arena.
#[derive(Debug, Default)]
pub struct Listing {
    /// The raw name bytes of every entry, back to back.
    pub names: Vec<u8>,
    /// The entries, in the order the OS returned them.
    pub entries: Vec<Entry>,
    /// Entries omitted because the OS refused their metadata (`EACCES`/`EPERM`).
    pub denied_entries: u64,
    /// Entries omitted for any other per-entry error (a vanished entry is not counted).
    pub unreadable_entries: u64,
    /// Indices of entries the file system reported as mount points. A bulk
    /// listing answers for the covered directory where `lstat` answers for the
    /// mounted volume's root, so the lister re-reads these with `fstatat`
    /// before the listing is handed on, and empties this list.
    pub mount_points: Vec<usize>,
    /// The listed directory's own times, when the platform read them from the
    /// directory itself (Windows); `None` where the parent's listing already
    /// reported each entry's own attributes (macOS, Linux).
    pub own_times: Option<DirTimes>,
    /// True once [`Listing::sort_by_name`] ordered the entries, as the POSIX
    /// listers and the synthetic one do; a Windows listing keeps its own order
    /// and leaves it false. Block numbering re-sorts only such a listing, by
    /// the names as they are stored ([`Listing::order_as_stored`]).
    pub sorted_by_name: bool,
}

impl Listing {
    /// Forgets the previous directory; keeps the allocations.
    pub fn clear(&mut self) {
        self.names.clear();
        self.mount_points.clear();
        self.entries.clear();
        self.denied_entries = 0;
        self.unreadable_entries = 0;
        self.own_times = None;
        self.sorted_by_name = false;
    }

    /// Forgets the previous directory and gives back what a big one left
    /// behind: at most `entries` entries' and `name_bytes` names' worth of room
    /// is kept, so one huge folder does not pin its listing's memory in a
    /// worker for the rest of the walk.
    pub fn shrink_to(&mut self, entries: usize, name_bytes: usize) {
        self.clear();
        self.entries.shrink_to(entries);
        self.names.shrink_to(name_bytes);
    }

    /// Puts a listing [`Listing::sort_by_name`] ordered by its raw bytes into
    /// the order of its names as they are stored (U+FFFD for each maximal
    /// invalid subpart): the order `tm-store`'s `breadth_first` and the Node
    /// ingest give each folder's children. The two orders differ only where a
    /// name is not UTF-8 (`a` + 0xF8 sorts after `a😀` raw and before it
    /// stored), so a listing whose every name is UTF-8 is left as it is; the
    /// sort is stable, so names stored alike keep their raw order. A listing in
    /// its own order (Windows) is never touched.
    pub fn order_as_stored(&mut self) {
        if !self.sorted_by_name {
            return;
        }
        let Self { names, entries, .. } = self;
        let name_of = |entry: &Entry| names.get(entry.name.clone()).unwrap_or(&[]);
        if entries
            .iter()
            .all(|entry| std::str::from_utf8(name_of(entry)).is_ok())
        {
            return;
        }
        entries.sort_by(|a, b| stored_cmp(name_of(a), name_of(b)));
    }

    /// Appends one entry.
    pub fn push(&mut self, name: &[u8], meta: Meta) {
        let start = self.names.len();
        self.names.extend_from_slice(name);
        self.entries.push(Entry {
            name: start..self.names.len(),
            meta,
        });
    }

    /// The raw name bytes of `entry`.
    pub fn name(&self, entry: &Entry) -> &[u8] {
        self.names.get(entry.name.clone()).unwrap_or(&[])
    }

    /// Orders the entries by their raw name bytes, as `strcmp` would — the
    /// order libuv's `scandir` gives the legacy walker on macOS and Linux, so
    /// their listers call it last and the walk numbers entries in the legacy
    /// walker's order, leaving the ingest's own sort (kept for modules built
    /// before this) its best case. Windows' listers do not: there libuv keeps
    /// the file system's order, and so does the legacy walker. The order is a
    /// lister's, never the host's — a Windows-shaped listing walked on another
    /// host (tm-mft's tests) keeps its own. Names within one directory are
    /// unique, so the unstable sort is exact. Call it once
    /// [`Listing::mount_points`], which holds indices into the entries, is empty.
    pub fn sort_by_name(&mut self) {
        let Self {
            names,
            entries,
            sorted_by_name,
            ..
        } = self;
        entries.sort_unstable_by(|a, b| {
            let a = names.get(a.name.clone()).unwrap_or(&[]);
            let b = names.get(b.name.clone()).unwrap_or(&[]);
            a.cmp(b)
        });
        *sorted_by_name = true;
    }

    /// How many entries were listed.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True when the directory had no entries.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// U+FFFD as UTF-8: what a name's stored form holds for each maximal invalid subpart.
const REPLACEMENT: &[u8] = "\u{FFFD}".as_bytes();

/// The bytes of `raw`'s stored form, in order, without building it: each
/// chunk's valid part, then U+FFFD when the chunk ends in an invalid subpart —
/// exactly `String::from_utf8_lossy`'s output, which reads the same chunks.
fn stored_bytes(raw: &[u8]) -> impl Iterator<Item = u8> + '_ {
    raw.utf8_chunks().flat_map(|chunk| {
        let replaced: &[u8] = if chunk.invalid().is_empty() {
            &[]
        } else {
            REPLACEMENT
        };
        chunk.valid().bytes().chain(replaced.iter().copied())
    })
}

/// How `a` and `b` compare as stored: their `String::from_utf8_lossy` forms
/// byte by byte, without allocating either.
pub fn stored_cmp(a: &[u8], b: &[u8]) -> std::cmp::Ordering {
    stored_bytes(a).cmp(stored_bytes(b))
}

/// How many bytes `raw` takes as stored.
pub fn stored_len(raw: &[u8]) -> usize {
    raw.utf8_chunks()
        .map(|chunk| {
            let replaced = if chunk.invalid().is_empty() {
                0
            } else {
                REPLACEMENT.len()
            };
            chunk.valid().len() + replaced
        })
        .sum()
}

/// Appends `raw`'s stored form to `out`.
pub fn push_stored(out: &mut Vec<u8>, raw: &[u8]) {
    for chunk in raw.utf8_chunks() {
        out.extend_from_slice(chunk.valid().as_bytes());
        if !chunk.invalid().is_empty() {
            out.extend_from_slice(REPLACEMENT);
        }
    }
}

/// A worker's buffers: the platform's raw listing buffer, allocated once and
/// reused for every directory, and the staged [`Listing`].
#[derive(Debug)]
pub struct ListBuffer {
    /// The bulk listing buffer (`getattrlistbulk` writes into it).
    pub raw: Vec<u8>,
    /// The staged entries of the current directory.
    pub listing: Listing,
    /// The walk's cancel flag: a listing loop that sees it set returns between
    /// two batches instead of issuing the next call, so a cancel does not wait
    /// for a huge directory to finish listing.
    pub stop: Arc<AtomicBool>,
    /// Bumped once per batch the OS answered, across every worker: the caller
    /// can tell a directory that is listing slowly from a call that never
    /// returned, which the entry count alone cannot (entries are counted only
    /// once a directory's listing is complete).
    pub heartbeat: Arc<AtomicU64>,
}

impl ListBuffer {
    /// A buffer of `buffer_bytes` (0 = [`DEFAULT_BUFFER_BYTES`], clamped to
    /// [`MIN_BUFFER_BYTES`]..=[`MAX_BUFFER_BYTES`]) with signals nobody else
    /// holds — a probe's, or a test's.
    pub fn new(buffer_bytes: usize) -> Self {
        Self::with_signals(
            buffer_bytes,
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicU64::new(0)),
        )
    }

    /// A buffer whose `stop` and `heartbeat` are the walk's own, shared by
    /// every worker.
    pub fn with_signals(
        buffer_bytes: usize,
        stop: Arc<AtomicBool>,
        heartbeat: Arc<AtomicU64>,
    ) -> Self {
        let bytes = if buffer_bytes == 0 {
            DEFAULT_BUFFER_BYTES
        } else {
            buffer_bytes.clamp(MIN_BUFFER_BYTES, MAX_BUFFER_BYTES)
        };
        Self {
            raw: vec![0; bytes],
            listing: Listing::default(),
            stop,
            heartbeat,
        }
    }

    /// True once the walk was cancelled: stop between batches.
    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::Acquire)
    }

    /// One more batch answered by the OS.
    pub fn beat(&self) {
        self.heartbeat.fetch_add(1, Ordering::AcqRel);
    }
}

/// A platform's listing. Implemented for macOS in [`darwin`], Windows in
/// [`windows`] and Linux in [`linux`]; tests script their own.
pub trait Lister: Send + Sync {
    /// The facts about `path` itself, without following a final symlink
    /// (used for the root, at the start and again at the end).
    fn stat_dir(&self, path: &Path, want_atime: bool) -> Result<Meta, Refusal>;

    /// Lists `dir` into `buf.listing` (cleared first) and returns the path that
    /// did it, or the refusal.
    fn list(&self, dir: &Path, want_atime: bool, buf: &mut ListBuffer)
    -> Result<FastPath, Refusal>;
}

/// The lister for this platform, or [`WalkError::Unsupported`] naming the platform.
pub fn platform_lister() -> Result<Arc<dyn Lister>, WalkError> {
    #[cfg(target_os = "macos")]
    {
        Ok(Arc::new(darwin::DarwinLister::new()))
    }
    #[cfg(target_os = "linux")]
    {
        Ok(Arc::new(linux::LinuxLister::new()))
    }
    #[cfg(windows)]
    {
        Ok(Arc::new(windows::WindowsLister::new()))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        Err(WalkError::Unsupported(unsupported::reason()))
    }
}

/// [`crate::probe`] on this platform.
pub fn platform_probe(root: &Path) -> Probe {
    #[cfg(target_os = "macos")]
    {
        darwin::probe(root)
    }
    #[cfg(target_os = "linux")]
    {
        linux::probe(root)
    }
    #[cfg(windows)]
    {
        windows::probe(root)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        unsupported::probe(root)
    }
}

/// Whether `path`'s data is on this disk, asked of its directory entry and
/// never by opening it — opening a cloud placeholder makes its sync client
/// download it (RISKS R71). macOS reads `lstat`'s flags for `SF_DATALESS`;
/// Windows the attributes and reparse tag `FindFirstFileExW` reports, through
/// the walk's own `windows::is_dataless`; elsewhere no file system keeps data
/// away, so an entry that exists is local. An error when the entry cannot be
/// asked about: it vanished, or on Windows its name holds a character the
/// search would read as a pattern.
pub fn data_is_local(path: &Path) -> std::io::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        darwin::data_is_local(path)
    }
    #[cfg(windows)]
    {
        windows::data_is_local(path)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        std::fs::symlink_metadata(path).map(|_| true)
    }
}

/// The machine's performance cores, where its cores come in more than one
/// performance level (Apple silicon: `hw.perflevel0.logicalcpu` while
/// `hw.nperflevels` is at least 2). `None` everywhere else, and wherever the
/// OS does not say.
pub fn performance_cores() -> Option<u32> {
    #[cfg(target_os = "macos")]
    {
        darwin::performance_cores()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Milliseconds from a `timespec`, exactly as Node computes `mtimeMs`:
/// `sec * 1e3 + nsec / 1e6`, no rounding (decision P3-6).
pub fn time_ms(sec: i64, nsec: i64) -> f64 {
    (sec as f64) * 1e3 + (nsec as f64) / 1e6
}

/// The legacy walker's classification of an errno.
#[cfg(unix)]
pub fn refusal_from_errno(errno: i32) -> Refusal {
    match errno {
        libc::EACCES | libc::EPERM => Refusal::Denied,
        libc::ENOENT | libc::ENOTDIR => Refusal::Vanished,
        _ => Refusal::Unreadable,
    }
}

/// The calling thread's last OS error number (`EIO` if none is recorded).
#[cfg(unix)]
pub fn last_errno() -> i32 {
    std::io::Error::last_os_error()
        .raw_os_error()
        .unwrap_or(libc::EIO)
}

/// Makes `call` again for as long as it fails with `EINTR`, and returns
/// anything else — success or another errno — at once. A signal that lands
/// while a worker is inside `open`, `getattrlistbulk`, `getdents64`, `statx`
/// or `fstatat` says nothing about the file; counted as an error, it would
/// record a readable directory as unreadable and drop its subtree because of
/// when a signal arrived.
#[cfg(unix)]
pub fn retry_eintr<T>(mut call: impl FnMut() -> Result<T, i32>) -> Result<T, i32> {
    loop {
        match call() {
            Err(libc::EINTR) => {}
            other => return other,
        }
    }
}

/// The calling thread's own CPU time in seconds: `CLOCK_THREAD_CPUTIME_ID` on
/// Unix, `GetThreadTimes` on Windows; NaN where the platform has no thread clock.
pub fn thread_cpu_seconds() -> f64 {
    #[cfg(windows)]
    {
        windows::thread_cpu_seconds()
    }
    #[cfg(unix)]
    {
        // SAFETY: all-zero is a valid `timespec`.
        let mut ts: libc::timespec = unsafe { std::mem::zeroed() };
        // SAFETY: `ts` is a writable timespec and the clock id is valid on this platform.
        let rc = unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &raw mut ts) };
        if rc != 0 {
            return f64::NAN;
        }
        (ts.tv_sec as f64) + (ts.tv_nsec as f64) / 1e9
    }
    #[cfg(not(any(unix, windows)))]
    {
        f64::NAN
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Names whose stored forms test every way a chunk can end: empty, valid,
    /// a lone invalid byte, a truncated sequence, surrogates, past U+10FFFF,
    /// an invalid byte before an ASCII separator, and two raw names stored alike.
    const CORPUS: &[&[u8]] = &[
        b"",
        b"a",
        b"A",
        b"a-",
        b"a\xF8",
        "a\u{1F600}".as_bytes(),
        b"\xF0\x9F\x98",
        b"\xF0\x9F\x98\x80",
        b"x\xF8.txt",
        b"x\xF9.txt",
        b"\xE2/",
        b"\xFF\xFE",
        b"ab\xC3",
        b"\xC3\xA4",
        b"\xED\xA0\x80",
        b"\xF4\x90\x80\x80",
        "\u{FFFD}".as_bytes(),
    ];

    fn lossy(raw: &[u8]) -> Vec<u8> {
        String::from_utf8_lossy(raw).into_owned().into_bytes()
    }

    fn listing(names: &[&[u8]]) -> Listing {
        let mut listing = Listing::default();
        for name in names {
            listing.push(name, Meta::unknown(crate::KIND_FILE));
        }
        listing
    }

    fn order(listing: &Listing) -> Vec<Vec<u8>> {
        listing
            .entries
            .iter()
            .map(|entry| listing.name(entry).to_vec())
            .collect()
    }

    #[test]
    fn a_stored_name_is_exactly_what_from_utf8_lossy_makes() {
        for &a in CORPUS {
            let mut out = Vec::new();
            push_stored(&mut out, a);
            assert_eq!(out, lossy(a), "{a:?}");
            assert_eq!(stored_len(a), lossy(a).len(), "{a:?}");
            for &b in CORPUS {
                assert_eq!(stored_cmp(a, b), lossy(a).cmp(&lossy(b)), "{a:?} vs {b:?}");
            }
        }
    }

    #[test]
    fn a_name_sorted_listing_is_reordered_by_its_stored_names_only_when_one_is_not_utf8() {
        let emoji = "a\u{1F600}".as_bytes();
        let mut mixed = listing(&[b"b", b"a\xF8", emoji, b"x\xF9.txt", b"x\xF8.txt"]);
        mixed.sort_by_name();
        assert_eq!(
            order(&mixed),
            [emoji, b"a\xF8", b"b", b"x\xF8.txt", b"x\xF9.txt"],
            "raw bytes first"
        );
        mixed.order_as_stored();
        assert_eq!(
            order(&mixed),
            [b"a\xF8", emoji, b"b", b"x\xF8.txt", b"x\xF9.txt"],
            "stored: a\u{FFFD} before a\u{1F600}; the two stored alike keep their raw order"
        );

        let mut own_order = listing(&[b"b", emoji, b"a\xF8"]);
        own_order.order_as_stored();
        assert_eq!(
            order(&own_order),
            [b"b", emoji, b"a\xF8"],
            "a listing in its own order (Windows) is never touched"
        );
    }

    #[test]
    fn the_stored_order_keeps_the_raw_order_of_names_stored_alike_in_a_big_listing() {
        // Fifty groups of twenty raw names stored alike (`gNN` and one lone
        // continuation byte, each stored `gNN` U+FFFD), each group's valid
        // `gNNé` after it raw and before it stored: the re-sort must move every
        // `é` name and keep each group in its raw order. Small slices and runs
        // already in order sort stably even unstably, so it takes a listing
        // this size, out of order, to tell the two apart.
        let mut names: Vec<Vec<u8>> = Vec::new();
        for group in 0..50_u8 {
            for byte in 0x80..0x94_u8 {
                names.push([format!("g{group:02}").as_bytes(), &[byte]].concat());
            }
            names.push(format!("g{group:02}\u{e9}").into_bytes());
        }
        let refs: Vec<&[u8]> = names.iter().map(Vec::as_slice).collect();
        let mut big = listing(&refs);
        big.sort_by_name();
        let mut expected = order(&big);
        // The oracle: the raw order, stable-sorted by `from_utf8_lossy`.
        expected.sort_by_key(|name| lossy(name));
        big.order_as_stored();
        assert_eq!(order(&big), expected);
    }

    #[test]
    fn clearing_a_listing_forgets_that_it_was_sorted() {
        let mut listed = listing(&[b"b", b"a"]);
        listed.sort_by_name();
        assert!(listed.sorted_by_name);
        listed.clear();
        assert!(
            !listed.sorted_by_name,
            "the next folder's order is its lister's to say"
        );
    }

    #[test]
    fn shrinking_a_listing_gives_back_what_a_big_folder_took() {
        let names: Vec<Vec<u8>> = (0..5_000)
            .map(|i| format!("n{i:05}").into_bytes())
            .collect();
        let refs: Vec<&[u8]> = names.iter().map(Vec::as_slice).collect();
        let mut big = listing(&refs);
        assert!(big.entries.capacity() >= 5_000);
        big.shrink_to(100, 1_000);
        assert!(big.is_empty(), "forgotten");
        assert_eq!(big.entries.capacity(), 100);
        assert_eq!(big.names.capacity(), 1_000);
    }
}

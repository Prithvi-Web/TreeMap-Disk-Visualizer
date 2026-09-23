//! M5, the MFT mode's proof: on a real NTFS volume, `read_volume` of a real
//! fixture equals `tm_walk`'s listing walk of the same root column for
//! column, once each directory's children are laid out canonically — and
//! each directory's children come out of both engines in the same order, the
//! directory index's (`$UpCase` collation), which is asserted on its own.
//!
//! Windows only, and CI's Windows runner is where it proves anything: the
//! runner is an administrator, which reading a volume needs. A developer's
//! unelevated run is told `NotElevated` and passes with the reason printed;
//! on GitHub Actions that skip is a failure, because there it would leave
//! the mode unproven. No other error skips.
//!
//! The fixture, under `std::env::temp_dir()`: nested directories and an
//! empty one; files of 0 bytes, of 100 (small enough to stay resident in its
//! record), of 5,000 and of 1 MiB + 17; names whose byte order is not their
//! NTFS order (`_`, mixed case, non-ASCII); a long name with spaces, which
//! NTFS gives an 8.3 alias (a DOS-namespace `$FILE_NAME` that must never be
//! an entry); a hard link made after the file's last write (correction 6);
//! a junction (`cmd /c mklink /J`, a leaf sized by its target); a sparse file
//! (`fsutil sparse setflag`, allocated far less than its size). The two
//! steps that need `fsutil` need an administrator: their failures are held
//! until the volume is known to be readable, and fail the test only then.
//!
//! The listing walk reads through the file system's cache, the MFT reader
//! reads the disk, where NTFS writes `$MFT`'s pages lazily: a fixture made a
//! moment ago can be missing, or stale, on disk. So the two walks are
//! repeated until they agree, for at most [`CONVERGE_WITHIN`]; a difference
//! still there then fails with the last one found.
#![cfg(windows)]

mod canon;

use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use canon::{Canonical, canonical, child_order, differences};
use tm_governor::{Budget, FakeSampler, FakeSignals, Governor, Preset};
use tm_mft::{MftError, read_volume};
use tm_walk::{KIND_DIR, KIND_FILE, KIND_SYMLINK, WalkOptions, WalkOutput};

type TestResult = Result<(), String>;

/// Small enough to stay resident in a 1 KiB record.
const TINY: u64 = 100;
const MID: u64 = 5_000;
/// 1 MiB + 17: non-resident, several clusters, a partial last one.
const BIG: u64 = 1_048_593;
const LINKED: u64 = 777;
/// Written into the sparse file before it is extended.
const SPARSE_HEAD: usize = 4096;
/// The sparse file's size.
const SPARSE_LEN: u64 = 4 * 1024 * 1024;
/// A long name with spaces: NTFS gives it an 8.3 alias.
const LONG_NAME: &str = "long name with spaces.txt";
/// That alias, the first of its kind in a new directory.
const SHORT_ALIAS: &str = "LONGNA~1.TXT";
const UNICODE_NAME: &str = "\u{fc}n\u{ef}c\u{f8}d\u{e9}-\u{540d}\u{524d}.txt";
/// How long the table on disk may take to catch up with the cache.
const CONVERGE_WITHIN: Duration = Duration::from_secs(120);
/// The pause between two tries.
const RETRY_EVERY: Duration = Duration::from_secs(2);
/// The most a listing walk of the fixture may take.
const WALK_WITHIN: Duration = Duration::from_secs(60);
/// The most one read of the whole volume's table may take: the runner's
/// system volume holds every file of its image, not only the fixture's.
const READ_WITHIN: Duration = Duration::from_secs(600);

/// The fixture's entries under the root, by path: `(kind, size)`, a size of
/// `None` where the size is the thing under proof (the junction's target
/// text, a directory's 0).
fn expected_entries() -> Vec<(String, u8, Option<u64>)> {
    let f = |path: &str, size: u64| (path.to_owned(), KIND_FILE, Some(size));
    let d = |path: &str| (path.to_owned(), KIND_DIR, None);
    vec![
        f("zero.bin", 0),
        f("tiny.txt", TINY),
        f("B mixed Case.txt", 11),
        f("_underscore.txt", 12),
        f(UNICODE_NAME, 13),
        f(LONG_NAME, 14),
        d("empty-dir"),
        d("a"),
        f("a/mid.bin", MID),
        f("a/linked.txt", LINKED),
        d("a/b"),
        f("a/b/big.bin", BIG),
        f("a/b/linked-too.txt", LINKED),
        d("a/b/c"),
        d("a/b/c/d"),
        f("a/b/c/d/deep.txt", 15),
        f("sparse.bin", SPARSE_LEN),
        ("junction".to_owned(), KIND_SYMLINK, None),
    ]
}

/// The root's children in NTFS index order: upper-cased, then compared unit
/// by unit — `_` (0x5F) after the letters, `Ü` (0xDC) after `_`; not the
/// names' byte order, where `B` and `_` come before `a`.
const ROOT_ORDER: [&str; 10] = [
    "a",
    "B mixed Case.txt",
    "empty-dir",
    "junction",
    LONG_NAME,
    "sparse.bin",
    "tiny.txt",
    "zero.bin",
    "_underscore.txt",
    UNICODE_NAME,
];

/// The fixture, removed however the test ends.
struct Fixture {
    root: PathBuf,
    /// The steps that need an administrator and failed: fatal once the
    /// volume turns out readable, which needs an administrator too.
    admin_failures: Vec<String>,
}

fn run(program: &str, args: &[&OsStr]) -> Result<(), String> {
    let out = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("{program} {args:?}: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(format!(
        "{program} {args:?} exited with {}: {} {}",
        out.status,
        String::from_utf8_lossy(&out.stdout).trim(),
        String::from_utf8_lossy(&out.stderr).trim()
    ))
}

impl Fixture {
    fn build() -> Result<Self, String> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let root = std::env::temp_dir().join(format!("tm-mft-live-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&root).map_err(|e| format!("mkdir {}: {e}", root.display()))?;
        let mut fx = Self {
            root,
            admin_failures: Vec::new(),
        };
        for (path, kind, size) in expected_entries() {
            if kind == KIND_DIR {
                fx.dir(&path)?;
            } else if kind == KIND_FILE && path != "sparse.bin" && path != "a/b/linked-too.txt" {
                fx.file(&path, size.unwrap_or(0))?;
            }
        }
        fx.sparse("sparse.bin")?;
        // Every write is done: the second name of the hard link now, or the
        // listing would report it from an index copy NTFS never refreshed
        // (correction 6).
        fs::hard_link(fx.path("a/linked.txt"), fx.path("a/b/linked-too.txt"))
            .map_err(|e| format!("hard link: {e}"))?;
        run(
            "cmd",
            &[
                OsStr::new("/c"),
                OsStr::new("mklink"),
                OsStr::new("/J"),
                fx.path("junction").as_os_str(),
                fx.path("a").as_os_str(),
            ],
        )?;
        fx.short_name(LONG_NAME, SHORT_ALIAS);
        Ok(fx)
    }

    fn path(&self, rel: &str) -> PathBuf {
        rel.split('/')
            .fold(self.root.clone(), |p, part| p.join(part))
    }

    fn dir(&self, rel: &str) -> Result<(), String> {
        let p = self.path(rel);
        fs::create_dir_all(&p).map_err(|e| format!("mkdir {}: {e}", p.display()))
    }

    /// `bytes` bytes written through one handle, flushed, closed.
    fn file(&self, rel: &str, bytes: u64) -> Result<(), String> {
        let p = self.path(rel);
        let bytes = usize::try_from(bytes).map_err(|e| e.to_string())?;
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let mut f = File::create(&p).map_err(|e| format!("create {}: {e}", p.display()))?;
        f.write_all(&vec![b'x'; bytes])
            .and_then(|()| f.sync_all())
            .map_err(|e| format!("write {}: {e}", p.display()))
    }

    /// A sparse file of [`SPARSE_LEN`] bytes holding [`SPARSE_HEAD`].
    fn sparse(&mut self, rel: &str) -> Result<(), String> {
        let p = self.path(rel);
        File::create(&p).map_err(|e| format!("create {}: {e}", p.display()))?;
        if let Err(e) = run(
            "fsutil",
            &[OsStr::new("sparse"), OsStr::new("setflag"), p.as_os_str()],
        ) {
            self.admin_failures.push(e);
        }
        let mut f = OpenOptions::new()
            .write(true)
            .open(&p)
            .map_err(|e| format!("open {}: {e}", p.display()))?;
        f.write_all(&[b's'; SPARSE_HEAD])
            .and_then(|()| f.set_len(SPARSE_LEN))
            .and_then(|()| f.sync_all())
            .map_err(|e| format!("write {}: {e}", p.display()))
    }

    /// Gives `rel` the 8.3 alias `alias` unless the volume made it already.
    fn short_name(&mut self, rel: &str, alias: &str) {
        if self.path(alias).exists() {
            return;
        }
        if let Err(e) = run(
            "fsutil",
            &[
                OsStr::new("file"),
                OsStr::new("setshortname"),
                self.path(rel).as_os_str(),
                OsStr::new(alias),
            ],
        ) {
            self.admin_failures.push(e);
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // `remove_dir_all` removes a junction without following it.
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// `tm_walk`'s listing walk of `root`, access times on, governed as its own
/// live test governs it.
fn listing_walk(root: &Path) -> Result<WalkOutput, String> {
    let governor = Arc::new(Governor::start(
        Budget {
            preset: Preset::Balanced,
            cpu_percent: None,
        },
        false,
        Box::new(FakeSampler::new(4)),
        Box::new(FakeSignals::default()),
    ));
    let mut opts = WalkOptions::new(root);
    opts.want_atime = true;
    let handle = tm_walk::start(opts, governor).map_err(|e| format!("the listing walk: {e}"))?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(handle.take());
    });
    rx.recv_timeout(WALK_WITHIN)
        .map_err(|_| format!("the listing walk did not end within {WALK_WITHIN:?}"))?
        .map_err(|e| format!("the listing walk: {e}"))
}

/// What one try came to.
enum Try {
    /// The volume could not be opened: the process is not elevated.
    NotElevated(MftError),
    /// The two walks, equal once canonical.
    Equal(Box<(WalkOutput, WalkOutput)>),
    /// Why they are not (yet).
    Differs(String),
}

/// `read_volume` of `root` on its own thread, so that a read that never
/// ends fails this test with a sentence rather than CI's step with a timeout.
fn read_within(root: &Path) -> Result<Result<WalkOutput, MftError>, String> {
    let root = root.to_path_buf();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(read_volume(&root, true));
    });
    rx.recv_timeout(READ_WITHIN)
        .map_err(|_| format!("read_volume did not end within {READ_WITHIN:?}"))
}

fn one_try(fx: &Fixture) -> Result<Try, String> {
    let mft = match read_within(&fx.root)? {
        Err(e @ MftError::NotElevated { .. }) => return Ok(Try::NotElevated(e)),
        Err(e) => return Ok(Try::Differs(format!("read_volume refused: {e}"))),
        Ok(out) => out,
    };
    let listing = listing_walk(&fx.root)?;
    let found = differences(&canonical(&mft)?, &canonical(&listing)?, 25);
    if found.is_empty() {
        return Ok(Try::Equal(Box::new((mft, listing))));
    }
    Ok(Try::Differs(found.join("\n")))
}

#[test]
fn the_mft_walk_equals_the_listing_walk_on_a_real_ntfs_volume() -> TestResult {
    let fixture = Fixture::build()?;
    let started = Instant::now();
    let mut tries = 0_u32;
    loop {
        tries += 1;
        let last = match one_try(&fixture)? {
            Try::NotElevated(e) => return not_elevated(&e),
            Try::Equal(walks) => return verify(&fixture, &walks.0, &walks.1, tries),
            Try::Differs(why) => why,
        };
        if started.elapsed() >= CONVERGE_WITHIN {
            return Err(format!(
                "after {tries} tries over {:?} the MFT walk still differs from the listing walk (fixture steps that failed: {:?}):\n{last}",
                started.elapsed(),
                fixture.admin_failures
            ));
        }
        thread::sleep(RETRY_EVERY);
    }
}

/// A developer's unelevated run passes with the reason; CI's cannot skip.
fn not_elevated(e: &MftError) -> TestResult {
    if std::env::var_os("GITHUB_ACTIONS").is_some_and(|v| v == "true") {
        return Err(format!(
            "{e} — but CI's Windows runner is an administrator: skipped there, the MFT mode would ship unproven"
        ));
    }
    println!("skipped, the process is not elevated: {e}");
    Ok(())
}

/// Once the walks agree: the admin-only fixture steps worked, the order is
/// the index's in both, and what they agree on is the fixture — every path,
/// kind and size it was made with, the link pair, the sparse allocation, no
/// 8.3 alias as an entry — so agreement on nothing cannot pass.
fn verify(fx: &Fixture, mft: &WalkOutput, listing: &WalkOutput, tries: u32) -> TestResult {
    if !fx.admin_failures.is_empty() {
        return Err(format!(
            "the volume was readable, so the process is elevated, yet a fixture step failed: {:?}",
            fx.admin_failures
        ));
    }
    let (mft_order, listing_order) = (child_order(mft)?, child_order(listing)?);
    if mft_order != listing_order {
        let first = mft_order
            .iter()
            .find(|(dir, kids)| listing_order.get(*dir) != Some(*kids));
        return Err(format!(
            "each engine emits its children in another order; first: {first:?} in the MFT walk, {:?} in the listing",
            first.and_then(|(dir, _)| listing_order.get(dir))
        ));
    }
    let root_order: Vec<String> = ROOT_ORDER.iter().map(|s| (*s).to_owned()).collect();
    if mft_order.get("") != Some(&root_order) {
        return Err(format!(
            "the root's children are {:?}, not in $UpCase order {root_order:?}",
            mft_order.get("")
        ));
    }
    fixture_facts(&canonical(mft)?)?;
    if !fx.path(SHORT_ALIAS).exists() {
        return Err(format!(
            "{LONG_NAME:?} has no 8.3 alias {SHORT_ALIAS}: the DOS-name rule went unexercised"
        ));
    }
    println!("the MFT walk equals the listing walk (try {tries})");
    Ok(())
}

fn fixture_facts(c: &Canonical) -> TestResult {
    let expected = expected_entries();
    let mut want: BTreeSet<String> = expected.iter().map(|e| e.0.clone()).collect();
    want.insert(String::new());
    let have: BTreeSet<String> = c.paths.iter().cloned().collect();
    if have != want {
        return Err(format!(
            "the walks agree on {have:?}, not the fixture {want:?} (an 8.3 alias as an entry, or an entry missing)"
        ));
    }
    let node = |path: &str| {
        c.paths
            .iter()
            .position(|p| p == path)
            .ok_or_else(|| format!("no {path:?}"))
    };
    let at = |v: &[u64], i: usize| v.get(i).copied().map(f64::from_bits);
    for (path, kind, size) in &expected {
        let i = node(path)?;
        if c.kind.get(i) != Some(kind) {
            return Err(format!("{path:?} is kind {:?}, not {kind}", c.kind.get(i)));
        }
        if let Some(size) = size {
            if c.size.get(i) != Some(&(*size as f64).to_bits()) {
                return Err(format!(
                    "{path:?} is {:?} bytes, not {size}",
                    at(&c.size, i)
                ));
            }
        }
    }
    let junction = node("junction")?;
    if at(&c.size, junction).is_none_or(|s| s <= 0.0) {
        return Err("the junction is not sized by its target".to_owned());
    }
    // A 100-byte file kept in its record: whatever allocation the two agree
    // on, one a cluster would hold means it was not resident, and the
    // resident branch went unexercised.
    let tiny = node("tiny.txt")?;
    if at(&c.alloc, tiny).is_none_or(|a| a >= 4096.0) {
        return Err(format!(
            "tiny.txt is allocated {:?}: not resident in its record",
            at(&c.alloc, tiny)
        ));
    }
    let sparse = node("sparse.bin")?;
    if at(&c.alloc, sparse).is_none_or(|a| a >= SPARSE_LEN as f64) {
        return Err(format!(
            "sparse.bin is allocated {:?} of its {SPARSE_LEN} bytes: not sparse",
            at(&c.alloc, sparse)
        ));
    }
    let (a, b) = (node("a/linked.txt")?, node("a/b/linked-too.txt")?);
    let linked: Vec<usize> = c.hardlinks.iter().map(|h| h.0).collect();
    let ids: BTreeSet<u64> = c.hardlinks.iter().map(|h| h.2).collect();
    if linked != [a, b] || ids.len() != 1 {
        return Err(format!(
            "the hard links are {:?}, not the pair {a} and {b} sharing one id",
            c.hardlinks
        ));
    }
    if !c.refusals.is_empty() || c.counts.entries != 18 || c.counts.dirs_listed != 6 {
        return Err(format!(
            "refusals {:?}, counters {:?}: not the fixture's 18 entries in 6 directories",
            c.refusals, c.counts
        ));
    }
    Ok(())
}

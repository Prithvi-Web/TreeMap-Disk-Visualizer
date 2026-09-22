//! The macOS listing: the `getattrlistbulk` parser on synthetic buffers (the
//! `RETURNED_ATTRS` rule, `ATTR_CMN_ERROR`, `SF_DATALESS`, a corrupt length),
//! the probe, the errno classification, the time formula, the buffer reuse, and
//! the internal consistency check: the real bulk listing and the per-entry
//! fallback must agree entry by entry on the same fixture directory.
#![cfg(target_os = "macos")]

use std::collections::BTreeMap;
use std::ffi::CString;
use std::fs;
use std::num::TryFromIntError;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use tm_walk::platform::darwin::{
    ATTR_CMN_ERROR, DarwinLister, SF_DATALESS, VDIR, VFIFO, VLNK, VREG, parse_batch,
};
use tm_walk::platform::{ListBuffer, Lister, Listing, Meta, refusal_from_errno, time_ms};
use tm_walk::{
    DEFAULT_BUFFER_BYTES, FLAG_DATALESS, FastPath, KIND_DIR, KIND_FILE, KIND_SYMLINK,
    MIN_BUFFER_BYTES, Refusal, probe, probe_with,
};

type TestResult = Result<(), String>;

/// Every common attribute the listing requests, atime included.
const ALL_COMMON: u32 = libc::ATTR_CMN_RETURNED_ATTRS
    | ATTR_CMN_ERROR
    | libc::ATTR_CMN_NAME
    | libc::ATTR_CMN_DEVID
    | libc::ATTR_CMN_OBJTYPE
    | libc::ATTR_CMN_MODTIME
    | libc::ATTR_CMN_ACCTIME
    | libc::ATTR_CMN_FLAGS
    | libc::ATTR_CMN_FILEID;
/// Every file attribute the listing requests.
const ALL_FILE: u32 =
    libc::ATTR_FILE_LINKCOUNT | libc::ATTR_FILE_ALLOCSIZE | libc::ATTR_FILE_DATALENGTH;
/// A device id like APFS reports for the boot volume.
const DEV: i32 = 16_777_234;
/// `UF_HIDDEN` from `<sys/stat.h>`: a flag that is not `SF_DATALESS`.
const UF_HIDDEN: u32 = 0x0000_8000;
/// Entries in the throughput fixture.
const MEASURE_ENTRIES: usize = 5_000;
/// Listings per method in the throughput measurement; the best is reported.
const MEASURE_RUNS: usize = 5;

/// One entry as the kernel would pack it, field by field.
struct Packed {
    common: u32,
    file: u32,
    error: u32,
    name: &'static [u8],
    objtype: u32,
    mtime: (i64, i64),
    atime: (i64, i64),
    flags: u32,
    fileid: u64,
    nlink: u32,
    alloc: i64,
    len: i64,
    /// The returned directory group (`ATTR_DIR_*`), packed between the common and the file group.
    dir: u32,
    mountstatus: u32,
}

fn regular(name: &'static [u8], len: i64) -> Packed {
    Packed {
        common: ALL_COMMON,
        file: ALL_FILE,
        dir: 0,
        mountstatus: 0,
        error: 0,
        name,
        objtype: VREG,
        mtime: (1_700_000_000, 123_456_789),
        atime: (1_700_000_100, 999_999),
        flags: 0,
        fileid: 4_242,
        nlink: 1,
        alloc: 4_096,
        len,
    }
}

/// Packs `e` the way `getattrlistbulk` does: a `u32` length, the returned
/// `attribute_set_t`, the error (only when its bit is returned), then the
/// attributes in bit order with the name as an `attrreference_t` whose data
/// follows the fixed part; everything 4-byte aligned, the group padded to 8.
fn pack(e: &Packed) -> Result<Vec<u8>, TryFromIntError> {
    let mut before_name = Vec::new();
    if e.common & ATTR_CMN_ERROR != 0 {
        before_name.extend_from_slice(&e.error.to_ne_bytes());
    }
    let mut after_name = Vec::new();
    if e.common & libc::ATTR_CMN_DEVID != 0 {
        after_name.extend_from_slice(&DEV.to_ne_bytes());
    }
    if e.common & libc::ATTR_CMN_OBJTYPE != 0 {
        after_name.extend_from_slice(&e.objtype.to_ne_bytes());
    }
    if e.common & libc::ATTR_CMN_MODTIME != 0 {
        after_name.extend_from_slice(&e.mtime.0.to_ne_bytes());
        after_name.extend_from_slice(&e.mtime.1.to_ne_bytes());
    }
    if e.common & libc::ATTR_CMN_ACCTIME != 0 {
        after_name.extend_from_slice(&e.atime.0.to_ne_bytes());
        after_name.extend_from_slice(&e.atime.1.to_ne_bytes());
    }
    if e.common & libc::ATTR_CMN_FLAGS != 0 {
        after_name.extend_from_slice(&e.flags.to_ne_bytes());
    }
    if e.common & libc::ATTR_CMN_FILEID != 0 {
        after_name.extend_from_slice(&e.fileid.to_ne_bytes());
    }
    if e.dir & libc::ATTR_DIR_MOUNTSTATUS != 0 {
        after_name.extend_from_slice(&e.mountstatus.to_ne_bytes());
    }
    if e.file & libc::ATTR_FILE_LINKCOUNT != 0 {
        after_name.extend_from_slice(&e.nlink.to_ne_bytes());
    }
    if e.file & libc::ATTR_FILE_ALLOCSIZE != 0 {
        after_name.extend_from_slice(&e.alloc.to_ne_bytes());
    }
    if e.file & libc::ATTR_FILE_DATALENGTH != 0 {
        after_name.extend_from_slice(&e.len.to_ne_bytes());
    }
    let header = 4 + 5 * 4;
    let name_ref_pos = header + before_name.len();
    let name_field = if e.common & libc::ATTR_CMN_NAME != 0 {
        8
    } else {
        0
    };
    let name_data_pos = name_ref_pos + name_field + after_name.len();
    let mut name_bytes = e.name.to_vec();
    name_bytes.push(0);
    while name_bytes.len() % 4 != 0 {
        name_bytes.push(0);
    }
    let mut total = name_data_pos + name_bytes.len();
    while total % 8 != 0 {
        total += 1;
    }
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&u32::try_from(total)?.to_ne_bytes());
    for group in [e.common, 0, e.dir, e.file, 0] {
        out.extend_from_slice(&group.to_ne_bytes());
    }
    out.extend_from_slice(&before_name);
    if name_field > 0 {
        let offset = i32::try_from(name_data_pos - name_ref_pos)?;
        out.extend_from_slice(&offset.to_ne_bytes());
        out.extend_from_slice(&u32::try_from(e.name.len() + 1)?.to_ne_bytes());
    }
    out.extend_from_slice(&after_name);
    out.extend_from_slice(&name_bytes);
    out.resize(total, 0);
    Ok(out)
}

fn buffer(entries: &[Packed]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    for e in entries {
        out.extend(pack(e).map_err(|e| e.to_string())?);
    }
    Ok(out)
}

fn parsed(entries: &[Packed], want_atime: bool) -> Result<Listing, String> {
    let raw = buffer(entries)?;
    let mut out = Listing::default();
    parse_batch(&raw, entries.len(), want_atime, &mut out).map_err(|e| format!("{e:?}"))?;
    Ok(out)
}

fn by_name(listing: &Listing) -> BTreeMap<Vec<u8>, Meta> {
    listing
        .entries
        .iter()
        .map(|e| (listing.name(e).to_vec(), e.meta))
        .collect()
}

fn entry<'a>(map: &'a BTreeMap<Vec<u8>, Meta>, name: &str) -> Result<&'a Meta, String> {
    map.get(name.as_bytes())
        .ok_or_else(|| format!("no entry {name:?}: {:?}", map.keys()))
}

// ---------------------------------------------------------------------------
// The parser on synthetic buffers
// ---------------------------------------------------------------------------

#[test]
fn parses_a_regular_entry_exactly() -> TestResult {
    let listing = parsed(&[regular(b"a.bin", 10)], true)?;
    assert_eq!(listing.entries.len(), 1);
    let map = by_name(&listing);
    let a = entry(&map, "a.bin")?;
    assert_eq!(a.kind, KIND_FILE);
    assert_eq!(a.flags, 0);
    assert_eq!(a.size.to_bits(), 10.0_f64.to_bits());
    assert_eq!(a.alloc.to_bits(), 4_096.0_f64.to_bits());
    assert_eq!(
        a.mtime_ms.to_bits(),
        time_ms(1_700_000_000, 123_456_789).to_bits()
    );
    assert_eq!(
        a.atime_ms.to_bits(),
        time_ms(1_700_000_100, 999_999).to_bits()
    );
    assert_eq!(a.dev.to_bits(), f64::from(DEV).to_bits());
    assert_eq!(a.ino.to_bits(), 4_242.0_f64.to_bits());
    assert_eq!(a.nlink, 1);
    assert!(!a.withheld);
    assert_eq!(listing.denied_entries, 0);
    assert_eq!(listing.unreadable_entries, 0);
    Ok(())
}

#[test]
fn honours_the_returned_attribute_set_per_entry() -> TestResult {
    let mut short = regular(b"two.bin", 22);
    short.common &= !libc::ATTR_CMN_MODTIME;
    short.file &= !libc::ATTR_FILE_DATALENGTH;
    let listing = parsed(
        &[regular(b"one.bin", 11), short, regular(b"three.bin", 33)],
        true,
    )?;
    assert_eq!(
        listing.entries.len(),
        3,
        "a withheld attribute keeps the entry"
    );
    let map = by_name(&listing);
    let two = entry(&map, "two.bin")?;
    assert!(
        two.mtime_ms.is_nan(),
        "withheld mtime is NaN, not a parsed neighbour"
    );
    assert_eq!(two.size.to_bits(), 0.0_f64.to_bits(), "withheld size is 0");
    assert_eq!(
        two.alloc.to_bits(),
        4_096.0_f64.to_bits(),
        "an attribute that was returned is read"
    );
    assert!(two.withheld, "the entry is marked so the walk counts it");
    assert_eq!(two.nlink, 1);
    let three = entry(&map, "three.bin")?;
    assert_eq!(
        three.size.to_bits(),
        33.0_f64.to_bits(),
        "the next entry is still parsed in place"
    );
    assert_eq!(
        three.mtime_ms.to_bits(),
        time_ms(1_700_000_000, 123_456_789).to_bits()
    );
    assert!(!three.withheld);
    assert!(!entry(&map, "one.bin")?.withheld);
    Ok(())
}

#[test]
fn an_atime_that_was_returned_but_not_wanted_is_skipped_not_misread() -> TestResult {
    let mut hidden = regular(b"h.bin", 5);
    hidden.flags = UF_HIDDEN;
    let listing = parsed(&[hidden], false)?;
    let map = by_name(&listing);
    let h = entry(&map, "h.bin")?;
    assert!(h.atime_ms.is_nan());
    assert_eq!(
        h.flags, 0,
        "UF_HIDDEN is not dataless; the flags field after atime was read in place"
    );
    assert_eq!(h.ino.to_bits(), 4_242.0_f64.to_bits());
    Ok(())
}

#[test]
fn a_withheld_name_drops_the_entry_as_unreadable() -> TestResult {
    let mut nameless = regular(b"ignored", 1);
    nameless.common &= !libc::ATTR_CMN_NAME;
    let listing = parsed(&[nameless, regular(b"next.bin", 2)], true)?;
    assert_eq!(listing.entries.len(), 1);
    assert_eq!(listing.unreadable_entries, 1);
    assert!(entry(&by_name(&listing), "next.bin").is_ok());
    Ok(())
}

#[test]
fn an_entry_error_omits_the_entry_and_is_classified_like_the_legacy_walker() -> TestResult {
    let mut denied = regular(b"denied.bin", 1);
    denied.error = u32::try_from(libc::EACCES).map_err(|e| e.to_string())?;
    let mut denied_too = regular(b"denied2.bin", 1);
    denied_too.error = u32::try_from(libc::EPERM).map_err(|e| e.to_string())?;
    let mut gone = regular(b"gone.bin", 1);
    gone.error = u32::try_from(libc::ENOENT).map_err(|e| e.to_string())?;
    let mut broken = regular(b"broken.bin", 1);
    broken.error = u32::try_from(libc::EIO).map_err(|e| e.to_string())?;
    let listing = parsed(
        &[denied, denied_too, gone, broken, regular(b"fine.bin", 9)],
        true,
    )?;
    assert_eq!(
        listing.entries.len(),
        1,
        "only the entry without an error survives"
    );
    assert_eq!(listing.denied_entries, 2, "EACCES and EPERM");
    assert_eq!(
        listing.unreadable_entries, 1,
        "EIO; a vanished entry costs nothing"
    );
    let map = by_name(&listing);
    let fine = entry(&map, "fine.bin")?;
    assert_eq!(fine.size.to_bits(), 9.0_f64.to_bits());
    Ok(())
}

#[test]
fn an_error_field_of_zero_is_no_error() -> TestResult {
    let listing = parsed(&[regular(b"ok.bin", 4)], true)?;
    assert_eq!(listing.entries.len(), 1);
    assert_eq!(listing.denied_entries + listing.unreadable_entries, 0);
    Ok(())
}

#[test]
fn maps_sf_dataless_to_flag_dataless() -> TestResult {
    let mut dataless = regular(b"cloud.bin", 100);
    dataless.flags = SF_DATALESS;
    dataless.alloc = 0;
    let mut hidden = regular(b"hidden.bin", 1);
    hidden.flags = UF_HIDDEN;
    let listing = parsed(&[dataless, hidden, regular(b"plain.bin", 1)], true)?;
    let map = by_name(&listing);
    assert_eq!(entry(&map, "cloud.bin")?.flags, FLAG_DATALESS);
    assert_eq!(entry(&map, "hidden.bin")?.flags, 0);
    assert_eq!(entry(&map, "plain.bin")?.flags, 0);
    Ok(())
}

#[test]
fn a_symlink_is_a_leaf_with_its_own_length() -> TestResult {
    let mut link = regular(b"link", 9);
    link.objtype = VLNK;
    let listing = parsed(&[link], true)?;
    let map = by_name(&listing);
    let l = entry(&map, "link")?;
    assert_eq!(l.kind, KIND_SYMLINK);
    assert_eq!(l.size.to_bits(), 9.0_f64.to_bits());
    assert!(!l.withheld);
    Ok(())
}

#[test]
fn a_directory_or_a_fifo_without_a_file_group_is_not_withheld_but_a_file_is() -> TestResult {
    let mut dir = regular(b"dir", 0);
    dir.objtype = VDIR;
    dir.file = 0;
    let mut fifo = regular(b"fifo", 0);
    fifo.objtype = VFIFO;
    fifo.file = 0;
    let mut file = regular(b"file.bin", 0);
    file.file = 0;
    let listing = parsed(&[dir, fifo, file], true)?;
    let map = by_name(&listing);
    let d = entry(&map, "dir")?;
    assert_eq!(d.kind, KIND_DIR);
    assert_eq!(d.size.to_bits(), 0.0_f64.to_bits());
    assert_eq!(d.alloc.to_bits(), 0.0_f64.to_bits());
    assert!(!d.withheld, "a directory has no file group to withhold");
    let f = entry(&map, "fifo")?;
    assert_eq!(f.kind, KIND_FILE);
    assert!(!f.withheld, "a fifo has no data fork");
    assert!(
        entry(&map, "file.bin")?.withheld,
        "a regular file without its sizes was withheld"
    );
    Ok(())
}

#[test]
fn a_directory_entry_ignores_a_file_group_it_was_given() -> TestResult {
    let mut dir = regular(b"dir", 640);
    dir.objtype = VDIR;
    let listing = parsed(&[dir, regular(b"after.bin", 3)], true)?;
    let map = by_name(&listing);
    assert_eq!(
        entry(&map, "dir")?.size.to_bits(),
        0.0_f64.to_bits(),
        "a directory's own size is not a fact the store keeps"
    );
    assert_eq!(entry(&map, "after.bin")?.size.to_bits(), 3.0_f64.to_bits());
    Ok(())
}

#[test]
fn a_directory_the_file_system_marks_as_a_mount_point_is_listed_for_a_second_look() -> TestResult {
    // getattrlistbulk answers for the covered directory, lstat for the mounted
    // volume's root; the lister re-reads a mount point with fstatat, so the
    // parser must say which entries are mount points.
    let mut mounted = regular(b"mnt", 0);
    mounted.objtype = VDIR;
    mounted.file = 0;
    mounted.dir = libc::ATTR_DIR_MOUNTSTATUS;
    mounted.mountstatus = libc::DIR_MNTSTATUS_MNTPOINT;
    let mut plain = regular(b"plain", 0);
    plain.objtype = VDIR;
    plain.file = 0;
    plain.dir = libc::ATTR_DIR_MOUNTSTATUS;
    plain.mountstatus = 0;
    let listing = parsed(&[regular(b"a.txt", 3), mounted, plain], true)?;
    assert_eq!(listing.entries.len(), 3);
    assert_eq!(
        listing.mount_points,
        vec![1],
        "only the entry with the mount-point bit"
    );
    let map = by_name(&listing);
    assert_eq!(entry(&map, "mnt")?.kind, KIND_DIR);
    assert_eq!(
        entry(&map, "plain")?.mtime_ms.to_bits(),
        time_ms(1_700_000_000, 123_456_789).to_bits(),
        "the group after the dir group still parses"
    );
    Ok(())
}

#[test]
fn rejects_a_corrupt_length() -> TestResult {
    let mut raw = buffer(&[regular(b"a.bin", 1)])?;
    let mut out = Listing::default();
    assert!(
        parse_batch(&raw, 2, true, &mut out).is_err(),
        "more entries than the buffer holds"
    );
    if let Some(first) = raw.first_mut() {
        *first = 0;
    }
    if let Some(second) = raw.get_mut(1) {
        *second = 0;
    }
    assert!(
        parse_batch(&raw, 1, true, &mut Listing::default()).is_err(),
        "a zero length cannot advance"
    );
    let mut huge = buffer(&[regular(b"a.bin", 1)])?;
    if let Some(hi) = huge.get_mut(3) {
        *hi = 0xFF;
    }
    assert!(
        parse_batch(&huge, 1, true, &mut Listing::default()).is_err(),
        "a length past the buffer"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

#[test]
fn time_ms_is_the_exact_node_formula() {
    let expected = 1_700_000_000_f64 * 1e3 + 123_456_789_f64 / 1e6;
    assert_eq!(
        time_ms(1_700_000_000, 123_456_789).to_bits(),
        expected.to_bits()
    );
    // No rounding: a sub-millisecond nanosecond count survives in the double.
    let fine = time_ms(1, 999_999);
    assert_eq!(fine.to_bits(), (1e3 + 0.999_999_f64).to_bits());
    assert_ne!(fine.to_bits(), fine.round().to_bits());
}

#[test]
fn refusal_from_errno_classifies_like_the_legacy_walker() {
    assert_eq!(refusal_from_errno(libc::EACCES), Refusal::Denied);
    assert_eq!(refusal_from_errno(libc::EPERM), Refusal::Denied);
    assert_eq!(refusal_from_errno(libc::ENOENT), Refusal::Vanished);
    assert_eq!(refusal_from_errno(libc::ENOTDIR), Refusal::Vanished);
    assert_eq!(refusal_from_errno(libc::EIO), Refusal::Unreadable);
    assert_eq!(refusal_from_errno(libc::ENOTSUP), Refusal::Unreadable);
    assert_eq!(refusal_from_errno(0), Refusal::Unreadable);
}

#[test]
fn the_listing_buffer_is_sized_once() {
    assert_eq!(
        ListBuffer::new(0).raw.len(),
        DEFAULT_BUFFER_BYTES,
        "zero means the default"
    );
    assert_eq!(
        ListBuffer::new(1).raw.len(),
        MIN_BUFFER_BYTES,
        "too small is raised to the minimum"
    );
    assert_eq!(ListBuffer::new(1 << 20).raw.len(), 1 << 20);
}

// ---------------------------------------------------------------------------
// Live: the real listing on a real fixture
// ---------------------------------------------------------------------------

struct Fixture {
    root: PathBuf,
}

/// Fixtures created by this test binary so far: tests run on parallel threads,
/// and two starting within the clock's resolution must not share a directory.
static FIXTURES: AtomicU64 = AtomicU64::new(0);

impl Fixture {
    fn new(tag: &str) -> Result<Self, String> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let serial = FIXTURES.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!(
            "tm-walk-darwin-{tag}-{}-{serial}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&root).map_err(|e| format!("mkdir {}: {e}", root.display()))?;
        Ok(Self { root })
    }

    fn file(&self, rel: &str, bytes: usize) -> Result<(), String> {
        let p = self.root.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        fs::write(&p, vec![b'y'; bytes]).map_err(|e| format!("write {}: {e}", p.display()))
    }

    fn fifo(&self, rel: &str) -> Result<(), String> {
        let p = self.root.join(rel);
        let c = CString::new(p.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        // SAFETY: `c` is a valid NUL-terminated path; mkfifo reads it and creates the node.
        let rc = unsafe { libc::mkfifo(c.as_ptr(), 0o644) };
        if rc == 0 {
            Ok(())
        } else {
            Err(format!(
                "mkfifo {}: {}",
                p.display(),
                std::io::Error::last_os_error()
            ))
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// Lists `dir` with `lister` into a fresh buffer and returns the entries by name.
fn list_with(
    lister: DarwinLister,
    dir: &Path,
) -> Result<(FastPath, BTreeMap<Vec<u8>, Meta>), String> {
    let mut buf = ListBuffer::new(0);
    let path = lister
        .list(dir, true, &mut buf)
        .map_err(|r| format!("listing refused: {r:?}"))?;
    Ok((path, by_name(&buf.listing)))
}

fn consistency_fixture() -> Result<Fixture, String> {
    let fx = Fixture::new("agree")?;
    fx.file("zero.bin", 0)?;
    fx.file("one.bin", 1)?;
    fx.file("odd.bin", 4_097)?;
    fx.file("sub/inner.bin", 12)?;
    let sparse = fs::File::create(fx.root.join("sparse.bin")).map_err(|e| e.to_string())?;
    sparse.set_len(1 << 20).map_err(|e| e.to_string())?;
    std::os::unix::fs::symlink("one.bin", fx.root.join("link")).map_err(|e| e.to_string())?;
    std::os::unix::fs::symlink("/nowhere/at/all", fx.root.join("broken"))
        .map_err(|e| e.to_string())?;
    fs::hard_link(fx.root.join("odd.bin"), fx.root.join("odd-again.bin"))
        .map_err(|e| e.to_string())?;
    fx.file("emoji-\u{1F332}\n.txt", 3)?;
    fx.fifo("fifo")?;
    Ok(fx)
}

#[test]
fn the_bulk_listing_and_the_per_entry_fallback_agree_entry_by_entry() -> TestResult {
    let fx = consistency_fixture()?;
    let (bulk_path, bulk) = list_with(DarwinLister::new(), &fx.root)?;
    let (slow_path, slow) = list_with(DarwinLister::per_entry_only(), &fx.root)?;
    assert_eq!(bulk_path, FastPath::Bulk);
    assert_eq!(slow_path, FastPath::PerEntry);
    let bulk_names: Vec<&Vec<u8>> = bulk.keys().collect();
    let slow_names: Vec<&Vec<u8>> = slow.keys().collect();
    assert_eq!(bulk_names, slow_names, "the same entries");
    assert_eq!(
        bulk.len(),
        10,
        "zero, one, odd, sub, sparse, link, broken, odd-again, the emoji name, fifo"
    );
    let mut differences = Vec::new();
    for (name, b) in &bulk {
        let Some(s) = slow.get(name) else {
            differences.push(format!(
                "{}: missing from the per-entry listing",
                String::from_utf8_lossy(name)
            ));
            continue;
        };
        let shown = String::from_utf8_lossy(name);
        let fields: [(&str, bool); 10] = [
            ("kind", b.kind == s.kind),
            ("flags", b.flags == s.flags),
            ("size", b.size.to_bits() == s.size.to_bits()),
            ("alloc", b.alloc.to_bits() == s.alloc.to_bits()),
            ("mtime_ms", b.mtime_ms.to_bits() == s.mtime_ms.to_bits()),
            ("atime_ms", b.atime_ms.to_bits() == s.atime_ms.to_bits()),
            ("dev", b.dev.to_bits() == s.dev.to_bits()),
            ("ino", b.ino.to_bits() == s.ino.to_bits()),
            ("nlink", b.nlink == s.nlink),
            ("withheld", b.withheld == s.withheld),
        ];
        for (field, same) in fields {
            if !same {
                differences.push(format!(
                    "{shown}: {field} differs: bulk {b:?} vs per-entry {s:?}"
                ));
            }
        }
    }
    assert!(differences.is_empty(), "{}", differences.join("\n"));
    // And the facts themselves, not only their agreement.
    let sparse = entry(&bulk, "sparse.bin")?;
    assert_eq!(sparse.size.to_bits(), (1_048_576.0_f64).to_bits());
    assert_eq!(sparse.alloc.to_bits(), 0.0_f64.to_bits());
    assert_eq!(entry(&bulk, "link")?.kind, KIND_SYMLINK);
    assert_eq!(entry(&bulk, "link")?.size.to_bits(), 7.0_f64.to_bits());
    assert_eq!(
        entry(&bulk, "broken")?.size.to_bits(),
        ("/nowhere/at/all".len() as f64).to_bits()
    );
    assert_eq!(entry(&bulk, "sub")?.kind, KIND_DIR);
    assert_eq!(entry(&bulk, "fifo")?.kind, KIND_FILE);
    assert_eq!(entry(&bulk, "odd.bin")?.nlink, 2);
    assert_eq!(
        entry(&bulk, "odd-again.bin")?.ino.to_bits(),
        entry(&bulk, "odd.bin")?.ino.to_bits()
    );
    assert_eq!(
        entry(&bulk, "odd.bin")?.alloc.to_bits(),
        8_192.0_f64.to_bits(),
        "4,097 bytes occupy two 4 KiB blocks"
    );
    assert!(
        bulk.values().all(|m| !m.withheld),
        "APFS returns every requested attribute"
    );
    assert!(
        bulk.values().all(|m| m.atime_ms.is_finite()),
        "atime asked for and returned"
    );
    Ok(())
}

/// Attaches a small sparse disk image at `mountpoint`; `None` (with the reason
/// printed) when hdiutil is not there or refuses. No password is needed for a
/// mount point the user owns.
fn attach_image(dir: &Path, mountpoint: &Path) -> Result<Option<PathBuf>, String> {
    let image = dir.join("edge.sparseimage");
    let created = std::process::Command::new("hdiutil")
        .args([
            "create",
            "-size",
            "8m",
            "-fs",
            "APFS",
            "-type",
            "SPARSE",
            "-volname",
            "TmWalkMount",
            "-quiet",
        ])
        .arg(&image)
        .output();
    let created = match created {
        Ok(out) if out.status.success() => out,
        Ok(out) => {
            println!(
                "skipped: hdiutil create refused: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
            return Ok(None);
        }
        Err(err) => {
            println!("skipped: hdiutil is not available: {err}");
            return Ok(None);
        }
    };
    let _ = created;
    let attached = std::process::Command::new("hdiutil")
        .args(["attach", "-mountpoint"])
        .arg(mountpoint)
        .args(["-nobrowse", "-quiet"])
        .arg(&image)
        .output()
        .map_err(|e| e.to_string())?;
    if !attached.status.success() {
        println!(
            "skipped: hdiutil attach refused: {}",
            String::from_utf8_lossy(&attached.stderr).trim()
        );
        return Ok(None);
    }
    Ok(Some(image))
}

fn detach(mountpoint: &Path) {
    let _ = std::process::Command::new("hdiutil")
        .args(["detach", "-quiet"])
        .arg(mountpoint)
        .output();
}

/// Detaches on drop, so a failing assertion cannot leave the image mounted
/// (two were found mounted after a red mutant run of the test below).
struct Mounted(PathBuf);

impl Drop for Mounted {
    fn drop(&mut self) {
        detach(&self.0);
    }
}

#[test]
fn a_mount_point_carries_the_mounted_roots_attributes_as_lstat_reports_them() -> TestResult {
    let fx = Fixture::new("mount")?;
    let mountpoint = fx.root.join("mnt");
    fs::create_dir(&mountpoint).map_err(|e| e.to_string())?;
    fx.file("beside.txt", 10)?;
    let Some(_image) = attach_image(&fx.root, &mountpoint)? else {
        return Ok(());
    };
    let _mounted = Mounted(mountpoint.clone());
    (|| -> TestResult {
        let expected = tm_walk::platform::per_entry::lstat_meta(&mountpoint, true)
            .map_err(|e| format!("lstat: errno {e}"))?;
        let mut buf = ListBuffer::new(0);
        let path = DarwinLister::new()
            .list(&fx.root, true, &mut buf)
            .map_err(|r| format!("listing refused: {r:?}"))?;
        assert_eq!(path, FastPath::Bulk);
        let map = by_name(&buf.listing);
        let got = entry(&map, "mnt")?;
        assert_eq!(got.kind, KIND_DIR);
        assert_eq!(
            got.dev.to_bits(),
            expected.dev.to_bits(),
            "the mounted volume's device, not the covered directory's"
        );
        assert_eq!(
            got.ino.to_bits(),
            expected.ino.to_bits(),
            "the mounted root's inode"
        );
        assert_eq!(
            got.mtime_ms.to_bits(),
            expected.mtime_ms.to_bits(),
            "mtime: bulk {} vs lstat {}",
            got.mtime_ms,
            expected.mtime_ms
        );
        assert_eq!(
            got.atime_ms.to_bits(),
            expected.atime_ms.to_bits(),
            "atime: bulk {} vs lstat {}",
            got.atime_ms,
            expected.atime_ms
        );
        assert!(
            buf.listing.mount_points.is_empty(),
            "the second look leaves no pending mount points behind"
        );
        Ok(())
    })()
}

#[test]
fn the_bulk_buffer_is_allocated_once_and_reused() -> TestResult {
    let fx = consistency_fixture()?;
    let lister = DarwinLister::new();
    let mut buf = ListBuffer::new(0);
    let before = (buf.raw.as_ptr(), buf.raw.len(), buf.raw.capacity());
    for _ in 0..3 {
        lister
            .list(&fx.root, false, &mut buf)
            .map_err(|r| format!("{r:?}"))?;
        lister
            .list(&fx.root.join("sub"), false, &mut buf)
            .map_err(|r| format!("{r:?}"))?;
    }
    let after = (buf.raw.as_ptr(), buf.raw.len(), buf.raw.capacity());
    assert_eq!(before, after, "the same allocation serves every directory");
    assert_eq!(
        buf.listing.entries.len(),
        1,
        "the listing is cleared per directory"
    );
    Ok(())
}

#[test]
fn a_denied_directory_is_a_denied_refusal_and_a_missing_one_vanished() -> TestResult {
    let fx = Fixture::new("refusal")?;
    fx.file("locked/x.bin", 1)?;
    let locked = fx.root.join("locked");
    // SAFETY: geteuid has no preconditions and only reads the process's credentials.
    let root_user = unsafe { libc::geteuid() } == 0;
    let lister = DarwinLister::new();
    let mut buf = ListBuffer::new(0);
    if root_user {
        eprintln!("skipped the chmod 000 assertion: running as root");
    } else {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000))
            .map_err(|e| e.to_string())?;
        let result = lister.list(&locked, false, &mut buf);
        let _ = fs::set_permissions(&locked, fs::Permissions::from_mode(0o755));
        assert_eq!(result, Err(Refusal::Denied));
    }
    assert_eq!(
        lister.list(&fx.root.join("missing"), false, &mut buf),
        Err(Refusal::Vanished)
    );
    assert_eq!(
        lister.list(&fx.root.join("locked/x.bin"), false, &mut buf),
        Err(Refusal::Vanished),
        "ENOTDIR is a vanished directory"
    );
    Ok(())
}

#[test]
fn the_probe_reports_unavailable_for_a_missing_root() {
    let probe = probe(Path::new("/nonexistent/tm-walk/probe/root"));
    assert_eq!(probe.fast_path, FastPath::Unavailable);
    assert!(probe.reason.contains("No such file"), "{}", probe.reason);
}

#[test]
fn the_probe_reports_unavailable_for_a_file_root() -> TestResult {
    let fx = Fixture::new("probefile")?;
    fx.file("plain.bin", 1)?;
    let probe = probe(&fx.root.join("plain.bin"));
    assert_eq!(probe.fast_path, FastPath::Unavailable);
    assert!(probe.reason.contains("not a directory"), "{}", probe.reason);
    Ok(())
}

/// A lister whose bulk path is refused, as a network volume's would be.
struct PerEntryOnly;

impl Lister for PerEntryOnly {
    fn stat_dir(&self, _path: &Path, _want_atime: bool) -> Result<Meta, Refusal> {
        Ok(Meta::unknown(KIND_DIR))
    }

    fn list(
        &self,
        _dir: &Path,
        _want_atime: bool,
        buf: &mut ListBuffer,
    ) -> Result<FastPath, Refusal> {
        buf.listing.clear();
        Ok(FastPath::PerEntry)
    }
}

#[test]
fn the_probe_reports_per_entry_with_a_reason_when_bulk_is_refused() {
    let probe = probe_with(&PerEntryOnly, Path::new("/anywhere"));
    assert_eq!(probe.fast_path, FastPath::PerEntry);
    assert!(probe.reason.contains("per-entry"), "{}", probe.reason);
}

#[test]
fn measures_bulk_against_per_entry_on_five_thousand_entries() -> TestResult {
    let fx = Fixture::new("measure")?;
    for i in 0..MEASURE_ENTRIES {
        fx.file(&format!("f{i:05}.bin"), 1)?;
    }
    let best = |lister: DarwinLister| -> Result<f64, String> {
        let mut buf = ListBuffer::new(0);
        let mut best_secs = f64::INFINITY;
        for _ in 0..MEASURE_RUNS {
            let started = Instant::now();
            lister
                .list(&fx.root, false, &mut buf)
                .map_err(|r| format!("{r:?}"))?;
            let secs = started.elapsed().as_secs_f64();
            if buf.listing.entries.len() != MEASURE_ENTRIES {
                return Err(format!(
                    "listed {} of {MEASURE_ENTRIES}",
                    buf.listing.entries.len()
                ));
            }
            best_secs = best_secs.min(secs);
        }
        Ok(MEASURE_ENTRIES as f64 / best_secs)
    };
    let bulk = best(DarwinLister::new())?;
    let slow = best(DarwinLister::per_entry_only())?;
    println!(
        "listing {MEASURE_ENTRIES} entries in one directory, best of {MEASURE_RUNS} (this build's optimisation level): getattrlistbulk {bulk:.0} entries/s; readdir+fstatat {slow:.0} entries/s; ratio {:.2}x",
        bulk / slow
    );
    assert!(bulk.is_finite() && slow.is_finite());
    Ok(())
}

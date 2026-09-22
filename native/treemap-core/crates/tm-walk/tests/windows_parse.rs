//! The Windows listing without Windows: `FILE_ID_EXTD_DIR_INFO` records built
//! by hand into a byte buffer and parsed the way the lister parses the
//! kernel's, the FILETIME formula Node goes through, libuv's reparse-target
//! size rules, the file-id collision rule for hard links, the Win32 error
//! classification and the `\\?\` prefix rule. No Windows API is called, so
//! these run on every platform; the live proof is the equivalence suite on the
//! Windows CI leg.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tm_walk::platform::windows::{
    DirFacts, ERROR_ACCESS_DENIED, ERROR_CANT_ACCESS_FILE, ERROR_DIRECTORY,
    ERROR_ELEVATION_REQUIRED, ERROR_FILE_NOT_FOUND, ERROR_INVALID_DRIVE, ERROR_INVALID_NAME,
    ERROR_INVALID_REPARSE_DATA, ERROR_NOACCESS, ERROR_NOT_SUPPORTED, ERROR_PATH_NOT_FOUND,
    ERROR_PRIVILEGE_NOT_HELD, ERROR_SHARING_VIOLATION, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_RECALL_ON_OPEN,
    FILE_ATTRIBUTE_REPARSE_POINT, FILETIME_UNIX_EPOCH, IO_REPARSE_TAG_APPEXECLINK,
    IO_REPARSE_TAG_CLOUD, IO_REPARSE_TAG_LX_SYMLINK, IO_REPARSE_TAG_MOUNT_POINT,
    IO_REPARSE_TAG_SYMLINK, IO_REPARSE_TAG_WOF, RECORD_HEADER_BYTES, Record, ReparseSource,
    filetime_ms, filetime_to_timespec, is_dataless, parse_records, prefixed_path,
    refusal_from_win32, reparse_target_len, stage_record,
};
use tm_walk::platform::{ListBuffer, Lister, Listing, Meta, time_ms};
use tm_walk::walk::Pacer;
use tm_walk::{
    FLAG_DATALESS, FastPath, KIND_DIR, KIND_FILE, KIND_SYMLINK, Refusal, WalkOptions, WalkOutput,
    start_with,
};

type TestResult = Result<(), String>;

/// A volume serial number like `GetFileInformationByHandle` reports.
const SERIAL: u32 = 0x9A3B_1C2D;
/// 2024-01-01T00:00:00Z as a FILETIME: 1_704_067_200 s after 1970, 11_644_473_600 s
/// after 1601, times 10^7 ticks (the plan's figure, 133_485_888_000_000_000, is 13h20m later).
const FT_2024: i64 = 133_485_408_000_000_000;
/// `IO_REPARSE_TAG_CLOUD_6`: what OneDrive stamps on its placeholders.
const IO_REPARSE_TAG_CLOUD_6: u32 = 0x9000_601A;

// ---------------------------------------------------------------------------
// Record packing: the layout the kernel writes, field by field
// ---------------------------------------------------------------------------

fn utf16le(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(u16::to_le_bytes).collect()
}

/// One record's facts, as the kernel would pack them.
struct Packed {
    name: String,
    attributes: u32,
    tag: u32,
    eof: i64,
    alloc: i64,
    write: i64,
    access: i64,
    id: u128,
}

fn file(name: &str, eof: i64) -> Packed {
    Packed {
        name: name.to_owned(),
        attributes: 0x20, // FILE_ATTRIBUTE_ARCHIVE: the ordinary file
        tag: 0,
        eof,
        alloc: 4_096,
        write: FT_2024,
        access: FT_2024 + 10_000_000,
        id: 0x0001_0000_0000_2A2A,
    }
}

fn directory(name: &str) -> Packed {
    let mut d = file(name, 0);
    d.attributes = FILE_ATTRIBUTE_DIRECTORY;
    d.alloc = 0;
    d.id = 0x0002_0000_0000_0D1D;
    d
}

fn pack_one(e: &Packed, has_next: bool) -> Result<Vec<u8>, String> {
    let name = utf16le(&e.name);
    let body = RECORD_HEADER_BYTES + name.len();
    let padded = body.div_ceil(8) * 8;
    let next = if has_next { padded } else { 0 };
    let mut rec = Vec::with_capacity(padded);
    let u32_of = |n: usize| u32::try_from(n).map_err(|e| e.to_string());
    rec.extend(u32_of(next)?.to_le_bytes()); // NextEntryOffset
    rec.extend(0_u32.to_le_bytes()); // FileIndex
    rec.extend(e.write.to_le_bytes()); // CreationTime (not a fact the walk keeps)
    rec.extend(e.access.to_le_bytes()); // LastAccessTime
    rec.extend(e.write.to_le_bytes()); // LastWriteTime
    rec.extend(e.write.to_le_bytes()); // ChangeTime (not kept either)
    rec.extend(e.eof.to_le_bytes()); // EndOfFile
    rec.extend(e.alloc.to_le_bytes()); // AllocationSize
    rec.extend(e.attributes.to_le_bytes()); // FileAttributes
    rec.extend(u32_of(name.len())?.to_le_bytes()); // FileNameLength (bytes)
    rec.extend(0_u32.to_le_bytes()); // EaSize
    rec.extend(e.tag.to_le_bytes()); // ReparsePointTag
    rec.extend(e.id.to_le_bytes()); // FileId: 16 bytes, low 64 first
    assert_eq!(rec.len(), RECORD_HEADER_BYTES);
    rec.extend(&name);
    if has_next {
        rec.resize(padded, 0);
    }
    Ok(rec)
}

/// Chains every record by `NextEntryOffset`; the last one ends the buffer.
fn buffer(entries: &[Packed]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    for (i, e) in entries.iter().enumerate() {
        out.extend(pack_one(e, i + 1 < entries.len())?);
    }
    Ok(out)
}

/// A reparse-point source scripted by name: the `REPARSE_DATA_BUFFER` bytes
/// the file would return, or the Win32 error opening it would raise.
#[derive(Default)]
struct FakeReparse {
    by_name: HashMap<String, Result<Vec<u8>, u32>>,
}

impl FakeReparse {
    fn with(mut self, name: &str, answer: Result<Vec<u8>, u32>) -> Self {
        self.by_name.insert(name.to_owned(), answer);
        self
    }
}

impl ReparseSource for FakeReparse {
    fn reparse_data(&self, _dir: &Path, name: &[u16]) -> Result<Vec<u8>, u32> {
        let key = String::from_utf16_lossy(name);
        match self.by_name.get(&key) {
            Some(answer) => answer.clone(),
            None => Err(ERROR_FILE_NOT_FOUND),
        }
    }
}

/// A `REPARSE_DATA_BUFFER` for a symbolic link or a junction whose substitute
/// name is `substitute` (the print name is the same text; libuv ignores it).
fn link_buffer(tag: u32, substitute: &str) -> Vec<u8> {
    let sub = utf16le(substitute);
    let print = utf16le(substitute);
    let mut path_buffer = Vec::new();
    path_buffer.extend(&sub);
    path_buffer.extend(&print);
    let mut out = Vec::new();
    let fixed: u16 = if tag == IO_REPARSE_TAG_SYMLINK { 12 } else { 8 };
    let data_len = fixed + u16::try_from(path_buffer.len()).unwrap_or(u16::MAX);
    out.extend(tag.to_le_bytes());
    out.extend(data_len.to_le_bytes());
    out.extend(0_u16.to_le_bytes()); // Reserved
    out.extend(0_u16.to_le_bytes()); // SubstituteNameOffset
    out.extend(u16::try_from(sub.len()).unwrap_or(u16::MAX).to_le_bytes());
    out.extend(u16::try_from(sub.len()).unwrap_or(u16::MAX).to_le_bytes()); // PrintNameOffset
    out.extend(u16::try_from(print.len()).unwrap_or(u16::MAX).to_le_bytes());
    if tag == IO_REPARSE_TAG_SYMLINK {
        out.extend(0_u32.to_le_bytes()); // Flags (absolute)
    }
    out.extend(&path_buffer);
    out
}

/// An `IO_REPARSE_TAG_APPEXECLINK` buffer: a version word, then NUL-separated strings.
fn appexeclink_buffer(strings: &[&str]) -> Vec<u8> {
    let mut list = Vec::new();
    for s in strings {
        list.extend(utf16le(s));
        list.extend(0_u16.to_le_bytes());
    }
    list.extend(0_u16.to_le_bytes());
    let mut out = Vec::new();
    out.extend(IO_REPARSE_TAG_APPEXECLINK.to_le_bytes());
    out.extend(
        u16::try_from(4 + list.len())
            .unwrap_or(u16::MAX)
            .to_le_bytes(),
    );
    out.extend(0_u16.to_le_bytes());
    out.extend(3_u32.to_le_bytes()); // Version / StringCount
    out.extend(&list);
    out
}

fn staged(
    entries: &[Packed],
    reparse: &dyn ReparseSource,
    want_atime: bool,
) -> Result<Listing, String> {
    let raw = buffer(entries)?;
    let mut out = Listing::default();
    let facts = DirFacts {
        dev: SERIAL,
        want_atime,
    };
    let dir = Path::new("C:\\fixture");
    let mut visited = 0_usize;
    let count = parse_records(&raw, &mut |rec: &Record<'_>| {
        visited += 1;
        stage_record(rec, facts, dir, reparse, &mut out);
    })
    .map_err(|e| format!("{e:?}"))?;
    assert_eq!(
        count, visited,
        "parse_records reports the records it visited"
    );
    Ok(out)
}

fn by_name(listing: &Listing) -> BTreeMap<String, Meta> {
    listing
        .entries
        .iter()
        .map(|e| {
            (
                String::from_utf8_lossy(listing.name(e)).into_owned(),
                e.meta,
            )
        })
        .collect()
}

fn entry<'a>(map: &'a BTreeMap<String, Meta>, name: &str) -> Result<&'a Meta, String> {
    map.get(name)
        .ok_or_else(|| format!("no entry {name:?}: {:?}", map.keys()))
}

// ---------------------------------------------------------------------------
// The record parser and the staging of one entry
// ---------------------------------------------------------------------------

#[test]
fn parses_chained_records_a_directory_a_file_and_a_last_name_at_the_buffer_end() -> TestResult {
    let long_name: String = "n".repeat(100);
    let mut last = file(&long_name, 7);
    last.id = 0x0003_0000_0000_0777;
    let entries = [
        directory("."),
        directory(".."),
        directory("sub"),
        file("a.bin", 10),
        last,
    ];
    let raw = buffer(&entries)?;
    let tail = raw.len() - 200;
    assert_eq!(
        raw.get(tail..)
            .map(|t| t.iter().all(|b| *b == b'n' || *b == 0)),
        Some(true),
        "the 100-char name ends exactly at the buffer end"
    );
    let listing = staged(&entries, &FakeReparse::default(), true)?;
    assert_eq!(listing.entries.len(), 3, "`.` and `..` are skipped");
    let map = by_name(&listing);
    let sub = entry(&map, "sub")?;
    assert_eq!(sub.kind, KIND_DIR);
    assert_eq!(sub.size.to_bits(), 0.0_f64.to_bits());
    assert_eq!(sub.alloc.to_bits(), 0.0_f64.to_bits());
    assert_eq!(sub.nlink, 0, "a directory records no link count");
    assert!(!sub.withheld);
    let a = entry(&map, "a.bin")?;
    assert_eq!(a.kind, KIND_FILE);
    assert_eq!(a.flags, 0);
    assert_eq!(a.size.to_bits(), 10.0_f64.to_bits());
    assert_eq!(a.alloc.to_bits(), 4_096.0_f64.to_bits());
    assert_eq!(a.mtime_ms.to_bits(), filetime_ms(FT_2024).to_bits());
    assert_eq!(
        a.atime_ms.to_bits(),
        filetime_ms(FT_2024 + 10_000_000).to_bits()
    );
    assert_eq!(a.dev.to_bits(), f64::from(SERIAL).to_bits());
    assert_eq!(
        a.ino.to_bits(),
        (0x0001_0000_0000_2A2A_u64 as f64).to_bits(),
        "the low 64 bits of the 128-bit id, as Node's double"
    );
    assert_eq!(
        a.nlink, 0,
        "the record has no link count: the walk detects families by collision"
    );
    assert!(!a.withheld);
    let long = entry(&map, &long_name)?;
    assert_eq!(long.size.to_bits(), 7.0_f64.to_bits());
    assert_eq!(
        long.ino.to_bits(),
        (0x0003_0000_0000_0777_u64 as f64).to_bits()
    );
    assert_eq!(listing.denied_entries + listing.unreadable_entries, 0);
    Ok(())
}

#[test]
fn atime_is_nan_when_not_wanted_and_the_fields_after_it_are_still_read_in_place() -> TestResult {
    let listing = staged(&[file("a.bin", 3)], &FakeReparse::default(), false)?;
    let map = by_name(&listing);
    let a = entry(&map, "a.bin")?;
    assert!(a.atime_ms.is_nan());
    assert_eq!(a.mtime_ms.to_bits(), filetime_ms(FT_2024).to_bits());
    assert_eq!(a.size.to_bits(), 3.0_f64.to_bits());
    Ok(())
}

#[test]
fn a_symlink_reparse_point_is_a_leaf_sized_by_its_target_text() -> TestResult {
    let mut link = file("to-file", 0);
    link.attributes = FILE_ATTRIBUTE_REPARSE_POINT;
    link.tag = IO_REPARSE_TAG_SYMLINK;
    let mut dir_link = file("to-dir", 0);
    dir_link.attributes = FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY;
    dir_link.tag = IO_REPARSE_TAG_SYMLINK;
    let mut junction = file("junction", 0);
    junction.attributes = FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY;
    junction.tag = IO_REPARSE_TAG_MOUNT_POINT;
    let mut volume_mount = file("mnt", 0);
    volume_mount.attributes = FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY;
    volume_mount.tag = IO_REPARSE_TAG_MOUNT_POINT;
    let reparse = FakeReparse::default()
        .with(
            "to-file",
            Ok(link_buffer(
                IO_REPARSE_TAG_SYMLINK,
                "\\??\\C:\\target\\file.txt",
            )),
        )
        .with(
            "to-dir",
            Ok(link_buffer(IO_REPARSE_TAG_SYMLINK, "..\\sibling")),
        )
        .with(
            "junction",
            Ok(link_buffer(IO_REPARSE_TAG_MOUNT_POINT, "\\??\\D:\\data")),
        )
        .with(
            "mnt",
            Ok(link_buffer(
                IO_REPARSE_TAG_MOUNT_POINT,
                "\\??\\Volume{3f5c1b2a-0000-0000-0000-100000000000}\\",
            )),
        );
    let listing = staged(&[link, dir_link, junction, volume_mount], &reparse, true)?;
    let map = by_name(&listing);
    let l = entry(&map, "to-file")?;
    assert_eq!(l.kind, KIND_SYMLINK);
    assert_eq!(
        l.size.to_bits(),
        18.0_f64.to_bits(),
        "`C:\\target\\file.txt` after the `\\??\\` prefix is stripped"
    );
    assert!(!l.withheld);
    let d = entry(&map, "to-dir")?;
    assert_eq!(
        d.kind, KIND_SYMLINK,
        "a directory symlink is a leaf, never a directory"
    );
    assert_eq!(
        d.size.to_bits(),
        10.0_f64.to_bits(),
        "a relative target is kept as is"
    );
    let j = entry(&map, "junction")?;
    assert_eq!(
        j.kind, KIND_SYMLINK,
        "Node's lstat reports a drive junction as a symlink"
    );
    assert_eq!(j.size.to_bits(), 7.0_f64.to_bits(), "`D:\\data`");
    let m = entry(&map, "mnt")?;
    assert_eq!(
        m.kind, KIND_SYMLINK,
        "readdir marks every reparse point a link, so the legacy walker never descends"
    );
    assert_eq!(
        m.size.to_bits(),
        0.0_f64.to_bits(),
        "libuv cannot read a volume mount point as a link and stats the directory behind it: size 0"
    );
    assert_eq!(listing.denied_entries + listing.unreadable_entries, 0);
    Ok(())
}

#[test]
fn an_appexeclink_is_a_symlink_sized_by_its_third_string() -> TestResult {
    let mut stub = file("python.exe", 0);
    stub.attributes = FILE_ATTRIBUTE_REPARSE_POINT;
    stub.tag = IO_REPARSE_TAG_APPEXECLINK;
    let mut odd = file("odd.exe", 0);
    odd.attributes = FILE_ATTRIBUTE_REPARSE_POINT;
    odd.tag = IO_REPARSE_TAG_APPEXECLINK;
    let reparse = FakeReparse::default()
        .with(
            "python.exe",
            Ok(appexeclink_buffer(&[
                "PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0",
                "PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0!Python",
                "C:\\Program Files\\WindowsApps\\Python\\python.exe",
                "0",
            ])),
        )
        .with("odd.exe", Ok(appexeclink_buffer(&["pkg", "entry"])));
    let listing = staged(&[stub, odd], &reparse, true)?;
    let map = by_name(&listing);
    let p = entry(&map, "python.exe")?;
    assert_eq!(p.kind, KIND_SYMLINK);
    assert_eq!(
        p.size.to_bits(),
        ("C:\\Program Files\\WindowsApps\\Python\\python.exe".len() as f64).to_bits()
    );
    assert!(
        !map.contains_key("odd.exe"),
        "with fewer than three strings libuv cannot read it, following it fails: omitted"
    );
    assert_eq!(
        listing.denied_entries, 1,
        "ERROR_CANT_ACCESS_FILE is EACCES to Node"
    );
    Ok(())
}

#[test]
fn a_cloud_placeholder_is_a_symlink_leaf_with_its_logical_size_and_the_dataless_flag() -> TestResult
{
    let mut placeholder = file("Report.docx", 500);
    placeholder.attributes = FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
    placeholder.tag = IO_REPARSE_TAG_CLOUD_6;
    placeholder.alloc = 0;
    let mut cloud_dir = file("Photos", 0);
    cloud_dir.attributes = FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY;
    cloud_dir.tag = IO_REPARSE_TAG_CLOUD_6;
    let mut offline = file("archived.bin", 9);
    offline.attributes = FILE_ATTRIBUTE_OFFLINE;
    let mut recall = file("stub.bin", 9);
    recall.attributes = FILE_ATTRIBUTE_RECALL_ON_OPEN;
    let mut compressed = file("system.dll", 4_000);
    compressed.attributes = FILE_ATTRIBUTE_REPARSE_POINT;
    compressed.tag = IO_REPARSE_TAG_WOF;
    let listing = staged(
        &[
            placeholder,
            cloud_dir,
            offline,
            recall,
            compressed,
            file("plain.bin", 1),
        ],
        &FakeReparse::default(),
        true,
    )?;
    let map = by_name(&listing);
    let p = entry(&map, "Report.docx")?;
    assert_eq!(
        p.kind, KIND_SYMLINK,
        "readdir reports the reparse point as a link"
    );
    assert_eq!(
        p.size.to_bits(),
        500.0_f64.to_bits(),
        "lstat follows it and reports EndOfFile"
    );
    assert_eq!(p.flags, FLAG_DATALESS);
    let d = entry(&map, "Photos")?;
    assert_eq!(
        d.kind, KIND_SYMLINK,
        "a placeholder directory is a leaf to the legacy walker too"
    );
    assert_eq!(d.size.to_bits(), 0.0_f64.to_bits());
    assert_eq!(
        d.flags, FLAG_DATALESS,
        "the cloud tag alone marks it dataless"
    );
    assert_eq!(entry(&map, "archived.bin")?.flags, FLAG_DATALESS);
    assert_eq!(entry(&map, "archived.bin")?.kind, KIND_FILE);
    assert_eq!(entry(&map, "stub.bin")?.flags, FLAG_DATALESS);
    let c = entry(&map, "system.dll")?;
    assert_eq!(
        c.kind, KIND_SYMLINK,
        "a WOF-compressed file is a reparse point: a link to readdir"
    );
    assert_eq!(c.size.to_bits(), 4_000.0_f64.to_bits());
    assert_eq!(c.flags, 0, "WOF is not a cloud tag");
    assert_eq!(entry(&map, "plain.bin")?.flags, 0);
    assert_eq!(listing.denied_entries + listing.unreadable_entries, 0);
    Ok(())
}

#[test]
fn the_dataless_rule_is_the_cloud_family_or_the_three_attributes() {
    assert!(is_dataless(0, IO_REPARSE_TAG_CLOUD));
    assert!(is_dataless(0, IO_REPARSE_TAG_CLOUD_6));
    assert!(is_dataless(0, 0x9000_F01A), "every cloud variant");
    assert!(!is_dataless(0, IO_REPARSE_TAG_SYMLINK));
    assert!(!is_dataless(0, IO_REPARSE_TAG_WOF));
    assert!(is_dataless(FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, 0));
    assert!(is_dataless(FILE_ATTRIBUTE_RECALL_ON_OPEN, 0));
    assert!(is_dataless(FILE_ATTRIBUTE_OFFLINE, 0));
    assert!(!is_dataless(FILE_ATTRIBUTE_DIRECTORY | 0x20, 0));
}

#[test]
fn a_reparse_point_that_cannot_be_opened_is_counted_like_a_failed_lstat() -> TestResult {
    let mut gone = file("gone", 0);
    gone.attributes = FILE_ATTRIBUTE_REPARSE_POINT;
    gone.tag = IO_REPARSE_TAG_SYMLINK;
    let mut locked = file("locked", 0);
    locked.attributes = FILE_ATTRIBUTE_REPARSE_POINT;
    locked.tag = IO_REPARSE_TAG_SYMLINK;
    let mut busy = file("busy", 0);
    busy.attributes = FILE_ATTRIBUTE_REPARSE_POINT;
    busy.tag = IO_REPARSE_TAG_SYMLINK;
    let mut wsl = file("wsl-link", 0);
    wsl.attributes = FILE_ATTRIBUTE_REPARSE_POINT;
    wsl.tag = IO_REPARSE_TAG_LX_SYMLINK;
    let reparse = FakeReparse::default()
        .with("gone", Err(ERROR_FILE_NOT_FOUND))
        .with("locked", Err(ERROR_ACCESS_DENIED))
        .with("busy", Err(ERROR_SHARING_VIOLATION));
    let listing = staged(
        &[gone, locked, busy, wsl, file("fine.bin", 2)],
        &reparse,
        true,
    )?;
    let map = by_name(&listing);
    assert_eq!(
        map.len(),
        1,
        "only the plain file survives: {:?}",
        map.keys()
    );
    assert!(entry(&map, "fine.bin").is_ok());
    assert_eq!(
        listing.denied_entries, 2,
        "ACCESS_DENIED, and the WSL link Windows itself cannot follow"
    );
    assert_eq!(
        listing.unreadable_entries, 1,
        "a sharing violation is EBUSY"
    );
    Ok(())
}

#[test]
fn a_record_without_an_id_or_an_allocation_is_withheld() -> TestResult {
    let raw = buffer(&[file("a.bin", 5)])?;
    let mut out = Listing::default();
    let facts = DirFacts {
        dev: SERIAL,
        want_atime: false,
    };
    parse_records(&raw, &mut |rec: &Record<'_>| {
        let partial = Record {
            allocation: None,
            file_id_low: None,
            ..*rec
        };
        stage_record(
            &partial,
            facts,
            Path::new("C:\\x"),
            &FakeReparse::default(),
            &mut out,
        );
    })
    .map_err(|e| format!("{e:?}"))?;
    let map = by_name(&out);
    let a = entry(&map, "a.bin")?;
    assert!(a.withheld, "FindFirstFileExW has neither field");
    assert_eq!(
        a.size.to_bits(),
        5.0_f64.to_bits(),
        "what it does have is kept"
    );
    assert_eq!(a.alloc.to_bits(), 0.0_f64.to_bits());
    assert_eq!(a.ino.to_bits(), 0.0_f64.to_bits());
    Ok(())
}

#[test]
fn rejects_a_corrupt_record() -> TestResult {
    let mut past_end = buffer(&[file("a.bin", 1), file("b.bin", 2)])?;
    // NextEntryOffset of the first record pointing beyond the buffer.
    past_end.splice(0..4, 0xFFFF_0000_u32.to_le_bytes());
    let count = |raw: &[u8]| parse_records(raw, &mut |_rec: &Record<'_>| {});
    assert!(count(&past_end).is_err(), "an offset past the buffer");
    let mut name_past_end = buffer(&[file("a.bin", 1)])?;
    name_past_end.splice(60..64, 4_000_u32.to_le_bytes());
    assert!(
        count(&name_past_end).is_err(),
        "a name longer than the record"
    );
    let mut odd_name = buffer(&[file("a.bin", 1)])?;
    odd_name.splice(60..64, 9_u32.to_le_bytes());
    assert!(count(&odd_name).is_err(), "an odd UTF-16 byte length");
    let short = buffer(&[file("a.bin", 1)])?;
    assert!(
        count(short.get(..40).unwrap_or(&[])).is_err(),
        "a buffer shorter than one header"
    );
    let mut backwards = buffer(&[file("a.bin", 1), file("b.bin", 2)])?;
    backwards.splice(0..4, 4_u32.to_le_bytes());
    assert!(
        count(&backwards).is_err(),
        "an offset that does not advance past the header"
    );
    assert_eq!(count(&[]).ok(), Some(0), "an empty buffer holds no record");
    Ok(())
}

#[test]
fn names_are_utf16_decoded_lossily_as_node_decodes_them() -> TestResult {
    let entries = [file("caf\u{E9}-\u{1F332}.txt", 1)];
    let mut raw = buffer(&entries)?;
    // Append a second record whose name holds a lone high surrogate.
    let mut lone = file("x", 2);
    lone.name = "lone".to_owned();
    let mut rec = pack_one(&lone, false)?;
    let name_start = RECORD_HEADER_BYTES;
    rec.splice(name_start..name_start + 2, 0xD83C_u16.to_le_bytes());
    let first_len = raw.len();
    let padded = first_len.div_ceil(8) * 8;
    raw.resize(padded, 0);
    raw.splice(
        0..4,
        u32::try_from(padded)
            .map_err(|e| e.to_string())?
            .to_le_bytes(),
    );
    raw.extend(rec);
    let mut out = Listing::default();
    let facts = DirFacts {
        dev: SERIAL,
        want_atime: false,
    };
    parse_records(&raw, &mut |rec: &Record<'_>| {
        stage_record(
            rec,
            facts,
            Path::new("C:\\x"),
            &FakeReparse::default(),
            &mut out,
        );
    })
    .map_err(|e| format!("{e:?}"))?;
    let map = by_name(&out);
    assert!(
        entry(&map, "caf\u{E9}-\u{1F332}.txt").is_ok(),
        "{:?}",
        map.keys()
    );
    assert!(
        entry(&map, "\u{FFFD}one").is_ok(),
        "a lone surrogate becomes U+FFFD: {:?}",
        map.keys()
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// The FILETIME formula
// ---------------------------------------------------------------------------

#[test]
fn filetime_ms_is_the_libuv_then_node_formula() {
    assert_eq!(filetime_to_timespec(FILETIME_UNIX_EPOCH), (0, 0));
    assert_eq!(
        filetime_ms(FILETIME_UNIX_EPOCH).to_bits(),
        0.0_f64.to_bits()
    );
    assert_eq!(filetime_to_timespec(FT_2024), (1_704_067_200, 0));
    assert_eq!(
        filetime_ms(FT_2024).to_bits(),
        1_704_067_200_000.0_f64.to_bits()
    );
    // 1234 s and 5,678,901 ticks of 100 ns: a remainder that survives as nanoseconds.
    let ft = FILETIME_UNIX_EPOCH + 12_345_678_901;
    assert_eq!(filetime_to_timespec(ft), (1_234, 567_890_100));
    assert_eq!(
        filetime_ms(ft).to_bits(),
        time_ms(1_234, 567_890_100).to_bits(),
        "sec * 1e3 + nsec / 1e6, unrounded"
    );
    assert_ne!(filetime_ms(ft).to_bits(), filetime_ms(ft).round().to_bits());
    // One tick before the epoch: C division truncates toward zero and libuv
    // normalises the negative nanoseconds.
    assert_eq!(
        filetime_to_timespec(FILETIME_UNIX_EPOCH - 1),
        (-1, 999_999_900)
    );
    assert_eq!(
        filetime_ms(FILETIME_UNIX_EPOCH - 1).to_bits(),
        time_ms(-1, 999_999_900).to_bits()
    );
    // libuv keeps tv_sec in a 32-bit `long` on Windows: 2038 wraps there, so it wraps here.
    let wrap = FILETIME_UNIX_EPOCH + (1_i64 << 31) * 10_000_000;
    assert_eq!(filetime_to_timespec(wrap), (i64::from(i32::MIN), 0));
    // Zero, what NTFS reports for a time never set: 1601 is -11,644,473,600 s,
    // which the 32-bit `long` keeps as 1,240,428,288 (April 2009). Mirrored,
    // not corrected: the equivalence gate compares against Node.
    assert_eq!(filetime_to_timespec(0), (1_240_428_288, 0));
}

// ---------------------------------------------------------------------------
// The reparse-target size rules (libuv's fs__readlink_handle)
// ---------------------------------------------------------------------------

#[test]
fn reparse_target_len_follows_libuvs_prefix_rules() {
    let sym = |s: &str| reparse_target_len(&link_buffer(IO_REPARSE_TAG_SYMLINK, s));
    assert_eq!(
        sym("\\??\\C:\\target\\file.txt"),
        Some(18),
        "`\\??\\` stripped"
    );
    assert_eq!(sym("\\??\\c:"), Some(2), "a bare drive is a drive");
    assert_eq!(
        sym("\\??\\UNC\\server\\share\\x"),
        Some(16),
        "`\\??\\UNC\\` becomes `\\\\`: `\\\\server\\share\\x`"
    );
    assert_eq!(
        sym("\\??\\unc\\s\\t"),
        Some(5),
        "UNC is matched without case"
    );
    assert_eq!(
        sym("..\\target.txt"),
        Some(13),
        "a relative target is untouched"
    );
    assert_eq!(sym("target.txt"), Some(10));
    assert_eq!(
        sym("\\??\\Volume{3f5c1b2a-0000-0000-0000-100000000000}\\"),
        Some(49),
        "a symlink to a volume path keeps its prefix"
    );
    assert_eq!(sym("\\??\\C:x"), Some(7), "not `\\??\\X:\\`: untouched");
    assert_eq!(sym("\u{1F332}"), Some(4), "UTF-8 bytes, not UTF-16 units");
    assert_eq!(sym(""), Some(0));
    let mut lone = link_buffer(IO_REPARSE_TAG_SYMLINK, "ab");
    lone.splice(20..22, 0xDC00_u16.to_le_bytes());
    assert_eq!(
        reparse_target_len(&lone),
        Some(4),
        "a lone surrogate is three bytes of U+FFFD"
    );

    let junction = |s: &str| reparse_target_len(&link_buffer(IO_REPARSE_TAG_MOUNT_POINT, s));
    assert_eq!(junction("\\??\\D:\\data"), Some(7));
    assert_eq!(junction("\\??\\D:"), Some(2));
    assert_eq!(
        junction("\\??\\Volume{3f5c1b2a-0000-0000-0000-100000000000}\\"),
        None,
        "a volume mount point is not a link to libuv"
    );
    assert_eq!(
        junction("\\??\\UNC\\s\\t"),
        None,
        "UNC junctions are refused"
    );
    assert_eq!(junction("relative"), None);

    let app = |strings: &[&str]| reparse_target_len(&appexeclink_buffer(strings));
    assert_eq!(app(&["pkg", "entry", "C:\\Apps\\x.exe", "0"]), Some(13));
    assert_eq!(
        app(&["pkg", "entry", "C:\\Apps\\x.exe"]),
        Some(13),
        "three strings suffice"
    );
    assert_eq!(
        app(&["pkg", "entry"]),
        None,
        "the third string is the target"
    );
    assert_eq!(
        app(&["pkg", "", "C:\\Apps\\x.exe"]),
        None,
        "an empty string ends the list"
    );
    assert_eq!(
        app(&["pkg", "entry", "relative\\x.exe"]),
        None,
        "must be absolute"
    );

    assert_eq!(
        reparse_target_len(&link_buffer(IO_REPARSE_TAG_CLOUD, "\\??\\C:\\x")),
        None,
        "a cloud tag is not a link"
    );
    assert_eq!(reparse_target_len(&[]), None, "no header");
    let mut short = link_buffer(IO_REPARSE_TAG_SYMLINK, "\\??\\C:\\x");
    short.truncate(24);
    assert_eq!(
        reparse_target_len(&short),
        None,
        "a substitute name beyond the buffer"
    );
}

// ---------------------------------------------------------------------------
// The file-id collision rule for hard links
// ---------------------------------------------------------------------------

/// A scripted tree whose files carry no link count, as the Windows listing's do.
struct ScriptedTree {
    root: PathBuf,
    dirs: HashMap<PathBuf, Vec<(String, Meta)>>,
}

fn dir_meta(ino: f64) -> Meta {
    Meta {
        kind: KIND_DIR,
        flags: 0,
        size: 0.0,
        alloc: 0.0,
        mtime_ms: 1_704_067_200_000.0,
        atime_ms: f64::NAN,
        dev: f64::from(SERIAL),
        ino,
        nlink: 0,
        withheld: false,
    }
}

fn file_meta(size: f64, ino: f64, withheld: bool) -> Meta {
    Meta {
        kind: KIND_FILE,
        size,
        alloc: size,
        withheld,
        ..dir_meta(ino)
    }
}

impl ScriptedTree {
    fn new() -> Self {
        let root = PathBuf::from("C:\\root");
        let mut dirs = HashMap::new();
        dirs.insert(root.clone(), Vec::new());
        Self { root, dirs }
    }

    /// The absolute path of `rel` (`""` is the root), built by `join` exactly
    /// as the walk builds child paths on this host.
    fn abs(&self, rel: &str) -> PathBuf {
        rel.split('/')
            .filter(|c| !c.is_empty())
            .fold(self.root.clone(), |p, c| p.join(c))
    }

    fn add(&mut self, parent_rel: &str, name: &str, meta: Meta) {
        let parent = self.abs(parent_rel);
        if meta.kind == KIND_DIR {
            self.dirs.entry(parent.join(name)).or_default();
        }
        self.dirs
            .entry(parent)
            .or_default()
            .push((name.to_owned(), meta));
    }
}

impl Lister for ScriptedTree {
    fn stat_dir(&self, _path: &Path, _want_atime: bool) -> Result<Meta, Refusal> {
        Ok(dir_meta(1.0))
    }

    fn list(
        &self,
        dir: &Path,
        _want_atime: bool,
        buf: &mut ListBuffer,
    ) -> Result<FastPath, Refusal> {
        let entries = self.dirs.get(dir).ok_or(Refusal::Vanished)?;
        buf.listing.clear();
        for (name, meta) in entries {
            buf.listing.push(name.as_bytes(), *meta);
        }
        Ok(FastPath::ExtdDirInfo)
    }
}

struct NoPacer;

impl Pacer for NoPacer {
    fn on_worker_start(&self) {}
    fn throttle(&self, _cancelled: &dyn Fn() -> bool) {}
    fn worker_limit(&self) -> u32 {
        1
    }
}

fn walk(tree: ScriptedTree) -> Result<WalkOutput, String> {
    let root = tree.root.clone();
    let handle = start_with(WalkOptions::new(root), Arc::new(NoPacer), Arc::new(tree))
        .map_err(|e| e.to_string())?;
    handle.take().map_err(|e| e.to_string())
}

fn node_by_name(out: &WalkOutput, name: &str) -> Result<u32, String> {
    (0..out.len())
        .find(|i| out.name(*i) == Some(name.as_bytes()))
        .and_then(|i| u32::try_from(i).ok())
        .ok_or_else(|| format!("no node named {name:?}"))
}

#[test]
fn file_id_collisions_yield_exactly_the_legacy_hard_link_families() -> TestResult {
    let mut tree = ScriptedTree::new();
    // A family of three across two directories.
    tree.add("", "a.bin", file_meta(10.0, 700.0, false));
    tree.add("", "b.bin", file_meta(10.0, 700.0, false));
    tree.add("", "sub", dir_meta(2.0));
    tree.add("sub", "c.bin", file_meta(10.0, 700.0, false));
    // One link inside the scan, its sibling outside: a lone id.
    tree.add("", "lone.bin", file_meta(5.0, 701.0, false));
    // A directory sharing an id with the family: never a member.
    tree.add("", "dirx", dir_meta(700.0));
    // A second, independent family of two.
    tree.add("", "sub2", dir_meta(3.0));
    tree.add("sub2", "p.bin", file_meta(1.0, 800.0, false));
    tree.add("sub2", "q.bin", file_meta(1.0, 800.0, false));
    // Two withheld entries with the unknown id 0: never matched.
    tree.add("", "w1.bin", file_meta(1.0, 0.0, true));
    tree.add("sub", "w2.bin", file_meta(1.0, 0.0, true));
    // A symlink sharing an id with a file: symlinks are not keyed, as in the legacy walker.
    let mut link = file_meta(3.0, 701.0, false);
    link.kind = KIND_SYMLINK;
    tree.add("", "link", link);

    let out = walk(tree)?;
    let mut expected = vec![
        node_by_name(&out, "a.bin")?,
        node_by_name(&out, "b.bin")?,
        node_by_name(&out, "c.bin")?,
        node_by_name(&out, "p.bin")?,
        node_by_name(&out, "q.bin")?,
    ];
    expected.sort_unstable();
    let nodes: Vec<u32> = out.hardlinks.iter().map(|h| h.node).collect();
    assert_eq!(
        nodes, expected,
        "one ref per family member, sorted by node; none for the lone file, the directory, the symlink or the withheld ids"
    );
    for h in &out.hardlinks {
        assert_eq!(h.dev.to_bits(), f64::from(SERIAL).to_bits());
        let ino: f64 = if h.node < node_by_name(&out, "p.bin")? {
            700.0
        } else {
            800.0
        };
        assert_eq!(h.ino.to_bits(), ino.to_bits(), "node {}", h.node);
    }
    assert_eq!(out.stats.unreadable_entries, 2, "the two withheld entries");
    Ok(())
}

#[test]
fn a_link_count_that_was_reported_still_wins_over_collision_detection() -> TestResult {
    let mut tree = ScriptedTree::new();
    let mut counted = file_meta(10.0, 900.0, false);
    counted.nlink = 2;
    tree.add("", "counted.bin", counted);
    let mut single = file_meta(10.0, 901.0, false);
    single.nlink = 1;
    tree.add("", "single-a.bin", single);
    tree.add("", "single-b.bin", single);
    let out = walk(tree)?;
    let nodes: Vec<u32> = out.hardlinks.iter().map(|h| h.node).collect();
    assert_eq!(
        nodes,
        vec![node_by_name(&out, "counted.bin")?],
        "nlink 2 is a ref on its own; nlink 1 never enters the collision map even when ids repeat"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

#[test]
fn refusal_from_win32_classifies_as_libuv_then_the_legacy_walker_would() {
    for denied in [
        ERROR_ACCESS_DENIED,
        ERROR_NOACCESS,
        ERROR_ELEVATION_REQUIRED,
        ERROR_CANT_ACCESS_FILE,
        ERROR_PRIVILEGE_NOT_HELD,
    ] {
        assert_eq!(refusal_from_win32(denied), Refusal::Denied, "{denied}");
    }
    for vanished in [
        ERROR_FILE_NOT_FOUND,
        ERROR_PATH_NOT_FOUND,
        ERROR_INVALID_NAME,
        ERROR_INVALID_DRIVE,
        ERROR_INVALID_REPARSE_DATA,
        ERROR_DIRECTORY,
    ] {
        assert_eq!(
            refusal_from_win32(vanished),
            Refusal::Vanished,
            "{vanished}"
        );
    }
    assert_eq!(refusal_from_win32(ERROR_NOT_SUPPORTED), Refusal::Unreadable);
    assert_eq!(
        refusal_from_win32(ERROR_SHARING_VIOLATION),
        Refusal::Unreadable
    );
    assert_eq!(refusal_from_win32(0), Refusal::Unreadable);
}

#[test]
fn prefixed_path_adds_the_long_path_prefix_once_and_only_to_absolute_paths() {
    assert_eq!(prefixed_path("C:\\Users\\x"), "\\\\?\\C:\\Users\\x");
    assert_eq!(
        prefixed_path("c:/Users/x/"),
        "\\\\?\\c:\\Users\\x\\",
        "slashes become backslashes"
    );
    assert_eq!(prefixed_path("C:\\"), "\\\\?\\C:\\");
    assert_eq!(
        prefixed_path("\\\\server\\share\\dir"),
        "\\\\?\\UNC\\server\\share\\dir",
        "a UNC path gets the UNC form"
    );
    assert_eq!(prefixed_path("//server/share"), "\\\\?\\UNC\\server\\share");
    assert_eq!(
        prefixed_path("\\\\?\\C:\\x"),
        "\\\\?\\C:\\x",
        "already prefixed"
    );
    assert_eq!(prefixed_path("\\\\?\\UNC\\s\\t"), "\\\\?\\UNC\\s\\t");
    assert_eq!(
        prefixed_path("\\\\.\\PhysicalDrive0"),
        "\\\\.\\PhysicalDrive0",
        "a device path is left alone"
    );
    assert_eq!(
        prefixed_path("relative\\dir"),
        "relative\\dir",
        "a relative path cannot take the prefix"
    );
    assert_eq!(prefixed_path(""), "");
}

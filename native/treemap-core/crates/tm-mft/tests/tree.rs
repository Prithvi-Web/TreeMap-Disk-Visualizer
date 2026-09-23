//! The tree builder on synthetic record tables: the root's subtree only,
//! breadth first; DOS-only names dropped; a hard link in two directories as
//! two entries with one file reference; reparse points as symlink-kind leaves
//! sized by `tm_walk`'s `reparse_target_len`; `is_dataless`; times through
//! `filetime_ms`; children in `$UpCase` order; orphans, deleted records and
//! NTFS's own metafiles dropped; extension records merged into their base.
//! The last test lists the same volume the way the Windows listing does —
//! records packed as `FILE_ID_EXTD_DIR_INFO`, staged by `tm_walk`'s own
//! `stage_record`, walked by its own walk — and requires every column to
//! equal the builder's.

mod common;

use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::{
    DOS, POSIX, WIN32, WIN32_AND_DOS, appexeclink_buffer, link_buffer, tag_buffer, units,
};
use tm_mft::tree::{FIRST_USER_RECORD, UPCASE_UNITS};
use tm_mft::{
    BuildError, FileName, Record, RecordTable, StdInfo, build_tree, collate, with_root_name,
};
use tm_walk::platform::windows::{
    DirFacts, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_OFFLINE,
    FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_RECALL_ON_OPEN,
    FILE_ATTRIBUTE_REPARSE_POINT, IO_REPARSE_TAG_LX_SYMLINK, IO_REPARSE_TAG_MOUNT_POINT,
    IO_REPARSE_TAG_SYMLINK, IO_REPARSE_TAG_WOF, RECORD_HEADER_BYTES, Record as ListRecord,
    ReparseSource, filetime_ms, is_dataless, parse_records, stage_record,
};
use tm_walk::platform::{DirTimes, ListBuffer, Lister, Meta};
use tm_walk::walk::Pacer;
use tm_walk::{
    FLAG_DATALESS, FLAG_REFUSED_DIR, FastPath, KIND_DIR, KIND_FILE, KIND_SYMLINK, Refusal,
    WalkOptions, WalkOutput, start_with,
};

type TestResult = Result<(), String>;

/// A volume serial number like `GetFileInformationByHandle` reports.
const SERIAL: u32 = 0x9A3B_1C2D;
/// 2024-01-01T00:00:00Z as a FILETIME.
const FT: i64 = 133_485_408_000_000_000;
/// The scan root's record number in most tests.
const ROOT: u64 = 100;
/// `FILE_ATTRIBUTE_ARCHIVE`: the ordinary file.
const ARCHIVE: u32 = 0x20;
/// `IO_REPARSE_TAG_CLOUD_6`: what OneDrive stamps on its placeholders.
const TAG_CLOUD_6: u32 = 0x9000_601A;
/// `ERROR_NOT_A_REPARSE_POINT`, as `FSCTL_GET_REPARSE_POINT` fails on a file without one.
const ERROR_NOT_A_REPARSE_POINT: u32 = 4390;

fn si(attributes: u32) -> StdInfo {
    StdInfo {
        last_write: FT,
        last_access: FT + 10_000_000,
        attributes,
    }
}

fn named(parent: u64, parent_seq: u16, namespace: u8, name: &str) -> FileName {
    FileName {
        parent,
        parent_seq,
        namespace,
        name: units(name),
    }
}

/// An in-use directory, sequence 1, with one Win32 name under `parent` (sequence 1).
fn dir(number: u64, parent: u64, name: &str) -> Record {
    Record {
        number,
        sequence: 1,
        in_use: true,
        is_dir: true,
        std_info: Some(si(0)),
        names: vec![named(parent, 1, WIN32, name)],
        ..Record::default()
    }
}

/// An in-use file, sequence 1, with one Win32 name under `parent` (sequence 1).
fn file(number: u64, parent: u64, name: &str, size: u64) -> Record {
    Record {
        number,
        sequence: 1,
        in_use: true,
        is_dir: false,
        std_info: Some(si(ARCHIVE)),
        names: vec![named(parent, 1, WIN32, name)],
        data_size: Some(size),
        data_alloc: Some(size.next_multiple_of(4096)),
        ..Record::default()
    }
}

/// `r` made a reparse point holding `value`.
fn with_reparse(mut r: Record, value: Vec<u8>) -> Record {
    let s = r.std_info.unwrap_or_default();
    r.std_info = Some(StdInfo {
        attributes: s.attributes | FILE_ATTRIBUTE_REPARSE_POINT,
        ..s
    });
    r.reparse = Some(value);
    r
}

fn root() -> Record {
    dir(ROOT, 5, "root")
}

fn table(records: impl IntoIterator<Item = Record>) -> RecordTable {
    let mut t = RecordTable::new(SERIAL);
    for r in records {
        t.insert(r);
    }
    t
}

/// An `$UpCase` table that upper-cases ASCII letters and nothing else.
fn ascii_upcase() -> Vec<u16> {
    (0..=u16::MAX)
        .map(|u| {
            if (0x61..=0x7A).contains(&u) {
                u - 0x20
            } else {
                u
            }
        })
        .collect()
}

fn build(t: &RecordTable) -> Result<WalkOutput, String> {
    build_at(t, false)
}

fn build_at(t: &RecordTable, want_atime: bool) -> Result<WalkOutput, String> {
    build_tree(t, ROOT, &ascii_upcase(), want_atime).map_err(|e| format!("{e:?}"))
}

fn name_at(out: &WalkOutput, i: usize) -> String {
    out.name(i)
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .unwrap_or_default()
}

fn node(out: &WalkOutput, name: &str) -> Result<usize, String> {
    (0..out.len())
        .find(|i| out.name(*i) == Some(name.as_bytes()))
        .ok_or_else(|| format!("no node named {name:?}"))
}

/// The names of `parent`'s children, in node order.
fn children(out: &WalkOutput, parent: usize) -> Vec<String> {
    (1..out.len())
        .filter(|i| out.parent.get(*i).is_some_and(|p| *p as usize == parent))
        .map(|i| name_at(out, i))
        .collect()
}

fn at<T: Copy>(column: &[T], i: usize) -> Result<T, String> {
    column.get(i).copied().ok_or_else(|| format!("no row {i}"))
}

fn refused(out: &WalkOutput, i: usize) -> bool {
    out.refusals
        .iter()
        .any(|r| r.node as usize == i && r.why == Refusal::Unreadable)
        && out.flags.get(i).is_some_and(|f| f & FLAG_REFUSED_DIR != 0)
}

fn bits(column: &[f64]) -> Vec<u64> {
    column.iter().map(|x| x.to_bits()).collect()
}

// ---------------------------------------------------------------------------
// The subtree, names and links
// ---------------------------------------------------------------------------

#[test]
fn only_the_root_s_subtree_is_built_breadth_first() -> TestResult {
    let t = table([
        root(),
        file(101, ROOT, "a.txt", 1),
        dir(102, ROOT, "sub"),
        dir(103, 102, "deep"),
        file(104, 103, "x.bin", 2),
        dir(105, ROOT, "sub2"),
        file(106, 105, "y2.bin", 6),
        dir(200, 5, "outside"),
        file(201, 200, "y.bin", 3),
    ]);
    let out = build(&t)?;
    let names: Vec<String> = (0..out.len()).map(|i| name_at(&out, i)).collect();
    assert_eq!(
        names,
        ["root", "a.txt", "sub", "sub2", "deep", "y2.bin", "x.bin"],
        "level by level, as one worker of the walk lists: sub2's child before deep's"
    );
    assert_eq!(
        out.parent,
        vec![0, 0, 0, 0, 2, 3, 4],
        "every parent before its children"
    );
    assert_eq!(
        out.kind,
        vec![
            KIND_DIR, KIND_FILE, KIND_DIR, KIND_DIR, KIND_DIR, KIND_FILE, KIND_FILE
        ]
    );
    assert_eq!(out.size, vec![0.0, 1.0, 0.0, 0.0, 0.0, 6.0, 2.0]);
    assert_eq!(
        out.alloc_bytes,
        vec![0.0, 4096.0, 0.0, 0.0, 0.0, 4096.0, 4096.0]
    );
    assert_eq!(out.name_off.len(), out.len() + 1);
    Ok(())
}

#[test]
fn a_dos_only_name_is_never_an_entry_and_a_dos_alias_adds_none() -> TestResult {
    let mut long = file(101, ROOT, "Long Name.txt", 1);
    long.names.push(named(ROOT, 1, DOS, "LONGNA~1.TXT"));
    let mut dos_only = file(102, ROOT, "unused", 1);
    dos_only.names = vec![named(ROOT, 1, DOS, "DOSONLY.TXT")];
    let mut both = file(103, ROOT, "unused", 1);
    both.names = vec![named(ROOT, 1, WIN32_AND_DOS, "SHORT.TXT")];
    let mut posix = file(104, ROOT, "unused", 1);
    posix.names = vec![named(ROOT, 1, POSIX, "posix")];
    let out = build(&table([root(), long, dos_only, both, posix]))?;
    assert_eq!(children(&out, 0), ["Long Name.txt", "posix", "SHORT.TXT"]);
    assert!(out.hardlinks.is_empty(), "a DOS alias is not a second link");
    Ok(())
}

#[test]
fn a_hard_link_in_two_directories_is_two_entries_with_one_file_reference() -> TestResult {
    let mut linked = file(110, ROOT, "link-a", 77);
    linked.sequence = 3;
    linked.names.push(named(102, 1, WIN32, "link-b"));
    let mut lone = file(111, ROOT, "lone", 5);
    lone.names.push(named(200, 1, WIN32, "elsewhere"));
    let mut symlink = with_reparse(
        file(112, ROOT, "sym-1", 0),
        link_buffer(IO_REPARSE_TAG_SYMLINK, "\\??\\C:\\t"),
    );
    symlink.names.push(named(ROOT, 1, WIN32, "sym-2"));
    let t = table([
        root(),
        dir(102, ROOT, "sub"),
        linked,
        lone,
        symlink,
        dir(200, 5, "outside"),
    ]);
    let out = build(&t)?;
    let a = node(&out, "link-a")?;
    let b = node(&out, "link-b")?;
    let nodes: Vec<usize> = out.hardlinks.iter().map(|h| h.node as usize).collect();
    assert_eq!(
        nodes,
        vec![a, b],
        "both names; never the lone link, never a symlink's two names"
    );
    let reference = (3_u64 << 48) + 110;
    for h in &out.hardlinks {
        assert_eq!(h.dev.to_bits(), f64::from(SERIAL).to_bits());
        assert_eq!(
            h.ino.to_bits(),
            (reference as f64).to_bits(),
            "the file reference is the id"
        );
    }
    assert_eq!((at(&out.size, a)?, at(&out.size, b)?), (77.0, 77.0));
    Ok(())
}

// ---------------------------------------------------------------------------
// Reparse points, dataless entries and times: the listing's own rules
// ---------------------------------------------------------------------------

#[test]
fn a_symlink_or_junction_is_a_leaf_sized_by_its_target_and_never_descended() -> TestResult {
    let sym = with_reparse(
        file(106, ROOT, "sym", 0),
        link_buffer(IO_REPARSE_TAG_SYMLINK, "\\??\\C:\\target"),
    );
    let junc = with_reparse(
        dir(107, ROOT, "junc"),
        link_buffer(IO_REPARSE_TAG_MOUNT_POINT, "\\??\\D:\\x"),
    );
    let volume = with_reparse(
        dir(109, ROOT, "mnt"),
        link_buffer(IO_REPARSE_TAG_MOUNT_POINT, "\\??\\Volume{0}\\"),
    );
    let wof = with_reparse(
        file(110, ROOT, "wof.dll", 123_456),
        tag_buffer(IO_REPARSE_TAG_WOF, &[1, 0, 0, 0]),
    );
    let out = build(&table([
        root(),
        sym,
        junc,
        file(108, 107, "hidden.txt", 1),
        volume,
        wof,
    ]))?;
    assert_eq!(children(&out, 0), ["junc", "mnt", "sym", "wof.dll"]);
    for (name, size) in [
        ("sym", 9.0),           // C:\target
        ("junc", 4.0),          // D:\x
        ("mnt", 0.0),           // a volume mount point: the directory behind it
        ("wof.dll", 123_456.0), // a filter's tag: the file behind it
    ] {
        let i = node(&out, name)?;
        assert_eq!(at(&out.kind, i)?, KIND_SYMLINK, "{name}");
        assert_eq!(at(&out.size, i)?.to_bits(), f64::to_bits(size), "{name}");
    }
    assert!(
        node(&out, "hidden.txt").is_err(),
        "a junction is never descended"
    );
    assert_eq!(out.stats.dirs_listed, 1, "only the root was listed");
    Ok(())
}

#[test]
fn cloud_placeholders_and_recall_attributes_are_dataless() -> TestResult {
    let mut cloud = with_reparse(
        file(109, ROOT, "cloud.docx", 5000),
        tag_buffer(TAG_CLOUD_6, &[0; 8]),
    );
    cloud.data_alloc = Some(0);
    cloud.std_info = cloud.std_info.map(|s| StdInfo {
        attributes: s.attributes | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
        ..s
    });
    let mut offline = file(120, ROOT, "offline.dat", 10);
    offline.std_info = Some(si(ARCHIVE | FILE_ATTRIBUTE_OFFLINE));
    let out = build(&table([
        root(),
        cloud,
        offline,
        file(121, ROOT, "plain.txt", 10),
    ]))?;
    let facts = |name: &str| -> Result<(u8, u8), String> {
        let i = node(&out, name)?;
        Ok((at(&out.kind, i)?, at(&out.flags, i)?))
    };
    assert_eq!(facts("cloud.docx")?, (KIND_SYMLINK, FLAG_DATALESS));
    assert_eq!(facts("offline.dat")?, (KIND_FILE, FLAG_DATALESS));
    assert_eq!(facts("plain.txt")?, (KIND_FILE, 0));
    let i = node(&out, "cloud.docx")?;
    assert_eq!(
        at(&out.size, i)?.to_bits(),
        5000.0_f64.to_bits(),
        "the logical size"
    );
    assert_eq!(
        at(&out.alloc_bytes, i)?.to_bits(),
        0.0_f64.to_bits(),
        "nothing allocated, which the ingest reads as a placeholder"
    );
    assert_eq!(out.stats.dataless, 2);
    Ok(())
}

#[test]
fn times_are_standard_information_s_through_filetime_ms() -> TestResult {
    let mut f = file(101, ROOT, "t.txt", 1);
    f.std_info = Some(StdInfo {
        last_write: FT,
        last_access: FT + 12_345_678,
        attributes: ARCHIVE,
    });
    let mut r = root();
    r.std_info = Some(StdInfo {
        last_write: FT - 10_000_000,
        last_access: FT - 20_000_000,
        attributes: 0,
    });
    let t = table([r, f]);
    assert_eq!(
        filetime_ms(FT).to_bits(),
        1_704_067_200_000.0_f64.to_bits(),
        "2024-01-01 in ms"
    );
    let out = build_at(&t, false)?;
    let i = node(&out, "t.txt")?;
    assert_eq!(at(&out.mtime_ms, i)?.to_bits(), filetime_ms(FT).to_bits());
    assert!(
        at(&out.atime_ms, i)?.is_nan(),
        "no access time unless asked"
    );
    assert_eq!(
        at(&out.mtime_ms, 0)?.to_bits(),
        filetime_ms(FT - 10_000_000).to_bits(),
        "the root's own record"
    );
    assert!(at(&out.atime_ms, 0)?.is_nan());
    let out = build_at(&t, true)?;
    assert_eq!(
        at(&out.atime_ms, i)?.to_bits(),
        filetime_ms(FT + 12_345_678).to_bits()
    );
    assert_eq!(
        at(&out.atime_ms, 0)?.to_bits(),
        filetime_ms(FT - 20_000_000).to_bits()
    );
    Ok(())
}

#[test]
fn a_reparse_point_the_listing_cannot_stat_is_counted_not_listed() -> TestResult {
    let wsl = with_reparse(
        file(111, ROOT, "wsl", 0),
        tag_buffer(IO_REPARSE_TAG_LX_SYMLINK, b"target"),
    );
    let alias = with_reparse(
        file(112, ROOT, "alias", 0),
        appexeclink_buffer(&["pkg", "app"]),
    );
    let mut broken = file(113, ROOT, "broken", 0);
    broken.std_info = Some(si(ARCHIVE | FILE_ATTRIBUTE_REPARSE_POINT));
    let mut remote = file(114, ROOT, "remote", 0);
    remote.std_info = Some(si(ARCHIVE | FILE_ATTRIBUTE_REPARSE_POINT));
    remote.reparse_nonresident = true;
    let out = build(&table([
        root(),
        wsl,
        alias,
        broken,
        remote,
        file(115, ROOT, "ok.txt", 1),
        dir(116, ROOT, "zdir"),
        file(117, 116, "inside.txt", 1),
    ]))?;
    assert_eq!(children(&out, 0), ["ok.txt", "zdir"]);
    assert_eq!(
        children(&out, node(&out, "zdir")?),
        ["inside.txt"],
        "a directory after omitted entries is still listed as itself"
    );
    assert_eq!(
        out.stats.denied_entries, 2,
        "a WSL link and an alias libuv cannot read: lstat's EACCES"
    );
    assert_eq!(
        out.stats.unreadable_entries, 2,
        "reparse points whose value the record does not hold"
    );
    Ok(())
}

#[test]
fn a_record_missing_its_times_or_its_size_is_kept_withheld() -> TestResult {
    let mut no_times = file(200, ROOT, "no-times", 10);
    no_times.std_info = None;
    no_times.names.push(named(ROOT, 1, WIN32, "no-times-2"));
    let mut no_size = file(201, ROOT, "no-size", 0);
    no_size.data_size = None;
    no_size.data_alloc = None;
    let out = build(&table([root(), no_times, no_size]))?;
    for name in ["no-times", "no-times-2"] {
        let i = node(&out, name)?;
        assert!(at(&out.mtime_ms, i)?.is_nan(), "{name}");
        assert_eq!(
            at(&out.size, i)?.to_bits(),
            10.0_f64.to_bits(),
            "{name}: the size is still known"
        );
    }
    let i = node(&out, "no-size")?;
    assert_eq!((at(&out.size, i)?, at(&out.alloc_bytes, i)?), (0.0, 0.0));
    assert_eq!(out.stats.unreadable_entries, 3);
    assert!(
        out.hardlinks.is_empty(),
        "a withheld entry is never a hard-link member"
    );
    Ok(())
}

#[test]
fn a_name_is_cut_at_its_first_nul_unit() -> TestResult {
    let out = build(&table([root(), file(101, ROOT, "abc\u{0}def", 1)]))?;
    assert_eq!(children(&out, 0), ["abc"]);
    Ok(())
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

#[test]
fn children_are_in_the_volume_s_upcase_order() -> TestResult {
    let t = table([
        root(),
        file(101, ROOT, "_x", 1),
        file(102, ROOT, "b", 1),
        file(103, ROOT, "A", 1),
        file(104, ROOT, "a", 1),
        file(105, ROOT, "ab", 1),
    ]);
    let out = build(&t)?;
    assert_eq!(
        children(&out, 0),
        ["A", "a", "ab", "b", "_x"],
        "'a' and 'A' together, a prefix first, '_' after 'Z' (byte order: A _x a ab b)"
    );
    // The volume's own table decides, not a built-in case rule: here 'q'
    // upper-cases to 'A', so it sorts before 'B'.
    let mut odd = ascii_upcase();
    *odd.get_mut(usize::from(b'q')).ok_or("q")? = u16::from(b'A');
    let t = table([root(), file(101, ROOT, "B", 1), file(102, ROOT, "q", 1)]);
    let out = build_tree(&t, ROOT, &odd, false).map_err(|e| format!("{e:?}"))?;
    assert_eq!(children(&out, 0), ["q", "B"]);
    Ok(())
}

#[test]
fn collate_compares_upcased_units_then_length_then_raw_units() {
    let up = ascii_upcase();
    assert_eq!(collate(&units("abc"), &units("ABD"), &up), Ordering::Less);
    assert_eq!(
        collate(&units("ab"), &units("ABC"), &up),
        Ordering::Less,
        "a prefix first"
    );
    assert_eq!(
        collate(&units("A"), &units("a"), &up),
        Ordering::Less,
        "equal once upcased: the raw units decide"
    );
    assert_eq!(collate(&units("a"), &units("a"), &up), Ordering::Equal);
    assert_eq!(
        collate(&units("_"), &units("z"), &up),
        Ordering::Greater,
        "'_' (0x5F) after 'Z' (0x5A)"
    );
    assert_eq!(
        collate(&units("b"), &units("A"), &[]),
        Ordering::Greater,
        "a unit past the table is its own upcase"
    );
}

// ---------------------------------------------------------------------------
// What is never an entry
// ---------------------------------------------------------------------------

#[test]
fn an_orphan_whose_parent_sequence_no_longer_matches_is_dropped() -> TestResult {
    let mut orphan = file(130, ROOT, "unused", 1);
    orphan.names = vec![named(ROOT, 7, WIN32, "orphan.txt")];
    let mut reused = dir(140, ROOT, "reused");
    reused.sequence = 2;
    let stale = file(141, 140, "stale.txt", 1);
    let mut fresh = file(142, 140, "unused", 1);
    fresh.names = vec![named(140, 2, WIN32, "fresh.txt")];
    let out = build(&table([
        root(),
        file(131, ROOT, "kept.txt", 1),
        orphan,
        reused,
        stale,
        fresh,
    ]))?;
    assert_eq!(children(&out, 0), ["kept.txt", "reused"]);
    assert_eq!(children(&out, node(&out, "reused")?), ["fresh.txt"]);
    Ok(())
}

#[test]
fn a_record_not_in_use_is_never_an_entry() -> TestResult {
    let mut gone = file(150, ROOT, "gone.txt", 1);
    gone.in_use = false;
    let mut gone_dir = dir(151, ROOT, "gone-dir");
    gone_dir.in_use = false;
    let t = table([
        root(),
        gone,
        gone_dir,
        file(152, 151, "under-gone.txt", 1),
        file(153, ROOT, "here.txt", 1),
    ]);
    assert!(t.get(150).is_none() && t.get(151).is_none());
    let out = build(&t)?;
    assert_eq!(children(&out, 0), ["here.txt"]);
    Ok(())
}

#[test]
fn records_below_16_are_never_entries() -> TestResult {
    let mut volume_root = dir(5, 5, "unused");
    volume_root.sequence = 5;
    volume_root.names = vec![named(5, 5, WIN32_AND_DOS, ".")];
    let in_root = |mut r: Record, name: &str| {
        r.names = vec![named(5, 5, WIN32_AND_DOS, name)];
        r
    };
    let mut extend = in_root(dir(11, 5, "unused"), "$Extend");
    extend.sequence = 11;
    let mut quota = file(24, 11, "unused", 0);
    quota.names = vec![named(11, 11, WIN32_AND_DOS, "$Quota")];
    let t = table([
        volume_root,
        in_root(file(0, 5, "unused", 1), "$MFT"),
        in_root(file(10, 5, "unused", 1), "$UpCase"),
        in_root(file(15, 5, "unused", 1), "reserved"),
        extend,
        quota,
        in_root(file(16, 5, "unused", 1), "first-user"),
        in_root(file(40, 5, "unused", 1), "pagefile.sys"),
    ]);
    let out = build_tree(&t, 5, &ascii_upcase(), false).map_err(|e| format!("{e:?}"))?;
    assert_eq!(
        children(&out, 0),
        ["first-user", "pagefile.sys"],
        "$MFT, $UpCase, record 15, $Extend and the root's own '.' are hidden"
    );
    assert_eq!(name_at(&out, 0), ".", "until with_root_name names it");
    assert_eq!(FIRST_USER_RECORD, 16);
    Ok(())
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

#[test]
fn a_directory_whose_name_holds_a_separator_is_refused_and_not_descended() -> TestResult {
    let mut back = dir(170, ROOT, "unused");
    back.names = vec![named(ROOT, 1, POSIX, "a\\b")];
    let mut slash = dir(172, ROOT, "unused");
    slash.names = vec![named(ROOT, 1, POSIX, "c/d")];
    let mut named_file = file(174, ROOT, "unused", 1);
    named_file.names = vec![named(ROOT, 1, POSIX, "e\\f.txt")];
    let out = build(&table([
        root(),
        back,
        file(171, 170, "under.txt", 1),
        slash,
        file(173, 172, "under2.txt", 1),
        named_file,
    ]))?;
    for name in ["a\\b", "c/d"] {
        assert!(refused(&out, node(&out, name)?), "{name}");
    }
    assert!(node(&out, "under.txt").is_err() && node(&out, "under2.txt").is_err());
    assert_eq!(
        at(&out.flags, node(&out, "e\\f.txt")?)?,
        0,
        "a file's name is never joined onto a path, so never refused"
    );
    assert_eq!(out.stats.dirs_listed, 1);
    Ok(())
}

/// Runs `f` on its own thread and waits at most `secs` for its answer, so a
/// build that never ends fails the test instead of hanging the suite.
fn within<T: Send + 'static>(
    secs: u64,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || tx.send(f()));
    rx.recv_timeout(std::time::Duration::from_secs(secs))
        .map_err(|_| format!("the build gave no answer within {secs} s"))
}

#[test]
fn a_directory_named_twice_is_listed_once_and_refused_after() -> TestResult {
    let mut twice = dir(180, ROOT, "one");
    twice.names.push(named(ROOT, 1, WIN32, "two"));
    let out = build(&table([root(), twice, file(181, 180, "child.txt", 1)]))?;
    let names: Vec<String> = (0..out.len()).map(|i| name_at(&out, i)).collect();
    assert_eq!(names, ["root", "one", "two", "child.txt"]);
    assert!(
        !refused(&out, node(&out, "one")?),
        "the first name is listed"
    );
    assert!(refused(&out, node(&out, "two")?), "the second is refused");
    assert_eq!(out.stats.dirs_listed, 2, "root, one");
    Ok(())
}

#[test]
fn a_cycle_of_directories_ends_in_a_refusal() -> TestResult {
    // 190 in the root, 191 in 190, and 190 named again inside 191.
    let out = within(2, || {
        let mut looped = dir(190, ROOT, "loop");
        looped.names.push(named(191, 1, WIN32, "back"));
        build(&table([root(), looped, dir(191, 190, "inner")]))
    })??;
    let names: Vec<String> = (0..out.len()).map(|i| name_at(&out, i)).collect();
    assert_eq!(names, ["root", "loop", "inner", "back"]);
    assert!(refused(&out, node(&out, "back")?), "the cycle ends");
    assert_eq!(out.stats.dirs_listed, 3, "root, loop, inner");
    Ok(())
}

// ---------------------------------------------------------------------------
// The record table
// ---------------------------------------------------------------------------

#[test]
fn extension_records_are_merged_into_their_base_in_any_order() -> TestResult {
    let base = Record {
        number: 160,
        sequence: 4,
        in_use: true,
        std_info: Some(si(ARCHIVE)),
        names: vec![named(ROOT, 1, WIN32, "big.bin")],
        ..Record::default()
    };
    let extension = |number: u64, base_seq: u16| Record {
        number,
        sequence: 1,
        in_use: true,
        base: 160,
        base_seq,
        ..Record::default()
    };
    let second_link = Record {
        names: vec![named(ROOT, 1, WIN32, "big-link.bin")],
        ..extension(161, 4)
    };
    let data = Record {
        data_size: Some(1_000_000),
        data_alloc: Some(1_003_520),
        ..extension(162, 4)
    };
    let stale = Record {
        names: vec![named(ROOT, 1, WIN32, "stale.bin")],
        data_size: Some(9),
        ..extension(163, 3)
    };
    let orphaned = Record {
        base: 170,
        names: vec![named(ROOT, 1, WIN32, "no-base.bin")],
        ..extension(164, 1)
    };
    // One extension before its base, one after, one stale, one whose base never comes.
    let t = table([root(), second_link, stale, base, data, orphaned]);
    assert_eq!(t.len(), 2, "the root and one merged file");
    let out = build(&t)?;
    assert_eq!(children(&out, 0), ["big-link.bin", "big.bin"]);
    for name in ["big.bin", "big-link.bin"] {
        let i = node(&out, name)?;
        assert_eq!(
            at(&out.size, i)?.to_bits(),
            1_000_000.0_f64.to_bits(),
            "{name}"
        );
        assert_eq!(
            at(&out.alloc_bytes, i)?.to_bits(),
            1_003_520.0_f64.to_bits(),
            "{name}"
        );
        assert_eq!(
            at(&out.mtime_ms, i)?.to_bits(),
            filetime_ms(FT).to_bits(),
            "{name}: the base's $STANDARD_INFORMATION"
        );
    }
    assert_eq!(out.hardlinks.len(), 2, "two names of one record: a family");
    Ok(())
}

#[test]
fn a_base_keeps_its_own_attributes_over_an_extension_s() -> TestResult {
    let base = file(165, ROOT, "own.bin", 10);
    let ext = Record {
        number: 166,
        sequence: 1,
        in_use: true,
        base: 165,
        base_seq: 1,
        std_info: Some(StdInfo {
            last_write: 1,
            last_access: 1,
            attributes: FILE_ATTRIBUTE_OFFLINE,
        }),
        data_size: Some(99),
        data_alloc: Some(104),
        ..Record::default()
    };
    let link = with_reparse(
        file(175, ROOT, "own-link", 0),
        link_buffer(IO_REPARSE_TAG_SYMLINK, "\\??\\C:\\a"),
    );
    let link_ext = Record {
        number: 176,
        sequence: 1,
        in_use: true,
        base: 175,
        base_seq: 1,
        reparse: Some(link_buffer(IO_REPARSE_TAG_SYMLINK, "\\??\\C:\\abcdef")),
        ..Record::default()
    };
    let out = build(&table([root(), base, ext, link, link_ext]))?;
    let i = node(&out, "own.bin")?;
    assert_eq!(
        (at(&out.size, i)?, at(&out.alloc_bytes, i)?),
        (10.0, 4096.0)
    );
    assert_eq!(at(&out.flags, i)?, 0, "the base's attributes");
    assert_eq!(at(&out.mtime_ms, i)?.to_bits(), filetime_ms(FT).to_bits());
    let j = node(&out, "own-link")?;
    assert_eq!(
        at(&out.size, j)?.to_bits(),
        4.0_f64.to_bits(),
        "the base's own target, C:\\a"
    );
    Ok(())
}

#[test]
fn an_extension_supplies_every_attribute_its_base_lacks() -> TestResult {
    let base = Record {
        number: 167,
        sequence: 2,
        in_use: true,
        names: vec![named(ROOT, 1, WIN32, "parts")],
        ..Record::default()
    };
    let ext = |number: u64| Record {
        number,
        sequence: 1,
        in_use: true,
        base: 167,
        base_seq: 2,
        ..Record::default()
    };
    let t = table([
        Record {
            std_info: Some(si(ARCHIVE)),
            ..ext(168)
        },
        base,
        Record {
            reparse: Some(vec![1, 2, 3, 4]),
            data_size: Some(50),
            data_alloc: Some(56),
            ..ext(169)
        },
        Record {
            reparse_nonresident: true,
            ..ext(170)
        },
    ]);
    let merged = t.get(167).ok_or("no base")?;
    assert_eq!(merged.std_info, Some(si(ARCHIVE)));
    assert_eq!((merged.data_size, merged.data_alloc), (Some(50), Some(56)));
    assert_eq!(merged.reparse.as_deref(), Some(&[1_u8, 2, 3, 4][..]));
    assert!(merged.reparse_nonresident);
    assert_eq!(merged.names.len(), 1);
    assert!(
        t.get(168).is_none(),
        "an extension is never a record of its own"
    );
    assert_eq!(t.len(), 1);
    Ok(())
}

// ---------------------------------------------------------------------------
// The root, the stats and the root's name
// ---------------------------------------------------------------------------

#[test]
fn the_root_must_be_an_in_use_directory_that_is_not_a_reparse_point() {
    let up = ascii_upcase();
    let t = table([
        root(),
        file(101, ROOT, "f", 1),
        with_reparse(
            dir(102, ROOT, "j"),
            link_buffer(IO_REPARSE_TAG_MOUNT_POINT, "\\??\\D:\\x"),
        ),
    ]);
    assert_eq!(
        build_tree(&t, 999, &up, false).err(),
        Some(BuildError::RootNotFound { root: 999 })
    );
    assert_eq!(
        build_tree(&t, 101, &up, false).err(),
        Some(BuildError::RootNotDirectory { root: 101 })
    );
    assert_eq!(
        build_tree(&t, 102, &up, false).err(),
        Some(BuildError::RootIsReparsePoint { root: 102 })
    );
    assert_eq!(
        build_tree(&t, ROOT, up.get(..100).unwrap_or_default(), false).err(),
        Some(BuildError::BadUpcase { units: 100 })
    );
    assert_eq!(UPCASE_UNITS, 65_536);
}

#[test]
fn the_root_keeps_its_own_flags_and_name_and_is_not_counted() -> TestResult {
    let mut r = root();
    r.std_info = Some(si(FILE_ATTRIBUTE_RECALL_ON_OPEN));
    r.names = vec![named(5, 1, DOS, "ROOTDI~1"), named(5, 1, WIN32, "root dir")];
    let out = build(&table([r, file(101, ROOT, "f", 1)]))?;
    assert_eq!(
        name_at(&out, 0),
        "root dir",
        "its first name that is not a DOS alias"
    );
    assert_eq!(at(&out.flags, 0)?, FLAG_DATALESS);
    assert_eq!(out.stats.dataless, 0, "the root is not an entry");
    Ok(())
}

#[test]
fn the_stats_count_what_was_built() -> TestResult {
    let out = build(&table([
        root(),
        dir(102, ROOT, "sub"),
        dir(103, 102, "empty"),
        file(104, 102, "f", 1),
        file(105, ROOT, "g", 1),
    ]))?;
    let s = &out.stats;
    assert_eq!(s.dirs_listed, 3, "the root, sub and empty");
    assert_eq!(s.entries, 4);
    assert_eq!(u64::try_from(out.len()).unwrap_or(0), s.entries + 1);
    assert_eq!(
        (s.denied_entries, s.unreadable_entries, s.dataless),
        (0, 0, 0)
    );
    assert_eq!((s.workers_peak, s.climb_steps), (1, 0));
    assert_eq!(
        s.fast_path,
        FastPath::Unavailable,
        "a placeholder until FastPath has a variant for the MFT"
    );
    assert!(s.wall_ms.is_finite() && s.wall_ms >= 0.0);
    Ok(())
}

#[test]
fn with_root_name_replaces_node_0_s_name_and_nothing_else() -> TestResult {
    let out = build(&table([
        root(),
        file(101, ROOT, "a", 1),
        file(102, ROOT, "bb", 1),
    ]))?;
    let renamed = with_root_name(out.clone(), "C:\\").map_err(|e| format!("{e:?}"))?;
    let names: Vec<String> = (0..renamed.len()).map(|i| name_at(&renamed, i)).collect();
    assert_eq!(names, ["C:\\", "a", "bb"]);
    assert_eq!(renamed.name_off, vec![0, 3, 4, 6]);
    assert_eq!(renamed.parent, out.parent);
    assert_eq!(bits(&renamed.mtime_ms), bits(&out.mtime_ms));
    Ok(())
}

// ---------------------------------------------------------------------------
// The oracle: the same volume, listed as the Windows listing lists it
// ---------------------------------------------------------------------------

/// A `FILE_ID_EXTD_DIR_INFO` for `name` of `rec`: the test's statement of
/// what NTFS enumeration reports from the directory's index, field by field.
fn extd_record(name: &[u16], rec: &Record, has_next: bool) -> Vec<u8> {
    let s = rec.std_info.unwrap_or_default();
    let dir_bit = if rec.is_dir {
        FILE_ATTRIBUTE_DIRECTORY
    } else {
        0
    };
    let attributes = s.attributes | dir_bit;
    let tag = if attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        0
    } else {
        rec.reparse
            .as_deref()
            .and_then(|v| v.get(..4))
            .and_then(|b| <[u8; 4]>::try_from(b).ok())
            .map_or(0, u32::from_le_bytes)
    };
    let size = |v: Option<u64>| {
        if rec.is_dir {
            0
        } else {
            i64::try_from(v.unwrap_or(0)).unwrap_or(i64::MAX)
        }
    };
    let name_bytes: Vec<u8> = name.iter().flat_map(|u| u.to_le_bytes()).collect();
    let padded = (RECORD_HEADER_BYTES + name_bytes.len()).div_ceil(8) * 8;
    let next = if has_next { padded } else { 0 };
    let mut out = Vec::with_capacity(padded);
    out.extend(u32::try_from(next).unwrap_or(0).to_le_bytes()); // NextEntryOffset
    out.extend(0_u32.to_le_bytes()); // FileIndex
    out.extend(0_i64.to_le_bytes()); // CreationTime
    out.extend(s.last_access.to_le_bytes()); // LastAccessTime
    out.extend(s.last_write.to_le_bytes()); // LastWriteTime
    out.extend(s.last_write.to_le_bytes()); // ChangeTime
    out.extend(size(rec.data_size).to_le_bytes()); // EndOfFile
    out.extend(size(rec.data_alloc).to_le_bytes()); // AllocationSize
    out.extend(attributes.to_le_bytes()); // FileAttributes
    out.extend(u32::try_from(name_bytes.len()).unwrap_or(0).to_le_bytes()); // FileNameLength
    out.extend(0_u32.to_le_bytes()); // EaSize
    out.extend(tag.to_le_bytes()); // ReparsePointTag
    out.extend(u128::from(rec.reference()).to_le_bytes()); // FileId
    out.extend(&name_bytes);
    if has_next {
        out.resize(padded, 0);
    }
    out
}

/// A volume listed directory by directory, in the order its index returns.
struct Oracle {
    root: PathBuf,
    records: HashMap<u64, Record>,
    /// Each directory's names, in NTFS index order, written out by hand.
    order: HashMap<u64, Vec<(u64, usize)>>,
    /// Every directory the walk will list, by the path it will ask for.
    dirs: HashMap<PathBuf, u64>,
}

impl Oracle {
    fn new(records: &[Record], order: Vec<(u64, Vec<(u64, usize)>)>, root: PathBuf) -> Self {
        let records: HashMap<u64, Record> = records.iter().map(|r| (r.number, r.clone())).collect();
        let order: HashMap<u64, Vec<(u64, usize)>> = order.into_iter().collect();
        let mut dirs = HashMap::new();
        let mut pending = vec![(root.clone(), ROOT)];
        while let Some((path, number)) = pending.pop() {
            for &(child, idx) in order.get(&number).map_or(&[][..], Vec::as_slice) {
                let name = records
                    .get(&child)
                    .and_then(|r| r.names.get(idx))
                    .map(|n| String::from_utf16_lossy(&n.name))
                    .unwrap_or_default();
                if order.contains_key(&child) {
                    pending.push((path.join(name), child));
                }
            }
            dirs.insert(path, number);
        }
        Self {
            root,
            records,
            order,
            dirs,
        }
    }

    fn times(&self, number: u64, want_atime: bool) -> DirTimes {
        let s = self
            .records
            .get(&number)
            .and_then(|r| r.std_info)
            .unwrap_or_default();
        DirTimes {
            mtime_ms: filetime_ms(s.last_write),
            atime_ms: if want_atime {
                filetime_ms(s.last_access)
            } else {
                f64::NAN
            },
        }
    }
}

/// Each child's reparse data, as `FSCTL_GET_REPARSE_POINT` would return it.
struct OracleReparse<'a> {
    oracle: &'a Oracle,
    dir: u64,
}

impl ReparseSource for OracleReparse<'_> {
    fn reparse_data(&self, _dir: &Path, name: &[u16]) -> Result<Vec<u8>, u32> {
        self.oracle
            .order
            .get(&self.dir)
            .into_iter()
            .flatten()
            .filter_map(|&(child, idx)| self.oracle.records.get(&child).map(|r| (r, idx)))
            .find(|(r, idx)| r.names.get(*idx).is_some_and(|n| n.name == name))
            .and_then(|(r, _)| r.reparse.clone())
            .ok_or(ERROR_NOT_A_REPARSE_POINT)
    }
}

impl Lister for Oracle {
    fn stat_dir(&self, _path: &Path, want_atime: bool) -> Result<Meta, Refusal> {
        let r = self.records.get(&ROOT).ok_or(Refusal::Vanished)?;
        let s = r.std_info.unwrap_or_default();
        let times = self.times(ROOT, want_atime);
        Ok(Meta {
            kind: KIND_DIR,
            flags: if is_dataless(s.attributes, 0) {
                FLAG_DATALESS
            } else {
                0
            },
            size: 0.0,
            alloc: 0.0,
            mtime_ms: times.mtime_ms,
            atime_ms: times.atime_ms,
            dev: f64::from(SERIAL),
            ino: r.reference() as f64,
            nlink: 0,
            withheld: false,
        })
    }

    fn list(
        &self,
        dir: &Path,
        want_atime: bool,
        buf: &mut ListBuffer,
    ) -> Result<FastPath, Refusal> {
        buf.listing.clear();
        let number = *self.dirs.get(dir).ok_or(Refusal::Vanished)?;
        let kids = self.order.get(&number).cloned().unwrap_or_default();
        let mut raw = Vec::new();
        for (k, &(child, idx)) in kids.iter().enumerate() {
            let rec = self.records.get(&child).ok_or(Refusal::Unreadable)?;
            let name = &rec.names.get(idx).ok_or(Refusal::Unreadable)?.name;
            raw.extend(extd_record(name, rec, k + 1 < kids.len()));
        }
        let facts = DirFacts {
            dev: SERIAL,
            want_atime,
        };
        let reparse = OracleReparse {
            oracle: self,
            dir: number,
        };
        let listing = &mut buf.listing;
        parse_records(&raw, &mut |rec: &ListRecord<'_>| {
            stage_record(rec, facts, dir, &reparse, listing);
        })
        .map_err(|_| Refusal::Unreadable)?;
        buf.listing.own_times = Some(self.times(number, want_atime));
        Ok(FastPath::ExtdDirInfo)
    }
}

/// One worker, so the walk lists breadth first.
struct OneWorker;

impl Pacer for OneWorker {
    fn on_worker_start(&self) {}
    fn throttle(&self, _cancelled: &dyn Fn() -> bool) {}
    fn worker_limit(&self) -> u32 {
        1
    }
}

fn walk_listing(oracle: Oracle, want_atime: bool) -> Result<WalkOutput, String> {
    let mut opts = WalkOptions::new(oracle.root.clone());
    opts.want_atime = want_atime;
    let handle =
        start_with(opts, Arc::new(OneWorker), Arc::new(oracle)).map_err(|e| e.to_string())?;
    handle.take().map_err(|e| e.to_string())
}

fn assert_same_columns(mft: &WalkOutput, walk: &WalkOutput) {
    assert_eq!(
        String::from_utf8_lossy(&mft.names),
        String::from_utf8_lossy(&walk.names),
        "names"
    );
    assert_eq!(mft.name_off, walk.name_off, "name offsets");
    assert_eq!(mft.parent, walk.parent, "parents");
    assert_eq!(mft.kind, walk.kind, "kinds");
    assert_eq!(mft.flags, walk.flags, "flags");
    assert_eq!(bits(&mft.size), bits(&walk.size), "sizes");
    assert_eq!(
        bits(&mft.alloc_bytes),
        bits(&walk.alloc_bytes),
        "allocations"
    );
    assert_eq!(bits(&mft.mtime_ms), bits(&walk.mtime_ms), "mtimes");
    assert_eq!(bits(&mft.atime_ms), bits(&walk.atime_ms), "atimes");
    let links = |o: &WalkOutput| -> Vec<(u32, u64, u64)> {
        o.hardlinks
            .iter()
            .map(|h| (h.node, h.dev.to_bits(), h.ino.to_bits()))
            .collect()
    };
    assert_eq!(links(mft), links(walk), "hard links");
    assert_eq!(mft.refusals, walk.refusals, "refusals");
    let counts = |o: &WalkOutput| {
        let s = &o.stats;
        (
            s.dirs_listed,
            s.entries,
            s.denied_entries,
            s.unreadable_entries,
            s.dataless,
        )
    };
    assert_eq!(
        counts(mft),
        counts(walk),
        "dirs listed, entries, denied, unreadable, dataless"
    );
}

#[test]
fn the_columns_equal_the_listing_walk_s_on_the_same_volume() -> TestResult {
    let mut r = root();
    r.std_info = Some(StdInfo {
        last_write: FT - 7_000_000,
        last_access: FT - 3_000_000,
        attributes: 0,
    });
    let mut sub = dir(103, ROOT, "sub");
    sub.std_info = Some(StdInfo {
        last_write: FT + 5_000_000,
        last_access: FT + 6_000_000,
        attributes: 0,
    });
    let mut linked = file(110, ROOT, "link-b", 77);
    linked.sequence = 3;
    linked.names.push(named(103, 1, WIN32, "link-a"));
    let mut long = file(106, ROOT, "long name.txt", 1234);
    long.names.push(named(ROOT, 1, DOS, "LONGNA~1.TXT"));
    let mut cloud = with_reparse(
        file(109, ROOT, "cloud.docx", 5000),
        tag_buffer(TAG_CLOUD_6, &[0; 8]),
    );
    cloud.data_alloc = Some(0);
    cloud.std_info = cloud.std_info.map(|s| StdInfo {
        attributes: s.attributes | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
        ..s
    });
    let mut orphan = file(113, ROOT, "unused", 1);
    orphan.names = vec![named(ROOT, 9, WIN32, "orphan.txt")];
    let mut dos_only = file(114, ROOT, "unused", 1);
    dos_only.names = vec![named(ROOT, 1, DOS, "DOSONLY.TXT")];
    let records = vec![
        r,
        file(101, ROOT, "b.txt", 10),
        file(102, ROOT, "A.txt", 5000),
        sub,
        file(104, 103, "inner.bin", 30),
        dir(105, 103, "deeper"),
        file(115, 105, "leaf", 3),
        linked,
        long,
        with_reparse(
            file(107, ROOT, "sym", 0),
            link_buffer(IO_REPARSE_TAG_SYMLINK, "\\??\\C:\\target"),
        ),
        with_reparse(
            dir(108, ROOT, "junc"),
            link_buffer(IO_REPARSE_TAG_MOUNT_POINT, "\\??\\D:\\x"),
        ),
        file(118, 108, "hidden.txt", 1),
        cloud,
        with_reparse(
            file(111, ROOT, "wsl", 0),
            tag_buffer(IO_REPARSE_TAG_LX_SYMLINK, b"t"),
        ),
        dir(112, ROOT, "Zeta"),
        orphan,
        dos_only,
    ];
    // What NTFS returns for each listed directory, in index order: upcased
    // A.TXT B.TXT CLOUD.DOCX JUNC LINK-B LONG NAME.TXT SUB SYM WSL ZETA, then
    // DEEPER INNER.BIN LINK-A. The orphan and the DOS-only name are not in
    // any index a listing returns.
    let order = vec![
        (
            ROOT,
            vec![
                (102, 0),
                (101, 0),
                (109, 0),
                (108, 0),
                (110, 0),
                (106, 0),
                (103, 0),
                (107, 0),
                (111, 0),
                (112, 0),
            ],
        ),
        (103, vec![(105, 0), (104, 0), (110, 1)]),
        (105, vec![(115, 0)]),
        (112, vec![]),
    ];
    let root_path = PathBuf::from("C:\\vol\\root");
    let root_name = root_path
        .file_name()
        .unwrap_or(root_path.as_os_str())
        .to_string_lossy()
        .into_owned();
    for want_atime in [false, true] {
        let mft = build_at(&table(records.clone()), want_atime)?;
        let mft = with_root_name(mft, &root_name).map_err(|e| format!("{e:?}"))?;
        let walk = walk_listing(
            Oracle::new(&records, order.clone(), root_path.clone()),
            want_atime,
        )?;
        assert_eq!(mft.len(), 14, "13 entries under the root");
        assert_same_columns(&mft, &walk);
    }
    Ok(())
}

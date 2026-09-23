//! The columns file (M6): the helper's product, read back by `tm-node`'s
//! `mftTake`. A round trip must give back every column bit for bit (NaN
//! times included), every side table and every stat; a refusal must carry
//! its sentence; and a file that is short, long, tampered with or shaped
//! wrong must be refused with a reason — never a panic, never an output the
//! ingest could loop on (a parent that is not before its child).

use std::fs;

use tm_mft::columns::{
    ColumnsError, ColumnsFile, FLAG_ATIME, HEADER_BYTES, MAGIC_COLUMNS, MAGIC_REFUSAL,
    OUTPUT_EXTENSION, decode, encode_columns, encode_refusal, is_output_name,
};
use tm_walk::{
    DirRefusal, FLAG_DATALESS, FLAG_REFUSED_DIR, FastPath, HardlinkRef, KIND_DIR, KIND_FILE,
    KIND_SYMLINK, Refusal, WalkOutput, WalkStats,
};

type TestResult = Result<(), String>;
/// One change to the sample, for the shape refusals.
type Change = Box<dyn FnOnce(&mut WalkOutput)>;

/// A root holding a folder `sub` (refused), a file `a.txt`, a symlink `ln`
/// and two names of one hard-linked file; a NaN mtime and atime included.
fn sample() -> WalkOutput {
    let names = ["C:\\", "sub", "a.txt", "ln", "h1", "h2"];
    let mut name_off = vec![0_u32];
    let mut blob = Vec::new();
    for name in names {
        blob.extend_from_slice(name.as_bytes());
        name_off.push(u32::try_from(blob.len()).unwrap_or(u32::MAX));
    }
    WalkOutput {
        parent: vec![0, 0, 0, 0, 0, 1],
        name_off,
        names: blob,
        kind: vec![
            KIND_DIR,
            KIND_DIR,
            KIND_FILE,
            KIND_SYMLINK,
            KIND_FILE,
            KIND_FILE,
        ],
        flags: vec![0, FLAG_REFUSED_DIR, FLAG_DATALESS, 0, 0, 0],
        size: vec![0.0, 0.0, 1234.0, 11.0, 5.0e9, 5.0e9],
        alloc_bytes: vec![0.0, 0.0, 0.0, 0.0, 5_000_003_584.0, 5_000_003_584.0],
        mtime_ms: vec![
            1_700_000_000_000.5,
            f64::NAN,
            1_600_000_000_123.456_7,
            -11_644_473_600_000.0,
            1.0,
            1.0,
        ],
        atime_ms: vec![f64::NAN, 2.0, 3.0, 4.0, 5.0, 6.0],
        hardlinks: vec![
            HardlinkRef { node: 4, family: 0 },
            HardlinkRef { node: 5, family: 0 },
        ],
        refusals: vec![DirRefusal {
            node: 1,
            why: Refusal::Denied,
        }],
        stats: WalkStats {
            dirs_listed: 1,
            entries: 5,
            wall_ms: 12.5,
            cpu_seconds: 0.25,
            fast_path: FastPath::Mft,
            workers_peak: 1,
            climb_steps: 0,
            denied_entries: 7,
            unreadable_entries: 8,
            dataless: 9,
        },
    }
}

/// Only the root.
fn root_only() -> WalkOutput {
    WalkOutput {
        parent: vec![0],
        name_off: vec![0, 3],
        names: b"C:\\".to_vec(),
        kind: vec![KIND_DIR],
        flags: vec![0],
        size: vec![0.0],
        alloc_bytes: vec![0.0],
        mtime_ms: vec![1.0],
        atime_ms: vec![f64::NAN],
        hardlinks: Vec::new(),
        refusals: Vec::new(),
        stats: WalkStats {
            dirs_listed: 1,
            entries: 0,
            wall_ms: 0.0,
            cpu_seconds: f64::NAN,
            fast_path: FastPath::Mft,
            workers_peak: 1,
            climb_steps: 0,
            denied_entries: 0,
            unreadable_entries: 0,
            dataless: 0,
        },
    }
}

fn bits(column: &[f64]) -> Vec<u64> {
    column.iter().map(|v| v.to_bits()).collect()
}

/// Equal column for column, the float columns bit for bit (NaN is a value here).
fn same(a: &WalkOutput, b: &WalkOutput) -> TestResult {
    let pairs: [(&str, bool); 12] = [
        ("parent", a.parent == b.parent),
        ("name_off", a.name_off == b.name_off),
        ("names", a.names == b.names),
        ("kind", a.kind == b.kind),
        ("flags", a.flags == b.flags),
        ("size", bits(&a.size) == bits(&b.size)),
        ("alloc_bytes", bits(&a.alloc_bytes) == bits(&b.alloc_bytes)),
        ("mtime_ms", bits(&a.mtime_ms) == bits(&b.mtime_ms)),
        ("atime_ms", bits(&a.atime_ms) == bits(&b.atime_ms)),
        ("hardlinks", a.hardlinks == b.hardlinks),
        ("refusals", a.refusals == b.refusals),
        (
            "stats",
            a.stats.dirs_listed == b.stats.dirs_listed
                && a.stats.entries == b.stats.entries
                && a.stats.wall_ms.to_bits() == b.stats.wall_ms.to_bits()
                && a.stats.cpu_seconds.to_bits() == b.stats.cpu_seconds.to_bits()
                && a.stats.fast_path == b.stats.fast_path
                && a.stats.workers_peak == b.stats.workers_peak
                && a.stats.climb_steps == b.stats.climb_steps
                && a.stats.denied_entries == b.stats.denied_entries
                && a.stats.unreadable_entries == b.stats.unreadable_entries
                && a.stats.dataless == b.stats.dataless,
        ),
    ];
    match pairs.iter().find(|(_, equal)| !equal) {
        Some((column, _)) => Err(format!("{column} differs after the round trip")),
        None => Ok(()),
    }
}

fn columns_of(bytes: &[u8]) -> Result<WalkOutput, String> {
    match decode(bytes) {
        Ok(ColumnsFile::Columns(out)) => Ok(*out),
        other => Err(format!("expected columns, got {other:?}")),
    }
}

fn encoded(out: &WalkOutput) -> Result<Vec<u8>, String> {
    encode_columns(out, FLAG_ATIME).map_err(|e| format!("encode: {e}"))
}

#[test]
fn every_column_side_table_and_stat_survives_the_round_trip() -> TestResult {
    let out = sample();
    same(&columns_of(&encoded(&out)?)?, &out)?;
    let lone = root_only();
    same(&columns_of(&encoded(&lone)?)?, &lone)
}

#[test]
fn the_round_trip_holds_through_a_file_on_disk() -> TestResult {
    let dir = std::env::temp_dir().join(format!("tm-mft-columns-test-{}", std::process::id()));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("round-trip.tmmft");
    let out = sample();
    fs::write(&file, encoded(&out)?).map_err(|e| e.to_string())?;
    let back = fs::read(&file).map_err(|e| e.to_string());
    let _ = fs::remove_file(&file);
    let _ = fs::remove_dir(&dir);
    same(&columns_of(&back?)?, &out)
}

#[test]
fn the_header_is_the_magic_the_entry_count_and_the_flags_little_endian() -> TestResult {
    let bytes = encoded(&sample())?;
    assert_eq!(HEADER_BYTES, 16);
    assert_eq!(bytes.get(..8), Some(&MAGIC_COLUMNS[..]));
    assert_eq!(&MAGIC_COLUMNS, b"TMMFT002");
    assert_eq!(
        bytes.get(8..12),
        Some(&6_u32.to_le_bytes()[..]),
        "six nodes"
    );
    assert_eq!(bytes.get(12..16), Some(&FLAG_ATIME.to_le_bytes()[..]));
    // The first column follows at once: parent[0] = 0, parent[1] = 0.
    assert_eq!(bytes.get(16..24), Some(&[0_u8; 8][..]));
    Ok(())
}

#[test]
fn a_refusal_carries_its_sentence() -> TestResult {
    let sentence = "D: is formatted exFAT, not NTFS; only NTFS keeps a master file table";
    let bytes = encode_refusal(sentence);
    assert_eq!(bytes.get(..8), Some(&MAGIC_REFUSAL[..]));
    assert_eq!(&MAGIC_REFUSAL, b"TMMFTERR");
    match decode(&bytes) {
        Ok(ColumnsFile::Refusal(text)) => assert_eq!(text, sentence),
        other => return Err(format!("expected the refusal, got {other:?}")),
    }
    Ok(())
}

#[test]
fn every_truncation_is_refused_and_nothing_panics() -> TestResult {
    for bytes in [encoded(&sample())?, encode_refusal("no")] {
        for len in 0..bytes.len() {
            let cut = bytes.get(..len).ok_or("cut")?;
            if decode(cut).is_ok() {
                return Err(format!(
                    "a file cut to {len} of {} bytes was accepted",
                    bytes.len()
                ));
            }
        }
    }
    Ok(())
}

#[test]
fn a_trailing_byte_is_refused() -> TestResult {
    let mut bytes = encoded(&sample())?;
    bytes.push(0);
    assert_eq!(decode(&bytes).err(), Some(ColumnsError::TrailingBytes(1)));
    Ok(())
}

#[test]
fn a_wrong_magic_and_an_unknown_flag_are_refused() -> TestResult {
    let good = encoded(&sample())?;
    let mut foreign = good.clone();
    if let Some(b) = foreign.get_mut(0) {
        *b = b'X';
    }
    assert_eq!(decode(&foreign).err(), Some(ColumnsError::BadMagic));
    // Version 1 carried file ids as doubles; a file from a build that still
    // writes it is named as that, not as something else entirely.
    let mut older = good.clone();
    if let Some(b) = older.get_mut(7) {
        *b = b'1';
    }
    let refused = decode(&older).err();
    assert_eq!(refused, Some(ColumnsError::OtherVersion(*b"TMMFT001")));
    let sentence = refused.map(|e| e.to_string()).unwrap_or_default();
    assert!(
        sentence.contains("another TreeMap build") && sentence.contains("TMMFT001"),
        "{sentence}"
    );
    let mut flags = good;
    if let Some(b) = flags.get_mut(12) {
        *b |= 2;
    }
    assert_eq!(decode(&flags).err(), Some(ColumnsError::UnknownFlags(3)));
    Ok(())
}

/// The sample with one change, encoded, must be refused as shaped wrong.
fn refused_shape(change: impl FnOnce(&mut WalkOutput)) -> Result<ColumnsError, String> {
    let mut out = sample();
    change(&mut out);
    // The encoder refuses a shape the decoder would; when it does not,
    // the decoder must.
    match encode_columns(&out, FLAG_ATIME) {
        Err(e) => Ok(e),
        Ok(bytes) => match decode(&bytes) {
            Err(e) => Ok(e),
            Ok(file) => Err(format!("a bad shape was accepted: {file:?}")),
        },
    }
}

#[test]
fn a_parent_that_does_not_precede_its_child_is_refused() -> TestResult {
    // A cycle (1 -> 5 -> 1) would hang the ingest's parent-chain walk.
    let e = refused_shape(|o| {
        if let Some(p) = o.parent.get_mut(1) {
            *p = 5;
        }
    })?;
    assert!(matches!(e, ColumnsError::BadShape { .. }), "{e:?}");
    let root = refused_shape(|o| {
        if let Some(p) = o.parent.get_mut(0) {
            *p = 1;
        }
    })?;
    assert!(matches!(root, ColumnsError::BadShape { .. }), "{root:?}");
    Ok(())
}

#[test]
fn names_kinds_flags_and_side_tables_out_of_range_are_refused() -> TestResult {
    let cases: Vec<(&str, Change)> = vec![
        (
            "a name offset past the names",
            Box::new(|o: &mut WalkOutput| {
                if let Some(off) = o.name_off.get_mut(3) {
                    *off = 999;
                }
            }),
        ),
        (
            "a name that is not UTF-8",
            Box::new(|o: &mut WalkOutput| {
                if let Some(b) = o.names.get_mut(4) {
                    *b = 0xFF;
                }
            }),
        ),
        (
            "an unknown kind",
            Box::new(|o: &mut WalkOutput| {
                if let Some(k) = o.kind.get_mut(2) {
                    *k = 7;
                }
            }),
        ),
        (
            "an unknown flag bit",
            Box::new(|o: &mut WalkOutput| {
                if let Some(f) = o.flags.get_mut(2) {
                    *f = 4;
                }
            }),
        ),
        (
            "a hard link past the last node",
            Box::new(|o: &mut WalkOutput| {
                if let Some(h) = o.hardlinks.get_mut(1) {
                    h.node = 6;
                }
            }),
        ),
        (
            "a hard-link family numbered past the table",
            Box::new(|o: &mut WalkOutput| {
                if let Some(h) = o.hardlinks.get_mut(1) {
                    h.family = 2;
                }
            }),
        ),
        (
            "a refusal past the last node",
            Box::new(|o: &mut WalkOutput| {
                if let Some(r) = o.refusals.get_mut(0) {
                    r.node = 60;
                }
            }),
        ),
        (
            "a column shorter than the others",
            Box::new(|o: &mut WalkOutput| {
                o.size.pop();
            }),
        ),
    ];
    for (what, change) in cases {
        let e = refused_shape(change)?;
        assert!(
            matches!(e, ColumnsError::BadShape { .. }),
            "{what}: expected BadShape, got {e:?}"
        );
    }
    Ok(())
}

#[test]
fn an_unknown_refusal_code_or_fast_path_code_in_the_file_is_refused() -> TestResult {
    let good = encoded(&sample())?;
    // The refusal table sits right before the stats; its one entry's code
    // is the byte before the stats block.
    let stats_bytes = 8 + 8 + 8 + 8 + 1 + 4 + 4 + 8 + 8 + 8;
    let why_at = good.len() - stats_bytes - 1;
    let mut why = good.clone();
    if let Some(b) = why.get_mut(why_at) {
        *b = 9;
    }
    assert!(
        matches!(decode(&why).err(), Some(ColumnsError::BadShape { .. })),
        "refusal code 9"
    );
    let fast_path_at = good.len() - (stats_bytes - 8 - 8 - 8 - 8);
    let mut fast = good;
    if let Some(b) = fast.get_mut(fast_path_at) {
        *b = 99;
    }
    assert!(
        matches!(decode(&fast).err(), Some(ColumnsError::BadShape { .. })),
        "fast path code 99"
    );
    Ok(())
}

#[test]
fn every_error_reads_as_a_sentence() {
    for e in [
        ColumnsError::TooShort,
        ColumnsError::BadMagic,
        ColumnsError::UnknownFlags(6),
        ColumnsError::Truncated { section: "size" },
        ColumnsError::TrailingBytes(3),
        ColumnsError::BadShape {
            reason: "a parent that does not precede its child",
        },
        ColumnsError::TooLarge,
    ] {
        let text = e.to_string();
        assert!(text.len() > 12 && !text.contains('{'), "{text}");
    }
}

#[test]
fn only_a_name_the_app_gives_is_a_columns_file_name() {
    assert_eq!(OUTPUT_EXTENSION, ".tmmft");
    for good in ["3f2c-9a.tmmft", "a.tmmft", "run_1.2.tmmft", "A-Z_09.tmmft"] {
        assert!(is_output_name(good), "{good:?}");
    }
    for bad in [
        "",
        ".tmmft",
        "..tmmft",
        "x",
        "x.dll",
        "x.tmmft.exe",
        "x.TMMFT",
        "x.TMMFT.lnk",
        "x:ads.tmmft",
        "x.tmmft:ads",
        "a b.tmmft",
        "x$.tmmft",
        "x/y.tmmft",
        "x\\y.tmmft",
        "é.tmmft",
        "CON.tmmft ",
    ] {
        assert!(!is_output_name(bad), "{bad:?} must be refused");
    }
}

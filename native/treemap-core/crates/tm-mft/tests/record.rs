//! The FILE-record parser on hand-built records (1,024 bytes, two 512-byte
//! update-sequence sectors, unless a test says otherwise): the signature, the
//! fix-ups and the torn-write refusal, the header's flags and references, the
//! attribute walk to its end marker, and the four attributes the tree reads.
//! No Windows API is involved; the live proof is M5's test on a real volume.

mod common;

use common::{
    ATTR_COMPRESSED, ATTR_SPARSE, CREATED, DATA, DIRECTORY, DOS, END, Extent, FILE_NAME,
    FileRecord, IN_USE, OBJECT_ID, POSIX, RECORD_BYTES, REPARSE_POINT, SLACK, STANDARD_INFORMATION,
    STRIDE, USN, WIN32, WIN32_AND_DOS, file_name, link_buffer, non_resident, pair, put, resident,
    std_info, units,
};
use tm_mft::{
    DataExtent, FileName, Record, RecordError, StdInfo, UPDATE_SEQUENCE_STRIDE, data_extents,
    parse_record,
};

type TestResult = Result<(), String>;

/// 2024-01-01T00:00:00Z as a FILETIME.
const FT_2024: i64 = 133_485_408_000_000_000;
/// `IO_REPARSE_TAG_SYMLINK`.
const TAG_SYMLINK: u32 = 0xA000_000C;

fn parse(rec: &FileRecord) -> Result<Record, String> {
    let mut buf = rec.on_disk()?;
    parse_record(&mut buf, UPDATE_SEQUENCE_STRIDE).map_err(|e| format!("{e:?}"))
}

fn parse_bytes(mut buf: Vec<u8>) -> Result<RecordError, String> {
    match parse_record(&mut buf, UPDATE_SEQUENCE_STRIDE) {
        Ok(r) => Err(format!("parsed {r:?} where a refusal was expected")),
        Err(e) => Ok(e),
    }
}

fn refusal(rec: &FileRecord) -> Result<RecordError, String> {
    parse_bytes(rec.on_disk()?)
}

/// The reason of a `BadAttribute` at `offset`, or what was returned instead.
fn bad_attribute_at(err: RecordError, offset: usize) -> Result<&'static str, String> {
    match err {
        RecordError::BadAttribute { offset: at, reason } if at == offset => Ok(reason),
        other => Err(format!("expected BadAttribute at {offset}, got {other:?}")),
    }
}

fn bad_header(err: RecordError) -> Result<&'static str, String> {
    match err {
        RecordError::BadHeader { reason } => Ok(reason),
        other => Err(format!("expected BadHeader, got {other:?}")),
    }
}

fn name_of(n: &FileName) -> String {
    String::from_utf16_lossy(&n.name)
}

/// A name of `len` units that is not one repeated letter, so a shifted or
/// truncated read cannot look right.
fn long_name(len: usize) -> String {
    (0..len)
        .map(|i| match i % 7 {
            0 => 'Ω',
            k => char::from(
                b'a' + u8::try_from(i % 26).unwrap_or(0) + u8::try_from(k).unwrap_or(0) % 3,
            ),
        })
        .collect()
}

/// Runs `f` on its own thread and waits at most `secs` for its answer, so a
/// parser that never returns (an attribute that never advances) fails the
/// test instead of hanging the suite.
fn within<T: Send + 'static>(
    secs: u64,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || tx.send(f()));
    rx.recv_timeout(std::time::Duration::from_secs(secs))
        .map_err(|_| format!("the parser gave no answer within {secs} s"))
}

// ---------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------

#[test]
fn reads_the_header_of_an_in_use_base_record() -> TestResult {
    let mut f = FileRecord::new(0x0001_2345);
    f.sequence = 7;
    let r = parse(&f)?;
    assert_eq!(r.number, 0x0001_2345, "the record number at 0x2C");
    assert_eq!(r.sequence, 7, "the sequence number at 0x10");
    assert!(r.in_use);
    assert!(!r.is_dir);
    assert_eq!(
        (r.base, r.base_seq),
        (0, 0),
        "a base record's reference is 0"
    );
    assert!(r.names.is_empty() && r.std_info.is_none() && r.data_size.is_none());
    assert!(r.reparse.is_none() && !r.reparse_nonresident);
    Ok(())
}

#[test]
fn the_in_use_and_directory_flags_are_the_header_s_two_low_bits() -> TestResult {
    let mut f = FileRecord::new(40);
    f.flags = IN_USE | DIRECTORY;
    let r = parse(&f)?;
    assert!(r.in_use && r.is_dir, "0x0003: an in-use directory");
    f.flags = IN_USE | 0x0004 | 0x0008;
    let r = parse(&f)?;
    assert!(r.in_use && !r.is_dir, "0x000D: in use, not a directory");
    f.flags = DIRECTORY;
    let r = parse(&f)?;
    assert!(!r.in_use && r.is_dir, "0x0002: a deleted directory");
    Ok(())
}

#[test]
fn the_base_reference_is_a_48_bit_number_and_a_16_bit_sequence() -> TestResult {
    let mut f = FileRecord::new(900);
    f.base = (0x0007_u64 << 48) | 0x1234_5678_9ABC;
    let r = parse(&f)?;
    assert_eq!(r.base, 0x1234_5678_9ABC);
    assert_eq!(r.base_seq, 7);
    Ok(())
}

#[test]
fn a_signature_other_than_file_is_refused() -> TestResult {
    let mut buf = FileRecord::new(40).on_disk()?;
    put(&mut buf, 0, b"BAAD")?;
    assert_eq!(
        parse_bytes(buf)?,
        RecordError::BadSignature,
        "chkdsk's torn-record mark"
    );
    assert_eq!(
        parse_bytes(vec![0; RECORD_BYTES])?,
        RecordError::BadSignature,
        "a record never written"
    );
    Ok(())
}

#[test]
fn a_buffer_shorter_than_the_header_is_truncated() -> TestResult {
    let whole = FileRecord::new(40).on_disk()?;
    let short = whole.get(..0x2F).ok_or("short")?.to_vec();
    assert_eq!(parse_bytes(short)?, RecordError::Truncated);
    assert_eq!(parse_bytes(Vec::new())?, RecordError::Truncated);
    Ok(())
}

#[test]
fn a_record_without_an_ntfs_3_1_record_number_is_refused() -> TestResult {
    // NTFS 3.0 put the update-sequence array at 0x2A, where 3.1 keeps the
    // record's own number: there is no number to read.
    let mut f = FileRecord::new(40);
    f.usa_offset = 0x2A;
    let reason = bad_header(refusal(&f)?)?;
    assert!(reason.contains("record number"), "{reason}");
    Ok(())
}

#[test]
fn a_record_not_in_use_is_returned_with_its_header_only() -> TestResult {
    // A deleted record keeps whatever it held; nothing in it is a fact, so
    // nothing in it can fail it either.
    let mut zero_length = Vec::new();
    zero_length.extend(OBJECT_ID.to_le_bytes());
    zero_length.extend(0_u32.to_le_bytes());
    let mut f = FileRecord::new(41)
        .attr(resident(
            FILE_NAME,
            "",
            0,
            &file_name(5, 5, WIN32, "gone.txt"),
        ))
        .attr(zero_length);
    f.flags = 0;
    f.sequence = 9;
    let r = parse(&f)?;
    assert!(!r.in_use);
    assert_eq!((r.number, r.sequence), (41, 9));
    assert!(r.names.is_empty(), "the stale name is not read");
    f.flags = IN_USE;
    let offset = f.attribute_offset(1);
    let reason = bad_attribute_at(within(5, move || refusal(&f))??, offset)?;
    assert!(
        reason.contains("zero"),
        "in use, the same bytes are refused: {reason}"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// The update-sequence fix-ups
// ---------------------------------------------------------------------------

/// A record whose `$FILE_NAME` crosses the first sector's end: 200 units
/// starting at 242 cover bytes 510-511.
fn crossing_record() -> (FileRecord, String) {
    let name = long_name(200);
    let f = FileRecord::new(77)
        .attr(resident(
            STANDARD_INFORMATION,
            "",
            0,
            &std_info(FT_2024, FT_2024, 0x20),
        ))
        .attr(resident(FILE_NAME, "", 0, &file_name(5, 5, WIN32, &name)));
    (f, name)
}

#[test]
fn the_fix_ups_restore_every_sector_end() -> TestResult {
    let (f, name) = crossing_record();
    let name_start = f.attribute_offset(1) + 0x18 + 0x42;
    assert!(
        name_start < 510 && name_start + 400 > 512,
        "the fixture's name must cover the first sector's end"
    );
    let logical = f.logical()?;
    let mut buf = f.on_disk()?;
    assert_eq!(
        pair(&buf, 510)?,
        USN.to_le_bytes(),
        "the disk image holds the USN"
    );
    let r = parse_record(&mut buf, UPDATE_SEQUENCE_STRIDE).map_err(|e| format!("{e:?}"))?;
    assert_eq!(r.names.len(), 1);
    assert_eq!(
        r.names.first().map(name_of).as_deref(),
        Some(name.as_str()),
        "the unit at 510 was restored from the array"
    );
    assert_eq!(
        pair(&buf, 510)?,
        pair(&logical, 510)?,
        "sector 0's end, in place"
    );
    assert_eq!(
        pair(&buf, 1022)?,
        [SLACK, SLACK],
        "sector 1's end, in place"
    );
    Ok(())
}

#[test]
fn a_torn_write_is_refused_naming_the_sector_and_the_buffer_is_left_as_read() -> TestResult {
    let (f, _) = crossing_record();
    for (sector, end) in [(0, 510), (1, 1022)] {
        let mut buf = f.on_disk()?;
        put(&mut buf, end, &(USN ^ 0x0101).to_le_bytes())?;
        let before = buf.clone();
        let got = parse_record(&mut buf, UPDATE_SEQUENCE_STRIDE);
        assert_eq!(
            got.err(),
            Some(RecordError::FixupMismatch { sector }),
            "sector {sector}"
        );
        assert!(
            buf == before,
            "a refused record is not half fixed up (sector {sector})"
        );
    }
    Ok(())
}

#[test]
fn an_update_sequence_array_that_does_not_fit_the_record_is_refused() -> TestResult {
    let f = FileRecord::new(40);
    let disk = f.on_disk()?;

    let mut wrong_count = disk.clone();
    put(&mut wrong_count, 0x06, &2_u16.to_le_bytes())?;
    let reason = bad_header(parse_bytes(wrong_count)?)?;
    assert!(
        reason.contains("sector"),
        "a count that is not 1 + sectors: {reason}"
    );

    let mut odd = disk.clone();
    put(&mut odd, 0x04, &0x31_u16.to_le_bytes())?;
    let reason = bad_header(parse_bytes(odd)?)?;
    assert!(reason.contains("aligned"), "{reason}");

    let mut outside = disk.clone();
    put(&mut outside, 0x04, &0x03FC_u16.to_le_bytes())?;
    let reason = bad_header(parse_bytes(outside)?)?;
    assert!(
        reason.contains("protected"),
        "an array over a sector end: {reason}"
    );

    for stride in [0, 1000, 4096] {
        let mut buf = disk.clone();
        let reason = bad_header(
            parse_record(&mut buf, stride)
                .err()
                .ok_or_else(|| format!("stride {stride} was accepted"))?,
        )?;
        assert!(reason.contains("whole number"), "stride {stride}: {reason}");
    }
    Ok(())
}

#[test]
fn a_4096_byte_record_is_protected_at_the_same_512_byte_stride() -> TestResult {
    // A 4K-native disk formats 4,096-byte records; the stride stays 512, so
    // the array has 1 + 8 slots and every 512 bytes end in the USN on disk.
    let name = long_name(255);
    let mut f = FileRecord::new(5000)
        .attr(resident(FILE_NAME, "", 0, &file_name(5, 5, WIN32, &name)))
        .attr(resident(DATA, "", 0, &[0x5A; 2600]));
    f.size = 4096;
    let disk = f.on_disk()?;
    assert_eq!(
        u16::from_le_bytes(pair(&disk, 0x06)?),
        9,
        "the builder writes 1 + 8"
    );
    let r = parse(&f)?;
    assert_eq!(r.names.first().map(name_of).as_deref(), Some(name.as_str()));
    assert_eq!(r.data_size, Some(2600), "a value crossing five sector ends");
    Ok(())
}

// ---------------------------------------------------------------------------
// The attribute walk
// ---------------------------------------------------------------------------

#[test]
fn attributes_are_read_up_to_the_end_marker_and_never_past_it() -> TestResult {
    let mut marker = Vec::new();
    marker.extend(END.to_le_bytes());
    marker.extend(0_u32.to_le_bytes());
    let f = FileRecord::new(50)
        .attr(resident(
            FILE_NAME,
            "",
            0,
            &file_name(5, 5, WIN32, "before.txt"),
        ))
        .attr(marker)
        .attr(resident(
            FILE_NAME,
            "",
            0,
            &file_name(5, 5, WIN32, "after.txt"),
        ));
    let r = parse(&f)?;
    let names: Vec<String> = r.names.iter().map(name_of).collect();
    assert_eq!(
        names,
        vec!["before.txt"],
        "inside the used size, but past the end marker"
    );
    Ok(())
}

#[test]
fn a_zero_length_attribute_is_refused() -> TestResult {
    let mut blob = Vec::new();
    blob.extend(OBJECT_ID.to_le_bytes());
    blob.extend(0_u32.to_le_bytes());
    let f = FileRecord::new(50)
        .attr(resident(STANDARD_INFORMATION, "", 0, &std_info(1, 2, 3)))
        .attr(blob);
    let offset = f.attribute_offset(1);
    let reason = bad_attribute_at(within(5, move || refusal(&f))??, offset)?;
    assert!(reason.contains("zero"), "{reason}");
    Ok(())
}

#[test]
fn an_attribute_running_past_the_used_size_is_refused() -> TestResult {
    let f = FileRecord::new(50).attr(resident(OBJECT_ID, "", 0, &[7; 16]));
    let mut buf = f.on_disk()?;
    // 0x28 bytes long by its header; say 0x200 instead. The used size ends
    // well before that, though the record's slack does not.
    put(&mut buf, f.first_attribute() + 4, &0x200_u32.to_le_bytes())?;
    let reason = bad_attribute_at(parse_bytes(buf)?, f.first_attribute())?;
    assert!(reason.contains("past the used size"), "{reason}");
    Ok(())
}

#[test]
fn a_used_size_past_the_record_or_a_first_attribute_outside_it_is_refused() -> TestResult {
    let f = FileRecord::new(50);
    let mut buf = f.on_disk()?;
    put(&mut buf, 0x18, &1025_u32.to_le_bytes())?;
    let reason = bad_header(parse_bytes(buf)?)?;
    assert!(reason.contains("used size"), "{reason}");

    let mut buf = f.on_disk()?;
    put(&mut buf, 0x14, &0x0400_u16.to_le_bytes())?;
    let reason = bad_header(parse_bytes(buf)?)?;
    assert!(reason.contains("first attribute"), "{reason}");
    Ok(())
}

#[test]
fn attributes_that_reach_the_used_size_without_an_end_marker_are_refused() -> TestResult {
    let f = FileRecord::new(50).attr(resident(OBJECT_ID, "", 0, &[7; 16]));
    let mut buf = f.on_disk()?;
    // The used size stops right after the one attribute, before the marker.
    let used = f.attribute_offset(1);
    put(
        &mut buf,
        0x18,
        &u32::try_from(used).unwrap_or(0).to_le_bytes(),
    )?;
    let reason = bad_attribute_at(parse_bytes(buf)?, used)?;
    assert!(reason.contains("end marker"), "{reason}");
    Ok(())
}

#[test]
fn a_resident_value_outside_its_attribute_is_refused() -> TestResult {
    let f = FileRecord::new(50).attr(resident(FILE_NAME, "", 0, &file_name(5, 5, WIN32, "x.txt")));
    let mut buf = f.on_disk()?;
    put(
        &mut buf,
        f.first_attribute() + 0x10,
        &0x0100_u32.to_le_bytes(),
    )?;
    let reason = bad_attribute_at(parse_bytes(buf)?, f.first_attribute())?;
    assert!(reason.contains("value"), "{reason}");
    Ok(())
}

#[test]
fn an_attribute_whose_header_does_not_fit_its_length_is_refused() -> TestResult {
    let mut blob = Vec::new();
    blob.extend(STANDARD_INFORMATION.to_le_bytes());
    blob.extend(16_u32.to_le_bytes());
    blob.extend([0_u8; 8]);
    let f = FileRecord::new(50).attr(blob);
    let reason = bad_attribute_at(refusal(&f)?, f.first_attribute())?;
    assert!(reason.contains("header"), "{reason}");
    Ok(())
}

// ---------------------------------------------------------------------------
// $STANDARD_INFORMATION and $FILE_NAME
// ---------------------------------------------------------------------------

#[test]
fn standard_information_gives_last_write_last_access_and_the_attributes() -> TestResult {
    let f = FileRecord::new(60).attr(resident(
        STANDARD_INFORMATION,
        "",
        0,
        &std_info(FT_2024, FT_2024 + 12_345, 0x0040_0421),
    ));
    let r = parse(&f)?;
    assert_eq!(
        r.std_info,
        Some(StdInfo {
            last_write: FT_2024,
            last_access: FT_2024 + 12_345,
            attributes: 0x0040_0421,
        })
    );
    assert_ne!(FT_2024, CREATED, "the creation time is a different field");
    Ok(())
}

#[test]
fn a_standard_information_that_is_short_or_non_resident_is_refused() -> TestResult {
    let short = std_info(1, 2, 3);
    let f = FileRecord::new(60).attr(resident(
        STANDARD_INFORMATION,
        "",
        0,
        short.get(..0x20).ok_or("short")?,
    ));
    let reason = bad_attribute_at(refusal(&f)?, f.first_attribute())?;
    assert!(reason.contains("shorter"), "{reason}");

    let f = FileRecord::new(60).attr(non_resident(
        STANDARD_INFORMATION,
        "",
        0,
        &Extent {
            runs: vec![0],
            ..Extent::default()
        },
    ));
    let reason = bad_attribute_at(refusal(&f)?, f.first_attribute())?;
    assert!(reason.contains("must be resident"), "{reason}");
    Ok(())
}

#[test]
fn every_file_name_gives_its_parent_reference_namespace_and_units() -> TestResult {
    let f = FileRecord::new(61)
        .attr(resident(
            FILE_NAME,
            "",
            0,
            &file_name(0x0000_1234_5678, 0x00AB, WIN32, "Long File Name.txt"),
        ))
        .attr(resident(
            FILE_NAME,
            "",
            0,
            &file_name(0x0000_1234_5678, 0x00AB, DOS, "LONGFI~1.TXT"),
        ))
        .attr(resident(
            FILE_NAME,
            "",
            0,
            &file_name(99, 3, POSIX, "λ-posix"),
        ))
        .attr(resident(
            FILE_NAME,
            "",
            0,
            &file_name(5, 5, WIN32_AND_DOS, "SHORT.TXT"),
        ));
    let r = parse(&f)?;
    let expect = |parent: u64, parent_seq: u16, namespace: u8, name: &str| FileName {
        parent,
        parent_seq,
        namespace,
        name: units(name),
    };
    assert_eq!(
        r.names,
        vec![
            expect(0x0000_1234_5678, 0x00AB, WIN32, "Long File Name.txt"),
            expect(0x0000_1234_5678, 0x00AB, DOS, "LONGFI~1.TXT"),
            expect(99, 3, POSIX, "λ-posix"),
            expect(5, 5, WIN32_AND_DOS, "SHORT.TXT"),
        ],
        "every name, the DOS one included, in record order"
    );
    Ok(())
}

#[test]
fn a_file_name_whose_units_run_past_its_value_is_refused() -> TestResult {
    let value = file_name(5, 5, WIN32, "twelve chars");
    let cut = value.get(..value.len() - 4).ok_or("cut")?;
    let f = FileRecord::new(62).attr(resident(FILE_NAME, "", 0, cut));
    let reason = bad_attribute_at(refusal(&f)?, f.first_attribute())?;
    assert!(reason.contains("FILE_NAME"), "{reason}");
    Ok(())
}

// ---------------------------------------------------------------------------
// $DATA
// ---------------------------------------------------------------------------

#[test]
fn resident_unnamed_data_is_the_size_and_its_allocation_is_quad_aligned() -> TestResult {
    for (len, alloc) in [(0_usize, 0_u64), (13, 16), (16, 16), (17, 24)] {
        let f = FileRecord::new(70).attr(resident(DATA, "", 0, &vec![0x11; len]));
        let r = parse(&f)?;
        assert_eq!(
            r.data_size,
            Some(u64::try_from(len).unwrap_or(0)),
            "{len} bytes"
        );
        assert_eq!(r.data_alloc, Some(alloc), "{len} bytes");
    }
    Ok(())
}

#[test]
fn non_resident_unnamed_data_is_the_real_size_field() -> TestResult {
    let f = FileRecord::new(71).attr(non_resident(
        DATA,
        "",
        0,
        &Extent {
            lowest_vcn: 0,
            highest_vcn: 1,
            allocated: 8192,
            size: 5000,
            initialized: 4096,
            compressed: None,
            runs: vec![0x21, 0x02, 0x10, 0x27, 0x00],
        },
    ));
    let r = parse(&f)?;
    assert_eq!(
        r.data_size,
        Some(5000),
        "0x30, not the allocated or initialized size"
    );
    assert_eq!(r.data_alloc, Some(8192), "the allocated size at 0x28");
    Ok(())
}

#[test]
fn sparse_or_compressed_data_is_allocated_what_it_actually_holds() -> TestResult {
    for flags in [ATTR_SPARSE, ATTR_COMPRESSED] {
        let f = FileRecord::new(72).attr(non_resident(
            DATA,
            "",
            flags,
            &Extent {
                highest_vcn: 255,
                allocated: 1_048_576,
                size: 1_000_000,
                initialized: 1_000_000,
                compressed: Some(4096),
                runs: vec![0x01, 0xFF, 0x00],
                ..Extent::default()
            },
        ));
        let r = parse(&f)?;
        assert_eq!(r.data_size, Some(1_000_000), "flags {flags:#06x}");
        assert_eq!(
            r.data_alloc,
            Some(4096),
            "the size at 0x40, flags {flags:#06x}"
        );
    }
    Ok(())
}

#[test]
fn a_run_list_inside_the_attribute_header_is_refused() -> TestResult {
    // Sparse, so the header is 0x48 bytes long; the builder put the run list
    // at 0x40 (no compressed size was given), inside it.
    let f = FileRecord::new(73).attr(non_resident(
        DATA,
        "",
        ATTR_SPARSE,
        &Extent {
            allocated: 4096,
            size: 10,
            initialized: 10,
            runs: vec![0x11, 0x01, 0x05, 0x00],
            ..Extent::default()
        },
    ));
    let reason = bad_attribute_at(refusal(&f)?, f.first_attribute())?;
    assert!(reason.contains("header"), "{reason}");
    Ok(())
}

#[test]
fn a_named_data_stream_is_not_the_file_s_size() -> TestResult {
    let f = FileRecord::new(74)
        .attr(resident(DATA, "Zone.Identifier", 0, &[0x33; 26]))
        .attr(resident(DATA, "", 0, &[0x44; 7]))
        .attr(resident(DATA, "", 0, &[0x55; 99]))
        .attr(non_resident(
            DATA,
            "big",
            0,
            &Extent {
                allocated: 1 << 20,
                size: 1 << 20,
                initialized: 1 << 20,
                runs: vec![0x21, 0x01, 0x00, 0x01, 0x00],
                ..Extent::default()
            },
        ));
    let r = parse(&f)?;
    assert_eq!(
        (r.data_size, r.data_alloc),
        (Some(7), Some(8)),
        "the first unnamed stream; a second one in the same record (corrupt) does not replace it"
    );
    let only_named = FileRecord::new(75).attr(resident(DATA, "ads", 0, &[1; 3]));
    assert_eq!(
        parse(&only_named)?.data_size,
        None,
        "no unnamed stream: no size"
    );
    Ok(())
}

#[test]
fn only_the_data_extent_that_starts_at_vcn_0_carries_the_sizes() -> TestResult {
    let later = Extent {
        lowest_vcn: 16,
        highest_vcn: 31,
        allocated: 999,
        size: 999,
        initialized: 999,
        runs: vec![0x11, 0x10, 0x20, 0x00],
        ..Extent::default()
    };
    let first = Extent {
        lowest_vcn: 0,
        highest_vcn: 15,
        allocated: 131_072,
        size: 120_000,
        initialized: 120_000,
        runs: vec![0x11, 0x10, 0x40, 0x00],
        ..Extent::default()
    };
    let f = FileRecord::new(76).attr(non_resident(DATA, "", 0, &later));
    assert_eq!(
        parse(&f)?.data_size,
        None,
        "an extension's extent alone has no size"
    );
    let f = FileRecord::new(76)
        .attr(non_resident(DATA, "", 0, &later))
        .attr(non_resident(DATA, "", 0, &first));
    let r = parse(&f)?;
    assert_eq!((r.data_size, r.data_alloc), (Some(120_000), Some(131_072)));
    Ok(())
}

#[test]
fn an_attribute_name_outside_the_attribute_is_refused() -> TestResult {
    let f = FileRecord::new(78).attr(resident(DATA, "ads", 0, &[1, 2, 3]));
    let mut buf = f.on_disk()?;
    put(
        &mut buf,
        f.first_attribute() + 0x0A,
        &0x0100_u16.to_le_bytes(),
    )?;
    let reason = bad_attribute_at(parse_bytes(buf)?, f.first_attribute())?;
    assert!(reason.contains("name"), "{reason}");
    Ok(())
}

#[test]
fn a_non_resident_flag_other_than_0_or_1_is_refused() -> TestResult {
    let f = FileRecord::new(77).attr(resident(DATA, "", 0, &[1, 2, 3]));
    let mut buf = f.on_disk()?;
    put(&mut buf, f.first_attribute() + 8, &[2])?;
    let reason = bad_attribute_at(parse_bytes(buf)?, f.first_attribute())?;
    assert!(reason.contains("non-resident"), "{reason}");
    Ok(())
}

// ---------------------------------------------------------------------------
// $REPARSE_POINT
// ---------------------------------------------------------------------------

#[test]
fn the_reparse_point_value_is_kept_verbatim() -> TestResult {
    let buffer = link_buffer(TAG_SYMLINK, "\\??\\C:\\target");
    let f = FileRecord::new(80).attr(resident(REPARSE_POINT, "", 0, &buffer));
    let r = parse(&f)?;
    assert_eq!(r.reparse.as_deref(), Some(buffer.as_slice()));
    assert!(!r.reparse_nonresident);
    Ok(())
}

#[test]
fn a_non_resident_reparse_point_is_noted_not_read() -> TestResult {
    let f = FileRecord::new(81).attr(non_resident(
        REPARSE_POINT,
        "",
        0,
        &Extent {
            allocated: 4096,
            size: 2000,
            initialized: 2000,
            runs: vec![0x11, 0x01, 0x30, 0x00],
            ..Extent::default()
        },
    ));
    let r = parse(&f)?;
    assert_eq!(r.reparse, None);
    assert!(
        r.reparse_nonresident,
        "its value is on disk, not in the record"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// The unnamed $DATA extents, for the MFT's own record and $UpCase
// ---------------------------------------------------------------------------

#[test]
fn data_extents_lists_every_unnamed_non_resident_extent_of_a_fixed_up_record() -> TestResult {
    let runs = vec![0x31, 0x40, 0x00, 0x00, 0x0C, 0x21, 0x20, 0x00, 0x10, 0x00];
    let f = FileRecord::new(0)
        .attr(resident(STANDARD_INFORMATION, "", 0, &std_info(1, 2, 6)))
        .attr(non_resident(
            DATA,
            "",
            0,
            &Extent {
                lowest_vcn: 0,
                highest_vcn: 95,
                allocated: 393_216,
                size: 393_216,
                initialized: 390_144,
                runs: runs.clone(),
                ..Extent::default()
            },
        ))
        .attr(non_resident(
            DATA,
            "named",
            0,
            &Extent {
                runs: vec![0x11, 0x01, 0x01, 0x00],
                ..Extent::default()
            },
        ));
    let mut buf = f.on_disk()?;
    parse_record(&mut buf, UPDATE_SEQUENCE_STRIDE).map_err(|e| format!("{e:?}"))?;
    let extents = data_extents(&buf).map_err(|e| format!("{e:?}"))?;
    assert_eq!(extents.len(), 1, "the named stream is not the MFT's data");
    let e: &DataExtent = extents.first().ok_or("no extent")?;
    assert_eq!(
        (e.lowest_vcn, e.data_size, e.initialized_size),
        (0, 393_216, 390_144)
    );
    assert!(
        e.runs.starts_with(&runs) && e.runs.iter().skip(runs.len()).all(|b| *b == 0),
        "the run list from its offset to the attribute's end: {:?}",
        e.runs
    );
    Ok(())
}

#[test]
fn the_stride_constant_is_512() {
    assert_eq!(UPDATE_SEQUENCE_STRIDE, STRIDE);
}

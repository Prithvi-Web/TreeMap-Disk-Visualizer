//! Run lists and `$MFT`'s own extents, on hand-written byte strings: the
//! header byte's two nibbles, unsigned lengths, signed offsets relative to
//! the previous run (a negative one included), sparse runs, the terminator,
//! and every refusal; then record numbers to byte offsets through the
//! volume's cluster and record sizes, from `$MFT`'s own record to the map.

mod common;

use common::{DATA, Extent, FileRecord, STANDARD_INFORMATION, non_resident, resident, std_info};
use tm_mft::{
    ExtentError, MftExtent, MftExtents, RecordError, UPDATE_SEQUENCE_STRIDE, data_extents,
    decode_runs, parse_record,
};

type TestResult = Result<(), String>;
type Runs = Vec<(Option<u64>, u64)>;

fn runs(bytes: &[u8]) -> Result<Runs, String> {
    decode_runs(bytes).map_err(|e| format!("{e:?}"))
}

/// The offset and reason of a `BadRuns`, or what was returned instead.
fn refused(bytes: &[u8]) -> Result<(usize, &'static str), String> {
    match decode_runs(bytes) {
        Err(RecordError::BadRuns { offset, reason }) => Ok((offset, reason)),
        other => Err(format!("expected BadRuns for {bytes:02x?}, got {other:?}")),
    }
}

// ---------------------------------------------------------------------------
// decode_runs
// ---------------------------------------------------------------------------

#[test]
fn the_low_nibble_sizes_the_length_and_the_high_nibble_the_offset() -> TestResult {
    // 0x21: a one-byte length (0x18 = 24 clusters), a two-byte offset (0x5634).
    assert_eq!(
        runs(&[0x21, 0x18, 0x34, 0x56, 0x00])?,
        vec![(Some(0x5634), 24)]
    );
    // 0x31: a one-byte length (64), a three-byte offset (0x0C0000).
    assert_eq!(
        runs(&[0x31, 0x40, 0x00, 0x00, 0x0C, 0x00])?,
        vec![(Some(0x000C_0000), 64)]
    );
    // 0x12: a two-byte length (0x0102), a one-byte offset (0x07).
    assert_eq!(
        runs(&[0x12, 0x02, 0x01, 0x07, 0x00])?,
        vec![(Some(7), 0x0102)]
    );
    Ok(())
}

#[test]
fn lengths_are_unsigned_whatever_their_top_bit() -> TestResult {
    // 0x80 in a one-byte length is 128 clusters, not -128; the same run
    // written with a two-byte length reads the same.
    assert_eq!(runs(&[0x11, 0x80, 0x05, 0x00])?, vec![(Some(5), 128)]);
    assert_eq!(runs(&[0x12, 0x80, 0x00, 0x05, 0x00])?, vec![(Some(5), 128)]);
    assert_eq!(
        runs(&[
            0x18, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x05, 0x00
        ])?,
        vec![(Some(5), 0x00FF_FFFF_FFFF_FFFF)]
    );
    Ok(())
}

#[test]
fn offsets_are_signed_and_relative_to_the_previous_run() -> TestResult {
    let list = [
        0x21, 0x10, 0x00, 0x10, // 16 clusters at 0x1000
        0x11, 0x08, 0xF0, // 8 clusters 16 before it: 0x0FF0
        0x21, 0x04, 0x00, 0x01, // 4 clusters 256 after that: 0x10F0
        0x22, 0x00, 0x02, 0xFF, 0xFF, // 512 clusters 1 before that: 0x10EF
        0x00,
    ];
    assert_eq!(
        runs(&list)?,
        vec![
            (Some(0x1000), 16),
            (Some(0x0FF0), 8),
            (Some(0x10F0), 4),
            (Some(0x10EF), 512),
        ]
    );
    Ok(())
}

#[test]
fn a_sparse_run_has_no_position_and_does_not_move_the_base() -> TestResult {
    let list = [
        0x21, 0x10, 0x00, 0x10, // 16 clusters at 0x1000
        0x01, 0x20, // 32 sparse clusters
        0x11, 0x04, 0x10, // 4 clusters 16 after 0x1000, not after the hole
        0x00,
    ];
    assert_eq!(
        runs(&list)?,
        vec![(Some(0x1000), 16), (None, 32), (Some(0x1010), 4)]
    );
    Ok(())
}

#[test]
fn the_terminator_ends_the_list_and_nothing_after_it_is_read() -> TestResult {
    assert_eq!(
        runs(&[0x11, 0x01, 0x05, 0x00, 0x11, 0x02, 0x06])?,
        vec![(Some(5), 1)]
    );
    assert_eq!(
        runs(&[0x00, 0xFF, 0xFF])?,
        Vec::new(),
        "an empty stream's list"
    );
    let (offset, reason) = refused(&[0x11, 0x01, 0x05])?;
    assert_eq!(offset, 3);
    assert!(reason.contains("terminator"), "{reason}");
    let (offset, reason) = refused(&[])?;
    assert_eq!(offset, 0);
    assert!(reason.contains("terminator"), "{reason}");
    Ok(())
}

#[test]
fn a_run_that_points_before_lcn_0_is_refused() -> TestResult {
    let (offset, reason) = refused(&[0x11, 0x04, 0x05, 0x11, 0x04, 0xF0, 0x00])?;
    assert_eq!(offset, 3, "the second run: 5 - 16");
    assert!(reason.contains("before LCN 0"), "{reason}");
    let (offset, reason) = refused(&[0x11, 0x04, 0xFF, 0x00])?;
    assert_eq!(offset, 0, "a first run at -1");
    assert!(reason.contains("before LCN 0"), "{reason}");
    Ok(())
}

#[test]
fn a_run_that_overflows_is_refused() -> TestResult {
    // The running LCN passes i64::MAX when the second delta is added.
    let mut list = vec![0x81, 0x01];
    list.extend(0x7FFF_FFFF_FFFF_FFF0_i64.to_le_bytes());
    list.extend([0x11, 0x01, 0x20, 0x00]);
    let (offset, reason) = refused(&list)?;
    assert_eq!(offset, 10);
    assert!(reason.contains("overflow"), "the position: {reason}");

    // A run whose last cluster lies past i64::MAX.
    let mut list = vec![0x81, 0x20];
    list.extend(0x7FFF_FFFF_FFFF_FFF0_i64.to_le_bytes());
    list.push(0x00);
    let (offset, reason) = refused(&list)?;
    assert_eq!(offset, 0);
    assert!(reason.contains("overflow"), "the run's end: {reason}");

    // Two sparse runs whose clusters together pass what a VCN can count.
    let mut list = vec![0x08];
    list.extend(0x7FFF_FFFF_FFFF_FFFF_u64.to_le_bytes());
    list.push(0x01);
    list.push(0x01);
    list.push(0x00);
    let (offset, reason) = refused(&list)?;
    assert_eq!(offset, 9);
    assert!(reason.contains("overflow"), "the VCN count: {reason}");
    Ok(())
}

#[test]
fn a_field_wider_than_8_bytes_or_past_the_list_is_refused() -> TestResult {
    for (list, what) in [
        (
            vec![0x19_u8, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
            "a nine-byte length",
        ),
        (
            vec![0x91, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
            "a nine-byte offset",
        ),
    ] {
        let (offset, reason) = refused(&list)?;
        assert_eq!(offset, 0, "{what}");
        assert!(reason.contains("wider than 8"), "{what}: {reason}");
    }
    for (list, what) in [
        (vec![0x21_u8, 0x01, 0x05], "an offset cut short"),
        (vec![0x03_u8, 0x01, 0x05], "a length cut short"),
    ] {
        let (offset, reason) = refused(&list)?;
        assert_eq!(offset, 0, "{what}");
        assert!(reason.contains("past the run list"), "{what}: {reason}");
    }
    Ok(())
}

#[test]
fn a_run_without_a_length_or_of_zero_length_is_refused() -> TestResult {
    let (offset, reason) = refused(&[0x10, 0x05, 0x00])?;
    assert_eq!(offset, 0);
    assert!(reason.contains("no length"), "{reason}");
    let (offset, reason) = refused(&[0x11, 0x01, 0x05, 0x11, 0x00, 0x05, 0x00])?;
    assert_eq!(offset, 3);
    assert!(reason.contains("zero length"), "{reason}");
    Ok(())
}

// ---------------------------------------------------------------------------
// The extent map
// ---------------------------------------------------------------------------

#[test]
fn record_numbers_map_to_byte_offsets_across_the_extents() -> TestResult {
    // 4 KiB clusters, 1 KiB records: 64 clusters hold 256 records, 32 hold 128.
    let map = MftExtents::new(
        &[(Some(0x000C_0000), 64), (Some(0x000C_1000), 32)],
        4096,
        1024,
    )
    .map_err(|e| format!("{e:?}"))?;
    let first = 0x000C_0000_u64 * 4096;
    let second = 0x000C_1000_u64 * 4096;
    assert_eq!(
        map.extents(),
        &[
            MftExtent {
                first_record: 0,
                records: 256,
                byte_offset: first,
            },
            MftExtent {
                first_record: 256,
                records: 128,
                byte_offset: second,
            },
        ]
    );
    assert_eq!(map.record_count(), 384);
    assert_eq!(map.offset_of(0), Some(first));
    assert_eq!(map.offset_of(1), Some(first + 1024));
    assert_eq!(map.offset_of(255), Some(first + 255 * 1024));
    assert_eq!(
        map.offset_of(256),
        Some(second),
        "the next extent's first record"
    );
    assert_eq!(map.offset_of(383), Some(second + 127 * 1024));
    assert_eq!(map.offset_of(384), None, "past the last extent");
    Ok(())
}

#[test]
fn a_record_larger_than_a_cluster_spans_whole_clusters() -> TestResult {
    // 512-byte clusters, 1 KiB records: two clusters per record.
    let map = MftExtents::new(&[(Some(100), 4), (Some(50), 2)], 512, 1024)
        .map_err(|e| format!("{e:?}"))?;
    assert_eq!(map.record_count(), 3);
    assert_eq!(map.offset_of(0), Some(100 * 512));
    assert_eq!(map.offset_of(1), Some(100 * 512 + 1024));
    assert_eq!(map.offset_of(2), Some(50 * 512));
    Ok(())
}

#[test]
fn the_extent_map_refuses_what_the_mft_cannot_be() {
    let one = [(Some(10_u64), 4_u64)];
    assert_eq!(MftExtents::new(&one, 0, 1024), Err(ExtentError::ZeroSize));
    assert_eq!(MftExtents::new(&one, 4096, 0), Err(ExtentError::ZeroSize));
    assert_eq!(
        MftExtents::new(&[(Some(10), 4), (None, 4)], 4096, 1024),
        Err(ExtentError::SparseRun { index: 1 }),
        "the MFT is never sparse"
    );
    assert_eq!(
        MftExtents::new(&[(Some(10), 2), (Some(20), 3)], 512, 1024),
        Err(ExtentError::PartialRecord { index: 1 }),
        "three 512-byte clusters would split a 1 KiB record across two runs"
    );
    assert_eq!(
        MftExtents::new(&[(Some(1_u64 << 62), 1)], 4096, 1024),
        Err(ExtentError::Overflow { index: 0 }),
        "a byte offset past 2^64"
    );
    assert_eq!(
        MftExtents::new(&[(Some(u64::MAX / 4096), 2)], 4096, 1024),
        Err(ExtentError::Overflow { index: 0 }),
        "a run that starts below 2^64 bytes and ends past it"
    );
    assert_eq!(
        MftExtents::new(&[(Some(0), 1 << 63), (Some(0), 1 << 63)], 1, 1),
        Err(ExtentError::Overflow { index: 1 }),
        "more records than a 64-bit number counts"
    );
}

#[test]
fn the_mft_s_own_record_maps_its_records() -> TestResult {
    // Record 0 with its unnamed $DATA in two runs, through the parser, the
    // run decoder and the map, as the volume reader will chain them.
    let list = vec![0x31, 0x40, 0x00, 0x00, 0x0C, 0x21, 0x20, 0x00, 0x10, 0x00];
    let f = FileRecord::new(0)
        .attr(resident(STANDARD_INFORMATION, "", 0, &std_info(1, 2, 6)))
        .attr(non_resident(
            DATA,
            "",
            0,
            &Extent {
                highest_vcn: 95,
                allocated: 96 * 4096,
                size: 96 * 4096,
                initialized: 96 * 4096,
                runs: list,
                ..Extent::default()
            },
        ));
    let mut buf = f.on_disk()?;
    parse_record(&mut buf, UPDATE_SEQUENCE_STRIDE).map_err(|e| format!("{e:?}"))?;
    let extents = data_extents(&buf).map_err(|e| format!("{e:?}"))?;
    let only = extents.first().ok_or("no extent")?;
    let decoded = decode_runs(&only.runs).map_err(|e| format!("{e:?}"))?;
    assert_eq!(
        decoded,
        vec![(Some(0x000C_0000), 64), (Some(0x000C_1000), 32)]
    );
    let map = MftExtents::new(&decoded, 4096, 1024).map_err(|e| format!("{e:?}"))?;
    assert_eq!(map.record_count(), only.data_size / 1024);
    assert_eq!(map.offset_of(300), Some(0x000C_1000 * 4096 + 44 * 1024));
    Ok(())
}

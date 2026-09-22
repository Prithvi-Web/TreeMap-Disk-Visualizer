//! The Linux listing without Linux: `linux_dirent64` records built by hand
//! and walked by `d_reclen`, the `makedev` arithmetic Node's `stat.dev` goes
//! through, and the `stx_mask` rule on a scripted `statx` result. No system
//! call is made, so these run on every platform; the live proof is the
//! equivalence suite on the Linux CI legs.

use std::collections::BTreeMap;

use tm_walk::platform::linux::{
    DIRENT64_HEADER_BYTES, DT_DIR, DT_LNK, DT_REG, DT_UNKNOWN, Dirent, S_IFDIR, S_IFLNK, S_IFREG,
    STATX_ATIME, STATX_BLOCKS, STATX_INO, STATX_MODE, STATX_MTIME, STATX_NLINK, STATX_SIZE,
    STATX_TYPE, STATX_WANTED, StatxFacts, dev_parts, makedev, meta_from_statx, parse_dirents,
};
use tm_walk::platform::time_ms;
use tm_walk::{KIND_DIR, KIND_FILE, KIND_SYMLINK};

type TestResult = Result<(), String>;

// ---------------------------------------------------------------------------
// Record packing: the layout getdents64 writes
// ---------------------------------------------------------------------------

/// One `linux_dirent64`: `d_ino`, `d_off`, `d_reclen`, `d_type`, then the
/// NUL-terminated name, the whole record padded to 8 bytes as the kernel does.
fn record(ino: u64, d_type: u8, name: &[u8]) -> Result<Vec<u8>, String> {
    let body = DIRENT64_HEADER_BYTES + name.len() + 1;
    let reclen = body.div_ceil(8) * 8;
    let mut out = Vec::with_capacity(reclen);
    out.extend(ino.to_ne_bytes());
    out.extend(0_i64.to_ne_bytes()); // d_off: an opaque cookie
    out.extend(
        u16::try_from(reclen)
            .map_err(|e| e.to_string())?
            .to_ne_bytes(),
    );
    out.push(d_type);
    assert_eq!(out.len(), DIRENT64_HEADER_BYTES);
    out.extend(name);
    out.push(0);
    out.resize(reclen, 0);
    Ok(out)
}

fn buffer(records: &[(u64, u8, &[u8])]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    for (ino, d_type, name) in records {
        out.extend(record(*ino, *d_type, name)?);
    }
    Ok(out)
}

/// The entries of a parsed buffer by name: `(ino, d_type)`.
type ByName = BTreeMap<Vec<u8>, (u64, u8)>;

/// Parses `raw` and returns the visited count and the entries by name.
fn parsed(raw: &[u8]) -> Result<(usize, ByName), String> {
    let mut map = BTreeMap::new();
    let count = parse_dirents(raw, &mut |d: &Dirent<'_>| {
        map.insert(d.name.to_vec(), (d.ino, d.d_type));
    })
    .map_err(|e| format!("{e:?}"))?;
    Ok((count, map))
}

// ---------------------------------------------------------------------------
// The dirent parser
// ---------------------------------------------------------------------------

#[test]
fn walks_records_by_reclen_and_skips_dot_and_dotdot() -> TestResult {
    let raw = buffer(&[
        (2, DT_DIR, b"."),
        (1, DT_DIR, b".."),
        (1_001, DT_DIR, b"sub"),
        (1_002, DT_REG, b"a.bin"),
        (1_003, DT_LNK, b"link"),
        (1_004, DT_UNKNOWN, b"unknown-type"),
        (1_005, DT_REG, b"tab\tnew\nline"),
    ])?;
    let (count, map) = parsed(&raw)?;
    assert_eq!(count, 5, "`.` and `..` are never facts");
    assert_eq!(map.get(b"sub".as_slice()), Some(&(1_001, DT_DIR)));
    assert_eq!(map.get(b"a.bin".as_slice()), Some(&(1_002, DT_REG)));
    assert_eq!(map.get(b"link".as_slice()), Some(&(1_003, DT_LNK)));
    assert_eq!(
        map.get(b"unknown-type".as_slice()),
        Some(&(1_004, DT_UNKNOWN))
    );
    assert_eq!(
        map.get(b"tab\tnew\nline".as_slice()),
        Some(&(1_005, DT_REG))
    );
    assert_eq!(map.len(), 5);
    Ok(())
}

#[test]
fn a_name_whose_nul_is_the_last_byte_of_the_buffer_is_read_whole() -> TestResult {
    // 19 header bytes + 4 name bytes + NUL = 24: already a multiple of 8, so
    // the record has no padding and the NUL is the buffer's last byte.
    let raw = buffer(&[(7, DT_REG, b"first"), (8, DT_REG, b"abcd")])?;
    assert_eq!(raw.last(), Some(&0));
    assert_eq!(raw.len() % 8, 0);
    let (count, map) = parsed(&raw)?;
    assert_eq!(count, 2);
    assert_eq!(map.get(b"abcd".as_slice()), Some(&(8, DT_REG)));
    assert_eq!(map.get(b"first".as_slice()), Some(&(7, DT_REG)));
    Ok(())
}

#[test]
fn names_are_the_raw_bytes_not_decoded_here() -> TestResult {
    let raw = buffer(&[(9, DT_REG, b"caf\xC3\xA9"), (10, DT_REG, b"bad\xFFbyte")])?;
    let (_, map) = parsed(&raw)?;
    assert!(map.contains_key(b"caf\xC3\xA9".as_slice()));
    assert!(
        map.contains_key(b"bad\xFFbyte".as_slice()),
        "the walk decodes lossily when the name enters the arena; the listing keeps the OS bytes"
    );
    Ok(())
}

#[test]
fn rejects_a_corrupt_record() -> TestResult {
    let count = |raw: &[u8]| parse_dirents(raw, &mut |_d: &Dirent<'_>| {});
    assert_eq!(count(&[]).ok(), Some(0), "an empty buffer is the end");
    let mut short_reclen = buffer(&[(1, DT_REG, b"a")])?;
    short_reclen.splice(16..18, 8_u16.to_ne_bytes());
    assert!(
        count(&short_reclen).is_err(),
        "a reclen shorter than the header"
    );
    let mut zero_reclen = buffer(&[(1, DT_REG, b"a")])?;
    zero_reclen.splice(16..18, 0_u16.to_ne_bytes());
    assert!(
        count(&zero_reclen).is_err(),
        "a reclen of zero cannot advance"
    );
    let mut past_end = buffer(&[(1, DT_REG, b"a")])?;
    past_end.splice(16..18, 4_000_u16.to_ne_bytes());
    assert!(count(&past_end).is_err(), "a reclen past the buffer");
    let mut no_nul = buffer(&[(1, DT_REG, b"abcd")])?;
    for b in no_nul.iter_mut().skip(DIRENT64_HEADER_BYTES) {
        *b = b'x';
    }
    assert!(count(&no_nul).is_err(), "a name without its NUL");
    let whole = buffer(&[(1, DT_REG, b"a")])?;
    assert!(
        count(whole.get(..10).unwrap_or(&[])).is_err(),
        "a buffer shorter than one header"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// makedev: glibc's gnu_dev_makedev, which Node's stat.dev went through
// ---------------------------------------------------------------------------

#[test]
fn makedev_is_the_glibc_arithmetic() {
    assert_eq!(makedev(8, 1), 2_049, "sda1");
    assert_eq!(
        makedev(259, 3),
        0x1_0303,
        "nvme0n1p3: 66307, not 0x10300003"
    );
    assert_eq!(
        makedev(0, 256),
        0x10_0000,
        "a minor above 8 bits moves up by 12"
    );
    assert_eq!(
        makedev(0x1000, 0),
        0x1000_0000_0000,
        "a major above 12 bits moves up by 32"
    );
    assert_eq!(makedev(0xFFF, 0xFF), 0xF_FFFF);
    assert_eq!(
        makedev(u32::MAX, u32::MAX),
        u64::MAX,
        "the four fields tile the 64 bits: minor 0-7, major 8-19, minor 20-43, major 44-63"
    );
}

#[test]
fn dev_parts_is_the_inverse_of_makedev() {
    for (major, minor) in [
        (8, 1),
        (259, 3),
        (0, 256),
        (0x1000, 0),
        (0xFFF, 0xFF),
        (u32::MAX, u32::MAX),
    ] {
        assert_eq!(
            dev_parts(makedev(major, minor)),
            (major, minor),
            "({major}, {minor})"
        );
    }
    assert_eq!(dev_parts(2_049), (8, 1));
    assert_eq!(dev_parts(0x1_0303), (259, 3));
}

// ---------------------------------------------------------------------------
// The stx_mask rule
// ---------------------------------------------------------------------------

fn full(mode: u16) -> StatxFacts {
    StatxFacts {
        mask: STATX_WANTED | STATX_ATIME,
        mode,
        nlink: 1,
        ino: 4_242,
        size: 4_097,
        blocks: 16,
        mtime: (1_700_000_000, 123_456_789),
        atime: (1_700_000_100, 999_999),
        dev_major: 259,
        dev_minor: 3,
    }
}

#[test]
fn a_full_mask_yields_every_fact_as_the_legacy_walker_records_it() {
    let m = meta_from_statx(&full(S_IFREG | 0o644), true, DT_REG);
    assert_eq!(m.kind, KIND_FILE);
    assert_eq!(m.flags, 0, "Linux has no dataless flag");
    assert_eq!(m.size.to_bits(), 4_097.0_f64.to_bits());
    assert_eq!(m.alloc.to_bits(), 8_192.0_f64.to_bits(), "blocks * 512");
    assert_eq!(
        m.mtime_ms.to_bits(),
        time_ms(1_700_000_000, 123_456_789).to_bits()
    );
    assert_eq!(
        m.atime_ms.to_bits(),
        time_ms(1_700_000_100, 999_999).to_bits()
    );
    assert_eq!(
        m.dev.to_bits(),
        (0x1_0303_u64 as f64).to_bits(),
        "makedev(259, 3)"
    );
    assert_eq!(m.ino.to_bits(), 4_242.0_f64.to_bits());
    assert_eq!(m.nlink, 1);
    assert!(!m.withheld);
}

#[test]
fn the_kind_comes_from_the_mode_and_a_directory_keeps_no_sizes() {
    let d = meta_from_statx(&full(S_IFDIR | 0o755), true, DT_DIR);
    assert_eq!(d.kind, KIND_DIR);
    assert_eq!(d.size.to_bits(), 0.0_f64.to_bits());
    assert_eq!(d.alloc.to_bits(), 0.0_f64.to_bits());
    assert_eq!(
        d.nlink, 0,
        "a directory's link count is not a fact the walk records"
    );
    assert!(!d.withheld);
    let l = meta_from_statx(&full(S_IFLNK | 0o777), true, DT_LNK);
    assert_eq!(l.kind, KIND_SYMLINK);
    assert_eq!(
        l.size.to_bits(),
        4_097.0_f64.to_bits(),
        "a link's size is its target's length"
    );
    let fifo = meta_from_statx(&full(0o010_644), true, DT_UNKNOWN);
    assert_eq!(fifo.kind, KIND_FILE, "a fifo is a leaf");
    let raced = meta_from_statx(&full(S_IFREG | 0o644), true, DT_DIR);
    assert_eq!(
        raced.kind, KIND_FILE,
        "statx is fresher than d_type when both are known"
    );
}

#[test]
fn a_withheld_attribute_leaves_the_unknown_value_and_marks_the_entry() {
    let mut no_size = full(S_IFREG | 0o644);
    no_size.mask &= !STATX_SIZE;
    let m = meta_from_statx(&no_size, true, DT_REG);
    assert_eq!(m.size.to_bits(), 0.0_f64.to_bits());
    assert_eq!(
        m.alloc.to_bits(),
        8_192.0_f64.to_bits(),
        "what was returned is read"
    );
    assert!(m.withheld);

    let mut no_mtime = full(S_IFREG | 0o644);
    no_mtime.mask &= !STATX_MTIME;
    let m = meta_from_statx(&no_mtime, true, DT_REG);
    assert!(m.mtime_ms.is_nan());
    assert!(m.withheld);

    let mut no_blocks = full(S_IFREG | 0o644);
    no_blocks.mask &= !STATX_BLOCKS;
    let m = meta_from_statx(&no_blocks, true, DT_REG);
    assert_eq!(m.alloc.to_bits(), 0.0_f64.to_bits());
    assert!(m.withheld);

    let mut no_ino = full(S_IFREG | 0o644);
    no_ino.mask &= !STATX_INO;
    let m = meta_from_statx(&no_ino, true, DT_REG);
    assert_eq!(m.ino.to_bits(), 0.0_f64.to_bits());
    assert!(m.withheld);

    let mut no_nlink = full(S_IFREG | 0o644);
    no_nlink.mask &= !STATX_NLINK;
    let m = meta_from_statx(&no_nlink, true, DT_REG);
    assert_eq!(m.nlink, 0);
    assert!(m.withheld);

    let mut dir_no_file_group = full(S_IFDIR | 0o755);
    dir_no_file_group.mask &= !(STATX_SIZE | STATX_BLOCKS | STATX_NLINK);
    let m = meta_from_statx(&dir_no_file_group, true, DT_DIR);
    assert!(
        !m.withheld,
        "a directory has no sizes or link count to withhold"
    );
    assert_eq!(m.kind, KIND_DIR);
}

#[test]
fn a_withheld_type_falls_back_to_d_type_and_is_still_marked() {
    let mut no_type = full(S_IFREG | 0o644);
    no_type.mask &= !(STATX_TYPE | STATX_MODE);
    let as_dir = meta_from_statx(&no_type, true, DT_DIR);
    assert_eq!(
        as_dir.kind, KIND_DIR,
        "d_type decides when the mode is withheld"
    );
    assert!(as_dir.withheld);
    let as_link = meta_from_statx(&no_type, true, DT_LNK);
    assert_eq!(as_link.kind, KIND_SYMLINK);
    let as_reg = meta_from_statx(&no_type, true, DT_REG);
    assert_eq!(as_reg.kind, KIND_FILE);
    let unknown = meta_from_statx(&no_type, true, DT_UNKNOWN);
    assert_eq!(
        unknown.kind, KIND_FILE,
        "nothing says directory: a leaf, marked withheld"
    );
    assert!(unknown.withheld);
    let mut only_type = full(S_IFDIR);
    only_type.mask &= !STATX_MODE;
    assert_eq!(
        meta_from_statx(&only_type, true, DT_UNKNOWN).kind,
        KIND_DIR,
        "STATX_TYPE alone is enough for the kind"
    );
}

#[test]
fn atime_is_nan_when_not_wanted_or_not_returned_and_never_marks_the_entry() {
    let m = meta_from_statx(&full(S_IFREG | 0o644), false, DT_REG);
    assert!(m.atime_ms.is_nan(), "returned but not wanted");
    assert!(!m.withheld);
    let mut no_atime = full(S_IFREG | 0o644);
    no_atime.mask &= !STATX_ATIME;
    let m = meta_from_statx(&no_atime, true, DT_REG);
    assert!(m.atime_ms.is_nan(), "wanted but not returned");
    assert!(
        !m.withheld,
        "as on macOS, a missing atime is not a withheld fact"
    );
}

#[test]
fn the_requested_mask_is_exactly_the_legacy_facts() {
    assert_eq!(
        STATX_WANTED,
        STATX_TYPE | STATX_MODE | STATX_SIZE | STATX_BLOCKS | STATX_MTIME | STATX_INO | STATX_NLINK
    );
    assert_eq!(
        STATX_WANTED & STATX_ATIME,
        0,
        "atime is added only when wanted"
    );
}

#[test]
fn blocks_times_512_saturates_rather_than_wrapping() {
    let mut huge = full(S_IFREG | 0o644);
    huge.blocks = u64::MAX;
    let m = meta_from_statx(&huge, false, DT_REG);
    assert_eq!(m.alloc.to_bits(), (u64::MAX as f64).to_bits());
}

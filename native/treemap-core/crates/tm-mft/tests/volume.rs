//! The volume reader on synthetic NTFS volumes, on every platform.
//!
//! A volume here is clusters in memory with `$MFT`'s records laid out
//! through its own runs — fragmented, its later extents named by an
//! extension record of `$MFT`, a stale extension of an older `$MFT` beside
//! it, records past the initialized size that look in use — plus `$UpCase`
//! and a scan root. Every read the reader makes is recorded and must be
//! whole clusters from a cluster boundary, at most one chunk. The portable
//! pieces of the Windows boundary (the order of the calls and every refusal
//! on their answers) run through a scripted [`VolumeApi`]. Only the calls
//! themselves are left to the Windows CI leg (`tests/live_windows.rs`).

mod common;

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

use common::{
    DATA, DIRECTORY, Extent, FILE_NAME, FileRecord, IN_USE, STANDARD_INFORMATION, WIN32,
    WIN32_AND_DOS, file_name, non_resident, put, resident, std_info,
};
use tm_mft::volume::{MAX_CLUSTER_BYTES, UPCASE_BYTES, VOLUME_DATA_BYTES};
use tm_mft::win32::{
    DRIVE_NO_ROOT_DIR, DRIVE_REMOTE, DRIVE_UNKNOWN, IO_ALIGN, aligned_window, check_drive_type,
    check_file_system, check_root, check_same_volume, device_path, file_reference, open_error,
    root_name, text_until_nul,
};
use tm_mft::{
    BuildError, Chunk, Geometry, MAX_CHUNK_BYTES, MftError, MftExtents, OpenedVolume, RecordError,
    RootIdentity, Volume, VolumeApi, VolumeFacts, VolumeInformation, plan_chunks, read_mft,
    read_volume_with,
};
use tm_walk::WalkOutput;
use tm_walk::platform::thread_cpu_seconds;

type TestResult = Result<(), String>;

/// 2024-01-01T00:00:00Z as a FILETIME.
const FT: i64 = 133_485_408_000_000_000;
/// The volume serial number every synthetic volume carries.
const SERIAL: u32 = 0x1234_5678;
/// The scan root's record.
const SCAN: u64 = 20;
/// The scan root's file reference: sequence 1 over record 20.
const SCAN_REFERENCE: u64 = reference(1, SCAN);
/// The name the path gives the root, which the records do not know.
const ROOT_NAME: &str = "scan-root";
/// The records `$MFT`'s initialized size holds in every volume but the
/// tests that change it.
const INITIALIZED: u64 = 50;
/// A cluster no extent maps, where a stale extension points.
const STALE_LCN: u64 = 70;
/// `IN_USE` alone: a file.
const FILE: u16 = IN_USE;
/// A directory.
const DIR: u16 = IN_USE | DIRECTORY;
/// Not in use: a deleted file's record.
const DELETED: u16 = 0;

// ---------------------------------------------------------------------------
// Synthetic volumes
// ---------------------------------------------------------------------------

/// A file reference: `sequence` over the 48-bit record number.
const fn reference(sequence: u64, record: u64) -> u64 {
    (sequence << 48) | record
}

/// Every read a test image was asked for, shared with the test once the
/// image is handed over.
type Reads = Rc<RefCell<Vec<(u64, u64)>>>;

/// A plan layout: cluster size, record size, `$MFT`'s runs.
type Layout = (u64, u64, Vec<(Option<u64>, u64)>);

fn usize_of(n: u64) -> Result<usize, String> {
    usize::try_from(n).map_err(|e| e.to_string())
}

/// A run list of `(lcn, clusters)` runs, each written with 8-byte fields and
/// its LCN relative to the previous run's, as every extent's list starts
/// from LCN 0.
fn run_list(runs: &[(u64, u64)]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut previous = 0_i128;
    for &(lcn, clusters) in runs {
        out.push(0x88);
        out.extend(clusters.to_le_bytes());
        let delta = i64::try_from(i128::from(lcn) - previous).unwrap_or(i64::MAX);
        out.extend(delta.to_le_bytes());
        previous = i128::from(lcn);
    }
    out.push(0);
    out
}

/// An unnamed, non-resident `$DATA` extent.
fn data_extent(lowest: u64, highest: u64, size: u64, initialized: u64, runs: Vec<u8>) -> Vec<u8> {
    non_resident(
        DATA,
        "",
        0,
        &Extent {
            lowest_vcn: lowest,
            highest_vcn: highest,
            allocated: size,
            size,
            initialized,
            compressed: None,
            runs,
        },
    )
}

/// An `$UpCase` table that upper-cases ASCII letters — but maps `x` to
/// `0`, which no built-in table would (a name starting with `x` sorts first
/// only if the reader used the table it read off the volume), and `b` to
/// U+0100, above every other unit here (a name starting with `b` sorts last
/// only if the table was read little-endian: read the other way round, it
/// is 0x0001 and sorts first, where every value below 256 keeps its order).
fn volume_upcase() -> Vec<u16> {
    (0..=u16::MAX)
        .map(|u| match u {
            0x78 => 0x30,
            0x62 => 0x0100,
            0x61..=0x7A => u - 0x20,
            _ => u,
        })
        .collect()
}

/// A volume to lay out: its geometry, `$MFT`'s runs in VCN order, which
/// record holds which of them, and every record by number.
#[derive(Clone)]
struct Spec {
    cluster: u64,
    record: u64,
    /// `$MFT`'s runs in VCN order: `(lcn, clusters)`.
    mft_runs: Vec<(u64, u64)>,
    /// `(holder, runs)`: record 0 (holder 0) holds the first `runs` of
    /// `mft_runs`, each extension record the next ones.
    split: Vec<(u64, usize)>,
    /// The records `$MFT`'s own `$DATA` says are initialized.
    initialized: u64,
    /// Bytes more its initialized size holds: part of the next record.
    initialized_extra: u64,
    /// What `FSCTL_GET_NTFS_VOLUME_DATA` says is initialized, in bytes.
    valid_data_length: u64,
    upcase_lcn: u64,
    upcase: Vec<u16>,
    clusters: u64,
    /// Every record by number; `None` clears one the layout would write.
    records: BTreeMap<u64, Option<FileRecord>>,
    /// Bytes written over a record's slot as they are.
    raw: BTreeMap<u64, Vec<u8>>,
}

impl Spec {
    /// A volume of `cluster`-byte clusters and `record`-byte records whose
    /// `$MFT` is `mft_runs`, split between record 0 and extension records
    /// as `split` says; `$UpCase` at `upcase_lcn`.
    fn new(
        cluster: u64,
        record: u64,
        mft_runs: Vec<(u64, u64)>,
        split: Vec<(u64, usize)>,
        upcase_lcn: u64,
    ) -> Self {
        let mut s = Self {
            cluster,
            record,
            mft_runs,
            split,
            initialized: INITIALIZED,
            initialized_extra: 0,
            valid_data_length: 0,
            upcase_lcn,
            upcase: volume_upcase(),
            clusters: upcase_lcn + UPCASE_BYTES.div_ceil(cluster),
            records: BTreeMap::new(),
            raw: BTreeMap::new(),
        };
        s.valid_data_length = s.mft_records() * record;
        s.files();
        s
    }

    fn mft_records(&self) -> u64 {
        self.mft_runs.iter().map(|r| r.1).sum::<u64>() * self.cluster / self.record
    }

    fn geometry(&self) -> Result<Geometry, String> {
        Geometry::new(
            self.cluster,
            self.record,
            i64::try_from(self.mft_runs.first().map_or(0, |r| r.0)).map_err(|e| e.to_string())?,
            i64::try_from(self.valid_data_length).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    }

    fn facts(&self) -> Result<VolumeFacts, String> {
        Ok(VolumeFacts {
            geometry: self.geometry()?,
            serial: SERIAL,
            root_reference: SCAN_REFERENCE,
            root_name: ROOT_NAME.to_owned(),
        })
    }

    /// A record of this volume's size with `$STANDARD_INFORMATION` and one
    /// `$FILE_NAME`.
    fn named(
        &self,
        number: u64,
        sequence: u16,
        flags: u16,
        parent: (u64, u16),
        name: &str,
    ) -> FileRecord {
        let mut r = FileRecord::new(u32::try_from(number).unwrap_or(u32::MAX));
        r.sequence = sequence;
        r.flags = flags;
        r.size = usize::try_from(self.record).unwrap_or(0);
        let namespace = if name.starts_with('$') || name == "." {
            WIN32_AND_DOS
        } else {
            WIN32
        };
        r.attr(resident(
            STANDARD_INFORMATION,
            "",
            0,
            &std_info(FT, FT, 0x20),
        ))
        .attr(resident(
            FILE_NAME,
            "",
            0,
            &file_name(parent.0, parent.1, namespace, name),
        ))
    }

    fn file(&self, number: u64, parent: u64, name: &str, size: usize) -> FileRecord {
        self.named(number, 1, FILE, (parent, 1), name)
            .attr(resident(DATA, "", 0, &vec![b'x'; size]))
    }

    /// The root directory, `$UpCase` and the scan root's tree; `$MFT`'s own
    /// records come from [`Self::mft_records_for`] when the image is laid out.
    fn files(&mut self) {
        let upcase_clusters = UPCASE_BYTES.div_ceil(self.cluster);
        let set = [
            (5, self.named(5, 5, DIR, (5, 5), ".")),
            (
                10,
                self.named(10, 10, FILE, (5, 5), "$UpCase")
                    .attr(data_extent(
                        0,
                        upcase_clusters - 1,
                        UPCASE_BYTES,
                        UPCASE_BYTES,
                        run_list(&[(self.upcase_lcn, upcase_clusters)]),
                    )),
            ),
            (SCAN, self.named(SCAN, 1, DIR, (5, 5), "scan")),
            (21, self.file(21, SCAN, "b.txt", 10)),
            (22, self.file(22, SCAN, "A.txt", 20)),
            (23, self.named(23, 1, DIR, (SCAN, 1), "sub")),
            (24, self.file(24, 23, "inner.bin", 30)),
            (25, self.file(25, SCAN, "x-first.txt", 40)),
            (26, self.named(26, 1, DELETED, (SCAN, 1), "gone.txt")),
            // One file, two names: a hard link, keyed by the serial.
            (
                27,
                self.file(27, SCAN, "l-one.txt", 5).attr(resident(
                    FILE_NAME,
                    "",
                    0,
                    &file_name(23, 1, WIN32, "l-two.txt"),
                )),
            ),
            (33, self.file(33, SCAN, "far.txt", 50)),
            (45, self.file(45, 23, "late.txt", 60)),
            // Past the initialized size: stale bytes that look like an entry.
            (55, self.file(55, SCAN, "ghost.txt", 70)),
        ];
        for (n, r) in set {
            self.records.insert(n, Some(r));
        }
    }

    /// Record 0 and the extension records holding `$MFT`'s later extents.
    fn mft_records_for(&self) -> Vec<(u64, FileRecord)> {
        let mut out = Vec::new();
        let mut next_run = 0_usize;
        let mut vcn = 0_u64;
        let size = self.mft_records() * self.record;
        for &(holder, count) in &self.split {
            let runs: Vec<(u64, u64)> = self
                .mft_runs
                .iter()
                .skip(next_run)
                .take(count)
                .copied()
                .collect();
            next_run += count;
            let clusters: u64 = runs.iter().map(|r| r.1).sum();
            let (sizes, initialized) = if holder == 0 {
                (
                    size,
                    self.initialized * self.record + self.initialized_extra,
                )
            } else {
                (0, 0)
            };
            let extent = data_extent(vcn, vcn + clusters - 1, sizes, initialized, run_list(&runs));
            vcn += clusters;
            let rec = if holder == 0 {
                self.named(0, 1, FILE, (5, 5), "$MFT").attr(extent)
            } else {
                let mut r = FileRecord::new(u32::try_from(holder).unwrap_or(u32::MAX));
                r.base = 1 << 48; // record 0, sequence 1
                r.size = usize::try_from(self.record).unwrap_or(0);
                r.attr(extent)
            };
            out.push((holder, rec));
        }
        out
    }

    /// Record `n`'s byte offset, through `$MFT`'s runs.
    fn offset_of(&self, n: u64) -> Result<u64, String> {
        let mut first = 0_u64;
        for &(lcn, clusters) in &self.mft_runs {
            let count = clusters * self.cluster / self.record;
            if n < first + count {
                return Ok(lcn * self.cluster + (n - first) * self.record);
            }
            first += count;
        }
        Err(format!("record {n} is past $MFT's runs"))
    }

    fn image(&self) -> Result<Image, String> {
        let mut bytes = vec![0_u8; usize_of(self.clusters * self.cluster)?];
        let mut all: BTreeMap<u64, Option<FileRecord>> = self
            .mft_records_for()
            .into_iter()
            .map(|(n, r)| (n, Some(r)))
            .collect();
        for (n, r) in &self.records {
            all.insert(*n, r.clone());
        }
        for (n, r) in &all {
            if let Some(r) = r {
                put(&mut bytes, usize_of(self.offset_of(*n)?)?, &r.on_disk()?)?;
            }
        }
        for (n, raw) in &self.raw {
            put(&mut bytes, usize_of(self.offset_of(*n)?)?, raw)?;
        }
        let table: Vec<u8> = self.upcase.iter().flat_map(|u| u.to_le_bytes()).collect();
        put(
            &mut bytes,
            usize_of(self.upcase_lcn * self.cluster)?,
            &table,
        )?;
        Ok(Image::new(
            bytes,
            self.cluster,
            self.geometry()?.chunk_bytes(),
        ))
    }

    /// The bytes of record `n` as laid out (for a raw override built from them).
    fn on_disk(&self, n: u64) -> Result<Vec<u8>, String> {
        self.records
            .get(&n)
            .cloned()
            .flatten()
            .ok_or_else(|| format!("no record {n}"))?
            .on_disk()
    }
}

/// The volume most tests read: 4 KiB clusters, 1 KiB records, `$MFT` in two
/// runs of 8 clusters (records 0-31 at LCN 16, 32-63 at LCN 40), record 0
/// holding the first and record 17 — an extension of `$MFT` — the second;
/// record 18 an extension of an older `$MFT` (sequence 7) naming clusters
/// that are not `$MFT`'s. `$UpCase` at LCN 100.
fn standard() -> Spec {
    let mut s = Spec::new(
        4096,
        1024,
        vec![(16, 8), (40, 8)],
        vec![(0, 1), (17, 1)],
        100,
    );
    let mut stale = FileRecord::new(18);
    stale.base = 7 << 48;
    stale.size = 1024;
    s.records.insert(
        18,
        Some(stale.attr(data_extent(8, 15, 0, 0, run_list(&[(STALE_LCN, 8)])))),
    );
    s
}

/// A volume whose whole `$MFT` is one run named by record 0.
fn single_run(cluster: u64, record: u64) -> Spec {
    let clusters = (64 * record).div_ceil(cluster);
    Spec::new(
        cluster,
        record,
        vec![(16, clusters)],
        vec![(0, 1)],
        16 + clusters + 4,
    )
}

/// Where a read tears a record: the next `times` reads holding the record
/// at `at` return it with its second unit's last two bytes flipped, as a
/// sector written from an older version of the record would read.
#[derive(Clone, Copy, Debug)]
struct Tear {
    at: u64,
    times: u32,
}

/// A volume in memory. Every read is recorded, and one that is not whole
/// clusters from a cluster boundary, or larger than one chunk, fails.
struct Image {
    bytes: Vec<u8>,
    cluster: u64,
    max_read: u64,
    reads: Reads,
    tears: Vec<Tear>,
    delay: Duration,
    /// Thread CPU seconds the first read burns.
    burn: f64,
}

impl Image {
    fn new(bytes: Vec<u8>, cluster: u64, max_read: u64) -> Self {
        Self {
            bytes,
            cluster,
            max_read,
            reads: Rc::new(RefCell::new(Vec::new())),
            tears: Vec::new(),
            delay: Duration::ZERO,
            burn: 0.0,
        }
    }

    fn reads(&self) -> Vec<(u64, u64)> {
        self.reads.borrow().clone()
    }
}

impl Volume for Image {
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<(), MftError> {
        let len = u64::try_from(buf.len()).unwrap_or(u64::MAX);
        self.reads.borrow_mut().push((offset, len));
        if offset % self.cluster != 0 || len % self.cluster != 0 || len == 0 || len > self.max_read
        {
            return Err(MftError::Io {
                call: "the test image",
                message: format!("a read of {len} bytes at {offset}"),
            });
        }
        let start = usize::try_from(offset).unwrap_or(usize::MAX);
        let available = self.bytes.len().saturating_sub(start).min(buf.len());
        let src = self
            .bytes
            .get(start..start.saturating_add(buf.len()))
            .ok_or(MftError::ShortRead {
                offset,
                wanted: len,
                got: u64::try_from(available).unwrap_or(0),
            })?;
        buf.copy_from_slice(src);
        for tear in &mut self.tears {
            if tear.times > 0 && tear.at >= offset && tear.at + 1024 <= offset + len {
                let unit_end = usize::try_from(tear.at - offset + 1022).unwrap_or(usize::MAX);
                if let Some(b) = buf.get_mut(unit_end) {
                    *b ^= 0xFF;
                }
                tear.times -= 1;
            }
        }
        std::thread::sleep(self.delay);
        if self.burn > 0.0 {
            let from = thread_cpu_seconds();
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut x = 0_u64;
            while thread_cpu_seconds() - from < self.burn && Instant::now() < deadline {
                x = std::hint::black_box(x.wrapping_mul(31).wrapping_add(7));
            }
            self.burn = 0.0;
        }
        Ok(())
    }
}

fn read(spec: &Spec) -> Result<(WalkOutput, Vec<(u64, u64)>), String> {
    let mut image = spec.image()?;
    let out = read_mft(&mut image, &spec.facts()?, false).map_err(|e| e.to_string())?;
    Ok((out, image.reads()))
}

fn refusal(spec: &Spec) -> Result<MftError, String> {
    let mut image = spec.image()?;
    match read_mft(&mut image, &spec.facts()?, false) {
        Ok(out) => Err(format!(
            "read {} nodes where a refusal was expected",
            out.len()
        )),
        Err(e) => Ok(e),
    }
}

fn names(out: &WalkOutput) -> Vec<String> {
    (0..out.len())
        .map(|i| String::from_utf8_lossy(out.name(i).unwrap_or_default()).into_owned())
        .collect()
}

fn bits(values: &[f64]) -> Vec<u64> {
    values.iter().map(|v| v.to_bits()).collect()
}

/// The scan root's subtree, breadth first, in the volume's `$UpCase` order:
/// `x` upper-cases to `0`, before every letter, and `b` to U+0100, after
/// them all; `-` (0x2D) before `A`.
const EXPECTED: [&str; 10] = [
    ROOT_NAME,
    "x-first.txt",
    "A.txt",
    "far.txt",
    "l-one.txt",
    "sub",
    "b.txt",
    "inner.bin",
    "l-two.txt",
    "late.txt",
];
const EXPECTED_SIZES: [f64; 10] = [0.0, 40.0, 20.0, 50.0, 5.0, 0.0, 10.0, 30.0, 5.0, 60.0];

fn assert_expected_tree(out: &WalkOutput) {
    assert_eq!(names(out), EXPECTED);
    assert_eq!(bits(&out.size), bits(&EXPECTED_SIZES));
    assert_eq!(out.parent, vec![0, 0, 0, 0, 0, 0, 0, 5, 5, 5]);
    assert_eq!(out.stats.entries, 9);
    assert_eq!(out.stats.dirs_listed, 2);
    // The two names of record 27: one family, told apart from nothing else.
    let links: Vec<(u32, u32)> = out.hardlinks.iter().map(|h| (h.node, h.family)).collect();
    assert_eq!(links, vec![(4, 0), (8, 0)]);
}

// ---------------------------------------------------------------------------
// The whole read
// ---------------------------------------------------------------------------

#[test]
fn a_fragmented_mft_is_read_once_through_its_own_extension_record() -> TestResult {
    let spec = standard();
    let (out, reads) = read(&spec)?;
    assert_expected_tree(&out);
    assert_eq!(
        reads,
        vec![
            (16 * 4096, 4096),   // record 0, to start from
            (16 * 4096, 32_768), // the first run: records 0-31, record 17 among them
            // The second run, named by record 17: records 32-49, the last
            // one's cluster whole; records 52-63 (the ghost) never read.
            (40 * 4096, 20_480),
            (100 * 4096, 131_072), // $UpCase
        ]
    );
    Ok(())
}

#[test]
fn every_read_is_whole_clusters_of_at_most_a_mebibyte_on_other_geometries() -> TestResult {
    // 4 KiB records on 4 KiB clusters (a 4K-native disk: the fix-ups still
    // use the 512-byte stride, eight units a record), and 1 KiB records on
    // 512-byte clusters (two clusters a record).
    // 256 KiB clusters are larger than $UpCase: it is read as one cluster.
    for (cluster, record) in [(4096, 4096), (512, 1024), (65_536, 1024), (262_144, 1024)] {
        let spec = single_run(cluster, record);
        let (out, reads) = read(&spec).map_err(|e| format!("{cluster}/{record}: {e}"))?;
        assert_expected_tree(&out);
        let first = reads.first().copied().ok_or("no read")?;
        assert_eq!(
            first,
            (16 * cluster, cluster.max(record)),
            "{cluster}/{record}: record 0 first, in whole clusters"
        );
    }
    Ok(())
}

#[test]
fn extents_are_joined_in_vcn_order_whatever_order_their_records_are_in() -> TestResult {
    // Record 17 names the third run (VCN 16-19) and record 19 the second
    // (VCN 8-15): met in record order, joined in VCN order.
    let mut spec = Spec::new(
        4096,
        1024,
        vec![(16, 8), (40, 8), (80, 4)],
        vec![(0, 1), (19, 1), (17, 1)],
        100,
    );
    spec.initialized = 70;
    spec.valid_data_length = 80 * 1024;
    let far_run = spec.file(66, SCAN, "c-third-run.txt", 5);
    spec.records.insert(66, Some(far_run));
    let (out, reads) = read(&spec)?;
    assert!(names(&out).contains(&"c-third-run.txt".to_owned()));
    assert!(names(&out).contains(&"late.txt".to_owned()));
    assert!(
        reads.contains(&(80 * 4096, 8192)),
        "records 64-69 of the third run: {reads:?}"
    );
    // Without record 19, VCN 8-15 is a gap: the extent past it is never
    // joined across it, and the read stops, refused, where the gap starts.
    spec.records.insert(19, None);
    assert_eq!(
        refusal(&spec)?,
        MftError::MftIncomplete {
            read: 32,
            wanted: 70
        }
    );
    Ok(())
}

#[test]
fn a_deleted_extension_of_the_mft_is_not_followed() -> TestResult {
    // Record 19 was an extension of this very $MFT (sequence 1), naming
    // VCN 8 too, but it is no longer in use: followed, it would overlap
    // record 17's extent.
    let mut spec = standard();
    let mut deleted = FileRecord::new(19);
    deleted.base = reference(1, 0);
    deleted.flags = DELETED;
    deleted.size = 1024;
    spec.records.insert(
        19,
        Some(deleted.attr(data_extent(8, 15, 0, 0, run_list(&[(STALE_LCN, 8)])))),
    );
    assert_expected_tree(&read(&spec)?.0);
    Ok(())
}

#[test]
fn without_its_extension_record_the_mft_is_refused_as_incomplete() -> TestResult {
    // Record 18 (an extension of an older $MFT, sequence 7) names VCN 8 too,
    // but is not $MFT's: nothing maps records 32-49.
    let mut spec = standard();
    spec.records.insert(17, None);
    assert_eq!(
        refusal(&spec)?,
        MftError::MftIncomplete {
            read: 32,
            wanted: INITIALIZED
        }
    );
    Ok(())
}

#[test]
fn two_extents_mapping_one_vcn_are_refused() -> TestResult {
    let mut spec = standard();
    let mut again = FileRecord::new(19);
    again.base = 1 << 48;
    again.size = 1024;
    spec.records.insert(
        19,
        Some(again.attr(data_extent(8, 15, 0, 0, run_list(&[(40, 8)])))),
    );
    assert_eq!(
        refusal(&spec)?,
        MftError::OverlappingExtents {
            stream: "$MFT",
            vcn: 8
        }
    );
    Ok(())
}

#[test]
fn the_read_stops_at_the_smaller_of_the_two_initialized_sizes() -> TestResult {
    // FSCTL_GET_NTFS_VOLUME_DATA says 40 records, record 0 says 50.
    let mut spec = standard();
    spec.valid_data_length = 40 * 1024;
    let (out, reads) = read(&spec)?;
    assert!(names(&out).contains(&"far.txt".to_owned()));
    assert!(!names(&out).contains(&"late.txt".to_owned()), "record 45");
    assert!(
        reads.contains(&(40 * 4096, 8192)),
        "records 32-39: {reads:?}"
    );
    // Record 0 says 40, the volume data 64.
    let mut spec = standard();
    spec.initialized = 40;
    let (out, reads) = read(&spec)?;
    assert!(!names(&out).contains(&"late.txt".to_owned()));
    assert!(reads.contains(&(40 * 4096, 8192)), "{reads:?}");
    Ok(())
}

#[test]
fn a_record_torn_once_is_read_again_and_used() -> TestResult {
    let spec = standard();
    let mut image = spec.image()?;
    image.tears.push(Tear {
        at: spec.offset_of(22)?,
        times: 1,
    });
    let out = read_mft(&mut image, &spec.facts()?, false).map_err(|e| e.to_string())?;
    assert_expected_tree(&out);
    let reads = image.reads();
    assert_eq!(
        reads.get(2),
        Some(&(21 * 4096, 4096)),
        "the torn record's cluster, read again right after its chunk: {reads:?}"
    );
    assert_eq!(reads.len(), 5);
    Ok(())
}

#[test]
fn a_record_torn_on_both_reads_refuses_the_scan() -> TestResult {
    let spec = standard();
    let mut image = spec.image()?;
    image.tears.push(Tear {
        at: spec.offset_of(22)?,
        times: 2,
    });
    let got = read_mft(&mut image, &spec.facts()?, false);
    assert_eq!(
        got.map(|o| o.len()),
        Err(MftError::BadRecord {
            record: 22,
            error: RecordError::FixupMismatch { sector: 1 }
        })
    );
    Ok(())
}

#[test]
fn a_record_the_initialized_size_ends_inside_is_not_read() -> TestResult {
    // The initialized size ends 512 bytes into record 50: its second half is
    // whatever the disk held, so the record is left out whole.
    let mut spec = standard();
    spec.initialized_extra = 512;
    let half = spec.file(50, SCAN, "half.txt", 7);
    spec.records.insert(50, Some(half));
    assert_expected_tree(&read(&spec)?.0);
    Ok(())
}

#[test]
fn a_torn_record_not_in_use_is_skipped_without_a_second_read() -> TestResult {
    let spec = standard();
    let mut image = spec.image()?;
    image.tears.push(Tear {
        at: spec.offset_of(26)?,
        times: 9,
    });
    let out = read_mft(&mut image, &spec.facts()?, false).map_err(|e| e.to_string())?;
    assert_expected_tree(&out);
    assert_eq!(image.reads().len(), 4, "{:?}", image.reads());
    Ok(())
}

#[test]
fn record_0_torn_once_is_read_again_too() -> TestResult {
    let spec = standard();
    let mut image = spec.image()?;
    image.tears.push(Tear {
        at: spec.offset_of(0)?,
        times: 1,
    });
    let out = read_mft(&mut image, &spec.facts()?, false).map_err(|e| e.to_string())?;
    assert_expected_tree(&out);
    assert_eq!(
        image.reads().get(..2),
        Some(&[(16 * 4096, 4096), (16 * 4096, 4096)][..])
    );
    Ok(())
}

#[test]
fn records_without_a_file_signature_are_skipped() -> TestResult {
    // Record 12 was never written (zeros); record 21 is marked BAAD by chkdsk.
    let mut spec = standard();
    let mut baad = spec.on_disk(21)?;
    put(&mut baad, 0, b"BAAD")?;
    spec.raw.insert(21, baad);
    let (out, _) = read(&spec)?;
    assert!(!names(&out).contains(&"b.txt".to_owned()));
    assert_eq!(out.stats.entries, 8);
    Ok(())
}

#[test]
fn an_in_use_record_that_does_not_parse_refuses_the_scan() -> TestResult {
    let mut spec = standard();
    let bad = spec
        .named(21, 1, FILE, (SCAN, 1), "b.txt")
        .attr(vec![0x80, 0, 0, 0, 0, 0, 0, 0]); // $DATA of length 0
    spec.records.insert(21, Some(bad));
    assert!(
        matches!(
            refusal(&spec)?,
            MftError::BadRecord {
                record: 21,
                error: RecordError::BadAttribute { .. }
            }
        ),
        "a zero-length attribute"
    );
    // The same bytes in a record that is not in use are never a fact.
    let mut spec = standard();
    let deleted = spec
        .named(26, 1, DELETED, (SCAN, 1), "gone.txt")
        .attr(vec![0x80, 0, 0, 0, 0, 0, 0, 0]);
    spec.records.insert(26, Some(deleted));
    assert_expected_tree(&read(&spec)?.0);
    Ok(())
}

#[test]
fn an_in_use_record_whose_header_names_another_number_refuses_the_scan() -> TestResult {
    let mut spec = standard();
    let elsewhere = spec.file(99, SCAN, "b.txt", 10);
    spec.raw.insert(21, elsewhere.on_disk()?);
    assert_eq!(
        refusal(&spec)?,
        MftError::MisplacedRecord {
            position: 21,
            number: 99
        }
    );
    // A deleted record naming another number is no record at all.
    let mut spec = standard();
    let stale = spec.named(98, 1, DELETED, (SCAN, 1), "stale.txt");
    spec.raw.insert(26, stale.on_disk()?);
    assert_expected_tree(&read(&spec)?.0);
    Ok(())
}

#[test]
fn record_0_must_be_the_in_use_mft_holding_its_first_extent() -> TestResult {
    let mft = |spec: &Spec| -> Result<Vec<u8>, String> {
        spec.mft_records_for()
            .into_iter()
            .find(|(n, _)| *n == 0)
            .ok_or("no record 0")?
            .1
            .on_disk()
    };
    let bad = |reason: &'static str| MftError::BadMftRecord { reason };
    let base = standard();
    let cases: Vec<(&str, Vec<u8>, MftError)> = vec![
        (
            "never written",
            vec![0; 1024],
            bad("no in-use FILE record is at MftStartLcn"),
        ),
        (
            "not in use",
            {
                let mut b = mft(&base)?;
                put(&mut b, 0x16, &0_u16.to_le_bytes())?;
                b
            },
            bad("no in-use FILE record is at MftStartLcn"),
        ),
        (
            "numbered 1",
            {
                let mut b = mft(&base)?;
                put(&mut b, 0x2C, &1_u32.to_le_bytes())?;
                b
            },
            bad("the record at MftStartLcn is not record 0"),
        ),
        (
            "an extension",
            {
                let mut b = mft(&base)?;
                put(&mut b, 0x20, &((1_u64 << 48) | 5).to_le_bytes())?;
                b
            },
            bad("the record at MftStartLcn is not record 0"),
        ),
        (
            "sequence 0",
            {
                let mut b = mft(&base)?;
                put(&mut b, 0x10, &0_u16.to_le_bytes())?;
                b
            },
            bad(
                "record 0 has sequence number 0, which would make every base record read as one of its extensions",
            ),
        ),
        (
            "named otherwise",
            base.named(0, 1, FILE, (5, 5), "$MFX")
                .attr(data_extent(0, 7, 65_536, 51_200, run_list(&[(16, 8)])))
                .on_disk()?,
            bad("the record at MftStartLcn is not named $MFT"),
        ),
        (
            "its $DATA resident",
            base.named(0, 1, FILE, (5, 5), "$MFT")
                .attr(resident(DATA, "", 0, &[0; 16]))
                .on_disk()?,
            bad("it holds no unnamed, non-resident $DATA extent at VCN 0"),
        ),
    ];
    for (what, bytes, expected) in cases {
        let mut spec = standard();
        spec.raw.insert(0, bytes);
        assert_eq!(refusal(&spec)?, expected, "record 0 {what}");
    }
    let mut spec = standard();
    spec.initialized = 15;
    assert_eq!(
        refusal(&spec)?,
        bad("its initialized size holds fewer records than NTFS's 16 metafiles")
    );
    Ok(())
}

#[test]
fn upcase_allocated_past_its_size_is_read_only_to_its_size() -> TestResult {
    // 32 clusters of data in a run of 36, then a run of 4 more: 128 KiB
    // read, in one read, and nothing past it.
    let mut spec = standard();
    let over = spec
        .named(10, 10, FILE, (5, 5), "$UpCase")
        .attr(data_extent(
            0,
            39,
            UPCASE_BYTES,
            UPCASE_BYTES,
            run_list(&[(100, 36), (140, 4)]),
        ));
    spec.records.insert(10, Some(over));
    spec.clusters = 144;
    let (out, reads) = read(&spec)?;
    assert_expected_tree(&out);
    assert_eq!(reads.last(), Some(&(100 * 4096, 131_072)));
    assert!(!reads.iter().any(|r| r.0 == 140 * 4096), "{reads:?}");
    Ok(())
}

#[test]
fn upcase_is_record_10_whole_named_and_not_sparse() -> TestResult {
    let bad = |reason: &'static str| MftError::BadUpcase { reason };
    let base = standard();
    let upcase = |extent: Vec<u8>| base.named(10, 10, FILE, (5, 5), "$UpCase").attr(extent);
    let cases: Vec<(&str, Option<FileRecord>, MftError)> = vec![
        ("absent", None, bad("it is not an in-use base record")),
        (
            "named otherwise",
            Some(
                base.named(10, 10, FILE, (5, 5), "$UpCasf")
                    .attr(data_extent(
                        0,
                        31,
                        UPCASE_BYTES,
                        UPCASE_BYTES,
                        run_list(&[(100, 32)]),
                    )),
            ),
            bad("it is not named $UpCase"),
        ),
        (
            "resident",
            Some(upcase(resident(DATA, "", 0, &[0; 64]))),
            bad("it holds no unnamed, non-resident $DATA extent at VCN 0"),
        ),
        (
            "1,000 bytes",
            Some(upcase(data_extent(0, 0, 1000, 1000, run_list(&[(100, 1)])))),
            bad("its data is not 131,072 bytes (65,536 UTF-16 units)"),
        ),
        (
            "half initialized",
            Some(upcase(data_extent(
                0,
                31,
                UPCASE_BYTES,
                UPCASE_BYTES / 2,
                run_list(&[(100, 32)]),
            ))),
            bad("its data is not all initialized"),
        ),
        (
            "split across an extension record",
            Some(upcase(data_extent(
                0,
                7,
                UPCASE_BYTES,
                UPCASE_BYTES,
                run_list(&[(100, 8)]),
            ))),
            bad("its runs map less than its size (an extension record holds the rest)"),
        ),
        (
            "sparse",
            // A one-byte length (32 clusters) and no offset: a sparse run.
            Some(upcase(data_extent(
                0,
                31,
                UPCASE_BYTES,
                UPCASE_BYTES,
                vec![0x01, 0x20, 0x00],
            ))),
            bad("a run of its data is sparse"),
        ),
    ];
    for (what, record, expected) in cases {
        let mut spec = standard();
        spec.records.insert(10, record);
        assert_eq!(refusal(&spec)?, expected, "$UpCase {what}");
    }
    Ok(())
}

#[test]
fn the_root_is_the_record_and_the_sequence_the_handle_named() -> TestResult {
    let spec = standard();
    let with = |reference: u64| -> Result<MftError, String> {
        let mut image = spec.image()?;
        let facts = VolumeFacts {
            root_reference: reference,
            ..spec.facts()?
        };
        match read_mft(&mut image, &facts, false) {
            Ok(out) => Err(format!("read {} nodes", out.len())),
            Err(e) => Ok(e),
        }
    };
    assert_eq!(
        with(reference(2, SCAN))?,
        MftError::RootReplaced {
            record: SCAN,
            sequence: 2,
            found: 1
        }
    );
    assert_eq!(
        with(reference(1, 30))?,
        MftError::RootNotRead { record: 30 }
    );
    assert_eq!(
        with(reference(1, 26))?,
        MftError::RootNotRead { record: 26 }
    );
    assert_eq!(
        with(reference(1, 21))?,
        MftError::Build(BuildError::RootNotDirectory { root: 21 })
    );
    Ok(())
}

#[test]
fn a_short_read_refuses_the_scan() -> TestResult {
    let spec = standard();
    let mut image = spec.image()?;
    image.bytes.truncate(101 * 4096);
    let got = read_mft(&mut image, &spec.facts()?, false);
    assert_eq!(
        got.map(|o| o.len()),
        Err(MftError::ShortRead {
            offset: 100 * 4096,
            wanted: 131_072,
            got: 4096
        })
    );
    Ok(())
}

#[test]
fn the_stats_time_the_reads_as_well_as_the_build() -> TestResult {
    let spec = standard();
    let mut image = spec.image()?;
    image.delay = Duration::from_millis(30);
    let out = read_mft(&mut image, &spec.facts()?, false).map_err(|e| e.to_string())?;
    assert!(
        out.stats.wall_ms >= 120.0,
        "four reads of 30 ms: {}",
        out.stats.wall_ms
    );
    assert_eq!(out.stats.workers_peak, 1);
    assert_eq!(out.stats.climb_steps, 0);
    if thread_cpu_seconds().is_nan() {
        return Ok(());
    }
    let mut image = spec.image()?;
    image.burn = 0.05;
    let out = read_mft(&mut image, &spec.facts()?, false).map_err(|e| e.to_string())?;
    assert!(
        out.stats.cpu_seconds >= 0.05,
        "a read that burnt 50 ms of CPU: {}",
        out.stats.cpu_seconds
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// The geometry and the plan
// ---------------------------------------------------------------------------

/// An `NTFS_VOLUME_DATA_BUFFER` whose other fields hold decoys.
fn volume_data(cluster: u32, record: u32, start_lcn: i64, valid: i64) -> Vec<u8> {
    let mut v = vec![0_u8; VOLUME_DATA_BYTES];
    let _ = put(&mut v, 0, &0x0123_4567_89AB_CDEF_i64.to_le_bytes()); // VolumeSerialNumber
    let _ = put(&mut v, 40, &512_u32.to_le_bytes()); // BytesPerSector
    let _ = put(&mut v, 44, &cluster.to_le_bytes()); // BytesPerCluster
    let _ = put(&mut v, 48, &record.to_le_bytes()); // BytesPerFileRecordSegment
    let _ = put(&mut v, 52, &3_u32.to_le_bytes()); // ClustersPerFileRecordSegment
    let _ = put(&mut v, 56, &valid.to_le_bytes()); // MftValidDataLength
    let _ = put(&mut v, 64, &start_lcn.to_le_bytes()); // MftStartLcn
    let _ = put(&mut v, 72, &999_999_i64.to_le_bytes()); // Mft2StartLcn
    v
}

#[test]
fn the_geometry_is_read_from_its_own_fields() -> TestResult {
    let g = Geometry::from_volume_data(&volume_data(4096, 1024, 786_432, 1 << 30))
        .map_err(|e| e.to_string())?;
    assert_eq!(
        g,
        Geometry {
            bytes_per_cluster: 4096,
            bytes_per_record: 1024,
            mft_start_lcn: 786_432,
            mft_valid_data_length: 1 << 30,
        }
    );
    let mut longer = volume_data(4096, 4096, 3, 4096 * 64);
    longer.extend([0xEE; 32]); // NTFS_EXTENDED_VOLUME_DATA after it
    assert_eq!(
        Geometry::from_volume_data(&longer).map(|g| g.bytes_per_record),
        Ok(4096)
    );
    let short = volume_data(4096, 1024, 3, 4096);
    assert!(matches!(
        Geometry::from_volume_data(short.get(..VOLUME_DATA_BYTES - 1).unwrap_or_default()),
        Err(MftError::BadGeometry { .. })
    ));
    Ok(())
}

#[test]
fn a_geometry_the_reader_cannot_read_with_is_refused() {
    for (cluster, record, lcn, valid, what) in [
        (0, 1024, 0, 0, "a zero cluster"),
        (3000, 1024, 0, 0, "a cluster that is not a power of two"),
        (MAX_CLUSTER_BYTES * 2, 1024, 0, 0, "a cluster over 2 MiB"),
        (4096, 0, 0, 0, "a zero record"),
        (4096, 256, 0, 0, "a record under the 512-byte stride"),
        (4096, 1000, 0, 0, "a record that is not a power of two"),
        (4096, MAX_CHUNK_BYTES * 2, 0, 0, "a record over a chunk"),
        (4096, 1024, -1, 0, "a negative MftStartLcn"),
        (4096, 1024, i64::MAX, 0, "record 0 past 2^64 bytes"),
        (4096, 1024, 0, -1, "a negative MftValidDataLength"),
    ] {
        assert!(
            matches!(
                Geometry::new(cluster, record, lcn, valid),
                Err(MftError::BadGeometry { .. })
            ),
            "{what}"
        );
    }
    for (cluster, record) in [
        (512, 512),
        (512, 1024),
        (4096, 4096),
        (MAX_CLUSTER_BYTES, 1024),
    ] {
        assert!(
            Geometry::new(cluster, record, 1, 1).is_ok(),
            "{cluster}/{record}"
        );
    }
}

fn geometry(cluster: u64, record: u64) -> Result<Geometry, String> {
    Geometry::new(cluster, record, 0, 0).map_err(|e| e.to_string())
}

fn plan(
    runs: &[(Option<u64>, u64)],
    g: &Geometry,
    from: u64,
    to: u64,
) -> Result<Vec<Chunk>, String> {
    let map = MftExtents::new(runs, g.bytes_per_cluster, g.bytes_per_record)
        .map_err(|e| e.to_string())?;
    plan_chunks(&map, g, from, to).map_err(|e| e.to_string())
}

#[test]
fn a_run_is_read_in_whole_clusters_at_most_a_mebibyte_at_a_time() -> TestResult {
    let g = geometry(4096, 1024)?;
    assert_eq!(g.chunk_bytes(), MAX_CHUNK_BYTES);
    // 300 clusters (1,200 records) at LCN 1,000, then 50 at LCN 5,000.
    let runs = [(Some(1000), 300), (Some(5000), 50)];
    assert_eq!(
        plan(&runs, &g, 0, 1400)?,
        vec![
            Chunk {
                offset: 1000 * 4096,
                bytes: MAX_CHUNK_BYTES,
                first_record: 0,
                records: 1024,
                skip: 0
            },
            Chunk {
                offset: 1000 * 4096 + MAX_CHUNK_BYTES,
                bytes: 300 * 4096 - MAX_CHUNK_BYTES,
                first_record: 1024,
                records: 176,
                skip: 0
            },
            Chunk {
                offset: 5000 * 4096,
                bytes: 50 * 4096,
                first_record: 1200,
                records: 200,
                skip: 0
            },
        ]
    );
    Ok(())
}

#[test]
fn a_range_ending_or_starting_inside_a_cluster_reads_that_cluster_whole() -> TestResult {
    let g = geometry(4096, 1024)?;
    let runs = [(Some(1000), 300), (Some(5000), 50)];
    // The initialized size ends after record 1,202: its cluster, no more.
    assert_eq!(
        plan(&runs, &g, 0, 1203)?.last().copied(),
        Some(Chunk {
            offset: 5000 * 4096,
            bytes: 4096,
            first_record: 1200,
            records: 3,
            skip: 0
        })
    );
    // Records 1,201-1,205: two clusters, the first record 1 KiB in.
    assert_eq!(
        plan(&runs, &g, 1201, 1206)?,
        vec![Chunk {
            offset: 5000 * 4096,
            bytes: 8192,
            first_record: 1201,
            records: 5,
            skip: 1024
        }]
    );
    Ok(())
}

#[test]
fn records_larger_than_clusters_and_clusters_larger_than_a_chunk() -> TestResult {
    // 512-byte clusters, 1 KiB records: two clusters a record.
    let g = geometry(512, 1024)?;
    assert_eq!(
        plan(&[(Some(100), 10)], &g, 1, 4)?,
        vec![Chunk {
            offset: 100 * 512 + 1024,
            bytes: 3072,
            first_record: 1,
            records: 3,
            skip: 0
        }]
    );
    // 2 MiB clusters: one cluster a read, larger than the 1 MiB target.
    let g = geometry(MAX_CLUSTER_BYTES, 1024)?;
    assert_eq!(g.chunk_bytes(), MAX_CLUSTER_BYTES);
    assert_eq!(
        plan(&[(Some(3), 2)], &g, 0, 4096)?,
        vec![
            Chunk {
                offset: 3 * MAX_CLUSTER_BYTES,
                bytes: MAX_CLUSTER_BYTES,
                first_record: 0,
                records: 2048,
                skip: 0
            },
            Chunk {
                offset: 4 * MAX_CLUSTER_BYTES,
                bytes: MAX_CLUSTER_BYTES,
                first_record: 2048,
                records: 2048,
                skip: 0
            },
        ]
    );
    Ok(())
}

#[test]
fn every_plan_covers_its_range_exactly_in_order_in_aligned_reads() -> TestResult {
    let layouts: [Layout; 4] = [
        (
            4096,
            1024,
            vec![(Some(1000), 300), (Some(7), 1), (Some(5000), 513)],
        ),
        (512, 1024, vec![(Some(64), 4098), (Some(9000), 6)]),
        (4096, 4096, vec![(Some(3), 257), (Some(700), 1)]),
        (65_536, 1024, vec![(Some(2), 17), (Some(40), 1)]),
    ];
    for (cluster, record, runs) in layouts {
        let g = geometry(cluster, record)?;
        let map = MftExtents::new(&runs, cluster, record).map_err(|e| e.to_string())?;
        let total = map.record_count();
        for (from, to) in [(0, total), (1, total - 1), (3, 5), (total / 2, total + 9)] {
            let chunks = plan_chunks(&map, &g, from, to).map_err(|e| e.to_string())?;
            let mut next = from;
            for c in &chunks {
                assert_eq!(c.first_record, next, "{cluster}/{record} {from}..{to}");
                assert!(c.offset % cluster == 0 && c.bytes % cluster == 0, "{c:?}");
                assert!(c.bytes <= g.chunk_bytes() && c.records > 0, "{c:?}");
                assert!(c.skip + c.records * record <= c.bytes, "{c:?}");
                assert_eq!(
                    map.offset_of(c.first_record),
                    Some(c.offset + c.skip),
                    "{c:?}"
                );
                assert_eq!(
                    map.offset_of(c.first_record + c.records - 1),
                    Some(c.offset + c.skip + (c.records - 1) * record),
                    "one run: {c:?}"
                );
                next = c.first_record + c.records;
            }
            assert_eq!(
                next,
                to.min(total).max(from),
                "{cluster}/{record} {from}..{to}"
            );
        }
    }
    Ok(())
}

#[test]
fn an_empty_range_plans_nothing() -> TestResult {
    let g = geometry(4096, 1024)?;
    let runs = [(Some(1000), 300)];
    assert!(plan(&runs, &g, 5, 5)?.is_empty());
    assert!(plan(&runs, &g, 7, 3)?.is_empty());
    assert!(plan(&runs, &g, 1200, 2000)?.is_empty(), "past the runs");
    Ok(())
}

// ---------------------------------------------------------------------------
// The Win32 boundary: each answer's check
// ---------------------------------------------------------------------------

#[test]
fn a_drive_letter_s_root_opens_as_its_device_and_nothing_else_does() {
    for (volume, device) in [
        ("C:\\", "\\\\.\\C:"),
        ("d:\\", "\\\\.\\D:"),
        ("\\\\?\\E:\\", "\\\\.\\E:"),
    ] {
        assert_eq!(device_path(volume), Ok(device.to_owned()), "{volume}");
    }
    for volume in [
        "C:\\mnt\\data\\",
        "\\\\server\\share\\",
        "\\\\?\\Volume{0b8c3c1e-0000-0000-0000-100000000000}\\",
        "C:",
        "C:\\\\",
        "1:\\",
        "",
    ] {
        assert_eq!(
            device_path(volume),
            Err(MftError::NoDriveLetter {
                volume: volume.to_owned()
            }),
            "{volume}"
        );
    }
}

#[test]
fn network_drives_and_paths_without_a_volume_are_refused_by_type() {
    let v = "Z:\\";
    assert_eq!(
        check_drive_type(DRIVE_REMOTE, v),
        Err(MftError::NetworkVolume {
            volume: v.to_owned()
        })
    );
    for kind in [DRIVE_UNKNOWN, DRIVE_NO_ROOT_DIR] {
        assert_eq!(
            check_drive_type(kind, v),
            Err(MftError::NoVolume {
                volume: v.to_owned()
            })
        );
    }
    // Removable, fixed, optical and RAM disks go on to the NTFS check.
    for kind in [2, 3, 5, 6] {
        assert_eq!(check_drive_type(kind, v), Ok(()), "{kind}");
    }
}

#[test]
fn only_the_exact_file_system_name_ntfs_passes() {
    assert_eq!(check_file_system("NTFS", "C:\\"), Ok(()));
    for name in [
        "ReFS", "FAT32", "exFAT", "FAT", "ntfs", "NTFS ", "", "CSVFS",
    ] {
        assert_eq!(
            check_file_system(name, "C:\\"),
            Err(MftError::NotNtfs {
                volume: "C:\\".to_owned(),
                file_system: name.to_owned()
            }),
            "{name:?}"
        );
    }
}

#[test]
fn a_root_on_another_volume_than_its_path_names_is_refused() {
    assert_eq!(check_same_volume(SERIAL, SERIAL), Ok(()));
    assert_eq!(
        check_same_volume(0x0BAD_F00D, SERIAL),
        Err(MftError::OtherVolume {
            root_serial: 0x0BAD_F00D,
            volume_serial: SERIAL
        })
    );
}

#[test]
fn a_file_reference_is_the_high_index_over_the_low() {
    assert_eq!(
        file_reference(0x0005_0000, 0x0000_0014),
        0x0005_0000_0000_0014
    );
    assert_eq!(file_reference(0, 7), 7);
    assert_eq!(file_reference(1, 0), 1 << 32);
}

#[test]
fn a_filled_buffer_is_read_to_its_first_nul() {
    let units = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
    let mut buf = units("NTFS");
    buf.extend([0, 0x46, 0x41, 0x54]); // a stale "FAT" past the NUL
    assert_eq!(text_until_nul(&buf), "NTFS");
    assert_eq!(text_until_nul(&units("C:\\")), "C:\\", "no NUL: all of it");
    assert_eq!(text_until_nul(&[0, 0x41]), "");
    assert_eq!(text_until_nul(&[0x41, 0xD800, 0]), "A\u{FFFD}");
}

#[test]
fn access_denied_on_the_volume_is_not_elevated_and_other_codes_are_themselves() {
    assert_eq!(
        open_error(5, "C:\\"),
        MftError::NotElevated {
            volume: "C:\\".to_owned()
        }
    );
    assert_eq!(
        open_error(32, "C:\\"),
        MftError::Os {
            call: "CreateFileW on the volume",
            code: 32
        }
    );
}

#[test]
fn a_relative_root_or_one_holding_a_nul_is_refused() {
    let absolute = std::env::temp_dir().join("scan-root");
    assert_eq!(check_root(&absolute), Ok(()));
    assert_eq!(
        check_root(Path::new("relative/scan-root")),
        Err(MftError::BadRoot {
            reason: "is not an absolute path"
        })
    );
    assert_eq!(
        check_root(Path::new("")),
        Err(MftError::BadRoot {
            reason: "is not an absolute path"
        })
    );
    assert_eq!(
        check_root(&absolute.join("a\0b")),
        Err(MftError::BadRoot {
            reason: "holds a NUL character"
        })
    );
}

#[test]
fn the_root_is_named_as_the_listing_walk_names_it() {
    assert_eq!(root_name(Path::new("/tmp/scan-root")), "scan-root");
    assert_eq!(root_name(Path::new("/tmp/scan-root/")), "scan-root");
    assert_eq!(root_name(Path::new("/")), "/", "no last component");
    if cfg!(windows) {
        assert_eq!(root_name(Path::new("C:\\")), "C:\\");
        assert_eq!(root_name(Path::new("C:\\Users\\x y")), "x y");
    }
}

#[test]
fn every_read_lands_in_a_buffer_aligned_for_a_read_past_the_cache() -> TestResult {
    let mut raw = Vec::new();
    // Far above any allocator's own alignment, so a window that is not
    // aligned on purpose shows.
    for align in [512, IO_ALIGN, 1 << 16, 1 << 20] {
        for len in [4096, 3000, 1] {
            let window = aligned_window(&mut raw, len, align).ok_or("no window")?;
            assert_eq!(window.len(), len);
            assert_eq!(window.as_ptr().addr() % align, 0, "{len} at {align}");
        }
    }
    let first = aligned_window(&mut raw, 8192, IO_ALIGN)
        .ok_or("no window")?
        .as_ptr()
        .addr();
    let again = aligned_window(&mut raw, 8192, IO_ALIGN)
        .ok_or("no window")?
        .as_ptr()
        .addr();
    assert_eq!(first, again, "the buffer is reused, not grown");
    assert!(aligned_window(&mut raw, 16, 0).is_none());
    assert!(aligned_window(&mut raw, usize::MAX, IO_ALIGN).is_none());
    Ok(())
}

#[test]
fn every_refusal_reads_as_a_sentence_naming_its_facts() {
    let volume = || "C:\\".to_owned();
    let cases = [
        (MftError::NotElevated { volume: volume() }, "elevated"),
        (
            MftError::NotNtfs {
                volume: volume(),
                file_system: "ReFS".to_owned(),
            },
            "C:\\ is formatted ReFS, not NTFS",
        ),
        (
            MftError::NetworkVolume { volume: volume() },
            "network drive",
        ),
        (
            MftError::BadRecord {
                record: 77,
                error: RecordError::FixupMismatch { sector: 1 },
            },
            "record 77 is in use but could not be read: the record's unit 1",
        ),
        (
            MftError::RootReplaced {
                record: 20,
                sequence: 2,
                found: 1,
            },
            "sequence number 2",
        ),
        (
            MftError::MftIncomplete {
                read: 32,
                wanted: 50,
            },
            "map 32 records, but its initialized size holds 50",
        ),
    ];
    for (error, words) in cases {
        let text = error.to_string();
        assert!(text.contains(words), "{text:?} should say {words:?}");
    }
}

// ---------------------------------------------------------------------------
// The Win32 boundary: the order of the calls, through a script
// ---------------------------------------------------------------------------

/// A scripted Windows: each call's answer, and every call made, in order.
struct Script {
    volume: Result<String, MftError>,
    drive_type: u32,
    information: Result<VolumeInformation, MftError>,
    identity: Result<RootIdentity, MftError>,
    opened: RefCell<Option<Result<OpenedVolume, MftError>>>,
    calls: RefCell<Vec<String>>,
    delay: Duration,
}

impl Script {
    /// A drive letter's local NTFS volume holding the standard volume's root.
    fn ntfs(image: Image, volume_data: Vec<u8>) -> Self {
        Self {
            volume: Ok("C:\\".to_owned()),
            drive_type: 3,
            information: Ok(VolumeInformation {
                file_system: "NTFS".to_owned(),
                serial: SERIAL,
            }),
            identity: Ok(RootIdentity {
                volume_serial: SERIAL,
                file_reference: SCAN_REFERENCE,
            }),
            opened: RefCell::new(Some(Ok(OpenedVolume {
                reader: Box::new(image),
                volume_data,
            }))),
            calls: RefCell::new(Vec::new()),
            delay: Duration::ZERO,
        }
    }

    fn calls(&self) -> Vec<String> {
        self.calls.borrow().clone()
    }

    fn call(&self, what: String) {
        self.calls.borrow_mut().push(what);
    }
}

impl VolumeApi for Script {
    fn volume_path_name(&self, root: &Path) -> Result<String, MftError> {
        self.call(format!("GetVolumePathNameW {}", root.display()));
        std::thread::sleep(self.delay);
        self.volume.clone()
    }

    fn drive_type(&self, volume: &str) -> u32 {
        self.call(format!("GetDriveTypeW {volume}"));
        self.drive_type
    }

    fn volume_information(&self, volume: &str) -> Result<VolumeInformation, MftError> {
        self.call(format!("GetVolumeInformationW {volume}"));
        self.information.clone()
    }

    fn root_identity(&self, root: &Path) -> Result<RootIdentity, MftError> {
        self.call(format!("GetFileInformationByHandle {}", root.display()));
        self.identity.clone()
    }

    fn open_volume(&self, device: &str, volume: &str) -> Result<OpenedVolume, MftError> {
        self.call(format!("open {device} for {volume}"));
        self.opened.borrow_mut().take().unwrap_or(Err(MftError::Io {
            call: "the script",
            message: "opened twice".to_owned(),
        }))
    }
}

fn scan_root() -> PathBuf {
    std::env::temp_dir().join(ROOT_NAME)
}

/// The standard volume behind a scripted Windows, and the image's reads.
fn scripted() -> Result<(Script, Reads), String> {
    let image = standard().image()?;
    let reads = Rc::clone(&image.reads);
    Ok((
        Script::ntfs(image, volume_data(4096, 1024, 16, 64 * 1024)),
        reads,
    ))
}

fn every_call(root: &Path) -> Vec<String> {
    vec![
        format!("GetVolumePathNameW {}", root.display()),
        "GetDriveTypeW C:\\".to_owned(),
        "GetVolumeInformationW C:\\".to_owned(),
        format!("GetFileInformationByHandle {}", root.display()),
        "open \\\\.\\C: for C:\\".to_owned(),
    ]
}

#[test]
fn the_whole_read_makes_every_call_in_order_and_names_the_root_after_its_path() -> TestResult {
    let (script, reads) = scripted()?;
    let root = scan_root();
    let out = read_volume_with(&script, &root, false).map_err(|e| e.to_string())?;
    assert_expected_tree(&out);
    assert_eq!(script.calls(), every_call(&root));
    assert_eq!(reads.borrow().len(), 4);
    Ok(())
}

#[test]
fn a_root_that_cannot_be_placed_is_refused_before_any_call() -> TestResult {
    for root in [
        PathBuf::from("relative/scan-root"),
        scan_root().join("a\0b"),
    ] {
        let (script, _) = scripted()?;
        let got = read_volume_with(&script, &root, false).map(|o| o.len());
        assert!(matches!(got, Err(MftError::BadRoot { .. })), "{got:?}");
        assert!(script.calls().is_empty(), "{:?}", script.calls());
    }
    Ok(())
}

#[test]
fn each_refusal_comes_before_the_volume_is_opened() -> TestResult {
    type Setup = fn(&mut Script);
    let root = scan_root();
    let cases: [(Setup, usize, MftError); 6] = [
        (
            |s| s.volume = Ok("C:\\mnt\\data\\".to_owned()),
            1,
            MftError::NoDriveLetter {
                volume: "C:\\mnt\\data\\".to_owned(),
            },
        ),
        (
            |s| {
                s.volume = Err(MftError::Os {
                    call: "GetVolumePathNameW",
                    code: 3,
                });
            },
            1,
            MftError::Os {
                call: "GetVolumePathNameW",
                code: 3,
            },
        ),
        (
            |s| s.drive_type = DRIVE_REMOTE,
            2,
            MftError::NetworkVolume {
                volume: "C:\\".to_owned(),
            },
        ),
        (
            |s| {
                s.information = Ok(VolumeInformation {
                    file_system: "ReFS".to_owned(),
                    serial: SERIAL,
                });
            },
            3,
            MftError::NotNtfs {
                volume: "C:\\".to_owned(),
                file_system: "ReFS".to_owned(),
            },
        ),
        (
            |s| {
                s.identity = Ok(RootIdentity {
                    volume_serial: 0x0BAD_F00D,
                    file_reference: SCAN_REFERENCE,
                });
            },
            4,
            MftError::OtherVolume {
                root_serial: 0x0BAD_F00D,
                volume_serial: SERIAL,
            },
        ),
        (
            |s| {
                *s.opened.borrow_mut() = Some(Err(open_error(5, "C:\\")));
            },
            5,
            MftError::NotElevated {
                volume: "C:\\".to_owned(),
            },
        ),
    ];
    for (setup, calls, expected) in cases {
        let (mut script, reads) = scripted()?;
        setup(&mut script);
        let got = read_volume_with(&script, &root, false).map(|o| o.len());
        assert_eq!(got, Err(expected.clone()));
        let made = script.calls();
        assert_eq!(
            made.as_slice(),
            every_call(&root).get(..calls).unwrap_or_default(),
            "{expected:?}"
        );
        assert!(reads.borrow().is_empty(), "nothing read: {expected:?}");
    }
    Ok(())
}

#[test]
fn nothing_is_read_before_the_volume_data_is_checked() -> TestResult {
    let (script, reads) = scripted()?;
    if let Some(Ok(opened)) = script.opened.borrow_mut().as_mut() {
        opened.volume_data.truncate(VOLUME_DATA_BYTES - 1);
    }
    let got = read_volume_with(&script, &scan_root(), false).map(|o| o.len());
    assert!(matches!(got, Err(MftError::BadGeometry { .. })), "{got:?}");
    assert!(reads.borrow().is_empty());
    Ok(())
}

#[test]
fn the_stats_time_the_calls_before_the_read_too() -> TestResult {
    let (mut script, _) = scripted()?;
    script.delay = Duration::from_millis(40);
    let out = read_volume_with(&script, &scan_root(), false).map_err(|e| e.to_string())?;
    assert!(out.stats.wall_ms >= 40.0, "{}", out.stats.wall_ms);
    Ok(())
}

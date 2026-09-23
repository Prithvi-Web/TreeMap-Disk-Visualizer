//! The master file table read off a volume (M4 of
//! `docs/superpowers/plans/2026-09-23-phase3-w6-mft.md`): from a volume's
//! bytes to the scan root's subtree, in a few large sequential reads.
//!
//! Everything here is portable and tested on every platform against
//! synthetic volume images; the Windows calls that produce a [`Volume`] and
//! the [`VolumeFacts`] are in [`crate::win32`].
//!
//! * [`read_mft`] reads `$MFT`'s own record (0) at `MftStartLcn`, fixed up at
//!   the 512-byte stride whatever the device's sector size (correction 1),
//!   then every record in the order the volume holds them, in whole-cluster
//!   reads of at most 1 MiB ([`plan_chunks`]), up to `$MFT`'s initialized size
//!   and never past it (correction 3) — the smaller of the size record 0
//!   states and the one `FSCTL_GET_NTFS_VOLUME_DATA` reports.
//! * A fragmented `$MFT` keeps its later extents in its own extension records
//!   (base 0 with `$MFT`'s sequence number), found only by reading the first
//!   extents (correction 2). The reader collects them as it meets them and,
//!   once the extents it knows are read, reads on into the ones they named,
//!   concatenated in VCN order: every record is read exactly once.
//! * `$UpCase` (record 10) is read from its own runs; the root's record is
//!   matched by number and sequence; the tree is [`build_tree`]'s, renamed
//!   after the path ([`with_root_name`]), timed from the first read on
//!   (correction 8).
//! * A record with no `FILE` signature (never used, or marked `BAAD`) or not
//!   in use is skipped: nothing in it is a fact. An in-use record that does
//!   not parse refuses the whole read, after one second read when it was
//!   torn — a write in flight when its chunk was read has landed by then.
//!   Skipping it instead would drop its entries without a trace: the result
//!   would differ from the listing walk's, and the run-time cross-check
//!   (W6-8) could not see it, because it only samples entries the result
//!   holds. A refusal falls back to the listing walk with this reason.

use std::time::Instant;

use tm_walk::WalkOutput;
use tm_walk::platform::thread_cpu_seconds;

pub use crate::error::MftError;
use crate::record::{
    DataExtent, REFERENCE_NUMBER_MASK, Record, RecordError, UPDATE_SEQUENCE_STRIDE, data_extents,
    header_in_use, parse_record, read_i64, read_u32, sequence_of,
};
use crate::runs::{MftExtents, decode_runs};
use crate::tree::{FIRST_USER_RECORD, RecordTable, UPCASE_UNITS, build_tree, with_root_name};

/// The most one read asks the volume for, unless one cluster is larger.
pub const MAX_CHUNK_BYTES: u64 = 1024 * 1024;
/// NTFS's largest cluster (2 MiB since Windows 10 1709).
pub const MAX_CLUSTER_BYTES: u64 = 2 * 1024 * 1024;
/// The fix-up stride as a byte count: the smallest record NTFS can protect.
const STRIDE_BYTES: u64 = UPDATE_SEQUENCE_STRIDE as u64;
/// `$MFT`'s own record.
pub const MFT_RECORD: u64 = 0;
/// `$UpCase`'s record.
pub const UPCASE_RECORD: u64 = 10;
/// `$UpCase`'s data: one little-endian UTF-16 unit for each of the 65,536.
pub const UPCASE_BYTES: u64 = 2 * UPCASE_UNITS as u64;

/// Bytes of `NTFS_VOLUME_DATA_BUFFER`, what `FSCTL_GET_NTFS_VOLUME_DATA`
/// returns ahead of any extended data.
pub const VOLUME_DATA_BYTES: usize = 96;
/// `BytesPerCluster`'s offset in `NTFS_VOLUME_DATA_BUFFER`.
pub(crate) const VD_BYTES_PER_CLUSTER: usize = 44;
/// `BytesPerFileRecordSegment`'s offset.
pub(crate) const VD_BYTES_PER_RECORD: usize = 48;
/// `MftValidDataLength`'s offset.
pub(crate) const VD_MFT_VALID_DATA_LENGTH: usize = 56;
/// `MftStartLcn`'s offset.
pub(crate) const VD_MFT_START_LCN: usize = 64;

/// The volume facts `FSCTL_GET_NTFS_VOLUME_DATA` gives the reader, checked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Geometry {
    /// `BytesPerCluster`: a power of two, at most [`MAX_CLUSTER_BYTES`].
    pub bytes_per_cluster: u64,
    /// `BytesPerFileRecordSegment`: a power of two from the 512-byte fix-up
    /// stride to [`MAX_CHUNK_BYTES`].
    pub bytes_per_record: u64,
    /// `MftStartLcn`: the cluster record 0 starts at.
    pub mft_start_lcn: u64,
    /// `MftValidDataLength`: `$MFT`'s initialized size as the file system
    /// holds it in memory.
    pub mft_valid_data_length: u64,
}

impl Geometry {
    /// Checks the four facts the reader uses. Both sizes must be powers of
    /// two — which NTFS's boot sector guarantees, and which makes every read
    /// that holds whole clusters also hold whole records — and the cluster
    /// no larger than NTFS allows; nothing may be negative or place record 0
    /// past 2^64 bytes.
    pub fn new(
        bytes_per_cluster: u64,
        bytes_per_record: u64,
        mft_start_lcn: i64,
        mft_valid_data_length: i64,
    ) -> Result<Self, MftError> {
        let bad = |reason| MftError::BadGeometry { reason };
        if !bytes_per_cluster.is_power_of_two() || bytes_per_cluster > MAX_CLUSTER_BYTES {
            return Err(bad(
                "a cluster size that is not a power of two of at most 2 MiB",
            ));
        }
        if !bytes_per_record.is_power_of_two()
            || !(STRIDE_BYTES..=MAX_CHUNK_BYTES).contains(&bytes_per_record)
        {
            return Err(bad(
                "a file record size that is not a power of two from 512 bytes to 1 MiB",
            ));
        }
        let mft_start_lcn =
            u64::try_from(mft_start_lcn).map_err(|_| bad("a negative MftStartLcn"))?;
        if mft_start_lcn.checked_mul(bytes_per_cluster).is_none() {
            return Err(bad("an MftStartLcn past 2^64 bytes"));
        }
        let mft_valid_data_length = u64::try_from(mft_valid_data_length)
            .map_err(|_| bad("a negative MftValidDataLength"))?;
        Ok(Self {
            bytes_per_cluster,
            bytes_per_record,
            mft_start_lcn,
            mft_valid_data_length,
        })
    }

    /// Reads the geometry out of the `NTFS_VOLUME_DATA_BUFFER` at the start
    /// of `buf`, the bytes `FSCTL_GET_NTFS_VOLUME_DATA` returned.
    pub fn from_volume_data(buf: &[u8]) -> Result<Self, MftError> {
        let short = || MftError::BadGeometry {
            reason: "fewer bytes than an NTFS_VOLUME_DATA_BUFFER holds",
        };
        if buf.len() < VOLUME_DATA_BYTES {
            return Err(short());
        }
        Self::new(
            u64::from(read_u32(buf, VD_BYTES_PER_CLUSTER).ok_or_else(short)?),
            u64::from(read_u32(buf, VD_BYTES_PER_RECORD).ok_or_else(short)?),
            read_i64(buf, VD_MFT_START_LCN).ok_or_else(short)?,
            read_i64(buf, VD_MFT_VALID_DATA_LENGTH).ok_or_else(short)?,
        )
    }

    /// The smallest read holding whole clusters and whole records: the
    /// larger of the two, both being powers of two.
    fn unit(&self) -> u64 {
        self.bytes_per_cluster.max(self.bytes_per_record)
    }

    /// The most one read asks for: [`MAX_CHUNK_BYTES`], or one cluster
    /// where a cluster is larger. A multiple of both sizes.
    pub fn chunk_bytes(&self) -> u64 {
        MAX_CHUNK_BYTES.max(self.unit())
    }

    fn record_len(&self) -> Result<usize, MftError> {
        usize::try_from(self.bytes_per_record).map_err(|_| MftError::Overflow)
    }
}

/// One read of the sequential pass: `bytes` bytes from byte `offset` of the
/// volume — whole clusters from a cluster boundary — holding records
/// `first_record..first_record + records`, the first of them `skip` bytes in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chunk {
    /// Where the read starts on the volume: a cluster boundary.
    pub offset: u64,
    /// How many bytes it reads: whole clusters.
    pub bytes: u64,
    /// The first record wanted from it.
    pub first_record: u64,
    /// How many records are wanted from it.
    pub records: u64,
    /// Where the first wanted record starts inside it.
    pub skip: u64,
}

/// Plans the reads of records `from..to` through `map`, in record order:
/// each run's records in reads of at most [`Geometry::chunk_bytes`], every
/// read whole clusters from a cluster boundary (all a volume read without
/// the cache takes), never across two runs and never splitting a record. A
/// range that starts or ends inside a cluster reads that whole cluster and
/// skips the records outside the range: `to` is where `$MFT`'s initialized
/// size ends, and nothing past its cluster is read.
pub fn plan_chunks(
    map: &MftExtents,
    geometry: &Geometry,
    from: u64,
    to: u64,
) -> Result<Vec<Chunk>, MftError> {
    let record = geometry.bytes_per_record;
    let cluster = geometry.bytes_per_cluster;
    let most = geometry.chunk_bytes();
    let mut out = Vec::new();
    for extent in map.extents() {
        let extent_end = extent
            .first_record
            .checked_add(extent.records)
            .ok_or(MftError::Overflow)?;
        let start = from.max(extent.first_record);
        let end = to.min(extent_end);
        if start >= end {
            continue;
        }
        let byte_of = |n: u64| {
            (n - extent.first_record)
                .checked_mul(record)
                .and_then(|b| extent.byte_offset.checked_add(b))
                .ok_or(MftError::Overflow)
        };
        let first_byte = byte_of(start)?;
        let end_byte = byte_of(end)?;
        // A run starts on a cluster boundary and holds whole clusters, so
        // the clusters around the range are the run's own.
        let read_start = first_byte - first_byte % cluster;
        let read_end = end_byte
            .checked_next_multiple_of(cluster)
            .ok_or(MftError::Overflow)?;
        let mut pos = read_start;
        while pos < read_end {
            let piece_end = pos
                .checked_add(most)
                .ok_or(MftError::Overflow)?
                .min(read_end);
            let lo = pos.max(first_byte);
            let hi = piece_end.min(end_byte);
            if lo < hi {
                out.push(Chunk {
                    offset: pos,
                    bytes: piece_end - pos,
                    first_record: extent.first_record + (lo - extent.byte_offset) / record,
                    records: (hi - lo) / record,
                    skip: lo - pos,
                });
            }
            pos = piece_end;
        }
    }
    Ok(out)
}

/// Where the reader reads from: a volume, by byte offset.
pub trait Volume {
    /// Fills all of `buf` from the volume's byte `offset`. The reader asks
    /// only for whole clusters from cluster boundaries, at most
    /// [`Geometry::chunk_bytes`] at a time.
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<(), MftError>;
}

/// What the reader needs to know besides the volume's bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VolumeFacts {
    /// The volume's checked geometry.
    pub geometry: Geometry,
    /// The volume serial number: every hard-link key's `dev`, as the listing
    /// reports it.
    pub serial: u32,
    /// The root's file reference: its sequence number over its record number.
    pub root_reference: u64,
    /// The root's name as the listing walk records it
    /// ([`crate::win32::root_name`]).
    pub root_name: String,
}

/// The subtree of the root `facts` names, read off `volume`: see the module
/// docs. `WalkStats::wall_ms` and `cpu_seconds` cover the reads and the build.
pub fn read_mft(
    volume: &mut dyn Volume,
    facts: &VolumeFacts,
    want_atime: bool,
) -> Result<WalkOutput, MftError> {
    read_mft_timed(
        volume,
        facts,
        want_atime,
        Instant::now(),
        thread_cpu_seconds(),
    )
}

/// [`read_mft`], with the stats timed from `started` and `cpu_started`: the
/// Windows reader starts the clock before its first call.
pub(crate) fn read_mft_timed(
    volume: &mut dyn Volume,
    facts: &VolumeFacts,
    want_atime: bool,
    started: Instant,
    cpu_started: f64,
) -> Result<WalkOutput, MftError> {
    let geometry = &facts.geometry;
    let start = bootstrap(volume, geometry)?;
    let mut extents = start.extents;
    let mut pass = Pass {
        table: RecordTable::new(facts.serial),
        found: Vec::new(),
        upcase: None,
    };
    let mut done = 0_u64;
    loop {
        let (runs, _) = stream_runs(&extents, MFT_STREAM)?;
        let map = MftExtents::new(&runs, geometry.bytes_per_cluster, geometry.bytes_per_record)
            .map_err(MftError::Extents)?;
        let reachable = map.record_count().min(start.wanted);
        if reachable <= done {
            break;
        }
        read_records(
            volume,
            geometry,
            &map,
            (done, reachable),
            start.sequence,
            &mut pass,
        )?;
        extents.append(&mut pass.found);
        done = reachable;
    }
    if done < start.wanted {
        return Err(MftError::MftIncomplete {
            read: done,
            wanted: start.wanted,
        });
    }
    let upcase = read_upcase(volume, geometry, &pass.table, pass.upcase.as_deref())?;
    let root = root_record(&pass.table, facts.root_reference)?;
    let out = build_tree(&pass.table, root, &upcase, want_atime).map_err(MftError::Build)?;
    let mut out = with_root_name(out, &facts.root_name).map_err(MftError::Build)?;
    // `build_tree` timed itself alone; the scan is the reads too (correction 8).
    out.stats.wall_ms = started.elapsed().as_secs_f64() * 1e3;
    out.stats.cpu_seconds = thread_cpu_seconds() - cpu_started;
    Ok(out)
}

/// A stream's runs, `(lcn, clusters)` in VCN order (a sparse run's LCN is `None`).
type Runs = Vec<(Option<u64>, u64)>;

/// The stream name the refusals give `$MFT`'s runs.
const MFT_STREAM: &str = "$MFT";
/// The stream name the refusals give `$UpCase`'s runs.
const UPCASE_STREAM: &str = "$UpCase";

/// Where the sequential pass starts: `$MFT`'s sequence number, the extents
/// its own record holds, and how many records its initialized size holds.
struct Start {
    sequence: u16,
    extents: Vec<DataExtent>,
    wanted: u64,
}

/// What the sequential pass collects besides the records.
struct Pass {
    table: RecordTable,
    /// `$MFT`'s extents met in its extension records during this pass.
    found: Vec<DataExtent>,
    /// `$UpCase`'s extents, from its own record.
    upcase: Option<Vec<DataExtent>>,
}

/// Whether one of `record`'s `$FILE_NAME`s is `name`.
fn has_name(record: &Record, name: &str) -> bool {
    record
        .names
        .iter()
        .any(|n| n.name.iter().copied().eq(name.encode_utf16()))
}

/// Reads record 0 at `MftStartLcn` and checks it is `$MFT` itself: in use,
/// numbered 0, a base record, named `$MFT`, a sequence number other than 0
/// (which would make every base record read as one of its extensions), and
/// holding its `$DATA`'s first extent, whose sizes are the stream's.
fn bootstrap(volume: &mut dyn Volume, geometry: &Geometry) -> Result<Start, MftError> {
    let bad = |reason| MftError::BadMftRecord { reason };
    let offset = geometry
        .mft_start_lcn
        .checked_mul(geometry.bytes_per_cluster)
        .ok_or(MftError::Overflow)?;
    let mut slot = vec![0_u8; geometry.record_len()?];
    read_record_into(volume, geometry, offset, &mut slot)?;
    let record = parse_slot(volume, geometry, &mut slot, MFT_RECORD, offset)?
        .filter(|r| r.in_use)
        .ok_or(bad("no in-use FILE record is at MftStartLcn"))?;
    if record.number != MFT_RECORD || record.is_extension() {
        return Err(bad("the record at MftStartLcn is not record 0"));
    }
    if !has_name(&record, MFT_STREAM) {
        return Err(bad("the record at MftStartLcn is not named $MFT"));
    }
    if record.sequence == 0 {
        return Err(bad(
            "record 0 has sequence number 0, which would make every base record read as one of its extensions",
        ));
    }
    let extents = data_extents(&slot).map_err(|error| MftError::BadRecord {
        record: MFT_RECORD,
        error,
    })?;
    let first = extents.iter().find(|e| e.lowest_vcn == 0).ok_or(bad(
        "it holds no unnamed, non-resident $DATA extent at VCN 0",
    ))?;
    // Past the initialized size the clusters hold whatever the disk held
    // before, which can look like in-use records (correction 3).
    let initialized = first
        .initialized_size
        .min(first.data_size)
        .min(geometry.mft_valid_data_length);
    let wanted = initialized / geometry.bytes_per_record;
    if wanted < FIRST_USER_RECORD {
        return Err(bad(
            "its initialized size holds fewer records than NTFS's 16 metafiles",
        ));
    }
    Ok(Start {
        sequence: record.sequence,
        extents,
        wanted,
    })
}

/// The runs of `extents` — one stream's, in any order — that follow on from
/// VCN 0 without a gap, in VCN order, and how many clusters they map. An
/// extent past a gap waits: its predecessor may be in a record not read yet.
/// Two extents mapping one VCN are refused.
fn stream_runs(extents: &[DataExtent], stream: &'static str) -> Result<(Runs, u64), MftError> {
    let mut sorted: Vec<&DataExtent> = extents.iter().collect();
    sorted.sort_by_key(|e| e.lowest_vcn);
    let mut runs = Vec::new();
    let mut next_vcn = 0_u64;
    for extent in sorted {
        if extent.lowest_vcn > next_vcn {
            break;
        }
        if extent.lowest_vcn < next_vcn {
            return Err(MftError::OverlappingExtents {
                stream,
                vcn: extent.lowest_vcn,
            });
        }
        for (lcn, clusters) in
            decode_runs(&extent.runs).map_err(|error| MftError::BadRuns { stream, error })?
        {
            next_vcn = next_vcn.checked_add(clusters).ok_or(MftError::Overflow)?;
            runs.push((lcn, clusters));
        }
    }
    Ok((runs, next_vcn))
}

/// Reads the record at byte `offset` into `slot`, as the whole clusters
/// around it: a volume read that bypasses the cache takes nothing smaller.
fn read_record_into(
    volume: &mut dyn Volume,
    geometry: &Geometry,
    offset: u64,
    slot: &mut [u8],
) -> Result<(), MftError> {
    let cluster = geometry.bytes_per_cluster;
    let start = offset - offset % cluster;
    let within = offset - start;
    let end = within
        .checked_add(geometry.bytes_per_record)
        .ok_or(MftError::Overflow)?;
    let length = end
        .checked_next_multiple_of(cluster)
        .ok_or(MftError::Overflow)?;
    let mut buf = vec![0_u8; usize::try_from(length).map_err(|_| MftError::Overflow)?];
    volume.read_at(start, &mut buf)?;
    let range = usize::try_from(within).map_err(|_| MftError::Overflow)?
        ..usize::try_from(end).map_err(|_| MftError::Overflow)?;
    let record = buf.get(range).ok_or(MftError::Overflow)?;
    if record.len() != slot.len() {
        return Err(MftError::Overflow);
    }
    slot.copy_from_slice(record);
    Ok(())
}

/// What one parse of a slot came to.
enum Parsed {
    /// A record, or `None` for bytes that are not one (no `FILE` signature,
    /// or not in use).
    Done(Option<Record>),
    /// An in-use record with a unit that does not hold its update sequence
    /// number.
    Torn(RecordError),
}

fn classify(
    parsed: Result<Record, RecordError>,
    slot: &[u8],
    number: u64,
) -> Result<Parsed, MftError> {
    match parsed {
        Ok(record) => Ok(Parsed::Done(Some(record))),
        // Never written, or marked BAAD by chkdsk: not a record.
        Err(RecordError::BadSignature) => Ok(Parsed::Done(None)),
        // Nothing in a record that is not in use is a fact.
        Err(_) if !header_in_use(slot) => Ok(Parsed::Done(None)),
        Err(error @ RecordError::FixupMismatch { .. }) => Ok(Parsed::Torn(error)),
        Err(error) => Err(MftError::BadRecord {
            record: number,
            error,
        }),
    }
}

/// Parses record `number`, read from byte `offset` into `slot`: see
/// [`Parsed`]. A torn in-use record is read once more — a write in flight
/// when its chunk was read has landed by then — and refused if still torn.
fn parse_slot(
    volume: &mut dyn Volume,
    geometry: &Geometry,
    slot: &mut [u8],
    number: u64,
    offset: u64,
) -> Result<Option<Record>, MftError> {
    let parsed = parse_record(slot, UPDATE_SEQUENCE_STRIDE);
    if let Parsed::Done(record) = classify(parsed, slot, number)? {
        return Ok(record);
    }
    read_record_into(volume, geometry, offset, slot)?;
    let parsed = parse_record(slot, UPDATE_SEQUENCE_STRIDE);
    match classify(parsed, slot, number)? {
        Parsed::Done(record) => Ok(record),
        Parsed::Torn(error) => Err(MftError::BadRecord {
            record: number,
            error,
        }),
    }
}

/// Reads records `range.0..range.1` through `map` chunk by chunk into
/// `pass`: every in-use record into the table, `$MFT`'s extension records'
/// extents into `pass.found`, `$UpCase`'s into `pass.upcase`.
fn read_records(
    volume: &mut dyn Volume,
    geometry: &Geometry,
    map: &MftExtents,
    range: (u64, u64),
    mft_sequence: u16,
    pass: &mut Pass,
) -> Result<(), MftError> {
    let record_len = geometry.record_len()?;
    let mut buf = Vec::new();
    for chunk in plan_chunks(map, geometry, range.0, range.1)? {
        buf.resize(
            usize::try_from(chunk.bytes).map_err(|_| MftError::Overflow)?,
            0,
        );
        volume.read_at(chunk.offset, &mut buf)?;
        for k in 0..chunk.records {
            let number = chunk.first_record + k;
            // Where the record is comes from the map alone, and where it
            // lands in the read from that: the plan and the map must agree.
            let offset = map.offset_of(number).ok_or(MftError::Overflow)?;
            let at = offset
                .checked_sub(chunk.offset)
                .and_then(|a| usize::try_from(a).ok())
                .ok_or(MftError::Overflow)?;
            let slot = at
                .checked_add(record_len)
                .and_then(|end| buf.get_mut(at..end))
                .ok_or(MftError::Overflow)?;
            if let Some(record) = parse_slot(volume, geometry, slot, number, offset)? {
                take_record(record, slot, number, mft_sequence, pass)?;
            }
        }
    }
    Ok(())
}

/// Files one parsed record: a record not in use is dropped; an in-use one
/// must be the record its position says (a header naming another number is
/// not a record NTFS would read there), and `slot` — fixed up — gives the
/// extents of `$MFT`'s extension records (base 0 with `$MFT`'s sequence
/// number: one of an older `$MFT` is not followed) and of `$UpCase`.
fn take_record(
    record: Record,
    slot: &[u8],
    number: u64,
    mft_sequence: u16,
    pass: &mut Pass,
) -> Result<(), MftError> {
    if !record.in_use {
        return Ok(());
    }
    if record.number != number {
        return Err(MftError::MisplacedRecord {
            position: number,
            number: record.number,
        });
    }
    let extents = || {
        data_extents(slot).map_err(|error| MftError::BadRecord {
            record: number,
            error,
        })
    };
    if record.is_extension() {
        if record.base == MFT_RECORD && record.base_seq == mft_sequence {
            pass.found.extend(extents()?);
        }
    } else if number == UPCASE_RECORD {
        pass.upcase = Some(extents()?);
    }
    pass.table.insert(record);
    Ok(())
}

/// `$UpCase`'s 65,536 units, read from its own runs: record 10 must be the
/// in-use base record named `$UpCase` whose unnamed, non-resident `$DATA`
/// is exactly 131,072 bytes, all initialized, mapped by its own runs (none
/// sparse) — never through an extension record, which it never needs.
fn read_upcase(
    volume: &mut dyn Volume,
    geometry: &Geometry,
    table: &RecordTable,
    extents: Option<&[DataExtent]>,
) -> Result<Vec<u16>, MftError> {
    let bad = |reason| MftError::BadUpcase { reason };
    let record = table
        .get(UPCASE_RECORD)
        .ok_or(bad("it is not an in-use base record"))?;
    if !has_name(record, UPCASE_STREAM) {
        return Err(bad("it is not named $UpCase"));
    }
    let extents = extents.unwrap_or_default();
    let first = extents.iter().find(|e| e.lowest_vcn == 0).ok_or(bad(
        "it holds no unnamed, non-resident $DATA extent at VCN 0",
    ))?;
    if first.data_size != UPCASE_BYTES {
        return Err(bad("its data is not 131,072 bytes (65,536 UTF-16 units)"));
    }
    if first.initialized_size < first.data_size {
        return Err(bad("its data is not all initialized"));
    }
    let (runs, clusters) = stream_runs(extents, UPCASE_STREAM)?;
    let mapped = clusters
        .checked_mul(geometry.bytes_per_cluster)
        .ok_or(MftError::Overflow)?;
    if mapped < UPCASE_BYTES {
        return Err(bad(
            "its runs map less than its size (an extension record holds the rest)",
        ));
    }
    let runs = runs
        .into_iter()
        .map(|(lcn, clusters)| lcn.map(|lcn| (lcn, clusters)))
        .collect::<Option<Vec<(u64, u64)>>>()
        .ok_or(bad("a run of its data is sparse"))?;
    let bytes = read_runs(volume, geometry, &runs, UPCASE_BYTES)?;
    Ok(bytes
        .chunks_exact(2)
        .map(|pair| <[u8; 2]>::try_from(pair).map_or(0, u16::from_le_bytes))
        .collect())
}

/// The first `size` bytes of the stream `runs` map, one whole-cluster read
/// per run. Its only stream is `$UpCase`, whose 128 KiB rounded up to a
/// cluster never exceeds one chunk ([`Geometry::chunk_bytes`] is at least
/// 1 MiB and at least a cluster), so no run needs a second read; a run past
/// the size (an over-allocated stream) is not read.
fn read_runs(
    volume: &mut dyn Volume,
    geometry: &Geometry,
    runs: &[(u64, u64)],
    size: u64,
) -> Result<Vec<u8>, MftError> {
    let cluster = geometry.bytes_per_cluster;
    let mut remaining = size
        .checked_next_multiple_of(cluster)
        .ok_or(MftError::Overflow)?;
    let mut out = Vec::with_capacity(usize::try_from(remaining).map_err(|_| MftError::Overflow)?);
    let mut buf = Vec::new();
    for &(lcn, clusters) in runs {
        let bytes = clusters
            .checked_mul(cluster)
            .ok_or(MftError::Overflow)?
            .min(remaining);
        if bytes == 0 {
            break;
        }
        buf.resize(usize::try_from(bytes).map_err(|_| MftError::Overflow)?, 0);
        volume.read_at(
            lcn.checked_mul(cluster).ok_or(MftError::Overflow)?,
            &mut buf,
        )?;
        out.extend_from_slice(&buf);
        remaining -= bytes;
    }
    out.truncate(usize::try_from(size).map_err(|_| MftError::Overflow)?);
    Ok(out)
}

/// The root's record number, once the table holds it with the sequence
/// number of the root that was opened: a record the disk holds for another
/// file (the root replaced, or a table written before the root was made)
/// is refused rather than walked.
fn root_record(table: &RecordTable, reference: u64) -> Result<u64, MftError> {
    let record = reference & REFERENCE_NUMBER_MASK;
    let sequence = sequence_of(reference);
    let found = table.get(record).ok_or(MftError::RootNotRead { record })?;
    if found.sequence != sequence {
        return Err(MftError::RootReplaced {
            record,
            sequence,
            found: found.sequence,
        });
    }
    Ok(record)
}

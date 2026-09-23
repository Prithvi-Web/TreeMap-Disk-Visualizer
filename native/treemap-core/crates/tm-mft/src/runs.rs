//! Run lists (NTFS "mapping pairs") and the map from `$MFT` record numbers to
//! byte offsets on the volume.
//!
//! A non-resident attribute says where its clusters are as a list of runs,
//! each a header byte and two little-endian fields: the low nibble is the
//! length field's width, the high nibble the offset field's. The length is a
//! cluster count; the offset is signed and relative to the previous run's
//! starting cluster (LCN), so a file fragmented backwards has negative
//! offsets; an offset field of width 0 is a sparse run (no clusters, reads as
//! zeros) and leaves the base where it was; a 0x00 header ends the list.
//!
//! `$MFT` is itself a file, and its unnamed `$DATA` run list is how the
//! volume reader finds every other record: [`MftExtents`] turns the decoded
//! runs, the cluster size and the record size into the byte offset of any
//! record number, refusing what `$MFT` can never be (sparse, or a record
//! split across two runs) rather than reading the wrong bytes.

use crate::record::RecordError;

/// The low nibble of a run's header: its length field's width in bytes.
const LENGTH_WIDTH_MASK: u8 = 0x0F;
/// The high nibble's shift: its offset field's width in bytes.
const OFFSET_WIDTH_SHIFT: u32 = 4;
/// The widest field a run can have: a 64-bit value.
const MAX_FIELD_BYTES: usize = 8;
/// NTFS numbers clusters with signed 64-bit LCNs and VCNs, so nothing a run
/// list maps may lie past this.
const MAX_CLUSTER: u64 = i64::MAX.unsigned_abs();

/// A little-endian unsigned field of 1 to 8 bytes.
fn unsigned(bytes: &[u8]) -> u64 {
    bytes
        .iter()
        .rev()
        .fold(0_u64, |acc, b| (acc << 8) | u64::from(*b))
}

/// A little-endian signed field of 1 to 8 bytes, sign-extended from its top byte.
fn signed(bytes: &[u8]) -> i64 {
    let negative = bytes.last().is_some_and(|top| top & 0x80 != 0);
    let init: u64 = if negative { u64::MAX } else { 0 };
    let value = bytes
        .iter()
        .rev()
        .fold(init, |acc, b| (acc << 8) | u64::from(*b));
    i64::from_ne_bytes(value.to_ne_bytes())
}

/// Decodes a non-resident attribute's run list into `(starting LCN, cluster
/// count)` runs in VCN order; a sparse run's LCN is `None`.
///
/// Refused, naming the run's offset: a run with no length field or a zero
/// length, a field wider than 8 bytes or running past the list, a run whose
/// position leaves the 64-bit signed cluster range (below LCN 0, or past
/// `i64::MAX` by its position or its last cluster), a list that maps more
/// clusters than a VCN can count, and a list with no terminator. Lengths are
/// read unsigned, which also reads right the minimal signed encoding
/// ntfs-3g writes (it never sets the top bit of a length's last byte).
pub fn decode_runs(runs: &[u8]) -> Result<Vec<(Option<u64>, u64)>, RecordError> {
    let mut out = Vec::new();
    let mut lcn: i64 = 0;
    let mut clusters: u64 = 0;
    let mut pos = 0_usize;
    loop {
        let at = pos;
        let bad = move |reason| RecordError::BadRuns { offset: at, reason };
        let header = *runs
            .get(at)
            .ok_or_else(|| bad("the run list ends without its terminator"))?;
        if header == 0 {
            return Ok(out);
        }
        let length_width = usize::from(header & LENGTH_WIDTH_MASK);
        let offset_width = usize::from(header >> OFFSET_WIDTH_SHIFT);
        if length_width == 0 {
            return Err(bad("the run has no length field"));
        }
        if length_width > MAX_FIELD_BYTES || offset_width > MAX_FIELD_BYTES {
            return Err(bad("a field of the run is wider than 8 bytes"));
        }
        let length_at = at + 1;
        let offset_at = length_at + length_width;
        let end = offset_at + offset_width;
        let length = unsigned(
            runs.get(length_at..offset_at)
                .ok_or_else(|| bad("the run's length field runs past the run list"))?,
        );
        if length == 0 {
            return Err(bad("the run has zero length"));
        }
        let start = if offset_width == 0 {
            None
        } else {
            let delta = signed(
                runs.get(offset_at..end)
                    .ok_or_else(|| bad("the run's offset field runs past the run list"))?,
            );
            lcn = lcn
                .checked_add(delta)
                .ok_or_else(|| bad("the run's position overflows a 64-bit LCN"))?;
            let first = u64::try_from(lcn).map_err(|_| bad("the run points before LCN 0"))?;
            first
                .checked_add(length)
                .filter(|last| *last <= MAX_CLUSTER)
                .ok_or_else(|| bad("the run's clusters overflow a 64-bit LCN"))?;
            Some(first)
        };
        clusters = clusters
            .checked_add(length)
            .filter(|n| *n <= MAX_CLUSTER)
            .ok_or_else(|| bad("the runs overflow the clusters a 64-bit VCN can count"))?;
        out.push((start, length));
        pos = end;
    }
}

/// Where one run of `$MFT`'s records lies on the volume.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MftExtent {
    /// The first record number the run holds.
    pub first_record: u64,
    /// How many records it holds.
    pub records: u64,
    /// Its byte offset on the volume.
    pub byte_offset: u64,
}

/// Why `$MFT`'s runs cannot be mapped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExtentError {
    /// The cluster size or the record size is zero.
    ZeroSize,
    /// A sparse run: `$MFT`'s clusters are always allocated.
    SparseRun {
        /// The run's index.
        index: usize,
    },
    /// A run that is not a whole number of records, so a record would lie
    /// across two runs (clusters smaller than records, fragmented mid-record).
    PartialRecord {
        /// The run's index.
        index: usize,
    },
    /// A byte offset or a record count past 2^64.
    Overflow {
        /// The run's index.
        index: usize,
    },
}

impl std::fmt::Display for ExtentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ZeroSize => f.write_str("the volume reports a zero cluster or record size"),
            Self::SparseRun { index } => write!(f, "$MFT's run {index} is sparse"),
            Self::PartialRecord { index } => {
                write!(f, "$MFT's run {index} is not a whole number of records")
            }
            Self::Overflow { index } => write!(f, "$MFT's run {index} lies past 2^64 bytes"),
        }
    }
}

impl std::error::Error for ExtentError {}

/// `$MFT`'s records, run by run: record number to byte offset on the volume.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MftExtents {
    extents: Vec<MftExtent>,
    bytes_per_record: u64,
}

impl MftExtents {
    /// Maps `runs` (from [`decode_runs`], every extent of `$MFT`'s unnamed
    /// `$DATA` concatenated in VCN order) with the volume's cluster and record
    /// sizes. The map covers every allocated record; a reader must stop at
    /// `$MFT`'s initialized size, past which the clusters hold whatever the
    /// disk held before.
    pub fn new(
        runs: &[(Option<u64>, u64)],
        bytes_per_cluster: u64,
        bytes_per_record: u64,
    ) -> Result<Self, ExtentError> {
        if bytes_per_cluster == 0 || bytes_per_record == 0 {
            return Err(ExtentError::ZeroSize);
        }
        let mut extents = Vec::with_capacity(runs.len());
        let mut next_record = 0_u64;
        for (index, &(start, clusters)) in runs.iter().enumerate() {
            let lcn = start.ok_or(ExtentError::SparseRun { index })?;
            let overflow = ExtentError::Overflow { index };
            let bytes = clusters.checked_mul(bytes_per_cluster).ok_or(overflow)?;
            if bytes % bytes_per_record != 0 {
                return Err(ExtentError::PartialRecord { index });
            }
            let byte_offset = lcn.checked_mul(bytes_per_cluster).ok_or(overflow)?;
            byte_offset.checked_add(bytes).ok_or(overflow)?;
            let records = bytes / bytes_per_record;
            extents.push(MftExtent {
                first_record: next_record,
                records,
                byte_offset,
            });
            next_record = next_record.checked_add(records).ok_or(overflow)?;
        }
        Ok(Self {
            extents,
            bytes_per_record,
        })
    }

    /// The byte offset of record `number` on the volume, or `None` past the
    /// last run.
    pub fn offset_of(&self, number: u64) -> Option<u64> {
        let index = self
            .extents
            .partition_point(|e| e.first_record.saturating_add(e.records) <= number);
        let extent = self.extents.get(index)?;
        let within = number.checked_sub(extent.first_record)?;
        extent
            .byte_offset
            .checked_add(within.checked_mul(self.bytes_per_record)?)
    }

    /// How many records the runs hold.
    pub fn record_count(&self) -> u64 {
        self.extents
            .last()
            .map_or(0, |e| e.first_record.saturating_add(e.records))
    }

    /// The runs, in record order: what a sequential reader walks.
    pub fn extents(&self) -> &[MftExtent] {
        &self.extents
    }
}

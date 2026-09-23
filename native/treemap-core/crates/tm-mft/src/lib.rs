//! `tm-mft`: the NTFS master file table read as records instead of listed
//! directory by directory (Phase 3 W6, the "turbo mode" of
//! `docs/superpowers/plans/2026-09-23-phase3-w6-mft.md`).
//!
//! Everything in this crate but the Windows calls themselves is portable and
//! tested on synthetic byte buffers on every platform, exactly as the Windows
//! listing's parsers are:
//!
//! * [`record`] applies a FILE record's update-sequence fix-ups and reads the
//!   attributes the tree needs: `$STANDARD_INFORMATION`, every `$FILE_NAME`,
//!   the unnamed `$DATA` stream's sizes and `$REPARSE_POINT`'s value.
//! * [`runs`] decodes a non-resident attribute's run list and maps record
//!   numbers to byte offsets on the volume through `$MFT`'s own extents.
//! * [`tree`] merges extension records into their base record and builds the
//!   scan root's subtree in `tm_walk`'s column shape, entry by entry through
//!   the Windows listing's own staging rules, so the store, the JSON and the
//!   equivalence gate see what the listing walk would have produced.
//! * [`volume`] reads the table off a volume's bytes: `$MFT`'s own record,
//!   every extent of it (its extension records included), every record in
//!   whole-cluster reads of at most 1 MiB up to its initialized size,
//!   `$UpCase`, and the root's record; then the tree.
//! * [`error`] is every refusal of the reader ([`volume`] and [`win32`]), as a
//!   sentence.
//! * [`win32`] goes from a scan root to an open, checked volume: a drive
//!   letter's local NTFS volume holding the root, opened read-only. Its
//!   `cfg(windows)` layer is the calls alone (`read_volume`, Windows only);
//!   the order and every refusal are portable and tested with a script.
//!
//! The elevated helper that runs `read_volume` for the app is M6.

pub mod error;
pub mod record;
pub mod runs;
pub mod tree;
pub mod volume;
pub mod win32;

pub use error::MftError;
pub use record::{
    DataExtent, FileName, Record, RecordError, StdInfo, UPDATE_SEQUENCE_STRIDE, data_extents,
    parse_record,
};
pub use runs::{ExtentError, MftExtent, MftExtents, decode_runs};
pub use tree::{BuildError, RecordTable, build_tree, collate, with_root_name};
pub use volume::{Chunk, Geometry, MAX_CHUNK_BYTES, Volume, VolumeFacts, plan_chunks, read_mft};
#[cfg(windows)]
pub use win32::read_volume;
pub use win32::{OpenedVolume, RootIdentity, VolumeApi, VolumeInformation, read_volume_with};

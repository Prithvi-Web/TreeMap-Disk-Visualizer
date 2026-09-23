//! `tm-mft`: the NTFS master file table read as records instead of listed
//! directory by directory (Phase 3 W6, the "turbo mode" of
//! `docs/superpowers/plans/2026-09-23-phase3-w6-mft.md`).
//!
//! Everything in this crate so far is portable and tested on synthetic byte
//! buffers on every platform, exactly as the Windows listing's parsers are:
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
//!
//! The volume reader (`cfg(windows)`) and the elevated helper are later tasks
//! of the same plan (M4-M6); nothing here touches a volume.

pub mod record;
pub mod runs;
pub mod tree;

pub use record::{
    DataExtent, FileName, Record, RecordError, StdInfo, UPDATE_SEQUENCE_STRIDE, data_extents,
    parse_record,
};
pub use runs::{ExtentError, MftExtent, MftExtents, decode_runs};
pub use tree::{BuildError, RecordTable, build_tree, collate, with_root_name};

//! Why the MFT reader produced no tree: [`MftError`], one variant per
//! refusal, each reading as a sentence — the reason a scan falls back to the
//! listing walk with.

use std::fmt;

use crate::record::RecordError;
use crate::runs::ExtentError;
use crate::tree::BuildError;

/// Why no tree was read off the volume. Every variant reads as a sentence
/// (its `Display`), which is the reason a scan falls back to the listing
/// walk with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MftError {
    /// The scan root cannot be used as given.
    BadRoot {
        /// What is wrong with it.
        reason: &'static str,
    },
    /// The root's volume is not mounted at a drive letter's root.
    NoDriveLetter {
        /// The volume path `GetVolumePathNameW` returned.
        volume: String,
    },
    /// The root's volume is a network drive.
    NetworkVolume {
        /// Its volume path.
        volume: String,
    },
    /// Windows reports no volume at the root's volume path.
    NoVolume {
        /// The volume path.
        volume: String,
    },
    /// The volume's file system is not NTFS.
    NotNtfs {
        /// The volume path.
        volume: String,
        /// The file system's name, as `GetVolumeInformationW` reported it.
        file_system: String,
    },
    /// The volume could not be opened for reading: access is denied, which
    /// is what an unelevated process is told.
    NotElevated {
        /// The volume path.
        volume: String,
    },
    /// The root lies on another volume than the one its path names.
    OtherVolume {
        /// The serial number of the volume the root itself is on.
        root_serial: u32,
        /// The serial number of the volume its path names.
        volume_serial: u32,
    },
    /// A Windows call failed.
    Os {
        /// The call.
        call: &'static str,
        /// Its Windows error code.
        code: u32,
    },
    /// A call failed with an error that carries no Windows error code.
    Io {
        /// The call.
        call: &'static str,
        /// The error, in words.
        message: String,
    },
    /// The volume's geometry is not one the reader can read with.
    BadGeometry {
        /// What `FSCTL_GET_NTFS_VOLUME_DATA` reported that is wrong.
        reason: &'static str,
    },
    /// The volume returned fewer bytes than were asked for.
    ShortRead {
        /// Where the read started.
        offset: u64,
        /// How many bytes were asked for.
        wanted: u64,
        /// How many came back.
        got: u64,
    },
    /// `$MFT`'s own record cannot start the read.
    BadMftRecord {
        /// What is wrong with it.
        reason: &'static str,
    },
    /// Two extents of one stream map the same VCN.
    OverlappingExtents {
        /// The stream (`$MFT` or `$UpCase`).
        stream: &'static str,
        /// The VCN the second extent starts at.
        vcn: u64,
    },
    /// `$MFT`'s extents found map fewer records than its initialized size
    /// holds: the extension record naming the rest was not among them.
    MftIncomplete {
        /// The records the extents found map (all of them were read).
        read: u64,
        /// The records the initialized size holds.
        wanted: u64,
    },
    /// An in-use record that cannot be parsed.
    BadRecord {
        /// The record's number.
        record: u64,
        /// Why the parser refused it.
        error: RecordError,
    },
    /// An in-use record whose header names another record number.
    MisplacedRecord {
        /// Where in `$MFT` it was read.
        position: u64,
        /// The number its header holds.
        number: u64,
    },
    /// A run list of `$MFT` or `$UpCase` that does not decode.
    BadRuns {
        /// The stream (`$MFT` or `$UpCase`).
        stream: &'static str,
        /// Why the decoder refused it.
        error: RecordError,
    },
    /// `$MFT`'s runs cannot be mapped to records.
    Extents(ExtentError),
    /// `$UpCase` cannot be read.
    BadUpcase {
        /// What is wrong with it.
        reason: &'static str,
    },
    /// The root's record is not an in-use record of the table as read.
    RootNotRead {
        /// The root's record number.
        record: u64,
    },
    /// The root's record holds another file than the root that was opened.
    RootReplaced {
        /// The root's record number.
        record: u64,
        /// The sequence number of the root that was opened.
        sequence: u16,
        /// The sequence number the table holds for that record.
        found: u16,
    },
    /// The tree builder refused.
    Build(BuildError),
    /// A position or a size past what 64 bits, or this platform's memory,
    /// can address.
    Overflow,
}

impl fmt::Display for MftError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadRoot { reason } => write!(f, "the scan root {reason}"),
            Self::NoDriveLetter { volume } => write!(
                f,
                "the scan root is on the volume mounted at {volume}, which is not a drive letter's root (a folder mount point, or a network share); only a volume with a drive letter can be read"
            ),
            Self::NetworkVolume { volume } => write!(
                f,
                "{volume} is a network drive: its master file table is on another machine"
            ),
            Self::NoVolume { volume } => write!(f, "Windows reports no volume at {volume}"),
            Self::NotNtfs {
                volume,
                file_system,
            } => {
                if file_system.is_empty() {
                    write!(
                        f,
                        "{volume} reports no file system name; only NTFS keeps a master file table"
                    )
                } else {
                    write!(
                        f,
                        "{volume} is formatted {file_system}, not NTFS; only NTFS keeps a master file table"
                    )
                }
            }
            Self::NotElevated { volume } => write!(
                f,
                "the volume {volume} could not be opened for reading: access is denied; reading a volume's master file table needs an elevated (administrator) process"
            ),
            Self::OtherVolume {
                root_serial,
                volume_serial,
            } => write!(
                f,
                "the scan root is on the volume with serial number {root_serial:08X}, not on {volume_serial:08X}, the volume its path names: it is reached through a junction or a symbolic link"
            ),
            Self::Os { call, code } => {
                write!(f, "{call} failed with Windows error {code}")?;
                #[cfg(windows)]
                write!(
                    f,
                    " ({})",
                    std::io::Error::from_raw_os_error(i32::try_from(*code).unwrap_or(i32::MAX))
                )?;
                Ok(())
            }
            Self::Io { call, message } => write!(f, "{call} failed: {message}"),
            Self::BadGeometry { reason } => {
                write!(f, "FSCTL_GET_NTFS_VOLUME_DATA reported {reason}")
            }
            Self::ShortRead {
                offset,
                wanted,
                got,
            } => write!(
                f,
                "the volume returned {got} of the {wanted} bytes asked for at offset {offset}"
            ),
            Self::BadMftRecord { reason } => write!(f, "$MFT's own record (0): {reason}"),
            Self::OverlappingExtents { stream, vcn } => {
                write!(f, "two extents of {stream}'s data map VCN {vcn}")
            }
            Self::MftIncomplete { read, wanted } => write!(
                f,
                "$MFT's extents that were found map {read} records, but its initialized size holds {wanted}: no record read names the rest"
            ),
            Self::BadRecord { record, error } => {
                write!(f, "record {record} is in use but could not be read: {error}")
            }
            Self::MisplacedRecord { position, number } => write!(
                f,
                "the record at position {position} of $MFT says it is record {number}"
            ),
            Self::BadRuns { stream, error } => write!(f, "{stream}'s run list: {error}"),
            Self::Extents(error) => write!(f, "{error}"),
            Self::BadUpcase { reason } => write!(f, "$UpCase (record 10): {reason}"),
            Self::RootNotRead { record } => write!(
                f,
                "the scan root's record {record} is not an in-use record of the master file table as the disk holds it (a table written before the root was made, or a root deleted since)"
            ),
            Self::RootReplaced {
                record,
                sequence,
                found,
            } => write!(
                f,
                "the scan root is record {record} with sequence number {sequence}, but the disk holds sequence number {found} there (the root was replaced, or the table on disk predates it)"
            ),
            Self::Build(error) => write!(f, "the tree could not be built: {error}"),
            Self::Overflow => f.write_str(
                "a position or a size on the volume lies past what 64 bits, or this platform's memory, can address",
            ),
        }
    }
}

impl std::error::Error for MftError {}

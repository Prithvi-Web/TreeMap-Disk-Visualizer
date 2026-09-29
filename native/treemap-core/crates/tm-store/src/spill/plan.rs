//! Whether a scan may spill, and how much disk it holds while it does (Phase 4 T13b;
//! design §S.3's disk rule and §S.5.4).
//!
//! [`spill_plan`] allows a spill only when all of these hold, and otherwise names, in a
//! sentence a person can read, the first rule that refused it ([`SpillRefusal`]):
//!
//! 1. app-data can be written: not a read-only portable session, a fact Node passes in
//!    (`portableStatus().writable`, from `probeWritable` in `src/services/portableMode.ts`);
//! 2. the volume's facts can be read (unknown free space is not enough free space);
//! 3. the file system is local: `smbfs`, `nfs`, `afpfs`, `webdav` and `fuse` are refused in
//!    every spelling ([`FileSystem`]), because on them a file removed while it is open can be
//!    left behind under another name;
//! 4. free space is at least 3 × the bytes the spill writes ([`spill_bytes`]) + 1 GiB, where
//!    free space is what the volume reports less what other spills of this process hold
//!    reserved on the [`Ledger`].
//!
//! An allowed plan holds its bytes on the ledger until its [`Reservation`] is dropped, so
//! scans planned at the same time cannot each count the same free space. The check and the
//! reservation are one step under the ledger's lock.
//!
//! Whether app-data and the scanned root are on one volume is reported and never refuses:
//! spill files have no names, so no walk can count them (§S.5.3).
//!
//! During the walk, after every [`IN_WALK_CHECK_EVERY`] bytes written, the spill sink asks
//! [`in_walk_check`]: free space must stay at least 2 × the bytes still to write + max(1 GiB,
//! 2 % of the volume).

use std::fmt;
use std::io;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};

/// The rule's free-space multiple: a spill needs 3 × the bytes it writes free.
pub const FREE_MULTIPLE: u64 = 3;
/// And this much more, to spare: 1 GiB.
pub const FREE_RESERVE: u64 = 1 << 30;
/// How often, in bytes written, the spill sink checks the volume during the walk.
pub const IN_WALK_CHECK_EVERY: u64 = 256 << 20;
/// The in-walk rule's floor for the margin: 1 GiB.
pub const IN_WALK_FLOOR: u64 = 1 << 30;
/// The in-walk rule's margin as a share of the volume: 2 %, one fiftieth.
pub const IN_WALK_VOLUME_DIVISOR: u64 = 50;

/// The bytes one row takes on disk: the P4-1 columns are 46 B a row plus the name, 18 B at
/// §S.3's budgeted mean (L), and `nameOff` is a u64 on disk (§S.5.2), 4 B more than in
/// memory: 46 + 18 + 4.
pub const ROW_BYTES: u64 = 68;
/// The block table and the patch log: about 32 B per folder (§S.3).
pub const FOLDER_LOG_BYTES: u64 = 32;
/// The share of entries that are folders, in percent (§S.3; DESIGN §6).
pub const FOLDER_PERCENT: u64 = 15;
/// One link-key record (§S.3).
pub const LINK_RECORD_BYTES: u64 = 40;
/// The link-key log is counted twice: its records, and one sorted copy beside them, as the
/// sort writes its runs (§S.3's Windows row; §S.6.3's 0.24 GB at a POSIX 100M).
pub const LINK_LOG_COPIES: u64 = 2;
/// The share of files keyed on POSIX, in percent: κ, a file whose listing reported more
/// than one link (§S.3). Windows reports no link count, so there every file is keyed.
pub const POSIX_KEYED_PERCENT: u64 = 1;

/// Which operating system's rule sizes the link-key log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    /// macOS and Linux: a file is keyed when its listing reports more than one link.
    Posix,
    /// Windows: no link count is reported, so every file is keyed.
    Windows,
}

impl Platform {
    /// The platform this build runs on.
    pub const THIS: Self = if cfg!(windows) {
        Self::Windows
    } else {
        Self::Posix
    };
}

/// What a spill writes, term by term (§S.3's rule): its rows, its folders' block table and
/// patch log, and the link-key log with one sort copy.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SpillBytes {
    /// The rows: [`ROW_BYTES`] each.
    pub columns: u64,
    /// The block table and the patch log: [`FOLDER_LOG_BYTES`] per folder.
    pub folder_logs: u64,
    /// The link-key log: [`LINK_RECORD_BYTES`] per keyed file, [`LINK_LOG_COPIES`] times.
    pub link_log: u64,
}

impl SpillBytes {
    /// All three, saturating at `u64::MAX`.
    pub fn total(self) -> u64 {
        self.columns
            .saturating_add(self.folder_logs)
            .saturating_add(self.link_log)
    }
}

/// The bytes a spill of `projected_entries` rows writes, from §S.3's rule, written once
/// here:
///
/// ```text
/// folders = ⌈entries × 15 / 100⌉              files = entries − folders
/// keyed   = ⌈files × 1 / 100⌉ on POSIX,      every file on Windows
/// bytes   = 68 × entries  +  32 × folders  +  2 × 40 × keyed
/// ```
///
/// That is 73.5 B an entry on POSIX (68 + 4.8 + 0.68) and 140.8 B on Windows (68 + 4.8 +
/// 68): 734.8 MB at 10M entries and 7.35 GB at 100M on POSIX, 1.41 GB and 14.08 GB on
/// Windows. The shares round up, so a small tree is never asked for less than its folders
/// and its keyed files; past any real tree the sum saturates rather than wraps.
///
/// The whole link-key log is counted, though up to 32 MiB of it stays in memory (§S.6.3):
/// at most 3 × 32 MiB more asked for, against the gigabytes a spill of millions of rows
/// asks for anyway.
pub fn spill_bytes(projected_entries: u64, platform: Platform) -> SpillBytes {
    let entries = u128::from(projected_entries);
    let folders = (entries * u128::from(FOLDER_PERCENT)).div_ceil(100);
    let files = entries - folders.min(entries);
    let keyed = match platform {
        Platform::Posix => (files * u128::from(POSIX_KEYED_PERCENT)).div_ceil(100),
        Platform::Windows => files,
    };
    let saturate = |bytes: u128| u64::try_from(bytes).unwrap_or(u64::MAX);
    SpillBytes {
        columns: saturate(entries * u128::from(ROW_BYTES)),
        folder_logs: saturate(folders * u128::from(FOLDER_LOG_BYTES)),
        link_log: saturate(keyed * u128::from(LINK_RECORD_BYTES * LINK_LOG_COPIES)),
    }
}

/// What a file system calls itself, as each OS says it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileSystem {
    /// macOS: `statfs`'s `f_fstypename` ("apfs", "smbfs"...).
    Named(String),
    /// Linux: `statfs`'s `f_type`, a magic number (`linux/magic.h`).
    Magic(u64),
    /// Windows: `GetDriveTypeW`'s answer for the volume (`DRIVE_REMOTE` is 4).
    DriveType(u32),
}

/// Linux's `f_type` for the network file systems refused, with the name a refusal gives:
/// NFS, SMB and its CIFS and SMB2 spellings, FUSE (which is how `davfs2`, WebDAV, and
/// `afpfs-ng`, AFP, mount there), and Coda (which `davfs2` can mount through as well).
const NETWORK_MAGIC: [(u64, &str); 6] = [
    (0x6969, "nfs"),
    (0x517B, "smbfs"),
    (0xFF53_4D42, "smbfs (cifs)"),
    (0xFE53_4D42, "smbfs (smb2)"),
    (0x6573_5546, "fuse"),
    (0x7375_7245, "coda"),
];

/// Windows' `GetDriveTypeW` answer for a network drive.
const DRIVE_REMOTE: u32 = 4;

impl FileSystem {
    /// The network file system this is, named as a refusal names it, or `None` for a local
    /// one. On macOS every FUSE build calls itself by a name holding "fuse" (`macfuse`,
    /// `osxfuse`, `fusefs`); FUSE-T mounts as `nfs` or `smbfs`, which are refused anyway.
    pub fn network(&self) -> Option<String> {
        match self {
            Self::Named(name) => match name.as_str() {
                "smbfs" | "nfs" | "afpfs" | "webdav" => Some(name.clone()),
                other if other.contains("fuse") => Some(format!("fuse ({other})")),
                _ => None,
            },
            Self::Magic(magic) => NETWORK_MAGIC
                .iter()
                .find(|(known, _)| known == magic)
                .map(|(_, named)| (*named).to_owned()),
            Self::DriveType(DRIVE_REMOTE) => Some("a network drive".to_owned()),
            Self::DriveType(_) => None,
        }
    }
}

/// Which volume a path is on: `st_dev` on POSIX, the volume's root path on Windows. Two
/// paths are on one volume when their ids are equal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VolumeId(pub String);

/// What a file system says about the volume holding a path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VolumeFacts {
    /// The bytes free for a user without privilege: `f_bavail × f_frsize` (`statvfs`; on
    /// macOS `f_bavail × f_bsize` from `statfs`, whose counts are 64-bit where `statvfs`'s
    /// are 32), or `GetDiskFreeSpaceExW`'s free bytes available to the caller.
    pub free_bytes: u64,
    /// The volume's size, as the same call gives it.
    pub total_bytes: u64,
    /// The file system.
    pub file_system: FileSystem,
    /// The volume.
    pub volume: VolumeId,
}

/// Where [`spill_plan`] reads a volume's facts: the OS ([`OsVolumes`]), or a test's table.
pub trait VolumeSource {
    /// The facts of the volume holding `path`, which exists.
    fn facts(&self, path: &Path) -> io::Result<VolumeFacts>;
}

/// The OS's own calls: `statvfs` and `statfs` (macOS `statfs` alone) and `stat`; on Windows
/// `GetVolumePathNameW`, `GetDiskFreeSpaceExW` and `GetDriveTypeW`.
pub struct OsVolumes;

impl VolumeSource for OsVolumes {
    fn facts(&self, path: &Path) -> io::Result<VolumeFacts> {
        super::sys::volume_facts(path)
    }
}

/// Why a scan does not spill, in a sentence a person can read ([`fmt::Display`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpillRefusal {
    /// App-data cannot be written in this session (a read-only portable drive).
    AppDataReadOnly,
    /// The facts of app-data's volume could not be read.
    VolumeUnreadable {
        /// The OS's answer.
        error: String,
    },
    /// App-data is on a network file system.
    NetworkFileSystem {
        /// Which, named as [`FileSystem::network`] names it.
        file_system: String,
    },
    /// Free space is under the rule: [`FREE_MULTIPLE`] × the bytes written + [`FREE_RESERVE`].
    NotEnoughSpace {
        /// What the rule asks for.
        needs: u64,
        /// What the spill would write.
        writes: u64,
        /// What the volume reported free.
        free: u64,
        /// What other spills of this process held reserved of it.
        reserved: u64,
    },
    /// During the walk, free space fell under the in-walk rule ([`in_walk_check`]).
    LowSpaceWhileSpilling {
        /// What the volume reported free.
        free: u64,
        /// What the rule asks for.
        needs: u64,
        /// The bytes still to write.
        remainder: u64,
        /// The margin: the larger of 1 GiB and 2 % of the volume.
        margin: u64,
    },
}

impl fmt::Display for SpillRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AppDataReadOnly => f.write_str(
                "TreeMap's data folder cannot be written in this session (a read-only portable \
                 drive), so a scan has nowhere to spill to",
            ),
            Self::VolumeUnreadable { error } => write!(
                f,
                "the free space of the volume holding TreeMap's data folder could not be read \
                 ({error}), so a scan does not spill there"
            ),
            Self::NetworkFileSystem { file_system } => write!(
                f,
                "TreeMap's data folder is on a network file system ({file_system}); a file \
                 removed while it is open can be left there under another name, so a scan does \
                 not spill there"
            ),
            Self::NotEnoughSpace {
                needs,
                writes,
                free,
                reserved,
            } => {
                write!(
                    f,
                    "spilling this scan needs {} free on the volume of TreeMap's data folder: \
                     three times the {} it would write, and {} to spare; {} is free",
                    bytes_text(*needs),
                    bytes_text(*writes),
                    bytes_text(FREE_RESERVE),
                    bytes_text(*free),
                )?;
                if *reserved > 0 {
                    write!(
                        f,
                        ", and other scans' spills have reserved {} of it",
                        bytes_text(*reserved)
                    )?;
                }
                Ok(())
            }
            Self::LowSpaceWhileSpilling {
                free,
                needs,
                remainder,
                margin,
            } => write!(
                f,
                "free space on the volume of TreeMap's data folder fell to {} while this scan \
                 was spilling, under the {} it needs: twice the {} still to write, and {} to \
                 spare (the larger of {} and 2% of the volume)",
                bytes_text(*free),
                bytes_text(*needs),
                bytes_text(*remainder),
                bytes_text(*margin),
                bytes_text(IN_WALK_FLOOR),
            ),
        }
    }
}

impl std::error::Error for SpillRefusal {}

/// The bytes spills of this process hold reserved: each allowed plan adds what its spill
/// writes, and gives it back when its [`Reservation`] is dropped. Every scan of the process
/// plans against [`Ledger::process`]; a test makes its own.
///
/// A reservation counts its spill's whole size until it is released, so a plan made while
/// another spill is part way through counts the bytes that spill has written twice — once
/// in the volume's free space and once here — which errs toward refusing.
#[derive(Debug, Default)]
pub struct Ledger {
    reserved: Mutex<u64>,
}

impl Ledger {
    /// An empty ledger.
    pub const fn new() -> Self {
        Self {
            reserved: Mutex::new(0),
        }
    }

    /// The ledger every scan of this process plans against.
    pub fn process() -> &'static Self {
        static PROCESS: Ledger = Ledger::new();
        &PROCESS
    }

    /// The bytes held reserved now.
    pub fn reserved(&self) -> u64 {
        *self.lock()
    }

    /// A panic while the lock was held cannot leave the count half-changed (every change is
    /// one assignment), so a poisoned lock is taken as it is.
    fn lock(&self) -> MutexGuard<'_, u64> {
        self.reserved.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Reserves `writes` when `free`, less what is already reserved, is at least `needs`;
    /// one step under the lock. Answers the reservation or the refusal, and what was
    /// reserved before it.
    fn reserve(
        &self,
        free: u64,
        needs: u64,
        writes: u64,
    ) -> (Result<Reservation<'_>, SpillRefusal>, u64) {
        let mut reserved = self.lock();
        let before = *reserved;
        if free.saturating_sub(before) >= needs {
            *reserved = before.saturating_add(writes);
            let held = Reservation {
                ledger: self,
                bytes: writes,
            };
            (Ok(held), before)
        } else {
            let refusal = SpillRefusal::NotEnoughSpace {
                needs,
                writes,
                free,
                reserved: before,
            };
            (Err(refusal), before)
        }
    }
}

/// A spill's bytes held on a [`Ledger`], given back when this is dropped.
#[derive(Debug)]
pub struct Reservation<'a> {
    ledger: &'a Ledger,
    bytes: u64,
}

impl Reservation<'_> {
    /// The bytes held.
    pub fn bytes(&self) -> u64 {
        self.bytes
    }
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        let mut reserved = self.ledger.lock();
        *reserved = reserved.saturating_sub(self.bytes);
    }
}

/// What a plan is asked about.
#[derive(Clone, Copy, Debug)]
pub struct SpillRequest<'a> {
    /// The rows the scan is projected to hold (P4-4a: the previous scan of the root's
    /// entries × 1.25; for the overflow target, `capRows`).
    pub projected_entries: u64,
    /// Whose rule sizes the link-key log: [`Platform::THIS`] outside tests.
    pub platform: Platform,
    /// TreeMap's data folder, which exists: the spill folder is made in it.
    pub app_data_dir: &'a Path,
    /// The folder being scanned, for the same-volume report.
    pub scanned_root: &'a Path,
    /// Whether app-data can be written: false in a read-only portable session. Node knows
    /// (`portableStatus().writable`) and passes it in.
    pub app_data_writable: bool,
}

/// A plan's answer.
#[derive(Debug)]
pub struct SpillPlan<'a> {
    /// What the spill would write.
    pub bytes: SpillBytes,
    /// The free bytes app-data's volume reported, or `None` when they could not be read.
    pub free_bytes: Option<u64>,
    /// What other spills of this process held reserved when the plan was decided.
    pub reserved_elsewhere: u64,
    /// Whether app-data and the scanned root are on one volume, or `None` when either's
    /// volume could not be read. Reported only: it never refuses (§S.5.3).
    pub same_volume: Option<bool>,
    /// Allowed, with the spill's bytes held on the ledger until the reservation is dropped;
    /// or refused, and why.
    pub verdict: Result<Reservation<'a>, SpillRefusal>,
}

/// Whether a scan of `request.projected_entries` rows may spill into app-data now, and on
/// what: see the module docs for the rules, in the order they are asked.
pub fn spill_plan<'l>(
    request: &SpillRequest<'_>,
    volumes: &dyn VolumeSource,
    ledger: &'l Ledger,
) -> SpillPlan<'l> {
    let bytes = spill_bytes(request.projected_entries, request.platform);
    let app_data = volumes.facts(request.app_data_dir);
    let root = volumes.facts(request.scanned_root);
    let same_volume = match (&app_data, &root) {
        (Ok(app_data), Ok(root)) => Some(app_data.volume == root.volume),
        _ => None,
    };
    let free_bytes = app_data.as_ref().ok().map(|facts| facts.free_bytes);
    let (verdict, seen) = decide(request, bytes, app_data, ledger);
    let reserved_elsewhere = seen.unwrap_or_else(|| ledger.reserved());
    SpillPlan {
        bytes,
        free_bytes,
        reserved_elsewhere,
        same_volume,
        verdict,
    }
}

/// The rules, in order; the first that fails is the answer. With it, what other spills held
/// reserved when the ledger was asked, if it was.
fn decide<'l>(
    request: &SpillRequest<'_>,
    bytes: SpillBytes,
    app_data: io::Result<VolumeFacts>,
    ledger: &'l Ledger,
) -> (Result<Reservation<'l>, SpillRefusal>, Option<u64>) {
    if !request.app_data_writable {
        return (Err(SpillRefusal::AppDataReadOnly), None);
    }
    let facts = match app_data {
        Ok(facts) => facts,
        Err(e) => {
            let error = e.to_string();
            return (Err(SpillRefusal::VolumeUnreadable { error }), None);
        }
    };
    if let Some(file_system) = facts.file_system.network() {
        return (Err(SpillRefusal::NetworkFileSystem { file_system }), None);
    }
    let writes = bytes.total();
    let needs = writes
        .saturating_mul(FREE_MULTIPLE)
        .saturating_add(FREE_RESERVE);
    let (verdict, before) = ledger.reserve(facts.free_bytes, needs, writes);
    (verdict, Some(before))
}

/// The in-walk rule (§S.5.4), which the spill sink asks after every
/// [`IN_WALK_CHECK_EVERY`] bytes written: `free` must be at least 2 × `remainder` (the bytes
/// still to write) + the larger of 1 GiB and 2 % of `volume_bytes`.
pub fn in_walk_check(free: u64, volume_bytes: u64, remainder: u64) -> Result<(), SpillRefusal> {
    let margin = IN_WALK_FLOOR.max(volume_bytes / IN_WALK_VOLUME_DIVISOR);
    let needs = remainder.saturating_mul(2).saturating_add(margin);
    if free >= needs {
        Ok(())
    } else {
        Err(SpillRefusal::LowSpaceWhileSpilling {
            free,
            needs,
            remainder,
            margin,
        })
    }
}

/// `bytes` as the app writes a size (`formatBytes`, `src/utils/formatBytes.ts`): steps of
/// 1024 named B, KB, MB, GB, TB and PB, one decimal past bytes, a half rounded up as
/// `toFixed` rounds it, and a figure that rounds to 1024 of a unit given as one of the next.
/// Computed in whole numbers, so it agrees with JavaScript's doubles wherever those are
/// exact (below 2^53).
pub fn bytes_text(bytes: u64) -> String {
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    let n = u128::from(bytes);
    let mut unit = 0;
    while unit < UNITS.len() - 1 && n >= 1024_u128.pow(u32::try_from(unit + 1).unwrap_or(0)) {
        unit += 1;
    }
    if unit == 0 {
        return format!("{bytes} B");
    }
    // Tenths of the unit, a half rounded up: ⌊(10n / d) + ½⌋ = ⌊(20n + d) / 2d⌋.
    let tenths = |unit: usize| {
        let d = 1024_u128.pow(u32::try_from(unit).unwrap_or(0));
        (20 * n + d) / (2 * d)
    };
    let mut shown = tenths(unit);
    if shown >= 10_240 && unit < UNITS.len() - 1 {
        unit += 1;
        shown = tenths(unit);
    }
    let name = UNITS.get(unit).copied().unwrap_or("PB");
    format!("{}.{} {name}", shown / 10, shown % 10)
}

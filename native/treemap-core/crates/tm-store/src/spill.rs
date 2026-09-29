//! Spill files (Phase 4 T13; design §S.5.3): the files a large scan's columns are written
//! to, made so that they cannot outlive the scan.
//!
//! They live in one folder, `<appData>/scan-spill` ([`SpillDir`]), mode 0700, and each
//! is left with no name the moment it is made, so the kernel frees its bytes when its
//! last descriptor closes: when the scan is forgotten, cancelled or fails, when the app
//! quits, and after a crash or a `SIGKILL` too (the kill test, `tests/spill.rs`).
//!
//! * **Linux:** `O_TMPFILE`, so the file never has a name. A file system or a kernel that
//!   refuses `O_TMPFILE` gets the macOS method.
//! * **macOS:** the file is made exclusively as `<pid>-<startMs>-<scanId>-<column>`
//!   ([`SpillName`]), and its name is removed at once, after a check immediately before the
//!   unlink that the name still leads to the file this process opened: the `(dev, ino)` of
//!   the name's `lstat` must equal the descriptor's `fstat`. A name that leads elsewhere by
//!   then is left alone and the file refused ([`SpillError::Replaced`]); a file that still
//!   has a name once its own is gone is refused too ([`SpillError::OtherName`]). POSIX has no
//!   call that removes a name only if it leads to a given file, so a process of the same user
//!   could still swap the name in the microseconds between the check and the unlink; a name
//!   in this 0700 folder is all that could be lost that way.
//! * **Windows:** `CreateFileW` with `FILE_FLAG_DELETE_ON_CLOSE` and `FILE_SHARE_DELETE`:
//!   the name lasts while the file is open, and Windows removes it with the last handle,
//!   the process's end included. The folder is held open meanwhile, sharing no deletion, so
//!   it cannot be renamed or replaced by a junction. A walk of app-data's volume would list
//!   the open files there, so the walk must be kept out of `scan-spill` on Windows (T17).
//!
//! Only a crash inside the macOS window between the create and the unlink, or a power loss
//! on Windows, can leave a name behind. The boot sweep (`src/services/spillSweep.ts`)
//! removes such a file once the process its `<pid>` names is dead, through one confined
//! remover. Those two removals — this module's `unlink` of a name this process made a
//! moment before, and the sweep's of a dead process's leftover — are the owner's
//! exception to the master prompt's §3.1 ("never an `unlink`"), decided on 28 Sep 2026
//! (plan §S.11 Q1): TreeMap removes files it created itself, only inside `scan-spill`.
//! Nothing here removes anything else.
//!
//! Every descriptor is opened close-on-exec, so no child process the app starts can
//! inherit one and keep a file's bytes after the scan (`O_CLOEXEC` on POSIX, a handle
//! that is not inheritable on Windows).
//!
//! A file's bytes are appended at the end it has reached and read back at their offsets
//! (`pwrite` and `pread`; `WriteFile` and `ReadFile` at an offset on Windows). Nothing is
//! ever mapped (decision P4-5a).
//!
//! Whether a scan may spill at all, and the disk it holds meanwhile, is [`spill_plan`]'s
//! and the [`Ledger`]'s (T13b, design §S.5.4): three times the bytes a spill writes plus
//! 1 GiB free, app-data writable, a local file system; and [`in_walk_check`] while it runs.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// The folder under app-data that holds spill files.
pub const SPILL_DIR: &str = "scan-spill";
/// The most bytes a scan id may take in a name: Node's ids are UUIDs, 36.
pub const SCAN_ID_MAX: usize = 64;
/// The most bytes a column label may take in a name.
pub const COLUMN_MAX: usize = 32;

/// Why a spill file or its folder could not be made.
#[derive(Debug, thiserror::Error)]
pub enum SpillError {
    /// A part of a name breaks the name rules ([`SpillName::new`]).
    #[error("the {part} {text:?} cannot name a spill file: {why}")]
    BadName {
        /// Which part: "scan id" or "column".
        part: &'static str,
        /// The text given.
        text: String,
        /// The rule it breaks.
        why: String,
    },
    /// The folder cannot be used: a link, not a folder, or not this user's.
    #[error("{} cannot hold spill files: {why}", path.display())]
    DirRefused {
        /// The folder.
        path: PathBuf,
        /// Why, in words.
        why: String,
    },
    /// A call the OS refused.
    #[error("{call} on {} failed: {source}", path.display())]
    Io {
        /// The path it was made on.
        path: PathBuf,
        /// The call.
        call: &'static str,
        /// The OS's answer.
        #[source]
        source: io::Error,
    },
    /// Something already has the name: nothing was opened, and the thing is left alone.
    #[error("{name} is already in {}, so it was left alone and no spill file made", dir.display())]
    NameTaken {
        /// The folder.
        dir: PathBuf,
        /// The name.
        name: String,
    },
    /// The name no longer led to the file this process made when it was to be removed, so
    /// nothing was removed; the file was closed.
    #[error(
        "{name} in {} no longer led to the file this process made ({why}), so it was left alone and the spill file refused",
        dir.display()
    )]
    Replaced {
        /// The folder.
        dir: PathBuf,
        /// The name.
        name: String,
        /// What was found instead.
        why: &'static str,
    },
    /// Once its own name was removed, the file still had another, so it could outlive the
    /// scan; it was closed, and the other name left alone.
    #[error(
        "the spill file made as {name} in {} has another name, so it could outlive the scan; it was refused",
        dir.display()
    )]
    OtherName {
        /// The folder.
        dir: PathBuf,
        /// The name it was made with.
        name: String,
    },
}

impl SpillError {
    fn refused(path: &Path, why: impl Into<String>) -> Self {
        Self::DirRefused {
            path: path.to_owned(),
            why: why.into(),
        }
    }

    fn io(path: &Path, call: &'static str, source: io::Error) -> Self {
        Self::Io {
            path: path.to_owned(),
            call,
            source,
        }
    }
}

/// A spill file's name, `<pid>-<startMs>-<scanId>-<column>`: this process's id, which the
/// boot sweep reads to tell a dead process's leftover from a live scan's file; the
/// milliseconds since 1970 when this process first named a spill file, which keeps a
/// leftover of an earlier process with the same pid from taking this process's names; then
/// the scan and the column. On macOS a file has it only for the moment between its create
/// and its unlink; on Windows while it is open; on Linux never.
///
/// The scan id may hold ASCII letters, digits, `-` and `_`; the column letters, digits and
/// `_`, so the last `-` of a name always ends the scan id. Neither may be empty or longer
/// than [`SCAN_ID_MAX`] and [`COLUMN_MAX`] bytes. So no part can hold a separator (`/`,
/// `\`, `:`), a `..`, a NUL or anything outside ASCII; a file system that folds case can
/// only make two names collide, which is refused as [`SpillError::NameTaken`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpillName {
    scan_id: String,
    column: String,
}

impl SpillName {
    /// A name for `column` of the scan `scan_id`, or the rule a part breaks.
    pub fn new(scan_id: &str, column: &str) -> Result<Self, SpillError> {
        check_part("scan id", scan_id, SCAN_ID_MAX, true)?;
        check_part("column", column, COLUMN_MAX, false)?;
        Ok(Self {
            scan_id: scan_id.to_owned(),
            column: column.to_owned(),
        })
    }

    /// The name itself, `<pid>-<startMs>-<scanId>-<column>`.
    pub fn file_name(&self) -> String {
        format!(
            "{}-{}-{}-{}",
            std::process::id(),
            start_ms(),
            self.scan_id,
            self.column
        )
    }
}

/// Refuses a part of a name that is empty, longer than `max` bytes, or holds a byte other
/// than an ASCII letter, a digit, `_` and — where `dash` — `-`.
fn check_part(part: &'static str, text: &str, max: usize, dash: bool) -> Result<(), SpillError> {
    let why = if text.is_empty() {
        Some("it is empty".to_owned())
    } else if text.len() > max {
        Some(format!("it is longer than {max} bytes"))
    } else if !text
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || (dash && b == b'-'))
    {
        Some(if dash {
            "it holds a character other than an ASCII letter, a digit, '-' and '_'".to_owned()
        } else {
            "it holds a character other than an ASCII letter, a digit and '_'".to_owned()
        })
    } else {
        None
    };
    why.map_or(Ok(()), |why| {
        Err(SpillError::BadName {
            part,
            text: text.to_owned(),
            why,
        })
    })
}

/// The `<startMs>` of this process's names: the milliseconds since 1970 when this process
/// first named a spill file. With the pid it tells this process's names from those of an
/// earlier process that had the same pid, so a leftover can never take a name this process
/// needs.
fn start_ms() -> u128 {
    static START: OnceLock<u128> = OnceLock::new();
    *START.get_or_init(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_millis())
    })
}

/// `<appData>/scan-spill`, checked and held: spill files are made in it.
pub struct SpillDir {
    path: PathBuf,
    dir: sys::Dir,
}

impl SpillDir {
    /// `<app_data_dir>/scan-spill`, made mode 0700 if it is absent, and made 0700 if it is
    /// this user's and more open than that. Refused, with the reason, if it is a link (a
    /// symbolic link; on Windows any reparse point, a junction included), not a folder, or
    /// — on POSIX — not this user's. `app_data_dir` itself must exist: it is Node's.
    ///
    /// On Windows the owner is not checked: that needs the folder's security descriptor,
    /// and app-data sits in the user's profile, whose permissions are the user's.
    pub fn open(app_data_dir: &Path) -> Result<Self, SpillError> {
        let path = app_data_dir.join(SPILL_DIR);
        let dir = sys::open_dir(&path)?;
        Ok(Self { path, dir })
    }

    /// The folder.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A new, empty spill file, which has no name (POSIX) or loses it when it closes
    /// (Windows): see the module docs. `name` is used only where a file has one: macOS,
    /// Linux without `O_TMPFILE`, and Windows. Give each file of a scan its own column: on
    /// Windows a name stays taken while its file is open, so a second file of the same name
    /// is refused as [`SpillError::NameTaken`] there, while on POSIX the first has no name by
    /// then and the second is made.
    pub fn create(&self, name: &SpillName) -> Result<SpillFile, SpillError> {
        let file = sys::create(&self.dir, &self.path, &name.file_name())?;
        Ok(SpillFile { file, len: 0 })
    }
}

/// An open spill file: bytes appended, and read back at their offsets.
pub struct SpillFile {
    file: File,
    /// The bytes appended so far: where the next append goes, and the end of what may be
    /// read.
    len: u64,
}

impl SpillFile {
    /// The bytes appended so far.
    pub fn len(&self) -> u64 {
        self.len
    }

    /// Whether nothing was appended yet.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Writes `bytes` at the end the file has reached, and answers the offset they start
    /// at. The write is positioned (`pwrite`; `WriteFile` at an offset), so a failed one —
    /// `ENOSPC`, `EIO` — leaves the length where it was, and the next append writes over
    /// whatever part of it landed.
    pub fn append(&mut self, bytes: &[u8]) -> io::Result<u64> {
        let at = self.len;
        let end = u64::try_from(bytes.len())
            .ok()
            .and_then(|len| at.checked_add(len))
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "past 2^64 bytes"))?;
        write_all_at(&self.file, bytes, at)?;
        self.len = end;
        Ok(at)
    }

    /// Fills `buf` with the bytes written at `offset`. A read reaching past what was
    /// appended is refused (`UnexpectedEof`) before the file is read.
    pub fn read_exact_at(&self, buf: &mut [u8], offset: u64) -> io::Result<()> {
        let written = u64::try_from(buf.len())
            .ok()
            .and_then(|len| offset.checked_add(len))
            .is_some_and(|end| end <= self.len);
        if !written {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                format!(
                    "{} bytes at {offset} reach past the {} written",
                    buf.len(),
                    self.len
                ),
            ));
        }
        read_exact_at(&self.file, buf, offset)
    }
}

#[cfg(unix)]
fn write_all_at(file: &File, bytes: &[u8], at: u64) -> io::Result<()> {
    std::os::unix::fs::FileExt::write_all_at(file, bytes, at)
}

#[cfg(unix)]
fn read_exact_at(file: &File, buf: &mut [u8], at: u64) -> io::Result<()> {
    std::os::unix::fs::FileExt::read_exact_at(file, buf, at)
}

/// `seek_write` until every byte is written. Every read and write here names its offset:
/// a positioned `ReadFile` on a handle opened for synchronous use moves the file pointer,
/// so a write at the pointer could land where the last read ended.
#[cfg(windows)]
fn write_all_at(file: &File, bytes: &[u8], at: u64) -> io::Result<()> {
    use std::os::windows::fs::FileExt;
    let (mut rest, mut at) = (bytes, at);
    while !rest.is_empty() {
        match file.seek_write(rest, at) {
            Ok(0) => return Err(io::Error::from(io::ErrorKind::WriteZero)),
            Ok(n) => {
                rest = rest.get(n..).unwrap_or_default();
                at = at.saturating_add(u64::try_from(n).unwrap_or(u64::MAX));
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// `seek_read` until `buf` is full; see [`write_all_at`].
#[cfg(windows)]
fn read_exact_at(file: &File, buf: &mut [u8], at: u64) -> io::Result<()> {
    use std::os::windows::fs::FileExt;
    let (mut rest, mut at) = (buf, at);
    while !rest.is_empty() {
        match file.seek_read(rest, at) {
            Ok(0) => return Err(io::Error::from(io::ErrorKind::UnexpectedEof)),
            Ok(n) => {
                rest = std::mem::take(&mut rest).get_mut(n..).unwrap_or_default();
                at = at.saturating_add(u64::try_from(n).unwrap_or(u64::MAX));
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

mod plan;

pub use plan::{
    FOLDER_LOG_BYTES, FOLDER_PERCENT, FREE_MULTIPLE, FREE_RESERVE, FileSystem, IN_WALK_CHECK_EVERY,
    IN_WALK_FLOOR, IN_WALK_VOLUME_DIVISOR, LINK_LOG_COPIES, LINK_RECORD_BYTES, Ledger, OsVolumes,
    POSIX_KEYED_PERCENT, Platform, ROW_BYTES, Reservation, SpillBytes, SpillPlan, SpillRefusal,
    SpillRequest, VolumeFacts, VolumeId, VolumeSource, bytes_text, in_walk_check, spill_bytes,
    spill_plan,
};

#[cfg(unix)]
#[path = "spill/sys_unix.rs"]
mod sys;

#[cfg(windows)]
#[path = "spill/sys_windows.rs"]
mod sys;

//! `tm-mft-helper`: the one process of the Windows MFT turbo mode that runs
//! elevated (W6-1), for one scan, and then exits.
//!
//! `tm-mft-helper <volume> <root> <output file>` reads the master file table
//! of `<volume>` (a drive letter, `C:`) for the scan root `<root>` (a folder
//! on that drive) and writes the root's subtree as a columns file
//! ([`tm_mft::columns`]) to `<output file>`. It exits 0 with the columns
//! written, or 2 with one line on stderr naming the refusal — and, once the
//! output file is its own, the same sentence in that file as a refusal
//! record, because an elevated process's stderr never reaches the app that
//! asked for it.
//!
//! Read-only by construction (W6-2): the volume is opened `GENERIC_READ`
//! (`tm_mft::read_volume`, Windows only), and the only thing this process ever creates
//! or writes is its own output file, which must be named as the app names it
//! and sit directly inside the app's temp folder — this user's
//! `%TEMP%\TreeMap-mft`, resolved by the helper itself, never taken from its
//! arguments. That folder must be a real folder — never a link or junction,
//! which would send the file wherever it points — and is held open while
//! the file is made, so it cannot be swapped for one meanwhile. Every
//! argument is checked, and the output file created (`CREATE_NEW`: never an
//! existing file, never through a link planted at its name), before a
//! single byte of the volume is read ([`run`]).

use std::ffi::OsString;
use std::fmt;
use std::fs::OpenOptions;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub use tm_mft::columns::OUTPUT_EXTENSION;
use tm_mft::columns::{FLAG_ATIME, encode_columns, encode_refusal, is_output_name};
use tm_walk::WalkOutput;

/// The app's temp folder, under the OS temp folder: the one place the
/// helper writes (the app creates it before it asks for the helper).
pub const APP_TEMP_FOLDER: &str = "TreeMap-mft";
/// Exit status: the columns file is written.
pub const EXIT_OK: u8 = 0;
/// Exit status: refused; the sentence is on stderr (and in the output file
/// once it is the helper's own).
pub const EXIT_REFUSED: u8 = 2;

/// The arguments once every check has passed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    /// The drive letter, upper-cased, with its colon: `C:`.
    pub volume: String,
    /// The scan root, as given (a folder on `volume`).
    pub root: PathBuf,
    /// Where the columns go: the app's temp folder, canonical, joined with
    /// the output's own name.
    pub output: PathBuf,
}

/// Why the arguments were refused. Every variant is one line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArgError {
    /// Not exactly three arguments (how many there were).
    Usage {
        /// The count received.
        got: usize,
    },
    /// An argument is not valid Unicode.
    NotUnicode {
        /// Which one.
        which: &'static str,
    },
    /// The volume is not a drive letter with its colon.
    VolumeNotDriveLetter {
        /// What was given.
        volume: String,
    },
    /// The root is not an absolute folder path on that volume.
    RootNotOnVolume {
        /// What was given.
        root: String,
        /// The volume.
        volume: String,
        /// Why not.
        reason: &'static str,
    },
    /// The output's name is not one the app gives.
    OutputName {
        /// What was given.
        output: String,
    },
    /// The output's folder cannot be resolved.
    OutputFolder {
        /// What was given.
        output: String,
        /// The error.
        reason: String,
    },
    /// The output is not directly inside the app's temp folder.
    OutsideTempFolder {
        /// What was given.
        output: String,
        /// The app's temp folder.
        folder: String,
    },
    /// The app's temp folder cannot be resolved.
    TempFolder {
        /// The folder.
        folder: String,
        /// The error.
        reason: String,
    },
}

/// `text` in quotes with every character that can end a line replaced, so a
/// refusal is always one line whatever a path holds: the control characters,
/// and the line and paragraph separators U+2028 and U+2029, which are not
/// control characters yet end a line for any reader that follows Unicode (the
/// pre-landing review of 23 Sep 2026).
fn quoted(text: &str) -> String {
    let clean: String = text
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') {
                '\u{FFFD}'
            } else {
                c
            }
        })
        .collect();
    format!("\"{clean}\"")
}

impl fmt::Display for ArgError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Usage { got } => write!(
                f,
                "usage: tm-mft-helper <volume such as C:> <scan root on that volume> <output file directly inside the app's temp folder>; got {got} arguments"
            ),
            Self::NotUnicode { which } => {
                write!(f, "the {which} argument is not valid Unicode")
            }
            Self::VolumeNotDriveLetter { volume } => write!(
                f,
                "the volume argument {} is not a drive letter such as C:",
                quoted(volume)
            ),
            Self::RootNotOnVolume {
                root,
                volume,
                reason,
            } => write!(
                f,
                "the scan root {} is not a folder on {volume}: {reason}",
                quoted(root)
            ),
            Self::OutputName { output } => write!(
                f,
                "the output file {} is not named as the app names it (letters, digits, '-', '_' and '.', ending in {OUTPUT_EXTENSION})",
                quoted(output)
            ),
            Self::OutputFolder { output, reason } => write!(
                f,
                "the folder of the output file {} cannot be resolved: {}",
                quoted(output),
                quoted(reason)
            ),
            Self::OutsideTempFolder { output, folder } => write!(
                f,
                "the output file {} is not directly inside the app's temp folder {}, the only place the helper writes",
                quoted(output),
                quoted(folder)
            ),
            Self::TempFolder { folder, reason } => write!(
                f,
                "the app's temp folder {} cannot be resolved: {}",
                quoted(folder),
                quoted(reason)
            ),
        }
    }
}

impl std::error::Error for ArgError {}

/// The volume argument as a drive letter: one ASCII letter and a colon,
/// upper-cased (`c:` → `C:`); anything else is refused.
pub fn parse_volume(volume: &str) -> Result<String, ArgError> {
    let mut chars = volume.chars();
    match (chars.next(), chars.next(), chars.next()) {
        (Some(letter), Some(':'), None) if letter.is_ascii_alphabetic() => {
            Ok(format!("{}:", letter.to_ascii_uppercase()))
        }
        _ => Err(ArgError::VolumeNotDriveLetter {
            volume: volume.to_owned(),
        }),
    }
}

/// Refuses a root that is not an absolute folder path on `volume`: it must
/// start with the volume's letter, its colon and a separator (`C:\`), hold
/// no NUL and no `..` component. The reader then refuses a root on a folder
/// mount point or reached through a junction onto another volume (M4), so
/// the volume read is always the one named — the one the user was asked
/// about.
pub fn check_root_on_volume(root: &str, volume: &str) -> Result<(), ArgError> {
    let refuse = |reason: &'static str| ArgError::RootNotOnVolume {
        root: root.to_owned(),
        volume: volume.to_owned(),
        reason,
    };
    if root.contains('\0') {
        return Err(refuse("it holds a NUL character"));
    }
    let mut chars = root.chars();
    let (Some(letter), Some(':'), Some('\\' | '/')) = (chars.next(), chars.next(), chars.next())
    else {
        return Err(refuse(
            "it is not an absolute path that starts with a drive letter",
        ));
    };
    let named = volume.chars().next().map(|c| c.to_ascii_uppercase());
    if !letter.is_ascii_alphabetic() || Some(letter.to_ascii_uppercase()) != named {
        return Err(refuse("it is on another drive"));
    }
    if root.split(['\\', '/']).any(|component| component == "..") {
        return Err(refuse("it holds a '..' component"));
    }
    Ok(())
}

/// The output file, checked: named as the app names it, and in a folder
/// that resolves (every link followed) to the app's temp folder itself —
/// not beside it, not below it. Returns the path to create: the temp
/// folder's canonical path joined with the name.
pub fn check_output(output: &Path, temp_folder: &Path) -> Result<PathBuf, ArgError> {
    let shown = || output.to_string_lossy().into_owned();
    let name = output
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| is_output_name(name))
        .ok_or_else(|| ArgError::OutputName { output: shown() })?;
    // The temp folder itself must be a real folder, never a link or junction:
    // canonicalize follows one, so both sides of the comparison below would
    // resolve to wherever it points, and this elevated process would create
    // its file there — a junction any process of the same user can plant
    // (the security review of M6, 23 Sep 2026). A link further up the path is
    // the user's own layout: redirected, the fence would still have to be a
    // real `TreeMap-mft` folder inside the target, which only whoever can
    // write there could make.
    let unresolved = std::fs::symlink_metadata(temp_folder).map_err(|e| ArgError::TempFolder {
        folder: temp_folder.to_string_lossy().into_owned(),
        reason: e.to_string(),
    })?;
    refuse_unless_real_folder(&unresolved, temp_folder)?;
    let fence = std::fs::canonicalize(temp_folder).map_err(|e| ArgError::TempFolder {
        folder: temp_folder.to_string_lossy().into_owned(),
        reason: e.to_string(),
    })?;
    let folder = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| ArgError::OutputFolder {
            output: shown(),
            reason: "it names no folder".to_owned(),
        })?;
    let folder = std::fs::canonicalize(folder).map_err(|e| ArgError::OutputFolder {
        output: shown(),
        reason: e.to_string(),
    })?;
    if folder != fence {
        return Err(ArgError::OutsideTempFolder {
            output: shown(),
            folder: fence.to_string_lossy().into_owned(),
        });
    }
    Ok(fence.join(name))
}

/// Whether `meta` (from `symlink_metadata`, so not followed) is a link: a
/// symbolic link anywhere, and on Windows any reparse point at all — a
/// junction included, whatever its tag says.
fn is_link_or_reparse_point(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        /// `FILE_ATTRIBUTE_REPARSE_POINT`.
        const REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & REPARSE_POINT != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}

/// Refuses `meta` (of `temp_folder`, not followed) unless it is a real
/// folder: no link, no junction or other reparse point, and a folder.
fn refuse_unless_real_folder(meta: &std::fs::Metadata, temp_folder: &Path) -> Result<(), ArgError> {
    if is_link_or_reparse_point(meta) || !meta.is_dir() {
        return Err(ArgError::TempFolder {
            folder: temp_folder.to_string_lossy().into_owned(),
            reason:
                "it is a link, a junction or not a folder at all, so nothing is written through it"
                    .to_owned(),
        });
    }
    Ok(())
}

/// The app's temp folder, opened and held while the output file is created
/// inside it and found where the check said ([`run`]).
///
/// On Windows the folder is opened as itself (`FILE_FLAG_OPEN_REPARSE_POINT`:
/// a junction at its name is opened as the junction, and refused) and
/// without `FILE_SHARE_DELETE`, so while it is held no process can rename or
/// remove it — and a folder that cannot be moved aside cannot be swapped for
/// a junction between the check and the file's creation, the race the
/// landing check alone could only see once the file was made. Elsewhere,
/// where the helper never runs elevated, nothing is pinned: holding is the
/// same refusal of a link, unheld.
#[derive(Debug)]
pub struct HeldFolder {
    #[cfg(windows)]
    _handle: std::fs::File,
}

/// Opens and holds `temp_folder` ([`HeldFolder`]), refusing a link, a
/// junction or any other reparse point, and anything that is not a folder.
pub fn hold_temp_folder(temp_folder: &Path) -> Result<HeldFolder, ArgError> {
    let refuse = |e: std::io::Error| ArgError::TempFolder {
        folder: temp_folder.to_string_lossy().into_owned(),
        reason: e.to_string(),
    };
    #[cfg(windows)]
    let (meta, held) = {
        use std::os::windows::fs::OpenOptionsExt;
        /// `FILE_READ_ATTRIBUTES`: enough to read what the folder is.
        const READ_ATTRIBUTES: u32 = 0x80;
        /// `FILE_SHARE_READ | FILE_SHARE_WRITE`, and not `FILE_SHARE_DELETE`.
        const SHARE_ALL_BUT_DELETE: u32 = 0x1 | 0x2;
        /// `FILE_FLAG_BACKUP_SEMANTICS` (so a folder can be opened) and
        /// `FILE_FLAG_OPEN_REPARSE_POINT` (the name itself, not where it leads).
        const THE_FOLDER_ITSELF: u32 = 0x0200_0000 | 0x0020_0000;
        let handle = OpenOptions::new()
            .access_mode(READ_ATTRIBUTES)
            .share_mode(SHARE_ALL_BUT_DELETE)
            .custom_flags(THE_FOLDER_ITSELF)
            .open(temp_folder)
            .map_err(refuse)?;
        let meta = handle.metadata().map_err(refuse)?;
        (meta, HeldFolder { _handle: handle })
    };
    #[cfg(not(windows))]
    let (meta, held) = (
        std::fs::symlink_metadata(temp_folder).map_err(refuse)?,
        HeldFolder {},
    );
    refuse_unless_real_folder(&meta, temp_folder)?;
    Ok(held)
}

/// This user's app temp folder: the OS temp folder's [`APP_TEMP_FOLDER`].
pub fn app_temp_folder() -> PathBuf {
    std::env::temp_dir().join(APP_TEMP_FOLDER)
}

fn text<'a>(arg: &'a OsString, which: &'static str) -> Result<&'a str, ArgError> {
    arg.to_str().ok_or(ArgError::NotUnicode { which })
}

/// The three arguments, each checked: the volume, the root on it, the
/// output inside `temp_folder`.
pub fn validate(args: &[OsString], temp_folder: &Path) -> Result<Request, ArgError> {
    let [volume, root, output] = args else {
        return Err(ArgError::Usage { got: args.len() });
    };
    let volume = parse_volume(text(volume, "volume")?)?;
    let root = text(root, "root")?;
    check_root_on_volume(root, &volume)?;
    let output = check_output(Path::new(text(output, "output")?), temp_folder)?;
    Ok(Request {
        volume,
        root: PathBuf::from(root),
        output,
    })
}

/// How a run ended: the exit status and the line for stderr.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    /// [`EXIT_OK`] or [`EXIT_REFUSED`].
    pub code: u8,
    /// The refusal, one line; `None` on success.
    pub message: Option<String>,
}

fn refused(message: String) -> Outcome {
    Outcome {
        code: EXIT_REFUSED,
        message: Some(message),
    }
}

/// Writes `sentence` into `file` as a refusal record, over whatever the file
/// held: the one channel the elevated helper has to the app that asked for it,
/// whose stderr never arrives. Through the handle the helper already holds,
/// never by path — once something has gone wrong, a path may lead somewhere
/// else. Best effort: a file that cannot take even this leaves the app its
/// own reason (a file too short to read), and the app removes the output
/// either way (the Rust review of M6).
pub fn record_refusal(file: &mut std::fs::File, sentence: &str) {
    let record = encode_refusal(sentence);
    let _ = file
        .set_len(0)
        .and_then(|()| file.seek(SeekFrom::Start(0)))
        .and_then(|_| file.write_all(&record))
        .and_then(|()| file.flush());
}

/// Creates the output file for a [`validate`]d `request`, new, with the
/// app's temp folder held ([`HeldFolder`]) from before the file is made until
/// it is found where the check said — the second half of [`run`], public so a
/// test can move a folder between the check and the creation. The sentence of
/// a refusal otherwise.
pub fn create_output(request: &Request, temp_folder: &Path) -> Result<std::fs::File, String> {
    let shown = request.output.to_string_lossy().into_owned();
    let _held = hold_temp_folder(temp_folder).map_err(|e| e.to_string())?;
    // Resolved again now that the folder is held. The hold pins the folder
    // itself, but a folder above it swapped for a junction between the check
    // and the hold would have moved where the checked path leads (the second
    // security review of M6). From the hold on, nothing above it can move:
    // Windows refuses to rename or remove a folder with an open handle inside
    // it. So a path that still resolves to where it did is the one the file
    // is created through.
    let fence_now = std::fs::canonicalize(temp_folder).map_err(|e| {
        format!(
            "the app's temp folder {} cannot be resolved once held: {e}",
            quoted(&temp_folder.to_string_lossy())
        )
    })?;
    if request.output.parent() != Some(fence_now.as_path()) {
        return Err(format!(
            "the app's temp folder {} now leads to {}, not where it led when the arguments were checked; nothing was created",
            quoted(&temp_folder.to_string_lossy()),
            quoted(&fence_now.to_string_lossy())
        ));
    }
    // CREATE_NEW / O_EXCL: an existing file, or a link planted at the name,
    // is refused rather than written through.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&request.output)
        .map_err(|e| {
            format!(
                "the output file {} could not be created: {e}",
                quoted(&shown)
            )
        })?;
    // The folder was checked a moment ago and has been held since; make sure
    // the file is where the check said all the same. From here the file
    // exists, so a refusal is recorded in it: the app learns why rather than
    // finding a file too short to read.
    let Some(refusal) = landing_refusal(&request.output, std::fs::canonicalize(&request.output))
    else {
        return Ok(file);
    };
    record_refusal(&mut file, &refusal);
    Err(refusal)
}

/// Where the output file was found once created, judged against `output`,
/// where the check said it would be: `None` when it is exactly there, and the
/// sentence of the refusal otherwise — found somewhere else, or not found at
/// all. The last step of [`create_output`], kept apart from the file system
/// and public so a test can reach every arm: with the folder held from the
/// check on, only a race no test can stage makes a file land elsewhere (the
/// pre-landing review of 23 Sep 2026).
pub fn landing_refusal(output: &Path, landed: std::io::Result<PathBuf>) -> Option<String> {
    let shown = output.to_string_lossy();
    match landed {
        Ok(landed) if landed == output => None,
        Ok(landed) => Some(format!(
            "the output file landed at {}, not at {}; nothing was read",
            quoted(&landed.to_string_lossy()),
            quoted(&shown)
        )),
        Err(e) => Some(format!(
            "the output file {} could not be found after it was created: {e}",
            quoted(&shown)
        )),
    }
}

/// The whole run, in the order W6-2 needs: validate every argument; create
/// the output file (new, never an existing one) with the temp folder held,
/// and check where it landed;
/// only then `read` the volume; write the columns — or the refusal, so the
/// app learns why. A refused argument never reaches `read` and writes
/// nothing anywhere.
pub fn run(
    args: &[OsString],
    temp_folder: &Path,
    read: impl FnOnce(&Request) -> Result<WalkOutput, String>,
) -> Outcome {
    let request = match validate(args, temp_folder) {
        Ok(request) => request,
        Err(e) => return refused(e.to_string()),
    };
    let shown = request.output.to_string_lossy().into_owned();
    let mut file = match create_output(&request, temp_folder) {
        Ok(file) => file,
        Err(sentence) => return refused(sentence),
    };
    let (bytes, outcome) = match read(&request) {
        Ok(out) => match encode_columns(&out, FLAG_ATIME) {
            Ok(bytes) => (
                bytes,
                Outcome {
                    code: EXIT_OK,
                    message: None,
                },
            ),
            Err(e) => {
                let sentence = format!("the tree could not be written as columns: {e}");
                (encode_refusal(&sentence), refused(sentence))
            }
        },
        Err(sentence) => (encode_refusal(&sentence), refused(sentence)),
    };
    if let Err(e) = file.write_all(&bytes).and_then(|()| file.flush()) {
        let sentence = format!(
            "the output file {} could not be written: {e}",
            quoted(&shown)
        );
        // Over the half-written columns, so the app reads why, not garbage.
        record_refusal(&mut file, &sentence);
        return refused(sentence);
    }
    outcome
}

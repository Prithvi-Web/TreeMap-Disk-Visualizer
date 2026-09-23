//! The Win32 boundary of the volume reader: from a scan root to an open,
//! checked volume and the facts [`crate::volume::read_mft`] needs.
//!
//! [`read_volume_with`] is the whole sequence, portable and tested on every
//! platform through a scripted [`VolumeApi`]: the root must be absolute; its
//! volume (`GetVolumePathNameW`) a drive letter's root, local
//! (`GetDriveTypeW`) and NTFS by the exact name `GetVolumeInformationW`
//! reports (W6-3); the root itself (`GetFileInformationByHandle` on the root,
//! opened as itself) on that very volume — a junction or a symbolic link to
//! another volume would name a record of the wrong table. Only then is the
//! volume opened, read-only (W6-2) and unbuffered, and nothing is read before
//! `FSCTL_GET_NTFS_VOLUME_DATA` has answered. Every answer's check is a
//! function here ([`device_path`], [`check_drive_type`],
//! [`check_file_system`], [`check_same_volume`], [`open_error`]...).
//!
//! The `cfg(windows)` layer is the `os` module: one [`VolumeApi`] method per
//! call, and [`crate::volume::Volume::read_at`] as one positional read into a
//! sector-aligned buffer. The volume and the root are opened through
//! `std::fs::OpenOptions`, so the only `unsafe` blocks are the five calls
//! the standard library does not make.

use std::path::Path;
use std::time::Instant;

use tm_walk::WalkOutput;
use tm_walk::platform::thread_cpu_seconds;
use tm_walk::platform::windows::{ERROR_ACCESS_DENIED, has_embedded_nul};

use crate::volume::{Geometry, MftError, Volume, VolumeFacts, read_mft_timed};

/// The file-system name `GetVolumeInformationW` must report.
pub const NTFS_NAME: &str = "NTFS";
/// The alignment of the buffer every volume read lands in: a read that
/// bypasses the cache needs a sector-aligned address, and 4,096 covers both
/// sector sizes Windows formats volumes with (512 and 4,096).
pub const IO_ALIGN: usize = 4096;
/// `GetDriveTypeW`: the type cannot be determined.
pub const DRIVE_UNKNOWN: u32 = 0;
/// `GetDriveTypeW`: no volume is mounted at the path.
pub const DRIVE_NO_ROOT_DIR: u32 = 1;
/// `GetDriveTypeW`: a network drive.
pub const DRIVE_REMOTE: u32 = 4;

/// What `GetVolumeInformationW` reports about a volume root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VolumeInformation {
    /// The file system's name: `NTFS`, `ReFS`, `FAT32`, `exFAT`...
    pub file_system: String,
    /// The volume serial number.
    pub serial: u32,
}

/// What `GetFileInformationByHandle` reports about the root, opened as itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RootIdentity {
    /// The serial number of the volume the root is on.
    pub volume_serial: u32,
    /// The root's file reference: `nFileIndexHigh:nFileIndexLow`, its
    /// sequence number over its record number.
    pub file_reference: u64,
}

/// An opened volume: its reader, and what `FSCTL_GET_NTFS_VOLUME_DATA`
/// returned on it.
pub struct OpenedVolume {
    /// Reads the volume.
    pub reader: Box<dyn Volume>,
    /// The `NTFS_VOLUME_DATA_BUFFER`, as the bytes the call returned.
    pub volume_data: Vec<u8>,
}

/// The Windows calls [`read_volume_with`] makes, one method per call: the
/// Windows build implements them (`os`), and the tests script them.
pub trait VolumeApi {
    /// `GetVolumePathNameW`: the root of the volume `root` is on, as `C:\`.
    fn volume_path_name(&self, root: &Path) -> Result<String, MftError>;
    /// `GetDriveTypeW` on a volume root.
    fn drive_type(&self, volume: &str) -> u32;
    /// `GetVolumeInformationW` on a volume root.
    fn volume_information(&self, volume: &str) -> Result<VolumeInformation, MftError>;
    /// `GetFileInformationByHandle` on the root, opened as itself (a final
    /// reparse point is not followed).
    fn root_identity(&self, root: &Path) -> Result<RootIdentity, MftError>;
    /// Opens `device` (`\\.\X:`) for reading and nothing else —
    /// `GENERIC_READ`, sharing reads and writes, `OPEN_EXISTING`, unbuffered
    /// (`FILE_FLAG_NO_BUFFERING`) — and asks it
    /// `FSCTL_GET_NTFS_VOLUME_DATA`. `volume` names it in a refusal.
    fn open_volume(&self, device: &str, volume: &str) -> Result<OpenedVolume, MftError>;
}

/// Refuses a root the reader cannot place: one holding a NUL (every Win32
/// call would stop reading there and use what came before), or a relative
/// one (`GetVolumePathNameW` answers a relative path with the boot volume,
/// whatever the current directory's).
pub fn check_root(root: &Path) -> Result<(), MftError> {
    if has_embedded_nul(&root.to_string_lossy()) {
        return Err(MftError::BadRoot {
            reason: "holds a NUL character",
        });
    }
    if !root.is_absolute() {
        return Err(MftError::BadRoot {
            reason: "is not an absolute path",
        });
    }
    Ok(())
}

/// The root's name as the listing walk records it: the path's last
/// component, or the whole path when it has none (`C:\`).
pub fn root_name(root: &Path) -> String {
    root.file_name()
        .unwrap_or(root.as_os_str())
        .to_string_lossy()
        .into_owned()
}

/// The device path to open for the volume root `GetVolumePathNameW`
/// returned: `\\.\X:` for `X:\` (or `\\?\X:\`), the letter upper-cased.
/// Anything else — a volume mounted in a folder, a network share, a volume
/// GUID path — has no drive letter to open and is refused.
pub fn device_path(volume: &str) -> Result<String, MftError> {
    let bare = volume.strip_prefix("\\\\?\\").unwrap_or(volume);
    let mut chars = bare.chars();
    match (chars.next(), chars.next(), chars.next(), chars.next()) {
        (Some(letter), Some(':'), Some('\\'), None) if letter.is_ascii_alphabetic() => {
            Ok(format!("\\\\.\\{}:", letter.to_ascii_uppercase()))
        }
        _ => Err(MftError::NoDriveLetter {
            volume: volume.to_owned(),
        }),
    }
}

/// Refuses the drive types whose volume cannot be read here: a network drive
/// (its table is on another machine), and a path Windows finds no volume at
/// or cannot type.
pub fn check_drive_type(drive_type: u32, volume: &str) -> Result<(), MftError> {
    match drive_type {
        DRIVE_REMOTE => Err(MftError::NetworkVolume {
            volume: volume.to_owned(),
        }),
        DRIVE_UNKNOWN | DRIVE_NO_ROOT_DIR => Err(MftError::NoVolume {
            volume: volume.to_owned(),
        }),
        _ => Ok(()),
    }
}

/// Refuses every file system but NTFS, by the exact name
/// `GetVolumeInformationW` reports (W6-3).
pub fn check_file_system(file_system: &str, volume: &str) -> Result<(), MftError> {
    if file_system == NTFS_NAME {
        return Ok(());
    }
    Err(MftError::NotNtfs {
        volume: volume.to_owned(),
        file_system: file_system.to_owned(),
    })
}

/// Refuses a root whose own volume serial number is not the one of the
/// volume its path names.
pub fn check_same_volume(root_serial: u32, volume_serial: u32) -> Result<(), MftError> {
    if root_serial == volume_serial {
        return Ok(());
    }
    Err(MftError::OtherVolume {
        root_serial,
        volume_serial,
    })
}

/// A file reference from `BY_HANDLE_FILE_INFORMATION`'s `nFileIndexHigh`
/// and `nFileIndexLow`.
pub fn file_reference(index_high: u32, index_low: u32) -> u64 {
    (u64::from(index_high) << 32) | u64::from(index_low)
}

/// The text before the first NUL of a buffer a Win32 call filled (all of it
/// when there is none), a lone surrogate as U+FFFD.
pub fn text_until_nul(units: &[u16]) -> String {
    let end = units.iter().position(|u| *u == 0).unwrap_or(units.len());
    String::from_utf16_lossy(units.get(..end).unwrap_or(units))
}

/// The error for a volume `CreateFileW` would not open with `code`:
/// `ERROR_ACCESS_DENIED` is what an unelevated process is told
/// ([`MftError::NotElevated`]); any other code is reported as itself.
pub fn open_error(code: u32, volume: &str) -> MftError {
    if code == ERROR_ACCESS_DENIED {
        return MftError::NotElevated {
            volume: volume.to_owned(),
        };
    }
    MftError::Os {
        call: "CreateFileW on the volume",
        code,
    }
}

/// A `len`-byte window of `raw` that starts at an address that is a
/// multiple of `align`, `raw` grown as needed and reused from one read to
/// the next; `None` when `align` is 0 or the sizes overflow.
pub fn aligned_window(raw: &mut Vec<u8>, len: usize, align: usize) -> Option<&mut [u8]> {
    if align == 0 {
        return None;
    }
    let need = len.checked_add(align)?;
    if raw.len() < need {
        raw.resize(need, 0);
    }
    let start = (align - raw.as_ptr().addr() % align) % align;
    raw.get_mut(start..start.checked_add(len)?)
}

/// The scan root's subtree from its volume's master file table, through
/// `api`: every check in the module docs' order, then
/// [`crate::volume::read_mft`]. The stats' times run from the first call.
pub fn read_volume_with(
    api: &dyn VolumeApi,
    root: &Path,
    want_atime: bool,
) -> Result<WalkOutput, MftError> {
    let started = Instant::now();
    let cpu_started = thread_cpu_seconds();
    check_root(root)?;
    let volume = api.volume_path_name(root)?;
    let device = device_path(&volume)?;
    check_drive_type(api.drive_type(&volume), &volume)?;
    let information = api.volume_information(&volume)?;
    check_file_system(&information.file_system, &volume)?;
    let identity = api.root_identity(root)?;
    check_same_volume(identity.volume_serial, information.serial)?;
    let mut opened = api.open_volume(&device, &volume)?;
    let facts = VolumeFacts {
        geometry: Geometry::from_volume_data(&opened.volume_data)?,
        serial: identity.volume_serial,
        root_reference: identity.file_reference,
        root_name: root_name(root),
    };
    read_mft_timed(
        opened.reader.as_mut(),
        &facts,
        want_atime,
        started,
        cpu_started,
    )
}

#[cfg(windows)]
const _: () = {
    use windows_sys::Win32::Foundation::MAX_PATH;
    use windows_sys::Win32::System::Ioctl::NTFS_VOLUME_DATA_BUFFER;
    use windows_sys::Win32::System::WindowsProgramming as wp;

    use crate::volume::{
        VD_BYTES_PER_CLUSTER, VD_BYTES_PER_RECORD, VD_MFT_START_LCN, VD_MFT_VALID_DATA_LENGTH,
        VOLUME_DATA_BYTES,
    };
    assert!(DRIVE_UNKNOWN == wp::DRIVE_UNKNOWN);
    assert!(DRIVE_NO_ROOT_DIR == wp::DRIVE_NO_ROOT_DIR);
    assert!(DRIVE_REMOTE == wp::DRIVE_REMOTE);
    assert!(MAX_PATH == 260);
    assert!(VOLUME_DATA_BYTES == std::mem::size_of::<NTFS_VOLUME_DATA_BUFFER>());
    assert!(VD_BYTES_PER_CLUSTER == std::mem::offset_of!(NTFS_VOLUME_DATA_BUFFER, BytesPerCluster));
    assert!(
        VD_BYTES_PER_RECORD
            == std::mem::offset_of!(NTFS_VOLUME_DATA_BUFFER, BytesPerFileRecordSegment)
    );
    assert!(
        VD_MFT_VALID_DATA_LENGTH
            == std::mem::offset_of!(NTFS_VOLUME_DATA_BUFFER, MftValidDataLength)
    );
    assert!(VD_MFT_START_LCN == std::mem::offset_of!(NTFS_VOLUME_DATA_BUFFER, MftStartLcn));
};

#[cfg(windows)]
mod os {
    use std::ffi::{OsString, c_void};
    use std::fs::{File, OpenOptions};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::os::windows::fs::{FileExt, OpenOptionsExt};
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};
    use std::ptr;

    use tm_walk::WalkOutput;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_NO_BUFFERING,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, GetDriveTypeW, GetFileInformationByHandle, GetVolumeInformationW,
        GetVolumePathNameW,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;
    use windows_sys::Win32::System::Ioctl::FSCTL_GET_NTFS_VOLUME_DATA;
    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

    use super::{
        IO_ALIGN, OpenedVolume, RootIdentity, VolumeApi, VolumeInformation, aligned_window,
        file_reference, open_error, read_volume_with, text_until_nul,
    };
    use crate::volume::{MftError, VOLUME_DATA_BYTES, Volume};

    /// The longest path Windows takes, in UTF-16 units with its NUL: the
    /// most `GetVolumePathNameW` can return.
    const LONG_PATH_UNITS: usize = 32_768;
    /// `MAX_PATH + 1`: the largest file-system name `GetVolumeInformationW`
    /// returns, with its NUL (checked against `MAX_PATH` at compile time).
    const FILE_SYSTEM_NAME_UNITS: usize = 261;

    /// The Windows calls.
    struct WindowsApi;

    /// `path` as a NUL-terminated UTF-16 string. `check_root` has refused a
    /// path holding a NUL, so the string is the whole path.
    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// `text` as a NUL-terminated UTF-16 string; `text` is a volume path a
    /// call returned, cut at its first NUL, so it holds none.
    fn wide_text(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn len_u32<T>(buf: &[T]) -> u32 {
        u32::try_from(buf.len()).unwrap_or(u32::MAX)
    }

    /// `error` as the reader reports it: its Windows code when it has one.
    fn io_error(call: &'static str, error: &std::io::Error) -> MftError {
        match error
            .raw_os_error()
            .and_then(|code| u32::try_from(code).ok())
        {
            Some(code) => MftError::Os { call, code },
            None => MftError::Io {
                call,
                message: error.to_string(),
            },
        }
    }

    /// The calling thread's last Windows error, as `call`'s.
    fn last_error(call: &'static str) -> MftError {
        io_error(call, &std::io::Error::last_os_error())
    }

    impl VolumeApi for WindowsApi {
        fn volume_path_name(&self, root: &Path) -> Result<String, MftError> {
            let name = wide_path(root);
            let mut out = vec![0_u16; LONG_PATH_UNITS];
            // SAFETY: `name` is NUL-terminated and outlives the call, which
            // only reads it; the output pointer and length describe `out`,
            // writable for its whole length.
            let ok = unsafe { GetVolumePathNameW(name.as_ptr(), out.as_mut_ptr(), len_u32(&out)) };
            if ok == 0 {
                return Err(last_error("GetVolumePathNameW"));
            }
            Ok(text_until_nul(&out))
        }

        fn drive_type(&self, volume: &str) -> u32 {
            let name = wide_text(volume);
            // SAFETY: `name` is NUL-terminated and outlives the call, which
            // only reads it.
            unsafe { GetDriveTypeW(name.as_ptr()) }
        }

        fn volume_information(&self, volume: &str) -> Result<VolumeInformation, MftError> {
            let name = wide_text(volume);
            let mut file_system = vec![0_u16; FILE_SYSTEM_NAME_UNITS];
            let mut serial = 0_u32;
            // SAFETY: `name` is NUL-terminated and outlives the call, which
            // only reads it; the volume name, the component length and the
            // flags are optional outputs, declined with null pointers (and a
            // 0 size for the name); `serial` is a live u32 owned by this
            // frame; the file-system-name pointer and length describe
            // `file_system`, writable for its whole length.
            let ok = unsafe {
                GetVolumeInformationW(
                    name.as_ptr(),
                    ptr::null_mut(),
                    0,
                    &raw mut serial,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    file_system.as_mut_ptr(),
                    len_u32(&file_system),
                )
            };
            if ok == 0 {
                return Err(last_error("GetVolumeInformationW"));
            }
            Ok(VolumeInformation {
                file_system: text_until_nul(&file_system),
                serial,
            })
        }

        fn root_identity(&self, root: &Path) -> Result<RootIdentity, MftError> {
            // The root itself, never through a final reparse point: its own
            // record is the one the table is searched for.
            let file = OpenOptions::new()
                .access_mode(FILE_READ_ATTRIBUTES)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(root)
                .map_err(|e| io_error("CreateFileW on the scan root", &e))?;
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            // SAFETY: `file` is open for the whole call (it is borrowed, so
            // it cannot be closed meanwhile); `info` is a writable
            // BY_HANDLE_FILE_INFORMATION owned by this frame, the structure
            // the call fills.
            let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &raw mut info) };
            if ok == 0 {
                return Err(last_error("GetFileInformationByHandle"));
            }
            Ok(RootIdentity {
                volume_serial: info.dwVolumeSerialNumber,
                file_reference: file_reference(info.nFileIndexHigh, info.nFileIndexLow),
            })
        }

        fn open_volume(&self, device: &str, volume: &str) -> Result<OpenedVolume, MftError> {
            // Read-only by construction (W6-2): GENERIC_READ and nothing
            // else, sharing reads and writes, OPEN_EXISTING (the default
            // when nothing is created or truncated). Unbuffered by
            // construction too: Microsoft says to assume a volume handle is
            // opened uncached anyway, at the file system's discretion; the
            // flag makes it certain, so a whole-table read never passes
            // through (or evicts) the cache, and every read already meets
            // the alignment an uncached read needs (whole clusters from a
            // cluster boundary, into a 4,096-aligned buffer).
            let file = OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_NO_BUFFERING)
                .open(device)
                .map_err(
                    |e| match e.raw_os_error().and_then(|c| u32::try_from(c).ok()) {
                        Some(code) => open_error(code, volume),
                        None => io_error("CreateFileW on the volume", &e),
                    },
                )?;
            let volume_data = ntfs_volume_data(&file)?;
            Ok(OpenedVolume {
                reader: Box::new(WindowsVolume {
                    file,
                    bounce: Vec::new(),
                }),
                volume_data,
            })
        }
    }

    /// `FSCTL_GET_NTFS_VOLUME_DATA` on the open volume: exactly the bytes it
    /// returned.
    fn ntfs_volume_data(file: &File) -> Result<Vec<u8>, MftError> {
        let mut buf = vec![0_u8; VOLUME_DATA_BYTES];
        let mut returned = 0_u32;
        // SAFETY: `file` is an open volume handle for the whole call (it is
        // borrowed, so it cannot be closed meanwhile); no input buffer is
        // passed; the output pointer and length describe `buf`, writable for
        // its whole length; `returned` is a live u32 owned by this frame; the
        // handle was not opened for overlapped I/O, so none is passed.
        let ok = unsafe {
            DeviceIoControl(
                file.as_raw_handle(),
                FSCTL_GET_NTFS_VOLUME_DATA,
                ptr::null(),
                0,
                buf.as_mut_ptr().cast::<c_void>(),
                len_u32(&buf),
                &raw mut returned,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(last_error("FSCTL_GET_NTFS_VOLUME_DATA"));
        }
        buf.truncate(usize::try_from(returned).unwrap_or(0));
        Ok(buf)
    }

    /// The opened volume, read by one positional `ReadFile` per read into a
    /// sector-aligned buffer (`std`'s `seek_read`), then copied out.
    struct WindowsVolume {
        file: File,
        bounce: Vec<u8>,
    }

    impl Volume for WindowsVolume {
        fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<(), MftError> {
            let wanted = buf.len();
            let window =
                aligned_window(&mut self.bounce, wanted, IO_ALIGN).ok_or(MftError::Overflow)?;
            let got = self
                .file
                .seek_read(window, offset)
                .map_err(|e| io_error("ReadFile on the volume", &e))?;
            // A read that bypasses the cache is whole or it failed; a short
            // one is the volume's end, and continuing from a misaligned
            // position would fail anyway.
            if got != wanted {
                return Err(MftError::ShortRead {
                    offset,
                    wanted: u64::try_from(wanted).unwrap_or(u64::MAX),
                    got: u64::try_from(got).unwrap_or(u64::MAX),
                });
            }
            buf.copy_from_slice(window);
            Ok(())
        }
    }

    /// The scan root's subtree, read from its volume's master file table:
    /// [`read_volume_with`] through the Windows calls. Needs an elevated
    /// process; without one it is [`MftError::NotElevated`].
    pub fn read_volume(root: &Path, want_atime: bool) -> Result<WalkOutput, MftError> {
        read_volume_with(&WindowsApi, root, want_atime)
    }

    /// Windows' system folder as the kernel reports it (`GetSystemDirectoryW`),
    /// or `None` if it does not answer. The app starts PowerShell from it by
    /// its full path: never by a name, which Windows would look up in the
    /// app's own folder first, and never from `SystemRoot` or `windir`, which
    /// a program running as the user can shadow in `HKCU\Environment` (the
    /// third security review of M6).
    pub fn system_directory() -> Option<PathBuf> {
        let mut units = vec![0_u16; LONG_PATH_UNITS];
        // SAFETY: `units` is writable for `len_u32(&units)` UTF-16 units; the
        // call writes at most that many, its NUL included, and returns how
        // many it wrote without the NUL — or, for a buffer too small, the
        // size it needs, and 0 on failure — so a return below the length is
        // the written prefix.
        let written = unsafe { GetSystemDirectoryW(units.as_mut_ptr(), len_u32(&units)) };
        let written = usize::try_from(written).ok()?;
        if written == 0 || written >= units.len() {
            return None;
        }
        units.truncate(written);
        Some(PathBuf::from(OsString::from_wide(&units)))
    }
}

#[cfg(windows)]
pub use os::{read_volume, system_directory};

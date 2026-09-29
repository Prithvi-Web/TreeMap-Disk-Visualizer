//! Windows: the folder held open and checked through its handle, and each file made in it
//! with `CreateFileW`, `FILE_FLAG_DELETE_ON_CLOSE` and `FILE_SHARE_DELETE`, all through
//! `std::fs::OpenOptions`. The name lasts while the file is open; Windows removes it with the
//! last handle, when the process ends too. std's handles are not inheritable, so no child
//! process can hold one.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::ptr;

use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TEMPORARY, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_DELETE_ON_CLOSE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, GetDiskFreeSpaceExW, GetDriveTypeW, GetVolumePathNameW,
};

use super::SpillError;
use super::plan::{FileSystem, VolumeFacts, VolumeId};

/// The longest path Windows takes, in UTF-16 units with its NUL: the most
/// `GetVolumePathNameW` can return.
const LONG_PATH_UNITS: usize = 32_768;

/// The folder, held open for as long as spill files are made in it. Its handle does not share
/// deletion, so no process can rename the folder, remove it, or put a junction in its place
/// meanwhile: Windows makes files by path, and the path must keep leading here.
pub(super) struct Dir {
    _held: File,
}

/// `path`, made if absent and held open, and refused if it is a reparse point (a symbolic
/// link, a junction or anything else that could send its files elsewhere) or not a folder.
/// The checks read the held handle itself, never the path again.
pub(super) fn open_dir(path: &Path) -> Result<Dir, SpillError> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(SpillError::io(path, "CreateDirectoryW", e)),
    }
    // A folder opens only with backup semantics; a reparse point is opened as itself.
    let held = OpenOptions::new()
        .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|e| SpillError::io(path, "CreateFileW", e))?;
    let meta = held
        .metadata()
        .map_err(|e| SpillError::io(path, "GetFileInformationByHandle", e))?;
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(SpillError::refused(
            path,
            "it is a link: a symbolic link, a junction or another reparse point",
        ));
    }
    if !meta.is_dir() {
        return Err(SpillError::refused(path, "it is not a folder"));
    }
    Ok(Dir { _held: held })
}

/// A new spill file named `name` in `dir_path`, removed by Windows when it closes. Made
/// only if nothing has the name (`CREATE_NEW`, which opens no existing file or link). It
/// takes `DELETE` access, which delete-on-close needs, and shares only deletion, so no
/// other process can open it to read or write.
pub(super) fn create(_dir: &Dir, dir_path: &Path, name: &str) -> Result<File, SpillError> {
    let path = dir_path.join(name);
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE)
        .share_mode(FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_DELETE_ON_CLOSE)
        .attributes(FILE_ATTRIBUTE_TEMPORARY)
        .open(&path)
        .map_err(|e| {
            if e.kind() == io::ErrorKind::AlreadyExists {
                SpillError::NameTaken {
                    dir: dir_path.to_owned(),
                    name: name.to_owned(),
                }
            } else {
                SpillError::io(&path, "CreateFileW", e)
            }
        })
}

/// The facts of the volume holding `path`: `GetVolumePathNameW` finds its root (the volume's
/// id, lower-cased), `GetDiskFreeSpaceExW` its bytes free to this user and its size, and
/// `GetDriveTypeW` whether it is a network drive.
pub(super) fn volume_facts(path: &Path) -> io::Result<VolumeFacts> {
    let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        // Every call would stop reading at the NUL and answer for the path before it.
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the path holds a NUL",
        ));
    }
    let wide: Vec<u16> = wide.into_iter().chain(std::iter::once(0)).collect();
    let mut root = vec![0_u16; LONG_PATH_UNITS];
    let room = u32::try_from(root.len()).unwrap_or(u32::MAX);
    // SAFETY: `wide` is NUL-terminated and outlives the call, which only reads it; the
    // output pointer and length describe `root`, writable for its whole length.
    if unsafe { GetVolumePathNameW(wide.as_ptr(), root.as_mut_ptr(), room) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let root: Vec<u16> = root.into_iter().take_while(|&unit| unit != 0).collect();
    let root_wide: Vec<u16> = root.iter().copied().chain(std::iter::once(0)).collect();
    let (mut free, mut total) = (0_u64, 0_u64);
    // SAFETY: `wide` is NUL-terminated and outlives the call; `free` and `total` are live
    // u64s the call writes; the volume's total free bytes are declined with a null pointer.
    let answered = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &raw mut free,
            &raw mut total,
            ptr::null_mut(),
        )
    };
    if answered == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `root_wide` is NUL-terminated and outlives the call, which only reads it.
    let drive_type = unsafe { GetDriveTypeW(root_wide.as_ptr()) };
    Ok(VolumeFacts {
        free_bytes: free,
        total_bytes: total,
        file_system: FileSystem::DriveType(drive_type),
        volume: VolumeId(String::from_utf16_lossy(&root).to_lowercase()),
    })
}

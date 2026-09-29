//! Windows: the folder checked by path, and each file made with `CreateFileW`,
//! `FILE_FLAG_DELETE_ON_CLOSE` and `FILE_SHARE_DELETE`, through `std::fs::OpenOptions`, so
//! no `unsafe` is needed. The name lasts while the file is open; Windows removes it with
//! the last handle, when the process ends too. std's handles are not inheritable, so no
//! child process can hold one.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TEMPORARY, FILE_FLAG_DELETE_ON_CLOSE,
    FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_DELETE,
};

use super::SpillError;

/// The folder: Windows makes files by path, so nothing is held.
pub(super) struct Dir;

/// `path`, made if absent, and refused if it is a reparse point (a symbolic link, a
/// junction or anything else that could send its files elsewhere) or not a folder.
pub(super) fn open_dir(path: &Path) -> Result<Dir, SpillError> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(SpillError::io(path, "CreateDirectoryW", e)),
    }
    let meta =
        fs::symlink_metadata(path).map_err(|e| SpillError::io(path, "GetFileAttributesExW", e))?;
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(SpillError::refused(
            path,
            "it is a link: a symbolic link, a junction or another reparse point",
        ));
    }
    if !meta.is_dir() {
        return Err(SpillError::refused(path, "it is not a folder"));
    }
    Ok(Dir)
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

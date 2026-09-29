//! POSIX: the folder held open (`O_DIRECTORY | O_NOFOLLOW`), and every file made, checked
//! and unnamed relative to that descriptor (`openat`, `fstatat`, `unlinkat`), so a folder
//! swapped for a link once it was checked cannot send a file, or a removal, anywhere else.

use std::ffi::{CStr, CString};
use std::fs::{DirBuilder, File, OpenOptions, Permissions};
use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

use super::SpillError;
use super::plan::{FileSystem, VolumeFacts, VolumeId};

/// A spill file's permissions: this user's alone.
const FILE_MODE: libc::c_uint = 0o600;
/// The folder's.
const DIR_MODE: u32 = 0o700;

/// The folder, open: every file is made relative to it.
pub(super) struct Dir {
    file: File,
}

/// `path`, made if absent and held open, for the user this process runs as.
pub(super) fn open_dir(path: &Path) -> Result<Dir, SpillError> {
    // SAFETY: `geteuid` takes no arguments, touches no memory and cannot fail.
    let euid = unsafe { libc::geteuid() };
    open_dir_as(path, euid)
}

/// [`open_dir`] for the user `euid`: the tests pass another user to see the folder refused.
pub(super) fn open_dir_as(path: &Path, euid: libc::uid_t) -> Result<Dir, SpillError> {
    // 0700 is asked for; the umask can only take bits away, and the check below restores
    // them.
    match DirBuilder::new().mode(DIR_MODE).create(path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(SpillError::io(path, "mkdir", e)),
    }
    // The folder itself, never through a final link: `O_NOFOLLOW` refuses a symbolic link
    // (`ELOOP`) and `O_DIRECTORY` anything that is not a folder (`ENOTDIR`).
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| match e.raw_os_error() {
            Some(libc::ELOOP | libc::ENOTDIR) => SpillError::refused(path, what_is_there(path)),
            _ => SpillError::io(path, "open", e),
        })?;
    let meta = file
        .metadata()
        .map_err(|e| SpillError::io(path, "fstat", e))?;
    if meta.uid() != euid {
        return Err(SpillError::refused(
            path,
            format!(
                "it belongs to user {}, not to the user TreeMap runs as ({euid})",
                meta.uid()
            ),
        ));
    }
    if meta.mode() & 0o777 != DIR_MODE {
        file.set_permissions(Permissions::from_mode(DIR_MODE))
            .map_err(|e| SpillError::io(path, "fchmod", e))?;
    }
    Ok(Dir { file })
}

/// Why the folder could not be opened as one, in words.
fn what_is_there(path: &Path) -> &'static str {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => "it is a symbolic link",
        _ => "it is not a folder",
    }
}

/// A new spill file in `dir` with no name: `O_TMPFILE` on Linux, else [`create_named`].
/// With `O_EXCL`, an `O_TMPFILE` file can never be given a name afterwards (`linkat`
/// refuses it), even by a process holding its descriptor.
pub(super) fn create(dir: &Dir, dir_path: &Path, name: &str) -> Result<File, SpillError> {
    #[cfg(target_os = "linux")]
    match open_at(
        dir,
        c".",
        libc::O_TMPFILE | libc::O_EXCL | libc::O_RDWR | libc::O_CLOEXEC,
    ) {
        Ok(file) => return Ok(file),
        // The macOS method below serves where Linux cannot give a file no name.
        Err(e) if tmpfile_refused(e.raw_os_error()) => {}
        Err(e) => return Err(SpillError::io(dir_path, "open(O_TMPFILE)", e)),
    }
    create_named(dir, dir_path, name, &mut || {})
}

/// Whether `open` refused `O_TMPFILE` for want of it: the file system does not support it
/// (`EOPNOTSUPP`), or the kernel predates it (3.11) and took the flag's `O_DIRECTORY` bit
/// for a folder opened for writing (`EISDIR`). Any other error is the folder's, and the
/// named method would meet it too.
#[cfg(target_os = "linux")]
fn tmpfile_refused(errno: Option<i32>) -> bool {
    matches!(errno, Some(libc::EOPNOTSUPP | libc::EISDIR))
}

/// The macOS method: `name` made exclusively in `dir` (`O_CREAT | O_EXCL`: nothing that is
/// already there, a link included, is opened), then — `window` run, which is the tests' seam
/// for what another process could do in that moment — its `(dev, ino)` compared with the
/// name's `lstat`, and only when they match the name removed. The file must then have no
/// name at all.
pub(super) fn create_named(
    dir: &Dir,
    dir_path: &Path,
    name: &str,
    window: &mut dyn FnMut(),
) -> Result<File, SpillError> {
    let c_name = CString::new(name).map_err(|_| SpillError::BadName {
        part: "file name",
        text: name.to_owned(),
        why: "it holds a NUL".to_owned(),
    })?;
    let file = open_at(
        dir,
        &c_name,
        libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC,
    )
    .map_err(|e| {
        if e.kind() == io::ErrorKind::AlreadyExists {
            SpillError::NameTaken {
                dir: dir_path.to_owned(),
                name: name.to_owned(),
            }
        } else {
            SpillError::io(&dir_path.join(name), "openat", e)
        }
    })?;
    let mine = identity(&file).map_err(|e| SpillError::io(&dir_path.join(name), "fstat", e))?;
    window();
    let replaced = |why| SpillError::Replaced {
        dir: dir_path.to_owned(),
        name: name.to_owned(),
        why,
    };
    match identity_at(dir, &c_name) {
        Ok(now) if now == mine => {}
        Ok(_) => return Err(replaced("the name leads to another file")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Err(replaced("the name is gone"));
        }
        Err(e) => return Err(SpillError::io(&dir_path.join(name), "fstatat", e)),
    }
    // SAFETY: `c_name` is NUL-terminated and outlives the call; the descriptor is the
    // folder's, open while `dir` is borrowed. The name removed is one this process made
    // just above and has just seen still leads to its own file.
    if unsafe { libc::unlinkat(dir.file.as_raw_fd(), c_name.as_ptr(), 0) } != 0 {
        return Err(SpillError::io(
            &dir_path.join(name),
            "unlinkat",
            io::Error::last_os_error(),
        ));
    }
    let links = file
        .metadata()
        .map_err(|e| SpillError::io(&dir_path.join(name), "fstat", e))?
        .nlink();
    if links != 0 {
        return Err(SpillError::OtherName {
            dir: dir_path.to_owned(),
            name: name.to_owned(),
        });
    }
    Ok(file)
}

/// `openat(dir, name, flags, 0600)`, close-on-exec as `flags` must say.
fn open_at(dir: &Dir, name: &CStr, flags: libc::c_int) -> io::Result<File> {
    // SAFETY: `name` is NUL-terminated and outlives the call; the descriptor is the
    // folder's, open while `dir` is borrowed; the mode is read only when `flags` create.
    let fd = unsafe { libc::openat(dir.file.as_raw_fd(), name.as_ptr(), flags, FILE_MODE) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `openat` just returned `fd`, and nothing else owns it.
    Ok(File::from(unsafe { OwnedFd::from_raw_fd(fd) }))
}

/// The `(dev, ino)` of the open `file`.
fn identity(file: &File) -> io::Result<(libc::dev_t, libc::ino_t)> {
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    // SAFETY: the descriptor is `file`'s, open while it is borrowed; `stat` is writable
    // for one `struct stat`, which the call fills when it answers 0.
    if unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the call answered 0, so it filled `stat`.
    let stat = unsafe { stat.assume_init() };
    Ok((stat.st_dev, stat.st_ino))
}

/// The `(dev, ino)` that `name` in `dir` leads to itself, a link not followed.
fn identity_at(dir: &Dir, name: &CStr) -> io::Result<(libc::dev_t, libc::ino_t)> {
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `name` is NUL-terminated and outlives the call; the descriptor is the
    // folder's, open while `dir` is borrowed; `stat` is writable for one `struct stat`,
    // which the call fills when it answers 0.
    let answer = unsafe {
        libc::fstatat(
            dir.file.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if answer != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the call answered 0, so it filled `stat`.
    let stat = unsafe { stat.assume_init() };
    Ok((stat.st_dev, stat.st_ino))
}

/// The facts of the volume holding `path`: its free and total bytes and its file system
/// from `statfs` (macOS) or `statvfs` and `statfs` (Linux), and its device from `stat`.
pub(super) fn volume_facts(path: &Path) -> io::Result<VolumeFacts> {
    let c_path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "the path holds a NUL"))?;
    let device = std::fs::metadata(path)?.dev();
    let (free_bytes, total_bytes, file_system) = space(&c_path)?;
    Ok(VolumeFacts {
        free_bytes,
        total_bytes,
        file_system,
        volume: VolumeId(device.to_string()),
    })
}

/// macOS: `statfs` alone. Its counts are 64-bit where `statvfs`'s are 32 (`fsblkcnt_t` is
/// an `unsigned int` there), and `f_bsize` is the block size the counts are in.
#[cfg(target_os = "macos")]
fn space(path: &CStr) -> io::Result<(u64, u64, FileSystem)> {
    let facts = statfs(path)?;
    let block = u64::from(facts.f_bsize);
    let name: Vec<u8> = facts
        .f_fstypename
        .iter()
        .map(|c| {
            let [byte] = c.to_ne_bytes();
            byte
        })
        .take_while(|&byte| byte != 0)
        .collect();
    Ok((
        facts.f_bavail.saturating_mul(block),
        facts.f_blocks.saturating_mul(block),
        FileSystem::Named(String::from_utf8_lossy(&name).into_owned()),
    ))
}

/// Linux: the space from `statvfs` (`f_bavail × f_frsize`), the file system's magic number
/// from `statfs`.
#[cfg(not(target_os = "macos"))]
fn space(path: &CStr) -> io::Result<(u64, u64, FileSystem)> {
    let mut vfs = MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `path` is NUL-terminated and outlives the call; `vfs` is writable for one
    // `statvfs`, which the call fills when it answers 0.
    if unsafe { libc::statvfs(path.as_ptr(), vfs.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the call answered 0, so it filled `vfs`.
    let vfs = unsafe { vfs.assume_init() };
    let facts = statfs(path)?;
    // The magic numbers are 32-bit; on a 32-bit target `f_type` is signed, and the high
    // ones (CIFS, SMB2) would read negative, so only the low 32 bits are taken.
    #[expect(
        clippy::cast_sign_loss,
        reason = "f_type holds a 32-bit magic number, read as its bits"
    )]
    let magic = facts.f_type as u64 & 0xFFFF_FFFF;
    Ok((
        vfs.f_bavail.saturating_mul(vfs.f_frsize),
        vfs.f_blocks.saturating_mul(vfs.f_frsize),
        FileSystem::Magic(magic),
    ))
}

fn statfs(path: &CStr) -> io::Result<libc::statfs> {
    let mut facts = MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: `path` is NUL-terminated and outlives the call; `facts` is writable for one
    // `statfs`, which the call fills when it answers 0.
    if unsafe { libc::statfs(path.as_ptr(), facts.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the call answered 0, so it filled `facts`.
    Ok(unsafe { facts.assume_init() })
}

#[cfg(test)]
mod tests {
    //! The macOS method against what another process could do inside its window, through
    //! the seam `create_named` offers (on Linux too, where it is `O_TMPFILE`'s fallback),
    //! and the folder refused for another user.

    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    type TestResult = Result<(), String>;

    static SCRATCHES: AtomicU32 = AtomicU32::new(0);

    /// A folder of the test's own under the OS temp folder, removed with its contents.
    struct Scratch {
        dir: PathBuf,
    }

    impl Scratch {
        fn new(tag: &str) -> Result<Self, String> {
            let n = SCRATCHES.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "tm-store-spill-unit-{tag}-{}-{n}",
                std::process::id()
            ));
            std::fs::create_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            Ok(Self { dir })
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            if self.dir.starts_with(std::env::temp_dir()) {
                let _ = std::fs::remove_dir_all(&self.dir);
            }
        }
    }

    fn names_in(dir: &Path) -> Result<Vec<String>, String> {
        let mut names = Vec::new();
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            names.push(
                entry
                    .map_err(|e| e.to_string())?
                    .file_name()
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        names.sort();
        Ok(names)
    }

    /// The spill folder under a new scratch folder, open.
    fn spill(scratch: &Scratch) -> Result<(PathBuf, Dir), String> {
        let path = scratch.dir.join("scan-spill");
        let dir = open_dir(&path).map_err(|e| e.to_string())?;
        Ok((path, dir))
    }

    #[test]
    fn the_named_method_leaves_no_name() -> TestResult {
        let scratch = Scratch::new("named")?;
        let (path, dir) = spill(&scratch)?;
        let file =
            create_named(&dir, &path, "1-2-scan-size", &mut || {}).map_err(|e| e.to_string())?;
        assert_eq!(names_in(&path)?, Vec::<String>::new());
        assert_eq!(file.metadata().map_err(|e| e.to_string())?.nlink(), 0);
        Ok(())
    }

    #[test]
    fn a_name_replaced_in_the_window_is_left_alone_and_the_file_refused() -> TestResult {
        let scratch = Scratch::new("replaced")?;
        let (path, dir) = spill(&scratch)?;
        let name = "1-2-scan-size";
        let impostor = path.join("impostor");
        let target = path.join(name);
        let mut seam_failed = None;
        let made = create_named(&dir, &path, name, &mut || {
            // Another process puts a file of its own at the name.
            if let Err(e) = std::fs::write(&impostor, b"not TreeMap's")
                .and_then(|()| std::fs::rename(&impostor, &target))
            {
                seam_failed = Some(e.to_string());
            }
        });
        if let Some(e) = seam_failed {
            return Err(format!("the seam: {e}"));
        }
        match made {
            Err(SpillError::Replaced { why, .. }) => {
                assert!(why.contains("another file"), "the reason: {why}");
            }
            Err(other) => return Err(format!("refused for another reason: {other}")),
            Ok(_) => return Err("the file was taken although its name was replaced".to_owned()),
        }
        assert_eq!(names_in(&path)?, vec![name.to_owned()], "the name is left");
        assert_eq!(
            std::fs::read(&target).map_err(|e| e.to_string())?,
            b"not TreeMap's",
            "and still leads to the other process's file"
        );
        Ok(())
    }

    #[test]
    fn a_link_put_at_the_name_in_the_window_is_left_alone() -> TestResult {
        let scratch = Scratch::new("linked")?;
        let (path, dir) = spill(&scratch)?;
        let outside = scratch.dir.join("outside.txt");
        std::fs::write(&outside, b"the user's").map_err(|e| e.to_string())?;
        let name = "1-2-scan-flags";
        let target = path.join(name);
        let parked = scratch.dir.join("parked");
        let mut seam_failed = None;
        let made = create_named(&dir, &path, name, &mut || {
            // Another process moves the file away and leaves a link to its own in its place.
            if let Err(e) = std::fs::rename(&target, &parked)
                .and_then(|()| std::os::unix::fs::symlink(&outside, &target))
            {
                seam_failed = Some(e.to_string());
            }
        });
        if let Some(e) = seam_failed {
            return Err(format!("the seam: {e}"));
        }
        assert!(
            matches!(made, Err(SpillError::Replaced { .. })),
            "the file is refused: {:?}",
            made.map(|_| ())
        );
        let link = std::fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
        assert!(link.file_type().is_symlink(), "the link is left in place");
        assert_eq!(
            std::fs::read(&outside).map_err(|e| e.to_string())?,
            b"the user's",
            "and what it leads to is untouched"
        );
        Ok(())
    }

    #[test]
    fn a_name_gone_in_the_window_is_refused() -> TestResult {
        let scratch = Scratch::new("gone")?;
        let (path, dir) = spill(&scratch)?;
        let name = "1-2-scan-ext";
        let target = path.join(name);
        let parked = scratch.dir.join("parked");
        let mut seam_failed = None;
        let made = create_named(&dir, &path, name, &mut || {
            if let Err(e) = std::fs::rename(&target, &parked) {
                seam_failed = Some(e.to_string());
            }
        });
        if let Some(e) = seam_failed {
            return Err(format!("the seam: {e}"));
        }
        match made {
            Err(SpillError::Replaced { why, .. }) => assert!(why.contains("gone"), "{why}"),
            Err(other) => return Err(format!("refused for another reason: {other}")),
            Ok(_) => return Err("a file that has another name was taken".to_owned()),
        }
        Ok(())
    }

    #[test]
    fn a_second_name_made_in_the_window_is_refused_and_left_alone() -> TestResult {
        let scratch = Scratch::new("second")?;
        let (path, dir) = spill(&scratch)?;
        let name = "1-2-scan-names";
        let target = path.join(name);
        let second = scratch.dir.join("second-name");
        let mut seam_failed = None;
        let made = create_named(&dir, &path, name, &mut || {
            if let Err(e) = std::fs::hard_link(&target, &second) {
                seam_failed = Some(e.to_string());
            }
        });
        if let Some(e) = seam_failed {
            return Err(format!("the seam: {e}"));
        }
        assert!(
            matches!(made, Err(SpillError::OtherName { .. })),
            "a file that keeps another name is refused: {:?}",
            made.map(|_| ())
        );
        assert!(second.exists(), "the other name is not TreeMap's to remove");
        assert_eq!(names_in(&path)?, Vec::<String>::new(), "its own is gone");
        Ok(())
    }

    #[test]
    fn a_name_already_taken_is_refused_and_left_as_it_was() -> TestResult {
        let scratch = Scratch::new("taken")?;
        let (path, dir) = spill(&scratch)?;
        let name = "1-2-scan-parent";
        std::fs::write(path.join(name), b"already here").map_err(|e| e.to_string())?;
        let made = create_named(&dir, &path, name, &mut || {});
        assert!(
            matches!(made, Err(SpillError::NameTaken { .. })),
            "a taken name is refused as taken, and nothing opened: {:?}",
            made.map(|_| ())
        );
        assert_eq!(
            std::fs::read(path.join(name)).map_err(|e| e.to_string())?,
            b"already here"
        );
        Ok(())
    }

    #[test]
    fn a_link_already_at_the_name_is_not_followed() -> TestResult {
        let scratch = Scratch::new("prelinked")?;
        let (path, dir) = spill(&scratch)?;
        let outside = scratch.dir.join("outside.txt");
        std::fs::write(&outside, b"the user's").map_err(|e| e.to_string())?;
        let name = "1-2-scan-atime";
        std::os::unix::fs::symlink(&outside, path.join(name)).map_err(|e| e.to_string())?;
        let made = create_named(&dir, &path, name, &mut || {});
        assert!(
            matches!(made, Err(SpillError::NameTaken { .. })),
            "a taken name is refused as taken, and nothing opened: {:?}",
            made.map(|_| ())
        );
        assert_eq!(
            std::fs::read(&outside).map_err(|e| e.to_string())?,
            b"the user's"
        );
        assert!(
            std::fs::symlink_metadata(path.join(name))
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink(),
            "the link is left in place"
        );
        Ok(())
    }

    #[test]
    fn a_folder_that_is_not_this_users_is_refused() -> TestResult {
        let scratch = Scratch::new("owner")?;
        let path = scratch.dir.join("scan-spill");
        // SAFETY: `geteuid` takes no arguments, touches no memory and cannot fail.
        let euid = unsafe { libc::geteuid() };
        match open_dir_as(&path, euid.wrapping_add(1)) {
            Err(SpillError::DirRefused { why, .. }) => {
                assert!(why.contains("belongs to user"), "the reason: {why}");
            }
            Err(other) => return Err(format!("refused for another reason: {other}")),
            Ok(_) => return Err("another user's folder was taken".to_owned()),
        }
        open_dir_as(&path, euid).map_err(|e| format!("this user's: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn o_tmpfile_is_given_up_only_where_it_is_not_supported() {
        assert!(tmpfile_refused(Some(libc::EOPNOTSUPP)));
        assert!(tmpfile_refused(Some(libc::EISDIR)));
        for other in [
            libc::EACCES,
            libc::ENOSPC,
            libc::EROFS,
            libc::ENOENT,
            libc::EIO,
        ] {
            assert!(!tmpfile_refused(Some(other)), "errno {other}");
        }
        assert!(!tmpfile_refused(None));
    }
}

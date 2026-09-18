//! The per-entry listing: `fdopendir` + `readdir` + `fstatat(AT_SYMLINK_NOFOLLOW)`.
//! On macOS it is the fallback for a volume whose `getattrlistbulk` is refused
//! (`ENOTSUP`/`EINVAL`: network and FUSE volumes); it is written on POSIX calls
//! only so Linux can reuse it in W5. `readdir` rather than `readdir_r`: every
//! worker owns its own `DIR` stream, and macOS's `readdir` keeps its state in
//! the stream, not in a static, so the deprecated `readdir_r` buys nothing.

use std::ffi::{CStr, CString};
use std::os::fd::{IntoRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use super::darwin::SF_DATALESS;
use super::{Listing, Meta, last_errno, time_ms};
use crate::{FLAG_DATALESS, KIND_DIR, KIND_FILE, KIND_SYMLINK};

/// `st_blocks` counts units of this many bytes, whatever the file system's block size.
const BLOCK_BYTES: i64 = 512;

/// `lstat(path)` as a [`Meta`] (the kind says whether it is a directory).
pub fn lstat_meta(path: &Path, want_atime: bool) -> Result<Meta, i32> {
    let c = CString::new(path.as_os_str().as_bytes()).map_err(|_| libc::EINVAL)?;
    // SAFETY: all-zero is a valid `stat` (plain integers).
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a NUL-terminated path and `st` a writable stat; lstat fills it
    // and does not follow a final symlink.
    let rc = unsafe { libc::lstat(c.as_ptr(), &raw mut st) };
    if rc != 0 {
        return Err(last_errno());
    }
    Ok(meta_from_stat(&st, want_atime))
}

/// The facts the legacy walker takes from an `lstat`: kind from `st_mode`,
/// size (0 for a directory), `st_blocks * 512` as the allocation, the times as
/// Node's doubles, `st_dev`, `st_ino`, `st_nlink`, and `SF_DATALESS`. A
/// directory's size, allocation and link count are 0: the walk records none of
/// them, and the bulk listing (which returns no file group for a directory)
/// must agree with this path fact for fact.
pub fn meta_from_stat(st: &libc::stat, want_atime: bool) -> Meta {
    let kind = match st.st_mode & libc::S_IFMT {
        libc::S_IFDIR => KIND_DIR,
        libc::S_IFLNK => KIND_SYMLINK,
        _ => KIND_FILE,
    };
    let is_dir = kind == KIND_DIR;
    let size = if is_dir { 0.0 } else { st.st_size as f64 };
    let alloc = if is_dir {
        0.0
    } else {
        st.st_blocks.saturating_mul(BLOCK_BYTES) as f64
    };
    let nlink = if is_dir { 0 } else { u32::from(st.st_nlink) };
    let mtime_ms = time_ms(st.st_mtime, st.st_mtime_nsec);
    let atime_ms = if want_atime {
        time_ms(st.st_atime, st.st_atime_nsec)
    } else {
        f64::NAN
    };
    let flags = if st.st_flags & SF_DATALESS != 0 {
        FLAG_DATALESS
    } else {
        0
    };
    Meta {
        kind,
        flags,
        size,
        alloc,
        mtime_ms,
        atime_ms,
        dev: f64::from(st.st_dev),
        ino: st.st_ino as f64,
        nlink,
        withheld: false,
    }
}

/// Lists the directory `fd` refers to, one `fstatat` per entry, into `out`
/// (cleared first). Takes the descriptor: the stream owns it and closes it.
pub fn list(fd: OwnedFd, want_atime: bool, out: &mut Listing) -> Result<(), i32> {
    out.clear();
    let raw = fd.into_raw_fd();
    // SAFETY: `raw` is an open directory descriptor this function now owns; on
    // success the stream owns it and `closedir` releases it.
    let dir = unsafe { libc::fdopendir(raw) };
    if dir.is_null() {
        let errno = last_errno();
        // SAFETY: fdopendir failed, so the descriptor is still ours to close.
        unsafe { libc::close(raw) };
        return Err(errno);
    }
    let result = read_all(dir, want_atime, out);
    // SAFETY: `dir` came from fdopendir and has not been closed.
    unsafe { libc::closedir(dir) };
    result
}

fn read_all(dir: *mut libc::DIR, want_atime: bool, out: &mut Listing) -> Result<(), i32> {
    // SAFETY: `dir` is an open stream.
    let dirfd = unsafe { libc::dirfd(dir) };
    loop {
        clear_errno();
        // SAFETY: `dir` is an open stream; readdir returns null at the end (errno
        // untouched) or on error (errno set), otherwise a pointer into the
        // stream's own buffer that stays valid until the next call on it.
        let ent = unsafe { libc::readdir(dir) };
        if ent.is_null() {
            let errno = last_errno();
            return if errno == 0 { Ok(()) } else { Err(errno) };
        }
        // SAFETY: `ent` is non-null; taking the field's address creates no
        // reference to the record, which may be shorter than `dirent`.
        let name_ptr = unsafe { (&raw const (*ent).d_name).cast::<libc::c_char>() };
        // SAFETY: readdir NUL-terminates `d_name` within the record.
        let name = unsafe { CStr::from_ptr(name_ptr) }.to_bytes();
        if name == b"." || name == b".." {
            continue;
        }
        // SAFETY: all-zero is a valid `stat`.
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: `dirfd` is open, `name_ptr` is NUL-terminated, `st` is writable;
        // AT_SYMLINK_NOFOLLOW reports a link as its own object.
        let rc = unsafe { libc::fstatat(dirfd, name_ptr, &raw mut st, libc::AT_SYMLINK_NOFOLLOW) };
        if rc != 0 {
            count_entry_error(last_errno(), out);
            continue;
        }
        out.push(name, meta_from_stat(&st, want_atime));
    }
}

/// The legacy walker's accounting for an entry whose metadata could not be
/// read: denied for `EACCES`/`EPERM`, nothing for a vanished entry, unreadable otherwise.
pub fn count_entry_error(errno: i32, out: &mut Listing) {
    match errno {
        libc::EACCES | libc::EPERM => out.denied_entries = out.denied_entries.saturating_add(1),
        libc::ENOENT => {}
        _ => out.unreadable_entries = out.unreadable_entries.saturating_add(1),
    }
}

/// `readdir` signals the end and an error the same way (null), so errno is
/// cleared first and read afterwards.
fn clear_errno() {
    // SAFETY: `__error` returns the calling thread's errno slot, always valid to write.
    unsafe { *libc::__error() = 0 };
}

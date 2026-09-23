//! The per-entry listing: `fdopendir` + `readdir` + `fstatat(AT_SYMLINK_NOFOLLOW)`.
//! On macOS it is the fallback for a volume whose `getattrlistbulk` is refused
//! (`ENOTSUP`/`EINVAL`: network and FUSE volumes); it is written on POSIX calls
//! only so Linux can reuse it in W5. `readdir` rather than `readdir_r`: every
//! worker owns its own `DIR` stream, and macOS's `readdir` keeps its state in
//! the stream, not in a static, so the deprecated `readdir_r` buys nothing.

use std::ffi::{CStr, CString};
use std::os::fd::{IntoRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use super::darwin::SF_DATALESS;
use super::{ListBuffer, Listing, Meta, last_errno, time_ms};
use crate::{FLAG_DATALESS, KIND_DIR, KIND_FILE, KIND_SYMLINK};

/// `st_blocks` counts units of this many bytes, whatever the file system's block size.
const BLOCK_BYTES: i64 = 512;
/// Entries per batch of the per-entry listing. There is no bulk call to pace
/// the walk's two signals by, so a batch is this many `readdir` answers: the
/// stop flag is checked before each batch and the heartbeat bumped after it,
/// and the last, partial batch beats when the stream ends, so even an empty
/// directory beats once. The Windows `FindNextFileW` fallback keeps the same cadence.
pub const PER_ENTRY_BATCH: usize = 256;

/// `lstat(path)` as a [`Meta`] (the kind says whether it is a directory).
pub fn lstat_meta(path: &Path, want_atime: bool) -> Result<Meta, i32> {
    let c = CString::new(path.as_os_str().as_bytes()).map_err(|_| libc::EINVAL)?;
    // SAFETY: all-zero is a valid `stat` (plain integers).
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    super::retry_eintr(|| {
        // SAFETY: `c` is a NUL-terminated path and `st` a writable stat; lstat
        // fills it and does not follow a final symlink.
        let rc = unsafe { libc::lstat(c.as_ptr(), &raw mut st) };
        if rc == 0 { Ok(()) } else { Err(last_errno()) }
    })?;
    Ok(meta_from_stat(&st, want_atime))
}

/// `fstatat(dirfd, name, AT_SYMLINK_NOFOLLOW)` as a [`Meta`]: the entry `name`
/// of the directory `dirfd` refers to, as its own object, exactly what `lstat`
/// on the joined path reads. The one stat behind the per-entry listing, the
/// mount-point re-read and the bulk listing's type fallback.
pub fn fstatat_meta(dirfd: RawFd, name: &CStr, want_atime: bool) -> Result<Meta, i32> {
    // SAFETY: all-zero is a valid `stat` (plain integers).
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    super::retry_eintr(|| {
        // SAFETY: `name` is NUL-terminated and `st` a writable stat; a closed or
        // invalid `dirfd` fails with EBADF rather than doing anything; the flag
        // stops a final symlink from being followed.
        let rc =
            unsafe { libc::fstatat(dirfd, name.as_ptr(), &raw mut st, libc::AT_SYMLINK_NOFOLLOW) };
        if rc == 0 { Ok(()) } else { Err(last_errno()) }
    })?;
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

/// Lists the directory `fd` refers to, one `fstatat` per entry, into
/// `buf.listing` (cleared first), pacing the walk's stop flag and heartbeat
/// by [`PER_ENTRY_BATCH`]. Takes the descriptor: the stream owns it and closes it.
pub fn list(fd: OwnedFd, want_atime: bool, buf: &mut ListBuffer) -> Result<(), i32> {
    buf.listing.clear();
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
    let result = read_all(dir, want_atime, buf);
    // SAFETY: `dir` came from fdopendir and has not been closed.
    unsafe { libc::closedir(dir) };
    result
}

fn read_all(dir: *mut libc::DIR, want_atime: bool, buf: &mut ListBuffer) -> Result<(), i32> {
    // SAFETY: `dir` is an open stream.
    let dirfd = unsafe { libc::dirfd(dir) };
    let mut in_batch = 0_usize;
    loop {
        if in_batch == PER_ENTRY_BATCH {
            buf.beat();
            in_batch = 0;
        }
        if in_batch == 0 && buf.stopped() {
            // The walk discards the listing on cancel, so which errno ends it is immaterial.
            return Err(libc::ECANCELED);
        }
        let ent = super::retry_eintr(|| {
            clear_errno();
            // SAFETY: `dir` is an open stream; readdir returns null at the end
            // (errno untouched) or on error (errno set), otherwise a pointer into
            // the stream's own buffer that stays valid until the next call on it.
            let ent = unsafe { libc::readdir(dir) };
            if ent.is_null() {
                let errno = last_errno();
                if errno != 0 {
                    return Err(errno);
                }
            }
            Ok(ent)
        })?;
        if ent.is_null() {
            // The end is an answer too: the last, partial batch beats here.
            buf.beat();
            return Ok(());
        }
        in_batch += 1;
        let out = &mut buf.listing;
        // SAFETY: `ent` is non-null; taking the field's address creates no
        // reference to the record, which may be shorter than `dirent`.
        let name_ptr = unsafe { (&raw const (*ent).d_name).cast::<libc::c_char>() };
        // SAFETY: readdir NUL-terminates `d_name` within the record.
        let name = unsafe { CStr::from_ptr(name_ptr) };
        let bytes = name.to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        match fstatat_meta(dirfd, name, want_atime) {
            Ok(meta) => out.push(bytes, meta),
            Err(errno) => count_entry_error(errno, out),
        }
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

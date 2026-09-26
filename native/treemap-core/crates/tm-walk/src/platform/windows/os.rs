//! Windows' own calls behind the portable parser and rules of
//! [`super`]: the directory handle, `FileIdExtdDirectoryInfo` and the
//! `FindFirstFileExW` fallback, reparse reads, `lstat`'s facts, and the
//! thread clock. Moved out of `windows.rs` unchanged (Phase 4, T6b).

use std::ffi::{OsString, c_void};
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::ptr;

use windows_sys::Win32::Foundation::{
    CloseHandle, FILETIME, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FileAttributeTagInfo, FileIdExtdDirectoryInfo,
    FileIdExtdDirectoryRestartInfo, FindClose, FindExInfoBasic, FindExSearchNameMatch,
    FindFirstFileExW, GetFileInformationByHandle, GetFileInformationByHandleEx, OPEN_EXISTING,
    WIN32_FIND_DATAW,
};
use windows_sys::Win32::System::IO::DeviceIoControl;
use windows_sys::Win32::System::Ioctl::FSCTL_GET_REPARSE_POINT;
use windows_sys::Win32::System::Threading::{GetCurrentThread, GetThreadTimes};

use super::{
    DirFacts, ERROR_CANT_ACCESS_FILE, ERROR_DIRECTORY, ERROR_INVALID_DATA, ERROR_INVALID_NAME,
    ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, ERROR_NOT_SUPPORTED, ERROR_OPERATION_ABORTED,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FLAG_DATALESS, KIND_DIR, KIND_FILE,
    KIND_SYMLINK, LinkClass, RecordAt, ReparseSource, after, filetime_ms, has_embedded_nul,
    is_dataless, is_dot_entry, link_class, prefixed_path, record_at, refusal_from_win32,
    reparse_target_len, stage_record,
};
use crate::output::Refusal;
use crate::platform::{DirTimes, ListBuffer, Listed, Lister, Meta, list_whole};
use crate::{FastPath, Probe};

mod find;

use find::{FindAt, FindStep, find_start, find_step};

/// The probe's own listing buffer.
const PROBE_BUFFER_BYTES: usize = 64 * 1024;
/// `MAXIMUM_REPARSE_DATA_BUFFER_SIZE`: what `FSCTL_GET_REPARSE_POINT` can return.
const REPARSE_BUFFER_BYTES: usize = 16 * 1024;
/// How every directory and reparse point is opened: as a backup operator
/// would, and never through a reparse point.
const OPEN_FLAGS: u32 = FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT;
/// Every sharing mode: a listing must never block a writer or a delete.
const SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
/// FILETIME ticks per second, as a double.
const TICKS_PER_SECOND_F64: f64 = 1e7;
/// An open file or directory handle, closed on drop.
struct Handle(HANDLE);

// SAFETY: a file handle names a kernel object of the process, not of the
// thread that opened it: any thread may use or close it. A `Handle` is used
// through one owner at a time — a listing's cursor moves only with the
// `&mut ListBuffer` holding it — and is closed once, in `drop`.
unsafe impl Send for Handle {}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: `self.0` came from a successful CreateFileW (so it is not
        // INVALID_HANDLE_VALUE) and is closed exactly once, here.
        unsafe { CloseHandle(self.0) };
    }
}

/// [`crate::platform::data_is_local`] on Windows: the entry's attributes
/// and reparse tag from `FindFirstFileExW` on the path itself, never an
/// open. A name holding a character the search reads as a pattern (`*`,
/// `?`, and the DOS wildcards `<`, `>`, `"`) is refused rather than
/// answered for another file.
pub fn data_is_local(path: &Path) -> std::io::Result<bool> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default();
    if name.contains(['*', '?', '<', '>', '"']) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the name holds a character the directory search reads as a pattern",
        ));
    }
    let wide_path = wide(path).map_err(os_error)?;
    // SAFETY: all-zero is a valid WIN32_FIND_DATAW.
    let mut data: WIN32_FIND_DATAW = unsafe { std::mem::zeroed() };
    // SAFETY: `wide_path` is NUL-terminated; the pointer is a writable
    // WIN32_FIND_DATAW, which is what FindExInfoBasic fills; no search
    // filter is passed, as FindExSearchNameMatch requires.
    let handle = unsafe {
        FindFirstFileExW(
            wide_path.as_ptr(),
            FindExInfoBasic,
            (&raw mut data).cast::<c_void>(),
            FindExSearchNameMatch,
            ptr::null(),
            0,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(os_error(last_error()));
    }
    let _search = FindHandle(handle);
    let tag = if data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        0
    } else {
        data.dwReserved0
    };
    Ok(!is_dataless(data.dwFileAttributes, tag))
}

/// An open search handle, closed on drop.
struct FindHandle(HANDLE);

// SAFETY: a `FindFirstFileExW` search belongs to the process, not to the
// thread that started it; `FindNextFileW` and `FindClose` may be called from
// any thread as long as the calls do not overlap. A `FindHandle` is used
// through one owner at a time (a listing's cursor moves only with the
// `&mut ListBuffer` holding it) and is closed once, in `drop`.
unsafe impl Send for FindHandle {}

impl Drop for FindHandle {
    fn drop(&mut self) {
        // SAFETY: `self.0` came from a successful FindFirstFileExW and is
        // closed exactly once, here.
        unsafe { FindClose(self.0) };
    }
}

fn last_error() -> u32 {
    // SAFETY: GetLastError reads the calling thread's error slot; no preconditions.
    unsafe { GetLastError() }
}

fn os_error(code: u32) -> std::io::Error {
    std::io::Error::from_raw_os_error(i32::try_from(code).unwrap_or(i32::MAX))
}

/// `path` as a NUL-terminated UTF-16 `\\?\` path, or `ERROR_INVALID_NAME`
/// when the path holds a NUL of its own: passed on, that NUL would end the
/// string early and the call would silently open a truncated path.
fn wide(path: &Path) -> Result<Vec<u16>, u32> {
    let text = path.to_string_lossy();
    if has_embedded_nul(&text) {
        return Err(ERROR_INVALID_NAME);
    }
    Ok(prefixed_path(&text)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect())
}

fn join_wide(dir: &Path, name: &[u16]) -> PathBuf {
    dir.join(OsString::from_wide(name))
}

fn struct_size<T>() -> u32 {
    u32::try_from(std::mem::size_of::<T>()).unwrap_or(u32::MAX)
}

#[expect(
    clippy::cast_possible_wrap,
    reason = "a FILETIME is a signed 64-bit tick count split in two words"
)]
fn ticks(t: FILETIME) -> i64 {
    ((u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime)) as i64
}

fn size_of_parts(high: u32, low: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}

/// Opens `path` itself (never through a final reparse point unless
/// `flags` says so) for `access`, sharing everything.
fn open(path: &Path, access: u32, flags: u32) -> Result<Handle, u32> {
    let name = wide(path)?;
    // SAFETY: `name` is NUL-terminated and outlives the call; no security
    // attributes and no template handle are passed; OPEN_EXISTING creates nothing.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            access,
            SHARE_ALL,
            ptr::null(),
            OPEN_EXISTING,
            flags,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(last_error());
    }
    Ok(Handle(handle))
}

fn by_handle_info(handle: &Handle) -> Result<BY_HANDLE_FILE_INFORMATION, u32> {
    // SAFETY: all-zero is a valid BY_HANDLE_FILE_INFORMATION (plain integers).
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: `handle` is open and `info` is a writable struct of the type the call fills.
    let ok = unsafe { GetFileInformationByHandle(handle.0, &raw mut info) };
    if ok == 0 {
        return Err(last_error());
    }
    Ok(info)
}

fn reparse_tag_of(handle: &Handle) -> Result<u32, u32> {
    // SAFETY: all-zero is a valid FILE_ATTRIBUTE_TAG_INFO.
    let mut info: FILE_ATTRIBUTE_TAG_INFO = unsafe { std::mem::zeroed() };
    // SAFETY: `handle` is open; the pointer and size describe a writable
    // FILE_ATTRIBUTE_TAG_INFO owned by this frame, the class the call fills.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle.0,
            FileAttributeTagInfo,
            (&raw mut info).cast::<c_void>(),
            struct_size::<FILE_ATTRIBUTE_TAG_INFO>(),
        )
    };
    if ok == 0 {
        return Err(last_error());
    }
    Ok(info.ReparseTag)
}

/// The `REPARSE_DATA_BUFFER` behind `handle`, exactly the bytes returned.
fn read_reparse(handle: &Handle) -> Result<Vec<u8>, u32> {
    let mut buf = vec![0_u8; REPARSE_BUFFER_BYTES];
    let mut returned = 0_u32;
    // SAFETY: `handle` is open; no input buffer is passed; the output
    // pointer and size describe `buf`, writable for its whole length;
    // `returned` is a live u32 owned by this frame; no overlapped I/O.
    let ok = unsafe {
        DeviceIoControl(
            handle.0,
            FSCTL_GET_REPARSE_POINT,
            ptr::null(),
            0,
            buf.as_mut_ptr().cast::<c_void>(),
            u32::try_from(buf.len()).unwrap_or(u32::MAX),
            &raw mut returned,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(last_error());
    }
    buf.truncate(usize::try_from(returned).unwrap_or(0));
    Ok(buf)
}

/// The reparse source for real entries: opens `dir\name` itself and reads its data.
#[derive(Debug, Clone, Copy, Default)]
pub struct FileReparse;

impl ReparseSource for FileReparse {
    fn reparse_data(&self, dir: &Path, name: &[u16]) -> Result<Vec<u8>, u32> {
        let handle = open(&join_wide(dir, name), FILE_READ_ATTRIBUTES, OPEN_FLAGS)?;
        read_reparse(&handle)
    }
}

/// `path` itself as Node's `lstat` reports it: kind by libuv's rule (a
/// readable link is a symbolic link sized by its target; any other reparse
/// point is the object behind it), sizes, times, `dev`, `ino` and the link
/// count from `BY_HANDLE_FILE_INFORMATION`. That structure has no
/// allocation size, so a file is marked withheld; the walk only ever asks
/// about the root, which must be a directory.
pub fn stat_path(path: &Path, want_atime: bool) -> Result<Meta, u32> {
    let handle = open(path, FILE_READ_ATTRIBUTES, OPEN_FLAGS)?;
    let info = by_handle_info(&handle)?;
    let attrs = info.dwFileAttributes;
    let is_dir = attrs & FILE_ATTRIBUTE_DIRECTORY != 0;
    let mut kind = if is_dir { KIND_DIR } else { KIND_FILE };
    let mut size = if is_dir {
        0.0
    } else {
        size_of_parts(info.nFileSizeHigh, info.nFileSizeLow) as f64
    };
    let mut tag = 0;
    if attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        tag = reparse_tag_of(&handle)?;
        let class = link_class(tag);
        match class {
            LinkClass::Link | LinkClass::Alias => {
                match reparse_target_len(&read_reparse(&handle)?) {
                    Some(len) => {
                        kind = KIND_SYMLINK;
                        size = len as f64;
                    }
                    None if class == LinkClass::Alias => return Err(ERROR_CANT_ACCESS_FILE),
                    None => {}
                }
            }
            LinkClass::Unfollowable => return Err(ERROR_CANT_ACCESS_FILE),
            LinkClass::Followed => {}
        }
    }
    let flags = if is_dataless(attrs, tag) {
        FLAG_DATALESS
    } else {
        0
    };
    let times = own_times(&info, want_atime);
    Ok(Meta {
        kind,
        flags,
        size,
        alloc: 0.0,
        mtime_ms: times.mtime_ms,
        atime_ms: times.atime_ms,
        dev: f64::from(info.dwVolumeSerialNumber),
        ino: u128::from(size_of_parts(info.nFileIndexHigh, info.nFileIndexLow)),
        nlink: if is_dir { 0 } else { info.nNumberOfLinks },
        withheld: kind != KIND_DIR,
    })
}

/// A handle's own last-write and last-access times, as libuv's `lstat`
/// computes them: the directory's own record, not its parent's index copy.
fn own_times(info: &BY_HANDLE_FILE_INFORMATION, want_atime: bool) -> DirTimes {
    DirTimes {
        mtime_ms: filetime_ms(ticks(info.ftLastWriteTime)),
        atime_ms: if want_atime {
            filetime_ms(ticks(info.ftLastAccessTime))
        } else {
            f64::NAN
        },
    }
}

/// Opens `dir` to list it. The listing types every reparse point as a
/// link and never enqueues one, so a reparse point found here is either
/// the root or a replacement since the parent was listed: a real link is
/// refused as not a directory, a cloud placeholder (or any other tag with
/// a filter behind it) is reopened through its filter exactly as `readdir`
/// opens it, and a tag Windows cannot follow is refused as `lstat` would be.
fn open_dir(dir: &Path) -> Result<(Handle, BY_HANDLE_FILE_INFORMATION), u32> {
    let handle = open(dir, FILE_LIST_DIRECTORY, OPEN_FLAGS)?;
    let info = by_handle_info(&handle)?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(ERROR_DIRECTORY);
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        return Ok((handle, info));
    }
    let class = link_class(reparse_tag_of(&handle)?);
    let follow = match class {
        LinkClass::Followed => true,
        LinkClass::Unfollowable => false,
        LinkClass::Link | LinkClass::Alias => {
            if reparse_target_len(&read_reparse(&handle)?).is_some() {
                return Err(ERROR_DIRECTORY);
            }
            class == LinkClass::Link
        }
    };
    if !follow {
        return Err(ERROR_CANT_ACCESS_FILE);
    }
    drop(handle);
    let followed = open(dir, FILE_LIST_DIRECTORY, FILE_FLAG_BACKUP_SEMANTICS)?;
    let info = by_handle_info(&followed)?;
    Ok((followed, info))
}

/// How a bulk listing ended other than with an error.
enum Outcome {
    /// Every batch was parsed into the listing.
    Listed,
    /// The very first call was refused with `ERROR_INVALID_PARAMETER` or
    /// `ERROR_NOT_SUPPORTED`: this volume has no file ids; nothing was read.
    Unsupported(u32),
}

/// The `FileIdExtdDirectoryInfo` loop over `handle` into `buf.raw`, staging
/// every batch; the walk's stop flag is checked before each call and its
/// heartbeat bumped after each answer.
fn list_extd(
    handle: &Handle,
    dir: &Path,
    facts: DirFacts,
    buf: &mut ListBuffer,
) -> Result<Outcome, u32> {
    match extd_step(handle, dir, facts, buf, ExtdAt::FIRST, usize::MAX)? {
        ExtdStep::Done => Ok(Outcome::Listed),
        ExtdStep::Unsupported(code) => Ok(Outcome::Unsupported(code)),
        // No listing holds `usize::MAX` entries.
        ExtdStep::Stopped(_) => Err(ERROR_INVALID_DATA),
    }
}

/// Where a `FileIdExtdDirectoryInfo` listing stands between two steps (T6b):
/// whether the call has answered yet — its first call restarts the scan and
/// is the only one that may refuse the class for the volume — and the
/// unread rest of its last batch in `buf.raw`.
#[derive(Clone, Copy, Debug)]
struct ExtdAt {
    answered: bool,
    rest: Option<RecordAt>,
}

impl ExtdAt {
    const FIRST: Self = Self {
        answered: false,
        rest: None,
    };
}

/// How a step of a `FileIdExtdDirectoryInfo` listing ended other than with an error.
#[derive(Clone, Copy, Debug)]
enum ExtdStep {
    /// Every batch was staged.
    Done,
    /// The listing holds its limit: where it goes on from.
    Stopped(ExtdAt),
    /// The very first call was refused with `ERROR_INVALID_PARAMETER` or
    /// `ERROR_NOT_SUPPORTED`: this volume has no file ids; nothing was read.
    Unsupported(u32),
}

/// [`list_extd`] from `at` on, until the listing is complete or holds
/// `limit` entries, stopping inside a batch if it must.
fn extd_step(
    handle: &Handle,
    dir: &Path,
    facts: DirFacts,
    buf: &mut ListBuffer,
    mut at: ExtdAt,
    limit: usize,
) -> Result<ExtdStep, u32> {
    let limit = limit.max(1);
    let size = u32::try_from(buf.raw.len()).unwrap_or(u32::MAX);
    loop {
        if let Some(mut rest) = at.rest.take() {
            let ListBuffer { raw, listing, .. } = &mut *buf;
            loop {
                if listing.len() >= limit {
                    at.rest = Some(rest);
                    return Ok(ExtdStep::Stopped(at));
                }
                let (record, next) = record_at(raw, rest).map_err(|_| ERROR_INVALID_DATA)?;
                if !is_dot_entry(record.name) {
                    stage_record(&record, facts, dir, &FileReparse, listing);
                }
                match after(raw, rest, next).map_err(|_| ERROR_INVALID_DATA)? {
                    Some(following) => rest = following,
                    None => break,
                }
            }
        }
        if buf.listing.len() >= limit {
            return Ok(ExtdStep::Stopped(at));
        }
        if buf.stopped() {
            // The walk discards the listing on cancel, so which error ends it is immaterial.
            return Err(ERROR_OPERATION_ABORTED);
        }
        let class = if at.answered {
            FileIdExtdDirectoryInfo
        } else {
            FileIdExtdDirectoryRestartInfo
        };
        // SAFETY: `handle` is an open directory; the pointer and `size`
        // describe `buf.raw`, writable for its whole length; the class is a
        // directory-listing class the call fills in place.
        let ok = unsafe {
            GetFileInformationByHandleEx(
                handle.0,
                class,
                buf.raw.as_mut_ptr().cast::<c_void>(),
                size,
            )
        };
        if ok == 0 {
            let code = last_error();
            if code == ERROR_NO_MORE_FILES {
                // The end is an answer too: even an empty volume root beats once.
                buf.beat();
                return Ok(ExtdStep::Done);
            }
            if !at.answered && (code == ERROR_INVALID_PARAMETER || code == ERROR_NOT_SUPPORTED) {
                return Ok(ExtdStep::Unsupported(code));
            }
            return Err(code);
        }
        buf.beat();
        at = ExtdAt {
            answered: true,
            rest: Some(RecordAt::default()),
        };
    }
}

/// The Windows lister: `FileIdExtdDirectoryInfo` first, `FindFirstFileExW`
/// where a volume refuses it.
#[derive(Debug, Clone, Copy, Default)]
pub struct WindowsLister {
    find_only: bool,
}

impl WindowsLister {
    /// The lister.
    pub fn new() -> Self {
        Self { find_only: false }
    }

    /// `FindFirstFileExW` only, as on a volume that refuses
    /// `FileIdExtdDirectoryInfo` (for the tests that list in parts).
    pub fn find_only() -> Self {
        Self { find_only: true }
    }
}

/// Where a Windows listing that stopped early goes on from (T6b): its open
/// directory or search and its place, and what it does once complete (its
/// own times). Dropping it closes the handle.
enum WinCursor {
    Extd {
        handle: Handle,
        at: ExtdAt,
        dir: PathBuf,
        facts: DirFacts,
        times: DirTimes,
    },
    Find {
        at: FindAt,
        dir: PathBuf,
        facts: DirFacts,
        times: DirTimes,
    },
}

impl WindowsLister {
    /// What a `FileIdExtdDirectoryInfo` step answers: complete with the
    /// directory's own times set once, or `More` with its cursor kept.
    fn extd_answer(
        step: Result<ExtdStep, u32>,
        handle: Handle,
        dir: &Path,
        facts: DirFacts,
        times: DirTimes,
        buf: &mut ListBuffer,
    ) -> Result<Listed, Refusal> {
        match step {
            Ok(ExtdStep::Done) => {
                drop(handle);
                buf.listing.own_times = Some(times);
                Ok(Listed::Complete(FastPath::ExtdDirInfo))
            }
            Ok(ExtdStep::Stopped(at)) => {
                buf.keep_cursor(WinCursor::Extd {
                    handle,
                    at,
                    dir: dir.to_path_buf(),
                    facts,
                    times,
                });
                Ok(Listed::More)
            }
            Ok(ExtdStep::Unsupported(code)) | Err(code) => Err(refusal_from_win32(code)),
        }
    }

    /// What a `FindFirstFileExW` step answers, as [`WindowsLister::extd_answer`].
    fn find_answer(
        step: Result<FindStep, u32>,
        dir: &Path,
        facts: DirFacts,
        times: DirTimes,
        buf: &mut ListBuffer,
    ) -> Result<Listed, Refusal> {
        match step.map_err(refusal_from_win32)? {
            FindStep::Done => {
                buf.listing.own_times = Some(times);
                Ok(Listed::Complete(FastPath::PerEntry))
            }
            FindStep::Stopped(at) => {
                buf.keep_cursor(WinCursor::Find {
                    at,
                    dir: dir.to_path_buf(),
                    facts,
                    times,
                });
                Ok(Listed::More)
            }
        }
    }
}

impl Lister for WindowsLister {
    fn stat_dir(&self, path: &Path, want_atime: bool) -> Result<Meta, Refusal> {
        stat_path(path, want_atime).map_err(refusal_from_win32)
    }

    fn list(
        &self,
        dir: &Path,
        want_atime: bool,
        buf: &mut ListBuffer,
    ) -> Result<FastPath, Refusal> {
        list_whole(self, dir, want_atime, buf)
    }

    fn list_until(
        &self,
        dir: &Path,
        want_atime: bool,
        buf: &mut ListBuffer,
        limit: usize,
    ) -> Result<Listed, Refusal> {
        buf.close_cursor();
        buf.listing.clear();
        let (handle, info) = open_dir(dir).map_err(refusal_from_win32)?;
        let facts = DirFacts {
            dev: info.dwVolumeSerialNumber,
            want_atime,
        };
        // The directory's own times, from the handle this listing opened:
        // its parent's index holds a lazily updated copy (see DirTimes).
        let times = own_times(&info, want_atime);
        let step = if self.find_only {
            Ok(ExtdStep::Unsupported(ERROR_NOT_SUPPORTED))
        } else {
            extd_step(&handle, dir, facts, buf, ExtdAt::FIRST, limit)
        };
        match step {
            Ok(ExtdStep::Unsupported(_code)) => {
                drop(handle);
                buf.listing.clear();
                let step = find_start(dir, facts, buf, limit);
                Self::find_answer(step, dir, facts, times, buf)
            }
            step => Self::extd_answer(step, handle, dir, facts, times, buf),
        }
    }

    fn list_more(&self, buf: &mut ListBuffer, limit: usize) -> Result<Listed, Refusal> {
        match buf.take_cursor::<WinCursor>() {
            Some(WinCursor::Extd {
                handle,
                at,
                dir,
                facts,
                times,
            }) => {
                let step = extd_step(&handle, &dir, facts, buf, at, limit);
                Self::extd_answer(step, handle, &dir, facts, times, buf)
            }
            Some(WinCursor::Find {
                at,
                dir,
                facts,
                times,
            }) => {
                let step = find_step(at, &dir, facts, buf, limit);
                Self::find_answer(step, &dir, facts, times, buf)
            }
            None => Err(Refusal::Unreadable),
        }
    }
}

/// [`crate::probe`] on Windows: reads the root's own facts, opens it, and
/// lists it once with `FileIdExtdDirectoryInfo`.
pub fn probe(root: &Path) -> Probe {
    let unavailable = |reason: String| Probe {
        fast_path: FastPath::Unavailable,
        reason,
    };
    match stat_path(root, false) {
        Err(code) => {
            return unavailable(format!("the root could not be read: {}", os_error(code)));
        }
        Ok(meta) if meta.kind != KIND_DIR => {
            return unavailable("the root is not a directory".to_owned());
        }
        Ok(_) => {}
    }
    let (handle, info) = match open_dir(root) {
        Ok(opened) => opened,
        Err(code) => {
            return unavailable(format!(
                "the root directory could not be opened: {}",
                os_error(code)
            ));
        }
    };
    let facts = DirFacts {
        dev: info.dwVolumeSerialNumber,
        want_atime: false,
    };
    let mut buf = ListBuffer::new(PROBE_BUFFER_BYTES);
    match list_extd(&handle, root, facts, &mut buf) {
        Ok(Outcome::Listed) => Probe {
            fast_path: FastPath::ExtdDirInfo,
            reason: format!(
                "FileIdExtdDirectoryInfo listed the root directory ({} entries)",
                buf.listing.len()
            ),
        },
        Ok(Outcome::Unsupported(code)) => Probe {
            fast_path: FastPath::PerEntry,
            reason: format!(
                "FileIdExtdDirectoryInfo refused the root with {}; FindFirstFileExW is used, which reports no file ids or allocation sizes on this volume",
                os_error(code)
            ),
        },
        Err(code) => unavailable(format!(
            "FileIdExtdDirectoryInfo failed on the root: {}",
            os_error(code)
        )),
    }
}

/// The calling thread's own CPU time in seconds from `GetThreadTimes`
/// (kernel plus user); NaN when the call fails.
pub fn thread_cpu_seconds() -> f64 {
    // SAFETY: all-zero is a valid FILETIME.
    let mut creation: FILETIME = unsafe { std::mem::zeroed() };
    // SAFETY: as above.
    let mut exit: FILETIME = unsafe { std::mem::zeroed() };
    // SAFETY: as above.
    let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
    // SAFETY: as above.
    let mut user: FILETIME = unsafe { std::mem::zeroed() };
    // SAFETY: GetCurrentThread's pseudo-handle is always valid for the
    // calling thread; the four pointers are live, writable FILETIMEs owned
    // by this frame. The call only reads the thread.
    let ok = unsafe {
        GetThreadTimes(
            GetCurrentThread(),
            &raw mut creation,
            &raw mut exit,
            &raw mut kernel,
            &raw mut user,
        )
    };
    if ok == 0 {
        return f64::NAN;
    }
    (ticks(kernel).saturating_add(ticks(user))) as f64 / TICKS_PER_SECOND_F64
}

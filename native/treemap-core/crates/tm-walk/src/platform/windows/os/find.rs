//! The `FindFirstFileExW` fallback, read in parts (T6b). Moved out of
//! `os.rs` unchanged.

use std::ffi::c_void;
use std::path::Path;
use std::ptr;

use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::Storage::FileSystem::{
    FIND_FIRST_EX_LARGE_FETCH, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW,
    FindNextFileW, WIN32_FIND_DATAW,
};

use super::{FileReparse, FindHandle, last_error, size_of_parts, ticks, wide};
use crate::platform::windows::{
    DirFacts, ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_FILES, ERROR_OPERATION_ABORTED, Record,
    is_dot_entry, stage_record,
};
use crate::platform::{ListBuffer, Listing};

/// Records per batch of the `FindNextFileW` fallback, which answers one
/// record per call: the walk's stop flag is checked before each batch and
/// its heartbeat bumped after it, as `list_extd` does per call, and the
/// last, partial batch beats when the search ends. The same cadence as
/// macOS's per-entry fallback.
const FIND_BATCH: usize = 256;

/// Where a `FindFirstFileExW` listing stands between two steps (T6b): its
/// open search, the record it answered last (not yet staged), and the
/// answers since the last beat. Dropping it closes the search.
pub(super) struct FindAt {
    find: FindHandle,
    data: Box<WIN32_FIND_DATAW>,
    in_batch: usize,
}

/// How a step of a `FindFirstFileExW` listing ended other than with an error.
pub(super) enum FindStep {
    /// The search is done.
    Done,
    /// The listing holds its limit: where it goes on from.
    Stopped(FindAt),
}

/// The fallback: `FindFirstFileExW` over `dir\*`, staging each record into
/// `buf.listing`; no allocation size and no file id, so no leaf keys a
/// hard link (RISKS R55). The walk's two signals are paced by [`FIND_BATCH`].
/// Its first step: the search opened, then [`find_step`].
pub(super) fn find_start(
    dir: &Path,
    facts: DirFacts,
    buf: &mut ListBuffer,
    limit: usize,
) -> Result<FindStep, u32> {
    if buf.stopped() {
        // The walk discards the listing on cancel, so which error ends it is immaterial.
        return Err(ERROR_OPERATION_ABORTED);
    }
    let pattern = wide(&dir.join("*"))?;
    // SAFETY: all-zero is a valid WIN32_FIND_DATAW.
    let mut data: Box<WIN32_FIND_DATAW> = Box::new(unsafe { std::mem::zeroed() });
    // SAFETY: `pattern` is NUL-terminated; the pointer is a writable
    // WIN32_FIND_DATAW, which is what FindExInfoBasic fills; no search
    // filter is passed, as FindExSearchNameMatch requires.
    let handle = unsafe {
        FindFirstFileExW(
            pattern.as_ptr(),
            FindExInfoBasic,
            (&raw mut *data).cast::<c_void>(),
            FindExSearchNameMatch,
            ptr::null(),
            FIND_FIRST_EX_LARGE_FETCH,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let code = last_error();
        // A volume root with nothing in it has no `.` either; that answer beats too.
        return if code == ERROR_FILE_NOT_FOUND {
            buf.beat();
            Ok(FindStep::Done)
        } else {
            Err(code)
        };
    }
    let at = FindAt {
        find: FindHandle(handle),
        data,
        in_batch: 0,
    };
    find_step(at, dir, facts, buf, limit)
}

/// Stages the search's records from `at` on, until the search is done or
/// the listing holds `limit` entries.
pub(super) fn find_step(
    mut at: FindAt,
    dir: &Path,
    facts: DirFacts,
    buf: &mut ListBuffer,
    limit: usize,
) -> Result<FindStep, u32> {
    let limit = limit.max(1);
    let mut name = Vec::new();
    loop {
        if buf.listing.len() >= limit {
            return Ok(FindStep::Stopped(at));
        }
        stage_find(&at.data, &mut name, facts, dir, &mut buf.listing);
        at.in_batch += 1;
        if at.in_batch == FIND_BATCH {
            buf.beat();
            at.in_batch = 0;
            if buf.stopped() {
                // As above: the walk discards a cancelled listing.
                return Err(ERROR_OPERATION_ABORTED);
            }
        }
        // SAFETY: `at.find` is an open search handle and `at.data` a writable
        // WIN32_FIND_DATAW.
        let ok = unsafe { FindNextFileW(at.find.0, &raw mut *at.data) };
        if ok == 0 {
            let code = last_error();
            return if code == ERROR_NO_MORE_FILES {
                // The end is an answer too: the last, partial batch beats here.
                buf.beat();
                Ok(FindStep::Done)
            } else {
                Err(code)
            };
        }
    }
}

fn stage_find(
    data: &WIN32_FIND_DATAW,
    name: &mut Vec<u8>,
    facts: DirFacts,
    dir: &Path,
    out: &mut Listing,
) {
    let len = data
        .cFileName
        .iter()
        .position(|u| *u == 0)
        .unwrap_or(data.cFileName.len());
    name.clear();
    name.extend(
        data.cFileName
            .iter()
            .take(len)
            .flat_map(|u| u.to_le_bytes()),
    );
    if is_dot_entry(name) {
        return;
    }
    let record = Record {
        name,
        attributes: data.dwFileAttributes,
        reparse_tag: data.dwReserved0,
        end_of_file: i64::try_from(size_of_parts(data.nFileSizeHigh, data.nFileSizeLow))
            .unwrap_or(i64::MAX),
        allocation: None,
        last_write: ticks(data.ftLastWriteTime),
        last_access: ticks(data.ftLastAccessTime),
        file_id: None,
    };
    stage_record(&record, facts, dir, &FileReparse, out);
}

//! POSIX: `mmap(MAP_ANONYMOUS | MAP_PRIVATE)` and `munmap`.

use std::ptr::{self, NonNull};

/// A new private anonymous mapping of `bytes`, or the error number.
pub(super) fn map(bytes: usize) -> Result<NonNull<u8>, i32> {
    // SAFETY: with a null hint and without `MAP_FIXED`, `mmap` places the mapping in
    // address space nothing uses, so it changes no memory anything else can reach; an
    // anonymous mapping takes the descriptor -1 and the offset 0.
    let start = unsafe {
        libc::mmap(
            ptr::null_mut(),
            bytes,
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
            -1,
            0,
        )
    };
    if start == libc::MAP_FAILED {
        return Err(super::last_error());
    }
    refuse_huge_pages(start, bytes);
    // Without `MAP_FIXED` the kernel does not place a mapping at address 0.
    NonNull::new(start.cast::<u8>()).ok_or(libc::ENOMEM)
}

/// Linux can back an anonymous mapping with transparent huge pages, 2 MiB at a time, and
/// it merges neighbouring anonymous mappings into one region, so a huge page faulted in
/// for one column can make the next column's untouched pages resident: seen on CI's
/// Linux legs, 26 Sep 2026, 0.5–1.1 MB of a name pool past its room. A column's memory
/// is the pages its rows were written to (decision P4-11), so the mapping refuses huge
/// pages. The advice changes no memory, and a mapping is correct without it: a kernel
/// built without huge pages refuses it (`EINVAL`), and that refusal is not an error here.
#[cfg(target_os = "linux")]
fn refuse_huge_pages(start: *mut libc::c_void, bytes: usize) {
    // SAFETY: advice on the whole of a mapping `mmap` just made; it reads and writes no
    // memory, and nothing else holds the mapping yet.
    unsafe { libc::madvise(start, bytes, libc::MADV_NOHUGEPAGE) };
}

/// Elsewhere there are no transparent huge pages to refuse.
#[cfg(not(target_os = "linux"))]
fn refuse_huge_pages(_start: *mut libc::c_void, _bytes: usize) {}

/// [`map`]: an anonymous mapping is backed by memory only as its pages are first
/// written, so reserving is mapping.
pub(super) fn reserve(bytes: usize) -> Result<NonNull<u8>, i32> {
    map(bytes)
}

/// Nothing to do: every page of a mapping is usable, and backed when first written.
///
/// # Safety
///
/// As on Windows: `start..start + bytes` lies inside a live mapping `reserve` made.
#[expect(
    clippy::unnecessary_wraps,
    reason = "the Windows twin can fail, and the one caller serves both"
)]
pub(super) unsafe fn commit(_start: *mut u8, _bytes: usize) -> Result<(), i32> {
    Ok(())
}

/// Releases the mapping; whether the OS did.
///
/// # Safety
///
/// `start` and `bytes` are a mapping `map` made that has not been released, and nothing
/// reads or writes it any more.
pub(super) unsafe fn unmap(start: NonNull<u8>, bytes: usize) -> bool {
    // SAFETY: the caller hands over a whole live mapping that nothing uses.
    unsafe { libc::munmap(start.as_ptr().cast(), bytes) == 0 }
}

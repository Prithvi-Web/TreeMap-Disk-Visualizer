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
    // Without `MAP_FIXED` the kernel does not place a mapping at address 0.
    NonNull::new(start.cast::<u8>()).ok_or(libc::ENOMEM)
}

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

//! Windows: `VirtualAlloc(MEM_RESERVE | MEM_COMMIT)`, or `MEM_RESERVE` and then
//! `MEM_COMMIT` page range by page range, and `VirtualFree(MEM_RELEASE)`.

use std::ffi::c_void;
use std::ptr::{self, NonNull};

// Declared here rather than taken from windows-sys, whose `Win32_System_Memory` feature no
// crate in this workspace enables; the signatures are those of <memoryapi.h>, as
// windows-sys 0.61 declares them, and the constants those of <winnt.h>.
#[link(name = "kernel32")]
unsafe extern "system" {
    fn VirtualAlloc(
        address: *const c_void,
        size: usize,
        allocation_type: u32,
        protect: u32,
    ) -> *mut c_void;
    fn VirtualFree(address: *mut c_void, size: usize, free_type: u32) -> i32;
}

const MEM_COMMIT: u32 = 0x1000;
const MEM_RESERVE: u32 = 0x2000;
const MEM_RELEASE: u32 = 0x8000;
const PAGE_READWRITE: u32 = 0x04;

/// A new region of `bytes`, reserved and committed, or the error number.
pub(super) fn map(bytes: usize) -> Result<NonNull<u8>, i32> {
    // SAFETY: with a null address `VirtualAlloc` reserves and commits a new region where
    // the system chooses, so it changes no memory anything else can reach.
    let start =
        unsafe { VirtualAlloc(ptr::null(), bytes, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE) };
    NonNull::new(start.cast::<u8>()).ok_or_else(super::last_error)
}

/// A new region of `bytes`, reserved and not committed: it charges nothing against
/// the machine's commit limit until [`commit`] commits its pages. Or the error number.
pub(super) fn reserve(bytes: usize) -> Result<NonNull<u8>, i32> {
    // SAFETY: with a null address `VirtualAlloc` reserves a new region where the system
    // chooses, so it changes no memory anything else can reach.
    let start = unsafe { VirtualAlloc(ptr::null(), bytes, MEM_RESERVE, PAGE_READWRITE) };
    NonNull::new(start.cast::<u8>()).ok_or_else(super::last_error)
}

/// Commits every page holding a byte of `start..start + bytes`. A page already
/// committed keeps its contents; a page committed now reads as zeros. Several threads
/// may commit overlapping pages at once: the system serialises the calls.
///
/// # Safety
///
/// `start..start + bytes` lies inside a region `reserve` made that has not been
/// released.
pub(super) unsafe fn commit(start: *mut u8, bytes: usize) -> Result<(), i32> {
    // SAFETY: the caller hands over a range inside a live reserved region; committing
    // its pages changes the contents of none that were committed already.
    let done =
        unsafe { VirtualAlloc(start.cast_const().cast(), bytes, MEM_COMMIT, PAGE_READWRITE) };
    if done.is_null() {
        Err(super::last_error())
    } else {
        Ok(())
    }
}

/// Releases the region; whether the OS did.
///
/// # Safety
///
/// `start` is the base of a region `map` made that has not been released, and nothing
/// reads or writes it any more.
pub(super) unsafe fn unmap(start: NonNull<u8>, _bytes: usize) -> bool {
    // SAFETY: the caller hands over the base address `VirtualAlloc` returned for a live
    // region that nothing uses; `MEM_RELEASE` frees the whole region and takes the size 0.
    unsafe { VirtualFree(start.as_ptr().cast(), 0, MEM_RELEASE) != 0 }
}

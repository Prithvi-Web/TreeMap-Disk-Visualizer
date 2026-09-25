//! One column of the store, and the anonymous mappings large columns live in.

use std::alloc::{Layout, handle_alloc_error};
use std::cell::Cell;
use std::fmt;
use std::marker::PhantomData;
use std::ptr::NonNull;

/// One column: its rows, and room for the store's headroom after them.
///
/// Plain Node accepts external typed arrays, so a column can reach JavaScript with no copy.
/// Electron 31, the desktop app, refuses them (`napi_no_external_buffers_allowed`), and
/// napi-rs 3.4 then copies the rows into memory V8 allocates, so there every column is
/// copied (RISKS R72, measured 23 Sep 2026).
///
/// Two columns are equal when their rows are, wherever the rows live; their room is not
/// compared, as `Vec`'s equality does not compare capacity.
#[derive(Clone, Debug)]
pub enum Column<T: Zeroable> {
    /// Rows in a `Vec` whose allocation has room for the store's headroom.
    Owned(Vec<T>),
    /// Rows in an anonymous mapping of their own (decision P4-11), which the OS fills with
    /// zeros and takes back whole when the column is dropped.
    Anon(AnonRows<T>),
}

impl<T: Zeroable> Column<T> {
    /// A column in an anonymous mapping with room for `capacity` rows, holding the first
    /// `len` of them. Every row reads as zero until it is written.
    pub fn anon(len: usize, capacity: usize) -> Result<Self, ColumnError> {
        AnonRows::new(len, capacity).map(Self::Anon)
    }

    /// The rows.
    pub fn as_slice(&self) -> &[T] {
        match self {
            Self::Owned(rows) => rows,
            Self::Anon(rows) => rows.as_slice(),
        }
    }

    /// The rows, to write.
    pub fn as_mut_slice(&mut self) -> &mut [T] {
        match self {
            Self::Owned(rows) => rows,
            Self::Anon(rows) => rows.as_mut_slice(),
        }
    }

    /// How many rows there are.
    pub fn len(&self) -> usize {
        self.as_slice().len()
    }

    /// Whether there are none.
    pub fn is_empty(&self) -> bool {
        self.as_slice().is_empty()
    }

    /// How many rows the allocation holds without growing.
    pub fn capacity(&self) -> usize {
        match self {
            Self::Owned(rows) => rows.capacity(),
            Self::Anon(rows) => rows.capacity,
        }
    }

    /// The rows and the headroom after them, `capacity()` rows in all: the headroom of an
    /// anonymous column reads as zero. `None` for an owned column, whose headroom is
    /// uninitialised.
    pub fn with_headroom(&self) -> Option<&[T]> {
        match self {
            Self::Owned(_) => None,
            Self::Anon(rows) => Some(rows.with_headroom()),
        }
    }
}

impl<T: Zeroable + PartialEq> PartialEq for Column<T> {
    fn eq(&self, other: &Self) -> bool {
        self.as_slice() == other.as_slice()
    }
}

/// A row type a column can keep in pages the OS fills with zeros.
///
/// # Safety
///
/// An implementation promises that `size_of::<Self>()` zero bytes are a valid `Self`, and
/// that `align_of::<Self>()` divides 4096, which divides every page size a mapping starts on
/// here. `Copy` means a row is never dropped, so releasing a mapping drops nothing.
pub unsafe trait Zeroable: Copy {}

// SAFETY: zero bytes are the integer 0; the alignment is 1.
unsafe impl Zeroable for u8 {}
// SAFETY: zero bytes are the integer 0; the alignment is 2.
unsafe impl Zeroable for u16 {}
// SAFETY: zero bytes are the integer 0; the alignment is 4.
unsafe impl Zeroable for u32 {}
// SAFETY: zero bytes are the integer 0; the alignment is 4.
unsafe impl Zeroable for i32 {}
// SAFETY: zero bytes are +0.0 (IEEE 754); the alignment is 8.
unsafe impl Zeroable for f64 {}

/// Why an anonymous column could not be made.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ColumnError {
    /// More rows asked for than the room asked for.
    #[error("{len} rows do not fit a column with room for {capacity}")]
    LenPastCapacity {
        /// The rows asked for.
        len: usize,
        /// The room asked for.
        capacity: usize,
    },
    /// The room asked for spans more bytes than one slice may (`isize::MAX`).
    #[error("{rows} rows of {row_bytes} bytes are more than one mapping can hold")]
    TooLarge {
        /// The room asked for.
        rows: usize,
        /// The bytes in one row.
        row_bytes: usize,
    },
    /// The OS refused the mapping.
    #[error("the OS refused to map {bytes} bytes of anonymous memory (OS error {code})")]
    MapFailed {
        /// The bytes asked for.
        bytes: usize,
        /// The OS's error number (`errno`, or `GetLastError` on Windows).
        code: i32,
    },
}

/// Rows in an anonymous mapping that nothing else uses: `capacity` rows of room, the first
/// `len` of them the column's rows. The mapping is released when this is dropped.
pub struct AnonRows<T: Zeroable> {
    /// The mapping's first byte; dangling, with nothing mapped, when `bytes` is 0.
    start: NonNull<T>,
    len: usize,
    capacity: usize,
    /// `capacity` rows of bytes: what was mapped, and what is released.
    bytes: usize,
    rows: PhantomData<T>,
}

impl<T: Zeroable> AnonRows<T> {
    fn new(len: usize, capacity: usize) -> Result<Self, ColumnError> {
        if len > capacity {
            return Err(ColumnError::LenPastCapacity { len, capacity });
        }
        let bytes = capacity
            .checked_mul(size_of::<T>())
            .filter(|&bytes| isize::try_from(bytes).is_ok())
            .ok_or(ColumnError::TooLarge {
                rows: capacity,
                row_bytes: size_of::<T>(),
            })?;
        let start = if bytes == 0 {
            NonNull::dangling()
        } else {
            map_zeroed(bytes)?.cast::<T>()
        };
        Ok(Self {
            start,
            len,
            capacity,
            bytes,
            rows: PhantomData,
        })
    }

    fn as_slice(&self) -> &[T] {
        // SAFETY: `start` is aligned for `T`: a mapping starts on a page boundary, and
        // `Zeroable` promises the alignment divides every page size, while a dangling
        // pointer is aligned by construction. The mapping spans `capacity` rows, at most
        // `isize::MAX` bytes (checked in `new`), and `len <= capacity`; with `bytes` 0 the
        // slice spans no bytes. Each row is a valid `T`: the OS zero-filled the pages, zero
        // bytes are a `T` (`Zeroable`), and anything written since was written as a `T`.
        // `&self` keeps `as_mut_slice` from lending the rows until this borrow ends, and
        // nothing else points into the mapping.
        unsafe { std::slice::from_raw_parts(self.start.as_ptr(), self.len) }
    }

    fn as_mut_slice(&mut self) -> &mut [T] {
        // SAFETY: as in `as_slice`; and `&mut self` makes this the only borrow of the rows.
        unsafe { std::slice::from_raw_parts_mut(self.start.as_ptr(), self.len) }
    }

    fn with_headroom(&self) -> &[T] {
        // SAFETY: as in `as_slice`, for all `capacity` rows the mapping spans; the rows past
        // `len` were never written, so they are the zeros the OS filled them with.
        unsafe { std::slice::from_raw_parts(self.start.as_ptr(), self.capacity) }
    }
}

impl<T: Zeroable> Clone for AnonRows<T> {
    /// A mapping of its own with the same room and rows. When the OS refuses the mapping the
    /// process is stopped through `handle_alloc_error`, as `Vec`'s clone stops it when the
    /// allocator refuses.
    fn clone(&self) -> Self {
        let Ok(mut copy) = Self::new(self.len, self.capacity) else {
            match Layout::from_size_align(self.bytes, align_of::<T>()) {
                Ok(layout) => handle_alloc_error(layout),
                Err(_) => std::process::abort(),
            }
        };
        copy.as_mut_slice().copy_from_slice(self.as_slice());
        copy
    }
}

impl<T: Zeroable + fmt::Debug> fmt::Debug for AnonRows<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AnonRows")
            .field("capacity", &self.capacity)
            .field("rows", &self.as_slice())
            .finish_non_exhaustive()
    }
}

impl<T: Zeroable> Drop for AnonRows<T> {
    fn drop(&mut self) {
        if self.bytes > 0 {
            // SAFETY: `start` and `bytes` are the mapping `map_zeroed` made in `new`, which
            // only this value owns and nothing has released: `drop` runs once, and every
            // slice of the mapping borrowed from `self` has ended.
            unsafe { unmap(self.start.cast::<u8>(), self.bytes) };
        }
    }
}

// SAFETY: an `AnonRows` is the only owner of its mapping, as a `Vec` is of its buffer, so
// moving it to another thread moves that ownership; a mapping can be released from any
// thread (`munmap`, `VirtualFree`).
unsafe impl<T: Zeroable + Send> Send for AnonRows<T> {}

// SAFETY: a shared `AnonRows` lends only `&[T]`, which threads may share when `T: Sync`.
unsafe impl<T: Zeroable + Sync> Sync for AnonRows<T> {}

/// What one thread has mapped and released for anonymous columns since it started.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct AnonTally {
    /// Mappings made.
    pub maps: u64,
    /// Mappings released.
    pub unmaps: u64,
    /// Bytes asked for by the mappings made (the OS maps whole pages).
    pub bytes_mapped: u64,
    /// Bytes asked for by the mappings released.
    pub bytes_unmapped: u64,
}

thread_local! {
    static TALLY: Cell<AnonTally> = const {
        Cell::new(AnonTally {
            maps: 0,
            unmaps: 0,
            bytes_mapped: 0,
            bytes_unmapped: 0,
        })
    };
}

/// This thread's [`AnonTally`]. A mapping is counted on the thread that made it, and its
/// release on the thread that dropped the column.
pub fn anon_tally() -> AnonTally {
    TALLY.try_with(Cell::get).unwrap_or_default()
}

/// Adds one mapping of `bytes` to this thread's tally, as made or as released.
fn tally(bytes: usize, released: bool) {
    let bytes = u64::try_from(bytes).unwrap_or(u64::MAX);
    // `try_with` fails only while the thread's locals are being destroyed; the mapping is
    // then left out of a tally nobody can read any more.
    let _ = TALLY.try_with(|cell| {
        let mut now = cell.get();
        if released {
            now.unmaps = now.unmaps.saturating_add(1);
            now.bytes_unmapped = now.bytes_unmapped.saturating_add(bytes);
        } else {
            now.maps = now.maps.saturating_add(1);
            now.bytes_mapped = now.bytes_mapped.saturating_add(bytes);
        }
        cell.set(now);
    });
}

/// Maps `bytes` (more than 0) of memory private to this process, filled with zeros by the
/// OS, starting on a page boundary.
fn map_zeroed(bytes: usize) -> Result<NonNull<u8>, ColumnError> {
    let start = sys::map(bytes).map_err(|code| ColumnError::MapFailed { bytes, code })?;
    tally(bytes, false);
    Ok(start)
}

/// Releases a mapping `map_zeroed` made. A release the OS refuses stays out of the tally.
///
/// # Safety
///
/// `start` and `bytes` are a mapping `map_zeroed` made that has not been released, and
/// nothing reads or writes it any more.
unsafe fn unmap(start: NonNull<u8>, bytes: usize) {
    // SAFETY: the caller's promise is the one `sys::unmap` asks for.
    if unsafe { sys::unmap(start, bytes) } {
        tally(bytes, true);
    }
}

/// The OS's error number for the call that just failed.
fn last_error() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

#[cfg(unix)]
mod sys {
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
}

#[cfg(windows)]
mod sys {
    //! Windows: `VirtualAlloc(MEM_RESERVE | MEM_COMMIT)` and `VirtualFree(MEM_RELEASE)`.

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
}

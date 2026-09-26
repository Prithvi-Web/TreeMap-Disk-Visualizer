//! One column of the store, and the anonymous mappings large columns live in.
//!
//! A column the memory sink fills during the walk is reserved whole
//! (`AnonRows::reserve`) and written from several threads at once through one narrow
//! unsafe API, `AnonRows::with_rows_mut`, each thread at the rows its block reserved;
//! `AnonRows::settle` then makes it a column of `n` rows. All three are the crate's own.

use std::alloc::{Layout, handle_alloc_error};
use std::cell::Cell;
use std::fmt;
use std::marker::PhantomData;
use std::ops::Range;
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
    /// Rows asked for that are not all in the column's room.
    #[error("rows {start}..{end} are not in the column's room for {room}")]
    RowsPastRoom {
        /// The first row asked for.
        start: usize,
        /// One past the last row asked for.
        end: usize,
        /// The rows the column has room for.
        room: usize,
    },
    /// The OS refused to commit the pages of rows reserved for later (Windows: the
    /// machine's commit limit is reached).
    #[error("the OS refused to commit {bytes} bytes of reserved memory (OS error {code})")]
    CommitFailed {
        /// The bytes asked for.
        bytes: usize,
        /// The OS's error number (`GetLastError`).
        code: i32,
    },
}

/// Rows in an anonymous mapping that nothing else uses: `capacity` rows of room, the first
/// `len` of them the column's rows. The mapping is released when this is dropped.
pub struct AnonRows<T: Zeroable> {
    /// The mapping's first byte; dangling, with nothing mapped, when `bytes` is 0.
    start: NonNull<T>,
    len: usize,
    /// The rows of room: every one of them mapped, and committed unless `lazy`.
    capacity: usize,
    /// The bytes mapped: what is released. At least `capacity` rows of them, and more
    /// once [`AnonRows::settle`] has narrowed the room.
    bytes: usize,
    /// Whether the room's pages are committed only as rows are handed out (Windows, for
    /// a column made by [`AnonRows::reserve`]); always false elsewhere.
    lazy: bool,
    rows: PhantomData<T>,
}

impl<T: Zeroable> AnonRows<T> {
    fn new(len: usize, capacity: usize) -> Result<Self, ColumnError> {
        if len > capacity {
            return Err(ColumnError::LenPastCapacity { len, capacity });
        }
        let bytes = Self::bytes_for(capacity)?;
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
            lazy: false,
            rows: PhantomData,
        })
    }

    /// Room for `capacity` rows, none of them the column's yet, backed by memory only
    /// as rows are written. POSIX maps anonymous pages lazily anyway: a page is resident
    /// once written. Windows would charge the machine's commit limit for every page of a
    /// committed region at once, written or not, so there the address space is reserved
    /// and [`AnonRows::with_rows_mut`] commits the pages of the rows it hands out.
    pub(crate) fn reserve(capacity: usize) -> Result<Self, ColumnError> {
        let bytes = Self::bytes_for(capacity)?;
        let start = if bytes == 0 {
            NonNull::dangling()
        } else {
            reserve_zeroed(bytes)?.cast::<T>()
        };
        Ok(Self {
            start,
            len: 0,
            capacity,
            bytes,
            lazy: cfg!(windows) && bytes > 0,
            rows: PhantomData,
        })
    }

    /// The bytes `rows` rows take, or `TooLarge` past what one slice may span.
    fn bytes_for(rows: usize) -> Result<usize, ColumnError> {
        rows.checked_mul(size_of::<T>())
            .filter(|&bytes| isize::try_from(bytes).is_ok())
            .ok_or(ColumnError::TooLarge {
                rows,
                row_bytes: size_of::<T>(),
            })
    }

    /// Hands `write` the rows `rows` of the room to read and write, through a shared
    /// reference: the one way the memory sink's workers write their blocks side by side.
    /// Refused, with nothing handed out, when the rows are not all in the room, or (on
    /// Windows) when the OS will not commit their pages.
    ///
    /// # Safety
    ///
    /// While `write` runs, no other thread reads or writes any of `rows`, and nothing holds
    /// a slice of this column's rows (`as_slice`, `as_mut_slice`, `with_headroom`). A
    /// thread that reads these rows later does so after this call returns, in
    /// happens-before order (through a lock, a queue or a join).
    pub(crate) unsafe fn with_rows_mut<R>(
        &self,
        rows: Range<usize>,
        write: impl FnOnce(&mut [T]) -> R,
    ) -> Result<R, ColumnError> {
        let Range { start, end } = rows;
        if start > end || end > self.capacity {
            return Err(ColumnError::RowsPastRoom {
                start,
                end,
                room: self.capacity,
            });
        }
        if start == end {
            return Ok(write(&mut []));
        }
        // SAFETY: `start < end <= capacity`, so the offset stays inside the mapping, which
        // spans `capacity` rows (at most `isize::MAX` bytes, checked when it was made).
        let first = unsafe { self.start.as_ptr().add(start) };
        self.commit(first.cast::<u8>(), (end - start) * size_of::<T>())?;
        // SAFETY: the rows `start..end` lie inside the mapping, are aligned for `T` (the
        // mapping starts on a page, `Zeroable` promises `T`'s alignment divides it, and the
        // offset is a whole number of rows) and are committed (just above, where it is
        // lazy). Each is a valid `T`: the OS zero-filled them, zero bytes are a `T`
        // (`Zeroable`), and anything written since was written as a `T`. The caller
        // promises that nobody else reads or writes them while `write` runs, so this is the
        // only reference to them, and the slice cannot outlive the call.
        let rows = unsafe { std::slice::from_raw_parts_mut(first, end - start) };
        Ok(write(rows))
    }

    /// Commits the pages holding `bytes` bytes from `first`, where the room is committed
    /// lazily; nothing to do elsewhere.
    fn commit(&self, first: *mut u8, bytes: usize) -> Result<(), ColumnError> {
        if !self.lazy || bytes == 0 {
            return Ok(());
        }
        // SAFETY: the callers pass a range inside the room, which lies inside the region
        // `reserve` made and nothing has released: this value owns it until it drops.
        unsafe { sys::commit(first, bytes) }
            .map_err(|code| ColumnError::CommitFailed { bytes, code })
    }

    /// Makes the first `len` rows the column's rows and the first `room` its room: rows
    /// past `room` are never lent again, though they stay mapped until the column is
    /// dropped. Where the room is committed lazily, its pages are committed through `room`
    /// first, so every row lent afterwards reads as a `T`: written, or zero.
    pub(crate) fn settle(&mut self, len: usize, room: usize) -> Result<(), ColumnError> {
        if room > self.capacity {
            return Err(ColumnError::RowsPastRoom {
                start: 0,
                end: room,
                room: self.capacity,
            });
        }
        if len > room {
            return Err(ColumnError::LenPastCapacity {
                len,
                capacity: room,
            });
        }
        self.commit(self.start.as_ptr().cast::<u8>(), room * size_of::<T>())?;
        self.len = len;
        self.capacity = room;
        // Every row of the room is committed now.
        self.lazy = false;
        Ok(())
    }

    fn as_slice(&self) -> &[T] {
        // SAFETY: `start` is aligned for `T`: a mapping starts on a page boundary, and
        // `Zeroable` promises the alignment divides every page size, while a dangling
        // pointer is aligned by construction. The mapping spans `capacity` rows, at most
        // `isize::MAX` bytes (checked in `new`), and `len <= capacity`; with `bytes` 0 the
        // slice spans no bytes. The rows are committed: all `capacity` of them unless the
        // column is `lazy`, and a lazy column has no rows (`reserve` makes it with `len`
        // 0, and `settle`, the one place `len` grows, commits the room and ends the
        // laziness). Each row is a valid `T`: the OS zero-filled the pages, zero bytes are
        // a `T` (`Zeroable`), and anything written since was written as a `T`. `&self`
        // keeps `as_mut_slice` from lending the rows until this borrow ends, and
        // `with_rows_mut`'s callers promise to hold none of its slices meanwhile.
        unsafe { std::slice::from_raw_parts(self.start.as_ptr(), self.len) }
    }

    fn as_mut_slice(&mut self) -> &mut [T] {
        // SAFETY: as in `as_slice`; and `&mut self` makes this the only borrow of the rows.
        unsafe { std::slice::from_raw_parts_mut(self.start.as_ptr(), self.len) }
    }

    fn with_headroom(&self) -> &[T] {
        // A lazy column's room is not all committed yet: it has no rows to show.
        let rows = if self.lazy { 0 } else { self.capacity };
        // SAFETY: as in `as_slice`, for `rows` rows: all `capacity` rows the mapping spans,
        // each committed and a valid `T` (zero-filled by the OS, or written as a `T`), when
        // the column is not lazy, and none when it is.
        unsafe { std::slice::from_raw_parts(self.start.as_ptr(), rows) }
    }

    /// The start of the rows and the headroom after them, and how many there are — every
    /// row the mapping spans, or none while the column is lazy — for lending the mapping
    /// to an owner outside Rust (the napi hand-over, T8b). Taking them is safe; using them
    /// is the owner's promise: it keeps the column alive while it holds them, reads and
    /// writes only whole `T`s below the count, and leaves the column itself unused
    /// meanwhile.
    pub fn room_mut(&mut self) -> (NonNull<T>, usize) {
        let rows = if self.lazy { 0 } else { self.capacity };
        (self.start, rows)
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

// SAFETY: a shared `AnonRows` lends `&[T]`, which threads may share when `T: Sync`, and,
// through the unsafe `with_rows_mut`, `&mut [T]` over rows whose callers promise no other
// thread touches them meanwhile and orders every later read after the write; a value
// written on one thread and read on another has then moved between them, which `T: Send`
// allows.
unsafe impl<T: Zeroable + Send + Sync> Sync for AnonRows<T> {}

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

/// [`map_zeroed`], with the pages backed only as they are committed: on Windows the
/// address space alone is reserved (see [`AnonRows::reserve`]). Counted as a mapping.
fn reserve_zeroed(bytes: usize) -> Result<NonNull<u8>, ColumnError> {
    let start = sys::reserve(bytes).map_err(|code| ColumnError::MapFailed { bytes, code })?;
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
#[path = "column/sys_unix.rs"]
mod sys;

#[cfg(windows)]
#[path = "column/sys_windows.rs"]
mod sys;

#[cfg(test)]
mod tests {
    //! The writer API the memory sink writes its columns through: rows handed out by
    //! range from a shared reference, refused past the room, and settled into a column.

    use super::*;

    type TestResult = Result<(), ColumnError>;

    /// A row value that is not zero, for row `i`.
    fn value(i: usize) -> u32 {
        u32::try_from(i % 1_000 + 1).unwrap_or(1)
    }

    #[test]
    fn written_rows_read_back_and_every_other_row_reads_zero_once_settled() -> TestResult {
        let mut rows = AnonRows::<u32>::reserve(10_000)?;
        assert_eq!(
            (rows.len, rows.capacity),
            (0, 10_000),
            "no rows yet, all room"
        );
        // SAFETY: nothing else reads or writes the column: this thread owns it.
        unsafe {
            rows.with_rows_mut(3_000..3_500, |written| {
                for (i, row) in (3_000..).zip(written.iter_mut()) {
                    *row = value(i);
                }
            })?;
        }
        rows.settle(4_000, 6_000)?;
        assert_eq!(rows.as_slice().len(), 4_000);
        for (i, &row) in rows.as_slice().iter().enumerate() {
            let expected = if (3_000..3_500).contains(&i) {
                value(i)
            } else {
                0
            };
            assert_eq!(row, expected, "row {i}");
        }
        assert_eq!(rows.capacity, 6_000, "the room is what was settled");
        assert_eq!(rows.with_headroom().len(), 6_000);
        assert!(
            rows.with_headroom()
                .get(4_000..)
                .is_some_and(|h| h.iter().all(|&r| r == 0)),
            "the headroom reads as zero"
        );
        Ok(())
    }

    #[test]
    fn rows_past_the_room_are_refused_and_left_unwritten() -> TestResult {
        let mut rows = AnonRows::<u16>::reserve(100)?;
        let mut called = false;
        // SAFETY: this thread owns the column.
        let past = unsafe { rows.with_rows_mut(90..101, |_| called = true) };
        assert_eq!(
            past.err(),
            Some(ColumnError::RowsPastRoom {
                start: 90,
                end: 101,
                room: 100
            })
        );
        assert!(!called, "nothing is handed out for rows past the room");
        // SAFETY: this thread owns the column.
        let backwards = unsafe { rows.with_rows_mut(Range { start: 50, end: 40 }, |_| ()) };
        assert!(backwards.is_err(), "a range that runs backwards is refused");
        // An empty range at the end of the room is no row past it.
        // SAFETY: this thread owns the column.
        let empty = unsafe { rows.with_rows_mut(100..100, |none| none.len()) }?;
        assert_eq!(empty, 0);

        // Settled, the room is the new capacity: rows past it are refused.
        rows.settle(10, 20)?;
        // SAFETY: this thread owns the column.
        let after = unsafe { rows.with_rows_mut(15..21, |_| ()) };
        assert_eq!(
            after.err(),
            Some(ColumnError::RowsPastRoom {
                start: 15,
                end: 21,
                room: 20
            })
        );
        Ok(())
    }

    #[test]
    fn a_settle_past_the_room_is_refused_and_changes_nothing() -> TestResult {
        let mut rows = AnonRows::<f64>::reserve(64)?;
        assert_eq!(
            rows.settle(65, 65).err(),
            Some(ColumnError::RowsPastRoom {
                start: 0,
                end: 65,
                room: 64
            })
        );
        assert_eq!(
            rows.settle(33, 32).err(),
            Some(ColumnError::LenPastCapacity {
                len: 33,
                capacity: 32
            })
        );
        assert_eq!((rows.len, rows.capacity), (0, 64));
        Ok(())
    }

    #[test]
    fn threads_write_their_own_rows_side_by_side() -> Result<(), String> {
        const THREADS: usize = 8;
        const EACH: usize = 25_000;
        let mut rows = AnonRows::<u32>::reserve(THREADS * EACH).map_err(|e| e.to_string())?;
        let shared = &rows;
        let outcomes: Vec<Result<(), String>> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..THREADS)
                .map(|t| {
                    scope.spawn(move || {
                        let mine = t * EACH..(t + 1) * EACH;
                        // SAFETY: each thread writes its own `EACH` rows, which no other
                        // thread touches; the rows are read after `scope` joins every thread.
                        unsafe {
                            shared.with_rows_mut(mine.clone(), |written| {
                                for (i, row) in mine.zip(written.iter_mut()) {
                                    *row = value(i);
                                }
                            })
                        }
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| match handle.join() {
                    Ok(written) => written.map_err(|e| e.to_string()),
                    Err(_) => Err("a writer thread panicked".to_owned()),
                })
                .collect()
        });
        for outcome in outcomes {
            outcome?;
        }
        rows.settle(THREADS * EACH, THREADS * EACH)
            .map_err(|e| e.to_string())?;
        assert!(
            rows.as_slice()
                .iter()
                .enumerate()
                .all(|(i, &row)| row == value(i)),
            "every thread's rows read back"
        );
        Ok(())
    }

    #[test]
    fn a_reservation_is_counted_as_a_mapping_and_released_whole() -> TestResult {
        let before = anon_tally();
        let mut rows = AnonRows::<u32>::reserve(1_000)?;
        rows.settle(10, 20)?;
        drop(rows);
        let after = anon_tally();
        assert_eq!(after.maps - before.maps, 1);
        assert_eq!(after.unmaps - before.unmaps, 1);
        assert_eq!(after.bytes_mapped - before.bytes_mapped, 4_000);
        assert_eq!(
            after.bytes_unmapped - before.bytes_unmapped,
            4_000,
            "the whole reservation is released, not the settled room"
        );
        Ok(())
    }

    /// Windows commits a reserved column's pages as its rows are handed out, and at the
    /// settle through its room; the rest stays reserved, charging no commit.
    #[cfg(windows)]
    #[test]
    fn a_reserved_column_commits_only_the_pages_it_hands_out_and_its_room() -> TestResult {
        use std::ffi::c_void;

        #[repr(C)]
        struct Info {
            _base_address: *mut c_void,
            _allocation_base: *mut c_void,
            _allocation_protect: u32,
            #[cfg(not(target_arch = "x86"))]
            _partition_id: u16,
            region_size: usize,
            state: u32,
            _protect: u32,
            _kind: u32,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn VirtualQuery(address: *const c_void, buffer: *mut Info, length: usize) -> usize;
        }
        const MEM_COMMIT_STATE: u32 = 0x1000;
        const MEM_RESERVE_STATE: u32 = 0x2000;
        fn state(address: *const u8) -> Option<u32> {
            let mut info = Info {
                _base_address: std::ptr::null_mut(),
                _allocation_base: std::ptr::null_mut(),
                _allocation_protect: 0,
                #[cfg(not(target_arch = "x86"))]
                _partition_id: 0,
                region_size: 0,
                state: 0,
                _protect: 0,
                _kind: 0,
            };
            // SAFETY: `VirtualQuery` reads no memory at `address`; it writes at most
            // `size_of::<Info>()` bytes into `info`, whose fields are integers and pointers.
            let written = unsafe { VirtualQuery(address.cast(), &raw mut info, size_of::<Info>()) };
            (written == size_of::<Info>()).then_some(info.state)
        }
        const PAGE: usize = 4096;
        // 64 pages of bytes; rows 10 pages in, one page long, handed out.
        let mut rows = AnonRows::<u8>::reserve(64 * PAGE)?;
        let base = rows.start.as_ptr().cast_const();
        // SAFETY: the offsets are inside the reservation of 64 pages.
        let at = |page: usize| unsafe { base.add(page * PAGE) };
        assert_eq!(
            state(at(10)),
            Some(MEM_RESERVE_STATE),
            "reserved, not committed"
        );
        // SAFETY: this thread owns the column.
        unsafe {
            rows.with_rows_mut(10 * PAGE..11 * PAGE, |page| page.fill(7))?;
        }
        assert_eq!(state(at(10)), Some(MEM_COMMIT_STATE), "the page handed out");
        assert_eq!(state(at(11)), Some(MEM_RESERVE_STATE), "the next page");
        assert_eq!(state(at(9)), Some(MEM_RESERVE_STATE), "the page before");
        // Rows in a page already committed and written are handed out again (two blocks
        // can share a page): committing it again keeps what was written there.
        let again = 10 * PAGE + 100..10 * PAGE + 200;
        // SAFETY: this thread owns the column.
        unsafe {
            rows.with_rows_mut(again.clone(), |some| some.fill(9))?;
        }
        rows.settle(20 * PAGE, 30 * PAGE)?;
        assert_eq!(
            state(at(0)),
            Some(MEM_COMMIT_STATE),
            "the rows are committed"
        );
        assert_eq!(state(at(29)), Some(MEM_COMMIT_STATE), "and the room");
        assert_eq!(state(at(30)), Some(MEM_RESERVE_STATE), "not past the room");
        assert!(rows.as_slice().iter().enumerate().all(|(i, &b)| {
            b == if again.contains(&i) {
                9
            } else if (10 * PAGE..11 * PAGE).contains(&i) {
                7
            } else {
                0
            }
        }));
        Ok(())
    }
}

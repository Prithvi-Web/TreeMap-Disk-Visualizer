//! `Column::Anon`: rows in an anonymous mapping of their own (decision P4-11), with the
//! heap counted by this test binary's own global allocator (the other test binaries keep
//! the system's) and the mappings counted by `anon_tally` and asked of the kernel: `msync`
//! on POSIX, `VirtualQuery` on Windows.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::fmt::Debug;
use std::sync::{Mutex, MutexGuard, PoisonError};

use tm_store::{AnonTally, Column, ColumnError, Zeroable, anon_tally};

type TestResult = Result<(), Box<dyn std::error::Error>>;

/// Rows written, and rows of room: neither a whole number of pages for any row type here.
const ROWS: usize = 999_999;
const CAPACITY: usize = 1_000_003;

/// The system allocator, counting the bytes asked for on a thread while it is watching.
struct Counting;

thread_local! {
    static WATCHING: Cell<bool> = const { Cell::new(false) };
    static ASKED: Cell<usize> = const { Cell::new(0) };
}

fn note(bytes: usize) {
    // `try_with`, not `with`: an allocator must not panic. An access that fails counts nothing.
    if WATCHING.try_with(Cell::get).unwrap_or(false) {
        let _ = ASKED.try_with(|asked| asked.set(asked.get().saturating_add(bytes)));
    }
}

// SAFETY: every method defined here hands its arguments unchanged to `System`, whose
// allocations these all are, so each keeps `System`'s guarantees. `alloc_zeroed` is the
// trait's own, which asks `alloc` and zeroes the block.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        note(layout.size());
        // SAFETY: the caller meets `alloc`'s contract for `layout`, as `System.alloc` needs.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: `ptr` was allocated by this allocator, which is `System`, with `layout`.
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        note(new_size);
        // SAFETY: `ptr` was allocated by `System` with `layout`, and the caller meets
        // `realloc`'s contract for `new_size`.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// The bytes this thread asks the allocator for while `run` runs, and its answer.
fn bytes_asked_during<T>(run: impl FnOnce() -> T) -> (T, usize) {
    ASKED.with(|asked| asked.set(0));
    WATCHING.with(|watching| watching.set(true));
    let answer = run();
    WATCHING.with(|watching| watching.set(false));
    (answer, ASKED.with(Cell::get))
}

/// Every test here maps memory, so they take turns: a test that asks the kernel whether a
/// released range is still mapped must not have another test's mapping land on it.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

fn turn() -> MutexGuard<'static, ()> {
    ONE_AT_A_TIME.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What changed in this thread's tally between two readings.
fn since(before: AnonTally, after: AnonTally) -> AnonTally {
    AnonTally {
        maps: after.maps - before.maps,
        unmaps: after.unmaps - before.unmaps,
        bytes_mapped: after.bytes_mapped - before.bytes_mapped,
        bytes_unmapped: after.bytes_unmapped - before.bytes_unmapped,
    }
}

/// Whether the kernel has every page of `[start, start + bytes)` mapped. `msync` answers
/// `ENOMEM` for a range with a page that is not mapped, and 0 for a mapped anonymous one.
#[cfg(unix)]
fn mapped(start: *const u32, bytes: usize) -> bool {
    // SAFETY: `msync` only asks the kernel about the range; it reads and writes no memory,
    // and a range that is no longer mapped is answered with an error, not touched.
    let answer = unsafe { libc::msync(start.cast_mut().cast(), bytes, libc::MS_ASYNC) };
    answer == 0
}

#[cfg(windows)]
mod region {
    //! Windows: what `VirtualQuery` says of the region holding an address.

    use std::ffi::c_void;
    use std::ptr;

    // Declared here, as `column.rs` declares `VirtualAlloc`, rather than taken from
    // windows-sys, whose `Win32_System_Memory` feature no crate in this workspace enables.
    // The signature and the layout (whose `PartitionId` x86 lacks) are windows-sys 0.61's;
    // the constants are those of <winnt.h>.

    /// `MEMORY_BASIC_INFORMATION`.
    #[repr(C)]
    pub struct Info {
        _base_address: *mut c_void,
        /// The address the allocation holding the page starts at.
        pub allocation_base: *mut c_void,
        _allocation_protect: u32,
        #[cfg(not(target_arch = "x86"))]
        _partition_id: u16,
        /// Bytes, from the page holding the address, in which every page has the same
        /// attributes.
        pub region_size: usize,
        /// `MEM_COMMIT`, `MEM_RESERVE` or `MEM_FREE`.
        pub state: u32,
        _protect: u32,
        /// `MEM_PRIVATE`, `MEM_MAPPED` or `MEM_IMAGE`; undefined for a free region.
        pub kind: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn VirtualQuery(address: *const c_void, buffer: *mut Info, length: usize) -> usize;
    }

    pub const MEM_COMMIT: u32 = 0x1000;
    pub const MEM_FREE: u32 = 0x1_0000;
    pub const MEM_PRIVATE: u32 = 0x2_0000;

    /// What the system says of the region holding `address`; `None` unless the call reports
    /// writing `size_of::<Info>()` bytes: 0 is a failure, and any other count means `Info` is
    /// not the system's size.
    pub fn query(address: *const u32) -> Option<Info> {
        let mut info = Info {
            _base_address: ptr::null_mut(),
            allocation_base: ptr::null_mut(),
            _allocation_protect: 0,
            #[cfg(not(target_arch = "x86"))]
            _partition_id: 0,
            region_size: 0,
            state: 0,
            _protect: 0,
            kind: 0,
        };
        // SAFETY: `VirtualQuery` reads no memory at `address`, mapped or not; it writes at
        // most `length` bytes, the size of `info`, into `info`, which outlives the call, and
        // any bytes it writes are a valid `Info`, whose fields are integers and raw pointers.
        let written = unsafe { VirtualQuery(address.cast(), &raw mut info, size_of::<Info>()) };
        (written == size_of::<Info>()).then_some(info)
    }
}

/// A row value that is not zero, for row `i`.
fn row<T: From<u8>>(i: usize) -> T {
    T::from(u8::try_from(i % 250 + 1).unwrap_or(1))
}

/// An anonymous column of `T`: its length, its room, rows nobody wrote reading as zero, and
/// rows written reading back, with the headroom still zero after them.
fn check_rows_room_and_headroom<T>() -> TestResult
where
    T: Zeroable + From<u8> + PartialEq + Debug,
{
    let zero = T::from(0);
    let mut column = Column::<T>::anon(ROWS, CAPACITY)?;
    assert!(
        matches!(column, Column::Anon(_)),
        "{}",
        std::any::type_name::<T>()
    );
    assert_eq!(column.len(), ROWS);
    assert!(!column.is_empty());
    assert_eq!(column.capacity(), CAPACITY);
    assert!(
        column.as_slice().iter().all(|value| *value == zero),
        "rows nobody wrote read as zero"
    );
    for (i, value) in column.as_mut_slice().iter_mut().enumerate() {
        *value = row(i);
    }
    let all = column
        .with_headroom()
        .ok_or("an anonymous column shows its headroom")?;
    assert_eq!(all.len(), CAPACITY);
    let (rows, headroom) = all.split_at_checked(ROWS).ok_or("the rows come first")?;
    assert_eq!(rows, column.as_slice());
    assert!(
        rows.iter().enumerate().all(|(i, value)| *value == row(i)),
        "rows written read back"
    );
    assert_eq!(headroom.len(), CAPACITY - ROWS);
    assert!(
        headroom.iter().all(|value| *value == zero),
        "the headroom reads as zero"
    );
    Ok(())
}

#[test]
fn an_anon_column_has_its_rows_room_for_capacity_and_a_headroom_that_reads_zero() -> TestResult {
    let _turn = turn();
    check_rows_room_and_headroom::<u8>()?;
    check_rows_room_and_headroom::<u16>()?;
    check_rows_room_and_headroom::<u32>()?;
    check_rows_room_and_headroom::<i32>()?;
    check_rows_room_and_headroom::<f64>()?;

    // A column with no room maps nothing.
    let before = anon_tally();
    let empty = Column::<u32>::anon(0, 0)?;
    assert_eq!((empty.len(), empty.capacity()), (0, 0));
    assert!(empty.is_empty());
    assert_eq!(empty.with_headroom(), Some(&[][..]));
    drop(empty);
    assert_eq!(since(before, anon_tally()), AnonTally::default());

    // An owned column's headroom is uninitialised, so it is not shown.
    let owned = Column::Owned(Vec::<u32>::with_capacity(8));
    assert_eq!(owned.with_headroom(), None);

    // What cannot be mapped is refused, and nothing is mapped for it.
    assert_eq!(
        Column::<u32>::anon(5, 4).err(),
        Some(ColumnError::LenPastCapacity {
            len: 5,
            capacity: 4
        })
    );
    assert_eq!(
        Column::<f64>::anon(0, usize::MAX).err(),
        Some(ColumnError::TooLarge {
            rows: usize::MAX,
            row_bytes: 8
        })
    );
    assert_eq!(
        Column::<u8>::anon(0, usize::MAX).err(),
        Some(ColumnError::TooLarge {
            rows: usize::MAX,
            row_bytes: 1
        }),
        "more bytes than a slice may span"
    );
    // `isize::MAX` bytes pass the slice bound, and no OS here maps them: Linux answers
    // ENOMEM (more than `TASK_SIZE`), macOS refuses, and so does `VirtualAlloc`.
    let huge = isize::MAX.unsigned_abs();
    let refused = Column::<u8>::anon(0, huge).map(|column| column.capacity());
    assert!(
        matches!(refused, Err(ColumnError::MapFailed { bytes, code }) if bytes == huge && code != 0),
        "{huge} bytes: {refused:?}"
    );
    assert_eq!(since(before, anon_tally()), AnonTally::default());
    Ok(())
}

#[test]
fn dropping_an_anon_column_releases_its_mapping() -> TestResult {
    let _turn = turn();
    let bytes = CAPACITY * size_of::<u32>();
    let before = anon_tally();
    let column = Column::<u32>::anon(ROWS, CAPACITY)?;
    let made = since(before, anon_tally());
    assert_eq!(
        made,
        AnonTally {
            maps: 1,
            unmaps: 0,
            bytes_mapped: u64::try_from(bytes)?,
            bytes_unmapped: 0,
        }
    );
    let start = column.as_slice().as_ptr();
    #[cfg(unix)]
    assert!(
        mapped(start, bytes),
        "the kernel maps the column while it lives"
    );
    #[cfg(windows)]
    {
        let live = region::query(start).ok_or("VirtualQuery answers for a live column")?;
        assert_eq!(
            live.allocation_base.addr(),
            start.addr(),
            "the rows start an allocation of their own"
        );
        assert_eq!(live.state, region::MEM_COMMIT, "the column is committed");
        assert_eq!(
            live.kind,
            region::MEM_PRIVATE,
            "the column is private memory"
        );
        assert!(
            live.region_size >= bytes,
            "every page of the column is committed: {} of {bytes} bytes",
            live.region_size
        );
    }

    drop(column);
    let released = since(before, anon_tally());
    assert_eq!(released.unmaps, 1);
    assert_eq!(released.bytes_unmapped, u64::try_from(bytes)?);
    #[cfg(unix)]
    assert!(
        !mapped(start, bytes),
        "the kernel has the column's pages back"
    );
    #[cfg(windows)]
    assert_eq!(
        region::query(start).map(|info| info.state),
        Some(region::MEM_FREE),
        "the system has the column's pages back"
    );
    Ok(())
}

/// Counts only what goes through Rust's global allocator (`Counting`): rows taken from
/// `malloc`, `calloc` or `HeapAlloc` directly would pass it by. The kernel probes in
/// `dropping_an_anon_column_releases_its_mapping` are what see those: `msync` on POSIX and
/// `VirtualQuery` on Windows.
#[test]
fn an_anon_column_asks_the_heap_for_nothing() -> TestResult {
    let _turn = turn();
    let (outcome, asked) = bytes_asked_during(|| -> Result<(usize, usize, f64), ColumnError> {
        let mut column = Column::<f64>::anon(ROWS, CAPACITY)?;
        for (i, value) in column.as_mut_slice().iter_mut().enumerate() {
            *value = i as f64;
        }
        let total = column
            .with_headroom()
            .map_or(f64::NAN, |all| all.iter().sum());
        let shape = (column.len(), column.capacity(), total);
        drop(column);
        Ok(shape)
    });
    let (len, capacity, total) = outcome?;
    assert_eq!((len, capacity), (ROWS, CAPACITY));
    // Every partial sum is a whole number below 2^53, so the sum is exact in any order.
    let expected: f64 = (0..ROWS).map(|i| i as f64).sum();
    assert_eq!(total.to_bits(), expected.to_bits());
    assert_eq!(
        asked, 0,
        "heap bytes asked for by an anonymous column's rows"
    );

    // The count is real: an owned column with the same room asks for every byte of it.
    let (owned, asked) = bytes_asked_during(|| Column::Owned(Vec::<f64>::with_capacity(CAPACITY)));
    assert!(
        asked >= owned.capacity() * size_of::<f64>(),
        "asked for {asked} bytes, has room for {}",
        owned.capacity()
    );
    Ok(())
}

#[test]
fn an_anon_column_is_released_by_the_thread_that_drops_it() -> TestResult {
    let _turn = turn();
    let column = Column::<i32>::anon(ROWS, CAPACITY)?;
    let here = anon_tally();
    let there = std::thread::spawn(move || {
        let before = anon_tally();
        drop(column);
        since(before, anon_tally())
    })
    .join()
    .map_err(|_| "the thread that dropped the column panicked")?;
    assert_eq!(there.unmaps, 1);
    assert_eq!(
        there.bytes_unmapped,
        u64::try_from(CAPACITY * size_of::<i32>())?
    );
    assert_eq!(since(here, anon_tally()), AnonTally::default());
    Ok(())
}

#[test]
fn a_cloned_anon_column_is_a_mapping_of_its_own_with_the_same_rows() -> TestResult {
    let _turn = turn();
    let mut original = Column::<u16>::anon(ROWS, CAPACITY)?;
    for (i, value) in original.as_mut_slice().iter_mut().enumerate() {
        *value = row(i);
    }
    let before = anon_tally();
    let mut copy = original.clone();
    assert_eq!(since(before, anon_tally()).maps, 1);
    assert!(matches!(copy, Column::Anon(_)));
    assert_eq!(copy, original);
    assert_eq!(copy.capacity(), original.capacity());
    assert_ne!(copy.as_slice().as_ptr(), original.as_slice().as_ptr());
    let headroom = copy
        .with_headroom()
        .and_then(|all| all.get(ROWS..))
        .ok_or("the copy has its headroom")?;
    assert!(headroom.iter().all(|value| *value == 0));

    let first = copy.as_mut_slice().first_mut().ok_or("the copy has rows")?;
    *first = 9_999;
    assert_ne!(copy, original, "writing the copy leaves the original alone");
    assert_eq!(original.as_slice().first(), Some(&1));

    // Columns are equal when their rows are, wherever the rows live.
    assert_eq!(Column::Owned(original.as_slice().to_vec()), original);
    Ok(())
}

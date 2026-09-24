//! What `build` asks the allocator for, counted by this test binary's own global allocator
//! (the other test binaries keep the system's).
//!
//! A reservation that fails aborts the process (`handle_alloc_error`) instead of returning
//! an error, so a refusal the build owes its caller must come before it reserves anything.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use tm_store::{BuildOptions, StoreError, StoreMode, build};
use tm_walk::{FastPath, KIND_DIR, WalkOutput, WalkStats};

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

/// A walk of the root alone.
fn root_only() -> WalkOutput {
    WalkOutput {
        parent: vec![0],
        name_off: vec![0, 1],
        names: b"r".to_vec(),
        kind: vec![KIND_DIR],
        flags: vec![0],
        size: vec![0.0],
        alloc_bytes: vec![0.0],
        mtime_ms: vec![1_000.0],
        atime_ms: vec![f64::NAN],
        hardlinks: Vec::new(),
        refusals: Vec::new(),
        stats: WalkStats {
            dirs_listed: 1,
            entries: 0,
            wall_ms: 1.0,
            cpu_seconds: f64::NAN,
            fast_path: FastPath::PerEntry,
            workers_peak: 1,
            climb_steps: 0,
            denied_entries: 0,
            unreadable_entries: 0,
            dataless: 0,
        },
    }
}

fn options(headroom_rows: u32) -> BuildOptions {
    BuildOptions {
        root_name: "scanned".to_owned(),
        root_mtime_ms: 777.0,
        blocks_are_meaningful: true,
        sort_children: true,
        container_rules: Vec::new(),
        headroom_rows,
        mode: StoreMode::Memory,
    }
}

#[test]
fn rows_past_the_store_s_signed_ids_are_refused_before_anything_is_allocated()
-> Result<(), StoreError> {
    let (walk, opts) = (root_only(), options(i32::MAX.unsigned_abs()));
    let (built, asked) = bytes_asked_during(|| build(walk, &opts));
    assert_eq!(built, Err(StoreError::TooManyRows { rows: 1 << 31 }));
    assert_eq!(asked, 0, "bytes asked for before the refusal");

    // The count is real: the same walk with room for 16 more rows asked for at least every
    // byte its columns have room for (a `Vec` asks for exactly its capacity).
    let (walk, opts) = (root_only(), options(16));
    let (built, asked) = bytes_asked_during(|| build(walk, &opts));
    let store = built?;
    assert!(store.atime.is_none(), "no column left out of the sum");
    let room = store.parent.capacity() * size_of::<i32>()
        + (store.size.capacity() + store.mtime.capacity()) * size_of::<f64>()
        + (store.flags.capacity() + store.ext.capacity()) * size_of::<u16>()
        + store.container.capacity()
        + store.cloud_prov.capacity()
        + store.names.capacity()
        + (store.name_off.capacity() + store.child_start.capacity() + store.child_cnt.capacity())
            * size_of::<u32>();
    assert!(
        asked >= room,
        "asked for {asked} bytes, has room for {room}"
    );
    Ok(())
}

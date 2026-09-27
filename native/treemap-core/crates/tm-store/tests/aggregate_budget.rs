//! AggregateState, T12e (Phase 4; design §S.3): its peak memory on a 2M-entry synthetic
//! tree, counted, against the budget §S.3 sets for it.
//!
//! This test binary's own global allocator counts the bytes allocated and freed on a thread
//! while a thread-local flag is set, and the peak of their difference. A wrapper sink sets
//! the flag around every call into the state. The state takes its calls under the walk's
//! commit lock, one at a time, and everything it holds is allocated and freed inside them,
//! while the walk's own buffers, on the same threads, are allocated outside them: so what is
//! counted is the state's memory, and it is counted, not timed.

mod common;

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

use common::aggregate::OpenPacer;
use tm_store::aggregate::{
    AGGREGATE_Q_MAX, AggregateOptions, AggregateState, EXTENSION_LIMIT, FILE_HEAP, FOLDER_HEAP,
    KeepLimits, SHALLOW_ROWS,
};
use tm_walk::{
    Block, Finishing, ListingSink, Meta, Numbering, Refusal, SyntheticSpec, WalkOptions,
    lister_for, start_with_sinks, synthetic_temp_folder,
};

type TestResult = Result<(), String>;

// ---------------------------------------------------------------------------
// Counting the state's own bytes
// ---------------------------------------------------------------------------

thread_local! {
    static COUNTING: Cell<bool> = const { Cell::new(false) };
}

static LIVE: AtomicI64 = AtomicI64::new(0);
static PEAK: AtomicI64 = AtomicI64::new(0);

fn counting() -> bool {
    // `try_with`, not `with`: an allocator must not panic.
    COUNTING.try_with(Cell::get).unwrap_or(false)
}

fn grow(bytes: usize) {
    let bytes = i64::try_from(bytes).unwrap_or(i64::MAX);
    let live = LIVE
        .fetch_add(bytes, Ordering::Relaxed)
        .saturating_add(bytes);
    PEAK.fetch_max(live, Ordering::Relaxed);
}

fn shrink(bytes: usize) {
    LIVE.fetch_sub(i64::try_from(bytes).unwrap_or(i64::MAX), Ordering::Relaxed);
}

/// The system allocator, counting what a flagged thread allocates and frees.
struct Counting;

// SAFETY: every method hands its arguments unchanged to `System`, whose allocations these
// all are, so each keeps `System`'s guarantees; counting touches only two atomics.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if counting() {
            grow(layout.size());
        }
        // SAFETY: the caller meets `alloc`'s contract for `layout`, as `System.alloc` needs.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if counting() {
            shrink(layout.size());
        }
        // SAFETY: `ptr` was allocated by this allocator, which is `System`, with `layout`.
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if counting() {
            // The new block before the old one goes: both may be held while it copies.
            grow(new_size);
            shrink(layout.size());
        }
        // SAFETY: `ptr` was allocated by `System` with `layout`, and the caller meets
        // `realloc`'s contract for `new_size`.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

fn counted<T>(run: impl FnOnce() -> T) -> T {
    COUNTING.with(|flag| flag.set(true));
    let answer = run();
    COUNTING.with(|flag| flag.set(false));
    answer
}

/// The state, every call into it counted, and the most folders it held open.
struct Counted {
    state: Arc<AggregateState>,
    open_peak: AtomicUsize,
}

impl ListingSink for Counted {
    fn root(&self, name: &[u8], meta: &Meta) {
        counted(|| self.state.root(name, meta));
    }

    fn commit(&self, block: &Block<'_>) {
        counted(|| self.state.commit(block));
        self.open_peak
            .fetch_max(self.state.open_folders(), Ordering::Relaxed);
    }

    fn refused(&self, folder: u32, why: Refusal) {
        counted(|| self.state.refused(folder, why));
    }

    fn skipped(&self, folder: u32) {
        counted(|| self.state.skipped(folder));
    }

    fn abort(&self) {
        counted(|| self.state.abort());
    }

    fn finish(&self, ending: &Finishing<'_>) -> Result<(), String> {
        counted(|| self.state.finish(ending))
    }
}

// ---------------------------------------------------------------------------
// §S.3's budget for the state
// ---------------------------------------------------------------------------

/// §S.3: 19 MB for the folder heap's 150,001 records.
const FOLDER_RECORD: usize = 127;
/// §S.3: 19 MB for the file heap's 200,001 records.
const FILE_RECORD: usize = 95;
/// §S.3: 6 MB for the shallow keep's 65,536 rows.
const SHALLOW_RECORD: usize = 92;
/// §S.3: the extension table.
const EXTENSION_TABLE: usize = 8 << 20;
/// §S.3: the answers and side tables.
const ANSWERS: usize = 5 << 20;
/// §S.3: an open folder's accumulator.
const OPEN_FOLDER: usize = 112;
/// §S.3: a link-key record.
const LINK_RECORD: usize = 40;

/// The state's budget for a walk that held `open` folders open at most and keyed `keyed`
/// names.
fn budget(open: usize, keyed: usize) -> usize {
    FOLDER_HEAP * FOLDER_RECORD
        + FILE_HEAP * FILE_RECORD
        + SHALLOW_ROWS * SHALLOW_RECORD
        + EXTENSION_TABLE
        + ANSWERS
        + open * OPEN_FOLDER
        + keyed * LINK_RECORD
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

#[test]
fn the_state_holds_no_more_than_its_budget_on_two_million_entries() -> TestResult {
    let spec = SyntheticSpec::developer(2_000_000, 12);
    let root = synthetic_temp_folder().join("t12e");
    let sink = Arc::new(Counted {
        state: Arc::new(AggregateState::new(AggregateOptions {
            root_path: root.to_string_lossy().into_owned().into_bytes(),
            separator: b'/',
            observer: None,
            extension_limit: EXTENSION_LIMIT,
            keep: KeepLimits::default(),
        })),
        open_peak: AtomicUsize::new(0),
    });
    let mut opts = WalkOptions::new(root);
    opts.numbering = Numbering::Blocks;
    opts.max_workers = 4;
    // The sink modes' queue limit (P4-13), which bounds the frontier §S.3 budgets for.
    opts.q_max = AGGREGATE_Q_MAX;
    opts.synthetic = Some(spec);
    let lister = lister_for(&opts).map_err(|e| e.to_string())?;
    let sinks: Vec<Arc<dyn ListingSink>> = vec![sink.clone()];
    LIVE.store(0, Ordering::Relaxed);
    PEAK.store(0, Ordering::Relaxed);
    let handle =
        start_with_sinks(opts, Arc::new(OpenPacer), lister, sinks).map_err(|e| e.to_string())?;
    let out = handle.take().map_err(|e| format!("the walk: {e}"))?;
    let peak = usize::try_from(PEAK.load(Ordering::Relaxed)).unwrap_or(0);
    let open = sink.open_peak.load(Ordering::Relaxed);
    let keyed = out.hardlinks.len();
    let allowed = budget(open, keyed);
    assert!(
        out.stats.entries >= 2_000_000,
        "the tree has its two million entries"
    );
    assert!(
        peak > 0,
        "the state's memory was counted: the flag reached the allocator"
    );
    assert!(
        peak <= allowed,
        "the state peaked at {peak} bytes, past its budget of {allowed} ({open} folders open at \
         most, {keyed} keyed names)"
    );
    Ok(())
}

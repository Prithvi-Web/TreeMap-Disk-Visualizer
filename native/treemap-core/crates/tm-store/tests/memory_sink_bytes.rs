//! What the memory sink's store holds in memory (Phase 4, T7a; design §S.3), counted, not
//! timed: every column's pages asked of the kernel (`mincore`, POSIX), against the room
//! each was reserved with. The sink reserves `cap_rows` rows (and a name pool) up front;
//! only the pages its blocks write may be resident (decision P4-11), so a store of `n`
//! rows costs its rows, not its reservation.
//!
//! The test prints the bytes per row of the sink's columns beside those of `build`'s
//! columns for the same walk (their allocations' capacities). `TM_T7A_ROWS` sets the
//! tree's size (200,000 entries unless set); the owner's report used 1,000,000.

#![cfg(unix)]

use std::sync::Arc;

use tm_store::{BuildOptions, Column, MemorySink, Store, StoreMode, Zeroable, build};
use tm_walk::walk::{MAX_WORKERS, Pacer};
use tm_walk::{Numbering, SyntheticSpec, WalkOptions, lister_for, start_with_sinks};

type TestResult = Result<(), String>;

/// A pacer that never waits.
struct OpenPacer;

impl Pacer for OpenPacer {
    fn on_worker_start(&self) {}
    fn throttle(&self, _cancelled: &dyn Fn() -> bool) {}
    fn worker_limit(&self) -> u32 {
        MAX_WORKERS
    }
}

/// Transparent huge pages can make up to 2 MiB past a written page resident on Linux, so
/// a column's pages are counted as its rows' only up to this far past them.
const HUGE_PAGE: usize = 2 * 1024 * 1024;

fn page_size() -> Result<usize, String> {
    // SAFETY: `sysconf` reads a configuration value and touches no memory.
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    usize::try_from(page).map_err(|_| format!("the page size is {page}"))
}

/// Which pages of the mapping `[start, start + bytes)` are resident, one bool per page.
fn resident_pages(start: *const u8, bytes: usize) -> Result<Vec<bool>, String> {
    let page = page_size()?;
    let pages = bytes.div_ceil(page);
    let mut vec = vec![0_u8; pages];
    // SAFETY: `mincore` reads no memory at `start`; it writes one byte per page of the
    // range into `vec`, which has `pages` bytes. `start` is a mapping's first byte, page
    // aligned, and the range lies inside the mapping.
    #[cfg(target_vendor = "apple")]
    let answer = unsafe { libc::mincore(start.cast(), bytes, vec.as_mut_ptr().cast()) };
    #[cfg(not(target_vendor = "apple"))]
    let answer = unsafe { libc::mincore(start.cast_mut().cast(), bytes, vec.as_mut_ptr()) };
    if answer != 0 {
        return Err(format!(
            "mincore refused {bytes} bytes: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(vec.iter().map(|&state| state & 1 != 0).collect())
}

/// One column's residency: bytes resident, and bytes resident past the room it was
/// settled with (allowing for a huge page).
struct Residency {
    resident: usize,
    past_room: usize,
}

/// `column`'s residency, over the whole mapping it was reserved with (`reserved` rows).
fn residency<T: Zeroable>(column: &Column<T>, reserved: usize) -> Result<Residency, String> {
    let Column::Anon(_) = column else {
        return Err("the sink's column is not an anonymous mapping".to_owned());
    };
    let page = page_size()?;
    let start = column.as_slice().as_ptr().cast::<u8>();
    let bytes = reserved * size_of::<T>();
    let room = column.capacity() * size_of::<T>();
    let pages = resident_pages(start, bytes)?;
    let allowed = (room.div_ceil(page) * page + HUGE_PAGE).div_ceil(page);
    let resident = pages.iter().filter(|&&r| r).count() * page;
    let past_room = pages.iter().skip(allowed).filter(|&&r| r).count() * page;
    Ok(Residency {
        resident,
        past_room,
    })
}

/// The bytes a `build` column's allocation holds.
fn allocated<T: Zeroable>(column: &Column<T>) -> usize {
    column.capacity() * size_of::<T>()
}

fn options() -> BuildOptions {
    BuildOptions {
        root_name: "bytes".to_owned(),
        root_mtime_ms: 0.0,
        blocks_are_meaningful: true,
        sort_children: true,
        container_rules: Vec::new(),
        headroom_rows: 1_024,
        mode: StoreMode::Memory,
    }
}

/// Walks a developer-shaped synthetic tree of `entries` into a sink reserved for
/// `cap_rows`, and returns the sink's store and `build(take())`'s.
fn walk(entries: u64, cap_rows: u32, name_bytes: u64) -> Result<(Store, Store), String> {
    let build_opts = options();
    let sink =
        Arc::new(MemorySink::new(&build_opts, cap_rows, name_bytes).map_err(|e| e.to_string())?);
    let mut opts = WalkOptions::new(tm_walk::synthetic_temp_folder().join("tm-store-bytes"));
    opts.numbering = Numbering::Blocks;
    opts.max_workers = 8;
    opts.synthetic = Some(SyntheticSpec::developer(entries, 3));
    opts.id_ceiling = sink.id_ceiling();
    opts.name_ceiling = sink.name_ceiling();
    let lister = lister_for(&opts).map_err(|e| e.to_string())?;
    let handle = start_with_sinks(opts, Arc::new(OpenPacer), lister, vec![sink.clone()])
        .map_err(|e| e.to_string())?;
    let out = handle.take().map_err(|e| e.to_string())?;
    let mem = sink.seal(out.stats.clone()).map_err(|e| e.to_string())?;
    let bfs = build(out, &build_opts).map_err(|e| e.to_string())?;
    Ok((mem, bfs))
}

#[test]
fn the_sinks_store_is_resident_only_where_its_rows_are() -> TestResult {
    let entries: u64 = std::env::var("TM_T7A_ROWS")
        .ok()
        .and_then(|rows| rows.parse().ok())
        .unwrap_or(200_000);
    // Twice the rows the tree needs, and 64 name bytes a row: most of each mapping is
    // room the walk never uses.
    let cap_rows = u32::try_from(entries * 2 + 4_096).map_err(|e| e.to_string())?;
    let name_bytes = u64::from(cap_rows) * 64;
    let (mem, bfs) = walk(entries, cap_rows, name_bytes)?;
    let reserved = cap_rows as usize;
    let pool = usize::try_from(name_bytes).map_err(|e| e.to_string())?;
    let columns: Vec<(&str, Residency, usize)> = vec![
        (
            "parent",
            residency(&mem.parent, reserved)?,
            allocated(&bfs.parent),
        ),
        (
            "size",
            residency(&mem.size, reserved)?,
            allocated(&bfs.size),
        ),
        (
            "mtime",
            residency(&mem.mtime, reserved)?,
            allocated(&bfs.mtime),
        ),
        (
            "atime",
            match &mem.atime {
                Some(column) => residency(column, reserved)?,
                None => Residency {
                    resident: 0,
                    past_room: 0,
                },
            },
            bfs.atime.as_ref().map_or(0, allocated),
        ),
        (
            "flags",
            residency(&mem.flags, reserved)?,
            allocated(&bfs.flags),
        ),
        ("ext", residency(&mem.ext, reserved)?, allocated(&bfs.ext)),
        (
            "container",
            residency(&mem.container, reserved)?,
            allocated(&bfs.container),
        ),
        (
            "cloudProv",
            residency(&mem.cloud_prov, reserved)?,
            allocated(&bfs.cloud_prov),
        ),
        (
            "nameOff",
            residency(&mem.name_off, reserved + 1)?,
            allocated(&bfs.name_off),
        ),
        ("names", residency(&mem.names, pool)?, allocated(&bfs.names)),
        (
            "childStart",
            residency(&mem.child_start, reserved)?,
            allocated(&bfs.child_start),
        ),
        (
            "childCnt",
            residency(&mem.child_cnt, reserved)?,
            allocated(&bfs.child_cnt),
        ),
    ];
    let rows = f64::from(mem.n);
    let (mut sink_total, mut build_total) = (0, 0);
    println!(
        "{} rows, {} reserved (bytes per row: sink resident / build allocated)",
        mem.n, cap_rows
    );
    for (name, seen, built) in &columns {
        println!(
            "  {name:>10}: {:6.2} / {:6.2}",
            seen.resident as f64 / rows,
            *built as f64 / rows
        );
        assert_eq!(
            seen.past_room, 0,
            "{name}: pages past the rows and headroom are resident"
        );
        sink_total += seen.resident;
        build_total += built;
    }
    println!(
        "  {:>10}: {:6.2} / {:6.2}",
        "total",
        sink_total as f64 / rows,
        build_total as f64 / rows
    );
    Ok(())
}

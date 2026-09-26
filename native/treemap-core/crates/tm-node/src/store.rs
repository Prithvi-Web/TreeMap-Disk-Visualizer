//! The memory mode's store (Phase 4, T8b; design §S.1.6). A scan started with
//! `storage: "memory"` numbers its entries in blocks, keeps no columns of its own
//! (`WalkOptions::collect` off) and feeds a [`MemorySink`], which seals the
//! finalized store on the walk's driver thread as the walk finishes. `storeTake`
//! hands the store to JavaScript off the main thread and frees the handle;
//! `scanTake` frees such a scan and throws, since its rows are in the store.
//!
//! Every per-node column crosses at the store's `capacity` rows — the headroom
//! rows zero — as `PackedScanStore.adoptColumns` takes them. A column in an
//! anonymous mapping crosses as the mapping itself: napi-rs makes an external
//! buffer over it in plain Node, and the column is dropped — its mapping
//! released — when JavaScript drops the array; where Electron's memory cage
//! refuses external buffers, napi-rs copies the rows into memory V8 allocates
//! and drops the column right after the copy (RISKS R72).

use std::sync::Arc;

use napi::bindgen_prelude::{
    AsyncTask, Float64Array, Int32Array, Uint8Array, Uint16Array, Uint32Array,
};
use napi::{Env, Result, Task};
use napi_derive::napi;
use serde::Deserialize;
use serde_json::{Value, json};
use tm_store::{BuildOptions, Column, ContainerRule, Counters, MemorySink, Store, StoreMode};
use tm_walk::{Numbering, WalkOptions, WalkOutput};

use crate::{
    STILL_RUNNING, Slot, failure, lock, refuse, scans, stats_json, unknown_handle, walk_error,
};

/// The one value `scanStart`'s `storage` takes.
const MEMORY: &str = "memory";

/// `scanStart`'s `store` option: tm-store's `BuildOptions`, and the sink's room.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoreOptions {
    root_name: String,
    root_mtime_ms: f64,
    blocks_are_meaningful: bool,
    sort_children: bool,
    container_rules: Vec<ContainerRuleOption>,
    headroom_rows: u32,
    /// Rows the sink reserves, the headroom among them.
    cap_rows: u32,
    /// Name bytes the sink reserves, the root's and the headroom's among them.
    name_bytes: u64,
}

/// One of `detectContainerKind`'s rules, as `scanStart` takes it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContainerRuleOption {
    text: String,
    whole_name: bool,
    folders: bool,
    kind: u8,
}

/// The memory sink `storage` and `store` ask for, or `None` for a scan that
/// `scanTake` takes; a storage but `"memory"`, and the one without the other,
/// are refused.
pub(crate) fn memory_sink(
    storage: Option<&str>,
    store: Option<&StoreOptions>,
) -> Result<Option<Arc<MemorySink>>> {
    let options = match (storage, store) {
        (None, None) => return Ok(None),
        (Some(MEMORY), Some(options)) => options,
        (Some(MEMORY), None) => {
            return Err(refuse(
                "storage: 'memory' needs the store option: how the memory sink builds the store",
            ));
        }
        (None, Some(_)) => {
            return Err(refuse(
                "the store option is for storage: 'memory', which was not asked for",
            ));
        }
        (Some(other), _) => {
            return Err(refuse(format!(
                "storage must be 'memory' or absent; got {other:?}"
            )));
        }
    };
    let build = BuildOptions {
        root_name: options.root_name.clone(),
        root_mtime_ms: options.root_mtime_ms,
        blocks_are_meaningful: options.blocks_are_meaningful,
        sort_children: options.sort_children,
        container_rules: options
            .container_rules
            .iter()
            .map(|rule| ContainerRule {
                text: rule.text.clone(),
                whole_name: rule.whole_name,
                folders: rule.folders,
                kind: rule.kind,
            })
            .collect(),
        headroom_rows: options.headroom_rows,
        mode: StoreMode::Memory,
    };
    MemorySink::new(&build, options.cap_rows, options.name_bytes)
        .map(|sink| Some(Arc::new(sink)))
        .map_err(|err| refuse(format!("the memory sink cannot be made: {err}")))
}

/// Sets `opts` up to feed `sink` alone: block numbering, no columns of the walk's
/// own, and the sink's ceilings.
pub(crate) fn feed_only(opts: &mut WalkOptions, sink: &MemorySink) {
    opts.numbering = Numbering::Blocks;
    opts.collect = false;
    opts.id_ceiling = sink.id_ceiling();
    opts.name_ceiling = sink.name_ceiling();
}

/// The refusal `scanTake` answers a memory-mode scan that ended with an output.
pub(crate) const IN_THE_STORE: &str =
    "this scan kept its rows in its store (storage: 'memory'): storeTake takes them";

/// A memory-mode scan's store as JavaScript takes it (`native/index.d.ts`'s `NativeStore`).
#[napi(object)]
pub struct NativeStore {
    /// Rows in use, the root's included.
    pub n: u32,
    /// Rows each per-node column holds: `n` and the headroom.
    pub capacity: u32,
    /// Each row's parent row; the root's is -1.
    pub parent: Int32Array,
    /// Bytes each row keeps (0 for a folder and a later hard-link name).
    pub size: Float64Array,
    /// Modification times the store keeps, milliseconds.
    pub mtime: Float64Array,
    /// Access times; absent when no row has one.
    pub atime: Option<Float64Array>,
    /// The store's flag bits (`Flag` in `scanStore.ts`).
    pub flags: Uint16Array,
    /// Each row's extension: an index into `ext_dict`, 0 for none.
    pub ext: Uint16Array,
    /// Each row's container kind, 0 for none.
    pub container: Uint8Array,
    /// Each row's cloud provider, 0 for none (Node sets them).
    pub cloud_prov: Uint8Array,
    /// Where each row's name starts in `names`, and one past the last.
    pub name_off: Uint32Array,
    /// The names, UTF-8, back to back, with room after them.
    pub names: Uint8Array,
    /// The bytes of `names` in use.
    pub names_len: u32,
    /// Each folder's first child row.
    pub child_start: Uint32Array,
    /// Each folder's child count.
    pub child_cnt: Uint32Array,
    /// The extensions, none first.
    pub ext_dict: Vec<String>,
    /// Rows whose extension is past the dictionary, ascending.
    pub ext_overflow_ids: Uint32Array,
    /// Those rows' extensions.
    pub ext_overflow_texts: Vec<String>,
    /// Rows Node applies the cloud rule to, in breadth-first order.
    pub cloud_candidates: Uint32Array,
    /// Rows whose extension and container Node decides, ascending.
    pub text_candidates: Uint32Array,
    /// The sparse terms' rows, in breadth-first order.
    pub sparse_term_ids: Uint32Array,
    /// The sparse terms' bytes.
    pub sparse_term_bytes: Float64Array,
    /// The store's tallies before Node's passes.
    pub counters: Value,
    /// What the walk measured about itself.
    pub stats: Value,
}

/// `storeTake` as a task: the scan's slot — its walk and sink — taken off the
/// table on the JavaScript thread; the join and the store taken on libuv's pool;
/// the arrays made on the JavaScript thread.
pub struct StoreTake {
    slot: Option<Slot>,
    refusal: Option<napi::Error>,
}

/// A memory-mode scan's store, once a poll has reported `done`, and the handle
/// freed (see `native/index.d.ts`).
#[napi(js_name = "storeTake", catch_unwind)]
pub fn store_take(handle: u32) -> AsyncTask<StoreTake> {
    AsyncTask::new(match taken(handle) {
        Ok(slot) => StoreTake {
            slot: Some(slot),
            refusal: None,
        },
        Err(refusal) => StoreTake {
            slot: None,
            refusal: Some(refusal),
        },
    })
}

/// `handle`'s slot, off the table: refused — and kept — while the walk runs, for
/// a scan that was not started with `storage: 'memory'`, and for an unknown handle.
fn taken(handle: u32) -> Result<Slot> {
    let mut slots = lock(&scans().slots);
    let (running, memory) = match slots.get(&handle) {
        None => return Err(unknown_handle(handle)),
        Some(Slot::Running(walk, sink)) => (!walk.progress().done, sink.is_some()),
        Some(Slot::Finished(finished)) => (false, finished.sink.is_some()),
    };
    if !memory {
        return Err(refuse(format!(
            "scan handle {handle} was not started with storage: 'memory', so it has no store: scanTake takes its columns"
        )));
    }
    if running {
        return Err(refuse(STILL_RUNNING));
    }
    slots.remove(&handle).ok_or_else(|| unknown_handle(handle))
}

impl Task for StoreTake {
    type Output = Store;
    type JsValue = NativeStore;

    fn compute(&mut self) -> Result<Store> {
        if let Some(refusal) = self.refusal.take() {
            return Err(refusal);
        }
        let Some(slot) = self.slot.take() else {
            return Err(failure("storeTake ran twice"));
        };
        // Done: the driver has finished, so the join returns at once.
        let (outcome, sink): (std::result::Result<WalkOutput, _>, _) = match slot {
            Slot::Running(walk, sink) => (walk.take(), sink),
            Slot::Finished(finished) => (finished.result, finished.sink),
        };
        outcome.map_err(|err| walk_error(&err))?;
        sink.ok_or_else(|| failure("the scan has no memory sink"))?
            .take_store()
            .map_err(|err| failure(format!("the memory sink has no store: {err}")))
    }

    fn resolve(&mut self, _env: Env, store: Store) -> Result<NativeStore> {
        Ok(hand_over(store))
    }
}

/// The store as JavaScript takes it, each column crossing whole (see the module docs).
fn hand_over(store: Store) -> NativeStore {
    let Store {
        mode: _,
        n,
        capacity,
        parent,
        size,
        mtime,
        atime,
        flags,
        ext,
        container,
        cloud_prov,
        name_off,
        names,
        child_start,
        child_cnt,
        ext_dict,
        ext_overflow,
        cloud_candidates,
        text_candidates,
        sparse_terms,
        counters,
        walk_stats,
    } = store;
    let rows = capacity as usize;
    let names_len = name_off.as_slice().last().copied().unwrap_or(0);
    let names_room = names.capacity().max(names.len());
    let (ext_overflow_ids, ext_overflow_texts) =
        ext_overflow.into_iter().unzip::<_, _, Vec<_>, _>();
    let (sparse_term_ids, sparse_term_bytes) = sparse_terms.into_iter().unzip::<_, _, Vec<_>, _>();
    NativeStore {
        n,
        capacity,
        parent: int32(parent, rows),
        size: float64(size, rows),
        mtime: float64(mtime, rows),
        atime: atime.map(|column| float64(column, rows)),
        flags: uint16(flags, rows),
        ext: uint16(ext, rows),
        container: uint8(container, rows),
        cloud_prov: uint8(cloud_prov, rows),
        name_off: uint32(name_off, rows + 1),
        names: uint8(names, names_room),
        names_len,
        child_start: uint32(child_start, rows),
        child_cnt: uint32(child_cnt, rows),
        ext_dict,
        ext_overflow_ids: Uint32Array::new(ext_overflow_ids),
        ext_overflow_texts,
        cloud_candidates: Uint32Array::new(cloud_candidates),
        text_candidates: Uint32Array::new(text_candidates),
        sparse_term_ids: Uint32Array::new(sparse_term_ids),
        sparse_term_bytes: Float64Array::new(sparse_term_bytes),
        counters: counters_json(&counters),
        stats: stats_json(&walk_stats),
    }
}

/// One typed array's hand-over: an anonymous column crosses as its mapping, every
/// row it spans; an owned one as its rows padded with zeros to `rows`.
macro_rules! hand_over_column {
    ($name:ident, $array:ident, $row:ty, $zero:expr) => {
        fn $name(column: Column<$row>, rows: usize) -> $array {
            match column {
                Column::Owned(mut owned) => {
                    owned.resize(rows.max(owned.len()), $zero);
                    $array::new(owned)
                }
                Column::Anon(mut anon) => {
                    let (start, count) = anon.room_mut();
                    // SAFETY: `start` and `count` are the column's rows and headroom,
                    // every row its mapping spans (`AnonRows::room_mut`). The column
                    // moves into the finalizer, which napi-rs calls once — when
                    // JavaScript no longer holds the array, or right after it copies
                    // the rows where external buffers are refused — so the mapping
                    // outlives every use of the pointer, and nothing in Rust reads or
                    // writes the column meanwhile.
                    unsafe {
                        $array::with_external_data(start.as_ptr(), count, move |_, _| drop(anon))
                    }
                }
            }
        }
    };
}

hand_over_column!(int32, Int32Array, i32, 0);
hand_over_column!(float64, Float64Array, f64, 0.0);
hand_over_column!(uint16, Uint16Array, u16, 0);
hand_over_column!(uint8, Uint8Array, u8, 0);
hand_over_column!(uint32, Uint32Array, u32, 0);

/// The store's tallies in camelCase (`native/index.d.ts`'s `NativeStoreCounters`).
fn counters_json(counters: &Counters) -> Value {
    json!({
        "dirs": counters.dirs,
        "files": counters.files,
        "hardlinkedFiles": counters.hardlinked_files,
        "hardlinkedBytes": counters.hardlinked_bytes,
        "cloudFiles": counters.cloud_files,
        "cloudBytes": counters.cloud_bytes,
        "sparseFiles": counters.sparse_files,
        "sparseBytes": counters.sparse_bytes,
        "slackBytes": counters.slack_bytes,
        "deniedDirs": counters.denied_dirs,
        "vanishedDirs": counters.vanished_dirs,
        "unreadableDirs": counters.unreadable_dirs,
    })
}

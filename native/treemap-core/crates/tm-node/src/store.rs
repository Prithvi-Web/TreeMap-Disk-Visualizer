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
//! and drops the column right after the copy (RISKS R72) — on the JavaScript
//! thread, 6.5 ms a million rows (R92). There `storeTakeInto` is used instead
//! (Phase 4 T9c): `storeShape` gives the arrays' lengths, JavaScript makes the
//! arrays, and the store is copied into them on libuv's pool, each column
//! dropped after its copy; `externalBuffersAllowed` says which runtime this is.

use std::collections::HashMap;
use std::sync::Arc;
use std::thread::{self, ThreadId};

use napi::bindgen_prelude::{
    AsyncTask, Float64Array, Int32Array, Uint8Array, Uint16Array, Uint32Array,
};
use napi::{Env, Result, Task};
use napi_derive::napi;
use serde::Deserialize;
use serde_json::{Value, json};
use tm_store::{
    BuildOptions, Column, ContainerRule, Counters, MemorySink, Store, StoreMode, StoreShape,
    Zeroable,
};
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
        // Memory mode leaves the cloud rule to Node's pass over the store's
        // candidates (decision P4-3); the sink is given no table to evaluate.
        cloud_rules: Vec::new(),
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
    /// How `storeTakeInto` copied the store into JavaScript's arrays; absent from
    /// `storeTake`, which copies nothing of its own.
    pub hand_over: Option<NativeHandOver>,
}

/// The bytes `storeTakeInto` copied, on each side of the thread line.
#[napi(object)]
pub struct NativeHandOver {
    /// Copied on libuv's pool.
    pub bytes_off_thread: f64,
    /// Copied on the JavaScript thread: none, by design.
    pub bytes_on_js_thread: f64,
}

/// The lengths of the arrays `storeTakeInto` fills (`native/index.d.ts`'s `NativeStoreShape`).
#[napi(object)]
pub struct NativeStoreShape {
    /// Rows in use, the root's included.
    pub n: u32,
    /// Rows each per-node array holds (`nameOff` one more).
    pub capacity: u32,
    /// Bytes the `names` array holds.
    pub names_room: u32,
    /// Bytes of names in use.
    pub names_len: u32,
    /// Whether an `atime` array is wanted: the store has access times.
    pub atime: bool,
    /// `extOverflowIds`' length.
    pub ext_overflow: u32,
    /// `cloudCandidates`' length.
    pub cloud_candidates: u32,
    /// `textCandidates`' length.
    pub text_candidates: u32,
    /// `sparseTermIds`' and `sparseTermBytes`' length.
    pub sparse_terms: u32,
}

/// The arrays JavaScript made for `storeTakeInto` to fill, as long as `storeShape` says.
#[napi(object)]
pub struct NativeStoreArrays {
    /// Filled with each row's parent row.
    pub parent: Int32Array,
    /// Filled with the bytes each row keeps.
    pub size: Float64Array,
    /// Filled with the modification times.
    pub mtime: Float64Array,
    /// Filled with the access times: given exactly when the shape asks for it.
    pub atime: Option<Float64Array>,
    /// Filled with the flag bits.
    pub flags: Uint16Array,
    /// Filled with the extension indexes.
    pub ext: Uint16Array,
    /// Filled with the container kinds.
    pub container: Uint8Array,
    /// Filled with the cloud providers.
    pub cloud_prov: Uint8Array,
    /// Filled with the name offsets.
    pub name_off: Uint32Array,
    /// Filled with the names.
    pub names: Uint8Array,
    /// Filled with each folder's first child row.
    pub child_start: Uint32Array,
    /// Filled with each folder's child count.
    pub child_cnt: Uint32Array,
    /// Filled with the rows whose extension is past the dictionary.
    pub ext_overflow_ids: Uint32Array,
    /// Filled with the cloud candidates, in breadth-first order.
    pub cloud_candidates: Uint32Array,
    /// Filled with the text candidates.
    pub text_candidates: Uint32Array,
    /// Filled with the sparse terms' rows.
    pub sparse_term_ids: Uint32Array,
    /// Filled with the sparse terms' bytes.
    pub sparse_term_bytes: Float64Array,
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

/// `handle`'s memory sink, the slot left on the table: refused while the walk runs,
/// for a scan that was not started with `storage: 'memory'`, and for an unknown handle.
fn sink_of(slots: &HashMap<u32, Slot>, handle: u32) -> Result<Arc<MemorySink>> {
    let (running, sink) = match slots.get(&handle) {
        None => return Err(unknown_handle(handle)),
        Some(Slot::Running(walk, sink)) => (!walk.progress().done, sink.clone()),
        Some(Slot::Finished(finished)) => (false, finished.sink.clone()),
    };
    let Some(sink) = sink else {
        return Err(refuse(format!(
            "scan handle {handle} was not started with storage: 'memory', so it has no store: scanTake takes its columns"
        )));
    };
    if running {
        return Err(refuse(STILL_RUNNING));
    }
    Ok(sink)
}

/// `handle`'s slot, off the table, once [`sink_of`] allows it — and `check`, given
/// the sink, allows it too; a refusal keeps the slot.
fn taken_if(handle: u32, check: impl FnOnce(&MemorySink) -> Result<()>) -> Result<Slot> {
    let mut slots = lock(&scans().slots);
    check(sink_of(&slots, handle)?.as_ref())?;
    slots.remove(&handle).ok_or_else(|| unknown_handle(handle))
}

/// `handle`'s slot, off the table (see [`sink_of`]).
fn taken(handle: u32) -> Result<Slot> {
    taken_if(handle, |_| Ok(()))
}

/// The store a taken slot's walk sealed: the join returns at once, since the
/// walk is done; a walk that ended without an output gives its error.
fn sealed_store(slot: Slot) -> Result<Store> {
    let (outcome, sink): (std::result::Result<WalkOutput, _>, _) = match slot {
        Slot::Running(walk, sink) => (walk.take(), sink),
        Slot::Finished(finished) => (finished.result, finished.sink),
    };
    outcome.map_err(|err| walk_error(&err))?;
    sink.ok_or_else(|| failure("the scan has no memory sink"))?
        .take_store()
        .map_err(|err| failure(format!("the memory sink has no store: {err}")))
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
        sealed_store(slot)
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
        hand_over: None,
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

/// Whether this runtime lets a typed array be memory the addon owns: an N-API
/// external buffer. Plain Node does; Electron's memory cage refuses them
/// (`napi_no_external_buffers_allowed`), and there `storeTake`'s arrays are copies
/// made on the JavaScript thread, so `storeTakeInto` is the hand-over to use
/// (RISKS R92).
#[napi(js_name = "externalBuffersAllowed")]
pub fn external_buffers_allowed(env: Env) -> bool {
    /// Frees the probe's byte when V8 lets its buffer go.
    unsafe extern "C" fn release(
        _env: napi::sys::napi_env,
        data: *mut std::ffi::c_void,
        _hint: *mut std::ffi::c_void,
    ) {
        // SAFETY: `data` is the byte `external_buffers_allowed` boxed and gave the
        // buffer alone; V8 calls a buffer's finalizer once.
        drop(unsafe { Box::from_raw(data.cast::<u8>()) });
    }
    let byte = Box::into_raw(Box::new(0_u8));
    let mut buffer = std::ptr::null_mut();
    // SAFETY: `byte` is one live, writable byte, the buffer's from here on: freed by
    // `release` when V8 lets the buffer go, or below where the buffer is refused.
    let status = unsafe {
        napi::sys::napi_create_external_arraybuffer(
            env.raw(),
            byte.cast(),
            1,
            Some(release),
            std::ptr::null_mut(),
            &raw mut buffer,
        )
    };
    let allowed = status == napi::sys::Status::napi_ok;
    if !allowed {
        // SAFETY: refused, so no buffer owns the byte and `release` never runs.
        drop(unsafe { Box::from_raw(byte) });
    }
    allowed
}

/// The lengths of the arrays `storeTakeInto` fills, once a poll has reported
/// `done`; refused as `storeTake` refuses (see `native/index.d.ts`).
#[napi(js_name = "storeShape")]
pub fn store_shape(handle: u32) -> Result<NativeStoreShape> {
    let slots = lock(&scans().slots);
    native_shape(&sealed_shape(sink_of(&slots, handle)?.as_ref())?)
}

/// The sink's sealed store's shape, or why there is none.
fn sealed_shape(sink: &MemorySink) -> Result<StoreShape> {
    sink.sealed_shape()
        .map_err(|err| failure(format!("the memory sink has no store: {err}")))
}

/// `shape` as JavaScript takes it.
fn native_shape(shape: &StoreShape) -> Result<NativeStoreShape> {
    let length = |what: &str, value: usize| {
        u32::try_from(value)
            .map_err(|_| failure(format!("{what} is {value} long, past what an array holds")))
    };
    Ok(NativeStoreShape {
        n: shape.n,
        capacity: shape.capacity,
        names_room: length("the names' room", shape.names_room)?,
        names_len: shape.names_len,
        atime: shape.atime,
        ext_overflow: length("the extension overflow", shape.ext_overflow)?,
        cloud_candidates: length("the cloud candidates", shape.cloud_candidates)?,
        text_candidates: length("the text candidates", shape.text_candidates)?,
        sparse_terms: length("the sparse terms", shape.sparse_terms)?,
    })
}

/// `storeTakeInto` as a task: the arrays checked against the sealed store and the
/// scan's slot taken off the table on the JavaScript thread; the join, the store
/// and the copy into the arrays on libuv's pool; the arrays handed back on the
/// JavaScript thread.
pub struct StoreTakeInto {
    slot: Option<Slot>,
    into: Option<NativeStoreArrays>,
    /// The thread the task was made on, JavaScript's: bytes copied on it are counted apart.
    js_thread: ThreadId,
    refusal: Option<napi::Error>,
}

/// A memory-mode scan's store copied into `into` — arrays JavaScript made as long
/// as `storeShape` says — off the JavaScript thread, and the handle freed. Refused,
/// the scan kept, as `storeTake` refuses and when an array is not the shape's length.
/// Nothing may read or write the arrays until the promise settles.
#[napi(js_name = "storeTakeInto", catch_unwind)]
pub fn store_take_into(handle: u32, into: NativeStoreArrays) -> AsyncTask<StoreTakeInto> {
    let js_thread = thread::current().id();
    let (slot, refusal) = match taken_if(handle, |sink| fits(&into, &sealed_shape(sink)?)) {
        Ok(slot) => (Some(slot), None),
        Err(refusal) => (None, Some(refusal)),
    };
    AsyncTask::new(StoreTakeInto {
        slot,
        into: Some(into),
        js_thread,
        refusal,
    })
}

/// Whether every array in `into` is as long as `shape` says, or the first that is not.
fn fits(into: &NativeStoreArrays, shape: &StoreShape) -> Result<()> {
    let rows = shape.capacity as usize;
    let lengths = [
        ("parent", into.parent.len(), rows),
        ("size", into.size.len(), rows),
        ("mtime", into.mtime.len(), rows),
        ("flags", into.flags.len(), rows),
        ("ext", into.ext.len(), rows),
        ("container", into.container.len(), rows),
        ("cloudProv", into.cloud_prov.len(), rows),
        ("nameOff", into.name_off.len(), rows + 1),
        ("names", into.names.len(), shape.names_room),
        ("childStart", into.child_start.len(), rows),
        ("childCnt", into.child_cnt.len(), rows),
        (
            "extOverflowIds",
            into.ext_overflow_ids.len(),
            shape.ext_overflow,
        ),
        (
            "cloudCandidates",
            into.cloud_candidates.len(),
            shape.cloud_candidates,
        ),
        (
            "textCandidates",
            into.text_candidates.len(),
            shape.text_candidates,
        ),
        (
            "sparseTermIds",
            into.sparse_term_ids.len(),
            shape.sparse_terms,
        ),
        (
            "sparseTermBytes",
            into.sparse_term_bytes.len(),
            shape.sparse_terms,
        ),
    ];
    for (name, got, want) in lengths {
        if got != want {
            return Err(refuse(format!(
                "{name} must be {want} long, as storeShape says; it is {got}"
            )));
        }
    }
    match (&into.atime, shape.atime) {
        (Some(atime), true) if atime.len() != rows => Err(refuse(format!(
            "atime must be {rows} long, as storeShape says; it is {}",
            atime.len()
        ))),
        (None, true) => Err(refuse("atime must be given: the store has access times")),
        (Some(_), false) => Err(refuse(
            "atime must be absent: the store has no access times",
        )),
        _ => Ok(()),
    }
}

/// What the fill leaves for the JavaScript thread: everything but the arrays.
pub struct Filled {
    n: u32,
    capacity: u32,
    names_len: u32,
    ext_dict: Vec<String>,
    ext_overflow_texts: Vec<String>,
    counters: Value,
    stats: Value,
    copied: Copied,
}

/// Bytes copied, on each side of the line between JavaScript's thread and the rest.
struct Copied {
    js_thread: ThreadId,
    off: u64,
    on: u64,
}

impl Copied {
    /// Copies `rows` into the front of `into`, counted on the side it was copied on.
    fn rows<T: Copy>(&mut self, rows: &[T], into: &mut [T]) -> Result<()> {
        let room = into.len();
        let front = into.get_mut(..rows.len()).ok_or_else(|| {
            failure(format!(
                "an array of {room} cannot take {} rows",
                rows.len()
            ))
        })?;
        front.copy_from_slice(rows);
        let bytes = size_of_val(rows) as u64;
        if thread::current().id() == self.js_thread {
            self.on += bytes;
        } else {
            self.off += bytes;
        }
        Ok(())
    }

    /// [`Copied::rows`] of `column`, which is dropped — its mapping released — before
    /// the next column is copied, so at most one column is held twice.
    fn column<T: Copy + Zeroable>(&mut self, column: Column<T>, into: &mut [T]) -> Result<()> {
        self.rows(column.as_slice(), into)?;
        drop(column);
        Ok(())
    }
}

impl Task for StoreTakeInto {
    type Output = Filled;
    type JsValue = NativeStore;

    fn compute(&mut self) -> Result<Filled> {
        if let Some(refusal) = self.refusal.take() {
            return Err(refusal);
        }
        let Some(slot) = self.slot.take() else {
            return Err(failure("storeTakeInto ran twice"));
        };
        let store = sealed_store(slot)?;
        let into = self
            .into
            .as_mut()
            .ok_or_else(|| failure("storeTakeInto has no arrays"))?;
        fill(
            store,
            into,
            Copied {
                js_thread: self.js_thread,
                off: 0,
                on: 0,
            },
        )
    }

    fn resolve(&mut self, _env: Env, filled: Filled) -> Result<NativeStore> {
        let into = self
            .into
            .take()
            .ok_or_else(|| failure("storeTakeInto resolved twice"))?;
        Ok(NativeStore {
            n: filled.n,
            capacity: filled.capacity,
            parent: into.parent,
            size: into.size,
            mtime: into.mtime,
            atime: into.atime,
            flags: into.flags,
            ext: into.ext,
            container: into.container,
            cloud_prov: into.cloud_prov,
            name_off: into.name_off,
            names: into.names,
            names_len: filled.names_len,
            child_start: into.child_start,
            child_cnt: into.child_cnt,
            ext_dict: filled.ext_dict,
            ext_overflow_ids: into.ext_overflow_ids,
            ext_overflow_texts: filled.ext_overflow_texts,
            cloud_candidates: into.cloud_candidates,
            text_candidates: into.text_candidates,
            sparse_term_ids: into.sparse_term_ids,
            sparse_term_bytes: into.sparse_term_bytes,
            counters: filled.counters,
            stats: filled.stats,
            hand_over: Some(NativeHandOver {
                bytes_off_thread: filled.copied.off as f64,
                bytes_on_js_thread: filled.copied.on as f64,
            }),
        })
    }
}

/// `store` copied into JavaScript's arrays, each column dropped right after its copy.
fn fill(store: Store, into: &mut NativeStoreArrays, mut copied: Copied) -> Result<Filled> {
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
    let names_len = name_off.as_slice().last().copied().unwrap_or(0);
    // SAFETY: the arrays are JavaScript's, kept alive by the references napi-rs took
    // when they were passed in; nothing else reads or writes them until the promise
    // `storeTakeInto` returned settles (its contract: `takeNativeStore` made them and
    // awaits it), so these are their only references meanwhile, and each is borrowed once.
    let out = unsafe {
        (
            into.parent.as_mut(),
            into.size.as_mut(),
            into.mtime.as_mut(),
            into.atime.as_mut().map(|atime| atime.as_mut()),
            into.flags.as_mut(),
            into.ext.as_mut(),
            into.container.as_mut(),
            into.cloud_prov.as_mut(),
            into.name_off.as_mut(),
            into.names.as_mut(),
            into.child_start.as_mut(),
            into.child_cnt.as_mut(),
            into.ext_overflow_ids.as_mut(),
            into.cloud_candidates.as_mut(),
            into.text_candidates.as_mut(),
            into.sparse_term_ids.as_mut(),
            into.sparse_term_bytes.as_mut(),
        )
    };
    copied.column(parent, out.0)?;
    copied.column(size, out.1)?;
    copied.column(mtime, out.2)?;
    if let (Some(column), Some(array)) = (atime, out.3) {
        copied.column(column, array)?;
    }
    copied.column(flags, out.4)?;
    copied.column(ext, out.5)?;
    copied.column(container, out.6)?;
    copied.column(cloud_prov, out.7)?;
    copied.column(name_off, out.8)?;
    copied.column(names, out.9)?;
    copied.column(child_start, out.10)?;
    copied.column(child_cnt, out.11)?;
    let (overflow_ids, ext_overflow_texts): (Vec<u32>, Vec<String>) =
        ext_overflow.into_iter().unzip();
    copied.rows(&overflow_ids, out.12)?;
    copied.rows(&cloud_candidates, out.13)?;
    copied.rows(&text_candidates, out.14)?;
    let (term_ids, term_bytes): (Vec<u32>, Vec<f64>) = sparse_terms.into_iter().unzip();
    copied.rows(&term_ids, out.15)?;
    copied.rows(&term_bytes, out.16)?;
    Ok(Filled {
        n,
        capacity,
        names_len,
        ext_dict,
        ext_overflow_texts,
        counters: counters_json(&counters),
        stats: stats_json(&walk_stats),
        copied,
    })
}

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

//! `tm-node`: the napi bindings, the only crate Node touches.
//!
//! One process-wide [`Governor`] is started lazily, with the platform sampler and
//! signals, the first time an export needs it. Every export turns a failure into a
//! [`napi::Error`] with a plain-English message, and nothing panics across the FFI
//! boundary: the lint set denies `unwrap`, `expect` and `panic`, every export is
//! `#[napi(catch_unwind)]`, and the hold's `compute` wraps the governor the same way
//! (libuv's `execute` callback runs it bare, and a panic that unwound out of an
//! `extern "C"` function would abort the process).
//!
//! Shapes cross to JavaScript through serde, with the `rename_all = "camelCase"` the
//! `tm-governor` types carry, so `native/index.d.ts` and `src/services/engineBudget.ts`
//! describe exactly what is emitted: enums as lower-case strings, `Option` as `null`,
//! and the hold report in shares (0..1), the Rust `HoldReport` verbatim.
//!
//! `governorHold` is an [`AsyncTask`]: its `compute` runs on libuv's thread pool,
//! which is acceptable for a test-only measurement of a few seconds and not for a
//! scan. A scan (Phase 3) runs on `tm-walk`'s own threads behind a handle:
//! `scanStart` returns the handle, Node polls `scanPoll` at the SSE cadence (atomics
//! on this side, no callback and no `ThreadsafeFunction`, decision P3-1),
//! `scanPause`/`scanResume`/`scanCancel` reach the handle, and `scanTake` — once a
//! poll has reported `done`; a walk still running is refused, never joined on
//! Node's thread — moves the columns into typed arrays without copying and frees
//! the handle. The walk obeys the same process-wide governor `governorConfigure`
//! drives.
//!
//! The Windows MFT turbo mode (M6) adds two exports. `mftTake` reads the
//! columns file `tm-mft-helper` — the one elevated process, launched by
//! Electron — wrote under the app's temp folder, and hands the columns over
//! exactly as `scanTake` does, or throws the helper's refusal. `mftCrossCheck`
//! is the run-time gate (W6-8): each path opened by this unelevated process
//! with `FILE_READ_ATTRIBUTES` (the listing's own `stat_path`), its kind,
//! size and last-write time compared with what the table said.

use std::any::Any;
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, TryLockError};

use napi::bindgen_prelude::{AsyncTask, Float64Array, Uint8Array, Uint32Array};
use napi::{Env, Error, Result, ScopedTask, Status, Unknown};
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tm_governor::{
    Budget, Governor, HoldReport, Preset, capabilities, hold, platform_sampler, platform_signals,
};
use tm_mft::columns::{ColumnsFile, OUTPUT_EXTENSION, decode as decode_columns, is_output_name};
use tm_walk::{Progress, Refusal, WalkError, WalkHandle, WalkOptions, WalkOutput, WalkStats};

/// The budget the governor starts with before the app configures it: Automatic,
/// Balanced that yields to battery and heat, which is also the app's default setting.
const STARTING_BUDGET: Budget = Budget {
    preset: Preset::Balanced,
    cpu_percent: None,
};
/// Automatic mode for the starting budget.
const STARTING_AUTO: bool = true;
/// A numeric override replaces the preset's ceiling only in this range (percent of
/// machine CPU); the Rust side clamps, the boundary refuses.
const CPU_PERCENT_MIN: u8 = 1;
/// The top of the override range (percent of machine CPU).
const CPU_PERCENT_MAX: u8 = 100;
/// The lowest target `governorHold` holds (percent of machine CPU).
const HOLD_PERCENT_MIN: f64 = 1.0;
/// The highest target `governorHold` holds (percent of machine CPU).
const HOLD_PERCENT_MAX: f64 = 100.0;
/// The shortest hold (seconds): under a second there are not ten samples to judge.
const HOLD_SECONDS_MIN: f64 = 1.0;
/// The longest hold (seconds): ten minutes, already the three gate runs together.
const HOLD_SECONDS_MAX: f64 = 600.0;
/// The shape `governorConfigure` accepts, for the refusal message.
const BUDGET_SHAPE: &str = "governorConfigure needs a budget like { preset: 'eco' | 'balanced' | 'turbo', cpuPercent?: 1..100 | null }";

/// What the app last asked for, kept beside the governor because [`Governor`]
/// reports its budget but not whether auto mode is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Configured {
    budget: Budget,
    auto: bool,
}

/// The process-wide governor and the bookkeeping around it.
struct Shared {
    governor: Governor,
    configured: Mutex<Configured>,
    /// Taken for the length of a hold; a second hold finds it taken and is refused
    /// rather than run on top of the first.
    hold_slot: Mutex<()>,
}

static SHARED: OnceLock<Shared> = OnceLock::new();

/// The governor, started on first use with this machine's sampler and signals.
fn shared() -> &'static Shared {
    SHARED.get_or_init(|| Shared {
        governor: Governor::start(
            STARTING_BUDGET,
            STARTING_AUTO,
            platform_sampler(),
            platform_signals(),
        ),
        configured: Mutex::new(Configured {
            budget: STARTING_BUDGET,
            auto: STARTING_AUTO,
        }),
        hold_slot: Mutex::new(()),
    })
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A refusal of what the caller passed, as a JavaScript error with the message.
fn refuse(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

/// A failure inside the native core, as a JavaScript error with the message.
fn failure(message: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, message.into())
}

/// The text a panic carried, for the error it becomes.
fn panic_text(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .unwrap_or_else(|| {
            payload
                .downcast_ref::<&str>()
                .map_or_else(|| "no message".to_owned(), |s| (*s).to_owned())
        })
}

/// `value` as JSON for JavaScript: the `tm-governor` types' own serde shape.
fn to_json<T: Serialize>(what: &str, value: &T) -> Result<Value> {
    serde_json::to_value(value)
        .map_err(|err| failure(format!("the native core could not serialise {what}: {err}")))
}

/// The budget object from JavaScript, checked at the boundary: one of the three
/// presets and a whole-number override from 1 to 100 or null; anything else is
/// refused with the shape and what was received.
fn parse_budget(raw: Value) -> Result<Budget> {
    let received = raw.to_string();
    let budget: Budget = serde_json::from_value(raw)
        .map_err(|err| refuse(format!("{BUDGET_SHAPE}; got {received}: {err}")))?;
    if let Some(percent) = budget.cpu_percent
        && !(CPU_PERCENT_MIN..=CPU_PERCENT_MAX).contains(&percent)
    {
        return Err(refuse(format!(
            "cpuPercent must be a whole number from 1 to 100, or null to keep the preset's own ceiling; got {percent}"
        )));
    }
    Ok(budget)
}

/// The crate's version. The loader (`src/services/scan/native.ts`) refuses a module
/// whose version is not `package.json`'s `nativeVersion`.
#[napi(catch_unwind)]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// The seven mechanisms this machine offers (`qos`, `ioPolicy`, `priority`,
/// `thermal`, `battery`, `interaction`, `machineCpu`), each
/// `{ available, mechanism, reason }`. Probed only; nothing is applied.
#[napi(js_name = "governorCapabilities", catch_unwind)]
pub fn governor_capabilities() -> Result<Value> {
    to_json("the capabilities", &capabilities())
}

/// Sets the budget live. `budget` is `{ preset, cpuPercent? }`; `auto` makes it
/// Balanced that flips to Eco on battery or under serious heat. A budget that is not
/// valid is refused and the one in force stays.
#[napi(js_name = "governorConfigure", catch_unwind)]
pub fn governor_configure(budget: Option<Value>, auto: bool) -> Result<()> {
    let raw = budget.ok_or_else(|| refuse(format!("{BUDGET_SHAPE}; got nothing")))?;
    let budget = parse_budget(raw)?;
    let shared = shared();
    let mut configured = lock(&shared.configured);
    shared.governor.configure(budget, auto);
    *configured = Configured { budget, auto };
    Ok(())
}

/// The governor's state at this instant: the Rust `Snapshot` in camelCase.
#[napi(js_name = "governorSnapshot", catch_unwind)]
pub fn governor_snapshot() -> Result<Value> {
    to_json("the snapshot", &shared().governor.snapshot())
}

/// Blocks every worker at its next throttle until `governorResume()`.
#[napi(js_name = "governorPause", catch_unwind)]
pub fn governor_pause() {
    shared().governor.pause();
}

/// Releases workers paused by `governorPause()`; a thermal pause stays.
#[napi(js_name = "governorResume", catch_unwind)]
pub fn governor_resume() {
    shared().governor.resume();
}

/// What a hold was asked for, once the arguments passed the boundary check.
#[derive(Debug, Clone, Copy)]
struct HoldRequest {
    percent: u8,
    seconds: f64,
}

/// The hold as a task: its arguments are checked on the JavaScript thread, the
/// measurement runs on libuv's pool, and the promise resolves with the report or
/// rejects with the refusal.
pub struct HoldTask {
    request: std::result::Result<HoldRequest, String>,
}

/// Holds `targetPercent` of the machine for `seconds` with a synthetic load on the
/// configured preset (its QoS class and I/O policy included; only the ceiling is
/// replaced), then hands the budget back. Resolves with the Rust `HoldReport` in
/// shares. Refused, by rejection, outside 1..=100 percent or 1..=600 seconds, and
/// while another hold runs.
#[napi(js_name = "governorHold", catch_unwind)]
pub fn governor_hold(target_percent: f64, seconds: f64) -> AsyncTask<HoldTask> {
    AsyncTask::new(HoldTask {
        request: hold_request(target_percent, seconds),
    })
}

/// Checks a hold's arguments; the message names the argument and its range.
fn hold_request(target_percent: f64, seconds: f64) -> std::result::Result<HoldRequest, String> {
    if !target_percent.is_finite()
        || !(HOLD_PERCENT_MIN..=HOLD_PERCENT_MAX).contains(&target_percent)
    {
        return Err(format!(
            "targetPercent must be a number from 1 to 100 (percent of machine CPU); got {target_percent}"
        ));
    }
    if !seconds.is_finite() || !(HOLD_SECONDS_MIN..=HOLD_SECONDS_MAX).contains(&seconds) {
        return Err(format!(
            "seconds must be a number from 1 to 600; got {seconds}"
        ));
    }
    Ok(HoldRequest {
        percent: percent_to_u8(target_percent),
        seconds,
    })
}

/// The whole-number percent a checked target rounds to.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the caller checked 1 <= percent <= 100 and the clamp restates it, so the rounded value is positive and fits a u8"
)]
fn percent_to_u8(percent: f64) -> u8 {
    percent.round().clamp(HOLD_PERCENT_MIN, HOLD_PERCENT_MAX) as u8
}

/// Runs one hold on the shared governor: takes the slot, replaces the ceiling with the
/// target (the preset, and so the OS mechanisms, stays the one configured), measures,
/// and puts the budget back unless the app reconfigured meanwhile.
fn run_hold(request: HoldRequest) -> Result<HoldReport> {
    let shared = shared();
    let _slot = match shared.hold_slot.try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(TryLockError::WouldBlock) => {
            return Err(refuse(
                "a hold is already running; wait for it to finish before starting another",
            ));
        }
    };
    let before = {
        let configured = lock(&shared.configured);
        shared.governor.configure(
            Budget {
                preset: configured.budget.preset,
                cpu_percent: Some(request.percent),
            },
            false,
        );
        *configured
    };
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let mut sampler = platform_sampler();
        hold(&shared.governor, request.seconds, sampler.as_mut())
    }));
    {
        let configured = lock(&shared.configured);
        if *configured == before {
            shared.governor.configure(before.budget, before.auto);
        }
    }
    outcome.map_err(|payload| {
        failure(format!(
            "the native governor failed inside governorHold: {}",
            panic_text(payload.as_ref())
        ))
    })
}

impl<'task> ScopedTask<'task> for HoldTask {
    type Output = HoldReport;
    type JsValue = Unknown<'task>;

    fn compute(&mut self) -> Result<HoldReport> {
        let request = self
            .request
            .as_ref()
            .map_err(|message| refuse(message.clone()))?;
        run_hold(*request)
    }

    fn resolve(&mut self, env: &'task Env, output: HoldReport) -> Result<Unknown<'task>> {
        env.to_js_value(&output)
    }
}

/* ------------------------------ the native walker (Phase 3) ------------------------------ */

/// The shape `scanStart` accepts, for the refusal message.
const START_SHAPE: &str = "scanStart needs options like { neverDescend: string[], wantAtime: boolean, maxWorkers?: number, bufferBytes?: number }";

/// What `scanStart` takes, checked at the boundary: unknown keys are refused so a
/// misspelled option can never be silently ignored.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartOptions {
    /// Absolute paths the walk never descends into (the legacy list, passed from Node).
    #[serde(default)]
    never_descend: Vec<String>,
    /// Whether to record access times.
    #[serde(default)]
    want_atime: bool,
    /// A fixed worker count, still capped by the governor; absent, null or 0 lets the hill-climber decide.
    #[serde(default)]
    max_workers: Option<u32>,
    /// Bytes per worker listing buffer; absent, null or 0 is the crate's default.
    #[serde(default)]
    buffer_bytes: Option<u32>,
}

/// A walk that has ended: the last progress it reported and its outcome.
struct Finished {
    progress: Progress,
    result: std::result::Result<WalkOutput, WalkError>,
}

/// One walk as the table holds it: running behind its handle, or finished. The
/// poll that first sees `done` takes the handle so that a failure is reported by
/// `scanPoll` and thrown by `scanTake`; `scanTake` removes the slot either way,
/// but only once the walk is done — a running one is refused and stays.
enum Slot {
    Running(WalkHandle),
    Finished(Box<Finished>),
}

/// Every walk this process has started and not yet taken, by handle.
struct Scans {
    slots: Mutex<HashMap<u32, Slot>>,
    next: AtomicU32,
}

static SCANS: OnceLock<Scans> = OnceLock::new();

fn scans() -> &'static Scans {
    SCANS.get_or_init(|| Scans {
        slots: Mutex::new(HashMap::new()),
        next: AtomicU32::new(1),
    })
}

/// The refusal for a handle the table does not hold.
fn unknown_handle(handle: u32) -> Error {
    refuse(format!(
        "no scan handle {handle}: it was taken, cancelled or never started"
    ))
}

/// How a walk ended other than with an output, in plain English. A root refusal
/// is prefixed with Node's own errno spelling, so the scanner's error path turns
/// it into the sentence every engine uses.
fn walk_error_text(err: &WalkError) -> String {
    match err {
        WalkError::RootNotDirectory => {
            "ENOTDIR: the root is not a folder, so the native engine cannot walk it".to_owned()
        }
        WalkError::RootRefused(Refusal::Denied) => {
            "EACCES: the native engine was not allowed to list the root".to_owned()
        }
        WalkError::RootRefused(Refusal::Vanished) => {
            "ENOENT: the root disappeared while the native engine was scanning it".to_owned()
        }
        WalkError::RootRefused(Refusal::Unreadable) => {
            "EIO: the root could not be read by the native engine".to_owned()
        }
        WalkError::Unsupported(reason) => reason.clone(),
        WalkError::Cancelled => "the native scan was cancelled".to_owned(),
        WalkError::Internal(reason) => format!("the native engine failed: {reason}"),
    }
}

/// [`walk_error_text`] as the JavaScript error: a root that is not a folder is the
/// caller's mistake, everything else a failure.
fn walk_error(err: &WalkError) -> Error {
    let text = walk_error_text(err);
    match err {
        WalkError::RootNotDirectory => refuse(text),
        WalkError::RootRefused(_)
        | WalkError::Unsupported(_)
        | WalkError::Cancelled
        | WalkError::Internal(_) => failure(text),
    }
}

/// The walk's stats as JavaScript sees them: camelCase, `cpuSeconds` null where the
/// platform has no thread clock (never zero, which would be a measurement).
fn stats_json(stats: &WalkStats) -> Value {
    json!({
        "dirsListed": stats.dirs_listed,
        "entries": stats.entries,
        "wallMs": stats.wall_ms,
        "cpuSeconds": stats.cpu_seconds.is_finite().then_some(stats.cpu_seconds),
        "fastPath": stats.fast_path.as_str(),
        "workersPeak": stats.workers_peak,
        "climbSteps": stats.climb_steps,
        "deniedEntries": stats.denied_entries,
        "unreadableEntries": stats.unreadable_entries,
        "dataless": stats.dataless,
    })
}

/// The progress object `scanPoll` returns. `heartbeat` is the walk's own count of
/// listing batches the OS has answered, across every worker: it advances while one
/// huge directory is still listing, when `entries` cannot, so Node can tell a slow
/// walk from a wedged one.
fn progress_json(progress: &Progress, error: Option<&str>) -> Value {
    json!({
        "done": progress.done,
        "error": error,
        "entries": progress.entries,
        "dirs": progress.dirs,
        "files": progress.files,
        "bytes": progress.bytes,
        "heartbeat": progress.heartbeat,
        "currentPath": progress.current_path,
    })
}

/// The walk's product as `scanTake` returns it: columns in discovery order (index
/// 0 is the root, `parent[i] < i`), each created from the Rust `Vec` without
/// copying — napi takes the allocation over and frees it when JavaScript drops
/// the array — plus the side tables and the stats.
#[napi(object)]
pub struct WalkResult {
    /// Parent index; the root's is 0.
    pub parent: Uint32Array,
    /// `parent.length + 1` offsets into `names`.
    pub name_off: Uint32Array,
    /// Every name as UTF-8, back to back.
    pub names: Uint8Array,
    /// 0 = file (or socket, fifo, device), 1 = directory, 2 = symlink.
    pub kind: Uint8Array,
    /// Bit 1 = dataless, bit 2 = a directory that could not be listed.
    pub flags: Uint8Array,
    /// Logical size in bytes (0 for directories).
    pub size: Float64Array,
    /// Allocated bytes (0 for directories).
    pub alloc_bytes: Float64Array,
    /// Modification time in milliseconds, unrounded; NaN when withheld.
    pub mtime_ms: Float64Array,
    /// Access time the same way; NaN when not asked for or not recorded.
    pub atime_ms: Float64Array,
    /// Every leaf that shares its file with another name, sorted by node: its index.
    pub hardlink_node: Uint32Array,
    /// Its family's number, the same for every name of one file (an id never
    /// crosses as a double: the pre-landing review of 23 Sep 2026).
    pub hardlink_family: Uint32Array,
    /// Every directory that could not be listed, sorted by node: its index.
    pub refusal_node: Uint32Array,
    /// Why: 1 denied, 2 vanished, 3 unreadable.
    pub refusal_why: Uint8Array,
    /// The Rust `WalkStats` in camelCase (`cpuSeconds` null where unmeasured).
    pub stats: Value,
}

/// Moves a walk's output into typed arrays. Nothing is copied but the two small
/// side tables, which are split into their columns.
fn columns(output: WalkOutput) -> WalkResult {
    let WalkOutput {
        parent,
        name_off,
        names,
        kind,
        flags,
        size,
        alloc_bytes,
        mtime_ms,
        atime_ms,
        hardlinks,
        refusals,
        stats,
    } = output;
    let mut hardlink_node = Vec::with_capacity(hardlinks.len());
    let mut hardlink_family = Vec::with_capacity(hardlinks.len());
    for link in &hardlinks {
        hardlink_node.push(link.node);
        hardlink_family.push(link.family);
    }
    let mut refusal_node = Vec::with_capacity(refusals.len());
    let mut refusal_why = Vec::with_capacity(refusals.len());
    for refusal in &refusals {
        refusal_node.push(refusal.node);
        refusal_why.push(refusal.why.code());
    }
    WalkResult {
        parent: Uint32Array::new(parent),
        name_off: Uint32Array::new(name_off),
        names: Uint8Array::new(names),
        kind: Uint8Array::new(kind),
        flags: Uint8Array::new(flags),
        size: Float64Array::new(size),
        alloc_bytes: Float64Array::new(alloc_bytes),
        mtime_ms: Float64Array::new(mtime_ms),
        atime_ms: Float64Array::new(atime_ms),
        hardlink_node: Uint32Array::new(hardlink_node),
        hardlink_family: Uint32Array::new(hardlink_family),
        refusal_node: Uint32Array::new(refusal_node),
        refusal_why: Uint8Array::new(refusal_why),
        stats: stats_json(&stats),
    }
}

/// Opens and lists `root` once with this platform's listing; no side effects
/// beyond the read. `{ fastPath, reason }`, never a throw.
#[napi(js_name = "scanProbe", catch_unwind)]
pub fn scan_probe(root: String) -> Value {
    let probe = tm_walk::probe(&PathBuf::from(root));
    json!({ "fastPath": probe.fast_path.as_str(), "reason": probe.reason })
}

/// Starts a walk of `root` on `tm-walk`'s own threads, governed by the process-wide
/// governor, and returns its handle. Refuses options of the wrong shape, a root
/// that is not a folder or cannot be read (with Node's errno spelling in front),
/// and a platform without a native listing, each in plain English.
#[napi(js_name = "scanStart", catch_unwind)]
pub fn scan_start(root: String, opts: Option<Value>) -> Result<u32> {
    let raw = opts.unwrap_or_else(|| Value::Object(serde_json::Map::new()));
    let received = raw.to_string();
    let options: StartOptions = serde_json::from_value(raw)
        .map_err(|err| refuse(format!("{START_SHAPE}; got {received}: {err}")))?;
    let walk_options = WalkOptions {
        root: PathBuf::from(root),
        never_descend: options
            .never_descend
            .into_iter()
            .map(PathBuf::from)
            .collect(),
        want_atime: options.want_atime,
        max_workers: options
            .max_workers
            .map_or(0, |n| usize::try_from(n).unwrap_or(usize::MAX)),
        buffer_bytes: options
            .buffer_bytes
            .map_or(0, |n| usize::try_from(n).unwrap_or(usize::MAX)),
    };
    let governor = Arc::new(shared().governor.clone());
    let handle = tm_walk::start(walk_options, governor).map_err(|err| walk_error(&err))?;
    let table = scans();
    let id = table.next.fetch_add(1, Ordering::AcqRel);
    lock(&table.slots).insert(id, Slot::Running(handle));
    Ok(id)
}

/// The walk's progress right now: `{ done, error, entries, dirs, files, bytes,
/// heartbeat, currentPath }`. Once the walk is done its outcome is kept for
/// `scanTake`, and `error` says how it ended when it did not produce an output.
#[napi(js_name = "scanPoll", catch_unwind)]
pub fn scan_poll(handle: u32) -> Result<Value> {
    let mut slots = lock(&scans().slots);
    let slot = slots
        .remove(&handle)
        .ok_or_else(|| unknown_handle(handle))?;
    let (progress, error) = match slot {
        Slot::Running(walk) => {
            let progress = walk.progress();
            if progress.done {
                let result = walk.take();
                let error = result.as_ref().err().map(walk_error_text);
                slots.insert(
                    handle,
                    Slot::Finished(Box::new(Finished {
                        progress: progress.clone(),
                        result,
                    })),
                );
                (progress, error)
            } else {
                slots.insert(handle, Slot::Running(walk));
                (progress, None)
            }
        }
        Slot::Finished(finished) => {
            let progress = finished.progress.clone();
            let error = finished.result.as_ref().err().map(walk_error_text);
            slots.insert(handle, Slot::Finished(finished));
            (progress, error)
        }
    };
    drop(slots);
    Ok(progress_json(&progress, error.as_deref()))
}

/// Runs `act` on a walk that is still running; a finished walk has nothing to
/// pause, resume or cancel and is left alone; an unknown handle is refused.
fn with_running(handle: u32, act: impl FnOnce(&WalkHandle)) -> Result<()> {
    let slots = lock(&scans().slots);
    match slots.get(&handle) {
        None => Err(unknown_handle(handle)),
        Some(Slot::Running(walk)) => {
            act(walk);
            Ok(())
        }
        Some(Slot::Finished(_)) => Ok(()),
    }
}

/// Stops the workers at their next check (between directories and every 256
/// entries inside one); nothing is re-listed on resume.
#[napi(js_name = "scanPause", catch_unwind)]
pub fn scan_pause(handle: u32) -> Result<()> {
    with_running(handle, WalkHandle::pause)
}

/// Lets paused workers continue where they stopped.
#[napi(js_name = "scanResume", catch_unwind)]
pub fn scan_resume(handle: u32) -> Result<()> {
    with_running(handle, WalkHandle::resume)
}

/// Ends the walk at the workers' next check; a poll then reports `done`, and
/// `scanTake` throws the cancellation and frees the handle.
#[napi(js_name = "scanCancel", catch_unwind)]
pub fn scan_cancel(handle: u32) -> Result<()> {
    with_running(handle, WalkHandle::cancel)
}

/// The refusal for a take of a walk that has not reported done.
const STILL_RUNNING: &str =
    "the walk is still running: poll it until done — cancel first to end it — before taking it";

/// The walk's output as columns, once the walk is done (poll until `done`), and
/// the handle freed — a walk that failed or was cancelled throws its reason and is
/// freed too. A walk still running is refused and kept, never joined: joining it
/// would block the caller's thread — Node's main thread — until every worker
/// returned, and a worker wedged inside a listing syscall on a dead network mount
/// never does. An unknown handle is refused.
#[napi(js_name = "scanTake", catch_unwind)]
pub fn scan_take(handle: u32) -> Result<WalkResult> {
    let slot = {
        let mut slots = lock(&scans().slots);
        let slot = slots
            .remove(&handle)
            .ok_or_else(|| unknown_handle(handle))?;
        if let Slot::Running(walk) = &slot
            && !walk.progress().done
        {
            slots.insert(handle, slot);
            return Err(refuse(STILL_RUNNING));
        }
        slot
    };
    let result = match slot {
        // Done: the driver has finished, so the join returns at once.
        Slot::Running(walk) => walk.take(),
        Slot::Finished(finished) => finished.result,
    };
    let output = result.map_err(|err| walk_error(&err))?;
    Ok(columns(output))
}

/* ------------------------------ the Windows MFT turbo mode (W6, M6) ------------------------------ */

/// The columns `tm-mft-helper` wrote to `path`, as `scanTake` returns a
/// walk's: the file is read whole, checked (`tm_mft::columns` refuses a file
/// that is short, long, tampered with or shaped wrong — a parent that does
/// not precede its child above all), and moved into typed arrays. A refusal
/// file throws the helper's own sentence. The file is left where it is: the
/// app, which made the folder, removes it. Only a file named as the app names
/// its columns files is read at all ([`is_output_name`]): the one caller
/// passes the path it made, and the name rule keeps any later one from
/// pointing this at some other file (the security review of M6).
#[napi(js_name = "mftTake", catch_unwind)]
pub fn mft_take(path: String) -> Result<WalkResult> {
    let path = PathBuf::from(path);
    let named = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(is_output_name);
    if !named {
        return Err(failure(format!(
            "{} is not a columns file the app named (<id>{OUTPUT_EXTENSION}), so it is not read",
            path.display()
        )));
    }
    let bytes = std::fs::read(&path).map_err(|err| {
        failure(format!(
            "the MFT helper's columns file {} could not be read: {err}",
            path.display()
        ))
    })?;
    match decode_columns(&bytes).map_err(|err| failure(err.to_string()))? {
        ColumnsFile::Columns(output) => Ok(columns(*output)),
        ColumnsFile::Refusal(sentence) => Err(failure(sentence)),
    }
}

/// Windows' system folder as the kernel reports it, or `null` (elsewhere, or
/// if Windows does not answer). The NTFS turbo mode's launcher starts
/// PowerShell from it by its full path, never by name or from an
/// environment variable (the third security review of M6).
#[napi(js_name = "systemDirectory")]
pub fn system_directory() -> Option<String> {
    system_directory_here()
}

#[cfg(windows)]
fn system_directory_here() -> Option<String> {
    tm_mft::system_directory().map(|dir| dir.to_string_lossy().into_owned())
}

#[cfg(not(windows))]
fn system_directory_here() -> Option<String> {
    None
}

/// The shape `mftCrossCheck` accepts for each expected entry.
const EXPECTED_SHAPE: &str =
    "mftCrossCheck needs one { kind: 0 | 1 | 2, size: number, mtimeMs: number } per path";

/// What the table said about one entry.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Expected {
    kind: u8,
    size: f64,
    mtime_ms: f64,
}

/// One entry as this process sees it now.
struct Live {
    kind: u8,
    size: f64,
    mtime_ms: f64,
}

/// `path` itself, now, as the listing would stat it: on Windows the
/// listing's own `stat_path` (opened with `FILE_READ_ATTRIBUTES`, a final
/// reparse point not followed, kind and size by libuv's rules).
#[cfg(windows)]
fn live_facts(path: &str) -> std::result::Result<Live, String> {
    tm_walk::platform::windows::stat_path(std::path::Path::new(path), false)
        .map(|meta| Live {
            kind: meta.kind,
            size: meta.size,
            mtime_ms: meta.mtime_ms,
        })
        .map_err(|code| format!("Windows error {code}"))
}

/// `path` itself, now, as `lstat` reports it (the cross-check is Windows
/// only in the app; this keeps the export honest and testable elsewhere).
#[cfg(unix)]
fn live_facts(path: &str) -> std::result::Result<Live, String> {
    use std::os::unix::fs::MetadataExt;
    use tm_walk::{KIND_DIR, KIND_FILE, KIND_SYMLINK};
    let meta = std::fs::symlink_metadata(path).map_err(|err| err.to_string())?;
    let file_type = meta.file_type();
    let kind = if file_type.is_dir() {
        KIND_DIR
    } else if file_type.is_symlink() {
        KIND_SYMLINK
    } else {
        KIND_FILE
    };
    #[allow(
        clippy::cast_precision_loss,
        reason = "sizes cross to JavaScript as doubles (P3-7), exact to 2^53"
    )]
    let size = if kind == KIND_DIR {
        0.0
    } else {
        meta.len() as f64
    };
    Ok(Live {
        kind,
        size,
        mtime_ms: tm_walk::platform::time_ms(meta.mtime(), meta.mtime_nsec()),
    })
}

#[cfg(not(any(windows, unix)))]
fn live_facts(_path: &str) -> std::result::Result<Live, String> {
    Err("this platform has no live check".to_owned())
}

/// The fields that differ, in the order the reason names them.
fn differing(expected: &Expected, live: &Live) -> Vec<&'static str> {
    let mut fields = Vec::new();
    if expected.kind != live.kind {
        fields.push("kind");
    }
    if expected.size.to_bits() != live.size.to_bits() {
        fields.push("size");
    }
    if expected.mtime_ms.to_bits() != live.mtime_ms.to_bits() {
        fields.push("mtime");
    }
    fields
}

/// Opens each path now, unelevated, and compares its kind, size and
/// last-write time with what the master file table said (`expected`, one
/// per path, in order). One result per path: `{ outcome: 'match' |
/// 'mismatch' | 'unopenable', kind, size, mtimeMs, differs, reason }` — the
/// live values (null when the path could not be opened), the fields that
/// differ, and why a path could not be opened. Deciding what a mismatch
/// means (a divergence, or a file changed since the read) is the caller's.
#[napi(js_name = "mftCrossCheck", catch_unwind)]
pub fn mft_cross_check(paths: Vec<String>, expected: Value) -> Result<Value> {
    let received = expected.to_string();
    let expected: Vec<Expected> = serde_json::from_value(expected)
        .map_err(|err| refuse(format!("{EXPECTED_SHAPE}; got {received}: {err}")))?;
    if expected.len() != paths.len() {
        return Err(refuse(format!(
            "{EXPECTED_SHAPE}: {} paths but {} expected entries",
            paths.len(),
            expected.len()
        )));
    }
    let results: Vec<Value> = paths
        .into_iter()
        .zip(&expected)
        .map(|(path, want)| match live_facts(&path) {
            Err(reason) => json!({
                "outcome": "unopenable", "kind": null, "size": null, "mtimeMs": null,
                "differs": [], "reason": reason,
            }),
            Ok(live) => {
                let differs = differing(want, &live);
                json!({
                    "outcome": if differs.is_empty() { "match" } else { "mismatch" },
                    "kind": live.kind,
                    "size": live.size,
                    "mtimeMs": live.mtime_ms.is_finite().then_some(live.mtime_ms),
                    "differs": differs,
                    "reason": null,
                })
            }
        })
        .collect();
    Ok(Value::Array(results))
}

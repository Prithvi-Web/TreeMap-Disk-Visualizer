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
//! scan. Phase 3 runs a scan on a dedicated thread and reports through a batched
//! `ThreadsafeFunction`.

use std::any::Any;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError, TryLockError};

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, Result, ScopedTask, Status, Unknown};
use napi_derive::napi;
use serde::Serialize;
use serde_json::Value;
use tm_governor::{
    Budget, Governor, HoldReport, Preset, capabilities, hold, platform_sampler, platform_signals,
};

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

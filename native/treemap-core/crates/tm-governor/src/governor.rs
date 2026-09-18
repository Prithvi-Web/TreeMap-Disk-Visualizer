//! The governor: a ticking thread that samples this process, runs the
//! [`Controller`] and publishes its decision; `throttle()` for the workers;
//! pause and resume; live reconfiguration; the auto-Eco rule; and a snapshot
//! of it all.
//!
//! The tick thread owns the sampler and the signals. Every [`TICK`] it measures
//! the real interval with an [`Instant`], reads the process's CPU time since the
//! previous tick, and feeds a [`Sample`] to the controller. The decision goes to
//! atomics the workers read without a lock: the worker count, the duty (stored
//! as the `f64`'s bits, exactly) and the pause flag.
//!
//! A worker calls [`Governor::throttle`] after each unit of work. The call
//! applies the preset to the calling thread on its first visit and again after
//! the profile changes, blocks while the governor is paused, then owes the
//! thread's sleep ledger `(1 − duty) / duty × elapsed-since-last-call`, capped
//! at [`THROTTLE_SLEEP_CAP`], and sleeps what is owed. The ledger counts what
//! was actually slept, because a low-QoS thread's sleep can overrun by an
//! order of magnitude: an overrun becomes credit and the next sleeps are
//! skipped, so the duty holds on average. A stopped governor governs nothing: `throttle()`
//! returns at once, paused or not, so workers can never be stranded.
//!
//! Auto mode (`auto = true`) means Balanced that flips to Eco while the machine
//! runs on battery or reports `Serious` or worse thermal pressure, and back when
//! it does not. An unknown signal is not pressure.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::controller::{Controller, DUTY_MAX, DUTY_MIN, Decision, Sample, Thermal};
use crate::enforce::{EnforceReport, Mechanism, apply_to_current_thread};
use crate::preset::{Budget, Preset, PresetProfile, profile};
use crate::sample::CpuSampler;
use crate::signals::Signals;

/// The tick period. The controller sees the interval that was measured, never this.
pub const TICK: Duration = Duration::from_millis(100);
/// The longest one `throttle()` call sleeps, however long the unit of work was; it also
/// bounds the sleep ledger in both directions.
pub const THROTTLE_SLEEP_CAP: Duration = Duration::from_secs(1);
/// Sleeps shorter than this are saved up in the ledger: a wakeup costs more than they are worth.
pub const THROTTLE_MIN_SLEEP: Duration = Duration::from_millis(1);
/// The most a worker may run ahead of its budget after the OS over-slept it: credit beyond
/// this is forgiven, and the loop makes up the small shortfall it causes.
pub const THROTTLE_CREDIT_CAP: Duration = Duration::from_millis(250);
/// Ticks averaged into [`Snapshot::share_1s`] (one second at the nominal tick).
pub const SHARE_WINDOW_TICKS: usize = 10;
/// How long a paused worker waits before re-checking whether it may stop waiting.
const PAUSE_POLL: Duration = Duration::from_millis(50);
/// The name the tick thread carries in a debugger.
const TICK_THREAD_NAME: &str = "tm-governor-tick";
/// What the snapshot reports for a mechanism before any worker has applied the profile.
const NOT_APPLIED_MECHANISM: &str = "not applied yet";
/// Why nothing has been applied before the first worker.
const NOT_APPLIED_REASON: &str =
    "no worker thread has called throttle() yet; the profile is applied on a worker's first call";

/// Everything the API and the UI show about the governor, copied at one instant.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// The budget as configured.
    pub budget: Budget,
    /// The preset in force: the budget's, or what auto mode chose.
    pub effective: Preset,
    /// The share of all cores the loop is holding right now, after scaling.
    pub target_share: f64,
    /// The mean measured share over the last [`SHARE_WINDOW_TICKS`] ticks; `0.0`
    /// before the first tick (see [`Snapshot::ticks`]).
    pub share_1s: f64,
    /// How many workers may run.
    pub workers: u32,
    /// The fraction of wall time each worker may run.
    pub duty: f64,
    /// The last thermal reading.
    pub thermal: Thermal,
    /// The last power-source reading.
    pub on_battery: Option<bool>,
    /// The last interaction reading.
    pub interacting: Option<bool>,
    /// The machine's busy share from the last tick whose counters were new; the OS
    /// publishes them only every second or so, and a tick without new counters keeps
    /// the last reading. `None` until the OS has published one.
    pub machine_busy_share: Option<f64>,
    /// Whether workers are blocked in `throttle()`, by a caller or by `Critical` heat.
    pub paused: bool,
    /// Ticks the loop has run.
    pub ticks: u64,
    /// What the OS accepted when the profile was last applied to a worker thread.
    pub mechanisms: EnforceReport,
}

/// A handle to one governor. Clones share it; the tick thread ends when the last
/// clone is dropped or [`stop`](Self::stop) is called.
#[derive(Debug, Clone)]
pub struct Governor {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    /// Distinguishes governors in a thread's throttle state.
    id: u64,
    state: Mutex<State>,
    pause: Mutex<PauseState>,
    pause_changed: Condvar,
    workers: AtomicU32,
    duty_bits: AtomicU64,
    paused: AtomicBool,
    stopped: AtomicBool,
    /// Bumped whenever the profile a worker must apply changes.
    generation: AtomicU64,
    thread: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Debug)]
struct State {
    budget: Budget,
    auto: bool,
    effective: Preset,
    profile: PresetProfile,
    controller: Controller,
    decision: Decision,
    cores: u32,
    thermal: Thermal,
    on_battery: Option<bool>,
    interacting: Option<bool>,
    machine_busy_share: Option<f64>,
    ticks: u64,
    recent_shares: VecDeque<f64>,
    mechanisms: EnforceReport,
}

#[derive(Debug, Default)]
struct PauseState {
    by_user: bool,
    by_thermal: bool,
}

impl PauseState {
    fn any(&self) -> bool {
        self.by_user || self.by_thermal
    }
}

/// Per-thread throttle bookkeeping: which governor, when the last call ended,
/// which profile generation this thread has applied, and the sleep ledger.
struct ThrottleState {
    governor_id: u64,
    last_call_ended: Instant,
    applied_generation: u64,
    /// Sleep owed (positive) or credit from sleeps that overran (negative), in nanoseconds.
    ledger_ns: i64,
}

thread_local! {
    static THROTTLE: RefCell<Option<ThrottleState>> = const { RefCell::new(None) };
}

static NEXT_GOVERNOR_ID: AtomicU64 = AtomicU64::new(1);

impl Governor {
    /// Starts a governor for `budget` and spawns its tick thread. `auto` makes
    /// the budget Balanced-that-flips-to-Eco (see the module docs). If the OS
    /// refuses the thread, the governor is inert: `ticks` stays at zero and
    /// `throttle()` never sleeps.
    pub fn start(
        budget: Budget,
        auto: bool,
        sampler: Box<dyn CpuSampler>,
        signals: Box<dyn Signals>,
    ) -> Governor {
        let cores = sampler.cores().max(1);
        let effective = effective_preset(budget, auto, None, Thermal::Unknown);
        let initial = profile(effective, cores, budget.cpu_percent);
        let controller = Controller::new(initial, cores);
        let decision = controller.decision();
        let inner = Arc::new(Inner {
            id: NEXT_GOVERNOR_ID.fetch_add(1, Ordering::Relaxed),
            state: Mutex::new(State {
                budget,
                auto,
                effective,
                profile: initial,
                controller,
                decision,
                cores,
                thermal: Thermal::Unknown,
                on_battery: None,
                interacting: None,
                machine_busy_share: None,
                ticks: 0,
                recent_shares: VecDeque::with_capacity(SHARE_WINDOW_TICKS),
                mechanisms: not_applied_report(),
            }),
            pause: Mutex::new(PauseState::default()),
            pause_changed: Condvar::new(),
            workers: AtomicU32::new(decision.workers),
            duty_bits: AtomicU64::new(decision.duty.to_bits()),
            paused: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            generation: AtomicU64::new(1),
            thread: Mutex::new(None),
        });
        let weak = Arc::downgrade(&inner);
        let spawned = thread::Builder::new()
            .name(TICK_THREAD_NAME.to_owned())
            .spawn(move || run_ticks(&weak, sampler, signals));
        match spawned {
            Ok(handle) => {
                *lock(&inner.thread) = Some(handle);
            }
            Err(_refused) => {
                inner.stopped.store(true, Ordering::Release);
            }
        }
        Governor { inner }
    }

    /// Changes the budget live. The controller switches profile at once and
    /// the next tick runs on it; workers re-apply the profile on their next
    /// `throttle()`.
    pub fn configure(&self, budget: Budget, auto: bool) {
        let inner = &*self.inner;
        let mut state = inner.state();
        state.budget = budget;
        state.auto = auto;
        let effective = effective_preset(budget, auto, state.on_battery, state.thermal);
        let next = profile(effective, state.cores, budget.cpu_percent);
        if effective != state.effective || next != state.profile {
            state.effective = effective;
            state.profile = next;
            state.controller.set_profile(next);
            state.decision = state.controller.decision();
            let decision = state.decision;
            inner.generation.fetch_add(1, Ordering::AcqRel);
            drop(state);
            inner.publish(&decision);
        }
    }

    /// Called by a worker after each unit of work. Applies the profile to the
    /// calling thread when needed, blocks while paused, then sleeps in
    /// proportion to the duty (see the module docs).
    pub fn throttle(&self) {
        let inner = &*self.inner;
        if inner.stopped.load(Ordering::Acquire) {
            return;
        }
        let generation = inner.generation.load(Ordering::Acquire);
        let (work, needs_apply) = THROTTLE.with(|cell| {
            let mut slot = cell.borrow_mut();
            match slot.as_mut() {
                Some(state) if state.governor_id == inner.id => {
                    let needs_apply = state.applied_generation != generation;
                    state.applied_generation = generation;
                    (Some(state.last_call_ended.elapsed()), needs_apply)
                }
                _ => {
                    *slot = Some(ThrottleState {
                        governor_id: inner.id,
                        last_call_ended: Instant::now(),
                        applied_generation: generation,
                        ledger_ns: 0,
                    });
                    (None, true)
                }
            }
        });
        if needs_apply {
            let current = inner.state().profile;
            let report = apply_to_current_thread(&current);
            inner.state().mechanisms = report;
        }
        inner.wait_while_paused();
        if let Some(work) = work {
            sleep_from_ledger(throttle_sleep(work, inner.duty()));
        }
        THROTTLE.with(|cell| {
            if let Some(state) = cell.borrow_mut().as_mut() {
                state.last_call_ended = Instant::now();
            }
        });
    }

    /// How many workers may run right now.
    pub fn worker_limit(&self) -> u32 {
        self.inner.workers.load(Ordering::Acquire)
    }

    /// Blocks every worker at its next `throttle()` until [`resume`](Self::resume).
    pub fn pause(&self) {
        self.inner.set_user_pause(true);
    }

    /// Releases workers paused by [`pause`](Self::pause); a thermal pause stays.
    pub fn resume(&self) {
        self.inner.set_user_pause(false);
    }

    /// A copy of the governor's state at this instant.
    pub fn snapshot(&self) -> Snapshot {
        let inner = &*self.inner;
        let state = inner.state();
        let paused = inner.pause_state().any();
        Snapshot {
            budget: state.budget,
            effective: state.effective,
            target_share: state.decision.target_share,
            share_1s: mean(&state.recent_shares),
            workers: state.decision.workers,
            duty: state.decision.duty,
            thermal: state.thermal,
            on_battery: state.on_battery,
            interacting: state.interacting,
            machine_busy_share: state.machine_busy_share,
            paused,
            ticks: state.ticks,
            mechanisms: state.mechanisms.clone(),
        }
    }

    /// Stops the tick thread and waits for it; releases any worker blocked in
    /// `throttle()`. Idempotent.
    pub fn stop(&self) {
        let inner = &*self.inner;
        inner.stopped.store(true, Ordering::Release);
        inner.pause_changed.notify_all();
        let handle = lock(&inner.thread).take();
        if let Some(handle) = handle {
            // A tick thread that panicked (only a sampler or signals implementation
            // could) has already stopped ticking; there is nothing left to undo.
            let _ = handle.join();
        }
    }
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    fn pause_state(&self) -> MutexGuard<'_, PauseState> {
        lock(&self.pause)
    }

    fn duty(&self) -> f64 {
        f64::from_bits(self.duty_bits.load(Ordering::Acquire))
    }

    /// One tick: the auto-Eco rule, the controller, the window, the atomics.
    fn tick(&self, sample: &Sample) {
        let mut state = self.state();
        state.thermal = sample.thermal;
        state.on_battery = sample.on_battery;
        state.interacting = sample.interacting;
        if let Some(share) = sample.machine_busy_share {
            state.machine_busy_share = Some(share);
        }
        let effective =
            effective_preset(state.budget, state.auto, sample.on_battery, sample.thermal);
        if effective != state.effective {
            let next = profile(effective, state.cores, state.budget.cpu_percent);
            state.effective = effective;
            state.profile = next;
            state.controller.set_profile(next);
            self.generation.fetch_add(1, Ordering::AcqRel);
        }
        let decision = state.controller.step(sample);
        state.decision = decision;
        state.ticks += 1;
        state.recent_shares.push_back(decision.share_measured);
        while state.recent_shares.len() > SHARE_WINDOW_TICKS {
            state.recent_shares.pop_front();
        }
        drop(state);
        self.publish(&decision);
    }

    /// Copies a decision into the lock-free fields the workers read.
    fn publish(&self, decision: &Decision) {
        self.workers.store(decision.workers, Ordering::Release);
        self.duty_bits
            .store(decision.duty.to_bits(), Ordering::Release);
        let mut pause = self.pause_state();
        if pause.by_thermal != decision.paused_for_thermal {
            pause.by_thermal = decision.paused_for_thermal;
            self.paused.store(pause.any(), Ordering::Release);
            self.pause_changed.notify_all();
        }
    }

    fn set_user_pause(&self, paused: bool) {
        let mut pause = self.pause_state();
        pause.by_user = paused;
        self.paused.store(pause.any(), Ordering::Release);
        self.pause_changed.notify_all();
    }

    /// Blocks while paused; wakes on resume, on a thermal change, or on stop.
    fn wait_while_paused(&self) {
        if !self.paused.load(Ordering::Acquire) {
            return;
        }
        let mut guard = self.pause_state();
        while guard.any() && !self.stopped.load(Ordering::Acquire) {
            let (next, _) = self
                .pause_changed
                .wait_timeout(guard, PAUSE_POLL)
                .unwrap_or_else(PoisonError::into_inner);
            guard = next;
        }
    }
}

/// The tick loop. Holds only a weak handle, so the governor can be dropped
/// while it sleeps; it then ends at its next tick.
fn run_ticks(inner: &Weak<Inner>, mut sampler: Box<dyn CpuSampler>, mut signals: Box<dyn Signals>) {
    let mut last_tick = Instant::now();
    let mut last_cpu = sampler.own_cpu_seconds();
    let mut next = last_tick + TICK;
    loop {
        sleep_until(next);
        let Some(inner) = inner.upgrade() else {
            return;
        };
        if inner.stopped.load(Ordering::Acquire) {
            return;
        }
        let now = Instant::now();
        let interval_s = now.duration_since(last_tick).as_secs_f64();
        last_tick = now;
        let cpu = sampler.own_cpu_seconds();
        let own_cpu_s = cpu - last_cpu;
        last_cpu = cpu;
        let sample = Sample {
            interval_s,
            own_cpu_s,
            machine_busy_share: sampler.machine_busy_share(),
            thermal: signals.thermal(),
            on_battery: signals.on_battery(),
            interacting: signals.interacting(),
        };
        inner.tick(&sample);
        next += TICK;
        if next < now {
            next = now + TICK;
        }
    }
}

/// The preset in force for a budget: the budget's own, or in auto mode
/// Balanced unless the machine is on battery or under `Serious`-or-worse heat.
pub fn effective_preset(
    budget: Budget,
    auto: bool,
    on_battery: Option<bool>,
    thermal: Thermal,
) -> Preset {
    if !auto {
        return budget.preset;
    }
    if on_battery == Some(true) || thermal.is_serious_or_worse() {
        Preset::Eco
    } else {
        Preset::Balanced
    }
}

/// How long a worker sleeps after `work` at `duty`: `(1 − duty) / duty × work`,
/// capped at [`THROTTLE_SLEEP_CAP`]; nothing at full duty.
pub fn throttle_sleep(work: Duration, duty: f64) -> Duration {
    let duty = if duty.is_finite() {
        duty.clamp(DUTY_MIN, DUTY_MAX)
    } else {
        DUTY_MAX
    };
    if duty >= DUTY_MAX {
        return Duration::ZERO;
    }
    let seconds = work.as_secs_f64() * (1.0 - duty) / duty;
    Duration::try_from_secs_f64(seconds)
        .unwrap_or(THROTTLE_SLEEP_CAP)
        .min(THROTTLE_SLEEP_CAP)
}

/// Adds `owed` to the calling thread's ledger, sleeps what the ledger holds once it reaches
/// [`THROTTLE_MIN_SLEEP`], and counts the time actually slept. A sleep that overruns (macOS
/// stretches a Utility thread's 3 ms sleep to about 17 ms and a Background thread's to about
/// 160 ms; Windows rounds up to its 15.6 ms timer) leaves a credit that skips the following
/// sleeps, so the duty holds on average whatever the OS does to one sleep. The ledger is
/// bounded by [`THROTTLE_SLEEP_CAP`] above and [`THROTTLE_CREDIT_CAP`] below.
fn sleep_from_ledger(owed: Duration) {
    let cap = nanos(THROTTLE_SLEEP_CAP);
    let credit_cap = nanos(THROTTLE_CREDIT_CAP);
    let due = THROTTLE.with(|cell| {
        let mut slot = cell.borrow_mut();
        let Some(state) = slot.as_mut() else {
            return Duration::ZERO;
        };
        state.ledger_ns = state.ledger_ns.saturating_add(nanos(owed)).min(cap);
        if state.ledger_ns >= nanos(THROTTLE_MIN_SLEEP) {
            duration(state.ledger_ns)
        } else {
            Duration::ZERO
        }
    });
    if due.is_zero() {
        return;
    }
    let started = Instant::now();
    thread::sleep(due);
    let slept = nanos(started.elapsed());
    THROTTLE.with(|cell| {
        if let Some(state) = cell.borrow_mut().as_mut() {
            state.ledger_ns = state.ledger_ns.saturating_sub(slept).max(-credit_cap);
        }
    });
}

fn nanos(duration: Duration) -> i64 {
    i64::try_from(duration.as_nanos()).unwrap_or(i64::MAX)
}

fn duration(nanos: i64) -> Duration {
    Duration::from_nanos(u64::try_from(nanos).unwrap_or(0))
}

/// Sleeps until `deadline`, or not at all if it has passed.
pub(crate) fn sleep_until(deadline: Instant) {
    let now = Instant::now();
    if deadline > now {
        thread::sleep(deadline - now);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn mean(values: &VecDeque<f64>) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

fn not_applied_report() -> EnforceReport {
    EnforceReport {
        qos: Mechanism::unavailable(NOT_APPLIED_MECHANISM, NOT_APPLIED_REASON),
        io: Mechanism::unavailable(NOT_APPLIED_MECHANISM, NOT_APPLIED_REASON),
        priority: Mechanism::unavailable(NOT_APPLIED_MECHANISM, NOT_APPLIED_REASON),
    }
}

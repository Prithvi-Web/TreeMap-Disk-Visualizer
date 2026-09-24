//! The pure closed loop: one [`Sample`] per tick in, one [`Decision`] out.
//!
//! The loop knows nothing about threads, clocks or the OS. The governor's tick
//! thread measures the tick's real length and this process's CPU time, and the
//! controller turns them into a duty (the fraction of wall time each worker may
//! run) and a worker count. Every constant is named below with its unit.
//!
//! **Rules.**
//! * `share = own_cpu_s / (interval_s × cores)`, smoothed by an EMA with weight
//!   [`SHARE_EMA_ALPHA`] on the newest sample.
//! * The target is the profile's ceiling, × [`THERMAL_SERIOUS_SCALE`] under
//!   `Serious` thermal pressure, paused under `Critical`, × the profile's
//!   `interaction_scale` while the user is interacting. `Fair` and `Unknown`
//!   thermal states and an unknown interaction state change nothing.
//! * PI on the duty: `duty = integral + KP_PER_TICK × error`, clamped to
//!   [`DUTY_MIN`]`..=`[`DUTY_MAX`]; the integral gains `KI_PER_TICK × error` per
//!   tick and is clamped to the same range (anti-windup by clamping, so it can
//!   neither run past full duty nor freeze above the floor while pinned). Workers start at the profile's maximum and the
//!   duty starts at the feed-forward value `target × cores / workers`.
//! * After [`WORKER_CHANGE_TICKS`] consecutive ticks with `duty < WORKER_DROP_DUTY`
//!   and workers above the minimum, one worker is dropped and the duty rescaled by
//!   `old / new`; after the same number of ticks with `duty ≥ WORKER_ADD_DUTY`,
//!   the share below `target − SHARE_MARGIN` and workers below the maximum, one
//!   worker is added and the duty rescaled.
//!
//! **Sanitising.** A NaN, infinite or negative `own_cpu_s` counts as no CPU time;
//! a NaN, infinite or non-positive `interval_s` counts as [`TICK_NOMINAL_S`]; the
//! share is clamped to `0..=1`. [`Decision::share_measured`] is that sanitised
//! share, so nothing is reported that was not measured, and nothing is invented
//! to fill a gap. While paused the loop's state is frozen: the pause has nothing
//! to teach it.

use serde::{Deserialize, Serialize};

use crate::preset::PresetProfile;

/// The nominal tick length in seconds; the governor measures the real one and
/// only the sanitiser falls back to this.
pub const TICK_NOMINAL_S: f64 = 0.1;
/// Weight of the newest sample in the smoothed share (dimensionless, per tick).
pub const SHARE_EMA_ALPHA: f64 = 0.3;
/// Proportional gain: duty per unit of share error (dimensionless).
pub const KP_PER_TICK: f64 = 1.5;
/// Integral gain: duty added to the integral per unit of share error, per tick.
pub const KI_PER_TICK: f64 = 0.3;
/// The lowest duty a worker is asked to run at (fraction of wall time).
pub const DUTY_MIN: f64 = 0.05;
/// The highest duty: no throttling at all (fraction of wall time).
pub const DUTY_MAX: f64 = 1.0;
/// A duty below this (fraction of wall time) for [`WORKER_CHANGE_TICKS`] ticks
/// sheds one worker. It sits above the plan's 0.25 because Eco on two cores
/// settles exactly at duty 0.25 with two workers, which is a boundary, not a
/// decision; at 0.4 the remaining worker takes the load at no more than 0.8.
pub const WORKER_DROP_DUTY: f64 = 0.4;
/// A duty at or above this (fraction of wall time), with the share still short,
/// for [`WORKER_CHANGE_TICKS`] ticks adds one worker.
pub const WORKER_ADD_DUTY: f64 = 0.98;
/// Consecutive ticks a worker-change condition must hold (2 s at the nominal tick).
pub const WORKER_CHANGE_TICKS: u32 = 20;
/// Target multiplier under `Serious` thermal pressure (dimensionless).
pub const THERMAL_SERIOUS_SCALE: f64 = 0.5;
/// How far below the target the share must sit before a worker is added
/// (share of all cores).
pub const SHARE_MARGIN: f64 = 0.05;
/// The machine's busy share (all processes, this one included) at or above
/// which it counts as full: nearly every core was running something. A share
/// short of target then is the machine's doing, not the duty's, so the loop
/// holds its duty and adds no worker (see [`Controller::step`]).
pub const MACHINE_FULL_SHARE: f64 = 0.95;

/// The machine's thermal pressure, as the OS reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Thermal {
    /// Normal operation.
    Nominal,
    /// Warm, but nothing needs to change.
    Fair,
    /// The OS wants less work: the target halves.
    Serious,
    /// The OS wants no work: the loop pauses.
    Critical,
    /// The OS does not say; treated as nominal, never as pressure.
    Unknown,
}

impl Thermal {
    /// `Serious` or `Critical`: the states the auto budget treats as pressure.
    pub fn is_serious_or_worse(self) -> bool {
        matches!(self, Self::Serious | Self::Critical)
    }
}

/// One tick's measurement, as the governor feeds it to the loop.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample {
    /// The real length of the tick in seconds.
    pub interval_s: f64,
    /// CPU seconds this process consumed during the tick.
    pub own_cpu_s: f64,
    /// The whole machine's busy share during the tick, when the OS exposes it.
    /// The loop holds this process's share, not the machine's; the machine's
    /// only tells it when a shortfall cannot be closed ([`MACHINE_FULL_SHARE`]).
    pub machine_busy_share: Option<f64>,
    /// The thermal state at the end of the tick.
    pub thermal: Thermal,
    /// Whether the machine runs on battery, when the OS says.
    pub on_battery: Option<bool>,
    /// Whether the user is interacting, when the OS says.
    pub interacting: Option<bool>,
}

/// What the loop decided after a tick.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    /// The share of all cores the loop is holding, after thermal and interaction scaling.
    pub target_share: f64,
    /// How many workers may run.
    pub workers: u32,
    /// The fraction of wall time each worker may run, [`DUTY_MIN`]`..=`[`DUTY_MAX`].
    pub duty: f64,
    /// Whether `Critical` thermal pressure has paused all work; the duty is then moot.
    pub paused_for_thermal: bool,
    /// The sanitised share this tick measured, `0..=1`.
    pub share_measured: f64,
}

/// The closed loop. Feed it one [`Sample`] per tick with [`step`](Self::step).
#[derive(Debug, Clone)]
pub struct Controller {
    profile: PresetProfile,
    cores: u32,
    smoothed_share: Option<f64>,
    integral: f64,
    workers: u32,
    low_duty_ticks: u32,
    saturated_ticks: u32,
    last_thermal: Thermal,
    last_interacting: Option<bool>,
    /// Whether the machine's latest busy share was full. macOS publishes the
    /// counters about once a second, so a tick without a reading keeps the last.
    machine_full: bool,
    last: Decision,
}

impl Controller {
    /// A loop for `profile` on a machine with `cores` logical cores: workers at
    /// the profile's maximum, duty at the feed-forward value for the ceiling.
    pub fn new(profile: PresetProfile, cores: u32) -> Self {
        let cores = cores.max(1);
        let (_, max) = worker_range(&profile);
        let target = unit(profile.cpu_ceiling);
        let duty = feed_forward_duty(target, cores, max);
        Self {
            profile,
            cores,
            smoothed_share: None,
            integral: duty,
            workers: max,
            low_duty_ticks: 0,
            saturated_ticks: 0,
            last_thermal: Thermal::Unknown,
            last_interacting: None,
            machine_full: false,
            last: Decision {
                target_share: target,
                workers: max,
                duty,
                paused_for_thermal: false,
                share_measured: 0.0,
            },
        }
    }

    /// Switches to `profile` live. A wider worker range starts at its maximum, as
    /// [`new`](Self::new) does; a narrower one clamps the current count; the same
    /// range keeps the count the loop has learned. The duty restarts at the
    /// feed-forward value for the new target and the change counters reset; the
    /// smoothed share is kept, because the measurement did not change.
    pub fn set_profile(&mut self, profile: PresetProfile) {
        let old_max = self.profile.max_workers;
        let (min, max) = worker_range(&profile);
        self.workers = if max > old_max {
            max
        } else {
            self.workers.clamp(min, max)
        };
        self.profile = profile;
        let (target, paused) = self.scaled_target();
        let duty = feed_forward_duty(target, self.cores, self.workers);
        self.integral = duty;
        self.low_duty_ticks = 0;
        self.saturated_ticks = 0;
        self.last = Decision {
            target_share: target,
            workers: self.workers,
            duty,
            paused_for_thermal: paused,
            share_measured: self.last.share_measured,
        };
    }

    /// Runs one tick of the loop on `sample` and returns the new decision.
    ///
    /// A share short of target on a full machine ([`MACHINE_FULL_SHARE`]) holds
    /// the duty, the integral and the smoothed share where they are: the other work, not the duty,
    /// is what keeps the share down, and winding up against it only stores a
    /// burst that lands the moment that work stops (the macOS CI leg of 24 Sep
    /// 2026 held 21.7% for a 10% target that way). A share over target acts as
    /// always, full machine or not.
    pub fn step(&mut self, sample: &Sample) -> Decision {
        self.last_thermal = sample.thermal;
        self.last_interacting = sample.interacting;
        if let Some(machine) = sample.machine_busy_share {
            self.machine_full = machine.is_finite() && machine >= MACHINE_FULL_SHARE;
        }
        let share = measured_share(sample, self.cores);
        let (target, paused) = self.scaled_target();
        if paused {
            self.low_duty_ticks = 0;
            self.saturated_ticks = 0;
            self.last = Decision {
                target_share: target,
                workers: self.workers,
                duty: self.last.duty,
                paused_for_thermal: true,
                share_measured: share,
            };
            return self.last;
        }
        let smoothed = match self.smoothed_share {
            None => share,
            Some(previous) => SHARE_EMA_ALPHA * share + (1.0 - SHARE_EMA_ALPHA) * previous,
        };
        // Held when this tick's own share fell short on a machine with no idle CPU: the
        // other work left no room. It is this tick's share, not the smoothed one, that
        // decides: the machine's busy share counts this process too, and a loop coming back
        // from a pause fills the machine itself while its smoothed share still lags.
        let held_by_machine = share < target && self.machine_full;
        // A share the full machine kept down measures the other work, not the duty, so it
        // is not folded into the smoothed share either: the loop picks up where it left off
        // when the machine frees up, with no lagging shortfall for the proportional term to
        // answer with a burst.
        if !held_by_machine {
            self.smoothed_share = Some(smoothed);
        }
        let error = target - smoothed;
        let duty = if held_by_machine {
            self.last.duty
        } else {
            let duty = (self.integral + KP_PER_TICK * error).clamp(DUTY_MIN, DUTY_MAX);
            // Anti-windup by clamping: the integral lives in the duty's own range, so it can
            // neither wind up past full duty nor freeze above the floor while the proportional
            // term pins the output there (a frozen integral resurfaces as a jump the moment
            // the error shrinks or a worker change rescales it).
            self.integral = (self.integral + KI_PER_TICK * error).clamp(DUTY_MIN, DUTY_MAX);
            duty
        };
        let duty = self.rebalance_workers(duty, smoothed, target);
        self.last = Decision {
            target_share: target,
            workers: self.workers,
            duty,
            paused_for_thermal: false,
            share_measured: share,
        };
        self.last
    }

    /// The decision in force: the last one [`step`](Self::step) returned, or the
    /// starting point before the first tick.
    pub fn decision(&self) -> Decision {
        self.last
    }

    /// The target after thermal and interaction scaling, and whether the loop is paused.
    fn scaled_target(&self) -> (f64, bool) {
        let mut target = unit(self.profile.cpu_ceiling);
        let paused = matches!(self.last_thermal, Thermal::Critical);
        if matches!(self.last_thermal, Thermal::Serious) {
            target *= THERMAL_SERIOUS_SCALE;
        }
        if self.last_interacting == Some(true) {
            target *= unit(self.profile.interaction_scale);
        }
        (unit(target), paused)
    }

    /// Applies the worker-drop and worker-add rules; returns the duty, rescaled
    /// when the count changed.
    fn rebalance_workers(&mut self, duty: f64, smoothed: f64, target: f64) -> f64 {
        let (min, max) = worker_range(&self.profile);
        let wants_fewer = self.workers > min && duty < WORKER_DROP_DUTY;
        self.low_duty_ticks = if wants_fewer {
            self.low_duty_ticks + 1
        } else {
            0
        };
        let wants_more = self.workers < max
            && duty >= WORKER_ADD_DUTY
            && smoothed < target - SHARE_MARGIN
            && !self.machine_full;
        self.saturated_ticks = if wants_more {
            self.saturated_ticks + 1
        } else {
            0
        };
        let new_workers = if self.low_duty_ticks >= WORKER_CHANGE_TICKS {
            self.workers - 1
        } else if self.saturated_ticks >= WORKER_CHANGE_TICKS {
            self.workers + 1
        } else {
            return duty;
        };
        let factor = f64::from(self.workers) / f64::from(new_workers);
        self.workers = new_workers;
        self.low_duty_ticks = 0;
        self.saturated_ticks = 0;
        self.integral = (self.integral * factor).clamp(DUTY_MIN, DUTY_MAX);
        (duty * factor).clamp(DUTY_MIN, DUTY_MAX)
    }
}

/// The profile's worker range with the invariants `1 ≤ min ≤ max` restored.
fn worker_range(profile: &PresetProfile) -> (u32, u32) {
    let min = profile.min_workers.max(1);
    (min, profile.max_workers.max(min))
}

/// The duty that would hold `target` if every worker's full time were one core.
fn feed_forward_duty(target: f64, cores: u32, workers: u32) -> f64 {
    (target * f64::from(cores.max(1)) / f64::from(workers.max(1))).clamp(DUTY_MIN, DUTY_MAX)
}

/// The sanitised share of all cores this process used during the tick.
fn measured_share(sample: &Sample, cores: u32) -> f64 {
    let own = if sample.own_cpu_s.is_finite() && sample.own_cpu_s > 0.0 {
        sample.own_cpu_s
    } else {
        0.0
    };
    let interval = if sample.interval_s.is_finite() && sample.interval_s > 0.0 {
        sample.interval_s
    } else {
        TICK_NOMINAL_S
    };
    (own / (interval * f64::from(cores.max(1)))).clamp(0.0, 1.0)
}

/// `value` clamped to `0..=1`; a NaN counts as zero.
fn unit(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

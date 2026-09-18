//! The preset table: what each budget means in CPU ceiling, I/O class, QoS class,
//! worker range and interaction scale, plus the numeric override.
//!
//! | Preset   | Ceiling | I/O      | QoS           | Workers                 | Interaction scale |
//! | -------- | ------- | -------- | ------------- | ----------------------- | ----------------- |
//! | Eco      | 0.25    | Throttle | Background    | `1..=min(2, cores)`     | 0.7               |
//! | Balanced | 0.50    | Utility  | Utility       | `1..=max(1, cores / 2)` | 0.7               |
//! | Turbo    | 0.90    | Normal   | UserInitiated | `1..=cores`             | 1.0               |
//!
//! A numeric override (`cpu_percent`, 1–100) replaces the ceiling and leaves the rest of
//! the preset alone. Turbo still yields to the user and still obeys thermal pressure.

use serde::{Deserialize, Serialize};

/// Eco's share of the machine (fraction of all cores).
pub const ECO_CEILING: f64 = 0.25;
/// Balanced's share of the machine.
pub const BALANCED_CEILING: f64 = 0.50;
/// Turbo's share of the machine; the rest is left so the machine stays responsive.
pub const TURBO_CEILING: f64 = 0.90;
/// Every preset keeps at least this many workers.
pub const MIN_WORKERS: u32 = 1;
/// Eco never runs more workers than this, however many cores there are.
pub const ECO_MAX_WORKERS: u32 = 2;
/// Balanced runs at most one worker per this many cores.
pub const BALANCED_CORES_PER_WORKER: u32 = 2;
/// Target multiplier while the user is interacting, for Eco and Balanced.
pub const YIELDING_INTERACTION_SCALE: f64 = 0.7;
/// Turbo's target multiplier while the user is interacting (it does not scale).
pub const TURBO_INTERACTION_SCALE: f64 = 1.0;
/// The lowest ceiling a numeric override can set (fraction of all cores).
pub const OVERRIDE_MIN_SHARE: f64 = 0.01;
/// The highest ceiling a numeric override can set.
pub const OVERRIDE_MAX_SHARE: f64 = 1.0;
/// Percent points in a whole share.
pub const PERCENT_PER_SHARE: f64 = 100.0;

/// A user-selectable budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Preset {
    /// Stay out of the way: a quarter of the machine, background I/O and scheduling.
    Eco,
    /// Half the machine with utility-class I/O and scheduling.
    Balanced,
    /// Nearly the whole machine; still yields while the user works and under heat.
    Turbo,
}

/// The budget as configured: a preset plus an optional numeric ceiling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    /// The preset the rest of the profile comes from.
    pub preset: Preset,
    /// `1..=100` replaces the preset's ceiling; `None` keeps it.
    pub cpu_percent: Option<u8>,
}

/// Disk I/O priority class asked of the OS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IoClass {
    /// Lowest: yields to every other I/O.
    Throttle,
    /// Below normal.
    Utility,
    /// The default class.
    Normal,
}

/// Scheduling (quality of service) class asked of the OS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QosClass {
    /// Work the user is not waiting for.
    Background,
    /// Work the user may be waiting for, but not right now.
    Utility,
    /// Work the user asked for and is waiting on.
    UserInitiated,
}

/// A preset resolved for a machine: what the controller and the enforcement act on.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetProfile {
    /// The preset this profile came from.
    pub preset: Preset,
    /// The share of all cores the loop holds, `0.01..=1.0`.
    pub cpu_ceiling: f64,
    /// The disk I/O class workers run with.
    pub io: IoClass,
    /// The scheduling class workers run with.
    pub qos: QosClass,
    /// The fewest workers the controller may run.
    pub min_workers: u32,
    /// The most workers the controller may run.
    pub max_workers: u32,
    /// Target multiplier while the user is interacting (`1.0` means no change).
    pub interaction_scale: f64,
}

/// Resolves `preset` for a machine with `cores` logical cores. `cpu_percent`
/// replaces the ceiling (clamped to `0.01..=1.0`) and leaves the rest of the
/// preset as it is. A core count of zero is treated as one.
pub fn profile(preset: Preset, cores: u32, cpu_percent: Option<u8>) -> PresetProfile {
    let cores = cores.max(MIN_WORKERS);
    let (cpu_ceiling, io, qos, max_workers, interaction_scale) = match preset {
        Preset::Eco => (
            ECO_CEILING,
            IoClass::Throttle,
            QosClass::Background,
            ECO_MAX_WORKERS.min(cores),
            YIELDING_INTERACTION_SCALE,
        ),
        Preset::Balanced => (
            BALANCED_CEILING,
            IoClass::Utility,
            QosClass::Utility,
            (cores / BALANCED_CORES_PER_WORKER).max(MIN_WORKERS),
            YIELDING_INTERACTION_SCALE,
        ),
        Preset::Turbo => (
            TURBO_CEILING,
            IoClass::Normal,
            QosClass::UserInitiated,
            cores,
            TURBO_INTERACTION_SCALE,
        ),
    };
    let cpu_ceiling = cpu_percent.map_or(cpu_ceiling, override_share);
    PresetProfile {
        preset,
        cpu_ceiling,
        io,
        qos,
        min_workers: MIN_WORKERS,
        max_workers: max_workers.max(MIN_WORKERS),
        interaction_scale,
    }
}

/// The ceiling a numeric override sets: `percent / 100`, clamped to
/// [`OVERRIDE_MIN_SHARE`]`..=`[`OVERRIDE_MAX_SHARE`].
pub fn override_share(percent: u8) -> f64 {
    (f64::from(percent) / PERCENT_PER_SHARE).clamp(OVERRIDE_MIN_SHARE, OVERRIDE_MAX_SHARE)
}

impl Budget {
    /// The profile this budget resolves to on a machine with `cores` cores.
    pub fn profile(self, cores: u32) -> PresetProfile {
        profile(self.preset, cores, self.cpu_percent)
    }
}

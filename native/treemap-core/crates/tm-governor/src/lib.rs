//! `tm-governor`: the resource governor that holds TreeMap's scanning budget.
//!
//! * [`preset`] is the table of budgets (Eco, Balanced, Turbo) and the numeric override.
//! * [`controller`] is the pure closed loop: one [`Sample`] per tick in, one [`Decision`] out.
//! * [`sample`] reads this process's CPU time and the machine's busy share from the OS.
//! * [`signals`] reads thermal pressure, the power source and user interaction.
//! * [`enforce`] gives a thread the preset's QoS class, I/O policy and priority, and says
//!   which of those the OS actually took.
//! * [`governor`] ticks every 100 ms, runs the loop on what was measured, and throttles the
//!   workers; [`loadgen`] is the synthetic load and the held-band measurement.
//!
//! Nothing here prints a number it did not measure: a mechanism the platform lacks is
//! reported as unavailable with its reason, and a signal the OS does not expose is `None`.

pub mod controller;
pub mod enforce;
pub mod governor;
pub mod loadgen;
pub mod preset;
pub mod sample;
pub mod signals;

pub use controller::{Controller, Decision, Sample, Thermal};
pub use enforce::{Capabilities, EnforceReport, Mechanism, apply_to_current_thread, capabilities};
pub use governor::{Governor, Snapshot, ThrottleTotals};
pub use loadgen::{HoldReport, SyntheticLoad, hold};
pub use preset::{Budget, IoClass, Preset, PresetProfile, QosClass, profile};
pub use sample::{CpuSampler, FakeSampler, platform_sampler};
pub use signals::{FakeSignals, Signals, platform_signals};

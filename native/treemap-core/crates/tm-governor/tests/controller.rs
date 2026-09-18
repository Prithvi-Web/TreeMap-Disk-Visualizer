//! Simulation tests for the pure closed loop (`Controller`) and the preset table.
//!
//! A `SimulatedEngine` stands in for the real workers: its share is
//! `workers × duty × per_worker_share + noise`, with `per_worker_share = 1 / cores`
//! and the noise drawn from a seeded LCG in ±0.02. Every test feeds the controller
//! `Sample`s exactly the way the governor's tick thread will, so the constants tuned
//! here are the constants the machine runs with.

use tm_governor::{
    Controller, Decision, IoClass, Preset, PresetProfile, QosClass, Sample, Thermal, profile,
};

/// Nominal tick length fed to the controller (the governor measures the real one).
const TICK_S: f64 = 0.1;
/// Noise amplitude on the simulated share (±).
const NOISE: f64 = 0.02;
/// The held band: the mean of the last half must be within this of the target.
const BAND: f64 = 0.05;
/// Ticks per simulated hold (60 s at 100 ms).
const HOLD_TICKS: usize = 600;

/// A tiny seeded linear congruential generator so the noise is reproducible.
struct Lcg(u64);

impl Lcg {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    /// The next 53 random bits.
    fn next_bits(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 11
    }

    /// A value in `0.0..1.0`.
    fn unit(&mut self) -> f64 {
        self.next_bits() as f64 / (1u64 << 53) as f64
    }

    /// An index in `0..n` (0 when `n` is 0).
    fn pick(&mut self, n: usize) -> usize {
        let modulus = u64::try_from(n.max(1)).unwrap_or(u64::MAX);
        usize::try_from(self.next_bits() % modulus).unwrap_or(0)
    }

    /// A random byte.
    fn pick_u8(&mut self) -> u8 {
        u8::try_from(self.pick(256)).unwrap_or(0)
    }

    /// Noise in `-NOISE..NOISE`.
    fn noise(&mut self) -> f64 {
        (self.unit() * 2.0 - 1.0) * NOISE
    }
}

/// The plant: an engine whose CPU share follows the controller's decision.
struct SimulatedEngine {
    cores: u32,
    rng: Lcg,
    thermal: Thermal,
    on_battery: Option<bool>,
    interacting: Option<bool>,
}

impl SimulatedEngine {
    fn new(cores: u32) -> Self {
        Self {
            cores,
            rng: Lcg::new(0x5eed_0001),
            thermal: Thermal::Nominal,
            on_battery: None,
            interacting: None,
        }
    }

    /// The share this engine produces under `decision` during one tick.
    fn share(&mut self, decision: &Decision) -> f64 {
        if decision.paused_for_thermal {
            return 0.0;
        }
        let per_worker = 1.0 / f64::from(self.cores);
        let raw = f64::from(decision.workers) * decision.duty * per_worker + self.rng.noise();
        raw.clamp(0.0, 1.0)
    }

    /// One tick's worth of measurement for the controller.
    fn sample(&mut self, decision: &Decision) -> (f64, Sample) {
        let share = self.share(decision);
        let sample = Sample {
            interval_s: TICK_S,
            own_cpu_s: share * TICK_S * f64::from(self.cores),
            machine_busy_share: Some(share),
            thermal: self.thermal,
            on_battery: self.on_battery,
            interacting: self.interacting,
        };
        (share, sample)
    }
}

/// What a simulated run produced.
struct Run {
    /// The engine's share on every tick.
    shares: Vec<f64>,
    /// The decision in force after the last tick.
    last: Decision,
    /// The largest worker count the controller ever asked for.
    max_workers_seen: u32,
    /// The smallest worker count the controller ever asked for.
    min_workers_seen: u32,
}

impl Run {
    fn mean_of_last_half(&self) -> f64 {
        mean(self.shares.iter().skip(self.shares.len() / 2))
    }
}

fn mean<'a>(values: impl Iterator<Item = &'a f64>) -> f64 {
    let (sum, count) = values.fold((0.0, 0usize), |(s, n), v| (s + v, n + 1));
    if count == 0 { 0.0 } else { sum / count as f64 }
}

/// Runs `ticks` ticks: the decision in force produces a share, the controller steps on it.
fn run(controller: &mut Controller, engine: &mut SimulatedEngine, ticks: usize) -> Run {
    let mut shares = Vec::with_capacity(ticks);
    let mut decision = controller.decision();
    let mut max_workers_seen = decision.workers;
    let mut min_workers_seen = decision.workers;
    for _ in 0..ticks {
        let (share, sample) = engine.sample(&decision);
        shares.push(share);
        decision = controller.step(&sample);
        max_workers_seen = max_workers_seen.max(decision.workers);
        min_workers_seen = min_workers_seen.min(decision.workers);
    }
    Run {
        shares,
        last: decision,
        max_workers_seen,
        min_workers_seen,
    }
}

fn assert_held(held: &Run, target: f64, label: &str) {
    let mean = held.mean_of_last_half();
    assert!(
        (mean - target).abs() <= BAND,
        "{label}: mean of the last half {mean:.4} is not within ±{BAND} of {target}; final {:?}",
        held.last
    );
}

fn approx(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[test]
fn eco_holds_a_quarter_on_eight_cores() {
    let mut controller = Controller::new(profile(Preset::Eco, 8, None), 8);
    let mut engine = SimulatedEngine::new(8);
    let held = run(&mut controller, &mut engine, HOLD_TICKS);
    assert_held(&held, 0.25, "eco/8");
    assert!(
        held.max_workers_seen <= 2,
        "eco never uses more than two workers"
    );
}

#[test]
fn balanced_holds_half_on_eight_cores() {
    let mut controller = Controller::new(profile(Preset::Balanced, 8, None), 8);
    let mut engine = SimulatedEngine::new(8);
    let held = run(&mut controller, &mut engine, HOLD_TICKS);
    assert_held(&held, 0.50, "balanced/8");
    assert!(
        held.max_workers_seen <= 4,
        "balanced never uses more than half the cores"
    );
}

#[test]
fn turbo_holds_ninety_percent_on_eight_cores() {
    let mut controller = Controller::new(profile(Preset::Turbo, 8, None), 8);
    let mut engine = SimulatedEngine::new(8);
    let held = run(&mut controller, &mut engine, HOLD_TICKS);
    assert_held(&held, 0.90, "turbo/8");
    assert!(held.max_workers_seen <= 8);
}

#[test]
fn eco_holds_a_quarter_on_two_cores() {
    // 0.25 of two cores is half a core: one worker at duty 0.5. The controller must
    // shed the second worker rather than run two at a quarter each.
    let mut controller = Controller::new(profile(Preset::Eco, 2, None), 2);
    let mut engine = SimulatedEngine::new(2);
    let held = run(&mut controller, &mut engine, HOLD_TICKS);
    assert_held(&held, 0.25, "eco/2");
    assert_eq!(
        held.last.workers, 1,
        "workers must reach one; final {:?}",
        held.last
    );
    assert!(
        (held.last.duty - 0.5).abs() < 0.1,
        "one worker should sit near duty 0.5; final {:?}",
        held.last
    );
}

#[test]
fn serious_thermal_halves_the_target() {
    let mut controller = Controller::new(profile(Preset::Balanced, 8, None), 8);
    let mut engine = SimulatedEngine::new(8);
    let warm = run(&mut controller, &mut engine, 200);
    assert_held(&warm, 0.50, "balanced before thermal pressure");

    engine.thermal = Thermal::Serious;
    let hot = run(&mut controller, &mut engine, 400);
    assert!(
        approx(hot.last.target_share, 0.25),
        "serious thermal halves the target: {:?}",
        hot.last
    );
    assert!(!hot.last.paused_for_thermal);
    assert_held(&hot, 0.25, "balanced under serious thermal pressure");

    engine.thermal = Thermal::Fair;
    let fair = run(&mut controller, &mut engine, 400);
    assert!(
        approx(fair.last.target_share, 0.50),
        "fair is not a throttle: {:?}",
        fair.last
    );
    assert_held(&fair, 0.50, "balanced after the pressure lifts");
}

#[test]
fn critical_thermal_pauses() {
    let mut controller = Controller::new(profile(Preset::Turbo, 8, None), 8);
    let mut engine = SimulatedEngine::new(8);
    let _ = run(&mut controller, &mut engine, 50);

    engine.thermal = Thermal::Critical;
    let paused = run(&mut controller, &mut engine, 50);
    assert!(
        paused.last.paused_for_thermal,
        "critical pauses: {:?}",
        paused.last
    );
    assert!(
        paused.shares.iter().skip(1).all(|s| approx(*s, 0.0)),
        "a paused engine does no work"
    );
    let stable = controller.decision();
    assert!(
        stable.paused_for_thermal,
        "decision() reports the pause too"
    );

    engine.thermal = Thermal::Nominal;
    let resumed = run(&mut controller, &mut engine, 300);
    assert!(
        !resumed.last.paused_for_thermal,
        "nominal resumes: {:?}",
        resumed.last
    );
    assert_held(&resumed, 0.90, "turbo after a thermal pause");
}

#[test]
fn interaction_scales_every_preset_but_turbo() {
    for (preset, expected) in [
        (Preset::Eco, 0.25 * 0.7),
        (Preset::Balanced, 0.50 * 0.7),
        (Preset::Turbo, 0.90),
    ] {
        let mut controller = Controller::new(profile(preset, 8, None), 8);
        let mut engine = SimulatedEngine::new(8);
        engine.interacting = Some(true);
        let held = run(&mut controller, &mut engine, HOLD_TICKS);
        assert!(
            approx(held.last.target_share, expected),
            "{preset:?} while interacting should target {expected}: {:?}",
            held.last
        );
        assert_held(&held, expected, "interacting");

        engine.interacting = Some(false);
        let idle = run(&mut controller, &mut engine, 10);
        let ceiling = profile(preset, 8, None).cpu_ceiling;
        assert!(
            approx(idle.last.target_share, ceiling),
            "{preset:?} idle: {:?}",
            idle.last
        );

        engine.interacting = None;
        let unknown = run(&mut controller, &mut engine, 10);
        assert!(
            approx(unknown.last.target_share, ceiling),
            "an unknown interaction state is not a throttle: {:?}",
            unknown.last
        );
    }
}

#[test]
fn a_numeric_override_replaces_the_ceiling() {
    let forty = profile(Preset::Balanced, 8, Some(40));
    let stock = profile(Preset::Balanced, 8, None);
    assert!(approx(forty.cpu_ceiling, 0.40));
    assert_eq!(forty.io, stock.io);
    assert_eq!(forty.qos, stock.qos);
    assert_eq!(forty.min_workers, stock.min_workers);
    assert_eq!(forty.max_workers, stock.max_workers);
    assert!(approx(forty.interaction_scale, stock.interaction_scale));
    assert_eq!(forty.preset, Preset::Balanced);

    assert!(
        approx(profile(Preset::Eco, 8, Some(0)).cpu_ceiling, 0.01),
        "0 clamps to 1%"
    );
    assert!(approx(profile(Preset::Eco, 8, Some(100)).cpu_ceiling, 1.0));
    assert!(
        approx(profile(Preset::Eco, 8, Some(255)).cpu_ceiling, 1.0),
        "over 100 clamps"
    );

    let mut controller = Controller::new(forty, 8);
    let mut engine = SimulatedEngine::new(8);
    let held = run(&mut controller, &mut engine, HOLD_TICKS);
    assert!(approx(held.last.target_share, 0.40), "{:?}", held.last);
    assert_held(&held, 0.40, "balanced at 40%");
}

#[test]
fn workers_drop_when_duty_stays_low_and_return_when_saturated() {
    // 12% of eight cores is 0.96 of a core: four workers would idle at duty 0.24, so
    // the controller sheds them down to two at duty 0.48.
    let mut controller = Controller::new(profile(Preset::Balanced, 8, Some(12)), 8);
    let mut engine = SimulatedEngine::new(8);
    let low = run(&mut controller, &mut engine, HOLD_TICKS);
    assert_held(&low, 0.12, "balanced at 12%");
    assert_eq!(low.last.workers, 2, "workers shed to two: {:?}", low.last);
    assert_eq!(low.min_workers_seen, 2, "never below what the target needs");

    // 45% needs 3.6 cores: two workers saturate at 0.25, so the controller must add
    // workers back until four run near duty 0.9.
    controller.set_profile(profile(Preset::Balanced, 8, Some(45)));
    let high = run(&mut controller, &mut engine, HOLD_TICKS);
    assert_eq!(
        high.last.workers, 4,
        "workers return when saturated: {:?}",
        high.last
    );
    assert_held(&high, 0.45, "balanced at 45%");
}

#[test]
fn the_preset_table_is_the_prompts_table() {
    for cores in [1u32, 2, 4, 8, 16] {
        let eco = profile(Preset::Eco, cores, None);
        assert_eq!(eco.preset, Preset::Eco);
        assert!(
            approx(eco.cpu_ceiling, 0.25),
            "eco ceiling on {cores} cores"
        );
        assert_eq!(eco.io, IoClass::Throttle);
        assert_eq!(eco.qos, QosClass::Background);
        assert_eq!(eco.min_workers, 1);
        assert_eq!(
            eco.max_workers,
            2.min(cores),
            "eco workers on {cores} cores"
        );
        assert!(approx(eco.interaction_scale, 0.7));

        let balanced = profile(Preset::Balanced, cores, None);
        assert_eq!(balanced.preset, Preset::Balanced);
        assert!(approx(balanced.cpu_ceiling, 0.50));
        assert_eq!(balanced.io, IoClass::Utility);
        assert_eq!(balanced.qos, QosClass::Utility);
        assert_eq!(balanced.min_workers, 1);
        assert_eq!(
            balanced.max_workers,
            (cores / 2).max(1),
            "balanced workers on {cores} cores"
        );
        assert!(approx(balanced.interaction_scale, 0.7));

        let turbo = profile(Preset::Turbo, cores, None);
        assert_eq!(turbo.preset, Preset::Turbo);
        assert!(approx(turbo.cpu_ceiling, 0.90));
        assert_eq!(turbo.io, IoClass::Normal);
        assert_eq!(turbo.qos, QosClass::UserInitiated);
        assert_eq!(turbo.min_workers, 1);
        assert_eq!(turbo.max_workers, cores, "turbo workers on {cores} cores");
        assert!(approx(turbo.interaction_scale, 1.0));
    }
    let zero = profile(Preset::Turbo, 0, None);
    assert_eq!(zero.max_workers, 1, "a machine reports at least one core");
}

#[test]
fn every_decision_is_clamped() {
    let mut rng = Lcg::new(0xbad_5eed);
    let thermals = [
        Thermal::Nominal,
        Thermal::Fair,
        Thermal::Serious,
        Thermal::Critical,
        Thermal::Unknown,
    ];
    let hostile_cpu = [f64::NAN, -1.0, f64::INFINITY, f64::NEG_INFINITY, 1e9, 0.0];
    let hostile_interval = [f64::NAN, -0.1, 0.0, f64::INFINITY, 1e-12, 1e6];
    for preset in [Preset::Eco, Preset::Balanced, Preset::Turbo] {
        for cores in [1u32, 2, 8, 64] {
            let percent = if rng.unit() < 0.5 {
                None
            } else {
                Some(rng.pick_u8())
            };
            let prof = profile(preset, cores, percent);
            let mut controller = Controller::new(prof, cores);
            for i in 0..2_000usize {
                let own_cpu_s = if i % 7 == 0 {
                    hostile_cpu
                        .get(i % hostile_cpu.len())
                        .copied()
                        .unwrap_or(0.0)
                } else {
                    rng.unit() * TICK_S * f64::from(cores) * 1.5
                };
                let interval_s = if i % 11 == 0 {
                    hostile_interval
                        .get(i % hostile_interval.len())
                        .copied()
                        .unwrap_or(TICK_S)
                } else {
                    TICK_S
                };
                let thermal = thermals
                    .get(rng.pick(thermals.len()))
                    .copied()
                    .unwrap_or(Thermal::Unknown);
                let interacting = match rng.pick(3) {
                    0 => None,
                    1 => Some(false),
                    _ => Some(true),
                };
                let sample = Sample {
                    interval_s,
                    own_cpu_s,
                    machine_busy_share: if rng.unit() < 0.5 {
                        None
                    } else {
                        Some(rng.unit())
                    },
                    thermal,
                    on_battery: None,
                    interacting,
                };
                let d = controller.step(&sample);
                check_clamped(&d, &prof, preset, cores, i);
                let again = controller.decision();
                assert_eq!(again, d, "decision() repeats the last step");
            }
        }
    }
}

fn check_clamped(d: &Decision, prof: &PresetProfile, preset: Preset, cores: u32, tick: usize) {
    let ctx = format!("{preset:?} on {cores} cores at tick {tick}: {d:?}");
    assert!(
        d.duty.is_finite() && (0.05..=1.0).contains(&d.duty),
        "duty clamped {ctx}"
    );
    assert!(
        (prof.min_workers..=prof.max_workers).contains(&d.workers),
        "workers in range {ctx}"
    );
    assert!(
        d.target_share.is_finite() && (0.0..=1.0).contains(&d.target_share),
        "target in range {ctx}"
    );
    assert!(
        d.share_measured.is_finite() && (0.0..=1.0).contains(&d.share_measured),
        "share sanitised {ctx}"
    );
}

#[test]
fn a_missing_machine_share_changes_nothing() {
    // On macOS 27 `host_statistics64` publishes new CPU counters about once a second, so
    // most ticks carry `machine_busy_share: None`. The loop holds this process's own share
    // and must treat `None` as "no new counters yet": the decision stream is identical
    // whether every tick carries a reading or one in ten does.
    let prof = profile(Preset::Balanced, 8, None);
    let mut sparse = Controller::new(prof, 8);
    let mut dense = Controller::new(prof, 8);
    let mut engine = SimulatedEngine::new(8);
    let mut decision = dense.decision();
    for tick in 0..HOLD_TICKS {
        let (_, sample) = engine.sample(&decision);
        let sparse_sample = Sample {
            machine_busy_share: if tick % 10 == 0 {
                sample.machine_busy_share
            } else {
                None
            },
            ..sample
        };
        let sparse_decision = sparse.step(&sparse_sample);
        decision = dense.step(&sample);
        assert_eq!(
            sparse_decision, decision,
            "tick {tick}: a missing reading changed the loop"
        );
    }
    assert!(
        !decision.paused_for_thermal && decision.workers == 4,
        "{decision:?}"
    );
}

#[test]
fn a_pinned_duty_does_not_hide_a_stale_integral() {
    // Twice the target pins the duty at the floor. The integral must follow it down to the
    // floor while pinned; if it froze above it, the moment the error vanished the duty would
    // jump to the stale value the proportional term had been masking.
    let mut controller = Controller::new(profile(Preset::Eco, 8, None), 8);
    let scripted = |share: f64| Sample {
        interval_s: TICK_S,
        own_cpu_s: share * TICK_S * 8.0,
        machine_busy_share: None,
        thermal: Thermal::Nominal,
        on_battery: None,
        interacting: None,
    };
    let mut pinned = controller.decision();
    for _ in 0..40 {
        pinned = controller.step(&scripted(0.50));
    }
    assert!(
        approx(pinned.duty, 0.05),
        "twice the target pins the duty at the floor: {pinned:?}"
    );

    for tick in 0..10 {
        let on_target = controller.step(&scripted(0.25));
        assert!(
            on_target.duty <= 0.12,
            "tick {tick}: with the error gone the duty must rise from the floor, not jump to a \
             stale integral: {on_target:?}"
        );
    }
}

#[test]
fn recovery_after_a_long_overshoot_is_prompt() {
    // A long spell over target pins the duty at the floor. When the work then vanishes the
    // duty must climb back within a few ticks: an integral allowed to wind up below the floor
    // would keep the loop pinned for as many ticks as it spent over target.
    let mut controller = Controller::new(profile(Preset::Balanced, 8, None), 8);
    let scripted = |share: f64| Sample {
        interval_s: TICK_S,
        own_cpu_s: share * TICK_S * 8.0,
        machine_busy_share: None,
        thermal: Thermal::Nominal,
        on_battery: None,
        interacting: None,
    };
    for _ in 0..200 {
        controller.step(&scripted(1.0));
    }
    assert!(
        approx(controller.decision().duty, 0.05),
        "{:?}",
        controller.decision()
    );

    let mut recovered_at = None;
    for tick in 1..=10 {
        let decision = controller.step(&scripted(0.0));
        if decision.duty >= 0.4 {
            recovered_at = Some(tick);
            break;
        }
    }
    assert!(
        recovered_at.is_some(),
        "the duty must reach 0.4 within ten ticks of the work vanishing: {:?}",
        controller.decision()
    );
}

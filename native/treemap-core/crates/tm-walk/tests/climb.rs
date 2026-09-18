//! The hill-climber as a pure state machine. A scripted clock and a scripted
//! entries counter drive it: no threads, no real time. Each test describes a
//! world in which the rate depends on the worker count, feeds the climber one
//! observation per interval, and checks what it decided.

use std::time::Duration;

use tm_walk::climb::{Climber, HOLD_INTERVALS, INTERVAL, NOISE_FLOOR, START_WORKERS};

/// Intervals the simulations run for.
const TICKS: u32 = 40;
/// Entries per interval one worker produces in the linear world.
const PER_WORKER: u64 = 1_000;
/// A third worker that adds 4 %: real, but under the 5 % noise floor.
const UNDER_FLOOR_PERCENT: u64 = 104;
/// A third worker that adds 6 %: over the floor, so it is kept.
const OVER_FLOOR_PERCENT: u64 = 106;
/// The floor the two percentages above straddle.
const FLOOR: f64 = 0.05;

/// A scripted world: a clock and an entries counter that keep running across
/// calls, so a sequence of `run`s is one continuous walk.
#[derive(Default)]
struct World {
    now: Duration,
    entries: u64,
}

impl World {
    /// Runs `ticks` intervals. During each interval the world produces
    /// `rate_for(workers)` entries with the count the climber chose at the start
    /// of it; the observation lands at the end. Returns the count after each tick.
    fn run(
        &mut self,
        climber: &mut Climber,
        ticks: u32,
        rate_for: impl Fn(u32) -> u64,
    ) -> Vec<u32> {
        let mut seen = Vec::with_capacity(ticks as usize);
        for _ in 0..ticks {
            self.entries += rate_for(climber.workers());
            self.now += INTERVAL;
            seen.push(climber.observe(self.now, self.entries));
        }
        seen
    }
}

/// One continuous run from a fresh world.
fn simulate(climber: &mut Climber, ticks: u32, rate_for: impl Fn(u32) -> u64) -> Vec<u32> {
    World::default().run(climber, ticks, rate_for)
}

/// A world where each worker adds the same throughput, up to the ceiling.
fn linear(workers: u32) -> u64 {
    u64::from(workers) * PER_WORKER
}

#[test]
fn starts_at_two_workers_bounded_by_the_ceiling() {
    assert_eq!(Climber::new(8).workers(), START_WORKERS);
    assert_eq!(Climber::new(2).workers(), START_WORKERS);
    assert_eq!(Climber::new(1).workers(), 1);
    assert_eq!(
        Climber::new(0).workers(),
        1,
        "a ceiling of zero still runs one worker"
    );
    assert_eq!(Climber::new(8).steps(), 0);
}

#[test]
fn does_not_re_evaluate_before_the_interval() {
    let mut climber = Climber::new(8);
    let before = climber.workers();
    assert_eq!(climber.observe(Duration::from_millis(100), 5_000), before);
    assert_eq!(
        climber.observe(INTERVAL.saturating_sub(Duration::from_millis(1)), 50_000),
        before
    );
    assert_eq!(
        climber.steps(),
        0,
        "no observation inside the interval may move the count"
    );
}

#[test]
fn climbs_while_throughput_improves_and_never_exceeds_the_ceiling() {
    let ceiling = 4;
    let mut climber = Climber::new(ceiling);
    let seen = simulate(&mut climber, TICKS, linear);
    let peak = seen.iter().copied().max().unwrap_or(0);
    assert_eq!(
        peak, ceiling,
        "a linear world is worth climbing to the ceiling: {seen:?}"
    );
    assert!(
        seen.iter().all(|w| *w <= ceiling),
        "never above the ceiling: {seen:?}"
    );
    assert!(
        seen.iter().all(|w| *w >= 1),
        "never below one worker: {seen:?}"
    );
    assert!(
        climber.steps() >= 2,
        "two kept steps take 2 to 4: {}",
        climber.steps()
    );
}

#[test]
fn the_noise_floor_is_five_percent() {
    assert_eq!(NOISE_FLOOR.to_bits(), FLOOR.to_bits());
}

#[test]
fn a_step_below_the_noise_floor_is_reverted_and_probing_stops_for_a_while() {
    let flat = |workers: u32| -> u64 {
        if workers >= 3 {
            PER_WORKER * UNDER_FLOOR_PERCENT / 100
        } else {
            PER_WORKER
        }
    };
    let mut climber = Climber::new(8);
    let mut world = World::default();
    // Tick 1 warms up at 2 and probes 3; tick 2 measures 3 and reverts to 2.
    let first = world.run(&mut climber, 2, flat);
    assert_eq!(first, vec![3, 2], "probe, then revert: {first:?}");
    assert_eq!(
        climber.steps(),
        2,
        "the probe and its revert are both steps"
    );
    // Then it holds: the observation HOLD_INTERVALS intervals after the revert
    // is the first that may probe again, so every one before it keeps 2.
    let held = world.run(&mut climber, HOLD_INTERVALS - 1, flat);
    assert!(
        held.iter().all(|w| *w == 2),
        "no probing during the hold: {held:?}"
    );
    assert_eq!(climber.steps(), 2);
    // And it re-probes at the boundary.
    let later = world.run(&mut climber, 1, flat);
    assert!(
        later.iter().all(|w| *w != 2),
        "a probe follows the hold: {later:?}"
    );
    assert_eq!(climber.steps(), 3);
}

#[test]
fn a_step_above_the_noise_floor_is_kept() {
    let helps = |workers: u32| -> u64 {
        if workers >= 3 {
            PER_WORKER * OVER_FLOOR_PERCENT / 100
        } else {
            PER_WORKER
        }
    };
    let mut climber = Climber::new(8);
    let seen = simulate(&mut climber, 2, helps);
    assert_eq!(
        seen.first().copied(),
        Some(3),
        "warm-up, then the first probe"
    );
    assert!(
        seen.get(1).is_some_and(|w| *w >= 3),
        "a 6 % gain keeps the third worker (and probes on): {seen:?}"
    );
}

#[test]
fn never_exceeds_a_lowered_ceiling() {
    let mut climber = Climber::new(6);
    let mut world = World::default();
    let climbed = world.run(&mut climber, 12, linear);
    assert!(
        climbed.iter().any(|w| *w >= 4),
        "the linear world climbs first: {climbed:?}"
    );
    climber.set_ceiling(2);
    assert!(climber.workers() <= 2, "a lowered ceiling clamps at once");
    let after = world.run(&mut climber, TICKS, linear);
    assert!(
        after.iter().all(|w| *w <= 2),
        "never above the new ceiling: {after:?}"
    );
    assert!(
        after.contains(&2),
        "and it still uses what it may: {after:?}"
    );
    climber.set_ceiling(0);
    assert_eq!(
        climber.workers(),
        1,
        "a zero ceiling still means one worker"
    );
}

#[test]
fn a_ceiling_of_one_never_climbs() {
    let mut climber = Climber::new(1);
    let seen = simulate(&mut climber, TICKS, linear);
    assert!(seen.iter().all(|w| *w == 1), "{seen:?}");
    assert_eq!(climber.steps(), 0, "nowhere to step");
}

#[test]
fn counts_every_change_as_a_step() {
    let mut climber = Climber::new(3);
    let seen = simulate(&mut climber, TICKS, linear);
    let changes = seen
        .windows(2)
        .filter(|pair| pair.first() != pair.get(1))
        .count();
    // The first tick's change (from the initial 2) is not visible in `windows`.
    let first_change = usize::from(seen.first().is_some_and(|w| *w != START_WORKERS));
    assert_eq!(
        climber.steps() as usize,
        changes + first_change,
        "steps count every change the climber made: {seen:?}"
    );
}

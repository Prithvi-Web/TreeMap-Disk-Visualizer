//! The hill-climber that picks the worker count: a pure state machine. The
//! driver feeds it the clock and the entries counter; it answers with the
//! count to run. Nothing here touches a thread or reads the time.
//!
//! It starts at the count [`start_for`] names (bounded by the ceiling),
//! re-evaluates once per [`INTERVAL`] against entries per second, and keeps a
//! step only when throughput improved by more than [`NOISE_FLOOR`]. A step that
//! did not pay is reverted and probing stops for [`HOLD_INTERVALS`] intervals;
//! then it probes again, in the other direction first. It never exceeds the
//! ceiling the governor sets, and it counts every change it makes.

use std::time::Duration;

use tm_governor::Preset;

/// Workers at the start of a walk, unless [`start_for`] names another count
/// (bounded by the ceiling either way).
pub const START_WORKERS: u32 = 2;
/// How often the climber re-evaluates.
pub const INTERVAL: Duration = Duration::from_millis(250);
/// A step is kept only when the rate improved by more than this share.
pub const NOISE_FLOOR: f64 = 0.05;
/// Intervals without probing after a step that did not pay.
pub const HOLD_INTERVALS: u32 = 8;
/// The climber never runs fewer workers than this.
pub const MIN_WORKERS: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Phase {
    /// The first interval: measure the rate at the starting count, then probe.
    Warmup,
    /// A step was taken; the next observation decides whether it stays.
    Trial {
        previous_rate: f64,
        previous_workers: u32,
    },
    /// A step was reverted (or there was nowhere to step); no probing until `until`.
    Holding { until: Duration },
}

/// The state machine. See the module docs.
#[derive(Debug, Clone)]
pub struct Climber {
    workers: u32,
    ceiling: u32,
    /// `+1` probes up, `-1` probes down; flips at a bound and after a revert.
    direction: i8,
    phase: Phase,
    steps: u32,
    last_at: Duration,
    last_entries: u64,
}

/// The count a walk under `preset` starts with, given the machine's
/// performance-core count when the platform names one.
///
/// Turbo starts at the performance cores: the walk is kernel time, and on an
/// Apple M3 (4 performance + 4 efficiency cores, enum200k, warm) fixed counts
/// of 1–8 workers peaked at exactly four and fell beyond it, while a walk that
/// starts at [`START_WORKERS`] and climbs one worker per [`INTERVAL`] ends
/// before it gets there (it peaked at 3). Eco and Balanced, and Turbo where
/// the platform names no performance cores, start at [`START_WORKERS`] as
/// before. The governor's limit caps every start.
pub fn start_for(preset: Preset, performance_cores: Option<u32>) -> u32 {
    match (preset, performance_cores) {
        (Preset::Turbo, Some(cores)) if cores >= MIN_WORKERS => cores,
        _ => START_WORKERS,
    }
}

impl Climber {
    /// A climber that may run up to `ceiling` workers (at least one), starting
    /// at [`START_WORKERS`].
    pub fn new(ceiling: u32) -> Self {
        Self::starting_at(ceiling, START_WORKERS)
    }

    /// A climber that may run up to `ceiling` workers (at least one), starting
    /// at `start` bounded by the ceiling (and by one from below). Taking the
    /// start is not a step. A start above [`START_WORKERS`] probes down first:
    /// it is the top of the range the platform is known to reward, and on the
    /// M3 the count above it cost 41 % more CPU per entry (7.6 → 10.7 s per
    /// million) for about 2 % more walk throughput than the count below it.
    pub fn starting_at(ceiling: u32, start: u32) -> Self {
        let ceiling = ceiling.max(MIN_WORKERS);
        Self {
            workers: start.clamp(MIN_WORKERS, ceiling),
            ceiling,
            direction: if start > START_WORKERS { -1 } else { 1 },
            phase: Phase::Warmup,
            steps: 0,
            last_at: Duration::ZERO,
            last_entries: 0,
        }
    }

    /// The count to run right now.
    pub fn workers(&self) -> u32 {
        self.workers
    }

    /// How many times the climber changed the count.
    pub fn steps(&self) -> u32 {
        self.steps
    }

    /// The most workers it may run.
    pub fn ceiling(&self) -> u32 {
        self.ceiling
    }

    /// Sets the ceiling (the governor's limit); a count above it is clamped at
    /// once. The clamp is the governor's decision, not a climb step.
    pub fn set_ceiling(&mut self, ceiling: u32) {
        self.ceiling = ceiling.max(MIN_WORKERS);
        if self.workers > self.ceiling {
            self.workers = self.ceiling;
        }
        if let Phase::Trial {
            previous_workers, ..
        } = &mut self.phase
        {
            *previous_workers = (*previous_workers).min(self.ceiling);
        }
    }

    /// One reading of the clock (`now`, since the walk started) and the entries
    /// counter. Re-evaluates only when an [`INTERVAL`] has passed since the last
    /// evaluation; returns the count to run.
    pub fn observe(&mut self, now: Duration, entries: u64) -> u32 {
        let elapsed = now.saturating_sub(self.last_at);
        if elapsed < INTERVAL {
            return self.workers;
        }
        let produced = entries.saturating_sub(self.last_entries);
        let rate = produced as f64 / elapsed.as_secs_f64();
        self.last_at = now;
        self.last_entries = entries;
        match self.phase {
            Phase::Warmup => self.probe(now, rate),
            Phase::Trial {
                previous_rate,
                previous_workers,
            } => {
                if rate > previous_rate * (1.0 + NOISE_FLOOR) {
                    self.probe(now, rate);
                } else {
                    self.change_to(previous_workers);
                    self.direction = -self.direction;
                    self.phase = Phase::Holding {
                        until: now + INTERVAL * HOLD_INTERVALS,
                    };
                }
            }
            Phase::Holding { until } => {
                if now >= until {
                    self.probe(now, rate);
                }
            }
        }
        self.workers
    }

    /// Steps once in the current direction (flipping at a bound). With nowhere
    /// to step, holds instead.
    fn probe(&mut self, now: Duration, rate: f64) {
        match self.next_count() {
            Some(next) => {
                let previous_workers = self.workers;
                self.change_to(next);
                self.phase = Phase::Trial {
                    previous_rate: rate,
                    previous_workers,
                };
            }
            None => {
                self.phase = Phase::Holding {
                    until: now + INTERVAL * HOLD_INTERVALS,
                };
            }
        }
    }

    fn next_count(&mut self) -> Option<u32> {
        let can_go_up = self.workers < self.ceiling;
        let can_go_down = self.workers > MIN_WORKERS;
        if self.direction > 0 && !can_go_up {
            self.direction = -1;
        } else if self.direction < 0 && !can_go_down {
            self.direction = 1;
        }
        if self.direction > 0 && can_go_up {
            self.workers.checked_add(1)
        } else if self.direction < 0 && can_go_down {
            self.workers.checked_sub(1)
        } else {
            None
        }
    }

    /// Records a change of count. `count` comes from [`next_count`](Self::next_count)
    /// (bounded by the ceiling) or from a `Trial`'s previous count (clamped by
    /// [`set_ceiling`](Self::set_ceiling)); there is deliberately no second
    /// clamp here, so a wrong bound in either place shows in the tests.
    fn change_to(&mut self, count: u32) {
        if count != self.workers {
            self.workers = count;
            self.steps = self.steps.saturating_add(1);
        }
    }
}

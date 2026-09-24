//! The synthetic load and the gate measurement.
//!
//! [`SyntheticLoad`] is a set of spinning workers that obey a [`Governor`] the
//! way a scan engine would: worker `i` spins for [`SPIN_UNIT`] and calls
//! `throttle()` while `i < worker_limit()`, and idles otherwise. [`hold`] runs
//! such a load for a while and samples this process's share of the machine
//! every [`HOLD_SAMPLE_PERIOD`] with a sampler of its own, independent of the
//! governor's, so the report measures the governor rather than quoting it.

use std::hint::black_box;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::governor::{Governor, sleep_until};
use crate::preset::profile;
use crate::sample::CpuSampler;

/// The unit of work a synthetic worker does between two `throttle()` calls.
pub const SPIN_UNIT: Duration = Duration::from_millis(10);
/// How often a worker above the limit re-checks whether it may run.
pub const IDLE_POLL: Duration = Duration::from_millis(10);
/// How often `hold()` samples the share.
pub const HOLD_SAMPLE_PERIOD: Duration = Duration::from_millis(100);
/// Half-width of the band `within_band` checks (share of all cores).
pub const HOLD_BAND: f64 = 0.05;
/// The percentile of the absolute error the report carries, in percent.
pub const HOLD_ERROR_PERCENTILE: usize = 95;
/// The name synthetic workers carry in a debugger.
const WORKER_THREAD_NAME: &str = "tm-governor-load";

/// Spinning workers that obey a governor. Dropping the handle stops them and
/// waits for them, exactly as [`stop`](Self::stop) does, so an unwind between
/// start and stop leaves nothing spinning.
#[derive(Debug)]
pub struct SyntheticLoad {
    stop: Arc<AtomicBool>,
    /// Units done, one counter per worker index.
    units: Arc<[AtomicU64]>,
    workers: Vec<JoinHandle<()>>,
}

impl SyntheticLoad {
    /// Starts `threads` workers on `governor`. A worker the OS refuses to
    /// spawn is left out; [`threads`](Self::threads) says how many run.
    pub fn start(governor: &Governor, threads: u32) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let units: Arc<[AtomicU64]> = (0..threads).map(|_| AtomicU64::new(0)).collect();
        let workers = (0..threads)
            .filter_map(|index| {
                let governor = governor.clone();
                let stop = Arc::clone(&stop);
                let units = Arc::clone(&units);
                thread::Builder::new()
                    .name(format!("{WORKER_THREAD_NAME}-{index}"))
                    .spawn(move || {
                        if let Some(mine) = usize::try_from(index).ok().and_then(|i| units.get(i)) {
                            work(&governor, index, &stop, mine);
                        }
                    })
                    .ok()
            })
            .collect();
        Self {
            stop,
            units,
            workers,
        }
    }

    /// How many workers are running.
    pub fn threads(&self) -> usize {
        self.workers.len()
    }

    /// How many [`SPIN_UNIT`]s of work all workers have completed so far.
    pub fn units_done(&self) -> u64 {
        self.units
            .iter()
            .map(|units| units.load(Ordering::Relaxed))
            .fold(0, u64::saturating_add)
    }

    /// The units each worker has completed so far, by worker index (a worker the OS
    /// refused to spawn stays at zero): a test can then count which workers ran
    /// rather than infer it from a total over time.
    pub fn units_by_worker(&self) -> Vec<u64> {
        self.units
            .iter()
            .map(|units| units.load(Ordering::Relaxed))
            .collect()
    }

    /// Stops the workers and waits for them. A worker parked in a paused
    /// governor's `throttle()` returns within one pause poll, because it
    /// throttles with its own stop flag as the cancel condition.
    pub fn stop(mut self) {
        self.end();
    }

    fn end(&mut self) {
        self.stop.store(true, Ordering::Release);
        for worker in self.workers.drain(..) {
            // A worker that panicked has already stopped spinning; nothing to undo.
            let _ = worker.join();
        }
    }
}

impl Drop for SyntheticLoad {
    fn drop(&mut self) {
        self.end();
    }
}

/// One worker: spin, throttle, repeat, while inside the governor's limit.
fn work(governor: &Governor, index: u32, stop: &AtomicBool, units: &AtomicU64) {
    let stopped = || stop.load(Ordering::Acquire);
    while !stopped() {
        if index < governor.worker_limit() {
            spin_for(SPIN_UNIT);
            units.fetch_add(1, Ordering::Relaxed);
            governor.throttle_unless(&stopped);
        } else {
            thread::sleep(IDLE_POLL);
        }
    }
}

/// Burns CPU on the calling thread for `wall` without sleeping.
pub fn spin_for(wall: Duration) {
    let started = Instant::now();
    let mut x: u64 = 1;
    while started.elapsed() < wall {
        x = black_box(x)
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
    }
    black_box(x);
}

/// What a [`hold`] measured.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldReport {
    /// The share the governor was holding when the hold began.
    pub target: f64,
    /// The measured share, one sample per [`HOLD_SAMPLE_PERIOD`].
    pub samples: Vec<f64>,
    /// Mean of every sample.
    pub mean: f64,
    /// Mean of the second half of the samples, once the loop has settled.
    pub mean_last_half: f64,
    /// The [`HOLD_ERROR_PERCENTILE`]th percentile of `|sample − target|`.
    pub p95_abs_error: f64,
    /// Whether `|mean_last_half − target| ≤` [`HOLD_BAND`].
    pub within_band: bool,
    /// The governor's worker count when the hold ended.
    pub workers_final: u32,
    /// The governor's duty when the hold ended.
    pub duty_final: f64,
    /// The most of the machine the governor's own decisions allowed over the second
    /// half: the mean, over its samples, of the workers in force times the duty,
    /// over the cores. No worker runs more than its duty, so the measured share can
    /// only pass this by the ledger's bounded credit. A single final snapshot could
    /// not stand in for it: a loop that cut its duty on the last tick made a CI run
    /// look as though the throttle had let the share run past the duty (24 Sep 2026).
    pub allowed_last_half: f64,
    /// The share of the whole machine that sat idle over the second half, from the
    /// busy shares the OS published then (see [`machine_idle_last_half`]); `None`
    /// when it published none or exposes none. A hold under its target on a
    /// machine with no idle CPU measured the machine, not the governor.
    pub machine_idle_last_half: Option<f64>,
}

/// Runs a synthetic load on `governor` for `seconds` and measures the share
/// it held, sampling with `sampler` every [`HOLD_SAMPLE_PERIOD`]. As many
/// workers are started as the effective profile allows, so the governor may
/// shed and re-add them; each obeys `worker_limit()` live.
pub fn hold(governor: &Governor, seconds: f64, sampler: &mut dyn CpuSampler) -> HoldReport {
    let opening = governor.snapshot();
    let target = opening.target_share;
    let cores = sampler.cores().max(1);
    let threads = profile(opening.effective, cores, opening.budget.cpu_percent)
        .max_workers
        .max(governor.worker_limit());
    let load = SyntheticLoad::start(governor, threads);

    let count = sample_count(seconds);
    let mut samples = Vec::with_capacity(count);
    let mut machine_busy = Vec::with_capacity(count);
    let mut allowed = Vec::with_capacity(count);
    let mut last_cpu = sampler.own_cpu_seconds();
    let mut last_at = Instant::now();
    let mut next = last_at + HOLD_SAMPLE_PERIOD;
    for _ in 0..count {
        sleep_until(next);
        next += HOLD_SAMPLE_PERIOD;
        let now = Instant::now();
        let cpu = sampler.own_cpu_seconds();
        let share = share_of(cpu - last_cpu, now.duration_since(last_at), cores);
        last_cpu = cpu;
        last_at = now;
        samples.push(share);
        machine_busy.push(sampler.machine_busy_share());
        let decision = governor.snapshot();
        allowed.push(allowed_share(
            decision.workers,
            threads,
            decision.duty,
            cores,
        ));
    }
    load.stop();
    let closing = governor.snapshot();
    HoldReport {
        machine_idle_last_half: machine_idle_last_half(&machine_busy),
        ..summarise(target, samples, &allowed, closing.workers, closing.duty)
    }
}

/// The share of all cores the governor's decision allows the load: the workers in
/// force (its limit, at most the threads started) times the duty, over the cores.
fn allowed_share(limit: u32, threads: u32, duty: f64, cores: u32) -> f64 {
    let duty = if duty.is_finite() {
        duty.clamp(0.0, 1.0)
    } else {
        1.0
    };
    f64::from(limit.min(threads)) * duty / f64::from(cores.max(1))
}

/// Samples in `seconds` of holding; a NaN or negative duration means none.
fn sample_count(seconds: f64) -> usize {
    Duration::try_from_secs_f64(seconds)
        .map(|total| total.as_millis() / HOLD_SAMPLE_PERIOD.as_millis())
        .map_or(0, |count| usize::try_from(count).unwrap_or(usize::MAX))
}

/// The share of all cores `cpu_s` of CPU time is over `wall`.
fn share_of(cpu_s: f64, wall: Duration, cores: u32) -> f64 {
    let wall_s = wall.as_secs_f64();
    if wall_s <= 0.0 || !cpu_s.is_finite() {
        return 0.0;
    }
    (cpu_s.max(0.0) / (wall_s * f64::from(cores))).clamp(0.0, 1.0)
}

fn mean<'a>(values: impl Iterator<Item = &'a f64>) -> f64 {
    let (sum, count) = values.fold((0.0, 0usize), |(sum, count), v| (sum + v, count + 1));
    if count == 0 { 0.0 } else { sum / count as f64 }
}

/// The nearest-rank percentile of the absolute errors.
fn percentile_abs_error(samples: &[f64], target: f64) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let mut errors: Vec<f64> = samples.iter().map(|s| (s - target).abs()).collect();
    errors.sort_by(f64::total_cmp);
    let rank = (errors.len() * HOLD_ERROR_PERCENTILE).div_ceil(100);
    errors.get(rank.saturating_sub(1)).copied().unwrap_or(0.0)
}

fn summarise(
    target: f64,
    samples: Vec<f64>,
    allowed: &[f64],
    workers_final: u32,
    duty_final: f64,
) -> HoldReport {
    let mean_all = mean(samples.iter());
    let mean_last_half = mean(samples.iter().skip(samples.len() / 2));
    let allowed_last_half = mean(allowed.iter().skip(allowed.len() / 2));
    let p95_abs_error = percentile_abs_error(&samples, target);
    HoldReport {
        target,
        samples,
        mean: mean_all,
        mean_last_half,
        p95_abs_error,
        within_band: (mean_last_half - target).abs() <= HOLD_BAND,
        workers_final,
        duty_final,
        allowed_last_half,
        machine_idle_last_half: None,
    }
}

/// The idle share of the whole machine over the second half of a hold: one
/// minus the mean of the busy shares published at those samples. A sample the
/// OS published nothing for (macOS publishes about once a second) and a reading
/// that is not a number count for nothing; `None` when no reading is left.
pub fn machine_idle_last_half(busy: &[Option<f64>]) -> Option<f64> {
    let published: Vec<f64> = busy
        .iter()
        .skip(busy.len() / 2)
        .filter_map(|reading| reading.filter(|share| share.is_finite()))
        .collect();
    if published.is_empty() {
        None
    } else {
        Some((1.0 - mean(published.iter())).clamp(0.0, 1.0))
    }
}

#[cfg(test)]
mod tests {
    use super::{allowed_share, summarise};

    #[test]
    fn the_allowed_share_is_the_second_half_s_mean_not_the_last_value() {
        // The second half here averages 0.3; its last value is 0.2. The gate compares the
        // measured half with this mean, so a report that carried the last value would
        // call a throttle that held its duty a throttle that did not.
        let allowed = [0.9, 0.9, 0.9, 0.9, 0.4, 0.2, 0.4, 0.2];
        let report = summarise(0.25, vec![0.25; 8], &allowed, 1, 0.1);
        assert!((report.allowed_last_half - 0.3).abs() < 1e-12, "{report:?}");
        assert!((summarise(0.25, Vec::new(), &[], 1, 0.1).allowed_last_half).abs() < 1e-12);
    }

    #[test]
    fn the_allowed_share_counts_the_workers_in_force_at_their_duty() {
        // Four workers allowed but three started: three run. The duty is clamped into
        // 0..=1, and a duty that is not a number allows everything rather than nothing.
        assert!((allowed_share(4, 3, 0.5, 6) - 0.25).abs() < 1e-12);
        assert!((allowed_share(2, 8, 0.5, 4) - 0.25).abs() < 1e-12);
        assert!((allowed_share(2, 2, 1.5, 4) - 0.5).abs() < 1e-12);
        assert!((allowed_share(2, 2, f64::NAN, 4) - 0.5).abs() < 1e-12);
        assert!(
            (allowed_share(1, 1, 0.5, 0) - 0.5).abs() < 1e-12,
            "no cores counts as one"
        );
    }
}

//! The synthetic load and the gate measurement.
//!
//! [`SyntheticLoad`] is a set of spinning workers that obey a [`Governor`] the
//! way a scan engine would: worker `i` spins for [`SPIN_UNIT`] and calls
//! `throttle()` while `i < worker_limit()`, and idles otherwise. Each worker also
//! reads its own thread's CPU clock as it goes, so the CPU the duties govern can be
//! told apart from every other thread in the process. [`hold`] runs such a load for
//! a while and samples this process's share of the machine every
//! [`HOLD_SAMPLE_PERIOD`] with a sampler of its own, independent of the governor's,
//! so the report measures the governor rather than quoting it.

use std::hint::black_box;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::governor::{Governor, sleep_until};
use crate::preset::profile;
use crate::sample::{CpuSampler, thread_cpu_seconds};

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
    /// What each worker has done and used, one entry per worker index.
    counters: Arc<[WorkerCounters]>,
    workers: Vec<JoinHandle<()>>,
}

/// What one worker publishes as it runs.
#[derive(Debug, Default)]
struct WorkerCounters {
    /// Units of work done.
    units: AtomicU64,
    /// The worker thread's own CPU seconds, as an `f64`'s bits, from its last reading of
    /// its thread clock: zero before it reads it, a NaN where the platform has none.
    cpu_bits: AtomicU64,
}

impl SyntheticLoad {
    /// Starts `threads` workers on `governor`. A worker the OS refuses to
    /// spawn is left out; [`threads`](Self::threads) says how many run.
    pub fn start(governor: &Governor, threads: u32) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let counters: Arc<[WorkerCounters]> =
            (0..threads).map(|_| WorkerCounters::default()).collect();
        let workers = (0..threads)
            .filter_map(|index| {
                let governor = governor.clone();
                let stop = Arc::clone(&stop);
                let counters = Arc::clone(&counters);
                thread::Builder::new()
                    .name(format!("{WORKER_THREAD_NAME}-{index}"))
                    .spawn(move || {
                        let mine = usize::try_from(index).ok().and_then(|i| counters.get(i));
                        if let Some(mine) = mine {
                            work(&governor, index, &stop, mine);
                        }
                    })
                    .ok()
            })
            .collect();
        Self {
            stop,
            counters,
            workers,
        }
    }

    /// How many workers are running.
    pub fn threads(&self) -> usize {
        self.workers.len()
    }

    /// How many [`SPIN_UNIT`]s of work all workers have completed so far.
    pub fn units_done(&self) -> u64 {
        self.counters
            .iter()
            .map(|worker| worker.units.load(Ordering::Relaxed))
            .fold(0, u64::saturating_add)
    }

    /// The units each worker has completed so far, by worker index (a worker the OS
    /// refused to spawn stays at zero): a test can then count which workers ran
    /// rather than infer it from a total over time.
    pub fn units_by_worker(&self) -> Vec<u64> {
        self.counters
            .iter()
            .map(|worker| worker.units.load(Ordering::Relaxed))
            .collect()
    }

    /// The CPU time all workers have used so far, in seconds, as each last read its own
    /// thread clock ([`thread_cpu_seconds`]) — after every unit of work and every idle
    /// poll, so a reading trails a worker's true CPU by at most the unit it is part way
    /// through. Only the workers' CPU: the thread that asks, the governor's tick and
    /// anything else in the process are not in it. `None` where the platform has no
    /// per-thread CPU clock.
    pub fn cpu_seconds(&self) -> Option<f64> {
        let total: f64 = self
            .counters
            .iter()
            .map(|worker| f64::from_bits(worker.cpu_bits.load(Ordering::Relaxed)))
            .sum();
        total.is_finite().then_some(total)
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

/// One worker: spin, throttle, repeat, while inside the governor's limit, reading its
/// own CPU clock after every unit of work and every idle poll.
fn work(governor: &Governor, index: u32, stop: &AtomicBool, mine: &WorkerCounters) {
    let read_clock = || {
        let seconds = thread_cpu_seconds().unwrap_or(f64::NAN);
        mine.cpu_bits.store(seconds.to_bits(), Ordering::Relaxed);
    };
    read_clock();
    let stopped = || stop.load(Ordering::Acquire);
    while !stopped() {
        if index < governor.worker_limit() {
            spin_for(SPIN_UNIT);
            mine.units.fetch_add(1, Ordering::Relaxed);
            read_clock();
            governor.throttle_unless(&stopped);
        } else {
            thread::sleep(IDLE_POLL);
            read_clock();
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
    /// How long each sample's interval lasted, in seconds. Nominally
    /// [`HOLD_SAMPLE_PERIOD`]; on a machine busy enough to wake the sampling thread late, a
    /// late sample's interval runs long and the next ones run short (down to microseconds)
    /// while the schedule catches up, so the samples are shares of unequal spans. Rust-only,
    /// like [`workers_last_half`](Self::workers_last_half): the report Node receives keeps
    /// its pinned keys.
    #[serde(skip_serializing)]
    pub intervals: Vec<f64>,
    /// Mean of every sample, each weighted by its interval: the process's share over the hold.
    pub mean: f64,
    /// Mean of the second half of the samples, once the loop has settled, each weighted by its
    /// interval: the process's share over the second half's wall time.
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
    /// half: the workers in force times the duty, over the cores, averaged over the
    /// half's wall time (each sample's decision weighted by how long its interval
    /// lasted). A single final snapshot could not stand in for it: a loop that cut its
    /// duty on the last tick made a CI run look as though the throttle had let the share
    /// run past the duty (24 Sep 2026).
    pub allowed_last_half: f64,
    /// The share of all cores the load's own workers used over the second half: the CPU
    /// time their own thread clocks counted, over the half's wall time. It is exactly the
    /// CPU the duties govern, so no worker can take more of it than
    /// [`allowed_last_half`](Self::allowed_last_half) grants, bar the ledger's bounded
    /// credit. The process share cannot stand in for it: it also counts the sampling
    /// thread and the governor's tick, and its per-sample mean weighs a sample the
    /// schedule caught up with in microseconds as much as a full one (the macOS CI leg
    /// of 26 Sep 2026 read 0.229 against 0.176 allowed that way). `None` where the
    /// platform has no per-thread CPU clock. Rust-only, like
    /// [`intervals`](Self::intervals).
    #[serde(skip_serializing)]
    pub workers_last_half: Option<f64>,
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
    let mut series = Series::with_capacity(count);
    let mut machine_busy = Vec::with_capacity(count);
    let mut last_cpu = sampler.own_cpu_seconds();
    let mut last_at = Instant::now();
    series.workers_cpu.push(load.cpu_seconds());
    let mut next = last_at + HOLD_SAMPLE_PERIOD;
    for _ in 0..count {
        sleep_until(next);
        next += HOLD_SAMPLE_PERIOD;
        let now = Instant::now();
        let cpu = sampler.own_cpu_seconds();
        let workers_cpu = load.cpu_seconds();
        let interval = now.duration_since(last_at);
        series
            .samples
            .push(share_of(cpu - last_cpu, interval, cores));
        series.intervals.push(interval.as_secs_f64());
        series.workers_cpu.push(workers_cpu);
        last_cpu = cpu;
        last_at = now;
        machine_busy.push(sampler.machine_busy_share());
        let decision = governor.snapshot();
        series.allowed.push(allowed_share(
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
        ..summarise(target, series, cores, closing.workers, closing.duty)
    }
}

/// What a hold recorded, sample by sample, before it is summarised.
#[derive(Debug, Default)]
struct Series {
    /// The process's share of all cores over each interval.
    samples: Vec<f64>,
    /// How long each interval lasted, in seconds.
    intervals: Vec<f64>,
    /// The share the governor's decision allowed when each interval ended.
    allowed: Vec<f64>,
    /// The workers' own CPU seconds before the first interval and when each ended: one
    /// more entry than there are samples.
    workers_cpu: Vec<Option<f64>>,
}

impl Series {
    fn with_capacity(count: usize) -> Self {
        Self {
            samples: Vec::with_capacity(count),
            intervals: Vec::with_capacity(count),
            allowed: Vec::with_capacity(count),
            workers_cpu: Vec::with_capacity(count.saturating_add(1)),
        }
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
    series: Series,
    cores: u32,
    workers_final: u32,
    duty_final: f64,
) -> HoldReport {
    let Series {
        samples,
        intervals,
        allowed,
        workers_cpu,
    } = series;
    let half = samples.len() / 2;
    // Each sample is a share of its own interval, and a late wakeup is followed by samples
    // the schedule caught up with in microseconds, in which the sampling thread itself runs
    // throughout: weighted by their intervals, the samples give the process's CPU over the
    // wall time, which a plain mean of them does not.
    let mean_all = time_weighted_mean(&samples, &intervals);
    let half_intervals = from_index(&intervals, half);
    let mean_last_half = time_weighted_mean(from_index(&samples, half), half_intervals);
    let allowed_last_half = time_weighted_mean(from_index(&allowed, half), half_intervals);
    let workers_last_half = workers_share(&workers_cpu, half, half_intervals.iter().sum(), cores);
    let p95_abs_error = percentile_abs_error(&samples, target);
    HoldReport {
        target,
        samples,
        intervals,
        mean: mean_all,
        mean_last_half,
        p95_abs_error,
        within_band: (mean_last_half - target).abs() <= HOLD_BAND,
        workers_final,
        duty_final,
        allowed_last_half,
        workers_last_half,
        machine_idle_last_half: None,
    }
}

/// The values from `index` on; none when there are not that many.
fn from_index(values: &[f64], index: usize) -> &[f64] {
    values.get(index..).unwrap_or_default()
}

/// The mean of `values`, each weighted by how long its interval lasted; the plain mean
/// when the intervals add up to no time.
fn time_weighted_mean(values: &[f64], intervals: &[f64]) -> f64 {
    let (weighted, time) = values
        .iter()
        .zip(intervals)
        .fold((0.0, 0.0), |(weighted, time), (value, interval)| {
            (weighted + value * interval, time + interval)
        });
    if time > 0.0 {
        weighted / time
    } else {
        mean(values.iter())
    }
}

/// The share of all cores the workers used between their reading at index `from` and
/// their last one, `wall` seconds apart; `None` when either reading is missing or no
/// time passed.
fn workers_share(readings: &[Option<f64>], from: usize, wall: f64, cores: u32) -> Option<f64> {
    let start = readings.get(from).copied().flatten()?;
    let end = readings.last().copied().flatten()?;
    (wall > 0.0).then(|| (end - start) / (wall * f64::from(cores.max(1))))
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
    use super::{Series, allowed_share, summarise};

    fn series(
        samples: &[f64],
        intervals: &[f64],
        allowed: &[f64],
        workers_cpu: &[Option<f64>],
    ) -> Series {
        Series {
            samples: samples.to_vec(),
            intervals: intervals.to_vec(),
            allowed: allowed.to_vec(),
            workers_cpu: workers_cpu.to_vec(),
        }
    }

    /// Cumulative CPU readings for workers using `cores` of CPU steadily: one before the
    /// first interval and one as each ends.
    fn steady_readings(cores: f64, intervals: &[f64]) -> Vec<Option<f64>> {
        std::iter::once(0.0)
            .chain(intervals.iter().scan(0.0, |used, interval| {
                *used += cores * interval;
                Some(*used)
            }))
            .map(Some)
            .collect()
    }

    #[test]
    fn the_allowed_share_is_the_second_half_s_time_weighted_mean_not_the_last_value() {
        // The second half here averages 0.3 over equal intervals; its last value is 0.2. The
        // gate compares the workers' CPU over the half with this, so a report that carried
        // the last value would call a throttle that held its duty a throttle that did not.
        let allowed = [0.9, 0.9, 0.9, 0.9, 0.4, 0.2, 0.4, 0.2];
        let even = summarise(
            0.25,
            series(&[0.25; 8], &[0.1; 8], &allowed, &[None; 9]),
            4,
            1,
            0.1,
        );
        assert!((even.allowed_last_half - 0.3).abs() < 1e-12, "{even:?}");
        // Over unequal intervals each decision counts for as long as it was in force: the
        // 0.4 of a 300 ms interval outweighs the 0.4 of a 0.1 ms one.
        let intervals = [0.1, 0.1, 0.1, 0.1, 0.3, 0.1, 0.0001, 0.1];
        let uneven = summarise(
            0.25,
            series(&[0.25; 8], &intervals, &allowed, &[None; 9]),
            4,
            1,
            0.1,
        );
        let expected = (0.4 * 0.3 + 0.2 * 0.1 + 0.4 * 0.0001 + 0.2 * 0.1) / 0.5001;
        assert!(
            (uneven.allowed_last_half - expected).abs() < 1e-12,
            "{} instead of {expected}",
            uneven.allowed_last_half
        );
        let empty = summarise(0.25, series(&[], &[], &[], &[None]), 4, 1, 0.1);
        assert!(empty.allowed_last_half.abs() < 1e-12, "{empty:?}");
    }

    #[test]
    fn the_workers_share_is_their_own_cpu_over_the_half_s_wall_time_however_the_samples_fell() {
        // The macOS CI leg of 26 Sep 2026 in miniature: three cores, one worker at duty 0.57,
        // so 0.57 of a core, a share of 0.19, exactly what the governor allowed. Its
        // sampling thread woke 140 ms late, and the schedule caught up with a sample 0.3 ms
        // long, in which that thread itself ran throughout and the OS charged CPU the worker
        // had used before: the sample reads 1.0.
        const CORES: u32 = 3;
        const WORKER_CORES: f64 = 0.57;
        let intervals = [0.1, 0.1, 0.1, 0.1, 0.1, 0.24, 0.0003, 0.0597, 0.1, 0.1];
        let samples = [0.19, 0.19, 0.19, 0.19, 0.19, 0.18, 1.0, 0.19, 0.19, 0.19];
        let allowed = [allowed_share(1, 1, WORKER_CORES, CORES); 10];
        let readings = steady_readings(WORKER_CORES, &intervals);
        let report = summarise(
            0.19,
            series(&samples, &intervals, &allowed, &readings),
            CORES,
            1,
            WORKER_CORES,
        );
        assert!(
            report
                .workers_last_half
                .is_some_and(|workers| (workers - 0.19).abs() < 1e-9),
            "the workers used 0.19 of the machine over the half, as allowed: {report:?}"
        );
        assert!((report.allowed_last_half - 0.19).abs() < 1e-9, "{report:?}");
        // The plain mean of the half's samples would weigh the 0.3 ms sample as much as a
        // 100 ms one and read 0.35, outside the band of a share held at 0.19: the report's
        // means weigh each sample by its interval, which is the process's CPU over the
        // half's wall time.
        let half_cpu = 0.18 * 0.24 + 1.0 * 0.0003 + 0.19 * 0.0597 + 0.19 * 0.1 + 0.19 * 0.1;
        assert!(
            (report.mean_last_half - half_cpu / 0.5).abs() < 1e-9,
            "the last half's mean is its time-weighted mean, {}: {report:?}",
            half_cpu / 0.5
        );
        assert_eq!(report.intervals, intervals.to_vec(), "{report:?}");
    }

    #[test]
    fn the_workers_share_is_unknown_without_both_readings_or_any_time() {
        let intervals = [0.1; 4];
        let allowed = [0.2; 4];
        let mut readings = steady_readings(0.4, &intervals);
        let known = summarise(
            0.2,
            series(&[0.2; 4], &intervals, &allowed, &readings),
            2,
            1,
            0.4,
        );
        assert!(
            known
                .workers_last_half
                .is_some_and(|workers| (workers - 0.2).abs() < 1e-9),
            "{known:?}"
        );
        // The half starts at the reading that ended the first half and ends at the last one:
        // without either, nothing was measured.
        if let Some(start) = readings.get_mut(2) {
            *start = None;
        }
        let no_start = summarise(
            0.2,
            series(&[0.2; 4], &intervals, &allowed, &readings),
            2,
            1,
            0.4,
        );
        assert_eq!(no_start.workers_last_half, None, "{no_start:?}");
        let mut no_end = steady_readings(0.4, &intervals);
        if let Some(end) = no_end.last_mut() {
            *end = None;
        }
        let no_end = summarise(
            0.2,
            series(&[0.2; 4], &intervals, &allowed, &no_end),
            2,
            1,
            0.4,
        );
        assert_eq!(no_end.workers_last_half, None, "{no_end:?}");
        let no_time = summarise(
            0.2,
            series(&[0.2; 4], &[0.0; 4], &allowed, &[Some(0.0); 5]),
            2,
            1,
            0.4,
        );
        assert_eq!(no_time.workers_last_half, None, "{no_time:?}");
        let nothing = summarise(0.2, series(&[], &[], &[], &[Some(0.0)]), 2, 1, 0.4);
        assert_eq!(nothing.workers_last_half, None, "{nothing:?}");
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

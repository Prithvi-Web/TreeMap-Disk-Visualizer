//! The held-band gate: the governor, with the real sampler and the real OS
//! mechanisms, holds a share of this machine. The default test holds 19% for
//! ten seconds: one worker at duty 0.38 does not saturate a 2-vCPU runner, and no
//! whole number of unthrottled workers lands within the band on 2, 4 or 8 cores,
//! so a dead throttle cannot pass it (10% could: one unthrottled worker of eight
//! is 12.5%). The ignored tests are
//! the Phase 2 gate, one minute each at Eco, Balanced and Turbo:
//!
//! `cargo test --release -p tm-governor --test hold -- --ignored --test-threads=1 --nocapture`
//!
//! Every run prints the series it measured; nothing in the report is assumed.

use std::thread;
use std::time::{Duration, Instant};

use tm_governor::governor::{THROTTLE_CREDIT_CAP, THROTTLE_MIN_SLEEP, TICK};
use tm_governor::loadgen::{HOLD_SAMPLE_PERIOD, SPIN_UNIT};
use tm_governor::{
    Budget, FakeSignals, Governor, HoldReport, Preset, hold, platform_sampler, profile,
};

/// The band the mean of the last half must sit in, either side of the target.
const BAND: f64 = 0.05;
/// Samples per second `hold()` takes.
const SAMPLES_PER_SECOND: usize = 10;
/// Seconds the default (CI) test holds.
const SHORT_HOLD_S: u32 = 10;
/// The default test's target in percent (see the module docs for why not 10).
const SHORT_HOLD_PERCENT: u8 = 19;
/// Seconds each gate run holds.
const GATE_HOLD_S: u32 = 60;
/// Samples printed per row of the full series.
const SERIES_ROW: usize = 20;
/// Holds the default test may run. A hold under the band on a machine that had no idle
/// CPU over its last half measured the machine, not the governor, and is measured again
/// (the Windows CI leg of 24 Sep 2026 held 11% of a 19% target with both of its workers
/// at full duty); one that ends that way every time fails, saying so.
const HOLD_ATTEMPTS: u32 = 3;
/// How long the default test waits, before holding again, for the machine to have room:
/// on that CI leg the busy spell outlasted one hold and failed the next test binary too.
const ROOM_DEADLINE: Duration = Duration::from_secs(60);
/// How often it asks how busy the machine is while it waits.
const ROOM_POLL: Duration = Duration::from_millis(250);
/// How far off the sampling period an interval must be for the report to list it: a fifth.
const IRREGULAR_INTERVAL_S: f64 = 0.02;

/// The credit a sleep that overran before the second half can carry into it: the ledger's cap.
const CREDIT_ALLOWANCE: Duration = Duration::from_millis(250);
/// What the ledger owes at the end of the half but has not slept, being below one wakeup.
const OWED_REMAINDER_ALLOWANCE: Duration = Duration::from_millis(1);
/// A duty read at a sample up to one tick after the loop changed it: one tick at full duty.
const DUTY_AGE_ALLOWANCE: Duration = Duration::from_millis(100);
/// The unit of work a worker's own clock reading trails its CPU by.
const CLOCK_LAG_ALLOWANCE: Duration = Duration::from_millis(10);
/// What the OS may charge a thread's clock late at the half's first reading: Windows charges
/// thread time in whole 15.6 ms clock ticks (`GetThreadTimes`); macOS and Linux keep the
/// thread clock to the nanosecond.
#[cfg(windows)]
const CHARGE_ALLOWANCE: Duration = Duration::from_millis(16);
#[cfg(not(windows))]
const CHARGE_ALLOWANCE: Duration = Duration::ZERO;

/// What one worker may run past the duties in force over the second half while the throttle
/// does exactly its job, in CPU time: the five parts above. Nothing else enters the duty law,
/// because it reads the workers' own clocks over the half's wall time: no other thread's CPU
/// and no sampling interval is in it. The parts are this law's own numbers, not the crate's
/// constants: [`assert_the_allowance_covers_the_throttle`] holds the crate to them, so a
/// larger cap or a longer tick is a change to this law too, made on purpose, never a silent
/// widening of it.
fn per_worker_allowance() -> Duration {
    CREDIT_ALLOWANCE
        + OWED_REMAINDER_ALLOWANCE
        + DUTY_AGE_ALLOWANCE
        + CLOCK_LAG_ALLOWANCE
        + CHARGE_ALLOWANCE
}

/// Every started worker's allowance, as a share of all cores over the second half's wall time.
fn duty_law_slack(report: &HoldReport, cores: u32, threads: u32) -> f64 {
    let half_wall_s: f64 = report
        .intervals
        .iter()
        .skip(report.intervals.len() / 2)
        .sum();
    f64::from(threads) * per_worker_allowance().as_secs_f64()
        / (half_wall_s * f64::from(cores.max(1)))
}

/// The allowance is only an allowance if the throttle keeps within it.
fn assert_the_allowance_covers_the_throttle(label: &str) {
    let parts = [
        (
            "the ledger's credit cap",
            THROTTLE_CREDIT_CAP,
            CREDIT_ALLOWANCE,
        ),
        (
            "the smallest sleep",
            THROTTLE_MIN_SLEEP,
            OWED_REMAINDER_ALLOWANCE,
        ),
        ("the tick", TICK, DUTY_AGE_ALLOWANCE),
        ("the unit of work", SPIN_UNIT, CLOCK_LAG_ALLOWANCE),
    ];
    for (part, crate_value, allowed) in parts {
        assert!(
            crate_value <= allowed,
            "[{label}] the duty law allows each worker {allowed:?} for {part}, but the crate's is \
             {crate_value:?}: widen the allowance here, deliberately, before the crate"
        );
    }
}

/// A hold's report, the machine it measured and the workers its load started.
struct Gate {
    report: HoldReport,
    cores: u32,
    threads: u32,
}

fn run_gate(label: &str, preset: Preset, cpu_percent: Option<u8>, seconds: u32) -> Gate {
    let governor = Governor::start(
        Budget {
            preset,
            cpu_percent,
        },
        false,
        platform_sampler(),
        // A quiet desktop, not this machine's live signals. The hold measures the
        // loop against the REAL sampler; what the signals do to the target (the
        // interaction back-off, thermal halving, the battery default) is tested
        // with scripted signals in controller.rs and governor.rs, and the real
        // signal readers are tested for honesty in platform.rs. With the live
        // signals, a person touching the keyboard during the hold made this gate
        // fail although the governor did exactly what it should: measured on 23
        // September 2026, 2 workers at duty 0.531 on 8 cores held 0.133 — the
        // 0.19 target times the 0.7 interaction scale — against a report whose
        // target was read before the user started typing.
        Box::new(FakeSignals::default()),
    );
    let mut sampler = platform_sampler();
    let report = hold(&governor, f64::from(seconds), sampler.as_mut());
    governor.stop();
    let cores = sampler.cores();
    // As many workers as hold() starts: the profile's most (auto is off, so the preset is
    // the one asked for).
    let threads = profile(preset, cores, cpu_percent).max_workers;
    print_report(label, &report, cores, threads);
    Gate {
        report,
        cores,
        threads,
    }
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

fn print_report(label: &str, report: &HoldReport, cores: u32, threads: u32) {
    println!(
        "[{label}] cores {cores} target {:.2} mean {:.4} mean_last_half {:.4} p95_abs_error {:.4} \
         workers_final {} duty_final {:.3} allowed_last_half {:.4} workers_last_half {} \
         duty_law_slack {:.4} within_band {} samples {} machine_idle_last_half {}",
        report.target,
        report.mean,
        report.mean_last_half,
        report.p95_abs_error,
        report.workers_final,
        report.duty_final,
        report.allowed_last_half,
        workers_text(report),
        duty_law_slack(report, cores, threads),
        report.within_band,
        report.samples.len(),
        idle_text(report)
    );
    // A sample is a share of its own interval, and the intervals are equal only on a machine
    // with room: a late wakeup lengthens one and the schedule then catches up with short ones,
    // down to microseconds, in which the sampling thread itself runs throughout.
    let period_s = HOLD_SAMPLE_PERIOD.as_secs_f64();
    let irregular: Vec<String> = report
        .intervals
        .iter()
        .enumerate()
        .filter(|(_, interval)| (*interval - period_s).abs() > IRREGULAR_INTERVAL_S)
        .map(|(sample, interval)| format!("#{sample} {:.1}", interval * 1e3))
        .collect();
    println!(
        "[{label}] intervals off the {:.0} ms period (ms): {}",
        period_s * 1e3,
        if irregular.is_empty() {
            "none".to_owned()
        } else {
            irregular.join(" ")
        }
    );
    let per_second: Vec<String> = report
        .samples
        .chunks(SAMPLES_PER_SECOND)
        .map(|second| format!("{:.2}", mean(second)))
        .collect();
    println!("[{label}] per-second means: {}", per_second.join(" "));
    for (row, chunk) in report.samples.chunks(SERIES_ROW).enumerate() {
        let cells: Vec<String> = chunk.iter().map(|s| format!("{s:.2}")).collect();
        let starts_at_s = (row * SERIES_ROW) as f64 / SAMPLES_PER_SECOND as f64;
        println!("[{label}] t={starts_at_s:>5.1}s {}", cells.join(" "));
    }
}

fn idle_text(report: &HoldReport) -> String {
    report
        .machine_idle_last_half
        .map_or_else(|| "unknown".to_owned(), |idle| format!("{idle:.4}"))
}

fn workers_text(report: &HoldReport) -> String {
    report.workers_last_half.map_or_else(
        || "unmeasured (no per-thread CPU clock answered)".to_owned(),
        |workers| format!("{workers:.4}"),
    )
}

/// Whether a hold under the band had nothing to hold with: over its last half the whole
/// machine sat idle for no more than the band, so there was no CPU the governor left untaken.
fn machine_had_nothing_to_give(report: &HoldReport) -> bool {
    report.mean_last_half < report.target - BAND
        && report
            .machine_idle_last_half
            .is_some_and(|idle| idle <= BAND)
}

/// Waits until the whole machine sits idle for more than `needed` of its time, so a hold
/// could reach its target without taking anything from anyone, or until the deadline;
/// says which.
fn wait_for_room(label: &str, needed: f64) {
    let mut sampler = platform_sampler();
    let started = Instant::now();
    let mut last_idle = None;
    while started.elapsed() < ROOM_DEADLINE {
        thread::sleep(ROOM_POLL);
        if let Some(busy) = sampler.machine_busy_share() {
            let idle = 1.0 - busy;
            last_idle = Some(idle);
            if idle > needed {
                println!(
                    "[{label}] the machine was idle for {idle:.3} of its time after {:.1} s of waiting",
                    started.elapsed().as_secs_f64()
                );
                return;
            }
        }
    }
    println!(
        "[{label}] the machine was never idle for more than {needed:.2} in {ROOM_DEADLINE:?} \
         (last reading {last_idle:?}); holding anyway"
    );
}

fn assert_gate(label: &str, gate: &Gate, seconds: u32) {
    let Gate {
        report,
        cores,
        threads,
    } = gate;
    let (cores, threads) = (*cores, *threads);
    let expected_samples = usize::try_from(seconds).unwrap_or(0) * SAMPLES_PER_SECOND;
    let n = report.samples.len();
    assert!(
        n.abs_diff(expected_samples) <= expected_samples / 20,
        "[{label}] {n} samples for {seconds}s at {SAMPLES_PER_SECOND}/s"
    );
    assert!(
        report
            .samples
            .iter()
            .all(|s| s.is_finite() && (0.0..=1.0).contains(s)),
        "[{label}] every sample is a share"
    );
    // No worker can run more than its duty allows, so the workers' own CPU over the second
    // half, counted by their thread clocks over the half's wall time, must stay within what
    // the workers and duties in force over the same half allowed, plus each worker's
    // allowance. A throttle that never sleeps ends at the duty floor with one worker while
    // that worker keeps a whole core. (A final snapshot cannot stand in for the half: on the
    // CI legs of 24 Sep 2026 the loop cut its duty on the last tick, and 1 worker at 0.352 on
    // 3 cores "explained" 0.117 of a 0.194 share it had allowed. Nor can the process share:
    // it counts the sampling thread and the tick as well, and its per-sample mean weighs a
    // sample the schedule caught up with in microseconds, in which the sampling thread ran
    // throughout, as much as a full one. The macOS CI leg of 26 Sep 2026 failed the law on
    // that mean, 0.229 against 0.176 allowed, with catch-up samples reading 0.44 to 1.00;
    // on a Mac whose cores were kept busy the mean overstated the process's share over the
    // half by 0.05.) Checked before the band: a throttle that does not throttle also moves
    // the share out of the band, and this names the cause.
    assert_the_allowance_covers_the_throttle(label);
    let slack = duty_law_slack(report, cores, threads);
    assert!(
        report
            .workers_last_half
            .is_some_and(|workers| workers <= report.allowed_last_half + slack),
        "[{label}] the workers' own CPU over the second half came to {} of {cores} cores, but \
         the workers and duties in force allowed at most {:.4} (+{slack:.4}: each of {threads} \
         workers' ledger credit, a duty up to a tick old, one unit of clock lag): the throttle \
         is not throttling",
        workers_text(report),
        report.allowed_last_half,
    );
    assert!(
        (report.mean_last_half - report.target).abs() <= BAND,
        "[{label}] mean of the last half {:.4} is outside ±{BAND} of {:.2}{}",
        report.mean_last_half,
        report.target,
        if machine_had_nothing_to_give(report) {
            format!(
                " — on a machine idle for {} of its time, so this measured the machine: \
                 nothing was left for the governor to take",
                idle_text(report)
            )
        } else {
            format!(" (the machine was idle for {} of it)", idle_text(report))
        }
    );
    assert!(
        report.within_band,
        "[{label}] the report must agree with the band it computed"
    );
}

#[test]
fn holds_nineteen_percent_of_this_machine_for_ten_seconds() {
    let label = "balanced@19%";
    for attempt in 1..=HOLD_ATTEMPTS {
        let gate = run_gate(
            label,
            Preset::Balanced,
            Some(SHORT_HOLD_PERCENT),
            SHORT_HOLD_S,
        );
        let report = &gate.report;
        assert!(
            (report.target - f64::from(SHORT_HOLD_PERCENT) / 100.0).abs() < 1e-9,
            "the target is the override: {}",
            report.target
        );
        if attempt < HOLD_ATTEMPTS && machine_had_nothing_to_give(report) {
            println!(
                "[{label}] attempt {attempt} of {HOLD_ATTEMPTS}: the machine was idle for {} of \
                 the last half, so the hold measured the machine; holding again once it has room",
                idle_text(report)
            );
            wait_for_room(label, report.target + BAND);
            continue;
        }
        assert_gate(label, &gate, SHORT_HOLD_S);
        return;
    }
}

#[test]
#[ignore = "Phase 2 gate: one minute at Eco; run with --ignored --test-threads=1 --nocapture"]
fn holds_eco_for_sixty_seconds() {
    let gate = run_gate("eco", Preset::Eco, None, GATE_HOLD_S);
    assert_gate("eco", &gate, GATE_HOLD_S);
}

#[test]
#[ignore = "Phase 2 gate: one minute at Balanced; run with --ignored --test-threads=1 --nocapture"]
fn holds_balanced_for_sixty_seconds() {
    let gate = run_gate("balanced", Preset::Balanced, None, GATE_HOLD_S);
    assert_gate("balanced", &gate, GATE_HOLD_S);
}

#[test]
#[ignore = "Phase 2 gate: one minute at Turbo; run with --ignored --test-threads=1 --nocapture"]
fn holds_turbo_for_sixty_seconds() {
    let gate = run_gate("turbo", Preset::Turbo, None, GATE_HOLD_S);
    assert_gate("turbo", &gate, GATE_HOLD_S);
}

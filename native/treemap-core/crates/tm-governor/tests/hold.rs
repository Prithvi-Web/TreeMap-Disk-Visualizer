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

use tm_governor::controller::MACHINE_FULL_SHARE;
use tm_governor::governor::{THROTTLE_CREDIT_CAP, THROTTLE_MIN_SLEEP, TICK};
use tm_governor::loadgen::{HOLD_SAMPLE_PERIOD, SPIN_UNIT, machine_idle_last_half};
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
/// Holds the default test may run. A hold under the band that the machine held back over its
/// last half measured the machine, not the governor, and is measured again (the Windows CI
/// leg of 24 Sep 2026 held 11% of a 19% target with both of its workers at full duty; see
/// [`machine_held_it_back`]); the last hold is held to the band whatever the machine did,
/// saying so when it held that one back too.
const HOLD_ATTEMPTS: u32 = 3;
/// How long the default test waits, before holding again, for the machine to have room:
/// on that CI leg the busy spell outlasted one hold and failed the next test binary too.
const ROOM_DEADLINE: Duration = Duration::from_secs(60);
/// How often it asks how busy the machine is while it waits.
const ROOM_POLL: Duration = Duration::from_millis(250);
/// Readings in a row the machine must have room at before a hold is run again, at the least.
const ROOM_READINGS_IN_A_ROW: usize = 3;
/// How long those readings must cover, from the first to the last: macOS publishes about one
/// reading a second, Linux and Windows one at every poll ([`ROOM_POLL`]).
const ROOM_SPAN: Duration = Duration::from_secs(2);
/// Readings at or over [`MACHINE_FULL_SHARE`], and wakeups a whole period late, that a hold's
/// second half must hold before either counts as a sign of a full machine. One alone may be a
/// blip: macOS sometimes publishes its counters several times within a second, and a reading
/// then covers only the few ticks since the last one; here one read 1.000 at a moment of a half
/// that was 0.76 idle, and another 0.000.
const FULL_MACHINE_SIGNS: usize = 2;
/// The full readings must also be one in this many of the readings published over the half, at
/// the least: the controller holds its duty from a full reading to the next one, so where readings
/// come evenly this is the share of the half it held, and roughly so where macOS publishes several
/// within a second. macOS published 9 to 15 readings over a half on this Mac, and
/// Linux and Windows publish one at every sample, fifty, so two would be a different claim on each.
const FULL_READINGS_ONE_IN: usize = 5;
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
            auto_base: Preset::Balanced,
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
    let readings: Vec<String> = report
        .machine_busy
        .iter()
        .enumerate()
        .filter_map(|(sample, reading)| reading.map(|busy| format!("#{sample} {busy:.3}")))
        .collect();
    println!(
        "[{label}] machine busy share as the OS published it (sample: share): {}",
        if readings.is_empty() {
            "none".to_owned()
        } else {
            readings.join(" ")
        }
    );
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

/// The machine readings the OS published over a hold's second half: how many found the
/// machine full by the controller's own line ([`MACHINE_FULL_SHARE`]), and how many there were.
fn full_readings_last_half(report: &HoldReport) -> (usize, usize) {
    let published: Vec<f64> = report
        .machine_busy
        .iter()
        .skip(report.machine_busy.len() / 2)
        .filter_map(|reading| reading.filter(|share| share.is_finite()))
        .collect();
    let full = published
        .iter()
        .filter(|&&share| share >= MACHINE_FULL_SHARE)
        .count();
    (full, published.len())
}

/// The samples of a hold's second half at which the OS woke the sampling thread a whole
/// [`HOLD_SAMPLE_PERIOD`] or more after it was due (an interval of two periods or more), and how
/// many samples there were. A thread left waiting that long found no core free for it, or had
/// its core taken away by whatever hosts the machine.
fn late_wakeups_last_half(report: &HoldReport) -> (usize, usize) {
    let half = report
        .intervals
        .get(report.intervals.len() / 2..)
        .unwrap_or_default();
    let late_from = 2.0 * HOLD_SAMPLE_PERIOD.as_secs_f64();
    let late = half
        .iter()
        .filter(|&&interval| interval >= late_from)
        .count();
    (late, half.len())
}

/// The signs of a full machine a hold's second half shows; see [`machine_held_it_back`].
struct Signs {
    /// Readings at or over [`MACHINE_FULL_SHARE`], [`FULL_MACHINE_SIGNS`] of them at the least
    /// and one in [`FULL_READINGS_ONE_IN`] of those published.
    full_readings: bool,
    /// Wakeups a whole period late, [`FULL_MACHINE_SIGNS`] of them at the least.
    late_wakeups: bool,
    /// A mean idle share no larger than the hold's shortfall and the band together.
    no_room: bool,
}

fn signs(report: &HoldReport) -> Signs {
    let (full, published) = full_readings_last_half(report);
    let shortfall = report.target - report.mean_last_half;
    Signs {
        full_readings: full >= FULL_MACHINE_SIGNS && full * FULL_READINGS_ONE_IN >= published,
        late_wakeups: late_wakeups_last_half(report).0 >= FULL_MACHINE_SIGNS,
        no_room: report
            .machine_idle_last_half
            .is_some_and(|idle| idle <= shortfall + BAND),
    }
}

/// Whether a hold under the band was held back by the machine, as measured over its second half,
/// in any of three ways ([`Signs`]). The machine read full by the controller's own line
/// ([`MACHINE_FULL_SHARE`]) for a fair share of the half, and from such a reading to the next the
/// controller holds its duty rather than wind it up against work that is not its own
/// (controller.rs, `held_by_machine`). Or the OS woke the sampling thread a whole period late
/// ([`late_wakeups_last_half`]), and the controller's own ticks run on the same machine. Or the
/// machine sat idle for no more than the hold fell short by, plus the band: too little was there
/// to take. That last is the rule before 25 Oct 2026 (an idle share within the band)
/// widened by the shortfall: the macOS CI leg of that day held 0.139 of a 0.19 target, its own
/// decisions allowing 0.143 on average, over a half whose mean idle share was 0.057, more than
/// the band, so it was not measured again, though four of the half's wakeups came more than a
/// whole period late. This decides only whether a hold is measured again: the last one is held
/// to the band whatever the machine did.
fn machine_held_it_back(report: &HoldReport) -> bool {
    let Signs {
        full_readings,
        late_wakeups,
        no_room,
    } = signs(report);
    report.mean_last_half < report.target - BAND && (full_readings || late_wakeups || no_room)
}

/// How the machine held a hold back, in words: only the signs it showed.
fn held_back_text(report: &HoldReport) -> String {
    let Signs {
        full_readings,
        late_wakeups,
        no_room,
    } = signs(report);
    let mut how = Vec::new();
    if full_readings {
        how.push("the controller holds its duty at a full reading");
    }
    if late_wakeups {
        how.push("its own ticks may have waited for a core as the sampling thread did");
    }
    if no_room {
        how.push("the machine sat idle for no more than the hold fell short by, plus the band");
    }
    how.join(", and ")
}

/// What the machine did over a hold's second half, in words.
fn readings_text(report: &HoldReport) -> String {
    let (full, published) = full_readings_last_half(report);
    let (late, samples) = late_wakeups_last_half(report);
    let readings = match report.machine_idle_last_half {
        Some(idle) => format!(
            "idle for {idle:.4} of it, full at {full} of the {published} readings the OS published"
        ),
        None => "never read: the OS published no reading of it".to_owned(),
    };
    format!(
        "{readings}, and its sampling thread woken a whole period late at {late} of the \
         {samples} samples"
    )
}

/// Watches the machine readings for room that lasts: idle for more than `needed` of its time at
/// every reading for [`ROOM_SPAN`], and at [`ROOM_READINGS_IN_A_ROW`] readings at the least. One
/// reading with room on a machine kept full is a blip: with eight busy loops on this Mac's eight
/// cores, the wait read 0.40 idle once in 50 s, ended, and the hold after it failed.
struct RoomWatch {
    needed: f64,
    in_a_row: usize,
    /// When the first reading of the current run with room came.
    since: Option<Duration>,
}

impl RoomWatch {
    fn new(needed: f64) -> Self {
        Self {
            needed,
            in_a_row: 0,
            since: None,
        }
    }

    /// Takes one reading of the machine's idle share, `at` into the wait; true once the readings
    /// in a row with room are enough and span [`ROOM_SPAN`]. A reading that is not a number has
    /// no room.
    fn saw(&mut self, idle: f64, at: Duration) -> bool {
        let has_room = idle > self.needed;
        if !has_room {
            self.in_a_row = 0;
            self.since = None;
            return false;
        }
        self.in_a_row += 1;
        let since = *self.since.get_or_insert(at);
        self.in_a_row >= ROOM_READINGS_IN_A_ROW && at.saturating_sub(since) >= ROOM_SPAN
    }
}

/// Waits until the whole machine has room that lasts ([`RoomWatch`]), so a hold could reach its
/// target without taking anything from anyone, or until the deadline; says which.
fn wait_for_room(label: &str, needed: f64) {
    let mut sampler = platform_sampler();
    let mut watch = RoomWatch::new(needed);
    let started = Instant::now();
    let mut last_idle = None;
    while started.elapsed() < ROOM_DEADLINE {
        thread::sleep(ROOM_POLL);
        if let Some(busy) = sampler.machine_busy_share() {
            let idle = 1.0 - busy;
            last_idle = Some(idle);
            if watch.saw(idle, started.elapsed()) {
                println!(
                    "[{label}] the machine was idle for more than {needed:.2} of its time at every \
                     reading for {ROOM_SPAN:?}, the last {idle:.3}, after {:.1} s of waiting",
                    started.elapsed().as_secs_f64()
                );
                return;
            }
        }
    }
    println!(
        "[{label}] the machine was never idle for more than {needed:.2} at every reading for \
         {ROOM_SPAN:?} in {ROOM_DEADLINE:?} (last reading {last_idle:?}); holding anyway"
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
        if machine_held_it_back(report) {
            format!(
                " — on a machine {}; {}, so this measured the machine, at least in part",
                readings_text(report),
                held_back_text(report)
            )
        } else {
            format!(" (the machine was {})", readings_text(report))
        }
    );
    assert!(
        report.within_band,
        "[{label}] the report must agree with the band it computed"
    );
}

/// One ten-second hold at the default test's target.
fn hold_nineteen(label: &str) -> Gate {
    let gate = run_gate(
        label,
        Preset::Balanced,
        Some(SHORT_HOLD_PERCENT),
        SHORT_HOLD_S,
    );
    assert!(
        (gate.report.target - f64::from(SHORT_HOLD_PERCENT) / 100.0).abs() < 1e-9,
        "the target is the override: {}",
        gate.report.target
    );
    gate
}

#[test]
fn holds_nineteen_percent_of_this_machine_for_ten_seconds() {
    let label = "balanced@19%";
    for attempt in 1..HOLD_ATTEMPTS {
        let gate = hold_nineteen(label);
        if !machine_held_it_back(&gate.report) {
            assert_gate(label, &gate, SHORT_HOLD_S);
            return;
        }
        println!(
            "[{label}] attempt {attempt} of {HOLD_ATTEMPTS}: over the last half the machine was {}, \
             so the hold measured the machine; holding again once the machine has room",
            readings_text(&gate.report)
        );
        wait_for_room(label, gate.report.target + BAND);
    }
    // The last hold is judged whatever the machine did.
    assert_gate(label, &hold_nineteen(label), SHORT_HOLD_S);
}

/// A ten-second hold's report holding `mean_last_half` of a 0.19 target, the OS publishing the
/// machine's busy share once a second of its second half (`last_half`, as macOS does) and nothing
/// in its first.
fn report_with(mean_last_half: f64, last_half: &[f64]) -> HoldReport {
    let count = usize::try_from(SHORT_HOLD_S).unwrap_or(0) * SAMPLES_PER_SECOND;
    let mut machine_busy = vec![None; count];
    for (second, &busy) in last_half.iter().enumerate() {
        if let Some(reading) =
            machine_busy.get_mut(count / 2 + (second + 1) * SAMPLES_PER_SECOND - 1)
        {
            *reading = Some(busy);
        }
    }
    let target = f64::from(SHORT_HOLD_PERCENT) / 100.0;
    HoldReport {
        target,
        samples: vec![mean_last_half; count],
        intervals: vec![HOLD_SAMPLE_PERIOD.as_secs_f64(); count],
        mean: mean_last_half,
        mean_last_half,
        p95_abs_error: (mean_last_half - target).abs(),
        within_band: (mean_last_half - target).abs() <= BAND,
        workers_final: 1,
        duty_final: mean_last_half * 3.0,
        allowed_last_half: mean_last_half,
        workers_last_half: Some(mean_last_half),
        machine_idle_last_half: machine_idle_last_half(&machine_busy),
        machine_busy,
    }
}

/// `report` with the OS publishing a reading at every sample of the second half, as Linux and
/// Windows do: `last_half` in order, from its first sample.
fn read_at_every_sample(mut report: HoldReport, last_half: &[f64]) -> HoldReport {
    let half = report.machine_busy.len() / 2;
    for (sample, &busy) in last_half.iter().enumerate() {
        if let Some(reading) = report.machine_busy.get_mut(half + sample) {
            *reading = Some(busy);
        }
    }
    report.machine_idle_last_half = machine_idle_last_half(&report.machine_busy);
    report
}

/// `full` readings of 0.99 and the rest of the half's fifty at 0.70, one at every sample.
fn full_at(full: usize) -> Vec<f64> {
    (0..50)
        .map(|sample| if sample < full { 0.99 } else { 0.70 })
        .collect()
}

#[test]
fn a_hold_short_of_its_target_while_the_machine_read_full_is_measured_again() {
    // Two full readings of five, on a half that sat idle for 0.192 on average: more than the
    // shortfall and the band together (0.1007), so only the full readings speak.
    let held_back = report_with(0.1393, &[0.97, 0.97, 0.70, 0.70, 0.70]);
    let Signs {
        late_wakeups,
        no_room,
        ..
    } = signs(&held_back);
    assert!(
        !late_wakeups && !no_room,
        "control: the full readings are the only sign"
    );
    assert!(
        machine_held_it_back(&held_back),
        "two of its five readings found the machine full, and from each the controller held its \
         duty: the hold measured the machine"
    );
    assert!(
        !machine_held_it_back(&report_with(0.1393, &[0.80; 5])),
        "the same shortfall on a machine with room at every reading is the governor's own"
    );
    assert!(
        machine_held_it_back(&report_with(
            0.1393,
            &[MACHINE_FULL_SHARE, MACHINE_FULL_SHARE, 0.70, 0.70, 0.70]
        )),
        "a reading at the line itself is full, as the controller counts it"
    );
    assert!(
        !machine_held_it_back(&report_with(0.1393, &[1.0, 0.24, 0.24, 0.24, 0.24])),
        "one full reading in a half with room at every other is a blip"
    );
    assert!(
        !machine_held_it_back(&report_with(0.17, &[0.99; 5])),
        "a hold within the band was not held back, however full the machine"
    );
    assert!(
        !machine_held_it_back(&report_with(0.1393, &[])),
        "where the OS published no reading, nothing says the machine held it back"
    );
}

#[test]
fn full_readings_count_by_their_share_of_those_published() {
    let at_every_sample =
        |full: usize| read_at_every_sample(report_with(0.1393, &[]), &full_at(full));
    assert_eq!(
        at_every_sample(2).machine_busy.iter().flatten().count(),
        50,
        "control: a reading at every sample of the half, as on Linux and Windows"
    );
    assert!(
        !machine_held_it_back(&at_every_sample(2)),
        "two full readings of fifty: the controller held its duty for a tenth of a second each"
    );
    assert!(
        !machine_held_it_back(&at_every_sample(9)),
        "nine of fifty is less than one in {FULL_READINGS_ONE_IN}"
    );
    assert!(
        machine_held_it_back(&at_every_sample(10)),
        "ten of fifty is one in {FULL_READINGS_ONE_IN}: the controller held its duty for a fifth \
         of the half"
    );
}

#[test]
fn a_hold_short_of_its_target_on_a_machine_with_no_room_for_it_is_measured_again() {
    // The macOS CI leg of 25 Oct 2026: 0.1393 of 0.19 over a half idle for 0.0572 on average.
    // Readings all just under the controller's line come to that mean with no full one.
    let ci = report_with(0.1393, &[0.9428; 5]);
    let idle = ci.machine_idle_last_half.unwrap_or(f64::NAN);
    assert!(
        (idle - 0.0572).abs() < 1e-9,
        "control: the CI leg's mean idle share, not {idle}"
    );
    assert!(
        idle > BAND,
        "control: more idle than the band, which alone did not call for another hold"
    );
    let Signs {
        full_readings,
        late_wakeups,
        ..
    } = signs(&ci);
    assert!(
        !full_readings && !late_wakeups,
        "control: no full reading and no late wakeup"
    );
    assert!(
        machine_held_it_back(&ci),
        "0.0572 idle is less than the 0.0507 it fell short by and the band together: too little \
         was there to take"
    );
    assert!(
        !machine_held_it_back(&report_with(0.1393, &[0.85; 5])),
        "0.15 idle had room for the shortfall and the band"
    );
    assert!(
        machine_held_it_back(&report_with(0.0384, &[0.85; 5])),
        "the same 0.15 idle did not have room for a shortfall of 0.15"
    );
    assert!(
        !machine_held_it_back(&report_with(0.0384, &[0.15; 5])),
        "a governor capped at a quarter of its duty held 0.038 on this Mac with the machine 0.85 \
         idle: the shortfall is its own"
    );
}

/// `report` with the OS also publishing `first_half`, once a second of the hold's first half.
fn read_in_first_half(mut report: HoldReport, first_half: &[f64]) -> HoldReport {
    for (second, &busy) in first_half.iter().enumerate() {
        if let Some(reading) = report
            .machine_busy
            .get_mut((second + 1) * SAMPLES_PER_SECOND - 1)
        {
            *reading = Some(busy);
        }
    }
    report.machine_idle_last_half = machine_idle_last_half(&report.machine_busy);
    report
}

/// `report` with the sampling thread woken `late_by` past its time at each sample in `at`: that
/// interval runs a period plus the delay, and the schedule catches up at the next sample, whose
/// interval runs as much short (none at all once the delay reaches a whole period).
fn woken_late(mut report: HoldReport, at: &[usize], late_by: Duration) -> HoldReport {
    let period = HOLD_SAMPLE_PERIOD.as_secs_f64();
    let late = late_by.as_secs_f64();
    for &sample in at {
        if let Some(interval) = report.intervals.get_mut(sample) {
            *interval = period + late;
        }
        if let Some(next) = report.intervals.get_mut(sample + 1) {
            *next = (period - late).max(0.0);
        }
    }
    report
}

#[test]
fn a_hold_short_of_its_target_while_its_own_sampling_thread_waited_for_a_core_is_measured_again() {
    // The macOS CI leg of 25 Oct 2026 woke the sampling thread more than a whole period late at
    // four samples of the second half (intervals of 201 to 241 ms for a 100 ms period), and
    // later than asked at most of the rest. A thread left waiting that long found no core free
    // for it. The half here had 0.20 idle at every reading, so the wakeups are the only sign.
    let waited = woken_late(
        report_with(0.1393, &[0.80; 5]),
        &[62, 75],
        Duration::from_millis(101),
    );
    assert!(
        machine_held_it_back(&waited),
        "a sampling thread woken a whole period late, twice over the second half: the hold \
         measured the machine"
    );
    assert!(
        !machine_held_it_back(&woken_late(
            report_with(0.1393, &[0.80; 5]),
            &[62],
            Duration::from_millis(141),
        )),
        "one wakeup a whole period late is a blip"
    );
    assert!(
        !machine_held_it_back(&woken_late(
            report_with(0.1393, &[1.0, 0.70, 0.70, 0.70, 0.70]),
            &[62],
            Duration::from_millis(141),
        )),
        "one full reading and one late wakeup are a blip of each kind: the kinds are not added up"
    );
    assert!(
        !machine_held_it_back(&woken_late(
            report_with(0.1393, &[0.80; 5]),
            &[62, 72, 82],
            Duration::from_millis(99),
        )),
        "a wakeup less than a whole period late is not counted: an OS may gather timers that far"
    );
    assert!(
        !machine_held_it_back(&woken_late(
            report_with(0.17, &[0.80; 5]),
            &[62, 72],
            Duration::from_millis(150),
        )),
        "a hold within the band was not held back, however late its sampling thread woke"
    );
}

#[test]
fn only_what_the_machine_did_over_the_second_half_calls_for_another_hold() {
    let full_early = read_in_first_half(report_with(0.1393, &[0.80; 5]), &[0.99; 5]);
    assert_eq!(
        full_early.machine_busy.iter().flatten().count(),
        10,
        "control: five readings in each half"
    );
    assert!(
        !machine_held_it_back(&full_early),
        "a machine full only over the first half, with room at every reading of the second, \
         left the second half's shortfall to the governor"
    );
    assert!(
        !machine_held_it_back(&woken_late(
            report_with(0.1393, &[0.80; 5]),
            &[12, 22, 32],
            Duration::from_millis(150),
        )),
        "and so did one that woke the sampling thread late only over the first half"
    );
}

#[test]
fn a_failure_the_machine_held_back_names_only_the_signs_it_saw() {
    let late = |report| woken_late(report, &[62, 75], Duration::from_millis(101));
    let full = report_with(0.1393, &[0.97, 0.97, 0.70, 0.70, 0.70]);
    let waited = late(report_with(0.1393, &[0.80; 5]));
    let no_room = report_with(0.1393, &[0.9428; 5]);
    let all = late(report_with(0.1393, &[0.99; 5]));
    assert_eq!(
        held_back_text(&full),
        "the controller holds its duty at a full reading"
    );
    assert_eq!(
        held_back_text(&waited),
        "its own ticks may have waited for a core as the sampling thread did"
    );
    assert_eq!(
        held_back_text(&no_room),
        "the machine sat idle for no more than the hold fell short by, plus the band"
    );
    assert_eq!(
        held_back_text(&all),
        "the controller holds its duty at a full reading, and its own ticks may have waited for a \
         core as the sampling thread did, and the machine sat idle for no more than the hold fell \
         short by, plus the band"
    );
    assert_eq!(
        readings_text(&waited),
        "idle for 0.2000 of it, full at 0 of the 5 readings the OS published, and its sampling \
         thread woken a whole period late at 2 of the 50 samples"
    );
    assert_eq!(
        readings_text(&report_with(0.1393, &[])),
        "never read: the OS published no reading of it, and its sampling thread woken a whole \
         period late at 0 of the 50 samples"
    );
}

#[test]
fn the_wait_for_room_ends_only_on_room_that_lasts() {
    let needed = f64::from(SHORT_HOLD_PERCENT) / 100.0 + BAND;
    // Each reading as (its idle share, seconds into the wait).
    let watched = |readings: &[(f64, f64)]| -> Vec<bool> {
        let mut watch = RoomWatch::new(needed);
        readings
            .iter()
            .map(|&(idle, at)| watch.saw(idle, Duration::from_secs_f64(at)))
            .collect()
    };
    // Eight busy loops on this Mac's eight cores: one reading of 0.40 idle in 50 s of waiting.
    assert_eq!(
        watched(&[(0.01, 1.0), (0.40, 2.0), (0.01, 3.0), (0.02, 4.0)]),
        [false; 4],
        "one reading with room on a machine kept full is a blip"
    );
    assert_eq!(
        watched(&[(0.30, 1.0), (0.30, 2.0), (0.30, 3.0)]),
        [false, false, true],
        "about one reading a second, as macOS publishes: room at three readings over two seconds"
    );
    let every_poll: Vec<(f64, f64)> = (1..=9).map(|poll| (0.30, f64::from(poll) * 0.25)).collect();
    assert_eq!(
        watched(&every_poll),
        [false, false, false, false, false, false, false, false, true],
        "a reading at every poll, as Linux and Windows publish: room for two seconds, not three \
         readings"
    );
    assert_eq!(
        watched(&[(0.30, 1.0), (0.30, 3.5), (0.30, 4.0)]),
        [false, false, true],
        "two readings over two seconds and more are not enough"
    );
    assert_eq!(
        watched(&[
            (0.30, 1.0),
            (0.30, 2.0),
            (0.01, 3.0),
            (0.30, 3.25),
            (0.30, 3.5),
            (0.30, 3.75)
        ]),
        [false; 6],
        "a reading without room starts the count and the span again"
    );
    assert_eq!(
        watched(&[
            (0.30, 1.0),
            (0.30, 2.0),
            (0.01, 3.0),
            (0.30, 4.0),
            (0.30, 6.5)
        ]),
        [false; 5],
        "the readings before one without room do not count towards the three"
    );
    assert_eq!(
        watched(&[(needed, 1.0), (needed, 2.0), (needed, 3.0), (f64::NAN, 4.0)]),
        [false; 4],
        "a reading at the share needed, or one that is not a number, has no room"
    );
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

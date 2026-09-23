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

use tm_governor::{Budget, FakeSignals, Governor, HoldReport, Preset, hold, platform_sampler};

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
/// Slack on the law that a worker cannot deliver more share than its duty allows: the band's
/// own half-width. The ledger's bounded credit adds under one point over the window, and the
/// loop only ever errs the other way (a worker that gets less CPU than its duty allows makes
/// the duty rise), so the slack is measurement noise, not a model allowance.
const DUTY_EXPLAINS_SHARE_SLACK: f64 = BAND;

fn run_gate(
    label: &str,
    preset: Preset,
    cpu_percent: Option<u8>,
    seconds: u32,
) -> (HoldReport, u32) {
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
    print_report(label, &report, cores);
    (report, cores)
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

fn print_report(label: &str, report: &HoldReport, cores: u32) {
    println!(
        "[{label}] cores {cores} target {:.2} mean {:.4} mean_last_half {:.4} p95_abs_error {:.4} \
         workers_final {} duty_final {:.3} within_band {} samples {}",
        report.target,
        report.mean,
        report.mean_last_half,
        report.p95_abs_error,
        report.workers_final,
        report.duty_final,
        report.within_band,
        report.samples.len()
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

fn assert_gate(label: &str, report: &HoldReport, cores: u32, seconds: u32) {
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
    assert!(
        (report.mean_last_half - report.target).abs() <= BAND,
        "[{label}] mean of the last half {:.4} is outside ±{BAND} of {:.2}",
        report.mean_last_half,
        report.target
    );
    assert!(
        report.within_band,
        "[{label}] the report must agree with the band it computed"
    );
    // No worker can deliver more of the machine than its duty allows, so the governor's
    // final duty and worker count must explain the share that was measured. A throttle
    // that never sleeps ends at the duty floor with one worker while the share stays up.
    let explained = f64::from(report.workers_final) * report.duty_final / f64::from(cores.max(1));
    assert!(
        explained >= report.mean_last_half - DUTY_EXPLAINS_SHARE_SLACK,
        "[{label}] {} workers at duty {:.3} on {cores} cores explain at most {explained:.3}, \
         not the {:.3} that was measured: the throttle is not throttling",
        report.workers_final,
        report.duty_final,
        report.mean_last_half
    );
}

#[test]
fn holds_nineteen_percent_of_this_machine_for_ten_seconds() {
    let label = "balanced@19%";
    let (report, cores) = run_gate(
        label,
        Preset::Balanced,
        Some(SHORT_HOLD_PERCENT),
        SHORT_HOLD_S,
    );
    assert!(
        (report.target - f64::from(SHORT_HOLD_PERCENT) / 100.0).abs() < 1e-9,
        "the target is the override: {}",
        report.target
    );
    assert_gate(label, &report, cores, SHORT_HOLD_S);
}

#[test]
#[ignore = "Phase 2 gate: one minute at Eco; run with --ignored --test-threads=1 --nocapture"]
fn holds_eco_for_sixty_seconds() {
    let (report, cores) = run_gate("eco", Preset::Eco, None, GATE_HOLD_S);
    assert_gate("eco", &report, cores, GATE_HOLD_S);
}

#[test]
#[ignore = "Phase 2 gate: one minute at Balanced; run with --ignored --test-threads=1 --nocapture"]
fn holds_balanced_for_sixty_seconds() {
    let (report, cores) = run_gate("balanced", Preset::Balanced, None, GATE_HOLD_S);
    assert_gate("balanced", &report, cores, GATE_HOLD_S);
}

#[test]
#[ignore = "Phase 2 gate: one minute at Turbo; run with --ignored --test-threads=1 --nocapture"]
fn holds_turbo_for_sixty_seconds() {
    let (report, cores) = run_gate("turbo", Preset::Turbo, None, GATE_HOLD_S);
    assert_gate("turbo", &report, cores, GATE_HOLD_S);
}

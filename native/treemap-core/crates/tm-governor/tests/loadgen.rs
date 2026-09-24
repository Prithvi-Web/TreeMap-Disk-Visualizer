//! The synthetic load's own lifecycle: a stop must return even while the
//! governor it obeys is paused, and dropping the load must end its workers.
//! Both were review findings: a worker parked inside a paused `throttle()`
//! could only be released by the governor, so `stop()` hung, and a load
//! dropped without `stop()` kept spinning for the life of the process.

use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use std::hint::black_box;

use tm_governor::loadgen::machine_idle_last_half;
use tm_governor::{Budget, FakeSampler, FakeSignals, Governor, Preset, SyntheticLoad, hold};

const WITHIN: Duration = Duration::from_secs(2);

fn governor() -> Governor {
    Governor::start(
        Budget {
            preset: Preset::Turbo,
            cpu_percent: None,
        },
        false,
        Box::new(FakeSampler::new(4)),
        Box::new(FakeSignals::default()),
    )
}

#[test]
fn stop_returns_while_the_governor_is_paused() {
    let governor = governor();
    let load = SyntheticLoad::start(&governor, 2);
    thread::sleep(Duration::from_millis(50));
    governor.pause();
    // The workers reach their next throttle() and park there.
    thread::sleep(Duration::from_millis(100));
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        load.stop();
        let _ = tx.send(());
    });
    let stopped = rx.recv_timeout(WITHIN).is_ok();
    governor.resume();
    governor.stop();
    assert!(
        stopped,
        "stop() must return while the governor is paused: the workers were parked in throttle()"
    );
}

#[test]
fn dropping_the_load_ends_its_workers() {
    let governor = governor();
    let before = governor.handle_count();
    let load = SyntheticLoad::start(&governor, 2);
    assert_eq!(
        governor.handle_count(),
        before + 2,
        "each worker holds a handle"
    );
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        drop(load);
        let _ = tx.send(());
    });
    assert!(rx.recv_timeout(WITHIN).is_ok(), "drop returned");
    let deadline = Instant::now() + WITHIN;
    while governor.handle_count() != before && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let after = governor.handle_count();
    governor.stop();
    assert_eq!(
        after, before,
        "the workers ended with the load instead of spinning on"
    );
}

fn spin_for(wall: Duration) {
    let started = Instant::now();
    let mut x: u64 = 1;
    while started.elapsed() < wall {
        x = black_box(x)
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
    }
    black_box(x);
}

#[test]
fn a_cancelled_worker_skips_the_duty_sleep() {
    // Eco on two cores runs at duty 0.25, so 40 ms of work owes 120 ms of rest.
    let mut sampler = FakeSampler::new(2);
    sampler.push_cpu(0.0);
    let governor = Governor::start(
        Budget {
            preset: Preset::Eco,
            cpu_percent: None,
        },
        false,
        Box::new(sampler),
        Box::new(FakeSignals::default()),
    );
    governor.throttle(); // opens this thread's ledger
    spin_for(Duration::from_millis(40));
    let before = governor.throttle_totals();
    let started = Instant::now();
    governor.throttle_unless(&|| true);
    let took = started.elapsed();
    let cancelled = governor.throttle_totals().since(before);
    governor.stop();
    // Counted, not read off the wall clock: Eco leaves this thread at the lowest priority,
    // where a busy machine can hold any call up for longer than the sleep it owes.
    assert_eq!(
        (cancelled.owed, cancelled.requested, cancelled.slept),
        (Duration::ZERO, Duration::ZERO, Duration::ZERO),
        "a cancelled worker must not rest (the call took {took:?})"
    );
}

#[test]
fn the_machine_idle_share_is_the_last_half_of_what_the_os_published() {
    // Six samples: the last half is the last three, and a sample the OS published
    // nothing for (macOS publishes about once a second) counts for nothing.
    let busy = [Some(0.2), None, Some(0.4), Some(0.9), None, Some(1.0)];
    let idle = machine_idle_last_half(&busy).map(|i| (i * 1e9).round() / 1e9);
    assert_eq!(idle, Some(0.05), "1 - mean(0.9, 1.0)");
    assert_eq!(
        machine_idle_last_half(&[Some(0.1), Some(0.2), None, None]),
        None,
        "nothing published in the last half is no reading"
    );
    assert_eq!(machine_idle_last_half(&[]), None);
    assert_eq!(
        machine_idle_last_half(&[Some(0.5), Some(f64::NAN)]),
        None,
        "a reading that is not a number is not a reading"
    );
}

#[test]
fn a_hold_reports_how_idle_the_machine_was_over_its_last_half() {
    let run = |machine: Option<f64>| {
        let mut control = FakeSampler::new(4);
        control.push_cpu(0.0);
        let governor = Governor::start(
            Budget {
                preset: Preset::Balanced,
                cpu_percent: None,
            },
            false,
            Box::new(control),
            Box::new(FakeSignals::default()),
        );
        let mut measure = FakeSampler::new(4);
        measure.push_cpu(0.0);
        measure.set_machine(machine);
        let report = hold(&governor, 0.4, &mut measure);
        governor.stop();
        report
            .machine_idle_last_half
            .map(|i| (i * 1e9).round() / 1e9)
    };
    assert_eq!(run(Some(0.97)), Some(0.03));
    assert_eq!(run(None), None, "a machine without counters reports none");
}

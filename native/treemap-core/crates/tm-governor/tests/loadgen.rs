//! The synthetic load's own lifecycle: a stop must return even while the
//! governor it obeys is paused, and dropping the load must end its workers.
//! Both were review findings: a worker parked inside a paused `throttle()`
//! could only be released by the governor, so `stop()` hung, and a load
//! dropped without `stop()` kept spinning for the life of the process.

use std::sync::{Mutex, MutexGuard, PoisonError, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use std::hint::black_box;

use tm_governor::loadgen::{SPIN_UNIT, machine_idle_last_half};
use tm_governor::sample::thread_cpu_seconds;
use tm_governor::{
    Budget, FakeSampler, FakeSignals, Governor, Preset, SyntheticLoad, hold, platform_sampler,
};

const WITHIN: Duration = Duration::from_secs(2);
/// How long a test waits for workers to show CPU before it calls them stuck: a guard
/// against hanging, not a measurement.
const WORKERS_ALIVE: Duration = Duration::from_secs(60);
/// How often a test polls while it waits.
const POLL: Duration = Duration::from_millis(10);
/// The CPU an OS may charge late, per thread and reading: Windows charges whole 15.6 ms ticks.
const CHARGE_GRANULARITY_S: f64 = 0.016;
/// What a governor ticking on a fake sampler, and the thread spawns and joins around a load,
/// use while a test waits: a few microseconds a tick, generously.
const OTHER_THREADS_S: f64 = 0.005;

/// Held by every test here that runs a load, so they run one at a time: a test that compares
/// its workers' CPU with the whole process's must be the only one spinning in the process.
static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(PoisonError::into_inner)
}

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
    let _serial = serial();
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
    let _serial = serial();
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
    let _serial = serial();
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
fn a_load_counts_the_cpu_its_workers_use_and_no_other_thread_s() {
    // Two workers on Turbo over an idle fake run at (nearly) full duty. Counted, not timed:
    // the test waits until the workers' own clocks show WORKERS_CPU_TO_SEE, then compares
    // them with the process's clock, which counts every thread. The workers' CPU is part of
    // the process's, never more (a reading of the whole process would count it once per
    // worker), and nearly all of it: this thread only waits (its own clock says how little
    // it used), the fake-driven tick uses microseconds, and each worker's reading trails its
    // clock by at most the unit of work it was doing.
    const THREADS: u32 = 2;
    const WORKERS_CPU_TO_SEE: f64 = 0.2;
    let _serial = serial();
    let governor = governor();
    let mut process = platform_sampler();
    let process_before = process.own_cpu_seconds();
    let mine_before = thread_cpu_seconds();
    let load = SyntheticLoad::start(&governor, THREADS);
    let deadline = Instant::now() + WORKERS_ALIVE;
    while !load
        .cpu_seconds()
        .is_some_and(|used| used >= WORKERS_CPU_TO_SEE)
        && Instant::now() < deadline
    {
        thread::sleep(POLL);
    }
    let workers = load.cpu_seconds();
    let process_used = process.own_cpu_seconds() - process_before;
    let mine_used = thread_cpu_seconds()
        .zip(mine_before)
        .map_or(0.0, |(now, before)| now - before);
    load.stop();
    governor.stop();
    assert!(
        workers.is_some_and(|used| used >= WORKERS_CPU_TO_SEE),
        "the workers' clocks showed {workers:?} s within {WORKERS_ALIVE:?} (the process used {process_used:.4} s)"
    );
    let workers = workers.unwrap_or(f64::NAN);
    assert!(
        workers <= process_used + CHARGE_GRANULARITY_S,
        "the workers used {workers:.4} s, more than the whole process's {process_used:.4} s"
    );
    let trailing = f64::from(THREADS) * (SPIN_UNIT.as_secs_f64() + CHARGE_GRANULARITY_S);
    let others = mine_used + OTHER_THREADS_S + CHARGE_GRANULARITY_S;
    assert!(
        workers >= process_used - trailing - others,
        "the workers' clocks counted {workers:.4} s of the process's {process_used:.4} s; this thread used {mine_used:.4} s"
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
    let _serial = serial();
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

//! The synthetic load's own lifecycle: a stop must return even while the
//! governor it obeys is paused, and dropping the load must end its workers.
//! Both were review findings: a worker parked inside a paused `throttle()`
//! could only be released by the governor, so `stop()` hung, and a load
//! dropped without `stop()` kept spinning for the life of the process.

use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use std::hint::black_box;

use tm_governor::{Budget, FakeSampler, FakeSignals, Governor, Preset, SyntheticLoad};

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
    let started = Instant::now();
    governor.throttle_unless(&|| true);
    let took = started.elapsed();
    governor.stop();
    assert!(
        took < Duration::from_millis(20),
        "a cancelled worker must not rest: took {took:?}"
    );
}

//! Tests for the governor: the tick thread, `throttle()`, pause/resume, `configure()`,
//! the auto-Eco rule, `snapshot()` and `stop()`. The sampler and the signals are fakes
//! the test keeps steering after the governor owns them; the clock and the threads are real.

use std::hint::black_box;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use tm_governor::governor::{THROTTLE_SLEEP_CAP, throttle_sleep};
use tm_governor::{
    Budget, FakeSampler, FakeSignals, Governor, Preset, Signals, SyntheticLoad, Thermal,
};

/// The machine the fakes describe.
const CORES: u32 = 8;
/// The governor's nominal tick.
const TICK: Duration = Duration::from_millis(100);
/// How long a condition may take to appear before a test gives up.
const SETTLE: Duration = Duration::from_secs(3);
/// Polling interval for `wait_until`.
const POLL: Duration = Duration::from_millis(10);
/// CPU seconds per 100 ms tick that read as half of eight cores.
const HALF_MACHINE_CPU_PER_TICK_S: f64 = 0.4;
/// CPU seconds per 100 ms tick that read as a fifth of eight cores.
const FIFTH_MACHINE_CPU_PER_TICK_S: f64 = 0.16;
/// The unit of work between two `throttle()` calls in the cadence measurement.
const SPIN: Duration = Duration::from_millis(2);
/// The longest a single `throttle()` may sleep.
const THROTTLE_CAP: Duration = Duration::from_secs(1);

/// Signals a test can keep changing after the governor owns a handle to them.
#[derive(Clone)]
struct SharedSignals(Arc<Mutex<FakeSignals>>);

impl SharedSignals {
    fn quiet() -> Self {
        Self(Arc::new(Mutex::new(FakeSignals::default())))
    }

    fn boxed(&self) -> Box<dyn Signals> {
        Box::new(self.clone())
    }

    fn set(&self, change: impl FnOnce(&mut FakeSignals)) {
        change(&mut self.0.lock().unwrap_or_else(PoisonError::into_inner));
    }

    fn get(&self) -> FakeSignals {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Signals for SharedSignals {
    fn thermal(&mut self) -> Thermal {
        self.get().thermal
    }

    fn on_battery(&mut self) -> Option<bool> {
        self.get().on_battery
    }

    fn interacting(&mut self) -> Option<bool> {
        self.get().interacting
    }
}

fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if condition() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(POLL);
    }
}

/// A sampler whose process uses no CPU at all.
fn idle_sampler() -> FakeSampler {
    let mut sampler = FakeSampler::new(CORES);
    sampler.push_cpu(0.0);
    sampler
}

fn budget(preset: Preset) -> Budget {
    Budget {
        preset,
        cpu_percent: None,
    }
}

fn approx(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
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

/// Wall time for `units` of "spin, then throttle()".
fn cadence(governor: &Governor, units: u32) -> Duration {
    let started = Instant::now();
    for _ in 0..units {
        spin_for(SPIN);
        governor.throttle();
    }
    started.elapsed()
}

#[test]
fn throttle_sleeps_in_proportion_to_the_duty() {
    const UNITS: u32 = 50;
    let spin_total = SPIN * UNITS;
    let mut sampler = idle_sampler();
    let governor = Governor::start(
        budget(Preset::Eco),
        false,
        Box::new(sampler.clone()),
        SharedSignals::quiet().boxed(),
    );
    assert!(wait_until(SETTLE, || governor.snapshot().ticks >= 3));
    let full = governor.snapshot();
    assert!(
        full.duty > 0.95,
        "an idle process is not throttled: {full:?}"
    );
    governor.throttle();
    let unthrottled = cadence(&governor, UNITS);
    assert!(
        unthrottled < spin_total * 2,
        "at full duty throttle() never sleeps: {unthrottled:?} for {spin_total:?} of work"
    );

    // The process now reads as half the machine, twice Eco's quarter: the loop must cut the
    // duty all the way to the floor, where it stays while the measurement runs.
    sampler.push_cpu(HALF_MACHINE_CPU_PER_TICK_S);
    assert!(
        wait_until(SETTLE, || governor.snapshot().duty <= 0.06),
        "the duty falls to the floor when the share is over target: {:?}",
        governor.snapshot()
    );
    governor.throttle();
    let duty = governor.snapshot().duty;
    let throttled = cadence(&governor, UNITS);
    let ideal = spin_total.as_secs_f64() / duty;
    let ratio = throttled.as_secs_f64() / ideal;
    assert!(
        throttled >= unthrottled * 3,
        "throttled {throttled:?} should be well over unthrottled {unthrottled:?} at duty {duty}"
    );
    assert!(
        (0.6..=1.6).contains(&ratio),
        "{UNITS} units of {SPIN:?} at duty {duty:.3} should take about {ideal:.3}s, took {throttled:?} (ratio {ratio:.2})"
    );

    // One call never sleeps past the cap, however long the unit of work was: uncapped, a
    // 1.2 s unit at duty 0.05 would owe 22.8 s. The OS may still overrun the capped second.
    thread::sleep(THROTTLE_CAP + Duration::from_millis(200));
    let started = Instant::now();
    governor.throttle();
    let slept = started.elapsed();
    assert!(
        slept >= Duration::from_millis(500) && slept <= THROTTLE_CAP * 3,
        "a long unit of work at duty {duty} sleeps about the capped second, not {slept:?}"
    );
    governor.stop();
}

#[test]
fn pause_blocks_throttle_within_200_ms_and_resume_releases_it() {
    let governor = Governor::start(
        budget(Preset::Balanced),
        false,
        Box::new(idle_sampler()),
        SharedSignals::quiet().boxed(),
    );
    let passes = Arc::new(AtomicU64::new(0));
    let done = Arc::new(AtomicBool::new(false));
    let worker = {
        let governor = governor.clone();
        let passes = Arc::clone(&passes);
        let done = Arc::clone(&done);
        thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                governor.throttle();
                passes.fetch_add(1, Ordering::Relaxed);
                thread::sleep(Duration::from_millis(1));
            }
        })
    };
    assert!(wait_until(SETTLE, || passes.load(Ordering::Relaxed) > 10));

    governor.pause();
    assert!(governor.snapshot().paused, "the snapshot reports the pause");
    thread::sleep(Duration::from_millis(200));
    let at_200_ms = passes.load(Ordering::Relaxed);
    thread::sleep(Duration::from_millis(200));
    let at_400_ms = passes.load(Ordering::Relaxed);
    assert_eq!(at_200_ms, at_400_ms, "throttle() blocks while paused");

    governor.resume();
    assert!(
        wait_until(Duration::from_millis(500), || passes
            .load(Ordering::Relaxed)
            > at_400_ms),
        "resume() releases throttle()"
    );
    assert!(!governor.snapshot().paused);

    done.store(true, Ordering::Relaxed);
    assert!(worker.join().is_ok());
    governor.stop();
}

#[test]
fn configure_takes_effect_on_the_next_tick() {
    let governor = Governor::start(
        budget(Preset::Balanced),
        false,
        Box::new(idle_sampler()),
        SharedSignals::quiet().boxed(),
    );
    assert!(wait_until(SETTLE, || governor.snapshot().ticks >= 1));
    let balanced = governor.snapshot();
    assert_eq!(balanced.effective, Preset::Balanced);
    assert!(approx(balanced.target_share, 0.50), "{balanced:?}");
    assert_eq!(
        governor.worker_limit(),
        4,
        "balanced on eight cores runs four workers"
    );

    governor.configure(budget(Preset::Eco), false);
    let ticks_before = governor.snapshot().ticks;
    assert!(
        wait_until(TICK * 3, || {
            let s = governor.snapshot();
            s.effective == Preset::Eco && approx(s.target_share, 0.25) && s.workers == 2
        }),
        "eco applies on the next tick: {:?}",
        governor.snapshot()
    );
    assert!(governor.snapshot().ticks <= ticks_before + 3);
    assert_eq!(governor.worker_limit(), 2);

    let turbo_forty = Budget {
        preset: Preset::Turbo,
        cpu_percent: Some(40),
    };
    governor.configure(turbo_forty, false);
    assert!(
        wait_until(TICK * 3, || {
            let s = governor.snapshot();
            s.effective == Preset::Turbo && approx(s.target_share, 0.40) && s.workers == 8
        }),
        "a numeric override applies with its preset: {:?}",
        governor.snapshot()
    );
    assert_eq!(governor.snapshot().budget, turbo_forty);
    assert_eq!(governor.worker_limit(), 8);
    governor.stop();
}

#[test]
fn auto_mode_flips_balanced_to_eco_on_battery_or_heat_and_back() {
    let signals = SharedSignals::quiet();
    let governor = Governor::start(
        budget(Preset::Balanced),
        true,
        Box::new(idle_sampler()),
        signals.boxed(),
    );
    let effective = |governor: &Governor| governor.snapshot().effective;
    let flip_window = TICK * 5;
    assert!(wait_until(SETTLE, || governor.snapshot().ticks >= 1));
    assert_eq!(effective(&governor), Preset::Balanced);

    signals.set(|s| s.on_battery = Some(true));
    assert!(
        wait_until(flip_window, || effective(&governor) == Preset::Eco),
        "battery flips to Eco"
    );
    assert!(
        approx(governor.snapshot().target_share, 0.25),
        "{:?}",
        governor.snapshot()
    );
    signals.set(|s| s.on_battery = Some(false));
    assert!(
        wait_until(flip_window, || effective(&governor) == Preset::Balanced),
        "mains flips back"
    );

    signals.set(|s| s.thermal = Thermal::Serious);
    assert!(
        wait_until(flip_window, || effective(&governor) == Preset::Eco),
        "serious heat flips to Eco"
    );
    signals.set(|s| s.thermal = Thermal::Fair);
    assert!(
        wait_until(flip_window, || effective(&governor) == Preset::Balanced),
        "fair is not pressure"
    );

    signals.set(|s| s.thermal = Thermal::Critical);
    assert!(
        wait_until(flip_window, || {
            let s = governor.snapshot();
            s.effective == Preset::Eco && s.paused
        }),
        "critical heat flips to Eco and pauses: {:?}",
        governor.snapshot()
    );
    signals.set(|s| s.thermal = Thermal::Nominal);
    assert!(
        wait_until(flip_window, || {
            let s = governor.snapshot();
            s.effective == Preset::Balanced && !s.paused
        }),
        "nominal resumes Balanced: {:?}",
        governor.snapshot()
    );

    signals.set(|s| {
        s.thermal = Thermal::Unknown;
        s.on_battery = None;
    });
    thread::sleep(TICK * 3);
    assert_eq!(
        effective(&governor),
        Preset::Balanced,
        "unknown signals are not pressure"
    );

    // Auto means Balanced, whatever preset the budget names.
    governor.configure(budget(Preset::Turbo), true);
    thread::sleep(TICK * 3);
    assert_eq!(
        effective(&governor),
        Preset::Balanced,
        "auto is Balanced, not the budget's preset"
    );

    // Without auto, the battery changes nothing.
    governor.configure(budget(Preset::Balanced), false);
    signals.set(|s| s.on_battery = Some(true));
    thread::sleep(TICK * 3);
    assert_eq!(
        effective(&governor),
        Preset::Balanced,
        "manual budgets ignore the battery"
    );

    // Auto with a numeric override keeps the override across the flip.
    governor.configure(
        Budget {
            preset: Preset::Balanced,
            cpu_percent: Some(30),
        },
        true,
    );
    assert!(
        wait_until(flip_window, || {
            let s = governor.snapshot();
            s.effective == Preset::Eco && approx(s.target_share, 0.30)
        }),
        "the override survives the flip: {:?}",
        governor.snapshot()
    );
    governor.stop();
}

#[test]
fn snapshot_reports_the_effective_preset_the_last_second_share_and_the_mechanisms() {
    let mut sampler = idle_sampler();
    let governor = Governor::start(
        budget(Preset::Eco),
        false,
        Box::new(sampler.clone()),
        SharedSignals::quiet().boxed(),
    );
    let fresh = governor.snapshot();
    assert_eq!(fresh.budget, budget(Preset::Eco));
    assert_eq!(fresh.effective, Preset::Eco);
    assert!(approx(fresh.target_share, 0.25), "{fresh:?}");
    assert!(
        !fresh.mechanisms.qos.available && fresh.mechanisms.qos.reason.is_some(),
        "before any worker ran, nothing was applied and the report says so: {:?}",
        fresh.mechanisms
    );

    sampler.push_cpu(FIFTH_MACHINE_CPU_PER_TICK_S);
    assert!(wait_until(SETTLE, || governor.snapshot().ticks >= 15));
    let s = governor.snapshot();
    assert!(
        (s.share_1s - 0.20).abs() <= 0.05,
        "share_1s tracks the sampler: {s:?}"
    );
    assert_eq!(s.thermal, Thermal::Nominal);
    assert_eq!(s.on_battery, None);
    assert_eq!(s.interacting, None);
    assert!(!s.paused);
    assert!((1..=2).contains(&s.workers), "{s:?}");
    assert!((0.05..=1.0).contains(&s.duty), "{s:?}");

    governor.throttle();
    let applied = governor.snapshot().mechanisms;
    for mechanism in [&applied.qos, &applied.io, &applied.priority] {
        assert!(!mechanism.mechanism.is_empty(), "{mechanism:?}");
        assert_eq!(
            mechanism.available,
            mechanism.reason.is_none(),
            "an unavailable mechanism carries its reason and an available one needs none: {mechanism:?}"
        );
    }
    governor.stop();
}

#[test]
fn stop_ends_the_tick_thread_within_500_ms_and_is_idempotent() {
    let governor = Governor::start(
        budget(Preset::Turbo),
        false,
        Box::new(idle_sampler()),
        SharedSignals::quiet().boxed(),
    );
    assert!(wait_until(SETTLE, || governor.snapshot().ticks >= 3));
    let started = Instant::now();
    governor.stop();
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "stop() joins the tick thread promptly"
    );
    let ticks = governor.snapshot().ticks;
    thread::sleep(TICK * 3);
    assert_eq!(governor.snapshot().ticks, ticks, "no ticks after stop()");
    governor.stop();

    governor.pause();
    let started = Instant::now();
    governor.throttle();
    assert!(
        started.elapsed() < Duration::from_millis(50),
        "a stopped governor governs nothing: throttle() never blocks"
    );
    let twin = governor.clone();
    assert_eq!(twin.snapshot().ticks, ticks, "clones share one governor");
}

#[test]
fn a_missing_machine_share_keeps_the_last_measured_one() {
    // `host_statistics64` publishes new counters about once a second, so most ticks read
    // `None`. `None` is "no new counters yet": the snapshot keeps the last real reading, the
    // loop is neither paused nor reset, and a governor that never gets one never invents one.
    let mut sampler = idle_sampler();
    let governor = Governor::start(
        budget(Preset::Balanced),
        false,
        Box::new(sampler.clone()),
        SharedSignals::quiet().boxed(),
    );
    assert!(wait_until(SETTLE, || governor.snapshot().ticks >= 5));
    assert_eq!(
        governor.snapshot().machine_busy_share,
        None,
        "nothing measured, nothing reported"
    );

    sampler.set_machine(0.6);
    assert!(
        wait_until(SETTLE, || governor
            .snapshot()
            .machine_busy_share
            .is_some_and(|m| approx(m, 0.6))),
        "a real reading shows up: {:?}",
        governor.snapshot()
    );
    let ticks_at_reading = governor.snapshot().ticks;
    sampler.set_machine(None);
    assert!(wait_until(SETTLE, || governor.snapshot().ticks
        >= ticks_at_reading + 10));
    let s = governor.snapshot();
    assert!(
        s.machine_busy_share.is_some_and(|m| approx(m, 0.6)),
        "None means no new counters yet, so the last reading stays: {s:?}"
    );
    assert!(!s.paused, "a missing reading never pauses: {s:?}");
    assert_eq!(
        s.effective,
        Preset::Balanced,
        "a missing reading never reconfigures: {s:?}"
    );
    assert!((0.05..=1.0).contains(&s.duty), "{s:?}");

    sampler.set_machine(0.3);
    assert!(
        wait_until(SETTLE, || governor
            .snapshot()
            .machine_busy_share
            .is_some_and(|m| approx(m, 0.3))),
        "a new reading replaces the old: {:?}",
        governor.snapshot()
    );
    governor.stop();
}

#[test]
fn throttle_honours_the_duty_on_average_despite_stretched_sleeps() {
    // A short sleep takes longer than asked (macOS stretches a 4 ms sleep to ~6 ms; Windows
    // rounds to its 15.6 ms timer). `throttle()` must keep a ledger — sleep what is owed,
    // count what was actually slept — so the duty holds on average and Turbo's 1 ms sleeps
    // do not turn into 15 ms ones. The fake reports exactly the target from the first tick,
    // so the loop rests at the feed-forward duty 0.4 (Balanced at 20% of eight cores).
    const UNIT: Duration = Duration::from_millis(2);
    const UNITS: u32 = 200;
    let mut sampler = FakeSampler::new(CORES);
    sampler.push_cpu(FIFTH_MACHINE_CPU_PER_TICK_S);
    let governor = Governor::start(
        Budget {
            preset: Preset::Balanced,
            cpu_percent: Some(20),
        },
        false,
        Box::new(sampler),
        SharedSignals::quiet().boxed(),
    );
    assert!(wait_until(SETTLE, || governor.snapshot().ticks >= 5));
    let duty_before = governor.snapshot().duty;
    assert!(
        (duty_before - 0.4).abs() < 0.1,
        "the loop rests near the feed-forward duty: {duty_before}"
    );

    governor.throttle();
    let started = Instant::now();
    for _ in 0..UNITS {
        spin_for(UNIT);
        governor.throttle();
    }
    let took = started.elapsed().as_secs_f64();
    let duty = f64::midpoint(duty_before, governor.snapshot().duty);
    let expected = f64::from(UNITS) * UNIT.as_secs_f64() / duty;
    let ratio = took / expected;
    assert!(
        (0.85..=1.15).contains(&ratio),
        "{UNITS} units of {UNIT:?} at duty {duty:.3} should take {expected:.3}s, took {took:.3}s (ratio {ratio:.3})"
    );
    governor.stop();
}

#[test]
fn the_owed_sleep_is_proportional_capped_and_never_negative() {
    // (1 − duty) / duty × work: 19× at the floor, 0 at full duty, capped at one second.
    let work = Duration::from_millis(2);
    assert_eq!(throttle_sleep(work, 0.05), Duration::from_millis(38));
    assert_eq!(
        throttle_sleep(Duration::from_millis(10), 0.5),
        Duration::from_millis(10)
    );
    assert_eq!(throttle_sleep(work, 1.0), Duration::ZERO);
    assert_eq!(
        throttle_sleep(Duration::from_secs(10), 0.05),
        THROTTLE_SLEEP_CAP,
        "capped"
    );
    assert_eq!(
        throttle_sleep(work, 0.0),
        throttle_sleep(work, 0.05),
        "below the floor is the floor"
    );
    assert_eq!(
        throttle_sleep(work, 1.5),
        Duration::ZERO,
        "above full duty is full duty"
    );
    assert_eq!(
        throttle_sleep(work, f64::NAN),
        Duration::ZERO,
        "a NaN duty throttles nothing"
    );
    assert_eq!(
        throttle_sleep(Duration::ZERO, 0.05),
        Duration::ZERO,
        "no work, no sleep"
    );
}

#[test]
fn the_synthetic_load_obeys_the_worker_limit_live() {
    // Eco on a one-core machine allows one worker, and a fake that reports exactly the
    // target keeps its duty at the feed-forward 0.25. Four synthetic threads must therefore
    // complete about a quarter of the ten-millisecond units one unthrottled thread would,
    // not four times as many: only the thread inside the limit may spin.
    const RUN: Duration = Duration::from_secs(2);
    let mut sampler = FakeSampler::new(1);
    sampler.push_cpu(0.025);
    let governor = Governor::start(
        budget(Preset::Eco),
        false,
        Box::new(sampler),
        SharedSignals::quiet().boxed(),
    );
    assert!(wait_until(SETTLE, || governor.snapshot().ticks >= 3));
    assert_eq!(governor.worker_limit(), 1, "{:?}", governor.snapshot());
    let load = SyntheticLoad::start(&governor, 4);
    thread::sleep(RUN);
    let units = load.units_done();
    load.stop();
    governor.stop();
    let one_unthrottled_thread = RUN.as_millis() / 10;
    let allowed = u64::try_from(one_unthrottled_thread / 2).unwrap_or(u64::MAX);
    assert!(
        units < allowed,
        "one worker at duty 0.25 does about {} units in {RUN:?}; {units} means threads outside \
         the limit were spinning",
        one_unthrottled_thread / 4
    );
    assert!(units > 5, "the one allowed worker does run: {units} units");
}

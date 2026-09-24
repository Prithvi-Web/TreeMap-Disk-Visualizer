//! Tests for the governor: the tick thread, `throttle()`, pause/resume, `configure()`,
//! the auto-Eco rule, `snapshot()` and `stop()`. The sampler and the signals are fakes
//! the test keeps steering after the governor owns them; the clock and the threads are real.

use std::hint::black_box;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use tm_governor::controller::{DUTY_MAX, DUTY_MIN, WORKER_CHANGE_TICKS};
use tm_governor::governor::{
    SHARE_WINDOW_TICKS, THROTTLE_CREDIT_CAP, THROTTLE_MIN_SLEEP, THROTTLE_SLEEP_CAP, ledger_charge,
    ledger_settle, throttle_sleep,
};
use tm_governor::{
    Budget, CpuSampler, FakeSampler, FakeSignals, Governor, Preset, Signals, Snapshot,
    SyntheticLoad, Thermal, profile,
};

/// Held by every test in this file, so they run one at a time: beside a test that burns CPU
/// (the synthetic load, the cadence spins) another test's tick thread starves. A fake that
/// scripts a CPU time per reading then reads a late tick as less CPU and a catch-up tick a few
/// milliseconds later as many times the budget, and the duty moves mid-measurement (the macOS
/// CI legs of 23 and 24 Sep 2026: 0.4 fell to 0.25, then rose to 0.6), so a test that needs an
/// exact share holds it against the wall clock instead ([`FakeSampler::hold_share`]).
static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The machine the fakes describe.
const CORES: u32 = 8;
/// The governor's nominal tick.
const TICK: Duration = Duration::from_millis(100);
/// How long a condition may take to appear before a test gives up.
const SETTLE: Duration = Duration::from_secs(3);
/// Ticks, beyond a worker change's, the loop may take to settle after a step in the share.
const SETTLE_TICKS: u64 = 10;
/// How long a test waits for ticks before it calls the tick thread stopped: a guard
/// against hanging, not a measurement.
const TICK_THREAD_ALIVE: Duration = Duration::from_secs(60);
/// Polling interval for `wait_until`.
const POLL: Duration = Duration::from_millis(10);
/// CPU seconds per tick that read as the whole machine even for a tick a busy machine ran
/// minutes late: the share is clamped to one.
const SATURATED_CPU_PER_TICK_S: f64 = 1_000.0;
/// A fifth of the machine, as a share a [`FakeSampler`] holds.
const FIFTH_OF_THE_MACHINE: f64 = 0.2;
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
    let _serial = serial();
    let spin_total = SPIN * UNITS;
    // The ledger keeps back less than one minimum sleep per call, which is all that
    // separates what the duty law owes from what is slept, credit aside.
    let ledger_slack = (THROTTLE_MIN_SLEEP * (UNITS + 1)).as_secs_f64();
    // A charge is rounded to the nanosecond.
    let rounding = f64::from(UNITS) * 1e-9;
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
        approx(full.duty, DUTY_MAX),
        "an idle process is not throttled: {full:?}"
    );
    // What throttle() did is counted, not read off the wall clock: Eco puts this thread at
    // the lowest priority, where a busy machine stretches the work and even the calls (the
    // macOS CI leg of 24 Sep 2026: 262 ms for 100 ms of work at full duty; with every core of
    // this Mac busy, 0.5 to 2.4 s, and single calls of up to 89 ms that slept nothing).
    governor.throttle();
    let before = governor.throttle_totals();
    let unthrottled = cadence(&governor, UNITS);
    let full_duty = governor.throttle_totals().since(before);
    assert!(
        full_duty.worked >= spin_total,
        "throttle() saw the work between its calls: {:?} of {spin_total:?}",
        full_duty.worked
    );
    assert_eq!(
        (full_duty.owed, full_duty.requested, full_duty.slept),
        (Duration::ZERO, Duration::ZERO, Duration::ZERO),
        "at full duty throttle() owes and sleeps nothing ({UNITS} units took {unthrottled:?})"
    );

    // The process now reads as more than the whole machine however late a busy machine runs
    // a tick (half of it, as this test once read, is under Eco's quarter for any tick run
    // twice as late), so the loop cuts the duty to the floor; after WORKER_CHANGE_TICKS
    // ticks there it drops to Eco's fewest workers, which doubles the duty for one tick
    // (measured: that tick inside the measurement left 1.816 s owed where 1.900 s was due).
    // At the floor with the fewest workers nothing can move, and the measurement runs.
    sampler.push_cpu(SATURATED_CPU_PER_TICK_S);
    // Counted in ticks, not seconds: a busy machine runs the ticks late, and every late
    // tick is time the wall clock would charge to the loop.
    let fewest = profile(Preset::Eco, CORES, None).min_workers;
    let settled = |s: &Snapshot| approx(s.duty, DUTY_MIN) && s.workers == fewest;
    let pushed_at = governor.snapshot().ticks;
    let within_ticks = u64::from(WORKER_CHANGE_TICKS) + SETTLE_TICKS;
    assert!(
        wait_until(TICK_THREAD_ALIVE, || {
            let now = governor.snapshot();
            settled(&now) || now.ticks >= pushed_at + within_ticks
        }),
        "the tick thread stopped ticking: {:?}",
        governor.snapshot()
    );
    let now = governor.snapshot();
    assert!(
        settled(&now),
        "within {within_ticks} ticks of the share going over target the duty falls to the \
         floor and the workers to the fewest: {now:?}"
    );
    governor.throttle();
    let duty = governor.snapshot().duty;
    let owed_per_work = (1.0 - duty) / duty;
    let before = governor.throttle_totals();
    let throttled = cadence(&governor, UNITS);
    let at_the_floor = governor.throttle_totals().since(before);
    let after_the_floor = governor.snapshot();
    assert!(
        settled(&after_the_floor),
        "the loop stayed settled through the measurement: {after_the_floor:?}"
    );
    let worked = at_the_floor.worked.as_secs_f64();
    let owed = at_the_floor.owed.as_secs_f64();
    let requested = at_the_floor.requested.as_secs_f64();
    let slept = at_the_floor.slept.as_secs_f64();
    // The duty law, exactly: every unit was at least SPIN of work, and a unit a busy
    // machine stretched owes more, up to the cap on one call.
    let owed_for_the_spins = spin_total.as_secs_f64() * owed_per_work;
    assert!(
        owed >= owed_for_the_spins - rounding && owed <= worked * owed_per_work + rounding,
        "at duty {duty:.3}, {worked:.3}s of work (at least {spin_total:?}) owes between \
         {owed_for_the_spins:.3}s and {:.3}s of sleep, not {owed:.3}s",
        worked * owed_per_work
    );
    // It never asks the OS for more than was owed: the ledger only takes away (a sleep that
    // ran long leaves a credit). What the OS then does to a sleep is the OS's.
    assert!(
        requested <= owed + THROTTLE_MIN_SLEEP.as_secs_f64(),
        "at duty {duty:.3} throttle() owed {owed:.3}s of sleep and asked for {requested:.3}s"
    );
    // And what is owed is slept — an OS that sleeps longer than asked only adds — less the
    // credit an over-long sleep just before may carry in (measured: 162 ms short, after the
    // second-long sleep that follows the drop to the floor).
    let carried_credit = THROTTLE_CREDIT_CAP.as_secs_f64();
    assert!(
        slept >= owed - carried_credit - ledger_slack,
        "at duty {duty:.3} throttle() owed {owed:.3}s of sleep and slept {slept:.3}s \
         ({UNITS} units took {throttled:?})"
    );

    // One call never owes more than the cap, however long the unit of work was: uncapped,
    // a 1.2 s unit at duty 0.05 would owe 22.8 s. It sleeps that second, less any credit;
    // the OS may overrun it.
    thread::sleep(THROTTLE_CAP + Duration::from_millis(200));
    let before = governor.throttle_totals();
    governor.throttle();
    let long_unit = governor.throttle_totals().since(before);
    assert_eq!(
        long_unit.owed, THROTTLE_SLEEP_CAP,
        "a long unit of work ({:?}) at duty {duty} owes the capped second",
        long_unit.worked
    );
    assert!(
        long_unit.requested <= THROTTLE_SLEEP_CAP
            && long_unit.requested >= THROTTLE_SLEEP_CAP.saturating_sub(THROTTLE_CREDIT_CAP),
        "one call asks for the capped second, less any credit, and never more: {:?}",
        long_unit.requested
    );
    assert!(
        long_unit.slept >= THROTTLE_SLEEP_CAP.saturating_sub(THROTTLE_CREDIT_CAP),
        "a long unit of work at duty {duty} sleeps the capped second, less any credit, not {:?}",
        long_unit.slept
    );
    governor.stop();
}

#[test]
fn the_ledger_sleeps_once_a_minimum_is_owed_and_forgives_credit_past_its_cap() {
    let ms = |m: i64| m * 1_000_000;
    let micros = |m: i64| m * 1_000;
    assert_eq!(
        ledger_charge(0, Duration::from_micros(500)),
        (micros(500), Duration::ZERO),
        "less than the minimum is saved up"
    );
    assert_eq!(
        ledger_charge(micros(500), Duration::from_micros(600)),
        (micros(1_100), Duration::from_micros(1_100)),
        "once it reaches the minimum, all of it is slept"
    );
    assert_eq!(
        ledger_charge(-ms(30), Duration::from_millis(38)),
        (ms(8), Duration::from_millis(8)),
        "credit is spent before anything is slept"
    );
    assert_eq!(
        ledger_charge(-ms(50), Duration::from_millis(38)),
        (-ms(12), Duration::ZERO),
        "a credit larger than the charge skips the sleep"
    );
    assert_eq!(
        ledger_charge(ms(900), Duration::from_millis(500)),
        (ms(1_000), THROTTLE_SLEEP_CAP),
        "the balance never passes the cap"
    );
    assert_eq!(
        ledger_settle(ms(38), Duration::from_millis(38)),
        0,
        "an exact sleep"
    );
    assert_eq!(
        ledger_settle(ms(38), Duration::from_millis(40)),
        -ms(2),
        "a sleep that ran long leaves a credit"
    );
    assert_eq!(
        ledger_settle(ms(38), Duration::from_millis(500)),
        -ms(250),
        "credit past its cap is forgiven"
    );
}

#[test]
fn pause_blocks_throttle_within_200_ms_and_resume_releases_it() {
    let _serial = serial();
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
    let _serial = serial();
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
    let _serial = serial();
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
    let _serial = serial();
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

    // Held against the wall clock, so a tick a busy machine runs late reads the same fifth;
    // the window is read once every share in it was measured under the hold (the first
    // reading after the switch covers time before it).
    sampler.hold_share(FIFTH_OF_THE_MACHINE);
    let switched_at = governor.snapshot().ticks;
    let window = u64::try_from(SHARE_WINDOW_TICKS).unwrap_or(u64::MAX);
    assert!(
        wait_until(TICK_THREAD_ALIVE, || governor.snapshot().ticks
            > switched_at + 1 + window),
        "the tick thread stopped ticking: {:?}",
        governor.snapshot()
    );
    let s = governor.snapshot();
    assert!(
        (s.share_1s - FIFTH_OF_THE_MACHINE).abs() <= 0.05,
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
    let _serial = serial();
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
    let _serial = serial();
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
    // A short sleep takes longer than asked (macOS stretches a 4 ms sleep to ~6 ms and a
    // starved thread's by far more; Windows rounds to its 15.6 ms timer). `throttle()` must
    // keep a ledger — charge what the duty owes, sleep it once it is worth a wakeup, credit
    // what the OS over-slept — so the duty holds on average and Turbo's 1 ms sleeps do not
    // turn into 15 ms ones. Every call is checked against the governor's own counters
    // (`ThrottleTotals`) and a replay of the ledger's two steps: the test counts what
    // throttle() did and never times it, so a busy machine's clock cannot fail it (a test
    // that timed 200 units failed 8 of 8 here with every core busy, and its duty check 6 of
    // 6 with the test process at background priority, where a late tick read as less CPU).
    //
    // Balanced at 25% of eight cores rests at the feed-forward duty 0.5 with four workers:
    // clear of both worker-change duties (0.4 and 0.98), so the count cannot move under it.
    const UNIT: Duration = Duration::from_millis(2);
    const UNITS: u32 = 200;
    const TARGET: f64 = 0.25;
    const FEED_FORWARD_DUTY: f64 = 0.5;
    let _serial = serial();
    let mut sampler = FakeSampler::new(CORES);
    sampler.hold_share(TARGET);
    let governor = Governor::start(
        Budget {
            preset: Preset::Balanced,
            cpu_percent: Some(25),
        },
        false,
        Box::new(sampler),
        SharedSignals::quiet().boxed(),
    );
    assert!(
        wait_until(TICK_THREAD_ALIVE, || governor.snapshot().ticks >= 5),
        "the tick thread stopped ticking"
    );

    // A thread's first call starts its ledger and owes nothing.
    governor.throttle();
    let mut ledger_ns: i64 = 0;
    let mut owed_total = Duration::ZERO;
    let mut slept_total = Duration::ZERO;
    let mut forgiven = Duration::ZERO;
    let mut largest_overrun = Duration::ZERO;
    let mut sleeping_calls = 0_u32;
    let mut duties = Vec::new();
    for call in 0..UNITS {
        spin_for(UNIT);
        let before = governor.throttle_totals();
        governor.throttle();
        let did = governor.throttle_totals().since(before);
        // The duty this call charged at, read back from its own charge (owed = work ×
        // (1 − duty) / duty) rather than from a snapshot a tick may have overtaken.
        if did.owed < THROTTLE_SLEEP_CAP {
            let worked = did.worked.as_secs_f64();
            let duty = worked / (worked + did.owed.as_secs_f64());
            assert!(
                (DUTY_MIN - 1e-6..=DUTY_MAX + 1e-6).contains(&duty),
                "call {call}: charged {:?} for {:?} of work, a duty of {duty}",
                did.owed,
                did.worked
            );
            duties.push(duty);
        }
        let (charged, due) = ledger_charge(ledger_ns, did.owed);
        assert_eq!(
            did.requested, due,
            "call {call}: the sleep asked for is the ledger's (balance {ledger_ns} ns, owed {:?})",
            did.owed
        );
        ledger_ns = charged;
        if due.is_zero() {
            assert_eq!(
                did.slept,
                Duration::ZERO,
                "call {call}: nothing asked, nothing slept"
            );
        } else {
            assert!(
                did.slept >= due,
                "call {call}: a sleep never ends early: asked {due:?}, slept {:?}",
                did.slept
            );
            sleeping_calls += 1;
            largest_overrun = largest_overrun.max(did.slept.saturating_sub(due));
            let unforgiven = ledger_ns.saturating_sub(nanos(did.slept));
            ledger_ns = ledger_settle(ledger_ns, did.slept);
            forgiven += Duration::from_nanos(
                u64::try_from(ledger_ns.saturating_sub(unforgiven)).unwrap_or(0),
            );
        }
        owed_total += did.owed;
        slept_total += did.slept;
    }
    governor.stop();
    // The fake holds exactly the target, so the calls charge at the feed-forward duty; the
    // median ignores the odd tick a starved tick thread measured over a stretched interval.
    duties.sort_by(f64::total_cmp);
    let median = duties.get(duties.len() / 2).copied();
    assert!(
        median.is_some_and(|duty| (duty - FEED_FORWARD_DUTY).abs() < 0.02),
        "the calls charge at the duty in force, {FEED_FORWARD_DUTY}: median {median:?} of {} calls",
        duties.len()
    );
    // A credit skips the sleeps after it (with the test process at background priority, 6 of
    // 200 calls slept, each for ~160 ms), so the count of sleeping calls says nothing on its
    // own; the loop must still have slept.
    assert!(sleeping_calls >= 1, "the loop really slept");
    // What it owed and did not sleep is the ledger's last balance, which is below one wakeup
    // (anything larger would have been slept): the loop never under-sleeps on average.
    assert!(
        slept_total + THROTTLE_MIN_SLEEP > owed_total,
        "slept {slept_total:?} of {owed_total:?} owed: the duty was not honoured"
    );
    // Over-sleeps do not add up: in total the loop sleeps what it owed, plus at most the one
    // largest over-run still standing as credit and any credit past the cap it forgave.
    assert!(
        slept_total <= owed_total + largest_overrun + forgiven,
        "slept {slept_total:?} for {owed_total:?} owed (largest over-run {largest_overrun:?}, \
         forgiven {forgiven:?}): over-sleeps accumulated instead of being credited"
    );
}

/// A duration as the ledger's signed nanoseconds.
fn nanos(duration: Duration) -> i64 {
    i64::try_from(duration.as_nanos()).unwrap_or(i64::MAX)
}

#[test]
fn a_held_share_reads_as_that_share_over_any_interval() {
    // A scripted amount per reading reads low over a late tick and high over a catch-up
    // tick; a held share is measured against the wall time between the two readings, so the
    // instants around each reading bound it exactly, however the scheduler spaced them.
    let mut sampler = FakeSampler::new(CORES);
    sampler.hold_share(FIFTH_OF_THE_MACHINE);
    let before_first = Instant::now();
    let first = sampler.own_cpu_seconds();
    let after_first = Instant::now();
    thread::sleep(Duration::from_millis(30));
    let before_second = Instant::now();
    let second = sampler.own_cpu_seconds();
    let after_second = Instant::now();
    assert!(
        approx(first, 0.0),
        "the first reading after the switch adds nothing: {first}"
    );
    let per_second = FIFTH_OF_THE_MACHINE * f64::from(CORES);
    let added = second - first;
    let least = per_second * before_second.duration_since(after_first).as_secs_f64();
    let most = per_second * after_second.duration_since(before_first).as_secs_f64();
    assert!(
        least <= added && added <= most,
        "a fifth of {CORES} cores over the time between the readings: {least}..={most}, read {added}"
    );
    sampler.push_cpu(0.5);
    let third = sampler.own_cpu_seconds();
    assert!(
        approx(third - second, 0.5),
        "push_cpu ends the hold: {}",
        third - second
    );
}

#[test]
fn the_owed_sleep_is_proportional_capped_and_never_negative() {
    let _serial = serial();
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
    // Eco on a one-core machine allows one worker, and a fake holding exactly the target keeps
    // its duty at the feed-forward 0.25. Of four synthetic threads only the one inside the
    // limit may spin: counted per thread, so a busy machine that slows the allowed worker
    // cannot fail the check, and a thread outside the limit cannot hide inside a total (a
    // total over two wall-clock seconds failed 5 of 5 with the test process at background
    // priority, where a late tick read as less CPU and the duty climbed).
    const UNITS_TO_SEE: u64 = 20;
    let _serial = serial();
    let mut sampler = FakeSampler::new(1);
    sampler.hold_share(0.25);
    let governor = Governor::start(
        budget(Preset::Eco),
        false,
        Box::new(sampler),
        SharedSignals::quiet().boxed(),
    );
    assert!(
        wait_until(TICK_THREAD_ALIVE, || governor.snapshot().ticks >= 3),
        "the tick thread stopped ticking"
    );
    assert_eq!(governor.worker_limit(), 1, "{:?}", governor.snapshot());
    let load = SyntheticLoad::start(&governor, 4);
    assert_eq!(load.threads(), 4, "the OS started every synthetic thread");
    let ran = wait_until(TICK_THREAD_ALIVE, || load.units_done() >= UNITS_TO_SEE);
    let by_worker = load.units_by_worker();
    let limit_after = governor.worker_limit();
    load.stop();
    governor.stop();
    assert!(ran, "the one allowed worker does run: {by_worker:?}");
    assert_eq!(
        limit_after, 1,
        "the limit is still one worker: the check below counts against it"
    );
    assert!(
        by_worker
            .first()
            .is_some_and(|&units| units >= UNITS_TO_SEE),
        "worker 0 is inside the limit and did the work: {by_worker:?}"
    );
    assert!(
        by_worker.iter().skip(1).all(|&units| units == 0),
        "threads outside the limit never spun: {by_worker:?}"
    );
}

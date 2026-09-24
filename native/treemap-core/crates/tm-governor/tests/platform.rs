//! Platform tests for the sampler, the signals and the enforcement mechanisms.
//!
//! The pure parsers run on every platform; the live tests measure the machine
//! the test runs on and print what they saw, so the numbers in a report are
//! numbers that were measured, never assumed.

use std::hint::black_box;
use std::thread;
use std::time::{Duration, Instant};

use tm_governor::sample::{CpuTicks, fold_reading, parse_proc_stat, proc_stat_busy_share};
use tm_governor::signals::{
    THERMAL_CRITICAL_C, THERMAL_FAIR_C, THERMAL_SERIOUS_C, ac_from_estimate,
    on_battery_from_status, thermal_from_millidegrees, thermal_from_zone_text,
};
use tm_governor::{
    Mechanism, Preset, Thermal, apply_to_current_thread, capabilities, platform_sampler,
    platform_signals, profile,
};

/// Two `/proc/stat` readings 1,700 ticks apart: 1,000 busy (600 user + 400
/// system) and 700 idle (600 idle + 100 iowait).
const PROC_STAT_BEFORE: &str = "cpu  1000 100 500 8000 200 10 20 0 0 0\n\
cpu0 500 50 250 4000 100 5 10 0 0 0\n\
intr 12345 0 1\n\
ctxt 999\n";
const PROC_STAT_AFTER: &str = "cpu  1600 100 900 8600 300 10 20 0 0 0\n\
cpu0 800 50 450 4300 150 5 10 0 0 0\n\
intr 12399 0 1\n\
ctxt 1010\n";
/// The busy share those two readings describe.
const EXPECTED_BUSY_SHARE: f64 = 1000.0 / 1700.0;
/// An OS may publish its machine CPU counters only about once a second (macOS
/// does), so the live test waits up to this long for a reading to arrive.
const MACHINE_SHARE_DEADLINE: Duration = Duration::from_millis(2500);
/// How often the live test asks again while waiting.
const MACHINE_SHARE_POLL: Duration = Duration::from_millis(10);
/// The CPU time the live test spins for, as the sampler reports it.
const SPIN_CPU_S: f64 = 0.010;
/// One stretch of spinning between two readings of the sampler.
const SPIN_STEP: Duration = Duration::from_millis(5);
/// How long the live test may spin before a sampler that never grows fails it.
const SPIN_DEADLINE: Duration = Duration::from_secs(10);
/// The CPU time an OS may charge late, per core: Windows charges it in whole
/// 15.6 ms clock ticks.
const CHARGE_GRANULARITY_S: f64 = 0.016;

/// Burn CPU on the calling thread for `wall` without sleeping.
fn spin_for(wall: Duration) {
    let started = Instant::now();
    let mut x: u64 = 0;
    while started.elapsed() < wall {
        x = x
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        black_box(x);
    }
}

/// The contract every `Mechanism` keeps: it is named, and it is unavailable
/// exactly when it carries a reason.
fn assert_honest(m: &Mechanism) {
    assert!(!m.mechanism.is_empty(), "a mechanism must be named: {m:?}");
    assert_eq!(
        m.available,
        m.reason.is_none(),
        "unavailable means a reason, available means none: {m:?}"
    );
}

#[cfg(target_os = "macos")]
mod thread_state {
    //! Reads the calling thread's QoS class and disk I/O policy straight from
    //! the OS, independently of the crate under test.

    unsafe extern "C" {
        fn getiopolicy_np(iotype: libc::c_int, scope: libc::c_int) -> libc::c_int;
    }
    const IOPOL_TYPE_DISK: libc::c_int = 0;
    const IOPOL_SCOPE_THREAD: libc::c_int = 1;

    /// `(qos class raw value, relative priority, disk I/O policy)`.
    pub fn read() -> (u32, i32, i32) {
        let mut class: u32 = 0;
        let mut relative: libc::c_int = 0;
        // SAFETY: pthread_self() names the calling thread; both out-pointers
        // point at live locals; qos_class_t is repr(u32), so a u32 slot has the
        // right size and alignment and reading the raw number avoids
        // materialising an enum value the OS did not promise.
        let rc = unsafe {
            libc::pthread_get_qos_class_np(
                libc::pthread_self(),
                (&raw mut class).cast::<libc::qos_class_t>(),
                &raw mut relative,
            )
        };
        assert_eq!(rc, 0, "pthread_get_qos_class_np failed with {rc}");
        // SAFETY: getiopolicy_np takes two plain integers and returns the
        // policy, or -1 with errno set.
        let io = unsafe { getiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_THREAD) };
        (class, relative, io)
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod thread_state {
    //! Reads the calling thread's nice value straight from the OS.

    /// `(nice value, errno after the read)`.
    pub fn read() -> (i32, i32) {
        // SAFETY: getpriority takes plain integers; `who` 0 is the caller.
        let nice = unsafe { libc::getpriority(libc::PRIO_PROCESS, 0) };
        let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        (nice, errno)
    }
}

#[cfg(windows)]
mod thread_state {
    //! Reads the calling thread's scheduling priority straight from the OS.

    use windows_sys::Win32::System::Threading::{GetCurrentThread, GetThreadPriority};

    /// The thread priority value, or `i32::MAX` when the call failed.
    pub fn read() -> i32 {
        // SAFETY: GetCurrentThread returns a pseudo-handle that is always valid
        // for the calling thread; GetThreadPriority only reads it.
        unsafe { GetThreadPriority(GetCurrentThread()) }
    }
}

#[test]
fn proc_stat_busy_share_is_parsed_from_two_readings() {
    let share = proc_stat_busy_share(PROC_STAT_BEFORE, PROC_STAT_AFTER).unwrap_or(f64::NAN);
    assert!(
        (share - EXPECTED_BUSY_SHARE).abs() < 1e-12,
        "expected {EXPECTED_BUSY_SHARE}, got {share}"
    );

    let parsed = parse_proc_stat(PROC_STAT_BEFORE);
    assert!(parsed.is_some(), "the aggregate cpu line must parse");

    assert!(
        proc_stat_busy_share(PROC_STAT_BEFORE, PROC_STAT_BEFORE).is_none(),
        "no elapsed ticks means no share, not a fabricated one"
    );
    assert!(
        proc_stat_busy_share(PROC_STAT_AFTER, PROC_STAT_BEFORE).is_none(),
        "counters that went backwards mean no share"
    );
}

#[test]
fn a_garbled_proc_stat_line_yields_no_share() {
    const GARBLED: &str = "cpu  1000 abc 500 8000 200 10 20 0 0 0\ncpu0 1 2 3 4\n";
    const TOO_SHORT: &str = "cpu  1000 100 500\n";
    const NO_AGGREGATE: &str = "cpu0 500 50 250 4000 100 5 10 0 0 0\nintr 1\n";

    assert!(
        parse_proc_stat(GARBLED).is_none(),
        "a non-numeric field is garbage"
    );
    assert!(
        parse_proc_stat(TOO_SHORT).is_none(),
        "fewer than four counters is garbage"
    );
    assert!(
        parse_proc_stat(NO_AGGREGATE).is_none(),
        "per-core lines are not the aggregate"
    );
    assert!(
        parse_proc_stat("").is_none(),
        "an empty file is not a reading"
    );

    assert!(proc_stat_busy_share(GARBLED, PROC_STAT_AFTER).is_none());
    assert!(proc_stat_busy_share(PROC_STAT_BEFORE, GARBLED).is_none());
}

#[test]
fn a_reading_without_new_ticks_keeps_the_baseline() {
    let first = CpuTicks {
        busy: 100,
        idle: 900,
    };
    let (baseline, share) = fold_reading(None, first);
    assert_eq!(
        (baseline, share),
        (Some(first), None),
        "the first reading only sets the baseline"
    );

    let (baseline, share) = fold_reading(baseline, first);
    assert_eq!(
        (baseline, share),
        (Some(first), None),
        "unchanged counters keep the baseline and give no share"
    );

    let later = CpuTicks {
        busy: 150,
        idle: 950,
    };
    let (baseline, share) = fold_reading(baseline, later);
    assert_eq!(baseline, Some(later), "advanced counters move the baseline");
    let share = share.unwrap_or(f64::NAN);
    assert!(
        (share - 0.5).abs() < 1e-12,
        "50 busy of 100 elapsed ticks is 0.5, got {share}"
    );

    let reset = CpuTicks { busy: 10, idle: 20 };
    let (baseline, share) = fold_reading(baseline, reset);
    assert_eq!(
        (baseline, share),
        (Some(reset), None),
        "counters that went backwards restart the baseline"
    );
}

#[test]
fn linux_power_supply_status_is_parsed() {
    assert_eq!(on_battery_from_status("Discharging\n"), Some(true));
    assert_eq!(on_battery_from_status("Charging\n"), Some(false));
    assert_eq!(on_battery_from_status("Full"), Some(false));
    assert_eq!(on_battery_from_status("Not charging\n"), Some(false));
    assert_eq!(
        on_battery_from_status(""),
        None,
        "a missing status is not a guess"
    );
    assert_eq!(on_battery_from_status("Unknown\n"), None);
    assert_eq!(on_battery_from_status("garbage"), None);
}

/// The thresholds must be ordered, or the mapping below has no meaning; the
/// compiler checks it.
const _: () = assert!(
    THERMAL_FAIR_C < THERMAL_SERIOUS_C && THERMAL_SERIOUS_C < THERMAL_CRITICAL_C,
    "the thermal thresholds must be ordered"
);

#[test]
fn linux_thermal_zone_temperatures_map_to_states() {
    assert!(matches!(
        thermal_from_zone_text("45000\n"),
        Thermal::Nominal
    ));
    assert!(matches!(thermal_from_zone_text("75000\n"), Thermal::Fair));
    assert!(matches!(
        thermal_from_zone_text("85000\n"),
        Thermal::Serious
    ));
    assert!(matches!(thermal_from_zone_text("95000"), Thermal::Critical));
    assert!(matches!(
        thermal_from_zone_text("-5000\n"),
        Thermal::Nominal
    ));
    assert!(matches!(
        thermal_from_zone_text("garbage\n"),
        Thermal::Unknown
    ));
    assert!(matches!(thermal_from_zone_text(""), Thermal::Unknown));

    let millidegrees = |celsius: i64| celsius * 1000;
    assert!(matches!(
        thermal_from_millidegrees(millidegrees(THERMAL_FAIR_C) - 1),
        Thermal::Nominal
    ));
    assert!(matches!(
        thermal_from_millidegrees(millidegrees(THERMAL_FAIR_C)),
        Thermal::Fair
    ));
    assert!(matches!(
        thermal_from_millidegrees(millidegrees(THERMAL_SERIOUS_C) - 1),
        Thermal::Fair
    ));
    assert!(matches!(
        thermal_from_millidegrees(millidegrees(THERMAL_SERIOUS_C)),
        Thermal::Serious
    ));
    assert!(matches!(
        thermal_from_millidegrees(millidegrees(THERMAL_CRITICAL_C) - 1),
        Thermal::Serious
    ));
    assert!(matches!(
        thermal_from_millidegrees(millidegrees(THERMAL_CRITICAL_C)),
        Thermal::Critical
    ));
}

#[test]
fn ac_from_estimate_maps_only_unlimited_to_ac() {
    assert!(
        ac_from_estimate(-2.0),
        "kIOPSTimeRemainingUnlimited means AC power"
    );
    assert!(
        !ac_from_estimate(-1.0),
        "kIOPSTimeRemainingUnknown means on battery"
    );
    assert!(
        !ac_from_estimate(0.0),
        "an empty battery is still a battery"
    );
    assert!(
        !ac_from_estimate(3600.0),
        "an hour remaining means on battery"
    );
    assert!(!ac_from_estimate(f64::NAN), "not a number is not AC");
}

#[test]
fn the_platform_sampler_reports_this_machines_cores_and_advances() {
    let expected_cores =
        thread::available_parallelism().map_or(1, |n| u32::try_from(n.get()).unwrap_or(u32::MAX));

    let mut sampler = platform_sampler();
    assert_eq!(
        sampler.cores(),
        expected_cores,
        "cores must be what std sees"
    );

    // Spin until the sampler shows the CPU time, however long the machine keeps this thread
    // waiting: a spin is wall time, and a busy machine can give it none (the Windows CI leg
    // of 24 Sep 2026: a 50 ms spin read 0.046875 -> 0.046875).
    let before = sampler.own_cpu_seconds();
    let spun_from = Instant::now();
    let mut after = before;
    while after - before < SPIN_CPU_S && spun_from.elapsed() < SPIN_DEADLINE {
        spin_for(SPIN_STEP);
        after = sampler.own_cpu_seconds();
    }
    let spun = spun_from.elapsed().as_secs_f64();
    assert!(
        after - before >= SPIN_CPU_S,
        "own CPU must grow while this thread spins: {before} -> {after} after {spun:.3} s"
    );
    // Seconds, not a larger unit: no process uses more than every core for the whole time.
    let most = f64::from(expected_cores) * (spun + CHARGE_GRANULARITY_S);
    assert!(
        after - before <= most,
        "{:.3} CPU seconds in {spun:.3} s on {expected_cores} cores is more than the machine has",
        after - before
    );

    // The OS may publish the machine counters only about once a second, so
    // wait for the next publication instead of assuming one fell in the spin.
    let started_waiting = Instant::now();
    let mut machine = sampler.machine_busy_share();
    while machine.is_none() && started_waiting.elapsed() < MACHINE_SHARE_DEADLINE {
        thread::sleep(MACHINE_SHARE_POLL);
        machine = sampler.machine_busy_share();
    }
    let waited = started_waiting.elapsed();
    let caps = capabilities();
    if let Some(share) = machine {
        assert!(
            (0.0..=1.0).contains(&share),
            "a share is in 0..=1, got {share}"
        );
        assert!(
            caps.machine_cpu.available,
            "a measured share means an available mechanism"
        );
    } else {
        assert!(
            !caps.machine_cpu.available,
            "no share means the mechanism says why"
        );
        assert!(caps.machine_cpu.reason.is_some());
    }
    #[cfg(target_os = "macos")]
    assert!(
        machine.is_some(),
        "macOS publishes host CPU ticks about once a second, but none arrived within {MACHINE_SHARE_DEADLINE:?}"
    );

    println!(
        "live sampler: cores={} own_cpu_before={before:.4}s own_cpu_after={after:.4}s machine_busy_share={machine:?} (arrived after {waited:?}) via {}",
        sampler.cores(),
        caps.machine_cpu.mechanism
    );
}

#[test]
fn capabilities_never_change_the_calling_thread() {
    let before = thread_state::read();
    let caps = capabilities();
    let after = thread_state::read();
    assert_eq!(
        before, after,
        "probing must leave the calling thread untouched"
    );

    let all = [
        &caps.qos,
        &caps.io_policy,
        &caps.priority,
        &caps.thermal,
        &caps.battery,
        &caps.interaction,
        &caps.machine_cpu,
    ];
    for mechanism in all {
        assert_honest(mechanism);
    }
    println!("live capabilities: {caps:#?}");
}

#[test]
fn apply_to_current_thread_reports_what_it_did() {
    let cores = 8;
    let eco = apply_to_current_thread(&profile(Preset::Eco, cores, None));
    assert_honest(&eco.qos);
    assert_honest(&eco.io);
    assert_honest(&eco.priority);
    println!("live enforce (eco): {eco:#?}");

    #[cfg(target_os = "macos")]
    {
        const QOS_CLASS_BACKGROUND: u32 = 0x09;
        const QOS_CLASS_UTILITY: u32 = 0x11;
        const QOS_CLASS_USER_INITIATED: u32 = 0x19;
        /// No explicit per-thread disk policy: a thread-scope `setiopolicy_np`
        /// would opt the thread out of the QoS system for good, so the crate
        /// must never set one, and the class alone carries the I/O tier.
        const IOPOL_DEFAULT: i32 = 0;

        assert!(eco.qos.available, "{:?}", eco.qos);
        assert_eq!(eco.qos.mechanism, "pthread_set_qos_class_self_np");
        assert!(eco.io.available, "{:?}", eco.io);
        assert_eq!(eco.io.mechanism, "QoS carries the disk I/O tier on macOS");
        assert_eq!(eco.priority.mechanism, "QoS carries priority on macOS");
        assert_eq!(eco.priority.available, eco.qos.available);
        let (class, _, io) = thread_state::read();
        assert_eq!(
            class, QOS_CLASS_BACKGROUND,
            "Eco must really move the thread to Background"
        );
        assert_eq!(
            io, IOPOL_DEFAULT,
            "no thread I/O policy may ever be set beside QoS"
        );

        let balanced = apply_to_current_thread(&profile(Preset::Balanced, cores, None));
        assert!(
            balanced.qos.available && balanced.io.available,
            "{balanced:?}"
        );
        let (class, _, io) = thread_state::read();
        assert_eq!(
            class, QOS_CLASS_UTILITY,
            "Balanced must really move the thread to Utility"
        );
        assert_eq!(io, IOPOL_DEFAULT);

        let turbo = apply_to_current_thread(&profile(Preset::Turbo, cores, None));
        assert!(turbo.qos.available && turbo.io.available, "{turbo:?}");
        let (class, _, io) = thread_state::read();
        assert_eq!(
            class, QOS_CLASS_USER_INITIATED,
            "Turbo must really move the thread to User-initiated"
        );
        assert_eq!(io, IOPOL_DEFAULT);

        let again = apply_to_current_thread(&profile(Preset::Eco, cores, None));
        assert!(
            again.qos.available,
            "a thread must be able to move down again: {again:?}"
        );
        let (class, _, _) = thread_state::read();
        assert_eq!(class, QOS_CLASS_BACKGROUND);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let turbo = apply_to_current_thread(&profile(Preset::Turbo, cores, None));
        assert_honest(&turbo.qos);
        assert_honest(&turbo.io);
        assert_honest(&turbo.priority);
    }
}

#[test]
fn signals_are_never_a_confident_guess() {
    let mut signals = platform_signals();
    let caps = capabilities();

    let thermal = signals.thermal();
    let on_battery = signals.on_battery();
    let interacting = signals.interacting();

    assert_eq!(
        caps.thermal.available,
        !matches!(thermal, Thermal::Unknown),
        "a thermal state is reported exactly when the mechanism is available: {thermal:?} vs {:?}",
        caps.thermal
    );
    assert_eq!(
        caps.battery.available,
        on_battery.is_some(),
        "a power source is reported exactly when the mechanism is available: {:?}",
        caps.battery
    );
    assert_eq!(
        caps.interaction.available,
        interacting.is_some(),
        "interaction is reported exactly when the mechanism is available: {:?}",
        caps.interaction
    );

    #[cfg(target_os = "macos")]
    {
        assert!(
            matches!(
                thermal,
                Thermal::Nominal | Thermal::Fair | Thermal::Serious | Thermal::Critical
            ),
            "macOS always has a thermal state, got {thermal:?}"
        );
        assert!(on_battery.is_some(), "IOKit always knows the power source");
    }
    #[cfg(windows)]
    {
        assert!(
            matches!(thermal, Thermal::Unknown),
            "Windows has no thermal state"
        );
        assert!(on_battery.is_some(), "GetSystemPowerStatus always answers");
    }
    #[cfg(target_os = "linux")]
    {
        assert!(
            interacting.is_none(),
            "Linux has no portable input-idle source"
        );
        assert!(caps.interaction.reason.is_some());
    }

    #[cfg(target_os = "macos")]
    let idle = tm_governor::signals::seconds_since_last_input();
    #[cfg(not(target_os = "macos"))]
    let idle: Option<f64> = None;
    println!(
        "live signals: thermal={thermal:?} on_battery={on_battery:?} interacting={interacting:?} seconds_since_last_input={idle:?}"
    );
}

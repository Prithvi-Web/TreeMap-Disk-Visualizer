//! Enforcement: what the OS lets a thread do to hold a budget, and what it did.
//!
//! [`capabilities`] probes every mechanism without changing anything;
//! [`apply_to_current_thread`] gives the calling thread a preset's QoS class,
//! I/O policy and priority and reports, mechanism by mechanism, whether the OS
//! took it. A mechanism the platform lacks is reported as unavailable with the
//! reason in plain words; nothing is defaulted silently.

use serde::Serialize;

use crate::preset::PresetProfile;

/// One OS mechanism: whether it is usable here and, when it is not, why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Mechanism {
    /// Whether the mechanism worked (or, from [`capabilities`], is usable).
    pub available: bool,
    /// The OS call or source the mechanism is made of.
    pub mechanism: String,
    /// Why it is unavailable, in plain words; `None` when it is available.
    pub reason: Option<String>,
}

impl Mechanism {
    /// A mechanism that is usable.
    pub fn available(mechanism: impl Into<String>) -> Self {
        Self {
            available: true,
            mechanism: mechanism.into(),
            reason: None,
        }
    }

    /// A mechanism that is not usable, and why.
    pub fn unavailable(mechanism: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            available: false,
            mechanism: mechanism.into(),
            reason: Some(reason.into()),
        }
    }

    /// A mechanism from the outcome of trying it.
    pub fn from_outcome(mechanism: impl Into<String>, outcome: Result<(), String>) -> Self {
        match outcome {
            Ok(()) => Self::available(mechanism),
            Err(reason) => Self::unavailable(mechanism, reason),
        }
    }
}

/// What this machine can do, mechanism by mechanism. Probed, never applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Per-thread scheduling class (QoS on macOS, power throttling on Windows,
    /// `SCHED_BATCH` on Linux).
    pub qos: Mechanism,
    /// Per-thread disk I/O priority.
    pub io_policy: Mechanism,
    /// Per-thread scheduling priority.
    pub priority: Mechanism,
    /// The machine's thermal state.
    pub thermal: Mechanism,
    /// Whether the machine runs on battery.
    pub battery: Mechanism,
    /// Whether the user is interacting.
    pub interaction: Mechanism,
    /// The whole machine's CPU busy share.
    pub machine_cpu: Mechanism,
}

/// What [`apply_to_current_thread`] did to the calling thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EnforceReport {
    /// The scheduling class.
    pub qos: Mechanism,
    /// The disk I/O policy.
    pub io: Mechanism,
    /// The scheduling priority.
    pub priority: Mechanism,
}

/// Probes every mechanism on the running platform. Reads only; the calling
/// thread is left exactly as it was.
pub fn capabilities() -> Capabilities {
    platform::capabilities()
}

/// Gives the calling thread the profile's QoS class, I/O policy and priority
/// and reports what the OS accepted.
pub fn apply_to_current_thread(profile: &PresetProfile) -> EnforceReport {
    platform::apply(profile)
}

/// The last OS error as text, e.g. "Operation not permitted (os error 1)".
#[cfg(any(windows, target_os = "linux"))]
fn last_os_error() -> String {
    std::io::Error::last_os_error().to_string()
}

#[cfg(target_os = "macos")]
mod platform {
    //! macOS: one mechanism, the QoS class, carries all three effects.
    //!
    //! The class sets the scheduling tier and priority, and XNU derives the
    //! thread's disk I/O tier from it (`qos_iotier` in `thread_policy.c`):
    //! Background gets the tier `IOPOL_THROTTLE` selects, Utility the tier
    //! `IOPOL_UTILITY` selects, and User-initiated the default tier. The
    //! per-thread `setiopolicy_np(IOPOL_SCOPE_THREAD, ...)` call is
    //! deliberately not used: measured on macOS 27, it opts the calling thread
    //! out of the QoS system for good (`pthread_get_qos_class_np` reports
    //! `QOS_CLASS_UNSPECIFIED` afterwards and every later
    //! `pthread_set_qos_class_self_np` returns `EPERM`), so the two cannot be
    //! combined on one thread and the class is the one that also covers I/O.

    use libc::{c_int, qos_class_t};

    use super::{Capabilities, EnforceReport, Mechanism};
    use crate::controller::Thermal;
    use crate::preset::{PresetProfile, QosClass};
    use crate::sample::platform::probe_host_ticks;
    use crate::signals::on_battery_from_estimate;
    use crate::signals::platform::{
        seconds_since_last_input, thermal_state, time_remaining_estimate,
    };

    const QOS_MECHANISM: &str = "pthread_set_qos_class_self_np";
    const IO_MECHANISM: &str = "QoS carries the disk I/O tier on macOS";
    const PRIORITY_MECHANISM: &str = "QoS carries priority on macOS";
    const THERMAL_MECHANISM: &str = "NSProcessInfo.thermalState";
    const BATTERY_MECHANISM: &str = "IOPSGetTimeRemainingEstimate";
    const INTERACTION_MECHANISM: &str = "CGEventSourceSecondsSinceLastEventType";
    const MACHINE_CPU_MECHANISM: &str = "host_statistics64(HOST_CPU_LOAD_INFO)";

    fn qos_class(qos: QosClass) -> qos_class_t {
        match qos {
            QosClass::Background => qos_class_t::QOS_CLASS_BACKGROUND,
            QosClass::Utility => qos_class_t::QOS_CLASS_UTILITY,
            QosClass::UserInitiated => qos_class_t::QOS_CLASS_USER_INITIATED,
        }
    }

    /// The calling thread's QoS class as a raw number, or the error code.
    fn current_qos_class() -> Result<u32, c_int> {
        let mut class: u32 = 0;
        let mut relative: c_int = 0;
        // SAFETY: pthread_self() names the calling thread; both out-pointers
        // refer to live locals; qos_class_t is repr(u32), so a u32 slot has the
        // right size and alignment, and reading the raw number avoids
        // materialising an enum value the OS did not promise.
        let rc = unsafe {
            libc::pthread_get_qos_class_np(
                libc::pthread_self(),
                (&raw mut class).cast::<qos_class_t>(),
                &raw mut relative,
            )
        };
        if rc == 0 { Ok(class) } else { Err(rc) }
    }

    /// Priority and the I/O tier on macOS are whatever the QoS class implies,
    /// so each is exactly as available as the QoS mechanism.
    fn carried_by_qos(mechanism: &str, qos: &Mechanism) -> Mechanism {
        Mechanism {
            available: qos.available,
            mechanism: mechanism.to_owned(),
            reason: qos.reason.clone(),
        }
    }

    fn error_text(code: c_int) -> String {
        std::io::Error::from_raw_os_error(code).to_string()
    }

    pub fn capabilities() -> Capabilities {
        let qos = match current_qos_class() {
            Ok(_) => Mechanism::available(QOS_MECHANISM),
            Err(code) => Mechanism::unavailable(
                QOS_MECHANISM,
                format!("pthread_get_qos_class_np failed: {}", error_text(code)),
            ),
        };
        let io_policy = carried_by_qos(IO_MECHANISM, &qos);
        let priority = carried_by_qos(PRIORITY_MECHANISM, &qos);
        let thermal = match thermal_state() {
            Thermal::Unknown => Mechanism::unavailable(
                THERMAL_MECHANISM,
                "NSProcessInfo reported a thermal state this build does not know",
            ),
            _ => Mechanism::available(THERMAL_MECHANISM),
        };
        let battery = if on_battery_from_estimate(time_remaining_estimate()).is_some() {
            Mechanism::available(BATTERY_MECHANISM)
        } else {
            Mechanism::unavailable(BATTERY_MECHANISM, "IOKit returned no power-source estimate")
        };
        let interaction = if seconds_since_last_input().is_some() {
            Mechanism::available(INTERACTION_MECHANISM)
        } else {
            Mechanism::unavailable(
                INTERACTION_MECHANISM,
                "CoreGraphics returned no input-idle time; this process may have no window server session",
            )
        };
        let machine_cpu = match probe_host_ticks() {
            Ok(()) => Mechanism::available(MACHINE_CPU_MECHANISM),
            Err(rc) => Mechanism::unavailable(
                MACHINE_CPU_MECHANISM,
                format!("host_statistics64 returned kern_return {rc}"),
            ),
        };
        Capabilities {
            qos,
            io_policy,
            priority,
            thermal,
            battery,
            interaction,
            machine_cpu,
        }
    }

    pub fn apply(profile: &PresetProfile) -> EnforceReport {
        // SAFETY: a valid class with relative priority 0; only the calling
        // thread is affected.
        let rc = unsafe { libc::pthread_set_qos_class_self_np(qos_class(profile.qos), 0) };
        let qos = if rc == 0 {
            Mechanism::available(QOS_MECHANISM)
        } else {
            let mut reason = format!("pthread_set_qos_class_self_np refused: {}", error_text(rc));
            if rc == libc::EPERM {
                reason.push_str(
                    "; a thread that once set a scheduler policy or a thread I/O policy is permanently outside the QoS system",
                );
            }
            Mechanism::unavailable(QOS_MECHANISM, reason)
        };
        let io = carried_by_qos(IO_MECHANISM, &qos);
        let priority = carried_by_qos(PRIORITY_MECHANISM, &qos);
        EnforceReport { qos, io, priority }
    }
}

#[cfg(windows)]
mod platform {
    //! Windows: thread priority and background mode, plus power throttling
    //! (EcoQoS) for the Eco preset. There is no thermal state.

    use std::cell::Cell;

    use windows_sys::Win32::System::Threading::{
        GetCurrentThread, GetThreadInformation, GetThreadPriority, SetThreadInformation,
        SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN, THREAD_MODE_BACKGROUND_END,
        THREAD_POWER_THROTTLING_CURRENT_VERSION, THREAD_POWER_THROTTLING_EXECUTION_SPEED,
        THREAD_POWER_THROTTLING_STATE, THREAD_PRIORITY_BELOW_NORMAL, THREAD_PRIORITY_NORMAL,
        ThreadPowerThrottling,
    };

    use super::{Capabilities, EnforceReport, Mechanism, last_os_error};
    use crate::preset::{IoClass, PresetProfile, QosClass};
    use crate::sample::platform::read_system_ticks;
    use crate::signals::platform::{NO_THERMAL_REASON, ac_line_status, idle_milliseconds};

    /// `THREAD_PRIORITY_ERROR_RETURN`: what `GetThreadPriority` returns on
    /// failure (declared here because it lives in a feature this crate does
    /// not enable).
    const THREAD_PRIORITY_ERROR_RETURN: i32 = i32::MAX;
    /// `ACLineStatus` value for "Windows does not know".
    const AC_LINE_STATUS_UNKNOWN: u8 = 255;

    const QOS_MECHANISM: &str = "SetThreadInformation(ThreadPowerThrottling)";
    const IO_MECHANISM: &str =
        "SetThreadPriority(THREAD_MODE_BACKGROUND_BEGIN) lowers I/O priority";
    const PRIORITY_MECHANISM: &str = "SetThreadPriority";
    const THERMAL_MECHANISM: &str = "thermal state";
    const BATTERY_MECHANISM: &str = "GetSystemPowerStatus";
    const INTERACTION_MECHANISM: &str = "GetLastInputInfo";
    const MACHINE_CPU_MECHANISM: &str = "GetSystemTimes";

    thread_local! {
        /// Whether this thread entered background mode, which must be ended
        /// explicitly and cannot be entered twice.
        static IN_BACKGROUND_MODE: Cell<bool> = const { Cell::new(false) };
    }

    fn struct_size<T>() -> u32 {
        u32::try_from(size_of::<T>()).unwrap_or(u32::MAX)
    }

    fn power_throttling_state(qos: QosClass) -> THREAD_POWER_THROTTLING_STATE {
        let (control, state) = match qos {
            // Force EcoQoS on.
            QosClass::Background => (
                THREAD_POWER_THROTTLING_EXECUTION_SPEED,
                THREAD_POWER_THROTTLING_EXECUTION_SPEED,
            ),
            // Let Windows decide.
            QosClass::Utility | QosClass::UserInitiated => (0, 0),
        };
        THREAD_POWER_THROTTLING_STATE {
            Version: THREAD_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask: control,
            StateMask: state,
        }
    }

    fn set_power_throttling(qos: QosClass) -> Result<(), String> {
        let state = power_throttling_state(qos);
        // SAFETY: GetCurrentThread's pseudo-handle is always valid for the
        // calling thread; the pointer and size describe a live
        // THREAD_POWER_THROTTLING_STATE owned by this frame.
        let ok = unsafe {
            SetThreadInformation(
                GetCurrentThread(),
                ThreadPowerThrottling,
                (&raw const state).cast(),
                struct_size::<THREAD_POWER_THROTTLING_STATE>(),
            )
        };
        if ok != 0 {
            Ok(())
        } else {
            Err(last_os_error())
        }
    }

    fn set_thread_priority(priority: i32) -> Result<(), String> {
        // SAFETY: GetCurrentThread's pseudo-handle is always valid for the
        // calling thread; the priority is one of the documented values.
        let ok = unsafe { SetThreadPriority(GetCurrentThread(), priority) };
        if ok != 0 {
            Ok(())
        } else {
            Err(last_os_error())
        }
    }

    /// Enters or leaves background mode and sets the priority the class asks for.
    fn set_priority(qos: QosClass) -> Result<(), String> {
        match qos {
            QosClass::Background => {
                if !IN_BACKGROUND_MODE.get() {
                    set_thread_priority(THREAD_MODE_BACKGROUND_BEGIN)?;
                    IN_BACKGROUND_MODE.set(true);
                }
                Ok(())
            }
            QosClass::Utility | QosClass::UserInitiated => {
                if IN_BACKGROUND_MODE.get() {
                    set_thread_priority(THREAD_MODE_BACKGROUND_END)?;
                    IN_BACKGROUND_MODE.set(false);
                }
                let priority = if matches!(qos, QosClass::Utility) {
                    THREAD_PRIORITY_BELOW_NORMAL
                } else {
                    THREAD_PRIORITY_NORMAL
                };
                set_thread_priority(priority)
            }
        }
    }

    fn io_report(io: IoClass, priority: &Mechanism) -> Mechanism {
        match io {
            IoClass::Throttle => Mechanism {
                available: priority.available,
                mechanism: IO_MECHANISM.to_owned(),
                reason: priority.reason.clone(),
            },
            IoClass::Utility => Mechanism::unavailable(
                IO_MECHANISM,
                "Windows has no per-thread I/O priority between normal and background, so Balanced runs its I/O at normal priority",
            ),
            IoClass::Normal => Mechanism {
                available: priority.available,
                mechanism:
                    "SetThreadPriority(THREAD_MODE_BACKGROUND_END) restores normal I/O priority"
                        .to_owned(),
                reason: priority.reason.clone(),
            },
        }
    }

    pub fn capabilities() -> Capabilities {
        let mut state = THREAD_POWER_THROTTLING_STATE {
            Version: THREAD_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask: 0,
            StateMask: 0,
        };
        // SAFETY: GetCurrentThread's pseudo-handle is always valid for the
        // calling thread; the pointer and size describe a live, writable
        // THREAD_POWER_THROTTLING_STATE owned by this frame. This only reads.
        let ok = unsafe {
            GetThreadInformation(
                GetCurrentThread(),
                ThreadPowerThrottling,
                (&raw mut state).cast(),
                struct_size::<THREAD_POWER_THROTTLING_STATE>(),
            )
        };
        let qos = if ok != 0 {
            Mechanism::available(QOS_MECHANISM)
        } else {
            Mechanism::unavailable(
                QOS_MECHANISM,
                format!(
                    "GetThreadInformation(ThreadPowerThrottling) failed: {}; power throttling needs Windows 10 version 1709 or later",
                    last_os_error()
                ),
            )
        };
        // SAFETY: GetCurrentThread's pseudo-handle is always valid for the
        // calling thread; GetThreadPriority only reads it.
        let current = unsafe { GetThreadPriority(GetCurrentThread()) };
        let priority = if current == THREAD_PRIORITY_ERROR_RETURN {
            Mechanism::unavailable(
                PRIORITY_MECHANISM,
                format!("GetThreadPriority failed: {}", last_os_error()),
            )
        } else {
            Mechanism::available(PRIORITY_MECHANISM)
        };
        let io_policy = Mechanism {
            available: priority.available,
            mechanism: IO_MECHANISM.to_owned(),
            reason: priority.reason.clone(),
        };
        let thermal = Mechanism::unavailable(THERMAL_MECHANISM, NO_THERMAL_REASON);
        let battery = match ac_line_status() {
            Some(AC_LINE_STATUS_UNKNOWN) => Mechanism::unavailable(
                BATTERY_MECHANISM,
                "GetSystemPowerStatus reported the AC line status as unknown",
            ),
            Some(_) => Mechanism::available(BATTERY_MECHANISM),
            None => Mechanism::unavailable(
                BATTERY_MECHANISM,
                format!("GetSystemPowerStatus failed: {}", last_os_error()),
            ),
        };
        let interaction = if idle_milliseconds().is_some() {
            Mechanism::available(INTERACTION_MECHANISM)
        } else {
            Mechanism::unavailable(
                INTERACTION_MECHANISM,
                format!(
                    "GetLastInputInfo failed: {}; this may not be an interactive session",
                    last_os_error()
                ),
            )
        };
        let machine_cpu = if read_system_ticks().is_some() {
            Mechanism::available(MACHINE_CPU_MECHANISM)
        } else {
            Mechanism::unavailable(
                MACHINE_CPU_MECHANISM,
                format!("GetSystemTimes failed: {}", last_os_error()),
            )
        };
        Capabilities {
            qos,
            io_policy,
            priority,
            thermal,
            battery,
            interaction,
            machine_cpu,
        }
    }

    pub fn apply(profile: &PresetProfile) -> EnforceReport {
        let qos = Mechanism::from_outcome(QOS_MECHANISM, set_power_throttling(profile.qos));
        let priority = Mechanism::from_outcome(PRIORITY_MECHANISM, set_priority(profile.qos));
        let io = io_report(profile.io, &priority);
        EnforceReport { qos, io, priority }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    //! Linux: `SCHED_BATCH`, `ioprio_set` and nice values, all per thread.

    use libc::{c_int, c_long};

    use super::{Capabilities, EnforceReport, Mechanism, last_os_error};
    use crate::preset::{IoClass, PresetProfile, QosClass};
    use crate::sample::platform::read_proc_stat_ticks;
    use crate::signals::platform::{
        NO_INTERACTION_REASON, POWER_SUPPLY_ROOT, THERMAL_ROOT, battery_on_battery,
        hottest_zone_millidegrees,
    };

    // From <linux/ioprio.h>; libc does not declare these.
    /// The class occupies the bits above the level.
    const IOPRIO_CLASS_SHIFT: c_long = 13;
    /// No explicit class: the kernel derives one from the nice value.
    const IOPRIO_CLASS_NONE: c_long = 0;
    /// Best effort, levels 0 (highest) to 7 (lowest).
    const IOPRIO_CLASS_BE: c_long = 2;
    /// Only when the disk is otherwise idle.
    const IOPRIO_CLASS_IDLE: c_long = 3;
    /// The lowest best-effort level.
    const IOPRIO_BE_LOWEST: c_long = 7;
    /// `who` names one thread (or the caller when it is 0).
    const IOPRIO_WHO_PROCESS: c_long = 1;
    /// `who` 0: the calling thread.
    const CALLING_THREAD: c_long = 0;
    // From <sched.h>; libc does not declare these for linux-gnu.
    /// The default time-sharing policy.
    const SCHED_OTHER: c_int = 0;
    /// Time-sharing for batch work: the same share, fewer pre-emptions.
    const SCHED_BATCH: c_int = 3;
    /// Nice values per class; an unprivileged thread can raise its nice value
    /// but never lower it again, so these stay modest.
    const NICE_BACKGROUND: c_int = 10;
    const NICE_UTILITY: c_int = 5;
    const NICE_USER_INITIATED: c_int = 0;

    const QOS_MECHANISM: &str = "sched_setscheduler(SCHED_BATCH)";
    const IO_MECHANISM: &str = "ioprio_set";
    const PRIORITY_MECHANISM: &str = "setpriority";
    const THERMAL_MECHANISM: &str = "/sys/class/thermal/thermal_zone*/temp";
    const BATTERY_MECHANISM: &str = "/sys/class/power_supply/*/status";
    const INTERACTION_MECHANISM: &str = "input idle time";
    const MACHINE_CPU_MECHANISM: &str = "/proc/stat";

    const fn ioprio_value(class: c_long, level: c_long) -> c_long {
        (class << IOPRIO_CLASS_SHIFT) | level
    }

    fn ioprio_for(io: IoClass) -> c_long {
        match io {
            IoClass::Throttle => ioprio_value(IOPRIO_CLASS_IDLE, 0),
            IoClass::Utility => ioprio_value(IOPRIO_CLASS_BE, IOPRIO_BE_LOWEST),
            IoClass::Normal => ioprio_value(IOPRIO_CLASS_NONE, 0),
        }
    }

    fn set_ioprio(io: IoClass) -> Result<(), String> {
        // SAFETY: ioprio_set takes three plain integers; `who` 0 is the
        // calling thread, so nothing else is touched.
        let rc = unsafe {
            libc::syscall(
                libc::SYS_ioprio_set,
                IOPRIO_WHO_PROCESS,
                CALLING_THREAD,
                ioprio_for(io),
            )
        };
        if rc == 0 {
            Ok(())
        } else {
            Err(last_os_error())
        }
    }

    fn scheduler_policy(qos: QosClass) -> c_int {
        match qos {
            QosClass::Background | QosClass::Utility => SCHED_BATCH,
            QosClass::UserInitiated => SCHED_OTHER,
        }
    }

    fn set_scheduler(qos: QosClass) -> Result<(), String> {
        let param = libc::sched_param { sched_priority: 0 };
        // SAFETY: pid 0 is the calling thread; `param` is a live sched_param
        // carrying the only priority these policies accept.
        let rc = unsafe { libc::sched_setscheduler(0, scheduler_policy(qos), &raw const param) };
        if rc == 0 {
            Ok(())
        } else {
            Err(last_os_error())
        }
    }

    fn nice_for(qos: QosClass) -> c_int {
        match qos {
            QosClass::Background => NICE_BACKGROUND,
            QosClass::Utility => NICE_UTILITY,
            QosClass::UserInitiated => NICE_USER_INITIATED,
        }
    }

    /// The calling thread's nice value, or the OS error text.
    fn current_nice() -> Result<c_int, String> {
        // SAFETY: __errno_location returns a valid pointer to this thread's
        // errno, which getpriority needs cleared because -1 is a valid nice.
        unsafe {
            *libc::__errno_location() = 0;
        }
        // SAFETY: plain integers; `who` 0 is the calling thread.
        let nice = unsafe { libc::getpriority(libc::PRIO_PROCESS, 0) };
        let error = std::io::Error::last_os_error();
        if nice == -1 && error.raw_os_error().is_some_and(|code| code != 0) {
            Err(error.to_string())
        } else {
            Ok(nice)
        }
    }

    fn set_nice(qos: QosClass) -> Result<(), String> {
        let wanted = nice_for(qos);
        if current_nice()? == wanted {
            return Ok(());
        }
        // SAFETY: plain integers; `who` 0 is the calling thread.
        let rc = unsafe { libc::setpriority(libc::PRIO_PROCESS, 0, wanted) };
        if rc == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        let mut reason = error.to_string();
        if error.raw_os_error() == Some(libc::EACCES) {
            reason.push_str(
                "; Linux lets an unprivileged thread raise its nice value but never lower it again, so a thread that ran Eco cannot return to a higher budget",
            );
        }
        Err(reason)
    }

    pub fn capabilities() -> Capabilities {
        // SAFETY: pid 0 is the calling thread; the call only reads.
        let policy = unsafe { libc::sched_getscheduler(0) };
        let qos = if policy >= 0 {
            Mechanism::available(QOS_MECHANISM)
        } else {
            Mechanism::unavailable(
                QOS_MECHANISM,
                format!("sched_getscheduler failed: {}", last_os_error()),
            )
        };
        // SAFETY: ioprio_get takes two plain integers; `who` 0 is the caller.
        let ioprio =
            unsafe { libc::syscall(libc::SYS_ioprio_get, IOPRIO_WHO_PROCESS, CALLING_THREAD) };
        let io_policy = if ioprio >= 0 {
            Mechanism::available(IO_MECHANISM)
        } else {
            Mechanism::unavailable(
                IO_MECHANISM,
                format!("ioprio_get failed: {}", last_os_error()),
            )
        };
        let priority = match current_nice() {
            Ok(_) => Mechanism::available(PRIORITY_MECHANISM),
            Err(reason) => {
                Mechanism::unavailable(PRIORITY_MECHANISM, format!("getpriority failed: {reason}"))
            }
        };
        let thermal = if hottest_zone_millidegrees().is_some() {
            Mechanism::available(THERMAL_MECHANISM)
        } else {
            Mechanism::unavailable(
                THERMAL_MECHANISM,
                format!("no readable thermal zone under {THERMAL_ROOT}"),
            )
        };
        let battery = if battery_on_battery().is_some() {
            Mechanism::available(BATTERY_MECHANISM)
        } else {
            Mechanism::unavailable(
                BATTERY_MECHANISM,
                format!("no battery with a readable status under {POWER_SUPPLY_ROOT}"),
            )
        };
        let interaction = Mechanism::unavailable(INTERACTION_MECHANISM, NO_INTERACTION_REASON);
        let machine_cpu = if read_proc_stat_ticks().is_some() {
            Mechanism::available(MACHINE_CPU_MECHANISM)
        } else {
            Mechanism::unavailable(MACHINE_CPU_MECHANISM, "/proc/stat is unreadable or garbled")
        };
        Capabilities {
            qos,
            io_policy,
            priority,
            thermal,
            battery,
            interaction,
            machine_cpu,
        }
    }

    pub fn apply(profile: &PresetProfile) -> EnforceReport {
        EnforceReport {
            qos: Mechanism::from_outcome(QOS_MECHANISM, set_scheduler(profile.qos)),
            io: Mechanism::from_outcome(IO_MECHANISM, set_ioprio(profile.io)),
            priority: Mechanism::from_outcome(PRIORITY_MECHANISM, set_nice(profile.qos)),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod platform {
    //! Any other OS: every mechanism is reported as unavailable.

    use super::{Capabilities, EnforceReport, Mechanism};
    use crate::preset::PresetProfile;

    const REASON: &str = "not implemented on this platform";

    fn none(mechanism: &str) -> Mechanism {
        Mechanism::unavailable(mechanism, REASON)
    }

    pub fn capabilities() -> Capabilities {
        Capabilities {
            qos: none("scheduling class"),
            io_policy: none("I/O policy"),
            priority: none("priority"),
            thermal: none("thermal state"),
            battery: none("power source"),
            interaction: none("input idle time"),
            machine_cpu: none("machine CPU"),
        }
    }

    pub fn apply(_profile: &PresetProfile) -> EnforceReport {
        EnforceReport {
            qos: none("scheduling class"),
            io: none("I/O policy"),
            priority: none("priority"),
        }
    }
}

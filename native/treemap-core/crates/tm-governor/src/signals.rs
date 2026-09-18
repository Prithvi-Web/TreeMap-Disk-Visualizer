//! The machine's signals: thermal pressure, power source and user interaction.
//!
//! [`platform_signals`] returns the reader for the running OS and
//! [`FakeSignals`] holds whatever a test wants the governor to see. A platform
//! reader that cannot answer says `None` (or [`Thermal::Unknown`]); it never
//! guesses, and [`crate::enforce::capabilities`] says why it could not answer.

use crate::controller::Thermal;

/// Reads the signals that scale or pause the budget.
pub trait Signals: Send {
    /// The machine's thermal pressure; `Unknown` when the OS does not say.
    fn thermal(&mut self) -> Thermal;
    /// `Some(true)` on battery, `Some(false)` on external power, `None` when
    /// the OS does not say.
    fn on_battery(&mut self) -> Option<bool>;
    /// `Some(true)` when the user touched the keyboard, mouse or tablet within
    /// [`INTERACTION_WINDOW_S`]; `None` when the OS does not say.
    fn interacting(&mut self) -> Option<bool>;
}

/// The signal reader for the running platform.
pub fn platform_signals() -> Box<dyn Signals> {
    Box::new(platform::PlatformSignals)
}

/// Scripted signals for tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FakeSignals {
    /// What `thermal()` returns.
    pub thermal: Thermal,
    /// What `on_battery()` returns.
    pub on_battery: Option<bool>,
    /// What `interacting()` returns.
    pub interacting: Option<bool>,
}

impl Default for FakeSignals {
    /// A quiet desktop: nominal thermals, and nothing known about power or input.
    fn default() -> Self {
        Self {
            thermal: Thermal::Nominal,
            on_battery: None,
            interacting: None,
        }
    }
}

impl Signals for FakeSignals {
    fn thermal(&mut self) -> Thermal {
        self.thermal
    }

    fn on_battery(&mut self) -> Option<bool> {
        self.on_battery
    }

    fn interacting(&mut self) -> Option<bool> {
        self.interacting
    }
}

/// Input within this many seconds means the user is interacting.
pub const INTERACTION_WINDOW_S: f64 = 2.0;

/// Maps seconds since the last input event to "interacting". A negative or
/// non-numeric idle time is not a reading.
pub fn interacting_from_idle_seconds(seconds: f64) -> Option<bool> {
    (seconds.is_finite() && seconds >= 0.0).then_some(seconds < INTERACTION_WINDOW_S)
}

/// `kIOPSTimeRemainingUnlimited`: the machine is on AC or another external source.
pub const IOPS_TIME_REMAINING_UNLIMITED: f64 = -2.0;
/// `kIOPSTimeRemainingUnknown`: on battery, but the estimate is not ready yet.
pub const IOPS_TIME_REMAINING_UNKNOWN: f64 = -1.0;

/// Whether an `IOPSGetTimeRemainingEstimate` result means external power:
/// only the exact `kIOPSTimeRemainingUnlimited` sentinel does. `-1.0` (still
/// estimating) and any number of seconds both mean the battery is in use.
pub fn ac_from_estimate(estimate: f64) -> bool {
    estimate.to_bits() == IOPS_TIME_REMAINING_UNLIMITED.to_bits()
}

/// Maps an `IOPSGetTimeRemainingEstimate` result to "on battery"; a
/// non-numeric estimate is not a reading.
pub fn on_battery_from_estimate(estimate: f64) -> Option<bool> {
    (!estimate.is_nan()).then_some(!ac_from_estimate(estimate))
}

/// Parses a Linux `/sys/class/power_supply/*/status` file. "Discharging"
/// means on battery; "Charging", "Full" and "Not charging" mean external
/// power; anything else (including "Unknown" and an empty file) is not a
/// reading.
pub fn on_battery_from_status(status: &str) -> Option<bool> {
    match status.trim() {
        "Discharging" => Some(true),
        "Charging" | "Full" | "Not charging" => Some(false),
        _ => None,
    }
}

/// Maps a Windows `SYSTEM_POWER_STATUS.ACLineStatus` byte: 0 is offline (on
/// battery), 1 is online, and 255 means Windows does not know.
pub fn on_battery_from_ac_line_status(status: u8) -> Option<bool> {
    match status {
        0 => Some(true),
        1 => Some(false),
        _ => None,
    }
}

/// Milliseconds between a `GetTickCount` reading and `LASTINPUTINFO.dwTime`,
/// both of which wrap every 49.7 days.
pub fn idle_millis(now_ticks: u32, last_input_ticks: u32) -> u32 {
    now_ticks.wrapping_sub(last_input_ticks)
}

/// From this temperature up, a Linux thermal zone reads as `Fair`.
pub const THERMAL_FAIR_C: i64 = 70;
/// From this temperature up, a Linux thermal zone reads as `Serious`.
pub const THERMAL_SERIOUS_C: i64 = 80;
/// From this temperature up, a Linux thermal zone reads as `Critical`.
pub const THERMAL_CRITICAL_C: i64 = 90;
/// Linux thermal zones report thousandths of a degree Celsius.
pub const MILLIDEGREES_PER_DEGREE: i64 = 1000;

/// Maps a thermal zone temperature to a state using the thresholds above.
pub fn thermal_from_millidegrees(millidegrees: i64) -> Thermal {
    let celsius = millidegrees.div_euclid(MILLIDEGREES_PER_DEGREE);
    if celsius >= THERMAL_CRITICAL_C {
        Thermal::Critical
    } else if celsius >= THERMAL_SERIOUS_C {
        Thermal::Serious
    } else if celsius >= THERMAL_FAIR_C {
        Thermal::Fair
    } else {
        Thermal::Nominal
    }
}

/// Parses the text of a `/sys/class/thermal/thermal_zone*/temp` file; anything
/// that is not a whole number of millidegrees is `Unknown`.
pub fn thermal_from_zone_text(text: &str) -> Thermal {
    text.trim()
        .parse::<i64>()
        .map_or(Thermal::Unknown, thermal_from_millidegrees)
}

#[cfg(target_os = "macos")]
pub use platform::seconds_since_last_input;

#[cfg(target_os = "macos")]
pub(crate) mod platform {
    //! macOS: NSProcessInfo for thermals, IOKit for power, CoreGraphics for input.

    use objc2_foundation::{NSProcessInfo, NSProcessInfoThermalState};

    use super::{Signals, interacting_from_idle_seconds, on_battery_from_estimate};
    use crate::controller::Thermal;

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        /// Seconds until every battery is empty; `-2.0` on unlimited (external)
        /// power, `-1.0` while the estimate is being calculated on battery.
        fn IOPSGetTimeRemainingEstimate() -> f64;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        /// Seconds since the last event of `event_type` in the event source
        /// `state_id` was seen.
        fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
    }

    /// `kCGEventSourceStateCombinedSessionState`: every process in the login session.
    const CG_COMBINED_SESSION_STATE: i32 = 0;
    /// `kCGAnyInputEventType`: keyboard, mouse or tablet, whichever came last.
    const CG_ANY_INPUT_EVENT_TYPE: u32 = u32::MAX;

    /// The thermal state NSProcessInfo reports, or `Unknown` for a value this
    /// build does not know.
    pub fn thermal_state() -> Thermal {
        let state = NSProcessInfo::processInfo().thermalState();
        if state == NSProcessInfoThermalState::Nominal {
            Thermal::Nominal
        } else if state == NSProcessInfoThermalState::Fair {
            Thermal::Fair
        } else if state == NSProcessInfoThermalState::Serious {
            Thermal::Serious
        } else if state == NSProcessInfoThermalState::Critical {
            Thermal::Critical
        } else {
            Thermal::Unknown
        }
    }

    /// IOKit's raw time-remaining estimate; see [`super::ac_from_estimate`].
    pub fn time_remaining_estimate() -> f64 {
        // SAFETY: the call has no preconditions and returns a plain double.
        unsafe { IOPSGetTimeRemainingEstimate() }
    }

    /// Seconds since the user last touched the keyboard, mouse or tablet, or
    /// `None` when CoreGraphics returns something that is not an idle time.
    pub fn seconds_since_last_input() -> Option<f64> {
        // SAFETY: the call takes two plain integers and returns a plain double.
        let seconds = unsafe {
            CGEventSourceSecondsSinceLastEventType(
                CG_COMBINED_SESSION_STATE,
                CG_ANY_INPUT_EVENT_TYPE,
            )
        };
        (seconds.is_finite() && seconds >= 0.0).then_some(seconds)
    }

    /// The macOS signal reader.
    pub struct PlatformSignals;

    impl Signals for PlatformSignals {
        fn thermal(&mut self) -> Thermal {
            thermal_state()
        }

        fn on_battery(&mut self) -> Option<bool> {
            on_battery_from_estimate(time_remaining_estimate())
        }

        fn interacting(&mut self) -> Option<bool> {
            seconds_since_last_input().and_then(interacting_from_idle_seconds)
        }
    }
}

#[cfg(target_os = "linux")]
pub(crate) mod platform {
    //! Linux: sysfs thermal zones and power supplies; no input-idle source.

    use std::fs;
    use std::path::Path;

    use super::{Signals, on_battery_from_status, thermal_from_millidegrees};
    use crate::controller::Thermal;

    /// Where the kernel publishes thermal zones.
    pub const THERMAL_ROOT: &str = "/sys/class/thermal";
    /// Where the kernel publishes batteries and adapters.
    pub const POWER_SUPPLY_ROOT: &str = "/sys/class/power_supply";
    /// Why interaction is never reported on Linux.
    pub const NO_INTERACTION_REASON: &str = "no portable input-idle source on Linux";

    /// The hottest readable `thermal_zone*/temp`, in millidegrees; `None`
    /// when no zone reads as a number.
    pub fn hottest_zone_millidegrees() -> Option<i64> {
        hottest_zone_millidegrees_under(Path::new(THERMAL_ROOT))
    }

    fn hottest_zone_millidegrees_under(root: &Path) -> Option<i64> {
        fs::read_dir(root)
            .ok()?
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("thermal_zone")
            })
            .filter_map(|entry| fs::read_to_string(entry.path().join("temp")).ok())
            .filter_map(|text| text.trim().parse::<i64>().ok())
            .max()
    }

    /// The hottest zone mapped to a state; `Unknown` when no zone reads.
    pub fn hottest_zone_thermal() -> Thermal {
        hottest_zone_millidegrees().map_or(Thermal::Unknown, thermal_from_millidegrees)
    }

    /// `Some(true)` when any battery is discharging, `Some(false)` when every
    /// battery with a readable status is charging or full, `None` when there
    /// is no battery or none of them says.
    pub fn battery_on_battery() -> Option<bool> {
        battery_on_battery_under(Path::new(POWER_SUPPLY_ROOT))
    }

    fn battery_on_battery_under(root: &Path) -> Option<bool> {
        let statuses: Vec<bool> = fs::read_dir(root)
            .ok()?
            .flatten()
            .filter(|entry| {
                fs::read_to_string(entry.path().join("type"))
                    .is_ok_and(|kind| kind.trim() == "Battery")
            })
            .filter_map(|entry| fs::read_to_string(entry.path().join("status")).ok())
            .filter_map(|status| on_battery_from_status(&status))
            .collect();
        (!statuses.is_empty()).then(|| statuses.into_iter().any(|discharging| discharging))
    }

    /// The Linux signal reader.
    pub struct PlatformSignals;

    impl Signals for PlatformSignals {
        fn thermal(&mut self) -> Thermal {
            hottest_zone_thermal()
        }

        fn on_battery(&mut self) -> Option<bool> {
            battery_on_battery()
        }

        fn interacting(&mut self) -> Option<bool> {
            None
        }
    }
}

#[cfg(windows)]
pub(crate) mod platform {
    //! Windows: the power status and the last input tick; no thermal state.

    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use windows_sys::Win32::System::SystemInformation::GetTickCount64;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    use super::{
        Signals, idle_millis, interacting_from_idle_seconds, on_battery_from_ac_line_status,
    };
    use crate::controller::Thermal;

    /// Why thermals are never reported on Windows.
    pub const NO_THERMAL_REASON: &str = "Windows exposes no thermal state to user processes";
    const MILLISECONDS_PER_SECOND: f64 = 1000.0;

    /// The raw `ACLineStatus` byte, or `None` when `GetSystemPowerStatus` fails.
    pub fn ac_line_status() -> Option<u8> {
        let mut status = SYSTEM_POWER_STATUS {
            ACLineStatus: 0,
            BatteryFlag: 0,
            BatteryLifePercent: 0,
            SystemStatusFlag: 0,
            BatteryLifeTime: 0,
            BatteryFullLifeTime: 0,
        };
        // SAFETY: the pointer refers to a live, writable SYSTEM_POWER_STATUS
        // owned by this frame.
        let ok = unsafe { GetSystemPowerStatus(&raw mut status) };
        (ok != 0).then_some(status.ACLineStatus)
    }

    /// Milliseconds since the last input event, or `None` when
    /// `GetLastInputInfo` fails (for example outside an interactive session).
    pub fn idle_milliseconds() -> Option<u32> {
        let mut info = LASTINPUTINFO {
            cbSize: u32::try_from(size_of::<LASTINPUTINFO>()).unwrap_or(0),
            dwTime: 0,
        };
        // SAFETY: cbSize carries the struct's size as the API requires and the
        // pointer refers to a live, writable LASTINPUTINFO owned by this frame.
        let ok = unsafe { GetLastInputInfo(&raw mut info) };
        if ok == 0 {
            return None;
        }
        // SAFETY: GetTickCount64 has no preconditions.
        let now = unsafe { GetTickCount64() };
        let now_low = u32::try_from(now & u64::from(u32::MAX)).unwrap_or(0);
        Some(idle_millis(now_low, info.dwTime))
    }

    /// The Windows signal reader.
    pub struct PlatformSignals;

    impl Signals for PlatformSignals {
        fn thermal(&mut self) -> Thermal {
            Thermal::Unknown
        }

        fn on_battery(&mut self) -> Option<bool> {
            ac_line_status().and_then(on_battery_from_ac_line_status)
        }

        fn interacting(&mut self) -> Option<bool> {
            idle_milliseconds()
                .map(|millis| f64::from(millis) / MILLISECONDS_PER_SECOND)
                .and_then(interacting_from_idle_seconds)
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub(crate) mod platform {
    //! Any other OS: nothing is read, and nothing is invented.

    use super::Signals;
    use crate::controller::Thermal;

    /// A reader that knows nothing.
    pub struct PlatformSignals;

    impl Signals for PlatformSignals {
        fn thermal(&mut self) -> Thermal {
            Thermal::Unknown
        }

        fn on_battery(&mut self) -> Option<bool> {
            None
        }

        fn interacting(&mut self) -> Option<bool> {
            None
        }
    }
}

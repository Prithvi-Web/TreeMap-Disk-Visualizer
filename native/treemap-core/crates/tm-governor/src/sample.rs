//! CPU sampling: this process's own CPU time and the whole machine's busy share.
//!
//! [`platform_sampler`] returns the sampler for the running OS and
//! [`FakeSampler`] replays a script for tests. Every number a platform sampler
//! returns was read from the OS; when the OS does not answer, the sampler says
//! `None` and [`crate::enforce::capabilities`] says why.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;

/// Reads CPU time. The governor's tick thread owns one of these.
pub trait CpuSampler: Send {
    /// Total CPU seconds (user plus system) this process has consumed so far.
    fn own_cpu_seconds(&mut self) -> f64;
    /// The share of all cores that were busy since the previous reading that
    /// carried new counters, in `0..=1`. `None` when the OS has not published
    /// new counters since then (macOS publishes its host CPU ticks about once
    /// a second) or does not expose them at all. The baseline is kept until
    /// new counters arrive, so no interval is lost and none is invented.
    fn machine_busy_share(&mut self) -> Option<f64>;
    /// The logical cores the shares are normalised against.
    fn cores(&self) -> u32;
}

/// The sampler for the running platform, with its first machine reading taken.
pub fn platform_sampler() -> Box<dyn CpuSampler> {
    Box::new(platform::PlatformSampler::new())
}

/// The logical core count as std sees it; 1 when std cannot tell.
pub fn logical_cores() -> u32 {
    thread::available_parallelism().map_or(1, |n| u32::try_from(n.get()).unwrap_or(u32::MAX))
}

/// CPU ticks split into busy and idle. Either cumulative counters read from
/// the OS or the difference between two such readings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CpuTicks {
    /// Ticks spent running something.
    pub busy: u64,
    /// Ticks spent idle (on Linux, waiting for I/O counts as idle).
    pub idle: u64,
}

/// The busy share of one interval's ticks: `busy / (busy + idle)`.
/// `None` when nothing elapsed.
pub fn busy_share_of(delta: CpuTicks) -> Option<f64> {
    let total = delta.busy.checked_add(delta.idle)?;
    if total == 0 {
        return None;
    }
    Some(delta.busy as f64 / total as f64)
}

/// The busy share between two cumulative readings. `None` when nothing
/// elapsed or a counter went backwards.
pub fn busy_share_between(before: CpuTicks, after: CpuTicks) -> Option<f64> {
    busy_share_of(CpuTicks {
        busy: after.busy.checked_sub(before.busy)?,
        idle: after.idle.checked_sub(before.idle)?,
    })
}

/// Folds a fresh cumulative reading into a sampler's baseline and returns the
/// new baseline with the busy share since the old one:
/// * no baseline yet: the reading becomes the baseline, no share;
/// * the counters advanced: the share, and the reading becomes the baseline;
/// * the counters did not move (the OS has not published new ticks yet): no
///   share; the reading equals the baseline, so the next share covers the
///   whole span since the last publication;
/// * a counter went backwards (a reset): no share, the reading becomes the
///   baseline.
pub fn fold_reading(baseline: Option<CpuTicks>, now: CpuTicks) -> (Option<CpuTicks>, Option<f64>) {
    let Some(before) = baseline else {
        return (Some(now), None);
    };
    if now.busy < before.busy || now.idle < before.idle {
        return (Some(now), None);
    }
    match busy_share_between(before, now) {
        Some(share) => (Some(now), Some(share)),
        None => (Some(before), None),
    }
}

/// The counters an aggregate `/proc/stat` cpu line carries, in order.
const PROC_STAT_COUNTERS: usize = 8;
/// The counters that must be present for the line to mean anything:
/// user, nice, system and idle.
const PROC_STAT_REQUIRED_COUNTERS: usize = 4;

/// Parses the aggregate `cpu` line of `/proc/stat` into cumulative ticks.
///
/// Busy is user + nice + system + irq + softirq + steal; idle is idle + iowait.
/// The guest counters are already included in user and nice, so they are
/// ignored. `None` when the aggregate line is missing, carries fewer than
/// four counters, or one of its first eight counters is not a number.
pub fn parse_proc_stat(text: &str) -> Option<CpuTicks> {
    let line = text
        .lines()
        .find(|line| line.starts_with("cpu ") || line.starts_with("cpu\t"))?;
    let mut fields = line.split_ascii_whitespace().skip(1);
    let mut counters = [0_u64; PROC_STAT_COUNTERS];
    let mut present = 0;
    for slot in &mut counters {
        match fields.next() {
            Some(field) => {
                *slot = field.parse().ok()?;
                present += 1;
            }
            None => break,
        }
    }
    if present < PROC_STAT_REQUIRED_COUNTERS {
        return None;
    }
    let [user, nice, system, idle, iowait, irq, softirq, steal] = counters;
    let busy = [user, nice, system, irq, softirq, steal]
        .into_iter()
        .try_fold(0_u64, u64::checked_add)?;
    Some(CpuTicks {
        busy,
        idle: idle.checked_add(iowait)?,
    })
}

/// The machine's busy share between two `/proc/stat` snapshots.
pub fn proc_stat_busy_share(before: &str, after: &str) -> Option<f64> {
    busy_share_between(parse_proc_stat(before)?, parse_proc_stat(after)?)
}

/// A scripted sampler for tests.
///
/// [`push_cpu`](Self::push_cpu) appends one reading's worth of CPU time to the
/// script. Every [`own_cpu_seconds`](CpuSampler::own_cpu_seconds) call consumes
/// the next entry and adds it to the running total; once the script is used
/// up the last entry repeats, so a single push is a steady rate. Clones share
/// the script, so a test can keep scripting a sampler it has already handed to
/// a governor.
#[derive(Debug, Clone)]
pub struct FakeSampler {
    shared: Arc<Mutex<FakeState>>,
}

#[derive(Debug)]
struct FakeState {
    cores: u32,
    total_cpu_s: f64,
    script: VecDeque<f64>,
    last_step_s: f64,
    machine: Option<f64>,
}

impl FakeSampler {
    /// A sampler for a machine with `cores` logical cores, no CPU used yet and
    /// no machine share.
    pub fn new(cores: u32) -> Self {
        Self {
            shared: Arc::new(Mutex::new(FakeState {
                cores,
                total_cpu_s: 0.0,
                script: VecDeque::new(),
                last_step_s: 0.0,
                machine: None,
            })),
        }
    }

    /// Scripts `seconds` of CPU time for the next reading (and, once the script
    /// runs out, for every reading after it).
    pub fn push_cpu(&mut self, seconds: f64) {
        self.state().script.push_back(seconds);
    }

    /// Sets the machine busy share every reading reports; `None` means the
    /// machine does not expose one.
    pub fn set_machine(&mut self, share: impl Into<Option<f64>>) {
        self.state().machine = share.into();
    }

    fn state(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.shared.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl CpuSampler for FakeSampler {
    fn own_cpu_seconds(&mut self) -> f64 {
        let mut state = self.state();
        if let Some(step) = state.script.pop_front() {
            state.last_step_s = step;
        }
        state.total_cpu_s += state.last_step_s;
        state.total_cpu_s
    }

    fn machine_busy_share(&mut self) -> Option<f64> {
        self.state().machine
    }

    fn cores(&self) -> u32 {
        self.state().cores
    }
}

/// This process's CPU time (user plus system) from `getrusage`, or `None`
/// when the call fails.
#[cfg(unix)]
fn rusage_cpu_seconds() -> Option<f64> {
    const MICROSECONDS_PER_SECOND: f64 = 1_000_000.0;
    // SAFETY: rusage is a plain C struct of integers, for which all-zero bytes
    // are a valid value; getrusage then overwrites it.
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    // SAFETY: RUSAGE_SELF is a valid selector and the pointer refers to a
    // live, writable rusage owned by this frame.
    let rc = unsafe { libc::getrusage(libc::RUSAGE_SELF, &raw mut usage) };
    if rc != 0 {
        return None;
    }
    // tv_usec is i32 on macOS and i64 on Linux. Widening through i128 is a
    // real conversion on both (so clippy's useless_conversion stays quiet on
    // Linux), and f64 has no From<i128>, so the final cast trips no
    // cast_lossless on macOS either.
    let seconds = |tv: libc::timeval| {
        tv.tv_sec as f64 + i128::from(tv.tv_usec) as f64 / MICROSECONDS_PER_SECOND
    };
    Some(seconds(usage.ru_utime) + seconds(usage.ru_stime))
}

#[cfg(target_os = "macos")]
pub(crate) mod platform {
    //! macOS: `getrusage` for the process, `host_statistics64` for the machine.

    use super::{CpuSampler, CpuTicks, busy_share_of, logical_cores, rusage_cpu_seconds};

    // Declared here rather than taken from libc, whose copies are deprecated in
    // favour of the mach2 crate; the signatures are those of <mach/mach_host.h>,
    // <mach/mach_port.h> and <mach/mach_init.h>.
    unsafe extern "C" {
        /// A send right to the host port.
        fn mach_host_self() -> libc::mach_port_t;
        /// Releases one user reference on a port right held by `task`.
        fn mach_port_deallocate(
            task: libc::mach_port_t,
            name: libc::mach_port_t,
        ) -> libc::kern_return_t;
        /// The calling task's own port; the C `mach_task_self()` macro reads it.
        static mach_task_self_: libc::mach_port_t;
    }

    /// The four `host_cpu_load_info` counters in the order the kernel fills
    /// them: `CPU_STATE_USER`, `CPU_STATE_SYSTEM`, `CPU_STATE_IDLE`,
    /// `CPU_STATE_NICE`. Each is a 32-bit tick count that wraps.
    type HostTicks = [libc::natural_t; 4];

    /// A send right to the host port, released when dropped.
    pub struct HostPort(libc::mach_port_t);

    impl HostPort {
        /// Takes a send right to the host port.
        pub fn new() -> Self {
            // SAFETY: mach_host_self has no preconditions; it returns a send
            // right that Drop releases.
            Self(unsafe { mach_host_self() })
        }

        /// Reads the host-wide CPU tick counters, or the kernel's return code
        /// when the call fails.
        pub fn read_ticks(&self) -> Result<HostTicks, libc::kern_return_t> {
            let mut info = libc::host_cpu_load_info { cpu_ticks: [0; 4] };
            let mut count: libc::mach_msg_type_number_t = libc::HOST_CPU_LOAD_INFO_COUNT;
            // SAFETY: `self.0` is the valid host port taken in `new`; `info`
            // is a live, writable host_cpu_load_info, which is exactly
            // HOST_CPU_LOAD_INFO_COUNT integer_t words long, and `count` tells
            // the kernel that size.
            let rc = unsafe {
                libc::host_statistics64(
                    self.0,
                    libc::HOST_CPU_LOAD_INFO,
                    (&raw mut info).cast::<libc::integer_t>(),
                    &raw mut count,
                )
            };
            if rc == libc::KERN_SUCCESS {
                Ok(info.cpu_ticks)
            } else {
                Err(rc)
            }
        }
    }

    impl Drop for HostPort {
        fn drop(&mut self) {
            // SAFETY: mach_task_self_ is the task port libSystem initialises
            // before any Rust code runs, and `self.0` is the send right
            // mach_host_self gave us; releasing it once is the balance, and
            // there is nothing to do if the kernel declines.
            unsafe {
                mach_port_deallocate(mach_task_self_, self.0);
            }
        }
    }

    /// Asks the kernel for the CPU counters once, without keeping anything.
    pub fn probe_host_ticks() -> Result<(), libc::kern_return_t> {
        HostPort::new().read_ticks().map(|_| ())
    }

    /// The ticks elapsed between two host readings, wrap-safe.
    fn ticks_between(before: HostTicks, after: HostTicks) -> CpuTicks {
        let [before_user, before_system, before_idle, before_nice] = before;
        let [after_user, after_system, after_idle, after_nice] = after;
        let elapsed = |after: u32, before: u32| u64::from(after.wrapping_sub(before));
        CpuTicks {
            busy: elapsed(after_user, before_user)
                + elapsed(after_system, before_system)
                + elapsed(after_nice, before_nice),
            idle: elapsed(after_idle, before_idle),
        }
    }

    /// The macOS sampler. Holds the host port for its lifetime.
    pub struct PlatformSampler {
        cores: u32,
        host: HostPort,
        previous: Option<HostTicks>,
        last_own_cpu_s: f64,
    }

    impl PlatformSampler {
        /// Takes the host port and the first tick reading.
        pub fn new() -> Self {
            let host = HostPort::new();
            let previous = host.read_ticks().ok();
            Self {
                cores: logical_cores(),
                host,
                previous,
                last_own_cpu_s: 0.0,
            }
        }
    }

    impl CpuSampler for PlatformSampler {
        fn own_cpu_seconds(&mut self) -> f64 {
            if let Some(seconds) = rusage_cpu_seconds() {
                self.last_own_cpu_s = seconds;
            }
            self.last_own_cpu_s
        }

        fn machine_busy_share(&mut self) -> Option<f64> {
            let now = self.host.read_ticks().ok()?;
            // Measured on macOS 27: the kernel publishes these counters about
            // once a second. Between publications the reading equals the
            // baseline, so the share is `None` and the next one covers the
            // whole span since the last publication.
            let share = self
                .previous
                .and_then(|before| busy_share_of(ticks_between(before, now)));
            self.previous = Some(now);
            share
        }

        fn cores(&self) -> u32 {
            self.cores
        }
    }
}

#[cfg(target_os = "linux")]
pub(crate) mod platform {
    //! Linux: `getrusage` for the process, `/proc/stat` for the machine.

    use super::{
        CpuSampler, CpuTicks, fold_reading, logical_cores, parse_proc_stat, rusage_cpu_seconds,
    };

    /// Where the kernel publishes the aggregate CPU counters.
    pub const PROC_STAT_PATH: &str = "/proc/stat";

    /// Reads and parses `/proc/stat`, or `None` when it is unreadable or garbled.
    pub fn read_proc_stat_ticks() -> Option<CpuTicks> {
        std::fs::read_to_string(PROC_STAT_PATH)
            .ok()
            .and_then(|text| parse_proc_stat(&text))
    }

    /// The Linux sampler.
    pub struct PlatformSampler {
        cores: u32,
        previous: Option<CpuTicks>,
        last_own_cpu_s: f64,
    }

    impl PlatformSampler {
        /// Takes the first `/proc/stat` reading.
        pub fn new() -> Self {
            Self {
                cores: logical_cores(),
                previous: read_proc_stat_ticks(),
                last_own_cpu_s: 0.0,
            }
        }
    }

    impl CpuSampler for PlatformSampler {
        fn own_cpu_seconds(&mut self) -> f64 {
            if let Some(seconds) = rusage_cpu_seconds() {
                self.last_own_cpu_s = seconds;
            }
            self.last_own_cpu_s
        }

        fn machine_busy_share(&mut self) -> Option<f64> {
            let now = read_proc_stat_ticks()?;
            let (baseline, share) = fold_reading(self.previous, now);
            self.previous = baseline;
            share
        }

        fn cores(&self) -> u32 {
            self.cores
        }
    }
}

#[cfg(windows)]
pub(crate) mod platform {
    //! Windows: `GetProcessTimes` for the process, `GetSystemTimes` for the machine.

    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetProcessTimes, GetSystemTimes,
    };

    use super::{CpuSampler, CpuTicks, fold_reading, logical_cores};

    /// FILETIME counts 100-nanosecond intervals.
    const FILETIME_UNITS_PER_SECOND: f64 = 10_000_000.0;

    const fn zero_filetime() -> FILETIME {
        FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        }
    }

    fn filetime_units(ft: FILETIME) -> u64 {
        (u64::from(ft.dwHighDateTime) << 32) | u64::from(ft.dwLowDateTime)
    }

    /// This process's kernel plus user time in seconds, or `None` when
    /// `GetProcessTimes` fails.
    pub fn process_cpu_seconds() -> Option<f64> {
        let mut creation = zero_filetime();
        let mut exit = zero_filetime();
        let mut kernel = zero_filetime();
        let mut user = zero_filetime();
        // SAFETY: GetCurrentProcess returns a pseudo-handle that is always
        // valid for the calling process; the four out-pointers refer to live,
        // writable FILETIMEs owned by this frame.
        let ok = unsafe {
            GetProcessTimes(
                GetCurrentProcess(),
                &raw mut creation,
                &raw mut exit,
                &raw mut kernel,
                &raw mut user,
            )
        };
        if ok == 0 {
            return None;
        }
        let units = filetime_units(kernel).checked_add(filetime_units(user))?;
        Some(units as f64 / FILETIME_UNITS_PER_SECOND)
    }

    /// The machine's cumulative busy and idle time from `GetSystemTimes`, in
    /// FILETIME units; kernel time includes idle time, so it is split out.
    pub fn read_system_ticks() -> Option<CpuTicks> {
        let mut idle = zero_filetime();
        let mut kernel = zero_filetime();
        let mut user = zero_filetime();
        // SAFETY: the three out-pointers refer to live, writable FILETIMEs
        // owned by this frame.
        let ok = unsafe { GetSystemTimes(&raw mut idle, &raw mut kernel, &raw mut user) };
        if ok == 0 {
            return None;
        }
        let idle = filetime_units(idle);
        let kernel_busy = filetime_units(kernel).checked_sub(idle)?;
        Some(CpuTicks {
            busy: kernel_busy.checked_add(filetime_units(user))?,
            idle,
        })
    }

    /// The Windows sampler.
    pub struct PlatformSampler {
        cores: u32,
        previous: Option<CpuTicks>,
        last_own_cpu_s: f64,
    }

    impl PlatformSampler {
        /// Takes the first `GetSystemTimes` reading.
        pub fn new() -> Self {
            Self {
                cores: logical_cores(),
                previous: read_system_ticks(),
                last_own_cpu_s: 0.0,
            }
        }
    }

    impl CpuSampler for PlatformSampler {
        fn own_cpu_seconds(&mut self) -> f64 {
            if let Some(seconds) = process_cpu_seconds() {
                self.last_own_cpu_s = seconds;
            }
            self.last_own_cpu_s
        }

        fn machine_busy_share(&mut self) -> Option<f64> {
            let now = read_system_ticks()?;
            let (baseline, share) = fold_reading(self.previous, now);
            self.previous = baseline;
            share
        }

        fn cores(&self) -> u32 {
            self.cores
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub(crate) mod platform {
    //! Any other OS: nothing is measured, and nothing is invented.

    use super::{CpuSampler, logical_cores};

    /// A sampler that reports no CPU time and no machine share.
    pub struct PlatformSampler {
        cores: u32,
    }

    impl PlatformSampler {
        /// Counts the cores; measures nothing else.
        pub fn new() -> Self {
            Self {
                cores: logical_cores(),
            }
        }
    }

    impl CpuSampler for PlatformSampler {
        fn own_cpu_seconds(&mut self) -> f64 {
            0.0
        }

        fn machine_busy_share(&mut self) -> Option<f64> {
            None
        }

        fn cores(&self) -> u32 {
            self.cores
        }
    }
}

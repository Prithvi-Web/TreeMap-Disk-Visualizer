//! Keeps this addon mapped for the life of the process (Windows; RISKS R96).
//!
//! Node closes every addon an environment loaded when that environment is destroyed:
//! `node::Environment::~Environment` calls `binding::DLib::Close` (read off Node 24.16.0's
//! own binary, 28 Sep 2026). On Windows that is `FreeLibrary`, and where a worker thread
//! was the addon's only holder it unmaps the DLL while the worker's teardown still has
//! calls to make into it — napi-rs's per-environment machinery, and this DLL's own
//! statically linked C runtime (`.cargo/config.toml`). The process then died with an
//! access violation after the worker had answered: CI run 36524222262, exit code
//! 3221225477 (0xC0000005), its stderr "the worker thread answered 0.5.0; terminating
//! it". macOS never unmaps a library that has thread-local variables, and glibc waits
//! while their destructors are pending, so neither showed it.
//!
//! Pinned when it is loaded, the DLL stays mapped until the process ends, whichever
//! thread loaded it first and whichever environment closes it: every later
//! `FreeLibrary` of it is a no-op. The app's main thread loads the addon before any
//! worker does, so there the pin backs up a rule; the harness's worker probe loads it in
//! a worker alone, which is how the crash was found.
//!
//! A pin that fails leaves the DLL exactly as it was before this module existed, held
//! by every environment that loaded it — safe wherever the main thread holds it, as the
//! app's does. Nothing reports a failed pin while the app runs; the test on the Windows
//! leg reads its outcome and asserts the pin held.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::System::LibraryLoader::{
    GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, GET_MODULE_HANDLE_EX_FLAG_PIN, GetModuleHandleExW,
};

static TRIED: AtomicBool = AtomicBool::new(false);
static PINNED: AtomicBool = AtomicBool::new(false);
static ERROR: AtomicU32 = AtomicU32::new(0);

/// Pins the module this function is in, once, as the DLL is loaded: a static
/// constructor, run by the loader before Node registers the module. It asks the
/// loader for nothing it does not already hold (the module is in its list), so it
/// is safe under the loader lock.
#[napi_derive::module_init]
unsafe fn pin_this_module() {
    let mut module = std::ptr::null_mut();
    // SAFETY: with FROM_ADDRESS the second argument is read as an address inside a
    // loaded module — this function's own, so inside this DLL — not as a name; PIN
    // keeps that module loaded until the process ends, so the handle written to
    // `module`, a valid place for one, never needs releasing.
    let pinned = unsafe {
        GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
            (pin_this_module as *const ()).cast::<u16>(),
            &raw mut module,
        )
    } != 0;
    if !pinned {
        // SAFETY: reads this thread's last-error value, which the failed call set.
        ERROR.store(unsafe { GetLastError() }, Ordering::Release);
    }
    PINNED.store(pinned, Ordering::Release);
    TRIED.store(true, Ordering::Release);
}

/// Whether the pin was tried and held; the Win32 error it failed with otherwise, or
/// `None` before it was tried.
#[cfg(test)]
fn outcome() -> Option<Result<(), u32>> {
    if !TRIED.load(Ordering::Acquire) {
        return None;
    }
    Some(if PINNED.load(Ordering::Acquire) {
        Ok(())
    } else {
        Err(ERROR.load(Ordering::Acquire))
    })
}

#[cfg(test)]
mod tests {
    use super::outcome;

    #[test]
    fn the_module_was_pinned_when_it_was_loaded() {
        // In a test binary the constructor pins the executable itself, the module this
        // function is in; the call and its flags are the ones the DLL makes. The DLL's
        // own case is the worker probe on the Windows leg
        // (tests/benchMemoryPath.test.ts), which crashed without the pin.
        assert_eq!(outcome(), Some(Ok(())));
    }
}

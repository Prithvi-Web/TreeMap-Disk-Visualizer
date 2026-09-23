//! On Windows, the helper's own imports load from System32 only.
//!
//! tm-mft-helper.exe runs elevated. Its C runtime is linked statically
//! (native/treemap-core/.cargo/config.toml), so every DLL it imports is
//! Windows' own, and `/DEPENDENTLOADFLAG:0x800` (LOAD_LIBRARY_SEARCH_SYSTEM32)
//! makes the loader take them from System32 and never from a folder on the
//! PATH that a program running as the user could write (the pre-landing
//! review of 23 Sep 2026). tests/windowsImports.test.ts reads the flag back
//! out of the built image on the Windows CI leg.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|env| env == "msvc") {
        println!("cargo:rustc-link-arg-bins=/DEPENDENTLOADFLAG:0x800");
    }
}

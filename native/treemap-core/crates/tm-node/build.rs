//! Build script: `napi-build` adds the linker arguments a Node addon needs on each
//! platform (macOS lets the host resolve the N-API symbols; nothing on MSVC).
fn main() {
    napi_build::setup();
}

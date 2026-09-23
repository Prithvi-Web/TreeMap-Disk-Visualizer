//! `tm-mft-helper <volume> <root> <output file>` — the elevated, read-only
//! reader of the Windows MFT turbo mode (see the library's docs): exit 0
//! with the columns written, or 2 with the refusal on stderr and, once the
//! output file is its own, in that file.

use std::ffi::OsString;
use std::io::Write;
use std::process::ExitCode;

use tm_mft_helper::{Request, app_temp_folder, run};
use tm_walk::WalkOutput;

fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let outcome = run(&args, &app_temp_folder(), read);
    if let Some(message) = &outcome.message {
        // Nothing to do if stderr is gone: the refusal is in the file too.
        let _ = writeln!(std::io::stderr(), "{message}");
    }
    ExitCode::from(outcome.code)
}

/// The volume's master file table, for the checked root, access times
/// included (the app's walks always record them).
#[cfg(windows)]
fn read(request: &Request) -> Result<WalkOutput, String> {
    tm_mft::read_volume(&request.root, true).map_err(|e| e.to_string())
}

/// Anywhere but Windows there is no NTFS volume to open.
#[cfg(not(windows))]
fn read(_request: &Request) -> Result<WalkOutput, String> {
    Err(format!(
        "tm-mft-helper reads an NTFS volume through Windows, and this build is for {}",
        std::env::consts::OS
    ))
}

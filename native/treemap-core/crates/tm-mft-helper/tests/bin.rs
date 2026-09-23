//! The helper as the app starts it (M6, W6-2): the built binary, its exit
//! status and what it writes. The pre-landing review of 23 Sep 2026 found no
//! test ran it, so main's own part — which arguments it hands `run`, which
//! temp folder, the status it exits with, the one line it writes to stderr —
//! was pinned by nothing.

mod common;

use std::ffi::OsStr;
use std::path::Path;
use std::process::{Command, Output};

use common::Scratch;
use tm_mft_helper::{APP_TEMP_FOLDER, EXIT_OK, EXIT_REFUSED};

type TestResult = Result<(), String>;

/// The built helper, run with `args` and with `temp` as its OS temp folder —
/// set, for the child alone, in every variable `std::env::temp_dir` reads:
/// TMPDIR on unix, TMP and then TEMP on Windows. So no test touches this
/// machine's own app temp folder, and the helper is seen resolving its temp
/// folder itself, never from its arguments.
fn helper<A: AsRef<OsStr>>(args: &[A], temp: &Path) -> Result<Output, String> {
    Command::new(env!("CARGO_BIN_EXE_tm-mft-helper"))
        .args(args)
        .env("TMPDIR", temp)
        .env("TMP", temp)
        .env("TEMP", temp)
        .output()
        .map_err(|e| format!("the helper did not start: {e}"))
}

/// What the helper wrote to stderr, which must be exactly one line.
fn one_line(stderr: &[u8]) -> Result<String, String> {
    let text = String::from_utf8_lossy(stderr);
    match text.strip_suffix('\n') {
        Some(line) if !line.contains(['\n', '\r']) => Ok(line.to_owned()),
        _ => Err(format!("stderr is not exactly one line: {text:?}")),
    }
}

#[test]
fn the_exit_statuses_are_the_numbers_the_app_compares() {
    // electron/mft.js passes the helper's status back untouched, and
    // src/services/scan/nativeEngine.ts reads 0 as the columns written and
    // anything else as failure, 2 the refusal whose reason is in the file;
    // the launcher's own codes (1223, 9001, 9002) are chosen never to collide
    // with these. Every other test compares with the constants themselves, so
    // without this one a renumbering would pass them all.
    assert_eq!(EXIT_OK, 0, "EXIT_OK");
    assert_eq!(EXIT_REFUSED, 2, "EXIT_REFUSED");
}

#[test]
fn a_bad_volume_exits_refused_with_one_line_on_stderr_naming_it() -> TestResult {
    let scratch = Scratch::new("bin-volume")?;
    let out = helper(&["CD", "C:/x", "x.tmmft"], &scratch.dir)?;
    assert_eq!(out.status.code(), Some(i32::from(EXIT_REFUSED)));
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "the volume argument \"CD\" is not a drive letter such as C:\n"
    );
    assert!(
        out.stdout.is_empty(),
        "stdout: {:?}",
        String::from_utf8_lossy(&out.stdout)
    );
    Ok(())
}

#[test]
fn well_formed_arguments_pass_every_check_and_an_existing_output_is_left_alone() -> TestResult {
    // Not a usage error: all three arguments are checked and pass, the temp
    // folder the helper resolves from its environment is the one the output
    // sits in, and it is the creation that refuses — CREATE_NEW, over a file
    // someone else made. Nothing is read, so no test reads a real volume.
    let scratch = Scratch::new("bin-exists")?;
    let fence = scratch.folder(APP_TEMP_FOLDER)?;
    let taken = fence.join("taken.tmmft");
    std::fs::write(&taken, b"someone else's").map_err(|e| e.to_string())?;
    let out = helper(
        &[OsStr::new("C:"), OsStr::new("C:\\data"), taken.as_os_str()],
        &scratch.dir,
    )?;
    assert_eq!(out.status.code(), Some(i32::from(EXIT_REFUSED)));
    let line = one_line(&out.stderr)?;
    assert!(
        line.starts_with("the output file \"")
            && line.contains("taken.tmmft\" could not be created: "),
        "{line}"
    );
    assert_eq!(
        std::fs::read(&taken).map_err(|e| e.to_string())?,
        b"someone else's"
    );
    Ok(())
}

#[cfg(not(windows))]
#[test]
fn off_windows_a_well_formed_run_refuses_in_the_output_file_as_well_as_on_stderr() -> TestResult {
    // An elevated process's stderr never reaches the app, so the output file
    // is the channel that counts: the binary's refusal must be in it too.
    // Off Windows there is no volume to read, so the read itself refuses.
    use tm_mft::columns::{ColumnsFile, decode};
    let scratch = Scratch::new("bin-refusal")?;
    let fence = scratch.folder(APP_TEMP_FOLDER)?;
    let output = fence.join("run.tmmft");
    let out = helper(
        &[OsStr::new("C:"), OsStr::new("C:\\data"), output.as_os_str()],
        &scratch.dir,
    )?;
    let sentence = format!(
        "tm-mft-helper reads an NTFS volume through Windows, and this build is for {}",
        std::env::consts::OS
    );
    assert_eq!(out.status.code(), Some(i32::from(EXIT_REFUSED)));
    assert_eq!(one_line(&out.stderr)?, sentence);
    match decode(&std::fs::read(&output).map_err(|e| e.to_string())?) {
        Ok(ColumnsFile::Refusal(text)) => assert_eq!(text, sentence),
        other => return Err(format!("expected the refusal, got {other:?}")),
    }
    Ok(())
}

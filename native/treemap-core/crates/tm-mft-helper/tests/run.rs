//! The helper's run, portable (M6, W6-2): the arguments and the output file
//! are settled before the volume is read — a refused argument means the
//! reader is never called and nothing is written anywhere; an existing
//! output is never overwritten; a read becomes a columns file, and a refused
//! read becomes a refusal file carrying the sentence, since an elevated
//! process's stderr does not reach the app.

mod common;

use std::cell::Cell;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use common::{Scratch, plant_file_link, plant_folder_link};
use tm_mft::columns::{ColumnsFile, decode};
use tm_mft_helper::{
    APP_TEMP_FOLDER, EXIT_OK, EXIT_REFUSED, Request, create_output, landing_refusal,
    record_refusal, run, validate,
};
use tm_walk::{FastPath, KIND_DIR, KIND_FILE, WalkOutput, WalkStats};

type TestResult = Result<(), String>;

fn args(volume: &str, root: &str, output: &Path) -> Vec<OsString> {
    vec![
        OsString::from(volume),
        OsString::from(root),
        output.as_os_str().to_owned(),
    ]
}

/// A root `C:\data` holding one file.
fn tiny() -> WalkOutput {
    WalkOutput {
        parent: vec![0, 0],
        name_off: vec![0, 4, 9],
        names: b"datafile1".to_vec(),
        kind: vec![KIND_DIR, KIND_FILE],
        flags: vec![0, 0],
        size: vec![0.0, 42.0],
        alloc_bytes: vec![0.0, 4096.0],
        mtime_ms: vec![1.0, 2.0],
        atime_ms: vec![3.0, 4.0],
        hardlinks: Vec::new(),
        refusals: Vec::new(),
        stats: WalkStats {
            dirs_listed: 1,
            entries: 1,
            wall_ms: 1.0,
            cpu_seconds: 0.5,
            fast_path: FastPath::Mft,
            workers_peak: 1,
            climb_steps: 0,
            denied_entries: 0,
            unreadable_entries: 0,
            dataless: 0,
        },
    }
}

fn files_in(dir: &Path) -> Result<Vec<String>, String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    Ok(names)
}

#[test]
fn a_refused_output_means_the_volume_is_never_read_and_nothing_is_written() -> TestResult {
    let scratch = Scratch::new("run-refused")?;
    let fence = scratch.folder(APP_TEMP_FOLDER)?;
    let elsewhere = scratch.folder("elsewhere")?;
    let read = Cell::new(false);
    let outcome = run(
        &args("C:", "C:\\data", &elsewhere.join("x.tmmft")),
        &fence,
        |_req: &Request| {
            read.set(true);
            Ok(tiny())
        },
    );
    assert_eq!(outcome.code, EXIT_REFUSED);
    assert!(
        !read.get(),
        "the reader ran before the output was validated"
    );
    let message = outcome.message.unwrap_or_default();
    assert!(message.contains(APP_TEMP_FOLDER), "{message}");
    assert!(files_in(&elsewhere)?.is_empty(), "nothing written outside");
    assert!(
        files_in(&fence)?.is_empty(),
        "nothing written inside either"
    );
    Ok(())
}

#[test]
fn refused_volume_or_root_arguments_never_reach_the_reader() -> TestResult {
    let scratch = Scratch::new("run-args")?;
    let fence = scratch.folder(APP_TEMP_FOLDER)?;
    for (volume, root) in [("CD", "C:\\data"), ("C:", "D:\\data"), ("C:", "C:\\..\\x")] {
        let read = Cell::new(false);
        let outcome = run(&args(volume, root, &fence.join("a.tmmft")), &fence, |_| {
            read.set(true);
            Ok(tiny())
        });
        assert_eq!(outcome.code, EXIT_REFUSED, "{volume} {root}");
        assert!(!read.get(), "{volume} {root}: read anyway");
        assert!(
            files_in(&fence)?.is_empty(),
            "{volume} {root}: wrote a file"
        );
    }
    let outcome = run(&[OsString::from("C:")], &fence, |_| Ok(tiny()));
    assert_eq!(outcome.code, EXIT_REFUSED);
    assert!(outcome.message.unwrap_or_default().contains("usage"));
    Ok(())
}

#[test]
fn an_existing_output_is_never_overwritten_and_the_volume_is_not_read() -> TestResult {
    let scratch = Scratch::new("run-exists")?;
    let fence = scratch.folder(APP_TEMP_FOLDER)?;
    let out = fence.join("taken.tmmft");
    std::fs::write(&out, b"someone else's").map_err(|e| e.to_string())?;
    let read = Cell::new(false);
    let outcome = run(&args("C:", "C:\\data", &out), &fence, |_| {
        read.set(true);
        Ok(tiny())
    });
    assert_eq!(outcome.code, EXIT_REFUSED);
    assert!(!read.get());
    assert_eq!(
        std::fs::read(&out).map_err(|e| e.to_string())?,
        b"someone else's"
    );
    Ok(())
}

#[test]
fn a_temp_folder_that_is_a_link_is_refused_before_anything_is_created_or_read() -> TestResult {
    // The security review of M6: a junction at the app's temp folder would
    // have sent this elevated process's file wherever it points.
    let scratch = Scratch::new("run-fence-link")?;
    let protected = scratch.folder("somewhere-protected")?;
    let fence = scratch.path(APP_TEMP_FOLDER);
    plant_folder_link(&protected, &fence)?;
    let read = Cell::new(false);
    let outcome = run(
        &args("C:", "C:\\data", &fence.join("x.tmmft")),
        &fence,
        |_| {
            read.set(true);
            Ok(tiny())
        },
    );
    assert_eq!(outcome.code, EXIT_REFUSED);
    assert!(!read.get(), "the volume was read");
    let message = outcome.message.unwrap_or_default();
    assert!(message.contains("junction"), "{message}");
    assert!(
        files_in(&protected)?.is_empty(),
        "a file was created where the link points"
    );
    Ok(())
}

#[test]
fn a_folder_above_the_temp_folder_swapped_for_a_link_after_the_check_means_nothing_is_created()
-> TestResult {
    // The second security review of M6: the hold pins the temp folder itself,
    // but a folder ABOVE it swapped for a link (a junction on Windows) between
    // the check and the hold would have moved where the checked path leads.
    let scratch = Scratch::new("run-ancestor")?;
    let above = scratch.folder("above")?;
    let fence = scratch.folder(&format!("above/{APP_TEMP_FOLDER}"))?;
    let elsewhere = scratch.folder("elsewhere")?;
    let decoy = scratch.folder(&format!("elsewhere/{APP_TEMP_FOLDER}"))?;
    let request = validate(&args("C:", "C:\\data", &fence.join("x.tmmft")), &fence)
        .map_err(|e| e.to_string())?;
    // The swap: the real folder moved aside, a link to the decoy's parent in its place.
    let aside = scratch.path("above-moved-aside");
    std::fs::rename(&above, &aside).map_err(|e| e.to_string())?;
    plant_folder_link(&elsewhere, &above)?;
    let result = create_output(&request, &fence);
    assert!(result.is_err(), "created through the swapped path");
    assert!(
        files_in(&decoy)?.is_empty(),
        "nothing created where the link leads"
    );
    assert!(
        files_in(&aside.join(APP_TEMP_FOLDER))?.is_empty(),
        "nor in the folder moved aside"
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn a_link_planted_at_the_output_name_is_not_followed() -> TestResult {
    let scratch = Scratch::new("run-link")?;
    let fence = scratch.folder(APP_TEMP_FOLDER)?;
    let target = scratch.path("victim.txt");
    std::fs::write(&target, b"precious").map_err(|e| e.to_string())?;
    let out = fence.join("planted.tmmft");
    std::os::unix::fs::symlink(&target, &out).map_err(|e| e.to_string())?;
    let outcome = run(&args("C:", "C:\\data", &out), &fence, |_| Ok(tiny()));
    assert_eq!(outcome.code, EXIT_REFUSED);
    assert_eq!(
        std::fs::read(&target).map_err(|e| e.to_string())?,
        b"precious"
    );
    Ok(())
}

#[test]
fn a_dangling_link_planted_at_the_output_name_is_refused_and_nothing_is_created_where_it_points()
-> TestResult {
    // The pre-landing review of 23 Sep 2026. The link above leads to a file
    // that exists; this one leads nowhere yet, the case where following it
    // would CREATE a file wherever it points, as this elevated process. The
    // name itself must be refused (CREATE_NEW, O_EXCL) on Windows as on unix:
    // the landing check would only see that the file had gone elsewhere
    // after it was made there. On Windows this is a real symbolic link, not
    // a junction, which the CI runner can plant as an administrator.
    let scratch = Scratch::new("run-dangling")?;
    let fence = scratch.folder(APP_TEMP_FOLDER)?;
    let target = scratch.path("never-made.txt");
    let out = fence.join("dangling.tmmft");
    plant_file_link(&target, &out)?;
    let read = Cell::new(false);
    let outcome = run(&args("C:", "C:\\data", &out), &fence, |_| {
        read.set(true);
        Ok(tiny())
    });
    assert_eq!(outcome.code, EXIT_REFUSED);
    assert!(!read.get(), "the volume was read");
    assert!(
        std::fs::symlink_metadata(&target).is_err(),
        "a file was created where the link points"
    );
    let message = outcome.message.unwrap_or_default();
    assert!(
        message.contains("could not be created"),
        "refused only after the file was made: {message}"
    );
    Ok(())
}

#[test]
fn a_refusal_recorded_over_a_half_written_file_is_all_the_file_holds() -> TestResult {
    // The Rust review of M6: after the output file exists, a failed landing
    // check or a failed write returned with the file empty or half written,
    // so the app read "too short" instead of why. The refusal now goes into
    // the file, through the handle the helper holds, over whatever was there.
    use std::io::Write;
    let scratch = Scratch::new("record")?;
    let path = scratch.path("half.tmmft");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(&[0xAB; 4096]).map_err(|e| e.to_string())?;
    record_refusal(
        &mut file,
        "the output file could not be written: the disk is full",
    );
    drop(file);
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    match decode(&bytes) {
        Ok(ColumnsFile::Refusal(sentence)) => assert_eq!(
            sentence,
            "the output file could not be written: the disk is full"
        ),
        other => return Err(format!("not a refusal record: {other:?}")),
    }
    Ok(())
}

#[test]
fn a_read_becomes_a_columns_file_the_app_can_decode() -> TestResult {
    let scratch = Scratch::new("run-ok")?;
    let fence = scratch.folder(APP_TEMP_FOLDER)?;
    let out = fence.join("ok.tmmft");
    let seen = Cell::new(None::<(String, String)>);
    let outcome = run(&args("c:", "C:\\data", &out), &fence, |req: &Request| {
        seen.set(Some((
            req.volume.clone(),
            req.root.to_string_lossy().into_owned(),
        )));
        Ok(tiny())
    });
    assert_eq!(
        outcome,
        tm_mft_helper::Outcome {
            code: EXIT_OK,
            message: None
        }
    );
    assert_eq!(
        seen.take(),
        Some(("C:".to_owned(), "C:\\data".to_owned())),
        "the reader gets the checked volume and root"
    );
    let bytes = std::fs::read(&out).map_err(|e| e.to_string())?;
    match decode(&bytes) {
        Ok(ColumnsFile::Columns(back)) => {
            assert_eq!(back.parent, vec![0, 0]);
            assert_eq!(back.names, b"datafile1".to_vec());
            assert_eq!(back.size, vec![0.0, 42.0]);
            assert_eq!(back.stats.fast_path, FastPath::Mft);
        }
        other => return Err(format!("expected columns, got {other:?}")),
    }
    assert_eq!(
        files_in(&fence)?,
        vec!["ok.tmmft".to_owned()],
        "only its own file"
    );
    Ok(())
}

#[test]
fn a_refused_read_becomes_a_refusal_file_carrying_the_sentence() -> TestResult {
    let scratch = Scratch::new("run-no")?;
    let fence = scratch.folder(APP_TEMP_FOLDER)?;
    let out = fence.join("no.tmmft");
    let sentence = "C:\\ is formatted ReFS, not NTFS; only NTFS keeps a master file table";
    let outcome = run(&args("C:", "C:\\data", &out), &fence, |_| {
        Err(sentence.to_owned())
    });
    assert_eq!(outcome.code, EXIT_REFUSED);
    assert_eq!(outcome.message.as_deref(), Some(sentence));
    match decode(&std::fs::read(&out).map_err(|e| e.to_string())?) {
        Ok(ColumnsFile::Refusal(text)) => assert_eq!(text, sentence),
        other => return Err(format!("expected the refusal, got {other:?}")),
    }
    Ok(())
}

// The landing check: once created, the output file must be found exactly
// where the check said. The pre-landing review of 23 Sep 2026 found no test
// reached its refusals — with the folder held from the check on, a file lands
// elsewhere only through a race no test can stage — so the decision is its
// own function, and each arm is pinned here by its exact sentence.

/// Where these tests say the check put the output.
const CHECKED: &str = "/fence/TreeMap-mft/x.tmmft";

#[test]
fn a_file_found_exactly_where_the_check_said_passes_the_landing_check() {
    let output = Path::new(CHECKED);
    assert_eq!(landing_refusal(output, Ok(output.to_path_buf())), None);
}

#[test]
fn a_file_found_anywhere_else_is_refused_naming_both_places() {
    assert_eq!(
        landing_refusal(
            Path::new(CHECKED),
            Ok(PathBuf::from("/somewhere-else/x.tmmft"))
        ),
        Some(
            "the output file landed at \"/somewhere-else/x.tmmft\", not at \"/fence/TreeMap-mft/x.tmmft\"; nothing was read"
                .to_owned()
        )
    );
}

#[test]
fn a_file_not_found_after_it_was_created_is_refused_with_the_reason() {
    let gone = std::io::Error::new(std::io::ErrorKind::NotFound, "it is gone");
    assert_eq!(
        landing_refusal(Path::new(CHECKED), Err(gone)),
        Some(
            "the output file \"/fence/TreeMap-mft/x.tmmft\" could not be found after it was created: it is gone"
                .to_owned()
        )
    );
}

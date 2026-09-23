//! The helper's run, portable (M6, W6-2): the arguments and the output file
//! are settled before the volume is read — a refused argument means the
//! reader is never called and nothing is written anywhere; an existing
//! output is never overwritten; a read becomes a columns file, and a refused
//! read becomes a refusal file carrying the sentence, since an elevated
//! process's stderr does not reach the app.

mod common;

use std::cell::Cell;
use std::ffi::OsString;
use std::path::Path;

use common::{Scratch, plant_folder_link};
use tm_mft::columns::{ColumnsFile, decode};
use tm_mft_helper::{
    APP_TEMP_FOLDER, EXIT_OK, EXIT_REFUSED, Request, create_output, run, validate,
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

//! The helper's argument validation (M6, W6-2): the volume is a drive
//! letter; the scan root lies on that volume; the output file sits directly
//! inside the app's temp folder, named as the app names it — all decided
//! from the arguments and the file system before the volume is touched.

mod common;

use std::ffi::OsString;

use common::{Scratch, canonical, plant_folder_link};
use tm_mft_helper::{
    APP_TEMP_FOLDER, ArgError, app_temp_folder, check_output, check_root_on_volume,
    hold_temp_folder, parse_volume, validate,
};

type TestResult = Result<(), String>;

#[test]
fn the_volume_is_a_drive_letter_and_nothing_else() {
    assert_eq!(parse_volume("C:"), Ok("C:".to_owned()));
    assert_eq!(parse_volume("d:"), Ok("D:".to_owned()), "upper-cased");
    for bad in [
        "",
        "C",
        "C:\\",
        "C:/",
        "CC:",
        "1:",
        ":",
        "\\\\.\\C:",
        "\\\\?\\C:\\",
        "é:",
        "C:x",
    ] {
        assert!(
            matches!(
                parse_volume(bad),
                Err(ArgError::VolumeNotDriveLetter { .. })
            ),
            "{bad:?} must be refused"
        );
    }
}

#[test]
fn the_root_must_be_an_absolute_path_on_that_volume() {
    for good in [
        "C:\\",
        "C:\\Users\\me",
        "c:\\Users",
        "C:/Users/me",
        "C:\\a b\\ü",
    ] {
        assert_eq!(check_root_on_volume(good, "C:"), Ok(()), "{good:?}");
    }
    for bad in [
        "D:\\Users",              // another volume
        "C:Users",                // relative to C:'s current directory
        "C:",                     // the same
        "\\Users\\me",            // relative to the current drive
        "Users\\me",              // relative
        "\\\\server\\share\\x",   // a network path
        "\\\\?\\C:\\Users",       // a device path, not the form the app passes
        "\\\\.\\C:\\Users",       // the same
        "C:\\a\\..\\..\\Windows", // a parent component
        "C:\\a\\..",              // the same, at the end
        "C:\\a\u{0}b",            // a NUL
        "",
    ] {
        assert!(
            matches!(
                check_root_on_volume(bad, "C:"),
                Err(ArgError::RootNotOnVolume { .. })
            ),
            "{bad:?} must be refused"
        );
    }
}

#[test]
fn the_output_is_accepted_directly_inside_the_temp_folder_and_named_as_the_app_names_it()
-> TestResult {
    let scratch = Scratch::new("inside")?;
    let fence = scratch.folder(APP_TEMP_FOLDER)?;
    let out = fence.join("3f2c-9a.tmmft");
    assert_eq!(
        check_output(&out, &fence),
        Ok(canonical(&fence)?.join("3f2c-9a.tmmft")),
        "the output, through the canonical folder"
    );
    Ok(())
}

#[test]
fn an_output_anywhere_else_is_refused() -> TestResult {
    let scratch = Scratch::new("outside")?;
    let fence = scratch.folder(APP_TEMP_FOLDER)?;
    let nested = scratch.folder(&format!("{APP_TEMP_FOLDER}/deeper"))?;
    let beside = scratch.folder("elsewhere")?;
    for out in [
        beside.join("x.tmmft"),                             // a sibling folder
        scratch.path("x.tmmft"),                            // the temp folder's parent
        nested.join("x.tmmft"),                             // below it, not in it
        fence.join("..").join("elsewhere").join("x.tmmft"), // climbing out by name
    ] {
        assert!(
            matches!(
                check_output(&out, &fence),
                Err(ArgError::OutsideTempFolder { .. })
            ),
            "{} must be refused",
            out.display()
        );
    }
    Ok(())
}

#[test]
fn an_output_whose_name_is_not_the_app_s_is_refused() -> TestResult {
    let scratch = Scratch::new("names")?;
    let fence = scratch.folder(APP_TEMP_FOLDER)?;
    for name in [
        "x.dll",
        "x.tmmft.exe",
        "x",
        "x.TMMFT.lnk",
        "x:ads.tmmft",
        "x.tmmft:ads",
        ".tmmft",
        "a b.tmmft",
        "x$.tmmft",
    ] {
        assert!(
            matches!(
                check_output(&fence.join(name), &fence),
                Err(ArgError::OutputName { .. })
            ),
            "{name:?} must be refused"
        );
    }
    assert!(
        matches!(
            check_output(&fence, &fence),
            Err(ArgError::OutputName { .. })
        ),
        "the folder itself is not a file name"
    );
    Ok(())
}

#[test]
fn a_missing_folder_or_a_missing_temp_folder_is_refused() -> TestResult {
    let scratch = Scratch::new("missing")?;
    let fence = scratch.folder(APP_TEMP_FOLDER)?;
    assert!(matches!(
        check_output(&fence.join("gone").join("x.tmmft"), &fence),
        Err(ArgError::OutputFolder { .. })
    ));
    let absent = scratch.path("never-made");
    assert!(matches!(
        check_output(&absent.join("x.tmmft"), &absent),
        Err(ArgError::TempFolder { .. })
    ));
    Ok(())
}

#[test]
fn the_app_temp_folder_itself_as_a_link_is_refused_and_nothing_is_created_where_it_points()
-> TestResult {
    // The security review of M6 (23 Sep 2026): canonicalize follows a link AT
    // the temp folder, so both sides of the old comparison resolved to wherever
    // it points, and the elevated helper would have created its file there — a
    // junction any process of the same user can plant, no admin needed. On
    // Windows this plants that junction; elsewhere a symbolic link.
    let scratch = Scratch::new("fence-link")?;
    let protected = scratch.folder("somewhere-protected")?;
    let fence = scratch.path(APP_TEMP_FOLDER);
    plant_folder_link(&protected, &fence)?;
    let result = check_output(&fence.join("x.tmmft"), &fence);
    assert!(
        matches!(result, Err(ArgError::TempFolder { .. })),
        "{result:?}"
    );
    let created = std::fs::read_dir(&protected)
        .map_err(|e| e.to_string())?
        .count();
    assert_eq!(created, 0, "nothing was created where the link points");
    Ok(())
}

#[test]
fn only_a_real_folder_is_held() -> TestResult {
    let scratch = Scratch::new("hold")?;
    let fence = scratch.folder(APP_TEMP_FOLDER)?;
    assert!(hold_temp_folder(&fence).is_ok(), "a real folder is held");
    let elsewhere = scratch.folder("elsewhere")?;
    let link = scratch.path("linked");
    plant_folder_link(&elsewhere, &link)?;
    let file = scratch.path("a-file");
    std::fs::write(&file, b"").map_err(|e| e.to_string())?;
    for not_real in [&link, &file, &scratch.path("absent")] {
        let result = hold_temp_folder(not_real);
        assert!(
            matches!(result, Err(ArgError::TempFolder { .. })),
            "{}: {result:?}",
            not_real.display()
        );
    }
    Ok(())
}

#[cfg(windows)]
#[test]
fn a_held_temp_folder_cannot_be_renamed_or_removed_until_it_is_let_go() -> TestResult {
    // What closes the race the landing check could only see afterwards: the
    // folder checked is the folder the file is created in, because nothing
    // can move it aside (and plant a junction at its name) while it is held.
    let scratch = Scratch::new("pinned")?;
    let above = scratch.folder("above")?;
    let fence = scratch.folder(&format!("above/{APP_TEMP_FOLDER}"))?;
    let aside = scratch.path("moved-aside");
    let held = hold_temp_folder(&fence).map_err(|e| e.to_string())?;
    assert!(
        std::fs::rename(&fence, &aside).is_err(),
        "renamed while held"
    );
    assert!(std::fs::remove_dir(&fence).is_err(), "removed while held");
    // Nor can a folder above it be moved: Windows refuses to rename a folder
    // with an open handle inside it, which is what lets the helper trust a
    // path it resolved again after taking the hold (the second review of M6).
    assert!(
        std::fs::rename(&above, scratch.path("above-moved")).is_err(),
        "a folder above it renamed while it was held"
    );
    assert!(fence.is_dir(), "still where it was");
    drop(held);
    std::fs::rename(&fence, &aside).map_err(|e| format!("once let go: {e}"))?;
    Ok(())
}

#[test]
fn a_folder_link_inside_the_temp_folder_pointing_out_is_refused() -> TestResult {
    let scratch = Scratch::new("link")?;
    let fence = scratch.folder(APP_TEMP_FOLDER)?;
    let outside = scratch.folder("outside")?;
    let link = fence.join("sneaky");
    plant_folder_link(&outside, &link)?;
    assert!(matches!(
        check_output(&link.join("x.tmmft"), &fence),
        Err(ArgError::OutsideTempFolder { .. })
    ));
    Ok(())
}

#[test]
fn the_app_temp_folder_is_the_os_temp_folder_s_treemap_mft() {
    assert_eq!(app_temp_folder(), std::env::temp_dir().join("TreeMap-mft"));
}

#[test]
fn validate_takes_exactly_volume_root_output_and_checks_each() -> TestResult {
    let scratch = Scratch::new("validate")?;
    let fence = scratch.folder(APP_TEMP_FOLDER)?;
    let out = fence.join("run.tmmft");
    let args = |v: &str, r: &str, o: &std::path::Path| {
        vec![
            OsString::from(v),
            OsString::from(r),
            o.as_os_str().to_owned(),
        ]
    };
    let ok = validate(&args("c:", "C:\\Users\\me", &out), &fence).map_err(|e| e.to_string())?;
    assert_eq!(ok.volume, "C:");
    assert_eq!(ok.root, std::path::PathBuf::from("C:\\Users\\me"));
    assert_eq!(ok.output, canonical(&fence)?.join("run.tmmft"));
    assert!(matches!(
        validate(&args("C:", "D:\\x", &out), &fence),
        Err(ArgError::RootNotOnVolume { .. })
    ));
    assert!(matches!(
        validate(&args("CD", "C:\\x", &out), &fence),
        Err(ArgError::VolumeNotDriveLetter { .. })
    ));
    assert!(matches!(
        validate(&args("C:", "C:\\x", &scratch.path("x.tmmft")), &fence),
        Err(ArgError::OutsideTempFolder { .. })
    ));
    for n in [0_usize, 2, 4] {
        let few: Vec<OsString> = (0..n).map(|i| OsString::from(format!("a{i}"))).collect();
        assert_eq!(validate(&few, &fence), Err(ArgError::Usage { got: n }));
    }
    Ok(())
}

#[test]
fn every_refusal_reads_as_one_line() {
    for e in [
        ArgError::Usage { got: 1 },
        ArgError::NotUnicode { which: "root" },
        ArgError::VolumeNotDriveLetter {
            volume: "CD".to_owned(),
        },
        ArgError::RootNotOnVolume {
            root: "D:\\x".to_owned(),
            volume: "C:".to_owned(),
            reason: "it is on another volume",
        },
        ArgError::OutputName {
            output: "x.dll".to_owned(),
        },
        ArgError::OutputFolder {
            output: "x".to_owned(),
            reason: "gone".to_owned(),
        },
        ArgError::OutsideTempFolder {
            output: "x".to_owned(),
            folder: "y".to_owned(),
        },
        ArgError::TempFolder {
            folder: "y".to_owned(),
            reason: "gone".to_owned(),
        },
    ] {
        let text = e.to_string();
        assert!(
            !text.contains('\n') && !text.contains('{') && text.len() > 20,
            "{text}"
        );
    }
}

#[test]
fn a_line_or_paragraph_separator_in_an_argument_cannot_break_a_refusal_across_lines() {
    // The pre-landing review of 23 Sep 2026: U+2028 and U+2029 are not
    // control characters (Unicode files them as Zl and Zp, not Cc), so the
    // replacement let them through — yet Unicode names both line terminators,
    // and any reader that follows Unicode ends a line at either, which breaks
    // the promise that every refusal is one line.
    for separator in ['\u{2028}', '\u{2029}'] {
        let refusal = ArgError::VolumeNotDriveLetter {
            volume: format!("C{separator}:"),
        };
        assert_eq!(
            refusal.to_string(),
            "the volume argument \"C\u{FFFD}:\" is not a drive letter such as C:",
            "{separator:?}"
        );
    }
}

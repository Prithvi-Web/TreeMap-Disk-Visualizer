//! `platform::data_is_local`: whether a file's data is on this disk, asked of
//! its directory entry and never by opening it — opening a cloud placeholder
//! makes its sync client download it (RISKS R71). The positive case, a
//! dataless file, needs a sync client to evict one and cannot be made here;
//! the flags it reads are the ones the walk reads (`SF_DATALESS`;
//! `is_dataless` over the attributes and the reparse tag).

use std::path::PathBuf;

use tm_walk::platform::data_is_local;

type TestResult = Result<(), String>;

struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> Result<Self, String> {
        let dir = std::env::temp_dir().join(format!("tm-data-local-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(Self(dir))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _gone = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn an_ordinary_file_and_folder_are_local_and_a_missing_path_cannot_be_asked() -> TestResult {
    let scratch = Scratch::new("plain")?;
    let file = scratch.0.join("plain.bin");
    std::fs::write(&file, b"on this disk").map_err(|e| e.to_string())?;
    assert!(data_is_local(&file).map_err(|e| e.to_string())?, "a file");
    assert!(
        data_is_local(&scratch.0).map_err(|e| e.to_string())?,
        "a folder"
    );
    assert!(
        data_is_local(&scratch.0.join("absent")).is_err(),
        "nothing to ask about"
    );
    Ok(())
}

#[test]
fn a_name_holding_a_wildcard_is_never_answered_for_another_file() -> TestResult {
    // FindFirstFileExW reads `*` and `?` in a name as a pattern: asked about
    // `p*`, it would describe `plain.bin`. Elsewhere `p*` is just a name that
    // does not exist. Either way there is no answer about another file.
    let scratch = Scratch::new("wild")?;
    std::fs::write(scratch.0.join("plain.bin"), b"x").map_err(|e| e.to_string())?;
    for name in ["p*", "plain.bi?"] {
        assert!(data_is_local(&scratch.0.join(name)).is_err(), "{name}");
    }
    Ok(())
}

//! A scratch folder under the OS temp directory, made fresh for one test
//! and removed with everything the test put in it.

#![allow(dead_code, reason = "each test binary uses a different part")]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT: AtomicU32 = AtomicU32::new(0);

/// A folder of the test's own under `std::env::temp_dir()`.
pub struct Scratch {
    pub dir: PathBuf,
}

impl Scratch {
    pub fn new(tag: &str) -> Result<Self, String> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "tm-mft-helper-test-{tag}-{}-{n}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        Ok(Self { dir })
    }

    /// A subfolder, created.
    pub fn folder(&self, name: &str) -> Result<PathBuf, String> {
        let path = self.dir.join(name);
        std::fs::create_dir(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(path)
    }

    pub fn path(&self, rel: &str) -> PathBuf {
        self.dir.join(rel)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // Only this test's own folder, under the OS temp directory; symbolic
        // links inside it are removed, never followed.
        if self.dir.starts_with(std::env::temp_dir()) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

/// `path` canonical, for comparing with what the helper returns.
pub fn canonical(path: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// A link at `at` to the folder `target`: a symbolic link.
#[cfg(unix)]
pub fn plant_folder_link(target: &Path, at: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, at).map_err(|e| format!("{}: {e}", at.display()))
}

/// A link at `at` to the folder `target`: a directory junction, which any
/// process of the user can make without privilege — the attack the
/// security review of M6 (23 Sep 2026) found against the elevated helper.
#[cfg(windows)]
pub fn plant_folder_link(target: &Path, at: &Path) -> Result<(), String> {
    let made = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(at)
        .arg(target)
        .output()
        .map_err(|e| format!("mklink /J: {e}"))?;
    if made.status.success() {
        Ok(())
    } else {
        Err(format!(
            "mklink /J {}: {}",
            at.display(),
            String::from_utf8_lossy(&made.stderr).trim()
        ))
    }
}

/// A symbolic link at `at` to the file `target`, which need not exist.
#[cfg(unix)]
pub fn plant_file_link(target: &Path, at: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, at).map_err(|e| format!("{}: {e}", at.display()))
}

/// A symbolic link at `at` to the file `target`, which need not exist. Unlike
/// a junction it takes the right to create symbolic links — an administrator,
/// as the CI runner is, or Developer Mode — and a test that cannot plant it
/// fails saying so rather than passing without it.
#[cfg(windows)]
pub fn plant_file_link(target: &Path, at: &Path) -> Result<(), String> {
    std::os::windows::fs::symlink_file(target, at).map_err(|e| {
        format!(
            "{}: {e} (a symbolic link needs an administrator or Developer Mode)",
            at.display()
        )
    })
}

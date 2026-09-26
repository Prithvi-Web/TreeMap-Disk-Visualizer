//! A real folder listed in parts (T6b; R89): a platform lister stops once its
//! listing holds its limit — inside a batch if it must, keeping the batch's
//! unread rest and its open descriptor or handle — and reads on from there,
//! giving exactly the entries, facts and order of the folder listed whole.
//! Each lister here lists a fresh temp folder of `BIG_LISTING` + 3,000 empty
//! files, removed at the end: macOS's bulk listing and its per-entry
//! fallback, Linux's `getdents64`, and Windows' `FileIdExtdDirectoryInfo` and
//! its `FindFirstFileExW` fallback (run by CI's Windows leg). A scripted
//! lister checks the helpers that read a stopped listing to its end.
#![cfg(any(target_os = "macos", target_os = "linux", windows))]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tm_walk::platform::{ListBuffer, Listed, Lister, Meta, list_whole};
use tm_walk::{BIG_LISTING, FastPath, KIND_FILE, Refusal};

type TestResult = Result<(), String>;

/// Files in the folder: past `BIG_LISTING`, as a big listing's are.
const FILES: usize = BIG_LISTING + 3_000;
/// The limits a listing in parts is read to: the first, 999, falls inside a
/// batch for every lister here, then a step each.
const FIRST_LIMIT: usize = 999;
const STEP: usize = 4_096;

/// A fresh temp folder of `FILES` empty files, removed when dropped.
struct Folder(PathBuf);

impl Folder {
    fn new(tag: &str) -> Result<Self, String> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let dir = std::env::temp_dir().join(format!(
            "tm-walk-parts-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let folder = Self(dir);
        for f in 0..FILES {
            let path = folder.0.join(format!("f{f:06}"));
            std::fs::write(&path, b"").map_err(|e| format!("{}: {e}", path.display()))?;
        }
        Ok(folder)
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// An entry's facts, floats by their bits (an access time not asked for is
/// NaN, which equals nothing).
type Facts = (Vec<u8>, u8, u8, u64, u64, u64, u64, u64, u128, u32, bool);

fn facts(name: &[u8], meta: &Meta) -> Facts {
    (
        name.to_vec(),
        meta.kind,
        meta.flags,
        meta.size.to_bits(),
        meta.alloc.to_bits(),
        meta.mtime_ms.to_bits(),
        meta.atime_ms.to_bits(),
        meta.dev.to_bits(),
        meta.ino,
        meta.nlink,
        meta.withheld,
    )
}

/// Each entry's name and facts, in order.
fn entries(buf: &ListBuffer) -> Vec<Facts> {
    buf.listing
        .entries
        .iter()
        .map(|entry| facts(buf.listing.name(entry), &entry.meta))
        .collect()
}

/// Listed whole, then in parts: the same entries, facts and order; each part
/// stopped at its limit exactly; the heartbeat beaten by both; no cursor left.
fn lists_in_parts_as_whole(lister: &dyn Lister, dir: &Path, fast_path: FastPath) -> TestResult {
    let mut whole = ListBuffer::new(0);
    let path = lister
        .list(dir, false, &mut whole)
        .map_err(|why| format!("whole: {why:?}"))?;
    assert_eq!(path, fast_path, "the whole listing's path");
    assert_eq!(whole.listing.len(), FILES, "every file listed");

    let mut parts = ListBuffer::new(0);
    let mut limit = FIRST_LIMIT;
    let mut answer = lister
        .list_until(dir, false, &mut parts, limit)
        .map_err(|why| format!("first part: {why:?}"))?;
    let mut stops = 0;
    while answer == Listed::More {
        assert_eq!(
            parts.listing.len(),
            limit,
            "a part stops at its limit exactly"
        );
        assert!(parts.has_cursor(), "a stopped listing keeps its cursor");
        stops += 1;
        limit += STEP;
        answer = lister
            .list_more(&mut parts, limit)
            .map_err(|why| format!("part {stops}: {why:?}"))?;
    }
    assert_eq!(answer, Listed::Complete(fast_path), "the parts' path");
    assert!(
        stops >= FILES / STEP,
        "{stops} stop(s): the listing was read in parts"
    );
    assert!(!parts.has_cursor(), "a complete listing leaves no cursor");
    assert!(
        entries(&parts) == entries(&whole),
        "listed in parts, the entries, their facts or their order differ"
    );
    // A stop issues no call and a resumed listing reads on in the batch it
    // stopped in: the same calls, so the same beats, one per batch.
    assert!(whole.heartbeat.load(Ordering::Acquire) > 0);
    assert_eq!(
        parts.heartbeat.load(Ordering::Acquire),
        whole.heartbeat.load(Ordering::Acquire),
        "one beat per batch, read whole or in parts"
    );
    Ok(())
}

#[cfg(target_os = "macos")]
#[test]
fn a_folder_listed_in_parts_through_getattrlistbulk_is_the_folder_listed_whole() -> TestResult {
    let folder = Folder::new("bulk")?;
    let lister = tm_walk::platform::darwin::DarwinLister::new();
    lists_in_parts_as_whole(&lister, &folder.0, FastPath::Bulk)
}

#[cfg(target_os = "macos")]
#[test]
fn a_folder_listed_in_parts_entry_by_entry_is_the_folder_listed_whole() -> TestResult {
    let folder = Folder::new("per-entry")?;
    let lister = tm_walk::platform::darwin::DarwinLister::per_entry_only();
    lists_in_parts_as_whole(&lister, &folder.0, FastPath::PerEntry)
}

#[cfg(target_os = "linux")]
#[test]
fn a_folder_listed_in_parts_through_getdents64_is_the_folder_listed_whole() -> TestResult {
    let folder = Folder::new("getdents")?;
    let lister = tm_walk::platform::linux::LinuxLister::new();
    lists_in_parts_as_whole(&lister, &folder.0, FastPath::Getdents)
}

#[cfg(windows)]
#[test]
fn a_folder_listed_in_parts_through_file_id_extd_dir_info_is_the_folder_listed_whole() -> TestResult
{
    let folder = Folder::new("extd")?;
    let lister = tm_walk::platform::windows::WindowsLister::new();
    lists_in_parts_as_whole(&lister, &folder.0, FastPath::ExtdDirInfo)
}

#[cfg(windows)]
#[test]
fn a_folder_listed_in_parts_through_find_first_file_is_the_folder_listed_whole() -> TestResult {
    let folder = Folder::new("find")?;
    let lister = tm_walk::platform::windows::WindowsLister::find_only();
    lists_in_parts_as_whole(&lister, &folder.0, FastPath::PerEntry)
}

/// Calls a stalled [`Drip`] answers before it gives up with `Vanished`, so
/// that a reader that never stops fails instead of hanging.
const DRIP_CALLS: usize = 100;

/// A lister that answers one entry a call and `More` until it has listed
/// `entries`, whatever limit it is given; or, when it `stalls`, `More`
/// without listing anything.
struct Drip {
    entries: usize,
    stalls: bool,
    calls: AtomicUsize,
}

/// A drip's place: the entries it has listed.
struct DripCursor(usize);

impl Drip {
    fn new(entries: usize, stalls: bool) -> Self {
        Self {
            entries,
            stalls,
            calls: AtomicUsize::new(0),
        }
    }

    fn step(&self, buf: &mut ListBuffer, listed: usize) -> Result<Listed, Refusal> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == DRIP_CALLS {
            return Err(Refusal::Vanished);
        }
        if !self.stalls {
            let name = format!("e{listed}");
            buf.listing.push(name.as_bytes(), Meta::unknown(KIND_FILE));
        }
        let listed = listed + usize::from(!self.stalls);
        if listed == self.entries {
            return Ok(Listed::Complete(FastPath::Unavailable));
        }
        buf.keep_cursor(DripCursor(listed));
        Ok(Listed::More)
    }
}

impl Lister for Drip {
    fn stat_dir(&self, _path: &Path, _want_atime: bool) -> Result<Meta, Refusal> {
        Err(Refusal::Vanished)
    }

    fn list(
        &self,
        dir: &Path,
        want_atime: bool,
        buf: &mut ListBuffer,
    ) -> Result<FastPath, Refusal> {
        list_whole(self, dir, want_atime, buf)
    }

    fn list_until(
        &self,
        _dir: &Path,
        _want_atime: bool,
        buf: &mut ListBuffer,
        _limit: usize,
    ) -> Result<Listed, Refusal> {
        buf.close_cursor();
        buf.listing.clear();
        self.step(buf, 0)
    }

    fn list_more(&self, buf: &mut ListBuffer, _limit: usize) -> Result<Listed, Refusal> {
        let DripCursor(listed) = buf.take_cursor::<DripCursor>().ok_or(Refusal::Unreadable)?;
        self.step(buf, listed)
    }
}

#[test]
fn a_listing_is_read_to_its_end_whatever_its_lister_answers_and_a_stalled_one_is_refused() {
    let dir = Path::new("/drip");
    let mut buf = ListBuffer::new(0);
    // A lister that stops even when no limit binds it is read on to the end.
    let drip = Drip::new(5, false);
    assert_eq!(drip.list(dir, false, &mut buf), Ok(FastPath::Unavailable));
    assert_eq!(buf.listing.len(), 5, "every entry");
    assert!(!buf.has_cursor(), "a complete listing leaves no cursor");
    // One that answers `More` without listing anything is refused at once,
    // not asked again and again, and its cursor is closed.
    let stalled = Drip::new(5, true);
    let refused = stalled.list(dir, false, &mut buf);
    assert_eq!(
        stalled.calls.load(Ordering::SeqCst),
        2,
        "its first answer and one that listed nothing"
    );
    assert_eq!(refused, Err(Refusal::Unreadable), "refused as unreadable");
    assert!(!buf.has_cursor(), "a refused listing leaves no cursor");
}

#[test]
fn a_stopped_listing_is_closed_by_close_cursor_and_by_the_next_listing() -> TestResult {
    let folder = Folder::new("closed")?;
    let lister = tm_walk::platform::platform_lister().map_err(|e| e.to_string())?;
    let mut buf = ListBuffer::new(0);
    let stop = |buf: &mut ListBuffer| -> TestResult {
        let answer = lister
            .list_until(&folder.0, false, buf, FIRST_LIMIT)
            .map_err(|why| format!("{why:?}"))?;
        assert_eq!(answer, Listed::More);
        assert!(buf.has_cursor(), "a stopped listing keeps its cursor");
        Ok(())
    };
    stop(&mut buf)?;
    buf.close_cursor();
    assert!(
        lister.list_more(&mut buf, usize::MAX).is_err(),
        "a closed listing was read on"
    );
    // A listing started in the buffer ends the one stopped there.
    stop(&mut buf)?;
    let answer = lister
        .list_until(&folder.0, false, &mut buf, usize::MAX)
        .map_err(|why| format!("{why:?}"))?;
    assert!(matches!(answer, Listed::Complete(_)), "{answer:?}");
    assert_eq!(buf.listing.len(), FILES, "the new listing, whole");
    assert!(!buf.has_cursor(), "the stopped listing was closed");
    Ok(())
}

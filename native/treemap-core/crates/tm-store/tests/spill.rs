//! Spill files (Phase 4 T13a; design §S.5.3), through the crate's public API: the folder
//! and its refusals, names checked part by part, a file that has no name while it is open
//! (POSIX) and gives back what was written at every offset, a descriptor no child process
//! inherits, and the kill test.
//!
//! **The kill test.** A helper process — this test binary run again, with
//! [`HELPER_ENV`] set — spills 256 MiB, says it is ready, and is killed with `SIGKILL`
//! (`TerminateProcess` on Windows). Afterwards `scan-spill` must hold no file and the
//! volume must have the bytes back. A second helper that keeps a named file of the same
//! size is the positive control: the same measurement must see its bytes as not freed,
//! so a pass cannot come from a measurement that sees nothing.
//!
//! Counted, never timed: the parent waits on the helper's "ready" line and on its exit
//! status, never on a clock. APFS frees an unlinked file's blocks lazily — measured on
//! this Mac on 28 Sep 2026, with a probe that killed a process holding 256 MiB unlinked:
//! 0 MiB back after the kill and the wait, however often free space was read, and the
//! 256 MiB back after one `sync()`, while a kept file's bytes stayed used — so the
//! parent asks for them with `sync()`, at most [`MAX_SYNCS`] times. The free space is
//! read here with the OS's own call, not through the crate, so the crate cannot vouch
//! for itself. The margin is half the bytes spilled: the probe's noise was within 10 MiB.
//!
//! One thing can still keep the bytes: an APFS snapshot (Time Machine's local ones are
//! hourly) taken while the helper's file was open holds its blocks after the kill. That
//! window is about a second per run; CI's macOS runners take no snapshots.

use std::io::{BufRead, BufReader, ErrorKind};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use tm_store::spill::{COLUMN_MAX, SCAN_ID_MAX, SPILL_DIR, SpillDir, SpillError, SpillName};

type TestResult = Result<(), String>;

/// Set in a helper's environment: `<role>|<argument>`.
const HELPER_ENV: &str = "TM_SPILL_TEST_HELPER";
/// The line a helper prints once its bytes are written.
const READY: &str = "tm-spill-helper-ready";
/// What a helper spills: far above the volume's noise, far inside the owner's 40 GB
/// test-data cap.
const SPILL_BYTES: u64 = 256 << 20;
/// The helper's write size.
const CHUNK: usize = 1 << 20;
/// How many `sync()` calls the parent makes, at most, before it reads the bytes as not
/// freed: counted, not timed, and far more than the one the probe needed, because APFS frees
/// the helper's files one after another in the background.
const MAX_SYNCS: u32 = 32;
/// How long a helper may take to say it is ready before it is taken for hung: a guard only,
/// far past the few seconds 256 MiB takes on a loaded machine.
const HANG_GUARD: Duration = Duration::from_secs(300);
/// A scan id as Node makes them (`crypto.randomUUID()`).
const UUID: &str = "3f2b1c4e-8a7d-4b6c-9e1f-0123456789ab";

/// The kill tests measure one volume's free space, so they take turns.
static MEASURING: Mutex<()> = Mutex::new(());

/// A folder of the test's own under the OS temp folder, removed with everything in it.
struct Scratch {
    dir: PathBuf,
}

static SCRATCHES: AtomicU32 = AtomicU32::new(0);

impl Scratch {
    fn new(tag: &str) -> Result<Self, String> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let n = SCRATCHES.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "tm-store-spill-{tag}-{}-{n}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        Ok(Self { dir })
    }

    fn spill_dir(&self) -> PathBuf {
        self.dir.join(SPILL_DIR)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // Only this test's own folder; a link inside it is removed, never followed.
        if self.dir.starts_with(std::env::temp_dir()) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

/// The names in `dir`.
fn names_in(dir: &Path) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| format!("{}: {e}", dir.display()))?;
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    Ok(names)
}

/// `len` bytes that differ from offset to offset, so a read at the wrong place shows.
fn pattern(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x.to_le_bytes()[0]
        })
        .collect()
}

// ---------------------------------------------------------------------------------------
// The folder

#[cfg(unix)]
#[test]
fn the_folder_is_made_for_this_user_alone() -> TestResult {
    use std::os::unix::fs::PermissionsExt;
    let scratch = Scratch::new("private")?;
    let dir = SpillDir::open(&scratch.dir).map_err(|e| e.to_string())?;
    assert_eq!(dir.path(), scratch.spill_dir());
    let mode = std::fs::metadata(scratch.spill_dir())
        .map_err(|e| e.to_string())?
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o700, "scan-spill is made mode 0700");
    Ok(())
}

#[cfg(unix)]
#[test]
fn a_folder_others_could_read_is_closed_to_them() -> TestResult {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let scratch = Scratch::new("tighten")?;
    std::fs::DirBuilder::new()
        .mode(0o755)
        .create(scratch.spill_dir())
        .map_err(|e| e.to_string())?;
    std::fs::set_permissions(scratch.spill_dir(), std::fs::Permissions::from_mode(0o755))
        .map_err(|e| e.to_string())?;
    SpillDir::open(&scratch.dir).map_err(|e| e.to_string())?;
    let mode = std::fs::metadata(scratch.spill_dir())
        .map_err(|e| e.to_string())?
        .permissions()
        .mode();
    assert_eq!(
        mode & 0o777,
        0o700,
        "an existing scan-spill of this user's is made 0700"
    );
    Ok(())
}

#[test]
fn a_link_in_place_of_the_folder_is_refused_and_where_it_leads_is_untouched() -> TestResult {
    let scratch = Scratch::new("link")?;
    let elsewhere = scratch.dir.join("elsewhere");
    std::fs::create_dir(&elsewhere).map_err(|e| e.to_string())?;
    plant_folder_link(&elsewhere, &scratch.spill_dir())?;
    match SpillDir::open(&scratch.dir) {
        Err(SpillError::DirRefused { why, .. }) => {
            assert!(why.contains("link"), "the reason names the link: {why}");
        }
        Err(other) => return Err(format!("refused for another reason: {other}")),
        Ok(_) => return Err("a link in place of scan-spill was taken".to_owned()),
    }
    assert!(
        names_in(&elsewhere)?.is_empty(),
        "nothing is made where the link leads"
    );
    Ok(())
}

#[test]
fn a_file_in_place_of_the_folder_is_refused_and_left_as_it_was() -> TestResult {
    let scratch = Scratch::new("file")?;
    std::fs::write(scratch.spill_dir(), b"not a folder").map_err(|e| e.to_string())?;
    match SpillDir::open(&scratch.dir) {
        Err(SpillError::DirRefused { why, .. }) => {
            assert!(why.contains("not a folder"), "the reason says so: {why}");
        }
        Err(other) => return Err(format!("refused for another reason: {other}")),
        Ok(_) => return Err("a file in place of scan-spill was taken".to_owned()),
    }
    let kept = std::fs::read(scratch.spill_dir()).map_err(|e| e.to_string())?;
    assert_eq!(kept, b"not a folder");
    Ok(())
}

/// App-data is Node's to make: a spill folder is made in it, never the folder itself.
#[test]
fn a_missing_app_data_folder_is_refused_and_not_made() -> TestResult {
    let scratch = Scratch::new("noappdata")?;
    let missing = scratch.dir.join("app-data");
    match SpillDir::open(&missing) {
        Err(SpillError::Io { call, .. }) => {
            assert!(
                call.contains("mkdir") || call.contains("CreateDirectory"),
                "{call}"
            );
        }
        Err(other) => return Err(format!("refused for another reason: {other}")),
        Ok(_) => return Err("a spill folder was made without its app-data".to_owned()),
    }
    assert!(!missing.exists(), "app-data is not made");
    Ok(())
}

/// A link at `at` to the folder `target`: a symbolic link.
#[cfg(unix)]
fn plant_folder_link(target: &Path, at: &Path) -> TestResult {
    std::os::unix::fs::symlink(target, at).map_err(|e| format!("{}: {e}", at.display()))
}

/// A link at `at` to the folder `target`: a directory junction, which any process of the
/// user can make without privilege.
#[cfg(windows)]
fn plant_folder_link(target: &Path, at: &Path) -> TestResult {
    let made = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(at)
        .arg(target)
        .output()
        .map_err(|e| format!("mklink: {e}"))?;
    if made.status.success() {
        Ok(())
    } else {
        Err(format!(
            "mklink /J failed: {}",
            String::from_utf8_lossy(&made.stderr)
        ))
    }
}

// ---------------------------------------------------------------------------------------
// Names

#[test]
fn a_name_is_the_pid_the_start_the_scan_and_the_column() -> TestResult {
    let name = SpillName::new(UUID, "nameOff_1").map_err(|e| e.to_string())?;
    let text = name.file_name();
    let parts: Vec<&str> = text.splitn(3, '-').collect();
    let [pid, start, rest] = parts.as_slice() else {
        return Err(format!("{text} has no pid and start"));
    };
    assert_eq!(
        *pid,
        std::process::id().to_string(),
        "the pid is this process's"
    );
    assert!(
        !start.is_empty() && start.bytes().all(|b| b.is_ascii_digit()),
        "the start is milliseconds: {start}"
    );
    // A time: when this process first named a spill file, in milliseconds since 1970. With the
    // pid it keeps an earlier process's leftover from taking this process's names, so it must
    // be no later than now, and past a floor (2020) any set clock is past.
    let start_ms: u128 = start.parse().map_err(|e| format!("{start}: {e}"))?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    assert!(
        start_ms > 1_600_000_000_000 && start_ms <= now_ms,
        "the start {start_ms} is not a time in this process's life (now {now_ms})"
    );
    assert_eq!(*rest, format!("{UUID}-nameOff_1"));
    assert_eq!(
        SpillName::new(UUID, "size")
            .map_err(|e| e.to_string())?
            .file_name()
            .rsplit_once('-')
            .map(|(head, _)| head.to_owned()),
        text.rsplit_once('-').map(|(head, _)| head.to_owned()),
        "every name of this process and scan starts the same way"
    );
    Ok(())
}

#[test]
fn every_part_of_a_name_is_checked() -> TestResult {
    let longest_id = "a".repeat(SCAN_ID_MAX);
    let longest_column = "c".repeat(COLUMN_MAX);
    for (scan_id, column) in [
        (UUID, "size"),
        (longest_id.as_str(), "size"),
        (UUID, longest_column.as_str()),
        ("scan_1", "links0"),
    ] {
        SpillName::new(scan_id, column)
            .map_err(|e| format!("{scan_id:?} / {column:?} was refused: {e}"))?;
    }
    let too_long_id = "a".repeat(SCAN_ID_MAX + 1);
    let too_long_column = "c".repeat(COLUMN_MAX + 1);
    for (scan_id, column, rule) in [
        ("", "size", "empty"),
        (too_long_id.as_str(), "size", "longer than"),
        ("a/b", "size", "character"),
        ("a\\b", "size", "character"),
        ("..", "size", "character"),
        ("../up", "size", "character"),
        ("a.b", "size", "character"),
        ("C:", "size", "character"),
        ("a\0b", "size", "character"),
        ("a b", "size", "character"),
        ("\u{e9}t\u{e9}", "size", "character"),
        (UUID, "", "empty"),
        (UUID, too_long_column.as_str(), "longer than"),
        (UUID, "name-off", "character"),
        (UUID, "a/b", "character"),
        (UUID, "..", "character"),
        (UUID, "x.y", "character"),
    ] {
        match SpillName::new(scan_id, column) {
            Err(SpillError::BadName { why, .. }) => assert!(
                why.contains(rule),
                "{scan_id:?} / {column:?}: the reason names the rule ({rule}): {why}"
            ),
            Err(other) => return Err(format!("{scan_id:?} / {column:?}: {other}")),
            Ok(name) => {
                return Err(format!(
                    "{scan_id:?} / {column:?} was taken as {}",
                    name.file_name()
                ));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// The file

#[cfg(unix)]
#[test]
fn a_spill_file_has_no_name_while_it_is_open() -> TestResult {
    let scratch = Scratch::new("noname")?;
    let dir = SpillDir::open(&scratch.dir).map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for column in ["parent", "size", "names"] {
        let name = SpillName::new(UUID, column).map_err(|e| e.to_string())?;
        let mut file = dir.create(&name).map_err(|e| e.to_string())?;
        file.append(b"rows").map_err(|e| e.to_string())?;
        files.push(file);
    }
    assert_eq!(
        names_in(&scratch.spill_dir())?,
        Vec::<String>::new(),
        "scan-spill holds no name for an open spill file"
    );
    for file in &files {
        let mut back = [0_u8; 4];
        file.read_exact_at(&mut back, 0)
            .map_err(|e| e.to_string())?;
        assert_eq!(&back, b"rows");
    }
    Ok(())
}

#[cfg(windows)]
#[test]
fn a_spill_file_is_named_only_while_it_is_open() -> TestResult {
    let scratch = Scratch::new("deleteonclose")?;
    let dir = SpillDir::open(&scratch.dir).map_err(|e| e.to_string())?;
    let name = SpillName::new(UUID, "size").map_err(|e| e.to_string())?;
    let file = dir.create(&name).map_err(|e| e.to_string())?;
    assert_eq!(names_in(&scratch.spill_dir())?, vec![name.file_name()]);
    drop(file);
    assert_eq!(
        names_in(&scratch.spill_dir())?,
        Vec::<String>::new(),
        "Windows removes the name with the last handle"
    );
    Ok(())
}

#[test]
fn bytes_come_back_from_the_offsets_they_were_written_at() -> TestResult {
    let scratch = Scratch::new("offsets")?;
    let dir = SpillDir::open(&scratch.dir).map_err(|e| e.to_string())?;
    let name = SpillName::new(UUID, "mtime").map_err(|e| e.to_string())?;
    let mut file = dir.create(&name).map_err(|e| e.to_string())?;
    let chunks: Vec<Vec<u8>> = [1, 4096, (1 << 20) + 3, 17, 0, 65_537]
        .iter()
        .zip(1_u64..)
        .map(|(&len, seed)| pattern(len, seed))
        .collect();
    assert!(file.is_empty(), "a new spill file holds nothing");
    let mut offsets = Vec::new();
    let mut end = 0_u64;
    for chunk in &chunks {
        let at = file.append(chunk).map_err(|e| e.to_string())?;
        assert_eq!(at, end, "each append starts where the last one ended");
        offsets.push(at);
        end += chunk.len() as u64;
        assert_eq!(file.len(), end, "the length is the bytes appended");
        assert_eq!(
            file.is_empty(),
            end == 0,
            "empty only until a byte is appended"
        );
    }
    // Read back in another order than written, each at its own offset.
    for i in [3, 0, 5, 1, 4, 2] {
        let (Some(chunk), Some(&at)) = (chunks.get(i), offsets.get(i)) else {
            return Err(format!("no chunk {i}"));
        };
        let mut back = vec![0_u8; chunk.len()];
        file.read_exact_at(&mut back, at)
            .map_err(|e| format!("chunk {i} at {at} did not come back: {e}"))?;
        assert!(back == *chunk, "chunk {i} at {at} came back changed");
    }
    // A read across three chunks' boundaries.
    let whole: Vec<u8> = chunks.concat();
    let (from, to) = (4000_usize, (1 << 20) + 4200);
    let mut across = vec![0_u8; to - from];
    file.read_exact_at(&mut across, from as u64)
        .map_err(|e| e.to_string())?;
    assert!(
        whole.get(from..to) == Some(across.as_slice()),
        "a read across chunks"
    );
    Ok(())
}

#[test]
fn a_read_past_what_was_written_is_refused() -> TestResult {
    let scratch = Scratch::new("pastend")?;
    let dir = SpillDir::open(&scratch.dir).map_err(|e| e.to_string())?;
    let name = SpillName::new(UUID, "flags").map_err(|e| e.to_string())?;
    let mut file = dir.create(&name).map_err(|e| e.to_string())?;
    file.append(&pattern(100, 7)).map_err(|e| e.to_string())?;
    let mut tail = [0_u8; 10];
    file.read_exact_at(&mut tail, 90)
        .map_err(|e| format!("the last ten bytes: {e}"))?;
    let mut past = [0_u8; 11];
    match file.read_exact_at(&mut past, 90) {
        Err(e) if e.kind() == ErrorKind::UnexpectedEof => {}
        Err(e) => return Err(format!("refused for another reason: {e}")),
        Ok(()) => return Err("a read one byte past the end was answered".to_owned()),
    }
    let mut none = [0_u8; 0];
    file.read_exact_at(&mut none, 100)
        .map_err(|e| format!("nothing at the end: {e}"))?;
    Ok(())
}

/// A failed append — here the file-size limit (`RLIMIT_FSIZE`) stopping a write half way,
/// as `ENOSPC` or `EIO` could — leaves the length where it was; a read past that length is
/// refused although the file holds the half-written bytes; and the next append writes over
/// them. In a child process, because the limit is the whole process's.
#[cfg(unix)]
#[test]
fn a_failed_append_leaves_the_length_where_it_was() -> TestResult {
    let scratch = Scratch::new("efbig")?;
    let out = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
        .args(["--exact", "helper", "--nocapture", "--test-threads=1"])
        .env(HELPER_ENV, format!("efbig|{}", scratch.dir.display()))
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("the child: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success()
            && text
                .lines()
                .any(|line| line.ends_with("tm-spill-helper-efbig ok")),
        "the child: {text}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(())
}

/// A spill file's descriptor must close in any child process the app starts (Node starts
/// several: gdu, the MFT helper, `git`...), or a child that outlives the scan would keep
/// the file's bytes on the disk. The child — this binary run again — looks through every
/// descriptor it holds for a nameless regular file of a size only this test writes.
#[cfg(unix)]
#[test]
fn a_child_process_does_not_inherit_a_spill_file() -> TestResult {
    const MARK: u64 = 777_777;
    let scratch = Scratch::new("cloexec")?;
    let dir = SpillDir::open(&scratch.dir).map_err(|e| e.to_string())?;
    let name = SpillName::new(UUID, "cloexec").map_err(|e| e.to_string())?;
    let mut file = dir.create(&name).map_err(|e| e.to_string())?;
    let bytes = usize::try_from(MARK).map_err(|e| e.to_string())?;
    file.append(&pattern(bytes, 3)).map_err(|e| e.to_string())?;
    let out = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
        .args(["--exact", "helper", "--nocapture", "--test-threads=1"])
        .env(HELPER_ENV, format!("fds|{MARK}"))
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("the child: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "the child failed: {text}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        text.lines()
            .any(|line| line.ends_with("tm-spill-helper-fds none")),
        "the child holds the spill file: {text}"
    );
    drop(file);
    Ok(())
}

/// Each file of a scan takes its own column. On POSIX a second file of a name whose first
/// has already lost it is made; on Windows, where the first keeps its name while it is open,
/// the second is refused as taken.
#[test]
fn a_name_used_twice_while_its_first_file_is_open() -> TestResult {
    let scratch = Scratch::new("twice")?;
    let dir = SpillDir::open(&scratch.dir).map_err(|e| e.to_string())?;
    let name = SpillName::new(UUID, "twice").map_err(|e| e.to_string())?;
    let first = dir.create(&name).map_err(|e| e.to_string())?;
    let second = dir.create(&name);
    #[cfg(unix)]
    second.map_err(|e| format!("the second file of the name: {e}"))?;
    #[cfg(windows)]
    assert!(
        matches!(second, Err(SpillError::NameTaken { .. })),
        "the second file of the name is refused while the first is open"
    );
    drop(first);
    Ok(())
}

/// Windows makes files by path, so the folder is held open, sharing no deletion, for as long
/// as spill files are made in it: no process can move it and put a junction in its place.
#[cfg(windows)]
#[test]
fn the_folder_cannot_be_moved_while_spill_files_are_made_in_it() -> TestResult {
    let scratch = Scratch::new("held")?;
    let dir = SpillDir::open(&scratch.dir).map_err(|e| e.to_string())?;
    let moved = scratch.dir.join("moved");
    assert!(
        std::fs::rename(scratch.spill_dir(), &moved).is_err(),
        "the folder was moved while it was held"
    );
    drop(dir);
    std::fs::rename(scratch.spill_dir(), &moved).map_err(|e| format!("once let go: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// The kill test

#[test]
fn a_killed_spiller_leaves_no_file_and_the_volume_gets_its_bytes_back() -> TestResult {
    let _turn = MEASURING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let scratch = Scratch::new("kill")?;
    let seen = kill_a_helper("spill", &scratch)?;
    println!("spilled and killed: {seen:?}");
    assert!(
        seen.drop_while_alive >= half(),
        "the helper's bytes were not seen on the volume while it ran: {seen:?}"
    );
    assert_eq!(
        seen.left_in_folder,
        Vec::<String>::new(),
        "scan-spill holds a file after the kill: {seen:?}"
    );
    assert!(
        seen.back_after_kill >= half(),
        "the volume did not get the bytes back after {} syncs: {seen:?}",
        seen.syncs
    );
    Ok(())
}

/// The positive control: a helper that keeps a named file of the same size, killed the
/// same way, must be seen by the same measurement as not freed — a name left in the
/// folder and the bytes still used.
#[test]
fn a_killed_process_that_kept_its_file_is_seen_as_not_freed() -> TestResult {
    let _turn = MEASURING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let scratch = Scratch::new("keep")?;
    let seen = kill_a_helper("keep", &scratch)?;
    println!("kept and killed: {seen:?}");
    assert!(
        seen.drop_while_alive >= half(),
        "the helper's bytes were not seen on the volume while it ran: {seen:?}"
    );
    assert_eq!(
        seen.left_in_folder.len(),
        1,
        "the kept file is seen in the folder: {seen:?}"
    );
    assert!(
        seen.back_after_kill < half(),
        "a kept file's bytes were read as freed: {seen:?}"
    );
    Ok(())
}

/// What the parent saw of one helper: the free bytes lost while it ran, the names left in
/// `scan-spill` after the kill, and the free bytes regained after it (all signed: a volume
/// in use moves either way).
#[derive(Debug)]
struct KillSeen {
    drop_while_alive: i128,
    left_in_folder: Vec<String>,
    back_after_kill: i128,
    syncs: u32,
}

fn half() -> i128 {
    i128::from(SPILL_BYTES / 2)
}

/// Runs a helper in `role` against `scratch`, kills it once it is ready, and measures.
fn kill_a_helper(role: &str, scratch: &Scratch) -> Result<KillSeen, String> {
    flush_volume();
    let before = free_bytes(&scratch.dir)?;
    let mut child = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
        .args(["--exact", "helper", "--nocapture", "--test-threads=1"])
        .env(HELPER_ENV, format!("{role}|{}", scratch.dir.display()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("the helper: {e}"))?;
    if let Err(e) = wait_for_ready(&mut child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    flush_volume();
    let alive = free_bytes(&scratch.dir)?;
    child.kill().map_err(|e| format!("the kill: {e}"))?;
    let status = child.wait().map_err(|e| format!("the wait: {e}"))?;
    assert!(!status.success(), "the helper ended on its own: {status:?}");
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(
            status.signal(),
            Some(9),
            "the helper was killed: {status:?}"
        );
    }
    let left_in_folder = names_in(&scratch.spill_dir())?;
    let mut syncs = 0;
    let mut back = i128::from(free_bytes(&scratch.dir)?) - i128::from(alive);
    while back < half() && syncs < MAX_SYNCS {
        flush_volume();
        syncs += 1;
        back = i128::from(free_bytes(&scratch.dir)?) - i128::from(alive);
    }
    Ok(KillSeen {
        drop_while_alive: i128::from(before) - i128::from(alive),
        left_in_folder,
        back_after_kill: back,
        syncs,
    })
}

/// Waits for the helper's ready line, or fails with what it said instead. The line is read
/// on a thread of its own so that a helper that neither says it nor ends is killed after
/// [`HANG_GUARD`] rather than holding the suite: the clock guards a hang and decides
/// nothing else.
fn wait_for_ready(child: &mut Child) -> TestResult {
    let out = child.stdout.take().ok_or("the helper has no stdout")?;
    let (said, heard) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let _ = said.send(read_until_ready(out));
    });
    let ready = heard.recv_timeout(HANG_GUARD).unwrap_or_else(|_| {
        Err(format!(
            "the helper was neither ready nor ended after {} s",
            HANG_GUARD.as_secs()
        ))
    });
    if ready.is_err() {
        // Ends the reader's read with the pipe.
        let _ = child.kill();
    }
    let _ = reader.join();
    ready
}

fn read_until_ready(out: ChildStdout) -> TestResult {
    let mut said = Vec::new();
    for line in BufReader::new(out).lines() {
        let line = line.map_err(|e| format!("the helper's output: {e}"))?;
        // libtest prints "test helper ... " before the test runs, with no newline.
        if line.ends_with(READY) {
            return Ok(());
        }
        said.push(line);
    }
    Err(format!(
        "the helper ended without being ready: {}",
        said.join("\n")
    ))
}

/// Asks the OS to write out what it holds for every volume (`sync()`): APFS makes an
/// unlinked file's freed blocks count only then. Windows frees them when the last handle
/// closes, and has no such call for a process without privilege.
fn flush_volume() {
    #[cfg(unix)]
    // SAFETY: `sync` takes no arguments and touches no memory of this process.
    unsafe {
        libc::sync();
    }
}

/// The bytes free for an unprivileged user on the volume holding `path`, from the OS's
/// own call: `statfs` on macOS (its `statvfs` counts in 32 bits), `statvfs` on Linux,
/// `GetDiskFreeSpaceExW` on Windows.
fn free_bytes(path: &Path) -> Result<u64, String> {
    os_free_bytes(path).map_err(|e| format!("the free space of {}: {e}", path.display()))
}

#[cfg(target_os = "macos")]
fn os_free_bytes(path: &Path) -> std::io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    let mut facts = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: `c` is a NUL-terminated path that outlives the call; `facts` is writable
    // for one `statfs`, which the call fills when it answers 0.
    if unsafe { libc::statfs(c.as_ptr(), facts.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: the call answered 0, so it filled `facts`.
    let facts = unsafe { facts.assume_init() };
    Ok(facts.f_bavail.saturating_mul(u64::from(facts.f_bsize)))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn os_free_bytes(path: &Path) -> std::io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    let mut facts = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `c` is a NUL-terminated path that outlives the call; `facts` is writable
    // for one `statvfs`, which the call fills when it answers 0.
    if unsafe { libc::statvfs(c.as_ptr(), facts.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: the call answered 0, so it filled `facts`.
    let facts = unsafe { facts.assume_init() };
    #[expect(
        clippy::useless_conversion,
        reason = "the fields are u64 on 64-bit Linux and narrower elsewhere"
    )]
    let free = u64::from(facts.f_bavail).saturating_mul(u64::from(facts.f_frsize));
    Ok(free)
}

#[cfg(windows)]
fn os_free_bytes(path: &Path) -> std::io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDiskFreeSpaceExW(
            directory: *const u16,
            free_to_caller: *mut u64,
            total: *mut u64,
            total_free: *mut u64,
        ) -> i32;
    }
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut free = 0_u64;
    // SAFETY: `wide` is NUL-terminated and outlives the call; `free` is a live u64 the
    // call writes; the other two answers are declined with null pointers.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &raw mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(free)
}

// ---------------------------------------------------------------------------------------
// The helper

/// This binary run as a helper ([`HELPER_ENV`] set); otherwise it does nothing.
///
/// * `spill|<app-data>`: spills [`SPILL_BYTES`] through the crate into four files, says
///   [`READY`], and waits on its stdin until it is killed.
/// * `keep|<app-data>`: the same bytes in one named file in `scan-spill` that it keeps.
/// * `efbig|<app-data>`: has an append fail half way, and checks what is left.
/// * `fds|<size>`: says whether it holds a nameless regular file of `<size>` bytes.
#[test]
fn helper() -> TestResult {
    let Ok(spec) = std::env::var(HELPER_ENV) else {
        return Ok(());
    };
    let (role, argument) = spec.split_once('|').ok_or("no role")?;
    match role {
        "spill" => spill_and_wait(Path::new(argument)),
        "keep" => keep_and_wait(Path::new(argument)),
        #[cfg(unix)]
        "efbig" => fail_an_append(Path::new(argument)),
        #[cfg(unix)]
        "fds" => {
            report_inherited(argument.parse().map_err(|_| "a size")?);
            Ok(())
        }
        other => Err(format!("no helper role {other}")),
    }
}

fn spill_and_wait(app_data: &Path) -> TestResult {
    let dir = SpillDir::open(app_data).map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for column in ["parent", "size", "mtime", "names"] {
        let name = SpillName::new(UUID, column).map_err(|e| e.to_string())?;
        files.push(dir.create(&name).map_err(|e| e.to_string())?);
    }
    let chunk = pattern(CHUNK, 11);
    let mut written = 0_u64;
    while written < SPILL_BYTES {
        for file in &mut files {
            file.append(&chunk).map_err(|e| e.to_string())?;
            written += CHUNK as u64;
        }
    }
    wait_to_be_killed(files.len())
}

fn keep_and_wait(app_data: &Path) -> TestResult {
    use std::io::Write;
    let spill = app_data.join(SPILL_DIR);
    std::fs::create_dir_all(&spill).map_err(|e| e.to_string())?;
    let path = spill.join(format!("kept-{}", std::process::id()));
    let mut file = std::fs::File::create_new(&path).map_err(|e| e.to_string())?;
    let chunk = pattern(CHUNK, 11);
    let mut written = 0_u64;
    while written < SPILL_BYTES {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        written += CHUNK as u64;
    }
    wait_to_be_killed(1)
}

/// Says [`READY`] and blocks on stdin, which the parent never writes to or closes before
/// it kills this process.
fn wait_to_be_killed(files: usize) -> TestResult {
    use std::io::{Read, Write};
    let mut out = std::io::stdout();
    writeln!(out, "\n{READY}").map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())?;
    let mut byte = [0_u8; 1];
    let _ = std::io::stdin().read(&mut byte);
    Err(format!(
        "the helper holding {files} files was let go rather than killed"
    ))
}

#[cfg(unix)]
fn fail_an_append(app_data: &Path) -> TestResult {
    // SAFETY: the signal a write past the file-size limit raises is ignored, so the write
    // fails with `EFBIG` instead of ending this helper; no memory is touched.
    unsafe { libc::signal(libc::SIGXFSZ, libc::SIG_IGN) };
    let dir = SpillDir::open(app_data).map_err(|e| e.to_string())?;
    let name = SpillName::new(UUID, "efbig").map_err(|e| e.to_string())?;
    let mut file = dir.create(&name).map_err(|e| e.to_string())?;
    let (first, second, third) = (pattern(100, 5), pattern(100, 6), pattern(100, 7));
    file.append(&first).map_err(|e| e.to_string())?;
    let open_limit = file_size_limit(150)?;
    let failed = file.append(&second);
    file_size_limit(open_limit)?;
    if failed.is_ok() {
        return Err("an append past the file-size limit succeeded".to_owned());
    }
    if file.len() != 100 {
        return Err(format!(
            "a failed append moved the length to {}",
            file.len()
        ));
    }
    let mut past = [0_u8; 20];
    match file.read_exact_at(&mut past, 100) {
        Err(e) if e.kind() == ErrorKind::UnexpectedEof => {}
        other => {
            return Err(format!(
                "a read past the length, into half-written bytes: {other:?}"
            ));
        }
    }
    let at = file.append(&third).map_err(|e| e.to_string())?;
    if at != 100 {
        return Err(format!("the next append started at {at}"));
    }
    let mut back = vec![0_u8; 200];
    file.read_exact_at(&mut back, 0)
        .map_err(|e| e.to_string())?;
    if back != [first, third].concat() {
        return Err("the bytes came back changed".to_owned());
    }
    println!("\ntm-spill-helper-efbig ok");
    Ok(())
}

/// Sets this process's file-size limit (`RLIMIT_FSIZE`, the soft one) and answers the one it
/// replaced.
#[cfg(unix)]
fn file_size_limit(bytes: libc::rlim_t) -> Result<libc::rlim_t, String> {
    let mut limit = std::mem::MaybeUninit::<libc::rlimit>::uninit();
    // SAFETY: `limit` is writable for one `rlimit`, which the call fills when it answers 0.
    if unsafe { libc::getrlimit(libc::RLIMIT_FSIZE, limit.as_mut_ptr()) } != 0 {
        return Err(format!("getrlimit: {}", std::io::Error::last_os_error()));
    }
    // SAFETY: the call answered 0, so it filled `limit`.
    let mut limit = unsafe { limit.assume_init() };
    let was = limit.rlim_cur;
    limit.rlim_cur = bytes;
    // SAFETY: `limit` is a live `rlimit` the call only reads.
    if unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &raw const limit) } != 0 {
        return Err(format!("setrlimit: {}", std::io::Error::last_os_error()));
    }
    Ok(was)
}

#[cfg(unix)]
fn report_inherited(size: u64) {
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::io::FromRawFd;
    let mut found = Vec::new();
    for fd in 0..4096 {
        // SAFETY: `F_GETFD` reads a descriptor's flags and touches no memory; an fd that
        // is not open answers -1.
        if unsafe { libc::fcntl(fd, libc::F_GETFD) } < 0 {
            continue;
        }
        // SAFETY: `fd` is open in this process (checked above) and duplicated, so the
        // `File` owns a descriptor of its own and closes only that.
        let dup = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
        if dup < 0 {
            continue;
        }
        // SAFETY: `dup` was just made and nothing else owns it.
        let file = unsafe { std::fs::File::from_raw_fd(dup) };
        if let Ok(meta) = file.metadata()
            && meta.is_file()
            && meta.nlink() == 0
            && meta.len() == size
        {
            found.push(fd);
        }
    }
    if found.is_empty() {
        println!("\ntm-spill-helper-fds none");
    } else {
        println!("\ntm-spill-helper-fds inherited {found:?}");
    }
}

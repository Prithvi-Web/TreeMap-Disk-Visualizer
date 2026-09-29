//! `spill_plan` and the ledger (Phase 4 T13b; design §S.3's disk rule, §S.5.4): what a
//! spill writes, from the rule; each rule that refuses a spill, with its exact sentence,
//! against a fake file system; the ledger across plans; the boundaries of the 3× rule and
//! of the in-walk check; and the OS's own facts on this machine.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use tm_store::spill::{
    FREE_RESERVE, FileSystem, IN_WALK_CHECK_EVERY, Ledger, OsVolumes, Platform, SpillBytes,
    SpillRefusal, SpillRequest, VolumeFacts, VolumeId, VolumeSource, bytes_text, in_walk_check,
    spill_bytes, spill_plan,
};

type TestResult = Result<(), String>;

const APP_DATA: &str = "app-data";
const ROOT: &str = "scanned";
const GIB: u64 = 1 << 30;
const GB: u64 = 1_000_000_000;

/// A file system that answers from a table: each path's facts, or an error.
#[derive(Default)]
struct FakeVolumes {
    facts: HashMap<PathBuf, Result<VolumeFacts, String>>,
}

impl FakeVolumes {
    fn with(mut self, path: &str, facts: Result<VolumeFacts, &str>) -> Self {
        self.facts
            .insert(PathBuf::from(path), facts.map_err(str::to_owned));
        self
    }
}

impl VolumeSource for FakeVolumes {
    fn facts(&self, path: &Path) -> io::Result<VolumeFacts> {
        match self.facts.get(path) {
            Some(Ok(facts)) => Ok(facts.clone()),
            Some(Err(why)) => Err(io::Error::other(why.clone())),
            None => Err(io::Error::from(io::ErrorKind::NotFound)),
        }
    }
}

/// A local APFS volume of 500 GB with `free` bytes free.
fn local(free: u64, volume: &str) -> VolumeFacts {
    VolumeFacts {
        free_bytes: free,
        total_bytes: 500 * GB,
        file_system: FileSystem::Named("apfs".to_owned()),
        volume: VolumeId(volume.to_owned()),
    }
}

/// App-data and the scanned root on one local volume with `free` bytes free.
fn one_volume(free: u64) -> FakeVolumes {
    FakeVolumes::default()
        .with(APP_DATA, Ok(local(free, "disk1")))
        .with(ROOT, Ok(local(free, "disk1")))
}

fn request(projected_entries: u64, platform: Platform) -> SpillRequest<'static> {
    SpillRequest {
        projected_entries,
        platform,
        app_data_dir: Path::new(APP_DATA),
        scanned_root: Path::new(ROOT),
        app_data_writable: true,
    }
}

/// What the rule asks for: three times the bytes written, and 1 GiB.
fn asks(bytes: SpillBytes) -> u64 {
    3 * bytes.total() + FREE_RESERVE
}

// ---------------------------------------------------------------------------------------
// The bytes a spill writes

#[test]
fn the_bytes_a_spill_writes_follow_the_rule() {
    // 10M entries: 1.5M folders, 8.5M files, 85,000 of them keyed on POSIX.
    assert_eq!(
        spill_bytes(10_000_000, Platform::Posix),
        SpillBytes {
            columns: 680_000_000,
            folder_logs: 48_000_000,
            link_log: 6_800_000,
        }
    );
    // Windows keys every file.
    assert_eq!(
        spill_bytes(10_000_000, Platform::Windows),
        SpillBytes {
            columns: 680_000_000,
            folder_logs: 48_000_000,
            link_log: 680_000_000,
        }
    );
    // DESIGN §7's table, row by row: entries, platform, the link log, the bytes written and
    // what the rule asks for. 6.25M is the overflow target's `capRows` (§S.1.1).
    for (entries, platform, link_log, writes, asked) in [
        (
            6_250_000,
            Platform::Posix,
            4_250_000,
            459_250_000,
            2_451_491_824,
        ),
        (
            6_250_000,
            Platform::Windows,
            425_000_000,
            880_000_000,
            3_713_741_824,
        ),
        (
            10_000_000,
            Platform::Posix,
            6_800_000,
            734_800_000,
            3_278_141_824,
        ),
        (
            10_000_000,
            Platform::Windows,
            680_000_000,
            1_408_000_000,
            5_297_741_824,
        ),
        (
            100_000_000,
            Platform::Posix,
            68_000_000,
            7_348_000_000,
            23_117_741_824,
        ),
        (
            100_000_000,
            Platform::Windows,
            6_800_000_000,
            14_080_000_000,
            43_313_741_824_u64,
        ),
    ] {
        let bytes = spill_bytes(entries, platform);
        assert_eq!(bytes.link_log, link_log, "{entries} {platform:?}");
        assert_eq!(bytes.total(), writes, "{entries} {platform:?}");
        assert_eq!(asks(bytes), asked, "{entries} {platform:?}");
    }
    // Shares round up: 7 entries hold 2 folders (1.05 → 2) and 5 files, one of them keyed
    // on POSIX (0.05 → 1).
    assert_eq!(
        spill_bytes(7, Platform::Posix),
        SpillBytes {
            columns: 7 * 68,
            folder_logs: 2 * 32,
            link_log: 80,
        }
    );
    assert_eq!(spill_bytes(0, Platform::Posix).total(), 0);
    // Past any real tree each term saturates rather than wraps (a wrapped term would still
    // saturate the total, so the terms are what shows it).
    assert_eq!(
        spill_bytes(u64::MAX, Platform::Windows),
        SpillBytes {
            columns: u64::MAX,
            folder_logs: u64::MAX,
            link_log: u64::MAX,
        }
    );
    assert_eq!(spill_bytes(u64::MAX, Platform::Windows).total(), u64::MAX);
}

// ---------------------------------------------------------------------------------------
// The rules, one at a time, each with its sentence

#[test]
fn spill_is_allowed_at_exactly_three_times_its_bytes_and_a_gibibyte() -> TestResult {
    let bytes = spill_bytes(10_000_000, Platform::Posix);
    let ledger = Ledger::new();
    let plan = spill_plan(
        &request(10_000_000, Platform::Posix),
        &one_volume(asks(bytes)),
        &ledger,
    );
    let reservation = plan.verdict.as_ref().map_err(ToString::to_string)?;
    assert_eq!(
        reservation.bytes(),
        bytes.total(),
        "it reserves what it writes"
    );
    assert_eq!(ledger.reserved(), bytes.total());
    assert_eq!(plan.bytes, bytes);
    assert_eq!(plan.free_bytes, Some(asks(bytes)));
    assert_eq!(plan.reserved_elsewhere, 0);
    Ok(())
}

#[test]
fn one_byte_short_of_the_rule_is_refused_with_what_it_needs() {
    let bytes = spill_bytes(10_000_000, Platform::Posix);
    let ledger = Ledger::new();
    let plan = spill_plan(
        &request(10_000_000, Platform::Posix),
        &one_volume(asks(bytes) - 1),
        &ledger,
    );
    let refusal = plan.verdict.err();
    assert_eq!(
        refusal,
        Some(SpillRefusal::NotEnoughSpace {
            needs: asks(bytes),
            writes: bytes.total(),
            free: asks(bytes) - 1,
            reserved: 0,
        })
    );
    assert_eq!(
        refusal.map(|r| r.to_string()).as_deref(),
        Some(
            "spilling this scan needs 3.1 GB free on the volume of TreeMap's data folder: \
             three times the 700.8 MB it would write, and 1.0 GB to spare; 3.1 GB is free"
        )
    );
    assert_eq!(ledger.reserved(), 0, "a refused plan reserves nothing");
}

#[test]
fn a_read_only_session_is_refused_before_anything_else() {
    let ledger = Ledger::new();
    // A network file system and no free space as well: the first rule is the one named.
    let volumes = FakeVolumes::default()
        .with(
            APP_DATA,
            Ok(VolumeFacts {
                file_system: FileSystem::Named("smbfs".to_owned()),
                ..local(0, "share")
            }),
        )
        .with(ROOT, Ok(local(0, "disk1")));
    let mut req = request(10_000_000, Platform::Posix);
    req.app_data_writable = false;
    let plan = spill_plan(&req, &volumes, &ledger);
    let refusal = plan.verdict.err();
    assert_eq!(refusal, Some(SpillRefusal::AppDataReadOnly));
    assert_eq!(
        refusal.map(|r| r.to_string()).as_deref(),
        Some(
            "TreeMap's data folder cannot be written in this session (a read-only portable \
             drive), so a scan has nowhere to spill to"
        )
    );
}

#[test]
fn a_volume_whose_facts_cannot_be_read_is_refused() {
    let ledger = Ledger::new();
    let volumes = FakeVolumes::default()
        .with(APP_DATA, Err("the disk went away"))
        .with(ROOT, Ok(local(900 * GB, "disk1")));
    let plan = spill_plan(&request(10_000_000, Platform::Posix), &volumes, &ledger);
    assert_eq!(plan.free_bytes, None);
    let refusal = plan.verdict.err();
    assert_eq!(
        refusal.map(|r| r.to_string()).as_deref(),
        Some(
            "the free space of the volume holding TreeMap's data folder could not be read \
             (the disk went away), so a scan does not spill there"
        )
    );
}

#[test]
fn network_file_systems_are_refused_in_every_spelling() -> TestResult {
    let network = [
        (FileSystem::Named("smbfs".to_owned()), "smbfs"),
        (FileSystem::Named("nfs".to_owned()), "nfs"),
        (FileSystem::Named("afpfs".to_owned()), "afpfs"),
        (FileSystem::Named("webdav".to_owned()), "webdav"),
        (FileSystem::Named("macfuse".to_owned()), "fuse (macfuse)"),
        (FileSystem::Named("osxfuse".to_owned()), "fuse (osxfuse)"),
        (FileSystem::Named("fusefs".to_owned()), "fuse (fusefs)"),
        (FileSystem::Magic(0x6969), "nfs"),
        (FileSystem::Magic(0x517B), "smbfs"),
        (FileSystem::Magic(0xFF53_4D42), "smbfs (cifs)"),
        (FileSystem::Magic(0xFE53_4D42), "smbfs (smb2)"),
        (FileSystem::Magic(0x6573_5546), "fuse"),
        (FileSystem::Magic(0x7375_7245), "coda"),
        (FileSystem::DriveType(4), "a network drive"),
    ];
    for (file_system, named) in network {
        let ledger = Ledger::new();
        let volumes = FakeVolumes::default()
            .with(
                APP_DATA,
                Ok(VolumeFacts {
                    file_system: file_system.clone(),
                    ..local(900 * GB, "share")
                }),
            )
            .with(ROOT, Ok(local(900 * GB, "disk1")));
        let plan = spill_plan(&request(1_000, Platform::Posix), &volumes, &ledger);
        let said = plan.verdict.err().map(|r| r.to_string());
        assert_eq!(
            said,
            Some(format!(
                "TreeMap's data folder is on a network file system ({named}); a file removed \
                 while it is open can be left there under another name, so a scan does not \
                 spill there"
            )),
            "{file_system:?}"
        );
    }
    let local_ones = [
        FileSystem::Named("apfs".to_owned()),
        FileSystem::Named("hfs".to_owned()),
        FileSystem::Named("msdos".to_owned()),
        FileSystem::Magic(0xEF53),
        FileSystem::Magic(0x5846_5342),
        FileSystem::Magic(0x0102_1994),
        FileSystem::DriveType(3),
        FileSystem::DriveType(2),
    ];
    for file_system in local_ones {
        let ledger = Ledger::new();
        let volumes = FakeVolumes::default()
            .with(
                APP_DATA,
                Ok(VolumeFacts {
                    file_system: file_system.clone(),
                    ..local(900 * GB, "disk1")
                }),
            )
            .with(ROOT, Ok(local(900 * GB, "disk1")));
        let plan = spill_plan(&request(1_000, Platform::Posix), &volumes, &ledger);
        plan.verdict
            .as_ref()
            .map_err(|r| format!("{file_system:?} was refused: {r}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// The ledger

#[test]
fn the_ledger_counts_other_spills_until_they_are_released() -> TestResult {
    let bytes = spill_bytes(10_000_000, Platform::Posix);
    // Room for one spill of this size and not two.
    let free = asks(bytes) + bytes.total() - 1;
    let ledger = Ledger::new();
    let first = spill_plan(
        &request(10_000_000, Platform::Posix),
        &one_volume(free),
        &ledger,
    );
    let held = first.verdict.map_err(|r| r.to_string())?;
    assert_eq!(ledger.reserved(), bytes.total());

    let second = spill_plan(
        &request(10_000_000, Platform::Posix),
        &one_volume(free),
        &ledger,
    );
    assert_eq!(second.reserved_elsewhere, bytes.total());
    let refusal = second.verdict.err();
    assert_eq!(
        refusal,
        Some(SpillRefusal::NotEnoughSpace {
            needs: asks(bytes),
            writes: bytes.total(),
            free,
            reserved: bytes.total(),
        })
    );
    assert_eq!(
        refusal.map(|r| r.to_string()).as_deref(),
        Some(
            "spilling this scan needs 3.1 GB free on the volume of TreeMap's data folder: \
             three times the 700.8 MB it would write, and 1.0 GB to spare; 3.7 GB is free, \
             and other scans' spills have reserved 700.8 MB of it"
        )
    );
    assert_eq!(
        ledger.reserved(),
        bytes.total(),
        "the refusal reserved nothing"
    );

    drop(held);
    assert_eq!(
        ledger.reserved(),
        0,
        "the first spill's bytes are given back"
    );
    let third = spill_plan(
        &request(10_000_000, Platform::Posix),
        &one_volume(free),
        &ledger,
    );
    let _allowed = third
        .verdict
        .map_err(|r| format!("after the release: {r}"))?;
    Ok(())
}

#[test]
fn the_ledger_holds_every_reservation_until_each_is_dropped() -> TestResult {
    let ledger = Ledger::new();
    let small = spill_bytes(1_000_000, Platform::Posix);
    let large = spill_bytes(5_000_000, Platform::Windows);
    let a = spill_plan(
        &request(1_000_000, Platform::Posix),
        &one_volume(900 * GB),
        &ledger,
    )
    .verdict
    .map_err(|r| r.to_string())?;
    let b = spill_plan(
        &request(5_000_000, Platform::Windows),
        &one_volume(900 * GB),
        &ledger,
    )
    .verdict
    .map_err(|r| r.to_string())?;
    assert_eq!(ledger.reserved(), small.total() + large.total());
    drop(a);
    assert_eq!(ledger.reserved(), large.total());
    drop(b);
    assert_eq!(ledger.reserved(), 0);
    Ok(())
}

/// The ledger every scan of the process plans against is one ledger: a reservation made
/// through one call is seen through the next. No other test here uses it.
#[test]
fn the_process_ledger_is_one_ledger() -> TestResult {
    let before = Ledger::process().reserved();
    let bytes = spill_bytes(1_000_000, Platform::Posix);
    let plan = spill_plan(
        &request(1_000_000, Platform::Posix),
        &one_volume(900 * GB),
        Ledger::process(),
    );
    let held = plan.verdict.map_err(|r| r.to_string())?;
    assert_eq!(Ledger::process().reserved(), before + bytes.total());
    drop(held);
    assert_eq!(Ledger::process().reserved(), before);
    Ok(())
}

/// The check and the reservation are one step under the ledger's lock: of many plans made at
/// once against room for exactly one, exactly one is allowed, round after round.
#[test]
fn plans_made_at_once_share_the_room_between_them() {
    const PLANS: usize = 32;
    const ROUNDS: usize = 20;
    let bytes = spill_bytes(10_000_000, Platform::Posix);
    let free = asks(bytes) + bytes.total() - 1;
    for round in 0..ROUNDS {
        let ledger = Ledger::new();
        let start = std::sync::Barrier::new(PLANS);
        let allowed = std::thread::scope(|scope| {
            let plans: Vec<_> = (0..PLANS)
                .map(|_| {
                    scope.spawn(|| {
                        start.wait();
                        spill_plan(
                            &request(10_000_000, Platform::Posix),
                            &one_volume(free),
                            &ledger,
                        )
                        .verdict
                    })
                })
                .collect();
            // Every verdict is held until all are in, so no reservation is given back early.
            let verdicts: Vec<_> = plans
                .into_iter()
                .filter_map(|plan| plan.join().ok())
                .collect();
            assert_eq!(
                verdicts.len(),
                PLANS,
                "round {round}: a plan's thread failed"
            );
            verdicts.iter().filter(|verdict| verdict.is_ok()).count()
        });
        assert_eq!(allowed, 1, "round {round}: plans allowed at once");
        assert_eq!(
            ledger.reserved(),
            0,
            "round {round}: every reservation given back"
        );
    }
}

// ---------------------------------------------------------------------------------------
// The same volume: reported, never a refusal

#[test]
fn the_same_volume_is_reported_and_never_refuses() -> TestResult {
    let ledger = Ledger::new();
    let same = spill_plan(
        &request(1_000, Platform::Posix),
        &one_volume(900 * GB),
        &ledger,
    );
    assert_eq!(same.same_volume, Some(true));
    let _allowed = same.verdict.map_err(|r| r.to_string())?;

    let apart = FakeVolumes::default()
        .with(APP_DATA, Ok(local(900 * GB, "disk1")))
        .with(ROOT, Ok(local(900 * GB, "disk2")));
    let plan = spill_plan(&request(1_000, Platform::Posix), &apart, &ledger);
    assert_eq!(plan.same_volume, Some(false));
    let _allowed = plan.verdict.map_err(|r| r.to_string())?;

    let unknown = FakeVolumes::default()
        .with(APP_DATA, Ok(local(900 * GB, "disk1")))
        .with(ROOT, Err("the root is gone"));
    let plan = spill_plan(&request(1_000, Platform::Posix), &unknown, &ledger);
    assert_eq!(plan.same_volume, None, "unknown, not false");
    let _allowed = plan.verdict.map_err(|r| r.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// The in-walk check

#[test]
fn the_in_walk_check_holds_at_its_boundary_and_says_why_below_it() {
    assert_eq!(IN_WALK_CHECK_EVERY, 256 << 20);
    // A 10 GB volume: 2 % is 200 MB, so the 1 GiB floor is the margin.
    let (volume, remainder) = (10 * GB, 500_000_000);
    let needs = 2 * remainder + GIB;
    assert_eq!(in_walk_check(needs, volume, remainder), Ok(()));
    let refusal = in_walk_check(needs - 1, volume, remainder).err();
    assert_eq!(
        refusal,
        Some(SpillRefusal::LowSpaceWhileSpilling {
            free: needs - 1,
            needs,
            remainder,
            margin: GIB,
        })
    );
    assert_eq!(
        refusal.map(|r| r.to_string()).as_deref(),
        Some(
            "free space on the volume of TreeMap's data folder fell to 1.9 GB while this scan \
             was spilling, under the 1.9 GB it needs: twice the 476.8 MB still to write, and \
             1.0 GB to spare (the larger of 1.0 GB and 2% of the volume)"
        )
    );
    // A 500 GB volume: 2 % is 10 GB, above the floor.
    let (volume, remainder) = (500 * GB, 1_000_000_000);
    let needs = 2 * remainder + 10 * GB;
    assert_eq!(in_walk_check(needs, volume, remainder), Ok(()));
    assert!(
        matches!(
            in_walk_check(needs - 1, volume, remainder),
            Err(SpillRefusal::LowSpaceWhileSpilling { margin, .. }) if margin == 10 * GB
        ),
        "2 % of the volume is the margin once it passes 1 GiB"
    );
    // Nothing left to write still keeps the margin.
    assert_eq!(in_walk_check(GIB, volume / 100, 0), Ok(()));
    assert!(in_walk_check(GIB - 1, volume / 100, 0).is_err());
}

// ---------------------------------------------------------------------------------------
// Sizes in words, as the app writes them

#[test]
fn sizes_read_as_the_app_writes_them() {
    // Each pinned from `formatBytes` (src/utils/formatBytes.ts) under Node 24.16.
    for (bytes, text) in [
        (0, "0 B"),
        (1, "1 B"),
        (1023, "1023 B"),
        (1024, "1.0 KB"),
        (1178, "1.2 KB"),
        (1280, "1.3 KB"),
        (1536, "1.5 KB"),
        (1_048_575, "1.0 MB"),
        (1_048_576, "1.0 MB"),
        (107_374_182, "102.4 MB"),
        (322_122_547, "307.2 MB"),
        (1_073_741_823, "1.0 GB"),
        (1_073_741_824, "1.0 GB"),
        (3_278_141_824, "3.1 GB"),
        (1_374_389_534_720, "1.3 TB"),
        (9_007_199_254_740_991, "8.0 PB"),
        (2_251_799_813_685_248_000, "2000.0 PB"),
    ] {
        assert_eq!(bytes_text(bytes), text, "{bytes}");
    }
}

// ---------------------------------------------------------------------------------------
// This machine

/// The free space the OS reports for the temp folder's volume, read the test's own way,
/// before and after the crate reads it: the crate's figure must fall between them, give or
/// take what other processes wrote meanwhile.
#[test]
fn the_os_facts_are_this_machines() -> TestResult {
    const NOISE: u64 = 256 << 20;
    let temp = std::env::temp_dir();
    let before = own_free_bytes(&temp)?;
    let facts = OsVolumes
        .facts(&temp)
        .map_err(|e| format!("{}: {e}", temp.display()))?;
    let after = own_free_bytes(&temp)?;
    assert!(
        facts.free_bytes + NOISE >= before.min(after)
            && facts.free_bytes <= before.max(after) + NOISE,
        "the crate read {} free; the OS said {before} and {after}",
        facts.free_bytes
    );
    assert!(facts.total_bytes >= facts.free_bytes, "{facts:?}");
    let ledger = Ledger::new();
    let plan = spill_plan(
        &SpillRequest {
            projected_entries: 1_000,
            platform: Platform::THIS,
            app_data_dir: &temp,
            scanned_root: &temp,
            app_data_writable: true,
        },
        &OsVolumes,
        &ledger,
    );
    assert_eq!(plan.same_volume, Some(true), "{facts:?}");
    let _allowed = plan
        .verdict
        .map_err(|r| format!("a thousand entries on this machine's temp volume: {r}"))?;
    Ok(())
}

/// The OS says which file system holds the temp folder, and the rule reads it as local: APFS
/// on macOS, a magic number on Linux (and `/proc`'s own, 0x9FA0), a fixed drive on Windows.
#[test]
fn the_os_names_this_machines_file_systems() -> TestResult {
    let temp = std::env::temp_dir();
    let facts = OsVolumes
        .facts(&temp)
        .map_err(|e| format!("{}: {e}", temp.display()))?;
    assert_eq!(facts.file_system.network(), None, "{facts:?}");
    #[cfg(target_os = "macos")]
    assert_eq!(facts.file_system, FileSystem::Named("apfs".to_owned()));
    #[cfg(target_os = "linux")]
    {
        assert!(
            matches!(facts.file_system, FileSystem::Magic(magic) if magic != 0),
            "{facts:?}"
        );
        let proc = OsVolumes
            .facts(Path::new("/proc"))
            .map_err(|e| format!("/proc: {e}"))?;
        assert_eq!(proc.file_system, FileSystem::Magic(0x9FA0));
    }
    #[cfg(windows)]
    assert_eq!(facts.file_system, FileSystem::DriveType(3));
    Ok(())
}

/// On Linux `/proc` is a volume of its own.
#[cfg(target_os = "linux")]
#[test]
fn two_volumes_are_told_apart() {
    let ledger = Ledger::new();
    let plan = spill_plan(
        &SpillRequest {
            projected_entries: 1_000,
            platform: Platform::Posix,
            app_data_dir: &std::env::temp_dir(),
            scanned_root: Path::new("/proc"),
            app_data_writable: true,
        },
        &OsVolumes,
        &ledger,
    );
    assert_eq!(plan.same_volume, Some(false));
}

#[cfg(target_os = "macos")]
fn own_free_bytes(path: &Path) -> Result<u64, String> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let mut facts = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: `c` is a NUL-terminated path that outlives the call; `facts` is writable for
    // one `statfs`, which the call fills when it answers 0.
    if unsafe { libc::statfs(c.as_ptr(), facts.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    // SAFETY: the call answered 0, so it filled `facts`.
    let facts = unsafe { facts.assume_init() };
    Ok(facts.f_bavail.saturating_mul(u64::from(facts.f_bsize)))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn own_free_bytes(path: &Path) -> Result<u64, String> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let mut facts = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `c` is a NUL-terminated path that outlives the call; `facts` is writable for
    // one `statvfs`, which the call fills when it answers 0.
    if unsafe { libc::statvfs(c.as_ptr(), facts.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
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
fn own_free_bytes(path: &Path) -> Result<u64, String> {
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
    // SAFETY: `wide` is NUL-terminated and outlives the call; `free` is a live u64 the call
    // writes; the other two answers are declined with null pointers.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &raw mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(free)
}

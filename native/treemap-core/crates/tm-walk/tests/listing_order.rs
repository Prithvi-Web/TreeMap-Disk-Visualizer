//! The order a real listing hands its entries over in: the legacy walker's.
//! It lists with `fs.readdir`, and libuv's `scandir` sorts that listing with
//! `strcmp` on macOS and Linux and keeps the file system's own order on
//! Windows. The walk numbers entries in the order they arrive, so here the
//! platform's own lister, on a real folder, must answer in that order.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tm_walk::platform::{ListBuffer, platform_lister};

type TestResult = Result<(), String>;

/// 64 names, `a..` and `B..` alternating, created in reverse: byte order puts
/// every `B` first and NTFS's case-insensitive order every `a` first, and a
/// file system that hashes its directories (APFS, ext4) returns neither.
fn names() -> Vec<String> {
    (0..64_u8)
        .rev()
        .map(|i| format!("{}{i:02}", if i % 2 == 0 { 'a' } else { 'B' }))
        .collect()
}

#[test]
fn a_real_listing_comes_back_in_the_legacy_walkers_order() -> TestResult {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    let dir: PathBuf =
        std::env::temp_dir().join(format!("tm-walk-order-{}-{nanos}", std::process::id()));
    std::fs::create_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let result = (|| -> TestResult {
        for name in names() {
            std::fs::write(dir.join(&name), b"").map_err(|e| format!("{name}: {e}"))?;
        }
        let lister = platform_lister().map_err(|e| e.to_string())?;
        let mut buf = ListBuffer::new(256 * 1024);
        lister
            .list(&dir, false, &mut buf)
            .map_err(|why| format!("{why:?}"))?;
        let listed: Vec<String> = buf
            .listing
            .entries
            .iter()
            .map(|entry| String::from_utf8_lossy(buf.listing.name(entry)).into_owned())
            .collect();
        let mut expected = names();
        if cfg!(windows) {
            expected.sort_by_key(|name| name.to_uppercase());
        } else {
            expected.sort();
        }
        assert_eq!(listed, expected);
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

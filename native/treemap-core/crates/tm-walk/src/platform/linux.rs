//! Linux: raw `getdents64` into a reusable buffer for the names and `d_type`,
//! then one `statx(AT_SYMLINK_NOFOLLOW | AT_STATX_DONT_SYNC)` per entry
//! through the directory descriptor, with `fstatat` as the fallback when the
//! kernel answers `ENOSYS` or a seccomp filter answers `EPERM`.
//!
//! The facts are what Node's `lstat` reports: kind from `st_mode`, `st_size`,
//! `st_blocks * 512` as the allocation, `st_dev` (glibc's `makedev` of the
//! major and minor `statx` returns), `st_ino`, `st_nlink`, and the times as
//! Node's doubles. `stx_mask` is honoured per entry as the macOS listing
//! honours `ATTR_CMN_RETURNED_ATTRS`: a fact the file system withheld keeps
//! its unknown value and marks the entry. A mount point needs no second look
//! here: `statx` on the entry through the directory descriptor answers for the
//! mounted root, exactly as `lstat` on the joined path does. `io_uring` is not
//! built in this phase (DESIGN §5 records it as deferred).
//!
//! The dirent parser, the `makedev` arithmetic and the mask rule are portable
//! and tested on every platform; only the calls are `cfg(target_os = "linux")`.
//! The constants are defined here from the kernel headers so the portable part
//! needs no crate; on Linux they are checked at compile time against `libc`.

use super::{Meta, time_ms};
use crate::{KIND_DIR, KIND_FILE, KIND_SYMLINK};

/// `DT_UNKNOWN`: the file system did not say; the mode decides.
pub const DT_UNKNOWN: u8 = 0;
/// `DT_DIR`.
pub const DT_DIR: u8 = 4;
/// `DT_REG`.
pub const DT_REG: u8 = 8;
/// `DT_LNK`.
pub const DT_LNK: u8 = 10;
/// `S_IFMT`: the type bits of a mode.
pub const S_IFMT: u16 = 0o170_000;
/// `S_IFDIR`.
pub const S_IFDIR: u16 = 0o040_000;
/// `S_IFREG`.
pub const S_IFREG: u16 = 0o100_000;
/// `S_IFLNK`.
pub const S_IFLNK: u16 = 0o120_000;
/// `STATX_TYPE`: `stx_mode & S_IFMT` is valid.
pub const STATX_TYPE: u32 = 0x0001;
/// `STATX_MODE`: `stx_mode & !S_IFMT` is valid.
pub const STATX_MODE: u32 = 0x0002;
/// `STATX_NLINK`.
pub const STATX_NLINK: u32 = 0x0004;
/// `STATX_ATIME`.
pub const STATX_ATIME: u32 = 0x0020;
/// `STATX_MTIME`.
pub const STATX_MTIME: u32 = 0x0040;
/// `STATX_INO`.
pub const STATX_INO: u32 = 0x0100;
/// `STATX_SIZE`.
pub const STATX_SIZE: u32 = 0x0200;
/// `STATX_BLOCKS`.
pub const STATX_BLOCKS: u32 = 0x0400;
/// The mask the listing asks for: the legacy walker's facts, atime added when wanted.
pub const STATX_WANTED: u32 =
    STATX_TYPE | STATX_MODE | STATX_SIZE | STATX_BLOCKS | STATX_MTIME | STATX_INO | STATX_NLINK;
/// Bytes before `d_name` in a `linux_dirent64`: `d_ino`, `d_off`, `d_reclen`, `d_type`.
pub const DIRENT64_HEADER_BYTES: usize = 19;
const OFF_RECLEN: usize = 16;
const OFF_TYPE: usize = 18;
/// `st_blocks` counts units of this many bytes, whatever the file system's block size.
const BLOCK_BYTES: u64 = 512;

/// A buffer the kernel could not have written: the directory is unreadable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseError {
    /// Which record of the buffer was malformed.
    pub record: usize,
    /// What was wrong with it.
    pub reason: &'static str,
}

fn fail(record: usize, reason: &'static str) -> ParseError {
    ParseError { record, reason }
}

/// One `linux_dirent64`, as far as the walk reads it.
#[derive(Debug, Clone, Copy)]
pub struct Dirent<'a> {
    /// `d_ino`.
    pub ino: u64,
    /// `d_type`.
    pub d_type: u8,
    /// `d_name` up to its NUL: the OS bytes.
    pub name: &'a [u8],
}

fn read_u16(buf: &[u8], off: usize) -> Option<u16> {
    let bytes = buf.get(off..off.checked_add(2)?)?;
    Some(u16::from_ne_bytes(bytes.try_into().ok()?))
}

fn read_u64(buf: &[u8], off: usize) -> Option<u64> {
    let bytes = buf.get(off..off.checked_add(8)?)?;
    Some(u64::from_ne_bytes(bytes.try_into().ok()?))
}

/// Walks the `linux_dirent64` records in `buf` (as `getdents64` left them,
/// `buf` being exactly the bytes it returned) by `d_reclen` and hands every
/// record but `.` and `..` to `visit`. Returns how many were visited; a
/// length the kernel could not have written is an error.
pub fn parse_dirents(buf: &[u8], visit: &mut dyn FnMut(&Dirent<'_>)) -> Result<usize, ParseError> {
    let mut pos = 0_usize;
    let mut visited = 0_usize;
    let mut index = 0_usize;
    while pos < buf.len() {
        let rec = buf
            .get(pos..)
            .filter(|r| r.len() >= DIRENT64_HEADER_BYTES)
            .ok_or_else(|| fail(index, "the record is shorter than its header"))?;
        let reclen = usize::from(
            read_u16(rec, OFF_RECLEN)
                .ok_or_else(|| fail(index, "the record length is not addressable"))?,
        );
        if reclen <= DIRENT64_HEADER_BYTES {
            return Err(fail(
                index,
                "the record length does not advance past the header",
            ));
        }
        let record = rec
            .get(..reclen)
            .ok_or_else(|| fail(index, "the record extends beyond the buffer"))?;
        let name_area = record
            .get(DIRENT64_HEADER_BYTES..)
            .ok_or_else(|| fail(index, "the record has no name"))?;
        let nul = name_area
            .iter()
            .position(|b| *b == 0)
            .ok_or_else(|| fail(index, "the name is not NUL-terminated within the record"))?;
        let name = name_area
            .get(..nul)
            .ok_or_else(|| fail(index, "the name range is not addressable"))?;
        let ino = read_u64(record, 0).ok_or_else(|| fail(index, "the inode is not addressable"))?;
        let d_type = record
            .get(OFF_TYPE)
            .copied()
            .ok_or_else(|| fail(index, "the type is not addressable"))?;
        if name != b"." && name != b".." {
            visit(&Dirent { ino, d_type, name });
            visited = visited.saturating_add(1);
        }
        pos = pos
            .checked_add(reclen)
            .ok_or_else(|| fail(index, "the record length overflows"))?;
        index = index.saturating_add(1);
    }
    Ok(visited)
}

/// glibc's `gnu_dev_makedev`: what Node's `stat.dev` holds for the major and
/// minor numbers `statx` reports.
pub fn makedev(major: u32, minor: u32) -> u64 {
    let major = u64::from(major);
    let minor = u64::from(minor);
    ((major & 0xFFFF_F000) << 32)
        | ((major & 0x0000_0FFF) << 8)
        | ((minor & 0xFFFF_FF00) << 12)
        | (minor & 0x0000_00FF)
}

/// glibc's `gnu_dev_major` and `gnu_dev_minor`: the inverse of [`makedev`],
/// for a `dev_t` the fallback `fstatat` reports.
#[expect(
    clippy::cast_possible_truncation,
    reason = "each part is masked to 32 bits before the cast"
)]
pub fn dev_parts(dev: u64) -> (u32, u32) {
    let major = ((dev >> 8) & 0xFFF) | ((dev >> 32) & 0xFFFF_F000);
    let minor = (dev & 0xFF) | ((dev >> 12) & 0xFFFF_FF00);
    (major as u32, minor as u32)
}

/// What a `statx` call answered, as far as the walk reads it: the mask says
/// which of the other fields the file system filled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatxFacts {
    /// `stx_mask`.
    pub mask: u32,
    /// `stx_mode`.
    pub mode: u16,
    /// `stx_nlink`.
    pub nlink: u32,
    /// `stx_ino`.
    pub ino: u64,
    /// `stx_size`.
    pub size: u64,
    /// `stx_blocks`: 512-byte units.
    pub blocks: u64,
    /// `stx_mtime` as `(tv_sec, tv_nsec)`.
    pub mtime: (i64, i64),
    /// `stx_atime` as `(tv_sec, tv_nsec)`.
    pub atime: (i64, i64),
    /// `stx_dev_major`.
    pub dev_major: u32,
    /// `stx_dev_minor`.
    pub dev_minor: u32,
}

/// The facts the legacy walker takes from an `lstat`, through the mask: a
/// missing field keeps the unknown value and marks the entry withheld. The
/// kind comes from the mode when `STATX_TYPE` was returned, from `d_type`
/// otherwise; a directory's size, allocation and link count are 0, so those
/// three cannot be withheld from one.
pub fn meta_from_statx(facts: &StatxFacts, want_atime: bool, d_type: u8) -> Meta {
    let mut withheld = false;
    let kind = if facts.mask & STATX_TYPE != 0 {
        match facts.mode & S_IFMT {
            S_IFDIR => KIND_DIR,
            S_IFLNK => KIND_SYMLINK,
            _ => KIND_FILE,
        }
    } else {
        withheld = true;
        match d_type {
            DT_DIR => KIND_DIR,
            DT_LNK => KIND_SYMLINK,
            _ => KIND_FILE,
        }
    };
    let is_dir = kind == KIND_DIR;
    let size = if is_dir {
        0.0
    } else if facts.mask & STATX_SIZE != 0 {
        facts.size as f64
    } else {
        withheld = true;
        0.0
    };
    let alloc = if is_dir {
        0.0
    } else if facts.mask & STATX_BLOCKS != 0 {
        facts.blocks.saturating_mul(BLOCK_BYTES) as f64
    } else {
        withheld = true;
        0.0
    };
    let nlink = if is_dir {
        0
    } else if facts.mask & STATX_NLINK != 0 {
        facts.nlink
    } else {
        withheld = true;
        0
    };
    let mtime_ms = if facts.mask & STATX_MTIME != 0 {
        time_ms(facts.mtime.0, facts.mtime.1)
    } else {
        withheld = true;
        f64::NAN
    };
    let atime_ms = if want_atime && facts.mask & STATX_ATIME != 0 {
        time_ms(facts.atime.0, facts.atime.1)
    } else {
        f64::NAN
    };
    let ino = if facts.mask & STATX_INO != 0 {
        u128::from(facts.ino)
    } else {
        withheld = true;
        0
    };
    Meta {
        kind,
        flags: 0,
        size,
        alloc,
        mtime_ms,
        atime_ms,
        dev: makedev(facts.dev_major, facts.dev_minor) as f64,
        ino,
        nlink,
        withheld,
    }
}

/// True for an answer that means `statx` cannot be used at all, so the lister
/// switches to `fstatat` for good: `ENOSYS` from a kernel without the call,
/// and `EPERM` from a seccomp filter that rejects the call outright (Docker's
/// default profile did, on older runtimes) — libuv treats the two alike for
/// exactly that reason, and a real permission problem is `EACCES`, not `EPERM`.
#[cfg(unix)]
pub fn statx_unusable(errno: i32) -> bool {
    errno == libc::ENOSYS || errno == libc::EPERM
}

#[cfg(target_os = "linux")]
const _: () = {
    assert!(DT_UNKNOWN == libc::DT_UNKNOWN);
    assert!(DT_DIR == libc::DT_DIR);
    assert!(DT_REG == libc::DT_REG);
    assert!(DT_LNK == libc::DT_LNK);
    assert!(S_IFMT as u32 == libc::S_IFMT);
    assert!(S_IFDIR as u32 == libc::S_IFDIR);
    assert!(S_IFREG as u32 == libc::S_IFREG);
    assert!(S_IFLNK as u32 == libc::S_IFLNK);
    assert!(STATX_TYPE == libc::STATX_TYPE);
    assert!(STATX_MODE == libc::STATX_MODE);
    assert!(STATX_NLINK == libc::STATX_NLINK);
    assert!(STATX_ATIME == libc::STATX_ATIME);
    assert!(STATX_MTIME == libc::STATX_MTIME);
    assert!(STATX_INO == libc::STATX_INO);
    assert!(STATX_SIZE == libc::STATX_SIZE);
    assert!(STATX_BLOCKS == libc::STATX_BLOCKS);
    assert!(DIRENT64_HEADER_BYTES == std::mem::offset_of!(libc::dirent64, d_name));
};

#[cfg(target_os = "linux")]
mod os {
    use std::ffi::c_void;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::{Dirent, StatxFacts, dev_parts, meta_from_statx, parse_dirents};
    use crate::output::Refusal;
    use crate::platform::{
        ListBuffer, Lister, Listing, Meta, last_errno, refusal_from_errno, retry_eintr,
    };
    use crate::{DEFAULT_BUFFER_BYTES, FastPath, KIND_DIR, Probe};

    /// The probe's own listing buffer.
    const PROBE_BUFFER_BYTES: usize = 64 * 1024;
    /// How every entry is asked about: never through a final symlink, and
    /// never forcing a network file system to synchronise first.
    const STATX_FLAGS: i32 = libc::AT_SYMLINK_NOFOLLOW | libc::AT_STATX_DONT_SYNC;

    /// Opens `path` as a directory for reading, without following a final symlink.
    fn open_dir(path: &Path) -> Result<OwnedFd, i32> {
        let mut c = path.as_os_str().as_bytes().to_vec();
        if c.contains(&0) {
            return Err(libc::EINVAL);
        }
        c.push(0);
        let fd = retry_eintr(|| {
            // SAFETY: `c` is NUL-terminated; the flags open a directory read-only,
            // refuse a final symlink, and close the descriptor on exec.
            let fd = unsafe {
                libc::open(
                    c.as_ptr().cast::<libc::c_char>(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 { Err(last_errno()) } else { Ok(fd) }
        })?;
        // SAFETY: `fd` was just opened and nobody else owns it.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    /// One `statx` (or, once `statx` proved unusable, one `fstatat`) of `name`
    /// relative to `dirfd`; `name` is NUL-terminated by the caller.
    fn stat_entry(
        dirfd: i32,
        name: *const libc::c_char,
        want_atime: bool,
        statx_unavailable: &AtomicBool,
    ) -> Result<StatxFacts, i32> {
        if !statx_unavailable.load(Ordering::Relaxed) {
            let mask = super::STATX_WANTED | if want_atime { super::STATX_ATIME } else { 0 };
            // SAFETY: all-zero is a valid `statx` (plain integers).
            let mut stx: libc::statx = unsafe { std::mem::zeroed() };
            let answer = retry_eintr(|| {
                // SAFETY: `dirfd` is open (or AT_FDCWD), `name` is NUL-terminated,
                // `stx` is a writable statx; the flags stop a final symlink from
                // being followed.
                let rc = unsafe { libc::statx(dirfd, name, STATX_FLAGS, mask, &raw mut stx) };
                if rc == 0 { Ok(()) } else { Err(last_errno()) }
            });
            match answer {
                Ok(()) => return Ok(facts_from_statx(&stx)),
                Err(errno) if !super::statx_unusable(errno) => return Err(errno),
                Err(_) => statx_unavailable.store(true, Ordering::Relaxed),
            }
        }
        // SAFETY: all-zero is a valid `stat` (plain integers).
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        retry_eintr(|| {
            // SAFETY: as for statx above; fstatat fills `st` and does not follow a final symlink.
            let rc = unsafe { libc::fstatat(dirfd, name, &raw mut st, libc::AT_SYMLINK_NOFOLLOW) };
            if rc == 0 { Ok(()) } else { Err(last_errno()) }
        })?;
        Ok(facts_from_stat(&st))
    }

    fn facts_from_statx(stx: &libc::statx) -> StatxFacts {
        StatxFacts {
            mask: stx.stx_mask,
            mode: stx.stx_mode,
            nlink: stx.stx_nlink,
            ino: stx.stx_ino,
            size: stx.stx_size,
            blocks: stx.stx_blocks,
            mtime: (stx.stx_mtime.tv_sec, i64::from(stx.stx_mtime.tv_nsec)),
            atime: (stx.stx_atime.tv_sec, i64::from(stx.stx_atime.tv_nsec)),
            dev_major: stx.stx_dev_major,
            dev_minor: stx.stx_dev_minor,
        }
    }

    /// A `stat` as the facts `statx` would have returned in full: every field
    /// of the basic set is present, so the mask is the whole wanted set. A
    /// negative size or block count cannot come from the kernel and reads as 0.
    fn facts_from_stat(st: &libc::stat) -> StatxFacts {
        let (dev_major, dev_minor) = dev_parts(st.st_dev);
        StatxFacts {
            mask: super::STATX_WANTED | super::STATX_ATIME,
            mode: u16::try_from(st.st_mode & 0xFFFF).unwrap_or(0),
            nlink: u32::try_from(st.st_nlink).unwrap_or(u32::MAX),
            ino: st.st_ino,
            size: u64::try_from(st.st_size).unwrap_or(0),
            blocks: u64::try_from(st.st_blocks).unwrap_or(0),
            mtime: (st.st_mtime, st.st_mtime_nsec),
            atime: (st.st_atime, st.st_atime_nsec),
            dev_major,
            dev_minor,
        }
    }

    /// The legacy walker's accounting for an entry whose metadata could not be
    /// read: denied for `EACCES`/`EPERM`, nothing for a vanished entry, unreadable otherwise.
    fn count_entry_error(errno: i32, out: &mut Listing) {
        match errno {
            libc::EACCES | libc::EPERM => out.denied_entries = out.denied_entries.saturating_add(1),
            libc::ENOENT => {}
            _ => out.unreadable_entries = out.unreadable_entries.saturating_add(1),
        }
    }

    /// The `getdents64` loop over `fd` into `buf.raw`, one `statx` per entry;
    /// the walk's stop flag is checked before each call and its heartbeat
    /// bumped after each answer.
    fn list_getdents(
        fd: &OwnedFd,
        want_atime: bool,
        buf: &mut ListBuffer,
        statx_unavailable: &AtomicBool,
    ) -> Result<(), i32> {
        let dirfd = fd.as_raw_fd();
        let mut name_c: Vec<u8> = Vec::new();
        loop {
            if buf.stopped() {
                // The walk discards the listing on cancel, so which errno ends it is immaterial.
                return Err(libc::ECANCELED);
            }
            let n = retry_eintr(|| {
                // SAFETY: `dirfd` is an open directory; `buf.raw` is a writable buffer
                // of exactly `buf.raw.len()` bytes; the kernel writes at most that many.
                let n = unsafe {
                    libc::syscall(
                        libc::SYS_getdents64,
                        dirfd,
                        buf.raw.as_mut_ptr().cast::<c_void>(),
                        buf.raw.len(),
                    )
                };
                if n < 0 { Err(last_errno()) } else { Ok(n) }
            })?;
            // Every answer beats, the empty one that ends the listing included,
            // so even an empty directory beats once.
            buf.beat();
            if n == 0 {
                return Ok(());
            }
            let filled = usize::try_from(n).map_err(|_| libc::EIO)?;
            let batch = buf.raw.get(..filled).ok_or(libc::EIO)?;
            let listing = &mut buf.listing;
            parse_dirents(batch, &mut |d: &Dirent<'_>| {
                name_c.clear();
                name_c.extend_from_slice(d.name);
                name_c.push(0);
                let name = name_c.as_ptr().cast::<libc::c_char>();
                match stat_entry(dirfd, name, want_atime, statx_unavailable) {
                    Ok(facts) => {
                        listing.push(d.name, meta_from_statx(&facts, want_atime, d.d_type));
                    }
                    Err(errno) => count_entry_error(errno, listing),
                }
            })
            .map_err(|_| libc::EIO)?;
        }
    }

    /// `path` itself as `lstat` reports it, through `statx` at `AT_FDCWD`.
    pub fn stat_path(
        path: &Path,
        want_atime: bool,
        statx_unavailable: &AtomicBool,
    ) -> Result<Meta, i32> {
        let mut c = path.as_os_str().as_bytes().to_vec();
        if c.contains(&0) {
            return Err(libc::EINVAL);
        }
        c.push(0);
        let facts = stat_entry(
            libc::AT_FDCWD,
            c.as_ptr().cast::<libc::c_char>(),
            want_atime,
            statx_unavailable,
        )?;
        Ok(meta_from_statx(&facts, want_atime, super::DT_UNKNOWN))
    }

    /// The Linux lister: `getdents64` and `statx`, with `fstatat` once `statx`
    /// was refused with `ENOSYS` or `EPERM` ([`super::statx_unusable`]).
    #[derive(Debug, Default)]
    pub struct LinuxLister {
        statx_unavailable: AtomicBool,
    }

    impl LinuxLister {
        /// The lister.
        pub fn new() -> Self {
            Self::default()
        }
    }

    impl Lister for LinuxLister {
        fn stat_dir(&self, path: &Path, want_atime: bool) -> Result<Meta, Refusal> {
            stat_path(path, want_atime, &self.statx_unavailable).map_err(refusal_from_errno)
        }

        fn list(
            &self,
            dir: &Path,
            want_atime: bool,
            buf: &mut ListBuffer,
        ) -> Result<FastPath, Refusal> {
            buf.listing.clear();
            let fd = open_dir(dir).map_err(refusal_from_errno)?;
            list_getdents(&fd, want_atime, buf, &self.statx_unavailable)
                .map_err(refusal_from_errno)?;
            buf.listing.sort_by_name();
            Ok(FastPath::Getdents)
        }
    }

    /// [`crate::probe`] on Linux: reads the root's own facts, opens it, and
    /// lists it once with `getdents64` and `statx`.
    pub fn probe(root: &Path) -> Probe {
        let unavailable = |reason: String| Probe {
            fast_path: FastPath::Unavailable,
            reason,
        };
        let statx_unavailable = AtomicBool::new(false);
        match stat_path(root, false, &statx_unavailable) {
            Err(errno) => {
                return unavailable(format!("the root could not be read: {}", os_error(errno)));
            }
            Ok(meta) if meta.kind != KIND_DIR => {
                return unavailable("the root is not a directory".to_owned());
            }
            Ok(_) => {}
        }
        let fd = match open_dir(root) {
            Ok(fd) => fd,
            Err(errno) => {
                return unavailable(format!(
                    "the root directory could not be opened: {}",
                    os_error(errno)
                ));
            }
        };
        let mut buf = ListBuffer::new(PROBE_BUFFER_BYTES.min(DEFAULT_BUFFER_BYTES));
        match list_getdents(&fd, false, &mut buf, &statx_unavailable) {
            Ok(()) => Probe {
                fast_path: FastPath::Getdents,
                reason: format!(
                    "getdents64 and {} listed the root directory ({} entries)",
                    if statx_unavailable.load(Ordering::Relaxed) {
                        "fstatat (statx answered ENOSYS or EPERM)"
                    } else {
                        "statx"
                    },
                    buf.listing.len()
                ),
            },
            Err(errno) => unavailable(format!(
                "getdents64 failed on the root: {}",
                os_error(errno)
            )),
        }
    }

    fn os_error(errno: i32) -> std::io::Error {
        std::io::Error::from_raw_os_error(errno)
    }
}

#[cfg(target_os = "linux")]
pub use os::{LinuxLister, probe, stat_path};

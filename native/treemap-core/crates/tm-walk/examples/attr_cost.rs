//! The kernel cost of each attribute the macOS walker asks `getattrlistbulk`
//! for. Walks a tree on one thread with a given attribute set — the walker's
//! own open flags, buffer size and request — and reports kernel and user CPU
//! (`getrusage`) and wall time per million entries.
//!
//! ```text
//! cargo run --release --offline -p tm-walk --example attr_cost -- <root> [rounds]
//! ```
//!
//! The variants are the walker's full set (atime wanted, as the app asks), the
//! full set minus one attribute at a time, the full set minus the whole file
//! group, the floor a walk cannot go below (name, type, the returned set and
//! the error), and `open`+`close` of every directory alone. Each is walked
//! once per round, the order rotated round by round, after one untimed
//! warm-up walk; the medians are printed. A diagnostic, not a benchmark: it
//! never scans anything but the root it is given.

#[cfg(target_os = "macos")]
fn main() -> std::process::ExitCode {
    mac::main()
}

#[cfg(not(target_os = "macos"))]
fn main() {}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{CString, c_void};
    use std::os::unix::ffi::OsStrExt;
    use std::process::ExitCode;
    use std::time::Instant;

    use tm_walk::platform::darwin::{ATTR_CMN_ERROR, COMMON_ATTRS, FILE_ATTRS, VDIR};

    /// The walker's default listing buffer.
    const BUFFER_BYTES: usize = tm_walk::DEFAULT_BUFFER_BYTES;
    /// Rounds when the command line names none.
    const DEFAULT_ROUNDS: usize = 3;
    /// The `u32` length and the five-word `attribute_set_t` before the first attribute.
    const HEADER_BYTES: usize = 4 + 5 * 4;
    /// Bytes of an `attrreference_t` (the name's offset and length).
    const ATTRREF_BYTES: usize = 8;
    /// Bytes of a `dev_t` in the buffer.
    const DEVID_BYTES: usize = 4;
    /// Bytes of the `ATTR_CMN_ERROR` field.
    const ERROR_BYTES: usize = 4;
    /// Entries per million.
    const MILLION: f64 = 1e6;

    /// One attribute request, or the open/close-only pass.
    #[derive(Clone, Copy)]
    struct Variant {
        name: &'static str,
        common: u32,
        dir: u32,
        file: u32,
        open_close_only: bool,
        /// Children are opened with `openat` on their parent's descriptor
        /// instead of by their whole path.
        openat: bool,
    }

    fn variants() -> Vec<Variant> {
        let common = COMMON_ATTRS | libc::ATTR_CMN_ACCTIME;
        let dir = libc::ATTR_DIR_MOUNTSTATUS;
        let file = FILE_ATTRS;
        let request = |name, common, dir, file| Variant {
            name,
            common,
            dir,
            file,
            open_close_only: false,
            openat: false,
        };
        let minus_common = |name, bit: u32| request(name, common & !bit, dir, file);
        let minus_file = |name, bit: u32| request(name, common, dir, file & !bit);
        vec![
            request("full (the walker's set)", common, dir, file),
            minus_common("- ACCTIME", libc::ATTR_CMN_ACCTIME),
            minus_file("- ALLOCSIZE", libc::ATTR_FILE_ALLOCSIZE),
            minus_file("- DATALENGTH", libc::ATTR_FILE_DATALENGTH),
            minus_file("- LINKCOUNT", libc::ATTR_FILE_LINKCOUNT),
            minus_common("- DEVID", libc::ATTR_CMN_DEVID),
            minus_common("- FILEID", libc::ATTR_CMN_FILEID),
            minus_common("- FLAGS", libc::ATTR_CMN_FLAGS),
            minus_common("- MODTIME", libc::ATTR_CMN_MODTIME),
            minus_file("- the file group", file),
            request(
                "floor (name, type, returned, error)",
                libc::ATTR_CMN_RETURNED_ATTRS
                    | ATTR_CMN_ERROR
                    | libc::ATTR_CMN_NAME
                    | libc::ATTR_CMN_OBJTYPE,
                0,
                0,
            ),
            Variant {
                name: "open + close of every directory only",
                common: 0,
                dir: 0,
                file: 0,
                open_close_only: true,
                openat: false,
            },
            Variant {
                name: "full, children opened with openat",
                common,
                dir,
                file,
                open_close_only: false,
                openat: true,
            },
        ]
    }

    /// What one walk saw.
    #[derive(Default)]
    struct Tally {
        entries: u64,
        dirs: u64,
        errors: u64,
    }

    /// One timed walk, per million entries.
    struct Sample {
        kernel: f64,
        user: f64,
        wall: f64,
        entries: u64,
        dirs: u64,
        errors: u64,
    }

    fn read_u32(buf: &[u8], pos: usize) -> Option<u32> {
        let bytes = buf.get(pos..pos.checked_add(4)?)?;
        Some(u32::from_ne_bytes(bytes.try_into().ok()?))
    }

    /// The entry's name when the entry is a directory to descend into.
    fn child_dir(entry: &[u8]) -> Option<&[u8]> {
        let common = read_u32(entry, 4)?;
        let mut pos = HEADER_BYTES;
        if common & ATTR_CMN_ERROR != 0 {
            if read_u32(entry, pos)? != 0 {
                return None;
            }
            pos = pos.checked_add(ERROR_BYTES)?;
        }
        if common & libc::ATTR_CMN_NAME == 0 || common & libc::ATTR_CMN_OBJTYPE == 0 {
            return None;
        }
        let name_ref = pos;
        let offset = usize::try_from(i32::from_ne_bytes(
            entry.get(pos..pos.checked_add(4)?)?.try_into().ok()?,
        ))
        .ok()?;
        let length = read_u32(entry, pos.checked_add(4)?)? as usize;
        pos = pos.checked_add(ATTRREF_BYTES)?;
        if common & libc::ATTR_CMN_DEVID != 0 {
            pos = pos.checked_add(DEVID_BYTES)?;
        }
        if read_u32(entry, pos)? != VDIR {
            return None;
        }
        let start = name_ref.checked_add(offset)?;
        let raw = entry.get(start..start.checked_add(length)?)?;
        let name = raw.split(|b| *b == 0).next()?;
        (!name.is_empty()).then_some(name)
    }

    fn open_dir(path: &[u8]) -> Option<i32> {
        let c = CString::new(path).ok()?;
        // SAFETY: `c` is NUL-terminated; the flags are the walker's own: a
        // directory, read-only, a final symlink refused, closed on exec.
        let fd = unsafe {
            libc::open(
                c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        (fd >= 0).then_some(fd)
    }

    fn close(fd: i32) {
        // SAFETY: `fd` was opened by `open_dir` and is closed exactly once.
        unsafe { libc::close(fd) };
    }

    /// Walks `root` depth first with `variant`'s request; `dirs_seen`
    /// collects every directory path when given.
    fn walk(
        root: &[u8],
        variant: Variant,
        buf: &mut [u8],
        mut dirs_seen: Option<&mut Vec<Vec<u8>>>,
    ) -> Tally {
        let mut tally = Tally::default();
        let mut attrs = libc::attrlist {
            bitmapcount: libc::ATTR_BIT_MAP_COUNT,
            reserved: 0,
            commonattr: variant.common,
            volattr: 0,
            dirattr: variant.dir,
            fileattr: variant.file,
            forkattr: 0,
        };
        let mut stack: Vec<Vec<u8>> = vec![root.to_vec()];
        while let Some(path) = stack.pop() {
            let Some(fd) = open_dir(&path) else {
                tally.errors = tally.errors.saturating_add(1);
                continue;
            };
            tally.dirs = tally.dirs.saturating_add(1);
            loop {
                // SAFETY: `fd` is an open directory; `attrs` is a valid attrlist
                // for the call; `buf` is writable for exactly `buf.len()` bytes.
                let n = unsafe {
                    libc::getattrlistbulk(
                        fd,
                        (&raw mut attrs).cast::<c_void>(),
                        buf.as_mut_ptr().cast::<c_void>(),
                        buf.len(),
                        0,
                    )
                };
                let Ok(count) = usize::try_from(n) else {
                    tally.errors = tally.errors.saturating_add(1);
                    break;
                };
                if count == 0 {
                    break;
                }
                let mut pos = 0_usize;
                for _ in 0..count {
                    let Some(len) = read_u32(buf, pos).map(|l| l as usize) else {
                        break;
                    };
                    let Some(entry) = pos.checked_add(len).and_then(|end| buf.get(pos..end)) else {
                        break;
                    };
                    tally.entries = tally.entries.saturating_add(1);
                    if let Some(name) = child_dir(entry) {
                        let mut child = path.clone();
                        child.push(b'/');
                        child.extend_from_slice(name);
                        stack.push(child);
                    }
                    pos = pos.saturating_add(len);
                }
            }
            close(fd);
            if let Some(seen) = dirs_seen.as_deref_mut() {
                seen.push(path);
            }
        }
        tally
    }

    /// The same walk with every child opened by `openat` on its parent's
    /// still-open descriptor: one path component resolved per directory.
    fn walk_openat(fd: i32, variant: Variant, buf: &mut [u8], tally: &mut Tally) {
        tally.dirs = tally.dirs.saturating_add(1);
        let mut attrs = libc::attrlist {
            bitmapcount: libc::ATTR_BIT_MAP_COUNT,
            reserved: 0,
            commonattr: variant.common,
            volattr: 0,
            dirattr: variant.dir,
            fileattr: variant.file,
            forkattr: 0,
        };
        let mut children: Vec<CString> = Vec::new();
        loop {
            // SAFETY: as in `walk`.
            let n = unsafe {
                libc::getattrlistbulk(
                    fd,
                    (&raw mut attrs).cast::<c_void>(),
                    buf.as_mut_ptr().cast::<c_void>(),
                    buf.len(),
                    0,
                )
            };
            let Ok(count) = usize::try_from(n) else {
                tally.errors = tally.errors.saturating_add(1);
                break;
            };
            if count == 0 {
                break;
            }
            let mut pos = 0_usize;
            for _ in 0..count {
                let Some(len) = read_u32(buf, pos).map(|l| l as usize) else {
                    break;
                };
                let Some(entry) = pos.checked_add(len).and_then(|end| buf.get(pos..end)) else {
                    break;
                };
                tally.entries = tally.entries.saturating_add(1);
                if let Some(name) = child_dir(entry).and_then(|n| CString::new(n).ok()) {
                    children.push(name);
                }
                pos = pos.saturating_add(len);
            }
        }
        for name in children {
            // SAFETY: `fd` is an open directory; `name` is one NUL-terminated
            // component; the flags are the walker's own.
            let child = unsafe {
                libc::openat(
                    fd,
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if child < 0 {
                tally.errors = tally.errors.saturating_add(1);
                continue;
            }
            walk_openat(child, variant, buf, tally);
            close(child);
        }
    }

    /// `open` and `close` of every directory in `dirs`, nothing listed.
    fn open_close(dirs: &[Vec<u8>]) -> u64 {
        let mut opened = 0_u64;
        for path in dirs {
            if let Some(fd) = open_dir(path) {
                close(fd);
                opened = opened.saturating_add(1);
            }
        }
        opened
    }

    /// This process's (kernel, user) CPU seconds so far.
    fn cpu_seconds() -> Option<(f64, f64)> {
        // SAFETY: all-zero is a valid `rusage`.
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        // SAFETY: `usage` is a writable `rusage`; `RUSAGE_SELF` is a valid target.
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, &raw mut usage) } != 0 {
            return None;
        }
        let secs = |tv: libc::timeval| tv.tv_sec as f64 + f64::from(tv.tv_usec) / MILLION;
        Some((secs(usage.ru_stime), secs(usage.ru_utime)))
    }

    fn median(values: &mut [f64]) -> f64 {
        values.sort_by(f64::total_cmp);
        let mid = values.len() / 2;
        match (values.get(mid.wrapping_sub(1)), values.get(mid)) {
            (Some(a), Some(b)) if values.len() % 2 == 0 => (a + b) / 2.0,
            (_, Some(b)) => *b,
            _ => f64::NAN,
        }
    }

    fn timed(
        root: &[u8],
        variant: Variant,
        entries_of_tree: u64,
        dirs: &[Vec<u8>],
        buf: &mut [u8],
    ) -> Result<Sample, String> {
        let (k0, u0) = cpu_seconds().ok_or("getrusage failed")?;
        let started = Instant::now();
        let tally = if variant.open_close_only {
            Tally {
                entries: entries_of_tree,
                dirs: open_close(dirs),
                errors: 0,
            }
        } else if variant.openat {
            let mut tally = Tally::default();
            match open_dir(root) {
                Some(fd) => {
                    walk_openat(fd, variant, buf, &mut tally);
                    close(fd);
                }
                None => tally.errors = 1,
            }
            tally
        } else {
            walk(root, variant, buf, None)
        };
        let wall = started.elapsed().as_secs_f64();
        let (k1, u1) = cpu_seconds().ok_or("getrusage failed")?;
        let per_million = MILLION / (tally.entries.max(1) as f64);
        Ok(Sample {
            kernel: (k1 - k0) * per_million,
            user: (u1 - u0) * per_million,
            wall: wall * per_million,
            entries: tally.entries,
            dirs: tally.dirs,
            errors: tally.errors,
        })
    }

    fn run(root: &[u8], rounds: usize) -> Result<(), String> {
        let all = variants();
        let full = *all.first().ok_or("no variants")?;
        let mut buf = vec![0_u8; BUFFER_BYTES];
        let mut dirs = Vec::new();
        let warm = walk(root, full, &mut buf, Some(&mut dirs));
        println!(
            "warm-up: {} entries in {} directories ({} errors)",
            warm.entries, warm.dirs, warm.errors
        );
        let mut samples: Vec<Vec<Sample>> = all.iter().map(|_| Vec::new()).collect();
        for round in 0..rounds {
            for k in 0..all.len() {
                let index = (k + round) % all.len();
                let variant = *all.get(index).ok_or("variant index")?;
                let sample = timed(root, variant, warm.entries, &dirs, &mut buf)?;
                println!(
                    "round {} | {:<38} | kernel {:.3} s/M | user {:.3} s/M | wall {:.3} s/M | {} entries, {} dirs, {} errors",
                    round + 1,
                    variant.name,
                    sample.kernel,
                    sample.user,
                    sample.wall,
                    sample.entries,
                    sample.dirs,
                    sample.errors
                );
                samples.get_mut(index).ok_or("sample index")?.push(sample);
            }
        }
        println!(
            "\nmedians of {rounds} (per million entries of the tree; one thread; {BUFFER_BYTES}-byte buffer)"
        );
        println!("variant | kernel s/M | user s/M | wall s/M | kernel vs full | kernel spread");
        let mut full_kernel = f64::NAN;
        for (variant, rows) in all.iter().zip(&samples) {
            let mut kernel: Vec<f64> = rows.iter().map(|s| s.kernel).collect();
            let mut user: Vec<f64> = rows.iter().map(|s| s.user).collect();
            let mut wall: Vec<f64> = rows.iter().map(|s| s.wall).collect();
            let k = median(&mut kernel);
            let spread = match (kernel.first(), kernel.last()) {
                (Some(lo), Some(hi)) if k > 0.0 => (hi - lo) / k * 100.0,
                _ => f64::NAN,
            };
            if full_kernel.is_nan() {
                full_kernel = k;
            }
            println!(
                "{} | {:.3} | {:.3} | {:.3} | {:+.1} % | {:.1} %",
                variant.name,
                k,
                median(&mut user),
                median(&mut wall),
                (k / full_kernel - 1.0) * 100.0,
                spread
            );
        }
        Ok(())
    }

    pub fn main() -> ExitCode {
        let mut args = std::env::args_os().skip(1);
        let Some(root) = args.next() else {
            eprintln!("usage: attr_cost <root> [rounds]");
            return ExitCode::from(2);
        };
        let rounds = args
            .next()
            .and_then(|r| r.to_str().and_then(|s| s.parse().ok()))
            .unwrap_or(DEFAULT_ROUNDS)
            .max(1);
        match run(root.as_bytes(), rounds) {
            Ok(()) => ExitCode::SUCCESS,
            Err(why) => {
                eprintln!("attr_cost: {why}");
                ExitCode::FAILURE
            }
        }
    }
}

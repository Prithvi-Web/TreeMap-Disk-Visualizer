//! The `getattrlistbulk` batch parser: every entry through its own
//! returned-attribute set (see [`super`]). Moved out of `darwin.rs` unchanged
//! (Phase 4, T6b).

use super::{ATTR_CMN_ERROR, BatchRest, HEADER_BYTES, SF_DATALESS, VDIR, VLNK, VNON, VREG};
use crate::platform::{Listing, Meta, time_ms};
use crate::{FLAG_DATALESS, KIND_DIR, KIND_FILE, KIND_SYMLINK};

/// A batch the kernel could not have written: the directory is unreadable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseError {
    /// Which entry of the batch was malformed.
    pub entry: usize,
    /// What was wrong with it.
    pub reason: &'static str,
}

/// The stat behind an entry whose type the file system withheld: `fstatat`
/// through the directory descriptor on the live path, a script in tests.
/// `None` when that stat failed too.
pub type TypeFallback<'a> = dyn FnMut(&[u8]) -> Option<Meta> + 'a;

/// Parses `count` entries from `raw` (as `getattrlistbulk` left them) into `out`.
/// Per-entry problems become counters; a malformed length is an error. An
/// entry whose type was withheld is asked about through `type_fallback`.
pub fn parse_batch(
    raw: &[u8],
    count: usize,
    want_atime: bool,
    out: &mut Listing,
    type_fallback: &mut TypeFallback<'_>,
) -> Result<(), ParseError> {
    let whole = BatchRest {
        pos: 0,
        index: 0,
        count,
    };
    parse_part(raw, whole, want_atime, out, type_fallback, usize::MAX).map(drop)
}

/// [`parse_batch`] from `from` on, stopping before an entry once `out` holds
/// `limit` entries (T6b): the rest of the batch still to parse, or `None`
/// once it is all parsed.
pub fn parse_part(
    raw: &[u8],
    from: BatchRest,
    want_atime: bool,
    out: &mut Listing,
    type_fallback: &mut TypeFallback<'_>,
    limit: usize,
) -> Result<Option<BatchRest>, ParseError> {
    let mut pos = from.pos;
    for index in from.index..from.count {
        if out.len() >= limit {
            return Ok(Some(BatchRest {
                pos,
                index,
                count: from.count,
            }));
        }
        let len = read_u32(raw, pos).ok_or(ParseError {
            entry: index,
            reason: "the entry length lies beyond the buffer",
        })? as usize;
        if len < HEADER_BYTES {
            return Err(ParseError {
                entry: index,
                reason: "the entry is shorter than its header",
            });
        }
        let end = pos
            .checked_add(len)
            .filter(|end| *end <= raw.len())
            .ok_or(ParseError {
                entry: index,
                reason: "the entry extends beyond the buffer",
            })?;
        let entry = raw.get(pos..end).ok_or(ParseError {
            entry: index,
            reason: "the entry range is not addressable",
        })?;
        match parse_entry(entry, want_atime, out, type_fallback) {
            Ok(()) | Err(Problem::Vanished) => {}
            Err(Problem::Denied) => out.denied_entries = out.denied_entries.saturating_add(1),
            Err(Problem::Unreadable) => {
                out.unreadable_entries = out.unreadable_entries.saturating_add(1);
            }
        }
        pos = end;
    }
    Ok(None)
}

/// Why one entry was omitted.
enum Problem {
    Denied,
    Vanished,
    Unreadable,
}

fn problem_from_errno(errno: u32) -> Problem {
    match i32::try_from(errno) {
        Ok(libc::EACCES | libc::EPERM) => Problem::Denied,
        Ok(libc::ENOENT) => Problem::Vanished,
        _ => Problem::Unreadable,
    }
}

fn read_u32(buf: &[u8], pos: usize) -> Option<u32> {
    let bytes = buf.get(pos..pos.checked_add(4)?)?;
    Some(u32::from_ne_bytes(bytes.try_into().ok()?))
}

/// A bounds-checked reader over one entry.
struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl Cursor<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], Problem> {
        let end = self.pos.checked_add(n).ok_or(Problem::Unreadable)?;
        let bytes = self.buf.get(self.pos..end).ok_or(Problem::Unreadable)?;
        self.pos = end;
        Ok(bytes)
    }

    fn u32(&mut self) -> Result<u32, Problem> {
        let bytes = self.take(4)?;
        Ok(u32::from_ne_bytes(
            bytes.try_into().map_err(|_| Problem::Unreadable)?,
        ))
    }

    fn i32(&mut self) -> Result<i32, Problem> {
        let bytes = self.take(4)?;
        Ok(i32::from_ne_bytes(
            bytes.try_into().map_err(|_| Problem::Unreadable)?,
        ))
    }

    fn u64(&mut self) -> Result<u64, Problem> {
        let bytes = self.take(8)?;
        Ok(u64::from_ne_bytes(
            bytes.try_into().map_err(|_| Problem::Unreadable)?,
        ))
    }

    fn i64(&mut self) -> Result<i64, Problem> {
        let bytes = self.take(8)?;
        Ok(i64::from_ne_bytes(
            bytes.try_into().map_err(|_| Problem::Unreadable)?,
        ))
    }

    /// A `timespec`: seconds then nanoseconds, both 64-bit, 4-byte aligned.
    fn timespec(&mut self) -> Result<(i64, i64), Problem> {
        let sec = self.i64()?;
        let nsec = self.i64()?;
        Ok((sec, nsec))
    }
}

/// One entry, through its own returned set.
fn parse_entry(
    entry: &[u8],
    want_atime: bool,
    out: &mut Listing,
    type_fallback: &mut TypeFallback<'_>,
) -> Result<(), Problem> {
    let mut cur = Cursor { buf: entry, pos: 4 };
    let common = cur.u32()?;
    let _vol = cur.u32()?;
    let dir = cur.u32()?;
    let file = cur.u32()?;
    let _fork = cur.u32()?;
    if common & ATTR_CMN_ERROR != 0 {
        let errno = cur.u32()?;
        if errno != 0 {
            return Err(problem_from_errno(errno));
        }
    }
    if common & libc::ATTR_CMN_NAME == 0 {
        return Err(Problem::Unreadable);
    }
    let ref_pos = cur.pos;
    let offset = cur.i32()?;
    let length = cur.u32()? as usize;
    let start = ref_pos
        .checked_add(usize::try_from(offset).map_err(|_| Problem::Unreadable)?)
        .ok_or(Problem::Unreadable)?;
    let end = start.checked_add(length).ok_or(Problem::Unreadable)?;
    let name_raw = entry.get(start..end).ok_or(Problem::Unreadable)?;
    let name = name_raw
        .iter()
        .position(|b| *b == 0)
        .and_then(|nul| name_raw.get(..nul))
        .unwrap_or(name_raw);
    if name.is_empty() {
        return Err(Problem::Unreadable);
    }
    if common & libc::ATTR_CMN_OBJTYPE == 0 {
        // Without the type a directory would be recorded as a leaf and its
        // whole subtree silently lost: one stat through the directory
        // descriptor says what the entry is, and every fact is taken from it.
        // Only when that stat fails too does the entry stay a withheld leaf.
        if let Some(meta) = type_fallback(name) {
            out.push(name, meta);
            return Ok(());
        }
    }

    let mut withheld = false;
    let dev = if common & libc::ATTR_CMN_DEVID != 0 {
        f64::from(cur.i32()?)
    } else {
        withheld = true;
        0.0
    };
    let objtype = if common & libc::ATTR_CMN_OBJTYPE != 0 {
        cur.u32()?
    } else {
        withheld = true;
        VNON
    };
    let mtime_ms = if common & libc::ATTR_CMN_MODTIME != 0 {
        let (sec, nsec) = cur.timespec()?;
        time_ms(sec, nsec)
    } else {
        withheld = true;
        f64::NAN
    };
    let atime_ms = if common & libc::ATTR_CMN_ACCTIME != 0 {
        let (sec, nsec) = cur.timespec()?;
        if want_atime {
            time_ms(sec, nsec)
        } else {
            f64::NAN
        }
    } else {
        f64::NAN
    };
    let st_flags = if common & libc::ATTR_CMN_FLAGS != 0 {
        cur.u32()?
    } else {
        withheld = true;
        0
    };
    let ino = if common & libc::ATTR_CMN_FILEID != 0 {
        u128::from(cur.u64()?)
    } else {
        withheld = true;
        0
    };

    // The directory group sits between the common and the file group.
    let mountstatus = if dir & libc::ATTR_DIR_MOUNTSTATUS != 0 {
        cur.u32()?
    } else {
        0
    };
    let kind = match objtype {
        VDIR => KIND_DIR,
        VLNK => KIND_SYMLINK,
        _ => KIND_FILE,
    };
    // Only a regular file or a symlink has a data fork whose absence means
    // something was withheld; a directory, a socket, a fifo or a device has none.
    let needs_file_group = matches!(objtype, VREG | VLNK);
    let nlink = if file & libc::ATTR_FILE_LINKCOUNT != 0 {
        cur.u32()?
    } else {
        withheld |= needs_file_group;
        0
    };
    let alloc = if file & libc::ATTR_FILE_ALLOCSIZE != 0 {
        cur.i64()? as f64
    } else {
        withheld |= needs_file_group;
        0.0
    };
    let size = if file & libc::ATTR_FILE_DATALENGTH != 0 {
        cur.i64()? as f64
    } else {
        withheld |= needs_file_group;
        0.0
    };
    let (size, alloc) = if kind == KIND_DIR {
        (0.0, 0.0)
    } else {
        (size, alloc)
    };
    let flags = if st_flags & SF_DATALESS != 0 {
        FLAG_DATALESS
    } else {
        0
    };
    out.push(
        name,
        Meta {
            kind,
            flags,
            size,
            alloc,
            mtime_ms,
            atime_ms,
            dev,
            ino,
            nlink,
            withheld,
        },
    );
    if kind == KIND_DIR && mountstatus & libc::DIR_MNTSTATUS_MNTPOINT != 0 {
        out.mount_points.push(out.entries.len().saturating_sub(1));
    }
    Ok(())
}

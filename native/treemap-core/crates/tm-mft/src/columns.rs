//! The columns file (M6): how `tm-mft-helper` hands the scan root's subtree
//! to the app. The helper runs elevated in its own process, so the columns
//! cross as a file under the app's temp folder, and `tm-node`'s `mftTake`
//! reads them back into the same typed arrays a native walk produces.
//!
//! The format is versioned by its magic and little-endian throughout:
//!
//! | bytes | what |
//! | --- | --- |
//! | 0..8 | the magic: `TMMFT002` for columns, `TMMFTERR` for a refusal |
//! | 8..12 | the entry count `n` (the root included), `u32`; for a refusal, the sentence's length in bytes |
//! | 12..16 | flags, `u32`: bit 0 [`FLAG_ATIME`]; any other bit is refused |
//!
//! then, for columns, each column of [`WalkOutput`] back to back: `parent`
//! (`n` × `u32`), `name_off` (`n + 1` × `u32`), `names` (`name_off[n]`
//! bytes of UTF-8), `kind` and `flags` (`n` bytes each), `size`,
//! `alloc_bytes`, `mtime_ms` and `atime_ms` (`n` × `f64` each, NaN kept bit
//! for bit); the hard-link table (a `u32` count, then `node: u32, family:
//! u32` each — version 1 carried `dev` and `ino` as doubles, which cannot
//! hold a file id: the pre-landing review of 23 Sep 2026); the refusal table (a `u32` count, then `node: u32, why:
//! u8` each); and the stats (`dirs_listed: u64, entries: u64, wall_ms: f64,
//! cpu_seconds: f64, fast_path: u8, workers_peak: u32, climb_steps: u32,
//! denied_entries: u64, unreadable_entries: u64, dataless: u64`). Nothing
//! follows. A refusal is the header and the sentence, as UTF-8.
//!
//! The file lives in a folder the user's own processes can write, so the
//! reader trusts nothing in it: every length is checked against what is
//! left before anything is allocated, and the columns must have the shape
//! the ingest relies on ([`check_shape`]) — above all `parent[i] < i`,
//! without which the ingest's walk up a parent chain could loop forever.
//! The encoder applies the same check, so the helper never writes a file
//! the app would refuse.

use std::fmt;

use tm_walk::{
    DirRefusal, FLAG_DATALESS, FLAG_REFUSED_DIR, FastPath, HardlinkRef, KIND_DIR, KIND_FILE,
    KIND_SYMLINK, Refusal, WalkOutput, WalkStats,
};

/// The magic of a columns file (format version 2: hard links by family).
pub const MAGIC_COLUMNS: [u8; 8] = *b"TMMFT002";
/// What every version's magic starts with, so a file from another build is
/// named as that rather than as something else entirely.
const MAGIC_FAMILY: &[u8] = b"TMMFT";
/// The magic of a refusal: the helper's reason, as a sentence.
pub const MAGIC_REFUSAL: [u8; 8] = *b"TMMFTERR";
/// The header: the magic, the entry count and the flags.
pub const HEADER_BYTES: usize = 16;
/// Header flag: the access-time column was asked for (NaN where the
/// volume recorded none); without it the column is NaN throughout.
pub const FLAG_ATIME: u32 = 1;
/// Every header flag this build knows.
const KNOWN_FLAGS: u32 = FLAG_ATIME;
/// The longest refusal sentence a file may carry, in bytes.
pub const MAX_REFUSAL_BYTES: usize = 64 * 1024;
/// The extension of every columns file the app names.
pub const OUTPUT_EXTENSION: &str = ".tmmft";

/// Whether `name` is one the app gives a columns file: letters, digits, `-`,
/// `_` and `.`, a non-empty stem, ending in [`OUTPUT_EXTENSION`] — so no
/// alternate data stream (`:`), no other extension, no device name trick.
/// The elevated helper creates nothing else, and `mftTake` reads nothing else.
pub fn is_output_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(OUTPUT_EXTENSION) else {
        return false;
    };
    !stem.is_empty()
        && !stem.starts_with('.')
        && stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// A hard-link entry: `node: u32, family: u32`.
const HARDLINK_BYTES: usize = 4 + 4;
/// A refusal entry: `node: u32, why: u8`.
const REFUSAL_BYTES: usize = 4 + 1;

/// What a file holds.
#[derive(Debug)]
pub enum ColumnsFile {
    /// The scan root's subtree (boxed: it is the large variant).
    Columns(Box<WalkOutput>),
    /// The helper's refusal, as the sentence it wrote.
    Refusal(String),
}

/// Why a file was refused. Every variant reads as a sentence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ColumnsError {
    /// Shorter than the header.
    TooShort,
    /// Neither magic.
    BadMagic,
    /// A columns file from another build: its magic names another version.
    OtherVersion([u8; 8]),
    /// A header flag this build does not know (the whole flags word).
    UnknownFlags(u32),
    /// The file ends inside a section.
    Truncated {
        /// The section it ends in.
        section: &'static str,
    },
    /// Bytes after the last section (how many).
    TrailingBytes(u64),
    /// The columns are not shaped as the ingest needs.
    BadShape {
        /// What is wrong, as a noun phrase.
        reason: &'static str,
    },
    /// A count or a length past what this platform can address.
    TooLarge,
}

impl fmt::Display for ColumnsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooShort => write!(
                f,
                "the columns file is shorter than its {HEADER_BYTES}-byte header"
            ),
            Self::BadMagic => f.write_str(
                "the file is not a TreeMap columns file: its magic is neither TMMFT002 nor TMMFTERR",
            ),
            Self::OtherVersion(magic) => write!(
                f,
                "the columns file was written by another TreeMap build (format {}); this build reads TMMFT002",
                String::from_utf8_lossy(magic)
            ),
            Self::UnknownFlags(flags) => write!(
                f,
                "the columns file sets header flags {flags:#x}, which this build does not know"
            ),
            Self::Truncated { section } => {
                write!(f, "the columns file ends inside its {section}")
            }
            Self::TrailingBytes(n) => {
                write!(f, "the columns file has {n} bytes after its last section")
            }
            Self::BadShape { reason } => write!(f, "the columns file holds {reason}"),
            Self::TooLarge => f.write_str(
                "the columns file declares more than this platform can hold in memory",
            ),
        }
    }
}

impl std::error::Error for ColumnsError {}

/// The file format's own code for a fast path (stable whatever `tm-walk`
/// numbers them internally).
fn fast_path_code(path: FastPath) -> u8 {
    match path {
        FastPath::Bulk => 0,
        FastPath::ExtdDirInfo => 1,
        FastPath::Getdents => 2,
        FastPath::PerEntry => 3,
        FastPath::Unavailable => 4,
        FastPath::Mft => 5,
    }
}

fn fast_path_of(code: u8) -> Option<FastPath> {
    match code {
        0 => Some(FastPath::Bulk),
        1 => Some(FastPath::ExtdDirInfo),
        2 => Some(FastPath::Getdents),
        3 => Some(FastPath::PerEntry),
        4 => Some(FastPath::Unavailable),
        5 => Some(FastPath::Mft),
        _ => None,
    }
}

fn refusal_of(code: u8) -> Option<Refusal> {
    match code {
        1 => Some(Refusal::Denied),
        2 => Some(Refusal::Vanished),
        3 => Some(Refusal::Unreadable),
        _ => None,
    }
}

fn bad(reason: &'static str) -> ColumnsError {
    ColumnsError::BadShape { reason }
}

/// The bytes a node's name must not hold: joined onto its parent's path it
/// would name something else — another file (`a\b`), a stream of a file
/// (`a:b`), a path cut short (NUL). The listing never stages one
/// (`tm_walk`'s `stage_record`).
const NOT_IN_A_NAME: &[u8] = b"/\\:\0";
/// The largest count JavaScript holds exactly (`Number.MAX_SAFE_INTEGER`):
/// past it a count would cross napi as a number the ingest cannot add to.
const MAX_SAFE_COUNT: u64 = (1 << 53) - 1;

/// Whether `name`, joined onto its parent's path, names that entry and
/// nothing else: not empty, not `.` or `..` (which a listing never reports
/// as an entry), none of [`NOT_IN_A_NAME`].
fn is_one_name(name: &[u8]) -> bool {
    !name.is_empty()
        && name != b"."
        && name != b".."
        && !name.iter().any(|b| NOT_IN_A_NAME.contains(b))
}

/// A size or an allocation a file system could report: a whole, finite,
/// non-negative number of bytes (the listing clamps a negative one to 0).
fn is_byte_count(v: f64) -> bool {
    v.is_finite() && v >= 0.0
}

/// The shape the ingest relies on, checked on both sides of the file: at
/// least a root; every column `n` long and `name_off` `n + 1`; the root its
/// own parent and every other node's parent before it; name offsets from 0,
/// never decreasing, ending at the names' length, each name UTF-8 and, but
/// the root's (the scan path's), one name; sizes and allocations finite and
/// not negative; known kinds and node flags; side tables inside the nodes,
/// sorted by node; and stats a walk of these nodes could have counted.
pub fn check_shape(out: &WalkOutput) -> Result<(), ColumnsError> {
    let n = out.parent.len();
    if n == 0 {
        return Err(bad("no root"));
    }
    let lengths = [
        out.kind.len(),
        out.flags.len(),
        out.size.len(),
        out.alloc_bytes.len(),
        out.mtime_ms.len(),
        out.atime_ms.len(),
    ];
    if lengths.iter().any(|&len| len != n) || out.name_off.len() != n.saturating_add(1) {
        return Err(bad("a column shorter or longer than the others"));
    }
    for (i, &p) in out.parent.iter().enumerate() {
        let p = usize::try_from(p).map_err(|_| ColumnsError::TooLarge)?;
        let precedes = if i == 0 { p == 0 } else { p < i };
        if !precedes {
            return Err(bad("a parent that does not precede its child"));
        }
    }
    check_names(out)?;
    if !out
        .size
        .iter()
        .chain(&out.alloc_bytes)
        .all(|&v| is_byte_count(v))
    {
        return Err(bad(
            "a size or allocation that is negative or not a finite number",
        ));
    }
    if out
        .kind
        .iter()
        .any(|k| ![KIND_FILE, KIND_DIR, KIND_SYMLINK].contains(k))
    {
        return Err(bad("an unknown kind"));
    }
    if out
        .flags
        .iter()
        .any(|f| f & !(FLAG_DATALESS | FLAG_REFUSED_DIR) != 0)
    {
        return Err(bad("an unknown node flag"));
    }
    let inside = |node: u32| usize::try_from(node).is_ok_and(|node| node < n);
    let sorted = |nodes: &[u32]| nodes.windows(2).all(|w| w.first() <= w.get(1));
    let links: Vec<u32> = out.hardlinks.iter().map(|h| h.node).collect();
    if !links.iter().all(|&node| inside(node)) || !sorted(&links) {
        return Err(bad("a hard link outside the nodes, or out of order"));
    }
    // Families are numbered from 0, at most one per link.
    if out
        .hardlinks
        .iter()
        .any(|h| usize::try_from(h.family).map_or(true, |f| f >= links.len()))
    {
        return Err(bad("a hard-link family numbered past the table"));
    }
    let refused: Vec<u32> = out.refusals.iter().map(|r| r.node).collect();
    if !refused.iter().all(|&node| inside(node)) || !sorted(&refused) {
        return Err(bad("a refusal outside the nodes, or out of order"));
    }
    check_stats(out)
}

/// The stats against the nodes: every node but the root an entry; no more
/// directories listed, or dataless entries, than nodes; the omitted-entry
/// counts within what JavaScript holds exactly; a finite, non-negative wall
/// time; a CPU time that is NaN (no thread clock) or finite and non-negative.
fn check_stats(out: &WalkOutput) -> Result<(), ColumnsError> {
    let s = &out.stats;
    let n = u64::try_from(out.parent.len()).map_err(|_| ColumnsError::TooLarge)?;
    if s.entries != n.saturating_sub(1) {
        return Err(bad("an entry count other than its nodes under the root"));
    }
    if s.dirs_listed > n || s.dataless > n {
        return Err(bad(
            "more directories listed, or entries without their data, than nodes",
        ));
    }
    if s.denied_entries > MAX_SAFE_COUNT || s.unreadable_entries > MAX_SAFE_COUNT {
        return Err(bad(
            "a count of omitted entries past 2^53 - 1, which JavaScript cannot hold exactly",
        ));
    }
    if !is_byte_count(s.wall_ms) {
        return Err(bad("a wall time that is negative or not a finite number"));
    }
    if s.cpu_seconds.is_infinite() || s.cpu_seconds < 0.0 {
        return Err(bad("a CPU time that is negative or infinite"));
    }
    Ok(())
}

/// The name offsets and the names: from 0, never decreasing, ending at the
/// names' length, each name UTF-8 and every name but the root's one name.
fn check_names(out: &WalkOutput) -> Result<(), ColumnsError> {
    if out.name_off.first() != Some(&0) {
        return Err(bad("a first name offset that is not 0"));
    }
    for (node, pair) in out.name_off.windows(2).enumerate() {
        let (Some(&start), Some(&end)) = (pair.first(), pair.get(1)) else {
            return Err(bad("a name offset outside the names"));
        };
        let start = usize::try_from(start).map_err(|_| ColumnsError::TooLarge)?;
        let end = usize::try_from(end).map_err(|_| ColumnsError::TooLarge)?;
        let name = out
            .names
            .get(start..end)
            .ok_or_else(|| bad("a name offset outside the names"))?;
        if std::str::from_utf8(name).is_err() {
            return Err(bad("a name that is not UTF-8"));
        }
        if node > 0 && !is_one_name(name) {
            return Err(bad(
                "a name that is not one file name: empty, `.` or `..`, or holding `/`, `\\`, `:` or NUL",
            ));
        }
    }
    let last = out.name_off.last().copied().unwrap_or(0);
    if usize::try_from(last).ok() != Some(out.names.len()) {
        return Err(bad("names past the last name offset"));
    }
    Ok(())
}

fn count(len: usize) -> Result<u32, ColumnsError> {
    u32::try_from(len).map_err(|_| ColumnsError::TooLarge)
}

/// `out` as a columns file with header `flags`. Refuses a shape the reader
/// would refuse ([`check_shape`]) and flags this build does not know.
pub fn encode_columns(out: &WalkOutput, flags: u32) -> Result<Vec<u8>, ColumnsError> {
    if flags & !KNOWN_FLAGS != 0 {
        return Err(ColumnsError::UnknownFlags(flags));
    }
    check_shape(out)?;
    let n = count(out.len())?;
    let mut w = Vec::with_capacity(
        HEADER_BYTES
            .saturating_add(out.names.len())
            .saturating_add(out.len().saturating_mul(42)),
    );
    w.extend_from_slice(&MAGIC_COLUMNS);
    w.extend_from_slice(&n.to_le_bytes());
    w.extend_from_slice(&flags.to_le_bytes());
    for v in out.parent.iter().chain(&out.name_off) {
        w.extend_from_slice(&v.to_le_bytes());
    }
    w.extend_from_slice(&out.names);
    w.extend_from_slice(&out.kind);
    w.extend_from_slice(&out.flags);
    for column in [&out.size, &out.alloc_bytes, &out.mtime_ms, &out.atime_ms] {
        for v in column {
            w.extend_from_slice(&v.to_le_bytes());
        }
    }
    w.extend_from_slice(&count(out.hardlinks.len())?.to_le_bytes());
    for link in &out.hardlinks {
        w.extend_from_slice(&link.node.to_le_bytes());
        w.extend_from_slice(&link.family.to_le_bytes());
    }
    w.extend_from_slice(&count(out.refusals.len())?.to_le_bytes());
    for refusal in &out.refusals {
        w.extend_from_slice(&refusal.node.to_le_bytes());
        w.push(refusal.why.code());
    }
    let s = &out.stats;
    w.extend_from_slice(&s.dirs_listed.to_le_bytes());
    w.extend_from_slice(&s.entries.to_le_bytes());
    w.extend_from_slice(&s.wall_ms.to_le_bytes());
    w.extend_from_slice(&s.cpu_seconds.to_le_bytes());
    w.push(fast_path_code(s.fast_path));
    w.extend_from_slice(&s.workers_peak.to_le_bytes());
    w.extend_from_slice(&s.climb_steps.to_le_bytes());
    w.extend_from_slice(&s.denied_entries.to_le_bytes());
    w.extend_from_slice(&s.unreadable_entries.to_le_bytes());
    w.extend_from_slice(&s.dataless.to_le_bytes());
    Ok(w)
}

/// A refusal file: the header and `sentence` as UTF-8, cut at a character
/// boundary to [`MAX_REFUSAL_BYTES`].
pub fn encode_refusal(sentence: &str) -> Vec<u8> {
    let mut end = sentence.len().min(MAX_REFUSAL_BYTES);
    while !sentence.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    let text = sentence.get(..end).unwrap_or_default().as_bytes();
    let mut w = Vec::with_capacity(HEADER_BYTES.saturating_add(text.len()));
    w.extend_from_slice(&MAGIC_REFUSAL);
    w.extend_from_slice(&count(text.len()).unwrap_or(0).to_le_bytes());
    w.extend_from_slice(&0_u32.to_le_bytes());
    w.extend_from_slice(text);
    w
}

/// A cursor over the file that checks every length before it reads.
struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, len: usize, section: &'static str) -> Result<&'a [u8], ColumnsError> {
        let end = self
            .pos
            .checked_add(len)
            .ok_or(ColumnsError::Truncated { section })?;
        let out = self
            .bytes
            .get(self.pos..end)
            .ok_or(ColumnsError::Truncated { section })?;
        self.pos = end;
        Ok(out)
    }

    /// `items` records of `size` bytes each, as one checked slice.
    fn records(
        &mut self,
        items: usize,
        size: usize,
        section: &'static str,
    ) -> Result<&'a [u8], ColumnsError> {
        let len = items.checked_mul(size).ok_or(ColumnsError::TooLarge)?;
        self.take(len, section)
    }

    fn array<const N: usize>(&mut self, section: &'static str) -> Result<[u8; N], ColumnsError> {
        <[u8; N]>::try_from(self.take(N, section)?).map_err(|_| ColumnsError::Truncated { section })
    }

    fn u8(&mut self, section: &'static str) -> Result<u8, ColumnsError> {
        Ok(u8::from_le_bytes(self.array(section)?))
    }

    fn u32(&mut self, section: &'static str) -> Result<u32, ColumnsError> {
        Ok(u32::from_le_bytes(self.array(section)?))
    }

    fn u64(&mut self, section: &'static str) -> Result<u64, ColumnsError> {
        Ok(u64::from_le_bytes(self.array(section)?))
    }

    fn f64(&mut self, section: &'static str) -> Result<f64, ColumnsError> {
        Ok(f64::from_le_bytes(self.array(section)?))
    }

    fn u32s(&mut self, items: usize, section: &'static str) -> Result<Vec<u32>, ColumnsError> {
        let raw = self.records(items, 4, section)?;
        Ok(raw
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes([byte(c, 0), byte(c, 1), byte(c, 2), byte(c, 3)]))
            .collect())
    }

    fn f64s(&mut self, items: usize, section: &'static str) -> Result<Vec<f64>, ColumnsError> {
        let raw = self.records(items, 8, section)?;
        Ok(raw.chunks_exact(8).map(f64_at).collect())
    }

    fn rest(&self) -> usize {
        self.bytes.len().saturating_sub(self.pos)
    }
}

/// Byte `i` of a chunk `chunks_exact` sized; 0 never happens.
fn byte(chunk: &[u8], i: usize) -> u8 {
    chunk.get(i).copied().unwrap_or(0)
}

/// The little-endian `f64` at the start of an 8-byte chunk.
fn f64_at(chunk: &[u8]) -> f64 {
    let mut raw = [0_u8; 8];
    for (i, b) in raw.iter_mut().enumerate() {
        *b = byte(chunk, i);
    }
    f64::from_le_bytes(raw)
}

/// Reads a columns file or a refusal; refuses anything else with a reason.
pub fn decode(bytes: &[u8]) -> Result<ColumnsFile, ColumnsError> {
    if bytes.len() < HEADER_BYTES {
        return Err(ColumnsError::TooShort);
    }
    let mut r = Reader { bytes, pos: 0 };
    let magic: [u8; 8] = r.array("header")?;
    let entries = usize::try_from(r.u32("header")?).map_err(|_| ColumnsError::TooLarge)?;
    let flags = r.u32("header")?;
    if magic == MAGIC_REFUSAL {
        return decode_refusal(&mut r, entries, flags);
    }
    if magic != MAGIC_COLUMNS {
        return Err(if magic.starts_with(MAGIC_FAMILY) {
            ColumnsError::OtherVersion(magic)
        } else {
            ColumnsError::BadMagic
        });
    }
    if flags & !KNOWN_FLAGS != 0 {
        return Err(ColumnsError::UnknownFlags(flags));
    }
    if entries == 0 {
        return Err(bad("no root"));
    }
    let out = decode_columns(&mut r, entries)?;
    let rest = r.rest();
    if rest != 0 {
        return Err(ColumnsError::TrailingBytes(
            u64::try_from(rest).unwrap_or(u64::MAX),
        ));
    }
    check_shape(&out)?;
    Ok(ColumnsFile::Columns(Box::new(out)))
}

fn decode_refusal(r: &mut Reader<'_>, len: usize, flags: u32) -> Result<ColumnsFile, ColumnsError> {
    if flags != 0 {
        return Err(ColumnsError::UnknownFlags(flags));
    }
    if len > MAX_REFUSAL_BYTES {
        return Err(ColumnsError::TooLarge);
    }
    let text = r.take(len, "refusal sentence")?;
    let rest = r.rest();
    if rest != 0 {
        return Err(ColumnsError::TrailingBytes(
            u64::try_from(rest).unwrap_or(u64::MAX),
        ));
    }
    let sentence =
        std::str::from_utf8(text).map_err(|_| bad("a refusal sentence that is not UTF-8"))?;
    Ok(ColumnsFile::Refusal(sentence.to_owned()))
}

fn decode_columns(r: &mut Reader<'_>, n: usize) -> Result<WalkOutput, ColumnsError> {
    let parent = r.u32s(n, "parent column")?;
    let name_off = r.u32s(
        n.checked_add(1).ok_or(ColumnsError::TooLarge)?,
        "name offsets",
    )?;
    let names_len = name_off
        .last()
        .map_or(Ok(0), |&len| usize::try_from(len))
        .map_err(|_| ColumnsError::TooLarge)?;
    let names = r.take(names_len, "names")?.to_vec();
    let kind = r.take(n, "kind column")?.to_vec();
    let flags = r.take(n, "flags column")?.to_vec();
    let size = r.f64s(n, "size column")?;
    let alloc_bytes = r.f64s(n, "allocation column")?;
    let mtime_ms = r.f64s(n, "modification-time column")?;
    let atime_ms = r.f64s(n, "access-time column")?;
    let links = usize::try_from(r.u32("hard-link count")?).map_err(|_| ColumnsError::TooLarge)?;
    let raw = r.records(links, HARDLINK_BYTES, "hard-link table")?;
    let hardlinks = raw
        .chunks_exact(HARDLINK_BYTES)
        .map(|c| HardlinkRef {
            node: u32::from_le_bytes([byte(c, 0), byte(c, 1), byte(c, 2), byte(c, 3)]),
            family: u32::from_le_bytes([byte(c, 4), byte(c, 5), byte(c, 6), byte(c, 7)]),
        })
        .collect();
    let refused = usize::try_from(r.u32("refusal count")?).map_err(|_| ColumnsError::TooLarge)?;
    let raw = r.records(refused, REFUSAL_BYTES, "refusal table")?;
    let refusals = raw
        .chunks_exact(REFUSAL_BYTES)
        .map(|c| {
            Ok(DirRefusal {
                node: u32::from_le_bytes([byte(c, 0), byte(c, 1), byte(c, 2), byte(c, 3)]),
                why: refusal_of(byte(c, 4)).ok_or_else(|| bad("an unknown refusal code"))?,
            })
        })
        .collect::<Result<Vec<_>, ColumnsError>>()?;
    let stats = decode_stats(r)?;
    Ok(WalkOutput {
        parent,
        name_off,
        names,
        kind,
        flags,
        size,
        alloc_bytes,
        mtime_ms,
        atime_ms,
        hardlinks,
        refusals,
        stats,
    })
}

fn decode_stats(r: &mut Reader<'_>) -> Result<WalkStats, ColumnsError> {
    const SECTION: &str = "stats";
    Ok(WalkStats {
        dirs_listed: r.u64(SECTION)?,
        entries: r.u64(SECTION)?,
        wall_ms: r.f64(SECTION)?,
        cpu_seconds: r.f64(SECTION)?,
        fast_path: fast_path_of(r.u8(SECTION)?).ok_or_else(|| bad("an unknown fast path code"))?,
        workers_peak: r.u32(SECTION)?,
        climb_steps: r.u32(SECTION)?,
        denied_entries: r.u64(SECTION)?,
        unreadable_entries: r.u64(SECTION)?,
        dataless: r.u64(SECTION)?,
    })
}

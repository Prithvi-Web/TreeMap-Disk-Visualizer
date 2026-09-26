//! A scripted listing that reads nothing from disk (Phase 4, P4-8): the
//! [`SyntheticLister`] answers every listing from a [`SyntheticSpec`] and the
//! folder's path alone, so one seed lists one tree whatever order the folders
//! are listed in and however many workers list them. It is refused for a root
//! outside the app's own synthetic temp folder ([`synthetic_fences`]), and it
//! never creates, opens or reads anything there.
//!
//! The tree, for `entries` entries under the root:
//! * `entries × folder_ppm / 10⁶` of them (rounded down) are folders, the rest
//!   files.
//! * The folders fill `min(depth, folders)` levels below the root. A level
//!   holds at most `fan_out` times the level above and takes an even share of
//!   the folders still to place; its folders are spread evenly over the level
//!   above, so no folder holds more than `fan_out` subfolders. Folders are
//!   numbered level by level from 1; the root is folder 0.
//! * The files are spread evenly over every folder, the root included, and
//!   numbered in folder order.
//! * Every name is `name_len` bytes: a seeded run of `a-z0-9`, a `-`, the
//!   entry's number in base 36 (a folder's own number, a file's number within
//!   its folder), and for a file a `.` and a seeded extension. The number
//!   keeps names unique in their folder, and lets a folder's path be read back.
//! * Sizes are log-normal around `size_median` with `size_sigma_milli / 1000`
//!   as the spread of their natural log, drawn with integer sums and IEEE
//!   754's exactly rounded `+ − × ÷ √` only, so no platform's maths library
//!   enters a draw. Allocated bytes are the size rounded up to 4,096-byte
//!   blocks.
//! * `link_ppm` of the files, in whole pairs, are hard-linked: the two names
//!   of a pair report one inode, a link count of 2, and one size and time.
//!   They are files `r` and `r + files / 2` (rounded down) in file order, so
//!   they lie in different folders unless one folder holds more than
//!   `files / 2` files: never with two or more subfolders; with none, every
//!   pair shares the root, and with one subfolder and an odd file count, one
//!   pair does.
//!
//! The lister reports [`FastPath::Unavailable`]: no platform listing ran.

use std::path::{Component, Path, PathBuf};

use crate::output::Refusal;
use crate::platform::{ListBuffer, Listed, Lister, Meta, list_whole, time_ms};
use crate::{FastPath, KIND_DIR, KIND_FILE, WalkError};

mod shape;

use shape::Shape;

/// The app's synthetic temp folder, under the OS temp folder: a synthetic root
/// must lie inside it. Nothing ever creates it.
pub const SYNTHETIC_TEMP_FOLDER: &str = "TreeMap-synthetic";
/// Entries a listing hands over between two looks at the cancel flag, each
/// look after the first one beating the heartbeat.
pub const SYNTHETIC_BATCH: usize = 4096;
/// The most entries a synthetic tree may hold: the walk's id ceiling.
pub const MAX_SYNTHETIC_ENTRIES: u64 = 4_294_967_294;
/// The most folder levels below the root.
pub const MAX_SYNTHETIC_DEPTH: u32 = 256;
/// The longest name a file system allows (`NAME_MAX`).
pub const MAX_NAME_LEN: u32 = 255;
/// The widest spread of the sizes' natural log, in thousandths.
pub const MAX_SIGMA_MILLI: u32 = 10_000;
/// The largest size a double holds exactly: 2^53 bytes.
pub const MAX_EXACT_SIZE: u64 = 1 << 53;
/// The denominator of the folder and hard-link shares.
pub const PPM: u32 = 1_000_000;

/// The characters a name's seeded run is drawn from.
const ALPHABET: &[u8; 36] = b"abcdefghijklmnopqrstuvwxyz0123456789";
/// Base-36 digits, by value.
const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
/// Characters one 64-bit draw yields: 36^12 < 2^64.
const CHARS_PER_DRAW: u32 = 12;
/// File extensions, one drawn per file.
const EXTENSIONS: [&str; 16] = [
    "js", "ts", "json", "md", "png", "txt", "rs", "h", "c", "py", "html", "css", "svg", "jpg", "o",
    "lock",
];
/// The longest of [`EXTENSIONS`].
const LONGEST_EXTENSION: u64 = 4;
/// The device id every synthetic entry reports: one volume.
const SYNTHETIC_DEV: f64 = 32_343.0;
/// The block allocated sizes are rounded up to.
const BLOCK_BYTES: f64 = 4096.0;
/// The latest modification time drawn: 2025-06-15 in seconds since the epoch.
const LATEST_SECONDS: i64 = 1_750_000_000;
/// Modification times lie up to five years before [`LATEST_SECONDS`].
const MTIME_SPAN_SECONDS: u64 = 5 * 365 * 86_400;
/// Access times lie up to thirty days after the modification time.
const ATIME_SPAN_SECONDS: u64 = 30 * 86_400;
/// Nanoseconds in a second.
const NANOS: u64 = 1_000_000_000;
/// √3: four uniform draws summed have a variance of 1/3.
const SQRT_3: f64 = 1.732_050_807_568_877_2;
/// Sizes are drawn on steps of 1/64 of an octave.
const STEPS_PER_OCTAVE: i64 = 64;
/// The splitmix64 increment.
const GOLDEN: u64 = 0x9E37_79B9_7F4A_7C15;
/// An odd multiplier that spreads a key before it is mixed.
const KEY_SPREAD: u64 = 0xD1B5_4A32_D192_ED03;

/// What each seeded draw is for: one stream per purpose.
const TAG_DIR_NAME: u64 = 1;
const TAG_FILE_NAME: u64 = 2;
const TAG_DIR_TIME: u64 = 3;
const TAG_FILE_TIME: u64 = 4;
const TAG_FILE_SIZE: u64 = 5;
const TAG_LINK_TIME: u64 = 6;
const TAG_LINK_SIZE: u64 = 7;
const TAG_LINK_STEP: u64 = 8;

/// The shape of a synthetic tree. Every field is an integer, so the options
/// that carry it compare exactly.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyntheticSpec {
    /// Every name, size, time and hard-link pair is drawn from it; the shape is not.
    pub seed: u64,
    /// Entries under the root, as the walk counts them (the root is not one).
    pub entries: u64,
    /// The most subfolders one folder holds.
    pub fan_out: u32,
    /// The folder levels below the root (fewer only when there are fewer folders).
    pub depth: u32,
    /// Folders per million entries.
    pub folder_ppm: u32,
    /// Bytes in every name.
    pub name_len: u32,
    /// The median file size in bytes.
    pub size_median: u64,
    /// The spread of the sizes' natural log, in thousandths.
    pub size_sigma_milli: u32,
    /// Hard-linked file names per million files, rounded down to whole pairs.
    pub link_ppm: u32,
}

impl SyntheticSpec {
    /// The developer shape of design §S.8: 15% folders, 18-byte names,
    /// log-normal sizes around 4 KiB with a spread of 2, 1% of the files
    /// hard-linked in pairs across folders, at most 16 subfolders per folder
    /// and 12 folder levels.
    pub fn developer(entries: u64, seed: u64) -> Self {
        Self {
            seed,
            entries,
            fan_out: 16,
            depth: 12,
            folder_ppm: 150_000,
            name_len: 18,
            size_median: 4096,
            size_sigma_milli: 2_000,
            link_ppm: 10_000,
        }
    }
}

/// [`SYNTHETIC_TEMP_FOLDER`] in the OS temp folder as `std::env::temp_dir()`
/// spells it: the first of [`synthetic_fences`], and the folder a caller
/// outside Rust is given to put synthetic roots in, since only Rust's own
/// rule names it (on macOS with no `TMPDIR` it is the per-user temp folder,
/// not `TMP`, `TEMP` or `/tmp`). Nothing is created.
pub fn synthetic_temp_folder() -> PathBuf {
    std::env::temp_dir().join(SYNTHETIC_TEMP_FOLDER)
}

/// The folders a synthetic root may lie inside: [`synthetic_temp_folder`],
/// and the same folder as the temp folder's resolved path spells it where
/// that differs (macOS's `/var` is a link to `/private/var`). Resolving reads
/// the temp folder's path; nothing is created.
pub fn synthetic_fences() -> Vec<PathBuf> {
    let mut fences = vec![synthetic_temp_folder()];
    if let Ok(real) = std::fs::canonicalize(std::env::temp_dir()) {
        let resolved = real.join(SYNTHETIC_TEMP_FOLDER);
        if !fences.contains(&resolved) {
            fences.push(resolved);
        }
    }
    fences
}

/// True when `root` is strictly inside one of `fences`, reached by plain
/// names only (no `..`), so a synthetic path can never name anything else.
fn inside_a_fence(root: &Path, fences: &[PathBuf]) -> bool {
    fences.iter().any(|fence| {
        root.strip_prefix(fence).is_ok_and(|rest| {
            let mut parts = rest.components().peekable();
            parts.peek().is_some() && parts.all(|part| matches!(part, Component::Normal(_)))
        })
    })
}

/// How many base-36 digits `n` takes.
fn base36_len(mut n: u64) -> u64 {
    let mut digits = 1;
    while n >= 36 {
        n /= 36;
        digits += 1;
    }
    digits
}

/// splitmix64's finaliser.
fn mix(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// The draw for `key` in stream `tag` under `seed`.
fn draw(seed: u64, tag: u64, key: u64) -> u64 {
    mix(mix(seed ^ tag.wrapping_mul(GOLDEN)) ^ key.wrapping_mul(KEY_SPREAD))
}

/// `2^(k/64)` for `k` in `0..64`, built by six square roots of 2 and repeated
/// products: both are exactly rounded in IEEE 754, so every platform agrees.
fn octave_steps() -> [f64; 64] {
    let mut root = 2.0_f64;
    for _ in 0..6 {
        root = root.sqrt();
    }
    let mut steps = [1.0_f64; 64];
    let mut value = 1.0_f64;
    for step in &mut steps {
        *step = value;
        value *= root;
    }
    steps
}

/// `2^whole` exactly, for `whole` in the normal exponent range.
fn power_of_two(whole: i64) -> f64 {
    let biased = u64::try_from(whole.clamp(-1022, 1023) + 1023).unwrap_or(1023);
    f64::from_bits(biased << 52)
}

/// Appends `count` characters of [`ALPHABET`] drawn from `state`.
fn push_seeded(mut state: u64, count: u64, out: &mut Vec<u8>) {
    let mut word = 0_u64;
    let mut left = 0_u32;
    for _ in 0..count {
        if left == 0 {
            state = mix(state.wrapping_add(GOLDEN));
            word = state;
            left = CHARS_PER_DRAW;
        }
        let at = usize::try_from(word % 36).unwrap_or(0);
        out.push(ALPHABET.get(at).copied().unwrap_or(b'a'));
        word /= 36;
        left -= 1;
    }
}

fn push_base36(out: &mut Vec<u8>, n: u64) {
    let start = out.len();
    let mut n = n;
    loop {
        let at = usize::try_from(n % 36).unwrap_or(0);
        out.push(DIGITS.get(at).copied().unwrap_or(b'0'));
        n /= 36;
        if n == 0 {
            break;
        }
    }
    if let Some(digits) = out.get_mut(start..) {
        digits.reverse();
    }
}

/// A base-36 digit's value, as [`push_base36`] writes it (`0-9`, then `a-z`).
fn base36_value(byte: u8) -> Option<u64> {
    match byte {
        b'0'..=b'9' => Some(u64::from(byte - b'0')),
        b'a'..=b'z' => Some(u64::from(byte - b'a') + 10),
        _ => None,
    }
}

/// The number a folder's name ends with, after its last `-`.
fn folder_number(name: &[u8]) -> Option<u64> {
    let dash = name.iter().rposition(|&b| b == b'-')?;
    let digits = name.get(dash + 1..)?;
    if digits.is_empty() {
        return None;
    }
    digits.iter().try_fold(0_u64, |n, &b| {
        n.checked_mul(36)?.checked_add(base36_value(b)?)
    })
}

/// The scripted lister: see the module's description.
#[derive(Debug)]
pub struct SyntheticLister {
    seed: u64,
    root: PathBuf,
    shape: Shape,
    name_len: u64,
    size_median: f64,
    /// The spread of log2 of a size: the natural-log spread × log2(e).
    octaves_per_sigma: f64,
    octave_steps: [f64; 64],
}

impl SyntheticLister {
    /// The lister for `spec` at `root`. Refused when `root` is not inside the
    /// app's synthetic temp folder ([`synthetic_fences`]), and when the spec
    /// cannot be built; each reason is a sentence.
    pub fn new(spec: &SyntheticSpec, root: &Path) -> Result<Self, WalkError> {
        let fences = synthetic_fences();
        if !inside_a_fence(root, &fences) {
            let named: Vec<String> = fences.iter().map(|f| f.display().to_string()).collect();
            return Err(WalkError::OptionsRefused(format!(
                "a synthetic tree is listed only inside the app's synthetic temp folder ({}), and {} is not inside it",
                named.join(" or "),
                root.display()
            )));
        }
        let shape = Shape::new(spec).map_err(WalkError::OptionsRefused)?;
        Ok(Self {
            seed: spec.seed,
            root: root.to_path_buf(),
            shape,
            name_len: u64::from(spec.name_len),
            size_median: spec.size_median as f64,
            octaves_per_sigma: f64::from(spec.size_sigma_milli) / 1000.0 * std::f64::consts::LOG2_E,
            octave_steps: octave_steps(),
        })
    }

    /// The folder `path` names: the root is 0; `None` for a path that is not
    /// a folder of this tree.
    fn folder_at(&self, path: &Path) -> Option<u64> {
        let rest = path.strip_prefix(&self.root).ok()?;
        let mut folder = 0_u64;
        let mut expected = Vec::new();
        for component in rest.components() {
            let Component::Normal(name) = component else {
                return None;
            };
            // The OS's own bytes on Unix, and UTF-8 for the ASCII names this
            // lister makes on Windows.
            let name = name.as_encoded_bytes();
            let child = folder_number(name)?;
            if child == 0 || self.shape.parent_of(child)? != folder {
                return None;
            }
            self.dir_name(child, &mut expected);
            if expected.as_slice() != name {
                return None;
            }
            folder = child;
        }
        Some(folder)
    }

    fn dir_name(&self, g: u64, out: &mut Vec<u8>) {
        out.clear();
        let seeded = self.name_len.saturating_sub(1 + base36_len(g));
        push_seeded(draw(self.seed, TAG_DIR_NAME, g), seeded, out);
        out.push(b'-');
        push_base36(out, g);
    }

    /// File `q`'s name, `k`-th in its folder.
    fn file_name(&self, q: u64, k: u64, out: &mut Vec<u8>) {
        out.clear();
        let state = draw(self.seed, TAG_FILE_NAME, q);
        let pick = usize::try_from(state % 16).unwrap_or(0);
        let extension = EXTENSIONS.get(pick).copied().unwrap_or("bin");
        let fixed = 1 + base36_len(k) + 1 + u64::try_from(extension.len()).unwrap_or(0);
        push_seeded(state, self.name_len.saturating_sub(fixed), out);
        out.push(b'-');
        push_base36(out, k);
        out.push(b'.');
        out.extend_from_slice(extension.as_bytes());
    }

    /// Modification and access times for `key` in stream `tag`; the access
    /// time is NaN unless asked for, and never before the modification time.
    fn times(&self, tag: u64, key: u64, want_atime: bool) -> (f64, f64) {
        let state = draw(self.seed, tag, key);
        let back = i64::try_from(state % MTIME_SPAN_SECONDS).unwrap_or(0);
        let sec = LATEST_SECONDS - back;
        let later = mix(state);
        let nsec = i64::try_from(later % NANOS).unwrap_or(0);
        let mtime = time_ms(sec, nsec);
        let atime = if want_atime {
            let after = i64::try_from(mix(later) % ATIME_SPAN_SECONDS).unwrap_or(0);
            time_ms(sec + after, nsec)
        } else {
            f64::NAN
        };
        (mtime, atime)
    }

    /// A log-normal size from one draw: four 16-bit uniforms summed
    /// (Irwin–Hall, mean 2, variance 1/3) make a standard normal on ±2√3,
    /// scaled to octaves and taken in 1/64-octave steps from the median.
    #[expect(
        clippy::cast_possible_truncation,
        reason = "the step count is floored and bounded by ±2√3 × 10 × log2(e) × 64, about ±3,200"
    )]
    fn size(&self, state: u64) -> f64 {
        let sum = (state & 0xFFFF)
            + ((state >> 16) & 0xFFFF)
            + ((state >> 32) & 0xFFFF)
            + ((state >> 48) & 0xFFFF);
        let normal = (sum as f64 / 65_536.0 - 2.0) * SQRT_3;
        let steps = (normal * self.octaves_per_sigma * 64.0).floor() as i64;
        let whole = steps.div_euclid(STEPS_PER_OCTAVE);
        let part = usize::try_from(steps.rem_euclid(STEPS_PER_OCTAVE)).unwrap_or(0);
        let fraction = self.octave_steps.get(part).copied().unwrap_or(1.0);
        (self.size_median * fraction * power_of_two(whole))
            .round()
            .min(MAX_EXACT_SIZE as f64)
    }

    fn dir_meta(&self, g: u64, want_atime: bool) -> Meta {
        let (mtime_ms, atime_ms) = self.times(TAG_DIR_TIME, g, want_atime);
        Meta {
            kind: KIND_DIR,
            flags: 0,
            size: 0.0,
            alloc: 0.0,
            mtime_ms,
            atime_ms,
            dev: SYNTHETIC_DEV,
            ino: u128::from(g) + 1,
            nlink: 0,
            withheld: false,
        }
    }

    /// File `q`'s facts; both names of a hard-linked pair report the pair's.
    fn file_meta(&self, q: u64, want_atime: bool) -> Meta {
        let files_from = u128::from(self.shape.folders) + 2;
        let (size_tag, time_tag, key, ino, nlink) = match self.shape.pair_of(q) {
            Some(j) => (
                TAG_LINK_SIZE,
                TAG_LINK_TIME,
                j,
                files_from + u128::from(self.shape.files) + u128::from(j),
                2,
            ),
            None => (
                TAG_FILE_SIZE,
                TAG_FILE_TIME,
                q,
                files_from + u128::from(q),
                1,
            ),
        };
        let size = self.size(draw(self.seed, size_tag, key));
        let (mtime_ms, atime_ms) = self.times(time_tag, key, want_atime);
        Meta {
            kind: KIND_FILE,
            flags: 0,
            size,
            alloc: (size / BLOCK_BYTES).ceil() * BLOCK_BYTES,
            mtime_ms,
            atime_ms,
            dev: SYNTHETIC_DEV,
            ino,
            nlink,
            withheld: false,
        }
    }
}

/// Every [`SYNTHETIC_BATCH`] entries: beat the heartbeat (after the first
/// batch) and stop when the walk was cancelled; the walk discards a listing
/// a cancel ended, so which refusal ends it is immaterial.
fn checkpoint(buf: &ListBuffer, listed: usize) -> Result<(), Refusal> {
    if listed % SYNTHETIC_BATCH != 0 {
        return Ok(());
    }
    if listed > 0 {
        buf.beat();
    }
    if buf.stopped() {
        return Err(Refusal::Unreadable);
    }
    Ok(())
}

/// Where a synthetic listing that stopped early goes on from (T6b).
#[derive(Debug)]
struct SyntheticCursor {
    folder: u64,
    want_atime: bool,
    /// The next subfolder's number, and one past the last.
    child: u64,
    children_end: u64,
    /// The next file's place in the folder, and how many it holds.
    file: u64,
    files: u64,
}

impl SyntheticLister {
    /// Lists on from `at`: the folder's subfolders, then its files, until the
    /// folder is done or the listing holds `limit` entries; ordered by name,
    /// as the POSIX listers order theirs ([`crate::Listing::sort_by_name`]),
    /// once it is done.
    fn read_on(
        &self,
        mut at: SyntheticCursor,
        buf: &mut ListBuffer,
        limit: usize,
    ) -> Result<Listed, Refusal> {
        let limit = limit.max(1);
        let first = self.shape.first_file(at.folder);
        let mut name = Vec::new();
        loop {
            let a_folder = at.child < at.children_end;
            if !a_folder && at.file >= at.files {
                break;
            }
            if buf.listing.len() >= limit {
                buf.keep_cursor(at);
                return Ok(Listed::More);
            }
            checkpoint(buf, buf.listing.len())?;
            if a_folder {
                self.dir_name(at.child, &mut name);
                buf.listing
                    .push(&name, self.dir_meta(at.child, at.want_atime));
                at.child += 1;
            } else {
                let q = first + at.file;
                self.file_name(q, at.file, &mut name);
                buf.listing.push(&name, self.file_meta(q, at.want_atime));
                at.file += 1;
            }
        }
        buf.listing.sort_by_name();
        buf.beat();
        Ok(Listed::Complete(FastPath::Unavailable))
    }
}

impl Lister for SyntheticLister {
    fn stat_dir(&self, path: &Path, want_atime: bool) -> Result<Meta, Refusal> {
        self.folder_at(path)
            .map(|g| self.dir_meta(g, want_atime))
            .ok_or(Refusal::Vanished)
    }

    /// The folder's subfolders, then its files, ordered by name as the POSIX
    /// listers order theirs ([`crate::Listing::sort_by_name`]).
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
        dir: &Path,
        want_atime: bool,
        buf: &mut ListBuffer,
        limit: usize,
    ) -> Result<Listed, Refusal> {
        buf.close_cursor();
        buf.listing.clear();
        let folder = self.folder_at(dir).ok_or(Refusal::Vanished)?;
        let children = self.shape.child_folders(folder);
        let at = SyntheticCursor {
            folder,
            want_atime,
            child: children.start,
            children_end: children.end,
            file: 0,
            files: self.shape.files_in(folder),
        };
        self.read_on(at, buf, limit)
    }

    fn list_more(&self, buf: &mut ListBuffer, limit: usize) -> Result<Listed, Refusal> {
        let at = buf
            .take_cursor::<SyntheticCursor>()
            .ok_or(Refusal::Unreadable)?;
        self.read_on(at, buf, limit)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use super::{SYNTHETIC_BATCH, checkpoint};
    use crate::platform::ListBuffer;

    fn beats(buf: &ListBuffer) -> u64 {
        buf.heartbeat.load(Ordering::Acquire)
    }

    #[test]
    fn a_stop_ends_a_listing_at_the_next_batch_boundary_after_one_beat() -> Result<(), String> {
        let buf = ListBuffer::new(0);
        buf.stop.store(true, Ordering::Release);
        for listed in [SYNTHETIC_BATCH, 2 * SYNTHETIC_BATCH, 250 * SYNTHETIC_BATCH] {
            let before = beats(&buf);
            if checkpoint(&buf, listed).is_ok() {
                return Err(format!(
                    "a stop seen after {listed} entries was listed past"
                ));
            }
            assert_eq!(beats(&buf), before + 1, "{listed}: one beat, then the stop");
        }
        // Between two boundaries the flags are not looked at.
        for listed in [1, SYNTHETIC_BATCH - 1, SYNTHETIC_BATCH + 1] {
            let before = beats(&buf);
            checkpoint(&buf, listed).map_err(|why| format!("{listed}: {why}"))?;
            assert_eq!(beats(&buf), before, "{listed}: a beat between batches");
        }
        // Before the first entry the stop is seen, and no batch was answered.
        let before = beats(&buf);
        if checkpoint(&buf, 0).is_ok() {
            return Err("a stop seen before the first entry was listed past".to_owned());
        }
        assert_eq!(beats(&buf), before, "a beat before the first entry");
        Ok(())
    }

    #[test]
    fn without_a_stop_each_batch_boundary_beats_once_and_the_listing_goes_on() -> Result<(), String>
    {
        let buf = ListBuffer::new(0);
        checkpoint(&buf, 0).map_err(|why| format!("0: {why}"))?;
        assert_eq!(beats(&buf), 0, "a beat before the first entry");
        for batch in 1..=3 {
            let listed = batch * SYNTHETIC_BATCH;
            checkpoint(&buf, listed).map_err(|why| format!("{listed}: {why}"))?;
        }
        assert_eq!(beats(&buf), 3, "one beat per batch boundary");
        Ok(())
    }
}

//! The tree a [`SyntheticSpec`](super::SyntheticSpec) makes, worked out once:
//! its folder levels, where each folder's subfolders and files sit, and which
//! files are hard-linked pairs. Moved out of `synthetic.rs` unchanged (Phase 4,
//! T6b).

use std::ops::Range;

use super::{
    LONGEST_EXTENSION, MAX_EXACT_SIZE, MAX_NAME_LEN, MAX_SIGMA_MILLI, MAX_SYNTHETIC_DEPTH,
    MAX_SYNTHETIC_ENTRIES, PPM, SyntheticSpec, TAG_LINK_STEP, base36_len, draw,
};

/// One level of folders: the first folder's number and how many there are.
#[derive(Clone, Copy, Debug)]
struct Level {
    start: u64,
    count: u64,
}

/// The tree a spec makes, worked out once: everything a listing needs to
/// place a folder's entries without looking at any other folder.
#[derive(Debug)]
pub(super) struct Shape {
    pub(super) folders: u64,
    pub(super) files: u64,
    /// `levels[0]` is the root alone.
    levels: Vec<Level>,
    /// Every folder holds `files_base` files, and the first `files_extra` one more.
    files_base: u64,
    files_extra: u64,
    /// Pair `j`'s names are files `r` and `r + link_stride`, where `r × link_step ≡ j`.
    link_stride: u64,
    link_pairs: u64,
    link_step: u64,
}

/// `value × share / PPM`, rounded down; never above `value` while `share ≤ PPM`.
fn share_of(value: u64, share: u32, denominator: u64) -> u64 {
    let product = u128::from(value) * u128::from(share) / u128::from(denominator);
    u64::try_from(product).unwrap_or(u64::MAX)
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// The folder levels: see the module's description. Refused when the folders
/// do not fit the fan-out and the depth.
fn levels(folders: u64, fan_out: u32, depth: u32) -> Result<Vec<Level>, String> {
    let mut levels = vec![Level { start: 0, count: 1 }];
    if folders == 0 {
        return Ok(levels);
    }
    if fan_out == 0 {
        return Err(format!("{folders} folders need a fan-out of at least 1"));
    }
    if depth == 0 {
        return Err(format!("{folders} folders need a depth of at least 1"));
    }
    if depth > MAX_SYNTHETIC_DEPTH {
        return Err(format!(
            "the depth is at most {MAX_SYNTHETIC_DEPTH} folder levels; got {depth}"
        ));
    }
    let used = u64::from(depth).min(folders);
    let mut remaining = folders;
    let mut start = 1;
    let mut above = 1_u64;
    for level in 1..=used {
        let left = used - level + 1;
        let count = above
            .saturating_mul(u64::from(fan_out))
            .min(remaining.div_ceil(left));
        levels.push(Level { start, count });
        start += count;
        remaining -= count;
        above = count;
    }
    if remaining > 0 {
        return Err(format!(
            "{folders} folders do not fit a fan-out of {fan_out} and a depth of {depth}, which hold {}",
            folders - remaining
        ));
    }
    Ok(levels)
}

impl Shape {
    pub(super) fn new(spec: &SyntheticSpec) -> Result<Self, String> {
        if spec.entries > MAX_SYNTHETIC_ENTRIES {
            return Err(format!(
                "a synthetic tree holds at most 4,294,967,294 entries, the walk's id ceiling; {} were asked for",
                spec.entries
            ));
        }
        if spec.folder_ppm > PPM {
            return Err(format!(
                "the folder share is at most 1,000,000 per million; got {}",
                spec.folder_ppm
            ));
        }
        if spec.link_ppm > PPM {
            return Err(format!(
                "the hard-link share is at most 1,000,000 per million; got {}",
                spec.link_ppm
            ));
        }
        if spec.size_sigma_milli > MAX_SIGMA_MILLI {
            return Err(format!(
                "the size sigma is at most 10 (10,000 thousandths); got {} thousandths",
                spec.size_sigma_milli
            ));
        }
        if spec.size_median > MAX_EXACT_SIZE {
            return Err(format!(
                "the median size is at most 2^53 bytes, the largest a double holds exactly; got {}",
                spec.size_median
            ));
        }
        let folders = share_of(spec.entries, spec.folder_ppm, u64::from(PPM));
        let files = spec.entries - folders;
        let levels = levels(folders, spec.fan_out, spec.depth)?;
        let owners = folders + 1;
        let files_base = files / owners;
        let files_extra = files % owners;
        let link_stride = files / 2;
        let link_pairs = share_of(files, spec.link_ppm, 2 * u64::from(PPM));
        let shape = Self {
            folders,
            files,
            levels,
            files_base,
            files_extra,
            link_stride,
            link_pairs,
            link_step: coprime_step(spec.seed, link_stride),
        };
        shape.check_name_len(spec.name_len)?;
        Ok(shape)
    }

    /// Names must hold their numbers (and a file's longest extension) and
    /// fit a file system.
    fn check_name_len(&self, name_len: u32) -> Result<(), String> {
        let dir_min = if self.folders > 0 {
            1 + base36_len(self.folders)
        } else {
            1
        };
        let most_files = self.files_base + u64::from(self.files_extra > 0);
        let file_min = if most_files > 0 {
            1 + base36_len(most_files - 1) + 1 + LONGEST_EXTENSION
        } else {
            1
        };
        let least = dir_min.max(file_min);
        if u64::from(name_len) < least {
            return Err(format!(
                "the name length must be at least {least} bytes to number {} folders and {most_files} files in a folder; got {name_len}",
                self.folders
            ));
        }
        if name_len > MAX_NAME_LEN {
            return Err(format!(
                "the name length is at most {MAX_NAME_LEN} bytes, a file system's limit; got {name_len}"
            ));
        }
        Ok(())
    }

    /// Folder `g`'s level and its place in that level.
    fn level_of(&self, g: u64) -> Option<(usize, u64)> {
        self.levels.iter().enumerate().find_map(|(i, level)| {
            g.checked_sub(level.start)
                .filter(|&place| place < level.count)
                .map(|place| (i, place))
        })
    }

    /// The numbers of folder `g`'s subfolders.
    pub(super) fn child_folders(&self, g: u64) -> Range<u64> {
        let Some((i, place)) = self.level_of(g) else {
            return 0..0;
        };
        let (Some(this), Some(next)) = (self.levels.get(i), self.levels.get(i + 1)) else {
            return 0..0;
        };
        let bound = |p: u64| {
            let first = (u128::from(p) * u128::from(next.count)).div_ceil(u128::from(this.count));
            next.start + u64::try_from(first).unwrap_or(next.count)
        };
        bound(place)..bound(place + 1)
    }

    /// The folder that holds folder `g`; `None` for the root and for a number
    /// past the last folder.
    pub(super) fn parent_of(&self, g: u64) -> Option<u64> {
        let (i, place) = self.level_of(g)?;
        let above = self.levels.get(i.checked_sub(1)?)?;
        let this = self.levels.get(i)?;
        let index = u128::from(place) * u128::from(above.count) / u128::from(this.count);
        Some(above.start + u64::try_from(index).ok()?)
    }

    pub(super) fn files_in(&self, g: u64) -> u64 {
        self.files_base + u64::from(g < self.files_extra)
    }

    pub(super) fn first_file(&self, g: u64) -> u64 {
        g.saturating_mul(self.files_base) + g.min(self.files_extra)
    }

    /// The hard-link pair file `q` is a name of, if any.
    pub(super) fn pair_of(&self, q: u64) -> Option<u64> {
        if self.link_pairs == 0 || q >= self.link_stride.saturating_mul(2) {
            return None;
        }
        let r = q % self.link_stride;
        let j = u128::from(r) * u128::from(self.link_step) % u128::from(self.link_stride);
        let j = u64::try_from(j).ok()?;
        (j < self.link_pairs).then_some(j)
    }
}

/// A seeded multiplier coprime with `stride`, so `r ↦ r × step mod stride` is
/// a permutation and the linked files are spread over every folder.
fn coprime_step(seed: u64, stride: u64) -> u64 {
    if stride <= 1 {
        return 1;
    }
    let mut step = 1 + draw(seed, TAG_LINK_STEP, 0) % (stride - 1);
    while gcd(step, stride) != 1 {
        step = if step + 1 >= stride { 1 } else { step + 1 };
    }
    step
}

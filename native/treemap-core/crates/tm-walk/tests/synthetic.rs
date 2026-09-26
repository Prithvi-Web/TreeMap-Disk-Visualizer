//! The synthetic source (Phase 4, P4-8 and design §S.8): a scripted `Lister`
//! that reads nothing from disk, walked here through the real walk core with
//! the lister `tm_walk::start` would pick. Every test counts what the walk
//! produced; none reads a clock.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;

use tm_governor::{Budget, FakeSampler, FakeSignals, Governor, Preset};
use tm_walk::platform::synthetic::{SYNTHETIC_BATCH, synthetic_fences};
use tm_walk::platform::{ListBuffer, Listed, Lister};
use tm_walk::walk::Pacer;
use tm_walk::{
    FastPath, KIND_DIR, KIND_FILE, SyntheticLister, SyntheticSpec, WalkError, WalkOptions,
    WalkOutput, lister_for, start, start_with, synthetic_temp_folder,
};

type TestResult = Result<(), String>;

/// Folders per million entries in the developer shape (§S.8: 15% folders).
const DEVELOPER_FOLDER_PPM: u64 = 150_000;
/// Hard-linked files per million files in the developer shape (§S.8: κ = 1%).
const DEVELOPER_LINK_PPM: u64 = 10_000;
/// One million, the denominator of every share.
const PPM: u64 = 1_000_000;
/// The block size allocated sizes are rounded up to.
const BLOCK: f64 = 4096.0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// The app's synthetic temp folder, written out here independently of the crate's own.
fn fence() -> PathBuf {
    std::env::temp_dir().join("TreeMap-synthetic")
}

/// A root inside the fence that nothing ever creates: one per test and process.
fn root(tag: &str) -> PathBuf {
    fence().join(format!("tm-walk-{tag}-{}", std::process::id()))
}

/// A pacer that allows `limit` workers and never waits.
struct FixedPacer(u32);

impl Pacer for FixedPacer {
    fn on_worker_start(&self) {}
    fn throttle(&self, _cancelled: &dyn Fn() -> bool) {}
    fn worker_limit(&self) -> u32 {
        self.0
    }
}

/// A real governor on fake signals, as the live walk tests build one.
fn governor() -> Arc<Governor> {
    Arc::new(Governor::start(
        Budget {
            preset: Preset::Turbo,
            cpu_percent: None,
        },
        false,
        Box::new(FakeSampler::new(8)),
        Box::new(FakeSignals::default()),
    ))
}

/// Walks `spec` at `root` with exactly `workers` workers, through the lister
/// [`lister_for`] picks for the options (the one `start` uses).
fn walk(spec: &SyntheticSpec, root: &Path, workers: u32) -> Result<WalkOutput, String> {
    let mut opts = WalkOptions::new(root);
    opts.max_workers = usize::try_from(workers).map_err(|e| e.to_string())?;
    opts.synthetic = Some(spec.clone());
    let lister = lister_for(&opts).map_err(|e| e.to_string())?;
    let handle =
        start_with(opts, Arc::new(FixedPacer(workers)), lister).map_err(|e| e.to_string())?;
    handle.take().map_err(|e| e.to_string())
}

fn at<T: Copy>(column: &[T], i: usize, what: &str) -> Result<T, String> {
    column
        .get(i)
        .copied()
        .ok_or_else(|| format!("{what}[{i}] is missing"))
}

/// Each node's path relative to the root (`""` for the root), built from the
/// parent column; checks `parent[i] < i` on the way.
fn rel_paths(out: &WalkOutput) -> Result<Vec<String>, String> {
    let mut paths: Vec<String> = Vec::with_capacity(out.len());
    for i in 0..out.len() {
        if i == 0 {
            paths.push(String::new());
            continue;
        }
        let name = out.name(i).ok_or_else(|| format!("node {i} has no name"))?;
        let name = String::from_utf8_lossy(name);
        let parent = at(&out.parent, i, "parent")? as usize;
        if parent >= i {
            return Err(format!("parent[{i}] = {parent} is not smaller than {i}"));
        }
        let parent_path = paths
            .get(parent)
            .ok_or_else(|| format!("parent {parent} unknown"))?;
        paths.push(if parent_path.is_empty() {
            name.into_owned()
        } else {
            format!("{parent_path}/{name}")
        });
    }
    Ok(paths)
}

/// Each node's depth below the root (the root is 0).
fn depths(out: &WalkOutput) -> Result<Vec<u32>, String> {
    let mut depth: Vec<u32> = Vec::with_capacity(out.len());
    for i in 0..out.len() {
        if i == 0 {
            depth.push(0);
            continue;
        }
        let parent = at(&out.parent, i, "parent")? as usize;
        depth.push(at(&depth, parent, "depth")? + 1);
    }
    Ok(depth)
}

/// How many folders directly under each node.
fn subfolders(out: &WalkOutput) -> Result<Vec<u32>, String> {
    let mut count = vec![0_u32; out.len()];
    for i in 1..out.len() {
        if at(&out.kind, i, "kind")? == KIND_DIR {
            let parent = at(&out.parent, i, "parent")? as usize;
            *count
                .get_mut(parent)
                .ok_or_else(|| format!("parent {parent} unknown"))? += 1;
        }
    }
    Ok(count)
}

/// Folders and files under the root.
fn kinds(out: &WalkOutput) -> Result<(u64, u64), String> {
    let (mut dirs, mut files) = (0_u64, 0_u64);
    for i in 1..out.len() {
        match at(&out.kind, i, "kind")? {
            KIND_DIR => dirs += 1,
            KIND_FILE => files += 1,
            other => return Err(format!("node {i} has kind {other}")),
        }
    }
    Ok((dirs, files))
}

/// What one node is, with the id the walk gave it taken out.
#[derive(Debug, PartialEq, Eq)]
struct Facts {
    kind: u8,
    flags: u8,
    size: u64,
    alloc: u64,
    mtime: u64,
    atime: u64,
    /// The smallest path in the node's hard-link family, when it has one.
    family: Option<String>,
}

/// Every node by its path: a walk's output independent of its numbering.
fn by_path(out: &WalkOutput) -> Result<BTreeMap<String, Facts>, String> {
    let paths = rel_paths(out)?;
    let mut first_member: HashMap<u32, String> = HashMap::new();
    let mut family_of: HashMap<u32, u32> = HashMap::new();
    for link in &out.hardlinks {
        let path = paths
            .get(link.node as usize)
            .ok_or_else(|| format!("hard link to unknown node {}", link.node))?;
        family_of.insert(link.node, link.family);
        let first = first_member
            .entry(link.family)
            .or_insert_with(|| path.clone());
        if path < first {
            first.clone_from(path);
        }
    }
    let mut facts = BTreeMap::new();
    for (i, path) in paths.iter().enumerate() {
        let node = u32::try_from(i).map_err(|e| e.to_string())?;
        let family = family_of
            .get(&node)
            .and_then(|f| first_member.get(f))
            .cloned();
        facts.insert(
            path.clone(),
            Facts {
                kind: at(&out.kind, i, "kind")?,
                flags: at(&out.flags, i, "flags")?,
                size: at(&out.size, i, "size")?.to_bits(),
                alloc: at(&out.alloc_bytes, i, "alloc")?.to_bits(),
                mtime: at(&out.mtime_ms, i, "mtime")?.to_bits(),
                atime: at(&out.atime_ms, i, "atime")?.to_bits(),
                family,
            },
        );
    }
    Ok(facts)
}

/// The first path at which two trees differ, in words; `None` when they are equal.
fn first_difference(a: &BTreeMap<String, Facts>, b: &BTreeMap<String, Facts>) -> Option<String> {
    if let Some(path) = a.keys().find(|p| !b.contains_key(*p)) {
        return Some(format!(
            "{path:?} is only in the first ({} vs {})",
            a.len(),
            b.len()
        ));
    }
    if let Some(path) = b.keys().find(|p| !a.contains_key(*p)) {
        return Some(format!(
            "{path:?} is only in the second ({} vs {})",
            a.len(),
            b.len()
        ));
    }
    a.iter().find_map(|(path, fa)| {
        b.get(path)
            .filter(|fb| *fb != fa)
            .map(|fb| format!("{path:?}: {fa:?} vs {fb:?}"))
    })
}

/// One folder's listing, every value as bits.
type Snapshot = Vec<(Vec<u8>, u8, u64, u64, u64, u64, u128, u32)>;

fn snapshot(lister: &SyntheticLister, dir: &Path, want_atime: bool) -> Result<Snapshot, String> {
    let mut buf = ListBuffer::new(0);
    lister
        .list(dir, want_atime, &mut buf)
        .map_err(|why| format!("{}: {why}", dir.display()))?;
    Ok(entries_of(&buf))
}

/// The listing in `buf`, every value as bits.
fn entries_of(buf: &ListBuffer) -> Snapshot {
    buf.listing
        .entries
        .iter()
        .map(|entry| {
            let m = entry.meta;
            (
                buf.listing.name(entry).to_vec(),
                m.kind,
                m.size.to_bits(),
                m.alloc.to_bits(),
                m.mtime_ms.to_bits(),
                m.atime_ms.to_bits(),
                m.ino,
                m.nlink,
            )
        })
        .collect()
}

fn refused(result: Result<SyntheticLister, WalkError>, what: &str, needle: &str) -> TestResult {
    match result {
        Err(WalkError::OptionsRefused(text)) if text.contains(needle) => Ok(()),
        Err(other) => Err(format!(
            "{what}: refused as {other:?}, not with a reason naming {needle:?}"
        )),
        Ok(_) => Err(format!("{what}: accepted")),
    }
}

/// The folders the spec's share makes of `entries`, written out here.
fn folders_of(entries: u64, folder_ppm: u64) -> u64 {
    entries * folder_ppm / PPM
}

/// The hard-linked file names the spec's rate makes of `files`: whole pairs.
fn linked_of(files: u64, link_ppm: u64) -> u64 {
    2 * (files * link_ppm / (2 * PPM))
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

#[test]
fn the_same_seed_lists_the_same_tree_at_any_worker_count() -> TestResult {
    let spec = SyntheticSpec::developer(30_000, 7);
    let at = root("workers");
    let one = by_path(&walk(&spec, &at, 1)?)?;
    assert_eq!(one.len(), 30_001);
    assert!(
        one.values().any(|f| f.family.is_some()),
        "the tree has hard links to compare"
    );
    for workers in [2, 8, 64] {
        let other = by_path(&walk(&spec, &at, workers)?)?;
        if let Some(difference) = first_difference(&one, &other) {
            return Err(format!(
                "1 and {workers} workers listed other trees: {difference}"
            ));
        }
    }
    Ok(())
}

#[test]
fn a_folder_lists_the_same_from_any_lister_in_any_order() -> TestResult {
    let spec = SyntheticSpec::developer(20_000, 11);
    let at = root("listing");
    let out = walk(&spec, &at, 4)?;
    let paths = rel_paths(&out)?;
    let folders: Vec<PathBuf> = paths
        .iter()
        .enumerate()
        .filter(|(i, _)| out.kind.get(*i) == Some(&KIND_DIR))
        .step_by(97)
        .map(|(_, p)| if p.is_empty() { at.clone() } else { at.join(p) })
        .collect();
    assert!(folders.len() > 20, "{} folders sampled", folders.len());

    let first = SyntheticLister::new(&spec, &at).map_err(|e| e.to_string())?;
    let second = SyntheticLister::new(&spec, &at).map_err(|e| e.to_string())?;
    let forward = folders
        .iter()
        .map(|dir| snapshot(&first, dir, false))
        .collect::<Result<Vec<_>, _>>()?;
    let mut backward = folders
        .iter()
        .rev()
        .map(|dir| snapshot(&second, dir, false))
        .collect::<Result<Vec<_>, _>>()?;
    backward.reverse();
    assert!(forward == backward, "a folder listed differently");

    // Access times only when asked for, and never before the modification time.
    for dir in &folders {
        let without = snapshot(&first, dir, false)?;
        let with = snapshot(&first, dir, true)?;
        for ((_, _, _, _, mtime, plain, ..), (_, _, _, _, _, asked, ..)) in
            without.iter().zip(&with)
        {
            assert!(f64::from_bits(*plain).is_nan(), "{}", dir.display());
            let (asked, mtime) = (f64::from_bits(*asked), f64::from_bits(*mtime));
            assert!(
                asked.is_finite() && asked >= mtime,
                "{asked} against {mtime}"
            );
        }
    }
    Ok(())
}

#[test]
fn another_seed_lists_other_names_sizes_and_links_in_the_same_shape() -> TestResult {
    let at = root("seeds");
    let a = walk(&SyntheticSpec::developer(10_000, 1), &at, 2)?;
    let b = walk(&SyntheticSpec::developer(10_000, 2), &at, 2)?;
    assert_eq!(
        kinds(&a)?,
        kinds(&b)?,
        "the shape does not depend on the seed"
    );
    assert_eq!(a.hardlinks.len(), b.hardlinks.len());

    let paths_a: BTreeSet<String> = rel_paths(&a)?.into_iter().collect();
    let paths_b: BTreeSet<String> = rel_paths(&b)?.into_iter().collect();
    let shared = paths_a.intersection(&paths_b).count();
    assert_eq!(shared, 1, "only the root is named alike under two seeds");

    let sorted = |out: &WalkOutput| {
        let mut sizes: Vec<u64> = out.size.iter().map(|s| s.to_bits()).collect();
        sizes.sort_unstable();
        sizes
    };
    assert_ne!(sorted(&a), sorted(&b), "the sizes are drawn from the seed");
    Ok(())
}

// ---------------------------------------------------------------------------
// The count
// ---------------------------------------------------------------------------

#[test]
fn the_walk_holds_exactly_the_entries_asked_for() -> TestResult {
    for entries in [0_u64, 1, 2, 3, 7, 100, 1_001, 99_991] {
        let out = walk(&SyntheticSpec::developer(entries, 3), &root("count"), 4)?;
        assert_eq!(
            u64::try_from(out.len()).ok(),
            Some(entries + 1),
            "{entries}: nodes"
        );
        assert_eq!(out.stats.entries, entries, "{entries}: counted entries");
        let (dirs, files) = kinds(&out)?;
        let expected_dirs = folders_of(entries, DEVELOPER_FOLDER_PPM);
        assert_eq!(dirs, expected_dirs, "{entries}: folders");
        assert_eq!(files, entries - expected_dirs, "{entries}: files");
        assert_eq!(
            out.stats.dirs_listed,
            dirs + 1,
            "{entries}: every folder listed"
        );
    }
    Ok(())
}

#[test]
fn a_million_entries_walk_as_a_million() -> TestResult {
    let entries = 1_000_000_u64;
    let out = walk(&SyntheticSpec::developer(entries, 13), &root("million"), 8)?;
    assert_eq!(u64::try_from(out.len()).ok(), Some(entries + 1));
    assert_eq!(out.stats.entries, entries);
    let (dirs, files) = kinds(&out)?;
    assert_eq!(dirs, 150_000);
    assert_eq!(files, 850_000);
    assert_eq!(
        u64::try_from(out.hardlinks.len()).ok(),
        Some(linked_of(files, DEVELOPER_LINK_PPM))
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Each knob, seen in the output
// ---------------------------------------------------------------------------

#[test]
fn the_folder_share_is_the_share_of_entries_that_are_folders() -> TestResult {
    let entries = 9_999_u64;
    for ppm in [0_u32, 10_000, 150_000, 330_000, 999_999, 1_000_000] {
        let spec = SyntheticSpec {
            folder_ppm: ppm,
            ..SyntheticSpec::developer(entries, 5)
        };
        let out = walk(&spec, &root("share"), 4)?;
        let (dirs, files) = kinds(&out)?;
        let expected = folders_of(entries, u64::from(ppm));
        assert_eq!(dirs, expected, "{ppm} ppm: folders");
        assert_eq!(files, entries - expected, "{ppm} ppm: files");
    }
    Ok(())
}

#[test]
fn every_name_is_the_name_length() -> TestResult {
    for len in [18_u32, 40, 255] {
        let spec = SyntheticSpec {
            name_len: len,
            ..SyntheticSpec::developer(5_000, 6)
        };
        let out = walk(&spec, &root("names"), 4)?;
        for i in 1..out.len() {
            let name = out.name(i).ok_or_else(|| format!("node {i} has no name"))?;
            assert_eq!(
                u32::try_from(name.len()).ok(),
                Some(len),
                "{:?}",
                String::from_utf8_lossy(name)
            );
        }
    }
    Ok(())
}

#[test]
fn the_fan_out_and_the_depth_shape_the_folder_tree() -> TestResult {
    // 560 entries at 15% folders are 84 folders: exactly a complete 4-ary
    // tree three levels deep (4 + 16 + 64).
    let spec = SyntheticSpec {
        fan_out: 4,
        depth: 3,
        ..SyntheticSpec::developer(560, 9)
    };
    let out = walk(&spec, &root("fanout"), 2)?;
    let depth = depths(&out)?;
    let under = subfolders(&out)?;
    let mut deepest_folder = 0;
    for i in 0..out.len() {
        let d = at(&depth, i, "depth")?;
        if at(&out.kind, i, "kind")? == KIND_DIR {
            deepest_folder = deepest_folder.max(d);
            let expected = if d < 3 { 4 } else { 0 };
            assert_eq!(
                at(&under, i, "subfolders")?,
                expected,
                "node {i} at depth {d}"
            );
        }
    }
    assert_eq!(deepest_folder, 3);
    assert_eq!(
        depth.iter().max().copied(),
        Some(4),
        "files sit in the deepest folders"
    );

    // The developer shape reaches its depth, and no folder holds more than
    // the fan-out, though the first levels are full.
    let out = walk(&SyntheticSpec::developer(20_000, 9), &root("fanout-dev"), 4)?;
    let depth = depths(&out)?;
    let deepest_folder = (0..out.len())
        .filter(|&i| out.kind.get(i) == Some(&KIND_DIR))
        .filter_map(|i| depth.get(i).copied())
        .max();
    assert_eq!(deepest_folder, Some(12));
    assert_eq!(subfolders(&out)?.iter().max().copied(), Some(16));
    Ok(())
}

#[test]
fn a_tree_the_fan_out_and_depth_cannot_hold_is_refused() -> TestResult {
    let small = |fan_out, depth| SyntheticSpec {
        fan_out,
        depth,
        ..SyntheticSpec::developer(560, 9)
    };
    // 84 folders; a fan-out of 4 two levels deep holds 4 + 16 = 20.
    refused(
        SyntheticLister::new(&small(4, 2), &root("toodeep")),
        "84 folders in 20 places",
        "84",
    )?;
    refused(
        SyntheticLister::new(&small(0, 3), &root("nofan")),
        "a fan-out of 0",
        "fan-out",
    )?;
    refused(
        SyntheticLister::new(&small(4, 0), &root("nodepth")),
        "a depth of 0",
        "depth",
    )?;
    // With no folders the fan-out and the depth do not matter.
    let flat = SyntheticSpec {
        folder_ppm: 0,
        ..small(0, 0)
    };
    SyntheticLister::new(&flat, &root("flat")).map_err(|e| e.to_string())?;
    Ok(())
}

#[test]
fn sizes_are_log_normal_around_the_median() -> TestResult {
    let files_of = |out: &WalkOutput| -> Vec<(f64, f64)> {
        (1..out.len())
            .filter(|&i| out.kind.get(i) == Some(&KIND_FILE))
            .filter_map(|i| Some((*out.size.get(i)?, *out.alloc_bytes.get(i)?)))
            .collect()
    };

    // No spread: every file is the median.
    let flat = SyntheticSpec {
        size_median: 5_000,
        size_sigma_milli: 0,
        ..SyntheticSpec::developer(4_000, 8)
    };
    let out = walk(&flat, &root("sizes-flat"), 2)?;
    for (size, alloc) in files_of(&out) {
        assert_eq!(size.to_bits(), 5_000_f64.to_bits());
        assert_eq!(
            alloc.to_bits(),
            8_192_f64.to_bits(),
            "rounded up to 4,096-byte blocks"
        );
    }

    // A spread of 1.5: the median holds, and about 16% lie beyond one sigma each side.
    let spread = SyntheticSpec {
        size_median: 4_096,
        size_sigma_milli: 1_500,
        link_ppm: 0,
        ..SyntheticSpec::developer(40_000, 8)
    };
    let out = walk(&spread, &root("sizes"), 4)?;
    let files = files_of(&out);
    let mut sizes: Vec<f64> = files.iter().map(|(s, _)| *s).collect();
    sizes.sort_by(f64::total_cmp);
    let median = at(&sizes, sizes.len() / 2, "sizes")?;
    assert!((median / 4_096.0 - 1.0).abs() <= 0.05, "median {median}");
    let n = sizes.len() as f64;
    let above = sizes
        .iter()
        .filter(|&&s| s > 4_096.0 * 1.5_f64.exp())
        .count() as f64
        / n;
    let below = sizes
        .iter()
        .filter(|&&s| s < 4_096.0 * (-1.5_f64).exp())
        .count() as f64
        / n;
    assert!((0.13..=0.19).contains(&above), "{above} above one sigma");
    assert!((0.13..=0.19).contains(&below), "{below} below one sigma");
    for (size, alloc) in files {
        let blocks = (size / BLOCK).ceil() * BLOCK;
        assert_eq!(
            alloc.to_bits(),
            blocks.to_bits(),
            "{size} allocates {alloc}"
        );
    }
    Ok(())
}

#[test]
fn the_hard_link_rate_pairs_files_across_folders() -> TestResult {
    for ppm in [0_u32, 10_000, 100_000, 1_000_000] {
        let spec = SyntheticSpec {
            link_ppm: ppm,
            ..SyntheticSpec::developer(20_000, 4)
        };
        let out = walk(&spec, &root("links"), 4)?;
        let (_, files) = kinds(&out)?;
        assert_eq!(
            u64::try_from(out.hardlinks.len()).ok(),
            Some(linked_of(files, u64::from(ppm))),
            "{ppm} ppm"
        );
        let mut families: BTreeMap<u32, Vec<usize>> = BTreeMap::new();
        for link in &out.hardlinks {
            families
                .entry(link.family)
                .or_default()
                .push(link.node as usize);
        }
        for (family, members) in &families {
            let [a, b] = members.as_slice() else {
                return Err(format!("family {family} has {} members", members.len()));
            };
            let (a, b) = (*a, *b);
            assert_ne!(
                at(&out.parent, a, "parent")?,
                at(&out.parent, b, "parent")?,
                "family {family}: one folder"
            );
            assert_eq!(
                at(&out.size, a, "size")?.to_bits(),
                at(&out.size, b, "size")?.to_bits()
            );
            assert_eq!(
                at(&out.mtime_ms, a, "mtime")?.to_bits(),
                at(&out.mtime_ms, b, "mtime")?.to_bits()
            );
        }
    }
    Ok(())
}

#[test]
fn the_names_of_a_pair_share_a_folder_only_when_one_folder_holds_more_than_half_the_files()
-> TestResult {
    // (entries, folder_ppm, pairs whose two names share a folder): no
    // subfolders; one subfolder with 999 files and with 1,000; two subfolders.
    let cases: [(u64, u32, u64); 4] = [
        (1_000, 0, 500),
        (1_000, 1_000, 1),
        (1_001, 1_000, 0),
        (2_001, 1_000, 0),
    ];
    for (entries, folder_ppm, expected_shared) in cases {
        let spec = SyntheticSpec {
            folder_ppm,
            link_ppm: 1_000_000,
            ..SyntheticSpec::developer(entries, 4)
        };
        let out = walk(&spec, &root("pair-folders"), 2)?;
        let (dirs, files) = kinds(&out)?;
        let mut files_in: HashMap<u32, u64> = HashMap::new();
        for i in 1..out.len() {
            if at(&out.kind, i, "kind")? == KIND_FILE {
                *files_in.entry(at(&out.parent, i, "parent")?).or_default() += 1;
            }
        }
        let fullest = files_in.values().copied().max().unwrap_or(0);
        let mut families: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        for link in &out.hardlinks {
            families.entry(link.family).or_default().push(at(
                &out.parent,
                link.node as usize,
                "parent",
            )?);
        }
        let pairs = u64::try_from(families.len()).map_err(|e| e.to_string())?;
        assert_eq!(
            pairs,
            files / 2,
            "{entries}/{folder_ppm}: every file is linked"
        );
        let shared = families
            .values()
            .filter(|parents| matches!(parents.as_slice(), [a, b] if a == b))
            .count();
        let shared = u64::try_from(shared).map_err(|e| e.to_string())?;
        let what = format!("{dirs} folders, {files} files, {fullest} in the fullest folder");
        assert_eq!(shared, expected_shared, "{what}");
        if fullest <= files / 2 {
            assert_eq!(
                shared, 0,
                "{what}: no folder holds more than half the files"
            );
        }
        if dirs == 0 {
            assert_eq!(shared, pairs, "{what}: every pair is in the root");
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The root, and specs that cannot be built
// ---------------------------------------------------------------------------

#[test]
fn a_root_outside_the_apps_synthetic_temp_folder_is_refused() -> TestResult {
    let spec = SyntheticSpec::developer(100, 1);
    let temp = std::env::temp_dir();
    let mut outside = vec![
        PathBuf::from("/"),
        temp.clone(),
        fence(),
        temp.join("elsewhere").join("tree"),
        temp.join("TreeMap-synthetic-other").join("tree"),
        fence().join("..").join("escape"),
        fence().join("tree").join("..").join("..").join("escape"),
        PathBuf::from("TreeMap-synthetic").join("relative"),
    ];
    if let Some(parent) = temp.parent() {
        outside.push(parent.join("TreeMap-synthetic").join("tree"));
    }
    for root in outside {
        let mut opts = WalkOptions::new(&root);
        opts.synthetic = Some(spec.clone());
        match lister_for(&opts) {
            Err(WalkError::OptionsRefused(text)) if text.contains("TreeMap-synthetic") => {}
            Err(other) => return Err(format!("{}: refused as {other:?}", root.display())),
            Ok(_) => return Err(format!("{} was accepted", root.display())),
        }
        match start(opts, governor()) {
            Err(WalkError::OptionsRefused(_)) => {}
            other => return Err(format!("{}: start answered {other:?}", root.display())),
        }
    }
    Ok(())
}

#[test]
fn a_root_inside_it_is_walked_and_nothing_is_created_on_disk() -> TestResult {
    let spec = SyntheticSpec::developer(2_000, 1);
    let at = root("nothing-on-disk");
    let fence_was_there = fence().exists();
    assert!(!at.exists(), "{} exists before the walk", at.display());

    let mut opts = WalkOptions::new(&at);
    opts.synthetic = Some(spec.clone());
    let out = start(opts, governor())
        .and_then(tm_walk::WalkHandle::take)
        .map_err(|e| e.to_string())?;
    assert_eq!(out.len(), 2_001);
    assert!(!at.exists(), "{} exists after the walk", at.display());
    assert_eq!(
        fence().exists(),
        fence_was_there,
        "the fence was made or removed"
    );

    // The temp folder's resolved spelling is the same folder.
    let real = std::fs::canonicalize(std::env::temp_dir()).map_err(|e| e.to_string())?;
    let resolved = real.join("TreeMap-synthetic").join("resolved");
    SyntheticLister::new(&spec, &resolved).map_err(|e| format!("{}: {e}", resolved.display()))?;
    Ok(())
}

#[test]
fn the_temp_folder_handed_to_node_is_the_one_the_lister_accepts_roots_inside() -> TestResult {
    let spec = SyntheticSpec::developer(100, 1);
    let folder = synthetic_temp_folder();
    assert_eq!(
        folder,
        fence(),
        "the folder is not temp_dir()/TreeMap-synthetic"
    );
    assert_eq!(
        synthetic_fences().first(),
        Some(&folder),
        "the folder is not the first fence"
    );
    SyntheticLister::new(&spec, &folder.join("tree"))
        .map_err(|e| format!("{}: {e}", folder.display()))?;
    refused(
        SyntheticLister::new(&spec, &folder),
        "the folder itself",
        "TreeMap-synthetic",
    )
}

#[test]
fn a_spec_that_cannot_be_built_is_refused() -> TestResult {
    let base = || SyntheticSpec::developer(20_000, 1);
    let at = root("specs");
    let cases: [(SyntheticSpec, &str, &str); 7] = [
        (
            SyntheticSpec {
                entries: 4_294_967_295,
                ..base()
            },
            "one entry past the id ceiling",
            "4,294,967,294",
        ),
        (
            SyntheticSpec {
                folder_ppm: 1_000_001,
                ..base()
            },
            "a folder share above one",
            "folder",
        ),
        (
            SyntheticSpec {
                link_ppm: 1_000_001,
                ..base()
            },
            "a hard-link share above one",
            "hard-link",
        ),
        (
            SyntheticSpec {
                name_len: 5,
                ..base()
            },
            "names too short to tell apart",
            "name length",
        ),
        (
            SyntheticSpec {
                name_len: 256,
                ..base()
            },
            "names longer than a file system allows",
            "name length",
        ),
        (
            SyntheticSpec {
                size_sigma_milli: 10_001,
                ..base()
            },
            "a spread past ten",
            "sigma",
        ),
        (
            SyntheticSpec {
                size_median: (1 << 53) + 1,
                ..base()
            },
            "a median a double cannot hold",
            "median",
        ),
    ];
    for (spec, what, needle) in cases {
        refused(SyntheticLister::new(&spec, &at), what, needle)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// A big listing and a cancel
// ---------------------------------------------------------------------------

/// The stop is set here before the listing starts; a stop that arrives
/// between two batches is the unit tests' in `platform/synthetic.rs`.
#[test]
fn a_big_listing_beats_the_heartbeat_and_a_stopped_one_lists_nothing() -> TestResult {
    let entries = 10_000_usize;
    let spec = SyntheticSpec {
        folder_ppm: 0,
        ..SyntheticSpec::developer(u64::try_from(entries).map_err(|e| e.to_string())?, 1)
    };
    let at = root("stop");
    let lister = SyntheticLister::new(&spec, &at).map_err(|e| e.to_string())?;
    let mut buf = ListBuffer::new(0);
    lister
        .list(&at, false, &mut buf)
        .map_err(|why| why.to_string())?;
    assert_eq!(buf.listing.len(), entries);
    let beats = u64::try_from(entries / SYNTHETIC_BATCH + 1).map_err(|e| e.to_string())?;
    assert_eq!(
        buf.heartbeat.load(Ordering::Acquire),
        beats,
        "one beat per batch and one at the end"
    );

    buf.stop.store(true, Ordering::Release);
    let stopped = lister.list(&at, false, &mut buf);
    assert!(stopped.is_err(), "a stopped listing answered {stopped:?}");
    assert_eq!(buf.listing.len(), 0, "nothing listed after the stop");
    Ok(())
}

// ---------------------------------------------------------------------------
// A listing read in parts (T6b; R89)
// ---------------------------------------------------------------------------

/// The limits a listing in parts is read to: 2, inside the root's four
/// subfolders; `SYNTHETIC_BATCH`, on a batch boundary; then 999 more each
/// time, between boundaries.
fn part_limits() -> impl Iterator<Item = usize> {
    [2, SYNTHETIC_BATCH]
        .into_iter()
        .chain((1..).map(|k| SYNTHETIC_BATCH + k * 999))
}

#[test]
fn a_synthetic_listing_read_in_parts_is_the_listing_read_whole() -> TestResult {
    // Four subfolders, and 8,000 of the 40,000 files in each of the five folders.
    let spec = SyntheticSpec {
        entries: 40_004,
        fan_out: 4,
        depth: 1,
        folder_ppm: 100,
        ..SyntheticSpec::developer(0, 5)
    };
    let at = root("parts");
    let lister = SyntheticLister::new(&spec, &at).map_err(|e| e.to_string())?;
    let mut whole = ListBuffer::new(0);
    lister
        .list(&at, true, &mut whole)
        .map_err(|why| format!("whole: {why}"))?;
    assert_eq!(whole.listing.len(), 8_004, "the root's listing");

    let mut parts = ListBuffer::new(0);
    let mut limits = part_limits();
    let mut limit = limits.next().ok_or("no limit")?;
    let mut answer = lister
        .list_until(&at, true, &mut parts, limit)
        .map_err(|why| format!("first part: {why}"))?;
    let mut stops = 0;
    while answer == Listed::More {
        assert_eq!(parts.listing.len(), limit, "a part stops at its limit");
        assert!(parts.has_cursor(), "a stopped listing keeps its cursor");
        stops += 1;
        limit = limits.next().ok_or("out of limits")?;
        answer = lister
            .list_more(&mut parts, limit)
            .map_err(|why| format!("part {stops}: {why}"))?;
    }
    assert_eq!(answer, Listed::Complete(FastPath::Unavailable));
    // At 2, 4,096, 5,095, 6,094 and 7,093 entries; then complete at 8,004.
    assert_eq!(stops, 5, "the listing was read in parts");
    assert!(!parts.has_cursor(), "a complete listing leaves no cursor");
    assert!(
        entries_of(&parts) == entries_of(&whole),
        "listed in parts, the entries, their facts or their order differ"
    );
    assert_eq!(
        parts.heartbeat.load(Ordering::Acquire),
        whole.heartbeat.load(Ordering::Acquire),
        "one beat per batch, read whole or in parts"
    );
    Ok(())
}

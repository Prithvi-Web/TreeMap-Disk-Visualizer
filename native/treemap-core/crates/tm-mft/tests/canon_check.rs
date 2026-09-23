//! M5's instrument on hand-made outputs, on every platform: one tree
//! numbered two ways is equal once laid out canonically; every column, side
//! table and counter that differs is named with its path; each directory's
//! emitted order is kept apart, so the NTFS order the two engines share can
//! be asserted on its own. The live comparison is only as good as this.

mod canon;

use std::collections::HashMap;

use canon::{Counts, canonical, child_order, differences};
use tm_walk::{
    DirRefusal, FastPath, HardlinkRef, KIND_DIR, KIND_FILE, KIND_SYMLINK, Refusal, WalkOutput,
    WalkStats,
};

type TestResult = Result<(), String>;

/// One node of a hand-made output: its path under the root (`""` for the
/// root) and its columns.
#[derive(Clone, Copy, Debug)]
struct Node {
    path: &'static str,
    kind: u8,
    flags: u8,
    size: f64,
    alloc: f64,
    mtime: f64,
    atime: f64,
}

fn dir(path: &'static str) -> Node {
    Node {
        path,
        kind: KIND_DIR,
        flags: 0,
        size: 0.0,
        alloc: 0.0,
        mtime: 1_700_000_000_000.5,
        atime: f64::NAN,
    }
}

fn file(path: &'static str, size: f64) -> Node {
    Node {
        path,
        kind: KIND_FILE,
        flags: 0,
        size,
        alloc: size + 1.0,
        mtime: 1_700_000_000_001.25,
        atime: f64::NAN,
    }
}

const COUNTS: Counts = Counts {
    dirs_listed: 3,
    entries: 6,
    denied: 0,
    unreadable: 0,
    dataless: 0,
};

/// An output holding `nodes` with ids in the order given (each parent
/// before its children), the root named `root`, a hard-link ref on each of
/// `links`, a refusal per `refused`.
fn output(
    nodes: &[Node],
    links: &[&str],
    refused: &[(&str, Refusal)],
    counts: Counts,
) -> Result<WalkOutput, String> {
    let mut ids: HashMap<&str, u32> = HashMap::new();
    let mut out = WalkOutput {
        parent: Vec::new(),
        name_off: vec![0],
        names: Vec::new(),
        kind: Vec::new(),
        flags: Vec::new(),
        size: Vec::new(),
        alloc_bytes: Vec::new(),
        mtime_ms: Vec::new(),
        atime_ms: Vec::new(),
        hardlinks: Vec::new(),
        refusals: Vec::new(),
        stats: WalkStats {
            dirs_listed: counts.dirs_listed,
            entries: counts.entries,
            wall_ms: 1.0,
            cpu_seconds: 1.0,
            fast_path: FastPath::Unavailable,
            workers_peak: 1,
            climb_steps: 0,
            denied_entries: counts.denied,
            unreadable_entries: counts.unreadable,
            dataless: counts.dataless,
        },
    };
    let id_of = |ids: &HashMap<&str, u32>, path: &str| {
        ids.get(path)
            .copied()
            .ok_or_else(|| format!("no node {path:?} before its use"))
    };
    for (i, n) in nodes.iter().enumerate() {
        let (parent, name) = if n.path.is_empty() {
            (0, "root")
        } else {
            match n.path.rsplit_once('/') {
                Some((up, name)) => (id_of(&ids, up)?, name),
                None => (id_of(&ids, "")?, n.path),
            }
        };
        out.names.extend_from_slice(name.as_bytes());
        out.name_off
            .push(u32::try_from(out.names.len()).map_err(|e| e.to_string())?);
        out.parent.push(parent);
        out.kind.push(n.kind);
        out.flags.push(n.flags);
        out.size.push(n.size);
        out.alloc_bytes.push(n.alloc);
        out.mtime_ms.push(n.mtime);
        out.atime_ms.push(n.atime);
        ids.insert(n.path, u32::try_from(i).map_err(|e| e.to_string())?);
    }
    for path in links {
        out.hardlinks.push(HardlinkRef {
            node: id_of(&ids, path)?,
            family: 0,
        });
    }
    for (path, why) in refused {
        out.refusals.push(DirRefusal {
            node: id_of(&ids, path)?,
            why: *why,
        });
    }
    Ok(out)
}

/// The tree breadth first, siblings by name.
fn by_name() -> Vec<Node> {
    vec![
        dir(""),
        dir("a"),
        file("b.txt", 10.0),
        file("z.txt", 26.0),
        file("a/c.txt", 3.0),
        dir("a/d"),
        file("a/d/e.bin", 5.0),
    ]
}

/// The same tree numbered another valid way: siblings reversed, depth first.
fn by_other() -> Vec<Node> {
    vec![
        dir(""),
        file("z.txt", 26.0),
        dir("a"),
        dir("a/d"),
        file("a/d/e.bin", 5.0),
        file("a/c.txt", 3.0),
        file("b.txt", 10.0),
    ]
}

fn compare(a: &WalkOutput, b: &WalkOutput) -> Result<Vec<String>, String> {
    Ok(differences(&canonical(a)?, &canonical(b)?, 50))
}

#[test]
fn one_tree_numbered_two_ways_is_equal_once_canonical() -> TestResult {
    let a = output(&by_name(), &["b.txt", "a/c.txt"], &[], COUNTS)?;
    let b = output(&by_other(), &["a/c.txt", "b.txt"], &[], COUNTS)?;
    assert_ne!(a.parent, b.parent, "the two numberings really differ");
    let (ca, cb) = (canonical(&a)?, canonical(&b)?);
    assert_eq!(ca, cb);
    assert_eq!(
        ca.paths,
        vec!["", "a", "b.txt", "z.txt", "a/c.txt", "a/d", "a/d/e.bin"],
        "breadth first, each directory's children by name bytes"
    );
    assert_eq!(ca.parent, vec![0, 0, 0, 0, 1, 1, 5]);
    assert!(compare(&a, &b)?.is_empty());
    Ok(())
}

#[test]
fn every_column_that_differs_is_named_with_its_path() -> TestResult {
    type Change = fn(&mut Node);
    let base = output(&by_name(), &[], &[], COUNTS)?;
    let changes: [(&str, Change); 6] = [
        ("the kind", |n| n.kind = KIND_SYMLINK),
        ("the flags", |n| n.flags = 1),
        ("the size", |n| n.size += 1.0),
        ("the allocation", |n| n.alloc += 4096.0),
        ("the mtime", |n| n.mtime += 0.25),
        ("the atime", |n| n.atime = 0.0),
    ];
    for (column, change) in changes {
        let mut nodes = by_other();
        let target = nodes
            .iter_mut()
            .find(|n| n.path == "a/d/e.bin")
            .ok_or("no a/d/e.bin")?;
        change(target);
        let found = compare(&base, &output(&nodes, &[], &[], COUNTS)?)?;
        assert_eq!(
            found.len(),
            1,
            "{column}: exactly one difference, got {found:?}"
        );
        let line = found.first().ok_or("no line")?;
        assert!(
            line.starts_with("\"a/d/e.bin\": ") && line.contains(column),
            "{column}: {line}"
        );
    }
    Ok(())
}

#[test]
fn a_path_on_one_side_only_is_named() -> TestResult {
    let base = output(&by_name(), &[], &[], COUNTS)?;
    let mut fewer = by_other();
    fewer.retain(|n| n.path != "z.txt");
    let found = compare(&base, &output(&fewer, &[], &[], COUNTS)?)?;
    assert_eq!(found, vec!["\"z.txt\": only in the MFT walk".to_owned()]);
    let mut renamed = by_other();
    for n in &mut renamed {
        if n.path == "a/c.txt" {
            n.path = "a/C.txt";
        }
    }
    let found = compare(&base, &output(&renamed, &[], &[], COUNTS)?)?;
    assert_eq!(
        found,
        vec![
            "\"a/c.txt\": only in the MFT walk".to_owned(),
            "\"a/C.txt\": only in the listing walk".to_owned()
        ]
    );
    // One node under another parent is another path too.
    let mut moved = by_other();
    for n in &mut moved {
        if n.path == "a/d/e.bin" {
            n.path = "a/e.bin";
        }
    }
    let found = compare(&base, &output(&moved, &[], &[], COUNTS)?)?;
    assert_eq!(found.len(), 2, "{found:?}");
    Ok(())
}

#[test]
fn hard_links_refusals_and_counters_are_compared() -> TestResult {
    let base = output(
        &by_name(),
        &["b.txt", "a/c.txt"],
        &[("a/d", Refusal::Unreadable)],
        COUNTS,
    )?;
    let links = output(
        &by_other(),
        &["b.txt", "z.txt"],
        &[("a/d", Refusal::Unreadable)],
        COUNTS,
    )?;
    let found = compare(&base, &links)?;
    assert!(
        found.len() == 1 && found.iter().all(|l| l.starts_with("the hard links")),
        "{found:?}"
    );
    let refusals = output(
        &by_other(),
        &["b.txt", "a/c.txt"],
        &[("a/d", Refusal::Denied)],
        COUNTS,
    )?;
    let found = compare(&base, &refusals)?;
    assert!(
        found.len() == 1 && found.iter().all(|l| l.starts_with("the refusals")),
        "{found:?}"
    );
    for counts in [
        Counts {
            dirs_listed: 4,
            ..COUNTS
        },
        Counts {
            entries: 5,
            ..COUNTS
        },
        Counts {
            denied: 1,
            ..COUNTS
        },
        Counts {
            unreadable: 1,
            ..COUNTS
        },
        Counts {
            dataless: 1,
            ..COUNTS
        },
    ] {
        let other = output(
            &by_other(),
            &["b.txt", "a/c.txt"],
            &[("a/d", Refusal::Unreadable)],
            counts,
        )?;
        let found = compare(&base, &other)?;
        assert!(
            found.len() == 1 && found.iter().all(|l| l.starts_with("the counters")),
            "{counts:?}: {found:?}"
        );
    }
    Ok(())
}

#[test]
fn an_unknown_time_equals_only_an_unknown_time() -> TestResult {
    let base = output(&by_name(), &[], &[], COUNTS)?;
    assert!(compare(&base, &output(&by_other(), &[], &[], COUNTS)?)?.is_empty());
    let mut known = by_other();
    for n in &mut known {
        n.atime = 0.0;
    }
    assert_eq!(
        compare(&base, &output(&known, &[], &[], COUNTS)?)?.len(),
        7,
        "each node's NaN atime against 0"
    );
    Ok(())
}

#[test]
fn the_emitted_order_is_kept_per_directory() -> TestResult {
    let a = child_order(&output(&by_name(), &[], &[], COUNTS)?)?;
    let b = child_order(&output(&by_other(), &[], &[], COUNTS)?)?;
    assert_eq!(
        a.get("").ok_or("no root")?,
        &vec!["a".to_owned(), "b.txt".to_owned(), "z.txt".to_owned()]
    );
    assert_eq!(
        b.get("").ok_or("no root")?,
        &vec!["z.txt".to_owned(), "a".to_owned(), "b.txt".to_owned()]
    );
    assert_eq!(
        b.get("a").ok_or("no a")?,
        &vec!["d".to_owned(), "c.txt".to_owned()]
    );
    assert_eq!(a.len(), 3, "the root, a and a/d have children");
    assert_ne!(a, b, "the canonical layouts are equal, the orders are not");
    Ok(())
}

#[test]
fn a_malformed_output_is_refused() -> TestResult {
    let mut bad = output(&by_name(), &[], &[], COUNTS)?;
    if let Some(p) = bad.parent.get_mut(2) {
        *p = 2;
    }
    assert!(canonical(&bad).is_err(), "a parent that does not precede");
    assert!(child_order(&bad).is_err());
    let mut short = output(&by_name(), &[], &[], COUNTS)?;
    short.atime_ms.pop();
    assert!(canonical(&short).is_err(), "a column one row short");
    // A row too many is caught only by the length check: every row read
    // exists.
    let mut long = output(&by_name(), &[], &[], COUNTS)?;
    long.size.push(1.0);
    assert!(canonical(&long).is_err(), "a column one row long");
    Ok(())
}

#[test]
fn a_long_list_of_differences_is_capped() -> TestResult {
    let base = output(&by_name(), &[], &[], COUNTS)?;
    let mut other = by_other();
    for n in &mut other {
        n.mtime += 1.0;
    }
    let a = canonical(&base)?;
    let b = canonical(&output(&other, &[], &[], COUNTS)?)?;
    let found = differences(&a, &b, 2);
    assert_eq!(found.len(), 3, "{found:?}");
    assert_eq!(found.last().map(String::as_str), Some("... and 5 more"));
    Ok(())
}

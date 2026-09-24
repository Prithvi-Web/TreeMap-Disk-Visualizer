//! The store built from a scripted walk, fact by fact against the Node ingest's rules
//! (`ingestColumns` in `src/services/scan/nativeEngine.ts`, `statToInput`,
//! `PackedScanStore`'s `writeNode`/`internExt`/`finalize`).

use tm_store::derive::ContainerRule;
use tm_store::{BuildOptions, EXT_NONE, EXT_OVERFLOW, Store, StoreError, StoreMode, build, flag};
use tm_walk::{
    DirRefusal, FLAG_DATALESS, FLAG_REFUSED_DIR, FastPath, HardlinkRef, KIND_DIR, KIND_FILE,
    KIND_SYMLINK, Refusal, WalkOutput, WalkStats,
};

type TestResult = Result<(), StoreError>;

const HEADROOM: u32 = 16;

/// One node of a scripted walk.
#[derive(Clone, Copy)]
struct Node {
    parent: u32,
    name: &'static str,
    kind: u8,
    flags: u8,
    size: f64,
    alloc: f64,
    mtime: f64,
    atime: f64,
}

fn dir(parent: u32, name: &'static str) -> Node {
    Node {
        parent,
        name,
        kind: KIND_DIR,
        flags: 0,
        size: 0.0,
        alloc: 0.0,
        mtime: 1_000.0,
        atime: f64::NAN,
    }
}

/// A file whose allocation matches its size, so it is neither sparse nor slack.
fn file(parent: u32, name: &'static str, size: f64) -> Node {
    Node {
        parent,
        name,
        kind: KIND_FILE,
        flags: 0,
        size,
        alloc: size,
        mtime: 2_000.0,
        atime: f64::NAN,
    }
}

/// A hard-link row: `(node, family)`.
type Link = (u32, u32);

/// A refusal row: `(node, why)`.
type Refused = (u32, Refusal);

/// Adds a row to one of a walk's columns.
type Lengthen = fn(&mut WalkOutput);

fn walk_of(nodes: &[Node], hardlinks: &[Link], refusals: &[Refused]) -> WalkOutput {
    let mut names = Vec::new();
    let mut name_off = vec![0u32];
    for node in nodes {
        names.extend_from_slice(node.name.as_bytes());
        name_off.push(u32::try_from(names.len()).unwrap_or(u32::MAX));
    }
    WalkOutput {
        parent: nodes.iter().map(|n| n.parent).collect(),
        name_off,
        names,
        kind: nodes.iter().map(|n| n.kind).collect(),
        flags: nodes.iter().map(|n| n.flags).collect(),
        size: nodes.iter().map(|n| n.size).collect(),
        alloc_bytes: nodes.iter().map(|n| n.alloc).collect(),
        mtime_ms: nodes.iter().map(|n| n.mtime).collect(),
        atime_ms: nodes.iter().map(|n| n.atime).collect(),
        hardlinks: hardlinks
            .iter()
            .map(|&(node, family)| HardlinkRef { node, family })
            .collect(),
        refusals: refusals
            .iter()
            .map(|&(node, why)| DirRefusal { node, why })
            .collect(),
        stats: WalkStats {
            dirs_listed: 1,
            entries: nodes.len().saturating_sub(1) as u64,
            wall_ms: 1.0,
            cpu_seconds: f64::NAN,
            fast_path: FastPath::PerEntry,
            workers_peak: 1,
            climb_steps: 0,
            denied_entries: 3,
            unreadable_entries: 4,
            dataless: 0,
        },
    }
}

/// `detectContainerKind`'s rules in its order, with `CONTAINER_ID`'s numbers.
fn typescript_rules() -> Vec<ContainerRule> {
    let rule = |text: &str, whole_name: bool, folders: bool, kind: u8| ContainerRule {
        text: text.to_owned(),
        whole_name,
        folders,
        kind,
    };
    vec![
        rule(".photoslibrary", false, true, 6),
        rule("docker.raw", true, false, 7),
        rule("docker.qcow2", true, false, 7),
        rule("ext4.vhdx", true, false, 7),
        rule("docker_data.vhdx", true, false, 7),
        rule(".tar.gz", false, false, 3),
        rule(".tgz", false, false, 3),
        rule(".zip", false, false, 1),
        rule(".jar", false, false, 1),
        rule(".tar", false, false, 2),
        rule(".iso", false, false, 4),
        rule(".dmg", false, false, 5),
    ]
}

fn options() -> BuildOptions {
    BuildOptions {
        root_name: "scanned".to_owned(),
        root_mtime_ms: 777.0,
        blocks_are_meaningful: true,
        sort_children: true,
        container_rules: typescript_rules(),
        headroom_rows: HEADROOM,
        mode: StoreMode::Memory,
    }
}

/// The store id of the node named `name` (the first, in id order).
fn id_of(store: &Store, name: &str) -> usize {
    let off = store.name_off.as_slice();
    let names = store.names.as_slice();
    (0..store.n as usize)
        .find(|&i| {
            let (Some(&a), Some(&b)) = (off.get(i), off.get(i + 1)) else {
                return false;
            };
            names.get(a as usize..b as usize) == Some(name.as_bytes())
        })
        .unwrap_or(usize::MAX)
}

/// The name bytes of store row `id` (empty past the last).
fn name_at(store: &Store, id: usize) -> &[u8] {
    let off = store.name_off.as_slice();
    match (off.get(id), off.get(id + 1)) {
        (Some(&a), Some(&b)) => store.names.as_slice().get(a as usize..b as usize),
        _ => None,
    }
    .unwrap_or_default()
}

/// A float as the bits Node would hold: compared exactly, and −0 is not +0.
fn bits(x: f64) -> u64 {
    x.to_bits()
}

fn at<T: Copy + Default>(column: &[T], id: usize) -> T {
    column.get(id).copied().unwrap_or_default()
}

#[test]
fn every_column_has_a_row_per_node_and_room_for_the_headroom() -> TestResult {
    let nodes = [
        dir(0, "r"),
        file(0, "a.txt", 10.0),
        dir(0, "sub"),
        file(2, "b.txt", 20.0),
    ];
    let store = build(walk_of(&nodes, &[], &[]), &options())?;
    let n = nodes.len();
    assert_eq!(store.n as usize, n);
    assert_eq!(store.capacity as usize, n + HEADROOM as usize);
    let rows = [
        ("parent", store.parent.len(), store.parent.capacity()),
        ("size", store.size.len(), store.size.capacity()),
        ("mtime", store.mtime.len(), store.mtime.capacity()),
        ("flags", store.flags.len(), store.flags.capacity()),
        ("ext", store.ext.len(), store.ext.capacity()),
        (
            "container",
            store.container.len(),
            store.container.capacity(),
        ),
        (
            "cloud_prov",
            store.cloud_prov.len(),
            store.cloud_prov.capacity(),
        ),
        (
            "child_start",
            store.child_start.len(),
            store.child_start.capacity(),
        ),
        (
            "child_cnt",
            store.child_cnt.len(),
            store.child_cnt.capacity(),
        ),
    ];
    for (column, len, capacity) in rows {
        assert_eq!(len, n, "{column} has a row per node");
        assert!(
            capacity >= store.capacity as usize,
            "{column} has room for the headroom"
        );
    }
    assert_eq!(store.name_off.len(), n + 1);
    assert!(store.name_off.capacity() > store.capacity as usize);
    assert_eq!(
        store.names.as_slice(),
        b"scanneda.txtsubb.txt",
        "the root's name is Node's"
    );
    assert!(store.names.capacity() >= store.names.len() + HEADROOM as usize * 64);
    assert!(store.atime.is_none(), "no node recorded an access time");
    assert!(
        store.cloud_prov.as_slice().iter().all(|&p| p == 0),
        "Node sets providers"
    );
    assert_eq!(store.parent.as_slice(), [-1, 0, 0, 2]);
    assert_eq!(store.child_start.as_slice(), [1, 3, 3, 4]);
    assert_eq!(store.child_cnt.as_slice(), [2, 0, 1, 0]);
    assert_eq!(
        store.walk_stats.denied_entries, 3,
        "the walk's stats travel with the store"
    );
    Ok(())
}

#[test]
fn the_root_row_is_a_folder_with_node_s_name_and_the_walk_s_times() -> TestResult {
    let mut root = dir(0, "ignored");
    root.mtime = 1_695_000_000_000.5;
    root.atime = 1_695_000_000_000.4;
    let store = build(
        walk_of(&[root], &[], &[]),
        &BuildOptions {
            root_name: ".Lib.photoslibrary".to_owned(),
            ..options()
        },
    )?;
    assert_eq!(store.names.as_slice(), b".Lib.photoslibrary");
    let flags = at(store.flags.as_slice(), 0);
    assert_eq!(
        flags,
        flag::DIR | flag::HAS_CHILD_ARRAY | flag::HIDDEN | flag::HAS_ACCESSED,
        "{flags:#b}"
    );
    assert_eq!(
        at(store.container.as_slice(), 0),
        6,
        "a Photos library scanned as the root"
    );
    assert_eq!(
        bits(at(store.mtime.as_slice(), 0)),
        bits(1_695_000_000_001.0)
    );
    assert_eq!(
        store.atime.as_ref().map(|a| at(a.as_slice(), 0)),
        Some(1_695_000_000_000.0)
    );
    assert_eq!(store.counters.dirs, 1);

    root.mtime = f64::NAN;
    root.atime = 0.0;
    let store = build(walk_of(&[root], &[], &[]), &options())?;
    assert_eq!(
        bits(at(store.mtime.as_slice(), 0)),
        bits(777.0),
        "Node's own stat when the walk withheld it"
    );
    assert!(store.atime.is_none());
    assert_eq!(
        at(store.flags.as_slice(), 0),
        flag::DIR | flag::HAS_CHILD_ARRAY
    );
    Ok(())
}

#[test]
fn a_hard_linked_file_keeps_its_bytes_at_its_first_name_in_store_order() -> TestResult {
    // The walk meets `a/b` before `z`, but the store adds the root's children first, so
    // `z` is the first name: it keeps the bytes and `b` is the duplicate.
    let nodes = [
        dir(0, "r"),
        dir(0, "a"),
        file(1, "b", 100.0),
        file(0, "z", 100.0),
        file(0, "y", 7.0),
    ];
    let store = build(walk_of(&nodes, &[(2, 0), (3, 0), (4, 1)], &[]), &options())?;
    let (b, z, y) = (id_of(&store, "b"), id_of(&store, "z"), id_of(&store, "y"));
    assert!(z < b, "z is before b in the store");
    assert_eq!(bits(at(store.size.as_slice(), z)), bits(100.0));
    assert_eq!(bits(at(store.size.as_slice(), b)), bits(0.0));
    assert_eq!(
        bits(at(store.size.as_slice(), y)),
        bits(7.0),
        "a family of one is nobody's duplicate"
    );
    assert_eq!(
        at(store.flags.as_slice(), b) & flag::HARDLINK_DUP,
        flag::HARDLINK_DUP
    );
    assert_eq!(at(store.flags.as_slice(), z) & flag::HARDLINK_DUP, 0);
    assert_eq!(store.counters.hardlinked_files, 1);
    assert_eq!(bits(store.counters.hardlinked_bytes), bits(100.0));
    Ok(())
}

#[test]
fn sparse_and_slack_are_counted_only_where_blocks_mean_anything() -> TestResult {
    let mut slack = file(0, "slack", 1_000.0);
    slack.alloc = 4_096.0;
    let mut sparse = file(0, "sparse", 10_000.0);
    sparse.alloc = 4_096.0;
    let mut empty = file(0, "empty", 0.0);
    empty.alloc = 4_096.0;
    let mut dup = file(0, "zdup", 10_000.0);
    dup.alloc = 4_096.0;
    let mut first = file(0, "first", 10_000.0);
    first.alloc = 10_000.0;
    let nodes = [dir(0, "r"), slack, sparse, empty, dup, first];
    let links = [(4, 1), (5, 1)];
    let store = build(walk_of(&nodes, &links, &[]), &options())?;
    assert_eq!(bits(store.counters.slack_bytes), bits(3_096.0));
    assert_eq!(
        store.counters.sparse_files, 1,
        "the duplicate's shortfall is its first name's"
    );
    assert_eq!(bits(store.counters.sparse_bytes), bits(5_904.0));
    assert!(
        store.cloud_candidates.is_empty(),
        "everything here has blocks"
    );

    let store = build(
        walk_of(&nodes, &links, &[]),
        &BuildOptions {
            blocks_are_meaningful: false,
            ..options()
        },
    )?;
    assert_eq!(bits(store.counters.slack_bytes), bits(0.0));
    assert_eq!(store.counters.sparse_files, 0);
    assert_eq!(bits(store.counters.sparse_bytes), bits(0.0));
    Ok(())
}

#[test]
fn the_walk_s_placeholders_are_counted_and_its_guesses_left_to_node() -> TestResult {
    let mut dataless = file(0, "a-dataless", 500.0);
    dataless.alloc = 0.0;
    dataless.flags = FLAG_DATALESS;
    let mut guess = file(0, "b-guess", 300.0);
    guess.alloc = 0.0;
    let mut link = file(0, "c-link", 12.0);
    link.kind = KIND_SYMLINK;
    link.alloc = 0.0;
    let mut cloud_link = link;
    cloud_link.name = "d-cloud-link";
    cloud_link.flags = FLAG_DATALESS;
    let mut empty = file(0, "e-empty", 0.0);
    empty.alloc = 0.0;
    let mut dataless_dir = dir(0, "f-dir");
    dataless_dir.flags = FLAG_DATALESS;
    let nodes = [
        dir(0, "r"),
        dataless,
        guess,
        link,
        cloud_link,
        empty,
        dataless_dir,
    ];
    let store = build(walk_of(&nodes, &[], &[]), &options())?;
    let id = |name| id_of(&store, name);
    let placeholder = |name| at(store.flags.as_slice(), id(name)) & flag::CLOUD_PLACEHOLDER != 0;
    assert!(placeholder("a-dataless"));
    assert!(
        placeholder("d-cloud-link"),
        "the walk's flag is exact, a link included"
    );
    assert!(!placeholder("b-guess"), "a guess is Node's to decide");
    assert!(!placeholder("c-link") && !placeholder("e-empty") && !placeholder("f-dir"));
    let candidates: Vec<usize> = store.cloud_candidates.iter().map(|&c| c as usize).collect();
    assert_eq!(
        candidates,
        [id("a-dataless"), id("b-guess"), id("d-cloud-link")]
    );
    assert_eq!(store.counters.cloud_files, 2);
    assert_eq!(bits(store.counters.cloud_bytes), bits(512.0));
    assert_eq!(
        store.counters.sparse_files, 0,
        "the guess's shortfall waits for Node's answer"
    );
    assert_eq!(at(store.flags.as_slice(), id("c-link")), flag::SYMLINK);
    Ok(())
}

#[test]
fn a_git_folder_marks_the_folder_it_is_in() -> TestResult {
    let nodes = [
        dir(0, "r"),
        dir(0, ".git"),
        dir(0, "p"),
        dir(2, ".git"),
        dir(0, "q"),
        file(4, ".git", 1.0),
    ];
    let store = build(walk_of(&nodes, &[], &[]), &options())?;
    let git = |name| at(store.flags.as_slice(), id_of(&store, name)) & flag::GIT_REPO != 0;
    assert!(git("scanned"), "the root");
    assert!(git("p"));
    assert!(!git("q"), "a file named .git is not a repository");
    Ok(())
}

#[test]
fn extensions_are_interned_lower_case_in_store_order() -> TestResult {
    let mut link = file(0, "l.JPG", 3.0);
    link.kind = KIND_SYMLINK;
    let nodes = [
        dir(0, "r"),
        file(0, "c.Md", 1.0),
        file(0, "b.TXT", 1.0),
        file(0, "a.txt", 1.0),
        dir(0, "x.txt"),
        link,
        file(0, ".bashrc", 1.0),
    ];
    let store = build(walk_of(&nodes, &[], &[]), &options())?;
    assert_eq!(
        store.ext_dict,
        ["", "txt", "md", "jpg"],
        "sorted: .bashrc a.txt b.TXT c.Md l.JPG x.txt"
    );
    let ext = |name| at(store.ext.as_slice(), id_of(&store, name));
    assert_eq!(
        (ext("a.txt"), ext("b.TXT"), ext("c.Md"), ext("l.JPG")),
        (1, 1, 2, 3)
    );
    assert_eq!(ext("x.txt"), EXT_NONE, "a folder has no extension");
    assert_eq!(ext(".bashrc"), EXT_NONE, "a dotfile has none");
    assert!(store.ext_overflow.is_empty());
    Ok(())
}

#[test]
fn names_javascript_decides_are_listed_and_left_at_none() -> TestResult {
    let nodes = [
        dir(0, "r"),
        file(0, "café.zip", 1.0),
        file(0, "日本語", 1.0),
        file(0, "plain.zip", 1.0),
    ];
    let store = build(
        walk_of(&nodes, &[], &[]),
        &BuildOptions {
            root_name: "Fotos.photoslibrarÿ".to_owned(),
            ..options()
        },
    )?;
    let cafe = id_of(&store, "café.zip");
    let candidates: Vec<usize> = store.text_candidates.iter().map(|&c| c as usize).collect();
    assert_eq!(
        candidates,
        [0, cafe],
        "the root too: a name outside ASCII with a dot"
    );
    assert_eq!(at(store.ext.as_slice(), cafe), EXT_NONE);
    assert_eq!(at(store.container.as_slice(), cafe), 0);
    assert_eq!(
        at(store.container.as_slice(), id_of(&store, "plain.zip")),
        1
    );
    Ok(())
}

#[test]
fn refusals_become_the_denied_vanished_and_unreadable_counters() -> TestResult {
    let mut refused = [dir(0, "d1"), dir(0, "d2"), dir(0, "v"), dir(0, "u")];
    for node in &mut refused {
        node.flags = FLAG_REFUSED_DIR;
    }
    let nodes = [
        dir(0, "r"),
        refused[0],
        refused[1],
        refused[2],
        refused[3],
        file(0, "f", 1.0),
    ];
    let why = [
        (1, Refusal::Denied),
        (2, Refusal::Denied),
        (3, Refusal::Vanished),
        (4, Refusal::Unreadable),
    ];
    let store = build(walk_of(&nodes, &[], &why), &options())?;
    let mut denied: Vec<usize> = store
        .counters
        .denied_dirs
        .iter()
        .map(|&d| d as usize)
        .collect();
    denied.sort_unstable();
    assert_eq!(denied, [id_of(&store, "d1"), id_of(&store, "d2")]);
    assert_eq!(store.counters.vanished_dirs, 1);
    assert_eq!(store.counters.unreadable_dirs, 1);
    assert_eq!((store.counters.dirs, store.counters.files), (5, 1));
    Ok(())
}

#[test]
fn folders_and_everything_else_are_counted_and_times_rounded_as_node_does() -> TestResult {
    let mut old = file(0, "old", 1.0);
    old.mtime = -0.5;
    let mut withheld = file(0, "withheld", 1.0);
    withheld.mtime = f64::NAN;
    let mut read = file(0, "read", 1.0);
    read.atime = 2.5;
    let mut link = file(0, "link", 4.0);
    link.kind = KIND_SYMLINK;
    let nodes = [dir(0, "r"), old, withheld, read, link, dir(0, "d")];
    let store = build(walk_of(&nodes, &[], &[]), &options())?;
    assert_eq!((store.counters.dirs, store.counters.files), (2, 4));
    let mtime = |name| at(store.mtime.as_slice(), id_of(&store, name));
    assert!(
        mtime("old") == 0.0 && mtime("old").is_sign_negative(),
        "Math.round(-0.5) is -0"
    );
    assert!(mtime("withheld") == 0.0 && mtime("withheld").is_sign_positive());
    let read_id = id_of(&store, "read");
    let atime = store
        .atime
        .as_ref()
        .map(|a| a.as_slice().to_vec())
        .unwrap_or_default();
    assert_eq!(
        atime.len(),
        nodes.len(),
        "a zero row for every node without one"
    );
    assert_eq!(atime.iter().filter(|&&a| a != 0.0).count(), 1);
    assert_eq!(bits(at(&atime, read_id)), bits(3.0));
    assert!(read_id > 0, "the column is made at a later row");
    assert!(
        store
            .atime
            .as_ref()
            .is_some_and(|a| a.capacity() >= store.capacity as usize),
        "the access times have room for the headroom too"
    );
    assert_eq!(
        at(store.flags.as_slice(), read_id) & flag::HAS_ACCESSED,
        flag::HAS_ACCESSED
    );
    assert_eq!(
        bits(at(store.size.as_slice(), id_of(&store, "link"))),
        bits(4.0),
        "a link's own length"
    );
    Ok(())
}

#[test]
fn the_extension_dictionary_overflows_as_the_packed_store_s_does() -> TestResult {
    // 65,534 extensions fit beside "none"; the next ones are kept per node (`extOverflow`).
    // `zz.over1` is first in the walk and last in the store, so every overflow row's walk
    // index differs from its id.
    const DISTINCT: usize = 65_540;
    let names: Vec<&'static str> = ["zz.over1"]
        .into_iter()
        .chain((0..DISTINCT).map(|i| &*Box::leak(format!("f{i:06}.e{i:06}").into_boxed_str())))
        .chain(["g.e065539"])
        .collect();
    let mut nodes = vec![dir(0, "r")];
    nodes.extend(names.iter().map(|&name| file(0, name, 1.0)));
    let store = build(walk_of(&nodes, &[], &[]), &options())?;
    assert_eq!(store.ext_dict.len(), 0xffff);
    let overflowed: Vec<&str> = store.ext_overflow.iter().map(|(_, e)| e.as_str()).collect();
    assert_eq!(
        overflowed,
        [
            "e065534", "e065535", "e065536", "e065537", "e065538", "e065539", "e065539", "over1"
        ],
        "each overflowing name is kept on its own, a repeat included"
    );
    for (id, extension) in &store.ext_overflow {
        let id = *id as usize;
        assert_eq!(at(store.ext.as_slice(), id), EXT_OVERFLOW);
        assert!(
            name_at(&store, id).ends_with(format!(".{extension}").as_bytes()),
            "row {id} is the node whose extension it holds"
        );
    }
    Ok(())
}

#[test]
fn what_the_build_cannot_do_as_node_would_is_refused() {
    let nodes = [dir(0, "r"), file(0, "a", 1.0)];
    for mode in [StoreMode::Spill, StoreMode::Aggregate] {
        let refused = build(
            walk_of(&nodes, &[], &[]),
            &BuildOptions { mode, ..options() },
        );
        assert_eq!(refused, Err(StoreError::ModeNotBuilt(mode)));
    }
    let mut rules = typescript_rules();
    rules.push(ContainerRule {
        text: ".ZIP".to_owned(),
        whole_name: false,
        folders: false,
        kind: 1,
    });
    let refused = build(
        walk_of(&nodes, &[], &[]),
        &BuildOptions {
            container_rules: rules,
            ..options()
        },
    );
    assert!(
        matches!(refused, Err(StoreError::BadContainerRule { index: 12, .. })),
        "{refused:?}"
    );

    let mut short = walk_of(&nodes, &[], &[]);
    short.mtime_ms.pop();
    assert!(matches!(
        build(short, &options()),
        Err(StoreError::Malformed(_))
    ));
    let mut long = walk_of(&nodes, &[], &[]);
    long.size.push(1.0);
    assert!(
        matches!(build(long, &options()), Err(StoreError::Malformed(_))),
        "a column with a row no node owns"
    );
    assert!(
        matches!(
            build(walk_of(&nodes, &[(7, 1)], &[]), &options()),
            Err(StoreError::Malformed(_))
        ),
        "a side table naming a node that is not there"
    );
    assert!(
        matches!(
            build(walk_of(&[file(0, "r", 1.0)], &[], &[]), &options()),
            Err(StoreError::Malformed(_))
        ),
        "a root that is not a folder"
    );
}

/// A folder the walk could not list.
fn refused_dir(parent: u32, name: &'static str) -> Node {
    Node {
        flags: FLAG_REFUSED_DIR,
        ..dir(parent, name)
    }
}

/// A file that claims `size` bytes with `alloc` allocated.
fn file_alloc(parent: u32, name: &'static str, size: f64, alloc: f64) -> Node {
    Node {
        alloc,
        ..file(parent, name, size)
    }
}

/// A file the walk flagged a placeholder.
fn dataless(parent: u32, name: &'static str, size: f64, alloc: f64) -> Node {
    Node {
        flags: FLAG_DATALESS,
        ..file_alloc(parent, name, size, alloc)
    }
}

fn ids(list: &[u32]) -> Vec<usize> {
    list.iter().map(|&id| id as usize).collect()
}

#[test]
fn what_the_build_lists_is_store_ids_when_the_walk_lists_in_another_order() -> TestResult {
    // The walk lists these as a folder's listing came; the store sorts them by name bytes.
    // Two folders vanished and one was unreadable, so the two counts swapped would differ.
    let nodes = [
        dir(0, "r"),
        dataless(0, "z-dataless", 500.0, 0.0), // walk 1, store 7
        refused_dir(0, "v1"),                  // walk 2, store 5
        file(0, "zé.txt", 1.0),                // walk 3, store 8
        file_alloc(0, "m-guess", 300.0, 0.0),  // walk 4, store 3
        refused_dir(0, "v2"),                  // walk 5, store 6
        refused_dir(0, "u"),                   // walk 6, store 4
        refused_dir(0, "d"),                   // walk 7, store 2
        file(0, "a", 1.0),                     // walk 8, store 1
    ];
    let why = [
        (2, Refusal::Vanished),
        (5, Refusal::Vanished),
        (6, Refusal::Unreadable),
        (7, Refusal::Denied),
    ];
    let store = build(walk_of(&nodes, &[], &why), &options())?;
    let id = |name| id_of(&store, name);
    assert_eq!(
        [
            id("a"),
            id("d"),
            id("m-guess"),
            id("u"),
            id("v1"),
            id("v2"),
            id("z-dataless"),
            id("zé.txt")
        ],
        [1, 2, 3, 4, 5, 6, 7, 8],
        "the store's order"
    );
    assert_eq!(
        ids(&store.cloud_candidates),
        [id("m-guess"), id("z-dataless")]
    );
    assert_eq!(ids(&store.text_candidates), [id("zé.txt")]);
    assert_eq!(ids(&store.counters.denied_dirs), [id("d")]);
    assert_eq!(store.counters.vanished_dirs, 2);
    assert_eq!(store.counters.unreadable_dirs, 1);
    assert_eq!((store.counters.dirs, store.counters.files), (5, 4));
    assert_eq!(store.counters.cloud_files, 1);
    assert_eq!(bits(store.counters.cloud_bytes), bits(500.0));
    Ok(())
}

#[test]
fn a_git_folder_marks_its_parent_s_store_row_and_only_when_spelled_git() -> TestResult {
    // `z` is first in the walk and second in the store; `a` the other way round.
    let nodes = [
        dir(0, "r"),
        dir(0, "z"),
        dir(0, "a"),
        dir(1, ".git"),
        dir(2, ".GIT"),
    ];
    let store = build(walk_of(&nodes, &[], &[]), &options())?;
    let (a, z) = (id_of(&store, "a"), id_of(&store, "z"));
    assert_eq!((a, z), (1, 2));
    let git = |id| at(store.flags.as_slice(), id) & flag::GIT_REPO != 0;
    assert!(git(z), "z holds the .git folder");
    assert!(
        !git(a),
        "a holds `.GIT`, which the ingest's `name === '.git'` does not match"
    );
    assert!(!git(0));
    Ok(())
}

#[test]
fn a_scanned_folder_named_git_is_a_plain_hidden_root() -> TestResult {
    // The ingest applies the `.git` rule to the children it adds, never to the root.
    let store = build(
        walk_of(&[dir(0, "x"), file(0, "HEAD", 1.0)], &[], &[]),
        &BuildOptions {
            root_name: ".git".to_owned(),
            ..options()
        },
    )?;
    let root = at(store.flags.as_slice(), 0);
    assert_eq!(
        root,
        flag::DIR | flag::HAS_CHILD_ARRAY | flag::HIDDEN,
        "{root:#b}"
    );
    Ok(())
}

#[test]
fn hard_linked_guesses_and_placeholders_are_judged_before_the_dedup_and_tallied_after() -> TestResult
{
    // `ingestColumns` judges the guess on the walk's bytes before the dedup zeroes a later
    // name's size, and tallies a placeholder's bytes after it.
    let nodes = [
        dir(0, "r"),
        dataless(0, "p2", 500.0, 0.0),   // walk 1, store 4
        file_alloc(0, "g2", 300.0, 0.0), // walk 2, store 2
        file_alloc(0, "g1", 300.0, 0.0), // walk 3, store 1
        dataless(0, "p1", 500.0, 0.0),   // walk 4, store 3
    ];
    let links = [(1, 1), (2, 0), (3, 0), (4, 1)];
    let store = build(walk_of(&nodes, &links, &[]), &options())?;
    let id = |name| id_of(&store, name);
    let (g1, g2, p1, p2) = (id("g1"), id("g2"), id("p1"), id("p2"));
    assert_eq!((g1, g2, p1, p2), (1, 2, 3, 4));
    assert_eq!(
        ids(&store.cloud_candidates),
        [g1, g2, p1, p2],
        "a later name is a candidate like its first"
    );
    let size = |id| bits(at(store.size.as_slice(), id));
    assert_eq!(
        (size(g1), size(g2), size(p1), size(p2)),
        (bits(300.0), bits(0.0), bits(500.0), bits(0.0))
    );
    let flags = |id| at(store.flags.as_slice(), id);
    assert_eq!(flags(g1), 0);
    assert_eq!(flags(g2), flag::HARDLINK_DUP);
    assert_eq!(flags(p1), flag::CLOUD_PLACEHOLDER);
    assert_eq!(flags(p2), flag::CLOUD_PLACEHOLDER | flag::HARDLINK_DUP);
    let c = &store.counters;
    assert_eq!(c.cloud_files, 2, "each placeholder name is a placeholder");
    assert_eq!(
        bits(c.cloud_bytes),
        bits(500.0),
        "the later name's bytes are the first name's"
    );
    assert_eq!(c.hardlinked_files, 2);
    assert_eq!(bits(c.hardlinked_bytes), bits(800.0));
    assert_eq!((c.sparse_files, bits(c.sparse_bytes)), (0, bits(0.0)));
    assert!(
        store.sparse_terms.is_empty(),
        "the guesses are Node's to count"
    );
    Ok(())
}

#[test]
fn a_placeholder_s_allocation_is_neither_sparse_nor_slack() -> TestResult {
    let nodes = [
        dir(0, "r"),
        dataless(0, "partial", 10_000.0, 4_096.0),
        dataless(0, "over", 1_000.0, 4_096.0),
    ];
    let store = build(walk_of(&nodes, &[], &[]), &options())?;
    let c = &store.counters;
    assert_eq!((c.sparse_files, bits(c.sparse_bytes)), (0, bits(0.0)));
    assert_eq!(bits(c.slack_bytes), bits(0.0));
    assert_eq!(c.cloud_files, 2);
    assert_eq!(bits(c.cloud_bytes), bits(11_000.0));
    assert_eq!(ids(&store.cloud_candidates), [1, 2]);
    Ok(())
}

#[test]
fn a_symlink_named_like_a_container_is_one() -> TestResult {
    // `statToInput` gives a link the container kind of its own name.
    let mut link = file(0, "a.zip", 9.0);
    link.kind = KIND_SYMLINK;
    let store = build(walk_of(&[dir(0, "r"), link], &[], &[]), &options())?;
    assert_eq!(at(store.container.as_slice(), 1), 1);
    assert_eq!(at(store.flags.as_slice(), 1), flag::SYMLINK);
    Ok(())
}

#[test]
fn unsorted_children_keep_the_walk_s_order_through_the_build() -> TestResult {
    let nodes = [
        dir(0, "r"),
        file(0, "b", 1.0),
        dir(0, "a"),
        file(2, "c", 1.0),
    ];
    let store = build(
        walk_of(&nodes, &[], &[]),
        &BuildOptions {
            sort_children: false,
            ..options()
        },
    )?;
    assert_eq!(
        store.names.as_slice(),
        b"scannedbac",
        "as listed on Windows"
    );
    assert_eq!(store.parent.as_slice(), [-1, 0, 0, 2]);
    Ok(())
}

#[test]
fn a_side_table_naming_a_node_past_the_last_is_refused() {
    let two = [dir(0, "r"), file(0, "a", 1.0)];
    let refused = |walk| matches!(build(walk, &options()), Err(StoreError::Malformed(_)));
    assert!(
        refused(walk_of(&two, &[(2, 0)], &[])),
        "a hard link one past the last node"
    );
    assert!(
        refused(walk_of(&two, &[], &[(2, Refusal::Denied)])),
        "a refusal one past the last node"
    );
    assert!(
        refused(walk_of(&[dir(0, "r")], &[], &[(9, Refusal::Denied)])),
        "a refusal far past a walk of one"
    );
}

#[test]
fn side_tables_out_of_node_order_or_naming_a_node_twice_are_refused() {
    // The walk promises each table sorted by node with one row per node; the build looks
    // rows up by that order, so a table that breaks it cannot be read.
    let nodes = [
        dir(0, "r"),
        refused_dir(0, "d1"),
        refused_dir(0, "d2"),
        file(0, "f1", 1.0),
        file(0, "f2", 1.0),
    ];
    let cases: [(&str, &[Link], &[Refused]); 4] = [
        ("hard links out of order", &[(4, 0), (3, 0)], &[]),
        ("a node's hard link twice", &[(3, 0), (3, 0)], &[]),
        (
            "refusals out of order",
            &[],
            &[(2, Refusal::Vanished), (1, Refusal::Vanished)],
        ),
        (
            "a folder refused twice",
            &[],
            &[(1, Refusal::Denied), (1, Refusal::Vanished)],
        ),
    ];
    for (case, links, refusals) in cases {
        let built = build(walk_of(&nodes, links, refusals), &options());
        assert!(matches!(built, Err(StoreError::Malformed(_))), "{case}");
    }
    assert!(
        build(
            walk_of(
                &nodes,
                &[(3, 0), (4, 0)],
                &[(1, Refusal::Denied), (2, Refusal::Vanished)]
            ),
            &options()
        )
        .is_ok(),
        "the same tables in order"
    );
}

#[test]
fn a_family_numbered_past_the_hard_link_table_is_refused() {
    // Families are numbered from 0, at most one per row (tm-walk's `hardlink_families`;
    // tm-mft's `check_shape` refuses the same), which bounds the build's record of them.
    let nodes = [dir(0, "r"), file(0, "f", 1.0)];
    for family in [1, u32::MAX] {
        assert!(
            matches!(
                build(walk_of(&nodes, &[(1, family)], &[]), &options()),
                Err(StoreError::Malformed(_))
            ),
            "family {family} of a table of one"
        );
    }
    assert!(build(walk_of(&nodes, &[(1, 0)], &[]), &options()).is_ok());
}

#[test]
fn a_column_longer_than_the_walk_is_refused_whichever_it_is() {
    let nodes = [dir(0, "r"), file(0, "a", 1.0)];
    let lengthen: [(&str, Lengthen); 6] = [
        ("kind", |w| w.kind.push(KIND_FILE)),
        ("flags", |w| w.flags.push(0)),
        ("size", |w| w.size.push(1.0)),
        ("alloc_bytes", |w| w.alloc_bytes.push(1.0)),
        ("mtime_ms", |w| w.mtime_ms.push(1.0)),
        ("atime_ms", |w| w.atime_ms.push(1.0)),
    ];
    for (column, lengthen) in lengthen {
        let mut walk = walk_of(&nodes, &[], &[]);
        lengthen(&mut walk);
        let built = build(walk, &options());
        assert!(
            matches!(&built, Err(StoreError::Malformed(why)) if why.starts_with(column)),
            "{column}: {built:?}"
        );
    }
}

/// Node's `sparseBytes` after its pass: from 0, in id order, every term the build lists and
/// the size of every guess Node counts sparse (`counted`, ascending ids).
fn node_sparse_bytes(store: &Store, counted: &[u32]) -> f64 {
    let mut total = 0.0;
    let mut terms = store.sparse_terms.iter().peekable();
    for &guess in counted {
        while let Some(&(_, bytes)) = terms.next_if(|&&(id, _)| id < guess) {
            total += bytes;
        }
        total += at(store.size.as_slice(), guess as usize);
    }
    for &(_, bytes) in terms {
        total += bytes;
    }
    total
}

#[test]
fn sparse_bytes_can_be_summed_in_the_ingest_s_order_once_node_decides_its_guesses() -> TestResult {
    // `ingestColumns` keeps one running sum in id order, the guesses Node decides later
    // among the files counted here, and float addition depends on the order.
    const BIG: f64 = 1_152_921_504_606_846_976.0; // 2^60: its neighbours are 256 apart

    // Whole numbers whose every running total stays below 2^53: any order gives the same
    // sum, so the build gives one term.
    let nodes = [
        dir(0, "r"),
        file_alloc(0, "c", 8_192.0, 4_096.0),
        file_alloc(0, "b-guess", 300.0, 0.0),
        file_alloc(0, "a", 10_000.0, 4_096.0),
    ];
    let store = build(walk_of(&nodes, &[], &[]), &options())?;
    assert_eq!(store.sparse_terms, [(0, 10_000.0)]);
    assert_eq!(store.counters.sparse_files, 2);
    assert_eq!(bits(node_sparse_bytes(&store, &[2])), bits(10_300.0));

    // Past 2^53 the order shows: the ingest gives ((0 + 100) + 2^60) + 100 = 2^60, while
    // the build's sum then the guess gives 200 + 2^60 = 2^60 + 256.
    let nodes = [
        dir(0, "r"),
        file_alloc(0, "c.img", 4_196.0, 4_096.0), // walk 1, store 3
        file_alloc(0, "b.img", BIG, 0.0),         // walk 2, store 2
        file_alloc(0, "a.img", 4_196.0, 4_096.0), // walk 3, store 1
    ];
    let store = build(walk_of(&nodes, &[], &[]), &options())?;
    assert_eq!(store.sparse_terms, [(1, 100.0), (3, 100.0)]);
    assert_eq!(bits(store.counters.sparse_bytes), bits(200.0));
    assert_eq!(bits(node_sparse_bytes(&store, &[2])), bits(BIG));
    assert_ne!(bits(store.counters.sparse_bytes + BIG), bits(BIG));
    assert_eq!(
        bits(node_sparse_bytes(&store, &[])),
        bits(200.0),
        "no guess counted"
    );

    // A running total of exactly 2^53 may stand for more (2^53 + 1 rounds to it), so the
    // terms are listed: the ingest gives 2^53 here, their sum then the guess 2^53 + 2.
    let two_53 = 9_007_199_254_740_992.0;
    let nodes = [
        dir(0, "r"),
        file_alloc(0, "a", two_53 - 1.0, 1.0),
        file_alloc(0, "b-guess", 2.0, 0.0),
        file_alloc(0, "c", 2.0, 1.0),
        file_alloc(0, "d", 2.0, 1.0),
    ];
    let store = build(walk_of(&nodes, &[], &[]), &options())?;
    assert_eq!(store.sparse_terms, [(1, two_53 - 2.0), (3, 1.0), (4, 1.0)]);
    assert_eq!(bits(node_sparse_bytes(&store, &[2])), bits(two_53));

    // Fractions round below 2^53 too: the ingest gives 1.6 here, the other order
    // 1.6000000000000003.
    let nodes = [
        dir(0, "r"),
        file_alloc(0, "a", 1.3, 1.0),
        file_alloc(0, "b-guess", 0.1, 0.0),
        file_alloc(0, "c", 2.2, 1.0),
    ];
    let store = build(walk_of(&nodes, &[], &[]), &options())?;
    let ingest = ((0.0 - (1.0 - 1.3)) - (0.0 - 0.1)) - (1.0 - 2.2);
    assert_eq!(bits(ingest), bits(1.6));
    assert_eq!(store.sparse_terms.len(), 2);
    assert_eq!(bits(node_sparse_bytes(&store, &[2])), bits(ingest));

    // Where blocks mean nothing there is nothing to add.
    let store = build(
        walk_of(&nodes, &[], &[]),
        &BuildOptions {
            blocks_are_meaningful: false,
            ..options()
        },
    )?;
    assert!(store.sparse_terms.is_empty());
    Ok(())
}

#[test]
fn a_file_allocated_beyond_its_size_is_slack_and_no_sparse_term() -> TestResult {
    // The 2^60 walk, whose terms are listed, and a file taking 3,096 bytes more than it
    // claims: a term for it would take them off Node's `sparseBytes`, 2^60 − 3,072 here.
    const BIG: f64 = 1_152_921_504_606_846_976.0; // 2^60
    let nodes = [
        dir(0, "r"),
        file_alloc(0, "a.img", 4_196.0, 4_096.0),
        file_alloc(0, "b.img", BIG, 0.0),
        file_alloc(0, "c.img", 4_196.0, 4_096.0),
        file_alloc(0, "d.slack", 1_000.0, 4_096.0),
    ];
    let store = build(walk_of(&nodes, &[], &[]), &options())?;
    assert_eq!(store.sparse_terms, [(1, 100.0), (3, 100.0)]);
    assert_eq!(bits(store.counters.slack_bytes), bits(3_096.0));
    assert_eq!(bits(node_sparse_bytes(&store, &[2])), bits(BIG));
    Ok(())
}

#[test]
fn slack_does_not_lower_the_total_that_decides_whether_the_terms_are_listed() -> TestResult {
    // The 2^53 boundary walk with a file 1 byte slack at the end. Taken as a shortfall of −1,
    // it would bring the running total from 2^53 to 2^53 − 1 and fold the terms into one,
    // (0, 2^53), and Node would give 2^53 + 2 where the ingest gives 2^53.
    let two_53 = 9_007_199_254_740_992.0;
    let nodes = [
        dir(0, "r"),
        file_alloc(0, "a", two_53 - 1.0, 1.0),
        file_alloc(0, "b-guess", 2.0, 0.0),
        file_alloc(0, "c", 2.0, 1.0),
        file_alloc(0, "d", 2.0, 1.0),
        file_alloc(0, "e-slack", 1.0, 2.0),
    ];
    let store = build(walk_of(&nodes, &[], &[]), &options())?;
    assert_eq!(store.sparse_terms, [(1, two_53 - 2.0), (3, 1.0), (4, 1.0)]);
    assert_eq!(bits(store.counters.slack_bytes), bits(1.0));
    assert_eq!(bits(node_sparse_bytes(&store, &[2])), bits(two_53));
    Ok(())
}

#[test]
fn one_sparse_file_is_one_folded_term() -> TestResult {
    // One sparse file, far below 2^53.
    let nodes = [dir(0, "r"), file_alloc(0, "a", 10_000.0, 4_096.0)];
    let store = build(walk_of(&nodes, &[], &[]), &options())?;
    assert_eq!(store.counters.sparse_files, 1);
    assert_eq!(store.sparse_terms, [(0, 5_904.0)]);
    assert_eq!(bits(node_sparse_bytes(&store, &[])), bits(5_904.0));
    Ok(())
}

#[test]
fn cloud_bytes_can_be_summed_in_the_ingest_s_order_from_the_candidates_alone() -> TestResult {
    // Every `cloudBytes` term is a candidate's: the walk's placeholders and the guesses Node
    // finds a provider for, each its store size (0 for a later hard-link name). Summed over
    // the candidates in id order they are the ingest's sum, 2^60 here, where the walk's
    // placeholders' total then the guess would give 2^60 + 256.
    const BIG: f64 = 1_152_921_504_606_846_976.0;
    let nodes = [
        dir(0, "r"),
        dataless(0, "c", 100.0, 0.0),
        file_alloc(0, "b-guess", BIG, 0.0),
        dataless(0, "a", 100.0, 0.0),
    ];
    let store = build(walk_of(&nodes, &[], &[]), &options())?;
    let placeholder_or_decided =
        |id: u32| id == 2 || at(store.flags.as_slice(), id as usize) & flag::CLOUD_PLACEHOLDER != 0;
    let node_cloud_bytes: f64 = store
        .cloud_candidates
        .iter()
        .filter(|&&id| placeholder_or_decided(id))
        .fold(0.0, |total, &id| {
            total + at(store.size.as_slice(), id as usize)
        });
    assert_eq!(ids(&store.cloud_candidates), [1, 2, 3]);
    assert_eq!(bits(node_cloud_bytes), bits(BIG));
    assert_eq!(bits(store.counters.cloud_bytes), bits(200.0));
    Ok(())
}

//! The selection ports, T15a (Phase 4; design §S.5.5): `select_prune` and `select_treemap`
//! held to the JavaScript they port — `pruneStore` and `prunedExpansion`
//! (`src/services/scanStore.ts`), `buildTreemapFromStore` (`src/utils/treemap.ts`).
//!
//! Two kinds of evidence. Small trees worked by hand pin each rule a port could get wrong —
//! the heap's tie order, the last folder given every child, each bound — with the answers
//! the JavaScript itself gives for the same trees (`tests/selectOracle.test.ts` holds the
//! JavaScript to them). And the oracle `tests/fixtures/selectOracle.ts` writes from the
//! JavaScript (`tests/fixtures/select-oracle.tsv`): eighteen seeded trees full of ties,
//! grown here draw for draw by a copy of its generator, the largest 320,000 rows, each
//! selected at the budgets and treemap settings the routes use.

use tm_store::column::Column;
use tm_store::{
    Counters, Rect, RowError, Store, StoreMode, TreemapCell, TreemapOptions, flag, select_prune,
    select_treemap,
};
use tm_walk::{FastPath, WalkStats};

type TestResult = Result<(), Box<dyn std::error::Error>>;

// ---------------------------------------------------------------------------
// A store from columns
// ---------------------------------------------------------------------------

/// A tree in the store's layout: breadth-first ids, each row's children one consecutive
/// range of them.
#[derive(Default)]
struct Columns {
    parent: Vec<i32>,
    /// A file's bytes; a folder's total once [`sum_sizes`] has run.
    size: Vec<f64>,
    flags: Vec<u16>,
    container: Vec<u8>,
    child_start: Vec<u32>,
    child_cnt: Vec<u32>,
}

fn at<T: Copy>(column: &[T], id: usize, what: &str) -> Result<T, String> {
    column
        .get(id)
        .copied()
        .ok_or_else(|| format!("row {id} is outside {what}"))
}

/// `PackedScanStore.sumSizes()` (scanStore.ts), rule for rule: every folder zeroed, then
/// each row from the last to the first added into its parent when the parent is a folder
/// (a container keeps its own size), so every total is the float sum the JavaScript makes.
fn sum_sizes(c: &mut Columns) -> Result<(), String> {
    for (size, &bits) in c.size.iter_mut().zip(&c.flags) {
        if bits & flag::DIR != 0 {
            *size = 0.0;
        }
    }
    for id in (1..c.size.len()).rev() {
        if at(&c.flags, id, "flags")? & flag::REMOVED != 0 {
            continue;
        }
        let parent = usize::try_from(at(&c.parent, id, "parent")?)
            .map_err(|_| format!("row {id} has no parent"))?;
        if at(&c.flags, parent, "flags")? & flag::DIR != 0 {
            let bytes = at(&c.size, id, "size")?;
            *c.size.get_mut(parent).ok_or("a parent outside the sizes")? += bytes;
        }
    }
    Ok(())
}

/// The memory store holding `c`: the columns the selections read, the rest empty.
fn store_of(c: Columns) -> Result<Store, String> {
    let rows = c.parent.len();
    let n = u32::try_from(rows).map_err(|_| "too many rows")?;
    Ok(Store {
        mode: StoreMode::Memory,
        n,
        capacity: n,
        parent: Column::Owned(c.parent),
        size: Column::Owned(c.size),
        mtime: Column::Owned(vec![0.0; rows]),
        atime: None,
        flags: Column::Owned(c.flags),
        ext: Column::Owned(vec![0; rows]),
        container: Column::Owned(c.container),
        cloud_prov: Column::Owned(vec![0; rows]),
        name_off: Column::Owned(vec![0; rows + 1]),
        names: Column::Owned(Vec::new()),
        child_start: Column::Owned(c.child_start),
        child_cnt: Column::Owned(c.child_cnt),
        ext_dict: vec![String::new()],
        ext_overflow: Vec::new(),
        cloud_candidates: Vec::new(),
        text_candidates: Vec::new(),
        sparse_terms: Vec::new(),
        counters: Counters::default(),
        walk_stats: WalkStats {
            dirs_listed: 0,
            entries: 0,
            wall_ms: 0.0,
            cpu_seconds: 0.0,
            fast_path: FastPath::Unavailable,
            workers_peak: 0,
            climb_steps: 0,
            denied_entries: 0,
            unreadable_entries: 0,
            dataless: 0,
        },
    })
}

// ---------------------------------------------------------------------------
// Trees by hand
// ---------------------------------------------------------------------------

/// A row of a hand-made tree and the rows below it.
struct Row {
    size: f64,
    flags: u16,
    container: u8,
    children: Vec<Row>,
}

fn file(size: f64) -> Row {
    Row {
        size,
        flags: 0,
        container: 0,
        children: Vec::new(),
    }
}

fn folder(children: Vec<Row>) -> Row {
    Row {
        size: 0.0,
        flags: flag::DIR | flag::HAS_CHILD_ARRAY,
        container: 0,
        children,
    }
}

/// A folder without a child array: no scan makes one, but the two functions read the
/// flag differently, so it tells their rules apart.
fn folder_without_child_array(children: Vec<Row>) -> Row {
    Row {
        size: 0.0,
        flags: flag::DIR,
        container: 0,
        children,
    }
}

/// A file of container kind `kind` opened as a container is: a child array and children.
fn opened_container(kind: u8, size: f64, children: Vec<Row>) -> Row {
    Row {
        size,
        flags: flag::HAS_CHILD_ARRAY,
        container: kind,
        children,
    }
}

/// `root`'s tree numbered breadth-first and summed, as the ingest and `sumSizes()` leave it.
fn hand(root: &Row) -> Result<Store, String> {
    let mut rows = vec![root];
    let mut c = Columns {
        parent: vec![-1],
        ..Columns::default()
    };
    let mut id = 0;
    while let Some(&row) = rows.get(id) {
        let start = u32::try_from(rows.len()).map_err(|_| "too many rows")?;
        let this = i32::try_from(id).map_err(|_| "too many rows")?;
        c.child_start.push(start);
        c.child_cnt
            .push(u32::try_from(row.children.len()).map_err(|_| "too many rows")?);
        c.size.push(row.size);
        c.flags.push(row.flags);
        c.container.push(row.container);
        for child in &row.children {
            rows.push(child);
            c.parent.push(this);
        }
        id += 1;
    }
    sum_sizes(&mut c)?;
    store_of(c)
}

/// A cell as the JavaScript's `TreemapNode` has it, the rectangle by its bits.
type CellBits = (u32, u32, bool, [u64; 4]);

fn bits(cells: &[TreemapCell]) -> Vec<CellBits> {
    cells
        .iter()
        .map(|c| {
            let Rect { x, y, w, h } = c.rect;
            (
                c.id,
                c.depth,
                c.expanded,
                [x.to_bits(), y.to_bits(), w.to_bits(), h.to_bits()],
            )
        })
        .collect()
}

fn cell(id: u32, depth: u32, expanded: bool, [x, y, w, h]: [f64; 4]) -> CellBits {
    (
        id,
        depth,
        expanded,
        [x.to_bits(), y.to_bits(), w.to_bits(), h.to_bits()],
    )
}

fn options(max_depth: u32, min_size: f64, max_nodes: usize) -> TreemapOptions {
    TreemapOptions {
        max_depth,
        min_size,
        max_nodes,
    }
}

// ---------------------------------------------------------------------------
// The rules, one small tree each. Every expected value is what the JavaScript answers for
// the same tree (`tests/selectOracle.test.ts`, "the hand-made trees…").
// ---------------------------------------------------------------------------

/// Four folders of 100 bytes under the root, each holding two 50-byte files.
fn four_equal_folders() -> Result<Store, String> {
    hand(&folder(
        (0..4)
            .map(|_| folder(vec![file(50.0), file(50.0)]))
            .collect(),
    ))
}

#[test]
fn equal_folders_pop_first_then_last_to_second_as_the_javascript_heap_leaves_them() -> TestResult {
    // Pushed A, B, C, D (ids 1–4) with one size, the heap never swaps them; a pop moves D
    // to the top, which neither child beats, so D comes second. Neither first-in-first-out
    // nor the smallest id gives that order.
    let store = four_equal_folders()?;
    let at_nine = select_prune(&store, 0, 9)?;
    assert_eq!(at_nine.expanded, [0, 1, 4]);
    assert_eq!(at_nine.rows, [0, 1, 2, 3, 4, 5, 6, 11, 12]);
    let all = select_prune(&store, 0, 1_000)?;
    assert_eq!(all.expanded, [0, 1, 4, 3, 2]);
    assert_eq!(all.rows, [0, 1, 2, 3, 4, 5, 6, 11, 12, 9, 10, 7, 8]);

    let seven = hand(&folder((0..7).map(|_| folder(vec![file(10.0)])).collect()))?;
    let all = select_prune(&seven, 0, 1_000)?;
    assert_eq!(all.expanded, [0, 1, 7, 6, 5, 4, 3, 2]);
    Ok(())
}

#[test]
fn the_last_folder_popped_gives_every_child_past_the_budget() -> TestResult {
    // The root's pop counts 3 rows; the folder's then counts 13, far past 5, and all ten of
    // its files are rows of the answer: a folder is shown whole or not at all.
    let store = hand(&folder(vec![
        folder((0..10).map(|_| file(100.0)).collect()),
        file(7.0),
    ]))?;
    let selection = select_prune(&store, 0, 5)?;
    assert_eq!(selection.expanded, [0, 1]);
    assert_eq!(selection.rows, (0..13).collect::<Vec<u32>>());
    Ok(())
}

#[test]
fn no_folder_is_popped_once_the_rows_reach_the_budget() -> TestResult {
    // The root's pop counts 5 rows: at a budget of 5 nothing more is popped, at 6 one
    // folder is; at 1 (and at 0, which the JavaScript raises to 1) not even the root.
    let store = hand(&folder(vec![
        folder(vec![file(1.0)]),
        folder(vec![file(1.0)]),
        file(1.0),
        file(1.0),
    ]))?;
    let cases: [(usize, &[u32], &[u32]); 4] = [
        (0, &[], &[0]),
        (1, &[], &[0]),
        (5, &[0], &[0, 1, 2, 3, 4]),
        (6, &[0, 1], &[0, 1, 2, 3, 4, 5]),
    ];
    for (max_nodes, expanded, rows) in cases {
        let selection = select_prune(&store, 0, max_nodes)?;
        assert_eq!(selection.expanded, expanded, "expanded at {max_nodes}");
        assert_eq!(selection.rows, rows, "rows at {max_nodes}");
    }
    Ok(())
}

#[test]
fn the_treemap_expands_no_deeper_than_max_depth() -> TestResult {
    // A chain: the root, a folder, a folder, a file, each the whole of the one above.
    let store = hand(&folder(vec![folder(vec![folder(vec![file(100.0)])])]))?;
    let whole = [0.0, 0.0, 100.0, 100.0];
    let cases: [(u32, &[u32], Vec<CellBits>); 3] = [
        (1, &[0], vec![cell(1, 1, false, whole)]),
        (
            2,
            &[0, 1],
            vec![cell(1, 1, true, whole), cell(2, 2, false, whole)],
        ),
        (
            3,
            &[0, 1, 2],
            vec![
                cell(1, 1, true, whole),
                cell(2, 2, true, whole),
                cell(3, 3, false, whole),
            ],
        ),
    ];
    for (max_depth, read, cells) in cases {
        let map = select_treemap(&store, 0, &options(max_depth, 0.0, 20_000))?;
        assert_eq!(map.read, read, "read at depth {max_depth}");
        assert_eq!(bits(&map.cells), cells, "cells at depth {max_depth}");
    }
    Ok(())
}

#[test]
fn the_treemap_keeps_children_of_min_size_and_above_and_never_one_of_zero_bytes() -> TestResult {
    let store = hand(&folder(vec![
        file(4096.0),
        file(4095.0),
        file(4097.0),
        file(0.0),
    ]))?;
    let top = [0.0, 0.0, 66.674_804_687_5, 50.006_102_770_657_88];
    let below = [
        0.0,
        50.006_102_770_657_88,
        66.674_804_687_5,
        49.993_897_229_342_12,
    ];
    let at_cut = select_treemap(&store, 0, &options(4, 4096.0, 20_000))?;
    assert_eq!(
        at_cut.rows,
        [0, 1, 3],
        "4096 bytes is kept at a 4096-byte cut"
    );
    assert_eq!(
        bits(&at_cut.cells),
        [cell(3, 1, false, top), cell(1, 1, false, below)]
    );
    let none = select_treemap(&store, 0, &options(4, 0.0, 20_000))?;
    assert_eq!(none.rows, [0, 1, 2, 3], "zero bytes is never kept");
    assert_eq!(
        bits(&none.cells),
        [
            cell(3, 1, false, top),
            cell(1, 1, false, below),
            cell(
                2,
                1,
                false,
                [66.674_804_687_5, 0.0, 33.325_195_312_5, 100.0]
            ),
        ]
    );
    Ok(())
}

#[test]
fn the_treemap_emits_at_most_max_nodes_cells_and_reads_no_folder_past_them() -> TestResult {
    let five = hand(&folder(
        [5.0, 4.0, 3.0, 2.0, 1.0].into_iter().map(file).collect(),
    ))?;
    let map = select_treemap(&five, 0, &options(4, 0.0, 3))?;
    assert_eq!(
        map.rows,
        [0, 1, 2, 3, 4, 5],
        "every kept child is placed by the layout, though three cells are emitted"
    );
    assert_eq!(
        bits(&map.cells),
        [
            cell(1, 1, false, [0.0, 0.0, 60.0, 55.555_555_555_555_55]),
            cell(
                2,
                1,
                false,
                [0.0, 55.555_555_555_555_55, 60.0, 44.444_444_444_444_44]
            ),
            cell(3, 1, false, [60.0, 0.0, 40.0, 50.0]),
        ]
    );

    // Two expandable folders fill a budget of 2 at the root, so neither is read; at 3 the
    // first is read and gives one cell.
    let two = hand(&folder(vec![
        folder(vec![file(10.0), file(10.0)]),
        folder(vec![file(10.0), file(10.0)]),
    ]))?;
    let halves = [
        cell(1, 1, true, [0.0, 0.0, 100.0, 50.0]),
        cell(2, 1, true, [0.0, 50.0, 100.0, 50.0]),
    ];
    let at_two = select_treemap(&two, 0, &options(4, 0.0, 2))?;
    assert_eq!(at_two.read, [0]);
    assert_eq!(at_two.rows, [0, 1, 2]);
    assert_eq!(bits(&at_two.cells), halves);
    let at_three = select_treemap(&two, 0, &options(4, 0.0, 3))?;
    assert_eq!(at_three.read, [0, 1]);
    assert_eq!(at_three.rows, [0, 1, 2, 3, 4]);
    let [first, second] = halves;
    assert_eq!(
        bits(&at_three.cells),
        [first, second, cell(3, 2, false, [0.0, 0.0, 50.0, 50.0])]
    );
    Ok(())
}

#[test]
fn a_rectangle_just_0_2_across_is_too_thin_to_expand() -> TestResult {
    // A 2-byte folder beside 998 one-byte files that a 2-byte cut drops: its share of the
    // map is 20 of 10,000, a strip down the left edge exactly 0.2 wide.
    let mut beside = vec![folder(vec![file(2.0)])];
    beside.extend((0..998).map(|_| file(1.0)));
    let narrow = hand(&folder(beside))?;
    let map = select_treemap(&narrow, 0, &options(3, 2.0, 20_000))?;
    assert_eq!(map.read, [0]);
    assert_eq!(
        bits(&map.cells),
        [cell(1, 1, false, [0.0, 0.0, 0.2, 100.0])]
    );

    // A 6-byte folder in a 3,000-byte folder laid out 75 wide and 100 tall, beside 2,994
    // bytes a 6-byte cut drops: 15 of the folder's 7,500, a strip along its top exactly 0.2
    // tall.
    let mut inside = vec![folder(vec![file(6.0)])];
    inside.extend((0..598).map(|_| file(5.0)));
    inside.push(file(4.0));
    let flat = hand(&folder(vec![folder(inside), file(1000.0)]))?;
    let map = select_treemap(&flat, 0, &options(3, 6.0, 20_000))?;
    assert_eq!(map.read, [0, 1]);
    assert_eq!(map.rows, [0, 1, 2, 3]);
    assert_eq!(
        bits(&map.cells),
        [
            cell(1, 1, true, [0.0, 0.0, 75.0, 100.0]),
            cell(2, 1, false, [75.0, 0.0, 25.0, 100.0]),
            cell(3, 2, false, [0.0, 0.0, 75.0, 0.2]),
        ]
    );
    Ok(())
}

#[test]
fn a_folder_without_a_child_array_is_laid_out_but_never_pruned_open() -> TestResult {
    // `isExpandableId` asks for the child array; the treemap asks only for children.
    let store = hand(&folder(vec![
        folder_without_child_array(vec![file(10.0), file(10.0)]),
        file(5.0),
    ]))?;
    let pruned = select_prune(&store, 0, 100)?;
    assert_eq!(pruned.expanded, [0]);
    assert_eq!(pruned.rows, [0, 1, 2]);
    let map = select_treemap(&store, 0, &options(3, 0.0, 20_000))?;
    assert_eq!(map.read, [0, 1]);
    assert_eq!(map.rows, [0, 1, 2, 3, 4]);
    assert_eq!(
        bits(&map.cells),
        [
            cell(1, 1, true, [0.0, 0.0, 80.0, 100.0]),
            cell(2, 1, false, [80.0, 0.0, 20.0, 100.0]),
            cell(3, 2, false, [0.0, 0.0, 80.0, 50.0]),
            cell(4, 2, false, [0.0, 50.0, 80.0, 50.0]),
        ]
    );
    Ok(())
}

/// A store whose columns are given row by row: a malformed one, as no build makes it.
fn rows_of(
    flags: &[u16],
    size: &[f64],
    child_start: &[u32],
    child_cnt: &[u32],
) -> Result<Store, String> {
    let parent = (0..flags.len())
        .map(|id| if id == 0 { -1 } else { 0 })
        .collect();
    store_of(Columns {
        parent,
        size: size.to_vec(),
        flags: flags.to_vec(),
        container: vec![0; flags.len()],
        child_start: child_start.to_vec(),
        child_cnt: child_cnt.to_vec(),
    })
}

const FOLDER: u16 = flag::DIR | flag::HAS_CHILD_ARRAY;

#[test]
fn a_row_the_store_does_not_hold_is_refused() -> TestResult {
    let store = four_equal_folders()?;
    let past_the_rows = |outcome: Result<(), RowError>| {
        matches!(
            outcome,
            Err(RowError::NoRow {
                id: 13,
                rows: 13,
                ..
            })
        )
    };
    assert!(
        past_the_rows(select_prune(&store, 13, 10).map(|_| ())),
        "a root past the rows, pruned"
    );
    assert!(
        past_the_rows(select_treemap(&store, 13, &options(4, 0.0, 10)).map(|_| ())),
        "a root past the rows, laid out"
    );
    // A size column two rows short of the rest: the folder at row 1 can be expanded, so
    // its size is read, and the column does not hold it.
    let mut short = store_of(Columns {
        parent: vec![-1, 0, 1],
        size: vec![10.0, 10.0, 10.0],
        flags: vec![FOLDER, FOLDER, 0],
        container: vec![0, 0, 0],
        child_start: vec![1, 2, 3],
        child_cnt: vec![1, 1, 0],
    })?;
    short.size = Column::Owned(vec![10.0]);
    assert_eq!(
        select_prune(&short, 0, 10),
        Err(RowError::NoRow {
            id: 1,
            column: "size",
            rows: 1
        })
    );
    Ok(())
}

#[test]
fn a_child_range_past_the_rows_is_refused_where_the_javascript_would_read_it() -> TestResult {
    // The root's two children said to start at row 1 of a store of two rows.
    let broken = rows_of(&[FOLDER, FOLDER], &[10.0, 10.0], &[1, 2], &[2, 0])?;
    let at_the_root = Err(RowError::ChildrenPastRows {
        id: 0,
        start: 1,
        count: 2,
        rows: 2,
    });
    assert_eq!(select_prune(&broken, 0, 10).map(|_| ()), at_the_root);
    assert_eq!(
        select_treemap(&broken, 0, &options(4, 0.0, 10)).map(|_| ()),
        at_the_root
    );
    // A range whose end does not fit in 32 bits is past the rows too.
    let wrapped = rows_of(&[FOLDER, FOLDER], &[10.0, 10.0], &[u32::MAX, 2], &[2, 0])?;
    assert_eq!(
        select_prune(&wrapped, 0, 10).map(|_| ()),
        Err(RowError::ChildrenPastRows {
            id: 0,
            start: u32::MAX,
            count: 2,
            rows: 2
        })
    );

    // A folder (row 2, 5 bytes) whose three children are said to lie past the rows, beside
    // a 10-byte file. `pruneStore` asks whether each child of the root can be expanded,
    // which reads the folder's range, although a budget of 2 is spent before the folder
    // would be popped: refused. The treemap reads a child's range only for a cell it
    // emits; at a cap of one cell it emits the larger file alone, never reads the
    // folder's range, and answers as the JavaScript does. At a cap of two it reads it.
    let past = rows_of(
        &[FOLDER, 0, FOLDER],
        &[15.0, 10.0, 5.0],
        &[1, 3, 5],
        &[2, 0, 3],
    )?;
    let at_the_folder = Err(RowError::ChildrenPastRows {
        id: 2,
        start: 5,
        count: 3,
        rows: 3,
    });
    assert_eq!(select_prune(&past, 0, 2).map(|_| ()), at_the_folder);
    let one = select_treemap(&past, 0, &options(4, 0.0, 1))?;
    assert_eq!(one.read, [0]);
    assert_eq!(one.rows, [0, 1, 2]);
    assert_eq!(
        bits(&one.cells),
        [cell(1, 1, false, [0.0, 0.0, 66.666_666_666_666_66, 100.0])]
    );
    assert_eq!(
        select_treemap(&past, 0, &options(4, 0.0, 2)).map(|_| ()),
        at_the_folder
    );
    Ok(())
}

#[test]
fn only_the_seven_container_kinds_open_a_file() -> TestResult {
    // `container()` answers a kind for the bytes 1–7 (`CONTAINER_KINDS[k - 1]`) and
    // undefined for any other, so a file whose byte is 8 opens for neither function,
    // child array and children notwithstanding, while kind 7 (docker) does. A container
    // keeps its own size: its children are not added into it.
    let store = hand(&folder(vec![
        opened_container(8, 30.0, vec![file(10.0), file(10.0)]),
        opened_container(7, 20.0, vec![file(5.0), file(5.0)]),
        file(5.0),
    ]))?;
    let pruned = select_prune(&store, 0, 100)?;
    assert_eq!(pruned.expanded, [0, 2]);
    assert_eq!(pruned.rows, [0, 1, 2, 3, 6, 7]);
    let map = select_treemap(&store, 0, &options(3, 0.0, 20_000))?;
    assert_eq!(map.read, [0, 2]);
    assert_eq!(map.rows, [0, 1, 2, 3, 6, 7]);
    let (left, right) = (54.545_454_545_454_54, 77.272_727_272_727_28);
    assert_eq!(
        bits(&map.cells),
        [
            cell(1, 1, false, [0.0, 0.0, left, 100.0]),
            cell(
                2,
                1,
                true,
                [left, 0.0, 45.454_545_454_545_47, 79.999_999_999_999_99]
            ),
            cell(
                3,
                1,
                false,
                [
                    left,
                    79.999_999_999_999_99,
                    45.454_545_454_545_425,
                    20.000_000_000_000_014
                ]
            ),
            cell(
                6,
                2,
                false,
                [left, 0.0, 22.727_272_727_272_734, 39.999_999_999_999_99]
            ),
            cell(
                7,
                2,
                false,
                [right, 0.0, 22.727_272_727_272_734, 39.999_999_999_999_99]
            ),
        ]
    );
    let inside = select_treemap(&store, 1, &options(3, 0.0, 20_000))?;
    assert_eq!(inside.read, []);
    assert_eq!(inside.rows, [1]);
    Ok(())
}

#[test]
fn a_size_that_is_not_a_number_is_compared_as_the_javascript_compares_it() -> TestResult {
    // No scan gives a size that is not a number, but a store can hold one, and every
    // comparison with it is false in both languages: the folder of a NaN file totals NaN,
    // its NaN parent is still read (NaN is not at most zero), the NaN child is dropped (NaN
    // is not above zero), the heap lets a sized folder climb past it, and the rectangles
    // of a NaN total are NaN wide and 0 tall, so none is emitted.
    let store = hand(&folder(vec![
        folder(vec![file(10.0), file(f64::NAN)]),
        file(5.0),
        folder(vec![file(3.0)]),
    ]))?;
    let all = select_prune(&store, 0, 100)?;
    assert_eq!(all.expanded, [0, 3, 1]);
    assert_eq!(all.rows, [0, 1, 2, 3, 6, 4, 5]);
    let map = select_treemap(&store, 0, &options(3, 0.0, 20_000))?;
    assert_eq!(map.read, [0]);
    assert_eq!(map.rows, [0, 2, 3]);
    assert_eq!(bits(&map.cells), []);
    let inside = select_treemap(&store, 3, &options(3, 0.0, 20_000))?;
    assert_eq!(inside.read, [3]);
    assert_eq!(
        bits(&inside.cells),
        [cell(6, 1, false, [0.0, 0.0, 100.0, 100.0])]
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// The oracle's trees, grown here as `selectOracle.ts` grows them
// ---------------------------------------------------------------------------

/// `makeRng` (tests/fixtures/storeFuzz.ts): mulberry32, as JavaScript's 32-bit integer
/// operations compute it.
struct Mulberry32(u32);

impl Mulberry32 {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x6D2B_79F5);
        let a = self.0;
        let mut t = (a ^ (a >> 15)).wrapping_mul(a | 1);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 0x3D)) ^ t;
        t ^ (t >> 14)
    }

    /// `Math.floor(rng() * k)`: `rng()` is the draw over 2^32, and below 2^21 the product
    /// is exact in a double, so the floor is the integer `(draw × k) >> 32`, which is
    /// below `k` and so fits.
    fn draw(&mut self, k: u32) -> u32 {
        assert!(k <= 1 << 21, "a draw of {k} is not exact in a double");
        let wide = (u64::from(self.next()) * u64::from(k)) >> 32;
        u32::try_from(wide).unwrap_or(u32::MAX)
    }
}

/// A `tree` line's shape (see `Shape` in selectOracle.ts).
#[derive(Debug)]
struct Shape {
    seed: u32,
    nodes: usize,
    dir_pct: u32,
    chain_pct: u32,
    wide_pct: u32,
    wide_min: u32,
    wide_span: u32,
    small_max: u32,
    zero_pct: u32,
    palette_pct: u32,
    palette_len: u32,
    container_pct: u32,
    open_pct: u32,
    odd_pct: u32,
}

/// `PALETTE` in selectOracle.ts.
const PALETTE: [f64; 9] = [
    1.0,
    2.0,
    7.0,
    4095.0,
    4096.0,
    4097.0,
    10240.0,
    65536.0,
    1_048_576.0,
];
/// `SPREAD` in selectOracle.ts.
const SPREAD: u32 = 1 << 20;
/// `EXTRA_FLAGS` in selectOracle.ts.
const EXTRA_FLAGS: [u16; 9] = [
    0,
    0,
    flag::HIDDEN,
    flag::HARDLINK_DUP,
    flag::SYMLINK,
    flag::CLOUD_PLACEHOLDER,
    flag::GIT_REPO,
    flag::VIRTUAL,
    flag::HAS_ACCESSED,
];

/// `PALETTE[value % paletteLen]`, refused where the JavaScript would read past the palette.
fn palette(value: u32, palette_len: u32) -> Result<f64, String> {
    value
        .checked_rem(palette_len)
        .and_then(|at| usize::try_from(at).ok())
        .and_then(|at| PALETTE.get(at).copied())
        .ok_or_else(|| format!("paletteLen {palette_len} is not within the palette"))
}

fn pick<T: Copy>(table: &[T], index: u32) -> Result<T, String> {
    let len = u32::try_from(table.len()).map_err(|_| "a table too long")?;
    let at = usize::try_from(index % len.max(1)).map_err(|_| "an index too large")?;
    table
        .get(at)
        .copied()
        .ok_or_else(|| "an empty table".to_owned())
}

/// `generate` in selectOracle.ts, draw for draw: two draws per listing, five per child.
fn generate(shape: &Shape) -> Result<Columns, String> {
    let mut rng = Mulberry32(shape.seed);
    let mut c = Columns {
        parent: vec![-1],
        size: vec![0.0],
        flags: vec![flag::DIR | flag::HAS_CHILD_ARRAY],
        container: vec![0],
        ..Columns::default()
    };
    let mut listed = vec![true];
    let mut ahead = 1_usize;
    let mut id = 0_usize;
    while id < c.parent.len() {
        let start = c.parent.len();
        c.child_start
            .push(u32::try_from(start).map_err(|_| "too many rows")?);
        if at(&listed, id, "the listed rows")? {
            ahead = ahead
                .checked_sub(1)
                .ok_or("a listed row the generator did not count")?;
            let form = rng.draw(100);
            let spread = rng.draw(SPREAD);
            let chain = form < shape.chain_pct;
            let mut count = if chain {
                1
            } else if form < shape.chain_pct + shape.wide_pct {
                shape.wide_min + spread % (shape.wide_span + 1)
            } else {
                spread % (shape.small_max + 1)
            } as usize;
            let rescue = ahead == 0;
            if rescue {
                count = count.max(1);
            }
            // `Math.min(count, nodes - parent.length)`: never below zero children.
            count = count.min(shape.nodes.saturating_sub(c.parent.len()));
            let this = i32::try_from(id).map_err(|_| "too many rows")?;
            for k in 0..count {
                let kind = rng.draw(100);
                let sized = rng.draw(100);
                let value = rng.draw(SPREAD);
                let odd = rng.draw(100);
                let boxed = rng.draw(100);
                let mut bits = pick(&EXTRA_FLAGS, value >> 4)?;
                let mut bytes = 0.0;
                let mut kind_of_box = 0_u8;
                let mut lists = false;
                if chain || (rescue && k == 0) || kind < shape.dir_pct {
                    bits |= flag::DIR;
                    if odd >= shape.odd_pct {
                        bits |= flag::HAS_CHILD_ARRAY;
                    }
                    lists = true;
                } else {
                    if sized < shape.zero_pct {
                        bytes = 0.0;
                    } else if sized < shape.zero_pct + shape.palette_pct {
                        bytes = palette(value, shape.palette_len)?;
                    } else {
                        bytes = f64::from(1 + value);
                    }
                    if boxed < shape.container_pct {
                        kind_of_box =
                            u8::try_from(1 + value % 7).map_err(|_| "a container kind")?;
                        if odd < shape.open_pct {
                            bits |= flag::HAS_CHILD_ARRAY;
                            lists = true;
                        } else if odd < shape.open_pct + shape.odd_pct {
                            lists = true;
                        }
                    } else if odd < shape.odd_pct {
                        bits |= flag::HAS_CHILD_ARRAY;
                        lists = true;
                    }
                }
                c.parent.push(this);
                c.size.push(bytes);
                c.flags.push(bits);
                c.container.push(kind_of_box);
                listed.push(lists);
                if lists {
                    ahead += 1;
                }
            }
        }
        c.child_cnt
            .push(u32::try_from(c.parent.len() - start).map_err(|_| "too many rows")?);
        id += 1;
    }
    Ok(c)
}

// ---------------------------------------------------------------------------
// The oracle's digests: FNV-1a, 32-bit, over little-endian bytes (`Digest` in
// selectOracle.ts)
// ---------------------------------------------------------------------------

struct Digest(u32);

impl Digest {
    fn new() -> Self {
        Self(0x811C_9DC5)
    }

    fn bytes(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0 ^ u32::from(b)).wrapping_mul(0x0100_0193);
        }
    }

    fn hex(&self) -> String {
        format!("{:08x}", self.0)
    }
}

fn tree_digest(c: &Columns) -> String {
    let mut d = Digest::new();
    let rows = c
        .parent
        .iter()
        .zip(&c.size)
        .zip(&c.flags)
        .zip(&c.container)
        .zip(&c.child_start)
        .zip(&c.child_cnt);
    for (((((parent, size), bits), container), start), count) in rows {
        d.bytes(&parent.to_le_bytes());
        d.bytes(&size.to_le_bytes());
        d.bytes(&bits.to_le_bytes());
        d.bytes(&container.to_le_bytes());
        d.bytes(&start.to_le_bytes());
        d.bytes(&count.to_le_bytes());
    }
    d.hex()
}

fn list_text(ids: &[u32]) -> String {
    let mut d = Digest::new();
    for id in ids {
        d.bytes(&id.to_le_bytes());
    }
    format!("{}\t{}", ids.len(), d.hex())
}

fn cells_text(cells: &[TreemapCell]) -> String {
    let mut d = Digest::new();
    for c in cells {
        d.bytes(&c.id.to_le_bytes());
        d.bytes(&c.depth.to_le_bytes());
        d.bytes(&[u8::from(c.expanded)]);
        for v in [c.rect.x, c.rect.y, c.rect.w, c.rect.h] {
            d.bytes(&v.to_le_bytes());
        }
    }
    format!("{}\t{}", cells.len(), d.hex())
}

// ---------------------------------------------------------------------------
// Holding the ports to the oracle
// ---------------------------------------------------------------------------

fn oracle() -> Result<String, String> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("select-oracle.tsv");
    std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))
}

fn field<T: std::str::FromStr>(fields: &[&str], index: usize, what: &str) -> Result<T, String> {
    fields
        .get(index)
        .and_then(|text| text.parse().ok())
        .ok_or_else(|| format!("the oracle's {what} is missing or malformed"))
}

fn shape_of(fields: &[&str]) -> Result<Shape, String> {
    Ok(Shape {
        seed: field(fields, 2, "seed")?,
        nodes: field(fields, 3, "nodes")?,
        dir_pct: field(fields, 4, "dirPct")?,
        chain_pct: field(fields, 5, "chainPct")?,
        wide_pct: field(fields, 6, "widePct")?,
        wide_min: field(fields, 7, "wideMin")?,
        wide_span: field(fields, 8, "wideSpan")?,
        small_max: field(fields, 9, "smallMax")?,
        zero_pct: field(fields, 10, "zeroPct")?,
        palette_pct: field(fields, 11, "palettePct")?,
        palette_len: field(fields, 12, "paletteLen")?,
        container_pct: field(fields, 13, "containerPct")?,
        open_pct: field(fields, 14, "openPct")?,
        odd_pct: field(fields, 15, "oddPct")?,
    })
}

/// A case's line as the ports answer it: the line's own settings, then the answer.
fn answer_line(store: &Store, fields: &[&str]) -> Result<String, String> {
    let root: u32 = field(fields, 1, "root")?;
    match fields.first().copied() {
        Some("prune") => {
            let max_nodes: usize = field(fields, 2, "maxNodes")?;
            let s = select_prune(store, root, max_nodes).map_err(|e| e.to_string())?;
            let head = fields.get(..3).ok_or("a short line")?.join("\t");
            Ok(format!(
                "{head}\t{}\t{}",
                list_text(&s.expanded),
                list_text(&s.rows)
            ))
        }
        Some("treemap") => {
            let opts = options(
                field(fields, 2, "maxDepth")?,
                field(fields, 3, "minSize")?,
                field(fields, 4, "maxNodes")?,
            );
            let s = select_treemap(store, root, &opts).map_err(|e| e.to_string())?;
            let head = fields.get(..5).ok_or("a short line")?.join("\t");
            Ok(format!(
                "{head}\t{}\t{}\t{}",
                list_text(&s.read),
                list_text(&s.rows),
                cells_text(&s.cells)
            ))
        }
        other => Err(format!("an oracle line of kind {other:?}")),
    }
}

/// Trees, prunes and treemaps in the oracle: a file cut short, or one that lost a case,
/// is not quietly held to less.
const ORACLE_TREES: usize = 18;
const ORACLE_PRUNES: usize = 522;
const ORACLE_TREEMAPS: usize = 3_376;

#[test]
fn the_ports_choose_the_rows_the_javascript_chooses_on_every_oracle_tree() -> TestResult {
    let text = oracle()?;
    let mut tree: Option<(String, Store)> = None;
    let (mut trees, mut prunes, mut treemaps) = (0_usize, 0_usize, 0_usize);
    let mut differences: Vec<String> = Vec::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.first() == Some(&"tree") {
            let name: String = field(&fields, 1, "tree name")?;
            let mut columns = generate(&shape_of(&fields)?)?;
            sum_sizes(&mut columns)?;
            let rows: usize = field(&fields, 16, "rows")?;
            let digest: String = field(&fields, 17, "tree digest")?;
            if (columns.parent.len(), tree_digest(&columns)) != (rows, digest.clone()) {
                return Err(format!(
                    "{name}: the generator here grew {} rows with digest {}, the oracle's {rows} rows {digest}: \
                     the two generators have drifted apart",
                    columns.parent.len(),
                    tree_digest(&columns)
                )
                .into());
            }
            tree = Some((name, store_of(columns)?));
            trees += 1;
            continue;
        }
        let (name, store) = tree.as_ref().ok_or("a case before any tree")?;
        match fields.first().copied() {
            Some("prune") => prunes += 1,
            Some("treemap") => treemaps += 1,
            _ => {}
        }
        let ours = answer_line(store, &fields)?;
        if ours != line {
            differences.push(format!(
                "{name}: the oracle's\n  {line}\nthe ports'\n  {ours}"
            ));
        }
    }
    assert!(
        differences.is_empty(),
        "{} of {} cases differ; the first three:\n{}",
        differences.len(),
        prunes + treemaps,
        differences
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
    assert_eq!(
        (trees, prunes, treemaps),
        (ORACLE_TREES, ORACLE_PRUNES, ORACLE_TREEMAPS),
        "the oracle's trees, prunes and treemaps"
    );
    Ok(())
}

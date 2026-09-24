//! The store's ids against a numbering worked out by hand from `PackedScanStore.finalize()`'s
//! rule (breadth-first by insertion order, the ingest inserting each folder's children
//! sorted by name bytes, or as listed on Windows).

use tm_store::StoreError;
use tm_store::finalize::breadth_first;

type TestResult = Result<(), StoreError>;

/// `(parent, name)` per walk index, root first; returns the walk's parent, offsets and names.
fn walk_of(nodes: &[(u32, &str)]) -> (Vec<u32>, Vec<u32>, Vec<u8>) {
    let mut parent = Vec::new();
    let mut name_off = vec![0u32];
    let mut names = Vec::new();
    for &(p, name) in nodes {
        parent.push(p);
        names.extend_from_slice(name.as_bytes());
        name_off.push(u32::try_from(names.len()).unwrap_or(u32::MAX));
    }
    (parent, name_off, names)
}

/// Twelve nodes as two walker threads interleave them: every parent before its children,
/// a folder's children scattered through the columns.
const TWELVE: [(u32, &str); 12] = [
    (0, "r"),     // 0 the root
    (0, "b"),     // 1 folder
    (0, "a"),     // 2 folder
    (0, "z.txt"), // 3
    (2, "d2"),    // 4 in a
    (1, "c"),     // 5 in b
    (2, "d1"),    // 6 folder in a
    (0, "B"),     // 7 — upper case sorts before lower case in strcmp
    (6, "y"),     // 8 in d1
    (6, "x"),     // 9 in d1
    (1, "a"),     // 10 in b
    (6, "e"),     // 11 folder in d1, empty
];

#[test]
fn sorted_children_number_breadth_first_as_finalize_does() -> TestResult {
    let (parent, name_off, names) = walk_of(&TWELVE);
    let order = breadth_first(&parent, &name_off, &names, true)?;
    // Root: B a b z.txt; a: d1 d2; b: a c; d1: e x y.
    assert_eq!(order.walk_index, [0, 7, 2, 1, 3, 6, 4, 10, 5, 11, 9, 8]);
    assert_eq!(order.parent, [-1, 0, 0, 0, 0, 2, 2, 3, 3, 5, 5, 5]);
    assert_eq!(
        order.child_start,
        [1, 5, 5, 7, 9, 9, 12, 12, 12, 12, 12, 12]
    );
    assert_eq!(order.child_cnt, [4, 0, 2, 2, 0, 3, 0, 0, 0, 0, 0, 0]);
    Ok(())
}

#[test]
fn unsorted_children_keep_the_listing_order_as_on_windows() -> TestResult {
    let (parent, name_off, names) = walk_of(&TWELVE);
    let order = breadth_first(&parent, &name_off, &names, false)?;
    assert_eq!(order.walk_index, [0, 1, 2, 3, 7, 5, 10, 4, 6, 8, 9, 11]);
    assert_eq!(order.parent, [-1, 0, 0, 0, 0, 1, 1, 2, 2, 8, 8, 8]);
    assert_eq!(order.child_start, [1, 5, 7, 9, 9, 9, 9, 9, 9, 12, 12, 12]);
    assert_eq!(order.child_cnt, [4, 2, 2, 0, 0, 0, 0, 0, 3, 0, 0, 0]);
    Ok(())
}

#[test]
fn names_equal_byte_for_byte_keep_their_column_order() -> TestResult {
    // On Linux two names that differ only in invalid bytes arrive as the same U+FFFD
    // text; the ingest's stable sort keeps them in column order, and so must the store.
    let (parent, name_off, names) = walk_of(&[
        (0, "r"),
        (0, "a\u{FFFD}"),
        (0, "a"),
        (0, "a\u{FFFD}"),
        (0, "A"),
    ]);
    let order = breadth_first(&parent, &name_off, &names, true)?;
    assert_eq!(order.walk_index, [0, 4, 2, 1, 3]);
    Ok(())
}

#[test]
fn many_equal_names_keep_their_column_order_where_an_unstable_sort_would_not() -> TestResult {
    // Enough of them that a sort which does not promise stability moves some.
    let mut nodes: Vec<(u32, String)> = vec![(0, "r".to_owned())];
    for i in 0..300u32 {
        let name = if i % 3 == 0 {
            format!("n{:03}", 299 - i)
        } else {
            "same".to_owned()
        };
        nodes.push((0, name));
    }
    let borrowed: Vec<(u32, &str)> = nodes.iter().map(|(p, n)| (*p, n.as_str())).collect();
    let (parent, name_off, names) = walk_of(&borrowed);
    let order = breadth_first(&parent, &name_off, &names, true)?;
    let same: Vec<u32> = order
        .walk_index
        .iter()
        .copied()
        .filter(|&w| nodes.get(w as usize).is_some_and(|(_, n)| n == "same"))
        .collect();
    assert_eq!(same.len(), 200);
    assert!(
        same.windows(2).all(|w| w.first() < w.get(1)),
        "column order among equal names"
    );
    Ok(())
}

#[test]
fn a_walk_that_breaks_its_promises_is_refused() {
    let (parent, name_off, names) = walk_of(&[(0, "r"), (2, "x"), (0, "y")]);
    assert!(
        matches!(
            breadth_first(&parent, &name_off, &names, true),
            Err(StoreError::Malformed(_))
        ),
        "a parent after its child"
    );
    let (parent, name_off, names) = walk_of(&[(0, "r"), (1, "x")]);
    assert!(
        matches!(
            breadth_first(&parent, &name_off, &names, true),
            Err(StoreError::Malformed(_))
        ),
        "a node its own parent"
    );
    let (parent, name_off, names) = walk_of(&[(0, "r"), (0, "x")]);
    assert!(
        matches!(
            breadth_first(&parent, name_off.get(..2).unwrap_or_default(), &names, true),
            Err(StoreError::Malformed(_))
        ),
        "offsets for fewer nodes"
    );
    assert!(
        matches!(
            breadth_first(&[], &[0], &[], true),
            Err(StoreError::Malformed(_))
        ),
        "no root"
    );
    let (parent, _, names) = walk_of(&[(0, "r"), (0, "x"), (0, "y")]);
    assert!(
        matches!(
            breadth_first(&parent, &[0, 1, 0, 2], &names, true),
            Err(StoreError::Malformed(_))
        ),
        "offsets out of order"
    );
}

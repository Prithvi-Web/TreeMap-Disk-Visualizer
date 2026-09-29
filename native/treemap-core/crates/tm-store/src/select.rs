//! The selection ports (Phase 4 T15a; design §S.5.5): the rows of a store that the
//! JavaScript's pruned tree and treemap read, chosen here exactly as the JavaScript
//! chooses them.
//!
//! In spill mode a scan's rows are on disk, yet the app must still send the JSON the same
//! scan held in memory would: the pruned tree (the progress stream's `complete` frame,
//! `/result`, `/subtree`) and the treemap. So Rust picks the rows the JavaScript would
//! read, and the unchanged JavaScript runs over just those. A tie broken differently here
//! is a different tree on a user's screen, so each function is a port, rule for rule:
//!
//! * [`select_prune`] is `pruneStore`'s discipline (`src/services/scanStore.ts`), which
//!   `prunedExpansion` shares: `StoreSizeHeap`, whose sift rules decide ties, ported as it
//!   is rather than replaced by [`std::collections::BinaryHeap`], whose order among equal
//!   keys is its own; children pushed in child order; folders popped while fewer rows than
//!   `max_nodes` are counted; and every child of each popped folder counted, the last
//!   folder's included.
//! * [`select_treemap`] is `buildTreemapFromStore`'s (`src/utils/treemap.ts`): its
//!   breadth-first queue, its size filter, its stable sort, `squarify`'s float arithmetic
//!   operation for operation (a rectangle 0.2 across or less either way is never expanded,
//!   one with no width or no height is never emitted), and its cap on cells.
//!
//! Both read a store through [`RowSource`], which the memory [`Store`] implements here and
//! the spill reader is to implement (T14, T15b).

use std::collections::VecDeque;
use std::ops::Range;

use crate::{Store, flag};

/// What the selections read of a store, and nothing more: a row's size, its flag bits, its
/// container kind and its children. The two JavaScript functions read nothing else to
/// decide which rows they touch (names, paths and times are read only to write out what
/// was chosen), so any store that answers these four can be selected from.
///
/// A row's children are one consecutive range of ids, in child order (invariant I2 of
/// design §S.2, which every store Rust builds keeps), so `children` answers `childCount`
/// too. The stores selected from are never edited: no child is tombstoned (`removeNode` is
/// Live mode's, which the large modes turn off) and none is added after the build
/// (container expansion, likewise off), so the range is every child `childIds` would hand
/// out. A range that runs past the store's rows is an error, not a range, so a malformed
/// store fails before a selection counts rows it does not have.
pub trait RowSource {
    /// Why a read failed: a row the store does not hold, or children it names but does
    /// not hold; for a spilled store, a read of the disk as well.
    type Error;
    /// A row's size: a file's bytes, a folder's total. The selections compare these as
    /// the JavaScript compares `store.size`, so a folder must hold its total.
    fn size(&self, id: u32) -> Result<f64, Self::Error>;
    /// A row's [`flag`] bits; [`flag::DIR`] and [`flag::HAS_CHILD_ARRAY`] are the ones read.
    fn flags(&self, id: u32) -> Result<u16, Self::Error>;
    /// A row's container byte (`CONTAINER_ID`): a kind from 1 to 7, 0 for none. An opened
    /// container is laid out and expanded like a folder.
    fn container(&self, id: u32) -> Result<u8, Self::Error>;
    /// A row's children, in child order: `[childStart, childStart + childCnt)`.
    fn children(&self, id: u32) -> Result<Range<u32>, Self::Error>;
}

/// Why the memory store did not answer a read. Either is a caller's mistake (a root that
/// is no row) or a store that breaks its own shape; no store `build` or the memory sink
/// makes gives the second.
#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
pub enum RowError {
    /// A row the store does not hold: an id past the rows of the column read.
    #[error("row {id} is not in the store's {column} column, which holds {rows} rows")]
    NoRow {
        /// The row asked for.
        id: u32,
        /// The column read.
        column: &'static str,
        /// The rows that column holds.
        rows: usize,
    },
    /// A row whose children are said to run past the store's rows.
    #[error("row {id}'s {count} children from {start} run past the store's {rows} rows")]
    ChildrenPastRows {
        /// The row whose range it is.
        id: u32,
        /// The range's first child.
        start: u32,
        /// How many children it names.
        count: u32,
        /// The rows the store holds.
        rows: u32,
    },
}

/// The memory store's columns, read as they stand. A folder's size is what its column
/// holds: its total once summed (Node's `sumSizes()` over the adopted columns), 0 before,
/// so a selection is only meaningful on a summed store.
impl RowSource for Store {
    type Error = RowError;

    fn size(&self, id: u32) -> Result<f64, RowError> {
        row_of(self.size.as_slice(), id, "size")
    }

    fn flags(&self, id: u32) -> Result<u16, RowError> {
        row_of(self.flags.as_slice(), id, "flags")
    }

    fn container(&self, id: u32) -> Result<u8, RowError> {
        row_of(self.container.as_slice(), id, "container")
    }

    fn children(&self, id: u32) -> Result<Range<u32>, RowError> {
        let start = row_of(self.child_start.as_slice(), id, "childStart")?;
        let count = row_of(self.child_cnt.as_slice(), id, "childCnt")?;
        match start.checked_add(count) {
            Some(end) if end <= self.n => Ok(start..end),
            _ => Err(RowError::ChildrenPastRows {
                id,
                start,
                count,
                rows: self.n,
            }),
        }
    }
}

/// Row `id` of `column`, or the store's refusal to answer for a row it does not hold.
fn row_of<T: Copy>(column: &[T], id: u32, name: &'static str) -> Result<T, RowError> {
    usize::try_from(id)
        .ok()
        .and_then(|at| column.get(at))
        .copied()
        .ok_or(RowError::NoRow {
            id,
            column: name,
            rows: column.len(),
        })
}

// ---------------------------------------------------------------------------
// The pruned tree
// ---------------------------------------------------------------------------

/// What `pruneStore` reads of a store, from one root under one budget.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct PruneSelection {
    /// The folders it expands (gives every child to), in the order its heap pops them:
    /// `prunedExpansion`'s answer, in its set's order.
    pub expanded: Vec<u32>,
    /// The rows of the pruned tree in the order `pruneStore` makes them: the root, then
    /// each expanded folder's children in child order, folder by folder in pop order.
    /// Each row appears once, so the length is `pruneStore`'s `nodes`.
    pub rows: Vec<u32>,
}

/// A folder waiting to be expanded: its size, which is all the heap compares, its id, and
/// its children, read once when it was deferred (the store never changes between).
#[derive(Clone, Debug)]
struct Waiting {
    size: f64,
    id: u32,
    children: Range<u32>,
}

/// `StoreSizeHeap` (scanStore.ts), rule for rule: a binary max-heap in an array that
/// compares sizes and nothing else. A pushed folder climbs while its parent is smaller (an
/// equal parent stops it); a pop moves the last folder to the top and sinks it toward the
/// larger child while that child is strictly larger (the left one when the two tie). So
/// folders of one size come out in the order the array happens to hold them — for folders
/// pushed in child order and never displaced, the first, then the last back to the
/// second — which no order on (size, id) or on push order gives.
#[derive(Debug, Default)]
struct SizeHeap {
    folders: Vec<Waiting>,
}

impl SizeHeap {
    fn size_at(&self, at: usize) -> Option<f64> {
        self.folders.get(at).map(|w| w.size)
    }

    fn push(&mut self, folder: Waiting) {
        self.folders.push(folder);
        let mut at = self.folders.len() - 1;
        while at > 0 {
            let parent = (at - 1) >> 1;
            // `if (a[p].srcSize >= a[i].srcSize) break;`
            let (Some(above), Some(this)) = (self.size_at(parent), self.size_at(at)) else {
                break;
            };
            if above >= this {
                break;
            }
            self.folders.swap(parent, at);
            at = parent;
        }
    }

    fn pop(&mut self) -> Option<Waiting> {
        if self.folders.is_empty() {
            return None;
        }
        // `top = a[0]; last = a.pop(); if (a.length > 0) a[0] = last;`
        let top = self.folders.swap_remove(0);
        let mut at = 0;
        loop {
            let left = 2 * at + 1;
            let right = left + 1;
            let mut larger = at;
            // `if (l < a.length && a[l].srcSize > a[m].srcSize) m = l;`, then the same for r.
            if let (Some(l), Some(m)) = (self.size_at(left), self.size_at(larger))
                && l > m
            {
                larger = left;
            }
            if let (Some(r), Some(m)) = (self.size_at(right), self.size_at(larger))
                && r > m
            {
                larger = right;
            }
            if larger == at {
                break;
            }
            self.folders.swap(larger, at);
            at = larger;
        }
        Some(top)
    }
}

/// How many container kinds the store numbers: `CONTAINER_KINDS` in scanStore.ts, whose
/// `container()` answers a kind for the bytes 1 to 7 and `undefined` for 0 and for any
/// byte past the table.
const CONTAINER_KINDS: u8 = 7;

/// Whether the row `id`, whose flag bits are `flags`, drills in: a folder, or a container
/// (`container(id) !== undefined`; an opened one carries children).
fn opens<S: RowSource + ?Sized>(store: &S, id: u32, flags: u16) -> Result<bool, S::Error> {
    Ok(flags & flag::DIR != 0 || (1..=CONTAINER_KINDS).contains(&store.container(id)?))
}

/// `isExpandableId` (scanStore.ts): a row that drills in, with a child array that holds at
/// least one child. Answers those children, or `None` for a row that cannot be expanded,
/// reading what the JavaScript reads in its order: the flags, the container when the row
/// is no folder, then the child count.
fn expandable<S: RowSource + ?Sized>(store: &S, id: u32) -> Result<Option<Range<u32>>, S::Error> {
    let flags = store.flags(id)?;
    if !opens(store, id, flags)? || flags & flag::HAS_CHILD_ARRAY == 0 {
        return Ok(None);
    }
    let children = store.children(id)?;
    Ok((!children.is_empty()).then_some(children))
}

/// `pruneStore`'s `defer`: a row that can be expanded waits in the heap, by its size.
fn defer<S: RowSource + ?Sized>(store: &S, id: u32, heap: &mut SizeHeap) -> Result<(), S::Error> {
    if let Some(children) = expandable(store, id)? {
        heap.push(Waiting {
            size: store.size(id)?,
            id,
            children,
        });
    }
    Ok(())
}

/// The rows `pruneStore(store, root, { maxNodes: max_nodes })` reads, as it reads them
/// (see [`PruneSelection`]). The root is counted before anything is popped, so a budget of
/// 0 answers as 1 does, which is all `Math.max(1, maxNodes)` changes in the JavaScript:
/// nothing is popped under either. The last folder popped gives every child however far
/// past the budget that takes the count: a folder is shown whole or not at all.
pub fn select_prune<S: RowSource + ?Sized>(
    store: &S,
    root: u32,
    max_nodes: usize,
) -> Result<PruneSelection, S::Error> {
    let mut heap = SizeHeap::default();
    let mut expanded = Vec::new();
    let mut rows = vec![root];
    let mut nodes = 1_usize;
    defer(store, root, &mut heap)?;
    // `while (heap.size > 0 && nodes < maxNodes)`: an empty heap ends it at the pop.
    while nodes < max_nodes {
        let Some(folder) = heap.pop() else {
            break;
        };
        expanded.push(folder.id);
        nodes += folder.children.len();
        rows.extend(folder.children.clone());
        for child in folder.children {
            defer(store, child, &mut heap)?;
        }
    }
    Ok(PruneSelection { expanded, rows })
}

// ---------------------------------------------------------------------------
// The treemap
// ---------------------------------------------------------------------------

/// A rectangle in percent of the map, which is 100 × 100 (`Rect` in treemap.ts).
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct Rect {
    /// The left edge.
    pub x: f64,
    /// The top edge.
    pub y: f64,
    /// The width.
    pub w: f64,
    /// The height.
    pub h: f64,
}

/// The whole map: where the root is laid out.
const WHOLE: Rect = Rect {
    x: 0.0,
    y: 0.0,
    w: 100.0,
    h: 100.0,
};

/// `buildTreemapFromStore`'s options (`TreemapOptions` in treemap.ts). The route asks for
/// `maxDepth` 1–8 (the UI for 4), `minSize` (the UI for 4096, then 1 when that draws
/// nothing) and 20,000 cells.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct TreemapOptions {
    /// How deep cells are expanded: a cell at depth `d` is expanded only while `d` is
    /// below this.
    pub max_depth: u32,
    /// The fewest bytes a child needs to be laid out; a child of none never is.
    pub min_size: f64,
    /// The most cells emitted.
    pub max_nodes: usize,
}

/// One cell of the treemap: a `TreemapNode`'s row, depth, `expanded` and rectangle.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct TreemapCell {
    /// The row.
    pub id: u32,
    /// Its depth below the root the map is laid out from; the root's children are at 1.
    pub depth: u32,
    /// Whether its children are laid out inside it in turn, or would be were the cap not
    /// reached first.
    pub expanded: bool,
    /// Where it lies.
    pub rect: Rect,
}

/// What `buildTreemapFromStore` reads of a store, from one root with one set of options.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct TreemapSelection {
    /// The folders whose children it reads (its `childIds` calls), in the order its queue
    /// takes them: the root first, when it has any to lay out.
    pub read: Vec<u32>,
    /// The rows a store must hold to lay out this map: the root, then each read folder's
    /// children that the size filter keeps (at least `min_size` bytes, and more than
    /// none), in child order. A child the filter drops is read for its size alone and
    /// never reaches the map, so a store without it lays out the same map, as long as it
    /// keeps each folder's true child count, which the treemap also asks.
    pub rows: Vec<u32>,
    /// The cells it emits, in its order: at most `max_nodes`.
    pub cells: Vec<TreemapCell>,
}

/// A folder waiting in the treemap's queue: where it lies and how deep.
#[derive(Clone, Copy, Debug)]
struct Queued {
    id: u32,
    rect: Rect,
    depth: u32,
}

/// The rows `buildTreemapFromStore(store, root, opts)` reads and the cells it emits (see
/// [`TreemapSelection`]), breadth-first, so that when the cap is reached the shallow cells
/// have won over the deep ones.
pub fn select_treemap<S: RowSource + ?Sized>(
    store: &S,
    root: u32,
    opts: &TreemapOptions,
) -> Result<TreemapSelection, S::Error> {
    let mut map = Layout {
        store,
        opts: *opts,
        queue: VecDeque::from([Queued {
            id: root,
            rect: WHOLE,
            depth: 0,
        }]),
        chosen: TreemapSelection {
            rows: vec![root],
            ..TreemapSelection::default()
        },
    };
    // `while (queue.length > 0 && out.length < maxNodes)`: an empty queue ends it at the take.
    while map.chosen.cells.len() < opts.max_nodes {
        let Some(job) = map.queue.pop_front() else {
            break;
        };
        map.lay_out(job)?;
    }
    Ok(map.chosen)
}

/// A treemap being laid out: its queue and what it has chosen so far.
struct Layout<'a, S: ?Sized> {
    store: &'a S,
    opts: TreemapOptions,
    queue: VecDeque<Queued>,
    chosen: TreemapSelection,
}

impl<S: RowSource + ?Sized> Layout<'_, S> {
    /// One turn of `buildTreemapFromStore`'s loop: the folder `job` laid out, its children
    /// emitted as cells until the cap, and those that expand queued behind it.
    fn lay_out(&mut self, job: Queued) -> Result<(), S::Error> {
        let store = self.store;
        let flags = store.flags(job.id)?;
        if !opens(store, job.id, flags)? {
            return Ok(());
        }
        let children = store.children(job.id)?;
        if children.is_empty() {
            return Ok(());
        }
        let node_size = store.size(job.id)?;
        if node_size <= 0.0 || job.rect.w <= 0.0 || job.rect.h <= 0.0 {
            return Ok(());
        }
        self.chosen.read.push(job.id);
        let mut kept = kept_children(store, children, self.opts.min_size)?;
        self.chosen
            .rows
            .extend(kept.iter().map(|&(child, _)| child));
        // `.sort((a, b) => size(b) - size(a))`: stable, largest first. The kept sizes are
        // above zero, so the difference is a consistent comparison (two infinities compare
        // equal under both) and a stable sort by it is this one. (`if (children.length ===
        // 0) continue;` has nothing to port: no child kept is no area and no cell.)
        kept.sort_by(|a, b| b.1.total_cmp(&a.1));
        // Each child's share of the folder's own total, so what the filter dropped stays
        // empty space.
        let rect_area = job.rect.w * job.rect.h;
        let areas: Vec<f64> = kept
            .iter()
            .map(|&(_, size)| (size / node_size) * rect_area)
            .collect();
        for (&(child, _), rect) in kept.iter().zip(squarify(&areas, job.rect)) {
            if self.chosen.cells.len() >= self.opts.max_nodes {
                break;
            }
            if rect.w <= 0.0 || rect.h <= 0.0 {
                continue;
            }
            let depth = job.depth + 1;
            // Too small a rectangle is not worth subdividing.
            let expanded = opens(store, child, store.flags(child)?)?
                && depth < self.opts.max_depth
                && !store.children(child)?.is_empty()
                && rect.w > 0.2
                && rect.h > 0.2;
            self.chosen.cells.push(TreemapCell {
                id: child,
                depth,
                expanded,
                rect,
            });
            if expanded {
                self.queue.push_back(Queued {
                    id: child,
                    rect,
                    depth,
                });
            }
        }
        Ok(())
    }
}

/// The children the treemap's filter keeps (`size >= minSize && size > 0`), in child
/// order, with their sizes. The rest are read for their size alone.
fn kept_children<S: RowSource + ?Sized>(
    store: &S,
    children: Range<u32>,
    min_size: f64,
) -> Result<Vec<(u32, f64)>, S::Error> {
    let mut kept = Vec::new();
    for child in children {
        let size = store.size(child)?;
        if size >= min_size && size > 0.0 {
            kept.push((child, size));
        }
    }
    Ok(kept)
}

/// What `worstRatio` (treemap.ts) folds out of a row of areas: the sum from 0 in order,
/// and the largest and smallest as `>` and `<` against ±∞ find them. A row grown by one
/// area folds that area in last, where the JavaScript's fresh fold over the longer array
/// also takes it, so every value here is the one it computes.
#[derive(Clone, Copy, Debug)]
struct RowFold {
    sum: f64,
    max: f64,
    min: f64,
}

impl RowFold {
    const EMPTY: Self = Self {
        sum: 0.0,
        max: f64::NEG_INFINITY,
        min: f64::INFINITY,
    };

    fn with(self, area: f64) -> Self {
        Self {
            sum: self.sum + area,
            max: if area > self.max { area } else { self.max },
            min: if area < self.min { area } else { self.min },
        }
    }

    /// `worstRatio(row, side)`: the row's worst aspect ratio laid along `side`, lower
    /// being better; infinite for a row of no area or a side of no length.
    fn worst(self, side: f64) -> f64 {
        if self.sum <= 0.0 || side <= 0.0 {
            return f64::INFINITY;
        }
        let s2 = self.sum * self.sum;
        let w2 = side * side;
        js_max((w2 * self.max) / s2, s2 / (w2 * self.min))
    }
}

/// `squarify(areas, rect)` (treemap.ts; Bruls, Huizing and van Wijk's squarified layout),
/// operation for operation: rows laid along the shorter side of what remains, each grown
/// while its worst aspect ratio does not get worse. One rectangle per area, in order.
fn squarify(areas: &[f64], rect: Rect) -> Vec<Rect> {
    let mut placed = Vec::with_capacity(areas.len());
    let mut remaining = rect;
    let mut rest = areas.iter().copied().peekable();
    while let Some(first) = rest.next() {
        let side = js_min(remaining.w, remaining.h);
        let mut row = vec![first];
        let mut fold = RowFold::EMPTY.with(first);
        while let Some(&area) = rest.peek() {
            let grown = fold.with(area);
            if grown.worst(side) <= fold.worst(side) {
                fold = grown;
                row.push(area);
                rest.next();
            } else {
                break;
            }
        }
        // `rowArea` is the same fold from 0 as the row's sum.
        let thickness = if side > 0.0 { fold.sum / side } else { 0.0 };
        if remaining.w >= remaining.h {
            // A strip down the left edge; its rectangles stack top to bottom.
            let mut top = remaining.y;
            for area in row {
                let height = if thickness > 0.0 {
                    area / thickness
                } else {
                    0.0
                };
                placed.push(Rect {
                    x: remaining.x,
                    y: top,
                    w: thickness,
                    h: height,
                });
                top += height;
            }
            remaining = Rect {
                x: remaining.x + thickness,
                y: remaining.y,
                w: remaining.w - thickness,
                h: remaining.h,
            };
        } else {
            // A strip along the top edge; its rectangles run left to right.
            let mut left = remaining.x;
            for area in row {
                let width = if thickness > 0.0 {
                    area / thickness
                } else {
                    0.0
                };
                placed.push(Rect {
                    x: left,
                    y: remaining.y,
                    w: width,
                    h: thickness,
                });
                left += width;
            }
            remaining = Rect {
                x: remaining.x,
                y: remaining.y + thickness,
                w: remaining.w,
                h: remaining.h - thickness,
            };
        }
    }
    placed
}

/// JavaScript's `Math.min` of two numbers: NaN if either is, and −0 below +0.
/// (`f64::min` answers the other number for a NaN.) Two numbers neither below the other
/// are equal: the same bits, or two zeros, of which the negative one is the answer.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else if b < a || a.is_sign_positive() {
        b
    } else {
        a
    }
}

/// JavaScript's `Math.max` of two numbers: NaN if either is, and +0 above −0.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else if b > a || a.is_sign_negative() {
        b
    } else {
        a
    }
}

#[cfg(test)]
mod tests {
    use super::{js_max, js_min};

    /// Node's answers, `Object.is` telling the zeros apart: `Math.min(0, -0)` and
    /// `Math.min(-0, 0)` are −0, `Math.max(0, -0)` and `Math.max(-0, 0)` are +0, a NaN on
    /// either side is NaN, and otherwise the smaller or larger, of either sign. No scan's
    /// sizes reach most of these (every area laid out is positive, and a side is negative only
    /// once nothing more is drawn), but a port answers as what it ports does.
    #[test]
    fn min_and_max_answer_as_javascript_does_for_zeros_of_either_sign_and_for_nan() {
        let bits = f64::to_bits;
        assert_eq!(bits(js_min(0.0, -0.0)), bits(-0.0));
        assert_eq!(bits(js_min(-0.0, 0.0)), bits(-0.0));
        assert_eq!(bits(js_max(0.0, -0.0)), bits(0.0));
        assert_eq!(bits(js_max(-0.0, 0.0)), bits(0.0));
        for (a, b) in [(f64::NAN, 1.0), (1.0, f64::NAN)] {
            assert!(js_min(a, b).is_nan(), "Math.min({a}, {b})");
            assert!(js_max(a, b).is_nan(), "Math.max({a}, {b})");
        }
        for (a, b, min, max) in [
            (2.0, 3.0, 2.0, 3.0),
            (3.0, 2.0, 2.0, 3.0),
            (-1.0, -2.0, -2.0, -1.0),
            (-2.0, -1.0, -2.0, -1.0),
        ] {
            assert_eq!(bits(js_min(a, b)), bits(min), "Math.min({a}, {b})");
            assert_eq!(bits(js_max(a, b)), bits(max), "Math.max({a}, {b})");
        }
        assert_eq!(
            bits(js_min(f64::NEG_INFINITY, f64::INFINITY)),
            bits(f64::NEG_INFINITY)
        );
    }
}

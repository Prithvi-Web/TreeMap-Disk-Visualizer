//! What aggregate keeps of the tree itself (Phase 4 T12c; design §S.6.1): the β heaps and
//! the shallow keep, bounded however large the walk grows.
//!
//! * **The β heaps** hold the largest folder totals below the root and the largest file
//!   sizes. At the seal, β is the smallest value a full heap holds (none, when it is not
//!   full), and what is kept is decided by value against it, strictly: a heap's smallest
//!   value only rises, so everything above the final β is still held, whatever order the
//!   walk went in, and rows tied at β are dropped together.
//! * **The shallow keep** holds each listed folder's top children — by (size desc, then
//!   child order), the order `compactTree`'s stable sort leaves them in — down to the depth
//!   D_s. The root keeps [`ROOT_TOP`] (`saveSnapshot`'s `topEntries`), every other folder
//!   [`SHALLOW_TOP`] (the snapshot tree's 30 per folder). D_s comes from a histogram of
//!   rows per depth: each listed folder adds min(its top, its listing's length), and D_s is
//!   the deepest depth whose rows, with every shallower depth's, fit in [`SHALLOW_ROWS`];
//!   the root's list always fits. D_s only falls, and when it does the lists at the depth it
//!   left are dropped at once, so what is held never passes the cap, and the final D_s is
//!   the full tree's.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use super::position::PositionPath;

/// The folder heap's size: `R_dir + 1`, so at most `R_dir` folders are kept by β.
pub const FOLDER_HEAP: usize = 150_001;
/// The file heap's size: `R_file + 1`.
pub const FILE_HEAP: usize = 200_001;
/// The most rows the shallow keep holds.
pub const SHALLOW_ROWS: usize = 65_536;
/// How many top children each folder at depth 1 to D_s keeps.
pub const SHALLOW_TOP: usize = 32;
/// How many top children the root keeps.
pub const ROOT_TOP: usize = 100;

/// How much aggregate keeps; the defaults are the constants above. A heap size below 1
/// counts as 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeepLimits {
    /// The folder heap's size ([`FOLDER_HEAP`]).
    pub folder_heap: usize,
    /// The file heap's size ([`FILE_HEAP`]).
    pub file_heap: usize,
    /// The most rows the shallow keep holds ([`SHALLOW_ROWS`]).
    pub shallow_rows: usize,
    /// Top children kept per folder below the root ([`SHALLOW_TOP`]).
    pub shallow_top: usize,
    /// Top children the root keeps ([`ROOT_TOP`]).
    pub root_top: usize,
}

impl Default for KeepLimits {
    fn default() -> Self {
        Self {
            folder_heap: FOLDER_HEAP,
            file_heap: FILE_HEAP,
            shallow_rows: SHALLOW_ROWS,
            shallow_top: SHALLOW_TOP,
            root_top: ROOT_TOP,
        }
    }
}

/// A row as aggregate keeps it: enough to place it in the summary and to say what it holds.
#[derive(Clone, Debug)]
pub(super) struct Record {
    pub name: Box<[u8]>,
    pub position: PositionPath,
    pub depth: u32,
    pub bytes: u128,
    pub modified_at: f64,
    /// A folder's recursive file and folder counts; `None` for a file.
    pub counts: Option<(u64, u64)>,
}

/// A heap entry, ordered so the top is the smallest value (the latest place at a tie).
struct Smallest(Record);

impl Ord for Smallest {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .0
            .bytes
            .cmp(&self.0.bytes)
            .then_with(|| self.0.position.cmp(&other.0.position))
    }
}

impl PartialOrd for Smallest {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Smallest {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Smallest {}

/// One β heap: the largest values so far.
struct BetaHeap {
    capacity: usize,
    heap: BinaryHeap<Smallest>,
}

impl BetaHeap {
    fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            heap: BinaryHeap::new(),
        }
    }

    /// Whether a value would be turned away: the heap is full and it is no larger than the
    /// smallest held.
    fn turns_away(&self, bytes: u128) -> bool {
        self.heap.len() >= self.capacity && self.heap.peek().is_some_and(|min| bytes <= min.0.bytes)
    }

    /// Takes `record`, unless [`Self::turns_away`] says otherwise.
    fn offer(&mut self, record: Record) {
        if self.turns_away(record.bytes) {
            return;
        }
        if self.heap.len() >= self.capacity {
            self.heap.pop();
        }
        self.heap.push(Smallest(record));
    }

    /// β: the smallest value held, once the heap is full.
    fn threshold(&self) -> Option<u128> {
        if self.heap.len() < self.capacity {
            return None;
        }
        self.heap.peek().map(|min| min.0.bytes)
    }

    /// Every record above `beta`, or every record when there is none.
    fn above(&self, beta: Option<u128>) -> impl Iterator<Item = &Record> {
        self.heap
            .iter()
            .map(|entry| &entry.0)
            .filter(move |record| beta.is_none_or(|beta| record.bytes > beta))
    }
}

/// A child in a folder's top list.
struct Child {
    index: u32,
    record: Record,
}

/// Ordered so the top is the worst child: the smallest, then the later in child order.
struct Worst(Child);

impl Ord for Worst {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .0
            .record
            .bytes
            .cmp(&self.0.record.bytes)
            .then_with(|| self.0.index.cmp(&other.0.index))
    }
}

impl PartialOrd for Worst {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Worst {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Worst {}

/// An open folder's top children so far.
struct TopList {
    depth: u32,
    top: usize,
    heap: BinaryHeap<Worst>,
}

impl TopList {
    /// Whether the child at `index` with `bytes` would enter the list.
    fn wants(&self, index: u32, bytes: u128) -> bool {
        if self.heap.len() < self.top {
            return true;
        }
        self.heap.peek().is_some_and(|worst| {
            let worst = &worst.0;
            match bytes.cmp(&worst.record.bytes) {
                Ordering::Greater => true,
                Ordering::Less => false,
                Ordering::Equal => index < worst.index,
            }
        })
    }

    /// Takes the child, dropping the worst if the list is full; answers whether the list
    /// grew.
    fn take(&mut self, index: u32, record: Record) -> bool {
        let full = self.heap.len() >= self.top;
        if full {
            self.heap.pop();
        }
        self.heap.push(Worst(Child { index, record }));
        !full
    }
}

/// The shallow keep.
struct Shallow {
    limits: KeepLimits,
    /// The deepest depth whose lists are kept: none until the cap is first passed.
    limit: Option<u32>,
    /// Rows by depth, within the limit.
    rows: Vec<usize>,
    /// Their sum.
    total: usize,
    /// Open folders' lists, by the walk's id.
    open: HashMap<u32, TopList>,
    /// Closed folders' lists, by depth, then by the folder's position.
    closed: Vec<HashMap<PositionPath, Vec<Record>>>,
    /// Records held in every list.
    held: usize,
}

impl Shallow {
    fn new(limits: KeepLimits) -> Self {
        Self {
            limits,
            limit: None,
            rows: Vec::new(),
            total: 0,
            open: HashMap::new(),
            closed: Vec::new(),
            held: 0,
        }
    }

    fn top(&self, depth: u32) -> usize {
        if depth == 0 {
            self.limits.root_top
        } else {
            self.limits.shallow_top
        }
    }

    /// D_s as it stands: the limit, or the deepest depth with a list.
    fn depth(&self) -> u32 {
        self.limit
            .unwrap_or_else(|| u32::try_from(self.rows.len().saturating_sub(1)).unwrap_or(u32::MAX))
    }

    /// Folder `folder`, at `depth`, has been listed with `len` children.
    fn listed(&mut self, folder: u32, depth: u32, len: u32) -> Result<(), String> {
        if self.limit.is_some_and(|limit| depth > limit) {
            return Ok(());
        }
        let top = self.top(depth);
        let adds = top.min(usize::try_from(len).unwrap_or(usize::MAX));
        if adds == 0 {
            return Ok(());
        }
        let at = usize::try_from(depth).map_err(|e| e.to_string())?;
        if self.rows.len() <= at {
            self.rows.resize(at + 1, 0);
        }
        let slot = self.rows.get_mut(at).ok_or("a depth's rows vanished")?;
        *slot = slot.saturating_add(adds);
        self.total = self.total.saturating_add(adds);
        self.open.insert(
            folder,
            TopList {
                depth,
                top,
                heap: BinaryHeap::with_capacity(adds),
            },
        );
        while self.total > self.limits.shallow_rows {
            let deepest = self.depth();
            if deepest == 0 {
                break;
            }
            self.leave(deepest)?;
            self.limit = Some(deepest - 1);
        }
        Ok(())
    }

    /// D_s leaves `depth`: its rows stop counting, and its lists are dropped.
    fn leave(&mut self, depth: u32) -> Result<(), String> {
        let at = usize::try_from(depth).map_err(|e| e.to_string())?;
        if let Some(slot) = self.rows.get_mut(at) {
            self.total = self.total.saturating_sub(*slot);
            *slot = 0;
        }
        let mut dropped = 0;
        self.open.retain(|_, list| {
            let stays = list.depth != depth;
            if !stays {
                dropped += list.heap.len();
            }
            stays
        });
        if let Some(lists) = self.closed.get_mut(at) {
            dropped += lists.values().map(Vec::len).sum::<usize>();
            lists.clear();
        }
        self.held = self.held.saturating_sub(dropped);
        Ok(())
    }

    /// Whether open folder `folder` wants its child at `index` with `bytes`.
    fn wants(&self, folder: u32, index: u32, bytes: u128) -> bool {
        self.open
            .get(&folder)
            .is_some_and(|list| list.wants(index, bytes))
    }

    fn take(&mut self, folder: u32, index: u32, record: Record) {
        if let Some(list) = self.open.get_mut(&folder)
            && list.take(index, record)
        {
            self.held = self.held.saturating_add(1);
        }
    }

    /// Folder `folder` has closed at `position`: its list, if it has one, is final.
    fn closed(&mut self, folder: u32, position: &PositionPath) -> Result<(), String> {
        let Some(list) = self.open.remove(&folder) else {
            return Ok(());
        };
        let at = usize::try_from(list.depth).map_err(|e| e.to_string())?;
        if self.closed.len() <= at {
            self.closed.resize_with(at + 1, HashMap::new);
        }
        let lists = self.closed.get_mut(at).ok_or("a depth's lists vanished")?;
        let records = list.heap.into_iter().map(|worst| worst.0.record).collect();
        lists.insert(position.clone(), records);
        Ok(())
    }

    /// Closed folder `position`'s top children, at `depth`.
    fn list(&self, depth: u32, position: &PositionPath) -> Option<&Vec<Record>> {
        let at = usize::try_from(depth).ok()?;
        self.closed.get(at)?.get(position)
    }
}

/// Everything aggregate keeps of the tree while the walk goes.
pub(super) struct Keep {
    limits: KeepLimits,
    folders: BetaHeap,
    files: BetaHeap,
    shallow: Shallow,
}

/// What the seal reads from [`Keep`]: what it holds.
pub(super) struct Held<'a> {
    /// β_d: none when the folder heap is not full.
    pub folder_threshold: Option<u128>,
    /// β_f: likewise.
    pub file_threshold: Option<u128>,
    /// D_s.
    pub shallow_depth: u32,
    /// Every folder above β_d, and every file above both.
    pub by_beta: Vec<&'a Record>,
    keep: &'a Keep,
}

impl Held<'_> {
    /// Closed folder `position`'s top children, if it is at depth D_s or above.
    pub fn top_children(&self, depth: u32, position: &PositionPath) -> &[Record] {
        if depth > self.shallow_depth {
            return &[];
        }
        self.keep
            .shallow
            .list(depth, position)
            .map_or(&[], Vec::as_slice)
    }
}

impl Keep {
    pub(super) fn new(limits: KeepLimits) -> Self {
        Self {
            limits,
            folders: BetaHeap::new(limits.folder_heap),
            files: BetaHeap::new(limits.file_heap),
            shallow: Shallow::new(limits),
        }
    }

    pub(super) fn clear(&mut self) {
        *self = Self::new(self.limits);
    }

    /// Records held by the shallow keep.
    pub(super) fn shallow_rows_held(&self) -> usize {
        self.shallow.held
    }

    /// Folder `folder`, at `depth`, has been listed with `len` children.
    pub(super) fn listed(&mut self, folder: u32, depth: u32, len: u32) -> Result<(), String> {
        self.shallow.listed(folder, depth, len)
    }

    /// A child of open folder `parent`, at `index` among its children: a file at its
    /// block, or a folder as it closes. `record` is made only if something takes it.
    pub(super) fn child(
        &mut self,
        parent: u32,
        index: u32,
        bytes: u128,
        is_folder: bool,
        record: impl FnOnce() -> Record,
    ) {
        let heap = if is_folder {
            &mut self.folders
        } else {
            &mut self.files
        };
        let to_heap = !heap.turns_away(bytes);
        let to_list = self.shallow.wants(parent, index, bytes);
        if !to_heap && !to_list {
            return;
        }
        let record = record();
        if to_heap {
            heap.offer(record.clone());
        }
        if to_list {
            self.shallow.take(parent, index, record);
        }
    }

    /// Folder `folder` has closed at `position`.
    pub(super) fn closed(&mut self, folder: u32, position: &PositionPath) -> Result<(), String> {
        self.shallow.closed(folder, position)
    }

    /// What the seal reads.
    pub(super) fn held(&self) -> Held<'_> {
        let folder_threshold = self.folders.threshold();
        let file_threshold = self.files.threshold();
        let file_beta = match (folder_threshold, file_threshold) {
            (Some(d), Some(f)) => Some(d.max(f)),
            (d, f) => d.or(f),
        };
        let by_beta = self
            .folders
            .above(folder_threshold)
            .chain(self.files.above(file_beta))
            .collect();
        Held {
            folder_threshold,
            file_threshold,
            shallow_depth: self.shallow.depth(),
            by_beta,
            keep: self,
        }
    }
}

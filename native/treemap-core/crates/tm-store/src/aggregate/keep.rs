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
//!
//! **Held compactly (T12e; §S.3's budget).** A heap row keeps its position path and name in
//! one allocation, a file row no counts, and each heap is a binary heap of slots that never
//! move while held — so a hard-link family's entry can be found and replaced (T12d) with no
//! tree node per row. A top list's child keeps its index, not its position. Rows are read
//! back as [`Record`]s only at the seal.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use super::links::Family;
use super::position::{PositionPath, depth_of};

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
/// The walk's queue limit in the sink modes (P4-13), which bounds the open frontier that
/// §S.3's budget counts.
pub const AGGREGATE_Q_MAX: usize = 4_096;

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

/// A row as aggregate hands it in, and as the seal reads it back.
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

/// A held row's position path and name, in one allocation.
#[derive(Debug, Default)]
struct Place {
    bytes: Box<[u8]>,
    split: u32,
}

impl Place {
    fn new(position: &PositionPath, name: &[u8]) -> Self {
        let path = position.as_bytes();
        let mut bytes = Vec::with_capacity(path.len() + name.len());
        bytes.extend_from_slice(path);
        bytes.extend_from_slice(name);
        Self {
            bytes: bytes.into_boxed_slice(),
            split: u32::try_from(path.len()).unwrap_or(u32::MAX),
        }
    }

    fn split(&self) -> usize {
        usize::try_from(self.split).unwrap_or(usize::MAX)
    }

    fn position(&self) -> &[u8] {
        self.bytes.get(..self.split()).unwrap_or_default()
    }

    fn name(&self) -> &[u8] {
        self.bytes.get(self.split()..).unwrap_or_default()
    }

    fn record(&self, bytes: u128, modified_at: f64, counts: Option<(u64, u64)>) -> Record {
        Record {
            name: self.name().into(),
            position: PositionPath::from_bytes(self.position()),
            depth: depth_of(self.position()),
            bytes,
            modified_at,
            counts,
        }
    }
}

/// A file the β heap holds.
#[derive(Debug, Default)]
struct HeldFile {
    place: Place,
    bytes: u64,
    modified_at: f64,
}

/// A folder the β heap holds.
#[derive(Debug, Default)]
struct HeldFolder {
    place: Place,
    bytes: u128,
    files: u64,
    folders: u64,
    modified_at: f64,
}

/// A row a slot heap holds.
trait Row: Default {
    fn weight(&self) -> u128;
    fn of(record: &Record) -> Self;
    fn record(&self) -> Record;
}

impl Row for HeldFile {
    fn weight(&self) -> u128 {
        u128::from(self.bytes)
    }

    fn of(record: &Record) -> Self {
        Self {
            place: Place::new(&record.position, &record.name),
            bytes: u64::try_from(record.bytes).unwrap_or(u64::MAX),
            modified_at: record.modified_at,
        }
    }

    fn record(&self) -> Record {
        self.place
            .record(u128::from(self.bytes), self.modified_at, None)
    }
}

impl Row for HeldFolder {
    fn weight(&self) -> u128 {
        self.bytes
    }

    fn of(record: &Record) -> Self {
        let (files, folders) = record.counts.unwrap_or_default();
        Self {
            place: Place::new(&record.position, &record.name),
            bytes: record.bytes,
            files,
            folders,
            modified_at: record.modified_at,
        }
    }

    fn record(&self) -> Record {
        self.place.record(
            self.bytes,
            self.modified_at,
            Some((self.files, self.folders)),
        )
    }
}

/// How many rows a chunk of a slot heap's store holds.
const CHUNK: usize = 4_096;

/// Rows in chunks of fixed room, so the store never copies itself to grow, and holds at
/// most one chunk it has not filled.
struct Chunks<R> {
    chunks: Vec<Vec<R>>,
    len: usize,
}

impl<R> Chunks<R> {
    fn new() -> Self {
        Self {
            chunks: Vec::new(),
            len: 0,
        }
    }

    fn len(&self) -> usize {
        self.len
    }

    fn get(&self, at: usize) -> Option<&R> {
        self.chunks.get(at / CHUNK)?.get(at % CHUNK)
    }

    fn get_mut(&mut self, at: usize) -> Option<&mut R> {
        self.chunks.get_mut(at / CHUNK)?.get_mut(at % CHUNK)
    }

    /// Appends `row`; a new chunk has room for no more than `limit` rows in all.
    fn push(&mut self, row: R, limit: usize) {
        if self.chunks.last().is_none_or(|chunk| chunk.len() >= CHUNK) {
            let room = CHUNK.min(limit.saturating_sub(self.len).max(1));
            self.chunks.push(Vec::with_capacity(room));
        }
        if let Some(chunk) = self.chunks.last_mut() {
            chunk.push(row);
            self.len += 1;
        }
    }
}

/// Makes room in `vec` for one more, doubling as it grows but never past `limit`, so a heap's
/// index holds no more room than the heap can fill.
fn room_for_one<T>(vec: &mut Vec<T>, limit: usize) {
    if vec.len() == vec.capacity() {
        let more = vec
            .len()
            .max(16)
            .min(limit.saturating_sub(vec.len()))
            .max(1);
        vec.reserve_exact(more);
    }
}

/// One β heap: the largest values so far in a binary heap of slots, the smallest first. A
/// row keeps its slot while it is held, and a hard-link family's entry is found by its slot.
struct SlotHeap<R> {
    capacity: usize,
    rows: Chunks<R>,
    free: Vec<u32>,
    /// Slots in heap order, the lightest first.
    order: Vec<u32>,
    /// Each slot's place in `order`.
    at: Vec<u32>,
    families: HashMap<Family, u32>,
    family_of: HashMap<u32, Family>,
}

fn index(slot: u32) -> usize {
    usize::try_from(slot).unwrap_or(usize::MAX)
}

impl<R: Row> SlotHeap<R> {
    fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            rows: Chunks::new(),
            free: Vec::new(),
            order: Vec::new(),
            at: Vec::new(),
            families: HashMap::new(),
            family_of: HashMap::new(),
        }
    }

    fn len(&self) -> usize {
        self.order.len()
    }

    /// The weight of the row at `place` in heap order.
    fn weight_at(&self, place: usize) -> u128 {
        self.order
            .get(place)
            .and_then(|&slot| self.rows.get(index(slot)))
            .map_or(0, Row::weight)
    }

    /// Whether a value would be turned away: the heap is full and it is no larger than the
    /// smallest held.
    fn turns_away(&self, weight: u128) -> bool {
        self.len() >= self.capacity && !self.order.is_empty() && weight <= self.weight_at(0)
    }

    /// Whether `family` has an entry.
    fn holds(&self, family: &Family) -> bool {
        self.families.contains_key(family)
    }

    /// Takes `row`, unless [`Self::turns_away`] says otherwise; a family's first row is its
    /// entry.
    fn offer(&mut self, row: R, family: Option<Family>) {
        if self.turns_away(row.weight()) {
            return;
        }
        if self.len() >= self.capacity {
            self.pop_lightest();
        }
        self.push(row, family);
    }

    fn push(&mut self, row: R, family: Option<Family>) {
        let slot = if let Some(slot) = self.free.pop() {
            if let Some(cell) = self.rows.get_mut(index(slot)) {
                *cell = row;
            }
            slot
        } else {
            let slot = u32::try_from(self.rows.len()).unwrap_or(u32::MAX);
            self.rows.push(row, self.capacity);
            room_for_one(&mut self.at, self.capacity);
            self.at.push(0);
            slot
        };
        let place = self.order.len();
        room_for_one(&mut self.order, self.capacity);
        self.order.push(slot);
        self.set_at(slot, place);
        if let Some(family) = family {
            self.families.insert(family, slot);
            self.family_of.insert(slot, family);
        }
        self.sift_up(place);
    }

    fn pop_lightest(&mut self) {
        let Some(&slot) = self.order.first() else {
            return;
        };
        self.remove_place(0);
        if let Some(cell) = self.rows.get_mut(index(slot)) {
            // Frees the row's own allocation now, not when its slot is next used.
            *cell = R::default();
        }
        self.free.push(slot);
        if let Some(family) = self.family_of.remove(&slot) {
            self.families.remove(&family);
        }
    }

    fn remove_place(&mut self, place: usize) {
        let Some(last) = self.order.len().checked_sub(1) else {
            return;
        };
        self.swap(place, last);
        self.order.pop();
        if place < self.order.len() {
            self.sift_down(place);
            self.sift_up(place);
        }
    }

    /// Puts `row` in `slot`, in place of what it held, which it answers.
    fn replace(&mut self, slot: u32, row: R) -> Option<R> {
        let cell = self.rows.get_mut(index(slot))?;
        let old = std::mem::replace(cell, row);
        let place = index(*self.at.get(index(slot))?);
        self.sift_down(place);
        self.sift_up(place);
        Some(old)
    }

    fn set_at(&mut self, slot: u32, place: usize) {
        if let Some(cell) = self.at.get_mut(index(slot)) {
            *cell = u32::try_from(place).unwrap_or(u32::MAX);
        }
    }

    fn swap(&mut self, a: usize, b: usize) {
        if a == b || a >= self.order.len() || b >= self.order.len() {
            return;
        }
        self.order.swap(a, b);
        for place in [a, b] {
            if let Some(&slot) = self.order.get(place) {
                self.set_at(slot, place);
            }
        }
    }

    fn sift_up(&mut self, mut place: usize) {
        while place > 0 {
            let parent = (place - 1) / 2;
            if self.weight_at(place) >= self.weight_at(parent) {
                break;
            }
            self.swap(place, parent);
            place = parent;
        }
    }

    fn sift_down(&mut self, mut place: usize) {
        loop {
            let mut lightest = place;
            for child in [2 * place + 1, 2 * place + 2] {
                if child < self.order.len() && self.weight_at(child) < self.weight_at(lightest) {
                    lightest = child;
                }
            }
            if lightest == place {
                break;
            }
            self.swap(place, lightest);
            place = lightest;
        }
    }

    /// β: the smallest value held, once the heap is full.
    fn threshold(&self) -> Option<u128> {
        (self.len() >= self.capacity && !self.order.is_empty()).then(|| self.weight_at(0))
    }

    /// Every row above `beta`, or every row when there is none.
    fn above(&self, beta: Option<u128>) -> impl Iterator<Item = &R> {
        self.order
            .iter()
            .filter_map(|&slot| self.rows.get(index(slot)))
            .filter(move |row| beta.is_none_or(|beta| row.weight() > beta))
    }
}

impl SlotHeap<HeldFile> {
    /// Another name of `family`, whose entry is held: the earlier (depth, position) keeps
    /// the entry and its own bytes, and the other is offered at 0 bytes.
    fn merge(&mut self, family: Family, member: HeldFile) {
        let Some(&slot) = self.families.get(&family) else {
            return;
        };
        let Some(holder) = self.rows.get(index(slot)) else {
            return;
        };
        let (held, offered) = (holder.place.position(), member.place.position());
        if (depth_of(held), held) <= (depth_of(offered), offered) {
            self.offer(HeldFile { bytes: 0, ..member }, None);
            return;
        }
        if let Some(displaced) = self.replace(slot, member) {
            self.offer(
                HeldFile {
                    bytes: 0,
                    ..displaced
                },
                None,
            );
        }
    }
}

/// A child in a folder's top list: its index among the folder's children, name, weight and
/// facts. Its position is the folder's and its index, made again at the seal.
#[derive(Debug)]
struct Child {
    bytes: u128,
    name: Box<[u8]>,
    modified_at: f64,
    files: u64,
    folders: u64,
    index: u32,
    folder: bool,
}

impl Child {
    fn of(index: u32, record: &Record) -> Self {
        let (files, folders) = record.counts.unwrap_or_default();
        Self {
            bytes: record.bytes,
            name: record.name.clone(),
            modified_at: record.modified_at,
            files,
            folders,
            index,
            folder: record.counts.is_some(),
        }
    }

    /// Its record, below the folder at `parent` and `depth`.
    fn record(&self, parent: &PositionPath, depth: u32) -> Record {
        Record {
            name: self.name.clone(),
            position: parent.child(self.index),
            depth: depth.saturating_add(1),
            bytes: self.bytes,
            modified_at: self.modified_at,
            counts: self.folder.then_some((self.files, self.folders)),
        }
    }
}

/// Ordered so the top is the worst child: the smallest, then the later in child order.
struct Worst(Child);

impl Ord for Worst {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .0
            .bytes
            .cmp(&self.0.bytes)
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
    /// Whether its listing holds more children than it keeps.
    cut: bool,
    heap: BinaryHeap<Worst>,
}

/// A closed folder's top children, and whether its listing held more.
struct TopChildren {
    children: Vec<Child>,
    cut: bool,
}

impl TopList {
    /// Whether the child at `index` with `bytes` would enter the list.
    fn wants(&self, index: u32, bytes: u128) -> bool {
        if self.heap.len() < self.top {
            return true;
        }
        self.heap.peek().is_some_and(|worst| {
            let worst = &worst.0;
            match bytes.cmp(&worst.bytes) {
                Ordering::Greater => true,
                Ordering::Less => false,
                Ordering::Equal => index < worst.index,
            }
        })
    }

    /// Takes the child, dropping the worst if the list is full; answers whether the list
    /// grew.
    fn take(&mut self, child: Child) -> bool {
        let full = self.heap.len() >= self.top;
        if full {
            self.heap.pop();
        }
        self.heap.push(Worst(child));
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
    closed: Vec<HashMap<PositionPath, TopChildren>>,
    /// Children held in every list.
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
                cut: usize::try_from(len).unwrap_or(usize::MAX) > top,
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
            dropped += lists
                .values()
                .map(|list| list.children.len())
                .sum::<usize>();
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

    fn take(&mut self, folder: u32, child: Child) {
        if let Some(list) = self.open.get_mut(&folder)
            && list.take(child)
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
        let children = list.heap.into_iter().map(|worst| worst.0).collect();
        lists.insert(
            position.clone(),
            TopChildren {
                children,
                cut: list.cut,
            },
        );
        Ok(())
    }

    /// Closed folder `position`'s top children, at `depth`.
    fn list(&self, depth: u32, position: &PositionPath) -> Option<&TopChildren> {
        let at = usize::try_from(depth).ok()?;
        self.closed.get(at)?.get(position)
    }
}

/// What a child offered to [`Keep::child`] is.
#[derive(Clone, Copy)]
pub(super) enum ChildKind {
    Folder,
    /// A file, with its hard-link family when its name is keyed.
    File {
        family: Option<Family>,
    },
}

/// Everything aggregate keeps of the tree while the walk goes.
pub(super) struct Keep {
    limits: KeepLimits,
    folders: SlotHeap<HeldFolder>,
    files: SlotHeap<HeldFile>,
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
    pub by_beta: Vec<Record>,
    keep: &'a Keep,
}

impl Held<'_> {
    /// Closed folder `position`'s top children, if it is at depth D_s or above, and whether
    /// its listing held more.
    pub fn top_children(&self, depth: u32, position: &PositionPath) -> Option<(Vec<Record>, bool)> {
        if depth > self.shallow_depth {
            return None;
        }
        let list = self.keep.shallow.list(depth, position)?;
        let children = list
            .children
            .iter()
            .map(|child| child.record(position, depth))
            .collect();
        Some((children, list.cut))
    }
}

impl Keep {
    pub(super) fn new(limits: KeepLimits) -> Self {
        Self {
            limits,
            folders: SlotHeap::new(limits.folder_heap),
            files: SlotHeap::new(limits.file_heap),
            shallow: Shallow::new(limits),
        }
    }

    pub(super) fn clear(&mut self) {
        *self = Self::new(self.limits);
    }

    /// Children held by the shallow keep.
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
        kind: ChildKind,
        record: impl FnOnce() -> Record,
    ) {
        let to_list = self.shallow.wants(parent, index, bytes);
        match kind {
            ChildKind::Folder => {
                let to_heap = !self.folders.turns_away(bytes);
                if !to_heap && !to_list {
                    return;
                }
                let record = record();
                if to_list {
                    self.shallow.take(parent, Child::of(index, &record));
                }
                if to_heap {
                    self.folders.offer(HeldFolder::of(&record), None);
                }
            }
            ChildKind::File { family } => {
                // A family of empty files needs no first name: every name holds 0 bytes.
                let family = family.filter(|_| bytes > 0);
                let merging = family.filter(|family| self.files.holds(family));
                let to_heap = merging.is_some() || !self.files.turns_away(bytes);
                if !to_heap && !to_list {
                    return;
                }
                let record = record();
                if to_list {
                    self.shallow.take(parent, Child::of(index, &record));
                }
                let row = HeldFile::of(&record);
                match merging {
                    Some(family) => self.files.merge(family, row),
                    None if to_heap => self.files.offer(row, family),
                    None => {}
                }
            }
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
            .map(Row::record)
            .chain(self.files.above(file_beta).map(Row::record))
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

#[cfg(test)]
mod tests {
    //! What no answer shows, since only memory can: how a heap's index grows (T12e). Here, as a
    //! private item's unit test, because `cargo mutants` found nothing held it (T12f).

    use super::room_for_one;

    /// A heap size one past a power of two, where doubling alone would reach almost twice it.
    const LIMIT: usize = 1_025;

    #[test]
    fn the_room_made_for_one_more_doubles_as_it_grows_and_never_passes_the_limit() {
        let mut index: Vec<u32> = Vec::new();
        let mut rooms: Vec<usize> = Vec::new();
        for row in 0..LIMIT {
            room_for_one(&mut index, LIMIT);
            index.push(u32::try_from(row).unwrap_or(u32::MAX));
            if rooms.last() != Some(&index.capacity()) {
                rooms.push(index.capacity());
            }
        }
        assert!(
            rooms.iter().all(|&room| room <= LIMIT),
            "the index never holds more room than the heap can fill: {rooms:?}"
        );
        assert!(
            rooms.len() <= 8,
            "the room doubles from 16, so it grows at most eight times on the way to {LIMIT}, \
             not once a row: {rooms:?}"
        );
    }
}

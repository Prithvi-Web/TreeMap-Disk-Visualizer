//! The answers the dashboard asks of a scan, kept exact while the walk goes (Phase 4 T12b;
//! design §S.6.1), each hard-linked file counted once (T12d; §S.6.3–§S.6.4):
//!
//! * the largest files, by (size desc, pre-order) — `collectLargestFiles`;
//! * the largest folders below the root, by (total desc, post-order), each with its
//!   recursive file count — `collectLargestFolders`;
//! * every extension's file count and bytes, by (bytes desc, first seen in pre-order) —
//!   `collectFileTypes`;
//! * the size histogram — `computeSizeDistribution`'s buckets.
//!
//! The two lists keep [`KEEP`] entries each, which answers every limit up to it with any
//! minimum size exactly: sorted as they are, a minimum only cuts a list short. A file that
//! cannot beat a full file list's worst is turned away before its path is built.
//!
//! **Hard links.** A family holds one place in the file list: while it is listed, another
//! of its names merges into it — the earlier (depth, position) keeps the place and its own
//! bytes, and the other is offered as a 0-byte file. Everything else is counted per name as
//! the walk goes, and corrected from the settled link log when the answers are read: a later
//! name's bytes leave its extension and the folders above it, and it moves to the
//! histogram's first bucket. A list the corrections could have changed past what it turned
//! away says so ([`Exactness`]).

use std::cmp::{Ordering, Reverse};
use std::collections::{BTreeMap, BinaryHeap, HashMap};

use super::buckets::{SIZE_BUCKETS, size_bucket};
use super::frontier::joined;
use super::links::{Family, Settled};
use super::position::PositionPath;

/// How many entries each list keeps: the most any route asks for.
pub const KEEP: usize = 2_000;

/// How many distinct extensions the table holds: the store's dictionary (65,535) and its
/// overflow (200,000). Past that, the file types are refused with the reason (design §S.6.1).
pub const EXTENSION_LIMIT: usize = 265_535;

/// A file's extension as the store decides it.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Extension {
    /// None: `collectFileTypes` files it under `(none)`.
    None,
    /// Decided here, lower-case ASCII: a name with no byte past ASCII, or with no dot.
    Known(Vec<u8>),
    /// A name with a byte past ASCII and a dot: its raw suffix, which Node lower-cases
    /// (design §S.6.1: once per distinct suffix).
    Pending(Vec<u8>),
}

/// One of the largest files.
#[derive(Clone, Debug, PartialEq)]
pub struct FileAnswer {
    /// Its name as the store keeps it.
    pub name: Vec<u8>,
    /// Its path, built as the scan builds paths.
    pub path: Vec<u8>,
    /// Whole bytes.
    pub size: u64,
    /// Its extension.
    pub extension: Extension,
    /// Milliseconds, as the store keeps them.
    pub modified_at: f64,
    /// Its place in the tree: ties in size keep pre-order.
    pub position: PositionPath,
}

/// One of the largest folders below the root.
#[derive(Clone, Debug, PartialEq)]
pub struct FolderAnswer {
    /// Its name as the store keeps it.
    pub name: Vec<u8>,
    /// Its path, built as the scan builds paths.
    pub path: Vec<u8>,
    /// Every file's bytes below it.
    pub size: u128,
    /// Every file below it.
    pub file_count: u64,
    /// Milliseconds, as the store keeps them.
    pub modified_at: f64,
    /// Its place in the tree: ties in total keep post-order.
    pub position: PositionPath,
}

/// One extension's files.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TypeAnswer {
    /// The extension.
    pub extension: Extension,
    /// How many files have it.
    pub count: u64,
    /// Their bytes.
    pub bytes: u128,
    /// Where the first of them is, in pre-order: ties in bytes keep that order.
    pub first: PositionPath,
}

/// Whether an answer is proven to be what the store would answer (design §S.6.4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Exactness {
    /// Proven.
    Exact,
    /// Not proven, and why.
    NotProven(String),
}

/// Everything the state answers.
#[derive(Clone, Debug, PartialEq)]
pub struct Answers {
    /// At most [`KEEP`], by (size desc, pre-order).
    pub largest_files: Vec<FileAnswer>,
    /// Whether [`Self::largest_files`] is proven.
    pub largest_files_exact: Exactness,
    /// At most [`KEEP`] below the root, by (total desc, post-order).
    pub largest_folders: Vec<FolderAnswer>,
    /// Whether [`Self::largest_folders`] is proven.
    pub largest_folders_exact: Exactness,
    /// Every extension by (bytes desc, first seen in pre-order), or why there are too many.
    pub file_types: Result<Vec<TypeAnswer>, String>,
    /// Files per bucket ([`size_bucket`]), [`SIZE_BUCKETS`] of them.
    pub size_histogram: Vec<u64>,
    /// Every file counted.
    pub files: u64,
}

/// A file as the answers take it.
pub(super) struct File<'a> {
    pub name: &'a [u8],
    pub parent_path: &'a [u8],
    pub separator: u8,
    pub parent_position: &'a PositionPath,
    pub index: u32,
    /// How many steps below the root it is.
    pub depth: u32,
    pub size: u64,
    pub extension: Extension,
    pub modified_at: f64,
    /// Its hard-link family, when its name is keyed.
    pub family: Option<Family>,
}

/// A folder below the root as it closes.
pub(super) struct Folder<'a> {
    pub name: &'a [u8],
    pub path: &'a [u8],
    pub position: &'a PositionPath,
    pub size: u128,
    pub file_count: u64,
    pub modified_at: f64,
}

/// A listed file's place: the larger first, then the earlier in pre-order.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct FileKey {
    size: Reverse<u64>,
    position: PositionPath,
}

impl FileKey {
    fn of(answer: &FileAnswer) -> Self {
        Self {
            size: Reverse(answer.size),
            position: answer.position.clone(),
        }
    }
}

/// A listed file, and the family whose place it holds.
struct Listed {
    answer: FileAnswer,
    family: Option<Family>,
}

/// What the answers keep while the walk goes.
pub(super) struct Kept {
    extension_limit: usize,
    /// The largest files so far, best first.
    files: BTreeMap<FileKey, Listed>,
    /// The place of every family the file list holds.
    families: HashMap<Family, FileKey>,
    /// Whether the file list has turned a file away.
    files_turned_away: bool,
    /// Why the file list is not proven, once something showed it.
    files_unproven: Option<String>,
    /// The largest folders so far, the worst on top.
    folders: BinaryHeap<WorstFolder>,
    /// The largest total the folder list turned away, counted per name.
    folders_turned_away: Option<u128>,
    /// Every extension so far, or `None` once there were too many.
    types: Option<HashMap<Extension, TypeAnswer>>,
    histogram: Vec<u64>,
    counted: u64,
}

/// A kept folder, ordered worst first: the smaller, then the later in post-order.
struct WorstFolder(FolderAnswer);

impl Ord for WorstFolder {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .0
            .size
            .cmp(&self.0.size)
            .then_with(|| self.0.position.post_order(&other.0.position))
    }
}

impl PartialOrd for WorstFolder {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for WorstFolder {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for WorstFolder {}

impl Kept {
    pub(super) fn new(extension_limit: usize) -> Self {
        Self {
            extension_limit,
            files: BTreeMap::new(),
            families: HashMap::new(),
            files_turned_away: false,
            files_unproven: None,
            folders: BinaryHeap::new(),
            folders_turned_away: None,
            types: Some(HashMap::new()),
            histogram: vec![0; SIZE_BUCKETS],
            counted: 0,
        }
    }

    pub(super) fn clear(&mut self) {
        *self = Self::new(self.extension_limit);
    }

    /// Counts a file everywhere it counts, and keeps it among the largest if it is.
    pub(super) fn file(&mut self, file: &File<'_>) {
        self.counted = self.counted.saturating_add(1);
        #[expect(
            clippy::cast_precision_loss,
            reason = "a size as JavaScript's number holds it"
        )]
        let bucket = size_bucket(file.size as f64);
        if let Some(count) = self.histogram.get_mut(bucket) {
            *count = count.saturating_add(1);
        }
        self.count_type(file);
        // A family of empty files needs no first name: every name holds 0 bytes.
        match file.family.filter(|_| file.size > 0) {
            Some(family) if self.families.contains_key(&family) => self.merge(file, family),
            family => self.offer(file, file.size, family),
        }
    }

    /// Offers `file` at `size`. A full list turns it away before its path is built unless it
    /// beats the worst — larger, or as large and earlier in pre-order.
    fn offer(&mut self, file: &File<'_>, size: u64, family: Option<Family>) {
        if self.files.len() >= KEEP {
            let Some((worst, _)) = self.files.last_key_value() else {
                return;
            };
            let beats = match size.cmp(&worst.size.0) {
                Ordering::Less => false,
                Ordering::Greater => true,
                Ordering::Equal => {
                    file.parent_position
                        .compare_child(file.index, &worst.position)
                        == Ordering::Less
                }
            };
            if !beats {
                self.files_turned_away = true;
                return;
            }
            self.drop_worst();
        }
        let answer = answer_of(file, size, file.parent_position.child(file.index));
        self.list(answer, family);
    }

    /// Offers a name already made, as a 0-byte file.
    fn offer_empty(&mut self, mut answer: FileAnswer) {
        answer.size = 0;
        if self.files.len() >= KEEP {
            let Some((worst, _)) = self.files.last_key_value() else {
                return;
            };
            if FileKey::of(&answer) >= *worst {
                self.files_turned_away = true;
                return;
            }
            self.drop_worst();
        }
        self.list(answer, None);
    }

    fn list(&mut self, answer: FileAnswer, family: Option<Family>) {
        let key = FileKey::of(&answer);
        if let Some(family) = family {
            self.families.insert(family, key.clone());
        }
        self.files.insert(key, Listed { answer, family });
    }

    fn drop_worst(&mut self) {
        if let Some((_, gone)) = self.files.pop_last() {
            if let Some(family) = gone.family {
                self.families.remove(&family);
            }
            self.files_turned_away = true;
        }
    }

    /// Another name of a family the list holds: the earlier (depth, position) keeps the place
    /// and its own bytes, and the other is offered as a 0-byte file.
    fn merge(&mut self, file: &File<'_>, family: Family) {
        let Some(key) = self.families.get(&family).cloned() else {
            return;
        };
        let position = file.parent_position.child(file.index);
        let Some(holder) = self.files.get(&key) else {
            return;
        };
        let holder_first =
            (holder.answer.position.depth(), &holder.answer.position) <= (file.depth, &position);
        if holder_first {
            self.offer_empty(answer_of(file, 0, position));
            return;
        }
        let Some(displaced) = self.files.remove(&key) else {
            return;
        };
        let answer = answer_of(file, file.size, position);
        if FileKey::of(&answer) > key && self.files_turned_away {
            self.files_unproven.get_or_insert_with(|| {
                "a hard link's first name ranks below the later name whose place it took, and \
                 the list had turned files away"
                    .to_owned()
            });
        }
        self.list(answer, Some(family));
        self.offer_empty(displaced.answer);
    }

    fn count_type(&mut self, file: &File<'_>) {
        let limit = self.extension_limit;
        let Some(types) = self.types.as_mut() else {
            return;
        };
        if let Some(entry) = types.get_mut(&file.extension) {
            entry.count = entry.count.saturating_add(1);
            entry.bytes = entry.bytes.saturating_add(u128::from(file.size));
            if file.parent_position.compare_child(file.index, &entry.first) == Ordering::Less {
                entry.first = file.parent_position.child(file.index);
            }
            return;
        }
        if types.len() >= limit {
            // Past what the store could name: the whole answer is refused, and the table
            // freed (design §S.6.1).
            self.types = None;
            return;
        }
        types.insert(
            file.extension.clone(),
            TypeAnswer {
                extension: file.extension.clone(),
                count: 1,
                bytes: u128::from(file.size),
                first: file.parent_position.child(file.index),
            },
        );
    }

    /// Keeps a closed folder below the root among the largest if it is.
    pub(super) fn folder(&mut self, folder: &Folder<'_>) {
        if self.folders.len() >= KEEP {
            let Some(worst) = self.folders.peek() else {
                return;
            };
            let beats = match folder.size.cmp(&worst.0.size) {
                Ordering::Less => false,
                Ordering::Greater => true,
                Ordering::Equal => folder.position.post_order(&worst.0.position) == Ordering::Less,
            };
            if !beats {
                self.folder_turned_away(folder.size);
                return;
            }
            if let Some(gone) = self.folders.pop() {
                self.folder_turned_away(gone.0.size);
            }
        }
        self.folders.push(WorstFolder(FolderAnswer {
            name: folder.name.to_vec(),
            path: folder.path.to_vec(),
            size: folder.size,
            file_count: folder.file_count,
            modified_at: folder.modified_at,
            position: folder.position.clone(),
        }));
    }

    fn folder_turned_away(&mut self, total: u128) {
        self.folders_turned_away = Some(self.folders_turned_away.map_or(total, |t| t.max(total)));
    }

    /// The answers, each later name of a hard link taken out as `settled` names them.
    pub(super) fn answers(&self, settled: &Settled<'_>) -> Answers {
        let (largest_files, largest_files_exact) = self.files_answer(settled);
        let (largest_folders, largest_folders_exact) = self.folders_answer(settled);
        let mut histogram = self.histogram.clone();
        let mut types = self.types.clone();
        for loser in &settled.losers {
            #[expect(
                clippy::cast_precision_loss,
                reason = "a size as JavaScript's number holds it"
            )]
            let bucket = size_bucket(loser.bytes as f64);
            if let Some(count) = histogram.get_mut(bucket) {
                *count = count.saturating_sub(1);
            }
            if let Some(count) = histogram.get_mut(size_bucket(0.0)) {
                *count = count.saturating_add(1);
            }
            if let Some(entry) = types.as_mut().and_then(|t| t.get_mut(&loser.extension)) {
                entry.bytes = entry.bytes.saturating_sub(u128::from(loser.bytes));
            }
        }
        let file_types = match types {
            Some(types) => {
                let mut rows: Vec<TypeAnswer> = types.into_values().collect();
                rows.sort_by(|a, b| {
                    b.bytes
                        .cmp(&a.bytes)
                        .then_with(|| a.first.pre_order(&b.first))
                });
                Ok(rows)
            }
            None => Err(format!(
                "the scan holds more than {} distinct extensions, past what the file types keep",
                self.extension_limit
            )),
        };
        Answers {
            largest_files,
            largest_files_exact,
            largest_folders,
            largest_folders_exact,
            file_types,
            size_histogram: histogram,
            files: self.counted,
        }
    }

    /// The file list: a place held by a later name of its family loses its bytes, and the
    /// list is then not proven — its family's first name may belong where it stood.
    fn files_answer(&self, settled: &Settled<'_>) -> (Vec<FileAnswer>, Exactness) {
        let mut unproven = self.files_unproven.clone();
        let mut files = Vec::with_capacity(self.files.len());
        for listed in self.files.values() {
            let mut answer = listed.answer.clone();
            if let Some(family) = listed.family
                && settled
                    .winners
                    .get(&family)
                    .is_some_and(|first| **first != answer.position)
            {
                answer.size = 0;
                unproven.get_or_insert_with(|| {
                    "a later name of a hard link held a place in the list, where its family's \
                     first name may belong"
                        .to_owned()
                });
            }
            files.push(answer);
        }
        files.sort_by(|a, b| {
            b.size
                .cmp(&a.size)
                .then_with(|| a.position.pre_order(&b.position))
        });
        (
            files,
            unproven.map_or(Exactness::Exact, Exactness::NotProven),
        )
    }

    /// The folder list: each listed folder above a later name loses its bytes. Corrections
    /// only lower totals, so the list is proven when nothing listed changed, or when its
    /// last folder still outweighs the largest it turned away.
    fn folders_answer(&self, settled: &Settled<'_>) -> (Vec<FolderAnswer>, Exactness) {
        let mut folders: Vec<FolderAnswer> =
            self.folders.iter().map(|kept| kept.0.clone()).collect();
        let at: HashMap<PositionPath, usize> = folders
            .iter()
            .enumerate()
            .map(|(row, folder)| (folder.position.clone(), row))
            .collect();
        let mut changed = false;
        for loser in &settled.losers {
            let mut up = loser.position.parent();
            while let Some(position) = up {
                if loser.bytes > 0
                    && let Some(folder) = at.get(&position).and_then(|&row| folders.get_mut(row))
                {
                    folder.size = folder.size.saturating_sub(u128::from(loser.bytes));
                    changed = true;
                }
                up = position.parent();
            }
        }
        folders.sort_by(|a, b| {
            b.size
                .cmp(&a.size)
                .then_with(|| a.position.post_order(&b.position))
        });
        let exact = match (changed, self.folders_turned_away, folders.last()) {
            (true, Some(best), Some(last)) if last.size <= best => Exactness::NotProven(format!(
                "hard links: with their later names taken out, the list's last folder holds {} \
                 bytes, no more than a folder it turned away ({best} bytes counted per name)",
                last.size
            )),
            _ => Exactness::Exact,
        };
        (folders, exact)
    }
}

/// `file`'s answer at `size`, placed at `position`.
fn answer_of(file: &File<'_>, size: u64, position: PositionPath) -> FileAnswer {
    FileAnswer {
        name: file.name.to_vec(),
        path: joined(file.parent_path, file.separator, file.name),
        size,
        extension: file.extension.clone(),
        modified_at: file.modified_at,
        position,
    }
}

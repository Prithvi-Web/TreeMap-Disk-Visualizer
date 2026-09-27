//! The answers the dashboard asks of a scan, kept exact while the walk goes (Phase 4 T12b;
//! design §S.6.1), before hard links (T12d):
//!
//! * the largest files, by (size desc, pre-order) — `collectLargestFiles`;
//! * the largest folders below the root, by (total desc, post-order), each with its
//!   recursive file count — `collectLargestFolders`;
//! * every extension's file count and bytes, by (bytes desc, first seen in pre-order) —
//!   `collectFileTypes`;
//! * the size histogram — `computeSizeDistribution`'s buckets.
//!
//! The two lists keep [`KEEP`] entries each, which answers every limit up to it with any
//! minimum size exactly: sorted as they are, a minimum only cuts a list short. Each keeps
//! its entries in a heap whose top is its worst, so a file that cannot beat the worst is
//! turned away before its path is built.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use super::buckets::{SIZE_BUCKETS, size_bucket};
use super::frontier::joined;
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

/// Everything the state answers.
#[derive(Clone, Debug, PartialEq)]
pub struct Answers {
    /// At most [`KEEP`], by (size desc, pre-order).
    pub largest_files: Vec<FileAnswer>,
    /// At most [`KEEP`] below the root, by (total desc, post-order).
    pub largest_folders: Vec<FolderAnswer>,
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
    pub size: u64,
    pub extension: Extension,
    pub modified_at: f64,
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

/// What the answers keep while the walk goes.
pub(super) struct Kept {
    extension_limit: usize,
    /// The largest files so far, the worst on top.
    files: BinaryHeap<WorstFile>,
    /// The largest folders so far, the worst on top.
    folders: BinaryHeap<WorstFolder>,
    /// Every extension so far, or `None` once there were too many.
    types: Option<HashMap<Extension, TypeAnswer>>,
    histogram: Vec<u64>,
    counted: u64,
}

/// A kept file, ordered worst first: the smaller, then the later in pre-order.
struct WorstFile(FileAnswer);

impl Ord for WorstFile {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .0
            .size
            .cmp(&self.0.size)
            .then_with(|| self.0.position.pre_order(&other.0.position))
    }
}

impl PartialOrd for WorstFile {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for WorstFile {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for WorstFile {}

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
            files: BinaryHeap::new(),
            folders: BinaryHeap::new(),
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
        if self.files.len() >= KEEP {
            let Some(worst) = self.files.peek() else {
                return;
            };
            // A file the worst kept one beats — larger, or as large and earlier in
            // pre-order — is turned away before its path is built.
            let beats = match file.size.cmp(&worst.0.size) {
                Ordering::Less => false,
                Ordering::Greater => true,
                Ordering::Equal => {
                    file.parent_position
                        .compare_child(file.index, &worst.0.position)
                        == Ordering::Less
                }
            };
            if !beats {
                return;
            }
            self.files.pop();
        }
        self.files.push(WorstFile(FileAnswer {
            name: file.name.to_vec(),
            path: joined(file.parent_path, file.separator, file.name),
            size: file.size,
            extension: file.extension.clone(),
            modified_at: file.modified_at,
            position: file.parent_position.child(file.index),
        }));
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
                return;
            }
            self.folders.pop();
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

    pub(super) fn answers(&self) -> Answers {
        let mut largest_files: Vec<FileAnswer> =
            self.files.iter().map(|kept| kept.0.clone()).collect();
        largest_files.sort_by(|a, b| {
            b.size
                .cmp(&a.size)
                .then_with(|| a.position.pre_order(&b.position))
        });
        let mut largest_folders: Vec<FolderAnswer> =
            self.folders.iter().map(|kept| kept.0.clone()).collect();
        largest_folders.sort_by(|a, b| {
            b.size
                .cmp(&a.size)
                .then_with(|| a.position.post_order(&b.position))
        });
        let file_types = match &self.types {
            Some(types) => {
                let mut rows: Vec<TypeAnswer> = types.values().cloned().collect();
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
            largest_folders,
            file_types,
            size_histogram: self.histogram.clone(),
            files: self.counted,
        }
    }
}

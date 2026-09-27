//! AggregateState (Phase 4, T12; design §S.6): what the large storage modes keep of a walk
//! in place of its rows. T12a built its spine: position paths and folder totals folded as
//! folders close. T12b adds the answers the dashboard asks of a scan ([`Answers`]); hard
//! links come in T12d.
//!
//! It is a [`ListingSink`] that takes its calls under the walk's commit lock
//! ([`ListingSink::writes_in_place`] is false), so it sees one call at a time and the
//! blocks in id order. Nothing is kept per entry beyond the answers' bounded lists and the
//! extension table. A folder is **open** from the block that holds its row until its own
//! listing has ended and every child folder of its own has closed; it then **closes**: it
//! is shown to the observer, if there is one, and folded into its parent, which may close
//! in turn. A folder's listing ends with its block's last chunk or, for a folder that is
//! never listed, with its refusal or its skip ([`ListingSink::skipped`]). The root closes
//! last, once everything below it is in. What stays in memory is the open frontier, one
//! record per open folder: its position, its path and its running totals.
//!
//! Every order the answers need comes from **position paths** ([`PositionPath`]), never from
//! ids, which a block-numbered walk hands out in no fixed order (design §S.2).
//!
//! Totals are exact integers: each file's bytes by the walk's whole-byte rule, summed as u128.
//! They equal memory mode's float fold whenever every partial sum is below 2^53 (design
//! §S.2's intentional differences). Hard links are counted per name until T12d settles their
//! families.

mod answers;
mod buckets;
mod frontier;
mod keep;
mod position;
mod summary;

pub use answers::{
    Answers, EXTENSION_LIMIT, Extension, FileAnswer, FolderAnswer, KEEP, TypeAnswer,
};
pub use buckets::{SIZE_BUCKET_STARTS, SIZE_BUCKETS, size_bucket};
pub use keep::{FILE_HEAP, FOLDER_HEAP, KeepLimits, ROOT_TOP, SHALLOW_ROWS, SHALLOW_TOP};
pub use position::PositionPath;
pub use summary::{FolderRow, Omitted, Summary, SummaryRow};

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tm_walk::{Block, Finishing, KIND_DIR, ListingSink, Meta, Refusal};

use crate::derive::{decided_here, extension, store_mtime};
use answers::{File, Folder, Kept};
use frontier::{Child, Frontier};
use keep::{Keep, Record};

/// What an aggregate state is made with.
pub struct AggregateOptions {
    /// The scan's root as the scan names it: every folder's path is built on it.
    pub root_path: Vec<u8>,
    /// The separator the scan's paths use.
    pub separator: u8,
    /// Shown each folder as it closes, if anything is.
    pub observer: Option<Arc<dyn CloseObserver>>,
    /// How many distinct extensions the file types hold before they are refused:
    /// [`EXTENSION_LIMIT`].
    pub extension_limit: usize,
    /// How much of the tree itself is kept: the β heaps and the shallow keep.
    pub keep: KeepLimits,
}

/// A folder the moment it closes: everything below it counted.
pub struct ClosedFolder<'a> {
    /// The walk's id for it.
    pub id: u32,
    /// Its parent's id; `None` for the root.
    pub parent: Option<u32>,
    /// Its index among its parent's children (the root's is 0).
    pub index: u32,
    /// Its name as the store keeps it.
    pub name: &'a [u8],
    /// Its path, built as the scan builds paths.
    pub path: &'a [u8],
    /// Its modification time as the store keeps it.
    pub modified_at: f64,
    /// Its place in the tree.
    pub position: &'a PositionPath,
    /// How many steps below the root it is: the root's is 0.
    pub depth: u32,
    /// The bytes of every file below it.
    pub bytes: u128,
    /// How many files are below it.
    pub files: u64,
    /// How many folders are below it, itself not counted.
    pub folders: u64,
}

/// Shown each folder as it closes, in the order folders close.
pub trait CloseObserver: Send + Sync {
    /// `folder` has closed.
    fn closed(&self, folder: &ClosedFolder<'_>);
}

/// See the module docs.
pub struct AggregateState {
    observer: Option<Arc<dyn CloseObserver>>,
    inner: Mutex<Inner>,
}

struct Inner {
    frontier: Frontier,
    /// The answers' lists.
    kept: Kept,
    /// The β heaps and the shallow keep.
    keep: Keep,
    /// The root's own record, once it has closed.
    root: Option<Record>,
    /// The first broken promise of the walk's, reported by `finish`; nothing more is
    /// counted after it.
    fault: Option<String>,
}

/// What one step of the walk works on.
struct Parts<'a> {
    frontier: &'a mut Frontier,
    kept: &'a mut Kept,
    keep: &'a mut Keep,
    root: &'a mut Option<Record>,
    observer: Option<&'a dyn CloseObserver>,
}

impl AggregateState {
    /// An empty state, which the walk's first call (its root) starts.
    pub fn new(options: AggregateOptions) -> Self {
        Self {
            observer: options.observer,
            inner: Mutex::new(Inner {
                frontier: Frontier::new(options.root_path, options.separator),
                kept: Kept::new(options.extension_limit),
                keep: Keep::new(options.keep),
                root: None,
                fault: None,
            }),
        }
    }

    /// How many folders are open now: the frontier's size.
    pub fn open_folders(&self) -> usize {
        self.lock().frontier.len()
    }

    /// What the state answers now: complete once the walk has finished and `finish` has
    /// accepted it. After a broken promise of the walk's, it is what was counted before it,
    /// and `finish` refuses the walk.
    pub fn answers(&self) -> Answers {
        self.lock().kept.answers()
    }

    /// What aggregate kept of the tree, sealed (design §S.6.2). Refused until the walk has
    /// finished, and after a broken promise of the walk's.
    pub fn summary(&self) -> Result<Summary, String> {
        let inner = self.lock();
        if let Some(fault) = &inner.fault {
            return Err(format!("the aggregate state: {fault}"));
        }
        match &inner.root {
            Some(root) if inner.frontier.len() == 0 => summary::seal(root, &inner.keep.held()),
            _ => Err(
                "the aggregate state: the walk has not finished, so there is nothing to seal"
                    .to_owned(),
            ),
        }
    }

    /// How many rows the shallow keep holds now: never more than its cap, or the root's own
    /// list where that is more.
    pub fn shallow_rows_held(&self) -> usize {
        self.lock().keep.shallow_rows_held()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `step` on the state, unless a fault has already stopped the counting; its own
    /// fault stops it.
    fn run(&self, step: impl FnOnce(Parts<'_>) -> Result<(), String>) {
        let mut inner = self.lock();
        let Inner {
            frontier,
            kept,
            keep,
            root,
            fault,
        } = &mut *inner;
        if fault.is_some() {
            return;
        }
        let parts = Parts {
            frontier,
            kept,
            keep,
            root,
            observer: self.observer.as_deref(),
        };
        if let Err(broken) = step(parts) {
            *fault = Some(broken);
        }
    }
}

impl Parts<'_> {
    /// Ends `folder`'s listing: each folder that closes is shown to the observer, offered
    /// below the root to the answers and to what is kept, and the root kept as it closes.
    fn end(&mut self, folder: u32) -> Result<(), String> {
        let Self {
            frontier,
            kept,
            keep,
            root,
            observer,
        } = self;
        frontier.ended(folder, &mut |closed: &ClosedFolder<'_>| {
            if let Some(observer) = observer {
                observer.closed(closed);
            }
            keep.closed(closed.id, closed.position)?;
            let record = || Record {
                name: closed.name.into(),
                position: closed.position.clone(),
                depth: closed.depth,
                bytes: closed.bytes,
                modified_at: closed.modified_at,
                counts: Some((closed.files, closed.folders)),
            };
            match closed.parent {
                None => **root = Some(record()),
                Some(parent) => {
                    kept.folder(&Folder {
                        name: closed.name,
                        path: closed.path,
                        position: closed.position,
                        size: closed.bytes,
                        file_count: closed.files,
                        modified_at: closed.modified_at,
                    });
                    keep.child(parent, closed.index, closed.bytes, true, record);
                }
            }
            Ok(())
        })
    }
}

/// A file's extension as the store decides it: none; lower-case ASCII, decided here; or,
/// for a name with a byte past ASCII, its raw suffix pending Node's lower-casing.
fn extension_of(name: &[u8]) -> Extension {
    match extension(name) {
        None => Extension::None,
        Some(raw) if decided_here(name) => Extension::Known(raw.to_ascii_lowercase()),
        Some(raw) => Extension::Pending(raw.to_vec()),
    }
}

/// A file's bytes by the walk's whole-byte rule: a finite size of no less than zero, its
/// fraction dropped; anything else 0.
fn whole_bytes(size: f64) -> u64 {
    if size.is_finite() && size >= 0.0 {
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a finite size of no less than zero: `as` drops the fraction and \
                      saturates past u64::MAX, the walk's own whole-byte rule"
        )]
        let bytes = size as u64;
        bytes
    } else {
        0
    }
}

impl ListingSink for AggregateState {
    fn root(&self, name: &[u8], meta: &Meta) {
        self.run(|parts| parts.frontier.open_root(name, store_mtime(meta.mtime_ms)));
    }

    fn commit(&self, block: &Block<'_>) {
        self.run(|mut parts| {
            if block.offset == 0 {
                // A folder's own times, read from the folder itself (Windows), replace what
                // its parent's listing said, as the memory store's row takes them.
                if block.folder != 0
                    && let Some(own) = block.own_times
                {
                    parts
                        .frontier
                        .own_time(block.folder, store_mtime(own.mtime_ms))?;
                }
                let depth = parts.frontier.place(block.folder)?.depth;
                parts.keep.listed(block.folder, depth, block.len)?;
            }
            let Parts {
                frontier,
                kept,
                keep,
                ..
            } = &mut parts;
            let separator = frontier.separator();
            for (step, row) in (0u32..).zip(block.rows) {
                let index = block
                    .offset
                    .checked_add(step)
                    .ok_or("a block's index overflowed")?;
                let id = block
                    .first
                    .checked_add(index)
                    .ok_or("a block's id overflowed")?;
                let name = block.name(row);
                let modified_at = store_mtime(row.meta.mtime_ms);
                if row.meta.kind == KIND_DIR {
                    frontier.child(block.folder, id, index, Child::Folder { name, modified_at })?;
                } else {
                    let size = whole_bytes(row.meta.size);
                    frontier.child(
                        block.folder,
                        id,
                        index,
                        Child::File {
                            bytes: u128::from(size),
                        },
                    )?;
                    let place = frontier.place(block.folder)?;
                    kept.file(&File {
                        name,
                        parent_path: place.path,
                        separator,
                        parent_position: place.position,
                        index,
                        size,
                        extension: extension_of(name),
                        modified_at,
                    });
                    let bytes = u128::from(size);
                    keep.child(block.folder, index, bytes, false, || Record {
                        name: name.into(),
                        position: place.position.child(index),
                        depth: place.depth.saturating_add(1),
                        bytes,
                        modified_at,
                        counts: None,
                    });
                }
            }
            let rows = u64::try_from(block.rows.len()).unwrap_or(u64::MAX);
            if u64::from(block.offset).saturating_add(rows) == u64::from(block.len) {
                parts.end(block.folder)?;
            }
            Ok(())
        });
    }

    fn refused(&self, folder: u32, _why: Refusal) {
        self.run(|mut parts| parts.end(folder));
    }

    fn skipped(&self, folder: u32) {
        self.run(|mut parts| parts.end(folder));
    }

    fn abort(&self) {
        let mut inner = self.lock();
        inner.frontier.clear();
        inner.kept.clear();
        inner.keep.clear();
        inner.root = None;
        inner.fault = None;
    }

    fn finish(&self, _ending: &Finishing<'_>) -> Result<(), String> {
        let inner = self.lock();
        if let Some(fault) = &inner.fault {
            return Err(format!("the aggregate state: {fault}"));
        }
        match inner.frontier.len() {
            0 => Ok(()),
            open => Err(format!(
                "the aggregate state: {open} folder(s) were still open when the walk finished"
            )),
        }
    }
}

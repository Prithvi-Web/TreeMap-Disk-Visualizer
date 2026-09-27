//! AggregateState (Phase 4, T12; design §S.6): what the large storage modes keep of a walk
//! in place of its rows. T12a builds its spine: position paths and folder totals folded as
//! folders close; the answers the dashboard asks of a scan come in T12b–T12d.
//!
//! It is a [`ListingSink`] that takes its calls under the walk's commit lock
//! ([`ListingSink::writes_in_place`] is false), so it sees one call at a time and the blocks
//! in id order. Nothing is kept per entry. A folder is **open** from the block that holds its
//! row until its own listing has ended and every child folder of its own has closed; it then
//! **closes**: it is shown to the observer, if there is one, and folded into its parent,
//! which may close in turn. A folder's listing ends with its block's last chunk or, for a
//! folder that is never listed, with its refusal or its skip ([`ListingSink::skipped`]).
//! The root closes last, once everything below it is in. What stays in memory is the open
//! frontier, one record per open folder: its position, its path and its running totals.
//!
//! Every order the answers need comes from **position paths** ([`PositionPath`]), never from
//! ids, which a block-numbered walk hands out in no fixed order (design §S.2).
//!
//! Totals are exact integers: each file's bytes by the walk's whole-byte rule, summed as u128.
//! They equal memory mode's float fold whenever every partial sum is below 2^53 (design
//! §S.2's intentional differences). Hard links are counted per name until T12d settles their
//! families.

mod frontier;
mod position;

pub use position::PositionPath;

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tm_walk::{Block, Finishing, KIND_DIR, ListingSink, Meta, Refusal};

use frontier::{Child, Frontier};

/// What an aggregate state is made with.
pub struct AggregateOptions {
    /// The scan's root as the scan names it: every folder's path is built on it.
    pub root_path: Vec<u8>,
    /// The separator the scan's paths use.
    pub separator: u8,
    /// Shown each folder as it closes, if anything is.
    pub observer: Option<Arc<dyn CloseObserver>>,
}

/// A folder the moment it closes: everything below it counted.
pub struct ClosedFolder<'a> {
    /// The walk's id for it.
    pub id: u32,
    /// Its path, built as the scan builds paths.
    pub path: &'a [u8],
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
    /// The first broken promise of the walk's, reported by `finish`; nothing more is
    /// counted after it.
    fault: Option<String>,
}

impl AggregateState {
    /// An empty state, which the walk's first call (its root) starts.
    pub fn new(options: AggregateOptions) -> Self {
        Self {
            observer: options.observer,
            inner: Mutex::new(Inner {
                frontier: Frontier::new(options.root_path, options.separator),
                fault: None,
            }),
        }
    }

    /// How many folders are open now: the frontier's size.
    pub fn open_folders(&self) -> usize {
        self.lock().frontier.len()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `step` on the frontier, closes shown to the observer, unless a fault has
    /// already stopped the counting; its own fault stops it.
    fn run(
        &self,
        step: impl FnOnce(&mut Frontier, &mut dyn FnMut(&ClosedFolder<'_>)) -> Result<(), String>,
    ) {
        let mut inner = self.lock();
        if inner.fault.is_some() {
            return;
        }
        let observer = self.observer.clone();
        let mut shown = |folder: &ClosedFolder<'_>| {
            if let Some(observer) = &observer {
                observer.closed(folder);
            }
        };
        if let Err(fault) = step(&mut inner.frontier, &mut shown) {
            inner.fault = Some(fault);
        }
    }
}

/// A file's bytes by the walk's whole-byte rule: a finite size of no less than zero, its
/// fraction dropped; anything else 0.
fn whole_bytes(size: f64) -> u128 {
    if size.is_finite() && size >= 0.0 {
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a finite size of no less than zero: `as` drops the fraction and \
                      saturates past u64::MAX, the walk's own whole-byte rule"
        )]
        let bytes = size as u64;
        u128::from(bytes)
    } else {
        0
    }
}

impl ListingSink for AggregateState {
    fn root(&self, _name: &[u8], _meta: &Meta) {
        self.run(|frontier, _| frontier.open_root());
    }

    fn commit(&self, block: &Block<'_>) {
        self.run(|frontier, closed| {
            for (step, row) in (0u32..).zip(block.rows) {
                let index = block
                    .offset
                    .checked_add(step)
                    .ok_or("a block's index overflowed")?;
                let id = block
                    .first
                    .checked_add(index)
                    .ok_or("a block's id overflowed")?;
                let child = if row.meta.kind == KIND_DIR {
                    Child::Folder {
                        name: block.name(row),
                    }
                } else {
                    Child::File {
                        bytes: whole_bytes(row.meta.size),
                    }
                };
                frontier.child(block.folder, id, index, child)?;
            }
            let rows = u64::try_from(block.rows.len()).unwrap_or(u64::MAX);
            if u64::from(block.offset).saturating_add(rows) == u64::from(block.len) {
                frontier.ended(block.folder, closed)?;
            }
            Ok(())
        });
    }

    fn refused(&self, folder: u32, _why: Refusal) {
        self.run(|frontier, closed| frontier.ended(folder, closed));
    }

    fn skipped(&self, folder: u32) {
        self.run(|frontier, closed| frontier.ended(folder, closed));
    }

    fn abort(&self) {
        let mut inner = self.lock();
        inner.frontier.clear();
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

//! The open frontier (design §S.6.1): one record per folder the walk has named and not yet
//! finished, folded into its parent the moment it closes.

use std::collections::HashMap;

use super::ClosedFolder;
use super::position::PositionPath;

/// One open folder: its place, its path, what is still to come below it, and what has been
/// counted so far.
struct Open {
    /// Its parent's id; `None` for the root.
    parent: Option<u32>,
    position: PositionPath,
    depth: u32,
    name: Vec<u8>,
    path: Vec<u8>,
    /// Its modification time as the store keeps it: its row's, or on Windows what its own
    /// listing read from the folder itself.
    modified_at: f64,
    /// Child folders still open, plus one while its own listing is outstanding.
    pending: u32,
    bytes: u128,
    files: u64,
    folders: u64,
}

/// A child a block names, as the frontier counts it.
#[derive(Clone, Copy)]
pub(super) enum Child<'a> {
    /// A folder, opened here and awaiting its own listing, with its row's time.
    Folder { name: &'a [u8], modified_at: f64 },
    /// Anything else, counted as a file with its bytes.
    File { bytes: u128 },
}

pub(super) struct Frontier {
    root_path: Vec<u8>,
    separator: u8,
    open: HashMap<u32, Open>,
}

impl Frontier {
    pub(super) fn new(root_path: Vec<u8>, separator: u8) -> Self {
        Self {
            root_path,
            separator,
            open: HashMap::new(),
        }
    }

    /// The separator paths are joined with.
    pub(super) fn separator(&self) -> u8 {
        self.separator
    }

    /// Open folder `folder`'s path and position, for the files its blocks name.
    pub(super) fn place(&self, folder: u32) -> Result<(&[u8], &PositionPath), String> {
        self.open
            .get(&folder)
            .map(|open| (open.path.as_slice(), &open.position))
            .ok_or_else(|| format!("a block named folder {folder}, which is not open"))
    }

    /// Open folder `folder`'s modification time, as its own listing read it (Windows).
    pub(super) fn own_time(&mut self, folder: u32, modified_at: f64) -> Result<(), String> {
        let open = self
            .open
            .get_mut(&folder)
            .ok_or_else(|| format!("folder {folder}'s own times came, and it is not open"))?;
        open.modified_at = modified_at;
        Ok(())
    }

    /// Folders open now.
    pub(super) fn len(&self) -> usize {
        self.open.len()
    }

    pub(super) fn clear(&mut self) {
        self.open.clear();
    }

    /// Opens the root, id 0, awaiting its listing.
    pub(super) fn open_root(&mut self) -> Result<(), String> {
        let root = Open {
            parent: None,
            position: PositionPath::root(),
            depth: 0,
            name: Vec::new(),
            path: self.root_path.clone(),
            modified_at: 0.0,
            pending: 1,
            bytes: 0,
            files: 0,
            folders: 0,
        };
        if self.open.insert(0, root).is_some() {
            return Err("the root was opened twice".to_owned());
        }
        Ok(())
    }

    /// Counts `folder`'s child `id`, at `index` among its children: a file's bytes go to the
    /// folder, and a child folder is opened below it.
    pub(super) fn child(
        &mut self,
        folder: u32,
        id: u32,
        index: u32,
        child: Child<'_>,
    ) -> Result<(), String> {
        let separator = self.separator;
        let parent = self
            .open
            .get_mut(&folder)
            .ok_or_else(|| format!("a block named folder {folder}, which is not open"))?;
        let opened = match child {
            Child::File { bytes } => {
                parent.bytes = parent
                    .bytes
                    .checked_add(bytes)
                    .ok_or_else(|| format!("folder {folder}'s bytes overflowed"))?;
                parent.files = parent.files.saturating_add(1);
                None
            }
            Child::Folder { name, modified_at } => {
                parent.pending = parent
                    .pending
                    .checked_add(1)
                    .ok_or_else(|| format!("folder {folder} has too many open children"))?;
                Some(Open {
                    parent: Some(folder),
                    position: parent.position.child(index),
                    depth: parent.depth.saturating_add(1),
                    name: name.to_vec(),
                    path: joined(&parent.path, separator, name),
                    modified_at,
                    pending: 1,
                    bytes: 0,
                    files: 0,
                    folders: 0,
                })
            }
        };
        if let Some(open) = opened
            && self.open.insert(id, open).is_some()
        {
            return Err(format!("folder {id} was opened twice"));
        }
        Ok(())
    }

    /// `folder`'s listing has ended — its block's last chunk, its refusal or its skip. Each
    /// folder that thereby closes is handed to `closed`, then folded into its parent, which
    /// may close in turn.
    pub(super) fn ended(
        &mut self,
        folder: u32,
        closed: &mut dyn FnMut(&ClosedFolder<'_>),
    ) -> Result<(), String> {
        let mut at = folder;
        loop {
            let open = self
                .open
                .get_mut(&at)
                .ok_or_else(|| format!("folder {at} ended, and it is not open"))?;
            open.pending = open
                .pending
                .checked_sub(1)
                .ok_or_else(|| format!("folder {at} ended more often than it began"))?;
            if open.pending > 0 {
                return Ok(());
            }
            let done = self
                .open
                .remove(&at)
                .ok_or_else(|| format!("folder {at} vanished as it closed"))?;
            closed(&ClosedFolder {
                id: at,
                name: &done.name,
                path: &done.path,
                modified_at: done.modified_at,
                position: &done.position,
                depth: done.depth,
                bytes: done.bytes,
                files: done.files,
                folders: done.folders,
            });
            let Some(parent) = done.parent else {
                return Ok(());
            };
            let up = self
                .open
                .get_mut(&parent)
                .ok_or_else(|| format!("folder {at} closed into {parent}, which is not open"))?;
            up.bytes = up
                .bytes
                .checked_add(done.bytes)
                .ok_or_else(|| format!("folder {parent}'s bytes overflowed"))?;
            up.files = up.files.saturating_add(done.files);
            up.folders = up.folders.saturating_add(done.folders).saturating_add(1);
            at = parent;
        }
    }
}

/// A child's path as the scan joins it (`joinPath` in `scanStore.ts`): a separator between
/// the two, unless the parent's path already ends with one.
pub(super) fn joined(parent: &[u8], separator: u8, name: &[u8]) -> Vec<u8> {
    let mut path = Vec::with_capacity(parent.len() + 1 + name.len());
    path.extend_from_slice(parent);
    if parent.last() != Some(&separator) {
        path.push(separator);
    }
    path.extend_from_slice(name);
    path
}

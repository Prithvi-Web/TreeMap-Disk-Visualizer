//! The seal's summary (Phase 4 T12c; design §S.6.2): the rows aggregate kept, in
//! breadth-first order with each one's parent, and each kept folder with what it omitted.
//!
//! The kept set is the root, every row the β rule keeps, and — depth by depth, down to
//! D_s — the top children of every folder already kept. The β rows are ancestor-closed by
//! construction (a row's ancestors hold at least its bytes), and a top child's parent is
//! kept before its children are added, so every row's parent is in the summary.

use std::collections::{HashMap, HashSet};

use super::answers::Exactness;
use super::keep::{Held, Record};
use super::links::Settled;
use super::position::PositionPath;

/// What a kept folder left out: everything below it that no kept child of its own holds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Omitted {
    /// Files below it, not counted by a kept child.
    pub files: u64,
    /// Folders below it, not counted by a kept child, nor a kept child itself.
    pub folders: u64,
    /// Their bytes.
    pub bytes: u128,
}

/// A kept folder's counts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FolderRow {
    /// Every file below it.
    pub files: u64,
    /// Every folder below it.
    pub folders: u64,
    /// What it left out: its totals less its kept children's.
    pub omitted: Omitted,
}

/// One kept row.
#[derive(Clone, Debug, PartialEq)]
pub struct SummaryRow {
    /// Its parent's place in the rows; `None` for the root.
    pub parent: Option<u32>,
    /// Its name as the store keeps it.
    pub name: Vec<u8>,
    /// Its place in the tree.
    pub position: PositionPath,
    /// How many steps below the root it is.
    pub depth: u32,
    /// A file's bytes, or a folder's total.
    pub bytes: u128,
    /// Milliseconds, as the store keeps them.
    pub modified_at: f64,
    /// A folder's counts; `None` for a file.
    pub folder: Option<FolderRow>,
}

/// What aggregate kept of the tree, sealed.
#[derive(Clone, Debug, PartialEq)]
pub struct Summary {
    /// Breadth-first — by depth, then by position — the root first.
    pub rows: Vec<SummaryRow>,
    /// β_d: the smallest total the full folder heap held; `None` when it was not full, and
    /// every folder was kept.
    pub folder_threshold: Option<u128>,
    /// β_f, likewise for files.
    pub file_threshold: Option<u64>,
    /// D_s: the deepest depth whose kept folders kept their top children.
    pub shallow_depth: u32,
    /// Whether the top children kept are proven to be the largest once hard links are
    /// counted once: a folder's list is ranked by what the walk counted per name, so one
    /// that turned children away while holding a later name of a hard link is not.
    pub shallow_exact: Exactness,
}

/// Adds `record` to the chosen rows unless its row is already chosen (the first record
/// stands: a β record before a top list's); a folder is queued at its depth for its top
/// children.
fn choose<'a>(
    record: &'a Record,
    chosen: &mut HashMap<&'a PositionPath, &'a Record>,
    folders_at: &mut Vec<Vec<&'a Record>>,
) -> Result<(), String> {
    if chosen.contains_key(&record.position) {
        return Ok(());
    }
    chosen.insert(&record.position, record);
    if record.counts.is_none() {
        return Ok(());
    }
    let at = usize::try_from(record.depth).map_err(|e| e.to_string())?;
    if folders_at.len() <= at {
        folders_at.resize_with(at + 1, Vec::new);
    }
    folders_at
        .get_mut(at)
        .ok_or("a depth's folders vanished")?
        .push(record);
    Ok(())
}

/// Seals what was kept into the summary. `root` is the root's own record; `settled` names
/// the later names of hard links, whose bytes leave every kept folder above them.
pub(super) fn seal(
    root: &Record,
    kept: &Held<'_>,
    settled: &Settled<'_>,
) -> Result<Summary, String> {
    let later: HashSet<&PositionPath> =
        settled.losers.iter().map(|loser| &loser.position).collect();
    let mut shallow_unproven = false;
    let mut chosen: HashMap<&PositionPath, &Record> =
        HashMap::with_capacity(kept.by_beta.len() + 1);
    let mut folders_at: Vec<Vec<&Record>> = Vec::new();
    choose(root, &mut chosen, &mut folders_at)?;
    for &record in &kept.by_beta {
        choose(record, &mut chosen, &mut folders_at)?;
    }
    let mut at = 0usize;
    while at < folders_at.len() {
        let depth = u32::try_from(at).map_err(|e| e.to_string())?;
        if depth > kept.shallow_depth {
            break;
        }
        let folders = folders_at
            .get_mut(at)
            .map(std::mem::take)
            .unwrap_or_default();
        for folder in folders {
            let Some(list) = kept.top_children(depth, &folder.position) else {
                continue;
            };
            for child in &list.records {
                choose(child, &mut chosen, &mut folders_at)?;
            }
            if list.cut
                && list
                    .records
                    .iter()
                    .any(|child| later.contains(&child.position))
            {
                shallow_unproven = true;
            }
        }
        at += 1;
    }

    let mut records: Vec<&Record> = chosen.into_values().collect();
    records.sort_by(|a, b| {
        a.depth
            .cmp(&b.depth)
            .then_with(|| a.position.pre_order(&b.position))
    });
    let mut row_of: HashMap<&PositionPath, u32> = HashMap::with_capacity(records.len());
    for (row, record) in (0_u32..).zip(&records) {
        row_of.insert(&record.position, row);
    }

    // A later name of a hard link holds nothing, and every kept folder above it loses its
    // bytes.
    let mut bytes: Vec<u128> = records.iter().map(|record| record.bytes).collect();
    for loser in &settled.losers {
        if let Some(slot) = row_of
            .get(&loser.position)
            .and_then(|&row| bytes.get_mut(usize::try_from(row).ok()?))
        {
            *slot = 0;
        }
        let mut up = loser.position.parent();
        while let Some(position) = up {
            if let Some(slot) = row_of
                .get(&position)
                .and_then(|&row| bytes.get_mut(usize::try_from(row).ok()?))
            {
                *slot = slot.saturating_sub(u128::from(loser.bytes));
            }
            up = position.parent();
        }
    }

    let mut parents = Vec::with_capacity(records.len());
    let mut sums = vec![Omitted::default(); records.len()];
    for (record, &own) in records.iter().zip(&bytes) {
        let parent = match record.position.parent() {
            None => None,
            Some(up) => Some(*row_of.get(&up).ok_or_else(|| {
                format!(
                    "the aggregate summary: the row at {:?} was kept without its parent",
                    record.position.indices()
                )
            })?),
        };
        if let Some(parent) = parent {
            let sum = sums
                .get_mut(usize::try_from(parent).map_err(|e| e.to_string())?)
                .ok_or("a parent's tally vanished")?;
            sum.bytes = sum.bytes.saturating_add(own);
            match record.counts {
                Some((files, folders)) => {
                    sum.files = sum.files.saturating_add(files);
                    sum.folders = sum.folders.saturating_add(folders).saturating_add(1);
                }
                None => sum.files = sum.files.saturating_add(1),
            }
        }
        parents.push(parent);
    }

    let mut rows = Vec::with_capacity(records.len());
    for (((record, parent), sum), &own) in records.iter().zip(parents).zip(&sums).zip(&bytes) {
        let folder = match record.counts {
            None => None,
            Some((files, folders)) => {
                let short = || {
                    format!(
                        "the aggregate summary: the kept children of the folder at {:?} hold \
                         more than it does",
                        record.position.indices()
                    )
                };
                Some(FolderRow {
                    files,
                    folders,
                    omitted: Omitted {
                        files: files.checked_sub(sum.files).ok_or_else(short)?,
                        folders: folders.checked_sub(sum.folders).ok_or_else(short)?,
                        bytes: own.checked_sub(sum.bytes).ok_or_else(short)?,
                    },
                })
            }
        };
        rows.push(SummaryRow {
            parent,
            name: record.name.to_vec(),
            position: record.position.clone(),
            depth: record.depth,
            bytes: own,
            modified_at: record.modified_at,
            folder,
        });
    }
    Ok(Summary {
        rows,
        folder_threshold: kept.folder_threshold,
        file_threshold: kept
            .file_threshold
            .map(|beta| {
                u64::try_from(beta).map_err(|_| "a file's size passed 2^64 bytes".to_owned())
            })
            .transpose()?,
        shallow_depth: kept.shallow_depth,
        shallow_exact: if shallow_unproven {
            Exactness::NotProven(
                "hard links: a folder's top children were ranked counting a later name of a \
                 hard link, which holds nothing, and the folder had more children than it kept"
                    .to_owned(),
            )
        } else {
            Exactness::Exact
        },
    })
}

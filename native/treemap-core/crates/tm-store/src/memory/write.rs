//! Writing one block, or one chunk of a big listing, into the memory sink's columns at the
//! ids and name bytes the walk reserved for it; the parent module says why that is sound
//! beside other workers' blocks.

use std::sync::atomic::Ordering;

use tm_walk::{Block, link_key};

use super::{Columns, Keyed, MemorySink, Side, Values, lock, read};
use crate::column::ColumnError;
use crate::row::{RowInput, RowRules, derive_row, row_times};
use crate::{EXT_NONE, flag};

impl MemorySink {
    /// One block, or one chunk of a big one.
    pub(super) fn write_block(&self, block: &Block<'_>) -> Result<(), String> {
        let columns = read(&self.columns);
        let Some(cols) = columns.as_ref() else {
            return Ok(());
        };
        let walk_root = *self
            .walk_root
            .get()
            .ok_or("a block came before the root's row")?;
        let count = u32::try_from(block.rows.len()).map_err(|e| e.to_string())?;
        let (Some(start), Some(block_end)) = (
            block.first.checked_add(block.offset),
            block.first.checked_add(block.len),
        ) else {
            return Err(format!("folder {}'s block overflows the ids", block.folder));
        };
        if start.checked_add(count).is_none_or(|end| end > block_end) {
            return Err(format!(
                "folder {}'s chunk runs past its block",
                block.folder
            ));
        }
        let pool_start = if block.offset == 0 {
            let shifted = block
                .name_base
                .checked_sub(walk_root)
                .map(|base| base + self.root_name.len() as u64)
                .ok_or_else(|| {
                    format!("folder {}'s names start inside the root's", block.folder)
                })?;
            usize::try_from(shifted).map_err(|e| e.to_string())?
        } else {
            let offset = start as usize;
            let after = offset + 1;
            // SAFETY: name offset `start` holds where the listing's previous chunk ended its
            // last name. That chunk reached this sink from this same thread (one worker
            // lists a folder and hands its chunks over in order), and no other block's
            // rows or offsets include it, so nothing else reads or writes it now.
            let at = unsafe {
                cols.name_off
                    .with_rows_mut(offset..after, |off| off.first().copied())
            }
            .map_err(|e| e.to_string())?;
            at.ok_or("a chunk's first name offset is missing")? as usize
        };
        let folder = i32::try_from(block.folder).map_err(|e| e.to_string())?;
        let rules = self.rules();
        let mut gathered = Side::default();
        let mut values = Vec::with_capacity(block.rows.len());
        let mut names = Vec::with_capacity(block.names.len());
        let mut extensions = Vec::new();
        let mut accessed = 0_u64;
        let mut git_repo = false;
        for (id, row) in (start..).zip(block.rows) {
            let name = block.name(row);
            let meta = &row.meta;
            let derived = derive_row(
                &RowInput {
                    name,
                    is_root: false,
                    kind: meta.kind,
                    walk_flags: meta.flags,
                    size: meta.size,
                    alloc: meta.alloc,
                    mtime_ms: meta.mtime_ms,
                    atime_ms: meta.atime_ms,
                },
                &rules,
            )
            .map_err(|e| e.to_string())?;
            gathered.shortfall.add(meta.size, meta.alloc);
            if derived.is_dir() {
                gathered.counters.dirs += 1;
            } else {
                gathered.counters.files += 1;
            }
            if derived.cloud_candidate() {
                gathered.cloud_candidates.push(id);
            }
            if !derived.decided {
                gathered.text_candidates.push(id);
            }
            git_repo |= derived.marks_parent_git_repo;
            // A row that may share its file with another name is settled at the seal,
            // once its family is known; any other is settled now.
            let key = if derived.linkable() {
                link_key(meta, id)
            } else {
                None
            };
            let (bits, bytes) = if let Some(key) = key {
                gathered.keyed.push(Keyed {
                    key,
                    pending: derived.pending,
                });
                (derived.bits, derived.pending.bytes)
            } else {
                let settled = derived.pending.settle(
                    false,
                    id,
                    &mut gathered.counters,
                    Some(&mut gathered.sparse_terms),
                );
                (derived.bits | settled.dup_bit, settled.bytes)
            };
            if derived.atime.is_some() {
                accessed += 1;
            }
            if let Some(raw) = derived.extension {
                extensions.push((values.len(), raw));
            }
            names.extend_from_slice(name);
            let name_end = u32::try_from(pool_start + names.len())
                .map_err(|_| "the names pass the store's 4 GiB".to_owned())?;
            values.push(Values {
                parent: folder,
                size: bytes,
                mtime: derived.mtime,
                atime: derived.atime.unwrap_or(0.0),
                flags: bits,
                ext: EXT_NONE,
                container: derived.container,
                name_end,
            });
        }
        if !extensions.is_empty() {
            // One lock per block: its extensions are interned in its rows' order.
            let mut interner = lock(&self.interner);
            for (at, raw) in extensions {
                if let Some(row) = values.get_mut(at) {
                    let id = start + u32::try_from(at).map_err(|e| e.to_string())?;
                    row.ext = interner.intern(raw, id);
                }
            }
        }
        // SAFETY: the rows `start..start + count` of every column, the name offsets after
        // them and the pool's bytes from `pool_start` for this chunk's names are this
        // block's alone: the walk reserved its ids and its name bytes under the commit lock
        // for this block only, so no other block writes or reads them, and a chunk of the
        // same listing covers other rows. The seal reads them only once it holds the
        // columns under the write lock, which waits for this read lock to be released.
        unsafe {
            write_rows(
                cols,
                start as usize,
                &values,
                &names,
                pool_start,
                accessed > 0,
            )
        }
        .map_err(|e| e.to_string())?;
        let accessed_change = write_own_row(cols, block, git_repo, &rules)?;
        self.accessed.fetch_add(accessed, Ordering::AcqRel);
        if accessed_change < 0 {
            self.accessed.fetch_sub(1, Ordering::AcqRel);
        } else if accessed_change > 0 {
            self.accessed.fetch_add(1, Ordering::AcqRel);
        }
        self.written.fetch_add(u64::from(count), Ordering::AcqRel);
        self.end.fetch_max(block_end, Ordering::AcqRel);
        lock(&self.side).absorb(gathered);
        Ok(())
    }
}

/// What a folder's own listing decides about its own row: its child range (on the
/// listing's first chunk), `GitRepo` when a child is a `.git` folder, and its own times
/// where the listing read them (Windows). The change it made to the count of rows with
/// an access time: −1, 0 or 1.
fn write_own_row(
    cols: &Columns,
    block: &Block<'_>,
    git_repo: bool,
    rules: &RowRules<'_>,
) -> Result<i8, String> {
    let row = block.folder as usize;
    let after = row + 1;
    let own = row..after;
    let own_times = block
        .own_times
        .filter(|_| block.offset == 0 && block.folder != 0)
        .map(|times| row_times(false, times.mtime_ms, times.atime_ms, rules));
    let mut change = 0_i8;
    // SAFETY: row `block.folder` is the listed folder's own row. Its values were
    // written by the block that holds it, which reached this sink before this listing
    // began (the walk queues a folder only after its parent's block is with every
    // sink, and the queue's mutex orders the two); since then only the worker listing
    // the folder — this thread — touches the fields its listing decides: its child
    // range, its `GitRepo` bit, its own times. The seal reads them only once it holds the
    // columns under the write lock, which waits for the caller's read lock.
    unsafe {
        if block.offset == 0 {
            cols.child_start
                .with_rows_mut(own.clone(), |start| start.fill(block.first))
                .map_err(|e| e.to_string())?;
            cols.child_cnt
                .with_rows_mut(own.clone(), |count| count.fill(block.len))
                .map_err(|e| e.to_string())?;
        }
        if git_repo {
            cols.flags
                .with_rows_mut(own.clone(), |bits| {
                    for bit in bits {
                        *bit |= flag::GIT_REPO;
                    }
                })
                .map_err(|e| e.to_string())?;
        }
        if let Some((mtime, atime)) = own_times {
            cols.mtime
                .with_rows_mut(own.clone(), |times| times.fill(mtime))
                .map_err(|e| e.to_string())?;
            cols.atime
                .with_rows_mut(own.clone(), |times| times.fill(atime.unwrap_or(0.0)))
                .map_err(|e| e.to_string())?;
            cols.flags
                .with_rows_mut(own, |bits| {
                    for bit in bits {
                        let had = *bit & flag::HAS_ACCESSED != 0;
                        *bit &= !flag::HAS_ACCESSED;
                        if atime.is_some() {
                            *bit |= flag::HAS_ACCESSED;
                        }
                        change = i8::from(atime.is_some()) - i8::from(had);
                    }
                })
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(change)
}

/// Writes `values` at rows `start..` of every column, their name offsets after them and
/// `names` at `pool_start` in the pool; the access-time column only when `any_atime`, so
/// a walk that records none never touches its pages.
///
/// # Safety
///
/// The rows, the name offsets `start + 1..`, and the pool's bytes from `pool_start` that
/// this writes are the caller's alone while it runs, as [`AnonRows::with_rows_mut`] asks.
pub(super) unsafe fn write_rows(
    cols: &Columns,
    start: usize,
    values: &[Values],
    names: &[u8],
    pool_start: usize,
    any_atime: bool,
) -> Result<(), ColumnError> {
    let end = start + values.len();
    let rows = start..end;
    let (first_offset, end_offset) = (start + 1, end + 1);
    let offsets = first_offset..end_offset;
    let pool = pool_start..pool_start + names.len();
    // SAFETY: the caller's promise, for each range written here.
    unsafe {
        cols.parent
            .with_rows_mut(rows.clone(), |out| put(out, values, |v| v.parent))?;
        cols.size
            .with_rows_mut(rows.clone(), |out| put(out, values, |v| v.size))?;
        cols.mtime
            .with_rows_mut(rows.clone(), |out| put(out, values, |v| v.mtime))?;
        if any_atime {
            cols.atime
                .with_rows_mut(rows.clone(), |out| put(out, values, |v| v.atime))?;
        }
        cols.flags
            .with_rows_mut(rows.clone(), |out| put(out, values, |v| v.flags))?;
        cols.ext
            .with_rows_mut(rows.clone(), |out| put(out, values, |v| v.ext))?;
        cols.container
            .with_rows_mut(rows, |out| put(out, values, |v| v.container))?;
        cols.name_off
            .with_rows_mut(offsets, |out| put(out, values, |v| v.name_end))?;
        cols.names
            .with_rows_mut(pool, |out| out.copy_from_slice(names))?;
    }
    Ok(())
}

/// Fills `out` with one field of each of `values`, in order.
fn put<T: Copy>(out: &mut [T], values: &[Values], field: impl Fn(&Values) -> T) {
    for (slot, value) in out.iter_mut().zip(values) {
        *slot = field(value);
    }
}

//! The memory sink (Phase 4, T7a; design §S.1.3): the finalized store's columns, written
//! while the walk runs, at the ids each listing's block reserved, then sealed into a
//! [`Store`] of `n` rows on the walk's driver thread as the walk finishes with an output
//! ([`ListingSink::finish`], T8a: the seal sees a cancel and moves the heartbeat), and
//! handed over by [`MemorySink::take_store`].
//!
//! The columns are `PackedScanStore`'s (decision P4-1) in anonymous mappings reserved for
//! `cap_rows` rows, the headroom among them, and a name pool reserved likewise (decision
//! P4-11): only the pages written are ever resident. On Windows only they are committed
//! while the walk runs, and the seal commits the rows and the headroom, so the machine's
//! commit limit is never charged for reserved rows the walk did not use
//! (`AnonRows::reserve`). The sink writes in place
//! ([`ListingSink::writes_in_place`]): each worker writes its own block's rows after the
//! commit lock is released, beside other workers' blocks, through the one narrow unsafe
//! writer `AnonRows::with_rows_mut`. What makes that sound is what the walk guarantees
//! a sink that writes in place:
//!
//! * a block's rows, its name offsets and its names are its own: the walk reserved its ids
//!   and name bytes under the commit lock for it alone, so no two blocks share a row, an
//!   offset or a name byte;
//! * a folder's own row — its child range, its `.git` child, its own times — is updated
//!   only by the one worker that lists the folder, which was handed the folder after the
//!   block holding its row reached this sink (the queue's mutex orders the two);
//! * a big listing's chunks come in order, from that one worker;
//! * blocks write under the columns' read lock, and the seal and an abort take the
//!   columns under its write lock, which waits for every block still being written; the
//!   walk aborts only after its workers have stopped.
//!
//! Every row is derived by the kernel `build` runs (the crate's `row` module): the same
//! rules on the same input (design §S.2, Lemma 1). Three things differ from `build`, and none reaches
//! an answer (§S.2, Lemmas 4 and 5): the ids are the walk's blocks' rather than
//! breadth-first; the extension dictionary's ids are in the order blocks reached the
//! sink, its texts the same; and the counters' byte sums are added block by block, which
//! gives `build`'s sums exactly while every partial sum is a whole number below 2^53.
//!
//! **Hard links (T7b).** Families come from the walk's own link keys
//! ([`tm_walk::link_key`], [`hardlink_families`]), settled at the seal. The member that
//! keeps the bytes is `build`'s (P4-2a): the first breadth-first, placed from the sealed
//! store's own child ranges (`order.rs`: a queue of the folders alone, and per child range
//! a binary search over the rows that need a place; design §S.1.5), which also puts the
//! cloud candidates and the sparse terms in `build`'s order. A family found by file id
//! alone (listings with no link count, Windows) is re-read as the walk re-reads it, and its
//! members are derived again from the file's own facts (`refresh.rs`). The link log's
//! resident cap and disk runs come with the spill files (T13), and position paths with the
//! large modes (T12). Folder totals stay Node's (`sumSizes`), as the seal of design §S.1.5
//! says.

use std::mem;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{
    Mutex, MutexGuard, OnceLock, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard,
};

use tm_walk::{
    Block, Finishing, HardlinkRef, IdFamily, LinkKey, ListingSink, Meta, Refusal, hardlink_families,
};

use crate::build::{
    BuildOptions, Counters, NAME_BYTES_PER_HEADROOM_ROW, Store, StoreMode, check_options,
};
use crate::column::{AnonRows, Column, ColumnError};
use crate::derive::ContainerRule;
use crate::row::{ExtInterner, Pending, RowInput, RowRules, ShortfallSum, derive_row};
use crate::{EXT_NONE, StoreError};

mod order;
mod refresh;
mod write;

use order::Places;
use refresh::Rows;
use write::write_rows;

/// A [`ListingSink`] that writes the finalized store's columns while the walk runs (see
/// the module docs). Hand it to the walk with its ceilings set
/// ([`MemorySink::id_ceiling`], [`MemorySink::name_ceiling`]), then [`MemorySink::seal`]
/// it once the walk has ended with an output.
pub struct MemorySink {
    /// The root's name as the store shows it (`BuildOptions::root_name`).
    root_name: Vec<u8>,
    root_mtime_ms: f64,
    blocks_are_meaningful: bool,
    container_rules: Vec<ContainerRule>,
    headroom_rows: u32,
    /// Rows every column has room for, the headroom among them.
    cap_rows: u32,
    /// Bytes the name pool has room for.
    pool_bytes: u32,
    /// The columns; `None` once sealed or aborted. Blocks write under the read lock, side
    /// by side; the seal and an abort take the columns under the write lock.
    columns: RwLock<Option<Columns>>,
    /// The length of the walk's stored root name: where the walk's name arena puts the
    /// first block's names. Set by `root`, before any block.
    walk_root: OnceLock<u64>,
    /// The extension dictionary, shared: its ids in the order blocks reach it.
    interner: Mutex<ExtInterner>,
    /// What blocks gathered besides their rows.
    side: Mutex<Side>,
    /// Rows with an access time: the store has an access-time column when there are any.
    accessed: AtomicU64,
    /// Rows written in blocks: every id below the root once, when nothing went wrong.
    written: AtomicU64,
    /// One past the last id a block reserved: the store's `n`.
    end: AtomicU32,
    /// The first thing the sink could not do; the seal reports it.
    broken: Mutex<Option<String>>,
    /// The store sealed at the walk's finish, until it is taken.
    sealed: Mutex<Option<Store>>,
}

/// The P4-1 columns, reserved.
struct Columns {
    parent: AnonRows<i32>,
    size: AnonRows<f64>,
    mtime: AnonRows<f64>,
    atime: AnonRows<f64>,
    flags: AnonRows<u16>,
    ext: AnonRows<u16>,
    container: AnonRows<u8>,
    cloud_prov: AnonRows<u8>,
    name_off: AnonRows<u32>,
    names: AnonRows<u8>,
    child_start: AnonRows<u32>,
    child_cnt: AnonRows<u32>,
}

impl Columns {
    fn reserve(rows: usize, name_bytes: usize) -> Result<Self, ColumnError> {
        Ok(Self {
            parent: AnonRows::reserve(rows)?,
            size: AnonRows::reserve(rows)?,
            mtime: AnonRows::reserve(rows)?,
            atime: AnonRows::reserve(rows)?,
            flags: AnonRows::reserve(rows)?,
            ext: AnonRows::reserve(rows)?,
            container: AnonRows::reserve(rows)?,
            cloud_prov: AnonRows::reserve(rows)?,
            name_off: AnonRows::reserve(rows + 1)?,
            names: AnonRows::reserve(name_bytes)?,
            child_start: AnonRows::reserve(rows)?,
            child_cnt: AnonRows::reserve(rows)?,
        })
    }
}

/// What blocks gather besides their rows, in no particular order until the seal.
#[derive(Default)]
struct Side {
    counters: Counters,
    cloud_candidates: Vec<u32>,
    text_candidates: Vec<u32>,
    /// Rows that may share their file with another name: settled at the seal, once their
    /// families are known.
    keyed: Vec<Keyed>,
    /// `(id, bytes)` for every row counted sparse.
    sparse_terms: Vec<(u32, f64)>,
    shortfall: ShortfallSum,
}

impl Side {
    /// Adds what one block gathered.
    fn absorb(&mut self, block: Self) {
        let Self {
            counters,
            cloud_candidates,
            text_candidates,
            keyed,
            sparse_terms,
            shortfall,
        } = block;
        let totals = &mut self.counters;
        totals.dirs += counters.dirs;
        totals.files += counters.files;
        totals.hardlinked_files += counters.hardlinked_files;
        totals.hardlinked_bytes += counters.hardlinked_bytes;
        totals.cloud_files += counters.cloud_files;
        totals.cloud_bytes += counters.cloud_bytes;
        totals.sparse_files += counters.sparse_files;
        totals.sparse_bytes += counters.sparse_bytes;
        totals.slack_bytes += counters.slack_bytes;
        totals.denied_dirs.extend(counters.denied_dirs);
        totals.vanished_dirs += counters.vanished_dirs;
        totals.unreadable_dirs += counters.unreadable_dirs;
        self.cloud_candidates.extend(cloud_candidates);
        self.text_candidates.extend(text_candidates);
        self.keyed.extend(keyed);
        self.sparse_terms.extend(sparse_terms);
        self.shortfall.merge(&shortfall);
    }
}

/// A row that may share its file with another name, and what its dedup settles.
struct Keyed {
    /// Its link key; `node` is its id.
    key: LinkKey,
    pending: Pending,
    /// The listing's allocated bytes: with the file's own size and times and `pending`'s
    /// flag, what the Windows families' re-read derives the row from again (`refresh.rs`).
    /// The row is a file: `link_key` keys nothing else. (Beside the key and `pending` it
    /// fills what was padding: a keyed row takes 64 bytes as before.)
    alloc: f64,
}

/// One row's column values, before its block writes them.
struct Values {
    parent: i32,
    size: f64,
    mtime: f64,
    atime: f64,
    flags: u16,
    ext: u16,
    container: u8,
    /// Where its name ends in the name pool.
    name_end: u32,
}

impl MemorySink {
    /// A sink whose columns have room for `cap_rows` rows, the headroom
    /// (`opts.headroom_rows`) among them, and whose name pool has room for `name_bytes`
    /// bytes: reserved now, resident only where written. Refused for options `build`
    /// refuses, for more rows than the store's signed 32-bit ids number, for more name
    /// bytes than its 32-bit offsets reach, and for room that leaves none beside the root
    /// and the headroom.
    pub fn new(opts: &BuildOptions, cap_rows: u32, name_bytes: u64) -> Result<Self, StoreError> {
        check_options(opts)?;
        if i32::try_from(cap_rows).is_err() {
            return Err(StoreError::TooManyRows {
                rows: u64::from(cap_rows),
            });
        }
        if cap_rows <= opts.headroom_rows {
            return Err(StoreError::Sink(format!(
                "room for {cap_rows} rows leaves none beside {} rows of headroom",
                opts.headroom_rows
            )));
        }
        let pool_bytes = u32::try_from(name_bytes)
            .map_err(|_| StoreError::NamesTooLong { bytes: name_bytes })?;
        let set_aside = reserved_names(opts);
        if u64::from(pool_bytes) <= set_aside {
            return Err(StoreError::Sink(format!(
                "{name_bytes} bytes of names leave none beside the {set_aside} the root's name and the headroom take"
            )));
        }
        let columns = Columns::reserve(cap_rows as usize, pool_bytes as usize)
            .map_err(|e| column_error(&e))?;
        Ok(Self {
            root_name: opts.root_name.as_bytes().to_vec(),
            root_mtime_ms: opts.root_mtime_ms,
            blocks_are_meaningful: opts.blocks_are_meaningful,
            container_rules: opts.container_rules.clone(),
            headroom_rows: opts.headroom_rows,
            cap_rows,
            pool_bytes,
            columns: RwLock::new(Some(columns)),
            walk_root: OnceLock::new(),
            interner: Mutex::new(ExtInterner::new()),
            side: Mutex::new(Side::default()),
            accessed: AtomicU64::new(0),
            written: AtomicU64::new(0),
            end: AtomicU32::new(0),
            broken: Mutex::new(None),
            sealed: Mutex::new(None),
        })
    }

    /// The id ceiling a walk feeding this sink sets (`WalkOptions::id_ceiling`): ids
    /// `0..id_ceiling` leave the headroom free. A walk that needs more faults with the
    /// walk's own ceiling message.
    pub fn id_ceiling(&self) -> u32 {
        self.cap_rows - self.headroom_rows
    }

    /// The name ceiling a walk feeding this sink sets (`WalkOptions::name_ceiling`): the
    /// bytes the root's entries' names may take, leaving room for the root's own name and
    /// the headroom's names. A walk that needs more faults with the walk's name message.
    pub fn name_ceiling(&self) -> u64 {
        let set_aside = self.root_name.len() as u64
            + u64::from(self.headroom_rows) * NAME_BYTES_PER_HEADROOM_ROW as u64;
        u64::from(self.pool_bytes).saturating_sub(set_aside)
    }

    /// The store the walk wrote, sealed when the walk finished with an output
    /// ([`ListingSink::finish`]), handed over once. Fails while the walk has not finished
    /// with an output — it is running, or it ended without one and the sink was aborted —
    /// and once the store has been taken.
    pub fn take_store(&self) -> Result<Store, StoreError> {
        lock(&self.sealed).take().ok_or_else(|| {
            StoreError::Sink(
                "no store: the walk has not finished with an output, or its store was taken".into(),
            )
        })
    }

    /// The store the walk wrote, at its finish (`ending`: what it measured, and its
    /// lister, root and signals), re-reading the hard-link families found by file id as
    /// the walk re-reads them. Fails when the sink was aborted or sealed before, when a
    /// block could not be written (the first reason given), when the rows written are not
    /// every id below the root once, and when the walk is cancelled meanwhile.
    fn seal(&self, ending: &Finishing<'_>) -> Result<Store, StoreError> {
        ending.beat();
        let taken = write(&self.columns).take();
        let columns =
            taken.ok_or_else(|| StoreError::Sink("it was aborted or sealed already".into()))?;
        if let Some(why) = lock(&self.broken).take() {
            return Err(StoreError::Sink(why));
        }
        let mut side = mem::take(&mut *lock(&self.side));
        let interner = mem::replace(&mut *lock(&self.interner), ExtInterner::new());
        self.seal_columns(columns, &mut side, interner, ending)
    }

    fn seal_columns(
        &self,
        mut cols: Columns,
        side: &mut Side,
        interner: ExtInterner,
        ending: &Finishing<'_>,
    ) -> Result<Store, StoreError> {
        let (n, rows, room) = self.written_rows()?;
        cols.name_off
            .settle(rows + 1, room + 1)
            .map_err(|e| column_error(&e))?;
        let name_off = Column::Anon(cols.name_off);
        let names_end = name_off.as_slice().last().map_or(0, |&end| end as usize);
        let names_room = names_end + self.headroom_rows as usize * NAME_BYTES_PER_HEADROOM_ROW;
        cols.names
            .settle(names_end, names_room)
            .map_err(|e| column_error(&e))?;
        let names = Column::Anon(cols.names);
        let parent = settled(cols.parent, rows, room)?;
        let mut size = settled(cols.size, rows, room)?;
        let mut mtime = settled(cols.mtime, rows, room)?;
        let mut flags = settled(cols.flags, rows, room)?;
        let child_start = settled(cols.child_start, rows, room)?;
        let child_cnt = settled(cols.child_cnt, rows, room)?;

        let (members, id_families) = link_families(&mut side.keyed);
        // The access times are kept only where a row has one, and a re-read can give a
        // row the first one or take the last one away.
        let mut atime = if self.accessed.load(Ordering::Acquire) > 0 || !id_families.is_empty() {
            Some(settled(cols.atime, rows, room)?)
        } else {
            None
        };
        self.reread_families(
            ending,
            &id_families,
            side,
            Rows {
                parent: parent.as_slice(),
                name_off: name_off.as_slice(),
                names: names.as_slice(),
                mtime: mtime.as_mut_slice(),
                atime: atime.as_mut().map(Column::as_mut_slice),
                flags: flags.as_mut_slice(),
            },
        )?;
        // Every size is final now, so the keyed rows' shortfalls join the others'.
        for keyed in &side.keyed {
            side.shortfall.add(keyed.pending.bytes, keyed.alloc);
        }

        // Where a row stands breadth-first — the id `build` gives it — decides a hard-link
        // family's winner and the order of the cloud candidates and the sparse terms (T7b).
        let wanted = side
            .keyed
            .iter()
            .map(|keyed| keyed.key.node)
            .chain(side.cloud_candidates.iter().copied())
            .chain(side.sparse_terms.iter().map(|&(id, _)| id))
            .collect();
        let places = Places::of(child_start.as_slice(), child_cnt.as_slice(), wanted)?;
        self.settle_links(
            side,
            &members,
            size.as_mut_slice(),
            flags.as_mut_slice(),
            &places,
        )?;

        let exact = !self.blocks_are_meaningful || side.shortfall.is_exact();
        let sparse_terms = if exact {
            if side.counters.sparse_files > 0 {
                vec![(0, side.counters.sparse_bytes)]
            } else {
                Vec::new()
            }
        } else {
            places.sort(mem::take(&mut side.sparse_terms), |&(id, _)| id)?
        };
        // Dropped, so unmapped, when no row has an access time.
        let atime = atime.filter(|_| self.accessed.load(Ordering::Acquire) > 0);
        let (ext_dict, mut ext_overflow) = interner.finish();
        ext_overflow.sort_unstable_by_key(|&(id, _)| id);
        let cloud_candidates = places.sort(mem::take(&mut side.cloud_candidates), |&id| id)?;
        side.text_candidates.sort_unstable();
        side.counters.denied_dirs.sort_unstable();
        Ok(Store {
            mode: StoreMode::Memory,
            n,
            capacity: u32::try_from(room)
                .map_err(|_| StoreError::TooManyRows { rows: room as u64 })?,
            parent,
            size,
            mtime,
            atime,
            flags,
            ext: settled(cols.ext, rows, room)?,
            container: settled(cols.container, rows, room)?,
            cloud_prov: settled(cols.cloud_prov, rows, room)?,
            name_off,
            names,
            child_start,
            child_cnt,
            ext_dict,
            ext_overflow,
            cloud_candidates,
            text_candidates: mem::take(&mut side.text_candidates),
            sparse_terms,
            counters: mem::take(&mut side.counters),
            walk_stats: ending.stats().clone(),
        })
    }

    /// How many rows the walk wrote (`n`, and as a length) and the room the store keeps
    /// them in, headroom included. Fails when the root's row never came, when the rows
    /// written below the root are not every id its blocks reserved, and when the headroom
    /// does not fit in the rows reserved.
    fn written_rows(&self) -> Result<(u32, usize, usize), StoreError> {
        if self.walk_root.get().is_none() {
            return Err(StoreError::Sink("the root's row never came".into()));
        }
        let n = self.end.load(Ordering::Acquire);
        let below_root = self.written.load(Ordering::Acquire);
        if n == 0 || below_root + 1 != u64::from(n) {
            return Err(StoreError::Sink(format!(
                "{below_root} rows were written below the root, of the {} its blocks reserved",
                n.saturating_sub(1)
            )));
        }
        let rows = n as usize;
        let room = rows + self.headroom_rows as usize;
        if room > self.cap_rows as usize {
            return Err(StoreError::Sink(format!(
                "{rows} rows leave no room for {} rows of headroom in the {} reserved",
                self.headroom_rows, self.cap_rows
            )));
        }
        Ok((n, rows, room))
    }

    /// Settles the rows that may share their file with another name, adding their tallies.
    /// A family's winner is the member `build` meets first — the least breadth-first place
    /// (T7b) — and keeps the bytes; every other member is a duplicate.
    fn settle_links(
        &self,
        side: &mut Side,
        members: &[HardlinkRef],
        size: &mut [f64],
        flags: &mut [u16],
        places: &Places,
    ) -> Result<(), StoreError> {
        let mut winners: Vec<Option<(u32, u32)>> = vec![None; members.len()];
        for member in members {
            let rank = places.of_row(member.node)?;
            let winner = winners.get_mut(member.family as usize).ok_or_else(|| {
                StoreError::Sink(format!("family {} is past its members", member.family))
            })?;
            if winner.is_none_or(|(least, _)| rank < least) {
                *winner = Some((rank, member.node));
            }
        }
        // `members` is sorted by id, so `later` is too.
        let later: Vec<u32> = members
            .iter()
            .filter(|member| {
                let winner = winners.get(member.family as usize).copied().flatten();
                winner.map(|(_, node)| node) != Some(member.node)
            })
            .map(|member| member.node)
            .collect();
        let keep_terms = self.blocks_are_meaningful;
        for keyed in &side.keyed {
            let id = keyed.key.node;
            let duplicate = later.binary_search(&id).is_ok();
            let terms = keep_terms.then_some(&mut side.sparse_terms);
            let settled = keyed
                .pending
                .settle(duplicate, id, &mut side.counters, terms);
            let row = id as usize;
            let (Some(bytes), Some(bits)) = (size.get_mut(row), flags.get_mut(row)) else {
                return Err(StoreError::Sink(format!(
                    "row {id} is past the store's rows"
                )));
            };
            *bytes = settled.bytes;
            *bits |= settled.dup_bit;
        }
        Ok(())
    }

    /// The rules each row is derived by.
    fn rules(&self) -> RowRules<'_> {
        RowRules {
            root_mtime_ms: self.root_mtime_ms,
            blocks_are_meaningful: self.blocks_are_meaningful,
            container_rules: &self.container_rules,
        }
    }

    /// Keeps the first thing the sink could not do.
    fn note(&self, outcome: Result<(), String>) {
        if let Err(why) = outcome {
            lock(&self.broken).get_or_insert(why);
        }
    }

    /// Row 0: the root, with Node's name for it.
    fn write_root(&self, walk_name: &[u8], meta: &Meta) -> Result<(), String> {
        let walk_root = u64::try_from(walk_name.len()).map_err(|e| e.to_string())?;
        if self.walk_root.set(walk_root).is_err() {
            return Err("the root's row came twice".into());
        }
        let columns = read(&self.columns);
        let Some(cols) = columns.as_ref() else {
            return Ok(());
        };
        let mut block = Side::default();
        let row = derive_row(
            &RowInput {
                name: &self.root_name,
                is_root: true,
                kind: meta.kind,
                walk_flags: meta.flags,
                size: meta.size,
                alloc: meta.alloc,
                mtime_ms: meta.mtime_ms,
                atime_ms: meta.atime_ms,
            },
            &self.rules(),
        )
        .map_err(|e| e.to_string())?;
        block.shortfall.add(meta.size, meta.alloc);
        block.counters.dirs = 1;
        if !row.decided {
            block.text_candidates.push(0);
        }
        let settled =
            row.pending
                .settle(false, 0, &mut block.counters, Some(&mut block.sparse_terms));
        let name_end = u32::try_from(self.root_name.len()).map_err(|e| e.to_string())?;
        let ext = match row.extension {
            Some(raw) => lock(&self.interner).intern(raw, 0),
            None => EXT_NONE,
        };
        let values = [Values {
            parent: -1,
            size: settled.bytes,
            mtime: row.mtime,
            atime: row.atime.unwrap_or(0.0),
            flags: row.bits | settled.dup_bit,
            ext,
            container: row.container,
            name_end,
        }];
        // SAFETY: row 0 of every column, the name offsets 0 and 1 and the pool's first
        // `root_name.len()` bytes belong to the root alone: every block's ids start at 1
        // and its names after the root's, and this call comes before the walk hands out
        // any block (the root's own listing is committed only after this returns), so no
        // other thread touches them now. The seal reads them only once it holds the
        // columns under the write lock, which waits for this read lock to be released.
        unsafe {
            cols.name_off
                .with_rows_mut(0..1, |first| first.fill(0))
                .and_then(|()| {
                    write_rows(cols, 0, &values, &self.root_name, 0, row.atime.is_some())
                })
        }
        .map_err(|e| e.to_string())?;
        if row.atime.is_some() {
            self.accessed.fetch_add(1, Ordering::AcqRel);
        }
        lock(&self.side).absorb(block);
        Ok(())
    }
}

/// The hard-link families among `keyed`, which it sorts by id: one ref per member, by id,
/// with its family's number, and the families found by file id alone, which the walk
/// re-reads.
fn link_families(keyed: &mut [Keyed]) -> (Vec<HardlinkRef>, Vec<IdFamily>) {
    keyed.sort_unstable_by_key(|keyed| keyed.key.node);
    let mut keys: Vec<LinkKey> = keyed.iter().map(|keyed| keyed.key).collect();
    hardlink_families(&mut keys)
}

/// `rows` as a column of `len` rows with room for `room`.
fn settled<T: crate::Zeroable>(
    mut rows: AnonRows<T>,
    len: usize,
    room: usize,
) -> Result<Column<T>, StoreError> {
    rows.settle(len, room).map_err(|e| column_error(&e))?;
    Ok(Column::Anon(rows))
}

/// The name bytes a store sets aside besides its entries': the root's name, and the
/// headroom's names.
fn reserved_names(opts: &BuildOptions) -> u64 {
    opts.root_name.len() as u64 + u64::from(opts.headroom_rows) * NAME_BYTES_PER_HEADROOM_ROW as u64
}

fn column_error(error: &ColumnError) -> StoreError {
    StoreError::Sink(error.to_string())
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn read<T>(rw: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    rw.read().unwrap_or_else(PoisonError::into_inner)
}

fn write<T>(rw: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    rw.write().unwrap_or_else(PoisonError::into_inner)
}

impl ListingSink for MemorySink {
    fn root(&self, name: &[u8], meta: &Meta) {
        let outcome = self.write_root(name, meta);
        self.note(outcome);
    }

    fn commit(&self, block: &Block<'_>) {
        let outcome = self.write_block(block);
        self.note(outcome);
    }

    fn refused(&self, folder: u32, why: Refusal) {
        let mut side = lock(&self.side);
        match why {
            Refusal::Denied => side.counters.denied_dirs.push(folder),
            Refusal::Vanished => side.counters.vanished_dirs += 1,
            Refusal::Unreadable => side.counters.unreadable_dirs += 1,
        }
    }

    /// Releases every mapping — a sealed store's too — and forgets what the blocks
    /// gathered.
    fn abort(&self) {
        drop(write(&self.columns).take());
        drop(lock(&self.sealed).take());
        *lock(&self.side) = Side::default();
        *lock(&self.interner) = ExtInterner::new();
    }

    fn writes_in_place(&self) -> bool {
        true
    }

    /// Seals the store on the walk's driver thread, for [`MemorySink::take_store`].
    fn finish(&self, ending: &Finishing<'_>) -> Result<(), String> {
        let store = self.seal(ending).map_err(|e| e.to_string())?;
        *lock(&self.sealed) = Some(store);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    /// On Windows every file is keyed, so a keyed row is what the link log costs per file:
    /// the re-read's allocation fills padding the key and `pending` leave (T7b).
    #[cfg(target_pointer_width = "64")]
    #[test]
    fn a_keyed_row_takes_64_bytes() {
        assert_eq!(std::mem::size_of::<super::Keyed>(), 64);
    }
}

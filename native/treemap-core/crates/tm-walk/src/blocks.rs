//! Block numbering (P4-1a; design §S.1.2): a worker lists and orders a whole
//! folder, stages its rows, then — under one commit lock — reserves the ids
//! `first..first + k` for its `k` children and the bytes their names take,
//! hands the rows to every [`ListingSink`], and only then queues the child
//! folders, numbered `first + i`. So I1–I4 ([`crate::invariants`]) hold by
//! construction: a folder's id was reserved in its parent's block before its
//! job was queued, its children's block after it was listed, and ids and name
//! bytes are reserved together, in one order.
//!
//! A listing a cancel interrupts is never committed: the cancel is read again
//! as the lock is taken, and a worker that finds the walk cancelled there
//! reserves nothing and hands nothing on. A listing of more than
//! [`BIG_LISTING`] entries goes through a semaphore, one at a time, reserves
//! its whole block at once and is staged and handed on in chunks of
//! [`CHUNK_BYTES`]; the worker's listing buffer then shrinks back. A worker
//! waiting on the lock or the semaphore beats the heartbeat, so a long wait
//! is never taken for a stalled walk, and gives up once the walk is cancelled.
//!
//! **One big listing resident at a time (T6b; R89).** A lister reads a folder
//! until its listing is complete or holds [`BIG_LISTING`] entries
//! ([`crate::Lister::list_until`]); a listing it stopped early waits for the
//! semaphore with those entries in hand and is read to its end only past it,
//! and the semaphore is left only once the listing is let go (committed,
//! counted, and the buffer shrunk back). So the listers that read in batches
//! (every platform's, and the synthetic one) hold at most `BIG_LISTING`
//! entries each outside the semaphore and one listing of any size inside it.
//! A lister that lists a folder whole ([`crate::Lister`]'s default) is not
//! bounded: its listing is resident before the walk knows it is big, as under
//! T6.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use crate::output::Refusal;
use crate::platform::{Entry, ListBuffer, Listed, Listing, push_stored, read_rest, stored_len};
use crate::queue::{DirJob, RangeBuilder, queueable};
use crate::sink::{Block, ListingSink};
use crate::walk::{
    CHECK_EVERY, Counted, Shared, ceiling_fault, name_is_a_path, panic_text, whole_bytes,
};
use crate::{BIG_LISTING, CHUNK_BYTES, FLAG_DATALESS, KIND_DIR};

/// How long a worker waits on the commit lock or the big-listing semaphore
/// before it beats the heartbeat again and re-reads the cancel flag.
const WAIT_SLICE: Duration = Duration::from_millis(25);
/// The entries a listing buffer keeps room for after a big listing.
const KEEP_ENTRIES: usize = BIG_LISTING;
/// The name bytes a listing buffer keeps room for after a big listing.
const KEEP_NAME_BYTES: usize = BIG_LISTING * 64;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What the commit lock guards besides the ids, which stay in
/// `Shared::next_id` so the end of the walk reads them as a discovery walk's.
struct Reserved {
    /// The next name byte to hand out, in the names laid out in id order.
    next_name: u64,
}

/// The commit lock: a token one worker holds at a time. A waiter beats the
/// heartbeat every [`WAIT_SLICE`] and gives up once the walk is cancelled, so
/// a worker that died holding the token (its panic cancels the walk) wedges
/// nobody.
pub(crate) struct CommitLock {
    token: Mutex<Option<Reserved>>,
    returned: Condvar,
}

/// The token, held: it goes back when the guard drops, however the holder ends.
struct CommitGuard<'a> {
    lock: &'a CommitLock,
    held: Option<Reserved>,
}

impl CommitLock {
    /// The lock, its name bytes starting after the root's own name.
    pub(crate) fn new(root_name_bytes: u64) -> Self {
        Self {
            token: Mutex::new(Some(Reserved {
                next_name: root_name_bytes,
            })),
            returned: Condvar::new(),
        }
    }

    /// Waits for the token; `None` once the walk is cancelled.
    fn acquire(&self, shared: &Shared) -> Option<CommitGuard<'_>> {
        let mut slot = lock(&self.token);
        loop {
            if shared.is_cancelled() {
                return None;
            }
            if let Some(held) = slot.take() {
                return Some(CommitGuard {
                    lock: self,
                    held: Some(held),
                });
            }
            shared.heartbeat.fetch_add(1, Ordering::AcqRel);
            let (next, _) = self
                .returned
                .wait_timeout(slot, WAIT_SLICE)
                .unwrap_or_else(PoisonError::into_inner);
            slot = next;
        }
    }
}

impl Drop for CommitGuard<'_> {
    fn drop(&mut self) {
        if let Some(held) = self.held.take() {
            *lock(&self.lock.token) = Some(held);
            self.lock.returned.notify_one();
        }
    }
}

/// The big-listing semaphore's state and counts.
#[derive(Default)]
struct BigState {
    /// Workers past the semaphore right now: 0 or 1.
    inside: u32,
    /// The most workers ever past it at once.
    peak: u32,
    /// Listings that went through it.
    listings: u64,
}

/// One big listing at a time (design §S.1.2 step 5).
#[derive(Default)]
pub(crate) struct BigListings {
    state: Mutex<BigState>,
    freed: Condvar,
    /// Workers waiting for it right now. Outside `state` so that a waiter's
    /// [`Counted`] guard can give it back without taking the lock the waiter
    /// holds; changed and read only under that lock all the same.
    waiting: AtomicU32,
}

/// A worker past the semaphore; dropping it lets the next one in.
struct BigPermit<'a> {
    big: &'a BigListings,
}

impl BigListings {
    /// Waits until no other big listing is in progress; `None` once cancelled.
    fn enter(&self, shared: &Shared) -> Option<BigPermit<'_>> {
        let mut state = lock(&self.state);
        if state.inside > 0 {
            // Counted for as long as it waits, however the wait ends; the
            // guard is dropped before `state`, so under the lock.
            let waiting = Counted::new(&self.waiting);
            while state.inside > 0 {
                if shared.is_cancelled() {
                    return None;
                }
                shared.heartbeat.fetch_add(1, Ordering::AcqRel);
                let (next, _) = self
                    .freed
                    .wait_timeout(state, WAIT_SLICE)
                    .unwrap_or_else(PoisonError::into_inner);
                state = next;
            }
            drop(waiting);
        }
        state.inside += 1;
        state.peak = state.peak.max(state.inside);
        state.listings += 1;
        Some(BigPermit { big: self })
    }

    /// `(listings, waiting now, peak inside)`. `waiting` is read under the
    /// lock a waiter holds from its count to its first wait, so a waiter
    /// counted here has already beaten the heartbeat.
    pub(crate) fn counts(&self) -> (u64, u32, u32) {
        let state = lock(&self.state);
        (
            state.listings,
            self.waiting.load(Ordering::Acquire),
            state.peak,
        )
    }
}

impl Drop for BigPermit<'_> {
    fn drop(&mut self) {
        let mut state = lock(&self.big.state);
        state.inside = state.inside.saturating_sub(1);
        drop(state);
        self.big.freed.notify_one();
    }
}

/// The listing entries in the workers' buffers (block numbering; T6b, R89):
/// counted each time a lister answers, given back once the walk is done with
/// the listing. A listing only grows while it is read, so its largest size
/// is counted when its last batch returns.
#[derive(Default)]
pub(crate) struct Resident {
    /// Entries held now, across workers.
    entries: AtomicU64,
    /// The most held at once.
    entries_peak: AtomicU64,
    /// Listings of more than [`BIG_LISTING`] entries held now.
    big: AtomicU32,
    /// The most held at once.
    big_peak: AtomicU32,
}

impl Resident {
    /// `(the most entries held at once, the most listings of more than
    /// BIG_LISTING entries held at once)`.
    pub(crate) fn peaks(&self) -> (u64, u32) {
        (
            self.entries_peak.load(Ordering::Acquire),
            self.big_peak.load(Ordering::Acquire),
        )
    }
}

/// One worker's listing as [`Resident`] counts it: given back when the guard
/// drops, however the listing ends.
struct Held<'a> {
    resident: &'a Resident,
    entries: u64,
    big: bool,
}

impl<'a> Held<'a> {
    fn new(resident: &'a Resident) -> Self {
        Self {
            resident,
            entries: 0,
            big: false,
        }
    }

    /// The listing now holds `len` entries.
    fn note(&mut self, len: usize) {
        let len = u64::try_from(len).unwrap_or(u64::MAX);
        if len > self.entries {
            let more = len - self.entries;
            let now = self
                .resident
                .entries
                .fetch_add(more, Ordering::AcqRel)
                .saturating_add(more);
            self.resident.entries_peak.fetch_max(now, Ordering::AcqRel);
            self.entries = len;
        }
        if !self.big && len > u64::try_from(BIG_LISTING).unwrap_or(u64::MAX) {
            self.big = true;
            let now = self.resident.big.fetch_add(1, Ordering::AcqRel) + 1;
            self.resident.big_peak.fetch_max(now, Ordering::AcqRel);
        }
    }
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        self.resident
            .entries
            .fetch_sub(self.entries, Ordering::AcqRel);
        if self.big {
            self.resident.big.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

/// A worker's staging: the rows it hands on and their stored names.
#[derive(Default)]
pub(crate) struct Stage {
    names: Vec<u8>,
    rows: Vec<Entry>,
}

impl Stage {
    /// The bytes staged: names and rows.
    fn bytes(&self) -> usize {
        self.names.len() + self.rows.len() * size_of::<Entry>()
    }

    /// Stages `listing`'s entries from `from` on until `budget` bytes are
    /// staged or the listing ends; the index it stopped at, or `None` when a
    /// pause (read every [`CHECK_EVERY`] entries of the listing) ended in a
    /// cancel.
    fn fill(
        &mut self,
        shared: &Shared,
        listing: &Listing,
        from: usize,
        budget: usize,
    ) -> Option<usize> {
        self.names.clear();
        self.rows.clear();
        let mut at = from;
        for entry in listing.entries.get(from..).unwrap_or(&[]) {
            if self.bytes() >= budget {
                break;
            }
            if at > 0 && at % CHECK_EVERY == 0 && shared.wait_while_paused() {
                return None;
            }
            let start = self.names.len();
            push_stored(&mut self.names, listing.name(entry));
            self.rows.push(Entry {
                name: start..self.names.len(),
                meta: entry.meta,
            });
            at += 1;
        }
        Some(at)
    }
}

/// Calls `call` on every sink, the collector first; a sink's panic becomes
/// the walk's fault and cancels it (false).
pub(crate) fn to_sinks(shared: &Shared, call: impl Fn(&dyn ListingSink)) -> bool {
    for sink in &shared.sinks {
        if let Err(payload) = catch_unwind(AssertUnwindSafe(|| call(sink.as_ref()))) {
            shared.record_fault(format!(
                "a listing sink panicked: {}",
                panic_text(&*payload)
            ));
            shared.cancel();
            return false;
        }
    }
    true
}

/// Reserves `k` ids and `bytes` name bytes under the held lock: the first id
/// and the first name byte, or `None` after recording the ceiling fault.
fn reserve(shared: &Shared, guard: &mut CommitGuard<'_>, k: u32, bytes: u64) -> Option<(u32, u64)> {
    let first = shared.next_id.load(Ordering::Acquire);
    let end = if k == 0 {
        Some(first)
    } else {
        first.checked_add(k).filter(|&end| end <= shared.id_ceiling)
    };
    let (Some(end), Some(held)) = (end, guard.held.as_mut()) else {
        // A wrapped id would overwrite an earlier node's row, so the walk
        // ends here as a fault, as the discovery walk's counter does.
        shared.record_fault(ceiling_fault(shared.id_ceiling));
        shared.cancel();
        return None;
    };
    shared.next_id.store(end, Ordering::Release);
    let name_base = held.next_name;
    held.next_name = name_base.saturating_add(bytes);
    Some((first, name_base))
}

/// Hands one staged chunk to every sink, then the refusal of each child
/// folder whose name holds a separator; false when a sink panicked.
fn deliver(shared: &Shared, block: &Block<'_>) -> bool {
    if !to_sinks(shared, |sink| sink.commit(block)) {
        return false;
    }
    let first = block.first.saturating_add(block.offset);
    for (id, row) in (first..).zip(block.rows) {
        if row.meta.kind == KIND_DIR
            && name_is_a_path(block.name(row))
            && !to_sinks(shared, |sink| sink.refused(id, Refusal::Unreadable))
        {
            return false;
        }
    }
    true
}

/// The listing's size as ids, or the ceiling fault.
fn id_count(shared: &Shared, listing: &Listing) -> Option<u32> {
    let k = u32::try_from(listing.len()).ok();
    if k.is_none() {
        shared.record_fault(ceiling_fault(shared.id_ceiling));
        shared.cancel();
    }
    k
}

/// Commits a listing of at most [`BIG_LISTING`] entries: staged whole outside
/// the lock, then reserved and handed on under it. The first child's id.
fn commit_whole(shared: &Shared, listing: &Listing, stage: &mut Stage, folder: u32) -> Option<u32> {
    stage.fill(shared, listing, 0, usize::MAX)?;
    let k = id_count(shared, listing)?;
    let bytes = u64::try_from(stage.names.len()).unwrap_or(u64::MAX);
    let mut guard = shared.commit.acquire(shared)?;
    let (first, name_base) = reserve(shared, &mut guard, k, bytes)?;
    shared.blocks.fetch_add(1, Ordering::AcqRel);
    let block = Block {
        folder,
        first,
        len: k,
        name_base,
        offset: 0,
        rows: &stage.rows,
        names: &stage.names,
        own_times: listing.own_times.filter(|_| folder != 0),
    };
    deliver(shared, &block).then_some(first)
}

/// Commits a big listing: its whole block reserved at once, then staged and
/// handed on in chunks of [`CHUNK_BYTES`], all under the lock so the sinks
/// see its chunks together and in id order. A cancel between two chunks stops
/// the hand-over; the walk then ends and every sink is aborted.
fn commit_in_chunks(
    shared: &Shared,
    listing: &Listing,
    stage: &mut Stage,
    folder: u32,
) -> Option<u32> {
    let k = id_count(shared, listing)?;
    let bytes: u64 = listing
        .entries
        .iter()
        .map(|entry| u64::try_from(stored_len(listing.name(entry))).unwrap_or(u64::MAX))
        .fold(0, u64::saturating_add);
    let mut guard = shared.commit.acquire(shared)?;
    let (first, name_base) = reserve(shared, &mut guard, k, bytes)?;
    shared.blocks.fetch_add(1, Ordering::AcqRel);
    let mut at = 0;
    while at < listing.len() {
        if shared.is_cancelled() {
            return None;
        }
        let end = stage.fill(shared, listing, at, CHUNK_BYTES)?;
        let block = Block {
            folder,
            first,
            len: k,
            name_base,
            offset: u32::try_from(at).ok()?,
            rows: &stage.rows,
            names: &stage.names,
            own_times: listing.own_times.filter(|_| folder != 0 && at == 0),
        };
        if !deliver(shared, &block) {
            return None;
        }
        at = end;
    }
    drop(guard);
    Some(first)
}

/// Counts a committed listing's entries and queues its child folders,
/// numbered from `first` in the order they were committed, as one range.
fn account(shared: &Shared, listing: &Listing, first: u32, job: &DirJob) {
    let (folders, name_bytes) = queueable(listing);
    let mut range = RangeBuilder::new(&job.path, Some(first), folders, name_bytes);
    for (id, entry) in (first..).zip(&listing.entries) {
        let meta = &entry.meta;
        let name = listing.name(entry);
        shared.entries.fetch_add(1, Ordering::AcqRel);
        if meta.withheld {
            shared.unreadable_entries.fetch_add(1, Ordering::AcqRel);
        }
        if meta.flags & FLAG_DATALESS != 0 {
            shared.dataless.fetch_add(1, Ordering::AcqRel);
        }
        if meta.kind == KIND_DIR {
            shared.dirs.fetch_add(1, Ordering::AcqRel);
            if !name_is_a_path(name) && shared.may_descend(&job.path, name) {
                range.push(id, name);
            }
        } else {
            shared.files.fetch_add(1, Ordering::AcqRel);
            shared
                .bytes
                .fetch_add(whole_bytes(meta.size), Ordering::AcqRel);
        }
    }
    shared.queue.push_ranges(range.finish());
}

/// A listing that failed: the root's ends the walk, as in a discovery walk;
/// any other folder's refusal is handed to the sinks unless the walk was
/// cancelled, since a cancel is what ends a listing early.
fn refuse(shared: &Shared, job: &DirJob, why: Refusal) {
    if job.id == 0 {
        shared.root_refused.store(why.code(), Ordering::Release);
        shared.queue.close();
        return;
    }
    let Some(guard) = shared.commit.acquire(shared) else {
        return;
    };
    let _refused = to_sinks(shared, |sink| sink.refused(job.id, why));
    drop(guard);
}

/// Lists one folder and commits it as one block (see the module docs).
pub(crate) fn process_listing(
    shared: &Shared,
    buf: &mut ListBuffer,
    stage: &mut Stage,
    job: &DirJob,
) {
    shared.sample_path(&job.path);
    let mut held = Held::new(&shared.resident);
    let first = shared
        .lister
        .list_until(&job.path, shared.want_atime, buf, BIG_LISTING);
    held.note(buf.listing.len());
    let mut permit = None;
    let listed = match first {
        Ok(Listed::Complete(path)) if buf.listing.len() <= BIG_LISTING => Ok(path),
        Ok(answer) => {
            // A big listing: past the semaphore one at a time, entered with
            // the first batches in hand and before the rest is read (R89).
            let Some(entered) = shared.big.enter(shared) else {
                // Cancelled while waiting: nothing of it is committed, and
                // its cursor is closed now, not when the buffer is next used.
                buf.close_cursor();
                return;
            };
            permit = Some(entered);
            match answer {
                Listed::Complete(path) => Ok(path),
                Listed::More => {
                    let rest = read_rest(shared.lister.as_ref(), buf);
                    held.note(buf.listing.len());
                    rest
                }
            }
        }
        Err(why) => Err(why),
    };
    let big = permit.is_some();
    let path = match listed {
        Ok(path) => path,
        Err(why) => {
            // Refused in whichever batch it failed, as a whole listing is; a
            // big one is let go before the semaphore is (R89).
            if big {
                buf.listing.shrink_to(KEEP_ENTRIES, KEEP_NAME_BYTES);
            }
            drop(held);
            drop(permit);
            refuse(shared, job, why);
            return;
        }
    };
    if job.id == 0 {
        shared.root_fast_path.store(path.code(), Ordering::Release);
    }
    shared.dirs_listed.fetch_add(1, Ordering::AcqRel);
    shared
        .denied_entries
        .fetch_add(buf.listing.denied_entries, Ordering::AcqRel);
    shared
        .unreadable_entries
        .fetch_add(buf.listing.unreadable_entries, Ordering::AcqRel);
    buf.listing.order_as_stored();
    let committed = if big {
        commit_in_chunks(shared, &buf.listing, stage, job.id)
    } else {
        commit_whole(shared, &buf.listing, stage, job.id)
    };
    if let Some(first) = committed {
        account(shared, &buf.listing, first, job);
    }
    if big {
        buf.listing.shrink_to(KEEP_ENTRIES, KEEP_NAME_BYTES);
    }
    // The semaphore is left only once a big listing is let go, so the next
    // one is read in only then (R89); T6 left it after the hand-over.
    drop(held);
    drop(permit);
}

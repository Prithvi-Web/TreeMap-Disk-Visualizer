//! Discovery numbering's listing: one atomic counter hands every entry its
//! id as it is found ([`process_dir`]). Moved out of `walk.rs` unchanged
//! (Phase 4, T6b).

use std::sync::atomic::{AtomicU32, Ordering};

use super::{CHECK_EVERY, Part, Shared, ceiling_fault, child_path, name_is_a_path, whole_bytes};
use crate::links::link_key;
use crate::output::{DirRefusal, Refusal};
use crate::platform::ListBuffer;
use crate::queue::DirJob;
use crate::{FLAG_DATALESS, KIND_DIR};

/// The next node id, or `None` once the counter has reached its ceiling: it
/// never wraps, so no two nodes are numbered alike.
#[cfg(test)]
fn take_id(next_id: &AtomicU32) -> Option<u32> {
    take_id_below(next_id, crate::ID_CEILING)
}

/// The next node id below `ceiling`, or `None` once the counter has reached
/// it: ids `0..ceiling` are handed out, and none twice.
fn take_id_below(next_id: &AtomicU32, ceiling: u32) -> Option<u32> {
    next_id
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |id| {
            (id < ceiling).then(|| id + 1)
        })
        .ok()
}

/// Lists one directory and records what it holds.
pub(super) fn process_dir(
    shared: &Shared,
    part: &mut Part,
    buf: &mut ListBuffer,
    pending: &mut Vec<DirJob>,
    job: &DirJob,
) {
    shared.sample_path(&job.path);
    let path = match shared.lister.list(&job.path, shared.want_atime, buf) {
        Ok(path) => path,
        Err(why) => {
            if job.id == 0 {
                shared.root_refused.store(why.code(), Ordering::Release);
                shared.queue.close();
            } else {
                part.refusals.push(DirRefusal { node: job.id, why });
            }
            return;
        }
    };
    if job.id == 0 {
        shared.root_fast_path.store(path.code(), Ordering::Release);
    }
    shared.dirs_listed.fetch_add(1, Ordering::AcqRel);
    // Numbered in the order the lister hands the entries over: the order is
    // the lister's to decide (the POSIX listers sort; see Listing::sort_by_name).
    let listing = &buf.listing;
    // The root's node already holds its own times (stat_dir reads the root
    // itself), so only a subdirectory's parent-given copy can be stale.
    if let Some(times) = listing.own_times.filter(|_| job.id != 0) {
        part.time_patches.push((job.id, times));
    }
    shared
        .denied_entries
        .fetch_add(listing.denied_entries, Ordering::AcqRel);
    shared
        .unreadable_entries
        .fetch_add(listing.unreadable_entries, Ordering::AcqRel);
    for (k, entry) in listing.entries.iter().enumerate() {
        if k > 0 && k % CHECK_EVERY == 0 && shared.wait_while_paused() {
            pending.clear();
            return;
        }
        let meta = &entry.meta;
        let name = listing.name(entry);
        let Some(id) = take_id_below(&shared.next_id, shared.id_ceiling) else {
            // The columns are full: a wrapped id would overwrite an earlier
            // node's, so the walk ends here as a fault.
            shared.record_fault(ceiling_fault(shared.id_ceiling));
            shared.cancel();
            pending.clear();
            return;
        };
        part.push(id, job.id, name, meta);
        shared.entries.fetch_add(1, Ordering::AcqRel);
        if meta.withheld {
            shared.unreadable_entries.fetch_add(1, Ordering::AcqRel);
        }
        if meta.flags & FLAG_DATALESS != 0 {
            shared.dataless.fetch_add(1, Ordering::AcqRel);
        }
        if meta.kind == KIND_DIR {
            shared.dirs.fetch_add(1, Ordering::AcqRel);
            if name_is_a_path(name) {
                // Joined, the name would become several components and the
                // walk would list somewhere else: refused, exactly as a
                // directory that could not be read is, and never enqueued.
                part.refusals.push(DirRefusal {
                    node: id,
                    why: Refusal::Unreadable,
                });
            } else {
                let child = child_path(&job.path, name);
                if !shared.never_descend.contains(&child) {
                    pending.push(DirJob { id, path: child });
                }
            }
        } else {
            shared.files.fetch_add(1, Ordering::AcqRel);
            shared
                .bytes
                .fetch_add(whole_bytes(meta.size), Ordering::AcqRel);
            if let Some(key) = link_key(meta, id) {
                part.link_keys.push(key);
            }
        }
    }
    shared.queue.push_all(pending);
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use super::*;
    use crate::platform::{Lister, Meta};
    use crate::walk::{ID_CEILING_FAULT, Pacer, lock};
    use crate::{FastPath, KIND_FILE, MIN_BUFFER_BYTES, WalkOptions};

    /// A pacer that does nothing and allows one worker.
    struct IdlePacer;

    impl Pacer for IdlePacer {
        fn on_worker_start(&self) {}
        fn throttle(&self, _cancelled: &dyn Fn() -> bool) {}
        fn worker_limit(&self) -> u32 {
            1
        }
    }

    /// A lister whose every directory holds one file.
    struct OneFile;

    impl Lister for OneFile {
        fn stat_dir(&self, _path: &Path, _want_atime: bool) -> Result<Meta, Refusal> {
            Ok(Meta::unknown(KIND_DIR))
        }

        fn list(
            &self,
            _dir: &Path,
            _want_atime: bool,
            buf: &mut ListBuffer,
        ) -> Result<FastPath, Refusal> {
            buf.listing.clear();
            buf.listing.push(b"only.bin", Meta::unknown(KIND_FILE));
            Ok(FastPath::Unavailable)
        }
    }

    #[test]
    fn the_id_counter_stops_at_its_ceiling_instead_of_wrapping() {
        let next_id = AtomicU32::new(u32::MAX - 1);
        assert_eq!(take_id(&next_id), Some(u32::MAX - 1));
        assert_eq!(take_id(&next_id), None);
        assert_eq!(take_id(&next_id), None, "and stays there");
        assert_eq!(next_id.load(Ordering::Acquire), u32::MAX);
    }

    #[test]
    fn a_directory_past_the_id_ceiling_faults_and_cancels_the_walk() {
        let shared = Shared::new(
            WalkOptions::new("/fake"),
            Arc::new(IdlePacer),
            Arc::new(OneFile),
        );
        shared.next_id.store(u32::MAX, Ordering::Release);
        let mut part = Part::default();
        let mut buf = ListBuffer::new(MIN_BUFFER_BYTES);
        let mut pending = Vec::new();
        let job = DirJob {
            id: 0,
            path: PathBuf::from("/fake"),
        };
        process_dir(&shared, &mut part, &mut buf, &mut pending, &job);
        assert_eq!(lock(&shared.fault).as_deref(), Some(ID_CEILING_FAULT));
        assert!(shared.is_cancelled());
        assert!(pending.is_empty());
        assert!(part.ids.is_empty(), "nothing is numbered past the ceiling");
        assert_eq!(shared.entries.load(Ordering::Acquire), 0);
    }

    #[test]
    fn a_lowered_ceiling_stops_the_counter_there() {
        let next_id = AtomicU32::new(8);
        assert_eq!(take_id_below(&next_id, 10), Some(8));
        assert_eq!(take_id_below(&next_id, 10), Some(9));
        assert_eq!(take_id_below(&next_id, 10), None, "ids 0..10 only");
        assert_eq!(next_id.load(Ordering::Acquire), 10);
    }
}

//! The listing buffer's size rules and the two signals the walk threads through it.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use tm_walk::{DEFAULT_BUFFER_BYTES, ListBuffer, MAX_BUFFER_BYTES, MIN_BUFFER_BYTES};

#[test]
fn zero_means_the_default_and_the_floor_and_ceiling_both_hold() {
    assert_eq!(ListBuffer::new(0).raw.len(), DEFAULT_BUFFER_BYTES);
    assert_eq!(ListBuffer::new(1).raw.len(), MIN_BUFFER_BYTES);
    assert_eq!(
        ListBuffer::new(MAX_BUFFER_BYTES + 1).raw.len(),
        MAX_BUFFER_BYTES,
        "a caller cannot ask a worker to allocate more than the ceiling"
    );
    const { assert!(MIN_BUFFER_BYTES < DEFAULT_BUFFER_BYTES && DEFAULT_BUFFER_BYTES < MAX_BUFFER_BYTES) };
}

#[test]
fn a_fresh_buffer_has_its_own_quiet_signals_and_shared_ones_are_the_walks() {
    let fresh = ListBuffer::new(0);
    assert!(!fresh.stopped());
    assert_eq!(fresh.heartbeat.load(Ordering::Acquire), 0);

    let stop = Arc::new(AtomicBool::new(false));
    let beats = Arc::new(AtomicU64::new(0));
    let shared = ListBuffer::with_signals(0, Arc::clone(&stop), Arc::clone(&beats));
    shared.beat();
    shared.beat();
    assert_eq!(
        beats.load(Ordering::Acquire),
        2,
        "a beat is visible to whoever holds the counter"
    );
    stop.store(true, Ordering::Release);
    assert!(
        shared.stopped(),
        "the walk's cancel is visible inside the listing"
    );
}

/**
 * One holder at a time, across awaits, in the order they asked (FG3f #2).
 *
 * For a read-modify-write of one JSON store: load it, change it, save it. Two of those that overlap
 * each save the document they loaded, and the later save silently drops the earlier one's change —
 * `writeJsonFile` queues writes, but a queue of whole documents does not merge them. A Time Capsule
 * capture that loaded the index, copied for minutes and saved it erased whatever a restore, a
 * "Forget" or another run had recorded meanwhile.
 *
 * Never ask for the same mutex from inside its own `run`: the inner call waits for the outer one,
 * which waits for the inner one, for ever.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;

  /** How many callers are waiting their turn, the holder not counted. */
  get waiting(): number {
    return this.queued;
  }

  /** Runs `fn` once every earlier caller's `fn` has settled, and answers what it answers. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const turn = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queued++;
    return turn.then(async () => {
      this.queued--;
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }
}

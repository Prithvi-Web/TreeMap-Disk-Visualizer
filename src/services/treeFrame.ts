import { constants } from 'node:buffer';
import type { Overshoot } from '../utils/pruneTree';
import { isExpandableId, materializeBare, prunedExpansion, type ScanStore } from './scanStore';

/**
 * The first tree, sent from the store (Phase 4 T9b; plan T9b, RISKS R93).
 *
 * The progress stream's `complete` frame and `/result`'s body carry the
 * pruned tree: 250,000 nodes, 81–86 MB of JSON. (Both prune with
 * `overshoot: 'none'` since plan U-19, so a folder wider than the room left
 * stays `pruned` instead of taking the frame past its budget: on the
 * diagnosis Mac one folder had made it 671,545 nodes and 238.6 MB.) Built
 * the old way — the pruned tree as objects, the whole frame as one string,
 * the socket's UTF-8 copy of it — sending it cost +680 MB in plain Node and
 * +325–410 MB in Electron (T9's measurements). Here the tree is written from
 * the store in chunks instead, byte for byte what `JSON.stringify` wrote:
 *
 *  - `prunedExpansion` finds the folders `pruneStore` expands, with its heap;
 *  - each node is `materializeBare`'s node stringified, with the key
 *    `pruneStore` adds spliced before its closing brace;
 *  - a first pass counts the frame, so it is refused before a byte is written
 *    exactly where today's one string could not have been built;
 *  - the frame is written in chunks while the socket takes them, and waits for
 *    `drain` only when the socket pushes back. A closed socket ends it.
 *
 * The count runs in slices (plan U-18, decision U-D10). It counted every node
 * in one synchronous pass — 0.75 s at load 9 and 3.6 s at load 25 for the
 * diagnosis Mac's 671,545 nodes — and every reader counted again. Now:
 *
 *  - it yields every FRAME_YIELD_NODES nodes, under the store's version: a
 *    change while it waits counts again from the start, at most FRAME_ATTEMPTS
 *    times, the last in one turn (U-D9), so a frame is still one instant of the
 *    store. Its first byte is written in the turn the count ends;
 *  - a tree whose JSON is at most FRAME_BUFFER_MAX characters is gathered as
 *    chunks during that same count and written from them, with no second
 *    pass. Readers that arrive while it is counted share the count, each
 *    writing its own head and tail around the chunks, and the chunks are let
 *    go when the last of them is served: no frame is kept once sent;
 *  - a longer tree holds nothing (what was gathered is dropped at the cap),
 *    and each reader writes its frame from the store in a second pass, T9b's,
 *    which while the socket keeps up is one instant of the store.
 */

/** Characters a chunk gathers before it is written. */
export const TREE_CHUNK_CHARS = 64 * 1024;

/** Nodes the count writes between two turns of the event loop (plan U-18). */
export const FRAME_YIELD_NODES = 4_096;

/**
 * The longest tree, in characters of its JSON, gathered into memory by the
 * count and shared by the readers that wait on it: 32 MiB (decision U-D10).
 * Phase 4 T9b measured holding a 5M-node frame as chunks at +186 MB with the
 * reader keeping up and +282 MB with it stalled, against +43 and +207 MB for
 * two passes, so a longer tree is written from the store again instead.
 */
export const FRAME_BUFFER_MAX = 32 * 1024 * 1024;

/** Counts a build makes before its last, which runs in one turn (decision U-D9). */
export const FRAME_ATTEMPTS = 3;

/**
 * Stands for the tree in a value `jsonAroundTree` splits: a string no scan
 * gives (U+FDD0 is a noncharacter), which `JSON.stringify` leaves as it is.
 */
export const TREE_MARK = '﷐treemap-tree﷐';

export type TreeSendOutcome = 'sent' | 'refused' | 'closed';

/** What the tree is written to: an HTTP response, as a `Writable` has it. */
export interface TreeSink {
  write(chunk: string): boolean;
  once(event: 'drain' | 'close' | 'error', listener: () => void): unknown;
  removeListener(event: 'drain' | 'close' | 'error', listener: () => void): unknown;
  readonly destroyed?: boolean;
  readonly writableEnded?: boolean;
}

let maxCharsForTests: number | null = null;

/** The longest frame sent: V8's longest string, the most today's one-string frame could reach. */
export function treeFrameMaxChars(): number {
  return maxCharsForTests ?? constants.MAX_STRING_LENGTH;
}

/** Tests only: a shorter longest frame, so the refusal can be reached; null restores V8's. */
export function setTreeFrameMaxCharsForTests(chars: number | null): void {
  maxCharsForTests = chars;
}

/** The default turn between two slices of a count. */
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

let yieldForTests: (() => Promise<void>) | null = null;
let bufferMaxForTests: number | null = null;

/** Tests only: what every count awaits between its slices (to hold one, or count them); null restores a turn of the loop. */
export function setFrameYieldForTests(yieldTurn: (() => Promise<void>) | null): void {
  yieldForTests = yieldTurn;
}

/** Tests only: a smaller buffer cap, so a test tree can pass it; null restores FRAME_BUFFER_MAX. */
export function setFrameBufferMaxForTests(chars: number | null): void {
  bufferMaxForTests = chars;
}

function frameBufferMax(): number {
  return bufferMaxForTests ?? FRAME_BUFFER_MAX;
}

/** What the frames sent so far cost, counted: the tests' window on U-D10. */
export interface FrameBuildStats {
  /** Builds started: one count, with the attempts it needed. */
  builds: number;
  /** Counts run, every attempt of every build. */
  attempts: number;
  /** Frames written from a build's chunks. */
  buffered: number;
  /** Frames written from the store in a second pass, past the cap. */
  streamed: number;
  /** Characters of tree JSON held now: chunks gathered by counts that run, and by builds whose readers are not all served. */
  heldChars: number;
  /** Readers waiting now on a count. */
  waiting: number;
}

const stats: FrameBuildStats = { builds: 0, attempts: 0, buffered: 0, streamed: 0, heldChars: 0, waiting: 0 };

/** The counters as they stand. */
export function frameBuildStats(): FrameBuildStats {
  return { ...stats };
}

/**
 * `JSON.stringify(value)` split where `TREE_MARK` stands: the text before the
 * tree and after it, so `before + JSON.stringify(tree) + after` is `value`
 * with the tree in the mark's place. Throws unless the mark appears exactly once.
 */
export function jsonAroundTree(value: object): [string, string] {
  const json = JSON.stringify(value);
  const mark = JSON.stringify(TREE_MARK);
  const at = json.indexOf(mark);
  if (at < 0 || json.indexOf(mark, at + mark.length) >= 0) {
    throw new Error('jsonAroundTree: the value must hold TREE_MARK exactly once');
  }
  return [json.slice(0, at), json.slice(at + mark.length)];
}

/** An expanded folder being written: its children, the next to write, and its path (theirs start with it). */
interface OpenFolder {
  kids: number[];
  next: number;
  path: string;
}

/**
 * `pruneStore(store, rootId, { maxNodes, overshoot }).root`'s JSON, as
 * `JSON.stringify` writes it, in pieces, with a stack of its own (so any depth
 * goes), from the folders `prunedExpansion` names. A folder
 * `pruneStore` expands gets `"children":[…]`, one it does not `"pruned":true`,
 * an empty one `"children":[]` — each where `pruneStore` adds the key, after
 * the node's own.
 */
class PrunedJson {
  private readonly open: OpenFolder[] = [];
  private started = false;
  private given = 0;

  constructor(
    private readonly store: ScanStore,
    private readonly rootId: number,
    private readonly expanded: ReadonlySet<number>,
  ) {}

  /** Whether every piece has been given. */
  get done(): boolean {
    return this.started && this.open.length === 0;
  }

  /** Nodes given so far. */
  get nodes(): number {
    return this.given;
  }

  /**
   * Appends pieces to `parts` until at least `chars` characters are gathered,
   * the tree is out, or the next piece would be a node past the `nodeLimit`th;
   * how many characters were. A folder's closing comes with its last child.
   */
  fill(parts: string[], chars: number, nodeLimit = Number.POSITIVE_INFINITY): number {
    let gathered = 0;
    const emit = (piece: string): void => {
      parts.push(piece);
      gathered += piece.length;
    };
    if (!this.started) {
      this.started = true;
      this.node(this.rootId, undefined, emit);
    }
    while (this.open.length > 0 && gathered < chars) {
      const folder = this.open[this.open.length - 1];
      if (folder.next === folder.kids.length) {
        emit(']}');
        this.open.pop();
        continue;
      }
      if (this.given >= nodeLimit) break;
      if (folder.next > 0) emit(',');
      const kid = folder.kids[folder.next++];
      this.node(kid, this.store.childPath(kid, folder.path), emit);
    }
    return gathered;
  }

  private node(id: number, knownPath: string | undefined, emit: (piece: string) => void): void {
    this.given++;
    const node = materializeBare(this.store, id, knownPath);
    const json = JSON.stringify(node);
    if (this.expanded.has(id)) {
      emit(`${json.slice(0, -1)},"children":[`);
      this.open.push({ kids: this.store.childIds(id), next: 0, path: node.path });
    } else if (isExpandableId(this.store, id)) {
      emit(`${json.slice(0, -1)},"pruned":true}`);
    } else if (this.store.hasChildArray(id) && this.store.childCount(id) === 0) {
      emit(`${json.slice(0, -1)},"children":[]}`);
    } else {
      emit(json);
    }
  }
}

function isClosed(out: TreeSink): boolean {
  return out.destroyed === true || out.writableEnded === true;
}

/** Resolves true when `out` drains, false when it closes or fails first. */
function drained(out: TreeSink): Promise<boolean> {
  if (isClosed(out)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const settle = (ok: boolean): void => {
      out.removeListener('drain', onDrain);
      out.removeListener('close', onClose);
      out.removeListener('error', onClose);
      resolve(ok);
    };
    const onDrain = (): void => settle(true);
    const onClose = (): void => settle(false);
    out.once('drain', onDrain);
    out.once('close', onClose);
    out.once('error', onClose);
  });
}

/**
 * A tree's JSON as a count gathers it: every character counted, and the
 * chunks kept while the whole so far is within `cap`. Past the cap what was
 * kept is dropped and nothing more is.
 */
class Gathered {
  chars = 0;
  chunks: string[] | null = [];
  private held = 0;
  private pieces: string[] = [];
  private piecesChars = 0;

  constructor(private readonly cap: number) {}

  /** Counts `tree` until it is out, or until its next piece is a node past the `nodeLimit`th (a folder's closing comes with its last child). */
  take(tree: PrunedJson, nodeLimit: number): void {
    for (;;) {
      const room = TREE_CHUNK_CHARS - this.piecesChars;
      const got = tree.fill(this.pieces, room, nodeLimit);
      this.piecesChars += got;
      this.chars += got;
      if (this.piecesChars >= TREE_CHUNK_CHARS || tree.done) this.close();
      // Short of the room and not out: the next piece is a node past the limit.
      if (tree.done || got < room) return;
    }
  }

  /** Lets go of every chunk kept. */
  drop(): void {
    stats.heldChars -= this.held;
    this.held = 0;
    this.chunks = null;
  }

  private close(): void {
    const chunk = this.pieces.join('');
    this.pieces = [];
    this.piecesChars = 0;
    if (this.chunks === null) return;
    if (this.chars > this.cap) {
      this.drop();
      return;
    }
    this.chunks.push(chunk);
    this.held += chunk.length;
    stats.heldChars += chunk.length;
  }
}

/** A tree counted once, at one version of its store. */
interface CountedTree {
  readonly version: number;
  readonly expanded: ReadonlySet<number>;
  /** Characters of the tree's JSON. */
  readonly chars: number;
  /** The tree's JSON, when it is within the cap, until the last reader is served; null past the cap, and once let go. */
  chunks: string[] | null;
}

/** A count in flight and the readers that will write from it. */
interface FrameJob {
  readonly counted: Promise<CountedTree>;
  readers: number;
}

/**
 * Counts in flight, per store, by root, budget and rule. An entry lives only
 * while its count runs: a reader that comes once it has ended counts again.
 */
const inFlight = new WeakMap<ScanStore, Map<string, FrameJob>>();

/**
 * Counts `rootId`'s tree under `maxNodes` and `overshoot` in slices (see the
 * module's note): the expansion, the length, and the chunks while within the
 * cap. The version is read before each attempt and checked after each yield,
 * and the last attempt does not yield, so what it answers is the store at
 * `version`, unchanged since, in the turn it answers.
 */
async function countTree(
  store: ScanStore,
  rootId: number,
  maxNodes: number,
  overshoot: Overshoot,
  yieldTurn: () => Promise<void>,
): Promise<CountedTree> {
  stats.builds++;
  for (let attempt = 1; ; attempt++) {
    stats.attempts++;
    const oneTurn = attempt >= FRAME_ATTEMPTS;
    const version = store.version;
    const expanded = prunedExpansion(store, rootId, { maxNodes, overshoot });
    const tree = new PrunedJson(store, rootId, expanded);
    const gathered = new Gathered(frameBufferMax());
    let changed = false;
    try {
      while (!tree.done) {
        gathered.take(tree, oneTurn ? Number.POSITIVE_INFINITY : tree.nodes + FRAME_YIELD_NODES);
        if (oneTurn) continue;
        await yieldTurn();
        if (store.version !== version) {
          changed = true;
          break;
        }
      }
    } catch (err) {
      gathered.drop();
      throw err;
    }
    if (changed) {
      gathered.drop();
      continue;
    }
    return { version, expanded, chars: gathered.chars, chunks: gathered.chunks };
  }
}

/** The count of this tree in flight, joined, or a new one started; the caller is one more reader of it. */
function joinCount(
  store: ScanStore,
  rootId: number,
  maxNodes: number,
  overshoot: Overshoot,
  yieldTurn: () => Promise<void>,
): FrameJob {
  let jobs = inFlight.get(store);
  if (!jobs) {
    jobs = new Map();
    inFlight.set(store, jobs);
  }
  const key = `${rootId}:${maxNodes}:${overshoot}`;
  let job = jobs.get(key);
  if (!job) {
    const started: FrameJob = { counted: countTree(store, rootId, maxNodes, overshoot, yieldTurn), readers: 0 };
    const ended = (): void => {
      if (jobs.get(key) === started) jobs.delete(key);
    };
    // Registered before any reader's, so the entry is gone before a reader
    // writes: a later reader counts again.
    started.counted.then(ended, ended);
    jobs.set(key, started);
    job = started;
  }
  job.readers++;
  return job;
}

/** A reader done with `job`: the last lets go of the chunks. */
function leave(job: FrameJob, counted: CountedTree | null): void {
  job.readers--;
  if (job.readers > 0 || !counted?.chunks) return;
  stats.heldChars -= counted.chars;
  counted.chunks = null;
}

/** Writes `head`, `chunks` and `tail` to `out`, honouring its backpressure. */
async function writeChunks(
  out: TreeSink,
  head: string,
  chunks: readonly string[],
  tail: string,
  onFirstByte: () => void,
): Promise<TreeSendOutcome> {
  const last = chunks.length - 1;
  for (let i = 0; ; i++) {
    let chunk = chunks[i];
    if (i === 0) chunk = head + chunk;
    if (i === last) chunk += tail;
    if (isClosed(out)) return 'closed';
    if (i === 0) onFirstByte();
    const takesMore = out.write(chunk);
    if (i === last) return 'sent';
    if (!takesMore && !(await drained(out))) return 'closed';
  }
}

/** Writes `head`, the tree's JSON from the store, and `tail` to `out` (T9b's second pass), honouring its backpressure. */
async function writeFromStore(
  out: TreeSink,
  store: ScanStore,
  rootId: number,
  expanded: ReadonlySet<number>,
  head: string,
  tail: string,
  onFirstByte: () => void,
): Promise<TreeSendOutcome> {
  const tree = new PrunedJson(store, rootId, expanded);
  let parts = [head];
  let gathered = head.length;
  for (let first = true; ; first = false) {
    gathered += tree.fill(parts, TREE_CHUNK_CHARS - gathered);
    const last = tree.done;
    if (last) parts.push(tail);
    const chunk = parts.join('');
    parts = [];
    gathered = 0;
    if (isClosed(out)) return 'closed';
    if (first) onFirstByte();
    const takesMore = out.write(chunk);
    if (last) return 'sent';
    if (!takesMore && !(await drained(out))) return 'closed';
  }
}

/** How a tree is sent. */
export interface SendTreeOptions {
  /** The prune's rule for the last folder (`PruneOptions.overshoot`): today's `'lastFolder'` unless set. */
  overshoot?: Overshoot;
  /** What a count started for this reader awaits between its slices: a turn of the loop unless set. */
  yieldTurn?: () => Promise<void>;
  /** Called once, in the same turn, just before the frame's first byte is written. */
  onFirstByte?: () => void;
}

/**
 * Writes `head`, then `pruneStore(store, rootId, { maxNodes, overshoot }).root`'s
 * JSON byte for byte, then `tail`, to `out` in chunks (see the module's note).
 * `'refused'`, with nothing written, when the whole would be longer than
 * `treeFrameMaxChars()`; `'closed'` when `out` closed first; else `'sent'`.
 * The caller ends `out`.
 */
export async function sendPrunedTree(
  out: TreeSink,
  store: ScanStore,
  rootId: number,
  maxNodes: number,
  head: string,
  tail: string,
  options: SendTreeOptions = {},
): Promise<TreeSendOutcome> {
  const overshoot = options.overshoot ?? 'lastFolder';
  const yieldTurn = options.yieldTurn ?? yieldForTests ?? nextTurn;
  const onFirstByte = options.onFirstByte ?? ((): void => {});
  for (;;) {
    const job = joinCount(store, rootId, maxNodes, overshoot, yieldTurn);
    stats.waiting++;
    let counted: CountedTree;
    try {
      counted = await job.counted;
    } catch (err) {
      leave(job, null);
      throw err;
    } finally {
      stats.waiting--;
    }
    try {
      // A tree written from the store must be written at the version it was
      // counted at; a reader let through after a change counts again.
      if (counted.chunks === null && store.version !== counted.version) continue;
      if (head.length + counted.chars + tail.length > treeFrameMaxChars()) return 'refused';
      if (counted.chunks !== null) {
        stats.buffered++;
        return await writeChunks(out, head, counted.chunks, tail, onFirstByte);
      }
      stats.streamed++;
      return await writeFromStore(out, store, rootId, counted.expanded, head, tail, onFirstByte);
    } finally {
      leave(job, counted);
    }
  }
}

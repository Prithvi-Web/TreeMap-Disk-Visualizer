import { constants } from 'node:buffer';
import { isExpandableId, materializeBare, prunedExpansion, type ScanStore } from './scanStore';

/**
 * The first tree, sent from the store (Phase 4 T9b; plan T9b, RISKS R93).
 *
 * The progress stream's `complete` frame and `/result`'s body carry the
 * pruned tree: 250,000 nodes, 81–86 MB of JSON. Built the old way — the
 * pruned tree as objects, the whole frame as one string, the socket's UTF-8
 * copy of it — sending it cost +680 MB in plain Node and +325–410 MB in
 * Electron (T9's measurements). Here the tree is written from the store in
 * chunks instead, byte for byte what `JSON.stringify` wrote:
 *
 *  - `prunedExpansion` finds the folders `pruneStore` expands, with its heap;
 *  - each node is `materializeBare`'s node stringified, with the key
 *    `pruneStore` adds spliced before its closing brace;
 *  - a first pass counts the frame, so it is refused before a byte is written
 *    exactly where today's one string could not have been built;
 *  - the second writes chunks while the socket takes them — the frame is one
 *    instant of the store, as it was, whenever the reader keeps up — and waits
 *    for `drain` only when the socket pushes back. A closed socket ends it.
 */

/** Characters a chunk gathers before it is written. */
export const TREE_CHUNK_CHARS = 64 * 1024;

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
 * `pruneStore(store, rootId, { maxNodes }).root`'s JSON, as `JSON.stringify`
 * writes it, in pieces, with a stack of its own (so any depth goes). A folder
 * `pruneStore` expands gets `"children":[…]`, one it does not `"pruned":true`,
 * an empty one `"children":[]` — each where `pruneStore` adds the key, after
 * the node's own.
 */
class PrunedJson {
  private readonly open: OpenFolder[] = [];
  private started = false;

  constructor(
    private readonly store: ScanStore,
    private readonly rootId: number,
    private readonly expanded: ReadonlySet<number>,
  ) {}

  /** Whether every piece has been given. */
  get done(): boolean {
    return this.started && this.open.length === 0;
  }

  /** Appends pieces to `parts` until at least `chars` characters are gathered or the tree is out; how many were. */
  fill(parts: string[], chars: number): number {
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
      if (folder.next > 0) emit(',');
      const kid = folder.kids[folder.next++];
      this.node(kid, this.store.childPath(kid, folder.path), emit);
    }
    return gathered;
  }

  private node(id: number, knownPath: string | undefined, emit: (piece: string) => void): void {
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
 * Writes `head`, then `pruneStore(store, rootId, { maxNodes }).root`'s JSON
 * byte for byte, then `tail`, to `out` in chunks (see the module's note).
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
): Promise<TreeSendOutcome> {
  const expanded = prunedExpansion(store, rootId, { maxNodes });
  let length = head.length + tail.length;
  const counted = new PrunedJson(store, rootId, expanded);
  const scratch: string[] = [];
  while (!counted.done) {
    length += counted.fill(scratch, TREE_CHUNK_CHARS);
    scratch.length = 0;
  }
  if (length > treeFrameMaxChars()) return 'refused';

  const tree = new PrunedJson(store, rootId, expanded);
  let parts = [head];
  let gathered = head.length;
  for (;;) {
    gathered += tree.fill(parts, TREE_CHUNK_CHARS - gathered);
    const last = tree.done;
    if (last) parts.push(tail);
    const chunk = parts.join('');
    parts = [];
    gathered = 0;
    if (isClosed(out)) return 'closed';
    const takesMore = out.write(chunk);
    if (last) return 'sent';
    if (!takesMore && !(await drained(out))) return 'closed';
  }
}

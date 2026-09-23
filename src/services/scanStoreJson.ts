import { isExpandableId, materializeBare, type ScanStore } from './scanStore';

/** About how many characters `streamTreeJson` gathers before each write: a few milliseconds of work. */
export const TREE_JSON_CHUNK_CHARS = 256 * 1024;

/** One directory (or expanded container) whose children are being written. */
interface Frame {
  kids: number[];
  next: number;
  path: string;
}

/**
 * The whole tree under `id` as JSON — byte for byte
 * `JSON.stringify(pruneStore(store, id, { maxNodes: Number.MAX_SAFE_INTEGER }).root)`,
 * which is what `scan.root` serialises to — handed to `write` in chunks of
 * about `chunkChars`, without building the tree or the whole string.
 *
 * Why: the fast-rescan cache was that JSON.stringify of `scan.root`, run as a
 * scan completed. On a 200,000-entry tree (M3, 23 September 2026) building
 * the tree took 69 ms and stringifying it (48 MB) 80 ms: two freezes of the
 * event loop the moment a scan finished, the first before anything could see
 * that it had. And JSON.stringify recurses, so a tree a few thousand levels
 * deep never got a cache at all.
 *
 * Byte-identical by construction: every node is built by the same
 * `materializeBare` a prune uses and stringified alone, and `children` — the
 * one key a prune adds after the node's own, always last because `pruned` is
 * deleted as they arrive — is spliced in where that node's closing brace was.
 * With no node budget a prune expands every expandable node and lists its
 * children in child-id order, which is the order written here.
 *
 * Each `write` is awaited, so the event loop runs between chunks, and the
 * store may change meanwhile (a delete, a watcher, a container expansion). A
 * document spanning two versions would describe a tree that never existed,
 * so a change seen after a write stops the stream: false, and the caller
 * discards what was written. True: the document is complete, and describes
 * the store as it was when its last piece was built.
 */
export async function streamTreeJson(
  store: ScanStore,
  id: number,
  write: (chunk: string) => Promise<void>,
  opts: { chunkChars?: number } = {},
): Promise<boolean> {
  const chunkChars = Math.max(1, opts.chunkChars ?? TREE_JSON_CHUNK_CHARS);
  const version = store.version;
  const stack: Frame[] = [];
  let buf = '';
  const emit = (nodeId: number, knownPath?: string): void => {
    const node = materializeBare(store, nodeId, knownPath);
    const json = JSON.stringify(node);
    if (isExpandableId(store, nodeId)) {
      buf += `${json.slice(0, -1)},"children":[`;
      stack.push({ kids: store.childIds(nodeId), next: 0, path: node.path });
    } else if (store.hasChildArray(nodeId) && store.childCount(nodeId) === 0) {
      buf += `${json.slice(0, -1)},"children":[]}`;
    } else {
      buf += json;
    }
  };

  emit(id);
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.next < top.kids.length) {
      if (top.next > 0) buf += ',';
      const kid = top.kids[top.next++];
      emit(kid, store.childPath(kid, top.path));
    } else {
      buf += ']}';
      stack.pop();
    }
    // Only while more is to be built: the version check guards the pieces
    // not yet built, and the last one is written below.
    if (buf.length >= chunkChars && stack.length > 0) {
      await write(buf);
      buf = '';
      if (store.version !== version) return false;
    }
  }
  if (buf.length > 0) await write(buf);
  return true;
}

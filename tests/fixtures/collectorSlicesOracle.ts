import { LargeFolder } from '../../src/models/types';
import { TreeSource, asStore } from '../../src/services/scanStore';

/**
 * The three dashboard collectors as they were before Track U U-17 sliced them
 * (main bc809a2, `src/services/diskScanner.ts`), copied verbatim so
 * `tests/collectorSlices.test.ts` can hold the rewritten walks — sliced and
 * drained — to them byte for byte. Never "fix" this file to match the new
 * code: a difference is the finding.
 */

export function oracleLargestFiles(source: TreeSource, limit: number, minSize: number) {
  const store = asStore(source);
  interface Hit { id: number; size: number }
  const top: Hit[] = [];
  // Simple bounded insertion keeps memory flat even for huge trees.
  store.eachFile(store.rootId, (id) => {
    const size = store.size(id);
    if (size < minSize) return;
    if (top.length < limit) {
      top.push({ id, size });
      if (top.length === limit) top.sort((a, b) => b.size - a.size);
    } else if (size > top[top.length - 1].size) {
      top[top.length - 1] = { id, size };
      top.sort((a, b) => b.size - a.size);
    }
  });
  top.sort((a, b) => b.size - a.size);
  return top.map(({ id, size }) => ({
    name: store.name(id),
    path: store.path(id),
    size,
    extension: store.extension(id),
    modifiedAt: store.modifiedAt(id),
  }));
}

export function oracleLargestFolders(source: TreeSource, limit: number, minSize: number): LargeFolder[] {
  const store = asStore(source);
  const found: LargeFolder[] = [];
  // Post-order with an explicit stack (no recursion on deep trees): each
  // frame accumulates its subtree's recursive file count as children finish.
  interface Frame { id: number; kids: number[]; next: number; count: number }
  const frame = (id: number): Frame => ({ id, kids: store.isDir(id) ? store.childIds(id) : [], next: 0, count: 0 });
  const stack: Frame[] = [frame(store.rootId)];
  while (stack.length) {
    const f = stack[stack.length - 1];
    if (!store.isDir(f.id)) {
      // A file (containers included — their listings are not files on disk).
      stack.pop();
      if (stack.length) stack[stack.length - 1].count += 1;
      continue;
    }
    if (f.next < f.kids.length) {
      stack.push(frame(f.kids[f.next++]));
      continue;
    }
    stack.pop();
    if (stack.length) {
      const size = store.size(f.id);
      if (size >= minSize) {
        found.push({
          name: store.name(f.id),
          path: store.path(f.id),
          size,
          fileCount: f.count,
          modifiedAt: store.modifiedAt(f.id),
        });
      }
      stack[stack.length - 1].count += f.count;
    }
  }
  return found.sort((a, b) => b.size - a.size).slice(0, limit);
}

export function oracleFileTypes(source: TreeSource) {
  const store = asStore(source);
  const byExt = new Map<string, { count: number; totalSize: number }>();
  store.eachFile(store.rootId, (id) => {
    const ext = store.extension(id) ?? '(none)';
    const entry = byExt.get(ext) ?? { count: 0, totalSize: 0 };
    entry.count++;
    entry.totalSize += store.size(id);
    byExt.set(ext, entry);
  });
  return [...byExt.entries()]
    .map(([ext, v]) => ({ ext, count: v.count, totalSize: v.totalSize }))
    .sort((a, b) => b.totalSize - a.totalSize);
}

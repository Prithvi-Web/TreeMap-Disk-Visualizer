import { FileNode, ScanResult } from '../../models/types';
import { createScanRecord } from '../diskScanner';
import { saveSnapshot } from '../snapshots';
import { providerById, tokenFor, cloudRootPath } from './providers';
import { findNodeByPath } from '../../utils/treemap';
import { AppError } from '../../middleware/errorHandler';

/**
 * cloud/cloudScan — a cloud listing that REGISTERS AS A SCAN. The record
 * lives in the regular scan store, so the progress SSE, result, treemap,
 * grid, file-types and search all work on it unchanged. Snapshots save too,
 * which means Trends and the time slider work across cloud scans for free.
 */

export async function startCloudScan(providerId: string): Promise<ScanResult> {
  const provider = providerById(providerId);
  const token = await tokenFor(provider); // fails fast when not connected

  const scan = createScanRecord(cloudRootPath(provider.id));
  scan.engine = 'cloud';

  void (async () => {
    try {
      const root = await provider.listTree(token, scan);
      if (scan.cancelled) return;
      scan.root = root;
      scan.status = 'complete';
      scan.finishedAt = Date.now();
      scan.currentPath = scan.rootPath;
      void saveSnapshot(scan).catch((err: unknown) => {
        console.error('[treemap] cloud snapshot save failed:', err);
      });
    } catch (err) {
      scan.status = 'error';
      scan.error = err instanceof Error ? err.message : String(err);
      scan.finishedAt = Date.now();
    }
  })();

  return scan;
}

/**
 * Move cloud entries to the provider's own trash (mirroring the local
 * trash-only rule), then prune them from the in-memory tree so re-fetched
 * layouts reflect the deletion.
 */
export async function trashCloudPaths(
  scan: ScanResult & { root: FileNode },
  paths: string[],
): Promise<{ deleted: string[]; failed: { path: string; reason: string }[] }> {
  const providerId = scan.rootPath.replace('cloud://', '');
  const provider = providerById(providerId);
  const token = await tokenFor(provider);

  const deleted: string[] = [];
  const failed: { path: string; reason: string }[] = [];
  for (const p of paths) {
    try {
      const node = findNodeByPath(scan.root, p);
      if (!node) throw new AppError(404, 'PATH_NOT_FOUND', 'not in this scan');
      if (!node.cloudId) throw new AppError(400, 'NO_CLOUD_ID', 'this entry has no provider id');
      await provider.trash(token, node.cloudId);
      pruneNode(scan.root, p, node.size);
      deleted.push(p);
    } catch (err) {
      failed.push({ path: p, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { deleted, failed };
}

/** Remove a node from the tree and shrink every ancestor by its size. */
function pruneNode(root: FileNode, targetPath: string, size: number): void {
  const parentPath = targetPath.slice(0, targetPath.lastIndexOf('/'));
  const parent = parentPath === root.path ? root : findNodeByPath(root, parentPath);
  if (parent?.children) {
    parent.children = parent.children.filter((c) => c.path !== targetPath);
  }
  let p = parentPath;
  for (;;) {
    const dir = p === root.path ? root : findNodeByPath(root, p);
    if (dir) dir.size -= size;
    if (p === root.path) break;
    const up = p.slice(0, p.lastIndexOf('/'));
    if (up === p || up.length < root.path.length) break;
    p = up;
  }
}

import { FileNode, ScanResult } from '../../models/types';
import { createScanRecord } from '../diskScanner';
import { saveSnapshot } from '../snapshots';
import { providerById, tokenFor, cloudRootPath } from './providers';
import { findNodeByPath } from '../../utils/treemap';
import { AppError } from '../../middleware/errorHandler';
import { buildStoreFromTree, ScanStore } from '../scanStore';

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
      let root: FileNode;
      try {
        root = await provider.listTree(token, scan);
      } catch (err) {
        // A token can 401 mid-listing even when it looked fresh (clock skew,
        // revoke-and-reissue). Force one refresh and restart the listing.
        if (err instanceof AppError && err.code === 'CLOUD_AUTH' && !scan.cancelled) {
          const retryToken = await tokenFor(provider, true);
          scan.scanned = 0;
          root = await provider.listTree(retryToken, scan);
        } else {
          throw err;
        }
      }
      if (scan.cancelled) return;
      // Pack the listing: the provider's FileNode tree is bounded (one
      // account's metadata), and once packed it can be dropped for GC.
      scan.store = buildStoreFromTree(root, '/');
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
      if (scan.store) {
        await trashOneInStore(scan.store, provider.trash.bind(provider), token, p);
      } else {
        const node = findNodeByPath(scan.root, p);
        if (!node) throw new AppError(404, 'PATH_NOT_FOUND', 'not in this scan');
        if (!node.cloudId) throw new AppError(400, 'NO_CLOUD_ID', 'this entry has no provider id');
        await provider.trash(token, node.cloudId);
        pruneNode(scan.root, p, node.size);
      }
      deleted.push(p);
    } catch (err) {
      failed.push({ path: p, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { deleted, failed };
}

/** Trash one store-backed entry, then prune it and shrink every ancestor. */
async function trashOneInStore(
  store: ScanStore,
  trash: (token: string, cloudId: string) => Promise<void>,
  token: string,
  p: string,
): Promise<void> {
  const id = store.findByPath(p);
  if (id === -1) throw new AppError(404, 'PATH_NOT_FOUND', 'not in this scan');
  const cloudId = store.cloudId(id);
  if (!cloudId) throw new AppError(400, 'NO_CLOUD_ID', 'this entry has no provider id');
  await trash(token, cloudId);
  const size = store.size(id);
  store.removeNode(id);
  for (let a = store.parent(id); a !== -1; a = store.parent(a)) {
    store.addToSize(a, -size);
  }
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

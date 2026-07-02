import { ContainerKind } from '../models/types';

/**
 * containerKind — which files/bundles the treemap can drill into as
 * containers. Pure name-based detection, shared by the scanner (tagging)
 * and the ContainerScanner service (dispatch).
 */

/** Docker Desktop's disk image basenames (macOS/Windows data roots). */
const DOCKER_DATA_FILES = new Set(['docker.raw', 'docker.qcow2', 'ext4.vhdx', 'docker_data.vhdx']);

export function detectContainerKind(name: string, isDir: boolean): ContainerKind | undefined {
  const lower = name.toLowerCase();
  if (isDir) {
    if (lower.endsWith('.photoslibrary')) return 'photos';
    return undefined;
  }
  if (DOCKER_DATA_FILES.has(lower)) return 'docker';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tgz';
  if (lower.endsWith('.zip') || lower.endsWith('.jar')) return 'zip';
  if (lower.endsWith('.tar')) return 'tar';
  if (lower.endsWith('.iso')) return 'iso';
  if (lower.endsWith('.dmg')) return 'dmg';
  return undefined;
}

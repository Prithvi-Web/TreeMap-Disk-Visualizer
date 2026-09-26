import { ContainerKind } from '../models/types';

/**
 * containerKind — which files/bundles the treemap can drill into as
 * containers. Pure name-based detection, shared by the scanner (tagging)
 * and the ContainerScanner service (dispatch).
 */

/**
 * One container rule: a name that equals the text (`wholeName`) or ends with
 * it, ignoring case, is a container of `kind` — for folders only, or for
 * everything else. Each text is lower-case ASCII with a dot, because the
 * native store (tm-store's `ContainerRule`) reads this same table, handed over
 * at `scanStart`, and decides an ASCII name's container from it.
 */
export interface ContainerRule {
  text: string;
  wholeName: boolean;
  folders: boolean;
  kind: ContainerKind;
}

/**
 * `detectContainerKind`'s rules, in its order: the first rule a name meets
 * decides. Docker Desktop's disk images (macOS/Windows data roots) are known
 * by their whole names.
 */
export const CONTAINER_RULES: readonly ContainerRule[] = [
  { text: '.photoslibrary', wholeName: false, folders: true, kind: 'photos' },
  { text: 'docker.raw', wholeName: true, folders: false, kind: 'docker' },
  { text: 'docker.qcow2', wholeName: true, folders: false, kind: 'docker' },
  { text: 'ext4.vhdx', wholeName: true, folders: false, kind: 'docker' },
  { text: 'docker_data.vhdx', wholeName: true, folders: false, kind: 'docker' },
  { text: '.tar.gz', wholeName: false, folders: false, kind: 'tgz' },
  { text: '.tgz', wholeName: false, folders: false, kind: 'tgz' },
  { text: '.zip', wholeName: false, folders: false, kind: 'zip' },
  { text: '.jar', wholeName: false, folders: false, kind: 'zip' },
  { text: '.tar', wholeName: false, folders: false, kind: 'tar' },
  { text: '.iso', wholeName: false, folders: false, kind: 'iso' },
  { text: '.dmg', wholeName: false, folders: false, kind: 'dmg' },
];

/**
 * What follows the last dot of every name a rule can match, lower-cased.
 * Checked first: nearly every name a scan sees has none of them, and costs
 * one lastIndexOf and a short slice instead of lower-casing the whole name
 * and a walk over the rules. Derived from the rules, so a new rule is found.
 */
const CONTAINER_SUFFIXES = new Set(CONTAINER_RULES.map((rule) => rule.text.slice(rule.text.lastIndexOf('.') + 1)));

export function detectContainerKind(name: string, isDir: boolean): ContainerKind | undefined {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || !CONTAINER_SUFFIXES.has(name.slice(dot + 1).toLowerCase())) return undefined;
  const lower = name.toLowerCase();
  for (const rule of CONTAINER_RULES) {
    if (rule.folders !== isDir) continue;
    if (rule.wholeName ? lower === rule.text : lower.endsWith(rule.text)) return rule.kind;
  }
  return undefined;
}

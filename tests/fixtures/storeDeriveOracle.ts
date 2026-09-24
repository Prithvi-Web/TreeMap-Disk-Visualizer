import fs from 'node:fs';
import path from 'node:path';
import { statToInput } from '../../src/services/scan/nodeInput';
import type { ContainerKind } from '../../src/models/types';

/**
 * The answers `statToInput` gives for names the native store (tm-store) decides
 * itself — every name that is all ASCII — written to a file the store's Rust
 * tests read, so the two sides are held to one answer per name. The names are
 * every one of one to three of `tests/nodeInput.test.ts`'s ASCII tokens (dots
 * at the start, the end and doubled; container suffixes in mixed case; a
 * space). `tests/storeDeriveOracle.test.ts` fails when the file and the
 * TypeScript disagree; regenerate with `npx tsx tests/fixtures/storeDeriveOracle.ts`.
 */

/** `CONTAINER_ID` in `src/services/scanStore.ts`: the store's container column. */
const KIND_ID: Record<ContainerKind, number> = { zip: 1, tar: 2, tgz: 3, iso: 4, dmg: 5, photos: 6, docker: 7 };

export const ASCII_TOKENS: readonly string[] = [
  '.', '..', 'a', 'Z', 'zip', '.zip', '.ZIP', '.tar', '.Tar', '.gz', '.tgz', '.jar', '.iso', '.DMG',
  '.raw', '.qcow2', '.vhdx', 'docker', 'ext4', 'docker_data', '.photoslibrary', '.PhotosLibrary', ' ',
];

export const ORACLE_PATH = path.join(
  __dirname, '..', '..', 'native', 'treemap-core', 'crates', 'tm-store', 'tests', 'fixtures', 'derive-oracle.tsv',
);

/**
 * One line per distinct name: the name, a file's extension ('' for none), a
 * file's container kind, a folder's, and whether it is hidden (1 or 0),
 * tab-separated.
 */
export function oracleText(): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  const add = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const file = statToInput(name, false, 1, 0);
    const folder = statToInput(name, true, 0, 0);
    const kind = (k: ContainerKind | undefined): number => (k ? KIND_ID[k] : 0);
    lines.push([name, file.extension ?? '', kind(file.container), kind(folder.container), file.isHidden ? 1 : 0].join('\t'));
  };
  for (const a of ASCII_TOKENS) {
    add(a);
    for (const b of ASCII_TOKENS) {
      add(a + b);
      for (const c of ASCII_TOKENS) add(a + b + c);
    }
  }
  return lines.join('\n') + '\n';
}

if (require.main === module) {
  fs.mkdirSync(path.dirname(ORACLE_PATH), { recursive: true });
  fs.writeFileSync(ORACLE_PATH, oracleText());
  process.stdout.write(`wrote ${ORACLE_PATH}\n`);
}

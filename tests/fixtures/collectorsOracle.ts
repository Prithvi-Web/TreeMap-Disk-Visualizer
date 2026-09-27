import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as NativeCore from '../../native/index';
import { collectFileTypes, collectLargestFiles, collectLargestFolders, createScanRecord } from '../../src/services/diskScanner';
import { loadNative } from '../../src/services/scan/native';
import { ingestColumns, rootName } from '../../src/services/scan/nativeEngine';
import { statToInput } from '../../src/services/scan/nodeInput';
import { BUCKETS, bucketFor } from '../../src/services/reclaimInputs';
import { PackedScanStore } from '../../src/services/scanStore';

/**
 * The collectors' oracle (Phase 4, task T12b): what `collectLargestFiles`,
 * `collectLargestFolders`, `collectFileTypes` (diskScanner.ts) and the size
 * histogram's buckets (reclaimInputs.ts) answer for a few synthetic trees,
 * walked by the native engine and built into the store the columns path
 * builds, written to a file tm-store's Rust tests read
 * (`native/treemap-core/crates/tm-store/tests/fixtures/collectors-oracle.tsv`).
 * There the Rust port of the collectors — the oracle AggregateState is held
 * to — must give the same text for the same trees.
 *
 * Every limit and minimum size the routes ask for is the full list (KEEP
 * entries, minimum 0) cut short at the minimum and the limit;
 * `tests/collectorsOracle.test.ts` checks that over a grid, so the file holds
 * each tree's full lists. The synthetic lister sorts every listing by name on
 * every platform, so one file serves every host. Regenerate with
 * `npx tsx tests/fixtures/collectorsOracle.ts`.
 *
 * One record per line, tab-separated:
 *   spec      <entries> <seed> <folder_ppm> <link_ppm> <size_sigma_milli>
 *   file      <path under the root> <size> <extension, '' for none> <modifiedAt>
 *   folder    <path under the root> <size> <file count> <modifiedAt>
 *   short     <limit> <minimum> <path under the root> <size> <extension> <modifiedAt>
 *             (the short lists fill at once, so the collector's replacements and
 *             its ties run, which the full lists of these small trees never reach)
 *   type      <extension, '(none)' for none> <count> <bytes>
 *   histogram <files> <the bucket counts, comma-separated>
 */

export const ORACLE_PATH = path.join(
  __dirname, '..', '..', 'native', 'treemap-core', 'crates', 'tm-store', 'tests', 'fixtures', 'collectors-oracle.tsv',
);

/** How many entries each list keeps: tm-store's `aggregate::KEEP`. */
export const KEEP = 2000;

/** The short lists, as (limit, minimum size). */
export const SHORT: ReadonlyArray<readonly [number, number]> = [[10, 0], [100, 1_000]];

/**
 * The trees, in Rust's terms: the developer shape without hard links (T12d brings those),
 * and one whose sizes do not spread, so every file ties with every other and each order
 * falls to position alone.
 */
export const SPECS = [
  { entries: 1_200, seed: 11, folderPpm: 150_000, linkPpm: 0, sizeSigmaMilli: 2_000 },
  { entries: 1_200, seed: 12, folderPpm: 330_000, linkPpm: 0, sizeSigmaMilli: 2_000 },
  { entries: 1_200, seed: 13, folderPpm: 150_000, linkPpm: 0, sizeSigmaMilli: 0 },
] as const;

export type Spec = (typeof SPECS)[number];
type Core = typeof NativeCore;

export const PREBUILT_MODULE = path.join(__dirname, '..', '..', 'native', 'prebuilt', `${process.platform}-${process.arch}`, 'treemap_core.node');

/** `spec` walked natively, ingested and summed as the columns path does. */
export async function storeOf(core: Core, spec: Spec, index: number): Promise<{ store: PackedScanStore; root: string }> {
  const root = path.join(core.syntheticTempFolder(), `t12b-oracle-${index}-${process.pid}`);
  const handle = core.scanStart(root, {
    neverDescend: [],
    wantAtime: false,
    maxWorkers: 2,
    synthetic: {
      entries: spec.entries,
      seed: spec.seed,
      folderShare: spec.folderPpm / 1e6,
      linkShare: spec.linkPpm / 1e6,
      sizeSigma: spec.sizeSigmaMilli / 1e3,
    },
  });
  const started = Date.now();
  while (!core.scanPoll(handle).done) {
    if (Date.now() - started > 120_000) throw new Error('the synthetic walk did not finish within 120 s');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const cols = core.scanTake(handle);
  const scan = createScanRecord(root);
  const store = new PackedScanStore(root, path.sep, statToInput(rootName(root), true, 0, 0));
  ingestColumns(scan, store, cols, root);
  store.finalize();
  store.sumSizes();
  return { store, root };
}

/** `p` under `root`, `/` between the names whatever the host's separator. */
function under(root: string, p: string): string {
  return path.relative(root, p).split(path.sep).join('/');
}

/** One tree's lines: its spec, its full lists, its types and its histogram. */
export function answersText(store: PackedScanStore, root: string, spec: Spec): string {
  const lines = [`spec\t${spec.entries}\t${spec.seed}\t${spec.folderPpm}\t${spec.linkPpm}\t${spec.sizeSigmaMilli}`];
  for (const f of collectLargestFiles(store, KEEP, 0)) {
    lines.push(`file\t${under(root, f.path)}\t${f.size}\t${f.extension ?? ''}\t${f.modifiedAt}`);
  }
  for (const f of collectLargestFolders(store, KEEP, 0)) {
    lines.push(`folder\t${under(root, f.path)}\t${f.size}\t${f.fileCount}\t${f.modifiedAt}`);
  }
  for (const [limit, min] of SHORT) {
    for (const f of collectLargestFiles(store, limit, min)) {
      lines.push(`short\t${limit}\t${min}\t${under(root, f.path)}\t${f.size}\t${f.extension ?? ''}\t${f.modifiedAt}`);
    }
  }
  for (const t of collectFileTypes(store)) {
    lines.push(`type\t${t.ext}\t${t.count}\t${t.totalSize}`);
  }
  const counts = new Array<number>(BUCKETS).fill(0);
  let files = 0;
  store.eachFile(store.rootId, (id) => {
    counts[bucketFor(store.size(id))]++;
    files++;
  });
  lines.push(`histogram\t${files}\t${counts.join(',')}`);
  return lines.join('\n');
}

/** Every tree's lines. */
export async function oracleText(core: Core): Promise<string> {
  const parts: string[] = [];
  for (const [index, spec] of SPECS.entries()) {
    const { store, root } = await storeOf(core, spec, index);
    parts.push(answersText(store, root, spec));
  }
  return `${parts.join('\n')}\n`;
}

if (require.main === module) {
  // Nothing here saves app data, but run as a script the app's data folder is
  // pointed away from the owner's all the same, as every test file's is.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-collectorsOracle-data-'));
  process.env.TREEMAP_DATA_DIR = dataDir;
  const loaded = loadNative({ path: process.env.TREEMAP_NATIVE_MODULE ?? PREBUILT_MODULE });
  if (!loaded.available) throw new Error(loaded.reason);
  void oracleText(loaded.module as unknown as Core)
    .then((text) => {
      fs.writeFileSync(ORACLE_PATH, text);
      process.stdout.write(`wrote ${ORACLE_PATH} (${text.length} bytes)\n`);
    })
    .finally(() => fs.rmSync(dataDir, { recursive: true, force: true }));
}

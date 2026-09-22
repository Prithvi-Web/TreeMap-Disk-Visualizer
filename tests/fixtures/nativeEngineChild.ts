/*
 * A scan in a process whose native module is pinned to a path that is not
 * there — the "legacy fallback verified" case of the Phase 3 plan (W2).
 *
 * argv: <tree> <dataDir>. Writes an Automatic engine setting into a private
 * data directory, points the loader at a module that does not exist (the
 * same seam tests/fixtures/engineBudgetChild.ts uses, so the machine's own
 * prebuilt can never answer), scans the tree, and prints one JSON line: the
 * engine that ran, why, the fast path, the fallback reason and the counters.
 * The parent (tests/nativeEngine.test.ts) asserts the walker ran, that the
 * reason names the missing path, and that the scan is complete and correct.
 */
import fs from 'node:fs';
import path from 'node:path';

const [tree, dataDir] = process.argv.slice(2);
if (!tree || !dataDir) {
  console.error('usage: nativeEngineChild.ts <tree> <dataDir>');
  process.exit(2);
}
process.env.TREEMAP_DATA_DIR = dataDir;
process.env.TREEMAP_NO_GDU = '1';
const MISSING = path.join(dataDir, 'nonexistent', 'treemap_core.node');
process.env.TREEMAP_NATIVE_MODULE = MISSING;
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ engine: 'auto' }));

// Required after the environment is set: these modules read it when loaded.
/* eslint-disable @typescript-eslint/no-require-imports */
const { setNativeLoadOptionsForTests } = require('../../src/services/engineBudget') as typeof import('../../src/services/engineBudget');
const { startScan, getScan } = require('../../src/services/diskScanner') as typeof import('../../src/services/diskScanner');
const { buildScanStats } = require('../../src/api/scanRoutes') as typeof import('../../src/api/scanRoutes');
/* eslint-enable @typescript-eslint/no-require-imports */

setNativeLoadOptionsForTests({ path: MISSING });

async function main(): Promise<void> {
  const scan = await startScan(tree);
  while (getScan(scan.scanId)?.status === 'running') {
    await new Promise((r) => setTimeout(r, 10));
  }
  const done = getScan(scan.scanId);
  if (!done) throw new Error('the scan record vanished');
  const stats = buildScanStats(done);
  console.log(JSON.stringify({
    status: done.status,
    error: done.error ?? null,
    missing: MISSING,
    engine: stats.engine,
    engineReason: stats.engineReason,
    fastPath: stats.fastPath,
    fallbackReason: stats.fallbackReason,
    cpuSeconds: stats.cpuSeconds,
    placeholdersSkipped: stats.placeholdersSkipped,
    scanned: stats.scanned,
    fileCount: stats.fileCount,
    dirCount: stats.dirCount,
  }));
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);

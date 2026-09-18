/*
 * A scan in a process of its own, so its CPU can be measured on its own.
 *
 * argv: <preset> <tree> <dataDir>. Writes the preset into a settings file in
 * the private data dir, scans the tree with the walker (gdu off, the native
 * core pinned to a path that is not there, so the shim is what runs), and
 * prints one JSON line: wall time, CPU time (user + system, every thread of
 * this process), the counters and the budget the scan recorded. The parent
 * (tests/engineBudget.test.ts) turns that into a share of the machine.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [preset, tree, dataDir] = process.argv.slice(2);
if (!preset || !tree || !dataDir) {
  console.error('usage: engineBudgetChild.ts <preset> <tree> <dataDir>');
  process.exit(2);
}
process.env.TREEMAP_DATA_DIR = dataDir;
process.env.TREEMAP_NO_GDU = '1';
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ engineBudget: { preset, cpuPercent: null } }));

// Required after the environment is set: these modules read it when loaded.
/* eslint-disable @typescript-eslint/no-require-imports */
const { setNativeLoadOptionsForTests } = require('../../src/services/engineBudget') as typeof import('../../src/services/engineBudget');
const { startScan, getScan } = require('../../src/services/diskScanner') as typeof import('../../src/services/diskScanner');
/* eslint-enable @typescript-eslint/no-require-imports */

setNativeLoadOptionsForTests({ path: path.join(os.tmpdir(), 'treemap-no-native-here.node') });

async function main(): Promise<void> {
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const scan = await startScan(tree);
  while (getScan(scan.scanId)?.status === 'running') {
    await new Promise((r) => setTimeout(r, 10));
  }
  const wallMs = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const done = getScan(scan.scanId);
  console.log(JSON.stringify({
    preset,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    scanned: done?.scanned ?? -1,
    status: done?.status ?? 'missing',
    engine: done?.engine ?? null,
    budget: done?.budget ?? null,
  }));
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);

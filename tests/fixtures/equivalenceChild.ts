/*
 * One engine's scan of one tree, in a process of its own (Phase 3, W3).
 *
 * argv: <jobFile>. The job names the engine, the root, a private app-data
 * directory, the hard-link families for the digest and the result file. The
 * engine is forced before a service is imported: `settings.json { engine }`
 * in the data directory (the setting Phase 3's W2 adds — the normaliser
 * ignores it until then), `TREEMAP_NO_GDU` for every engine but gdu, and
 * whatever `TREEMAP_NATIVE_MODULE` the parent chose. `pinNativeModule` makes
 * the loader look at that one path and nothing else, through the same seam
 * tests/fixtures/engineBudgetChild.ts and W2's nativeEngineChild.ts use: the
 * environment variable is only the first of several candidates, so on a
 * machine with a prebuilt it cannot force a load failure by itself. The result carries the
 * engine the scan reported, the canonical lines and digest, the eleven
 * counters, the W2 fields when they exist, and a probe of what this build
 * offers (does the settings module know `engine`; does the loaded native
 * module export `scanStart`; is a gdu binary available), so the parent can
 * skip with a reason rather than guess. Nothing crosses stdout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ScanResult } from '../../src/models/types';
import type { CounterName, Counters } from './canonicalTree';

export type ChildEngine = 'walker' | 'gdu' | 'native' | 'auto';

export interface ChildJob {
  engine: ChildEngine;
  root: string;
  dataDir: string;
  hardlinkFamilies: string[][];
  outFile: string;
  /** When set, the loader considers only this path (the forced-load-failure case). */
  pinNativeModule?: string;
}

export interface ChildProbe {
  /** The settings module carries an `engine` key: W2's forced-engine setting exists in this build. */
  settingsAcceptEngine: boolean;
  /** The scan record carries W2's `engineReason` and `fallbackReason`: `startScan` selects engines the Phase 3 way. */
  scanReportsEngineReason: boolean;
  /** The native module loaded and exports `scanStart`: W1's walker is in the module on disk. */
  moduleHasScanStart: boolean;
  /** Why the module did not load, when it did not. */
  moduleReason: string | null;
  gduBinary: string | null;
}

export interface ChildSuccess {
  ok: true;
  engine: string;
  fallbackReason: string | null;
  engineReason: string | null;
  fastPath: string | null;
  counters: Counters;
  lines: string[];
  digest: string;
  probe: ChildProbe;
  wallMs: number;
  /** Set instead of a scan when the engine asked for cannot run here; the parent skips with it. */
  unavailable?: string;
}
export interface ChildFailure { ok: false; error: string }
export type ChildResult = ChildSuccess | ChildFailure;

const ENGINES: readonly ChildEngine[] = ['walker', 'gdu', 'native', 'auto'];
const POLL_MS = 2;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readJob(file: string | undefined): ChildJob {
  if (!file) throw new Error('equivalenceChild: a job file is required');
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('equivalenceChild: the job is not an object');
  const j = parsed as Record<string, unknown>;
  if (!ENGINES.includes(j.engine as ChildEngine)) throw new Error(`equivalenceChild: unknown engine ${String(j.engine)}`);
  for (const key of ['root', 'dataDir', 'outFile'] as const) {
    if (typeof j[key] !== 'string' || !j[key]) throw new Error(`equivalenceChild: ${key} is required`);
  }
  if (!Array.isArray(j.hardlinkFamilies)) throw new Error('equivalenceChild: hardlinkFamilies must be an array');
  if (j.pinNativeModule !== undefined && typeof j.pinNativeModule !== 'string') throw new Error('equivalenceChild: pinNativeModule must be a path');
  return parsed as ChildJob;
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

async function main(job: ChildJob): Promise<ChildSuccess> {
  process.env.TREEMAP_DATA_DIR = job.dataDir;
  if (job.engine === 'gdu') delete process.env.TREEMAP_NO_GDU;
  else process.env.TREEMAP_NO_GDU = '1';
  fs.mkdirSync(job.dataDir, { recursive: true });
  fs.writeFileSync(path.join(job.dataDir, 'settings.json'), JSON.stringify({ engine: job.engine }));

  // Required only now: these modules read the environment when they load.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { startScan, cancelAllScans } = require('../../src/services/diskScanner') as typeof import('../../src/services/diskScanner');
  const { getSettings } = require('../../src/services/settings') as typeof import('../../src/services/settings');
  const { loadNative } = require('../../src/services/scan/native') as typeof import('../../src/services/scan/native');
  const { findGduBinary } = require('../../src/services/gduScanner') as typeof import('../../src/services/gduScanner');
  const { storeOf } = require('../../src/services/scanStore') as typeof import('../../src/services/scanStore');
  const { settled } = require('../../src/utils/backgroundWrites') as typeof import('../../src/utils/backgroundWrites');
  const { canonicalLines, digestOfLines, countersOf } = require('./canonicalTree') as typeof import('./canonicalTree');
  const { setNativeLoadOptionsForTests } = require('../../src/services/engineBudget') as typeof import('../../src/services/engineBudget');
  /* eslint-enable @typescript-eslint/no-require-imports */
  if (job.pinNativeModule) setNativeLoadOptionsForTests({ path: job.pinNativeModule });

  const settings = (await getSettings()) as unknown as Record<string, unknown>;
  const native = loadNative();
  const gduBinary = await findGduBinary();
  const probe: ChildProbe = {
    settingsAcceptEngine: Object.prototype.hasOwnProperty.call(settings, 'engine'),
    scanReportsEngineReason: false,
    moduleHasScanStart: native.available && typeof native.module.scanStart === 'function',
    moduleReason: native.available ? null : native.reason,
    gduBinary,
  };
  if (job.engine === 'gdu' && !gduBinary) {
    return {
      ok: true, engine: 'none', fallbackReason: null, engineReason: null, fastPath: null,
      counters: countersOf({} as Pick<ScanResult, CounterName>), lines: [], digest: '', probe, wallMs: 0,
      unavailable: 'no gdu binary is available (bundled, ./gdu, or $PATH); run `npm run fetch:gdu:dev` first',
    };
  }

  const t0 = performance.now();
  const scan = await startScan(job.root);
  while (scan.status === 'running') await sleep(POLL_MS);
  const wallMs = performance.now() - t0;
  if (scan.status !== 'complete') throw new Error(`the scan ended as ${scan.status}: ${scan.error ?? 'no error recorded'}`);

  const store = storeOf(scan);
  const lines = canonicalLines(store, { hardlinkFamilies: job.hardlinkFamilies });
  // W2's fields, read by name so this file needs no compile-time dependency on them.
  const record = scan as unknown as Record<string, unknown>;
  probe.scanReportsEngineReason = Object.prototype.hasOwnProperty.call(record, 'engineReason') && Object.prototype.hasOwnProperty.call(record, 'fallbackReason');
  await settled();
  cancelAllScans();
  return {
    ok: true,
    engine: scan.engine ?? 'unset',
    fallbackReason: text(record.fallbackReason),
    engineReason: text(record.engineReason),
    fastPath: text(record.fastPath),
    counters: countersOf(scan),
    lines,
    digest: digestOfLines(lines),
    probe,
    wallMs,
  };
}

if (require.main === module) {
  const job = readJob(process.argv[2]);
  main(job)
    .then((result) => {
      fs.writeFileSync(job.outFile, JSON.stringify(result));
      process.exit(0);
    })
    .catch((err: unknown) => {
      const failure: ChildFailure = { ok: false, error: err instanceof Error ? err.message : String(err) };
      try {
        fs.writeFileSync(job.outFile, JSON.stringify(failure));
      } catch {
        /* the parent reports the missing file */
      }
      process.exit(1);
    });
}

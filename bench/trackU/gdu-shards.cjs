'use strict';
/*
 * Reproduce 5.1.0's whole-disk gdu engine on this Mac, stage by stage, and time every stage that
 * ran on the server's main thread. Uses the repo's own gdu mapper and store (unchanged since 73abc4c)
 * from the diag worktree's dist, and the gdu binary 5.1.0 bundles (v5.36.1).
 *
 *   node gdu-shards.cjs <gduBin> <outDir>
 *
 * Per top-level directory of "/" (skipping 5.1.0's never-descend list), sequentially as 5.1.0 does:
 *   gdu -n -x -o shard.json <dir>   (wall time; the file size; would it pass MAX_SHARD_BYTES = 450 MiB?)
 *   readFile(utf8)                  (async in 5.1.0, timed anyway)
 *   JSON.parse                      (synchronous on the main thread in 5.1.0)
 *   mapGduTreeIntoStore             (synchronous on the main thread in 5.1.0)
 * then finalize + sumSizes (synchronous), then the 5.1.0 complete frame: store.prune(250k) as objects and
 * JSON.stringify of the whole frame as one string (synchronous), catching V8's string-length RangeError.
 * The shard JSON (which holds file names) is deleted as soon as it is measured. Only top-level folder names
 * are printed.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { sanitize } = require('./run-api.cjs');

/**
 * What a failed gdu run is recorded as: a fixed phrase with its exit code or signal. Never execFile's
 * message, which is the whole command line — the gdu binary's path and the shard's under outDir
 * (U-0 review, finding 17).
 */
const gduFailure = (e) => {
  if (e.killed) return 'timeout';
  if (e.code === 'ENOENT') return 'gdu not found';
  if (typeof e.code === 'number') return `gdu failed (exit ${e.code})`;
  if (e.signal) return `gdu failed (signal ${e.signal})`;
  return 'gdu failed';
};

// Exported for tests/trackUTools.test.ts; the run below starts only when this file is the program.
module.exports = { gduFailure };
if (require.main === module) main();

function main() {
  const WT = process.env.WT;
  const { PackedScanStore } = require(path.join(WT, 'dist/services/scanStore.js'));
  const { mapGduTreeIntoStore } = require(path.join(WT, 'dist/services/gduMapper.js'));
  const { cloudProviderFor } = require(path.join(WT, 'dist/services/cloudFolders.js'));
  const [bin, outDir] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  const MAX_SHARD_BYTES = 450 * 1024 * 1024;
  const SKIP = new Set(['/System/Volumes', '/Volumes', '/dev', '/home', '/net', '/Network']);
  const mb = (b) => (b / 1048576).toFixed(1);
  const rss = () => Math.round(process.memoryUsage().rss / 1048576);
  const runGdu = (dir, out) => new Promise((resolve, reject) => {
    execFile(bin, ['-n', '-x', '-o', out, dir], { maxBuffer: 1 << 20, timeout: 5 * 60 * 1000, killSignal: 'SIGKILL' }, (err) => (err ? reject(err) : resolve()));
  });

  (async () => {
    const entries = await fsp.readdir('/', { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => '/' + e.name).filter((p) => !SKIP.has(p));
    const store = new PackedScanStore('/', '/', { name: '/', isDir: true, size: 0, modifiedAt: 0, isHidden: false });
    const seenInodes = new Set();
    let peakRss = rss();
    const rows = [];
    const tAll = Date.now();
    for (const dir of dirs) {
      const out = path.join(outDir, 'shard.json');
      const t0 = Date.now();
      let gduErr = null;
      try { await runGdu(dir, out); } catch (e) { gduErr = gduFailure(e); }
      const tGdu = Date.now() - t0;
      if (gduErr) { rows.push({ dir, gduMs: tGdu, error: gduErr }); console.log(JSON.stringify(rows[rows.length - 1])); continue; }
      const bytes = (await fsp.stat(out)).size;
      const t1 = Date.now();
      const text = await fsp.readFile(out, 'utf8');
      const tRead = Date.now() - t1;
      const t2 = Date.now();
      const doc = JSON.parse(text);
      const tParse = Date.now() - t2;
      peakRss = Math.max(peakRss, rss());
      const t3 = Date.now();
      const { stats } = mapGduTreeIntoStore(doc, dir, store, store.rootId, { seenInodes, cloudProviderFor, blocksAreMeaningful: true });
      const tMap = Date.now() - t3;
      peakRss = Math.max(peakRss, rss());
      await fsp.unlink(out);
      rows.push({ dir, gduMs: tGdu, jsonMB: +mb(bytes), overShardCap: bytes > MAX_SHARD_BYTES, entries: stats.fileCount + stats.dirCount, readMs: tRead, parseMs: tParse, mapMs: tMap, deniedDirs: stats.deniedDirs, rssMB: rss() });
      console.log(JSON.stringify(rows[rows.length - 1]));
    }
    const t4 = Date.now();
    store.finalize();
    const tFin = Date.now() - t4;
    const t5 = Date.now();
    store.sumSizes();
    const tSum = Date.now() - t5;
    peakRss = Math.max(peakRss, rss());
    const t6 = Date.now();
    const { root, nodes } = store.prune(store.rootId, { maxNodes: 250_000 });
    const tPrune = Date.now() - t6;
    peakRss = Math.max(peakRss, rss());
    let frameChars = null, tStr = null, strErr = null;
    const t7 = Date.now();
    try { frameChars = `data: ${JSON.stringify({ type: 'complete', root, stats: {} })}\n\n`.length; } catch (e) { strErr = e.message; }
    tStr = Date.now() - t7;
    peakRss = Math.max(peakRss, rss());
    const total = rows.reduce((a, r) => a + (r.entries || 0), 0);
    console.log(JSON.stringify({ summary: true, shards: rows.length, entries: total, wallMs: Date.now() - tAll, gduMsTotal: rows.reduce((a, r) => a + r.gduMs, 0), mainThreadParseMapMs: rows.reduce((a, r) => a + (r.parseMs || 0) + (r.mapMs || 0), 0), finalizeMs: tFin, sumSizesMs: tSum, prune250kMs: tPrune, prunedNodes: nodes, stringifyMs: tStr, frameChars, stringifyError: strErr, rootBytes: store.size(store.rootId), peakRssMB: peakRss }));
  })().catch((e) => { console.error(sanitize(e && e.stack ? e.stack : String(e))); process.exit(1); });
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Isolate app data BEFORE any service is imported: scans write caches and snapshots.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-suites-data-'));
process.env.TREEMAP_DATA_DIR = DATA_DIR;
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { planCorpus, createCorpus } from '../bench/lib/corpus';
import { runEnumerate } from '../bench/lib/suites';
import { cancelAllScans } from '../src/services/diskScanner';

const CORPUS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-suites-corpus-'));

after(() => {
  cancelAllScans();
  fs.rmSync(CORPUS_DIR, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('enumerate drives the real walker over a small corpus and its counts match the manifest', async () => {
  const plan = planCorpus({ entries: 600, fanout: 5, depth: 4, flat: 0, sizeMedian: 512, sizeSigma: 1, sizeMax: 65_536, duplicateRate: 0.1, hardlinkRate: 0.02, sparseRate: 0.01, seed: 11 });
  const manifest = await createCorpus(CORPUS_DIR, plan);
  const result = await runEnumerate({ manifest, corpusName: 'test600', engine: 'walker', runs: 2, cache: 'warm', label: 'suite test' });
  assert.ok(result.engine === 'walker' || result.engine === 'turbo-walker', result.engine);
  assert.equal(result.correctness.ok, true, result.correctness.notes.join('\n'));
  assert.equal(result.runs.length, 2);
  assert.equal(result.runs[0].entries, manifest.files + manifest.dirs, 'every file and directory, the root included, is an entry');
  assert.ok(result.summary.wallMsMedian > 0);
  assert.ok(result.summary.entriesPerSecond > 0);
  assert.equal(result.cache.state, 'warm');
  assert.equal(result.corpus.files, manifest.files);
  assert.equal(result.corpus.dirs, manifest.dirs);
});

test('asking for gdu when the binary is unavailable is refused, never silently downgraded', async () => {
  const plan = planCorpus({ entries: 50, fanout: 3, depth: 2, flat: 0, sizeMedian: 512, sizeSigma: 1, sizeMax: 4096, duplicateRate: 0, hardlinkRate: 0, sparseRate: 0, seed: 12 });
  const dir = path.join(CORPUS_DIR, 'tiny');
  fs.mkdirSync(dir);
  const manifest = await createCorpus(dir, plan);
  // This Mac has a dev copy at ./gdu/gdu, so "unavailable" is injected: a
  // bundled path that does not exist and no $PATH lookup.
  await assert.rejects(
    runEnumerate({ manifest, corpusName: 'tiny', engine: 'gdu', runs: 1, cache: 'warm', label: 'suite test', gduFind: { bundledPath: path.join(dir, 'no-such-gdu'), pathLookup: false } }),
    /gdu/,
  );
});

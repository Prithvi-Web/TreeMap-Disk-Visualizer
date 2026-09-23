import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { planCorpus, createCorpus, type CorpusManifest } from '../bench/lib/corpus';
import { runEnumerate, runDuplicates, runNearDup } from '../bench/lib/suites';
import { budgetMoved } from '../bench/lib/report';
import { createImageCorpus, ALL_TRANSFORMS } from '../bench/lib/images';

// Every measured pass runs in a CHILD process with its own isolated data
// directory (the suites create and remove it), so this test process never
// imports a service and never writes app data anywhere.
const CORPUS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-bench-suites-corpus-'));

after(() => {
  fs.rmSync(CORPUS_DIR, { recursive: true, force: true });
});

const SMALL = { entries: 600, fanout: 5, depth: 4, flat: 0, sizeMedian: 512, sizeSigma: 1, sizeMax: 65_536, duplicateRate: 0.1, hardlinkRate: 0.02, sparseRate: 0.01, seed: 11 };

// One build, shared by every test: the promise is memoised, not the result,
// so a build that fails is reported by each test as the failure it was
// rather than as EEXIST on the directory the first attempt left behind (which
// is what CI showed when the worker entry could not load on Node 20).
let smallBuild: Promise<CorpusManifest> | null = null;
function small(): Promise<CorpusManifest> {
  if (!smallBuild) {
    const dir = path.join(CORPUS_DIR, 'small');
    fs.mkdirSync(dir);
    smallBuild = createCorpus(dir, planCorpus(SMALL));
  }
  return smallBuild;
}

test('enumerate drives the real walker in a child process and every run agrees with the manifest', async () => {
  const manifest = await small();
  const result = await runEnumerate({ manifest, corpusName: 'test600', engine: 'walker', preset: 'turbo', runs: 3, cache: 'warm', label: 'suite test' });
  assert.ok(result.engine === 'walker' || result.engine === 'turbo-walker', result.engine);
  assert.equal(result.correctness.ok, true, result.correctness.notes.join('\n'));
  assert.equal(result.runs.length, 3);
  for (const run of result.runs) {
    assert.equal(run.entries, manifest.files + manifest.dirs, 'every file and directory, the root included, is an entry');
    assert.ok(run.cpuSeconds >= run.selfCpuSeconds, 'cpuSeconds is self plus children');
    assert.ok(run.persistMs >= 0, 'the persistence that follows a scan is measured on its own');
    assert.equal(typeof run.bytesReadReason, 'string');
  }
  assert.ok(result.summary.wallMsMedian > 0);
  assert.ok(result.summary.entriesPerSecond > 0);
  assert.equal(result.entriesUnit, 'entries');
  assert.equal(result.cache.state, 'warm');
  assert.equal(result.corpus.files, manifest.files);
  assert.equal(result.corpus.dirs, manifest.dirs);
  assert.equal(result.machine.arch, process.arch);
});

test('asking for gdu when the binary is unavailable is refused, never silently downgraded', async () => {
  const manifest = await small();
  await assert.rejects(
    runEnumerate({ manifest, corpusName: 'tiny', engine: 'gdu', preset: 'turbo', runs: 1, cache: 'warm', label: 'suite test', gduFind: { bundledPath: path.join(CORPUS_DIR, 'no-such-gdu'), pathLookup: false } }),
    /gdu/,
  );
});

test('a run whose engine differs from the one requested is refused', async () => {
  const manifest = await small();
  // The walker was requested but the child is told to report a different engine name.
  await assert.rejects(
    runEnumerate({ manifest, corpusName: 'tiny', engine: 'walker', preset: 'turbo', runs: 1, cache: 'warm', label: 'suite test', pretendEngine: 'gdu-turbo' }),
    /requested walker but the scan ran on gdu-turbo/,
  );
});

test('a cold series is labelled cold only when every measured run was purged', async () => {
  const manifest = await small();
  let calls = 0;
  const purge = async (): Promise<{ ok: boolean; command: string; error?: string }> => {
    calls += 1;
    return calls === 1 ? { ok: true, command: 'fake purge' } : { ok: false, command: 'fake purge', error: 'a password is required' };
  };
  const result = await runEnumerate({ manifest, corpusName: 'tiny', engine: 'walker', preset: 'turbo', runs: 3, cache: 'cold', label: 'suite test', purge });
  assert.equal(calls, 3, 'one purge per measured run');
  assert.equal(result.cache.state, 'unknown');
  assert.match(result.cache.reason, /runs 2, 3/);
  assert.match(result.cache.reason, /password/);
  const allOk = async (): Promise<{ ok: boolean; command: string }> => ({ ok: true, command: 'fake purge' });
  const cold = await runEnumerate({ manifest, corpusName: 'tiny', engine: 'walker', preset: 'turbo', runs: 2, cache: 'cold', label: 'suite test', purge: allOk });
  assert.equal(cold.cache.state, 'cold');
});

test('the duplicate suite drives the real finder and proves every planted group by bytes', async () => {
  const manifest = await small();
  assert.ok(manifest.duplicateGroups.length > 0, 'the small corpus plants duplicates');
  const result = await runDuplicates({ manifest, corpusName: 'test600', runs: 2, minSize: 1024, label: 'suite test' });
  assert.equal(result.correctness.ok, true, result.correctness.notes.join('\n'));
  assert.match(result.correctness.notes[0], /recall 1\.0000/);
  assert.match(result.correctness.notes[0], /precision 1\.0000/);
  assert.equal(result.entriesUnit, 'files');
  assert.equal(result.engine, 'sha256-staged');
  assert.match(result.engineDescription, /64 KiB/);
  assert.equal(result.runs.length, 2);
  assert.equal(result.cache.state, 'warm');
});

test("enumerate scans under the preset it names, set by the app's own setter in the child, and records what each scan's own record says", async () => {
  const manifest = await small();
  // Automatic never resolves to Turbo, so a Turbo record can only mean the preset was applied, not defaulted.
  const turbo = await runEnumerate({ manifest, corpusName: 'test600', engine: 'walker', preset: 'turbo', runs: 2, cache: 'warm', label: 'suite test' });
  assert.equal(turbo.correctness.ok, true, turbo.correctness.notes.join('\n'));
  assert.deepEqual(turbo.budget, { requested: 'turbo', effective: ['turbo', 'turbo'] });
  const eco = await runEnumerate({ manifest, corpusName: 'test600', engine: 'walker', preset: 'eco', runs: 1, cache: 'warm', label: 'suite test' });
  assert.deepEqual(eco.budget, { requested: 'eco', effective: ['eco'] });
});

test('a preset the scan did not record is refused: the number would describe another budget', async () => {
  const manifest = await small();
  // The child reports its scan's setting as Automatic: what a preset undone by the settings load would leave behind.
  await assert.rejects(
    runEnumerate({ manifest, corpusName: 'tiny', engine: 'walker', preset: 'eco', runs: 1, cache: 'warm', label: 'suite test', pretendBudget: { preset: 'auto' } }),
    /requested the eco budget but the scan recorded the auto setting/,
  );
});

test("the effective presets are the scans' own, not the request: a child that reports another carries it into the result as a moved budget", async () => {
  const manifest = await small();
  const result = await runEnumerate({ manifest, corpusName: 'tiny', engine: 'walker', preset: 'eco', runs: 2, cache: 'warm', label: 'suite test', pretendBudget: { effective: 'balanced' } });
  assert.deepEqual(result.budget, { requested: 'eco', effective: ['balanced', 'balanced'] });
  assert.match(budgetMoved(result.budget) ?? '', /^eco was requested but runs 1 and 2 ran under balanced /);
});

test("the duplicate suite names no preset and records what the app's default resolved to in each run", async () => {
  const manifest = await small();
  const result = await runDuplicates({ manifest, corpusName: 'test600', runs: 1, minSize: 1024, label: 'suite test' });
  assert.equal(result.budget.requested, 'auto');
  assert.equal(result.budget.effective.length, 1);
  for (const preset of result.budget.effective) assert.ok(preset === 'balanced' || preset === 'eco', `Automatic resolves to Balanced or Eco, never ${preset}`);
});

test('the near-duplicate suite judges precision, not just completion', async () => {
  let sharp: unknown = null;
  try { sharp = require('sharp'); } catch { sharp = null; }
  if (!sharp) return; // decode path unavailable: nothing to measure here
  const root = path.join(CORPUS_DIR, 'images');
  const manifest = await createImageCorpus(root, { originals: 2, seed: 9, transforms: [...ALL_TRANSFORMS] });
  const result = await runNearDup({ manifest, corpusName: 'images2', runs: 1, threshold: 10, label: 'suite test' });
  assert.equal(result.entriesUnit, 'images');
  assert.equal(result.engine, 'dhash-pairwise');
  assert.equal(result.runs[0].entries, manifest.images.length);
  assert.equal(result.budget.requested, 'auto', 'the near-duplicate suite names no preset: its scan runs under the app\'s own default');
  assert.equal(result.budget.effective.length, 1);
  assert.match(result.correctness.notes.join('\n'), /precision/);
  assert.match(result.correctness.notes.join('\n'), /recall by transform/);
  // Two clearly different synthetic originals must never be joined: precision is the correctness bar.
  const precision = Number(/precision (\d+\.\d+)/.exec(result.correctness.notes.join('\n'))?.[1]);
  assert.equal(result.correctness.ok, precision >= 0.98 && result.correctness.notes.join('\n').includes('truncated false'));
});

test('the near-duplicate correctness rule: available, not truncated, at least one pair, precision at the bar', async () => {
  const { nearDupVerdict, NEAR_DUP_PRECISION_FLOOR } = await import('../bench/lib/suites');
  assert.equal(nearDupVerdict({ available: true, truncated: false, pairs: 10, precision: 1 }), true);
  assert.equal(nearDupVerdict({ available: true, truncated: false, pairs: 10, precision: NEAR_DUP_PRECISION_FLOOR }), true);
  assert.equal(nearDupVerdict({ available: true, truncated: false, pairs: 10, precision: 0.5 }), false, 'joined pairs that share no original');
  assert.equal(nearDupVerdict({ available: true, truncated: false, pairs: 0, precision: 1 }), false, 'nothing clustered is not a pass');
  assert.equal(nearDupVerdict({ available: true, truncated: true, pairs: 10, precision: 1 }), false);
  assert.equal(nearDupVerdict({ available: false, truncated: false, pairs: 10, precision: 1 }), false);
});

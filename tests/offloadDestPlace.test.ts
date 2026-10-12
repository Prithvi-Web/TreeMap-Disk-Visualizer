import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-offloadDestPlace-data-');
process.env.TREEMAP_NO_GDU = '1';

import { startScan } from '../src/services/diskScanner';
import { prepareOffload, setOffloadDiskUsageForTests } from '../src/services/offload';
import { setTrashStepForTests } from '../src/services/cleaner';
import { updateSettings } from '../src/services/settings';
import { AppError } from '../src/middleware/errorHandler';
import type { ScanResult } from '../src/models/types';

/**
 * An offload copies, verifies, then trashes the selection — so a destination inside a selected
 * folder (or a selection inside the destination) "would eat itself", and is refused before anything
 * is copied (DEST_INSIDE_SOURCE, SOURCE_INSIDE_DEST). Those two checks compared the scan's spelling
 * with the destination as typed (the final review, F1.9, F1.14): a destination inside the source
 * spelled in another case, through a link, or on the Data volume's long spelling passed — the dry run
 * too — and the real run copied into the source, verified the copy, and sent it to the Trash with
 * the original. Asked here of `prepareOffload`, which the dry run and the real run both make.
 */

const DARWIN = process.platform === 'darwin';
const WINDOWS = process.platform === 'win32';

/** The scanned folder, by its real path: F/a.txt, F/sub/b.txt, and lnk -> F/sub. */
const R = fs.realpathSync(fileTempDir('treemap-offloadDestPlace-root-'));
const F = path.join(R, 'F');
fs.mkdirSync(path.join(F, 'sub'), { recursive: true });
fs.writeFileSync(path.join(F, 'a.txt'), 'the original');
fs.writeFileSync(path.join(F, 'sub', 'b.txt'), 'inside');
if (!WINDOWS) fs.symlinkSync(path.join(F, 'sub'), path.join(R, 'lnk'));
/** Outside the scan: a file a link inside it names. */
const OUTSIDE = fs.realpathSync(fileTempDir('treemap-offloadDestPlace-outside-'));
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'outside every scan');
/** G/a.txt and G/out -> OUTSIDE/secret.txt: a folder that holds a link out of the scan. */
const G = path.join(R, 'G');
fs.mkdirSync(G);
fs.writeFileSync(path.join(G, 'a.txt'), 'a');
if (!WINDOWS) fs.symlinkSync(path.join(OUTSIDE, 'secret.txt'), path.join(G, 'out'));
const CASE_FOLDS = fs.existsSync(path.join(R, 'f', 'SUB'));
/** A destination outside the scan. */
const D = fs.realpathSync(fileTempDir('treemap-offloadDestPlace-dest-'));

let scan: ScanResult;
const trashed: string[] = [];
let restoreDiskUsage: () => void = () => undefined;

before(async () => {
  setTrashStepForTests(async (p) => {
    trashed.push(p);
    throw new Error(`no test here may trash anything, and ${p} was asked for`);
  });
  restoreDiskUsage = setOffloadDiskUsageForTests(async () => ({ total: 1e12, free: 1e12, used: 0 }) as never);
  await updateSettings({ engine: 'walker' });
  scan = await startScan(R);
  await waitFor(() => scan.status !== 'running', `the scan of ${R}`);
  assert.equal(scan.status, 'complete', scan.error);
});

after(() => {
  setTrashStepForTests(null);
  restoreDiskUsage();
  assert.deepEqual(trashed, [], 'nothing was trashed');
});

/** The refusal's code for an offload of `paths` to `dest`, or 'planned'. */
async function verdict(paths: string[], dest: string): Promise<string> {
  try {
    await prepareOffload(scan, paths, dest);
    return 'planned';
  } catch (err) {
    return err instanceof AppError ? err.code : `threw ${String(err)}`;
  }
}

test('a destination inside the folder being offloaded is refused by every spelling that reaches it — another case, a link, the Data volume — and so is a selection inside the destination', { skip: WINDOWS && 'making a link needs a privilege the runner may not hold' }, async () => {
  const answers: Record<string, string> = {
    'F to F/sub, as the scan spells it': await verdict([F], path.join(F, 'sub')),
    'F to lnk (a link to F/sub)': await verdict([F], path.join(R, 'lnk')),
    'F/sub/b.txt to lnk (a link to F/sub, where it lies)': await verdict([path.join(F, 'sub', 'b.txt')], path.join(R, 'lnk')),
    'F to a folder outside the scan': await verdict([F], D),
  };
  if (CASE_FOLDS) {
    answers['F to f/SUB (another case)'] = await verdict([F], path.join(R, 'f', 'SUB'));
    answers['F/sub/b.txt to f (another case)'] = await verdict([path.join(F, 'sub', 'b.txt')], path.join(R, 'f'));
  }
  if (DARWIN) answers['F to F/sub on the Data volume'] = await verdict([F], `/System/Volumes/Data${path.join(F, 'sub')}`);
  const expected: Record<string, string> = {};
  for (const how of Object.keys(answers)) {
    expected[how] = how.startsWith('F/sub/b.txt') ? 'SOURCE_INSIDE_DEST' : how.endsWith('outside the scan') ? 'planned' : 'DEST_INSIDE_SOURCE';
  }
  assert.deepEqual(answers, expected);
});

test('a copy the plan makes is refused when its own name reaches the folder being offloaded: a link in the destination under a name the volume folds (ſtuff for stuff) is found, as the app-data rule finds one', { skip: WINDOWS && 'making a link needs a privilege the runner may not hold' }, async (t) => {
  const source = path.join(R, 'ſtuff');
  fs.mkdirSync(path.join(source, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(source, 'x.txt'), 'x');
  const dest = fs.realpathSync(fileTempDir('treemap-offloadDestPlace-folded-'));
  fs.symlinkSync(path.join(source, 'inner'), path.join(dest, 'stuff'));
  if (!fs.existsSync(path.join(dest, 'ſtuff'))) {
    t.skip('this volume does not fold ſ to s');
    return;
  }
  const rescan = await startScan(R);
  await waitFor(() => rescan.status !== 'running', `the rescan of ${R}`);
  scan = rescan;
  assert.equal(await verdict([source], dest), 'DEST_INSIDE_SOURCE');
});

test('an offload never copies through a link: a link in the selection, or one selected, is refused with a sentence before anything is copied — opened, it was copied as whatever it named, from outside the scan too, and sized as the link (the final review, F1.10)', { skip: WINDOWS && 'making a link needs a privilege the runner may not hold' }, async () => {
  const answers: Record<string, string> = {
    'G, which holds a link out of the scan': await verdict([G], D),
    'the link G/out itself': await verdict([path.join(G, 'out')], D),
    'lnk, a link to a folder in the scan': await verdict([path.join(R, 'lnk')], D),
    'F/sub, which holds none': await verdict([path.join(F, 'sub')], D),
  };
  assert.deepEqual(answers, {
    'G, which holds a link out of the scan': 'LINK_IN_SELECTION',
    'the link G/out itself': 'LINK_IN_SELECTION',
    'lnk, a link to a folder in the scan': 'LINK_IN_SELECTION',
    'F/sub, which holds none': 'planned',
  });
  assert.deepEqual(fs.readdirSync(D), [], 'nothing was written at the destination');
  await assert.rejects(prepareOffload(scan, [G], D), (err: unknown) => err instanceof AppError && err.message.includes(path.join(G, 'out')), 'the sentence names the link');
});

test('two folders the volume tells apart are two folders: an offload from one into the other is planned, never refused as one inside the other — their places are compared exactly, never folded (the final review, F2.4, F2.10)', async (t) => {
  // Photos and Ｐhotos (a fullwidth Ｐ, which no volume folds to P, though a fold of names does) are two
  // folders everywhere; on a volume that keeps case, so are Photos and photos.
  const photos = path.join(R, 'Photos');
  const others: Record<string, string> = { 'Ｐhotos (a fullwidth Ｐ)': path.join(R, 'Ｐhotos') };
  if (!CASE_FOLDS) others['photos (another case, on a volume that keeps it)'] = path.join(R, 'photos');
  for (const folder of [photos, ...Object.values(others)]) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'x.txt'), folder);
  }
  const distinct = Object.fromEntries(Object.entries(others).filter(([, folder]) => fs.statSync(folder).ino !== fs.statSync(photos).ino));
  if (Object.keys(distinct).length === 0) {
    t.skip('this volume reads every such name as Photos');
    return;
  }
  const rescan = await startScan(R);
  await waitFor(() => rescan.status !== 'running', `the rescan of ${R}`);
  scan = rescan;
  const answers: Record<string, string> = {};
  for (const [what, folder] of Object.entries(distinct)) {
    answers[`Photos into ${what}`] = await verdict([photos], folder);
    answers[`${what}/x.txt into Photos`] = await verdict([path.join(folder, 'x.txt')], photos);
  }
  assert.deepEqual(answers, Object.fromEntries(Object.keys(answers).map((how) => [how, 'planned'])));
});

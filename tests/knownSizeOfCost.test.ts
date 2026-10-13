import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor } from './fixtures/waitFor';
isolatedDataDir('treemap-knownSizeOfCost-data-');
process.env.TREEMAP_NO_GDU = '1';

import { startScan } from '../src/services/diskScanner';
import { updateSettings } from '../src/services/settings';
import { knownSizeOf } from '../src/services/policy';
import type { ScanResult } from '../src/models/types';

/**
 * knownSizeOf sizes every path a delete, a cart commit or MCP trash_paths names — up to 500 in one
 * request, synchronously. A path the scan does not list by its exact text is looked up by where it
 * lives, and a name not found exactly was looked for among its siblings by folding every sibling's
 * name, once per path: on a folder of 30,000 files, 100 paths the scan did not list (files gone since
 * the scan) held the server for 1.7 s, and a request of 500 for seconds more (the final review, F2.3).
 *
 * Counted here, not timed: the fold reads each sibling's name through the store's `name`, which no
 * exact lookup uses. A path with nothing at it folds nothing (there is nothing to size); an entry
 * there has every name as the volume stores it but its own last name, when it is a link; and one batch
 * of such links folds each folder's names once.
 *
 * A name more than one sibling folds to is no answer: "unknown", never one of their sizes, since a
 * wrong size reaches the byte cap and the audit (the final review, F3.4).
 */

const ROOT = fs.realpathSync(fileTempDir('treemap-knownSizeOfCost-root-'));
const BIG = path.join(ROOT, 'big');
const FILES = 300;
const LINKS = 10;
const GONE = 20;
fs.mkdirSync(BIG);
for (let i = 0; i < FILES; i++) fs.writeFileSync(path.join(BIG, `f${i}.bin`), Buffer.alloc(i + 1, 1));
const WINDOWS = process.platform === 'win32';
if (!WINDOWS) for (let i = 0; i < LINKS; i++) fs.symlinkSync(path.join(BIG, `f${i}.bin`), path.join(BIG, `l${i}`));
/** Whether this volume folds case, as macOS's and Windows' do by default. */
const CASE_FOLDS = fs.existsSync(path.join(BIG, 'F0.BIN'));

/** The size of each file whose name folds as another sibling's does: never the answer for a path that is not it. */
const OTHER_BYTES = 5000;
/**
 * Names that fold alike, which every volume keeps apart: a link `l0` and a different file `Ｌ0`
 * (fullwidth), which `foldName` reads as one name; and a link `m0` no other name folds to.
 */
const AMBIGUOUS = path.join(ROOT, 'ambiguous');
fs.mkdirSync(AMBIGUOUS);
fs.writeFileSync(path.join(AMBIGUOUS, 'target.bin'), Buffer.alloc(7, 1));
fs.writeFileSync(path.join(AMBIGUOUS, 'Ｌ0'), Buffer.alloc(OTHER_BYTES, 1));
if (!WINDOWS) for (const name of ['l0', 'm0']) fs.symlinkSync(path.join(AMBIGUOUS, 'target.bin'), path.join(AMBIGUOUS, name));
/** Two files whose names fold alike, `R0` and `Ｒ0`, beside which a test makes a link `𝐫0` (folding the same) after the scan. */
const LATE = path.join(ROOT, 'late');
fs.mkdirSync(LATE);
fs.writeFileSync(path.join(LATE, 'R0'), Buffer.alloc(11, 1));
fs.writeFileSync(path.join(LATE, 'Ｒ0'), Buffer.alloc(OTHER_BYTES, 1));
/**
 * One file alone in each fold, `Ｘ1` and `Ｙ1` (fullwidth), beside which a test makes, after the scan, a
 * link `x1` and a file `y1`: names `foldName` reads as theirs, which every volume keeps apart.
 */
const APART = path.join(ROOT, 'apart');
fs.mkdirSync(APART);
fs.writeFileSync(path.join(APART, 'target.bin'), Buffer.alloc(7, 1));
for (const name of ['Ｘ1', 'Ｙ1']) fs.writeFileSync(path.join(APART, name), Buffer.alloc(OTHER_BYTES, 1));
/**
 * A folder `proj`, holding a file `x`, that a test scans again as a root of its own — one scan's root
 * inside another's, as is common — and a link `via` that leads to it. Beside it the test makes, after
 * both scans, a folder `Ｐroj` (fullwidth P) holding another `x`: a name `foldName` reads as the root's
 * own, which every volume keeps apart.
 */
const PROJ = path.join(ROOT, 'proj');
const PROJ_X_BYTES = 17;
fs.mkdirSync(PROJ);
fs.writeFileSync(path.join(PROJ, 'x'), Buffer.alloc(PROJ_X_BYTES, 1));
if (!WINDOWS) fs.symlinkSync(PROJ, path.join(ROOT, 'via'));

let scan: ScanResult;
let names = 0;

before(async () => {
  await updateSettings({ engine: 'walker' });
  scan = await startScan(ROOT);
  await waitFor(() => scan.status !== 'running', `the scan of ${ROOT}`);
  assert.equal(scan.status, 'complete', scan.error);
  // Count every name the store reads out for a caller: the fold's work, one per sibling.
  const store = scan.store as unknown as { name(id: number): string } | undefined;
  assert.ok(store, 'the walker keeps the scan in a store');
  const read = store.name.bind(store);
  store.name = (id: number): string => {
    names++;
    return read(id);
  };
});

/** `fn` run synchronously, with the names the store read out while it ran. */
function counted<T>(fn: () => T): { value: T; names: number } {
  names = 0;
  const value = fn();
  return { value, names };
}

test('paths with nothing at them, in a folder the scan listed, fold no sibling names, and are "unknown"', () => {
  const gone = Array.from({ length: GONE }, (_, i) => path.join(BIG, `gone${i}.bin`));
  const { value, names: read } = counted(() => gone.map((p) => knownSizeOf(p)));
  assert.deepEqual({ sizes: [...new Set(value)], 'names folded': read }, { sizes: [null], 'names folded': 0 });
});

test('files spelled in another case are sized by the names the volume stores, folding nothing', { skip: !CASE_FOLDS && 'this volume keeps case' }, () => {
  const spelled = Array.from({ length: LINKS }, (_, i) => path.join(BIG, `F${i}.BIN`));
  const { value, names: read } = counted(() => spelled.map((p) => knownSizeOf(p)));
  assert.deepEqual({ sizes: value, 'names folded': read }, { sizes: Array.from({ length: LINKS }, (_, i) => i + 1), 'names folded': 0 });
});

test('a batch of links spelled in another case is sized, folding the folder\'s names once for the whole batch — and once again for a later batch, which reads the scan as it is then', { skip: (WINDOWS || !CASE_FOLDS) && 'needs links, on a volume that folds case' }, async () => {
  const spelled = Array.from({ length: LINKS }, (_, i) => path.join(BIG, `L${i}`));
  const listed = Array.from({ length: LINKS }, (_, i) => knownSizeOf(path.join(BIG, `l${i}`)));
  const first = counted(() => spelled.map((p) => knownSizeOf(p)));
  await new Promise((resolve) => setImmediate(resolve)); // the batch's turn of the event loop ends
  const later = counted(() => spelled.map((p) => knownSizeOf(p)));
  assert.ok(listed.every((size) => size !== null), `each link is sized by its own spelling (${listed.join(', ')})`);
  assert.deepEqual(
    { sizes: first.value, 'names folded': first.names, 'a later batch, names folded': later.names },
    { sizes: listed, 'names folded': FILES + LINKS, 'a later batch, names folded': FILES + LINKS },
  );
});

test('a name more than one sibling folds to is "unknown", never one of their sizes: a link spelled in another case beside a different file whose name folds the same, and a link the scan never listed beside two that fold alike — while a link alone in its fold is sized (the final review, F3.4)', { skip: WINDOWS && 'needs links' }, () => {
  const late = path.join(LATE, '𝐫0'); // made after the scan: the scan never listed it
  fs.symlinkSync(path.join(LATE, 'R0'), late);
  try {
    const sizes: Record<string, number | null> = { 'a link the scan never listed, beside R0 and Ｒ0': knownSizeOf(late) };
    const expected: Record<string, number | null> = { 'a link the scan never listed, beside R0 and Ｒ0': null };
    if (CASE_FOLDS) {
      const listed = knownSizeOf(path.join(AMBIGUOUS, 'm0'));
      assert.ok(listed !== null, 'the link m0 is sized by its own spelling');
      sizes['the link l0, spelled L0, beside Ｌ0'] = knownSizeOf(path.join(AMBIGUOUS, 'L0'));
      sizes['the link m0, spelled M0, alone in its fold'] = knownSizeOf(path.join(AMBIGUOUS, 'M0'));
      expected['the link l0, spelled L0, beside Ｌ0'] = null;
      expected['the link m0, spelled M0, alone in its fold'] = listed;
    }
    assert.deepEqual(sizes, expected);
  } finally {
    fs.rmSync(late);
  }
});

test('an entry the scan never listed is "unknown" beside the one scanned sibling whose name folds the same but which the volume keeps apart — never that sibling\'s size, since the byte cap would then judge a different file than the one named', () => {
  const made: string[] = [];
  try {
    const sizes: Record<string, number | null> = {};
    const file = path.join(APART, 'y1');
    fs.writeFileSync(file, Buffer.alloc(13, 1));
    made.push(file);
    sizes['a file y1 made after the scan, beside Ｙ1'] = knownSizeOf(file);
    if (!WINDOWS) {
      const link = path.join(APART, 'x1');
      fs.symlinkSync(path.join(APART, 'target.bin'), link);
      made.push(link);
      sizes['a link x1 made after the scan, beside Ｘ1'] = knownSizeOf(link);
    }
    assert.deepEqual(sizes, Object.fromEntries(Object.keys(sizes).map((what) => [what, null])));
  } finally {
    for (const p of made) fs.rmSync(p);
  }
});

/** A scan of `root`, started and settled, which `knownSizeOf` reads from then on beside the first. */
async function scanned(root: string): Promise<ScanResult> {
  const result = await startScan(root);
  await waitFor(() => result.status !== 'running', `the scan of ${root}`);
  assert.equal(result.status, 'complete', result.error);
  return result;
}

test('a path beside a second scan\'s root, under a name that folds as that root\'s own but which the volume keeps apart, is "unknown" — never a size from inside that root — while a file only the second scan listed is sized through a link to it', async () => {
  const late = path.join(PROJ, 'late.bin'); // after the first scan: only the second lists it
  const LATE_BYTES = 23;
  fs.writeFileSync(late, Buffer.alloc(LATE_BYTES, 1));
  await scanned(PROJ);
  const apart = path.join(ROOT, 'Ｐroj'); // after both scans
  fs.mkdirSync(apart);
  fs.writeFileSync(path.join(apart, 'x'), Buffer.alloc(OTHER_BYTES, 1));
  try {
    const sizes: Record<string, number | null> = {
      'Ｐroj/x, beside the second scan\'s root proj, which holds an x': knownSizeOf(path.join(apart, 'x')),
      'the folder Ｐroj itself': knownSizeOf(apart),
    };
    const expected: Record<string, number | null> = {
      'Ｐroj/x, beside the second scan\'s root proj, which holds an x': null,
      'the folder Ｐroj itself': null,
    };
    if (!WINDOWS) {
      sizes['proj/late.bin, spelled through the link via'] = knownSizeOf(path.join(ROOT, 'via', 'late.bin'));
      expected['proj/late.bin, spelled through the link via'] = LATE_BYTES;
    }
    assert.deepEqual(sizes, expected);
  } finally {
    fs.rmSync(apart, { recursive: true });
  }
});

test('a scan of one file, its name typed in another case, sizes that file by the name the volume stores: the volume answers both names with one entry', { skip: !CASE_FOLDS && 'this volume keeps case' }, async () => {
  const solo = path.join(ROOT, 'Solo.bin'); // after the first scan: only the scan below lists it
  const SOLO_BYTES = 19;
  fs.writeFileSync(solo, Buffer.alloc(SOLO_BYTES, 1));
  await scanned(path.join(ROOT, 'SOLO.BIN'));
  assert.equal(knownSizeOf(solo), SOLO_BYTES);
});

test('a name found by its fold counts only on the volume\'s own word that both names are one entry — one device AND one id, an id that is not 0, an answer at all — shown with a stand-in for that one question (the review of LEFT2, F1.4)', () => {
  const file = path.join(APART, 'y1'); // made after the scan, beside Ｙ1, whose name folds the same
  const sibling = path.join(APART, 'Ｙ1');
  fs.writeFileSync(file, Buffer.alloc(13, 1));
  /** What the stand-in answers when the identity of `file`, then of `sibling`, is asked (bigint, links not followed). */
  type Identity = { dev: bigint; ino: bigint } | 'throws';
  const answers: Record<string, [Identity, Identity]> = {
    'one device and one id': [{ dev: 1n, ino: 42n }, { dev: 1n, ino: 42n }],
    'one id on two devices': [{ dev: 1n, ino: 42n }, { dev: 2n, ino: 42n }],
    'an id of 0 for both': [{ dev: 1n, ino: 0n }, { dev: 1n, ino: 0n }],
    'no answer: the look fails': ['throws', 'throws'],
  };
  type Lstat = (p: fs.PathLike, options?: { bigint?: boolean }) => unknown;
  const host = fs as unknown as { lstatSync: Lstat };
  const real = host.lstatSync;
  const sizes: Record<string, number | null> = {};
  try {
    for (const [what, [first, second]] of Object.entries(answers)) {
      host.lstatSync = (p, options) => {
        const answer = p === file ? first : p === sibling ? second : null;
        if (answer === null || options?.bigint !== true) return real(p, options);
        if (answer === 'throws') throw Object.assign(new Error(`EIO: i/o error, lstat '${String(p)}'`), { code: 'EIO' });
        return answer;
      };
      sizes[what] = knownSizeOf(file);
    }
  } finally {
    host.lstatSync = real;
    fs.rmSync(file);
  }
  assert.deepEqual(sizes, {
    'one device and one id': OTHER_BYTES, // the stand-in reaches the rule: Ｙ1's size
    'one id on two devices': null,
    'an id of 0 for both': null,
    'no answer: the look fails': null,
  });
});

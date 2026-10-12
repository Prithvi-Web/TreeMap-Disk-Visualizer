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

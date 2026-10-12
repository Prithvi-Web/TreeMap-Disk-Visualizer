import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-snapshotRecoveredSize-data-');

import { platform, resetPlatformForTests } from '../src/platform';
import { restoreFromSnapshot } from '../src/services/snapshotRecovery';
import { INDEX } from './fixtures/liftFrontend';

/**
 * What a recovery from a snapshot reports as its size (the final review, F1.15). A recovered folder was
 * reported with its directory entry's own size from lstat — 96 B on APFS for a whole tree — so the page
 * said "Recovered 96 B" and the audit recorded that figure. Now a folder reports the bytes of the files
 * recovered in it, and one whose tree cannot be read reports none (null), never a wrong number.
 *
 * Nothing reaches the machine's snapshots: the snapshot list and the copy out of one are stood in for on
 * the platform object, the copy made from a folder of this file's own.
 */

afterEach(() => {
  resetPlatformForTests();
});

/** Makes `platform()` recover `original` by copying `from` (a folder or file of this test's) to the destination. */
function standInRecovery(from: string, after?: (destination: string) => void): void {
  const provider = platform() as unknown as Record<string, unknown>;
  provider.listSnapshots = async () => [{ id: 'snap-1', name: 'snap-1', takenAt: 1, volume: path.parse(from).root, accessPath: from }];
  provider.restoreFolderRefusal = async () => null;
  provider.recoverFromSnapshots = async (_snaps: unknown, _original: string, destination: string) => {
    fs.cpSync(from, destination, { recursive: true });
    after?.(destination);
    return { restored: true, fromSnapshotId: 'snap-1', sizeBytes: fs.lstatSync(destination).size };
  };
}

test('a recovered folder reports the bytes of the files in it, not its directory entry\'s size', async () => {
  const snapshot = fileTempDir('treemap-snapshotRecoveredSize-snap-');
  const photos = path.join(snapshot, 'Photos');
  fs.mkdirSync(path.join(photos, 'trip'), { recursive: true });
  fs.writeFileSync(path.join(photos, 'a.jpg'), Buffer.alloc(1_000_000, 1));
  fs.writeFileSync(path.join(photos, 'b.jpg'), Buffer.alloc(1_000_000, 2));
  fs.writeFileSync(path.join(photos, 'trip', 'c.jpg'), Buffer.alloc(1_000_000, 3));
  standInRecovery(photos);
  const destination = path.join(fileTempDir('treemap-snapshotRecoveredSize-dest-'), 'Photos (recovered)');
  const out = await restoreFromSnapshot({ path: path.join(fileTempDir('treemap-snapshotRecoveredSize-home-'), 'Photos'), destination });
  assert.equal(out.restoredTo, destination);
  assert.equal(out.sizeBytes, 3_000_000);
});

test('a link in a recovered folder is counted as itself, never followed to what it names (final review F2.7)', { skip: process.platform === 'win32' ? 'links need privileges on Windows' : false }, async () => {
  const snapshot = fileTempDir('treemap-snapshotRecoveredSize-links-');
  const folder = path.join(snapshot, 'Project');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'notes.txt'), Buffer.alloc(1000, 1));
  // A large folder beside it, which a link inside the recovered folder names.
  const big = path.join(fileTempDir('treemap-snapshotRecoveredSize-links-big-'), 'big');
  fs.mkdirSync(big);
  fs.writeFileSync(path.join(big, 'a.bin'), Buffer.alloc(2_000_000, 2));
  fs.writeFileSync(path.join(big, 'b.bin'), Buffer.alloc(2_000_000, 3));
  let link = '';
  standInRecovery(folder, (destination) => {
    link = path.join(destination, 'big-link');
    fs.symlinkSync(big, link, 'dir');
  });
  const destination = path.join(fileTempDir('treemap-snapshotRecoveredSize-links-dest-'), 'Project (recovered)');
  const out = await restoreFromSnapshot({ path: path.join(fileTempDir('treemap-snapshotRecoveredSize-links-home-'), 'Project'), destination });
  assert.equal(out.sizeBytes, 1000 + fs.lstatSync(link).size, 'the file, and the link\'s own size — not the 4 MB it names');
});

test('a recovered file still reports its own size', async () => {
  const snapshot = fileTempDir('treemap-snapshotRecoveredSize-file-');
  const notes = path.join(snapshot, 'notes.txt');
  fs.writeFileSync(notes, Buffer.alloc(1234, 7));
  standInRecovery(notes);
  const destination = path.join(fileTempDir('treemap-snapshotRecoveredSize-file-dest-'), 'notes (recovered).txt');
  const out = await restoreFromSnapshot({ path: path.join(fileTempDir('treemap-snapshotRecoveredSize-file-home-'), 'notes.txt'), destination });
  assert.equal(out.sizeBytes, 1234);
});

test('a recovered folder whose tree cannot be read reports no size, never a wrong one', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'permissions do not stop this user here' : false }, async () => {
  const snapshot = fileTempDir('treemap-snapshotRecoveredSize-locked-');
  const folder = path.join(snapshot, 'Folder');
  fs.mkdirSync(path.join(folder, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'inner', 'x.bin'), Buffer.alloc(500, 1));
  let locked = '';
  standInRecovery(folder, (destination) => {
    locked = path.join(destination, 'inner');
    fs.chmodSync(locked, 0o000);
  });
  const destination = path.join(fileTempDir('treemap-snapshotRecoveredSize-locked-dest-'), 'Folder (recovered)');
  try {
    const out = await restoreFromSnapshot({ path: path.join(fileTempDir('treemap-snapshotRecoveredSize-locked-home-'), 'Folder'), destination });
    assert.equal(out.sizeBytes, null);
  } finally {
    if (locked) fs.chmodSync(locked, 0o755);
  }
});

/** The page's own restoreFromSnapshot, evaluated: what it shows for the server's answer `out`. */
async function pageShows(out: Record<string, unknown>): Promise<string> {
  const at = INDEX.indexOf('async function restoreFromSnapshot(');
  assert.notEqual(at, -1, 'the page has it');
  const open = INDEX.indexOf('{', INDEX.indexOf(')', at));
  let depth = 0;
  let end = open;
  for (let i = open; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const host = { innerHTML: '', querySelector: () => null };
  const restore = new Function('api', 'icon', 'escapeHtml', 'formatBytes', 'snapNewerUnreadText', 'wireSnapshotActions', 'toast',
    `${INDEX.slice(at, end)}; return restoreFromSnapshot;`,
  )(async () => out, () => '', String, (n: number) => `${n} B`, () => '', () => undefined, () => undefined) as (p: string, h: unknown) => Promise<void>;
  await restore('/home/me/Photos', host);
  return host.innerHTML.replace(/<[^>]+>/g, '');
}

test('the page says it recovered the folder when no size is known, and the size when it is', async () => {
  const sized = await pageShows({ restored: true, restoredTo: '/home/me/Photos (recovered)', sizeBytes: 3000, fromSnapshotId: 's' });
  assert.match(sized, /Recovered 3000 B to \/home\/me\/Photos \(recovered\)/, sized);
  const unsized = await pageShows({ restored: true, restoredTo: '/home/me/Photos (recovered)', sizeBytes: null, fromSnapshotId: 's' });
  assert.match(unsized, /Recovered it to \/home\/me\/Photos \(recovered\)/, unsized);
  assert.doesNotMatch(unsized, /null|NaN/, unsized);
});

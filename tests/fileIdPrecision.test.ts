import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-fileIdPrecision-data-');

import { sanitizePath } from '../src/utils/pathSanitizer';

/**
 * NTFS file ids above 2^53 (POL item 9, 6 Oct 2026).
 *
 * An NTFS file id is 64 bits — a 48-bit record number under a 16-bit sequence
 * number — so on a volume whose records have been reused the ids pass 2^53,
 * where a JavaScript number keeps only every 256th integer near 2^60. Read
 * from a plain `fs.stat` as a number, two different folders can carry one id.
 * The sanitizer refuses a folder that IS a blocked one under another name by
 * comparing device and id; compared as numbers, a folder named like a blocked
 * one ("dev", "System32") whose id differs only past the 53rd bit was refused
 * as that folder. Ids are compared in full now (bigint stats), as the Time
 * Capsule, the copy check and the restore sweep already compare them.
 *
 * No volume this suite can make hands out such ids, so `fs.statSync` answers
 * for the blocked folders and the two candidates — exactly as Node answers on
 * NTFS: the full id with `{ bigint: true }`, the rounded number without —
 * before anything in this file has asked the sanitizer, whose memo of the
 * blocked folders' ids is made at its first such question.
 */

// Not a number JavaScript can hold exactly (2^60 + 1 reads as 2^60), nor is the
// id one past it: so a check that reads either side as a number is caught too.
const BLOCKED_ID = 2n ** 60n + 1n;
const DEV = 7n;
const windows = process.platform === 'win32';
/** The sanitizer's blocklist as it stats it (pathSanitizer.ts UNIX_BLOCKLIST / WINDOWS_BLOCKLIST). */
const BLOCKED = windows
  ? ['c:\\windows\\system32', 'c:\\windows\\syswow64', 'c:\\windows\\winsxs', 'c:\\$recycle.bin', 'c:\\system volume information']
  : ['/proc', '/sys', '/dev', '/run', '/private/var/db', '/System/Volumes/VM'];

test('a folder named like a blocked one whose NTFS-sized id differs from it only past 2^53 is not refused as that folder; one with the same id still is (POL item 9)', () => {
  const base = fs.realpathSync(fileTempDir('tm-fileid-'));
  const name = windows ? 'System32' : 'dev';
  const other = path.join(base, 'other', name); // a different folder: its id is one past the blocked folder's
  const same = path.join(base, 'same', name); // the blocked folder under a second name: its id is the blocked folder's
  fs.mkdirSync(other, { recursive: true });
  fs.mkdirSync(same, { recursive: true });
  const ids = new Map<string, bigint>([...BLOCKED.map((b): [string, bigint] => [b, BLOCKED_ID]), [other, BLOCKED_ID + 1n], [same, BLOCKED_ID]]);
  const statSync = fs.statSync;
  const asked: string[] = [];
  (fs as { statSync: unknown }).statSync = (p: fs.PathLike, opts?: { bigint?: boolean }) => {
    const id = ids.get(String(p));
    if (id === undefined) return (statSync as (...a: unknown[]) => unknown)(p, opts);
    asked.push(String(p));
    return opts?.bigint ? { dev: DEV, ino: id } : { dev: Number(DEV), ino: Number(id) };
  };
  let verdicts: Record<string, string>;
  try {
    const verdict = (p: string): string => {
      try {
        sanitizePath(p);
        return 'allowed';
      } catch (err) {
        return (err as { code?: string }).code ?? String(err);
      }
    };
    verdicts = { other: verdict(other), same: verdict(same) };
  } finally {
    (fs as { statSync: unknown }).statSync = statSync;
  }
  assert.ok(asked.includes(other) && asked.some((p) => BLOCKED.includes(p)), `control: the identity check asked about both folders and the blocklist (${asked.join(', ')})`);
  assert.deepEqual(verdicts, { other: 'allowed', same: 'PATH_BLOCKED' });
});

import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pending, settled } from '../../src/utils/backgroundWrites';

/** How long a cleanup waits for the app's own background saves before it removes the folders anyway. */
const SETTLE_LIMIT_MS = 10_000;

/** The folders this test file made through the fixture, removed when its tests are done. */
const madeForThisFile: string[] = [];

// Registered once, as this module loads, before any test runs: so a folder
// made inside a test is removed with the file's, on every Node version,
// instead of by a hook whose owner depends on where it was called from.
after(async () => {
  for (const dir of madeForThisFile.splice(0)) {
    for (const note of await cleanUpDataDir(dir)) console.warn(note);
  }
});

/**
 * Points the app's data folder (TREEMAP_DATA_DIR) at a new folder under the
 * system temp folder for the rest of this test file, and removes the folder
 * once the file's tests are done. Called where the file used to assign the
 * variable itself, so it still runs before any service reads the folder.
 * Every file that isolated its app data that way left the folder behind on
 * every run (41 after one full `npm test`, 23 Sep 2026).
 */
export function isolatedDataDir(prefix: string): string {
  const dir = fileTempDir(prefix);
  process.env.TREEMAP_DATA_DIR = dir;
  return dir;
}

/**
 * A new folder under the system temp folder, removed once this test file's
 * tests are done — at the top of a file or inside one of its tests.
 */
export function fileTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  madeForThisFile.push(dir);
  return dir;
}

/**
 * Waits for the app's background saves (`trackWrite`: a scan saves its
 * snapshot and cache after it has answered, and one landing after the removal
 * made the folder again), then removes `dir`. Answers what it could not do,
 * in words; never throws, since the tests the folder served have finished.
 */
export async function cleanUpDataDir(dir: string, limitMs = SETTLE_LIMIT_MS): Promise<string[]> {
  const notes: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), limitMs);
  });
  const outcome = await Promise.race([settled().then(() => 'settled' as const), late]);
  clearTimeout(timer);
  if (outcome === 'late') notes.push(`[tests] background saves still running after ${limitMs} ms: ${pending().join(', ')}`);
  const left = removeTempDir(dir);
  if (left !== null) notes.push(left);
  return notes;
}

/**
 * Removes `dir` and everything in it, retrying as Windows needs for a file
 * another process has only just let go of. Answers why it could not, or
 * null: a folder left behind is reported, never a failure.
 */
export function removeTempDir(dir: string): string | null {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    return null;
  } catch (err) {
    return `[tests] ${dir} was left behind: ${err instanceof Error ? err.message : String(err)}`;
  }
}

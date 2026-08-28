import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * What happens to a store this app cannot parse.
 *
 * Nine services here are read-modify-write over a JSON file in the app-data
 * directory, and `readJsonFile` answers a fallback for one it cannot parse —
 * so the very next save replaces the unreadable file with a partial one. The
 * comment used to say "nothing usable to preserve", which is true of the
 * PARSE and false of the bytes:
 *
 *   - `offload-manifest.json` is the only record of where a user's offloaded
 *     files went;
 *   - `cloud-tokens.json` holds credentials for every provider, and saving one
 *     rewrites the file;
 *   - `settings.json` carries the ignore list that gates what Autopilot may
 *     touch.
 *
 * Resetting to defaults is a reasonable thing to do with a broken preferences
 * file. Destroying it on the way is not, and it costs one `copyFile` to avoid.
 */

function withDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-corrupt-'));
  const prior = process.env.TREEMAP_DATA_DIR;
  process.env.TREEMAP_DATA_DIR = dir;
  return fn(dir).finally(() => {
    process.env.TREEMAP_DATA_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('a corrupt store is kept before anything overwrites it', async () => {
  await withDataDir(async (dir) => {
    const { readJsonFile, writeJsonFile } = await import('../src/services/storage');
    const original = '{"entries":[{"id":"the-only-record-of-an-offloaded-file"';
    fs.writeFileSync(path.join(dir, 'offload-manifest.json'), original);

    // Exactly the read-modify-write every one of those services performs.
    const store = await readJsonFile<{ entries: unknown[] }>('offload-manifest.json', { entries: [] });
    store.entries.push({ id: 'a-new-one' });
    await writeJsonFile('offload-manifest.json', store);

    const kept = path.join(dir, 'offload-manifest.json.corrupt');
    assert.ok(fs.existsSync(kept), 'the unreadable original is kept beside itself');
    assert.equal(fs.readFileSync(kept, 'utf8'), original, 'byte for byte — it is evidence, not a draft');
    assert.match(fs.readFileSync(path.join(dir, 'offload-manifest.json'), 'utf8'), /a-new-one/);
  });
});

test('the backup is made once, however many times the file is read', async () => {
  // `readJsonFile` sits on hot paths — `getPolicy` runs on every enforcement —
  // so a corrupt file must not copy itself on every call, and a later read
  // must not overwrite the FIRST backup with a second-hand one.
  await withDataDir(async (dir) => {
    const { readJsonFile } = await import('../src/services/storage');
    fs.writeFileSync(path.join(dir, 'settings.json'), '{oops');
    for (let i = 0; i < 5; i++) await readJsonFile('settings.json', {});
    const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt'));
    assert.equal(backups.length, 1, `expected one backup, found ${backups.join(', ')}`);
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json.corrupt'), 'utf8'), '{oops');
  });
});

test('an absent store is a first run, and leaves nothing behind', async () => {
  // The caveat has to mean something: a `.corrupt` file appearing on a fresh
  // install would be alarming and wrong.
  await withDataDir(async (dir) => {
    const { readJsonFile } = await import('../src/services/storage');
    assert.deepEqual(await readJsonFile('never-written.json', { fresh: true }), { fresh: true });
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing is created for a file that was never there');
  });
});

test('a readable store is returned untouched, with no backup', async () => {
  await withDataDir(async (dir) => {
    const { readJsonFile } = await import('../src/services/storage');
    fs.writeFileSync(path.join(dir, 'fine.json'), JSON.stringify({ ok: 1 }));
    assert.deepEqual(await readJsonFile('fine.json', {}), { ok: 1 });
    assert.deepEqual(fs.readdirSync(dir), ['fine.json']);
  });
});

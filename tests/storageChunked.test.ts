import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isolatedDataDir } from './fixtures/dataDir';
isolatedDataDir('treemap-storageChunked-data-');

/**
 * `writeFileChunked`: a file of the app-data directory written from chunks,
 * for a document too big to build as one string (the fast-rescan cache of a
 * 200,000-entry scan is 48 MB). The promises are writeJsonFile's — tmp then
 * rename, so a reader sees the old file or the new one and never half of
 * either, and writes of one name queue — plus one of its own: a producer that
 * gives up (or throws) leaves the old file exactly as it was and no tmp file
 * behind.
 */

function withDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-chunked-'));
  const prior = process.env.TREEMAP_DATA_DIR;
  process.env.TREEMAP_DATA_DIR = dir;
  return fn(dir).finally(() => {
    // Assigned undefined, process.env holds the string "undefined".
    if (prior === undefined) delete process.env.TREEMAP_DATA_DIR;
    else process.env.TREEMAP_DATA_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const leftovers = (dir: string): string[] => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));

test('the chunks land as one file, atomically, and no tmp file stays', async () => {
  await withDataDir(async (dir) => {
    const { writeFileChunked } = await import('../src/services/storage');
    const replaced = await writeFileChunked('doc.json', async (write) => {
      for (const piece of ['{"a":', '[1,2', ',3]', '}']) await write(piece);
      return true;
    });
    assert.equal(replaced, true);
    assert.equal(fs.readFileSync(path.join(dir, 'doc.json'), 'utf8'), '{"a":[1,2,3]}');
    assert.deepEqual(leftovers(dir), []);
  });
});

test('a producer that gives up leaves the old file byte for byte, and no tmp file', async () => {
  await withDataDir(async (dir) => {
    const { writeFileChunked } = await import('../src/services/storage');
    fs.writeFileSync(path.join(dir, 'doc.json'), 'the old document');
    const replaced = await writeFileChunked('doc.json', async (write) => {
      await write('half of a new ');
      return false;
    });
    assert.equal(replaced, false);
    assert.equal(fs.readFileSync(path.join(dir, 'doc.json'), 'utf8'), 'the old document');
    assert.deepEqual(leftovers(dir), []);
  });
});

test('a producer that throws rejects, and leaves the old file and no tmp file', async () => {
  await withDataDir(async (dir) => {
    const { writeFileChunked } = await import('../src/services/storage');
    fs.writeFileSync(path.join(dir, 'doc.json'), 'the old document');
    await assert.rejects(writeFileChunked('doc.json', async (write) => {
      await write('half of a new ');
      throw new Error('the producer failed');
    }), /the producer failed/);
    assert.equal(fs.readFileSync(path.join(dir, 'doc.json'), 'utf8'), 'the old document');
    assert.deepEqual(leftovers(dir), []);
  });
});

/** Every file handle opened while `fn` runs fails its close() — after really closing. */
async function withFailingClose<T>(fn: () => Promise<T>): Promise<T> {
  const promises = fs.promises as unknown as { open: (...args: unknown[]) => Promise<{ close: () => Promise<void> }> };
  const realOpen = promises.open;
  promises.open = async (...args: unknown[]) => {
    const handle = await realOpen.apply(fs.promises, args);
    const realClose = handle.close.bind(handle);
    handle.close = async () => {
      await realClose();
      throw new Error('close failed');
    };
    return handle;
  };
  try {
    return await fn();
  } finally {
    promises.open = realOpen;
  }
}

test('a close that fails is never renamed into place: the old file stays and no tmp file is left', async () => {
  await withDataDir(async (dir) => {
    const { writeFileChunked } = await import('../src/services/storage');
    fs.writeFileSync(path.join(dir, 'doc.json'), 'the old document');
    await withFailingClose(() => assert.rejects(writeFileChunked('doc.json', async (write) => {
      await write('a whole new document');
      return true;
    }), /close failed/));
    assert.equal(fs.readFileSync(path.join(dir, 'doc.json'), 'utf8'), 'the old document');
    assert.deepEqual(leftovers(dir), []);
  });
});

test('when the producer throws and the close fails too, the producer’s error is the one reported', async () => {
  await withDataDir(async (dir) => {
    const { writeFileChunked } = await import('../src/services/storage');
    await withFailingClose(() => assert.rejects(writeFileChunked('doc.json', async () => {
      throw new Error('the producer failed');
    }), /the producer failed/));
    assert.deepEqual(leftovers(dir), []);
  });
});

test('a failed write does not poison the queue: the next write of the name still lands', async () => {
  await withDataDir(async (dir) => {
    const { writeFileChunked } = await import('../src/services/storage');
    const failed = writeFileChunked('doc.json', async () => {
      throw new Error('the producer failed');
    });
    const next = writeFileChunked('doc.json', async (write) => {
      await write('the next document');
      return true;
    });
    await assert.rejects(failed, /the producer failed/);
    assert.equal(await next, true);
    assert.equal(fs.readFileSync(path.join(dir, 'doc.json'), 'utf8'), 'the next document');
  });
});

test('two writes of one name queue: they never interleave, and the later one wins', async () => {
  await withDataDir(async (dir) => {
    const { writeFileChunked } = await import('../src/services/storage');
    const writer = (tag: string) => async (write: (chunk: string) => Promise<void>): Promise<boolean> => {
      for (let i = 0; i < 50; i++) {
        await write(`${tag}${i};`);
        await new Promise((r) => setImmediate(r));
      }
      return true;
    };
    const [first, second] = await Promise.all([
      writeFileChunked('doc.json', writer('A')),
      writeFileChunked('doc.json', writer('B')),
    ]);
    assert.equal(first, true);
    assert.equal(second, true);
    const want = Array.from({ length: 50 }, (_, i) => `B${i};`).join('');
    assert.equal(fs.readFileSync(path.join(dir, 'doc.json'), 'utf8'), want);
    assert.deepEqual(leftovers(dir), []);
  });
});

const NO_CHMOD = process.platform === 'win32'
  ? 'chmod cannot make a directory read-only on Windows — the read-only medium case is POSIX-shaped'
  : process.getuid?.() === 0
    ? 'root may write anywhere: chmod cannot make a directory read-only for root'
    : false;

test('a read-only portable session writes nothing and never asks the producer', { skip: NO_CHMOD }, async () => {
  const { initPortableMode, resetPortableMode, PORTABLE_DATA_DIRNAME } = await import('../src/services/portableMode');
  const { writeFileChunked } = await import('../src/services/storage');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-chunked-ro-'));
  const readOnly = path.join(base, 'ro');
  fs.mkdirSync(readOnly);
  fs.chmodSync(readOnly, 0o500);
  try {
    resetPortableMode();
    const status = initPortableMode({ TREEMAP_PORTABLE: '1', TREEMAP_DATA_DIR: path.join(readOnly, PORTABLE_DATA_DIRNAME) } as NodeJS.ProcessEnv);
    assert.equal(status.writable, false, 'the session under test is the read-only one');
    let asked = false;
    const replaced = await writeFileChunked('doc.json', async () => {
      asked = true;
      return true;
    });
    assert.equal(replaced, false);
    assert.equal(asked, false, 'nothing is even produced');
  } finally {
    resetPortableMode();
    fs.chmodSync(readOnly, 0o700);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a rename that fails removes the tmp file and rejects, for both writers', async () => {
  // The pre-landing review of 23 Sep 2026: the rename was the one step whose
  // failure left the tmp file behind (on Windows, a target another program
  // holds open refuses it). A non-empty folder at the target's name refuses
  // a rename on every platform.
  await withDataDir(async (dir) => {
    const { writeFileChunked, writeJsonFile } = await import('../src/services/storage');
    for (const name of ['chunked.json', 'whole.json']) {
      fs.mkdirSync(path.join(dir, name));
      fs.writeFileSync(path.join(dir, name, 'keep'), 'x');
    }
    await assert.rejects(writeFileChunked('chunked.json', async (write) => {
      await write('{}');
      return true;
    }));
    await assert.rejects(writeJsonFile('whole.json', { a: 1 }));
    assert.deepEqual(leftovers(dir), [], 'no tmp file stays');
    assert.ok(fs.existsSync(path.join(dir, 'chunked.json', 'keep')) && fs.existsSync(path.join(dir, 'whole.json', 'keep')), 'what was there is untouched');
  });
});

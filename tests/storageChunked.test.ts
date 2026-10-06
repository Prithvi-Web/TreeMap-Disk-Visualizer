import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { waitFor, withinHangGuard } from './fixtures/waitFor';
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

/* ─────────────── FG3g review F2.5: two processes saving one file at once ─────────────── */

const tsxCli = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const WRITER = path.join(__dirname, 'fixtures', 'storageWriterChild.ts');

/**
 * The app and the MCP server are two processes saving into one app-data folder, and nothing
 * coordinates them. Every save went through one fixed temp name, so a save in one process truncated
 * and wrote into the very temp file the other was half-way through: the file came out torn, a reader
 * took it for corrupt and started from empty, and the next save of offload-manifest.json kept only
 * its own entries. Here a real second process is held half-way through its save while this one saves.
 *
 * Each writer against itself (FG3g review F3.5): a pair of different writers kept their temp files
 * apart even had one of them gone back to the fixed name, so it could not show either one had its
 * own — and writeJsonFile is the writer behind offload-manifest.json.
 */
const WRITERS: { writer: 'chunked' | 'json'; held: string }[] = [
  { writer: 'chunked', held: 'half-way through writing its temp file' },
  { writer: 'json', held: 'between writing its temp file and renaming it into place' },
];

for (const { writer, held } of WRITERS) {
  test(`a save by another TreeMap process at the same moment never tears the file: each writes a temp file of its own, and the file is one whole document (${writer === 'json' ? 'writeJsonFile' : 'writeFileChunked'} in both)`, async () => {
    await withDataDir(async (dir) => {
      const { writeFileChunked, writeJsonFile } = await import('../src/services/storage');
      const first = `{"who":"the other process","pad":"${'c'.repeat(2000)}`;
      const rest = `${'c'.repeat(2000)}"}`;
      const child = spawn(process.execPath, [tsxCli, WRITER, dir, 'shared.json', first, rest, writer], {
        env: { ...process.env, TREEMAP_DATA_DIR: dir },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
      // 'close', not 'exit': it comes once the child's output has all been read, its last line included.
      const exited = new Promise<void>((resolve) => { child.once('close', () => resolve()); });
      const mine = { who: 'this process', pad: 'p'.repeat(6000) };
      try {
        await waitFor(() => out.includes('HALF') || child.exitCode !== null, `the other process held ${held}`);
        assert.match(out, /HALF/, out);
        if (writer === 'json') {
          await writeJsonFile('shared.json', mine);
        } else {
          assert.equal(await writeFileChunked('shared.json', async (write) => {
            await write(JSON.stringify(mine));
            return true;
          }), true);
        }
        assert.equal((JSON.parse(fs.readFileSync(path.join(dir, 'shared.json'), 'utf8')) as { who: string }).who, 'this process', 'this process\'s save is in place, whole');
        child.stdin.write('GO\n');
        await withinHangGuard(exited, 'the other process finishing its save');
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
      assert.match(out, /DONE/, `the other process's save finished: ${out}`);
      const text = fs.readFileSync(path.join(dir, 'shared.json'), 'utf8');
      assert.deepEqual(JSON.parse(text), { who: 'the other process', pad: 'c'.repeat(4000) }, 'the file is the later save\'s whole document, never a mix of the two');
      assert.deepEqual(leftovers(dir), [], 'and neither temp file stays');
    });
  });
}

/* ─────────────── FG3g review F3.2, F3.7: what a killed save left is removed at the next start ─────────────── */

/** A pid no process has (tests/spillSweep.test.ts pins it): `process.kill` takes nothing larger. */
const NO_SUCH_PID = 2 ** 31 - 1;

/**
 * Each save writes a temp file named for its own process, so a later save — by another process, as
 * every later start is — never replaces one a killed or crashed save left: a scan's cache, tens of
 * megabytes, stayed half-written for good in a disk-space tool's own folder. The start sweep removes
 * those, and only those: here a real save is killed half-way, beside a save of a process still
 * running and every other kind of name the sweep must leave alone.
 */
test('the start sweep removes the temp file a killed save left, and keeps one of a process still running, this process\'s own, and every other name', async () => {
  await withDataDir(async (dir) => {
    const { sweepDeadSaveTemps, writeFileChunked } = await import('../src/services/storage');
    const half = (name: string): { child: ReturnType<typeof spawn>; out: () => string; pid: () => number; closed: Promise<void> } => {
      const child = spawn(process.execPath, [tsxCli, WRITER, dir, name, `{"pad":"${'k'.repeat(1000)}`, '"}'], {
        env: { ...process.env, TREEMAP_DATA_DIR: dir },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      let out = '';
      child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
      const closed = new Promise<void>((resolve) => { child.once('close', () => resolve()); });
      // The writer's own process id, which names its temp file: tsx runs it under the process spawned here.
      const pid = (): number => Number(/HALF (\d+)\n/.exec(out)?.[1]);
      return { child, out: () => out, pid, closed };
    };
    const killed = half('cache.json');
    const running = half('live.json');
    try {
      await waitFor(() => killed.pid() > 0 && running.pid() > 0, 'both saves half-way, each having said its process id');
      process.kill(killed.pid(), 'SIGKILL'); // the writer killed part-way, as a crash or a forced quit leaves it
      await withinHangGuard(killed.closed, 'the killed save\'s process ending');
      const deadLeft = `cache.json.${String(killed.pid())}.tmp`;
      const liveLeft = `live.json.${String(running.pid())}.tmp`;
      assert.deepEqual(leftovers(dir).sort(), [deadLeft, liveLeft].sort(), 'each save\'s temp file, under its own process\'s id');
      const keep = [
        liveLeft,
        `settings.json.${String(process.pid)}.tmp`, // this process's own
        'notes.json.tmp', // no process id: not a name a save makes now
        `notes.json.0${String(NO_SUCH_PID)}.tmp`, // not a process id as one is written
        `notes.txt.${String(NO_SUCH_PID)}.tmp`, // not a .json store
        `folder.json.${String(NO_SUCH_PID)}.tmp`, // a folder, not a file
        `link.json.${String(NO_SUCH_PID)}.tmp`, // a link, never followed
      ];
      fs.writeFileSync(path.join(dir, keep[1]), 'mine');
      fs.writeFileSync(path.join(dir, keep[2]), 'old');
      fs.writeFileSync(path.join(dir, keep[3]), 'odd');
      fs.writeFileSync(path.join(dir, keep[4]), 'text');
      fs.mkdirSync(path.join(dir, keep[5]));
      const target = path.join(fileTempDir('treemap-storageChunked-link-target-'), 'kept.txt');
      fs.writeFileSync(target, 'what the link leads to');
      fs.symlinkSync(target, path.join(dir, keep[6]));
      const dead2 = `snapshots.json.${String(NO_SUCH_PID)}.tmp`;
      fs.writeFileSync(path.join(dir, dead2), 'half a snapshot');

      const swept = await sweepDeadSaveTemps();

      assert.deepEqual([...swept.removed].sort(), [deadLeft, dead2].sort(), 'the temp files of processes that are gone are removed');
      for (const name of [deadLeft, dead2]) assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} is gone`);
      assert.deepEqual(swept.failed, []);
      for (const name of keep) assert.ok(fs.lstatSync(path.join(dir, name)), `${name} is kept`);
      assert.ok(fs.existsSync(target), 'and what the link leads to is untouched');
      // The save still running finishes, its file whole.
      running.child.stdin?.write('GO\n');
      await withinHangGuard(running.closed, 'the running save finishing');
      assert.match(running.out(), /DONE/, running.out());
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8')), { pad: 'k'.repeat(1000) });
      // And a later save of the killed one's file is whole, with nothing of the killed save left.
      assert.equal(await writeFileChunked('cache.json', async (write) => { await write('{"again":true}'); return true; }), true);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'cache.json'), 'utf8')), { again: true });
    } finally {
      for (const { child } of [killed, running]) if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
});

const NO_MODES = process.platform === 'win32'
  ? 'a folder\'s mode does not stop a removal on Windows'
  : process.getuid?.() === 0 ? 'running as root, a folder\'s mode stops nothing' : false;

test('a temp file the start sweep cannot remove is left and named with the reason, and the sweep goes on', { skip: NO_MODES }, async () => {
  await withDataDir(async (dir) => {
    const { sweepDeadSaveTemps } = await import('../src/services/storage');
    const stuck = `fleet.json.${String(NO_SUCH_PID)}.tmp`;
    fs.writeFileSync(path.join(dir, stuck), 'half');
    fs.chmodSync(dir, 0o500); // nothing in it may be removed
    let swept: Awaited<ReturnType<typeof sweepDeadSaveTemps>>;
    try {
      swept = await sweepDeadSaveTemps();
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    assert.deepEqual(swept.removed, []);
    assert.deepEqual(swept.failed.map((f) => f.name), [stuck], 'it is named');
    assert.match(swept.failed[0]?.why ?? '', /EACCES|permission/i, swept.failed[0]?.why);
    assert.ok(fs.existsSync(path.join(dir, stuck)), 'and left where it is');
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { checkOpenHandles, describeConflicts } from '../src/services/openHandleGuard';
import { moveToTrash } from '../src/services/cleaner';
import { AppError } from '../src/middleware/errorHandler';
import { platform } from '../src/platform';
import { intersectHandles, type LsofRecord } from '../src/platform/macos/lsofGuard';
import { intersectHandles as intersectProc } from '../src/platform/linux/procFdGuard';
import { expandForRegistration } from '../src/platform/windows/restartManager';

/**
 * B2 — the open-file guard.
 *
 * The integration tests hold *real* descriptors open against *real* files, per
 * §9: a mock here would test the matching logic against my own assumptions
 * about what lsof reports, which is exactly the thing that turned out to be
 * wrong twice already (no `(deleted)` marker on macOS; a directory argument
 * reporting nothing about its contents).
 *
 * Nothing in this file trashes anything. The destructive assertions all run
 * against a *blocked* delete, which by definition never reaches the Trash — and
 * they check that the files are still there afterwards.
 */

const IS_MAC = process.platform === 'darwin';
const IS_UNIX = process.platform !== 'win32';
const mkTmp = (): Promise<string> => fsp.mkdtemp(path.join(os.tmpdir(), 'tm-b2-'));

/**
 * Hold `target` open from a **separate process**, and resolve once it really
 * has it.
 *
 * Not the test process itself: the guard deliberately ignores TreeMap's own
 * descriptors (its duplicate finder streams files while the user is clicking
 * around, and "TreeMap has this file open" is noise, not a warning). So a test
 * that opened the file itself would prove nothing about the case B2 exists for
 * — "a file held open by **another** process" — and would quietly pass no
 * matter how broken detection was.
 *
 * The child announces on stdout only after the descriptor is open, so there is
 * no sleep-and-hope race here.
 */
async function holdOpenElsewhere(target: string): Promise<() => void> {
  const child = spawn(
    process.execPath,
    ['-e', 'const fs=require("fs");fs.openSync(process.argv[1],"r");console.log("open");setInterval(()=>{},1000);', target],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('the holder process never signalled that it opened the file')); }, 10_000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('the holder process exited early')); });
  });
  return () => child.kill('SIGKILL');
}

/* ══════════════════ The matching rule (pure, every OS) ══════════════════ */

const rec = (over: Partial<LsofRecord> = {}): LsofRecord => ({
  pid: 42,
  processName: 'TestApp',
  path: '/a/f.txt',
  ino: 1,
  size: 10,
  markedDeleted: false,
  ...over,
});

test('a handle on a file inside a folder blocks deleting that folder', () => {
  // The finding this feature turns on: `lsof /some/dir` says nothing about a
  // file open inside it, so matching had to become prefix-based. Trashing
  // node_modules while a dev server holds a log open is the everyday case.
  const found = intersectHandles([rec({ path: '/a/logs/app.log' })], [['/a/logs', '/a/logs']]);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, '/a/logs', 'attributed to the folder the user is deleting');
  assert.equal(found[0].openPath, '/a/logs/app.log', 'while naming the file actually in use');
});

test('a sibling folder with a shared name prefix is not claimed', () => {
  // Without the trailing separator, deleting `/a/logs` would warn about
  // `/a/logs-archive/x` — and a guard that cries wolf is one people learn to
  // click straight through.
  assert.deepEqual(intersectHandles([rec({ path: '/a/logs-archive/x.log' })], [['/a/logs', '/a/logs']]), []);
});

test('the deepest match wins, so the warning names the most specific path', () => {
  const found = intersectHandles(
    [rec({ path: '/a/logs/app.log' })],
    [['/a', '/a'], ['/a/logs/app.log', '/a/logs/app.log']],
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].path, '/a/logs/app.log');
});

test('an unlinked inode blocks nothing', () => {
  // Its blocks are already unreachable by name; deleting the name is a no-op,
  // so warning about it would be noise. B5 reports these separately.
  assert.deepEqual(intersectHandles([rec({ markedDeleted: true })], [['/a/f.txt', '/a/f.txt']]), []);
});

test('one process holding many descriptors on one file warns once', () => {
  const found = intersectHandles(
    [rec({ path: '/a/f.txt' }), rec({ path: '/a/f.txt' })],
    [['/a/f.txt', '/a/f.txt']],
  );
  assert.equal(found.length, 1);
});

test('the reported path is the one the caller asked about, not the resolved one', () => {
  // lsof answers with /private/tmp/x for a handle opened on /tmp/x; a warning
  // naming a path the user never typed reads like a different file.
  const found = intersectHandles([rec({ path: '/private/tmp/x' })], [['/private/tmp/x', '/tmp/x']]);
  assert.equal(found[0].path, '/tmp/x');
});

test('Linux /proc matching enforces the identical rule', () => {
  // §11.1: different mechanism, same guarantee. If these two ever diverge, a
  // folder delete is guarded on one OS and not the other.
  const found = intersectProc(
    [{ pid: 7, processName: 'node', path: '/a/logs/app.log', markedDeleted: false, fdPath: '/proc/7/fd/3' }],
    [['/a/logs', '/a/logs']],
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].openPath, '/a/logs/app.log');
  assert.deepEqual(
    intersectProc(
      [{ pid: 7, processName: 'node', path: '/a/logs-archive/x', markedDeleted: false, fdPath: '/proc/7/fd/3' }],
      [['/a/logs', '/a/logs']],
    ),
    [],
    'the prefix boundary holds here too',
  );
});

/* ══════════════════ Windows registration expansion ══════════════════ */

test('Windows expansion turns a folder into the files Restart Manager needs', async () => {
  // Restart Manager has no "list everything open" mode, so the descendant
  // coverage lsof and /proc get for free has to be produced by walking. Pure
  // fs work, so it is verified here rather than only in Windows CI.
  const dir = await mkTmp();
  try {
    await fsp.mkdir(path.join(dir, 'sub'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'a.txt'), 'a');
    await fsp.writeFile(path.join(dir, 'sub', 'b.txt'), 'b');

    const { files, complete } = await expandForRegistration([dir]);
    assert.equal(complete, true);
    assert.deepEqual(
      files.map((f) => path.relative(dir, f)).sort(),
      ['a.txt', path.join('sub', 'b.txt')],
      'nested files are registered, not just the folder',
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('hitting the registration cap is reported, never passed off as a clean result', async () => {
  const dir = await mkTmp();
  try {
    for (let i = 0; i < 5; i++) await fsp.writeFile(path.join(dir, `f${String(i)}.txt`), 'x');
    const { files, complete } = await expandForRegistration([dir], 3);
    assert.equal(files.length, 3);
    assert.equal(complete, false, 'a capped walk cannot claim to have checked everything');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a path that is already gone is skipped rather than failing the check', async () => {
  const { files, complete } = await expandForRegistration([path.join(os.tmpdir(), 'tm-b2-not-here-at-all')]);
  assert.deepEqual(files, []);
  assert.equal(complete, true, 'nothing can hold a nonexistent file open — that is not an incomplete answer');
});

/* ══════════════════ Wording ══════════════════ */

test('the warning names the program in language a non-technical reader can act on', () => {
  const one = describeConflicts([{ path: '/a/f.txt', pid: 1, processName: 'Google Chrome' }]);
  assert.match(one, /Google Chrome has a file you’re deleting open/);
  assert.match(one, /may not free the space/, 'it says what the consequence actually is');
  assert.ok(!/pid|PID|\bhandle\b/.test(one), 'no jargon on the first line the user reads');

  const two = describeConflicts([
    { path: '/a/f.txt', pid: 1, processName: 'Chrome' },
    { path: '/a/g.txt', pid: 2, processName: 'Slack' },
  ]);
  assert.match(two, /Chrome and Slack have 2 of the files you’re deleting open/);

  const many = describeConflicts([
    { path: '/a/f', pid: 1, processName: 'A' },
    { path: '/a/g', pid: 2, processName: 'B' },
    { path: '/a/h', pid: 3, processName: 'C' },
    { path: '/a/i', pid: 4, processName: 'D' },
  ]);
  assert.match(many, /A, B and 2 other programs/, 'a long list is summarised, not dumped');
});

test('one folder holding several open files is counted by file, not by handle', () => {
  const msg = describeConflicts([
    { path: '/a/logs', pid: 1, processName: 'node', openPath: '/a/logs/x.log' },
    { path: '/a/logs', pid: 1, processName: 'node', openPath: '/a/logs/y.log' },
  ]);
  assert.match(msg, /2 of the files/);
});

/* ══════════════════ Against real open descriptors ══════════════════ */

test('a file held open by another process is found through the service', { skip: !IS_UNIX }, async () => {
  const dir = await mkTmp();
  try {
    const target = path.join(dir, 'held.bin');
    await fsp.writeFile(target, Buffer.alloc(2048, 1));
    const release = await holdOpenElsewhere(target);
    try {
      const report = await checkOpenHandles([target]);
      assert.equal(report.checked, true);
      assert.equal(report.conflicts.length, 1);
      assert.notEqual(report.conflicts[0].pid, process.pid, 'a genuinely foreign process');
      assert.ok(report.conflicts[0].processName.length > 0, 'the warning can name the program');
    } finally {
      release();
    }
    // The kill is asynchronous; give the kernel a moment to reap the fd rather
    // than asserting on a race.
    for (let i = 0; i < 20; i++) {
      if ((await checkOpenHandles([target])).conflicts.length === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual((await checkOpenHandles([target])).conflicts, [], 'closing the file clears the warning');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('deleting a FOLDER is blocked by a file open inside it', { skip: !IS_UNIX }, async () => {
  // End-to-end proof of the finding this feature turns on, against a real
  // descriptor in a real other process: the case a targeted `lsof <dir>`
  // silently passed.
  const dir = await mkTmp();
  try {
    const nested = path.join(dir, 'project', 'logs');
    await fsp.mkdir(nested, { recursive: true });
    const logFile = path.join(nested, 'server.log');
    await fsp.writeFile(logFile, 'running');
    const release = await holdOpenElsewhere(logFile);
    try {
      const report = await checkOpenHandles([path.join(dir, 'project')]);
      assert.equal(report.conflicts.length, 1, 'the folder delete is guarded by what is inside it');
      assert.equal(report.conflicts[0].path, path.join(dir, 'project'));
      assert.ok(
        report.conflicts[0].openPath?.endsWith('server.log'),
        'and the warning can name the file in use, not just the folder',
      );
    } finally {
      release();
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a 1,000-path batch costs one pass, and the real figure is recorded', { skip: !IS_UNIX }, async (t) => {
  // §B2: "A 1,000-file batch check adds under a second." Asserted loosely and
  // printed exactly — an absolute wall-clock assertion measures the CI runner,
  // which is the lesson A4's benchmark taught this suite the hard way.
  const dir = await mkTmp();
  try {
    const paths: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const p = path.join(dir, `f${String(i)}.bin`);
      await fsp.writeFile(p, 'x');
      paths.push(p);
    }

    const one = await checkOpenHandles([paths[0]]);
    const thousand = await checkOpenHandles(paths);
    t.diagnostic(`open-handle check: 1 path ${String(one.elapsedMs)}ms, 1,000 paths ${String(thousand.elapsedMs)}ms`);

    assert.equal(thousand.checked, true);
    assert.deepEqual(thousand.conflicts, []);
    // The machine-independent invariant: cost is flat in the size of the set,
    // because it is one enumeration either way. A per-path implementation would
    // be ~1000× the single-path figure, not ~1×.
    assert.ok(
      thousand.elapsedMs < Math.max(one.elapsedMs * 10 + 250, 3000),
      `a 1,000-path check must not scale with the batch (1: ${String(one.elapsedMs)}ms, 1000: ${String(thousand.elapsedMs)}ms)`,
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('an empty set is answered without touching the system', async () => {
  const report = await checkOpenHandles([]);
  assert.deepEqual(report.conflicts, []);
  assert.equal(report.checked, true);
  assert.equal(report.elapsedMs, 0, 'no subprocess is spawned to prove nothing is open');
});

/* ══════════════════ The guard inside the delete pathway ══════════════════ */

test('moveToTrash refuses the whole batch when something in it is open', { skip: !IS_UNIX }, async () => {
  const dir = await mkTmp();
  try {
    const held = path.join(dir, 'held.bin');
    const free = path.join(dir, 'free.bin');
    await fsp.writeFile(held, 'busy');
    await fsp.writeFile(free, 'idle');
    const release = await holdOpenElsewhere(held);
    try {
      await assert.rejects(
        () => moveToTrash([held, free]),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.status, 409);
          assert.equal(err.code, 'OPEN_HANDLE_CONFLICT');
          assert.match(err.message, /open right now/);
          const conflicts = err.details?.conflicts as { pid: number; processName: string }[] | undefined;
          assert.equal(conflicts?.length, 1, 'the offending process reaches the API body');
          assert.notEqual(conflicts?.[0].pid, process.pid);
          return true;
        },
      );
      // All-or-nothing: the un-held file must NOT have been trashed on the way
      // to discovering the held one. A half-applied delete is a delete the user
      // never agreed to.
      assert.ok(fs.existsSync(free), 'the free file is untouched');
      assert.ok(fs.existsSync(held), 'and so is the held one');
    } finally {
      release();
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a broken check never becomes a clean bill of health', async () => {
  // §6 failure isolation, §10 "never report what you cannot verify". If the
  // mechanism throws, the honest answer is "unknown" — which still lets the
  // delete proceed, because refusing everything when lsof is missing would be
  // worse than the risk being guarded against.
  const provider = platform() as unknown as { getOpenHandlesBatch: (p: string[]) => Promise<unknown> };
  const original = provider.getOpenHandlesBatch.bind(provider);
  provider.getOpenHandlesBatch = () => Promise.reject(new Error('probe exploded'));
  try {
    const report = await checkOpenHandles(['/tmp/whatever']);
    assert.equal(report.checked, false, 'an unknown answer is never reported as "nothing is open"');
    assert.deepEqual(report.conflicts, []);
    assert.match(report.reason ?? '', /couldn’t check/i);
  } finally {
    provider.getOpenHandlesBatch = original;
  }
});

test('an unknown answer does not block the delete', async () => {
  const provider = platform() as unknown as { getOpenHandlesBatch: (p: string[]) => Promise<unknown> };
  const original = provider.getOpenHandlesBatch.bind(provider);
  provider.getOpenHandlesBatch = () => Promise.reject(new Error('probe exploded'));
  const dir = await mkTmp();
  try {
    const target = path.join(dir, 'gone.bin');
    await fsp.writeFile(target, 'x');
    // Not trashed here — moveToTrash would really trash it. What matters is
    // that the guard raises nothing to refuse on, which is what the empty
    // conflicts list above proves. This asserts the decision the guard feeds.
    const report = await checkOpenHandles([target]);
    assert.equal(report.conflicts.length, 0, 'nothing to refuse on, so the delete proceeds');
  } finally {
    provider.getOpenHandlesBatch = original;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('"delete anyway" skips the check entirely', { skip: !IS_MAC }, async () => {
  // The bypass has to be real, or the warning becomes a wall. Proven without
  // trashing anything: the guard is stubbed to a conflict that would refuse,
  // and the call is made with the flag against a path that no longer exists —
  // so it reaches the trash step (past the guard) and fails there instead.
  const provider = platform() as unknown as { getOpenHandlesBatch: (p: string[]) => Promise<unknown> };
  const original = provider.getOpenHandlesBatch.bind(provider);
  provider.getOpenHandlesBatch = (paths: string[]) =>
    Promise.resolve({ handles: paths.map((p) => ({ path: p, pid: 999999, processName: 'Pretend' })), complete: true });
  const missing = path.join(os.tmpdir(), 'tm-b2-never-existed.bin');
  try {
    await assert.rejects(() => moveToTrash([missing]), /OPEN_HANDLE_CONFLICT|open right now/);

    const result = await moveToTrash([missing], { ignoreOpenHandles: true });
    assert.deepEqual(result.deleted, [], 'nothing was trashed — the path does not exist');
    assert.equal(result.failed.length, 1, 'it got past the guard and failed at the filesystem instead');
  } finally {
    provider.getOpenHandlesBatch = original;
  }
});

test('our own process reading a file is not reported as a conflict', async () => {
  const provider = platform() as unknown as { getOpenHandlesBatch: (p: string[]) => Promise<unknown> };
  const original = provider.getOpenHandlesBatch.bind(provider);
  provider.getOpenHandlesBatch = (paths: string[]) =>
    Promise.resolve({
      handles: [
        { path: paths[0], pid: process.pid, processName: 'TreeMap' },
        { path: paths[0], pid: process.pid + 1, processName: 'Someone Else' },
      ],
      complete: true,
    });
  try {
    const report = await checkOpenHandles(['/tmp/x']);
    assert.equal(report.conflicts.length, 1, 'TreeMap hashing a file for the duplicate finder is not a warning');
    assert.equal(report.conflicts[0].processName, 'Someone Else');
  } finally {
    provider.getOpenHandlesBatch = original;
  }
});

/* ══════════════════ No second delete pathway (§10) ══════════════════ */

test('nothing outside Cleaner removes a user file', async () => {
  // §9's destructive-path requirement, and the structural reason the guard can
  // be trusted: if a service could unlink directly, it would bypass both the
  // Trash guarantee and this check. Only the cleaner's own trash implementation
  // and offload's rollback of its OWN copies may remove anything.
  const servicesDir = path.join(__dirname, '..', 'src', 'services');
  /**
   * The complete list of files permitted to remove anything, each for a stated
   * reason. Adding to it should require the same argument these three make.
   *
   *  - `cleaner.ts` — the Trash pathway itself, and where this guard runs.
   *  - `offload.ts` — rolls back copies *it just wrote* to the destination;
   *    it never removes a user original except through cleaner's moveToTrash.
   *  - `trash.ts`   — Empty Trash. The one place a permanent delete is the
   *    entire point, it only ever touches the OS trash directory, and it
   *    refuses without an explicit `confirm: true`.
   *  - `compressionAdvisor.ts` — discards the ENCODE it just wrote when the
   *    verification fails. Exactly offload's argument: the only path it can
   *    remove is a temp file created moments earlier by the same function, and
   *    the user's original is only ever removed through cleaner's moveToTrash.
   */
  const allowed = new Set(['cleaner.ts', 'offload.ts', 'trash.ts', 'compressionAdvisor.ts']);
  const offenders: string[] = [];

  const scan = async (dir: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await scan(full); continue; }
      if (!entry.name.endsWith('.ts') || allowed.has(entry.name)) continue;
      const src = (await fsp.readFile(full, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, ' ');
      // App-data bookkeeping (indexes, manifests, caches) is TreeMap's own
      // storage, not the user's files — those live under the app-data dir and
      // are matched by name below rather than being blanket-allowed.
      for (const m of src.matchAll(/fsp?\.(?:promises\.)?(unlink|rm|rmdir)\s*\(([^)]*)/g)) {
        const arg = m[2];
        // TreeMap's own scratch and app-data files are not user data: gdu's
        // JSON output, the SQLite index, staging dirs for verified copies.
        // Time Capsule (B3) removes things in exactly two situations, both
        // named so they are visible here rather than argued about in review:
        //   - its own payloads under app-data (entryDir/payloadRoot/orphan…)
        //   - paths a restore wrote seconds earlier, when that restore failed
        //     (…ByThisRestore) — the same rollback-what-I-just-wrote licence
        //     offload.ts has. A restore never clears a pre-existing file: it
        //     refuses outright when the original path is occupied.
        // Deliberately NOT a blanket allow for timeCapsule.ts: a bare delete
        // of a user's file added there later must still fail this test.
        const ownStorage =
          /dbPath|indexPath|tmpPath|tmpDir|tempDir|outFile|staging|\.tmp|CAPSULE|appData|dataDir/i.test(arg) ||
          /entryDir\(|payloadRoot\(|orphanCapsuleDir|ByThisRestore/.test(arg);
        if (!ownStorage) offenders.push(`${entry.name}: ${m[1]}(${arg.slice(0, 60)}`);
      }
    }
  };
  await scan(servicesDir);
  assert.deepEqual(offenders, [], 'a bare delete outside Cleaner bypasses the Trash and this guard');
});

test('a probe that could not cover the whole set says so, and does not read as clear', () => {
  // The three-state contract at the top of `openHandleGuard.ts` promised
  // this and could not deliver it: `complete` was hardcoded `true`, while
  // Windows' Restart Manager computed the real value in four places and the
  // caller threw it away with `const { files } = …`. A `node_modules` delete
  // passes RM_MAX_RESOURCES routinely, so the common case reported a partial
  // probe as a whole one.
  return (async () => {
    const provider = platform() as unknown as { getOpenHandlesBatch: (p: string[]) => Promise<unknown> };
    const original = provider.getOpenHandlesBatch.bind(provider);
    provider.getOpenHandlesBatch = () => Promise.resolve({ handles: [], complete: false });
    try {
      const report = await checkOpenHandles(['/tmp/x']);
      assert.equal(report.checked, true, 'the probe did run');
      assert.equal(report.complete, false, 'but it could not see everything');
      assert.deepEqual(report.conflicts, [], 'and it found nothing in what it could see');
      assert.ok(report.reason && /could not check every file/i.test(report.reason),
        'the reason says so rather than leaving an empty conflict list to speak for itself');
    } finally {
      provider.getOpenHandlesBatch = original;
    }
  })();
});

test('a complete probe carries no partial-coverage caveat', () => {
  // The caveat has to mean something: attaching it to a complete sweep would
  // train people to ignore it.
  return (async () => {
    const provider = platform() as unknown as { getOpenHandlesBatch: (p: string[]) => Promise<unknown> };
    const original = provider.getOpenHandlesBatch.bind(provider);
    provider.getOpenHandlesBatch = () => Promise.resolve({ handles: [], complete: true });
    try {
      const report = await checkOpenHandles(['/tmp/x']);
      assert.equal(report.complete, true);
      assert.ok(!report.reason || !/could not check every file/i.test(report.reason));
    } finally {
      provider.getOpenHandlesBatch = original;
    }
  })();
});

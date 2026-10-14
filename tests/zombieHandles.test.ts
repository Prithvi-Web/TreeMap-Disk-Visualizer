import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { isolatedDataDir } from './fixtures/dataDir';
import { withinHangGuard } from './fixtures/waitFor';
isolatedDataDir('tm-b5-data-');
process.env.TREEMAP_NO_GDU = '1';

import {
  groupZombies, appBundleOf, zombieReport, restartProcess, executablePathsOf, PS_PIDS_PER_CALL, restartRefusal, RESTART_REFUSES,
} from '../src/services/zombieHandles';
import * as zombieHandles from '../src/services/zombieHandles';
import { AppError } from '../src/middleware/errorHandler';
import { runText, CommandFailedError } from '../src/platform/exec';
import { createApp } from '../src/server';
import { resetRateLimiter } from '../src/middleware/rateLimiter';

/**
 * B5 — the zombie-handle reclaim detector.
 *
 * The integration tests leak *real* descriptors from *real* separate
 * processes, per §9: the whole feature exists because an unlinked file's
 * blocks stay allocated while a descriptor lives, and only a live descriptor
 * from another process proves detection works. The pure tests cover the
 * arithmetic a wrong "X GB held" figure would come from.
 *
 * Nothing here touches the Trash, and the only process ever terminated is a
 * child this file spawned for the purpose.
 */

const IS_UNIX = process.platform !== 'win32';
const NODE_NAME = path.basename(process.execPath);

/* ══════════════════ Grouping arithmetic (pure, every OS) ══════════════════ */

test('handles group by process, biggest holder first, unknowns counted not guessed', () => {
  const grouped = groupZombies([
    { pid: 20, processName: 'small', path: '/x/a', bytes: 100 },
    { pid: 10, processName: 'big', path: '/x/b', bytes: 4000 },
    { pid: 10, processName: 'big', path: '/x/c', bytes: 1000 },
    { pid: 10, processName: 'big', path: '/x/d', bytes: null },
  ]);

  assert.deepEqual(grouped.processes.map((p) => p.pid), [10, 20], 'sorted by held bytes, descending');
  assert.equal(grouped.processes[0].bytes, 5000, 'a process sums its own handles');
  assert.equal(grouped.processes[0].unknownSizeCount, 1, 'an unknowable size is counted, never folded into the sum as zero');
  assert.equal(grouped.totalBytes, 5100, 'the headline total is the sum of known bytes only — a floor, not an estimate');
  assert.equal(grouped.unknownSizeCount, 1);
  assert.deepEqual(
    grouped.processes[0].handles.map((h) => h.bytes),
    [4000, 1000, null],
    'within a process, biggest handle first and unknowns last',
  );
});

test('an empty handle list groups to an empty report, not an error', () => {
  const grouped = groupZombies([]);
  assert.deepEqual(grouped.processes, []);
  assert.equal(grouped.totalBytes, 0);
});

test('one deleted file held by several programs is counted once, and says how many hold it (QA D17)', () => {
  // QA's Mac: one logd cache file held by hundreds of programs was counted once per
  // holder, so 687 MB of unique held files read as 2.37 GB.
  const shared = { path: '/private/var/db/cache.plist-cache', ino: 77, bytes: 100 };
  const grouped = groupZombies([
    { pid: 10, processName: 'logd', ...shared },
    { pid: 11, processName: 'Finder', ...shared },
    { pid: 12, processName: 'Dock', ...shared },
    { pid: 12, processName: 'Dock', path: '/tmp/own.log', ino: 5, bytes: 40 },
  ]);
  assert.equal(grouped.totalBytes, 140, 'the shared file once plus the other one, not 100 per holder');
  assert.equal(grouped.processes.length, 3, 'every holder is still listed');
  assert.equal(grouped.processes.find((p) => p.pid === 12)?.bytes, 140, 'a holder still shows everything it holds');
  assert.equal(grouped.fileCount, 2, 'two deleted files are held');
  assert.equal(grouped.sharedFileCount, 1, 'one of them by more than one program');
  const holdersOf = (pid: number, p: string) =>
    grouped.processes.find((x) => x.pid === pid)?.handles.find((h) => h.path === p)?.holders;
  assert.equal(holdersOf(10, shared.path), 3, 'each handle says how many programs hold that file');
  assert.equal(holdersOf(12, '/tmp/own.log'), 1, 'and a file one program holds says one');
});

test('the same path on a different inode is a different file, as a log rotated twice is (QA D17)', () => {
  const grouped = groupZombies([
    { pid: 10, processName: 'a', path: '/var/log/app.log', ino: 1, bytes: 100 },
    { pid: 11, processName: 'b', path: '/var/log/app.log', ino: 2, bytes: 100 },
  ]);
  assert.equal(grouped.totalBytes, 200, 'two inodes are two files, each holding its own space');
  assert.equal(grouped.fileCount, 2, 'and two files are counted');
});

test('without an inode, holders of the same path and size count once, so the total stays a floor (QA D17)', () => {
  const grouped = groupZombies([
    { pid: 10, processName: 'a', path: '/x/f', ino: null, bytes: 100 },
    { pid: 11, processName: 'b', path: '/x/f', ino: null, bytes: 100 },
    { pid: 10, processName: 'a', path: '/x/u', bytes: null },
    { pid: 11, processName: 'b', path: '/x/u', bytes: null },
  ]);
  assert.equal(grouped.totalBytes, 100, 'never more than is provably held');
  assert.equal(grouped.unknownSizeCount, 1, 'one unsized file, however many programs hold it');
  assert.equal(grouped.fileCount, 2, 'two files in all');
  const resized = groupZombies([
    { pid: 10, processName: 'a', path: '/x/f', ino: null, bytes: 100 },
    { pid: 11, processName: 'b', path: '/x/f', ino: null, bytes: 300 },
  ]);
  assert.equal(resized.totalBytes, 400, 'a different size at the same path is a different file');
});

test('the .app bundle test matches path segments, not substrings', () => {
  assert.equal(
    appBundleOf('/Applications/Safari.app/Contents/MacOS/Safari'),
    '/Applications/Safari.app',
    'a real bundle resolves to the bundle root',
  );
  assert.equal(
    appBundleOf('/Applications/Google Chrome.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper'),
    null,
    'a helper inside an app is not that app — `open` on the running app reopens nothing (fourth browser pass, E02)',
  );
  assert.equal(appBundleOf('/usr/local/bin/node'), null, 'a plain binary is not a bundle');
  assert.equal(appBundleOf('/opt/my.apple/bin/tool'), null, 'nor is a folder whose name merely contains ".app"');
  assert.equal(appBundleOf(null), null);
  assert.equal(appBundleOf('.app/x'), null, 'a path that starts at the marker has no bundle name');
});

/** The fourth browser pass's own processes (E02), as macOS's ps names them. */
const CHROME = '/Applications/Google Chrome.app';
const RENDERER = `${CHROME}/Contents/Frameworks/Google Chrome Framework.framework/Versions/141.0.7390.55/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)`;
const INSIDE_AN_APP: Array<[string, string, string]> = [
  [RENDERER, CHROME, 'a helper app inside a framework inside the app'],
  ['/Applications/Google Drive.app/Contents/PlugIns/DFSFileProviderExtension.appex/Contents/MacOS/DFSFileProviderExtension', '/Applications/Google Drive.app', 'an app extension'],
  ['/Applications/WhatsApp.app/Contents/PlugIns/ServiceExtension.appex/Contents/MacOS/ServiceExtension', '/Applications/WhatsApp.app', 'another extension'],
  ['/Applications/Slack.app/Contents/XPCServices/SlackXPC.xpc/Contents/MacOS/SlackXPC', '/Applications/Slack.app', 'an XPC service'],
  ['/Applications/Dropbox.app/Contents/Library/LoginItems/DropboxHelper.app/Contents/MacOS/DropboxHelper', '/Applications/Dropbox.app', 'a login item'],
  [`${CHROME}/Contents/Frameworks/Google Chrome Framework.framework/Versions/141.0.7390.55/Helpers/chrome_crashpad_handler`, CHROME, 'a bare tool kept in the app\'s bundle'],
  ['/Users/me/Applications/Tool.app/Contents/Resources/bin/tool', '/Users/me/Applications/Tool.app', 'a tool in the app\'s resources'],
];

test('a process inside an app — a helper, an extension, an XPC service, a login item, a tool in its bundle — is part of that app, never the app it would reopen (E02)', () => {
  const roleOf = (zombieHandles as unknown as { bundleRoleOf?: (e: string | null) => { appBundle: string | null; partOf: string | null } }).bundleRoleOf;
  assert.equal(typeof roleOf, 'function', 'zombieHandles exposes bundleRoleOf');
  for (const [exe, host, what] of INSIDE_AN_APP) {
    assert.deepEqual(roleOf!(exe), { appBundle: null, partOf: host }, `${what} runs inside ${host}`);
  }
  assert.deepEqual(roleOf!(`${CHROME}/Contents/MacOS/Google Chrome`), { appBundle: CHROME, partOf: null }, 'the app\'s own executable is the app');
  assert.deepEqual(roleOf!('/usr/local/bin/node'), { appBundle: null, partOf: null }, 'a plain binary is neither');
  assert.deepEqual(roleOf!('/opt/my.apple/bin/tool'), { appBundle: null, partOf: null }, 'nor is a program in a folder whose name merely contains ".app"');
  assert.deepEqual(roleOf!(null), { appBundle: null, partOf: null });
});

/* ══════════════════ Track U U-5 — one `ps` for every held-space process ══════════════════ */

type Call = { cmd: string; args: string[] };

/** The pids one recorded `ps` call asked about. */
const pidsAskedIn = (call: Call): number[] => call.args[call.args.indexOf('-p') + 1].split(',').map(Number);

/** The uid the fake `ps` reports unless told otherwise, and the one the report is told is TreeMap's. */
const OUR_UID = 501;

/**
 * A stand-in for `ps -ww -o pid=,uid=,comm= -p <pids>`: answers the way macOS's
 * does (pid and uid right-aligned, one space, then the whole path), for the
 * pids it knows, and records every call. `uids` overrides the owner per pid.
 */
function fakePs(paths: ReadonlyMap<number, string>, uids: ReadonlyMap<number, number> = new Map()) {
  const calls: Call[] = [];
  const run = async (cmd: string, args: string[]): Promise<string> => {
    const call = { cmd, args };
    // An app's Info.plist, as plutil reads it: here every app's own executable is named after the app.
    if (cmd === 'plutil') return `${path.basename(path.dirname(path.dirname(args[args.length - 1])), '.app')}\n`;
    calls.push(call);
    return pidsAskedIn(call)
      .filter((pid) => paths.has(pid))
      .map((pid) => `${String(pid).padStart(5)} ${String(uids.get(pid) ?? OUR_UID).padStart(5)} ${paths.get(pid)}\n`)
      .join('');
  };
  return { run, calls };
}

/** One held handle for each pid: what the platform's lsof pass hands groupZombies. */
const heldBy = (pids: number[]) => async () => pids.map((pid) => ({ pid, processName: `proc${pid}`, path: `/tmp/held-${pid}`, bytes: 1000 }));
const range = (from: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + i);

test('fifty processes holding space cost exactly one ps, and each gets its own answer', async () => {
  const pids = range(1000, 50);
  const ps = fakePs(new Map([[1003, '/Applications/My App.app/Contents/MacOS/My App'], [1007, '/usr/local/bin/node']]));
  const report = await zombieReport({ handles: heldBy(pids), run: ps.run, os: 'darwin' });
  assert.equal(ps.calls.length, 1, 'one ps for the whole report, not one per process');
  assert.equal(ps.calls[0].cmd, 'ps');
  assert.deepEqual(ps.calls[0].args, ['-ww', '-o', 'pid=,uid=,comm=', '-p', pids.join(',')], 'every pid asked about in that one call, at full width');
  assert.equal(report.processes.length, 50, 'every holder is still listed');
  const bundle = (pid: number) => report.processes.find((p) => p.pid === pid)?.appBundle;
  assert.equal(bundle(1003), '/Applications/My App.app', 'a path with spaces is read whole, not cut at its first space');
  assert.equal(bundle(1007), null, 'a plain binary is not a bundle');
  assert.equal(bundle(1004), null, 'a pid ps did not answer for is null, never a neighbour\'s answer');
});

test('executablePathsOf: a pid missing from the output is null, and 1,200 pids are asked in three calls of at most 500', async () => {
  assert.equal(PS_PIDS_PER_CALL, 500);
  const ps = fakePs(new Map([[7, '/bin/zsh']]));
  const one = await executablePathsOf([7, 8], ps.run);
  assert.equal(one.get(7), '/bin/zsh');
  assert.equal(one.get(8), null, 'absent from the output: unknown, not an empty path');

  const many = range(10_000, 1200);
  const big = fakePs(new Map(many.map((pid) => [pid, `/opt/p${pid}/bin/p${pid}`])));
  const paths = await executablePathsOf(many, big.run);
  assert.equal(big.calls.length, 3, '1,200 pids: three calls');
  assert.deepEqual(big.calls.map((c) => pidsAskedIn(c).length), [500, 500, 200], 'never more than 500 pids in one call');
  assert.deepEqual(big.calls.flatMap(pidsAskedIn), many, 'each pid asked about once, in order');
  assert.equal(paths.size, 1200, 'one entry per pid asked');
  // The map is seeded with null for every pid, so its size proves nothing about
  // the answers: every pid of every chunk must carry the path ps printed for it.
  const unread = many.filter((pid) => paths.get(pid) !== `/opt/p${pid}/bin/p${pid}`);
  assert.deepEqual(unread, [], 'every chunk\'s answers are read, not only the last one\'s');
});

test('executablePathsOf: a ps call that fails leaves only its own 500 pids unknown, and the chunk after it is still asked', async () => {
  const many = range(20_000, 1200);
  const ps = fakePs(new Map(many.map((pid) => [pid, `/opt/p${pid}/bin/p${pid}`])));
  let calls = 0;
  const run = async (cmd: string, args: string[]): Promise<string> => {
    calls++;
    if (calls === 2) throw new CommandFailedError('ps', 'ps exited with code 1', '', '', 1);
    return ps.run(cmd, args);
  };
  const paths = await executablePathsOf(many, run);
  assert.equal(calls, 3, 'the third chunk is asked after the second one\'s ps failed');
  const answered = (pids: number[]): number => pids.filter((pid) => paths.get(pid) === `/opt/p${pid}/bin/p${pid}`).length;
  const unknown = (pids: number[]): number => pids.filter((pid) => paths.get(pid) === null).length;
  assert.deepEqual(
    [answered(many.slice(0, 500)), unknown(many.slice(500, 1000)), answered(many.slice(1000))],
    [500, 500, 200],
    'the first chunk answered, the failed chunk unknown (nothing guessed), the last chunk answered',
  );
});

test('a ps that fails leaves every bundle unknown and the report still answers', async () => {
  const pids = range(2000, 5);
  const failures: Array<[string, () => Promise<string>]> = [
    ['ps exits 1 when no pid matches (macOS)', async () => { throw new CommandFailedError('ps', 'ps exited with code 1', '', '', 1); }],
    ['ps cannot be started at all', async () => { throw new Error('spawn ps ENOENT'); }],
  ];
  for (const [what, fail] of failures) {
    let calls = 0;
    const report = await zombieReport({ handles: heldBy(pids), run: async () => { calls++; return fail(); }, os: 'darwin' });
    assert.equal(calls, 1, `${what}: asked once`);
    assert.equal(report.processes.length, 5, `${what}: every holder is still reported`);
    assert.ok(report.processes.every((p) => p.appBundle === null), `${what}: no bundle is guessed`);
    assert.equal(report.totalBytes, 5000, `${what}: the held bytes are unaffected`);
  }
  // Only macOS has .app bundles: elsewhere nothing is asked at all.
  let asked = 0;
  await zombieReport({ handles: heldBy(pids), run: async () => { asked++; return ''; }, os: 'linux' });
  assert.equal(asked, 0, 'no ps where the answer cannot be yes');
});

test('the real ps answers the batched form: this process by its executable, an exited one as unknown', { skip: !IS_UNIX }, async () => {
  const gone = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await exited(gone);
  const calls: string[][] = [];
  const paths = await executablePathsOf([process.pid, gone.pid!], (cmd, args, opts) => { calls.push(args); return runText(cmd, args, opts); });
  assert.equal(calls.length, 1, 'both pids in one real ps');
  const mine = paths.get(process.pid);
  assert.ok(typeof mine === 'string' && mine.length > 0, `ps named this process (got ${String(mine)})`);
  assert.equal(path.basename(mine), NODE_NAME, 'by its executable');
  assert.equal(paths.get(gone.pid!), null, 'an exited process is unknown');
});

/* ══════════════════ QA D40 — never a program that is part of the system ══════════════════ */

test('restartRefusal: the operating system\u2019s own programs, root and other users are refused (QA D40)', () => {
  const refuse = (executable: string | null, os: NodeJS.Platform, uid: number | null = OUR_UID) =>
    restartRefusal({ executable, uid }, os, OUR_UID);
  // QA's list, at the paths macOS runs them from: each was offered Restart (SIGTERM).
  for (const exe of [
    '/System/Library/PrivateFrameworks/Chrono.framework/Support/chronod',
    '/System/Library/Frameworks/FileProvider.framework/Support/fileproviderd',
    '/System/Library/CoreServices/WallpaperAgent.app/Contents/MacOS/WallpaperAgent',
    '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder',
    '/usr/libexec/linkd', '/usr/sbin/cfprefsd', '/sbin/launchd', '/usr/bin/vim', '/bin/zsh', '/Library/Apple/usr/libexec/x',
  ]) {
    const r = refuse(exe, 'darwin');
    assert.equal(r?.code, 'PID_SYSTEM', `${exe} is part of macOS`);
    assert.match(r?.reason ?? '', /part of macOS/i, `${exe}: and the reason says so`);
  }
  // A person's own programs, Apple's apps included, stay restartable.
  for (const exe of [
    '/Applications/Docker.app/Contents/MacOS/Docker',
    '/System/Applications/Mail.app/Contents/MacOS/Mail',
    '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
    '/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari',
    '/usr/local/bin/node',
    '/Users/me/bin/tool',
  ]) {
    assert.equal(refuse(exe, 'darwin'), null, `${exe} is a program a person runs`);
  }
  const app = '/Applications/Docker.app/Contents/MacOS/Docker';
  assert.equal(refuse(app, 'darwin', 0)?.code, 'PID_SYSTEM', 'a program run as root is refused wherever it lives');
  assert.match(refuse(app, 'darwin', 0)?.reason ?? '', /administrator/i, 'and says who runs it');
  assert.equal(refuse(app, 'darwin', OUR_UID + 1)?.code, 'PID_OTHER_USER', 'another user\u2019s program is refused');
  assert.equal(refuse(app, 'darwin', null)?.code, 'PID_UNVERIFIED', 'an owner TreeMap could not read is refused, not assumed');
  assert.equal(refuse(null, 'darwin')?.code, 'PID_UNVERIFIED', 'and so is a program TreeMap could not locate');
  // Linux: the same rule over the executable /proc names.
  for (const exe of ['/usr/lib/systemd/systemd', '/usr/libexec/gvfsd', '/usr/bin/pipewire', '/sbin/init', '/lib/systemd/systemd-logind']) {
    assert.equal(refuse(exe, 'linux')?.code, 'PID_SYSTEM', `${exe} is part of the operating system`);
  }
  for (const exe of ['/opt/google/chrome/chrome', '/home/me/.local/bin/tool', '/usr/local/bin/node', '/snap/firefox/123/usr/lib/firefox/firefox']) {
    assert.equal(refuse(exe, 'linux'), null, `${exe} is a program a person runs`);
  }
  assert.ok(refuse('C:\\Program Files\\App\\app.exe', 'win32'), 'and nowhere else is a restart carried out');
});

/**
 * A pid no process can ever have: macOS caps pids below 100,000 and Linux at
 * 4,194,304. The refusal tests name it so that no signal can reach any process,
 * even if a refusal were broken (a mutant), since nothing can be alive there.
 */
const IMPOSSIBLE_PID = 2 ** 30;

test('restart refuses a system program, root\u2019s or another user\u2019s, before any signal (QA D40)', async () => {
  const cases: Array<[string, number, string]> = [
    ['/usr/libexec/chronod', OUR_UID, 'PID_SYSTEM'],
    ['/System/Library/PrivateFrameworks/Chrono.framework/Support/chronod', OUR_UID, 'PID_SYSTEM'],
    ['/Applications/Thing.app/Contents/MacOS/chronod', 0, 'PID_SYSTEM'],
    ['/Applications/Thing.app/Contents/MacOS/chronod', OUR_UID + 1, 'PID_OTHER_USER'],
  ];
  for (const [exe, uid, code] of cases) {
    const ps = fakePs(new Map([[IMPOSSIBLE_PID, exe]]), new Map([[IMPOSSIBLE_PID, uid]]));
    assert.equal(
      await appErrorCode(() => restartProcess(IMPOSSIBLE_PID, 'chronod', 800, ps.run, { os: 'darwin', uid: OUR_UID })),
      code,
      `${exe} run by uid ${String(uid)} is refused`,
    );
  }
  // Linux's ps names a process by its 15-character comm, so the system check reads
  // the executable from /proc instead.
  const linuxPs = fakePs(new Map([[IMPOSSIBLE_PID, 'systemd']]));
  assert.equal(
    await appErrorCode(() => restartProcess(IMPOSSIBLE_PID, 'systemd', 800, linuxPs.run, {
      os: 'linux', uid: OUR_UID, procFacts: async () => ({ executable: '/usr/lib/systemd/systemd', uid: OUR_UID }),
    })),
    'PID_SYSTEM',
    'on Linux the executable /proc names decides',
  );
  // The control: a person's own program passes every check and only then finds the
  // process gone — the refusals are not a blanket "no".
  const own = fakePs(new Map([[IMPOSSIBLE_PID, '/Applications/Thing.app/Contents/MacOS/Thing']]));
  const result = await restartProcess(IMPOSSIBLE_PID, 'Thing', 800, own.run, { os: 'darwin', uid: OUR_UID });
  assert.match(result.message, /already quit/, 'a program of the person\u2019s own is not refused');
});

test('the report marks programs that cannot be restarted, and says why (QA D40)', async () => {
  const ps = fakePs(new Map([[1001, '/usr/libexec/chronod'], [1002, '/Applications/My App.app/Contents/MacOS/My App']]));
  const report = await zombieReport({ handles: heldBy([1001, 1002, 1003]), run: ps.run, os: 'darwin', uid: OUR_UID });
  const proc = (pid: number) => report.processes.find((p) => p.pid === pid);
  assert.equal(proc(1001)?.restartable, false, 'chronod is part of macOS');
  assert.match(proc(1001)?.restartRefusal ?? '', /part of macOS/i, 'and the report says so');
  assert.equal(proc(1002)?.restartable, true, 'a person\u2019s own app can be restarted');
  assert.equal(proc(1002)?.restartRefusal, null, 'with nothing to explain');
  assert.equal(proc(1003)?.restartable, false, 'a program ps could not name is not offered a restart');
  assert.match(proc(1003)?.restartRefusal ?? '', /could not confirm/i);
  assert.equal(ps.calls.length, 1, 'still one ps for the whole report');

  // Linux reads the executable and owner from /proc, with no ps at all.
  let asked = 0;
  const onLinux = await zombieReport({
    handles: heldBy([2001, 2002]),
    run: async () => { asked++; return ''; },
    os: 'linux',
    uid: OUR_UID,
    procFacts: async (pid) => ({ executable: pid === 2001 ? '/usr/lib/systemd/systemd' : '/opt/app/bin/app', uid: OUR_UID }),
  });
  assert.equal(onLinux.processes.find((p) => p.pid === 2001)?.restartable, false, 'systemd is part of the operating system');
  assert.equal(onLinux.processes.find((p) => p.pid === 2002)?.restartable, true, 'an app under /opt is not');
  assert.equal(asked, 0, 'and no ps was run on Linux');
});

/* ══════════════════ The acceptance criterion (unix) ══════════════════ */

/**
 * Hold `target` open from a separate process, resolving once the descriptor
 * is really open — the same no-sleep handshake the B2 suite uses. Returns the
 * child so tests can terminate it and observe the space actually free.
 */
async function holdOpenElsewhere(target: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['-e', 'const fs=require("fs");fs.openSync(process.argv[1],"r");console.log("open");setInterval(()=>{},1000);', target],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  await withinHangGuard(new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('error', (err) => reject(err));
    child.once('exit', () => reject(new Error('the holder process exited early')));
  }), 'the holder process signalling that it opened the file');
  return child;
}

/** Wait for a spawned child to fully exit. */
function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

test('a file deleted while held open is detected with its real size, and clears when the holder exits', { skip: !IS_UNIX }, async () => {
  // §B5 acceptance: "A file deleted while held open by a controlled test
  // process is detected, and the reclaimable byte count matches reality after
  // that process exits."
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-b5-'));
  const target = path.join(dir, 'doomed.bin');
  const SIZE = 1_048_576;
  await fsp.writeFile(target, Buffer.alloc(SIZE));

  const holder = await holdOpenElsewhere(target);
  try {
    await fsp.unlink(target);

    const report = await zombieReport();
    const mine = report.processes.find((p) => p.pid === holder.pid);
    assert.ok(mine, 'the holder process is listed among the zombie holders');
    assert.equal(mine!.bytes, SIZE, 'the held bytes are the file’s real size — not a guess, not zero');
    assert.ok(report.totalBytes >= SIZE, 'the headline total includes it');

    // The reclaim itself: once the holder exits, the space is genuinely free
    // and the report must stop claiming it.
    holder.kill('SIGKILL');
    await exited(holder);
    const after = await zombieReport();
    assert.equal(
      after.processes.find((p) => p.pid === holder.pid),
      undefined,
      'an exited holder no longer appears — the bytes it held are reclaimed',
    );
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/* ══════════════════ restartProcess safety rails (unix) ══════════════════ */

const appErrorCode = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return 'no-error';
  } catch (err) {
    return err instanceof AppError ? err.code : `unexpected: ${String(err)}`;
  }
};

test('restart refuses system pids, TreeMap itself, and its parent', async () => {
  assert.equal(await appErrorCode(() => restartProcess(0, 'x')), 'PID_INVALID');
  assert.equal(await appErrorCode(() => restartProcess(1, 'launchd')), 'PID_INVALID');
  assert.equal(await appErrorCode(() => restartProcess(-5, 'x')), 'PID_INVALID');
  assert.equal(await appErrorCode(() => restartProcess(2.5, 'x')), 'PID_INVALID');
  assert.equal(await appErrorCode(() => restartProcess(process.pid, 'anything')), 'PID_IS_TREEMAP');
  if (process.ppid > 1) {
    assert.equal(await appErrorCode(() => restartProcess(process.ppid, 'anything')), 'PID_IS_TREEMAP');
  }
});

test('restart refuses a pid whose process is not what the caller named', { skip: !IS_UNIX }, async () => {
  // Pids are recycled; acting on a stale panel must never quit whatever
  // program inherited the number.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-b5-'));
  const target = path.join(dir, 'held.bin');
  await fsp.writeFile(target, 'x');
  const child = await holdOpenElsewhere(target);
  try {
    assert.equal(await appErrorCode(() => restartProcess(child.pid!, 'DefinitelyNotThisProcess')), 'PID_REUSED');
    assert.equal(child.exitCode, null, 'the mismatched process was left completely alone');
  } finally {
    child.kill('SIGKILL');
    await exited(child);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('restart still asks ps about its one pid, right before it acts (U-5 batches only the report)', { skip: !IS_UNIX }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-b5-'));
  const target = path.join(dir, 'held.bin');
  await fsp.writeFile(target, 'x');
  const child = await holdOpenElsewhere(target);
  const calls: Call[] = [];
  const counted = (cmd: string, args: string[], opts?: Parameters<typeof runText>[2]) => { calls.push({ cmd, args }); return runText(cmd, args, opts); };
  try {
    assert.equal(await appErrorCode(() => restartProcess(child.pid!, 'DefinitelyNotThisProcess', undefined, counted)), 'PID_REUSED');
    assert.equal(calls.length, 1, 'one identity check');
    assert.equal(calls[0].cmd, 'ps');
    assert.deepEqual(pidsAskedIn(calls[0]), [child.pid], 'about that pid alone');
    assert.equal(child.exitCode, null, 'the mismatched process was left alone');
  } finally {
    child.kill('SIGKILL');
    await exited(child);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('restart terminates a willing process gracefully and reports it plainly', { skip: !IS_UNIX }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-b5-'));
  const target = path.join(dir, 'held.bin');
  await fsp.writeFile(target, 'x');
  const child = await holdOpenElsewhere(target);
  try {
    const result = await restartProcess(child.pid!, NODE_NAME);
    await exited(child);
    assert.equal(result.terminated, true, 'a default SIGTERM handler exits, and that is reported');
    assert.equal(result.relaunched, false, 'a bare binary is never "reopened" — there is nothing supportable to reopen');
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'the child really is gone');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a process that declines to quit is reported still running — never force-killed', { skip: !IS_UNIX }, async () => {
  const child = spawn(
    process.execPath,
    ['-e', 'process.on("SIGTERM",()=>{});console.log("up");setInterval(()=>{},1000);'],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
  try {
    const result = await restartProcess(child.pid!, NODE_NAME, 800);
    assert.equal(result.terminated, false, 'the refusal is reported, not escalated');
    assert.equal(child.exitCode, null, 'the process was asked, not forced — it is still alive');
    assert.match(result.message, /still running/, 'and the message says exactly that');
  } finally {
    child.kill('SIGKILL');
    await exited(child);
  }
});

test('restarting a process that already quit reports the space as already free', { skip: !IS_UNIX }, async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await exited(child);
  const result = await restartProcess(child.pid!, NODE_NAME);
  assert.equal(result.terminated, true);
  assert.match(result.message, /already quit/);
});

/* ══════════════════ A helper is not its app (fourth browser pass, E02) ══════════════════ */

type Role = { appBundle: string | null; partOf: string | null };
type ReportDeps = Parameters<typeof zombieReport>[0] & { bundleExecutable?: (bundle: string) => Promise<string | null> };
type Env = NonNullable<Parameters<typeof restartProcess>[4]> & { bundleExecutable?: (bundle: string) => Promise<string | null> };

test('the report says which app a helper runs inside, and calls a process the app only when the app\'s Info.plist names its executable (E02)', async () => {
  const exes = new Map<number, string>([
    [3001, RENDERER],
    [3002, `${CHROME}/Contents/MacOS/Google Chrome`],
    [3003, '/Applications/Fake.app/Contents/MacOS/crash_reporter'],
    [3004, '/Applications/Odd.app/Contents/MacOS/Odd'],
    [3005, '/usr/local/bin/node'],
  ]);
  const mains: Record<string, string | null> = { [CHROME]: 'Google Chrome', '/Applications/Fake.app': 'Fake', '/Applications/Odd.app': null };
  const asked: string[] = [];
  const deps: ReportDeps = {
    handles: heldBy([...exes.keys()]), run: fakePs(exes).run, os: 'darwin', uid: OUR_UID,
    bundleExecutable: async (bundle) => { asked.push(bundle); return mains[bundle] ?? null; },
  };
  const report = await zombieReport(deps);
  const role = (pid: number): Role => {
    const p = report.processes.find((x) => x.pid === pid) as unknown as Role;
    return { appBundle: p.appBundle, partOf: p.partOf };
  };
  assert.deepEqual(role(3001), { appBundle: null, partOf: CHROME }, 'the renderer runs inside Google Chrome — it is not Google Chrome');
  assert.deepEqual(role(3002), { appBundle: CHROME, partOf: null }, 'Google Chrome\'s own executable is the app');
  assert.deepEqual(role(3003), { appBundle: null, partOf: '/Applications/Fake.app' }, 'a second program in Contents/MacOS is part of the app, not the app');
  assert.deepEqual(role(3004), { appBundle: null, partOf: null }, 'an app whose Info.plist cannot be read is promised nothing');
  assert.deepEqual(role(3005), { appBundle: null, partOf: null }, 'a plain binary is neither');
  assert.deepEqual(asked.sort(), ['/Applications/Fake.app', CHROME, '/Applications/Odd.app'], 'the Info.plist is read only for a program in an app\'s Contents/MacOS');
});

test('an app\'s Info.plist is read for the executable it names, XML or binary, and one that cannot be read names none (E02)', { skip: process.platform !== 'darwin' && 'plutil is macOS\'s' }, async () => {
  const read = (zombieHandles as unknown as { readBundleExecutable?: (bundle: string) => Promise<string | null> }).readBundleExecutable;
  assert.equal(typeof read, 'function', 'zombieHandles exposes readBundleExecutable');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tm-e02-'));
  try {
    const bundle = path.join(dir, 'My Tool.app');
    await fsp.mkdir(path.join(bundle, 'Contents'), { recursive: true });
    const plist = path.join(bundle, 'Contents', 'Info.plist');
    await fsp.writeFile(plist, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0"><dict><key>CFBundleName</key><string>My Tool</string><key>CFBundleExecutable</key><string>My Tool Main</string></dict></plist>\n');
    assert.equal(await read!(bundle), 'My Tool Main', 'an XML Info.plist, a name with spaces read whole');
    await runText('plutil', ['-convert', 'binary1', plist]);
    assert.equal(await read!(bundle), 'My Tool Main', 'a binary one too');
    assert.equal(await read!(path.join(dir, 'Missing.app')), null, 'no Info.plist, no name');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/** A child that quits on SIGTERM, standing for the program ps is told it is. */
async function willingChild(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'console.log("up");setInterval(()=>{},1000);'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await withinHangGuard(new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('exit', () => reject(new Error('the child exited early')));
  }), 'the child starting');
  return child;
}

/**
 * Restarts a real child that ps is told runs `exe`. Every command goes through the stand-in, so an
 * `open` is recorded, never run: nothing on this Mac is launched.
 */
async function restartAs(exe: string, mains: Record<string, string | null>): Promise<{ result: Awaited<ReturnType<typeof restartProcess>>; opened: string[][] }> {
  assert.equal(fs.existsSync(exe.slice(0, exe.indexOf('.app/') + 4)), false, `the app ${exe} stands for exists nowhere on this disk`);
  const child = await willingChild();
  const opened: string[][] = [];
  const ps = fakePs(new Map([[child.pid!, exe]]));
  const run = async (cmd: string, args: string[]): Promise<string> => {
    if (cmd === 'open') { opened.push(args); return ''; }
    return ps.run(cmd, args);
  };
  const env: Env = { os: 'darwin', uid: OUR_UID, bundleExecutable: async (bundle) => mains[bundle] ?? null };
  try {
    const result = await restartProcess(child.pid!, path.basename(exe), undefined, run, env);
    await exited(child);
    return { result, opened };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

/**
 * The restart tests' apps are made up and exist nowhere on disk: should a change ever reach the real
 * `open` again, it fails on a missing app instead of bringing one of this Mac's to the front.
 */
const TEST_BROWSER = '/Applications/TreeMap Test Browser (no such app).app';
const TEST_RENDERER = `${TEST_BROWSER}/Contents/Frameworks/Test Browser Framework.framework/Versions/1/Helpers/Test Browser Helper (Renderer).app/Contents/MacOS/Test Browser Helper (Renderer)`;

test('restarting a helper never says it was reopened: it is asked to quit, nothing is opened, and the result names the app it runs inside (E02)', { skip: !IS_UNIX }, async () => {
  assert.equal(fs.existsSync(TEST_BROWSER), false, 'control: the made-up app is nowhere on this disk');
  const { result, opened } = await restartAs(TEST_RENDERER, { [TEST_BROWSER]: 'TreeMap Test Browser (no such app)' });
  assert.equal(result.terminated, true, 'control: the helper quit');
  assert.deepEqual(opened, [], 'the browser is not "opened" — it is running, and opening it reopens nothing');
  assert.equal(result.relaunched, false);
  assert.doesNotMatch(result.message, /reopened\./, 'never "quit and was reopened"');
  assert.match(result.message, /runs inside TreeMap Test Browser \(no such app\)/, 'it names the app it belongs to');
  assert.match(result.message, /did not reopen it/, 'and says plainly that TreeMap did not reopen it');

  const second = await restartAs('/Applications/TreeMap Fake (no such app).app/Contents/MacOS/crash_reporter', { '/Applications/TreeMap Fake (no such app).app': 'TreeMap Fake (no such app)' });
  assert.deepEqual(second.opened, [], 'a second program in Contents/MacOS is not reopened by opening its app');
  assert.match(second.result.message, /runs inside TreeMap Fake \(no such app\)/);
});

test('restarting an app\'s own executable opens that app again through the same runner, and says so (E02)', { skip: !IS_UNIX }, async () => {
  const app = '/Applications/TreeMap Fake App (no such app).app';
  assert.equal(fs.existsSync(app), false, 'control: the made-up app is nowhere on this disk');
  const { result, opened } = await restartAs(`${app}/Contents/MacOS/TreeMap Fake App (no such app)`, { [app]: 'TreeMap Fake App (no such app)' });
  assert.deepEqual(opened, [[app]], 'the app is opened again — through the runner, so a test launches nothing');
  assert.equal(result.relaunched, true);
  assert.match(result.message, /quit and was reopened/);
});

/* ══════════════════ The endpoints ══════════════════ */

async function listen() {
  resetRateLimiter();
  const app = createApp(path.join(__dirname, '..', 'public'));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function req(port: number, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port, path: url, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { buf += c; });
        res.on('end', () => {
          let parsed: unknown = buf;
          try { parsed = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

test('GET /api/zombie-handles answers the report, or the honest capability reason', async () => {
  const { port, close } = await listen();
  try {
    const r = await req(port, 'GET', '/api/zombie-handles');
    if (r.status === 200) {
      assert.ok(Array.isArray(r.body.processes), 'processes is a list');
      assert.equal(typeof r.body.totalBytes, 'number');
      assert.equal(typeof r.body.unknownSizeCount, 'number');
      assert.equal(r.body.capability.available, true);
    } else {
      // Windows, or a unix box with lsof genuinely missing: the flat error
      // envelope with the probe's human-readable reason (§2.2), never a blank.
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'CAPABILITY_UNAVAILABLE');
      assert.ok(String(r.body.error).length > 10, 'the reason is a sentence a person can act on');
    }
  } finally {
    await close();
  }
});

test('POST /api/zombie-handles/restart validates before it acts', async () => {
  const { port, close } = await listen();
  try {
    const probe = await req(port, 'GET', '/api/zombie-handles');
    if (probe.status !== 200) {
      // Capability-gated out: the restart gate must answer identically.
      const r = await req(port, 'POST', '/api/zombie-handles/restart', { pid: 12345, processName: 'x' });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'CAPABILITY_UNAVAILABLE');
      return;
    }

    const missing = await req(port, 'POST', '/api/zombie-handles/restart', {});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'PID_INVALID');

    const noName = await req(port, 'POST', '/api/zombie-handles/restart', { pid: 12345 });
    assert.equal(noName.status, 400);
    assert.equal(noName.body.code, 'PROCESS_NAME_REQUIRED');

    const self = await req(port, 'POST', '/api/zombie-handles/restart', { pid: process.pid, processName: 'TreeMap' });
    assert.equal(self.status, 400);
    assert.equal(self.body.code, 'PID_IS_TREEMAP');

    const system = await req(port, 'POST', '/api/zombie-handles/restart', { pid: 1, processName: 'launchd' });
    assert.equal(system.status, 400);
    assert.equal(system.body.code, 'PID_INVALID');
  } finally {
    await close();
  }
});

/* ══════════════════ The held-up space card (built page) ══════════════════ */

/**
 * Runs the built page's renderZombies with every global it touches stubbed, and
 * returns the HTML it paints. Sizes print as "<n> B" so the arithmetic is visible.
 */
function paintZombies(report: Record<string, unknown>): string {
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const start = index.indexOf('function renderZombies(');
  const end = index.indexOf('function wireZombieActions(', start);
  assert.ok(start > 0 && end > start, 'renderZombies is in the built page');
  let html = '';
  const body = { classList: { remove() {} }, innerHTML: '' };
  const stubs: Record<string, unknown> = {
    $: () => body,
    formatBytes: (n: number) => `${String(n)} B`,
    escapeHtml: (s: unknown) => String(s),
    baseName: (p: string) => p.split('/').pop(),
    fxBarStyle: () => '',
    fxBarsIn: () => undefined,
    wireZombieActions: () => undefined,
    icon: () => '',
    ZH_VISIBLE_ROWS: 1,
    FxNum: { rollHtml: (_el: unknown, h: string) => { html = h; } },
  };
  const keys = Object.keys(stubs);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const render = new Function(...keys, `let zombieProcs = []; ${index.slice(start, end)}; return renderZombies;`)(
    ...keys.map((k) => stubs[k]),
  ) as (r: unknown) => void;
  render(report);
  return html || body.innerHTML;
}

test('the held-up space card counts a shared file once and says so (QA D17)', () => {
  const shared = { path: '/var/db/cache', ino: 9, bytes: 600 };
  const report = groupZombies([
    { pid: 10, processName: 'logd', ...shared },
    { pid: 11, processName: 'Finder', ...shared },
    { pid: 12, processName: 'Dock', ...shared },
  ]);
  const html = paintZombies({ ...report, scannedAt: 0 });
  assert.match(html, /600 B held by 3 programs/, 'the headline is the file once, held by three programs');
  assert.match(html, /open in more than one program/, 'and the card says a shared file is counted once');
  assert.doesNotMatch(html, /1200 B|1800 B/, 'no figure on the card adds the shared file up per program');
});

test('the card offers Restart only where the server allows it, and says why not elsewhere (QA D40)', () => {
  const row = (pid: number, name: string, restartable: boolean, restartRefusal: string | null) => ({
    pid, processName: name, appBundle: null, bytes: 100, unknownSizeCount: 0, restartable, restartRefusal,
    handles: [{ path: `/tmp/${name}`, bytes: 100, holders: 1 }],
  });
  const html = paintZombies({
    processes: [row(1, 'MyApp', true, null), row(2, 'chronod', false, 'Part of macOS')],
    totalBytes: 200, unknownSizeCount: 0, fileCount: 2, sharedFileCount: 0, scannedAt: 0,
  });
  const rows = html.split('<div class="zh-row"').slice(1);
  assert.equal(rows.length, 2, 'both holders are listed');
  assert.match(rows[0], /data-zh-restart="0"/, 'a person’s own program keeps its Restart button');
  assert.doesNotMatch(rows[1], /data-zh-restart/, 'a system program is never offered one');
  assert.match(rows[1], /Part of macOS/, 'and the row says why');
});

test('the restart refusals are stated in one sentence the Missing GB page quotes (QA D40)', () => {
  for (const kind of [/part of the operating system/, /system administrator/, /another user/, /TreeMap itself/, /its own parent/]) {
    assert.match(RESTART_REFUSES, kind, `the sentence names every refusal restartProcess makes (${String(kind)})`);
  }
});

/* ══════════════════ The restart sheet says what will happen (E02) ══════════════════ */

/** The page's own confirmZombieRestart for `p`: the sheet's title, text and OK. */
function restartSheet(p: Record<string, unknown>): { title: string; text: string; ok: string } {
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  // From the app-name helper the sheet uses, through the sheet itself.
  const start = index.indexOf('function zhAppName(');
  const end = index.indexOf("$('zombieRefresh')", start);
  assert.ok(start > 0 && end > start && index.slice(start, end).includes('function confirmZombieRestart('), 'confirmZombieRestart is in the built page');
  const els: Record<string, { innerHTML: string; classList: { add: () => void } }> = {};
  const $ = (id: string) => (els[id] ??= { innerHTML: '', classList: { add: () => undefined } });
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const open = new Function('$', 'icon', 'escapeHtml', 'resetOpenHandleWarning', 'platformWord', 'lastPathSegment', 'api', 'toast', 'loadZombies',
    `let onConfirmTrash = null; ${index.slice(start, end)}; return confirmZombieRestart;`)(
    $, () => '', (s: unknown) => String(s), () => undefined, (w: Record<string, string>) => w.darwin,
    (q: string) => q.split('/').filter(Boolean).pop() ?? q, async () => ({}), () => undefined, () => undefined,
  ) as (p: unknown) => void;
  open(p);
  return { title: els.confirmTitle.innerHTML, text: els.confirmText.innerHTML, ok: els.confirmOk.innerHTML };
}

test('the restart sheet for a helper says unsaved work could be lost and that TreeMap will not reopen it — never a save prompt and a reopen (E02)', () => {
  const base = { pid: 9, bytes: 15_300_000, unknownSizeCount: 0, restartable: true, restartRefusal: null, handles: [] };
  const helper = restartSheet({ ...base, processName: 'Google Chrome Helper (Renderer)', appBundle: null, partOf: CHROME });
  assert.match(helper.text, /that work could be lost/, 'a helper never asks to save: its work can be lost');
  assert.match(helper.text, /runs inside <b>Google Chrome<\/b>/, 'it names the app it runs inside');
  assert.match(helper.text, /TreeMap does not reopen it/, 'and that TreeMap will not reopen it');
  assert.doesNotMatch(helper.text, /open it again|ask you to save/, 'no reopen and no save prompt is promised');

  const app = restartSheet({ ...base, processName: 'Google Chrome', appBundle: CHROME, partOf: null });
  assert.match(app.text, /then open it again/, 'control: the app itself is reopened');
  const bare = restartSheet({ ...base, processName: 'node', appBundle: null, partOf: null });
  assert.match(bare.text, /that work could be lost/, 'control: a bare program keeps its own wording');
  assert.match(bare.text, /start it again yourself/);
});

test('the OpenAPI document says which app a restart reopens and which it does not (E02)', async () => {
  const { buildOpenApiDocument } = await import('../src/api/openapi');
  const said = JSON.stringify((buildOpenApiDocument() as { paths: Record<string, unknown> }).paths['/api/zombie-handles']);
  assert.match(said, /appBundle \(the macOS app this process is[^)]*the only one a restart reopens\)/, 'appBundle is the app itself');
  assert.match(said, /partOf \(the macOS app a helper[^)]*a restart does not reopen it\)/, 'partOf is the app a helper runs inside');
});

test('the report reads each app\'s Info.plist once, however many of its programs hold space (E02)', async () => {
  const exes = new Map<number, string>([
    [4001, `${CHROME}/Contents/MacOS/Google Chrome`],
    [4002, `${CHROME}/Contents/MacOS/Google Chrome`], // a second instance
    [4003, '/Applications/Fake.app/Contents/MacOS/Fake'],
  ]);
  const asked: string[] = [];
  const deps: ReportDeps = {
    handles: heldBy([...exes.keys()]), run: fakePs(exes).run, os: 'darwin', uid: OUR_UID,
    bundleExecutable: async (bundle) => { asked.push(bundle); return path.basename(bundle, '.app'); },
  };
  const report = await zombieReport(deps);
  assert.deepEqual(report.processes.map((p) => p.appBundle).sort(), ['/Applications/Fake.app', CHROME, CHROME], 'control: each is its app');
  assert.deepEqual(asked.sort(), ['/Applications/Fake.app', CHROME], 'one read per app');
});

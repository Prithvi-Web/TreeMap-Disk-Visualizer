import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyTrashCommands } from '../src/services/trash';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTerminal, openCommand, runCommand, terminalCommands } from '../src/services/cleaner';

/**
 * Empty Trash and Open Terminal Here both shell out per platform. These tests
 * pin the exact argv arrays chosen for each process.platform WITHOUT executing
 * anything — the security property being guarded is that every command is an
 * execFile argv array and the user's path only ever travels as data, never as
 * shell text it could escape from.
 */

/* ---------------- emptyTrashCommands ---------------- */

test('empty trash on macOS goes through Finder via osascript', () => {
  assert.deepEqual(emptyTrashCommands('darwin'), [
    { cmd: 'osascript', args: ['-e', 'tell application "Finder" to empty trash'] },
  ]);
});

test('empty trash on Windows uses Clear-RecycleBin with hard error semantics', () => {
  assert.deepEqual(emptyTrashCommands('win32'), [
    {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', 'Clear-RecycleBin -Force -ErrorAction Stop'],
    },
  ]);
});

test('empty trash on Linux prefers gio; the dir-clearing fallback is separate', () => {
  assert.deepEqual(emptyTrashCommands('linux'), [
    { cmd: 'gio', args: ['trash', '--empty'] },
  ]);
});

/* ---------------- terminalCommands ---------------- */

// A path chosen to break out of anything that treats it as shell text.
const HOSTILE = '/tmp/we ird$(rm -rf ~)`touch pwned`"q" \'s\'';

test('macOS terminal: osascript primary with escaped AppleScript, open -a fallback', () => {
  const cmds = terminalCommands(HOSTILE, 'darwin');
  assert.equal(cmds.length, 2);

  const [osa, fallback] = cmds;
  assert.equal(osa.cmd, 'osascript');
  assert.equal(osa.args[0], '-e');
  const script = osa.args[1];
  // The path rides inside an AppleScript string literal handed to
  // `quoted form of` — the shell never parses it directly.
  assert.match(script, /do script "cd " & quoted form of "/);
  // Literal double quotes in the path must be AppleScript-escaped.
  assert.ok(script.includes('\\"q\\"'));
  // $(…) and backticks stay inert data inside the literal.
  assert.ok(script.includes('$(rm -rf ~)'));
  assert.match(script, /^tell application "Terminal"\n/);
  assert.match(script, /\nactivate\nend tell$/);

  assert.deepEqual(fallback, { cmd: 'open', args: ['-a', 'Terminal', HOSTILE] });
});


test('Linux terminal: emulators in preference order with their working-dir flags', () => {
  const cmds = terminalCommands(HOSTILE, 'linux');
  assert.deepEqual(cmds.map((c) => c.cmd), ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']);
  assert.deepEqual(cmds[0].args, [`--working-directory=${HOSTILE}`]);
  assert.deepEqual(cmds[1].args, [`--working-directory=${HOSTILE}`]);
  assert.deepEqual(cmds[2].args, ['--workdir', HOSTILE]);
  // xterm has no working-dir flag: a FIXED sh script reads the target from $1,
  // so the hostile path is never interpolated into shell text.
  assert.deepEqual(cmds[3].args, ['-e', 'sh', '-c', 'cd "$1" && exec "${SHELL:-sh}"', 'sh', HOSTILE]);
});

test('every candidate on every platform carries the path only as argv data', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as NodeJS.Platform[]) {
    for (const { cmd, args, cwd } of terminalCommands(HOSTILE, platform)) {
      assert.equal(typeof cmd, 'string');
      assert.ok(Array.isArray(args));
      if (cmd === 'osascript') continue; // path is inside the escaped literal, asserted above
      if (platform === 'win32') {
        // On Windows the path travels as the working directory only.
        assert.equal(cwd, HOSTILE, `${cmd} starts in the folder`);
        assert.ok(args.every((a) => !a.includes(HOSTILE)), `${cmd} carries no path`);
        continue;
      }
      // The path appears verbatim as (or inside) exactly one argv element.
      const carriers = args.filter((a) => a === HOSTILE || a.endsWith(HOSTILE));
      assert.equal(carriers.length, 1, `${platform}/${cmd} should carry the dir in one argv entry`);
    }
  }
});

/* ---------------- Windows: nothing a program parses again ---------------- */

// cmd.exe reads `&`, `|`, `^` and `%VAR%` in its whole command line, and
// Windows Terminal splits its commands at `;` — whatever the quoting. libuv
// quotes an argument only when it holds a space, a tab or a quote, so a name
// like `x&second` reached cmd.exe as syntax (the pre-landing review of 23 Sep
// 2026). Every character here is legal in a Windows name, and there is no
// space, so nothing gets quoted.
const WIN_HOSTILE = 'C:\\Work\\R&D\\x&second.exe;wt^%PATH%(1)!';

test('Windows open: PowerShell opens the path from the environment, never from a command line', () => {
  assert.deepEqual(openCommand(WIN_HOSTILE, false, 'win32'), {
    cmd: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', 'Invoke-Item -LiteralPath $env:TREEMAP_OPEN_TARGET'],
    env: { TREEMAP_OPEN_TARGET: WIN_HOSTILE },
  });
});

test('Windows reveal: explorer.exe, started directly, gets the path as its own argument', () => {
  assert.deepEqual(openCommand(WIN_HOSTILE, true, 'win32'), { cmd: 'explorer.exe', args: ['/select,', WIN_HOSTILE] });
});

test('macOS and Linux open and reveal pass the path as argv data', () => {
  assert.deepEqual(openCommand(HOSTILE, false, 'darwin'), { cmd: 'open', args: [HOSTILE] });
  assert.deepEqual(openCommand(HOSTILE, true, 'darwin'), { cmd: 'open', args: ['-R', HOSTILE] });
  assert.deepEqual(openCommand(HOSTILE, false, 'linux'), { cmd: 'xdg-open', args: [HOSTILE] });
});

test('Windows terminal: the folder is the new window\u2019s working directory, never an argument', () => {
  assert.deepEqual(terminalCommands(WIN_HOSTILE, 'win32'), [
    { cmd: 'wt.exe', args: ['-d', '.'], cwd: WIN_HOSTILE },
    { cmd: 'cmd.exe', args: ['/c', 'start', '', 'cmd.exe'], cwd: WIN_HOSTILE },
  ]);
});

test('no Windows command hands cmd.exe or Windows Terminal any part of the path', () => {
  const commands = [openCommand(WIN_HOSTILE, false, 'win32'), openCommand(WIN_HOSTILE, true, 'win32'), ...terminalCommands(WIN_HOSTILE, 'win32')];
  for (const { cmd, args } of commands) {
    if (cmd !== 'cmd.exe' && cmd !== 'wt.exe' && cmd !== 'powershell.exe') continue;
    for (const arg of args) {
      assert.ok(!arg.includes('R&D') && !arg.includes('%PATH%') && !arg.includes('second'), `${cmd} got ${arg}`);
    }
  }
});

test('the Windows open script parses, and Invoke-Item takes -LiteralPath', { skip: process.platform !== 'win32' && 'PowerShell runs only on Windows' }, () => {
  const { args } = openCommand('C:\\x', false, 'win32');
  const script = args[args.length - 1];
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '[void][scriptblock]::Create($env:TM_SCRIPT); (Get-Command Invoke-Item).Parameters.ContainsKey("LiteralPath")',
  ], { encoding: 'utf8', env: { ...process.env, TM_SCRIPT: script } });
  assert.equal(out.trim(), 'True');
});

/* ---------------- the plumbing, run for real ---------------- */

test('a command gets its environment: the way a path reaches a Windows script', async () => {
  const check = (env?: Record<string, string>) => runCommand({
    cmd: process.execPath,
    // Added to the environment, not in place of it: PowerShell needs the rest.
    args: ['-e', 'process.exit(process.env.TREEMAP_OPEN_TARGET === "C:\\\\R&D\\\\x&second" && process.env.PATH ? 0 : 3)'],
    ...(env ? { env } : {}),
  });
  await check({ TREEMAP_OPEN_TARGET: 'C:\\R&D\\x&second' });
  await assert.rejects(check(), 'without the variable the child exits 3');
});

test('a terminal starts in its folder: the way a folder reaches a Windows terminal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-terminal-cwd-'));
  try {
    const file = path.join(dir, 'started-in.txt');
    await launchTerminal({
      cmd: process.execPath,
      // The child reports where it started into a file named by absolute
      // path, so a launcher that dropped `cwd` fails here instead of leaving
      // a file wherever the test runner stands.
      args: ['-e', 'require("fs").writeFileSync(process.argv[1], process.cwd())', file],
      cwd: dir,
    });
    for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(fs.realpathSync(fs.readFileSync(file, 'utf8')), fs.realpathSync(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import { execFile, spawn } from 'child_process';
import { promises as fsp } from 'fs';
import path from 'path';
import { CleanResult } from '../models/types';
import { AppError } from '../middleware/errorHandler';
import { describeFsError } from '../utils/errno';
import { checkOpenHandles, describeConflicts } from './openHandleGuard';

/**
 * Cleaner — moves files to the system trash and opens paths in the OS.
 * Nothing here ever hard-deletes: every removal goes through the platform's
 * native trash so the user can undo from Finder/Files/Explorer.
 *
 * All commands run through execFile (argv arrays, no shell) so paths with
 * quotes, spaces or $(...) can never be interpreted as shell syntax. On
 * Windows that alone is not enough (WINDOWS_REPARSE below): there a path
 * never reaches the command line of a program that parses it again.
 *
 * Since B2 this is also where the open-file guard runs. It sits here, in the
 * one pathway every deletion already goes through, rather than in each caller —
 * so a feature added later cannot forget it, and there is no second delete
 * route to keep in sync.
 */

/** One command to run: an argv array, and what it needs besides. */
export interface PlatformCommand {
  cmd: string;
  args: string[];
  /** Variables added to the environment: how a path reaches a script as data. */
  env?: Record<string, string>;
  /** The working directory to start in: how a folder reaches a terminal as data. */
  cwd?: string;
}

/*
 * WINDOWS_REPARSE: on Windows a program receives one command line and splits
 * it itself, so an argv array protects an argument only from Node, not from
 * the program. cmd.exe reads `&`, `|`, `^` and `%VAR%` in its whole command
 * line, and Windows Terminal splits its commands at `;` — and libuv quotes an
 * argument only when it holds a space, a tab or a quote, so `start ""
 * C:\Work\R&D\a.txt` ran `D\a.txt` as a second command, and a crafted name
 * could start a program of its choosing (the pre-landing review of 23 Sep
 * 2026). No path is ever put on the command line of either: a script reads it
 * from the environment, a terminal starts in it.
 */

/** Runs one command to its end; rejects with what it wrote to stderr. */
export function runCommand({ cmd, args, env: extraEnv }: PlatformCommand, timeoutMs = 15000): Promise<void> {
  const env = extraEnv ? { ...process.env, ...extraEnv } : undefined;
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, ...(env ? { env } : {}) }, (err, _stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message || 'command failed').trim();
        reject(new Error(detail));
      } else {
        resolve();
      }
    });
  });
}

function run(cmd: string, args: string[]): Promise<void> {
  return runCommand({ cmd, args });
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
function appleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** A path refused before any trash call; its message is the sentence the page shows. */
class TrashRefusal extends Error {}

/**
 * Why `p` is not handed to the platform's trash call, or null. On Windows a
 * name that ends in a dot or a space is one name to NTFS (made from Linux,
 * or by a program using `\\?\` paths), and Node reaches it exactly; but the
 * Recycle Bin call normalizes the path the Win32 way and trims the dot or
 * space — in any part of the path — so trashing `a.` would recycle `a` if
 * one sits beside it, after `lstat` checked the right file (RISKS R61).
 */
export function trashRefusal(p: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32') return null;
  const trimmed = p.split(/[\\/]/).some((part) => part !== '.' && part !== '..' && /[. ]$/.test(part));
  return trimmed
    ? 'Windows would trim the dot or space that ends a name in its path and put a different file in the Recycle Bin, so TreeMap leaves it — rename it first, or delete it with the program that made it'
    : null;
}

async function trashOne(p: string): Promise<void> {
  // Confirm the path still exists (and learn file-vs-dir for Windows).
  const stat = await fsp.lstat(p); // throws ENOENT -> caught by caller
  const refusal = trashRefusal(p);
  if (refusal) throw new TrashRefusal(refusal);

  switch (process.platform) {
    case 'darwin': {
      const script = `tell application "Finder" to delete POSIX file "${appleScriptString(p)}"`;
      await run('osascript', ['-e', script]);
      return;
    }
    case 'win32': {
      const method = stat.isDirectory() ? 'DeleteDirectory' : 'DeleteFile';
      // FileIO.FileSystem routes through the Recycle Bin natively.
      const ps = [
        'Add-Type -AssemblyName Microsoft.VisualBasic;',
        `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}(`,
        `[string]$env:TREEMAP_TRASH_TARGET,`,
        `'OnlyErrorDialogs', 'SendToRecycleBin')`,
      ].join(' ');
      await new Promise<void>((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', ps],
          { timeout: 20000, windowsHide: true, env: { ...process.env, TREEMAP_TRASH_TARGET: p } },
          (err, _stdout, stderr) => {
            if (err) reject(new Error((stderr || err.message).trim()));
            else resolve();
          }
        );
      });
      return;
    }
    default: {
      // Linux & friends: freedesktop trash via gio (GLib), present on all
      // mainstream desktop distros.
      await run('gio', ['trash', p]);
      return;
    }
  }
}

export interface TrashOptions {
  /**
   * Skip the open-file check (B2).
   *
   * Set only when the user has already been shown the warning and chose to go
   * ahead — the "delete anyway" button — or when a caller has just run the
   * check itself. It never means "this caller doesn't care"; nothing in
   * TreeMap is allowed to delete without the user having had the chance to see
   * the warning.
   */
  ignoreOpenHandles?: boolean;
}

/**
 * Move every path to the system trash; per-path failures don't abort the batch.
 *
 * Refuses the whole batch with `OPEN_HANDLE_CONFLICT` when something in it is
 * open (§B2), unless the caller passes `ignoreOpenHandles`. All-or-nothing is
 * deliberate: silently trashing the 9 files that were free and stopping at the
 * 10th would leave the user with a half-applied delete they never agreed to.
 */
export async function moveToTrash(paths: string[], opts: TrashOptions = {}): Promise<CleanResult> {
  if (!opts.ignoreOpenHandles) {
    const report = await checkOpenHandles(paths);
    if (report.conflicts.length > 0) {
      throw new AppError(409, 'OPEN_HANDLE_CONFLICT', describeConflicts(report.conflicts), {
        conflicts: report.conflicts,
      });
    }
  }

  const deleted: string[] = [];
  const failed: { path: string; reason: string }[] = [];

  // Sequential on purpose: parallel osascript/powershell invocations are
  // flaky, and trash batches are small (UI sends chunks).
  for (const p of paths) {
    try {
      await trashOne(p);
      deleted.push(p);
    } catch (err) {
      // The page prints `reason` in a toast, so it gets a sentence; the raw
      // text (errno, syscall, path) goes to the terminal where it is useful.
      console.warn(`[treemap] could not move to the Trash: ${p}:`, err instanceof Error ? err.message : err);
      failed.push({ path: p, reason: err instanceof TrashRefusal ? err.message : describeFsError(err) });
    }
  }
  return { deleted, failed };
}

/**
 * Candidate argv commands, tried in order, to open the platform's terminal at
 * `dir`. Pure — exported so tests can assert the exact argv per platform
 * without spawning anything.
 *
 *  - macOS: AppleScript embeds the path with appleScriptString() escaping and
 *    then `quoted form of` single-quotes it for the shell, so spaces, quotes,
 *    $() and backticks can never break out of the cd argument. `do script`
 *    runs before `activate` so a cold-started Terminal opens one window, not
 *    two. If Terminal automation was denied, `open -a Terminal <dir>` starts
 *    a window already cd'd there without any Apple events.
 *  - Windows: Windows Terminal first, then cmd.exe `start`, each started in
 *    the directory (`cwd`) and never given it as an argument, since both
 *    parse their command line again (WINDOWS_REPARSE).
 *  - Linux: common emulators in order, each with its working-dir flag. xterm
 *    has none, so a fixed `sh -c` script reads the target from $1 — the path
 *    is never interpolated into shell text.
 */
export function terminalCommands(dir: string, platform: NodeJS.Platform = process.platform): PlatformCommand[] {
  switch (platform) {
    case 'darwin': {
      const script =
        `tell application "Terminal"\n` +
        `do script "cd " & quoted form of "${appleScriptString(dir)}"\n` +
        `activate\n` +
        `end tell`;
      return [
        { cmd: 'osascript', args: ['-e', script] },
        { cmd: 'open', args: ['-a', 'Terminal', dir] },
      ];
    }
    case 'win32':
      // The folder is the new window's working directory, never an argument:
      // both programs parse their command line again (see WINDOWS_REPARSE).
      // cmd.exe refuses a network share (UNC) as its working directory however
      // it is given one, `start /D` included, and opens in the Windows folder;
      // on a share only Windows Terminal starts in the folder.
      return [
        { cmd: 'wt.exe', args: ['-d', '.'], cwd: dir },
        { cmd: 'cmd.exe', args: ['/c', 'start', '', 'cmd.exe'], cwd: dir },
      ];
    default:
      return [
        { cmd: 'x-terminal-emulator', args: [`--working-directory=${dir}`] },
        { cmd: 'gnome-terminal', args: [`--working-directory=${dir}`] },
        { cmd: 'konsole', args: ['--workdir', dir] },
        { cmd: 'xterm', args: ['-e', 'sh', '-c', 'cd "$1" && exec "${SHELL:-sh}"', 'sh', dir] },
      ];
  }
}

/**
 * Launch one terminal candidate. Some emulators (konsole, xterm) stay in the
 * foreground for the life of their window, so success is "spawned and still
 * alive after a grace period (or exited 0)", not "exited" — waiting for exit
 * would misread a perfectly good window as a timeout and open a second one.
 */
export function launchTerminal({ cmd, args, cwd }: PlatformCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, ...(cwd ? { cwd } : {}) });
    let settled = false;
    const settle = (fn: () => void): void => { if (!settled) { settled = true; fn(); } };
    child.once('error', (err) => settle(() => reject(err))); // ENOENT — not installed
    child.once('exit', (code) => {
      if (code === 0) settle(resolve);
      else settle(() => reject(new Error(`${cmd} exited with code ${String(code)}`)));
    });
    setTimeout(() => settle(() => { child.unref(); resolve(); }), 1200);
  });
}

/**
 * Open the platform's terminal at `dirPath` (Open Terminal Here). Tries each
 * candidate in order; one that is missing or exits nonzero falls through to
 * the next. All argv arrays, no shell.
 */
export async function openTerminal(dirPath: string): Promise<void> {
  const errors: string[] = [];
  for (const command of terminalCommands(dirPath)) {
    try {
      await launchTerminal(command);
      return;
    } catch (err) {
      errors.push(`${command.cmd}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`No terminal emulator could be opened (${errors.join('; ')})`);
}

/**
 * How to open `p` with its default handler, or with `reveal` highlight it in
 * Finder/Explorer. Pure — exported so tests assert the argv per platform.
 * On Windows opening goes through PowerShell's `Invoke-Item`, which reads the
 * path from the environment (WINDOWS_REPARSE); explorer.exe, started
 * directly, takes it as its own argument.
 */
export function openCommand(p: string, reveal: boolean, platform: NodeJS.Platform = process.platform): PlatformCommand {
  switch (platform) {
    case 'darwin':
      return { cmd: 'open', args: reveal ? ['-R', p] : [p] };
    case 'win32':
      return reveal
        ? { cmd: 'explorer.exe', args: ['/select,', p] }
        : {
          cmd: 'powershell.exe',
          args: ['-NoProfile', '-NonInteractive', '-Command', 'Invoke-Item -LiteralPath $env:TREEMAP_OPEN_TARGET'],
          env: { TREEMAP_OPEN_TARGET: p },
        };
    default:
      return { cmd: 'xdg-open', args: [p] };
  }
}

/**
 * Open a file/folder with the OS default handler.
 * With `reveal`, highlights the item in Finder/Explorer instead of opening it.
 */
export async function openPath(p: string, reveal = false): Promise<void> {
  await fsp.lstat(p); // throws ENOENT for missing paths

  const command = openCommand(p, reveal);
  const opened = runCommand(command);
  if (command.cmd === 'explorer.exe') {
    await opened.catch(() => {
      /* explorer returns nonzero exit codes even on success */
    });
    return;
  }
  await opened;
}

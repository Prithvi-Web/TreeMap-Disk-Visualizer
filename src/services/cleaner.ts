import { execFile, spawn } from 'child_process';
import { promises as fsp } from 'fs';
import path from 'path';
import { CleanResult } from '../models/types';
import { AppError } from '../middleware/errorHandler';
import { describeFsError } from '../utils/errno';
import { checkOpenHandles, describeConflicts, type OpenHandleReport } from './openHandleGuard';
import { capabilityState } from '../platform/capabilities';
import { assertNotSafetyRecord, assertNotSpillPath, insideAnyScanRoot, outsideScanRootSentence } from '../middleware/pathGuard';
import { RealMachineRefusal, refuseUnderTestRunner } from './realMachineGuard';
import { emptyCheckSession, NOT_EMPTY_CODES } from './emptyFolderCheck';

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

/**
 * A command stopped before it answered — at its time limit, or (on macOS and Linux) by a signal
 * from outside — rather than one that failed on its own. What it was asked to do may still happen:
 * osascript stopped at its limit has already handed Finder the move, and Finder can finish it
 * afterwards (FG3b). A caller that would act on "it did not happen" treats this as "not known".
 */
export class CommandStopped extends Error {}

/**
 * The error a finished command rejects with: `CommandStopped` when it did not end on its own —
 * execFile stopped it (`killed`, its time limit, on every platform) or a signal ended it (`signal`:
 * the out-of-memory killer, a person; macOS and Linux only) — and a plain Error when it exited with
 * a failure. Windows has no signals: libuv ends a process there with TerminateProcess(handle, 1) and
 * reports a signal only for a child this process killed itself, so a command ended by anyone else
 * exits 1 with no signal and reads as a failure of its own (tests/platformCommands.test.ts, FG3c).
 */
function commandError(err: Error & { killed?: boolean; signal?: NodeJS.Signals | null }, stderr: string): Error {
  const detail = (stderr || err.message || 'command failed').trim();
  return err.killed === true || (err.signal !== undefined && err.signal !== null) ? new CommandStopped(detail) : new Error(detail);
}

/** Runs one command to its end; rejects with what it wrote to stderr. */
export function runCommand({ cmd, args, env: extraEnv }: PlatformCommand, timeoutMs = 15000): Promise<void> {
  const env = extraEnv ? { ...process.env, ...extraEnv } : undefined;
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, ...(env ? { env } : {}) }, (err, _stdout, stderr) => {
      if (err) reject(commandError(err, stderr));
      else resolve();
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
  // Under a test runner the machine's Trash is never reached: a test stands in for this step
  // (setTrashStepForTests). Before anything else, the lstat below included (realMachineGuard.ts).
  refuseUnderTestRunner(`a test reached the machine's real Trash: ${p} — use setTrashStepForTests`);
  // Confirm the path still exists (and learn file-vs-dir for Windows).
  const stat = await fsp.lstat(p); // throws ENOENT -> caught by caller

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
            if (err) reject(commandError(err, stderr));
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
  /**
   * Told what the open-file check found, when it runs (not with
   * `ignoreOpenHandles`), before any refusal: MCP's real trash_paths says
   * whether the check saw every program, as its dry run does (BQR-1 item 16).
   */
  onOpenHandleReport?: (report: OpenHandleReport) => void;
  /**
   * Nobody is watching this delete (Autopilot). An open-file check that could
   * not run — the mechanism exists here, but this attempt failed, as `lsof`
   * does when it outruns its limit on a loaded machine — then refuses the
   * delete, where a person's delete would go ahead on the unknown answer after
   * being shown it.
   */
  unattended?: boolean;
  /**
   * Every path was offered as an empty folder (Empty Folders, Track U U-4):
   * each is looked at again right before its own Trash step, and one that is
   * not still an empty folder is left where it is and failed with `refused`
   * and the code that says why (`NOT_EMPTY_CODES`, U-4b L4): it holds
   * something (`FOLDER_NOT_EMPTY`), a folder in it cannot be read
   * (`FOLDER_UNREADABLE`), it or its drive does not answer, or its drive holds
   * two calls that have not and it is not asked (`FOLDER_NO_ANSWER`), the 10 s for
   * looking ran out before its turn (`FOLDER_NOT_CHECKED`), it holds
   * too much to look through (`FOLDER_TOO_MANY_ENTRIES`), it is not a folder
   * (`NOT_A_FOLDER`). A path that is gone fails as it always did.
   */
  onlyEmptyFolders?: boolean;
  /**
   * With `onlyEmptyFolders`: Empty Folders' junk rule — OS junk such as
   * .DS_Store is not content. True when left out; the pane sends the choice its
   * list was made with (U-4b L4).
   */
  ignoreJunk?: boolean;
  /**
   * Asked of each path at its own turn, right before its Trash step (FG3f): a sentence and a code
   * when it must not be trashed after all — it is then left where it is and failed with
   * `refused: true` and that code — or null to go ahead. The Undo Vault's: the item's copy is
   * still there, and the item is still what was copied.
   */
  checkEach?: (p: string) => Promise<{ reason: string; code: string } | null>;
}

/** Why an "only empty folders" delete leaves a folder the look found gone that a stat then finds there. */
const GONE_YET_THERE = 'it seemed to be gone when TreeMap looked at it again, yet it is there, so TreeMap cannot tell that it is empty';

/** The step that moves one path to the Trash; a test replaces it (setTrashStepForTests). */
let trashStep: (p: string) => Promise<void> = trashOne;

/**
 * Test-only: run `step` in place of the real Trash step, so a test can drive
 * every delete path without anything reaching the machine's Trash; null
 * restores the real one. Under a test runner the real one refuses
 * (realMachineGuard.ts), so a test that reaches a delete must use this.
 */
export function setTrashStepForTests(step: ((p: string) => Promise<void>) | null): void {
  trashStep = step ?? trashOne;
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
  // The backstop behind every entry point's own refusal (Phase 4 §S.5.3): nothing in TreeMap's
  // own spill folder is ever trashed, whatever asked. The whole batch is refused, before anything.
  for (const p of paths) {
    assertNotSpillPath(p);
    assertNotSafetyRecord(p); // the agent policy and the audit log, whatever asked (the final review, F1.11)
  }
  if (!opts.ignoreOpenHandles) {
    const report = await checkOpenHandles(paths);
    opts.onOpenHandleReport?.(report);
    if (report.conflicts.length > 0) {
      throw new AppError(409, 'OPEN_HANDLE_CONFLICT', describeConflicts(report.conflicts), {
        conflicts: report.conflicts,
      });
    }
    // An unattended delete never trashes what the check could not look at.
    // Only where the mechanism exists here and this attempt failed: where it
    // can never run, refusing would stop every delete for good, and the rule
    // above (go ahead on an unknown answer) stands for both.
    if (opts.unattended && !report.checked && (await capabilityState('openHandleGuard')).available) {
      throw new AppError(
        409,
        'OPEN_HANDLE_UNCHECKED',
        `${report.reason ?? 'TreeMap couldn’t check whether these files are in use.'} Nobody was watching this run, so nothing was moved to the Trash; the next run will check again.`,
      );
    }
  }

  const deleted: string[] = [];
  const failed: CleanResult['failed'] = [];
  // One session of looks for the batch (U-4b M1): a drive that does not answer is asked once, and
  // the looks together stop after 10 s — the Trash steps between them are not looking.
  const looks = opts.onlyEmptyFolders ? emptyCheckSession(opts.ignoreJunk !== false) : null;

  // Sequential on purpose: parallel osascript/powershell invocations are
  // flaky, and trash batches are small (UI sends chunks).
  for (const p of paths) {
    try {
      // A path the platform's trash call would change is handed to no Trash step, a test's
      // stand-in included (trashRefusal, RISKS R61). One that has gone since the scan reads as
      // gone, as it did when the refusal sat inside the Trash step after its lstat: the lstat,
      // which reaches the name exactly, comes first.
      const refusal = trashRefusal(p);
      if (refusal) {
        await fsp.lstat(p);
        throw new TrashRefusal(refusal);
      }
      if (looks) {
        // At this path's own turn, not before the batch: an earlier step's wait is time for it to fill.
        const look = await looks.look(p);
        if (!look.empty && look.why !== 'gone') {
          failed.push({ path: p, reason: look.reason, refused: true, code: NOT_EMPTY_CODES[look.why] });
          continue;
        }
        if (!look.empty) {
          // Gone, the look says. It fails as gone on a stat of its own, as the Trash step's stat
          // would have failed it — and is never handed to the Trash (U-4c L1): a folder there now,
          // under that name, is one nobody looked at.
          await fsp.lstat(p); // ENOENT -> caught below, the path's failure
          failed.push({ path: p, reason: GONE_YET_THERE, refused: true, code: NOT_EMPTY_CODES.unreadable });
          continue;
        }
      }
      if (opts.checkEach) {
        const stop = await opts.checkEach(p);
        if (stop !== null) {
          failed.push({ path: p, reason: stop.reason, refused: true, code: stop.code });
          continue;
        }
      }
      await trashStep(p);
      deleted.push(p);
    } catch (err) {
      // A test that reached the real Trash is a failure of the test, never one path's reason.
      if (err instanceof RealMachineRefusal) throw err;
      // The page prints `reason` in a toast, so it gets a sentence; the raw
      // text (errno, syscall, path) goes to the terminal where it is useful.
      console.warn(`[treemap] could not move to the Trash: ${p}:`, err instanceof Error ? err.message : err);
      if (err instanceof CommandStopped) {
        failed.push({ path: p, reason: 'the Trash did not answer in time, and may still finish moving it', stopped: true });
      } else if (err instanceof TrashRefusal) {
        failed.push({ path: p, reason: err.message, refused: true });
      } else {
        failed.push({ path: p, reason: describeFsError(err) });
      }
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
 * Where a path to open comes from. `scanned`: a request naming a path, which must lie inside a
 * scanned root. `offloadCopy`: a copy the offload manifest recorded on another drive, which no
 * scan covers and the manifest vouches for.
 */
export type OpenScope = 'scanned' | 'offloadCopy';

/**
 * The service's own check before anything is started at `p`: never TreeMap's own spill folder,
 * and for a `scanned` path inside a scanned root. The routes judge both already; a service that
 * starts programs at a path does not take its caller's word that it was judged, as moveToTrash,
 * relocateSecret and runGitGc do not (T17a's security review).
 */
function assertMayOpen(p: string, scope: OpenScope): void {
  assertNotSpillPath(p);
  if (scope === 'scanned' && !insideAnyScanRoot(p)) {
    throw new AppError(403, 'OUTSIDE_SCAN_ROOT', outsideScanRootSentence(p));
  }
}

/** How openPath and openTerminal start their program; a test replaces both (setLaunchStepForTests). */
let openStep: (command: PlatformCommand) => Promise<void> = runCommand;
let terminalStep: (command: PlatformCommand) => Promise<void> = launchTerminal;

/**
 * Test-only: run `step` in place of starting the program for openPath and openTerminal, so a test
 * can drive both without anything opening on the machine; null restores the real ones.
 */
export function setLaunchStepForTests(step: ((command: PlatformCommand) => Promise<void>) | null): void {
  openStep = step ?? runCommand;
  terminalStep = step ?? launchTerminal;
}

/**
 * Open the platform's terminal at `dirPath` (Open Terminal Here). Tries each
 * candidate in order; one that is missing or exits nonzero falls through to
 * the next. All argv arrays, no shell.
 */
export async function openTerminal(dirPath: string): Promise<void> {
  assertMayOpen(dirPath, 'scanned');
  const errors: string[] = [];
  for (const command of terminalCommands(dirPath)) {
    try {
      await terminalStep(command);
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
 * directly, takes it as its own argument. xdg-open has no "select this item":
 * handed the item it would OPEN it, so a reveal there opens the folder that
 * holds it (POSIX paths, whatever the host).
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
      return { cmd: 'xdg-open', args: [reveal ? path.posix.dirname(p) : p] };
  }
}

/**
 * Open a file/folder with the OS default handler.
 * With `reveal`, highlights the item in Finder/Explorer instead of opening it.
 * `scope` says where the path comes from (`OpenScope`); a caller that does not
 * say gets the strict one.
 */
export async function openPath(p: string, reveal = false, scope: OpenScope = 'scanned'): Promise<void> {
  assertMayOpen(p, scope);
  await fsp.lstat(p); // throws ENOENT for missing paths

  const command = openCommand(p, reveal);
  const opened = openStep(command);
  if (command.cmd === 'explorer.exe') {
    await opened.catch(() => {
      /* explorer returns nonzero exit codes even on success */
    });
    return;
  }
  await opened;
}

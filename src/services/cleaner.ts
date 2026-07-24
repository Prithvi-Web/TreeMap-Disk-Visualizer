import { execFile, spawn } from "child_process";
import { promises as fsp } from "fs";
import path from "path";
import { CleanResult } from "../models/types";

/**
 * Cleaner — moves files to the system trash and opens paths in the OS.
 * Nothing here ever hard-deletes: every removal goes through the platform's
 * native trash so the user can undo from Finder/Files/Explorer.
 *
 * All commands run through execFile (argv arrays, no shell) so paths with
 * quotes, spaces or $(...) can never be interpreted as shell syntax.
 */

/** Windows recycle helper — SHFileOperation, not VB FileSystem (see script).
 *  Packaged builds load it from extraResources (asar is opaque to powershell.exe). */
export function windowsRecycleScriptPath(): string {
  const resources = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (resources) {
    return path.join(resources, "scripts", "sendToRecycleBin.ps1");
  }
  return path.join(__dirname, "..", "..", "scripts", "sendToRecycleBin.ps1");
}

function run(cmd: string, args: string[], timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message || "command failed").trim();
          reject(new Error(detail));
        } else {
          resolve();
        }
      },
    );
  });
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
function appleScriptString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function trashOne(p: string): Promise<void> {
  // Confirm the path still exists before asking the OS to trash it.
  await fsp.lstat(p); // throws ENOENT -> caught by caller

  switch (process.platform) {
    case "darwin": {
      const script = `tell application "Finder" to delete POSIX file "${appleScriptString(p)}"`;
      await run("osascript", ["-e", script]);
      return;
    }
    case "win32": {
      // Prefer SHFileOperation(FOF_ALLOWUNDO) over VisualBasic FileIO.FileSystem
      // DeleteFile/DeleteDirectory: the VB helpers' RecycleOption is unsupported
      // in non-interactive hosts and fails with ERROR_INVALID_LEVEL
      // ("The system call level is not correct") for many real folders.
      await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          windowsRecycleScriptPath(),
          "-Path",
          p,
        ],
        60_000,
      );
      return;
    }
    default: {
      // Linux & friends: freedesktop trash via gio (GLib), present on all
      // mainstream desktop distros.
      await run("gio", ["trash", p]);
      return;
    }
  }
}

/** Move every path to the system trash; per-path failures don't abort the batch. */
export async function moveToTrash(paths: string[]): Promise<CleanResult> {
  const deleted: string[] = [];
  const failed: { path: string; reason: string }[] = [];

  // Sequential on purpose: parallel osascript/powershell invocations are
  // flaky, and trash batches are small (UI sends chunks).
  for (const p of paths) {
    try {
      await trashOne(p);
      deleted.push(p);
    } catch (err) {
      failed.push({
        path: p,
        reason: err instanceof Error ? err.message : String(err),
      });
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
 *  - Windows: Windows Terminal first; the cmd.exe fallback passes the
 *    directory as its own /D argv entry (empty title guards spaced paths).
 *  - Linux: common emulators in order, each with its working-dir flag. xterm
 *    has none, so a fixed `sh -c` script reads the target from $1 — the path
 *    is never interpolated into shell text.
 */
export function terminalCommands(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] }[] {
  switch (platform) {
    case "darwin": {
      const script =
        `tell application "Terminal"\n` +
        `do script "cd " & quoted form of "${appleScriptString(dir)}"\n` +
        `activate\n` +
        `end tell`;
      return [
        { cmd: "osascript", args: ["-e", script] },
        { cmd: "open", args: ["-a", "Terminal", dir] },
      ];
    }
    case "win32":
      return [
        { cmd: "wt.exe", args: ["-d", dir] },
        { cmd: "cmd.exe", args: ["/c", "start", "", "/D", dir, "cmd.exe"] },
      ];
    default:
      return [
        { cmd: "x-terminal-emulator", args: [`--working-directory=${dir}`] },
        { cmd: "gnome-terminal", args: [`--working-directory=${dir}`] },
        { cmd: "konsole", args: ["--workdir", dir] },
        {
          cmd: "xterm",
          args: ["-e", "sh", "-c", 'cd "$1" && exec "${SHELL:-sh}"', "sh", dir],
        },
      ];
  }
}

/**
 * Launch one terminal candidate. Some emulators (konsole, xterm) stay in the
 * foreground for the life of their window, so success is "spawned and still
 * alive after a grace period (or exited 0)", not "exited" — waiting for exit
 * would misread a perfectly good window as a timeout and open a second one.
 */
function launchTerminal(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    let settled = false;
    const settle = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    child.once("error", (err) => settle(() => reject(err))); // ENOENT — not installed
    child.once("exit", (code) => {
      if (code === 0) settle(resolve);
      else
        settle(() =>
          reject(new Error(`${cmd} exited with code ${String(code)}`)),
        );
    });
    setTimeout(
      () =>
        settle(() => {
          child.unref();
          resolve();
        }),
      1200,
    );
  });
}

/**
 * Open the platform's terminal at `dirPath` (Open Terminal Here). Tries each
 * candidate in order; one that is missing or exits nonzero falls through to
 * the next. All argv arrays, no shell.
 */
export async function openTerminal(dirPath: string): Promise<void> {
  const errors: string[] = [];
  for (const { cmd, args } of terminalCommands(dirPath)) {
    try {
      await launchTerminal(cmd, args);
      return;
    } catch (err) {
      errors.push(
        `${cmd}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  throw new Error(
    `No terminal emulator could be opened (${errors.join("; ")})`,
  );
}

/**
 * Open a file/folder with the OS default handler.
 * With `reveal`, highlights the item in Finder/Explorer instead of opening it.
 */
export async function openPath(p: string, reveal = false): Promise<void> {
  await fsp.lstat(p); // throws ENOENT for missing paths

  switch (process.platform) {
    case "darwin":
      await run("open", reveal ? ["-R", p] : [p]);
      return;
    case "win32":
      if (reveal) {
        await run("explorer.exe", ["/select,", p]).catch(() => {
          /* explorer returns nonzero exit codes even on success */
        });
      } else {
        // `start` is a cmd builtin; empty title arg guards paths with spaces.
        await run("cmd.exe", ["/c", "start", "", p]).catch(() => {
          /* same quirk as explorer */
        });
      }
      return;
    default:
      await run("xdg-open", [p]);
      return;
  }
}

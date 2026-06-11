import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import { CleanResult } from '../models/types';

/**
 * Cleaner — moves files to the system trash and opens paths in the OS.
 * Nothing here ever hard-deletes: every removal goes through the platform's
 * native trash so the user can undo from Finder/Files/Explorer.
 *
 * All commands run through execFile (argv arrays, no shell) so paths with
 * quotes, spaces or $(...) can never be interpreted as shell syntax.
 */

function run(cmd: string, args: string[], timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message || 'command failed').trim();
        reject(new Error(detail));
      } else {
        resolve();
      }
    });
  });
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
function appleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function trashOne(p: string): Promise<void> {
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
      failed.push({ path: p, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { deleted, failed };
}

/**
 * Open a file/folder with the OS default handler.
 * With `reveal`, highlights the item in Finder/Explorer instead of opening it.
 */
export async function openPath(p: string, reveal = false): Promise<void> {
  await fsp.lstat(p); // throws ENOENT for missing paths

  switch (process.platform) {
    case 'darwin':
      await run('open', reveal ? ['-R', p] : [p]);
      return;
    case 'win32':
      if (reveal) {
        await run('explorer.exe', ['/select,', p]).catch(() => {
          /* explorer returns nonzero exit codes even on success */
        });
      } else {
        // `start` is a cmd builtin; empty title arg guards paths with spaces.
        await run('cmd.exe', ['/c', 'start', '', p]).catch(() => {
          /* same quirk as explorer */
        });
      }
      return;
    default:
      await run('xdg-open', [p]);
      return;
  }
}

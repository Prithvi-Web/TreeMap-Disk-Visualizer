import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import path from 'path';

/**
 * Disk capacity for the volume containing a path — shared by the /api/system
 * endpoint and the desktop tray (which shows free space in the menu bar).
 */

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

/** Parse `df -k <path>`: 1024-byte blocks; columns 2 and 4 are total/available. */
async function unixDiskUsage(target: string): Promise<{ total: number; free: number }> {
  const stdout = await exec('df', ['-k', target]);
  const lines = stdout.trim().split('\n');
  if (lines.length < 2) throw new Error('Unexpected df output');
  // The data line can wrap when the device name is long — take the last line.
  const cols = lines[lines.length - 1].trim().split(/\s+/);
  // Filesystem 1024-blocks Used Available ... — find the first numeric run.
  const numbers = cols.filter((c) => /^\d+$/.test(c)).map(Number);
  if (numbers.length < 3) throw new Error('Unexpected df output');
  return assertPlausible('df', numbers[0] * 1024, numbers[2] * 1024);
}

async function windowsDiskUsage(target: string): Promise<{ total: number; free: number }> {
  const drive = path.parse(path.resolve(target)).root.replace(/\\$/, ''); // "C:"
  const ps = `Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'" | Select-Object Size,FreeSpace | ConvertTo-Json`;
  const stdout = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  const parsed = JSON.parse(stdout) as { Size: number; FreeSpace: number };
  return assertPlausible('Get-CimInstance Win32_LogicalDisk', Number(parsed.Size), Number(parsed.FreeSpace));
}

/**
 * How long `statfs` gets before the OS tools are asked instead.
 *
 * `statfs(2)` blocks in the kernel on a stale or disconnected network mount —
 * for the mount's own `timeo`, which can be minutes. Every subprocess form
 * below carries a 10 s ceiling; the syscall carries none, so one is imposed
 * here. Two seconds is far beyond any local answer (measured sub-millisecond
 * on this Mac) and far below anything a user would sit through.
 *
 * What this bounds is the CALLER's wait, and only that. The libuv threadpool
 * thread stays blocked in the kernel for the mount's full timeout whatever
 * this promise does, and the `df` fallback then blocks too — so a hung NFS
 * mount costs about twelve seconds rather than being unbounded, with the
 * thread still held. Worth having; not a fix for the threadpool.
 */
const STATFS_TIMEOUT_MS = 2_000;

/**
 * The same numbers from one syscall, with no subprocess at all.
 *
 * `statfs` is `uv_fs_statfs`: `statvfs` on Unix, and on Windows the
 * cluster-counting `GetDiskFreeSpaceW` — NOT `GetDiskFreeSpaceEx`, which
 * returns byte totals and could not fill `f_bsize`/`f_blocks`/`f_bavail` at
 * all. That distinction matters rather than being pedantry: the `Ex` form is
 * quota-aware and the plain one is not, so on a Windows volume with per-user
 * quotas this and `Win32_LogicalDisk.FreeSpace` (the fallback below) will
 * disagree. Neither is wrong; they answer different questions, and this one
 * answers "how much room is on the volume".
 *
 * Verified against `df -k` on all twelve mounts of this Mac: byte-identical
 * totals, free within one block. NOT yet verified on Windows against
 * `Get-CimInstance` — `tests/diskUsage.test.ts` compares the two on whatever
 * platform it runs on, so CI answers that question on the runner rather than
 * this comment answering it from memory.
 *
 * It is the preferred path because the subprocess forms have a failure mode
 * with nothing to do with the disk: spawning costs time, and `powershell.exe`
 * on a loaded machine routinely takes seconds just to start. When the 10 s
 * ceiling is missed the rejection is indistinguishable from a real inability
 * to read the volume, and callers treat it as one — `/api/system` answered
 * 500 and the forecast reported `freeBytes: 0`. Two tests failed exactly that
 * way on Windows CI, in three separate runs, on a machine whose disk was
 * perfectly readable throughout.
 */
async function statfsDiskUsage(target: string): Promise<{ total: number; free: number }> {
  let timer: NodeJS.Timeout | undefined;
  const s = await Promise.race([
    fsp.statfs(target),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`statfs did not answer within ${String(STATFS_TIMEOUT_MS)}ms`)), STATFS_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });

  const total = Number(s.bsize) * Number(s.blocks);
  // `bavail`, not `bfree`: the reserved blocks a non-root process cannot touch
  // are not free space to anyone this app is speaking for. `df` agrees.
  // (On Windows libuv sets the two equal, so the distinction is a no-op there.)
  const free = Number(s.bsize) * Number(s.bavail);
  return assertPlausible('statfs', total, free);
}

/**
 * Refuse a reading that cannot be true, whichever producer made it.
 *
 * Applied to all three, not just the syscall. `Win32_LogicalDisk` reports
 * `Size: null` for an empty optical drive, a locked BitLocker volume and some
 * mounted-folder volumes, and `Number(null) || 0` is 0; `df` on a synthetic
 * mount reports zero blocks and still parses. Those are exactly the volumes
 * `statfs` is most likely to have failed on, so the fallback is the path most
 * likely to produce them — and `{ total: 0, free: 0 }` is what makes
 * `/api/system` say "0 B free" and `prepareOffload` print "only 0.0 GB free"
 * about a drive that is empty. Refusing is honest; zero is a claim.
 *
 * A number that is merely finite is not yet a number worth showing either: a
 * filesystem reporting `bavail` as a wrapped unsigned (free space below the
 * root reserve, unclamped) yields ~7e22, which passes `isFinite` and would
 * put "75 ZB free" in front of a user.
 */
function assertPlausible(source: string, total: number, free: number): { total: number; free: number } {
  if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0 || free < 0 || free > total) {
    throw new Error(`${source} reported implausible capacity (total ${String(total)}, free ${String(free)})`);
  }
  return { total, free };
}

export async function diskUsage(target: string): Promise<{ total: number; free: number }> {
  try {
    return await statfsDiskUsage(target);
  } catch (statfsErr) {
    // The OS tools stay as a fallback rather than being deleted: `statfs` is
    // one syscall with no timeout of its own and no second opinion, and a
    // wrong number here becomes a wrong number in the UI. When BOTH fail the
    // caller would otherwise see only the tool's message, with no trace that
    // the fast path was even tried — so the first reason is carried on the
    // second error rather than discarded.
    try {
      return await (process.platform === 'win32' ? windowsDiskUsage(target) : unixDiskUsage(target));
    } catch (toolErr) {
      // The CODE, not the whole message: `statfs`'s message repeats the
      // target path verbatim, which the tool's message already carries.
      const first = (statfsErr as NodeJS.ErrnoException | null)?.code
        ?? (statfsErr instanceof Error ? statfsErr.message : String(statfsErr));
      const second = toolErr instanceof Error ? toolErr.message : String(toolErr);
      throw new Error(`${second} (statfs first said: ${String(first)})`, { cause: toolErr });
    }
  }
}

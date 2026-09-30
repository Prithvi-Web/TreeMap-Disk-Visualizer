import childProcess from 'node:child_process';
import fs from 'node:fs';

/**
 * How many whole-machine enumerations of open files `fn` ran — `lsof -F`
 * runs on macOS, listings of /proc on Linux — beside what `fn` returned.
 *
 * §B2 asks for one enumeration pass intersected against the delete set in
 * memory, so a batch check costs the same whatever its size. That is a count,
 * and this counts it through the Node builtins the providers call
 * (`child_process.execFile`, `fs.promises.readdir`), so nothing in the app
 * changes for it. The capability probes (`lsof -v`, an access of
 * /proc/self/fd) enumerate nothing and are not counted, so a probe that
 * re-runs inside `fn` leaves the count alone.
 */
export async function openFileEnumerationsDuring<T>(fn: () => Promise<T>): Promise<{ result: T; runs: number }> {
  let runs = 0;
  const cp = childProcess as unknown as { execFile: (...args: unknown[]) => unknown };
  const realExecFile = cp.execFile;
  cp.execFile = function (this: unknown, cmd: unknown, args: unknown, ...rest: unknown[]): unknown {
    if (cmd === 'lsof' && Array.isArray(args) && args.includes('-F')) runs++;
    return realExecFile.call(this, cmd, args, ...rest);
  };
  const fsp = fs.promises as unknown as { readdir: (...args: unknown[]) => unknown };
  const realReaddir = fsp.readdir;
  fsp.readdir = function (this: unknown, dir: unknown, ...rest: unknown[]): unknown {
    if (String(dir) === '/proc') runs++;
    return realReaddir.call(this, dir, ...rest);
  };
  try {
    return { result: await fn(), runs };
  } finally {
    cp.execFile = realExecFile;
    fsp.readdir = realReaddir;
  }
}

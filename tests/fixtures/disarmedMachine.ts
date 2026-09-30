import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * For a child process of tests/realMachineGuard.test.ts that must reach a
 * door to the machine with the guard off — production, as the real app runs
 * it — and still touch nothing. From the call on, every child process (the
 * Finder, tmutil, PowerShell, gio, git), every directory listing outside
 * `allowed` and every request is recorded in the returned list and refused,
 * never made. It never puts anything back, so it is for a process of its own.
 *
 * It proves each refusal holds before it returns — a child process, a listing
 * and a request are each tried and must come back refused — and throws if one
 * does not, so a door is never reached on a machine that is not disarmed.
 */
export async function disarmTheMachine(allowed: string): Promise<string[]> {
  const calls: string[] = [];
  const refused = (what: string, code: string): Error => Object.assign(new Error(`the machine is disarmed: ${what}`), { code });
  const inside = (p: unknown): boolean => {
    const rel = path.relative(allowed, path.resolve(String(p)));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };

  // spawn, execFile, exec and fork all start their child through this one method.
  const proto = childProcess.ChildProcess.prototype as unknown as { spawn: (options: { file: string; args?: string[] }) => unknown };
  proto.spawn = (options) => {
    calls.push(`spawn ${[options.file, ...(options.args ?? []).slice(1)].join(' ')}`);
    throw refused(`${options.file} was not started`, 'EDISARMED');
  };
  const cp = childProcess as unknown as Record<'spawnSync' | 'execFileSync' | 'execSync', (file: string) => never>;
  for (const name of ['spawnSync', 'execFileSync', 'execSync'] as const) {
    cp[name] = (file) => {
      calls.push(`${name} ${file}`);
      throw refused(`${file} was not started`, 'EDISARMED');
    };
  }
  const fsp = fs.promises as unknown as { readdir: (...args: unknown[]) => Promise<unknown> };
  const readdir = fsp.readdir;
  fsp.readdir = async (...args) => {
    if (inside(args[0])) return readdir.apply(fs.promises, args);
    calls.push(`readdir ${String(args[0])}`);
    throw refused(`${String(args[0])} was not listed`, 'EACCES');
  };
  globalThis.fetch = (async (input: unknown) => {
    calls.push(`fetch ${String(input)}`);
    throw refused('no request was sent', 'EDISARMED');
  }) as typeof fetch;

  const holds: Array<[string, () => unknown]> = [
    ['a child process', () => childProcess.execFile(process.execPath, ['-e', ''])],
    ['a child process, synchronously', () => childProcess.spawnSync(process.execPath, ['-e', ''])],
    ['a listing outside its own folder', () => fs.promises.readdir(path.dirname(path.resolve(allowed)))],
    ['a request', () => fetch('http://127.0.0.1:9/')],
  ];
  for (const [what, attempt] of holds) {
    const outcome = await (async () => attempt())().then(() => 'made', (err: { message?: string }) => err.message ?? '');
    if (!outcome.startsWith('the machine is disarmed: ')) throw new Error(`the machine is not disarmed: ${what} was ${outcome === 'made' ? 'made' : `refused otherwise (${outcome})`}`);
  }
  calls.length = 0;
  return calls;
}

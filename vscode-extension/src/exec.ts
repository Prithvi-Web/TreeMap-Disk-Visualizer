import { ChildProcess, spawn } from 'node:child_process';
import * as net from 'node:net';
import * as os from 'node:os';
import { parseNodeMajor, MINIMUM_NODE_MAJOR } from './lib/serverReady';

/**
 * Running other programs, and finding a port.
 *
 * Every spawn here uses an argv array and `shell: false`. TreeMap's whole
 * safety story is that it never builds a command string out of a path, and an
 * extension that shelled out would undo that on the very first workspace whose
 * folder name contains a quote.
 */

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class Cancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'Cancelled';
  }
}

/**
 * Run a command to completion, streaming its output to `onOutput`.
 *
 * `signal` is honoured by killing the child: these are `git clone` and
 * `npm ci`, both of which can run for a minute, and a cancel button that only
 * takes effect after they finish is not a cancel button.
 */
export function run(
  command: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; onOutput?: (chunk: string) => void; signal?: AbortSignal },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Cancelled());
      return;
    }
    // npm on Windows ships as npm.cmd — there is no npm.exe. libuv's PATH
    // search only ever appends .com and .exe and never consults PATHEXT, so
    // spawning a bare `npm` there fails with ENOENT and the user is told npm
    // is not installed when it plainly is. Spawning `npm.cmd` is not the
    // answer either: Node refuses a .cmd without a shell (EINVAL, CVE-2024-27980).
    //
    // So npm — and only npm — is routed through the command processor. That is
    // safe *here* specifically because npm's argv is entirely fixed literals
    // ('ci', '--no-audit', '--no-fund', 'run', 'build'): no path, URL or ref is
    // ever passed to npm. git keeps its direct spawn, because git.exe resolves
    // normally and git IS handed user-controlled values.
    const viaCmd = process.platform === 'win32' && command === 'npm';
    const file = viaCmd ? process.env.ComSpec || 'cmd.exe' : command;
    const argv = viaCmd ? ['/d', '/s', '/c', command, ...args] : args;
    // shell:false is the default; stated because it is load-bearing.
    const child = spawn(file, argv, { cwd: opts.cwd, env: opts.env, shell: false });
    let stdout = '';
    let stderr = '';
    const onAbort = (): void => {
      child.kill('SIGTERM');
      // npm and git both normally exit on SIGTERM; this is the net for one
      // that does not, so a cancelled install cannot outlive the window.
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => { stdout += c; opts.onOutput?.(c); });
    child.stderr?.on('data', (c: string) => { stderr += c; opts.onOutput?.(c); });

    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) reject(new Cancelled());
      else resolve({ code, stdout, stderr });
    });
  });
}

/** A spawn that failed because the program is not installed at all. */
export function isMissingProgram(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/**
 * The Node that will run the server — deliberately NOT this process.
 *
 * The extension host is Electron, and TreeMap depends on better-sqlite3 and
 * sharp: native modules compiled for a specific NODE_MODULE_VERSION. Loading
 * the server in-process would abort the whole extension host with an ABI
 * mismatch on the first require. It must be a child process running the user's
 * own Node, which is also why the version is checked before anything is built.
 */
export async function findNode(env: NodeJS.ProcessEnv): Promise<{ path: string; version: string }> {
  const candidates = process.platform === 'win32' ? ['node.exe', 'node'] : ['node'];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const res = await run(candidate, ['--version'], { cwd: os.tmpdir(), env });
      if (res.code === 0) {
        const version = res.stdout.trim();
        const major = parseNodeMajor(version);
        if (major === null) throw new Error(`could not read a version from "${version}"`);
        if (major < MINIMUM_NODE_MAJOR) {
          throw new Error(
            `TreeMap needs Node ${MINIMUM_NODE_MAJOR} or newer to run; the Node on your PATH is ${version}.`,
          );
        }
        return { path: candidate, version };
      }
    } catch (err) {
      if (!isMissingProgram(err)) throw err;
      lastError = err;
    }
  }
  throw new Error(
    'No Node.js was found on your PATH. TreeMap runs its server on Node 20 or newer — ' +
      'install it from nodejs.org, then reopen the visualizer.' +
      (lastError ? '' : ''),
  );
}

/**
 * A port nothing is listening on right now.
 *
 * This is a hint, not a reservation — the port can be taken between the probe
 * and the server's own bind. That race is why the caller believes the port the
 * server PRINTS rather than the one requested, and why a bind failure is
 * retried on a fresh port instead of reported.
 */
export function findFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('could not find a free port'))));
    });
  });
}

export type { ChildProcess };

import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { findFreePort } from './exec';
import { findReady } from './lib/serverReady';

/**
 * Owning the TreeMap server process.
 *
 * One per window. The extension host is Electron and TreeMap loads native
 * modules built for plain Node, so this is always a child process running the
 * user's own Node — never a require() into this process.
 */

export interface RunningServer {
  url: string;
  port: number;
  stop: () => void;
}

const READY_TIMEOUT_MS = 30_000;
/** A port can be taken between the probe and the bind; try a few. */
const BIND_ATTEMPTS = 3;

export interface StartOptions {
  nodePath: string;
  /** The TreeMap checkout: the directory holding package.json. */
  dir: string;
  host: string;
  onLog: (line: string) => void;
  signal?: AbortSignal;
}

/**
 * Start the server and resolve once it has told us the port it bound.
 *
 * `dist/index.js` rather than `dist/server.js`: index.js is the entry point
 * that owns a whole process — it installs its own SIGTERM/SIGINT draining and
 * exits on a failed bind — which is exactly right for a child we are going to
 * kill, and exactly wrong to require in-process.
 *
 * The environment is scrubbed of TREEMAP_* rather than inherited wholesale. A
 * user with TREEMAP_TOKEN exported in their shell would otherwise get a server
 * demanding a bearer token the webview does not send, and a stray
 * TREEMAP_DATA_DIR would silently move where their scan history is written.
 */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < BIND_ATTEMPTS; attempt++) {
    if (opts.signal?.aborted) throw new Error('Cancelled');
    const port = await findFreePort(opts.host);
    try {
      return await spawnOnce(opts, port);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!/EADDRINUSE|address already in use/i.test(lastError.message)) throw lastError;
      opts.onLog(`[treemap] port ${port} was taken, trying another`);
    }
  }
  throw lastError ?? new Error('could not start the TreeMap server');
}

function spawnOnce(opts: StartOptions, port: number): Promise<RunningServer> {
  return new Promise<RunningServer>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('TREEMAP_')) delete env[key];
    }
    env.PORT = String(port);
    env.HOST = opts.host;

    const child: ChildProcess = spawn(opts.nodePath, [path.join('dist', 'index.js')], {
      cwd: opts.dir,
      env,
      shell: false,
    });

    let settled = false;
    let buffered = '';
    const stop = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      // index.ts drains SSE streams and exits within its own 5s deadline; this
      // is the net for a process that ignores the signal entirely.
      setTimeout(() => child.kill('SIGKILL'), 6000).unref();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      reject(new Error(`TreeMap did not start within ${READY_TIMEOUT_MS / 1000}s. Its log may say why.`));
    }, READY_TIMEOUT_MS);

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(new Error('Cancelled'));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (fn: () => void): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      opts.onLog(chunk);
      if (settled) return;
      // Accumulate: the ready line can be split across two chunks.
      buffered += chunk;
      const ready = findReady(buffered);
      if (!ready) return;
      settled = true;
      // The PRINTED port, not the requested one — see lib/serverReady.
      finish(() => resolve({ url: ready.url, port: ready.port, stop }));
    });
    // Buffered too, not just logged: index.ts reports a failed bind through
    // console.error, so stderr is the ONLY place the reason for an early exit
    // exists — and the exit handler below is what surfaces it to the user.
    child.stderr?.on('data', (chunk: string) => {
      opts.onLog(chunk);
      if (!settled) buffered += chunk;
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      finish(() => reject(err));
    });
    child.on('exit', (code, signal) => {
      opts.onLog(`[treemap] server exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`);
      if (settled) return;
      settled = true;
      // index.ts prints the cause and exits 1 on a failed bind, so the buffered
      // output is the only place the real reason exists. Carry it out.
      const tail = buffered.trim().split(/\r?\n/).slice(-4).join('\n');
      finish(() => reject(new Error(tail || `the TreeMap server exited with code ${code ?? 'null'}`)));
    });
  });
}

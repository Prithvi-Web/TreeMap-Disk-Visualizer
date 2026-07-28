import { spawn } from 'child_process';

/**
 * Property-list → JSON, via macOS's own `plutil`.
 *
 * Why this exists: the macOS tools TreeMap needs (`diskutil`, `mdls`) have no
 * `--json`, but they do have `-plist`, which is a structured mode. §2.3 forbids
 * regex over *human-formatted* output where a structured mode exists — it does
 * not ask us to hand-write an XML plist parser when the OS ships a converter.
 * So the pipeline is: tool → XML/binary plist → `plutil -convert json` →
 * `JSON.parse`. No regex touches any of it.
 *
 * `spawn` rather than `execFile` because plutil reads the plist on stdin
 * (`-` as its input argument). Still an argv array, still no shell.
 */

export class PlistConversionError extends Error {}

/** Convert a plist document (XML or binary) to a parsed JSON value. */
export function plistToJson<T>(plist: Buffer, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn('plutil', ['-convert', 'json', '-o', '-', '-'], { windowsHide: true });
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(() => reject(new PlistConversionError('plutil timed out')));
    }, timeoutMs);

    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => errOut.push(c));
    child.on('error', (err) => settle(() => reject(new PlistConversionError(err.message))));
    child.on('close', (code) => {
      settle(() => {
        if (code !== 0) {
          reject(new PlistConversionError(Buffer.concat(errOut).toString().trim() || `plutil exited ${String(code)}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(out).toString()) as T);
        } catch {
          reject(new PlistConversionError('plutil produced output that is not valid JSON'));
        }
      });
    });

    // A plist arriving on stdin can outrun the pipe buffer; end() flushes it.
    child.stdin.on('error', () => {
      /* plutil died early; the close handler reports it */
    });
    child.stdin.end(plist);
  });
}

/** Run a tool that emits a plist on stdout, and hand back parsed JSON. */
export function runPlist<T>(cmd: string, args: string[], timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(() => reject(new PlistConversionError(`${cmd} timed out`)));
    }, timeoutMs);

    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => errOut.push(c));
    child.on('error', (err) => settle(() => reject(new PlistConversionError(err.message))));
    child.on('close', (code) => {
      settle(() => {
        const body = Buffer.concat(out);
        if (body.length === 0) {
          reject(
            new PlistConversionError(
              Buffer.concat(errOut).toString().trim() || `${cmd} exited ${String(code)} with no output`,
            ),
          );
          return;
        }
        plistToJson<T>(body, timeoutMs).then(resolve, reject);
      });
    });
  });
}

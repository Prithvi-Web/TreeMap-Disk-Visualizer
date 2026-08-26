/**
 * Pure parsing for the TreeMap server's startup output.
 *
 * Nothing in `lib/` may import `vscode`: these modules are unit-tested from the
 * main repository's own suite (tests/vscodeExtension.test.ts), which runs under
 * plain Node with no extension host to provide that module.
 */

/**
 * The line src/index.ts prints once the socket is bound:
 *
 *     TreeMap running → http://127.0.0.1:4280
 *
 * Parsed rather than assumed, because it is the only statement of the port the
 * server ACTUALLY bound. The extension picks a free port and passes it in, but
 * a probe-then-bind is a race — something else can take the port in between —
 * and index.ts falls back to 4280 for any port that is not a positive integer
 * (`Number(process.env.PORT) || 4280`). Believing our own request rather than
 * the server's answer would point the webview at the wrong port.
 *
 * The arrow is matched loosely: it is a non-ASCII character in a log line, and
 * a mangled encoding must not cost us the port.
 */
export function parseReadyLine(line: string): { url: string; port: number } | null {
  const m = /TreeMap running\s*\S*\s*(https?:\/\/([^\s:/]+):(\d{1,5}))\s*$/.exec(line.trim());
  if (!m) return null;
  const port = Number(m[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { url: m[1], port };
}

/**
 * Scan a chunk of accumulated stdout for the ready line.
 *
 * Output arrives in arbitrarily-sized chunks, so a line can be split across
 * two reads; callers accumulate and re-scan rather than testing each chunk.
 */
export function findReady(buffered: string): { url: string; port: number } | null {
  for (const line of buffered.split(/\r?\n/)) {
    const hit = parseReadyLine(line);
    if (hit) return hit;
  }
  return null;
}

/** Node's `--version` output, e.g. "v20.11.1" -> 20. Null when unrecognisable. */
export function parseNodeMajor(versionOutput: string): number | null {
  const m = /^v?(\d+)\./.exec(versionOutput.trim());
  if (!m) return null;
  const major = Number(m[1]);
  return Number.isInteger(major) ? major : null;
}

/** TreeMap's package.json declares `node >=20`; below that it will not run. */
export const MINIMUM_NODE_MAJOR = 20;

export function nodeIsSupported(versionOutput: string): boolean {
  const major = parseNodeMajor(versionOutput);
  return major !== null && major >= MINIMUM_NODE_MAJOR;
}

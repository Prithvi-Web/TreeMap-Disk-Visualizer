/**
 * Client for the elevated NTFS MFT broker (named pipe TreeMapNtfsMftBroker).
 * Falls back to null/"unreachable" so callers can use per-scan UAC instead.
 */
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fsp from "node:fs/promises";

const execFileAsync = promisify(execFile);

export const BROKER_PIPE = "\\\\.\\pipe\\TreeMapNtfsMftBroker";
export const BROKER_TASK_NAME = "TreeMapNtfsMftBroker";

export type BrokerResponse = {
  id: number;
  ok: boolean;
  elevated?: boolean;
  exitCode?: number;
  error?: string;
};

function brokerScriptPath(): string {
  const resources = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (resources) {
    return path.join(resources, "scripts", "ntfsMftBroker.ps1");
  }
  return path.join(__dirname, "..", "..", "scripts", "ntfsMftBroker.ps1");
}

/** One request/response over the named pipe. Throws on timeout/connection errors. */
export function brokerRequest(
  payload: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<BrokerResponse> {
  const attempt = (): Promise<BrokerResponse> =>
    new Promise((resolve, reject) => {
      const client = net.connect(BROKER_PIPE);
      let buf = "";
      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error("broker IPC timeout"));
      }, timeoutMs);

      client.setEncoding("utf8");
      client.on("connect", () => {
        client.write(JSON.stringify(payload) + "\n");
      });
      client.on("data", (chunk) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(buf.slice(0, nl)) as BrokerResponse);
          } catch (err) {
            reject(err);
          }
          client.end();
        }
      });
      client.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

  // Broker recreates the named pipe between clients — brief ENOENT is expected.
  return (async () => {
    let lastErr: unknown;
    for (let i = 0; i < 8; i++) {
      try {
        return await attempt();
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ECONNREFUSED") throw err;
        await new Promise((r) => setTimeout(r, 150 + i * 50));
      }
    }
    throw lastErr;
  })();
}

export async function brokerPing(): Promise<boolean> {
  try {
    const r = await brokerRequest({ id: 1, cmd: "ping" }, 2000);
    return r.ok === true;
  } catch {
    return false;
  }
}

/**
 * Try to wake the standing broker via Task Scheduler (no UAC when /rl highest
 * was registered). Returns true if a subsequent ping succeeds.
 */
export async function ensureBrokerRunning(): Promise<boolean> {
  if (await brokerPing()) return true;
  try {
    await execFileAsync(
      "schtasks.exe",
      ["/run", "/tn", BROKER_TASK_NAME],
      { windowsHide: true, timeout: 10_000 },
    );
  } catch {
    return false;
  }
  // Broker must create the named pipe after process start — give it time.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await brokerPing()) return true;
  }
  return false;
}

/** Run the ntfs-mft-scan helper through the elevated broker (no UAC). */
export async function brokerRunHelper(
  exe: string,
  args: string[],
  timeoutMs = 5 * 60 * 1000,
): Promise<void> {
  const alive = await ensureBrokerRunning();
  if (!alive) {
    throw new Error("ntfs-mft broker unreachable");
  }
  const r = await brokerRequest(
    { id: Date.now(), cmd: "run", exe, args },
    timeoutMs,
  );
  if (!r.ok) {
    throw new Error(r.error || "broker run failed");
  }
  if (r.exitCode !== 0) {
    throw new Error(`ntfs-mft-scan exited with code ${r.exitCode}`);
  }
}

export async function brokerScriptExists(): Promise<boolean> {
  try {
    await fsp.access(brokerScriptPath());
    return true;
  } catch {
    return false;
  }
}

export { brokerScriptPath };

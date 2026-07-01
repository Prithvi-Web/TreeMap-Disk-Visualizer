import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

/**
 * OS snapshot accounting (Feature 9). Best-effort surfacing of space held by
 * filesystem snapshots that a normal directory walk never sees, so the "Used"
 * number lines up with what the OS reports. Every external tool is optional —
 * a missing tmutil/btrfs/vssadmin degrades to `available: false`, never a crash.
 */

export interface OsSnapshot {
  id: string;
  date: string | null;
  sizeBytes: number | null;
}

export interface SnapshotAccounting {
  available: boolean;
  platform: NodeJS.Platform;
  snapshots: OsSnapshot[];
  totalBytes: number | null;
  canPurge: boolean;
  reason?: string;
}

const EXEC_OPTS = { timeout: 8000, maxBuffer: 8 * 1024 * 1024 } as const;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unitToBytes(value: number, unit: string): number {
  const u = unit.toUpperCase();
  const mult = u.startsWith('T') ? 1024 ** 4 : u.startsWith('G') ? 1024 ** 3 : u.startsWith('M') ? 1024 ** 2 : u.startsWith('K') ? 1024 : 1;
  return Math.round(value * mult);
}

/** Extract `YYYY-MM-DD-HHMMSS` from a Time Machine snapshot name → ISO-ish string. */
export function parseTmDate(name: string): string | null {
  const m = name.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
}

/** Parse `tmutil listlocalsnapshots` output into snapshot records. */
export function parseTmList(stdout: string): OsSnapshot[] {
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('com.apple.TimeMachine'))
    .map((id) => ({ id, date: parseTmDate(id), sizeBytes: null }));
}

async function macSnapshots(): Promise<SnapshotAccounting> {
  try {
    const { stdout } = await exec('tmutil', ['listlocalsnapshots', '/'], EXEC_OPTS);
    const snapshots = parseTmList(stdout);
    return { available: true, platform: 'darwin', snapshots, totalBytes: null, canPurge: snapshots.length > 0 };
  } catch (err) {
    return { available: false, platform: 'darwin', snapshots: [], totalBytes: null, canPurge: false, reason: errMsg(err) };
  }
}

async function linuxSnapshots(): Promise<SnapshotAccounting> {
  try {
    const { stdout } = await exec('btrfs', ['subvolume', 'list', '/'], EXEC_OPTS);
    const snapshots = stdout
      .split('\n')
      .filter(Boolean)
      .map((line, i) => {
        const m = line.match(/path\s+(.+)$/);
        return { id: m ? m[1] : `subvolume-${i}`, date: null, sizeBytes: null };
      });
    return { available: true, platform: 'linux', snapshots, totalBytes: null, canPurge: false };
  } catch {
    return { available: false, platform: 'linux', snapshots: [], totalBytes: null, canPurge: false, reason: 'btrfs not available' };
  }
}

async function windowsSnapshots(): Promise<SnapshotAccounting> {
  try {
    const { stdout } = await exec('vssadmin', ['list', 'shadowstorage'], EXEC_OPTS);
    let totalBytes: number | null = null;
    const m = stdout.match(/Used Shadow Copy Storage space:\s*([\d.]+)\s*([A-Za-z]+)/i);
    if (m) totalBytes = unitToBytes(parseFloat(m[1]), m[2]);
    const count = (stdout.match(/Shadow Copy Storage association/gi) || []).length;
    const snapshots: OsSnapshot[] = Array.from({ length: count }, (_, i) => ({ id: `shadowstorage-${i}`, date: null, sizeBytes: null }));
    return { available: true, platform: 'win32', snapshots, totalBytes, canPurge: false };
  } catch (err) {
    return { available: false, platform: 'win32', snapshots: [], totalBytes: null, canPurge: false, reason: errMsg(err) };
  }
}

export async function getSnapshotAccounting(): Promise<SnapshotAccounting> {
  if (process.platform === 'darwin') return macSnapshots();
  if (process.platform === 'win32') return windowsSnapshots();
  if (process.platform === 'linux') return linuxSnapshots();
  return { available: false, platform: process.platform, snapshots: [], totalBytes: null, canPurge: false, reason: 'unsupported platform' };
}

export interface PurgeResult {
  ok: boolean;
  deleted: number;
  failed: number;
  error?: string;
}

/** Delete local Time Machine snapshots (macOS only). Time Machine recreates them on the next backup. */
export async function purgeSnapshots(): Promise<PurgeResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, deleted: 0, failed: 0, error: 'Purging snapshots is only supported on macOS' };
  }
  const acc = await macSnapshots();
  const dates = acc.snapshots
    .map((s) => s.id.match(/(\d{4}-\d{2}-\d{2}-\d{6})/)?.[1])
    .filter((d): d is string => Boolean(d));
  let deleted = 0;
  let failed = 0;
  for (const date of dates) {
    try {
      await exec('tmutil', ['deletelocalsnapshots', date], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
      deleted++;
    } catch {
      failed++;
    }
  }
  return { ok: failed === 0, deleted, failed };
}

import { execFile } from 'child_process';
import { promisify } from 'util';
import { measureShadowStorage, normalizeVolume, type ShadowStorageFailure, type ShadowStorageMeasurement } from '../platform/windows/vss';
import { reasonOf } from '../platform/exec';
import type { PowerShellOptions } from '../platform/windows/powershell';

const exec = promisify(execFile);

/**
 * OS snapshot accounting (Feature 9). Best-effort surfacing of space held by
 * filesystem snapshots that a normal directory walk never sees, so the "Used"
 * number lines up with what the OS reports. Every external tool is optional —
 * a missing tmutil/btrfs/PowerShell degrades to `available: false`, never a
 * crash.
 *
 * Windows goes through CIM (`Win32_ShadowStorage`, `Win32_ShadowCopy`) via
 * PowerShell and JSON, never `vssadmin`: that prints a table in the display
 * language, so an English regex found nothing on a Portuguese machine (issue
 * #33), and it refuses to run at all without administrator rights. When the
 * size is withheld, `sizeReason` says why in Windows' own words and what to do.
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
  /** Present only when `available` is false: why nothing could be asked. Shown verbatim. */
  reason?: string;
  /**
   * Present when `totalBytes` is null although the tool answered: why the
   * platform withheld the size, in its own words, with what to do about it.
   */
  sizeReason?: string;
  /**
   * Windows only. `volume` when the figures were scoped to the volume asked
   * for; `machine` when a volume was asked for but Windows did not say which
   * drive each restore point belongs to, so the figures cover every drive.
   */
  scope?: 'volume' | 'machine';
}

const EXEC_OPTS = { timeout: 8000, maxBuffer: 8 * 1024 * 1024 } as const;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/**
 * How to run TreeMap as an administrator, said once for every Windows sentence
 * that needs it. The system-tray part is not decoration: TreeMap keeps running
 * in the tray after its window closes (electron/main.js keeps the process alive
 * there), and a second copy started with "Run as administrator" meets the
 * single-instance lock and quits at once — so the user believes they elevated
 * and did not.
 */
export const ELEVATE_HOW =
  'To run TreeMap as an administrator, first quit it — right-click its icon in the system tray (click the ^ arrow if it is hidden) and choose Quit TreeMap — then start it with Run as administrator. If a copy is still running in the tray, the administrator copy closes at once and the ordinary one only reopens its window.';

/** What to do when Windows withholds the size. */
export const NEEDS_ADMIN = `Windows normally shows how much space restore points use only to an administrator. ${ELEVATE_HOW}`;

/** The one invariant word from a refusal, for a report to be looked up by. */
function what(f: ShadowStorageFailure | null): string {
  const word = f ? f.native || f.category || f.id : undefined;
  return word ? ` (${word})` : '';
}

/** WBEM_E_ACCESS_DENIED (0x80041003) and E_ACCESSDENIED (0x80070005), as the signed Int32 JSON carries. */
const DENIED_HRESULTS = new Set([-2147217405, -2147024891]);

function isDenied(f: ShadowStorageFailure): boolean {
  return f.category === 'PermissionDenied' || f.native === 'AccessDenied' || (f.hresult !== undefined && DENIED_HRESULTS.has(f.hresult));
}

/**
 * Would running as an administrator cure this refusal? Yes when Windows says
 * the process is not one and the refusal is a denial (or gives no reason at
 * all); when elevation is unknown, only a denial says so; an administrator's
 * refusal is something else entirely.
 */
function refusedByRights(m: ShadowStorageMeasurement, f: ShadowStorageFailure | null): boolean {
  if (m.elevated === true) return false;
  if (f === null) return m.elevated === false;
  return isDenied(f);
}

/**
 * Turn a Windows measurement into the receipt's shape. Pure; exported for tests.
 *
 * `mountPoint` (e.g. `C:\`) scopes the figures to one drive when Windows'
 * volume map allows it — the receipt is per volume, and D:'s shadow storage
 * must not be booked against C:. Without a mount point (the Dashboard) the
 * figures cover the whole PC on purpose.
 */
export function windowsSnapshotsFrom(m: ShadowStorageMeasurement, mountPoint?: string): SnapshotAccounting {
  const unavailable = (reason: string): SnapshotAccounting => ({ available: false, platform: 'win32', snapshots: [], totalBytes: null, canPurge: false, reason });

  // Neither the list nor the storage answered: nothing was measured at all, and
  // an empty list from a query that failed must never read as "none".
  if (!m.copiesKnown && m.storage === null) {
    const rights = refusedByRights(m, m.copiesFailure);
    return unavailable(`Windows would not list its restore points${what(m.copiesFailure)}.${rights ? ` ${NEEDS_ADMIN}` : ''}`);
  }

  const wanted = mountPoint ? normalizeVolume(mountPoint) : null;
  const device = wanted === null ? undefined : m.volumes.find((v) => v.letter !== null && normalizeVolume(v.letter) === wanted)?.deviceId;
  const scoped = device !== undefined;
  const inScope = (volume: string) => !scoped || normalizeVolume(volume) === normalizeVolume(device);
  const copies = m.copies.filter((c) => inScope(c.volume));
  const rows = m.storage === null ? null : m.storage.filter((r) => inScope(r.volume));

  const snapshots: OsSnapshot[] = copies.map((c) => ({
    id: c.id,
    date: c.takenAt === null ? null : new Date(c.takenAt).toISOString(),
    sizeBytes: null,
  }));
  const base: SnapshotAccounting = { available: true, platform: 'win32', snapshots, totalBytes: null, canPurge: false };
  if (wanted !== null) base.scope = scoped ? 'volume' : 'machine';
  const points = `${String(snapshots.length)} restore point${snapshots.length === 1 ? '' : 's'}`;

  if (rows === null) {
    // The storage query did not answer. Unelevated and denied for rights, that
    // is the rule rather than the exception; anything else is a refusal worth
    // naming, and elevating would not cure it.
    if (refusedByRights(m, m.failure)) return { ...base, sizeReason: NEEDS_ADMIN };
    return { ...base, sizeReason: `Windows would not report the space its restore points hold${what(m.failure)}.` };
  }
  let usedBytes: number | null = 0;
  for (const row of rows) {
    if (row.usedBytes === null) {
      usedBytes = null;
      break;
    }
    usedBytes += row.usedBytes;
  }
  if (usedBytes === null) {
    return { ...base, sizeReason: 'Windows reported its restore-point storage in a form TreeMap could not add up, so how much it holds cannot be read here.' };
  }
  if (rows.length === 0 && snapshots.length > 0) {
    // Restore points exist but no storage came back: unelevated that is the
    // usual silence, elevated it is a contradiction — either way not a zero.
    if (m.elevated !== true) return { ...base, sizeReason: NEEDS_ADMIN };
    return { ...base, sizeReason: `Windows lists ${points} but reported no storage for them, so how much they hold cannot be read here.` };
  }
  if (rows.length === 0 && snapshots.length === 0 && m.elevated !== true) {
    // A standard user may simply be shown nothing. An empty answer is then not
    // a measurement, and "no restore points" would be a guess.
    return {
      ...base,
      sizeReason: `Windows reported no restore points and no storage for them, but it normally shows these only to an administrator, so this may not be the whole picture. ${ELEVATE_HOW}`,
    };
  }
  // A measured figure, whatever the list said — the receipt uses the number
  // even when no restore point is listed at this moment.
  return { ...base, totalBytes: usedBytes };
}

/** Ask Windows, through PowerShell and CIM. `run` is injectable so a test can stand in for PowerShell. */
export async function measureWindowsSnapshots(run?: (script: string, opts?: PowerShellOptions) => Promise<unknown>, mountPoint?: string): Promise<SnapshotAccounting> {
  try {
    return windowsSnapshotsFrom(await measureShadowStorage(run), mountPoint);
  } catch (err) {
    return {
      available: false,
      platform: 'win32',
      snapshots: [],
      totalBytes: null,
      canPurge: false,
      reason: `TreeMap could not ask Windows about restore points: ${reasonOf(err)}`,
    };
  }
}

/** `mountPoint` scopes Windows' figures to one drive (the receipt); without it they cover the PC (the Dashboard). */
export async function getSnapshotAccounting(mountPoint?: string): Promise<SnapshotAccounting> {
  if (process.platform === 'darwin') return macSnapshots();
  if (process.platform === 'win32') return measureWindowsSnapshots(undefined, mountPoint);
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

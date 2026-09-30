import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * portableMode — the no-install, no-trace triage session (§D3).
 *
 * The promise is narrow and absolute: **a portable session leaves nothing on
 * the machine it is troubleshooting.** Everything TreeMap would normally write
 * to `~/Library/Application Support` (or `%APPDATA%`, or `~/.config`) — the
 * settings file, the snapshot history, the SQLite index, the Time Capsule —
 * goes beside the executable instead, on the removable drive it was launched
 * from.
 *
 * That promise does not rest on detection being clever. It rests on one fact:
 * `appDataDir()` is the single place every writer resolves its directory from,
 * so redirecting it redirects all of them at once. Detection only decides
 * whether to redirect; it never decides whether the guarantee holds.
 *
 * Three signals turn portable mode on, in order of authority:
 *
 *  1. `TREEMAP_PORTABLE=1` — explicit, and always wins.
 *  2. `PORTABLE_EXECUTABLE_DIR` — set by electron-builder's own portable
 *     target on Windows, so a portable build identifies itself.
 *  3. A `treemap-portable.txt` marker beside the executable — how the mac and
 *     Linux portable bundles identify themselves, since neither format has an
 *     equivalent of the Windows variable.
 *
 * Being *on removable media* is deliberately NOT one of them. It is a
 * heuristic — mount-point prefixes vary, network shares look external, and a
 * disk image mounted for an unrelated reason is not a portable session — and
 * silently changing where a normal install stores its data would be a far worse
 * surprise than not detecting a USB stick. Removability is used only to decide
 * which drives to *offer* in the picker, where being wrong costs nothing.
 *
 * **If the medium is read-only, nothing is persisted anywhere.** The session
 * runs entirely in memory and says so. Quietly falling back to the host's
 * normal location would break the one promise this feature makes.
 */

export type PortableSignal = 'env' | 'portable-executable-dir' | 'marker-file' | 'off';

export interface DegradedCapability {
  key: string;
  reason: string;
}

export interface PortableStatus {
  portable: boolean;
  signal: PortableSignal;
  /** Where state is written in this session. Null when nothing is persisted. */
  dataDir: string | null;
  /** The folder the executable lives in — the only place we may write. */
  baseDir: string;
  writable: boolean;
  /** Why nothing can be persisted, when that is the case. */
  reason?: string;
  /** True while the host's own app-data location has not been touched. */
  hostUntouched: boolean;
  /** The host location that is being deliberately avoided. */
  hostDataDir: string;
  degraded: DegradedCapability[];
}

export const PORTABLE_MARKER = 'treemap-portable.txt';
/** Written beside the executable, so the drive stays tidy and identifiable. */
export const PORTABLE_DATA_DIRNAME = 'TreeMap-Data';

/** Where a normal install would write, so the UI can name what is being avoided. */
export function hostDataDir(platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  switch (platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'TreeMap');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'TreeMap');
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'treemap');
  }
}

/**
 * The folder holding the running executable.
 *
 * Inside a macOS .app the executable is three levels down in
 * `TreeMap.app/Contents/MacOS/`, and writing there would put state *inside the
 * application bundle* — invisible to the user and destroyed by the next
 * update. The bundle's own parent is the right place.
 */
export function executableBaseDir(execPath = process.execPath): string {
  const dir = path.dirname(execPath);
  const macBundle = /\/([^/]+)\.app\/Contents\/MacOS\/?$/.exec(dir + '/');
  if (macBundle) return path.dirname(path.dirname(path.dirname(dir)));
  return dir;
}

/** Which signal, if any, says this is a portable session. */
export function portableSignal(env: NodeJS.ProcessEnv = process.env, baseDir = executableBaseDir()): PortableSignal {
  if (env.TREEMAP_PORTABLE === '1' || env.TREEMAP_PORTABLE === 'true') return 'env';
  if (env.PORTABLE_EXECUTABLE_DIR) return 'portable-executable-dir';
  try {
    fs.statSync(path.join(baseDir, PORTABLE_MARKER));
    return 'marker-file';
  } catch {
    return 'off';
  }
}

/** Can we actually create the data directory here? Proven by writing, not guessed. */
export function probeWritable(dir: string): { writable: boolean; reason?: string } {
  // A new name, created exclusively (FG3): the drive may have been prepared by someone else, and a
  // plain write to a name already there (the probe's used to be `.treemap-write-probe-<pid>`) goes
  // wherever a link at that name leads.
  const probe = path.join(dir, `.treemap-write-probe-${crypto.randomUUID()}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, 'x', { flag: 'wx' });
    fs.unlinkSync(probe);
    return { writable: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      writable: false,
      reason:
        code === 'EROFS' || code === 'EACCES' || code === 'EPERM'
          ? 'The drive TreeMap is running from is read-only, so nothing can be saved. This session works normally but keeps nothing: no settings, no scan history, no index — and it writes nothing to this computer either.'
          : `Nothing can be saved beside the app (${code || 'unknown error'}). This session keeps nothing, and writes nothing to this computer either.`,
    };
  }
}

const KEEPS_NOTHING = 'This session keeps nothing, and writes nothing to this computer either.';

/** A name for a sentence: control characters shown as `?`. */
function shownName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, '?');
}

/**
 * Why a TreeMap-Data folder someone else may have prepared must not be used, or null (FG4 #5).
 *
 * Every app-data writer resolves into this folder and writes fixed names there
 * (`settings.json.tmp`, `audit.jsonl`, `journal.jsonl(.tmp)`, `<name>.corrupt`…) with calls that
 * follow a link at that name. So the folder is refused when it is itself a link (or a junction),
 * or when anything at its top level is a link or anything but a plain file or folder. A folder
 * not there yet is fine: the probe makes it, fresh.
 */
export function portableDataDirRefusal(dir: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    return `The ${PORTABLE_DATA_DIRNAME} folder beside the app could not be checked (${code ?? 'unknown error'}). ${KEEPS_NOTHING}`;
  }
  if (st.isSymbolicLink()) {
    return `The ${PORTABLE_DATA_DIRNAME} folder beside the app is a link to somewhere else, so saving there could write anywhere on this computer. ${KEEPS_NOTHING}`;
  }
  if (!st.isDirectory()) return null; // not a folder at all: making it fails, and the probe says so
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return `The ${PORTABLE_DATA_DIRNAME} folder beside the app could not be read (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}). ${KEEPS_NOTHING}`;
  }
  for (const entry of entries) {
    const name = shownName(entry.name);
    if (entry.isSymbolicLink()) {
      return `The ${PORTABLE_DATA_DIRNAME} folder beside the app holds a link, ${name}, which could send TreeMap's saves somewhere else on this computer. ${KEEPS_NOTHING}`;
    }
    if (!entry.isFile() && !entry.isDirectory()) {
      return `The ${PORTABLE_DATA_DIRNAME} folder beside the app holds ${name}, which is not an ordinary file or folder. ${KEEPS_NOTHING}`;
    }
  }
  return null;
}

/**
 * What a portable session cannot do, stated per capability.
 *
 * §D3: "Note honestly in the UI which capabilities need privileges the portable
 * mode may not have … so a portable session degrades to a normal walker scan
 * with a clear label rather than appearing broken."
 */
export function degradedCapabilities(platform: NodeJS.Platform = process.platform, writable = true): DegradedCapability[] {
  const out: DegradedCapability[] = [];
  if (!writable) {
    out.push({
      key: 'liveIndex',
      reason: 'The instant-search index needs somewhere to write, and this drive is read-only. Searching still works on the folder you just scanned.',
    });
    out.push({
      key: 'scanHistory',
      reason: 'Scan history and trends are not kept, because nothing is saved in this session.',
    });
    out.push({
      key: 'journal',
      reason: 'The disk journal is not kept between sessions, because nothing is saved; changes noticed while TreeMap runs are still shown.',
    });
  }
  if (platform === 'win32') {
    out.push({
      key: 'fastEnumeration',
      reason: 'Reading the drive index (MFT) directly needs administrator rights, which a portable session usually does not have. Folders are read the ordinary way instead — a little slower, and every number is still exact.',
    });
  }
  if (platform === 'linux') {
    out.push({
      key: 'liveIndex',
      reason: 'Watching a whole filesystem for changes needs root. TreeMap watches the folders it has scanned instead, which covers what you are looking at.',
    });
  }
  out.push({
    key: 'shellIntegration',
    reason: 'A portable session deliberately adds nothing to this computer, so the "Scan with TreeMap" right-click entry is not offered.',
  });
  return out;
}

let cached: PortableStatus | null = null;

/**
 * Decide the session's mode, and — when portable and writable — point
 * `TREEMAP_DATA_DIR` at the removable drive.
 *
 * MUST run before anything reads `appDataDir()`. It sets the same environment
 * variable the tests and dev launch configs already use, so there is exactly
 * one redirection mechanism rather than a second parallel one. `baseDir` is
 * the folder the app runs from (`executableBaseDir()`); a test hands in its
 * own, so it never creates a data folder beside the Node it runs under.
 */
export function initPortableMode(env: NodeJS.ProcessEnv = process.env, baseDir = executableBaseDir()): PortableStatus {
  const host = hostDataDir();
  const signal = portableSignal(env, baseDir);

  if (signal === 'off') {
    cached = {
      portable: false, signal, dataDir: null, baseDir, writable: true,
      hostUntouched: false, hostDataDir: host, degraded: [],
    };
    return cached;
  }

  // An explicitly-set data dir wins: a person who said where to write meant it.
  if (env.TREEMAP_DATA_DIR) {
    const probe = probeWritable(env.TREEMAP_DATA_DIR);
    cached = {
      portable: true, signal, dataDir: env.TREEMAP_DATA_DIR, baseDir,
      writable: probe.writable, reason: probe.reason,
      hostUntouched: true, hostDataDir: host,
      degraded: degradedCapabilities(process.platform, probe.writable),
    };
    return cached;
  }

  const target = path.join(baseDir, PORTABLE_DATA_DIRNAME);
  // A folder prepared by someone else is checked before anything is written into it (FG4 #5).
  const planted = portableDataDirRefusal(target);
  const probe = planted ? { writable: false, reason: planted } : probeWritable(target);
  if (probe.writable) {
    env.TREEMAP_DATA_DIR = target;
  }
  // When it is NOT writable, TREEMAP_DATA_DIR is deliberately left unset AND
  // the caller is told: falling through to the host location would write to the
  // machine we promised not to touch. The server keeps everything in memory.
  cached = {
    portable: true, signal,
    dataDir: probe.writable ? target : null,
    baseDir,
    writable: probe.writable,
    reason: probe.reason,
    hostUntouched: true,
    hostDataDir: host,
    degraded: degradedCapabilities(process.platform, probe.writable),
  };
  return cached;
}

export function portableStatus(): PortableStatus {
  return cached ?? initPortableMode();
}

/**
 * True when this session must persist NOTHING, anywhere.
 *
 * Reached when the medium TreeMap was launched from is read-only. The tempting
 * behaviour — quietly writing to the host's normal app-data location instead —
 * is exactly the promise D3 makes and must not break, and a live portable run
 * proved that leaving `TREEMAP_DATA_DIR` unset does precisely that, because
 * "unset" means "use the host default". So storage, the index, the audit log
 * and the Time Capsule all consult this and keep everything in memory.
 */
export function isEphemeral(): boolean {
  const status = portableStatus();
  return status.portable && !status.writable;
}

/** Test-only: the decision is made once per process. */
export function resetPortableMode(): void {
  cached = null;
}

/* ────────────────────── external volumes, for the picker ────────────────────── */

/**
 * Mount points that look like an attached drive rather than the system disk.
 *
 * A heuristic, and labelled as one — it decides what to *offer*, never what to
 * write, so being wrong costs a user one extra click. Every OS mounts
 * user-attached media under a small set of well-known parents.
 */
export function externalMountParents(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') return ['/Volumes'];
  if (platform === 'win32') return [];
  return ['/media', '/run/media', '/mnt'];
}

export interface ExternalVolume {
  path: string;
  name: string;
}

/**
 * Attached volumes worth offering first in a portable session.
 *
 * On macOS the boot volume also appears under `/Volumes` as a symlink to `/`;
 * it is filtered out by resolving it, or the picker would offer the very disk
 * the user is standing on as an "external drive".
 */
export function listExternalVolumes(
  platform: NodeJS.Platform = process.platform,
  parents: string[] = externalMountParents(platform),
): ExternalVolume[] {
  const out: ExternalVolume[] = [];
  const rootReal = (() => {
    try { return fs.realpathSync('/'); } catch { return '/'; }
  })();
  const collect = (parent: string, flattenUsers: boolean): void => {
    let entries: string[];
    try {
      entries = fs.readdirSync(parent);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(parent, name);
      try {
        const st = fs.statSync(full);
        if (!st.isDirectory()) continue;
        if (fs.realpathSync(full) === rootReal) continue; // the boot volume
        if (flattenUsers) {
          // udisks mounts per-user: /run/media/<user>/<volume>. The user
          // directory is not a drive — reporting it would put the tmpfs's
          // fabricated capacity on the dock — so it is flattened one level
          // and each of ITS children is the volume.
          collect(full, false);
        } else {
          out.push({ path: full, name });
        }
      } catch {
        // A volume that vanished mid-listing is simply not offered.
      }
    }
  };
  for (const parent of parents) {
    const isRunMedia = path.basename(parent) === 'media' && path.basename(path.dirname(parent)) === 'run';
    collect(parent, isRunMedia);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

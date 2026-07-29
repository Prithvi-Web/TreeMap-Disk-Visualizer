import os from 'os';
import path from 'path';
import { ScanStore, TreeSource, asStore } from './scanStore';
import { CompiledIgnore, matchesAny } from '../utils/glob';

/**
 * securityHygieneScanner — secrets in the wrong place (§C5).
 *
 * This looks at **names and locations only**. It never opens a file, never
 * reads a byte of user content, and never sends anything anywhere. A private
 * key in `~/.ssh` is where a private key belongs and is not a finding; the same
 * file in `~/Downloads` is, because that is the folder people share, sync,
 * screen-record and forget.
 *
 * Two rules keep it honest:
 *
 *  - **Expected locations are per-pattern.** `credentials` under `~/.aws` is
 *    normal. `credentials` on the Desktop is not. A scanner that flagged the
 *    first would train people to ignore it.
 *  - **Nothing here is ever deleted automatically.** False positives in this
 *    category are expensive — the "fix" is to reveal it or move it somewhere
 *    sensible, both of which the user drives.
 */

export type SecuritySeverity = 'high' | 'medium' | 'low';

export interface SecurityPattern {
  id: string;
  /** What was matched, in plain English. */
  label: string;
  /** Why it matters, stated without drama. */
  why: string;
  severity: SecuritySeverity;
  /** Exact lowercased basenames. */
  names?: string[];
  /** Lowercased extensions, without the dot. */
  extensions?: string[];
  /** Lowercased basename prefixes (`id_rsa` also matches `id_rsa.pub`? no — see test). */
  prefixes?: string[];
  /**
   * Directories where this file is expected and therefore NOT a finding, as
   * path segments relative to home (`.ssh`, `.aws`). Matched against any
   * ancestor directory of the file.
   */
  expectedIn: string[];
  /** Where it should live, shown as the suggested destination. */
  suggestedHome?: string;
}

/**
 * The catalog. Deliberately conservative: every entry here is a file whose
 * mere presence outside its home is worth a look, not merely "interesting".
 */
export const SECURITY_PATTERNS: SecurityPattern[] = [
  {
    id: 'ssh-private-key',
    label: 'SSH private key',
    why: 'Anyone with this file can log in as you to every server that trusts it.',
    severity: 'high',
    names: ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'identity'],
    expectedIn: ['.ssh'],
    suggestedHome: '.ssh',
  },
  {
    id: 'pem-key',
    label: 'Private key or certificate',
    why: 'PEM files usually hold a private key or a certificate with one.',
    severity: 'high',
    extensions: ['pem', 'key', 'ppk'],
    expectedIn: ['.ssh', '.certs', '.config/certs'],
    suggestedHome: '.ssh',
  },
  {
    id: 'pkcs12-bundle',
    label: 'PKCS#12 certificate bundle',
    why: 'Bundles a certificate together with its private key.',
    severity: 'high',
    extensions: ['pfx', 'p12'],
    expectedIn: ['.certs'],
  },
  {
    id: 'java-keystore',
    label: 'Java keystore',
    why: 'Holds signing keys — a leaked release keystore cannot be revoked.',
    severity: 'high',
    extensions: ['jks', 'keystore'],
    expectedIn: ['.android', '.gradle'],
  },
  {
    id: 'cloud-credentials',
    label: 'Cloud provider credentials',
    why: 'Long-lived access keys that can spend money and read data.',
    severity: 'high',
    names: ['credentials', 'gcloud-credentials.json', 'azureprofile.json'],
    expectedIn: ['.aws', '.config/gcloud', '.azure', '.config/openstack'],
    suggestedHome: '.aws',
  },
  {
    id: 'kubeconfig',
    label: 'Kubernetes config',
    why: 'Grants cluster access, often with administrator rights.',
    severity: 'high',
    names: ['kubeconfig', 'config.kubeconfig'],
    expectedIn: ['.kube'],
    suggestedHome: '.kube',
  },
  {
    id: 'netrc',
    label: 'Stored login credentials',
    why: 'A .netrc stores usernames and passwords in plain text.',
    severity: 'high',
    names: ['.netrc', '_netrc'],
    expectedIn: [],
    // Its expected place IS the home directory, handled by homeIsExpected below.
  },
  {
    id: 'env-file',
    label: 'Environment file',
    why: 'A .env normally holds API keys and database passwords.',
    severity: 'medium',
    names: ['.env', '.env.local', '.env.production', '.env.prod'],
    expectedIn: [],
  },
  {
    id: 'crypto-wallet',
    label: 'Cryptocurrency wallet',
    why: 'A wallet file is the funds — losing or leaking it is irreversible.',
    severity: 'high',
    names: ['wallet.dat', 'keystore.json'],
    extensions: ['wallet'],
    expectedIn: [],
  },
  {
    id: 'password-database',
    label: 'Password database',
    why: 'A password vault is worth attacking offline for as long as it exists.',
    severity: 'medium',
    extensions: ['kdbx', 'kdb', 'agilekeychain', 'opvault'],
    expectedIn: [],
  },
  {
    id: 'git-credentials',
    label: 'Stored git credentials',
    why: 'Holds repository access tokens in plain text.',
    severity: 'medium',
    names: ['.git-credentials'],
    expectedIn: [],
  },
  {
    id: 'vpn-profile',
    label: 'VPN profile with embedded key',
    why: 'OpenVPN profiles frequently embed the client private key.',
    severity: 'medium',
    extensions: ['ovpn'],
    expectedIn: ['.config/openvpn', '.openvpn'],
  },
];

/**
 * Folders where finding a secret is worse than merely unexpected: shared,
 * synced, or routinely handed to someone else.
 */
const EXPOSED_FOLDERS = ['downloads', 'desktop', 'public', 'shared', 'documents'];
const SYNC_FOLDERS = ['dropbox', 'google drive', 'googledrive', 'onedrive', 'icloud drive', 'box sync', 'mydrive'];

export interface SecurityFinding {
  patternId: string;
  label: string;
  why: string;
  severity: SecuritySeverity;
  path: string;
  name: string;
  size: number;
  modifiedAt: number;
  /** Plain-English statement of where it is and why that is a problem. */
  reason: string;
  /** Absolute path this kind of file belongs in, when there is an obvious one. */
  suggestedPath?: string;
  /** True when the file sits in a folder that is shared or cloud-synced. */
  exposed: boolean;
  /**
   * True when an installed program owns this file. Listed for awareness only:
   * never called serious, and never offered a move.
   */
  appOwned: boolean;
}

export interface SecurityReport {
  findings: SecurityFinding[];
  counts: { high: number; medium: number; low: number };
  /** True once the cap below has bitten, so the UI can say the list is partial. */
  truncated: boolean;
}

const MAX_FINDINGS = 500;

/** True when `child` sits inside `parent` (or is it). */
function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Lowercased path segments of `p`, for ancestor matching. */
function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase());
}

/**
 * Places where an installed program owns what is inside.
 *
 * Chrome ships a CA bundle; Google Drive ships `roots.pem`; half of npm ships a
 * test fixture key. Those match the name rules exactly, but they are not a
 * secret anyone mislaid — they are part of the software. TreeMap still lists
 * them, because silently hiding a key-shaped file is the one thing this panel
 * must never do, but it does two things differently: it does not call them
 * serious, and it does not offer to move them. The relocate is a rename, and
 * renaming an application's own resource out from under it breaks that
 * application — which is a worse outcome than the finding it "fixed".
 */
const APP_OWNED_SEGMENTS = new Set([
  'node_modules', 'site-packages', 'dist-packages', 'bower_components',
  'program files', 'program files (x86)',
]);
/** The same idea where it takes two consecutive segments to be sure. */
const APP_OWNED_RUNS = [
  ['library', 'application support'],
  ['library', 'containers'],
  ['library', 'group containers'],
  ['appdata', 'local'],
  ['appdata', 'roaming'],
];

/** True when a run of segments appears consecutively in `dirs`. */
function hasRun(dirs: string[], want: string[]): boolean {
  for (let i = 0; i + want.length <= dirs.length; i++) {
    if (want.every((w, k) => dirs[i + k] === w)) return true;
  }
  return false;
}

/** True when the file lives inside an installed program's own files. */
export function isApplicationOwned(filePath: string): boolean {
  const dirs = segments(path.dirname(filePath));
  // A macOS bundle is a directory whose name ends in `.app`.
  if (dirs.some((d) => d.endsWith('.app') || APP_OWNED_SEGMENTS.has(d))) return true;
  return APP_OWNED_RUNS.some((want) => hasRun(dirs, want));
}

/**
 * Is `filePath` inside one of the pattern's expected directories?
 * `expectedIn` entries may be nested (`.config/gcloud`), matched as a
 * consecutive run of ancestor segments.
 */
function inExpectedLocation(filePath: string, pattern: SecurityPattern, homeDir: string): boolean {
  const dirSegments = segments(path.dirname(filePath));
  for (const expected of pattern.expectedIn) {
    const want = segments(expected);
    for (let i = 0; i + want.length <= dirSegments.length; i++) {
      if (want.every((w, k) => dirSegments[i + k] === w)) return true;
    }
  }
  // A `.netrc` or `.env` in the home directory itself is where it belongs.
  if (pattern.expectedIn.length === 0 && path.dirname(filePath) === homeDir) return true;
  return false;
}

function matchPattern(name: string): SecurityPattern | undefined {
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  return SECURITY_PATTERNS.find((p) => {
    if (p.names?.includes(lower)) return true;
    if (ext && p.extensions?.includes(ext)) return true;
    if (p.prefixes?.some((prefix) => lower.startsWith(prefix))) return true;
    return false;
  });
}

/**
 * Findings for a completed scan. Reads names and paths from the scan tree
 * only — no file is ever opened.
 */
export function collectSecurityFindings(
  source: TreeSource,
  ignore: CompiledIgnore[],
  homeDir: string = os.homedir(),
): SecurityReport {
  const store = asStore(source);
  const findings: SecurityFinding[] = [];
  let truncated = false;

  const visit = (node: number, nodePath: string): void => {
    for (const child of store.childIds(node)) {
      const name = store.name(child);
      const childPath = store.childPath(child, nodePath);
      if (matchesAny(ignore, childPath, name)) continue;
      if (store.isDir(child)) {
        visit(child, childPath);
        continue;
      }
      if (findings.length >= MAX_FINDINGS) { truncated = true; return; }

      const pattern = matchPattern(name);
      if (!pattern) continue;
      // A public key is not a secret, and flagging it teaches people to ignore
      // the whole panel.
      if (name.toLowerCase().endsWith('.pub')) continue;
      if (inExpectedLocation(childPath, pattern, homeDir)) continue;

      const dirs = segments(path.dirname(childPath));
      const exposedFolder = dirs.find((d) => EXPOSED_FOLDERS.includes(d));
      const syncFolder = dirs.find((d) => SYNC_FOLDERS.some((s) => d === s || d.startsWith(s)));
      const where = path.basename(path.dirname(childPath)) || path.dirname(childPath);

      // Being inside a synced or shared folder raises the stakes, never lowers
      // them — a medium finding in Dropbox is a high one.
      const stakes = syncFolder && pattern.severity === 'medium' ? 'high' : pattern.severity;
      const appOwned = isApplicationOwned(childPath);

      findings.push({
        patternId: pattern.id,
        label: pattern.label,
        why: pattern.why,
        // A file that ships with a program is where that program put it, so it
        // is not "in the wrong place" in the sense this panel means. Listed,
        // never called serious.
        severity: appOwned ? 'low' : stakes,
        path: childPath,
        name,
        size: store.size(child),
        modifiedAt: store.modifiedAt(child),
        reason: appOwned
          ? `In “${where}”, which belongs to an installed program — this file is part of that software, so moving it would break it.`
          : syncFolder
            ? `In “${where}”, which syncs to the cloud — a copy of this file leaves this computer.`
            : exposedFolder
              ? `In “${where}”, a folder that is easy to share or hand over by accident.`
              : `In “${where}”, which is not where this kind of file belongs.`,
        // Only suggest a home directory for a file that is ALREADY under home.
        // Proposing to move a key found on an external drive into ~/.ssh is a
        // surprising place to put someone's file, and the rename would fail
        // across filesystems anyway. And never for a file a program owns.
        suggestedPath:
          !appOwned && pattern.suggestedHome && isUnder(childPath, homeDir)
            ? path.join(homeDir, pattern.suggestedHome)
            : undefined,
        exposed: Boolean(syncFolder || exposedFolder),
        appOwned,
      });
    }
  };
  visit(store.rootId, store.rootPath);

  const rank: Record<SecuritySeverity, number> = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || Number(b.exposed) - Number(a.exposed) || b.modifiedAt - a.modifiedAt);

  return {
    findings,
    counts: {
      high: findings.filter((f) => f.severity === 'high').length,
      medium: findings.filter((f) => f.severity === 'medium').length,
      low: findings.filter((f) => f.severity === 'low').length,
    },
    truncated,
  };
}

/** The destination a finding would move to, or null when there is no obvious one. */
export function relocationTargetFor(finding: Pick<SecurityFinding, 'suggestedPath' | 'name'>): string | null {
  return finding.suggestedPath ? path.join(finding.suggestedPath, finding.name) : null;
}

/* ────────────────────────── moving one somewhere safer ────────────────────────── */

export interface RelocateResult {
  moved: boolean;
  from: string;
  to: string;
}

/**
 * Move a secret into its expected directory.
 *
 * **A rename, and nothing else.** A rename cannot lose data: the file exists at
 * the old path or the new one, never neither. The obvious alternative — copy
 * then delete — would make this the only service outside `cleaner.ts` able to
 * remove a user's file, which would bypass both the Trash guarantee and the
 * open-file guard (a structural rule the suite enforces). So when the
 * destination turns out to be on a different filesystem, this REFUSES and says
 * so rather than quietly falling back to copy-and-delete.
 *
 * It also never clobbers: an occupied destination aborts, because the file
 * already there is probably the key actually in use. The destination directory
 * is created `0700`, since a secrets directory anyone can list is not a safer
 * place.
 */
export async function relocateSecret(from: string, to: string): Promise<RelocateResult> {
  const fsp = await import('fs/promises');
  const src = await fsp.lstat(from);
  if (!src.isFile()) throw new Error('Only a file can be moved to a safer location');

  try {
    await fsp.lstat(to);
    throw new Error(`Something already exists at ${to} — nothing was moved`);
  } catch (err) {
    // ENOENT is the good case: the destination is free.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  await fsp.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      throw new Error(
        `${to} is on a different disk. TreeMap only moves a file when it can do it as a single rename, ` +
        'so nothing can be lost part-way — copy it across yourself and delete the original when you are happy.',
      );
    }
    throw err;
  }
  // Keep the timestamps: a key that suddenly looks brand new is confusing, and
  // some tools care.
  await fsp.utimes(to, src.atime, src.mtime).catch(() => undefined);
  await fsp.chmod(to, 0o600).catch(() => undefined);
  return { moved: true, from, to };
}

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Flag, ScanStore, TreeSource, asStore } from './scanStore';
import { CompiledIgnore, matchesAny } from '../utils/glob';
import { appDataPathRefusal, insideAnyScanRoot, safetyRecordRefusal, spillPathRefusal } from '../middleware/pathGuard';
import { isInside } from '../utils/pathSanitizer';
import { installedProgramOf, programPhrase } from './installedPrograms';

/**
 * securityHygieneScanner — secrets in the wrong place (§C5).
 *
 * This looks at **names and locations only** (plus the size the scan already
 * recorded, for the one extension a Mac shares with Keynote — or, for a hard
 * link's second name, which the scan counts as 0, the file's own size from a
 * metadata read). It never opens a file, never reads a byte of user content, and never sends anything anywhere. A private
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
   * ancestor directory of the file — unless a folder above the file syncs to
   * the cloud or is easy to share (`syncsToCloud`, EXPOSED_FOLDERS), where no
   * folder gives a pass: a key in ~/Dropbox/.ssh or ~/Dropbox/certs leaves the
   * computer, and a downloaded zip may unpack to certs/ or .ssh/ in Downloads
   * (review F1.5, F2.7).
   */
  expectedIn: string[];
  /**
   * Where it should live, shown as the suggested destination. Only an SSH-key
   * pattern names `.ssh`: offering to move anything else there (a certificate,
   * a TLS key, a Keynote presentation) puts a person's file somewhere it does
   * not belong, which is the harm this panel exists to undo.
   */
  suggestedHome?: string;
  /**
   * A file larger than this is not what the pattern means, so it is not a
   * finding. Decided from the scan's own size, never by opening the file.
   */
  maxBytes?: number;
  /**
   * The `why` for one file, from its name alone, where the name says more than
   * the pattern does; `why` where it does not. Never by opening the file.
   */
  whyFor?: (name: string) => string;
  /**
   * The severity for one file, from its name alone, where the name says more than the pattern does;
   * `severity` where it does not. Never by opening the file.
   */
  severityFor?: (name: string) => SecuritySeverity;
}

/**
 * What a .pem holds, as far as its name goes (seventh browser pass J53). A .pem
 * may hold a private key, or only public material — certificates, a CA bundle
 * such as roots.pem or cacert.pem — and TreeMap reads names, never contents.
 * A row once said "PEM files usually hold a private key or a certificate with
 * one" of every public CA bundle. The name's words are matched whole (split at
 * anything not a letter or digit), so monkey.pem suggests no key; a name that
 * suggests both, or neither, gets the sentence true of every .pem.
 */
const PEM_KEY_WORDS = new Set(['key', 'privkey', 'privatekey', 'private', 'priv', 'secret']);
const PEM_CERT_WORDS = new Set(['cert', 'certs', 'certificate', 'certificates', 'cacert', 'cacerts', 'crt', 'ca', 'roots', 'root', 'chain', 'fullchain', 'bundle', 'trust', 'truststore', 'public', 'pub']);
/** A word that ends like a certificate's name: zcacert, DigiCertGlobalRootCA. */
const PEM_CERT_ENDINGS = /(?:cert|certs|rootca)$/;
const PEM_WHY_CERTS =
  'Its name suggests public certificates, such as a certificate authority bundle, which are not secret — but a .pem can hold a ' +
  'private key too, and TreeMap reads names and sizes, never contents, so it cannot be sure.';
const PEM_WHY_KEY =
  'Its name suggests a private key: anyone with a copy can use it wherever it is trusted. TreeMap reads names and sizes, never ' +
  'contents, so the name is all it goes by.';
const PEM_WHY =
  'A .pem file may hold a private key, or only public material such as certificates. TreeMap reads names and sizes, never ' +
  'contents, so it cannot tell which: open it to check — a private key’s block begins with a line naming a PRIVATE KEY.';
/** What a .pem's name suggests it holds: public certificates, a private key, or neither or both ('unknown'). */
function pemSuggests(name: string): 'certs' | 'key' | 'unknown' {
  const words = name.toLowerCase().replace(/\.pem$/, '').split(/[^a-z0-9]+/).filter(Boolean);
  const key = words.some((w) => PEM_KEY_WORDS.has(w));
  const certs = words.some((w) => PEM_CERT_WORDS.has(w) || PEM_CERT_ENDINGS.test(w));
  if (certs && !key) return 'certs';
  if (key && !certs) return 'key';
  return 'unknown';
}
export function pemWhy(name: string): string {
  const suggests = pemSuggests(name);
  return suggests === 'certs' ? PEM_WHY_CERTS : suggests === 'key' ? PEM_WHY_KEY : PEM_WHY;
}
/**
 * A .pem whose name suggests public certificates is minor (eighth browser pass K54): roots.pem, cacert.pem
 * and ca-bundle.pem were badged SERIOUS beside a sentence saying they hold certificates, which are not
 * secret. Still listed, since a .pem can hold a key whatever its name; a name that suggests a key, or
 * says nothing, stays serious.
 */
export function pemSeverity(name: string): SecuritySeverity {
  return pemSuggests(name) === 'certs' ? 'low' : 'high';
}

/**
 * The largest `.key` file that could be a private key. A PEM private key is a
 * few KB (RSA-8192 is about 6.5 KB; an exported PGP secret key with subkeys
 * stays well under this). A Keynote document, which shares the extension on a
 * Mac, is far larger.
 */
const KEY_FILE_MAX_BYTES = 64 * 1024;

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
    why: PEM_WHY,
    whyFor: pemWhy,
    severity: 'high',
    severityFor: pemSeverity,
    extensions: ['pem'],
    // Where certificates and keys are kept on purpose: a folder named certs (ssl/certs among them) or
    // ca-certificates too (eighth browser pass K54: "In “certs”, which is not where this kind of file
    // belongs" was said of a CA bundle in a folder named certs).
    expectedIn: ['.ssh', '.certs', '.config/certs', 'certs', 'ca-certificates'],
    // No suggested home: a .pem is as often a TLS key or a certificate as an
    // SSH key, and ~/.ssh is not where either of those belongs.
  },
  {
    id: 'putty-private-key',
    label: 'PuTTY SSH private key',
    why: 'A PuTTY key file holds an SSH private key: anyone with it can log in as you wherever it is trusted.',
    severity: 'high',
    extensions: ['ppk'],
    expectedIn: ['.ssh', '.putty'],
    suggestedHome: '.ssh',
  },
  {
    id: 'key-file',
    label: 'Key file, or a Keynote presentation',
    why:
      'A .key file is either a private key or, on a Mac, a Keynote presentation. TreeMap reads names and ' +
      'sizes only, never contents, so it cannot tell which: open it to check.',
    // Minor, and never moved: the name alone is as likely a presentation as a
    // key, so calling it serious, or offering to move it into ~/.ssh, would be
    // wrong for most of the files it matches.
    severity: 'low',
    extensions: ['key'],
    expectedIn: ['.ssh', '.certs', '.config/certs'],
    maxBytes: KEY_FILE_MAX_BYTES,
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
/** A folder of one of these names, or a name beginning with one, syncs to the cloud. */
const SYNC_FOLDERS = ['dropbox', 'google drive', 'googledrive', 'onedrive', 'icloud drive', 'iclouddrive', 'box sync', 'mydrive'];
/**
 * Where macOS keeps the folders that sync, as consecutive segments: iCloud Drive and the apps' iCloud
 * folders under Library/Mobile Documents, and every File Provider folder (Box, Google Drive, OneDrive,
 * Dropbox) under Library/CloudStorage — names no path held as SYNC_FOLDERS spells them (review F2.1).
 */
const SYNC_RUNS = [['library', 'mobile documents'], ['library', 'cloudstorage']];

/** Does a folder above the file, given as lowercased segments, sync to the cloud? */
function syncsToCloud(dirs: string[]): boolean {
  return dirs.some((d) => SYNC_FOLDERS.some((s) => d === s || d.startsWith(s))) || SYNC_RUNS.some((want) => hasRun(dirs, want));
}

export interface SecurityFinding {
  patternId: string;
  label: string;
  why: string;
  severity: SecuritySeverity;
  path: string;
  name: string;
  /**
   * The file's own size. A hard link's second name carries 0 in the scan (the
   * file is counted once), so its size is read from the file's metadata; null
   * when that cannot be read — unknown, never a zero (B17).
   */
  size: number | null;
  modifiedAt: number;
  /** Plain-English statement of where it is and why that is a problem. */
  reason: string;
  /** Absolute path this kind of file belongs in, when there is an obvious one. */
  suggestedPath?: string;
  /**
   * Set by GET /api/security/findings beside a `suggestedPath` (fourth browser pass, E10): why
   * POST /api/security/relocate would refuse that move — the folder is outside every scan, the agent
   * policy, something already there — or null when it would make it. The move is offered only on null.
   */
  relocateRefusal?: string | null;
  /** True when the file sits in a folder that is shared or cloud-synced. */
  exposed: boolean;
  /**
   * True when an installed program owns this file. Listed for awareness only:
   * never called serious, and never offered a move.
   */
  appOwned: boolean;
}

export interface SecurityReport {
  /** The most serious findings first, at most MAX_FINDINGS of them, from `offset` on. */
  findings: SecurityFinding[];
  /** Counted over EVERY finding, not only the ones in `findings`. */
  counts: { high: number; medium: number; low: number };
  /** How many findings there are in all; more than `findings.length` once the cap bites. */
  total: number;
  /**
   * How many of `total` are `appOwned` — they sit in folders that installed software or the operating
   * system keeps for itself: a program, its data folders or its packages (review F1.3) — counted over
   * every finding (sixth browser pass H05). The rest are the ones sitting outside the folder they belong in.
   */
  appOwnedCount: number;
  /** True while findings remain after this page, so the UI can say the list is partial and ask for the next. */
  truncated: boolean;
  /** Where this page starts in the whole ordered list (fourth browser pass, E09: every finding is reachable). */
  offset: number;
}

const MAX_FINDINGS = 500;

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

/**
 * A macOS bundle other than an app: frameworks, loadable bundles, extensions,
 * XPC services, plug-ins and kernel extensions. Apple ships public root CA
 * `.pem` files inside Ruby.framework (QA D42). The name before the suffix must
 * not be empty, so Bundler's per-project `.bundle` settings folder is not one.
 */
const BUNDLE_DIR = /^.+\.(?:framework|bundle|appex|xpc|plugin|kext)$/;

/**
 * Top-level folders the operating system itself manages, as the leading
 * lowercased segments of an absolute POSIX path. `/usr/local` is excluded
 * below: it is where a person installs things.
 */
const OS_OWNED_ROOTS = [
  ['system'], ['usr'], ['bin'], ['sbin'], ['lib'], ['lib64'], ['etc'], ['private', 'etc'], ['library', 'apple'],
];

/** True when the file lives in a folder the operating system manages. */
function isOsOwned(filePath: string): boolean {
  const dirs = segments(path.dirname(filePath));
  if (/^[a-z]:$/.test(dirs[0] ?? '')) return dirs[1] === 'windows';
  if (!filePath.startsWith('/')) return false;
  if (dirs[0] === 'usr' && dirs[1] === 'local') return false;
  return OS_OWNED_ROOTS.some((root) => root.every((s, i) => dirs[i] === s));
}

/**
 * True when the file lives inside an installed program's own files. A part of
 * an installed program — a Mac app, a program under Program Files — is the
 * shared detector's answer, the same one the Trash sheets and Autopilot ask
 * (fifth browser pass F01); the places below are the panel's own wider net
 * (a program's data, its packages, its other bundles).
 */
export function isApplicationOwned(filePath: string): boolean {
  if (installedProgramOf(filePath) !== null) return true;
  const dirs = segments(path.dirname(filePath));
  if (dirs.some((d) => APP_OWNED_SEGMENTS.has(d) || BUNDLE_DIR.test(d))) return true;
  return APP_OWNED_RUNS.some((want) => hasRun(dirs, want));
}

/** One of the panel's wider-net places (review F2.2): what the folder is, and its name as spelled. */
interface OwnedPlace {
  kind: 'bundle' | 'packages' | 'programs' | 'data';
  name: string;
}

/**
 * Which of the panel's wider-net places holds a file the shared detector names no program for (review
 * F2.2): the nearest bundle or package folder, else a program data folder. Its row says what that folder
 * is and claims no more — a key a person saved in a tool's data folder is not part of that software.
 */
function ownedPlaceOf(filePath: string): OwnedPlace | null {
  const names = path.dirname(filePath).split(/[\\/]+/).filter(Boolean);
  const dirs = names.map((s) => s.toLowerCase());
  for (let i = dirs.length - 1; i >= 0; i--) {
    if (BUNDLE_DIR.test(dirs[i])) return { kind: 'bundle', name: names[i] };
    if (APP_OWNED_SEGMENTS.has(dirs[i])) return { kind: dirs[i].startsWith('program files') ? 'programs' : 'packages', name: names[i] };
  }
  for (const want of APP_OWNED_RUNS) {
    for (let i = 0; i + want.length <= dirs.length; i++) {
      // Library's runs are named by their second folder (the one inside Library), AppData's by its first.
      if (want.every((w, k) => dirs[i + k] === w)) return { kind: 'data', name: names[want[0] === 'library' ? i + 1 : i] };
    }
  }
  return null;
}

/** The row's reason for a file in one of the wider-net places, `where` being its own folder (review F2.2). */
function ownedPlaceReason(where: string, place: OwnedPlace | null): string {
  const at = (word: string): string => (place && place.name !== where ? `, ${word} “${place.name}”` : '');
  switch (place?.kind) {
    case 'data':
      return `In “${where}”${at('under')}, where programs keep their own data — TreeMap does not offer to move it, since a program may rely on it. If you saved it here yourself, you can move it by hand.`;
    case 'packages':
      return `In “${where}”${at('inside')}, a folder a package manager fills with installed packages — TreeMap does not offer to move it, since a package may rely on it.`;
    case 'bundle':
      return `In “${where}”${at('inside')}, a software bundle — this file is part of that bundle, so moving it could break the software that loads it.`;
    case 'programs':
      return `In “${where}”${at('inside')}, where installed programs live — TreeMap does not offer to move it, since a program may rely on it.`;
    default:
      return `In “${where}”, a folder installed software keeps for itself — TreeMap does not offer to move it, since that software may rely on it.`;
  }
}

/**
 * Is `filePath` inside one of the pattern's expected directories?
 * `expectedIn` entries may be nested (`.config/gcloud`), matched as a
 * consecutive run of ancestor segments — and none counts where a folder above
 * the file syncs to the cloud or is easy to share (`exposed`; review F2.7).
 */
function inExpectedLocation(filePath: string, pattern: SecurityPattern, homeDir: string, exposed: boolean): boolean {
  const dirSegments = segments(path.dirname(filePath));
  if (!exposed && pattern.expectedIn.some((expected) => hasRun(dirSegments, segments(expected)))) return true;
  // A `.netrc` or `.env` in the home directory itself is where it belongs.
  if (pattern.expectedIn.length === 0 && path.dirname(filePath) === homeDir) return true;
  return false;
}

/** A size of null is unknown, so it cannot rule a file out. */
function matchPattern(name: string, size: number | null): SecurityPattern | undefined {
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  return SECURITY_PATTERNS.find((p) => {
    if (p.maxBytes !== undefined && size !== null && size > p.maxBytes) return false;
    if (p.names?.includes(lower)) return true;
    if (ext && p.extensions?.includes(ext)) return true;
    if (p.prefixes?.some((prefix) => lower.startsWith(prefix))) return true;
    return false;
  });
}

/**
 * The size of a file the scan counted under another name: a metadata read
 * (lstat), which opens nothing. null when it cannot be read.
 */
export function linkedFileSize(filePath: string): number | null {
  try {
    const st = fs.lstatSync(filePath);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/**
 * Findings for a completed scan. Reads names, paths and sizes from the scan
 * tree — and, for a hard link's second name the tree counts as 0, that file's
 * size from its metadata (`sizeOfLinkedName`, B17). No file is ever opened.
 *
 * Every match is collected, sorted most serious first, counted, and only then
 * cut to MAX_FINDINGS. Cutting in walk order (QA D77) let 500 Keynote decks
 * walked first push the real keys out of the list, and the counts then
 * described the cut list rather than the disk.
 *
 * `offset` pages through the rest (fourth browser pass, E09: 500 of 801 were
 * shown and the other 301 could not be reached): the same order every time,
 * so the page from `offset` starts where the one before it ended.
 */
export function collectSecurityFindings(
  source: TreeSource,
  ignore: CompiledIgnore[],
  homeDir: string = os.homedir(),
  sizeOfLinkedName: (filePath: string) => number | null = linkedFileSize,
  offset = 0,
): SecurityReport {
  const store = asStore(source);
  const findings: SecurityFinding[] = [];

  const visit = (node: number, nodePath: string): void => {
    for (const child of store.childIds(node)) {
      const name = store.name(child);
      const childPath = store.childPath(child, nodePath);
      if (matchesAny(ignore, childPath, name)) continue;
      if (store.isDir(child)) {
        visit(child, childPath);
        continue;
      }

      // A hard link's second name carries 0 in the tree (the scan counts the
      // file once). The panel describes files, so it reads that file's own
      // size — only for a name that could be a finding at all (B17).
      const linked = store.flag(child, Flag.HardlinkDup);
      if (linked && !matchPattern(name, null)) continue;
      const size = linked ? sizeOfLinkedName(childPath) : store.size(child);
      const pattern = matchPattern(name, size);
      if (!pattern) continue;
      // A public key is not a secret, and flagging it teaches people to ignore
      // the whole panel.
      if (name.toLowerCase().endsWith('.pub')) continue;

      const dirs = segments(path.dirname(childPath));
      const exposedFolder = dirs.find((d) => EXPOSED_FOLDERS.includes(d));
      const syncFolder = syncsToCloud(dirs);
      // Judged with the synced and exposed folders known: no folder inside one gives a pass (review F1.5, F2.7).
      if (inExpectedLocation(childPath, pattern, homeDir, Boolean(syncFolder || exposedFolder))) continue;
      const where = path.basename(path.dirname(childPath)) || path.dirname(childPath);

      // Being inside a synced or shared folder raises the stakes, never lowers
      // them — a medium finding in Dropbox is a high one.
      const named = pattern.severityFor ? pattern.severityFor(name) : pattern.severity;
      const stakes = syncFolder && named === 'medium' ? 'high' : named;
      const osOwned = isOsOwned(childPath);
      const appOwned = osOwned || isApplicationOwned(childPath);
      // The program by name where the shared detector knows it (H05): an app, a program under Program Files.
      const program = appOwned && !osOwned ? installedProgramOf(childPath) : null;

      findings.push({
        patternId: pattern.id,
        label: pattern.label,
        why: pattern.whyFor ? pattern.whyFor(name) : pattern.why,
        // A file that ships with a program is where that program put it, so it
        // is not "in the wrong place" in the sense this panel means. Listed,
        // never called serious.
        severity: appOwned ? 'low' : stakes,
        path: childPath,
        name,
        size,
        modifiedAt: store.modifiedAt(child),
        reason: osOwned
          ? `In “${where}”, a folder the operating system manages — this file is part of the system, so moving it would break whatever uses it.`
          : program !== null && program.kind !== 'package'
          ? `In “${where}”, part of ${programPhrase(program)} — this file ships with that program, so moving it would break it.`
          : appOwned
          ? ownedPlaceReason(where, ownedPlaceOf(childPath))
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
          // The shared containment test: a bare check for a leading ".." read "~/..data" as outside home.
          !appOwned && pattern.suggestedHome && isInside(homeDir, childPath)
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

  const from = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  return {
    findings: findings.slice(from, from + MAX_FINDINGS),
    counts: {
      high: findings.filter((f) => f.severity === 'high').length,
      medium: findings.filter((f) => f.severity === 'medium').length,
      low: findings.filter((f) => f.severity === 'low').length,
    },
    total: findings.length,
    appOwnedCount: findings.filter((f) => f.appOwned).length,
    truncated: findings.length > from + MAX_FINDINGS,
    offset: from,
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
  // Both ends, checked here as well as by the route: a service that renames a user's file does
  // not take its caller's word that the path was judged (git gc re-checks the same way; T17a's
  // security review found a request that reached this with its path unjudged).
  for (const [end, p] of [['source', from], ['destination', to]] as const) {
    if (!insideAnyScanRoot(p)) throw new Error(`The ${end} ${p} is outside every scanned folder, so nothing was moved`);
    const spill = spillPathRefusal(p);
    if (spill) throw new Error(spill.message);
  }
  // Nothing is moved INTO app-data, whose files TreeMap trusts (FG1); moving one out is a delete.
  const appData = appDataPathRefusal(to);
  if (appData) throw new Error(appData.message);
  // Nor is the agent policy or the audit log moved out of it (the final review, F1.11).
  const record = safetyRecordRefusal(from);
  if (record) throw new Error(record.message);
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

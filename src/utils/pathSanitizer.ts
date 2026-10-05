import path from 'path';
import os from 'os';
import fs from 'fs';
import { appDataDir } from '../services/storage';
import { SPILL_DIR } from '../services/spillSweep';
import { meansAbsent } from './errno';

/**
 * Path validation shared by the pathGuard middleware and the services.
 * Throws PathRejectedError for anything suspicious; returns the resolved
 * absolute path otherwise.
 */

export class PathRejectedError extends Error {
  readonly code: string;
  constructor(message: string, code = 'PATH_REJECTED') {
    super(message);
    this.name = 'PathRejectedError';
    this.code = code;
  }
}

/** Virtual / volatile filesystems and OS internals we refuse to touch. */
const UNIX_BLOCKLIST = ['/proc', '/sys', '/dev', '/run', '/private/var/db', '/System/Volumes/VM'];
const WINDOWS_BLOCKLIST = [
  'c:\\windows\\system32',
  'c:\\windows\\syswow64',
  'c:\\windows\\winsxs',
  'c:\\$recycle.bin',
  'c:\\system volume information',
];

/**
 * A path's second names: spellings the operating system answers for a path that are not that
 * path's own (the SEC-1 review, M1).
 *
 * macOS answers three names at the root of the boot volume, for any path on any mounted volume:
 * `/.nofollow/<path>` and `/.resolve/<flags>/<path>` (the path again, looked up under other rules
 * for links) and `/.vol/<device>/<inode>/…` (a file by its device and inode number). realpath gives
 * the first back unchanged and cannot resolve the other two, while lstat, open and rename go
 * through all three — so neither the blocklist nor the scanned-root rule could see where such a
 * spelling lands: `/.nofollow/private/var/db` was not /private/var/db to the blocklist, and after a
 * scan of / that never entered /Volumes, `/.nofollow/Volumes/Backup/f.txt` was "inside" it. Nothing
 * TreeMap offers produces one, and a walk of / lists each of the three as an empty folder. Matched
 * in any case: the boot volume folds it.
 *
 * Windows: the Win32 device namespaces (`\\?\`, `\\.\`) and the NT object namespace (`\??\`) reach
 * a volume by its GUID (`\\?\Volume{…}\`), a raw device (`\\.\PhysicalDrive0`; `\\.\C:` is the
 * volume itself, not its root folder) and the whole object manager (`\\?\GLOBALROOT\…`), none of
 * which the drive-letter blocklist names. Behind `\\?\` or `\\.\` only a drive-letter path (`C:\…`)
 * or a UNC path (`UNC\server\share…`) is a file path; anything else there, and `\??\` always, is a
 * second name.
 *
 * Answers the namespace as spelled (for the refusal's sentence), or null. Pure — no file system
 * call — and `platform` picks the rules, so both platforms' are tested everywhere.
 */
const DARWIN_ALIAS_ROOT = /^\/\.(?:nofollow|resolve|vol)(?=\/|$)/i;
const WIN32_OBJECT_NAMESPACE = /^[\\/]\?\?(?=[\\/])/;
const WIN32_DEVICE_PREFIX = /^[\\/]{2}[?.](?=[\\/])/;
const WIN32_FILE_BEHIND_PREFIX = /^[\\/]{2}[?.][\\/](?:[a-z]:[\\/]|unc[\\/][^\\/]+[\\/][^\\/]+)/i;
/** `\\?\` or `\\.\` in front of a drive letter: the same path as the drive-letter spelling, to the blocklist. */
const WIN32_PREFIX_BEFORE_DRIVE = /^[\\/]{2}[?.][\\/](?=[a-z]:[\\/])/i;

/** A UNC path's host and share, also behind `\\?\UNC\` or `\\.\UNC\`. */
const WIN32_UNC_SHARE = /^[\\/]{2}(?:[?.][\\/]unc[\\/])?([^\\/]+)[\\/]([^\\/]+)(?=[\\/]|$)/i;
/** The shares Windows makes of every drive (`C$`) and of the Windows folder (`ADMIN$`). */
const WIN32_ADMIN_SHARE = /^(?:[a-z]|admin)\$$/i;
/** A host that is always this machine: loopback by name or address. */
const WIN32_LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|::1|\[::1\]|0--1\.ipv6-literal\.net)$/i;
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** This machine's own names and addresses, as a UNC path may name it: asked only of an admin share's host. */
function ownHostNames(): string[] {
  const addresses = Object.values(os.networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.address));
  return [os.hostname(), process.env.COMPUTERNAME ?? '', ...addresses].filter((n) => n.length > 0);
}

/**
 * Whether a UNC host is this machine (the SEC-2 review, LOW-3): loopback, `.`, or one of its own
 * names — compared by the first label, so `mypc.corp.example.com` is `MYPC` — or addresses.
 */
function isThisMachine(host: string, ownHosts: readonly string[] | undefined): boolean {
  const h = host.toLowerCase().replace(/(.)\.$/, '$1'); // a fully qualified name's final dot, never `.` itself
  if (h === '.' || WIN32_LOOPBACK_HOST.test(h)) return true;
  const literal = IPV4_LITERAL.test(h) || h.includes(':');
  return (ownHosts ?? ownHostNames()).some((own) => {
    const o = own.toLowerCase();
    if (literal || IPV4_LITERAL.test(o) || o.includes(':')) return o === h;
    return o.split('.')[0] === h.split('.')[0];
  });
}

export function aliasNamespaceOf(p: string, platform: NodeJS.Platform = process.platform, ownHosts?: readonly string[]): string | null {
  if (platform === 'darwin') return DARWIN_ALIAS_ROOT.exec(p)?.[0] ?? null;
  if (platform !== 'win32' || p.startsWith('cloud://')) return null; // a cloud identifier's colon is its scheme's
  if (WIN32_OBJECT_NAMESPACE.test(p)) return p.slice(0, 4);
  if (WIN32_DEVICE_PREFIX.test(p) && !WIN32_FILE_BEHIND_PREFIX.test(p)) return p.slice(0, 4);
  // This machine's own admin share is its drive (or Windows folder) again: \\localhost\C$\x is C:\x.
  const share = WIN32_UNC_SHARE.exec(p);
  if (share && WIN32_ADMIN_SHARE.test(share[2]) && isThisMachine(share[1], ownHosts)) return share[0];
  // A name with a colon past the root is an NTFS stream of a file or folder, never a path's own
  // name: `System32::$INDEX_ALLOCATION` is the folder itself, `f.txt:x` a stream inside the file.
  const rest = p.slice(path.win32.parse(p).root.length);
  const colon = rest.indexOf(':');
  if (colon !== -1) return rest.slice(colon).split(/[\\/]/)[0];
  return null;
}

/**
 * Win32 strips trailing spaces and dots from every path component inside the
 * OS, so `C:\\Windows\\System32 ` and `C:\\Windows\\System32` are one directory to
 * every file API. This file deliberately stopped trimming the tail — a trailing
 * space is legal filename DATA on POSIX — so the blocklist has to do the
 * normalisation Windows itself would do, or the space walks a blocked path
 * straight past a string comparison. Windows' separator, whatever this OS's is,
 * so Windows' rules are tested on every OS.
 */
function win32Normalize(p: string): string {
  return p
    .toLowerCase()
    .split(path.win32.sep)
    .map((seg) => seg.replace(/[ .]+$/, ''))
    .join(path.win32.sep);
}

function isBlocked(resolved: string, platform: NodeJS.Platform = process.platform, ownHosts?: readonly string[]): boolean {
  // A second name (`aliasNamespaceOf`) lands where no string here can tell: refused wherever it
  // appears — as typed, or where a link in the parents leads.
  if (aliasNamespaceOf(resolved, platform, ownHosts) !== null) return true;
  if (platform === 'win32') {
    const lower = win32Normalize(resolved.replace(WIN32_PREFIX_BEFORE_DRIVE, ''));
    return WINDOWS_BLOCKLIST.some((b) => lower === b || lower.startsWith(b + path.win32.sep));
  }
  return UNIX_BLOCKLIST.some((b) => resolved === b || resolved.startsWith(b + '/'));
}

/** A drive behind `\\?\` or `\\.\` with no separator after it: the volume device itself, as spelled. */
const WIN32_BARE_DRIVE_BEHIND_PREFIX = /^[\\/]{2}[?.][\\/][a-z]:$/i;

/**
 * `p` resolved to an absolute path (`path.resolve`) — except that on Windows a drive's root folder
 * behind `\\?\` or `\\.\` keeps its separator. Resolving drops it (`\\?\C:\` → `\\?\C:`), which
 * spells the volume device, not its root folder, and the sanitizer refused the root of every drive
 * spelled that way (the SEC-2 review, F5). Typed without the separator, it is the device, and stays
 * refused.
 *
 * Resolved by `platform`'s rules when one is named (`path.win32` or `path.posix`), so a test pins
 * Windows' resolution on any OS; with none named, by the path module Node runs with — never by
 * `process.platform`. The answer is what the file system is asked about next, and the tests stand
 * Windows in for process.platform on another OS to reach Windows' rules with this OS's real paths:
 * resolved by Windows' rules there, `/var/folders/…` came back as `\var\folders\…`, which no file
 * system call finds. On a real machine the platform and Node's module are the same.
 */
export function resolveAsTyped(p: string, platform?: NodeJS.Platform): string {
  const paths = platform === undefined ? path : platform === 'win32' ? path.win32 : path.posix;
  const resolved = paths.resolve(p);
  if (paths !== path.win32) return resolved;
  return WIN32_BARE_DRIVE_BEHIND_PREFIX.test(resolved) && WIN32_FILE_BEHIND_PREFIX.test(p) ? `${resolved}${path.win32.sep}` : resolved;
}

/** What `sanitizePath` decides from a path's spelling alone (`judgeSpelling`). */
export interface SpellingVerdict {
  /** The path resolved (`resolveAsTyped`): what `sanitizePath` returns when nothing is refused. */
  resolved: string;
  /** The second name it is spelled through, as typed or once resolved (`aliasNamespaceOf`), and that spelling; or null. */
  secondName: { alias: string; named: string } | null;
  /** Whether the resolved spelling is on the blocklist, read as the platform reads names. */
  blocked: boolean;
}

/**
 * The half of `sanitizePath`'s verdict that needs no file system call: `p` (its `~` already
 * expanded) resolved, a second name it is spelled through, and the blocklist on the resolved
 * spelling. Pure — a `platform` named picks the rules and the resolution, so Windows' are tested on
 * every OS; with none named, the rules are process.platform's and the resolution Node's own
 * (`resolveAsTyped`), as `sanitizePath` needs — and `ownHosts` stands in for this machine's names
 * where a test needs others.
 */
export function judgeSpelling(p: string, platform?: NodeJS.Platform, ownHosts?: readonly string[]): SpellingVerdict {
  const rules = platform ?? process.platform;
  const resolved = resolveAsTyped(p, platform);
  // Asked of the typed path too, since resolving on Windows turns `\??\x` into a folder of the
  // current drive and would hide what was asked for.
  const named = aliasNamespaceOf(p, rules, ownHosts) !== null ? p : resolved;
  const alias = aliasNamespaceOf(named, rules, ownHosts);
  if (alias !== null) return { resolved, secondName: { alias, named }, blocked: true };
  return { resolved, secondName: null, blocked: isBlocked(resolved, rules, ownHosts) };
}

/** Node's realpath.native can hand back a Windows extended-length prefix; the
 *  blocklist is written in ordinary drive-letter form. */
function strip(p: string): string {
  return process.platform === 'win32' && p.startsWith('\\\\?\\') ? p.slice(4) : p;
}

/**
 * Bounded, short-lived memo of directory -> canonical directory.
 *
 * Sizing: entries are two strings, so 512 is a few tens of kB and covers any
 * realistic mix of open scan roots; eviction is oldest-inserted-first (a Map
 * iterates in insertion order), which is enough — the memo exists to collapse
 * ONE batch, not to be a long-lived index.
 *
 * Freshness beats hit rate here, hence the TTL as well as the cap. A cached
 * entry is a claim about the shape of the filesystem, and the filesystem can
 * change underneath it: if /tmp/work is memoised as an ordinary directory and
 * is then replaced by a symlink to /dev, a hit inside the window answers with
 * the stale, unblocked location. Five seconds keeps that window shorter than
 * any human-driven swap while still collapsing a batch, which is processed in
 * a single synchronous tick. Note also which half of the check is cached: the
 * DIRECTORY chain, whose entries are long-lived and mostly OS-owned. A symlink
 * planted as the LEAF — the cheap, obvious attack — is re-lstat'd every time
 * and cannot be hidden by this cache at all.
 */
const CANON_CACHE_MAX = 512;
const CANON_CACHE_TTL_MS = 5_000;
const canonCache = new Map<string, { value: string; at: number }>();

/** Canonical form of a DIRECTORY path, memoised. */
function canonDir(dir: string): string {
  const now = Date.now();
  const hit = canonCache.get(dir);
  if (hit !== undefined && now - hit.at < CANON_CACHE_TTL_MS) return hit.value;

  const value = canonDirUncached(dir);
  canonCache.delete(dir); // re-insert so this entry counts as the newest
  canonCache.set(dir, { value, at: now });
  if (canonCache.size > CANON_CACHE_MAX) {
    const oldest = canonCache.keys().next().value;
    if (oldest !== undefined) canonCache.delete(oldest);
  }
  return value;
}

function canonDirUncached(dir: string, hops = 0): string {
  try {
    return strip(fs.realpathSync.native(dir));
  } catch (err) {
    // A link realpath could not follow is judged where it says it leads, never as a folder here.
    const led = whereLinkLeads(dir, hops);
    if (led !== null) return led;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return dir;
  }
  // ENOENT: climb toward the root looking for a real ancestor to canonicalise,
  // because "/var/db/not-yet.sqlite" must stay blocked even though nothing at
  // that path exists yet. Recursing through canonDir memoises every level of
  // the climb, so a second missing sibling costs nothing.
  const parent = path.dirname(dir);
  if (parent === dir) return dir; // a root that will not resolve: nothing above it
  return path.join(canonDir(parent), path.basename(dir));
}

/**
 * Where the link at `p` says it leads, for a link realpath cannot follow (the SEC-2 review, F3): a
 * target that is missing, a loop, or a target spelled through a second name — realpath fails on a
 * `/.resolve/…` target (EINVAL) and a `/.vol/…` one (ENOENT). Answering those with the link's own
 * spelling made everything beneath the link read as a folder of its own folder: inside a scan, and
 * past the blocklist and the alias test. Its target is read and resolved from the folder the link is
 * in, then judged where that is, link by link. A target spelled through a second name is answered as
 * spelled, so the alias test sees it; past the kernel's own limit of links (a loop) the last target
 * read is the answer — nothing lies beneath a loop, and every call there fails. Null when `p` is not
 * a link.
 */
function whereLinkLeads(p: string, hops: number): string | null {
  const target = linkTargetOf(p);
  if (target === null) return null;
  if (aliasNamespaceOf(target) !== null || hops >= MAX_LINK_HOPS) return target;
  return canonDirUncached(target, hops + 1);
}

/**
 * Whether `p` is itself a link that leads through a second name (`aliasNamespaceOf`): where
 * realpath says it leads, or where its target says when realpath cannot follow it
 * (`whereLinkLeads`). The sanitizer judges a link where it leads and refuses that one; the
 * scanned-root rule asks this so that it agrees (the SEC-2 review, F3) — opening or previewing the
 * link would follow it. One lstat, and a realpath only for a link.
 */
export function linkLeadsThroughSecondName(p: string): boolean {
  let leaf: fs.Stats | undefined;
  try {
    leaf = fs.lstatSync(p, { throwIfNoEntry: false });
  } catch {
    return false; // unreadable: judged by its parents alone, as before
  }
  if (!leaf?.isSymbolicLink()) return false;
  let led: string | null;
  try {
    led = strip(fs.realpathSync.native(p));
  } catch {
    led = whereLinkLeads(p, 0);
  }
  return led !== null && aliasNamespaceOf(led) !== null;
}

/**
 * Resolve every symlink in `resolved`, for the blocklist test only.
 *
 * A textual blocklist asks "does this string start with a forbidden prefix?"
 * when the question that matters is "does this path land in a forbidden
 * directory?". On macOS the two answers disagree out of the box: /var, /etc
 * and /tmp are symlinks into /private, so "/private/var/db" was rejected while
 * "/var/db" — byte-for-byte the same directory — was allowed. The same hole
 * opens anywhere a symlink inside a permitted tree points at a blocked one,
 * which is why this canonicalises the WHOLE path — every intermediate
 * component as well as the last segment.
 *
 * Failure is never an error here. A path the caller is about to create, a
 * directory this process cannot stat, a symlink loop — none of those is a
 * bypass attempt, and turning them into PathRejectedError would break scanning
 * a folder that merely contains an unreadable ancestor. So:
 *
 *  - ENOENT is the one case worth working at, because "/var/db/not-yet.sqlite"
 *    must stay blocked even though the leaf is missing. Walk up to the deepest
 *    ancestor that does exist, canonicalise that, and re-attach the tail.
 *  - EACCES / EPERM / ELOOP / anything else falls back to the textual path,
 *    which is exactly the pre-existing behaviour: no worse than before, and
 *    the textual blocklist test still runs against it.
 *
 * COST — this is not once per request. `guardBodyPathsMax` sanitizes a body
 * with `paths.map(sanitizePath)` over batches capped at 2,000, so "one realpath
 * per sanitize call" means up to 2,000 synchronous syscalls parked on the event
 * loop for a single facts request, where this file used to do pure string work.
 * What the blocklist actually asks about is DIRECTORIES — 2,000 files in one
 * folder share one answer — so the work is split in two:
 *
 *  - the directory part of the path goes through the memo above, which turns a
 *    whole batch in one folder into one realpath;
 *  - the leaf gets an `lstat`, and only a leaf that really is a symlink costs a
 *    realpath of its own. `lstat` is one syscall against realpath's walk of
 *    every component, and — the reason it is not cached — it is always FRESH.
 *    The leaf is where a bypass would be planted, so it is the one question
 *    that must never be answered from memory.
 */
/**
 * macOS firmlinks: the same directory under two names, and realpath collapses
 * neither.
 *
 * Since Catalina the system volume is sealed and the writable Data volume is
 * mounted at /System/Volumes/Data, firmlinked into the root — so /private/var
 * and /System/Volumes/Data/private/var are one directory with one inode, and
 * `realpath(3)` reports each spelling as itself because a firmlink is a mount
 * feature, not a link. The blocklist was reachable by the alias: sanitizePath
 * accepted /System/Volumes/Data/private/var/db, which is exactly the directory
 * holding the local account database.
 *
 * The prefix is a documented, fixed part of the OS layout, so stripping it is
 * complete for the whole tree beneath any aliased directory and costs nothing.
 */
const DATA_VOLUME = '/System/Volumes/Data';
function stripDataVolume(p: string): string {
  if (process.platform !== 'darwin') return p;
  if (p === DATA_VOLUME) return '/';
  return p.startsWith(DATA_VOLUME + '/') ? p.slice(DATA_VOLUME.length) : p;
}

/**
 * Device+inode of every blocked directory that exists, computed once.
 *
 * The backstop behind the string rules. An alias nobody predicted — another
 * mount of the same volume, a bind mount, a firmlink Apple adds next release —
 * still lands on the same inode, and identity is the one test that cannot be
 * spelled around. Gated on a basename match below so the stat is not paid on
 * every path this app ever sees.
 */
let blockedIds: Set<string> | null = null;
function blockedIdentities(): Set<string> {
  if (blockedIds) return blockedIds;
  blockedIds = new Set<string>();
  const list = process.platform === 'win32' ? WINDOWS_BLOCKLIST : UNIX_BLOCKLIST;
  for (const b of list) {
    try {
      const st = fs.statSync(b);
      blockedIds.add(`${st.dev}:${st.ino}`);
    } catch {
      // Not present on this machine, so nothing can alias to it.
    }
  }
  return blockedIds;
}

/** Is `p` the same directory as a blocked one, under any name? */
function isBlockedByIdentity(p: string): boolean {
  // Cheap pre-filter: only a path whose LAST component is named like a blocked
  // directory can be one under a different prefix. Anything deeper inside an
  // aliased tree is already handled by stripDataVolume, which rewrites the
  // whole path rather than just its tail.
  const base = path.basename(p).toLowerCase();
  const list = process.platform === 'win32' ? WINDOWS_BLOCKLIST : UNIX_BLOCKLIST;
  if (!list.some((b) => path.basename(b).toLowerCase() === base)) return false;
  try {
    const st = fs.statSync(p);
    return blockedIdentities().has(`${st.dev}:${st.ino}`);
  } catch {
    return false; // it does not exist, so it is not a blocked directory
  }
}

/**
 * Could some spelling of this path's last component land on the blocklist?
 *
 * True when the path's own parent directory is at or above a blocked entry —
 * `/` is above `/dev`, `/private/var` is above `/private/var/db`. Anywhere
 * else, renaming the leaf cannot produce a blocked path, so its on-disk
 * spelling does not matter and the syscall is skipped.
 */
function parentMayHostBlocked(candidate: string): boolean {
  const parent = path.dirname(candidate);
  const list = process.platform === 'win32' ? WINDOWS_BLOCKLIST : UNIX_BLOCKLIST;
  const sep = process.platform === 'win32' ? path.sep : '/';
  const norm = process.platform === 'win32' ? win32Normalize(parent) : parent;
  const prefix = norm.endsWith(sep) ? norm : norm + sep;
  return list.some((b) => b === norm || b.startsWith(prefix));
}

function canonicalize(resolved: string): string {
  const parent = path.dirname(resolved);
  if (parent === resolved) return canonDir(resolved); // "/" or "C:\" itself

  const candidate = stripDataVolume(path.join(canonDir(parent), path.basename(resolved)));

  let leaf: fs.Stats | undefined;
  try {
    // lstat, not stat: the question is whether this last component is itself a
    // link, and stat would follow it and answer about the target. A missing
    // leaf is not an error (throwIfNoEntry) — its canonical location is still
    // the canonical parent, which is what keeps /var/db/not-yet.sqlite blocked.
    leaf = fs.lstatSync(resolved, { throwIfNoEntry: false });
  } catch {
    // EACCES / ENOTDIR / anything else: fall back to the textual answer, which
    // is what this function did before it could see the filesystem at all.
    return candidate;
  }
  // A symlink is not the only way the caller's spelling of the leaf differs
  // from the kernel's. macOS mounts its boot volume case-insensitive and
  // case-preserving, so `/DEV` is an ordinary directory to `lstat` and `/dev`
  // to everything else; Windows discards a trailing space or dot before any
  // file API sees it. Either way a blocked directory arrives under a name the
  // string comparison does not recognise, which the whole-path realpath this
  // replaced could not miss.
  //
  // Realpathing every leaf would give back the cost the memo exists to save.
  // But the only leaf whose SPELLING can change the verdict is one that could
  // land on the blocklist, and the parent already tells us that: unless the
  // canonical parent sits at or above a blocked directory, no spelling of the
  // last component reaches one. That is a string test, so the extra syscall is
  // paid on `/`, `/private/var` and `C:\\Windows`, and never on the 2,000 files
  // in someone's Downloads folder. A child of a case-variant directory needs
  // nothing here: its own parent goes through canonDir, which realpaths it.
  const mustCheckLeaf = leaf !== undefined && (leaf.isSymbolicLink() || parentMayHostBlocked(candidate));
  if (!mustCheckLeaf) return candidate;

  try {
    const viaLink = stripDataVolume(strip(fs.realpathSync.native(resolved)));
    // The more restrictive answer wins. Returning the link's target outright
    // would let a symlink sitting INSIDE a blocked tree, but pointing out of
    // it, carry its own path back out as unblocked — the candidate already
    // says where the link lives, and that is the fact the blocklist is about.
    return isBlocked(candidate) ? candidate : viaLink;
  } catch {
    // realpath could not follow the link — its target is missing, it loops, or the target is
    // spelled through a second name realpath cannot resolve (/.resolve, /.vol): it is judged where
    // its target says it leads (`whereLinkLeads`, the SEC-2 review, F3), the more restrictive answer
    // winning as above. Anything else realpath refused keeps the canonical parent plus its own name.
    const led = leaf?.isSymbolicLink() ? whereLinkLeads(resolved, 0) : null;
    if (led === null) return candidate;
    return isBlocked(candidate) ? candidate : stripDataVolume(led);
  }
}

/**
 * Validate and normalize a user-supplied path.
 * - rejects non-strings, empty strings and null bytes
 * - strips LEADING whitespace only (see below)
 * - expands a leading "~" to the home directory
 * - resolves to an absolute path (eliminating ../ traversal segments)
 * - rejects blocked system directories, judged on the CANONICAL path (symlinks
 *   resolved) so that /var/db and /private/var/db get the same answer
 */
export function sanitizePath(input: unknown): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new PathRejectedError('Path must be a non-empty string', 'PATH_INVALID');
  }
  if (input.includes('\0')) {
    throw new PathRejectedError('Path contains a null byte', 'PATH_INVALID');
  }

  // Leading whitespace is noise; TRAILING whitespace is part of the name.
  //
  // Nothing can precede an absolute path or a "~", so a leading run is always
  // copy-paste debris and comes off. At the other end a space is a legal
  // filename byte on macOS and Linux, `path.resolve` preserves it deliberately,
  // and every lookup in this app is exact string equality — so trimming
  // "~/Downloads/Screenshots " does not find a folder that is close enough, it
  // finds nothing, and the route 404s on a directory the treemap is drawing.
  // (This used to be harmless only by accident: the trimmed value was assigned
  // to req.query[name], which express 5 discards. Making the guard rewrite the
  // URL made the trim real.) Emptiness is still judged with a full trim, so a
  // whitespace-only value never reaches path.resolve — which would answer with
  // the process's cwd. Note that both operations cover the same character set:
  // JavaScript's \s and String.prototype.trim agree, U+00A0 and U+FEFF
  // included, and those two arrive routinely in names pasted from a web page.
  const trimmed = input.replace(/^\s+/, '');

  // Cloud-scan paths (cloud://provider/...) are pure identifiers: they never
  // reach the filesystem, so they skip resolution — but not validation. They
  // are matched on the leading-trimmed string for the same reason as above:
  // otherwise " cloud://gdrive/x" misses this branch and gets resolved into a
  // nonsense path under the cwd. The trailing end is left alone here too — a
  // cloud identifier ends in a remote file's name, which is no more ours to
  // rewrite than a local one.
  if (trimmed.startsWith('cloud://')) {
    if (!/^cloud:\/\/[a-z]+(\/[^\0]*)?$/.test(trimmed) || trimmed.includes('..')) {
      throw new PathRejectedError('Malformed cloud path', 'PATH_INVALID');
    }
    return trimmed;
  }

  let p = trimmed;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(1));
  }

  // A second name (`aliasNamespaceOf`) first, and before any file system call: nothing below can
  // say where one lands (`judgeSpelling`).
  const { resolved, secondName, blocked } = judgeSpelling(p);
  if (secondName !== null) {
    throw new PathRejectedError(
      `"${secondName.named}" names a path through ${secondName.alias}, a second name the system gives it. TreeMap acts on a path only by its own name.`,
      'PATH_BLOCKED',
    );
  }
  // Test the canonical form, return the caller's. Returning the canonical path
  // would quietly rewrite what the rest of the app scans and displays (/tmp/x
  // would surface as /private/tmp/x in the UI, in scan roots, in saved
  // snapshots), which is a visible change nobody asked for; the blocklist only
  // needs to KNOW where the path lands, not to relabel it. Returning `resolved`
  // also keeps the function idempotent — path.resolve of an absolute path is
  // itself, and re-canonicalising the same string reaches the same verdict —
  // which matters because paths are sanitized twice on most requests (pathGuard
  // middleware, then again inside the service).
  const canonical = canonicalize(resolved);
  if (blocked || (canonical !== resolved && isBlocked(canonical)) || isBlockedByIdentity(resolved)) {
    throw new PathRejectedError(`Scanning "${resolved}" is not allowed`, 'PATH_BLOCKED');
  }
  return resolved;
}

/**
 * Where a path LIVES: every symlink in its parent chain resolved, the last
 * component left exactly as spelled.
 *
 * This is the form the scan-root guard compares, and the two halves of the
 * rule are both deliberate. Resolving the parents is what stops
 * `root/esc/victim.txt` (esc -> somewhere outside the root) walking past a
 * textual `path.relative` test — the scanner never followed that link, so the
 * file was never in the map. Leaving the leaf alone is what keeps the link
 * ITSELF trashable: `root/esc` lives in the root whatever it points at, and
 * removing a symlink removes the link, never the target. The same resolution
 * on the root makes an alias spelling of a scanned file (/tmp/x vs
 * /private/tmp/x on macOS) the same file rather than "outside every scanned
 * root". The Data-volume firmlink prefix is stripped too, because realpath
 * collapses neither spelling of that one.
 *
 * Cost and freshness are those of `canonDir`'s memo: a batch of paths in one
 * folder is one realpath, and a directory swapped for a symlink is seen within
 * five seconds — the window the blocklist already accepts.
 */
export function canonicalDirOf(p: string): string {
  return stripDataVolume(livesAt(p));
}

/**
 * `canonicalDirOf` with the Data volume's prefix left as it is: every link in the parents
 * resolved, the last name as spelled. For the scanned-root rule, which takes the prefix off
 * only where the firmlinks make the rest the root's own folder (the SEC-1 review, L1): under
 * /System/Volumes/Data, /Users is /Users, but /usr/bin is not /usr/bin.
 */
export function livesAt(p: string): string {
  const parent = path.dirname(p);
  if (parent === p) return canonDir(p); // "/" or "C:\" itself
  return path.join(canonDir(parent), path.basename(p));
}

/**
 * Where `p` is on the disk: every link resolved and each name as the volume stores it — the native
 * realpath, so `proj/FOO.TXT` answers `…/Proj/Foo.txt` on a volume that folds case (on macOS and
 * Windows; Linux's keeps each name as typed) — on the Data volume's short spelling. Not memoised,
 * unlike `canonDir`: it decides what one delete takes (FG3c). Null when nothing is there
 * (`meansAbsent`); a look that fails for another reason (a folder above it cannot be looked into,
 * an I/O error) throws, since it says nothing either way (FG3d #10).
 */
export async function realPlaceOf(p: string): Promise<string | null> {
  try {
    return stripDataVolume(strip(await realpathNative(p)));
  } catch (err) {
    if (meansAbsent(err)) return null;
    throw err;
  }
}
const realpathNative = (p: string): Promise<string> =>
  new Promise((resolve, reject) => fs.realpath.native(p, (err, out) => (err ? reject(err) : resolve(out))));

/**
 * True when `child` is `parent` itself or located anywhere beneath it. Only
 * `..` itself leaves: a name that merely begins with two dots (`..data`, as
 * Kubernetes mounts a ConfigMap; `...`) is a name inside the folder (the U-25
 * security review, F6), and refusing it only ever refused a file a scan listed.
 */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * A whole path as a case-insensitive volume compares it, for the Autopilot prefilter
 * (`spillCandidateTest`): lower-cased, and on Windows with each name's trailing dots and spaces
 * dropped as Win32 drops them (`win32Normalize`). The rules themselves compare name by name
 * (`foldName`), which folds more than case.
 */
function foldForCompare(p: string): string {
  return process.platform === 'win32' ? win32Normalize(p) : p.toLowerCase();
}

/**
 * A name as a file system may read it: the compatibility forms folded (NFKC: `ſ`, U+017F, is `s`
 * to default APFS, as to any volume that folds case by Unicode's tables), then case. On Windows the
 * case fold is NTFS's own, upper then lower, so `ı` (U+0131), which NTFS upcases to `I` and NFKC
 * and lower case leave alone, is `i`; and a trailing run of dots and spaces goes, as Win32 drops it.
 * It folds some names no file system folds (the fullwidth letters, `ß` as `ss` on Windows), which
 * only refuses more. Asked of ONE name, never a whole path: NFKC makes `／` a separator and `．．` a
 * `..`.
 */
export function foldName(name: string, platform: NodeJS.Platform = process.platform): string {
  const compatible = name.normalize('NFKC');
  if (platform !== 'win32') return compatible.toLowerCase();
  return compatible.toUpperCase().toLowerCase().replace(/[ .]+$/, '');
}

/** Whether a folder name is the spill folder's as a file system may read it (`foldName`). */
export function isSpillFolderName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  return foldName(name, platform) === SPILL_DIR;
}

/** A path's names, its root first: `/`, `C:\`, or `\\server\share\`. */
function namesOf(p: string): string[] {
  const { root } = path.parse(p);
  return [root, ...p.slice(root.length).split(path.sep).filter((name) => name.length > 0)];
}

/** App-data where it really is (every link resolved; a part not made yet as spelled), and its names folded. */
let appDataMemo: { at: string; folded: string[] } | null = null;
function appDataNames(): { at: string; folded: string[] } {
  const at = stripDataVolume(canonDir(appDataDir()));
  if (appDataMemo?.at !== at) appDataMemo = { at, folded: namesOf(at).map((name) => foldName(name)) };
  return appDataMemo;
}

/**
 * Where `p` lies in app-data: the names below it (none for app-data itself), or null when it is
 * not app-data nor in it. Judged on where the path lives (`canonicalDirOf`: every link in its
 * parents resolved, `..` and repeated separators gone, its last name and any part not made yet as
 * spelled), name by name against app-data where it really is, each name read as a file system reads
 * it (`foldName`) — so another case, `ſ` for `s`, NTFS's `ı`, a link in the parents, all land in
 * app-data, before a folder is made as well as after. A path whose last name is app-data's own
 * entry under a name no fold explains (an 8.3 short name on Windows) is asked by identity when it
 * exists (lstat, so a link there stays a link).
 */
function namesBelowAppData(p: string): { where: string; appData: string; below: string[] } | null {
  const { at, folded } = appDataNames();
  const where = canonicalDirOf(p);
  const names = namesOf(where);
  if (names.length < folded.length) return null;
  const own = folded.length - 1;
  for (let i = 0; i < own; i++) if (foldName(names[i]) !== folded[i]) return null;
  if (foldName(names[own]) === folded[own]) return { where, appData: at, below: names.slice(folded.length) };
  return names.length === folded.length && sameEntry(where, at) ? { where, appData: at, below: [] } : null;
}

/**
 * Is `p` TreeMap's own spill folder, `<appData>/` + `SPILL_DIR`, or anything under it (Phase 4
 * §S.5.3)? It holds the working files of very large scans, so no request may name a path
 * there to trash, open, move or write, and the Empty Folders view never offers it.
 *
 * A path in app-data (`namesBelowAppData`: any spelling of app-data, links in the parents
 * resolved) whose first name below it is the folder's as a file system reads names
 * (`isSpillFolderName`) — so `x/../`, another case, `ſ` for `s`, Windows' trailing dots and spaces
 * and NTFS's `ı` are the folder, and a look-alike is refused by its name before the folder exists,
 * when making the path would make the folder. A link whose own path is elsewhere is not the folder
 * (the scanned-root rule's reading): trashing it removes the link, never what it leads to, and
 * opening it follows it as opening any link in a scanned root does.
 */
export function isSpillPath(p: string): boolean {
  if (p.startsWith('cloud://')) return false;
  const at = namesBelowAppData(p);
  if (at === null || at.below.length === 0) return false; // not in app-data, or app-data itself
  if (isSpillFolderName(at.below[0])) return true;
  // A name no fold explains may still be the folder's: an 8.3 short name on Windows. Directly in
  // app-data, it is asked by identity when it exists (lstat, so a link there stays a link).
  return at.below.length === 1 && sameEntry(at.where, path.join(at.appData, SPILL_DIR));
}

/** Links a destination is followed through before it is refused as a doubt; the kernel's own limit is about as long. */
const MAX_LINK_HOPS = 40;

/**
 * Is `p` TreeMap's own app-data folder or anything in it, as a place something would be WRITTEN
 * (FG1)? App-data holds the files TreeMap trusts: its settings, the Autopilot policies and their
 * approval, the offload manifest, the Time Capsule, the spill folder. So no request may make one
 * of its files — as a relocation's destination, an offload's or any copy it plans, a snapshot
 * restore's, an encode's — whatever the file is called and before it exists.
 *
 * Every spelling `namesBelowAppData` knows, and one more that only a write has: a write to a link
 * goes where the link leads, so a path that is a link is judged by its target as well — followed
 * link by link, a missing target included, and a chain longer than the kernel would follow is
 * refused rather than guessed. Reading app-data and deleting in it are not asked here.
 */
export function isAppDataPath(p: string): boolean {
  if (p.startsWith('cloud://')) return false;
  let current = p;
  for (let hop = 0; hop <= MAX_LINK_HOPS; hop++) {
    if (namesBelowAppData(current) !== null) return true;
    const next = linkTargetOf(current);
    if (next === null) return false;
    current = next;
  }
  return true; // a loop, or a chain no system follows: doubt refuses
}

/** Where the link at `p` leads (resolved from the folder the link really is in), or null when `p` is not a link. */
function linkTargetOf(p: string): string | null {
  try {
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (st === undefined || !st.isSymbolicLink()) return null;
    return path.resolve(canonDir(path.dirname(p)), fs.readlinkSync(p));
  } catch {
    return null; // unreadable: judged as spelled
  }
}

/**
 * Whether `p` lies strictly inside `folder`, both where they really are: every link in the folder
 * resolved, and every link in p resolved too — its own last name included, when it exists — so a
 * link inside the folder that leads out of it is outside, and so is `folder/..`; either path not
 * text, or not absolute, is not inside anything. Names are compared as the resolved paths spell them, never
 * folded: this answers what may be opened, and a fold could only let more through.
 */
export function liesInside(folder: unknown, p: unknown): boolean {
  if (typeof folder !== 'string' || typeof p !== 'string') return false; // a record that is not text names no place
  if (!path.isAbsolute(folder) || !path.isAbsolute(p)) return false; // a relative one would be read from the working folder
  const root = stripDataVolume(canonDir(folder));
  let where: string;
  try {
    where = stripDataVolume(strip(fs.realpathSync.native(p)));
  } catch {
    where = canonicalDirOf(p);
  }
  return where !== root && isInside(root, where);
}

/** Whether two paths name one existing entry: the same device and id, links not followed. */
function sameEntry(a: string, b: string): boolean {
  try {
    const first = fs.lstatSync(a, { bigint: true, throwIfNoEntry: false });
    if (first === undefined) return false;
    const second = fs.lstatSync(b, { bigint: true, throwIfNoEntry: false });
    return second !== undefined && first.dev === second.dev && first.ino === second.ino;
  } catch {
    return false; // unreadable: judged by its name alone
  }
}

/**
 * A cheap test over the paths a scan of `root` lists (the root joined with the names it found):
 * false for every path that cannot be in the spill folder, true for one that may be, which
 * `isSpillPath` must still judge. Made once per run from where the two folders really are —
 * every link resolved, the last name included, so app-data reached through a link of its own
 * (moved to a bigger volume) is found where it is — then string work per path, because the full
 * check resolves each path's folders (tens of microseconds a path).
 *
 * On any doubt it passes every path on: a policy folder that is not an absolute path, either
 * folder not resolved, the two on different volumes (a mount, a junction or a firmlink can join
 * them where the strings do not). A doubt costs time, never a verdict.
 */
export function spillCandidateTest(root: string): (p: string) => boolean {
  if (!path.isAbsolute(root)) return () => true; // doubt: not a path a scan starts from
  let appData: string;
  let scanned: string;
  try {
    const appDataAt = realLocationOf(appDataDir());
    const rootAt = realLocationOf(root);
    if (fs.statSync(appDataAt, { bigint: true }).dev !== fs.statSync(rootAt, { bigint: true }).dev) return () => true; // doubt: two volumes
    appData = foldForCompare(appDataAt);
    scanned = foldForCompare(rootAt);
  } catch {
    return () => true; // doubt: a folder that could not be resolved
  }
  if (isInside(appData, scanned)) return () => true; // the scan lies in app-data
  if (!isInside(scanned, appData)) return () => false; // app-data lies outside the scan
  // App-data as the scan spells it: the scan's own root, then app-data's place below it.
  const listed = path.join(foldForCompare(root), path.relative(scanned, appData));
  return (p) => isInside(listed, foldForCompare(p));
}

/** Where a folder really is: every link resolved, its last name included, asked afresh (no memo). */
function realLocationOf(p: string): string {
  return stripDataVolume(strip(fs.realpathSync.native(p)));
}


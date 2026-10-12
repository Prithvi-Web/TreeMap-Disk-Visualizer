import fs from 'fs';
import path from 'path';
import { Request, Response, NextFunction } from 'express';
import { sanitizePath, sanitizePathToRead, isInside, livesAt, rootLivesAt, isSpillPath, isAppDataPath, foldName, aliasNamespaceOf, linkLeadsThroughSecondName, takesSafetyRecord } from '../utils/pathSanitizer';
import { SPILL_DIR } from '../services/spillSweep';
import { allScans } from '../services/diskScanner';
import { DATA_VOLUME, exclusionsBelow, isAtOrUnder, parseFirmlinks } from '../utils/mountBoundaries';
import type { ScanResult } from '../models/types';
import { isVirtualPath } from '../services/containerScanner';
import { AppError } from './errorHandler';

/**
 * pathGuard — validates every user-supplied path before it reaches a route.
 *
 * Two flavors:
 *  - `guardBodyPaths` / `guardQueryPath`: sanitize (resolve, de-traverse,
 *    blocklist) and rewrite the value in place so handlers only ever see
 *    clean absolute paths.
 *  - `requireInsideScanRoot`: for destructive/OS-touching endpoints — the
 *    path must additionally live inside the root of a scan this server
 *    actually performed. The server never trashes or opens anything it
 *    hasn't been pointed at first.
 */

/** Sanitize req.body.path (single path field). */
export function guardBodyPath(req: Request, _res: Response, next: NextFunction): void {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || body.path === undefined) {
    next(new AppError(400, 'PATH_REQUIRED', 'Request body must include "path"'));
    return;
  }
  body.path = sanitizePath(body.path); // throws PathRejectedError -> errorHandler
  next();
}

/**
 * The default batch cap for `paths` bodies.
 *
 * Every destructive route uses this. It is deliberately small: these bodies
 * become filesystem operations, and a person confirming "move 500 things to
 * the Trash" is still reviewing a list they could in principle read.
 */
export const DEFAULT_MAX_BODY_PATHS = 500;

/**
 * Sanitize req.body.paths (array of paths), capping the batch at `max`.
 *
 * Read-only routes may raise the cap — the v4 fact sidecar (§4.1) allows
 * 2,000, because it answers questions about paths rather than acting on them
 * and a treemap view can legitimately need facts for a whole screenful at
 * once. The cap is a parameter rather than a global so that raising it for a
 * read-only route cannot silently raise it for a destructive one.
 */
export function guardBodyPathsMax(max: number) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const paths = cappedBodyPaths(req, max);
    if (paths instanceof AppError) {
      next(paths);
      return;
    }
    (req.body as Record<string, unknown>).paths = paths.map((p) => sanitizePath(p));
    next();
  };
}

/** req.body.paths when it is a non-empty list of at most `max`; otherwise the refusal. */
function cappedBodyPaths(req: Request, max: number): unknown[] | AppError {
  const paths = (req.body as Record<string, unknown> | undefined)?.paths;
  if (!Array.isArray(paths) || paths.length === 0) return new AppError(400, 'PATHS_REQUIRED', 'Request body must include a non-empty "paths" array');
  if (paths.length > max) return new AppError(400, 'TOO_MANY_PATHS', `At most ${max} paths per request`);
  return paths;
}

/** Sanitize req.body.paths (array of paths), capped at 500. */
export const guardBodyPaths = guardBodyPathsMax(DEFAULT_MAX_BODY_PATHS);

/** The paths of a read-only request that the sanitizer refused only for where they lead (`guardBodyPathsToRead`). */
const unanswerable = new WeakMap<Request, ReadonlySet<string>>();

/**
 * `guardBodyPathsMax` for a route that only reads (POST /api/facts). A path the sanitizer refuses
 * only for where it LEADS (`sanitizePathToRead`) — a link the scan listed as itself, to /dev, /.vol
 * or /.resolve — is kept as spelled, resolved, and named in `unanswerablePaths` for the route to
 * skip: one planted link cost a folder's whole batch its answers (the SEC-3 brief, item 3). A path
 * refused by its own spelling still refuses the batch, and the routes that act on paths keep
 * `guardBodyPaths`, which refuses either kind (AGENTS.md).
 */
export function guardBodyPathsToRead(max: number) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const paths = cappedBodyPaths(req, max);
    if (paths instanceof AppError) {
      next(paths);
      return;
    }
    const refused = new Set<string>();
    (req.body as Record<string, unknown>).paths = paths.map((p) => {
      const judged = sanitizePathToRead(p); // throws PathRejectedError -> errorHandler, as sanitizePath does
      if (!judged.answerable) refused.add(judged.path);
      return judged.path;
    });
    unanswerable.set(req, refused);
    next();
  };
}

/** The paths `guardBodyPathsToRead` kept that have no answer: refused only for where they lead. */
export function unanswerablePaths(req: Request): ReadonlySet<string> {
  return unanswerable.get(req) ?? new Set();
}

/**
 * Decode one query-string component the way express's default ("simple")
 * query parser does: `+` is a space, `%XX` is a byte, and a malformed escape
 * is left standing rather than throwing (querystring.parse never throws).
 * Used only to match a raw key against a guarded parameter name.
 */
function decodeQueryComponent(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/**
 * Rewrite `req.url`'s query string so the sanitized values actually stick.
 *
 * express@5 keeps no query object on the request: `req.query` is a getter that
 * re-parses `req.url` on every single access and hands back a brand-new object
 * (express/lib/request.js). Assigning `req.query[name] = clean` therefore
 * mutates a throwaway and every handler downstream still reads the RAW value —
 * which is how one trailing slash on `?path=/…/Media/` reached findByPath
 * un-trimmed and 404'd a subtree that plainly existed. Editing the request's
 * own query string is the one change the getter cannot discard: it re-parses to
 * the clean value from here on, for every reader, without a single handler
 * having to know about any of this.
 *
 * Everything the guard does not own is copied through byte for byte — same
 * parameters, same order, same encoding — because a middleware that owns
 * `path` has no business re-spelling anyone else's parameter.
 */
function rewriteQueryValues(req: Request, cleaned: Map<string, string>): void {
  if (cleaned.size === 0) return;

  const qAt = req.url.indexOf('?');
  // No query string means nothing was read out of one either; inventing one
  // here could only differ from what the getter already returned.
  if (qAt === -1) return;

  const head = req.url.slice(0, qAt);
  let search = req.url.slice(qAt + 1);
  // A '#' in the request target starts a fragment: express parses the query
  // only up to it, so the tail has to be carried across untouched rather than
  // swallowed into (or dropped from) the rebuilt query string.
  let fragment = '';
  const hashAt = search.indexOf('#');
  if (hashAt !== -1) {
    fragment = search.slice(hashAt);
    search = search.slice(0, hashAt);
  }

  const rewritten = new Set<string>();
  const pairs = search.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const name = decodeQueryComponent(rawKey);
    const clean = cleaned.get(name);
    if (clean === undefined) return pair; // not ours — pass the raw bytes through
    rewritten.add(name);
    // encodeURIComponent escapes '?', '#', '&', '=', '%' and '+', so a path
    // containing any of them survives the round trip back through the parser.
    return `${rawKey}=${encodeURIComponent(clean)}`;
  });
  // A value the parser produced from something we could not find in the raw
  // string still has to reach handlers cleaned, so append it rather than
  // silently leaving the raw spelling in force.
  for (const [name, clean] of cleaned) {
    if (!rewritten.has(name)) pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(clean)}`);
  }

  req.url = `${head}?${pairs.join('&')}${fragment}`;
}

/** Sanitize an optional ?path= / ?root= query parameter. */
export function guardQueryPath(...params: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const cleaned = new Map<string, string>();
    for (const name of params) {
      const value = req.query[name];
      if (value === undefined) continue;
      // throws PathRejectedError -> errorHandler; a repeated parameter arrives
      // as an array and is rejected here, exactly as it always was.
      cleaned.set(name, sanitizePath(value));
    }
    rewriteQueryValues(req, cleaned);
    next();
  };
}

/**
 * Is `p` inside the root of any scan this server has run (and not evicted)?
 *
 * Judged on where the path LIVES (`placeOf`: parents resolved, leaf as
 * spelled), on both sides. A textual test let a symlink inside a root reach any
 * file on the disk — the scanner never follows links, so nothing beyond one was
 * ever scanned — and refused the same file under an alias spelling. This is the
 * one gate for every destructive and OS-touching route AND the MCP tools, so it
 * is the one place the rule lives.
 *
 * And a scan grants only what it LISTED (Track U, U-25, U-D19): a path at or
 * beneath a folder it never descended into — a fixed never-descend folder
 * below its root (/Volumes after a scan of /), or a drive mounted inside that
 * it did not enter under "Stay on this drive" — is outside that scan, unless
 * another scan covers it. The prefix test alone let a delete, an offload or an
 * open reach files on a drive the scan never saw.
 */
export function insideAnyScanRoot(p: string): boolean {
  if (p.startsWith('cloud://')) return false; // never on this filesystem
  const where = whereUnlessSecondName(p);
  return where !== null && allScans().some((scan) => listedBy(scan, p, where));
}

/**
 * Where `p` lives (`placeOf`), or null when it is spelled through a second name the system
 * gives a path (`aliasNamespaceOf`: macOS's /.nofollow, /.resolve and /.vol; Windows' device
 * namespaces) — as given, or where a link in its parents leads. No scan lists through one, and
 * realpath cannot say where one lands, so it is outside every scan: here, on its own, whether or
 * not the sanitizer ran first (the SEC-1 review, M1).
 */
function whereUnlessSecondName(p: string): string | null {
  // As typed first: on Windows realpath may re-spell a volume's GUID name with its drive letter.
  if (aliasNamespaceOf(p) !== null) return null;
  const where = placeOf(p);
  if (aliasNamespaceOf(where) !== null) return null;
  // A link that itself leads through one: the sanitizer refuses it, and so does this rule (the
  // SEC-2 review, F3). A link in the parents that realpath cannot follow is judged where its target
  // says it leads, inside placeOf (pathSanitizer's whereLinkLeads).
  return linkLeadsThroughSecondName(p) ? null : where;
}

/**
 * Where a path lives, as the scanned-root rule compares it: every link in its parents resolved,
 * the last name as spelled (`livesAt`), and — on macOS — the Data volume's prefix taken off only
 * where the rest lies in a firmlinked folder (the SEC-1 review, L1). /System/Volumes/Data/Users
 * and /Users are one folder; /System/Volumes/Data/usr/bin and /usr/bin are two, as are
 * /System/Volumes/Data itself and /. Taking the prefix off everywhere made the Data volume's own
 * folders, which a scan of / never lists (they lie under /System/Volumes), read as the root's
 * folders of the same names, which it does.
 */
function placeOf(p: string): string {
  return placeFrom(livesAt(p));
}

/**
 * Where a scan's root lives, as `placeOf` reads a path: from `rootLivesAt`, so a root typed with its
 * last name in another case is the folder it names — /System/Volumes/data is the Data volume (the
 * SEC-2b review, F1.3, F1.5).
 */
function rootPlaceOf(root: string): string {
  return placeFrom(rootLivesAt(root));
}

/**
 * `where` (`placeOf` of `p`), or the scan's `root` itself when `p` names the root's own folder by
 * another spelling of its last name. A path keeps its last name as typed, while a root that is a
 * folder has the volume's own (`rootPlaceOf`), so on a volume that folds case the root a scan named
 * `PROJECTS` was outside it by that name, the files in it inside (the SEC-2c review, F2.3). Asked of
 * the file system only for a path beside the root, and judged as the root is (`rootPlaceOf`): a
 * folder by the name the volume stores, a link as itself — so a link beside the root that leads to
 * it is not the root, and on a volume that keeps case another folder is another folder.
 */
function asTheRoot(p: string, where: string, root: string): string {
  if (where === root || path.dirname(where) !== path.dirname(root)) return where;
  return rootPlaceOf(p) === root ? root : where;
}

/** `placeOf` from where the path lives: the Data volume's prefix off where the firmlinks show the rest. */
function placeFrom(at: string): string {
  if (!onDataVolume(at)) return at;
  const rest = at === DATA_VOLUME ? '/' : at.slice(DATA_VOLUME.length);
  return underFirmlink(rest) ? rest : at;
}

/** Whether `p` is spelled under macOS's Data volume, /System/Volumes/Data. */
function onDataVolume(p: string): boolean {
  return process.platform === 'darwin' && isAtOrUnder(DATA_VOLUME, p);
}

/** Whether `p`, as the root spells it, lies in a folder the firmlinks show from the Data volume. */
function underFirmlink(p: string): boolean {
  return dataVolumeFolderList().some((f) => isInside(f, p));
}

/**
 * `where` (`placeOf` of a path) as a scan rooted at `root` (`placeOf` of its root) listed it, or
 * null when that scan cannot have listed it. A root in the root's spelling compares as it is. A
 * root on the Data volume listed Data volume spellings: a path the root spells reaches that volume
 * only through a firmlink, and a scan of the volume itself covers only what the root shows of it —
 * never the sealed system volume nor another volume (the U-25 security review, F2) — while one
 * rooted in a folder only that volume has (no firmlink shows it) listed that folder's paths.
 */
function asListedFrom(root: string, where: string): string | null {
  if (!onDataVolume(root)) return where;
  if (!onDataVolume(where)) return underFirmlink(where) ? DATA_VOLUME + where : null;
  return root === DATA_VOLUME ? null : where;
}

/**
 * Is `p` under the root of any scan this server has run — whether or not that
 * scan listed it? The read-only rule (`requireInsideScanRootToRead`): a path
 * here that no scan listed is a question the facts route answers by skipping
 * it, not by refusing the batch it rides in.
 *
 * Under the root as that scan spelled it (`asListedFrom`), or else as the
 * path is spelled. `asListedFrom` answers "not listed" for the Data volume's
 * own folders after a scan of the volume itself (/System/Volumes/Data/usr,
 * …/.Spotlight-V100), and that is the listing rule's answer, not this one's:
 * they lie under its root, so they are skipped, and one of them no longer
 * costs the Grid a whole batch's badges (the SEC-2 review, MEDIUM-2). Its
 * other "not listed" — a path on the sealed system volume or another volume,
 * after a scan rooted on the Data volume — is spelled outside that root, so
 * it stays under none.
 *
 * `asItself`, for a path the route skips because the sanitizer refused it
 * only for where it leads (`unanswerablePaths`): judged where it lives itself
 * (`placeOf`) — a link a scan listed as itself — since the only question left
 * is whether it lies under a scanned root at all (the SEC-3 brief, item 3).
 */
function underAnyScanRoot(p: string, asItself = false): boolean {
  if (p.startsWith('cloud://')) return false;
  const where = asItself ? placeOf(p) : whereUnlessSecondName(p);
  return where !== null && allScans().some((scan) => {
    const root = rootPlaceOf(scan.rootPath);
    const at = asTheRoot(p, where, root);
    return isInside(root, asListedFrom(root, at) ?? at);
  });
}

/**
 * A path's names, its root first, as a file system may fold them: `foldName`,
 * then upper and lower case once more, so a word-final sigma (ς) and σ are one
 * letter on every platform, as on Windows. A fold only ever refuses more.
 */
function foldedNames(p: string): string[] {
  const { root } = path.parse(p);
  return [root, ...p.slice(root.length).split(path.sep).filter((name) => name.length > 0)].map((name) => foldName(name).toUpperCase().toLowerCase());
}

/** A run of folded names as one key: NUL is in no file name. */
const NAMES_JOIN = '\u0000';

/**
 * The folders `scan` never listed below its root, each as the key of its folded
 * names, spelled from where the root really is (`placeOf`) and then
 * exactly as the walk spelled them below it — the walk never follows a link,
 * so nothing below the root needs resolving. No file system call is made for
 * an exclusion (a dead mount there answers none), and an exclusion is never
 * canonicalised on its own: the Data volume's own spelling of the root,
 * `/System/Volumes/Data`, once canonicalised to `/`, which made every path on
 * the disk "beneath" it after a scan of / (the U-25 security review, F1). The
 * boundary never changes once a scan has started, so the keys are made once
 * per record and spelling of its root.
 *
 * The fixed folders are also taken from where the root really is, not only as
 * it was typed (the SEC-2 review, F1). The record keeps the root as typed, and
 * a root typed through a link in its parents (`/Volumes/Macintosh HD/System/
 * Volumes/Data`) or in another case (`/System/volumes/Data`) is the Data
 * volume all the same — but none of the fixed folders, nor their Data volume
 * spellings, lay strictly below the typed string, so /Volumes, where every
 * drive appears, was dropped again, and with it every drive mounted after the
 * scan began (or every drive, when the table could not be read).
 */
const exclusionKeys = new WeakMap<ScanResult, { root: string; keys: Set<string> }>();

function exclusionKeysOf(scan: ScanResult, root: string): Set<string> {
  const known = exclusionKeys.get(scan);
  if (known && known.root === root) return known.keys;
  const keys = new Set(exclusionsBelow(scan.boundary, scan.rootPath, root, root).map((never) => foldedNames(never).join(NAMES_JOIN)));
  exclusionKeys.set(scan, { root, keys });
  return keys;
}

/** macOS's list of the Data volume's folders that the root shows (firmlinks): /Users, /Applications, /private, … */
const FIRMLINKS_FILE = '/usr/share/firmlinks';

/**
 * The folders every macOS since Catalina (10.15) firmlinks from the Data volume, as the root spells
 * them: the list where /usr/share/firmlinks cannot be read, or names none (the SEC-2 review, LOW-1).
 * With no list at all, no Data volume spelling was the root's, while the sanitizer and the spill and
 * app-data rules take the prefix off every such spelling — so the layers disagreed about one file.
 * Only folders on every version: one firmlinked on some (/System/Library/Caches, /usr/libexec/cups)
 * is left out, since reading the Data volume's own folder of that name as the root's would grant
 * what a scan of / never listed.
 */
export const DEFAULT_DATA_VOLUME_FOLDERS: readonly string[] = Object.freeze(['/Applications', '/Library', '/Users', '/Volumes', '/cores', '/opt', '/private', '/usr/local']);

/** The Data volume's folders as the root spells them, read once; the default list when the file cannot be read. */
let dataVolumeFolders: readonly string[] | null = null;
let dataVolumeFoldersForTests: readonly string[] | null = null;
let firmlinksFileForTests: string | null = null;

function dataVolumeFolderList(): readonly string[] {
  if (dataVolumeFoldersForTests) return dataVolumeFoldersForTests;
  if (dataVolumeFolders === null) {
    let read: string[] = [];
    try {
      read = parseFirmlinks(fs.readFileSync(firmlinksFileForTests ?? FIRMLINKS_FILE, 'utf8')).map((pair) => pair.system);
    } catch {
      // unreadable: the default list below
    }
    dataVolumeFolders = read.length > 0 ? read : DEFAULT_DATA_VOLUME_FOLDERS;
  }
  return dataVolumeFolders;
}

/** Tests only: the Data volume's folders, in place of this Mac's firmlinks; null puts them back. */
export function setDataVolumeFoldersForTests(list: readonly string[] | null): void {
  dataVolumeFoldersForTests = list;
}

/** Tests only: read the firmlinks from `file` in place of /usr/share/firmlinks, afresh; null puts this Mac's back. */
export function setFirmlinksFileForTests(file: string | null): void {
  firmlinksFileForTests = file;
  dataVolumeFolders = null;
}

/**
 * Whether `p`, living at `where` (`placeOf`), is something `scan` listed: under its
 * root as that scan spelled it (`asListedFrom`; the root itself by any spelling of
 * its last name, `asTheRoot`), and not at or beneath a folder
 * the scan never descended into (`exclusionsOf`). Names are compared as a file
 * system may fold them, so the drive's name in another case is the drive; on a
 * volume that keeps case that also refuses a look-alike folder, which only ever
 * refuses more.
 */
function listedBy(scan: ScanResult, p: string, where: string): boolean {
  const root = rootPlaceOf(scan.rootPath);
  const at = asListedFrom(root, asTheRoot(p, where, root));
  if (at === null || !isInside(root, at)) return false;
  const keys = exclusionKeysOf(scan, root);
  if (keys.size === 0) return true;
  // At or beneath an exclusion when some leading run of the path's names is one.
  let key = '';
  for (const name of foldedNames(at)) {
    key = key === '' ? name : `${key}${NAMES_JOIN}${name}`;
    if (keys.has(key)) return false;
  }
  return true;
}

/**
 * The refusal for a path in TreeMap's own spill folder (`<appData>/` + `SPILL_DIR`, Phase 4
 * §S.5.3), or null. The folder holds the working files of very large scans; no request that
 * names a path there may trash, open, move or write it, however the path is spelled
 * (`isSpillPath`). Refused before the scanned-root rule is asked: a scan of a home folder
 * covers app-data, and scanning is no licence here.
 */
export function spillPathRefusal(p: string): AppError | null {
  if (!isSpillPath(p)) return null;
  return new AppError(
    403,
    'SPILL_PATH',
    `"${p}" is in TreeMap's own ${SPILL_DIR} folder, which holds the working files of very large scans. ` +
      'TreeMap never trashes, opens, moves or writes anything there.',
  );
}

/** Throws `spillPathRefusal`'s 403 for a path in the spill folder: for services and the MCP tools. */
export function assertNotSpillPath(p: string): void {
  const refusal = spillPathRefusal(p);
  if (refusal) throw refusal;
}

/**
 * The refusal for a WRITE destination in TreeMap's own app-data folder (`isAppDataPath`), or
 * null (FG1). App-data holds the files TreeMap trusts — its settings, the Autopilot policies and
 * their approval, the offload manifest the reveal route opens from, the Time Capsule — so no
 * request makes a file there: not a relocation's `to`, an offload's `dest` or any copy its plan
 * makes, a snapshot restore's destination, nor an encode (which writes where its original is).
 * Reading app-data, and deleting what a scan covers, are not refused here (the agent policy and the
 * audit log are, by `safetyRecordRefusal`).
 */
export function appDataPathRefusal(p: string): AppError | null {
  if (!isAppDataPath(p)) return null;
  return new AppError(
    403,
    'APP_DATA_PATH',
    `"${p}" is in TreeMap's own app-data folder, where it keeps its settings and records. ` +
      'No request writes, moves or copies a file there.',
  );
}

/** Throws `appDataPathRefusal`'s 403 for a write destination in app-data: for routes, services and the MCP tools. */
export function assertNotAppDataPath(p: string): void {
  const refusal = appDataPathRefusal(p);
  if (refusal) throw refusal;
}

/**
 * The refusal for removing or moving TreeMap's agent policy or its audit log, a folder that holds
 * them, or a link TreeMap reaches them through (`takesSafetyRecord`), or null (the final review, F1.11,
 * F1.20, F2.1). The policy is deliberately not writable through the API, and an absent one means "no
 * limits"; the audit is the record of what was done. Asked only by the doors that remove or move what
 * a request names — never by open or preview: a person edits the policy by opening it.
 */
export function safetyRecordRefusal(p: string): AppError | null {
  if (!takesSafetyRecord(p)) return null;
  return new AppError(
    403,
    'SAFETY_RECORD',
    `"${p}" is TreeMap's agent policy or its audit log, a folder that holds them, or a link TreeMap reaches them through. TreeMap never removes or moves any of these: ` +
      'an absent policy means no limits at all, and the audit is the record of what was done. Change them yourself, outside TreeMap.',
  );
}

/** Throws `safetyRecordRefusal`'s 403: for the Trash step, the Time Capsule, a relocation and the MCP tools. */
export function assertNotSafetyRecord(p: string): void {
  const refusal = safetyRecordRefusal(p);
  if (refusal) throw refusal;
}

/**
 * `safetyRecordRefusal` over every path a request's body carries (`bodyPaths`): the guard of every
 * route that removes or moves what it names — a delete, the cart, an offload, a relocation — before its
 * dry run, so a dry run refuses as the real run would.
 */
export function refuseSafetyRecords(req: Request, _res: Response, next: NextFunction): void {
  const candidates = bodyPaths(req);
  if (candidates instanceof AppError) {
    next(candidates);
    return;
  }
  for (const p of candidates) {
    const refusal = safetyRecordRefusal(p);
    if (refusal) {
      next(refusal);
      return;
    }
  }
  next();
}

/**
 * Every path a request's body carries: its `path` when present, and each element of its
 * `paths` when present, whichever of the two its route reads. Judging only one let the other
 * through: a `paths: []` beside `path` used to stand in for it, so `/files/open`,
 * `/files/terminal` and `/security/relocate` ran on a `path` no rule had judged (T17a's
 * security review). Anything that is not a non-empty string is refused, 400 `PATH_INVALID`.
 */
function bodyPaths(req: Request): string[] | AppError {
  const body = req.body as Record<string, unknown>;
  const given: unknown[] = [];
  if (body.path !== undefined) given.push(body.path);
  if (body.paths !== undefined) {
    if (!Array.isArray(body.paths)) return new AppError(400, 'PATH_INVALID', '"paths" must be a list of paths');
    given.push(...body.paths);
  }
  for (const p of given) {
    if (typeof p !== 'string' || p.length === 0) return new AppError(400, 'PATH_INVALID', 'Every path must be a non-empty string');
  }
  return given as string[];
}

/**
 * The scanned-root rule over every path a request's body carries (`bodyPaths`), in one
 * place: a cloud path, a path in TreeMap's own spill folder (when `refuseSpill`), a path
 * outside every scanned root, an entry inside an archive. Answers the first refusal, or null.
 * `readOnly` asks only that the path lie under some scan's root (`underAnyScanRoot`); the
 * route then answers nothing for a path no scan listed, nor for one the sanitizer refused only for
 * where it leads (`unanswerablePaths`), which is judged by where it lives itself.
 */
function scanRootRefusal(req: Request, refuseSpill: boolean, readOnly = false): AppError | null {
  const candidates = bodyPaths(req);
  if (candidates instanceof AppError) return candidates;
  const unanswerableHere = unanswerablePaths(req);
  for (const p of candidates) {
    // Cloud entries never touch this filesystem — their deletes go through
    // POST /api/cloud/trash to the provider's own trash.
    if (p.startsWith('cloud://')) {
      return new AppError(403, 'CLOUD_PATH', `"${p}" lives in a cloud account — use the provider's trash instead`);
    }
    const spill = refuseSpill ? spillPathRefusal(p) : null;
    if (spill) return spill;
    if (!(readOnly ? underAnyScanRoot(p, unanswerableHere.has(p)) : insideAnyScanRoot(p))) {
      return new AppError(
        403,
        'OUTSIDE_SCAN_ROOT',
        `"${p}" is outside every scanned root — scan its folder first`
      );
    }
    // Entries inside a container exist in its directory listing, not on
    // disk — only the container itself can be trashed or opened.
    if (isVirtualPath(p)) {
      return new AppError(
        403,
        'VIRTUAL_PATH',
        `"${p}" is inside an archive — act on the archive itself instead`
      );
    }
  }
  return null;
}

/**
 * Reject body paths that fall outside every known scan root, and any path in TreeMap's own
 * spill folder: the guard of every destructive and OS-touching route.
 */
export function requireInsideScanRoot(req: Request, _res: Response, next: NextFunction): void {
  const refusal = scanRootRefusal(req, true);
  if (refusal) next(refusal);
  else next();
}

/**
 * The same scanned-root rule for a route that only reads (POST /api/facts): a question about
 * the spill folder is answered like any other, since answering it touches nothing there, and
 * one such path must not cost a whole batch of 2,000 its answers. For the same reason a path
 * under a scanned root that no scan listed — a drive a scan did not enter, a folder no walk
 * descends into (Track U, U-25) — passes here, and the route skips it: it has no answer, and a
 * mount point among a folder's children must not cost the Grid every badge (TS review R8). A
 * path under no scanned root at all is still refused.
 */
export function requireInsideScanRootToRead(req: Request, _res: Response, next: NextFunction): void {
  const refusal = scanRootRefusal(req, false, true);
  if (refusal) next(refusal);
  else next();
}

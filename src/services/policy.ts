import { AgentPolicy } from '../models/types';
import os from 'os';
import path from 'path';
import { appDataDir, readJsonFileChecked } from './storage';
import { canonicalDirOf, foldName, isInside, realPlaceNow, rootLivesAt } from '../utils/pathSanitizer';
import { allScans } from './diskScanner';
import { storeOf } from './scanStore';
import { AppError } from '../middleware/errorHandler';
import { formatBytes } from '../utils/formatBytes';

/**
 * policy — user-editable guard rails for what agents (and the HTTP API) may
 * scan and destroy, layered ON TOP of the existing safety model
 * (requireInsideScanRoot, trash-only deletes). The policy file is read fresh
 * on every enforcement so edits take effect immediately, and an absent or
 * empty file imposes no restriction at all — today's behavior, verbatim.
 *
 * The file is agent-policy.json in the app-data directory, edited by the
 * human (deliberately NOT writable through the API — a policy an agent could
 * rewrite for itself would be theatre):
 *
 *   {
 *     "allowedRoots": ["/Users/me/Downloads", "/Users/me/projects"],
 *     "protectedPaths": ["/Users/me/projects/keep-forever"],
 *     "maxBytesPerOperation": 10737418240
 *   }
 */

export const POLICY_FILE = 'agent-policy.json';

/**
 * Read and normalize the policy; malformed FIELDS fall back to "no
 * restriction", but an unreadable or unparseable FILE does not.
 *
 * The difference is the whole security posture. Every enforcement below
 * short-circuits on an empty policy — `assertScanAllowed` returns immediately
 * when `allowedRoots` is empty, the `protectedPaths` loop never runs, and
 * `assertBytesCap` returns when the cap is null. So "the policy file could
 * not be read" and "the user configured no restrictions" produce byte-
 * identical behaviour: every guard rail off, silently.
 *
 * An ABSENT file genuinely means no restrictions, and is documented above as
 * today's behaviour. A file that is there and will not parse is a different
 * fact, and this boundary fails closed on it: refusing an operation is
 * recoverable, and quietly permitting one is not.
 */
export async function getPolicy(): Promise<AgentPolicy> {
  const loaded = await readJsonFileChecked<Partial<AgentPolicy>>(POLICY_FILE);
  if (!loaded.ok && loaded.reason === 'corrupt') {
    // 500, not 403. Nothing about the CALLER is forbidden — the server cannot
    // determine authorization at all — and a 403 here is indistinguishable in
    // logs and on the MCP surface from a genuine policy denial. The path is in
    // the message because "fix or remove the file" is useless without it.
    // The path is NOT in the message. `errorHandler` passes an `AppError`
    // through verbatim at any status, while its own generic 500 branch says
    // "hide internals from the client" — and the default bind is loopback but
    // the Dockerfile sets HOST=0.0.0.0. An absolute path leaks the OS
    // username. `GET /api/policy` is the endpoint that exists to tell a
    // person where the file is, and it still does.
    //
    // "Fix" only, never "remove": an ABSENT policy is documented as no
    // restrictions, so telling the user to delete it in the same sentence
    // that refuses to act without limits would be handing them the shape the
    // refusal exists to avoid.
    throw new AppError(
      500,
      'POLICY_UNREADABLE',
      `The agent policy file could not be read (${loaded.detail}), so TreeMap refused this operation rather ` +
        'than acting as if you had set no limits. Repair it — GET /api/policy reports its location. ' +
        'A copy of the unreadable file is kept beside it with a .corrupt suffix.',
    );
  }
  const raw: Partial<AgentPolicy> = loaded.ok ? loaded.value : {};
  return {
    allowedRoots: Array.isArray(raw.allowedRoots)
      ? raw.allowedRoots.filter((r): r is string => typeof r === 'string' && r.length > 0)
      : [],
    protectedPaths: Array.isArray(raw.protectedPaths)
      ? raw.protectedPaths.filter((r): r is string => typeof r === 'string' && r.length > 0)
      : [],
    maxBytesPerOperation:
      typeof raw.maxBytesPerOperation === 'number' && Number.isFinite(raw.maxBytesPerOperation) && raw.maxBytesPerOperation > 0
        ? raw.maxBytesPerOperation
        : null,
  };
}

/**
 * Scans are the entry ticket to everything else — gate them first.
 *
 * Judged where the root really is (`rootLivesAt`: a folder by its real place, a
 * link — which a walk lists as the one entry it is — by the folder it lies in),
 * against each allowed root where it lives and where it really is. By its text, a
 * folder spelled inside an allowed root through a link above it passed, and an
 * index build — which, unlike a scan, has no later check of its own — walked and
 * served a folder outside every allowed root (the final review, F1.8, F1.15). A
 * scan still checks where a link root leads before it walks (`startScan`).
 */
export function assertScanAllowed(policy: AgentPolicy, rootPath: string): void {
  if (policy.allowedRoots.length === 0) return;
  const where = path.normalize(canonicalDirOf(rootLivesAt(rootPath)));
  if (policy.allowedRoots.flatMap(placesOfEntry).some((root) => isInside(root, where))) return;
  throw new AppError(
    403,
    'POLICY_ROOT_NOT_ALLOWED',
    `"${rootPath}" is outside the allowed roots — edit agent-policy.json (allowedRoots) to widen them`,
  );
}

/** A policy entry as a path: a leading `~` is the home folder, as a path a request carries reads it. */
function entryPath(entry: string): string {
  const expanded = entry === '~' || entry.startsWith('~/') || entry.startsWith('~\\') ? path.join(os.homedir(), entry.slice(1)) : entry;
  return path.resolve(expanded);
}

/**
 * Where a policy entry is: where it lives (every link in its parents resolved, its own name as
 * written: a link entry is the link) and, when realpath can answer, where it really is (a link entry
 * is also what it leads to). Both count, so an entry written through a link, or as a link, names the
 * folder its writer meant.
 */
function placesOfEntry(entry: string): string[] {
  const p = entryPath(entry);
  const places = [path.normalize(canonicalDirOf(p))];
  const real = realPlaceNow(p);
  if (real !== null && real !== places[0]) places.push(real);
  return places;
}

/**
 * Where a request's path lives, as the scanned-root rule and the delete read it: every link in its
 * parents resolved, its own name as spelled — so a link is still the link, and removing it removes
 * the link, never what it leads to.
 */
function placeOfTarget(p: string): string {
  return path.normalize(canonicalDirOf(p));
}

/** A path's names, its root first, each as a file system may fold it (`foldName`): a fold only ever refuses more here. */
function foldedNamesOf(p: string): string[] {
  const { root } = path.parse(p);
  return [root, ...p.slice(root.length).split(path.sep).filter((name) => name.length > 0)].map((name) => foldName(name).toUpperCase().toLowerCase());
}

/** Whether the folded names `outer` are `inner`'s or lead to them. */
function namesContain(outer: string[], inner: string[]): boolean {
  return outer.length <= inner.length && outer.every((name, i) => name === inner[i]);
}

/**
 * Destructive targets must lie inside an allowed root and must not touch a
 * protected path — in either direction: trashing a folder that CONTAINS a
 * protected path would delete it just as surely.
 *
 * Both are judged on where each path LIVES (`placeOfTarget`), as the scanned-root
 * rule judges it and the delete then acts (the final review, F1.3, F1.7): by its
 * text, a protected folder spelled through a link in its parents, in another case
 * or on the Data volume's long spelling passed, and a path spelled inside an
 * allowed root through a link that leads out of it was "inside". A protected path
 * is compared name by name as a file system may fold names, which only refuses
 * more; an allowed root exactly, since a fold there would let more through.
 */
export function assertPathsAllowed(policy: AgentPolicy, paths: string[]): void {
  if (policy.allowedRoots.length > 0) {
    const allowed = policy.allowedRoots.flatMap(placesOfEntry);
    for (const p of paths) {
      const where = placeOfTarget(p);
      if (!allowed.some((root) => isInside(root, where))) {
        throw new AppError(
          403,
          'POLICY_ROOT_NOT_ALLOWED',
          `"${p}" is outside the allowed roots — edit agent-policy.json (allowedRoots) to widen them`,
        );
      }
    }
  }
  if (policy.protectedPaths.length === 0) return;
  const protectedPlaces = policy.protectedPaths.map((entry) => ({ entry, places: placesOfEntry(entry).map(foldedNamesOf) }));
  for (const p of paths) {
    const where = foldedNamesOf(placeOfTarget(p));
    for (const { entry, places } of protectedPlaces) {
      const touches = isInside(entry, p) || isInside(p, entry) || places.some((place) => namesContain(place, where) || namesContain(where, place));
      if (touches) {
        throw new AppError(
          403,
          'POLICY_PROTECTED_PATH',
          `"${p}" touches the protected path "${entry}" — remove it from agent-policy.json to allow this`,
        );
      }
    }
  }
}

/** The per-operation byte cap; null bytes (unknown size) pass — honesty over guessing. */
export function assertBytesCap(policy: AgentPolicy, bytes: number | null): void {
  if (policy.maxBytesPerOperation === null || bytes === null) return;
  if (bytes <= policy.maxBytesPerOperation) return;
  throw new AppError(
    403,
    'POLICY_BYTES_EXCEEDED',
    `This operation covers ${formatBytes(bytes)}, over the ${formatBytes(policy.maxBytesPerOperation)} per-operation cap in agent-policy.json`,
  );
}

/**
 * Recursive size of `p` according to any completed scan that contains it: by its
 * own spelling, or else by where it lives (`placeOfTarget`), spelled as that scan
 * spells its paths (the final review, F1.4). Found by its text alone, a folder
 * spelled through a link in its parents, in another case or on the Data volume's
 * long spelling was "size unknown" — so the byte cap let it through and the audit
 * counted nothing — while the delete took the folder the scan had sized.
 */
export function knownSizeOf(p: string): number | null {
  const complete = allScans().filter((scan) => scan.status === 'complete' && (scan.store || scan.root));
  for (const scan of complete) {
    const store = storeOf(scan);
    const id = store.findByPath(p);
    if (id !== -1) return store.size(id);
  }
  const where = placeOfTarget(p);
  for (const scan of complete) {
    const store = storeOf(scan);
    const id = nodeAtPlace(store, scan.rootPath, where);
    if (id !== -1) return store.size(id);
  }
  return null;
}

/**
 * The node of the scan rooted at `rootPath` that lies at `where` (a place, `placeOfTarget`), or -1:
 * the names below the root's own place (`rootLivesAt`) walked from the root's node, each by its
 * exact name or else by the one child whose name folds the same (the last name keeps the case it was
 * typed in; the folders above it are realpath's, as the volume stores them).
 */
function nodeAtPlace(store: ReturnType<typeof storeOf>, rootPath: string, where: string): number {
  const rootAt = path.normalize(rootPlaceNow(rootPath));
  const rootNames = foldedNamesOf(rootAt);
  const names = where.slice(path.parse(where).root.length).split(path.sep).filter((name) => name.length > 0);
  if (!namesContain(rootNames, foldedNamesOf(where))) return -1;
  let id = store.findByPath(rootPath);
  for (const name of names.slice(rootNames.length - 1)) {
    if (id === -1) return -1;
    id = childNamed(store, id, name);
  }
  return id;
}

/** The child of `parent` named `name`, or the one child whose name folds the same; -1 when none (or more than one) does. */
function childNamed(store: ReturnType<typeof storeOf>, parent: number, name: string): number {
  const exact = store.childByName(parent, name);
  if (exact !== -1) return exact;
  const wanted = foldName(name).toUpperCase().toLowerCase();
  let found = -1;
  let count = 0;
  store.forEachChild(parent, (child) => {
    if (foldName(store.name(child)).toUpperCase().toLowerCase() === wanted) {
      found = child;
      count += 1;
    }
  });
  return count === 1 ? found : -1;
}

/** Where a scan's root is, as `rootLivesAt` reads it, on the Data volume's short spelling as `canonicalDirOf` gives a path. */
function rootPlaceNow(rootPath: string): string {
  return canonicalDirOf(rootLivesAt(rootPath));
}

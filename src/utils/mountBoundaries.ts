import { promises as fsp } from 'fs';
import { parseBsdMount, parseProcMounts, type MountEntry } from '../platform/atime';
import { runText, type RunOptions } from '../platform/exec';

/**
 * Where a scan stops: the folders no walk descends into, and — per scan — the
 * drives mounted inside the folder being scanned (Track U, U-23).
 *
 * Two lists, composed in one place (`scanBoundary`), handed to every engine:
 *
 * **The fixed list** (below). Folders a scan must never descend INTO, on every
 * scan of every folder — each may still be scanned directly as a chosen root,
 * because the list is consulted only on the way down. Two failure modes live
 * behind it:
 *
 *  - Re-entry: /System/Volumes/Data firmlink-mirrors the entire writable
 *    volume, so descending into it counts every byte a full-disk scan already
 *    saw at /Users, /Applications, /private, …
 *  - Blocking triggers: automount points, File Provider materialization and
 *    dead network/external volumes block open()/stat() indefinitely — a
 *    full-disk scan that wanders in never comes back. Diagnosed live: gdu sat
 *    at 0% CPU with every worker thread parked inside open() under
 *    /System/Volumes while the scan counter froze.
 *
 * **The mount table.** A drive mounted inside the scanned folder — a disk
 * image, the iOS Simulator's runtime volumes under /Library, a nullfs view
 * an app makes of its own bundle, a separate /home partition on Linux — is a
 * separate disk. With the boundary rule at `stay` (the default, the owner's
 * answer to U-Q9 on 2 Oct 2026) no engine enters one; with `cross` they do,
 * as every engine but gdu did before. The diagnosis Mac had four such mounts
 * under `/` — about 1.18M entries and ~35 GiB that a scan of `/` counted on
 * top of the disk they are not on (docs/engine/TRACK-U-DIAGNOSIS.md).
 *
 * **Why the table, and never a device id** (decision P3-3, kept by U-D12).
 * Measured, not assumed: on macOS 15 and 27 the firmlinked folders (/Users,
 * /Applications, /private, …) report the SAME `st_dev` as `/` (16777234 on
 * the diagnosis Mac), and the simulator volumes report others (16777239,
 * 16777247) — so on that Mac a device test would happen to give the right
 * answer. It is still the wrong rule: a Linux bind mount shares its source's
 * device, so a device test misses it, and every btrfs subvolume has a device
 * of its own, so a device test stops at folders that are no mount at all. The
 * table names exactly what is mounted where, on every OS that has one; the
 * built-in walker's device comparison only COUNTS a crossing the table missed
 * (`crossedUnlisted`), and never decides whether to descend.
 *
 * The table is matched by spelling, so a mount the table spells through a
 * firmlink (the Data volume's own names) or a root typed through a symlink
 * (/var → /private/var) is re-spelled into the walk's spelling here, once.
 */
const DARWIN_SKIP = new Set(['/System/Volumes', '/Volumes', '/dev', '/home', '/net', '/Network']);
const LINUX_SKIP = new Set(['/proc', '/sys', '/dev', '/run']);

/** Paths a test adds to every platform's list (`setNeverDescendForTests`): a scan of a temp folder cannot reach the real ones. */
let extraForTests: ReadonlySet<string> | null = null;

export function neverDescend(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (extraForTests?.has(p)) return true;
  if (platform === 'darwin') return DARWIN_SKIP.has(p);
  if (platform === 'linux') return LINUX_SKIP.has(p);
  return false;
}

/** The whole list for a platform, in a fixed order — what the native walker is given. */
export function neverDescendPaths(platform: NodeJS.Platform = process.platform): string[] {
  const fixed = platform === 'darwin' ? [...DARWIN_SKIP] : platform === 'linux' ? [...LINUX_SKIP] : [];
  return extraForTests ? [...fixed, ...extraForTests] : fixed;
}

/** Tests only: `paths` join every platform's never-descend list, for every engine; null puts the fixed lists back. */
export function setNeverDescendForTests(paths: readonly string[] | null): void {
  extraForTests = paths ? new Set(paths) : null;
}

/* ───────────────────────────── the boundary rule ───────────────────────────── */

/**
 * What a scan does at a drive mounted inside the folder it scans: `stay` on
 * the drive it started on, or `cross` into the mounted one.
 */
export type BoundaryRule = 'stay' | 'cross';

/** Every rule, in the order Settings lists them. */
export const BOUNDARY_RULES: readonly BoundaryRule[] = Object.freeze(['stay', 'cross'] as const);

/** The owner's answer to U-Q9 (2 Oct 2026): "Stay on this drive". */
export const DEFAULT_BOUNDARY_RULE: BoundaryRule = 'stay';

/* ───────────────────────────── spelling, segment by segment ───────────────────────────── */

/**
 * Is `p` at or beneath `dir`? Name by name, so `/Volumes/Disk2` is not under
 * `/Volumes/Disk`. POSIX spelling only: no platform TreeMap reads a mount
 * table on spells a path any other way.
 */
export function isAtOrUnder(dir: string, p: string): boolean {
  if (p === dir) return true;
  return p.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
}

/** Is `p` strictly beneath `dir` — never `dir` itself? */
export function isStrictlyUnder(dir: string, p: string): boolean {
  return p !== dir && isAtOrUnder(dir, p);
}

/* ───────────────────────────── the mount table ───────────────────────────── */

/** Where a table came from: macOS's `mount`, Linux's `/proc/mounts`, or nowhere. */
export type MountTableSource = 'mount' | '/proc/mounts' | 'none';

/**
 * The mounts the operating system reports. `entries: null` means UNKNOWN —
 * the table could not be read, and `reason` says why. An empty list is a
 * reading: nothing is mounted anywhere a scan could meet it.
 */
export interface MountTable {
  source: MountTableSource;
  entries: MountEntry[] | null;
  /** Why the table is unknown, or (Windows) why there is none to read; null when it was read. */
  reason: string | null;
}

export interface MountTableDeps {
  /** macOS: the text `mount` prints. */
  runMount(): Promise<string>;
  /** Linux: the text of `/proc/mounts`. */
  readProcMounts(): Promise<string>;
}

/** By its full path: a packaged app's PATH need not hold /sbin. */
const MOUNT_BINARY = '/sbin/mount';
const MOUNT_TIMEOUT_MS = 5_000;

/** Windows' sentence. A volume mounted in a folder there is a reparse point, which the engines list as a link. */
const WINDOWS_NO_TABLE =
  'Windows keeps no mount table for a walk to read: a drive mounted in a folder there is a reparse point, which the scan engines treat as a link and do not follow.';

type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<string>;

/**
 * The real machine's table readers. The `mount` child is started without
 * TreeMap's API token in its environment (Phase T, T-7): nothing TreeMap
 * starts needs it, and a child's environment is readable by anything that
 * can read the child.
 */
export function liveMountTableDeps(run: Runner = runText): MountTableDeps {
  return {
    runMount: () => run(MOUNT_BINARY, [], { timeoutMs: MOUNT_TIMEOUT_MS, env: { TREEMAP_TOKEN: undefined } }),
    readProcMounts: () => fsp.readFile('/proc/mounts', 'utf8'),
  };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Read this machine's mount table, fresh. Never cached — a drive attached
 * between two scans must be in the second one's list — and never thrown: a
 * table that cannot be read is `entries: null` with the reason, so the scan
 * can say "unknown" rather than "nothing mounted".
 */
export async function readMountTable(platform: NodeJS.Platform, deps: MountTableDeps = liveMountTableDeps()): Promise<MountTable> {
  if (platform === 'darwin') {
    try {
      return { source: 'mount', entries: parseBsdMount(await deps.runMount()), reason: null };
    } catch (err) {
      return { source: 'mount', entries: null, reason: message(err) };
    }
  }
  if (platform === 'linux') {
    try {
      return { source: '/proc/mounts', entries: parseProcMounts(await deps.readProcMounts()), reason: null };
    } catch (err) {
      return { source: '/proc/mounts', entries: null, reason: message(err) };
    }
  }
  if (platform === 'win32') return { source: 'none', entries: [], reason: WINDOWS_NO_TABLE };
  return { source: 'none', entries: null, reason: `TreeMap has no reader for the mount table on ${platform}` };
}

/* ───────────────────────────── firmlinks ───────────────────────────── */

const DATA_VOLUME = '/System/Volumes/Data';
const FIRMLINKS_FILE = '/usr/share/firmlinks';

/** One firmlink: the folder as the root spells it, and as the Data volume does. Both absolute. */
export interface FirmlinkPair {
  system: string;
  data: string;
}

/** Every other spelling of a path, for matching a table's spelling to a walk's. */
export type AliasRule = (p: string) => string[];

const NO_ALIASES: AliasRule = () => [];

/** `/usr/share/firmlinks`: one firmlink a line, the root's spelling, a tab, then the path inside the Data volume. */
export function parseFirmlinks(text: string): FirmlinkPair[] {
  const pairs: FirmlinkPair[] = [];
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const system = line.slice(0, tab).trim();
    const inData = line.slice(tab + 1).trim().replace(/^\/+/, '');
    if (!system.startsWith('/') || system === '/' || !inData) continue;
    pairs.push({ system, data: `${DATA_VOLUME}/${inData}` });
  }
  return pairs;
}

/** Each firmlinked path's other spelling: the Data volume's for the root's, and the root's for the Data volume's. */
export function firmlinkAliases(pairs: readonly FirmlinkPair[]): AliasRule {
  return (p) => {
    const out: string[] = [];
    for (const { system, data } of pairs) {
      if (isAtOrUnder(data, p)) out.push(system + p.slice(data.length));
      else if (isAtOrUnder(system, p)) out.push(data + p.slice(system.length));
    }
    return out;
  };
}

/**
 * The fallback where the firmlinks cannot be read: a copy of pathSanitizer's
 * `stripDataVolume` prefix rule (private there, and it reads
 * `process.platform`). One direction only: it cannot know which of the
 * root's folders are firmlinked, so it never invents a Data-volume spelling.
 */
export function dataVolumeAlias(p: string): string[] {
  if (p === DATA_VOLUME) return ['/'];
  return p.startsWith(`${DATA_VOLUME}/`) ? [p.slice(DATA_VOLUME.length)] : [];
}

/* ───────────────────────────── which mounts lie under a root ───────────────────────────── */

/** A mount beneath a scan's root, spelled as that scan's walk spells it. */
export interface MountUnder {
  path: string;
  filesystem: string;
  /** What is mounted there (a device, or the folder a nullfs or bind mount shows again); empty when the table did not say. */
  source: string;
}

/** `p` in the root's own spelling, when it lies strictly beneath the root as typed or where it really is; else null. */
function respell(p: string, root: string, realRoot: string): string | null {
  if (isStrictlyUnder(root, p)) return p;
  if (realRoot === root || !isStrictlyUnder(realRoot, p)) return null;
  const rest = realRoot === '/' ? p : p.slice(realRoot.length);
  return root === '/' ? rest : root + rest;
}

/**
 * The mounts strictly beneath `root`, one per mount point, in the spelling the
 * walk of `root` produces (the root as typed, joined with the names it lists).
 *
 * Pure. `realRoot` is where the root really is (its links resolved), so a
 * root typed as /var/folders/… finds the mounts the table spells under
 * /private/var/folders/…; `aliases` gives a table spelling's other names (the
 * firmlinks), so a root of /System/Volumes/Data finds the mounts the table
 * spells under /Library. A mount's own spelling is preferred to an alias, and
 * a mount point listed twice (one mounted over the other) is the later entry,
 * the one a walk meets.
 */
export function mountPointsUnder(root: string, realRoot: string, entries: readonly MountEntry[], aliases: AliasRule): MountUnder[] {
  const byPath = new Map<string, MountUnder>();
  for (const entry of entries) {
    let walked: string | null = null;
    for (const spelling of [entry.mountPoint, ...aliases(entry.mountPoint)]) {
      walked = respell(spelling, root, realRoot);
      if (walked !== null) break;
    }
    if (walked === null) continue;
    byPath.delete(walked);
    byPath.set(walked, { path: walked, filesystem: entry.filesystem, source: entry.source ?? '' });
  }
  return [...byPath.values()];
}

/* ───────────────────────────── the scan's boundary ───────────────────────────── */

export interface BoundaryMount extends MountUnder {
  /** At or beneath a fixed never-descend folder below the root, so no walk of this root ever reaches it. */
  underFixed: boolean;
}

/** One scan's boundary, composed once when it starts and kept on its record. */
export interface ScanBoundary {
  rule: BoundaryRule;
  /** Where the mount table came from. */
  source: MountTableSource;
  /** Why the table is unknown (or, on Windows, why there is none); null when it was read. */
  reason: string | null;
  /** Every mount strictly beneath the root, in the walk's spelling; null when the table could not be read. */
  mounts: BoundaryMount[] | null;
  /** The platform's fixed never-descend list. */
  fixed: string[];
  /** Every path the walk must not descend into: the fixed list, plus — under `stay` — every listed mount. */
  neverDescend: string[];
}

export interface BoundaryDeps {
  platform: NodeJS.Platform;
  readTable(): Promise<MountTable>;
  /** Where the root really is: every link resolved. */
  realpath(p: string): Promise<string>;
  aliases(): Promise<AliasRule>;
  /** Whether a mount point is a folder; null when that could not be learned in time. */
  isDirectory(p: string): Promise<boolean | null>;
}

/** A dead network mount must not hold a scan's start: a mount whose kind is not known by then is kept. */
const MOUNT_STAT_TIMEOUT_MS = 2_000;

async function isDirectoryBounded(p: string): Promise<boolean | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), MOUNT_STAT_TIMEOUT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([fsp.stat(p).then((st) => st.isDirectory(), () => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function liveAliases(platform: NodeJS.Platform): Promise<AliasRule> {
  if (platform !== 'darwin') return NO_ALIASES;
  try {
    const pairs = parseFirmlinks(await fsp.readFile(FIRMLINKS_FILE, 'utf8'));
    return pairs.length > 0 ? firmlinkAliases(pairs) : dataVolumeAlias;
  } catch {
    return dataVolumeAlias;
  }
}

/** The real machine's. */
export function liveBoundaryDeps(platform: NodeJS.Platform = process.platform): BoundaryDeps {
  return {
    platform,
    readTable: () => readMountTable(platform),
    realpath: (p) => fsp.realpath(p),
    aliases: () => liveAliases(platform),
    isDirectory: isDirectoryBounded,
  };
}

let depsForTests: Partial<BoundaryDeps> | null = null;

/** Test seam: every scan's boundary is composed with these in place of the real machine's; null puts the machine back. */
export function setBoundaryDepsForTests(over: Partial<BoundaryDeps> | null): void {
  depsForTests = over;
}

function scanDeps(): BoundaryDeps {
  const live = liveBoundaryDeps(depsForTests?.platform ?? process.platform);
  return depsForTests ? { ...live, ...depsForTests } : live;
}

/**
 * The one place a scan's never-descend list is composed: the fixed list, and
 * — under `stay` — every drive the mount table shows mounted beneath `root`.
 *
 * A mount the system reports as a file (Docker's bind mount of /etc/hosts) is
 * not a drive a walk could enter, and is dropped; one whose kind cannot be
 * learned in time is kept, since not entering it is the safe side. Mounts
 * under the fixed folders are listed but never looked at: no walk reaches
 * them, and a dead one must not stall the start. A table that cannot be read
 * leaves the list unknown (`mounts: null`, with the reason) and the walk
 * crossing as it always did — the fixed list alone.
 */
export async function scanBoundary(root: string, rule: BoundaryRule, deps: BoundaryDeps = scanDeps()): Promise<ScanBoundary> {
  const fixed = neverDescendPaths(deps.platform);
  const table = await deps.readTable();
  if (table.entries === null) {
    return { rule, source: table.source, reason: table.reason, mounts: null, fixed, neverDescend: [...fixed] };
  }
  const realRoot = await deps.realpath(root).catch(() => root);
  const aliases = await deps.aliases().catch(() => (deps.platform === 'darwin' ? dataVolumeAlias : NO_ALIASES));
  const fixedBelow = fixed.filter((f) => isStrictlyUnder(root, f));
  const looked = await Promise.all(
    mountPointsUnder(root, realRoot, table.entries, aliases).map(async (m): Promise<BoundaryMount | null> => {
      const underFixed = fixedBelow.some((f) => isAtOrUnder(f, m.path));
      if (!underFixed && (await deps.isDirectory(m.path)) === false) return null;
      return { ...m, underFixed };
    }),
  );
  const mounts = looked.filter((m): m is BoundaryMount => m !== null);
  const neverDescend = rule === 'stay' ? [...new Set([...fixed, ...mounts.map((m) => m.path)])] : [...fixed];
  return { rule, source: table.source, reason: table.reason, mounts, fixed, neverDescend };
}

/** The boundary of a scan whose table could not even be composed: unknown, with the reason, crossing as before. */
export function unknownBoundary(rule: BoundaryRule, platform: NodeJS.Platform, reason: string): ScanBoundary {
  const fixed = neverDescendPaths(platform);
  return { rule, source: 'none', reason, mounts: null, fixed, neverDescend: [...fixed] };
}

/* ───────────────────────────── what the walk did at the boundary (Track U, U-24) ───────────────────────────── */

/** Example paths kept beside any count here: the five smallest, in sorted order, so two walks of one tree agree. */
const BOUNDARY_EXAMPLES = 5;

function keepSmallestPath(list: string[], p: string): void {
  if (list.includes(p)) return;
  list.push(p);
  list.sort();
  if (list.length > BOUNDARY_EXAMPLES) list.length = BOUNDARY_EXAMPLES;
}

/** What the walk itself recorded at the boundary. */
export interface BoundaryWalk {
  /**
   * Folders the built-in walker descended into although their device differs
   * from their parent's and the table did not list them (P3-3: a device id
   * only COUNTS a crossing the table missed; it never stops a walk).
   */
  crossedUnlisted: { count: number; examples: string[] };
  /** Listed mounts beneath a folder the walk was refused: never reached. */
  refusedAbove: Set<string>;
  /** Listed mounts at or beneath a folder the scan's "don't scan" patterns skip: never reached. */
  skipped: Set<string>;
}

/** A scan's boundary as its record keeps it: the list it was given, and what the walk recorded there. */
export interface ScanBoundaryRecord extends ScanBoundary {
  walk: BoundaryWalk;
}

export function boundaryRecord(b: ScanBoundary): ScanBoundaryRecord {
  return { ...b, walk: { crossedUnlisted: { count: 0, examples: [] }, refusedAbove: new Set(), skipped: new Set() } };
}

/** An engine that fell back hands the walk to the next: what the walk recorded starts again; what the start decided stays. */
export function restartBoundaryWalk(record: ScanBoundaryRecord): void {
  record.walk.crossedUnlisted = { count: 0, examples: [] };
  record.walk.refusedAbove = new Set();
}

/** A folder the walk was refused: every listed mount beneath it was never reached. */
export function noteRefusedBelow(record: ScanBoundaryRecord, dirPath: string): void {
  for (const m of record.mounts ?? []) {
    if (!m.underFixed && isStrictlyUnder(dirPath, m.path)) record.walk.refusedAbove.add(m.path);
  }
}

/** The "don't scan" patterns, asked of every folder from below the root down to each listed mount. */
export function noteSkippedMounts(record: ScanBoundaryRecord, root: string, isSkipped: (p: string) => boolean): void {
  for (const m of record.mounts ?? []) {
    if (m.underFixed) continue;
    for (let p = m.path; isStrictlyUnder(root, p); p = p.slice(0, p.lastIndexOf('/')) || '/') {
      if (isSkipped(p)) {
        record.walk.skipped.add(m.path);
        break;
      }
    }
  }
}

/** The walker went into a folder on another device that the table did not list. */
export function noteCrossedUnlisted(record: ScanBoundaryRecord, p: string): void {
  record.walk.crossedUnlisted.count++;
  keepSmallestPath(record.walk.crossedUnlisted.examples, p);
}

/** What became of each listed mount. Every list is taken from the boundary and the walk's records — never from the tree. */
export interface MountOutcome {
  /** False when the table could not be read: none of the lists below is a reading. */
  known: boolean;
  /** stay: the listed drives the walk reached and did not enter. */
  notEntered: BoundaryMount[];
  /** cross: the outermost listed drives the walk entered (a drive inside one is inside its bytes). */
  entered: BoundaryMount[];
  /** Listed drives no walk of this root reached: under a fixed folder, beneath a refused or skipped folder, or (stay) inside a drive not entered. */
  unreached: BoundaryMount[];
  /** cross: listed drives inside an entered one — entered too, their bytes already inside it. */
  enteredWithin: BoundaryMount[];
}

/**
 * What became of each listed mount, from the list and the walk's own records.
 *
 * Never from the shape of the tree: gdu's `-x` drops a mount point's node, and
 * a spill or aggregate store may hold no row for a small folder, so "no node"
 * and "a childless node" say nothing about whether a walk went in (U-D12).
 */
export function mountOutcome(record: ScanBoundaryRecord): MountOutcome {
  if (record.mounts === null) return { known: false, notEntered: [], entered: [], unreached: [], enteredWithin: [] };
  const reached = record.mounts.filter((m) => !m.underFixed && !record.walk.refusedAbove.has(m.path) && !record.walk.skipped.has(m.path));
  const inside = (m: BoundaryMount): boolean => reached.some((o) => o !== m && isStrictlyUnder(o.path, m.path));
  const outer = reached.filter((m) => !inside(m));
  const within = reached.filter(inside);
  const unreached = record.mounts.filter((m) => !reached.includes(m));
  if (record.rule === 'stay') return { known: true, notEntered: outer, entered: [], unreached: [...unreached, ...within], enteredWithin: [] };
  return { known: true, notEntered: [], entered: outer, unreached, enteredWithin: within };
}

/**
 * The paths beneath `root` a scan never listed: the fixed folders below the
 * root and — under `stay` — every listed mount. The scanned-root rule and Live
 * mode read this; Empty Folders reads the same list as `Flag.Unlisted`, which
 * `settleComplete` marks from `neverDescend` on every engine's tree (U-4). A
 * record from before U-24 (no boundary) reads the fixed list, which every
 * engine has always honoured.
 */
export function exclusionsOf(record: ScanBoundary | undefined, root: string, platform: NodeJS.Platform = process.platform): string[] {
  const list = record ? record.neverDescend : neverDescendPaths(platform);
  return list.filter((p) => isStrictlyUnder(root, p));
}

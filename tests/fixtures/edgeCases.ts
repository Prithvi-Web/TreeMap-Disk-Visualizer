/**
 * The edge-case fixture (Phase 3, W3): every condition the master prompt's
 * §12.2 and DESIGN.md §15 name, built under a temporary root so the legacy
 * walker (tests/edgeCases.test.ts) and the equivalence gate
 * (tests/nativeEquivalence.test.ts) can walk it. Each case is a named
 * function that reports `{ built: true, ...facts }` or `{ built: false,
 * reason }` — a case this OS cannot build is reported with the reason, never
 * silently omitted, so the tests skip it visibly. Nothing here imports a
 * service; the fixture is plain file-system work.
 *
 * Time-stable by construction: after every case is built, `freezeTimes`
 * stamps each entry with a deterministic mtime (a base plus its index in a
 * name-ordered walk plus a sub-second fraction, some at .9996 s, so the
 * engines' rounding is exercised). A file's or a symlink's atime is its mtime
 * plus one second: nothing in a walk reads their contents, so nothing moves
 * it. A directory's atime is different, because listing a directory IS
 * reading it, and each platform has its own rule for when a listing moves it:
 *
 *  - macOS (APFS) moves it only when the atime is not newer than the mtime
 *    (measured on this machine on 18 September 2026);
 *  - Linux, under the default `relatime` (relatime_need_update in
 *    fs/inode.c), moves it when the atime is not newer than the mtime, OR not
 *    newer than the ctime, OR more than 24 hours old. `utimes` itself sets
 *    the ctime to now, so the 2023 atime this fixture used to stamp was older
 *    than its ctime and older than a day, and the first listing moved it:
 *    that is how the first Linux CI run of the equivalence gate failed;
 *  - Windows (NTFS, where last-access updates are on for the volume) moves it
 *    on an enumeration only when the stored time is more than an hour from
 *    the time of the listing.
 *
 * So every directory's atime is stamped from ONE anchor per process, half an
 * hour ahead of the moment this module loaded (plus the entry's fraction):
 * newer than its 2023 mtime, newer than the ctime the stamp sets for the
 * first half hour, less than a day old, and within the hour of any listing in
 * the first ninety minutes — no rule on the three platforms fires. One anchor
 * per process, not per call, is what makes every re-stamp write the same
 * values, so the equivalence gate's runs, each after a re-stamp, see one tree.
 * A process past its first half hour is refused rather than allowed to stamp
 * a tree Linux would move. A stamped tree keeps its times through any number
 * of walks, and within one process its digest is a function of the tree
 * alone; the directories' accessedAt column differs between processes by
 * design, and nothing compares digests across processes. Layout:
 *
 *   links/file/{target.txt, to-file}      links/broken/dangling
 *   links/loop/{loop-a, loop-b, self, into-siblings}
 *   hardlinks/{a.bin, b.bin, sub/c.bin}   sparse/{small.img, over-4gib.img}
 *   zero/empty.bin                        names/{odd, normalization, case}/…
 *   deep/<40-char components>/leaf.txt    denied/secret/inner.txt (chmod 000)
 *   mounts/{nested, readonly}             ← hdiutil sparse images, kept OUTSIDE the root in `<root>.images`
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export type CaseResult<T extends object = Record<never, never>> =
  | ({ built: true } & T)
  | { built: false; reason: string };

export interface EdgeCases {
  symlinkToFile: CaseResult<{ link: string; target: string; targetBytes: number; linkBytes: number }>;
  brokenSymlink: CaseResult<{ link: string; linkBytes: number }>;
  circularSymlinks: CaseResult<{ pair: [string, string]; selfLoopDir: string; intoSiblings: string }>;
  hardlinkFamily: CaseResult<{ family: string[]; bytes: number }>;
  sparseFile: CaseResult<{ file: string; logicalSize: number }>;
  sparseFileOver4GiB: CaseResult<{ file: string; logicalSize: number }>;
  zeroByteFile: CaseResult<{ file: string }>;
  oddNames: CaseResult<{ dir: string; names: string[] }>;
  /** `listed` is what readdir returned: one entry when the file system folds the forms, two when it keeps both. */
  nfcNfdPair: CaseResult<{ dir: string; nfc: string; nfd: string; listed: string[]; folded: boolean }>;
  caseCollision: CaseResult<{ dir: string; names: string[] }>;
  longPath: CaseResult<{ leaf: string; length: number }>;
  deniedDirectory: CaseResult<{ dir: string; hiddenFile: string }>;
  nestedMount: CaseResult<{ mountPoint: string; files: string[] }>;
  readOnlyMount: CaseResult<{ mountPoint: string; files: string[] }>;
}
export type EdgeCaseName = keyof EdgeCases;

export interface EdgeCaseFixture {
  /** The scan root (real path). */
  root: string;
  cases: EdgeCases;
  /** Absolute paths of every hard-link family built, for the canonical digest. */
  hardlinkFamilies: string[][];
  /** Entries whose times could not be stamped (a read-only volume, a refused listing), with the errno. */
  unstamped: string[];
  /**
   * Every directory under the root, the root included, as the builder's
   * stamping walk found them on this platform: what the time-stable test holds
   * its own walk to, so a platform that builds fewer is never held to more.
   */
  directories: string[];
  /** Restores permissions, detaches the mounts, removes the root and the images. Throws if a mount cannot be detached. */
  cleanup(): Promise<void>;
}

export interface FreezeOptions {
  /** Seconds since the epoch of the first entry; default 1,700,000,000 (14 November 2023). */
  baseSeconds?: number;
  /** Whether mtimes carry sub-second fractions (default true); false stamps whole seconds, which is what gdu can report. */
  fractions?: boolean;
  /** The clock, in seconds since the epoch, that the anchor check reads; default now. For tests: it moves the check, never the stamps. */
  nowSeconds?: number;
}
export interface FreezeReport {
  stamped: number;
  skipped: Array<{ path: string; code: string }>;
  /** Every directory the walk entered, the root included, in walk order: listed, or refused with the refusal in `skipped`. */
  directories: string[];
}

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;
export const SPARSE_SMALL_BYTES = 16 * MiB;
export const SPARSE_OVER_4GIB_BYTES = 4 * GiB + 4096;
export const HARDLINK_BYTES = 12_345;
const SYMLINK_TARGET_BYTES = 4_321;
const LONG_PATH_TARGET = 300;
const LONG_PATH_COMPONENT = 40;
const IMAGE_SIZE = '8m';
const HDIUTIL_TIMEOUT_MS = 60_000;
const DETACH_ATTEMPTS = 3;
const DETACH_RETRY_MS = 500;
export const FREEZE_BASE_SECONDS = 1_700_000_000;
/** Cycled per entry: the .9994/.9996 and .4995/.5005 pairs sit either side of a millisecond rounding boundary. */
const FRACTIONS = [0, 0.25, 0.5, 0.75, 0.9994, 0.9996, 0.0004, 0.0006, 0.4995, 0.5005];
/**
 * How far ahead of this module's load the directory atimes are stamped. Far
 * enough that for half an hour the ctime a stamp sets stays behind the atime
 * (Linux's relatime moves one that does not); near enough that the atime is
 * within the hour of every listing in the first ninety minutes (NTFS moves one
 * that is not). Half an hour is also the window for stamping: see the check
 * at the top of `freezeTimes`.
 */
const ANCHOR_AHEAD_SECONDS = 30 * 60;
/**
 * The one instant every directory atime in this process is stamped from,
 * fixed when this module loads — never per call, so a re-stamp writes exactly
 * what the last one did. Whole seconds; each directory adds its fraction.
 */
export const DIRECTORY_ATIME_ANCHOR_SECONDS = Math.floor(Date.now() / 1000) + ANCHOR_AHEAD_SECONDS;
const NFC_NAME = 'café.txt';
const NFD_NAME = 'café.txt';
const ODD_NAMES = ['with\nnewline.txt', 'with\ttab.txt', 'emoji-\u{1F642}.txt'];

const notBuilt = (reason: string): { built: false; reason: string } => ({ built: false, reason });

function describeError(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  if (e && typeof e === 'object' && typeof e.code === 'string') return `${e.code}: ${e.message}`;
  return err instanceof Error ? err.message : String(err);
}

function errnoOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

/** Runs one case; an unexpected error becomes its reason rather than a thrown build. */
async function attempt<T extends object>(fn: () => Promise<CaseResult<T>>): Promise<CaseResult<T>> {
  try {
    return await fn();
  } catch (err) {
    return notBuilt(`not built: ${describeError(err)}`);
  }
}

async function writeBytes(file: string, bytes: number, fill = 0x61): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, Buffer.alloc(bytes, fill));
}

/* ------------------------------ symlinks ------------------------------ */

async function symlinkToFile(root: string): Promise<EdgeCases['symlinkToFile']> {
  const dir = path.join(root, 'links', 'file');
  const target = path.join(dir, 'target.txt');
  await writeBytes(target, SYMLINK_TARGET_BYTES);
  const link = path.join(dir, 'to-file');
  try {
    await fsp.symlink('target.txt', link);
  } catch (err) {
    return notBuilt(`a symbolic link could not be created here: ${describeError(err)}`);
  }
  const st = await fsp.lstat(link);
  if (!st.isSymbolicLink()) return notBuilt('the link was created but lstat does not report a symbolic link');
  return { built: true, link, target, targetBytes: SYMLINK_TARGET_BYTES, linkBytes: st.size };
}

async function brokenSymlink(root: string): Promise<EdgeCases['brokenSymlink']> {
  const dir = path.join(root, 'links', 'broken');
  await fsp.mkdir(dir, { recursive: true });
  const link = path.join(dir, 'dangling');
  try {
    await fsp.symlink('no-such-target-anywhere', link);
  } catch (err) {
    return notBuilt(`a symbolic link could not be created here: ${describeError(err)}`);
  }
  const st = await fsp.lstat(link);
  return { built: true, link, linkBytes: st.size };
}

async function circularSymlinks(root: string): Promise<EdgeCases['circularSymlinks']> {
  const dir = path.join(root, 'links', 'loop');
  await fsp.mkdir(dir, { recursive: true });
  const a = path.join(dir, 'loop-a');
  const b = path.join(dir, 'loop-b');
  const self = path.join(dir, 'self');
  const intoSiblings = path.join(dir, 'into-siblings');
  try {
    await fsp.symlink('loop-b', a);
    await fsp.symlink('loop-a', b);
    // A link to its own directory: followed, it never ends. A link into a
    // sibling subtree: followed, that subtree is counted twice.
    await fsp.symlink('.', self, 'dir');
    await fsp.symlink(path.join('..', '..', 'hardlinks'), intoSiblings, 'dir');
  } catch (err) {
    return notBuilt(`a symbolic link could not be created here: ${describeError(err)}`);
  }
  return { built: true, pair: [a, b], selfLoopDir: self, intoSiblings };
}

/* ----------------------------- hard links ----------------------------- */

async function hardlinkFamily(root: string): Promise<EdgeCases['hardlinkFamily']> {
  const dir = path.join(root, 'hardlinks');
  const a = path.join(dir, 'a.bin');
  const b = path.join(dir, 'b.bin');
  const c = path.join(dir, 'sub', 'c.bin');
  await writeBytes(a, HARDLINK_BYTES, 0x41);
  await fsp.mkdir(path.dirname(c), { recursive: true });
  try {
    await fsp.link(a, b);
    await fsp.link(a, c);
  } catch (err) {
    return notBuilt(`a hard link could not be created here: ${describeError(err)}`);
  }
  const st = await fsp.lstat(a);
  if (st.nlink !== 3) return notBuilt(`the file system reports nlink ${st.nlink} for a family of three`);
  return { built: true, family: [a, b, c], bytes: HARDLINK_BYTES };
}

/* ------------------------------- sparse ------------------------------- */

async function sparseFile(root: string, name: string, size: number): Promise<CaseResult<{ file: string; logicalSize: number }>> {
  if (process.platform === 'win32') {
    return notBuilt('Stats.blocks is not reported on Windows, so a truncate-only file cannot be proven sparse (and NTFS allocates it in full without FSCTL_SET_SPARSE)');
  }
  const dir = path.join(root, 'sparse');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const fh = await fsp.open(file, 'w');
  try {
    await fh.truncate(size);
  } finally {
    await fh.close();
  }
  const st = await fsp.lstat(file);
  if (st.size !== size) {
    await fsp.rm(file, { force: true });
    return notBuilt(`the file system reports ${st.size} bytes for a ${size}-byte truncate`);
  }
  if (st.blocks !== 0) {
    await fsp.rm(file, { force: true });
    return notBuilt(`the file system allocated ${st.blocks} 512-byte blocks (${st.blocks * 512} bytes) for a truncate-only file, so it is not sparse here`);
  }
  return { built: true, file, logicalSize: size };
}

async function zeroByteFile(root: string): Promise<EdgeCases['zeroByteFile']> {
  const file = path.join(root, 'zero', 'empty.bin');
  await writeBytes(file, 0);
  return { built: true, file };
}

/* -------------------------------- names -------------------------------- */

async function oddNames(root: string): Promise<EdgeCases['oddNames']> {
  const dir = path.join(root, 'names', 'odd');
  await fsp.mkdir(dir, { recursive: true });
  const failures: string[] = [];
  for (const [i, name] of ODD_NAMES.entries()) {
    try {
      await fsp.writeFile(path.join(dir, name), Buffer.alloc(10 + i, 0x6e));
    } catch (err) {
      failures.push(`${JSON.stringify(name)} (${errnoOf(err)})`);
    }
  }
  if (failures.length > 0) {
    await fsp.rm(dir, { recursive: true, force: true });
    return notBuilt(`the file system refused ${failures.join(', ')}`);
  }
  return { built: true, dir, names: [...ODD_NAMES] };
}

async function nfcNfdPair(root: string): Promise<EdgeCases['nfcNfdPair']> {
  const dir = path.join(root, 'names', 'normalization');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, NFC_NAME), 'nfc');
  // A file system that folds the forms answers the NFD name with the NFC file;
  // writing it would only overwrite. One that keeps them apart gets a second file.
  const folded = fs.existsSync(path.join(dir, NFD_NAME));
  if (!folded) await fsp.writeFile(path.join(dir, NFD_NAME), 'nfd');
  const listed = (await fsp.readdir(dir)).sort();
  return { built: true, dir, nfc: NFC_NAME, nfd: NFD_NAME, listed, folded };
}

async function caseCollision(root: string): Promise<EdgeCases['caseCollision']> {
  const dir = path.join(root, 'names', 'case');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'A.txt'), 'upper');
  if (fs.existsSync(path.join(dir, 'a.txt'))) {
    return notBuilt('the directory is case-insensitive: A.txt and a.txt name the same entry');
  }
  await fsp.writeFile(path.join(dir, 'a.txt'), 'lower');
  const listed = await fsp.readdir(dir);
  if (listed.length !== 2) return notBuilt(`after creating A.txt and a.txt the directory lists ${listed.length} entries`);
  return { built: true, dir, names: ['A.txt', 'a.txt'] };
}

async function longPath(root: string): Promise<EdgeCases['longPath']> {
  let current = path.join(root, 'deep');
  for (let level = 0; current.length < LONG_PATH_TARGET; level++) {
    current = path.join(current, String.fromCharCode(0x61 + (level % 26)).repeat(LONG_PATH_COMPONENT));
  }
  const leaf = path.join(current, 'leaf.txt');
  await writeBytes(leaf, 33);
  if (!fs.existsSync(leaf)) return notBuilt(`the ${leaf.length}-character path was created but cannot be seen again`);
  return { built: true, leaf, length: leaf.length };
}

/* ------------------------------- refusal ------------------------------- */

interface DeniedPrepared { dir: string; hiddenFile: string }

async function prepareDenied(root: string): Promise<CaseResult<DeniedPrepared>> {
  if (process.platform === 'win32') return notBuilt('chmod cannot refuse a listing on Windows (no POSIX mode bits)');
  if (typeof process.getuid === 'function' && process.getuid() === 0) return notBuilt('running as root: chmod 000 does not refuse root a listing');
  const dir = path.join(root, 'denied', 'secret');
  const hiddenFile = path.join(dir, 'inner.txt');
  await writeBytes(hiddenFile, 77);
  return { built: true, dir, hiddenFile };
}

/** Applied after the times are stamped, because nothing under a mode-000 directory can be touched afterwards. */
async function sealDenied(prepared: DeniedPrepared): Promise<EdgeCases['deniedDirectory']> {
  await fsp.chmod(prepared.dir, 0o000);
  try {
    await fsp.readdir(prepared.dir);
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'EACCES' || code === 'EPERM') return { built: true, ...prepared };
    await fsp.chmod(prepared.dir, 0o755);
    return notBuilt(`the listing failed with ${code} rather than a refusal`);
  }
  await fsp.chmod(prepared.dir, 0o755);
  return notBuilt(`the listing was not refused after chmod 000 (uid ${process.getuid?.() ?? 'unknown'})`);
}

/* -------------------------------- mounts -------------------------------- */

type Hdiutil = { ok: true; stdout: string } | { ok: false; reason: string };

function hdiutil(args: string[]): Hdiutil {
  const r = spawnSync('hdiutil', args, { encoding: 'utf8', timeout: HDIUTIL_TIMEOUT_MS });
  if (r.error) {
    const code = errnoOf(r.error);
    return { ok: false, reason: code === 'ENOENT' ? 'hdiutil is not installed here' : `hdiutil could not be run: ${describeError(r.error)}` };
  }
  if (r.status !== 0) {
    const last = `${r.stderr}\n${r.stdout}`.trim().split('\n').filter((l) => l && !l.includes('deprecated')).pop() ?? '';
    return { ok: false, reason: `hdiutil ${args[0]} exited ${r.status ?? `on signal ${r.signal}`}: ${last}` };
  }
  return { ok: true, stdout: r.stdout };
}

function createImage(images: string, name: string, volname: string): Hdiutil & { file: string } {
  const base = path.join(images, name);
  const r = hdiutil(['create', '-size', IMAGE_SIZE, '-fs', 'APFS', '-type', 'SPARSE', '-volname', volname, base]);
  return { ...r, file: `${base}.sparseimage` };
}

async function attachAt(image: string, mountPoint: string, readonly: boolean, mounted: string[]): Promise<Hdiutil> {
  await fsp.mkdir(mountPoint, { recursive: true });
  const r = hdiutil(['attach', '-mountpoint', mountPoint, '-nobrowse', ...(readonly ? ['-readonly'] : []), image]);
  if (r.ok) mounted.push(mountPoint);
  return r;
}

function detach(mountPoint: string, mounted: string[]): string | null {
  let last = '';
  for (let attempt = 0; attempt < DETACH_ATTEMPTS; attempt++) {
    const r = hdiutil(['detach', mountPoint, ...(attempt === DETACH_ATTEMPTS - 1 ? ['-force'] : [])]);
    if (r.ok) {
      const i = mounted.indexOf(mountPoint);
      if (i !== -1) mounted.splice(i, 1);
      return null;
    }
    last = r.reason;
    spawnSync('sleep', [String(DETACH_RETRY_MS / 1000)]);
  }
  return last;
}

async function populateVolume(mountPoint: string): Promise<string[]> {
  const files = [path.join(mountPoint, 'inside', 'one.txt'), path.join(mountPoint, 'two.txt')];
  await writeBytes(files[0], 1500);
  await writeBytes(files[1], 2500);
  return files;
}

const noHdiutil = (): string | null => (process.platform === 'darwin' ? null : `hdiutil disk images exist only on macOS (this is ${process.platform})`);

async function nestedMount(root: string, images: string, mounted: string[]): Promise<EdgeCases['nestedMount']> {
  const why = noHdiutil();
  if (why) return notBuilt(why);
  const image = createImage(images, 'nested', 'TmEdgeNested');
  if (!image.ok) return notBuilt(image.reason);
  const mountPoint = path.join(root, 'mounts', 'nested');
  const attached = await attachAt(image.file, mountPoint, false, mounted);
  if (!attached.ok) return notBuilt(attached.reason);
  const files = await populateVolume(mountPoint);
  return { built: true, mountPoint, files };
}

async function readOnlyMount(root: string, images: string, mounted: string[]): Promise<EdgeCases['readOnlyMount']> {
  const why = noHdiutil();
  if (why) return notBuilt(why);
  const image = createImage(images, 'readonly', 'TmEdgeReadOnly');
  if (!image.ok) return notBuilt(image.reason);
  // Filled and time-stamped while writable at a staging point outside the
  // root, then re-attached read-only where the walk will find it.
  const staging = path.join(images, 'readonly-staging');
  const attached = await attachAt(image.file, staging, false, mounted);
  if (!attached.ok) return notBuilt(attached.reason);
  await populateVolume(staging);
  freezeTimes(staging);
  const problem = detach(staging, mounted);
  if (problem) return notBuilt(`the staging volume could not be detached: ${problem}`);
  const mountPoint = path.join(root, 'mounts', 'readonly');
  const reattached = await attachAt(image.file, mountPoint, true, mounted);
  if (!reattached.ok) return notBuilt(reattached.reason);
  const files = [path.join(mountPoint, 'inside', 'one.txt'), path.join(mountPoint, 'two.txt')];
  return { built: true, mountPoint, files };
}

/* --------------------------------- times --------------------------------- */

type EntryKind = 'directory' | 'symlink' | 'other';

/**
 * Stamps every entry under `root` (and the root itself) with a deterministic
 * mtime, in a name-ordered walk so the same tree gets the same mtimes
 * anywhere. A file's or symlink's atime is its mtime plus one second; a
 * directory's is `DIRECTORY_ATIME_ANCHOR_SECONDS` plus its fraction — the
 * header says which rule on which platform each choice satisfies. Symlinks
 * are stamped with lutimes. An entry that cannot be stamped (a read-only
 * volume, a refused listing) is reported, never thrown; a process that has
 * outlived its anchor is refused outright, because every directory it
 * stamped would move at Linux's next listing.
 */
export function freezeTimes(root: string, opts: FreezeOptions = {}): FreezeReport {
  const base = opts.baseSeconds ?? FREEZE_BASE_SECONDS;
  const fractions = opts.fractions ?? true;
  const nowSeconds = opts.nowSeconds ?? Date.now() / 1000;
  if (nowSeconds >= DIRECTORY_ATIME_ANCHOR_SECONDS) {
    throw new Error(`freezeTimes: this process loaded the fixture more than ${ANCHOR_AHEAD_SECONDS / 60} minutes ago, so its directory-atime anchor is no longer ahead of the clock. A directory stamped now would carry an atime no newer than the ctime the stamp itself sets, which Linux's relatime moves at the next listing, and the tree would not stay time-stable. Stamp from a fresh process.`);
  }
  const report: FreezeReport = { stamped: 0, skipped: [], directories: [] };
  let index = 0;
  const stamp = (p: string, kind: EntryKind): void => {
    const i = index++;
    const fraction = fractions ? FRACTIONS[i % FRACTIONS.length] : 0;
    const mtime = base + i + fraction;
    const atime = kind === 'directory' ? DIRECTORY_ATIME_ANCHOR_SECONDS + fraction : mtime + 1;
    try {
      if (kind === 'symlink') fs.lutimesSync(p, atime, mtime);
      else fs.utimesSync(p, atime, mtime);
      report.stamped++;
    } catch (err) {
      report.skipped.push({ path: p, code: errnoOf(err) });
    }
  };
  const visit = (dir: string): void => {
    report.directories.push(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      report.skipped.push({ path: dir, code: `readdir ${errnoOf(err)}` });
      return;
    }
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const kind: EntryKind = e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'directory' : 'other';
      if (kind === 'directory') visit(p);
      stamp(p, kind);
    }
  };
  visit(root);
  stamp(root, 'directory');
  return report;
}

/* -------------------------------- builder -------------------------------- */

export async function buildEdgeCases(root: string): Promise<EdgeCaseFixture> {
  await fsp.mkdir(root, { recursive: true });
  const real = await fsp.realpath(root);
  const images = `${real}.images`;
  await fsp.mkdir(images, { recursive: true });
  const mounted: string[] = [];
  let deniedDir: string | null = null;

  const cleanup = async (): Promise<void> => {
    if (deniedDir) await fsp.chmod(deniedDir, 0o755).catch(() => undefined);
    const problems: string[] = [];
    for (const mountPoint of [...mounted].reverse()) {
      const problem = detach(mountPoint, mounted);
      if (problem) problems.push(`${mountPoint}: ${problem}`);
    }
    if (problems.length > 0) {
      throw new Error(`edge fixture: a mounted image could not be detached, so ${real} was left in place — detach by hand with hdiutil detach:\n${problems.join('\n')}`);
    }
    await fsp.rm(real, { recursive: true, force: true, maxRetries: 3 });
    await fsp.rm(images, { recursive: true, force: true, maxRetries: 3 });
  };

  try {
    const cases: Omit<EdgeCases, 'deniedDirectory'> = {
      symlinkToFile: await attempt(() => symlinkToFile(real)),
      brokenSymlink: await attempt(() => brokenSymlink(real)),
      circularSymlinks: await attempt(() => circularSymlinks(real)),
      hardlinkFamily: await attempt(() => hardlinkFamily(real)),
      sparseFile: await attempt(() => sparseFile(real, 'small.img', SPARSE_SMALL_BYTES)),
      sparseFileOver4GiB: await attempt(() => sparseFile(real, 'over-4gib.img', SPARSE_OVER_4GIB_BYTES)),
      zeroByteFile: await attempt(() => zeroByteFile(real)),
      oddNames: await attempt(() => oddNames(real)),
      nfcNfdPair: await attempt(() => nfcNfdPair(real)),
      caseCollision: await attempt(() => caseCollision(real)),
      longPath: await attempt(() => longPath(real)),
      nestedMount: await attempt(() => nestedMount(real, images, mounted)),
      readOnlyMount: await attempt(() => readOnlyMount(real, images, mounted)),
    };
    const prepared = await attempt(() => prepareDenied(real));
    const freeze = freezeTimes(real);
    const deniedDirectory = prepared.built ? await attempt(() => sealDenied(prepared)) : prepared;
    if (deniedDirectory.built) deniedDir = deniedDirectory.dir;
    const hardlinkFamilies = cases.hardlinkFamily.built ? [cases.hardlinkFamily.family] : [];
    return {
      root: real,
      cases: { ...cases, deniedDirectory },
      hardlinkFamilies,
      unstamped: freeze.skipped.map((s) => `${s.path} (${s.code})`),
      directories: freeze.directories,
      cleanup,
    };
  } catch (err) {
    await cleanup().catch(() => undefined);
    throw err;
  }
}

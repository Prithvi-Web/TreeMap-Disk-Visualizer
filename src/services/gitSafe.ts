import { ChildProcess, spawn } from 'child_process';
import crypto from 'crypto';
import fs, { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';

/**
 * Every git command TreeMap runs goes through this module (FG4).
 *
 * TreeMap asks git about repositories it finds under folders a person scanned — a second-hand
 * drive, an unpacked archive, a synced folder — and a repository's own `.git/config` can name
 * programs for git to start: `core.fsmonitor` during `status`, a `filter.<x>.clean` for every
 * file whose timestamps changed, hooks. Until FG4 a read-only question ("is this pushed?",
 * asked by the reclaim score on hover) started them as the user, and `git gc` ran wherever a
 * planted `.git` file pointed. So, two layers:
 *
 *  - **Every call** carries GIT_HARDENING, which switches off what git would otherwise start by
 *    itself (the file-system monitor, hooks, a pager, credential helpers, every transport), and
 *    an environment built from scratch (gitEnvironment): only what finding and starting git
 *    needs is inherited; no GIT_* variable, no HOME or XDG_CONFIG_HOME of the user's, no system
 *    or global settings, no optional locks (so `status` never rewrites the index), no prompts,
 *    no lazy fetch.
 *  - **Before any command that reads a work tree, an index, objects or refs**, the repository
 *    is vetted (vetRepository): where git says it lives — a git dir or common dir kept outside
 *    the folder must lie inside a scanned folder — and every setting it has, read by git's own
 *    parser without following includes, against an allow-list of settings that cannot start a
 *    program. A repository that fails is unknown for that repository, with the reason, and
 *    nothing else is run in it.
 *
 * The flags alone are not enough: a repository-defined clean filter still runs under them
 * (verified by the T17a review). The vetting alone would be one allow-list entry away from a
 * miss. Hence both.
 */

/**
 * Somewhere nothing can be. On POSIX, /dev/null: a device, so no hook, settings file or folder
 * can exist "under" it, and git treats every path below it as absent. On Windows `/dev/null`
 * would be read as `\dev\null` on the current drive, where any local account may make a folder,
 * so instead an unguessable name in the user's own temp folder that is never created.
 */
const NOWHERE = process.platform === 'win32'
  ? path.join(os.tmpdir(), `treemap-git-nowhere-${crypto.randomUUID()}`)
  : '/dev/null';

/** Prepended to every git argv: what git would otherwise start or reach by itself, switched off. */
export const GIT_HARDENING: readonly string[] = Object.freeze([
  '-c', 'core.fsmonitor=false',
  '-c', `core.hooksPath=${NOWHERE}`,
  '-c', 'core.pager=cat',
  '-c', 'core.untrackedCache=false',
  '-c', 'credential.helper=',
  '-c', 'protocol.allow=never',
]);

/**
 * The only names copied from the caller's environment: what finding and starting git needs.
 * Exported so the tests take the list from here rather than restating it per platform (FG4c).
 */
export const GIT_INHERITED_ENV: readonly string[] = Object.freeze(process.platform === 'win32'
  ? ['PATH', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP']
  : ['PATH', 'TMPDIR']);

const FIXED_ENV: Readonly<Record<string, string>> = Object.freeze({
  HOME: NOWHERE,
  XDG_CONFIG_HOME: NOWHERE,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? path.join(NOWHERE, 'gitconfig') : '/dev/null',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GIT_NO_LAZY_FETCH: '1',
});

/** The environment every git call runs in, built from scratch rather than inherited. */
export function gitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of GIT_INHERITED_ENV) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...FIXED_ENV };
}

/* ───────────────────────────── Running git ───────────────────────────── */

const GIT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 8 * 1024 * 1024;
const STDERR_CAP = 16 * 1024;

/** One git call, whole: the argv git is started with, its environment, folder and stdin. */
export interface GitInvocation {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdin: string;
  readonly timeoutMs: number;
}

/** How a git call ended. `stopped`: the reader heard enough and git was told to stop. */
export interface GitExit {
  code: number | null;
  stderr: string;
  stopped?: boolean;
  error?: string;
}

/** Starts git for `inv`, handing stdout to `sink` as it arrives; `sink` answers true once it has heard enough. */
export type GitSpawn = (inv: GitInvocation, sink: (chunk: string) => boolean) => Promise<GitExit>;

const realSpawn: GitSpawn = (inv, sink) => new Promise((resolve) => {
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const done = (exit: GitExit): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolve(exit);
  };
  let child: ChildProcess;
  try {
    child = spawn('git', [...inv.args], { cwd: inv.cwd, env: inv.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    done({ code: null, stderr: '', error: err instanceof Error ? err.message : String(err) });
    return;
  }
  let stderr = '';
  let stopped = false;
  timer = setTimeout(() => {
    child.kill();
    done({ code: null, stderr, error: `git did not answer within ${String(inv.timeoutMs / 1000)} s` });
  }, inv.timeoutMs);
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (stopped) return;
    if (sink(chunk)) {
      stopped = true;
      child.kill();
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < STDERR_CAP) stderr += chunk;
  });
  child.on('error', (err) => done({ code: null, stderr, error: err.message }));
  child.on('close', (code) => done({ code, stderr, stopped }));
  child.stdin?.on('error', () => { /* git exited before reading; its exit says why */ });
  child.stdin?.end(inv.stdin);
});

let spawnStep: GitSpawn = realSpawn;

/**
 * Test-only: start nothing, and hand every git call to `step` instead (tests/fixtures/
 * gitRecorder.ts records and answers them). null puts real git back.
 */
export function setGitSpawnForTests(step: GitSpawn | null): void {
  spawnStep = step ?? realSpawn;
}

export interface GitCall {
  /** The repository the call is about: git is told never to look above it (GIT_CEILING_DIRECTORIES). */
  repoRoot?: string;
  stdin?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  /** `check-ignore` exits 1 to mean "nothing matched" — an answer, for that command only. */
  exitOneIsEmpty?: boolean;
  /** Reads stdout as it arrives instead of collecting it; true once it has heard enough. */
  onStdout?: (chunk: string) => boolean;
  /** Only for the one call that reads the user's own global settings (userExcludesFile). */
  env?: NodeJS.ProcessEnv;
}

export type GitRun = { ok: true; stdout: string; stderr: string } | { ok: false; error: string };

/**
 * Where git is started: outside any repository (each call names its repository with -C). On
 * Windows a program name is looked for in the working folder before PATH, so there it is the
 * Windows folder, which only administrators can write, never the user's temp folder.
 */
function startFolder(): string {
  if (process.platform === 'win32') return process.env.SystemRoot || process.env.windir || os.tmpdir();
  return os.tmpdir();
}

/** The whole invocation for `args`: GIT_HARDENING first, the environment from scratch, started outside any repository. */
export function gitInvocation(args: readonly string[], call: GitCall = {}): GitInvocation {
  const env = call.env ?? gitEnvironment();
  return {
    args: [...GIT_HARDENING, ...args],
    env: call.repoRoot ? { ...env, GIT_CEILING_DIRECTORIES: path.dirname(call.repoRoot) } : env,
    cwd: startFolder(),
    stdin: call.stdin ?? '',
    timeoutMs: call.timeoutMs ?? GIT_TIMEOUT_MS,
  };
}

/** Runs an invocation exactly as given. */
export async function runGitInvocation(inv: GitInvocation, call: GitCall = {}): Promise<GitRun> {
  const limit = call.maxBuffer ?? MAX_BUFFER;
  const parts: string[] = [];
  let size = 0;
  let overflow = false;
  const sink = call.onStdout ?? ((chunk: string): boolean => {
    size += chunk.length;
    if (size > limit) {
      overflow = true;
      return true;
    }
    parts.push(chunk);
    return false;
  });
  const exit = await spawnStep(inv, sink);
  if (exit.error !== undefined) return { ok: false, error: exit.error };
  if (overflow) return { ok: false, error: `git answered with more than ${String(limit)} characters` };
  const stdout = parts.join('');
  if (exit.stopped || exit.code === 0) return { ok: true, stdout, stderr: exit.stderr };
  // `check-ignore` exits 1 to mean "nothing matched" — an answer, and scoped to that one command
  // on purpose: applied everywhere it made a `git status` that exits 1 read as a clean, empty
  // work tree, and with a remote and ahead=0 a confident "deleting this costs one git clone" for
  // a repository whose state was never read. A failure must look like a failure.
  if (call.exitOneIsEmpty && exit.code === 1) return { ok: true, stdout, stderr: exit.stderr };
  const first = exit.stderr.trim().split('\n')[0];
  return { ok: false, error: first || `git exited with code ${String(exit.code)}` };
}

/** Runs `git <GIT_HARDENING> <args>` in the environment from scratch. */
export function runGit(args: readonly string[], call: GitCall = {}): Promise<GitRun> {
  return runGitInvocation(gitInvocation(args, call), call);
}

/* ───────────────────────────── Vetting a repository ───────────────────────────── */

/** A repository that passed vetRepository: where it is, and where git keeps its data. */
export interface VettedRepo {
  root: string;
  gitDir: string;
  commonDir: string;
}

/** `error`: git could not answer. `refused`: it answered, and the answer is not safe to act on. */
export type RepoVetting =
  | { ok: true; repo: VettedRepo }
  | { ok: false; kind: 'error' | 'refused'; reason: string };

export interface VetOptions {
  /** Whether a path lies inside a scanned folder. Absent, every redirect is refused. */
  insideScannedRoot?: (p: string) => boolean;
}

async function real(p: string): Promise<string | null> {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

/** A name for display: control characters shown as `?`, and long ones cut. */
function shown(text: string): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, '?');
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}

const refused = (reason: string): RepoVetting => ({ ok: false, kind: 'refused', reason });

/**
 * Git's refusal of a repository another account owns, as git prints it with no language set —
 * which no call passes. Git for Windows may still answer in Windows' own language; then git's
 * own first line is the reason, as for any other failure.
 */
const DUBIOUS_OWNERSHIP = /detected dubious ownership/i;

/** Where git says the repository at `root` is: its folder, git dir and common dir, resolved. */
async function whereGitWorks(root: string): Promise<RepoVetting> {
  const where = await runGit(['-C', root, 'rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { repoRoot: root });
  if (!where.ok && DUBIOUS_OWNERSHIP.test(where.error)) {
    // Git's own advice (add a safe.directory exception to the global settings) cannot work here:
    // no TreeMap call reads those settings, on purpose (FG4c, review #22).
    return {
      ok: false,
      kind: 'error',
      reason: 'it belongs to another account on this computer, and Git does not read a repository another account owns; '
        + 'TreeMap does not use your Git settings, so a safe.directory exception there cannot help',
    };
  }
  if (!where.ok) return { ok: false, kind: 'error', reason: where.error };
  const [top, gitDirRaw, commonRaw] = where.stdout.split('\n');
  if (!top || !gitDirRaw || !commonRaw) return refused(`Git did not say where the project at ${shown(root)} keeps its data, so TreeMap did not run Git on it.`);
  const [realRoot, realTop, gitDir, commonDir] = await Promise.all([
    real(root), real(path.resolve(top)), real(path.resolve(gitDirRaw)), real(path.resolve(root, commonRaw)),
  ]);
  if (!realRoot || !gitDir || !commonDir || realTop !== realRoot) {
    return refused(`Git treats ${shown(top)} as this project's folder, not ${shown(root)}, so TreeMap did not run Git on it.`);
  }
  return { ok: true, repo: { root, gitDir, commonDir } };
}

/** A network path (`\\server\share`, `//server/share`): git is never sent to one. */
function isNetworkPath(p: string): boolean {
  return /^(\\\\|\/\/)/.test(p);
}

/** Opened without following a link and without waiting on a pipe; flags a platform lacks are 0. */
const POINTER_OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/** The first line of a pointer file (`.git`'s `gitdir: …`, a `commondir`), after `prefix`; at most 4 KiB read. */
async function pointerTarget(file: string, prefix: string): Promise<string | null> {
  const handle = await fsp.open(file, POINTER_OPEN_FLAGS);
  try {
    if (!(await handle.stat()).isFile()) return null;
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const line = buf.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)[0] ?? '';
    return line.startsWith(prefix) ? line.slice(prefix.length).trim() : null;
  } finally {
    await handle.close();
  }
}

/** Where a pointer leads, or why git must not be sent there. */
type Leads = { to: string } | { refusal: string };

/**
 * Where the pointer text `raw` (a `.git` file's `gitdir:`, a `.git` link, a `commondir`, an
 * `alternates` line, a link in the git folder), read relative to `base`, leads — resolved as git
 * and the operating system resolve it: links first, then `..`, by realpath on the text as it is
 * written. `path.resolve` would drop `..` before a link is followed, and so judge a place git
 * never goes (FG4c, review #2). A network path is refused before anything is resolved (on
 * Windows, resolving one contacts the server), and so is a target that is not there — there is
 * nothing to judge — or one outside every scanned folder.
 */
async function pointerLeads(raw: string, base: string, opts: VetOptions): Promise<Leads> {
  const network = { refusal: `Git keeps this project's data on a network share (${shown(raw)}), so TreeMap did not run Git on it.` };
  if (isNetworkPath(raw)) return network;
  const target = await real(path.isAbsolute(raw) ? raw : `${base}${path.sep}${raw}`);
  if (target === null) return { refusal: `Git would be sent to ${shown(raw)}, which is not there, so TreeMap did not run Git on it.` };
  if (isNetworkPath(target)) return network;
  if (!opts.insideScannedRoot?.(target)) {
    return { refusal: `Git keeps this project's data at ${shown(target)}, outside every folder you scanned, so TreeMap did not run Git on it.` };
  }
  return { to: target };
}

/** How many levels of borrowed object folders git follows (its own limit, `alternates` in a borrowed folder included). */
const ALTERNATES_DEPTH = 5;
/** An `alternates` file longer than this is not read, and the repository is refused. */
const ALTERNATES_LIMIT = 64 * 1024;
/** A git folder with more top-level entries than this is not looked through, and the repository is refused. */
const TOP_LEVEL_LIMIT = 10_000;

/** A whole small file, opened without following a link or waiting on a pipe; null when it is not a plain file or is too long. */
async function smallFile(file: string, limit: number): Promise<string | null> {
  const handle = await fsp.open(file, POINTER_OPEN_FLAGS);
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > limit) return null;
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

const C_ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };

/**
 * A line git reads as C-quoted (`"…"`, as `unquote_c_style` does): its text, or null when it is
 * not quoted that way — then git reads the line as it is. `trailing` is set when text follows the
 * closing quote, which git would read as a second entry.
 */
function unquoteC(line: string): { text: string; trailing: boolean } | null {
  const bytes: number[] = [];
  let i = 1;
  while (i < line.length) {
    const c = line[i];
    if (c === '"') return { text: Buffer.from(bytes).toString('utf8'), trailing: i + 1 < line.length };
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      i += 1;
      continue;
    }
    const next = line[i + 1] ?? '';
    if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next]);
      i += 2;
    } else if (/^[0-3][0-7][0-7]$/.test(line.slice(i + 1, i + 4))) {
      bytes.push(parseInt(line.slice(i + 1, i + 4), 8));
      i += 4;
    } else {
      return null;
    }
  }
  return null;
}

/**
 * Why git must not read the object folders `objects` borrows (its `info/alternates`, and theirs in
 * turn, as git follows them), or null (FG4c, review #1). Git reads them during the first
 * `rev-parse`, before any setting is vetted; a line naming a folder outside every scan or a
 * network share refuses the repository, as a `.git` pointer does. Lines are git's: `#` starts a
 * comment, a blank line is skipped, a relative one is read from the objects folder.
 */
async function alternatesRefusal(objects: string, opts: VetOptions, depth: number, seen: Set<string>): Promise<string | null> {
  if (seen.has(objects)) return null;
  seen.add(objects);
  const file = path.join(objects, 'info', 'alternates');
  if (!(await fsp.lstat(file).catch(() => null))) return null;
  if (depth >= ALTERNATES_DEPTH) return `${shown(file)} borrows objects more than ${String(ALTERNATES_DEPTH)} folders deep, so TreeMap did not run Git on it.`;
  const text = await smallFile(file, ALTERNATES_LIMIT);
  if (text === null) return `${shown(file)} is not a plain file TreeMap can read whole, so TreeMap did not run Git on it.`;
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const quoted = line.startsWith('"') ? unquoteC(line) : null;
    if (quoted?.trailing) return `${shown(file)} holds a line TreeMap cannot read as Git does, so TreeMap did not run Git on it.`;
    const leads = await pointerLeads(quoted ? quoted.text : line, objects, opts);
    if ('refusal' in leads) return leads.refusal;
    const deeper = await alternatesRefusal(leads.to, opts, depth + 1, seen);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * Why git must not be sent where a link at the top of the git folder `dir` leads (a linked
 * `objects`, `refs`, `config`, `HEAD`…), or null: git follows each while it starts, before any
 * setting is vetted (FG4c). A link deeper inside is not looked for here (RISKS R115).
 */
async function topLevelLinkRefusal(dir: string, opts: VetOptions): Promise<string | null> {
  let count = 0;
  for await (const entry of await fsp.opendir(dir)) {
    if (++count > TOP_LEVEL_LIMIT) return `${shown(dir)} holds too many entries to check, so TreeMap did not run Git on it.`;
    if (!entry.isSymbolicLink()) continue;
    const link = path.join(dir, entry.name);
    const leads = await pointerLeads(await fsp.readlink(link), dir, opts);
    if ('refusal' in leads) return leads.refusal;
  }
  return null;
}

/**
 * Where `.git` at `root` points, read by TreeMap itself before git is started (FG4, FG4c): a
 * `.git` link, a `.git` file (`gitdir: …`) and a `commondir` file (in `.git`, or in the folder a
 * `.git` file names — one level, as git follows it), a link at the top of either git folder, and
 * the object folders either borrows (`objects/info/alternates`) can send git anywhere — a folder
 * no scan covers, a network share (on Windows, one that is sent the user's credentials), a pipe
 * that never answers. Each target must be a local path inside a scanned folder, or git is not
 * run at all.
 */
async function pointerRefusal(root: string, opts: VetOptions): Promise<string | null> {
  const dotGit = path.join(root, '.git');
  const st = await fsp.lstat(dotGit).catch(() => null);
  if (!st) return null; // no .git: git itself answers "not a repository"
  let gitDir = dotGit;
  if (st.isSymbolicLink() || st.isFile()) {
    const raw = st.isSymbolicLink() ? await fsp.readlink(dotGit) : await pointerTarget(dotGit, 'gitdir:');
    if (raw === null || raw === '') return `${shown(dotGit)} is a file that does not name a git folder, so TreeMap did not run Git on it.`;
    const leads = await pointerLeads(raw, root, opts);
    if ('refusal' in leads) return leads.refusal;
    gitDir = leads.to;
  } else if (!st.isDirectory()) {
    return `${shown(dotGit)} is not a file or folder, so TreeMap did not run Git on it.`;
  }
  let commonDir = gitDir;
  const common = path.join(gitDir, 'commondir');
  const cst = await fsp.lstat(common).catch(() => null);
  if (cst) {
    const raw = cst.isFile() ? await pointerTarget(common, '') : null;
    if (raw === null || raw === '') return `${shown(common)} does not name a git folder, so TreeMap did not run Git on it.`;
    const leads = await pointerLeads(raw, gitDir, opts);
    if ('refusal' in leads) return leads.refusal;
    commonDir = leads.to;
  }
  const seen = new Set<string>();
  for (const dir of new Set([gitDir, commonDir])) {
    const why = (await topLevelLinkRefusal(dir, opts)) ?? (await alternatesRefusal(path.join(dir, 'objects'), opts, 0, seen));
    if (why) return why;
  }
  return null;
}

/**
 * Vets the repository at `root` before anything reads its work tree: where `.git` points, read
 * by TreeMap before git starts; where git says it keeps its data; and every setting it has. Runs
 * `rev-parse` and `config --list` only — neither starts a program whatever the repository says.
 */
export async function vetRepository(root: string, opts: VetOptions = {}): Promise<RepoVetting> {
  const pointer = await pointerRefusal(root, opts).catch((err: unknown) =>
    `Where ${shown(root)}/.git points could not be read (${err instanceof Error ? err.message : String(err)}), so TreeMap did not run Git on it.`);
  if (pointer) return refused(pointer);
  const where = await whereGitWorks(root);
  if (!where.ok) return where;
  const { gitDir, commonDir } = where.repo;
  const own = path.join((await real(root)) ?? root, '.git');
  for (const dir of new Set([gitDir, commonDir])) {
    if (dir === own) continue;
    if (!opts.insideScannedRoot?.(dir)) {
      return refused(`Git keeps this project's data at ${shown(dir)}, outside every folder you scanned, so TreeMap did not run Git on it.`);
    }
  }
  const listed = await runGit(['-C', root, 'config', '--list', '--show-origin', '--no-includes', '-z'], { repoRoot: root });
  if (!listed.ok) return { ok: false, kind: 'error', reason: listed.error };
  const entries = parseConfigList(listed.stdout);
  if (entries === null) return refused(`Git's list of the settings of ${shown(root)} could not be read, so TreeMap did not run Git on it.`);
  for (const entry of entries) {
    if (isOwnFlag(entry)) continue;
    const why = configKeyRefusal(entry.key, entry.value);
    if (why) return refused(`The Git settings of ${shown(root)} include ${shown(entry.key)}, which ${why}, so TreeMap did not run Git on it.`);
  }
  return where;
}

/* ───────────────────────────── Settings ───────────────────────────── */

export interface ConfigEntry { origin: string; key: string; value: string | null }

/**
 * Parses `git config --list --show-origin -z`: records `origin\0key\nvalue\0`, or `origin\0key\0`
 * for a key with no value. Null when the text is not of that shape — never a partial list.
 */
export function parseConfigList(stdout: string): ConfigEntry[] | null {
  if (stdout === '') return [];
  if (!stdout.endsWith('\0')) return null;
  const parts = stdout.slice(0, -1).split('\0');
  if (parts.length % 2 !== 0) return null;
  const out: ConfigEntry[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const record = parts[i + 1];
    const nl = record.indexOf('\n');
    const key = nl === -1 ? record : record.slice(0, nl);
    if (key === '') return null;
    out.push({ origin: parts[i], key, value: nl === -1 ? null : record.slice(nl + 1) });
  }
  return out;
}

/** `key=value` of every pair GIT_HARDENING sets, keys lower-cased as git prints them. */
const OWN_FLAGS: ReadonlySet<string> = new Set(
  GIT_HARDENING.filter((_, i) => i % 2 === 1).map((pair) => {
    const eq = pair.indexOf('=');
    return `${pair.slice(0, eq).toLowerCase()}=${pair.slice(eq + 1)}`;
  }),
);

function isOwnFlag(entry: ConfigEntry): boolean {
  return entry.origin === 'command line:' && OWN_FLAGS.has(`${entry.key.toLowerCase()}=${entry.value ?? ''}`);
}

/**
 * Settings without a name of their own in the middle that cannot make git start a program:
 * what git init and clone write, how data is stored, and three that every call sets on the
 * command line, which wins (core.hookspath — husky sets it — core.untrackedcache,
 * core.excludesfile). Lower case, as git prints them.
 */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates', 'core.ignorecase',
  'core.precomposeunicode', 'core.symlinks', 'core.autocrlf', 'core.safecrlf', 'core.eol', 'core.checkstat',
  'core.trustctime', 'core.quotepath', 'core.sparsecheckout', 'core.sparsecheckoutcone', 'core.commitgraph',
  'core.multipackindex', 'core.compression', 'core.loosecompression', 'core.bigfilethreshold', 'core.preloadindex',
  'core.splitindex', 'core.fscache', 'core.longpaths', 'core.protectntfs', 'core.protecthfs', 'core.abbrev',
  'core.whitespace', 'core.warnambiguousrefs', 'core.commentchar', 'core.commentstring', 'core.hidedotfiles',
  'core.fsyncobjectfiles', 'core.deltabasecachelimit', 'core.packedgitlimit', 'core.packedgitwindowsize',
  'core.fsmonitorhookversion', 'core.hookspath', 'core.untrackedcache', 'core.excludesfile',
  // Not extensions.partialclone, remote.<name>.promisor or .partialclonefilter: a partial clone
  // fetches what it lacks on demand, and GIT_NO_LAZY_FETCH exists only from git 2.44 — so a
  // partial clone is unknown rather than read.
  'extensions.objectformat', 'extensions.compatobjectformat', 'extensions.worktreeconfig',
  'extensions.preciousobjects', 'extensions.refstorage',
  'index.sparse', 'index.version', 'index.skiphash', 'index.threads', 'index.recordendofindexentries', 'index.recordoffsettable',
  'feature.manyfiles', 'feature.experimental',
  'user.name', 'user.email', 'user.signingkey', 'user.useconfigonly', 'init.defaultbranch', 'commit.gpgsign', 'tag.gpgsign',
  'push.default', 'push.autosetupremote', 'push.followtags', 'pull.rebase', 'pull.ff', 'merge.ff',
  'rebase.autosquash', 'rebase.autostash', 'fetch.prune', 'fetch.prunetags', 'fetch.recursesubmodules', 'submodule.recurse',
  'gc.auto', 'gc.autodetach', 'maintenance.auto', 'maintenance.strategy', 'lfs.repositoryformatversion', 'color.ui',
  // `git clone --recurse-submodules` writes the flat form, submodules or not (FG4c, review #15).
  'submodule.active',
  // Every submodule checkout has one. It moves the work tree, which cannot start a program, and
  // whereGitWorks refuses a repository whose work tree git places anywhere but the folder asked
  // about — asked before the settings are listed (FG4c, review #20).
  'core.worktree',
  // Written into a repository's own settings by ordinary tools and read by no command that starts
  // a program: a fork's push remote, branch set-up, shared-repository permissions, the signing
  // format (TreeMap never signs or verifies; gpg.*.program stays refused), conflict display and
  // rerere, rename detection, the untracked-files default (every status passes its own), git-lfs's
  // URL (its filters stay refused) (FG4c, review #21).
  'remote.pushdefault', 'branch.autosetupmerge', 'branch.autosetuprebase', 'core.sharedrepository', 'gpg.format',
  'merge.conflictstyle', 'rerere.enabled', 'rerere.autoupdate', 'diff.renames', 'status.showuntrackedfiles', 'lfs.url',
]);

/** Sections whose every flat key is a message switch, and nothing else: `advice.detachedHead`… */
const MESSAGE_SECTIONS: ReadonlySet<string> = new Set(['advice']);

/** Settings under a name of their own (a remote, a branch, a submodule): the keys allowed per section. */
const ALLOWED_NAMED: Readonly<Record<string, ReadonlySet<string> | 'any'>> = {
  // gh-resolved: which remote `gh repo set-default` (and a fork's `gh repo clone`) chose; git ignores it.
  remote: new Set(['url', 'pushurl', 'fetch', 'push', 'tagopt', 'prune', 'prunetags', 'mirror', 'skipdefaultupdate',
    'skipfetchall', 'followremotehead', 'gh-resolved']),
  // Git reads remote, pushremote, merge, mergeoptions, rebase and description here; editors add
  // their own (VS Code's vscode-merge-base). None of them starts anything.
  branch: 'any',
  submodule: new Set(['url', 'active', 'branch', 'ignore', 'fetchrecursesubmodules', 'shallow', 'update']),
  lfs: new Set(['access', 'locksverify']),
};

const GIT_BOOLEAN = /^(true|false|yes|no|on|off|1|0|)$/i;
const SUBMODULE_UPDATE = /^(checkout|rebase|merge|none)$/i;

/** Null when `key` (with `value`) cannot make git start a program; otherwise why it was refused. */
export function configKeyRefusal(key: string, value: string | null): string | null {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  const section = (first === -1 ? key : key.slice(0, first)).toLowerCase();
  if (section === 'include' || section === 'includeif') return 'reads more settings from another file';
  const notSafe = 'is not a setting TreeMap knows cannot start a program';
  if (first === -1) return notSafe;
  const name = key.slice(last + 1).toLowerCase();
  if (first === last) {
    const flat = `${section}.${name}`;
    if (flat === 'core.fsmonitor') return value === null || GIT_BOOLEAN.test(value) ? null : 'can start a program';
    return ALLOWED_KEYS.has(flat) || MESSAGE_SECTIONS.has(section) ? null : notSafe;
  }
  const allowed = ALLOWED_NAMED[section];
  if (allowed === 'any') return null;
  if (!allowed?.has(name)) return notSafe;
  if (section === 'submodule' && name === 'update' && !SUBMODULE_UPDATE.test(value ?? '')) return 'can start a program';
  return null;
}

/* ───────────────────────────── The user's own ignore file ───────────────────────────── */

let excludesArgs: Promise<string[]> | null = null;

/**
 * The file of ignore patterns the user's own git settings name (`core.excludesFile`), or git's
 * default for it. Every git call runs without the user's settings, so this one is read and then
 * passed explicitly: what counts as untracked is what git itself would say. Reading settings
 * starts nothing; this is the one call that sees the user's real HOME.
 */
export async function userExcludesFile(base: NodeJS.ProcessEnv = process.env): Promise<string> {
  const home = base.HOME || base.USERPROFILE || os.homedir();
  const xdg = base.XDG_CONFIG_HOME || '';
  const { GIT_CONFIG_GLOBAL: _global, XDG_CONFIG_HOME: _xdg, ...scratch } = gitEnvironment(base);
  const env: NodeJS.ProcessEnv = { ...scratch, HOME: home, ...(xdg ? { XDG_CONFIG_HOME: xdg } : {}), GIT_CEILING_DIRECTORIES: os.tmpdir() };
  const run = await runGit(['config', '--global', '--path', '--get', 'core.excludesFile'], { env });
  const named = run.ok ? run.stdout.replace(/\r?\n$/, '') : '';
  return named || path.join(xdg || path.join(home, '.config'), 'git', 'ignore');
}

/**
 * `-c core.excludesFile=<the user's>`, read once per process. When it cannot be worked out (no
 * home folder at all), nothing is passed and the next call tries again: a failure is never kept.
 */
export function userExcludesArgs(): Promise<string[]> {
  excludesArgs ??= userExcludesFile()
    .then((file) => ['-c', `core.excludesFile=${file}`])
    .catch(() => {
      excludesArgs = null;
      return [];
    });
  return excludesArgs;
}

/** Test-only: forget what was read once per process. */
export function resetGitSafeForTests(): void {
  excludesArgs = null;
}

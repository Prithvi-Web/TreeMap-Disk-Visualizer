import { promises as fsp } from 'fs';
import { runText, CommandUnavailableError, CommandFailedError, type RunOptions } from '../exec';
import type { OpenHandleInfo, ZombieHandleInfo, ZombieHandleScan } from '../types';
import { meansAbsent } from '../../utils/errno';

/**
 * Open-handle (B2) and zombie-handle (B5) detection on macOS and Linux via
 * `lsof`.
 *
 * Mechanism choice (§2.3): tier 3, a system binary. `lsof` ships with macOS and
 * with every mainstream Linux distribution, needs no entitlement to see the
 * calling user's own processes, and has a documented machine-readable mode.
 * There is no `--json`, but `-F` is not human-formatted output — it is
 * field-per-line output designed for programs, so parsing it does not violate
 * §10's "no regex over human-formatted output" rule. Linux additionally has a
 * faster no-subprocess path through /proc (see ../linux/procFdGuard.ts); this
 * module is macOS's primary mechanism and Linux's fallback.
 *
 * ── Two behaviours measured on macOS 15 (Darwin 25.5), not assumed ──
 *
 * 1. **macOS emits no `(deleted)` marker.** The widely-documented Linux
 *    behaviour of appending `(deleted)` to an unlinked-but-open file's name
 *    does not happen here: `lsof` output for a descriptor is byte-identical
 *    before and after `unlink()` — same path, same size, same inode. Detecting
 *    a zombie therefore compares lsof's `i` (inode) field against the inode
 *    currently at that path: gone, or a different inode, means the descriptor
 *    is holding an unlinked one. The `(deleted)` marker is still honoured when
 *    present, so Linux takes the cheap path and macOS the correct one.
 *
 * 2. **lsof reports resolved paths.** A handle opened on `/tmp/x` comes back as
 *    `/private/tmp/x`, because `/tmp` is a symlink. Matching results against a
 *    caller's delete set therefore compares realpaths, or every warning about a
 *    file under `/tmp`, `/var` or `/etc` would be silently missed.
 *
 * 3. **lsof escapes what it prints.** A backslash in a path or name is `\\`, a tab `\t`, and under no
 *    locale every byte past ASCII is `\xNN` (review F2.1). Both fields are read back through
 *    `decodeLsofText`, or no path holding one would match, and every such file would read as deleted.
 *    Its `^A` for a control byte cannot be undone, a caret being written as itself: a path is matched
 *    by that spelling too (`lsofReadBack`; review F3.1, F3.3), and one holding a caret is judged deleted
 *    only when no spelling its text could be holds its inode and every one could be looked at
 *    (`lsofSpellings`, BQL item 12); otherwise it is counted as undecided, never claimed.
 *
 * Field order, as emitted: `f` (descriptor) opens a block, then `t` type,
 * `D` device, `s` size, `i` inode, `n` name. State resets on each `f`.
 *
 * What this cannot see: processes owned by other users, unless TreeMap runs
 * elevated. Reported as a partial answer in the capability reason, never as a
 * confident "nothing has it open" — and the held-space panel speaks only for
 * the person's own programs (BQL item 11).
 */

/** One descriptor as reported by lsof. */
export interface LsofRecord {
  pid: number;
  processName: string;
  /** Path as lsof resolved it (symlinks already followed). */
  path: string;
  /** Inode the descriptor points at, when reported. */
  ino: number | null;
  /** Size in bytes, when reported. */
  size: number | null;
  /** True when lsof itself flagged the inode as unlinked (Linux). */
  markedDeleted: boolean;
}

/**
 * Parse lsof `-F` output into descriptor records.
 *
 * Exported because this parser is the only part of the mechanism that can be
 * asserted without a live system, and the awkward cases it must survive —
 * spaces in application names, `(deleted)` suffixes, non-file names like
 * sockets and pipes — are exactly where a naive implementation goes wrong.
 */
export function parseLsofRecords(stdout: string): LsofRecord[] {
  const out: LsofRecord[] = [];
  let pid = 0;
  let processName = '';
  let size: number | null = null;
  let ino: number | null = null;

  const intOrNull = (s: string): number | null => {
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
  };

  for (const line of stdout.split('\n')) {
    if (line.length < 2) continue;
    const code = line[0];
    const value = line.slice(1);

    switch (code) {
      case 'p':
        pid = intOrNull(value) ?? 0;
        processName = '';
        size = ino = null;
        break;
      case 'c':
        processName = decodeLsofText(value);
        break;
      case 'f': // a new descriptor block — previous per-fd fields no longer apply
        size = ino = null;
        break;
      case 's':
        size = intOrNull(value);
        break;
      case 'i':
        ino = intOrNull(value);
        break;
      case 'n': {
        if (!pid) break;
        const markedDeleted = value.endsWith('(deleted)');
        // The path as the file system spells it, not as lsof printed it (review F2.1): matched against
        // realpaths and stat'ed, the printed form finds nothing — and a file nobody deleted reads as gone.
        const path = decodeLsofText(markedDeleted ? value.slice(0, -'(deleted)'.length).trimEnd() : value);
        // Sockets, pipes, kqueues and cwd markers are not files on disk.
        if (path.startsWith('/')) out.push({ pid, processName, path, ino, size, markedDeleted });
        size = ino = null;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * The most characters of a command name lsof prints (`c`) on macOS: the kernel's process name, 32
 * bytes with its terminating NUL (sixth browser pass H04, measured: `lsof -F pc` printed
 * "Google Chrome Helper (Aperitif " for "Google Chrome Helper (Aperitif Renderer)"). A name this long
 * may be cut mid-word; Linux's names stop at 15, well short of it.
 */
export const LSOF_NAME_MAX = 31;

/**
 * One escape as lsof writes it in a name (`c`) or a path (`n`), measured on this Mac (review F1.1,
 * F2.1). A backslash is `\\` under every locale, so every backslash lsof prints starts an escape; a
 * tab, newline, backspace, form feed and carriage return are `\t`, `\n`, `\b`, `\f`, `\r`; DEL — and,
 * under no locale, as the Dock and launchd start TreeMap, every byte past ASCII — is `\xNN`. Its `^X`
 * for another control byte is not undone: lsof writes a `^` as itself, so "^A" in its text may be a
 * caret and an A, and is left as the text it is. The guard allows for it where it judges a path
 * (`lsofReadBack`, and resolveZombies; review F3.1, F3.3).
 */
const LSOF_ESCAPE = /\\(\\|x[0-9a-fA-F]{2}|[bfnrt])/;

/** The control byte each of lsof's letter escapes stands for. */
const LSOF_CONTROL: Readonly<Record<string, number>> = { b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09 };

/** The byte one of lsof's escapes (without its backslash) stands for. */
function lsofEscapeByte(body: string): number {
  if (body === '\\') return 0x5c;
  if (body.length === 3) return Number.parseInt(body.slice(1), 16);
  return LSOF_CONTROL[body];
}

/**
 * lsof's text with every escape put back as the byte it stands for, read as UTF-8 (review F1.1, F2.1):
 * "\xc3\x89cran" is "Écran", "back\\slash" is "back\slash". A character a cut went through reads back as
 * one to three U+FFFD: one under no locale, where lsof escapes each of its bytes; one per byte under a
 * UTF-8 locale, where lsof writes its first byte raw — which Node decodes as a U+FFFD — and any after it
 * as `\xNN`, each a lone byte here (measured, review F3.2).
 */
export function decodeLsofText(value: string): string {
  if (!value.includes('\\')) return value;
  // Split on one capturing group: the odd parts are the escapes' bodies, the even ones plain text.
  const parts = value.split(LSOF_ESCAPE).map((part, i) =>
    i % 2 === 1 ? Buffer.from([lsofEscapeByte(part)]) : Buffer.from(part, 'utf8'));
  return Buffer.concat(parts).toString('utf8');
}

/** The letter lsof escapes each of LSOF_CONTROL's bytes with. */
const LSOF_CONTROL_LETTER: ReadonlyMap<number, string> = new Map(Object.entries(LSOF_CONTROL).map(([letter, byte]) => [byte, letter]));

/**
 * A path as lsof writes it (`-F n`), measured on this Mac under no locale and under UTF-8 (review F2.1,
 * F3.1, F3.3), as far as reading it back can tell: a backslash as `\\`; a backspace, tab, newline, form
 * feed and carriage return as `\b`, `\t`, `\n`, `\f`, `\r`; every other control byte as `^` and the
 * character 0x40 above it (0x01 "^A", ESC "^[", 0x1c "^\"). DEL and every letter past ASCII are kept as
 * they are: lsof's `\xNN` for their bytes reads back as those bytes.
 */
function lsofPrinted(path: string): string {
  let out = '';
  for (const ch of path) {
    const c = ch.codePointAt(0) ?? 0;
    const letter = LSOF_CONTROL_LETTER.get(c);
    if (ch === '\\') out += '\\\\';
    else if (letter !== undefined) out += `\\${letter}`;
    else if (c < 0x20) out += `^${String.fromCharCode(c + 0x40)}`;
    else out += ch;
  }
  return out;
}

/**
 * The path parseLsofRecords reads back for the file at `path` (review F3.1, F3.3): `path` itself, unless
 * one of its names holds a control byte lsof writes as `^X`. That spelling cannot be undone, since lsof
 * writes a caret as itself, so the guard matches the file by the spelling instead: "a\x01b.txt" is read
 * back as "a^Ab.txt", and "c\x1cb.txt" — printed "c^\b.txt" — as a caret and a backspace.
 */
export function lsofReadBack(path: string): string {
  return decodeLsofText(lsofPrinted(path));
}

/** The most carets a path read back from lsof may hold for the guard to try every spelling it could be (BQL item 12). */
export const LSOF_CARETS_TRIED = 4;
/** The most spellings it tries for one path: four carets, each a caret, a control byte or 0x1c's run-ins, stay inside. */
const LSOF_SPELLINGS_MAX = 256;
/** The most fragments the search below looks at for one path, so no name, however written, costs an unbounded walk. */
const LSOF_SEARCH_MAX = 50_000;

/**
 * How many characters at the end of lsof's printed text a following character could still change: a
 * backslash no escape consumed, alone or with an `x` and one hex digit after it — the start of a `\xNN`
 * the next characters may finish. 0 when the text ends between escapes.
 */
function openEscapeTail(printed: string): number {
  for (let i = 0; i < printed.length; i++) {
    if (printed[i] !== '\\') continue;
    const after = printed.slice(i + 1);
    if (/^(\\|x[0-9a-fA-F]{2}|[bfnrt])/.test(after)) { i += after[0] === 'x' ? 3 : 1; continue; }
    if (/^(x[0-9a-fA-F]?)?$/.test(after)) return printed.length - i;
  }
  return 0;
}

/**
 * Every path whose spelling lsof reads back as `readBack` (BQL item 12), each verified by `lsofReadBack`;
 * null when there could be more than the guard tries — more than LSOF_CARETS_TRIED carets, or more
 * spellings or search than its bounds allow.
 *
 * lsof writes a control byte as `^` and the character 0x40 above it, and a caret as itself, so each `^X`
 * in its text may be a caret and an X or one control byte. And 0x1c's `^\` runs into what follows it: its
 * backslash and the next characters lsof prints can read back as one escape — "\x1cb" as a caret and a
 * backspace, "\x1cx41" as "^A", "\x1c\\" as a caret and two backslashes. A path with no caret is read back
 * as itself and nothing else, and so is every part of a path between one caret's spelling and the next.
 *
 * The search: from each caret, the shortest runs of characters whose printed text ends between escapes
 * and reads back as the text there, then the rest of the path the same way. A character in a spelling
 * that is not in the text itself is one of those runs' — a control byte, 0x1c, or a letter, `x`, hex
 * digit, backslash or escaped control 0x1c's backslash ran into — and those are all tried.
 */
export function lsofSpellings(readBack: string): string[] | null {
  const carets = readBack.split('^').length - 1;
  if (carets === 0) return [readBack];
  if (carets > LSOF_CARETS_TRIED) return null;
  const alphabet = new Set<string>([...readBack, '^', '\x1c', '\\', 'x', 'b', 'f', 'n', 'r', 't', '\b', '\t', '\n', '\f', '\r', ...'0123456789abcdefABCDEF']);
  for (let i = readBack.indexOf('^'); i !== -1; i = readBack.indexOf('^', i + 1)) {
    // Not "^@": NUL is in no file name, and a spelling holding one is refused by every stat before it asks
    // the system — never "no such file" — so a deleted notes^@v2.txt was left undecided (BQL-a review F1.2).
    const c = readBack.charCodeAt(i + 1);
    if (c > 0x40 && c <= 0x5f) alphabet.add(String.fromCharCode(c - 0x40));
  }
  const letters = [...alphabet];
  let searched = 0;
  let overflow = false;

  /** The shortest runs of characters at a caret whose printed text ends between escapes and reads back as `text`'s start. */
  const runsAt = (text: string): [run: string, used: number][] => {
    const runs: [string, number][] = [];
    const grow = (run: string): void => {
      if (overflow) return;
      if (++searched > LSOF_SEARCH_MAX) { overflow = true; return; }
      const printed = lsofPrinted(run);
      const back = decodeLsofText(printed);
      const open = openEscapeTail(printed);
      if (!text.startsWith(back.slice(0, back.length - open))) return;
      if (run.length > 0 && open === 0) { runs.push([run, back.length]); return; }
      // An escape left open at the very end of the text: nothing follows to finish it, so lsof's text ends
      // with it as the characters it is — "/work/rep\x1c" is printed "/work/rep^\" and read back as that. No
      // longer run reads back as this text: one more character either finishes the escape, which changes
      // what the text reads, or follows it, past the text's end (BQL-a review F1.2).
      if (run.length > 0 && back === text) { runs.push([run, back.length]); return; }
      if (run.length > 2 * text.length + 4) return;
      for (const ch of letters) grow(run + ch);
    };
    grow('');
    return runs;
  };

  const memo = new Map<string, string[] | null>();
  const spellingsOf = (text: string): string[] | null => {
    const known = memo.get(text);
    if (known !== undefined) return known;
    const at = text.indexOf('^');
    let out: string[] | null = [];
    if (at === -1) out = [text];
    else {
      const head = text.slice(0, at);
      for (const [run, used] of runsAt(text.slice(at))) {
        const tails = spellingsOf(text.slice(at + used));
        if (tails === null || overflow) { out = null; break; }
        for (const tail of tails) out.push(head + run + tail);
        if (out.length > LSOF_SPELLINGS_MAX) { out = null; break; }
      }
    }
    if (overflow) out = null;
    memo.set(text, out);
    return out;
  };
  const found = spellingsOf(readBack);
  if (found === null || overflow) return null;
  // Every spelling is checked against what lsof would print for it: none is a guess.
  const exact = [...new Set(found)].filter((p) => lsofReadBack(p) === readBack);
  return exact.length > LSOF_SPELLINGS_MAX ? null : exact;
}

/**
 * Whether lsof may have cut `name` (H04, review F1.1). It prints at most LSOF_NAME_MAX bytes — bytes,
 * not characters: "Écran Partagé Assistant Appli" is 29 characters and 31 bytes. A cut inside a
 * character leaves one to three of its bytes after the 28 to 30 before them, read back as one to three
 * U+FFFD, three bytes each: such a name counts at least 31 too.
 */
function mayBeCut(name: string): boolean {
  return Buffer.byteLength(name, 'utf8') >= LSOF_NAME_MAX;
}

/**
 * A process's name as a person reads it (H04). A name lsof cannot have cut is whole, its trailing
 * spaces dropped. One it may have cut: the executable's own name is used where it continues it, and
 * otherwise what lsof gave is said to be cut, with an ellipsis — never a name that stops mid-word on a
 * space, as "Quit Google Chrome Helper (Aperitif ?" did, nor one ending in the U+FFFDs a character the
 * cut went through reads back as \u2014 one to three of them (review F1.1, F3.2).
 */
export function displayProcessName(lsofName: string, executable: string | null): string {
  if (!mayBeCut(lsofName)) return lsofName.trimEnd();
  const kept = lsofName.replace(/\uFFFD+$/, '');
  const own = executable ? executable.slice(executable.lastIndexOf('/') + 1) : '';
  if (own.startsWith(kept)) return own;
  return `${kept.trimEnd()}…`;
}

/**
 * `rows` with every process name as `displayProcessName` says it, asking `executablesOf` once about the
 * pids whose names lsof may have cut, and nothing when none is (H04). An answer that does not come
 * leaves those names said to be cut.
 */
export async function withFullProcessNames<T extends { pid: number; processName: string }>(
  rows: T[],
  executablesOf: (pids: number[]) => Promise<Map<number, string | null>> = psExecutables,
): Promise<T[]> {
  const cut = [...new Set(rows.filter((r) => mayBeCut(r.processName)).map((r) => r.pid))];
  const executables = cut.length > 0 ? await executablesOf(cut).catch(() => new Map<number, string | null>()) : new Map<number, string | null>();
  return rows.map((r) => ({ ...r, processName: displayProcessName(r.processName, executables.get(r.pid) ?? null) }));
}

/**
 * The environment every `ps` that names a program runs with (review F1.1). Under no locale — as the
 * Dock and launchd start TreeMap — macOS's ps writes each byte past ASCII in vis notation ("É" is
 * "M-CM^I"); under a UTF-8 locale it writes the bytes, which read as the letters (measured). A name
 * compared with lsof's, an Info.plist's or another ps's must be letters on both sides.
 */
export const PS_UTF8_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({ LC_ALL: 'en_US.UTF-8' });

/** One line of `ps -o pid=,comm=`: the pid right-aligned, ONE space, then the executable — spaces and all. */
const PS_COMM_LINE = /^\s*(\d+)\s(.*)$/;

/**
 * Each pid's executable from one `ps -ww -o pid=,comm=` — the full path on macOS (measured; Linux's comm
 * is its 15-character name, but no Linux name reaches LSOF_NAME_MAX). A pid it does not list is absent.
 */
export async function psExecutables(
  pids: number[],
  run: (cmd: string, args: string[], opts?: RunOptions) => Promise<string> = runText,
): Promise<Map<number, string | null>> {
  const out = await run('ps', ['-ww', '-o', 'pid=,comm=', '-p', pids.join(',')], { timeoutMs: 5_000, env: { ...PS_UTF8_ENV } }).catch((err: unknown) => {
    // macOS's ps exits 1 when no pid in the list is running, still printing those that are.
    if (err instanceof CommandFailedError && err.exitCode === 1) return err.stdout;
    throw err;
  });
  const found = new Map<number, string | null>();
  for (const line of out.split(/\r?\n/)) {
    const m = PS_COMM_LINE.exec(line);
    if (m && m[2].trimEnd()) found.set(Number(m[1]), m[2].trimEnd());
  }
  return found;
}

/** Resolve symlinks so lsof's answers and the caller's paths can be compared. */
async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return p;
  }
}

/**
 * Run lsof, tolerating its non-zero exits — but only the ones that mean
 * something.
 *
 * Measured: lsof exits **1** when nothing matches (the common, boring case)
 * *and* when any single path argument no longer exists — while still printing
 * complete records for every path that does. Both are ordinary during a
 * delete batch, where files legitimately vanish between listing and
 * confirming, so `exitCode === 1` with usable stdout is data, not failure.
 *
 * Every OTHER failure reports `exitCode: null` — measured on this Mac, that
 * is what a timeout kill and a `maxBuffer` overflow both produce. Those used
 * to be treated identically to the exit-1 case, which meant a killed run
 * returned empty stdout and a TRUNCATED run returned a partial record set,
 * and both were then reported to the caller as `checked: true` with no
 * conflicts. Reproduced: with `lsof` replaced by a stub that prints partial
 * output and exits 1, a file genuinely held open by another process came back
 * as `{ conflicts: 0, checked: true, complete: true }` — indistinguishable
 * from a clean answer, and `moveToTrash` proceeds on it.
 *
 * This module's own header states the rule it was violating: a guard that
 * cannot check must never answer "nothing is open". So anything that is not
 * the understood exit-1 case is rethrown, and `checkOpenHandles` turns it
 * into the `checked: false` state it has always had — and always tested.
 */
async function runLsof(args: string[], timeoutMs: number, maxBuffer?: number): Promise<string> {
  try {
    return await runText('lsof', args, { timeoutMs, ...(maxBuffer ? { maxBuffer } : {}) });
  } catch (err) {
    if (err instanceof CommandUnavailableError) throw err;
    if (err instanceof CommandFailedError && err.exitCode === 1) return err.stdout;
    throw err;
  }
}

/**
 * Which processes hold any of `paths` — **or anything beneath them** — open.
 *
 * ── Why one full enumeration rather than `lsof <path> <path> …` ──
 *
 * Measured on macOS 15: `lsof /some/dir` reports processes whose *own* cwd or
 * descriptor is that directory, and says **nothing** about a file open inside
 * it. So the targeted form silently passes a folder full of open files — and
 * trashing folders is most of what TreeMap's Clean Up view does (`node_modules`
 * while a dev server holds a log open is the everyday case). A guard that
 * quietly answers "nothing is open" there is worse than no guard.
 *
 * `lsof +D <dir>` does descend, but it stats every file in the tree, so a batch
 * mixing several large folders becomes several deep walks.
 *
 * One unfiltered enumeration, intersected against the delete set in memory, is
 * what §B2 actually prescribes ("do one enumeration pass and intersect against
 * the delete set") and it fixes both problems at once: exactly one subprocess
 * whatever the batch looks like, and descendants come free from prefix
 * matching. Measured on this Mac: ~170 ms warm for ~12,500 open file
 * descriptors, independent of how many paths are being deleted.
 */
export async function openHandlesFor(paths: string[]): Promise<OpenHandleInfo[]> {
  if (paths.length === 0) return [];

  const resolved = await Promise.all(paths.map(async (p) => [await realpathOrSelf(p), p] as const));
  const stdout = await runLsof(['-F', 'pcnfsi', '-w'], 30_000, 64 * 1024 * 1024);
  // Named whole (H04): the warning lists programs by name, and lsof cuts a long one at 31 characters.
  return withFullProcessNames(intersectHandles(parseLsofRecords(stdout), resolved));
}

/**
 * Intersect open descriptors with the delete set, matching descendants.
 *
 * Pure and exported: this is where the correctness lives, and it is the only
 * part testable without a live process holding real files open.
 *
 * `wanted` maps each realpath to the path the caller asked about, so a warning
 * names the file the user is looking at rather than lsof's resolved form
 * (`/tmp/x` comes back as `/private/tmp/x`).
 */
export function intersectHandles(
  records: LsofRecord[],
  wanted: readonly (readonly [resolved: string, requested: string])[],
): OpenHandleInfo[] {
  // Each path by its own spelling and by the one lsof's text is read back as (review F3.1, F3.3): a name
  // holding a control byte lsof writes as `^X` comes back with the caret, never with the byte.
  const spellings = wanted.flatMap(([resolved, requested]) => {
    const readBack = lsofReadBack(resolved);
    return readBack === resolved ? [[resolved, requested] as const] : [[resolved, requested] as const, [readBack, requested] as const];
  });
  const exact = new Map(spellings);
  // Directory prefixes carry a trailing separator so that deleting `/a/logs`
  // does not claim `/a/logs-archive/x` — a false warning about an unrelated
  // file is how a guard trains people to click through it. (No escape lsof
  // writes holds a `/`, so a folder's spelling begins its files' spellings.)
  const prefixes = spellings.map(([resolved, requested]) => [`${resolved.replace(/\/+$/, '')}/`, requested] as const);

  const seen = new Set<string>();
  const out: OpenHandleInfo[] = [];
  for (const rec of records) {
    if (rec.markedDeleted) continue; // an unlinked inode blocks no delete

    let requested = exact.get(rec.path);
    if (requested === undefined) {
      // Deepest match wins, so a set holding both a folder and a file inside it
      // attributes the handle to the file the user can actually see.
      let best = '';
      for (const [prefix, asked] of prefixes) {
        if (rec.path.startsWith(prefix) && prefix.length > best.length) {
          best = prefix;
          requested = asked;
        }
      }
      if (requested === undefined) continue;
    }

    const key = `${rec.pid}\0${requested}\0${rec.path}`;
    if (seen.has(key)) continue; // one process, many descriptors, one warning
    seen.add(key);
    out.push({ path: requested, pid: rec.pid, processName: rec.processName, openPath: rec.path });
  }
  return out;
}

/**
 * Files deleted while still open: their blocks stay allocated until the last
 * descriptor closes, which is how a disk can be full with nothing visible to
 * account for it.
 *
 * Uses lsof's own `(deleted)` marker where the platform emits it, and falls
 * back to comparing the descriptor's inode against what is at that path now —
 * which is the only mechanism that works on macOS (see the note at the top).
 */
export async function zombieHandles(): Promise<ZombieHandleInfo[]> {
  return (await zombieHandleScan()).handles;
}

/** The same pass, with how many open files it could not decide (BQL item 11). */
export async function zombieHandleScan(): Promise<ZombieHandleScan> {
  const stdout = await runLsof(['-F', 'pcnfsi', '-w'], 30_000, 64 * 1024 * 1024);
  return resolveZombieScan(parseLsofRecords(stdout), (p) => fsp.stat(p).then((st) => st.ino));
}

/**
 * Decide which records describe unlinked inodes.
 *
 * `inoAt` is injected so this — the part that carries the actual correctness
 * risk — is unit-testable without unlinking files under a live process.
 */
export async function resolveZombies(
  records: LsofRecord[],
  inoAt: (path: string) => Promise<number>,
): Promise<ZombieHandleInfo[]> {
  return (await resolveZombieScan(records, inoAt)).handles;
}

/** resolveZombies, with how many held files it could not decide (BQL item 11). */
export async function resolveZombieScan(
  records: LsofRecord[],
  inoAt: (path: string) => Promise<number>,
): Promise<ZombieHandleScan> {
  const out: ZombieHandleInfo[] = [];
  // One stat per distinct path, not per descriptor: a browser can hold hundreds
  // of descriptors on the same handful of files. Only "no such file" means the
  // path is gone (`meansAbsent`, not the wider `meansGone`: a path the kernel
  // will not resolve is not proof of a deletion); any other failure
  // (permission denied under a root-only folder, QA D17) says nothing about
  // the file, so it is unknown, not deleted.
  const inoCache = new Map<string, Promise<number | 'gone' | 'unknown'>>();
  const lookup = (p: string): Promise<number | 'gone' | 'unknown'> => {
    let hit = inoCache.get(p);
    if (!hit) {
      hit = inoAt(p).catch((err: unknown) => (meansAbsent(err) ? 'gone' as const : 'unknown' as const));
      inoCache.set(p, hit);
    }
    return hit;
  };

  // Deduplicate by (pid, inode): the same unlinked inode held on several
  // descriptors is one leak, not several, and counting it twice would overstate
  // reclaimable bytes — precisely the kind of confidently-wrong number §10 bans.
  const seen = new Set<string>();
  // The held files it could not decide, each once however many descriptors and programs hold it (BQL item
  // 11): never claimed either way, but counted, so the panel says it did not check them rather than "nothing
  // is held".
  const undecided = new Set<string>();

  for (const rec of records) {
    let isZombie = rec.markedDeleted;
    if (!isZombie) {
      // No inode reported — cannot know, so don't claim. Not counted either: lsof shows a few such records
      // on a Mac, all where Unix sockets live, and they hold no space.
      if (rec.ino === null) continue;
      // lsof writes a control byte as `^X` and a caret as itself (review F3.1, F3.3), so a path holding a
      // caret is any of the spellings its text could be (BQL item 12): the file was at one of them. In use
      // when one holds its inode; deleted only when none does and every one could be looked at; otherwise —
      // a spelling that cannot be looked at, or more spellings than the guard tries — cannot know, so don't
      // claim, and count it. Where lsof marks a file (deleted) itself, that still counts.
      const spellings = rec.path.includes('^') ? lsofSpellings(rec.path) : [rec.path];
      const places = spellings === null ? null : await Promise.all(spellings.map(lookup));
      if (places?.includes(rec.ino)) continue;
      if (places === null || places.includes('unknown')) { // could not look — cannot know, so don't claim
        undecided.add(`${rec.ino}\0${rec.path}`);
        continue;
      }
      isZombie = true; // gone from every spelling, or another inode in its place
    }
    if (!isZombie) continue;
    const key = `${rec.pid}\0${rec.ino ?? rec.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pid: rec.pid, processName: rec.processName, path: rec.path, bytes: rec.size, ino: rec.ino });
  }
  return { handles: out, undecided: undecided.size };
}

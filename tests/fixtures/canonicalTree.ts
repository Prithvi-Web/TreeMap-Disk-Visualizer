/**
 * The canonical digest of a scan (Phase 3, W3; DESIGN.md §5.1 and decision P3-8).
 *
 * Two engines walking one tree must produce the same store — the same entries,
 * parents, sizes, times and flags — but two legacy walks are not byte-identical
 * to each other on exactly two order-dependent facts: the order a listing
 * returns children in, and which name of a hard-link family was seen first
 * (and therefore carries the bytes). The digest normalises those two facts and
 * nothing else:
 *
 *  - visit from the root; at each node with a child array, the live children are
 *    sorted by the bytes of their names (`Buffer.compare`), so the listing order
 *    the engine happened to produce never reaches the digest;
 *  - for every hard-link family the caller names (absolute paths, as the corpus
 *    manifest and the edge fixture list them), the member with the smallest
 *    path in byte order owns the family's bytes — its line carries the size and
 *    no `hardlinkDup`; every other member is size 0 with `hardlinkDup`; and the
 *    directory totals move with the bytes. The owner's size is the SUM of what
 *    the members carry, so an engine that counted the family twice still differs.
 *
 * One line per node, tab-separated, ten columns:
 *   depth, name, type, size, modifiedAt, accessedAt, flags, extension, container, cloudProvider
 * An absent value is `-`. `flags` is five bits in the fixed order hidden,
 * symlink, hardlinkDup, cloudPlaceholder, gitRepo. A tab, newline, carriage
 * return or backslash inside a name (or an extension) is escaped (`\t`, `\n`,
 * `\r`, `\\`) so a name can never add a column or a line; the escape is
 * injective, so two different names never produce one line. The digest is
 * SHA-256 over the lines joined by `\n`.
 *
 * Also here: the eleven stats counters the equivalence gate compares, and the
 * first-difference locator the failure message uses. Pure over `ScanStore`;
 * imports no service, so `bench/` can use it too.
 */
import { createHash } from 'node:crypto';
import { Flag, type ScanStore } from '../../src/services/scanStore';
import type { ScanResult } from '../../src/models/types';

export interface CanonicalOptions {
  /** Hard-link families as absolute paths; a member the store does not hold is ignored. */
  hardlinkFamilies?: ReadonlyArray<ReadonlyArray<string>>;
}

/** The counters the gate compares, in this order (the plan's eleven). */
export const COUNTER_NAMES = [
  'fileCount', 'dirCount', 'hardlinkedFiles', 'hardlinkedBytes', 'sparseFiles', 'sparseBytes',
  'slackBytes', 'cloudFiles', 'cloudBytes', 'deniedDirs', 'vanishedDirs',
] as const;
export type CounterName = (typeof COUNTER_NAMES)[number];
export type Counters = Record<CounterName, number>;

export interface Difference {
  index: number;
  /** The line on the first side, or null when that side has no such line. */
  a: string | null;
  b: string | null;
}

const ABSENT = '-';
/** The flag bits, in the order they are written. */
const FLAG_ORDER: readonly Flag[] = [Flag.Hidden, Flag.Symlink, Flag.HardlinkDup, Flag.CloudPlaceholder, Flag.GitRepo];
const ESCAPES: Record<string, string> = { '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' };

function escapeText(s: string): string {
  return s.replace(/[\\\t\n\r]/g, (c) => ESCAPES[c]);
}

function byNameBytes(store: ScanStore, ids: number[]): number[] {
  const keyed = ids.map((id) => ({ id, bytes: Buffer.from(store.name(id)) }));
  keyed.sort((x, y) => Buffer.compare(x.bytes, y.bytes));
  return keyed.map((k) => k.id);
}

/** What the hard-link rule changes: a member's emitted size and flag, and the size delta of every ancestor. */
interface HardlinkAdjustments {
  size: Map<number, number>;
  dup: Map<number, boolean>;
  ancestorDelta: Map<number, number>;
}

function addDelta(map: Map<number, number>, id: number, delta: number): void {
  if (delta === 0) return;
  map.set(id, (map.get(id) ?? 0) + delta);
}

function eachAncestor(store: ScanStore, id: number, fn: (ancestor: number) => void): void {
  for (let a = store.parent(id); a !== -1; a = store.parent(a)) fn(a);
}

function hardlinkAdjustments(store: ScanStore, families: ReadonlyArray<ReadonlyArray<string>>): HardlinkAdjustments {
  const adj: HardlinkAdjustments = { size: new Map(), dup: new Map(), ancestorDelta: new Map() };
  for (const family of families) {
    const members = family
      .map((p) => ({ path: p, id: store.findByPath(p) }))
      .filter((m) => m.id !== -1 && !store.isDir(m.id));
    if (members.length < 2) continue;
    members.sort((x, y) => Buffer.compare(Buffer.from(x.path), Buffer.from(y.path)));
    const owner = members[0];
    let total = 0;
    for (const m of members) {
      const carried = store.size(m.id);
      total += carried;
      eachAncestor(store, m.id, (a) => addDelta(adj.ancestorDelta, a, -carried));
    }
    eachAncestor(store, owner.id, (a) => addDelta(adj.ancestorDelta, a, total));
    for (const m of members) {
      adj.size.set(m.id, m === owner ? total : 0);
      adj.dup.set(m.id, m !== owner);
    }
  }
  return adj;
}

function lineFor(store: ScanStore, id: number, depth: number, adj: HardlinkAdjustments): string {
  const size = adj.size.get(id) ?? store.size(id) + (adj.ancestorDelta.get(id) ?? 0);
  const flags = FLAG_ORDER.map((f) => {
    const on = f === Flag.HardlinkDup && adj.dup.has(id) ? (adj.dup.get(id) as boolean) : store.flag(id, f);
    return on ? '1' : '0';
  }).join('');
  const accessed = store.accessedAt(id);
  const extension = store.extension(id);
  return [
    String(depth),
    escapeText(store.name(id)),
    store.nodeType(id),
    String(size),
    String(store.modifiedAt(id)),
    accessed === undefined ? ABSENT : String(accessed),
    flags,
    extension === undefined ? ABSENT : escapeText(extension),
    store.container(id) ?? ABSENT,
    store.cloudProvider(id) ?? ABSENT,
  ].join('\t');
}

/** One canonical line per live node, pre-order from the root, children in name-byte order. */
export function canonicalLines(store: ScanStore, opts: CanonicalOptions = {}): string[] {
  const adj = hardlinkAdjustments(store, opts.hardlinkFamilies ?? []);
  const lines: string[] = [];
  const stack: Array<{ id: number; depth: number }> = [{ id: store.rootId, depth: 0 }];
  while (stack.length > 0) {
    const { id, depth } = stack.pop() as { id: number; depth: number };
    lines.push(lineFor(store, id, depth, adj));
    if (!store.hasChildArray(id)) continue;
    const kids = byNameBytes(store, store.childIds(id));
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ id: kids[i], depth: depth + 1 });
  }
  return lines;
}

/** SHA-256 (hex) over the canonical lines joined by `\n`. */
export function canonicalDigest(store: ScanStore, opts: CanonicalOptions = {}): string {
  return digestOfLines(canonicalLines(store, opts));
}

/** The digest of lines already produced (a child process hands lines over; the parent digests). */
export function digestOfLines(lines: readonly string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** The eleven counters, an absent one read as 0 exactly as `buildScanStats` reads it. */
export function countersOf(scan: Pick<ScanResult, CounterName>): Counters {
  const out = {} as Counters;
  for (const name of COUNTER_NAMES) out[name] = scan[name] ?? 0;
  return out;
}

/** The first index where two line lists differ, with both lines (null where a side ends), or null when equal. */
export function firstDifference(a: readonly string[], b: readonly string[]): Difference | null {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return { index: i, a: a[i] ?? null, b: b[i] ?? null };
  }
  return null;
}

/** The failure message: the first differing line of each side and the counters side by side. */
export function describeMismatch(labelA: string, labelB: string, linesA: readonly string[], linesB: readonly string[], countersA: Counters, countersB: Counters): string {
  const out: string[] = [];
  const diff = firstDifference(linesA, linesB);
  if (diff) {
    out.push(`first differing line (index ${diff.index} of ${linesA.length} / ${linesB.length}):`);
    out.push(`  ${labelA}: ${diff.a === null ? '<no line>' : JSON.stringify(diff.a)}`);
    out.push(`  ${labelB}: ${diff.b === null ? '<no line>' : JSON.stringify(diff.b)}`);
  } else {
    out.push('the lines are identical');
  }
  const width = Math.max(...COUNTER_NAMES.map((n) => n.length));
  out.push(`counters (${labelA} | ${labelB}):`);
  for (const name of COUNTER_NAMES) {
    const mark = countersA[name] === countersB[name] ? ' ' : '!';
    out.push(`  ${mark} ${name.padEnd(width)}  ${String(countersA[name]).padStart(16)} | ${String(countersB[name]).padStart(16)}`);
  }
  return out.join('\n');
}

import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { AppEntry, AuditEntry, JournalEntry, ScanResult, Snapshot, SnapshotTreeNode } from '../models/types';
import { appDataDir } from './storage';
import { isEphemeral } from './portableMode';
import { getAppAttribution } from './appAttribution';
import { readAudit } from './audit';
import { buildSnapshotTree, getSnapshotTreeAt } from './snapshots';
import { storeOf } from './scanStore';
import { isInside } from '../utils/pathSanitizer';
import { formatBytes } from '../utils/formatBytes';

/**
 * journal — a rolling, human-readable record of significant disk changes
 * (§7.3), persisted as JSONL under the app-data directory, capped and
 * rotated. "Docker added 14.2 GB (~/Library/Containers/com.docker.docker)";
 * "you removed 4.1 GB from Downloads". Every sentence sits beside the
 * structured fields it was built from, so the UI can open the treemap at
 * that path and date instead of just quoting prose.
 *
 * The write path copies audit.ts: one serialised queue, appendFile, an
 * in-memory ring when a read-only portable session must persist nothing.
 * What audit does not need and this file does is rotation — the journal
 * rolls forever, so the file is capped by line count and rewritten down to
 * its newest tail via tmp-file+rename. The rewrite runs INSIDE the same
 * serialised queue task as the appends; that queue is the only thing
 * guaranteeing an append can never interleave with a half-finished rotation.
 *
 * The journal is fed by the scheduler's own scans (recordScanJournal below)
 * and is deliberately NOT a subscriber of the live watcher: watcher.ts keeps
 * a watch session's OS watchers alive until its last listener unsubscribes,
 * so a permanent journal subscription would silently pin every watched root
 * open forever. Scheduled scans already notice every significant change,
 * one interval later at worst — the right trade for a daily-grain diary.
 */

const JOURNAL_FILE = 'journal.jsonl';
/** Rotate once the file exceeds this many lines… */
export const JOURNAL_ROTATE_AT_LINES = 2000;
/** …rewriting it down to the newest this-many. */
export const JOURNAL_KEEP_LINES = 1000;
/** Ring buffer standing in for the file in a read-only portable session. */
const memoryJournal: string[] = [];
const MEMORY_JOURNAL_MAX = 2000;
/** Read-back guard: never parse more than this many trailing lines. */
const MAX_READ_LINES = 1000;

/** A change smaller than this is daily noise, not a journal entry. */
export const SIGNIFICANT_BYTES = 100 * 1024 * 1024;
/** At most this many entries per scheduled scan, largest change first. */
const MAX_ENTRIES_PER_SCAN = 5;

/** The exact words used when no app can honestly be named. Never a guess. */
export const UNATTRIBUTED = 'an unidentified process';

/** Serialize appends so concurrent writes can't interleave partial lines. */
let queue: Promise<void> = Promise.resolve();
/** Lines currently in the file; counted once per process, then tracked. */
let lineCount: number | null = null;

export function journalFilePath(): string {
  return path.join(appDataDir(), JOURNAL_FILE);
}

async function countLines(file: string): Promise<number> {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return raw.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0; // no journal yet
  }
}

/** Append one entry. Resolves when written; never rejects. */
export function appendJournal(entry: Omit<JournalEntry, 'at'>): Promise<void> {
  const full: JournalEntry = { at: Date.now(), ...entry };
  queue = queue
    .catch(() => {
      /* an earlier failed append must not poison the queue */
    })
    .then(async () => {
      // A read-only portable session keeps the journal in memory: the diary
      // exists for the session that wrote it, and this machine keeps nothing.
      if (isEphemeral()) {
        memoryJournal.push(JSON.stringify(full));
        if (memoryJournal.length > MEMORY_JOURNAL_MAX) memoryJournal.shift();
        return;
      }
      const dir = appDataDir();
      await fsp.mkdir(dir, { recursive: true });
      const file = journalFilePath();
      if (lineCount === null) lineCount = await countLines(file);
      await fsp.appendFile(file, JSON.stringify(full) + '\n', 'utf8');
      lineCount += 1;
      if (lineCount > JOURNAL_ROTATE_AT_LINES) {
        // Same serialised task as the append above — the queue is what makes
        // this rewrite atomic with respect to every other append.
        const raw = await fsp.readFile(file, 'utf8');
        const tail = raw.split('\n').filter((l) => l.trim().length > 0).slice(-JOURNAL_KEEP_LINES);
        const tmp = file + '.tmp';
        await fsp.writeFile(tmp, tail.join('\n') + '\n', 'utf8');
        await fsp.rename(tmp, file);
        lineCount = tail.length;
      }
    })
    .catch(async (err: unknown) => {
      console.error('[treemap] journal append failed:', err);
      lineCount = null; // recount next time rather than trusting a torn state
      // A rotation that died between writeFile and rename leaves its tmp file
      // behind; it is never read, but a crash artifact is still litter. The
      // named tmpPath is what shows the delete-guard sweep this is our own
      // app-data scratch file, never a user file.
      const tmpPath = journalFilePath() + '.tmp';
      await fsp.unlink(tmpPath).catch(() => {});
    });
  return queue;
}

/** The most recent `limit` entries, newest first. Unparseable lines are skipped. */
export async function readJournal(limit: number): Promise<JournalEntry[]> {
  let raw: string;
  if (isEphemeral()) {
    raw = memoryJournal.join('\n');
  } else {
    try {
      raw = await fsp.readFile(journalFilePath(), 'utf8');
    } catch {
      return []; // no journal yet
    }
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const tail = lines.slice(-Math.min(Math.max(limit, 1), MAX_READ_LINES));
  const entries: JournalEntry[] = [];
  for (const line of tail) {
    try {
      entries.push(JSON.parse(line) as JournalEntry);
    } catch {
      /* torn or corrupt line — skip it, keep the rest honest */
    }
  }
  return entries.reverse();
}

/* ─────────────── Culprit selection over snapshot trees ─────────────── */

export interface SignificantChange {
  path: string;
  /** Signed bytes. */
  delta: number;
}

/**
 * Where did the bytes move? Walks two snapshot trees of the same root and
 * pins each significant change as deep as it can be pinned HONESTLY.
 *
 * Children are compared only when both trees stored them by name: a stored
 * tree keeps just the largest children per directory, so an unmatched child
 * has no previous size to diff against and any delta invented for it would
 * be a guess. When a node's matched children fully account for its change,
 * the walk descends and reports theirs; when they don't — the change lives
 * in unmatched children or files at this level — the node itself is
 * reported, coarser but true. Changes under SIGNIFICANT_BYTES are noise and
 * never reported at any level.
 */
export function significantChanges(prev: SnapshotTreeNode, curr: SnapshotTreeNode, rootPath: string): SignificantChange[] {
  const out: SignificantChange[] = [];
  const sep = rootPath.includes('\\') ? '\\' : '/';
  const join = (p: string, n: string): string => p + (p.endsWith(sep) ? '' : sep) + n;

  const walk = (p: SnapshotTreeNode, c: SnapshotTreeNode, nodePath: string): void => {
    const delta = c.s - p.s;
    const prevKids = new Map((p.c ?? []).map((k) => [k.n, k]));
    const pairs: { p: SnapshotTreeNode; c: SnapshotTreeNode }[] = [];
    for (const kid of c.c ?? []) {
      const prevKid = prevKids.get(kid.n);
      if (prevKid) pairs.push({ p: prevKid, c: kid });
    }
    const significantKids = pairs.filter((x) => Math.abs(x.c.s - x.p.s) >= SIGNIFICANT_BYTES);
    const explained = significantKids.reduce((sum, x) => sum + (x.c.s - x.p.s), 0);
    // Descend while the children account for the change (opposite-sign child
    // deltas cancel in `explained` exactly as they cancel in `delta`, which is
    // how two changes that null out at the root are still both found).
    if (significantKids.length && (Math.abs(delta - explained) < SIGNIFICANT_BYTES || Math.abs(delta) < SIGNIFICANT_BYTES)) {
      for (const kid of significantKids) walk(kid.p, kid.c, join(nodePath, kid.c.n));
      // Whatever the matched children do NOT explain is still a real change —
      // a growth that cancels against a vanished (unmatched) sibling would
      // otherwise be narrated as pure growth on a net-zero disk. The exact
      // remainder is reported here, coarsely, where it is known.
      const remainder = delta - explained;
      if (Math.abs(remainder) >= SIGNIFICANT_BYTES) out.push({ path: nodePath, delta: remainder });
      return;
    }
    if (Math.abs(delta) >= SIGNIFICANT_BYTES) out.push({ path: nodePath, delta });
  };

  walk(prev, curr, rootPath);
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

/* ─────────────── Attribution: an app, you, or an honest "don't know" ─────────────── */

/**
 * Who is responsible for `delta` bytes at `changedPath`?
 *
 * Three answers, in order of certainty. A shrink that lines up with a real,
 * successful TreeMap deletion inside the window is "you" — TreeMap knows
 * what it did, and that certainty outranks any app's claim on the folder.
 * Otherwise an app is named only when the changed path lies inside a
 * location the attribution walk says that app owns — containment, never a
 * prefix match, and never the reverse (an app living somewhere inside a
 * grown folder is not evidence it caused the growth). Everything else is
 * exactly UNATTRIBUTED: the journal states what it knows, not what it
 * suspects.
 */
/**
 * The audit actions whose real runs REMOVE the audited paths' bytes from this
 * machine — the only ones that may vouch for a shrink as "you". Everything
 * else the audit records (approving a policy, saving one, restoring a file —
 * which ADDS bytes) writes ok/dryRun:false lines over the very folders where
 * a coincidental shrink is likeliest, and counting those painted "you" onto
 * deletions the user never made. An action not on this list falls through to
 * app containment or UNATTRIBUTED — understated, never invented.
 */
const REMOVAL_ACTIONS = new Set([
  'files.trash',
  'cloud.trash',
  'cart.commit',
  'offload.start',
  'compression.encode',
  'git.gc',
  'security.relocate',
]);

export function attributeChange(
  changedPath: string,
  delta: number,
  apps: AppEntry[],
  audit: AuditEntry[],
  sinceMs: number,
): string {
  if (delta < 0) {
    const matching = audit.filter(
      (e) =>
        REMOVAL_ACTIONS.has(e.action) &&
        e.outcome === 'ok' &&
        !e.dryRun &&
        e.at >= sinceMs &&
        e.paths.some((p) => isInside(p, changedPath) || isInside(changedPath, p)),
    );
    // The claim must also fit the size of the hole: deletions covering at
    // least half the shrink may speak for it (sizes drift between scans);
    // a 150 MB trash does not explain 20 GB, and an entry whose bytes the
    // operation could not know vouches for nothing.
    const covered = matching.reduce((sum, e) => sum + (e.bytes ?? 0), 0);
    if (matching.length > 0 && covered >= -delta / 2) return 'you';
  }
  let best: { name: string; depth: number } | null = null;
  for (const app of apps) {
    for (const loc of app.locations) {
      if (!isInside(loc.path, changedPath)) continue;
      if (!best || loc.path.length > best.depth) best = { name: app.name, depth: loc.path.length };
    }
  }
  return best ? best.name : UNATTRIBUTED;
}

/** "Docker added 14.2 GB (~/Library/…)" / "you removed 4.1 GB from Downloads". */
export function sentenceFor(who: string, changedPath: string, delta: number, homeDir = os.homedir()): string {
  const pretty =
    changedPath === homeDir || changedPath.startsWith(homeDir + path.sep)
      ? '~' + changedPath.slice(homeDir.length)
      : changedPath;
  if (delta >= 0) return `${who} added ${formatBytes(delta)} (${pretty})`;
  const name = path.basename(changedPath) || pretty;
  return `${who} removed ${formatBytes(-delta)} from ${name}`;
}

/* ─────────────── The scheduler feed ─────────────── */

/**
 * Turn one completed scheduled scan into journal entries, comparing it
 * against the previous snapshot of the same root. Returns how many entries
 * were written. Called from the scheduler's tick (§B1: the journal rides
 * the one existing timer); see the header for why the live watcher is not
 * a source.
 */
export async function recordScanJournal(scan: ScanResult, prev: Snapshot): Promise<number> {
  if (scan.status !== 'complete' || (!scan.store && !scan.root)) return 0;
  const store = storeOf(scan);
  const curr = buildSnapshotTree(store);

  // The previous snapshot's stored tree lets a change be pinned 2–3 levels
  // deep. A snapshot from before trees were stored still has exact top-level
  // sizes, so it degrades to a top-level diff rather than to nothing.
  const stored = await getSnapshotTreeAt(scan.rootPath, prev.takenAt).catch(() => null);
  const prevTree: SnapshotTreeNode =
    stored && stored.snapshot.id === prev.id
      ? stored.tree
      : {
          n: path.basename(prev.rootPath) || prev.rootPath,
          s: prev.totalSize,
          t: 1,
          c: prev.topEntries.map((e) => ({ n: e.name, s: e.size, ...(e.type === 'dir' ? { t: 1 as const } : {}) })),
        };

  const culprits = significantChanges(prevTree, curr, scan.rootPath).slice(0, MAX_ENTRIES_PER_SCAN);
  if (!culprits.length) return 0;

  const apps = (await getAppAttribution(scan).catch(() => null))?.apps ?? [];
  const audit = await readAudit(MAX_READ_LINES);
  for (const change of culprits) {
    const attribution = attributeChange(change.path, change.delta, apps, audit, prev.takenAt);
    await appendJournal({
      rootPath: scan.rootPath,
      path: change.path,
      delta: change.delta,
      attribution,
      sentence: sentenceFor(attribution, change.path, change.delta),
    });
  }
  return culprits.length;
}

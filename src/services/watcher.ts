import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import { FileNode, ScanResult, WatchEvent, WatchEventKind, WatchStreamEvent } from '../models/types';
import { findNodeByPath } from '../utils/treemap';
import { getSettings } from './settings';
import { appDataDir } from './storage';
import { isInside } from '../utils/pathSanitizer';
import { ScanStore, Flag, NodeInput } from './scanStore';

/**
 * Watcher — live disk activity for a completed scan (Live mode).
 *
 * One session per scanId watches the scanned root: fs.watch with
 * { recursive: true } where the platform supports it (FSEvents on macOS,
 * ReadDirectoryChangesW on Windows, and inotify-backed recursion on newer
 * Linux). Where recursion is unavailable, the top 2 directory levels get
 * individual watchers (capped) — deeper changes surface when their parent
 * levels are touched, which is the usual case for busy paths.
 *
 * Raw events are debounced into one frame per second: per-path deltas are
 * accumulated against the last known size (seeded from the scan tree), so a
 * file that grows five times in a second is one event with one honest delta.
 * Sessions stop themselves when the last listener leaves or after the
 * configurable idle window, and stopAllWatchers() joins the graceful
 * shutdown path alongside scans, hashing and schedules.
 */

const FLUSH_MS = 1000;
const IDLE_CHECK_MS = 30_000;
/** Fallback mode: how many directories get their own watcher, at most. */
const MAX_FALLBACK_WATCHERS = 512;
const FALLBACK_DEPTH = 2;
/** At most this many events per one-second frame (largest |delta| win). */
const MAX_EVENTS_PER_FLUSH = 200;

type Listener = (frame: WatchStreamEvent) => void;

interface WatchSession {
  scanId: string;
  rootPath: string;
  engine: 'recursive' | 'top-levels';
  watchers: fs.FSWatcher[];
  /** Last known size per touched path (scan tree consulted on first touch). */
  knownSizes: Map<string, number>;
  pending: Map<string, WatchEvent>;
  listeners: Set<Listener>;
  flushTimer: NodeJS.Timeout;
  idleTimer: NodeJS.Timeout;
  lastActivityAt: number;
  idleMinutes: number;
  /** Store-backed scans fold live changes into the store; legacy into the tree. */
  store: ScanStore | null;
  root: FileNode | null;
  stopped: boolean;
}

const sessions = new Map<string, WatchSession>();

/** Merge one raw change into the per-second pending frame (pure — tested). */
export function mergePending(
  pending: Map<string, WatchEvent>,
  path_: string,
  kind: WatchEventKind,
  size: number,
  prevSize: number,
): void {
  const existing = pending.get(path_);
  if (!existing) {
    pending.set(path_, { path: path_, kind, delta: size - prevSize, size });
    return;
  }
  // Delta stays anchored to the size before this frame; kind favors the
  // terminal state (created→modified stays created; anything→deleted wins).
  existing.delta = size - (existing.size - existing.delta);
  existing.size = size;
  if (kind === 'deleted') existing.kind = 'deleted';
  else if (existing.kind === 'deleted') existing.kind = 'created'; // deleted then re-created
}

/** Cap a frame to the most significant events (largest |delta| first). */
export function capFrame(events: WatchEvent[], max: number): WatchEvent[] {
  if (events.length <= max) return events;
  return [...events].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, max);
}

/** topLevelDirs against a store-backed scan — same order, same cap. */
export function topLevelDirsInStore(store: ScanStore, depth: number, cap: number): string[] {
  const out: string[] = [store.rootPath];
  const walk = (id: number, d: number): void => {
    if (d >= depth) return;
    for (const c of store.childIds(id)) {
      if (out.length >= cap) return;
      if (store.isDir(c)) {
        out.push(store.path(c));
        walk(c, d + 1);
      }
    }
  };
  walk(store.rootId, 0);
  return out;
}

/** Directories of the top N levels of the scan tree (fallback watch targets). */
export function topLevelDirs(root: FileNode, depth: number, cap: number): string[] {
  const out: string[] = [root.path];
  const walk = (node: FileNode, d: number): void => {
    if (d >= depth || !node.children) return;
    for (const c of node.children) {
      if (out.length >= cap) return;
      if (c.type === 'dir') {
        out.push(c.path);
        walk(c, d + 1);
      }
    }
  };
  walk(root, 0);
  return out;
}

function attachWatchers(session: WatchSession): void {
  const handler = (dirBase: string) => (_event: string, filename: string | Buffer | null): void => {
    if (!filename) return;
    const rel = filename.toString();
    if (rel.includes('\0')) return;
    void onRawEvent(session, path.join(dirBase, rel));
  };
  try {
    const w = fs.watch(session.rootPath, { recursive: true, persistent: false }, handler(session.rootPath));
    w.on('error', () => stopSession(session, 'idle'));
    session.watchers.push(w);
    session.engine = 'recursive';
    return;
  } catch {
    /* recursion unavailable on this platform — fall back to top levels */
  }
  session.engine = 'top-levels';
  const fallbackDirs = session.store
    ? topLevelDirsInStore(session.store, FALLBACK_DEPTH, MAX_FALLBACK_WATCHERS)
    : topLevelDirs(session.root as FileNode, FALLBACK_DEPTH, MAX_FALLBACK_WATCHERS);
  for (const dir of fallbackDirs) {
    try {
      const w = fs.watch(dir, { persistent: false }, handler(dir));
      w.on('error', () => { /* dir vanished — its parent will report it */ });
      session.watchers.push(w);
    } catch {
      /* unwatchable dir (perms/deleted) — skip */
    }
  }
}

async function onRawEvent(session: WatchSession, absPath: string): Promise<void> {
  if (session.stopped) return;
  // The app's own bookkeeping (snapshots, caches) must not read as activity.
  if (isInside(appDataDir(), absPath)) return;

  let size = 0;
  let exists = false;
  let isFile = false;
  try {
    const st = await fsp.lstat(absPath);
    exists = true;
    isFile = st.isFile();
    size = st.size;
  } catch {
    /* deleted (or unreadable) — treated below */
  }
  if (exists && !isFile) return; // dirs surface through their files

  let prev = session.knownSizes.get(absPath);
  if (prev === undefined) {
    if (session.store) {
      const id = session.store.findByPath(absPath);
      prev = id !== -1 && !session.store.isDir(id) ? session.store.size(id) : 0;
    } else {
      const node = findNodeByPath(session.root as FileNode, absPath);
      prev = node && node.type === 'file' ? node.size : 0;
    }
  }
  const kind: WatchEventKind = !exists ? 'deleted' : prev > 0 || session.knownSizes.has(absPath) ? 'modified' : 'created';
  if (kind === 'deleted' && prev === 0) return; // unknown file came and went

  if (kind === 'deleted') session.knownSizes.delete(absPath);
  else session.knownSizes.set(absPath, size);
  mergePending(session.pending, absPath, kind, size, prev);
  applyToTree(session, absPath, kind, size, size - prev);
}

/**
 * Fold a live change into the in-memory scan (store or legacy tree), so
 * treemap layouts re-fetched during Live mode reflect what the disk is
 * doing right now.
 */
function applyToTree(session: WatchSession, absPath: string, kind: WatchEventKind, size: number, delta: number): void {
  if (delta === 0 && kind !== 'deleted') return;
  if (session.store) {
    applyToStore(session.store, session.rootPath, absPath, kind, size, delta);
    return;
  }
  const root = session.root as FileNode;
  const node = findNodeByPath(root, absPath);
  if (node && node.type === 'file') {
    node.size = kind === 'deleted' ? 0 : size;
    node.modifiedAt = Date.now();
  } else if (!node && kind === 'created') {
    const parent = findNodeByPath(root, path.dirname(absPath));
    if (parent && parent.type === 'dir' && parent.children) {
      const name = path.basename(absPath);
      const child: FileNode = { name, path: absPath, size, type: 'file', modifiedAt: Date.now(), isHidden: name.startsWith('.') };
      const ext = path.extname(name).toLowerCase().replace(/^\./, '');
      if (ext) child.extension = ext;
      parent.children.push(child);
    }
    // Parent dir newer than the scan — ancestors that do exist still get the delta.
  }
  let p = path.dirname(absPath);
  for (;;) {
    if (p === session.rootPath) {
      root.size += delta;
      break;
    }
    if (!isInside(session.rootPath, p)) break;
    const dir = findNodeByPath(root, p);
    if (dir && dir.type === 'dir') dir.size += delta;
    const up = path.dirname(p);
    if (up === p) break;
    p = up;
  }
}

/** applyToTree for store-backed scans — same rules, id-based. */
function applyToStore(store: ScanStore, rootPath: string, absPath: string, kind: WatchEventKind, size: number, delta: number): void {
  const id = store.findByPath(absPath);
  if (id !== -1 && !store.isDir(id)) {
    store.setSize(id, kind === 'deleted' ? 0 : size);
    store.setModifiedAt(id, Date.now());
  } else if (id === -1 && kind === 'created') {
    const parentId = store.findByPath(path.dirname(absPath));
    if (parentId !== -1 && store.isDir(parentId) && store.hasChildArray(parentId)) {
      const name = path.basename(absPath);
      const input: NodeInput = { name, isDir: false, size, modifiedAt: Date.now(), isHidden: name.startsWith('.') };
      const ext = path.extname(name).toLowerCase().replace(/^\./, '');
      if (ext) input.extension = ext;
      store.addNode(parentId, input);
    }
    // Parent dir newer than the scan — ancestors that do exist still get the delta.
  }
  let p = path.dirname(absPath);
  for (;;) {
    if (p === rootPath) {
      store.addToSize(store.rootId, delta);
      break;
    }
    if (!isInside(rootPath, p)) break;
    const dirId = store.findByPath(p);
    if (dirId !== -1 && store.flag(dirId, Flag.Dir)) store.addToSize(dirId, delta);
    const up = path.dirname(p);
    if (up === p) break;
    p = up;
  }
}

function flush(session: WatchSession): void {
  if (session.stopped || session.pending.size === 0) return;
  const events = capFrame([...session.pending.values()].filter((e) => e.delta !== 0 || e.kind !== 'modified'), MAX_EVENTS_PER_FLUSH);
  session.pending.clear();
  if (events.length === 0) return;
  session.lastActivityAt = Date.now();
  emit(session, { type: 'activity', at: session.lastActivityAt, events });
}

function emit(session: WatchSession, frame: WatchStreamEvent): void {
  for (const fn of session.listeners) {
    try {
      fn(frame);
    } catch {
      /* a broken listener must not break the watcher */
    }
  }
}

function stopSession(session: WatchSession, reason: 'idle' | 'shutdown'): void {
  if (session.stopped) return;
  session.stopped = true;
  clearInterval(session.flushTimer);
  clearInterval(session.idleTimer);
  for (const w of session.watchers) {
    try { w.close(); } catch { /* already closed */ }
  }
  session.watchers = [];
  emit(session, { type: 'paused', reason });
  session.listeners.clear();
  sessions.delete(session.scanId);
}

/** Start (or join) the watch session for a completed scan. */
export async function ensureWatchSession(scan: ScanResult & { root: FileNode }): Promise<WatchSession> {
  const existing = sessions.get(scan.scanId);
  if (existing && !existing.stopped) return existing;

  const { watchIdleMinutes } = await getSettings();
  const session: WatchSession = {
    scanId: scan.scanId,
    rootPath: scan.rootPath,
    engine: 'recursive',
    watchers: [],
    knownSizes: new Map(),
    pending: new Map(),
    listeners: new Set(),
    flushTimer: setInterval(() => flush(session), FLUSH_MS),
    idleTimer: setInterval(() => {
      if (Date.now() - session.lastActivityAt > session.idleMinutes * 60_000) stopSession(session, 'idle');
    }, IDLE_CHECK_MS),
    lastActivityAt: Date.now(),
    idleMinutes: watchIdleMinutes,
    // Store first: touching scan.root on a store-backed scan materializes.
    store: scan.store ?? null,
    root: scan.store ? null : scan.root,
    stopped: false,
  };
  session.flushTimer.unref();
  session.idleTimer.unref();
  attachWatchers(session);
  sessions.set(scan.scanId, session);
  return session;
}

/** Subscribe to a session's frames; returns an unsubscribe function. */
export function subscribe(session: WatchSession, fn: Listener): () => void {
  session.listeners.add(fn);
  return () => {
    session.listeners.delete(fn);
    // Last listener gone → no reason to keep the OS watchers alive.
    if (session.listeners.size === 0) stopSession(session, 'idle');
  };
}

/** Graceful shutdown: close every watcher and tell connected clients. */
export function stopAllWatchers(): void {
  for (const session of [...sessions.values()]) stopSession(session, 'shutdown');
}

import fs from 'fs';

/**
 * watchRegistry — the one place in the process that attaches or closes an OS
 * file watch (`fs.watch`), and the one that says when the set of watches
 * changed.
 *
 * Why the set matters. On macOS libuv serves every `fs.watch` of a directory
 * in an event loop — recursive or not — from ONE FSEventStream, and rebuilds
 * that stream whenever a watch attaches or closes: stop, invalidate, release,
 * then create a new one over every watched path, starting "since now". Read
 * off the Node 24.16.0 binary itself (`uv__cf_loop_cb`: FSEventStreamStop →
 * Invalidate → Release, then FSEventStreamCreate with sinceWhen = -1, i.e.
 * kFSEventStreamEventIdSinceNow), and libuv's uv/darwin.h agrees: one
 * `cf_state` per loop, one `cf_member` link per watch. (A worker thread has a
 * loop, and so a stream, of its own; nothing here watches from one.) A change
 * that lands while the stream is being rebuilt is reported to nobody —
 * including every watch that stayed attached. Measured on the owner's Mac
 * (26 and 28 Sep 2026): with a second watch attaching and closing every 5 ms,
 * 36 of 100 and then 19 of 50 first writes into a watched folder were never
 * reported; with no such churn, none of 200 and none of 100.
 *
 * Windows and Linux do not share anything the same way (uv/win.h, uv/linux.h):
 * libuv gives each Windows watch its own directory handle and
 * ReadDirectoryChangesW buffer, and each Linux watch its own inotify watch
 * descriptor on the loop's one inotify descriptor, which adding or removing
 * another never resets — and Node builds a recursive watch on Linux from one
 * such watch per file and folder. So there, one watch starting or stopping
 * costs the others nothing.
 *
 * What the index needs from this is honesty (indexEngine.ts, "Drift"): a
 * root whose watch may have missed a change must not go on saying `ready`.
 * Every watch-set change is reported, with who held the watch, so the engine
 * can mark the others stale — and two leases on the same folder share one OS
 * watch, so that turning Live mode on over a folder the index already watches
 * interrupts nothing.
 */

/** A change to the process's set of OS watches. */
export interface WatchSetChange {
  /**
   * `attached`: an OS watch was opened. `closed`: its last lease let go.
   * `errored`: the system ended it — every lease on it was told, and nothing
   * will be reported through it again.
   */
  kind: 'attached' | 'closed' | 'errored';
  path: string;
  recursive: boolean;
  /**
   * Who held the watch when it changed: the lease that opened it, the lease
   * that closed it, or — when the system ended it — every lease it had.
   */
  owners: string[];
}

export interface WatchOptions {
  recursive: boolean;
  /** Who holds the lease (`index:<root>`, `live:<scanId>`), named in every change it causes. */
  owner: string;
  /** Called when the system ends the OS watch this lease is on. */
  onError?: (err: Error) => void;
}

export type WatchListener = (eventType: string, filename: string | null) => void;

/** One holder's share of an OS watch. Closing it is idempotent. */
export interface WatchLease {
  close(): void;
}

/** The part of `fs.FSWatcher` the registry uses — what a test's stand-in has to provide. */
export interface OsWatcher {
  close(): void;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type WatchImpl = (
  target: string,
  opts: { recursive: boolean; persistent: false },
  listener: WatchListener,
) => OsWatcher;

interface Lease {
  owner: string;
  listener: WatchListener;
  onError?: (err: Error) => void;
}

/**
 * One OS watch and the leases on it. It is in `osWatches` exactly while it
 * has leases: the last one letting go, or the system ending it, takes it out.
 */
interface OsWatch {
  key: string;
  path: string;
  recursive: boolean;
  watcher: OsWatcher | null;
  leases: Set<Lease>;
}

// `persistent: false` everywhere: a watch never keeps the process alive. The
// server, the Electron shell and the tests own the process's lifetime, and
// every caller asked for exactly this before the registry existed.
const realWatch: WatchImpl = (target, opts, listener) =>
  fs.watch(target, opts, (eventType, filename) => listener(eventType, filename));

let watchImpl: WatchImpl = realWatch;
const osWatches = new Map<string, OsWatch>();
const setListeners = new Set<(change: WatchSetChange) => void>();

const keyOf = (target: string, recursive: boolean): string => `${recursive ? 'r' : 'd'}:${target}`;

/**
 * Call every function in `calls`, even when one throws, then rethrow the
 * first throw. One OS watch serves several subscribers, and a bug in one of
 * them must neither be swallowed nor keep the others from hearing it.
 */
function callEach(calls: Array<() => void>): void {
  let first: { err: unknown } | null = null;
  for (const call of calls) {
    try {
      call();
    } catch (err) {
      first ??= { err };
    }
  }
  if (first) throw first.err;
}

function report(change: WatchSetChange): void {
  for (const fn of [...setListeners]) {
    try {
      fn(change);
    } catch (err) {
      // Logged, not rethrown: the change has already happened and the
      // registry's books already say so. The caller that caused it — a
      // request attaching a watch, a shutdown closing one — would otherwise
      // lose the lease it was just handed over a bug that is not its own.
      console.error('[treemap] a watch-set listener failed:', err);
    }
  }
}

/**
 * Every lease on the watch hears the event — asked at the moment it is
 * called, so a lease that an earlier listener closed during this same
 * delivery hears nothing more, like one closed before it.
 */
function deliver(entry: OsWatch, eventType: string, filename: string | null): void {
  callEach(
    [...entry.leases].map((l) => () => {
      if (entry.leases.has(l)) l.listener(eventType, filename);
    }),
  );
}

/**
 * The system ended an OS watch. A native watch has already closed its handle
 * by the time it says so; Node's recursive emulation on Linux has not, and is
 * closed here — either way the watch is gone, and says so once.
 */
function failed(entry: OsWatch, err: Error): void {
  if (osWatches.get(entry.key) !== entry) return; // already let go
  osWatches.delete(entry.key);
  const leases = [...entry.leases];
  entry.leases.clear(); // so each lease's own close() is now a no-op
  try {
    entry.watcher?.close(); // a no-op on an errored native FSWatcher
  } catch {
    /* already closed */
  }
  try {
    callEach(leases.flatMap((l) => (l.onError ? [l.onError] : [])).map((onError) => () => onError(err)));
  } finally {
    report({ kind: 'errored', path: entry.path, recursive: entry.recursive, owners: leases.map((l) => l.owner) });
  }
}

function release(entry: OsWatch, lease: Lease): void {
  // Not in the set: this lease already let go, or the system ended its watch.
  if (!entry.leases.delete(lease)) return;
  if (entry.leases.size > 0) return;
  osWatches.delete(entry.key);
  try {
    entry.watcher?.close();
  } catch {
    /* already closed */
  }
  report({ kind: 'closed', path: entry.path, recursive: entry.recursive, owners: [lease.owner] });
}

/**
 * Watch `target` for changes. Shares the OS watch any other lease already has
 * on the same folder with the same `recursive`, and opens one otherwise.
 *
 * Throws when the system refuses the watch (a missing folder, permissions, a
 * descriptor or `max_user_watches` limit) and then records nothing: the
 * caller's catch is the whole story.
 */
export function watchPath(target: string, opts: WatchOptions, listener: WatchListener): WatchLease {
  const key = keyOf(target, opts.recursive);
  const lease: Lease = { owner: opts.owner, listener, onError: opts.onError };
  let entry = osWatches.get(key);
  if (entry) {
    entry.leases.add(lease);
  } else {
    const fresh: OsWatch = { key, path: target, recursive: opts.recursive, watcher: null, leases: new Set([lease]) };
    fresh.watcher = watchImpl(target, { recursive: opts.recursive, persistent: false }, (eventType, filename) =>
      deliver(fresh, eventType, filename),
    );
    // Always handled here: an unhandled 'error' on an FSWatcher throws, and
    // the change it causes is one every subscriber needs to hear about.
    fresh.watcher.on('error', (err) => failed(fresh, err));
    osWatches.set(key, fresh);
    entry = fresh;
    report({ kind: 'attached', path: target, recursive: opts.recursive, owners: [opts.owner] });
  }
  const owned = entry;
  return { close: () => release(owned, lease) };
}

/**
 * Keep every OS watch `owner` holds open until the returned function is
 * called, under a lease of `holder`'s that hears nothing.
 *
 * For a subscriber about to let go of its watches and take them back — an
 * index rebuild — so that each watch it takes back before the release is
 * handed over rather than closed and reopened. It never opens a watch, and a
 * held watch nobody took back by the release closes then, as it would have.
 */
export function holdWatchesOf(owner: string, holder: string): () => void {
  const held: WatchLease[] = [];
  for (const entry of osWatches.values()) {
    if (![...entry.leases].some((l) => l.owner === owner)) continue;
    const lease: Lease = { owner: holder, listener: () => {} };
    entry.leases.add(lease);
    held.push({ close: () => release(entry, lease) });
  }
  return () => {
    for (const lease of held) lease.close();
  };
}

/** Hear every change to the set of OS watches. Returns an unsubscribe. */
export function onWatchSetChange(fn: (change: WatchSetChange) => void): () => void {
  setListeners.add(fn);
  return () => setListeners.delete(fn);
}

/** The OS watches open right now, with who holds each. */
export function openWatches(): { path: string; recursive: boolean; owners: string[] }[] {
  return [...osWatches.values()].map((e) => ({
    path: e.path,
    recursive: e.recursive,
    owners: [...e.leases].map((l) => l.owner),
  }));
}

/**
 * Whether every watch in one process shares one OS change stream on
 * `platform`, so that any watch attaching or closing interrupts all the
 * others. True on macOS only — see the top of this file.
 */
export function streamIsSharedOn(platform: NodeJS.Platform): boolean {
  return platform === 'darwin';
}

let sharedOverride: boolean | null = null;

/** Whether this process's watches share one stream (see `streamIsSharedOn`). */
export function watchesShareOneStream(): boolean {
  return sharedOverride ?? streamIsSharedOn(process.platform);
}

/** Tests only: behave as a platform whose watches do (true) or do not (false) share a stream; null restores. */
export function setSharedStreamForTests(shared: boolean | null): void {
  sharedOverride = shared;
}

/** Tests only: stand in for `fs.watch`; null restores the real one. */
export function setWatchImplForTests(impl: WatchImpl | null): void {
  watchImpl = impl ?? realWatch;
}

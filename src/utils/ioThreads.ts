import os from 'os';

/**
 * ioThreads — sizes libuv's threadpool before it spins up.
 *
 * Every async fs call (lstat, readdir) runs on this pool, and its default of
 * 4 threads — not the walker's worker count — is the disk scanner's real
 * bottleneck. The pool is created lazily on the first async fs/zlib/dns call
 * and its size is read from UV_THREADPOOL_SIZE at that moment, so this module
 * must be imported before any of that happens (it is the first import of
 * server.ts; electron/main.js sets the variable itself even earlier).
 *
 * An explicit UV_THREADPOOL_SIZE from the user always wins. The default is
 * 2× cores capped at 16: measured on APFS, 16 threads scan ~1.6× faster than
 * 4, while 32 is consistently *slower* than 4 (kernel metadata-lock
 * contention) — more is not better here.
 */
export const IO_THREADS: number = (() => {
  const user = Number(process.env.UV_THREADPOOL_SIZE);
  if (Number.isFinite(user) && user > 0) return Math.min(1024, Math.floor(user));
  const size = Math.min(16, Math.max(8, os.cpus().length * 2));
  process.env.UV_THREADPOOL_SIZE = String(size);
  return size;
})();

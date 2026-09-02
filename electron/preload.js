'use strict';
/*
 * TreeMap — preload bridge. The only desktop superpowers the page gets, all
 * under `window.treemapDesktop`. Everything else keeps flowing through the
 * normal localhost HTTP API.
 *
 * Page → shell
 *  - getPathForFile(file)        absolute path for a dropped File (browsers hide it)
 *  - resolveScanPath(path)       → Promise<folder | null>: files resolve to their parent
 *  - requestScans(paths)         → Promise<{ queued, ignored } | null>. Every path is
 *                                  resolved to a folder, repeats are dropped, and the
 *                                  folders are scanned ONE AT A TIME in the order
 *                                  given: the shell pushes each over onScanPath when
 *                                  the previous one has finished. Use this for a
 *                                  multi-folder drop instead of calling startScan.
 *  - scanProgress(fraction)      dock / taskbar progress. 0…1 shows that fraction,
 *                                  any number above 1 (use 2) shows an indeterminate
 *                                  bar, -1 (or null) clears it. Send it at scan start
 *                                  (2), a few times a second at most while scanning,
 *                                  and it is cleared for you by scanFinished.
 *  - scanFinished(result)        { ok, path, files?, bytes?, error?, stopped? } at EVERY
 *                                  terminal path — finish, failure, and Stop (with
 *                                  stopped: true, which keeps the shell silent). It
 *                                  clears the progress bar, releases the scan queue
 *                                  so the next dropped folder starts, and — when the
 *                                  window is not focused — bounces the dock / flashes
 *                                  the taskbar and posts a notification. A page that
 *                                  never calls this leaves queued folders waiting;
 *                                  scanProgress(-1) also counts as "done".
 *
 * Shell → page
 *  - onScanPath(cb)              cb(folder) — scan this folder now (dock drop, second
 *                                  launch, tray, the File menu, the scan queue).
 *  - onCommand(cb)               cb(name) for a menu item the page owns:
 *                                  'settings' | 'palette' | 'sidebar' | 'shortcuts' | 'rescan'.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('treemapDesktop', {
  /** Absolute path for a File object from a drag-and-drop event. */
  getPathForFile(file) {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  /** Given any dropped path, returns the folder to scan (parent for files). */
  resolveScanPath(p) {
    return ipcRenderer.invoke('treemap:resolve-scan-path', p);
  },
  /** Queue several dropped items; the shell scans them one after another. */
  requestScans(paths) {
    return ipcRenderer.invoke('treemap:request-scans', paths);
  },
  /** Fires when the shell hands the page a folder to scan. */
  onScanPath(callback) {
    ipcRenderer.on('treemap:scan-path', (_event, p) => callback(p));
  },
  /** Fires for a menu item the page implements (see the header). */
  onCommand(callback) {
    ipcRenderer.on('treemap:command', (_event, name) => callback(name));
  },
  /** Dock / taskbar progress: 0…1, above 1 = indeterminate, -1 = clear. */
  scanProgress(fraction) {
    ipcRenderer.send('treemap:scan-progress', fraction);
  },
  /** Every terminal path of a scan: { ok, path, files, bytes, error, stopped }. */
  scanFinished(result) {
    ipcRenderer.send('treemap:scan-finished', result);
  },
});

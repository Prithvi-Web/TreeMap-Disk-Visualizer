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
 *                                  given, behind the folders the shell already holds:
 *                                  the shell pushes each over onScanPath when the
 *                                  previous one has finished. Use this for folders
 *                                  dropped while a scan runs, so one queue orders
 *                                  every folder. Each one held is told over
 *                                  onScanQueued, as the shell's own are; say nothing
 *                                  of them from the answer.
 *  - scanProgress(fraction, folder?)  dock / taskbar progress. 0…1 shows that fraction,
 *                                  any number above 1 (use 2) shows an indeterminate
 *                                  bar, -1 (or null) clears it. Send it at scan start
 *                                  (2) with the folder being scanned ('' for none the
 *                                  shell can name), which the shell then does not queue
 *                                  again behind itself; a few times a second at most
 *                                  while scanning; it is cleared for you by scanFinished.
 *  - scanFinished(result)        → Promise<{ dropped }>. { ok, path, files?, bytes?,
 *                                  refused?, error?, stopped? } (files: the files
 *                                  count; refused: folders that could not be read)
 *                                  at EVERY terminal path — finish,
 *                                  failure, and Stop (with stopped: true, which keeps
 *                                  the shell silent). It clears the progress bar and
 *                                  — when the window is not focused — bounces the dock
 *                                  / flashes the taskbar and posts a notification. A
 *                                  finish or failure releases the scan queue so the
 *                                  next dropped folder starts; a Stop drops every
 *                                  folder still waiting in it instead, and `dropped`
 *                                  says how many (0 otherwise). A page that never
 *                                  calls this leaves queued folders waiting;
 *                                  scanProgress(-1) also counts as "done".
 *  - openPrivacySettings(pane)   → Promise<{ opened, reason? }>. Opens one System
 *                                  Settings pane, named — today only 'full-disk-access'
 *                                  (macOS: Privacy & Security › Full Disk Access). The
 *                                  shell holds the URL; the page never sends one, and
 *                                  window.open still refuses x-apple URLs. opened: false
 *                                  (with a reason) means nothing opened: say the path in
 *                                  words instead.
 *
 * Shell → page
 *  - onScanPath(cb)              cb(folder) — scan this folder now (dock drop, second
 *                                  launch, tray, the File menu, the scan queue).
 *  - onScanQueued(cb)            cb({ path, before }) — the shell holds this folder behind
 *                                  the scan running, with `before` of its own folders ahead
 *                                  of it (the page's own queue scans first); or
 *                                  cb({ path, scanning: true }) — asked for again while it
 *                                  is the folder being scanned. Say it as the page's own
 *                                  queue says its folders, once a scan. Sent for the
 *                                  folders requestScans hands over too.
 *  - onCommand(cb)               cb(name) for a menu item the page owns:
 *                                  'settings' | 'palette' | 'sidebar' | 'shortcuts' | 'rescan'.
 *                                  One chosen while the page is still loading is sent
 *                                  once it has loaded (the latest one only).
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
  /** Fires when the shell holds a folder behind the scan running (see the header). */
  onScanQueued(callback) {
    ipcRenderer.on('treemap:scan-queued', (_event, held) => callback(held));
  },
  /** Fires for a menu item the page implements (see the header). */
  onCommand(callback) {
    ipcRenderer.on('treemap:command', (_event, name) => callback(name));
  },
  /** Dock / taskbar progress: 0…1, above 1 = indeterminate, -1 = clear; at a scan's start, with its folder. */
  scanProgress(fraction, folder) {
    ipcRenderer.send('treemap:scan-progress', fraction, folder);
  },
  /** Every terminal path of a scan: { ok, path, files, bytes, error, stopped } → { dropped }. */
  scanFinished(result) {
    return ipcRenderer.invoke('treemap:scan-finished', result);
  },
  /** Open a System Settings pane by name → { opened, reason? }. The shell owns the URL. */
  openPrivacySettings(pane) {
    return ipcRenderer.invoke('treemap:open-privacy-settings', pane);
  },
});

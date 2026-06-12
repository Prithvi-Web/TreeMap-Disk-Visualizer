'use strict';
/*
 * TreeMap — preload bridge. The only desktop superpowers the page gets:
 *  - turning a dropped File into an absolute path (browsers hide this),
 *  - resolving a dropped file to a scannable folder,
 *  - receiving "scan this path" pushes (dock drops, CLI args, tray actions).
 * Everything else keeps flowing through the normal localhost HTTP API.
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
  /** Fires when the OS hands the app a folder (dock drop, second launch, tray). */
  onScanPath(callback) {
    ipcRenderer.on('treemap:scan-path', (_event, p) => callback(p));
  },
});

'use strict';
/*
 * TreeMap — Electron main process.
 *
 * Turns the Express web app into a native desktop window. The full backend
 * (scanner, trash, system info) runs in-process exactly as it does on the
 * web, listening on a random localhost port; the window simply loads it.
 * Because it runs locally on the user's machine, it scans *their* disk —
 * which is the whole point of a downloadable app.
 */
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');

// Built backend lives in dist/. `npm run build` (tsc) must run before packaging.
const { startServer } = require(path.join(__dirname, '..', 'dist', 'server.js'));

let running = null; // { server, port, shutdown }
let mainWindow = null;

async function boot() {
  const publicDir = path.join(__dirname, '..', 'public');
  // Port 0 → OS assigns a free port, so two machines never collide.
  running = await startServer({ host: '127.0.0.1', port: 0, publicDir });
  console.log(`[treemap] desktop server ready on 127.0.0.1:${running.port}`);
  createWindow(running.port);
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0a0a0d',
    show: false,
    title: 'TreeMap',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Any external link (e.g. future "About") opens in the real browser, not in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// A minimal app menu so standard shortcuts (Cmd+Q, Cmd+R, Copy/Paste) work.
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Single-instance lock: a second launch just focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    boot().catch((err) => {
      console.error('[treemap] failed to start server:', err);
      app.quit();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && running) {
        createWindow(running.port);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (running) running.shutdown();
  });
}

'use strict';
/*
 * TreeMap — Electron main process.
 *
 * Turns the Express web app into a native desktop window. The full backend
 * (scanner, trash, scheduler, system info) runs in-process exactly as it
 * does on the web, listening on a random localhost port; the window simply
 * loads it. On top of that, the desktop build adds:
 *  - a menu-bar/tray icon with live free-disk stats and quick actions
 *  - folder drag-and-drop (onto the window or the dock icon) → instant scan
 *  - native notifications when a scheduled scan crosses its growth threshold
 *  - auto-updates from GitHub Releases (electron-updater), asking before
 *    restarting; updates require a code-signed build on macOS, so failures
 *    there are logged and otherwise ignored.
 */
// libuv threadpool: sized before anything can start it — every async fs call
// (the disk scanner's lstat/readdir storm) runs on this pool, and the default
// of 4 threads is the scan-speed bottleneck. Mirrors src/utils/ioThreads.ts.
if (!Number(process.env.UV_THREADPOOL_SIZE)) {
  process.env.UV_THREADPOOL_SIZE = String(Math.min(16, Math.max(8, require('os').cpus().length * 2)));
}

const { app, BrowserWindow, Tray, Menu, Notification, shell, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Built backend lives in dist/. `npm run build` (tsc) must run before packaging.
const { startServer } = require(path.join(__dirname, '..', 'dist', 'server.js'));
const { onGrowthAlert } = require(path.join(__dirname, '..', 'dist', 'services', 'scheduler.js'));
const { diskUsage } = require(path.join(__dirname, '..', 'dist', 'services', 'diskUsage.js'));
const { formatBytes } = require(path.join(__dirname, '..', 'dist', 'utils', 'formatBytes.js'));

let running = null; // { server, port, shutdown }
let mainWindow = null;
let tray = null;
let trayTimer = null;
/** Paths handed to us before the window was ready (dock drops, CLI args). */
const pendingScanPaths = [];

/* ─────────────────────────── Scan-path plumbing ─────────────────────────── */

/** Folder for any path: directories pass through, files resolve to their parent. */
function toScannableDir(p) {
  try {
    const stat = fs.statSync(p);
    return stat.isDirectory() ? p : path.dirname(p);
  } catch {
    return null;
  }
}

function requestScan(rawPath) {
  const dir = toScannableDir(rawPath);
  if (!dir) return;
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    showMainWindow();
    mainWindow.webContents.send('treemap:scan-path', dir);
  } else {
    pendingScanPaths.push(dir);
  }
}

function flushPendingScans() {
  while (pendingScanPaths.length > 0 && mainWindow) {
    mainWindow.webContents.send('treemap:scan-path', pendingScanPaths.shift());
  }
}

/** Directory args from a launch/second launch (Windows/Linux drag-onto-icon). */
function scanPathsFromArgv(argv) {
  return argv.slice(1).filter((arg) => {
    if (arg.startsWith('-')) return false;
    try {
      return fs.statSync(arg).isDirectory();
    } catch {
      return false;
    }
  });
}

ipcMain.handle('treemap:resolve-scan-path', (_event, p) => {
  if (typeof p !== 'string' || !p) return null;
  return toScannableDir(p);
});

/* ─────────────────────────────── Window ─────────────────────────────── */

async function boot() {
  const publicDir = path.join(__dirname, '..', 'public');
  // Port 0 → OS assigns a free port, so two machines never collide.
  running = await startServer({ host: '127.0.0.1', port: 0, publicDir });
  console.log(`[treemap] desktop server ready on 127.0.0.1:${running.port}`);
  createWindow(running.port);
  createTray();
  wireGrowthNotifications();
  setupAutoUpdates();
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#05060a',
    show: false,
    title: 'TreeMap',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.once('did-finish-load', flushPendingScans);

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

function showMainWindow() {
  if (!mainWindow) {
    if (running) createWindow(running.port);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ─────────────────────────────── Tray ─────────────────────────────── */

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true); // macOS recolors it for light/dark menu bars
  tray = new Tray(icon);
  tray.setToolTip('TreeMap — Disk Space Visualizer');
  tray.on('click', () => {
    // Windows/Linux convention: left-click opens the app.
    if (process.platform !== 'darwin') showMainWindow();
  });
  refreshTray();
  trayTimer = setInterval(refreshTray, 5 * 60_000); // keep stats fresh
  trayTimer.unref();
}

async function refreshTray() {
  if (!tray) return;
  let statsLabel = 'Disk stats unavailable';
  let title = '';
  try {
    const { total, free } = await diskUsage(os.homedir());
    statsLabel = `${formatBytes(free)} free of ${formatBytes(total)} (${total > 0 ? Math.round(((total - free) / total) * 100) : 0}% used)`;
    title = ` ${formatBytes(free, 0)} free`;
  } catch (err) {
    console.error('[treemap] tray disk stats failed:', err);
  }
  if (process.platform === 'darwin') tray.setTitle(title); // text next to the icon

  const menu = Menu.buildFromTemplate([
    { label: statsLabel, enabled: false },
    { type: 'separator' },
    { label: 'Open TreeMap', click: showMainWindow },
    {
      label: 'Scan Home Folder',
      click: () => {
        showMainWindow();
        requestScan(os.homedir());
      },
    },
    { type: 'separator' },
    { label: 'Quit TreeMap', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

/* ──────────────────────── Growth notifications ──────────────────────── */

function wireGrowthNotifications() {
  onGrowthAlert((alert) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: 'TreeMap — folder growing fast',
      body: alert.message,
    });
    n.on('click', showMainWindow);
    n.show();
  });
}

/* ───────────────────────────── Auto-update ───────────────────────────── */

function setupAutoUpdates() {
  if (!app.isPackaged) return; // dev runs would just error
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.error('[treemap] electron-updater unavailable:', err);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    const message = `TreeMap ${info.version} has been downloaded.`;
    dialog
      .showMessageBox({
        type: 'info',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        message,
        detail: 'Restart to apply the update — or it installs automatically the next time you quit.',
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      })
      .catch(() => {});
  });
  autoUpdater.on('error', (err) => {
    // Expected on macOS without code signing; never bother the user about it.
    console.error('[treemap] auto-update error:', err?.message || err);
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  const updateTimer = setInterval(check, 6 * 3600_000);
  updateTimer.unref();
}

/* ───────────────────────────── App lifecycle ───────────────────────────── */

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

// macOS: folder dropped onto the dock icon / "Open With" — may fire pre-ready.
app.on('open-file', (event, p) => {
  event.preventDefault();
  requestScan(p);
});

// Single-instance lock: a second launch focuses the window and forwards its args.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    showMainWindow();
    for (const dir of scanPathsFromArgv(argv)) requestScan(dir);
  });

  app.whenReady().then(() => {
    buildMenu();
    boot()
      .then(() => {
        // Windows/Linux: a folder dragged onto the app icon arrives as an arg.
        for (const dir of scanPathsFromArgv(process.argv)) requestScan(dir);
      })
      .catch((err) => {
        console.error('[treemap] failed to start server:', err);
        app.quit();
      });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && running) {
        createWindow(running.port);
      }
    });
  });

  // The tray keeps TreeMap alive when the window closes (scheduled scans keep
  // running); quit explicitly from the tray or app menu.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !tray) app.quit();
  });

  app.on('before-quit', () => {
    if (trayTimer) clearInterval(trayTimer);
    if (running) running.shutdown();
  });
}

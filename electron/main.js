'use strict';
/*
 * TreeMap — Electron main process.
 *
 * Turns the Express web app into a native desktop window. The full backend
 * (scanner, trash, scheduler, system info) runs in-process exactly as it
 * does on the web, listening on a random localhost port; the window simply
 * loads it. On top of that, the desktop build adds:
 *  - a per-launch API token, so only this window (and whoever the owner
 *    hands the token to) can drive the local API
 *  - a menu-bar/tray icon with live free-disk stats and quick actions
 *  - folder drag-and-drop (onto the window or the dock icon) → a scan queue
 *    that runs the folders one at a time, in order
 *  - dock / taskbar progress during a scan, and a bounce, a flash and a
 *    notification when a scan finishes in the background
 *  - the window reopening where it was closed (bounds, display, maximised,
 *    full screen), clamped to a display that is still attached
 *  - native notifications when a scheduled scan crosses its growth threshold
 *  - a real application menu (Settings ⌘, · Scan Folder ⌘O · Rescan ⌘R ·
 *    Help) with Developer Tools and Reload in development builds only
 *  - update checks from GitHub Releases (electron-updater): Windows installs
 *    them; the unsigned macOS build offers the download once, quietly, and
 *    remembers a skipped version
 *
 * The decisions behind all of that are pure functions in electron/lib/ —
 * this file only hands their results to Electron. The IPC contract the page
 * sees is documented at the top of electron/preload.js.
 */
// libuv threadpool: sized before anything can start it — every async fs call
// (the disk scanner's lstat/readdir storm) runs on this pool, and the default
// of 4 threads is the scan-speed bottleneck. Mirrors src/utils/ioThreads.ts.
if (!Number(process.env.UV_THREADPOOL_SIZE)) {
  process.env.UV_THREADPOOL_SIZE = String(Math.min(16, Math.max(8, require('os').cpus().length * 2)));
}

const { app, BrowserWindow, Tray, Menu, Notification, shell, ipcMain, dialog, nativeImage, screen, session, clipboard } =
  require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Built backend lives in dist/. `npm run build` (tsc) must run before packaging.
const { startServer } = require(path.join(__dirname, '..', 'dist', 'server.js'));
const { onGrowthAlert } = require(path.join(__dirname, '..', 'dist', 'services', 'scheduler.js'));
const { diskUsage } = require(path.join(__dirname, '..', 'dist', 'services', 'diskUsage.js'));
const { formatBytes } = require(path.join(__dirname, '..', 'dist', 'utils', 'formatBytes.js'));
const { appDataDir } = require(path.join(__dirname, '..', 'dist', 'services', 'storage.js'));
const { isEphemeral } = require(path.join(__dirname, '..', 'dist', 'services', 'portableMode.js'));
const desktop = require('./lib/desktop');
const guards = require('./lib/guards');
const windowState = require('./lib/windowState');
const { buildMenuTemplate } = require('./lib/menu');

/** Must match the NSIS shortcut's appId (package.json build.appId) or Windows drops our toasts. */
const APP_USER_MODEL_ID = 'com.prithviweb.treemap';
const WINDOW_DEFAULTS = { width: 1320, height: 880, minWidth: 1024, minHeight: 700 };
/** The first update check waits until the page is up and the user has settled in. */
const UPDATE_FIRST_CHECK_MS = 15_000;
/** Breathing room between one scan's finish and the next queued folder's start. */
const QUEUE_STEP_MS = 300;
const STATE_SAVE_DEBOUNCE_MS = 300;

let running = null; // { server, port, shutdown }
let mainWindow = null;
let tray = null;
let trayTimer = null;
let autoUpdater = null;
let updateTimer = null;
let firstUpdateCheck = null;
let interactiveCheck = false;
const offeredUpdates = new Set();

const unref = (timer) => {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
};

/* ───────────────────────────── Prefs file ───────────────────────────── */

function safeIsEphemeral() {
  try {
    return isEphemeral();
  } catch {
    return false;
  }
}

function readPrefs() {
  return windowState.readPrefs(appDataDir());
}

function updatePrefs(patch) {
  const next = { ...readPrefs(), ...patch };
  windowState.writePrefs(appDataDir(), next, { ephemeral: safeIsEphemeral() });
  return next;
}

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

const scanQueue = new desktop.ScanQueue(toScannableDir);
let pumpTimer = null;

function pageReady() {
  return !!mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading();
}

/** Hand the page the next queued folder, if it is ready for one. */
function pumpScanQueue() {
  if (!pageReady()) return;
  const dir = scanQueue.next();
  if (!dir) return;
  showMainWindow();
  mainWindow.webContents.send('treemap:scan-path', dir);
}

function pumpSoon() {
  if (pumpTimer) return;
  pumpTimer = unref(
    setTimeout(() => {
      pumpTimer = null;
      pumpScanQueue();
    }, QUEUE_STEP_MS),
  );
}

/**
 * Every way a folder reaches the shell lands here: dock drops, "Open With",
 * the CLI / "Scan with TreeMap" argv, the tray, the File menu, and the page's
 * own multi-folder drop via `treemap:request-scans`. Folders queue and scan
 * one at a time; the page is pushed the next one when it reports the last
 * finished (see preload.js for the contract).
 */
function requestScans(rawPaths) {
  const result = scanQueue.enqueue(rawPaths);
  if (result.queued.length > 0) pumpScanQueue();
  return result;
}

/** One folder (a dock drop, "Open With", the tray): the same queue. */
function requestScan(rawPath) {
  return requestScans([rawPath]);
}

/**
 * Directory args from a launch/second launch.
 *
 * This is the path the D2 shell integration uses: "Scan with TreeMap" launches
 * `<exe> <folder>`, which lands here and goes through `requestScans` — the same
 * entry point a dock drop uses, rather than a second path-injection mechanism.
 *
 * Unpackaged, Electron's own argv is `[electron, <appDir>, ...]`, and `<appDir>`
 * is a real directory — so `npm run app` would "helpfully" scan the repo. Skip
 * the extra leading argument when running from source.
 */
function scanPathsFromArgv(argv) {
  const from = app.isPackaged ? 1 : 2;
  return argv.slice(from).filter((arg) => {
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

ipcMain.handle('treemap:request-scans', (_event, paths) => {
  if (!Array.isArray(paths)) return null;
  return requestScans(paths.filter((p) => typeof p === 'string'));
});

/* ───────────────────── Dock progress and "scan finished" ───────────────────── */

ipcMain.on('treemap:scan-progress', (_event, value) => {
  const progress = desktop.progressBarValue(value);
  if (progress === -1) {
    // A cleared bar is a scan that ended: never let the queue wait on a page
    // that only reports progress.
    scanQueue.finished();
    pumpSoon();
  } else {
    scanQueue.markBusy();
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(progress);
});

ipcMain.on('treemap:scan-finished', (_event, result) => {
  scanQueue.finished();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1);
  announceScanFinished(result);
  pumpSoon();
});

/** A scan ended while the user was elsewhere: bounce, flash, and say what finished. */
function announceScanFinished(result) {
  const r = result && typeof result === 'object' ? result : null;
  if (!r || r.stopped) return;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return;
  if (process.platform === 'darwin') {
    if (app.dock) app.dock.bounce(r.ok ? 'informational' : 'critical');
  } else {
    mainWindow.flashFrame(true);
  }
  const notice = desktop.scanFinishedNotice(r, formatBytes);
  if (!notice || !Notification.isSupported()) return;
  const n = new Notification({ title: notice.title, body: notice.body });
  n.on('click', showMainWindow);
  n.show();
}

/* ─────────────────────────────── Window ─────────────────────────────── */

async function boot() {
  const publicDir = path.join(__dirname, '..', 'public');
  // The API is never open to whatever local process finds the port: the
  // server enforces this token on /api and hands the page its own session
  // cookie when it serves the UI, so the page needs no change. An owner who
  // set TREEMAP_TOKEN themselves keeps theirs.
  process.env.TREEMAP_TOKEN = desktop.desktopToken(process.env);
  // Port 0 → OS assigns a free port, so two machines never collide.
  running = await startServer({ host: '127.0.0.1', port: 0, publicDir });
  console.log(`[treemap] desktop server ready on 127.0.0.1:${running.port}`);
  hardenSession();
  createWindow(running.port);
  createTray();
  wireGrowthNotifications();
  setupAutoUpdates();
}

/** Electron grants every renderer permission by default; the page uses two. */
function hardenSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_webContents, permission, callback) => callback(guards.permissionAllowed(permission)));
  ses.setPermissionCheckHandler((_webContents, permission) => guards.permissionAllowed(permission));
}

function createWindow(port) {
  const state = windowState.windowStateFor(readPrefs().window, screen.getAllDisplays(), WINDOW_DEFAULTS);
  const win = new BrowserWindow({
    ...(state.x !== undefined ? { x: state.x, y: state.y } : {}),
    width: state.width,
    height: state.height,
    minWidth: WINDOW_DEFAULTS.minWidth,
    minHeight: WINDOW_DEFAULTS.minHeight,
    backgroundColor: '#05060a',
    show: false,
    title: 'TreeMap',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow = win;
  const origin = `http://127.0.0.1:${port}`;

  win.loadURL(`${origin}/`);
  win.once('ready-to-show', () => {
    if (state.maximized) win.maximize();
    if (state.fullScreen) win.setFullScreen(true);
    win.show();
  });
  // `on`, not `once`: a development reload is a new page with no scan running.
  win.webContents.on('did-finish-load', () => {
    scanQueue.reset();
    pumpScanQueue();
    scheduleFirstUpdateCheck();
  });

  // Links: the app's own origin stays in-app, web links open in the real
  // browser, and every other scheme is dropped (never handed to the OS).
  win.webContents.setWindowOpenHandler(({ url }) => {
    const decision = guards.windowOpenDecision(url, origin);
    if (decision.openExternal) shell.openExternal(decision.openExternal).catch(() => {});
    return { action: decision.action };
  });
  // The window only ever navigates to its own server.
  win.webContents.on('will-navigate', (event, url) => {
    if (!guards.navigationAllowed(url, origin)) event.preventDefault();
  });

  win.on('focus', () => win.flashFrame(false));

  // Window state: debounced while it moves, synchronous on close.
  let saveTimer = null;
  const saveState = () => {
    if (win.isDestroyed()) return;
    const bounds = win.getNormalBounds();
    let displayId;
    try {
      displayId = screen.getDisplayMatching(bounds).id;
    } catch {
      displayId = undefined;
    }
    updatePrefs({ window: windowState.stateOfWindow(win, displayId) });
  };
  const saveSoon = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = unref(
      setTimeout(() => {
        saveTimer = null;
        saveState();
      }, STATE_SAVE_DEBOUNCE_MS),
    );
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, saveSoon);
  win.on('close', () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveState();
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (running) createWindow(running.port);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** A dialog parented to the window when there is one (a sheet on macOS). */
function messageBox(options) {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const shown = win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  return shown.catch(() => undefined);
}

/* ─────────────────────────────── Tray ─────────────────────────────── */

/**
 * macOS recolours a "template" (black + alpha) glyph for light and dark
 * menu bars. Windows and Linux never recolour, and a black glyph vanishes
 * on their dark trays — they get the colour glyph (scripts/gen-tray-icon.js).
 */
function trayIconPath() {
  return path.join(__dirname, 'assets', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png');
}

function createTray() {
  const icon = nativeImage.createFromPath(trayIconPath());
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('TreeMap — Disk Space Visualizer');
  tray.on('click', () => {
    // Windows/Linux convention: left-click opens the app.
    if (process.platform !== 'darwin') showMainWindow();
  });
  refreshTray();
  trayTimer = unref(setInterval(refreshTray, 5 * 60_000)); // keep stats fresh
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
  if (!tray) return;
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
    const { title, body } = desktop.growthNotification(alert, formatBytes);
    const n = new Notification({ title, body });
    n.on('click', showMainWindow);
    n.show();
  });
}

/* ───────────────────────────── Auto-update ───────────────────────────── */

function setupAutoUpdates() {
  if (!app.isPackaged) return; // dev runs would just error
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.error('[treemap] electron-updater unavailable:', err);
    autoUpdater = null;
    return;
  }

  if (process.platform === 'darwin') {
    // This build is unsigned, and Squirrel.Mac refuses to install an update
    // into an unsigned app. The old flow still downloaded updates and
    // announced "restart to apply" — the install then silently failed,
    // leaving people convinced they were current while old code kept
    // running (issue #14 was filed from exactly that state, crashing on a
    // bug fixed two releases earlier). On macOS: check only, then hand the
    // user the real download — once per version, never before the window is
    // up, and a skipped version stays skipped across launches.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('update-available', (info) => {
      const asked = interactiveCheck;
      interactiveCheck = false;
      offerMacUpdate(info, asked);
    });
  } else {
    // Windows (NSIS) installs unsigned updates fine — keep the full flow.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', () => {
      interactiveCheck = false; // the download announces itself when it lands
    });
    autoUpdater.on('update-downloaded', (info) => {
      messageBox({
        type: 'info',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        message: `TreeMap ${info.version} has been downloaded.`,
        detail: 'Restart to apply the update — or it installs automatically the next time you quit.',
      }).then((r) => {
        if (r && r.response === 0) autoUpdater.quitAndInstall();
      });
    });
  }
  autoUpdater.on('update-not-available', () => {
    if (!interactiveCheck) return; // a quiet check that finds nothing says nothing
    interactiveCheck = false;
    messageBox({
      type: 'info',
      buttons: ['OK'],
      message: `You're up to date — TreeMap ${app.getVersion()} is the latest version.`,
    });
  });
  autoUpdater.on('error', (err) => {
    // A feed hiccup should never bother the user; log for diagnosis only —
    // unless they asked, in which case they deserve an answer.
    console.error('[treemap] auto-update error:', err?.message || err);
    if (!interactiveCheck) return;
    interactiveCheck = false;
    messageBox({
      type: 'info',
      buttons: ['OK'],
      message: "Couldn't check for updates right now.",
      detail: 'TreeMap will try again later. The latest version is always on the Releases page.',
    });
  });

  // Quietly, every 6 hours (SECURITY.md states this cadence).
  updateTimer = unref(setInterval(check, 6 * 3600_000));
}

/** A quiet check: nothing is said unless a newer version turns up. */
function check() {
  if (!autoUpdater) return;
  autoUpdater.checkForUpdates().catch(() => {});
}

/** Once per run, a little after the page is up — never a dialog over a blank window. */
function scheduleFirstUpdateCheck() {
  if (!autoUpdater || firstUpdateCheck) return;
  firstUpdateCheck = unref(setTimeout(check, UPDATE_FIRST_CHECK_MS));
}

function offerMacUpdate(info, userAsked) {
  const version = info && info.version;
  const win = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : null;
  if (!win || !version) return; // no window to parent it: the periodic check comes back later
  const current = app.getVersion();
  if (!userAsked) {
    const { skippedUpdate } = readPrefs();
    if (!desktop.updateOffer({ version, current, skippedVersion: skippedUpdate, offered: offeredUpdates })) return;
  }
  offeredUpdates.add(version);
  const copy = desktop.updateDialogCopy({ version, current, arch: process.arch });
  dialog
    .showMessageBox(win, {
      type: 'info',
      buttons: copy.buttons,
      defaultId: copy.defaultId,
      cancelId: copy.cancelId,
      message: copy.message,
      detail: copy.detail,
    })
    .then(({ response }) => {
      if (response === copy.downloadIndex) shell.openExternal(desktop.LATEST_RELEASE_URL).catch(() => {});
      else if (response === copy.skipIndex) updatePrefs({ skippedUpdate: version });
    })
    .catch(() => {});
}

/** Help › Check for Updates…: the one check that reports "nothing new". */
function checkForUpdatesInteractive() {
  showMainWindow();
  if (!autoUpdater) {
    // Development or no updater: the Releases page is the honest answer.
    shell.openExternal(desktop.RELEASES_URL).catch(() => {});
    return;
  }
  interactiveCheck = true;
  autoUpdater.checkForUpdates().catch(() => {});
}

/* ───────────────────────────── App lifecycle ───────────────────────────── */

// Last-resort net. Electron's default reaction to an uncaught main-process
// exception is a modal error dialog PER THROW — from a timer that becomes an
// unclosable dialog storm (that storm is what issue #14's reporter sat
// through on v2.1.0). Every known throw path is guarded at its source; this
// net exists so any future regression logs and surfaces once per run instead
// of storming. The stack goes to the log and, behind "Copy details", to the
// clipboard — the dialog itself stays in plain words. Dev runs keep the loud
// default on purpose.
if (app.isPackaged) {
  let reported = false;
  process.on('uncaughtException', (err) => {
    console.error('[treemap] uncaught exception:', err);
    if (reported) return;
    reported = true;
    const crash = desktop.crashDialogFor(err, {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron || 'n/a',
    });
    try {
      messageBox({
        type: 'error',
        buttons: crash.buttons,
        defaultId: crash.defaultId,
        cancelId: crash.cancelId,
        message: crash.message,
        detail: crash.detail,
      }).then((r) => {
        if (r && r.response === crash.copyIndex) clipboard.writeText(crash.details);
      });
    } catch {
      /* dialog unavailable this early — the log line above still lands */
    }
  });
  process.on('unhandledRejection', (reason) => {
    // No dialog: rejections never storm, but they must not vanish either.
    console.error('[treemap] unhandled rejection:', reason);
  });
}

function buildMenu() {
  const actions = {
    command: (name) => () => {
      showMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('treemap:command', name);
    },
    scanFolder: () => {
      showMainWindow();
      const options = { title: 'Choose a folder to scan', properties: ['openDirectory', 'multiSelections'] };
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options))
        .then((r) => {
          if (!r.canceled) requestScans(r.filePaths);
        })
        .catch(() => {});
    },
    scanHome: () => {
      showMainWindow();
      requestScans([os.homedir()]);
    },
    checkForUpdates: checkForUpdatesInteractive,
    showDataFolder: () => {
      shell.openPath(appDataDir()).catch(() => {});
    },
    openExternal: (url) => {
      shell.openExternal(url).catch(() => {});
    },
    about: () => app.showAboutPanel(),
  };
  const template = buildMenuTemplate({ isMac: process.platform === 'darwin', isPackaged: app.isPackaged, actions });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Windows toasts are delivered only when the process's AppUserModelID matches
// a Start-menu shortcut's — electron-builder's NSIS shortcut carries appId.
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

// macOS: folder dropped onto the dock icon / "Open With" — may fire pre-ready,
// and once per item for a multi-folder drop.
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
    requestScans(scanPathsFromArgv(argv));
  });

  app.whenReady().then(() => {
    app.setAboutPanelOptions(desktop.aboutPanelOptions({ version: app.getVersion() }));
    buildMenu();
    boot()
      .then(() => {
        // Windows/Linux: a folder dragged onto the app icon arrives as an arg.
        requestScans(scanPathsFromArgv(process.argv));
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
  // running); quit explicitly from the tray or app menu. Linux is the
  // exception: a desktop without a tray host (stock GNOME) never shows the
  // icon, and an invisible process with no way to quit is worse than losing
  // background scans — so there the last window closing quits.
  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return;
    if (process.platform === 'linux' || !tray) app.quit();
  });

  app.on('before-quit', () => {
    for (const t of [trayTimer, updateTimer, firstUpdateCheck, pumpTimer]) if (t) clearTimeout(t);
    if (running) running.shutdown();
  });
}

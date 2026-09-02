/*
 * A stand-in for the `electron` module, so `electron/main.js` can be loaded
 * under plain Node and driven like the real shell would drive it: windows are
 * created, IPC arrives, the updater emits, a growth alert fires, the process
 * throws. Nothing here is Electron; it records what main.js ASKS Electron to
 * do (setProgressBar, bounce, showMessageBox, Set-Cookie-free env) so the
 * tests can assert on those requests.
 *
 * Electron cannot launch on the test machine, so this is the only way the
 * wiring in main.js gets exercised at all — the pure decisions live in
 * electron/lib/*.js and are tested directly.
 */
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import path from 'node:path';
import { formatBytes } from '../../../src/utils/formatBytes';

export interface Rect { x: number; y: number; width: number; height: number }
export interface Display { id: number; bounds: Rect; workArea: Rect; scaleFactor?: number }

export interface StubOptions {
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
  dataDir: string;
  ephemeral?: boolean;
  displays?: Display[];
  version?: string;
  /** Value for TREEMAP_TOKEN before main.js loads; undefined = unset. */
  token?: string;
  /** Windows start focused unless told otherwise. */
  focused?: boolean;
}

export const DEFAULT_DISPLAY: Display = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 25, width: 1920, height: 1055 },
  scaleFactor: 2,
};

export class FakeWebContents extends EventEmitter {
  sent: Array<{ channel: string; args: unknown[] }> = [];
  windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null;
  /** A real window is loading from loadURL until did-finish-load. */
  loading = true;
  send(channel: string, ...args: unknown[]): void { this.sent.push({ channel, args }); }
  isLoading(): boolean { return this.loading; }
  setWindowOpenHandler(h: (details: { url: string }) => { action: string }): void { this.windowOpenHandler = h; }
  /** Every payload sent on one channel, in order. */
  on_channel(channel: string): unknown[] { return this.sent.filter((s) => s.channel === channel).map((s) => s.args[0]); }
}

export class FakeWindow extends EventEmitter {
  static all: FakeWindow[] = [];
  static focusedByDefault = true;
  options: Record<string, unknown>;
  webContents = new FakeWebContents();
  progress: number[] = [];
  flashes: boolean[] = [];
  destroyed = false;
  visible = false;
  minimized = false;
  maximized = false;
  fullScreen = false;
  focused: boolean;
  bounds: Rect;
  url = '';
  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
    this.focused = FakeWindow.focusedByDefault;
    this.bounds = {
      x: (options.x as number) ?? 100,
      y: (options.y as number) ?? 100,
      width: options.width as number,
      height: options.height as number,
    };
    FakeWindow.all.push(this);
  }
  loadURL(url: string): void { this.url = url; }
  show(): void { this.visible = true; }
  focus(): void { this.focused = true; }
  restore(): void { this.minimized = false; }
  isMinimized(): boolean { return this.minimized; }
  isFocused(): boolean { return this.focused; }
  isVisible(): boolean { return this.visible; }
  isDestroyed(): boolean { return this.destroyed; }
  isMaximized(): boolean { return this.maximized; }
  isFullScreen(): boolean { return this.fullScreen; }
  maximize(): void { this.maximized = true; }
  setFullScreen(v: boolean): void { this.fullScreen = v; }
  getNormalBounds(): Rect { return { ...this.bounds }; }
  getBounds(): Rect { return { ...this.bounds }; }
  setProgressBar(v: number): void { this.progress.push(v); }
  flashFrame(v: boolean): void { this.flashes.push(v); }
  /** What the real window does on ⌘W: 'close' (cancellable), then gone, then 'closed'. */
  close(): void {
    this.emit('close');
    this.destroyed = true;
    FakeWindow.all = FakeWindow.all.filter((w) => w !== this);
    this.emit('closed');
  }
  static getAllWindows(): FakeWindow[] { return FakeWindow.all.filter((w) => !w.destroyed); }
}

export class FakeTray {
  static created: FakeTray[] = [];
  icon: { path: string; template: boolean };
  tooltip = '';
  title = '';
  menu: unknown = null;
  handlers = new Map<string, () => void>();
  constructor(icon: { path: string; template: boolean }) { this.icon = icon; FakeTray.created.push(this); }
  setToolTip(t: string): void { this.tooltip = t; }
  on(ev: string, fn: () => void): void { this.handlers.set(ev, fn); }
  setTitle(t: string): void { this.title = t; }
  setContextMenu(m: unknown): void { this.menu = m; }
  destroy(): void { /* nothing to release */ }
}

export class FakeNotification {
  static shown: Array<Record<string, unknown>> = [];
  static supported = true;
  opts: Record<string, unknown>;
  handlers = new Map<string, () => void>();
  constructor(opts: Record<string, unknown>) { this.opts = opts; }
  static isSupported(): boolean { return FakeNotification.supported; }
  on(ev: string, fn: () => void): void { this.handlers.set(ev, fn); }
  show(): void { FakeNotification.shown.push(this.opts); }
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function makeStub(opts: StubOptions) {
  const displays = opts.displays ?? [DEFAULT_DISPLAY];
  const version = opts.version ?? '4.1.3';
  FakeWindow.all = [];
  FakeWindow.focusedByDefault = opts.focused ?? true;
  FakeTray.created = [];
  FakeNotification.shown = [];
  FakeNotification.supported = true;

  const app = Object.assign(new EventEmitter(), {
    isPackaged: opts.isPackaged ?? true,
    quitCalls: 0,
    aboutOptions: null as Record<string, unknown> | null,
    appUserModelId: null as string | null,
    dockBounces: [] as string[],
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    quit(): void { app.quitCalls++; },
    getVersion: () => version,
    getName: () => 'TreeMap',
    getPath: () => opts.dataDir,
    setAboutPanelOptions(o: Record<string, unknown>): void { app.aboutOptions = o; },
    showAboutPanel(): void { app.aboutShown = (app.aboutShown || 0) + 1; },
    aboutShown: 0,
    setAppUserModelId(id: string): void { app.appUserModelId = id; },
    dock: { bounce(type: string): number { app.dockBounces.push(type); return 1; } },
  });

  const ipcMain = {
    handlers: new Map<string, (...a: unknown[]) => unknown>(),
    listeners: new Map<string, (...a: unknown[]) => unknown>(),
    handle(ch: string, fn: (...a: unknown[]) => unknown): void { ipcMain.handlers.set(ch, fn); },
    on(ch: string, fn: (...a: unknown[]) => unknown): void { ipcMain.listeners.set(ch, fn); },
    /** Test side: what the page's ipcRenderer.invoke would reach. */
    invoke(ch: string, ...args: unknown[]): unknown {
      const fn = ipcMain.handlers.get(ch);
      if (!fn) throw new Error(`no ipcMain.handle for ${ch}`);
      return fn({ sender: {} }, ...args);
    },
    /** Test side: what the page's ipcRenderer.send would reach. */
    fire(ch: string, ...args: unknown[]): unknown {
      const fn = ipcMain.listeners.get(ch);
      if (!fn) throw new Error(`no ipcMain.on for ${ch}`);
      return fn({ sender: {} }, ...args);
    },
  };

  const dialog = {
    boxes: [] as Array<{ parent: unknown; opts: Record<string, unknown> }>,
    responses: [] as number[],
    openDialogResult: { canceled: true, filePaths: [] as string[] },
    showMessageBox(...args: unknown[]): Promise<{ response: number }> {
      const opts = (args.length === 2 ? args[1] : args[0]) as Record<string, unknown>;
      const parent = args.length === 2 ? args[0] : null;
      dialog.boxes.push({ parent, opts });
      const r = dialog.responses.length ? dialog.responses.shift()! : ((opts.cancelId as number) ?? 0);
      return Promise.resolve({ response: r });
    },
    showOpenDialog(): Promise<{ canceled: boolean; filePaths: string[] }> {
      return Promise.resolve(dialog.openDialogResult);
    },
  };

  const Menu = {
    built: [] as Array<{ template: unknown[] }>,
    applied: null as { template: unknown[] } | null,
    buildFromTemplate(template: unknown[]): { template: unknown[] } {
      const m = { template };
      Menu.built.push(m);
      return m;
    },
    setApplicationMenu(m: { template: unknown[] } | null): void { Menu.applied = m; },
  };

  const shell = {
    opened: [] as string[],
    openedPaths: [] as string[],
    openExternal(url: string): Promise<void> { shell.opened.push(url); return Promise.resolve(); },
    openPath(p: string): Promise<string> { shell.openedPaths.push(p); return Promise.resolve(''); },
  };

  const clipboard = { texts: [] as string[], writeText(t: string): void { clipboard.texts.push(t); } };

  const session = {
    defaultSession: {
      permissionRequestHandler: null as null | ((wc: unknown, permission: string, cb: (ok: boolean) => void) => void),
      permissionCheckHandler: null as null | ((wc: unknown, permission: string) => boolean),
      setPermissionRequestHandler(h: (wc: unknown, permission: string, cb: (ok: boolean) => void) => void): void {
        session.defaultSession.permissionRequestHandler = h;
      },
      setPermissionCheckHandler(h: (wc: unknown, permission: string) => boolean): void {
        session.defaultSession.permissionCheckHandler = h;
      },
    },
  };

  const screen = {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
    getDisplayMatching(rect: Rect): Display {
      let best = displays[0];
      let bestArea = -1;
      for (const d of displays) {
        const a = overlap(rect, d.bounds);
        if (a > bestArea) { best = d; bestArea = a; }
      }
      return best;
    },
  };

  const nativeImage = {
    createFromPath(p: string) {
      return { path: p, template: false, setTemplateImage(v: boolean): void { this.template = v; } };
    },
  };

  const autoUpdater = Object.assign(new EventEmitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checks: 0,
    quitAndInstalls: 0,
    checkForUpdates(): Promise<null> { autoUpdater.checks++; return Promise.resolve(null); },
    quitAndInstall(): void { autoUpdater.quitAndInstalls++; },
  });

  const electron = {
    app, BrowserWindow: FakeWindow, Tray: FakeTray, Menu, Notification: FakeNotification, shell, ipcMain, dialog,
    nativeImage, screen, session, clipboard,
  };

  const backend = {
    startServerCalls: [] as Array<{ opts: Record<string, unknown>; tokenAtStart: string | undefined }>,
    shutdowns: 0,
    growthHandlers: [] as Array<(alert: unknown) => void>,
    port: 43210,
  };
  const dist: Record<string, unknown> = {
    'dist/server.js': {
      startServer: async (o: Record<string, unknown>) => {
        backend.startServerCalls.push({ opts: o, tokenAtStart: process.env.TREEMAP_TOKEN });
        return { server: {}, port: backend.port, shutdown(): void { backend.shutdowns++; } };
      },
    },
    'dist/services/scheduler.js': { onGrowthAlert(fn: (alert: unknown) => void): void { backend.growthHandlers.push(fn); } },
    'dist/services/diskUsage.js': { diskUsage: async () => ({ total: 1000e9, free: 400e9 }) },
    'dist/utils/formatBytes.js': { formatBytes },
    'dist/services/storage.js': { appDataDir: () => opts.dataDir },
    'dist/services/portableMode.js': { isEphemeral: () => !!opts.ephemeral },
  };

  return { electron, updater: { autoUpdater }, backend, dist, app, ipcMain, dialog, Menu, shell, clipboard, session, screen, autoUpdater };
}

export type Stub = ReturnType<typeof makeStub>;

const REPO = path.join(__dirname, '..', '..', '..');
const MAIN = path.join(REPO, 'electron', 'main.js');
const LIB_DIR = path.join(REPO, 'electron', 'lib');

function purge(): void {
  for (const key of Object.keys(require.cache)) {
    if (key === MAIN || key.startsWith(LIB_DIR + path.sep)) delete require.cache[key];
  }
}

export interface Harness {
  stub: Stub;
  /** The one main window (throws when none exists). */
  win(): FakeWindow;
  windows(): FakeWindow[];
  /** The page finished loading: what Electron emits after loadURL resolves. */
  loadPage(): Promise<void>;
  /** Let boot()'s awaits run. */
  settle(): Promise<void>;
  /** Push a growth alert the way the scheduler does. */
  growth(alert: Record<string, unknown>): void;
  /** Hand an error to main.js's own uncaughtException listener (not the test runner's). */
  crash(err: unknown): void;
  dispose(): void;
}

/**
 * Load electron/main.js fresh under the stub. Every call is a new "process":
 * module cache purged, platform and packaging as requested, TREEMAP_TOKEN as
 * requested, and whenReady + boot() already settled on return.
 */
export async function loadMain(opts: StubOptions): Promise<Harness> {
  const stub = makeStub(opts);
  const platform = opts.platform ?? 'darwin';
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  const savedToken = process.env.TREEMAP_TOKEN;
  if (opts.token === undefined) delete process.env.TREEMAP_TOKEN;
  else process.env.TREEMAP_TOKEN = opts.token;
  const listenersBefore = {
    uncaught: process.listeners('uncaughtException'),
    rejection: process.listeners('unhandledRejection'),
  };

  const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const origLoad = mod._load;
  mod._load = function patched(request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') return stub.electron;
    if (request === 'electron-updater') return stub.updater;
    const norm = request.replace(/\\/g, '/');
    for (const [suffix, m] of Object.entries(stub.dist)) {
      if (norm.endsWith('/' + suffix)) return m;
    }
    return origLoad.call(this, request, parent, isMain);
  };

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  };

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    mod._load = origLoad;
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    if (savedToken === undefined) delete process.env.TREEMAP_TOKEN;
    else process.env.TREEMAP_TOKEN = savedToken;
    for (const l of process.listeners('uncaughtException')) {
      if (!listenersBefore.uncaught.includes(l)) process.removeListener('uncaughtException', l);
    }
    for (const l of process.listeners('unhandledRejection')) {
      if (!listenersBefore.rejection.includes(l)) process.removeListener('unhandledRejection', l);
    }
    purge();
  };

  let crashListeners: Array<(err: unknown) => void> = [];
  try {
    purge();
    require(MAIN);
    crashListeners = (process.listeners('uncaughtException') as Array<(err: unknown) => void>)
      .filter((l) => !listenersBefore.uncaught.includes(l as never));
    await settle();
  } catch (err) {
    dispose();
    throw err;
  }

  const win = (): FakeWindow => {
    const w = FakeWindow.getAllWindows()[0];
    if (!w) throw new Error('no main window');
    return w;
  };

  return {
    stub,
    win,
    windows: () => FakeWindow.getAllWindows(),
    async loadPage(): Promise<void> {
      const w = win();
      w.webContents.loading = false;
      w.emit('ready-to-show');
      w.webContents.emit('did-finish-load');
      await settle();
    },
    settle,
    growth(alert: Record<string, unknown>): void {
      for (const fn of stub.backend.growthHandlers) fn(alert);
    },
    crash(err: unknown): void {
      if (crashListeners.length === 0) throw new Error('main.js registered no uncaughtException listener');
      for (const l of crashListeners) l(err);
    },
    dispose,
  };
}

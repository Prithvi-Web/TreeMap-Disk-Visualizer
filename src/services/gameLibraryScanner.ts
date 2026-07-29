import fs from 'fs';
import path from 'path';
import { ScanStore, TreeSource, asStore } from './scanStore';

/**
 * gameLibraryScanner — deep game-library awareness (§C7).
 *
 * Game installs are the largest single thing on most consumer disks, and a
 * plain treemap says only "Steam: 400 GB". This finds each launcher's own
 * bookkeeping in the scanned tree and breaks every title into the parts that
 * mean different things to the user:
 *
 *   base install   the game. Deleting it means redownloading it.
 *   shader cache   compiled shaders. Regenerable — the only part this app
 *                  offers to clear, and it costs a one-time stutter.
 *   workshop       subscribed mods and their downloads.
 *   compat prefix  the Proton/Wine prefix (Linux), per app id.
 *   DLC            only when the game keeps it in its own folder; Steam
 *                  usually installs DLC into the base game, and this says so
 *                  rather than inventing a split.
 *
 * Detection is structural, not path-guessing: a Steam library is wherever a
 * `steamapps` directory is, which is exactly why `libraryfolders.vdf` exists —
 * libraries live on any drive. Sizes come from the already-scanned tree; only
 * the small manifest files are read from disk.
 */

export type GameLauncher = 'steam' | 'epic' | 'gog' | 'itch';

export interface GameComponent {
  kind: 'base' | 'shaderCache' | 'workshop' | 'compatPrefix' | 'dlc';
  path: string;
  bytes: number;
}

export interface GameTitle {
  launcher: GameLauncher;
  /** Launcher's own id: Steam appid, Epic AppName, GOG gameId. */
  id: string;
  name: string;
  installPath: string;
  totalBytes: number;
  components: GameComponent[];
  /** Last time the launcher updated it, when the manifest records one. */
  updatedAt?: number;
  /**
   * The size the launcher itself reports, when it records one — Steam's
   * `SizeOnDisk`, Epic's `InstallSize`. Shown next to our own figure so a
   * disagreement is visible rather than hidden.
   */
  reportedBytes?: number;
  /** |reported − measured| ÷ reported, when both are known. */
  reportedDelta?: number;
  /** True when Steam installs this title's DLC into the base game folder. */
  dlcInsideBase?: boolean;
}

export interface GameLibrary {
  launcher: GameLauncher;
  path: string;
  titles: GameTitle[];
  totalBytes: number;
  shaderCacheBytes: number;
}

export interface GameReport {
  libraries: GameLibrary[];
  totalBytes: number;
  shaderCacheBytes: number;
  titleCount: number;
}

/** Folder names a game may use for its own DLC, when it separates them at all. */
const DLC_FOLDERS = new Set(['dlc', 'dlcs', 'downloadable content', 'addons', 'add-ons']);
/** Manifests are tiny; refuse anything that plainly is not one. */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

/* ────────────────────────── Valve KeyValues (.acf / .vdf) ────────────────────────── */

export interface KeyValues {
  [key: string]: string | KeyValues;
}

/**
 * Parse Valve's KeyValues text format, which every Steam manifest uses:
 *
 *   "AppState" { "appid" "440"  "InstalledDepots" { "441" { "size" "12" } } }
 *
 * Quoted tokens only, `{}` for nesting, `//` comments. Deliberately small and
 * total: a malformed manifest yields whatever parsed cleanly rather than
 * throwing, because one bad file must not hide a whole library.
 */
export function parseKeyValues(text: string): KeyValues {
  const root: KeyValues = {};
  const stack: KeyValues[] = [root];
  let pendingKey: string | null = null;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      let token = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          const next = text[j + 1];
          token += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          j += 2;
          continue;
        }
        token += text[j];
        j++;
      }
      i = j + 1;
      if (pendingKey === null) {
        pendingKey = token;
      } else {
        stack[stack.length - 1][pendingKey] = token;
        pendingKey = null;
      }
      continue;
    }
    if (ch === '{') {
      const child: KeyValues = {};
      // A block with no key before it is malformed; keep parsing, drop it.
      if (pendingKey !== null) stack[stack.length - 1][pendingKey] = child;
      pendingKey = null;
      stack.push(child);
      i++;
      continue;
    }
    if (ch === '}') {
      if (stack.length > 1) stack.pop();
      pendingKey = null;
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    i++;
  }
  return root;
}

function kvString(node: KeyValues | undefined, key: string): string | undefined {
  if (!node) return undefined;
  const found = Object.keys(node).find((k) => k.toLowerCase() === key.toLowerCase());
  const value = found === undefined ? undefined : node[found];
  return typeof value === 'string' ? value : undefined;
}

function kvBlock(node: KeyValues | undefined, key: string): KeyValues | undefined {
  if (!node) return undefined;
  const found = Object.keys(node).find((k) => k.toLowerCase() === key.toLowerCase());
  const value = found === undefined ? undefined : node[found];
  return value && typeof value === 'object' ? value : undefined;
}

function readTextFile(file: string, max = MAX_MANIFEST_BYTES): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/* ────────────────────────── store helpers ────────────────────────── */

/** Case-insensitive child lookup — Steam's own casing varies across platforms. */
function childCI(store: ScanStore, id: number, name: string): number {
  const wanted = name.toLowerCase();
  let hit = -1;
  store.forEachChild(id, (c) => {
    if (hit === -1 && store.name(c).toLowerCase() === wanted) hit = c;
  });
  return hit;
}

function sizeOf(store: ScanStore, id: number): number {
  return id === -1 ? 0 : store.size(id);
}

function pushComponent(
  components: GameComponent[],
  kind: GameComponent['kind'],
  store: ScanStore,
  id: number,
  parentPath: string,
): void {
  if (id === -1) return;
  const bytes = store.size(id);
  if (bytes <= 0) return;
  components.push({ kind, path: store.childPath(id, parentPath), bytes });
}

/* ────────────────────────── Steam ────────────────────────── */

/**
 * One `steamapps` directory. `libraryfolders.vdf` lists every OTHER library
 * root Steam knows about — reported so the UI can say a library is elsewhere,
 * but never sized, because a folder outside the scan has no measured bytes and
 * guessing at one would be a lie.
 */
function readSteamLibrary(store: ScanStore, steamappsId: number, steamappsPath: string): GameLibrary {
  const titles: GameTitle[] = [];
  const commonId = childCI(store, steamappsId, 'common');
  const commonPath = commonId === -1 ? '' : store.childPath(commonId, steamappsPath);
  const shaderId = childCI(store, steamappsId, 'shadercache');
  const shaderPath = shaderId === -1 ? '' : store.childPath(shaderId, steamappsPath);
  const compatId = childCI(store, steamappsId, 'compatdata');
  const compatPath = compatId === -1 ? '' : store.childPath(compatId, steamappsPath);
  const workshopId = childCI(store, steamappsId, 'workshop');
  const workshopPath = workshopId === -1 ? '' : store.childPath(workshopId, steamappsPath);
  const workshopContentId = workshopId === -1 ? -1 : childCI(store, workshopId, 'content');
  const workshopDownloadsId = workshopId === -1 ? -1 : childCI(store, workshopId, 'downloads');

  store.forEachChild(steamappsId, (child) => {
    const name = store.name(child);
    if (store.isDir(child) || !/^appmanifest_\d+\.acf$/i.test(name)) return;
    const text = readTextFile(store.childPath(child, steamappsPath));
    if (!text) return;
    const state = kvBlock(parseKeyValues(text), 'AppState');
    const appid = kvString(state, 'appid');
    const installdir = kvString(state, 'installdir');
    if (!appid || !installdir) return; // not a manifest we can act on

    const components: GameComponent[] = [];
    const baseId = commonId === -1 ? -1 : childCI(store, commonId, installdir);
    pushComponent(components, 'base', store, baseId, commonPath);

    // DLC only when the game keeps it in its own folder. Steam usually does
    // not separate it, and inventing a split would be worse than saying so.
    let dlcInsideBase = true;
    if (baseId !== -1) {
      const basePath = store.childPath(baseId, commonPath);
      store.forEachChild(baseId, (sub) => {
        if (store.isDir(sub) && DLC_FOLDERS.has(store.name(sub).toLowerCase())) {
          pushComponent(components, 'dlc', store, sub, basePath);
          dlcInsideBase = false;
        }
      });
    }

    if (shaderId !== -1) pushComponent(components, 'shaderCache', store, childCI(store, shaderId, appid), shaderPath);
    if (compatId !== -1) pushComponent(components, 'compatPrefix', store, childCI(store, compatId, appid), compatPath);
    if (workshopContentId !== -1) {
      pushComponent(components, 'workshop', store, childCI(store, workshopContentId, appid), store.childPath(workshopContentId, workshopPath));
    }
    if (workshopDownloadsId !== -1) {
      pushComponent(components, 'workshop', store, childCI(store, workshopDownloadsId, appid), store.childPath(workshopDownloadsId, workshopPath));
    }

    const reported = Number(kvString(state, 'SizeOnDisk'));
    const lastUpdated = Number(kvString(state, 'LastUpdated'));
    const base = components.find((c) => c.kind === 'base')?.bytes ?? 0;
    const totalBytes = components.reduce((s, c) => s + c.bytes, 0);

    titles.push({
      launcher: 'steam',
      id: appid,
      name: kvString(state, 'name') || installdir,
      installPath: baseId === -1 ? path.join(commonPath || steamappsPath, installdir) : store.childPath(baseId, commonPath),
      totalBytes,
      components,
      updatedAt: Number.isFinite(lastUpdated) && lastUpdated > 0 ? lastUpdated * 1000 : undefined,
      // Compared against the BASE install: SizeOnDisk is what Steam downloaded,
      // which excludes shader cache, workshop and the compat prefix.
      reportedBytes: Number.isFinite(reported) && reported > 0 ? reported : undefined,
      reportedDelta:
        Number.isFinite(reported) && reported > 0 ? Math.abs(reported - base) / reported : undefined,
      dlcInsideBase,
    });
  });

  return finishLibrary('steam', steamappsPath, titles);
}

/* ────────────────────────── Epic ────────────────────────── */

/** Epic writes one JSON `.item` per install under `.../Data/Manifests`. */
function readEpicLibrary(store: ScanStore, manifestsId: number, manifestsPath: string): GameLibrary {
  const titles: GameTitle[] = [];
  store.forEachChild(manifestsId, (child) => {
    if (store.isDir(child) || !store.name(child).toLowerCase().endsWith('.item')) return;
    const text = readTextFile(store.childPath(child, manifestsPath));
    if (!text) return;
    let item: Record<string, unknown>;
    try {
      item = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return; // one unreadable manifest must not hide the rest
    }
    const location = typeof item.InstallLocation === 'string' ? item.InstallLocation : '';
    const name = (typeof item.DisplayName === 'string' && item.DisplayName) || (typeof item.AppName === 'string' && item.AppName) || '';
    if (!location || !name) return;
    const installed = store.findByPath(location);
    const measured = sizeOf(store, installed);
    const reported = typeof item.InstallSize === 'number' ? item.InstallSize : undefined;
    titles.push({
      launcher: 'epic',
      id: typeof item.AppName === 'string' ? item.AppName : name,
      name,
      installPath: location,
      totalBytes: measured,
      // Epic's install location is frequently outside the scanned folder; the
      // component list stays empty rather than claiming bytes nobody measured.
      components: measured > 0 ? [{ kind: 'base', path: location, bytes: measured }] : [],
      reportedBytes: reported,
      reportedDelta: reported && measured > 0 ? Math.abs(reported - measured) / reported : undefined,
    });
  });
  return finishLibrary('epic', manifestsPath, titles);
}

/* ────────────────────────── GOG and itch.io ────────────────────────── */

/** GOG drops a `goggame-<id>.info` JSON into each install directory. */
function readGogTitle(store: ScanStore, dirId: number, dirPath: string, infoId: number): GameTitle | null {
  const text = readTextFile(store.childPath(infoId, dirPath));
  if (!text) return null;
  let info: Record<string, unknown>;
  try {
    info = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const name = typeof info.name === 'string' ? info.name : store.name(dirId);
  const id = typeof info.gameId === 'string' ? info.gameId : store.name(infoId);
  return {
    launcher: 'gog',
    id,
    name,
    installPath: dirPath,
    totalBytes: store.size(dirId),
    components: [{ kind: 'base', path: dirPath, bytes: store.size(dirId) }],
    updatedAt: store.modifiedAt(dirId),
  };
}

/** itch.io installs one game per directory under `<itch>/apps/<title>`. */
function readItchLibrary(store: ScanStore, appsId: number, appsPath: string): GameLibrary {
  const titles: GameTitle[] = [];
  store.forEachChild(appsId, (child) => {
    if (!store.isDir(child) || store.size(child) <= 0) return;
    titles.push({
      launcher: 'itch',
      id: store.name(child),
      name: store.name(child),
      installPath: store.childPath(child, appsPath),
      totalBytes: store.size(child),
      components: [{ kind: 'base', path: store.childPath(child, appsPath), bytes: store.size(child) }],
      updatedAt: store.modifiedAt(child),
    });
  });
  return finishLibrary('itch', appsPath, titles);
}

function finishLibrary(launcher: GameLauncher, libPath: string, titles: GameTitle[]): GameLibrary {
  titles.sort((a, b) => b.totalBytes - a.totalBytes);
  return {
    launcher,
    path: libPath,
    titles,
    totalBytes: titles.reduce((s, t) => s + t.totalBytes, 0),
    shaderCacheBytes: titles.reduce(
      (s, t) => s + t.components.filter((c) => c.kind === 'shaderCache').reduce((n, c) => n + c.bytes, 0),
      0,
    ),
  };
}

/* ────────────────────────── entry point ────────────────────────── */

/** Every game library inside a completed scan, broken down per title. */
export function scanGameLibraries(source: TreeSource): GameReport {
  const store = asStore(source);
  const libraries: GameLibrary[] = [];

  const visit = (id: number, nodePath: string): void => {
    const kids = store.childIds(id);
    if (!kids.length) return;
    const lower = store.name(id).toLowerCase();

    // A Steam library is wherever `steamapps` is — libraries live on any drive,
    // which is the whole reason libraryfolders.vdf exists.
    if (lower === 'steamapps') {
      libraries.push(readSteamLibrary(store, id, nodePath));
      return; // its subtree is accounted for
    }
    // Epic: a `Manifests` directory holding its `.item` JSON files. Matched on
    // what is in it rather than where it is — the launcher's data directory
    // differs on every OS, and a Manifests folder full of .item files is Epic's
    // regardless of the path spelling.
    if (lower === 'manifests' && kids.some((c) => !store.isDir(c) && store.name(c).toLowerCase().endsWith('.item'))) {
      libraries.push(readEpicLibrary(store, id, nodePath));
      return;
    }
    // itch.io: <...>/itch/apps
    if (lower === 'apps' && /(^|[\\/])itch([\\/]|$)/i.test(path.dirname(nodePath))) {
      libraries.push(readItchLibrary(store, id, nodePath));
      return;
    }

    // GOG marks each install directory with its own goggame-<id>.info.
    const gogInfo = kids.find((c) => !store.isDir(c) && /^goggame-\d+\.info$/i.test(store.name(c)));
    if (gogInfo !== undefined) {
      const title = readGogTitle(store, id, nodePath, gogInfo);
      if (title) {
        const existing = libraries.find((l) => l.launcher === 'gog' && l.path === path.dirname(nodePath));
        if (existing) {
          existing.titles.push(title);
          existing.titles.sort((a, b) => b.totalBytes - a.totalBytes);
          existing.totalBytes += title.totalBytes;
        } else {
          libraries.push(finishLibrary('gog', path.dirname(nodePath), [title]));
        }
        return; // a game directory is not searched for more games
      }
    }

    for (const child of kids) {
      if (store.isDir(child)) visit(child, store.childPath(child, nodePath));
    }
  };
  visit(store.rootId, store.rootPath);

  // A library whose manifests all failed to parse is not a finding.
  const found = libraries.filter((l) => l.titles.length > 0);
  found.sort((a, b) => b.totalBytes - a.totalBytes);
  return {
    libraries: found,
    totalBytes: found.reduce((s, l) => s + l.totalBytes, 0),
    shaderCacheBytes: found.reduce((s, l) => s + l.shaderCacheBytes, 0),
    titleCount: found.reduce((s, l) => s + l.titles.length, 0),
  };
}

/**
 * Every shader-cache path in a report. This is the ONLY component the app
 * offers to clear: it is regenerated on the next launch, at the cost of a
 * one-time stutter while the game recompiles.
 */
export function shaderCachePaths(report: GameReport): string[] {
  const paths: string[] = [];
  for (const lib of report.libraries) {
    for (const title of lib.titles) {
      for (const component of title.components) {
        if (component.kind === 'shaderCache') paths.push(component.path);
      }
    }
  }
  return paths;
}

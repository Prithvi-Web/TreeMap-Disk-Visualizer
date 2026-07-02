import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  FileNode,
  ScanResult,
  AppCategory,
  AppEntry,
  AppLocation,
  AppAttributionResult,
} from '../models/types';
import { isInside } from '../utils/pathSanitizer';
import { winLocalAppData, winRoamingAppData, winProgramFilesDirs } from '../utils/osPaths';

/**
 * AppAttribution — maps a completed scan tree to the applications that own
 * the bytes (Apps tab). Pure tree walk over the in-memory scan result: known
 * OS locations ("containers") hold one directory per app; each such child is
 * claimed whole and never counted twice, so per-app totals plus the
 * "everything else" bucket always reconcile with the scan root.
 *
 * Categories: 'app' (the program itself), 'cache' + 'logs' (safe to clear),
 * 'data' (user data/settings — never touched by "Clear caches safely").
 */

const MAX_APPS = 300;
const MAX_LOCATIONS_PER_APP = 12;
// DELETE /api/files accepts at most 500 paths per request — same ceiling here
// so "Clear caches safely" never silently leaves selected caches behind.
const MAX_SAFE_PATHS_PER_APP = 500;

/* ---------------- Attribution context (injectable for tests) ---------------- */

export interface AttributionContext {
  platform: NodeJS.Platform;
  homeDir: string;
  /** bundle id / dir name (lowercased) → display name; curated + Info.plist-derived. */
  names: Map<string, string>;
}

/** How a container derives an app from each child directory. */
type ChildKind = 'bundleId' | 'appName' | 'appBundle' | 'groupContainer' | 'savedState';

interface ContainerSpec {
  /** Absolute path of the directory whose children are per-app dirs. */
  path: string;
  category: AppCategory;
  /** Breakdown label shown in the UI, e.g. "Application Support". */
  label: string;
  kind: ChildKind;
}

/** Vendor directories that hold one more level of per-app dirs. */
const VENDOR_DIRS = new Set([
  'google', 'microsoft', 'mozilla', 'adobe', 'jetbrains', 'oracle', 'autodesk',
  'epic games', 'unity', 'valve', 'obsidian', 'slack technologies',
]);

/** Directory basenames inside an app's data that are really caches. */
const CACHE_DIR_NAMES = new Set([
  'cache', 'caches', 'cached data', 'cachedata', 'code cache', 'gpucache',
  'dawn cache', 'dawngraphitecache', 'dawnwebgpucache', 'shadercache', 'shader cache',
  'blob_storage', 'cachestorage', 'cache_data', 'tmp', 'temp',
]);

/** Directory basenames inside an app's data that are logs/diagnostics. */
const LOG_DIR_NAMES = new Set(['logs', 'log', 'crashpad', 'crash reports', 'crashes', 'sentry']);

/**
 * Well-known bundle ids / dir names → display names, so the same app merges
 * into one row even when only some of its folders are inside the scan.
 */
const CURATED_NAMES: [string, string][] = [
  ['com.google.chrome', 'Google Chrome'],
  ['com.google.chrome.canary', 'Google Chrome Canary'],
  ['org.mozilla.firefox', 'Firefox'],
  ['com.apple.safari', 'Safari'],
  ['com.microsoft.edgemac', 'Microsoft Edge'],
  ['com.brave.browser', 'Brave Browser'],
  ['company.thebrowser.browser', 'Arc'],
  ['com.microsoft.vscode', 'Visual Studio Code'],
  ['com.todesktop.230313mzl4w4u92', 'Cursor'],
  ['com.tinyspeck.slackmacgap', 'Slack'],
  ['slack', 'Slack'],
  ['us.zoom.xos', 'Zoom'],
  ['zoom', 'Zoom'],
  ['com.spotify.client', 'Spotify'],
  ['spotify', 'Spotify'],
  ['com.hnc.discord', 'Discord'],
  ['discord', 'Discord'],
  ['notion.id', 'Notion'],
  ['notion', 'Notion'],
  ['com.figma.desktop', 'Figma'],
  ['figma', 'Figma'],
  ['com.apple.dt.xcode', 'Xcode'],
  ['com.docker.docker', 'Docker'],
  ['com.postmanlabs.mac', 'Postman'],
  ['md.obsidian', 'Obsidian'],
  ['obsidian', 'Obsidian'],
  ['com.anthropic.claudefordesktop', 'Claude'],
  ['com.openai.chat', 'ChatGPT'],
  ['net.whatsapp.whatsapp', 'WhatsApp'],
  ['ru.keepcoder.telegram', 'Telegram'],
  ['com.microsoft.teams2', 'Microsoft Teams'],
  ['com.apple.mail', 'Mail'],
  ['com.apple.photos', 'Photos'],
  ['com.apple.music', 'Music'],
  ['com.utmapp.utm', 'UTM'],
  ['mobilesync', 'iOS Backups (MobileSync)'],
  ['com.apple.bird', 'iCloud Drive sync (bird)'],
  ['google-chrome', 'Google Chrome'],
  ['firefox', 'Firefox'],
  ['code', 'Visual Studio Code'],
  ['chromium', 'Chromium'],
];

export function builtinNames(): Map<string, string> {
  return new Map(CURATED_NAMES);
}

/* ---------------- Container tables per platform ---------------- */

function containersFor(ctx: AttributionContext): ContainerSpec[] {
  const h = ctx.homeDir;
  const j = (...parts: string[]) => path.join(...parts);
  if (ctx.platform === 'darwin') {
    return [
      { path: '/Applications', category: 'app', label: 'Application', kind: 'appBundle' },
      { path: j(h, 'Applications'), category: 'app', label: 'Application', kind: 'appBundle' },
      { path: j(h, 'Library', 'Caches'), category: 'cache', label: 'Caches', kind: 'bundleId' },
      { path: j(h, 'Library', 'Application Support'), category: 'data', label: 'Application Support', kind: 'appName' },
      { path: j(h, 'Library', 'Containers'), category: 'data', label: 'Containers', kind: 'bundleId' },
      { path: j(h, 'Library', 'Group Containers'), category: 'data', label: 'Group Containers', kind: 'groupContainer' },
      { path: j(h, 'Library', 'Logs'), category: 'logs', label: 'Logs', kind: 'bundleId' },
      { path: j(h, 'Library', 'Saved Application State'), category: 'data', label: 'Saved State', kind: 'savedState' },
    ];
  }
  if (ctx.platform === 'win32') {
    // Env vars only mean something when we're really on Windows; otherwise
    // (tests exercising win32 rules elsewhere) derive everything from ctx.
    const onWindows = process.platform === 'win32';
    const programFiles = onWindows ? winProgramFilesDirs() : ['C:\\Program Files', 'C:\\Program Files (x86)'];
    const local = onWindows ? winLocalAppData() : j(h, 'AppData', 'Local');
    const roaming = onWindows ? winRoamingAppData() : j(h, 'AppData', 'Roaming');
    const specs: ContainerSpec[] = programFiles.map((p) => ({
      path: p, category: 'app' as AppCategory, label: 'Program Files', kind: 'appName' as ChildKind,
    }));
    specs.push(
      { path: path.join(local, 'Programs'), category: 'app', label: 'Programs', kind: 'appName' },
      { path: roaming, category: 'data', label: 'AppData (Roaming)', kind: 'appName' },
      { path: local, category: 'data', label: 'AppData (Local)', kind: 'appName' },
    );
    return specs;
  }
  return [
    { path: j(h, '.cache'), category: 'cache', label: 'Cache (~/.cache)', kind: 'appName' },
    { path: j(h, '.config'), category: 'data', label: 'Config (~/.config)', kind: 'appName' },
    { path: j(h, '.local', 'share'), category: 'data', label: 'Data (~/.local/share)', kind: 'appName' },
    { path: j(h, '.local', 'state'), category: 'logs', label: 'State (~/.local/state)', kind: 'appName' },
    { path: j(h, '.var', 'app'), category: 'data', label: 'Flatpak', kind: 'bundleId' },
    { path: j(h, 'snap'), category: 'data', label: 'Snap', kind: 'appName' },
  ];
}

/** Windows: children of AppData that are never per-app dirs. */
const WIN_APPDATA_SKIP = new Set(['temp', 'packages', 'comms', 'connecteddevicesplatform']);

/* ---------------- Name resolution ---------------- */

function normKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** "com.google.Chrome" → "Chrome"; "google-chrome" → "Google Chrome" is curated. */
function prettify(raw: string): string {
  const last = raw.includes('.') ? raw.split('.').pop()! : raw;
  const spaced = last.replace(/[-_]+/g, ' ').trim();
  return spaced.length <= 1 ? raw : spaced.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Looks like a reverse-DNS bundle id (com.vendor.App) rather than a name. */
function looksLikeBundleId(name: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9_-]+){1,}$/i.test(name) && name.includes('.') && !name.endsWith('.app');
}

/** Resolve a raw child dir name to { key, display } given the names map. */
function resolveName(raw: string, ctx: AttributionContext): { key: string; display: string } {
  const lower = raw.toLowerCase();
  const curated = ctx.names.get(lower);
  const display = curated ?? prettify(raw);
  return { key: normKey(display), display };
}

/* ---------------- The attribution walk ---------------- */

interface AppAccumulator {
  name: string;
  id: string;
  totalBytes: number;
  bytesByCategory: Map<AppCategory, number>;
  locations: AppLocation[];
  safeBytes: number;
  safePaths: string[];
}

function accFor(apps: Map<string, AppAccumulator>, key: string, display: string, id: string): AppAccumulator {
  let a = apps.get(key);
  if (!a) {
    a = { name: display, id, totalBytes: 0, bytesByCategory: new Map(), locations: [], safeBytes: 0, safePaths: [] };
    apps.set(key, a);
  }
  return a;
}

/**
 * Split a claimed subtree into (default category, cache, logs) byte totals.
 * Cache/log subdirs found inside a data claim are also collected as safe-to-
 * clear paths (a data dir itself never is).
 */
function splitClaim(
  node: FileNode,
  defaultCat: AppCategory,
  addBytes: (cat: AppCategory, bytes: number) => void,
  addSafePath: (p: string, bytes: number) => void,
): void {
  if (defaultCat === 'app') {
    addBytes('app', node.size); // an app bundle is one opaque unit
    return;
  }
  if (defaultCat === 'cache' || defaultCat === 'logs') {
    addBytes(defaultCat, node.size);
    if (node.size > 0) addSafePath(node.path, node.size);
    return;
  }
  // data claim: pull cache/log subdirs out, rest stays data
  let dataBytes = node.size;
  const stack: FileNode[] = [node];
  while (stack.length) {
    const cur = stack.pop()!;
    if (!cur.children) continue;
    for (const child of cur.children) {
      if (child.type !== 'dir') continue;
      const lower = child.name.toLowerCase();
      if (CACHE_DIR_NAMES.has(lower)) {
        addBytes('cache', child.size);
        dataBytes -= child.size;
        if (child.size > 0) addSafePath(child.path, child.size);
      } else if (LOG_DIR_NAMES.has(lower)) {
        addBytes('logs', child.size);
        dataBytes -= child.size;
        if (child.size > 0) addSafePath(child.path, child.size);
      } else {
        stack.push(child);
      }
    }
  }
  addBytes('data', dataBytes);
}

/** Derive the app identity for one container child, or null to leave unclaimed. */
function identityFor(child: FileNode, spec: ContainerSpec, ctx: AttributionContext):
  { key: string; display: string; id: string } | null {
  const name = child.name;
  switch (spec.kind) {
    case 'appBundle': {
      if (child.type !== 'dir' || !name.toLowerCase().endsWith('.app')) return null;
      const base = name.slice(0, -4);
      const r = resolveName(base, ctx);
      return { key: r.key, display: r.display, id: normKey(base) };
    }
    case 'savedState': {
      const base = name.toLowerCase().endsWith('.savedstate') ? name.slice(0, -'.savedstate'.length) : name;
      const r = resolveName(base, ctx);
      return { key: r.key, display: r.display, id: base.toLowerCase() };
    }
    case 'groupContainer': {
      // "ABCDE12345.group.com.foo.bar" → "group.com.foo.bar" → app "Bar"
      const stripped = name.replace(/^[A-Z0-9]{8,12}\./, '').replace(/^group\./i, '');
      const r = resolveName(stripped, ctx);
      return { key: r.key, display: r.display, id: stripped.toLowerCase() };
    }
    case 'bundleId':
    case 'appName': {
      if (child.type !== 'dir') return null;
      const r = resolveName(name, ctx);
      return { key: r.key, display: r.display, id: name.toLowerCase() };
    }
  }
}

/**
 * Attribute a scan tree to applications. Pure: everything OS-specific comes
 * in through `ctx`, so tests can exercise any platform's rules anywhere.
 */
export function attributeTree(root: FileNode, ctx: AttributionContext): Omit<AppAttributionResult, 'scanId'> {
  const containers = containersFor(ctx);
  const cmp = ctx.platform === 'linux'
    ? (a: string, b: string) => a === b
    : (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const containerByPath = new Map<string, ContainerSpec>(
    containers.map((c) => [ctx.platform === 'linux' ? c.path : c.path.toLowerCase(), c]),
  );
  const specAt = (p: string): ContainerSpec | undefined =>
    containerByPath.get(ctx.platform === 'linux' ? p : p.toLowerCase());

  const apps = new Map<string, AppAccumulator>();

  const claim = (child: FileNode, spec: ContainerSpec, vendorPrefix?: string): void => {
    const ident = identityFor(child, spec, ctx);
    if (!ident || child.size <= 0) return;
    // A vendor dir (Google/Chrome) prefixes the app name unless curated already did.
    let display = ident.display;
    if (vendorPrefix && !ctx.names.has(child.name.toLowerCase())) {
      const combined = `${vendorPrefix} ${display}`;
      const curatedCombined = ctx.names.get(combined.toLowerCase());
      display = curatedCombined ?? combined;
    }
    const key = normKey(display);
    const acc = accFor(apps, key, display, ident.id);
    acc.totalBytes += child.size;
    acc.locations.push({ path: child.path, bytes: child.size, category: spec.category, label: spec.label });
    splitClaim(
      child,
      spec.category,
      (cat, bytes) => { if (bytes > 0) acc.bytesByCategory.set(cat, (acc.bytesByCategory.get(cat) ?? 0) + bytes); },
      (p, bytes) => {
        if (acc.safePaths.length < MAX_SAFE_PATHS_PER_APP) { acc.safePaths.push(p); acc.safeBytes += bytes; }
      },
    );
  };

  const processContainer = (node: FileNode, spec: ContainerSpec): void => {
    if (!node.children) return;
    for (const child of node.children) {
      if (child.type !== 'dir') continue; // stray files fall to "everything else"
      // e.g. %LOCALAPPDATA%\Programs is a container nested inside a container
      const nested = specAt(child.path);
      if (nested) { processContainer(child, nested); continue; }
      const lower = child.name.toLowerCase();
      if (spec.kind === 'appBundle' && !lower.endsWith('.app')) {
        // e.g. /Applications/Utilities — one more level of bundles
        if (child.children) {
          for (const inner of child.children) {
            if (inner.type === 'dir' && inner.name.toLowerCase().endsWith('.app')) claim(inner, spec);
          }
        }
        continue;
      }
      if (spec.kind === 'appName' && ctx.platform === 'win32' && WIN_APPDATA_SKIP.has(lower) && spec.category !== 'app') {
        continue;
      }
      if ((spec.kind === 'appName' || spec.kind === 'bundleId') && VENDOR_DIRS.has(lower) && child.children) {
        const vendor = prettify(child.name);
        for (const inner of child.children) {
          if (inner.type === 'dir') claim(inner, spec, vendor);
        }
        continue;
      }
      claim(child, spec);
    }
  };

  // Walk down from the scan root until container paths are hit.
  const visit = (node: FileNode): void => {
    const spec = specAt(node.path);
    if (spec) { processContainer(node, spec); return; }
    if (!node.children) return;
    for (const child of node.children) if (child.type === 'dir') visit(child);
  };
  visit(root);

  const entries: AppEntry[] = [...apps.values()]
    .sort((a, b) => b.totalBytes - a.totalBytes)
    .slice(0, MAX_APPS)
    .map((a) => ({
      name: a.name,
      id: a.id,
      totalBytes: a.totalBytes,
      bytesByCategory: Object.fromEntries(a.bytesByCategory) as AppEntry['bytesByCategory'],
      locations: a.locations.sort((x, y) => y.bytes - x.bytes).slice(0, MAX_LOCATIONS_PER_APP),
      safeToClearBytes: a.safeBytes,
      safeToClearPaths: a.safePaths,
    }));

  // Apps beyond the cap fold back into "everything else" so totals reconcile.
  const listedBytes = entries.reduce((s, e) => s + e.totalBytes, 0);

  // Only system-level app folders count (/Applications, Program Files):
  // a home scan covers ~/Applications yet still misses most app binaries.
  // Platforms with no such folder (Linux) report true — nothing is missing.
  const systemAppDirs = containers.filter((c) => c.category === 'app' && !isInside(ctx.homeDir, c.path));
  const appsFolderScanned = systemAppDirs.length === 0
    || systemAppDirs.some((c) => cmp(c.path, root.path) || isInside(root.path, c.path));

  return {
    apps: entries,
    otherBytes: root.size - listedBytes,
    totalBytes: root.size,
    appsFolderScanned,
  };
}

/* ---------------- macOS bundle-id resolution (Info.plist) ---------------- */

const execFileP = promisify(execFile);
/** app bundle path → names discovered from its Info.plist (never re-read while running). */
const plistCache = new Map<string, { bundleId?: string; display?: string }>();
const PLIST_CONCURRENCY = 4;
const PLIST_MAX_APPS = 400;

/** Collect *.app bundle nodes sitting in Applications containers of the tree. */
function collectAppBundles(root: FileNode, ctx: AttributionContext): FileNode[] {
  const out: FileNode[] = [];
  const appDirs = containersFor(ctx).filter((c) => c.kind === 'appBundle').map((c) => c.path.toLowerCase());
  const walk = (node: FileNode, inApps: boolean): void => {
    if (!node.children) return;
    const here = inApps || appDirs.includes(node.path.toLowerCase());
    for (const child of node.children) {
      if (child.type !== 'dir') continue;
      if (here && child.name.toLowerCase().endsWith('.app')) out.push(child);
      else if (out.length < PLIST_MAX_APPS) walk(child, here);
    }
  };
  walk(root, false);
  return out.slice(0, PLIST_MAX_APPS);
}

/** Read CFBundleIdentifier/Name from Info.plist via macOS's built-in plutil. */
async function readPlistNames(appPath: string): Promise<{ bundleId?: string; display?: string }> {
  const cached = plistCache.get(appPath);
  if (cached) return cached;
  let result: { bundleId?: string; display?: string } = {};
  try {
    const plist = path.join(appPath, 'Contents', 'Info.plist');
    const { stdout } = await execFileP('plutil', ['-convert', 'json', '-o', '-', plist], {
      timeout: 3000, maxBuffer: 4 * 1024 * 1024,
    });
    const info = JSON.parse(stdout) as Record<string, unknown>;
    result = {
      bundleId: typeof info.CFBundleIdentifier === 'string' ? info.CFBundleIdentifier : undefined,
      display:
        (typeof info.CFBundleDisplayName === 'string' && info.CFBundleDisplayName) ||
        (typeof info.CFBundleName === 'string' && info.CFBundleName) ||
        undefined,
    };
  } catch {
    /* unreadable bundle — heuristics cover it */
  }
  plistCache.set(appPath, result);
  return result;
}

/** Augment the curated names map with real bundle ids from scanned .app bundles. */
async function resolveMacNames(root: FileNode, ctx: AttributionContext): Promise<void> {
  const bundles = collectAppBundles(root, ctx);
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < bundles.length) {
      const bundle = bundles[i++];
      const { bundleId, display } = await readPlistNames(bundle.path);
      const appName = display || bundle.name.slice(0, -4);
      if (bundleId && !ctx.names.has(bundleId.toLowerCase())) {
        ctx.names.set(bundleId.toLowerCase(), appName);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PLIST_CONCURRENCY, bundles.length) }, worker));
}

/* ---------------- Public entry point ---------------- */

/** Attribution results per scan; entries vanish with the scan itself. */
const resultCache = new WeakMap<ScanResult, AppAttributionResult>();

export async function getAppAttribution(
  scan: ScanResult & { root: FileNode },
): Promise<AppAttributionResult> {
  const cached = resultCache.get(scan);
  if (cached) return cached;

  const ctx: AttributionContext = {
    platform: process.platform,
    homeDir: os.homedir(),
    names: builtinNames(),
  };
  if (ctx.platform === 'darwin') await resolveMacNames(scan.root, ctx);

  const result: AppAttributionResult = { scanId: scan.scanId, ...attributeTree(scan.root, ctx) };
  resultCache.set(scan, result);
  return result;
}

import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { startScan } from './diskScanner';
import { getAppIconPng } from './maintenance';
import { AppSummary, AppLeftover, AppLeftoversResult } from '../models/types';

/**
 * apps — the macOS "Uninstaller". Lists installed applications and finds the
 * support files an app leaves behind under ~/Library (AppCleaner-style).
 *
 * Safety spine (unchanged): nothing here deletes. The route trashes through the
 * normal `DELETE /api/files` path, which is authorized by `requireInsideScanRoot`.
 * To make that authorization hold, `findLeftovers` runs a real `startScan()` on
 * the app bundle and every candidate leftover before returning — registering each
 * path as a scan root. That same scan also yields the sizes shown in the UI.
 *
 * Only user-space app folders are ever touched: /Applications and ~/Applications.
 * /System/Applications (Apple's built-ins) is never enumerated or accepted.
 */

interface ExecResult {
  stdout: string;
  stderr: string;
}

function execFileP(cmd: string, args: string[], timeoutMs = 15000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          (err as NodeJS.ErrnoException & ExecResult).stdout = stdout;
          (err as NodeJS.ErrnoException & ExecResult).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      }
    );
  });
}

/** The only two directories we treat as app sources (never /System/Applications). */
export function appRoots(): string[] {
  return ['/Applications', path.join(os.homedir(), 'Applications')];
}

/** Run an async mapper over items with a bounded number of concurrent workers. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The app icon as a base64 PNG data URI, or null if none/unconvertible.
 * Reuses Maintenance's `getAppIconPng` (the single shared .icns→PNG extractor)
 * so both features stay consistent; we deliver it inline (not via a per-icon
 * endpoint) to avoid a request burst when listing dozens of apps at once.
 */
export async function appIconDataUri(appPath: string): Promise<string | null> {
  try {
    const png = await getAppIconPng(appPath);
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return null; // no icon, non-macOS, or sips failed — fall back to a letter tile
  }
}

/** Read an app bundle's Info.plist into an AppSummary (best-effort, with icon). */
async function readAppMeta(appPath: string): Promise<AppSummary> {
  const base = path.basename(appPath).replace(/\.app$/i, '');
  let info: Record<string, unknown> = {};
  try {
    // plutil converts binary or XML plists to JSON we can parse without a dep.
    const { stdout } = await execFileP(
      'plutil',
      ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')],
      8000
    );
    info = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    /* missing/unreadable plist — fall back to the filename */
  }
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v : null;

  const bundleId = str(info.CFBundleIdentifier);
  // Mac App Store apps carry a receipt; everything else self-updates / unknown.
  const masReceipt = path.join(appPath, 'Contents', '_MASReceipt', 'receipt');
  const isMas = await fsp
    .access(masReceipt)
    .then(() => true)
    .catch(() => false);

  return {
    name: base,
    path: appPath,
    bundleId,
    version: str(info.CFBundleShortVersionString) ?? str(info.CFBundleVersion),
    executable: str(info.CFBundleExecutable),
    icon: await appIconDataUri(appPath),
    updateSource: isMas ? 'mas' : 'self',
    website: websiteFromBundleId(bundleId),
  };
}

/** Best-effort vendor website from a reverse-DNS bundle id (com.google.Chrome → https://google.com). */
function websiteFromBundleId(bundleId: string | null): string | null {
  if (!bundleId) return null;
  const parts = bundleId.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  const TLDS = new Set(['com', 'org', 'net', 'io', 'co', 'app', 'dev', 'me', 'ai']);
  const tld = parts[0].toLowerCase();
  if (!TLDS.has(tld)) return null;
  const domain = parts[1].toLowerCase();
  if (!domain || domain === 'apple') return null; // Apple bundles have no useful vendor page
  return `https://${domain}.${tld}`;
}

/** List installed apps. macOS only; cheap (no per-app sizing on this path). */
export async function listInstalledApps(): Promise<AppSummary[]> {
  if (process.platform !== 'darwin') return [];

  const seen = new Set<string>();
  const bundles: string[] = [];
  for (const dir of appRoots()) {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue; // ~/Applications often doesn't exist — skip silently
    }
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.app')) continue;
      if (name.startsWith('.')) continue; // hidden helper bundles — Finder hides these
      const full = path.join(dir, name);
      if (seen.has(full)) continue;
      seen.add(full);
      bundles.push(full);
    }
  }

  const apps = await mapPool(bundles, 8, readAppMeta);
  apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return apps;
}

/** True when a process whose name exactly equals `executable` is running. */
async function isAppRunning(executable: string | null): Promise<boolean> {
  if (!executable) return false;
  try {
    // pgrep -x matches the process name exactly (no false positives from
    // substrings, unlike `pgrep -f`). Exit 0 = at least one match.
    await execFileP('pgrep', ['-x', executable], 5000);
    return true;
  } catch {
    return false; // exit 1 (no match) or pgrep missing
  }
}

interface Candidate {
  path: string;
  category: string;
}

/**
 * Build the list of ~/Library leftover paths for an app, matched by bundle id
 * (exact + prefixed) and by exact app name. Only existing paths are returned.
 */
async function collectLeftovers(
  bundleId: string | null,
  displayName: string,
  fileBase: string
): Promise<Candidate[]> {
  const home = os.homedir();
  const L = (...p: string[]): string => path.join(home, 'Library', ...p);

  const names = new Set<string>();
  for (const n of [displayName, fileBase]) if (n) names.add(n.toLowerCase());

  const out: Candidate[] = [];

  const pushIfExists = async (full: string, category: string): Promise<void> => {
    try {
      await fsp.lstat(full);
      out.push({ path: full, category });
    } catch {
      /* not present */
    }
  };

  const matchInDir = async (
    dir: string,
    category: string,
    pred: (name: string) => boolean
  ): Promise<void> => {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (pred(name)) out.push({ path: path.join(dir, name), category });
    }
  };

  // Exact bundle-id-named items (no readdir needed).
  if (bundleId) {
    await pushIfExists(L('Application Support', bundleId), 'Application Support');
    await pushIfExists(L('Caches', bundleId), 'Caches');
    await pushIfExists(L('Preferences', `${bundleId}.plist`), 'Preferences');
    await pushIfExists(L('Containers', bundleId), 'Containers');
    await pushIfExists(L('Saved Application State', `${bundleId}.savedState`), 'Saved State');
    await pushIfExists(L('HTTPStorages', bundleId), 'HTTPStorages');
    await pushIfExists(L('HTTPStorages', `${bundleId}.binarycookies`), 'HTTPStorages');
    await pushIfExists(L('WebKit', bundleId), 'WebKit');
    await pushIfExists(L('Logs', bundleId), 'Logs');
    await pushIfExists(L('Cookies', `${bundleId}.binarycookies`), 'Cookies');
  }

  // Prefix / substring matches that need a directory listing.
  const lowerId = bundleId ? bundleId.toLowerCase() : null;
  await matchInDir(L('Preferences'), 'Preferences', (n) => {
    const l = n.toLowerCase();
    return lowerId !== null && l.startsWith(lowerId + '.') && l.endsWith('.plist');
  });
  await matchInDir(L('Preferences', 'ByHost'), 'Preferences', (n) =>
    lowerId !== null ? n.toLowerCase().startsWith(lowerId + '.') : false
  );
  await matchInDir(L('LaunchAgents'), 'LaunchAgents', (n) =>
    lowerId !== null ? n.toLowerCase().includes(lowerId) && n.toLowerCase().endsWith('.plist') : false
  );
  await matchInDir(L('Group Containers'), 'Group Containers', (n) =>
    lowerId !== null ? n.toLowerCase().includes(lowerId) : false
  );

  // Name-matched folders (some apps name support dirs by their human name).
  for (const dir of ['Application Support', 'Caches', 'Logs']) {
    await matchInDir(L(dir), dir, (n) => names.has(n.toLowerCase()));
  }

  // Dedupe — a path can match more than one rule.
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)));
}

/** Register a path as a scan root and return its size once the scan settles. */
async function registerAndSize(target: string): Promise<number> {
  let scan;
  try {
    scan = await startScan(target);
  } catch {
    return 0; // vanished between discovery and scan — not offered for delete
  }
  const deadline = Date.now() + 45000; // generous cap for large bundles
  while (scan.status === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 60));
  }
  return scan.root ? scan.root.size : 0;
}

/**
 * Analyze one app: read its metadata, find leftovers, register every path for
 * deletion authorization, and return sizes inline.
 */
export async function findLeftovers(appPath: string): Promise<AppLeftoversResult> {
  const meta = await readAppMeta(appPath);
  const fileBase = path.basename(appPath).replace(/\.app$/i, '');
  const running = await isAppRunning(meta.executable);

  const candidates = await collectLeftovers(meta.bundleId, meta.name, fileBase);

  // Register + size the bundle and each leftover. startScan registers the root
  // immediately (before walking), so even a slow scan still authorizes the later
  // DELETE; we await for accurate sizes.
  const targets = [appPath, ...candidates.map((c) => c.path)];
  const sizes = await Promise.all(targets.map(registerAndSize));

  const appSize = sizes[0];
  const leftovers: AppLeftover[] = candidates.map((c, i) => ({
    name: path.basename(c.path),
    path: c.path,
    category: c.category,
    size: sizes[i + 1],
  }));
  const totalSize = sizes.reduce((s, v) => s + v, 0);

  return {
    app: {
      name: meta.name,
      path: appPath,
      bundleId: meta.bundleId,
      version: meta.version,
      icon: meta.icon,
      size: appSize,
      running,
    },
    leftovers,
    totalSize,
  };
}

import { execFile } from 'child_process';
import { promises as fsp, constants as fsConstants } from 'fs';
import path from 'path';
import { appRoots, appIconDataUri, listInstalledApps } from './apps';
import {
  OutdatedCask, BrewUpgradeResult, UpdaterOtherApp, MasUpdate, SparkleUpdate, AppUpdate, AppUpdateInfo,
} from '../models/types';

/**
 * updater — the macOS "Updater". A deliberately small, honest panel built on
 * Homebrew (the one update mechanism we can query without bundling per-vendor
 * network catalogs). If `brew` isn't installed the whole feature reports
 * unavailable; we never fabricate update data.
 *
 * Read path:  `brew outdated --cask --greedy --json=v2`  (includes auto-updating
 *             casks so the list matches what the user sees in Homebrew).
 * Write path: `brew upgrade --cask <token>` per app, explicitly user-triggered.
 *
 * No new dependency: `brew` is the user's own tool, invoked via execFile (argv
 * array, no shell) so a token can never be interpreted as shell syntax.
 */

interface ExecResult {
  stdout: string;
  stderr: string;
}

function execFileP(cmd: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
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

const BREW_CANDIDATES = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];

// Cache the resolved brew path (or null) for the process lifetime.
let cachedBrew: string | null | undefined;

async function brewPath(): Promise<string | null> {
  if (cachedBrew !== undefined) return cachedBrew;
  if (process.platform !== 'darwin') {
    cachedBrew = null;
    return null;
  }
  for (const candidate of BREW_CANDIDATES) {
    try {
      await fsp.access(candidate, fsConstants.X_OK);
      cachedBrew = candidate;
      return candidate;
    } catch {
      /* not here — try the next */
    }
  }
  try {
    const { stdout } = await execFileP('/usr/bin/which', ['brew'], 4000);
    const resolved = stdout.trim();
    if (resolved) {
      cachedBrew = resolved;
      return resolved;
    }
  } catch {
    /* not on PATH */
  }
  cachedBrew = null;
  return null;
}

export async function brewAvailable(): Promise<boolean> {
  return (await brewPath()) !== null;
}

/** Collapse a name/token to alphanumerics for fuzzy app↔cask matching. */
function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Best-effort: find the installed .app a cask token corresponds to, for its icon. */
async function caskIcon(token: string): Promise<string | null> {
  const norm = normalizeToken(token);
  for (const dir of appRoots()) {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.app') || name.startsWith('.')) continue;
      if (normalizeToken(name.replace(/\.app$/i, '')) === norm) {
        return appIconDataUri(path.join(dir, name));
      }
    }
  }
  return null;
}

/** Last non-empty line of a multi-line string (brew's most relevant message). */
function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

export async function outdatedCasks(): Promise<OutdatedCask[]> {
  const brew = await brewPath();
  if (!brew) return [];
  try {
    const { stdout } = await execFileP(
      brew,
      ['outdated', '--cask', '--greedy', '--json=v2'],
      90000
    );
    const data = JSON.parse(stdout) as {
      casks?: Array<{
        name?: unknown;
        installed_versions?: unknown;
        current_version?: unknown;
      }>;
    };
    const casks = Array.isArray(data.casks) ? data.casks : [];
    const mapped = casks
      .map((c) => {
        const token = typeof c.name === 'string' ? c.name : '';
        const installed =
          Array.isArray(c.installed_versions) && c.installed_versions.length > 0
            ? String(c.installed_versions[0])
            : null;
        const latest = c.current_version != null ? String(c.current_version) : null;
        return { token, name: token, installedVersion: installed, latestVersion: latest };
      })
      .filter((c) => c.token.length > 0);
    return Promise.all(
      mapped.map(async (c) => ({ ...c, icon: await caskIcon(c.token) }))
    );
  } catch {
    // Network hiccup, brew error, or timeout — surface "no updates" rather than
    // a hard failure; the UI stays usable.
    return [];
  }
}

/**
 * Installed apps that aren't Homebrew casks, tagged with how they update
 * (Mac App Store vs self-updating). brew handles the actionable updates; this
 * list lets the UI offer an App Store / website link for everything else, since
 * most self-updating apps expose no externally-invokable update handler.
 */
export async function otherApps(casks: OutdatedCask[]): Promise<UpdaterOtherApp[]> {
  const apps = await listInstalledApps();
  const caskNames = new Set(casks.map((c) => normalizeToken(c.token)));
  return apps
    .filter((a) => !caskNames.has(normalizeToken(a.name)))
    .map((a) => ({
      name: a.name,
      path: a.path,
      icon: a.icon,
      source: a.updateSource,
      website: a.website,
    }));
}

export async function upgradeCask(token: string): Promise<BrewUpgradeResult> {
  const brew = await brewPath();
  if (!brew) return { ok: false, token, message: 'Homebrew is not installed' };
  try {
    const { stdout } = await execFileP(brew, ['upgrade', '--cask', token], 5 * 60 * 1000);
    return { ok: true, token, message: lastLine(stdout) || 'Updated' };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & ExecResult;
    const detail = lastLine(e.stderr || '') || (e.message || 'upgrade failed').trim();
    return { ok: false, token, message: detail };
  }
}

/* ---------- Mac App Store (optional, via the `mas` CLI) ---------- */

const MAS_CANDIDATES = ['/opt/homebrew/bin/mas', '/usr/local/bin/mas'];
let cachedMas: string | null | undefined;

async function masPath(): Promise<string | null> {
  if (cachedMas !== undefined) return cachedMas;
  if (process.platform !== 'darwin') {
    cachedMas = null;
    return null;
  }
  for (const candidate of MAS_CANDIDATES) {
    try {
      await fsp.access(candidate, fsConstants.X_OK);
      cachedMas = candidate;
      return candidate;
    } catch {
      /* try next */
    }
  }
  try {
    const { stdout } = await execFileP('/usr/bin/which', ['mas'], 4000);
    const resolved = stdout.trim();
    if (resolved) {
      cachedMas = resolved;
      return resolved;
    }
  } catch {
    /* not on PATH */
  }
  cachedMas = null;
  return null;
}

export async function masAvailable(): Promise<boolean> {
  return (await masPath()) !== null;
}

/** `mas outdated` → one MasUpdate per line `<id> <name> (<cur> -> <latest>)`. */
export async function outdatedMasApps(): Promise<MasUpdate[]> {
  const mas = await masPath();
  if (!mas) return [];
  let stdout = '';
  try {
    ({ stdout } = await execFileP(mas, ['outdated'], 60000));
  } catch (err) {
    stdout = (err as ExecResult).stdout || '';
  }
  const out: MasUpdate[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s+\((.+?)\s*->\s*(.+?)\)\s*$/);
    if (!m) continue;
    const name = m[2].trim();
    out.push({
      id: m[1],
      name,
      installedVersion: m[3].trim(),
      latestVersion: m[4].trim(),
      icon: await caskIcon(name), // matches the installed .app by name
    });
  }
  return out;
}

export async function upgradeMas(id: string): Promise<BrewUpgradeResult> {
  const mas = await masPath();
  if (!mas) return { ok: false, token: id, message: 'mas is not installed' };
  if (!/^\d+$/.test(id)) return { ok: false, token: id, message: 'Invalid App Store id' };
  try {
    const { stdout } = await execFileP(mas, ['upgrade', id], 10 * 60 * 1000);
    return { ok: true, token: id, message: lastLine(stdout) || 'Updated' };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & ExecResult;
    return { ok: false, token: id, message: lastLine(e.stderr || '') || (e.message || 'upgrade failed').trim() };
  }
}

/** Launch a .app so it runs its own updater (Sparkle/built-in). Caller validates the path. */
export async function openApp(appPath: string): Promise<void> {
  await execFileP('/usr/bin/open', [appPath], 10000);
}

/* ---------- Sparkle update detection (read each app's appcast feed) ----------
 * Most non-App-Store macOS apps use Sparkle: their Info.plist has an `SUFeedURL`
 * pointing to an appcast (RSS/XML) that lists the latest version + download. We
 * read that feed and compare its newest `sparkle:version` (= CFBundleVersion) to
 * the installed build to detect a real available update — exactly how MacUpdater /
 * Latest detect updates. Applying is left to the app's own updater (launch it).
 * NOTE: this makes outbound HTTPS requests to each vendor's own appcast server.   */

interface PlistInfo { feedURL: string | null; build: string | null; shortVersion: string | null; }

async function readPlistInfo(appPath: string): Promise<PlistInfo> {
  try {
    const { stdout } = await execFileP(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')],
      5000
    );
    const j = JSON.parse(stdout) as Record<string, unknown>;
    const feed = typeof j.SUFeedURL === 'string' ? j.SUFeedURL : null;
    return {
      feedURL: feed && /^https?:\/\//i.test(feed) ? feed : null,
      build: j.CFBundleVersion != null ? String(j.CFBundleVersion) : null,
      shortVersion: j.CFBundleShortVersionString != null ? String(j.CFBundleShortVersionString) : null,
    };
  } catch {
    return { feedURL: null, build: null, shortVersion: null };
  }
}

/** Compare dotted/numeric version strings (Sparkle-style, numeric segments). */
function cmpVersion(a: string, b: string): number {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** Newest item in a Sparkle appcast (by sparkle:version, attr or element). */
function parseAppcastLatest(xml: string): { build: string; short: string | null } | null {
  const grab = (s: string, attr: RegExp, el: RegExp): string | null => {
    const m = s.match(attr) || s.match(el);
    return m ? m[1].trim() : null;
  };
  const items = xml.split(/<item[\s>]/i).slice(1);
  let best: { build: string; short: string | null } | null = null;
  for (const it of items) {
    const build = grab(it, /sparkle:version="([^"]+)"/i, /<sparkle:version>([^<]+)<\/sparkle:version>/i);
    if (!build) continue;
    const short = grab(
      it,
      /sparkle:shortVersionString="([^"]+)"/i,
      /<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/i
    );
    if (!best || cmpVersion(build, best.build) > 0) best = { build, short };
  }
  return best;
}

async function fetchAppcast(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'TreeMap-Updater', Accept: 'application/rss+xml, application/xml, text/xml' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// Short-lived cache so re-opening the Updater doesn't re-poll every feed.
let sparkleCache: { at: number; data: SparkleUpdate[] } | null = null;
const SPARKLE_TTL = 5 * 60 * 1000;

export async function sparkleUpdates(): Promise<SparkleUpdate[]> {
  if (process.platform !== 'darwin') return [];
  if (sparkleCache && Date.now() - sparkleCache.at < SPARKLE_TTL) return sparkleCache.data;

  const apps = (await otherApps([])).filter((a) => a.source === 'self');
  const out: SparkleUpdate[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < apps.length; i += CONCURRENCY) {
    const batch = apps.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (a): Promise<SparkleUpdate | null> => {
        const info = await readPlistInfo(a.path);
        if (!info.feedURL || !info.build) return null;
        const xml = await fetchAppcast(info.feedURL);
        if (!xml) return null;
        const latest = parseAppcastLatest(xml);
        if (!latest || cmpVersion(latest.build, info.build) <= 0) return null; // up to date
        return {
          name: a.name,
          path: a.path,
          icon: a.icon,
          currentVersion: info.shortVersion || info.build,
          latestVersion: latest.short || latest.build,
        };
      })
    );
    for (const r of results) if (r) out.push(r);
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  sparkleCache = { at: Date.now(), data: out };
  return out;
}

/* ---------- Homebrew cask catalog (real updates for most apps) ----------
 * Homebrew's cask database (~7.7k apps) is a curated app → latest-version map.
 * We fetch it (cached 24h), match installed apps by name, and update via
 * `brew install --cask --adopt --force <token>` — which adopts a manually-
 * installed app into Homebrew and installs the latest build. Real one-click
 * updates for most mainstream apps, no per-vendor logic.                       */

interface CaskInfo { token: string; version: string; }
let caskCatalogCache: { at: number; map: Map<string, CaskInfo> } | null = null;
const CASK_CATALOG_TTL = 24 * 60 * 60 * 1000;

async function caskCatalog(): Promise<Map<string, CaskInfo>> {
  if (caskCatalogCache && Date.now() - caskCatalogCache.at < CASK_CATALOG_TTL) return caskCatalogCache.map;
  const map = new Map<string, CaskInfo>();
  try {
    const res = await fetch('https://formulae.brew.sh/api/cask.json', {
      signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': 'TreeMap-Updater' },
    });
    if (res.ok) {
      const casks = (await res.json()) as Array<{
        token?: string;
        version?: string;
        name?: string[];
        artifacts?: Array<Record<string, unknown>>;
      }>;
      for (const c of casks) {
        if (!c.token || !c.version || c.version === 'latest') continue;
        const info: CaskInfo = { token: c.token, version: String(c.version).split(',')[0].trim() };
        for (const art of c.artifacts || []) {
          const appList = (art as { app?: unknown }).app;
          if (!Array.isArray(appList)) continue;
          for (const an of appList) {
            const nm = typeof an === 'string' ? an : Array.isArray(an) && typeof an[0] === 'string' ? an[0] : null;
            if (nm && nm.toLowerCase().endsWith('.app')) map.set(normalizeToken(nm.replace(/\.app$/i, '')), info);
          }
        }
        for (const nm of c.name || []) {
          if (typeof nm === 'string') {
            const k = normalizeToken(nm);
            if (!map.has(k)) map.set(k, info);
          }
        }
      }
    }
  } catch {
    /* offline / blocked — no cask matches this run */
  }
  caskCatalogCache = { at: Date.now(), map };
  return map;
}

/** `brew install --cask --force <token>` — install the latest over the existing
 *  app (works whether or not brew installed it; `--force` overwrites). `--adopt`
 *  can't be combined with `--force`, and we want the newest version anyway. */
export async function upgradeCaskAdopt(token: string): Promise<BrewUpgradeResult> {
  const brew = await brewPath();
  if (!brew) return { ok: false, token, message: 'Homebrew is not installed' };
  try {
    const { stdout } = await execFileP(brew, ['install', '--cask', '--force', token], 10 * 60 * 1000);
    return { ok: true, token, message: lastLine(stdout) || 'Updated' };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & ExecResult;
    return { ok: false, token, message: lastLine(e.stderr || '') || (e.message || 'upgrade failed').trim() };
  }
}

/** Every installed app, each tagged with an update if one is detectable. */
export async function appUpdates(): Promise<AppUpdate[]> {
  if (process.platform !== 'darwin') return [];
  const [apps, catalog, hasMas] = await Promise.all([listInstalledApps(), caskCatalog(), masAvailable()]);
  const masMap = new Map<string, MasUpdate>();
  if (hasMas) for (const m of await outdatedMasApps()) masMap.set(normalizeToken(m.name), m);

  const out: AppUpdate[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < apps.length; i += CONCURRENCY) {
    const batch = apps.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (a): Promise<AppUpdate> => {
        let update: AppUpdateInfo | null = null;

        const cask = catalog.get(normalizeToken(a.name));
        if (cask && a.version && cmpVersion(cask.version, a.version) > 0) {
          update = { kind: 'cask', token: cask.token, latestVersion: cask.version };
        }
        if (!update && hasMas) {
          const m = masMap.get(normalizeToken(a.name));
          if (m) update = { kind: 'mas', id: m.id, latestVersion: m.latestVersion || '' };
        }
        if (!update && a.updateSource === 'self') {
          const info = await readPlistInfo(a.path);
          if (info.feedURL && info.build) {
            const xml = await fetchAppcast(info.feedURL);
            const latest = xml ? parseAppcastLatest(xml) : null;
            if (latest && cmpVersion(latest.build, info.build) > 0) {
              update = { kind: 'sparkle', latestVersion: latest.short || latest.build };
            }
          }
        }
        return { name: a.name, path: a.path, icon: a.icon, source: a.updateSource, currentVersion: a.version, update };
      })
    );
    out.push(...results);
  }
  out.sort((x, y) => Number(!!y.update) - Number(!!x.update) || x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
  return out;
}

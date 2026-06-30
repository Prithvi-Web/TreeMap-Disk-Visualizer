import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { readJsonFile, writeJsonFile } from './storage';

/**
 * maintenance — small, safe, no-sudo macOS upkeep actions for the "Maintenance"
 * tool. Nothing here is destructive or needs elevated privileges; commands that
 * *would* need root are reported as "skipped", never faked as success.
 *
 * Commands run through execFile (argv arrays, no shell), mirroring cleaner.ts.
 */

function run(cmd: string, args: string[], timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || 'command failed').trim()));
      else resolve(stdout);
    });
  });
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
function appleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface MaintenanceResult {
  id: string;
  ok: boolean;
  message: string;
}

export async function flushDns(): Promise<MaintenanceResult> {
  if (process.platform !== 'darwin') return { id: 'flush-dns', ok: false, message: 'macOS only' };
  try {
    // The unprivileged half — clears the directory-service resolver cache.
    await run('dscacheutil', ['-flushcache']);
    // Reloading mDNSResponder needs root; attempt it but never fail on it.
    try {
      await run('killall', ['-HUP', 'mDNSResponder']);
      return { id: 'flush-dns', ok: true, message: 'DNS cache flushed.' };
    } catch {
      return { id: 'flush-dns', ok: true, message: 'DNS cache flushed (mDNSResponder reload needs privileges — skipped).' };
    }
  } catch (e) {
    return { id: 'flush-dns', ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export async function rebuildLaunchServices(): Promise<MaintenanceResult> {
  if (process.platform !== 'darwin') return { id: 'rebuild-launchservices', ok: false, message: 'macOS only' };
  try {
    // user + local domains → no sudo. Fixes duplicate / wrong "Open With" entries.
    // (`-kill` was removed on recent macOS — `-r` alone re-registers.)
    await run(LSREGISTER, ['-r', '-domain', 'local', '-domain', 'user'], 60000);
    return { id: 'rebuild-launchservices', ok: true, message: 'Launch Services rebuilt — "Open With" menus refreshed.' };
  } catch (e) {
    return { id: 'rebuild-launchservices', ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function runMaintenance(id: string): Promise<MaintenanceResult> {
  switch (id) {
    case 'flush-dns':
      return flushDns();
    case 'rebuild-launchservices':
      return rebuildLaunchServices();
    default:
      return { id, ok: false, message: 'Unknown action' };
  }
}

/* ---------- Login items (user "Open at Login" apps) ---------- */

export interface LoginItem {
  name: string;
  path: string;
  /** true = launches hidden. */
  hidden: boolean;
  /** Present in the login-items list = will open at login. */
  enabled: boolean;
}

/** Render a macOS .app bundle's icon as a small PNG buffer (for the UI). */
export async function getAppIconPng(appPath: string): Promise<Buffer> {
  if (process.platform !== 'darwin') throw new Error('macOS only');
  if (!appPath.endsWith('.app')) throw new Error('Not an app bundle');

  const resDir = path.join(appPath, 'Contents', 'Resources');
  let icns = '';
  // Prefer the icon named in Info.plist, else the first .icns in Resources.
  try {
    const named = (await run('defaults', ['read', path.join(appPath, 'Contents', 'Info'), 'CFBundleIconFile'])).trim();
    if (named) {
      const candidate = path.join(resDir, named.endsWith('.icns') ? named : `${named}.icns`);
      if (await pathExists(candidate)) icns = candidate;
    }
  } catch {
    /* no explicit icon name */
  }
  if (!icns) {
    const entries = await fsp.readdir(resDir).catch(() => [] as string[]);
    const found = entries.find((e) => e.toLowerCase().endsWith('.icns'));
    if (!found) throw new Error('No icon');
    icns = path.join(resDir, found);
  }

  const out = path.join(os.tmpdir(), `tm-icon-${crypto.randomUUID()}.png`);
  try {
    await run('sips', ['-s', 'format', 'png', '-Z', '64', icns, '--out', out]);
    return await fsp.readFile(out);
  } finally {
    fsp.unlink(out).catch(() => {});
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Apple/system items we never show or touch — only user apps are managed. */
function isUserLoginItem(name: string, path: string): boolean {
  if (path.startsWith('/System/')) return false;
  if (/^com\.apple\./i.test(name)) return false;
  return true;
}

/**
 * List the user's "Open at Login" items via System Events. These are user apps
 * (Dropbox, Rectangle, …), not Apple system daemons. Requires Automation
 * permission for System Events the first time (macOS will prompt / -1743 if denied).
 */
/**
 * macOS "Open at Login" items have no native disabled state — an item is either
 * in the list or not. To keep a turned-off app *visible as disabled* (instead of
 * vanishing), we remember the ones the user disabled in a small JSON file and
 * merge them back into the list as `enabled:false`.
 */
const MAINT_FILE = 'maintenance.json';
interface MaintStore {
  disabledLoginItems: { name: string; path: string }[];
}
async function getDisabled(): Promise<{ name: string; path: string }[]> {
  const s = await readJsonFile<MaintStore>(MAINT_FILE, { disabledLoginItems: [] });
  return Array.isArray(s.disabledLoginItems) ? s.disabledLoginItems : [];
}
async function setDisabled(list: { name: string; path: string }[]): Promise<void> {
  await writeJsonFile(MAINT_FILE, { disabledLoginItems: list });
}

/**
 * List the user's "Open at Login" items via System Events (these are user apps,
 * not Apple daemons), merged with the apps the user disabled (shown as off).
 * Requires Automation permission for System Events (macOS prompts / -1743 if denied).
 */
export async function listLoginItems(): Promise<LoginItem[]> {
  if (process.platform !== 'darwin') return [];
  const out = await run('osascript', [
    '-e', 'tell application "System Events"',
    '-e', 'set acc to ""',
    '-e', 'repeat with li in login items',
    '-e', 'set acc to acc & (name of li) & tab & (path of li) & tab & (hidden of li) & linefeed',
    '-e', 'end repeat',
    '-e', 'return acc',
    '-e', 'end tell',
  ]);
  const items: LoginItem[] = [];
  const activePaths = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [name, path, hidden] = line.split('\t');
    if (!name || !path) continue;
    if (!isUserLoginItem(name, path)) continue;
    items.push({ name, path, hidden: hidden === 'true', enabled: true });
    activePaths.add(path);
  }
  // Merge back remembered-disabled apps that aren't currently active.
  const disabled = await getDisabled();
  for (const d of disabled) {
    if (activePaths.has(d.path) || !isUserLoginItem(d.name, d.path)) continue;
    items.push({ name: d.name, path: d.path, hidden: false, enabled: false });
  }
  // Prune any remembered-disabled that are active again (re-enabled elsewhere).
  const stillDisabled = disabled.filter((d) => !activePaths.has(d.path));
  if (stillDisabled.length !== disabled.length) await setDisabled(stillDisabled);

  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return items;
}

/**
 * Enable or disable a login item. Disabling removes it from System Events but
 * *remembers* it so it stays listed as off; enabling re-adds it by path and
 * forgets it. macOS only; refuses Apple/system paths.
 */
export async function setLoginItemEnabled(name: string, path: string, enabled: boolean): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Login items are managed on macOS only');
  if (!isUserLoginItem(name, path)) throw new Error('Refusing to modify a system login item');
  const disabled = await getDisabled();

  if (enabled) {
    await run('osascript', [
      '-e',
      `tell application "System Events" to make new login item at end with properties {path:"${appleScriptString(
        path
      )}", hidden:false}`,
    ]);
    await setDisabled(disabled.filter((d) => d.path !== path));
  } else {
    await run('osascript', [
      '-e',
      `tell application "System Events" to delete (every login item whose name is "${appleScriptString(name)}")`,
    ]);
    if (!disabled.some((d) => d.path === path)) {
      disabled.push({ name, path });
      await setDisabled(disabled);
    }
  }
}

import { execFile } from 'child_process';
import { promises as fsp, constants as fsConstants } from 'fs';
import path from 'path';
import { appRoots, appIconDataUri } from './apps';
import { OutdatedCask, BrewUpgradeResult } from '../models/types';

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

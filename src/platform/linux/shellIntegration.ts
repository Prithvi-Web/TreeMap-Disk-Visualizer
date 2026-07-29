import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { commandExists } from '../exec';
import type { ShellIntegrationResult } from '../types';

/**
 * "Scan with TreeMap" file-manager entries on Linux (D2).
 *
 * D2 is explicit that no single mechanism covers the three major file managers,
 * so TreeMap installs for whichever are actually present:
 *
 *   - **Nautilus** (GNOME) — an executable script in
 *     `~/.local/share/nautilus/scripts/`. Nautilus passes the selection in
 *     `$NAUTILUS_SCRIPT_SELECTED_FILE_PATHS`, one path per line.
 *   - **Dolphin** (KDE) — a `.desktop` service menu in
 *     `~/.local/share/kio/servicemenus/`.
 *   - **Thunar** (XFCE) — a custom action in `~/.config/Thunar/uca.xml`.
 *
 * All three are per-user paths, so **none of this needs root** — §3.8's rule
 * that elevation is never required for anything achievable without it.
 *
 * Reversibility is a requirement, not a nicety: D2 says an uninstall must not
 * leave a dead context-menu entry behind. Every file written here is written
 * only by TreeMap and removed whole by `unregister()`. Thunar is the exception
 * — its actions share one XML file with the user's own — so only TreeMap's own
 * `<action>` block is removed and the rest of the file is left untouched.
 *
 * The launcher reuses the existing drag-and-drop entry point in
 * electron/main.js (a path argument on argv) rather than inventing a second
 * path-injection mechanism.
 */

const SCRIPT_NAME = 'Scan with TreeMap';
const DESKTOP_NAME = 'treemap-scan.desktop';
const THUNAR_ACTION_NAME = 'Scan with TreeMap';

export interface ShellIntegrationPaths {
  home?: string;
  /** Absolute path to the TreeMap executable the menu entry should launch. */
  exec?: string;
}

function homeOf(opts: ShellIntegrationPaths): string {
  return opts.home ?? os.homedir();
}

function execOf(opts: ShellIntegrationPaths): string {
  return opts.exec ?? process.execPath;
}

/** Quote a path for safe embedding in a shell script line. */
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Escape text for an XML attribute or element body. */
export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

export function nautilusScript(exec: string): string {
  // Nautilus hands the selection in on an env var, one path per line. Reading
  // it with `while read` keeps paths containing spaces intact, which naive
  // `for p in $(...)` would split apart.
  return [
    '#!/bin/sh',
    '# Installed by TreeMap. Remove this file to uninstall the menu entry.',
    'set -eu',
    'printf %s "${NAUTILUS_SCRIPT_SELECTED_FILE_PATHS:-}" | while IFS= read -r target; do',
    '  [ -n "$target" ] || continue',
    `  ${shellQuote(exec)} "$target" &`,
    'done',
    '',
  ].join('\n');
}

export function dolphinServiceMenu(exec: string): string {
  return [
    '[Desktop Entry]',
    'Type=Service',
    'ServiceTypes=KonqPopupMenu/Plugin,inode/directory',
    'MimeType=inode/directory;',
    'Actions=treemapScan;',
    'X-KDE-Priority=TopLevel',
    '',
    '[Desktop Action treemapScan]',
    `Name=${SCRIPT_NAME}`,
    'Icon=treemap',
    `Exec=${exec} %f`,
    '',
  ].join('\n');
}

/* ------------------------------ install ------------------------------ */

async function installNautilus(opts: ShellIntegrationPaths): Promise<boolean> {
  if (!(await commandExists('nautilus', ['--version']))) return false;
  const dir = path.join(homeOf(opts), '.local', 'share', 'nautilus', 'scripts');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, SCRIPT_NAME);
  await fsp.writeFile(file, nautilusScript(execOf(opts)), { mode: 0o755 });
  // writeFile does not apply mode to an existing file, so set it explicitly —
  // a non-executable script silently does nothing when clicked.
  await fsp.chmod(file, 0o755);
  return true;
}

async function installDolphin(opts: ShellIntegrationPaths): Promise<boolean> {
  if (!(await commandExists('dolphin', ['--version']))) return false;
  const dir = path.join(homeOf(opts), '.local', 'share', 'kio', 'servicemenus');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, DESKTOP_NAME);
  await fsp.writeFile(file, dolphinServiceMenu(execOf(opts)), { mode: 0o644 });
  return true;
}

/**
 * Add TreeMap's action to Thunar's uca.xml, preserving whatever else is there.
 *
 * Exported as a pure string transform so the merge — the part that could
 * destroy a user's own custom actions — is unit-testable.
 */
export function addThunarAction(existing: string | null, exec: string): string {
  const action = [
    '<action>',
    `\t<icon>treemap</icon>`,
    `\t<name>${xmlEscape(THUNAR_ACTION_NAME)}</name>`,
    '\t<unique-id>treemap-scan-1</unique-id>',
    `\t<command>${xmlEscape(exec)} %f</command>`,
    '\t<description>Open this folder in TreeMap</description>',
    '\t<directories/>',
    '</action>',
  ].join('\n');

  if (existing === null || existing.trim().length === 0) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<actions>\n${action}\n</actions>\n`;
  }
  if (existing.includes('treemap-scan-1')) return existing; // already installed; adding twice would duplicate the menu item
  const close = existing.lastIndexOf('</actions>');
  if (close === -1) return existing; // unrecognised shape — leave the user's file alone rather than corrupt it
  return existing.slice(0, close) + action + '\n' + existing.slice(close);
}

/** Remove only TreeMap's own action, leaving the user's custom ones intact. */
export function removeThunarAction(existing: string | null): string | null {
  if (existing === null) return null;
  const pattern = /\n?<action>(?:(?!<\/action>)[\s\S])*?treemap-scan-1[\s\S]*?<\/action>/;
  return pattern.test(existing) ? existing.replace(pattern, '') : existing;
}

async function installThunar(opts: ShellIntegrationPaths): Promise<boolean> {
  if (!(await commandExists('thunar', ['--version']))) return false;
  const dir = path.join(homeOf(opts), '.config', 'Thunar');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'uca.xml');
  const existing = await fsp.readFile(file, 'utf8').catch(() => null);
  await fsp.writeFile(file, addThunarAction(existing, execOf(opts)), { mode: 0o644 });
  return true;
}

export async function registerShellIntegration(opts: ShellIntegrationPaths = {}): Promise<ShellIntegrationResult> {
  const targets: string[] = [];
  if (await installNautilus(opts).catch(() => false)) targets.push('nautilus');
  if (await installDolphin(opts).catch(() => false)) targets.push('dolphin');
  if (await installThunar(opts).catch(() => false)) targets.push('thunar');

  if (targets.length === 0) {
    return {
      installed: false,
      targets: [],
      reason:
        'None of the supported file managers (Files/Nautilus, Dolphin, Thunar) were found, so there is nowhere to add a "Scan with TreeMap" entry.',
    };
  }
  return { installed: true, targets };
}

export async function unregisterShellIntegration(opts: ShellIntegrationPaths = {}): Promise<ShellIntegrationResult> {
  const home = homeOf(opts);
  const removed: string[] = [];

  const nautilus = path.join(home, '.local', 'share', 'nautilus', 'scripts', SCRIPT_NAME);
  if (await fsp.rm(nautilus, { force: true }).then(() => true, () => false)) removed.push('nautilus');

  const dolphin = path.join(home, '.local', 'share', 'kio', 'servicemenus', DESKTOP_NAME);
  if (await fsp.rm(dolphin, { force: true }).then(() => true, () => false)) removed.push('dolphin');

  const thunar = path.join(home, '.config', 'Thunar', 'uca.xml');
  const existing = await fsp.readFile(thunar, 'utf8').catch(() => null);
  if (existing !== null) {
    const next = removeThunarAction(existing);
    if (next !== null && next !== existing) {
      await fsp.writeFile(thunar, next, { mode: 0o644 });
      removed.push('thunar');
    }
  }

  return { installed: false, targets: removed };
}

/**
 * Is any of the three entries present?
 *
 * Checked against the same three locations `unregisterShellIntegration` clears,
 * so "installed" and "removed" can never disagree. Any one of them counts —
 * a machine with only Thunar is still integrated.
 */
export async function isInstalled(opts: ShellIntegrationPaths = {}): Promise<boolean> {
  const home = homeOf(opts);
  const exists = (p: string): Promise<boolean> => fsp.stat(p).then(() => true, () => false);
  if (await exists(path.join(home, '.local', 'share', 'nautilus', 'scripts', SCRIPT_NAME))) return true;
  if (await exists(path.join(home, '.local', 'share', 'kio', 'servicemenus', DESKTOP_NAME))) return true;
  const thunar = await fsp.readFile(path.join(home, '.config', 'Thunar', 'uca.xml'), 'utf8').catch(() => null);
  return thunar !== null && thunar.includes(SCRIPT_NAME);
}

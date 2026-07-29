import { runText } from '../exec';
import type { ShellIntegrationResult } from '../types';

/**
 * "Scan with TreeMap" in Explorer's context menu (D2).
 *
 * Mechanism choice (§2.3): tier 3, `reg.exe` — with one decision that matters:
 * everything is written under **`HKEY_CURRENT_USER\Software\Classes`**, not
 * `HKEY_CLASSES_ROOT` or `HKLM`. `HKCU\Software\Classes` is the per-user half
 * of the same merged view Explorer reads, so the menu entry appears exactly as
 * it would from a machine-wide install — but **needs no administrator rights**,
 * which §3.8 requires whenever a thing can be done unelevated.
 *
 * Three keys, because Explorer treats them as three separate surfaces and
 * installing only the first is the usual half-done job:
 *
 *   - `Directory\shell`           — right-click a folder
 *   - `Directory\Background\shell` — right-click inside a folder's empty space
 *   - `Drive\shell`                — right-click a drive
 *
 * The background variant needs `%V` rather than `%1`: `%1` is empty there, so
 * copying the folder command verbatim produces a menu item that launches
 * TreeMap with no path at all.
 *
 * Uninstall removes the keys whole, satisfying D2's requirement that removing
 * the integration leaves no dead entry behind.
 *
 * ⚠ **Not executed on Windows by the author** (written on macOS). The command
 * construction is pure and unit-tested; the live round-trip runs in CI on
 * `windows-latest`.
 */

const MENU_LABEL = 'Scan with TreeMap';

/** The three parent keys Explorer reads, and the argument each must pass. */
export const SHELL_KEYS = [
  { key: String.raw`HKCU\Software\Classes\Directory\shell\TreeMapScan`, arg: '%1' },
  { key: String.raw`HKCU\Software\Classes\Directory\Background\shell\TreeMapScan`, arg: '%V' },
  { key: String.raw`HKCU\Software\Classes\Drive\shell\TreeMapScan`, arg: '%1' },
] as const;

export interface RegCommand {
  cmd: string;
  args: string[];
}

/**
 * Every `reg.exe` invocation needed to install the menu.
 *
 * Pure and exported so the exact argv — including how a path containing spaces
 * is quoted for the `command` value — is asserted in tests without touching a
 * registry. That quoting is the classic failure: an unquoted
 * `C:\Program Files\...` launches `C:\Program` with `Files\...` as an argument.
 */
export function installCommands(exePath: string, iconPath?: string): RegCommand[] {
  const out: RegCommand[] = [];
  for (const { key, arg } of SHELL_KEYS) {
    out.push({ cmd: 'reg.exe', args: ['add', key, '/ve', '/t', 'REG_SZ', '/d', MENU_LABEL, '/f'] });
    out.push({
      cmd: 'reg.exe',
      args: ['add', key, '/v', 'Icon', '/t', 'REG_SZ', '/d', iconPath ?? exePath, '/f'],
    });
    out.push({
      cmd: 'reg.exe',
      args: [
        'add',
        `${key}\\command`,
        '/ve',
        '/t',
        'REG_SZ',
        // The exe path is quoted inside the value; the argument placeholder is
        // quoted too, so a folder with spaces arrives as one argv entry.
        '/d',
        `"${exePath}" "${arg}"`,
        '/f',
      ],
    });
  }
  return out;
}

export function uninstallCommands(): RegCommand[] {
  return SHELL_KEYS.map(({ key }) => ({ cmd: 'reg.exe', args: ['delete', key, '/f'] }));
}

export async function registerShellIntegration(exePath = process.execPath): Promise<ShellIntegrationResult> {
  const failures: string[] = [];
  for (const { cmd, args } of installCommands(exePath)) {
    try {
      await runText(cmd, args, { timeoutMs: 10_000 });
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (failures.length > 0) {
    return {
      installed: false,
      targets: [],
      reason: `The "Scan with TreeMap" menu entry could not be added (${failures[0]}).`,
    };
  }
  return { installed: true, targets: ['explorer-folder', 'explorer-background', 'explorer-drive'] };
}

export async function unregisterShellIntegration(): Promise<ShellIntegrationResult> {
  const removed: string[] = [];
  for (const { cmd, args } of uninstallCommands()) {
    try {
      await runText(cmd, args, { timeoutMs: 10_000 });
      removed.push(args[1]);
    } catch {
      // Deleting a key that was never there is success, not failure.
    }
  }
  return { installed: false, targets: removed };
}

/**
 * Is the Explorer entry present?
 *
 * `reg query` on the first key is enough: install writes all three together and
 * uninstall removes all three together, so they cannot diverge except by a
 * hand edit — and reporting "installed" for a half-present entry would be
 * worse than reporting the common case correctly.
 */
export async function isInstalled(): Promise<boolean> {
  try {
    await runText('reg.exe', ['query', SHELL_KEYS[0].key], { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

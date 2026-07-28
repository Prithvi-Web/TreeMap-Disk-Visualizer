import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { runText } from '../exec';
import type { ShellIntegrationResult } from '../types';

/**
 * "Scan with TreeMap" in Finder (D2), as a Quick Action.
 *
 * Mechanism choice (§2.3): a Services/Quick Action bundle written to
 * `~/Library/Services/`. D2 offers a Finder Sync extension as the alternative;
 * that is rejected here for a concrete reason — a Finder Sync extension must be
 * embedded in a **code-signed** host application, and TreeMap currently ships
 * ad-hoc signed (see the release notes about Gatekeeper). An extension that
 * cannot load would be worse than none, because it fails silently.
 *
 * A Quick Action needs no signing, no admin rights, and is removed by deleting
 * one directory — which is how D2's "removing integration cleanly removes the
 * entry" requirement is met.
 *
 * The bundle is two files:
 *   Contents/Info.plist    — declares it as a folder-accepting service
 *   Contents/document.wflow — an Automator "Run Shell Script" action
 *
 * Both are written as XML plists directly. `NSRequiredContext` restricts the
 * entry to Finder so it does not clutter every application's Services menu, and
 * `NSSendFileTypes = public.folder` is what makes it appear on folders only.
 *
 * The shell script reads paths on stdin (`--args` passes them as arguments to
 * the workflow, which Automator hands to the script one per line), so a folder
 * whose name contains spaces or quotes cannot break the invocation.
 *
 * ⚠ Whether Finder picks the bundle up without a re-login is not something this
 * code can assert; `pbs -flush` is invoked to prompt a Services refresh, which
 * is the documented nudge. The capability reason says so rather than promising
 * an instant appearance.
 */

const SERVICE_NAME = 'Scan with TreeMap';

function servicesDir(home = os.homedir()): string {
  return path.join(home, 'Library', 'Services');
}

export function bundlePath(home = os.homedir()): string {
  return path.join(servicesDir(home), `${SERVICE_NAME}.workflow`);
}

/** Escape text for an XML plist string element. */
export function plistEscape(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

export function infoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>NSServices</key>
\t<array>
\t\t<dict>
\t\t\t<key>NSMenuItem</key>
\t\t\t<dict>
\t\t\t\t<key>default</key>
\t\t\t\t<string>${plistEscape(SERVICE_NAME)}</string>
\t\t\t</dict>
\t\t\t<key>NSMessage</key>
\t\t\t<string>runWorkflowAsService</string>
\t\t\t<key>NSSendFileTypes</key>
\t\t\t<array>
\t\t\t\t<string>public.folder</string>
\t\t\t</array>
\t\t\t<key>NSRequiredContext</key>
\t\t\t<dict>
\t\t\t\t<key>NSApplicationIdentifier</key>
\t\t\t\t<string>com.apple.finder</string>
\t\t\t</dict>
\t\t</dict>
\t</array>
</dict>
</plist>
`;
}

/**
 * The Automator workflow document.
 *
 * The shell script quotes `"$@"` so every selected folder is passed as one
 * argument regardless of spaces, and backgrounds each launch so Finder's
 * Services menu is not held open waiting for the app.
 */
export function documentWflow(execPath: string): string {
  const script = `#!/bin/sh\nfor target in "$@"; do\n  "${execPath}" "$target" &\ndone\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>AMApplicationBuild</key>
\t<string>521</string>
\t<key>AMApplicationVersion</key>
\t<string>2.10</string>
\t<key>AMDocumentVersion</key>
\t<string>2</string>
\t<key>actions</key>
\t<array>
\t\t<dict>
\t\t\t<key>action</key>
\t\t\t<dict>
\t\t\t\t<key>AMAccepts</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>Container</key>
\t\t\t\t\t<string>List</string>
\t\t\t\t\t<key>Optional</key>
\t\t\t\t\t<true/>
\t\t\t\t\t<key>Types</key>
\t\t\t\t\t<array>
\t\t\t\t\t\t<string>com.apple.cocoa.string</string>
\t\t\t\t\t</array>
\t\t\t\t</dict>
\t\t\t\t<key>ActionBundlePath</key>
\t\t\t\t<string>/System/Library/Automator/Run Shell Script.action</string>
\t\t\t\t<key>ActionName</key>
\t\t\t\t<string>Run Shell Script</string>
\t\t\t\t<key>AMActionVersion</key>
\t\t\t\t<string>2.0.3</string>
\t\t\t\t<key>ActionParameters</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>COMMAND_STRING</key>
\t\t\t\t\t<string>${plistEscape(script)}</string>
\t\t\t\t\t<key>CheckedForUserDefaultShell</key>
\t\t\t\t\t<true/>
\t\t\t\t\t<key>inputMethod</key>
\t\t\t\t\t<integer>1</integer>
\t\t\t\t\t<key>shell</key>
\t\t\t\t\t<string>/bin/sh</string>
\t\t\t\t\t<key>source</key>
\t\t\t\t\t<string></string>
\t\t\t\t</dict>
\t\t\t\t<key>BundleIdentifier</key>
\t\t\t\t<string>com.apple.RunShellScript</string>
\t\t\t\t<key>Class Name</key>
\t\t\t\t<string>RunShellScriptAction</string>
\t\t\t</dict>
\t\t</dict>
\t</array>
\t<key>workflowMetaData</key>
\t<dict>
\t\t<key>serviceApplicationBundleID</key>
\t\t<string>com.apple.finder</string>
\t\t<key>serviceInputTypeIdentifier</key>
\t\t<string>com.apple.Automator.fileSystemObject.folder</string>
\t\t<key>workflowTypeIdentifier</key>
\t\t<string>com.apple.Automator.servicesMenu</string>
\t</dict>
</dict>
</plist>
`;
}

export async function registerShellIntegration(
  execPath = process.execPath,
  home = os.homedir(),
): Promise<ShellIntegrationResult> {
  const contents = path.join(bundlePath(home), 'Contents');
  try {
    await fsp.mkdir(contents, { recursive: true });
    await fsp.writeFile(path.join(contents, 'Info.plist'), infoPlist(), 'utf8');
    await fsp.writeFile(path.join(contents, 'document.wflow'), documentWflow(execPath), 'utf8');
  } catch (err) {
    return {
      installed: false,
      targets: [],
      reason: `The Finder Quick Action could not be created (${err instanceof Error ? err.message : String(err)}).`,
    };
  }

  // Documented nudge to rebuild the Services cache. Failure is not fatal — the
  // entry still appears after the next login.
  await runText('/System/Library/CoreServices/pbs', ['-flush'], { timeoutMs: 10_000 }).catch(() => {});

  return { installed: true, targets: ['finder-quick-action'] };
}

export async function unregisterShellIntegration(home = os.homedir()): Promise<ShellIntegrationResult> {
  const bundle = bundlePath(home);
  const existed = await fsp.stat(bundle).then(() => true, () => false);
  if (existed) await fsp.rm(bundle, { recursive: true, force: true });
  await runText('/System/Library/CoreServices/pbs', ['-flush'], { timeoutMs: 10_000 }).catch(() => {});
  return { installed: false, targets: existed ? ['finder-quick-action'] : [] };
}

/** Is the Quick Action currently installed? */
export async function isInstalled(home = os.homedir()): Promise<boolean> {
  return fsp.stat(path.join(bundlePath(home), 'Contents', 'document.wflow')).then(() => true, () => false);
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { platform } from '../src/platform';
import { capabilityState, invalidateCapabilities } from '../src/platform/capabilities';

/**
 * §D2 — native shell integration.
 *
 * Acceptance: "The entry appears and correctly scopes the scan, verified on
 * Windows Explorer, macOS Finder, and at least two of the three named Linux
 * file managers. **Removing integration cleanly removes the entry.**"
 *
 * The removal half is the one that can be proven anywhere, and it is the half
 * that goes wrong — a dead right-click entry pointing at a deleted app is
 * exactly what §D2 says must not happen. So the round trip runs for real here,
 * against a throwaway HOME so the developer's own Finder is never touched.
 *
 * "The entry appears in Finder/Explorer/Nautilus" needs a human with a mouse on
 * each OS and is not claimed by any test in this file.
 */

const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

/* ─────────────── The round trip, on a throwaway HOME ─────────────── */

test('installing then removing leaves nothing behind (macOS)', { skip: !IS_MAC }, async () => {
  const { registerShellIntegration, unregisterShellIntegration, isInstalled, bundlePath } =
    await import('../src/platform/macos/shellIntegration');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-shell-'));
  try {
    assert.equal(await isInstalled(home), false, 'nothing there to begin with');

    const installed = await registerShellIntegration('/Applications/TreeMap.app/Contents/MacOS/TreeMap', home);
    assert.equal(installed.installed, true, installed.reason);
    assert.deepEqual(installed.targets, ['finder-quick-action']);
    assert.equal(await isInstalled(home), true);

    // The bundle is the two files Finder needs, and nothing else.
    const contents = path.join(bundlePath(home), 'Contents');
    assert.deepEqual(fs.readdirSync(contents).sort(), ['Info.plist', 'document.wflow']);

    const removed = await unregisterShellIntegration(home);
    assert.equal(removed.installed, false);
    assert.deepEqual(removed.targets, ['finder-quick-action'], 'it reports what it actually removed');
    assert.equal(await isInstalled(home), false);
    assert.equal(fs.existsSync(bundlePath(home)), false, 'the whole bundle is gone, not just its contents');

    // Removing again is not an error, and does not claim to have removed anything.
    const again = await unregisterShellIntegration(home);
    assert.deepEqual(again.targets, [], 'a second removal removes nothing and says so');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the Quick Action passes the folder as one argument, however it is named', { skip: !IS_MAC }, async () => {
  const { documentWflow } = await import('../src/platform/macos/shellIntegration');
  const wflow = documentWflow('/Applications/My Apps/TreeMap.app/Contents/MacOS/TreeMap');
  // The classic failure: an unquoted path launches "/Applications/My" with
  // "Apps/TreeMap.app/..." as an argument. Both sides must be quoted.
  assert.match(wflow, /"\/Applications\/My Apps\/TreeMap\.app\/Contents\/MacOS\/TreeMap" "\$target"/);
  assert.match(wflow, /for target in "\$@"/, 'and every selected folder is iterated safely');
});

test('the Quick Action is restricted to Finder, and to folders', { skip: !IS_MAC }, async () => {
  const { infoPlist } = await import('../src/platform/macos/shellIntegration');
  const plist = infoPlist();
  assert.match(plist, /public\.folder/, 'folders only — not every file in every app');
  assert.match(plist, /com\.apple\.finder/, 'and only in Finder’s menu');
});

test('installing then removing leaves nothing behind (Linux)', { skip: !IS_LINUX }, async () => {
  const { registerShellIntegration, unregisterShellIntegration, isInstalled } =
    await import('../src/platform/linux/shellIntegration');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-shell-'));
  try {
    assert.equal(await isInstalled({ home }), false);
    const installed = await registerShellIntegration({ home });
    // A CI container may have no file manager at all — that is a legitimate
    // "nowhere to install", and it must say so rather than claim success.
    if (!installed.installed) {
      assert.match(installed.reason!, /file managers/);
      return;
    }
    assert.ok(installed.targets.length > 0);
    assert.equal(await isInstalled({ home }), true);
    await unregisterShellIntegration({ home });
    assert.equal(await isInstalled({ home }), false, 'removal must be complete');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/* ─────────────── The argv contract the whole feature rests on ─────────────── */

test('the Windows menu quotes the executable and passes the folder', { skip: process.platform !== 'win32' && false }, async () => {
  const { installCommands, uninstallCommands, SHELL_KEYS } = await import('../src/platform/windows/shellIntegration');
  const cmds = installCommands(String.raw`C:\Program Files\TreeMap\TreeMap.exe`);
  // Only the `…\command` keys hold a command LINE. The sibling `Icon` value is
  // a bare path and must NOT be quoted, so it is deliberately excluded here.
  const commandValues = cmds
    .filter((c) => c.args[1].endsWith(String.raw`\command`))
    .map((c) => c.args[c.args.length - 2]);
  assert.equal(commandValues.length, SHELL_KEYS.length, 'one command line per shell key');
  for (const value of commandValues) {
    // Unquoted, Explorer launches C:\Program with Files\TreeMap\... as an arg.
    assert.match(value, /^"C:\\Program Files\\TreeMap\\TreeMap\.exe"/, `unquoted exe path: ${value}`);
    assert.match(value, /"%1"|"%V"/, `the folder must be passed, quoted: ${value}`);
  }
  const iconValues = cmds
    .filter((c) => c.args.includes('Icon'))
    .map((c) => c.args[c.args.length - 2]);
  for (const value of iconValues) {
    assert.doesNotMatch(value, /^"/, 'a registry Icon value is a bare path, not a command line');
  }

  // Every key installed is a key uninstalled — no orphan can survive.
  const removedKeys = uninstallCommands().map((c) => c.args[1]);
  for (const { key } of SHELL_KEYS) {
    assert.ok(removedKeys.includes(key), `${key} is installed but never removed`);
  }
});

test('the entry launches the app through its ordinary path argument', async () => {
  // §D2: reuse the existing drag-and-drop entry point rather than adding a
  // second path-injection mechanism. Every platform's integration therefore
  // launches `<exe> <folder>`, which electron/main.js already routes through
  // requestScan — the same function a dock drop uses.
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.match(main, /function scanPathsFromArgv/, 'argv paths are collected');
  assert.match(main, /app\.on\('second-instance'[\s\S]{0,200}scanPathsFromArgv/, 'a second launch forwards its args');
  assert.match(main, /scanPathsFromArgv\(process\.argv\)/, 'and a cold start reads its own');
  assert.match(main, /requestScan\(/, 'both go through the one entry point');
  // Unpackaged, argv[1] is the app directory and would scan the repo.
  assert.match(main, /app\.isPackaged \? 1 : 2/, 'the dev-mode argument offset is handled');
});

/* ─────────────── Capability honesty ─────────────── */

test('the capability names its mechanism, and explains itself when not yet installed', async () => {
  invalidateCapabilities();
  const state = await capabilityState('shellIntegration');
  assert.ok(state.mechanism.length > 0, 'the mechanism is always named');
  if (!state.available) {
    assert.ok(state.reason && state.reason.length > 20, 'and an unavailable one explains why');
  }
});

test('the installed flag is read from the system, never remembered', async () => {
  // A remembered flag goes stale the moment someone deletes the entry by hand,
  // and D2's removal guarantee becomes unverifiable.
  const value = await platform().shellIntegrationInstalled();
  assert.equal(typeof value, 'boolean');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'platformRoutes.ts'), 'utf8');
  assert.match(src, /installed: await provider\.shellIntegrationInstalled\(\)/,
    'the POST response re-reads the real state instead of echoing the intent');
});

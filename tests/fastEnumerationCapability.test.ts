/**
 * The "Fast scanning" capability must say what this build can actually do.
 *
 * Until Phase 3 every platform's probe said the bulk-listing call "needs
 * native code TreeMap does not ship". The native scan core ships now, so the
 * sentence is decided by the loader's real outcome: the platform's bulk call
 * when the core is loaded, the ordinary `readdir + lstat` path with the
 * loader's own reason when it is not. A claim the app prints is held to the
 * same bar as a number: it comes from a measurement (here, the load), never
 * from the build's opinion of itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fastEnumerationState } from '../src/platform/fastEnumeration';
import { resetNativeForTests, setNativeLoadOverrideForTests, SCAN_FUNCTIONS } from '../src/services/scan/native';
import type { ScanModuleOutcome } from '../src/services/scan/native';
import { MacOsProvider } from '../src/platform/macos/index';
import { LinuxProvider } from '../src/platform/linux/index';
import { WindowsProvider } from '../src/platform/windows/index';

const NO_NATIVE = path.join(os.tmpdir(), 'treemap-no-native-for-capabilities.node');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { nativeVersion: string };

const WORDS = {
  call: 'getattrlistbulk',
  legacy: 'readdir + lstat, device-aware concurrency',
  legacyShort: 'readdir + lstat',
};

function fakeScanModule(): Record<string, unknown> {
  const module: Record<string, unknown> = { version: () => pkg.nativeVersion };
  for (const name of SCAN_FUNCTIONS) module[name] = () => { throw new Error(`${name} is not exercised by this test`); };
  return module;
}

/** The loader pinned to a fake scan core that passes its handshake. */
function useFakeNative(): void {
  resetNativeForTests();
  setNativeLoadOverrideForTests({ path: '/fake/treemap_core.node', requireModule: () => fakeScanModule() });
}

/** The loader pinned to a path that is not there, so a Mac with the prebuilt answers like a machine without. */
function useNoNative(): void {
  resetNativeForTests();
  setNativeLoadOverrideForTests({ path: NO_NATIVE });
}

function restore(): void {
  setNativeLoadOverrideForTests(null);
  resetNativeForTests();
}

/* ─────────────────────────── the sentence ─────────────────────────── */

test('with the scan core loaded, Fast scanning names the platform’s bulk call and the native scan core, and is not degraded', () => {
  const loaded: ScanModuleOutcome = { available: true, module: fakeScanModule() as never, path: '/fake/treemap_core.node' };

  const state = fastEnumerationState(loaded, WORDS);

  assert.equal(state.available, true);
  assert.equal(state.mechanism, 'getattrlistbulk (native scan core)');
  assert.equal(state.degradedTo, undefined, 'the first-choice mechanism is in use, so nothing is degraded');
  assert.match(state.reason ?? '', /native scan core/);
  assert.match(state.reason ?? '', /Automatic or Native/, 'it says which Scan engine settings let the core run');
  assert.match(state.reason ?? '', /Dashboard/, 'it points at where the engine that ran is named');
  assert.doesNotMatch(state.reason ?? '', /does not ship/, 'the pre-Phase-3 sentence is gone');
});

test('without the scan core, Fast scanning is the ordinary path, degraded, and carries the loader’s own reason verbatim', () => {
  const reason = `no native module at ${NO_NATIVE} for ${process.platform}-${process.arch}; the legacy engines run instead`;
  const missing: ScanModuleOutcome = { available: false, reason };

  const state = fastEnumerationState(missing, WORDS);

  assert.equal(state.available, true, 'scanning still works, on the ordinary path');
  assert.equal(state.mechanism, WORDS.legacy);
  assert.equal(state.degradedTo, WORDS.legacyShort);
  assert.ok(state.reason?.includes(reason), `the loader’s sentence is carried verbatim, got: ${state.reason}`);
  assert.match(state.reason ?? '', /getattrlistbulk/, 'it still names the call this platform would use');
  assert.match(state.reason ?? '', /ordinary way/);
  assert.doesNotMatch(state.reason ?? '', /does not ship/, 'a load that failed is not "does not ship"');
});

test('a platform note is appended to the sentence in both states', () => {
  const words = { ...WORDS, note: 'Reading the drive’s own file table directly is not part of this build.' };

  const loaded = fastEnumerationState({ available: true, module: fakeScanModule() as never, path: '/x' }, words);
  const missing = fastEnumerationState({ available: false, reason: 'nope' }, words);

  assert.ok(loaded.reason?.endsWith(words.note), `loaded: ${loaded.reason}`);
  assert.ok(missing.reason?.endsWith(words.note), `missing: ${missing.reason}`);
});

/* ─────────────────────────── the wiring ─────────────────────────── */

const PROVIDERS: Array<{ name: string; make: () => { probeFastEnumeration(): Promise<{ mechanism: string; reason?: string; degradedTo?: string }> }; call: string }> = [
  { name: 'macOS', make: () => new MacOsProvider(), call: 'getattrlistbulk' },
  { name: 'Linux', make: () => new LinuxProvider(), call: 'getdents64' },
  { name: 'Windows', make: () => new WindowsProvider(), call: 'FileIdExtdDirectoryInfo' },
];

for (const { name, make, call } of PROVIDERS) {
  test(`${name}: the probe reads the loader — the bulk call with the core loaded, the loader’s reason without it`, async () => {
    try {
      useFakeNative();
      const withCore = await make().probeFastEnumeration();
      assert.equal(withCore.mechanism, `${call} (native scan core)`, `${name} with the core: ${withCore.mechanism}`);
      assert.equal(withCore.degradedTo, undefined);

      useNoNative();
      const withoutCore = await make().probeFastEnumeration();
      assert.ok(withoutCore.reason?.includes(NO_NATIVE), `${name} without the core names the path the loader tried: ${withoutCore.reason}`);
      assert.match(withoutCore.reason ?? '', new RegExp(call), `${name} without the core still names ${call}`);
      assert.ok(withoutCore.degradedTo, `${name} without the core is degraded`);
      assert.doesNotMatch(withoutCore.mechanism, /native scan core/);
    } finally {
      restore();
    }
  });
}

test('Windows keeps the honest note that the file-table trick is not part of this build, in both states', async () => {
  try {
    useFakeNative();
    const withCore = await new WindowsProvider().probeFastEnumeration();
    useNoNative();
    const withoutCore = await new WindowsProvider().probeFastEnumeration();
    for (const state of [withCore, withoutCore]) {
      assert.match(state.reason ?? '', /file table/, state.reason);
      assert.match(state.reason ?? '', /USB sticks and network drives/, state.reason);
    }
  } finally {
    restore();
  }
});

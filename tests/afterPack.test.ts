import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { CPU_TYPE_ARM64, CPU_TYPE_X86_64, EM_X86_64, IMAGE_FILE_MACHINE_AMD64, elf64, machO64, pe } from './fixtures/binaryHeaders';
isolatedDataDir('treemap-afterPack-data-');

/**
 * scripts/afterPack.js runs inside electron-builder after it has laid out the
 * app and before anything is signed or zipped — on every route into
 * electron-builder, the dist scripts and a bare `npx electron-builder --mac
 * --dir` alike. Track U U-14: it refuses an app whose
 * app.asar.unpacked/native/prebuilt/<platform>-<arch>/ does not hold the
 * module for the platform and architecture electron-builder is packaging,
 * at package.json's nativeVersion, on every platform — before its macOS-only
 * signing, so a Windows or Linux package is held to it too, and an app that
 * will not ship is never signed. The 5.1.0 build the owner ran shipped
 * without the module and nothing said so.
 */

const REPO = path.join(__dirname, '..');
const NATIVE_VERSION = (JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { nativeVersion: string }).nativeVersion;

interface Context { electronPlatformName: string; arch: number; appOutDir: string; packager: { appInfo: { productFilename: string } } }
type Run = (cmd: string, args: string[], opts?: object) => unknown;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hook = require('../scripts/afterPack.js') as { default(context: Context, deps?: { run: Run }): Promise<void>; nodeArchOf(arch: number): string };
// electron-builder's own Arch enum, the value it hands the hook as context.arch.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Arch } = require('electron-builder') as { Arch: Record<'ia32' | 'x64' | 'armv7l' | 'arm64' | 'universal', number> };

type Platform = 'darwin' | 'win32' | 'linux';

function context(platform: Platform, arch: number): Context {
  return { electronPlatformName: platform, arch, appOutDir: fileTempDir(`treemap-afterpack-${platform}-`), packager: { appInfo: { productFilename: 'TreeMap' } } };
}

/** Where electron-builder puts the app's resources: inside the bundle on macOS, beside the executable elsewhere. */
function resourcesOf(c: Context): string {
  return c.electronPlatformName === 'darwin' ? path.join(c.appOutDir, 'TreeMap.app', 'Contents', 'Resources') : path.join(c.appOutDir, 'resources');
}

function moduleDirOf(c: Context, triple: string): string {
  return path.join(resourcesOf(c), 'app.asar.unpacked', 'native', 'prebuilt', triple);
}

/** Lays out what electron-builder would have: the resources folder, and the module and VERSION when given. */
function pack(c: Context, triple: string, header: Buffer | null, version: string | null = `${NATIVE_VERSION}\n`): void {
  fs.mkdirSync(resourcesOf(c), { recursive: true });
  if (!header) return;
  const dir = moduleDirOf(c, triple);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'treemap_core.node'), header);
  if (version !== null) fs.writeFileSync(path.join(dir, 'VERSION'), version);
}

/** Runs the hook with codesign stood in for, and answers every command it ran. */
async function runHook(c: Context): Promise<{ calls: string[][]; error: Error | null }> {
  const calls: string[][] = [];
  try {
    await hook.default(c, { run: (cmd, args) => { calls.push([cmd, ...args]); } });
    return { calls, error: null };
  } catch (err) {
    return { calls, error: err as Error };
  }
}

const CASES: [Platform, number, string, Buffer][] = [
  ['darwin', Arch.arm64, 'darwin-arm64', machO64(CPU_TYPE_ARM64)],
  ['win32', Arch.x64, 'win32-x64', pe(IMAGE_FILE_MACHINE_AMD64)],
  ['linux', Arch.x64, 'linux-x64', elf64(EM_X86_64)],
];

test('afterPack, for a packaged app without the module, throws naming its path before any codesign call — darwin, win32 and linux', async () => {
  for (const [platform, arch, triple] of CASES) {
    const c = context(platform, arch);
    pack(c, triple, null);
    const { calls, error } = await runHook(c);
    assert.ok(error, `${platform}: an app without its native module is refused`);
    const expected = path.join(moduleDirOf(c, triple), 'treemap_core.node');
    assert.ok(error.message.includes(expected), `${platform}: the error names ${expected}: ${error.message}`);
    assert.match(error.message, /build:native/, `${platform}: and says how to get it`);
    assert.deepEqual(calls, [], `${platform}: nothing is signed for an app that will not ship`);
  }
});

test("afterPack passes the module of the target's architecture at nativeVersion; only darwin is then signed and verified", async () => {
  for (const [platform, arch, triple, header] of CASES) {
    const c = context(platform, arch);
    pack(c, triple, header);
    const { calls, error } = await runHook(c);
    assert.equal(error, null, `${platform}: ${error?.message}`);
    if (platform !== 'darwin') {
      assert.deepEqual(calls, [], `${platform}: no signing step here`);
      continue;
    }
    const app = path.join(c.appOutDir, 'TreeMap.app');
    assert.deepEqual(calls, [['codesign', '--force', '--sign', '-', '--timestamp=none', app], ['codesign', '--verify', '--deep', '--strict', app]],
      'the bundle is ad-hoc signed and its signature verified, as before');
  }
});

test('afterPack refuses a packaged module of another architecture, format or version, and says which', async () => {
  const bad: [Platform, number, string, Buffer, string | null, RegExp, string][] = [
    ['darwin', Arch.arm64, 'darwin-arm64', machO64(CPU_TYPE_X86_64), `${NATIVE_VERSION}\n`, /x64/, 'an Intel module in an Apple-silicon app'],
    ['darwin', Arch.x64, 'darwin-x64', machO64(CPU_TYPE_ARM64), `${NATIVE_VERSION}\n`, /arm64/, 'the other way round'],
    ['win32', Arch.x64, 'win32-x64', machO64(CPU_TYPE_X86_64), `${NATIVE_VERSION}\n`, /Mach-O/, "the Mac's module in a Windows app"],
    ['darwin', Arch.arm64, 'darwin-arm64', machO64(CPU_TYPE_ARM64), '0.0.1\n', /0\.0\.1/, 'a stale module the loader would refuse'],
    ['linux', Arch.x64, 'linux-x64', elf64(EM_X86_64), null, /VERSION/, 'a module without its VERSION'],
  ];
  for (const [platform, arch, triple, header, version, reason, label] of bad) {
    const c = context(platform, arch);
    pack(c, triple, header, version);
    const { calls, error } = await runHook(c);
    assert.ok(error, `${label}: refused`);
    assert.match(error.message, reason, `${label}: ${error.message}`);
    assert.deepEqual(calls, [], `${label}: and not signed`);
  }
});

test("afterPack reads electron-builder's own Arch values as the names Node gives process.arch, which name the prebuilt folders", () => {
  assert.equal(hook.nodeArchOf(Arch.x64), 'x64');
  assert.equal(hook.nodeArchOf(Arch.arm64), 'arm64');
  assert.equal(hook.nodeArchOf(Arch.ia32), 'ia32');
  assert.equal(hook.nodeArchOf(Arch.armv7l), 'arm', "electron-builder's armv7l is Node's arm");
  assert.equal(hook.nodeArchOf(Arch.universal), 'universal');
  assert.match(hook.nodeArchOf(99), /99/, 'an arch it does not know is named by its number, never taken for another');
});

test('electron-builder runs the default export: its own resolver finds the very function tested here', async () => {
  // resolveFunction prefers an export named after the hook ("afterPack") over
  // the default one, so a helper exported under that name would run instead.
  const lib = require.resolve('app-builder-lib/out/platformPackager', { paths: [require.resolve('electron-builder')] });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { resolveFunction } = require(lib) as { resolveFunction(type: string | undefined, executor: string, name: string): Promise<unknown> };
  const resolved = await resolveFunction(undefined, path.join(REPO, 'scripts', 'afterPack.js'), 'afterPack');
  assert.equal(resolved, hook.default);
});

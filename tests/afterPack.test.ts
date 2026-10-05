import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { CPU_TYPE_ARM64, CPU_TYPE_X86_64, EM_X86_64, IMAGE_FILE_MACHINE_AMD64, elf64, machO64, pe } from './fixtures/binaryHeaders';
import { chromiumCredits, electronLicence, electronZipEntries, macAppLayout } from './fixtures/electronLicences';
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
 *
 * And Electron's licences: electron-builder deletes Electron's LICENSE and
 * Chromium's LICENSES.chromium.html from a macOS build, so afterPack puts
 * them into the bundle's Resources, from the Electron zip, before signing,
 * and refuses any package — macOS, Windows or Linux — without them
 * (scripts/electron-licences.js, tests/electronLicences.test.ts).
 *
 * And gdu's: its LICENSE.md and the notices of the Go modules linked into it
 * (scripts/gdu-notices.js, tests/gduNotices.test.ts) ship in the resources'
 * gdu folder, and afterPack refuses a package without them, or with notices
 * that are not the sealed file the generator wrote.
 */

const REPO = path.join(__dirname, '..');
const NATIVE_VERSION = (JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { nativeVersion: string }).nativeVersion;

interface Context {
  electronPlatformName: string;
  arch: number;
  appOutDir: string;
  packager: { appInfo: { productFilename: string }; info: { framework: { version: string } }; config: Record<string, unknown>; projectDir: string };
}
type Run = (cmd: string, args: string[], opts?: object) => unknown;
interface Deps { run: Run; downloadZip(o: { version: string; platform: string; arch: string }): Promise<string>; readZipEntry(zip: string, entry: string): Buffer }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hook = require('../scripts/afterPack.js') as { default(context: Context, deps?: Partial<Deps> & { repo?: string }): Promise<void>; nodeArchOf(arch: number): string };
// electron-builder's own Arch enum, the value it hands the hook as context.arch.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Arch } = require('electron-builder') as { Arch: Record<'ia32' | 'x64' | 'armv7l' | 'arm64' | 'universal', number> };

type Platform = 'darwin' | 'win32' | 'linux';
const ELECTRON = '31.7.7';
const ZIP = '/cache/electron-v31.7.7-darwin-arm64.zip';

function context(platform: Platform, arch: number): Context {
  const appOutDir = fileTempDir(`treemap-afterpack-${platform}-`);
  return {
    electronPlatformName: platform,
    arch,
    appOutDir,
    packager: { appInfo: { productFilename: 'TreeMap' }, info: { framework: { version: ELECTRON } }, config: {}, projectDir: appOutDir },
  };
}

/** Where electron-builder puts the app's resources: inside the bundle on macOS, beside the executable elsewhere. */
function resourcesOf(c: Context): string {
  return c.electronPlatformName === 'darwin' ? path.join(c.appOutDir, 'TreeMap.app', 'Contents', 'Resources') : path.join(c.appOutDir, 'resources');
}

function moduleDirOf(c: Context, triple: string): string {
  return path.join(resourcesOf(c), 'app.asar.unpacked', 'native', 'prebuilt', triple);
}

/** gdu's licence files as build.extraResources puts them in the resources folder: the repository's own. */
function packGduLicences(c: Context): void {
  const dir = path.join(resourcesOf(c), 'gdu');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['LICENSE.md', 'THIRD_PARTY_NOTICES.txt']) fs.copyFileSync(path.join(REPO, 'build', 'gdu', name), path.join(dir, name));
}

/**
 * Lays out what electron-builder would have when afterPack runs: the
 * resources folder, with gdu's licence files (unless `gdu` is false); on
 * macOS the bundle's Electron Framework (and, as electron-builder leaves it,
 * no Electron licence anywhere); elsewhere Electron's licences beside the
 * executable, as electron-builder names them there (unless `licences` is
 * false); and the module and VERSION when given.
 */
function pack(c: Context, triple: string, header: Buffer | null, version: string | null = `${NATIVE_VERSION}\n`, licences = true, gdu = true): void {
  fs.mkdirSync(resourcesOf(c), { recursive: true });
  if (gdu) packGduLicences(c);
  if (c.electronPlatformName === 'darwin') macAppLayout(c.appOutDir, 'TreeMap', ELECTRON);
  else if (licences) {
    fs.writeFileSync(path.join(c.appOutDir, 'LICENSE.electron.txt'), electronLicence());
    fs.writeFileSync(path.join(c.appOutDir, 'LICENSES.chromium.html'), chromiumCredits());
  }
  if (!header) return;
  const dir = moduleDirOf(c, triple);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'treemap_core.node'), header);
  if (version !== null) fs.writeFileSync(path.join(dir, 'VERSION'), version);
}

/** A repository's native/prebuilt/<triple>/ holding `header` at nativeVersion. */
function prebuilt(dir: string, header: Buffer): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'treemap_core.node'), header);
  fs.writeFileSync(path.join(dir, 'VERSION'), `${NATIVE_VERSION}\n`);
}

/**
 * Runs the hook with codesign, the Electron download and the zip reader
 * stood in for — the zip holding `entries` — and answers every command it ran
 * and what `onSign` saw at each codesign call; `repo` stands in for the
 * repository it packages from.
 */
async function runHook(
  c: Context,
  entries: Record<string, Buffer> = electronZipEntries(ELECTRON),
  onSign: () => void = () => {},
  repo?: string,
): Promise<{ calls: string[][]; error: Error | null; asked: unknown[] }> {
  const calls: string[][] = [];
  const asked: unknown[] = [];
  try {
    await hook.default(c, {
      run: (cmd, args) => {
        onSign();
        calls.push([cmd, ...args]);
      },
      downloadZip: async (o) => {
        asked.push(o);
        return ZIP;
      },
      readZipEntry: (zip, entry) => {
        assert.equal(zip, ZIP);
        if (!(entry in entries)) throw new Error(`caution: filename not matched:  ${entry}`);
        return entries[entry];
      },
      ...(repo === undefined ? {} : { repo }),
    });
    return { calls, error: null, asked };
  } catch (err) {
    return { calls, error: err as Error, asked };
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

test('afterPack sends a missing module back to native/prebuilt/<triple>/ in the repository, and names a packaging config that dropped one that is there', async () => {
  for (const [platform, arch, triple, header] of CASES) {
    const repo = fileTempDir('treemap-afterpack-repo-');
    const source = path.join(repo, 'native', 'prebuilt', triple);
    const c = context(platform, arch);
    pack(c, triple, null);
    const none = await runHook(c, undefined, undefined, repo);
    assert.ok(none.error, `${platform}: refused`);
    const hint = none.error.message.slice(none.error.message.indexOf('does not exist'));
    assert.ok(hint.includes(source), `${platform}: the hint names ${source}: ${hint}`);
    assert.ok(!hint.includes(c.appOutDir), `${platform}: never the package electron-builder regenerates: ${hint}`);

    prebuilt(source, header);
    const c2 = context(platform, arch);
    pack(c2, triple, null);
    const dropped = await runHook(c2, undefined, undefined, repo);
    assert.ok(dropped.error, `${platform}: still refused`);
    assert.match(dropped.error.message, /build\.files or build\.asarUnpack/, `${platform}: the other cause: ${dropped.error.message}`);
    assert.deepEqual(dropped.calls, [], `${platform}: and nothing is signed`);
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
    const framework = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework');
    assert.deepEqual(calls, [
      ['codesign', '--force', '--sign', '-', '--timestamp=none', framework],
      ['codesign', '--force', '--sign', '-', '--timestamp=none', app],
      ['codesign', '--verify', '--deep', '--strict', app],
    ], 'the framework, then the bundle, are ad-hoc signed and the signature verified, as before');
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

test("afterPack, on macOS, puts Electron's licence and Chromium's credits into the bundle before it signs anything", async () => {
  const c = context('darwin', Arch.arm64);
  pack(c, 'darwin-arm64', machO64(CPU_TYPE_ARM64));
  const resources = resourcesOf(c);
  const seen: boolean[] = [];
  const { calls, error, asked } = await runHook(c, electronZipEntries(ELECTRON), () => {
    seen.push(fs.existsSync(path.join(resources, 'LICENSE.electron.txt')) && fs.existsSync(path.join(resources, 'LICENSES.chromium.html')));
  });
  assert.equal(error, null, error?.message);
  assert.deepEqual(asked, [{ version: ELECTRON, platform: 'darwin', arch: 'arm64' }],
    "the zip asked for is the Electron electron-builder packaged (its framework's version) for this architecture, by Node's name for it");
  assert.ok(calls.length > 0 && seen.length === calls.length && seen.every(Boolean), `both files are in place at every codesign call, so the signature seals them: ${JSON.stringify(seen)}`);
  const zip = electronZipEntries(ELECTRON);
  assert.ok(fs.readFileSync(path.join(resources, 'LICENSE.electron.txt')).equals(zip.LICENSE), "Electron's LICENSE, byte for byte");
  assert.ok(fs.readFileSync(path.join(resources, 'LICENSES.chromium.html')).equals(zip['LICENSES.chromium.html']), "Chromium's credits, byte for byte");
});

test("afterPack refuses, before any signing, a macOS app whose Electron zip lacks LICENSE and a Windows or Linux app without Electron's licences", async () => {
  const mac = context('darwin', Arch.arm64);
  pack(mac, 'darwin-arm64', machO64(CPU_TYPE_ARM64));
  const { LICENSE: _gone, ...noLicence } = electronZipEntries(ELECTRON);
  void _gone;
  const r = await runHook(mac, noLicence);
  assert.ok(r.error && r.error.message.includes('LICENSE') && r.error.message.includes(ZIP), `darwin: the zip and the entry are named: ${r.error?.message}`);
  assert.deepEqual(r.calls, [], 'darwin: nothing is signed');

  for (const [platform, triple, header] of [['win32', 'win32-x64', pe(IMAGE_FILE_MACHINE_AMD64)], ['linux', 'linux-x64', elf64(EM_X86_64)]] as const) {
    const c = context(platform, Arch.x64);
    pack(c, triple, header, `${NATIVE_VERSION}\n`, false);
    const { calls, error } = await runHook(c);
    assert.ok(error, `${platform}: an app without Electron's licences is refused`);
    for (const name of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) {
      assert.ok(error.message.includes(path.join(c.appOutDir, name)), `${platform}: names ${name} beside the executable: ${error.message}`);
    }
    assert.deepEqual(calls, [], `${platform}: no signing step runs`);
  }
});

test("afterPack refuses, before any signing, an app without gdu's licence or the notices of the Go modules in gdu, or with notices edited after they were sealed — darwin, win32 and linux", async () => {
  for (const [platform, arch, triple, header] of CASES) {
    const bare = context(platform, arch);
    pack(bare, triple, header, `${NATIVE_VERSION}\n`, true, false);
    const none = await runHook(bare);
    assert.ok(none.error, `${platform}: an app without gdu's licence files is refused`);
    for (const name of ['LICENSE.md', 'THIRD_PARTY_NOTICES.txt']) {
      const file = path.join(resourcesOf(bare), 'gdu', name);
      assert.ok(none.error.message.includes(file), `${platform}: names ${file}: ${none.error.message}`);
    }
    assert.deepEqual(none.calls, [], `${platform}: nothing is signed`);

    const edited = context(platform, arch);
    pack(edited, triple, header);
    const notices = path.join(resourcesOf(edited), 'gdu', 'THIRD_PARTY_NOTICES.txt');
    fs.writeFileSync(notices, fs.readFileSync(notices, 'utf8').replace('Permission is hereby granted', 'Permission is not granted'));
    const r = await runHook(edited);
    assert.ok(r.error && r.error.message.includes(notices), `${platform}: notices that no longer match their seal are refused, by path: ${r.error?.message}`);
    assert.match(r.error.message, /edited/);
    assert.deepEqual(r.calls, [], `${platform}: and not signed`);
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

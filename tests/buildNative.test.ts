import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MFT_HELPER_FILE, mftHelperCandidates } from '../src/services/scan/nativeEngine';

/**
 * scripts/build-native.js builds the native core and puts it where the loader
 * looks. The whole trip (cargo, copy, VERSION) is proven by the real-module
 * cases in tests/nativeLoader.test.ts; this file pins the decisions the script
 * makes on its own — the library name per platform, the prebuilt folder, the
 * target directory, the version handshake — and the one failure every user
 * without Rust would hit: cargo is not on PATH.
 */

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'build-native.js');

interface Helpers {
  libraryFileName(platform: string): string;
  prebuiltDir(repo: string, platform: string, arch: string): string;
  targetDir(env: NodeJS.ProcessEnv, workspace: string): string;
  workspaceVersion(toml: string): string | null;
  versionHandshake(nativeVersion: unknown, crateVersion: string | null): string | null;
  cargoMissingHint(): string;
  installModule(src: string, dest: string): void;
  helpersFor(platform: string): { crate: string; file: string }[];
  installAll(installs: { src: string; dest: string }[]): void;
  buildAndInstall(opts: {
    library: string;
    helpers: { crate: string; file: string }[];
    release: string;
    dir: string;
    runCargo(args: string[]): { ok: true } | { ok: false; code: number; message: string };
    exists(file: string): boolean;
    install(installs: { src: string; dest: string }[]): void;
  }): { code: number; messages: string[]; installed: string[] };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const helpers = require(SCRIPT) as Helpers;

test('the module is installed as a new file each time, never copied over the old one in place', () => {
  // Copying a rebuilt module over the old file keeps its inode, and on macOS
  // the kernel's cached code signature for that inode then no longer matches:
  // every process that later maps it is killed with SIGKILL (exit 137) —
  // node loading it, even cmp reading it (23 Sep 2026: 24 test files failed
  // that way after a rebuild while a test run had the old module loaded).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-install-'));
  try {
    const src = path.join(dir, 'libtm_node.dylib');
    const dest = path.join(dir, 'treemap_core.node');
    fs.writeFileSync(src, 'first build');
    helpers.installModule(src, dest);
    // bigint: an NTFS file id above 2^53 (a sequence number past 31) would round.
    const first = fs.statSync(dest, { bigint: true }).ino;
    fs.writeFileSync(src, 'second build');
    helpers.installModule(src, dest);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'second build');
    assert.notEqual(fs.statSync(dest, { bigint: true }).ino, first, 'a new file replaced the old one: its inode changed');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['libtm_node.dylib', 'treemap_core.node'], 'and no temporary file is left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('on Windows the NTFS turbo helper is built beside the module, under the name the app looks for; it is built nowhere else', () => {
  assert.deepEqual(helpers.helpersFor('win32'), [{ crate: 'tm-mft-helper', file: MFT_HELPER_FILE }]);
  for (const p of ['darwin', 'linux', 'freebsd']) assert.deepEqual(helpers.helpersFor(p), [], p);
  // cargo names a binary's executable after its [[bin]] name (plus .exe on
  // Windows), so the crate must build exactly the file the app looks for.
  const toml = fs.readFileSync(path.join(REPO, 'native', 'treemap-core', 'crates', 'tm-mft-helper', 'Cargo.toml'), 'utf8');
  assert.match(toml, /^name = "tm-mft-helper"$/m, 'the package');
  assert.match(toml, /\[\[bin\]\]\r?\nname = "tm-mft-helper"\r?\n/, 'the binary');
});

test('after npm run build:native the helper sits where the app looks for it first', { skip: process.platform !== 'win32' && 'the helper is built only for Windows' }, () => {
  const [first] = mftHelperCandidates();
  assert.equal(path.basename(first), MFT_HELPER_FILE);
  assert.ok(fs.existsSync(first), `${first} exists — run npm run build:native`);
});

test('a copy that fails installs nothing: every file is staged before any is installed, and no temporary is left', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-install-'));
  try {
    const moduleSrc = path.join(dir, 'libtm_node.dylib');
    fs.writeFileSync(moduleSrc, 'new module');
    const moduleDest = path.join(dir, 'treemap_core.node');
    fs.writeFileSync(moduleDest, 'old module');
    const notAFile = path.join(dir, 'helper-src');
    fs.mkdirSync(notAFile); // copying a folder as a file fails
    assert.throws(
      () => helpers.installAll([{ src: moduleSrc, dest: moduleDest }, { src: notAFile, dest: path.join(dir, 'tm-mft-helper.exe') }]),
      /copying the built files failed, so none was installed/,
    );
    assert.equal(fs.readFileSync(moduleDest, 'utf8'), 'old module', 'the module was not replaced');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['helper-src', 'libtm_node.dylib', 'treemap_core.node'], 'no temporary is left');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a rename that fails after another succeeded names what was installed and what was not, and leaves no temporary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-install-'));
  try {
    const moduleSrc = path.join(dir, 'libtm_node.dylib');
    const helperSrc = path.join(dir, 'tm_mft_helper_built');
    fs.writeFileSync(moduleSrc, 'new module');
    fs.writeFileSync(helperSrc, 'new helper');
    const moduleDest = path.join(dir, 'treemap_core.node');
    const helperDest = path.join(dir, 'tm-mft-helper.exe');
    fs.mkdirSync(helperDest);
    fs.writeFileSync(path.join(helperDest, 'in-use'), 'x'); // a non-empty folder where the helper goes: its rename fails
    assert.throws(
      () => helpers.installAll([{ src: moduleSrc, dest: moduleDest }, { src: helperSrc, dest: helperDest }]),
      (err: Error & { installed?: string[] }) => {
        assert.match(err.message, /installing tm-mft-helper\.exe failed .*; installed: treemap_core\.node; not installed: tm-mft-helper\.exe/);
        // Carried, not only named: the caller writes VERSION beside a module it replaced.
        assert.deepEqual(err.installed, [moduleDest]);
        return true;
      },
    );
    assert.equal(fs.readFileSync(moduleDest, 'utf8'), 'new module', 'the rename before it stands, and is named');
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], 'no temporary is left');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A cargo that records each run and fails the crates it is told to. */
function fakeCargo(failing: string[] = [], code = 101) {
  const runs: string[][] = [];
  const runCargo = (args: string[]): { ok: true } | { ok: false; code: number; message: string } => {
    runs.push(args);
    const crate = args[args.indexOf('-p') + 1];
    return failing.includes(crate) ? { ok: false, code, message: `build-native: cargo exited ${code}` } : { ok: true };
  };
  return { runs, runCargo };
}

const HELPER = { crate: 'tm-mft-helper', file: 'tm-mft-helper.exe' };
const RELEASE = path.join('target', 'release');
const PREBUILT = path.join('native', 'prebuilt', 'win32-x64');
const MODULE_INSTALL = { src: path.join(RELEASE, 'tm_node.dll'), dest: path.join(PREBUILT, 'treemap_core.node') };
const HELPER_INSTALL = { src: path.join(RELEASE, HELPER.file), dest: path.join(PREBUILT, HELPER.file) };

test('the module and each helper are built in cargo runs of their own, the module first, and all that built is installed together', () => {
  const cargo = fakeCargo();
  const installs: { src: string; dest: string }[][] = [];
  const r = helpers.buildAndInstall({ library: 'tm_node.dll', helpers: [HELPER], release: RELEASE, dir: PREBUILT, runCargo: cargo.runCargo, exists: () => true, install: (i) => { installs.push(i); } });
  assert.deepEqual(cargo.runs, [['build', '--release', '-p', 'tm-node'], ['build', '--release', '-p', 'tm-mft-helper']]);
  assert.equal(r.code, 0);
  assert.deepEqual(installs, [[MODULE_INSTALL, HELPER_INSTALL]]);
  assert.deepEqual(r.installed, [MODULE_INSTALL.dest, HELPER_INSTALL.dest]);
});

test('a helper that fails to build costs only itself: the module is installed, and the run still fails, naming the helper', () => {
  // The CI dry run of 23 Sep 2026: one cargo run for both meant a helper's
  // compile error installed nothing, and every native test on that leg would
  // have failed behind it.
  const cargo = fakeCargo(['tm-mft-helper']);
  const installs: { src: string; dest: string }[][] = [];
  const r = helpers.buildAndInstall({ library: 'tm_node.dll', helpers: [HELPER], release: RELEASE, dir: PREBUILT, runCargo: cargo.runCargo, exists: () => true, install: (i) => { installs.push(i); } });
  assert.equal(r.code, 1, 'the run fails, so the error is seen');
  assert.deepEqual(installs, [[MODULE_INSTALL]], 'the module is installed all the same');
  assert.match(r.messages.join('\n'), /the module was installed, but tm-mft-helper did not build/);
  assert.match(r.messages.join('\n'), /cargo exited 101/);
});

test('an install that fails part-way reports what it installed, so VERSION is written beside a replaced module', () => {
  // The pre-landing review of 23 Sep 2026: the module's rename had stood, a
  // helper's failed, and the result said nothing was installed — so VERSION
  // was left naming the module that had just been replaced.
  const build = (install: (i: { src: string; dest: string }[]) => void) =>
    helpers.buildAndInstall({ library: 'tm_node.dll', helpers: [HELPER], release: RELEASE, dir: PREBUILT, runCargo: fakeCargo().runCargo, exists: () => true, install });
  const partial = Object.assign(new Error('build-native: installing tm-mft-helper.exe failed (EBUSY); installed: treemap_core.node; not installed: tm-mft-helper.exe'), { installed: [MODULE_INSTALL.dest] });
  const r = build(() => { throw partial; });
  assert.equal(r.code, 1, 'the run still fails, so the error is seen');
  assert.deepEqual(r.messages, [partial.message]);
  assert.deepEqual(r.installed, [MODULE_INSTALL.dest]);
  const none = build(() => { throw new Error('build-native: copying the built files failed, so none was installed: ENOSPC'); });
  assert.equal(none.code, 1);
  assert.deepEqual(none.installed, [], 'an error that installed nothing says so');
});

test('a module that fails to build installs nothing and builds no helper', () => {
  const cargo = fakeCargo(['tm-node'], 101);
  const installs: unknown[] = [];
  const r = helpers.buildAndInstall({ library: 'tm_node.dll', helpers: [HELPER], release: RELEASE, dir: PREBUILT, runCargo: cargo.runCargo, exists: () => true, install: (i) => { installs.push(i); } });
  assert.equal(r.code, 101, 'cargo’s own status');
  assert.deepEqual(cargo.runs.length, 1, 'no helper is built after the module failed');
  assert.deepEqual(installs, []);
  assert.deepEqual(r.installed, []);
  assert.match(r.messages.join('\n'), /nothing was copied/);
});

test('a file cargo said it built but did not write is not installed: the module installs nothing; a helper only itself', () => {
  const noModule = helpers.buildAndInstall({ library: 'tm_node.dll', helpers: [HELPER], release: RELEASE, dir: PREBUILT, runCargo: fakeCargo().runCargo, exists: (f) => f !== MODULE_INSTALL.src, install: () => assert.fail('nothing may be installed') });
  assert.equal(noModule.code, 1);
  assert.match(noModule.messages.join('\n'), /tm_node\.dll does not exist; nothing was copied/);
  const installs: { src: string; dest: string }[][] = [];
  const noHelper = helpers.buildAndInstall({ library: 'tm_node.dll', helpers: [HELPER], release: RELEASE, dir: PREBUILT, runCargo: fakeCargo().runCargo, exists: (f) => f !== HELPER_INSTALL.src, install: (i) => { installs.push(i); } });
  assert.equal(noHelper.code, 1);
  assert.deepEqual(installs, [[MODULE_INSTALL]]);
  assert.match(noHelper.messages.join('\n'), /tm-mft-helper did not build/);
});

test('the library cargo writes is named per platform, and a platform the workspace does not build for is refused by name', () => {
  assert.equal(helpers.libraryFileName('darwin'), 'libtm_node.dylib');
  assert.equal(helpers.libraryFileName('linux'), 'libtm_node.so');
  assert.equal(helpers.libraryFileName('win32'), 'tm_node.dll');
  assert.throws(() => helpers.libraryFileName('freebsd'), /freebsd/);
});

test('the prebuilt folder is native/prebuilt/<platform>-<arch> and the target directory honours CARGO_TARGET_DIR', () => {
  assert.equal(helpers.prebuiltDir('/repo', 'darwin', 'arm64'), path.join('/repo', 'native', 'prebuilt', 'darwin-arm64'));
  assert.equal(helpers.prebuiltDir('/repo', 'win32', 'x64'), path.join('/repo', 'native', 'prebuilt', 'win32-x64'));
  assert.equal(helpers.targetDir({}, '/ws'), path.join('/ws', 'target'));
  assert.equal(helpers.targetDir({ CARGO_TARGET_DIR: '/elsewhere/target' }, '/ws'), path.resolve('/elsewhere/target'));
  assert.equal(helpers.targetDir({ CARGO_TARGET_DIR: '' }, '/ws'), path.join('/ws', 'target'), 'an empty override is no override');
});

test('the workspace version is read from [workspace.package], not from a crate', () => {
  const toml = [
    '[workspace]',
    'members = ["crates/*"]',
    '',
    '[workspace.package]',
    'version = "0.1.0"',
    'edition = "2024"',
    '',
    '[package]',
    'version = "9.9.9"',
  ].join('\n');
  assert.equal(helpers.workspaceVersion(toml), '0.1.0');
  assert.equal(helpers.workspaceVersion('[package]\nversion = "9.9.9"\n'), null, 'no workspace version is null, never a guess');
  assert.equal(helpers.workspaceVersion(''), null);
  assert.equal(helpers.workspaceVersion(fs.readFileSync(path.join(REPO, 'native', 'treemap-core', 'Cargo.toml'), 'utf8')), '0.1.0', 'the real workspace');
});

test('the version handshake: package.json nativeVersion and the crate version must agree, and both are named when they do not', () => {
  assert.equal(helpers.versionHandshake('0.1.0', '0.1.0'), null);
  const mismatch = helpers.versionHandshake('0.1.0', '0.2.0');
  assert.ok(mismatch && mismatch.includes('0.1.0') && mismatch.includes('0.2.0'), String(mismatch));
  assert.ok(mismatch && mismatch.includes('package.json') && mismatch.includes('Cargo.toml'), String(mismatch));
  assert.match(String(helpers.versionHandshake(undefined, '0.1.0')), /nativeVersion/);
  assert.match(String(helpers.versionHandshake('0.1.0', null)), /Cargo\.toml/);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { nativeVersion: string };
  assert.equal(helpers.versionHandshake(pkg.nativeVersion, helpers.workspaceVersion(fs.readFileSync(path.join(REPO, 'native', 'treemap-core', 'Cargo.toml'), 'utf8'))), null, 'the repo agrees with itself');
});

test('without cargo on PATH the script exits non-zero with the rustup hint, and builds nothing', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'treemap-no-cargo-'));
  try {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^path$/i.test(k)) env[k] = v;
    env.PATH = empty;
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf8', env, timeout: 60_000 });
    assert.notEqual(r.status, 0, `exit ${r.status}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /cargo/);
    assert.match(r.stderr, /rustup\.rs/);
    assert.match(r.stderr, /build:native/);
    assert.equal(r.stdout.trim(), '', 'no path is printed for a module that was not built');
    assert.match(helpers.cargoMissingHint(), /rustup\.rs/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

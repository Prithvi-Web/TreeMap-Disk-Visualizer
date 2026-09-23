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
    const first = fs.statSync(dest).ino;
    fs.writeFileSync(src, 'second build');
    helpers.installModule(src, dest);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'second build');
    assert.notEqual(fs.statSync(dest).ino, first, 'a new file replaced the old one: its inode changed');
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

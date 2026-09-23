#!/usr/bin/env node
'use strict';
/*
 * Build the native core (native/treemap-core, crate tm-node) and put it where
 * the loader looks.
 *
 *   node scripts/build-native.js        (npm run build:native)
 *
 * In order:
 *   1. the version handshake: package.json's nativeVersion must equal the
 *      workspace version in native/treemap-core/Cargo.toml. The loader
 *      (src/services/scan/native.ts) refuses a module whose version() is not
 *      nativeVersion, so a drift is caught here, before a module is built that
 *      would only be refused at run time;
 *   2. `cargo build --release -p tm-node` in the workspace, with cargo's own
 *      output on this terminal;
 *   3. the library cargo wrote (libtm_node.dylib / libtm_node.so / tm_node.dll)
 *      is copied to native/prebuilt/<platform>-<arch>/treemap_core.node and
 *      VERSION is written beside it;
 *   4. the module's path is printed on stdout, as the last line; everything
 *      else this script says goes to stderr.
 *
 * cargo's target directory is native/treemap-core/target, or CARGO_TARGET_DIR
 * when that is set (a relative one is relative to the workspace, as cargo
 * reads it). Both it and native/prebuilt/ are gitignored: the module is built
 * by CI on every leg and bundled by the release, never committed. Users never
 * run this — without the module the app runs the legacy engines and says why —
 * and without cargo the script exits 1 with the install hint.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const WORKSPACE = path.join(REPO, 'native', 'treemap-core');
const CRATE = 'tm-node';
const MODULE_FILE = 'treemap_core.node';
const VERSION_FILE = 'VERSION';
/** What cargo names the cdylib on each platform this workspace builds for. */
const LIBRARY_BY_PLATFORM = { darwin: 'libtm_node.dylib', linux: 'libtm_node.so', win32: 'tm_node.dll' };

function libraryFileName(platform) {
  const name = LIBRARY_BY_PLATFORM[platform];
  if (!name) throw new Error(`build-native: no native build for platform "${platform}" (the workspace builds for darwin, linux and win32)`);
  return name;
}

function prebuiltDir(repo, platform, arch) {
  return path.join(repo, 'native', 'prebuilt', `${platform}-${arch}`);
}

/** Where cargo writes: CARGO_TARGET_DIR (relative to the workspace, as cargo resolves it) or the workspace's target/. */
function targetDir(env, workspace) {
  return env.CARGO_TARGET_DIR ? path.resolve(workspace, env.CARGO_TARGET_DIR) : path.join(workspace, 'target');
}

/** The version under [workspace.package] in a Cargo.toml, or null when there is none. */
function workspaceVersion(toml) {
  let inWorkspacePackage = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inWorkspacePackage = line === '[workspace.package]';
      continue;
    }
    if (!inWorkspacePackage) continue;
    const m = /^version\s*=\s*"([^"]+)"/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/** Null when the two versions agree; otherwise the reason the build must not proceed. */
function versionHandshake(nativeVersion, crateVersion) {
  if (typeof nativeVersion !== 'string' || nativeVersion === '') {
    return 'build-native: package.json has no "nativeVersion" string, so the loader could never accept a module';
  }
  if (!crateVersion) {
    return 'build-native: native/treemap-core/Cargo.toml has no [workspace.package] version to compare with nativeVersion';
  }
  if (nativeVersion !== crateVersion) {
    return `build-native: package.json nativeVersion is ${nativeVersion} but native/treemap-core/Cargo.toml's workspace version is ${crateVersion}; the loader compares the module's version() with nativeVersion, so bump them together`;
  }
  return null;
}

function cargoMissingHint() {
  return 'build-native: cargo was not found on PATH. Install Rust from https://rustup.rs (it puts cargo in ~/.cargo/bin; open a new terminal afterwards), then run npm run build:native again. Users never need this: the app runs its legacy engines when the native module is absent.';
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const drift = versionHandshake(pkg.nativeVersion, workspaceVersion(fs.readFileSync(path.join(WORKSPACE, 'Cargo.toml'), 'utf8')));
  if (drift) {
    console.error(drift);
    process.exit(1);
  }
  let library;
  try {
    library = libraryFileName(process.platform);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const args = ['build', '--release', '-p', CRATE];
  console.error(`build-native: cargo ${args.join(' ')} in ${WORKSPACE}`);
  const r = spawnSync('cargo', args, { cwd: WORKSPACE, stdio: 'inherit' });
  if (r.error && r.error.code === 'ENOENT') {
    console.error(cargoMissingHint());
    process.exit(1);
  }
  if (r.error) {
    console.error(`build-native: could not run cargo: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`build-native: cargo exited ${r.status}; nothing was copied`);
    process.exit(r.status || 1);
  }

  const src = path.join(targetDir(process.env, WORKSPACE), 'release', library);
  if (!fs.existsSync(src)) {
    console.error(`build-native: cargo finished but ${src} does not exist`);
    process.exit(1);
  }
  const dir = prebuiltDir(REPO, process.platform, process.arch);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, MODULE_FILE);
  installModule(src, dest);
  fs.writeFileSync(path.join(dir, VERSION_FILE), `${pkg.nativeVersion}\n`);
  console.error(`build-native: native version ${pkg.nativeVersion}, ${fs.statSync(dest).size} bytes`);
  console.log(dest);
}

/**
 * Puts the library cargo built at `dest` as a new file: copied to a
 * temporary name beside it, then renamed over it. Copying over the old file
 * in place keeps its inode, and on macOS the kernel's cached code signature
 * for that inode then no longer matches the new bytes: every process that
 * later maps the file is killed with SIGKILL (exit 137) — node loading it,
 * even `cmp` reading it. It happened on 23 Sep 2026, when a rebuild landed
 * while a test run had the old module loaded, and failed 24 test files. The
 * rename also means no process ever loads a half-copied module.
 */
function installModule(src, dest) {
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.copyFileSync(src, tmp);
  try {
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = { libraryFileName, prebuiltDir, targetDir, workspaceVersion, versionHandshake, cargoMissingHint, installModule };
}

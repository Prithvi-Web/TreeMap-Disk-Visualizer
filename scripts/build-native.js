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
 *   2. `cargo build --release -p tm-node` in the workspace — on Windows with
 *      `-p tm-mft-helper` too, the NTFS turbo mode's elevated helper — with
 *      cargo's own output on this terminal;
 *   3. the library cargo wrote (libtm_node.dylib / libtm_node.so / tm_node.dll)
 *      is copied to native/prebuilt/<platform>-<arch>/treemap_core.node, the
 *      Windows helper to tm-mft-helper.exe beside it, and VERSION is written
 *      beside them;
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

/**
 * The executables built and installed beside the module, per platform. The
 * NTFS turbo mode's elevated helper (W6, M6) exists for Windows only; the app
 * looks for it beside the module first (mftHelperCandidates in
 * src/services/scan/nativeEngine.ts), and the release bundles native/prebuilt
 * whole, unpacked from the asar.
 */
const HELPERS_BY_PLATFORM = { win32: [{ crate: 'tm-mft-helper', file: 'tm-mft-helper.exe' }] };

function helpersFor(platform) {
  return HELPERS_BY_PLATFORM[platform] ?? [];
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

  const helpers = helpersFor(process.platform);
  const args = ['build', '--release', '-p', CRATE, ...helpers.flatMap((h) => ['-p', h.crate])];
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

  // Every file is checked, then staged beside its destination, before any is
  // installed (installAll): a build that made the module but not a helper, or
  // a copy that fails, installs nothing, and a rename that fails is reported
  // with exactly what was and was not installed.
  const release = path.join(targetDir(process.env, WORKSPACE), 'release');
  const dir = prebuiltDir(REPO, process.platform, process.arch);
  const installs = [
    { src: path.join(release, library), dest: path.join(dir, MODULE_FILE) },
    ...helpers.map((h) => ({ src: path.join(release, h.file), dest: path.join(dir, h.file) })),
  ];
  for (const { src } of installs) {
    if (!fs.existsSync(src)) {
      console.error(`build-native: cargo finished but ${src} does not exist; nothing was copied`);
      process.exit(1);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  try {
    installAll(installs);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const [moduleDest, ...helperDests] = installs.map((i) => i.dest);
  fs.writeFileSync(path.join(dir, VERSION_FILE), `${pkg.nativeVersion}\n`);
  for (const dest of helperDests) console.error(`build-native: ${path.basename(dest)}, ${fs.statSync(dest).size} bytes`);
  console.error(`build-native: native version ${pkg.nativeVersion}, ${fs.statSync(moduleDest).size} bytes`);
  console.log(moduleDest);
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
  installAll([{ src, dest }]);
}

/**
 * Installs each `{ src, dest }` as `installModule` does, in two steps so a
 * failure leaves as little as it can (the TypeScript review of M6): every
 * file is first copied to a temporary name beside its destination — a copy
 * that fails removes every temporary and installs nothing — and only then is
 * each renamed over its destination. A rename is not undone, so one that
 * fails after another succeeded (the file held open by a running TreeMap or
 * an antivirus scan) throws naming what was installed and what was not,
 * with the temporaries it left removed.
 */
function installAll(installs) {
  const staged = [];
  try {
    for (const { src, dest } of installs) {
      const tmp = `${dest}.${process.pid}.tmp`;
      staged.push({ tmp, dest });
      fs.copyFileSync(src, tmp);
    }
  } catch (err) {
    for (const { tmp } of staged) fs.rmSync(tmp, { force: true });
    throw new Error(`build-native: copying the built files failed, so none was installed: ${err.message}`);
  }
  const installed = [];
  staged.forEach(({ tmp, dest }, i) => {
    try {
      fs.renameSync(tmp, dest);
      installed.push(path.basename(dest));
    } catch (err) {
      const left = staged.slice(i);
      for (const rest of left) fs.rmSync(rest.tmp, { force: true });
      throw new Error(
        `build-native: installing ${path.basename(dest)} failed (${err.message}); installed: ${installed.join(', ') || 'nothing'}; ` +
          `not installed: ${left.map((rest) => path.basename(rest.dest)).join(', ')} — close whatever is using them and run npm run build:native again`,
      );
    }
  });
}

if (require.main === module) {
  main();
} else {
  module.exports = { libraryFileName, prebuiltDir, targetDir, workspaceVersion, versionHandshake, cargoMissingHint, installModule, installAll, helpersFor };
}

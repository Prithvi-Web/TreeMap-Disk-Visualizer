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
 *   2. `cargo build --release -p tm-node` in the workspace, then — on Windows —
 *      `cargo build --release -p tm-mft-helper` (the NTFS turbo mode's
 *      elevated helper) in a run of its own, so a helper that fails to build
 *      costs only itself (buildAndInstall); cargo's own output on this terminal;
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

  const dir = prebuiltDir(REPO, process.platform, process.arch);
  const result = buildAndInstall({
    library,
    helpers: helpersFor(process.platform),
    release: path.join(targetDir(process.env, WORKSPACE), 'release'),
    dir,
    runCargo,
    exists: fs.existsSync,
    install: (installs) => {
      fs.mkdirSync(dir, { recursive: true });
      installAll(installs);
    },
  });
  for (const message of result.messages) console.error(message);
  const [moduleDest, ...helperDests] = result.installed;
  if (moduleDest) {
    fs.writeFileSync(path.join(dir, VERSION_FILE), `${pkg.nativeVersion}\n`);
    for (const dest of helperDests) console.error(`build-native: ${path.basename(dest)}, ${fs.statSync(dest).size} bytes`);
    console.error(`build-native: native version ${pkg.nativeVersion}, ${fs.statSync(moduleDest).size} bytes`);
    console.log(moduleDest);
  }
  if (result.code !== 0) process.exit(result.code);
}

/** One cargo run in the workspace, cargo's own output on this terminal; never exits. */
function runCargo(args) {
  console.error(`build-native: cargo ${args.join(' ')} in ${WORKSPACE}`);
  const r = spawnSync('cargo', args, { cwd: WORKSPACE, stdio: 'inherit' });
  if (r.error && r.error.code === 'ENOENT') return { ok: false, code: 1, message: cargoMissingHint() };
  if (r.error) return { ok: false, code: 1, message: `build-native: could not run cargo: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, code: r.status || 1, message: `build-native: cargo exited ${r.status}` };
  return { ok: true };
}

/**
 * Builds and installs: the module in a cargo run of its own, then each helper
 * in a run of its own, so a helper that fails to build costs only itself —
 * the CI dry run of 23 Sep 2026: one run for both meant a helper's compile
 * error installed nothing, and every native test on that leg would have
 * failed behind it. A module that fails to build, or was not written, installs
 * nothing; a helper that fails either way is left out, the module is
 * installed, and the result still fails (exit 1) so the error is seen. Every
 * file that built is then installed together (installAll); an install that
 * fails part-way still reports what it installed. Runs nothing
 * itself: `runCargo(args)` answers `{ ok }` or `{ ok: false, code, message }`,
 * `exists(file)` and `install(installs)` are the file system's.
 * @returns {{ code: number, messages: string[], installed: string[] }}
 */
function buildAndInstall({ library, helpers, release, dir, runCargo, exists, install }) {
  const built = runCargo(['build', '--release', '-p', CRATE]);
  if (!built.ok) return { code: built.code, messages: [`${built.message}; nothing was copied`], installed: [] };
  const moduleInstall = { src: path.join(release, library), dest: path.join(dir, MODULE_FILE) };
  if (!exists(moduleInstall.src)) {
    return { code: 1, messages: [`build-native: cargo finished but ${moduleInstall.src} does not exist; nothing was copied`], installed: [] };
  }
  const installs = [moduleInstall];
  const failed = [];
  for (const helper of helpers) {
    const run = runCargo(['build', '--release', '-p', helper.crate]);
    const src = path.join(release, helper.file);
    if (!run.ok) failed.push(`${helper.crate} did not build (${run.message})`);
    else if (!exists(src)) failed.push(`${helper.crate} did not build (cargo finished but ${src} does not exist)`);
    else installs.push({ src, dest: path.join(dir, helper.file) });
  }
  try {
    install(installs);
  } catch (err) {
    // A rename that failed after another stood (installAll) says which: the
    // module among them was replaced, so VERSION must be written beside it.
    return { code: 1, messages: [err.message], installed: Array.isArray(err.installed) ? err.installed : [] };
  }
  const installed = installs.map((i) => i.dest);
  if (failed.length === 0) return { code: 0, messages: [], installed };
  return {
    code: 1,
    messages: [`build-native: the module was installed, but ${failed.join('; ')}, so it was not; the app falls back where it needs it, and this run fails so the error is seen`],
    installed,
  };
}

/**
 * Puts each file cargo built at its `dest` as a new file: copied to a
 * temporary name beside it, then renamed over it. Copying over the old file
 * in place keeps its inode, and on macOS the kernel's cached code signature
 * for that inode then no longer matches the new bytes: every process that
 * later maps the file is killed with SIGKILL (exit 137) — node loading it,
 * even `cmp` reading it. It happened on 23 Sep 2026, when a rebuild landed
 * while a test run had the old module loaded, and failed 24 test files. The
 * rename also means no process ever loads a half-copied module.
 *
 * In two steps, so a failure leaves as little as it can (the TypeScript
 * review of M6): every
 * file is first copied to a temporary name beside its destination — a copy
 * that fails removes every temporary and installs nothing — and only then is
 * each renamed over its destination. A rename is not undone, so one that
 * fails after another succeeded (the file held open by a running TreeMap or
 * an antivirus scan) throws naming what was installed and what was not,
 * with the temporaries it left removed; the error's `installed` holds the
 * destinations installed before it.
 *
 * A destination that already holds exactly the built bytes is left in place
 * and counts as installed: nothing would change, and Windows refuses to
 * replace a module another process has loaded — the suite's own rebuild
 * failed so, with EPERM, while other test files held the module it would
 * have replaced with the same bytes (CI run 36210179393, 26 Sep 2026).
 */
function installAll(installs) {
  const plan = installs.map(({ src, dest }) => ({ dest, src, tmp: `${dest}.${process.pid}.tmp`, current: holdsBytesOf(dest, src) }));
  const staged = [];
  try {
    for (const step of plan) {
      if (step.current) continue;
      staged.push(step);
      fs.copyFileSync(step.src, step.tmp);
    }
  } catch (err) {
    for (const { tmp } of staged) fs.rmSync(tmp, { force: true });
    throw new Error(`build-native: copying the built files failed, so none was installed: ${err.message}`);
  }
  const installed = [];
  plan.forEach((step, i) => {
    if (step.current) {
      installed.push(step.dest);
      return;
    }
    try {
      fs.renameSync(step.tmp, step.dest);
      installed.push(step.dest);
    } catch (err) {
      const left = plan.slice(i).filter((rest) => !rest.current);
      for (const rest of left) fs.rmSync(rest.tmp, { force: true });
      const named = installed.map((done) => path.basename(done)).join(', ') || 'nothing';
      throw Object.assign(
        new Error(
          `build-native: installing ${path.basename(step.dest)} failed (${err.message}); installed: ${named}; ` +
            `not installed: ${left.map((rest) => path.basename(rest.dest)).join(', ')} — close whatever is using them and run npm run build:native again`,
        ),
        { installed },
      );
    }
  });
}

/** Whether `dest` is a file holding exactly the bytes of `src`. */
function holdsBytesOf(dest, src) {
  let stat;
  try {
    stat = fs.statSync(dest);
  } catch {
    return false; // nothing installed there yet
  }
  if (!stat.isFile() || stat.size !== fs.statSync(src).size) return false;
  return fs.readFileSync(dest).equals(fs.readFileSync(src));
}

if (require.main === module) {
  main();
} else {
  module.exports = { libraryFileName, prebuiltDir, targetDir, workspaceVersion, versionHandshake, cargoMissingHint, installAll, helpersFor, buildAndInstall };
}

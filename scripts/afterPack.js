'use strict';
/*
 * electron-builder afterPack hook — on every platform, refuse an app without
 * its native module; on macOS, then give the app a VALID ad-hoc signature.
 *
 * The native module (Track U U-14): electron-builder runs this hook after it
 * has laid the app out and before anything is signed or archived, on every
 * route into it — the dist scripts, and a bare `npx electron-builder --mac
 * --dir` alike. The app's loader (src/services/scan/native.ts) looks for
 * app.asar/native/prebuilt/<platform>-<arch>/treemap_core.node, which
 * Electron reads from app.asar.unpacked (package.json's build.files and
 * build.asarUnpack put it there). An app without that file scans with gdu or
 * the walker, slower, and nothing says so at build time: the 5.1.0 build the
 * owner ran shipped that way. So the hook checks the packaged copy for the
 * platform and architecture electron-builder is packaging right now — the
 * file, a VERSION equal to package.json's nativeVersion, and a header of
 * that platform's format and architecture (scripts/check-prebuilt.js) — and
 * throws naming the path when any fails. The check comes before the
 * macOS-only signing below, so Windows and Linux packages are held to it
 * too, and an app that will not ship is never signed.
 *
 * The signature: TreeMap ships without a paid Apple Developer ID, so the
 * build runs with CSC_IDENTITY_AUTO_DISCOVERY=false. In that mode
 * electron-builder skips signing entirely, which leaves the .app bundle
 * with no _CodeSignature/CodeResources. macOS then treats the download as
 * "damaged" ("TreeMap is damaged and can't be opened") and refuses to launch
 * it — a dead end for non-technical users, because that error has no
 * right-click-to-open escape hatch.
 *
 * Re-signing the whole bundle ad-hoc (`codesign --sign -`) produces a proper
 * _CodeSignature so the bundle verifies cleanly. A downloaded copy then shows
 * the milder, dismissable "unidentified developer" prompt instead, which the
 * README explains how to clear. (Proper notarization would remove the prompt
 * altogether, but needs the paid Developer ID.)
 *
 * Nested helpers/frameworks must be signed before the outer app, so we sign
 * inside-out rather than relying on the deprecated `--deep` flag.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { checkPrebuilt } = require('./check-prebuilt');

/**
 * electron-builder's Arch enum (builder-util), by value, under the names Node
 * gives process.arch — the names of the prebuilt folders the loader reads.
 * Pinned against the real enum by tests/afterPack.test.ts.
 */
const NODE_ARCH_BY_BUILDER_ARCH = ['ia32', 'x64', 'arm', 'arm64', 'universal'];

/** Node's name for the architecture electron-builder hands the hook; one it does not know is named by its number. */
function nodeArchOf(arch) {
  return NODE_ARCH_BY_BUILDER_ARCH[arch] ?? `unknown architecture ${arch}`;
}

/** The packaged app's resources folder: inside the bundle on macOS, beside the executable elsewhere (electron-builder's getResourcesDir). */
function resourcesDirOf(context) {
  if (context.electronPlatformName === 'darwin') {
    return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  }
  return path.join(context.appOutDir, 'resources');
}

/**
 * Throws, naming the path, unless the packaged app holds the module it will
 * load. A missing one is looked for in `repo`'s native/prebuilt/<triple>/,
 * the folder electron-builder packages it from (tests stand a repo in).
 */
function assertPackagedModule(context, repo) {
  const platform = context.electronPlatformName;
  const arch = nodeArchOf(context.arch);
  const triple = `${platform}-${arch}`;
  const dir = path.join(resourcesDirOf(context), 'app.asar.unpacked', 'native', 'prebuilt', triple);
  const { nativeVersion } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const packagedFrom = path.join(repo, 'native', 'prebuilt', triple);
  const result = checkPrebuilt({ dir, platform, arch, nativeVersion, host: { platform: process.platform, arch: process.arch }, packagedFrom });
  if (!result.ok) {
    throw new Error(
      `[afterPack] the ${triple} app has no native module it can load: ${result.reason}. ` +
        'Every dist script builds the module and checks it (scripts/check-prebuilt.js) before electron-builder; a bare electron-builder call needs npm run build:native first.',
    );
  }
  console.log(`[afterPack] native module ${result.summary}`);
}

function sign(target, run) {
  // Plain ad-hoc, no hardened runtime: TreeMap is not notarized, and the
  // hardened runtime would block V8's JIT without extra entitlements.
  run('codesign', ['--force', '--sign', '-', '--timestamp=none', target], {
    stdio: 'inherit',
  });
}

function signInsideOut(appPath, run) {
  const frameworks = path.join(appPath, 'Contents', 'Frameworks');
  if (fs.existsSync(frameworks)) {
    for (const entry of fs.readdirSync(frameworks)) {
      const full = path.join(frameworks, entry);
      // Helper apps carry their own executable; sign that first.
      if (entry.endsWith('.app')) {
        const inner = path.join(full, 'Contents', 'MacOS');
        if (fs.existsSync(inner)) {
          for (const bin of fs.readdirSync(inner)) sign(path.join(inner, bin), run);
        }
      }
      sign(full, run); // framework bundle or loose .dylib
    }
  }
  sign(appPath, run); // outer bundle last, so its seal covers everything within
}

/**
 * The hook. electron-builder calls it with the context alone; `run` stands in
 * for execFileSync and `repo` for this repository in tests. Its resolver
 * takes an export named "afterPack" over this default one, so no export
 * carries that name.
 */
exports.default = async function afterPack(context, { run = execFileSync, repo = path.join(__dirname, '..') } = {}) {
  assertPackagedModule(context, repo);
  if (context.electronPlatformName !== 'darwin') return;
  // electron-builder still ad-hoc signs when a real identity is configured;
  // only step in when signing was skipped (no _CodeSignature was written).
  const appName = context.packager.appInfo.productFilename; // "TreeMap"
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[afterPack] ad-hoc signing ${appPath}`);
  try {
    signInsideOut(appPath, run);
    run('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
    console.log('[afterPack] ad-hoc signature verified');
  } catch (err) {
    console.error('[afterPack] ad-hoc signing failed:', err.message);
    throw err; // a broken signature is worse than a loud build failure
  }
};
exports.nodeArchOf = nodeArchOf;

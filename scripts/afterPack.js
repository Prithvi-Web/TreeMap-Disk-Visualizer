'use strict';
/*
 * electron-builder afterPack hook — give the macOS app a VALID ad-hoc
 * signature.
 *
 * Why this exists: TreeMap ships without a paid Apple Developer ID, so the
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

function sign(target) {
  // Plain ad-hoc, no hardened runtime: TreeMap is not notarized, and the
  // hardened runtime would block V8's JIT without extra entitlements.
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', target], {
    stdio: 'inherit',
  });
}

function signInsideOut(appPath) {
  const frameworks = path.join(appPath, 'Contents', 'Frameworks');
  if (fs.existsSync(frameworks)) {
    for (const entry of fs.readdirSync(frameworks)) {
      const full = path.join(frameworks, entry);
      // Helper apps carry their own executable; sign that first.
      if (entry.endsWith('.app')) {
        const inner = path.join(full, 'Contents', 'MacOS');
        if (fs.existsSync(inner)) {
          for (const bin of fs.readdirSync(inner)) sign(path.join(inner, bin));
        }
      }
      sign(full); // framework bundle or loose .dylib
    }
  }
  sign(appPath); // outer bundle last, so its seal covers everything within
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // electron-builder still ad-hoc signs when a real identity is configured;
  // only step in when signing was skipped (no _CodeSignature was written).
  const appName = context.packager.appInfo.productFilename; // "TreeMap"
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[afterPack] ad-hoc signing ${appPath}`);
  try {
    signInsideOut(appPath);
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
    console.log('[afterPack] ad-hoc signature verified');
  } catch (err) {
    console.error('[afterPack] ad-hoc signing failed:', err.message);
    throw err; // a broken signature is worse than a loud build failure
  }
};

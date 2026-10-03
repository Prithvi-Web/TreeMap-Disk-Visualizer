import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { CPU_TYPE_ARM64, machO64 } from './fixtures/binaryHeaders';
isolatedDataDir('treemap-packageScripts-data-');

import { nativeCandidates } from '../src/services/scan/native';

/**
 * package.json's packaging, held to Track U U-14 (owner answer U-Q14: a dist
 * that cannot build the native module fails, and a dist for another OS fails
 * without that OS's module). The 5.1.0 build the owner ran shipped without
 * the Rust scanner: no dist script built it, and nothing noticed it missing.
 * Now every dist script builds it, then checks it for the very target its
 * electron-builder call packages, before electron-builder runs; and
 * scripts/afterPack.js refuses a packaged app without it
 * (tests/afterPack.test.ts). R34 holds alongside: nothing a person's
 * `npm ci` runs ever needs Rust.
 */

const REPO = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
  nativeVersion: string;
  scripts: Record<string, string>;
  build: { files: string[]; asarUnpack: string[]; asar?: unknown };
};

interface Host { platform: string; arch: string }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const check = require('../scripts/check-prebuilt.js') as {
  resolveTarget(spec: string | undefined, host: Host): { ok: true; triple: string } | { ok: false; reason: string };
  main(argv: string[], deps: { repo: string; host: Host; out(line: string): void; err(line: string): void }): number;
};

const DIST = Object.entries(PKG.scripts).filter(([name]) => name === 'dist' || name.startsWith('dist:'));

/** electron-builder's platform flags, as the platform Node names. */
const PLATFORM_FLAGS: Record<string, string> = {
  '--mac': 'darwin', '-m': 'darwin', '--macos': 'darwin',
  '--win': 'win32', '-w': 'win32', '--windows': 'win32',
  '--linux': 'linux', '-l': 'linux',
};
/** electron-builder's architecture flags. */
const ARCH_FLAGS = ['--x64', '--arm64', '--ia32', '--armv7l', '--universal'];

/** A script's commands, in order. Every one is joined by `&&`, so one that fails stops the rest. */
function commands(name: string, script: string): string[] {
  const unquoted = script.replace(/"[^"]*"/g, '""');
  for (const part of unquoted.split('&&')) {
    assert.doesNotMatch(part, /[;|&]/, `${name}: its commands are joined by && only, so a failed build stops the packaging: ${script}`);
  }
  return script.split('&&').map((c) => c.trim());
}

/** The one command of `steps` that `matches`, by index. */
function only(name: string, steps: string[], label: string, matches: (step: string) => boolean): number {
  const hits = steps.flatMap((s, i) => (matches(s) ? [i] : []));
  assert.equal(hits.length, 1, `${name} runs ${label} exactly once: ${steps.join(' && ')}`);
  return hits[0];
}

const isCheck = (s: string) => /^node scripts\/check-prebuilt\.js(?:\s|$)/.test(s);
const isBuilder = (s: string) => /^electron-builder(?:\s|$)/.test(s);

/** What the check of a dist script is told: its --target, or undefined (this machine). */
function checkSpec(name: string, script: string): string | undefined {
  const steps = commands(name, script);
  const args = steps[only(name, steps, 'the check', isCheck)].split(/\s+/).slice(2);
  if (args.length === 0) return undefined;
  assert.ok(args.length === 2 && args[0] === '--target', `${name}: the check takes one --target: ${args.join(' ')}`);
  return args[1];
}

/** The target an electron-builder call packages, spelled as the check spells it: what the flags leave unsaid is this machine's. */
function builderSpec(name: string, script: string): string | undefined {
  const steps = commands(name, script);
  const args = steps[only(name, steps, 'electron-builder', isBuilder)].split(/\s+/).slice(1);
  const platforms = [...new Set(args.filter((a) => a in PLATFORM_FLAGS).map((a) => PLATFORM_FLAGS[a]))];
  const archs = args.filter((a) => ARCH_FLAGS.includes(a)).map((a) => a.slice(2));
  assert.ok(platforms.length <= 1 && archs.length <= 1, `${name}: one platform and one architecture at most, or the check could name only one of them: ${args.join(' ')}`);
  if (platforms.length === 0) {
    assert.equal(archs.length, 0, `${name}: an architecture without a platform is a target the check cannot spell`);
    return undefined;
  }
  return archs.length === 0 ? platforms[0] : `${platforms[0]}-${archs[0]}`;
}

test('every dist script builds the module and checks it before electron-builder', () => {
  const names = DIST.map(([name]) => name).sort();
  for (const expected of ['dist', 'dist:linux', 'dist:mac', 'dist:portable-linux', 'dist:portable-mac', 'dist:portable-win', 'dist:win']) {
    assert.ok(names.includes(expected), `${expected} exists: ${names.join(', ')}`);
  }
  for (const [name, script] of DIST) {
    const steps = commands(name, script);
    const build = only(name, steps, 'npm run build', (s) => s === 'npm run build');
    const native = only(name, steps, 'npm run build:native', (s) => s === 'npm run build:native');
    const checked = only(name, steps, 'the prebuilt check', isCheck);
    const builder = only(name, steps, 'electron-builder', isBuilder);
    assert.ok(build < native, `${name}: the module is built after the app (${steps.join(' && ')})`);
    assert.ok(native < checked, `${name}: and checked after it is built`);
    assert.ok(checked < builder, `${name}: and only then packaged`);
  }
});

test("each dist script's check names the target its own electron-builder call packages", () => {
  for (const [name, script] of DIST) {
    assert.equal(checkSpec(name, script), builderSpec(name, script), `${name}: the check and electron-builder name one target: ${script}`);
  }
});

test('dist:portable-mac and dist:portable-linux hand electron-builder its ${…} macros, not the empty strings sh would expand them to', {
  skip: process.platform === 'win32' && 'npm runs these two through sh; they package macOS and Linux, and are never run on Windows',
}, () => {
  // npm runs a script with `sh -c` on macOS and Linux, and sh expands
  // ${version}, ${arch} and ${ext} inside double quotes — to nothing, so the
  // portable builds were named "TreeMap-Portable--.". Each script's
  // electron-builder command is run through sh here with printf standing in
  // for electron-builder, which prints the arguments it is handed.
  for (const name of ['dist:portable-mac', 'dist:portable-linux']) {
    const steps = commands(name, PKG.scripts[name]);
    const builder = steps[only(name, steps, 'electron-builder', isBuilder)];
    const handed = execFileSync('/bin/sh', ['-c', builder.replace(/^electron-builder/, "printf '%s\\n'")], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    }).split('\n');
    const artifact = handed.find((a) => a.startsWith('--config.artifactName='));
    assert.equal(artifact, '--config.artifactName=TreeMap-Portable-${version}-${arch}.${ext}', `${name}: ${builder}`);
  }
});

test('dist:win on a darwin host checks win32-x64, not darwin-arm64', () => {
  const mac: Host = { platform: 'darwin', arch: 'arm64' };
  const macModuleOnly = fileTempDir('treemap-dist-win-on-mac-');
  fs.writeFileSync(path.join(macModuleOnly, 'package.json'), JSON.stringify({ nativeVersion: PKG.nativeVersion }));
  const dir = path.join(macModuleOnly, 'native', 'prebuilt', 'darwin-arm64');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'treemap_core.node'), machO64(CPU_TYPE_ARM64));
  fs.writeFileSync(path.join(dir, 'VERSION'), `${PKG.nativeVersion}\n`);

  for (const name of ['dist:win', 'dist:portable-win']) {
    const spec = checkSpec(name, PKG.scripts[name]);
    for (const host of [mac, { platform: 'win32', arch: 'x64' }, { platform: 'linux', arch: 'arm64' }]) {
      const r = check.resolveTarget(spec, host);
      assert.ok(r.ok && r.triple === 'win32-x64', `${name} on ${host.platform}-${host.arch}: win32-x64, the one Windows build TreeMap ships (${JSON.stringify(r)})`);
    }
    const err: string[] = [];
    const code = check.main(spec === undefined ? [] : ['--target', spec], { repo: macModuleOnly, host: mac, out: () => {}, err: (l) => err.push(l) });
    assert.equal(code, 1, `${name} on a Mac holding only the Mac's module fails`);
    assert.match(err.join('\n'), /win32-x64/, `${name}: and names the target it lacks: ${err.join('\n')}`);
  }
});

test('no install, preinstall, postinstall or prepare script runs cargo, build-native or fetch-native (R34)', () => {
  /** A script's text with the text of every `npm run <name>` it reaches, transitively. */
  const reach = (name: string, seen = new Set<string>()): string => {
    if (seen.has(name) || !(name in PKG.scripts)) return '';
    seen.add(name);
    const text = PKG.scripts[name];
    return [text, ...[...text.matchAll(/npm run ([\w:.-]+)/g)].map((m) => reach(m[1], seen))].join('\n');
  };
  assert.match(reach('dist:mac'), /build-native\.js/, 'the reach follows npm run into the scripts it names');
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']) {
    assert.doesNotMatch(reach(hook), /cargo|build-native|build:native|fetch-native|fetch:native/,
      `${hook}: npm runs it on a person's npm ci or npm install, and a person must never need Rust (R34)`);
  }
});

test('build.files and build.asarUnpack carry native/prebuilt: inside app.asar where the loader looks, unpacked beside it where afterPack checks', () => {
  assert.ok(PKG.build.files.includes('native/prebuilt/**'), `build.files: ${PKG.build.files.join(', ')}`);
  assert.ok(PKG.build.files.includes('dist/**/*'), 'and the compiled loader, whose folder three levels down from the archive root is what it resolves native/prebuilt from');
  assert.ok(PKG.build.asarUnpack.includes('native/prebuilt/**'),
    `build.asarUnpack: ${PKG.build.asarUnpack.join(', ')} — a native module must be a real file for dlopen and for the code signature`);
  assert.notEqual(PKG.build.asar, false, 'packed into app.asar: afterPack checks app.asar.unpacked');
  const first = nativeCandidates({})[0];
  assert.equal(path.relative(REPO, first), path.join('native', 'prebuilt', `${process.platform}-${process.arch}`, 'treemap_core.node'),
    'the loader looks in native/prebuilt/<platform>-<arch>/ under the app root (app.asar in a packaged app)');
});

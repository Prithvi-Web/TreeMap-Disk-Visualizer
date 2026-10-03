import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { fileTempDir, isolatedDataDir } from './fixtures/dataDir';
import { HANG_GUARD_MS } from './fixtures/waitFor';
import {
  CPU_TYPE_ARM64,
  CPU_TYPE_POWERPC64,
  CPU_TYPE_X86_64,
  EM_AARCH64,
  EM_RISCV,
  EM_X86_64,
  IMAGE_FILE_MACHINE_AMD64,
  IMAGE_FILE_MACHINE_ARM64,
  IMAGE_FILE_MACHINE_I386,
  IMAGE_FILE_MACHINE_RISCV64,
  elf64,
  fatMachO,
  machO64,
  pe,
  truncatedPe,
} from './fixtures/binaryHeaders';
isolatedDataDir('treemap-checkPrebuilt-data-');

/**
 * scripts/check-prebuilt.js is what every `dist` script runs between
 * `npm run build:native` and electron-builder (Track U U-14, owner answer
 * U-Q14: fail loudly). It passes only when the module for the target the
 * build packages is on disk, its VERSION is package.json's nativeVersion
 * (the loader refuses any other), and its header is that target's format and
 * architecture — so a dist for Windows on a Mac can never package the Mac's
 * module, and a stale module is refused before it is packaged rather than at
 * the owner's first scan. The headers here come from the formats' own
 * specifications (tests/fixtures/binaryHeaders.ts), and one real binary of
 * this machine is read too.
 */

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'check-prebuilt.js');

interface Machine { format: 'Mach-O' | 'PE' | 'ELF'; archs: string[] }
interface Host { platform: string; arch: string }
type Resolved = { ok: true; platform: string; arch: string; triple: string; how: string } | { ok: false; reason: string };
type Checked = { ok: true; summary: string } | { ok: false; reason: string };
interface CheckPrebuilt {
  MODULE_FILE: string;
  VERSION_FILE: string;
  machineOf(bytes: Buffer): Machine | null;
  machineOfFile(file: string): Machine | null;
  resolveTarget(spec: string | undefined, host: Host): Resolved;
  checkPrebuilt(opts: { dir: string; platform: string; arch: string; nativeVersion: string; host: Host; packagedFrom?: string }): Checked;
  main(argv: string[], deps: { repo: string; host: Host; out(line: string): void; err(line: string): void }): number;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const check = require(SCRIPT) as CheckPrebuilt;

const NATIVE_VERSION = (JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { nativeVersion: string }).nativeVersion;
const MAC_ARM: Host = { platform: 'darwin', arch: 'arm64' };

/** A prebuilt folder holding `header` as the module and `version` (null: none) as its VERSION. */
function prebuilt(dir: string, header: Buffer | null, version: string | null): string {
  fs.mkdirSync(dir, { recursive: true });
  if (header) fs.writeFileSync(path.join(dir, 'treemap_core.node'), header);
  if (version !== null) fs.writeFileSync(path.join(dir, 'VERSION'), version);
  return dir;
}

/** A repository stand-in: a package.json with `nativeVersion`, and native/prebuilt/<triple>/ for each entry. */
function fakeRepo(modules: Record<string, { header: Buffer; version: string | null }>, nativeVersion = NATIVE_VERSION): string {
  const repo = fileTempDir('treemap-check-prebuilt-');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'treemap', nativeVersion }));
  for (const [triple, m] of Object.entries(modules)) prebuilt(path.join(repo, 'native', 'prebuilt', triple), m.header, m.version);
  return repo;
}

function runMain(argv: string[], repo: string, host: Host = MAC_ARM): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = check.main(argv, { repo, host, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('machineOf reads Mach-O, PE and ELF headers for arm64 and x64, and a truncated PE reads as unknown', () => {
  assert.deepEqual(check.machineOf(machO64(CPU_TYPE_ARM64)), { format: 'Mach-O', archs: ['arm64'] });
  assert.deepEqual(check.machineOf(machO64(CPU_TYPE_X86_64)), { format: 'Mach-O', archs: ['x64'] });
  assert.deepEqual(check.machineOf(fatMachO([CPU_TYPE_X86_64, CPU_TYPE_ARM64])), { format: 'Mach-O', archs: ['x64', 'arm64'] },
    'a universal file holds every slice it lists');
  assert.deepEqual(check.machineOf(pe(IMAGE_FILE_MACHINE_AMD64)), { format: 'PE', archs: ['x64'] });
  assert.deepEqual(check.machineOf(pe(IMAGE_FILE_MACHINE_ARM64)), { format: 'PE', archs: ['arm64'] });
  assert.deepEqual(check.machineOf(pe(IMAGE_FILE_MACHINE_I386)), { format: 'PE', archs: ['ia32'] });
  assert.deepEqual(check.machineOf(pe(IMAGE_FILE_MACHINE_AMD64, 0x100)), { format: 'PE', archs: ['x64'] },
    'the PE header is found where e_lfanew points, not at a fixed offset');
  assert.deepEqual(check.machineOf(elf64(EM_X86_64)), { format: 'ELF', archs: ['x64'] });
  assert.deepEqual(check.machineOf(elf64(EM_AARCH64)), { format: 'ELF', archs: ['arm64'] });
  assert.deepEqual(check.machineOf(elf64(EM_AARCH64, 'be')), { format: 'ELF', archs: ['arm64'] }, 'e_machine is read in the file\'s own byte order');

  assert.equal(check.machineOf(truncatedPe()), null, 'a PE whose header lies past the end of the file is unknown, never a guess');
  const noSignature = pe(IMAGE_FILE_MACHINE_AMD64);
  noSignature.write('XX', 0x80, 'latin1');
  assert.equal(check.machineOf(noSignature), null, 'e_lfanew must lead to "PE\\0\\0"');
  assert.equal(check.machineOf(Buffer.from('#!/bin/sh\necho not a module\n')), null);
  assert.equal(check.machineOf(Buffer.alloc(0)), null);
  assert.equal(check.machineOf(machO64(CPU_TYPE_ARM64).subarray(0, 6)), null, 'a header cut before its cputype is unknown');

  for (const [label, bytes] of [['Mach-O', machO64(CPU_TYPE_POWERPC64)], ['PE', pe(IMAGE_FILE_MACHINE_RISCV64)], ['ELF', elf64(EM_RISCV)]] as const) {
    const m = check.machineOf(bytes);
    assert.ok(m && m.format === label && m.archs.length === 1, `${label}: still read as ${label}`);
    assert.ok(!['x64', 'arm64'].includes(m.archs[0]) && /0x[0-9a-f]+/.test(m.archs[0]), `${label}: an unknown machine is named by its number, never taken for x64 or arm64: ${m.archs[0]}`);
  }
});

test("machineOf reads this machine's own node binary as this platform's format, holding this machine's architecture", () => {
  const expected = { darwin: 'Mach-O', win32: 'PE', linux: 'ELF' }[process.platform as 'darwin' | 'win32' | 'linux'];
  assert.ok(expected, `a platform TreeMap packages: ${process.platform}`);
  const m = check.machineOfFile(process.execPath);
  assert.ok(m, `${process.execPath} is read`);
  assert.equal(m.format, expected);
  assert.ok(m.archs.includes(process.arch), `${process.execPath} holds ${process.arch}: ${m.archs.join(', ')}`);
});

test('machineOf reads the module build-native installed here as this machine\'s, when there is one', (t) => {
  const file = path.join(REPO, 'native', 'prebuilt', `${process.platform}-${process.arch}`, check.MODULE_FILE);
  if (!fs.existsSync(file)) {
    t.skip(`no module at ${file} (npm run build:native installs one)`);
    return;
  }
  const m = check.machineOfFile(file);
  assert.ok(m && m.archs.includes(process.arch), `${file}: ${JSON.stringify(m)}`);
});

test('checkPrebuilt passes the target\'s module with its VERSION, and says what it found', () => {
  const root = fileTempDir('treemap-prebuilt-ok-');
  const cases: [string, string, Buffer][] = [
    ['darwin', 'arm64', machO64(CPU_TYPE_ARM64)],
    ['darwin', 'x64', fatMachO([CPU_TYPE_X86_64, CPU_TYPE_ARM64])],
    ['win32', 'x64', pe(IMAGE_FILE_MACHINE_AMD64)],
    ['linux', 'x64', elf64(EM_X86_64)],
    ['linux', 'arm64', elf64(EM_AARCH64)],
  ];
  for (const [platform, arch, header] of cases) {
    const dir = prebuilt(path.join(root, `${platform}-${arch}`), header, `${NATIVE_VERSION}\n`);
    const r = check.checkPrebuilt({ dir, platform, arch, nativeVersion: NATIVE_VERSION, host: MAC_ARM });
    assert.ok(r.ok, `${platform}-${arch}: ${r.ok ? '' : r.reason}`);
    assert.ok(r.summary.includes(path.join(dir, check.MODULE_FILE)) && r.summary.includes(NATIVE_VERSION) && r.summary.includes(arch),
      `${platform}-${arch}: the summary names the file, the version and the architecture: ${r.summary}`);
  }
});

test('checkPrebuilt fails, with the reason, on a missing module, another architecture, another format, a missing VERSION, or a VERSION other than nativeVersion', () => {
  const root = fileTempDir('treemap-prebuilt-bad-');
  const run = (name: string, header: Buffer | null, version: string | null, platform = 'win32', arch = 'x64') =>
    check.checkPrebuilt({ dir: prebuilt(path.join(root, name), header, version), platform, arch, nativeVersion: NATIVE_VERSION, host: MAC_ARM });
  const fails = (r: Checked, pattern: RegExp, label: string) => {
    assert.equal(r.ok, false, `${label}: refused`);
    if (!r.ok) assert.match(r.reason, pattern, label);
  };

  const missing = run('missing', null, NATIVE_VERSION);
  fails(missing, /does not exist/, 'no module');
  if (!missing.ok) {
    assert.ok(missing.reason.includes(path.join(root, 'missing', check.MODULE_FILE)), `the reason names the path: ${missing.reason}`);
    assert.match(missing.reason, /win32-x64/, 'and the target');
  }
  fails(run('arm-for-x64', pe(IMAGE_FILE_MACHINE_ARM64), NATIVE_VERSION), /arm64.*x64|x64.*arm64/, 'a PE for arm64 where the target is x64');
  fails(run('mac-for-win', machO64(CPU_TYPE_X86_64), NATIVE_VERSION), /Mach-O/, "the Mac's module where Windows' belongs, even of the same architecture");
  fails(run('elf-for-mac', elf64(EM_AARCH64), NATIVE_VERSION, 'darwin', 'arm64'), /ELF/, 'a Linux module where the Mac\'s belongs');
  fails(run('fat-without', fatMachO([CPU_TYPE_X86_64]), NATIVE_VERSION, 'darwin', 'arm64'), /x64/, 'a universal file without the target\'s slice');
  fails(run('unreadable', truncatedPe(), NATIVE_VERSION), /cannot read|not a Mach-O, PE or ELF/, 'a header this check cannot read');
  fails(run('no-version', pe(IMAGE_FILE_MACHINE_AMD64), null), /VERSION/, 'no VERSION beside the module');
  const stale = run('stale', pe(IMAGE_FILE_MACHINE_AMD64), '0.0.1\n');
  fails(stale, /0\.0\.1/, 'a VERSION other than nativeVersion');
  if (!stale.ok) assert.ok(stale.reason.includes(NATIVE_VERSION), `both versions are named: ${stale.reason}`);
  const both = run('both', pe(IMAGE_FILE_MACHINE_ARM64), '0.0.1\n');
  fails(both, /0\.0\.1/, 'every reason is given at once');
  if (!both.ok) assert.match(both.reason, /arm64/, `both reasons: ${both.reason}`);
});

test('checking a packaged copy, a missing module is looked for where it is packaged from — never in the package electron-builder regenerates — and one that is there means the config dropped it', () => {
  // scripts/afterPack.js checks app.asar.unpacked/native/prebuilt/<triple>/
  // inside release/; "put the module there" sent a person into a folder the
  // next build deletes. The package is made from native/prebuilt/<triple>/.
  const root = fileTempDir('treemap-prebuilt-packaged-');
  const packagedOf = (triple: string) => path.join(root, 'release', 'x-unpacked', 'resources', 'app.asar.unpacked', 'native', 'prebuilt', triple);
  const sourceOf = (triple: string) => path.join(root, 'native', 'prebuilt', triple);
  const hintOf = (r: Checked) => {
    assert.equal(r.ok, false, 'refused');
    return r.ok ? '' : r.reason.slice(r.reason.indexOf('does not exist'));
  };
  for (const [platform, arch, host, how] of [['darwin', 'arm64', MAC_ARM, /npm run build:native builds it there/], ['win32', 'x64', MAC_ARM, /CI's release job/]] as const) {
    const triple = `${platform}-${arch}`;
    const r = check.checkPrebuilt({ dir: packagedOf(triple), platform, arch, nativeVersion: NATIVE_VERSION, host, packagedFrom: sourceOf(triple) });
    assert.ok(!r.ok && r.reason.startsWith(path.join(packagedOf(triple), check.MODULE_FILE)), 'the missing packaged file is named first');
    const hint = hintOf(r);
    assert.ok(hint.includes(sourceOf(triple)), `${triple}: the hint names the folder it is packaged from: ${hint}`);
    assert.ok(!hint.includes(path.join(root, 'release')), `${triple}: and never the regenerated package: ${hint}`);
    assert.match(hint, how, `${triple}: and how a module gets there from this machine: ${hint}`);
    assert.doesNotMatch(hint, /build\.files/, `${triple}: the config is not blamed while the source has none: ${hint}`);
  }
  const triple = 'darwin-arm64';
  prebuilt(sourceOf(triple), machO64(CPU_TYPE_ARM64), `${NATIVE_VERSION}\n`);
  const dropped = hintOf(check.checkPrebuilt({ dir: packagedOf(triple), platform: 'darwin', arch: 'arm64', nativeVersion: NATIVE_VERSION, host: MAC_ARM, packagedFrom: sourceOf(triple) }));
  assert.match(dropped, /build\.files or build\.asarUnpack/, `a module in the source but not in the package is a packaging-config drift: ${dropped}`);
  assert.ok(dropped.includes(sourceOf(triple)), dropped);
  assert.doesNotMatch(dropped, /npm run build:native builds/, 'and building it again would not help');
});

test("resolveTarget: a triple is taken as written, a platform alone takes this machine's architecture, and no target is this machine", () => {
  const as = (spec: string | undefined, host: Host) => {
    const r = check.resolveTarget(spec, host);
    return r.ok ? r.triple : `refused: ${r.reason}`;
  };
  assert.equal(as('win32-x64', MAC_ARM), 'win32-x64', "the target's architecture, never this machine's");
  assert.equal(as('darwin-x64', MAC_ARM), 'darwin-x64');
  assert.equal(as('linux', MAC_ARM), 'linux-arm64', 'electron-builder --linux with no architecture flag builds for this machine\'s');
  assert.equal(as('linux', { platform: 'linux', arch: 'x64' }), 'linux-x64');
  assert.equal(as(undefined, { platform: 'win32', arch: 'x64' }), 'win32-x64', 'electron-builder with no platform flag builds for this machine');
  assert.equal(as(undefined, MAC_ARM), 'darwin-arm64');
  for (const spec of ['freebsd-x64', 'darwin-ia32', 'win32-', '-x64', '', 'darwin-arm64-extra', 'mac']) {
    assert.match(as(spec, MAC_ARM), /^refused: /, `${JSON.stringify(spec)} is refused, not guessed`);
  }
  assert.match(as(undefined, { platform: 'freebsd', arch: 'x64' }), /^refused: .*freebsd/, 'a machine TreeMap does not package for is named');
});

test("main: 0 for the target's module at its version and architecture; 1 naming the target and the path otherwise — the target's architecture, never this machine's", () => {
  const good = fakeRepo({ 'win32-x64': { header: pe(IMAGE_FILE_MACHINE_AMD64), version: `${NATIVE_VERSION}\n` } });
  const ok = runMain(['--target', 'win32-x64'], good);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /win32-x64/);
  assert.equal(runMain(['--target=win32-x64'], good).code, 0, '--target=value reads the same');

  const macOnly = fakeRepo({ 'darwin-arm64': { header: machO64(CPU_TYPE_ARM64), version: `${NATIVE_VERSION}\n` } });
  const cross = runMain(['--target', 'win32-x64'], macOnly);
  assert.equal(cross.code, 1, 'a dist for Windows on this Mac fails while only the Mac\'s module is on disk');
  assert.ok(cross.err.includes(path.join(macOnly, 'native', 'prebuilt', 'win32-x64', check.MODULE_FILE)), `names the path it needs: ${cross.err}`);
  assert.match(cross.err, /darwin-arm64/, 'and says this machine is not the target');
  assert.equal(runMain([], macOnly).code, 0, 'no target: this machine, whose module is there');

  const wrongArch = fakeRepo({ 'win32-x64': { header: pe(IMAGE_FILE_MACHINE_ARM64), version: `${NATIVE_VERSION}\n` } });
  assert.equal(runMain(['--target', 'win32-x64'], wrongArch, { platform: 'win32', arch: 'arm64' }).code, 1,
    'an arm64 module for an x64 target fails on an arm64 machine too');
  const stale = fakeRepo({ 'darwin-arm64': { header: machO64(CPU_TYPE_ARM64), version: '0.0.1\n' } });
  assert.equal(runMain(['--target', 'darwin-arm64'], stale).code, 1, 'another VERSION');

  // Every module either reading could fall back to is here, so only a refusal gives 1.
  const both = fakeRepo({
    'win32-x64': { header: pe(IMAGE_FILE_MACHINE_AMD64), version: `${NATIVE_VERSION}\n` },
    'darwin-arm64': { header: machO64(CPU_TYPE_ARM64), version: `${NATIVE_VERSION}\n` },
  });
  assert.equal(runMain([], both).code, 0, 'this machine passes here');
  for (const argv of [['--target'], ['--target', 'beos-x64'], ['--tagret', 'win32-x64'], ['win32-x64'], ['--target', 'win32-x64', '--target', 'darwin-arm64']]) {
    const r = runMain(argv, both);
    assert.equal(r.code, 1, `${argv.join(' ')}: a command line it cannot read fails rather than checking something else`);
    assert.match(r.err, /check-prebuilt/, r.err);
  }
  const noVersion = fakeRepo({ 'win32-x64': { header: pe(IMAGE_FILE_MACHINE_AMD64), version: `${NATIVE_VERSION}\n` } }, '');
  const r = runMain(['--target', 'win32-x64'], noVersion);
  assert.equal(r.code, 1, 'a package.json without nativeVersion can vouch for no module');
  assert.match(r.err, /nativeVersion/);
});

test('run as a program it exits with that code and says why — on stderr when it fails, on stdout when it passes', () => {
  const repo = fakeRepo({});
  fs.mkdirSync(path.join(repo, 'scripts'));
  fs.copyFileSync(SCRIPT, path.join(repo, 'scripts', 'check-prebuilt.js'));
  const run = () => spawnSync(process.execPath, [path.join(repo, 'scripts', 'check-prebuilt.js'), '--target', 'win32-x64'], { cwd: repo, encoding: 'utf8', timeout: HANG_GUARD_MS });

  const before = run();
  assert.equal(before.status, 1, `exit ${before.status}: ${before.stdout}${before.stderr}`);
  assert.ok(before.stderr.includes(path.join('native', 'prebuilt', 'win32-x64', 'treemap_core.node')), before.stderr);
  assert.equal(before.stdout, '', 'nothing on stdout when it fails');

  prebuilt(path.join(repo, 'native', 'prebuilt', 'win32-x64'), pe(IMAGE_FILE_MACHINE_AMD64), `${NATIVE_VERSION}\n`);
  const after = run();
  assert.equal(after.status, 0, `exit ${after.status}: ${after.stdout}${after.stderr}`);
  assert.match(after.stdout, /win32-x64/);
});

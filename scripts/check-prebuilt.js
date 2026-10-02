#!/usr/bin/env node
'use strict';
/*
 * Check that the native module for the target a dist build packages is on
 * disk and is the one the packaged app will load — before electron-builder
 * runs (Track U U-14; owner answer U-Q14: a dist that cannot have the module
 * fails, loudly).
 *
 *   node scripts/check-prebuilt.js --target <platform>-<arch>   that target
 *   node scripts/check-prebuilt.js --target <platform>          that platform, this machine's architecture
 *   node scripts/check-prebuilt.js                              this machine
 *
 * The two short forms are spelled the way electron-builder's own flags are:
 * a call that names no architecture builds for this machine's, and one that
 * names no platform builds for this machine — so each dist script hands this
 * check exactly what its electron-builder call leaves to the machine
 * (tests/packageScripts.test.ts holds the two to one target).
 *
 * It passes only when native/prebuilt/<platform>-<arch>/ holds
 *   - treemap_core.node,
 *   - a VERSION equal to package.json's nativeVersion (the loader,
 *     src/services/scan/native.ts, refuses a module of any other version), and
 *   - a header of that platform's format (Mach-O, PE or ELF) for that
 *     architecture, so a dist for Windows run on a Mac can never package the
 *     Mac's module.
 * Otherwise it exits 1 with every reason on stderr. On success it prints
 * one line on stdout.
 *
 * A module for another OS cannot be built here: it comes from that OS's
 * build (CI's release job builds one on each leg). scripts/afterPack.js holds
 * the packaged copy to the same checks, with the platform and architecture
 * electron-builder actually packaged, on every route into electron-builder.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const MODULE_FILE = 'treemap_core.node';
const VERSION_FILE = 'VERSION';
/** The platforms TreeMap packages, each with the executable format its loader opens. */
const FORMAT_BY_PLATFORM = { darwin: 'Mach-O', win32: 'PE', linux: 'ELF' };
/** The architectures TreeMap packages: the release, fetchGdu.js and DESIGN §14 name no others. */
const ARCHS = ['x64', 'arm64'];
/** Enough of a file for any of the three headers, a universal file's slice list included. */
const HEADER_BYTES = 64 * 1024;

/** <mach/machine.h>: cputype → Node's name for it. */
const MACHO_CPU = { 0x01000007: 'x64', 0x0100000c: 'arm64', 0x00000007: 'ia32', 0x0000000c: 'arm' };
/** PE/COFF Machine → Node's name. */
const PE_MACHINE = { 0x8664: 'x64', 0xaa64: 'arm64', 0x014c: 'ia32', 0x01c4: 'arm' };
/** ELF e_machine → Node's name. */
const ELF_MACHINE = { 62: 'x64', 183: 'arm64', 3: 'ia32', 40: 'arm' };
/** A universal Mach-O lists at most this many slices; more is not a slice list. */
const MAX_FAT_SLICES = 32;

function named(table, value, what) {
  return table[value] ?? `unknown ${what} 0x${(value >>> 0).toString(16)}`;
}

/**
 * The format of an executable header and the architectures it holds, in the
 * names Node gives process.arch — or null when `bytes` is none of the three
 * this check reads, or is cut off before what it needs. A universal Mach-O
 * holds one architecture per slice.
 * @param {Buffer} bytes the start of the file
 * @returns {{ format: 'Mach-O' | 'PE' | 'ELF', archs: string[] } | null}
 */
function machineOf(bytes) {
  if (bytes.length >= 8) {
    const le = bytes.readUInt32LE(0);
    if (le === 0xfeedfacf || le === 0xfeedface) return { format: 'Mach-O', archs: [named(MACHO_CPU, bytes.readUInt32LE(4), 'cputype')] };
    const be = bytes.readUInt32BE(0);
    if (be === 0xcafebabe || be === 0xcafebabf) {
      const count = bytes.readUInt32BE(4);
      const size = be === 0xcafebabe ? 20 : 32;
      if (count === 0 || count > MAX_FAT_SLICES || 8 + count * size > bytes.length) return null;
      const archs = [];
      for (let i = 0; i < count; i++) archs.push(named(MACHO_CPU, bytes.readUInt32BE(8 + i * size), 'cputype'));
      return { format: 'Mach-O', archs };
    }
  }
  if (bytes.length >= 20 && bytes[0] === 0x7f && bytes.toString('latin1', 1, 4) === 'ELF') {
    const machine = bytes[5] === 2 ? bytes.readUInt16BE(18) : bytes.readUInt16LE(18);
    return { format: 'ELF', archs: [named(ELF_MACHINE, machine, 'e_machine')] };
  }
  if (bytes.length >= 0x40 && bytes.toString('latin1', 0, 2) === 'MZ') {
    const at = bytes.readUInt32LE(0x3c);
    if (at + 6 > bytes.length || bytes.toString('latin1', at, at + 4) !== 'PE\0\0') return null;
    return { format: 'PE', archs: [named(PE_MACHINE, bytes.readUInt16LE(at + 4), 'machine')] };
  }
  return null;
}

/** machineOf for the start of `file`. */
function machineOfFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    return machineOf(buffer.subarray(0, fs.readSync(fd, buffer, 0, HEADER_BYTES, 0)));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The target a --target value names, as Node names platforms and
 * architectures: `<platform>-<arch>` as written, `<platform>` with `host`'s
 * architecture, nothing for `host` itself — or the reason it names none
 * TreeMap packages.
 * @returns {{ ok: true, platform: string, arch: string, triple: string, how: string } | { ok: false, reason: string }}
 */
function resolveTarget(spec, host) {
  let platform;
  let arch;
  let how;
  if (spec === undefined) {
    [platform, arch, how] = [host.platform, host.arch, 'this machine'];
  } else {
    const m = /^([a-z0-9]+)(?:-([a-z0-9]+))?$/.exec(spec);
    if (!m) return { ok: false, reason: `"${spec}" is not a target: write <platform>-<arch>, as Node names them (darwin-arm64, win32-x64, linux-x64)` };
    [platform, arch, how] = m[2] === undefined ? [m[1], host.arch, `${m[1]} with this machine's architecture`] : [m[1], m[2], 'as named'];
  }
  if (!(platform in FORMAT_BY_PLATFORM)) {
    return { ok: false, reason: `TreeMap packages for ${Object.keys(FORMAT_BY_PLATFORM).join(', ')}; not ${platform} (${how})` };
  }
  if (!ARCHS.includes(arch)) return { ok: false, reason: `TreeMap packages ${ARCHS.join(' and ')} builds; not ${arch} (${how})` };
  return { ok: true, platform, arch, triple: `${platform}-${arch}`, how };
}

/**
 * Whether `dir` holds the module a `platform`-`arch` app loads: the file, a
 * VERSION equal to `nativeVersion`, and a header of that platform's format
 * holding that architecture. `host` only words the hint for a missing file.
 * @returns {{ ok: true, summary: string } | { ok: false, reason: string }}
 */
function checkPrebuilt({ dir, platform, arch, nativeVersion, host }) {
  const triple = `${platform}-${arch}`;
  const file = path.join(dir, MODULE_FILE);
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    /* reported below */
  }
  if (!stat || !stat.isFile()) {
    const hint =
      triple === `${host.platform}-${host.arch}`
        ? 'npm run build:native builds it on this machine'
        : `this machine is ${host.platform}-${host.arch}, and npm run build:native builds only this machine's module: put the ${triple} module a ${triple} build made (CI's release job builds one) there, with its VERSION`;
    return { ok: false, reason: `${file} does not exist; ${hint}` };
  }

  const reasons = [];
  const machine = machineOfFile(file);
  const format = FORMAT_BY_PLATFORM[platform];
  if (!machine) reasons.push(`${file} is not a Mach-O, PE or ELF file this check can read`);
  else if (machine.format !== format) reasons.push(`${file} is a ${machine.format} file (${machine.archs.join(', ')}), but a ${triple} app loads a ${format} one`);
  else if (!machine.archs.includes(arch)) reasons.push(`${file} is built for ${machine.archs.join(', ')}, but the target is ${arch}`);

  const versionFile = path.join(dir, VERSION_FILE);
  let version = null;
  try {
    version = fs.readFileSync(versionFile, 'utf8').trim();
  } catch {
    reasons.push(`${versionFile} does not exist; build-native writes it beside every module it installs`);
  }
  if (version !== null && version !== nativeVersion) {
    reasons.push(`${versionFile} says ${version || '(nothing)'} but package.json's nativeVersion is ${nativeVersion}, and the app refuses a module of any other version; npm run build:native rebuilds it`);
  }
  if (reasons.length > 0) return { ok: false, reason: reasons.join('; ') };
  return { ok: true, summary: `${file}: native version ${version}, ${machine.format} ${machine.archs.join('+')}` };
}

/**
 * The command line, run against `repo` on `host`; answers the exit code and
 * reports through `out` (success) and `err` (everything else).
 */
function main(argv, { repo = REPO, host = { platform: process.platform, arch: process.arch }, out = console.log, err = console.error } = {}) {
  let spec;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target' && i + 1 < argv.length && spec === undefined) spec = argv[++i];
    else if (arg.startsWith('--target=') && spec === undefined) spec = arg.slice('--target='.length);
    else {
      err(`check-prebuilt: cannot read "${argv.join(' ')}"; usage: node scripts/check-prebuilt.js [--target <platform>[-<arch>]]`);
      return 1;
    }
  }
  const target = resolveTarget(spec, host);
  if (!target.ok) {
    err(`check-prebuilt: ${target.reason}`);
    return 1;
  }
  let nativeVersion;
  try {
    nativeVersion = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).nativeVersion;
  } catch (e) {
    err(`check-prebuilt: could not read package.json's nativeVersion: ${e.message}`);
    return 1;
  }
  if (typeof nativeVersion !== 'string' || nativeVersion === '') {
    err('check-prebuilt: package.json has no "nativeVersion", so no module could pass the loader\'s handshake');
    return 1;
  }
  const dir = path.join(repo, 'native', 'prebuilt', target.triple);
  const result = checkPrebuilt({ dir, platform: target.platform, arch: target.arch, nativeVersion, host });
  if (!result.ok) {
    err(`check-prebuilt: cannot package ${target.triple} (${target.how}): ${result.reason}`);
    return 1;
  }
  out(`check-prebuilt: ${target.triple} (${target.how}) — ${result.summary}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
} else {
  module.exports = { MODULE_FILE, VERSION_FILE, FORMAT_BY_PLATFORM, machineOf, machineOfFile, resolveTarget, checkPrebuilt, main };
}

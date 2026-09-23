import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';

/**
 * What the Windows binaries may import. Rust's MSVC targets link the C
 * runtime dynamically unless told otherwise, so a binary needs
 * VCRUNTIME140.dll — which Windows does not ship. Where it is missing from
 * System32 the loader keeps searching, down the PATH, and an elevated
 * process's PATH includes the user's own entries, which any program running
 * as the user can change: a DLL planted there would run as administrator
 * inside tm-mft-helper.exe (the pre-landing review of 23 Sep 2026). So both
 * binaries link the C runtime statically (native/treemap-core/.cargo/
 * config.toml), and the helper's image tells the loader to take its DLLs
 * from System32 only (its build.rs, `/DEPENDENTLOADFLAG:0x800`).
 */

/** `LOAD_LIBRARY_SEARCH_SYSTEM32`. */
const SYSTEM32_ONLY = 0x800;
/** DLLs of a C runtime a machine may lack, or an API set that forwards to one. */
const C_RUNTIME = /^(vcruntime|msvcp|ucrtbase|api-ms-win-crt-)/i;

/** The DLLs a PE32+ image imports (directly or delay-loaded), lower-cased, and its load config's DependentLoadFlags (null without one that long). */
function peFacts(image: Buffer): { dlls: string[]; dependentLoadFlags: number | null } {
  const u16 = (o: number) => image.readUInt16LE(o);
  const u32 = (o: number) => image.readUInt32LE(o);
  const pe = u32(0x3c);
  assert.equal(image.toString('latin1', pe, pe + 4), 'PE\0\0', 'a PE image');
  const coff = pe + 4;
  const sections = u16(coff + 2);
  const optionalSize = u16(coff + 16);
  const optional = coff + 20;
  assert.equal(u16(optional), 0x20b, 'a PE32+ (64-bit) image');
  const dirs = optional + 112;
  const table = optional + optionalSize;
  const offsetOf = (rva: number): number => {
    for (let s = 0; s < sections; s++) {
      const h = table + s * 40;
      const va = u32(h + 12);
      const size = Math.max(u32(h + 8), u32(h + 16));
      if (rva >= va && rva < va + size) return rva - va + u32(h + 20);
    }
    throw new Error(`RVA ${rva} lies in no section`);
  };
  const name = (o: number) => image.toString('latin1', o, image.indexOf(0, o)).toLowerCase();
  const dlls: string[] = [];
  const imports = u32(dirs + 1 * 8);
  if (imports !== 0) {
    for (let d = offsetOf(imports); u32(d + 12) !== 0; d += 20) dlls.push(name(offsetOf(u32(d + 12))));
  }
  const delayed = u32(dirs + 13 * 8);
  if (delayed !== 0) {
    for (let d = offsetOf(delayed); u32(d + 4) !== 0; d += 32) dlls.push(name(offsetOf(u32(d + 4))));
  }
  const config = u32(dirs + 10 * 8);
  let dependentLoadFlags: number | null = null;
  if (config !== 0) {
    const at = offsetOf(config);
    // IMAGE_LOAD_CONFIG_DIRECTORY64.DependentLoadFlags: a u16 at 78.
    if (u32(at) >= 80) dependentLoadFlags = u16(at + 78);
  }
  return { dlls, dependentLoadFlags };
}

/** A minimal PE32+ image: one section, `dlls` imported, and a load config when `flags` is not null. */
function syntheticImage(dlls: string[], flags: number | null): Buffer {
  const img = Buffer.alloc(0x1000);
  img.writeUInt32LE(0x80, 0x3c);
  img.write('PE\0\0', 0x80, 'latin1');
  const coff = 0x84;
  img.writeUInt16LE(0x8664, coff);
  img.writeUInt16LE(1, coff + 2);
  img.writeUInt16LE(240, coff + 16);
  const optional = coff + 20;
  img.writeUInt16LE(0x20b, optional);
  const dirs = optional + 112;
  const table = optional + 240;
  img.writeUInt32LE(0xc00, table + 8);
  img.writeUInt32LE(0x1000, table + 12);
  img.writeUInt32LE(0xc00, table + 16);
  img.writeUInt32LE(0x400, table + 20);
  const rva = (fileOffset: number) => fileOffset - 0x400 + 0x1000;
  let names = 0x600;
  dlls.forEach((dll, k) => {
    img.writeUInt32LE(rva(names), 0x400 + k * 20 + 12);
    img.write(`${dll}\0`, names, 'latin1');
    names += dll.length + 1;
  });
  img.writeUInt32LE(rva(0x400), dirs + 1 * 8);
  if (flags !== null) {
    img.writeUInt32LE(0x140, 0x800);
    img.writeUInt16LE(flags, 0x800 + 78);
    img.writeUInt32LE(rva(0x800), dirs + 10 * 8);
  }
  return img;
}

test('the PE reader finds every imported DLL and the load flags an image asks for', () => {
  const facts = peFacts(syntheticImage(['KERNEL32.dll', 'VCRUNTIME140.dll', 'api-ms-win-crt-heap-l1-1-0.dll'], SYSTEM32_ONLY));
  assert.deepEqual(facts.dlls, ['kernel32.dll', 'vcruntime140.dll', 'api-ms-win-crt-heap-l1-1-0.dll']);
  assert.equal(facts.dependentLoadFlags, SYSTEM32_ONLY);
  assert.deepEqual(facts.dlls.filter((d) => C_RUNTIME.test(d)), ['vcruntime140.dll', 'api-ms-win-crt-heap-l1-1-0.dll'], 'the rule names both kinds');
  assert.equal(peFacts(syntheticImage(['KERNEL32.dll'], null)).dependentLoadFlags, null, 'no load config, no flags');
});

const prebuilt = path.join(__dirname, '..', 'native', 'prebuilt', `${process.platform}-${process.arch}`);

test('on Windows, neither binary imports a C runtime, and the helper loads its DLLs from System32 only', {
  skip: process.platform !== 'win32' && 'the binaries are Windows images; they are built and read on the Windows CI leg',
}, (t) => {
  const helper = path.join(prebuilt, 'tm-mft-helper.exe');
  const module = path.join(prebuilt, 'treemap_core.node');
  const missing = [helper, module].filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    // CI builds both before the suite (npm run build:native); a skip there
    // would leave the claim unproven, so there it is a failure.
    if (process.env.CI) assert.fail(`not built: ${missing.join(', ')}`);
    t.skip(`not built here: ${missing.join(', ')}; npm run build:native builds them`);
    return;
  }
  for (const file of [helper, module]) {
    const { dlls } = peFacts(fs.readFileSync(file));
    assert.ok(dlls.length > 0, `${file} imports something`);
    assert.deepEqual(dlls.filter((d) => C_RUNTIME.test(d)), [], `${path.basename(file)} imports ${dlls.join(', ')}`);
  }
  assert.equal(peFacts(fs.readFileSync(helper)).dependentLoadFlags, SYSTEM32_ONLY, 'the helper asks for System32 only');
});

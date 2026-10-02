/**
 * Minimal executable headers, written from the three formats' own
 * specifications — never from scripts/check-prebuilt.js, which reads them —
 * so a reader that gets an offset or a constant wrong fails against these
 * rather than agreeing with itself. Only the fields a loader's first glance
 * needs are filled in; the rest is zeros.
 *
 * Mach-O (<mach-o/loader.h>, <mach-o/fat.h>): a thin 64-bit file starts with
 * MH_MAGIC_64 (0xfeedfacf, little-endian on every Mac Apple ships) and its
 * cputype; a universal ("fat") file starts with FAT_MAGIC (0xcafebabe,
 * big-endian), a slice count and one 20-byte fat_arch per slice.
 * PE (Microsoft PE/COFF): "MZ", the new header's offset at 0x3c, then
 * "PE\0\0" and the COFF Machine field, little-endian.
 * ELF (System V gABI): 0x7f "ELF", class, data encoding, and e_machine at
 * offset 18 in the file's own byte order.
 */

/** <mach/machine.h>: CPU_TYPE_X86_64 and CPU_TYPE_ARM64 (CPU_ARCH_ABI64 | the 32-bit type). */
export const CPU_TYPE_X86_64 = 0x01000007;
export const CPU_TYPE_ARM64 = 0x0100000c;
/** A cputype no Mac uses: PowerPC 64. */
export const CPU_TYPE_POWERPC64 = 0x01000012;

/** PE/COFF Machine values. */
export const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
export const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;
export const IMAGE_FILE_MACHINE_I386 = 0x014c;
/** A Machine value TreeMap never packages: RISC-V 64. */
export const IMAGE_FILE_MACHINE_RISCV64 = 0x5064;

/** ELF e_machine values. */
export const EM_X86_64 = 62;
export const EM_AARCH64 = 183;
/** An e_machine TreeMap never packages: RISC-V. */
export const EM_RISCV = 243;

/** A 64-byte thin 64-bit Mach-O header: MH_MAGIC_64, cputype, a zero subtype, MH_DYLIB. */
export function machO64(cputype: number): Buffer {
  const b = Buffer.alloc(64);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeInt32LE(cputype, 4);
  b.writeUInt32LE(6, 12); // filetype MH_DYLIB
  return b;
}

/** A universal Mach-O: FAT_MAGIC, the slice count and one fat_arch per cputype, all big-endian. */
export function fatMachO(cputypes: number[]): Buffer {
  const b = Buffer.alloc(Math.max(64, 8 + 20 * cputypes.length));
  b.writeUInt32BE(0xcafebabe, 0);
  b.writeUInt32BE(cputypes.length, 4);
  cputypes.forEach((cputype, i) => {
    const at = 8 + 20 * i;
    b.writeInt32BE(cputype, at);
    b.writeUInt32BE(0x4000 * (i + 1), at + 8); // offset of the slice
    b.writeUInt32BE(0x1000, at + 12); // its size
    b.writeUInt32BE(14, at + 16); // align 2^14
  });
  return b;
}

/** A 64-byte ELF header: ELFCLASS64, the given byte order, ET_DYN and e_machine. */
export function elf64(machine: number, byteOrder: 'le' | 'be' = 'le'): Buffer {
  const b = Buffer.alloc(64);
  b.set([0x7f, 0x45, 0x4c, 0x46], 0);
  b[4] = 2; // ELFCLASS64
  b[5] = byteOrder === 'le' ? 1 : 2; // ELFDATA2LSB / ELFDATA2MSB
  b[6] = 1; // EV_CURRENT
  if (byteOrder === 'le') {
    b.writeUInt16LE(3, 16); // e_type ET_DYN
    b.writeUInt16LE(machine, 18);
  } else {
    b.writeUInt16BE(3, 16);
    b.writeUInt16BE(machine, 18);
  }
  return b;
}

/** A 0x200-byte PE file: the DOS header, e_lfanew past the DOS stub, "PE\0\0" and the COFF Machine. */
export function pe(machine: number, lfanew = 0x80): Buffer {
  const b = Buffer.alloc(0x200);
  b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(lfanew, 0x3c);
  b.write('PE\0\0', lfanew, 'latin1');
  b.writeUInt16LE(machine, lfanew + 4);
  b.writeUInt16LE(0x2022, lfanew + 22); // Characteristics: executable, large-address-aware, DLL
  return b;
}

/** A PE whose e_lfanew points past the end of the file: the "PE\0\0" header was cut off. */
export function truncatedPe(): Buffer {
  const b = Buffer.alloc(0x40);
  b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(0x80, 0x3c);
  return b;
}

'use strict';
/*
 * What scripts/rust-notices.js reads from the pinned Rust toolchain, all of it
 * offline: the licences of the standard library's own files
 * (share/doc/rust/COPYRIGHT-library.html, "In-tree files"); the notices of the
 * crates.io crates the library is built from ("📦 name-version" blocks in that
 * file and in share/doc/rust/COPYRIGHT.html, which records some the library
 * file leaves out); and which of those crates the installed standard libraries
 * really carry (the /rust/deps/<crate>-<version>/ paths inside their rlibs).
 */
const fs = require('fs');
const path = require('path');

/** The targets TreeMap's binaries are built for (MP §3.5's five); whichever of their standard libraries are installed are read. */
const SHIPPED_TARGETS = ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu'];

/**
 * The crates.io crates each pinned Rust's standard library is built from on
 * those targets, and the platforms whose library uses each. For 1.98.1 they
 * were read from the toolchain's own rlibs for macOS, Windows and Linux (the
 * /rust/deps/<crate>-<version>/ paths in them) and, for adler2 and
 * windows-link, which leave no such path, from its COPYRIGHT files:
 * windows-link has one version there; adler2 has 2.0.0 and 2.0.1, with the
 * same licence files, and miniz_oxide 0.8.9 accepts either, so 2.0.1 is
 * named. A Rust bump needs its own list here: the generator refuses a channel
 * without one, and a list that misses a crate the installed libraries carry.
 */
const STD_CRATES = {
  '1.98.1': [
    { name: 'addr2line', version: '0.25.1', on: 'macOS and Linux' },
    { name: 'adler2', version: '2.0.1', on: 'macOS and Linux' },
    { name: 'cfg-if', version: '1.0.4', on: 'macOS, Windows and Linux' },
    { name: 'gimli', version: '0.32.3', on: 'macOS and Linux' },
    { name: 'hashbrown', version: '0.17.1', on: 'macOS, Windows and Linux' },
    { name: 'libc', version: '0.2.185', on: 'macOS and Linux' },
    { name: 'memchr', version: '2.7.6', on: 'macOS and Linux' },
    { name: 'miniz_oxide', version: '0.8.9', on: 'macOS and Linux' },
    { name: 'object', version: '0.37.3', on: 'macOS and Linux' },
    { name: 'rustc-demangle', version: '0.1.27', on: 'macOS, Windows and Linux' },
    { name: 'windows-link', version: '0.2.1', on: 'Windows' },
  ],
};

/** Libraries in the sysroot that never reach TreeMap's binaries: the test harness and its option parser, the compiler's proc_macro, the profiler runtime. */
const NOT_LINKED_RLIBS = new Set(['test', 'getopts', 'proc_macro', 'rustc_literal_escaper', 'profiler_builtins']);

const RLIB = /^lib(.+)-[0-9a-f]+\.rlib$/;
const DEPS_PATH = /\/rust\/deps[/\\]([A-Za-z0-9_-]+?)-(\d+\.\d+\.\d+)(?=[/\\])/g;

/**
 * The crates.io crates the installed standard libraries of `targets` carry:
 * "<crate> <version>" → the targets whose rlibs name it. `scanned` lists the
 * targets that are installed. A crate that leaves no path in its rlib (one
 * of macros only, say) is not seen, so this checks a list; it cannot make one.
 */
function stdCratesInSysroot(sysroot, targets = SHIPPED_TARGETS) {
  const found = new Map();
  const scanned = [];
  for (const target of targets) {
    const dir = path.join(sysroot, 'lib', 'rustlib', target, 'lib');
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const rlibs = names.filter((n) => RLIB.test(n) && !NOT_LINKED_RLIBS.has(RLIB.exec(n)[1]));
    if (rlibs.length === 0) continue;
    scanned.push(target);
    for (const name of rlibs) {
      const text = fs.readFileSync(path.join(dir, name)).toString('latin1');
      for (const m of text.matchAll(DEPS_PATH)) {
        const key = `${m[1]} ${m[2]}`;
        if (!found.has(key)) found.set(key, new Set());
        found.get(key).add(target);
      }
    }
  }
  return { scanned, found };
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", copy: String.fromCharCode(0xa9) };

/** HTML character references, decoded in one pass; a name it does not know stays as written. */
function decodeEntities(text) {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (dec !== undefined) return String.fromCodePoint(Number(dec));
    if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16));
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const count = (text, re) => (text.match(re) ?? []).length;

/**
 * The "In-tree files" section of a toolchain's COPYRIGHT-library.html: each
 * file or folder of the standard library with its licence and copyright
 * lines, in document order, a nested exception's path spelled out from its
 * parent's. Throws when the section is missing, lists nothing, gives a file no
 * licence, or holds a line this parser cannot read (it counts them first).
 * @returns {{ path: string, licence: string, copyrights: string[] }[]}
 */
function parseStdCopyright(html) {
  const start = html.indexOf('id="in-tree-files"');
  if (start < 0) {
    throw new Error('the toolchain\'s COPYRIGHT-library.html has no "In-tree files" section; its layout has changed, so scripts/rust-notices.js must learn the new one');
  }
  const end = html.indexOf('id="out-of-tree-dependencies"', start);
  const section = html.slice(start, end < 0 ? html.length : end);
  const token = /<div\b[^>]*>|<\/div>|<b>File\/Directory:<\/b>\s*<code>([^<]*)<\/code>|<b>License:<\/b>\s*([^<]*?)\s*<\/p>|<b>Copyright:<\/b>\s*([^<]*?)\s*<\/p>/g;
  const frames = [];
  const files = [];
  const innermost = () => [...frames].reverse().find((f) => f.entry)?.entry ?? null;
  let licences = 0;
  let copyrights = 0;
  for (const m of section.matchAll(token)) {
    const [whole, name, licence, copyright] = m;
    if (whole.startsWith('<div')) {
      frames.push({ entry: null });
    } else if (whole === '</div>') {
      frames.pop();
    } else if (name !== undefined) {
      if (frames.length === 0) frames.push({ entry: null });
      const parent = [...frames].slice(0, -1).reverse().find((f) => f.entry)?.entry ?? null;
      const own = decodeEntities(name.trim());
      const full = !parent || parent.path === '.' || own.startsWith(`${parent.path}/`) ? own : `${parent.path}/${own}`;
      frames[frames.length - 1].entry = { path: full, licence: null, copyrights: [] };
      files.push(frames[frames.length - 1].entry);
    } else {
      const entry = innermost();
      if (!entry) throw new Error('COPYRIGHT-library.html has a licence or copyright line before any file; its layout has changed, so scripts/rust-notices.js must learn the new one');
      if (licence !== undefined) {
        entry.licence = decodeEntities(licence);
        licences += 1;
      } else {
        entry.copyrights.push(decodeEntities(copyright));
        copyrights += 1;
      }
    }
  }
  if (files.length === 0) throw new Error('the "In-tree files" section of COPYRIGHT-library.html lists no file');
  for (const f of files) {
    if (!f.licence) throw new Error(`COPYRIGHT-library.html gives ${f.path} no licence`);
  }
  for (const [what, read, seen] of [['File/Directory', files.length, count(section, /<b>File\/Directory:<\/b>/g)], ['License', licences, count(section, /<b>License:<\/b>/g)], ['Copyright', copyrights, count(section, /<b>Copyright:<\/b>/g)]]) {
    if (read !== seen) throw new Error(`COPYRIGHT-library.html's In-tree files section has ${seen} "${what}:" lines and ${read} could be read; one holds markup scripts/rust-notices.js cannot read`);
  }
  return files;
}

/**
 * What a toolchain's COPYRIGHT files record for one crates.io crate: its
 * licence, its crates.io URL and every notice (file name and text, the text
 * decoded but otherwise as recorded), from the first of `htmls` that has a
 * "📦 <crate>-<version>" block; null when none has. Throws when a block has
 * no licence or a notice this parser cannot read.
 */
function crateRecord(htmls, name, version) {
  const marker = `📦 ${name}-${version}</h3>`;
  for (const html of htmls) {
    const at = html.indexOf(marker);
    if (at < 0) continue;
    const next = html.indexOf('<h3>', at + marker.length);
    const block = html.slice(at, next < 0 ? html.length : next);
    const licence = /<b>License:<\/b>\s*([^<]*?)\s*<\/p>/.exec(block);
    const url = /<b>URL:<\/b>\s*<a href="([^"]*)"/.exec(block);
    const notices = [...block.matchAll(/<summary><code>([^<]*)<\/code><\/summary>\s*<pre>([\s\S]*?)<\/pre>/g)].map((m) => ({
      title: decodeEntities(m[1]),
      text: decodeEntities(m[2]),
    }));
    if (!licence) throw new Error(`the toolchain records ${name} ${version} without a licence`);
    if (notices.length === 0 || notices.length !== count(block, /<summary>/g)) {
      throw new Error(`the toolchain's notices for ${name} ${version} could not all be read (${notices.length} of ${count(block, /<summary>/g)})`);
    }
    return { licence: decodeEntities(licence[1]), url: url ? decodeEntities(url[1]) : null, notices };
  }
  return null;
}

module.exports = { SHIPPED_TARGETS, STD_CRATES, NOT_LINKED_RLIBS, stdCratesInSysroot, decodeEntities, parseStdCopyright, crateRecord };

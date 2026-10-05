'use strict';
/*
 * The build information a Go program records, read for scripts/gdu-notices.js
 * from its bytes alone: offline, with no Go installed, the way the Go
 * toolchain's own debug/buildinfo reads it.
 *
 * Go 1.18 and later lay it out as a 32-byte header — the magic
 * "\xff Go buildinf:", the pointer size, flags — and, when the flags say the
 * strings are inline, two length-prefixed strings after it: the Go version
 * that built the program, and its module list wrapped in two 16-byte
 * sentinels. The module list is the text `go version -m` prints:
 *
 *   path  <main package>
 *   mod   <main module> <version> [<go.sum hash>]
 *   dep   <module> <version> [<go.sum hash>]     one per module linked in
 *   =>    <module> <version> [<go.sum hash>]     replaces the dep above it
 *   build <key>=<value>
 *
 * Every hit of the magic is tried, since the bytes could also turn up in a
 * program's code; the first that reads as a whole wins. The older layout
 * (before Go 1.18) holds pointers into the program's memory, which needs its
 * executable format to follow, so it is named and refused rather than guessed
 * at.
 */

const MAGIC = Buffer.concat([Buffer.from([0xff]), Buffer.from(' Go buildinf:', 'latin1')]);
const HEADER_BYTES = 32;
const FLAG_INLINE_STRINGS = 0x2;
const SENTINEL_START = Buffer.from('3077af0c9274080241e1c107e6d618e6', 'hex');
const SENTINEL_END = Buffer.from('f932433186182072008242104116d8f2', 'hex');
/** Longer than any varint a length here needs; a longer run of continuation bytes is not a length. */
const MAX_VARINT_BYTES = 10;

/** An unsigned varint at `at`: [value, the offset after it], or null when the bytes end or run on. */
function uvarint(bytes, at) {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < MAX_VARINT_BYTES; i += 1) {
    const b = bytes[at + i];
    if (b === undefined) return null;
    value += (b & 0x7f) * scale;
    if (b < 0x80) return [value, at + i + 1];
    scale *= 0x80;
  }
  return null;
}

/** The length-prefixed string at `at`: [bytes, the offset after it], or null when it runs past the end. */
function lengthPrefixed(bytes, at) {
  const length = uvarint(bytes, at);
  if (!length || length[1] + length[0] > bytes.length) return null;
  return [bytes.subarray(length[1], length[1] + length[0]), length[1] + length[0]];
}

/** The two strings after the header at `at`, or a sentence saying why there are none. */
function stringsAt(bytes, at) {
  const flags = bytes[at + MAGIC.length + 1];
  if (flags === undefined) return { why: `the file ends at byte ${at} inside a header` };
  if ((flags & FLAG_INLINE_STRINGS) === 0) {
    return { why: `at byte ${at} it is laid out as Go wrote it before Go 1.18, with pointers into the program's memory, which this reader does not follow` };
  }
  const version = lengthPrefixed(bytes, at + HEADER_BYTES);
  const modinfo = version && lengthPrefixed(bytes, version[1]);
  if (!modinfo) return { why: `at byte ${at} its strings run past the end of the file` };
  const goVersion = version[0].toString('utf8');
  if (!/^(go|devel )\S*/.test(goVersion)) return { why: `at byte ${at} it names no Go version` };
  return { goVersion, modinfo: modinfo[0] };
}

/** The module text between the sentinels; '' when there is none; null when the sentinels are not where they belong. */
function unwrapModinfo(raw) {
  if (raw.length === 0) return '';
  const wrapped = raw.length >= SENTINEL_START.length + SENTINEL_END.length
    && raw.subarray(0, SENTINEL_START.length).equals(SENTINEL_START)
    && raw.subarray(raw.length - SENTINEL_END.length).equals(SENTINEL_END);
  return wrapped ? raw.subarray(SENTINEL_START.length, raw.length - SENTINEL_END.length).toString('utf8') : null;
}

/** A `mod`, `dep` or `=>` line's columns as a module: path, version and (when recorded) its go.sum hash. */
function moduleOf(kind, columns, line) {
  if (columns.length !== 2 && columns.length !== 3) {
    throw new Error(`its build information has a "${kind}" line of ${columns.length} column(s), where Go writes two or three: ${JSON.stringify(line)}`);
  }
  return { path: columns[0], version: columns[1], sum: columns[2] ?? '' };
}

/** The module text, line by line, as Go's runtime/debug.ParseBuildInfo reads it. */
function parseModinfo(text) {
  const info = { path: '', main: null, deps: [], settings: [] };
  let last = null;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const tab = line.indexOf('\t');
    const kind = tab < 0 ? line : line.slice(0, tab);
    const rest = tab < 0 ? '' : line.slice(tab + 1);
    if (kind === 'path') {
      info.path = rest;
    } else if (kind === 'mod') {
      info.main = moduleOf(kind, rest.split('\t'), line);
      last = info.main;
    } else if (kind === 'dep') {
      last = { ...moduleOf(kind, rest.split('\t'), line), replace: null };
      info.deps.push(last);
    } else if (kind === '=>') {
      if (!last) throw new Error(`its build information has a replacement with no module on the line before it: ${JSON.stringify(line)}`);
      last.replace = moduleOf(kind, rest.split('\t'), line);
      last = null;
    } else if (kind === 'build') {
      const eq = rest.indexOf('=');
      info.settings.push(eq < 0 ? { key: rest, value: '' } : { key: rest.slice(0, eq), value: rest.slice(eq + 1) });
    }
  }
  if (!info.main) throw new Error('its build information records no modules (built outside module mode?)');
  return info;
}

/**
 * A Go program's build information: { goVersion, path, main: { path,
 * version, sum }, deps: [{ path, version, sum, replace }], settings: [{ key,
 * value }] }, deps in the order the program records them. Throws a sentence
 * when the bytes hold none it can read.
 */
function readBuildInfo(bytes) {
  const reasons = [];
  for (let at = bytes.indexOf(MAGIC); at !== -1; at = bytes.indexOf(MAGIC, at + 1)) {
    const found = stringsAt(bytes, at);
    if (found.why) {
      reasons.push(found.why);
      continue;
    }
    const text = unwrapModinfo(found.modinfo);
    if (text === null) {
      reasons.push(`at byte ${at} its module list lacks the markers Go puts around it`);
      continue;
    }
    return { goVersion: found.goVersion, ...parseModinfo(text) };
  }
  const why = reasons.length > 0 ? `: ${reasons.join('; ')}` : ' (no "\\xff Go buildinf:" header in it)';
  throw new Error(`there is no Go build information it can read in it${why}`);
}

module.exports = { readBuildInfo };

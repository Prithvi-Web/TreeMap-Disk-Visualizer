'use strict';
/*
 * Ordering and text helpers for scripts/rust-notices.js. Every order here is
 * by code unit, never by the machine's locale, so the notices are the same
 * bytes on every machine.
 */

const WIDTH = 72;
const BOM = String.fromCharCode(0xfeff);

/** Code-unit order: the same on every machine, whatever its locale. */
function byCodeUnits(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Versions compared part by part, numbers as numbers (2.0.9 before 2.0.119). */
function compareVersions(a, b) {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const numeric = /^\d+$/.test(pa[i]) && /^\d+$/.test(pb[i]);
    const order = numeric ? Math.sign(Number(pa[i]) - Number(pb[i])) : byCodeUnits(pa[i], pb[i]);
    if (order !== 0) return order;
  }
  return 0;
}

/** Crates by name, then by version. */
function compareCrates(a, b) {
  return byCodeUnits(a.name, b.name) || compareVersions(a.version, b.version);
}

/** A licence text as it is printed: no BOM, LF line ends, no blank lines around it, one newline at the end; every word as written. */
function normaliseText(text) {
  const raw = String(text);
  const lines = (raw.startsWith(BOM) ? raw.slice(1) : raw).replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** Pieces packed into lines of at most `width` columns, a space between them, each line after `indent`; a piece is never split. */
function pack(pieces, indent = '', width = WIDTH) {
  const lines = [];
  let line = '';
  for (const piece of pieces) {
    if (line !== '' && indent.length + line.length + 1 + piece.length > width) {
      lines.push(indent + line);
      line = piece;
    } else {
      line = line === '' ? piece : `${line} ${piece}`;
    }
  }
  if (line !== '') lines.push(indent + line);
  return lines;
}

/** Prose wrapped at word boundaries. */
function wrap(text, indent = '', width = WIDTH) {
  return pack(text.split(/\s+/).filter(Boolean), indent, width);
}

/** An author as the notices name one: the name, never the e-mail address beside it. */
function authorName(author) {
  return String(author).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = { byCodeUnits, compareVersions, compareCrates, normaliseText, pack, wrap, authorName };

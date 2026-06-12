'use strict';
/*
 * One-time generator for the menu-bar/tray icons (electron/assets/
 * trayTemplate.png and @2x — inside electron/ so they ship in the asar).
 * Hand-encodes the PNG with zlib so the repo needs no image tooling.
 * The glyph is the TreeMap mark — one tall block and two stacked blocks —
 * in pure black + alpha, which macOS expects for "template" images (it
 * recolors them to match the menu bar). Run: node scripts/gen-tray-icon.js
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePng(size, pixels /* Uint8Array RGBA */) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // raw scanlines: filter byte 0 + row data
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0;
    pixels.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Draw the treemap glyph at scale (1 → 16px, 2 → 32px). */
function drawGlyph(scale) {
  const size = 16 * scale;
  const px = Buffer.alloc(size * size * 4);
  const fill = (x0, y0, x1, y1) => {
    for (let y = y0 * scale; y < y1 * scale; y++) {
      for (let x = x0 * scale; x < x1 * scale; x++) {
        const i = (y * size + x) * 4;
        px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 255;
      }
    }
  };
  fill(1, 1, 9, 15);   // tall block, left
  fill(11, 1, 15, 9);  // upper block, right
  fill(11, 11, 15, 15); // lower block, right
  return encodePng(size, px);
}

const outDir = path.join(__dirname, '..', 'electron', 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'trayTemplate.png'), drawGlyph(1));
fs.writeFileSync(path.join(outDir, 'trayTemplate@2x.png'), drawGlyph(2));
console.log('Wrote electron/assets/trayTemplate.png and trayTemplate@2x.png');

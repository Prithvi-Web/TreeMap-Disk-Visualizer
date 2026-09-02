'use strict';
/*
 * Icon generator for the desktop build. Run: node scripts/gen-tray-icon.js
 * (add `--out <dir>` to write somewhere else — the tests do).
 *
 * Writes:
 *  electron/assets/trayTemplate.png, @2x  — the macOS menu-bar glyph: pure
 *    black + alpha, which macOS expects for a "template" image and recolours
 *    to match a light or dark menu bar. Hand-encoded PNG (zlib only).
 *  electron/assets/tray.png, @2x — the Windows/Linux tray glyph. Those trays
 *    never recolour, and a black glyph vanishes on Windows 11's dark taskbar
 *    and GNOME's top bar, so this one is the app's own three tile colours with
 *    a dark 1px edge: the tiles carry it on a dark tray, the edge on a light one.
 *  build/icon.png — the app icon, rasterised from build/icon.svg with sharp
 *    onto a TRANSPARENT canvas on Apple's grid: the 1024px canvas holds an
 *    824px rounded tile with a 100px margin, the same proportions every icon in
 *    the Dock uses, so TreeMap draws at the size of its neighbours and the
 *    corners are see-through instead of a white square. electron-builder makes
 *    icon.icns from it.
 *  build/icon-full.png — the same art full-bleed (no margin): Windows and
 *    Linux icons carry no Apple margin, so package.json's win/linux `icon`
 *    should point here.
 *
 * The glyph is the TreeMap mark — one tall block and two stacked blocks.
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx !== -1 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]) : REPO;

/* ───────────────────────── PNG writer (RGBA, no deps) ───────────────────────── */

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

function encodePng(size, pixels /* Buffer RGBA */) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0; // filter: none
    pixels.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ───────────────────────────── The tray glyph ───────────────────────────── */

/** The three tiles in 16px "logical" coordinates: [x0, y0, x1, y1]. */
const TILES = [
  [1, 1, 9, 15], // tall block, left
  [11, 1, 15, 9], // upper block, right
  [11, 11, 15, 15], // lower block, right
];
/** The tile colours from build/icon.svg. */
const TILE_COLOURS = [
  [0x30, 0xd1, 0x58], // green
  [0xff, 0xd6, 0x0a], // yellow
  [0xff, 0x45, 0x3a], // red
];
/** The dark of the icon's gradient: the edge that holds the shape on a light tray. */
const EDGE = [0x1c, 0x1c, 0x24];
const BLACK = [0, 0, 0];

/**
 * @param scale 1 → 16px, 2 → 32px
 * @param colours null for the template (all black), or per-tile colours + edge
 */
function drawGlyph(scale, colours) {
  const size = 16 * scale;
  const px = Buffer.alloc(size * size * 4);
  const fill = (x0, y0, x1, y1, rgb) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * size + x) * 4;
        px[i] = rgb[0];
        px[i + 1] = rgb[1];
        px[i + 2] = rgb[2];
        px[i + 3] = 255;
      }
    }
  };
  TILES.forEach(([x0, y0, x1, y1], t) => {
    const s = scale;
    if (!colours) {
      fill(x0 * s, y0 * s, x1 * s, y1 * s, BLACK);
      return;
    }
    fill(x0 * s, y0 * s, x1 * s, y1 * s, colours.edge);
    fill(x0 * s + s, y0 * s + s, x1 * s - s, y1 * s - s, colours.tiles[t]);
  });
  return encodePng(size, px);
}

/* ───────────────────────────── The app icon ───────────────────────────── */

/** Apple's icon grid: an 824px tile centred on a 1024px canvas. */
const CANVAS = 1024;
const TILE = 824;

async function renderAppIcons(svgFile, buildDir) {
  let sharp;
  try {
    sharp = require('sharp');
  } catch (err) {
    throw new Error(`sharp is needed to rasterise ${svgFile}: ${err.message}`);
  }
  const svg = fs.readFileSync(svgFile, 'utf8');
  const margin = (CANVAS - TILE) / 2;
  const wrapped = svg
    .replace(/<svg\b[^>]*>/, (open) => `${open}<g transform="translate(${margin} ${margin}) scale(${TILE / CANVAS})">`)
    .replace(/<\/svg>\s*$/, '</g></svg>');
  const render = (source) => sharp(Buffer.from(source)).resize(CANVAS, CANVAS).png();
  await render(wrapped).toFile(path.join(buildDir, 'icon.png'));
  await render(svg).toFile(path.join(buildDir, 'icon-full.png'));
}

/* ───────────────────────────────── Main ───────────────────────────────── */

async function main() {
  const assets = path.join(OUT, 'electron', 'assets');
  const build = path.join(OUT, 'build');
  fs.mkdirSync(assets, { recursive: true });
  fs.mkdirSync(build, { recursive: true });

  fs.writeFileSync(path.join(assets, 'trayTemplate.png'), drawGlyph(1, null));
  fs.writeFileSync(path.join(assets, 'trayTemplate@2x.png'), drawGlyph(2, null));
  const colour = { tiles: TILE_COLOURS, edge: EDGE };
  fs.writeFileSync(path.join(assets, 'tray.png'), drawGlyph(1, colour));
  fs.writeFileSync(path.join(assets, 'tray@2x.png'), drawGlyph(2, colour));
  await renderAppIcons(path.join(REPO, 'build', 'icon.svg'), build);

  console.log(`Wrote tray icons to ${assets} and app icons to ${build}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

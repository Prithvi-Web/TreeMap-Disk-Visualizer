import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lift } from './fixtures/liftFrontend';

/**
 * The GIF encoder (v4 §7.1).
 *
 * The time-lapse export writes a GIF with no dependency: a hand-written LZW
 * encoder over a global palette quantised from the treemap's own colour ramp.
 * §7.1 asks for "its own unit test decoding the output back and comparing
 * frames" — so the decoder below is written from the GIF89a specification
 * independently of the encoder, sharing no helper with it. If the two agree
 * byte-for-byte on every pixel of every frame, the file is a GIF; if the
 * encoder and this decoder ever share a misunderstanding, the browser is the
 * third opinion — the exported file is opened in a real one during the phase's
 * real-app pass.
 *
 * The encoder lives in `public/index.html` as named pure functions, not in
 * `src/utils/` — the export runs in the page (frames come off a canvas), the
 * frontend has no build step to import a `src/` module through, and CI runs
 * the suite without `dist/` existing. A `src/` copy would be a second
 * implementation of the exact kind `liftFrontend.ts` documents as a drift
 * hazard. These tests drive the code that actually ships, lifted whole.
 */

interface GifOpts {
  width: number;
  height: number;
  delayMs: number;
  loop?: number | null;
}

const encodeGif = lift<(frames: Uint8Array[], opts: GifOpts) => Uint8Array>(
  ['encodeGif', 'gifBuildPalette', 'gifIndexFrame', 'gifLzwEncode'],
  'encodeGif',
);

/* ═════════════════ an independent GIF89a reader, for proof ═════════════════ */

interface DecodedGif {
  width: number;
  height: number;
  /** 2^depth palette entries, RGB triples. */
  palette: Array<[number, number, number]>;
  /** Per frame: RGB bytes (3 per pixel) and the GCE delay in centiseconds. */
  frames: Array<{ rgb: Uint8Array; delayCs: number }>;
  /** NETSCAPE2.0 loop count, or null when the extension is absent. */
  loopCount: number | null;
}

function decodeGif(bytes: Uint8Array): DecodedGif {
  let p = 0;
  const u8 = () => bytes[p++];
  const u16 = () => {
    const v = bytes[p] | (bytes[p + 1] << 8);
    p += 2;
    return v;
  };

  const header = String.fromCharCode(...bytes.slice(0, 6));
  assert.equal(header, 'GIF89a', 'file begins with the GIF89a signature');
  p = 6;

  const width = u16();
  const height = u16();
  const packed = u8();
  u8(); // background colour index
  u8(); // pixel aspect ratio
  assert.ok(packed & 0x80, 'a global colour table is present');
  const paletteSize = 2 << (packed & 0x07);
  const palette: Array<[number, number, number]> = [];
  for (let i = 0; i < paletteSize; i++) {
    palette.push([u8(), u8(), u8()]);
  }

  const frames: Array<{ rgb: Uint8Array; delayCs: number }> = [];
  let loopCount: number | null = null;
  let pendingDelayCs = 0;

  for (;;) {
    const block = u8();
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      const label = u8();
      if (label === 0xf9) {
        const size = u8();
        assert.equal(size, 4, 'graphic control extension is 4 bytes');
        u8(); // packed — this decoder does not use disposal
        pendingDelayCs = u16();
        u8(); // transparent index
        assert.equal(u8(), 0, 'graphic control extension terminates');
      } else if (label === 0xff) {
        const size = u8();
        const app = String.fromCharCode(...bytes.slice(p, p + size));
        p += size;
        if (app === 'NETSCAPE2.0') {
          assert.equal(u8(), 3, 'looping sub-block is 3 bytes');
          assert.equal(u8(), 1, 'looping sub-block id is 1');
          loopCount = u16();
          assert.equal(u8(), 0, 'application extension terminates');
        } else {
          for (let s = u8(); s !== 0; s = u8()) p += s;
        }
      } else {
        for (let s = u8(); s !== 0; s = u8()) p += s;
      }
      continue;
    }
    assert.equal(block, 0x2c, `block introducer 0x${block.toString(16)} is an image descriptor`);
    assert.equal(u16(), 0, 'image left is 0');
    assert.equal(u16(), 0, 'image top is 0');
    const iw = u16();
    const ih = u16();
    assert.equal(iw, width, 'frame spans the full width');
    assert.equal(ih, height, 'frame spans the full height');
    assert.equal(u8(), 0, 'no local colour table, no interlace');

    const minCodeSize = u8();
    const data: number[] = [];
    for (let s = u8(); s !== 0; s = u8()) {
      for (let i = 0; i < s; i++) data.push(u8());
    }

    const indices = lzwDecode(data, minCodeSize, iw * ih);
    const rgb = new Uint8Array(iw * ih * 3);
    for (let i = 0; i < indices.length; i++) {
      const entry = palette[indices[i]];
      assert.ok(entry, `pixel index ${indices[i]} is inside the palette`);
      rgb[i * 3] = entry[0];
      rgb[i * 3 + 1] = entry[1];
      rgb[i * 3 + 2] = entry[2];
    }
    frames.push({ rgb, delayCs: pendingDelayCs });
  }

  return { width, height, palette, frames, loopCount };
}

/** Canonical GIF-variant LZW decode, written against the spec, not the encoder. */
function lzwDecode(data: number[], minCodeSize: number, pixelCount: number): number[] {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    codeSize = minCodeSize + 1;
    next = eoi + 1;
  };
  reset();

  const out: number[] = [];
  let bitPos = 0;
  let prev: number[] | null = null;

  const readCode = (): number => {
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const byte = data[bitPos >> 3];
      assert.notEqual(byte, undefined, 'LZW stream does not run out before EOI');
      code |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return code;
  };

  for (;;) {
    const code = readCode();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry: number[];
    if (code < next && dict[code]) {
      entry = dict[code];
    } else if (code === next && prev) {
      entry = [...prev, prev[0]];
    } else {
      assert.fail(`LZW code ${code} is neither known nor the KwKwK case`);
    }
    out.push(...entry);
    if (prev) {
      if (next < 4096) {
        dict[next++] = [...prev, entry[0]];
        if (next === 1 << codeSize && codeSize < 12) codeSize++;
      }
    }
    prev = entry;
    if (out.length >= pixelCount) break;
  }
  assert.equal(out.length, pixelCount, 'LZW stream decodes to exactly one pixel per cell');
  return out;
}

/* ═══════════════════════════════ fixtures ═══════════════════════════════ */

/** A small ramp in the spirit of the treemap's own — a known, small set. */
const RAMP: Array<[number, number, number]> = [
  [30, 30, 46],
  [137, 180, 250],
  [243, 139, 168],
  [166, 227, 161],
  [249, 226, 175],
];

function flatFrame(w: number, h: number, colour: [number, number, number]): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = colour[0];
    data[i * 4 + 1] = colour[1];
    data[i * 4 + 2] = colour[2];
    data[i * 4 + 3] = 255;
  }
  return data;
}

function stripedFrame(w: number, h: number, stripe: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = RAMP[(Math.floor(x / stripe) + y) % RAMP.length];
      const i = (y * w + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return data;
}

function framePixels(frame: Uint8Array): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < frame.length; i += 4) {
    out.push([frame[i], frame[i + 1], frame[i + 2]]);
  }
  return out;
}

/* ══════════════════════════════ round trip ══════════════════════════════ */

test('three frames round-trip through decode pixel-for-pixel', () => {
  const w = 40;
  const h = 30;
  const frames = [flatFrame(w, h, RAMP[0]), stripedFrame(w, h, 4), stripedFrame(w, h, 7)];
  const gif = encodeGif(frames, { width: w, height: h, delayMs: 120 });
  const decoded = decodeGif(gif);

  assert.equal(decoded.width, w);
  assert.equal(decoded.height, h);
  assert.equal(decoded.frames.length, 3, 'every frame survives');

  for (let f = 0; f < frames.length; f++) {
    const original = framePixels(frames[f]);
    const got = decoded.frames[f].rgb;
    for (let i = 0; i < original.length; i++) {
      assert.deepEqual(
        [got[i * 3], got[i * 3 + 1], got[i * 3 + 2]],
        original[i],
        `frame ${f}, pixel ${i} survives the round trip exactly`,
      );
    }
  }
});

test('the delay is carried in centiseconds, rounded, on every frame', () => {
  const gif = encodeGif([flatFrame(8, 8, RAMP[1]), flatFrame(8, 8, RAMP[2])], {
    width: 8,
    height: 8,
    delayMs: 125,
  });
  const decoded = decodeGif(gif);
  for (const frame of decoded.frames) {
    assert.equal(frame.delayCs, 13, '125 ms rounds to 13 centiseconds');
  }
});

/* ══════════════════════════════ the palette ══════════════════════════════ */

test('the palette holds exactly the colours the frames use, padded to a power of two', () => {
  const frames = [stripedFrame(20, 20, 3)];
  const decoded = decodeGif(encodeGif(frames, { width: 20, height: 20, delayMs: 100 }));

  assert.equal(decoded.palette.length, 8, 'five colours pad to the next power of two');
  for (const colour of RAMP) {
    assert.ok(
      decoded.palette.some((p) => p[0] === colour[0] && p[1] === colour[1] && p[2] === colour[2]),
      `ramp colour ${colour.join(',')} appears in the global palette verbatim`,
    );
  }
});

test('more than 256 colours quantise to the nearest palette entry, never further', () => {
  // 300 distinct colours: anti-aliased edges produce exactly this shape of input.
  const w = 30;
  const h = 10;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = (i * 7) % 256;
    data[i * 4 + 1] = (i * 13) % 256;
    data[i * 4 + 2] = (i * 29) % 256;
    data[i * 4 + 3] = 255;
  }
  const decoded = decodeGif(encodeGif([data], { width: w, height: h, delayMs: 50 }));
  assert.ok(decoded.palette.length <= 256, 'the global palette never exceeds 256 entries');

  const dist = (a: [number, number, number], b: [number, number, number]) =>
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const original = framePixels(data);
  const got = decoded.frames[0].rgb;
  for (let i = 0; i < original.length; i++) {
    const chosen: [number, number, number] = [got[i * 3], got[i * 3 + 1], got[i * 3 + 2]];
    const best = Math.min(...decoded.palette.map((entry) => dist(entry, original[i])));
    assert.equal(
      dist(chosen, original[i]),
      best,
      `pixel ${i} maps to the nearest palette entry, not merely a near one`,
    );
  }
});

/* ═══════════════════════════════ edge cases ═══════════════════════════════ */

test('a single frame is a complete, decodable GIF', () => {
  const decoded = decodeGif(
    encodeGif([flatFrame(5, 3, RAMP[3])], { width: 5, height: 3, delayMs: 100 }),
  );
  assert.equal(decoded.frames.length, 1);
  assert.equal(decoded.frames[0].rgb[0], RAMP[3][0]);
});

test('a frame large enough to fill the LZW dictionary still decodes exactly', () => {
  // Seeded noise over 64 colours: the dictionary passes 4096 entries, so the
  // encoder must emit a clear code and reset mid-frame. This is the code path
  // a flat-colour fixture never reaches.
  const w = 200;
  const h = 200;
  let seed = 0x2f6e2b1;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  const palette: Array<[number, number, number]> = [];
  for (let i = 0; i < 64; i++) palette.push([(i * 4) % 256, (i * 11) % 256, (i * 23) % 256]);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = palette[rand() % 64];
    data[i * 4] = c[0];
    data[i * 4 + 1] = c[1];
    data[i * 4 + 2] = c[2];
    data[i * 4 + 3] = 255;
  }
  const decoded = decodeGif(encodeGif([data], { width: w, height: h, delayMs: 40 }));
  const original = framePixels(data);
  const got = decoded.frames[0].rgb;
  for (let i = 0; i < original.length; i++) {
    assert.equal(got[i * 3], original[i][0], `pixel ${i} red survives a dictionary reset`);
    assert.equal(got[i * 3 + 1], original[i][1], `pixel ${i} green survives a dictionary reset`);
    assert.equal(got[i * 3 + 2], original[i][2], `pixel ${i} blue survives a dictionary reset`);
  }
});

/* ═══════════════════════════ looping and honesty ═══════════════════════════ */

test('loop: 0 writes the NETSCAPE2.0 extension meaning "forever"', () => {
  const decoded = decodeGif(
    encodeGif([flatFrame(4, 4, RAMP[0])], { width: 4, height: 4, delayMs: 100, loop: 0 }),
  );
  assert.equal(decoded.loopCount, 0);
});

test('with loop unset there is no looping extension — the GIF plays once', () => {
  const decoded = decodeGif(
    encodeGif([flatFrame(4, 4, RAMP[0])], { width: 4, height: 4, delayMs: 100 }),
  );
  assert.equal(decoded.loopCount, null);
});

test('the same input produces the same bytes — the encoder is deterministic', () => {
  const frames = [stripedFrame(16, 12, 2), flatFrame(16, 12, RAMP[4])];
  const a = encodeGif(frames, { width: 16, height: 12, delayMs: 80, loop: 0 });
  const b = encodeGif(frames, { width: 16, height: 12, delayMs: 80, loop: 0 });
  assert.deepEqual(Array.from(a), Array.from(b));
});

test('a frame whose buffer does not match the declared size is refused, naming the frame', () => {
  assert.throws(
    () => encodeGif([new Uint8Array(10)], { width: 8, height: 8, delayMs: 100 }),
    /frame 0/,
  );
});

test('encoding zero frames is refused rather than producing an empty file', () => {
  assert.throws(() => encodeGif([], { width: 8, height: 8, delayMs: 100 }), /frame/i);
});

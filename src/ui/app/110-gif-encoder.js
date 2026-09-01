/* ───────────────── v4 §7.1 — GIF encoder (time-lapse export) ─────────────────
   A GIF89a writer with a hand-written LZW compressor, kept to pure functions
   over byte arrays so tests/gifEncoder.test.ts can lift them whole and decode
   the output back with an independent reader. Nothing here touches the DOM:
   the export path renders frames to an offscreen canvas elsewhere and hands
   the raw RGBA buffers in. The same property is what lets the encoding run
   off the main thread — the worker is built from these functions' own source
   (Function.prototype.toString into a Blob), so there is exactly one
   implementation and no build step, which the frontend does not have.

   The palette is global and exact for the common case: a treemap frame uses
   the colour ramp plus a background, well under 256 colours. Anti-aliased
   edges can push past 256, in which case the 256 most frequent colours are
   kept and every other pixel maps to the nearest survivor — quantisation in
   the small, honest sense: the ramp itself always survives verbatim.        */

/**
 * Count exact colours across all frames and build the global colour table.
 * Returns { rgb, depth, map, size }: `rgb` is the table padded to 2^depth
 * entries, `map` resolves an (r<<16|g<<8|b) key to its index.
 */
function gifBuildPalette(frames) {
  const counts = new Map();
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i += 4) {
      const key = (frame[i] << 16) | (frame[i + 1] << 8) | frame[i + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  let colours = [...counts.keys()];
  if (colours.length > 256) {
    // Most frequent first; ties break on the colour value so the table is
    // deterministic for identical input.
    colours = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, 256)
      .map((entry) => entry[0]);
  }
  let depth = 1;
  while ((1 << depth) < colours.length) depth++;
  const rgb = new Uint8Array(3 * (1 << depth));
  const map = new Map();
  for (let i = 0; i < colours.length; i++) {
    const key = colours[i];
    rgb[i * 3] = (key >> 16) & 255;
    rgb[i * 3 + 1] = (key >> 8) & 255;
    rgb[i * 3 + 2] = key & 255;
    map.set(key, i);
  }
  return { rgb, depth, map, size: colours.length };
}

/**
 * Map one RGBA frame to palette indices. Colours evicted from an over-full
 * table resolve to the nearest surviving entry by squared RGB distance; each
 * distinct colour is resolved once and cached back into the palette map.
 */
function gifIndexFrame(frame, palette) {
  const out = new Uint8Array(frame.length / 4);
  for (let i = 0, p = 0; i < frame.length; i += 4, p++) {
    const key = (frame[i] << 16) | (frame[i + 1] << 8) | frame[i + 2];
    let idx = palette.map.get(key);
    if (idx === undefined) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < palette.size; c++) {
        const dr = frame[i] - palette.rgb[c * 3];
        const dg = frame[i + 1] - palette.rgb[c * 3 + 1];
        const db = frame[i + 2] - palette.rgb[c * 3 + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = c; }
      }
      idx = best;
      palette.map.set(key, idx);
    }
    out[p] = idx;
  }
  return out;
}

/**
 * GIF-variant LZW: variable code widths from minCodeSize+1 up to 12 bits,
 * LSB-first bit packing, a clear code emitted first and again whenever the
 * dictionary fills at 4096 entries. Returns the raw compressed bytes; the
 * caller cuts them into 255-byte sub-blocks.
 */
function gifLzwEncode(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let clearPending = false;
  let dict = new Map();
  const bytes = [];
  let acc = 0;
  let accBits = 0;
  const emit = (code) => {
    acc |= code << accBits;
    accBits += codeSize;
    while (accBits >= 8) {
      bytes.push(acc & 255);
      acc >>= 8;
      accBits -= 8;
    }
    // The width changes after the code is written, so encoder and decoder
    // agree on the width of every code including this one.
    if (clearPending) {
      codeSize = minCodeSize + 1;
      clearPending = false;
    } else if (next > (1 << codeSize) - 1 && codeSize < 12) {
      codeSize++;
    }
  };

  emit(clear);
  let current = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (current << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      current = hit;
      continue;
    }
    emit(current);
    if (next < 4096) {
      dict.set(key, next++);
    } else {
      dict = new Map();
      next = eoi + 1;
      clearPending = true;
      emit(clear);
    }
    current = k;
  }
  emit(current);
  emit(eoi);
  if (accBits > 0) bytes.push(acc & 255);
  return bytes;
}

/**
 * Assemble a complete GIF89a file from RGBA frames.
 *
 * opts: { width, height, delayMs, loop, onFrame }. `loop` unset means play
 * once (no NETSCAPE extension); 0 means loop forever. `onFrame(done, total)`
 * is called after each frame is compressed so a worker can report progress.
 */
function encodeGif(frames, opts) {
  if (!frames || !frames.length) throw new Error('encodeGif needs at least one frame');
  const width = opts.width;
  const height = opts.height;
  const bytesPerFrame = width * height * 4;
  for (let i = 0; i < frames.length; i++) {
    if (!frames[i] || frames[i].length !== bytesPerFrame) {
      throw new Error(
        `frame ${i} holds ${frames[i] ? frames[i].length : 0} bytes; ` +
        `${width}×${height} needs ${bytesPerFrame}`,
      );
    }
  }
  const palette = gifBuildPalette(frames);
  const minCodeSize = Math.max(2, palette.depth);
  const delayCs = Math.max(0, Math.round(opts.delayMs / 10));

  const out = [];
  const u16 = (v) => { out.push(v & 255, (v >> 8) & 255); };
  for (let i = 0; i < 6; i++) out.push('GIF89a'.charCodeAt(i));
  u16(width);
  u16(height);
  out.push(0xf0 | (palette.depth - 1), 0, 0);
  for (let i = 0; i < palette.rgb.length; i++) out.push(palette.rgb[i]);
  if (opts.loop !== undefined && opts.loop !== null) {
    out.push(0x21, 0xff, 11);
    for (let i = 0; i < 11; i++) out.push('NETSCAPE2.0'.charCodeAt(i));
    out.push(3, 1);
    u16(opts.loop);
    out.push(0);
  }
  for (let f = 0; f < frames.length; f++) {
    out.push(0x21, 0xf9, 4, 0x04);
    u16(delayCs);
    out.push(0, 0);
    out.push(0x2c);
    u16(0);
    u16(0);
    u16(width);
    u16(height);
    out.push(0);
    out.push(minCodeSize);
    const data = gifLzwEncode(gifIndexFrame(frames[f], palette), minCodeSize);
    for (let i = 0; i < data.length; i += 255) {
      const n = Math.min(255, data.length - i);
      out.push(n);
      for (let j = 0; j < n; j++) out.push(data[i + j]);
    }
    out.push(0);
    if (opts.onFrame) opts.onFrame(f + 1, frames.length);
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}

/**
 * The bench harness's one source of determinism.
 *
 * Every corpus, size, role and pixel is drawn from `mulberry32(seed)`, and
 * anything that must be reproducible from two numbers (a file's bytes from its
 * content id and size) seeds a stream with `hash32`. Nothing in `bench/` may
 * call `Math.random`: a corpus that differs between two runs makes every
 * comparison between them meaningless.
 */

const TWO_POW_32 = 4294967296;

/** A 32-bit generator returning floats in [0, 1); the same seed gives the same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / TWO_POW_32;
  };
}

/** Mixes two 32-bit inputs into one unsigned 32-bit hash; order matters. */
export function hash32(a: number, b: number): number {
  let h = (a >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = (h ^ (b >>> 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** One draw of `rng` as a uint32: the harness's byte-stream and id source. */
export function nextUint32(rng: () => number): number {
  return (rng() * TWO_POW_32) >>> 0;
}

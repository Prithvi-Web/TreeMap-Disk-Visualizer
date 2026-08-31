import { ScanStore } from './scanStore';
import { DHash, IMAGE_EXT, detectDecoder, hamming, hashImage, loadSharp } from './perceptualDupes';

/**
 * dupeViewer — the facts behind the Duplicates view's side-by-side panel
 * (§8.2). Given 2–8 files that a duplicate/near-duplicate group put next to
 * each other, this answers: what is each file (from the SCANNED tree, so the
 * numbers match everything else on screen), what can the images tell us
 * (dimensions, EXIF capture date), how do they differ perceptually (dHash
 * regions + Hamming distance, in plain terms), and which one to keep — with
 * the rule that picked it stated outright.
 *
 * Two disciplines govern every field:
 *
 *  - **One fingerprint implementation.** The dHash comes from the exact
 *    functions perceptualDupes uses — imported, never copied — so the viewer
 *    can never disagree with the clustering that put the files here.
 *  - **Absent facts are null WITH a reason.** No sharp → "image decoding
 *    unavailable". No EXIF → "no capture date recorded". A text file → "not
 *    an image". Nothing is ever guessed, least of all a date.
 */

/** An older file must beat the newest by MORE than this to unseat it. */
const MEANINGFULLY_LARGER = 1.1;

export interface KeepRecommendation {
  /** Index into the caller's file array. */
  index: number;
  /** Which rule fired, in plain terms. */
  reason: string;
}

/**
 * Which copy to keep, from metadata alone (pure, so the rule is testable in
 * both directions): prefer the newest, unless an older file is meaningfully
 * larger — more than 10% more bytes, the signature of a larger original next
 * to a smaller re-encode. The reason always names the rule that fired.
 */
export function recommendKeep(files: { size: number; modifiedAt: number }[]): KeepRecommendation {
  // Newest, ties broken toward the larger copy, then toward the earlier index.
  let newest = 0;
  for (let i = 1; i < files.length; i++) {
    const f = files[i]!;
    const n = files[newest]!;
    if (f.modifiedAt > n.modifiedAt || (f.modifiedAt === n.modifiedAt && f.size > n.size)) newest = i;
  }
  // Largest, ties broken toward the newer copy, then toward the earlier index.
  let largest = 0;
  for (let i = 1; i < files.length; i++) {
    const f = files[i]!;
    const l = files[largest]!;
    if (f.size > l.size || (f.size === l.size && f.modifiedAt > l.modifiedAt)) largest = i;
  }

  const n = files[newest]!;
  const l = files[largest]!;

  if (files.every((f) => f.size === n.size && f.modifiedAt === n.modifiedAt)) {
    return { index: 0, reason: 'These copies are the same age and size — keeping the first; any of them would do.' };
  }

  if (largest !== newest && l.size > n.size * MEANINGFULLY_LARGER) {
    // The size rule: a bigger, older file is usually the original.
    if (n.size === 0) {
      return { index: largest, reason: 'Keep the largest copy: the newest one is empty (0 bytes).' };
    }
    const pct = Math.round((l.size / n.size - 1) * 100);
    return {
      index: largest,
      reason: `Keep the largest copy: it is ${pct}% larger than the newest — a bigger, older file is usually the original, and the newer one a re-encode.`,
    };
  }

  if (l.size > n.size) {
    const pct = Math.round((l.size / n.size - 1) * 100);
    return {
      index: newest,
      reason: `Keep the newest copy — an older file is ${pct}% larger, but that is under the 10% margin that would suggest a larger original.`,
    };
  }
  return { index: newest, reason: 'Keep the newest copy — it is also the largest.' };
}

/**
 * The 0–63 bit indices where two dHashes disagree. Bit i = row ⌊i/8⌋,
 * col i%8 of the 8×8 comparison grid — the frontend highlights exactly
 * these regions. Always `hamming(a, b)` entries long, ascending.
 */
export function diffBlocks(a: DHash, b: DHash): number[] {
  const out: number[] = [];
  const xlo = (a[1] ^ b[1]) >>> 0;
  const xhi = (a[0] ^ b[0]) >>> 0;
  for (let i = 0; i < 32; i++) if ((xlo >>> i) & 1) out.push(i);
  for (let i = 0; i < 32; i++) if ((xhi >>> i) & 1) out.push(32 + i);
  return out;
}

/** The Hamming distance in plain terms, built server-side so every client says the same thing. */
export function diffSummary(distance: number): string {
  if (distance === 0) {
    return 'identical perceptual fingerprint — any byte difference is encoding or metadata, not the picture';
  }
  if (distance <= 8) return `differs in ${distance} of 64 blocks — likely a re-encode of the same image`;
  if (distance <= 16) return `differs in ${distance} of 64 blocks — similar images, likely an edit or crop`;
  return `differs in ${distance} of 64 blocks — noticeably different images`;
}

/**
 * DateTimeOriginal (EXIF tag 0x9003) from a raw EXIF payload, or null.
 *
 * A minimal, honest TIFF walk — byte order, IFD0, the Exif-IFD pointer
 * (0x8769), then the one ASCII tag — rather than a heuristic string scan,
 * which could hand back ModifyDate and call it a capture date. Anything
 * malformed, missing, or blank (cameras write all-spaces when the clock was
 * never set) is null; the format returned is "YYYY-MM-DDTHH:MM:SS" with no
 * timezone, because EXIF records local wall-clock time and claiming more
 * would be an invention.
 */
export function parseExifCaptureDate(exif: Buffer): string | null {
  try {
    let tiff = 0;
    if (exif.length >= 6 && exif.toString('latin1', 0, 4) === 'Exif') tiff = 6;
    if (exif.length < tiff + 8) return null;
    const order = exif.toString('latin1', tiff, tiff + 2);
    const le = order === 'II';
    if (!le && order !== 'MM') return null;
    const u16 = (o: number): number => (le ? exif.readUInt16LE(o) : exif.readUInt16BE(o));
    const u32 = (o: number): number => (le ? exif.readUInt32LE(o) : exif.readUInt32BE(o));
    if (u16(tiff + 2) !== 42) return null;

    /** First entry with `tag` in the IFD at tiff-relative `rel`, or null. */
    const findTag = (rel: number, tag: number): { type: number; count: number; valueOff: number } | null => {
      const ifd = tiff + rel;
      if (ifd + 2 > exif.length) return null;
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > exif.length) return null;
        if (u16(e) === tag) return { type: u16(e + 2), count: u32(e + 4), valueOff: e + 8 };
      }
      return null;
    };

    const exifPtr = findTag(u32(tiff + 4), 0x8769);
    if (!exifPtr || exifPtr.type !== 4) return null;
    const dto = findTag(u32(exifPtr.valueOff), 0x9003);
    // ASCII ("2020:01:02 03:04:05" + NUL = 20 bytes); >4 bytes always rides
    // behind an offset rather than inline in the value field.
    if (!dto || dto.type !== 2 || dto.count <= 4) return null;
    const strOff = tiff + u32(dto.valueOff);
    if (strOff + dto.count > exif.length) return null;
    const raw = exif.toString('latin1', strOff, strOff + dto.count).replace(/\0+$/, '').trim();
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
    if (!m) return null;
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  } catch {
    return null;
  }
}

/* ─────────────────────────── the assembled answer ─────────────────────────── */

export interface DupeVisualDiff {
  /** dHash bits that differ vs the reference file (0–64). */
  hammingDistance: number;
  /** The differing bit indices, 0–63: row ⌊i/8⌋, col i%8 of the 8×8 grid. */
  differingBlocks: number[];
  /** The distance in plain terms, e.g. "differs in 4 of 64 blocks — …". */
  summary: string;
}

export interface DupeDetailFile {
  name: string;
  path: string;
  /** Bytes, from the scanned tree — the same number the treemap shows. */
  size: number;
  /** Unix epoch ms, from the scanned tree. */
  modifiedAt: number;
  /** Newest / largest of THIS group (ties can mark more than one). */
  newest: boolean;
  largest: boolean;
  isImage: boolean;
  width: number | null;
  height: number | null;
  dimensionsReason: string | null;
  /** "YYYY-MM-DDTHH:MM:SS" (EXIF local wall-clock, no timezone), or null. */
  captureDate: string | null;
  captureDateReason: string | null;
  visualDiff: DupeVisualDiff | null;
  visualDiffReason: string | null;
}

export interface DupeDetailResponse {
  scanId: string;
  files: DupeDetailFile[];
  recommendedKeep: KeepRecommendation;
  /** Index of the file the dHash diffs are measured against — the recommended
   * keep, when it could be fingerprinted; null when nothing could. */
  diffReference: number | null;
}

const REASON_NOT_IMAGE = 'not an image';
const REASON_NO_DECODER = 'image decoding unavailable';
const REASON_UNDECODABLE = 'image could not be decoded';
const REASON_NO_EXIF = 'no capture date recorded';
const REASON_IS_REFERENCE = 'this file is the comparison reference';
const REASON_NO_REFERENCE = 'the recommended file could not be fingerprinted, so there is no comparison';

/**
 * Everything the side-by-side panel shows, for `ids` (already resolved file
 * nodes of `store`, in the caller's order). Tree facts are exact; image facts
 * are best-effort and say so when they cannot be read.
 */
export async function buildDuplicateDetail(scanId: string, store: ScanStore, ids: number[]): Promise<DupeDetailResponse> {
  const meta = ids.map((id) => ({
    name: store.name(id),
    path: store.path(id),
    size: store.size(id),
    modifiedAt: store.modifiedAt(id),
    ext: store.extension(id),
  }));
  const recommendedKeep = recommendKeep(meta);
  const maxMtime = Math.max(...meta.map((f) => f.modifiedAt));
  const maxSize = Math.max(...meta.map((f) => f.size));

  const sharp = loadSharp();
  const decoder = await detectDecoder();

  interface ImageFacts {
    width: number | null;
    height: number | null;
    dimensionsReason: string | null;
    captureDate: string | null;
    captureDateReason: string | null;
    hash: DHash | null;
    /** Why there is no hash, when there is none. */
    hashReason: string | null;
  }

  const facts: ImageFacts[] = await Promise.all(
    meta.map(async (f): Promise<ImageFacts> => {
      const none = (reason: string): ImageFacts => ({
        width: null, height: null, dimensionsReason: reason,
        captureDate: null, captureDateReason: reason,
        hash: null, hashReason: reason,
      });
      const isImage = !!f.ext && IMAGE_EXT.has(f.ext);
      if (!isImage) return none(REASON_NOT_IMAGE);

      const out = none(REASON_NO_DECODER);
      if (sharp) {
        try {
          // metadata() reads the header only — cheap even for huge files.
          const m = await sharp(f.path, { failOn: 'none' }).metadata();
          if (typeof m.width === 'number' && typeof m.height === 'number') {
            out.width = m.width;
            out.height = m.height;
            out.dimensionsReason = null;
          } else {
            out.dimensionsReason = REASON_UNDECODABLE;
          }
          const parsed = m.exif ? parseExifCaptureDate(m.exif) : null;
          if (parsed) {
            out.captureDate = parsed;
            out.captureDateReason = null;
          } else {
            out.captureDateReason = REASON_NO_EXIF;
          }
        } catch {
          out.dimensionsReason = REASON_UNDECODABLE;
          out.captureDateReason = REASON_UNDECODABLE;
        }
      }
      if (decoder !== 'none') {
        out.hash = await hashImage(f.path, decoder);
        out.hashReason = out.hash ? null : REASON_UNDECODABLE;
      }
      return out;
    }),
  );

  const refHash = facts[recommendedKeep.index]!.hash;
  const diffReference = refHash ? recommendedKeep.index : null;

  const files: DupeDetailFile[] = meta.map((f, i) => {
    const x = facts[i]!;
    let visualDiff: DupeVisualDiff | null = null;
    let visualDiffReason: string | null;
    if (x.hashReason !== null) {
      visualDiffReason = x.hashReason;
    } else if (i === diffReference) {
      visualDiffReason = REASON_IS_REFERENCE;
    } else if (!refHash) {
      visualDiffReason = REASON_NO_REFERENCE;
    } else {
      visualDiff = {
        hammingDistance: hamming(x.hash!, refHash),
        differingBlocks: diffBlocks(x.hash!, refHash),
        summary: diffSummary(hamming(x.hash!, refHash)),
      };
      visualDiffReason = null;
    }
    return {
      name: f.name,
      path: f.path,
      size: f.size,
      modifiedAt: f.modifiedAt,
      newest: f.modifiedAt === maxMtime,
      largest: f.size === maxSize,
      isImage: !!f.ext && IMAGE_EXT.has(f.ext),
      width: x.width,
      height: x.height,
      dimensionsReason: x.dimensionsReason,
      captureDate: x.captureDate,
      captureDateReason: x.captureDateReason,
      visualDiff,
      visualDiffReason,
    };
  });

  return { scanId, files, recommendedKeep, diffReference };
}

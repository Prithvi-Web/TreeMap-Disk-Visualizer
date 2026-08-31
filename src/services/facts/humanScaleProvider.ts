import { getScan } from '../diskScanner';
import { storeOf } from '../scanStore';
import type { ScanStore } from '../scanStore';
import { FactBatch, FactProvider, unavailableBatch } from './types';

/**
 * The `humanScale` fact provider (v4 §9.3) — "42 GB — about 3,100 photos".
 *
 * A byte figure past a gigabyte stops meaning anything to most people, so the
 * UI translates it into things they own. The rule that makes the translation
 * honest comes straight from §9.3: the equivalent is computed **from the
 * actual file mix in that folder, never from a constant**. This provider
 * walks a directory's own subtree, averages the photos, videos and music
 * actually found there, and reports how many of *those* the folder's total
 * amounts to — together with the sample size and average, so the UI can show
 * its basis ("based on the 2,847 photos in this folder, average 12.1 MB").
 * A folder with no comparable files gets an empty list, and the UI shows
 * nothing: no generic "a photo is about 3 MB" ever stands in.
 *
 * **Deviation from the master prompt's example, recorded here on purpose:**
 * §9.3's illustration includes "6 hours of 4K video". A duration needs a
 * bitrate, the folder's own files do not carry one the scan can read, and
 * the very same sentence forbids reaching for a constant — so duration
 * equivalents are deliberately not produced. Counts of the folder's own
 * media ("about 18 of the videos in this folder") are the honest form of
 * the same idea, and that is all this provider emits.
 *
 * Directories only: a single file has no mix to compare against, so a file
 * path — like a path the scan does not contain — is `skipped` and absent
 * from `values`, following sizeProvider's rule that absent is not zero.
 */

export type HumanScaleKind = 'photos' | 'videos' | 'music';

/** One comparable kind found in the folder, with the basis stated. */
export interface HumanScaleEquivalent {
  kind: HumanScaleKind;
  /** How many files of this kind the average rests on. */
  sampleCount: number;
  /** The true average size of those files, in bytes (may be fractional). */
  avgBytes: number;
  /** Math.round(folder bytes / avgBytes) — "about this many of its own". */
  equivalentCount: number;
}

export interface HumanScaleFact {
  /** The scan's own byte total for this directory. */
  bytes: number;
  /** Present only when the walk hit its node cap: the basis is a sample. */
  capped?: true;
  /** Every kind that cleared the sample floor. Often empty — that is honest. */
  equivalents: HumanScaleEquivalent[];
}

/**
 * A kind needs at least this many files before its average is a basis.
 * An average of 3 files is an anecdote, and §9.3 would rather show nothing
 * than a figure resting on one.
 */
export const MIN_COMPARABLE = 10;

/**
 * Per-path walk budget. Trees reach a million nodes, a batch holds up to
 * 2,000 paths, and the drawn paths are the big directories near the root —
 * uncapped, one request could visit billions of nodes. A capped walk still
 * answers from what it saw, marked `capped: true` so the UI's basis line can
 * say the sample was truncated instead of presenting it as the whole.
 */
export const WALK_CAP = 500_000;

/**
 * Whole-request walk budget. The per-path cap alone is not a bound: a batch
 * of 2,000 deep directories at 500k nodes each could visit a BILLION nodes
 * in one synchronous compute() — seconds of blocked event loop from a single
 * request. The batch budget caps the request's total; paths past it are
 * skipped and counted, never zeroed, so the response still states its own
 * coverage (§2.4). The UI asks for one path per hover and never feels this;
 * it exists for the API and MCP callers who can ask for two thousand.
 */
export const BATCH_WALK_CAP = 2_000_000;

/**
 * The live caps. Mutable only through `setHumanScaleWalkCapForTests`:
 * proving the capped branches against the real constants would need
 * million-node fixtures, so — following the `setFactCacheLimitsForTests`
 * precedent — the seam is named for what it is so nobody mistakes it for a
 * tuning knob.
 */
let walkCap = WALK_CAP;
let batchWalkCap = BATCH_WALK_CAP;

/** Shrink the walk caps for a test. Returns a restore function. */
export function setHumanScaleWalkCapForTests(cap: number, batchCap?: number): () => void {
  const previous = walkCap;
  const previousBatch = batchWalkCap;
  walkCap = cap;
  if (batchCap !== undefined) batchWalkCap = batchCap;
  return () => {
    walkCap = previous;
    batchWalkCap = previousBatch;
  };
}

/**
 * The walk re-reads the abort signal every 4,096 visited nodes (visited
 * count AND-ed with this mask). Checking every node would put a getter read
 * in the hottest loop the fact layer has; checking only between paths would
 * let one enormous directory ignore a cancelled request for seconds.
 */
const ABORT_CHECK_MASK = 0xfff;

/** The extensions the scanner stores (lowercase, no dot) for each kind. */
const PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'tif', 'tiff', 'webp', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'avi', 'm4v', 'webm', 'mts', 'm2ts'];
const MUSIC_EXTENSIONS = ['mp3', 'm4a', 'flac', 'wav', 'aac', 'ogg', 'aiff'];

/** Emission order is fixed, so results are deterministic batch to batch. */
const KINDS: readonly HumanScaleKind[] = ['photos', 'videos', 'music'];

const KIND_OF_EXTENSION = new Map<string, HumanScaleKind>();
for (const e of PHOTO_EXTENSIONS) KIND_OF_EXTENSION.set(e, 'photos');
for (const e of VIDEO_EXTENSIONS) KIND_OF_EXTENSION.set(e, 'videos');
for (const e of MUSIC_EXTENSIONS) KIND_OF_EXTENSION.set(e, 'music');

/**
 * Walk one directory's subtree and tally its media mix.
 *
 * Explicit stack, no recursion: this runs against whatever the user has on
 * disk, and a deeply nested tree must not be able to overflow the call
 * stack. Files are tallied and never descended into, mirroring
 * `ScanStore.eachFile`: an expanded container's virtual listing is not part
 * of the folder's file mix, but the container file itself is.
 *
 * Returns `null` when the abort signal was found set mid-walk. A cancelled
 * request gets nothing for this path — skipped, not a partial value — while
 * a *capped* walk (the budget, not a cancellation) still answers, because
 * the caller is still listening and a truncated sample that states itself
 * is more useful than silence.
 */
function walkDir(
  store: ScanStore,
  dirId: number,
  signal: AbortSignal,
  /** Nodes this walk may visit — min of the per-path cap and what is left of the batch budget. */
  allowance: number,
): { fact: HumanScaleFact; visited: number } | null {
  const tallies: Record<HumanScaleKind, { count: number; bytes: number }> = {
    photos: { count: 0, bytes: 0 },
    videos: { count: 0, bytes: 0 },
    music: { count: 0, bytes: 0 },
  };

  const limit = Math.min(walkCap, allowance);
  const stack: number[] = [dirId];
  let visited = 0;
  let capped = false;

  while (stack.length > 0) {
    if (visited >= limit) {
      capped = true;
      break;
    }
    const id = stack.pop() as number;
    visited++;
    if ((visited & ABORT_CHECK_MASK) === 0 && signal.aborted) return null;

    if (store.isDir(id)) {
      store.forEachChild(id, (child) => stack.push(child));
      continue;
    }
    const ext = store.extension(id);
    if (ext === undefined) continue;
    const kind = KIND_OF_EXTENSION.get(ext);
    if (kind === undefined) continue;
    const tally = tallies[kind];
    tally.count += 1;
    tally.bytes += store.size(id);
  }

  // The folder's byte figure is the scan's own summed total — O(1) truth,
  // correct even when the walk above was capped: only the *sample* behind
  // the average is truncated, never the number being translated.
  const dirBytes = store.size(dirId);

  const equivalents: HumanScaleEquivalent[] = [];
  for (const kind of KINDS) {
    const tally = tallies[kind];
    // Below the floor the kind is omitted entirely — not emitted with a
    // zeroed count. Ten zero-byte files also clear no bar: an average of 0
    // divides nothing, so the guard on avgBytes drops that case the same way.
    if (tally.count < MIN_COMPARABLE) continue;
    const avgBytes = tally.bytes / tally.count;
    if (avgBytes <= 0) continue;
    equivalents.push({
      kind,
      sampleCount: tally.count,
      avgBytes,
      equivalentCount: Math.round(dirBytes / avgBytes),
    });
  }

  // The optional stays absent on a full walk — a `capped: false` would make
  // every consumer check a field that only ever matters when it is true.
  const fact: HumanScaleFact = capped
    ? { bytes: dirBytes, capped: true, equivalents }
    : { bytes: dirBytes, equivalents };
  return { fact, visited };
}

export const humanScaleProvider: FactProvider<HumanScaleFact> = {
  id: 'humanScale',
  label: 'Human-scale equivalents',
  // Reads only the scan already in memory — nothing this machine might lack.
  capabilityKey: null,

  async compute(scanId: string, paths: string[], signal: AbortSignal): Promise<FactBatch<HumanScaleFact>> {
    const scan = getScan(scanId);
    if (!scan) {
      // Scans live ~30 minutes. An expired one is a real, explainable state,
      // not an error — and saying so beats inventing equivalents from nothing.
      return unavailableBatch('That scan has expired. Scan the folder again to compare its size to its own files.', paths.length);
    }
    if (scan.status === 'running') {
      return unavailableBatch('That scan is still running — the folder\'s file mix is not final yet.', paths.length);
    }
    if (!scan.store && !scan.root) {
      return unavailableBatch(scan.error ?? 'That scan did not complete, so there is no file mix to read.', paths.length);
    }

    const store = storeOf(scan);
    const values = new Map<string, HumanScaleFact>();
    let skipped = 0;
    let batchBudget = batchWalkCap;

    for (let i = 0; i < paths.length; i++) {
      // Same contract as every other provider: an abort leaves the rest
      // `skipped`, so requested === computed + skipped + failed always holds
      // and a partial answer can state its own coverage (§2.4).
      if (signal.aborted) {
        skipped += paths.length - i;
        break;
      }
      const id = store.findByPath(paths[i]);
      if (id === -1) {
        skipped++; // not in this tree — absent from `values`, never a zero
        continue;
      }
      if (!store.isDir(id)) {
        // A file has no mix of files to average. Outside the domain, so
        // skipped — reporting `equivalents: []` for it would claim the
        // question was asked and answered when it was never applicable.
        skipped++;
        continue;
      }
      // The batch budget: once this request has visited its share of nodes,
      // every remaining path is skipped — stated in the stats — rather than
      // walked. One request must not be able to block the event loop for
      // seconds however many deep directories it names.
      if (batchBudget <= 0) {
        skipped++;
        continue;
      }
      const walked = walkDir(store, id, signal, batchBudget);
      if (walked === null) {
        // Aborted mid-walk: this path is skipped whole, and the loop-top
        // check catches every path after it on the next iteration.
        skipped++;
        continue;
      }
      batchBudget -= walked.visited;
      values.set(paths[i], walked.fact);
    }

    return {
      available: true,
      values,
      stats: {
        requested: paths.length,
        computed: values.size,
        skipped,
        // Walking an in-memory store cannot fail per path: an id resolves or
        // it does not, and "does not" is `skipped`.
        failed: 0,
      },
    };
  },
};

import { Router, Request, Response } from 'express';
import fs from 'fs';
import pathMod from 'path';
import { moveToTrash, openPath, openTerminal } from '../services/cleaner';
import {
  guardBodyPath,
  guardBodyPaths,
  guardBodyPathsMax,
  guardQueryPath,
  requireInsideScanRoot,
  insideAnyScanRoot,
  assertNotSpillPath,
  refuseSafetyRecords,
  withUnfinishedScan,
} from '../middleware/pathGuard';
import { AppError } from '../middleware/errorHandler';
import { getOrRenderThumbnail, THUMB_DIM, THUMB_MAX_INPUT } from '../services/thumbnailCache';
import { idempotency } from '../middleware/idempotency';
import { getPolicy, assertPathsAllowed, assertBytesCapOver, knownSizeOf } from '../services/policy';
import { appendAudit, tokenIdFor } from '../services/audit';
import { checkOpenHandles } from '../services/openHandleGuard';
import { emptyCheckSession, isNotEmptyCode, NOT_EMPTY_CODES, type NotEmptyCode } from '../services/emptyFolderCheck';
import { installedProgramParts, withInstalledProgram } from '../services/installedPrograms';

export const fileRouter = Router();

/**
 * POST /api/files/open-handles  { paths: string[] }
 * Which of these paths — or files inside them — is a program holding open (B2)?
 * -> { conflicts, checked, complete, reason?, elapsedMs }
 *
 * Read-only preflight for the confirmation dialog, so the warning appears
 * *before* the user commits rather than as a failure afterwards. The delete
 * endpoint runs the same check itself, so skipping this changes nothing about
 * what is allowed — it only changes when the user finds out.
 */
fileRouter.post('/files/open-handles', guardBodyPaths, requireInsideScanRoot, async (req: Request, res: Response) => {
  const { paths } = req.body as { paths: string[] };
  res.json(await checkOpenHandles(paths));
});

/** How many paths one installed-programs question may carry: it reads only the paths, so a whole screenful of a big selection goes in one. */
export const MAX_INSTALLED_PROGRAM_PATHS = 2000;

/**
 * POST /api/files/installed-programs  { paths: string[] }
 * Which of these paths is a part of an installed program — a file inside a Mac
 * app, a program's own folder under Program Files, Linux's /usr (fifth browser
 * pass F01)? -> { parts: [{ path, installedProgram: { kind, name, root } }] },
 * only the paths that are; a path that is no part of one is not listed.
 *
 * Read-only preflight for the Trash sheets, so "it is part of Google Chrome,
 * which will stop working" is said before the person confirms, not found out
 * afterwards. Like the open-file check it answers only for paths inside a
 * scanned root: one outside every one, or refused by the path rules, refuses
 * the whole request (review F1.7). It moves nothing; the one detector the
 * dry-run manifests, Autopilot and the Security panel ask reads the paths'
 * names, and where each really is (the links in its folders).
 */
fileRouter.post('/files/installed-programs', guardBodyPathsMax(MAX_INSTALLED_PROGRAM_PATHS), requireInsideScanRoot, (req: Request, res: Response) => {
  const { paths } = req.body as { paths: string[] };
  res.json({ parts: installedProgramParts(paths) });
});

/** One request's outcome in the audit trail, split by what decided it (U-4b L4). */
interface TrashAudit {
  paths: string[];
  sizeOf: Map<string, number | null>;
  dryRun: boolean;
  /** Paths an "only empty folders" look left where they are, each with its code. */
  refused: { path: string; code: string }[];
  /** Other paths that did not go: the Trash's own failures. */
  failed: number;
}

/**
 * Write a delete's audit entries. What the empty-folder look refused is a
 * refusal the endpoint itself decided, recorded as one with its code (one
 * entry per code), as AGENTS.md says of the endpoint's refusals — never folded
 * into an "error" with PARTIAL_FAILURE. Everything else is one entry, as it
 * always was: "ok", or "error" with PARTIAL_FAILURE when the Trash failed some.
 * With nothing refused the trail is exactly what it was.
 */
async function auditTrash(a: TrashAudit): Promise<void> {
  const bytesOf = (ps: string[]): number => ps.reduce((sum, p) => sum + (a.sizeOf.get(p) ?? 0), 0);
  const entry = { action: 'files.trash', source: 'http' as const, tokenId: tokenIdFor('http'), dryRun: a.dryRun };
  // One refusal takes one occurrence of its path out (the U-4b review, L-6): a path sent twice,
  // refused at one turn and trashed at the other, is in both entries.
  const refusalsLeft = new Map<string, number>();
  for (const r of a.refused) refusalsLeft.set(r.path, (refusalsLeft.get(r.path) ?? 0) + 1);
  const rest = a.paths.filter((p) => {
    const left = refusalsLeft.get(p) ?? 0;
    if (left === 0) return true;
    refusalsLeft.set(p, left - 1);
    return false;
  });
  if (rest.length > 0 || a.refused.length === 0) {
    await appendAudit({ ...entry, paths: rest, bytes: bytesOf(rest), outcome: a.failed === 0 ? 'ok' : 'error', ...(a.failed > 0 ? { code: 'PARTIAL_FAILURE' } : {}) });
  }
  const byCode = new Map<string, string[]>();
  for (const r of a.refused) byCode.set(r.code, [...(byCode.get(r.code) ?? []), r.path]);
  for (const [code, ps] of byCode) await appendAudit({ ...entry, paths: ps, bytes: bytesOf(ps), outcome: 'refused', code });
}

/**
 * DELETE /api/files  { paths: string[], dryRun?: boolean, ignoreOpenHandles?: boolean, onlyEmptyFolders?: boolean, ignoreJunk?: boolean }
 * Moves every path to the system trash (never hard-deletes).
 * -> { deleted: string[], failed: { path, reason }[] }
 * With dryRun: true, reports the exact manifest (paths + known bytes) and
 * touches nothing; the response then carries `dryRun: true` instead.
 * Honors an Idempotency-Key header so a retry can't double-trash.
 *
 * Answers `409 OPEN_HANDLE_CONFLICT` — with the offending processes in
 * `conflicts` — when something in the set is open, unless the caller passes
 * `ignoreOpenHandles: true` (the "delete anyway" the user chose after seeing
 * the warning). A dry run reports the conflicts rather than refusing: its whole
 * job is to describe what would happen without anything happening.
 *
 * `onlyEmptyFolders: true` (Empty Folders sends it, Track U U-4): every path
 * was offered as an empty folder, and each is looked at again right before its
 * own Trash step, in one session of looks (U-4b M1). One that is not still
 * empty is left where it is, in `failed` with `refused: true` and the code
 * that says why — FOLDER_NOT_EMPTY, FOLDER_UNREADABLE, FOLDER_NO_ANSWER, FOLDER_NOT_CHECKED,
 * FOLDER_TOO_MANY_ENTRIES, NOT_A_FOLDER (U-4b L4); a dry run lists those in
 * `notEmpty` and leaves them out of `wouldTrash`. `ignoreJunk` is the junk
 * rule the list was made with (true when left out). Anything but a boolean is
 * `400 ONLY_EMPTY_FOLDERS_INVALID` / `400 IGNORE_JUNK_INVALID`, and so is
 * `ignoreJunk` without `onlyEmptyFolders: true`: a caller that meant the
 * check never goes without it. Each such refusal is audited as a refusal with
 * its code.
 */
fileRouter.delete('/files', idempotency, guardBodyPaths, requireInsideScanRoot, refuseSafetyRecords, async (req: Request, res: Response) => {
  const { paths, dryRun, ignoreOpenHandles, onlyEmptyFolders, ignoreJunk } = req.body as {
    paths: string[];
    dryRun?: boolean;
    ignoreOpenHandles?: boolean;
    onlyEmptyFolders?: unknown;
    ignoreJunk?: unknown;
  };
  if (onlyEmptyFolders !== undefined && typeof onlyEmptyFolders !== 'boolean') {
    throw new AppError(400, 'ONLY_EMPTY_FOLDERS_INVALID', 'onlyEmptyFolders must be true or false');
  }
  if (ignoreJunk !== undefined && (typeof ignoreJunk !== 'boolean' || onlyEmptyFolders !== true)) {
    throw new AppError(400, 'IGNORE_JUNK_INVALID', 'ignoreJunk must be true or false, and is read only with onlyEmptyFolders: true');
  }
  const junkIsEmpty = ignoreJunk !== false;
  const sized = paths.map((p) => ({ path: p, bytes: knownSizeOf(p) }));
  const sizeOf = new Map(sized.map((s) => [s.path, s.bytes]));
  const totalKnownBytes = sized.reduce((sum, s) => sum + (s.bytes ?? 0), 0);

  const policy = await getPolicy();
  try {
    assertPathsAllowed(policy, paths);
    assertBytesCapOver(policy, sized);
  } catch (err) {
    if (err instanceof AppError) {
      await appendAudit({ action: 'files.trash', source: 'http', tokenId: tokenIdFor('http'), paths, bytes: totalKnownBytes, dryRun: dryRun === true, outcome: 'refused', code: err.code });
    }
    throw err;
  }

  if (dryRun === true) {
    // A dry run describes, it never refuses — so open files are reported as
    // part of the picture rather than as an error.
    const openHandles = await checkOpenHandles(paths);
    if (onlyEmptyFolders !== true) {
      await appendAudit({ action: 'files.trash', source: 'http', tokenId: tokenIdFor('http'), paths, bytes: totalKnownBytes, dryRun: true, outcome: 'ok' });
      // Each part of an installed program says which (F01): the manifest is what an agent shows a person.
      res.json({ dryRun: true, wouldTrash: sized.map(withInstalledProgram), totalKnownBytes, openHandles });
      return;
    }
    // The real run's own look, path by path, so the manifest is what it would do — in one
    // session, so a drive that does not answer is asked once (U-4b M1).
    const notEmpty: { path: string; code: NotEmptyCode; reason: string }[] = [];
    const looks = emptyCheckSession(junkIsEmpty);
    for (const p of paths) {
      const look = await looks.look(p);
      if (!look.empty && look.why !== 'gone') notEmpty.push({ path: p, code: NOT_EMPTY_CODES[look.why], reason: look.reason });
    }
    await auditTrash({ paths, sizeOf, dryRun: true, refused: notEmpty, failed: 0 });
    const left = new Set(notEmpty.map((n) => n.path));
    const wouldTrash = sized.filter((s) => !left.has(s.path)).map(withInstalledProgram);
    res.json({ dryRun: true, wouldTrash, totalKnownBytes: wouldTrash.reduce((sum, s) => sum + (s.bytes ?? 0), 0), openHandles, notEmpty });
    return;
  }

  let result;
  try {
    result = await moveToTrash(paths, { ignoreOpenHandles: ignoreOpenHandles === true, onlyEmptyFolders: onlyEmptyFolders === true, ignoreJunk: junkIsEmpty });
  } catch (err) {
    // A refusal is a real outcome and belongs in the audit trail beside the
    // policy refusals above — otherwise the log shows a delete that simply
    // never happened, with no record of why.
    if (err instanceof AppError && err.code === 'OPEN_HANDLE_CONFLICT') {
      await appendAudit({ action: 'files.trash', source: 'http', tokenId: tokenIdFor('http'), paths, bytes: totalKnownBytes, dryRun: false, outcome: 'refused', code: err.code });
    }
    throw err;
  }
  const refused = onlyEmptyFolders === true
    ? result.failed.flatMap((f) => (f.refused && isNotEmptyCode(f.code) ? [{ path: f.path, code: f.code }] : []))
    : [];
  await auditTrash({ paths, sizeOf, dryRun: false, refused, failed: result.failed.length - refused.length });
  res.json(result);
});

/**
 * POST /api/files/open  { path: string, reveal?: boolean }
 * Opens the path with the OS default app; reveal=true highlights it in
 * Finder / Explorer / the file manager instead.
 */
fileRouter.post('/files/open', guardBodyPath, requireInsideScanRoot, async (req: Request, res: Response) => {
  const { path: target, reveal } = req.body as { path: string; reveal?: boolean };
  await openPath(target, reveal === true);
  res.json({ opened: target });
});

/**
 * POST /api/files/terminal  { path: string }
 * Opens the platform's terminal at the directory (Open Terminal Here).
 * Guarded like every path-taking endpoint — sanitized and confined to
 * directories inside a scanned root; never launches anything for files.
 */
fileRouter.post('/files/terminal', guardBodyPath, requireInsideScanRoot, async (req: Request, res: Response) => {
  const { path: target } = req.body as { path: string };
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(target);
  } catch {
    throw new AppError(404, 'PATH_NOT_FOUND', 'That folder no longer exists');
  }
  if (!st.isDirectory()) {
    throw new AppError(400, 'NOT_A_DIRECTORY', 'Open Terminal works on folders');
  }
  try {
    await openTerminal(target);
  } catch (err) {
    // A refusal keeps its own status and code (the service's own check answers 403); only a
    // terminal that could not be started is NO_TERMINAL.
    if (err instanceof AppError) throw err;
    throw new AppError(500, 'NO_TERMINAL', err instanceof Error ? err.message : 'No terminal emulator found');
  }
  res.json({ opened: target });
});

/* ---------- Quick-look preview (Feature 4) ---------- */

const PREVIEW_IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};
const PREVIEW_TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'log', 'json', 'jsonc', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'java', 'kt', 'swift', 'php',
  'pl', 'lua', 'sh', 'bash', 'zsh', 'fish', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'csv', 'tsv', 'sql', 'gradle',
  'properties', 'gitignore', 'r', 'vue', 'svelte',
]);
// The sizes the preview pane names — "Image larger than 10 MB", "first 8 KB
// shown" — in the decimal units every size is printed in (QA D09).
const PREVIEW_MAX_IMAGE = 10_000_000;
const PREVIEW_TEXT_BYTES = 8000;
const PREVIEW_NAME_TEXT = new Set(['dockerfile', 'makefile', 'license', 'readme', '.gitignore', '.env']);
/** Raster formats sharp can turn into a WebP thumbnail (?thumb) for the near-dupe strip. */
const THUMB_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'heic', 'heif', 'avif']);
// THUMB_DIM and THUMB_MAX_INPUT live with the cache (services/thumbnailCache):
// the near-duplicate warm-up renders with the same numbers, so the entries
// it makes are the entries this route finds.

/** Heuristic: NUL byte or >10% control chars ⇒ treat as binary, not text. */
function looksBinary(buf: Buffer): boolean {
  const n = buf.length;
  if (n === 0) return false;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return true;
    if (c < 9 || (c > 13 && c < 32)) bad++;
  }
  return bad / n > 0.1;
}

/**
 * GET /api/files/preview?path=<encoded>
 * Read-only, restricted to files inside a scanned root. Images stream inline
 * (≤ 10 MB); known text types return the first 8 KB as JSON; everything else
 * returns lightweight { type:'meta' } so the UI can show icon + metadata.
 */
fileRouter.get('/files/preview', guardQueryPath('path'), async (req: Request, res: Response) => {
  const target = req.query.path;
  if (typeof target !== 'string' || !target) {
    throw new AppError(400, 'PATH_REQUIRED', 'A "path" query parameter is required');
  }
  assertNotSpillPath(target); // TreeMap's own spill folder is never opened (§S.5.3)
  if (!insideAnyScanRoot(target)) {
    throw new AppError(403, 'OUTSIDE_SCAN_ROOT', withUnfinishedScan('Preview is only available for files inside a scanned folder', target));
  }
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(target);
  } catch {
    throw new AppError(404, 'NOT_FOUND', 'File not found');
  }
  if (!st.isFile()) {
    throw new AppError(400, 'NOT_A_FILE', 'Preview is only available for files');
  }

  const ext = pathMod.extname(target).slice(1).toLowerCase();
  const baseName = pathMod.basename(target).toLowerCase();

  // Thumbnail mode: transcode any decodable raster image to a small WebP so
  // even TIFF/HEIC/BMP (which browsers won't show inline) appear in the
  // near-duplicate strip. Falls through to normal handling if sharp can't.
  if (req.query.thumb !== undefined && THUMB_EXT.has(ext) && st.size <= THUMB_MAX_INPUT) {
    const thumb = await getOrRenderThumbnail(target, st.mtimeMs, st.size, THUMB_DIM);
    if (thumb) {
      res.setHeader('Content-Type', 'image/webp');
      // The ETag is keyed on path + mtime + size, so an edited file gets a new
      // one and the browser re-fetches. An unchanged one costs a 304 and no
      // decode at all — the near-duplicate strip re-renders constantly
      // (threshold change, tab return, scrolling), and `no-store` made every
      // one of those a fresh ~20 ms sharp decode per visible image.
      res.setHeader('ETag', thumb.etag);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.fresh) {
        res.status(304).end();
        return;
      }
      res.end(thumb.body);
      return;
    }
  }

  // Images stream inline up to the cap.
  if (PREVIEW_IMAGE_MIME[ext]) {
    if (st.size > PREVIEW_MAX_IMAGE) {
      res.json({ type: 'meta', size: st.size, mtime: st.mtimeMs, ext, reason: 'Image larger than 10 MB' });
      return;
    }
    // The response may end while the file is being opened: the near-duplicate strip cancels most of
    // its requests as rows scroll away. Its 'close' has then already fired, so it is watched from
    // before the open, and a file opened for a response already gone is closed at once rather than
    // streamed into nothing and left to the garbage collector (review F1.9).
    let over = false;
    let stream: fs.ReadStream | null = null;
    let handle: fs.promises.FileHandle | null = null;
    // Destroy the source when the response is over, whichever way it ended.
    //
    // `Readable.pipe` unpipes on the destination's 'close'/'error' but never
    // destroys the source, so an aborted preview leaves this ReadStream paused
    // mid-file with its descriptor still open — and nothing ever collects it.
    // That is the common case, not the rare one: the near-duplicate strip asks
    // for one image per visible row (which is why the preview lane allows a 300
    // burst / 150 per second at all), and scrolling cancels nearly every one of
    // those requests as its row leaves the viewport. Hundreds of stranded
    // descriptors later the process hits EMFILE and the whole server dies, not
    // just previews.
    //
    // `res` always emits 'close', on a clean finish as well as on an abort. On
    // a clean finish the stream has already ended and closed itself, so this is
    // a no-op there; it changes nothing about the bytes, headers or status of a
    // completed response. Destroying rather than piping through
    // `stream.pipeline` is deliberate: pipeline destroys `res` on a source
    // error, which would replace the 500 the stream's error handler below
    // sends with a bare socket hang-up.
    res.on('close', () => {
      over = true;
      stream?.destroy();
      handle?.close().catch(() => undefined); // already closed by the stream, or by this
    });
    // Opened before anything is sent (hunt C87): a file TreeMap may not read reaches the error handler
    // as the text branch's does — 403 PERMISSION_DENIED, { error, code } — not a bare 500 typed as an image.
    handle = await fs.promises.open(target, 'r');
    if (over) {
      await handle.close().catch(() => undefined);
      return;
    }
    res.setHeader('Content-Type', PREVIEW_IMAGE_MIME[ext]);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    stream = fs.createReadStream(target, { fd: handle }); // closes the handle when it ends or is destroyed
    stream.on('error', (err) => {
      if (!res.headersSent) {
        res.removeHeader('Content-Type');
        res.status(500).json({ error: `The image could not be read: ${err.message}`, code: 'READ_FAILED' });
      } else {
        // Cut off part-way: end the connection, so the image never reads as complete (as errorHandler does, QA D35).
        res.destroy(err);
      }
    });
    stream.pipe(res);
    return;
  }

  // Known text types: return the first 8 KB if it decodes as text.
  if (PREVIEW_TEXT_EXT.has(ext) || ext === '' || PREVIEW_NAME_TEXT.has(baseName)) {
    const fd = await fs.promises.open(target, 'r');
    try {
      const len = Math.min(PREVIEW_TEXT_BYTES, st.size);
      const buf = Buffer.alloc(len);
      if (len > 0) await fd.read(buf, 0, len, 0);
      if (looksBinary(buf)) {
        res.json({ type: 'meta', size: st.size, mtime: st.mtimeMs, ext });
        return;
      }
      res.json({ type: 'text', content: buf.toString('utf8'), truncated: st.size > len, size: st.size, mtime: st.mtimeMs, ext });
      return;
    } finally {
      await fd.close();
    }
  }

  // Everything else: metadata only.
  res.json({ type: 'meta', size: st.size, mtime: st.mtimeMs, ext });
});

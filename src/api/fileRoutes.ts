import { Router, Request, Response } from 'express';
import fs from 'fs';
import pathMod from 'path';
import { moveToTrash, openPath } from '../services/cleaner';
import {
  guardBodyPath,
  guardBodyPaths,
  guardQueryPath,
  requireInsideScanRoot,
  insideAnyScanRoot,
} from '../middleware/pathGuard';
import { AppError } from '../middleware/errorHandler';
import { makeThumbnail } from '../services/perceptualDupes';

export const fileRouter = Router();

/**
 * DELETE /api/files  { paths: string[] }
 * Moves every path to the system trash (never hard-deletes).
 * -> { deleted: string[], failed: { path, reason }[] }
 */
fileRouter.delete('/files', guardBodyPaths, requireInsideScanRoot, async (req: Request, res: Response) => {
  const { paths } = req.body as { paths: string[] };
  const result = await moveToTrash(paths);
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
const PREVIEW_MAX_IMAGE = 10 * 1024 * 1024;
const PREVIEW_TEXT_BYTES = 8192;
const PREVIEW_NAME_TEXT = new Set(['dockerfile', 'makefile', 'license', 'readme', '.gitignore', '.env']);
/** Raster formats sharp can turn into a WebP thumbnail (?thumb) for the near-dupe strip. */
const THUMB_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'heic', 'heif', 'avif']);
const THUMB_MAX_INPUT = 60 * 1024 * 1024; // sharp decodes into memory — cap the source size

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
  if (!insideAnyScanRoot(target)) {
    throw new AppError(403, 'OUTSIDE_SCAN_ROOT', 'Preview is only available for files inside a scanned folder');
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
    const thumb = await makeThumbnail(target, 256);
    if (thumb) {
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(thumb);
      return;
    }
  }

  // Images stream inline up to the cap.
  if (PREVIEW_IMAGE_MIME[ext]) {
    if (st.size > PREVIEW_MAX_IMAGE) {
      res.json({ type: 'meta', size: st.size, mtime: st.mtimeMs, ext, reason: 'Image larger than 10 MB' });
      return;
    }
    res.setHeader('Content-Type', PREVIEW_IMAGE_MIME[ext]);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const stream = fs.createReadStream(target);
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.end(); });
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

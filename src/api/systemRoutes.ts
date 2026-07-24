import { Router, Request, Response } from "express";
import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { guardQueryPath } from "../middleware/pathGuard";
import { AppError } from "../middleware/errorHandler";
import { diskUsage, listVolumes } from "../services/diskUsage";
import { getTrashInfo, emptyTrash } from "../services/trash";
import {
  getSnapshotAccounting,
  purgeSnapshots,
} from "../services/snapshotAccounting";
import { SystemInfo } from "../models/types";

export const systemRouter = Router();

/* ------------------------------ Routes ------------------------------ */

/** GET /api/system -> platform, hostname, disk totals, suggested folders. */
systemRouter.get("/system", async (_req: Request, res: Response) => {
  const homeDir = os.homedir();
  const [{ total, free }, volumes] = await Promise.all([
    diskUsage(homeDir),
    listVolumes(),
  ]);

  const candidates = [
    homeDir,
    path.join(homeDir, "Desktop"),
    path.join(homeDir, "Documents"),
    path.join(homeDir, "Downloads"),
    path.join(homeDir, "Pictures"),
    path.join(homeDir, "Music"),
    path.join(homeDir, process.platform === "darwin" ? "Movies" : "Videos"),
  ];
  // Drive roots (C:\, D:\, …) so Browse / quick-scan can leave the home volume.
  for (const v of volumes) {
    if (!candidates.includes(v.mount)) candidates.push(v.mount);
  }
  const commonDirs: string[] = [];
  for (const dir of candidates) {
    try {
      const stat = await fsp.stat(dir);
      if (stat.isDirectory()) commonDirs.push(dir);
    } catch {
      /* missing on this machine — skip */
    }
  }

  const info: SystemInfo = {
    platform: process.platform,
    hostname: os.hostname(),
    totalDisk: total,
    freeDisk: free,
    homeDir,
    commonDirs,
    volumes,
  };
  res.json(info);
});

/** GET /api/trash/size -> { totalBytes, itemCount, paths, items } across all trash locations. */
systemRouter.get("/trash/size", async (_req: Request, res: Response) => {
  res.json(await getTrashInfo());
});

/**
 * POST /api/trash/empty { confirm:true } -> empty the system Trash / Recycle
 * Bin. Irreversible, so it demands the same explicit confirm flag as the
 * snapshot purge — the UI additionally gates it behind a confirm dialog.
 */
systemRouter.post("/trash/empty", async (req: Request, res: Response) => {
  const { confirm } = req.body as { confirm?: boolean };
  if (confirm !== true) {
    throw new AppError(
      400,
      "CONFIRM_REQUIRED",
      "Pass { confirm: true } to empty the Trash",
    );
  }
  res.json(await emptyTrash());
});

/** GET /api/system/snapshots -> OS snapshot accounting (APFS/Btrfs/VSS), best-effort. */
systemRouter.get("/system/snapshots", async (_req: Request, res: Response) => {
  res.json(await getSnapshotAccounting());
});

/** POST /api/system/snapshots/purge { confirm:true } -> delete local snapshots (macOS). */
systemRouter.post(
  "/system/snapshots/purge",
  async (req: Request, res: Response) => {
    const { confirm } = req.body as { confirm?: boolean };
    if (confirm !== true) {
      throw new AppError(
        400,
        "CONFIRM_REQUIRED",
        "Pass { confirm: true } to purge local snapshots",
      );
    }
    res.json(await purgeSnapshots());
  },
);

/**
 * GET /api/fs/list?path=<dir>
 * Subdirectories of a folder — powers the Browse picker in the UI.
 * Defaults to the home directory when no path is given.
 */
systemRouter.get(
  "/fs/list",
  guardQueryPath("path"),
  async (req: Request, res: Response) => {
    const target = (req.query.path as string | undefined) ?? os.homedir();

    const stat = await fsp.stat(target); // ENOENT/EACCES -> errorHandler
    if (!stat.isDirectory()) {
      throw new AppError(400, "NOT_A_DIRECTORY", "Path is not a directory");
    }

    const entries = await fsp.readdir(target, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .slice(0, 500)
      .map((e) => ({
        name: e.name,
        path: path.join(target, e.name),
        isHidden: e.name.startsWith("."),
      }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );

    const parent = path.dirname(target);
    res.json({
      path: target,
      parent: parent === target ? null : parent,
      dirs,
    });
  },
);

/**
 * POST /api/client-log { level?, message }
 * Mirrors UI toasts/diagnostics into the server console (dev terminal).
 * Local-only tool — no auth; keep payloads small.
 */
systemRouter.post("/client-log", (req: Request, res: Response) => {
  const body = req.body as { level?: string; message?: unknown };
  const message =
    typeof body.message === "string"
      ? body.message
      : String(body.message ?? "");
  if (!message.trim()) {
    throw new AppError(400, "MESSAGE_REQUIRED", 'Body must include "message"');
  }
  const level =
    body.level === "error" || body.level === "warn" ? body.level : "info";
  const line = `[client:${level}] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
  res.json({ ok: true });
});

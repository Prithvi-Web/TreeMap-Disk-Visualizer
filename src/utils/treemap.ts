import { FileNode, TreemapNode } from '../models/types';

/**
 * Squarified treemap layout, implemented from scratch after
 * Bruls, Huizing & van Wijk, "Squarified Treemaps" (2000).
 *
 * The algorithm lays items into rows along the shorter side of the
 * remaining rectangle, greedily adding items to the current row while
 * doing so improves (lowers) the worst aspect ratio of the row.
 */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TreemapOptions {
  maxDepth: number;
  /** Files/dirs smaller than this many bytes are omitted. */
  minSize: number;
  /** Hard cap on emitted nodes so a pathological tree can't explode the payload. */
  maxNodes: number;
}

/**
 * Worst aspect ratio of a row of areas laid along a side of length `side`.
 * Lower is better; 1.0 means every rectangle in the row is a square.
 */
function worstRatio(row: number[], side: number): number {
  let sum = 0;
  let max = -Infinity;
  let min = Infinity;
  for (const a of row) {
    sum += a;
    if (a > max) max = a;
    if (a < min) min = a;
  }
  if (sum <= 0 || side <= 0) return Infinity;
  const s2 = sum * sum;
  const w2 = side * side;
  return Math.max((w2 * max) / s2, s2 / (w2 * min));
}

/**
 * Lay out `areas` (sorted descending, each > 0, summing to <= rect area)
 * inside `rect`. Returns one rectangle per input area, in input order.
 */
export function squarify(areas: number[], rect: Rect): Rect[] {
  const result: Rect[] = new Array(areas.length);
  let remaining: Rect = { ...rect };
  let i = 0;

  while (i < areas.length) {
    const side = Math.min(remaining.w, remaining.h);

    // Grow the row while the worst aspect ratio keeps improving.
    const rowStart = i;
    const row: number[] = [areas[i]];
    i++;
    while (i < areas.length) {
      const candidate = [...row, areas[i]];
      if (worstRatio(candidate, side) <= worstRatio(row, side)) {
        row.push(areas[i]);
        i++;
      } else {
        break;
      }
    }

    // Fix the row: a strip of `thickness` along the shorter side.
    let rowArea = 0;
    for (const a of row) rowArea += a;
    const thickness = side > 0 ? rowArea / side : 0;

    if (remaining.w >= remaining.h) {
      // Vertical strip on the left edge; items stack top -> bottom.
      let y = remaining.y;
      for (let k = 0; k < row.length; k++) {
        const h = thickness > 0 ? row[k] / thickness : 0;
        result[rowStart + k] = { x: remaining.x, y, w: thickness, h };
        y += h;
      }
      remaining = {
        x: remaining.x + thickness,
        y: remaining.y,
        w: remaining.w - thickness,
        h: remaining.h,
      };
    } else {
      // Horizontal strip on the top edge; items run left -> right.
      let x = remaining.x;
      for (let k = 0; k < row.length; k++) {
        const w = thickness > 0 ? row[k] / thickness : 0;
        result[rowStart + k] = { x, y: remaining.y, w, h: thickness };
        x += w;
      }
      remaining = {
        x: remaining.x,
        y: remaining.y + thickness,
        w: remaining.w,
        h: remaining.h - thickness,
      };
    }
  }

  return result;
}

/**
 * Build a flattened treemap for `root`, recursing into directories up to
 * `maxDepth`. All coordinates are percentages (0–100) of the full viewport
 * so the client can scale them to any canvas size.
 */
export function buildTreemap(root: FileNode, options: TreemapOptions): TreemapNode[] {
  const { maxDepth, minSize, maxNodes } = options;
  const out: TreemapNode[] = [];

  // Breadth-first so that, if we hit maxNodes, shallow (big-picture)
  // rectangles win over deep detail.
  interface Job {
    node: FileNode;
    rect: Rect;
    depth: number;
  }
  const queue: Job[] = [{ node: root, rect: { x: 0, y: 0, w: 100, h: 100 }, depth: 0 }];

  while (queue.length > 0 && out.length < maxNodes) {
    const { node, rect, depth } = queue.shift()!;
    if (node.type !== 'dir' || !node.children || node.children.length === 0) continue;
    if (node.size <= 0 || rect.w <= 0 || rect.h <= 0) continue;

    const children = node.children
      .filter((c) => c.size >= minSize && c.size > 0)
      .sort((a, b) => b.size - a.size);
    if (children.length === 0) continue;

    // Scale child areas by their share of the *parent's* total size so the
    // visual proportions stay truthful even when small files are filtered
    // out (the filtered share simply remains empty space).
    const rectArea = rect.w * rect.h;
    const areas = children.map((c) => (c.size / node.size) * rectArea);
    const rects = squarify(areas, rect);

    for (let k = 0; k < children.length && out.length < maxNodes; k++) {
      const child = children[k];
      const r = rects[k];
      if (r.w <= 0 || r.h <= 0) continue;

      const canExpand =
        child.type === 'dir' &&
        depth + 1 < maxDepth &&
        !!child.children &&
        child.children.length > 0 &&
        // Don't bother recursing into rectangles too small to subdivide.
        r.w > 0.2 &&
        r.h > 0.2;

      out.push({
        name: child.name,
        path: child.path,
        size: child.size,
        type: child.type,
        extension: child.extension,
        modifiedAt: child.modifiedAt,
        depth: depth + 1,
        expanded: canExpand,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
      });

      if (canExpand) {
        queue.push({ node: child, rect: r, depth: depth + 1 });
      }
    }
  }

  return out;
}

/** Locate the node with exactly this path inside a scanned tree, or null. */
export function findNodeByPath(root: FileNode, targetPath: string): FileNode | null {
  if (root.path === targetPath) return root;
  if (root.type !== 'dir' || !root.children) return null;
  // The target must live under a child whose path prefixes it.
  for (const child of root.children) {
    if (targetPath === child.path || targetPath.startsWith(child.path + sep(child.path))) {
      const found = findNodeByPath(child, targetPath);
      if (found) return found;
    }
  }
  return null;
}

function sep(p: string): string {
  return p.includes('\\') ? '\\' : '/';
}

/* ══════════════════ v4 §6.3 — Lasso select ══════════════════

   A treemap is a *spatial* interface and, until now, the app offered no
   spatial selection: the only way to stage a cluster of files that plainly
   belong together was to find each of them again in a list. This is the
   affordance the picture has been implying since it shipped.

   ── The gesture, and one place the spec contradicts itself ──

   §6.3 asks for "rubber-band (drag) and freehand (hold Alt)" and, in the next
   sentence, for "Shift extends, Alt subtracts". Alt cannot do both. Freehand
   wins, because a modifier that changes the SHAPE of a gesture has to be
   decided before the drag starts, while add-or-subtract can be decided at any
   point during it — so subtract moves to ⌘ / Ctrl, and Shift keeps its job.

     drag                  → rubber band
     ⌥ drag                → freehand
     ⇧ drag (or plain)     → stage what is enclosed
     ⌘ / Ctrl drag         → take what is enclosed back out of the cart
     Disk City             → a modifier is REQUIRED, because a plain drag pans

   **No gesture ever empties the cart.** A plain lasso adds; the only way to
   remove is to say so with ⌘. §6.3's "Shift extends" reads as though plain
   should replace, and replace is the one behaviour that could silently throw
   away staging done in four other views. Shift is accepted as a synonym for
   add so the muscle memory works, and nothing clears.

   ── What can be caught ──

   Everything whose own centre falls inside the region, taken from the FRONTIER
   of whatever is drawn — treemap leaves, packed leaf circles, leaf Voronoi
   cells, Disk City blocks. Those sets never nest, which is the property that
   matters: a lasso that caught a folder and its children would stage the same
   bytes twice and report a total the disk does not have.

   The sunburst is the one renderer without a lasso, and that is why: its rings
   are drawn nested, so "everything whose centre is inside" is exactly the
   double-count above. Naming the exclusion beats an unexplained dead gesture.

   Staging only. Nothing here deletes; the cart runs its own dry run and its
   own confirmation (§4.4), and both of those still have to happen.            */

/**
 * Is a point inside a lasso path? Winding number, not even-odd.
 *
 * Deliberately the same rule Canvas2D's default `fill()` uses, because the
 * lasso is drawn filled while it is being dragged: with even-odd, a freehand
 * scribble that crossed itself would show one shape and select another, and
 * the whole point of a spatial selection is that you can see what you caught.
 * A self-crossed loop keeps everything it went around.
 */
function lassoContains(pts, px, py) {
  let winding = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j], b = pts[i];
    if (a.y <= py) {
      if (b.y > py && (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y) > 0) winding++;
    } else if (b.y <= py && (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y) < 0) winding--;
  }
  return winding !== 0;
}

/** Bounds of a lasso path, so a candidate can be rejected without the full test. */
function lassoBounds(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return pts.length ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 0, y1: 0 };
}

/** A rubber band, as a path, so there is one containment rule and not two. */
function lassoRectPath(a, b) {
  return [
    { x: a.x, y: a.y }, { x: b.x, y: a.y },
    { x: b.x, y: b.y }, { x: a.x, y: b.y },
  ];
}

/**
 * Add a point to a freehand path, but only when it has actually moved.
 *
 * A pointer sitting still emits move events anyway, and a path with four
 * hundred coincident vertices makes both the winding test and the stroke
 * measurably slower for no shape at all.
 */
function lassoPush(pts, x, y) {
  const last = pts[pts.length - 1];
  if (last && Math.abs(last.x - x) < 2 && Math.abs(last.y - y) < 2) return;
  pts.push({ x, y });
}

/* ── What is on screen, and where its centre is ──────────────────────────── */

/**
 * The frontier of the current renderer: one entry per drawn thing that has
 * nothing drawn inside it, with the centre the lasso tests.
 *
 * Anything that cannot be staged is left out here rather than filtered later,
 * so the count in the badge is the count that will be staged. That includes
 * §4.3's freed blocks (a hypothetical, not a file), archive entries (which are
 * a listing, not a path — `403 VIRTUAL_PATH`), and the synthetic Trash cell.
 */
function lassoTargets() {
  const out = [];
  /* Why a shape cannot be staged, or null when it can.
     Returned rather than filtered away, because "your loop caught nothing"
     and "everything your loop caught is an archive listing" are different
     facts and only one of them is actionable. Inside a .zip every block on
     screen is a virtual entry, and a lasso there used to report an empty
     loop over a map visibly full of things. */
  const skipReason = (n) => {
    if (!n || !n.path || n.isTrash) return null; // the Trash cell is not a path
    // Only one reason, because only one is reachable. §4.3's freed blocks are
    // the other unstageable thing on any map, and a lasso cannot be started
    // while the preview is up — so a message about them could never be read.
    if (n.virtual) return 'entries inside an archive, which is a listing rather than files on disk';
    return null;
  };
  const usable = (n) => n && n.path && !n.freed && !n.virtual && !n.isTrash;
  if (state.view === 'city') {
    const tx = cityTransform(
      Math.max(120, $('cityWrap').clientWidth),
      Math.max(120, $('cityWrap').clientHeight),
    );
    for (const b of state.city.blocks) {
      const skip = skipReason(b.n);
      if (!skip && !usable(b.n)) continue;
      // The centre of the roof, not of the footprint: the roof is what the
      // user sees and drags a loop around, and on a tall tower the two are
      // most of a building apart.
      const p = isoProject(b.x + b.w / 2, b.y + b.h / 2, b.z);
      out.push({ n: b.n, x: p.sx * tx.s + tx.dx, y: p.sy * tx.s + tx.dy, skip });
    }
    return out;
  }
  if (isCells()) {
    for (const c of state.treemap.cells) {
      if (!c.leaf) continue;
      const skip = skipReason(c.n);
      if (!skip && !usable(c.n)) continue;
      out.push({ n: c.n, x: c.cx, y: c.cy, skip });
    }
    return out;
  }
  for (const r of state.treemap.pxRects) {
    if (r.frame) continue;
    const skip = skipReason(r.n);
    if (!skip && !usable(r.n)) continue;
    out.push({ n: r.n, x: r.x + r.w / 2, y: r.y + r.h / 2, skip });
  }
  return out;
}

/**
 * Everything the current path encloses, split by whether it can be staged.
 *
 * `hits` is what the badge counts and what the cart receives. `skipped` is
 * everything the loop genuinely went around that cannot be staged, grouped by
 * the reason, so the toast can name it instead of saying "nothing".
 */
function lassoCaught() {
  const l = state.lasso;
  const empty = { hits: [], skipped: new Map() };
  if (!l.on || l.pts.length < 3) return empty;
  const bb = lassoBounds(l.pts);
  const hits = [];
  const skipped = new Map();
  for (const t of lassoTargets()) {
    if (t.x < bb.x0 || t.x > bb.x1 || t.y < bb.y0 || t.y > bb.y1) continue;
    if (!lassoContains(l.pts, t.x, t.y)) continue;
    if (t.skip) skipped.set(t.skip, (skipped.get(t.skip) || 0) + 1);
    else hits.push(t.n);
  }
  return { hits, skipped };
}

/* ── The gesture ────────────────────────────────────────────────────────── */

/** Which renderers offer a lasso, and why the sunburst does not. */
function lassoAvailable() {
  if (state.view === 'city') return true;
  if (state.view !== 'treemap') return false;
  return !isSun(); // nested rings would stage a folder and its contents twice
}

/** Read the modifiers into an operation, once, where the mapping is written down. */
function lassoOpFor(e) {
  return (e.metaKey || e.ctrlKey) ? 'remove' : 'add';
}

function lassoStart(e, canvas) {
  const local = Canvas2D.toLocal(canvas, e.clientX, e.clientY);
  state.lasso = {
    on: true,
    free: e.altKey,
    op: lassoOpFor(e),
    origin: local,
    pts: [local],
    moved: false,
    canvas,
  };
}

function lassoMove(e) {
  const l = state.lasso;
  if (!l.on) return;
  const local = Canvas2D.toLocal(l.canvas, e.clientX, e.clientY);
  if (Math.abs(local.x - l.origin.x) > 5 || Math.abs(local.y - l.origin.y) > 5) l.moved = true;
  if (l.free) lassoPush(l.pts, local.x, local.y);
  else l.pts = lassoRectPath(l.origin, local);
  lassoRepaint();
}

/**
 * Finish the gesture.
 *
 * Returns whether it was a real lasso, so the caller can suppress the click
 * that a pointer-up would otherwise become — a drag that ends up staging forty
 * files must not also drill into whatever was under the release.
 */
function lassoEnd() {
  const l = state.lasso;
  if (!l.on) return false;
  const real = l.moved;
  const caught = real ? lassoCaught() : { hits: [], skipped: new Map() };
  const op = l.op;
  state.lasso = { on: false, pts: [] };
  lassoRepaint();
  if (!real) return false;
  lassoApply(caught, op);
  return true;
}

function lassoCancel() {
  if (!state.lasso.on) return;
  state.lasso = { on: false, pts: [] };
  lassoRepaint();
}

/**
 * Stage or unstage what was caught.
 *
 * Says the count and the bytes out loud, including the ones that were already
 * staged, because "142 selected" over a cart that grew by nine is a true
 * sentence that reads as a false one.
 */
function lassoApply(caught, op) {
  const hits = caught.hits;
  if (!hits.length) {
    // Name the reason when there is one. A loop drawn inside an archive goes
    // around plenty of things and can stage none of them, and "nothing inside
    // that loop" over a map full of blocks reads as a broken gesture rather
    // than as the guarantee it actually is.
    const reasons = [...caught.skipped.entries()].sort((a, b) => b[1] - a[1]);
    if (reasons.length) {
      const [why, n] = reasons[0];
      toast(
        `${formatCount(n)} thing${n === 1 ? '' : 's'} in that loop cannot be staged: ${why}.`,
        'error', 7000,
      );
      return;
    }
    toast(op === 'remove' ? 'Nothing staged inside that loop' : 'Nothing inside that loop', 'error');
    return;
  }
  let changed = 0, bytes = 0;
  for (const n of hits) {
    if (op === 'remove') {
      if (state.cart.delete(n.path)) { changed++; bytes += n.size || 0; }
    } else if (!state.cart.has(n.path)) {
      state.cart.add(n.path);
      changed++;
      bytes += n.size || 0;
    }
  }
  saveCart();
  void renderCart();
  refreshCartButtons();
  const already = hits.length - changed;
  if (op === 'remove') {
    toast(
      `Took ${formatCount(changed)} item${changed === 1 ? '' : 's'} (${formatBytes(bytes)}) out of the cart` +
      (already ? ` — ${formatCount(already)} of the ${formatCount(hits.length)} caught ${already === 1 ? 'was' : 'were'} not in it` : ''),
      changed ? 'success' : 'error',
    );
    return;
  }
  toast(
    `Staged ${formatCount(changed)} item${changed === 1 ? '' : 's'} (${formatBytes(bytes)})` +
    (already ? ` — ${formatCount(already)} ${already === 1 ? 'was' : 'were'} already in the cart` : '') +
    '. Nothing has been deleted.',
    changed ? 'success' : 'error',
  );
}

/* ── Drawing it ─────────────────────────────────────────────────────────── */

function lassoRepaint() {
  if (state.view === 'city') { cityInvalidate(); return; }
  presentView();
}

/**
 * The loop, and a running count of what is inside it.
 *
 * The count is the whole reason this is worth drawing rather than just
 * selecting: a lasso you cannot see the consequence of until you let go is a
 * gesture you have to undo to understand. Recomputed per frame, which is a
 * point-in-polygon test per drawn thing — a few thousand at most, and measured
 * at well under a millisecond on a full map.
 */
function lassoPaint(ctx) {
  const l = state.lasso;
  if (!l.on || l.pts.length < 2) return;
  const accent = cssVar('--accent') || '#0A84FF';
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(l.pts[0].x, l.pts[0].y);
  for (let i = 1; i < l.pts.length; i++) ctx.lineTo(l.pts[i].x, l.pts[i].y);
  ctx.closePath();
  ctx.fillStyle = l.op === 'remove' ? 'rgba(255,69,58,0.12)' : 'rgba(10,132,255,0.12)';
  ctx.fill();
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = l.op === 'remove' ? (cssVar('--danger') || '#FF453A') : accent;
  ctx.stroke();
  ctx.setLineDash([]);

  if (!l.moved) { ctx.restore(); return; }
  const caught = lassoCaught().hits;
  let bytes = 0;
  for (const n of caught) bytes += n.size || 0;
  const label = `${formatCount(caught.length)} item${caught.length === 1 ? '' : 's'} · ${formatBytes(bytes)}` +
    (l.op === 'remove' ? ' · release to unstage' : '');
  const last = l.pts[l.pts.length - 1];
  ctx.font = '600 11.5px -apple-system, sans-serif';
  const w = ctx.measureText(label).width + 16;
  const bx = Math.max(4, last.x + 12), by = Math.max(4, last.y - 30);
  Canvas2D.roundRect(ctx, bx, by, w, 22, 11);
  ctx.fillStyle = 'rgba(20,20,26,0.88)';
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, bx + 8, by + 11.5);
  ctx.restore();
}

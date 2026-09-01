/* ───────────────────────────── Treemap view ───────────────────────────── */
const tmCanvas = $('treemapCanvas');
const tmCtx = tmCanvas.getContext('2d');
/* Offscreen buffer: the full cushion render happens once per layout/theme;
   hover frames just blit the buffer + draw a highlight, keeping mousemove cheap. */
const tmBuffer = document.createElement('canvas');
const tmBufCtx = tmBuffer.getContext('2d');
/* Second overlay buffer for search dim/highlight, so typing and hovering
   never re-render the cushion pass. */
const tmSearchBuffer = document.createElement('canvas');
const tmSearchCtx = tmSearchBuffer.getContext('2d');

let tmLoadSeq = 0;
async function loadTreemap(rootPath, animate = false) {
  if (!state.scanId) return;
  // §4.3 — a preview is a picture of one folder with one cart. Any load
  // replaces both, so it is dropped silently rather than left to go stale.
  exitCartPreview(true);
  const seq = ++tmLoadSeq;
  state.treemap.kbSel = null;
  // Captured before the tree is replaced: which node will still be on screen
  // afterwards, and where it is right now. Drilling in, that is the folder
  // being opened; climbing out, it is the one being left.
  let shared = null, wasAt = null;
  if (state.treemap.mode === 'circles' && state.treemap.rootPath && rootPath !== state.treemap.rootPath) {
    if (rootPath.startsWith(state.treemap.rootPath)) shared = rootPath;
    else if (state.treemap.rootPath.startsWith(rootPath)) shared = state.treemap.rootPath;
    if (shared) wasAt = altCircleFor(shared);
  }
  const zoom = $('treemapZoom');
  if (animate && !REDUCED) zoom.classList.add('zooming');
  try {
    if (isSun() || isCells()) {
      // The sunburst and §6.2's two renderers lay out client-side from the
      // in-memory tree, so unlike the treemap they need the real children —
      // fetch them if this branch was pruned, otherwise they draw a hollow
      // ring, or an empty circle, for a folder full of files.
      const node = (await ensureSubtree(rootPath)) || state.root;
      if (seq !== tmLoadSeq) return; // superseded while fetching
      if (!node) return;
      state.treemap.rootPath = node.path;
      state.treemap.rootName = node.name;
      state.treemap.rootSize = node.size;
      state.treemap.nodes = [];
      state.treemap.hover = null;
      renderCrumbs($('tmCrumbs'), state.treemap.rootPath, (p) => loadTreemap(p, true));
      $('tmUpBtn').disabled = !state.root || state.treemap.rootPath === state.root.path;
      exitHistoryState();
      refreshTimebar();
      if (isSun()) { drawSunburst(); }
      else {
        drawCells();
        // §6.2's zoom between levels. `shared` is whichever of the two roots
        // contains the other — the one node on screen both before and after,
        // and therefore the only thing the eye can follow across the change.
        if (state.treemap.mode === 'circles' && wasAt) altBeginZoom(shared, wasAt);
      }
    } else {
      const data = await api(`/api/scan/${state.scanId}/treemap?maxDepth=${state.treemap.maxDepth}&minSize=4096&root=${encodeURIComponent(rootPath)}`);
      if (seq !== tmLoadSeq) return; // a newer view/root load has superseded this fetch
      state.treemap.rootPath = data.root.path;
      state.treemap.rootName = data.root.name;
      state.treemap.rootSize = data.root.size;
      state.treemap.nodes = data.nodes;
      state.treemap.hover = null;
      renderCrumbs($('tmCrumbs'), state.treemap.rootPath, (p) => loadTreemap(p, true));
      $('tmUpBtn').disabled = !state.root || state.treemap.rootPath === state.root.path;
      maybeInjectTrash();
      exitHistoryState();
      refreshTimebar();
      drawTreemap();
    }
  } catch (e) {
    toast('Treemap failed: ' + e.message, 'error');
  } finally {
    if (animate && !REDUCED) requestAnimationFrame(() => requestAnimationFrame(() => zoom.classList.remove('zooming')));
  }
}

/** Shared breadcrumb renderer (treemap + grid). */
function renderCrumbs(host, path, onPick) {
  const crumbs = breadcrumbsFor(path);
  host.innerHTML = crumbs.map((c, i) => {
    const cur = i === crumbs.length - 1;
    return `${i ? '<span class="sep">' + icon('chevronRight', 12) + '</span>' : ''}` +
      `<button data-p="${escapeHtml(c.path)}" aria-current="${cur}" title="${escapeHtml(c.path)}">` +
      `${i === 0 ? icon('hardDrive', 13) : ''}${escapeHtml(c.name)}</button>`;
  }).join('');
  host.querySelectorAll('button').forEach(b => {
    // hideTooltip: the card describes a cell of the map being navigated away
    // from — QA caught a keyboard-selection tooltip surviving a crumb jump
    // and floating over the palette opened next.
    b.addEventListener('click', () => { hideTooltip(); onPick(b.dataset.p); });
    // Right-click a breadcrumb folder to set/edit its budget (Feature 15).
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const node = nodeFor(b.dataset.p);
      if (node && node.type === 'dir') openBudgetDialog(node);
    });
  });
}

function breadcrumbsFor(path) {
  const root = state.root;
  if (!root) return [];
  const crumbs = [{ name: root.name, path: root.path }];
  if (path === root.path) return crumbs;
  const sep = root.path.includes('\\') ? '\\' : '/';
  const rel = path.slice(root.path.length).split(sep).filter(Boolean);
  let acc = root.path;
  for (const part of rel) {
    acc = acc.endsWith(sep) ? acc + part : acc + sep + part;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
}

/** Render the treemap footer legend for the active color mode. */
function renderTmLegend() {
  const host = $('tmLegend');
  if (!host) return;
  if (state.treemap.history.active && state.treemap.history.diff) {
    const bands = [
      { rgb: C_TEAL, label: 'grew' },
      { rgb: C_RED, label: 'shrank' },
      { rgb: C_DIFF_SAME, label: 'unchanged' },
    ];
    host.innerHTML = '<div class="tm-legend-bands">' + bands.map((b) =>
      `<span class="ab"><i class="sw" style="background:rgb(${b.rgb[0]},${b.rgb[1]},${b.rgb[2]})"></i>${b.label}</span>`
    ).join('') + '</div>';
    return;
  }
  if (state.treemap.colorMode === 'age') {
    host.innerHTML = '<div class="tm-legend-bands">' + AGE_BANDS.map((b) =>
      `<span class="ab"><i class="sw" style="background:rgb(${b.rgb[0]},${b.rgb[1]},${b.rgb[2]})"></i>${b.label}</span>`
    ).join('') + '</div>';
  } else if (state.treemap.colorMode === 'reclaim') {
    // §3.3 asks for "a legend and a one-line explanation of what the colours
    // mean". The unscored swatch earns its place: it is not the bottom of the
    // ramp, and a viewer who reads it as "safe to leave" has been misled.
    const bands = [
      { rgb: C_RC_LOW, label: 'keep' },
      { rgb: C_AMBER, label: 'maybe' },
      { rgb: C_TEAL, label: 'safest to reclaim' },
      { rgb: C_RC_UNSCORED, label: 'not scored' },
    ];
    host.innerHTML = '<div class="tm-legend-bands">' + bands.map((b) =>
      `<span class="ab"><i class="sw" style="background:rgb(${b.rgb[0]},${b.rgb[1]},${b.rgb[2]})"></i>${b.label}</span>`
    ).join('') + '</div>' +
      `<span class="rc-legend-note">Greener means safer and more worthwhile to delete — right-click a cell for the reasoning.${reclaimCoverageNote()}</span>`;
  } else {
    host.innerHTML = '<span>1 MB</span><div class="legend-grad"></div><span>10 GB+</span>';
  }
}

/**
 * How much of what is on screen actually carries a score.
 *
 * §2.4: partial is stated, not hidden. Everything unscored paints in the same
 * grey, and without this the viewer cannot tell a cell TreeMap could not
 * score from one it simply has not reached — 2,716 of 4,717 cells on a real
 * repository, in the run that prompted this. Silence there reads as "these
 * are all fine", which is a claim nobody made.
 *
 * Says nothing when everything drawn is scored, because a line reading
 * "4,717 of 4,717" on every map is the noise that stops people reading the
 * one that matters.
 */
function reclaimCoverageNote() {
  const drawn = drawnCells();
  let total = 0;
  let scored = 0;
  let unscorable = 0;
  for (const r of drawn) {
    const p = r.n && r.n.path;
    if (!p || r.n.freed) continue; // §4.3 — not a file, so not part of coverage
    total++;
    if (!reclaim.scores.has(p)) continue;
    if (reclaim.scores.get(p) === null) unscorable++;
    else scored++;
  }
  if (total === 0 || scored + unscorable >= total) {
    // Everything on screen was asked about. Name the ones that came back
    // unanswerable, since those are grey for a real reason.
    return unscorable > 0
      ? ` ${formatCount(unscorable)} of ${formatCount(total)} could not be scored.`
      : '';
  }
  return ` Scored ${formatCount(scored)} of ${formatCount(total)} on screen`
    + (total > TM_SCORE_CAP ? ` — TreeMap stops at ${formatCount(TM_SCORE_CAP)} at a time; drill in to score the rest.` : '; the rest are still loading.');
}

/**
 * Height for the treemap/sunburst canvas, measured rather than guessed.
 *
 * This used to be `innerHeight - 300`, a reserve big enough for the toolbar,
 * the time slider, the legend and the page padding all at once — which left
 * about 126 px of dead space below the chart on a 720 px-tall window. Measure
 * what is actually above and below instead, so the chart fills the window and
 * still fits when the toolbar wraps to two lines.
 */
function treemapCanvasHeight(wrap) {
  const top = wrap.getBoundingClientRect().top;
  // Called before the view is laid out (hidden tab): fall back to the floor.
  if (!(top > 0)) return 420;
  const cs = getComputedStyle(wrap);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const foot = wrap.parentElement && wrap.parentElement.querySelector('.tm-foot');
  const below = foot
    ? foot.getBoundingClientRect().height + parseFloat(getComputedStyle(foot).marginTop)
    : 28;
  const main = wrap.closest('main');
  const mainPadB = main ? parseFloat(getComputedStyle(main).paddingBottom) : 24;
  return Math.max(360, Math.floor(window.innerHeight - top - padY - below - mainPadB));
}

function drawTreemap() {
  const wrap = $('treemapWrap');
  const cssW = wrap.clientWidth - 20;
  const cssH = treemapCanvasHeight(wrap);
  const dpr = window.devicePixelRatio || 1;
  tmCanvas.style.width = cssW + 'px';
  tmCanvas.style.height = cssH + 'px';
  const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
  if (tmCanvas.width !== pw) tmCanvas.width = pw;
  if (tmCanvas.height !== ph) tmCanvas.height = ph;
  if (tmBuffer.width !== pw) tmBuffer.width = pw;
  if (tmBuffer.height !== ph) tmBuffer.height = ph;

  const ctx = tmBufCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = cssVar('--tm-canvas-bg');
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.textAlign = 'left'; // reset — sunburst leaves textAlign='center' on the shared buffer ctx

  const px = [];
  for (const n of state.treemap.nodes) {
    if (state.treemap.hideCloud && n.cloudPlaceholder) continue;
    const x = (n.x / 100) * cssW, y = (n.y / 100) * cssH;
    const w = (n.w / 100) * cssW, h = (n.h / 100) * cssH;
    if (w * h < 1) continue;
    px.push({ n, x, y, w, h, frame: n.expanded });
  }
  state.treemap.pxRects = px;

  // Pass 1: cushion-shaded leaf fills.
  for (const r of px) {
    if (r.frame) continue;

    /* v4 §4.3 — a freed region. Hatched rather than filled, because the space
       is not there yet: a solid block would read as "this is what you have",
       which is exactly the false statement the preview exists to avoid. Same
       reasoning as A3's hollow cloud placeholders, and the same visual family. */
    if (r.n.freed) {
      ctx.fillStyle = cssVar('--tm-canvas-bg');
      ctx.fillRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.w - 1), Math.max(1, r.h - 1));
      const hatch = tmHatchPattern(ctx);
      if (hatch) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = hatch;
        ctx.fillRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.w - 1), Math.max(1, r.h - 1));
        ctx.restore();
      }
      if (r.w > 6 && r.h > 6) {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = cssVar('--warn') || '#FF9F0A';
        ctx.strokeRect(r.x + 1, r.y + 1, Math.max(1, r.w - 2), Math.max(1, r.h - 2));
        ctx.restore();
      }
      continue;
    }

    const base = r.n.isTrash ? [108, 122, 137] : cellRgb(r.n); // distinct gray-blue for the Trash cell
    const depthFade = Math.max(0.55, 1 - r.n.depth * 0.08);

    /* A3 — a cloud placeholder is drawn hollow, because it is not here.
       A solid block the size of a 4 GB video says "this is filling your disk",
       which for an evicted file is precisely the false statement A3 exists to
       correct. The faint fill plus a dashed outline reads as an outline of
       something absent, and the cloud glyph in pass 5 names the reason. */
    if (r.n.cloudPlaceholder && r.w > 6 && r.h > 6) {
      ctx.fillStyle = `rgba(${base[0]},${base[1]},${base[2]},${0.16 * depthFade})`;
      ctx.fillRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.w - 1), Math.max(1, r.h - 1));
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(${base[0]},${base[1]},${base[2]},0.85)`;
      ctx.strokeRect(r.x + 1, r.y + 1, Math.max(1, r.w - 2), Math.max(1, r.h - 2));
      ctx.restore();
      continue;
    }

    const top = mix(base, [255,255,255], 0.16);
    const bot = mix(base, [0,0,0], 0.22);
    const g = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
    g.addColorStop(0, `rgba(${top[0]},${top[1]},${top[2]},${0.95 * depthFade})`);
    g.addColorStop(1, `rgba(${bot[0]},${bot[1]},${bot[2]},${0.95 * depthFade})`);
    ctx.fillStyle = g;
    ctx.fillRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.w - 1), Math.max(1, r.h - 1));
    if (r.w > 6 && r.h > 6) {
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(r.x + 1, r.y + 1); ctx.lineTo(r.x + r.w - 1, r.y + 1);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    }
  }
  // Pass 2: directory frames.
  for (const r of px) {
    if (!r.frame) continue;
    ctx.strokeStyle = `rgba(255,255,255,${Math.max(0.12, 0.3 - r.n.depth * 0.05)})`;
    ctx.lineWidth = r.n.depth <= 1 ? 1.5 : 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
  }
  // Pass 2.5: diff wash over expanded directories (history diff mode only).
  // A folder's own growth/shrinkage must show even when its visible children
  // didn't change — e.g. it shrank because a child was deleted outright.
  if (state.treemap.history.active && state.treemap.history.diff) {
    for (const r of px) {
      if (!r.frame) continue;
      const c = diffRgb(r.n);
      if (c === C_DIFF_SAME) continue;
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.3)`;
      ctx.fillRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.w - 1), Math.max(1, r.h - 1));
    }
  }
  // Pass 3: top-level directory name tags.
  ctx.textBaseline = 'middle';
  const tagRects = [];
  for (const r of px) {
    if (!r.frame || r.n.depth !== 1 || r.w < 90 || r.h < 44) continue;
    const label = r.n.name;
    ctx.font = '600 10.5px -apple-system, sans-serif';
    const tw = Math.min(ctx.measureText(label).width, r.w - 26);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(ctx, r.x + 5, r.y + 5, tw + 14, 18, 9);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillText(label, r.x + 12, r.y + 14.5, r.w - 26);
    tagRects.push({ x: r.x + 5, y: r.y + 5, w: tw + 14, h: 18 });
  }
  // Pass 4: leaf labels (only when ≥ 40 px wide).
  //
  // The folder tag above is an overlay, not a reserved header row, so a child
  // sitting in its parent's top-left corner would print its name straight
  // through the tag — two strings on the same pixels, neither readable. Drop
  // the label below the tag when the cell is tall enough to take it, and leave
  // it out when it is not; the cell keeps its tooltip either way.
  // Pass 3.5 (v4 §4.3): name each freed block, so the hatched area is not a
  // mystery. Its own pass rather than part of pass 1, which must draw no text —
  // the contract test's leaf-fill slice ends at the first textBaseline it finds.
  if (tmPreview.on) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 11px -apple-system, sans-serif';
    ctx.fillStyle = cssVar('--text-1');
    for (const r of px) {
      if (!r.n.freed || r.w < 74 || r.h < 26) continue;
      ctx.fillText('Freed ' + formatBytes(r.n.size), r.x + r.w / 2, r.y + r.h / 2, r.w - 10);
    }
    ctx.restore();
    ctx.textAlign = 'left'; // pass 4 assumes it, and save/restore does not cover a later pass
  }

  ctx.textBaseline = 'top';
  for (const r of px) {
    if (r.frame || r.n.freed || r.w < 40 || r.h < 15) continue;
    let ty = r.y + 4;
    const clash = tagRects.find(t =>
      r.x + 5 < t.x + t.w && r.x + r.w - 5 > t.x && ty < t.y + t.h && ty + 12 > t.y);
    if (clash) {
      const shifted = clash.y + clash.h + 3;
      if (shifted + 12 > r.y + r.h) continue;
      ty = shifted;
    }
    const label = r.n.name;
    ctx.font = '500 11px -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    const maxChars = Math.floor((r.w - 10) / 6.2);
    const text = label.length > maxChars ? label.slice(0, Math.max(1, maxChars - 1)) + '…' : label;
    ctx.fillText(text, r.x + 5, ty, r.w - 10);
    if (r.y + r.h - ty > 26) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.font = '10px -apple-system, sans-serif';
      ctx.fillText(formatBytes(r.n.size), r.x + 5, ty + 13, r.w - 10);
    }
  }

  // Pass 5: cloud-placeholder markers (online-only files).
  for (const r of px) {
    if (r.frame || !r.n.cloudPlaceholder || r.w < 18 || r.h < 16) continue;
    const bx = r.x + r.w - 12, by = r.y + 8, s = 7;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    ctx.arc(bx - s * 0.35, by, s * 0.4, 0, Math.PI * 2);
    ctx.arc(bx + s * 0.1, by - s * 0.28, s * 0.5, 0, Math.PI * 2);
    ctx.arc(bx + s * 0.55, by, s * 0.38, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(bx - s * 0.35, by, s * 0.9, s * 0.45);
  }

  // Pass 6: git-repository markers (small branch glyph).
  for (const r of px) {
    if (!r.n.gitRepo || r.w < 70 || r.h < 40) continue;
    const gx = r.x + r.w - 17, gy = r.y + 11;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(gx, gy + 5, 2.1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(gx + 7, gy - 4, 2.1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(gx, gy + 4); ctx.lineTo(gx, gy - 2); ctx.quadraticCurveTo(gx, gy - 4, gx + 5, gy - 4); ctx.stroke();
  }

  // Pass 7: container badges (Feature 23) — drillable archives get a dashed
  // indigo border and a small box glyph. Virtual entries inside stay plain.
  for (const r of px) {
    if (!r.n.container || r.n.virtual) continue;
    ctx.strokeStyle = 'rgba(94,92,230,0.9)';
    ctx.setLineDash([5, 3]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(r.x + 1.5, r.y + 1.5, Math.max(1, r.w - 3), Math.max(1, r.h - 3));
    ctx.setLineDash([]);
    if (r.w > 40 && r.h > 34) {
      const bx = r.x + r.w - 15, by = r.y + r.h - 15;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1.3;
      ctx.strokeRect(bx, by, 9, 8);
      ctx.beginPath(); ctx.moveTo(bx, by + 2.5); ctx.lineTo(bx + 9, by + 2.5); ctx.stroke();
    }
  }

  renderSearchOverlay();
  presentTreemap();
  renderTmLegend();
}

/* ── Search/filter: highlight matches, dim the rest — no re-layout. ── */
function treemapMatch(n, q) {
  if (q.startsWith('*.')) return n.type === 'file' && (n.extension || '') === q.slice(2);
  if (q.startsWith('.') && q.length > 1) return n.type === 'file' && (n.extension || '') === q.slice(1);
  return n.name.toLowerCase().includes(q);
}

function renderSearchOverlay() {
  if (tmSearchBuffer.width !== tmBuffer.width) tmSearchBuffer.width = tmBuffer.width;
  if (tmSearchBuffer.height !== tmBuffer.height) tmSearchBuffer.height = tmBuffer.height;
  const dpr = window.devicePixelRatio || 1;
  const ctx = tmSearchCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, tmSearchBuffer.width, tmSearchBuffer.height);

  const q = state.treemap.query.trim().toLowerCase();
  state.treemap.matches = 0;
  updateTmStatus();
  if (!q) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dark = document.documentElement.dataset.theme !== 'light';
  const scrim = dark ? 'rgba(8,8,11,0.78)' : 'rgba(238,240,244,0.82)';
  const accent = cssVar('--accent') || '#0A84FF';
  let matches = 0;

  // One predicate, chosen once. A bare word uses the original local rule —
  // instant, and the exact behaviour this box has always had. A grammar query
  // uses the paths the server's evaluator returned, so the browser never
  // parses the grammar and there is only ever one implementation of it (§7).
  const grammar = state.treemap.queryMode === 'grammar' && state.treemap.matchedPaths;
  const hits = state.treemap.matchedPaths;
  const isMatch = grammar ? (n) => hits.has(n.path) : (n) => treemapMatch(n, q);

  // v4 §6.2 — the same two passes over circles or Voronoi cells. Everything
  // non-matching is dimmed, parents included: a parent's exposed rim left
  // bright while its contents dim reads as a match that is not one.
  if (isCells()) {
    // One path for everything that did not match, filled once. Separately
    // filled shapes STACK where a child sits inside a folder that also did not
    // match, and a doubled scrim washes the map out — measured on a real query
    // where two matches were the only colour left on an almost white panel.
    // Non-zero winding unions the subpaths instead, so an overlap costs
    // nothing, which is what dimming should do.
    ctx.beginPath();
    let anyDim = false;
    for (const c of state.treemap.cells) {
      if (isMatch(c.n)) continue;
      if (c.kind === 'circle') {
        ctx.moveTo(c.cx + c.r, c.cy);
        ctx.arc(c.cx, c.cy, Math.max(0.4, c.r), 0, Math.PI * 2);
      } else {
        ctx.moveTo(c.poly[0].x, c.poly[0].y);
        for (let i = 1; i < c.poly.length; i++) ctx.lineTo(c.poly[i].x, c.poly[i].y);
        ctx.closePath();
      }
      anyDim = true;
    }
    if (anyDim) { ctx.fillStyle = scrim; ctx.fill(); }
    for (const c of state.treemap.cells) {
      if (!isMatch(c.n)) continue;
      matches++;
      altCellPath(ctx, c);
      ctx.strokeStyle = accent;
      ctx.lineWidth = c.leaf ? 1.5 : 2.5;
      ctx.stroke();
    }
    state.treemap.matches = matches;
    updateTmStatus();
    return;
  }

  // Dim non-matching leaves first, then outline matches on top.
  for (const r of state.treemap.pxRects) {
    if (r.frame) continue;
    if (!isMatch(r.n)) {
      ctx.fillStyle = scrim;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
  }
  for (const r of state.treemap.pxRects) {
    if (!isMatch(r.n)) continue;
    matches++;
    ctx.strokeStyle = accent;
    ctx.lineWidth = r.frame ? 2.5 : 1.5;
    ctx.strokeRect(r.x + 0.75, r.y + 0.75, Math.max(1, r.w - 1.5), Math.max(1, r.h - 1.5));
  }
  state.treemap.matches = matches;
  updateTmStatus();
}

function updateTmStatus() {
  const q = state.treemap.query.trim();
  if (state.treemap.history.active && !q) {
    const when = new Date(state.treemap.history.viewingAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    $('tmStatus').textContent = `Viewing ${when} · ${formatBytes(state.treemap.rootSize)} — drag the slider to Live to interact`;
    return;
  }
  // v4 §4.3 — while a preview is up, the drawn set is a hypothetical, and the
  // highlight overlay counts matches against it. Staging exactly what a query
  // matched therefore produced "0 matches for ext:log modified>90d" under a
  // map that had just hatched all twelve of them: a true sentence about the
  // preview, read as a false one about the query. The banner is the
  // authoritative message here, so the status line says what it is looking at.
  if (tmPreview.on) {
    $('tmStatus').textContent =
      `Preview · ${formatBytes(tmPreview.freedBytes)} would be freed · ${formatBytes(state.treemap.rootSize)} total today`;
    return;
  }
  if (q) {
    // The map draws what fits at this folder and depth; a grammar query is
    // answered over the whole scan. Naming only the drawn count made "1 match
    // for size>1gb" the headline above a message saying two matched — the
    // prominent number contradicting the honest one. A bare word has no server
    // total (`matchTotal` stays null): the local filter is the whole answer.
    const total = state.treemap.matchTotal;
    const drawn = state.treemap.matches;
    // In the disclosure form the noun belongs to `total`, not to `drawn`, and
    // a total of one is reachable: the single file the grammar matched can sit
    // outside this folder or below the drawn depth, which printed
    // "0 of 1 matches". Each branch therefore agrees with the number its own
    // noun counts.
    const counted = Number.isFinite(total) && total > drawn
      ? `${formatCount(drawn)} of ${formatCount(total)} match${total === 1 ? '' : 'es'}`
      : `${formatCount(drawn)} match${drawn === 1 ? '' : 'es'}`;
    $('tmStatus').textContent = `${counted} for “${q}” · ${formatBytes(state.treemap.rootSize)} total`;
    return;
  }
  // With no query the count belongs to whichever renderer drew: "nodes drawn"
  // means nothing about a sunburst's rings or §6.2's shapes, and writing it
  // anyway would overwrite a true line with a plausible one.
  if (isSun() || isCells()) return;
  // The noun has to follow the number. Drilling into a folder holding exactly
  // one file printed "1 nodes · 1 drawn · 394.0 KB total" — the app's most-read
  // line disagreeing with itself — because this sentence was the one counted
  // string that never picked up the house idiom the `match`/`matches` branch
  // above and every other counted line in the app already use. Each count is
  // pluralised on ITS OWN number: a big folder drawn down to a single visible
  // cell must not borrow the node count's "s". "drawn" stays bare on purpose —
  // its noun is elided, so it already agrees with whatever precedes it.
  const nodeCount = state.treemap.nodes.length;
  $('tmStatus').textContent =
    `${formatCount(nodeCount)} node${nodeCount === 1 ? '' : 's'}`
    + ` · ${formatCount(state.treemap.pxRects.length)} drawn · ${formatBytes(state.treemap.rootSize)} total`;
}
/* ───────────────────── Shared Canvas 2D toolkit (§3.4) ─────────────────────
   The primitives every canvas panel needs, in one place: DPR-correct sizing,
   rounded rects, label fitting, pointer→canvas coordinates, and hit-testing.

   The point is that a new visual panel reuses these rather than re-deriving
   them — hit detection especially, which is where a hand-rolled version
   silently disagrees with what was drawn. Before this existed, six functions
   each recomputed devicePixelRatio and one hit-tester was welded to the
   treemap's own rectangle list.

   Deliberately NOT force-fitted everywhere: the treemap draws through an
   offscreen double buffer and the donut is a fixed square, so their sizing
   genuinely differs. Sharing what is common beats pretending they are the same. */
const Canvas2D = {
  /**
   * Size a canvas for the device pixel ratio and return a ready 2D context.
   * Resizing a canvas clears it, so the dimensions are only assigned when they
   * actually change — otherwise every redraw would flash.
   */
  setup(canvas, cssW, cssH) {
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, dpr, width: cssW, height: cssH };
  },

  /** Rounded-rectangle path. Radius is clamped so thin cells can't invert. */
  roundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  },

  /** Pointer coordinates relative to a canvas's CSS box. */
  toLocal(canvas, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  },

  /**
   * Topmost rectangle under a point.
   *
   * `rects` are plain `{x, y, w, h}` in CSS pixels plus whatever payload the
   * caller carries. When rectangles nest — as a treemap's do — the deepest
   * match wins, which `depthOf` reports; without that, a click on a file inside
   * a folder would select the folder.
   */
  hitTest(rects, x, y, opts = {}) {
    const { skip, depthOf } = opts;
    let best = null, bestDepth = -Infinity;
    for (const r of rects) {
      if (skip && skip(r)) continue;
      if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
      const depth = depthOf ? depthOf(r) : 0;
      if (best === null || depth > bestDepth) { best = r; bestDepth = depth; }
    }
    return best;
  },

  /**
   * Truncate `text` with an ellipsis so it fits `maxWidth`, or null when even
   * the ellipsis will not fit. Binary search rather than character-by-character:
   * a treemap can label thousands of cells per frame, and `measureText` is the
   * expensive part.
   */
  fitText(ctx, text, maxWidth) {
    if (maxWidth <= 0) return null;
    if (ctx.measureText(text).width <= maxWidth) return text;
    if (ctx.measureText('…').width > maxWidth) return null;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid; else hi = mid - 1;
    }
    return lo > 0 ? text.slice(0, lo) + '…' : null;
  },

  /** A filled, optionally-outlined, optionally-labelled rounded cell. */
  drawCell(ctx, rect, opts = {}) {
    const { fill, stroke, strokeWidth = 1, radius = 3, label, labelColor = '#fff', font } = opts;
    this.roundRect(ctx, rect.x, rect.y, rect.w, rect.h, radius);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.lineWidth = strokeWidth; ctx.strokeStyle = stroke; ctx.stroke(); }
    if (!label) return;
    if (font) ctx.font = font;
    const fitted = this.fitText(ctx, label, rect.w - 10);
    if (fitted === null) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
    ctx.fillStyle = labelColor;
    ctx.textBaseline = 'top';
    ctx.fillText(fitted, rect.x + 5, rect.y + 4);
    ctx.restore();
  },
};

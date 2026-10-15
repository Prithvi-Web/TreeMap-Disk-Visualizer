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

/**
 * The rectangle map's floor: files smaller than this get no rectangle (the
 * request's minSize). One number for the request, the live re-layout and the
 * sentence that admits it (tmNodeCapNote). The floor a map on screen was
 * actually asked with is state.treemap.minSize — loadTreemap drops this one
 * for a folder of small files (QA-6b review F1.2). 4 KB in the decimal units
 * the sentence prints it in (QA D09): 4096 read as "files under 4.1 KB".
 */
const TM_MIN_SIZE = 4000;

let tmLoadSeq = 0;
async function loadTreemap(rootPath, animate = false) {
  if (!state.scanId) return;
  // §4.3 — a preview is a picture of one folder with one cart. Any load
  // replaces both, so it is dropped silently rather than left to go stale.
  exitCartPreview(true);
  const seq = ++tmLoadSeq;
  const scanAtRequest = state.scanId; // the scan whatever lands here was asked of (C03)
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
      // A scrub is in flight: its landing draws. A live layout must not land
      // under the hand — it would exit history and park the thumb at Live.
      if (state.treemap.history.scrubbing) return;
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
      tmSetEmpty(''); // the rectangle map's note does not describe these renderers
      // Through drawView, never the renderer's own draw: drawView is where the
      // Reclaim colour mode asks for the scores of what was just drawn. Drawn
      // directly, a drill-in, an Up, a crumb or a renderer switch kept the
      // previous layout's scores — Voronoi's 210 on a 9,432-cell treemap,
      // painted grey under a legend blaming a cap nobody reached (QA D28).
      drawView();
      // §6.2's zoom between levels. `shared` is whichever of the two roots
      // contains the other — the one node on screen both before and after,
      // and therefore the only thing the eye can follow across the change.
      if (state.treemap.mode === 'circles' && wasAt) altBeginZoom(shared, wasAt);
    } else {
      let floor = TM_MIN_SIZE; // the floor the map on screen will have been asked with
      let data = await api(`/api/scan/${state.scanId}/treemap?maxDepth=${state.treemap.maxDepth}&minSize=${TM_MIN_SIZE}&root=${encodeURIComponent(rootPath)}`);
      if (seq !== tmLoadSeq) return; // a newer view/root load has superseded this fetch
      // The 4 KB floor keeps a big folder's map legible; in a folder of
      // dotfiles, scripts or one small file it hides everything, and a blank
      // panel reads as a broken app. When it drew nothing and there are bytes
      // to draw, ask again without the floor.
      if (!data.nodes.length && data.root.size > 0) {
        floor = 1;
        data = await api(`/api/scan/${state.scanId}/treemap?maxDepth=${state.treemap.maxDepth}&minSize=1&root=${encodeURIComponent(rootPath)}`);
        if (seq !== tmLoadSeq) return;
      }
      if (state.treemap.history.scrubbing) return; // same rule as above: a scrub in flight owns the map
      state.treemap.rootPath = data.root.path;
      state.treemap.rootName = data.root.name;
      state.treemap.rootSize = data.root.size;
      state.treemap.nodes = data.nodes;
      // Which scan and folder these rectangles are, and which array: Disk City
      // reuses them only while this very array is the one on the map (C03 —
      // loadCity says why). The folder's size and the floor ride with them:
      // they are what the city's line and size say of a city built from them.
      state.treemap.nodesFor = { scanId: scanAtRequest, path: data.root.path, nodes: data.nodes, size: data.root.size, minSize: floor };
      state.treemap.minSize = floor; // what tmNodeCapNote may say this map leaves out
      state.treemap.hover = null;
      renderCrumbs($('tmCrumbs'), state.treemap.rootPath, (p) => loadTreemap(p, true));
      $('tmUpBtn').disabled = !state.root || state.treemap.rootPath === state.root.path;
      maybeInjectTrash();
      exitHistoryState();
      refreshTimebar();
      drawView(); // the scores follow the drawn set — see the branch above
    }
  } catch (e) {
    toast('Treemap failed: ' + e.message, 'error');
  } finally {
    if (animate && !REDUCED) requestAnimationFrame(() => requestAnimationFrame(() => zoom.classList.remove('zooming')));
  }
}

/* ── Breadcrumbs: fold, never clip (QA D25) ──
   A deep trail used to overflow past its start edge under the mask's fade:
   ancestors were cut mid-word ("eAsset_iOSSimul"), and a clipped ancestor
   could not be clicked at all — Library and AssetsV2 were out of reach from
   the crumbs. The trail now folds instead. Ancestors go, oldest first after
   the root, into one "…" crumb whose menu lists them, until what is left sits
   clear of the fade; the root folds last, and the folder on screen never.
   Every ancestor is therefore always one click away, by name or by menu. */
const CRUMB_FADE_PX = 34; // the .crumbs mask's fade width — a crumb inside it is half legible

/** Shared breadcrumb renderer (treemap + grid + city). */
function renderCrumbs(host, path, onPick) {
  // Focus on "…" stays in the trail (QA-6 review MEDIUM-1): Escape or a
  // pick from its menu puts focus back on "…", and the buttons are rebuilt
  // when the map it opened lands — which used to hand focus to <body>. It
  // goes to the new "…", else the folder on screen. Only "…": a crumb a
  // pointer pressed holds focus too, and keeping it there would turn the
  // next Enter from the map's into a reload of that folder.
  // A "…" menu open over this trail goes with it (QA-6b review F1.3): it
  // lists what the old trail folded, and its opener is the "…" about to be
  // replaced — left up, the new "…" said aria-expanded false over an open
  // menu, a press of it re-opened instead of closing, and Escape focused a
  // button no longer on the page. Focus that was in that menu is kept in
  // the trail, like focus on "…".
  const active = document.activeElement;
  const menuHere = !!ctxMenuOpener && host.contains(ctxMenuOpener);
  const inMenu = menuHere && $('ctxMenu').contains(active);
  if (menuHere) hideCtxMenu();
  const kept = inMenu || (!!active && host.contains(active) && active.hasAttribute('data-crumb-more'));
  const crumbs = breadcrumbsFor(path);
  // Measured as a trail always is, never as the last fit left it: the tight
  // mark packs to the start, where every trail would read as overflowing.
  host.classList.remove('crumbs-tight');
  host.title = '';
  let fold = 0;
  crumbsPaint(host, crumbs, fold, onPick);
  while (fold < crumbs.length - 1 && crumbsOverflow(host)) crumbsPaint(host, crumbs, ++fold, onPick);
  // Folded as far as it goes and still over the fade or past the start edge
  // (QA C05): at 1024×768 "… › Archives" spilled "…" under the fade beside
  // the Up button, where the hidden levels could be neither seen nor opened.
  // The tight trail keeps "…" at its start and lets the folder on screen
  // give up width instead (035-treemap.css). Its name is cut short there, and
  // its own title never shows — it takes no pointer events — so the trail
  // carries the whole path as its tooltip (review F1.9).
  if (crumbsOverflow(host)) {
    host.classList.add('crumbs-tight');
    host.title = crumbs[crumbs.length - 1].path;
  }
  host._crumbs = { path, onPick, width: host.clientWidth };
  crumbsWatch(host);
  if (kept) {
    const buttons = host.querySelectorAll('button');
    const to = host.querySelector('[data-crumb-more]') || buttons[buttons.length - 1];
    if (to) to.focus({ preventScroll: true });
  }
}

/** Is crumb `i` of `n` folded into the "…" menu when `fold` of them are? */
function crumbFolded(i, n, fold) {
  if (i === n - 1) return false;   // the folder on screen
  if (fold >= n - 1) return true;  // everything else, the root included
  return i >= 1 && i <= fold;      // the middle, oldest first
}

/**
 * Does the trail run into the fade? It is packed to the END, so an overflow
 * spills past the START edge, where scrollWidth cannot see it; the first
 * crumb's left edge can. A host that is not laid out cannot be measured, and
 * folds nothing on a guess — its observer re-fits it once it has a width.
 */
function crumbsOverflow(host) {
  const first = host.firstElementChild;
  if (!first || !(host.clientWidth > 0)) return false;
  return first.getBoundingClientRect().left < host.getBoundingClientRect().left + CRUMB_FADE_PX;
}

/** Re-fit when the toolbar changes width: a window resize, the sidebar, the view being shown. */
function crumbsWatch(host) {
  if (host._crumbsRo || typeof ResizeObserver === 'undefined') return;
  host._crumbsRo = new ResizeObserver(() => {
    const last = host._crumbs;
    // Only on a real change of width: the re-fit itself must not feed the observer.
    if (last && host.clientWidth !== last.width) renderCrumbs(host, last.path, last.onPick);
  });
  host._crumbsRo.observe(host);
}

function crumbsPaint(host, crumbs, fold, onPick) {
  const n = crumbs.length;
  const folded = crumbs.filter((c, i) => crumbFolded(i, n, fold));
  const parts = [];
  crumbs.forEach((c, i) => {
    if (crumbFolded(i, n, fold)) {
      if (c === folded[0]) {
        parts.push(`<button class="crumb-more" data-crumb-more aria-haspopup="menu" aria-expanded="false" aria-controls="ctxMenu" ` +
          `aria-label="${folded.length} more folder${folded.length === 1 ? '' : 's'}" ` +
          `title="${escapeHtml(folded.map((f) => f.name).join(' › '))}">…</button>`);
      }
      return;
    }
    // The name is its own span: text-overflow does nothing on the button,
    // which is a flex container, so the folder on screen was cut off at the
    // 220 px ceiling with no ellipsis.
    parts.push(`<button data-p="${escapeHtml(c.path)}" aria-current="${i === n - 1}" title="${escapeHtml(c.path)}">` +
      `${i === 0 ? icon('hardDrive', 13) : ''}<span class="crumb-nm">${escapeHtml(c.name)}</span></button>`);
  });
  host.innerHTML = parts.join('<span class="sep">' + icon('chevronRight', 12) + '</span>');
  host.querySelectorAll('button[data-p]').forEach(b => {
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
  const more = host.querySelector('[data-crumb-more]');
  if (more) {
    more.addEventListener('click', (e) => {
      e.stopPropagation(); // the document's click handler closes #ctxMenu
      hideTooltip();
      // A toggle, as its aria-expanded says: a second press closes what the first opened.
      if (ctxMenuOpener === more && $('ctxMenu').style.display === 'block') { hideCtxMenu(); return; }
      showCrumbMenu(more, folded, onPick);
    });
  }
}

/**
 * The folded ancestors, root first, as a menu under the "…" crumb — #ctxMenu,
 * like the Export menu, and a menu to the keyboard as much as to the pointer
 * (QA-6 review MEDIUM-1): it opens with its first folder focused, the arrows,
 * Home and End move through it (ctxMenuKeydown), and Escape or a pick puts
 * focus back on "…" before the map moves.
 */
function showCrumbMenu(anchor, folded, onPick) {
  const menu = $('ctxMenu');
  const html = folded.map((c) =>
    `<button data-p="${escapeHtml(c.path)}" title="${escapeHtml(c.path)}">${icon('folder', 15)}${escapeHtml(c.name)}</button>`).join('');
  const r = anchor.getBoundingClientRect();
  ctxMenuShow(menu, { label: 'Folders above this one', html, opener: anchor, x: r.left, y: r.bottom + 6 });
  menu.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    ctxMenuFocusOpener(hideCtxMenu());
    onPick(b.dataset.p);
  }));
  const first = menu.querySelector('button');
  if (first) first.focus({ preventScroll: true });
}

/* "\" separates only a Windows path — a drive's or a share's — as tmParentPath
   reads it (POL item 7): on macOS and Linux it is a character a name may hold,
   and guessed from the root's path, "/x/y" below "/data/a\b" was one crumb, so
   Up jumped to the root. */
function breadcrumbsFor(path) {
  const root = state.root;
  if (!root) return [];
  const crumbs = [{ name: root.name, path: root.path }];
  if (path === root.path) return crumbs;
  const sep = /^(?:[A-Za-z]:|\\\\)/.test(root.path) ? '\\' : '/';
  const rel = path.slice(root.path.length).split(sep).filter(Boolean);
  let acc = root.path;
  for (const part of rel) {
    acc = acc.endsWith(sep) ? acc + part : acc + sep + part;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
}

/**
 * The size key's gradient, sampled from the ramp the CELLS are painted from.
 *
 * This used to be a CSS gradient over --ok/--warn/--danger, and it matched the
 * canvas only by coincidence: those tokens happened to hold the same three
 * hexes sizeRgb() interpolates. The day --ok and --danger were re-tuned for
 * the light theme — correct, since #30D158 measures ~1.95:1 on a white card
 * and the status TEXT using them was unreadable — the key started explaining
 * the map in colours the map never uses. Cells are painted from JS literals,
 * so they do not move with the theme and the key must not either. Sampling
 * the painter is the only arrangement where the two cannot drift apart.
 *
 * Samples rather than restates the ramp's shape: the anchors and the log
 * domain stay sizeRgb()'s business, and the amber knee lands exactly on the
 * middle stop, so a re-tune of either is followed here for free.
 */
function sizeRampCss(stops = 5) {
  const parts = [];
  for (let i = 0; i < stops; i++) {
    const t = i / (stops - 1);
    const c = sizeRgb(10 ** (TIER_LO + t * (TIER_HI - TIER_LO)));
    parts.push(`rgb(${c[0]},${c[1]},${c[2]}) ${Math.round(t * 100)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`;
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
    ).join('') + '</div>' + tmMarksKey();
    return;
  }
  if (state.treemap.colorMode === 'age') {
    host.innerHTML = '<div class="tm-legend-bands">' + AGE_BANDS.map((b) =>
      `<span class="ab"><i class="sw" style="background:rgb(${b.rgb[0]},${b.rgb[1]},${b.rgb[2]})"></i>${b.label}</span>`
    ).join('') + '</div>' + tmMarksKey();
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
      `<span class="rc-legend-note">Greener means safer and more worthwhile to delete — right-click a cell for the reasoning.${reclaimCoverageNote()}</span>` +
      tmMarksKey();
  } else {
    host.innerHTML = `<span>1 MB</span><div class="legend-grad" style="background:${sizeRampCss()}"></div><span>10 GB+</span>` + tmMarksKey();
  }
}

/**
 * The map's markings, in the key (design pass G27) — only those the last
 * paint of the rectangle map actually drew (drawTreemap records them in
 * state.treemap.marks as it draws each one), so the key never explains a
 * mark that is not on screen, and the other layouts, which draw none of
 * them, never inherit one.
 *
 * Named for what each mark means in drawTreemap: pass 7's dashed indigo
 * border is any container the server can list (containerListable — not a
 * .dmg, not an entry inside one), so it is named by the kinds drawn, an
 * archive, a disk image (an .iso, Docker's data) or a Photos library; pass
 * 1's hatched block with a dashed amber edge is what the cart preview shows
 * staged for the Trash; its hollow dashed tile, a cloud placeholder whose
 * bytes are not on this disk; pass 6's branch glyph, a folder that holds a
 * .git folder of its own.
 *
 * The open marking promises a click only where a click opens: the cart
 * preview is read-only (tmOnCanvasClick returns before an archive), so while
 * it is up the border is still named, with when it can be opened (review
 * F3.1).
 */
const TM_OPEN_NOUNS = { zip: 'archive', tgz: 'archive', tar: 'archive', iso: 'disk image', docker: 'disk image', photos: 'Photos library' };
function tmMarksKey() {
  const m = isRectMap() && state.treemap.marks;
  if (!m) return '';
  const items = [];
  if (m.open && m.open.size) {
    const nouns = [...new Set([...m.open].map((k) => TM_OPEN_NOUNS[k] || 'container'))];
    const how = tmPreview.on
      ? { title: 'Leave the preview, then click it to look inside — TreeMap lists what it holds', when: ' after the preview' }
      : { title: 'Click it to look inside — TreeMap lists what it holds', when: '' };
    items.push(`<span class="mk" title="${how.title}"><i class="mk-sw mk-open"></i>${escapeHtml(nouns.join(' or '))} you can open${how.when}</span>`);
  }
  if (m.staged) {
    items.push('<span class="mk" title="In the cleanup cart — nothing is deleted until you move it to the Trash"><i class="mk-sw mk-staged"></i>staged for the Trash</span>');
  }
  if (m.cloud) {
    items.push('<span class="mk" title="A cloud file that is not downloaded: drawn at its size in the cloud, it takes almost no space here"><i class="mk-sw mk-cloud"></i>in the cloud, not on this disk</span>');
  }
  if (m.git) {
    items.push('<span class="mk" title="A folder holding a .git folder of its own">' +
      '<svg class="mk-git" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="3" cy="9.5" r="1.8" fill="currentColor"/>' +
      '<circle cx="9" cy="2.5" r="1.8" fill="currentColor"/><path d="M3 8.5V4.5Q3 2.5 6.5 2.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>' +
      'git repository</span>');
  }
  return items.length ? `<div class="tm-marks">${items.join('')}</div>` : '';
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
  let loading = 0;
  for (const r of drawn) {
    // Exactly the cells the map asks about (reclaimAskableNode): not a freed
    // block (§4.3), not the Trash cell, not an in-archive or cloud listing.
    // Counting the Trash cell left "the rest are still loading" up for good.
    if (!reclaimAskableNode(r.n)) continue;
    const p = r.n.path;
    total++;
    // Landed before in flight: a path stays pending until its whole request
    // ends, and one whose batch already landed is scored, not loading.
    if (reclaim.scores.has(p)) {
      if (reclaim.scores.get(p) === null) unscorable++;
      else scored++;
      continue;
    }
    // A request that failed is not asked again in this view (ensureScores),
    // so it is no longer loading: it could not be scored.
    if (reclaim.failed.has(p)) { unscorable++; continue; }
    if (reclaim.pending.has(p)) loading++;
  }
  if (total === 0 || scored + unscorable >= total) {
    // Everything on screen was asked about. Name the ones that came back
    // unanswerable, since those are grey for a real reason.
    return unscorable > 0
      ? ` ${formatCount(unscorable)} of ${formatCount(total)} could not be scored.`
      : '';
  }
  // "Stops at 6,000" is a claim that TreeMap stopped ASKING, so it is made
  // only when what was asked — answered or still in flight — reached the
  // cap, AND there are cells past it: at exactly 6,000 nothing was left
  // unasked. A larger map than the cap is not enough either: the QA screen
  // said it over 210 scores carried in from another layout, with nothing
  // asked at all.
  const capped = total > TM_SCORE_CAP && scored + unscorable + loading >= TM_SCORE_CAP;
  const cap = ` — TreeMap stops at ${formatCount(TM_SCORE_CAP)} at a time; drill in to score the rest.`;
  const head = ` Scored ${formatCount(scored)} of ${formatCount(total)} on screen`;
  if (loading > 0) {
    return `${head}; ${formatCount(loading)} more ${loading === 1 ? 'is' : 'are'} loading` + (capped ? cap : '.');
  }
  return head + (capped ? cap : '; the rest are still loading.');
}

/**
 * Where `el`'s top edge is with <main> scrolled to its top, or null while it
 * is not laid out (a hidden view has no box). <main> is the page's one
 * scroller (025-layout.css) and nothing resets it on a view switch: read from
 * the window as it stood, a view entered under a scrolled Dashboard measured
 * its card that much higher and was fitted that much too tall — Disk City at
 * 975/900 again — and a card scrolled above the window was not fitted at all
 * (review F1.8 of fifth browser pass F06).
 */
function tmUnscrolledTop(el) {
  const box = el.getBoundingClientRect();
  if (!(box.top > 0) && !(box.height > 0)) return null;
  const main = el.closest('main');
  return box.top + ((main && main.scrollTop) || 0);
}

/**
 * Height for the treemap/sunburst canvas, measured rather than guessed.
 *
 * This used to be `innerHeight - 300`, a reserve big enough for the toolbar,
 * the time slider, the legend and the page padding all at once — which left
 * about 126 px of dead space below the chart on a 720 px-tall window. Measure
 * what is actually above and below instead, so the chart fills the window and
 * still fits when the toolbar wraps to two lines.
 *
 * The floor is for a window with no room left at all, where the page then
 * scrolls to the footer. It was 360 px, and at the desktop window's minimum
 * (1024×700) the rows above the map — the toolbar on two rows, a saved
 * view's chips, the time-lapse bar on two lines — left less than that: the
 * map kept its 360 and pushed the footer under the cart pill, hint and counts
 * with it, as it did at 1024×768 in Reclaim colour, whose legend wraps (QA
 * B36 re-check). The map gives way first now; the footer is what explains it.
 * The floor then was 200 px, and the same window with the preview pane open
 * (a 402 px map) in "Preview after" with the time slider up leaves 113: the
 * toolbar on four rows, the time-lapse bar on three, the banner's 127 px and
 * a two-line hint. The page grew to 787 px and the pill covered the legend
 * and the status line (QA D12). It is 96 px — two rows of labelled cells.
 * The map's card is a .glass card, and its border is height too: left out,
 * every window ran 2 px past its bottom (QA fourth pass D12, 702/700).
 * So is every row under the footer that is on screen: the drive dock while a
 * drive is connected — left out, its 61 px ran the page past the window,
 * 961/900 and 761/700 (fifth browser pass F06) — the alternate renderers'
 * note, and Disk City's list of buildings, which fits its card through here
 * too (cityFitHeight). A disclosure counts as closed: opened, it is read
 * below the fold, and the map does not shrink to make room for it.
 */
function treemapCanvasHeight(wrap) {
  const MIN_H = 96; // the floor, for a window with no room left (above)
  const top = tmUnscrolledTop(wrap);
  // Called before the view is laid out (hidden tab): fall back to the floor.
  if (top === null) return 420;
  const cs = getComputedStyle(wrap);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  const foot = wrap.parentElement && wrap.parentElement.querySelector('.tm-foot');
  let below = foot
    ? foot.getBoundingClientRect().height + parseFloat(getComputedStyle(foot).marginTop)
    : 28;
  for (let row = foot ? foot.nextElementSibling : null; row; row = row.nextElementSibling) {
    if (!row.getClientRects().length) continue; // hidden: it takes no room
    const shown = row.tagName === 'DETAILS' && row.open ? row.querySelector('summary') || row : row;
    below += shown.getBoundingClientRect().height + (parseFloat(getComputedStyle(row).marginTop) || 0);
  }
  const main = wrap.closest('main');
  const mainPadB = main ? parseFloat(getComputedStyle(main).paddingBottom) : 24;
  return Math.max(MIN_H, Math.floor(window.innerHeight - top - padY - below - mainPadB));
}

/**
 * Redraw the map when a row around it changed height (QA B26; D59 did this
 * for the time-lapse bar alone). The canvas is sized once per draw, from
 * what sits above and below it, and a row can appear or re-flow AFTER that
 * draw: the query bar (Save view · Stage N files), the time-lapse bar, a
 * toolbar that wraps, a footer that wraps, the room the cart pill reserves at
 * the bottom of <main>. The footer — legend, counts, hint — then fell below
 * the window. A no-op unless the height the map should have differs from the
 * one it was drawn at, and nothing before the first draw, which measures for
 * itself.
 *
 * Voronoi and Circles re-solve through tmCellsSettle, the resize handler's
 * own wait (B26 review F1.1): a corner drag moves the toolbar's width every
 * frame, so this fires every frame against a height the handler has not
 * redrawn yet — and solving here then re-solved the layout once a frame.
 */
function tmRefitMap() {
  if (state.view !== 'treemap' || !state.treemap.rootPath || !tmCanvas.style.height) return;
  if (tmCanvas.style.height === treemapCanvasHeight($('treemapWrap')) + 'px') return;
  if (isCells()) { tmCellsSettle(); return; }
  drawView();
}
// The drive dock comes and goes under the footer as a drive is connected or
// ejected (F06). The alternate renderers' note is counted but not watched:
// it is their layout's own answer, and watched it fed every answer back into
// the layout — altNoteSettled fits the map to it instead (review F1.1).
const TM_CHROME_ROWS = ['#view-treemap .tm-toolbar', '#tmQueryBar', '#tmTimebar', '#view-treemap .tm-foot', '#cartDock', '#tmDock'];
if (typeof ResizeObserver !== 'undefined') {
  const tmChromeRo = new ResizeObserver(() => tmRefitMap());
  for (const sel of TM_CHROME_ROWS) { const el = document.querySelector(sel); if (el) tmChromeRo.observe(el); }
}

/**
 * The server's ceiling on one treemap response: `maxNodes: 20_000` where
 * src/api/scanRoutes.ts builds the live map and src/api/insightRoutes.ts the
 * time slider's. The response is golden-locked (§12), so nothing in it can
 * say the map was cut — the page has to know the number, and
 * tests/mapViewTruth.test.ts reads both literals so the copies cannot drift.
 */
const TM_SERVER_NODE_CAP = 20000;
let tmCapMemo = { nodes: null, rootSize: -1, floor: -1, note: '' };

/**
 * The rectangle map's admission that the server's cap cut it short (QA D58).
 *
 * A folder of 25,600 files drew 20,000 of them and left a blank rectangle for
 * the rest, under a status line reading "20,000 nodes · 20,000 drawn" — the
 * blank read as free space or as a rendering fault. Circles and Voronoi
 * already name what they leave out; this is the same sentence for this map.
 *
 * The bytes with no rectangle are exact from the drawn set alone: every
 * outlined folder (the root included) minus what was drawn inside it. That
 * also counts the files under the floor the map was asked with, which no
 * drill-in reveals, so the sentence says so and where they are listed
 * (QA-6 review LOW-2). Only a map that had one: loadTreemap's second ask for
 * a folder of small files has none, and draws them, and neither has the time
 * slider's map — the floor is the one recorded with the nodes
 * (state.treemap.minSize), never assumed (QA-6b review F1.2). Below the cap
 * it says nothing — the line on every map would be noise.
 * The injected Trash cell is not a server node.
 *
 * Reaching the cap is not proof of a cut: a folder of exactly 20,000 items
 * fills it too. A cut always leaves bytes undrawn — every item it leaves out
 * is at least the floor, inside a folder that is outlined — so a map that
 * reached the cap with nothing undrawn was not cut, and says nothing; one
 * with bytes undrawn says it reached the cap, which is true either way.
 */
function tmNodeCapNote() {
  const nodes = state.treemap.nodes;
  // A history frame keeps each folder's biggest items a few levels deep
  // (snapshots.ts compactTree), so it can leave dark holes far below the cap;
  // they were unexplained (B33). Said for a frame that IS a snapshot — not
  // for the blends time-lapse playback draws between two. It promises
  // nothing about the live map, which has a floor and a cap of its own
  // (review F1.4: "The live map shows everything" was not true).
  const historyFrame = !!(state.treemap.history && state.treemap.history.active);
  if (historyFrame && state.treemap.lapse && state.treemap.lapse.playing) return '';
  let sent = 0;
  for (const n of nodes) if (!n.isTrash) sent++;
  const capped = sent >= TM_SERVER_NODE_CAP;
  if (!capped && !historyFrame) return '';
  const floor = historyFrame ? 0 : (state.treemap.minSize || 0);
  if (tmCapMemo.nodes === nodes && tmCapMemo.rootSize === state.treemap.rootSize && tmCapMemo.floor === floor) return tmCapMemo.note;
  const { root, kids } = tmDrawnTree();
  let blank = 0;
  for (const p of [root, ...nodes]) {
    if (!p.expanded) continue;
    let drawn = 0;
    for (const c of kids.get(p.path) || []) drawn += c.size;
    blank += Math.max(0, p.size - drawn);
  }
  const note = blank <= 0 ? ''
    : capped
      ? `The map holds at most ${formatCount(TM_SERVER_NODE_CAP)} items, and this folder reached that: `
        + `${formatBytes(blank)} has no rectangle here — drill in, or open the Grid view, to see the rest.`
        + (floor > 1 ? ` That figure counts files under ${formatBytes(floor)} too, which the map does not draw; the Grid view lists them.` : '')
      : `History keeps each folder's biggest items, a few levels deep — not every file: ${formatBytes(blank)} in this snapshot `
        + 'has no rectangle.';
  tmCapMemo = { nodes, rootSize: state.treemap.rootSize, floor, note };
  return note;
}

/** The note over an empty map. Empty text hides it; the note is a live region, so it is also read out. */
function tmSetEmpty(text) {
  const el = $('tmEmpty');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

/**
 * A leaf rectangle's paint: a cushion gradient — lighter at the top, darker at
 * the bottom — over the cell's colour, OPAQUE and at the colour's full
 * strength at every depth. One recipe for the map's leaf pass and the hover
 * magnifier, so the glass shows the colour the map shows (QA D39).
 *
 * Tiles used to be faded with depth, alpha 0.95 × max(0.55, 1 − 0.08·depth)
 * over --tm-canvas-bg, so the map's ground showed through: the 9.1 GB tile at
 * depth 4 reached the screen at C*ab 41 in light (pastel salmon) and 46 in
 * dark (muddy maroon), where #FF453A itself is 84 (design pass G01). The
 * owner's rule is that the colour must pop, as on a desktop treemap, so depth
 * is told by the folder frames and the dark outlines instead (pass 2), and
 * nothing behind the map can tint a tile. tests/mapColourPop.test.ts measures
 * every ramp step at depths 1–8 over both themes' real ground.
 *
 * The cushion's light and shadow are a share of the tile's height up to
 * TM_CUSHION_FULL_H: a short tile is a shallow cushion. Its label then spans
 * most of the gradient, and at the full 16%/22% no ink reaches 4.5:1 across
 * a short red tile from its light top to its dark bottom (G09).
 *
 * A labelled tile's cushion also gives way to its label (review F1.2,
 * F1.14): `lines` are the label's lines, each { off, px } — its top, down
 * from the tile's top, and its font size — and where neither black nor
 * white reaches 4.5:1 across a line, the cushion eases a step at a time
 * until one does. On a flat fill one of the two always does (4.58:1 at
 * worst, where they read alike), and on most tiles the whole cushion
 * already does: it is the colours near that crossing that need it — the
 * Reclaim "keep" grey, the diff's "unchanged", the Trash cell, and a red
 * tile whose label sits below its folder's tag, mid-cushion. `washes` are
 * the History diff's washes laid over the tile after it is painted
 * (tmDiffWashes): the label is read through them, so it is judged there.
 */
const TM_CUSHION_LIGHT = 0.16;   // the white mixed into the top edge
const TM_CUSHION_SHADE = 0.22;   // the black mixed into the bottom edge
const TM_CUSHION_FULL_H = 60;    // px: a tile this tall or taller gets the whole cushion
const TM_CUSHION_EASE = [1, 0.75, 0.5, 0.25, 0];  // the shares of its cushion a labelled tile tries, in turn
function tmLeafStops(base, h, lines, washes = []) {
  const full = Math.max(0, Math.min(1, h / TM_CUSHION_FULL_H));
  let stops = null;
  for (const share of TM_CUSHION_EASE) {
    const amp = full * share;
    stops = [mix(base, [255, 255, 255], TM_CUSHION_LIGHT * amp), mix(base, [0, 0, 0], TM_CUSHION_SHADE * amp)];
    const seen = tmSeenThrough(stops, washes);
    if (!lines || lines.every((l) => tmBestInk(seen, h, l.off, l.px, 1).contrast >= TM_LABEL_FLOOR)) break;
  }
  return stops;
}

/**
 * Pass 2.5's washes, in the History diff only: each expanded folder that grew
 * or shrank, as { r, rgb }, in the order the pass lays them. A wash is
 * TM_DIFF_WASH of the folder's own diff colour over its whole frame, its
 * leaves included — laid after pass 1 paints them and before pass 4 writes
 * their labels — so a label is read on its cushion seen through every wash
 * over its tile, and pass 1 eases the cushion and pass 4 picks the ink
 * against that (review F2.1). Judged against the cushion alone, the grey
 * "unchanged" leaf in the corner of a folder that grew took white at 4.64:1
 * and showed 3.67:1 under the teal.
 */
const TM_DIFF_WASH = 0.3;
function tmDiffWashes(px) {
  if (!state.treemap.history.active || !state.treemap.history.diff) return [];
  const washes = [];
  for (const r of px) {
    if (!r.frame) continue;
    const rgb = diffRgb(r.n);
    if (rgb !== C_DIFF_SAME) washes.push({ r, rgb });
  }
  return washes;
}
/** The colours of the washes laid over the tile `r`, in order: those whose folder's frame holds it. */
function tmWashesOver(r, washes) {
  return washes
    .filter(({ r: f }) => r.x >= f.x - 0.5 && r.y >= f.y - 0.5 && r.x + r.w <= f.x + f.w + 0.5 && r.y + r.h <= f.y + f.h + 0.5)
    .map((w) => w.rgb);
}
/** A cushion's stops as they reach the screen through `washes` (colours, in the order laid). */
function tmSeenThrough(stops, washes) {
  return washes.reduce((seen, rgb) => seen.map((c) => c.map((v, i) => v + (rgb[i] - v) * TM_DIFF_WASH)), stops);
}
function tmLeafFill(ctx, stops, y, h) {
  const [top, bot] = stops;
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, `rgb(${top[0]},${top[1]},${top[2]})`);
  g.addColorStop(1, `rgb(${bot[0]},${bot[1]},${bot[2]})`);
  return g;
}

/**
 * The ink for one line of a tile's label (design pass G09): black or white,
 * whichever keeps the higher WCAG contrast against the cushion under the
 * WHOLE line — its top and its bottom, since the cushion darkens downward.
 * A fixed black ink measured 2.55–3.91:1 on the darker and saturated tiles.
 * `r.seen` is the cushion pass 1 painted the tile with (r.stops, from
 * tmLeafStops, eased for this label where it had to be) as the screen shows
 * it, through any History diff wash over it (tmSeenThrough); a tile without
 * one (a hollow cloud placeholder) shows the map's own ground, and takes the
 * page's ink for it.
 * The size line is a step quieter, at TM_SIZE_INK_ALPHA, wherever that
 * still reads at 4.5:1; where it would not, it is written at full ink.
 * tests/mapColourPop.test.ts measures every colour the map paints, at the
 * label's usual place and below a folder's tag, in both themes.
 */
const TM_LABEL_LEADING = 1.2;    // a line of text's height, as a share of its font size
const TM_LABEL_FLOOR = 4.5;      // WCAG AA for the 10–11px label
const TM_SIZE_INK_ALPHA = 0.9;   // the size line, a step quieter than the name
function tmLuminance(c) {
  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function tmContrast(a, b) {
  const la = tmLuminance(a), lb = tmLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** Black or white for the line `off` px down a tile `h` px tall, at `alpha`: { ink, contrast } at the line's worst end. */
function tmBestInk(stops, h, off, fontPx, alpha) {
  const [top, bot] = stops;
  const under = (yy) => {
    const f = Math.max(0, Math.min(1, yy / h));
    return top.map((v, i) => v + (bot[i] - v) * f);
  };
  const ends = [under(off), under(off + fontPx * TM_LABEL_LEADING)];
  const worst = (ink) => Math.min(...ends.map((c) => tmContrast(ink.map((v, i) => alpha * v + (1 - alpha) * c[i]), c)));
  const black = worst([0, 0, 0]), white = worst([255, 255, 255]);
  return black >= white ? { ink: '0,0,0', contrast: black } : { ink: '255,255,255', contrast: white };
}
function tmLabelInk(r, y, fontPx, alpha) {
  const under = r.seen;
  if (!under) return cssVar(alpha < 1 ? '--text-2' : '--text-1');
  let best = tmBestInk(under, r.h, y - r.y, fontPx, alpha);
  if (best.contrast < TM_LABEL_FLOOR && alpha < 1) { alpha = 1; best = tmBestInk(under, r.h, y - r.y, fontPx, 1); }
  return `rgba(${best.ink},${alpha})`;
}

/**
 * Where pass 4 writes a leaf's label, as its lines { y, px, alpha } — the
 * name, and the size below it when two lines fit — or none. A label that
 * would print through a top-level folder's name tag (pass 3) drops below
 * the tag when the tile is tall enough, and is left out when it is not.
 * Pass 1 needs the lines too, to ease the cushion under them.
 */
function tmLabelLines(r, tags) {
  if (r.frame || r.n.freed || r.w < 40 || r.h < 15) return [];
  let ty = r.y + 4;
  const clash = tags.find(t =>
    r.x + 5 < t.x + t.w && r.x + r.w - 5 > t.x && ty < t.y + t.h && ty + 12 > t.y);
  if (clash) {
    const shifted = clash.y + clash.h + 3;
    if (shifted + 12 > r.y + r.h) return [];
    ty = shifted;
  }
  const lines = [{ y: ty, px: 11, alpha: 1 }];
  if (r.y + r.h - ty > 26) lines.push({ y: ty + 13, px: 10, alpha: TM_SIZE_INK_ALPHA });
  return lines;
}

/** Pass 3's name tags for the top-level folders, measured before pass 1 so labels can be placed around them. */
function tmFolderTags(ctx, px) {
  ctx.font = '600 10.5px -apple-system, sans-serif';
  const tags = [];
  for (const r of px) {
    if (!r.frame || r.n.depth !== 1 || r.w < 90 || r.h < 44) continue;
    const tw = Math.min(ctx.measureText(r.n.name).width, r.w - 26);
    tags.push({ r, x: r.x + 5, y: r.y + 5, w: tw + 14, h: 18 });
  }
  return tags;
}

function drawTreemap() {
  // QA D58 — the server stops a map at 20,000 nodes and its response cannot
  // say so (§12 golden lock), so the note under the map does. Written before
  // the map is measured: it is a row under the footer, which the map's height
  // counts, and it depends on the nodes alone (review F1.1 of F06).
  state.treemap.altNote = tmNodeCapNote();
  renderAltNote();
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
  // What this paint marks, for the key (G27): each pass below records the
  // marking it draws as it draws it.
  const marks = { open: new Set(), staged: false, cloud: false, git: false };
  state.treemap.marks = marks;

  // A map with nothing to draw must say so — a blank panel reads as a broken
  // app, not as a small folder. loadTreemap already dropped the 4 KB floor
  // when it would have hidden everything, so this is a genuinely empty
  // folder, or a panel too small for the files it holds.
  if (!px.length) {
    tmSetEmpty(state.treemap.rootSize > 0
      ? `Nothing here is big enough to draw — ${formatBytes(state.treemap.rootSize)} in files too small for a rectangle at this size. Open the Grid view to list them.`
      : 'This folder is empty.');
    renderSearchOverlay();
    presentTreemap();
    renderTmLegend();
    return;
  }
  tmSetEmpty('');

  // Where each label goes, around the top-level folders' tags: pass 1 eases
  // a cushion under its label where it must, and pass 4 writes it there.
  const tagRects = tmFolderTags(ctx, px);
  for (const r of px) r.label = tmLabelLines(r, tagRects);
  // The History diff's washes, which pass 2.5 lays over the leaves pass 1
  // paints: a label is read through them (review F2.1).
  const washes = tmDiffWashes(px);

  // Pass 1: cushion-shaded leaf fills.
  for (const r of px) {
    if (r.frame) continue;

    /* v4 §4.3 — a freed region. Hatched rather than filled, because the space
       is not there yet: a solid block would read as "this is what you have",
       which is exactly the false statement the preview exists to avoid. Same
       reasoning as A3's hollow cloud placeholders, and the same visual family. */
    if (r.n.freed) {
      marks.staged = true;
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

    /* A3 — a cloud placeholder is drawn hollow, because it is not here.
       A solid block the size of a 4 GB video says "this is filling your disk",
       which for an evicted file is precisely the false statement A3 exists to
       correct. The faint fill plus a dashed outline reads as an outline of
       something absent, and the cloud glyph in pass 5 names the reason. */
    if (r.n.cloudPlaceholder && r.w > 6 && r.h > 6) {
      marks.cloud = true;
      ctx.fillStyle = `rgba(${base[0]},${base[1]},${base[2]},0.16)`;
      ctx.fillRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.w - 1), Math.max(1, r.h - 1));
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(${base[0]},${base[1]},${base[2]},0.85)`;
      ctx.strokeRect(r.x + 1, r.y + 1, Math.max(1, r.w - 2), Math.max(1, r.h - 2));
      ctx.restore();
      continue;
    }

    const washedBy = tmWashesOver(r, washes);
    r.stops = tmLeafStops(base, r.h, r.label.map((l) => ({ off: l.y - r.y, px: l.px })), washedBy);
    ctx.fillStyle = tmLeafFill(ctx, r.stops, r.y, r.h);
    ctx.fillRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.w - 1), Math.max(1, r.h - 1));
    r.fillRgb = base; // the colour itself; r.stops is the cushion painted here
    r.seen = tmSeenThrough(r.stops, washedBy); // and as pass 4 writes the label on it, through pass 2.5 (G09, F2.1)
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
  // Pass 2: directory frames. Every leaf is painted at full strength now, so
  // nesting is read from the edges, as on a desktop treemap: each folder gets
  // a dark outline — heavier at the top level — inside which a light rim
  // catches the cushion's light (G01).
  for (const r of px) {
    if (!r.frame) continue;
    const top = r.n.depth <= 1;
    ctx.strokeStyle = `rgba(0,0,0,${top ? 0.6 : 0.42})`;
    ctx.lineWidth = top ? 1.5 : 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    if (r.w > 4 && r.h > 4) {
      ctx.strokeStyle = `rgba(255,255,255,${Math.max(0.12, 0.3 - r.n.depth * 0.05)})`;
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);
    }
  }
  // Pass 2.5: diff wash over expanded directories (history diff mode only).
  // A folder's own growth/shrinkage must show even when its visible children
  // didn't change — e.g. it shrank because a child was deleted outright.
  for (const { r, rgb: c } of washes) {
    ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${TM_DIFF_WASH})`;
    ctx.fillRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.w - 1), Math.max(1, r.h - 1));
  }
  // Pass 3: top-level directory name tags.
  ctx.textBaseline = 'middle';
  ctx.font = '600 10.5px -apple-system, sans-serif';
  for (const t of tagRects) {
    const r = t.r;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(ctx, t.x, t.y, t.w, t.h, 9);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillText(r.n.name, r.x + 12, r.y + 14.5, r.w - 26);
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
      ctx.fillText('Staged ' + formatBytes(r.n.size), r.x + r.w / 2, r.y + r.h / 2, r.w - 10); // not freed yet (B29)
    }
    ctx.restore();
    ctx.textAlign = 'left'; // pass 4 assumes it, and save/restore does not cover a later pass
  }

  ctx.textBaseline = 'top';
  for (const r of px) {
    if (!r.label.length) continue; // where it goes: tmLabelLines, above pass 1
    const [name, size] = r.label;
    const label = r.n.name;
    ctx.font = '500 11px -apple-system, sans-serif';
    ctx.fillStyle = tmLabelInk(r, name.y, name.px, name.alpha);
    const maxChars = Math.floor((r.w - 10) / 6.2);
    const text = label.length > maxChars ? label.slice(0, Math.max(1, maxChars - 1)) + '…' : label;
    ctx.fillText(text, r.x + 5, name.y, r.w - 10);
    if (size) {
      ctx.fillStyle = tmLabelInk(r, size.y, size.px, size.alpha);
      ctx.font = '10px -apple-system, sans-serif';
      ctx.fillText(formatBytes(r.n.size), r.x + 5, size.y, r.w - 10);
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
    marks.git = true;
    const gx = r.x + r.w - 17, gy = r.y + 11;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(gx, gy + 5, 2.1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(gx + 7, gy - 4, 2.1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(gx, gy + 4); ctx.lineTo(gx, gy - 2); ctx.quadraticCurveTo(gx, gy - 4, gx + 5, gy - 4); ctx.stroke();
  }

  // Pass 7: container badges (Feature 23) — drillable archives get a dashed
  // indigo border and a small box glyph. Virtual entries inside stay plain.
  for (const r of px) {
    if (!containerListable(r.n) || r.n.virtual) continue;
    marks.open.add(r.n.container);
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
    const when = formatWhen(state.treemap.history.viewingAt); // the one dialect, memoised
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
      `Preview · ${formatBytes(tmPreview.freedBytes)} staged for the Trash · ${formatBytes(state.treemap.rootSize)} total today`;
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
    // The size is the folder's, and says so: beside a match count a bare
    // "8.8 GB total" read as the matches' total (they were 7.2 GB — QA B26).
    $('tmStatus').textContent = `${counted} for “${q}” · ${formatBytes(state.treemap.rootSize)} in this folder`;
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

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

/**
 * The rectangle map of `root`, a tree the page holds, laid out here: a port
 * of buildTreemap() in src/utils/treemap.ts (the FileNode version), over the
 * same squarify (tmSquarify). Same nodes, same fields, same breadth-first
 * cap, so a map laid out here is the map the server lays out of the same
 * tree; tests/indexFirstMap.test.ts runs the two side by side and demands
 * identical nodes.
 *
 * Only for a tree with no scan behind it — the saved index's, painted before
 * its scan answers, or left on screen by a Stop (seventh browser pass, J05).
 * The server lays a map out only for a scan it ran, so that tree had no map
 * at all: a blank canvas until the scan completed, and for ever after a Stop.
 */
function tmLayoutTree(root, maxDepth, minSize, maxNodes) {
  const out = [];
  const queue = [{ node: root, rect: { x: 0, y: 0, w: 100, h: 100 }, depth: 0 }];
  for (let head = 0; head < queue.length && out.length < maxNodes; head++) {
    const { node, rect, depth } = queue[head];
    // Expanded containers are file nodes carrying virtual children.
    if ((node.type !== 'dir' && !node.container) || !node.children || node.children.length === 0) continue;
    if (node.size <= 0 || rect.w <= 0 || rect.h <= 0) continue;
    const children = node.children.filter((c) => c.size >= minSize && c.size > 0).sort((a, b) => b.size - a.size);
    if (children.length === 0) continue;
    // Each child's share of the PARENT's size, so what the floor leaves out stays empty space.
    const rectArea = rect.w * rect.h;
    const rects = tmSquarify(children.map((c) => (c.size / node.size) * rectArea), rect);
    for (let k = 0; k < children.length && out.length < maxNodes; k++) {
      const child = children[k];
      const r = rects[k];
      if (r.w <= 0 || r.h <= 0) continue;
      const canExpand = (child.type === 'dir' || !!child.container) && depth + 1 < maxDepth &&
        !!child.children && child.children.length > 0 && r.w > 0.2 && r.h > 0.2;
      out.push({
        name: child.name, path: child.path, size: child.size, type: child.type, extension: child.extension,
        modifiedAt: child.modifiedAt, depth: depth + 1, expanded: canExpand, x: r.x, y: r.y, w: r.w, h: r.h,
        cloudPlaceholder: child.cloudPlaceholder, gitRepo: child.gitRepo, container: child.container,
        virtual: child.virtual, logicalSize: child.logicalSize,
      });
      if (canExpand) queue.push({ node: child, rect: r, depth: depth + 1 });
    }
  }
  return out;
}

/**
 * The map of `rootPath` in the tree on screen when no scan is behind it, as
 * `(minSize) => { root, nodes }` — the shape GET /api/scan/:id/treemap
 * answers — or null when the folder is in no tree the page holds. A folder
 * the index's preview withheld (`pruned`) is fetched from the index first
 * (ensureSubtree), as the sunburst's is.
 */
async function tmHeldTreemap(rootPath) {
  const node = (await ensureSubtree(rootPath)) || state.root;
  if (!node) return null;
  const root = { name: node.name, path: node.path, size: node.size, modifiedAt: node.modifiedAt };
  return (minSize) => ({ root, nodes: tmLayoutTree(node, state.treemap.maxDepth, minSize, TM_SERVER_NODE_CAP) });
}

let tmLoadSeq = 0;
async function loadTreemap(rootPath, animate = false) {
  // A tree with no scan behind it — the saved index's — is drawn too, laid
  // out here (tmHeldTreemap, J05); with no tree at all there is nothing to draw
  // — a first scan's id on hand is no tree (BQJ-1b).
  if (!state.root) return;
  // §4.3 — a preview is a picture of one folder with one cart. Any load
  // replaces both, so it is dropped silently rather than left to go stale.
  exitCartPreview(true);
  const seq = ++tmLoadSeq;
  // The scan whatever lands here was asked of (C03): the one the tree on
  // screen came from. While a scan runs its id is on hand as soon as its
  // request answers, but the tree on screen is still the one before it — an
  // older scan's (settledScanId), or the saved index's (none) — and a scan
  // still walking answers a map with 202: asked of it, the map stayed blank,
  // or kept the older drawing under the new folder's name, for the whole
  // scan (treeScanId, review F1.5).
  const scanAtRequest = treeScanId();
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
      // A map answer onto the screen: its folder, its nodes, the floor it was
      // asked with (TM_MIN_SIZE, or 1 for a folder of small files) and the scan
      // it came from (null: laid out here from a tree with no scan behind it).
      const land = (data, floor, scanId) => {
        state.treemap.rootPath = data.root.path;
        state.treemap.rootName = data.root.name;
        state.treemap.rootSize = data.root.size;
        state.treemap.nodes = data.nodes;
        // Which scan and folder these rectangles are, and which array: Disk City
        // reuses them only while this very array is the one on the map (C03 —
        // loadCity says why). The folder's size and the floor ride with them:
        // they are what the city's line and size say of a city built from them.
        // A null scan is a map laid out here from the saved index's tree (J05),
        // which the footer says (updateTmStatus).
        state.treemap.nodesFor = { scanId, path: data.root.path, nodes: data.nodes, size: data.root.size, minSize: floor };
        state.treemap.minSize = floor; // what tmNodeCapNote may say this map leaves out
        state.treemap.hover = null;
        renderCrumbs($('tmCrumbs'), state.treemap.rootPath, (p) => loadTreemap(p, true));
        $('tmUpBtn').disabled = !state.root || state.treemap.rootPath === state.root.path;
        maybeInjectTrash();
        exitHistoryState();
        refreshTimebar();
        drawView(); // the scores follow the drawn set — see the branch above
      };
      // A map answer with nodes of its own: land() hands the map the nodes it
      // is given, and maybeInjectTrash squeezes them in place and adds the
      // Trash cell to them. The map kept for a Stop (`scanMap`, below) is kept,
      // and landed, as a copy, so a home folder's map is never squeezed twice
      // beside a second Trash cell (review F1.1, F1.3).
      const ownNodes = (data) => ({ ...data, nodes: data.nodes.map((n) => ({ ...n })) });
      // The older folder's map, back at once (ninth browser pass, item 19): a
      // Stop that puts back the tree an index paint stood over (putBackHeldTree,
      // J06) has the view ask that tree's scan for the map of the folder it was
      // in, and the stopped folder's drawing stood under that folder's crumbs
      // for the 70–130 ms the answer took. That map is the last one a scan
      // answered here (`scanMap`), so it is drawn again in this same turn, and
      // the scan's own answer is drawn over it when it lands. Only while the map
      // on screen is not of that scan: within one scan a load draws its answer
      // alone — a refresh, a depth, an archive opened are the scan's to say.
      const memo = state.treemap.scanMap;
      if (scanAtRequest && memo && memo.scanId === scanAtRequest && memo.maxDepth === state.treemap.maxDepth
        && (memo.ask === rootPath || memo.data.root.path === rootPath)
        && !(state.treemap.nodesFor && state.treemap.nodesFor.scanId === scanAtRequest)
        && !state.treemap.history.scrubbing) {
        land(ownNodes(memo.data), memo.floor, scanAtRequest);
      }
      let floor = TM_MIN_SIZE; // the floor the map on screen will have been asked with
      // No scan behind the tree on screen: its map is laid out here, from it (J05).
      const held = scanAtRequest ? null : await tmHeldTreemap(rootPath);
      if (seq !== tmLoadSeq) return; // superseded while a withheld folder was fetched
      if (!scanAtRequest && !held) return;
      let data = held ? held(TM_MIN_SIZE) : await api(`/api/scan/${scanAtRequest}/treemap?maxDepth=${state.treemap.maxDepth}&minSize=${TM_MIN_SIZE}&root=${encodeURIComponent(rootPath)}`);
      if (seq !== tmLoadSeq) return; // a newer view/root load has superseded this fetch
      // The 4 KB floor keeps a big folder's map legible; in a folder of
      // dotfiles, scripts or one small file it hides everything, and a blank
      // panel reads as a broken app. When it drew nothing and there are bytes
      // to draw, ask again without the floor.
      if (!data.nodes.length && data.root.size > 0) {
        floor = 1;
        data = held ? held(1) : await api(`/api/scan/${scanAtRequest}/treemap?maxDepth=${state.treemap.maxDepth}&minSize=1&root=${encodeURIComponent(rootPath)}`);
        if (seq !== tmLoadSeq) return;
      }
      if (state.treemap.history.scrubbing) return; // same rule as above: a scrub in flight owns the map
      // The last map a scan answered, for the Stop above.
      if (scanAtRequest) state.treemap.scanMap = { scanId: scanAtRequest, ask: rootPath, maxDepth: state.treemap.maxDepth, data: ownNodes(data), floor };
      land(data, floor, scanAtRequest);
    }
  } catch (e) {
    // Through reportError: the scan's results expiring is said as its sentence, never as "Treemap failed" (K05).
    reportError(e, 'Treemap failed');
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
    host.innerHTML = `<span class="tm-legend-end">1 MB</span><div class="legend-grad" style="background:${sizeRampCss()}"></div><span class="tm-legend-end">10 GB+</span>` + tmMarksKey();
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
    items.push('<span class="mk" title="In the Clean Up cart — nothing is deleted until you move it to the Trash"><i class="mk-sw mk-staged"></i>staged for the Trash</span>');
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
  // Nothing in flight, and no scan behind the tree on screen — the saved
  // index's: nothing was asked, and nothing will be until a scan of it lands,
  // so "still loading" would be false (review F3.3).
  const noScan = reclaimNoScanWords();
  if (noScan) return ' ' + noScan;
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
 * draw: the time-lapse bar, a toolbar that wraps, a footer that wraps, the
 * room the cart pill reserves at the bottom of <main>. The footer — legend,
 * counts, hint — then fell below the window. A no-op unless the height the
 * map should have differs from the one it was drawn at, and nothing before
 * the first draw, which measures for itself. The query bar (Save view ·
 * Stage matches) is no row any more: since design pass G19 it is a layer
 * over the foot of the map, which never moves the canvas. It is still
 * watched below, where a change of its size is one of these no-ops.
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
 * the rest, under a status line reading "20,000 of 20,000 items drawn" — the
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

/**
 * The note over an empty map. Empty text hides it. Its words are said in
 * #tmEmptySaid a frame after it shows them — the same note again, as a repaint
 * of the same empty map gives it, is no news — and taken back as it goes
 * (BQU item 24). Guarded: a page reader may lift this without sayAloud.
 */
function tmSetEmpty(text) {
  const el = $('tmEmpty');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
  if (typeof sayAloud === 'function') sayAloud('tmEmptySaid', text);
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
 * is told by the folder frames and the toned outlines instead (pass 2.6–2.7), and
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
/**
 * The map's outlines — the owner's decisions of 20 Oct 2026. First "the maps
 * outlines should be contrasting and easy to see", in both themes, while the
 * colour still pops; then, from before and after screenshots, "Refine it":
 * keep the outlines at 3:1, taper them so there is no hard step at 8 px,
 * thinner frames on small and nested folders so dense corners and small
 * folders stay bright, a faint texture where tiles are too small for an
 * outline, and every line at 3:1 against the tile on each of its sides. So:
 *   - every rectangle is laid on whole device pixels (tmSnap), and every line
 *     and band is a whole number of them wide (tmLinePx), so a 1 px line is one
 *     crisp line, never a device pixel and part of the next that blends into
 *     its tile; under a device pixel ratio of 1 (a page zoomed out) the
 *     painter's px is a device pixel, and the 8 px step, the band steps and the
 *     texture's pitch are taken in device pixels (tmPxScale);
 *   - two leaves of TM_DENSE_PX and up meet at ONE 1 px line, the right or
 *     lower leaf's own left or top edge (tmLeafLines): each such leaf draws its
 *     top and left edges, and its right and bottom edges only where what lies
 *     beyond is not such a leaf. A grid of 8 px tiles is a 1 px grid, as a grid
 *     of 7 px tiles is a 1 px texture: nothing doubles at 8 px. Each stretch of
 *     a line is a shade of its leaf's own colour toned against the tiles on
 *     BOTH its sides (tmToneFor) — its own leaf, and whatever lies beyond: a
 *     neighbour, a smaller leaf, a folder's fill, the ground of a hollow or
 *     staged cell. Where no one shade reaches TM_EDGE_MIN
 *     against both, either the two tiles already differ by that much — a light
 *     tile beside the dark theme's ground, or beside Reclaim's dark "not
 *     scored" grey — and the stretch needs no line, or it is two lines, each
 *     toned against the tile on its own side (tmSeamParts). Under a dark top
 *     line a highlight runs, part of the cushion and as deep as it is
 *     (tmLitAlpha);
 *   - a leaf thinner than TM_DENSE_PX has no outline: its top and left pixel
 *     are a texture, a slightly darker shade of its own colour on a light tile
 *     and a lighter one on a dark tile (tmTextureStops), at tmTextureContrast —
 *     1.1:1 on a 2 px leaf up to 1.375:1 on a 7 px one, so a folder of tiny
 *     files reads as many files while its mean lightness (L*) stays within a
 *     tenth of the solid fill's: never near-black, never a mesh. A folder's
 *     own fill (J51) carries the same kind of texture, a seam every
 *     TM_TEXTURE_PITCH px at 1.21:1, for its files too small to draw. A
 *     texture keeps a pixel clear of every line (tmLineMask), so a line only
 *     ever meets a tile's fill;
 *   - a folder is framed inside its own box by a band tmBandWidth px wide, by
 *     its size and depth: 3 px for a top-level folder 96 px or more across its
 *     thinner side, 2 px from 64 px (a nested one too), 1 px from
 *     TM_DENSE_PX, and none under it — a folder that small reads by texture,
 *     its own fill's (seamed from its corner) and its contents', as a small
 *     leaf does. Each stretch of a band is toned
 *     against what a person sees beside it (tmFrameBands): inside, what lies
 *     just past the band — never a sliver the band itself covers — to
 *     TM_FRAME_MIN; outside, a tile beside it, to TM_EDGE_MIN. Beside a leaf's
 *     line or another band, lines meet lines;
 *   - a folder's area that no rectangle covers (its files under the map's
 *     size floor, or past the server's cap) is filled with the folder's own
 *     colour and cushion (seventh browser pass J51), and its texture. A folder
 *     an online-only file is hidden in keeps the ground.
 * The SVG export and the lens paint from what the canvas recorded on each
 * rectangle (r.bg, r.tex, r.lit, r.lines, r.bands), so they paint what the
 * canvas paints; tests/mapColourPop.test.ts rasterizes realistic dense maps in
 * both themes and measures every line on its pixels.
 */
const TM_DENSE_PX = 8;      // px: a leaf this thick has lines of its own; a folder this thick, a band
const TM_TEXTURE_PX = 2;    // px: the thinnest leaf with a texture
const TM_TEXTURE_PITCH = 4; // px: the cells of the texture over a folder's own fill (J51)
const TM_EDGE_MIN = 3.3;    // a leaf's line against the tile on each of its sides
const TM_FRAME_MIN = 4.5;   // a folder's band against what lies inside it
const TM_LIT = 0.18;        // the white of a leaf's top highlight, on a tile tall enough for its whole cushion
/**
 * `v` css px on the nearest whole device pixel; a half device pixel rounds up,
 * and so does one that float noise puts a hair under it. A layout's far edge
 * is spelled 100 % or 99.99999999999999 %, which on a map 241 css px tall at
 * 150 % is 361.5 or 361.49999999999994 device px: a bare round put a file a
 * device pixel past the folder it ends with — out of the box the History
 * diff's wash over the folder is counted in, and beside the folder's band,
 * toned against the map's ground beyond the folder, at 1.02:1 (review F3.1).
 * Two spellings of one edge differ by far less than a millionth of a device
 * pixel.
 */
function tmSnap(v, dpr) {
  return Math.round(v * dpr + 1e-6) / dpr;
}
/**
 * The painter's px in css px, the unit its sizes are taken in — the 8 px step,
 * the band steps, the texture's pitch: a css px, or a device pixel where that
 * is the larger, under a device pixel ratio of 1 (a page zoomed out), as on a
 * map that many device pixels across at 100 % (review F3.6).
 */
function tmPxScale(dpr) {
  return Math.max(1, 1 / dpr);
}
/**
 * `px` painter's px of a line or a band, in css px, always a whole number of
 * device pixels: `px` device pixels under a device pixel ratio of 1, where a
 * 1 css px line was part of a device pixel, which the canvas blends with the
 * tile beside it — 2.47:1 at worst at 80 %, 1.95:1 at 67 %, under the owner's
 * 3:1 (review F3.6) — and from 1 up the most whole device pixels no wider than
 * `px` css px, and never none: at 125, 150 and 175 % a 1 css px line was a
 * device pixel and part of the next, blended with its tile there (residual 4).
 * No line or band is wider than its css width, so it takes no more of the map
 * at any ratio than at 100 %, where the owner's budgets are set: at 150 % two
 * device pixels for a 1 px line put the dense corner's pixels under luminance
 * 0.08 at 25.1 %, over the owner's 22 %, and at 175 % two (the nearest) put
 * corpus/Mail at 42.5 % band, over the owner's 40 %. At 150 % a 1 px line is
 * one device pixel, a 2 px band three and a 3 px band four; at 175 % one, three
 * and five.
 */
function tmLinePx(px, dpr) {
  if (dpr < 1) return px * tmPxScale(dpr);
  return Math.max(1, Math.floor(px * dpr + 1e-9)) / dpr;
}
/**
 * `px` painter's px of a texture's seam, in css px: `px` device pixels under a
 * device pixel ratio of 1, as a line (tmLinePx), and `px` css px from 1 up —
 * at 125, 150 and 175 % a device pixel and part of the next, a fainter seam
 * there, so a texture covers as much of its tile at every ratio as at 100 %:
 * laid one device pixel thick, a folder's seams covered 25.3 % of it at
 * 150 % where they cover 33.9 % at 100 % (review F3.4). A texture is no line:
 * nothing is asked of it against the tile beside it.
 */
function tmSeamPx(px, dpr) {
  return px * tmPxScale(dpr);
}
/**
 * Whether a size of `m` css px reaches `px`. A rectangle's width and height are
 * differences of two edges laid on whole device pixels (tmSnap), which at 125,
 * 150 and 175 % carry float noise — (29 / 1.5) − (17 / 1.5) is
 * 7.999999999999998 — and a bare >= put some of a grid of identical 8 px tiles
 * under the step and the rest over it, lined beside textured, and took some
 * folders' bands a step thinner (review F1.1). Two sizes on whole device pixels
 * are a device pixel apart or the same, never a millionth of a px.
 */
function tmReaches(m, px) {
  return m >= px - 1e-6;
}
/** Whether a leaf gets lines of its own (and, under a dark one, a top highlight): only one with room for them, in painter's px. */
function tmLeafEdged(r) {
  return tmReaches(Math.min(r.w, r.h) / tmPxScale(r.dpr || 1), TM_DENSE_PX);
}
/** Where a leaf's top highlight runs (r.lit): a line one painter's px wide (tmLinePx) under its top line, a line's width in from each end. */
function tmLitLine(r) {
  const t = tmLinePx(1, r.dpr || 1);
  return { x0: r.x + t, x1: r.x + r.w - t, y: r.y + 1.5 * t, width: t };
}
/**
 * The white of a leaf's top highlight, a share of TM_LIT as its cushion is of
 * the whole (TM_CUSHION_FULL_H): on a short tile, whose cushion is shallow, a
 * full-strength highlight would be a light line of its own, stepping in at
 * TM_DENSE_PX with the lines.
 */
function tmLitAlpha(r) {
  return TM_LIT * Math.max(0, Math.min(1, r.h / TM_CUSHION_FULL_H));
}
/**
 * What a leaf shows at its edges, by its thinner side: lines of its own
 * ('edged'), a texture ('textured') or neither ('solid'); a staged block or a
 * hollow online-only file shows the map's ground ('cell').
 */
function tmLeafKind(r) {
  if (r.shows) return 'cell';
  const m = Math.min(r.w, r.h) / tmPxScale(r.dpr || 1);
  return tmReaches(m, TM_DENSE_PX) ? 'edged' : tmReaches(m, TM_TEXTURE_PX) ? 'textured' : 'solid';
}
/**
 * Folder `r`'s band, in css px (tmLinePx): by its thinner side in painter's
 * px and its depth — 3 for a top-level folder 96 px or more across, 2 from
 * 64 px, 1 from TM_DENSE_PX — and none when it is thinner than that. 2 px
 * came from 32 px (48 nested): corpus/Mail, 58×52 px in the corpus map, stood
 * at 39.5 % band, its own 2 px band a fifth of that (residual 9).
 */
function tmBandWidth(r) {
  const dpr = r.dpr || 1, m = Math.min(r.w, r.h) / tmPxScale(dpr);
  if (!tmReaches(m, TM_DENSE_PX)) return 0;
  return tmLinePx(r.n.depth <= 1 && tmReaches(m, 96) ? 3 : tmReaches(m, 64) ? 2 : 1, dpr);
}
/** A texture's contrast against the tile it lies on, by the tile's thinner side `s` px: 1.1:1 at 2 px, rising to 1.375:1 at 7. */
function tmTextureContrast(s) {
  return 1.1 + 0.055 * (Math.max(TM_TEXTURE_PX, Math.min(TM_DENSE_PX - 1, s)) - TM_TEXTURE_PX);
}
/**
 * A cushion's texture, stop by stop: the shade of each stop nearest it that
 * reaches `target` against it, in 256 steps — toward black when the tile's own
 * colour `base` is light, toward white when it is dark. For a stop of whole
 * numbers each step moves every channel one way, so its contrast with the
 * stop only grows, and the first step that reaches `target` is found by
 * halving: nine tries, where trying each took up to 256 for every leaf with a
 * texture (review F1.13). Any other stop is tried step by step.
 */
function tmTextureStops(stops, base, target) {
  const toward = tmLuminance(base) >= 0.18 ? [0, 0, 0] : [255, 255, 255];
  return stops.map((c) => {
    if (tmContrast(mix(c, toward, 1), c) < target) return toward;
    if (!c.every(Number.isInteger)) {
      for (let k = 1; k <= 256; k++) {
        const m = mix(c, toward, k / 256);
        if (tmContrast(m, c) >= target) return m;
      }
    }
    let lo = 0, hi = 256; // the step at `hi` reaches the target; every step to `lo` falls short
    while (hi - lo > 1) {
      const k = (lo + hi) >> 1;
      if (tmContrast(mix(c, toward, k / 256), c) >= target) hi = k; else lo = k;
    }
    return mix(c, toward, hi / 256);
  });
}
/** CIE L* of the sRGB colour `c` ([r, g, b], 0–255), from its relative luminance. */
function tmLstar(c) {
  return tmLstarOf(tmLuminance(c));
}
/** CIE L* of a relative luminance `y`. */
function tmLstarOf(y) {
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}
/** The D65 white, in XYZ: CIE L*a*b* is reckoned against it. */
const TM_D65 = [0.95047, 1, 1.08883];
/** CIE L*a*b* of the sRGB colour `c`, [L, a, b]. */
function tmLab(c) {
  const lin = c.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  const xyz = [0.4124564 * lin[0] + 0.3575761 * lin[1] + 0.1804375 * lin[2], 0.2126729 * lin[0] + 0.7151522 * lin[1] + 0.072175 * lin[2],
    0.0193339 * lin[0] + 0.119192 * lin[1] + 0.9503041 * lin[2]];
  const [fx, fy, fz] = xyz.map((v, i) => { const t = v / TM_D65[i]; return t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116; });
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
/** The sRGB colour of CIE L*a*b* `lab`, [r, g, b] 0–255 unrounded — a channel under 0 or over 255 where it lies outside sRGB. */
function tmFromLab([L, a, b]) {
  const fy = (L + 16) / 116, f = [fy + a / 500, fy, fy - b / 200];
  const [X, Y, Z] = f.map((t, i) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27)) * TM_D65[i]);
  const lin = [3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, -0.969266 * X + 1.8760108 * Y + 0.041556 * Z, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z];
  return lin.map((v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
}
/**
 * The least share of its chroma a leaf's colour keeps when its lightness is
 * moved (tmShiftL): the owner's colour still pops. A leaf with lines of its
 * own keeps all of it (TM_LIFT_CHROMA) — inside every outlined tile it shows
 * at least 0.8 of its colour's strength, its cushion included, and the top
 * of the size ramp C*ab 60 (tests/mapColourPop.test.ts), and a tall orange
 * tile's cushion alone leaves it 0.82 — and one with a texture, a few px
 * across, all but 5 % (TM_SHIFT_CHROMA). A saturated amber lifted 1 L* gives
 * up 15 % of its chroma; darkened 5 L*, under 5 %.
 */
const TM_SHIFT_CHROMA = 0.95;
const TM_LIFT_CHROMA = 1;
/**
 * The colour `c` with its CIE L* moved by up to `dL`, its hue kept: its
 * chroma too where that lies inside sRGB, else the least chroma given up
 * that brings it in — never past `floor` of it, so where a lightness needs
 * more (a saturated amber lifted toward white), the lightness is moved only
 * as far as that allows.
 */
function tmShiftL(c, dL, floor = TM_SHIFT_CHROMA) {
  const [L, a, b] = tmLab(c);
  const inside = (rgb) => rgb.every((v) => v >= -0.5 && v <= 255.5);
  // The most chroma that lies inside sRGB at lightness L2, as a share of c's own, and the colour there.
  const at = (L2) => {
    let rgb = tmFromLab([L2, a, b]);
    if (inside(rgb)) return { k: 1, rgb };
    let lo = 0, hi = 1;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (inside(tmFromLab([L2, a * mid, b * mid]))) lo = mid; else hi = mid;
    }
    return { k: lo, rgb: tmFromLab([L2, a * lo, b * lo]) };
  };
  const clampL = (v) => Math.max(0, Math.min(100, v));
  let got = at(clampL(L + dL));
  if (got.k < floor) {
    // As far toward L + dL as keeps `floor` of the chroma.
    let lo = 0, hi = 1;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (at(clampL(L + dL * mid)).k >= floor) lo = mid; else hi = mid;
    }
    got = at(clampL(L + dL * lo));
  }
  return got.rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))));
}
/** The share of a tile one painter's px under TM_DENSE_PX that its texture takes: its top row and its left column. */
const TM_TEXTURE_SHARE = 1 - ((TM_DENSE_PX - 2) / (TM_DENSE_PX - 1)) ** 2;
/** The most L* a leaf's fill is moved for its lines or its texture, either way. */
const TM_FILL_SHIFT_MAX = 30;
/** The L* of a cushion's middle, its stops `stops` as the screen shows them through `washes`. */
function tmCushionL(stops, washes) {
  const seen = tmSeenThrough(stops, washes);
  return tmLstar(mix(seen[0], seen[1], 0.5));
}
/**
 * The L* a line beside a cushion showing `seen` (its stops on the screen) may
 * take at most (a dark line, `light` false) or at least (a light one): the
 * luminance at TM_EDGE_MIN from the stop nearest it. Pass 2.6 tones a line to
 * the first of 32 shades of its tile's fill that reaches that (tmToneFor); a
 * line moves with this bound as the fill moves.
 */
function tmLineBoundL(seen, light) {
  const ys = seen.map(tmLuminance);
  return tmLstarOf(light ? Math.min(1, TM_EDGE_MIN * (Math.max(...ys) + 0.05) - 0.05) : Math.max(0, (Math.min(...ys) + 0.05) / TM_EDGE_MIN - 0.05));
}
/**
 * How far in mean L* a tile of TM_DENSE_PX − 1 painter's px, of colour `base`
 * as the screen shows it through `washes` at device pixel ratio `dpr`, stands
 * from its solid cushion once its texture is laid: its texture's share of it
 * (TM_TEXTURE_SHARE) in the texture's shade (tmTextureStops at
 * tmTextureContrast). What a leaf with lines of its own is brought back to
 * (tmEdgedFill): a 3:1 line took as much of an 8 px tile as a 1.375:1
 * texture of a 7 px one, so the map darkened in one step at 8 px.
 */
function tmTextureMean(base, washes, dpr) {
  const stops = tmLeafStops(base, (TM_DENSE_PX - 1) * tmPxScale(dpr), null), tex = tmTextureStops(stops, base, tmTextureContrast(TM_DENSE_PX - 1));
  return TM_TEXTURE_SHARE * (tmCushionL(tex, washes) - tmCushionL(stops, washes));
}
/**
 * The mean L* less its solid cushion's of a tile of colour `base`, `h` css px
 * tall, through `washes`, once filled tmShiftL(base, t, TM_LIFT_CHROMA), with
 * its lines `lines` — [{ a, L, light, cap }]: the share of the tile each
 * takes, its L* as laid on the tile filled `base`, whether it is lighter than
 * the tile, and the bound the tile beyond it sets (tmLineBoundL; ±Infinity
 * where that tile moves with this one, a leaf with lines of its own, or none
 * does). A line moves as the nearer of its two bounds does. The function of
 * `t` that tmEdgedFill and tmTexturePull solve, as { fill, mean }.
 */
function tmLinedMean(base, h, washes, lines) {
  const seenOf = (c) => tmSeenThrough(tmLeafStops(c, h, null), washes);
  const lined = lines.reduce((sum, l) => sum + l.a, 0), solid = tmCushionL(tmLeafStops(base, h, null), washes);
  const held = lines.reduce((sum, l) => sum + l.a * l.L, 0);
  // Where a line may lie, by its own tile's bound and the one beyond: no lighter than either (a dark line), or no darker.
  const bounds = (seen) => [tmLineBoundL(seen, false), tmLineBoundL(seen, true)];
  const at = (l, b) => (l.light ? Math.max(b[1], l.cap) : Math.min(b[0], l.cap));
  const b0 = bounds(seenOf(base));
  return (t) => {
    const fill = t ? tmShiftL(base, t, TM_LIFT_CHROMA) : base, seen = seenOf(fill), b = bounds(seen);
    const moved = lines.reduce((sum, l) => sum + l.a * (at(l, b) - at(l, b0)), 0);
    return { fill, mean: (1 - lined) * tmLstar(mix(seen[0], seen[1], 0.5)) + held + moved - solid };
  };
}
/** The most shifts tmSolveFill tries past the first, and the least gap between two either side of its target it splits. */
const TM_SOLVE_TRIES = 12;
const TM_SOLVE_GAP = 0.02;
/**
 * The fill that brings `mean` (tmLinedMean) to `want`, moving L* the way that
 * does — up when its lines darken it past that, down when they lighten it —
 * as far as TM_LIFT_CHROMA lets the colour go; and the mean it gets there.
 * The mean only ever moves one way with the shift, and nearly in step with
 * it, so the secant through the last two shifts tried finds it in two or
 * three tries. But it moves in steps — each fill is whole sRGB values, a few
 * tenths of an L* apart — and stops moving where the colour meets sRGB's
 * edge, and a secant through two tries on nearly one step is flung far off:
 * kept as the last of four tries, it left Reclaim 67's 8 px tiles 3.8 L*
 * darker than its 9 px ones, and Reclaim 66's 13 px tiles 5.7 L* darker than
 * its 12 px (review F2.1). So once two tries lie either side of `want`, each
 * try is kept between them — the secant's, where it falls there, else
 * halfway — until they are TM_SOLVE_GAP apart (a step no shift between them
 * crosses); the answer is the try nearest `want`, the later on a tie, never
 * merely the last; and short of `want`, a try that leaves the mean on the
 * step it was on is followed by one twice as far, until a shift can go no
 * further — the colour at sRGB's edge.
 */
function tmSolveFill(mean, want) {
  const first = mean(0), e = first.mean - want;
  if (Math.abs(e) <= 0.05) return first;
  const dir = e < 0 ? 1 : -1, short = (err) => Math.sign(err) === Math.sign(e);
  let best = first, bestErr = Math.abs(e);
  // The shift furthest along that leaves the mean short of `want`, and the nearest past it, once a try is.
  let lo = 0, hi = null;
  // The try before, and the next: a first step as if the mean moved as the fill does where no line lies.
  let s0 = 0, e0 = e, s1 = Math.min(TM_FILL_SHIFT_MAX, -e * dir) * dir;
  for (let i = 0; i <= TM_SOLVE_TRIES; i++) {
    const got = mean(s1), e1 = got.mean - want;
    if (Math.abs(e1) <= bestErr) [best, bestErr] = [got, Math.abs(e1)];
    if (bestErr <= 0.1) break;
    if (short(e1)) lo = s1; else hi = s1;
    const flat = !(Math.abs(e1 - e0) > 1e-3), secant = s1 - (e1 * (s1 - s0)) / (e1 - e0);
    let next;
    if (hi === null) {
      // Short of it still: on by the secant — twice as far where the last try left the mean on the same step — as far as
      // a shift goes: past that, the colour is at sRGB's edge.
      next = Math.max(-TM_FILL_SHIFT_MAX, Math.min(TM_FILL_SHIFT_MAX, flat ? s1 + (s1 - s0) : secant));
      if (!((next - lo) * dir > 1e-9)) break;
    } else {
      if (Math.abs(hi - lo) < TM_SOLVE_GAP) break;
      next = !flat && secant > Math.min(lo, hi) && secant < Math.max(lo, hi) ? secant : (lo + hi) / 2;
    }
    [s0, e0, s1] = [s1, e1, next];
  }
  return best;
}
/** The area of the union of `rects` ([{ x, y, w, h }]): each one's, less where two overlap (a corner where two lines meet). */
function tmUnionArea(rects) {
  let sum = 0;
  for (let i = 0; i < rects.length; i++) {
    const a = rects[i];
    sum += a.w * a.h;
    for (let j = i + 1; j < rects.length; j++) {
      const b = rects[j];
      sum -= Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    }
  }
  return Math.max(0, sum);
}
/**
 * What a leaf with lines of its own (tmLeafKind 'edged') is filled with, once
 * pass 2.6 has first laid its lines (`r.lines`) over its colour `base`: that
 * colour with its CIE L* moved away from its lines' shades (tmShiftL —
 * lighter under dark lines, darker under light ones, hue and chroma kept) by
 * just enough that the tile, fill and lines together, keeps the mean
 * lightness a texture keeps a tile one painter's px too small for lines
 * (tmTextureMean), as far as TM_LIFT_CHROMA allows. A 3:1 line takes as much
 * of a tile as a 1.375:1 texture did one px under it, so the map darkened in
 * one step at 8 px: an 8 px tile 6.3 L* darker than a 7 px one on the size
 * ramp's amber, a lone row of 8 px tiles among 7 px rows a dark stripe, and
 * corpus/Mail opened as the map a dark grid of its lined files, 10 L* under
 * their colour (residuals 3 and 5). Pass 2.6 then tones every line again
 * against the fills as painted, so each still reaches TM_EDGE_MIN on both its
 * sides: a line beside a tile that keeps its fill moves only as far as that
 * tile lets it; the rest move with the fill (tmLinedMean). The
 * tile is judged where it shows: a folder's band laid over its edge is the
 * folder's. What it is brought to is its colour's canonical leaf's
 * (tmCanonicalLeaf): that texture's lightness where the canonical leaf's
 * lines move it the way the texture does, else its solid colour's — judged on
 * that leaf, not on this one's lines, since a cushion can turn a leaf's lines
 * the other tone: Reclaim's grey-olive at 18 px took light lines where at 17
 * px it took dark ones, and was brought to its texture's lightness where the
 * rest were brought to their colour's, 2.3 L* lighter (review F2.1). A tile
 * its lines move toward that, and no further, keeps its colour, and so does
 * one with lines of both tones — a grey between a dark file and a light one,
 * whose line beside the light one, a dark shade of it, stood out from both
 * until the lighter lines darkened its fill, and then none did, so both files
 * laid lines there, side by side. `g` is the neighbourhood (tmNeighbourhood),
 * whose `fills` keeps what each alike tile was filled with and `targets` what
 * each colour's leaves are brought to, and `washes` the History diff washes
 * over the tile.
 */
function tmEdgedFill(r, g, base, washes) {
  // Its box as a person sees it: less the bands of the folders whose edge it lies along, laid over its own edge.
  const inset = { top: 0, bottom: 0, left: 0, right: 0 };
  for (let f = g.folderOf.get(r); f; f = g.folderOf.get(f)) {
    for (const side of Object.keys(inset)) if (f.lw > 0 && tmTouches(r, f, side)) inset[side] = Math.max(inset[side], f.lw);
  }
  const x0 = r.x + inset.left, x1 = r.x + r.w - inset.right, y0 = r.y + inset.top, y1 = r.y + r.h - inset.bottom;
  const area = Math.max(x1 - x0, 0) * Math.max(y1 - y0, 0);
  if (!(area > 0)) return base;
  // Its lines where they show, each with its L*.
  const shown = [];
  for (const l of r.lines || []) {
    const lx = Math.max(x0, l.x), ly = Math.max(y0, l.y), w = Math.min(x1, l.x + l.w) - lx, h = Math.min(y1, l.y + l.h) - ly;
    if (w > 1e-6 && h > 1e-6) shown.push({ x: lx, y: ly, w, h, L: tmLstar(tmCssRgba(l.rgb) || [0, 0, 0]) });
  }
  const covered = Math.min(tmUnionArea(shown), area), sum = shown.reduce((a, l) => a + l.w * l.h, 0);
  if (!(covered > 0)) return base;
  const seen = tmSeenThrough(r.stops, washes), fillL = tmLstar(mix(seen[0], seen[1], 0.5));
  const lines = shown.map((l) => ({ ...l, a: (covered / area) * (l.w * l.h) / sum, light: l.L > fillL }));
  // Lines of both tones: a shade lighter or darker would leave no shade of it standing out from one side or the other.
  if (lines.some((l) => l.light) && lines.some((l) => !l.light)) return base;
  // How far its lines take it from its colour, against where its colour's canonical leaf is brought.
  const solid = tmCushionL(tmLeafStops(base, r.h, null), washes), d0 = lines.reduce((a, l) => a + l.a * (l.L - solid), 0);
  const tkey = `${base}|${washes.join(';')}`;
  if (!g.targets.has(tkey)) g.targets.set(tkey, tmCanonicalLeaf(base, g.dpr, washes).want);
  const want = g.targets.get(tkey);
  if (Math.abs(d0 - want) <= 0.05 || (Math.sign(d0) === Math.sign(want) && Math.abs(d0) <= Math.abs(want))) return base;
  // What lies beyond each side (tmAcross): a tile that keeps its fill — a texture's, a folder's own — bounds the line
  // beside it; a leaf with lines of its own is moved as this one is, and a line or the map's edge sets none.
  const across = {};
  for (const side of Object.keys(TM_SIDES)) across[side] = tmAcross(r, side, g);
  const sideOf = (l) => (l.w >= l.h ? (Math.abs(l.y - r.y) <= Math.abs(l.y + l.h - r.y - r.h) ? 'top' : 'bottom')
    : (Math.abs(l.x - r.x) <= Math.abs(l.x + l.w - r.x - r.w) ? 'left' : 'right'));
  for (const l of lines) {
    const [p, s] = TM_SIDES[sideOf(l)];
    l.cap = l.light ? -Infinity : Infinity;
    for (const seg of across[sideOf(l)]) {
      const beyond = [...(seg.beside || []), ...(seg.grain || [])];
      if (seg.line || seg.edged || seg.covered || !beyond.length || !(seg.hi > l[p] + 1e-6 && seg.lo < l[p] + l[s] - 1e-6)) continue;
      const b = tmLineBoundL(beyond, l.light);
      l.cap = l.light ? Math.max(l.cap, b) : Math.min(l.cap, b);
    }
  }
  const key = `${base}|${washes.join(';')}|${r.h.toFixed(1)}|${lines.map((l) => `${l.a.toFixed(3)}:${l.L.toFixed(1)}:${l.cap.toFixed(1)}`).join(',')}`;
  if (!g.fills.has(key)) g.fills.set(key, tmSolveFill(tmLinedMean(base, r.h, washes, lines), want).fill);
  return g.fills.get(key);
}
/**
 * The leaf with lines of its own that every lined leaf of colour `base` is
 * judged by, at device pixel ratio `dpr`, through `washes`: TM_DENSE_PX
 * painter's px square, its top and left lines one line's width (tmLinePx),
 * each toned against a tile alike. As { mean, d0, texture, want }: its mean
 * L* less its solid cushion's as its fill is shifted (tmLinedMean), that at
 * no shift — how far its lines take it — the mean a texture gives a tile one
 * painter's px smaller (tmTextureMean), and what it is brought to: that
 * texture's lightness where its lines move it the way the texture does, else
 * its solid colour's (tmEdgedFill, tmTexturePull).
 */
function tmCanonicalLeaf(base, dpr, washes) {
  const lw = tmLinePx(1, dpr) / tmPxScale(dpr), lined = 1 - (1 - lw / TM_DENSE_PX) ** 2, h = TM_DENSE_PX * tmPxScale(dpr);
  const seen = tmSeenThrough(tmLeafStops(base, h, null), washes), tone = tmTone(base, seen, TM_EDGE_MIN);
  const mean = tmLinedMean(base, h, washes, [{ a: lined, L: tmLstar(tone.rgb), light: tone.light, cap: tone.light ? -Infinity : Infinity }]), d0 = mean(0).mean;
  const texture = tmTextureMean(base, washes, dpr), want = Math.sign(d0) === Math.sign(texture) ? texture : 0;
  return { mean, d0, texture, want };
}
/** The least pull worth a texture's leaves (tmTexturePull), in mean L*: under it they keep their colour. */
const TM_PULL_MIN = 0.25;
/**
 * How far in mean L* a leaf of TM_DENSE_PX − 1 painter's px with a texture
 * is moved to meet what a leaf of TM_DENSE_PX with lines of its own shows, on
 * colour `base` at device pixel ratio `dpr`, through `washes`: none where
 * tmEdgedFill brings the lined leaf to its texture's lightness, else the rest
 * of the way. A 3:1 line on a saturated amber or orange cannot be offset by a
 * lighter fill without the colour giving up its strength — an amber lifted
 * 1 L* keeps 85 % of its chroma — so an 8 px leaf of the size ramp's amber
 * stood 5.5 L* darker than a 7 px one, whose texture is faint (1.375:1); the
 * texture's leaves are darkened a shade instead, so the step at 8 px is no
 * step (residual 3). The lined leaf is the canonical one (tmCanonicalLeaf).
 */
function tmTexturePull(base, dpr, washes) {
  const { mean, d0, texture, want } = tmCanonicalLeaf(base, dpr, washes);
  const reached = Math.abs(d0) <= Math.abs(want) + 0.05 ? d0 : tmSolveFill(mean, want).mean;
  const gap = reached - texture;
  return Math.abs(gap) < TM_PULL_MIN ? 0 : gap;
}
/**
 * What a leaf with a texture (tmLeafKind 'textured') `s` painter's px across
 * its thinner side is filled with: its colour `base` with its L* moved
 * toward a lined leaf's (tmTexturePull) by a share of the way that grows
 * with its size, from none at 1 px to the whole at TM_DENSE_PX − 1 — so
 * neither 8 px nor any size under it is a step. `cache` keeps the pull of
 * each colour.
 */
function tmTexturedFill(base, s, dpr, washes, cache) {
  const key = `${base}|${washes.join(';')}|${dpr}`;
  let pull = cache && cache.get(key);
  if (pull === undefined) {
    pull = tmTexturePull(base, dpr, washes);
    if (cache) cache.set(key, pull);
  }
  if (!pull) return base;
  const share = (Math.max(1, Math.min(TM_DENSE_PX - 1, s)) - 1) / (TM_DENSE_PX - 2);
  return share > 0 ? tmShiftL(base, pull * share) : base;
}
/**
 * The shade of `base` nearest to it that reaches, against every colour of each
 * group in `groups` — [[colours, target], …], what the screen shows beside the
 * line, through any History diff wash — that group's target, as { rgb, light,
 * ok }: toward black or toward white, whichever needs the smaller step (black
 * on a tie), in 32 steps. Every line is laid after the washes, so it is seen
 * as toned. Each step is tried, since a shade between a light colour and a
 * dark one can stand out from both. Where none reaches every target, `ok` is
 * false and `rgb` is the shade that comes nearest. Each answer is kept for
 * the paint (TM_TONE_MEMO): a map of thousands of files alike asks the same
 * question thousands of times, twice where its leaves' fills are moved
 * (tmEdgedFill).
 */
function tmToneFor(base, groups) {
  const key = `${base}|${groups.map(([cols, target]) => `${cols.join(';')}@${target}`).join('|')}`;
  let got = TM_TONE_MEMO.get(key);
  if (!got) {
    got = tmToneSearch(base, groups);
    if (TM_TONE_MEMO.size >= TM_TONE_MEMO_MAX) TM_TONE_MEMO.clear();
    TM_TONE_MEMO.set(key, got);
  }
  return { rgb: got.rgb.slice(), light: got.light, ok: got.ok };
}
/** tmToneFor's answers, by question: kept across paints, drawTreemap empties it before a paint once it holds more than TM_TONE_MEMO_KEEP. */
const TM_TONE_MEMO = new Map();
/** The most answers TM_TONE_MEMO keeps before it starts again, within one paint. */
const TM_TONE_MEMO_MAX = 200000;
/** The most answers a paint leaves TM_TONE_MEMO for the next, about 16 MB: a dense map's drag asks some 50,000. */
const TM_TONE_MEMO_KEEP = 60000;
/** tmToneFor's search, unkept. */
function tmToneSearch(base, groups) {
  // Each colour's luminance once; and the luminances a shade may not take against it — between (b + 0.05) / t − 0.05
  // and t (b + 0.05) − 0.05 it stands under the target — so the nearest shade is found by search, not by trying all 64.
  const lums = groups.filter(([cols]) => cols.length).map(([cols, target]) => [cols.map(tmLuminance), target]);
  const score = (c) => {
    const l = tmLuminance(c);
    let worst = Infinity;
    for (const [ls, target] of lums) {
      for (const b of ls) worst = Math.min(worst, ((l > b ? l : b) + 0.05) / ((l > b ? b : l) + 0.05) / target);
    }
    return worst;
  };
  const barred = [];
  for (const [ls, target] of lums) for (const b of ls) barred.push([(b + 0.05) / target - 0.05, target * (b + 0.05) - 0.05]);
  barred.sort((p, q) => p[0] - q[0]);
  const spans = [];
  for (const [lo, hi] of barred) {
    const last = spans[spans.length - 1];
    if (last && lo < last[1]) last[1] = Math.max(last[1], hi); else spans.push([lo, hi]);
  }
  // The first step toward `toward` whose shade reaches every target, or 0: the shades' luminance only ever moves one
  // way, so past a barred span is a search.
  const first = (toward, down) => {
    const lumAt = (k) => tmLuminance(mix(base, toward, k / 32));
    let k = 1;
    while (k <= 32) {
      const l = lumAt(k), span = spans.find(([lo, hi]) => l > lo && l < hi);
      if (!span) {
        if (score(mix(base, toward, k / 32)) >= 1) return k;
        k++;
        continue;
      }
      // The first step past the span's far end.
      let lo = k + 1, hi = 33;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (down ? lumAt(mid) <= span[0] : lumAt(mid) >= span[1]) hi = mid; else lo = mid + 1;
      }
      k = lo;
    }
    return 0;
  };
  const dark = first([0, 0, 0], true), light = first([255, 255, 255], false);
  if (dark && (!light || dark <= light)) return { rgb: mix(base, [0, 0, 0], dark / 32), light: false, ok: true };
  if (light) return { rgb: mix(base, [255, 255, 255], light / 32), light: true, ok: true };
  let best = null;
  for (let k = 1; k <= 32; k++) {
    for (const [toward, isLight] of [[[0, 0, 0], false], [[255, 255, 255], true]]) {
      const c = mix(base, toward, k / 32), sc = score(c);
      if (!best || sc > best.s) best = { rgb: c, light: isLight, s: sc };
    }
  }
  return { rgb: best.rgb, light: best.light, ok: false };
}
/** tmToneFor with one group: the shade of `base` that reaches `target` against each of `beside`. */
function tmTone(base, beside, target) {
  return tmToneFor(base, [[beside, target]]);
}
/** A CSS colour — #rgb, #rrggbb, rgb() or rgba() — as [r, g, b, a]; null when it is none of those. */
function tmCssRgba(v) {
  const s = String(v || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16)).concat(1);
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  return null;
}
/** The colour `fg` ([r, g, b, a], or null: nothing) laid over the opaque `bg`. */
function tmOver(fg, bg) {
  return fg ? mix(bg, fg, fg[3]) : bg;
}
/**
 * The map's ground as the screen shows it, [r, g, b]: --tm-canvas-bg over the
 * map's glass card over the page. A cell the painter clears to the ground — a
 * hollow cloud cell, a staged block — and the part of a folder an online-only
 * file is hidden in show it, so a line beside one is toned against it; it was
 * black there, unseen on the dark theme's ground (review F1.5).
 */
function tmGroundRgb() {
  const page = tmCssRgba(cssVar('--bg-1'));
  return tmOver(tmCssRgba(cssVar('--tm-canvas-bg')), tmOver(tmCssRgba(cssVar('--glass')), page ? page.slice(0, 3) : [12, 13, 20]));
}
/** A hollow online-only cell's faint wash, and its dashed outline: the shares of its colour over the ground (pass 1). */
const TM_HOLLOW_WASH = 0.16;
const TM_HOLLOW_DASH = 0.85;
/**
 * What a hollow online-only cell of colour `base` shows on its outermost
 * device pixel, over the map's `ground`, at device pixel ratio `dpr`: where
 * its dash is off, and where it is on. Pass 1 lays its faint wash from half
 * a css px in, and its dashed outline 1 px wide centred 1 px in — from half a
 * css px in too — so each covers that pixel by 1 − dpr / 2 of it: half at
 * 100 %, none from 200 % — but for the outline under a ratio of 2/3, where
 * the pixel is wider than 1.5 css px and the outline covers dpr of it (half
 * at 50 %). Taken to show the wash alone, a line was left out beside
 * it where its outline's half-pixel stood 1.40:1 from the file beyond
 * (review F2.1).
 */
function tmHollowEdge(ground, base, dpr) {
  const wash = Math.max(0, 1 - dpr / 2), dash = Math.max(0, Math.min(1, 1.5 * dpr) - dpr / 2);
  const off = mix(ground, base, TM_HOLLOW_WASH * wash);
  return [off, mix(off, base, TM_HOLLOW_DASH * dash)];
}
/**
 * What a staged block (the cart preview's) shows on its outermost device
 * pixel, over the map's `ground`, at device pixel ratio `dpr`: the ground laid
 * over it again (`inside`, what it shows inside its edge), with its hatch's
 * `amber` at half over that where a hatch line crosses the pixel (when
 * `hatched`), each where its dashed `amber` outline is off and where it is on
 * (when `dashed`: a block over 6 px across). Pass 1 lays the ground again and
 * the hatch from half a css px in, and the outline 1 px wide centred 1 px in,
 * so each covers that pixel by the share a hollow cell's wash and outline do
 * (tmHollowEdge). Reckoned as the hatch's amber at half over the ground laid
 * again at every ratio, it was lighter than the outline leaves that pixel in
 * the light theme where the outline covers more than half of it — 0.67 at
 * 67 %, 0.6 at 80 %, 0.55 at 90 % — and darker in the dark theme: a file of 8
 * px and up stood under 3:1 from a staged block beside it there (review F1.4
 * of BQJ-2c-r). Under a ratio of 1 pass 1 lays all three from a whole device
 * pixel in, and that pixel shows the `ground` alone: no one shade stood 3:1
 * from the ground, the hatch over it and the amber outline it blended there
 * (review F2.2 of BQJ-2c-r).
 */
function tmStagedEdge(ground, inside, amber, hatched, dashed, dpr) {
  if (dpr < 1) return [ground];
  const wash = Math.max(0, 1 - dpr / 2), dash = Math.max(0, Math.min(1, 1.5 * dpr) - dpr / 2);
  const off = mix(ground, inside, wash);
  const offs = hatched && amber ? [off, mix(off, amber, 0.5 * wash)] : [off];
  return dashed && amber ? [...offs, ...offs.map((c) => mix(c, amber, dash))] : offs;
}
/** The path of the folder `r` is filed under: its parent's, or for a staged block (the cart preview's) the folder it lies in. */
function tmFolderPathOf(r) {
  return r.n.freed && typeof r.n.parentPath === 'string' ? r.n.parentPath : tmParentPath(r.n.path);
}
/**
 * Each folder's drawn rectangles, by the folder's path. A staged block (the
 * cart preview's) is filed under the folder it lies in, its `parentPath`: its
 * name, "<folder> — freed", reads as a name in the folder above, which filed
 * it there — counted twice in that folder, whose own fill (pass 0) it then hid,
 * and never in its own (review F1.4). The Trash cell of a home folder's map
 * (maybeInjectTrash) has no folder in its path, "\0trash": it is filed with the
 * rest of the top level, under the folder they are filed under — filed apart,
 * no line or band beside it found it, and each was toned against the map's
 * ground (review F1.3).
 */
function tmKidsOf(px) {
  const kids = new Map();
  const sibling = px.find((r) => r.n.depth === 1 && !r.n.isTrash);
  const top = sibling ? tmFolderPathOf(sibling) : '';
  for (const r of px) {
    const parent = r.n.isTrash ? top : tmFolderPathOf(r);
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(r);
  }
  return kids;
}
/** The folders, deepest first: the order their bands are laid, so a folder's band lies over a nested one's on an edge they share. */
function tmFramesDeepestFirst(px) {
  return px.filter((r) => r.frame).sort((a, b) => b.n.depth - a.n.depth);
}
/** Which coordinate runs along each side of a box, and which measure. */
const TM_SIDES = { top: ['x', 'w'], bottom: ['x', 'w'], left: ['y', 'h'], right: ['y', 'h'] };
const TM_OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
/** Whether the rectangle `c` lies along `side` of the folder `r`. */
function tmTouches(c, r, side) {
  if (side === 'top') return Math.abs(c.y - r.y) < 1e-6;
  if (side === 'bottom') return Math.abs(c.y + c.h - r.y - r.h) < 1e-6;
  if (side === 'left') return Math.abs(c.x - r.x) < 1e-6;
  return Math.abs(c.x + c.w - r.x - r.w) < 1e-6;
}
/** The line `side` of the box `r` runs along. */
function tmSideAt(r, side) {
  return side === 'top' ? r.y : side === 'bottom' ? r.y + r.h : side === 'left' ? r.x : r.x + r.w;
}
/**
 * What passes 2.6 and 2.7 look at around each rectangle: its folder (null at
 * the top level), and the rectangles of each folder by the device pixel each
 * of their sides lies on — so the neighbour beyond a side is found by one
 * lookup — with the map's size and its ground; and for the paint, which
 * shades of a leaf's colour stand out from both sides of a shared edge
 * (`shared`, tmShareOk), what each alike leaf with lines is filled with
 * (`fills`) and what each colour's lined leaves are brought to (`targets`, tmEdgedFill).
 */
function tmNeighbourhood(px, kids, dpr, w, h, ground) {
  const folders = new Map();
  for (const r of px) if (r.frame) folders.set(r.n.path, r);
  const folderOf = new Map(), keyOf = new Map(), sides = new Map();
  for (const [parent, list] of kids) {
    const at = { top: new Map(), bottom: new Map(), left: new Map(), right: new Map() };
    for (const c of list) {
      folderOf.set(c, folders.get(parent) || null);
      keyOf.set(c, parent);
      for (const side of Object.keys(at)) {
        const k = Math.round(tmSideAt(c, side) * dpr);
        if (!at[side].has(k)) at[side].set(k, []);
        at[side].get(k).push(c);
      }
    }
    sides.set(parent, at);
  }
  return { dpr, w, h, ground, kids, folderOf, keyOf, sides, shared: new Map(), fills: new Map(), targets: new Map() };
}
/**
 * The colours a tile shows the screen beside a line: its cushion and highlight,
 * or the ground a hollow or staged cell shows — a hollow cell's on its
 * outermost device pixel too (tmHollowEdge). Its texture keeps clear of every
 * line (tmLineMask).
 */
function tmShown(c) {
  if (c.shows) return c.showsEdge ? [...c.shows, ...c.showsEdge] : c.shows;
  return c.litSeen ? [...(c.seen || []), c.litSeen] : [...(c.seen || [])];
}
/** A tile's own colour, which a line in it or a band beside it is a shade of; a cell with none takes its folder's. */
function tmBaseOf(c, folder) {
  return c.fillRgb || c.showsRgb || (folder && (folder.bgBase || folder.ownRgb)) || null;
}
/**
 * What the folder `f` shows where nothing is drawn in it: its own fill, or the
 * ground (the top level's too, and a folder's an online-only file is hidden
 * in). A folder its contents tile shows nothing between them but a sliver of
 * a device pixel, which asks nothing of a line. A folder's own fill carries
 * its seams' shades (`grain`), which run along a leaf's edge where it has no
 * line (review F1.5).
 */
function tmFillShown(f, g) {
  if (!f) return { line: false, base: null, beside: [g.ground] };
  if (f.showsGround) return { line: false, base: f.ownRgb || null, beside: f.groundSeen || [g.ground] };
  if (f.bgSeen) return { line: false, base: f.bgBase, beside: f.bgSeen, grain: f.texSeen || [] };
  return { line: true };
}
/** Whether the rectangle `c` lies wholly under its folder `f`'s band, along one of its sides: unseen, the band seen in its place. */
function tmUnderBand(c, f) {
  if (!f || !(f.lw > 0)) return false;
  return c.y + c.h <= f.y + f.lw + 1e-6 || c.y >= f.y + f.h - f.lw - 1e-6 || c.x + c.w <= f.x + f.lw + 1e-6 || c.x >= f.x + f.w - f.lw - 1e-6;
}
/**
 * Whether two leaves with lines of their own, `a` before `b` (left of it or
 * above it), meet at one line — b's own left or top edge, in one shade of b's
 * colour that reaches TM_EDGE_MIN against both. Where none does, each draws
 * its own line there, toned against its own tile.
 */
function tmShareOk(a, b, g) {
  const key = `${a.n.path}\n${b.n.path}`;
  if (!g.shared.has(key)) g.shared.set(key, tmToneFor(b.fillRgb, [[tmShown(b), TM_EDGE_MIN], [tmShown(a), TM_EDGE_MIN]]).ok);
  return g.shared.get(key);
}
/** `segs` (stretches along a side, { lo, hi, … }) cut to [lo, hi). */
function tmClip(segs, lo, hi) {
  return segs.map((s) => ({ ...s, lo: Math.max(lo, s.lo), hi: Math.min(hi, s.hi) })).filter((s) => s.hi > s.lo + 1e-6);
}
/**
 * What the rectangle `c` shows on its own `side`, one pixel in, along the
 * stretch that faces `facing`: a line ({ line: true }) — a folder's band, a
 * leaf's own top or left line, or its right or bottom line where it draws one
 * — or a tile ({ line: false, base, beside, grain }: `grain` the shades its
 * texture lays along its edge, a smaller leaf's). A leaf with lines shares its
 * right or bottom edge with a leaf with lines beyond it (tmShareOk), whose own
 * line lies there; its top and left lines are `shared` by it with whatever
 * faces them. A folder too small for a band shows what lies inside its edge;
 * a rectangle wholly under its folder's band is the band, as a person sees it.
 */
function tmEdgeOf(c, side, facing, g) {
  const all = { lo: -Infinity, hi: Infinity };
  if (tmUnderBand(c, g.folderOf.get(c))) return [{ ...all, line: true }];
  if (c.frame) return c.lw > 0 ? [{ ...all, line: true }] : tmInside(c, side, 0, g);
  if (tmLeafKind(c) === 'edged') {
    if (side === 'top' || side === 'left') return [{ ...all, line: true, shared: c }];
    const drawn = !(facing && !facing.frame && tmLeafKind(facing) === 'edged' && tmShareOk(c, facing, g));
    return [drawn ? { ...all, line: true } : { ...all, line: false, base: c.fillRgb, beside: tmShown(c), edged: true }];
  }
  return [{ ...all, line: false, base: tmBaseOf(c, g.folderOf.get(c)), beside: tmShown(c), grain: c.texSeen || [] }];
}
/**
 * What lies just beyond `side` of the rectangle `r`, stretch by stretch along
 * it ({ lo, hi, line, covered, shared, base, beside, grain }): nothing past the map's
 * own edge; along its folder's edge, the folder's band, laid over it
 * (`covered`) — or, where the folder is too small for a band, what lies beyond
 * the folder; else each neighbour's own edge (tmEdgeOf), and the folder's own
 * fill between them (tmFillShown).
 */
function tmAcross(r, side, g) {
  const [p, s] = TM_SIDES[side];
  const lo = r[p], hi = r[p] + r[s], at = tmSideAt(r, side);
  if (at < 1e-6 || (side === 'right' && at > g.w - 0.5 / g.dpr) || (side === 'bottom' && at > g.h - 0.5 / g.dpr)) return [{ lo, hi, line: true }];
  const folder = g.folderOf.get(r) || null;
  if (folder && tmTouches(r, folder, side)) {
    if (folder.lw > 0) return [{ lo, hi, line: true, covered: true }];
    return tmClip(tmAcross(folder, side, g), lo, hi);
  }
  const opposite = TM_OPPOSITE[side];
  const index = g.sides.get(g.keyOf.get(r));
  const near = ((index && index[opposite].get(Math.round(at * g.dpr))) || [])
    .filter((c) => c !== r && c[p] < hi - 1e-6 && c[p] + c[s] > lo + 1e-6)
    .sort((a, b) => a[p] - b[p]);
  const out = [];
  let cur = lo;
  for (const c of near) {
    const a = Math.max(cur, c[p]), b = Math.min(hi, c[p] + c[s]);
    if (b <= a + 1e-6) continue;
    if (a > cur + 1e-6) out.push({ lo: cur, hi: a, ...tmFillShown(folder, g) });
    out.push(...tmClip(tmEdgeOf(c, opposite, r, g), a, b));
    cur = b;
  }
  if (cur < hi - 1e-6) out.push({ lo: cur, hi, ...tmFillShown(folder, g) });
  return out;
}
/**
 * What lies inside the folder `f`, `inset` px in from its `side` — on the row
 * (or column) of device pixels there — stretch by stretch along it: each
 * rectangle that crosses that row (a nested folder's band, or what lies inside
 * it; a leaf's own top or left line where the row is its edge; else its tile,
 * with the shades its texture lays along its edge, `grain`), and the folder's
 * own fill between them. A sliver lying wholly under the band does not cross
 * the row past it, so a band is never toned against what it covers (REPORT
 * problem 6). A leaf's line beside a folder too small for a band looks in
 * here too, and weighs the grain as beside the same file in the open: on its
 * cushion alone a line was left out where the file's texture stood 2.68:1
 * from it (review F2.2).
 */
function tmInside(f, side, inset, g) {
  const [p, s] = TM_SIDES[side];
  const lo = f[p], hi = f[p] + f[s];
  const across = side === 'left' || side === 'right' ? ['x', 'w'] : ['y', 'h'];
  const far = side === 'bottom' || side === 'right';
  const edge = tmSideAt(f, side) + (far ? -inset : inset); // where the row starts, from the side
  // The middle of the first row of device pixels wholly past `edge` (a band's inner edge lies on a whole device pixel,
  // tmLinePx; an edge inside one would show the band and the tile both).
  const mid = far ? (Math.floor(edge * g.dpr + 1e-6) - 0.5) / g.dpr : (Math.ceil(edge * g.dpr - 1e-6) + 0.5) / g.dpr;
  const near = (g.kids.get(f.n.path) || [])
    .filter((c) => c[across[0]] < mid && c[across[0]] + c[across[1]] > mid && c[p] < hi - 1e-6 && c[p] + c[s] > lo + 1e-6)
    .sort((a, b) => a[p] - b[p]);
  const out = [];
  let cur = lo;
  for (const c of near) {
    const a = Math.max(cur, c[p]), b = Math.min(hi, c[p] + c[s]);
    if (b <= a + 1e-6) continue;
    if (a > cur + 1e-6) out.push({ lo: cur, hi: a, ...tmFillShown(f, g) });
    const off = far ? tmSideAt(c, side) - edge : edge - tmSideAt(c, side); // how far in from c's own side the row starts
    const offMid = far ? tmSideAt(c, side) - mid : mid - tmSideAt(c, side); // and its device pixels' middle
    let segs;
    if (c.frame) segs = offMid < c.lw ? [{ lo: a, hi: b, line: true }] : tmInside(c, side, off, g);
    else if (offMid < tmLinePx(1, g.dpr) && (side === 'top' || side === 'left') && tmLeafKind(c) === 'edged') segs = [{ lo: a, hi: b, line: true }];
    else segs = [{ lo: a, hi: b, line: false, base: tmBaseOf(c, f), beside: tmShown(c), grain: c.texSeen || [] }];
    out.push(...tmClip(segs, a, b));
    cur = b;
  }
  if (cur < hi - 1e-6) out.push({ lo: cur, hi, ...tmFillShown(f, g) });
  return out;
}
/** The tiles along [a, b) of `segs`, as a band asks of them: to TM_FRAME_MIN. */
function tmBandAsks(segs, a, b) {
  return [[segs.filter((s) => !s.line && s.lo < b - 1e-6 && s.hi > a + 1e-6).flatMap((s) => s.beside || []), TM_FRAME_MIN]];
}
/** Whether `rgb` reaches each group's target against every colour in it. */
function tmMeets(rgb, groups) {
  return groups.every(([cols, target]) => cols.every((c) => tmContrast(rgb, c) >= target - 1e-9));
}
/** Two partitions of [from, to) laid over each other: each piece, with the stretch of each that holds it. */
function tmOverlay(one, two, from, to) {
  const cuts = [...new Set([from, to, ...one.flatMap((s) => [s.lo, s.hi]), ...two.flatMap((s) => [s.lo, s.hi])])]
    .filter((v) => v >= from - 1e-6 && v <= to + 1e-6).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i], b = cuts[i + 1];
    if (b <= a + 1e-6) continue;
    const m = (a + b) / 2;
    out.push([a, b, one.find((s) => s.lo <= m && s.hi > m) || null, two.find((s) => s.lo <= m && s.hi > m) || null]);
  }
  return out;
}
/**
 * One stretch of a line `width` css px wide, as its parts { inset, width, rgb },
 * inset from its outer edge — an inner part laid piece by piece with the
 * stretch it covers, { lo, hi }. `inside` is what lies within it, as groups
 * [[colours, target], …]; `outside` the colours of a tile beyond it, asked
 * for TM_EDGE_MIN. One part, in the shade of `base` nearest it that reaches
 * every target. Where none does:
 *   - when what lies within is out of reach even alone (no shade of the size
 *     ramp's red takes a band to 4.5:1, nor of a mid grey's whole cushion to
 *     3.3:1), its strongest shade, where that stands out from what lies
 *     beyond;
 *   - a leaf's line (`optional`) whose tiles on its two sides already differ
 *     by TM_EDGE_MIN — a light tile beside the dark theme's ground, or beside
 *     Reclaim's dark "not scored" grey — is left out: the tiles part
 *     themselves, and no shade stands out from both. The far tile's texture
 *     (`grain`: a smaller leaf's, a folder's seams) is judged with it, since
 *     with no line there it runs along the edge — judged on its cushion alone,
 *     a 3.31:1 parting showed 2.64:1 against the texture (review F1.5);
 *   - a line one painter's px wide (`unit`, tmLinePx) takes the nearest
 *     shade that reaches TM_EDGE_MIN on both sides, if one does;
 *   - else two parts: the outer `unit` toned against what lies beyond, the
 *     rest against what lies within (`deeper(k)`: the tiles k px in, where
 *     the inner part then ends, as pieces { lo, hi, groups } wherever those
 *     tiles change) — so a band keeps its 4.5:1 within, piece by piece: a row
 *     of a light tile and a dark one has no one shade that stands out from
 *     both (review F1.2).
 * An empty side asks nothing; a line with neither side stands out from its
 * own colour.
 */
function tmSeamParts(base, inside, outside, width, deeper, optional = false, grain = [], unit = 1) {
  if (!base) return [{ inset: 0, width, rgb: [0, 0, 0] }];
  const single = (rgb) => [{ inset: 0, width, rgb }];
  const asked = (groups) => groups.filter(([cols]) => cols.length);
  const within = asked(inside);
  const alone = within.length ? within : [[[base], inside.length ? inside[0][1] : TM_EDGE_MIN]];
  if (!outside.length) return single(tmToneFor(base, alone).rgb);
  const all = [...within, [outside, TM_EDGE_MIN]];
  const one = tmToneFor(base, all);
  if (one.ok) return single(one.rgb);
  const best = tmToneFor(base, alone);
  if (!best.ok && tmMeets(best.rgb, [[outside, TM_EDGE_MIN]])) return single(best.rgb);
  const far = [...outside, ...grain];
  if (optional && within.every(([cols]) => cols.every((c) => far.every((o) => tmContrast(c, o) >= TM_EDGE_MIN)))) return [];
  if (width <= unit + 1e-9) {
    const eased = tmToneFor(base, all.map(([cols]) => [cols, TM_EDGE_MIN]));
    if (eased.ok) return single(eased.rgb);
  }
  const inner = Math.max(unit, width - unit);
  const outer = { inset: 0, width: unit, rgb: tmToneFor(base, [[outside, TM_EDGE_MIN]]).rgb };
  const toned = (groups) => {
    const deep = asked(groups);
    return tmToneFor(base, deep.length ? deep : alone).rgb;
  };
  if (!deeper) return [outer, { inset: unit, width: inner, rgb: toned(within) }];
  return [outer, ...deeper(unit + inner).map(({ lo, hi, groups }) => ({ inset: unit, width: inner, lo, hi, rgb: toned(groups) }))];
}
/** A part of a line along `side` of the box `r`, from a to b, as the rectangle { x, y, w, h, rgb } it fills. */
function tmPartRect(r, side, a, b, part) {
  const rgb = `rgb(${part.rgb[0]},${part.rgb[1]},${part.rgb[2]})`;
  if (side === 'top') return { x: a, y: r.y + part.inset, w: b - a, h: part.width, rgb };
  if (side === 'bottom') return { x: a, y: r.y + r.h - part.inset - part.width, w: b - a, h: part.width, rgb };
  if (side === 'left') return { x: r.x + part.inset, y: a, w: part.width, h: b - a, rgb };
  return { x: r.x + r.w - part.inset - part.width, y: a, w: part.width, h: b - a, rgb };
}
/** `rects` with each run of touching rectangles of one paint along one line merged into one. */
function tmMergeRuns(rects) {
  const out = [];
  for (const q of rects) {
    const last = out[out.length - 1];
    if (last && last.rgb === q.rgb && last.w === q.w && last.x === q.x && Math.abs(last.y + last.h - q.y) < 1e-6) { last.h += q.h; continue; }
    if (last && last.rgb === q.rgb && last.h === q.h && last.y === q.y && Math.abs(last.x + last.w - q.x) < 1e-6) { last.w += q.w; continue; }
    out.push({ ...q });
  }
  return out;
}
/**
 * The 1 px lines the leaf `r` (one with lines, tmLeafKind 'edged') draws inside
 * its own box, as { x, y, w, h, rgb }: its top and left edges, and its right
 * and bottom edges where what lies beyond is not a leaf with lines whose own
 * left or top edge it shares (tmShareOk) — nothing along its folder's own
 * edge, which the folder's band covers. Each stretch is toned against r's own
 * tile and the tile beyond it, and left out where those two already part
 * themselves and no shade stands out from both (tmSeamParts). At each corner
 * the line that runs on past it keeps the corner (tmBarCorners): laid over it,
 * a side line's outer pixel, toned against the tile beyond it alone, broke the
 * line between r and a tile above it where r's corner meets that tile's edge
 * (review F1.5), and a light line across, the side line beside a file that
 * runs on past r's corner (review F3.5).
 */
function tmLeafLines(r, g) {
  const own = tmShown(r), out = [], t = tmLinePx(1, g.dpr);
  // Each side's outer part, and how far in from its edge its line reaches, for tmBarCorners.
  const outer = { top: [], left: [], right: [], bottom: [] }, reach = { top: 0, left: 0, right: 0, bottom: 0 };
  for (const side of ['top', 'left', 'right', 'bottom']) {
    const [p, s] = TM_SIDES[side];
    // Each runs its side's whole length: where the top line is left out, the side line still closes the corner.
    const from = r[p], to = r[p] + r[s];
    for (const seg of tmAcross(r, side, g)) {
      if (seg.covered) continue;
      if ((side === 'right' || side === 'bottom') && seg.shared && tmShareOk(r, seg.shared, g)) continue;
      const a = Math.max(from, seg.lo), b = Math.min(to, seg.hi);
      if (b <= a + 1e-6) continue;
      const beyond = seg.line ? [] : seg.beside, grain = seg.line ? [] : seg.grain || [];
      const parts = tmSeamParts(r.fillRgb, [[own, TM_EDGE_MIN]], beyond, t, null, true, grain, t);
      for (const part of parts) {
        const rect = tmPartRect(r, side, a, b, part);
        out.push(rect);
        if (part.inset === 0) outer[side].push(rect);
        reach[side] = Math.max(reach[side], part.inset + part.width);
      }
    }
  }
  return [...tmMergeRuns(out), ...tmBarCorners(r, outer, reach, g)];
}
/**
 * Where two of the leaf `r`'s lines meet at a corner, the one that runs on past
 * it — the edge between the tiles beyond, a T's bar: across r's side, a tile
 * that runs past r's top or bottom edge; across its top or bottom, one that
 * runs past its side — laid again over the corner on the device pixels it
 * covers whole, so it keeps them, as rectangles to lay after r's lines. A
 * line across laid after the side line — r's lines are laid top, left, right,
 * bottom — took the corner's device pixels: a light bottom line over a dark
 * side line left the side line short of r's corner, no longer parting r from
 * the file beside it, which runs on past it (review F3.5; when lines were 1
 * css px at 125, 150 and 175 % the line across also blended with the side line
 * on the row it covered in part). Each stretch of the bar is laid again in its own colour, on its own
 * device pixels: where the tile that runs on past the corner starts a device
 * pixel or two before it, the stretch facing that tile is shorter than the
 * line across reaches, and laid over every pixel the line across reaches it
 * covered the next stretch too — dark beside a dark tile, 1.67:1 at 125 %
 * where that stretch's own light shade stands 7.75:1 (review F1.3 of
 * BQJ-2c-r). `outer` holds each side's outer part as laid, `reach` how far in
 * from its edge each side's line reaches.
 */
function tmBarCorners(r, outer, reach, g) {
  const index = g.sides.get(g.keyOf.get(r));
  if (!index) return [];
  const dpr = g.dpr, eps = 1e-6, out = [];
  // Whether a tile across `side` of r runs past the line `at` that crosses it: along x (`along`) or y.
  const runsPast = (side, at, along) => (index[TM_OPPOSITE[side]].get(Math.round(tmSideAt(r, side) * dpr)) || [])
    .some((c) => c !== r && (along ? c.x < at - eps && c.x + c.w > at + eps : c.y < at - eps && c.y + c.h > at + eps));
  for (const side of ['left', 'right']) {
    for (const across of ['top', 'bottom']) {
      const sideBar = runsPast(side, tmSideAt(r, across), false), acrossBar = runsPast(across, tmSideAt(r, side), true);
      if (sideBar === acrossBar) continue;
      const [bar, stem] = sideBar ? [side, across] : [across, side];
      if (!reach[stem]) continue;
      // The bar's outer part at this corner.
      const end = tmSideAt(r, sideBar ? across : side), vertical = bar === 'left' || bar === 'right';
      const l = outer[bar].find((q) => vertical
        ? (across === 'top' ? Math.abs(q.y - end) < eps : Math.abs(q.y + q.h - end) < eps)
        : (side === 'left' ? Math.abs(q.x - end) < eps : Math.abs(q.x + q.w - end) < eps));
      if (!l) continue;
      // Every device pixel the stem's line reaches along the bar, [b0, b1).
      const edge = tmSideAt(r, stem), inward = stem === 'top' || stem === 'left' ? 1 : -1;
      const s0 = Math.round(edge * dpr), s1 = inward > 0 ? Math.ceil((edge + reach[stem]) * dpr - eps) : Math.floor((edge - reach[stem]) * dpr + eps);
      const [b0, b1] = inward > 0 ? [s0, s1] : [s1, s0];
      // Each stretch of the bar there, on its whole device pixels across it and along it within [b0, b1).
      for (const q of outer[bar]) {
        const [a0, a1] = vertical ? [q.x, q.x + q.w] : [q.y, q.y + q.h];
        const [c0, c1] = vertical ? [q.y, q.y + q.h] : [q.x, q.x + q.w];
        const lo = Math.ceil(a0 * dpr - eps), hi = Math.floor(a1 * dpr + eps);
        const from = Math.max(b0, Math.round(c0 * dpr)), to = Math.min(b1, Math.round(c1 * dpr));
        if (hi <= lo || to <= from) continue;
        out.push(vertical
          ? { x: lo / dpr, y: from / dpr, w: (hi - lo) / dpr, h: (to - from) / dpr, rgb: q.rgb }
          : { x: from / dpr, y: lo / dpr, w: (to - from) / dpr, h: (hi - lo) / dpr, rgb: q.rgb });
      }
    }
  }
  return out;
}
/**
 * The folder `r`'s frame as the filled bands that draw it, { x, y, w, h, rgb }:
 * r.lw px (tmBandWidth) inside its own box, the top and bottom bands across its
 * whole width and the sides between them; each stretch a shade of the colour
 * inside it, toned against what lies just past the band inside (tmInside, to
 * TM_FRAME_MIN) and against a tile just beyond it (tmAcross, to TM_EDGE_MIN).
 */
function tmFrameBands(r, g) {
  const lw = r.lw;
  if (!lw) return [];
  const out = [];
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const vertical = side === 'left' || side === 'right';
    const from = vertical ? r.y + lw : r.x, to = vertical ? r.y + r.h - lw : r.x + r.w;
    if (to <= from + 1e-6) continue;
    const inside = tmInside(r, side, lw, g), outside = tmAcross(r, side, g);
    for (const [a, b, inn, beyond] of tmOverlay(inside, outside, from, to)) {
      const base = (inn && inn.base) || r.bgBase || r.ownRgb;
      const within = [[inn && !inn.line ? inn.beside : [], TM_FRAME_MIN]];
      // What lies k px in along [a, b), piece by piece where its tiles change: a two-part band's inner part is toned
      // against the tiles beside each piece alone (review F1.2).
      const deeper = (k) => tmOverlay(tmInside(r, side, k, g), [], a, b).map(([lo, hi, seg]) => ({ lo, hi, groups: tmBandAsks(seg ? [seg] : [], lo, hi) }));
      const parts = tmSeamParts(base, within, beyond && !beyond.line ? beyond.beside : [], lw, deeper, false, [], tmLinePx(1, g.dpr));
      for (const part of parts) out.push(tmPartRect(r, side, part.lo === undefined ? a : part.lo, part.hi === undefined ? b : part.hi, part));
    }
  }
  return tmMergeRuns(out);
}
/**
 * The device pixels a line or a band lies on, and every pixel beside one, as a
 * mask `w`×`h` device px: a texture keeps clear of them, so no line ever meets
 * a texture's darker or lighter shade, only the fill it lies on.
 */
function tmLineMask(px, w, h, dpr) {
  const mask = new Uint8Array(w * h);
  const mark = (x0, y0, x1, y1) => {
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) mask.fill(1, y * w + Math.max(0, x0), y * w + Math.min(w, x1));
  };
  for (const r of px) {
    for (const l of [...(r.lines || []), ...(r.bands || [])]) {
      const x0 = Math.floor(l.x * dpr + 1e-6), y0 = Math.floor(l.y * dpr + 1e-6);
      const x1 = Math.ceil((l.x + l.w) * dpr - 1e-6), y1 = Math.ceil((l.y + l.h) * dpr - 1e-6);
      mark(x0 - 1, y0, x1 + 1, y1);
      mark(x0, y0 - 1, x1, y1 + 1);
    }
  }
  return mask;
}
/** The seam `rect` ([x, y, w, h], one painter's px thick) as the runs of it clear of `mask` (tmLineMask), each [x, y, w, h]. */
function tmClearRuns(rect, mask, w, h, dpr) {
  const [x, y, rw, rh] = rect;
  const across = rw >= rh;
  const x0 = Math.floor(x * dpr + 1e-6), y0 = Math.floor(y * dpr + 1e-6);
  const x1 = Math.ceil((x + rw) * dpr - 1e-6), y1 = Math.ceil((y + rh) * dpr - 1e-6);
  const clear = across
    ? (k) => { for (let yy = Math.max(0, y0); yy < Math.min(h, y1); yy++) if (mask[yy * w + k]) return false; return true; }
    : (k) => { for (let xx = Math.max(0, x0); xx < Math.min(w, x1); xx++) if (mask[k * w + xx]) return false; return true; };
  const [lo, hi] = across ? [Math.max(0, x0), Math.min(w, x1)] : [Math.max(0, y0), Math.min(h, y1)];
  const out = [];
  let start = -1;
  for (let k = lo; k <= hi; k++) {
    const ok = k < hi && clear(k);
    if (ok && start < 0) start = k;
    if (!ok && start >= 0) {
      const a = Math.max(across ? x : y, start / dpr), b = Math.min(across ? x + rw : y + rh, k / dpr);
      if (b > a + 1e-6) out.push(across ? [a, y, b - a, rh] : [x, a, rw, b - a]);
      start = -1;
    }
  }
  return out;
}
/** The stretches of [lo, hi) that no interval [a, b) of `cover` takes. */
function tmUncovered(lo, hi, cover) {
  const out = [];
  let at = lo;
  for (const [a, b] of [...cover].sort((p, q) => p[0] - q[0])) {
    if (a > at + 1e-6) out.push([at, Math.min(a, hi)]);
    at = Math.max(at, b);
    if (at >= hi - 1e-6) break;
  }
  if (at < hi - 1e-6) out.push([at, hi]);
  return out.filter(([a, b]) => b > a + 1e-6);
}
/**
 * A folder's texture over its own fill (J51): a seam one painter's px wide
 * (tmSeamPx) every TM_TEXTURE_PITCH painter's px (tmPxScale) down and across
 * its box, from its top-left corner, in
 * the shade of its cushion tmTextureContrast puts at that pitch — the files in
 * it too small to draw. Only where its own fill shows: never under what is
 * drawn in it, and clear of every line (`mask`, tmLineMask). The last seam is
 * cut at the folder's edge: a folder whose side is not a whole multiple of
 * TM_TEXTURE_PITCH px laid it up to 1 px over the tile beside it (review F1.4).
 */
function tmFolderTexture(r, kids, mask, mw, mh, dpr) {
  const inside = kids.get(r.n.path) || [];
  const rects = [], pitch = TM_TEXTURE_PITCH * tmPxScale(dpr), unit = tmSeamPx(1, dpr);
  // Seam by seam across the folder, what crosses each: the rectangles in it, swept in order of where they start,
  // so a folder of thousands is not searched whole for every seam.
  const seams = (p, s, q, t, seam) => {
    const byStart = [...inside].sort((a, b) => a[p] - b[p]);
    let next = 0, open = [];
    for (let v = r[p]; v < r[p] + r[s] - 1e-6; v += pitch) {
      const thick = Math.min(unit, r[p] + r[s] - v);
      while (next < byStart.length && byStart[next][p] < v + thick - 1e-6) open.push(byStart[next++]);
      open = open.filter((c) => c[p] + c[s] > v + 1e-6);
      const cover = open.map((c) => [c[q], c[q] + c[t]]);
      for (const [a, b] of tmUncovered(r[q], r[q] + r[t], cover)) rects.push(...tmClearRuns(seam(v, a, b, thick), mask, mw, mh, dpr));
    }
  };
  seams('x', 'w', 'y', 'h', (x, a, b, thick) => [x, a, thick, b - a]);
  seams('y', 'h', 'x', 'w', (y, a, b, thick) => [a, y, b - a, thick]);
  return { stops: r.texStops, rects };
}
/**
 * A small leaf's texture (tmLeafKind 'textured'): its top row and its left
 * column below that, one painter's px wide (tmSeamPx), clear of every line
 * (`mask`) — and where a line beside the leaf takes a stretch of either, that
 * stretch laid one device pixel further in, where it is clear. Left out, a
 * leaf with a line along its top lost its top row of texture, a third of it:
 * a row of 7 px leaves under a row of 8 px ones stood 1.5 L* lighter than the
 * rows of 7 px leaves beyond it (residual 3).
 */
function tmLeafTexture(r, mask, mw, mh, dpr) {
  const t = tmSeamPx(1, dpr), d = 1 / dpr;
  // Seam `q`'s clear runs, and in each stretch the mask takes, the seam moved `step` ([dx, dy]) in — inside the leaf.
  const seam = (q, step, along) => {
    const runs = tmClearRuns(q, mask, mw, mh, dpr);
    const [p, s] = along === 'x' ? [0, 2] : [1, 3];
    const moved = [q[0] + step[0], q[1] + step[1], q[2], q[3]];
    if (moved[0] + moved[2] > r.x + r.w + 1e-6 || moved[1] + moved[3] > r.y + r.h + 1e-6) return runs;
    const taken = tmUncovered(q[p], q[p] + q[s], runs.map((run) => [run[p], run[p] + run[s]]));
    const again = taken.flatMap(([a, b]) => {
      const part = [...moved];
      part[p] = a; part[s] = b - a;
      return tmClearRuns(part, mask, mw, mh, dpr);
    });
    return [...runs, ...again];
  };
  return {
    stops: r.texStops,
    rects: [...seam([r.x, r.y, r.w, t], [0, d], 'x'), ...seam([r.x, r.y + t, t, r.h - t], [d, 0], 'y')],
  };
}

/** The indigo of a container's dashes (pass 7): a container TreeMap can look inside. */
const TM_OPEN_DASH = 'rgba(94,92,230,0.9)';
/** A container's dashes, in painter's px: so long, then a gap so long, from each corner of its ring. */
const TM_OPEN_DASH_ON = 5;
const TM_OPEN_DASH_OFF = 3;
/**
 * Where pass 7 lays the indigo dashes of a container TreeMap can look inside
 * (`r`), as rectangles [x, y, w, h] on whole device pixels: a ring one line's
 * width wide (tmLinePx), TM_OPEN_DASH_ON painter's px on and TM_OPEN_DASH_OFF
 * off along each side from its corners, inside how far its own lines or band
 * and the bands of its folders along its edge reach in (`g`, the
 * neighbourhood), a device pixel clear of them — and clear of every line and
 * band in it (`mask`, tmLineMask: the lines of what a Photos library holds).
 * Stroked 1.5 css px wide 1.5 px in, a dash covered part of the device pixel
 * beside a file's own line and blended with it, 2.67:1 from the tile beyond,
 * and ran over the bands of Pictures and Code (residual 6). None where the
 * ring does not fit.
 */
function tmOpenDashes(r, g, mask, mw, mh, dpr) {
  const t = tmLinePx(1, dpr), gap = 1 / dpr, u = tmPxScale(dpr);
  // How far in from each side a line or band reaches: its own, and its folders' laid over its edge.
  const reach = { top: 0, bottom: 0, left: 0, right: 0 };
  for (let f = g.folderOf.get(r); f; f = g.folderOf.get(f)) {
    for (const side of Object.keys(reach)) if (f.lw > 0 && tmTouches(r, f, side)) reach[side] = Math.max(reach[side], f.lw);
  }
  if (r.frame && r.lw > 0) for (const side of Object.keys(reach)) reach[side] = Math.max(reach[side], r.lw);
  for (const l of r.lines || []) {
    reach.top = Math.max(reach.top, l.w >= l.h && l.y - r.y < r.h / 2 ? l.y + l.h - r.y : 0);
    reach.bottom = Math.max(reach.bottom, l.w >= l.h && l.y - r.y >= r.h / 2 ? r.y + r.h - l.y : 0);
    reach.left = Math.max(reach.left, l.h > l.w && l.x - r.x < r.w / 2 ? l.x + l.w - r.x : 0);
    reach.right = Math.max(reach.right, l.h > l.w && l.x - r.x >= r.w / 2 ? r.x + r.w - l.x : 0);
  }
  const x0 = tmSnap(r.x + reach.left + gap, dpr), x1 = tmSnap(r.x + r.w - reach.right - gap, dpr);
  const y0 = tmSnap(r.y + reach.top + gap, dpr), y1 = tmSnap(r.y + r.h - reach.bottom - gap, dpr);
  if (x1 - x0 < 2 * t + u || y1 - y0 < 2 * t + u) return [];
  // Each side's dashes from its start, as runs [a, b) along it.
  const runs = (a, b) => {
    const out = [];
    for (let v = a; v < b - 1e-6; v += (TM_OPEN_DASH_ON + TM_OPEN_DASH_OFF) * u) out.push([tmSnap(v, dpr), tmSnap(Math.min(b, v + TM_OPEN_DASH_ON * u), dpr)]);
    return out.filter(([p, q]) => q > p + 1e-6);
  };
  const rects = [
    ...runs(x0, x1).flatMap(([a, b]) => [[a, y0, b - a, t], [a, y1 - t, b - a, t]]),
    ...runs(y0 + t, y1 - t).flatMap(([a, b]) => [[x0, a, t, b - a], [x1 - t, a, t, b - a]]),
  ];
  return rects.flatMap((q) => tmClearRuns(q, mask, mw, mh, dpr));
}

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
/**
 * The colours of the washes laid over the tile `r`, in order: those whose
 * folder's box holds it. Pass 2.5 lays each wash over its folder's whole box,
 * edge to edge on the device's pixels as the folder lies, so every tile in it
 * is washed to its edge — the lines beside it are toned against it washed. It
 * laid each half a css px in, which left a tile's outer device pixel at 2×
 * unwashed, and a folder half a px tall washed off its own box: a line toned
 * against the washed tile stood 2.91:1 from it there (review F2.3).
 */
function tmWashesOver(r, washes) {
  return washes
    .filter(({ r: f }) => r.x >= f.x - 1e-6 && r.y >= f.y - 1e-6 && r.x + r.w <= f.x + f.w + 1e-6 && r.y + r.h <= f.y + f.h + 1e-6)
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
/** Relative luminances already worked out, by whole-number colour: passes 2.6 and 2.7 try many shades against many tiles. */
const tmLumCache = new Map();
function tmLuminance(c) {
  const key = Number.isInteger(c[0]) && Number.isInteger(c[1]) && Number.isInteger(c[2]) ? (c[0] << 16) | (c[1] << 8) | c[2] : -1;
  if (key >= 0 && tmLumCache.has(key)) return tmLumCache.get(key);
  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  if (key >= 0 && tmLumCache.size < 1 << 17) tmLumCache.set(key, lum);
  return lum;
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

/**
 * Pass 3's name tags for the top-level folders, measured before pass 1 so
 * labels can be placed around them: each { r, x, y, w, h } and the name's own
 * measured width (`nameW`), which pass 3 writes squeezed to r.w − 26 where it
 * is wider. drawTreemap records them (state.treemap.tags) for the SVG export
 * and the lens, which lay the very tags the map laid.
 */
function tmFolderTags(ctx, px) {
  ctx.font = '600 10.5px -apple-system, sans-serif';
  const tags = [];
  for (const r of px) {
    if (!r.frame || r.n.depth !== 1 || r.w < 90 || r.h < 44) continue;
    const nameW = ctx.measureText(r.n.name).width, tw = Math.min(nameW, r.w - 26);
    tags.push({ r, x: r.x + 5, y: r.y + 5, w: tw + 14, h: 18, nameW });
  }
  return tags;
}
/** Pass 3's name tag `t` (tmFolderTags) on `ctx`: its half black, and the folder's name in it. Laid by the map and by the lens. */
function tmLayTag(ctx, t) {
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  roundRect(ctx, t.x, t.y, t.w, t.h, TM_TAG_RADIUS);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(t.r.n.name, t.r.x + 12, t.r.y + 14.5, t.r.w - 26);
}

/** A name tag's corner radius (pass 3), which the clip under it follows (tmClipOutTags). */
const TM_TAG_RADIUS = 9;

/**
 * Clips what is drawn next to the whole map but the top-level folders' name
 * tags, each the rounded pill pass 3 lays (review F3.1). A leaf's outline or a
 * folder's band stops at a tag's edge, as a frame's border stops at its
 * legend: under the tag's half black the line and the tile beside it were
 * both darkened by half, about 2:1 between them, under the owner's 3:1 bar —
 * and on the size ramp's red, its blue or a mid grey no colour at all reaches
 * 3:1 there. The name reads on the tiles alone.
 *
 * `w`×`h` is the canvas's own size in css px — its device pixels over the
 * ratio — and the clip runs a css px past it on every side, so no edge of the
 * clip but a tag's falls on a pixel the map paints (review F1.1, F1.2). At
 * 125, 150 or 175 % the canvas can be wider or taller than the map's css size
 * by part of a device pixel, and the map's far edges are laid on its last
 * device pixel (tmSnap): a clip of the css size alone let that last column
 * and row of every line there through only in part.
 */
function tmClipOutTags(ctx, tags, w, h) {
  ctx.beginPath();
  ctx.rect(-1, -1, w + 2, h + 2);
  for (const t of tags) {
    // Canvas2D.roundRect's own path, as a subpath of this one.
    const rr = Math.max(0, Math.min(TM_TAG_RADIUS, t.w / 2, t.h / 2));
    ctx.moveTo(t.x + rr, t.y);
    ctx.arcTo(t.x + t.w, t.y, t.x + t.w, t.y + t.h, rr);
    ctx.arcTo(t.x + t.w, t.y + t.h, t.x, t.y + t.h, rr);
    ctx.arcTo(t.x, t.y + t.h, t.x, t.y, rr);
    ctx.arcTo(t.x, t.y, t.x + t.w, t.y, rr);
    ctx.closePath();
  }
  ctx.clip('evenodd');
}
/**
 * Whether the rectangle `q` ([x, y, w, h]) lies wholly under one of the name
 * tags `tags` — the rounded pill pass 3 lays, which tmClipOutTags cuts out of
 * what is drawn under it — and so does not show. A pill is convex: a
 * rectangle lies in it when its four corners do.
 */
function tmUnderTag([x, y, w, h], tags) {
  return tags.some((t) => {
    const rr = Math.max(0, Math.min(TM_TAG_RADIUS, t.w / 2, t.h / 2));
    const inPill = (px, py) => {
      const dx = Math.max(t.x + rr - px, 0, px - (t.x + t.w - rr)), dy = Math.max(t.y + rr - py, 0, py - (t.y + t.h - rr));
      return dx * dx + dy * dy <= rr * rr + 1e-9;
    };
    return inPill(x, y) && inPill(x + w, y) && inPill(x, y + h) && inPill(x + w, y + h);
  });
}

/** Where a leaf's label lines lie, as tmLeafStops eases its cushion for them: each line's top below the leaf's, and its font size. */
function tmLabelAt(r) {
  return r.label.map((l) => ({ off: l.y - r.y, px: l.px }));
}
/**
 * What pass 1 paints the leaf `r` with in `fill`, a shade of its colour (its
 * own, or tmEdgedFill's), recorded on it: its cushion, eased for its label
 * (tmLeafStops), as the screen shows it through the History diff's `washes`
 * (r.seen); and whether a highlight runs under a dark line of its own. Laid
 * by tmLayLeaf.
 */
function tmPaintLeaf(r, fill, washes) {
  r.stops = tmLeafStops(fill, r.h, tmLabelAt(r), washes);
  r.fillRgb = fill; // the shade of its colour it is filled with, which its lines are toned from; r.stops is the cushion painted
  r.seen = tmSeenThrough(r.stops, washes); // and as pass 4 writes the label on it, through pass 2.5 (G09, F2.1)
  delete r.lit;
  delete r.litSeen;
  if (!tmLeafEdged(r)) return;
  // Lines of its own (pass 2.6, tmLeafLines). Where the shade of its own
  // colour that stands out from it is a dark one (tmTone), a highlight runs
  // along its top row under its top line, part of its cushion.
  r.lit = !tmTone(fill, r.seen, TM_EDGE_MIN).light;
  if (r.lit) r.litSeen = tmSeenThrough([mix(r.stops[0], [255, 255, 255], tmLitAlpha(r))], washes)[0];
}
/** Pass 1's leaf `r` as recorded (tmPaintLeaf): its cushion edge to edge over its box, and its top highlight. */
function tmLayLeaf(ctx, r) {
  ctx.fillStyle = tmLeafFill(ctx, r.stops, r.y, r.h);
  ctx.fillRect(r.x, r.y, r.w, r.h); // edge to edge: a leaf's outline lies inside its own box
  if (!r.lit) return;
  const lit = tmLitLine(r);
  ctx.strokeStyle = `rgba(255,255,255,${tmLitAlpha(r)})`;
  ctx.lineWidth = lit.width;
  ctx.beginPath();
  ctx.moveTo(lit.x0, lit.y); ctx.lineTo(lit.x1, lit.y);
  ctx.stroke();
}

function drawTreemap() {
  // QA D58 — the server stops a map at 20,000 nodes and its response cannot
  // say so (§12 golden lock), so the note under the map does. Written before
  // the map is measured: it is a row under the footer, which the map's height
  // counts, and it depends on the nodes alone (review F1.1 of F06).
  state.treemap.altNote = tmNodeCapNote();
  renderAltNote();
  const wrap = $('treemapWrap');
  // While the map previews beside the open cart its card is padded on the
  // right by the clearance tmCartClearSync measured, 0 otherwise (seventh
  // browser pass J52): the canvas fills the card's content box.
  const cssW = wrap.clientWidth - 20 - (wrap._tmCartClear || 0);
  const cssH = treemapCanvasHeight(wrap);
  const dpr = window.devicePixelRatio || 1;
  tmCanvas.style.width = cssW + 'px';
  tmCanvas.style.height = cssH + 'px';
  // The canvas ends where tmSnap lays the map's far edges, its tie-break and
  // all: a bare round ended it a device pixel short of the map where a css
  // size times the ratio lands a hair under a half (165 × 0.7 is
  // 115.49999999999999), and the map's right or bottom edge line went
  // unpainted (review F2.1 of BQJ-2c-r).
  const pw = Math.round(cssW * dpr + 1e-6), ph = Math.round(cssH * dpr + 1e-6);
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
  const cloudHiddenIn = new Set(); // folders an online-only file is hidden in (pass 0)
  for (const n of state.treemap.nodes) {
    if (state.treemap.hideCloud && n.cloudPlaceholder) { cloudHiddenIn.add(tmParentPath(n.path)); continue; }
    // On whole device pixels, edge by edge, so neighbours still meet exactly
    // and a 1 px line is one crisp line (the owner's outline decision).
    const x = tmSnap((n.x / 100) * cssW, dpr), y = tmSnap((n.y / 100) * cssH, dpr);
    const w = tmSnap(((n.x + n.w) / 100) * cssW, dpr) - x, h = tmSnap(((n.y + n.h) / 100) * cssH, dpr) - y;
    if (w * h < 1) continue;
    px.push({ n, x, y, w, h, frame: n.expanded, dpr });
  }
  state.treemap.pxRects = px;
  // And the name tags it lays (below), none until then: a map with nothing
  // to draw returns before it lays any, and the lens laid the last map's
  // over "This folder is empty." (review F1.2, F1.4, F1.12).
  state.treemap.tags = [];
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
  state.treemap.tags = tagRects; // the tags pass 3 lays, for the SVG export and the lens
  for (const r of px) r.label = tmLabelLines(r, tagRects);
  // The History diff's washes, which pass 2.5 lays over the leaves pass 1
  // paints: a label is read through them (review F2.1).
  const washes = tmDiffWashes(px);
  const kids = tmKidsOf(px);
  const pulls = new Map(); // each colour's pull on the leaves with a texture (tmTexturedFill)
  // tmToneFor's answers depend on the colours alone, and are kept from one
  // paint to the next while there are few enough of them: a window drag
  // repaints the same colours at every step, and asked again they took a
  // fifth of each paint — a drag's repaints ran 1.4 to 1.7 times as long as
  // before the fills were moved (review F1.13).
  if (TM_TONE_MEMO.size > TM_TONE_MEMO_KEEP) TM_TONE_MEMO.clear();

  // Pass 0: a folder's own fill, where no rectangle covers it (J51) — its
  // files under the map's size floor, or past the server's cap. Laid in the
  // server's breadth-first order, so a folder's fill lies under its contents.
  // Not in a folder an online-only file is hidden in: its bytes are not on
  // this disk, and the folder's colour there would claim the space. Its box
  // is cleared to the map's ground instead (r.showsGround), as pass 1 clears a
  // staged or hollow cell: a folder above it with a fill of its own laid that
  // fill over its whole box, which showed where the hidden file would be
  // (review F2.1). What is drawn in it is laid after, over the ground.
  const ground = tmGroundRgb();
  for (const r of px) {
    if (!r.frame) continue;
    // Its band's width, by its size and depth (tmBandWidth): passes 2.6 and
    // 2.7 read every folder's before any line is laid.
    r.lw = tmBandWidth(r);
    // The folder's colour, and the ground as it shows in it (through any
    // History diff wash): its band is toned from the one against the other
    // where the ground shows (review F1.5).
    r.ownRgb = cellRgb(r.n);
    r.groundSeen = tmSeenThrough([ground], tmWashesOver(r, washes));
    if (cloudHiddenIn.has(r.n.path)) {
      r.showsGround = true;
      ctx.clearRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = cssVar('--tm-canvas-bg');
      ctx.fillRect(r.x, r.y, r.w, r.h); // the ground, as the map's first fill laid it
      continue;
    }
    let covered = 0;
    for (const c of kids.get(r.n.path) || []) covered += c.w * c.h;
    // Its contents tile it: none of it shows. On whole device pixels their
    // areas sum to its own exactly when they do; a sliver left over — a
    // device pixel or two at 150 or 200 % — shows the folder's fill, not the
    // map's ground.
    if (covered >= r.w * r.h - 1e-6) continue;
    r.bgBase = r.ownRgb;
    r.bg = tmLeafStops(r.bgBase, r.h, null);
    r.bgSeen = tmSeenThrough(r.bg, tmWashesOver(r, washes));
    // Its texture's shades (pass 2.4), which a line beside its fill weighs (review F1.5).
    r.texStops = tmTextureStops(r.bg, r.bgBase, tmTextureContrast(TM_TEXTURE_PITCH));
    r.texSeen = tmSeenThrough(r.texStops, tmWashesOver(r, washes));
    ctx.fillStyle = tmLeafFill(ctx, r.bg, r.y, r.h);
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }

  // Pass 1: cushion-shaded leaf fills.
  for (const r of px) {
    if (r.frame) continue;

    /* v4 §4.3 — a freed region. Hatched rather than filled, because the space
       is not there yet: a solid block would read as "this is what you have",
       which is exactly the false statement the preview exists to avoid. Same
       reasoning as A3's hollow cloud placeholders, and the same visual family.
       The cell is cleared to the map's ground first: a folder's fill (pass 0)
       must not show through what is not there. */
    if (r.n.freed) {
      marks.staged = true;
      ctx.clearRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = cssVar('--tm-canvas-bg');
      ctx.fillRect(r.x, r.y, r.w, r.h); // the ground, as the map's first fill laid it
      // The ground again and the hatch from half a css px in, the outline 1 px
      // wide centred 1 px in — and under a ratio of 1 from a whole device pixel
      // in, the outline one device pixel wide inside that, so the block's
      // outermost device pixel shows the ground alone: there no shade of a
      // file's line stood 3:1 from the ground, the hatch and the amber outline
      // that pixel blended (2.31:1 at 67 % in the dark theme, review F2.2 of
      // BQJ-2c-r).
      const inset = dpr < 1 ? tmLinePx(1, dpr) : 0.5, ring = dpr < 1 ? 1.5 * inset : 1;
      ctx.fillRect(r.x + inset, r.y + inset, Math.max(1, r.w - 2 * inset), Math.max(1, r.h - 2 * inset));
      const hatch = tmHatchPattern(ctx);
      if (hatch) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = hatch;
        ctx.fillRect(r.x + inset, r.y + inset, Math.max(1, r.w - 2 * inset), Math.max(1, r.h - 2 * inset));
        ctx.restore();
      }
      if (r.w > 6 && r.h > 6) {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = dpr < 1 ? inset : 1;
        ctx.strokeStyle = cssVar('--warn') || '#FF9F0A';
        ctx.strokeRect(r.x + ring, r.y + ring, Math.max(1, r.w - 2 * ring), Math.max(1, r.h - 2 * ring));
        ctx.restore();
      }
      // What it shows inside its edge, for a folder's band beside it (F1.5):
      // the ground laid over once more, and the hatch's amber at half over that.
      const inside = tmOver(tmCssRgba(cssVar('--tm-canvas-bg')), ground);
      const amber = tmCssRgba(cssVar('--warn') || '#FF9F0A');
      r.shows = tmSeenThrough(hatch && amber ? [inside, mix(inside, amber, 0.5)] : [inside], tmWashesOver(r, washes));
      // And on its outermost device pixel, for a line beside it (tmStagedEdge, review F1.4 of BQJ-2c-r).
      r.showsEdge = tmSeenThrough(tmStagedEdge(ground, inside, amber, !!hatch, r.w > 6 && r.h > 6, dpr), tmWashesOver(r, washes));
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
      ctx.clearRect(r.x, r.y, r.w, r.h); // the map's ground, not a folder's fill (pass 0), shows through it
      ctx.fillStyle = cssVar('--tm-canvas-bg');
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = `rgba(${base[0]},${base[1]},${base[2]},${TM_HOLLOW_WASH})`;
      ctx.fillRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.w - 1), Math.max(1, r.h - 1));
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(${base[0]},${base[1]},${base[2]},${TM_HOLLOW_DASH})`;
      ctx.strokeRect(r.x + 1, r.y + 1, Math.max(1, r.w - 2), Math.max(1, r.h - 2));
      ctx.restore();
      // What it shows inside its dashed edge — its faint wash over the ground —
      // and its colour, for a folder's band beside it (review F1.5); and on its
      // outermost device pixel, for a line beside it (tmHollowEdge, review F2.1).
      r.shows = tmSeenThrough([mix(ground, base, TM_HOLLOW_WASH)], tmWashesOver(r, washes));
      r.showsEdge = tmSeenThrough(tmHollowEdge(ground, base, dpr), tmWashesOver(r, washes));
      r.showsRgb = base;
      continue;
    }

    const washedBy = tmWashesOver(r, washes);
    if (tmLeafKind(r) === 'textured') {
      // A shade toward a lined leaf's lightness, by its size (tmTexturedFill, residual 3).
      const s = Math.min(r.w, r.h) / tmPxScale(dpr);
      tmPaintLeaf(r, tmTexturedFill(base, s, dpr, washedBy, pulls), washedBy); // laid below (tmLayLeaf)
      // Its texture's shades (pass 2.4, tmLeafTexture), which a line beside it weighs (review F1.5).
      r.texStops = tmTextureStops(r.stops, base, tmTextureContrast(s));
      r.texSeen = tmSeenThrough(r.texStops, washedBy);
    } else {
      tmPaintLeaf(r, base, washedBy); // laid below, once its fill is settled (tmLayLeaf)
    }
    r.ownRgb = base; // its colour, which a lined leaf's fill is a shade of (tmEdgedFill)
  }
  // Where passes 2.6 and 2.7 will lay their lines, each stretch toned against
  // what a person sees on each side of it (tmLeafLines, tmFrameBands).
  const near = tmNeighbourhood(px, kids, dpr, pw / dpr, ph / dpr, ground);
  const edged = px.filter((r) => !r.frame && tmLeafKind(r) === 'edged');
  for (const r of edged) r.lines = tmLeafLines(r, near);
  // Where a leaf's lines took it further from its colour than a texture
  // would, it is filled a shade lighter or darker (tmEdgedFill) — every leaf
  // judged beside the fills as they were, so two alike are filled alike —
  // and every line toned again against the fills as they now are (residuals
  // 3 and 5). Then pass 1 lays each leaf (tmLayLeaf).
  const refills = edged.map((r) => [r, tmEdgedFill(r, near, r.ownRgb, tmWashesOver(r, washes))]).filter(([r, fill]) => fill !== r.fillRgb);
  for (const [r, fill] of refills) tmPaintLeaf(r, fill, tmWashesOver(r, washes));
  if (refills.length) {
    near.shared.clear();
    for (const r of edged) r.lines = tmLeafLines(r, near);
  }
  for (const r of px) if (!r.frame && !r.shows && r.stops) tmLayLeaf(ctx, r);
  for (const r of px) if (r.frame) r.bands = tmFrameBands(r, near);
  // Pass 2.4: the texture of each folder's own fill (J51) and of each leaf too
  // small for lines, part of its tile — clear of every line (tmLineMask), and
  // a folder's only where its own fill shows.
  const lineMask = tmLineMask(px, pw, ph, dpr);
  for (const r of px) {
    if (r.frame ? !r.bg || r.showsGround : tmLeafKind(r) !== 'textured') continue;
    r.tex = r.frame ? tmFolderTexture(r, kids, lineMask, pw, ph, dpr) : tmLeafTexture(r, lineMask, pw, ph, dpr);
    ctx.fillStyle = tmLeafFill(ctx, r.tex.stops, r.y, r.h);
    for (const [x, y, w, h] of r.tex.rects) ctx.fillRect(x, y, w, h);
  }
  // Pass 2.5: diff wash over expanded directories (history diff mode only).
  // A folder's own growth/shrinkage must show even when its visible children
  // didn't change — e.g. it shrank because a child was deleted outright. Over
  // its whole box, as tmWashesOver reckons it (review F2.3).
  for (const { r, rgb: c } of washes) {
    ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${TM_DIFF_WASH})`;
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  // Passes 2.6 and 2.7 stop at the top-level folders' name tags (tmClipOutTags).
  ctx.save();
  if (tagRects.length) tmClipOutTags(ctx, tagRects, pw / dpr, ph / dpr);
  // Pass 2.6: leaf lines, inside each leaf's own box (tmLeafLines), laid
  // after the washes so a line is seen in the tone it was picked in — under
  // two washes even black reached only 2.3:1 on a grey tile.
  for (const r of px) {
    for (const l of r.lines || []) {
      ctx.fillStyle = l.rgb;
      ctx.fillRect(l.x, l.y, l.w, l.h);
    }
  }
  // Pass 2.7: folder frames. Every leaf is painted at full strength, so
  // nesting is read from the edges, as on a desktop treemap: each folder's
  // band, toned stretch by stretch against what a person sees beside it
  // (tmFrameBands), after the washes, and deepest first, so a folder's band
  // lies over a nested one's on an edge they share.
  for (const r of tmFramesDeepestFirst(px)) {
    for (const b of r.bands) {
      ctx.fillStyle = b.rgb;
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
  }
  ctx.restore();
  // Pass 3: top-level directory name tags.
  ctx.textBaseline = 'middle';
  ctx.font = '600 10.5px -apple-system, sans-serif';
  for (const t of tagRects) tmLayTag(ctx, t);
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
  // The dashes keep a device pixel clear of every line and band
  // (tmOpenDashes), and stop at the top-level folders' name tags as the lines
  // do.
  ctx.save();
  if (tagRects.length) tmClipOutTags(ctx, tagRects, pw / dpr, ph / dpr);
  ctx.fillStyle = TM_OPEN_DASH;
  for (const r of px) {
    if (!containerListable(r.n) || r.n.virtual) continue;
    r.dashes = tmOpenDashes(r, near, lineMask, pw, ph, dpr);
    for (const [x, y, w, h] of r.dashes) ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
  for (const r of px) {
    if (!containerListable(r.n) || r.n.virtual) continue;
    // The key names it only where its mark shows: a dash clear of the name
    // tags, or its glyph. A container too small for its ring gets no dashes,
    // and one under a tag has them cut away (review F1.5).
    const glyph = r.w > 40 && r.h > 34;
    if (glyph || r.dashes.some((q) => !tmUnderTag(q, tagRects))) marks.open.add(r.n.container);
    if (glyph) {
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

  // A grammar query with no answer for this tree yet dims nothing: over the
  // saved index's tree while its scan runs (K03 took the older answer down),
  // the bare-word rule below judged "ext:mov,mkv" against every name, dimmed
  // the whole map and counted "0 matches" (ninth browser pass M01). The query
  // waits, the box says so, and its answer draws the highlights.
  const waiting = state.treemap.queryMode === 'grammar' && !state.treemap.matchedPaths;
  const q = waiting ? '' : state.treemap.query.trim().toLowerCase();
  state.treemap.matches = 0;
  // The sunburst draws no highlight — presentSunburst lays no overlay over its
  // arcs — so it counts none. Run on, the loops below counted the matches
  // among the last rectangle map's pxRects (another folder's, or none) and
  // "0 of 9 matches" stood over the sunburst's own line (hunt C20).
  if (state.treemap.mode === 'sunburst') return;
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

  // A folder's own fill (J51, pass 0) that does not match is dimmed with the
  // rest: it was left at full colour, a bright slab beside the matches (review
  // F1.1). Laid over the folder's box, shallowest folder first, then cleared
  // over what is drawn in it — which is dimmed below, leaf by leaf, or is a
  // folder of its own — so no pixel is dimmed twice. A folder that matches
  // keeps its fill bright, and its band is dimmed with what it lies on. The
  // ground a folder shows where an online-only file is hidden in it
  // (r.showsGround) is dimmed the same way: it was left undimmed, cleared from
  // the scrim of the folder above (review F2.1).
  const kids = tmKidsOf(state.treemap.pxRects);
  const fills = state.treemap.pxRects.filter((r) => r.frame && (r.bg || r.showsGround)).sort((a, b) => a.n.depth - b.n.depth);
  for (const r of fills) {
    if (isMatch(r.n)) continue;
    ctx.fillStyle = scrim;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    for (const c of kids.get(r.n.path) || []) ctx.clearRect(c.x, c.y, c.w, c.h);
  }
  // Dim non-matching leaves, then outline matches on top.
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
  // A grammar query with no answer yet counts nothing: the line is the map's
  // own, not "0 matches" (M01, as renderSearchOverlay draws it).
  const q = state.treemap.queryMode === 'grammar' && !state.treemap.matchedPaths ? '' : state.treemap.query.trim();
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
    // Not over the sunburst, which counts no matches (renderSearchOverlay):
    // its line is its own, and the box says what became of the query (C20).
    if (state.treemap.mode === 'sunburst') return;
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
  // How many items the map drew, in plain words, with the floor they were
  // asked with: "9,421 items of 4.0 KB or more drawn · 8.8 GB in this folder"
  // (BQG-5 item 15, review F1.4). It read "12,705 nodes · 9,421 drawn" —
  // "nodes" is the code's word — and then "9,421 of 12,705 items drawn",
  // which named the server's layout as the folder's items: it leaves out
  // everything under the floor, past the depth and inside a folder too small
  // to divide, so a folder of 100,000 small files said "4 of 4 items drawn".
  // The folder's own count is the Grid's to give. The Trash cell beside the
  // home folder is not one of its items. The noun follows its count — "1
  // item", never "1 items"; the size is the folder's, said so (B26).
  let drawn = 0;
  for (const r of state.treemap.pxRects) if (!r.n.isTrash) drawn++;
  const floor = state.treemap.minSize > 1 ? ` of ${formatBytes(state.treemap.minSize)} or more` : '';
  // A map laid out from the saved index's tree, with no scan behind it (J05):
  // said where the map is, since it may not be what the disk holds now.
  const held = state.treemap.nodesFor;
  const fromIndex = !!held && held.scanId === null && held.nodes === state.treemap.nodes;
  $('tmStatus').textContent =
    `${formatCount(drawn)} item${drawn === 1 ? '' : 's'}${floor} drawn`
    + ` · ${formatBytes(state.treemap.rootSize)} in this folder`
    + (fromIndex ? ' · from the saved index' : '');
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

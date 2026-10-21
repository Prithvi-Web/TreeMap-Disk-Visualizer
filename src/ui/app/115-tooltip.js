/* ───────────────────────────── Tooltip ───────────────────────────── */
/* ── A2 allocation, resolved on demand ──
   The index tree carries sharedBytes/exclusiveBytes per node, but a tree that
   came straight from a scan does not — and the background rescan replaces the
   indexed tree with a scanned one, which would silently drop the A2 line from
   tooltips a moment after it appeared.

   So a node without allocation data resolves it once, lazily, and the answer is
   cached by path (including "nothing to say", so a plain file is never asked
   about twice). One request per distinct file hovered, never per hover. */
const allocationCache = new Map();

function resolveAllocation(node) {
  if (!node || node.type !== 'file' || !node.path) return;
  if (node.sharedBytes !== undefined || allocationCache.has(node.path)) return;
  allocationCache.set(node.path, null); // claim it, so concurrent hovers don't stack

  api('/api/allocation/file?path=' + encodeURIComponent(node.path))
    .then((info) => {
      // An answer without figures — 202, the index still being built — is
      // nothing to say, like a 409 (not measured) below: the slot keeps its
      // null, and nothing is grafted onto the node (plan U-7).
      if (!info || typeof info.allocatedBytes !== 'number') return;
      allocationCache.set(node.path, info);
      // Graft onto the node so every later read — tooltip, grid, preview —
      // sees it without another request.
      node.allocatedBytes = info.allocatedBytes;
      node.sharedBytes = info.sharedBytes;
      node.exclusiveBytes = info.exclusiveBytes;
      node.linksInScope = info.linksInScope;
      node.linksTotal = info.linksTotal;
      // Repaint only if this is still the file under the pointer.
      const tip = $('tooltip');
      if (tip.style.display !== 'none' && tip.dataset.path === node.path) {
        showTooltip(Number(tip.dataset.x), Number(tip.dataset.y), node, tip.dataset.pct ? Number(tip.dataset.pct) : null);
      }
    })
    .catch(() => { /* no index yet, not a local file, or not measured (409) — the tooltip just omits the line */ });
}

/**
 * The A2 line in a tooltip: what this file really costs, and what deleting it
 * would actually free.
 *
 * Shown only when it says something the size does not — a line reading "100%
 * exclusive" on every ordinary file is noise, and noise is what stops people
 * reading tooltips at all. Three cases earn it:
 *
 *   - the file shares its data with another name (deleting it frees nothing),
 *   - it occupies less than it claims (sparse, compressed, or in the cloud),
 *   - its family reaches outside the scanned folder.
 */
function allocationTooltipLine(node) {
  const shared = node.sharedBytes > 0;
  const underAllocated = typeof node.allocatedBytes === 'number' && node.allocatedBytes < node.size;
  // A cloud placeholder always earns the line, even before its allocated size
  // has been resolved: the scanner marks it during the walk, and "this file is
  // not actually here" is the single most important thing to say about it.
  if (!shared && !underAllocated && !node.cloudPlaceholder) return '';

  if (shared) {
    const outside = node.linksTotal > node.linksInScope;
    const others = Math.max(1, (node.linksTotal || 2) - 1);
    return (
      `<div class="t-line num" style="margin-top:4px;">` +
      `<span class="t-strong">${formatBytes(node.sharedBytes)} shared</span> · ` +
      `0 B exclusive to this copy</div>` +
      `<div class="t-line">${escapeHtml(
        outside
          ? `The same data has ${others} other name${others === 1 ? '' : 's'}, at least one outside this folder — deleting this copy frees nothing.`
          : `The same data appears under ${others} other name${others === 1 ? '' : 's'} here — deleting this copy frees nothing.`,
      )}</div>`
    );
  }

  /* A3 — a placeholder states BOTH numbers, never one. "4.2 GB" alone is the
     lie: the file is not here, and reporting only its claimed size is what
     makes an evicted video look like it is filling the disk. The two are
     labelled by where the bytes are, not merely as "on disk" vs "claims". */
  if (node.cloudPlaceholder) {
    const local = node.allocatedBytes ?? 0;
    const provider = { icloud: 'iCloud', onedrive: 'OneDrive', dropbox: 'Dropbox', gdrive: 'Google Drive' }[node.cloudProvider] || 'the cloud';
    return (
      `<div class="t-line num" style="margin-top:4px;">` +
      `<span class="t-strong">${formatBytes(local)} on this computer</span> · ` +
      `${formatBytes(node.size)} in ${escapeHtml(provider)}</div>` +
      `<div class="t-line">${escapeHtml(
        `Not downloaded — it costs almost nothing here until you open it. Deleting it removes it from ${provider} too.`,
      )}</div>`
    );
  }

  return (
    `<div class="t-line num" style="margin-top:4px;">` +
    `<span class="t-strong">${formatBytes(node.allocatedBytes)} on disk</span> · ` +
    `claims ${formatBytes(node.size)}</div>` +
    `<div class="t-line">${escapeHtml(
      'This file reserves more space than it currently uses — it is not a cloud file.',
    )}</div>`
  );
}

function showTooltip(x, y, node, pctOfRoot = null) {
  const tip = $('tooltip');
  if (node.isTrash) {
    tip.innerHTML = `<div class="t-head"><span style="color:#8aa0b3;display:inline-flex;">${icon('trash', 15)}</span>Trash</div>` +
      `<div class="t-line num"><span class="t-strong">${formatBytes(node.size)}</span> · click to view contents</div>`;
    tip.style.display = 'block';
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(x + pad, window.innerWidth - w - 10) + 'px';
    tip.style.top = (y + pad + h > window.innerHeight - 10 ? y - h - 8 : y + pad) + 'px';
    return;
  }
  // Remember what this tooltip is showing, so an allocation lookup that lands
  // a moment later can repaint it — and only if it is still the same file.
  tip.dataset.path = node.path || '';
  tip.dataset.x = String(x);
  tip.dataset.y = String(y);
  if (pctOfRoot !== null) tip.dataset.pct = String(pctOfRoot); else delete tip.dataset.pct;
  resolveAllocation(node);
  resolveScore(node);
  resolveHumanScale(node);

  const k = kindFor(node);
  tip.innerHTML = `
    <div class="t-head"><span style="color:${k.tint};display:inline-flex;">${icon(k.icon, 15)}</span>${escapeHtml(node.name)}</div>
    <div class="t-line t-path">${escapeHtml(node.path)}</div>
    <div class="t-line num"><span class="t-strong" style="color:${sizeInk(node.size)}">${formatBytes(node.size)}</span>` +
    (pctOfRoot !== null && pctOfRoot >= 0.05 ? ` · ${pctOfRoot.toFixed(1)}% of this view` : '') +
    (node.logicalSize ? ` · ${formatBytes(node.logicalSize)} uncompressed` : '') +
    // While the cart preview is up a click does nothing (it previews the map
    // after the cart), so the tooltip says when the archive can be opened, as
    // the key does (BQG-5 item 15).
    (containerListable(node) && !node.children ? (tmPreview.on ? ' · you can look inside it after the preview' : ' · click to look inside') : '') +
    ` · modified ${formatDate(node.modifiedAt)}` +
    // Only meaningful while sorting the grid by atime — and atime is best-effort
    // (absent for gdu/cloud scans and noatime mounts), so missing shows as "—".
    (state.view === 'grid' && state.grid.sort === 'accessed'
      ? ` · accessed ${node.accessedAt ? formatDate(node.accessedAt) : '—'}` : '') +
    `</div>` +
    allocationTooltipLine(node) +
    reclaimTooltipLine(node) +
    humanScaleTooltipLine(node) +
    noteTooltipLine(node);
  tip.style.display = 'block';
  const pad = 14;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(x + pad, window.innerWidth - w - 10) + 'px';
  tip.style.top = (y + pad + h > window.innerHeight - 10 ? y - h - 8 : y + pad) + 'px';
}
/**
 * Fetch this node's reclaim score on hover, and repaint the tooltip when it
 * lands — the same shape as `resolveAllocation` above, for the same reason:
 * a hover must never wait on a subprocess.
 *
 * Only in the Reclaim colour mode. Scoring on every hover in every mode would
 * spend the fact budget on files nobody asked a question about, and put a
 * line in the tooltip that most people never want to see.
 */
function resolveScore(node) {
  if (!node || !node.path || state.treemap.colorMode !== 'reclaim') return;
  if (scoreKnown(node.path)) return;
  void ensureScores([node.path], () => {
    const tip = $('tooltip');
    if (tip.style.display !== 'none' && tip.dataset.path === node.path) {
      showTooltip(Number(tip.dataset.x), Number(tip.dataset.y), node, tip.dataset.pct ? Number(tip.dataset.pct) : null);
    }
  });
}

/**
 * The score line in a tooltip.
 *
 * Shown only in the Reclaim colour mode, where the number explains what the
 * user is already looking at. It names the single largest contributor rather
 * than the bare figure: "74 — mostly because it rebuilds itself" is a
 * sentence someone can disagree with, and 74 alone is not. The full breakdown
 * is a right-click away, which the line says.
 */
function reclaimTooltipLine(node) {
  if (state.treemap.colorMode !== 'reclaim' || !node || !node.path) return '';
  const fact = scoreFor(node.path);
  if (!fact) {
    // Asked and unanswerable is a real state and gets a real sentence; not
    // yet asked says nothing, because the answer is a moment away.
    return scoreKnown(node.path)
      ? `<div class="t-line">Reclaim score — none of the six signals could be read for this.</div>`
      : '';
  }
  const top = fact.components.reduce((best, c) => (best && best.contribution >= c.contribution ? best : c), null);
  const lead = top && top.contribution > 0 ? ` — mostly ${escapeHtml(top.label.toLowerCase())}` : '';
  const unknowns = fact.missing.length
    ? ` · ${fact.missing.length} signal${fact.missing.length === 1 ? '' : 's'} unknown`
    : '';
  return `<div class="t-line num"><span class="t-strong" style="color:${reclaimInk(fact.score)}">Reclaim ${fact.score}</span>` +
    `${lead}${unknowns} · right-click for the breakdown</div>`;
}

/* ── v4 §9.3 — human-scale equivalents in the tooltip ──
 *
 * "42 GB" is a number; "≈ 3,100 photos like the ones in this folder" is a
 * feeling. The equivalence comes from the humanScale fact provider, which
 * averages the folder's OWN media — never a constant — so the line can carry
 * its basis. Folders with nothing comparable (fewer than ten of a kind) get
 * no line at all, which is the honest form of "no comparison available".
 */
const HS_MIN_BYTES = 1e9; // ~1 GB — below this the raw number reads fine
const hsFacts = new Map(); // path → equivalents value, or null = asked, none
const hsPending = new Set();

function resolveHumanScale(node) {
  if (!humanScaleOn || !node || !node.path || node.type !== 'dir') return;
  if (node.size < HS_MIN_BYTES || node.virtual || node.path.startsWith('cloud://')) return;
  // Asked of the scan the tree on screen came from (treeScanId) — not a scan
  // running behind it, which answers "unavailable", kept as asked and none
  // (review F2.2).
  const treeScan = treeScanId;
  if (!treeScan() || hsFacts.has(node.path) || hsPending.has(node.path)) return;
  hsPending.add(node.path);
  const scanAtRequest = treeScan();
  void (async () => {
    try {
      const res = await api('/api/facts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanId: scanAtRequest, paths: [node.path], providers: ['humanScale'] }),
      });
      if (treeScan() !== scanAtRequest) return; // a new tree answered an old question
      const provider = (res.providers && res.providers.humanScale) || null;
      const values = (provider && provider.available && provider.values) || {};
      // Absent from values means the provider could not answer; null keeps us
      // from asking in a loop and, crucially, from inventing an equivalence.
      hsFacts.set(node.path, Object.prototype.hasOwnProperty.call(values, node.path) ? values[node.path] : null);
      const tip = $('tooltip');
      if (tip.style.display !== 'none' && tip.dataset.path === node.path) {
        showTooltip(Number(tip.dataset.x), Number(tip.dataset.y), node, tip.dataset.pct ? Number(tip.dataset.pct) : null);
      }
    } catch {
      hsFacts.delete(node.path); // transient — a later hover may retry
    } finally {
      hsPending.delete(node.path);
    }
  })();
}

function humanScaleTooltipLine(node) {
  if (!humanScaleOn || !node || !node.path || node.type !== 'dir' || node.size < HS_MIN_BYTES) return '';
  const fact = hsFacts.get(node.path);
  if (!fact || !fact.equivalents || !fact.equivalents.length) return ''; // nothing comparable → nothing said
  const parts = fact.equivalents.slice(0, 2).map((e) =>
    `≈ ${formatCount(Number(e.equivalentCount) || 0)} ${escapeHtml(e.kind)}`).join(' or ');
  const b = fact.equivalents[0];
  const basis = `based on the ${formatCount(b.sampleCount)} ${escapeHtml(b.kind)} in this folder, average ${formatBytes(b.avgBytes)}` +
    (fact.capped ? ' · sampled from the first 500k items' : '');
  return `<div class="t-line num">${parts} like the ones here <span class="muted">· ${basis}</span></div>`;
}

/**
 * The note line in a tooltip (v4 §9.5). The user's own words, escaped on the
 * way into markup — never raw — and truncated for the hover; the full text
 * lives in the editor one right-click away. When the note is also pausing
 * suggestions, the line says so: an absence of suggestions with no stated
 * cause reads as a bug.
 */
function noteTooltipLine(node) {
  if (!node || !node.path) return '';
  const n = noteFor(node.path);
  if (!n) return '';
  // Truncated by code points, not UTF-16 units — a slice through the middle
  // of an emoji leaves a lone surrogate rendering as �.
  const chars = [...n.text];
  const brief = chars.length > 140 ? chars.slice(0, 140).join('') + '…' : n.text;
  return `<div class="t-line"><span class="t-strong">Note:</span> ${escapeHtml(brief)}` +
    (n.suppress ? ' · suggestions paused here' : '') + '</div>';
}

function hideTooltip() { $('tooltip').style.display = 'none'; }
/**
 * Reposition the card that is already showing — the same-node frame of a
 * hover. No content is touched, so layout is clean and the two size reads
 * are plain reads, not a forced reflow. The remembered position moves with
 * it, so a resolver repaint that lands mid-glide draws where the pointer is
 * now rather than where it entered the tile.
 */
function moveTooltip(x, y) {
  const tip = $('tooltip');
  tip.dataset.x = String(x);
  tip.dataset.y = String(y);
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(x + pad, window.innerWidth - w - 10) + 'px';
  tip.style.top = (y + pad + h > window.innerHeight - 10 ? y - h - 8 : y + pad) + 'px';
}

/* ───────────────────────────── Context menu ───────────────────────────── */
let ctxTarget = null;
function showCtxMenu(x, y, node) {
  ctxTarget = node;
  const fm = state.system && state.system.platform === 'darwin' ? 'Finder'
           : state.system && state.system.platform === 'win32' ? 'Explorer' : 'file manager';
  const menu = $('ctxMenu');
  // Cloud entries: copy the path or send to the provider's trash — nothing
  // else exists for a file that isn't on this disk.
  if (node.path.startsWith('cloud://')) {
    const provider = cloudProviderOfScan();
    ctxMenuShow(menu, { label: `Actions for ${node.name || node.path}`, x, y, html: `
      <button data-act="copy">${icon('copy', 15)}Copy path</button>
      <div class="div"></div>
      <button data-act="cloudtrash" class="danger">${icon('trash', 15)}Move to ${escapeHtml(provider.name)}'s trash</button>` });
    menu.querySelector('[data-act="copy"]').addEventListener('click', () => { ctxMenuFocusOpener(hideCtxMenu()); copyPath(node.path); });
    menu.querySelector('[data-act="cloudtrash"]').addEventListener('click', () => { ctxMenuFocusOpener(hideCtxMenu()); confirmTrash([node.path]); });
    return;
  }
  // Entries inside a container exist in its listing, not on disk — the only
  // sensible action is copying the path; trash/open the container itself.
  if (node.virtual) {
    ctxMenuShow(menu, { label: `Actions for ${node.name || node.path}`, x, y, html: `
      <button data-act="copy">${icon('copy', 15)}Copy path</button>
      <div class="div"></div>
      <button disabled style="opacity:.55;cursor:var(--cur-dot)">${icon('archive', 15)}Inside an archive — act on the archive itself</button>` });
    menu.querySelector('[data-act="copy"]').addEventListener('click', () => { ctxMenuFocusOpener(hideCtxMenu()); copyPath(node.path); });
    return;
  }
  const inCart = cartHas(node.path);
  const hasBudget = node.type === 'dir' && !!budgetFor(node.path);
  // The cart entry names the feature as every cart toggle does (cartButtonTitle), in sentence
  // case; it said "Add to Cart" (G18 review F1.3). Written out, so the copy guard reads each arm.
  ctxMenuShow(menu, { label: `Actions for ${node.name || node.path}`, x, y, html: `
    <button data-act="open">${icon('external', 15)}Open in ${fm}</button>
    ${node.type === 'file' ? `<button data-act="preview">${icon('search', 15)}Quick Look</button>` : ''}
    <button data-act="copy">${icon('copy', 15)}Copy path</button>
    <button data-act="cart">${icon(inCart ? 'check' : 'cart', 15)}${inCart ? 'Remove from Clean Up cart' : 'Add to Clean Up cart'}</button>
    <button data-act="score">${icon('help', 15)}Why this reclaim score?</button>
    ${node.isTrash ? '' : `<button data-act="offload">${icon('archive', 15)}Offload…</button>`}
    ${node.type === 'dir' ? `<div class="div"></div>
    ${node.isTrash ? '' : `<button data-act="terminal">${icon('terminal', 15)}Open in Terminal</button>`}
    <button data-act="budget">${icon('gauge', 15)}${hasBudget ? 'Edit budget…' : 'Set budget…'}</button>
    ${hasBudget ? `<button data-act="budget-remove">${icon('x', 15)}Remove budget</button>` : ''}
    ${node.isTrash ? '' : `<button data-act="note">${icon('doc', 15)}${noteFor(node.path) ? 'Edit note…' : 'Add note…'}</button>`}` : ''}
    <div class="div"></div>
    <button data-act="trash" class="danger">${icon('trash', 15)}Move to Trash</button>` });
  menu.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    const act = b.dataset.act;
    const back = hideCtxMenu();
    ctxMenuFocusOpener(back); // before the act: a sheet it opens gives focus back here
    if (act === 'open') openInOS(ctxTarget.path, true);
    if (act === 'preview') openPreview(ctxTarget);
    if (act === 'copy') copyPath(ctxTarget.path);
    if (act === 'terminal') openTerminal(ctxTarget.path);
    if (act === 'cart') cartToggle(ctxTarget.path);
    // §3.2: every score in the UI is one click from its components. The
    // treemap has a tooltip rather than a clickable row, so the right-click
    // menu is where a cell's breakdown opens. The path is captured now
    // because ctxTarget is reassigned by the next right-click. The panel opens
    // at the pointer, and gives focus back to what the menu was opened from
    // (a Grid tile has no score badge to find again — QA fourth pass E05).
    if (act === 'score') { const p = ctxTarget.path; ensureScores([p]).then(() => openReclaimWhy(p, null, { x, y }, back)); }
    if (act === 'offload') startOffloadFlow([ctxTarget.path]);
    if (act === 'budget') openBudgetDialog(ctxTarget);
    if (act === 'budget-remove') removeBudget(ctxTarget.path);
    if (act === 'note') openNoteDialog(ctxTarget);
    if (act === 'trash') confirmTrash([ctxTarget.path]);
  }));
}

/* ── #ctxMenu is a menu, whoever fills it (QA-6 review MEDIUM-1) ──
   Three things show it — this right-click menu, Export, and the "…" crumb's
   folded folders — and each used to show it on its own, as an unnamed box of
   plain buttons the keyboard could reach only by Tab. ctxMenuShow is the one
   door, and the only writer of the menu's contents: the entries go into the
   .ctx-list that scrolls inside the panel (QA-6b review F1.11), the menu
   gets a name and its entries the menuitem role, the control
   that opened it says so (aria-expanded), and focus is remembered so the
   keyboard closes — Escape, a pick, Tab — put it back where it was rather
   than on <body>: every entry's handler starts with
   ctxMenuFocusOpener(hideCtxMenu()), whichever menu it is in (QA-6b review
   F1.8). ctxMenuKeydown gives it the arrows, Home and End. */
/** The control whose menu is showing (it carries aria-expanded), or null for a right-click at a point. */
let ctxMenuOpener = null;
/** Where focus goes back to when the keyboard closes the menu: the opener, or what had focus when it opened. */
let ctxMenuReturn = null;
/**
 * The gap kept between the menu and every edge of the window (QA-6 review
 * LOW-4). The CSS caps the menu's .ctx-list so the whole panel is no taller
 * than the window less two of these, and scrolls the rest, so a menu of 30
 * folded folders opens on screen; the top used to be placed above the
 * window's top edge, with the root out of reach.
 */
const CTX_MENU_EDGE = 8;

/**
 * Fill #ctxMenu with `html` — its entries — and show it at (x, y), named
 * `label` for assistive technology. The entries go in a .ctx-list, the
 * element that scrolls: #ctxMenu is a lensed surface whose frost and ring are
 * its ::before and ::after, which a scrolling #ctxMenu carried away with the
 * entries (QA-6b review F1.11). Listeners go on the entries after this.
 */
function ctxMenuShow(menu, { label, html, opener = null, x, y }) {
  if (ctxMenuOpener && ctxMenuOpener !== opener) ctxMenuOpener.setAttribute('aria-expanded', 'false');
  menu.innerHTML = `<div class="ctx-list" role="none">${html}</div>`;
  menu.setAttribute('aria-label', label);
  menu.querySelectorAll('button').forEach((b) => b.setAttribute('role', 'menuitem'));
  menu.querySelectorAll('.div').forEach((d) => d.setAttribute('role', 'separator'));
  menu.style.display = 'block';
  menu.style.left = Math.max(CTX_MENU_EDGE, Math.min(x, window.innerWidth - 230)) + 'px';
  menu.style.top = Math.max(CTX_MENU_EDGE, Math.min(y, window.innerHeight - menu.offsetHeight - CTX_MENU_EDGE)) + 'px';
  ctxMenuOpener = opener;
  ctxMenuReturn = opener || document.activeElement || null;
  if (opener) opener.setAttribute('aria-expanded', 'true');
}

/**
 * Close the menu. Answers where focus belongs now, for the closes the
 * keyboard made — ctxMenuFocusOpener(hideCtxMenu()) — and is otherwise a
 * plain close: a click elsewhere or a scroll leaves focus where it went.
 */
function hideCtxMenu() {
  $('ctxMenu').style.display = 'none';
  if (ctxMenuOpener) ctxMenuOpener.setAttribute('aria-expanded', 'false');
  const back = ctxMenuReturn;
  ctxMenuOpener = null;
  ctxMenuReturn = null;
  return back;
}

/** Focus `el` (what hideCtxMenu answered) if it is still on the page. */
function ctxMenuFocusOpener(el) {
  if (el && el.isConnected !== false && typeof el.focus === 'function') el.focus({ preventScroll: true });
}

/**
 * Whether #ctxMenu is showing. The keys of the views behind it wait while it
 * is — the map's (tmMapKeyYields) and the Grid's Backspace and Delete, whose
 * trail folds into the same "…" menu (QA-6b review F2.6).
 */
function ctxMenuIsOpen() {
  return $('ctxMenu').style.display === 'block';
}

/**
 * The open menu's keys, ahead of every other meaning (the page's keydown
 * handler asks first). ArrowDown and ArrowUp step through the entries and
 * wrap, Home and End go to the ends — from inside the menu, or from wherever
 * focus is when a right-click opened it without taking focus. Tab leaves it,
 * wherever focus is: the menu closes — Export and a right-click open it with
 * focus left where it was, and a menu left up holds the map's keys (QA-6b
 * review F1.1) — focus that was inside it goes back to its opener, and the
 * Tab goes on from there. Escape and Enter are not handled here: Escape is
 * the page's Escape chain, and Enter on an entry is that button's own press.
 * Answers whether the key was the menu's.
 */
function ctxMenuKeydown(e) {
  const menu = $('ctxMenu');
  if (menu.style.display !== 'block') return false;
  const active = document.activeElement;
  const inside = menu.contains(active);
  if (e.key === 'Tab') {
    const back = hideCtxMenu();
    if (inside) ctxMenuFocusOpener(back);
    return false;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return false;
  // A text field keeps its own arrows, Home and End.
  if (!inside && /^(INPUT|TEXTAREA|SELECT)$/.test((active && active.tagName) || '')) return false;
  const items = [...menu.querySelectorAll('button')].filter((b) => !b.disabled);
  if (!items.length) return false;
  const at = items.indexOf(active);
  const last = items.length - 1;
  const next = e.key === 'Home' ? 0
    : e.key === 'End' ? last
    : e.key === 'ArrowDown' ? (at + 1) % items.length // from outside (-1), the first
    : (at <= 0 ? last : at - 1);
  e.preventDefault();
  items[next].focus({ preventScroll: true });
  if (typeof items[next].scrollIntoView === 'function') items[next].scrollIntoView({ block: 'nearest' });
  return true;
}
/** A scroll elsewhere closes the menu; one of the menu's own list (it scrolls in a short window) does not. */
function ctxMenuOnScroll(e) {
  if (!$('ctxMenu').contains(e.target)) hideCtxMenu();
}
document.addEventListener('click', (e) => { if (!$('ctxMenu').contains(e.target)) hideCtxMenu(); });
document.addEventListener('scroll', ctxMenuOnScroll, true);

/* ── The menu from the keyboard (QA fourth pass E05) ──
   The ContextMenu key, or Shift+F10, on the focused item opens the menu a
   right-click on it would. Every list's rows and the Grid's tiles carry
   their own contextmenu listener, so the key is delivered as one, at the
   item, and bubbles: a control inside a row (Largest Files' buttons) opens
   its row's menu. Focus goes to the menu's first entry, and Escape, Tab and
   every entry give it back (ctxMenuReturn). The map's canvas is one element
   for every cell, and its listener hit-tests a point the keyboard has none
   of: there the menu is the keyboard's selected cell's (tmCanvasKeyMenu).
   A text field keeps the platform's own menu, a sheet holds the keyboard,
   and a key that opened nothing is left to the platform. */
/** Whether the ContextMenu key's keydown opened the menu: its keyup opens the platform's own on some systems. */
let ctxMenuKeyOpened = false;
function ctxMenuKeyOpens(e) {
  return e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey);
}
function ctxMenuFromKey(e) {
  if (!ctxMenuKeyOpens(e) || topModal()) return;
  const el = document.activeElement;
  if (!el || el === document.body || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || $('ctxMenu').contains(el)) return;
  let opened;
  if (el === tmCanvas) opened = tmCanvasKeyMenu();
  else {
    // At the item, a little in from its top-left corner, where the menu reads as its own.
    const r = el.getBoundingClientRect();
    opened = !el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
      clientX: r.left + Math.min(r.width / 2, 24), clientY: r.top + Math.min(r.height / 2, 24),
    }));
  }
  if (!opened) return; // nothing here has a menu: the platform's key
  e.preventDefault();
  ctxMenuKeyOpened = e.key === 'ContextMenu';
  // A crumb's menu is its budget sheet, which takes focus itself.
  if (!ctxMenuIsOpen()) return;
  const first = [...$('ctxMenu').querySelectorAll('button')].find((b) => !b.disabled);
  if (first) first.focus({ preventScroll: true });
}
function ctxMenuKeyUp(e) {
  if (e.key !== 'ContextMenu' || !ctxMenuKeyOpened) return;
  ctxMenuKeyOpened = false;
  e.preventDefault();
}
document.addEventListener('keydown', ctxMenuFromKey);
document.addEventListener('keyup', ctxMenuKeyUp);

async function openInOS(path, reveal) {
  try {
    await api('/api/files/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, reveal }),
    });
  } catch (e) { toast('Could not open: ' + e.message, 'error'); }
}
async function copyPath(path) {
  try { await navigator.clipboard.writeText(path); toast('Path copied'); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = path; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove(); toast('Path copied');
  }
}
/** Open the OS terminal at a scanned folder — the window itself is the feedback. */
async function openTerminal(path) {
  try {
    await api('/api/files/terminal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  } catch (e) { toast('Could not open a terminal: ' + e.message, 'error'); }
}

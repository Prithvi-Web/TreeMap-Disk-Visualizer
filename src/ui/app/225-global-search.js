/* ─────────────────────── Global search (A4) ───────────────────────
   Searches everything TreeMap has indexed, not just the current view — which
   is why it lives in the header rather than inside a tab.

   The query language is deliberately the one the treemap highlight box already
   uses (`*.zip`, `.zip`, or a filename substring). §A4 forbids inventing a
   second one, and the reason is practical: two boxes that look the same and
   interpret `*.zip` differently is worse than either box alone.

   Results come back largest-first, because this is a search for things filling
   the disk, and are grouped by folder so ten hits in one place read as one
   place rather than ten. */
const gsearch = {
  seq: 0,          // guards against a slow response overwriting a newer one
  timer: 0,
  hits: [],
  selected: -1,
  open: false,
  cameFrom: null,  // the control focused before the box was, for Escape to go back to (D10)
};

function gsearchClose() {
  gsearch.open = false;
  gsearch.selected = -1;
  const panel = $('gsearchResults');
  panel.hidden = true;
  $('gsearch').setAttribute('aria-expanded', 'false');
}

/**
 * Escape leaves the box (QA third pass D10). It blurred it, and focus fell to
 * <body>: a keyboard user started again from the top of the page. Focus goes
 * back to the control it came from, while that is still on screen; else to
 * the view on screen, or its sidebar tab when it has no control to offer —
 * the door the cart and the Grid's selection bar use (QA B13).
 */
function gsearchLeave() {
  gsearchClose();
  const from = gsearch.cameFrom;
  gsearch.cameFrom = null;
  // On screen means painted: a control removed or hidden since has no client rects.
  const usable = !!from && !from.disabled && !$('gsearchWrap').contains(from) && from.getClientRects().length > 0;
  const target = usable ? from : activeViewControl() || document.querySelector('.tabbar button[aria-selected="true"]');
  if (target) target.focus({ preventScroll: true });
}

/**
 * Focus the global search, opening the sidebar first when it is collapsed to
 * the icon rail — `focus()` on a `display: none` input does nothing at all,
 * silently, so the shortcut would otherwise be a lie in rail mode.
 */
function summonGlobalSearch() {
  if ($('sideNav').classList.contains('collapsed')) applySideNav(false);
  const box = $('gsearch');
  box.focus();
  box.select();
  if (gsearch.hits.length) gsearchOpen();
}

/**
 * Open the results, for someone in the search. A search typed and then left —
 * Tab or Escape inside the debounce, or while its request was out — still
 * answers and repaints the panel, so coming back shows the answer to what the
 * box says; it no longer reopens the panel around a person who is elsewhere,
 * its hits tabbable ahead of the sidebar's tabs (review F3.5 of QA third pass
 * D10). Cancelling the search instead would leave the older answer behind the
 * newer text, for Enter to open.
 */
function gsearchOpen() {
  if (!$('gsearchWrap').contains(document.activeElement)) return;
  gsearch.open = true;
  $('gsearchResults').hidden = false;
  $('gsearch').setAttribute('aria-expanded', 'true');
}

/** Render the panel: grouped by folder, largest first within each group. */
function renderGsearch(result) {
  const panel = $('gsearchResults');
  // One row per path (fifth browser pass F08). A folder and a folder inside
  // it can both be indexed; the server answers each path once, from a live
  // index where a stale one holds it too, and the panel holds to that as
  // well: a live index's hit wins over a stale one's, at the place the path
  // first came.
  const staleRoots = new Set(result.staleRoots || []);
  const byPath = new Map();
  for (const hit of result.hits || []) {
    const had = byPath.get(hit.path);
    if (!had || (staleRoots.has(had.rootPath) && !staleRoots.has(hit.rootPath))) byPath.set(hit.path, hit);
  }
  gsearch.hits = [...byPath.values()];
  gsearch.selected = -1;

  if (!gsearch.hits.length) {
    // Three different "nothing here" cases, and they mean different things —
    // collapsing them into one message is how a user concludes the feature is
    // broken when actually they simply haven't scanned anything yet.
    let note;
    if (!result.roots || result.roots.length === 0) {
      // The limit is the server's, as the last index status gave it (plan
      // U-1): a folder larger than that is not indexed after a scan, and
      // "scan a folder once" would be a promise a whole disk does not keep.
      note = typeof indexAutoMaxEntries === 'number'
        ? `Nothing is indexed yet. Scan a folder of up to ${formatCount(indexAutoMaxEntries)} items once and it becomes searchable instantly from then on.`
        : 'Nothing is indexed yet. Scan a folder once and it becomes searchable instantly from then on — folders larger than TreeMap indexes on its own are left out.';
    } else {
      note = `No matches for “${result.query}”. Try part of a filename, or ${'*.zip'} for a file type.`;
    }
    panel.innerHTML = `<div class="gsearch-note">${escapeHtml(note)}</div>`;
    gsearchOpen();
    return;
  }

  // Group by folder, preserving the size-descending order the server chose.
  const groups = new Map();
  for (const hit of gsearch.hits) {
    if (!groups.has(hit.parentPath)) groups.set(hit.parentPath, []);
    groups.get(hit.parentPath).push(hit);
  }

  let index = 0;
  let html = '';
  for (const [folder, hits] of groups) {
    // Long paths are truncated from the LEFT (direction:rtl in CSS): the tail
    // of a path is what identifies it, the "/Users/me/Library/…" head is not.
    // The CSS isolates the text left-to-right so the "/" stays first, and the
    // title carries the whole path the ellipsis cut (QA D51).
    html += `<div class="gsearch-group" title="${escapeHtml(folder)}">${escapeHtml(folder)}</div>`;
    for (const hit of hits) {
      html +=
        `<button class="gsearch-hit" role="option" aria-selected="false" data-i="${index}" data-path="${escapeHtml(hit.path)}">` +
        chipFor(hit, 13) +
        `<span class="nm">${escapeHtml(hit.name)}</span>` +
        `<span class="sz">${formatBytes(hit.size)}</span></button>`;
      index++;
    }
  }

  const shown = gsearch.hits.length;
  const total = result.countCapped ? `${formatCount(result.total)}+` : formatCount(result.total);
  if (result.truncated) {
    html += `<div class="gsearch-note">Showing the ${formatCount(shown)} largest of ${total} matches.</div>`;
  }
  // Staleness is never hidden: a result from an index that stopped watching
  // could name a file that has since moved (§A1's consistency guard). What
  // refreshes it is said as it is: a scan rebuilds a folder's index only up
  // to the limit (plan U-1), so a stale whole-disk index stays as it was, and
  // "scan again to refresh it" would be a promise a scan does not keep
  // (Track U review of U-1, finding 7).
  // Said where it is true: a hit shown came from a stale index — not whenever
  // any index searched is stale, while every hit shown came from a live one
  // (fifth browser pass F08).
  if (gsearch.hits.some((hit) => staleRoots.has(hit.rootPath))) {
    const limit = typeof indexAutoMaxEntries === 'number' ? ` (up to ${formatCount(indexAutoMaxEntries)} items)` : '';
    html += `<div class="gsearch-note">Some results come from an index that may be out of date. Scanning a folder again refreshes its index, unless it holds more than TreeMap indexes on its own${limit}.</div>`;
  }

  panel.innerHTML = html;
  panel.querySelectorAll('.gsearch-hit').forEach((btn) => {
    btn.addEventListener('click', () => gsearchGoTo(btn.dataset.path));
  });
  gsearchOpen();
}

/** Highlight the keyboard selection. */
function gsearchHighlight(delta) {
  const options = [...$('gsearchResults').querySelectorAll('.gsearch-hit')];
  if (!options.length) return;
  gsearch.selected = (gsearch.selected + delta + options.length) % options.length;
  options.forEach((el, i) => el.setAttribute('aria-selected', String(i === gsearch.selected)));
  options[gsearch.selected].scrollIntoView({ block: 'nearest' });
}

/**
 * Open a result: drill the treemap to the folder holding it and highlight the
 * file — the same click-through the Dashboard's top-10 already performs (§3.6),
 * so a search result behaves like every other path in the app.
 */
async function gsearchGoTo(targetPath) {
  const hit = gsearch.hits.find((h) => h.path === targetPath);
  if (!hit) return;
  gsearchClose();
  $('gsearch').blur();

  const folder = hit.type === 'dir' ? hit.path : hit.parentPath;

  // The treemap can only drill within the scan it currently holds: a hit
  // inside it by folder boundary (tmIsInside), so "/Users/me/Projects-old" is
  // not in "/Users/me/Projects", and a whole drive's scan holds every path on
  // it. A hit from a different indexed root needs that root scanned first —
  // and saying so beats silently doing nothing. The scan runs on its own;
  // drilled into now, the map would ask a scan that has not finished (POL
  // item 7 review, F2.9).
  if (!state.root || !(folder === state.root.path || tmIsInside(folder, state.root.path))) {
    // startScan refuses while a scan runs — the quiet refresh behind an
    // index-first paint included — so promising a scan of this folder, or
    // writing it into the path box, would both be untrue (POL item 7
    // review, F3.1).
    if (state.scanning) {
      toast(`A scan is already running, so “${hit.name}” in ${hit.rootPath} can’t be shown yet. Open the result again once that scan finishes.`, 'error');
      return;
    }
    toast(`“${hit.name}” is in ${hit.rootPath}, not the scan on screen — scanning that folder now. Open the result again when the scan finishes.`);
    $('pathInput').value = hit.rootPath;
    await startScan(hit.rootPath);
    return;
  }

  switchView('treemap');
  // loadTreemap roots the map once the folder has loaded; rooted here first,
  // a load that failed left the map at a folder it never drew.
  await loadTreemap(folder, true);
  // Reuse the existing highlight box so the file is visibly marked, rather
  // than adding a second highlighting mechanism.
  $('tmSearch').value = hit.name;
  tmApplyQuery(hit.name);
}

async function runGsearch(raw) {
  const q = raw.trim();
  if (!q) { gsearchClose(); return; }
  const seq = ++gsearch.seq;
  try {
    const result = await api('/api/search?q=' + encodeURIComponent(q) + '&limit=50');
    // A slower earlier request must not overwrite a newer answer.
    if (seq !== gsearch.seq) return;
    renderGsearch(result);
  } catch (e) {
    if (seq !== gsearch.seq) return;
    $('gsearchResults').innerHTML = `<div class="gsearch-note">${escapeHtml(e.message)}</div>`;
    gsearchOpen();
  }
}

$('gsearch').addEventListener('input', (e) => {
  clearTimeout(gsearch.timer);
  const value = e.target.value;
  // Debounced so a fast typist issues one query, not eight — the rate limiter
  // allows 10/s and the shared wrapper would otherwise be backing off.
  gsearch.timer = setTimeout(() => void runGsearch(value), 140);
});

$('gsearch').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); gsearchHighlight(1); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); gsearchHighlight(-1); return; }
  // One press, one meaning: let through, the page's own Escape also climbed
  // the map or closed the cart behind the box.
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); gsearchLeave(); return; }
  if (e.key === 'Enter') {
    const options = [...$('gsearchResults').querySelectorAll('.gsearch-hit')];
    const pick = options[gsearch.selected >= 0 ? gsearch.selected : 0];
    if (pick) { e.preventDefault(); void gsearchGoTo(pick.dataset.path); }
  }
});

$('gsearch').addEventListener('focus', (e) => {
  // Where focus came from, for Escape (D10). A move back from the box's own
  // results keeps what it came from before them.
  if (!(e.relatedTarget && $('gsearchWrap').contains(e.relatedTarget))) gsearch.cameFrom = e.relatedTarget || null;
  if (gsearch.hits.length) gsearchOpen();
});
// A result is a button Tab reaches from the box: Escape there leaves the search
// the way Escape in the box does. Only the box listened, so the key fell
// through to the page's own Escape — the map climbed a folder, the cart folded
// — with the results still open (review F2.7 of QA third pass D10).
$('gsearchResults').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault(); e.stopPropagation(); gsearchLeave();
});
// Tab out of the search — from the box or a result to anything outside it —
// closes the results, as a click elsewhere does. A move between the box and
// its results keeps them; focus going to no element on the page (another
// window) leaves them as they were.
$('gsearchWrap').addEventListener('focusout', (e) => {
  if (e.relatedTarget && !$('gsearchWrap').contains(e.relatedTarget)) gsearchClose();
});
document.addEventListener('click', (e) => {
  if (gsearch.open && !$('gsearchWrap').contains(e.target)) gsearchClose();
});

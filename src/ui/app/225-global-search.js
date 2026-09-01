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
};

function gsearchClose() {
  gsearch.open = false;
  gsearch.selected = -1;
  const panel = $('gsearchResults');
  panel.hidden = true;
  $('gsearch').setAttribute('aria-expanded', 'false');
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

function gsearchOpen() {
  gsearch.open = true;
  $('gsearchResults').hidden = false;
  $('gsearch').setAttribute('aria-expanded', 'true');
}

/** Render the panel: grouped by folder, largest first within each group. */
function renderGsearch(result) {
  const panel = $('gsearchResults');
  gsearch.hits = result.hits || [];
  gsearch.selected = -1;

  if (!gsearch.hits.length) {
    // Three different "nothing here" cases, and they mean different things —
    // collapsing them into one message is how a user concludes the feature is
    // broken when actually they simply haven't scanned anything yet.
    let note;
    if (!result.roots || result.roots.length === 0) {
      note = 'Nothing is indexed yet. Scan a folder once and it becomes searchable instantly from then on.';
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
    html += `<div class="gsearch-group">${escapeHtml(folder)}</div>`;
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
  // could name a file that has since moved (§A1's consistency guard).
  if (result.staleRoots && result.staleRoots.length) {
    html += `<div class="gsearch-note">Some results come from an index that may be out of date — scan again to refresh it.</div>`;
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

  // The treemap can only drill within the scan it currently holds. A hit from
  // a different indexed root needs that root loaded first — and saying so beats
  // silently doing nothing.
  if (!state.root || !(folder === state.root.path || folder.startsWith(state.root.path))) {
    toast(`“${hit.name}” is in ${hit.rootPath} — scanning that folder to show it.`);
    $('pathInput').value = hit.rootPath;
    await startScan(hit.rootPath);
  }

  switchView('treemap');
  state.treemap.rootPath = folder;
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
  if (e.key === 'Escape') { e.preventDefault(); gsearchClose(); e.target.blur(); return; }
  if (e.key === 'Enter') {
    const options = [...$('gsearchResults').querySelectorAll('.gsearch-hit')];
    const pick = options[gsearch.selected >= 0 ? gsearch.selected : 0];
    if (pick) { e.preventDefault(); void gsearchGoTo(pick.dataset.path); }
  }
});

$('gsearch').addEventListener('focus', () => { if (gsearch.hits.length) gsearchOpen(); });
document.addEventListener('click', (e) => {
  if (gsearch.open && !$('gsearchWrap').contains(e.target)) gsearchClose();
});

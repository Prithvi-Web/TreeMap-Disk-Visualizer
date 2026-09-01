/* ───────────────────────────── Clean Up modal ───────────────────────────── */
let cleanMatches = [];   // Custom Rules pane — matched file nodes
let emptyFolders = [];   // Empty Folders pane — { name, path }
let smartGroups = [];    // Smart Suggestions pane — rule groups from the API
/**
 * How the Smart Suggestions items are ordered (v4 §3.3).
 *
 * 'size' is the order the rules produce and the one people have learned to
 * read; 'reclaim' re-ranks within each group by the score. Not persisted: it
 * is a way of looking at one set of results, not a preference.
 */
let smartSort = 'size';

/**
 * One group's items in the active order, each paired with its index in
 * `g.items`.
 *
 * The pair is load-bearing, not tidiness. Every checkbox carries
 * `data-i`, and `updateCleanSummary` reads it back as
 * `smartGroups[g].items[i]` to decide what gets trashed. Rendering a
 * re-ordered list with positional indices would tick one row and delete a
 * different file.
 */
function smartItemsOf(g) {
  const pairs = g.items.map((it, i) => ({ it, i }));
  if (smartSort !== 'reclaim') return pairs;
  return pairs.sort(byReclaimDesc((p) => p.it.path));
}
let cleanPane = 'rules';

$('cleanupBtn').addEventListener('click', () => {
  if (!state.root) { toast('Run a scan first', 'error'); return; }
  $('cleanResults').innerHTML = '';
  $('smartResults').innerHTML = '';
  $('browserProfiles').innerHTML = '';
  $('emptyResults').innerHTML = '';
  $('cleanSummary').textContent = '';
  $('cleanConfirmBtn').disabled = true;
  $('cleanProgress').classList.remove('on');
  $('cleanProgressFill').style.width = '0%';
  cleanMatches = []; emptyFolders = []; smartGroups = [];
  cleanFunnelDrop(); // the standing funnel described the previous results
  setCleanRuleSource('simple'); // §4.5 — the pane opens where it always did
  setCleanPane('rules', true);
  $('cleanModal').classList.add('open');
  // Walks the whole tree server-side, so it runs on open rather than on every
  // scan completion. It also un-hides the Cloud-safe tab, which lives inside
  // this modal — so gating it on open costs no visible affordance.
  renderCloudSafe();
});

$('cleanSeg').querySelectorAll('button').forEach(b =>
  b.addEventListener('click', () => setCleanPane(b.dataset.pane)));

function setCleanPane(pane, skipLoad = false) {
  cleanPane = pane;
  $('cleanSeg').querySelectorAll('button').forEach(b =>
    b.setAttribute('aria-selected', String(b.dataset.pane === pane)));
  $('cleanPaneRules').style.display = pane === 'rules' ? '' : 'none';
  $('cleanPaneSmart').style.display = pane === 'smart' ? '' : 'none';
  $('cleanPaneEmpty').style.display = pane === 'empty' ? '' : 'none';
  $('cleanPaneVideo').style.display = pane === 'video' ? '' : 'none';
  $('cleanPaneCloud').style.display = pane === 'cloud' ? '' : 'none';
  updateCleanSummary();
  if (!skipLoad && pane === 'empty' && !emptyFolders.length) loadEmptyFolders();
  if (!skipLoad && pane === 'smart' && !smartGroups.length) loadSmartSuggestions();
  if (!skipLoad && pane === 'video' && !videoCandidates.length) loadVideoCandidates();
}

/* ── Shrink Video pane (§C2) ────────────────────────────────────────────────
   The only place TreeMap rewrites a file instead of moving it. The copy is
   deliberately blunt about the two things that matter: it is LOSSY, and the
   original goes to the Trash — but only after the new file has been checked. */
let videoCandidates = [];
let videoJobStream = null;

async function loadVideoCandidates() {
  const host = $('videoBody');
  if (!host || !state.scanId) return;
  host.innerHTML = skeletonRows(4, 34);
  let data;
  try { data = await api('/api/compression/candidates?scanId=' + state.scanId); }
  catch (e) { host.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`; return; }

  if (!data.available) {
    // §3.5 state 5 — unavailable, with the reason and the way to fix it.
    host.innerHTML = `<div class="muted" style="display:flex;align-items:flex-start;gap:8px;padding:10px 2px;">${icon('alert', 15)}
      <span>${escapeHtml(data.reason || 'Video re-encoding is not available on this system.')}</span></div>`;
    return;
  }
  videoCandidates = data.candidates || [];
  if (!videoCandidates.length) {
    host.innerHTML = `<div class="muted" style="display:flex;align-items:center;gap:8px;padding:10px 2px;">${icon('checkCircle', 15)}
      No video worth re-encoding — everything large is already in an efficient format.</div>`;
    return;
  }

  host.innerHTML =
    `<div class="vid-warn">${icon('alert', 15)}<span><b>Re-encoding is lossy.</b> The picture is compressed again, so a little
      quality is lost for good. TreeMap checks the new file opens and runs the full length before it touches anything, then the
      original goes to your <b>Trash</b> — recoverable until you empty it. Sizes below are <b>estimates</b>.</span></div>` +
    `<div class="vid-list">` + videoCandidates.map((c, i) => `
      <div class="clean-item">
        <input type="checkbox" class="vid-ck" data-i="${i}" aria-label="Select ${escapeHtml(c.name)}">
        ${chipFor({ type: 'file', extension: (c.name.split('.').pop() || '').toLowerCase() }, 13)}
        <div class="meta">
          <div class="nm">${escapeHtml(c.name)}</div>
          <div class="pth">${escapeHtml(c.path)}</div>
          <div class="vid-why">${escapeHtml(c.reason)}${c.width ? ` · ${c.width}×${c.height}` : ''}${
            c.durationSeconds ? ` · ${Math.round(c.durationSeconds / 60)} min` : ''}</div>
        </div>
        <span class="vid-ba num">${formatBytes(c.size)} → <b>~${formatBytes(c.estimatedBytes)}</b></span>
        <span class="size-badge num" style="color:${sizeColor(c.estimatedSaving)}">~${formatBytes(c.estimatedSaving)}</span>
      </div>`).join('') + `</div>
    <div class="vid-actions">
      <button class="btn" id="vidSelectAll">Select all</button>
      <button class="btn btn-danger" id="vidEncodeBtn" disabled>${icon('video', 14)} Re-encode</button>
      <span class="muted" id="vidSummary"></span>
    </div>
    <div class="vid-progress" id="vidProgress" hidden><div class="track"><div class="fill" id="vidFill"></div></div>
      <div class="vid-progtext" id="vidProgText"></div></div>`;

  const update = () => {
    const chosen = [...host.querySelectorAll('.vid-ck:checked')].map(ck => videoCandidates[+ck.dataset.i]);
    const saving = chosen.reduce((s, c) => s + c.estimatedSaving, 0);
    $('vidEncodeBtn').disabled = !chosen.length;
    $('vidSummary').textContent = chosen.length
      ? `${chosen.length} selected — around ${formatBytes(saving)} back, if the estimates hold`
      : '';
  };
  host.querySelectorAll('.vid-ck').forEach(ck => ck.addEventListener('change', update));
  $('vidSelectAll').addEventListener('click', () => {
    host.querySelectorAll('.vid-ck').forEach(ck => { ck.checked = true; });
    update();
  });
  $('vidEncodeBtn').addEventListener('click', () => confirmEncode(
    [...host.querySelectorAll('.vid-ck:checked')].map(ck => videoCandidates[+ck.dataset.i])));
  update();
}

function confirmEncode(chosen) {
  if (!chosen.length) return;
  const saving = chosen.reduce((s, c) => s + c.estimatedSaving, 0);
  $('confirmTitle').innerHTML = icon('video', 18) + 'Re-encode and replace?';
  $('confirmText').innerHTML =
    `Re-encode <b>${chosen.length}</b> video ${chosen.length === 1 ? 'file' : 'files'} to HEVC, freeing roughly <b>${formatBytes(saving)}</b>.<br>` +
    `<span style="color:var(--text-3)"><b>This is lossy</b> — the picture is compressed again and a little quality is lost permanently. ` +
    `Each new file is checked (it opens, and it runs the full length) <b>before</b> the original is moved to the Trash. ` +
    `If a check fails, that file is left exactly as it is. This can take a long time.</span>`;
  onConfirmTrash = () => startEncode(chosen.map(c => c.path));
  $('confirmModal').classList.add('open');
}

async function startEncode(paths) {
  let job;
  try {
    job = await api('/api/compression/encode', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, confirm: true }),
    });
  } catch (e) { toast('Could not start: ' + e.message, 'error'); return; }

  $('vidProgress').hidden = false;
  $('vidEncodeBtn').disabled = true;
  if (videoJobStream) videoJobStream.close();
  videoJobStream = new EventSource(`/api/compression/${job.jobId}/progress`);
  videoJobStream.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.type === 'progress') {
      const overall = d.total ? (d.done + (d.currentFraction || 0)) / d.total : 0;
      $('vidFill').style.width = Math.round(overall * 100) + '%';
      $('vidProgText').textContent = d.currentPath
        ? `${d.done} of ${d.total} done — working on ${baseName(d.currentPath)}`
        : `${d.done} of ${d.total} done`;
    } else if (d.type === 'complete') {
      videoJobStream.close(); videoJobStream = null;
      const ok = (d.results || []).filter(r => r.ok).length;
      const failed = (d.results || []).filter(r => !r.ok);
      $('vidFill').style.width = '100%';
      $('vidProgText').innerHTML = `${ok} re-encoded, ${formatBytes(d.savedBytes || 0)} recovered.` +
        (failed.length ? `<div class="vid-failed">${failed.map(f =>
          `<div>${escapeHtml(baseName(f.path))}: ${escapeHtml(f.error || 'failed')}</div>`).join('')}</div>` : '');
      toast(`Re-encoded ${ok} file${ok === 1 ? '' : 's'} — ${formatBytes(d.savedBytes || 0)} recovered`);
      rescan();
    }
  };
  videoJobStream.onerror = () => {
    if (videoJobStream) { videoJobStream.close(); videoJobStream = null; }
    $('vidProgText').textContent = 'Lost contact with the encoder — check the Trash and the folder before retrying.';
  };
}

/* ── Empty Folders pane ── */
async function loadEmptyFolders() {
  const host = $('emptyResults');
  host.innerHTML = skeletonRows(4, 30);
  try {
    const data = await api(`/api/empty-folders?scanId=${state.scanId}&ignoreJunk=${$('emptyIgnoreJunk').checked}`);
    emptyFolders = data.folders;
    if (!emptyFolders.length) {
      host.innerHTML = `<div class="muted" style="display:flex;align-items:center;gap:8px;padding:12px 2px;">${icon('checkCircle', 15)} No empty folders found — tidy already.</div>`;
      updateCleanSummary();
      return;
    }
    // The route caps `folders` at the topmost 1,000 and reports what it really
    // found in `totalCount`, with `truncated` saying the cap was hit. Printing
    // the list's length as the count states a cap as a fact, and Select all can
    // only ever tick what was sent — so on a capped list the row says both
    // numbers and which one the tick covers, the way the rules pane says
    // "largest shown". Untruncated, the list IS the count and the row is
    // unchanged.
    const shown = emptyFolders.length;
    const selectAllLabel = data.truncated
      ? `Select all — the top ${formatCount(shown)} shown of ${formatCount(data.totalCount)} empty folders found, nested ones included. Select all reaches only these ${formatCount(shown)} — trash them and rescan for the rest.`
      : `Select all — ${shown} top-level empty folder${shown > 1 ? 's' : ''}${data.totalCount > shown ? ` (${formatCount(data.totalCount)} counting nested ones)` : ''}`;
    host.innerHTML = `
      <div class="rule-row">
        <input type="checkbox" id="emptyAll" checked>
        <label for="emptyAll" class="muted">${selectAllLabel}</label>
      </div>
      <div class="clean-list">` + emptyFolders.map((f, i) => `
        <div class="clean-item">
          <input type="checkbox" class="empty-ck" data-i="${i}" checked aria-label="Select ${escapeHtml(f.name)}">
          ${chipFor({ type: 'dir' }, 13)}
          <div class="meta">
            <div class="nm">${escapeHtml(f.name)}</div>
            <div class="pth">${escapeHtml(f.path)}</div>
          </div>
          <button class="icon-btn" data-cart-add="${escapeHtml(f.path)}" aria-label="Add ${escapeHtml(f.name)} to cleanup cart">${icon('plus', 13)}</button>
        </div>`).join('') + '</div>';
    // v4 §4.2 — these are stageable one at a time, so their staged state has
    // to be reflected the moment the list is rebuilt.
    refreshCartButtons();
    updateCleanSummary();
  } catch (e) {
    host.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
  }
}
$('emptyIgnoreJunk').addEventListener('change', () => { emptyFolders = []; loadEmptyFolders(); });
/* Delegated once: this list is the app's longest (structural empties run to
   the thousands), so per-row listeners made every rebuild a stutter. */
$('emptyResults').addEventListener('change', (e) => {
  if (e.target.id === 'emptyAll') {
    $('emptyResults').querySelectorAll('.empty-ck').forEach(ck => { ck.checked = e.target.checked; });
    updateCleanSummary();
    return;
  }
  if (e.target.classList.contains('empty-ck')) updateCleanSummary();
});

/* ── Smart Suggestions pane ── */
/* Feature 13 — git repositories section + git gc. */
async function renderGitRepos() {
  const host = $('gitRepos');
  if (!host || !state.scanId) return;
  let repos = [];
  try { ({ repos } = await api('/api/git/repos?scanId=' + state.scanId)); } catch { return; }
  const notable = (repos || []).filter((r) => r.totalBytes > 1048576);
  if (!notable.length) { host.innerHTML = ''; return; }
  host.innerHTML = `<div style="margin-bottom:16px;">
    <div class="rule-row" style="padding:6px 0;"><b style="display:inline-flex;align-items:center;gap:7px;">${icon('gitBranch', 15)}Git repositories</b><span class="muted" style="flex:1;margin-left:8px;">pack &amp; loose-object breakdown — run gc to compact</span></div>
    <div class="clean-list">` + notable.map((r) => {
      const name = r.repoPath.split(/[\\/]/).pop() || r.repoPath;
      return `<div class="clean-item">
        <div class="meta"><div class="nm">${escapeHtml(name)}</div><div class="pth">${escapeHtml(r.repoPath)}</div></div>
        <span class="git-bd num">pack ${formatBytes(r.packBytes)} · loose ${formatBytes(r.looseObjectBytes)}${r.lfsBytes ? ` · LFS ${formatBytes(r.lfsBytes)}` : ''}</span>
        <span class="size-badge num">${formatBytes(r.totalBytes)}</span>
        ${r.canGC ? `<button class="pill" data-gc="${escapeHtml(r.repoPath)}">Run git gc</button>` : ''}
      </div>`;
    }).join('') + `</div></div>`;
}
async function runGitGcAction(repo) {
  toast('Running git gc…');
  try {
    const r = await api('/api/git/gc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: repo, confirm: true }) });
    if (r.ok) toast('git gc complete'); else toast('git gc failed: ' + (r.error || 'unknown'), 'error');
  } catch (e) { toast('git gc failed: ' + e.message, 'error'); }
  renderGitRepos();
}
document.addEventListener('click', (e) => {
  const gc = e.target.closest('[data-gc]');
  if (!gc) return;
  const repo = gc.getAttribute('data-gc');
  const name = repo.split(/[\\/]/).pop() || repo;
  $('confirmTitle').innerHTML = icon('gitBranch', 18) + 'Run git gc?';
  $('confirmText').innerHTML = `Run <b>git gc --aggressive</b> on <b>${escapeHtml(name)}</b>?<br><span style="color:var(--text-3)">Safe — it compacts the repo without changing any commits. Large repos can take a while.</span>`;
  onConfirmTrash = () => runGitGcAction(repo);
  $('confirmModal').classList.add('open');
});

/* ── Package-manager orphans (§C6) ──────────────────────────────────────────
   Grouped by ecosystem, and wired into the SAME selection the rest of the
   Clean Up modal uses — this is not a fourth delete surface. Orphans and
   caches get checkboxes; active artifacts are context only (Smart Suggestions
   below already offers those, and this panel exists for the things nobody is
   going to miss). */
const ECOSYSTEM_LABEL = {
  npm: 'npm', yarn: 'Yarn', pnpm: 'pnpm', python: 'Python', cargo: 'Rust / Cargo',
  maven: 'Maven', gradle: 'Gradle', cocoapods: 'CocoaPods', homebrew: 'Homebrew',
  nuget: 'NuGet', chocolatey: 'Chocolatey', winget: 'winget', apt: 'apt / dpkg',
};
function ecosystemLabel(id) { return ECOSYSTEM_LABEL[id] || id; }

let packageOrphans = [];

/** Render the ecosystem panel. Returns true if anything was shown. */
async function renderPackageOrphans() {
  const host = $('packageOrphans');
  if (!host || !state.scanId) return false;
  packageOrphans = [];
  let data;
  try { data = await api('/api/packages/orphans?scanId=' + state.scanId); } catch { host.innerHTML = ''; return false; }
  if (data.available === false) {
    // Same honesty rule as Smart Suggestions: a broken catalog is "unknown",
    // never "you have no leftovers".
    host.innerHTML = `<div class="muted" style="display:flex;align-items:flex-start;gap:8px;padding:10px 2px;">${icon('alert', 15)}
      <span>Package leftovers could not be checked — a cleanup rule pack failed to load.<br>
      <span class="smart-why-line">${escapeHtml(data.reason || 'No reason was given.')}</span></span></div>`;
    return false;
  }
  const groups = (data.ecosystems || []).filter(g => g.orphanCount || g.cacheCount || g.activeCount);
  if (!groups.length) { host.innerHTML = ''; return false; }

  // Flat index so a checkbox can name its entry without re-encoding the path.
  groups.forEach(g => g.entries.forEach(e => { e._i = packageOrphans.push(e) - 1; }));

  const reclaimable = data.orphanBytes + data.cacheBytes;
  host.innerHTML = `<div style="margin-bottom:16px;">
    <div class="rule-row" style="padding:6px 0;">
      <b style="display:inline-flex;align-items:center;gap:7px;">${icon('box', 15)}Package leftovers</b>
      <span class="muted" style="flex:1;margin-left:8px;">${data.orphanCount
        ? `${formatCount(data.orphanCount)} orphaned — nothing will rebuild ${data.orphanCount === 1 ? 'it' : 'them'}`
        : 'no orphans; shared caches only'}</span>
      <span class="size-badge num" style="color:${sizeColor(reclaimable)}">${formatBytes(reclaimable)}</span>
    </div>` + groups.map(g => {
      const head = [
        g.orphanCount ? `${formatCount(g.orphanCount)} orphaned · ${formatBytes(g.orphanBytes)}` : '',
        g.cacheCount ? `cache ${formatBytes(g.cacheBytes)}` : '',
        g.activeCount ? `${formatCount(g.activeCount)} in use` : '',
      ].filter(Boolean).join(' · ');
      return `<div class="pkg-eco">
      <div class="pkg-echead"><b>${escapeHtml(ecosystemLabel(g.ecosystem))}</b><span class="muted num">${escapeHtml(head)}</span></div>
      <div class="clean-list">` + g.entries.map(e => {
        const selectable = e.kind !== 'active' && !e.advisory;
        const project = e.projectName
          ? `<span class="pkg-proj">${escapeHtml(e.projectName)}</span>`
          : '<span class="pkg-proj none">no owning project</span>';
        return `<div class="clean-item pkg-item kind-${e.kind}">
          ${selectable
            ? `<input type="checkbox" class="pkg-ck" data-i="${e._i}" aria-label="Select ${escapeHtml(e.path)}">`
            : `<span class="adv-spacer" title="${e.advisory ? 'Not safe to trash' : 'In use — kept'}"></span>`}
          <span class="pkg-tag ${e.kind}">${e.kind === 'orphan' ? 'orphaned' : e.kind === 'cache' ? 'cache' : 'in use'}</span>
          <div class="meta">
            <div class="nm">${escapeHtml(e.name)} ${project}</div>
            <div class="pth">${escapeHtml(e.path)}</div>
            <div class="pkg-why">${escapeHtml(e.reason)}${e.command ? ` · <code>${escapeHtml(e.command)}</code> ${e.kind === 'cache' ? 'to clear' : 'to restore'}` : ''}</div>
          </div>
          <span class="dt num">${formatDate(e.modifiedAt)}</span>
          <span class="size-badge num">${formatBytes(e.size)}</span>
          ${selectable ? `<button class="icon-btn" data-cart-add="${escapeHtml(e.path)}" aria-label="Add ${escapeHtml(e.name)} to cleanup cart">${icon('plus', 13)}</button>` : ''}
        </div>`;
      }).join('') + `</div></div>`;
    }).join('') + `</div>`;

  host.querySelectorAll('.pkg-ck').forEach(ck => ck.addEventListener('change', updateCleanSummary));
  refreshCartButtons();
  return true;
}

/* ── Browser profile drill-down (Feature 16) — inline-SVG favicons, no external fetch ── */
const BROWSER_FAV = {
  Chrome: `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="#fff"/>` +
    `<path d="M24 2a22 22 0 0 1 19.05 11H24a11 11 0 0 0-9.74 5.86L6.2 13.2A22 22 0 0 1 24 2Z" fill="#ea4335"/>` +
    `<path d="M43.05 13A22 22 0 0 1 33.5 43.2L24.8 28.2A11 11 0 0 0 24 13Z" fill="#fbbc05"/>` +
    `<path d="M33.5 43.2A22 22 0 0 1 6.2 13.2l8.06 14.66A11 11 0 0 0 24 35Z" fill="#34a853"/>` +
    `<circle cx="24" cy="24" r="9.4" fill="#fff"/><circle cx="24" cy="24" r="7.2" fill="#4285f4"/></svg>`,
  Chromium: `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="#fff"/>` +
    `<path d="M24 2a22 22 0 0 1 19.05 11H24a11 11 0 0 0-9.74 5.86L6.2 13.2A22 22 0 0 1 24 2Z" fill="#9aa0a6"/>` +
    `<path d="M43.05 13A22 22 0 0 1 33.5 43.2L24.8 28.2A11 11 0 0 0 24 13Z" fill="#5f6368"/>` +
    `<path d="M33.5 43.2A22 22 0 0 1 6.2 13.2l8.06 14.66A11 11 0 0 0 24 35Z" fill="#80868b"/>` +
    `<circle cx="24" cy="24" r="9.4" fill="#fff"/><circle cx="24" cy="24" r="7.2" fill="#4285f4"/></svg>`,
  Edge: `<svg viewBox="0 0 48 48" aria-hidden="true"><defs>` +
    `<linearGradient id="bpEdge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#37bdf2"/><stop offset="1" stop-color="#0a5cb8"/></linearGradient></defs>` +
    `<circle cx="24" cy="24" r="22" fill="url(#bpEdge)"/>` +
    `<path d="M12 31c1-9 9-16 19-14 5 1 8 5 8 9 0-10-8-17-17-17S5 16 5 25c0 6 3 11 8 13-2-2-3-4-1-7Z" fill="#fff" opacity="0.9"/></svg>`,
  Brave: `<svg viewBox="0 0 48 48" aria-hidden="true">` +
    `<path d="M24 3 39 9l2 7 3 4-3 9c-2 7-9 12-17 15-8-3-15-8-17-15l-3-9 3-4 2-7Z" fill="#fb542b"/>` +
    `<path d="M24 14l6 5-3 9-3 3-3-3-3-9Z" fill="#fff" opacity="0.92"/></svg>`,
  Firefox: `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="25" r="20" fill="#ff7139"/>` +
    `<path d="M41 17c1 4 1 8-1 12-3 7-10 12-17 11-7-1-13-8-13-15 0-5 3-9 7-11-2 4 0 9 4 10-4-5-2-12 3-15-1 4 2 7 6 7-3-4 0-10 4-11 4-1 8 1 10 5l-3-2c2 2 3 5 4 7l-1 1c1 1 2 3 2 4Z" fill="#ffb340"/>` +
    `<path d="M38 21c2 5 1 11-3 15-4 4-10 5-15 3 7 1 13-3 15-9 1-3 2-6 3-9Z" fill="#fd3e1a" opacity="0.55"/></svg>`,
  Safari: `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="#19a0f4"/>` +
    `<circle cx="24" cy="24" r="18" fill="#f1f5f9"/>` +
    `<path d="M24 24 33 15 27 27Z" fill="#ff3b30"/><path d="M24 24 15 33 21 21Z" fill="#c2c8d0"/>` +
    `<circle cx="24" cy="24" r="2" fill="#5a6470"/></svg>`,
};
function browserFav(name) { return BROWSER_FAV[name] || BROWSER_FAV.Chromium; }

/** Render the per-profile browser cache accordions; returns true if any were shown. */
async function renderBrowserProfiles() {
  const host = $('browserProfiles');
  if (!host || !state.scanId) return false;
  let profiles = [];
  try { ({ profiles } = await api('/api/cleanup/browser-profiles?scanId=' + state.scanId)); }
  catch { host.innerHTML = ''; return false; }
  if (!profiles.length) { host.innerHTML = ''; return false; }
  const total = profiles.reduce((s, p) => s + p.totalBytes, 0);
  host.innerHTML = `<div class="bp-section-h"><b>${icon('globe', 15)}Browser caches</b>` +
    `<span class="muted" style="flex:1;margin-left:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${profiles.length} profile${profiles.length > 1 ? 's' : ''} · ${formatBytes(total)} — expand to pick what to clear</span></div>` +
    profiles.map((p, pi) => {
      const items = p.items.map((it) => `
        <div class="bp-item">
          <input type="checkbox" class="bp-ck" data-path="${escapeHtml(it.path)}" data-bytes="${it.bytes}" data-p="${pi}" aria-label="Select ${escapeHtml(it.label)}">
          <span class="lbl">${escapeHtml(it.label)}</span>
          <span class="size-badge num" style="color:${sizeColor(it.bytes)}">${formatBytes(it.bytes)}</span>
          <button class="icon-btn" data-cart-add="${escapeHtml(it.path)}" aria-label="Add ${escapeHtml(it.label)} to cleanup cart">${icon('plus', 13)}</button>
        </div>`).join('');
      return `<div class="bp-acc" data-acc="${pi}">
        <div class="bp-head" role="button" tabindex="0" aria-expanded="false">
          <input type="checkbox" class="bp-all" data-p="${pi}" aria-label="Select all caches for ${escapeHtml(p.browser)} ${escapeHtml(p.profile)}">
          <span class="bp-fav">${browserFav(p.browser)}</span>
          <span class="bp-title">${escapeHtml(p.browser)}<span class="prof">${escapeHtml(p.profile)}</span></span>
          <span class="spacer"></span>
          <span class="size-badge num">${p.items.length} · ${formatBytes(p.totalBytes)}</span>
          <span class="chev">${icon('chevronRight', 14)}</span>
        </div>
        <div class="bp-items">${items}</div>
      </div>`;
    }).join('');

  host.querySelectorAll('.bp-head').forEach(head => {
    const toggle = () => { const a = head.closest('.bp-acc'); head.setAttribute('aria-expanded', String(a.classList.toggle('open'))); };
    head.addEventListener('click', (e) => { if (e.target.closest('input,button')) return; toggle(); });
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
  host.querySelectorAll('.bp-all').forEach(all => all.addEventListener('change', () => {
    host.querySelectorAll(`.bp-ck[data-p="${all.dataset.p}"]`).forEach(ck => { ck.checked = all.checked; });
    all.indeterminate = false;
    updateCleanSummary();
  }));
  host.querySelectorAll('.bp-ck').forEach(ck => ck.addEventListener('change', () => {
    const p = ck.dataset.p;
    const all = host.querySelector(`.bp-all[data-p="${p}"]`);
    const cks = [...host.querySelectorAll(`.bp-ck[data-p="${p}"]`)];
    if (all) { all.checked = cks.every(c => c.checked); all.indeterminate = !all.checked && cks.some(c => c.checked); }
    updateCleanSummary();
  }));
  refreshCartButtons();
  return true;
}

/**
 * Confidence in words. "high" alone tells a non-coder nothing useful — and for
 * an advisory group it means "we are sure this is what it is", NOT "safe to
 * delete", which is the opposite of what that group is telling you.
 */
function confidenceWording(level, advisory) {
  if (advisory) {
    if (level === 'high') return 'High — this is certainly the thing named above.';
    if (level === 'medium') return 'Medium — this is very likely the thing named above.';
    if (level === 'low') return 'Low — this may not be what the rule expects. Check before acting.';
    return 'Not stated by the rule.';
  }
  if (level === 'high') return 'High — this is a well-known, safely reclaimable location.';
  if (level === 'medium') return 'Medium — usually reclaimable, but worth a glance at the paths below.';
  if (level === 'low') return 'Low — check each item before removing it.';
  return 'Not stated by the rule.';
}

/** Provenance for the catalog, so a stale rule set is visible as stale (§C8). */
function catalogNote(catalog) {
  if (!catalog || !Array.isArray(catalog.packs) || !catalog.packs.length) return '';
  const names = catalog.packs.map(p => p.name).join(' + ');
  const updated = catalog.packs.map(p => p.updated).sort().pop();
  const rules = catalog.packs.reduce((s, p) => s + p.ruleCount, 0);
  return ` <span class="smart-catalog">Rule packs: ${escapeHtml(names)} · ${rules} rules · updated ${escapeHtml(updated)}</span>`;
}

/**
 * Paint the Smart Suggestions groups.
 *
 * Extracted from `loadSmartSuggestions` so the Reclaim ordering can repaint
 * without re-fetching: the groups are already in `smartGroups`, and asking
 * the server for them again to change a sort order would be a round trip to
 * learn nothing new.
 */
function renderSmartGroups(catalog) {
  const host = $('smartResults');
  const catLabel = { regenerable: 'Regenerables', cache: 'Caches', junk: 'Junk' };
  const present = ['regenerable', 'cache', 'junk'].filter(c => smartGroups.some(g => g.category === c));
  const filterPills = present.length > 1
    ? `<div class="smart-filters" role="tablist" aria-label="Filter suggestions by type">
        <button class="pill active" data-cat="all">All</button>` +
        present.map(c => `<button class="pill" data-cat="${c}">${catLabel[c]}</button>`).join('') + `</div>`
    : '';
  // v4 §3.3 — every rule here already says a thing is safe to remove. The
  // score answers the next question: which of them is most worth removing.
  // A toggle rather than a default, because the rule order is what people
  // have learned to read.
  const sortPills = `<div class="smart-filters" role="group" aria-label="Order suggestions">
    <button class="pill${smartSort === 'size' ? ' active' : ''}" data-smartsort="size">Biggest first</button>
    <button class="pill${smartSort === 'reclaim' ? ' active' : ''}" data-smartsort="reclaim">Safest to reclaim first</button>
  </div>`;
  host.innerHTML = `<div class="muted" style="margin-bottom:8px;">Found by ${smartGroups.length} rule${smartGroups.length > 1 ? 's' : ''} — nothing is pre-selected, tick what you want gone.${catalogNote(catalog)}</div>` +
    filterPills + sortPills +
    smartGroups.map((g, gi) => {
      // An advisory group is shown for its size, never offered for deletion:
      // the file IS the data (a VM disk), or the OS owns it. It gets no
      // checkboxes at all, and names the supported way to reclaim it instead.
      const adv = !!g.advisory;
      return `
    <div class="smart-group cat-${g.category}${adv ? ' advisory' : ''}" data-cat="${g.category}">
      <div class="rule-row">
        ${adv
          ? `<span class="adv-mark" title="TreeMap will not offer to move this to the Trash" aria-label="Not safe to trash">${icon('alert', 14)}</span>`
          : `<input type="checkbox" class="smart-all" data-g="${gi}" aria-label="Select all in ${escapeHtml(g.title)}">`}
        <b>${escapeHtml(g.title)}</b>
        <span class="smart-desc">${escapeHtml(g.description)}</span>
        ${g.regenerateCmd ? `<code class="regen-cmd" title="Restore with: ${escapeHtml(g.regenerateCmd)}">${escapeHtml(g.regenerateCmd)}</code><span class="rc-lbl">to restore</span>` : ''}
        ${adv && g.adviceCommand ? `<code class="regen-cmd" title="Reclaim with: ${escapeHtml(g.adviceCommand)}">${escapeHtml(g.adviceCommand)}</code><span class="rc-lbl">to reclaim</span>` : ''}
        <button class="icon-btn why-btn" data-why="${gi}" aria-expanded="false" aria-controls="smartWhy${gi}"
          title="Why is this suggested?" aria-label="Why is ${escapeHtml(g.title)} suggested?">${icon('help', 13)}</button>
        <span class="size-badge num" style="color:${sizeColor(g.totalSize)}">${g.items.length} · ${formatBytes(g.totalSize)}</span>
      </div>
      <div class="smart-why" id="smartWhy${gi}" hidden>
        <div class="smart-why-line"><b>What matched:</b> ${escapeHtml(g.why || 'This rule did not record what it matches.')}</div>
        <div class="smart-why-line"><b>Confidence:</b> ${escapeHtml(confidenceWording(g.confidence, adv))}</div>
        <div class="smart-why-line"><b>${adv ? 'What this is' : 'Why it is safe'}:</b> ${escapeHtml(g.description)}</div>
        ${g.regenerateCmd ? `<div class="smart-why-line"><b>Put it back with:</b> <code>${escapeHtml(g.regenerateCmd)}</code></div>` : ''}
        ${adv ? `<div class="smart-why-line"><b>Do not move this to the Trash.</b>${g.adviceCommand ? ` Reclaim it instead: <code>${escapeHtml(g.adviceCommand)}</code>` : ''}</div>` : ''}
      </div>
      <div class="clean-list">` + smartItemsOf(g).map(({ it, i }) => `
        <div class="clean-item">
          ${adv ? '<span class="adv-spacer"></span>' : `<input type="checkbox" class="smart-ck" data-g="${gi}" data-i="${i}" aria-label="Select ${escapeHtml(it.path)}">`}
          ${chipFor({ type: it.type, extension: it.type === 'file' ? (it.name.split('.').pop() || '').toLowerCase() : undefined }, 13)}
          <div class="meta">
            <div class="nm">${escapeHtml(it.name)}</div>
            <div class="pth">${escapeHtml(it.path)}</div>
          </div>
          <span class="dt num">${formatDate(it.modifiedAt)}</span>
          ${reclaimBadge(it.path, scoreFor(it.path))}
          <span class="size-badge num">${formatBytes(it.size)}</span>
          ${adv ? '' : `<button class="icon-btn" data-cart-add="${escapeHtml(it.path)}" aria-label="Add ${escapeHtml(it.name)} to cleanup cart">${icon('plus', 13)}</button>`}
        </div>`).join('') + `</div>
    </div>`;
    }).join('');
  host.querySelectorAll('.why-btn').forEach(b => b.addEventListener('click', () => {
    const panel = $(`smartWhy${b.dataset.why}`);
    const open = panel.hidden;
    panel.hidden = !open;
    b.setAttribute('aria-expanded', String(open));
    b.classList.toggle('on', open);
  }));
  host.querySelectorAll('.smart-all').forEach(all => all.addEventListener('change', () => {
    host.querySelectorAll(`.smart-ck[data-g="${all.dataset.g}"]`).forEach(ck => { ck.checked = all.checked; });
    updateCleanSummary();
  }));
  host.querySelectorAll('.smart-ck').forEach(ck => ck.addEventListener('change', updateCleanSummary));
  host.querySelectorAll('[data-smartsort]').forEach(p => p.addEventListener('click', () => {
    smartSort = p.dataset.smartsort === 'reclaim' ? 'reclaim' : 'size';
    if (smartSort !== 'reclaim') { renderSmartGroups(catalog); return; }
    // Score what is on screen, then repaint once. Bounded by the fact
    // route's own per-request cap: the suggestion list can run to
    // thousands of items across rules, and the count of what was not
    // scored is stated rather than left to be inferred from a gap.
    const paths = [];
    for (const g of smartGroups) for (const it of g.items) if (paths.length < RECLAIM_BATCH) paths.push(it.path);
    if (paths.length) toast('Working out reclaim scores…', 'success', 2000);
    void ensureScores(paths, () => renderSmartGroups(catalog));
    renderSmartGroups(catalog);
  }));
  host.querySelectorAll('.smart-filters .pill[data-cat]').forEach(p => p.addEventListener('click', () => {
    const cat = p.dataset.cat;
    // Scoped to [data-cat]: the Reclaim ordering lives in a second
    // .smart-filters row, and an unscoped selector cleared its active state
    // every time someone picked a category.
    host.querySelectorAll('.smart-filters .pill[data-cat]').forEach(x => x.classList.toggle('active', x === p));
    host.querySelectorAll('.smart-group').forEach(g => {
      g.style.display = (cat === 'all' || g.dataset.cat === cat) ? '' : 'none';
    });
  }));
  refreshCartButtons();
  updateCleanSummary();
}

async function loadSmartSuggestions() {
  renderGitRepos();
  const hadPackages = await renderPackageOrphans();
  const hadBrowsers = await renderBrowserProfiles();
  const host = $('smartResults');
  host.innerHTML = skeletonRows(4, 34);
  try {
    const data = await api(`/api/cleanup/suggestions?scanId=${state.scanId}`);
    // §C8/§6: a malformed rule pack breaks this panel only, and says why —
    // never a blank "nothing to clean up", which would read as good news.
    if (data.available === false) {
      smartGroups = [];
      host.innerHTML = `<div class="muted" style="display:flex;align-items:flex-start;gap:8px;padding:12px 2px;">${icon('alert', 15)}
        <span>Smart Suggestions are unavailable because a cleanup rule pack could not be loaded.<br>
        <span class="smart-why-line">${escapeHtml(data.reason || 'No reason was given.')}</span></span></div>`;
      updateCleanSummary();
      return;
    }
    smartGroups = data.groups;
    // §9.5 honesty (QA finding 8): folders paused by a note are excluded
    // server-side, and an absence with no stated cause reads as good news.
    // One line, only when a pausing note actually exists.
    const pausedNotes = [...state.notes.values()].filter((n) => n.suppress).length;
    const noteHint = pausedNotes
      ? `<div class="muted" style="font-size:11.5px;padding:2px 2px 8px;">${icon('doc', 13)} ${pausedNotes === 1 ? 'One folder is' : `${pausedNotes} folders are`} excluded by a note that pauses suggestions — edit the note to include ${pausedNotes === 1 ? 'it' : 'them'} again.</div>`
      : '';
    if (!smartGroups.length) {
      host.innerHTML = ((hadBrowsers || hadPackages) ? ''
        : `<div class="muted" style="display:flex;align-items:center;gap:8px;padding:12px 2px;">${icon('checkCircle', 15)} Nothing in this scan matches the common-junk rules.</div>`)
        + noteHint;
      updateCleanSummary();
      return;
    }
    renderSmartGroups(data.catalog);
    if (noteHint) host.insertAdjacentHTML('beforeend', noteHint);
  } catch (e) {
    host.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
  }
}

/* ── Phase 4 (v4 §4.5) — query → rule → policy ────────────────────────────
   The pivot the query grammar was built for. A saved view is already a query;
   this makes it a Clean Up rule, and the button beside it makes that rule an
   Autopilot policy — with **every existing rail unchanged**.

   The rails are worth naming, because §4.5 is explicit that none of them may
   be weakened, bypassed or special-cased for this path: the first run of any
   new policy is always a preview a human approves; per-run and rolling-weekly
   byte caps; a cooldown; "ask me first above N GB"; and the Time Capsule on
   everything. Promotion opens the *existing* editor pre-filled and saves
   through the *existing* endpoint, so it inherits all of them by construction
   rather than by remembering to re-apply them. `tests/queryToPolicy.test.ts`
   asserts each one field by field on a promoted policy.

   The matching engine is shared too: a saved view runs through POST /api/query
   here, exactly as it does in the treemap box, and a promoted policy runs the
   same AST through the same evaluator server-side. §7 forbids a second query
   language, and three near-copies of one is how a project ends up with one. */

/** 'simple' — the age/size/ext knobs; 'query' — a saved view. */
let cleanRuleSource = 'simple';

function setCleanRuleSource(src) {
  cleanRuleSource = src === 'query' ? 'query' : 'simple';
  $('cleanRuleSeg').querySelectorAll('button').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.rulesrc === cleanRuleSource)));
  $('cleanRuleSimple').style.display = cleanRuleSource === 'simple' ? '' : 'none';
  $('cleanRuleQuery').style.display = cleanRuleSource === 'query' ? '' : 'none';
  if (cleanRuleSource === 'query') void fillCleanSavedViews();
}

$('cleanRuleSeg').querySelectorAll('button').forEach((b) =>
  b.addEventListener('click', () => setCleanRuleSource(b.dataset.rulesrc)));

/** Populate the picker from the saved views, and show the query it stands for. */
async function fillCleanSavedViews() {
  await loadSavedViews();
  const sel = $('cleanSavedView');
  const views = state.savedViews || [];
  if (!views.length) {
    sel.innerHTML = '<option value="">No saved views yet</option>';
    $('cleanSavedViewQ').textContent = 'Save one from the treemap search box first — type a query, then press Save view.';
    return;
  }
  const keep = sel.value;
  sel.innerHTML = views.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name)}</option>`).join('');
  if (keep && views.some((v) => v.id === keep)) sel.value = keep;
  showCleanSavedViewQuery();
}

function selectedSavedView() {
  return (state.savedViews || []).find((v) => v.id === $('cleanSavedView').value) || null;
}

function showCleanSavedViewQuery() {
  const view = selectedSavedView();
  // textContent, not innerHTML: a saved view's name and query are user text.
  $('cleanSavedViewQ').textContent = view ? view.q : '';
}
$('cleanSavedView').addEventListener('change', showCleanSavedViewQuery);

/**
 * Promote whatever rule is showing into an Autopilot policy (§4.5).
 *
 * Opens the existing editor pre-filled and nothing more. It does not save, it
 * does not enable, and it does not approve — the policy that comes out the
 * other side still has to be previewed and approved by a person before it can
 * delete anything, exactly like one typed from scratch.
 */
function promoteRuleToPolicy() {
  if (!state.root) { toast('Scan a folder first — a policy needs somewhere to work', 'error'); return; }
  let match;
  let name;
  if (cleanRuleSource === 'query') {
    const view = selectedSavedView();
    if (!view) { toast('Pick a saved view first', 'error'); return; }
    match = { kind: 'query', q: view.q };
    name = view.name;
  } else {
    const ageOn = $('ruleAgeOn').checked, sizeOn = $('ruleSizeOn').checked, extOn = $('ruleExtOn').checked;
    const exts = $('ruleExts').value.split(',').map((x) => x.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
    if (!ageOn && !sizeOn && !(extOn && exts.length)) {
      // The duplicate rule has no policy equivalent — matchCustomRules' `dup`
      // flag is not part of AutopilotMatch — so saying so is better than
      // silently promoting a rule that means something different.
      toast('Set an age, size or extension rule first — the duplicates-only rule cannot run unattended', 'error', 8000);
      return;
    }
    match = { kind: 'custom' };
    if (ageOn) match.maxAgeMs = Math.max(1, Number($('ruleAgeDays').value) || 180) * 86400000;
    if (sizeOn) match.minBytes = Math.max(1, Number($('ruleSizeMb').value) || 100) * 1048576;
    if (extOn && exts.length) match.exts = exts;
    name = 'Clean Up rule';
  }
  closeModal('cleanModal');
  openPolicyEditor({
    name,
    // The folder currently in view, which is the one the rule was just run
    // against. Still editable in the dialog — and normalizePolicy refuses the
    // root of the disk outright, whatever is passed here.
    path: state.treemap.rootPath || state.root.path,
    match,
    maxBytesPerRun: null, maxBytesPerWeek: null, requireConfirmationAbove: null,
    cooldownDays: 7,
    // Both left at their safe defaults on purpose: a promoted policy previews
    // every run and is switched off until the user turns it on themselves.
    dryRunFirst: true, enabled: false,
  });
  switchView('autopilot');
  toast('Pre-filled — nothing is scheduled until you save it, and its first run is always a preview you approve.', 'success', 9000);
}
$('cleanPromoteBtn').addEventListener('click', promoteRuleToPolicy);

/** Run a saved view as a Clean Up rule, through the one query engine (§4.5). */
async function findBySavedView() {
  const view = selectedSavedView();
  if (!view) { toast('Pick a saved view first', 'error'); return; }
  const out = await api('/api/query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scanId: state.scanId, q: view.q, limit: 500, sort: 'size' }),
  });
  // §2.2's degraded list is why this is not just a hit count: a query needing
  // a signal this machine cannot supply must not come back looking like
  // "nothing matched".
  if ((out.degraded || []).length) {
    toast((out.degraded || []).map((d) => d.reason).join(' '), 'error', 10000);
  }
  return {
    files: (out.hits || []).filter((h) => !h.isDir).map((h) => ({
      name: h.name, path: h.path, size: h.size, type: 'file', modifiedAt: h.mtimeMs,
    })),
    matched: out.total,
    truncated: Boolean(out.truncated),
  };
}

$('cleanFindBtn').addEventListener('click', async () => {
  if (!state.scanId) { toast('Run a scan first', 'error'); return; }
  if (cleanRuleSource === 'query') { void runCleanFind(findBySavedView); return; }
  const ageOn = $('ruleAgeOn').checked, sizeOn = $('ruleSizeOn').checked;
  const extOn = $('ruleExtOn').checked, dupOn = $('ruleDupOn').checked;
  const maxAgeMs = Number($('ruleAgeDays').value || 0) * 86400_000;
  const minBytes = Number($('ruleSizeMb').value || 0) * 1048576;
  const exts = $('ruleExts').value.split(',').map(s => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
  if (!ageOn && !sizeOn && !extOn && !dupOn) { toast('Enable at least one rule', 'error'); return; }
  if (extOn && !exts.length && !ageOn && !sizeOn && !dupOn) { toast('Add at least one extension', 'error'); return; }
  if (!state.scanId) { toast('Run a scan first', 'error'); return; }

  // Matched server-side: the client tree is pruned, and the duplicate rule in
  // particular asks whether a name+size repeats across the WHOLE scan — a
  // question the part of the tree we hold cannot answer.
  const q = new URLSearchParams({ scanId: state.scanId, limit: '500' });
  if (ageOn) q.set('maxAgeMs', String(maxAgeMs));
  if (sizeOn) q.set('minBytes', String(minBytes));
  if (extOn && exts.length) q.set('exts', exts.join(','));
  if (dupOn) q.set('dup', '1');

  await runCleanFind(async () => api('/api/cleanup/rules?' + q.toString()));
});

/**
 * Run one of the two rule sources and render its matches identically.
 *
 * Shared so the list, the checkboxes and the delete path are the same code
 * whichever source produced the hits — §4.5's "evaluated through the same
 * engine" is about the backend, and this is its counterpart in the UI.
 */
async function runCleanFind(fetcher) {
  const findBtn = $('cleanFindBtn');
  const findLabel = findBtn.innerHTML;
  findBtn.disabled = true;
  let data;
  try {
    data = await fetcher();
  } catch (e) {
    // Through `reportError`, never a bare red toast. `GET /api/cleanup/rules`
    // answers 202 {status:'running'} while a scan is still going, and `api()`
    // turns exactly that into a throw carrying `stillWorking` — an ANSWER, not
    // a failure. reportError is the one place that knows the difference (it
    // gives that flag, and CAPABILITY_UNAVAILABLE, the plain treatment rather
    // than red), so pressing Find during a rescan used to paint "Still working
    // on that — it hasn't finished yet" as an error for a request that had not
    // failed and would have succeeded a second later.
    reportError(e);
    return;
  } finally {
    findBtn.disabled = false;
    findBtn.innerHTML = findLabel;
  }
  if (!data) return; // the source reported its own problem
  cleanMatches = data.files;
  seedNodes(cleanMatches); // staged from here, so their sizes must resolve later

  const host = $('cleanResults');
  if (!cleanMatches.length) {
    host.innerHTML = `<div class="muted" style="display:flex;align-items:center;gap:8px;padding:14px 2px;">${icon('checkCircle', 15)} No files match these rules — nice and tidy.</div>`;
    $('cleanConfirmBtn').disabled = true;
    $('cleanSummary').textContent = '';
    return;
  }
  host.innerHTML = `
    <div class="rule-row" style="margin-top:6px;">
      <input type="checkbox" id="cleanAll" checked> <label for="cleanAll" class="muted">Select all (${cleanMatches.length}${data.truncated ? ` of ${formatCount(data.matched)}, largest shown` : ''})</label>
    </div>
    <div class="clean-list">` +
    cleanMatches.map((f, i) => `
      <div class="clean-item">
        <input type="checkbox" class="clean-ck" data-i="${i}" checked aria-label="Select ${escapeHtml(f.name)}">
        ${chipFor(f, 13)}
        <div class="meta">
          <div class="nm">${escapeHtml(f.name)}</div>
          <div class="pth">${escapeHtml(f.path)}</div>
        </div>
        <span class="dt num">${formatDate(f.modifiedAt)}</span>
        <span class="size-badge num" style="color:${sizeColor(f.size)}">${formatBytes(f.size)}</span>
        <button class="icon-btn" data-cart-add="${escapeHtml(f.path)}" aria-label="Add ${escapeHtml(f.name)} to cleanup cart">${icon('plus', 13)}</button>
      </div>`).join('') + '</div>';
  refreshCartButtons(); // v4 §4.2
  $('cleanAll').addEventListener('change', (e) => {
    host.querySelectorAll('.clean-ck').forEach(ck => { ck.checked = e.target.checked; });
    updateCleanSummary();
  });
  host.querySelectorAll('.clean-ck').forEach(ck => ck.addEventListener('change', updateCleanSummary));
  updateCleanSummary();
}

/**
 * Selected paths + recoverable bytes for whichever pane is showing.
 *
 * `sizes` is the same measurement as `bytes`, kept per path. A delete run can
 * come back with only part of the selection actually gone — a chunk refused
 * for an open handle is neither deleted nor failed — and a single pre-summed
 * total cannot be un-summed afterwards. The completion report needs to add up
 * exactly the paths the server confirmed, so it gets them one at a time.
 */
function activeCleanSelection() {
  if (cleanPane === 'rules') {
    const files = [...document.querySelectorAll('#cleanResults .clean-ck')]
      .filter(ck => ck.checked).map(ck => cleanMatches[+ck.dataset.i]);
    return {
      paths: files.map(f => f.path), bytes: files.reduce((s, f) => s + f.size, 0), noun: 'file',
      sizes: new Map(files.map(f => [f.path, f.size])),
    };
  }
  if (cleanPane === 'empty') {
    const sel = [...document.querySelectorAll('#emptyResults .empty-ck')]
      .filter(ck => ck.checked).map(ck => emptyFolders[+ck.dataset.i]);
    // An empty folder is worth ~0 bytes by definition, so there is nothing to
    // size — an empty map, not a missing one, so callers need no special case.
    return { paths: sel.map(f => f.path), bytes: 0, noun: 'empty folder', sizes: new Map() };
  }
  // The Smart pane has three sources that can name the SAME path — an orphaned
  // node_modules is both a package leftover (§C6) and a Smart Suggestion. Keyed
  // by path so selecting it in both places counts its bytes once.
  const chosen = new Map();
  document.querySelectorAll('#smartResults .smart-ck').forEach(ck => {
    if (!ck.checked) return;
    const it = smartGroups[+ck.dataset.g].items[+ck.dataset.i];
    chosen.set(it.path, it.size);
  });
  // Package-manager orphans and shared caches (§C6).
  document.querySelectorAll('#packageOrphans .pkg-ck').forEach(ck => {
    if (!ck.checked) return;
    const e = packageOrphans[+ck.dataset.i];
    if (e) chosen.set(e.path, e.size);
  });
  // Browser-cache sub-items carry their own path + size (Feature 16).
  document.querySelectorAll('#browserProfiles .bp-ck').forEach(ck => {
    if (!ck.checked) return;
    chosen.set(ck.dataset.path, Number(ck.dataset.bytes) || 0);
  });
  let bytes = 0;
  for (const size of chosen.values()) bytes += size;
  return { paths: [...chosen.keys()], bytes, noun: 'item', sizes: chosen };
}

function updateCleanSummary() {
  const { paths, bytes, noun } = activeCleanSelection();
  $('cleanSummary').textContent = paths.length
    ? `${paths.length} ${noun}${paths.length > 1 ? 's' : ''}${bytes ? ` — ${formatBytes(bytes)} will be recovered` : ''}`
    : '';
  $('cleanConfirmBtn').disabled = !paths.length;
  $('cleanConfirmBtn').innerHTML = icon('trash', 14) +
    (paths.length ? `Move ${paths.length} to Trash` : 'Move to Trash');
  if (cleanPane === 'smart') renderCleanFunnel(bytes);
}

/* The Smart pane's funnel: what the rules found → what is ticked → what
   those ticks will actually free. Staged sums every tick at its own size;
   projected-free is activeCleanSelection's promise, which counts a path
   picked in two sources once — the honest number the summary states. The
   funnel exists only while results do. */
let cleanFunnelHandle = null;
function cleanFunnelDrop() {
  if (cleanFunnelHandle) { cleanFunnelHandle.destroy(); cleanFunnelHandle = null; }
  $('cleanFunnel').hidden = true;
}
function renderCleanFunnel(freed) {
  let suggested = smartGroups.reduce((s, g) => s + (g.advisory ? 0 : g.totalSize), 0);
  document.querySelectorAll('#packageOrphans .pkg-ck').forEach(ck => {
    const e = packageOrphans[+ck.dataset.i];
    if (e) suggested += e.size;
  });
  document.querySelectorAll('#browserProfiles .bp-ck').forEach(ck => {
    suggested += Number(ck.dataset.bytes) || 0;
  });
  if (!(suggested > 0)) { cleanFunnelDrop(); return; }
  let staged = 0;
  document.querySelectorAll('#smartResults .smart-ck').forEach(ck => {
    if (ck.checked) staged += smartGroups[+ck.dataset.g].items[+ck.dataset.i].size;
  });
  document.querySelectorAll('#packageOrphans .pkg-ck').forEach(ck => {
    if (!ck.checked) return;
    const e = packageOrphans[+ck.dataset.i];
    if (e) staged += e.size;
  });
  document.querySelectorAll('#browserProfiles .bp-ck').forEach(ck => {
    if (ck.checked) staged += Number(ck.dataset.bytes) || 0;
  });
  const spec = {
    stages: [
      { name: 'Suggested', value: suggested },
      { name: 'Staged', value: staged },
      { name: 'Projected free', value: freed },
    ],
    trackSize: 46,
  };
  $('cleanFunnel').hidden = false;
  if (cleanFunnelHandle) cleanFunnelHandle.update(spec);
  else cleanFunnelHandle = FxCharts.funnel($('cleanFunnel'), spec);
}

/**
 * Move the current selection to the Trash, and report what actually happened.
 *
 * `trashPaths` answers in THREE buckets, not two: a chunk the server refuses
 * because something still has a file open comes back in `blocked` — in neither
 * `deleted` nor `failed`, because those files are untouched and retrying them
 * is the right next step. Reading only two of the three buckets loses those
 * files from the report, and stalls this progress bar short of 100% for the
 * rest of the run.
 *
 * The recovered figure is summed from the paths the server confirmed, path by
 * path, rather than quoting the selection's total: the total was computed
 * before anything was deleted, so on any run that did not delete everything it
 * credits the user with space still sitting on the disk.
 */
async function runCleanTrash() {
  const { paths, sizes } = activeCleanSelection();
  if (!paths.length) return;
  const btn = $('cleanConfirmBtn');
  btn.disabled = true;
  $('cleanProgress').classList.add('on');
  let done = 0, failed = 0, blocked = 0, recovered = 0;
  for (let i = 0; i < paths.length; i += 20) {
    const chunk = paths.slice(i, i + 20);
    const result = await trashPaths(chunk, { silent: true });
    done += result.deleted.length;
    for (const p of result.deleted) recovered += sizes.get(p) || 0;
    failed += result.failed.length;
    blocked += (result.blocked || []).length;
    const settled = done + failed + blocked;
    $('cleanProgressFill').style.width = Math.round((settled / paths.length) * 100) + '%';
    btn.innerHTML = icon('loader', 14, REDUCED ? '' : 'spin') + `Deleting… ${settled}/${paths.length}`;
  }
  closeModal('cleanModal');
  if (done) toast(`Moved ${done} item${done > 1 ? 's' : ''} to Trash${recovered ? ` — ${formatBytes(recovered)} recovered` : ''}`);
  if (failed) toast(`${failed} could not be trashed`, 'error');
  // Silent mode suppresses trashPaths' own re-ask dialog, so this is the only
  // place these files get mentioned at all. They are still where they were.
  if (blocked) toast(`${blocked} still in use — left where ${blocked > 1 ? 'they are' : 'it is'}. Close what is using ${blocked > 1 ? 'them' : 'it'} and try again.`, 'error', 9000);
  if (done) rescan();
}
$('cleanConfirmBtn').addEventListener('click', runCleanTrash);

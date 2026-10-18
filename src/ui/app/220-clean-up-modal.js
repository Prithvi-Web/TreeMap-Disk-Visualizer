/* ───────────────────────────── Clean Up modal ───────────────────────────── */
let cleanMatches = [];   // Custom Rules pane — matched file nodes
/** Custom Rules pane — path → bytes each matched file takes on its disk (the onDisk fact, F09); a file absent was not measured. */
let cleanOnDisk = new Map();
/**
 * True while runCleanTrash is moving a selection to the Trash: the footer's
 * button is the run's, held and saying how far it has got, until it ends — a
 * redraw meanwhile (Find's late answer about what the files take, a tick)
 * never arms it again (review F2.1, F2.9).
 */
let cleanTrashing = false;
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

/**
 * Where what Clean Up removes goes, said for the scan the sheet opens on
 * (QA third pass D06; review F1.4). A local scan's go to the system Trash
 * through DELETE /api/files, which keeps no Time Capsule copy, so they come
 * back only until the Trash is emptied; Shrink Video's original follows a
 * lossy re-encode there. A cloud account's go to that provider's own trash
 * (confirmTrash, cloudTrashPaths), which the provider empties after the time
 * it keeps deleted files — and the system Trash never sees them.
 */
function cleanUpWhereItGoes() {
  if (isCloudScan()) {
    return `Nothing is removed until you confirm. What Clean Up removes goes to ${cloudProviderOfScan().trashLabel} and is not copied to the Time Capsule, `
      + 'so it can be put back only until that trash is emptied — by you, or by the provider after the time it keeps deleted files.';
  }
  return 'Nothing is removed until you confirm. What Clean Up removes goes to the system Trash and is not copied to the Time Capsule, '
    + 'so it can be put back only until the Trash is emptied. Shrink Video’s re-encode loses a little quality for good, and the original then goes to the Trash too.';
}

$('cleanupBtn').addEventListener('click', () => {
  if (!state.root) { toast('Run a scan first', 'error'); return; }
  $('cleanWhereNote').textContent = cleanUpWhereItGoes();
  $('cleanResults').innerHTML = '';
  $('smartResults').innerHTML = '';
  $('browserProfiles').innerHTML = '';
  $('emptyResults').innerHTML = '';
  $('cleanSummary').textContent = '';
  $('cleanConfirmBtn').disabled = true;
  $('cleanProgress').classList.remove('on');
  $('cleanProgressFill').style.width = '0%';
  cleanMatches = []; emptyFolders = []; smartGroups = []; cleanOnDisk = new Map();
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
  // What was looked at and what could not be read (D56): a video ffprobe could
  // not read was never judged, so it is never counted as "already efficient".
  const unreadable = Number(data.unreadable) || 0;
  const looked = Number(data.shortlisted) || 0;
  const unreadSentence = (lead) => `${lead} large video${unreadable === 1 ? '' : 's'} couldn’t be read, so TreeMap can’t say whether re-encoding ${unreadable === 1 ? 'it' : 'them'} would help`;
  if (!videoCandidates.length) {
    const efficient = Math.max(0, looked - unreadable);
    const said = unreadable
      ? `${unreadSentence(formatCount(unreadable))}${efficient ? `; the other ${formatCount(efficient)} ${efficient === 1 ? 'is' : 'are'} already in an efficient format` : ''}.`
      : looked
        ? `No video worth re-encoding — the large ${looked === 1 ? 'one here is' : 'ones here are'} already in an efficient format.`
        : 'No large videos in this scan to re-encode.';
    host.innerHTML = `<div class="muted" style="display:flex;align-items:center;gap:8px;padding:10px 2px;">${icon(unreadable ? 'alert' : 'checkCircle', 15)}
      ${escapeHtml(said)}</div>`;
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
          <div class="pth" title="${escapeHtml(c.path)}">${escapeHtml(c.path)}</div>
          <div class="vid-why">${escapeHtml(c.reason)}${c.width ? ` · ${c.width}×${c.height}` : ''}${
            c.durationSeconds ? ` · ${Math.round(c.durationSeconds / 60)} min` : ''}</div>
        </div>
        <span class="vid-ba num">${formatBytes(c.size)} → <b>~${formatBytes(c.estimatedBytes)}</b></span>
        <span class="size-badge num" style="color:${sizeInk(c.estimatedSaving)}">~${formatBytes(c.estimatedSaving)}</span>
      </div>`).join('') + `</div>` +
    (unreadable ? `<div class="muted" style="padding:6px 2px;">${escapeHtml(`${formatCount(unreadable)} more large video${unreadable === 1 ? '' : 's'} couldn’t be read, so ${unreadable === 1 ? 'it isn’t' : 'they aren’t'} listed: TreeMap can’t say whether re-encoding ${unreadable === 1 ? 'it' : 'them'} would help.`)}</div>` : '') + `
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
    // Smaller once the Trash is emptied, as the sheet after it says: the
    // original waits there beside the new file until then (review F3.1).
    $('vidSummary').textContent = chosen.length
      ? `${chosen.length} selected — around ${formatBytes(saving)} smaller once you empty the Trash, if the estimates hold`
      : '';
  };
  host.querySelectorAll('.vid-ck').forEach(ck => ck.addEventListener('change', update));
  $('vidSelectAll').addEventListener('click', () => {
    host.querySelectorAll('.vid-ck').forEach(ck => { ck.checked = true; });
    update();
  });
  // Which of the videos are parts of an installed program, asked before the
  // sheet opens so its warning is there when it is read (review F1.4).
  $('vidEncodeBtn').addEventListener('click', async () => {
    const chosen = [...host.querySelectorAll('.vid-ck:checked')].map(ck => videoCandidates[+ck.dataset.i]);
    if (!chosen.length) return;
    const parts = await installedProgramParts(chosen.map(c => c.path));
    confirmEncode(chosen, parts);
  });
  update();
}

/**
 * The sheet before a re-encode of `chosen`. `parts`: which of them are parts
 * of an installed program (installedProgramParts, null when the server could
 * not be asked): replacing one breaks its app — on a Mac its signature too —
 * so the sheet says so before OK (review F1.4).
 */
function confirmEncode(chosen, parts) {
  if (!chosen.length) return;
  const saving = chosen.reduce((s, c) => s + c.estimatedSaving, 0);
  $('confirmTitle').innerHTML = icon('video', 18) + 'Re-encode and replace?';
  // Smaller once the Trash is emptied, not freed: the original waits there
  // beside the new file until then (D54; review F2.3 of QA third pass D06).
  const one = chosen.length === 1;
  $('confirmText').innerHTML =
    `Re-encode <b>${chosen.length}</b> video ${one ? 'file' : 'files'} to HEVC: roughly <b>${formatBytes(saving)}</b> smaller once you empty the Trash, where ${one ? 'the original goes' : 'the originals go'}.<br>` +
    `<span style="color:var(--text-3)"><b>This is lossy</b> — the picture is compressed again and a little quality is lost permanently. ` +
    `Each new file is checked (it opens, and it runs the full length) <b>before</b> the original is moved to the Trash. ` +
    `If a check fails, that file is left exactly as it is. This can take a long time.</span>` +
    installedProgramWarningHtml(parts, chosen.length, (n) => `Re-encoding ${n === 1 ? 'it' : 'them'}`);
  setConfirmButton('Re-encode', 'video');
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
      // The originals went to the Trash, which still holds them: smaller, not yet freed (D54).
      $('vidProgText').innerHTML = `${ok} re-encoded, ${formatBytes(d.savedBytes || 0)} smaller. The originals are in the Trash until you empty it.` +
        (failed.length ? `<div class="vid-failed">${failed.map(f =>
          `<div>${escapeHtml(baseName(f.path))}: ${escapeHtml(f.error || 'failed')}</div>`).join('')}</div>` : '');
      toast(`Re-encoded ${ok} file${ok === 1 ? '' : 's'} — ${formatBytes(d.savedBytes || 0)} smaller once you empty the Trash`);
      rescan({ unattended: true }); // the job ends when it ends, not at a click (review F2.1)
    }
  };
  videoJobStream.onerror = () => {
    if (videoJobStream) { videoJobStream.close(); videoJobStream = null; }
    $('vidProgText').textContent = 'Lost contact with the encoder — check the Trash and the folder before retrying.';
  };
}

/* ── Empty Folders pane ── */

/*
 * Why the folders Empty Folders left out were left out, from the answer's
 * `withheldBy` (U-4b review, L-5): "2 held something and 1 did not answer" —
 * only the reasons that applied, and TreeMap's own 10 s said as that, never
 * as a drive that did not answer. An answer without it (an older server) gets
 * the sentence that names every reason a folder can be left out for. A
 * no-answer folder may never have been asked — its drive held two calls that
 * had not answered — and is said so (the U-4c review, F3.2).
 */
const WITHHELD_SAID = [
  ['content', 'held something'],
  ['unreadable', 'could not be read'],
  ['no-answer', 'did not answer or was on a drive still waiting on earlier calls', 'did not answer or were on a drive still waiting on earlier calls'],
  ['out-of-time', 'was not looked at before the 10 seconds TreeMap gives to looking ran out', 'were not looked at before the 10 seconds TreeMap gives to looking ran out'],
  ['too-many', 'held too much to look through'],
  ['not-a-folder', 'was no longer a folder', 'were no longer folders'],
  ['gone', 'was gone', 'were gone'],
];
function whyLeftOut(by, withheld) {
  const counts = by && typeof by === 'object' ? by : null;
  if (!counts) return `${withheld === 1 ? 'it' : 'each'} held something, could not be read, or did not answer`;
  const parts = [];
  for (const [why, one, many] of WITHHELD_SAID) {
    const n = Number(counts[why]) || 0;
    if (n > 0) parts.push(withheld === 1 ? `it ${one}` : `${formatCount(n)} ${n === 1 ? one : (many || one)}`);
  }
  if (!parts.length) return `${withheld === 1 ? 'it' : 'each'} held something, could not be read, or did not answer`;
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Each load of the Empty Folders list takes the next number, and only the
 * latest paints (final review F1.8): every answer waits for the server's
 * second look on disk (U-4), up to 10 s on a slow drive, so "ignore junk"
 * toggled twice can see the older answer last — a list for the rule the box
 * no longer shows, with its Select-all count.
 */
let loadEmptyFoldersSeq = 0;
async function loadEmptyFolders() {
  const host = $('emptyResults');
  host.innerHTML = skeletonRows(4, 30);
  const seq = ++loadEmptyFoldersSeq;
  try {
    const data = await api(`/api/empty-folders?scanId=${state.scanId}&ignoreJunk=${$('emptyIgnoreJunk').checked}`);
    if (seq !== loadEmptyFoldersSeq) return; // a newer load owns the list
    emptyFolders = data.folders;
    // Track U, U-4: folders the scan saw empty that the server, looking again
    // on disk, did not find still empty — said, never dropped in silence. And a
    // scan that cannot tell an empty folder from one it never read (gdu) offers
    // none with a reason: "tidy already" would be a claim nobody could make.
    const withheld = data.withheld > 0 ? data.withheld : 0;
    const leftOut = (lead) => `${lead} looked empty to the scan but ${withheld === 1 ? 'was' : 'were'} left out: looked at again, ${whyLeftOut(data.withheldBy, withheld)}.`;
    if (!emptyFolders.length) {
      const said = data.reason
        ? escapeHtml(data.reason)
        : withheld ? leftOut(`${formatCount(withheld)} folder${withheld === 1 ? '' : 's'}`) : 'No empty folders found — tidy already.';
      host.innerHTML = `<div class="muted" style="display:flex;align-items:center;gap:8px;padding:12px 2px;">${icon(data.reason || withheld ? 'alert' : 'checkCircle', 15)} ${said}</div>`;
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
      </div>` + (withheld ? `
      <div class="muted" style="padding:2px 2px 8px;">${leftOut(`${formatCount(withheld)} more folder${withheld === 1 ? '' : 's'}`)}</div>` : '') + `
      <div class="clean-list">` + emptyFolders.map((f, i) => `
        <div class="clean-item">
          <input type="checkbox" class="empty-ck" data-i="${i}" checked aria-label="Select ${escapeHtml(f.name)}">
          ${chipFor({ type: 'dir' }, 13)}
          <div class="meta">
            <div class="nm">${escapeHtml(f.name)}</div>
            <div class="pth" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</div>
          </div>
          ${cartButtonHtml(f.path, f.name)}
        </div>`).join('') + '</div>';
    // v4 §4.2 — these are stageable one at a time, so their staged state has
    // to be reflected the moment the list is rebuilt.
    refreshCartButtons();
    updateCleanSummary();
  } catch (e) {
    if (seq !== loadEmptyFoldersSeq) return; // a stale failure must not replace a newer list
    host.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
  }
}
$('emptyIgnoreJunk').addEventListener('change', () => { emptyFolders = []; loadEmptyFolders(); });

/**
 * A "Select all" box that follows its rows (sixth browser pass H09): ticked
 * when every row is, clear when none is, and indeterminate between — as the
 * browser profiles' boxes always did. Custom Rules and Empty Folders left it
 * ticked after a row was unticked. An empty list ticks nothing.
 */
function syncSelectAll(all, boxes) {
  if (!all) return;
  const ticked = boxes.filter(b => b.checked).length;
  all.checked = boxes.length > 0 && ticked === boxes.length;
  all.indeterminate = ticked > 0 && ticked < boxes.length;
}

/**
 * A list's "Select all" box (`allId`) and its rows (`rowClass`), wired once on
 * the list's host, which outlives every rebuild of the list: the box ticks or
 * clears every row, a row's change sets the box to follow its rows, and each
 * refreshes the summary (`onChange`). Delegated — one listener however many
 * rows: Empty Folders is the app's longest list (structural empties run to
 * the thousands), and per-row listeners made every rebuild a stutter.
 */
function wireSelectAll(host, allId, rowClass, onChange) {
  host.addEventListener('change', (e) => {
    if (e.target.id === allId) {
      host.querySelectorAll(`.${rowClass}`).forEach(ck => { ck.checked = e.target.checked; });
      e.target.indeterminate = false;
      onChange();
      return;
    }
    if (!e.target.classList.contains(rowClass)) return;
    syncSelectAll($(allId), [...host.querySelectorAll(`.${rowClass}`)]);
    onChange();
  });
}
wireSelectAll($('emptyResults'), 'emptyAll', 'empty-ck', updateCleanSummary);

/* ── Smart Suggestions pane ── */
/* Feature 13 — git repositories section + git gc. */
async function renderGitRepos() {
  const host = $('gitRepos');
  if (!host || !state.scanId) return;
  let repos = [];
  try { ({ repos } = await api('/api/git/repos?scanId=' + state.scanId)); } catch { return; }
  const notable = (repos || []).filter((r) => r.totalBytes > MB);
  if (!notable.length) { host.innerHTML = ''; return; }
  host.innerHTML = `<div style="margin-bottom:16px;">
    <div class="rule-row" style="padding:6px 0;"><b style="display:inline-flex;align-items:center;gap:7px;">${icon('gitBranch', 15)}Git repositories</b><span class="muted" style="flex:1;margin-left:8px;">pack &amp; loose-object breakdown — run gc to compact</span></div>
    <div class="clean-list">` + notable.map((r) => {
      const name = r.repoPath.split(/[\\/]/).pop() || r.repoPath;
      return `<div class="clean-item">
        <div class="meta"><div class="nm">${escapeHtml(name)}</div><div class="pth" title="${escapeHtml(r.repoPath)}">${escapeHtml(r.repoPath)}</div></div>
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
  setConfirmButton('Run git gc', 'gitBranch');
  onConfirmTrash = () => runGitGcAction(repo);
  $('confirmModal').classList.add('open');
});

/* ── Package-manager orphans (§C6) ──────────────────────────────────────────
   Grouped by ecosystem, and wired into the SAME selection the rest of the
   Clean Up modal uses — this is not a fourth delete surface. Orphans and
   caches get checkboxes; active artifacts are context only (Smart Suggestions
   below already offers those, and this panel exists for the things nobody is
   going to miss).

   G05: the two halves sit apart. Orphans and caches — what a person can act
   on here — lead the sheet in #packageOrphans. A folder whose project is
   still here (the server's `active`) is listed after Smart Suggestions, in a
   fold of its own (#packageProjects), and is called what the server knows of
   it: its project is still here. "In use" is the open-file guard's word for
   a file a program has open, and over these rows it read as "do not delete"
   beside a suggestion offering the same folder. A sheet holding only such
   folders used to open on "Package leftovers — no orphans; shared caches only
   — 0 B". Nor is such a folder called rebuildable: `active` is a folder name
   a rule knows beside the project's manifest, and nothing reads what the
   folder holds — a `.venv` of hand-installed packages beside a pyenv pin is
   `active` too, and nothing there builds it again (G05 review F3.3). */
const ECOSYSTEM_LABEL = {
  npm: 'npm', yarn: 'Yarn', pnpm: 'pnpm', python: 'Python', cargo: 'Rust / Cargo',
  maven: 'Maven', gradle: 'Gradle', cocoapods: 'CocoaPods', homebrew: 'Homebrew',
  nuget: 'NuGet', chocolatey: 'Chocolatey', winget: 'winget', apt: 'apt / dpkg',
};
function ecosystemLabel(id) { return ECOSYSTEM_LABEL[id] || id; }

let packageOrphans = [];

/** Render the ecosystem panel and the fold after Smart Suggestions. Returns
    true if it listed any package folder, above the suggestions or in the
    fold: either way "nothing in this scan matches" would be false beside it —
    a folder whose project is still here matches a rule too, and one a note
    pauses is still listed here (G05 review F2.3). */
async function renderPackageOrphans() {
  const host = $('packageOrphans');
  if (!host || !state.scanId) return false;
  packageOrphans = [];
  // The fold belongs to the answer below: an earlier scan's goes now.
  const projectsHost = $('packageProjects');
  if (projectsHost) projectsHost.innerHTML = '';
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

  // Flat index so a checkbox can name its entry without re-encoding the path.
  groups.forEach(g => g.entries.forEach(e => { e._i = packageOrphans.push(e) - 1; }));
  /** Each ecosystem's entries that `keep` takes, ecosystems with none left out. */
  const part = (keep) => groups.map(g => ({ g, entries: g.entries.filter(keep) })).filter(x => x.entries.length);
  const leftovers = part(e => e.kind !== 'active');
  const projects = part(e => e.kind === 'active');

  const rowHtml = (e) => {
    const selectable = e.kind !== 'active' && !e.advisory;
    const project = e.projectName
      ? `<span class="pkg-proj">${escapeHtml(e.projectName)}</span>`
      : '<span class="pkg-proj none">no owning project</span>';
    // The server's reason for an `active` entry names the project as "in
    // use"; its row says what that means here instead. Only a cache names its
    // command, which does clear it. No row names one as putting it back: a
    // virtualenv's makes the environment but not the packages it held (its
    // rule once named `pip install -r requirements.txt`, which makes no
    // `.venv` — G05 review F2.1, H08), an orphan's project or interpreter is gone, and a
    // superseded Homebrew keg's (`brew cleanup`) removes it (F3.2).
    const why = e.kind === 'active' ? 'Its project is still here' : e.reason;
    const command = e.kind === 'cache' && e.command
      ? ` · <code>${escapeHtml(e.command)}</code> to clear` : '';
    return `<div class="clean-item pkg-item kind-${e.kind}">
          ${selectable
            ? `<input type="checkbox" class="pkg-ck" data-i="${e._i}" aria-label="Select ${escapeHtml(e.path)}">`
            : e.advisory ? '<span class="adv-spacer" title="Not safe to trash"></span>' : ''}
          <span class="pkg-tag ${e.kind}">${e.kind === 'orphan' ? 'orphaned' : e.kind === 'cache' ? 'cache' : 'has project'}</span>
          <div class="meta">
            <div class="nm">${escapeHtml(e.name)} ${project}</div>
            <div class="pth" title="${escapeHtml(e.path)}">${escapeHtml(e.path)}</div>
            <div class="pkg-why">${escapeHtml(why)}${command}</div>
          </div>
          <span class="dt num">${formatDate(e.modifiedAt)}</span>
          <span class="size-badge num">${formatBytes(e.size)}</span>
          ${selectable ? cartButtonHtml(e.path, e.name) : ''}
        </div>`;
  };
  const ecoHtml = ({ g, entries }, head) => `<div class="pkg-eco">
      <div class="pkg-echead"><b>${escapeHtml(ecosystemLabel(g.ecosystem))}</b><span class="muted num">${escapeHtml(head)}</span></div>
      <div class="clean-list">` + entries.map(rowHtml).join('') + `</div></div>`;

  const reclaimable = data.orphanBytes + data.cacheBytes;
  host.innerHTML = !leftovers.length ? '' : `<div style="margin-bottom:16px;">
    <div class="rule-row" style="padding:6px 0;">
      <b style="display:inline-flex;align-items:center;gap:7px;">${icon('box', 15)}Package leftovers</b>
      <span class="muted" style="flex:1;margin-left:8px;">${data.orphanCount
        // True of every orphan the server reports (BQG-5 item 15): its project
        // is gone, its interpreter is (a virtualenv that cannot run, though its
        // project may still be here and could make it again — so never
        // "nothing will rebuild it"), or it is a superseded Homebrew keg.
        ? `${formatCount(data.orphanCount)} orphaned — nothing can still use ${data.orphanCount === 1 ? 'it' : 'them'}`
        : 'no orphans; shared caches only'}</span>
      <span class="size-badge num" style="color:${sizeInk(reclaimable)}">${formatBytes(reclaimable)}</span>
    </div>` + leftovers.map(x => ecoHtml(x, [
      x.g.orphanCount ? `${formatCount(x.g.orphanCount)} orphaned · ${formatBytes(x.g.orphanBytes)}` : '',
      x.g.cacheCount ? `cache ${formatBytes(x.g.cacheBytes)}` : '',
    ].filter(Boolean).join(' · '))).join('') + `</div>`;

  const projectCount = projects.reduce((n, x) => n + x.entries.length, 0);
  // The line says what is true of every folder in the fold: its project is
  // still here. Never that the command beside it puts it back — a
  // virtualenv's makes the environment but not the packages it held (the rule
  // pack once named `pip install -r requirements.txt`, which makes no `.venv`
  // — G05 review F1.1, H08) — nor that its project can build it again (F3.3). The summary carries a
  // tabindex so a sheet's Tab trap (modalFocusables) lists it: a bare
  // <summary> matches none of its selectors, and with nothing ticked the
  // fold could be opened only with a mouse (F1.6).
  if (projectsHost) {
    projectsHost.innerHTML = !projectCount ? '' : `<details class="pkg-projects">
    <summary class="rule-row" tabindex="0">${icon('chevronRight', 14, 'pkg-chev')}
      <b style="display:inline-flex;align-items:center;gap:7px;">${icon('box', 15)}Folders whose project is still here</b>
      <span class="muted" style="flex:1;margin-left:8px;">${formatCount(projectCount)} folder${projectCount === 1 ? '' : 's'}</span>
      <span class="size-badge num">${formatBytes(data.activeBytes)}</span>
    </summary>` + projects.map(x => ecoHtml(x,
      `${formatCount(x.entries.length)} folder${x.entries.length === 1 ? '' : 's'} · ${formatBytes(x.g.activeBytes)}`)).join('') + `
  </details>`;
  }

  host.querySelectorAll('.pkg-ck').forEach(ck => ck.addEventListener('change', updateCleanSummary));
  refreshCartButtons();
  return leftovers.length > 0 || projectCount > 0;
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
          <span class="size-badge num" style="color:${sizeInk(it.bytes)}">${formatBytes(it.bytes)}</span>
          ${cartButtonHtml(it.path, it.label)}
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
    syncSelectAll(all, cks);
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
 * A rule's remedy — the command that puts a group back, or the supported way
 * to reclaim an advisory one — as markup that says what it is (QA fourth pass
 * E03). A command is code. A menu path ("Final Cut Pro ▸ File ▸ …") and a
 * sentence ("Re-rendered automatically when …") are text: in a code pill they
 * read as something to type. Alternatives joined by " · ", and steps joined by
 * ", then ", are each judged on their own. A command starts the way a program
 * name does — lower case, a digit or a path — and has no sentence in it: none
 * of the small words prose cannot do without. tests/layoutQa.test.ts holds
 * every remedy in the shipped packs to what it is.
 */
const REMEDY_PROSE_WORDS = new Set(['a', 'an', 'and', 'are', 'automatic', 'automatically', 'be', 'first', 'is', 'it', 'its', 'next', 'on', 'or', 'the', 'these', 'this', 'until', 'when', 'will']);
function remedyIsCommand(part) {
  if (!/^[a-z0-9./~_-]/.test(part) || /[▸—]/.test(part)) return false;
  return !part.split(/\s+/).some((w) => REMEDY_PROSE_WORDS.has(w.toLowerCase().replace(/[.,;:]+$/, '')));
}
/** `pill` false: plain code, as the "Why?" panel sets it. */
function remedyHtml(text, pill = true) {
  return String(text).split(/(\s+·\s+|,\s+then\s+)/).map((part, i) => {
    if (i % 2) return part.includes('·') ? ' · ' : ', then '; // the joiner
    if (!part) return '';
    if (remedyIsCommand(part)) return `<code${pill ? ' class="regen-cmd"' : ''}>${escapeHtml(part)}</code>`;
    return part.includes('▸') ? `<span class="smart-menu">${escapeHtml(part)}</span>` : escapeHtml(part);
  }).join('');
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
    ? `<div class="smart-filters" role="group" aria-label="Filter suggestions by type">
        <button class="pill active" data-cat="all" aria-pressed="true">All</button>` +
        present.map(c => `<button class="pill" data-cat="${c}" aria-pressed="false">${catLabel[c]}</button>`).join('') + `</div>`
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
      // The header row holds the title, "Why?" and the size; the description
      // and each remedy take a line of their own below it and wrap. In the
      // row, an advisory group's advice — the one thing a person can do with
      // it — ran 800 px past the sheet, and the descriptions beside it were
      // squeezed to nothing (QA fourth pass E03).
      const remedies = [
        adv && g.adviceCommand ? ['To reclaim', g.adviceCommand] : null,
        g.regenerateCmd ? ['To put it back', g.regenerateCmd] : null,
      ].filter(Boolean);
      return `
    <div class="smart-group cat-${g.category}${adv ? ' advisory' : ''}" data-cat="${g.category}">
      <div class="rule-row">
        ${adv
          ? `<span class="adv-mark" title="TreeMap will not offer to move this to the Trash" aria-label="Not safe to trash">${icon('alert', 14)}</span>`
          : `<input type="checkbox" class="smart-all" data-g="${gi}" aria-label="Select all in ${escapeHtml(g.title)}">`}
        <b class="smart-title">${escapeHtml(g.title)}</b>
        <button class="icon-btn why-btn" data-why="${gi}" aria-expanded="false" aria-controls="smartWhy${gi}"
          title="Why is this suggested?" aria-label="Why is ${escapeHtml(g.title)} suggested?">${icon('help', 13)}</button>
        <span class="size-badge num" style="color:${sizeInk(g.totalSize)}">${g.items.length} · ${formatBytes(g.totalSize)}</span>
      </div>
      <div class="smart-desc">${escapeHtml(g.description)}</div>
      ${remedies.map(([what, text]) => `<div class="smart-remedy"><span class="rc-lbl">${what}:</span> ${remedyHtml(text)}</div>`).join('')}
      <div class="smart-why" id="smartWhy${gi}" hidden>
        <div class="smart-why-line"><b>What matched:</b> ${escapeHtml(g.why || 'This rule did not record what it matches.')}</div>
        <div class="smart-why-line"><b>Confidence:</b> ${escapeHtml(confidenceWording(g.confidence, adv))}</div>
        <div class="smart-why-line"><b>${adv ? 'What this is' : 'Why it is safe'}:</b> ${escapeHtml(g.description)}</div>
        ${g.regenerateCmd ? `<div class="smart-why-line"><b>To put it back:</b> ${remedyHtml(g.regenerateCmd, false)}</div>` : ''}
        ${adv ? `<div class="smart-why-line"><b>Do not move this to the Trash.</b>${g.adviceCommand ? ` Reclaim it instead: ${remedyHtml(g.adviceCommand, false)}` : ''}</div>` : ''}
      </div>
      <div class="clean-list">` + smartItemsOf(g).map(({ it, i }) => `
        <div class="clean-item">
          ${adv ? '<span class="adv-spacer"></span>' : `<input type="checkbox" class="smart-ck" data-g="${gi}" data-i="${i}" aria-label="Select ${escapeHtml(it.path)}">`}
          ${chipFor({ type: it.type, extension: it.type === 'file' ? (it.name.split('.').pop() || '').toLowerCase() : undefined }, 13)}
          <div class="meta">
            <div class="nm">${escapeHtml(it.name)}</div>
            <div class="pth" title="${escapeHtml(it.path)}">${escapeHtml(it.path)}</div>
          </div>
          <span class="dt num">${formatDate(it.modifiedAt)}</span>
          ${reclaimBadge(it.path, scoreFor(it.path))}
          <span class="size-badge num">${formatBytes(it.size)}</span>
          ${adv ? '' : cartButtonHtml(it.path, it.name)}
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
    host.querySelectorAll('.smart-filters .pill[data-cat]').forEach(x => {
      x.classList.toggle('active', x === p);
      x.setAttribute('aria-pressed', String(x === p)); // toggle pills, like the ordering row beside them
    });
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
  $('cleanPromoteWhy').hidden = true; // a refusal about the other source's rules
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
  const why = $('cleanPromoteWhy');
  why.hidden = true; why.textContent = '';
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
    if ($('ruleDupOn').checked) {
      // Find ANDs the duplicate rule with the others, and no policy can: the
      // custom kind has no duplicate flag and the query field `dupe:` is not
      // wired yet. Promoting the rest would build a policy WIDER than what was
      // just shown — an unattended deleter of everything the other rules match.
      // So it is refused here, before the editor opens, rather than dropped.
      why.textContent = 'The “Duplicates only” rule cannot be carried into an Autopilot policy: a policy has no way to check for duplicates, so it would trash everything your other rules match, duplicate or not. Untick Duplicates only to make a policy from the other rules.';
      why.hidden = false;
      toast(why.textContent, 'error', 10000);
      return;
    }
    match = { kind: 'custom' };
    if (ageOn) match.maxAgeMs = Math.max(1, Number($('ruleAgeDays').value) || 180) * 86400000;
    if (sizeOn) match.minBytes = Math.max(1, Number($('ruleSizeMb').value) || 100) * MB;
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
$('ruleDupOn').addEventListener('change', () => { $('cleanPromoteWhy').hidden = true; });

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
  // The client half of the server's `positiveRule`. Both numbers are FLOORS —
  // "at least this old", "at least this big" — so 0, blank, junk and Infinity
  // rule nothing out, and `GET /api/cleanup/rules` drops them rather than
  // matching the whole disk on a typo. Sending one anyway is how a ticked box
  // holding 0 came back as 400 "Enable at least one rule": the server discarded
  // the only threshold we sent, its NO_RULES guard fired, and the user read
  // that sentence while looking at an enabled rule. Decide it here, the same
  // way, so what goes on the wire is only ever what will survive the trip.
  const threshold = (raw, unit) => {
    const n = Number(raw) * unit;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const maxAgeMs = ageOn ? threshold($('ruleAgeDays').value, 86400_000) : undefined;
  const minBytes = sizeOn ? threshold($('ruleSizeMb').value, MB) : undefined; // decimal MB, as printed (QA D09)
  const exts = $('ruleExts').value.split(',').map(s => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
  if (!ageOn && !sizeOn && !extOn && !dupOn) { toast('Enable at least one rule', 'error'); return; }
  if (extOn && !exts.length && !ageOn && !sizeOn && !dupOn) { toast('Add at least one extension', 'error'); return; }
  if (!state.scanId) { toast('Run a scan first', 'error'); return; }

  // Every row that is ticked but carries nothing to match on. `exts` is parsed
  // whether or not its row is ticked, so both halves are tested here: a full
  // box on an unticked row is not a rule, and treating it as one would let a
  // rule-less request — which matches everything — reach the server.
  const blank = [];
  if (ageOn && maxAgeMs === undefined) blank.push('Older than');
  if (sizeOn && minBytes === undefined) blank.push('Larger than');
  if (extOn && !exts.length) blank.push('Extensions');
  if (maxAgeMs === undefined && minBytes === undefined && !(extOn && exts.length) && !dupOn) {
    // Naming the box is the whole point. "Enable at least one rule" is only
    // true when nothing is ticked (the guard above), and saying it here sends
    // someone hunting for a checkbox instead of to the empty field beside it.
    toast(`${blank.join(' and ')} ${blank.length > 1 ? 'need values' : 'needs a value'} — a ticked rule left blank, or set to 0, is not a limit, so there is nothing to search for.`, 'error', 8000);
    return;
  }

  // Matched server-side: the client tree is pruned, and the duplicate rule in
  // particular asks whether a name+size repeats across the WHOLE scan — a
  // question the part of the tree we hold cannot answer.
  const q = new URLSearchParams({ scanId: state.scanId, limit: '500' });
  if (maxAgeMs !== undefined) q.set('maxAgeMs', String(maxAgeMs));
  if (minBytes !== undefined) q.set('minBytes', String(minBytes));
  if (extOn && exts.length) q.set('exts', exts.join(','));
  if (dupOn) q.set('dup', '1');

  // A live rule remains, so the search runs — but on fewer rules than the panel
  // looks like it describes, and results the user reads as filtered by age
  // would not be. 'success' is the plain channel: only .toast.success and
  // .toast.error are styled, and `reportError` already uses 'success' for
  // answers that are not failures, so an invented kind would ship unstyled.
  if (blank.length) {
    // "has no value" was not true of every case that reaches here: the box can
    // visibly contain 0, which the server discards as a threshold but which the
    // user can plainly see is a value. Name what is actually required instead.
    toast(`${blank.join(' and ')} ${blank.length > 1 ? 'need' : 'needs'} a number above zero, so nothing is being filtered on ${blank.length > 1 ? 'them' : 'it'} — searching on the other rules.`, 'success', 7000);
  }

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
  cleanOnDisk = new Map();
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
          <div class="pth" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</div>
        </div>
        <span class="dt num">${formatDate(f.modifiedAt)}</span>
        <span class="size-badge num" style="color:${sizeInk(f.size)}">${formatBytes(f.size)}</span>
        ${cartButtonHtml(f.path, f.name)}
      </div>`).join('') + '</div>';
  refreshCartButtons(); // v4 §4.2
  // "Select all" and the rows are wired once, on #cleanResults (wireSelectAll, H09).
  updateCleanSummary();
  // Then what the matched files take on the disk (F09), and the summary again
  // from it: until it lands the footer says the claimed size, "up to". Never
  // waited on before the list or Find — a drive that stopped answering since
  // the scan must hold neither (review F1.12) — and a late answer is dropped
  // once a later Find owns the list.
  const asked = cleanMatches;
  const onDisk = await cleanOnDiskOf(asked);
  if (cleanMatches !== asked) return;
  cleanOnDisk = onDisk;
  updateCleanSummary();
}

/* The Custom Rules list's "Select all" and rows, wired once on its host: every
   Find rebuilds the rows inside it (sixth browser pass H09). */
wireSelectAll($('cleanResults'), 'cleanAll', 'clean-ck', updateCleanSummary);

/** How many paths one onDisk question carries: the fact route's own limit. */
const CLEAN_ON_DISK_CHUNK = 2000;

/**
 * What each of `files` takes on its disk now, path → bytes, from the server's
 * onDisk fact (fifth browser pass F09). The scan counts the size a file
 * claims; a sparse file, a compressed one or a cloud placeholder takes less,
 * and only what it takes comes back. A file the fact could not measure is
 * absent — unknown, never 0 — and where the fact cannot be asked at all (a
 * system that reports no blocks, a failed request) the map is empty, and the
 * summary says the claimed size as the most that can come back.
 */
async function cleanOnDiskOf(files) {
  const out = new Map();
  // A cloud account's files are on no disk here: nothing to measure.
  if (!state.scanId || isCloudScan()) return out;
  try {
    for (let i = 0; i < files.length; i += CLEAN_ON_DISK_CHUNK) {
      const res = await api('/api/facts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanId: state.scanId, paths: files.slice(i, i + CLEAN_ON_DISK_CHUNK).map((f) => f.path), providers: ['onDisk'] }),
      });
      const fact = res && res.providers && res.providers.onDisk;
      if (!fact || !fact.available) return new Map();
      for (const [path, value] of Object.entries(fact.values || {})) out.set(path, value.bytes);
    }
  } catch {
    return new Map();
  }
  return out;
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
    // What they take on the disk, when every one was measured (F09): only
    // that comes back, so the footer says it and the completion toast counts
    // it, path by path. `bytes` and `sizes` stay what the files claim.
    const measured = files.length > 0 && files.every(f => cleanOnDisk.has(f.path));
    return {
      paths: files.map(f => f.path), bytes: files.reduce((s, f) => s + f.size, 0), noun: 'file',
      sizes: new Map(files.map(f => [f.path, f.size])),
      onDisk: measured ? files.reduce((s, f) => s + cleanOnDisk.get(f.path), 0) : null,
      onDiskSizes: measured ? new Map(files.map(f => [f.path, cleanOnDisk.get(f.path)])) : null,
    };
  }
  if (cleanPane === 'empty') {
    const sel = [...document.querySelectorAll('#emptyResults .empty-ck')]
      .filter(ck => ck.checked).map(ck => emptyFolders[+ck.dataset.i]);
    // An empty folder is worth ~0 bytes by definition, so there is nothing to
    // size — an empty map, not a missing one, so callers need no special case.
    // `onlyEmptyFolders`: the server looks at each again before it trashes it,
    // and leaves one that is no longer empty (Track U, U-4) — by the junk rule
    // this list was made with (U-4b L4): the box reloads the list when it changes.
    return {
      paths: sel.map(f => f.path), bytes: 0, noun: 'empty folder', sizes: new Map(),
      onlyEmptyFolders: true, ignoreJunk: $('emptyIgnoreJunk').checked,
    };
  }
  // Shrink Video and Cloud-safe have no tick-box selection of their own (their
  // buttons are their own), and the Smart pane behind them is only hidden, its
  // ticks still in the page: read here, the footer offered — and trashed — rows
  // the pane on screen does not show (review F2.6 of QA third pass D03).
  if (cleanPane !== 'smart') return { paths: [], bytes: 0, noun: 'item', sizes: new Map() };
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

/*
 * What a selection frees is said as what a move to the Trash does (D54): it
 * frees nothing until the Trash is emptied, and then at most the size the
 * files report — a sparse or shared file frees less.
 *
 * A cloud account's removals go to the provider's own trash (confirmTrash,
 * cloudTrashPaths), which the system Trash never sees, and whether the
 * provider counts its trash against the account's space is its own rule
 * (Dropbox does not): the line says where they go and promises no space, as
 * the sheet's top sentence does (review F2.1 of QA third pass D06).
 */
function updateCleanSummary() {
  const { paths, bytes, noun, onDisk } = activeCleanSelection();
  const cloud = isCloudScan() ? cloudProviderOfScan() : null;
  const where = cloud ? `${cloud.name}'s trash` : 'Trash';
  const size = !bytes ? ''
    : cloud ? ` · ${formatBytes(bytes)}, to ${where}`
    : cleanFreedSaid(bytes, onDisk, paths.length);
  $('cleanSummary').textContent = paths.length ? `${paths.length} ${noun}${paths.length > 1 ? 's' : ''}${size}` : '';
  // While a delete runs the button is its own: held, saying how far it has got.
  if (!cleanTrashing) {
    $('cleanConfirmBtn').disabled = !paths.length;
    $('cleanConfirmBtn').innerHTML = icon('trash', 14) +
      (paths.length ? `Move ${paths.length} to ${escapeHtml(where)}` : `Move to ${escapeHtml(where)}`);
  }
  // Shrink Video's action is its own Re-encode, and Cloud-safe stages into
  // the cart: under either the shared footer offers no Move to Trash, not
  // even a disabled one (fifth browser pass F10).
  $('cleanConfirmBtn').hidden = cleanPane === 'video' || cleanPane === 'cloud';
  if (cleanPane === 'smart') renderCleanFunnel(bytes);
}

/**
 * What emptying the Trash would give back for a selection that claims
 * `claimed` bytes, `onDisk` of them measured as taken on the disk (null when
 * not every file was measured). Up to that much, as a move to the Trash frees
 * nothing before (D54): what the files take where every one was measured — the
 * completion toast counts the same — and the size they claim where not. Where
 * they take less than they claim, as a sparse file does, it says so (fifth
 * browser pass F09): "2 files · up to 3.9 GB" for two files that take 0 B was
 * untrue. Where they take more (small files fill whole blocks), "up to" the
 * claimed size was less than the toast then counted (review F1.6).
 */
function cleanFreedSaid(claimed, onDisk, count) {
  if (onDisk === null || onDisk === undefined) return ` · up to ${formatBytes(claimed)}, freed when you empty the Trash`;
  if (onDisk >= claimed) return ` · up to ${formatBytes(onDisk)}, freed when you empty the Trash`;
  const one = count === 1;
  const claims = `${one ? 'it claims' : 'they claim'} ${formatBytes(claimed)}`;
  if (onDisk === 0) return ` · ${claims} but ${one ? 'takes' : 'take'} no space on the disk, so emptying the Trash frees none of it`;
  return ` · up to ${formatBytes(onDisk)}, freed when you empty the Trash — ${claims} but ${one ? 'takes' : 'take'} only ${formatBytes(onDisk)} on the disk`;
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
 *
 * Runs only from the shared dialog's OK (see confirmCleanTrash), with the
 * selection that dialog was opened for and the user's answer to its open-file
 * warning: `options.ignoreOpenHandles` is "Move to Trash anyway".
 */
async function runCleanTrash(selection, options) {
  const { paths, sizes, onDiskSizes, onlyEmptyFolders, ignoreJunk } = selection;
  // What comes back is what the files take, where that was measured (F09).
  const counted = onDiskSizes || sizes;
  const ignoreOpenHandles = Boolean(options && options.ignoreOpenHandles);
  if (!paths.length) return;
  const btn = $('cleanConfirmBtn');
  btn.disabled = true;
  $('cleanProgress').classList.add('on');
  let done = 0, failed = 0, blocked = 0, recovered = 0;
  // Folders offered as empty that the server, looking again, could not show empty: left where
  // they are on purpose, each reason said as itself (Track U, U-4; U-4b L4), never as a failure.
  const left = { FOLDER_NOT_EMPTY: 0, FOLDER_UNREADABLE: 0, FOLDER_NO_ANSWER: 0, FOLDER_NOT_CHECKED: 0, FOLDER_TOO_MANY_ENTRIES: 0, NOT_A_FOLDER: 0 };
  let leftOut = 0;
  // The button is the run's until it ends: no redraw of the footer arms it again meanwhile (review F2.1, F2.9).
  cleanTrashing = true;
  try {
    for (let i = 0; i < paths.length; i += 20) {
      const chunk = paths.slice(i, i + 20);
      const result = await trashPaths(chunk, {
        silent: true,
        ...(ignoreOpenHandles ? { ignoreOpenHandles: true } : {}),
        ...(onlyEmptyFolders ? { onlyEmptyFolders: true, ignoreJunk: ignoreJunk !== false } : {}),
      });
      done += result.deleted.length;
      for (const p of result.deleted) recovered += counted.get(p) || 0;
      for (const f of result.failed) {
        if (Object.prototype.hasOwnProperty.call(left, f.code)) { left[f.code]++; leftOut++; } else failed++;
      }
      blocked += (result.blocked || []).length;
      const settled = done + failed + leftOut + blocked;
      $('cleanProgressFill').style.width = Math.round((settled / paths.length) * 100) + '%';
      btn.innerHTML = icon('loader', 14, REDUCED ? '' : 'spin') + `Deleting… ${settled}/${paths.length}`;
    }
  } finally {
    cleanTrashing = false;
  }
  closeModal('cleanModal');
  // Measured, what the moved files took; not measured, the size they claim,
  // which is the most that comes back — "up to", as the footer said (review F1.6).
  if (done) toast(`Moved ${done} item${done > 1 ? 's' : ''} to Trash${recovered ? ` (${onDiskSizes ? '' : 'up to '}${formatBytes(recovered)}) — the space comes back when you empty the Trash` : ''}`);
  if (failed) toast(`${failed} could not be trashed`, 'error');
  const stays = (many) => `left where ${many ? 'they are' : 'it is'}`;
  const leftSaid = {
    FOLDER_NOT_EMPTY: (n, many) => `${n} folder${many ? 's are' : ' is'} no longer empty — ${stays(many)}. Rescan to see what is in ${many ? 'them' : 'it'}.`,
    FOLDER_UNREADABLE: (n, many) => `${n} folder${many ? 's' : ''} could not be read to make sure ${many ? 'they are' : 'it is'} empty — ${stays(many)}.`,
    // No time is promised (the U-4c review, F1.4): TreeMap asks a folder or drive again only once
    // the call it left out there answers, and a dead mount's may never come back. The code covers a
    // folder never asked too — its drive held two calls that had not answered — so no folder is said
    // to have not answered itself (the U-4c review, F3.2).
    FOLDER_NO_ANSWER: (n, many) => `No answer came in time for ${n} folder${many ? 's' : ''} — ${stays(many)}. ${many ? 'They or their drive' : 'It or its drive'} did not answer, or the drive was still waiting on earlier calls. The drive may be slow, asleep or disconnected; once the drive answers again, move ${many ? 'them' : 'it'} to the Trash again.`,
    // TreeMap's own time for looking ran out: no drive is blamed (U-4b review, L-5).
    FOLDER_NOT_CHECKED: (n, many) => `${n} folder${many ? 's were' : ' was'} not checked — ${stays(many)}. TreeMap looks for 10 seconds at a time and ran out first; move ${many ? 'them' : 'it'} to the Trash again to check ${many ? 'them' : 'it'}.`,
    FOLDER_TOO_MANY_ENTRIES: (n, many) => `${n} folder${many ? 's hold' : ' holds'} too much to look through — ${stays(many)}. Rescan to see what is in ${many ? 'them' : 'it'}.`,
    NOT_A_FOLDER: (n, many) => `${n} item${many ? 's are' : ' is'} no longer a folder — ${stays(many)}.`,
  };
  for (const code of Object.keys(left)) if (left[code]) toast(leftSaid[code](left[code], left[code] > 1), 'error', 9000);
  // Silent mode suppresses trashPaths' own re-ask dialog, so this is the only
  // place these files get mentioned at all. They are still where they were.
  if (blocked) toast(`${blocked} still in use — left where ${blocked > 1 ? 'they are' : 'it is'}. Close what is using ${blocked > 1 ? 'them' : 'it'} and try again.`, 'error', 9000);
  if (done) rescan();
}

/**
 * Move to Trash asks first, in the one dialog every other view uses (D53).
 *
 * This button used to run the delete on the click: every pane opens with its
 * rows ticked, so one click trashed them all, and with no B2 check either —
 * the run is silent, which also turns off trashPaths' own re-ask. Now the
 * click only opens "Move to Trash?" (which starts the open-file check), and
 * OK runs the delete for the selection taken HERE: a pane still loading
 * behind the dialog cannot add rows to what was confirmed.
 *
 * The callback is installed after confirmTrash, which clears it first. A
 * cloud scan keeps the dialog's own callback: its files go to the provider's
 * trash, never to the local Trash route.
 */
async function confirmCleanTrash() {
  // Its files are already on their way to the Trash: no second sheet for them (review F2.1).
  if (cleanTrashing) return;
  const selection = activeCleanSelection();
  if (!selection.paths.length) return;
  await confirmTrash(selection.paths);
  if (isCloudScan()) return;
  onConfirmTrash = ({ ignoreOpenHandles } = {}) => runCleanTrash(selection, { ignoreOpenHandles });
}
$('cleanConfirmBtn').addEventListener('click', confirmCleanTrash);
